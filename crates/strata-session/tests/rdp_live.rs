//! Live RDP tests.
//!
//! The SSH suite caught two assertions of mine that passed for the wrong
//! reason; RDP is the primary protocol, so it gets the same treatment.
//! Mocks cannot tell you whether CredSSP actually completes, whether the
//! server accepts our capability sets, or whether the framebuffer we
//! crop matches what the target drew.
//!
//! ## Two kinds of target
//!
//! **xrdp does not implement NLA server-side.** That makes it useless
//! for testing a successful session, and ideal for testing that the
//! engine refuses a target which will not do CredSSP — which is how the
//! `enable_tls: false` fail-closed behaviour got found in the first
//! place. `docker-compose.session-test.yml` provides it as
//! `STRATA_RDP_LEGACY_HOST`.
//!
//! The session tests need a target that speaks CredSSP, provided as
//! `STRATA_RDP_TEST_HOST` by FreeRDP's shadow server. Windows is not an
//! option here: Windows containers require a Windows container host and
//! ship no RDP server, and running Windows in a VM would need KVM
//! passthrough and a licensed multi-gigabyte image. The shadow server
//! performs the same CredSSP handshake, which is the part that matters.
//!
//! ```text
//! docker compose -f docker-compose.session-test.yml up -d --build
//! docker run --rm --network strata-session-test-net \
//!     -v "$PWD:/w" -w /w -e CARGO_TARGET_DIR=/tmp/target \
//!     -e STRATA_RDP_TEST_HOST=strata-rdp-target \
//!     -e STRATA_RDP_LEGACY_HOST=strata-rdp-legacy \
//!     -e STRATA_RDP_TEST_USER=strata \
//!     -e STRATA_RDP_TEST_PASSWORD=strata-test-password \
//!     rust:1.99-slim-trixie \
//!     cargo test -p strata-session --all-features --test rdp_live -- --ignored
//! docker compose -f docker-compose.session-test.yml down -v
//! ```

#![cfg(feature = "rdp")]

use std::time::Duration;

use secrecy::SecretString;
use strata_session::engine::rdp::{RdpConfig, RdpEngine};
use strata_session::engine::{InputEvent, Protocol, ProtocolEngine, TargetEvent, TargetSpec};
use strata_session::EngineError;

/// The RDP connection sequence plus CredSSP is slower than SSH auth, and
/// xrdp has to spawn an X session on top.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(45);

fn required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| {
        panic!(
            "{name} is not set — these tests need a live RDP server; see the \
             module header for the docker compose invocation"
        )
    })
}

fn spec(password: &str) -> TargetSpec {
    spec_for(&required("STRATA_RDP_TEST_HOST"), password)
}

fn spec_for(host: &str, password: &str) -> TargetSpec {
    TargetSpec {
        connect_addr: None,
        protocol: Protocol::Rdp,
        hostname: host.to_owned(),
        port: std::env::var("STRATA_RDP_TEST_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(3389),
        username: required("STRATA_RDP_TEST_USER"),
        secret: SecretString::from(password.to_owned()),
        width: 1024,
        height: 768,
    }
}

async fn connect() -> RdpEngine {
    let password = required("STRATA_RDP_TEST_PASSWORD");
    tokio::time::timeout(
        CONNECT_TIMEOUT,
        RdpEngine::connect(spec(&password), &RdpConfig::default()),
    )
    .await
    .expect("timed out connecting to the test RDP server")
    .expect("connecting to the test RDP server")
}

/// Pump until an image update arrives, or fail with what was seen.
async fn first_image(engine: &mut RdpEngine) -> (i32, i32, Vec<u8>) {
    let mut seen = Vec::new();
    let outcome = tokio::time::timeout(CONNECT_TIMEOUT, async {
        loop {
            match engine.next_event().await {
                Ok(Some(TargetEvent::ImageUpdate { x, y, data, .. })) => {
                    return Ok((x, y, data.to_vec()))
                }
                Ok(Some(TargetEvent::Disconnected { reason, .. })) => {
                    return Err(format!("disconnected before any frame: {reason}"))
                }
                Ok(Some(other)) => {
                    seen.push(format!("{other:?}").chars().take(80).collect::<String>())
                }
                Ok(None) => return Err("stream ended before any frame".to_owned()),
                Err(err) => return Err(format!("engine error: {err}")),
            }
        }
    })
    .await;

    match outcome {
        Ok(Ok(frame)) => frame,
        Ok(Err(why)) => panic!("{why}; saw: {seen:?}"),
        Err(_) => panic!("timed out waiting for a frame; saw: {seen:?}"),
    }
}

#[tokio::test]
#[ignore = "needs a live RDP server; see the module header"]
async fn completes_credssp_and_reaches_the_active_stage() {
    let engine = connect().await;
    assert_eq!(engine.protocol(), Protocol::Rdp);

    let (width, height) = engine.desktop_size();
    assert!(
        width >= 200 && height >= 200,
        "implausible negotiated desktop: {width}x{height}"
    );
}

#[tokio::test]
#[ignore = "needs a live RDP server; see the module header"]
async fn the_layer_size_precedes_any_drawing() {
    let mut engine = connect().await;

    // A client that receives an image before the layer is sized draws
    // onto a default-sized canvas and clips the session.
    let first = tokio::time::timeout(CONNECT_TIMEOUT, engine.next_event())
        .await
        .expect("timed out")
        .expect("engine error")
        .expect("stream open");

    let TargetEvent::Resized { width, height } = first else {
        panic!("expected the desktop size first, got {first:?}");
    };
    assert_eq!((width, height), {
        let (w, h) = engine.desktop_size();
        (w, h)
    });
}

#[tokio::test]
#[ignore = "needs a live RDP server; see the module header"]
async fn the_server_draws_real_png_frames() {
    let mut engine = connect().await;
    let (x, y, png) = first_image(&mut engine).await;

    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "not a PNG");
    assert!(x >= 0 && y >= 0, "negative frame origin {x},{y}");

    // The IHDR dimensions must fall inside the negotiated desktop, which
    // is what proves the crop maths against a real framebuffer.
    let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
    let (desktop_w, desktop_h) = engine.desktop_size();
    assert!(width > 0 && height > 0);
    assert!(
        x as u32 + width <= desktop_w && y as u32 + height <= desktop_h,
        "frame {width}x{height} at {x},{y} escapes the {desktop_w}x{desktop_h} desktop"
    );
}

#[tokio::test]
#[ignore = "needs a live RDP server; see the module header"]
async fn input_is_accepted_by_the_target() {
    let mut engine = connect().await;
    // Wait for the session to settle before typing at it.
    let _ = first_image(&mut engine).await;

    engine
        .handle_input(InputEvent::Mouse {
            x: 100,
            y: 100,
            mask: 0,
        })
        .await
        .expect("pointer move");

    for keysym in "echo".chars().map(u32::from) {
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

    // The session must still be producing frames rather than having
    // failed on the input PDUs.
    let _ = first_image(&mut engine).await;
}

#[tokio::test]
#[ignore = "needs a live RDP server; see the module header"]
async fn refuses_a_target_that_will_not_do_nla() {
    // The engine advertises CredSSP and nothing else. A server that
    // answers with the legacy security layer must be refused *before* a
    // session exists: on that layer the connection succeeds and the
    // credential is only checked later, on an in-session login screen,
    // so a gateway would report a healthy authenticated session for a
    // password it never validated. This test exists because that is
    // exactly what happened before `enable_tls` was turned off.
    let host = required("STRATA_RDP_LEGACY_HOST");
    let password = required("STRATA_RDP_TEST_PASSWORD");

    let result = tokio::time::timeout(
        CONNECT_TIMEOUT,
        RdpEngine::connect(spec_for(&host, &password), &RdpConfig::default()),
    )
    .await
    .expect("timed out");

    let err = result
        .err()
        .expect("connected to a target that does not support NLA");
    let text = err.to_string();
    assert!(
        text.contains("STANDARD_RDP_SECURITY") || text.contains("HYBRID"),
        "expected a security-negotiation refusal, got: {text}"
    );
}

#[tokio::test]
#[ignore = "needs a live RDP server; see the module header"]
async fn rejects_a_bad_password() {
    let host = std::env::var("STRATA_RDP_TEST_HOST")
        .or_else(|_| std::env::var("STRATA_RDP_LEGACY_HOST"))
        .expect("set STRATA_RDP_TEST_HOST or STRATA_RDP_LEGACY_HOST");

    let result = tokio::time::timeout(
        CONNECT_TIMEOUT,
        RdpEngine::connect(
            spec_for(&host, "definitely-not-the-password"),
            &RdpConfig::default(),
        ),
    )
    .await
    .expect("timed out");

    // Anything reporting success here would mean the credential reached
    // no authenticator.
    assert!(
        result.is_err(),
        "connected to an RDP target with the wrong password"
    );
    let err = result.err().unwrap();
    assert!(
        matches!(err, EngineError::AuthRejected | EngineError::Protocol(_)),
        "unexpected error for a bad password: {err:?}"
    );
}

#[tokio::test]
#[ignore = "needs a live RDP server; see the module header"]
async fn a_client_disconnect_ends_the_session() {
    let mut engine = connect().await;
    let _ = first_image(&mut engine).await;

    engine
        .handle_input(InputEvent::Disconnect)
        .await
        .expect("disconnect");

    let outcome = tokio::time::timeout(CONNECT_TIMEOUT, async {
        loop {
            match engine.next_event().await {
                Ok(Some(TargetEvent::Disconnected { reason, .. })) => return reason,
                Ok(Some(_)) => {}
                Ok(None) => return "stream ended".to_owned(),
                Err(err) => panic!("engine error: {err}"),
            }
        }
    })
    .await;

    assert!(outcome.is_ok(), "session did not end after a disconnect");
    engine.shutdown().await.expect("clean shutdown");
}
