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
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use russh::client;
use russh::keys::PrivateKeyWithHashAlg;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use secrecy::{ExposeSecret, SecretString};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::engine::ssh::{map_russh, HostKeyChecker, HostKeyPolicy};
use crate::engine::{FileEvent, FileRequest, InputEvent, Protocol, ProtocolEngine, TargetEvent};
use crate::error::EngineError;

/// Mimetype marking a directory listing rather than a file.
const STREAM_INDEX: &str = "application/vnd.glyptodon.guacamole.stream-index+json";

/// Bytes read per `blob`. The client acknowledges each one, so this
/// trades round trips against memory rather than against correctness.
const CHUNK_BYTES: usize = 4096;

/// Uploads plus downloads a single session may hold open at once.
const MAX_OPEN_TRANSFERS: usize = 8;

/// Default ceiling on one transfer, matching Quick Share's.
pub const DEFAULT_MAX_TRANSFER_BYTES: u64 = 500 * 1024 * 1024;

/// Read size when copying between the target and a staged copy.
const STAGE_CHUNK_BYTES: usize = 64 * 1024;

/// Policy applied to every transfer once it is fully staged on this side,
/// before any byte reaches its destination. Lets the host application
/// scan, approve or refuse a file without this crate knowing how.
#[async_trait]
pub trait TransferGate: Send + Sync {
    /// `Ok` lets a staged upload be written to the target; `Err` is the
    /// reason shown to the user.
    async fn admit_upload(&self, staged: &Path, name: &str) -> Result<(), String>;
    /// `Ok` delivers a staged download to the browser; `Err` is the reason
    /// it was withheld, including "held for approval".
    async fn admit_download(&self, staged: &Path, name: &str) -> Result<(), String>;
}

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
    /// Applied to every transfer before it is delivered. `None` admits all.
    pub gate: Option<Arc<dyn TransferGate>>,
    /// Largest file either direction will stage.
    pub max_transfer_bytes: u64,
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
            .field("gated", &self.gate.is_some())
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
            gate: None,
            max_transfer_bytes: DEFAULT_MAX_TRANSFER_BYTES,
        }
    }
}

/// A local copy of a file in transit, deleted when dropped.
struct Staged(PathBuf);

impl Staged {
    async fn create() -> std::io::Result<(Self, tokio::fs::File)> {
        // The `strata-upload-` prefix is what the backend's boot sweep removes.
        let path =
            std::env::temp_dir().join(format!("strata-upload-sftp-{}", uuid::Uuid::new_v4()));
        let mut options = tokio::fs::OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let file = options.open(&path).await?;
        Ok((Self(path), file))
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// An upload being received into its staged copy.
struct Upload {
    file: tokio::fs::File,
    staged: Staged,
    remote: String,
    name: String,
    size: u64,
}

/// An admitted download being streamed from its staged copy.
struct Delivery {
    file: tokio::fs::File,
    _staged: Staged,
}

/// Result of a transfer's background stage: gate plus target I/O.
enum Completion {
    DownloadReady {
        stream: i32,
        name: String,
        staged: Staged,
    },
    DownloadWithheld {
        stream: i32,
        message: String,
    },
    UploadFinished {
        message: String,
        ok: bool,
    },
}

/// An engine with file transfer attached.
pub struct SftpEngine {
    inner: Box<dyn ProtocolEngine>,
    sftp: Arc<SftpSession>,
    /// Holds the SSH connection open; dropping it closes the subsystem.
    _ssh: client::Handle<HostKeyChecker>,
    config: Arc<SftpConfig>,
    pending: VecDeque<TargetEvent>,
    /// Stream indices this engine allocates. Negative so they cannot
    /// collide with the client's, which the actor also routes.
    next_stream: i32,
    downloads: HashMap<i32, Delivery>,
    uploads: HashMap<i32, Upload>,
    /// Transfers handed to a background task (gate and target I/O), so a
    /// slow scan never stalls the session itself.
    in_flight: usize,
    done_tx: mpsc::UnboundedSender<Completion>,
    done_rx: mpsc::UnboundedReceiver<Completion>,
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
        let (done_tx, done_rx) = mpsc::unbounded_channel();

        Ok(Self {
            inner,
            sftp: Arc::new(sftp),
            _ssh: handle,
            config,
            pending,
            next_stream: -1,
            downloads: HashMap::new(),
            uploads: HashMap::new(),
            in_flight: 0,
            done_tx,
            done_rx,
        })
    }

    fn busy(&self) -> usize {
        self.downloads.len() + self.uploads.len() + self.in_flight
    }

    fn notice(&mut self, message: String, ok: bool) {
        self.pending
            .push_back(TargetEvent::File(FileEvent::Notice { message, ok }));
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
        if self.busy() >= MAX_OPEN_TRANSFERS {
            self.fail(stream, "too many transfers in progress", STATUS_FORBIDDEN);
            return Ok(());
        }
        self.in_flight += 1;
        let sftp = Arc::clone(&self.sftp);
        let gate = self.config.gate.clone();
        let limit = self.config.max_transfer_bytes;
        let done = self.done_tx.clone();
        let (path, name) = (path.to_owned(), name.to_owned());
        tokio::spawn(async move {
            let outcome = match stage_download(&sftp, &path, limit).await {
                Ok(staged) => match gate {
                    Some(gate) => gate.admit_download(&staged.0, &name).await.map(|()| staged),
                    None => Ok(staged),
                },
                Err(message) => Err(message),
            };
            let _ = done.send(match outcome {
                Ok(staged) => Completion::DownloadReady {
                    stream,
                    name,
                    staged,
                },
                Err(message) => Completion::DownloadWithheld { stream, message },
            });
        });
        Ok(())
    }

    /// Act on a finished background stage. Synchronous so that a cancelled
    /// `next_event` can never drop a completion it already received.
    fn on_completion(&mut self, done: Completion) {
        self.in_flight = self.in_flight.saturating_sub(1);
        match done {
            Completion::DownloadReady {
                stream,
                name,
                staged,
            } => match std::fs::File::open(&staged.0) {
                Ok(file) => {
                    self.downloads.insert(
                        stream,
                        Delivery {
                            file: tokio::fs::File::from_std(file),
                            _staged: staged,
                        },
                    );
                    // The client acknowledges `body` before any data, so the
                    // first chunk goes out on that ack like every later one.
                    self.pending.push_back(TargetEvent::File(FileEvent::Body {
                        object: OBJECT,
                        stream,
                        mimetype: "application/octet-stream".to_owned(),
                        name,
                    }));
                }
                Err(err) => {
                    tracing::warn!(error = %err, "staged download vanished");
                    self.fail(stream, "cannot read file", STATUS_FORBIDDEN);
                }
            },
            Completion::DownloadWithheld { stream, message } => {
                self.fail(stream, &message, STATUS_FORBIDDEN);
                self.notice(message, false);
            }
            Completion::UploadFinished { message, ok } => self.notice(message, ok),
        }
    }

    /// Send the next chunk of a download, or finish the stream.
    async fn continue_download(&mut self, stream: i32) -> Result<(), EngineError> {
        let Some(delivery) = self.downloads.get_mut(&stream) else {
            return Ok(());
        };
        let mut buffer = vec![0u8; CHUNK_BYTES];
        let read = match delivery.file.read(&mut buffer).await {
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
        if self.busy() >= MAX_OPEN_TRANSFERS {
            self.fail(stream, "too many transfers in progress", STATUS_FORBIDDEN);
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
        // Early refusal only; `write_remote` re-checks when it writes.
        match self.sftp.symlink_metadata(path.clone()).await {
            Ok(meta) if meta.is_symlink() => {
                self.fail(
                    stream,
                    "refusing to overwrite a symbolic link",
                    STATUS_FORBIDDEN,
                );
                return Ok(());
            }
            Ok(meta) if meta.is_dir() => {
                self.fail(stream, "a directory has that name", STATUS_FORBIDDEN);
                return Ok(());
            }
            _ => {}
        }
        let (staged, file) = match Staged::create().await {
            Ok(created) => created,
            Err(err) => {
                tracing::warn!(error = %err, "cannot stage sftp upload");
                self.fail(stream, "cannot stage file", STATUS_FORBIDDEN);
                return Ok(());
            }
        };
        self.uploads.insert(
            stream,
            Upload {
                file,
                staged,
                remote: path,
                name: leaf.to_owned(),
                size: 0,
            },
        );
        // Acknowledging the `put` is what makes the browser start sending.
        self.fail(stream, "", STATUS_SUCCESS);
        Ok(())
    }

    async fn on_upload_data(&mut self, stream: i32, data: &Bytes) -> Result<(), EngineError> {
        let limit = self.config.max_transfer_bytes;
        let Some(upload) = self.uploads.get_mut(&stream) else {
            return Ok(());
        };
        upload.size += data.len() as u64;
        if upload.size > limit {
            self.uploads.remove(&stream);
            self.fail(
                stream,
                "file is larger than the transfer limit",
                STATUS_FORBIDDEN,
            );
            return Ok(());
        }
        if let Err(err) = upload.file.write_all(data).await {
            tracing::warn!(error = %err, "staging an sftp upload failed");
            self.uploads.remove(&stream);
            self.fail(stream, "write failed", STATUS_FORBIDDEN);
            return Ok(());
        }
        self.fail(stream, "", STATUS_SUCCESS);
        Ok(())
    }

    /// The client has sent everything: gate the staged copy, then write it
    /// to the target. Reported by notice, because the stream is closed.
    async fn on_upload_end(&mut self, stream: i32) -> Result<(), EngineError> {
        let Some(mut upload) = self.uploads.remove(&stream) else {
            return Ok(());
        };
        if let Err(err) = upload.file.flush().await {
            tracing::warn!(error = %err, "staging an sftp upload failed");
            self.notice(format!("{}: upload failed", upload.name), false);
            return Ok(());
        }
        drop(upload.file);
        self.in_flight += 1;
        let sftp = Arc::clone(&self.sftp);
        let gate = self.config.gate.clone();
        let done = self.done_tx.clone();
        let Upload {
            staged,
            remote,
            name,
            ..
        } = upload;
        tokio::spawn(async move {
            let outcome = async {
                if let Some(gate) = gate {
                    gate.admit_upload(&staged.0, &name).await?;
                }
                write_remote(&sftp, &remote, &staged.0).await
            }
            .await;
            let (message, ok) = match outcome {
                Ok(()) => (format!("Uploaded {name}"), true),
                Err(reason) => (format!("{name}: {reason}"), false),
            };
            let _ = done.send(Completion::UploadFinished { message, ok });
        });
        Ok(())
    }
}

/// Copy a target file into a staged local copy, refusing anything over `limit`.
async fn stage_download(sftp: &SftpSession, path: &str, limit: u64) -> Result<Staged, String> {
    let mut remote = sftp
        .open(path.to_owned())
        .await
        .map_err(|_| "cannot open file".to_owned())?;
    let (staged, mut local) = Staged::create()
        .await
        .map_err(|_| "cannot stage file".to_owned())?;
    let mut buffer = vec![0u8; STAGE_CHUNK_BYTES];
    let mut total = 0u64;
    loop {
        let read = remote
            .read(&mut buffer)
            .await
            .map_err(|_| "read failed".to_owned())?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > limit {
            return Err("file is larger than the transfer limit".into());
        }
        local
            .write_all(&buffer[..read])
            .await
            .map_err(|_| "cannot stage file".to_owned())?;
    }
    local
        .flush()
        .await
        .map_err(|_| "cannot stage file".to_owned())?;
    Ok(staged)
}

/// Write a staged upload to `path` on the target without following links.
///
/// SFTP has no O_NOFOLLOW. Instead the existing entry is removed (which
/// never follows a link) and the file is created exclusively, so a symlink
/// planted at any point makes the create fail rather than redirect the
/// write outside the root.
async fn write_remote(sftp: &SftpSession, path: &str, staged: &Path) -> Result<(), String> {
    match sftp.symlink_metadata(path.to_owned()).await {
        Ok(meta) if meta.is_symlink() => {
            return Err("refusing to overwrite a symbolic link".into());
        }
        Ok(meta) if meta.is_dir() => return Err("a directory has that name".into()),
        Ok(_) => sftp
            .remove_file(path.to_owned())
            .await
            .map_err(|_| "cannot replace file".to_owned())?,
        Err(_) => {}
    }
    let flags = OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE;
    let mut remote = sftp
        .open_with_flags(path.to_owned(), flags)
        .await
        .map_err(|_| "cannot create file".to_owned())?;
    let mut local = tokio::fs::File::open(staged)
        .await
        .map_err(|_| "cannot read staged file".to_owned())?;
    tokio::io::copy(&mut local, &mut remote)
        .await
        .map_err(|_| "write failed".to_owned())?;
    // Flushed explicitly: the write half buffers, and a file that closes
    // without it arrives truncated.
    remote
        .flush()
        .await
        .map_err(|_| "write failed".to_owned())?;
    let _ = remote.shutdown().await;
    Ok(())
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
        loop {
            if let Some(event) = self.pending.pop_front() {
                return Ok(Some(event));
            }
            // Cancel-safe: partial state lives in `self.pending`, and both
            // branches are cancel-safe receives.
            tokio::select! {
                Some(done) = self.done_rx.recv() => self.on_completion(done),
                event = self.inner.next_event() => return event,
            }
        }
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
