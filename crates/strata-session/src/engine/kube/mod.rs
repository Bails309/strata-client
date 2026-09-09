//! Kubernetes exec engine, replacing guacd's `kubernetes` protocol.
//!
//! Not a protocol of its own: it is a WebSocket to one endpoint on the
//! API server carrying a PTY, so the SSH engine's keymap and the shared
//! terminal rasteriser do the rest.
//!
//! The `kube` crate was not used. It brings an ~80-deep dependency tree
//! to reach an API this engine touches at a single endpoint, and the
//! same tree was already turned down once for live pod listing.
//!
//! Framing is `v4.channel.k8s.io`: every message is prefixed with one
//! byte naming a stream, which is why a naive read shows a stray
//! character before the shell prompt.

use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use secrecy::{ExposeSecret, SecretString};
use tokio::net::TcpStream;
use tokio_rustls::rustls::pki_types::pem::PemObject;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};

use crate::engine::keymap::{keysym_to_bytes_with, Backspace, CellSize, Modifiers};
use crate::engine::{EngineFactory, InputEvent, Protocol, ProtocolEngine, TargetEvent, TargetSpec};
use crate::error::EngineError;

/// Stream indices defined by `v4.channel.k8s.io`.
const STDIN: u8 = 0;
const STDOUT: u8 = 1;
const STDERR: u8 = 2;
/// Carries a JSON `Status` when the command finishes or cannot start.
const ERROR: u8 = 3;
const RESIZE: u8 = 4;

/// Mouse button masks, matching the Guacamole protocol.
const MIDDLE: u8 = 0x02;
const RIGHT: u8 = 0x04;

/// Per-connection Kubernetes settings.
#[derive(Clone)]
pub struct KubeConfig {
    /// What the BackSpace key sends, from `backspace`.
    pub backspace: Backspace,
    /// Namespace holding the pod.
    pub namespace: String,
    /// Pod to attach to.
    pub pod: String,
    /// Container within the pod. The API picks the default when absent.
    pub container: Option<String>,
    /// Command to run, already split into arguments.
    pub command: Vec<String>,
    /// Whether to speak TLS to the API server.
    pub use_ssl: bool,
    /// Whether to verify the API server's certificate.
    pub verify_certificate: bool,
    /// PEM CA bundle that signed the API server, if not a public one.
    pub ca_cert: Option<String>,
    /// PEM client certificate presented for authentication.
    pub client_cert: Option<String>,
    /// PEM private key for `client_cert`.
    pub client_key: Option<SecretString>,
    /// Password protecting `client_key`, when it is encrypted.
    pub client_key_password: Option<SecretString>,
    /// Cell geometry for pixel-to-grid conversion.
    pub cell: CellSize,
    /// Drop every keystroke from the client.
    pub read_only: bool,
    /// Never carry the target's clipboard back to the client.
    pub disable_copy: bool,
    /// Never carry the client's clipboard to the target.
    pub disable_paste: bool,
}

impl Default for KubeConfig {
    fn default() -> Self {
        Self {
            backspace: Backspace::default(),
            namespace: "default".to_owned(),
            pod: String::new(),
            container: None,
            command: vec!["/bin/sh".to_owned()],
            use_ssl: true,
            verify_certificate: true,
            ca_cert: None,
            client_cert: None,
            client_key: None,
            client_key_password: None,
            cell: CellSize::default(),
            read_only: false,
            disable_copy: false,
            disable_paste: false,
        }
    }
}

// Hand-written so a client key cannot reach a log through a derive.
impl std::fmt::Debug for KubeConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KubeConfig")
            .field("namespace", &self.namespace)
            .field("pod", &self.pod)
            .field("container", &self.container)
            .field("command", &self.command)
            .field("use_ssl", &self.use_ssl)
            .field("verify_certificate", &self.verify_certificate)
            .field("ca_cert", &self.ca_cert.as_ref().map(|_| "<pem>"))
            .field("client_cert", &self.client_cert.as_ref().map(|_| "<pem>"))
            .field(
                "client_key",
                &self.client_key.as_ref().map(|_| "<redacted>"),
            )
            .field("read_only", &self.read_only)
            .finish_non_exhaustive()
    }
}

/// Builds [`KubeEngine`]s from a shared configuration.
pub struct KubeEngineFactory {
    config: Arc<KubeConfig>,
}

impl KubeEngineFactory {
    /// Create a factory with the given configuration.
    #[must_use]
    pub fn new(config: KubeConfig) -> Self {
        Self {
            config: Arc::new(config),
        }
    }
}

#[async_trait]
impl EngineFactory for KubeEngineFactory {
    async fn connect(&self, spec: TargetSpec) -> Result<Box<dyn ProtocolEngine>, EngineError> {
        let engine = KubeEngine::connect(spec, Arc::clone(&self.config)).await?;
        Ok(Box::new(engine))
    }
}

/// A live exec session against a pod.
pub struct KubeEngine {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    config: Arc<KubeConfig>,
    modifiers: Modifiers,
    /// What the client last said was on its clipboard, pasted on demand.
    clipboard: Bytes,
    mouse_mask: u8,
    cols: u32,
    rows: u32,
    finished: bool,
}

impl KubeEngine {
    /// Open an exec session against the pod named in `config`.
    pub async fn connect(spec: TargetSpec, config: Arc<KubeConfig>) -> Result<Self, EngineError> {
        let (cols, rows) = config.cell.to_grid(spec.width, spec.height);
        let scheme = if config.use_ssl { "wss" } else { "ws" };
        let url = format!(
            "{scheme}://{}:{}{}",
            spec.hostname,
            spec.port,
            exec_path(&config)
        );

        let mut request = url
            .into_client_request()
            .map_err(|e| EngineError::Protocol(format!("kubernetes exec url: {e}")))?;
        // The API server closes the connection immediately without this.
        request.headers_mut().insert(
            SEC_WEBSOCKET_PROTOCOL,
            "v4.channel.k8s.io"
                .parse()
                .expect("static header value is valid"),
        );

        let stream = TcpStream::connect((spec.dial_host().as_str(), spec.port)).await?;

        let connector = if config.use_ssl {
            Some(Connector::Rustls(Arc::new(tls_config(&config)?)))
        } else {
            None
        };

        let (socket, _) =
            tokio_tungstenite::client_async_tls_with_config(request, stream, None, connector)
                .await
                .map_err(|e| EngineError::Protocol(format!("kubernetes exec: {e}")))?;

        let mut engine = Self {
            socket,
            config,
            modifiers: Modifiers::default(),
            clipboard: Bytes::new(),
            mouse_mask: 0,
            cols,
            rows,
            finished: false,
        };
        engine.send_resize().await?;
        Ok(engine)
    }

    /// Send one framed message on `channel`.
    async fn send(&mut self, channel: u8, payload: &[u8]) -> Result<(), EngineError> {
        let mut framed = Vec::with_capacity(payload.len() + 1);
        framed.push(channel);
        framed.extend_from_slice(payload);
        self.socket
            .send(Message::Binary(framed.into()))
            .await
            .map_err(|e| EngineError::Protocol(format!("kubernetes send: {e}")))
    }

    async fn send_resize(&mut self) -> Result<(), EngineError> {
        // Field names are capitalised, and the API server rejects the
        // message outright if they are not.
        let payload = format!(r#"{{"Width":{},"Height":{}}}"#, self.cols, self.rows);
        self.send(RESIZE, payload.as_bytes()).await
    }

    async fn paste(&mut self) -> Result<(), EngineError> {
        if self.config.disable_paste || self.clipboard.is_empty() {
            return Ok(());
        }
        let clipboard = self.clipboard.clone();
        self.send(STDIN, &clipboard).await
    }
}

#[async_trait]
impl ProtocolEngine for KubeEngine {
    fn protocol(&self) -> Protocol {
        Protocol::KubeExec
    }

    async fn handle_input(&mut self, input: InputEvent) -> Result<(), EngineError> {
        if self.config.read_only
            && !matches!(input, InputEvent::Disconnect | InputEvent::Resize { .. })
        {
            return Ok(());
        }
        match input {
            InputEvent::Key { keysym, pressed } => {
                if self.modifiers.track(keysym, pressed) || !pressed {
                    return Ok(());
                }
                if (keysym == u32::from(b'V') && self.modifiers.ctrl)
                    || (keysym == u32::from(b'v') && self.modifiers.alt)
                {
                    return self.paste().await;
                }
                if let Some(bytes) =
                    keysym_to_bytes_with(keysym, self.modifiers, self.config.backspace)
                {
                    self.send(STDIN, &bytes).await?;
                }
            }
            InputEvent::Text(data) => self.send(STDIN, &data).await?,
            // Only a note of what the client holds. The client sends this
            // on focus and mouseover as well as on paste, so writing it
            // straight through would type the operator's clipboard into
            // the pod.
            InputEvent::Clipboard(data) => self.clipboard = data,
            InputEvent::Resize { width, height } => {
                let (cols, rows) = self.config.cell.to_grid(width, height);
                if (cols, rows) != (self.cols, self.rows) {
                    self.cols = cols;
                    self.rows = rows;
                    self.send_resize().await?;
                }
            }
            // A terminal pastes on middle or right release, which is how
            // most people paste into one.
            InputEvent::Mouse { mask, .. } => {
                let released = self.mouse_mask & !mask;
                self.mouse_mask = mask;
                if released & (MIDDLE | RIGHT) != 0 {
                    return self.paste().await;
                }
            }
            // Handled by the SFTP decorator, which sits above this engine.
            InputEvent::File(_) => {}
            InputEvent::Disconnect => {
                self.finished = true;
                let _ = self.socket.close(None).await;
            }
        }
        Ok(())
    }

    async fn next_event(&mut self) -> Result<Option<TargetEvent>, EngineError> {
        loop {
            if self.finished {
                return Ok(None);
            }
            let Some(message) = self.socket.next().await else {
                return Ok(None);
            };
            let message =
                message.map_err(|e| EngineError::Protocol(format!("kubernetes recv: {e}")))?;

            let payload = match message {
                Message::Binary(data) => data,
                Message::Close(frame) => {
                    self.finished = true;
                    let reason = frame.map_or_else(
                        || "pod closed the connection".to_owned(),
                        |f| f.reason.to_string(),
                    );
                    return Ok(Some(TargetEvent::Disconnected { reason }));
                }
                // Ping/pong are answered by the library; text frames are
                // not part of this subprotocol.
                _ => continue,
            };

            let Some((&channel, body)) = payload.split_first() else {
                continue;
            };
            match channel {
                STDOUT | STDERR => {
                    if !body.is_empty() {
                        return Ok(Some(TargetEvent::TerminalOutput(Bytes::copy_from_slice(
                            body,
                        ))));
                    }
                }
                ERROR => {
                    self.finished = true;
                    return Ok(Some(TargetEvent::Disconnected {
                        reason: exec_status_reason(body),
                    }));
                }
                other => tracing::debug!(channel = other, "unexpected kubernetes exec stream"),
            }
        }
    }

    async fn shutdown(&mut self) -> Result<(), EngineError> {
        // Best effort: a pod that has already gone must not stop the
        // session tearing down.
        if let Err(err) = self.socket.close(None).await {
            tracing::debug!(error = %err, "kubernetes close failed");
        }
        Ok(())
    }
}

/// Build the exec path, including its query string.
fn exec_path(config: &KubeConfig) -> String {
    let mut path = format!(
        "/api/v1/namespaces/{}/pods/{}/exec?stdin=true&stdout=true&tty=true",
        encode(&config.namespace),
        encode(&config.pod)
    );
    // `stderr` is deliberately absent: the API server rejects the request
    // when it is requested alongside a TTY, which merges the two anyway.
    if let Some(container) = &config.container {
        if !container.is_empty() {
            path.push_str("&container=");
            path.push_str(&encode(container));
        }
    }
    for argument in &config.command {
        path.push_str("&command=");
        path.push_str(&encode(argument));
    }
    path
}

/// Percent-encode one query-string value.
///
/// Hand-rolled to avoid a dependency for a handful of values, and
/// deliberately strict: everything outside the unreserved set is escaped
/// rather than guessed at.
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Turn the JSON `Status` on the error stream into something readable.
///
/// Not parsed as JSON: the whole body is a message for a human, and a
/// dependency to extract one field from it is not worth carrying.
fn exec_status_reason(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    if text.contains(r#""status":"Success""#) {
        return "command exited".to_owned();
    }
    if text.trim().is_empty() {
        return "pod closed the connection".to_owned();
    }
    text.into_owned()
}

/// TLS settings honouring the connection's certificate policy.
fn tls_config(config: &KubeConfig) -> Result<ClientConfig, EngineError> {
    let builder = ClientConfig::builder();
    let builder = if config.verify_certificate {
        builder.with_root_certificates(root_store(config)?)
    } else {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(crate::tls::NoCertificateVerification))
    };

    let (Some(cert), Some(key)) = (&config.client_cert, &config.client_key) else {
        return Ok(builder.with_no_client_auth());
    };

    let certs = CertificateDer::pem_slice_iter(cert.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| EngineError::Protocol(format!("client certificate is not valid PEM: {e}")))?;
    let key = read_private_key(key, config.client_key_password.as_ref())?;
    builder
        .with_client_auth_cert(certs, key)
        .map_err(|e| EngineError::Protocol(format!("client certificate rejected: {e}")))
}

/// Read the client key, decrypting it when a password was supplied.
///
/// An encrypted key is not detected by sniffing the PEM label: a
/// password being configured is the administrator saying the key needs
/// one, and honouring that is what makes the failure legible when it is
/// wrong.
fn read_private_key(
    key: &SecretString,
    password: Option<&SecretString>,
) -> Result<PrivateKeyDer<'static>, EngineError> {
    let Some(password) = password else {
        return PrivateKeyDer::from_pem_slice(key.expose_secret().as_bytes())
            .map_err(|e| EngineError::Protocol(format!("client key is not valid PEM: {e}")));
    };

    let document = pkcs8::SecretDocument::from_pem(key.expose_secret())
        .map_err(|e| EngineError::Protocol(format!("client key is not valid PEM: {e}")))?
        .1;
    let encrypted = pkcs8::EncryptedPrivateKeyInfoRef::try_from(document.as_bytes())
        .map_err(|e| EngineError::Protocol(format!("client key is not an encrypted key: {e}")))?;

    let decrypted = encrypted
        .decrypt(password.expose_secret().as_bytes())
        .map_err(|_| {
            // Deliberately not passing the library's message through: it
            // distinguishes a wrong password from an unsupported cipher,
            // and that difference is an oracle.
            EngineError::Protocol(
                "client key could not be decrypted with the configured password".to_owned(),
            )
        })?;

    Ok(PrivateKeyDer::Pkcs8(decrypted.as_bytes().to_vec().into()))
}

/// Trust anchors for the API server: the connection's CA if it has one,
/// otherwise the system store.
fn root_store(config: &KubeConfig) -> Result<RootCertStore, EngineError> {
    let Some(ca) = config.ca_cert.as_ref().filter(|c| !c.trim().is_empty()) else {
        return crate::tls::native_roots().map_err(|e| EngineError::Protocol(e.to_string()));
    };
    let mut roots = RootCertStore::empty();
    for cert in CertificateDer::pem_slice_iter(ca.as_bytes()) {
        let cert = cert
            .map_err(|e| EngineError::Protocol(format!("CA certificate is not valid PEM: {e}")))?;
        roots
            .add(cert)
            .map_err(|e| EngineError::Protocol(format!("CA certificate rejected: {e}")))?;
    }
    if roots.is_empty() {
        // Failing closed: an empty store verifies against nothing and
        // reports success.
        return Err(EngineError::Protocol(
            "the connection's CA certificate contained no certificates".to_owned(),
        ));
    }
    Ok(roots)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> KubeConfig {
        KubeConfig {
            pod: "web-0".to_owned(),
            ..KubeConfig::default()
        }
    }

    #[test]
    fn the_exec_path_names_the_pod_and_command() {
        let path = exec_path(&config());
        assert!(path.starts_with("/api/v1/namespaces/default/pods/web-0/exec?"));
        assert!(path.contains("stdin=true"));
        assert!(path.contains("tty=true"));
        assert!(path.contains("command=%2Fbin%2Fsh"));
    }

    /// The API server rejects the request outright when stderr is asked
    /// for alongside a TTY, and a TTY merges the two anyway.
    #[test]
    fn a_tty_session_does_not_ask_for_stderr() {
        assert!(!exec_path(&config()).contains("stderr"));
    }

    #[test]
    fn each_command_argument_is_its_own_parameter() {
        let mut config = config();
        config.command = vec!["/bin/sh".to_owned(), "-c".to_owned(), "echo hi".to_owned()];
        let path = exec_path(&config);
        assert_eq!(path.matches("command=").count(), 3);
        assert!(path.contains("command=echo%20hi"), "{path}");
    }

    /// A pod or namespace is attacker-influenced in the sense that an
    /// administrator can type anything into the form; it must not be
    /// able to add query parameters of its own.
    #[test]
    fn a_name_cannot_smuggle_extra_parameters() {
        let mut config = config();
        config.pod = "x&command=/bin/bash".to_owned();
        let path = exec_path(&config);
        assert!(!path.contains("pods/x&command"), "{path}");
        assert_eq!(path.matches("command=").count(), 1, "{path}");
    }

    #[test]
    fn an_empty_container_is_left_out() {
        let mut config = config();
        config.container = Some(String::new());
        assert!(!exec_path(&config).contains("container="));
    }

    #[test]
    fn a_clean_exit_reads_as_one() {
        let body = br#"{"metadata":{},"status":"Success"}"#;
        assert_eq!(exec_status_reason(body), "command exited");
    }

    #[test]
    fn a_failure_keeps_the_servers_own_words() {
        let body = br#"{"status":"Failure","message":"container not found"}"#;
        assert!(exec_status_reason(body).contains("container not found"));
    }

    #[test]
    fn a_ca_that_parses_to_nothing_is_refused() {
        let mut config = config();
        config.ca_cert = Some("not a certificate".to_owned());
        assert!(root_store(&config).is_err());
    }

    /// The key must never reach a log, and `Debug` is how it would.
    #[test]
    fn the_client_key_is_not_printable() {
        let mut config = config();
        config.client_key = Some(SecretString::from("-----BEGIN PRIVATE KEY-----"));
        let printed = format!("{config:?}");
        assert!(!printed.contains("BEGIN PRIVATE KEY"), "{printed}");
        assert!(printed.contains("redacted"), "{printed}");
    }

    /// A real Ed25519 key, generated with:
    ///   openssl genpkey -algorithm ED25519 -out k.pem
    ///   openssl pkcs8 -topk8 -in k.pem -passout pass:strata-test
    /// and verified to decrypt with `openssl pkey -passin pass:strata-test`.
    const ENCRYPTED_KEY: &str = concat!(
        "-----BEGIN ENCRYPTED PRIVATE KEY-----\n",
        "MIGjMF8GCSqGSIb3DQEFDTBSMDEGCSqGSIb3DQEFDDAkBBDsYEwNkeed5dim0i80\n",
        "X08MAgIIADAMBggqhkiG9w0CCQUAMB0GCWCGSAFlAwQBKgQQi5WD9pgx+Pne8gcK\n",
        "Jx+UqQRA1yGt5IrDv0kbIZAKqrMiSdc+Sf4EC398mJ8GHBt3lNDw0hjzwAtkD1g8\n",
        "gXTFyyC3HXy/LGesLMsED0vaaKnXcQ==\n",
        "-----END ENCRYPTED PRIVATE KEY-----\n"
    );

    const KEY_PASSWORD: &str = "strata-test";

    #[test]
    fn an_encrypted_key_is_decrypted_with_its_password() {
        let key = read_private_key(
            &SecretString::from(ENCRYPTED_KEY.to_owned()),
            Some(&SecretString::from(KEY_PASSWORD.to_owned())),
        )
        .expect("the key should decrypt");
        assert!(
            matches!(key, PrivateKeyDer::Pkcs8(_)),
            "expected a PKCS#8 key"
        );
    }

    /// A wrong password must not be distinguishable from an unsupported
    /// cipher: the difference is an oracle.
    #[test]
    fn a_decryption_failure_does_not_say_why() {
        let err = read_private_key(
            &SecretString::from(ENCRYPTED_KEY.to_owned()),
            Some(&SecretString::from("wrong".to_owned())),
        )
        .expect_err("the wrong password must not decrypt");
        let message = err.to_string();
        assert!(
            !message.contains("password") || !message.contains("cipher"),
            "error distinguishes the cause: {message}"
        );
    }

    /// Without a password the key is read as-is, so an unencrypted key
    /// keeps working exactly as before.
    #[test]
    fn an_unencrypted_key_needs_no_password() {
        let err = read_private_key(&SecretString::from("not a key".to_owned()), None)
            .expect_err("garbage must not parse");
        assert!(err.to_string().contains("not valid PEM"), "{err}");
    }
}
