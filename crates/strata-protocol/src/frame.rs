//! Length-prefixed JSON frame codec used during the link handshake.
//!
//! Each frame on the wire is:
//!
//! ```text
//!   [u32 big-endian payload length] [payload bytes (JSON)]
//! ```
//!
//! This codec is used **only** for the handshake. Once the link is up
//! the wire switches to HTTP/2 (Phase 1c). Keeping the handshake on a
//! simpler framing means we can debug the auth flow without an h2
//! decoder in the loop.

use serde::{de::DeserializeOwned, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::errors::ProtocolError;

/// Hard cap on a single frame's payload length. The handshake messages
/// are tiny (well under 1 KiB); anything larger is treated as either a
/// protocol bug or an attack.
pub const MAX_FRAME_PAYLOAD: usize = 64 * 1024;

/// Serialise `msg` and write a single length-prefixed JSON frame.
pub async fn write_frame<W, T>(w: &mut W, msg: &T) -> Result<(), ProtocolError>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let body = serde_json::to_vec(msg)
        .map_err(|e| ProtocolError::Malformed(format!("serialize: {e}")))?;
    if body.len() > MAX_FRAME_PAYLOAD {
        return Err(ProtocolError::Malformed(format!(
            "frame too large: {} > {}",
            body.len(),
            MAX_FRAME_PAYLOAD
        )));
    }
    let len = (body.len() as u32).to_be_bytes();
    w.write_all(&len)
        .await
        .map_err(|e| ProtocolError::Malformed(format!("write len: {e}")))?;
    w.write_all(&body)
        .await
        .map_err(|e| ProtocolError::Malformed(format!("write body: {e}")))?;
    w.flush()
        .await
        .map_err(|e| ProtocolError::Malformed(format!("flush: {e}")))?;
    Ok(())
}

/// Read a single length-prefixed JSON frame, deserialising it as `T`.
pub async fn read_frame<R, T>(r: &mut R) -> Result<T, ProtocolError>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf)
        .await
        .map_err(|e| ProtocolError::Malformed(format!("read len: {e}")))?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_FRAME_PAYLOAD {
        return Err(ProtocolError::Malformed(format!(
            "incoming frame too large: {len} > {MAX_FRAME_PAYLOAD}"
        )));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)
        .await
        .map_err(|e| ProtocolError::Malformed(format!("read body: {e}")))?;
    serde_json::from_slice(&body)
        .map_err(|e| ProtocolError::Malformed(format!("deserialize: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
    struct Msg {
        kind: String,
        n: u32,
    }

    #[tokio::test]
    async fn roundtrip() {
        let (mut a, mut b) = tokio::io::duplex(4096);
        let m = Msg {
            kind: "hello".into(),
            n: 42,
        };
        write_frame(&mut a, &m).await.unwrap();
        let r: Msg = read_frame(&mut b).await.unwrap();
        assert_eq!(r, m);
    }

    #[tokio::test]
    async fn rejects_oversized_outgoing() {
        let (mut a, _b) = tokio::io::duplex(4096);
        let big = Msg {
            kind: "x".repeat(MAX_FRAME_PAYLOAD + 1),
            n: 0,
        };
        assert!(matches!(
            write_frame(&mut a, &big).await,
            Err(ProtocolError::Malformed(_))
        ));
    }

    #[tokio::test]
    async fn rejects_oversized_incoming() {
        let (mut a, mut b) = tokio::io::duplex(4096);
        // Manually write a length prefix that exceeds the cap.
        let bad_len = ((MAX_FRAME_PAYLOAD as u32) + 1).to_be_bytes();
        a.write_all(&bad_len).await.unwrap();
        a.shutdown().await.ok();
        let r: Result<Msg, _> = read_frame(&mut b).await;
        assert!(matches!(r, Err(ProtocolError::Malformed(_))));
    }

    #[tokio::test]
    async fn rejects_truncated_frame() {
        let (mut a, mut b) = tokio::io::duplex(4096);
        a.write_all(&10u32.to_be_bytes()).await.unwrap();
        a.write_all(b"abc").await.unwrap();
        drop(a);
        let r: Result<Msg, _> = read_frame(&mut b).await;
        assert!(matches!(r, Err(ProtocolError::Malformed(_))));
    }
}
