use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::OnceLock;

/// Process-wide JWT signing secret. Set once at startup, read by auth/middleware.
/// This avoids publishing the secret via `std::env::set_var` where it would be
/// visible to child processes and `/proc/self/environ`.
pub static JWT_SECRET: OnceLock<String> = OnceLock::new();

/// Top-level configuration persisted to config.toml.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub database_url: String,
    pub database_mode: DatabaseMode,

    #[serde(default)]
    pub vault: Option<VaultConfig>,

    #[serde(default)]
    pub guacd_host: Option<String>,
    #[serde(default)]
    pub guacd_port: Option<u16>,

    /// Additional guacd instances for load distribution.
    /// Each entry is "host:port".  When populated, connections are distributed
    /// across these instances + the primary (guacd_host:guacd_port) in
    /// round-robin order.
    #[serde(default)]
    pub guacd_instances: Vec<String>,

    /// HMAC secret for signing local JWTs.  Generated on first boot
    /// and persisted so tokens survive restarts.
    /// SECURITY: Never written to config.toml — resolved from JWT_SECRET env var only.
    #[serde(skip_serializing, default)]
    pub jwt_secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseMode {
    Local,
    External,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VaultMode {
    Local,
    External,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultConfig {
    pub address: String,
    /// SECURITY: token is skip_serializing — loaded from env/memory only.
    #[serde(skip_serializing, default)]
    pub token: String,
    pub transit_key: String,
    #[serde(default = "default_vault_mode")]
    pub mode: VaultMode,
    /// Unseal key for the bundled vault (single-key mode). Only stored for local vaults.
    /// SECURITY: skip_serializing — never written to config.toml.
    #[serde(skip_serializing, default)]
    pub unseal_key: Option<String>,
}

fn default_vault_mode() -> VaultMode {
    VaultMode::External
}

impl AppConfig {
    /// Load configuration from a TOML file on disk.
    pub fn load(path: &str) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path)?;
        let cfg: Self = toml::from_str(&text)?;
        Ok(cfg)
    }

    /// Persist configuration to a TOML file on disk.
    pub fn save(&self, path: &str) -> anyhow::Result<()> {
        if let Some(parent) = Path::new(path).parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = toml::to_string_pretty(self)?;
        std::fs::write(path, text)?;
        Ok(())
    }

    pub fn config_path() -> String {
        std::env::var("CONFIG_PATH").unwrap_or_else(|_| "/app/config/config.toml".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_save_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let path_str = path.to_str().unwrap();

        let cfg = AppConfig {
            database_url: "postgresql://localhost/test".into(),
            database_mode: DatabaseMode::Local,
            vault: Some(VaultConfig {
                address: "http://vault:8200".into(),
                token: "secret-token-value".into(),
                transit_key: "strata-key".into(),
                mode: VaultMode::Local,
                unseal_key: Some("unseal-123".into()),
            }),
            guacd_host: Some("guacd".into()),
            guacd_port: Some(4822),
            guacd_instances: vec!["guacd2:4823".into()],
            jwt_secret: Some("jwt-secret-value".into()),
        };

        cfg.save(path_str).unwrap();
        let loaded = AppConfig::load(path_str).unwrap();

        assert_eq!(loaded.database_url, "postgresql://localhost/test");
        assert_eq!(loaded.database_mode, DatabaseMode::Local);
        assert_eq!(loaded.guacd_host.as_deref(), Some("guacd"));
        assert_eq!(loaded.guacd_port, Some(4822));
        assert_eq!(loaded.guacd_instances, vec!["guacd2:4823"]);
    }

    #[test]
    fn vault_token_not_serialized() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let path_str = path.to_str().unwrap();

        let cfg = AppConfig {
            database_url: "postgresql://localhost/test".into(),
            database_mode: DatabaseMode::Local,
            vault: Some(VaultConfig {
                address: "http://vault:8200".into(),
                token: "super-secret".into(),
                transit_key: "key".into(),
                mode: VaultMode::External,
                unseal_key: Some("unseal-key".into()),
            }),
            guacd_host: None,
            guacd_port: None,
            guacd_instances: vec![],
            jwt_secret: Some("jwt-secret".into()),
        };

        cfg.save(path_str).unwrap();
        let raw = std::fs::read_to_string(path_str).unwrap();

        // Token, unseal_key, and jwt_secret must NOT appear in serialized output
        assert!(!raw.contains("super-secret"), "vault token leaked to config file");
        assert!(!raw.contains("unseal-key"), "unseal key leaked to config file");
        assert!(!raw.contains("jwt-secret"), "jwt secret leaked to config file");
    }

    #[test]
    fn database_mode_serde() {
        let json = serde_json::to_string(&DatabaseMode::Local).unwrap();
        assert_eq!(json, "\"local\"");
        let json = serde_json::to_string(&DatabaseMode::External).unwrap();
        assert_eq!(json, "\"external\"");
    }

    #[test]
    fn save_creates_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("deep").join("config.toml");
        let path_str = path.to_str().unwrap();

        let cfg = AppConfig {
            database_url: "postgresql://localhost/test".into(),
            database_mode: DatabaseMode::Local,
            vault: None,
            guacd_host: None,
            guacd_port: None,
            guacd_instances: vec![],
            jwt_secret: None,
        };

        cfg.save(path_str).unwrap();
        assert!(path.exists());
    }
}
