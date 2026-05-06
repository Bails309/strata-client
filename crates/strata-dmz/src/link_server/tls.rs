//! TLS materials for the DMZ link server.
//!
//! The DMZ requires client authentication: only internal nodes that
//! present a cert chained to [`DmzConfig::link_ca_bundle_pem`] are
//! allowed to complete the TLS handshake. The system truststore is
//! intentionally not consulted — this is a private trust domain.

use std::sync::Arc;

use anyhow::{anyhow, Context};
use rustls::server::WebPkiClientVerifier;
use rustls::{RootCertStore, ServerConfig};
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::TlsAcceptor;

/// Build a [`TlsAcceptor`] that:
///
/// * presents the supplied server cert chain + key,
/// * REQUIRES a client cert chained to `client_ca_bundle_pem` (mTLS),
/// * uses rustls 0.23 with the ring provider (matching the rest of the
///   workspace),
/// * advertises ALPN `h2` only — anything that tries HTTP/1.1 on the
///   link port is rejected at TLS time.
pub fn build_acceptor(
    server_cert_pem: &[u8],
    server_key_pem: &[u8],
    client_ca_bundle_pem: &[u8],
) -> anyhow::Result<TlsAcceptor> {
    let server_chain: Vec<CertificateDer<'static>> =
        CertificateDer::pem_slice_iter(server_cert_pem)
            .collect::<Result<Vec<_>, _>>()
            .context("parse DMZ link server cert PEM")?;
    if server_chain.is_empty() {
        return Err(anyhow!("DMZ link server cert PEM contained no certificates"));
    }

    let server_key: PrivateKeyDer<'static> = PrivateKeyDer::from_pem_slice(server_key_pem)
        .context("parse DMZ link server key PEM")?;

    let mut roots = RootCertStore::empty();
    let cas: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(client_ca_bundle_pem)
        .collect::<Result<Vec<_>, _>>()
        .context("parse DMZ link client-CA bundle PEM")?;
    if cas.is_empty() {
        return Err(anyhow!(
            "DMZ link client-CA bundle PEM contained no certificates"
        ));
    }
    for c in cas {
        roots
            .add(c)
            .context("trust client-CA in DMZ link CA bundle")?;
    }

    let verifier = WebPkiClientVerifier::builder(Arc::new(roots))
        .build()
        .context("build mTLS client verifier")?;

    let mut cfg = ServerConfig::builder()
        .with_client_cert_verifier(verifier)
        .with_single_cert(server_chain, server_key)
        .context("install DMZ link server cert + key")?;
    // ALPN: link is h2-only. h2 0.4 negotiates over TLS via this
    // protocol identifier.
    cfg.alpn_protocols = vec![b"h2".to_vec()];

    Ok(TlsAcceptor::from(Arc::new(cfg)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<u8> {
        // Tiny self-signed pair generated with rcgen during fixture
        // setup would be ideal, but we keep this crate dep-light.
        // The TLS config tests live in the tls smoke-test in 2c when
        // the listener is wired up; here we only sanity-check parse
        // failure modes.
        match name {
            "empty" => Vec::new(),
            "junk" => b"-----BEGIN CERTIFICATE-----\nnot-base64-at-all\n-----END CERTIFICATE-----\n".to_vec(),
            _ => unreachable!(),
        }
    }

    #[test]
    fn rejects_empty_cert_pem() {
        let err = build_acceptor(&fixture("empty"), b"key", b"ca").unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains("server cert") || msg.contains("no certificates"),
            "unexpected error: {msg}"
        );
    }

    #[test]
    fn rejects_junk_cert_pem() {
        let err = build_acceptor(&fixture("junk"), b"key", b"ca").unwrap_err();
        let _ = format!("{err:#}");
    }
}
