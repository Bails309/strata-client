//! Live SSH tests against a real OpenSSH server.
//!
//! Everything else in this crate is verified against mocks. These tests
//! exist because mocks cannot tell you whether `russh` negotiates with a
//! real sshd, whether the PTY actually resizes, or whether a keysym
//! translated by [`strata_session::engine::ssh::keymap`] arrives at the
//! remote shell as the character the user pressed.
//!
//! They are `#[ignore]`d because they need a target. To run them:
//!
//! ```text
//! docker compose -f docker-compose.session-test.yml up -d --build
//! FP=$(docker exec strata-ssh-target \
//!        ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}')
//! docker run --rm --network strata-session-test-net \
//!     -v "$PWD:/w" -w /w -e CARGO_TARGET_DIR=/tmp/target \
//!     -e STRATA_SSH_TEST_HOST=strata-ssh-target \
//!     -e STRATA_SSH_TEST_USER=strata \
//!     -e STRATA_SSH_TEST_PASSWORD=strata-test-password \
//!     -e STRATA_SSH_TEST_FINGERPRINT="$FP" \
//!     rust:1.98-slim-trixie \
//!     cargo test -p strata-session --all-features --test ssh_live -- --ignored
//! docker compose -f docker-compose.session-test.yml down -v
//! ```

#![cfg(feature = "ssh")]

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use secrecy::SecretString;
use strata_session::engine::ssh::{SshConfig, SshEngine};
use strata_session::engine::{InputEvent, Protocol, ProtocolEngine, TargetEvent, TargetSpec};
use strata_session::EngineError;

/// Long enough to absorb a slow container, short enough that a hang is a
/// test failure rather than a hung CI job.
const IO_TIMEOUT: Duration = Duration::from_secs(20);

fn required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| {
        panic!(
            "{name} is not set — these tests need a live sshd; see the module \
             header for the docker compose invocation"
        )
    })
}

fn spec(password: &str) -> TargetSpec {
    TargetSpec {
        connect_addr: None,
        protocol: Protocol::Ssh,
        hostname: required("STRATA_SSH_TEST_HOST"),
        port: std::env::var("STRATA_SSH_TEST_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(22),
        username: required("STRATA_SSH_TEST_USER"),
        secret: SecretString::from(password.to_owned()),
        width: 640,
        height: 384,
    }
}

fn config(fingerprint: &str) -> Arc<SshConfig> {
    Arc::new(SshConfig::with_fingerprints(vec![fingerprint.to_owned()]))
}

async fn connect() -> SshEngine {
    let password = required("STRATA_SSH_TEST_PASSWORD");
    let fingerprint = required("STRATA_SSH_TEST_FINGERPRINT");
    SshEngine::connect(spec(&password), config(&fingerprint))
        .await
        .expect("connecting to the test sshd")
}

/// Pump the engine until its accumulated output contains `needle`.
async fn read_until(engine: &mut SshEngine, needle: &str) -> String {
    let mut seen = String::new();
    let outcome = tokio::time::timeout(IO_TIMEOUT, async {
        loop {
            match engine.next_event().await {
                Ok(Some(TargetEvent::TerminalOutput(bytes))) => {
                    seen.push_str(&String::from_utf8_lossy(&bytes));
                    if seen.contains(needle) {
                        return Ok::<_, EngineError>(());
                    }
                }
                Ok(Some(TargetEvent::Disconnected { reason, .. })) => {
                    panic!("target disconnected while waiting for {needle:?}: {reason}\n{seen}")
                }
                Ok(Some(_)) => {}
                Ok(None) => panic!("stream ended while waiting for {needle:?}\n{seen}"),
                Err(err) => return Err(err),
            }
        }
    })
    .await;

    match outcome {
        Ok(Ok(())) => seen,
        Ok(Err(err)) => panic!("engine error while waiting for {needle:?}: {err}\n{seen}"),
        Err(_) => panic!("timed out waiting for {needle:?}; saw:\n{seen}"),
    }
}

async fn type_line(engine: &mut SshEngine, line: &str) {
    engine
        .handle_input(InputEvent::Text(Bytes::from(format!("{line}\n"))))
        .await
        .expect("sending shell input");
}

#[tokio::test]
#[ignore = "needs a live sshd; see the module header"]
async fn opens_a_shell_and_round_trips_a_command() {
    let mut engine = connect().await;
    assert_eq!(engine.protocol(), Protocol::Ssh);

    type_line(&mut engine, "echo STRATA_ROUNDTRIP_OK").await;
    let seen = read_until(&mut engine, "STRATA_ROUNDTRIP_OK").await;
    assert!(seen.contains("STRATA_ROUNDTRIP_OK"));

    engine.shutdown().await.expect("clean shutdown");
}

#[tokio::test]
#[ignore = "needs a live sshd; see the module header"]
async fn keysyms_arrive_at_the_shell_as_typed_characters() {
    let mut engine = connect().await;

    // Drive the keymap end to end rather than writing bytes directly:
    // this is the path a browser actually takes.
    //
    // The empty quotes matter. The shell echoes back what was typed
    // (`echo KEY''SYM_OK`) *and* prints the result (`KEYSYM_OK`), so
    // without them a match could be satisfied by the terminal echo
    // alone and would prove only that bytes arrived, not that the shell
    // understood them.
    for ch in "echo KEY''SYM_OK".chars() {
        let keysym = u32::from(ch);
        engine
            .handle_input(InputEvent::Key {
                keysym,
                pressed: true,
            })
            .await
            .expect("key press");
        engine
            .handle_input(InputEvent::Key {
                keysym,
                pressed: false,
            })
            .await
            .expect("key release");
    }
    // Return.
    engine
        .handle_input(InputEvent::Key {
            keysym: 0xff0d,
            pressed: true,
        })
        .await
        .expect("return key");

    let seen = read_until(&mut engine, "KEYSYM_OK").await;
    assert!(
        seen.contains("KEY''SYM_OK"),
        "the shell never echoed the typed characters, saw:\n{seen}"
    );

    engine.shutdown().await.expect("clean shutdown");
}

#[tokio::test]
#[ignore = "needs a live sshd; see the module header"]
async fn ctrl_c_reaches_the_shell_as_an_interrupt() {
    let mut engine = connect().await;

    type_line(&mut engine, "sleep 60").await;
    // Give the shell a moment to actually start sleeping.
    tokio::time::sleep(Duration::from_millis(500)).await;

    engine
        .handle_input(InputEvent::Key {
            keysym: 0xffe3, // Control_L down
            pressed: true,
        })
        .await
        .expect("ctrl down");
    engine
        .handle_input(InputEvent::Key {
            keysym: u32::from('c'),
            pressed: true,
        })
        .await
        .expect("ctrl+c");

    // If the interrupt did not land, `sleep 60` outlives the timeout.
    type_line(&mut engine, "echo INTERRUPT_OK").await;
    read_until(&mut engine, "INTERRUPT_OK").await;

    engine.shutdown().await.expect("clean shutdown");
}

#[tokio::test]
#[ignore = "needs a live sshd; see the module header"]
async fn a_client_resize_reaches_the_remote_pty() {
    let mut engine = connect().await;

    // 800x480 pixels at the default 8x16 cell is a 100x30 grid.
    engine
        .handle_input(InputEvent::Resize {
            width: 800,
            height: 480,
            dpi: None,
        })
        .await
        .expect("resize");

    // Ask the target itself what geometry it thinks it has.
    type_line(&mut engine, "stty size").await;
    let seen = read_until(&mut engine, "30 100").await;
    assert!(
        seen.contains("30 100"),
        "remote pty did not adopt the resized geometry, saw:\n{seen}"
    );

    engine.shutdown().await.expect("clean shutdown");
}

#[tokio::test]
#[ignore = "needs a live sshd; see the module header"]
async fn refuses_a_host_key_that_is_not_pinned() {
    let password = required("STRATA_SSH_TEST_PASSWORD");
    // A syntactically valid but wrong fingerprint.
    let wrong = config("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

    let result = SshEngine::connect(spec(&password), wrong).await;
    // Must fail at key exchange, before the password is ever offered.
    assert!(
        matches!(
            result,
            Err(EngineError::Protocol(_) | EngineError::Transport(_))
        ),
        "expected a host-key failure, got {:?}",
        result.err()
    );
}

#[tokio::test]
#[ignore = "needs a live sshd; see the module header"]
async fn refuses_to_connect_with_no_pinned_host_key() {
    let password = required("STRATA_SSH_TEST_PASSWORD");
    let empty = Arc::new(SshConfig::with_fingerprints(vec![]));

    let result = SshEngine::connect(spec(&password), empty).await;
    assert!(
        matches!(
            result,
            Err(EngineError::Protocol(_) | EngineError::Transport(_))
        ),
        "an empty allow-list must reject every host, got {:?}",
        result.err()
    );
}

#[tokio::test]
#[ignore = "needs a live sshd; see the module header"]
async fn rejects_a_bad_password() {
    let fingerprint = required("STRATA_SSH_TEST_FINGERPRINT");
    let result =
        SshEngine::connect(spec("definitely-not-the-password"), config(&fingerprint)).await;

    assert!(
        matches!(result, Err(EngineError::AuthRejected)),
        "expected AuthRejected, got {:?}",
        result.err()
    );
}

#[tokio::test]
#[ignore = "needs a live sshd; see the module header"]
async fn a_remote_exit_ends_the_session() {
    let mut engine = connect().await;

    type_line(&mut engine, "exit").await;

    let outcome = tokio::time::timeout(IO_TIMEOUT, async {
        loop {
            match engine.next_event().await {
                Ok(Some(TargetEvent::Disconnected { reason, .. })) => return reason,
                Ok(Some(_)) => {}
                Ok(None) => panic!("stream ended without a Disconnected event"),
                Err(err) => panic!("engine error: {err}"),
            }
        }
    })
    .await;

    let reason = outcome.expect("timed out waiting for the shell to exit");
    assert!(
        reason.contains("exited"),
        "unexpected disconnect reason: {reason}"
    );
}

#[cfg(feature = "terminal")]
#[tokio::test]
#[ignore = "needs a live sshd; see the module header"]
async fn real_shell_output_rasterises_to_png_frames() {
    use strata_session::terminal::{RasterisingEngine, TerminalFont, DEFAULT_FONT_SIZE_PX};

    let font = TerminalFont::discover(DEFAULT_FONT_SIZE_PX)
        .expect("a monospace font must be installed to render terminal sessions");
    let engine = connect().await;
    let mut rendering = RasterisingEngine::new(Box::new(engine), font, 640, 384);

    // The layer geometry always precedes any drawing.
    let first = rendering
        .next_event()
        .await
        .expect("first event")
        .expect("stream open");
    assert!(matches!(first, TargetEvent::Resized { .. }));

    rendering
        .handle_input(InputEvent::Text(Bytes::from_static(b"echo RASTER_OK\n")))
        .await
        .expect("shell input");

    let frame = tokio::time::timeout(IO_TIMEOUT, async {
        loop {
            if let Ok(Some(TargetEvent::ImageUpdate { data, mimetype, .. })) =
                rendering.next_event().await
            {
                return (data, mimetype);
            }
        }
    })
    .await
    .expect("timed out waiting for a rendered frame");

    assert_eq!(frame.1, "image/png");
    assert_eq!(&frame.0[..8], b"\x89PNG\r\n\x1a\n");

    rendering.shutdown().await.expect("clean shutdown");
}
