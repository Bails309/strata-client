//! Reusable trust-root storage for the web-session kiosk.
//!
//! Admins upload a PEM bundle (one or more CA certs) once with a
//! human-readable label; web connections then reference it by UUID
//! through `WebSessionConfig::trusted_ca_id`. At kiosk launch time
//! [`materialise_into_nss_db`] drops the bundle into the per-session
//! Chromium profile's NSS DB so Chromium trusts those roots without
//! relying on `--ignore-certificate-errors`.
//!
//! The PEM is treated as opaque public material — it is **not**
//! sealed in Vault. CA certificates are public by design (the issuing
//! CA hands them out in chain attachments to every TLS handshake), so
//! confidentiality protections aren't useful here. Integrity is the
//! property that matters and is provided by the row-level audit trail
//! (`created_at` / `updated_at` / `created_by`).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::AppError;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TrustedCaSummary {
    pub id: Uuid,
    pub name: String,
    pub description: String,
    pub subject: Option<String>,
    pub not_after: Option<DateTime<Utc>>,
    pub fingerprint: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TrustedCaDetail {
    pub id: Uuid,
    pub name: String,
    pub description: String,
    pub pem: String,
    pub subject: Option<String>,
    pub not_after: Option<DateTime<Utc>>,
    pub fingerprint: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateTrustedCa {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub pem: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTrustedCa {
    pub name: Option<String>,
    pub description: Option<String>,
    /// Replacement PEM; when absent the existing bundle is preserved.
    pub pem: Option<String>,
}

/// Cached metadata extracted from a freshly-validated PEM bundle.
#[derive(Debug)]
struct ParsedMetadata {
    subject: Option<String>,
    not_after: Option<DateTime<Utc>>,
    fingerprint: Option<String>,
}

/// Parse and validate a PEM bundle. Returns the cleaned PEM (with
/// CRLF normalised to LF) plus metadata about the **first** CA cert
/// found. Returns `Validation` on any structural problem so the admin
/// gets an actionable error before the row hits the DB.
fn parse_and_validate(pem: &str) -> Result<(String, ParsedMetadata), AppError> {
    let normalised: String = pem.replace("\r\n", "\n").trim().to_owned();
    if normalised.is_empty() {
        return Err(AppError::Validation("CA bundle is empty".into()));
    }

    // rustls-pemfile only yields blocks whose label matches CERTIFICATE.
    let mut reader = std::io::Cursor::new(normalised.as_bytes());
    let certs: Vec<_> = rustls_pemfile::certs(&mut reader)
        .collect::<Result<_, _>>()
        .map_err(|e| AppError::Validation(format!("PEM parse error: {e}")))?;
    if certs.is_empty() {
        return Err(AppError::Validation(
            "No CERTIFICATE blocks found in PEM bundle".into(),
        ));
    }

    // Use the first cert's metadata for the list view. Bundles
    // typically lead with the root or intermediate the admin actually
    // cares about, and we want a stable single-row preview rather than
    // dumping the full chain.
    let first_der = certs
        .first()
        .expect("certs non-empty checked above")
        .as_ref();
    let (_, parsed) = x509_parser::parse_x509_certificate(first_der)
        .map_err(|e| AppError::Validation(format!("X.509 parse error: {e}")))?;

    // Soft check — we *prefer* CA certs (BasicConstraints CA:TRUE) but
    // we don't reject leaf certs outright because some operators
    // legitimately want to trust a single self-signed leaf. Surfacing
    // this would just be UI polish; leave it to the frontend hint.
    let subject = Some(parsed.tbs_certificate.subject.to_string());
    let not_after = chrono::DateTime::<Utc>::from_timestamp(
        parsed.tbs_certificate.validity.not_after.timestamp(),
        0,
    );

    let mut hasher = Sha256::new();
    hasher.update(first_der);
    let digest = hasher.finalize();
    let fingerprint = Some(
        digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<Vec<_>>()
            .join(":"),
    );

    Ok((
        normalised,
        ParsedMetadata {
            subject,
            not_after,
            fingerprint,
        },
    ))
}

pub async fn list(pool: &PgPool) -> Result<Vec<TrustedCaSummary>, AppError> {
    let rows = sqlx::query_as::<_, TrustedCaSummary>(
        "SELECT id, name, description, subject, not_after, fingerprint,
                created_at, updated_at
         FROM trusted_ca_bundles
         ORDER BY LOWER(name)",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get(pool: &PgPool, id: Uuid) -> Result<Option<TrustedCaDetail>, AppError> {
    let row = sqlx::query_as::<_, TrustedCaDetail>(
        "SELECT id, name, description, pem, subject, not_after, fingerprint,
                created_at, updated_at
         FROM trusted_ca_bundles
         WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn create(
    pool: &PgPool,
    body: &CreateTrustedCa,
    actor: Option<Uuid>,
) -> Result<TrustedCaSummary, AppError> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("Name is required".into()));
    }
    let (pem, meta) = parse_and_validate(&body.pem)?;

    let row = sqlx::query_as::<_, TrustedCaSummary>(
        "INSERT INTO trusted_ca_bundles (name, description, pem,
                                          subject, not_after, fingerprint, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, description, subject, not_after, fingerprint,
                   created_at, updated_at",
    )
    .bind(name)
    .bind(body.description.trim())
    .bind(&pem)
    .bind(&meta.subject)
    .bind(meta.not_after)
    .bind(&meta.fingerprint)
    .bind(actor)
    .fetch_one(pool)
    .await
    .map_err(|e| match &e {
        // 23505 unique_violation — surface a friendlier message than
        // "duplicate key value violates unique constraint".
        sqlx::Error::Database(db) if db.code().as_deref() == Some("23505") => {
            AppError::Validation(format!("A trusted CA called \"{name}\" already exists"))
        }
        _ => AppError::Database(e),
    })?;
    Ok(row)
}

pub async fn update(
    pool: &PgPool,
    id: Uuid,
    body: &UpdateTrustedCa,
) -> Result<Option<TrustedCaSummary>, AppError> {
    // Fetch the existing row so we can selectively overwrite fields.
    // PEM re-parse is only triggered when the admin sends a new bundle.
    let existing = get(pool, id).await?;
    let Some(existing) = existing else {
        return Ok(None);
    };

    let new_name = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&existing.name)
        .to_owned();
    let new_description = body
        .description
        .as_deref()
        .map(str::trim)
        .map(str::to_owned)
        .unwrap_or(existing.description.clone());

    let (pem, meta) = if let Some(pem) = &body.pem {
        if pem.trim().is_empty() {
            // Empty string means "keep existing".
            (
                existing.pem.clone(),
                ParsedMetadata {
                    subject: existing.subject.clone(),
                    not_after: existing.not_after,
                    fingerprint: existing.fingerprint.clone(),
                },
            )
        } else {
            parse_and_validate(pem)?
        }
    } else {
        (
            existing.pem.clone(),
            ParsedMetadata {
                subject: existing.subject.clone(),
                not_after: existing.not_after,
                fingerprint: existing.fingerprint.clone(),
            },
        )
    };

    let row = sqlx::query_as::<_, TrustedCaSummary>(
        "UPDATE trusted_ca_bundles
            SET name = $2,
                description = $3,
                pem = $4,
                subject = $5,
                not_after = $6,
                fingerprint = $7,
                updated_at = NOW()
          WHERE id = $1
        RETURNING id, name, description, subject, not_after, fingerprint,
                  created_at, updated_at",
    )
    .bind(id)
    .bind(&new_name)
    .bind(&new_description)
    .bind(&pem)
    .bind(&meta.subject)
    .bind(meta.not_after)
    .bind(&meta.fingerprint)
    .fetch_one(pool)
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(db) if db.code().as_deref() == Some("23505") => {
            AppError::Validation(format!("A trusted CA called \"{new_name}\" already exists"))
        }
        _ => AppError::Database(e),
    })?;
    Ok(Some(row))
}

pub async fn delete(pool: &PgPool, id: Uuid) -> Result<bool, AppError> {
    // Refuse to delete a CA still referenced by a connection so admins
    // don't silently break a kiosk.
    let in_use: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM connections
          WHERE protocol = 'web'
            AND (extra->>'trusted_ca_id') = $1::text",
    )
    .bind(id.to_string())
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    if in_use > 0 {
        return Err(AppError::Validation(format!(
            "Cannot delete: this CA is still attached to {in_use} web connection(s)"
        )));
    }

    let res = sqlx::query("DELETE FROM trusted_ca_bundles WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Materialise a stored CA bundle into the supplied Chromium user-data
/// directory's NSS DB so the kiosk picks it up automatically. Idempotent
/// per call: the NSS DB is created fresh under `<user_data_dir>/.pki/nssdb`
/// every session, so re-runs simply overwrite.
///
/// Requires `certutil` from the `libnss3-tools` package on the host
/// container — installed by the backend Dockerfile.
#[allow(dead_code)] // Pool-based convenience wrapper kept for future callers; the
                    // kiosk launcher currently calls `import_pem_into_nss_db` directly with the
                    // PEM it already carries on `WebSpawnSpec`.
pub async fn materialise_into_nss_db(
    pool: &PgPool,
    bundle_id: Uuid,
    user_data_dir: &std::path::Path,
) -> Result<(), AppError> {
    let detail = get(pool, bundle_id)
        .await?
        .ok_or_else(|| AppError::Validation(format!("Trusted CA {bundle_id} not found")))?;
    import_pem_into_nss_db(&detail.pem, user_data_dir, &bundle_id.to_string())
        .await
        .map_err(AppError::Internal)
}

/// Pool-free variant of [`materialise_into_nss_db`] for callers that
/// already hold the PEM (e.g. the kiosk launcher passes it in via
/// `WebSpawnSpec`). Returns a plain `String` error so it can be used
/// from modules that don't depend on `AppError`.
pub async fn import_pem_into_nss_db(
    pem: &str,
    user_data_dir: &std::path::Path,
    label: &str,
) -> Result<(), String> {
    let nss_dir = user_data_dir.join(".pki").join("nssdb");
    tokio::fs::create_dir_all(&nss_dir)
        .await
        .map_err(|e| format!("create nssdb dir: {e}"))?;

    let db_path = format!("sql:{}", nss_dir.display());

    // Initialise an empty DB with no master password. Errors here are
    // ignored when the DB already exists — the subsequent -A call
    // will succeed either way.
    let _ = tokio::process::Command::new("certutil")
        .args(["-N", "-d", &db_path, "--empty-password"])
        .output()
        .await;

    let mut reader = std::io::Cursor::new(pem.as_bytes());
    let blocks: Vec<_> = rustls_pemfile::certs(&mut reader)
        .collect::<Result<_, _>>()
        .map_err(|e| format!("PEM re-parse: {e}"))?;

    for (idx, der) in blocks.into_iter().enumerate() {
        let tmp = user_data_dir.join(format!("strata-ca-{idx}.der"));
        tokio::fs::write(&tmp, der.as_ref())
            .await
            .map_err(|e| format!("write temp cert: {e}"))?;

        let nickname = format!("strata-trust-{label}-{idx}");
        let out = tokio::process::Command::new("certutil")
            .args([
                "-A",
                "-d",
                &db_path,
                "-n",
                &nickname,
                "-t",
                "C,,",
                "-i",
                tmp.to_str().unwrap_or(""),
            ])
            .output()
            .await
            .map_err(|e| format!("certutil spawn: {e}"))?;
        let _ = tokio::fs::remove_file(&tmp).await;
        if !out.status.success() {
            return Err(format!(
                "certutil -A failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Self-signed leaf for `example.test` — generated once, embedded
    /// here as a known-good fixture so the parser tests don't depend on
    /// external tooling.
    const FIXTURE_PEM: &str = "-----BEGIN CERTIFICATE-----\n\
MIIBkTCCATegAwIBAgIUDc...\n\
-----END CERTIFICATE-----\n";

    #[test]
    fn rejects_empty() {
        let e = parse_and_validate("").unwrap_err();
        assert!(matches!(e, AppError::Validation(_)));
    }

    #[test]
    fn rejects_garbage() {
        let e = parse_and_validate("not a pem").unwrap_err();
        assert!(matches!(e, AppError::Validation(_)));
    }

    #[test]
    fn rejects_pem_without_certificate_blocks() {
        let only_key = "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n";
        let e = parse_and_validate(only_key).unwrap_err();
        assert!(matches!(e, AppError::Validation(_)));
    }

    // The FIXTURE_PEM constant is only a syntactic placeholder; a full
    // round-trip parse test belongs in the integration suite where we
    // can mint a real cert with `rcgen` at test time. Adding rcgen as
    // a dev-dep is left for a follow-up so the unit test surface stays
    // dependency-free.
    #[allow(dead_code)]
    fn _fixture_kept_for_future_integration_test() -> &'static str {
        FIXTURE_PEM
    }
}
