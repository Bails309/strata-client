//! TLS pieces shared by the engines that drive rustls directly.
//!
//! Deliberately one implementation of the accept-anything verifier
//! rather than one per engine: a second copy is a second thing to audit,
//! and the one that gets forgotten is the one that stops honouring a
//! connection's certificate policy.

use std::io;
use std::sync::Arc;

use base64::Engine as _;
use sha2::Digest as _;
use tokio_rustls::rustls::client::danger::{
    HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
};
use tokio_rustls::rustls::crypto::{
    verify_tls12_signature, verify_tls13_signature, CryptoProvider,
};
use tokio_rustls::rustls::pki_types::pem::PemObject as _;
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use tokio_rustls::rustls::{self, DigitallySignedStruct, RootCertStore, SignatureScheme};

/// What a connection will accept from the target's TLS certificate.
///
/// One type rather than a `verify: bool`, because the interesting cases
/// are the ones in between: an internal CA that the system store has
/// never heard of, and a self-signed host that can still be identified
/// exactly by pinning the certificate it presents.
#[derive(Debug, Clone, Default)]
pub enum CertPolicy {
    /// Accept any certificate — the connection's "ignore certificate" box.
    #[default]
    Ignore,
    /// Require a chain back to a trust anchor.
    Verify {
        /// PEM of the connection's attached trusted-CA bundle, trusted
        /// alongside the system store rather than instead of it.
        extra_roots: Option<String>,
    },
    /// Accept only certificates with one of these SHA-256 fingerprints.
    ///
    /// The chain is not consulted, which is the point: this is how a
    /// self-signed host is identified, and it is the same trust model as
    /// the SSH host keys pinned elsewhere.
    Pinned {
        /// Accepted end-entity certificate digests, 32 bytes each.
        fingerprints: Vec<Vec<u8>>,
    },
}

/// Parse one SHA-256 certificate fingerprint.
///
/// Accepts both forms an administrator is likely to have to hand: hex
/// from `openssl x509 -fingerprint -sha256` or the Windows certificate
/// dialog (case and `:`/space separators ignored), and the `SHA256:`
/// base64 that OpenSSH-style tooling prints. Returns `None` for anything
/// that is not 32 bytes, so a truncated paste is rejected at the point
/// it is entered rather than silently pinning nothing.
pub fn parse_fingerprint(raw: &str) -> Option<Vec<u8>> {
    let raw = raw.trim();
    let body = raw
        .get(..7)
        .filter(|p| p.eq_ignore_ascii_case("sha256:"))
        .map_or(raw, |_| &raw[7..]);

    let hex: String = body
        .chars()
        .filter(|c| !matches!(c, ':' | ' ' | '-'))
        .collect();
    if hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return (0..32)
            .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok())
            .collect();
    }

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(body)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(body))
        .ok()?;
    (decoded.len() == 32).then_some(decoded)
}

/// Render a fingerprint the way the connection editor asks for it, so a
/// mismatch can be resolved by copying the value out of the log.
pub(crate) fn format_fingerprint(digest: &[u8]) -> String {
    digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// Trust anchors for a connection: the system store, plus the CA bundle
/// attached to it.
///
/// The bundle adds to the system store rather than replacing it, which
/// matches what the web kiosk does when it writes the same bundle into
/// its NSS DB. A host whose store is empty is still usable this way —
/// the attached CA is then the only anchor, which is a deliberate choice
/// by whoever attached it.
pub(crate) fn roots_with_bundle(bundle_pem: Option<&str>) -> io::Result<RootCertStore> {
    let Some(pem) = bundle_pem.map(str::trim).filter(|p| !p.is_empty()) else {
        return native_roots();
    };

    let mut roots = RootCertStore::empty();
    for cert in CertificateDer::pem_slice_iter(pem.as_bytes()) {
        let cert =
            cert.map_err(|e| io::Error::other(format!("trusted CA bundle is not valid PEM: {e}")))?;
        roots
            .add(cert)
            .map_err(|e| io::Error::other(format!("trusted CA bundle rejected: {e}")))?;
    }
    if roots.is_empty() {
        return Err(io::Error::other(
            "the trusted CA bundle attached to this connection contains no certificates",
        ));
    }

    for cert in rustls_native_certs::load_native_certs().certs {
        let _ = roots.add(cert);
    }
    Ok(roots)
}

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

/// Accepts only certificates whose SHA-256 digest was pinned on the
/// connection.
///
/// Signatures are still checked by the crypto provider — pinning
/// replaces the question of *who vouches for this host*, not the proof
/// that the peer holds the key it presented.
#[derive(Debug)]
pub(crate) struct PinnedCertVerifier {
    fingerprints: Vec<Vec<u8>>,
    provider: Arc<CryptoProvider>,
}

impl PinnedCertVerifier {
    pub(crate) fn new(fingerprints: Vec<Vec<u8>>) -> io::Result<Self> {
        if fingerprints.is_empty() {
            // Failing closed: an empty pin list matches nothing, and a
            // verifier that always errors is a worse diagnostic than
            // refusing to build one.
            return Err(io::Error::other(
                "certificate pinning is enabled for this connection but no fingerprints were set",
            ));
        }
        let provider = CryptoProvider::get_default()
            .cloned()
            .unwrap_or_else(|| Arc::new(tokio_rustls::rustls::crypto::ring::default_provider()));
        Ok(Self {
            fingerprints,
            provider,
        })
    }
}

impl ServerCertVerifier for PinnedCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let digest = sha2::Sha256::digest(end_entity.as_ref());
        if self
            .fingerprints
            .iter()
            .any(|pinned| pinned.as_slice() == digest.as_slice())
        {
            return Ok(ServerCertVerified::assertion());
        }
        // The observed fingerprint goes in the message so an
        // administrator can compare it against what they pinned, and
        // adopt it after checking the host really did change.
        Err(rustls::Error::General(format!(
            "the target presented a certificate whose fingerprint is not pinned on this \
             connection (presented {})",
            format_fingerprint(&digest)
        )))
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
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

    /// SHA-256 of the empty input, the one digest that needs no fixture.
    const EMPTY_HEX: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[test]
    fn reads_a_fingerprint_in_every_form_an_admin_might_paste() {
        let expect = parse_fingerprint(EMPTY_HEX).expect("plain hex");
        assert_eq!(expect.len(), 32);

        let colons = "e3:b0:c4:42:98:fc:1c:14:9a:fb:f4:c8:99:6f:b9:24:\
                      27:ae:41:e4:64:9b:93:4c:a4:95:99:1b:78:52:b8:55";
        assert_eq!(parse_fingerprint(colons).as_ref(), Some(&expect));
        assert_eq!(
            parse_fingerprint(&colons.to_uppercase()).as_ref(),
            Some(&expect)
        );
        assert_eq!(
            parse_fingerprint(&format!("SHA256:{colons}")).as_ref(),
            Some(&expect)
        );
        // The base64 form OpenSSH-style tooling prints.
        assert_eq!(
            parse_fingerprint("SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU").as_ref(),
            Some(&expect)
        );
    }

    #[test]
    fn refuses_a_fingerprint_that_is_not_a_whole_digest() {
        // A truncated paste is the realistic failure, and accepting it
        // would pin nothing while looking configured.
        assert_eq!(parse_fingerprint(&EMPTY_HEX[..40]), None);
        assert_eq!(parse_fingerprint(""), None);
        assert_eq!(parse_fingerprint("not a fingerprint"), None);
    }

    #[test]
    fn pinning_refuses_to_build_with_nothing_to_match() {
        let err = PinnedCertVerifier::new(Vec::new()).expect_err("empty pin list");
        assert!(err.to_string().contains("no fingerprints"));
    }

    #[test]
    fn pinning_accepts_the_matching_certificate_and_rejects_others() {
        let cert = CertificateDer::from(b"not really a certificate".to_vec());
        let digest = sha2::Sha256::digest(cert.as_ref()).to_vec();

        let verifier = PinnedCertVerifier::new(vec![digest]).expect("verifier");
        let name = ServerName::try_from("host.internal").expect("name");
        let now = UnixTime::since_unix_epoch(std::time::Duration::from_secs(1_700_000_000));
        assert!(verifier
            .verify_server_cert(&cert, &[], &name, &[], now)
            .is_ok());

        let other = CertificateDer::from(b"a different certificate".to_vec());
        let err = verifier
            .verify_server_cert(&other, &[], &name, &[], now)
            .expect_err("unpinned certificate");
        // The presented value is in the message so it can be adopted
        // once the change has been checked.
        assert!(err
            .to_string()
            .contains(&format_fingerprint(&sha2::Sha256::digest(other.as_ref()))));
    }

    #[test]
    fn a_bundle_of_nonsense_is_rejected_rather_than_ignored() {
        let err = roots_with_bundle(Some("-----BEGIN CERTIFICATE-----\nnope\n"))
            .expect_err("invalid bundle");
        assert!(err.to_string().contains("trusted CA bundle"));
    }

    #[test]
    fn an_absent_bundle_falls_back_to_the_system_store() {
        // Same outcome either way as `native_roots`, which is the point:
        // attaching no CA must not change how a connection verifies.
        assert_eq!(
            roots_with_bundle(Some("   ")).is_ok(),
            native_roots().is_ok()
        );
        assert_eq!(roots_with_bundle(None).is_ok(), native_roots().is_ok());
    }
}
