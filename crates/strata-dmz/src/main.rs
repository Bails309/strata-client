//! `strata-dmz` — Strata Client public-facing dumb-proxy.
//!
//! This binary terminates public TLS, performs basic abuse-mitigation
//! (rate limit, body caps, slow-loris timeouts), and forwards every
//! request through a persistent **inbound** mTLS link to the internal
//! `strata-backend` node. It holds NO Strata business secrets.
//!
//! Phase 2e scope: link server + reverse-proxy adapter + edge-header
//! HMAC signer + abuse-mitigation tower stack (per-IP rate limit,
//! global concurrency cap, request timeout, body limit) live. Public
//! TLS termination lands in Phase 3.

// Crate-wide we deny unsafe; the only exception is the boot-time env
// scrubber in `config`, which is a single `unsafe` block guarded by
// "called from main, before any worker thread exists".
#![deny(unsafe_code)]

use std::sync::Arc;

use axum::{routing::get, Router};
use tower::limit::GlobalConcurrencyLimitLayer;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::timeout::TimeoutLayer;
use tracing::info;
use tracing_subscriber::EnvFilter;

mod config;
mod edge_signer;
mod limits;
mod link_server;
mod proxy;

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

    // Phase 2b — install rustls 0.23 with the ring crypto provider
    // exactly once. Both the public listener (when implemented) and
    // the link server share this provider.
    if rustls::crypto::ring::default_provider()
        .install_default()
        .is_err()
    {
        tracing::warn!("rustls default crypto provider was already installed");
    }

    // Pick the active PSK id: the first inserted entry is by
    // convention "the active key". The DmzConfig HashMap doesn't
    // preserve insertion order, so until we add an explicit field
    // the operator should set STRATA_DMZ_LINK_PSKS with `current:...`
    // as the first entry and we enforce that at parse time in 2c.
    // For now use any key — every accepted internal node MACs under
    // the id we send back.
    let active_psk_id = cfg
        .link_psks
        .keys()
        .next()
        .cloned()
        .expect("DmzConfig::from_env guarantees ≥1 PSK");

    // Build the link-server TLS acceptor (mTLS, h2 ALPN-only).
    let acceptor = link_server::build_acceptor(
        &cfg.link_tls.cert_pem,
        &cfg.link_tls.key_pem,
        &cfg.link_ca_bundle_pem,
    )?;

    let registry = link_server::LinkSessionRegistry::new();
    let shutdown = tokio_util::sync::CancellationToken::new();

    let link_cfg = link_server::LinkServerConfig {
        cluster_id: cfg.cluster_id.clone(),
        active_psk_id,
        psks: cfg.link_psks.clone(),
        listen_addr: cfg.link_bind,
    };
    let registry_for_link = registry.clone();
    let shutdown_for_link = shutdown.clone();
    let link_handle = tokio::spawn(async move {
        if let Err(e) =
            link_server::serve_link(link_cfg, acceptor, registry_for_link, shutdown_for_link).await
        {
            tracing::error!(error = %e, "DMZ link server exited with error");
        }
    });

    // Phase 2c — public surface forwards every non-health request
    // through the reverse-proxy adapter, which picks a session from
    // `registry` per request. Phase 2d wires the real HMAC edge-header
    // signer; Phase 2e adds rate-limit / body-cap / concurrency tower
    // layers.
    let edge_signer = edge_signer::HmacEdgeSigner::from_config(
        cfg.edge_hmac_key.clone(),
        cfg.node_id.clone(),
        &cfg.trust_forwarded_from,
    );
    let proxy_state = proxy::ProxyState::new(
        registry.clone(),
        Arc::new(edge_signer) as Arc<dyn proxy::EdgeSigner>,
    );
    let registry_for_readyz = registry.clone();

    // Phase 2e — abuse mitigation. Layers are applied outermost-to-
    // innermost as listed: rate-limit (cheapest, drops bad actors
    // before any work), concurrency cap (bounds tail latency under
    // load), request timeout (slow-loris), body limit (memory
    // exhaustion).
    let limiter = limits::PerIpRateLimiter::new(cfg.public_rate_rps, cfg.public_rate_burst);
    let request_timeout =
        std::time::Duration::from_millis(cfg.public_header_timeout_ms.max(1_000));

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route(
            "/readyz",
            get(move || {
                let r = registry_for_readyz.clone();
                async move {
                    if r.any_up() {
                        (axum::http::StatusCode::OK, "ok")
                    } else {
                        (
                            axum::http::StatusCode::SERVICE_UNAVAILABLE,
                            "no internal links up",
                        )
                    }
                }
            }),
        )
        .fallback(proxy::proxy_handler)
        .with_state(proxy_state)
        .layer(RequestBodyLimitLayer::new(cfg.public_body_limit_bytes))
        .layer(TimeoutLayer::new(request_timeout))
        .layer(GlobalConcurrencyLimitLayer::new(cfg.public_max_inflight))
        .layer(axum::middleware::from_fn_with_state(
            limiter,
            limits::rate_limit_middleware,
        ));

    info!(bind = %cfg.public_bind, "strata-dmz starting (Phase 2e: link server + reverse-proxy + edge-header signer + abuse mitigation live)");

    let listener = tokio::net::TcpListener::bind(cfg.public_bind).await?;
    let serve_result = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
        .with_graceful_shutdown({
            let s = shutdown.clone();
            async move {
                tokio::signal::ctrl_c().await.ok();
                s.cancel();
            }
        })
        .await;

    let _ = link_handle.await;
    serve_result?;
    Ok(())
}

async fn healthz() -> &'static str {
    "ok"
}
