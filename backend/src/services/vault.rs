use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use rand::RngCore;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::config::VaultConfig;
use crate::error::AppError;

/// Result of encrypting a credential using envelope encryption.
pub struct SealedCredential {
    pub ciphertext: Vec<u8>,
    pub encrypted_dek: Vec<u8>,
    pub nonce: Vec<u8>,
}

#[derive(Serialize)]
struct VaultEncryptRequest {
    plaintext: String,
}

#[derive(Deserialize)]
struct VaultEncryptResponse {
    data: VaultEncryptData,
}

#[derive(Deserialize)]
struct VaultEncryptData {
    ciphertext: String,
}

#[derive(Serialize)]
struct VaultDecryptRequest {
    ciphertext: String,
}

#[derive(Deserialize)]
struct VaultDecryptResponse {
    data: VaultDecryptData,
}

#[derive(Deserialize)]
struct VaultDecryptData {
    plaintext: String,
}

/// Encrypt a credential using envelope encryption:
/// 1. Generate random DEK
/// 2. Encrypt plaintext with DEK (AES-256-GCM)
/// 3. Wrap DEK via Vault Transit
pub async fn seal(vault: &VaultConfig, plaintext: &[u8]) -> Result<SealedCredential, AppError> {
    let b64 = base64::engine::general_purpose::STANDARD;

    // 1. Generate random DEK (32 bytes for AES-256)
    let mut dek = [0u8; 32];
    OsRng.fill_bytes(&mut dek);

    // 2. Encrypt plaintext with DEK
    let cipher = Aes256Gcm::new_from_slice(&dek)
        .map_err(|e| AppError::Internal(format!("AES init: {e}")))?;

    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| AppError::Internal(format!("AES encrypt: {e}")))?;

    // 3. Wrap DEK via Vault Transit engine
    let client = Client::new();
    let url = format!(
        "{}/v1/transit/encrypt/{}",
        vault.address.trim_end_matches('/'),
        vault.transit_key
    );

    let resp = client
        .post(&url)
        .header("X-Vault-Token", &vault.token)
        .json(&VaultEncryptRequest {
            plaintext: b64.encode(&dek),
        })
        .send()
        .await
        .map_err(|e| AppError::Vault(format!("Vault request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Vault(format!(
            "Vault encrypt failed ({status}): {body}"
        )));
    }

    let vault_resp: VaultEncryptResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Vault(format!("Vault response parse: {e}")))?;

    let encrypted_dek = vault_resp.data.ciphertext.into_bytes();

    // Zeroize plaintext DEK from memory
    dek.zeroize();

    Ok(SealedCredential {
        ciphertext,
        encrypted_dek,
        nonce: nonce_bytes.to_vec(),
    })
}

/// Decrypt a credential using envelope encryption:
/// 1. Unwrap DEK via Vault Transit
/// 2. Decrypt ciphertext with DEK (AES-256-GCM)
pub async fn unseal(
    vault: &VaultConfig,
    encrypted_dek: &[u8],
    ciphertext: &[u8],
    nonce_bytes: &[u8],
) -> Result<Vec<u8>, AppError> {
    let b64 = base64::engine::general_purpose::STANDARD;

    // 1. Unwrap DEK via Vault Transit
    let client = Client::new();
    let url = format!(
        "{}/v1/transit/decrypt/{}",
        vault.address.trim_end_matches('/'),
        vault.transit_key
    );

    let vault_ciphertext = String::from_utf8(encrypted_dek.to_vec())
        .map_err(|e| AppError::Vault(format!("DEK encoding: {e}")))?;

    let resp = client
        .post(&url)
        .header("X-Vault-Token", &vault.token)
        .json(&VaultDecryptRequest {
            ciphertext: vault_ciphertext,
        })
        .send()
        .await
        .map_err(|e| AppError::Vault(format!("Vault request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Vault(format!(
            "Vault decrypt failed ({status}): {body}"
        )));
    }

    let vault_resp: VaultDecryptResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Vault(format!("Vault response parse: {e}")))?;

    let mut dek = b64
        .decode(&vault_resp.data.plaintext)
        .map_err(|e| AppError::Vault(format!("DEK base64 decode: {e}")))?;

    // 2. Decrypt ciphertext with DEK
    let cipher = Aes256Gcm::new_from_slice(&dek)
        .map_err(|e| AppError::Internal(format!("AES init: {e}")))?;

    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| AppError::Internal(format!("AES decrypt: {e}")))?;

    // Zeroize DEK from memory
    dek.zeroize();

    Ok(plaintext)
}

/// Encrypt a string value for storage using the `vault:{json}` envelope format.
/// Used for settings, AD sync bind passwords, and other secrets stored as TEXT.
pub async fn seal_setting(vault: &VaultConfig, plaintext: &str) -> Result<String, AppError> {
    let sealed = seal(vault, plaintext.as_bytes()).await?;
    let b64 = base64::engine::general_purpose::STANDARD;
    let encoded = serde_json::json!({
        "ct": b64.encode(&sealed.ciphertext),
        "dek": b64.encode(&sealed.encrypted_dek),
        "n": b64.encode(&sealed.nonce),
    });
    Ok(format!("vault:{encoded}"))
}

/// Decrypt a `vault:{json}` envelope string. If the value does not start with
/// `vault:`, it is returned as-is (legacy plaintext).
pub async fn unseal_setting(vault: &VaultConfig, value: &str) -> Result<String, AppError> {
    let json_str = match value.strip_prefix("vault:") {
        Some(j) => j,
        None => return Ok(value.to_string()),
    };
    let parsed: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| AppError::Vault(format!("Invalid vault envelope: {e}")))?;
    let b64 = base64::engine::general_purpose::STANDARD;
    let ct = b64
        .decode(parsed["ct"].as_str().unwrap_or(""))
        .map_err(|e| AppError::Vault(format!("ct decode: {e}")))?;
    let dek = b64
        .decode(parsed["dek"].as_str().unwrap_or(""))
        .map_err(|e| AppError::Vault(format!("dek decode: {e}")))?;
    let n = b64
        .decode(parsed["n"].as_str().unwrap_or(""))
        .map_err(|e| AppError::Vault(format!("nonce decode: {e}")))?;
    let plaintext = unseal(vault, &dek, &ct, &n).await?;
    String::from_utf8(plaintext).map_err(|e| AppError::Vault(format!("UTF-8 decode: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_credential_fields() {
        let sc = SealedCredential {
            ciphertext: vec![1, 2, 3],
            encrypted_dek: vec![4, 5, 6],
            nonce: vec![7, 8, 9],
        };
        assert_eq!(sc.ciphertext, vec![1, 2, 3]);
        assert_eq!(sc.encrypted_dek, vec![4, 5, 6]);
        assert_eq!(sc.nonce, vec![7, 8, 9]);
    }

    #[tokio::test]
    async fn unseal_setting_plaintext_passthrough() {
        // Non-vault-prefixed values should pass through unchanged
        let vault_cfg = VaultConfig {
            address: "http://vault:8200".into(),
            token: "test-token".into(),
            transit_key: "strata-key".into(),
            mode: crate::config::VaultMode::Local,
            unseal_key: None,
        };
        let result = unseal_setting(&vault_cfg, "plain-text-value")
            .await
            .unwrap();
        assert_eq!(result, "plain-text-value");
    }

    #[tokio::test]
    async fn unseal_setting_invalid_json_after_prefix() {
        let vault_cfg = VaultConfig {
            address: "http://vault:8200".into(),
            token: "test-token".into(),
            transit_key: "strata-key".into(),
            mode: crate::config::VaultMode::Local,
            unseal_key: None,
        };
        let result = unseal_setting(&vault_cfg, "vault:not-valid-json").await;
        assert!(result.is_err());
        let err = format!("{}", result.unwrap_err());
        assert!(err.contains("Invalid vault envelope"));
    }

    #[test]
    fn vault_encrypt_request_serializes() {
        let req = VaultEncryptRequest {
            plaintext: "dGVzdA==".into(),
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["plaintext"], "dGVzdA==");
    }

    #[test]
    fn vault_decrypt_request_serializes() {
        let req = VaultDecryptRequest {
            ciphertext: "vault:v1:abc123".into(),
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["ciphertext"], "vault:v1:abc123");
    }

    #[test]
    fn vault_encrypt_response_deserializes() {
        let json = r#"{"data":{"ciphertext":"vault:v1:encrypted"}}"#;
        let resp: VaultEncryptResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.data.ciphertext, "vault:v1:encrypted");
    }

    #[test]
    fn vault_decrypt_response_deserializes() {
        let json = r#"{"data":{"plaintext":"dGVzdA=="}}"#;
        let resp: VaultDecryptResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.data.plaintext, "dGVzdA==");
    }
}
