//! Per-endpoint link supervisor task.
//!
//! Drives a single endpoint's lifecycle: dial → handshake → hold open
//! until disconnect → backoff → repeat. Cancellation token aware so
//! the existing graceful-shutdown harness in `main.rs` can drain it.

use std::sync::Arc;

use rand::rngs::OsRng;
use strata_protocol::backoff::default_link_backoff;
use strata_protocol::link::{client_handshake, ClientHandshakeConfig};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::config::{LinkConfig, LinkEndpoint};
use super::connector::{BoxedStream, Connector};
use super::registry::{LinkRegistry, LinkState};

/// Spawn one supervisor task per configured endpoint.
///
/// Returns a single join handle that completes when **all** supervisors
/// have unwound (cancellation observed by every loop).
pub fn spawn_link_supervisors(
    cfg: Arc<LinkConfig>,
    connector: Arc<dyn Connector>,
    registry: LinkRegistry,
    shutdown: CancellationToken,
) -> JoinHandle<()> {
    registry.seed(&cfg.endpoints);

    tokio::spawn(async move {
        let mut handles = Vec::with_capacity(cfg.endpoints.len());
        for endpoint in cfg.endpoints.clone() {
            let cfg = cfg.clone();
            let connector = connector.clone();
            let registry = registry.clone();
            let shutdown = shutdown.clone();
            handles.push(tokio::spawn(async move {
                run_endpoint(cfg, endpoint, connector, registry, shutdown).await
            }));
        }
        for h in handles {
            let _ = h.await;
        }
    })
}

async fn run_endpoint(
    cfg: Arc<LinkConfig>,
    endpoint: LinkEndpoint,
    connector: Arc<dyn Connector>,
    registry: LinkRegistry,
    shutdown: CancellationToken,
) {
    let mut backoff = default_link_backoff();
    let url = endpoint.url.clone();

    loop {
        if shutdown.is_cancelled() {
            registry.set_state(&url, LinkState::Stopped, None);
            return;
        }

        // ── dial ────────────────────────────────────────────────────
        registry.set_state(&url, LinkState::Connecting, None);
        let stream = tokio::select! {
            biased;
            _ = shutdown.cancelled() => {
                registry.set_state(&url, LinkState::Stopped, None);
                return;
            }
            r = connector.connect(&endpoint) => r,
        };

        let mut stream: BoxedStream = match stream {
            Ok(s) => s,
            Err(e) => {
                let msg = format!("dial failed: {e}");
                tracing::warn!(endpoint = %url, error = %msg, "DMZ link dial failed");
                registry.set_state(&url, LinkState::Backoff, Some(msg));
                if !sleep_with_cancel(backoff.next_delay(&mut OsRng), &shutdown).await {
                    registry.set_state(&url, LinkState::Stopped, None);
                    return;
                }
                continue;
            }
        };

        // ── auth handshake ──────────────────────────────────────────
        registry.set_state(&url, LinkState::Authenticating, None);
        let hs_cfg = ClientHandshakeConfig {
            cluster_id: cfg.cluster_id.clone(),
            node_id: cfg.node_id.clone(),
            software_version: cfg.software_version.clone(),
            psks: cfg.psks.clone(),
        };
        let accepted = match client_handshake(&mut stream, &hs_cfg).await {
            Ok(a) => a,
            Err(e) => {
                let msg = format!("handshake failed: {e}");
                tracing::warn!(endpoint = %url, error = %msg, "DMZ link handshake failed");
                registry.set_state(&url, LinkState::Backoff, Some(msg));
                if !sleep_with_cancel(backoff.next_delay(&mut OsRng), &shutdown).await {
                    registry.set_state(&url, LinkState::Stopped, None);
                    return;
                }
                continue;
            }
        };

        // ── up ──────────────────────────────────────────────────────
        tracing::info!(endpoint = %url, link_id = %accepted.link_id, "DMZ link up");
        registry.set_state(&url, LinkState::Up, None);
        backoff.reset();

        // Phase 1d will turn this block into an HTTP/2 request multiplexer.
        // For now: hold the link open by reading from the server until it
        // disconnects, which keeps the supervisor loop semantically correct
        // (a peer-initiated FIN or any read error means "link down").
        let dc = wait_for_disconnect(&mut stream, &shutdown).await;
        if let Disconnect::ShutdownObserved = dc {
            registry.set_state(&url, LinkState::Stopped, None);
            return;
        }
        let msg = match dc {
            Disconnect::PeerClosed => "peer closed link".to_string(),
            Disconnect::IoError(e) => format!("link i/o: {e}"),
            Disconnect::ShutdownObserved => unreachable!(),
        };
        tracing::warn!(endpoint = %url, reason = %msg, "DMZ link down");
        registry.set_state(&url, LinkState::Backoff, Some(msg));

        if !sleep_with_cancel(backoff.next_delay(&mut OsRng), &shutdown).await {
            registry.set_state(&url, LinkState::Stopped, None);
            return;
        }
    }
}

enum Disconnect {
    PeerClosed,
    IoError(std::io::Error),
    ShutdownObserved,
}

async fn wait_for_disconnect<S>(stream: &mut S, shutdown: &CancellationToken) -> Disconnect
where
    S: AsyncRead + Unpin,
{
    let mut buf = [0u8; 1];
    tokio::select! {
        biased;
        _ = shutdown.cancelled() => Disconnect::ShutdownObserved,
        r = stream.read(&mut buf) => match r {
            Ok(0) => Disconnect::PeerClosed,
            Ok(_) => {
                // Phase 1d will route bytes into the h2 decoder. Until
                // then: any unexpected byte from the peer is a protocol
                // violation; treat it as a disconnect to force a fresh
                // handshake.
                Disconnect::IoError(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "unexpected post-handshake byte from peer",
                ))
            }
            Err(e) => Disconnect::IoError(e),
        }
    }
}

/// Sleep for `dur`, returning `false` if the cancellation token fired.
async fn sleep_with_cancel(dur: std::time::Duration, shutdown: &CancellationToken) -> bool {
    tokio::select! {
        biased;
        _ = shutdown.cancelled() => false,
        _ = tokio::time::sleep(dur) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::dmz_link::config::{LinkConfig, LinkEndpoint};
    use crate::services::dmz_link::connector::{BoxedStream, Connector};
    use async_trait::async_trait;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::Duration;
    use strata_protocol::link::{server_handshake, ServerHandshakeConfig};
    use tokio::io::AsyncWriteExt;

    fn cfg() -> Arc<LinkConfig> {
        let mut psks = HashMap::new();
        psks.insert("current".into(), b"shared-link-psk".to_vec());
        Arc::new(LinkConfig {
            cluster_id: "production".into(),
            node_id: "internal-1".into(),
            software_version: "test".into(),
            endpoints: vec![LinkEndpoint {
                url: "test://dmz".into(),
            }],
            psks,
            client_cert_path: None,
            client_key_path: None,
            link_ca_path: None,
        })
    }

    /// Connector backed by `tokio::io::duplex`: every `connect` call
    /// pairs a fresh client end with a server end and spawns the
    /// requested server-side script (`server_action`) on the latter.
    struct TestConnector {
        psks: HashMap<String, Vec<u8>>,
        link_id: String,
        /// Number of `connect()` calls so far. Used to script
        /// "first call fails, second succeeds" tests.
        calls: Arc<Mutex<usize>>,
        /// Closure run on the server-side stream after a successful
        /// handshake. Replaces Phase 1d's request multiplexer in tests.
        server_after_auth: Arc<dyn Fn(BoxedStream) + Send + Sync>,
        /// Whether to fail the first dial outright (to exercise backoff).
        fail_first_dial: bool,
    }

    #[async_trait]
    impl Connector for TestConnector {
        async fn connect(&self, _endpoint: &LinkEndpoint) -> anyhow::Result<BoxedStream> {
            let n = {
                let mut g = self.calls.lock().unwrap();
                *g += 1;
                *g
            };
            if self.fail_first_dial && n == 1 {
                anyhow::bail!("scripted dial failure");
            }

            let (client, server) = tokio::io::duplex(8192);
            let psks = self.psks.clone();
            let link_id = self.link_id.clone();
            let after_auth = self.server_after_auth.clone();

            tokio::spawn(async move {
                let mut server: BoxedStream = Box::new(server);
                let sc = ServerHandshakeConfig {
                    psk_id: "current".into(),
                    psks,
                    link_id,
                };
                if server_handshake(&mut server, &sc).await.is_ok() {
                    after_auth(server);
                }
            });

            Ok(Box::new(client))
        }
    }

    fn make_connector(
        fail_first_dial: bool,
        server_after_auth: Arc<dyn Fn(BoxedStream) + Send + Sync>,
    ) -> (Arc<TestConnector>, Arc<Mutex<usize>>) {
        let calls = Arc::new(Mutex::new(0));
        let mut psks = HashMap::new();
        psks.insert("current".into(), b"shared-link-psk".to_vec());
        let c = Arc::new(TestConnector {
            psks,
            link_id: "test-link".into(),
            calls: calls.clone(),
            server_after_auth,
            fail_first_dial,
        });
        (c, calls)
    }

    async fn wait_state(reg: &LinkRegistry, ep: &str, want: LinkState, timeout_ms: u64) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            if reg
                .snapshot()
                .iter()
                .any(|s| s.endpoint == ep && s.state == want)
            {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test(flavor = "current_thread", start_paused = false)]
    async fn supervisor_brings_link_up() {
        // Server: hold the stream open forever so the link stays Up.
        let after = Arc::new(|stream: BoxedStream| {
            tokio::spawn(async move {
                let _hold = stream;
                tokio::time::sleep(Duration::from_secs(5)).await;
            });
        });

        let (connector, _calls) = make_connector(false, after);
        let reg = LinkRegistry::new();
        let shutdown = CancellationToken::new();

        let h = spawn_link_supervisors(cfg(), connector, reg.clone(), shutdown.clone());

        assert!(wait_state(&reg, "test://dmz", LinkState::Up, 2000).await);

        shutdown.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(2), h).await;
        assert!(reg.snapshot().iter().any(|s| s.state == LinkState::Stopped));
    }

    #[tokio::test(flavor = "current_thread", start_paused = false)]
    async fn supervisor_reconnects_after_disconnect() {
        // Server: close the stream immediately after auth completes,
        // forcing the supervisor to backoff + reconnect at least once.
        let after = Arc::new(|stream: BoxedStream| {
            tokio::spawn(async move {
                let mut s = stream;
                let _ = s.shutdown().await;
            });
        });

        let (connector, calls) = make_connector(false, after);
        let reg = LinkRegistry::new();
        let shutdown = CancellationToken::new();

        let h = spawn_link_supervisors(cfg(), connector, reg.clone(), shutdown.clone());

        // Wait until at least 2 connect attempts (proving reconnect happened).
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            if *calls.lock().unwrap() >= 2 {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                panic!("supervisor did not reconnect within timeout");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        shutdown.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(2), h).await;
    }

    #[tokio::test(flavor = "current_thread", start_paused = false)]
    async fn supervisor_recovers_from_dial_failure() {
        let after = Arc::new(|stream: BoxedStream| {
            tokio::spawn(async move {
                let _hold = stream;
                tokio::time::sleep(Duration::from_secs(5)).await;
            });
        });
        let (connector, _calls) = make_connector(true, after);
        let reg = LinkRegistry::new();
        let shutdown = CancellationToken::new();

        let h = spawn_link_supervisors(cfg(), connector, reg.clone(), shutdown.clone());

        // Should hit Backoff once, then come Up after the second dial.
        assert!(wait_state(&reg, "test://dmz", LinkState::Backoff, 2000).await);
        assert!(wait_state(&reg, "test://dmz", LinkState::Up, 4000).await);

        shutdown.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(2), h).await;
    }

    #[tokio::test(flavor = "current_thread", start_paused = false)]
    async fn cancellation_during_backoff_unwinds_promptly() {
        // Force a never-ending backoff loop by always failing dials.
        struct AlwaysFail;
        #[async_trait]
        impl Connector for AlwaysFail {
            async fn connect(&self, _: &LinkEndpoint) -> anyhow::Result<BoxedStream> {
                anyhow::bail!("nope")
            }
        }

        let reg = LinkRegistry::new();
        let shutdown = CancellationToken::new();
        let h = spawn_link_supervisors(cfg(), Arc::new(AlwaysFail), reg.clone(), shutdown.clone());

        // Wait until at least one Backoff has been recorded.
        assert!(wait_state(&reg, "test://dmz", LinkState::Backoff, 2000).await);

        shutdown.cancel();
        let r = tokio::time::timeout(Duration::from_secs(2), h).await;
        assert!(r.is_ok(), "supervisor did not unwind within 2s of cancel");
    }
}
