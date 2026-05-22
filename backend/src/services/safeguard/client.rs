//! Thin wrapper around the OneIdentity Safeguard Web API endpoints we
//! consume. Built lazily per request because we have to honour the
//! per-config `verify_tls` toggle, the per-config CA bundle, and (for
//! A2A) a client cert + key — none of which fit a shared `OnceLock`
//! pool.
//!
//! Endpoints used (Safeguard 2.x):
//!  * `POST /service/core/v4/Token/LoginResponse`  — exchange A2A
//!    credentials for a bearer; or, for OIDC, finalise a federated
//!    login (per-user OIDC path is scaffolded but currently 501s).
//!  * `GET  /service/core/v4/Me`                   — handshake probe.
//!  * `GET  /service/core/v4/AccessRequests`       — look up an
//!    existing pending request.
//!  * `POST /service/core/v4/AccessRequests`       — open a new
//!    password-checkout request.
//!  * `POST /service/core/v4/AccessRequests/{id}/CheckoutPassword`
//!  * `POST /service/core/v4/AccessRequests/{id}/Checkin`
//!
//! For MVP this module only implements:
//!   - [`build_client`]: construct a per-config `reqwest::Client`.
//!   - [`probe_me`]: hit `GET /Me` to verify reachability + auth.
//!   - [`a2a_login`]: token exchange for the A2A mode.
//!
//! The actual access-request CRUD will land in the follow-up commit
//! that wires `resolve_credentials` into the tunnel path. Splitting
//! it up keeps this commit reviewable and ships a working
//! configurator + connectivity check.

use std::time::Duration;

use reqwest::{Certificate, Client, Identity};
use serde::Deserialize;

use crate::error::AppError;

use super::config::{ResolvedSecrets, SafeguardConfig};

/// Overall HTTP timeout for Safeguard calls. Safeguard's REST surface
/// is typically <500 ms but we allow up to 15 s to absorb appliance
/// patch / boot windows during ops events.
const TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Construct a per-request reqwest client honouring the operator's
/// TLS preferences. The CA bundle (if provided) is layered ON TOP of
/// the system trust store — we never disable the default roots, only
/// add to them.
pub fn build_client(cfg: &SafeguardConfig, identity: Option<Identity>) -> Result<Client, AppError> {
    let mut builder = Client::builder()
        .timeout(TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .https_only(true)
        .user_agent(concat!("strata-backend/", env!("CARGO_PKG_VERSION")))
        .danger_accept_invalid_certs(!cfg.verify_tls);

    if !cfg.ca_cert_pem.trim().is_empty() {
        // PEM bundles may carry multiple certs; reqwest needs each
        // installed individually.
        for pem in split_pem_bundle(&cfg.ca_cert_pem) {
            let cert = Certificate::from_pem(pem.as_bytes()).map_err(|e| {
                AppError::Validation(format!("invalid Safeguard CA certificate PEM: {e}"))
            })?;
            builder = builder.add_root_certificate(cert);
        }
    }

    if let Some(id) = identity {
        builder = builder.identity(id);
    }

    builder
        .build()
        .map_err(|e| AppError::Internal(format!("reqwest builder: {e}")))
}

/// Split a PEM bundle into its constituent `-----BEGIN ... -----END ...`
/// blocks. Used because `reqwest::Certificate::from_pem` consumes one
/// cert at a time.
fn split_pem_bundle(bundle: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_cert = false;
    for line in bundle.lines() {
        if line.starts_with("-----BEGIN") {
            in_cert = true;
            current.clear();
        }
        if in_cert {
            current.push_str(line);
            current.push('\n');
        }
        if line.starts_with("-----END") && in_cert {
            in_cert = false;
            out.push(std::mem::take(&mut current));
        }
    }
    out
}

/// Build a client-cert `Identity` from PEM cert + PEM key. Returns
/// `None` when either field is empty (A2A not configured).
pub fn a2a_identity(secrets: &ResolvedSecrets) -> Result<Option<Identity>, AppError> {
    let cert = match secrets.a2a_client_cert_pem.as_deref() {
        Some(s) if !s.trim().is_empty() => s,
        _ => return Ok(None),
    };
    let key = match secrets.a2a_client_key_pem.as_deref() {
        Some(s) if !s.trim().is_empty() => s,
        _ => return Ok(None),
    };
    // reqwest's `Identity::from_pem` wants cert + key concatenated.
    let mut combined = String::with_capacity(cert.len() + key.len() + 1);
    combined.push_str(cert.trim());
    combined.push('\n');
    combined.push_str(key.trim());
    let id = Identity::from_pem(combined.as_bytes())
        .map_err(|e| AppError::Validation(format!("invalid A2A client cert / key PEM: {e}")))?;
    Ok(Some(id))
}

/// Compose the base URL for the appliance.
pub fn base_url(cfg: &SafeguardConfig) -> String {
    if cfg.appliance_port == 443 {
        format!("https://{}", cfg.appliance_fqdn)
    } else {
        format!("https://{}:{}", cfg.appliance_fqdn, cfg.appliance_port)
    }
}

/// `GET /service/core/v4/Me` — Safeguard's "who am I" endpoint. Used
/// to validate the bearer token returned by [`a2a_login`]. Returns the
/// user's display name when successful.
#[derive(Debug, Deserialize)]
pub struct MeResponse {
    #[serde(default, rename = "Name")]
    pub name: Option<String>,
    #[serde(default, rename = "DisplayName")]
    pub display_name: Option<String>,
}

pub async fn probe_me(client: &Client, base: &str, bearer: &str) -> Result<MeResponse, AppError> {
    let url = format!("{base}/service/core/v4/Me");
    let resp = client
        .get(&url)
        .bearer_auth(bearer)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("safeguard /Me: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Internal(format!(
            "Safeguard /Me returned HTTP {}",
            resp.status()
        )));
    }
    resp.json::<MeResponse>()
        .await
        .map_err(|e| AppError::Internal(format!("safeguard /Me decode: {e}")))
}

/// A2A token exchange.
///
/// Safeguard's A2A login requires the client cert + key (already
/// baked into `client` as the TLS identity) plus the API key in the
/// `Authorization: A2A …` header. The response carries a UserToken
/// that we use as the bearer for subsequent calls.
#[derive(Debug, Deserialize)]
struct A2aTokenResponse {
    #[serde(rename = "UserToken")]
    user_token: String,
}

pub async fn a2a_login(client: &Client, base: &str, api_key: &str) -> Result<String, AppError> {
    let url = format!("{base}/service/core/v4/Token/LoginResponse");
    let resp = client
        .post(&url)
        .header("Authorization", format!("A2A {api_key}"))
        .json(&serde_json::json!({ "StsAccessToken": "" }))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("safeguard A2A login: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Internal(format!(
            "Safeguard A2A login returned HTTP {}",
            resp.status()
        )));
    }
    let tok: A2aTokenResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("safeguard A2A login decode: {e}")))?;
    Ok(tok.user_token)
}

// ── Access Requests ────────────────────────────────────────────────────
//
// OneIdentity Safeguard's password-checkout workflow is a 3-step REST
// dance against `/service/core/v4/AccessRequests`:
//   1. POST a new request — returns an `Id` (string in v4).
//   2. POST `/{id}/CheckoutPassword` — body is empty; the response
//      is a raw JSON string carrying the plaintext password.
//   3. POST `/{id}/CheckIn` — empty body, releases the credential and
//      writes the audit row on the appliance side.
//
// Step 1 + 2 are commonly idempotent for the same (account, asset,
// reason) tuple within the duration window; if step 1 returns 409
// the appliance is telling us a pending request already exists for
// this user — we surface that as a clean validation error rather
// than silently checking a sibling out.

/// Parameters for creating a new access request.
pub struct CreateAccessRequestParams<'a> {
    /// Safeguard account identifier. May be either a numeric Id
    /// (sent as `AccountId`) or a name (sent as `AccountName`) —
    /// matches the dual form accepted by `New-SafeguardAccessRequest`.
    pub account_id: &'a str,
    /// Safeguard asset identifier. Same numeric-or-name handling as
    /// `account_id`. The Capita PS1 helper uses `-AccountId <int>
    /// -AssetName <fqdn>`, so the common case is asset-as-name.
    pub asset_id: &'a str,
    /// Hours requested. Clamped 1..=12 by the config DAO.
    pub hours: u32,
    /// Operator-visible reason text (template-expanded upstream).
    pub reason: &'a str,
}

#[derive(Debug, Deserialize)]
struct AccessRequestCreatedResponse {
    #[serde(rename = "Id")]
    id: serde_json::Value,
    #[serde(rename = "AccountName", default)]
    account_name: Option<String>,
    #[serde(rename = "AccountDomainName", default)]
    account_domain_name: Option<String>,
}

/// Returned from `create_access_request`. The account fields let the
/// caller construct an RDP/SSH username without an extra round-trip.
pub struct CreatedAccessRequest {
    pub request_id: String,
    /// Safeguard `Account.Name` (the sAMAccountName for AD-managed
    /// accounts, or the local username for local accounts).
    pub account_name: Option<String>,
    /// Safeguard `Account.DomainName` — empty for local accounts.
    /// Snapshotted for future DOMAIN\\user RDP synthesis; currently
    /// surfaced but not yet consumed.
    #[allow(dead_code)]
    pub account_domain_name: Option<String>,
}

/// Open a new password access request. Returns the request id plus
/// the account name/domain fields the appliance echoes back, so the
/// tunnel handler can synthesise `DOMAIN\user` for RDP without a
/// second `/Accounts/{id}` GET.
pub async fn create_access_request(
    client: &Client,
    base: &str,
    bearer: &str,
    params: &CreateAccessRequestParams<'_>,
) -> Result<CreatedAccessRequest, AppError> {
    let url = format!("{base}/service/core/v4/AccessRequests");

    // Numeric → `*Id` (Int32), non-numeric → `*Name` (string). Sending
    // both forms confuses Safeguard ("entity.AssetId must be Int32"),
    // so we pick exactly one per field.
    let mut body = serde_json::Map::new();
    match params.account_id.trim().parse::<i64>() {
        Ok(n) => {
            body.insert("AccountId".into(), serde_json::json!(n));
        }
        Err(_) => {
            body.insert("AccountName".into(), serde_json::json!(params.account_id));
        }
    }
    match params.asset_id.trim().parse::<i64>() {
        Ok(n) => {
            body.insert("AssetId".into(), serde_json::json!(n));
        }
        Err(_) => {
            body.insert("AssetName".into(), serde_json::json!(params.asset_id));
        }
    }
    body.insert("AccessRequestType".into(), serde_json::json!("Password"));
    body.insert(
        "RequestedDurationHours".into(),
        serde_json::json!(params.hours),
    );
    body.insert("ReasonComment".into(), serde_json::json!(params.reason));

    let resp = client
        .post(&url)
        .bearer_auth(bearer)
        .json(&serde_json::Value::Object(body))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("safeguard create AR: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "Safeguard AccessRequests POST returned HTTP {status}: {}",
            text.chars().take(500).collect::<String>()
        )));
    }
    let created: AccessRequestCreatedResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("safeguard AR decode: {e}")))?;
    let request_id = match created.id {
        serde_json::Value::String(s) => s,
        serde_json::Value::Number(n) => n.to_string(),
        other => other.to_string(),
    };
    Ok(CreatedAccessRequest {
        request_id,
        account_name: created.account_name.filter(|s| !s.is_empty()),
        account_domain_name: created.account_domain_name.filter(|s| !s.is_empty()),
    })
}

/// POST `/AccessRequests/{id}/CheckoutPassword`. Returns the
/// plaintext password as Safeguard delivers it (raw JSON string).
pub async fn checkout_password(
    client: &Client,
    base: &str,
    bearer: &str,
    request_id: &str,
) -> Result<String, AppError> {
    let url = format!("{base}/service/core/v4/AccessRequests/{request_id}/CheckoutPassword");
    let resp = client
        .post(&url)
        .bearer_auth(bearer)
        .header("Content-Length", "0")
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("safeguard checkout: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "Safeguard CheckoutPassword returned HTTP {status}: {}",
            text.chars().take(500).collect::<String>()
        )));
    }
    // The response body is a JSON-encoded string: `"the-password"`.
    let pw: String = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("safeguard CheckoutPassword decode: {e}")))?;
    Ok(pw)
}

/// GET `/AccessRequests/{id}` and return the appliance-reported
/// `State` string. Used by the password-cache validator to decide
/// whether a previously-issued request is still live (i.e. the user
/// hasn't already checked it back in via the Safeguard portal).
///
/// Returns `Ok(None)` when the appliance responds 404 — the request
/// has been purged, so the cache row should be evicted.
pub async fn get_access_request_state(
    client: &Client,
    base: &str,
    bearer: &str,
    request_id: &str,
) -> Result<Option<String>, AppError> {
    let url = format!("{base}/service/core/v4/AccessRequests/{request_id}");
    let resp = client
        .get(&url)
        .bearer_auth(bearer)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("safeguard get AR: {e}")))?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "Safeguard AccessRequests GET returned HTTP {status}: {}",
            text.chars().take(500).collect::<String>()
        )));
    }
    #[derive(serde::Deserialize)]
    struct AccessRequestState {
        #[serde(rename = "State", default)]
        state: Option<String>,
    }
    let parsed: AccessRequestState = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("safeguard AR state decode: {e}")))?;
    Ok(parsed.state)
}

/// GET `/Me/ActionableRequests` and return the caller's active
/// requests for the given account (matched on `AccountId`+`AssetId`
/// numeric ids, or `AccountName`+`AssetName` strings).
///
/// `Me/ActionableRequests` is the modern Safeguard endpoint that
/// returns the user's own requests under the `PersonalRequests`
/// bucket; older `Me/AccessRequests` 404s on current appliances.
///
/// Used by `jit_checkout` to release stale portal-side checkouts
/// before opening a new one — without this, Safeguard returns the
/// EXISTING request id with the old password and the user's
/// authentication fails because the account's actual password was
/// rotated when *we* thought we'd minted a fresh one.
///
/// Returns request IDs only; the caller calls `checkin` on each.
/// Returns `(request_id, state)` pairs so the caller can pick the
/// correct release verb (CheckIn for `PasswordCheckedOut`-style states,
/// Cancel for `RequestAvailable`/`PendingApproval`/etc.).
pub async fn list_my_active_requests_for(
    client: &Client,
    base: &str,
    bearer: &str,
    account_id: &str,
    asset_id: &str,
) -> Result<Vec<(String, Option<String>)>, AppError> {
    #[derive(serde::Deserialize)]
    struct Row {
        #[serde(rename = "Id", default)]
        id: serde_json::Value,
        #[serde(rename = "AccountId", default)]
        account_id: Option<i64>,
        #[serde(rename = "AccountName", default)]
        account_name: Option<String>,
        #[serde(rename = "AssetId", default)]
        asset_id: Option<i64>,
        #[serde(rename = "AssetName", default)]
        asset_name: Option<String>,
        #[serde(rename = "State", default)]
        state: Option<String>,
    }

    // `Me/Requests` returns ALL of the current user's access requests
    // regardless of whether they currently need user action. This is
    // critical: `Me/ActionableRequests` filters out requests whose
    // password has already been retrieved, so they would NOT be
    // released here and Safeguard would then reject our new
    // `POST /AccessRequests` with Code 90001 ("overlapping time frame").
    //
    // We fall back to `Me/ActionableRequests` (older `PersonalRequests`
    // wrapper) only if `Me/Requests` is not available on this
    // appliance version.
    let mut rows: Vec<Row> = Vec::new();
    let url = format!("{base}/service/core/v4/Me/Requests");
    let resp = client
        .get(&url)
        .bearer_auth(bearer)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("safeguard list Me/Requests: {e}")))?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        tracing::info!(
            "safeguard preflight: Me/Requests returned 404, falling back to Me/ActionableRequests"
        );
        // Older appliance — try the actionable wrapper instead.
        let url2 = format!("{base}/service/core/v4/Me/ActionableRequests");
        let resp2 = client
            .get(&url2)
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|e| {
                AppError::Internal(format!("safeguard list Me/ActionableRequests: {e}"))
            })?;
        let status2 = resp2.status();
        if status2 == reqwest::StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }
        if !status2.is_success() {
            let text = resp2.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!(
                "Safeguard Me/ActionableRequests returned HTTP {status2}: {}",
                text.chars().take(500).collect::<String>()
            )));
        }
        // Log raw body for debugging — appliance variants return different
        // wrapper shapes (PersonalRequests vs RequestorRequests vs a plain
        // array). We'll parse permissively below.
        let body = resp2.text().await.unwrap_or_default();
        tracing::info!(
            "safeguard preflight: Me/ActionableRequests raw body (truncated 1500): {}",
            body.chars().take(1500).collect::<String>()
        );
        // Try parsing as the standard wrapper first.
        // Safeguard 8.2.x uses singular bucket names ("Requester",
        // "Approver", "Admin", "Reviewer"); older 2.x/6.x docs use
        // suffixed names ("RequestorRequests", "PersonalRequests");
        // accept both so we work across appliance versions.
        #[derive(serde::Deserialize)]
        struct Wrapper {
            #[serde(rename = "Requester", default)]
            requester: Vec<Row>,
            #[serde(rename = "Approver", default)]
            approver: Vec<Row>,
            #[serde(rename = "Reviewer", default)]
            reviewer: Vec<Row>,
            #[serde(rename = "Admin", default)]
            admin: Vec<Row>,
            #[serde(rename = "PersonalRequests", default)]
            personal_requests: Vec<Row>,
            #[serde(rename = "RequestorRequests", default)]
            requestor_requests: Vec<Row>,
            #[serde(rename = "ApproverRequests", default)]
            approver_requests: Vec<Row>,
            #[serde(rename = "ReviewerRequests", default)]
            reviewer_requests: Vec<Row>,
        }
        if let Ok(parsed) = serde_json::from_str::<Wrapper>(&body) {
            rows.extend(parsed.requester);
            rows.extend(parsed.approver);
            rows.extend(parsed.reviewer);
            rows.extend(parsed.admin);
            rows.extend(parsed.personal_requests);
            rows.extend(parsed.requestor_requests);
            rows.extend(parsed.approver_requests);
            rows.extend(parsed.reviewer_requests);
        } else if let Ok(arr) = serde_json::from_str::<Vec<Row>>(&body) {
            rows = arr;
        } else {
            tracing::warn!(
                "safeguard preflight: could not decode Me/ActionableRequests body in any known shape"
            );
        }
    } else if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "Safeguard Me/Requests returned HTTP {status}: {}",
            text.chars().take(500).collect::<String>()
        )));
    } else {
        rows = resp
            .json::<Vec<Row>>()
            .await
            .map_err(|e| AppError::Internal(format!("safeguard Me/Requests decode: {e}")))?;
    }

    // Terminal states Safeguard uses for closed requests. Anything
    // not in this list we treat as "still live" and worth checking
    // back in before we open a new request for the same account.
    const TERMINAL: &[&str] = &[
        "Expired",
        "Denied",
        "Revoked",
        "Canceled",
        "Complete",
        "RequestDenied",
        "RequestRevoked",
        "RequestCanceled",
        "RequestComplete",
    ];

    let want_account_id = account_id.trim().parse::<i64>().ok();
    let want_account_name = if want_account_id.is_some() {
        None
    } else {
        Some(account_id.trim())
    };
    let want_asset_id = asset_id.trim().parse::<i64>().ok();
    let want_asset_name = if want_asset_id.is_some() {
        None
    } else {
        Some(asset_id.trim())
    };

    tracing::info!(
        "safeguard preflight: fetched {} request rows from appliance; looking for account={:?}/{:?} asset={:?}/{:?}",
        rows.len(),
        want_account_id,
        want_account_name,
        want_asset_id,
        want_asset_name,
    );

    let mut out = Vec::new();
    for r in rows {
        let rid_dbg = match &r.id {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) => n.to_string(),
            _ => String::new(),
        };
        tracing::info!(
            "safeguard preflight row: id={} state={:?} account_id={:?} account_name={:?} asset_id={:?} asset_name={:?}",
            rid_dbg,
            r.state,
            r.account_id,
            r.account_name,
            r.asset_id,
            r.asset_name,
        );
        if let Some(s) = r.state.as_deref() {
            if TERMINAL.contains(&s) {
                continue;
            }
        }
        let account_matches = match (want_account_id, want_account_name) {
            (Some(id), _) => r.account_id == Some(id),
            (None, Some(name)) => r.account_name.as_deref() == Some(name),
            _ => false,
        };
        let asset_matches = match (want_asset_id, want_asset_name) {
            (Some(id), _) => r.asset_id == Some(id),
            (None, Some(name)) => r.asset_name.as_deref() == Some(name),
            _ => false,
        };
        if !account_matches || !asset_matches {
            continue;
        }
        let rid = match r.id {
            serde_json::Value::String(s) => s,
            serde_json::Value::Number(n) => n.to_string(),
            _ => continue,
        };
        if !rid.is_empty() {
            out.push((rid, r.state));
        }
    }
    Ok(out)
}

/// POST `/AccessRequests/{id}/CheckIn`. Releases the credential and
/// triggers Safeguard-side audit/rotation per policy. Use this for
/// requests whose password has already been checked out
/// (state `PasswordCheckedOut` and similar).
pub async fn checkin(
    client: &Client,
    base: &str,
    bearer: &str,
    request_id: &str,
) -> Result<(), AppError> {
    let url = format!("{base}/service/core/v4/AccessRequests/{request_id}/CheckIn");
    let resp = client
        .post(&url)
        .bearer_auth(bearer)
        .header("Content-Type", "application/json")
        .body("\"strata preflight\"")
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("safeguard checkin: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "Safeguard CheckIn returned HTTP {status}: {}",
            text.chars().take(500).collect::<String>()
        )));
    }
    Ok(())
}

/// POST `/AccessRequests/{id}/Cancel`. Cancels a request whose
/// password has NOT been checked out yet (states `RequestAvailable`,
/// `PendingApproval`, `PendingReview`, etc.). CheckIn returns Code
/// 90114 for these — Cancel is the correct release verb.
pub async fn cancel(
    client: &Client,
    base: &str,
    bearer: &str,
    request_id: &str,
) -> Result<(), AppError> {
    let url = format!("{base}/service/core/v4/AccessRequests/{request_id}/Cancel");
    let resp = client
        .post(&url)
        .bearer_auth(bearer)
        .header("Content-Type", "application/json")
        .body("\"strata preflight\"")
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("safeguard cancel: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "Safeguard Cancel returned HTTP {status}: {}",
            text.chars().take(500).collect::<String>()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::safeguard::config::AuthMode;

    fn cfg_with_fqdn(fqdn: &str, port: i32) -> SafeguardConfig {
        SafeguardConfig {
            appliance_fqdn: fqdn.into(),
            appliance_port: port,
            auth_mode: AuthMode::A2a,
            ..Default::default()
        }
    }

    #[test]
    fn base_url_default_port_omits_443() {
        let c = cfg_with_fqdn("sg.example.com", 443);
        assert_eq!(base_url(&c), "https://sg.example.com");
    }

    #[test]
    fn base_url_custom_port_appended() {
        let c = cfg_with_fqdn("sg.example.com", 8443);
        assert_eq!(base_url(&c), "https://sg.example.com:8443");
    }

    #[test]
    fn split_pem_bundle_isolates_blocks() {
        let pem = "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n\
                   -----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----\n";
        let parts = split_pem_bundle(pem);
        assert_eq!(parts.len(), 2);
        assert!(parts[0].contains("AAA"));
        assert!(parts[1].contains("BBB"));
    }

    #[test]
    fn split_pem_bundle_handles_empty() {
        assert!(split_pem_bundle("").is_empty());
        assert!(split_pem_bundle("no markers here").is_empty());
    }

    #[test]
    fn a2a_identity_none_when_blank() {
        let r = ResolvedSecrets {
            a2a_api_key: None,
            a2a_client_cert_pem: Some(String::new()),
            a2a_client_key_pem: Some(String::new()),
        };
        assert!(a2a_identity(&r).unwrap().is_none());
    }

    #[test]
    fn build_client_accepts_invalid_pem_when_no_ca() {
        // No CA bundle → no PEM parsing happens.
        let cfg = SafeguardConfig {
            verify_tls: false,
            ..Default::default()
        };
        assert!(build_client(&cfg, None).is_ok());
    }

    #[test]
    fn build_client_rejects_bad_pem() {
        let cfg = SafeguardConfig {
            ca_cert_pem: "-----BEGIN CERTIFICATE-----\nnotvalid\n-----END CERTIFICATE-----\n"
                .into(),
            ..Default::default()
        };
        assert!(build_client(&cfg, None).is_err());
    }
}
