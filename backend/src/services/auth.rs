use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::error::AppError;

/// Standard OIDC claims extracted from the access token.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    pub sub: String,
    pub preferred_username: Option<String>,
    pub email: Option<String>,
    pub name: Option<String>,
    pub exp: usize,
    pub iat: usize,
}

/// OIDC discovery document (subset).
#[derive(Deserialize, Clone)]
pub struct OidcDiscovery {
    pub jwks_uri: String,
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    /// RP-Initiated Logout 1.0 end-session endpoint.
    ///
    /// `Option` because:
    ///   * Some legacy IdPs (and some Auth0 / Cognito configurations)
    ///     don't advertise it in their discovery document.
    ///   * It only exists in the OIDC discovery spec under the
    ///     "OpenID Connect Session Management" / "RP-Initiated Logout"
    ///     extensions, which are not mandatory.
    ///
    /// When present, [`crate::routes::auth::logout`] builds an
    /// `id_token_hint`-signed redirect to it so the user's IdP session
    /// is actually destroyed (W4-? pentest finding — pressing Logout
    /// previously cleared only Strata's cookies, so the next "Sign in"
    /// silently re-authenticated against the surviving Keycloak SSO
    /// cookie without prompting for credentials).
    #[serde(default)]
    pub end_session_endpoint: Option<String>,
}

/// JSON Web Key Set.
#[derive(Deserialize, Clone)]
struct Jwks {
    keys: Vec<Jwk>,
}

#[derive(Deserialize, Clone)]
struct Jwk {
    kid: Option<String>,
    n: String,
    e: String,
    kty: String,
}

// ── OIDC discovery + JWKS cache ────────────────────────────────────────
//
// Why this exists
// ---------------
// Both the SSO callback (`routes::auth::sso_callback`) and the bearer-
// token validator (`validate_token` below) need the OIDC discovery
// document and the JWKS for the configured issuer. Before this cache
// existed, a single SSO sign-in performed FOUR upstream HTTP round-trips
// to Keycloak on a cold cache:
//   1. discovery (cached in routes::auth)
//   2. token exchange POST
//   3. discovery AGAIN (uncached, inside validate_token)
//   4. JWKS (never cached)
// On a sluggish corporate IdP that cumulates to 15-30s of latency
// during which the user's URL bar still shows the Keycloak callback
// URL — the user-visible symptom is "the login hangs on a Keycloak
// page". A second attempt within the cache TTL is fast.
//
// The fix is to share both caches across all callers, with a 10-minute
// TTL that matches Keycloak's default key-rotation grace window.

const OIDC_CACHE_TTL: Duration = Duration::from_secs(600);

#[derive(Clone)]
struct CachedDiscovery {
    discovery: OidcDiscovery,
    fetched_at: Instant,
}

#[derive(Clone)]
struct CachedJwks {
    jwks: Jwks,
    fetched_at: Instant,
}

static OIDC_DISCOVERY_CACHE: LazyLock<Mutex<HashMap<String, CachedDiscovery>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static OIDC_JWKS_CACHE: LazyLock<Mutex<HashMap<String, CachedJwks>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Fetch (and cache for ~10 minutes) the OIDC discovery document for an
/// issuer. The cache is shared across the SSO callback and bearer-token
/// validation paths. Also asserts that the discovered `issuer` matches
/// the configured `issuer_url`, preventing redirect/secret exfiltration
/// via spoofed discovery documents.
pub async fn fetch_oidc_discovery_cached(issuer_url: &str) -> Result<OidcDiscovery, AppError> {
    if !issuer_url.starts_with("https://") {
        return Err(AppError::Auth("OIDC issuer must use HTTPS".into()));
    }
    {
        let cache = OIDC_DISCOVERY_CACHE
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = cache.get(issuer_url) {
            if entry.fetched_at.elapsed() < OIDC_CACHE_TTL {
                return Ok(entry.discovery.clone());
            }
        }
    }

    let client = crate::services::http_client::oidc_client();
    let discovery_url = format!(
        "{}/.well-known/openid-configuration",
        issuer_url.trim_end_matches('/')
    );
    let discovery: OidcDiscovery = client
        .get(&discovery_url)
        .send()
        .await
        .map_err(|e| AppError::Auth(format!("OIDC discovery failed: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Auth(format!("OIDC discovery parse: {e}")))?;

    let normalised_issuer = issuer_url.trim_end_matches('/');
    let normalised_discovery = discovery.issuer.trim_end_matches('/');
    if normalised_issuer != normalised_discovery {
        return Err(AppError::Auth(format!(
            "OIDC issuer mismatch: expected {normalised_issuer}, got {normalised_discovery}"
        )));
    }

    {
        let mut cache = OIDC_DISCOVERY_CACHE
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        cache.insert(
            issuer_url.to_string(),
            CachedDiscovery {
                discovery: discovery.clone(),
                fetched_at: Instant::now(),
            },
        );
    }

    Ok(discovery)
}

/// Fetch (and cache for ~10 minutes) the JWKS for an OIDC issuer.
async fn fetch_jwks_cached(jwks_uri: &str) -> Result<Jwks, AppError> {
    {
        let cache = OIDC_JWKS_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = cache.get(jwks_uri) {
            if entry.fetched_at.elapsed() < OIDC_CACHE_TTL {
                return Ok(entry.jwks.clone());
            }
        }
    }
    let client = crate::services::http_client::oidc_client();
    let jwks: Jwks = client
        .get(jwks_uri)
        .send()
        .await
        .map_err(|e| AppError::Auth(format!("JWKS fetch failed: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Auth(format!("JWKS parse: {e}")))?;

    {
        let mut cache = OIDC_JWKS_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        cache.insert(
            jwks_uri.to_string(),
            CachedJwks {
                jwks: jwks.clone(),
                fetched_at: Instant::now(),
            },
        );
    }
    Ok(jwks)
}

/// Validate an OIDC bearer token against the dynamically-configured issuer.
pub async fn validate_token(
    issuer_url: &str,
    client_id: &str,
    token: &str,
) -> Result<Claims, AppError> {
    // 1. Fetch (cached) OIDC discovery — also rejects non-HTTPS issuers
    //    and verifies the discovered issuer matches the configured one.
    let discovery = fetch_oidc_discovery_cached(issuer_url).await?;

    // 2. Fetch (cached) JWKS
    let jwks = fetch_jwks_cached(&discovery.jwks_uri).await?;

    // 3. Decode header to find kid
    let header = jsonwebtoken::decode_header(token)
        .map_err(|e| AppError::Auth(format!("Token header: {e}")))?;

    // Require a kid in the token header to prevent key confusion attacks
    let kid = header
        .kid
        .ok_or_else(|| AppError::Auth("Token missing kid header claim".into()))?;
    let jwk = jwks
        .keys
        .iter()
        .find(|k| k.kid.as_deref() == Some(&kid))
        .ok_or_else(|| AppError::Auth("No matching JWK kid".into()))?;

    if jwk.kty != "RSA" {
        return Err(AppError::Auth("Unsupported key type".into()));
    }

    // 4. Build decoding key and validate
    let key = DecodingKey::from_rsa_components(&jwk.n, &jwk.e)
        .map_err(|e| AppError::Auth(format!("RSA key: {e}")))?;

    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[client_id]);
    validation.set_issuer(&[&discovery.issuer]);

    let token_data = decode::<Claims>(token, &key, &validation)
        .map_err(|e| AppError::Auth(format!("Token validation: {e}")))?;

    Ok(token_data.claims)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn validate_token_rejects_http_issuer() {
        let result = validate_token("http://evil.example.com", "client-id", "fake.jwt.token").await;
        assert!(result.is_err());
        let err = format!("{}", result.unwrap_err());
        assert!(err.contains("HTTPS"), "Should require HTTPS, got: {err}");
    }

    #[tokio::test]
    async fn validate_token_rejects_non_url_issuer() {
        let result = validate_token("ftp://example.com", "client-id", "fake.jwt.token").await;
        assert!(result.is_err());
    }

    #[test]
    fn claims_debug() {
        let claims = Claims {
            sub: "user123".into(),
            preferred_username: Some("alice".into()),
            email: Some("alice@example.com".into()),
            name: None,
            exp: 9999999999,
            iat: 1000000000,
        };
        let debug = format!("{:?}", claims);
        assert!(debug.contains("user123"));
    }

    #[test]
    fn claims_serialize() {
        let claims = Claims {
            sub: "sub-id".into(),
            preferred_username: None,
            email: None,
            name: None,
            exp: 123,
            iat: 100,
        };
        let json = serde_json::to_value(&claims).unwrap();
        assert_eq!(json["sub"], "sub-id");
        assert!(json["preferred_username"].is_null());
    }

    #[test]
    fn oidc_discovery_deserializes() {
        let json = r#"{
            "jwks_uri": "https://idp.example.com/.well-known/jwks.json",
            "issuer": "https://idp.example.com",
            "authorization_endpoint": "https://idp.example.com/authorize",
            "token_endpoint": "https://idp.example.com/token"
        }"#;
        let disc: OidcDiscovery = serde_json::from_str(json).unwrap();
        assert_eq!(disc.issuer, "https://idp.example.com");
        assert!(disc.jwks_uri.contains("jwks.json"));
    }

    #[test]
    fn oidc_discovery_deserializes_with_end_session_endpoint() {
        // Keycloak-style discovery document includes end_session_endpoint;
        // the field must round-trip into the optional struct field.
        let json = r#"{
            "jwks_uri": "https://kc.example.com/realms/r/protocol/openid-connect/certs",
            "issuer": "https://kc.example.com/realms/r",
            "authorization_endpoint": "https://kc.example.com/realms/r/protocol/openid-connect/auth",
            "token_endpoint": "https://kc.example.com/realms/r/protocol/openid-connect/token",
            "end_session_endpoint": "https://kc.example.com/realms/r/protocol/openid-connect/logout"
        }"#;
        let disc: OidcDiscovery = serde_json::from_str(json).unwrap();
        assert_eq!(
            disc.end_session_endpoint.as_deref(),
            Some("https://kc.example.com/realms/r/protocol/openid-connect/logout")
        );
    }

    #[test]
    fn oidc_discovery_deserializes_without_end_session_endpoint() {
        // Legacy IdPs may omit end_session_endpoint. The field must
        // default to None rather than failing the whole parse.
        let json = r#"{
            "jwks_uri": "https://idp.example.com/.well-known/jwks.json",
            "issuer": "https://idp.example.com",
            "authorization_endpoint": "https://idp.example.com/authorize",
            "token_endpoint": "https://idp.example.com/token"
        }"#;
        let disc: OidcDiscovery = serde_json::from_str(json).unwrap();
        assert!(disc.end_session_endpoint.is_none());
    }

    #[test]
    fn claims_clone() {
        let claims = Claims {
            sub: "user1".into(),
            preferred_username: Some("alice".into()),
            email: Some("a@b.com".into()),
            name: Some("Alice".into()),
            exp: 9999999999,
            iat: 1000000000,
        };
        let cloned = claims.clone();
        assert_eq!(cloned.sub, "user1");
        assert_eq!(cloned.preferred_username.as_deref(), Some("alice"));
        assert_eq!(cloned.email.as_deref(), Some("a@b.com"));
        assert_eq!(cloned.name.as_deref(), Some("Alice"));
    }

    #[test]
    fn claims_deserialize_from_json() {
        let json = r#"{
            "sub": "user-42",
            "preferred_username": "bob",
            "email": null,
            "name": null,
            "exp": 9999999999,
            "iat": 1000000000
        }"#;
        let claims: Claims = serde_json::from_str(json).unwrap();
        assert_eq!(claims.sub, "user-42");
        assert_eq!(claims.preferred_username.as_deref(), Some("bob"));
        assert!(claims.email.is_none());
    }

    #[test]
    fn oidc_discovery_clone() {
        let disc = OidcDiscovery {
            jwks_uri: "https://example.com/jwks".into(),
            issuer: "https://example.com".into(),
            authorization_endpoint: "https://example.com/auth".into(),
            token_endpoint: "https://example.com/token".into(),
            end_session_endpoint: Some("https://example.com/logout".into()),
        };
        let cloned = disc.clone();
        assert_eq!(cloned.issuer, disc.issuer);
        assert_eq!(cloned.jwks_uri, disc.jwks_uri);
        assert_eq!(cloned.end_session_endpoint, disc.end_session_endpoint);
    }

    // ── W4-8 negative / misuse tests ───────────────────────────────

    #[tokio::test]
    async fn validate_token_rejects_empty_token() {
        let result = validate_token("https://idp.example.com", "client", "").await;
        assert!(result.is_err(), "empty token must be rejected");
    }

    #[tokio::test]
    async fn validate_token_rejects_malformed_token() {
        // Not three dot-separated segments → jsonwebtoken must error before any
        // network call.
        let result = validate_token("https://idp.example.com", "client", "not-a-jwt").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn validate_token_rejects_token_with_bogus_segments() {
        // Syntactically three segments but none are valid base64url JSON.
        let result = validate_token("https://idp.example.com", "client", "AAA.BBB.CCC").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn validate_token_rejects_sql_injection_shaped_issuer() {
        // W4-8: the caller-supplied issuer string is used in a URL; a SQL-ish
        // payload must be rejected by URL parsing / HTTPS enforcement rather
        // than making it to any network stack.
        let result = validate_token(
            "https://idp.example.com'; DROP TABLE users;--",
            "client",
            "fake.jwt.token",
        )
        .await;
        assert!(result.is_err());
    }
}
