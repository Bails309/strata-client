//! `strata-dmz` — Strata Client public-facing dumb-proxy.
//!
//! This binary terminates public TLS, performs basic abuse-mitigation
//! (rate limit, body caps, slow-loris timeouts), and forwards every
//! request through a persistent **inbound** mTLS link to the internal
//! `strata-backend` node. It holds NO Strata business secrets.
//!
//! Phase 0 scope (this commit): minimal Axum stub serving `/healthz`
//! and `/readyz`. Public surface, link server, edge-header signer
//! land in Phase 2.

#![forbid(unsafe_code)]

use std::net::SocketAddr;

use axum::{routing::get, Router};
use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .json()
        .init();

    let bind: SocketAddr = std::env::var("STRATA_DMZ_BIND")
        .unwrap_or_else(|_| "0.0.0.0:8443".to_string())
        .parse()?;

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz));

    info!(%bind, "strata-dmz starting (Phase 0 stub)");

    let listener = tokio::net::TcpListener::bind(bind).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn healthz() -> &'static str {
    "ok"
}

async fn readyz() -> (axum::http::StatusCode, &'static str) {
    // Phase 2 will gate this on "at least one internal link is up".
    // Until then, the stub is always ready to ack — there is nothing
    // to be unready for.
    (axum::http::StatusCode::OK, "ok")
}
