use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use rand::Rng;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::config::VaultConfig;
use crate::error::AppError;

/// Maximum number of retry attempts for Vault API calls.
const VAULT_MAX_RETRIES: u32 = 3;
/// Base delay between retries (doubles each attempt).
const VAULT_RETRY_BASE_MS: u64 = 200;

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

/// Send a POST request to Vault with retry and exponential backoff.
/// Retries on network errors and 5xx responses; does not retry on 4xx.
async fn vault_post_with_retry<T: Serialize>(
    url: &str,
    token: &str,
    body: &T,
) -> Result<reqwest::Response, AppError> {
    let client = Client::new();
    let mut last_err = None;

    for attempt in 0..=VAULT_MAX_RETRIES {
        if attempt > 0 {
            let delay = VAULT_RETRY_BASE_MS * 2u64.pow(attempt - 1);
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }

        match client
            .post(url)
            .header("X-Vault-Token", token)
            .json(body)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_server_error() => {
                let status = resp.status();
                let body_text = resp.text().await.unwrap_or_default();
                last_err = Some(format!("Vault {status}: {body_text}"));
                tracing::warn!(
                    "Vault request failed (attempt {}/{}): {status}",
                    attempt + 1,
                    VAULT_MAX_RETRIES + 1
                );
                continue;
            }
            Ok(resp) => return Ok(resp),
            Err(e) => {
                last_err = Some(format!("Vault request failed: {e}"));
                tracing::warn!(
                    "Vault request error (attempt {}/{}): {e}",
                    attempt + 1,
                    VAULT_MAX_RETRIES + 1
                );
                continue;
            }
        }
    }

    Err(AppError::Vault(last_err.unwrap_or_else(|| {
        "Vault request failed after retries".into()
    })))
}

/// Encrypt a credential using envelope encryption:
/// 1. Generate random DEK
/// 2. Encrypt plaintext with DEK (AES-256-GCM)
/// 3. Wrap DEK via Vault Transit
pub async fn seal(vault: &VaultConfig, plaintext: &[u8]) -> Result<SealedCredential, AppError> {
    let b64 = base64::engine::general_purpose::STANDARD;

    // 1. Generate random DEK (32 bytes for AES-256)
    let mut dek: [u8; 32] = OsRng.gen();

    // 2. Encrypt plaintext with DEK
    let cipher = Aes256Gcm::new_from_slice(&dek)
        .map_err(|e| AppError::Internal(format!("AES init: {e}")))?;

    let nonce_bytes: [u8; 12] = OsRng.gen();
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| AppError::Internal(format!("AES encrypt: {e}")))?;

    // 3. Wrap DEK via Vault Transit engine (with retry)
    let url = format!(
        "{}/v1/transit/encrypt/{}",
        vault.address.trim_end_matches('/'),
        vault.transit_key
    );

    let resp = vault_post_with_retry(
        &url,
        &vault.token,
        &VaultEncryptRequest {
            plaintext: b64.encode(dek),
        },
    )
    .await?;

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

    // 1. Unwrap DEK via Vault Transit (with retry)
    let url = format!(
        "{}/v1/transit/decrypt/{}",
        vault.address.trim_end_matches('/'),
        vault.transit_key
    );

    let vault_ciphertext = String::from_utf8(encrypted_dek.to_vec())
        .map_err(|e| AppError::Vault(format!("DEK encoding: {e}")))?;

    let resp = vault_post_with_retry(
        &url,
        &vault.token,
        &VaultDecryptRequest {
            ciphertext: vault_ciphertext,
        },
    )
    .await?;

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

/// Encode sealed bytes into a `vault:{json}` envelope string.
pub fn format_seal_envelope(sealed: &SealedCredential) -> String {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    let encoded = serde_json::json!({
        "ct": b64.encode(&sealed.ciphertext),
        "dek": b64.encode(&sealed.encrypted_dek),
        "n": b64.encode(&sealed.nonce),
    });
    format!("vault:{encoded}")
}

/// Decoded fields from a vault envelope: (ciphertext, encrypted_dek, nonce).
pub struct VaultEnvelope {
    pub ciphertext: Vec<u8>,
    pub encrypted_dek: Vec<u8>,
    pub nonce: Vec<u8>,
}

/// Parse a `vault:{json}` envelope, decoding the base64 ct/dek/nonce fields.
/// If the string does not start with `vault:`, returns `None` (treat as legacy plaintext).
pub fn parse_vault_envelope(value: &str) -> Result<Option<VaultEnvelope>, AppError> {
    use base64::Engine;
    let json_str = match value.strip_prefix("vault:") {
        Some(j) => j,
        None => return Ok(None),
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
    Ok(Some(VaultEnvelope {
        ciphertext: ct,
        encrypted_dek: dek,
        nonce: n,
    }))
}

/// Encrypt a string value for storage using the `vault:{json}` envelope format.
/// Used for settings, AD sync bind passwords, and other secrets stored as TEXT.
pub async fn seal_setting(vault: &VaultConfig, plaintext: &str) -> Result<String, AppError> {
    let sealed = seal(vault, plaintext.as_bytes()).await?;
    Ok(format_seal_envelope(&sealed))
}

/// Decrypt a `vault:{json}` envelope string. If the value does not start with
/// `vault:`, it is returned as-is (legacy plaintext).
pub async fn unseal_setting(vault: &VaultConfig, value: &str) -> Result<String, AppError> {
    let env = match parse_vault_envelope(value)? {
        Some(e) => e,
        None => return Ok(value.to_string()),
    };
    let plaintext = unseal(vault, &env.encrypted_dek, &env.ciphertext, &env.nonce).await?;
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

    #[test]
    fn sealed_credential_non_empty() {
        let sc = SealedCredential {
            ciphertext: vec![10, 20, 30, 40],
            encrypted_dek: vec![50, 60],
            nonce: vec![70, 80, 90, 100, 110, 120],
        };
        assert!(!sc.ciphertext.is_empty());
        assert!(!sc.encrypted_dek.is_empty());
        assert_eq!(sc.nonce.len(), 6);
    }

    #[tokio::test]
    async fn unseal_setting_empty_string_passthrough() {
        let vault_cfg = VaultConfig {
            address: "http://vault:8200".into(),
            token: "test-token".into(),
            transit_key: "strata-key".into(),
            mode: crate::config::VaultMode::Local,
            unseal_key: None,
        };
        let result = unseal_setting(&vault_cfg, "").await.unwrap();
        assert_eq!(result, "");
    }

    #[tokio::test]
    async fn unseal_setting_vault_prefix_missing_fields() {
        let vault_cfg = VaultConfig {
            address: "http://vault:8200".into(),
            token: "test-token".into(),
            transit_key: "strata-key".into(),
            mode: crate::config::VaultMode::Local,
            unseal_key: None,
        };
        // Valid JSON but missing expected fields — the base64 decode will fail on empty
        let result = unseal_setting(&vault_cfg, r#"vault:{"ct":"","dek":"","n":""}"#).await;
        // This will attempt to unseal with empty data, which should fail at the Vault call
        // or AES decryption. Either way it produces an error.
        assert!(result.is_err());
    }

    #[test]
    fn vault_encrypt_request_roundtrip() {
        let req = VaultEncryptRequest {
            plaintext: "aGVsbG8=".into(),
        };
        let json_str = serde_json::to_string(&req).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert_eq!(parsed["plaintext"], "aGVsbG8=");
    }

    #[test]
    fn vault_decrypt_request_roundtrip() {
        let req = VaultDecryptRequest {
            ciphertext: "vault:v1:xyz".into(),
        };
        let json_str = serde_json::to_string(&req).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert_eq!(parsed["ciphertext"], "vault:v1:xyz");
    }

    #[tokio::test]
    async fn unseal_setting_bad_base64_ct() {
        let vault_cfg = VaultConfig {
            address: "http://vault:8200".into(),
            token: "t".into(),
            transit_key: "k".into(),
            mode: crate::config::VaultMode::Local,
            unseal_key: None,
        };
        let result = unseal_setting(
            &vault_cfg,
            r#"vault:{"ct":"!!!invalid!!!","dek":"dGVzdA==","n":"dGVzdA=="}"#,
        )
        .await;
        assert!(result.is_err());
        assert!(format!("{}", result.unwrap_err()).contains("ct decode"));
    }

    #[tokio::test]
    async fn unseal_setting_bad_base64_dek() {
        let vault_cfg = VaultConfig {
            address: "http://vault:8200".into(),
            token: "t".into(),
            transit_key: "k".into(),
            mode: crate::config::VaultMode::Local,
            unseal_key: None,
        };
        let result = unseal_setting(
            &vault_cfg,
            r#"vault:{"ct":"dGVzdA==","dek":"!!!bad!!!","n":"dGVzdA=="}"#,
        )
        .await;
        assert!(result.is_err());
        assert!(format!("{}", result.unwrap_err()).contains("dek decode"));
    }

    #[tokio::test]
    async fn unseal_setting_bad_base64_nonce() {
        let vault_cfg = VaultConfig {
            address: "http://vault:8200".into(),
            token: "t".into(),
            transit_key: "k".into(),
            mode: crate::config::VaultMode::Local,
            unseal_key: None,
        };
        let result = unseal_setting(
            &vault_cfg,
            r#"vault:{"ct":"dGVzdA==","dek":"dGVzdA==","n":"!!!bad!!!"}"#,
        )
        .await;
        assert!(result.is_err());
        assert!(format!("{}", result.unwrap_err()).contains("nonce decode"));
    }

    // ── format_seal_envelope ───────────────────────────────────────

    #[test]
    fn format_seal_envelope_produces_vault_prefix() {
        let sealed = SealedCredential {
            ciphertext: vec![1, 2, 3],
            encrypted_dek: vec![4, 5, 6],
            nonce: vec![7, 8, 9],
        };
        let result = format_seal_envelope(&sealed);
        assert!(result.starts_with("vault:"));
    }

    #[test]
    fn format_seal_envelope_contains_valid_json() {
        let sealed = SealedCredential {
            ciphertext: vec![10, 20],
            encrypted_dek: vec![30, 40],
            nonce: vec![50, 60],
        };
        let result = format_seal_envelope(&sealed);
        let json_str = result.strip_prefix("vault:").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(json_str).unwrap();
        assert!(parsed["ct"].is_string());
        assert!(parsed["dek"].is_string());
        assert!(parsed["n"].is_string());
    }

    #[test]
    fn format_seal_envelope_roundtrips_with_parse() {
        let sealed = SealedCredential {
            ciphertext: vec![0xDE, 0xAD, 0xBE, 0xEF],
            encrypted_dek: vec![0xCA, 0xFE],
            nonce: vec![0xBA, 0xBE],
        };
        let envelope = format_seal_envelope(&sealed);
        let env = parse_vault_envelope(&envelope).unwrap().unwrap();
        assert_eq!(env.ciphertext, vec![0xDE, 0xAD, 0xBE, 0xEF]);
        assert_eq!(env.encrypted_dek, vec![0xCA, 0xFE]);
        assert_eq!(env.nonce, vec![0xBA, 0xBE]);
    }

    #[test]
    fn format_seal_envelope_empty_fields() {
        let sealed = SealedCredential {
            ciphertext: vec![],
            encrypted_dek: vec![],
            nonce: vec![],
        };
        let result = format_seal_envelope(&sealed);
        assert!(result.starts_with("vault:"));
        // Should still parse back
        let env = parse_vault_envelope(&result).unwrap().unwrap();
        assert!(env.ciphertext.is_empty());
        assert!(env.encrypted_dek.is_empty());
        assert!(env.nonce.is_empty());
    }

    // ── parse_vault_envelope ───────────────────────────────────────

    #[test]
    fn parse_vault_envelope_no_prefix() {
        let result = parse_vault_envelope("plain-text").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn parse_vault_envelope_empty_string() {
        let result = parse_vault_envelope("").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn parse_vault_envelope_invalid_json() {
        let result = parse_vault_envelope("vault:not-json");
        assert!(result.is_err());
    }

    #[test]
    fn parse_vault_envelope_bad_base64_ct() {
        let result =
            parse_vault_envelope(r#"vault:{"ct":"!!!invalid!!!","dek":"dGVzdA==","n":"dGVzdA=="}"#);
        assert!(result.is_err());
    }

    #[test]
    fn parse_vault_envelope_bad_base64_dek() {
        let result =
            parse_vault_envelope(r#"vault:{"ct":"dGVzdA==","dek":"!!!bad!!!","n":"dGVzdA=="}"#);
        assert!(result.is_err());
    }

    #[test]
    fn parse_vault_envelope_bad_base64_nonce() {
        let result =
            parse_vault_envelope(r#"vault:{"ct":"dGVzdA==","dek":"dGVzdA==","n":"!!!bad!!!"}"#);
        assert!(result.is_err());
    }

    #[test]
    fn parse_vault_envelope_valid() {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD;
        let envelope = format!(
            r#"vault:{{"ct":"{}","dek":"{}","n":"{}"}}"#,
            b64.encode([1, 2, 3]),
            b64.encode([4, 5]),
            b64.encode([6, 7, 8]),
        );
        let env = parse_vault_envelope(&envelope).unwrap().unwrap();
        assert_eq!(env.ciphertext, vec![1, 2, 3]);
        assert_eq!(env.encrypted_dek, vec![4, 5]);
        assert_eq!(env.nonce, vec![6, 7, 8]);
    }

    #[test]
    fn parse_vault_envelope_missing_fields_empty_decode() {
        // Missing ct/dek/n fields — parsed["ct"].as_str() returns None → unwrap_or("")
        // Empty string base64 decodes to empty vec, which is valid
        let env = parse_vault_envelope("vault:{}").unwrap().unwrap();
        assert!(env.ciphertext.is_empty());
        assert!(env.encrypted_dek.is_empty());
        assert!(env.nonce.is_empty());
    }
}
