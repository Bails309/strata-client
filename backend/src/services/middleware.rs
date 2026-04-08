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
    pub role: String,
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

    let token = req
        .headers()
        .get(http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string())
        .or_else(|| {
            // Only allow ?token= for WebSocket upgrade requests
            if !is_ws_upgrade {
                return None;
            }
            req.uri().query().and_then(|q| {
                q.split('&')
                    .find_map(|pair| pair.strip_prefix("token="))
                    .map(|t| t.to_string())
            })
        })
        .ok_or_else(|| AppError::Auth("Missing or invalid Authorization header".into()))?;

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

    // Verify user still exists in DB
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Auth("Invalid token subject".into()))?;

    let row: Option<(Uuid, String, String)> = sqlx::query_as(
        "SELECT u.id, u.username, r.name
         FROM users u JOIN roles r ON u.role_id = r.id
         WHERE u.id = $1",
    )
    .bind(user_id)
    .fetch_optional(&db.pool)
    .await
    .map_err(AppError::Database)?;

    let (id, username, role) = row.ok_or_else(|| AppError::Auth("User no longer exists".into()))?;

    Ok(Some(AuthUser {
        id,
        sub: claims.sub,
        username,
        role,
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

    let user: Option<(Uuid, String, String)> = sqlx::query_as(
        "SELECT u.id, u.username, r.name
         FROM users u JOIN roles r ON u.role_id = r.id
         WHERE u.sub = $1",
    )
    .bind(&claims.sub)
    .fetch_optional(&db.pool)
    .await
    .map_err(AppError::Database)?;

    let (user_id, username, role) = user
        .ok_or_else(|| AppError::Auth(format!("No user found for OIDC subject: {}", claims.sub)))?;

    Ok(AuthUser {
        id: user_id,
        sub: claims.sub,
        username,
        role,
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

    if user.role != "admin" {
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
            role: "admin".into(),
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
            role: "user".into(),
        };
        let debug = format!("{:?}", user);
        assert!(debug.contains("bob"));
        assert!(debug.contains("user"));
    }
}
