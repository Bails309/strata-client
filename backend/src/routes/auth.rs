use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::error::AppError;
use crate::services::app_state::SharedState;
use crate::services::audit;

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

/// POST /api/auth/login – authenticate with local username/password.
/// Returns a signed JWT for subsequent API calls.
pub async fn login(
    State(state): State<SharedState>,
    Json(body): Json<LoginRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = {
        let s = state.read().await;
        s.db.clone().ok_or(AppError::Internal("Database not available".into()))?
    };

    // Look up user by username
    let row: Option<(Uuid, String, String, Option<String>)> = sqlx::query_as(
        "SELECT u.id, u.username, r.name, u.password_hash
         FROM users u JOIN roles r ON u.role_id = r.id
         WHERE u.username = $1",
    )
    .bind(&body.username)
    .fetch_optional(&db.pool)
    .await
    .map_err(AppError::Database)?;

    let (user_id, username, role, password_hash) = row
        .ok_or_else(|| AppError::Auth("Invalid username or password".into()))?;

    let hash = password_hash
        .ok_or_else(|| AppError::Auth("This account does not support local login".into()))?;

    // Verify password with Argon2
    use argon2::{Argon2, PasswordHash, PasswordVerifier};
    let parsed_hash = PasswordHash::new(&hash)
        .map_err(|_| AppError::Auth("Invalid username or password".into()))?;
    Argon2::default()
        .verify_password(body.password.as_bytes(), &parsed_hash)
        .map_err(|_| AppError::Auth("Invalid username or password".into()))?;

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
    }

    let secret = std::env::var("JWT_SECRET").unwrap_or_else(|_| {
        // In production this should be set; for local dev use a deterministic default
        "strata-local-dev-secret-change-me".into()
    });

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
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(format!("JWT creation failed: {e}")))
}
