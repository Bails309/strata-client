use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use reqwest::Client;
use serde::{Deserialize, Serialize};

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
}

/// JSON Web Key Set.
#[derive(Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

#[derive(Deserialize)]
struct Jwk {
    kid: Option<String>,
    n: String,
    e: String,
    kty: String,
}

/// Validate an OIDC bearer token against the dynamically-configured issuer.
pub async fn validate_token(issuer_url: &str, client_id: &str, token: &str) -> Result<Claims, AppError> {
    // Validate issuer URL scheme to prevent SSRF
    if !issuer_url.starts_with("https://") {
        return Err(AppError::Auth("OIDC issuer must use HTTPS".into()));
    }

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| AppError::Auth(format!("HTTP client error: {e}")))?;

    // 1. Fetch OIDC discovery
    let discovery_url =
        format!("{}/.well-known/openid-configuration", issuer_url.trim_end_matches('/'));
    let discovery: OidcDiscovery = client
        .get(&discovery_url)
        .send()
        .await
        .map_err(|e| AppError::Auth(format!("OIDC discovery failed: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Auth(format!("OIDC discovery parse: {e}")))?;

    // Validate that the discovered issuer matches the configured one
    let normalised_issuer = issuer_url.trim_end_matches('/');
    let normalised_discovery = discovery.issuer.trim_end_matches('/');
    if normalised_issuer != normalised_discovery {
        return Err(AppError::Auth(format!(
            "OIDC issuer mismatch: expected {normalised_issuer}, got {normalised_discovery}"
        )));
    }

    // 2. Fetch JWKS
    let jwks: Jwks = client
        .get(&discovery.jwks_uri)
        .send()
        .await
        .map_err(|e| AppError::Auth(format!("JWKS fetch failed: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Auth(format!("JWKS parse: {e}")))?;

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
}
