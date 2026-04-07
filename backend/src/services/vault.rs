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
pub async fn seal(
    vault: &VaultConfig,
    plaintext: &[u8],
) -> Result<SealedCredential, AppError> {
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
        return Err(AppError::Vault(format!("Vault encrypt failed ({status}): {body}")));
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

/// Decrypt a credential using envelope decryption:
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
        return Err(AppError::Vault(format!("Vault decrypt failed ({status}): {body}")));
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
