//! Per-process request-id propagation (W3-11).
//!
//! `tower-http`'s `SetRequestIdLayer` stamps each incoming request with an
//! opaque UUID in the `x-request-id` header. That header is visible to our
//! route handlers, but by the time a handler calls out to Vault / LDAP /
//! Azure it usually does so through the shared [`crate::services::http_client`],
//! which has no easy way to reach into the request extensions.
//!
//! To bridge that gap we stash the current request id in a `tokio`
//! task-local and expose tiny helpers:
//!
//! * [`set_request_id`] — called by the axum middleware [`inject_request_id`]
//!   once per inbound request.
//! * [`current_request_id`] — readable by any async code running inside the
//!   request's tokio task, including deeply-nested spawned tasks that
//!   clone the task-local via `TaskLocal::scope`.
//! * [`reqwest::RequestBuilder` extension] — `RequestIdExt::with_request_id`
//!   appends the current id to an outbound request's `x-request-id` header.

use axum::{
    extract::Request,
    http::{HeaderName, HeaderValue},
    middleware::Next,
    response::Response,
};

pub const HEADER: HeaderName = HeaderName::from_static("x-request-id");

tokio::task_local! {
    static CURRENT: String;
}

/// Run `fut` inside a task-local scope that exposes `id` as the current
/// request id.
pub async fn with_request_id<F>(id: String, fut: F) -> F::Output
where
    F: std::future::Future,
{
    CURRENT.scope(id, fut).await
}

/// Current request id, or `"-"` if no scope is active.
pub fn current_request_id() -> String {
    CURRENT
        .try_with(|s| s.clone())
        .unwrap_or_else(|_| "-".into())
}

/// Axum middleware: read (or mint) `x-request-id`, stash into task-local,
/// and stamp the same id onto the response headers.
pub async fn inject_request_id(mut req: Request, next: Next) -> Response {
    let id = req
        .headers()
        .get(&HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_graphic()))
        .map(|s| s.to_string())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Make sure the id is visible both to downstream handlers (via
    // header) and to the task-local scope.
    if let Ok(hv) = HeaderValue::from_str(&id) {
        req.headers_mut().insert(&HEADER, hv);
    }

    let id_for_response = id.clone();
    let mut resp = with_request_id(id, next.run(req)).await;
    if let Ok(hv) = HeaderValue::from_str(&id_for_response) {
        resp.headers_mut().insert(&HEADER, hv);
    }
    resp
}

/// Extension trait: append the current request id to an outbound request.
pub trait RequestIdExt {
    fn with_request_id(self) -> Self;
}

impl RequestIdExt for reqwest::RequestBuilder {
    fn with_request_id(self) -> Self {
        self.header(HEADER.as_str(), current_request_id())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn default_id_outside_scope() {
        assert_eq!(current_request_id(), "-");
    }

    #[tokio::test]
    async fn scoped_id_is_visible() {
        with_request_id("abc-123".into(), async {
            assert_eq!(current_request_id(), "abc-123");
        })
        .await;
    }
}
