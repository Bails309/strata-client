//! TLS pieces shared by the engines that drive rustls directly.
//!
//! Deliberately one implementation of the accept-anything verifier
//! rather than one per engine: a second copy is a second thing to audit,
//! and the one that gets forgotten is the one that stops honouring a
//! connection's certificate policy.

use std::io;

use tokio_rustls::rustls::client::danger::{
    HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
};
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use tokio_rustls::rustls::{self, DigitallySignedStruct, RootCertStore, SignatureScheme};

/// Load the system trust store, failing when it is empty.
pub(crate) fn native_roots() -> io::Result<RootCertStore> {
    let loaded = rustls_native_certs::load_native_certs();
    let mut roots = RootCertStore::empty();
    for cert in loaded.certs {
        let _ = roots.add(cert);
    }
    if roots.is_empty() {
        // Failing closed: continuing here would verify against nothing
        // and report success, which is worse than not verifying at all.
        return Err(io::Error::other(format!(
            "certificate verification is enabled for this connection but no trusted \
             roots could be loaded ({} error(s)); install the CA that signed the \
             target, or tick \"ignore certificate\" on the connection",
            loaded.errors.len()
        )));
    }
    Ok(roots)
}

/// Accepts any server certificate.
///
/// Only ever reachable when an administrator ticked "ignore certificate"
/// on the connection.
#[derive(Debug)]
pub(crate) struct NoCertificateVerification;

impl ServerCertVerifier for NoCertificateVerification {
    fn verify_server_cert(
        &self,
        _: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::RSA_PKCS1_SHA1,
            SignatureScheme::ECDSA_SHA1_Legacy,
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
            SignatureScheme::ECDSA_NISTP521_SHA512,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::ED25519,
            SignatureScheme::ED448,
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_host_without_trust_anchors_refuses_to_verify() {
        // Only meaningful where the image ships no CA bundle; where one
        // exists the store is populated and this path is unreachable.
        match native_roots() {
            Ok(roots) => assert!(!roots.is_empty()),
            Err(e) => assert!(e.to_string().contains("no trusted roots")),
        }
    }
}
