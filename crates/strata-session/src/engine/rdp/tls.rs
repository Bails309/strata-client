//! TLS for the RDP transport, honouring the connection's certificate policy.
//!
//! `ironrdp_tls::upgrade` accepts any certificate. That is the usual RDP
//! posture — hosts are overwhelmingly self-signed, and CredSSP binds the
//! credential to the server's public key — but it silently overrides an
//! administrator who cleared "ignore certificate" on the connection.
//! This module keeps the accept-anything path for when that box *is*
//! ticked, and otherwise applies whichever anchor the connection was
//! given: a pinned fingerprint, an attached CA bundle, or the system
//! trust store.
//!
//! Deliberately unlike the upstream helper, `SSLKEYLOGFILE` is not
//! honoured: dumping TLS secrets on an environment variable is not a
//! trade a privileged-access gateway should make.

use std::io;
use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt as _};
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{self};

use crate::tls::{roots_with_bundle, CertPolicy, NoCertificateVerification, PinnedCertVerifier};

/// A TLS-wrapped transport carrying the RDP connection.
pub type TlsStream<S> = tokio_rustls::client::TlsStream<S>;

/// Wrap `stream` in TLS under the connection's certificate policy.
///
/// Returns the peer certificate alongside the stream because CredSSP
/// binds to its public key.
pub async fn upgrade<S>(
    stream: S,
    server_name: &str,
    policy: &CertPolicy,
) -> io::Result<(TlsStream<S>, x509_cert::Certificate)>
where
    S: Unpin + AsyncRead + AsyncWrite,
{
    let builder = rustls::ClientConfig::builder();
    let mut config = match policy {
        CertPolicy::Verify { extra_roots } => builder
            .with_root_certificates(roots_with_bundle(extra_roots.as_deref())?)
            .with_no_client_auth(),
        CertPolicy::Pinned { fingerprints } => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(PinnedCertVerifier::new(
                fingerprints.clone(),
            )?))
            .with_no_client_auth(),
        CertPolicy::Ignore => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoCertificateVerification))
            .with_no_client_auth(),
    };

    // "The CredSSP Protocol does not extend the TLS wire protocol. TLS
    // session resumption is not supported." — MS-CSSP.
    config.resumption = rustls::client::Resumption::disabled();

    let domain = ServerName::try_from(server_name.to_owned()).map_err(io::Error::other)?;
    let mut tls_stream = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(domain, stream)
        .await?;
    tls_stream.flush().await?;

    let certificate = {
        use x509_cert::der::Decode as _;

        let der = tls_stream
            .get_ref()
            .1
            .peer_certificates()
            .and_then(|chain| chain.first())
            .ok_or_else(|| io::Error::other("peer certificate is missing"))?;
        x509_cert::Certificate::from_der(der).map_err(io::Error::other)?
    };

    Ok((tls_stream, certificate))
}

#[cfg(test)]
mod tests {
    use crate::tls::native_roots;

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
