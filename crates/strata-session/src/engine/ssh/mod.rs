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

pub use crate::engine::keymap;

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use russh::client::{self, Handle, KeyboardInteractiveAuthResponse, Msg};
use russh::keys::{HashAlg, PublicKeyOrCertificate};
use russh::{Channel, ChannelMsg, Disconnect};
use secrecy::{ExposeSecret, SecretString};
use tokio::sync::{mpsc, Mutex};

use crate::engine::keymap::{keysym_to_bytes_with, Backspace, CellSize, Modifiers};
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
    /// Whether this policy would admit no host at all.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        let Self::Fingerprints(allowed) = self;
        allowed.is_empty()
    }

    fn accepts(&self, fingerprint: &str) -> bool {
        let Self::Fingerprints(allowed) = self;
        allowed.iter().any(|f| f == fingerprint)
    }
}

/// Engine-wide SSH settings.
#[derive(Clone)]
pub struct SshConfig {
    /// Host key admission policy.
    pub host_keys: HostKeyPolicy,
    /// `TERM` value announced to the remote shell.
    pub term: String,
    /// What the BackSpace key sends, from `backspace`.
    pub backspace: Backspace,
    /// Command to run instead of an interactive shell.
    pub command: Option<String>,
    /// Value for `TZ` on the channel, so timestamps match the operator
    /// rather than the gateway.
    pub timezone: Option<String>,
    /// Cell geometry for pixel-to-grid conversion.
    pub cell: CellSize,
    /// Idle interval before a keepalive is sent.
    pub keepalive: Duration,
    /// Connection is dropped after this much inactivity.
    pub inactivity_timeout: Duration,
    /// Private key for public-key authentication, in OpenSSH or PuTTY
    /// format, as guacd's `private-key` parameter holds it.
    pub private_key: Option<SecretString>,
    /// Passphrase decrypting [`Self::private_key`], if it is encrypted.
    pub passphrase: Option<SecretString>,
}

impl fmt::Debug for SshConfig {
    /// Hand-written so a config can be logged without the key in it.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SshConfig")
            .field("host_keys", &self.host_keys)
            .field("term", &self.term)
            .field("cell", &self.cell)
            .field("keepalive", &self.keepalive)
            .field("inactivity_timeout", &self.inactivity_timeout)
            .field(
                "private_key",
                &self.private_key.as_ref().map(|_| "<redacted>"),
            )
            .field(
                "passphrase",
                &self.passphrase.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

impl SshConfig {
    /// Config accepting exactly the supplied fingerprints.
    #[must_use]
    pub fn with_fingerprints(fingerprints: Vec<String>) -> Self {
        Self {
            host_keys: HostKeyPolicy::Fingerprints(fingerprints),
            term: "xterm-256color".to_owned(),
            backspace: Backspace::default(),
            command: None,
            timezone: None,
            cell: CellSize::default(),
            keepalive: Duration::from_secs(30),
            inactivity_timeout: Duration::from_secs(3600),
            private_key: None,
            passphrase: None,
        }
    }

    /// Attach a private key for public-key authentication.
    #[must_use]
    pub fn with_private_key(
        mut self,
        key: Option<SecretString>,
        passphrase: Option<SecretString>,
    ) -> Self {
        self.private_key = key;
        self.passphrase = passphrase;
        self
    }

    /// Apply the terminal settings a connection asked for.
    #[must_use]
    pub fn with_terminal(mut self, term: Option<String>, timezone: Option<String>) -> Self {
        if let Some(term) = term.filter(|t| !t.trim().is_empty()) {
            self.term = term;
        }
        self.timezone = timezone.filter(|t| !t.trim().is_empty());
        self
    }

    /// What the BackSpace key sends.
    #[must_use]
    pub fn with_backspace(mut self, backspace: Backspace) -> Self {
        self.backspace = backspace;
        self
    }

    /// Run `command` instead of an interactive shell.
    #[must_use]
    pub fn with_command(mut self, command: Option<String>) -> Self {
        self.command = command.filter(|c| !c.trim().is_empty());
        self
    }

    /// Cell geometry used to turn the client's pixel size into a PTY
    /// grid. Must match the renderer's font metrics in Wire
    /// Compatibility Mode, or the shell draws to a grid of a different
    /// shape than the one on screen.
    #[must_use]
    pub fn with_cell_size(mut self, cell: CellSize) -> Self {
        self.cell = cell;
        self
    }
}

/// Verifies the target's host key against the configured policy.
pub(crate) struct HostKeyChecker {
    pub(crate) policy: HostKeyPolicy,
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

/// Which credential the login prompt is still waiting for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Awaiting {
    Username,
    Password,
}

/// How many times a login may be retried before the session gives up.
///
/// Matches what a stock sshd allows, so a typo costs a retry rather than
/// the whole session.
const MAX_LOGIN_ATTEMPTS: u8 = 3;

/// What feeding one byte to the login prompt produced.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Typed {
    /// Nothing the client needs to see.
    Ignored,
    /// Write this to the terminal.
    Echo(String),
    /// The username is in; ask for the password.
    NeedPassword,
    /// Both halves are collected; try them.
    Ready,
    /// The user abandoned the attempt; ask again from the top.
    Restarted,
}

/// An interactive login for a connection that stores no credential.
///
/// guacd prompts in the terminal when a username or password is missing,
/// and connections are routinely configured that way rather than with
/// stored credentials. Without this the engine authenticates with empty
/// strings and the target rejects it.
struct Login {
    username: Option<String>,
    /// Held only until it is handed to the server, and never logged.
    password: Option<String>,
    awaiting: Awaiting,
    typed: String,
    attempts: u8,
}

impl Login {
    /// Advance the prompt by one typed byte.
    ///
    /// Kept free of I/O so the echo rules — in particular that a password
    /// is never echoed — can be asserted directly.
    fn feed(&mut self, byte: u8) -> Typed {
        match byte {
            b'\r' | b'\n' => {
                let value = std::mem::take(&mut self.typed);
                match self.awaiting {
                    // An empty username would be rejected anyway; ask
                    // again rather than spend one of the attempts.
                    Awaiting::Username if value.is_empty() => Typed::Restarted,
                    Awaiting::Username => {
                        self.username = Some(value);
                        self.awaiting = Awaiting::Password;
                        Typed::NeedPassword
                    }
                    Awaiting::Password => {
                        self.password = Some(value);
                        self.attempts += 1;
                        Typed::Ready
                    }
                }
            }
            // Both DEL and BS arrive, depending on the client.
            0x7f | 0x08 => {
                let removed = self.typed.pop().is_some();
                // Only the username is echoed, so only it can be erased.
                if removed && self.awaiting == Awaiting::Username {
                    Typed::Echo("\u{8} \u{8}".to_owned())
                } else {
                    Typed::Ignored
                }
            }
            // Ctrl+C abandons the login, not the connection.
            0x03 => {
                self.typed.clear();
                self.username = None;
                self.password = None;
                self.awaiting = Awaiting::Username;
                Typed::Restarted
            }
            // Other control characters mean nothing at a prompt.
            0x00..=0x1f => Typed::Ignored,
            printable => {
                self.typed.push(printable as char);
                if self.awaiting == Awaiting::Username {
                    Typed::Echo((printable as char).to_string())
                } else {
                    Typed::Ignored
                }
            }
        }
    }
}

/// What the engine is currently doing.
enum Stage {
    /// Collecting credentials; no channel exists yet.
    Login(Login),
    /// Authenticated, with an interactive shell on a PTY.
    Shell(Channel<Msg>),
}

/// A live SSH session with an interactive shell on a PTY.
pub struct SshEngine {
    session: Handle<HostKeyChecker>,
    stage: Stage,
    config: Arc<SshConfig>,
    modifiers: Modifiers,
    cols: u32,
    rows: u32,
    /// Kept so a PTY can be sized once login completes.
    width: u32,
    height: u32,
    exit_status: Option<u32>,
    /// What the client last put on its clipboard.
    ///
    /// Held rather than typed. The client pushes this on focus and on
    /// mouseover, not only on paste, so writing it straight to the PTY
    /// meant merely entering the terminal typed the operator's clipboard
    /// into it — and executed it, if it happened to end in a newline.
    clipboard: Bytes,
    /// Buttons held at the last mouse event, to spot a release.
    mouse_mask: u8,
    /// Terminal output produced before a channel exists.
    ///
    /// An mpsc rather than a queue because `next_event` is dropped by the
    /// actor's `select!` whenever client input arrives, and `recv` is
    /// cancellation-safe where re-polling a bare queue would need a
    /// wakeup primitive that is not.
    prompt_tx: mpsc::UnboundedSender<TargetEvent>,
    prompt_rx: mpsc::UnboundedReceiver<TargetEvent>,
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

        let session = client::connect(
            client_config,
            (spec.dial_host().as_str(), spec.port),
            handler,
        )
        .await
        .map_err(map_russh)?;

        let TargetSpec {
            username,
            secret,
            width,
            height,
            ..
        } = spec;

        let (prompt_tx, prompt_rx) = mpsc::unbounded_channel();
        let (cols, rows) = config.cell.to_grid(width, height);
        let mut engine = Self {
            session,
            // Replaced by `Stage::Shell` the moment authentication lands.
            stage: Stage::Login(Login {
                username: None,
                password: None,
                awaiting: Awaiting::Username,
                typed: String::new(),
                attempts: 0,
            }),
            config,
            modifiers: Modifiers::default(),
            cols,
            rows,
            width,
            height,
            exit_status: None,
            clipboard: Bytes::new(),
            mouse_mask: 0,
            prompt_tx,
            prompt_rx,
        };

        let password = secret.expose_secret().to_owned();
        // Nothing below this line may observe the original credential.
        drop(secret);

        // A key beats a password when both are configured, matching the
        // order OpenSSH tries them in.
        if engine.config.private_key.is_some() && !username.is_empty() {
            match engine.try_public_key(&username).await {
                Ok(true) => {
                    engine.open_shell().await?;
                    return Ok(engine);
                }
                Ok(false) => {
                    // Fall through to a password, again as OpenSSH does,
                    // rather than failing a session whose key merely is
                    // not installed on this host yet.
                    tracing::info!("ssh public key rejected; falling back to password");
                }
                Err(err) => {
                    // A key that will not parse is a configuration error
                    // and silently becoming a password prompt would hide it.
                    return Err(err);
                }
            }
        }

        if username.is_empty() || password.is_empty() {
            // Anything the connection did supply is kept, so only the
            // missing half is asked for.
            let Stage::Login(login) = &mut engine.stage else {
                unreachable!("just constructed as Login")
            };
            if !username.is_empty() {
                login.username = Some(username);
                login.awaiting = Awaiting::Password;
            }
            if !password.is_empty() {
                login.password = Some(password);
            }
            engine.show_prompt();
            return Ok(engine);
        }

        if !engine.try_password(&username, &password).await? {
            return Err(EngineError::AuthRejected);
        }
        engine.open_shell().await?;
        Ok(engine)
    }

    /// Try a password, over keyboard-interactive if that is all the
    /// target offers.
    ///
    /// A PAM-configured host commonly advertises only
    /// keyboard-interactive, and answering its single hidden prompt with
    /// the password is what every other client does. Without this such a
    /// host rejects a correct password with no way to tell why.
    async fn try_password(&mut self, username: &str, password: &str) -> Result<bool, EngineError> {
        let outcome = self
            .session
            .authenticate_password(username, password)
            .await
            .map_err(map_russh)?;
        if matches!(outcome, russh::client::AuthResult::Success) {
            return Ok(true);
        }

        let mut response = self
            .session
            .authenticate_keyboard_interactive_start(username.to_owned(), None)
            .await
            .map_err(map_russh)?;
        loop {
            match response {
                KeyboardInteractiveAuthResponse::Success => return Ok(true),
                KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
                KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                    let answers = match prompts.as_slice() {
                        // Some servers send an empty round purely to
                        // display a banner.
                        [] => Vec::new(),
                        [only] if !only.echo => vec![password.to_owned()],
                        // More than one prompt, or one the user is meant
                        // to see, means the host wants something other
                        // than the password — a one-time code, most
                        // likely. Sending the password would answer the
                        // wrong question and put it somewhere it does not
                        // belong.
                        other => {
                            tracing::info!(
                                prompts = other.len(),
                                "target asked for something other than a password; \
                                 keyboard-interactive not attempted"
                            );
                            return Ok(false);
                        }
                    };
                    response = self
                        .session
                        .authenticate_keyboard_interactive_respond(answers)
                        .await
                        .map_err(map_russh)?;
                }
            }
        }
    }

    /// Offer the configured private key.
    ///
    /// `Ok(false)` means the server declined the key, which is recoverable
    /// by trying a password. An error means the key itself is unusable,
    /// which is not.
    async fn try_public_key(&mut self, username: &str) -> Result<bool, EngineError> {
        let Some(key) = self.config.private_key.as_ref() else {
            return Ok(false);
        };
        let passphrase = self
            .config
            .passphrase
            .as_ref()
            .map(ExposeSecret::expose_secret);
        let decoded =
            russh::keys::decode_secret_key(key.expose_secret(), passphrase).map_err(|err| {
                // The message names the failure but never the key.
                EngineError::Protocol(format!(
                    "the configured private key could not be read: {err}"
                ))
            })?;

        let outcome = self
            .session
            .authenticate_publickey(
                username,
                // RSA keys are signed SHA-256; anything else ignores this.
                russh::keys::PrivateKeyWithHashAlg::new(
                    std::sync::Arc::new(decoded),
                    Some(russh::keys::HashAlg::Sha256),
                ),
            )
            .await
            .map_err(map_russh)?;
        Ok(matches!(outcome, russh::client::AuthResult::Success))
    }

    /// Queue terminal output for the client while there is no channel.
    fn emit(&self, text: &str) {
        let _ = self
            .prompt_tx
            .send(TargetEvent::TerminalOutput(Bytes::from(text.to_owned())));
    }

    /// Write whichever prompt the login is waiting on.
    fn show_prompt(&self) {
        let Stage::Login(login) = &self.stage else {
            return;
        };
        match login.awaiting {
            Awaiting::Username => self.emit("Login as: "),
            Awaiting::Password => self.emit("Password: "),
        }
    }

    /// Open the PTY and shell once authentication has succeeded.
    async fn open_shell(&mut self) -> Result<(), EngineError> {
        let channel = self
            .session
            .channel_open_session()
            .await
            .map_err(map_russh)?;

        // Sent without waiting for a reply: a server with a restrictive
        // AcceptEnv refuses it, and losing the session over a clock
        // preference would be a poor trade.
        if let Some(tz) = &self.config.timezone {
            if let Err(err) = channel.set_env(false, "TZ", tz.clone()).await {
                tracing::debug!(error = %err, "target would not accept TZ");
            }
        }

        let (cols, rows) = self.config.cell.to_grid(self.width, self.height);
        channel
            .request_pty(
                true,
                &self.config.term,
                cols,
                rows,
                self.width,
                self.height,
                &[],
            )
            .await
            .map_err(map_russh)?;
        // guacd's `command` parameter: run this instead of a login shell.
        // Still on a PTY, so a command that draws a full-screen interface
        // behaves the way it would for the operator running it directly.
        match &self.config.command {
            Some(command) => channel.exec(true, command.as_bytes()).await,
            None => channel.request_shell(true).await,
        }
        .map_err(map_russh)?;
        self.cols = cols;
        self.rows = rows;
        self.stage = Stage::Shell(channel);
        Ok(())
    }

    /// Feed typed bytes into the login prompt.
    ///
    /// Returns an error only when the session cannot continue; a rejected
    /// password re-prompts instead, because losing the whole session to a
    /// typo is not how any other SSH client behaves.
    async fn type_into_login(&mut self, bytes: &[u8]) -> Result<(), EngineError> {
        for &byte in bytes {
            let Stage::Login(login) = &mut self.stage else {
                return Ok(());
            };
            match login.feed(byte) {
                Typed::Ignored => {}
                Typed::Echo(text) => self.emit(&text),
                Typed::Restarted => {
                    self.emit("\r\n");
                    self.show_prompt();
                }
                Typed::NeedPassword => {
                    self.emit("\r\n");
                    self.show_prompt();
                }
                Typed::Ready => {
                    self.emit("\r\n");
                    self.attempt_login().await?;
                    if matches!(self.stage, Stage::Shell(_)) {
                        return Ok(());
                    }
                }
            }
        }
        Ok(())
    }

    /// Try the collected credentials, re-prompting on rejection.
    async fn attempt_login(&mut self) -> Result<(), EngineError> {
        let Stage::Login(login) = &mut self.stage else {
            return Ok(());
        };
        let username = login.username.clone().unwrap_or_default();
        let password = login.password.take().unwrap_or_default();
        let attempts = login.attempts;

        let accepted = self.try_password(&username, &password).await?;

        if accepted {
            return self.open_shell().await;
        }
        if attempts < MAX_LOGIN_ATTEMPTS {
            let Stage::Login(login) = &mut self.stage else {
                return Ok(());
            };
            // Start again from the username: the wrong one is as likely
            // as the wrong password, and the user cannot tell which the
            // server objected to.
            login.username = None;
            login.awaiting = Awaiting::Username;
            self.emit("Permission denied, please try again.\r\n");
            self.show_prompt();
            return Ok(());
        }
        Err(EngineError::AuthRejected)
    }

    /// Exit status reported by the remote shell, once it has exited.
    #[must_use]
    pub fn exit_status(&self) -> Option<u32> {
        self.exit_status
    }

    /// Send whatever the client last put on its clipboard.
    ///
    /// Only ever reached from a deliberate paste gesture, never from the
    /// clipboard arriving.
    async fn paste(&mut self) -> Result<(), EngineError> {
        if self.clipboard.is_empty() {
            return Ok(());
        }
        let data = self.clipboard.clone();
        self.write(data).await
    }

    async fn write(&mut self, data: impl Into<Bytes>) -> Result<(), EngineError> {
        let bytes: Bytes = data.into();
        match &mut self.stage {
            Stage::Shell(channel) => channel.data_bytes(bytes).await.map_err(map_russh),
            // Before authentication the same keystrokes drive the prompt.
            Stage::Login(_) => self.type_into_login(&bytes.clone()).await,
        }
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
                // Ctrl+Shift+V and Cmd+V paste, as they do in guacd's
                // terminal and in every other terminal emulator.
                if (keysym == u32::from(b'V') && self.modifiers.ctrl)
                    || (keysym == u32::from(b'v') && self.modifiers.alt)
                {
                    return self.paste().await;
                }
                if let Some(bytes) =
                    keysym_to_bytes_with(keysym, self.modifiers, self.config.backspace)
                {
                    self.write(bytes).await?;
                }
            }
            // Raw PTY bytes, which is a real keystroke rather than a
            // clipboard announcement.
            InputEvent::Text(data) => self.write(data).await?,
            // Only a note of what the client holds. The client sends this
            // on focus and mouseover as well as on paste, so acting on it
            // would type the operator's clipboard into the session.
            InputEvent::Clipboard(data) => self.clipboard = data,
            InputEvent::Resize { width, height } => {
                self.width = width;
                self.height = height;
                let (cols, rows) = self.config.cell.to_grid(width, height);
                if (cols, rows) != (self.cols, self.rows) {
                    if let Stage::Shell(channel) = &mut self.stage {
                        channel
                            .window_change(cols, rows, width, height)
                            .await
                            .map_err(map_russh)?;
                    }
                    self.cols = cols;
                    self.rows = rows;
                }
            }
            // Handled by the SFTP decorator, which sits above this engine.
            InputEvent::File(_) => {}
            InputEvent::Disconnect => {
                if let Stage::Shell(channel) = &mut self.stage {
                    channel.eof().await.map_err(map_russh)?;
                }
            }
            // A PTY has no mouse reporting, but a terminal still pastes
            // on middle or right click, which is how most people paste
            // into one.
            InputEvent::Mouse { mask, .. } => {
                const MIDDLE: u8 = 0x02;
                const RIGHT: u8 = 0x04;
                let released = self.mouse_mask & !mask;
                self.mouse_mask = mask;
                if released & (MIDDLE | RIGHT) != 0 {
                    self.paste().await?;
                }
            }
        }
        Ok(())
    }

    async fn next_event(&mut self) -> Result<Option<TargetEvent>, EngineError> {
        loop {
            // Anything the prompt produced outranks the channel, and while
            // logging in there is no channel to read from at all.
            if let Ok(event) = self.prompt_rx.try_recv() {
                return Ok(Some(event));
            }
            let channel = match &mut self.stage {
                Stage::Shell(channel) => channel,
                // `recv` is cancellation-safe, which matters because the
                // actor drops this future whenever client input arrives.
                Stage::Login(_) => return Ok(self.prompt_rx.recv().await),
            };

            // `Channel::wait` is an mpsc receive, so dropping this future
            // inside the actor's `select!` loses nothing.
            match channel.wait().await {
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
        if let Stage::Shell(channel) = &mut self.stage {
            if let Err(err) = channel.close().await {
                tracing::debug!(error = %err, "ssh channel close failed");
            }
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

pub(crate) fn map_russh(err: russh::Error) -> EngineError {
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

    fn login() -> Login {
        Login {
            username: None,
            password: None,
            awaiting: Awaiting::Username,
            typed: String::new(),
            attempts: 0,
        }
    }

    /// Type `text` and collect everything the prompt would echo.
    fn type_str(login: &mut Login, text: &str) -> String {
        let mut echoed = String::new();
        for byte in text.bytes() {
            if let Typed::Echo(s) = login.feed(byte) {
                echoed.push_str(&s);
            }
        }
        echoed
    }

    #[test]
    fn a_password_is_never_echoed() {
        // The whole point of the second prompt. An echo here would put
        // the credential on the screen, into any recording of it, and in
        // front of anyone observing the session.
        let mut login = login();
        type_str(&mut login, "alice");
        assert_eq!(login.feed(b'\r'), Typed::NeedPassword);

        let echoed = type_str(&mut login, "hunter2");
        assert_eq!(echoed, "", "the password must not reach the terminal");
        assert_eq!(login.feed(b'\r'), Typed::Ready);
        assert_eq!(login.username.as_deref(), Some("alice"));
        assert_eq!(login.password.as_deref(), Some("hunter2"));
    }

    #[test]
    fn a_username_is_echoed_so_it_can_be_read_back() {
        let mut login = login();
        assert_eq!(type_str(&mut login, "alice"), "alice");
    }

    #[test]
    fn backspace_erases_the_username_but_reveals_nothing_of_the_password() {
        let mut login = login();
        type_str(&mut login, "alicf");
        assert_eq!(login.feed(0x7f), Typed::Echo("\u{8} \u{8}".to_owned()));
        type_str(&mut login, "e");
        assert_eq!(login.feed(b'\r'), Typed::NeedPassword);
        assert_eq!(login.username.as_deref(), Some("alice"));

        type_str(&mut login, "pw");
        // Erasing a password character must not tell an onlooker its length.
        assert_eq!(login.feed(0x7f), Typed::Ignored);
        assert_eq!(login.feed(b'\r'), Typed::Ready);
        assert_eq!(login.password.as_deref(), Some("p"));
    }

    #[test]
    fn an_empty_username_asks_again_rather_than_spending_an_attempt() {
        // Sending an empty username to the server wastes one of the few
        // tries it allows before dropping the connection.
        let mut login = login();
        assert_eq!(login.feed(b'\r'), Typed::Restarted);
        assert_eq!(login.attempts, 0);
        assert!(login.username.is_none());
    }

    #[test]
    fn ctrl_c_abandons_the_credentials_rather_than_the_session() {
        let mut login = login();
        type_str(&mut login, "alice");
        login.feed(b'\r');
        type_str(&mut login, "secret");

        assert_eq!(login.feed(0x03), Typed::Restarted);
        assert!(
            login.username.is_none(),
            "a half-typed login must not persist"
        );
        assert!(login.password.is_none());
        assert_eq!(login.awaiting, Awaiting::Username);
        assert_eq!(login.typed, "");
    }

    #[test]
    fn each_completed_pair_counts_as_one_attempt() {
        // The count gates how many times a rejection re-prompts, so an
        // off-by-one here either locks a user out early or never stops.
        let mut login = login();
        for _ in 0..MAX_LOGIN_ATTEMPTS {
            type_str(&mut login, "alice");
            login.feed(b'\r');
            type_str(&mut login, "wrong");
            assert_eq!(login.feed(b'\r'), Typed::Ready);
            // What the engine does on rejection.
            login.username = None;
            login.awaiting = Awaiting::Username;
        }
        assert_eq!(login.attempts, MAX_LOGIN_ATTEMPTS);
    }

    #[test]
    fn control_characters_do_not_land_in_a_credential() {
        // Arrow keys and the like arrive as escape sequences; letting
        // them through would put invisible bytes in the password.
        let mut login = login();
        for byte in [0x1b, b'[', b'A'] {
            login.feed(byte);
        }
        // The escape byte is dropped; the printable remainder is not, which
        // is why an editing prompt is not what this is.
        assert_eq!(login.typed, "[A");
    }

    #[test]
    fn terminal_settings_a_connection_asks_for_are_carried() {
        let config = SshConfig::with_fingerprints(vec![])
            .with_terminal(Some("vt220".to_owned()), Some("Europe/London".to_owned()));
        assert_eq!(config.term, "vt220");
        assert_eq!(config.timezone.as_deref(), Some("Europe/London"));
    }

    #[test]
    fn a_blank_terminal_setting_leaves_the_default_alone() {
        // An empty string in the admin form means "unset", not "announce
        // an empty TERM", which some daemons refuse outright.
        let config = SshConfig::with_fingerprints(vec![])
            .with_terminal(Some("   ".to_owned()), Some(String::new()));
        assert_eq!(config.term, "xterm-256color");
        assert!(config.timezone.is_none());
    }

    #[test]
    fn a_private_key_never_appears_in_a_debug_dump() {
        // SshConfig is carried through the engine and is exactly the kind
        // of struct that ends up in a tracing field or a panic message.
        let config = SshConfig::with_fingerprints(vec!["SHA256:aaa".to_owned()]).with_private_key(
            Some(SecretString::from(
                "-----BEGIN OPENSSH PRIVATE KEY-----\nSUPERSECRET\n".to_owned(),
            )),
            Some(SecretString::from("hunter2".to_owned())),
        );
        let dumped = format!("{config:?}");
        assert!(!dumped.contains("SUPERSECRET"), "{dumped}");
        assert!(!dumped.contains("hunter2"), "{dumped}");
        assert!(dumped.contains("redacted"), "{dumped}");
    }

    #[test]
    fn a_config_without_a_key_still_says_so() {
        let config = SshConfig::with_fingerprints(vec![]);
        assert!(config.private_key.is_none());
        assert!(format!("{config:?}").contains("private_key: None"));
    }

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
            connect_addr: None,
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
