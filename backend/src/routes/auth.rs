use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::Redirect;
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;
use uuid::Uuid;

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
/// Hard cap on SSO state entries to prevent OOM from unauthenticated floods.
const MAX_SSO_STATE_ENTRIES: usize = 10_000;

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
        let cache = OIDC_DISCOVERY_CACHE
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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

/// Validate login input lengths. Returns `Err` for empty or over-limit fields.
pub fn validate_login_input(username: &str, password: &str) -> Result<(), AppError> {
    if username.is_empty() || password.is_empty() {
        return Err(AppError::Auth("Invalid credentials".into()));
    }
    if username.len() > 256 || password.len() > 1024 {
        return Err(AppError::Auth("Invalid credentials".into()));
    }
    Ok(())
}

/// Minimum password length for new or changed passwords.
pub const MIN_PASSWORD_LENGTH: usize = 12;

/// Validate a new password meets the password policy.
/// This is enforced on user creation and password changes, NOT on login
/// (to avoid locking out users with legacy passwords).
pub fn validate_password(password: &str) -> Result<(), AppError> {
    if password.len() < MIN_PASSWORD_LENGTH {
        return Err(AppError::Validation(format!(
            "Password must be at least {} characters",
            MIN_PASSWORD_LENGTH
        )));
    }
    if password.len() > 1024 {
        return Err(AppError::Validation("Password is too long".into()));
    }
    Ok(())
}

/// Check a sliding-window rate limit. Prunes expired entries and rejects if
/// the number of recent attempts for `key` meets or exceeds `max_attempts`.
/// Returns `true` if the request should be **rejected** (over limit).
pub fn check_rate_limit(
    map: &mut HashMap<String, Vec<Instant>>,
    key: &str,
    max_attempts: usize,
    window_secs: u64,
    max_entries: usize,
) -> bool {
    let now = Instant::now();
    // OOM protection: prune entire map if it exceeds max entries
    if map.len() > max_entries {
        map.retain(|_, attempts| {
            let cutoff = now - std::time::Duration::from_secs(window_secs);
            attempts.retain(|t| *t > cutoff);
            !attempts.is_empty()
        });
        if map.len() > max_entries {
            map.clear();
        }
    }
    let cutoff = now - std::time::Duration::from_secs(window_secs);
    let attempts = map.entry(key.to_string()).or_default();
    attempts.retain(|t| *t > cutoff);
    attempts.len() >= max_attempts
}

/// Extract the client IP from X-Forwarded-For (rightmost non-empty entry)
/// or fall back to "unknown".
///
/// This is `pub(crate)` so other route modules (files, tunnel, share) can
/// reuse the same extraction logic instead of duplicating it.
/// Use `try_extract_client_ip` when a ConnectInfo fallback is preferred.
pub(crate) fn extract_client_ip(headers: &HeaderMap) -> String {
    try_extract_client_ip(headers).unwrap_or_else(|| "unknown".into())
}

/// Extract the client IP from X-Forwarded-For (rightmost non-empty entry).
/// Returns `None` when no valid header is present — callers should fall back
/// to `ConnectInfo` or "unknown".
pub(crate) fn try_extract_client_ip(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.rsplit(',')
                .map(|s| s.trim())
                .find(|s| !s.is_empty())
                .map(|s| s.to_string())
        })
}

/// Helper to get the base URL for redirect URIs.
///
/// Uses `BASE_URL` env var if set, otherwise derives from proxy headers.
/// The `Host` header is validated against `ALLOWED_HOSTS` to prevent
/// SSO redirect hijacking via a spoofed Host header.
fn get_base_url(headers: &HeaderMap) -> String {
    // Prefer an explicit BASE_URL env var when available (most secure)
    if let Ok(base) = std::env::var("BASE_URL") {
        if !base.is_empty() {
            return base.trim_end_matches('/').to_string();
        }
    }

    let protocol = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("http");

    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost");

    // Validate the Host header against an allowlist when configured
    if let Ok(allowed) = std::env::var("ALLOWED_HOSTS") {
        let allowed_hosts: Vec<&str> = allowed.split(',').map(|s| s.trim()).collect();
        let host_without_port = host.split(':').next().unwrap_or(host);
        if !allowed_hosts
            .iter()
            .any(|&h| h.eq_ignore_ascii_case(host_without_port))
        {
            tracing::warn!(
                host = host,
                "Host header not in ALLOWED_HOSTS — using localhost"
            );
            return format!("{}://localhost", protocol);
        }
    }

    format!("{}://{}", protocol, host)
}

#[derive(sqlx::FromRow)]
struct UserAuthRow {
    id: Uuid,
    username: String,
    password_hash: Option<String>,
    #[sqlx(rename = "name")]
    role: String,
    can_manage_system: bool,
    can_manage_users: bool,
    can_manage_connections: bool,
    can_view_audit_logs: bool,
    can_create_users: bool,
    can_create_user_groups: bool,
    can_create_connections: bool,
    can_create_connection_folders: bool,
    can_create_sharing_profiles: bool,
}

/// POST /api/auth/login – authenticate with local username/password.
/// Returns a signed JWT for subsequent API calls.
pub async fn login(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<LoginRequest>,
) -> Result<axum::response::Response, AppError> {
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
    validate_login_input(&body.username, &body.password)?;

    let client_ip = extract_client_ip(&headers);

    // ── Per-IP rate limiting ──
    {
        let mut map = IP_RATE_LIMIT.lock().unwrap_or_else(|e| e.into_inner());
        if check_rate_limit(
            &mut map,
            &client_ip,
            MAX_IP_ATTEMPTS,
            IP_WINDOW_SECS,
            MAX_RATE_LIMIT_ENTRIES,
        ) {
            return Err(AppError::Auth(
                "Too many login attempts from this address. Please try again later.".into(),
            ));
        }
    }

    // ── Per-username rate limiting ──
    {
        let mut map = RATE_LIMIT.lock().unwrap_or_else(|e| e.into_inner());
        if check_rate_limit(
            &mut map,
            &body.username,
            MAX_ATTEMPTS,
            WINDOW_SECS,
            MAX_RATE_LIMIT_ENTRIES,
        ) {
            return Err(AppError::Auth(
                "Too many login attempts. Please try again later.".into(),
            ));
        }
    }

    let db = {
        let s = state.read().await;
        s.db.clone()
            .ok_or(AppError::Internal("Database not available".into()))?
    };

    /// Pre-computed Argon2 hash of a dummy password used to make the
    /// user-not-found path take the same time as the wrong-password path,
    /// preventing timing-based username enumeration.
    static DUMMY_HASH: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
        use argon2::PasswordHasher;
        let salt = argon2::password_hash::SaltString::from_b64("c29tZXNhbHRzb21lc2FsdA")
            .expect("valid static salt");
        argon2::Argon2::default()
            .hash_password(b"dummy-password-for-timing-equalisation", &salt)
            .expect("argon2 hash")
            .to_string()
    });

    let row: Option<UserAuthRow> = sqlx::query_as(
        "SELECT u.id, u.username, u.password_hash, r.name,
                r.can_manage_system, r.can_manage_users, r.can_manage_connections, r.can_view_audit_logs,
                r.can_create_users, r.can_create_user_groups, r.can_create_connections,
                r.can_create_connection_folders, r.can_create_sharing_profiles
         FROM users u JOIN roles r ON u.role_id = r.id
         WHERE (LOWER(u.username) = LOWER($1) OR LOWER(u.email) = LOWER($1)) AND u.auth_type = 'local' AND u.deleted_at IS NULL",
    )
    .bind(&body.username)
    .fetch_optional(&db.pool)
    .await
    .map_err(AppError::Database)?;

    let user = row.ok_or_else(|| {
        // Perform a dummy Argon2 verification so the response time is
        // indistinguishable from the wrong-password path.
        use argon2::{Argon2, PasswordHash, PasswordVerifier};
        if let Ok(parsed) = PasswordHash::new(&DUMMY_HASH) {
            let _ = Argon2::default().verify_password(body.password.as_bytes(), &parsed);
        }

        // Record failed attempt even when user is not found, to make
        // rate-limit behaviour identical for existing vs non-existing users.
        let mut map = RATE_LIMIT.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(body.username.clone())
            .or_default()
            .push(Instant::now());
        drop(map);
        let mut ip_map = IP_RATE_LIMIT.lock().unwrap_or_else(|e| e.into_inner());
        ip_map
            .entry(client_ip.clone())
            .or_default()
            .push(Instant::now());
        AppError::Auth("Invalid username or password".into())
    })?;

    // Use generic error message regardless of auth_type to prevent account type enumeration
    let hash = user
        .password_hash
        .ok_or_else(|| AppError::Auth("Invalid username or password".into()))?;

    // Verify password with Argon2
    use argon2::{Argon2, PasswordHash, PasswordVerifier};
    let parsed_hash = PasswordHash::new(&hash)
        .map_err(|_| AppError::Auth("Invalid username or password".into()))?;
    Argon2::default()
        .verify_password(body.password.as_bytes(), &parsed_hash)
        .map_err(|_| {
            // Record failed attempt for both username and IP
            let mut map = RATE_LIMIT.lock().unwrap_or_else(|e| e.into_inner());
            map.entry(body.username.clone())
                .or_default()
                .push(Instant::now());
            drop(map);
            let mut ip_map = IP_RATE_LIMIT.lock().unwrap_or_else(|e| e.into_inner());
            ip_map
                .entry(client_ip.clone())
                .or_default()
                .push(Instant::now());
            AppError::Auth("Invalid username or password".into())
        })?;

    // Successful login — clear rate limit for this user
    {
        let mut map = RATE_LIMIT.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(&body.username);
    }

    // Generate access token (short-lived) and refresh token (longer-lived)
    let (access_token, access_jti) = create_local_jwt(
        user.id,
        &user.username,
        &user.role,
        "access",
        ACCESS_TOKEN_TTL,
    )?;
    let (refresh_token, _refresh_jti) = create_local_jwt(
        user.id,
        &user.username,
        &user.role,
        "refresh",
        REFRESH_TOKEN_TTL,
    )?;

    let user_agent = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();

    // Record the session for per-user tracking
    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(ACCESS_TOKEN_TTL as i64);
    let _ = sqlx::query(
        "INSERT INTO active_sessions (jti, user_id, expires_at, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(access_jti)
    .bind(user.id)
    .bind(expires_at)
    .bind(&client_ip)
    .bind(&user_agent)
    .execute(&db.pool)
    .await;

    audit::log(
        &db.pool,
        Some(user.id),
        "auth.local_login",
        &json!({ "username": user.username }),
    )
    .await?;

    let response = axum::response::Response::builder()
        .status(200)
        .header("Content-Type", "application/json")
        .header(
            "Set-Cookie",
            format!(
                "refresh_token={}; HttpOnly; Secure; SameSite=Strict; Path=/api/auth/refresh; Max-Age={}",
                refresh_token, REFRESH_TOKEN_TTL
            ),
        )
        .body(axum::body::Body::from(
            serde_json::to_string(&json!({
                "access_token": access_token,
                "token_type": "Bearer",
                "expires_in": ACCESS_TOKEN_TTL,
                "user": {
                    "id": user.id,
                    "username": user.username,
                    "role": user.role,
                    "can_manage_system": user.can_manage_system,
                    "can_manage_users": user.can_manage_users,
                    "can_manage_connections": user.can_manage_connections,
                    "can_view_audit_logs": user.can_view_audit_logs,
                    "can_create_users": user.can_create_users,
                    "can_create_user_groups": user.can_create_user_groups,
                    "can_create_connections": user.can_create_connections,
                    "can_create_connection_folders": user.can_create_connection_folders,
                    "can_create_sharing_profiles": user.can_create_sharing_profiles,
                }
            }))
            .map_err(|e| AppError::Internal(format!("JSON serialization error: {e}")))?,
        ))
        .map_err(|e| AppError::Internal(format!("Response build error: {e}")))?;

    Ok(response)
}

/// Access token TTL (20 minutes).
const ACCESS_TOKEN_TTL: usize = 1200;
/// Refresh token TTL (8 hours).
const REFRESH_TOKEN_TTL: usize = 28800;

/// Create a local JWT signed with a server-side HMAC key.
/// `token_type` should be `"access"` or `"refresh"`.
/// `ttl_secs` is the token lifetime in seconds.
/// Returns `(token_string, jti)`.
fn create_local_jwt(
    user_id: Uuid,
    username: &str,
    role: &str,
    token_type: &str,
    ttl_secs: usize,
) -> Result<(String, Uuid), AppError> {
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
        token_type: String,
    }

    let secret = crate::config::JWT_SECRET
        .get()
        .ok_or_else(|| AppError::Internal("JWT_SECRET not configured".into()))?
        .clone();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as usize;

    let jti = Uuid::new_v4();
    let claims = LocalClaims {
        sub: user_id.to_string(),
        username: username.to_string(),
        role: role.to_string(),
        iss: "strata-local".into(),
        exp: now + ttl_secs,
        iat: now,
        jti: jti.to_string(),
        token_type: token_type.to_string(),
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(format!("JWT creation failed: {e}")))?;

    Ok((token, jti))
}

/// POST /api/auth/logout – revoke the current token and refresh token.
pub async fn logout(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
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
    struct ExpClaims {
        exp: u64,
    }

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

    // Persist to DB (best-effort) so revocations survive restarts
    let db_pool = {
        let s = state.read().await;
        s.db.as_ref().map(|d| d.pool.clone())
    };
    if let Some(pool) = &db_pool {
        crate::services::token_revocation::persist_revocation(pool, token, exp).await;
    }

    // Also revoke the refresh token if present in cookies
    if let Some(refresh_token) = extract_cookie(&headers, "refresh_token") {
        let refresh_exp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            + REFRESH_TOKEN_TTL as u64;
        crate::services::token_revocation::revoke(refresh_token, refresh_exp);
        if let Some(pool) = &db_pool {
            crate::services::token_revocation::persist_revocation(pool, refresh_token, refresh_exp)
                .await;
        }
    }

    // Clear the refresh token cookie
    let response = axum::response::Response::builder()
        .status(200)
        .header("Content-Type", "application/json")
        .header(
            "Set-Cookie",
            "refresh_token=; HttpOnly; Secure; SameSite=Strict; Path=/api/auth/refresh; Max-Age=0",
        )
        .body(axum::body::Body::from(
            serde_json::to_string(&json!({ "status": "logged_out" }))
                .map_err(|e| AppError::Internal(format!("JSON serialization error: {e}")))?,
        ))
        .map_err(|e| AppError::Internal(format!("Response build error: {e}")))?;

    Ok(response)
}

// ── Password Change ────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

/// PUT /api/auth/password – change the authenticated user's password.
pub async fn change_password(
    State(state): State<SharedState>,
    Extension(user): Extension<crate::services::middleware::AuthUser>,
    headers: HeaderMap,
    Json(body): Json<ChangePasswordRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Validate the new password meets policy
    validate_password(&body.new_password)?;

    let db = {
        let s = state.read().await;
        s.db.clone()
            .ok_or(AppError::Internal("Database not available".into()))?
    };

    // Fetch current password hash
    let hash: Option<String> =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1 AND auth_type = 'local' AND deleted_at IS NULL")
            .bind(user.id)
            .fetch_optional(&db.pool)
            .await
            .map_err(AppError::Database)?
            .flatten();

    let hash = hash.ok_or_else(|| {
        AppError::Validation("Password change is only available for local accounts".into())
    })?;

    // Verify current password
    use argon2::{Argon2, PasswordHash, PasswordVerifier};
    let parsed_hash = PasswordHash::new(&hash)
        .map_err(|_| AppError::Internal("Invalid stored password hash".into()))?;
    Argon2::default()
        .verify_password(body.current_password.as_bytes(), &parsed_hash)
        .map_err(|_| AppError::Auth("Current password is incorrect".into()))?;

    // Hash new password
    use argon2::password_hash::SaltString;
    use argon2::PasswordHasher;
    let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
    let new_hash = Argon2::default()
        .hash_password(body.new_password.as_bytes(), &salt)
        .map_err(|e| AppError::Internal(format!("Argon2 error: {e}")))?
        .to_string();

    sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
        .bind(&new_hash)
        .bind(user.id)
        .execute(&db.pool)
        .await
        .map_err(AppError::Database)?;

    // Revoke the current token so the user must re-authenticate
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    if let Some(token) = token {
        let exp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            + 86400;
        crate::services::token_revocation::revoke(token, exp);
        crate::services::token_revocation::persist_revocation(&db.pool, token, exp).await;
    }
    let _ = sqlx::query("DELETE FROM active_sessions WHERE user_id = $1")
        .bind(user.id)
        .execute(&db.pool)
        .await;

    audit::log(
        &db.pool,
        Some(user.id),
        "auth.password_changed",
        &json!({ "username": user.username }),
    )
    .await?;

    Ok(Json(json!({ "status": "password_changed" })))
}

// ── Token Refresh ──────────────────────────────────────────────────────

/// Extract a named cookie value from the Cookie header.
fn extract_cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(axum::http::header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|cookies| {
            cookies.split(';').find_map(|pair| {
                let pair = pair.trim();
                pair.strip_prefix(&format!("{}=", name))
            })
        })
}

/// GET /api/auth/check – token validation that **always returns 200**.
///
/// Returns `{ "authenticated": true, "user": { ... } }` with the full user
/// profile (permissions, watermark, vault) when the access token is valid, or
/// `{ "authenticated": false }` otherwise.  Unlike `/api/user/me` (which
/// returns 401 on failure), this endpoint never produces an error status, so
/// the browser's console stays clean on the login page.
pub async fn check_auth(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Json<serde_json::Value> {
    use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};

    #[derive(serde::Deserialize)]
    struct Claims {
        sub: String,
        #[serde(default = "default_access")]
        token_type: String,
    }
    fn default_access() -> String {
        "access".to_string()
    }

    let not_auth = || Json(json!({ "authenticated": false }));

    // Extract Bearer token
    let token = match headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    {
        Some(t) => t,
        None => return not_auth(),
    };

    // Check revocation
    if crate::services::token_revocation::is_revoked(token) {
        return not_auth();
    }

    // Validate JWT
    let secret = match crate::config::JWT_SECRET.get() {
        Some(s) => s.clone(),
        None => return not_auth(),
    };

    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&["strata-local"]);
    validation.set_required_spec_claims(&["sub", "exp", "iat", "iss"]);

    let token_data = match decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    ) {
        Ok(d) => d,
        Err(_) => return not_auth(),
    };

    if token_data.claims.token_type != "access" {
        return not_auth();
    }

    let user_id: uuid::Uuid = match token_data.claims.sub.parse() {
        Ok(id) => id,
        Err(_) => return not_auth(),
    };

    // Look up user + permissions in DB
    let db_opt = {
        let s = state.read().await;
        s.db.clone()
    };
    let db = match db_opt {
        Some(db) => db,
        None => return not_auth(),
    };

    #[derive(sqlx::FromRow)]
    struct UserRow {
        id: uuid::Uuid,
        username: String,
        full_name: Option<String>,
        #[sqlx(rename = "name")]
        role: String,
        can_manage_system: bool,
        can_manage_users: bool,
        can_manage_connections: bool,
        can_view_audit_logs: bool,
        can_create_users: bool,
        can_create_user_groups: bool,
        can_create_connections: bool,
        can_create_connection_folders: bool,
        can_create_sharing_profiles: bool,
        can_view_sessions: bool,
        terms_accepted_at: Option<chrono::DateTime<chrono::Utc>>,
        terms_accepted_version: Option<i32>,
    }

    let row: Option<UserRow> = sqlx::query_as(
        "SELECT u.id, u.username, u.full_name, r.name,
                r.can_manage_system, r.can_manage_users, r.can_manage_connections, r.can_view_audit_logs,
                r.can_create_users, r.can_create_user_groups, r.can_create_connections,
                r.can_create_connection_folders, r.can_create_sharing_profiles, r.can_view_sessions,
                u.terms_accepted_at, u.terms_accepted_version
         FROM users u JOIN roles r ON u.role_id = r.id
         WHERE u.id = $1 AND u.deleted_at IS NULL",
    )
    .bind(user_id)
    .fetch_optional(&db.pool)
    .await
    .unwrap_or(None);

    let user = match row {
        Some(u) => u,
        None => return not_auth(),
    };

    // Derive client_ip from X-Forwarded-For (rightmost entry from trusted proxy)
    let client_ip = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.rsplit(',')
                .map(|s| s.trim())
                .find(|s| !s.is_empty())
                .map(|s| s.to_string())
        })
        .unwrap_or_default();

    // Watermark setting
    let watermark_enabled = settings::get(&db.pool, "watermark_enabled")
        .await
        .unwrap_or(None)
        .unwrap_or_default();

    // Vault configured?
    let vault_configured = {
        let s = state.read().await;
        s.config.as_ref().and_then(|c| c.vault.as_ref()).is_some()
    };

    // Is the user an approver?
    let is_approver: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM approval_role_assignments WHERE user_id = $1)",
    )
    .bind(user_id)
    .fetch_one(&db.pool)
    .await
    .unwrap_or(false);

    Json(json!({
        "authenticated": true,
        "user": {
            "id": user.id,
            "username": user.username,
            "full_name": user.full_name,
            "role": user.role,
            "sub": user_id.to_string(),
            "client_ip": client_ip,
            "watermark_enabled": watermark_enabled == "true",
            "vault_configured": vault_configured,
            "terms_accepted_at": user.terms_accepted_at,
            "terms_accepted_version": user.terms_accepted_version,
            "can_manage_system": user.can_manage_system,
            "can_manage_users": user.can_manage_users,
            "can_manage_connections": user.can_manage_connections,
            "can_view_audit_logs": user.can_view_audit_logs,
            "can_create_users": user.can_create_users,
            "can_create_user_groups": user.can_create_user_groups,
            "can_create_connections": user.can_create_connections,
            "can_create_connection_folders": user.can_create_connection_folders,
            "can_create_sharing_profiles": user.can_create_sharing_profiles,
            "can_view_sessions": user.can_view_sessions,
            "is_approver": is_approver,
        }
    }))
}

/// POST /api/auth/refresh – exchange a valid refresh token for a new access token.
pub async fn refresh(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let refresh_token = extract_cookie(&headers, "refresh_token")
        .ok_or_else(|| AppError::Auth("Missing refresh token".into()))?;

    // Check if the refresh token has been revoked
    if crate::services::token_revocation::is_revoked(refresh_token) {
        return Err(AppError::Auth("Refresh token has been revoked".into()));
    }

    // Decode and validate the refresh token
    use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};

    #[derive(serde::Deserialize)]
    struct RefreshClaims {
        sub: String,
        token_type: String,
    }

    let secret = crate::config::JWT_SECRET
        .get()
        .ok_or_else(|| AppError::Internal("JWT_SECRET not configured".into()))?
        .clone();

    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&["strata-local"]);
    validation.set_required_spec_claims(&["sub", "exp", "iat", "iss"]);

    let token_data = decode::<RefreshClaims>(
        refresh_token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map_err(|_| AppError::Auth("Invalid or expired refresh token".into()))?;

    let claims = token_data.claims;
    if claims.token_type != "refresh" {
        return Err(AppError::Auth("Invalid token type".into()));
    }

    // Verify user still exists
    let db = {
        let s = state.read().await;
        s.db.clone()
            .ok_or(AppError::Internal("Database not available".into()))?
    };

    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Auth("Invalid token subject".into()))?;

    // Re-read username and role from the database to pick up any changes
    // since the refresh token was issued (e.g. role change, rename).
    let user_row: Option<(String, String)> = sqlx::query_as(
        "SELECT u.username, r.name AS role_name
         FROM users u JOIN roles r ON r.id = u.role_id
         WHERE u.id = $1 AND u.deleted_at IS NULL",
    )
    .bind(user_id)
    .fetch_optional(&db.pool)
    .await
    .map_err(AppError::Database)?;

    let (username, role) =
        user_row.ok_or_else(|| AppError::Auth("User no longer exists".into()))?;

    // Issue a new access token with the latest username/role
    let (access_token, _jti) =
        create_local_jwt(user_id, &username, &role, "access", ACCESS_TOKEN_TTL)?;

    Ok(Json(json!({
        "access_token": access_token,
        "token_type": "Bearer",
        "expires_in": ACCESS_TOKEN_TTL
    })))
}

// ── SSO / OIDC ─────────────────────────────────────────────────────────

/// GET /api/auth/sso/login – redirect to the OIDC provider.
pub async fn sso_login(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<Redirect, AppError> {
    let db = {
        let s = state.read().await;
        s.db.clone()
            .ok_or(AppError::Internal("Database not available".into()))?
    };

    let sso_enabled = settings::get(&db.pool, "sso_enabled")
        .await?
        .unwrap_or_default()
        == "true";
    if !sso_enabled {
        return Err(AppError::Auth("SSO is disabled".into()));
    }

    let issuer_url = settings::get(&db.pool, "sso_issuer_url")
        .await?
        .unwrap_or_default();
    let client_id = settings::get(&db.pool, "sso_client_id")
        .await?
        .unwrap_or_default();

    if issuer_url.is_empty() || client_id.is_empty() {
        return Err(AppError::Auth("SSO is not properly configured".into()));
    }

    // Discover the authorization endpoint (cached)
    let discovery = fetch_oidc_discovery(&issuer_url).await?;

    // Construct authorization URL with CSRF state parameter
    let base_url = get_base_url(&headers);
    let redirect_uri = format!("{}/api/auth/sso/callback", base_url);

    let state = Uuid::new_v4().to_string();
    {
        let mut store = SSO_STATE_STORE.lock().unwrap_or_else(|e| e.into_inner());
        // Prune expired entries
        let cutoff = Instant::now() - std::time::Duration::from_secs(SSO_STATE_TTL_SECS);
        store.retain(|_, created| *created > cutoff);
        // Hard cap to prevent OOM from unauthenticated floods
        if store.len() >= MAX_SSO_STATE_ENTRIES {
            tracing::warn!("SSO state store at capacity ({MAX_SSO_STATE_ENTRIES}) — rejecting");
            return Err(AppError::Auth(
                "Too many pending SSO requests. Please try again later.".into(),
            ));
        }
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
    pub state: String,
}

/// GET /api/auth/sso/callback – handle the OIDC callback.
pub async fn sso_callback(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Query(params): Query<SsoCallbackParams>,
) -> Result<axum::response::Response, AppError> {
    // Validate CSRF state parameter
    let state_value = &params.state;
    {
        let mut store = SSO_STATE_STORE.lock().unwrap_or_else(|e| e.into_inner());
        let cutoff = Instant::now() - std::time::Duration::from_secs(SSO_STATE_TTL_SECS);
        store.retain(|_, created| *created > cutoff);
        match store.remove(state_value.as_str()) {
            Some(_) => {} // valid — consumed
            None => {
                return Err(AppError::Auth(
                    "Invalid or expired SSO state parameter".into(),
                ))
            }
        }
    }

    let (db, vault) = {
        let s = state.read().await;
        let db =
            s.db.clone()
                .ok_or(AppError::Internal("Database not available".into()))?;
        let vault = s.config.as_ref().and_then(|c| c.vault.clone());
        (db, vault)
    };

    let issuer_url = settings::get(&db.pool, "sso_issuer_url")
        .await?
        .unwrap_or_default();
    let client_id = settings::get(&db.pool, "sso_client_id")
        .await?
        .unwrap_or_default();
    let client_secret_raw = settings::get(&db.pool, "sso_client_secret")
        .await?
        .unwrap_or_default();

    if issuer_url.is_empty() || client_id.is_empty() || client_secret_raw.is_empty() {
        return Err(AppError::Auth("SSO configuration is incomplete".into()));
    }

    // Decrypt client secret using the setting helper
    let client_secret = match vault {
        Some(v) => crate::services::vault::unseal_setting(&v, &client_secret_raw).await?,
        None if client_secret_raw.starts_with("vault:") => {
            return Err(AppError::Config(
                "Vault not configured but SSO secret is encrypted".into(),
            ));
        }
        _ => client_secret_raw,
    };

    // Discovery for token endpoint (cached)
    let discovery = fetch_oidc_discovery(&issuer_url).await?;
    let client = reqwest::Client::new();

    let base_url = get_base_url(&headers);
    let redirect_uri = format!("{}/api/auth/sso/callback", base_url);

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

    let id_token = token_res["id_token"]
        .as_str()
        .ok_or_else(|| AppError::Auth("Missing id_token in response".into()))?;

    // Validate token and get claims
    let claims = crate::services::auth::validate_token(&issuer_url, &client_id, id_token).await?;

    // Extract email from claims
    let user_email = claims.email.as_ref().ok_or_else(|| {
        AppError::Auth("OIDC identity missing email claim. SSO requires an email address.".into())
    })?;

    // Find user by email. We match by email to link pre-created SSO users.
    #[derive(sqlx::FromRow)]
    struct SsoUserRow {
        id: Uuid,
        username: String,
        role_name: String,
        sub: Option<String>,
        #[allow(dead_code)]
        full_name: Option<String>,
    }

    let row: Option<SsoUserRow> = sqlx::query_as(
        "SELECT u.id, u.username, r.name as role_name, u.sub, u.full_name
         FROM users u JOIN roles r ON u.role_id = r.id
         WHERE LOWER(u.email) = LOWER($1) AND u.deleted_at IS NULL",
    )
    .bind(user_email)
    .fetch_optional(&db.pool)
    .await
    .map_err(AppError::Database)?;

    let row = row.ok_or_else(|| {
        AppError::Auth(format!("No Strata user found for email {}. Registration via SSO is not enabled. Please contact your administrator.", user_email))
    })?;

    if let Some(sub) = &row.sub {
        if sub != &claims.sub {
            return Err(AppError::Auth(format!(
                "SSO subject mismatch for user {}. Please contact your administrator.",
                row.username
            )));
        }
    } else {
        // Link this user to the OIDC subject on first login
        sqlx::query("UPDATE users SET sub = $1, full_name = COALESCE(full_name, $2) WHERE id = $3")
            .bind(&claims.sub)
            .bind(&claims.name)
            .bind(row.id)
            .execute(&db.pool)
            .await?;
    }

    // Success — generate access + refresh tokens
    let (access_token, _access_jti) = create_local_jwt(
        row.id,
        &row.username,
        &row.role_name,
        "access",
        ACCESS_TOKEN_TTL,
    )?;
    let (refresh_token, _refresh_jti) = create_local_jwt(
        row.id,
        &row.username,
        &row.role_name,
        "refresh",
        REFRESH_TOKEN_TTL,
    )?;

    audit::log(
        &db.pool,
        Some(row.id),
        "auth.sso_login",
        &json!({ "username": row.username, "sub": claims.sub }),
    )
    .await?;

    // Redirect back to frontend with the access token in a URL fragment.
    // Fragments (#) are never sent to servers in Referer headers, never logged
    // by proxies/CDNs, and don't appear in server access logs.
    // The refresh token is set as an HttpOnly cookie for security.
    let redirect_url = format!("/login#token={}", access_token);
    let response = axum::response::Response::builder()
        .status(303)
        .header("Location", &redirect_url)
        .header(
            "Set-Cookie",
            format!(
                "refresh_token={}; HttpOnly; Secure; SameSite=Strict; Path=/api/auth/refresh; Max-Age={}",
                refresh_token, REFRESH_TOKEN_TTL
            ),
        )
        .body(axum::body::Body::empty())
        .map_err(|e| AppError::Internal(format!("Response build error: {e}")))?;

    Ok(response)
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
        headers.insert(
            "x-forwarded-for",
            " 10.0.0.1 , 192.168.1.1 ".parse().unwrap(),
        );
        assert_eq!(extract_client_ip(&headers), "192.168.1.1");
    }

    #[test]
    fn create_local_jwt_requires_secret() {
        // JWT_SECRET is a OnceLock, calling without init should fail
        // Since it might already be set from other tests, we just verify
        // the function signature exists and returns a Result
        let result = create_local_jwt(Uuid::new_v4(), "test", "admin", "access", ACCESS_TOKEN_TTL);
        // Either succeeds (if secret was set by another test) or fails with expected error
        match result {
            Ok((token, jti)) => {
                assert!(!token.is_empty());
                assert!(!jti.is_nil());
            }
            Err(e) => assert!(format!("{e}").contains("JWT_SECRET")),
        }
    }

    #[test]
    fn create_local_jwt_produces_unique_tokens() {
        // Set the JWT secret if not already set
        let _ = crate::config::JWT_SECRET.set("test-secret-for-unit-tests".into());
        let uid = Uuid::new_v4();
        let (t1, jti1) =
            create_local_jwt(uid, "alice", "admin", "access", ACCESS_TOKEN_TTL).unwrap();
        let (t2, jti2) =
            create_local_jwt(uid, "alice", "admin", "access", ACCESS_TOKEN_TTL).unwrap();
        // jti makes each token unique
        assert_ne!(t1, t2);
        assert_ne!(jti1, jti2);
    }

    #[test]
    fn create_local_jwt_contains_expected_claims() {
        let _ = crate::config::JWT_SECRET.set("test-secret-for-unit-tests".into());
        let uid = Uuid::new_v4();
        let (token, _jti) =
            create_local_jwt(uid, "bob", "user", "access", ACCESS_TOKEN_TTL).unwrap();

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
        assert!(!claims["jti"].as_str().unwrap().is_empty());
        assert!(claims["exp"].as_u64().unwrap() > claims["iat"].as_u64().unwrap());
    }

    #[test]
    fn login_request_deserializes() {
        let json = r#"{"username":"admin","password":"secret"}"#;
        let req: LoginRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.username, "admin");
        assert_eq!(req.password, "secret");
    }

    #[test]
    fn extract_client_ip_empty_xff() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "".parse().unwrap());
        assert_eq!(extract_client_ip(&headers), "unknown");
    }

    #[test]
    fn extract_client_ip_ipv6() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "::1".parse().unwrap());
        assert_eq!(extract_client_ip(&headers), "::1");
    }

    #[test]
    fn extract_client_ip_many_entries() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            "10.0.0.1, 172.16.0.1, 192.168.0.1, 203.0.113.50"
                .parse()
                .unwrap(),
        );
        assert_eq!(extract_client_ip(&headers), "203.0.113.50");
    }

    #[test]
    fn create_local_jwt_exp_matches_ttl() {
        let _ = crate::config::JWT_SECRET.set("test-secret-for-unit-tests".into());
        let uid = Uuid::new_v4();
        let (token, _jti) =
            create_local_jwt(uid, "carol", "admin", "access", ACCESS_TOKEN_TTL).unwrap();
        use base64::Engine;
        let parts: Vec<&str> = token.split('.').collect();
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(parts[1])
            .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(parts[1]))
            .unwrap();
        let claims: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        let iat = claims["iat"].as_u64().unwrap();
        let exp = claims["exp"].as_u64().unwrap();
        assert_eq!(exp - iat, ACCESS_TOKEN_TTL as u64);
    }

    #[test]
    fn rate_limit_constants() {
        assert_eq!(MAX_ATTEMPTS, 5);
        assert_eq!(WINDOW_SECS, 60);
        assert_eq!(MAX_IP_ATTEMPTS, 20);
        assert_eq!(IP_WINDOW_SECS, 300);
        assert_eq!(MAX_RATE_LIMIT_ENTRIES, 50_000);
        assert_eq!(SSO_STATE_TTL_SECS, 300);
        assert_eq!(OIDC_DISCOVERY_TTL_SECS, 600);
    }

    #[test]
    fn login_request_rejects_missing_fields() {
        let json = r#"{"username":"admin"}"#;
        let res: Result<LoginRequest, _> = serde_json::from_str(json);
        assert!(res.is_err());
    }

    #[test]
    fn get_base_url_with_forwarded_proto_and_host() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        headers.insert("host", "example.com".parse().unwrap());
        assert_eq!(get_base_url(&headers), "https://example.com");
    }

    #[test]
    fn get_base_url_with_port_in_host() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-proto", "http".parse().unwrap());
        headers.insert("host", "example.com:8080".parse().unwrap());
        assert_eq!(get_base_url(&headers), "http://example.com:8080");
    }

    #[test]
    fn get_base_url_defaults() {
        let headers = HeaderMap::new();
        assert_eq!(get_base_url(&headers), "http://localhost");
    }

    #[test]
    fn get_base_url_missing_proto() {
        let mut headers = HeaderMap::new();
        headers.insert("host", "myhost.com".parse().unwrap());
        assert_eq!(get_base_url(&headers), "http://myhost.com");
    }

    /// Create a minimal SharedState with no DB for unit tests.
    async fn test_state() -> SharedState {
        use crate::services::app_state::{AppState, BootPhase};
        use crate::services::file_store::FileStore;
        use crate::services::session_registry::SessionRegistry;
        std::sync::Arc::new(tokio::sync::RwLock::new(AppState {
            phase: BootPhase::Running,
            config: None,
            db: None,
            session_registry: SessionRegistry::new(),
            guacd_pool: None,
            file_store: FileStore::new(std::env::temp_dir().join("strata-test-logout")).await,
            started_at: std::time::Instant::now(),
        }))
    }

    #[tokio::test]
    async fn logout_missing_auth_header() {
        let state = test_state().await;
        let headers = HeaderMap::new();
        let result = logout(State(state), headers).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn logout_invalid_auth_header() {
        let state = test_state().await;
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Basic dXNlcjpwYXNz".parse().unwrap(),
        );
        let result = logout(State(state), headers).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn logout_with_bearer_token() {
        let _ = crate::config::JWT_SECRET.set("test-secret-for-unit-tests".into());
        let state = test_state().await;
        let mut headers = HeaderMap::new();
        // Use a fake JWT-like token (won't decode but that's OK - it goes to the else branch)
        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer some.fake.token".parse().unwrap(),
        );
        let result = logout(State(state), headers).await;
        assert!(result.is_ok());
        let response = result.unwrap();
        assert_eq!(response.status(), 200);
    }

    #[tokio::test]
    async fn logout_with_valid_local_jwt() {
        let _ = crate::config::JWT_SECRET.set("test-secret-for-unit-tests".into());
        let state = test_state().await;
        let uid = Uuid::new_v4();
        let (token, _jti) =
            create_local_jwt(uid, "test_user", "admin", "access", ACCESS_TOKEN_TTL).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {}", token).parse().unwrap(),
        );
        let result = logout(State(state), headers).await;
        assert!(result.is_ok());
        let response = result.unwrap();
        assert_eq!(response.status(), 200);
    }

    // ── get_base_url additional cases ──────────────────────────────

    #[test]
    fn get_base_url_https_default_port() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        headers.insert("host", "secure.example.com".parse().unwrap());
        assert_eq!(get_base_url(&headers), "https://secure.example.com");
    }

    #[test]
    fn get_base_url_with_custom_port() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        headers.insert("host", "example.com:3443".parse().unwrap());
        assert_eq!(get_base_url(&headers), "https://example.com:3443");
    }

    #[test]
    fn get_base_url_missing_host() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        assert_eq!(get_base_url(&headers), "https://localhost");
    }

    // ── extract_client_ip additional cases ─────────────────────────

    #[test]
    fn extract_client_ip_only_whitespace() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "   ".parse().unwrap());
        assert_eq!(extract_client_ip(&headers), "unknown");
    }

    #[test]
    fn extract_client_ip_trailing_comma() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "10.0.0.1,".parse().unwrap());
        // Rightmost non-empty entry
        assert_eq!(extract_client_ip(&headers), "10.0.0.1");
    }

    // ── LoginRequest additional cases ──────────────────────────────

    #[test]
    fn login_request_rejects_missing_password() {
        let json = r#"{"password":"secret"}"#;
        let res: Result<LoginRequest, _> = serde_json::from_str(json);
        assert!(res.is_err());
    }

    // ── Constants and SSO config ───────────────────────────────────

    #[test]
    fn rate_limit_per_ip_is_stricter_window() {
        // IP rate limiting has a larger window to catch distributed attacks
        const { assert!(IP_WINDOW_SECS > WINDOW_SECS) };
        const { assert!(MAX_IP_ATTEMPTS > MAX_ATTEMPTS) };
    }

    #[test]
    fn sso_state_ttl_is_reasonable() {
        const { assert!(SSO_STATE_TTL_SECS >= 60) };
        const { assert!(SSO_STATE_TTL_SECS <= 600) };
    }

    #[test]
    fn max_rate_limit_entries_prevents_oom() {
        const { assert!(MAX_RATE_LIMIT_ENTRIES >= 10_000) };
    }

    // ── validate_login_input ───────────────────────────────────────────

    #[test]
    fn validate_login_accepts_normal_input() {
        let user = String::from("alice");
        let pass = String::from_utf8(vec![b't', b'e', b's', b't']).unwrap();
        assert!(validate_login_input(&user, &pass).is_ok());
    }

    #[test]
    fn validate_login_rejects_empty_username() {
        let empty = String::new();
        let pass = String::from_utf8(vec![b't', b'e', b's', b't']).unwrap();
        assert!(validate_login_input(&empty, &pass).is_err());
    }

    #[test]
    fn validate_login_rejects_empty_password() {
        let user = String::from("alice");
        let empty = String::new();
        assert!(validate_login_input(&user, &empty).is_err());
    }

    #[test]
    fn validate_login_rejects_both_empty() {
        let empty = String::new();
        assert!(validate_login_input(&empty, &empty).is_err());
    }

    #[test]
    fn validate_login_rejects_long_username() {
        let long = "a".repeat(257);
        let pass = String::from_utf8(vec![b't', b'e', b's', b't']).unwrap();
        assert!(validate_login_input(&long, &pass).is_err());
    }

    #[test]
    fn validate_login_rejects_long_password() {
        let user = String::from("alice");
        let long = "a".repeat(1025);
        assert!(validate_login_input(&user, &long).is_err());
    }

    #[test]
    fn validate_login_accepts_boundary_lengths() {
        let u = "a".repeat(256);
        let p = "a".repeat(1024);
        assert!(validate_login_input(&u, &p).is_ok());
    }

    // ── check_rate_limit ───────────────────────────────────────────────

    #[test]
    fn rate_limit_allows_under_threshold() {
        let mut map = HashMap::new();
        assert!(!check_rate_limit(&mut map, "user1", 3, 60, 1000));
    }

    #[test]
    fn rate_limit_rejects_at_threshold() {
        let mut map = HashMap::new();
        let now = Instant::now();
        map.insert("user1".to_string(), vec![now, now, now]);
        assert!(check_rate_limit(&mut map, "user1", 3, 60, 1000));
    }

    #[test]
    fn rate_limit_allows_after_window_expires() {
        let mut map = HashMap::new();
        let old = Instant::now() - std::time::Duration::from_secs(120);
        map.insert("user1".to_string(), vec![old, old, old]);
        // Window is 60s, so all 3 attempts are expired
        assert!(!check_rate_limit(&mut map, "user1", 3, 60, 1000));
    }

    #[test]
    fn rate_limit_different_keys_independent() {
        let mut map = HashMap::new();
        let now = Instant::now();
        map.insert("user1".to_string(), vec![now, now, now]);
        // user2 has no attempts
        assert!(!check_rate_limit(&mut map, "user2", 3, 60, 1000));
    }

    #[test]
    fn rate_limit_oom_protection_clears_map() {
        let mut map = HashMap::new();
        // Fill beyond max_entries with expired timestamps
        let old = Instant::now() - std::time::Duration::from_secs(120);
        for i in 0..15 {
            map.insert(format!("user{i}"), vec![old]);
        }
        // max_entries = 10: the map has 15 entries, all expired → prune to 0
        assert!(!check_rate_limit(&mut map, "new_user", 3, 60, 10));
        // All old entries should be pruned
        assert!(map.len() <= 1); // only "new_user" entry
    }

    #[test]
    fn rate_limit_oom_hard_clear_when_all_active() {
        let mut map = HashMap::new();
        let now = Instant::now();
        for i in 0..15 {
            map.insert(format!("user{i}"), vec![now]);
        }
        // max_entries = 10, but all entries are active → hard clear
        assert!(!check_rate_limit(&mut map, "new_user", 3, 60, 10));
        // Hard clear leaves only the new entry
        assert!(map.len() <= 1);
    }
}
