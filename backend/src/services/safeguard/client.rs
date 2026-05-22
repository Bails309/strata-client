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
