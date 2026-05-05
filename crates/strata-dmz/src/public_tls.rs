//! TLS material for the public listener.
//!
//! The public listener is the *unauthenticated* internet-facing
//! surface. Unlike the link listener, we MUST NOT require client
//! certificates — random browsers and HTTP clients have none. The
//! ALPN list intentionally advertises `h2` and `http/1.1` so both
//! HTTP/1.1 and HTTP/2 public clients work.

use std::io::{BufReader, Cursor};
use std::sync::Arc;

use anyhow::{anyhow, Context};
use rustls::ServerConfig;
use rustls_pemfile::{certs, private_key};
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::TlsAcceptor;

/// Build a [`TlsAcceptor`] for the public listener:
///
/// * presents the supplied server cert chain + key,
/// * does NOT request a client cert,
/// * advertises ALPN `h2` then `http/1.1`.
pub fn build_public_acceptor(
    server_cert_pem: &[u8],
    server_key_pem: &[u8],
) -> anyhow::Result<TlsAcceptor> {
    let server_chain: Vec<CertificateDer<'static>> =
        certs(&mut BufReader::new(Cursor::new(server_cert_pem)))
            .collect::<Result<Vec<_>, _>>()
            .context("parse DMZ public TLS cert PEM")?;
    if server_chain.is_empty() {
        return Err(anyhow!("DMZ public TLS cert PEM contained no certificates"));
    }

    let server_key: PrivateKeyDer<'static> =
        private_key(&mut BufReader::new(Cursor::new(server_key_pem)))
            .context("parse DMZ public TLS key PEM")?
            .ok_or_else(|| anyhow!("DMZ public TLS key PEM contained no private key"))?;

    let mut cfg = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(server_chain, server_key)
        .context("install DMZ public TLS cert + key")?;
    // ALPN: prefer h2, fall back to HTTP/1.1.
    cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];

    Ok(TlsAcceptor::from(Arc::new(cfg)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_cert_pem() {
        let err = build_public_acceptor(b"", b"-----BEGIN PRIVATE KEY-----\n").unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("no certificates"), "got: {msg}");
    }

    #[test]
    fn rejects_junk_pem() {
        let err = build_public_acceptor(b"not a pem", b"not a key").unwrap_err();
        let _ = err; // any error is acceptable
    }
}
