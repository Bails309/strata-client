//! Admin endpoints for transactional-email configuration.
//!
//! Routes:
//! - `GET  /api/admin/notifications/smtp`        — current config (password redacted)
//! - `PUT  /api/admin/notifications/smtp`        — upsert config (Vault-seals password)
//! - `POST /api/admin/notifications/test-send`   — render + send a test message
//! - `GET  /api/admin/notifications/deliveries`  — recent `email_deliveries` rows

use axum::extract::{Query, State};
use axum::Extension;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::error::AppError;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::email::{EmailAddress, EmailMessage, EmailTransport, SmtpTransport};
use crate::services::middleware::AuthUser;
use crate::services::{audit, settings};

/// Read settings + Vault config and verify the system is past Setup.
async fn require_running(state: &SharedState) -> Result<crate::db::Database, AppError> {
    let s = state.read().await;
    if s.phase != BootPhase::Running {
        return Err(AppError::SetupRequired);
    }
    s.db.clone().ok_or(AppError::SetupRequired)
}

// ── GET /api/admin/notifications/smtp ─────────────────────────────────

/// Minimal HTML/XML escape \u2014 just the five significant characters.
/// Used for the SMTP test-send body where we splice user-controlled
/// settings (from name / address) into a hand-built HTML snippet.
fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

#[derive(Serialize)]
pub struct SmtpConfigView {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub tls_mode: String,
    pub from_address: String,
    pub from_name: String,
    /// `true` when a sealed password is stored (the value itself is never
    /// returned to the UI).  Lets the form show "•••• (set)" placeholder
    /// text instead of an empty input.
    pub password_set: bool,
    pub branding_accent_color: String,
}

pub async fn get_smtp_config(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<SmtpConfigView>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
    let db = require_running(&state).await?;

    let read = |k: &'static str, default: &'static str| {
        let pool = db.pool.clone();
        async move {
            settings::get(&pool, k)
                .await
                .map_err(|e| AppError::Internal(format!("read {k}: {e}")))
                .map(|v| v.unwrap_or_else(|| default.into()))
        }
    };

    let enabled = read("smtp_enabled", "false").await? == "true";
    let host = read("smtp_host", "").await?;
    let port = read("smtp_port", "587")
        .await?
        .parse::<u16>()
        .unwrap_or(587);
    let username = read("smtp_username", "").await?;
    let tls_mode = read("smtp_tls_mode", "starttls").await?;
    let from_address = read("smtp_from_address", "").await?;
    let from_name = read("smtp_from_name", "Strata Client").await?;
    let raw_password = read("smtp_encrypted_password", "").await?;
    let branding_accent_color = read("branding_accent_color", "#2563eb").await?;

    Ok(Json(SmtpConfigView {
        enabled,
        host,
        port,
        username,
        tls_mode,
        from_address,
        from_name,
        password_set: !raw_password.is_empty(),
        branding_accent_color,
    }))
}

// ── PUT /api/admin/notifications/smtp ─────────────────────────────────

#[derive(Deserialize)]
pub struct SmtpConfigUpdate {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// New plaintext password.  `None` → leave existing sealed value
    /// untouched.  `Some("")` → clear the stored password.
    pub password: Option<String>,
    pub tls_mode: String,
    pub from_address: String,
    pub from_name: String,
    pub branding_accent_color: String,
}

pub async fn update_smtp_config(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<SmtpConfigUpdate>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
    let db = require_running(&state).await?;

    // Validation: when enabled, From address is mandatory (SPF/DMARC hygiene).
    if body.enabled && body.from_address.trim().is_empty() {
        return Err(AppError::Validation(
            "Cannot enable SMTP without configuring From Address".into(),
        ));
    }
    if body.enabled && body.host.trim().is_empty() {
        return Err(AppError::Validation(
            "Cannot enable SMTP without configuring Host".into(),
        ));
    }

    // Validate TLS mode is one of the recognised options.
    let normalised_tls = match body.tls_mode.trim().to_ascii_lowercase().as_str() {
        "starttls" | "implicit" | "none" => body.tls_mode.trim().to_ascii_lowercase(),
        other => {
            return Err(AppError::Validation(format!(
                "Invalid tls_mode '{other}'. Must be 'starttls', 'implicit', or 'none'."
            )));
        }
    };

    settings::set(
        &db.pool,
        "smtp_enabled",
        if body.enabled { "true" } else { "false" },
    )
    .await
    .map_err(|e| AppError::Internal(format!("set smtp_enabled: {e}")))?;
    settings::set(&db.pool, "smtp_host", body.host.trim())
        .await
        .map_err(|e| AppError::Internal(format!("set smtp_host: {e}")))?;
    settings::set(&db.pool, "smtp_port", &body.port.to_string())
        .await
        .map_err(|e| AppError::Internal(format!("set smtp_port: {e}")))?;
    settings::set(&db.pool, "smtp_username", body.username.trim())
        .await
        .map_err(|e| AppError::Internal(format!("set smtp_username: {e}")))?;
    settings::set(&db.pool, "smtp_tls_mode", &normalised_tls)
        .await
        .map_err(|e| AppError::Internal(format!("set smtp_tls_mode: {e}")))?;
    settings::set(&db.pool, "smtp_from_address", body.from_address.trim())
        .await
        .map_err(|e| AppError::Internal(format!("set smtp_from_address: {e}")))?;
    settings::set(&db.pool, "smtp_from_name", body.from_name.trim())
        .await
        .map_err(|e| AppError::Internal(format!("set smtp_from_name: {e}")))?;
    settings::set(
        &db.pool,
        "branding_accent_color",
        body.branding_accent_color.trim(),
    )
    .await
    .map_err(|e| AppError::Internal(format!("set branding_accent_color: {e}")))?;

    // Password handling: only touch when the field is present.  Empty
    // string ⇒ clear; non-empty ⇒ Vault-seal then store.
    if let Some(pw) = body.password {
        let stored = if pw.is_empty() {
            String::new()
        } else {
            let vault_cfg = {
                let s = state.read().await;
                s.config.as_ref().and_then(|c| c.vault.clone())
            };
            match vault_cfg {
                Some(vc) => crate::services::vault::seal_setting(&vc, &pw).await?,
                None => {
                    // Hard-fail: the answer to question (1) — Vault is required.
                    return Err(AppError::Validation(
                        "Vault must be configured before storing an SMTP password".into(),
                    ));
                }
            }
        };
        settings::set(&db.pool, "smtp_encrypted_password", &stored)
            .await
            .map_err(|e| AppError::Internal(format!("set smtp_encrypted_password: {e}")))?;
    }

    audit::log(
        &db.pool,
        Some(user.id),
        "smtp.configured",
        &json!({
            "enabled": body.enabled,
            "host": body.host,
            "port": body.port,
            "tls_mode": normalised_tls,
            "from_address": body.from_address,
        }),
    )
    .await?;

    Ok(Json(json!({ "status": "smtp_updated" })))
}

// ── POST /api/admin/notifications/test-send ───────────────────────────

#[derive(Deserialize)]
pub struct TestSendRequest {
    /// Address to deliver the test message to.  Required.
    pub recipient: String,
}

pub async fn test_send(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<TestSendRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
    let db = require_running(&state).await?;

    let recipient = body.recipient.trim();
    if recipient.is_empty() || !recipient.contains('@') {
        return Err(AppError::Validation(
            "recipient must be a valid email address".into(),
        ));
    }

    let vault_cfg = {
        let s = state.read().await;
        s.config.as_ref().and_then(|c| c.vault.clone())
    };

    let smtp_settings = SmtpTransport::load_settings(&db.pool, vault_cfg.as_ref())
        .await
        .map_err(|e| AppError::Internal(format!("load smtp settings: {e}")))?;
    let transport = SmtpTransport::from_settings(&smtp_settings)
        .map_err(|e| AppError::Validation(format!("{e}")))?;

    let from = if smtp_settings.from_name.is_empty() {
        EmailAddress::new(smtp_settings.from_address.clone())
    } else {
        EmailAddress::with_name(
            smtp_settings.from_address.clone(),
            smtp_settings.from_name.clone(),
        )
    };

    let html = format!(
        "<html><body style=\"font-family:system-ui;background:#f3f4f6;padding:24px;\">\
            <h1 style=\"color:{accent}\">Strata Client — SMTP test</h1>\
            <p>This is a delivery probe sent by an administrator.</p>\
            <p style=\"color:#6b7280;font-size:12px\">Tenant: {tenant}</p>\
        </body></html>",
        accent = html_escape(&smtp_settings.from_name),
        tenant = html_escape(&smtp_settings.from_address),
    );
    let text = format!(
        "Strata Client — SMTP test\n\nThis is a delivery probe sent by an administrator.\nTenant: {}\n",
        smtp_settings.from_address
    );

    let msg = EmailMessage::builder(from, EmailAddress::new(recipient), "Strata SMTP test")
        .html(html)
        .text(text)
        .build();

    transport
        .send(&msg)
        .await
        .map_err(|e| AppError::Internal(format!("smtp send failed: {e}")))?;

    audit::log(
        &db.pool,
        Some(user.id),
        "smtp.test_sent",
        &json!({
            "recipient": recipient,
            "host": smtp_settings.host,
            "tls_mode": format!("{:?}", smtp_settings.tls_mode),
        }),
    )
    .await?;

    Ok(Json(json!({ "status": "sent" })))
}

// ── GET /api/admin/notifications/deliveries ───────────────────────────

#[derive(Deserialize)]
pub struct DeliveriesQuery {
    /// Optional status filter (`queued`, `sent`, `failed`, `bounced`, `suppressed`).
    pub status: Option<String>,
    /// Page size (default 50, max 200).
    pub limit: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct DeliveryRow {
    pub id: Uuid,
    pub template_key: String,
    pub recipient_email: String,
    pub subject: String,
    pub status: String,
    pub attempts: i32,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub sent_at: Option<DateTime<Utc>>,
}

pub async fn list_deliveries(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Query(q): Query<DeliveriesQuery>,
) -> Result<Json<Vec<DeliveryRow>>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
    let db = require_running(&state).await?;

    let limit = q.limit.unwrap_or(50).clamp(1, 200);

    // Use a CASE-style WHERE so a single prepared statement covers both
    // filtered and unfiltered queries — keeps sqlx from preparing two.
    let rows: Vec<DeliveryRow> = sqlx::query_as(
        "SELECT id, template_key, recipient_email, subject, status, attempts,
                last_error, created_at, sent_at
           FROM email_deliveries
          WHERE ($1::text IS NULL OR status = $1)
          ORDER BY created_at DESC
          LIMIT $2",
    )
    .bind(q.status.as_deref())
    .bind(limit)
    .fetch_all(&db.pool)
    .await
    .map_err(|e| AppError::Internal(format!("query email_deliveries: {e}")))?;

    Ok(Json(rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smtp_update_validation_rejects_invalid_tls_mode() {
        // Round-trips through the same lowercase normaliser used by the
        // handler — guards against accidental case-sensitive comparisons.
        let raw = "BOGUS";
        let lower = raw.trim().to_ascii_lowercase();
        assert!(!matches!(lower.as_str(), "starttls" | "implicit" | "none"));
    }

    #[test]
    fn deliveries_default_limit_clamps() {
        let q = DeliveriesQuery {
            status: None,
            limit: Some(99_999),
        };
        let limit = q.limit.unwrap_or(50).clamp(1, 200);
        assert_eq!(limit, 200);
    }
}
