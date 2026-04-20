use axum::{
    extract::{Request, State},
    http,
    middleware::Next,
    response::Response,
};
use uuid::Uuid;

use crate::error::AppError;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::auth;
use crate::services::settings;

/// Authenticated user identity resolved from the JWT and matched to the DB.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: Uuid,
    pub sub: String,
    pub username: String,
    pub full_name: Option<String>,
    pub role: String,
    pub can_manage_system: bool,
    pub can_manage_users: bool,
    pub can_manage_connections: bool,
    pub can_view_audit_logs: bool,
    pub can_create_users: bool,
    pub can_create_user_groups: bool,
    pub can_create_connections: bool,
    pub can_create_connection_folders: bool,
    pub can_create_sharing_profiles: bool,
    pub can_view_sessions: bool,
}

#[derive(sqlx::FromRow)]
struct UserPermissionsRow {
    pub id: Uuid,
    pub username: String,
    pub full_name: Option<String>,
    #[sqlx(rename = "name")]
    pub role: String,
    pub can_manage_system: bool,
    pub can_manage_users: bool,
    pub can_manage_connections: bool,
    pub can_view_audit_logs: bool,
    pub can_create_users: bool,
    pub can_create_user_groups: bool,
    pub can_create_connections: bool,
    pub can_create_connection_folders: bool,
    pub can_create_sharing_profiles: bool,
    pub can_view_sessions: bool,
}

impl AuthUser {
    /// Returns `true` if the user holds at least one admin-level permission.
    pub fn has_any_admin_permission(&self) -> bool {
        self.can_manage_system
            || self.can_manage_users
            || self.can_manage_connections
            || self.can_view_audit_logs
            || self.can_create_users
            || self.can_create_user_groups
            || self.can_create_connections
            || self.can_create_connection_folders
            || self.can_create_sharing_profiles
            || self.can_view_sessions
    }

    /// Returns `true` if the user can manage connections via any relevant permission.
    pub fn can_access_all_connections(&self) -> bool {
        self.can_manage_system || self.can_manage_connections
    }
}

// ── Per-endpoint permission checks ──────────────────────────────────
// These are called at the start of admin handlers to enforce granular RBAC.
// `can_manage_system` always implies access (super-admin).

pub fn check_system_permission(user: &AuthUser) -> Result<(), crate::error::AppError> {
    if !user.can_manage_system {
        return Err(crate::error::AppError::Forbidden);
    }
    Ok(())
}

pub fn check_user_management_permission(user: &AuthUser) -> Result<(), crate::error::AppError> {
    if !user.can_manage_users && !user.can_manage_system {
        return Err(crate::error::AppError::Forbidden);
    }
    Ok(())
}

pub fn check_connection_management_permission(
    user: &AuthUser,
) -> Result<(), crate::error::AppError> {
    if !user.can_manage_connections && !user.can_manage_system {
        return Err(crate::error::AppError::Forbidden);
    }
    Ok(())
}

pub fn check_audit_permission(user: &AuthUser) -> Result<(), crate::error::AppError> {
    if !user.can_view_audit_logs && !user.can_manage_system {
        return Err(crate::error::AppError::Forbidden);
    }
    Ok(())
}

pub fn check_session_permission(user: &AuthUser) -> Result<(), crate::error::AppError> {
    if !user.can_view_sessions && !user.can_manage_system {
        return Err(crate::error::AppError::Forbidden);
    }
    Ok(())
}

/// Extract a `token=` value from a query string, handling the `?undefined`
/// suffix that Guacamole sometimes appends.
pub fn extract_token_from_query(query: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        if let Some(t) = pair.strip_prefix("token=") {
            let t = t.to_string();
            if let Some(pos) = t.find('?') {
                Some(t[..pos].to_string())
            } else {
                Some(t)
            }
        } else {
            None
        }
    })
}

/// Axum middleware that validates the Bearer token (local JWT or OIDC),
/// looks up the user in the database, and injects `AuthUser` as a request extension.
pub async fn require_auth(
    State(state): State<SharedState>,
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let db = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Err(AppError::SetupRequired);
        }
        s.db.clone().ok_or(AppError::SetupRequired)?
    };

    // Extract Bearer token from Authorization header, or from ?token= query param (WebSocket upgrade only)
    let is_ws_upgrade = req
        .headers()
        .get(http::header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);

    if is_ws_upgrade {
        tracing::debug!("Detected WebSocket upgrade request");
    }

    let token = req
        .headers()
        .get(http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string())
        .or_else(|| {
            // Only allow ?token= for WebSocket upgrade requests
            if !is_ws_upgrade {
                tracing::debug!("Not a WS upgrade, skipping query token check");
                return None;
            }
            let query = req.uri().query().unwrap_or_default();
            tracing::debug!("Searching for token in query: {}", query);
            extract_token_from_query(query)
        })
        .ok_or_else(|| {
            tracing::warn!(
                "Auth failed: Missing token. Path: {}, WS: {}",
                req.uri().path(),
                is_ws_upgrade
            );
            AppError::Auth("Missing or invalid Authorization header".into())
        })?;

    // Check if the token has been revoked (logout) — do this before
    // expensive DB lookups to short-circuit revoked tokens early.
    if crate::services::token_revocation::is_revoked(&token) {
        return Err(AppError::Auth("Token has been revoked".into()));
    }

    // Try local JWT first, then fall back to OIDC
    let auth_user = if let Some(user) = try_local_jwt(&token, &db).await? {
        user
    } else {
        // Fall back to OIDC validation
        validate_oidc_token(&token, &db).await?
    };

    req.extensions_mut().insert(auth_user);
    Ok(next.run(req).await)
}

/// Attempt to validate a local JWT (issued by POST /api/auth/login).
async fn try_local_jwt(
    token: &str,
    db: &crate::db::Database,
) -> Result<Option<AuthUser>, AppError> {
    use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
    use serde::Deserialize;

    #[derive(Deserialize, Clone)]
    struct LocalClaims {
        sub: String,
        #[allow(dead_code)]
        username: String,
        #[allow(dead_code)]
        role: String,
        iss: String,
        /// Token type: "access" or "refresh". Only access tokens are accepted
        /// for API authentication. Defaults to "access" for backward
        /// compatibility with tokens issued before the refresh-token feature.
        #[serde(default = "default_token_type")]
        token_type: String,
    }

    fn default_token_type() -> String {
        "access".to_string()
    }

    let secret = match crate::config::JWT_SECRET.get() {
        Some(s) => s.clone(),
        None => return Ok(None),
    };

    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&["strata-local"]);
    validation.set_required_spec_claims(&["sub", "exp", "iat", "iss"]);

    let token_data = match decode::<LocalClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    ) {
        Ok(data) => data,
        Err(_) => return Ok(None), // Not a local JWT – let OIDC handle it
    };

    let claims = token_data.claims;
    if claims.iss != "strata-local" {
        return Ok(None);
    }

    // Reject refresh tokens used as access tokens
    if claims.token_type == "refresh" {
        return Err(AppError::Auth(
            "Refresh tokens cannot be used for API access".into(),
        ));
    }

    // Verify user still exists in DB
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Auth("Invalid token subject".into()))?;

    let row: Option<UserPermissionsRow> = sqlx::query_as(
        "SELECT u.id, u.username, u.full_name, r.name,
                r.can_manage_system, r.can_manage_users, r.can_manage_connections, r.can_view_audit_logs,
                r.can_create_users, r.can_create_user_groups, r.can_create_connections,
                r.can_create_connection_folders, r.can_create_sharing_profiles, r.can_view_sessions
         FROM users u JOIN roles r ON u.role_id = r.id
         WHERE u.id = $1 AND u.deleted_at IS NULL",
    )
    .bind(user_id)
    .fetch_optional(&db.pool)
    .await
    .map_err(AppError::Database)?;

    let user =
        row.ok_or_else(|| AppError::Auth("User no longer exists or has been deleted".into()))?;

    Ok(Some(AuthUser {
        id: user.id,
        sub: claims.sub,
        username: user.username,
        full_name: user.full_name,
        role: user.role,
        can_manage_system: user.can_manage_system,
        can_manage_users: user.can_manage_users,
        can_manage_connections: user.can_manage_connections,
        can_view_audit_logs: user.can_view_audit_logs,
        can_create_users: user.can_create_users,
        can_create_user_groups: user.can_create_user_groups,
        can_create_connections: user.can_create_connections,
        can_create_connection_folders: user.can_create_connection_folders,
        can_create_sharing_profiles: user.can_create_sharing_profiles,
        can_view_sessions: user.can_view_sessions,
    }))
}

/// Validate an OIDC bearer token. Returns an error if SSO is not configured.
async fn validate_oidc_token(token: &str, db: &crate::db::Database) -> Result<AuthUser, AppError> {
    let issuer_url = settings::get(&db.pool, "sso_issuer_url")
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .unwrap_or_default();
    let client_id = settings::get(&db.pool, "sso_client_id")
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .unwrap_or_default();

    if issuer_url.is_empty() || client_id.is_empty() {
        return Err(AppError::Auth("Invalid or expired token".into()));
    }

    let claims = auth::validate_token(&issuer_url, &client_id, token).await?;

    let row: Option<UserPermissionsRow> = sqlx::query_as(
        "SELECT u.id, u.username, u.full_name, r.name,
                r.can_manage_system, r.can_manage_users, r.can_manage_connections, r.can_view_audit_logs,
                r.can_create_users, r.can_create_user_groups, r.can_create_connections,
                r.can_create_connection_folders, r.can_create_sharing_profiles, r.can_view_sessions
         FROM users u JOIN roles r ON u.role_id = r.id
         WHERE u.sub = $1 AND u.deleted_at IS NULL",
    )
    .bind(&claims.sub)
    .fetch_optional(&db.pool)
    .await
    .map_err(AppError::Database)?;

    let user = row.ok_or_else(|| {
        AppError::Auth(format!(
            "No active user found for OIDC subject: {}",
            claims.sub
        ))
    })?;

    Ok(AuthUser {
        id: user.id,
        sub: claims.sub,
        username: user.username,
        full_name: user.full_name,
        role: user.role,
        can_manage_system: user.can_manage_system,
        can_manage_users: user.can_manage_users,
        can_manage_connections: user.can_manage_connections,
        can_view_audit_logs: user.can_view_audit_logs,
        can_create_users: user.can_create_users,
        can_create_user_groups: user.can_create_user_groups,
        can_create_connections: user.can_create_connections,
        can_create_connection_folders: user.can_create_connection_folders,
        can_create_sharing_profiles: user.can_create_sharing_profiles,
        can_view_sessions: user.can_view_sessions,
    })
}

/// Middleware that additionally requires the authenticated user to have the
/// "admin" role. Must be layered after `require_auth`.
pub async fn require_admin(req: Request, next: Next) -> Result<Response, AppError> {
    let user = req
        .extensions()
        .get::<AuthUser>()
        .cloned()
        .ok_or(AppError::Auth("Not authenticated".into()))?;

    if !user.has_any_admin_permission() {
        return Err(AppError::Forbidden);
    }

    Ok(next.run(req).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_user_clone() {
        let user = AuthUser {
            id: Uuid::new_v4(),
            sub: "sub-123".into(),
            username: "alice".into(),
            full_name: Some("Alice Smith".into()),
            role: "admin".into(),
            can_manage_system: false,
            can_manage_users: false,
            can_manage_connections: false,
            can_view_audit_logs: false,
            can_create_users: false,
            can_create_user_groups: false,
            can_create_connections: false,
            can_create_connection_folders: false,
            can_create_sharing_profiles: false,
            can_view_sessions: false,
        };
        let cloned = user.clone();
        assert_eq!(user.id, cloned.id);
        assert_eq!(user.username, cloned.username);
        assert_eq!(user.role, cloned.role);
        assert_eq!(user.sub, cloned.sub);
    }

    #[test]
    fn auth_user_debug() {
        let user = AuthUser {
            id: Uuid::nil(),
            sub: "sub".into(),
            username: "bob".into(),
            full_name: None,
            role: "user".into(),
            can_manage_system: false,
            can_manage_users: false,
            can_manage_connections: false,
            can_view_audit_logs: false,
            can_create_users: false,
            can_create_user_groups: false,
            can_create_connections: false,
            can_create_connection_folders: false,
            can_create_sharing_profiles: false,
            can_view_sessions: false,
        };
        let debug = format!("{:?}", user);
        assert!(debug.contains("bob"));
        assert!(debug.contains("user"));
    }

    #[test]
    fn auth_user_fields_accessible() {
        let id = Uuid::new_v4();
        let user = AuthUser {
            id,
            sub: "oidc|12345".into(),
            username: "charlie".into(),
            full_name: Some("Charlie Brown".into()),
            role: "admin".into(),
            can_manage_system: false,
            can_manage_users: false,
            can_manage_connections: false,
            can_view_audit_logs: false,
            can_create_users: false,
            can_create_user_groups: false,
            can_create_connections: false,
            can_create_connection_folders: false,
            can_create_sharing_profiles: false,
            can_view_sessions: false,
        };
        assert_eq!(user.id, id);
        assert_eq!(user.sub, "oidc|12345");
        assert_eq!(user.username, "charlie");
        assert_eq!(user.role, "admin");
    }

    #[test]
    fn auth_user_clone_independence() {
        let user = AuthUser {
            id: Uuid::new_v4(),
            sub: "sub-abc".into(),
            username: "dave".into(),
            full_name: None,
            role: "viewer".into(),
            can_manage_system: false,
            can_manage_users: false,
            can_manage_connections: false,
            can_view_audit_logs: false,
            can_create_users: false,
            can_create_user_groups: false,
            can_create_connections: false,
            can_create_connection_folders: false,
            can_create_sharing_profiles: false,
            can_view_sessions: false,
        };
        let mut cloned = user.clone();
        cloned.username = "eve".into();
        // Original unaffected
        assert_eq!(user.username, "dave");
        assert_eq!(cloned.username, "eve");
    }

    // ── AuthUser permission combinations ───────────────────────────

    fn make_user_with_perm(field: &str) -> AuthUser {
        let mut user = AuthUser {
            id: Uuid::new_v4(),
            sub: "sub".into(),
            username: "test".into(),
            full_name: None,
            role: "custom".into(),
            can_manage_system: false,
            can_manage_users: false,
            can_manage_connections: false,
            can_view_audit_logs: false,
            can_create_users: false,
            can_create_user_groups: false,
            can_create_connections: false,
            can_create_connection_folders: false,
            can_create_sharing_profiles: false,
            can_view_sessions: false,
        };
        match field {
            "can_manage_system" => user.can_manage_system = true,
            "can_manage_users" => user.can_manage_users = true,
            "can_manage_connections" => user.can_manage_connections = true,
            "can_view_audit_logs" => user.can_view_audit_logs = true,
            "can_create_users" => user.can_create_users = true,
            "can_create_user_groups" => user.can_create_user_groups = true,
            "can_create_connections" => user.can_create_connections = true,
            "can_create_connection_folders" => user.can_create_connection_folders = true,
            "can_create_sharing_profiles" => user.can_create_sharing_profiles = true,
            "can_view_sessions" => user.can_view_sessions = true,
            _ => {}
        }
        user
    }

    /// Checks that any single permission satisfies the admin check logic.
    #[test]
    fn has_any_admin_perm_per_field() {
        let perms = [
            "can_manage_system",
            "can_manage_users",
            "can_manage_connections",
            "can_view_audit_logs",
            "can_create_users",
            "can_create_user_groups",
            "can_create_connections",
            "can_create_connection_folders",
            "can_create_sharing_profiles",
        ];
        for field in perms {
            let user = make_user_with_perm(field);
            assert!(
                user.has_any_admin_permission(),
                "Expected '{}' to grant admin perm",
                field
            );
        }
    }

    /// User with zero permissions has no admin access.
    #[test]
    fn no_permissions_means_no_admin() {
        let user = make_user_with_perm("none");
        assert!(!user.has_any_admin_permission());
    }

    #[test]
    fn auth_user_full_name_none() {
        let user = AuthUser {
            id: Uuid::nil(),
            sub: "sub".into(),
            username: "anon".into(),
            full_name: None,
            role: "user".into(),
            can_manage_system: false,
            can_manage_users: false,
            can_manage_connections: false,
            can_view_audit_logs: false,
            can_create_users: false,
            can_create_user_groups: false,
            can_create_connections: false,
            can_create_connection_folders: false,
            can_create_sharing_profiles: false,
            can_view_sessions: false,
        };
        assert!(user.full_name.is_none());
    }

    #[test]
    fn auth_user_all_permissions_true() {
        let user = AuthUser {
            id: Uuid::new_v4(),
            sub: "admin-sub".into(),
            username: "superadmin".into(),
            full_name: Some("Super Admin".into()),
            role: "admin".into(),
            can_manage_system: true,
            can_manage_users: true,
            can_manage_connections: true,
            can_view_audit_logs: true,
            can_create_users: true,
            can_create_user_groups: true,
            can_create_connections: true,
            can_create_connection_folders: true,
            can_create_sharing_profiles: true,
            can_view_sessions: true,
        };
        assert!(user.has_any_admin_permission());
        assert_eq!(user.role, "admin");
    }

    // ── extract_token_from_query tests ───────────────────────────

    #[test]
    fn extract_token_simple() {
        assert_eq!(
            extract_token_from_query("token=abc123"),
            Some("abc123".into())
        );
    }

    #[test]
    fn extract_token_with_undefined_suffix() {
        assert_eq!(
            extract_token_from_query("token=abc123?undefined"),
            Some("abc123".into())
        );
    }

    #[test]
    fn extract_token_with_other_suffix() {
        assert_eq!(
            extract_token_from_query("token=abc123?extra"),
            Some("abc123".into())
        );
    }

    #[test]
    fn extract_token_among_other_params() {
        assert_eq!(
            extract_token_from_query("foo=bar&token=mytoken&baz=qux"),
            Some("mytoken".into())
        );
    }

    #[test]
    fn extract_token_first_param() {
        assert_eq!(
            extract_token_from_query("token=first&other=second"),
            Some("first".into())
        );
    }

    #[test]
    fn extract_token_last_param() {
        assert_eq!(
            extract_token_from_query("other=second&token=last"),
            Some("last".into())
        );
    }

    #[test]
    fn extract_token_missing() {
        assert_eq!(extract_token_from_query("foo=bar&baz=qux"), None);
    }

    #[test]
    fn extract_token_empty_query() {
        assert_eq!(extract_token_from_query(""), None);
    }

    #[test]
    fn extract_token_empty_value() {
        assert_eq!(extract_token_from_query("token="), Some("".into()));
    }

    #[test]
    fn extract_token_no_prefix_match() {
        // "tokenx=abc" should not match
        assert_eq!(extract_token_from_query("tokenx=abc"), None);
    }

    // ── permission checker tests ──────────────────────────────────

    fn user_with(system: bool, users: bool, conns: bool, audit: bool, sessions: bool) -> AuthUser {
        AuthUser {
            id: Uuid::nil(),
            sub: "s".into(),
            username: "u".into(),
            full_name: None,
            role: "user".into(),
            can_manage_system: system,
            can_manage_users: users,
            can_manage_connections: conns,
            can_view_audit_logs: audit,
            can_create_users: false,
            can_create_user_groups: false,
            can_create_connections: false,
            can_create_connection_folders: false,
            can_create_sharing_profiles: false,
            can_view_sessions: sessions,
        }
    }

    #[test]
    fn check_system_permission_requires_system_flag() {
        assert!(check_system_permission(&user_with(true, false, false, false, false)).is_ok());
        assert!(check_system_permission(&user_with(false, true, true, true, true)).is_err());
    }

    #[test]
    fn check_user_management_permission_accepts_users_or_system() {
        assert!(
            check_user_management_permission(&user_with(false, true, false, false, false)).is_ok()
        );
        assert!(
            check_user_management_permission(&user_with(true, false, false, false, false)).is_ok()
        );
        assert!(
            check_user_management_permission(&user_with(false, false, true, true, true)).is_err()
        );
    }

    #[test]
    fn check_connection_management_permission_accepts_conns_or_system() {
        assert!(check_connection_management_permission(&user_with(
            false, false, true, false, false
        ))
        .is_ok());
        assert!(check_connection_management_permission(&user_with(
            true, false, false, false, false
        ))
        .is_ok());
        assert!(
            check_connection_management_permission(&user_with(false, true, false, true, true))
                .is_err()
        );
    }

    #[test]
    fn check_audit_permission_accepts_audit_or_system() {
        assert!(check_audit_permission(&user_with(false, false, false, true, false)).is_ok());
        assert!(check_audit_permission(&user_with(true, false, false, false, false)).is_ok());
        assert!(check_audit_permission(&user_with(false, true, true, false, true)).is_err());
    }

    #[test]
    fn check_session_permission_accepts_sessions_or_system() {
        assert!(check_session_permission(&user_with(false, false, false, false, true)).is_ok());
        assert!(check_session_permission(&user_with(true, false, false, false, false)).is_ok());
        assert!(check_session_permission(&user_with(false, true, true, true, false)).is_err());
    }
}
