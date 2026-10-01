//! Bridge from the link's [`RequestHandler`] interface to an
//! `axum::Router`.
//!
//! Request and response bodies pass through as streams; the router's
//! own per-route body limits apply exactly as on a direct connection.
//!
//! The router itself is shared across every adopted stream; cloning it
//! is cheap (an `Arc` in axum 0.8).

use std::sync::Arc;

use async_trait::async_trait;
use axum::body::Body;
use axum::Router;
use http::{Request, Response};
use tower::ServiceExt;

use super::h2_serve::RequestHandler;

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
    async fn handle(&self, req: Request<Body>) -> Response<Body> {
        // Headers, URI, method and extensions pass through verbatim so
        // the edge-header verifier inside the router sees exactly what
        // the DMZ sent. Each stream gets its own clone of the router so
        // tower's per-Service state stays independent.
        let router: Router = (*self.router).clone();
        match router.oneshot(req).await {
            Ok(r) => r,
            // `<Router as Service>::Error == Infallible`.
            Err(never) => match never {},
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::DefaultBodyLimit;
    use axum::routing::{get, post};
    use axum::Json;
    use http::StatusCode;
    use http_body_util::BodyExt;

    const BIG: usize = 9 * 1024 * 1024;

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
            .route("/api/big", get(|| async { vec![b'x'; BIG] }))
            .route(
                "/api/small-upload",
                post(|body: axum::body::Bytes| async move { body.len().to_string() })
                    .layer(DefaultBodyLimit::max(1024)),
            )
            .fallback(|| async { (StatusCode::NOT_FOUND, "not found") })
    }

    async fn body_of(resp: Response<Body>) -> Vec<u8> {
        resp.into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dispatches_get_to_router() {
        let h = RouterHandler::new(test_router());
        let req = Request::builder()
            .method("GET")
            .uri("https://internal/api/health")
            .body(Body::empty())
            .unwrap();
        let resp = h.handle(req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_of(resp).await, b"ok");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dispatches_post_with_body() {
        let h = RouterHandler::new(test_router());
        let req = Request::builder()
            .method("POST")
            .uri("https://internal/api/echo")
            .body(Body::from("hello"))
            .unwrap();
        let resp = h.handle(req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_of(resp).await, b"echo:hello");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn returns_json_body() {
        let h = RouterHandler::new(test_router());
        let req = Request::builder()
            .method("GET")
            .uri("https://internal/api/json")
            .body(Body::empty())
            .unwrap();
        let resp = h.handle(req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = String::from_utf8(body_of(resp).await).unwrap();
        assert!(body.contains("\"hello\""));
        assert!(body.contains("\"world\""));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn unknown_route_yields_router_404_not_link_error() {
        let h = RouterHandler::new(test_router());
        let req = Request::builder()
            .method("GET")
            .uri("https://internal/api/nope")
            .body(Body::empty())
            .unwrap();
        let resp = h.handle(req).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert!(resp.headers().get("x-strata-link").is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn responses_are_not_capped_by_the_link() {
        let h = RouterHandler::new(test_router());
        let req = Request::builder()
            .method("GET")
            .uri("https://internal/api/big")
            .body(Body::empty())
            .unwrap();
        let resp = h.handle(req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_of(resp).await.len(), BIG);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn route_body_limits_still_apply() {
        let h = RouterHandler::new(test_router());
        let req = Request::builder()
            .method("POST")
            .uri("https://internal/api/small-upload")
            .body(Body::from(vec![0u8; 2048]))
            .unwrap();
        assert_eq!(h.handle(req).await.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }
}
