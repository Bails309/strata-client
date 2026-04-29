//! Periodic worker that retries `email_deliveries` rows whose previous
//! send attempt failed with a transient error.
//!
//! Runs every 30 seconds via the shared `services::worker::spawn_periodic`
//! harness.  Each iteration:
//!
//! 1. Selects up to 50 rows where `status = 'failed'` AND `attempts < 3`
//!    AND the exponential-backoff window has elapsed
//!    (`created_at + 2^attempts * 30s < NOW()`).
//! 2. Re-renders the original template using the data preserved in the
//!    `related_entity_id` (the source checkout) — for the v1 templates
//!    every variable can be reconstructed from the checkout row.
//! 3. Re-attempts the send and updates the row to `sent` /
//!    `failed`+1 / `bounced` (permanent).
//!
//! After 3 attempts the row is left at `failed` and an audit entry is
//! emitted so an admin can inspect it via the deliveries view.

use sqlx::{Pool, Postgres};
use std::time::Duration;
use uuid::Uuid;

use crate::services::app_state::{BootPhase, SharedState};

/// Spawn the email retry worker.
///
/// Starts with a 60-second initial delay so first-boot doesn't compete
/// with migration / vault unsealing for resources.
pub fn spawn_email_retry_worker(
    state: SharedState,
    shutdown: tokio_util::sync::CancellationToken,
) -> tokio::task::JoinHandle<()> {
    use crate::services::worker::{spawn_periodic, PeriodicConfig};
    spawn_periodic(
        PeriodicConfig {
            label: "email_retry",
            initial_delay: Duration::from_secs(60),
            interval: Duration::from_secs(30),
            iteration_timeout: Duration::from_secs(120),
            error_backoff_base: Duration::from_secs(30),
        },
        shutdown,
        move || {
            let state = state.clone();
            async move { run_retry_pass(state).await }
        },
    )
}

#[derive(sqlx::FromRow)]
struct DeliveryToRetry {
    id: Uuid,
    template_key: String,
    recipient_email: String,
    related_entity_id: Option<Uuid>,
    #[allow(dead_code)] // Selected so future logic can decide retry strategy by attempt count.
    attempts: i32,
}

async fn run_retry_pass(state: SharedState) -> anyhow::Result<()> {
    let (pool, vault) = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Ok(());
        }
        let pool =
            s.db.clone()
                .ok_or_else(|| anyhow::anyhow!("retry worker: no DB"))?
                .pool;
        let vault = s.config.as_ref().and_then(|c| c.vault.clone());
        (pool, vault)
    };

    // Window selector: `created_at + 2^attempts * 30s` is the earliest
    // moment we should retry.  attempts is in {1, 2}; window is 60s, 120s.
    let candidates: Vec<DeliveryToRetry> = sqlx::query_as(
        "SELECT id, template_key, recipient_email, related_entity_id, attempts
           FROM email_deliveries
          WHERE status = 'failed'
            AND attempts < 3
            AND created_at + (POWER(2, attempts) * INTERVAL '30 seconds') < NOW()
          ORDER BY created_at
          LIMIT 50",
    )
    .fetch_all(&pool)
    .await?;

    if candidates.is_empty() {
        return Ok(());
    }

    tracing::debug!("email retry worker: {} candidate(s)", candidates.len());

    for row in candidates {
        if let Err(e) = retry_one(&pool, vault.as_ref(), &row).await {
            tracing::warn!("email retry failed for delivery {}: {e}", row.id);
        }
    }

    // Permanently abandon any rows that have hit the cap; surface via audit
    // so admins can spot a misconfigured provider.
    let abandoned: Vec<(Uuid, String)> = sqlx::query_as(
        "UPDATE email_deliveries
            SET status = 'bounced',
                last_error = COALESCE(last_error, '') || ' [abandoned after 3 attempts]'
          WHERE status = 'failed' AND attempts >= 3
        RETURNING id, recipient_email",
    )
    .fetch_all(&pool)
    .await?;
    for (id, email) in abandoned {
        let _ = crate::services::audit::log(
            &pool,
            None,
            "notifications.abandoned",
            &serde_json::json!({ "delivery_id": id, "recipient": email }),
        )
        .await;
    }

    Ok(())
}

async fn retry_one(
    pool: &Pool<Postgres>,
    vault: Option<&crate::config::VaultConfig>,
    row: &DeliveryToRetry,
) -> anyhow::Result<()> {
    use crate::services::email::{
        EmailAddress, EmailMessage, EmailTransport, SmtpTransport, TemplateKey,
    };

    let template = match row.template_key.as_str() {
        "checkout_pending" => TemplateKey::CheckoutPending,
        "checkout_approved" => TemplateKey::CheckoutApproved,
        "checkout_rejected" => TemplateKey::CheckoutRejected,
        "checkout_self_approved" => TemplateKey::CheckoutSelfApproved,
        other => {
            anyhow::bail!("unknown template_key {other}");
        }
    };

    let checkout_id = row
        .related_entity_id
        .ok_or_else(|| anyhow::anyhow!("delivery has no related_entity_id"))?;

    // Reconstruct a minimal context from the source checkout.  This loses
    // the original approver_display_name (we don't store it on the
    // delivery row), but the body still reads correctly because the
    // approver line is optional in every template.
    let checkout = crate::services::checkouts::get_by_id(pool, checkout_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("source checkout {checkout_id} no longer exists"))?;

    // Mirror the dispatcher's account-label resolution: friendly_name
    // first (matches every UI surface), then a properly-escaped CN
    // parse, then the raw DN as a last resort.
    let target_cn = checkout
        .friendly_name
        .clone()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| crate::services::display::cn_from_dn(&checkout.managed_ad_dn))
        .unwrap_or_else(|| checkout.managed_ad_dn.clone());

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

    let expiry_human = match checkout.expires_at {
        Some(t) => crate::services::display::format_datetime_for_display(pool, t).await,
        None => String::new(),
    };

    let ctx = serde_json::json!({
        "accent": accent,
        "approve_url": format!("{}/admin/checkouts", base_url.trim_end_matches('/')),
        "profile_url": format!("{}/profile", base_url.trim_end_matches('/')),
        "requester_display_name": checkout.requester_username.clone().unwrap_or_default(),
        "requester_username": checkout.requester_username.clone().unwrap_or_default(),
        "approver_display_name": "the approver",
        "target_account_cn": target_cn,
        "justification": checkout.justification_comment,
        "requested_ttl_minutes": checkout.requested_duration_mins,
        "expiry_human": expiry_human,
    });

    let rendered = crate::services::email::render(template, &ctx)
        .map_err(|e| anyhow::anyhow!("render: {e}"))?;
    let subject = template.default_subject().to_owned();

    let smtp_settings = SmtpTransport::load_settings(pool, vault)
        .await
        .map_err(|e| anyhow::anyhow!("load smtp: {e}"))?;
    let from = if smtp_settings.from_name.is_empty() {
        EmailAddress::new(smtp_settings.from_address.clone())
    } else {
        EmailAddress::with_name(
            smtp_settings.from_address.clone(),
            smtp_settings.from_name.clone(),
        )
    };
    let to = EmailAddress::new(row.recipient_email.clone());
    let msg = EmailMessage::builder(from, to, &subject)
        .html(rendered.html_body)
        .text(rendered.text_body)
        .inline(crate::services::email::templates::logo_attachment())
        .build();

    let transport = SmtpTransport::from_settings(&smtp_settings)
        .map_err(|e| anyhow::anyhow!("smtp transport: {e}"))?;

    match transport.send(&msg).await {
        Ok(()) => {
            sqlx::query(
                "UPDATE email_deliveries
                    SET status = 'sent', sent_at = NOW(), attempts = attempts + 1
                  WHERE id = $1",
            )
            .bind(row.id)
            .execute(pool)
            .await?;
        }
        Err(e) => {
            let retryable = e.is_retryable();
            let status = if retryable { "failed" } else { "bounced" };
            sqlx::query(
                "UPDATE email_deliveries
                    SET status = $2, last_error = $3, attempts = attempts + 1
                  WHERE id = $1",
            )
            .bind(row.id)
            .bind(status)
            .bind(format!("{e}"))
            .execute(pool)
            .await?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    // The retry worker is exercised through the dispatcher's integration
    // tests (which cover the same DB row UPDATE paths).  Pure-unit cover
    // here would need a full pool + state mock — not worth the maintenance
    // burden for the small amount of straight-through code.
    #[test]
    fn smoke() {
        // Compile-only assertion that the module wires together.
        // (No runtime state worth asserting on; the integration tests cover
        // the actual retry path end-to-end.)
    }
}
