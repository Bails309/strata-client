//! Admin endpoints for the Safeguard JIT integration.
//!
//! Routes (all behind `require_admin` + `require_auth` + `require_csrf`):
//!   * `GET  /api/admin/safeguard/config`  → masked config snapshot.
//!   * `PUT  /api/admin/safeguard/config`  → upsert config (keep-on-mask
//!                                            secrets, see `services::safeguard::config`).
//!   * `POST /api/admin/safeguard/test`    → live connectivity probe
//!                                            using the *submitted* draft
//!                                            (NOT the persisted row), so
//!                                            admins can verify before
//!                                            saving.

use axum::extract::State;
use axum::Extension;
use axum::Json;

use crate::error::AppError;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::middleware::AuthUser;
use crate::services::safeguard::{
    self,
    client::{a2a_identity, a2a_login, base_url, build_client, probe_me},
    config::{AuthMode, ResolvedSecrets, SafeguardConfig, SECRET_MASK},
    TestConnectionOutcome, TestStep,
};

async fn require_running(state: &SharedState) -> Result<crate::db::Database, AppError> {
    let s = state.read().await;
    if s.phase != BootPhase::Running {
        return Err(AppError::SetupRequired);
    }
    s.db.clone().ok_or(AppError::SetupRequired)
}

/// `GET /api/admin/safeguard/config`
pub async fn get_config(
    State(state): State<SharedState>,
) -> Result<Json<SafeguardConfig>, AppError> {
    let db = require_running(&state).await?;
    let cfg = safeguard::config::load(&db.pool).await?;
    Ok(Json(cfg))
}

/// `PUT /api/admin/safeguard/config`
pub async fn put_config(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<SafeguardConfig>,
) -> Result<Json<SafeguardConfig>, AppError> {
    let (db, vault) = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Err(AppError::SetupRequired);
        }
        let db = s.db.clone().ok_or(AppError::SetupRequired)?;
        let vault = s.config.as_ref().and_then(|c| c.vault.clone());
        (db, vault)
    };

    safeguard::config::save(&db.pool, vault.as_ref(), Some(user.id), &body).await?;
    let updated = safeguard::config::load(&db.pool).await?;
    Ok(Json(updated))
}

/// `POST /api/admin/safeguard/test`
///
/// Body shape == [`SafeguardConfig`]. Sealed fields equal to
/// [`SECRET_MASK`] are resolved against the persisted row so an admin
/// can hit "Test" without re-typing the API key.
pub async fn test_connection(
    State(state): State<SharedState>,
    Json(draft): Json<SafeguardConfig>,
) -> Result<Json<TestConnectionOutcome>, AppError> {
    let (db, vault) = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Err(AppError::SetupRequired);
        }
        let db = s.db.clone().ok_or(AppError::SetupRequired)?;
        let vault = s.config.as_ref().and_then(|c| c.vault.clone());
        (db, vault)
    };

    if draft.appliance_fqdn.trim().is_empty() {
        return Ok(Json(TestConnectionOutcome::fail(
            "Appliance FQDN is required.",
            vec![],
        )));
    }

    // Resolve any masked secrets from the saved row.
    let saved_secrets: Option<ResolvedSecrets> = if let Some(ref v) = vault {
        safeguard::config::load_secrets(&db.pool, v).await.ok()
    } else {
        None
    };
    let mut secrets = ResolvedSecrets {
        a2a_api_key: resolve_secret(&draft.a2a_api_key, saved_secrets.as_ref().and_then(|s| s.a2a_api_key.clone())),
        a2a_client_cert_pem: resolve_secret(&draft.a2a_client_cert_pem, saved_secrets.as_ref().and_then(|s| s.a2a_client_cert_pem.clone())),
        a2a_client_key_pem: resolve_secret(&draft.a2a_client_key_pem, saved_secrets.as_ref().and_then(|s| s.a2a_client_key_pem.clone())),
    };
    // Trim trailing whitespace defensively so pasted PEM blocks don't
    // confuse reqwest's identity parser.
    if let Some(ref mut s) = secrets.a2a_client_cert_pem {
        *s = s.trim().to_string();
    }
    if let Some(ref mut s) = secrets.a2a_client_key_pem {
        *s = s.trim().to_string();
    }

    let mut steps: Vec<TestStep> = Vec::new();

    // Step 1 — build the reqwest client (validates CA bundle).
    let identity = match a2a_identity(&secrets) {
        Ok(id) => id,
        Err(e) => {
            steps.push(TestStep {
                name: "TLS identity",
                ok: false,
                detail: Some(e.to_string()),
            });
            return Ok(Json(TestConnectionOutcome::fail(
                "Could not load A2A client certificate.",
                steps,
            )));
        }
    };
    let client = match build_client(&draft, identity) {
        Ok(c) => c,
        Err(e) => {
            steps.push(TestStep {
                name: "HTTP client",
                ok: false,
                detail: Some(e.to_string()),
            });
            return Ok(Json(TestConnectionOutcome::fail(
                "Could not initialise HTTP client.",
                steps,
            )));
        }
    };
    steps.push(TestStep {
        name: "HTTP client",
        ok: true,
        detail: None,
    });

    let base = base_url(&draft);

    // Step 2 — reachability via /Me without auth. We expect 401 here
    // (not 5xx, not a connect error), proving the appliance answers.
    {
        let url = format!("{base}/service/core/v4/Me");
        match client.get(&url).send().await {
            Ok(r) => {
                let status = r.status();
                steps.push(TestStep {
                    name: "Reachability",
                    ok: true,
                    detail: Some(format!("HTTP {status} from /Me (unauth)")),
                });
            }
            Err(e) => {
                steps.push(TestStep {
                    name: "Reachability",
                    ok: false,
                    detail: Some(format!("{e}")),
                });
                return Ok(Json(TestConnectionOutcome::fail(
                    "Could not reach the Safeguard appliance.",
                    steps,
                )));
            }
        }
    }

    // Step 3 — A2A auth (only when configured + auth_mode allows it).
    let try_a2a = matches!(draft.auth_mode, AuthMode::A2a | AuthMode::Hybrid)
        && secrets.a2a_api_key.is_some()
        && secrets.a2a_client_cert_pem.is_some()
        && secrets.a2a_client_key_pem.is_some();
    if !try_a2a {
        return Ok(Json(TestConnectionOutcome::success(
            "Appliance reachable. (A2A credentials not configured — only TLS reachability was tested.)",
            steps,
        )));
    }

    let api_key = secrets.a2a_api_key.as_deref().unwrap_or_default();
    let bearer = match a2a_login(&client, &base, api_key).await {
        Ok(t) => t,
        Err(e) => {
            steps.push(TestStep {
                name: "A2A login",
                ok: false,
                detail: Some(e.to_string()),
            });
            return Ok(Json(TestConnectionOutcome::fail(
                "A2A login was rejected by the appliance.",
                steps,
            )));
        }
    };
    steps.push(TestStep {
        name: "A2A login",
        ok: true,
        detail: None,
    });

    match probe_me(&client, &base, &bearer).await {
        Ok(me) => {
            steps.push(TestStep {
                name: "Identity probe",
                ok: true,
                detail: me.display_name.or(me.name),
            });
            Ok(Json(TestConnectionOutcome::success(
                "Safeguard A2A authentication succeeded.",
                steps,
            )))
        }
        Err(e) => {
            steps.push(TestStep {
                name: "Identity probe",
                ok: false,
                detail: Some(e.to_string()),
            });
            Ok(Json(TestConnectionOutcome::fail(
                "Login succeeded but /Me failed.",
                steps,
            )))
        }
    }
}

/// Resolve a secret value submitted by the admin: mask → use saved,
/// empty → genuinely unset, otherwise → use the submitted value.
fn resolve_secret(submitted: &str, saved: Option<String>) -> Option<String> {
    if submitted == SECRET_MASK {
        saved
    } else if submitted.is_empty() {
        None
    } else {
        Some(submitted.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_secret_keeps_saved_on_mask() {
        assert_eq!(
            resolve_secret(SECRET_MASK, Some("kept".into())),
            Some("kept".into())
        );
    }

    #[test]
    fn resolve_secret_clears_on_empty() {
        assert_eq!(resolve_secret("", Some("kept".into())), None);
    }

    #[test]
    fn resolve_secret_overrides_on_value() {
        assert_eq!(
            resolve_secret("new", Some("old".into())),
            Some("new".into())
        );
    }
}
