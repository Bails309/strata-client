//! Per-endpoint link supervisor task.
//!
//! Drives a single endpoint's lifecycle: dial → handshake → h2 serve
//! loop → backoff → repeat. Cancellation token aware so the existing
//! graceful-shutdown harness in `main.rs` can drain it.

use std::sync::Arc;

use strata_protocol::backoff::default_link_backoff;
use strata_protocol::link::{client_handshake, ClientHandshakeConfig};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::config::{LinkConfig, LinkEndpoint};
use super::connector::{BoxedStream, Connector};
use super::h2_serve::{serve_h2, RequestHandler};
use super::registry::{LinkRegistry, LinkState};

/// Spawn one supervisor task per configured endpoint.
///
/// Returns a single join handle that completes when **all** supervisors
/// have unwound (cancellation observed by every loop).
pub fn spawn_link_supervisors(
    cfg: Arc<LinkConfig>,
    connector: Arc<dyn Connector>,
    handler: Arc<dyn RequestHandler>,
    registry: LinkRegistry,
    shutdown: CancellationToken,
) -> JoinHandle<()> {
    registry.seed(&cfg.endpoints);

    tokio::spawn(async move {
        let mut handles = Vec::with_capacity(cfg.endpoints.len());
        for endpoint in cfg.endpoints.clone() {
            let cfg = cfg.clone();
            let connector = connector.clone();
            let handler = handler.clone();
            let registry = registry.clone();
            let shutdown = shutdown.clone();
            handles.push(tokio::spawn(async move {
                run_endpoint(cfg, endpoint, connector, handler, registry, shutdown).await
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
    handler: Arc<dyn RequestHandler>,
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
                let delay = backoff.next_delay(&mut rand::rng());
                if !sleep_with_cancel(delay, &shutdown).await {
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
                let delay = backoff.next_delay(&mut rand::rng());
                if !sleep_with_cancel(delay, &shutdown).await {
                    registry.set_state(&url, LinkState::Stopped, None);
                    return;
                }
                continue;
            }
        };
        tracing::info!(endpoint = %url, link_id = %accepted.link_id, "DMZ link authenticated");

        // ── h2 serve loop ───────────────────────────────────────────
        // The link state stays `Authenticating` until the h2 handshake
        // completes (the on_ready callback flips it to `Up`). This
        // means a stuck h2 layer never falsely advertises readiness
        // to /readyz consumers.
        let url_for_ready = url.clone();
        let registry_for_ready = registry.clone();
        let serve_result = serve_h2(stream, handler.clone(), shutdown.clone(), move || {
            registry_for_ready.set_state(&url_for_ready, LinkState::Up, None);
        })
        .await;

        if shutdown.is_cancelled() {
            registry.set_state(&url, LinkState::Stopped, None);
            return;
        }

        let msg = match serve_result {
            Ok(()) => "peer closed link".to_string(),
            Err(e) => format!("h2 serve: {e}"),
        };
        tracing::warn!(endpoint = %url, reason = %msg, "DMZ link down");
        registry.set_state(&url, LinkState::Backoff, Some(msg));

        let delay = backoff.next_delay(&mut rand::rng());
                if !sleep_with_cancel(delay, &shutdown).await {
            registry.set_state(&url, LinkState::Stopped, None);
            return;
        }

        // Reset backoff once we've seen a successful link cycle (h2
        // handshake completed at least once); otherwise a flapping
        // peer that reaches Up briefly would never escape the cap.
        backoff.reset();
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
    use bytes::Bytes;
    use http::{Request, Response, StatusCode};
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::Duration;
    use strata_protocol::link::{server_handshake, ServerHandshakeConfig};

    /// Minimal handler for the supervisor tests — replies 204 to any
    /// request. We never actually issue requests in these tests; the
    /// handler exists only to satisfy `serve_h2`'s signature.
    struct NullHandler;
    #[async_trait]
    impl RequestHandler for NullHandler {
        async fn handle(&self, _: Request<Bytes>) -> Response<Bytes> {
            Response::builder()
                .status(StatusCode::NO_CONTENT)
                .body(Bytes::new())
                .unwrap()
        }
    }

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
    /// pairs a fresh client end with a server end and runs the
    /// requested server-side script (`server_action`) on the latter.
    struct TestConnector {
        psks: HashMap<String, Vec<u8>>,
        link_id: String,
        calls: Arc<Mutex<usize>>,
        server_after_auth: Arc<dyn Fn(BoxedStream) + Send + Sync>,
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

            let (client, server) = tokio::io::duplex(64 * 1024);
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

    /// Drive the DMZ-side h2 client handshake on the server end of the
    /// duplex pair, then keep it open until told to shut down. This is
    /// what the real DMZ does with the authenticated stream after
    /// `server_handshake` returns.
    fn dmz_h2_client_holder() -> Arc<dyn Fn(BoxedStream) + Send + Sync> {
        Arc::new(|stream: BoxedStream| {
            tokio::spawn(async move {
                let (h2, conn) = match h2::client::handshake(stream).await {
                    Ok(p) => p,
                    Err(_) => return,
                };
                // Hold the SendRequest handle so the connection stays
                // up; drop on this task's death tears it down.
                let _h2 = h2;
                let _ = conn.await;
            });
        })
    }

    /// Run h2 client handshake then immediately drop the connection,
    /// forcing the supervisor's serve_h2 to return and trigger a
    /// reconnect.
    fn dmz_h2_client_drops_after_ready() -> Arc<dyn Fn(BoxedStream) + Send + Sync> {
        Arc::new(|stream: BoxedStream| {
            tokio::spawn(async move {
                if let Ok((h2, conn)) = h2::client::handshake(stream).await {
                    drop(h2);
                    let _ = conn.await;
                }
            });
        })
    }

    #[tokio::test(flavor = "current_thread", start_paused = false)]
    async fn supervisor_brings_link_up_after_h2_handshake() {
        let (connector, _calls) = make_connector(false, dmz_h2_client_holder());
        let reg = LinkRegistry::new();
        let shutdown = CancellationToken::new();

        let h = spawn_link_supervisors(
            cfg(),
            connector,
            Arc::new(NullHandler),
            reg.clone(),
            shutdown.clone(),
        );

        assert!(wait_state(&reg, "test://dmz", LinkState::Up, 3000).await);

        shutdown.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(3), h).await;
        assert!(reg.snapshot().iter().any(|s| s.state == LinkState::Stopped));
    }

    #[tokio::test(flavor = "current_thread", start_paused = false)]
    async fn supervisor_reconnects_after_disconnect() {
        // DMZ side completes h2 handshake then drops, so each cycle
        // briefly reaches Up before bouncing back to Backoff.
        let (connector, calls) = make_connector(false, dmz_h2_client_drops_after_ready());
        let reg = LinkRegistry::new();
        let shutdown = CancellationToken::new();

        let h = spawn_link_supervisors(
            cfg(),
            connector,
            Arc::new(NullHandler),
            reg.clone(),
            shutdown.clone(),
        );

        // Wait until at least 2 connect attempts (proving reconnect happened).
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
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
        let _ = tokio::time::timeout(Duration::from_secs(3), h).await;
    }

    #[tokio::test(flavor = "current_thread", start_paused = false)]
    async fn supervisor_recovers_from_dial_failure() {
        let (connector, _calls) = make_connector(true, dmz_h2_client_holder());
        let reg = LinkRegistry::new();
        let shutdown = CancellationToken::new();

        let h = spawn_link_supervisors(
            cfg(),
            connector,
            Arc::new(NullHandler),
            reg.clone(),
            shutdown.clone(),
        );

        // Should hit Backoff once, then come Up after the second dial.
        assert!(wait_state(&reg, "test://dmz", LinkState::Backoff, 3000).await);
        assert!(wait_state(&reg, "test://dmz", LinkState::Up, 5000).await);

        shutdown.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(3), h).await;
    }

    #[tokio::test(flavor = "current_thread", start_paused = false)]
    async fn supervisor_stays_in_authenticating_when_h2_handshake_stalls() {
        // DMZ side never speaks h2 — opens raw stream and sits idle.
        // Auth completes, but h2 handshake never does, so the link
        // must NEVER advertise Up to consumers (e.g. /readyz).
        let after = Arc::new(|stream: BoxedStream| {
            tokio::spawn(async move {
                let _hold = stream;
                tokio::time::sleep(Duration::from_secs(10)).await;
            });
        });
        let (connector, _calls) = make_connector(false, after);
        let reg = LinkRegistry::new();
        let shutdown = CancellationToken::new();

        let h = spawn_link_supervisors(
            cfg(),
            connector,
            Arc::new(NullHandler),
            reg.clone(),
            shutdown.clone(),
        );

        // Reach Authenticating quickly, then verify we DON'T flip to
        // Up over the next second.
        assert!(wait_state(&reg, "test://dmz", LinkState::Authenticating, 2000).await);
        let bumped_to_up =
            tokio::time::timeout(Duration::from_secs(1), wait_state(&reg, "test://dmz", LinkState::Up, 1000)).await;
        match bumped_to_up {
            Ok(true) => panic!("link reached Up despite stalled h2 handshake"),
            _ => {}
        }
        assert!(!reg.any_up());

        shutdown.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(3), h).await;
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
        let h = spawn_link_supervisors(
            cfg(),
            Arc::new(AlwaysFail),
            Arc::new(NullHandler),
            reg.clone(),
            shutdown.clone(),
        );

        // Wait until at least one Backoff has been recorded.
        assert!(wait_state(&reg, "test://dmz", LinkState::Backoff, 2000).await);

        shutdown.cancel();
        let r = tokio::time::timeout(Duration::from_secs(2), h).await;
        assert!(r.is_ok(), "supervisor did not unwind within 2s of cancel");
    }
}
