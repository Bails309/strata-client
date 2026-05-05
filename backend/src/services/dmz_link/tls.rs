//! Production TLS connector for the DMZ link.
//!
//! Reads PEM-encoded mTLS material from disk (paths configured in
//! [`super::config::LinkConfig`]) and dials the DMZ over a vanilla
//! TCP-then-rustls handshake. The endpoint URL is parsed as
//! `tls://host:port` (or any `<scheme>://host:port`); the scheme is
//! ignored — only host+port and the SNI name (the host) matter.
//!
//! Trust is anchored exclusively in the operator-supplied private CA
//! bundle (`STRATA_DMZ_LINK_CA`). The system / Mozilla truststore is
//! intentionally **not** consulted: the DMZ link is a private link
//! between paired nodes; pinning to a private CA prevents any
//! publicly-trusted CA from minting a cert that could MITM the link.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, RootCertStore};
use rustls_pki_types::pem::PemObject;
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

use super::config::{LinkConfig, LinkEndpoint};
use super::connector::{BoxedStream, Connector};

/// Production mTLS [`Connector`] implementation.
pub struct TlsLinkConnector {
    rustls_config: Arc<ClientConfig>,
}

impl TlsLinkConnector {
    /// Build a connector from a [`LinkConfig`]. Returns an error if
    /// any of the three TLS path env vars are missing or the files
    /// fail to parse — operators must see misconfiguration at boot,
    /// never at first reconnect.
    pub fn from_config(cfg: &LinkConfig) -> anyhow::Result<Self> {
        let cert_path = cfg
            .client_cert_path
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("STRATA_DMZ_LINK_TLS_CLIENT_CERT not set"))?;
        let key_path = cfg
            .client_key_path
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("STRATA_DMZ_LINK_TLS_CLIENT_KEY not set"))?;
        let ca_path = cfg
            .link_ca_path
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("STRATA_DMZ_LINK_CA not set"))?;

        let rustls_config = build_client_config(cert_path, key_path, ca_path)?;
        Ok(Self {
            rustls_config: Arc::new(rustls_config),
        })
    }
}

#[async_trait]
impl Connector for TlsLinkConnector {
    async fn connect(&self, endpoint: &LinkEndpoint) -> anyhow::Result<BoxedStream> {
        let (host, port) = parse_endpoint(&endpoint.url)?;
        let server_name = ServerName::try_from(host.clone())
            .map_err(|e| anyhow::anyhow!("invalid SNI {host:?}: {e}"))?;

        let tcp = TcpStream::connect((host.as_str(), port)).await?;
        // Disable Nagle for handshake latency; the link carries
        // interactive guacd traffic, not bulk file transfers.
        let _ = tcp.set_nodelay(true);

        let connector = TlsConnector::from(self.rustls_config.clone());
        let tls = connector.connect(server_name, tcp).await?;
        Ok(Box::new(tls))
    }
}

fn build_client_config(
    cert_path: &Path,
    key_path: &Path,
    ca_path: &Path,
) -> anyhow::Result<ClientConfig> {
    // Build a root store from JUST the private CA bundle. We do not
    // fall back to the system truststore — see module docs.
    let mut roots = RootCertStore::empty();
    let ca_certs: Vec<rustls_pki_types::CertificateDer<'static>> =
        rustls_pki_types::CertificateDer::pem_file_iter(ca_path)
            .map_err(|e| anyhow::anyhow!("read CA bundle {}: {e}", ca_path.display()))?
            .collect::<Result<_, _>>()
            .map_err(|e| anyhow::anyhow!("parse CA bundle {}: {e}", ca_path.display()))?;
    if ca_certs.is_empty() {
        anyhow::bail!(
            "DMZ link CA bundle {} contains no certificates",
            ca_path.display()
        );
    }
    let (added, _ignored) = roots.add_parsable_certificates(ca_certs);
    if added == 0 {
        anyhow::bail!(
            "DMZ link CA bundle {} contained no usable certificates",
            ca_path.display()
        );
    }

    // Client cert chain.
    let chain: Vec<rustls_pki_types::CertificateDer<'static>> =
        rustls_pki_types::CertificateDer::pem_file_iter(cert_path)
            .map_err(|e| anyhow::anyhow!("read client cert {}: {e}", cert_path.display()))?
            .collect::<Result<_, _>>()
            .map_err(|e| anyhow::anyhow!("parse client cert {}: {e}", cert_path.display()))?;
    if chain.is_empty() {
        anyhow::bail!(
            "client cert chain {} is empty",
            cert_path.display()
        );
    }

    // Client private key — accept PKCS8, PKCS1, or SEC1.
    let key = rustls_pki_types::PrivateKeyDer::from_pem_file(key_path)
        .map_err(|e| anyhow::anyhow!("read client key {}: {e}", key_path.display()))?;

    let cfg = ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| anyhow::anyhow!("set TLS protocol versions: {e}"))?
    .with_root_certificates(roots)
    .with_client_auth_cert(chain, key)
    .map_err(|e| anyhow::anyhow!("install client cert: {e}"))?;

    Ok(cfg)
}

/// Parse `<scheme>://host:port` into `(host, port)`. Scheme is ignored
/// (the connector always speaks TCP+TLS). Bare `host:port` is also
/// accepted for ergonomics.
fn parse_endpoint(url: &str) -> anyhow::Result<(String, u16)> {
    let after_scheme = match url.split_once("://") {
        Some((_scheme, rest)) => rest,
        None => url,
    };
    // Strip any trailing path (we don't use it).
    let host_port = after_scheme
        .split_once('/')
        .map(|(hp, _)| hp)
        .unwrap_or(after_scheme);

    // IPv6 in brackets: [::1]:8444
    if let Some(rest) = host_port.strip_prefix('[') {
        let (host, tail) = rest
            .split_once(']')
            .ok_or_else(|| anyhow::anyhow!("malformed IPv6 endpoint: {url}"))?;
        let port_str = tail
            .strip_prefix(':')
            .ok_or_else(|| anyhow::anyhow!("missing :port in {url}"))?;
        let port: u16 = port_str
            .parse()
            .map_err(|e| anyhow::anyhow!("invalid port in {url}: {e}"))?;
        return Ok((host.to_string(), port));
    }

    let (host, port_str) = host_port
        .rsplit_once(':')
        .ok_or_else(|| anyhow::anyhow!("missing :port in {url}"))?;
    if host.is_empty() {
        anyhow::bail!("missing host in {url}");
    }
    let port: u16 = port_str
        .parse()
        .map_err(|e| anyhow::anyhow!("invalid port in {url}: {e}"))?;
    Ok((host.to_string(), port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_endpoint_with_scheme() {
        let (h, p) = parse_endpoint("tls://dmz1.example.net:8444").unwrap();
        assert_eq!(h, "dmz1.example.net");
        assert_eq!(p, 8444);
    }

    #[test]
    fn parse_endpoint_without_scheme() {
        let (h, p) = parse_endpoint("dmz1:8444").unwrap();
        assert_eq!(h, "dmz1");
        assert_eq!(p, 8444);
    }

    #[test]
    fn parse_endpoint_ipv6() {
        let (h, p) = parse_endpoint("tls://[2001:db8::1]:8444").unwrap();
        assert_eq!(h, "2001:db8::1");
        assert_eq!(p, 8444);
    }

    #[test]
    fn parse_endpoint_strips_path() {
        let (h, p) = parse_endpoint("https://dmz1:8444/link").unwrap();
        assert_eq!(h, "dmz1");
        assert_eq!(p, 8444);
    }

    #[test]
    fn parse_endpoint_rejects_no_port() {
        assert!(parse_endpoint("tls://dmz1").is_err());
    }

    #[test]
    fn parse_endpoint_rejects_empty_host() {
        assert!(parse_endpoint("tls://:8444").is_err());
    }

    #[test]
    fn parse_endpoint_rejects_bad_port() {
        assert!(parse_endpoint("tls://dmz1:notaport").is_err());
    }

    #[test]
    fn from_config_errors_when_paths_missing() {
        use std::collections::HashMap;
        let cfg = LinkConfig {
            cluster_id: "c".into(),
            node_id: "n".into(),
            software_version: "v".into(),
            endpoints: vec![],
            psks: HashMap::new(),
            client_cert_path: None,
            client_key_path: None,
            link_ca_path: None,
        };
        let r = TlsLinkConnector::from_config(&cfg);
        assert!(r.is_err());
        let msg = format!("{}", r.unwrap_err());
        assert!(msg.contains("STRATA_DMZ_LINK_TLS_CLIENT_CERT"));
    }

    #[test]
    fn from_config_errors_when_ca_unreadable() {
        use std::collections::HashMap;
        use std::path::PathBuf;
        let cfg = LinkConfig {
            cluster_id: "c".into(),
            node_id: "n".into(),
            software_version: "v".into(),
            endpoints: vec![],
            psks: HashMap::new(),
            client_cert_path: Some(PathBuf::from("/nonexistent/cert.pem")),
            client_key_path: Some(PathBuf::from("/nonexistent/key.pem")),
            link_ca_path: Some(PathBuf::from("/nonexistent/ca.pem")),
        };
        let r = TlsLinkConnector::from_config(&cfg);
        assert!(r.is_err());
    }
}
