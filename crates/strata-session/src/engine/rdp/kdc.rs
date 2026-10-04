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

use ironrdp_connector::{ConnectorError, ConnectorErrorKind, ConnectorResult};
use ironrdp_tokio::NetworkClient;
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

impl NetworkClient for KdcNetworkClient {
    async fn send(&mut self, request: &NetworkRequest) -> ConnectorResult<Vec<u8>> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    fn request(protocol: NetworkProtocol, url: &str, data: &[u8]) -> NetworkRequest {
        NetworkRequest {
            protocol,
            url: url.parse().unwrap(),
            data: data.to_vec(),
        }
    }

    /// A TCP KDC that records what it was sent and answers with `reply`.
    async fn tcp_kdc(reply: Vec<u8>) -> (String, tokio::task::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut length = [0u8; 4];
            stream.read_exact(&mut length).await.unwrap();
            let mut body = vec![0u8; u32::from_be_bytes(length) as usize];
            stream.read_exact(&mut body).await.unwrap();
            stream.write_all(&reply).await.unwrap();
            [length.as_slice(), &body].concat()
        });
        (format!("tcp://{addr}"), task)
    }

    #[test]
    fn a_kdc_url_without_a_port_uses_88() {
        let req = request(NetworkProtocol::Tcp, "tcp://kdc.example.test", b"");
        assert_eq!(target(&req), "kdc.example.test:88");
        let req = request(NetworkProtocol::Udp, "udp://kdc.example.test:750", b"");
        assert_eq!(target(&req), "kdc.example.test:750");
    }

    #[tokio::test]
    async fn tcp_sends_the_request_verbatim_and_keeps_the_reply_prefix() {
        let sent = [&5u32.to_be_bytes()[..], b"AS-RQ"].concat();
        let reply = [&5u32.to_be_bytes()[..], b"AS-RP"].concat();
        let (url, kdc) = tcp_kdc(reply.clone()).await;

        let got = KdcNetworkClient
            .send(&request(NetworkProtocol::Tcp, &url, &sent))
            .await
            .unwrap();

        assert_eq!(kdc.await.unwrap(), sent, "request must not be re-framed");
        assert_eq!(got, reply, "reply must keep its length prefix");
    }

    #[tokio::test]
    async fn tcp_refuses_a_reply_longer_than_the_token_limit() {
        let too_long = (MAX_KDC_REPLY as u32 + 1).to_be_bytes().to_vec();
        let (url, _kdc) = tcp_kdc(too_long).await;
        let sent = [&1u32.to_be_bytes()[..], b"x"].concat();
        assert!(KdcNetworkClient
            .send(&request(NetworkProtocol::Tcp, &url, &sent))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn tcp_reports_a_truncated_reply() {
        let short = [&10u32.to_be_bytes()[..], b"abc"].concat();
        let (url, _kdc) = tcp_kdc(short).await;
        let sent = [&1u32.to_be_bytes()[..], b"x"].concat();
        assert!(KdcNetworkClient
            .send(&request(NetworkProtocol::Tcp, &url, &sent))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn udp_replies_get_the_prefix_tcp_would_have_carried() {
        let kdc = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let url = format!("udp://{}", kdc.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut buf = [0u8; 64];
            let (n, peer) = kdc.recv_from(&mut buf).await.unwrap();
            kdc.send_to(b"TGS-RP", peer).await.unwrap();
            buf[..n].to_vec()
        });

        let got = KdcNetworkClient
            .send(&request(NetworkProtocol::Udp, &url, b"TGS-RQ"))
            .await
            .unwrap();

        assert_eq!(server.await.unwrap(), b"TGS-RQ");
        assert_eq!(got, [&6u32.to_be_bytes()[..], b"TGS-RP"].concat());
    }

    #[tokio::test]
    async fn kdc_proxy_urls_are_refused() {
        for (protocol, url) in [
            (NetworkProtocol::Http, "http://kdc.example.test/KdcProxy"),
            (NetworkProtocol::Https, "https://kdc.example.test/KdcProxy"),
        ] {
            let err = KdcNetworkClient
                .send(&request(protocol, url, b"x"))
                .await
                .unwrap_err();
            assert!(err.to_string().contains("KKDCP"), "{err}");
        }
    }
}
