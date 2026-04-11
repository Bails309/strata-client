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

/// Extract the HTTP status code and user-facing message for an error variant.
/// Internal details are never exposed to the client.
pub fn error_status_and_message(err: &AppError) -> (StatusCode, String) {
    match err {
        AppError::Database(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error".into(),
        ),
        AppError::Config(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error".into(),
        ),
        AppError::Vault(_) => (StatusCode::BAD_GATEWAY, "Service dependency error".into()),
        AppError::Reqwest(_) => (StatusCode::BAD_GATEWAY, "Service connectivity error".into()),
        AppError::Auth(msg) => (StatusCode::UNAUTHORIZED, msg.clone()),
        AppError::Validation(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
        AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
        AppError::Forbidden => (StatusCode::FORBIDDEN, "Forbidden".into()),
        AppError::SetupRequired => (StatusCode::SERVICE_UNAVAILABLE, "Setup required".into()),
        AppError::Internal(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error".into(),
        ),
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            AppError::Database(e) => {
                tracing::error!("Database error: {e}");
                error_status_and_message(&self)
            }
            AppError::Config(msg) => {
                tracing::error!("Config error: {msg}");
                error_status_and_message(&self)
            }
            AppError::Vault(msg) => {
                tracing::error!("Vault error: {msg}");
                error_status_and_message(&self)
            }
            AppError::Reqwest(e) => {
                tracing::error!("Network error: {e}");
                error_status_and_message(&self)
            }
            AppError::Internal(msg) => {
                tracing::error!("Internal error: {msg}");
                error_status_and_message(&self)
            }
            _ => error_status_and_message(&self),
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

    #[test]
    fn error_display_messages() {
        assert_eq!(
            format!("{}", AppError::Config("bad config".into())),
            "Configuration error: bad config"
        );
        assert_eq!(
            format!("{}", AppError::Vault("vault down".into())),
            "Vault error: vault down"
        );
        assert_eq!(
            format!("{}", AppError::Auth("no token".into())),
            "Authentication error: no token"
        );
        assert_eq!(
            format!("{}", AppError::Validation("missing field".into())),
            "Validation error: missing field"
        );
        assert_eq!(
            format!("{}", AppError::NotFound("item".into())),
            "Not found: item"
        );
        assert_eq!(format!("{}", AppError::Forbidden), "Forbidden");
        assert_eq!(format!("{}", AppError::SetupRequired), "Setup required");
        assert_eq!(format!("{}", AppError::Internal("oops".into())), "oops");
    }

    #[test]
    fn error_debug_format() {
        let err = AppError::Auth("test".into());
        let debug = format!("{:?}", err);
        assert!(debug.contains("Auth"));
        assert!(debug.contains("test"));
    }

    #[test]
    fn reqwest_error_returns_502() {
        // Build a reqwest error by parsing an invalid URL
        let err = reqwest::Client::new().get("not-a-url").build();
        if let Err(e) = err {
            let app_err: AppError = e.into();
            let (status, _) = error_response(app_err);
            assert_eq!(status, StatusCode::BAD_GATEWAY);
        }
    }

    // ── error_status_and_message (pure, verifies body text) ────────────

    #[test]
    fn database_error_hides_internal_details() {
        let err = AppError::Database(sqlx::Error::RowNotFound);
        let (status, msg) = error_status_and_message(&err);
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(msg, "Internal server error");
        assert!(!msg.contains("RowNotFound"));
    }

    #[test]
    fn config_error_hides_internal_details() {
        let err = AppError::Config("secret db url".into());
        let (_, msg) = error_status_and_message(&err);
        assert_eq!(msg, "Internal server error");
        assert!(!msg.contains("secret"));
    }

    #[test]
    fn vault_error_body_is_generic() {
        let err = AppError::Vault("vault token xyz".into());
        let (status, msg) = error_status_and_message(&err);
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(msg, "Service dependency error");
        assert!(!msg.contains("xyz"));
    }

    #[test]
    fn reqwest_error_body_is_generic() {
        let err = reqwest::Client::new().get("not-a-url").build();
        if let Err(e) = err {
            let app_err: AppError = e.into();
            let (_, msg) = error_status_and_message(&app_err);
            assert_eq!(msg, "Service connectivity error");
        }
    }

    #[test]
    fn auth_error_passes_through_message() {
        let err = AppError::Auth("Invalid credentials".into());
        let (status, msg) = error_status_and_message(&err);
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(msg, "Invalid credentials");
    }

    #[test]
    fn validation_error_passes_through_message() {
        let err = AppError::Validation("name is required".into());
        let (status, msg) = error_status_and_message(&err);
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(msg, "name is required");
    }

    #[test]
    fn not_found_error_passes_through_message() {
        let err = AppError::NotFound("connection 123".into());
        let (status, msg) = error_status_and_message(&err);
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(msg, "connection 123");
    }

    #[test]
    fn forbidden_body_text() {
        let (status, msg) = error_status_and_message(&AppError::Forbidden);
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(msg, "Forbidden");
    }

    #[test]
    fn setup_required_body_text() {
        let (status, msg) = error_status_and_message(&AppError::SetupRequired);
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(msg, "Setup required");
    }

    #[test]
    fn internal_error_hides_details() {
        let err = AppError::Internal("sensitive stack trace".into());
        let (status, msg) = error_status_and_message(&err);
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(msg, "Internal server error");
        assert!(!msg.contains("sensitive"));
    }
}
