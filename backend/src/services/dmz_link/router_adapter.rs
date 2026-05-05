//! Bridge from the link's [`RequestHandler`] interface to an
//! `axum::Router`.
//!
//! The link multiplexer ([`super::h2_serve`]) buffers each inbound
//! request body into [`Bytes`] and hands it to a [`RequestHandler`]
//! that returns a fully-buffered response. To run the existing
//! axum router on those requests we have to:
//!
//! 1. Reconstitute an `axum::extract::Request` (i.e. `Request<Body>`)
//!    from the buffered `Request<Bytes>`.
//! 2. Drive the router's `tower::Service::call` to completion.
//! 3. Collect the streaming response body back into `Bytes`, capped at
//!    [`MAX_RESPONSE_BODY_BYTES`] so a runaway endpoint can't exhaust
//!    the link multiplexer's memory.
//!
//! The router itself is shared across every adopted stream; cloning it
//! is cheap (an `Arc` in axum 0.8).

use std::sync::Arc;

use async_trait::async_trait;
use axum::body::Body;
use axum::Router;
use bytes::Bytes;
use http::{Request, Response, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

use super::h2_serve::RequestHandler;

/// Cap on response bodies the link will forward back to the DMZ.
/// Matches the inbound cap to keep round-trip memory bounded; any
/// endpoint that needs to ship more than this through the link is
/// misconfigured (the link is for control-plane traffic; bulk data
/// flows over WebSocket-tunnelled guacd channels).
pub const MAX_RESPONSE_BODY_BYTES: usize = 8 * 1024 * 1024;

/// Adapter that runs an `axum::Router` on every inbound link request.
pub struct RouterHandler {
    router: Arc<Router>,
}

impl RouterHandler {
    /// Wrap the supplied router. The router is cloned per-call so any
    /// per-route state internal to axum stays consistent across
    /// concurrent streams.
    pub fn new(router: Router) -> Self {
        Self {
            router: Arc::new(router),
        }
    }
}

#[async_trait]
impl RequestHandler for RouterHandler {
    async fn handle(&self, req: Request<Bytes>) -> Response<Bytes> {
        // Reconstitute Request<Body>. Headers + URI + method + extensions
        // are preserved verbatim so the existing edge-header verifier
        // middleware (which lives inside the router) sees exactly what
        // the DMZ sent.
        let (parts, body_bytes) = req.into_parts();
        let req: Request<Body> = Request::from_parts(parts, Body::from(body_bytes));

        // Each adopted h2 stream gets its own clone of the router so
        // tower's per-Service state (e.g. ready-state) is independent.
        let router: Router = (*self.router).clone();

        let response: Response<Body> = match router.oneshot(req).await {
            Ok(r) => r,
            // `<Router as Service>::Error == Infallible`, so this arm
            // is statically unreachable. Pattern-match on the empty
            // type to prove totality without a runtime panic.
            Err(never) => match never {},
        };

        let (parts, body) = response.into_parts();
        let collected = match collect_capped(body, MAX_RESPONSE_BODY_BYTES).await {
            Ok(b) => b,
            Err(CollectError::TooLarge) => {
                return error_response(
                    StatusCode::INSUFFICIENT_STORAGE,
                    b"response exceeds link multiplexer body limit",
                );
            }
            Err(CollectError::Body(e)) => {
                let msg = format!("collect router response body: {e}");
                tracing::warn!(error = %msg, "DMZ link router response stream errored");
                return error_response(StatusCode::BAD_GATEWAY, msg.as_bytes());
            }
        };

        Response::from_parts(parts, collected)
    }
}

enum CollectError {
    TooLarge,
    Body(Box<dyn std::error::Error + Send + Sync>),
}

async fn collect_capped(body: Body, max: usize) -> Result<Bytes, CollectError> {
    let mut body = body;
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let frame = match body.frame().await {
            None => break,
            Some(Ok(f)) => f,
            Some(Err(e)) => return Err(CollectError::Body(Box::new(e))),
        };
        if let Ok(chunk) = frame.into_data() {
            if buf.len().saturating_add(chunk.len()) > max {
                return Err(CollectError::TooLarge);
            }
            buf.extend_from_slice(&chunk);
        }
        // Trailers from axum responses are never forwarded over the
        // link — the public clients on the other side of the DMZ talk
        // HTTP/1.1 and don't expect them.
    }
    Ok(Bytes::from(buf))
}

fn error_response(status: StatusCode, body: &[u8]) -> Response<Bytes> {
    Response::builder()
        .status(status)
        .header("x-strata-link", "router-error")
        .body(Bytes::copy_from_slice(body))
        .expect("static error response")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::{get, post};
    use axum::Json;

    fn test_router() -> Router {
        Router::new()
            .route("/api/health", get(|| async { "ok" }))
            .route(
                "/api/echo",
                post(|body: String| async move { format!("echo:{body}") }),
            )
            .route(
                "/api/json",
                get(|| async { Json(serde_json::json!({"hello": "world"})) }),
            )
            .route(
                "/api/big",
                get(|| async {
                    // Exactly one byte over the cap.
                    let v = vec![b'x'; MAX_RESPONSE_BODY_BYTES + 1];
                    String::from_utf8(v).unwrap()
                }),
            )
            .fallback(|| async { (StatusCode::NOT_FOUND, "not found") })
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dispatches_get_to_router() {
        let h = RouterHandler::new(test_router());
        let req = Request::builder()
            .method("GET")
            .uri("https://internal/api/health")
            .body(Bytes::new())
            .unwrap();
        let resp = h.handle(req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.body().as_ref(), b"ok");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dispatches_post_with_body() {
        let h = RouterHandler::new(test_router());
        let req = Request::builder()
            .method("POST")
            .uri("https://internal/api/echo")
            .body(Bytes::from_static(b"hello"))
            .unwrap();
        let resp = h.handle(req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.body().as_ref(), b"echo:hello");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn returns_json_body() {
        let h = RouterHandler::new(test_router());
        let req = Request::builder()
            .method("GET")
            .uri("https://internal/api/json")
            .body(Bytes::new())
            .unwrap();
        let resp = h.handle(req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = std::str::from_utf8(resp.body()).unwrap();
        assert!(body.contains("\"hello\""));
        assert!(body.contains("\"world\""));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn unknown_route_yields_router_404_not_link_error() {
        let h = RouterHandler::new(test_router());
        let req = Request::builder()
            .method("GET")
            .uri("https://internal/api/nope")
            .body(Bytes::new())
            .unwrap();
        let resp = h.handle(req).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        // Must NOT be the link's own router-error envelope — the router
        // owns this response.
        assert!(resp.headers().get("x-strata-link").is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn oversized_response_is_capped_with_507() {
        let h = RouterHandler::new(test_router());
        let req = Request::builder()
            .method("GET")
            .uri("https://internal/api/big")
            .body(Bytes::new())
            .unwrap();
        let resp = h.handle(req).await;
        assert_eq!(resp.status(), StatusCode::INSUFFICIENT_STORAGE);
        assert_eq!(
            resp.headers()
                .get("x-strata-link")
                .map(|v| v.to_str().unwrap()),
            Some("router-error"),
        );
    }
}
