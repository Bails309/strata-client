//! `strata-dmz` — Strata Client public-facing dumb-proxy.
//!
//! This binary terminates public TLS, performs basic abuse-mitigation
//! (rate limit, body caps, slow-loris timeouts), and forwards every
//! request through a persistent **inbound** mTLS link to the internal
//! `strata-backend` node. It holds NO Strata business secrets.
//!
//! Phase 3b scope: link server + reverse-proxy adapter + edge-header
//! HMAC signer + abuse-mitigation tower stack + operator status
//! listener + public TLS termination live.

// Crate-wide we deny unsafe; the only exception is the boot-time env
// scrubber in `config`, which is a single `unsafe` block guarded by
// "called from main, before any worker thread exists".
#![deny(unsafe_code)]

use std::sync::Arc;

use axum::{routing::get, Router};
use http::StatusCode;
use tower::limit::GlobalConcurrencyLimitLayer;
use tower_http::timeout::TimeoutLayer;
use tracing::info;
use tracing_subscriber::EnvFilter;

mod body_caps;
mod config;
mod edge_signer;
mod limits;
mod link_server;
mod operator;
mod proxy;
mod public_server;
mod public_tls;

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

    // Phase 3a — spin up the operator status listener on a SEPARATE
    // socket from the public surface. Bound to loopback by default;
    // operators override `STRATA_DMZ_OPERATOR_BIND` to expose it on a
    // management interface. The token is in `cfg.operator_token`,
    // already length-validated.
    let operator_state = operator::OperatorState::new(
        registry.clone(),
        cfg.operator_token.clone(),
        cfg.cluster_id.clone(),
        cfg.node_id.clone(),
    );
    let operator_app = operator::router(operator_state);
    let operator_bind = cfg.operator_bind;
    let operator_listener = tokio::net::TcpListener::bind(operator_bind).await?;
    info!(bind = %operator_bind, "DMZ operator listener up");
    let operator_shutdown = shutdown.clone();
    let operator_handle = tokio::spawn(async move {
        let res = axum::serve(operator_listener, operator_app)
            .with_graceful_shutdown(async move { operator_shutdown.cancelled().await })
            .await;
        if let Err(e) = res {
            tracing::error!(error = %e, "DMZ operator listener exited with error");
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
    let body_cap_policy = body_caps::BodyCapPolicy::new(
        cfg.public_body_limit_bytes,
        cfg.public_body_caps.clone(),
    );
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
        // W6-2 — per-public-IP body-cap tuning. The middleware resolves
        // the effective cap from the peer IP and the operator-supplied
        // CIDR table (`STRATA_DMZ_PUBLIC_BODY_LIMITS_BY_IP`), falling
        // back to `STRATA_DMZ_PUBLIC_BODY_LIMIT_BYTES`. This replaces
        // the older static `RequestBodyLimitLayer` so a per-IP rule
        // can grant trusted partner networks a larger headroom or
        // shrink the cap for known-noisy sources.
        .layer(axum::middleware::from_fn_with_state(
            body_cap_policy,
            body_caps::body_cap_middleware,
        ))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            request_timeout,
        ))
        .layer(GlobalConcurrencyLimitLayer::new(cfg.public_max_inflight))
        .layer(axum::middleware::from_fn_with_state(
            limiter,
            limits::rate_limit_middleware,
        ));

    info!(bind = %cfg.public_bind, "strata-dmz starting (Phase 3b: link server + reverse-proxy + edge-header signer + abuse mitigation + operator listener + public TLS live)");

    // Phase 3b — the public listener terminates TLS itself (rustls)
    // when material is present; in dev mode (no cert/key) it falls
    // back to plaintext HTTP. axum::serve doesn't expose a TLS seam,
    // so we drive hyper-util's auto::Builder directly.
    let public_tls = match &cfg.public_tls {
        Some(mat) => Some(public_tls::build_public_acceptor(
            &mat.cert_pem,
            &mat.key_pem,
        )?),
        None => {
            tracing::warn!("strata-dmz running with PLAINTEXT public listener (dev mode)");
            None
        }
    };

    let public_bind = cfg.public_bind;
    let public_shutdown = shutdown.clone();
    let public_handle = tokio::spawn(async move {
        if let Err(e) = public_server::serve_public(public_bind, app, public_tls, public_shutdown.clone()).await
        {
            tracing::error!(error = %e, "DMZ public listener exited with error");
        }
    });

    // Wait for ctrl-c to cancel the shared shutdown token, which in
    // turn drains all three listeners.
    let cancel_for_signal = shutdown.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        cancel_for_signal.cancel();
    });

    let _ = link_handle.await;
    let _ = operator_handle.await;
    let _ = public_handle.await;
    Ok(())
}

async fn healthz() -> &'static str {
    "ok"
}
