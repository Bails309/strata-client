//! DMZ operator status endpoint.
//!
//! Exposes a small JSON API on a **separate** listener from the public
//! one ([`DmzConfig::operator_bind`]). Authentication is a constant-
//! time bearer-token compare against [`DmzConfig::operator_token`]; we
//! deliberately do NOT reuse the public listener's TLS material or
//! abuse-mitigation stack — the operator surface is intended to be
//! reached over a private management network, not the internet.
//!
//! ## Endpoints
//!
//! * `GET  /status`               — overall summary.
//! * `GET  /links`                — JSON list of every authenticated
//!                                  link session.
//! * `POST /links/:link_id/disconnect` — evict a session, forcing the
//!                                  internal-side supervisor to reconnect.
//!
//! All responses are JSON. Errors carry `{ "error": "..." }`. The
//! authentication failure response is deliberately bland (`401`) and
//! identical for "missing token" and "wrong token" — no oracles.

use std::time::SystemTime;

use axum::extract::{Path, Request, State};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::Router;
use serde::Serialize;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::link_server::LinkSessionRegistry;

/// Shared state for the operator router.
#[derive(Clone)]
pub struct OperatorState {
    pub registry: LinkSessionRegistry,
    pub token: std::sync::Arc<Zeroizing<Vec<u8>>>,
    pub cluster_id: String,
    pub node_id: String,
    pub started_at: SystemTime,
}

impl OperatorState {
    pub fn new(
        registry: LinkSessionRegistry,
        token: Zeroizing<Vec<u8>>,
        cluster_id: String,
        node_id: String,
    ) -> Self {
        Self {
            registry,
            token: std::sync::Arc::new(token),
            cluster_id,
            node_id,
            started_at: SystemTime::now(),
        }
    }
}

/// Build the operator router. Mount under whatever listener the caller
/// owns — typically a separate `TcpListener` bound to the management
/// interface.
pub fn router(state: OperatorState) -> Router {
    Router::new()
        .route("/status", get(get_status))
        .route("/links", get(list_links))
        .route("/links/{link_id}/disconnect", post(disconnect_link))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_bearer,
        ))
        .with_state(state)
}

async fn require_bearer(
    State(state): State<OperatorState>,
    req: Request,
    next: Next,
) -> Response {
    let presented: Option<&[u8]> = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.as_bytes());

    let expected: &[u8] = state.token.as_slice();
    let ok = match presented {
        Some(p) if p.len() == expected.len() => p.ct_eq(expected).into(),
        _ => false,
    };

    if !ok {
        let mut resp = (StatusCode::UNAUTHORIZED, Json(ErrorBody { error: "unauthorized" }))
            .into_response();
        resp.headers_mut().insert(
            axum::http::header::WWW_AUTHENTICATE,
            HeaderValue::from_static("Bearer realm=\"strata-dmz-operator\""),
        );
        return resp;
    }
    next.run(req).await
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}

#[derive(Serialize)]
struct StatusBody {
    cluster_id: String,
    node_id: String,
    uptime_secs: u64,
    links_up: usize,
    version: &'static str,
}

async fn get_status(State(state): State<OperatorState>) -> Json<StatusBody> {
    let uptime = SystemTime::now()
        .duration_since(state.started_at)
        .unwrap_or_default()
        .as_secs();
    Json(StatusBody {
        cluster_id: state.cluster_id.clone(),
        node_id: state.node_id.clone(),
        uptime_secs: uptime,
        links_up: state.registry.len(),
        version: env!("CARGO_PKG_VERSION"),
    })
}

#[derive(Serialize)]
struct LinkRow {
    link_id: String,
    cluster_id: String,
    node_id: String,
    software_version: String,
    /// Seconds since the link came up.
    age_secs: u64,
}

async fn list_links(State(state): State<OperatorState>) -> Json<Vec<LinkRow>> {
    let now = std::time::Instant::now();
    let rows = state
        .registry
        .snapshot()
        .into_iter()
        .map(|s| LinkRow {
            age_secs: now.saturating_duration_since(s.since).as_secs(),
            link_id: s.link_id,
            cluster_id: s.cluster_id,
            node_id: s.node_id,
            software_version: s.software_version,
        })
        .collect();
    Json(rows)
}

#[derive(Serialize)]
struct DisconnectBody {
    disconnected: bool,
    link_id: String,
}

async fn disconnect_link(
    State(state): State<OperatorState>,
    Path(link_id): Path<String>,
) -> Response {
    // We don't have a "link existed" probe separate from snapshot;
    // the snapshot lookup is cheap.
    let existed = state.registry.snapshot().iter().any(|s| s.link_id == link_id);
    state.registry.remove(&link_id);
    tracing::info!(
        link_id = %link_id,
        existed,
        actor = "operator",
        "DMZ link forcibly disconnected"
    );
    if existed {
        (
            StatusCode::OK,
            Json(DisconnectBody {
                disconnected: true,
                link_id,
            }),
        )
            .into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "link not found",
            }),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Method, Request as HttpRequest};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn state() -> OperatorState {
        OperatorState::new(
            LinkSessionRegistry::new(),
            Zeroizing::new(b"a-32-char-or-longer-operator-token!!".to_vec()),
            "production".into(),
            "dmz-test".into(),
        )
    }

    fn auth_header() -> HeaderValue {
        HeaderValue::from_static("Bearer a-32-char-or-longer-operator-token!!")
    }

    async fn call(router: Router, req: HttpRequest<Body>) -> Response {
        router.oneshot(req).await.expect("router responded")
    }

    #[tokio::test]
    async fn status_requires_auth() {
        let r = router(state());
        let req = HttpRequest::builder()
            .method(Method::GET)
            .uri("/status")
            .body(Body::empty())
            .unwrap();
        let resp = call(r, req).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert!(resp.headers().get("www-authenticate").is_some());
    }

    #[tokio::test]
    async fn status_with_wrong_token_is_401() {
        let r = router(state());
        let req = HttpRequest::builder()
            .method(Method::GET)
            .uri("/status")
            .header(
                axum::http::header::AUTHORIZATION,
                "Bearer this-is-not-the-right-32-char-token",
            )
            .body(Body::empty())
            .unwrap();
        let resp = call(r, req).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn status_with_correct_token_returns_json() {
        let r = router(state());
        let req = HttpRequest::builder()
            .method(Method::GET)
            .uri("/status")
            .header(axum::http::header::AUTHORIZATION, auth_header())
            .body(Body::empty())
            .unwrap();
        let resp = call(r, req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["cluster_id"], "production");
        assert_eq!(v["node_id"], "dmz-test");
        assert_eq!(v["links_up"], 0);
    }

    #[tokio::test]
    async fn links_returns_empty_list() {
        let r = router(state());
        let req = HttpRequest::builder()
            .method(Method::GET)
            .uri("/links")
            .header(axum::http::header::AUTHORIZATION, auth_header())
            .body(Body::empty())
            .unwrap();
        let resp = call(r, req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(v.is_array());
        assert_eq!(v.as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn disconnect_unknown_link_is_404() {
        let r = router(state());
        let req = HttpRequest::builder()
            .method(Method::POST)
            .uri("/links/nonexistent/disconnect")
            .header(axum::http::header::AUTHORIZATION, auth_header())
            .body(Body::empty())
            .unwrap();
        let resp = call(r, req).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn token_compare_is_length_safe() {
        // A token shorter than the configured one must NOT short-
        // circuit to "match prefix"; constant-time compare requires
        // equal lengths.
        let r = router(state());
        let req = HttpRequest::builder()
            .method(Method::GET)
            .uri("/status")
            .header(axum::http::header::AUTHORIZATION, "Bearer a")
            .body(Body::empty())
            .unwrap();
        let resp = call(r, req).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
