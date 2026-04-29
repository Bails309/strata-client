//! Domain-event dispatcher for transactional email.
//!
//! Public entry points:
//! - [`CheckoutEvent`]   — typed enum of every notification-emitting moment.
//! - [`spawn_dispatch`]  — fire-and-forget hook called from route handlers.
//! - [`dispatch`]        — synchronous version used by tests and the retry worker.
//!
//! Each call:
//! 1. Resolves recipients (filters opt-outs except for `SelfApproved`).
//! 2. Inserts an `email_deliveries` row per recipient with status `queued`.
//! 3. Renders the template through [`email::render`].
//! 4. Calls the configured SMTP transport.
//! 5. UPDATEs the row to `sent` / `failed` / `bounced` / `suppressed`.
//!
//! Notifications are an observability concern: we never bubble a send
//! failure back to the originating HTTP handler.

use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx::{Pool, Postgres};
use uuid::Uuid;

use crate::config::VaultConfig;
use crate::services::audit;
use crate::services::email::{
    self, EmailAddress, EmailMessage, EmailTransport, SmtpTransport, TemplateKey,
};

/// A domain event that may produce one or more transactional emails.
///
/// Each variant carries the minimum context required to render every
/// template it will fan out to — the dispatcher does **not** call back
/// into the database for additional fields, so a checkout that is
/// approved and then immediately deleted still produces a consistent
/// email.
#[derive(Debug, Clone)]
#[allow(dead_code)] // `target_account_dn` is captured for future filtering / audit enrichment; not read by today's templates.
pub enum CheckoutEvent {
    /// A new checkout request has been submitted and is awaiting approver
    /// action.  Fans out to every user whose role covers the target
    /// `managed_ad_dn`, plus a courtesy copy to the requester.
    Pending {
        checkout_id: Uuid,
        requester_id: Uuid,
        requester_display_name: String,
        requester_username: String,
        target_account_dn: String,
        target_account_cn: String,
        justification: String,
        requested_ttl_minutes: i32,
        approver_user_ids: Vec<Uuid>,
    },

    /// An approver has approved a pending request.  Emails the requester.
    Approved {
        checkout_id: Uuid,
        requester_id: Uuid,
        requester_display_name: String,
        approver_display_name: String,
        target_account_dn: String,
        target_account_cn: String,
        expires_at: DateTime<Utc>,
    },

    /// An approver has rejected a pending request.  Emails the requester.
    Rejected {
        checkout_id: Uuid,
        requester_id: Uuid,
        requester_display_name: String,
        approver_display_name: String,
        target_account_dn: String,
        target_account_cn: String,
    },

    /// The requester holds `can_self_approve` on the mapping and bypassed
    /// the approval queue.  Emails the requester for an audit-trail copy.
    /// **Ignores `notifications_opt_out`** — this message exists
    /// precisely to make the privileged action visible.
    SelfApproved {
        checkout_id: Uuid,
        requester_id: Uuid,
        requester_display_name: String,
        target_account_dn: String,
        target_account_cn: String,
        expires_at: DateTime<Utc>,
    },
}

impl CheckoutEvent {
    fn template_key(&self) -> TemplateKey {
        match self {
            CheckoutEvent::Pending { .. } => TemplateKey::CheckoutPending,
            CheckoutEvent::Approved { .. } => TemplateKey::CheckoutApproved,
            CheckoutEvent::Rejected { .. } => TemplateKey::CheckoutRejected,
            CheckoutEvent::SelfApproved { .. } => TemplateKey::CheckoutSelfApproved,
        }
    }

    fn ignores_opt_out(&self) -> bool {
        matches!(self, CheckoutEvent::SelfApproved { .. })
    }

    fn checkout_id(&self) -> Uuid {
        match self {
            CheckoutEvent::Pending { checkout_id, .. }
            | CheckoutEvent::Approved { checkout_id, .. }
            | CheckoutEvent::Rejected { checkout_id, .. }
            | CheckoutEvent::SelfApproved { checkout_id, .. } => *checkout_id,
        }
    }
}

// ── Recipient resolution ──────────────────────────────────────────────

#[derive(Debug, Clone, sqlx::FromRow)]
struct RecipientRow {
    id: Uuid,
    email: Option<String>,
    full_name: Option<String>,
    #[allow(dead_code)]
    username: String,
    notifications_opt_out: bool,
}

async fn fetch_user(pool: &Pool<Postgres>, id: Uuid) -> Result<Option<RecipientRow>, sqlx::Error> {
    sqlx::query_as::<_, RecipientRow>(
        "SELECT id, email, full_name, username,
                COALESCE(notifications_opt_out, false) AS notifications_opt_out
           FROM users WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}

async fn fetch_users(
    pool: &Pool<Postgres>,
    ids: &[Uuid],
) -> Result<Vec<RecipientRow>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    sqlx::query_as::<_, RecipientRow>(
        "SELECT id, email, full_name, username,
                COALESCE(notifications_opt_out, false) AS notifications_opt_out
           FROM users WHERE id = ANY($1)",
    )
    .bind(ids)
    .fetch_all(pool)
    .await
}

// ── Public API ────────────────────────────────────────────────────────

/// Fire-and-forget dispatch — spawns onto the current Tokio runtime so
/// the calling handler returns immediately.
pub fn spawn_dispatch(pool: Pool<Postgres>, vault: Option<VaultConfig>, event: CheckoutEvent) {
    tokio::spawn(async move {
        if let Err(e) = dispatch(&pool, vault.as_ref(), event).await {
            tracing::error!("notification dispatch failed: {e}");
        }
    });
}

/// Synchronous dispatch (tests, retry worker).
pub async fn dispatch(
    pool: &Pool<Postgres>,
    vault: Option<&VaultConfig>,
    event: CheckoutEvent,
) -> Result<(), String> {
    let template = event.template_key();
    let ignores_opt_out = event.ignores_opt_out();

    let recipients = resolve_recipients(pool, &event)
        .await
        .map_err(|e| format!("resolve recipients: {e}"))?;

    if recipients.is_empty() {
        tracing::debug!("no recipients for {} (no users on file)", template.as_str());
        return Ok(());
    }

    // Apply opt-out filter and audit each suppression for non-audit events.
    let mut filtered: Vec<RecipientRow> = Vec::with_capacity(recipients.len());
    for r in recipients {
        if r.notifications_opt_out && !ignores_opt_out {
            let _ = audit::log(
                pool,
                Some(r.id),
                "notifications.skipped_opt_out",
                &json!({
                    "template": template.as_str(),
                    "checkout_id": event.checkout_id(),
                }),
            )
            .await;
            continue;
        }
        if r.email.as_deref().map(str::is_empty).unwrap_or(true) {
            continue;
        }
        filtered.push(r);
    }

    if filtered.is_empty() {
        return Ok(());
    }

    // Build template context once — recipient-specific fields are not
    // currently part of these templates.
    let context = build_context(pool, &event).await;
    let rendered = email::render(template, &context).map_err(|e| format!("render: {e}"))?;
    let subject = template.default_subject().to_owned();

    // Load SMTP settings once per dispatch (transport built per-recipient
    // so a config change picks up on the next iteration).
    let smtp_settings = SmtpTransport::load_settings(pool, vault)
        .await
        .map_err(|e| format!("load smtp settings: {e}"))?;
    let from = if smtp_settings.from_name.is_empty() {
        EmailAddress::new(smtp_settings.from_address.clone())
    } else {
        EmailAddress::with_name(
            smtp_settings.from_address.clone(),
            smtp_settings.from_name.clone(),
        )
    };

    for r in filtered {
        let row_id = match insert_delivery_row(
            pool,
            template.as_str(),
            r.id,
            r.email.as_deref().unwrap_or(""),
            &subject,
            event.checkout_id(),
        )
        .await
        {
            Ok(id) => id,
            Err(e) => {
                tracing::warn!("insert email_deliveries failed: {e}");
                continue;
            }
        };

        let to = match &r.full_name {
            Some(name) if !name.is_empty() => {
                EmailAddress::with_name(r.email.clone().unwrap_or_default(), name.clone())
            }
            _ => EmailAddress::new(r.email.clone().unwrap_or_default()),
        };

        let msg = EmailMessage::builder(from.clone(), to, &subject)
            .html(rendered.html_body.clone())
            .text(rendered.text_body.clone())
            .inline(crate::services::email::templates::logo_attachment())
            .build();

        match SmtpTransport::from_settings(&smtp_settings) {
            Err(e) => {
                let _ = mark_suppressed(pool, row_id, &format!("{e}")).await;
            }
            Ok(transport) => match transport.send(&msg).await {
                Ok(()) => {
                    if let Err(e) = mark_sent(pool, row_id).await {
                        tracing::warn!("could not mark delivery {row_id} sent: {e}");
                    }
                }
                Err(e) => {
                    let retryable = e.is_retryable();
                    if let Err(e2) = mark_failed(pool, row_id, &format!("{e}"), retryable).await {
                        tracing::warn!("could not mark delivery {row_id} failed: {e2}");
                    }
                }
            },
        }
    }

    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────

async fn resolve_recipients(
    pool: &Pool<Postgres>,
    event: &CheckoutEvent,
) -> Result<Vec<RecipientRow>, sqlx::Error> {
    match event {
        CheckoutEvent::Pending {
            requester_id,
            approver_user_ids,
            ..
        } => {
            let mut all: Vec<Uuid> = approver_user_ids.clone();
            all.push(*requester_id);
            all.sort();
            all.dedup();
            fetch_users(pool, &all).await
        }
        CheckoutEvent::Approved { requester_id, .. }
        | CheckoutEvent::Rejected { requester_id, .. }
        | CheckoutEvent::SelfApproved { requester_id, .. } => {
            Ok(fetch_user(pool, *requester_id).await?.into_iter().collect())
        }
    }
}

async fn build_context(pool: &Pool<Postgres>, event: &CheckoutEvent) -> serde_json::Value {
    let accent = crate::services::settings::get(pool, "branding_accent_color")
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "#2563eb".into());
    let base_url = crate::services::settings::get(pool, "tenant_base_url")
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "https://strata.local".into());
    let approve_url = format!("{}/admin/checkouts", base_url.trim_end_matches('/'));
    let profile_url = format!("{}/profile", base_url.trim_end_matches('/'));

    match event {
        CheckoutEvent::Pending {
            requester_display_name,
            requester_username,
            target_account_cn,
            justification,
            requested_ttl_minutes,
            ..
        } => json!({
            "accent": accent,
            "approve_url": approve_url,
            "profile_url": profile_url,
            "requester_display_name": requester_display_name,
            "requester_username": requester_username,
            "target_account_cn": target_account_cn,
            "justification": justification,
            "requested_ttl_minutes": requested_ttl_minutes,
        }),
        CheckoutEvent::Approved {
            requester_display_name,
            approver_display_name,
            target_account_cn,
            expires_at,
            ..
        } => json!({
            "accent": accent,
            "approve_url": approve_url,
            "profile_url": profile_url,
            "requester_display_name": requester_display_name,
            "approver_display_name": approver_display_name,
            "target_account_cn": target_account_cn,
            "expiry_human": crate::services::display::format_datetime_for_display(pool, *expires_at).await,
        }),
        CheckoutEvent::Rejected {
            requester_display_name,
            approver_display_name,
            target_account_cn,
            ..
        } => json!({
            "accent": accent,
            "approve_url": approve_url,
            "profile_url": profile_url,
            "requester_display_name": requester_display_name,
            "approver_display_name": approver_display_name,
            "target_account_cn": target_account_cn,
        }),
        CheckoutEvent::SelfApproved {
            requester_display_name,
            target_account_cn,
            expires_at,
            ..
        } => json!({
            "accent": accent,
            "approve_url": approve_url,
            "profile_url": profile_url,
            "requester_display_name": requester_display_name,
            "target_account_cn": target_account_cn,
            "expiry_human": crate::services::display::format_datetime_for_display(pool, *expires_at).await,
        }),
    }
}

// ── DB row helpers ────────────────────────────────────────────────────

async fn insert_delivery_row(
    pool: &Pool<Postgres>,
    template_key: &str,
    recipient_user_id: Uuid,
    recipient_email: &str,
    subject: &str,
    checkout_id: Uuid,
) -> Result<Uuid, sqlx::Error> {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO email_deliveries
           (template_key, recipient_user_id, recipient_email, subject,
            related_entity_type, related_entity_id, status, attempts)
         VALUES ($1, $2, $3, $4, 'checkout', $5, 'queued', 0)
         RETURNING id",
    )
    .bind(template_key)
    .bind(recipient_user_id)
    .bind(recipient_email)
    .bind(subject)
    .bind(checkout_id)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

async fn mark_sent(pool: &Pool<Postgres>, id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE email_deliveries
            SET status = 'sent', sent_at = NOW(), attempts = attempts + 1
          WHERE id = $1",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn mark_failed(
    pool: &Pool<Postgres>,
    id: Uuid,
    err: &str,
    retryable: bool,
) -> Result<(), sqlx::Error> {
    let status = if retryable { "failed" } else { "bounced" };
    sqlx::query(
        "UPDATE email_deliveries
            SET status = $2, last_error = $3, attempts = attempts + 1
          WHERE id = $1",
    )
    .bind(id)
    .bind(status)
    .bind(err)
    .execute(pool)
    .await?;
    Ok(())
}

async fn mark_suppressed(pool: &Pool<Postgres>, id: Uuid, reason: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE email_deliveries
            SET status = 'suppressed', last_error = $2, attempts = attempts + 1
          WHERE id = $1",
    )
    .bind(id)
    .bind(reason)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nil_pending() -> CheckoutEvent {
        CheckoutEvent::Pending {
            checkout_id: Uuid::nil(),
            requester_id: Uuid::nil(),
            requester_display_name: "Ada".into(),
            requester_username: "ada".into(),
            target_account_dn: "CN=svc,OU=Service,DC=example,DC=com".into(),
            target_account_cn: "svc".into(),
            justification: "patch tuesday".into(),
            requested_ttl_minutes: 60,
            approver_user_ids: vec![],
        }
    }

    #[test]
    fn template_key_mapping_is_consistent() {
        assert_eq!(nil_pending().template_key().as_str(), "checkout_pending");
        assert!(!nil_pending().ignores_opt_out());

        let self_app = CheckoutEvent::SelfApproved {
            checkout_id: Uuid::nil(),
            requester_id: Uuid::nil(),
            requester_display_name: "Ada".into(),
            target_account_dn: "x".into(),
            target_account_cn: "y".into(),
            expires_at: Utc::now(),
        };
        assert_eq!(self_app.template_key().as_str(), "checkout_self_approved");
        assert!(
            self_app.ignores_opt_out(),
            "self-approved must ignore opt-out"
        );
    }

    #[test]
    fn checkout_id_extracted_from_each_variant() {
        let id = Uuid::new_v4();
        let approved = CheckoutEvent::Approved {
            checkout_id: id,
            requester_id: Uuid::nil(),
            requester_display_name: "Ada".into(),
            approver_display_name: "Grace".into(),
            target_account_dn: "x".into(),
            target_account_cn: "y".into(),
            expires_at: Utc::now(),
        };
        assert_eq!(approved.checkout_id(), id);
    }
}
