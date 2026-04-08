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

    /// SSL mode for the PostgreSQL connection (disable, allow, prefer, require,
    /// verify-ca, verify-full).  Overrides any sslmode query parameter in
    /// `database_url`.
    #[serde(default)]
    pub database_ssl_mode: Option<String>,

    /// Path to a PEM-encoded CA certificate used to verify the PostgreSQL
    /// server when `database_ssl_mode` is verify-ca or verify-full.
    #[serde(default)]
    pub database_ca_cert: Option<String>,

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

/// Secrets file for the bundled (local) Vault.
/// Kept separate from config.toml so the main config can be freely
/// serialized without leaking credentials.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalVaultSecrets {
    pub token: String,
    pub unseal_key: String,
}

impl LocalVaultSecrets {
    /// Derive the secrets file path from the config directory.
    pub fn path() -> String {
        let config = AppConfig::config_path();
        let dir = Path::new(&config)
            .parent()
            .unwrap_or_else(|| Path::new("/app/config"));
        dir.join("vault-secrets.json")
            .to_string_lossy()
            .into_owned()
    }

    /// Persist the local vault secrets to disk (restrictive permissions on Unix).
    pub fn save(&self) -> anyhow::Result<()> {
        let path = Self::path();
        if let Some(parent) = Path::new(&path).parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string(self)?;
        std::fs::write(&path, &json)?;

        // Restrict file permissions to owner-only on Unix
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }

    /// Load local vault secrets from disk, if they exist.
    pub fn load() -> Option<Self> {
        let path = Self::path();
        let text = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&text).ok()
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
            database_ssl_mode: None,
            database_ca_cert: None,
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
            database_ssl_mode: None,
            database_ca_cert: None,
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
        assert!(
            !raw.contains("super-secret"),
            "vault token leaked to config file"
        );
        assert!(
            !raw.contains("unseal-key"),
            "unseal key leaked to config file"
        );
        assert!(
            !raw.contains("jwt-secret"),
            "jwt secret leaked to config file"
        );
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
            database_ssl_mode: None,
            database_ca_cert: None,
            vault: None,
            guacd_host: None,
            guacd_port: None,
            guacd_instances: vec![],
            jwt_secret: None,
        };

        cfg.save(path_str).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn local_vault_secrets_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let secrets_path = dir.path().join("vault-secrets.json");

        // Write directly to the file to test load independently of path()
        let secrets = LocalVaultSecrets {
            token: "hvs.root-token-123".into(),
            unseal_key: "abc123def456".into(),
        };
        let json = serde_json::to_string(&secrets).unwrap();
        std::fs::write(&secrets_path, &json).unwrap();

        let loaded: LocalVaultSecrets =
            serde_json::from_str(&std::fs::read_to_string(&secrets_path).unwrap()).unwrap();
        assert_eq!(loaded.token, "hvs.root-token-123");
        assert_eq!(loaded.unseal_key, "abc123def456");
    }

    #[test]
    fn local_vault_secrets_save_creates_file() {
        // Use env var to redirect the config path into a temp directory
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        std::env::set_var("CONFIG_PATH", config_path.to_str().unwrap());

        let secrets = LocalVaultSecrets {
            token: "hvs.test".into(),
            unseal_key: "key123".into(),
        };
        secrets.save().unwrap();

        let loaded = LocalVaultSecrets::load().unwrap();
        assert_eq!(loaded.token, "hvs.test");
        assert_eq!(loaded.unseal_key, "key123");

        std::env::remove_var("CONFIG_PATH");
    }
}
