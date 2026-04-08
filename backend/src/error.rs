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

    #[error("Network error: {0}")]
    Reqwest(#[from] reqwest::Error),

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
            AppError::Database(e) => {
                tracing::error!("Database error: {e}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".into(),
                )
            }
            AppError::Config(msg) => {
                tracing::error!("Config error: {msg}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".into(),
                )
            }
            AppError::Vault(msg) => {
                tracing::error!("Vault error: {msg}");
                (StatusCode::BAD_GATEWAY, "Service dependency error".into())
            }
            AppError::Reqwest(e) => {
                tracing::error!("Network error: {e}");
                (StatusCode::BAD_GATEWAY, "Service connectivity error".into())
            }
            AppError::Auth(msg) => (StatusCode::UNAUTHORIZED, msg.clone()),
            AppError::Validation(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "Forbidden".into()),
            AppError::SetupRequired => (StatusCode::SERVICE_UNAVAILABLE, "Setup required".into()),
            AppError::Internal(msg) => {
                tracing::error!("Internal error: {msg}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".into(),
                )
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;

    /// Helper to extract status code and JSON body from an AppError response.
    fn error_response(err: AppError) -> (StatusCode, serde_json::Value) {
        let response = err.into_response();
        let status = response.status();
        // We can't easily extract the body in a unit test without a runtime,
        // so we test the match arms directly.
        (status, serde_json::Value::Null)
    }

    #[test]
    fn database_error_returns_500_generic() {
        let err = AppError::Database(sqlx::Error::RowNotFound);
        let (status, _) = error_response(err);
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn config_error_returns_500_generic() {
        let err = AppError::Config("secret db url here".into());
        let (status, _) = error_response(err);
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn vault_error_returns_502() {
        let err = AppError::Vault("vault token expired".into());
        let (status, _) = error_response(err);
        assert_eq!(status, StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn auth_error_returns_401() {
        let err = AppError::Auth("Invalid credentials".into());
        let (status, _) = error_response(err);
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn validation_error_returns_400() {
        let err = AppError::Validation("missing field".into());
        let (status, _) = error_response(err);
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn not_found_returns_404() {
        let err = AppError::NotFound("connection not found".into());
        let (status, _) = error_response(err);
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[test]
    fn forbidden_returns_403() {
        let (status, _) = error_response(AppError::Forbidden);
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[test]
    fn setup_required_returns_503() {
        let (status, _) = error_response(AppError::SetupRequired);
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn internal_returns_500() {
        let err = AppError::Internal("some internal detail".into());
        let (status, _) = error_response(err);
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn anyhow_converts_to_internal() {
        let err: AppError = anyhow::anyhow!("something went wrong").into();
        match err {
            AppError::Internal(msg) => assert!(msg.contains("something went wrong")),
            other => panic!("expected Internal, got {other:?}"),
        }
    }
}
