//! File transfer over SFTP, decorating any engine.
//!
//! Not a protocol of its own. guacd offers file transfer on RDP and VNC
//! as well as SSH, by opening a second SSH connection to the target and
//! exposing it as a Guacamole filesystem object — so this wraps an
//! existing engine rather than replacing one, the same way the terminal
//! rasteriser does.
//!
//! It is also what keeps the file browser, the outbound-share approval
//! workflow and its AV scanning working: all three hang off the
//! filesystem object this announces.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use russh::client;
use russh::keys::PrivateKeyWithHashAlg;
use russh_sftp::client::fs::File;
use russh_sftp::client::SftpSession;
use secrecy::{ExposeSecret, SecretString};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::engine::ssh::{map_russh, HostKeyChecker, HostKeyPolicy};
use crate::engine::{FileEvent, FileRequest, InputEvent, Protocol, ProtocolEngine, TargetEvent};
use crate::error::EngineError;

/// Mimetype marking a directory listing rather than a file.
const STREAM_INDEX: &str = "application/vnd.glyptodon.guacamole.stream-index+json";

/// Bytes read per `blob`. The client acknowledges each one, so this
/// trades round trips against memory rather than against correctness.
const CHUNK_BYTES: usize = 4096;

/// The single filesystem this engine announces.
const OBJECT: i32 = 1;

/// Guacamole status codes used when a transfer cannot proceed.
const STATUS_SUCCESS: i32 = 0;
const STATUS_FORBIDDEN: i32 = 0x0303;
const STATUS_NOT_FOUND: i32 = 0x0404;

/// Per-connection SFTP settings.
#[derive(Clone)]
pub struct SftpConfig {
    /// Host running the SFTP service. Defaults to the session's target.
    pub hostname: String,
    /// Address to dial, when the caller resolved `hostname` itself.
    pub connect_addr: Option<std::net::IpAddr>,
    /// Port for the SSH connection carrying SFTP.
    pub port: u16,
    /// Account used for the transfer, which need not be the session's.
    pub username: String,
    /// Password, when the account uses one.
    pub password: Option<SecretString>,
    /// Private key in OpenSSH format, when the account uses one.
    pub private_key: Option<SecretString>,
    /// Passphrase protecting `private_key`.
    pub passphrase: Option<SecretString>,
    /// Host key admission policy for this connection.
    pub host_keys: HostKeyPolicy,
    /// Directory the browser is confined to.
    pub root: String,
    /// Refuse to read files out of the target.
    pub disable_download: bool,
    /// Refuse to write files into the target.
    pub disable_upload: bool,
    /// Label shown in the file browser.
    pub name: String,
}

// Hand-written so a credential cannot reach a log through a derive.
impl std::fmt::Debug for SftpConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SftpConfig")
            .field("hostname", &self.hostname)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field(
                "private_key",
                &self.private_key.as_ref().map(|_| "<redacted>"),
            )
            .field("root", &self.root)
            .field("disable_download", &self.disable_download)
            .field("disable_upload", &self.disable_upload)
            .finish_non_exhaustive()
    }
}

impl SftpConfig {
    /// Settings for `hostname`, with everything else at its default.
    #[must_use]
    pub fn new(hostname: String, port: u16, username: String) -> Self {
        Self {
            hostname,
            connect_addr: None,
            port,
            username,
            password: None,
            private_key: None,
            passphrase: None,
            host_keys: HostKeyPolicy::Fingerprints(Vec::new()),
            root: "/".to_owned(),
            disable_download: false,
            disable_upload: false,
            name: "Files".to_owned(),
        }
    }
}

/// An engine with file transfer attached.
pub struct SftpEngine {
    inner: Box<dyn ProtocolEngine>,
    sftp: SftpSession,
    /// Holds the SSH connection open; dropping it closes the subsystem.
    _ssh: client::Handle<HostKeyChecker>,
    config: Arc<SftpConfig>,
    pending: VecDeque<TargetEvent>,
    /// Stream indices this engine allocates. Negative so they cannot
    /// collide with the client's, which the actor also routes.
    next_stream: i32,
    downloads: HashMap<i32, File>,
    uploads: HashMap<i32, File>,
}

impl SftpEngine {
    /// Attach file transfer to `inner`.
    pub async fn attach(
        inner: Box<dyn ProtocolEngine>,
        config: Arc<SftpConfig>,
    ) -> Result<Self, EngineError> {
        let checker = HostKeyChecker {
            policy: config.host_keys.clone(),
        };
        let dial_host = config
            .connect_addr
            .map_or_else(|| config.hostname.clone(), |ip| ip.to_string());
        let ssh_config = Arc::new(client::Config::default());
        let mut handle = client::connect(ssh_config, (dial_host.as_str(), config.port), checker)
            .await
            .map_err(map_russh)?;

        authenticate(&mut handle, &config).await?;

        let channel = handle.channel_open_session().await.map_err(map_russh)?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(map_russh)?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| EngineError::Protocol(format!("sftp subsystem: {e}")))?;

        let mut pending = VecDeque::new();
        // Announced up front so the browser shows the filesystem as soon
        // as the session opens, rather than after the first request.
        pending.push_back(TargetEvent::File(FileEvent::Filesystem {
            object: OBJECT,
            name: config.name.clone(),
        }));

        Ok(Self {
            inner,
            sftp,
            _ssh: handle,
            config,
            pending,
            next_stream: -1,
            downloads: HashMap::new(),
            uploads: HashMap::new(),
        })
    }

    fn allocate_stream(&mut self) -> i32 {
        let stream = self.next_stream;
        self.next_stream -= 1;
        stream
    }

    fn fail(&mut self, stream: i32, message: &str, status: i32) {
        self.pending.push_back(TargetEvent::File(FileEvent::Ack {
            stream,
            message: message.to_owned(),
            status,
        }));
    }

    async fn on_get(&mut self, name: String) -> Result<(), EngineError> {
        let stream = self.allocate_stream();
        let root = self.config.root.clone();
        let Some(path) = resolve_in(&self.sftp, &root, &name).await else {
            self.fail(stream, "no such file", STATUS_NOT_FOUND);
            return Ok(());
        };
        let Ok(metadata) = self.sftp.metadata(path.clone()).await else {
            self.fail(stream, "no such file", STATUS_NOT_FOUND);
            return Ok(());
        };

        if metadata.is_dir() {
            self.send_listing(stream, &name, &path).await
        } else {
            self.begin_download(stream, &name, &path).await
        }
    }

    /// Send a directory as the JSON object the browser expects.
    async fn send_listing(
        &mut self,
        stream: i32,
        name: &str,
        path: &str,
    ) -> Result<(), EngineError> {
        let Ok(entries) = self.sftp.read_dir(path.to_owned()).await else {
            self.fail(stream, "cannot list directory", STATUS_FORBIDDEN);
            return Ok(());
        };

        let mut listing = serde_json::Map::new();
        for entry in entries {
            let child = entry.file_name();
            if child == "." || child == ".." {
                continue;
            }
            let mimetype = if entry.metadata().is_dir() {
                STREAM_INDEX
            } else {
                "application/octet-stream"
            };
            let full = format!("{}/{}", name.trim_end_matches('/'), child);
            listing.insert(full, serde_json::Value::String(mimetype.to_owned()));
        }

        let body = serde_json::Value::Object(listing).to_string();
        self.pending.push_back(TargetEvent::File(FileEvent::Body {
            object: OBJECT,
            stream,
            mimetype: STREAM_INDEX.to_owned(),
            name: name.to_owned(),
        }));
        self.pending.push_back(TargetEvent::File(FileEvent::Data {
            stream,
            data: Bytes::from(body),
        }));
        self.pending
            .push_back(TargetEvent::File(FileEvent::End { stream }));
        Ok(())
    }

    async fn begin_download(
        &mut self,
        stream: i32,
        name: &str,
        path: &str,
    ) -> Result<(), EngineError> {
        if self.config.disable_download {
            self.fail(stream, "downloads are disabled", STATUS_FORBIDDEN);
            return Ok(());
        }
        let Ok(file) = self.sftp.open(path.to_owned()).await else {
            self.fail(stream, "cannot open file", STATUS_FORBIDDEN);
            return Ok(());
        };
        self.downloads.insert(stream, file);
        self.pending.push_back(TargetEvent::File(FileEvent::Body {
            object: OBJECT,
            stream,
            mimetype: "application/octet-stream".to_owned(),
            name: name.to_owned(),
        }));
        // The client acknowledges `body` before any data, so the first
        // chunk goes out on that ack like every later one.
        Ok(())
    }

    /// Send the next chunk of a download, or finish the stream.
    async fn continue_download(&mut self, stream: i32) -> Result<(), EngineError> {
        let Some(file) = self.downloads.get_mut(&stream) else {
            return Ok(());
        };
        let mut buffer = vec![0u8; CHUNK_BYTES];
        let read = match file.read(&mut buffer).await {
            Ok(read) => read,
            Err(err) => {
                tracing::warn!(error = %err, "sftp read failed");
                self.downloads.remove(&stream);
                self.pending
                    .push_back(TargetEvent::File(FileEvent::End { stream }));
                return Ok(());
            }
        };
        if read == 0 {
            self.downloads.remove(&stream);
            self.pending
                .push_back(TargetEvent::File(FileEvent::End { stream }));
            return Ok(());
        }
        buffer.truncate(read);
        self.pending.push_back(TargetEvent::File(FileEvent::Data {
            stream,
            data: Bytes::from(buffer),
        }));
        Ok(())
    }

    async fn on_put(&mut self, stream: i32, name: String) -> Result<(), EngineError> {
        if self.config.disable_upload {
            self.fail(stream, "uploads are disabled", STATUS_FORBIDDEN);
            return Ok(());
        }
        // The parent must resolve inside the root; the file itself does
        // not exist yet, so canonicalising it would fail.
        let parent = name.rsplit_once('/').map_or("/", |(head, _)| head);
        let root = self.config.root.clone();
        let Some(directory) = resolve_in(&self.sftp, &root, parent).await else {
            self.fail(stream, "no such directory", STATUS_NOT_FOUND);
            return Ok(());
        };
        let leaf = name.rsplit('/').next().unwrap_or_default();
        if leaf.is_empty() || leaf == "." || leaf == ".." {
            self.fail(stream, "invalid filename", STATUS_FORBIDDEN);
            return Ok(());
        }

        let path = format!("{}/{leaf}", directory.trim_end_matches('/'));
        let Ok(file) = self.sftp.create(path).await else {
            self.fail(stream, "cannot create file", STATUS_FORBIDDEN);
            return Ok(());
        };
        self.uploads.insert(stream, file);
        // Acknowledging the `put` is what makes the browser start sending.
        self.fail(stream, "", STATUS_SUCCESS);
        Ok(())
    }

    async fn on_upload_data(&mut self, stream: i32, data: &Bytes) -> Result<(), EngineError> {
        let Some(file) = self.uploads.get_mut(&stream) else {
            return Ok(());
        };
        if let Err(err) = file.write_all(data).await {
            tracing::warn!(error = %err, "sftp write failed");
            self.uploads.remove(&stream);
            self.fail(stream, "write failed", STATUS_FORBIDDEN);
            return Ok(());
        }
        self.fail(stream, "", STATUS_SUCCESS);
        Ok(())
    }

    async fn on_upload_end(&mut self, stream: i32) -> Result<(), EngineError> {
        if let Some(mut file) = self.uploads.remove(&stream) {
            // Flushed explicitly: the write half buffers, and a file that
            // closes without it arrives truncated.
            if let Err(err) = file.flush().await {
                tracing::warn!(error = %err, "sftp flush failed");
            }
            let _ = file.close().await;
        }
        Ok(())
    }
}

/// Resolve a client-supplied path inside `root`.
///
/// A free function rather than a method because holding `&self` across
/// these awaits would require the wrapped engine to be `Sync`, which no
/// engine is.
async fn resolve_in(sftp: &SftpSession, root: &str, name: &str) -> Option<String> {
    let root = sftp.canonicalize(root.to_owned()).await.ok()?;
    let joined = format!(
        "{}/{}",
        root.trim_end_matches('/'),
        name.trim_start_matches('/')
    );
    let resolved = sftp.canonicalize(joined).await.ok()?;
    if is_within(&root, &resolved) {
        Some(resolved)
    } else {
        tracing::warn!(requested = %name, "sftp path escapes the configured root");
        None
    }
}

/// Whether `resolved` lies inside `root`, both already canonical.
///
/// Compared with a trailing separator so a sibling directory whose name
/// merely starts with the root's — `/srv/data-old` against `/srv/data` —
/// is not mistaken for a child.
fn is_within(root: &str, resolved: &str) -> bool {
    let root = root.trim_end_matches('/');
    if root.is_empty() {
        return true;
    }
    resolved == root || resolved.starts_with(&format!("{root}/"))
}

/// Authenticate the SFTP connection, key first.
async fn authenticate(
    handle: &mut client::Handle<HostKeyChecker>,
    config: &SftpConfig,
) -> Result<(), EngineError> {
    if let Some(key) = &config.private_key {
        let passphrase = config.passphrase.as_ref().map(|p| p.expose_secret());
        match russh::keys::decode_secret_key(key.expose_secret(), passphrase) {
            Ok(key) => {
                let key =
                    PrivateKeyWithHashAlg::new(Arc::new(key), Some(russh::keys::HashAlg::Sha256));
                if handle
                    .authenticate_publickey(&config.username, key)
                    .await
                    .map_err(map_russh)?
                    .success()
                {
                    return Ok(());
                }
            }
            Err(err) => tracing::warn!(error = %err, "sftp private key could not be read"),
        }
    }

    if let Some(password) = &config.password {
        if handle
            .authenticate_password(&config.username, password.expose_secret())
            .await
            .map_err(map_russh)?
            .success()
        {
            return Ok(());
        }
    }

    Err(EngineError::AuthRejected)
}

#[async_trait]
impl ProtocolEngine for SftpEngine {
    fn protocol(&self) -> Protocol {
        self.inner.protocol()
    }

    async fn handle_input(&mut self, input: InputEvent) -> Result<(), EngineError> {
        let InputEvent::File(request) = input else {
            return self.inner.handle_input(input).await;
        };
        match request {
            FileRequest::Get { object, name } if object == OBJECT => self.on_get(name).await,
            FileRequest::Put {
                object,
                stream,
                name,
                ..
            } if object == OBJECT => self.on_put(stream, name).await,
            FileRequest::Data { stream, data } => self.on_upload_data(stream, &data).await,
            FileRequest::End { stream } => self.on_upload_end(stream).await,
            // Only this engine's own streams are flow-controlled; an ack
            // for anything else belongs to the clipboard or audio.
            FileRequest::Ack { stream, status } if stream < 0 => {
                if status == STATUS_SUCCESS {
                    self.continue_download(stream).await
                } else {
                    self.downloads.remove(&stream);
                    Ok(())
                }
            }
            FileRequest::Get { .. } | FileRequest::Put { .. } | FileRequest::Ack { .. } => Ok(()),
        }
    }

    async fn next_event(&mut self) -> Result<Option<TargetEvent>, EngineError> {
        if let Some(event) = self.pending.pop_front() {
            return Ok(Some(event));
        }
        // Everything this engine produces is generated by `handle_input`,
        // so with nothing queued the only source left is the session
        // underneath. Cancel-safe because all partial state is in
        // `self.pending`.
        self.inner.next_event().await
    }

    async fn shutdown(&mut self) -> Result<(), EngineError> {
        if let Err(err) = self.sftp.close().await {
            tracing::debug!(error = %err, "sftp close failed");
        }
        self.inner.shutdown().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_configured_credential_is_not_printable() {
        let mut config = SftpConfig::new("host".to_owned(), 22, "svc".to_owned());
        config.password = Some(SecretString::from("hunter2"));
        config.private_key = Some(SecretString::from("-----BEGIN OPENSSH PRIVATE KEY-----"));
        let printed = format!("{config:?}");
        assert!(!printed.contains("hunter2"), "{printed}");
        assert!(!printed.contains("BEGIN OPENSSH"), "{printed}");
    }

    /// The browser sends whatever the operator clicks, but nothing stops
    /// a crafted `get` naming a path outside the configured root.
    #[test]
    fn a_path_outside_the_root_is_refused() {
        assert!(!is_within("/srv/data", "/etc/shadow"));
        assert!(!is_within("/srv/data", "/srv"));
        assert!(!is_within("/srv/data", "/"));
    }

    /// A sibling whose name merely starts with the root's must not be
    /// mistaken for a child.
    #[test]
    fn a_sibling_sharing_a_prefix_is_not_inside_the_root() {
        assert!(!is_within("/srv/data", "/srv/data-old"));
        assert!(!is_within("/srv/data", "/srv/database"));
    }

    #[test]
    fn the_root_and_its_children_are_inside_it() {
        assert!(is_within("/srv/data", "/srv/data"));
        assert!(is_within("/srv/data", "/srv/data/file"));
        assert!(is_within("/srv/data/", "/srv/data/nested/file"));
        // A root of `/` confines nothing, which is the guacd default.
        assert!(is_within("/", "/etc/shadow"));
    }
}
