use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Vault error: {0}")]
    Vault(String),

    #[error("Authentication error: {0}")]
    Auth(String),

    #[error("Validation error: {0}")]
    Validation(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Forbidden")]
    Forbidden,

    #[error("Setup required")]
    SetupRequired,

    #[error("{0}")]
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            AppError::Database(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            AppError::Config(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg.clone()),
            AppError::Vault(msg) => (StatusCode::BAD_GATEWAY, msg.clone()),
            AppError::Auth(msg) => (StatusCode::UNAUTHORIZED, msg.clone()),
            AppError::Validation(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "Forbidden".into()),
            AppError::SetupRequired => (StatusCode::SERVICE_UNAVAILABLE, "Setup required".into()),
            AppError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg.clone()),
        };

        let body = json!({ "error": message });
        (status, axum::Json(body)).into_response()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}
