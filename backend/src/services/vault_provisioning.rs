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
}
