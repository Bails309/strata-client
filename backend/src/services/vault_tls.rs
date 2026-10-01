//! Certificates for the bundled Vault's TLS listener.
//!
//! `strata-backend vault-tls-init <tls-dir> <ca-dir>` runs as an init
//! container before Vault. It keeps a private CA in `<tls-dir>`, which only
//! Vault mounts, issues Vault's server certificate from it, and copies just
//! the CA certificate to `<ca-dir>`, which the backend mounts read-only and
//! trusts for Vault calls (`VAULT_CACERT`). Re-running keeps the CA and
//! reissues the server certificate only when it is missing or within
//! 30 days of expiry, so the backend's copy of the CA stays valid.

use anyhow::Context;
use rcgen::{
    BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair,
    KeyUsagePurpose, SanType,
};
use std::path::Path;
use time::{Duration, OffsetDateTime};

const CA_DAYS: i64 = 3650;
const SERVER_DAYS: i64 = 730;
const RENEW_WITHIN_DAYS: i64 = 30;
/// The compose service name, and what Vault's own healthcheck dials.
const SERVER_NAMES: [&str; 2] = ["vault", "localhost"];

/// Always built the same way, so a re-signed copy issues certificates that
/// chain to the CA certificate first written.
fn ca_params() -> anyhow::Result<CertificateParams> {
    let mut p = CertificateParams::new(Vec::<String>::new())?;
    p.distinguished_name
        .push(DnType::CommonName, "Strata bundled Vault CA");
    p.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    p.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    Ok(p)
}

pub fn run(tls_dir: &Path, ca_dir: &Path) -> anyhow::Result<()> {
    run_at(tls_dir, ca_dir, OffsetDateTime::now_utc())
}

fn run_at(tls_dir: &Path, ca_dir: &Path, now: OffsetDateTime) -> anyhow::Result<()> {
    std::fs::create_dir_all(tls_dir)?;
    std::fs::create_dir_all(ca_dir)?;
    let ca_key_path = tls_dir.join("ca.key");
    let ca_cert_path = tls_dir.join("ca.crt");
    let server_key_path = tls_dir.join("server.key");
    let server_cert_path = tls_dir.join("server.crt");

    let (ca_key, new_ca) = if ca_key_path.exists() && ca_cert_path.exists() {
        let pem = std::fs::read_to_string(&ca_key_path).context("reading ca.key")?;
        (KeyPair::from_pem(&pem)?, false)
    } else {
        let key = KeyPair::generate()?;
        let mut p = ca_params()?;
        p.not_before = now - Duration::days(1);
        p.not_after = now + Duration::days(CA_DAYS);
        let cert = p.self_signed(&key)?;
        write(&ca_key_path, key.serialize_pem().as_bytes(), 0o600)?;
        write(&ca_cert_path, cert.pem().as_bytes(), 0o644)?;
        (key, true)
    };

    let renew_by = now + Duration::days(RENEW_WITHIN_DAYS);
    if new_ca || !valid_until(&server_cert_path, renew_by) {
        let issuer = ca_params()?.self_signed(&ca_key)?;
        let key = KeyPair::generate()?;
        let mut p = CertificateParams::new(SERVER_NAMES.map(String::from).to_vec())?;
        p.subject_alt_names
            .push(SanType::IpAddress(std::net::Ipv4Addr::LOCALHOST.into()));
        p.distinguished_name.push(DnType::CommonName, "vault");
        p.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        p.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        p.not_before = now - Duration::days(1);
        p.not_after = now + Duration::days(SERVER_DAYS);
        let cert = p.signed_by(&key, &issuer, &ca_key)?;
        write(&server_key_path, key.serialize_pem().as_bytes(), 0o600)?;
        write(&server_cert_path, cert.pem().as_bytes(), 0o644)?;
    }

    let ca_pem = std::fs::read(&ca_cert_path)?;
    write(&ca_dir.join("ca.crt"), &ca_pem, 0o644)
}

/// Whether the certificate at `path` exists and is still valid at `at`.
fn valid_until(path: &Path, at: OffsetDateTime) -> bool {
    let Ok(pem) = std::fs::read(path) else {
        return false;
    };
    let Ok((_, pem)) = x509_parser::pem::parse_x509_pem(&pem) else {
        return false;
    };
    pem.parse_x509()
        .is_ok_and(|cert| cert.validity().not_after.timestamp() > at.unix_timestamp())
}

/// Written beside the target and renamed over it, created with `mode`.
fn write(path: &Path, bytes: &[u8], mode: u32) -> anyhow::Result<()> {
    use std::io::Write;
    let name = path.file_name().context("no file name")?.to_string_lossy();
    let tmp = path.with_file_name(format!(".{name}.tmp"));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let mut file = options
        .open(&tmp)
        .with_context(|| format!("writing {}", tmp.display()))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(&tmp, path).with_context(|| format!("writing {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::client::danger::ServerCertVerifier;
    use rustls::pki_types::{pem::PemObject, CertificateDer, ServerName, UnixTime};
    use std::sync::Arc;

    fn verify(ca: &Path, cert: &Path, name: &str) -> Result<(), rustls::Error> {
        let mut roots = rustls::RootCertStore::empty();
        roots
            .add(CertificateDer::from_pem_file(ca).unwrap())
            .unwrap();
        let verifier = rustls::client::WebPkiServerVerifier::builder_with_provider(
            Arc::new(roots),
            Arc::new(rustls::crypto::ring::default_provider()),
        )
        .build()
        .unwrap();
        let leaf = CertificateDer::from_pem_file(cert).unwrap();
        verifier
            .verify_server_cert(
                &leaf,
                &[],
                &ServerName::try_from(name.to_owned()).unwrap(),
                &[],
                UnixTime::now(),
            )
            .map(|_| ())
    }

    #[test]
    fn the_backend_trusts_vault_through_the_copied_ca_only() {
        let (tls, ca) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        run(tls.path(), ca.path()).unwrap();
        let (ca_crt, server) = (ca.path().join("ca.crt"), tls.path().join("server.crt"));
        for name in ["vault", "localhost", "127.0.0.1"] {
            verify(&ca_crt, &server, name).unwrap();
        }
        assert!(verify(&ca_crt, &server, "postgres-local").is_err());
        let backend_sees: Vec<_> = std::fs::read_dir(ca.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(backend_sees, ["ca.crt"], "no keys leave the Vault volume");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for key in ["ca.key", "server.key"] {
                let mode = std::fs::metadata(tls.path().join(key))
                    .unwrap()
                    .permissions()
                    .mode();
                assert_eq!(mode & 0o777, 0o600, "{key}");
            }
        }

        let other = tempfile::tempdir().unwrap();
        run(other.path(), other.path()).unwrap();
        assert!(
            verify(&other.path().join("ca.crt"), &server, "vault").is_err(),
            "another install's CA is not trusted"
        );
    }

    #[test]
    fn reruns_keep_the_ca_and_renew_the_server_cert_near_expiry() {
        let (tls, ca) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let now = OffsetDateTime::now_utc();
        // Two years ago, so the server certificate is now inside its renewal window.
        run_at(
            tls.path(),
            ca.path(),
            now - Duration::days(SERVER_DAYS - 10),
        )
        .unwrap();
        let first_ca = std::fs::read(ca.path().join("ca.crt")).unwrap();
        let first_server = std::fs::read(tls.path().join("server.crt")).unwrap();

        run_at(
            tls.path(),
            ca.path(),
            now - Duration::days(SERVER_DAYS - 50),
        )
        .unwrap();
        assert_eq!(
            std::fs::read(tls.path().join("server.crt")).unwrap(),
            first_server,
            "not renewed early"
        );

        run_at(tls.path(), ca.path(), now).unwrap();
        assert_eq!(std::fs::read(ca.path().join("ca.crt")).unwrap(), first_ca);
        assert_ne!(
            std::fs::read(tls.path().join("server.crt")).unwrap(),
            first_server
        );
        verify(
            &ca.path().join("ca.crt"),
            &tls.path().join("server.crt"),
            "vault",
        )
        .unwrap();
    }
}
