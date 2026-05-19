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
        return Err(anyhow!(
            "DMZ link server cert PEM contained no certificates"
        ));
    }

    let server_key: PrivateKeyDer<'static> =
        PrivateKeyDer::from_pem_slice(server_key_pem).context("parse DMZ link server key PEM")?;

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

    // The link channel is a fully-controlled internal trust domain;
    // pin TLS 1.3 only. Strata internal nodes are built against the
    // same rustls (0.23) and always negotiate 1.3, so we drop 1.2
    // entirely to remove its weaker AEAD modes from the attack
    // surface (CVE-2013-0169 etc.).
    let cfg = ServerConfig::builder_with_protocol_versions(&[&rustls::version::TLS13])
        .with_client_cert_verifier(verifier)
        .with_single_cert(server_chain, server_key)
        .context("install DMZ link server cert + key")?;
    let mut cfg = cfg;
    // ALPN: link is h2-only. h2 0.4 negotiates over TLS via this
    // protocol identifier.
    cfg.alpn_protocols = vec![b"h2".to_vec()];

    // Disable TLS 1.3 session resumption (PSK tickets). On resumption,
    // rustls does NOT re-present the client certificate, which would
    // silently weaken our mTLS guarantee from "every connection
    // verifies the cert chain" to "every fresh handshake verifies it,
    // and resumed ones inherit trust from a captured ticket". For a
    // private trust domain that already needs full handshake on
    // every connect, the ticket round-trip saves us nothing.
    cfg.session_storage = Arc::new(rustls::server::NoServerSessionStorage {});
    cfg.send_tls13_tickets = 0;

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
            "junk" => {
                b"-----BEGIN CERTIFICATE-----\nnot-base64-at-all\n-----END CERTIFICATE-----\n"
                    .to_vec()
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn rejects_empty_cert_pem() {
        let err = match build_acceptor(&fixture("empty"), b"key", b"ca") {
            Ok(_) => panic!("expected build_acceptor to fail on empty cert PEM"),
            Err(e) => e,
        };
        let msg = format!("{err:#}");
        assert!(
            msg.contains("server cert") || msg.contains("no certificates"),
            "unexpected error: {msg}"
        );
    }

    #[test]
    fn rejects_junk_cert_pem() {
        let err = match build_acceptor(&fixture("junk"), b"key", b"ca") {
            Ok(_) => panic!("expected build_acceptor to fail on junk cert PEM"),
            Err(e) => e,
        };
        let _ = format!("{err:#}");
    }
}
