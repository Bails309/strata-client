//! Dual-stack bridge to the native Rust session engine.
//!
//! `guacd` still serves every session by default. When
//! [`strata_session::routing`] says otherwise, [`run_native`] takes the
//! WebSocket instead and drives `crates/strata-session` in-process.
//!
//! The bridge speaks Guacamole Wire Compatibility Mode, so the browser
//! cannot tell which engine it reached — that is the whole point of
//! Phase 2 (ADR-0015). Rollback is `STRATA_SESSION_ENGINE=guacd`.
//!
//! ## Environment
//!
//! | Variable | Meaning |
//! | --- | --- |
//! | `STRATA_SESSION_ENGINE` | `guacd` (default), `canary`, or `native` |
//! | `STRATA_SESSION_NATIVE_PERCENT` | canary rollout, 0-100, bucketed per target host |
//! | `STRATA_SESSION_NATIVE_HOSTS` | comma-separated hosts always served natively |
//! | `STRATA_SESSION_NATIVE_PROTOCOLS` | comma-separated protocols eligible for the rollout |

use std::collections::HashSet;
use std::sync::OnceLock;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use secrecy::SecretString;
use strata_session::actor::{NullAuditSink, SessionActor, SessionConfig, SessionHandle};
use strata_session::engine::ssh::{SshConfig, SshEngineFactory};
use strata_session::engine::{EngineFactory, Protocol, ProtocolEngine, TargetSpec};
use strata_session::routing::{RoutingPolicy, SessionBackend};
use strata_session::terminal::{RasterisingEngine, TerminalFont, DEFAULT_FONT_SIZE_PX};
use strata_session::transport::{ClientFrame, GuacDecoder, GuacWireEncoder};

use crate::error::AppError;
use crate::tunnel::HandshakeParams;

/// Connection parameter naming the target's accepted host keys.
///
/// SHA-256 fingerprints in OpenSSH's `SHA256:base64` form, comma
/// separated. Without it the native SSH engine has nothing to verify
/// against and the session falls back to `guacd`.
const HOST_KEY_PARAM: &str = "host-key-fingerprint";

/// The process-wide rollout policy, read from the environment once.
pub fn policy() -> &'static RoutingPolicy {
    static POLICY: OnceLock<RoutingPolicy> = OnceLock::new();
    POLICY.get_or_init(|| {
        let policy = policy_from_env();
        tracing::info!(?policy, "native session engine routing policy");
        policy
    })
}

fn policy_from_env() -> RoutingPolicy {
    let mode = std::env::var("STRATA_SESSION_ENGINE")
        .unwrap_or_default()
        .to_ascii_lowercase();

    // Anything unrecognised means guacd. A typo in this variable must
    // not silently enable the new engine.
    let percent = match mode.as_str() {
        "native" => 100,
        "canary" => std::env::var("STRATA_SESSION_NATIVE_PERCENT")
            .ok()
            .and_then(|v| v.trim().parse::<u8>().ok())
            .unwrap_or(0),
        _ => return RoutingPolicy::disabled(),
    };

    let available = RoutingPolicy::compiled_protocols();
    let eligible = match std::env::var("STRATA_SESSION_NATIVE_PROTOCOLS") {
        Ok(list) => list.split(',').filter_map(protocol_from_str).collect(),
        Err(_) => available.clone(),
    };
    let hosts: HashSet<String> = std::env::var("STRATA_SESSION_NATIVE_HOSTS")
        .unwrap_or_default()
        .split(',')
        .map(|h| h.trim().to_owned())
        .filter(|h| !h.is_empty())
        .collect();

    RoutingPolicy::new(available)
        .with_eligible_protocols(eligible)
        .with_pinned_hosts(hosts)
        .with_rollout_percent(percent)
}

/// Map a connection's protocol column onto the engine's protocol enum.
pub fn protocol_from_str(protocol: &str) -> Option<Protocol> {
    match protocol.trim().to_ascii_lowercase().as_str() {
        "ssh" => Some(Protocol::Ssh),
        "rdp" => Some(Protocol::Rdp),
        "vnc" => Some(Protocol::Vnc),
        "kubernetes" => Some(Protocol::KubeExec),
        _ => None,
    }
}

/// Decide whether this session should use the native engine.
///
/// Returns `None` to stay on `guacd`. A session that the policy selects
/// but that cannot actually run natively — no host key configured, no
/// font installed — falls back rather than failing: during a canary,
/// breaking a user's session is worse than not moving it.
pub fn select_native(handshake: &HandshakeParams) -> Option<Protocol> {
    let protocol = protocol_from_str(&handshake.protocol)?;
    let decision = policy().decide(protocol, &handshake.hostname);
    if decision.backend != SessionBackend::Native {
        tracing::debug!(
            host = %handshake.hostname,
            protocol = %handshake.protocol,
            reason = decision.reason,
            "routing session to guacd"
        );
        return None;
    }

    if let Err(reason) = preflight(protocol, handshake) {
        tracing::warn!(
            host = %handshake.hostname,
            protocol = %handshake.protocol,
            %reason,
            "session selected for the native engine but cannot run there — \
             falling back to guacd"
        );
        return None;
    }

    tracing::info!(
        host = %handshake.hostname,
        protocol = %handshake.protocol,
        reason = decision.reason,
        "routing session to the native engine"
    );
    Some(protocol)
}

/// Everything that must be true before a session can run natively.
fn preflight(protocol: Protocol, handshake: &HandshakeParams) -> Result<(), String> {
    if protocol != Protocol::Ssh {
        return Err(format!("no native engine for {}", protocol.as_str()));
    }
    if host_key_fingerprints(handshake).is_empty() {
        return Err(format!(
            "connection has no `{HOST_KEY_PARAM}` parameter, and the native SSH \
             engine will not connect to an unverified host"
        ));
    }
    TerminalFont::discover(DEFAULT_FONT_SIZE_PX).map_err(|e| e.to_string())?;
    Ok(())
}

fn host_key_fingerprints(handshake: &HandshakeParams) -> Vec<String> {
    handshake
        .extra
        .get(HOST_KEY_PARAM)
        .map(|raw| {
            raw.split(',')
                .map(|f| f.trim().to_owned())
                .filter(|f| !f.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Serve one session with the native engine.
pub async fn run_native(
    ws: WebSocket,
    handshake: HandshakeParams,
    protocol: Protocol,
    session_id: String,
) -> Result<(), AppError> {
    let engine = connect_engine(protocol, &handshake).await?;

    let (handle, mut frames) = SessionActor::spawn(SessionConfig {
        id: session_id,
        engine,
        encoder: Box::new(GuacWireEncoder::new()),
        audit: Box::new(NullAuditSink),
        moderator: None,
        credential: None,
    });

    let (mut sink, mut stream) = ws.split();
    let mut decoder = GuacDecoder::default();

    let reason = loop {
        tokio::select! {
            frame = frames.recv() => {
                let Some(frame) = frame else {
                    break "session ended";
                };
                let message = match frame {
                    ClientFrame::Text(bytes) => match String::from_utf8(bytes.to_vec()) {
                        Ok(text) => Message::Text(text.into()),
                        Err(_) => break "engine emitted invalid utf-8",
                    },
                    ClientFrame::Binary(bytes) => Message::Binary(bytes),
                };
                if sink.send(message).await.is_err() {
                    break "client socket closed";
                }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        decoder.extend(text.as_bytes());
                        if let Err(why) = forward_instructions(&mut decoder, &handle).await {
                            break why;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        break "client closed the socket";
                    }
                    Some(Err(err)) => {
                        tracing::debug!(error = %err, "client websocket error");
                        break "client socket error";
                    }
                    // Pings, pongs and stray binary frames carry nothing
                    // the Guacamole protocol needs.
                    Some(Ok(_)) => {}
                }
            }
        }
    };

    let _ = handle.terminate(reason).await;
    let _ = sink.close().await;
    Ok(())
}

/// Drain every complete instruction the decoder holds into the session.
///
/// Returns why the session must end, if it must. Malformed input is
/// terminal: a desynchronised Guacamole stream cannot be resynchronised,
/// and continuing would feed the target attacker-chosen fragments.
async fn forward_instructions(
    decoder: &mut GuacDecoder,
    handle: &SessionHandle,
) -> Result<(), &'static str> {
    loop {
        match decoder.next_instruction() {
            Ok(Some(instruction)) => handle
                .send(instruction)
                .await
                .map_err(|_| "session ended")?,
            Ok(None) => return Ok(()),
            Err(err) => {
                tracing::warn!(error = %err, "client sent malformed guacamole input");
                return Err("malformed client input");
            }
        }
    }
}

async fn connect_engine(
    protocol: Protocol,
    handshake: &HandshakeParams,
) -> Result<Box<dyn ProtocolEngine>, AppError> {
    if protocol != Protocol::Ssh {
        return Err(AppError::Internal(format!(
            "no native engine for {}",
            protocol.as_str()
        )));
    }

    let spec = TargetSpec {
        protocol,
        hostname: handshake.hostname.clone(),
        port: handshake.port,
        username: handshake.username.clone().unwrap_or_default(),
        secret: SecretString::from(handshake.password.clone().unwrap_or_default()),
        width: handshake.width,
        height: handshake.height,
    };

    let factory = SshEngineFactory::new(SshConfig::with_fingerprints(host_key_fingerprints(
        handshake,
    )));
    let engine = factory
        .connect(spec)
        .await
        .map_err(|e| AppError::Internal(format!("native ssh connect: {e}")))?;

    let font = TerminalFont::discover(DEFAULT_FONT_SIZE_PX)
        .map_err(|e| AppError::Internal(format!("terminal font: {e}")))?;

    Ok(Box::new(RasterisingEngine::new(
        engine,
        font,
        handshake.width,
        handshake.height,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handshake(protocol: &str, fingerprint: Option<&str>) -> HandshakeParams {
        let mut extra = std::collections::HashMap::new();
        if let Some(fp) = fingerprint {
            extra.insert(HOST_KEY_PARAM.to_owned(), fp.to_owned());
        }
        HandshakeParams {
            protocol: protocol.to_owned(),
            hostname: "host.internal".to_owned(),
            port: 22,
            username: Some("svc".to_owned()),
            password: Some("secret".to_owned()),
            domain: None,
            security: None,
            ignore_cert: false,
            recording_path: None,
            recording_name: None,
            create_recording_path: false,
            width: 1024,
            height: 768,
            dpi: 96,
            extra,
        }
    }

    #[test]
    fn protocol_names_map_to_engine_protocols() {
        assert_eq!(protocol_from_str("ssh"), Some(Protocol::Ssh));
        assert_eq!(protocol_from_str("RDP"), Some(Protocol::Rdp));
        assert_eq!(protocol_from_str(" vnc "), Some(Protocol::Vnc));
        assert_eq!(protocol_from_str("kubernetes"), Some(Protocol::KubeExec));
        assert_eq!(protocol_from_str("telnet"), None);
    }

    #[test]
    fn a_session_without_a_pinned_host_key_is_not_run_natively() {
        let err = preflight(Protocol::Ssh, &handshake("ssh", None)).unwrap_err();
        assert!(err.contains(HOST_KEY_PARAM));
    }

    #[test]
    fn fingerprints_are_split_and_trimmed() {
        let params = handshake("ssh", Some(" SHA256:aaa , SHA256:bbb ,"));
        assert_eq!(
            host_key_fingerprints(&params),
            vec!["SHA256:aaa".to_owned(), "SHA256:bbb".to_owned()]
        );
    }

    #[test]
    fn protocols_without_an_engine_fail_preflight() {
        let err = preflight(Protocol::Rdp, &handshake("rdp", Some("SHA256:aaa"))).unwrap_err();
        assert!(err.contains("rdp"));
    }
}
