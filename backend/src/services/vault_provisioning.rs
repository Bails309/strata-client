//! Vault lifecycle management for the bundled Vault container.
//!
//! Handles first-time initialization (operator init), unseal,
//! enabling the Transit secrets engine, and creating the encryption key.

use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

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
    let resp: HealthResponse = Client::new()
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
    let client = Client::new();

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

    let resp = Client::new()
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
    let client = Client::new();

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

    let resp = Client::new()
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

/// Full provisioning flow for the bundled Vault:
/// 1. Check health
/// 2. Init if not initialized
/// 3. Unseal if sealed
/// 4. Enable Transit engine
/// 5. Create the encryption key
///
/// Returns the VaultInitResult if init was performed (first boot),
/// or None if the vault was already initialized and just needed unsealing.
pub async fn provision(
    address: &str,
    transit_key: &str,
    existing_unseal_key: Option<&str>,
    existing_token: Option<&str>,
) -> Result<Option<VaultInitResult>, AppError> {
    let (initialized, sealed) = health(address).await?;

    let (token, unseal_key, init_result) = if !initialized {
        // First boot — initialize
        tracing::info!("Vault is not initialized, running operator init...");
        let result = init(address).await?;
        tracing::info!("Vault initialized successfully");
        (
            result.root_token.clone(),
            result.unseal_key.clone(),
            Some(result),
        )
    } else {
        // Already initialized — use stored credentials
        let token = existing_token
            .ok_or_else(|| AppError::Vault("Vault is initialized but no token is stored".into()))?
            .to_string();
        let key = existing_unseal_key
            .ok_or_else(|| AppError::Vault("Vault is sealed but no unseal key is stored".into()))?
            .to_string();
        (token, key, None)
    };

    if sealed || !initialized {
        // Need to unseal (init always produces a sealed vault)
        tracing::info!("Unsealing Vault...");
        unseal(address, &unseal_key).await?;
        tracing::info!("Vault unsealed");
    }

    // Enable transit and create key
    enable_transit(address, &token).await?;
    create_transit_key(address, &token, transit_key).await?;

    Ok(init_result)
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
        routing::{get, post, put},
        Json, Router,
    };
    use serde_json::json;
    use std::net::SocketAddr;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    #[derive(Default, Clone)]
    struct MockVault {
        initialized: Arc<Mutex<bool>>,
        sealed: Arc<Mutex<bool>>,
        transit_mounted: Arc<Mutex<bool>>,
        keys_created: Arc<Mutex<Vec<String>>>,
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

    #[tokio::test]
    async fn provision_first_boot_flow_end_to_end() {
        // Uninitialised vault → init, unseal, enable transit, create key
        let state = MockVault::default();
        let addr = start_mock_vault(state.clone()).await;
        let result = provision(&format!("http://{addr}"), "master-key", None, None)
            .await
            .unwrap();
        // First boot returns the init result
        assert!(result.is_some());
        let init = result.unwrap();
        assert_eq!(init.root_token, "hvs.mock-root-token");
        assert!(*state.initialized.lock().await);
        assert!(!*state.sealed.lock().await);
        assert!(*state.transit_mounted.lock().await);
        assert!(state
            .keys_created
            .lock()
            .await
            .contains(&"master-key".to_string()));
    }

    #[tokio::test]
    async fn provision_existing_initialized_uses_stored_credentials() {
        // Already initialized and sealed → unseal with stored key
        let state = MockVault::default();
        *state.initialized.lock().await = true;
        *state.sealed.lock().await = true;
        let addr = start_mock_vault(state.clone()).await;
        let result = provision(
            &format!("http://{addr}"),
            "master-key",
            Some("stored-unseal-key"),
            Some("stored-root-token"),
        )
        .await
        .unwrap();
        // Existing vault returns None (no new init)
        assert!(result.is_none());
        assert!(!*state.sealed.lock().await);
    }

    #[tokio::test]
    async fn provision_initialized_missing_token_errors() {
        let state = MockVault::default();
        *state.initialized.lock().await = true;
        let addr = start_mock_vault(state).await;
        let result = provision(&format!("http://{addr}"), "master-key", Some("key"), None).await;
        assert!(result.is_err());
        assert!(format!("{}", result.unwrap_err()).contains("token"));
    }

    #[tokio::test]
    async fn provision_initialized_missing_unseal_key_errors() {
        let state = MockVault::default();
        *state.initialized.lock().await = true;
        *state.sealed.lock().await = true;
        let addr = start_mock_vault(state).await;
        let result = provision(&format!("http://{addr}"), "master-key", None, Some("token")).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn health_unreachable_returns_error() {
        // 127.0.0.1:1 is reserved and unreachable
        let result = health("http://127.0.0.1:1").await;
        assert!(result.is_err());
        assert!(format!("{}", result.unwrap_err()).contains("Vault"));
    }
}
