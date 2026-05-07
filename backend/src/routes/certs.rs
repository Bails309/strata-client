//! `GET /api/admin/certs` — read-only inventory of TLS certificates the
//! deployment is using, with validity windows so operators can see at a
//! glance which certs are about to expire (public TLS, DMZ link mTLS,
//! internal client mTLS, CAs, etc).
//!
//! Discovery sources, in order:
//!   1. Files explicitly named by env vars (`STRATA_DMZ_LINK_CA`,
//!      `STRATA_DMZ_LINK_TLS_CLIENT_CERT`, `STRATA_DMZ_LINK_TLS_CERT`,
//!      `STRATA_DMZ_LINK_CA_BUNDLE`, `STRATA_DMZ_PUBLIC_TLS_CERT`).
//!   2. Recursive scan of `STRATA_CERT_DIR` (defaults to
//!      `/etc/strata/certs`) for `*.crt` / `*.pem` files.
//! Duplicates (same canonical path) are de-duplicated; private keys
//! and unparseable files are silently skipped (with a warning trace).
//!
//! Only metadata is returned — never the cert body or fingerprint of
//! a private key. This endpoint is admin-only (mounted under the
//! `/api/admin/*` router which has `require_admin` + `require_auth`).

use axum::Json;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

use rustls_pki_types::pem::PemObject;

#[derive(Serialize, Debug, Clone)]
pub struct CertificateEntry {
    /// Workspace-relative-ish display path, e.g. `dmz/server.crt`.
    pub source: String,
    /// Logical category derived from path/env source.
    pub category: &'static str,
    /// Subject CN (or full RDN if no CN).
    pub subject: String,
    /// Issuer CN (or full RDN if no CN).
    pub issuer: String,
    /// Subject Alternative Names (DNS + IP), if any.
    pub san: Vec<String>,
    /// `notBefore` in RFC3339.
    pub not_before: String,
    /// `notAfter` in RFC3339.
    pub not_after: String,
    /// Days from now to `notAfter`. Negative if already expired.
    pub days_remaining: i64,
    /// SHA-256 fingerprint of the DER cert (`aa:bb:…`).
    pub fingerprint: String,
    /// True when `notAfter` is in the past.
    pub expired: bool,
    /// True when the cert has BasicConstraints CA:TRUE.
    pub is_ca: bool,
}

#[derive(Serialize)]
pub struct CertificatesResponse {
    pub certificates: Vec<CertificateEntry>,
    /// Files that were found but could not be parsed (kept terse so
    /// admins can spot a misnamed/corrupt file).
    pub errors: Vec<CertificateError>,
}

#[derive(Serialize)]
pub struct CertificateError {
    pub source: String,
    pub error: String,
}

/// `GET /api/admin/certs`
pub async fn list_certs() -> Json<CertificatesResponse> {
    let (certificates, errors) = tokio::task::spawn_blocking(scan_certs)
        .await
        .unwrap_or_else(|e| {
            tracing::error!(error = %e, "cert scan task panicked");
            (Vec::new(), Vec::new())
        });
    Json(CertificatesResponse {
        certificates,
        errors,
    })
}

fn scan_certs() -> (Vec<CertificateEntry>, Vec<CertificateError>) {
    let mut paths: Vec<PathBuf> = Vec::new();

    // ── 1. Explicit env vars used by the DMZ link / public TLS ──
    for var in [
        "STRATA_DMZ_LINK_CA",
        "STRATA_DMZ_LINK_TLS_CLIENT_CERT",
        "STRATA_DMZ_LINK_TLS_CERT",
        "STRATA_DMZ_LINK_CA_BUNDLE",
        "STRATA_DMZ_PUBLIC_TLS_CERT",
    ] {
        if let Ok(p) = std::env::var(var) {
            let p = p.trim();
            if !p.is_empty() {
                paths.push(PathBuf::from(p));
            }
        }
    }

    // ── 2. Recursive scan of the cert directory ──
    let cert_dir = std::env::var("STRATA_CERT_DIR")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "/etc/strata/certs".to_string());
    let cert_dir = PathBuf::from(cert_dir);
    if cert_dir.is_dir() {
        walk_dir(&cert_dir, &mut paths);
    }

    // De-dup by canonical path.
    let mut seen = std::collections::HashSet::new();
    paths.retain(|p| {
        let key = std::fs::canonicalize(p).unwrap_or_else(|_| p.clone());
        seen.insert(key)
    });

    let display_root = cert_dir.clone();
    let mut entries: Vec<CertificateEntry> = Vec::new();
    let mut errors: Vec<CertificateError> = Vec::new();

    for path in paths {
        let display = display_path(&path, &display_root);
        match parse_cert_file(&path, &display) {
            Ok(mut found) => entries.append(&mut found),
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "failed to parse cert file");
                errors.push(CertificateError {
                    source: display,
                    error: e,
                });
            }
        }
    }

    // Stable sort: soonest-to-expire first (helps the UI surface
    // urgency without extra client-side sorting).
    entries.sort_by_key(|c| c.days_remaining);
    (entries, errors)
}

fn walk_dir(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            walk_dir(&p, out);
        } else if p.is_file() && is_cert_file(&p) {
            out.push(p);
        }
    }
}

fn is_cert_file(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|s| s.to_str()),
        Some("crt") | Some("pem") | Some("cer")
    ) && !p
        .file_name()
        .and_then(|s| s.to_str())
        .map(|name| name.ends_with(".key.pem") || name == "key.pem")
        .unwrap_or(false)
}

fn display_path(path: &Path, root: &Path) -> String {
    if let Ok(rel) = path.strip_prefix(root) {
        return rel.display().to_string().replace('\\', "/");
    }
    path.display().to_string().replace('\\', "/")
}

fn category_for(display: &str) -> &'static str {
    let lower = display.to_ascii_lowercase();
    if lower.contains("dmz/") || lower.starts_with("dmz") {
        if lower.contains("ca.crt") || lower.contains("ca-bundle") {
            "DMZ CA"
        } else if lower.contains("client") {
            "DMZ Client (mTLS)"
        } else if lower.contains("public") {
            "DMZ Public TLS"
        } else if lower.contains("server") {
            "DMZ Link TLS"
        } else {
            "DMZ"
        }
    } else if lower.contains("public/") || lower.contains("cert.pem") {
        "Public TLS"
    } else if lower.contains("ca.crt") || lower.contains("ca-bundle") {
        "Trusted CA"
    } else if lower.contains("client") {
        "Client (mTLS)"
    } else {
        "TLS"
    }
}

fn parse_cert_file(path: &Path, display: &str) -> Result<Vec<CertificateEntry>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read: {e}"))?;
    let pem = String::from_utf8_lossy(&bytes);

    // Skip files that obviously contain a private key (e.g. a combined
    // PEM that has both — we still parse the CERTIFICATE blocks).
    let mut entries = Vec::new();
    let mut reader = std::io::Cursor::new(pem.as_bytes());
    let ders: Vec<rustls_pki_types::CertificateDer<'static>> =
        rustls_pki_types::CertificateDer::pem_reader_iter(&mut reader)
            .collect::<Result<_, _>>()
            .map_err(|e| format!("pem: {e}"))?;
    if ders.is_empty() {
        return Err("no CERTIFICATE blocks".into());
    }

    let now = chrono::Utc::now();
    for (idx, der) in ders.iter().enumerate() {
        let der_bytes = der.as_ref();
        let (_, parsed) = x509_parser::parse_x509_certificate(der_bytes)
            .map_err(|e| format!("x509: {e}"))?;
        let subject = cn_or_full(&parsed.tbs_certificate.subject.to_string());
        let issuer = cn_or_full(&parsed.tbs_certificate.issuer.to_string());
        let nb_ts = parsed.tbs_certificate.validity.not_before.timestamp();
        let na_ts = parsed.tbs_certificate.validity.not_after.timestamp();
        let nb = chrono::DateTime::<chrono::Utc>::from_timestamp(nb_ts, 0)
            .ok_or_else(|| "bad notBefore".to_string())?;
        let na = chrono::DateTime::<chrono::Utc>::from_timestamp(na_ts, 0)
            .ok_or_else(|| "bad notAfter".to_string())?;
        let days_remaining = (na - now).num_days();

        // SAN extraction (best-effort).
        let mut san: Vec<String> = Vec::new();
        for ext in parsed.extensions() {
            if let x509_parser::extensions::ParsedExtension::SubjectAlternativeName(s) =
                ext.parsed_extension()
            {
                for name in &s.general_names {
                    match name {
                        x509_parser::extensions::GeneralName::DNSName(d) => {
                            san.push((*d).to_string())
                        }
                        x509_parser::extensions::GeneralName::IPAddress(ip) => {
                            san.push(format_ip(ip));
                        }
                        _ => {}
                    }
                }
            }
        }

        let is_ca = parsed
            .basic_constraints()
            .ok()
            .flatten()
            .map(|bc| bc.value.ca)
            .unwrap_or(false);

        let mut hasher = Sha256::new();
        hasher.update(der_bytes);
        let fp = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<Vec<_>>()
            .join(":");

        let source = if ders.len() == 1 {
            display.to_string()
        } else {
            format!("{display}#{idx}")
        };
        let category = category_for(&source);

        entries.push(CertificateEntry {
            source,
            category,
            subject,
            issuer,
            san,
            not_before: nb.to_rfc3339(),
            not_after: na.to_rfc3339(),
            days_remaining,
            fingerprint: fp,
            expired: na < now,
            is_ca,
        });
    }
    Ok(entries)
}

fn cn_or_full(rdn: &str) -> String {
    // x509-parser's RDN string is like "CN=foo, O=bar". Pull CN if
    // present, otherwise return the whole thing trimmed.
    for part in rdn.split(',') {
        let p = part.trim();
        if let Some(rest) = p.strip_prefix("CN=") {
            return rest.to_string();
        }
    }
    rdn.trim().to_string()
}

fn format_ip(bytes: &[u8]) -> String {
    match bytes.len() {
        4 => format!("{}.{}.{}.{}", bytes[0], bytes[1], bytes[2], bytes[3]),
        16 => {
            // Lazy IPv6 formatting — group as 8 hex pairs.
            (0..8)
                .map(|i| format!("{:x}", u16::from_be_bytes([bytes[i * 2], bytes[i * 2 + 1]])))
                .collect::<Vec<_>>()
                .join(":")
        }
        _ => bytes.iter().map(|b| format!("{b:02x}")).collect::<String>(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cn_extracts_common_name() {
        assert_eq!(cn_or_full("CN=foo.example, O=Acme"), "foo.example");
        assert_eq!(cn_or_full("O=Acme, CN=bar"), "bar");
        assert_eq!(cn_or_full("O=Acme"), "O=Acme");
    }

    #[test]
    fn category_classifies_known_paths() {
        assert_eq!(category_for("dmz/server.crt"), "DMZ Link TLS");
        assert_eq!(category_for("dmz/client.crt"), "DMZ Client (mTLS)");
        assert_eq!(category_for("dmz/ca.crt"), "DMZ CA");
        assert_eq!(category_for("dmz/public.crt"), "DMZ Public TLS");
        assert_eq!(category_for("public/cert.pem"), "Public TLS");
        assert_eq!(category_for("ca.crt"), "Trusted CA");
        assert_eq!(category_for("misc.crt"), "TLS");
    }

    #[test]
    fn is_cert_file_filters_keys() {
        assert!(is_cert_file(Path::new("a.crt")));
        assert!(is_cert_file(Path::new("a.pem")));
        assert!(is_cert_file(Path::new("a.cer")));
        assert!(!is_cert_file(Path::new("a.key")));
        assert!(!is_cert_file(Path::new("key.pem")));
        assert!(!is_cert_file(Path::new("server.key.pem")));
        assert!(!is_cert_file(Path::new("a.txt")));
    }

    #[test]
    fn format_ip_handles_v4_and_v6() {
        assert_eq!(format_ip(&[127, 0, 0, 1]), "127.0.0.1");
        assert_eq!(format_ip(&[10, 0, 0, 1]), "10.0.0.1");
        let v6 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
        assert_eq!(format_ip(&v6), "0:0:0:0:0:0:0:1");
    }

    #[test]
    fn display_path_strips_root() {
        let root = PathBuf::from("/etc/strata/certs");
        assert_eq!(
            display_path(&PathBuf::from("/etc/strata/certs/dmz/ca.crt"), &root),
            "dmz/ca.crt"
        );
        assert_eq!(
            display_path(&PathBuf::from("/elsewhere/foo.pem"), &root),
            "/elsewhere/foo.pem"
        );
    }

    #[tokio::test]
    async fn list_certs_returns_empty_when_no_sources() {
        // Clear potential interference from process env.
        for v in [
            "STRATA_DMZ_LINK_CA",
            "STRATA_DMZ_LINK_TLS_CLIENT_CERT",
            "STRATA_DMZ_LINK_TLS_CERT",
            "STRATA_DMZ_LINK_CA_BUNDLE",
            "STRATA_DMZ_PUBLIC_TLS_CERT",
            "STRATA_CERT_DIR",
        ] {
            // SAFETY: tests run single-threaded by default; this is a
            // best-effort cleanup so the scan finds no inputs.
            unsafe {
                std::env::remove_var(v);
            }
        }
        // Point at a definitely-missing dir
        unsafe {
            std::env::set_var("STRATA_CERT_DIR", "/nonexistent/strata/certs");
        }
        let resp = list_certs().await;
        assert!(resp.certificates.is_empty());
    }
}
