//! SSH protocol engine built on [`russh`].
//!
//! Replaces `libguac-client-ssh`, which drove `libssh2` through polling
//! wrappers because `libssh2` has no async story. `russh` is Tokio-native,
//! so the engine is an ordinary async state machine with no bridging
//! threads and no unmanaged C.
//!
//! Terminal *state* is deliberately not tracked here. In Native Direct
//! Streaming Mode the PTY byte stream goes straight to `xterm.js`, which
//! is a far better terminal emulator than anything we would write on the
//! server. Guacamole Wire Compatibility Mode needs a server-side
//! rasteriser; that lands separately and will consume the same
//! [`TargetEvent::TerminalOutput`] stream.

pub mod keymap;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use russh::client::{self, Handle, Msg};
use russh::keys::{HashAlg, PublicKeyOrCertificate};
use russh::{Channel, ChannelMsg, Disconnect};
use secrecy::ExposeSecret;
use tokio::sync::Mutex;

use crate::engine::ssh::keymap::{keysym_to_bytes, Modifiers};
use crate::engine::{EngineFactory, InputEvent, Protocol, ProtocolEngine, TargetEvent, TargetSpec};
use crate::error::EngineError;

/// How the engine decides whether a host key is acceptable.
#[derive(Debug, Clone)]
pub enum HostKeyPolicy {
    /// Accept only these SHA-256 fingerprints, in OpenSSH's
    /// `SHA256:base64` rendering.
    ///
    /// An empty list rejects every host. That is deliberate: there is no
    /// "accept anything" variant, because an SSH gateway that skips host
    /// key verification is a man-in-the-middle waiting to happen, and
    /// this engine exists partly to close gaps like that one.
    Fingerprints(Vec<String>),
}

impl HostKeyPolicy {
    fn accepts(&self, fingerprint: &str) -> bool {
        let Self::Fingerprints(allowed) = self;
        allowed.iter().any(|f| f == fingerprint)
    }
}

/// Character cell dimensions, used to convert the client's pixel
/// geometry into the rows and columns a PTY wants.
#[derive(Debug, Clone, Copy)]
pub struct CellSize {
    /// Cell width in pixels.
    pub width: u32,
    /// Cell height in pixels.
    pub height: u32,
}

impl Default for CellSize {
    fn default() -> Self {
        Self {
            width: 8,
            height: 16,
        }
    }
}

impl CellSize {
    /// Convert a pixel geometry to `(columns, rows)`, never returning
    /// zero in either axis.
    #[must_use]
    pub fn to_grid(self, width_px: u32, height_px: u32) -> (u32, u32) {
        let cols = width_px / self.width.max(1);
        let rows = height_px / self.height.max(1);
        (cols.max(1), rows.max(1))
    }
}

/// Engine-wide SSH settings.
#[derive(Debug, Clone)]
pub struct SshConfig {
    /// Host key admission policy.
    pub host_keys: HostKeyPolicy,
    /// `TERM` value announced to the remote shell.
    pub term: String,
    /// Cell geometry for pixel-to-grid conversion.
    pub cell: CellSize,
    /// Idle interval before a keepalive is sent.
    pub keepalive: Duration,
    /// Connection is dropped after this much inactivity.
    pub inactivity_timeout: Duration,
}

impl SshConfig {
    /// Config accepting exactly the supplied fingerprints.
    #[must_use]
    pub fn with_fingerprints(fingerprints: Vec<String>) -> Self {
        Self {
            host_keys: HostKeyPolicy::Fingerprints(fingerprints),
            term: "xterm-256color".to_owned(),
            cell: CellSize::default(),
            keepalive: Duration::from_secs(30),
            inactivity_timeout: Duration::from_secs(3600),
        }
    }
}

/// Verifies the target's host key against the configured policy.
struct HostKeyChecker {
    policy: HostKeyPolicy,
}

impl client::Handler for HostKeyChecker {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => {
                key.fingerprint(HashAlg::Sha256).to_string()
            }
            PublicKeyOrCertificate::Certificate(cert) => {
                cert.public_key().fingerprint(HashAlg::Sha256).to_string()
            }
        };

        if self.policy.accepts(&fingerprint) {
            tracing::debug!(%fingerprint, "host key accepted");
            return Ok(true);
        }
        tracing::warn!(%fingerprint, "rejecting unknown host key");
        Ok(false)
    }
}

/// A host key observed on a server, before anyone has decided to trust it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredHostKey {
    /// Key algorithm, as OpenSSH names it, e.g. `ssh-ed25519`.
    pub algorithm: String,
    /// `SHA256:…`, in the form `ssh-keygen -lf` prints.
    pub fingerprint: String,
    /// The `<algorithm> <base64>` line, suitable for a known-hosts entry.
    pub public_key: String,
}

/// Records the key a server presents instead of judging it.
struct HostKeyRecorder {
    seen: Arc<Mutex<Option<DiscoveredHostKey>>>,
}

impl client::Handler for HostKeyRecorder {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => cert.public_key().clone().into(),
        };
        *self.seen.lock().await = Some(DiscoveredHostKey {
            algorithm: key.algorithm().to_string(),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
            public_key: key.to_openssh().unwrap_or_default(),
        });
        // Refuse regardless. Discovery must never leave a usable session
        // behind, and nothing here has authenticated anything.
        Ok(false)
    }
}

/// Observe the host key a server presents, without trusting or using it.
///
/// Finding a fingerprint by hand does not scale past a handful of hosts,
/// which is how a gateway ends up with host checking switched off
/// everywhere. This returns what the server offered so an operator can
/// approve it, and deliberately returns rather than stores: a key that
/// arrives over the same unverified channel it is meant to protect is
/// evidence, not proof.
///
/// Only the key that negotiation actually selects is returned, which is
/// the one a session would go on to use.
pub async fn discover_host_key(
    hostname: &str,
    port: u16,
    timeout: Duration,
) -> Result<DiscoveredHostKey, EngineError> {
    let client_config = Arc::new(client::Config {
        nodelay: true,
        ..client::Config::default()
    });
    let seen = Arc::new(Mutex::new(None));
    let handler = HostKeyRecorder {
        seen: Arc::clone(&seen),
    };

    // The connect is expected to fail: the handler rejects every key. The
    // key is read from `seen` either way.
    let _ = tokio::time::timeout(
        timeout,
        client::connect(client_config, (hostname, port), handler),
    )
    .await
    .map_err(|_| {
        EngineError::Protocol(format!("timed out reading the host key from {hostname}"))
    })?;

    let discovered = seen.lock().await.clone();
    discovered.ok_or_else(|| EngineError::Protocol(format!("{hostname} offered no host key")))
}

/// A live SSH session with an interactive shell on a PTY.
pub struct SshEngine {
    session: Handle<HostKeyChecker>,
    channel: Channel<Msg>,
    config: Arc<SshConfig>,
    modifiers: Modifiers,
    cols: u32,
    rows: u32,
    exit_status: Option<u32>,
}

impl SshEngine {
    /// Connect, authenticate, and open an interactive shell.
    ///
    /// The credential is consumed here and dropped — and therefore
    /// zeroed — before the function returns, whether or not
    /// authentication succeeded.
    pub async fn connect(spec: TargetSpec, config: Arc<SshConfig>) -> Result<Self, EngineError> {
        let client_config = Arc::new(client::Config {
            keepalive_interval: Some(config.keepalive),
            inactivity_timeout: Some(config.inactivity_timeout),
            nodelay: true,
            ..client::Config::default()
        });

        let handler = HostKeyChecker {
            policy: config.host_keys.clone(),
        };

        let mut session =
            client::connect(client_config, (spec.hostname.as_str(), spec.port), handler)
                .await
                .map_err(map_russh)?;

        let TargetSpec {
            username,
            secret,
            width,
            height,
            ..
        } = spec;

        let outcome = session
            .authenticate_password(username, secret.expose_secret())
            .await;
        // Nothing below this line may observe the credential.
        drop(secret);

        match outcome.map_err(map_russh)? {
            russh::client::AuthResult::Success => {}
            russh::client::AuthResult::Failure { .. } => return Err(EngineError::AuthRejected),
        }

        let channel = session.channel_open_session().await.map_err(map_russh)?;
        let (cols, rows) = config.cell.to_grid(width, height);
        channel
            .request_pty(true, &config.term, cols, rows, width, height, &[])
            .await
            .map_err(map_russh)?;
        channel.request_shell(true).await.map_err(map_russh)?;

        Ok(Self {
            session,
            channel,
            config,
            modifiers: Modifiers::default(),
            cols,
            rows,
            exit_status: None,
        })
    }

    /// Exit status reported by the remote shell, once it has exited.
    #[must_use]
    pub fn exit_status(&self) -> Option<u32> {
        self.exit_status
    }

    async fn write(&mut self, data: impl Into<Bytes>) -> Result<(), EngineError> {
        self.channel.data_bytes(data).await.map_err(map_russh)
    }
}

#[async_trait]
impl ProtocolEngine for SshEngine {
    fn protocol(&self) -> Protocol {
        Protocol::Ssh
    }

    async fn handle_input(&mut self, input: InputEvent) -> Result<(), EngineError> {
        match input {
            InputEvent::Key { keysym, pressed } => {
                if self.modifiers.track(keysym, pressed) || !pressed {
                    return Ok(());
                }
                if let Some(bytes) = keysym_to_bytes(keysym, self.modifiers) {
                    self.write(bytes).await?;
                }
            }
            // A paste is just typed input as far as the PTY is concerned.
            InputEvent::Text(data) | InputEvent::Clipboard(data) => self.write(data).await?,
            InputEvent::Resize { width, height } => {
                let (cols, rows) = self.config.cell.to_grid(width, height);
                if (cols, rows) != (self.cols, self.rows) {
                    self.channel
                        .window_change(cols, rows, width, height)
                        .await
                        .map_err(map_russh)?;
                    self.cols = cols;
                    self.rows = rows;
                }
            }
            InputEvent::Disconnect => {
                self.channel.eof().await.map_err(map_russh)?;
            }
            // A PTY without mouse reporting has nothing to do with this.
            InputEvent::Mouse { .. } => {}
        }
        Ok(())
    }

    async fn next_event(&mut self) -> Result<Option<TargetEvent>, EngineError> {
        loop {
            // `Channel::wait` is an mpsc receive, so dropping this future
            // inside the actor's `select!` loses nothing.
            match self.channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    return Ok(Some(TargetEvent::TerminalOutput(data)));
                }
                // stderr on an interactive shell belongs on screen too.
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    return Ok(Some(TargetEvent::TerminalOutput(data)));
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    self.exit_status = Some(exit_status);
                }
                Some(ChannelMsg::ExitSignal {
                    signal_name,
                    error_message,
                    ..
                }) => {
                    return Ok(Some(TargetEvent::Disconnected {
                        reason: format!("remote shell killed by {signal_name:?}: {error_message}"),
                    }));
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                    let reason = match self.exit_status {
                        Some(0) | None => "remote shell exited".to_owned(),
                        Some(status) => format!("remote shell exited with status {status}"),
                    };
                    return Ok(Some(TargetEvent::Disconnected { reason }));
                }
                // Flow control and request acknowledgements carry no
                // user-visible payload.
                Some(_) => {}
            }
        }
    }

    async fn shutdown(&mut self) -> Result<(), EngineError> {
        // Best effort: a target that has already vanished must not stop
        // the session tearing down cleanly.
        if let Err(err) = self.channel.close().await {
            tracing::debug!(error = %err, "ssh channel close failed");
        }
        if let Err(err) = self
            .session
            .disconnect(Disconnect::ByApplication, "session ended", "en")
            .await
        {
            tracing::debug!(error = %err, "ssh disconnect failed");
        }
        Ok(())
    }
}

/// Builds [`SshEngine`]s from a shared configuration.
pub struct SshEngineFactory {
    config: Arc<SshConfig>,
}

impl SshEngineFactory {
    /// Create a factory.
    #[must_use]
    pub fn new(config: SshConfig) -> Self {
        Self {
            config: Arc::new(config),
        }
    }
}

#[async_trait]
impl EngineFactory for SshEngineFactory {
    async fn connect(&self, spec: TargetSpec) -> Result<Box<dyn ProtocolEngine>, EngineError> {
        if spec.protocol != Protocol::Ssh {
            return Err(EngineError::Unsupported(spec.protocol.as_str()));
        }
        let engine = SshEngine::connect(spec, Arc::clone(&self.config)).await?;
        Ok(Box::new(engine))
    }
}

fn map_russh(err: russh::Error) -> EngineError {
    match err {
        russh::Error::IO(io) => EngineError::Transport(io),
        russh::Error::NotAuthenticated | russh::Error::NoAuthMethod => EngineError::AuthRejected,
        russh::Error::Disconnect => EngineError::Closed("peer disconnected".to_owned()),
        // A rejected host key surfaces as a KEX failure; name it, because
        // "key exchange failed" sends operators down the wrong path.
        russh::Error::UnknownKey => {
            EngineError::Protocol("host key not in the configured allow-list".to_owned())
        }
        other => EngineError::Protocol(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pixel_geometry_converts_to_a_sane_grid() {
        let cell = CellSize {
            width: 8,
            height: 16,
        };
        assert_eq!(cell.to_grid(1920, 1080), (240, 67));
        assert_eq!(cell.to_grid(640, 480), (80, 30));
    }

    #[test]
    fn a_collapsed_window_still_yields_a_usable_grid() {
        // A hidden or zero-height client must not request a 0x0 PTY:
        // some daemons reject it and others divide by zero.
        let cell = CellSize::default();
        assert_eq!(cell.to_grid(0, 0), (1, 1));
        assert_eq!(cell.to_grid(4, 4), (1, 1));
    }

    #[test]
    fn host_key_policy_is_deny_by_default() {
        let empty = HostKeyPolicy::Fingerprints(vec![]);
        assert!(!empty.accepts("SHA256:anything"));

        let allowed = HostKeyPolicy::Fingerprints(vec!["SHA256:abc".to_owned()]);
        assert!(allowed.accepts("SHA256:abc"));
        assert!(!allowed.accepts("SHA256:abd"));
        assert!(!allowed.accepts(""));
    }

    #[tokio::test]
    async fn the_factory_refuses_protocols_it_does_not_speak() {
        use secrecy::SecretString;

        let factory = SshEngineFactory::new(SshConfig::with_fingerprints(vec![]));
        let spec = TargetSpec {
            protocol: Protocol::Rdp,
            hostname: "host.internal".to_owned(),
            port: 3389,
            username: "admin".to_owned(),
            secret: SecretString::from("secret"),
            width: 1024,
            height: 768,
        };
        assert!(matches!(
            factory.connect(spec).await,
            Err(EngineError::Unsupported("rdp"))
        ));
    }
}
