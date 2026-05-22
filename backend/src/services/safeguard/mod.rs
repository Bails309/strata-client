//! OneIdentity Safeguard JIT credential checkout.
//!
//! Adds support for resolving a Strata credential profile of `kind =
//! 'safeguard'` against a Safeguard appliance at tunnel-open time so
//! the actual password never lives in Strata's DB.
//!
//! Three layers:
//!  - [`config`]: DAO for the singleton `safeguard_config` row.
//!  - [`client`]: thin reqwest wrapper around the 4 REST endpoints we
//!    consume (LoginResponse, AccessRequests CRUD, CheckoutPassword,
//!    Checkin).
//!
//! Everything is opt-in: when [`config::load`] returns `enabled =
//! false` the rest of the system behaves as if Safeguard never existed.

pub mod client;
pub mod config;
pub mod password_cache;
pub mod user_token;

#[allow(unused_imports)]
pub use config::SafeguardConfig;

use crate::error::AppError;
use sqlx::PgPool;

/// Convenience: returns `true` iff Safeguard JIT is enabled in the DB.
/// Mirrors the multiplayer kill-switch pattern (`settings::get` lookup
/// at every entry point). Errors are mapped to `false` — a corrupted
/// row should fail closed.
#[allow(dead_code)] // Wired into resolve_credentials in a follow-up commit.
pub async fn kill_switch_enabled(pool: &PgPool) -> bool {
    config::load(pool).await.map(|c| c.enabled).unwrap_or(false)
}

/// Returned by the test-connection endpoint. Stable JSON shape; the
/// admin tab depends on these field names.
#[derive(serde::Serialize)]
pub struct TestConnectionOutcome {
    /// True iff every probed step succeeded.
    pub ok: bool,
    /// Short human-readable summary suitable for the admin toast.
    pub message: String,
    /// Per-step results, ordered: TCP, TLS, REST handshake.
    pub steps: Vec<TestStep>,
}

#[derive(serde::Serialize)]
pub struct TestStep {
    pub name: &'static str,
    pub ok: bool,
    pub detail: Option<String>,
}

impl TestConnectionOutcome {
    pub(crate) fn fail(message: impl Into<String>, steps: Vec<TestStep>) -> Self {
        Self {
            ok: false,
            message: message.into(),
            steps,
        }
    }
    pub(crate) fn success(message: impl Into<String>, steps: Vec<TestStep>) -> Self {
        Self {
            ok: true,
            message: message.into(),
            steps,
        }
    }
}

/// Re-export so callers don't need to import the error module too.
pub type Result<T> = std::result::Result<T, AppError>;

// ── High-level JIT orchestration ──────────────────────────────────────
//
// `jit_checkout` and `jit_checkin` are the two entry points the tunnel
// layer calls. They encapsulate:
//   1. Loading the live safeguard_config row (including the kill switch).
//   2. Unsealing the per-config A2A secrets via Vault.
//   3. Building a TLS-configured reqwest client with the identity loaded.
//   4. Exchanging A2A creds for a user token.
//   5. Performing the AccessRequest workflow against the appliance.
//   6. Writing a row to `safeguard_checkout_audit` at each transition
//      so operators can correlate Strata sessions ↔ Safeguard requests.
//
// The kill switch is checked FIRST and fails closed: when disabled, a
// `Validation` error is returned so the caller can surface a clean
// "Safeguard JIT is currently disabled" rather than a TLS error from a
// stale appliance.

/// Result of a successful JIT password checkout. Returned to the
/// tunnel handler so it can inject the password into the Guacamole
/// handshake AND remember the request id for auto-checkin on close.
pub struct CheckoutResult {
    /// Safeguard AccessRequest id, used for the matching checkin.
    pub request_id: String,
    /// The plaintext password as released by Safeguard. NEVER persist.
    pub password: String,
    /// Username to inject into the target (RDP/SSH) handshake. Built
    /// from Safeguard's `AccountName` + `AccountDomainName` so the
    /// remote host sees the correct logon name, not the numeric id.
    /// Empty/None means the caller should let the protocol prompt.
    pub username: Option<String>,
}

/// Wrapper around `client::checkout_password` that tolerates the
/// post-cancel password-reset race. When the preflight cancels an
/// existing `RequestAvailable` request, Safeguard immediately rotates
/// the account password — and the very next `CheckoutPassword` on
/// the freshly-created request returns Code 90010 ("another request
/// is pending password reset") for a few seconds while the rotation
/// completes. Retry with exponential backoff, capped at ~10s total.
async fn checkout_password_with_retry(
    http: &reqwest::Client,
    base: &str,
    bearer: &str,
    request_id: &str,
) -> Result<String> {
    let delays_ms = [0u64, 500, 1000, 2000, 3000, 4000];
    let mut last_err: Option<AppError> = None;
    for (i, d) in delays_ms.iter().enumerate() {
        if *d > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(*d)).await;
        }
        match client::checkout_password(http, base, bearer, request_id).await {
            Ok(pw) => {
                if i > 0 {
                    tracing::info!(
                        "checkout_password: succeeded on retry {i} for request {request_id}"
                    );
                }
                return Ok(pw);
            }
            Err(e) => {
                let msg = e.to_string();
                // Code 90010 = "pending password reset". Anything else
                // is a permanent failure (auth, validation, not found).
                if msg.contains("\"Code\":90010") || msg.contains("90010") {
                    tracing::info!(
                        "checkout_password: 90010 on attempt {i} for request {request_id}, retrying"
                    );
                    last_err = Some(e);
                    continue;
                }
                return Err(e);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| {
        AppError::Internal("checkout_password retry loop exhausted with no error captured".into())
    }))
}

/// Perform the full Safeguard JIT checkout flow for a single tunnel
/// open. Writes an audit row at request creation and at password
/// release. The caller MUST call [`jit_checkin`] when the session
/// ends (or accept Safeguard's policy-driven auto-checkin window).
#[allow(clippy::too_many_arguments)]
pub async fn jit_checkout(
    pool: &PgPool,
    vault: &crate::config::VaultConfig,
    account_id: &str,
    asset_id: &str,
    reason: &str,
    user_id: Option<uuid::Uuid>,
    connection_id: Option<uuid::Uuid>,
    profile_id: Option<uuid::Uuid>,
    requested_hours: Option<u32>,
) -> Result<CheckoutResult> {
    let cfg = config::load(pool).await?;
    if !cfg.enabled {
        return Err(AppError::Validation(
            "Safeguard JIT is disabled in admin settings".into(),
        ));
    }
    if account_id.trim().is_empty() || asset_id.trim().is_empty() {
        return Err(AppError::Validation(
            "Safeguard credential profile is missing account_id or asset".into(),
        ));
    }

    // Acquire a Safeguard API bearer per the configured auth mode.
    //  - per_user_browser: the user signed in via the Safeguard-PS
    //    helper and posted their token to Strata; we just unseal it.
    //  - a2a: appliance-trusted client cert + API key.
    //  - hybrid: per-user token wins, A2A is the fallback so a single
    //    user without a sign-in doesn't break shared JIT.
    let secrets = config::load_secrets(pool, vault).await?;
    let identity = client::a2a_identity(&secrets)?;
    let http = client::build_client(&cfg, identity)?;
    let base = client::base_url(&cfg);

    let bearer = match cfg.auth_mode {
        config::AuthMode::PerUserBrowser => {
            let uid = user_id.ok_or_else(|| {
                AppError::Validation(
                    "Safeguard per_user_browser mode requires an authenticated user".into(),
                )
            })?;
            user_token::load(pool, vault, uid).await?.ok_or_else(|| {
                // Stable error code the frontend matches on to prompt
                // for a fresh Connect-Safeguard sign-in.
                AppError::Validation("safeguard.signin_required".into())
            })?
        }
        config::AuthMode::A2a => {
            let api_key = secrets
                .a2a_api_key
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| {
                    AppError::Validation("Safeguard A2A API key is not configured".into())
                })?;
            client::a2a_login(&http, &base, api_key).await?
        }
        config::AuthMode::Hybrid => {
            let user_bearer = match user_id {
                Some(uid) => user_token::load(pool, vault, uid).await?,
                None => None,
            };
            match user_bearer {
                Some(t) => t,
                None => {
                    let api_key = secrets
                        .a2a_api_key
                        .as_deref()
                        .filter(|s| !s.trim().is_empty())
                        .ok_or_else(|| AppError::Validation("safeguard.signin_required".into()))?;
                    client::a2a_login(&http, &base, api_key).await?
                }
            }
        }
    };

    // Per-profile checkout duration wins when provided; otherwise
    // fall back to the global Safeguard admin default. Clamp to >= 1
    // because Safeguard rejects 0.
    let hours = requested_hours
        .unwrap_or(cfg.default_checkout_hours.max(1) as u32)
        .max(1);

    // Preflight: Safeguard rejects a second simultaneous request for
    // the same account by the same user, and silently returns the
    // EXISTING request id with the OLD password — which then fails
    // RDP auth because the appliance rotates the password on every
    // fresh request. Release any active requests the caller already
    // holds for this account/asset before opening a new one. We
    // ignore failures — if Safeguard has already closed the request
    // we don't want that to block the new checkout, and on a network
    // blip the user's POST below will surface the real error.
    match client::list_my_active_requests_for(&http, &base, &bearer, account_id, asset_id).await {
        Ok(stale) => {
            for (rid, state) in stale {
                // Pick the right release verb based on Safeguard's
                // workflow state. Once the password has been checked
                // out the request is releasable via CheckIn; before
                // that point (RequestAvailable, PendingApproval, etc.)
                // CheckIn returns Code 90114 and the right call is
                // Cancel. We try one, fall back to the other.
                let checked_out = state
                    .as_deref()
                    .map(|s| s.contains("CheckedOut"))
                    .unwrap_or(false);
                let (first, second): (&str, &str) = if checked_out {
                    ("CheckIn", "Cancel")
                } else {
                    ("Cancel", "CheckIn")
                };
                let try_release = |verb: &str| {
                    let http = http.clone();
                    let base = base.clone();
                    let bearer = bearer.clone();
                    let rid = rid.clone();
                    let verb = verb.to_string();
                    async move {
                        if verb == "CheckIn" {
                            client::checkin(&http, &base, &bearer, &rid).await
                        } else {
                            client::cancel(&http, &base, &bearer, &rid).await
                        }
                    }
                };
                match try_release(first).await {
                    Ok(()) => {
                        tracing::info!(
                            "jit_checkout: released stale access request {rid} via {first} (state={state:?}) for account {account_id}@{asset_id}"
                        );
                    }
                    Err(e1) => match try_release(second).await {
                        Ok(()) => {
                            tracing::info!(
                                "jit_checkout: released stale access request {rid} via {second} after {first} failed (state={state:?}) for account {account_id}@{asset_id}"
                            );
                        }
                        Err(e2) => {
                            tracing::warn!(
                                "jit_checkout: preflight release of existing request {rid} failed (state={state:?}); {first}: {e1}; {second}: {e2}"
                            );
                        }
                    },
                }
            }
        }
        Err(e) => {
            tracing::warn!("jit_checkout: preflight list Me/AccessRequests failed: {e}");
        }
    }

    let params = client::CreateAccessRequestParams {
        account_id,
        asset_id,
        hours,
        reason,
    };

    let created = client::create_access_request(&http, &base, &bearer, &params).await?;
    let request_id = created.request_id;
    // Use Safeguard's `Account.Name` verbatim as the logon name.
    // Some targets (Windows servers joined to the same domain as the
    // Strata host) reject `DOMAIN\user` via NLA when the credential
    // is a local account, and many AD targets accept the bare
    // sAMAccountName when the RDP `domain` arg is left empty. Keep
    // it simple: send what Safeguard says the account is called.
    let username = created.account_name.clone();
    insert_audit(
        pool,
        user_id,
        connection_id,
        profile_id,
        Some(&request_id),
        account_id,
        asset_id,
        "pending",
        None,
    )
    .await;

    let password = match checkout_password_with_retry(&http, &base, &bearer, &request_id).await {
        Ok(pw) => pw,
        Err(e) => {
            insert_audit(
                pool,
                user_id,
                connection_id,
                profile_id,
                Some(&request_id),
                account_id,
                asset_id,
                "failed",
                Some(&e.to_string()),
            )
            .await;
            return Err(e);
        }
    };

    insert_audit(
        pool,
        user_id,
        connection_id,
        profile_id,
        Some(&request_id),
        account_id,
        asset_id,
        "success",
        None,
    )
    .await;

    Ok(CheckoutResult {
        request_id,
        password,
        username,
    })
}

/// Release a previously-issued access request. Safe to call even
/// when the kill switch has been flipped off since checkout — the
/// caller still wants the appliance side cleaned up.
pub async fn jit_checkin(
    pool: &PgPool,
    vault: &crate::config::VaultConfig,
    request_id: &str,
    account_id: &str,
    asset_id: &str,
    user_id: Option<uuid::Uuid>,
    connection_id: Option<uuid::Uuid>,
) -> Result<()> {
    let cfg = config::load(pool).await?;
    let secrets = config::load_secrets(pool, vault).await?;
    let identity = client::a2a_identity(&secrets)?;
    let http = client::build_client(&cfg, identity)?;
    let base = client::base_url(&cfg);

    // Mirror jit_checkout's auth-mode branching so a checkin performed
    // on a per_user_browser deployment still works (the user's token
    // is required to release their own access request).
    let bearer_result: Result<String> = match cfg.auth_mode {
        config::AuthMode::PerUserBrowser => {
            let uid = user_id.ok_or_else(|| {
                AppError::Validation("Safeguard per_user_browser checkin requires a user".into())
            })?;
            user_token::load(pool, vault, uid)
                .await?
                .ok_or_else(|| AppError::Validation("safeguard.signin_required".into()))
        }
        config::AuthMode::A2a => {
            let api_key = secrets
                .a2a_api_key
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| {
                    AppError::Validation("Safeguard A2A API key is not configured".into())
                })?;
            client::a2a_login(&http, &base, api_key).await
        }
        config::AuthMode::Hybrid => {
            let user_bearer = match user_id {
                Some(uid) => user_token::load(pool, vault, uid).await?,
                None => None,
            };
            match user_bearer {
                Some(t) => Ok(t),
                None => {
                    let api_key = secrets
                        .a2a_api_key
                        .as_deref()
                        .filter(|s| !s.trim().is_empty())
                        .ok_or_else(|| AppError::Validation("safeguard.signin_required".into()))?;
                    client::a2a_login(&http, &base, api_key).await
                }
            }
        }
    };
    let bearer = bearer_result?;

    let outcome = match client::checkin(&http, &base, &bearer, request_id).await {
        Ok(()) => ("checked_in", None),
        Err(e) => ("failed", Some(e.to_string())),
    };
    insert_audit(
        pool,
        user_id,
        connection_id,
        None,
        Some(request_id),
        account_id,
        asset_id,
        outcome.0,
        outcome.1.as_deref(),
    )
    .await;
    if outcome.0 == "failed" {
        return Err(AppError::Internal(format!(
            "safeguard checkin failed for request {request_id}: {}",
            outcome.1.unwrap_or_default()
        )));
    }
    Ok(())
}

/// Outcome of a cache-validity probe.
///
///  * `Active`   — appliance confirmed the request is in
///    `PasswordCheckedOut`. Cached password is safe to reuse.
///  * `Inactive` — appliance confirmed the request has been
///    checked in / expired / revoked / 404'd. Evict the cache.
///  * `Unknown`  — could not query the appliance (no usable bearer,
///    transient network glitch, etc.). Caller should fail OPEN: keep
///    using the cache so an expired user token doesn't defeat the
///    whole point of caching. If the password is actually stale the
///    downstream RDP auth will fail and the user can sign in once to
///    refresh.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheValidity {
    Active,
    Inactive,
    Unknown,
}

/// Ask the appliance whether `request_id` is still in the
/// `PasswordCheckedOut` state. Validation is a read-only operation,
/// so we PREFER A2A creds (appliance-trusted, no expiry) when
/// configured — regardless of the deployment's primary `auth_mode`
/// — and fall back to the per-user bearer only when A2A isn't set
/// up. When neither is available the result is `Unknown`, NOT an
/// error: the caller treats Unknown as "use the cache" so the 15-min
/// RSTS token expiry doesn't force users to re-sign-in mid-day.
pub async fn check_request_validity(
    pool: &PgPool,
    vault: &crate::config::VaultConfig,
    request_id: &str,
    user_id: Option<uuid::Uuid>,
) -> Result<CacheValidity> {
    let cfg = config::load(pool).await?;
    if !cfg.enabled {
        return Ok(CacheValidity::Unknown);
    }
    let secrets = config::load_secrets(pool, vault).await?;
    let identity = client::a2a_identity(&secrets)?;
    let http = client::build_client(&cfg, identity)?;
    let base = client::base_url(&cfg);

    // Prefer A2A: it doesn't expire and doesn't depend on the user's
    // browser sign-in being recent.
    let a2a_bearer: Option<String> = match secrets
        .a2a_api_key
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        Some(api_key) => match client::a2a_login(&http, &base, api_key).await {
            Ok(b) => Some(b),
            Err(e) => {
                tracing::debug!("safeguard cache validation: A2A login failed: {e}");
                None
            }
        },
        None => None,
    };
    let bearer = match a2a_bearer {
        Some(b) => Some(b),
        None => match user_id {
            Some(uid) => user_token::load(pool, vault, uid).await?,
            None => None,
        },
    };
    let Some(bearer) = bearer else {
        // Nothing usable — fail open.
        return Ok(CacheValidity::Unknown);
    };

    match client::get_access_request_state(&http, &base, &bearer, request_id).await {
        Ok(state) => {
            if matches!(state.as_deref(), Some("PasswordCheckedOut")) {
                Ok(CacheValidity::Active)
            } else {
                Ok(CacheValidity::Inactive)
            }
        }
        Err(e) => {
            tracing::debug!("safeguard cache validation: state probe failed: {e}");
            Ok(CacheValidity::Unknown)
        }
    }
}

/// Expand `{session_id}` and `{user}` placeholders in the configured
/// reason template. Anything not matched is left literally so admins
/// can include free text without quoting.
pub fn render_reason(template: &str, session_id: &str, user: &str) -> String {
    template
        .replace("{session_id}", session_id)
        .replace("{user}", user)
}

#[allow(clippy::too_many_arguments)]
async fn insert_audit(
    pool: &PgPool,
    user_id: Option<uuid::Uuid>,
    _connection_id: Option<uuid::Uuid>,
    profile_id: Option<uuid::Uuid>,
    safeguard_request_id: Option<&str>,
    account_id: &str,
    asset: &str,
    outcome: &str,
    error: Option<&str>,
) {
    // Audit writes are best-effort — a DB hiccup must NOT prevent a
    // successful checkout from being returned to the user. Log + drop.
    // user_id is NOT NULL in the schema; if the caller didn't pass one
    // (background tasks etc.) we skip the write rather than crash.
    let Some(uid) = user_id else {
        return;
    };
    let res = sqlx::query(
        "INSERT INTO safeguard_checkout_audit
           (user_id, profile_id, sg_request_id,
            sg_account_id, sg_asset, outcome, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(uid)
    .bind(profile_id)
    .bind(safeguard_request_id)
    .bind(account_id)
    .bind(asset)
    .bind(outcome)
    .bind(error)
    .execute(pool)
    .await;
    if let Err(e) = res {
        tracing::warn!("safeguard audit insert failed ({outcome}): {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_reason_substitutes_placeholders() {
        let r = render_reason("Strata {session_id} for {user}", "abc", "alice");
        assert_eq!(r, "Strata abc for alice");
    }

    #[test]
    fn render_reason_handles_missing_placeholders() {
        let r = render_reason("manual reason", "abc", "alice");
        assert_eq!(r, "manual reason");
    }

    #[test]
    fn render_reason_handles_duplicates() {
        let r = render_reason("{user} {user}", "x", "bob");
        assert_eq!(r, "bob bob");
    }
}
