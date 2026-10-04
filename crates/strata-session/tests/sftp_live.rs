//! Live SFTP tests against a real OpenSSH server.
//!
//! The engine's unit tests cover path containment and nothing else,
//! because everything interesting needs a server: whether the directory
//! listing is the shape the browser parses, whether the body/ack/chunk
//! sequence is right, and whether an upload is flushed before its handle
//! closes. Each of those fails silently rather than loudly, which is how
//! the VNC engine shipped a session that connected and drew nothing.
//!
//! `#[ignore]`d because they need a target. To run them:
//!
//! ```text
//! docker compose -f docker-compose.session-test.yml up -d --build sshd
//! FP=$(docker exec strata-ssh-target \
//!        ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}')
//! docker run --rm --network strata-session-test-net \
//!     -v "$PWD:/w" -w /w -e CARGO_TARGET_DIR=/tmp/target \
//!     -e STRATA_SSH_TEST_HOST=strata-ssh-target \
//!     -e STRATA_SSH_TEST_USER=strata \
//!     -e STRATA_SSH_TEST_PASSWORD=strata-test-password \
//!     -e STRATA_SSH_TEST_FINGERPRINT="$FP" \
//!     rust:1.99-slim-trixie \
//!     cargo test -p strata-session --all-features --test sftp_live -- --ignored
//! docker compose -f docker-compose.session-test.yml down -v
//! ```

#![cfg(all(feature = "sftp", feature = "ssh"))]

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use secrecy::SecretString;
use strata_session::engine::mock::MockEngine;
use strata_session::engine::sftp::{SftpConfig, SftpEngine, TransferGate};
use strata_session::engine::ssh::HostKeyPolicy;
use strata_session::engine::{
    FileEvent, FileRequest, InputEvent, Protocol, ProtocolEngine, TargetEvent,
};

const STREAM_INDEX: &str = "application/vnd.glyptodon.guacamole.stream-index+json";
const IO_TIMEOUT: Duration = Duration::from_secs(20);

fn required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| {
        panic!("{name} is not set - see the module header for the docker invocation")
    })
}

async fn connect_with(root: &str, mutate: impl FnOnce(&mut SftpConfig)) -> SftpEngine {
    let mut config = SftpConfig::new(
        required("STRATA_SSH_TEST_HOST"),
        std::env::var("STRATA_SSH_TEST_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(22),
        required("STRATA_SSH_TEST_USER"),
    );
    config.password = Some(SecretString::from(required("STRATA_SSH_TEST_PASSWORD")));
    config.host_keys = HostKeyPolicy::Fingerprints(vec![required("STRATA_SSH_TEST_FINGERPRINT")]);
    config.root = root.to_owned();
    mutate(&mut config);

    let (inner, events, _inputs) = MockEngine::new(Protocol::Ssh);
    // Held open for the test's lifetime: a closed session ends the engine
    // before background transfers can report.
    std::mem::forget(events);
    SftpEngine::attach(Box::new(inner), Arc::new(config))
        .await
        .expect("opening the sftp subsystem")
}

async fn connect() -> SftpEngine {
    connect_with("/tmp", |_| {}).await
}

/// Drain everything the engine has queued without waiting on the wrapped
/// session, which never produces anything here.
async fn drain(engine: &mut SftpEngine) -> Vec<FileEvent> {
    let mut seen = Vec::new();
    while let Ok(Ok(Some(event))) =
        tokio::time::timeout(Duration::from_millis(200), engine.next_event()).await
    {
        if let TargetEvent::File(file) = event {
            seen.push(file);
        }
    }
    seen
}

async fn send(engine: &mut SftpEngine, request: FileRequest) {
    tokio::time::timeout(IO_TIMEOUT, engine.handle_input(InputEvent::File(request)))
        .await
        .expect("timed out handling a file request")
        .expect("file request failed");
}

/// Uploads finish in the background once the stream ends; wait for the
/// notice that reports the outcome.
async fn notice(engine: &mut SftpEngine) -> (String, bool) {
    let deadline = tokio::time::Instant::now() + IO_TIMEOUT;
    loop {
        let event = tokio::time::timeout_at(deadline, engine.next_event())
            .await
            .expect("no transfer notice arrived")
            .expect("engine failed")
            .expect("engine ended");
        if let TargetEvent::File(FileEvent::Notice { message, ok }) = event {
            return (message, ok);
        }
    }
}

/// Refuses everything, the way a positive AV verdict would.
struct Refuse;

#[async_trait::async_trait]
impl TransferGate for Refuse {
    async fn admit_upload(&self, _: &std::path::Path, _: &str) -> Result<(), String> {
        Err("infected".into())
    }
    async fn admit_download(&self, _: &std::path::Path, _: &str) -> Result<(), String> {
        Err("held for approval".into())
    }
}

#[tokio::test]
#[ignore = "needs a live sshd"]
async fn the_filesystem_is_announced_on_connect() {
    let mut engine = connect().await;
    let events = drain(&mut engine).await;
    assert!(
        matches!(events.first(), Some(FileEvent::Filesystem { .. })),
        "expected a filesystem announcement, got {events:?}"
    );
}

/// The browser parses this as a JSON object of path to mimetype, and
/// shows an empty folder for anything else without reporting an error.
#[tokio::test]
#[ignore = "needs a live sshd"]
async fn a_directory_listing_is_the_shape_the_browser_parses() {
    let mut engine = connect().await;
    drain(&mut engine).await;

    send(
        &mut engine,
        FileRequest::Get {
            object: 1,
            name: "/".to_owned(),
        },
    )
    .await;
    let events = drain(&mut engine).await;

    let body = events
        .iter()
        .find_map(|e| match e {
            FileEvent::Body {
                mimetype, stream, ..
            } if mimetype == STREAM_INDEX => Some(*stream),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no directory body in {events:?}"));

    let data = events
        .iter()
        .find_map(|e| match e {
            FileEvent::Data { stream, data } if *stream == body => Some(data.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no listing payload in {events:?}"));

    let parsed: serde_json::Value =
        serde_json::from_slice(&data).expect("listing must be valid JSON");
    assert!(parsed.is_object(), "listing must be an object: {parsed}");
    for (path, mimetype) in parsed.as_object().expect("object") {
        assert!(path.starts_with('/'), "path must be absolute: {path}");
        assert!(
            mimetype.is_string(),
            "mimetype must be a string: {mimetype}"
        );
    }
    assert!(
        events.iter().any(|e| matches!(e, FileEvent::End { .. })),
        "listing stream was never closed: {events:?}"
    );
}

/// A round trip proves the upload flushed before its handle closed and
/// that the download's ack-driven chunking reassembles in order.
#[tokio::test]
#[ignore = "needs a live sshd"]
async fn a_file_survives_being_uploaded_and_read_back() {
    let mut engine = connect().await;
    drain(&mut engine).await;

    // Larger than one chunk, so the ack loop has to run more than once.
    let payload: Vec<u8> = (0..10_000u32).map(|i| (i % 251) as u8).collect();
    let name = "/strata-sftp-live.bin";

    send(
        &mut engine,
        FileRequest::Put {
            object: 1,
            stream: 7,
            mimetype: "application/octet-stream".to_owned(),
            name: name.to_owned(),
        },
    )
    .await;
    drain(&mut engine).await;

    for chunk in payload.chunks(3000) {
        send(
            &mut engine,
            FileRequest::Data {
                stream: 7,
                data: Bytes::copy_from_slice(chunk),
            },
        )
        .await;
        drain(&mut engine).await;
    }
    send(&mut engine, FileRequest::End { stream: 7 }).await;
    let (message, ok) = notice(&mut engine).await;
    assert!(ok, "upload failed: {message}");

    send(
        &mut engine,
        FileRequest::Get {
            object: 1,
            name: name.to_owned(),
        },
    )
    .await;
    let opened = drain(&mut engine).await;
    let stream = opened
        .iter()
        .find_map(|e| match e {
            FileEvent::Body {
                stream, mimetype, ..
            } if mimetype != STREAM_INDEX => Some(*stream),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no file body in {opened:?}"));

    // The client acks `body` before any data, and each chunk after.
    let mut received = Vec::new();
    loop {
        send(&mut engine, FileRequest::Ack { stream, status: 0 }).await;
        let events = drain(&mut engine).await;
        let mut finished = false;
        for event in events {
            match event {
                FileEvent::Data { data, .. } => received.extend_from_slice(&data),
                FileEvent::End { .. } => finished = true,
                _ => {}
            }
        }
        if finished {
            break;
        }
        assert!(
            received.len() <= payload.len(),
            "download overran the file it was reading"
        );
    }

    assert_eq!(received.len(), payload.len(), "wrong length read back");
    assert_eq!(received, payload, "contents differ after a round trip");
}

/// The containment check is unit-tested against canonical paths; this
/// proves the engine actually applies it to what a client sends.
#[tokio::test]
#[ignore = "needs a live sshd"]
async fn a_traversal_out_of_the_root_is_refused() {
    let mut engine = connect_with("/tmp", |_| {}).await;
    drain(&mut engine).await;

    send(
        &mut engine,
        FileRequest::Get {
            object: 1,
            name: "/../etc/passwd".to_owned(),
        },
    )
    .await;
    let events = drain(&mut engine).await;

    assert!(
        events
            .iter()
            .any(|e| matches!(e, FileEvent::Ack { status, .. } if *status != 0)),
        "traversal was not refused: {events:?}"
    );
    assert!(
        !events.iter().any(|e| matches!(e, FileEvent::Body { .. })),
        "traversal opened a stream: {events:?}"
    );
}

#[tokio::test]
#[ignore = "needs a live sshd"]
async fn downloads_can_be_turned_off() {
    let mut engine = connect_with("/tmp", |c| c.disable_download = true).await;
    drain(&mut engine).await;

    send(
        &mut engine,
        FileRequest::Get {
            object: 1,
            name: "/".to_owned(),
        },
    )
    .await;
    // A directory listing is not a download, so browsing still works.
    let events = drain(&mut engine).await;
    assert!(
        events.iter().any(|e| matches!(
            e,
            FileEvent::Body { mimetype, .. } if mimetype == STREAM_INDEX
        )),
        "listing should still be allowed: {events:?}"
    );
}

#[tokio::test]
#[ignore = "needs a live sshd"]
async fn uploads_can_be_turned_off() {
    let mut engine = connect_with("/tmp", |c| c.disable_upload = true).await;
    drain(&mut engine).await;

    send(
        &mut engine,
        FileRequest::Put {
            object: 1,
            stream: 3,
            mimetype: "application/octet-stream".to_owned(),
            name: "/strata-should-not-exist.bin".to_owned(),
        },
    )
    .await;
    let events = drain(&mut engine).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(e, FileEvent::Ack { status, .. } if *status != 0)),
        "upload was not refused: {events:?}"
    );
}

async fn put(engine: &mut SftpEngine, stream: i32, name: &str) -> Vec<FileEvent> {
    send(
        engine,
        FileRequest::Put {
            object: 1,
            stream,
            mimetype: "application/octet-stream".to_owned(),
            name: name.to_owned(),
        },
    )
    .await;
    drain(engine).await
}

/// The fixture plants `/tmp/strata-link.txt -> /home/strata/outside.txt`.
/// Following it would write outside the configured root.
#[tokio::test]
#[ignore = "needs a live sshd"]
async fn an_upload_over_a_symlink_is_refused() {
    let mut engine = connect().await;
    drain(&mut engine).await;

    let events = put(&mut engine, 5, "/strata-link.txt").await;
    assert!(
        events
            .iter()
            .any(|e| matches!(e, FileEvent::Ack { status, .. } if *status != 0)),
        "upload through a symlink was not refused: {events:?}"
    );
}

/// Replacing an existing regular file still works after the no-follow change.
#[tokio::test]
#[ignore = "needs a live sshd"]
async fn an_existing_file_can_be_replaced() {
    let mut engine = connect().await;
    drain(&mut engine).await;

    for stream in [11, 12] {
        let events = put(&mut engine, stream, "/strata-replace.bin").await;
        assert!(
            events
                .iter()
                .any(|e| matches!(e, FileEvent::Ack { status: 0, .. })),
            "upload {stream} was refused: {events:?}"
        );
        send(
            &mut engine,
            FileRequest::Data {
                stream,
                data: Bytes::from_static(b"x"),
            },
        )
        .await;
        send(&mut engine, FileRequest::End { stream }).await;
        let (message, ok) = notice(&mut engine).await;
        assert!(ok, "upload {stream} failed: {message}");
    }
}

/// A refused upload never reaches the target, and the user is told why.
#[tokio::test]
#[ignore = "needs a live sshd"]
async fn a_refused_upload_is_not_written() {
    let mut engine = connect_with("/tmp", |c| c.gate = Some(Arc::new(Refuse))).await;
    drain(&mut engine).await;

    let name = "/strata-refused.bin";
    put(&mut engine, 21, name).await;
    send(
        &mut engine,
        FileRequest::Data {
            stream: 21,
            data: Bytes::from_static(b"EICAR"),
        },
    )
    .await;
    send(&mut engine, FileRequest::End { stream: 21 }).await;
    let (message, ok) = notice(&mut engine).await;
    assert!(!ok && message.contains("infected"), "{message}");

    send(
        &mut engine,
        FileRequest::Get {
            object: 1,
            name: name.to_owned(),
        },
    )
    .await;
    let events = drain(&mut engine).await;
    assert!(
        !events.iter().any(|e| matches!(e, FileEvent::Body { .. })),
        "refused upload reached the target: {events:?}"
    );
}

/// A withheld download sends no bytes, only the reason.
#[tokio::test]
#[ignore = "needs a live sshd"]
async fn a_withheld_download_sends_nothing() {
    let mut engine = connect_with("/tmp", |_| {}).await;
    drain(&mut engine).await;
    put(&mut engine, 31, "/strata-withheld.bin").await;
    send(
        &mut engine,
        FileRequest::Data {
            stream: 31,
            data: Bytes::from_static(b"secret"),
        },
    )
    .await;
    send(&mut engine, FileRequest::End { stream: 31 }).await;
    assert!(notice(&mut engine).await.1);

    let mut engine = connect_with("/tmp", |c| c.gate = Some(Arc::new(Refuse))).await;
    drain(&mut engine).await;
    send(
        &mut engine,
        FileRequest::Get {
            object: 1,
            name: "/strata-withheld.bin".to_owned(),
        },
    )
    .await;
    let (message, ok) = notice(&mut engine).await;
    assert!(!ok && message.contains("approval"), "{message}");
    let events = drain(&mut engine).await;
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, FileEvent::Body { .. } | FileEvent::Data { .. })),
        "withheld download sent bytes: {events:?}"
    );
}
