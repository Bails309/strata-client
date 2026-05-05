//! TCP/TLS listener for inbound link connections from internal nodes.
//!
//! Per accepted connection:
//!
//! 1. Complete TLS handshake with mTLS — only certs chained to the
//!    configured private CA bundle are admitted.
//! 2. Run [`strata_protocol::link::server_handshake`] over the
//!    plaintext-after-TLS stream. Reject if the cluster id doesn't
//!    match this DMZ's `cluster_id` (i.e. someone with valid PKI but
//!    from the wrong cluster — defence in depth alongside the CA
//!    boundary).
//! 3. Drive `h2::client::handshake` over the same stream. The DMZ is
//!    the **client** of the h2 connection: requests flow DMZ → internal.
//! 4. Stash the resulting `SendRequest<Bytes>` in the
//!    [`LinkSessionRegistry`] keyed by the link id we minted.
//! 5. Drive the h2 connection future to completion in a background
//!    task. When it ends, evict the registry entry — the
//!    reverse-proxy adapter must immediately stop picking it.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use anyhow::Context;
use bytes::Bytes;
use strata_protocol::link::{server_handshake, LinkPeer, ServerHandshakeConfig};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

use super::registry::{LinkSessionInfo, LinkSessionRegistry};

/// Inputs for the link server listener.
pub struct LinkServerConfig {
    /// Cluster id this DMZ accepts.
    pub cluster_id: String,
    /// Active PSK id and rotation map.
    pub active_psk_id: String,
    pub psks: HashMap<String, Zeroizing<Vec<u8>>>,
    /// TCP listener address.
    pub listen_addr: std::net::SocketAddr,
}

/// Bind, accept, and drive link connections until `shutdown` cancels.
///
/// This function is the entire link server: there is no "spawn supervisor"
/// step — every accepted TCP connection is its own tokio task, gated only
/// by the supplied [`TlsAcceptor`].
pub async fn serve_link(
    cfg: LinkServerConfig,
    acceptor: TlsAcceptor,
    registry: LinkSessionRegistry,
    shutdown: CancellationToken,
) -> anyhow::Result<()> {
    let listener = TcpListener::bind(cfg.listen_addr)
        .await
        .with_context(|| format!("bind link listener on {}", cfg.listen_addr))?;
    tracing::info!(addr = %cfg.listen_addr, "DMZ link server listening");

    let cfg = Arc::new(cfg);

    loop {
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => {
                tracing::info!("DMZ link server shutting down");
                break;
            }
            accept = listener.accept() => {
                let (tcp, peer) = match accept {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!(error = %e, "DMZ link accept failed");
                        continue;
                    }
                };
                if let Err(e) = tcp.set_nodelay(true) {
                    tracing::warn!(%peer, error = %e, "set_nodelay failed on link socket");
                }
                let acceptor = acceptor.clone();
                let cfg = cfg.clone();
                let registry = registry.clone();
                let shutdown = shutdown.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_connection(tcp, peer, acceptor, cfg, registry, shutdown).await {
                        tracing::warn!(%peer, error = %e, "DMZ link connection ended with error");
                    }
                });
            }
        }
    }
    Ok(())
}

async fn handle_connection(
    tcp: tokio::net::TcpStream,
    peer: std::net::SocketAddr,
    acceptor: TlsAcceptor,
    cfg: Arc<LinkServerConfig>,
    registry: LinkSessionRegistry,
    shutdown: CancellationToken,
) -> anyhow::Result<()> {
    let tls = acceptor
        .accept(tcp)
        .await
        .context("TLS handshake with internal node")?;
    tracing::debug!(%peer, "DMZ link TLS handshake complete");

    let mut tls = tls;
    let link_id = Uuid::new_v4().to_string();

    let psks: HashMap<String, Vec<u8>> = cfg
        .psks
        .iter()
        .map(|(k, v)| (k.clone(), v.to_vec()))
        .collect();

    let sh_cfg = ServerHandshakeConfig {
        psk_id: cfg.active_psk_id.clone(),
        psks,
        link_id: link_id.clone(),
    };

    let peer_info: LinkPeer = server_handshake(&mut tls, &sh_cfg)
        .await
        .with_context(|| format!("link handshake from {peer}"))?;

    if peer_info.cluster_id != cfg.cluster_id {
        anyhow::bail!(
            "internal node {} advertised cluster_id {:?}, expected {:?}",
            peer,
            peer_info.cluster_id,
            cfg.cluster_id,
        );
    }

    tracing::info!(
        %peer,
        link_id = %link_id,
        node_id = %peer_info.node_id,
        software_version = %peer_info.software_version,
        "DMZ link authenticated"
    );

    // h2 client over the authenticated stream. The DMZ pushes requests
    // to the internal node; the internal node's serve_h2 hands them
    // to its axum router (Phase 1g).
    let (sender, connection) = h2::client::handshake(tls)
        .await
        .context("h2 client handshake on link stream")?;

    let info = LinkSessionInfo {
        link_id: link_id.clone(),
        cluster_id: peer_info.cluster_id.clone(),
        node_id: peer_info.node_id.clone(),
        software_version: peer_info.software_version.clone(),
        since: Instant::now(),
    };
    registry.insert(info, sender);

    // Drive the connection. When it ends (peer closed, TLS error, h2
    // GOAWAY, etc.), drop the registry entry so the reverse-proxy
    // adapter stops picking it.
    let result = tokio::select! {
        biased;
        _ = shutdown.cancelled() => Ok(()),
        r = connection => r.context("h2 link connection terminated"),
    };
    registry.remove(&link_id);
    tracing::info!(
        %peer,
        link_id = %link_id,
        "DMZ link torn down"
    );
    result.map(|_| ())
}
