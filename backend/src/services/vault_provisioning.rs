//! Vault lifecycle management for the bundled Vault container.
//!
//! Handles first-time initialization (operator init), unseal,
//! enabling the Transit secrets engine, and creating the encryption key.
//!
//! The backend never keeps a root token (SEC-25). Root is used only while
//! provisioning — from `operator init`, from a token stored by an older
//! release, or regenerated from the unseal key when the runtime token has
//! been lost — to issue a Transit-only runtime token, and is then revoked.
//! The unseal key stays with the backend so restarts remain automatic.

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::services::http_client::default_client;

/// Policy attached to the runtime token. Bumped when it gains a path, so
/// tokens issued under an older one are replaced.
pub const RUNTIME_POLICY: &str = "strata-transit-v2";

/// Ed25519 Transit key that signs audit checkpoints (SEC-17).
pub const AUDIT_SIGNING_KEY: &str = "strata-audit";

/// The runtime token lapses unless renewed within this period.
pub const RUNTIME_TOKEN_PERIOD: &str = "72h";

/// Credentials the backend keeps for the bundled Vault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalCredentials {
    /// Transit-only runtime token.
    pub token: String,
    pub unseal_key: String,
}

/// Result of `vault operator init` with a single unseal key.
#[derive(Debug, Clone)]
pub struct VaultInitResult {
    pub root_token: String,
    pub unseal_key: String,
}

#[derive(Serialize)]
struct InitRequest {
    secret_shares: u32,
    secret_threshold: u32,
}

#[derive(Deserialize)]
struct InitResponse {
    keys: Vec<String>,
    root_token: String,
}

#[derive(Serialize)]
struct UnsealRequest {
    key: String,
}

#[derive(Deserialize)]
struct UnsealResponse {
    sealed: bool,
}

#[derive(Deserialize)]
struct HealthResponse {
    initialized: bool,
    sealed: bool,
}

#[derive(Deserialize)]
struct MountsResponse {
    data: std::collections::HashMap<String, serde_json::Value>,
}

/// Check if the bundled Vault is reachable and return its init/seal status.
pub async fn health(address: &str) -> Result<(bool, bool), AppError> {
    let url = format!(
        "{}/v1/sys/health?standbyok=true&sealedcode=200&uninitcode=200",
        address.trim_end_matches('/')
    );
    let resp: HealthResponse = default_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::Vault(format!("Vault unreachable: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Vault(format!("Vault health parse: {e}")))?;

    Ok((resp.initialized, resp.sealed))
}

/// Initialize a fresh Vault instance with 1 unseal key / threshold 1.
pub async fn init(address: &str) -> Result<VaultInitResult, AppError> {
    let url = format!("{}/v1/sys/init", address.trim_end_matches('/'));
    let client = default_client();

    let resp = client
        .put(&url)
        .json(&InitRequest {
            secret_shares: 1,
            secret_threshold: 1,
        })
        .send()
        .await
        .map_err(|e| AppError::Vault(format!("Vault init request failed: {e}")))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Vault(format!("Vault init failed: {body}")));
    }

    let data: InitResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Vault(format!("Vault init response parse: {e}")))?;

    Ok(VaultInitResult {
        root_token: data.root_token,
        unseal_key: data.keys.into_iter().next().unwrap_or_default(),
    })
}

/// Unseal the Vault with a single unseal key.
pub async fn unseal(address: &str, key: &str) -> Result<(), AppError> {
    let url = format!("{}/v1/sys/unseal", address.trim_end_matches('/'));

    let resp = default_client()
        .put(&url)
        .json(&UnsealRequest {
            key: key.to_string(),
        })
        .send()
        .await
        .map_err(|e| AppError::Vault(format!("Vault unseal request failed: {e}")))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Vault(format!("Vault unseal failed: {body}")));
    }

    let data: UnsealResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Vault(format!("Vault unseal parse: {e}")))?;

    if data.sealed {
        return Err(AppError::Vault(
            "Vault is still sealed after unseal attempt".into(),
        ));
    }

    Ok(())
}

/// Enable the Transit secrets engine (idempotent — ignores "already mounted" errors).
pub async fn enable_transit(address: &str, token: &str) -> Result<(), AppError> {
    let client = default_client();

    // Check if transit is already mounted
    let mounts_url = format!("{}/v1/sys/mounts", address.trim_end_matches('/'));
    let mounts_resp = client
        .get(&mounts_url)
        .header("X-Vault-Token", token)
        .send()
        .await
        .map_err(|e| AppError::Vault(format!("Vault mounts request failed: {e}")))?;

    if mounts_resp.status().is_success() {
        if let Ok(mounts) = mounts_resp.json::<MountsResponse>().await {
            if mounts.data.contains_key("transit/") {
                tracing::info!("Transit engine already enabled");
                return Ok(());
            }
        }
    }

    let url = format!("{}/v1/sys/mounts/transit", address.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .header("X-Vault-Token", token)
        .json(&serde_json::json!({ "type": "transit" }))
        .send()
        .await
        .map_err(|e| AppError::Vault(format!("Transit enable request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        // 400 means already mounted
        if status.as_u16() == 400 && body.contains("already in use") {
            return Ok(());
        }
        return Err(AppError::Vault(format!(
            "Transit enable failed ({status}): {body}"
        )));
    }

    tracing::info!("Transit secrets engine enabled");
    Ok(())
}

/// Create a Transit encryption key (idempotent — does not error if key exists).
pub async fn create_transit_key(
    address: &str,
    token: &str,
    key_name: &str,
) -> Result<(), AppError> {
    let url = format!(
        "{}/v1/transit/keys/{}",
        address.trim_end_matches('/'),
        key_name
    );

    let resp = default_client()
        .post(&url)
        .header("X-Vault-Token", token)
        .send()
        .await
        .map_err(|e| AppError::Vault(format!("Transit key create request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        // 204 or existing key is fine
        if status.as_u16() != 204 && !body.contains("already exists") {
            return Err(AppError::Vault(format!(
                "Transit key create failed ({status}): {body}"
            )));
        }
    }

    tracing::info!("Transit key '{}' ready", key_name);
    Ok(())
}

/// Bring the bundled Vault to a usable state and return the credentials
/// the backend should run with:
/// 1. Initialise it if needed, and unseal it if sealed.
/// 2. If there is no usable non-root token — first boot, a root token
///    stored by an older release, or a runtime token that has lapsed —
///    take root (from init, the stored token, or regenerated with the
///    unseal key), enable Transit, create the key, issue a Transit-only
///    runtime token, hand it to `persist`, and revoke root.
///
/// Root is revoked only after `persist` succeeds, so a failure to save
/// the new token leaves a stored legacy root token usable.
pub async fn provision(
    address: &str,
    transit_key: &str,
    existing_unseal_key: Option<&str>,
    existing_token: Option<&str>,
    persist: impl FnOnce(&LocalCredentials) -> anyhow::Result<()>,
) -> Result<LocalCredentials, AppError> {
    check_key_name(transit_key)?;
    let (initialized, sealed) = health(address).await?;

    if !initialized {
        tracing::info!("Vault is not initialized, running operator init...");
        let result = init(address).await?;
        tracing::info!("Vault initialized successfully");
        unseal(address, &result.unseal_key).await?;
        tracing::info!("Vault unsealed");
        return with_root(
            address,
            transit_key,
            &result.root_token,
            result.unseal_key.clone(),
            persist,
        )
        .await;
    }

    let unseal_key = existing_unseal_key
        .ok_or_else(|| AppError::Vault("Vault is initialized but no unseal key is stored".into()))?
        .to_string();
    if sealed {
        tracing::info!("Unsealing Vault...");
        unseal(address, &unseal_key).await?;
        tracing::info!("Vault unsealed");
    }

    let lookup = match existing_token {
        Some(token) if !token.is_empty() => lookup_self(address, token).await?,
        _ => None,
    };
    match (lookup, existing_token) {
        (Some(policies), Some(token)) if policies.iter().any(|p| p == "root") => {
            tracing::warn!(
                "Stored Vault token is a root token; replacing it with a Transit-only token"
            );
            with_root(address, transit_key, token, unseal_key, persist).await
        }
        (Some(policies), Some(token)) if policies.iter().any(|p| p == RUNTIME_POLICY) => {
            Ok(LocalCredentials {
                token: token.to_string(),
                unseal_key,
            })
        }
        (lookup, token) => {
            tracing::warn!(
                "No usable Vault runtime token; regenerating root from the unseal key to issue one"
            );
            let root = generate_root(address, &unseal_key).await?;
            // A token from an older policy still works until it lapses.
            if let (Some(_), Some(old)) = (lookup, token) {
                if let Err(e) = revoke_token(address, &root, old).await {
                    tracing::warn!("Could not revoke the previous Vault runtime token: {e}");
                }
            }
            with_root(address, transit_key, &root, unseal_key, persist).await
        }
    }
}

/// Use `root` to finish provisioning, issue the runtime token, persist it,
/// then revoke `root`.
async fn with_root(
    address: &str,
    transit_key: &str,
    root: &str,
    unseal_key: String,
    persist: impl FnOnce(&LocalCredentials) -> anyhow::Result<()>,
) -> Result<LocalCredentials, AppError> {
    enable_transit(address, root).await?;
    create_transit_key(address, root, transit_key).await?;
    create_signing_key(address, root).await?;
    put_runtime_policy(address, root, transit_key).await?;
    let token = create_runtime_token(address, root).await?;
    check_runtime_token(address, &token, transit_key).await?;

    let creds = LocalCredentials { token, unseal_key };
    persist(&creds)
        .map_err(|e| AppError::Vault(format!("Could not save the Vault runtime token: {e}")))?;

    if let Err(e) = revoke_self(address, root).await {
        tracing::error!("Could not revoke the Vault root token: {e}");
    } else {
        tracing::info!("Vault root token revoked; running with a Transit-only token");
    }
    Ok(creds)
}

/// Transit key names go into the policy text, so keep them to a safe set.
fn check_key_name(key: &str) -> Result<(), AppError> {
    let ok = !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(AppError::Config(
            "Vault transit key names may only contain letters, digits, '-' and '_'".into(),
        ))
    }
}

fn runtime_policy(transit_key: &str) -> String {
    format!(
        "path \"transit/encrypt/{transit_key}\" {{ capabilities = [\"update\"] }}\n\
         path \"transit/decrypt/{transit_key}\" {{ capabilities = [\"update\"] }}\n\
         path \"transit/sign/{AUDIT_SIGNING_KEY}\" {{ capabilities = [\"update\"] }}\n\
         path \"transit/verify/{AUDIT_SIGNING_KEY}\" {{ capabilities = [\"update\"] }}\n\
         path \"auth/token/renew-self\" {{ capabilities = [\"update\"] }}\n\
         path \"auth/token/lookup-self\" {{ capabilities = [\"read\"] }}\n"
    )
}

/// The non-exportable Ed25519 key for audit checkpoints (idempotent).
async fn create_signing_key(address: &str, root: &str) -> Result<(), AppError> {
    let resp = default_client()
        .post(url(address, &format!("transit/keys/{AUDIT_SIGNING_KEY}")))
        .header("X-Vault-Token", root)
        .json(&serde_json::json!({ "type": "ed25519" }))
        .send()
        .await
        .map_err(|e| AppError::Vault(format!("Vault signing key request failed: {e}")))?;
    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }
    let body = resp.text().await.unwrap_or_default();
    if body.contains("already exists") {
        return Ok(());
    }
    Err(AppError::Vault(format!(
        "Vault signing key create failed ({status}): {body}"
    )))
}

async fn revoke_token(address: &str, root: &str, token: &str) -> Result<(), AppError> {
    let req = default_client()
        .post(url(address, "auth/token/revoke"))
        .header("X-Vault-Token", root)
        .json(&serde_json::json!({ "token": token }));
    vault_call(req, "Vault token revoke").await.map(drop)
}

fn url(address: &str, path: &str) -> String {
    format!("{}/v1/{path}", address.trim_end_matches('/'))
}

async fn vault_call(
    req: reqwest::RequestBuilder,
    what: &str,
) -> Result<reqwest::Response, AppError> {
    let resp = req
        .send()
        .await
        .map_err(|e| AppError::Vault(format!("{what} request failed: {e}")))?;
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    Err(AppError::Vault(format!("{what} failed ({status}): {body}")))
}

async fn put_runtime_policy(address: &str, root: &str, transit_key: &str) -> Result<(), AppError> {
    let req = default_client()
        .put(url(address, &format!("sys/policies/acl/{RUNTIME_POLICY}")))
        .header("X-Vault-Token", root)
        .json(&serde_json::json!({ "policy": runtime_policy(transit_key) }));
    vault_call(req, "Vault policy write").await.map(drop)
}

/// An orphan, so revoking the root that created it leaves it valid.
async fn create_runtime_token(address: &str, root: &str) -> Result<String, AppError> {
    #[derive(Deserialize)]
    struct Auth {
        client_token: String,
    }
    #[derive(Deserialize)]
    struct Created {
        auth: Auth,
    }
    let req = default_client()
        .post(url(address, "auth/token/create-orphan"))
        .header("X-Vault-Token", root)
        .json(&serde_json::json!({
            "policies": [RUNTIME_POLICY],
            "no_default_policy": true,
            "period": RUNTIME_TOKEN_PERIOD,
            "renewable": true,
            "display_name": "strata-backend",
        }));
    let created: Created = vault_call(req, "Vault token create")
        .await?
        .json()
        .await
        .map_err(|e| AppError::Vault(format!("Vault token create parse: {e}")))?;
    Ok(created.auth.client_token)
}

/// Prove the runtime token can use the key before anything depends on it.
async fn check_runtime_token(
    address: &str,
    token: &str,
    transit_key: &str,
) -> Result<(), AppError> {
    let req = default_client()
        .post(url(address, &format!("transit/encrypt/{transit_key}")))
        .header("X-Vault-Token", token)
        .json(&serde_json::json!({
            "plaintext": base64::engine::general_purpose::STANDARD.encode("strata-probe"),
        }));
    vault_call(req, "Vault runtime token check").await.map(drop)
}

/// The token's policies, or `None` if Vault no longer accepts it.
async fn lookup_self(address: &str, token: &str) -> Result<Option<Vec<String>>, AppError> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(default)]
        policies: Vec<String>,
    }
    #[derive(Deserialize)]
    struct Lookup {
        data: Data,
    }
    let resp = default_client()
        .get(url(address, "auth/token/lookup-self"))
        .header("X-Vault-Token", token)
        .send()
        .await
        .map_err(|e| AppError::Vault(format!("Vault token lookup request failed: {e}")))?;
    if resp.status() == reqwest::StatusCode::FORBIDDEN {
        return Ok(None);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Vault(format!(
            "Vault token lookup failed ({status}): {body}"
        )));
    }
    let lookup: Lookup = resp
        .json()
        .await
        .map_err(|e| AppError::Vault(format!("Vault token lookup parse: {e}")))?;
    Ok(Some(lookup.data.policies))
}

async fn revoke_self(address: &str, token: &str) -> Result<(), AppError> {
    let req = default_client()
        .post(url(address, "auth/token/revoke-self"))
        .header("X-Vault-Token", token);
    vault_call(req, "Vault token revoke").await.map(drop)
}

/// Extend the runtime token's lease by another period.
pub async fn renew_self(address: &str, token: &str) -> Result<(), AppError> {
    let req = default_client()
        .post(url(address, "auth/token/renew-self"))
        .header("X-Vault-Token", token)
        .json(&serde_json::json!({}));
    vault_call(req, "Vault token renew").await.map(drop)
}

/// Generate a root token with the unseal key (`vault operator
/// generate-root`), for re-issuing a lost runtime token.
async fn generate_root(address: &str, unseal_key: &str) -> Result<String, AppError> {
    #[derive(Deserialize)]
    struct Attempt {
        nonce: String,
        otp: String,
    }
    #[derive(Deserialize)]
    struct Update {
        complete: bool,
        #[serde(default)]
        encoded_token: String,
        #[serde(default)]
        encoded_root_token: String,
    }

    let client = default_client();
    // A stale attempt from an interrupted run would block a new one.
    let _ = client
        .delete(url(address, "sys/generate-root/attempt"))
        .send()
        .await;
    let attempt: Attempt = vault_call(
        client
            .put(url(address, "sys/generate-root/attempt"))
            .json(&serde_json::json!({})),
        "Vault generate-root start",
    )
    .await?
    .json()
    .await
    .map_err(|e| AppError::Vault(format!("Vault generate-root start parse: {e}")))?;
    let update: Update = vault_call(
        client
            .put(url(address, "sys/generate-root/update"))
            .json(&serde_json::json!({ "key": unseal_key, "nonce": attempt.nonce })),
        "Vault generate-root update",
    )
    .await?
    .json()
    .await
    .map_err(|e| AppError::Vault(format!("Vault generate-root update parse: {e}")))?;
    if !update.complete {
        return Err(AppError::Vault(
            "Vault generate-root did not complete".into(),
        ));
    }
    let encoded = if update.encoded_token.is_empty() {
        update.encoded_root_token
    } else {
        update.encoded_token
    };
    decode_root(&encoded, &attempt.otp)
}

/// Vault returns the new root token XOR the one-time password, base64
/// encoded without padding.
fn decode_root(encoded: &str, otp: &str) -> Result<String, AppError> {
    let bytes = base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(encoded.trim_end_matches('='))
        .map_err(|e| AppError::Vault(format!("Vault generate-root token decode: {e}")))?;
    if bytes.len() != otp.len() {
        return Err(AppError::Vault(
            "Vault generate-root token and OTP lengths differ".into(),
        ));
    }
    let token: Vec<u8> = bytes.iter().zip(otp.bytes()).map(|(a, b)| a ^ b).collect();
    String::from_utf8(token)
        .map_err(|_| AppError::Vault("Vault generate-root token is not text".into()))
}

/// Save the bundled Vault's credentials for the next start.
pub fn save_local_credentials(creds: &LocalCredentials) -> anyhow::Result<()> {
    crate::config::LocalVaultSecrets {
        token: creds.token.clone(),
        unseal_key: creds.unseal_key.clone(),
    }
    .save()
}

/// Renew the bundled Vault's runtime token every hour, well inside its
/// period. If Vault no longer accepts it, provision a new one.
pub fn spawn_token_renewal(
    state: crate::services::app_state::SharedState,
    shutdown: tokio_util::sync::CancellationToken,
) -> tokio::task::JoinHandle<()> {
    use crate::services::worker::{spawn_periodic, PeriodicConfig};
    use std::time::Duration;

    spawn_periodic(
        PeriodicConfig {
            label: "vault_token_renewal",
            initial_delay: Duration::from_secs(60),
            interval: Duration::from_secs(3600),
            iteration_timeout: Duration::from_secs(120),
            error_backoff_base: Duration::from_secs(60),
        },
        shutdown,
        move || {
            let state = state.clone();
            async move {
                let vault = {
                    let s = state.read().await;
                    s.config.as_ref().and_then(|c| c.vault.clone())
                };
                let Some(v) = vault.filter(|v| v.mode == crate::config::VaultMode::Local) else {
                    return Ok::<(), AppError>(());
                };
                if renew_self(&v.address, &v.token).await.is_ok() {
                    return Ok(());
                }
                let creds = provision(
                    &v.address,
                    &v.transit_key,
                    v.unseal_key.as_deref(),
                    Some(&v.token),
                    save_local_credentials,
                )
                .await?;
                let mut s = state.write().await;
                if let Some(v) = s.config.as_mut().and_then(|c| c.vault.as_mut()) {
                    v.token = creds.token;
                }
                Ok(())
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_init_result_clone() {
        let result = VaultInitResult {
            root_token: "s.roottoken".into(),
            unseal_key: "unseal-key-123".into(),
        };
        let cloned = result.clone();
        assert_eq!(result.root_token, cloned.root_token);
        assert_eq!(result.unseal_key, cloned.unseal_key);
    }

    #[test]
    fn vault_init_result_debug() {
        let result = VaultInitResult {
            root_token: "s.root".into(),
            unseal_key: "key".into(),
        };
        let debug = format!("{:?}", result);
        assert!(debug.contains("root"));
    }

    #[test]
    fn init_request_serializes() {
        let req = InitRequest {
            secret_shares: 1,
            secret_threshold: 1,
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["secret_shares"], 1);
        assert_eq!(json["secret_threshold"], 1);
    }

    #[test]
    fn init_response_deserializes() {
        let json = r#"{"keys":["abc123"],"root_token":"s.token"}"#;
        let resp: InitResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.root_token, "s.token");
        assert_eq!(resp.keys.len(), 1);
    }

    #[test]
    fn unseal_request_serializes() {
        let req = UnsealRequest {
            key: "my-unseal-key".into(),
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["key"], "my-unseal-key");
    }

    #[test]
    fn unseal_response_deserializes() {
        let json = r#"{"sealed":false}"#;
        let resp: UnsealResponse = serde_json::from_str(json).unwrap();
        assert!(!resp.sealed);
    }

    #[test]
    fn health_response_deserializes() {
        let json = r#"{"initialized":true,"sealed":false}"#;
        let resp: HealthResponse = serde_json::from_str(json).unwrap();
        assert!(resp.initialized);
        assert!(!resp.sealed);
    }

    #[test]
    fn mounts_response_deserializes() {
        let json = r#"{"data":{"transit/":{"type":"transit"},"secret/":{"type":"kv"}}}"#;
        let resp: MountsResponse = serde_json::from_str(json).unwrap();
        assert!(resp.data.contains_key("transit/"));
        assert!(resp.data.contains_key("secret/"));
    }

    #[test]
    fn unseal_response_sealed_true() {
        let json = r#"{"sealed":true}"#;
        let resp: UnsealResponse = serde_json::from_str(json).unwrap();
        assert!(resp.sealed);
    }

    #[test]
    fn health_response_uninitialized() {
        let json = r#"{"initialized":false,"sealed":true}"#;
        let resp: HealthResponse = serde_json::from_str(json).unwrap();
        assert!(!resp.initialized);
        assert!(resp.sealed);
    }

    #[test]
    fn init_response_multiple_keys() {
        let json = r#"{"keys":["key1","key2","key3"],"root_token":"s.multi"}"#;
        let resp: InitResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.keys.len(), 3);
        assert_eq!(resp.root_token, "s.multi");
    }

    #[test]
    fn mounts_response_empty_data() {
        let json = r#"{"data":{}}"#;
        let resp: MountsResponse = serde_json::from_str(json).unwrap();
        assert!(resp.data.is_empty());
        assert!(!resp.data.contains_key("transit/"));
    }

    #[test]
    fn vault_init_result_fields() {
        let result = VaultInitResult {
            root_token: "hvs.long-root-token-value".into(),
            unseal_key: "base64-unseal-key-data".into(),
        };
        assert!(result.root_token.starts_with("hvs."));
        assert!(!result.unseal_key.is_empty());
    }

    // ── Mock Vault HTTP server for integration tests ─────────────────
    //
    // Spins up a tiny axum server on 127.0.0.1:<random-port> that emulates
    // the subset of Vault endpoints our provisioning code calls.  This lets
    // us exercise the real HTTP paths (init / unseal / mounts / transit)
    // without any external Vault binary.

    use axum::{
        extract::{Path as AxumPath, State as AxumState},
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::{get, post, put},
        Json, Router,
    };
    use serde_json::json;
    use std::collections::HashMap;
    use std::net::SocketAddr;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    const MOCK_OTP: &str = "abcdefghijklmnopqrst";
    const REGENERATED_ROOT: &str = "hvs.regenerated-r00t";

    #[derive(Default, Clone)]
    struct MockVault {
        initialized: Arc<Mutex<bool>>,
        sealed: Arc<Mutex<bool>>,
        transit_mounted: Arc<Mutex<bool>>,
        keys_created: Arc<Mutex<Vec<String>>>,
        /// Live tokens and their policies.
        tokens: Arc<Mutex<HashMap<String, Vec<String>>>>,
        revoked: Arc<Mutex<Vec<String>>>,
        policies: Arc<Mutex<HashMap<String, String>>>,
    }

    impl MockVault {
        async fn add_token(&self, token: &str, policy: &str) {
            self.tokens
                .lock()
                .await
                .insert(token.into(), vec![policy.into()]);
        }

        async fn policies_of(&self, headers: &HeaderMap) -> Option<Vec<String>> {
            let token = headers.get("x-vault-token")?.to_str().ok()?;
            self.tokens.lock().await.get(token).cloned()
        }
    }

    async fn start_mock_vault(state: MockVault) -> SocketAddr {
        let app = Router::new()
            .route(
                "/v1/sys/health",
                get(|AxumState(s): AxumState<MockVault>| async move {
                    Json(json!({
                        "initialized": *s.initialized.lock().await,
                        "sealed": *s.sealed.lock().await,
                    }))
                }),
            )
            .route(
                "/v1/sys/init",
                put(|AxumState(s): AxumState<MockVault>| async move {
                    *s.initialized.lock().await = true;
                    *s.sealed.lock().await = true;
                    s.add_token("hvs.mock-root-token", "root").await;
                    Json(json!({
                        "keys": ["mock-unseal-key"],
                        "root_token": "hvs.mock-root-token",
                    }))
                }),
            )
            .route(
                "/v1/sys/unseal",
                put(|AxumState(s): AxumState<MockVault>| async move {
                    *s.sealed.lock().await = false;
                    Json(json!({ "sealed": false }))
                }),
            )
            .route(
                "/v1/sys/mounts",
                get(|AxumState(s): AxumState<MockVault>| async move {
                    let mounted = *s.transit_mounted.lock().await;
                    let mut data = serde_json::Map::new();
                    if mounted {
                        data.insert("transit/".into(), json!({"type": "transit"}));
                    }
                    Json(json!({ "data": data }))
                }),
            )
            .route(
                "/v1/sys/mounts/transit",
                post(|AxumState(s): AxumState<MockVault>| async move {
                    *s.transit_mounted.lock().await = true;
                    Json(json!({}))
                }),
            )
            .route(
                "/v1/transit/keys/{name}",
                post(
                    |AxumState(s): AxumState<MockVault>, AxumPath(name): AxumPath<String>| async move {
                        s.keys_created.lock().await.push(name);
                        Json(json!({}))
                    },
                ),
            )
            .route(
                "/v1/transit/encrypt/{name}",
                post(|AxumState(s): AxumState<MockVault>, h: HeaderMap| async move {
                    match s.policies_of(&h).await {
                        Some(_) => Json(json!({ "data": { "ciphertext": "vault:v1:x" } }))
                            .into_response(),
                        None => StatusCode::FORBIDDEN.into_response(),
                    }
                }),
            )
            .route(
                "/v1/sys/policies/acl/{name}",
                put(
                    |AxumState(s): AxumState<MockVault>,
                     AxumPath(name): AxumPath<String>,
                     Json(body): Json<serde_json::Value>| async move {
                        let policy = body["policy"].as_str().unwrap_or_default().to_string();
                        s.policies.lock().await.insert(name, policy);
                        StatusCode::NO_CONTENT
                    },
                ),
            )
            .route(
                "/v1/auth/token/create-orphan",
                post(|AxumState(s): AxumState<MockVault>, h: HeaderMap| async move {
                    if s.policies_of(&h).await != Some(vec!["root".into()]) {
                        return StatusCode::FORBIDDEN.into_response();
                    }
                    let token = format!("hvs.runtime-{}", s.tokens.lock().await.len());
                    s.add_token(&token, RUNTIME_POLICY).await;
                    Json(json!({ "auth": { "client_token": token } })).into_response()
                }),
            )
            .route(
                "/v1/auth/token/lookup-self",
                get(|AxumState(s): AxumState<MockVault>, h: HeaderMap| async move {
                    match s.policies_of(&h).await {
                        Some(p) => Json(json!({ "data": { "policies": p } })).into_response(),
                        None => StatusCode::FORBIDDEN.into_response(),
                    }
                }),
            )
            .route(
                "/v1/auth/token/revoke-self",
                post(|AxumState(s): AxumState<MockVault>, h: HeaderMap| async move {
                    let token = h
                        .get("x-vault-token")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default()
                        .to_string();
                    s.tokens.lock().await.remove(&token);
                    s.revoked.lock().await.push(token);
                    StatusCode::NO_CONTENT
                }),
            )
            .route(
                "/v1/auth/token/revoke",
                post(
                    |AxumState(s): AxumState<MockVault>, Json(body): Json<serde_json::Value>| async move {
                        let token = body["token"].as_str().unwrap_or_default().to_string();
                        s.tokens.lock().await.remove(&token);
                        s.revoked.lock().await.push(token);
                        StatusCode::NO_CONTENT
                    },
                ),
            )
            .route(
                "/v1/sys/generate-root/attempt",
                put(|| async { Json(json!({ "nonce": "n1", "otp": MOCK_OTP })) })
                    .delete(|| async { StatusCode::NO_CONTENT }),
            )
            .route(
                "/v1/sys/generate-root/update",
                put(|AxumState(s): AxumState<MockVault>| async move {
                    s.add_token(REGENERATED_ROOT, "root").await;
                    let xored: Vec<u8> = REGENERATED_ROOT
                        .bytes()
                        .zip(MOCK_OTP.bytes())
                        .map(|(a, b)| a ^ b)
                        .collect();
                    let encoded = base64::engine::general_purpose::STANDARD_NO_PAD.encode(xored);
                    Json(json!({ "complete": true, "encoded_token": encoded }))
                }),
            )
            .with_state(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        // Give the server a moment to start accepting
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        addr
    }

    #[tokio::test]
    async fn health_returns_status_from_server() {
        let state = MockVault::default();
        *state.initialized.lock().await = true;
        *state.sealed.lock().await = false;
        let addr = start_mock_vault(state).await;
        let (initialized, sealed) = health(&format!("http://{addr}")).await.unwrap();
        assert!(initialized);
        assert!(!sealed);
    }

    #[tokio::test]
    async fn health_handles_trailing_slash() {
        let state = MockVault::default();
        let addr = start_mock_vault(state).await;
        // Should not produce a double-slash in the URL
        let result = health(&format!("http://{addr}/")).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn init_returns_root_token_and_unseal_key() {
        let state = MockVault::default();
        let addr = start_mock_vault(state.clone()).await;
        let result = init(&format!("http://{addr}")).await.unwrap();
        assert_eq!(result.root_token, "hvs.mock-root-token");
        assert_eq!(result.unseal_key, "mock-unseal-key");
        assert!(*state.initialized.lock().await);
    }

    #[tokio::test]
    async fn unseal_succeeds_and_updates_state() {
        let state = MockVault::default();
        *state.initialized.lock().await = true;
        *state.sealed.lock().await = true;
        let addr = start_mock_vault(state.clone()).await;
        unseal(&format!("http://{addr}"), "any-key").await.unwrap();
        assert!(!*state.sealed.lock().await);
    }

    #[tokio::test]
    async fn enable_transit_is_idempotent_when_mounted() {
        let state = MockVault::default();
        *state.transit_mounted.lock().await = true;
        let addr = start_mock_vault(state).await;
        // Already mounted → returns Ok without making the POST call
        enable_transit(&format!("http://{addr}"), "token")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn enable_transit_mounts_when_not_present() {
        let state = MockVault::default();
        let addr = start_mock_vault(state.clone()).await;
        enable_transit(&format!("http://{addr}"), "token")
            .await
            .unwrap();
        assert!(*state.transit_mounted.lock().await);
    }

    #[tokio::test]
    async fn create_transit_key_records_key() {
        let state = MockVault::default();
        let addr = start_mock_vault(state.clone()).await;
        create_transit_key(&format!("http://{addr}"), "token", "master-key")
            .await
            .unwrap();
        assert!(state
            .keys_created
            .lock()
            .await
            .contains(&"master-key".to_string()));
    }

    fn no_persist(_: &LocalCredentials) -> anyhow::Result<()> {
        Ok(())
    }

    #[tokio::test]
    async fn first_boot_ends_with_a_transit_only_token_and_no_root() {
        let state = MockVault::default();
        let addr = start_mock_vault(state.clone()).await;
        let saved = std::sync::Mutex::new(None);
        let creds = provision(&format!("http://{addr}"), "master-key", None, None, |c| {
            *saved.lock().unwrap() = Some(c.clone());
            Ok(())
        })
        .await
        .unwrap();

        assert!(creds.token.starts_with("hvs.runtime-"));
        assert_eq!(creds.unseal_key, "mock-unseal-key");
        assert_eq!(saved.lock().unwrap().as_ref(), Some(&creds));
        assert_eq!(*state.revoked.lock().await, vec!["hvs.mock-root-token"]);
        assert!(!*state.sealed.lock().await);
        assert!(*state.transit_mounted.lock().await);
        assert!(state
            .keys_created
            .lock()
            .await
            .contains(&"master-key".to_string()));
        let policy = state.policies.lock().await[RUNTIME_POLICY].clone();
        assert!(policy.contains("transit/encrypt/master-key"));
        assert!(!policy.contains("sys/"));
    }

    #[tokio::test]
    async fn a_stored_root_token_is_replaced_and_revoked() {
        let state = MockVault::default();
        *state.initialized.lock().await = true;
        *state.sealed.lock().await = true;
        state.add_token("hvs.legacy-root", "root").await;
        let addr = start_mock_vault(state.clone()).await;
        let creds = provision(
            &format!("http://{addr}"),
            "master-key",
            Some("stored-unseal-key"),
            Some("hvs.legacy-root"),
            no_persist,
        )
        .await
        .unwrap();
        assert!(creds.token.starts_with("hvs.runtime-"));
        assert!(!*state.sealed.lock().await);
        assert_eq!(*state.revoked.lock().await, vec!["hvs.legacy-root"]);
    }

    #[tokio::test]
    async fn a_stored_root_token_survives_if_the_replacement_cannot_be_saved() {
        let state = MockVault::default();
        *state.initialized.lock().await = true;
        state.add_token("hvs.legacy-root", "root").await;
        let addr = start_mock_vault(state.clone()).await;
        let result = provision(
            &format!("http://{addr}"),
            "master-key",
            Some("key"),
            Some("hvs.legacy-root"),
            |_| anyhow::bail!("disk full"),
        )
        .await;
        assert!(result.is_err());
        assert!(state.revoked.lock().await.is_empty());
    }

    #[tokio::test]
    async fn a_working_runtime_token_is_kept() {
        let state = MockVault::default();
        *state.initialized.lock().await = true;
        state.add_token("hvs.runtime-7", RUNTIME_POLICY).await;
        let addr = start_mock_vault(state.clone()).await;
        let creds = provision(
            &format!("http://{addr}"),
            "master-key",
            Some("key"),
            Some("hvs.runtime-7"),
            |_| panic!("nothing new to save"),
        )
        .await
        .unwrap();
        assert_eq!(creds.token, "hvs.runtime-7");
        assert!(state.revoked.lock().await.is_empty());
    }

    #[tokio::test]
    async fn a_token_from_an_older_policy_is_replaced_and_revoked() {
        let state = MockVault::default();
        *state.initialized.lock().await = true;
        state.add_token("hvs.old-runtime", "strata-transit").await;
        let addr = start_mock_vault(state.clone()).await;
        let creds = provision(
            &format!("http://{addr}"),
            "master-key",
            Some("key"),
            Some("hvs.old-runtime"),
            no_persist,
        )
        .await
        .unwrap();
        assert_ne!(creds.token, "hvs.old-runtime");
        assert_eq!(
            *state.revoked.lock().await,
            vec!["hvs.old-runtime", REGENERATED_ROOT]
        );
        let policy = state.policies.lock().await[RUNTIME_POLICY].clone();
        assert!(policy.contains(&format!("transit/sign/{AUDIT_SIGNING_KEY}")));
    }

    #[tokio::test]
    async fn a_lapsed_runtime_token_is_reissued_with_a_regenerated_root() {
        let state = MockVault::default();
        *state.initialized.lock().await = true;
        let addr = start_mock_vault(state.clone()).await;
        let creds = provision(
            &format!("http://{addr}"),
            "master-key",
            Some("key"),
            Some("hvs.expired"),
            no_persist,
        )
        .await
        .unwrap();
        assert!(creds.token.starts_with("hvs.runtime-"));
        assert_eq!(*state.revoked.lock().await, vec![REGENERATED_ROOT]);
    }

    #[tokio::test]
    async fn provision_initialized_missing_unseal_key_errors() {
        let state = MockVault::default();
        *state.initialized.lock().await = true;
        *state.sealed.lock().await = true;
        let addr = start_mock_vault(state).await;
        let result = provision(
            &format!("http://{addr}"),
            "master-key",
            None,
            Some("token"),
            no_persist,
        )
        .await;
        assert!(result.is_err());
    }

    #[test]
    fn key_names_that_could_change_the_policy_are_refused() {
        assert!(check_key_name("guac-master-key").is_ok());
        assert!(check_key_name("k\" { capabilities = [\"sudo\"] }").is_err());
        assert!(check_key_name("").is_err());
    }

    #[test]
    fn decodes_a_generated_root_token() {
        let otp = "0123456789abcdefghijklmnopqr";
        let token = "hvs.AAAAAAAAAAAAAAAAAAAAAAAA";
        let xored: Vec<u8> = token.bytes().zip(otp.bytes()).map(|(a, b)| a ^ b).collect();
        let encoded = base64::engine::general_purpose::STANDARD_NO_PAD.encode(xored);
        assert_eq!(decode_root(&encoded, otp).unwrap(), token);
        assert!(decode_root(&encoded, "short").is_err());
    }

    /// Against a real, uninitialised Vault in server mode, e.g.
    /// `docker run -d -p 18200:8200 -e VAULT_LOCAL_CONFIG='{"storage":{"inmem":{}},"listener":[{"tcp":{"address":"0.0.0.0:8200","tls_disable":true}}],"disable_mlock":true}' hashicorp/vault:1.19 server`
    /// then `STRATA_TEST_VAULT_ADDR=http://127.0.0.1:18200`.
    #[tokio::test]
    async fn real_vault_runtime_token_is_transit_only() {
        let Ok(addr) = std::env::var("STRATA_TEST_VAULT_ADDR") else {
            eprintln!("STRATA_TEST_VAULT_ADDR unset, skipping");
            return;
        };
        let creds = provision(&addr, "strata-key", None, None, no_persist)
            .await
            .unwrap();
        let cfg = crate::config::VaultConfig {
            address: addr.clone(),
            token: creds.token.clone(),
            transit_key: "strata-key".into(),
            mode: crate::config::VaultMode::Local,
            unseal_key: None,
        };
        let sealed = crate::services::vault::seal(&cfg, b"secret").await.unwrap();
        let opened = crate::services::vault::unseal(
            &cfg,
            &sealed.encrypted_dek,
            &sealed.ciphertext,
            &sealed.nonce,
        )
        .await
        .unwrap();
        assert_eq!(opened, b"secret");
        assert_eq!(
            lookup_self(&addr, &creds.token).await.unwrap(),
            Some(vec![RUNTIME_POLICY.to_string()])
        );
        renew_self(&addr, &creds.token).await.unwrap();

        // It can sign audit checkpoints, and a signature does not verify
        // for a different message.
        let signature = crate::services::vault::sign_audit(&cfg, b"checkpoint")
            .await
            .unwrap();
        assert!(
            crate::services::vault::verify_audit(&cfg, b"checkpoint", &signature)
                .await
                .unwrap()
        );
        assert!(
            !crate::services::vault::verify_audit(&cfg, b"tampered", &signature)
                .await
                .unwrap()
        );

        // The runtime token can do nothing else.
        let denied = default_client()
            .post(url(&addr, "auth/token/create-orphan"))
            .header("X-Vault-Token", &creds.token)
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), reqwest::StatusCode::FORBIDDEN);
        assert!(put_runtime_policy(&addr, &creds.token, "other")
            .await
            .is_err());

        // A lost token is reissued from the unseal key, root revoked again.
        let again = provision(
            &addr,
            "strata-key",
            Some(&creds.unseal_key),
            Some("hvs.not-a-token"),
            no_persist,
        )
        .await
        .unwrap();
        assert_ne!(again.token, creds.token);
        assert_eq!(
            lookup_self(&addr, &again.token).await.unwrap(),
            Some(vec![RUNTIME_POLICY.to_string()])
        );
    }

    #[tokio::test]
    async fn health_unreachable_returns_error() {
        // 127.0.0.1:1 is reserved and unreachable
        let result = health("http://127.0.0.1:1").await;
        assert!(result.is_err());
        assert!(format!("{}", result.unwrap_err()).contains("Vault"));
    }
}
