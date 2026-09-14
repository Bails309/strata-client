//! KDC transport for Kerberos authentication.
//!
//! `ironrdp` drives CredSSP as a generator that suspends whenever it
//! needs to talk to a Key Distribution Centre, handing back a
//! [`NetworkRequest`] for the caller to service. Without an
//! implementation the connector can only do NTLM, so a target whose
//! domain requires Kerberos cannot be authenticated at all.
//!
//! ## Framing
//!
//! Deliberately mirrors `sspi`'s own reference client, because the
//! framing is asymmetric and easy to get subtly wrong:
//!
//! - **TCP** — `data` already carries its own 4-byte big-endian length
//!   prefix, so it is written verbatim. The reply must be handed back
//!   *including* a length prefix.
//! - **UDP** — datagrams carry no length, so the reply is given a
//!   synthetic prefix to match the shape TCP produces.
//!
//! Getting either wrong produces a KDC that appears to answer and an
//! ASN.1 parse failure several layers away.

use std::future::Future;
use std::pin::Pin;

use ironrdp_connector::{ConnectorError, ConnectorErrorKind, ConnectorResult};
use ironrdp_tokio::AsyncNetworkClient;
use sspi::generator::NetworkRequest;
use sspi::network_client::NetworkProtocol;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};

/// Default Kerberos port, used when the KDC URL omits one.
const DEFAULT_KDC_PORT: u16 = 88;

/// Largest KDC reply accepted, matching the default maximum token
/// length on Windows.
const MAX_KDC_REPLY: usize = 0xbb80;

/// Talks to a KDC over TCP or UDP on behalf of CredSSP.
#[derive(Debug, Default, Clone, Copy)]
pub struct KdcNetworkClient;

impl AsyncNetworkClient for KdcNetworkClient {
    fn send<'a>(
        &'a mut self,
        request: &'a NetworkRequest,
    ) -> Pin<Box<dyn Future<Output = ConnectorResult<Vec<u8>>> + 'a>> {
        Box::pin(async move {
            match request.protocol {
                NetworkProtocol::Tcp => send_tcp(request).await,
                NetworkProtocol::Udp => send_udp(request).await,
                // KDC Proxy (KKDCP) tunnels the same messages over HTTPS.
                // Refuse loudly rather than silently failing to
                // authenticate: an operator who configured a proxy URL
                // needs to know it is not honoured.
                NetworkProtocol::Http | NetworkProtocol::Https => Err(kdc_err(
                    "KDC Proxy (KKDCP) URLs are not supported; use tcp:// or udp://",
                )),
            }
        })
    }
}

fn kdc_err(message: &'static str) -> ConnectorError {
    ConnectorError::new(message, ConnectorErrorKind::General)
}

fn target(request: &NetworkRequest) -> String {
    format!(
        "{}:{}",
        request.url.host_str().unwrap_or_default(),
        request.url.port().unwrap_or(DEFAULT_KDC_PORT)
    )
}

async fn send_tcp(request: &NetworkRequest) -> ConnectorResult<Vec<u8>> {
    let mut stream = TcpStream::connect(target(request))
        .await
        .map_err(|_| kdc_err("cannot reach the KDC over TCP"))?;

    // `data` is already length-prefixed by sspi.
    stream
        .write_all(&request.data)
        .await
        .map_err(|_| kdc_err("failed writing to the KDC"))?;

    let mut length = [0u8; 4];
    stream
        .read_exact(&mut length)
        .await
        .map_err(|_| kdc_err("KDC closed before replying"))?;
    let len = u32::from_be_bytes(length) as usize;
    if len > MAX_KDC_REPLY {
        return Err(kdc_err("KDC reply exceeds the maximum token length"));
    }

    // The caller expects the length prefix to survive into the reply.
    let mut reply = vec![0u8; len + 4];
    reply[..4].copy_from_slice(&length);
    stream
        .read_exact(&mut reply[4..])
        .await
        .map_err(|_| kdc_err("truncated KDC reply"))?;
    Ok(reply)
}

async fn send_udp(request: &NetworkRequest) -> ConnectorResult<Vec<u8>> {
    // Bind on all interfaces: the KDC is remote, so a loopback-bound
    // socket would never receive the reply.
    let socket = UdpSocket::bind("0.0.0.0:0")
        .await
        .map_err(|_| kdc_err("cannot open a UDP socket for the KDC"))?;
    socket
        .send_to(&request.data, target(request))
        .await
        .map_err(|_| kdc_err("cannot reach the KDC over UDP"))?;

    let mut buf = vec![0u8; MAX_KDC_REPLY];
    let received = socket
        .recv(&mut buf)
        .await
        .map_err(|_| kdc_err("no reply from the KDC"))?;

    // Datagrams carry no length, so synthesise the prefix TCP would
    // have supplied.
    let mut reply = Vec::with_capacity(received + 4);
    reply.extend_from_slice(&(received as u32).to_be_bytes());
    reply.extend_from_slice(&buf[..received]);
    Ok(reply)
}
