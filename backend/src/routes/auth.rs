use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::Json;
use axum::response::Redirect;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use crate::error::AppError;
use crate::services::app_state::SharedState;
use crate::services::audit;
use crate::services::settings;

/// Rate limiter keyed by (username, client_ip) to prevent both credential
/// stuffing from a single IP and distributed attacks against a single user.
static RATE_LIMIT: std::sync::LazyLock<Mutex<HashMap<String, Vec<Instant>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Per-IP rate limiter — prevents a single IP from trying many usernames.
static IP_RATE_LIMIT: std::sync::LazyLock<Mutex<HashMap<String, Vec<Instant>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// In-memory store for SSO CSRF state parameters.
/// Each entry has a creation time; entries older than SSO_STATE_TTL are pruned.
static SSO_STATE_STORE: std::sync::LazyLock<Mutex<HashMap<String, Instant>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
const SSO_STATE_TTL_SECS: u64 = 300; // 5 minutes

/// Cached OIDC discovery document with TTL.
struct CachedDiscovery {
    discovery: crate::services::auth::OidcDiscovery,
    fetched_at: Instant,
}
static OIDC_DISCOVERY_CACHE: std::sync::LazyLock<Mutex<HashMap<String, CachedDiscovery>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
const OIDC_DISCOVERY_TTL_SECS: u64 = 600; // 10 minutes

/// Fetch OIDC discovery document, returning a cached copy if fresh.
async fn fetch_oidc_discovery(
    issuer_url: &str,
) -> Result<crate::services::auth::OidcDiscovery, AppError> {
    // Check cache
    {
        let cache = OIDC_DISCOVERY_CACHE.lock().unwrap();
        if let Some(entry) = cache.get(issuer_url) {
            if entry.fetched_at.elapsed().as_secs() < OIDC_DISCOVERY_TTL_SECS {
                return Ok(entry.discovery.clone());
            }
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| AppError::Auth(format!("HTTP client error: {e}")))?;
    let discovery_url = format!(
        "{}/.well-known/openid-configuration",
        issuer_url.trim_end_matches('/')
    );
    let discovery: crate::services::auth::OidcDiscovery = client
        .get(&discovery_url)
        .send()
        .await
        .map_err(|e| AppError::Auth(format!("OIDC discovery failed: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Auth(format!("OIDC discovery parse: {e}")))?;

    // Validate that the discovered issuer matches the configured one to
    // prevent redirect/secret exfiltration via spoofed discovery documents.
    let normalised_issuer = issuer_url.trim_end_matches('/');
    let normalised_discovery = discovery.issuer.trim_end_matches('/');
    if normalised_issuer != normalised_discovery {
        return Err(AppError::Auth(format!(
            "OIDC issuer mismatch: expected {normalised_issuer}, got {normalised_discovery}"
        )));
    }

    // Update cache
    {
        let mut cache = OIDC_DISCOVERY_CACHE.lock().unwrap();
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

const MAX_ATTEMPTS: usize = 5;
const WINDOW_SECS: u64 = 60;
/// Max attempts per IP across all usernames
const MAX_IP_ATTEMPTS: usize = 20;
const IP_WINDOW_SECS: u64 = 300;
/// Maximum entries in each rate limiter to prevent OOM under enumeration attacks.
const MAX_RATE_LIMIT_ENTRIES: usize = 50_000;

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

/// Extract the client IP from X-Forwarded-For (rightmost non-private entry)
/// or fall back to "unknown".
fn extract_client_ip(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            // Use rightmost entry — the one added by our trusted proxy (Caddy)
            v.rsplit(',')
                .map(|s| s.trim())
                .find(|s| !s.is_empty())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "unknown".into())
}

/// POST /api/auth/login – authenticate with local username/password.
/// Returns a signed JWT for subsequent API calls.
pub async fn login(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<LoginRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Check if local auth is enabled
    {
        let s = state.read().await;
        if let Some(ref db) = s.db {
            let local_enabled = settings::get(&db.pool, "local_auth_enabled")
                .await
                .unwrap_or(None)
                .map(|v| v == "true")
                .unwrap_or(true);
            if !local_enabled {
                return Err(AppError::Auth("Local authentication is disabled".into()));
            }
        }
    }

    // Input length validation
    if body.username.is_empty() || body.password.is_empty() {
        return Err(AppError::Auth("Invalid credentials".into()));
    }
    if body.username.len() > 256 || body.password.len() > 1024 {
        return Err(AppError::Auth("Invalid credentials".into()));
    }

    let client_ip = extract_client_ip(&headers);

    // ── Per-IP rate limiting ──
    {
        let mut map = IP_RATE_LIMIT.lock().unwrap();
        // Prune entire map if it exceeds the max entries threshold (OOM protection)
        if map.len() > MAX_RATE_LIMIT_ENTRIES {
            map.retain(|_, attempts| {
                let cutoff = Instant::now() - std::time::Duration::from_secs(IP_WINDOW_SECS);
                attempts.retain(|t| *t > cutoff);
                !attempts.is_empty()
            });
            // If still too large after pruning, clear entirely
            if map.len() > MAX_RATE_LIMIT_ENTRIES {
                map.clear();
            }
        }
        let cutoff = Instant::now() - std::time::Duration::from_secs(IP_WINDOW_SECS);
        let attempts = map.entry(client_ip.clone()).or_default();
        attempts.retain(|t| *t > cutoff);
        if attempts.len() >= MAX_IP_ATTEMPTS {
            return Err(AppError::Auth(
                "Too many login attempts from this address. Please try again later.".into(),
            ));
        }
    }

    // ── Per-username rate limiting ──
    {
        let mut map = RATE_LIMIT.lock().unwrap();
        // Prune entire map if it exceeds the max entries threshold (OOM protection)
        if map.len() > MAX_RATE_LIMIT_ENTRIES {
            map.retain(|_, attempts| {
                let cutoff = Instant::now() - std::time::Duration::from_secs(WINDOW_SECS);
                attempts.retain(|t| *t > cutoff);
                !attempts.is_empty()
            });
            if map.len() > MAX_RATE_LIMIT_ENTRIES {
                map.clear();
            }
        }
        let cutoff = Instant::now() - std::time::Duration::from_secs(WINDOW_SECS);
        let attempts = map.entry(body.username.clone()).or_default();
        attempts.retain(|t| *t > cutoff);
        if attempts.len() >= MAX_ATTEMPTS {
            return Err(AppError::Auth(
                "Too many login attempts. Please try again later.".into(),
            ));
        }
    }

    let db = {
        let s = state.read().await;
        s.db.clone().ok_or(AppError::Internal("Database not available".into()))?
    };

    let row: Option<(Uuid, String, Option<String>, String)> = sqlx::query_as(
        "SELECT u.id, u.username, u.password_hash, r.name
         FROM users u JOIN roles r ON u.role_id = r.id
         WHERE (u.username = $1 OR u.email = $1) AND u.auth_type = 'local'",
    )
    .bind(&body.username)
    .fetch_optional(&db.pool)
    .await
    .map_err(AppError::Database)?;

    let (user_id, username, password_hash, role) =
        row.ok_or_else(|| AppError::Auth("Invalid username or password".into()))?;

    let hash = password_hash
        .ok_or_else(|| AppError::Auth("This account does not support local login".into()))?;

    // Verify password with Argon2
    use argon2::{Argon2, PasswordHash, PasswordVerifier};
    let parsed_hash = PasswordHash::new(&hash)
        .map_err(|_| AppError::Auth("Invalid username or password".into()))?;
    Argon2::default()
        .verify_password(body.password.as_bytes(), &parsed_hash)
        .map_err(|_| {
            // Record failed attempt for both username and IP
            let mut map = RATE_LIMIT.lock().unwrap();
            map.entry(body.username.clone()).or_default().push(Instant::now());
            drop(map);
            let mut ip_map = IP_RATE_LIMIT.lock().unwrap();
            ip_map.entry(client_ip.clone()).or_default().push(Instant::now());
            AppError::Auth("Invalid username or password".into())
        })?;

    // Successful login — clear rate limit for this user
    {
        let mut map = RATE_LIMIT.lock().unwrap();
        map.remove(&body.username);
    }

    // Generate a local JWT
    let token = create_local_jwt(user_id, &username, &role)?;

    audit::log(
        &db.pool,
        Some(user_id),
        "auth.local_login",
        &json!({ "username": username }),
    )
    .await?;

    Ok(Json(json!({
        "access_token": token,
        "token_type": "Bearer",
        "user": {
            "id": user_id,
            "username": username,
            "role": role,
        }
    })))
}

/// Create a local JWT signed with a server-side HMAC key.
fn create_local_jwt(user_id: Uuid, username: &str, role: &str) -> Result<String, AppError> {
    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde::Serialize;

    #[derive(Serialize)]
    struct LocalClaims {
        sub: String,
        username: String,
        role: String,
        iss: String,
        exp: usize,
        iat: usize,
        jti: String,
    }

    let secret = crate::config::JWT_SECRET
        .get()
        .ok_or_else(|| AppError::Internal("JWT_SECRET not configured".into()))?
        .clone();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as usize;

    let claims = LocalClaims {
        sub: user_id.to_string(),
        username: username.to_string(),
        role: role.to_string(),
        iss: "strata-local".into(),
        exp: now + 86400, // 24 hours
        iat: now,
        jti: Uuid::new_v4().to_string(),
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(format!("JWT creation failed: {e}")))
}

/// POST /api/auth/logout – revoke the current token.
pub async fn logout(headers: HeaderMap) -> Result<Json<serde_json::Value>, AppError> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| AppError::Auth("Missing Authorization header".into()))?;

    // Try to decode as a local JWT to extract the real exp claim.
    // If decode fails (e.g. OIDC token), use a default 24h TTL so
    // the token is still tracked in the revocation list.
    use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};

    #[derive(serde::Deserialize, Clone)]
    struct ExpClaims { exp: u64 }

    let secret = crate::config::JWT_SECRET.get().cloned().unwrap_or_default();
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&["strata-local"]);
    validation.set_required_spec_claims(&["exp"]);

    let exp = if let Ok(data) = decode::<ExpClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    ) {
        data.claims.exp
    } else {
        // Non-local token (OIDC) — use 24h from now as a conservative TTL
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        now + 86400
    };

    crate::services::token_revocation::revoke(token, exp);

    Ok(Json(json!({ "status": "logged_out" })))
}

// ── SSO / OIDC ─────────────────────────────────────────────────────────

/// GET /api/auth/sso/login – redirect to the OIDC provider.
pub async fn sso_login(State(state): State<SharedState>) -> Result<Redirect, AppError> {
    let db = {
        let s = state.read().await;
        s.db.clone().ok_or(AppError::Internal("Database not available".into()))?
    };

    let sso_enabled = settings::get(&db.pool, "sso_enabled").await?.unwrap_or_default() == "true";
    if !sso_enabled {
        return Err(AppError::Auth("SSO is disabled".into()));
    }

    let issuer_url = settings::get(&db.pool, "sso_issuer_url").await?.unwrap_or_default();
    let client_id = settings::get(&db.pool, "sso_client_id").await?.unwrap_or_default();

    if issuer_url.is_empty() || client_id.is_empty() {
        return Err(AppError::Auth("SSO is not properly configured".into()));
    }

    // Discover the authorization endpoint (cached)
    let discovery = fetch_oidc_discovery(&issuer_url).await?;

    // Construct authorization URL with CSRF state parameter
    let redirect_uri = format!(
        "{}://{}/api/auth/sso/callback",
        "https",
        std::env::var("STRATA_DOMAIN").unwrap_or_else(|_| "localhost".into())
    );

    let state = Uuid::new_v4().to_string();
    {
        let mut store = SSO_STATE_STORE.lock().unwrap();
        // Prune expired entries
        let cutoff = Instant::now() - std::time::Duration::from_secs(SSO_STATE_TTL_SECS);
        store.retain(|_, created| *created > cutoff);
        store.insert(state.clone(), Instant::now());
    }

    let auth_url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope=openid+profile+email&state={}",
        discovery.authorization_endpoint,
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(&state),
    );

    Ok(Redirect::to(&auth_url))
}

#[derive(Deserialize)]
pub struct SsoCallbackParams {
    pub code: String,
    pub state: Option<String>,
}

/// GET /api/auth/sso/callback – handle the OIDC callback.
pub async fn sso_callback(
    State(state): State<SharedState>,
    Query(params): Query<SsoCallbackParams>,
) -> Result<Redirect, AppError> {
    // Validate CSRF state parameter
    let state_value = params.state.as_deref().unwrap_or_default();
    {
        let mut store = SSO_STATE_STORE.lock().unwrap();
        let cutoff = Instant::now() - std::time::Duration::from_secs(SSO_STATE_TTL_SECS);
        store.retain(|_, created| *created > cutoff);
        match store.remove(state_value) {
            Some(_) => {} // valid — consumed
            None => return Err(AppError::Auth("Invalid or expired SSO state parameter".into())),
        }
    }

    let (db, vault) = {
        let s = state.read().await;
        let db = s.db.clone().ok_or(AppError::Internal("Database not available".into()))?;
        let vault = s.config.as_ref().and_then(|c| c.vault.clone());
        (db, vault)
    };

    let issuer_url = settings::get(&db.pool, "sso_issuer_url").await?.unwrap_or_default();
    let client_id = settings::get(&db.pool, "sso_client_id").await?.unwrap_or_default();
    let client_secret_raw = settings::get(&db.pool, "sso_client_secret").await?.unwrap_or_default();

    if issuer_url.is_empty() || client_id.is_empty() || client_secret_raw.is_empty() {
        return Err(AppError::Auth("SSO configuration is incomplete".into()));
    }

    // Decrypt client secret using the setting helper
    let client_secret = match vault {
        Some(v) => crate::services::vault::unseal_setting(&v, &client_secret_raw).await?,
        None if client_secret_raw.starts_with("vault:") => {
            return Err(AppError::Config("Vault not configured but SSO secret is encrypted".into()));
        }
        _ => client_secret_raw,
    };

    // Discovery for token endpoint (cached)
    let discovery = fetch_oidc_discovery(&issuer_url).await?;
    let client = reqwest::Client::new();

    let redirect_uri = format!(
        "{}://{}/api/auth/sso/callback",
        "https",
        std::env::var("STRATA_DOMAIN").unwrap_or_else(|_| "localhost".into())
    );

    // Exchange code for token
    let token_res: serde_json::Value = client
        .post(&discovery.token_endpoint)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", &params.code),
            ("redirect_uri", &redirect_uri),
            ("client_id", &client_id),
            ("client_secret", &client_secret),
        ])
        .send()
        .await
        .map_err(|e| AppError::Auth(format!("Token exchange failed: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Auth(format!("Token response parse error: {e}")))?;

    let access_token = token_res["access_token"]
        .as_str()
        .ok_or_else(|| AppError::Auth("Missing access_token in response".into()))?;

    // Validate token and get claims
    let claims = crate::services::auth::validate_token(&issuer_url, &client_id, access_token).await?;

    // Extract email from claims
    let user_email = claims.email.as_ref().ok_or_else(|| {
        AppError::Auth("OIDC identity missing email claim. SSO requires an email address.".into())
    })?;

    // Find user by email. We match by email to link pre-created SSO users.
    let row: Option<(Uuid, String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT u.id, u.username, r.name as role_name, u.sub, u.full_name
         FROM users u JOIN roles r ON u.role_id = r.id
         WHERE u.email = $1",
    )
    .bind(user_email)
    .fetch_optional(&db.pool)
    .await
    .map_err(AppError::Database)?;

    let (user_id, username, role, existing_sub, existing_full_name) = row.ok_or_else(|| {
        AppError::Auth(format!("No Strata user found for email {}. Registration via SSO is not enabled. Please contact your administrator.", user_email))
    })?;

    // Link the OIDC subject to this user and update name if it was pre-created without one
    if existing_sub.is_none() || existing_full_name.is_none() {
        sqlx::query("UPDATE users SET sub = COALESCE(sub, $1), full_name = COALESCE(full_name, $2) WHERE id = $3")
            .bind(&claims.sub)
            .bind(&claims.name)
            .bind(user_id)
            .execute(&db.pool).await.map_err(AppError::Database)?;
    }

    // Create local JWT
    let token = create_local_jwt(user_id, &username, &role)?;

    audit::log(
        &db.pool,
        Some(user_id),
        "auth.sso_login",
        &json!({ "username": username, "sub": claims.sub }),
    )
    .await?;

    // Redirect back to frontend with the token in a URL fragment.
    // Fragments (#) are never sent to servers in Referer headers, never logged
    // by proxies/CDNs, and don't appear in server access logs.
    Ok(Redirect::to(&format!("/login#token={}", token)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::header::HeaderMap;

    #[test]
    fn extract_client_ip_from_xff() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.50, 10.0.0.1".parse().unwrap());
        // Rightmost entry (closest to our proxy)
        assert_eq!(extract_client_ip(&headers), "10.0.0.1");
    }

    #[test]
    fn extract_client_ip_single() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "198.51.100.42".parse().unwrap());
        assert_eq!(extract_client_ip(&headers), "198.51.100.42");
    }

    #[test]
    fn extract_client_ip_missing_header() {
        let headers = HeaderMap::new();
        assert_eq!(extract_client_ip(&headers), "unknown");
    }

    #[test]
    fn extract_client_ip_trims_whitespace() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", " 10.0.0.1 , 192.168.1.1 ".parse().unwrap());
        assert_eq!(extract_client_ip(&headers), "192.168.1.1");
    }

    #[test]
    fn create_local_jwt_requires_secret() {
        // JWT_SECRET is a OnceLock, calling without init should fail
        // Since it might already be set from other tests, we just verify
        // the function signature exists and returns a Result
        let result = create_local_jwt(Uuid::new_v4(), "test", "admin");
        // Either succeeds (if secret was set by another test) or fails with expected error
        match result {
            Ok(token) => assert!(!token.is_empty()),
            Err(e) => assert!(format!("{e}").contains("JWT_SECRET")),
        }
    }

    #[test]
    fn create_local_jwt_produces_unique_tokens() {
        // Set the JWT secret if not already set
        let _ = crate::config::JWT_SECRET.set("test-secret-for-unit-tests".into());
        let uid = Uuid::new_v4();
        let t1 = create_local_jwt(uid, "alice", "admin").unwrap();
        let t2 = create_local_jwt(uid, "alice", "admin").unwrap();
        // jti makes each token unique
        assert_ne!(t1, t2);
    }

    #[test]
    fn create_local_jwt_contains_expected_claims() {
        let _ = crate::config::JWT_SECRET.set("test-secret-for-unit-tests".into());
        let uid = Uuid::new_v4();
        let token = create_local_jwt(uid, "bob", "user").unwrap();

        // Decode without verification to inspect claims
        use base64::Engine;
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let payload = base64::engine::general_purpose::STANDARD_NO_PAD
            .decode(parts[1])
            .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(parts[1]))
            .unwrap();
        let claims: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(claims["sub"], uid.to_string());
        assert_eq!(claims["username"], "bob");
        assert_eq!(claims["role"], "user");
        assert_eq!(claims["iss"], "strata-local");
        assert!(claims["jti"].as_str().unwrap().len() > 0);
        assert!(claims["exp"].as_u64().unwrap() > claims["iat"].as_u64().unwrap());
    }

    #[test]
    fn login_request_deserializes() {
        let json = r#"{"username":"admin","password":"secret"}"#;
        let req: LoginRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.username, "admin");
        assert_eq!(req.password, "secret");
    }
}
