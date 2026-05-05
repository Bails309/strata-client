//! `strata-dmz` — Strata Client public-facing dumb-proxy.
//!
//! This binary terminates public TLS, performs basic abuse-mitigation
//! (rate limit, body caps, slow-loris timeouts), and forwards every
//! request through a persistent **inbound** mTLS link to the internal
//! `strata-backend` node. It holds NO Strata business secrets.
//!
//! Phase 2a scope: env-driven configuration loading + boot-time
//! validation. The public listener is still a minimal stub serving
//! `/healthz` and `/readyz`; the link server, reverse-proxy adapter,
//! and edge-header signer land in 2b–2d.

// Crate-wide we deny unsafe; the only exception is the boot-time env
// scrubber in `config`, which is a single `unsafe` block guarded by
// "called from main, before any worker thread exists".
#![deny(unsafe_code)]

use axum::{routing::get, Router};
use tracing::info;
use tracing_subscriber::EnvFilter;

mod config;

use config::DmzConfig;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .json()
        .init();

    // Load + validate configuration. On failure abort with a clear
    // message; do NOT proceed with partial defaults.
    let cfg = match DmzConfig::from_env() {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(error = %e, "strata-dmz config validation failed; refusing to start");
            std::process::exit(2);
        }
    };

    info!(
        public_bind = %cfg.public_bind,
        link_bind = %cfg.link_bind,
        cluster_id = %cfg.cluster_id,
        node_id = %cfg.node_id,
        dev_mode = cfg.dev_mode,
        psk_ids = ?cfg.link_psks.keys().collect::<Vec<_>>(),
        "strata-dmz config loaded",
    );

    // Phase 2a: the public listener is still a stub. The real public
    // surface (TLS, abuse-mitigation, reverse-proxy adapter) and the
    // link server land in 2b–2e. Bind on the configured address so
    // operators can verify config at least reaches the listener.
    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz));

    info!(bind = %cfg.public_bind, "strata-dmz starting (Phase 2a stub listener)");

    let listener = tokio::net::TcpListener::bind(cfg.public_bind).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn healthz() -> &'static str {
    "ok"
}

async fn readyz() -> (axum::http::StatusCode, &'static str) {
    // Phase 2b will gate this on "at least one internal link is up".
    // Until then, the stub is always ready to ack — there is nothing
    // to be unready for.
    (axum::http::StatusCode::OK, "ok")
}
