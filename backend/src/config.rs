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
    /// SECURITY: skip_serializing — database_url may contain credentials.
    /// Resolved from DATABASE_URL env var or persisted config on load.
    #[serde(skip_serializing, default)]
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

/// System-wide secrets (e.g. JWT signing key).
/// Kept separate from config.toml to avoid leaking via serialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemSecrets {
    pub jwt_secret: String,
}

impl SystemSecrets {
    /// Derive the secrets file path from the config directory.
    pub fn path() -> String {
        let config = AppConfig::config_path();
        let dir = Path::new(&config)
            .parent()
            .unwrap_or_else(|| Path::new("/app/config"));
        dir.join("system-secrets.json")
            .to_string_lossy()
            .into_owned()
    }

    /// Persist system secrets to disk.
    pub fn save(&self) -> anyhow::Result<()> {
        let path = Self::path();
        if let Some(parent) = Path::new(&path).parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string(self)?;
        std::fs::write(&path, &json)?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }

    /// Load system secrets from disk, if they exist.
    pub fn load() -> Option<Self> {
        let path = Self::path();
        let text = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&text).ok()
    }
}

/// Parse a comma-separated list of guacd instances, trimming whitespace and
/// filtering out empty entries.
pub fn parse_guacd_instances(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Parse a port number from an optional string, returning a default if the
/// string is `None` or not a valid `u16`.
pub fn parse_port_with_default(raw: Option<&str>, default: u16) -> u16 {
    raw.and_then(|p| p.parse().ok()).unwrap_or(default)
}

/// Determine `DatabaseMode` from a database URL string.
pub fn detect_database_mode(db_url: &str) -> DatabaseMode {
    if db_url.contains("postgres-local") {
        DatabaseMode::Local
    } else {
        DatabaseMode::External
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

        // database_url and jwt_secret have #[serde(skip_serializing)] for security,
        // so they should be empty/default after a config file round-trip.
        assert_eq!(loaded.database_url, "");
        assert_eq!(loaded.jwt_secret, None);

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

    #[test]
    fn vault_mode_serde() {
        let json = serde_json::to_string(&VaultMode::Local).unwrap();
        assert_eq!(json, "\"local\"");
        let json = serde_json::to_string(&VaultMode::External).unwrap();
        assert_eq!(json, "\"external\"");
    }

    #[test]
    fn vault_mode_equality() {
        assert_eq!(VaultMode::Local, VaultMode::Local);
        assert_ne!(VaultMode::Local, VaultMode::External);
    }

    #[test]
    fn vault_config_debug() {
        let vc = VaultConfig {
            address: "http://vault:8200".into(),
            token: "secret".into(),
            transit_key: "key".into(),
            mode: VaultMode::Local,
            unseal_key: None,
        };
        let debug = format!("{:?}", vc);
        assert!(debug.contains("vault:8200"));
    }

    #[test]
    fn app_config_debug() {
        let cfg = AppConfig {
            database_url: "postgresql://localhost/test".into(),
            database_mode: DatabaseMode::Local,
            database_ssl_mode: Some("require".into()),
            database_ca_cert: Some("/path/to/ca.pem".into()),
            vault: None,
            guacd_host: None,
            guacd_port: None,
            guacd_instances: vec![],
            jwt_secret: None,
        };
        let debug = format!("{:?}", cfg);
        assert!(debug.contains("Local"));
        assert!(debug.contains("require"));
    }

    #[test]
    fn app_config_ssl_mode_serialized() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let path_str = path.to_str().unwrap();

        let cfg = AppConfig {
            database_url: "postgresql://localhost/test".into(),
            database_mode: DatabaseMode::External,
            database_ssl_mode: Some("verify-full".into()),
            database_ca_cert: Some("/etc/ssl/ca.pem".into()),
            vault: None,
            guacd_host: None,
            guacd_port: None,
            guacd_instances: vec![],
            jwt_secret: None,
        };
        cfg.save(path_str).unwrap();
        let loaded = AppConfig::load(path_str).unwrap();
        assert_eq!(loaded.database_ssl_mode.as_deref(), Some("verify-full"));
        assert_eq!(loaded.database_ca_cert.as_deref(), Some("/etc/ssl/ca.pem"));
        assert_eq!(loaded.database_mode, DatabaseMode::External);
    }

    #[test]
    fn local_vault_secrets_debug() {
        let s = LocalVaultSecrets {
            token: "tok".into(),
            unseal_key: "key".into(),
        };
        let debug = format!("{:?}", s);
        assert!(debug.contains("tok"));
    }

    #[test]
    fn default_vault_mode_is_external() {
        assert_eq!(default_vault_mode(), VaultMode::External);
    }

    #[test]
    fn system_secrets_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        std::env::set_var("CONFIG_PATH", config_path.to_str().unwrap());

        let secrets = SystemSecrets {
            jwt_secret: "my-jwt-secret-123".into(),
        };
        secrets.save().unwrap();

        let loaded = SystemSecrets::load().unwrap();
        assert_eq!(loaded.jwt_secret, "my-jwt-secret-123");

        std::env::remove_var("CONFIG_PATH");
    }

    #[test]
    fn system_secrets_load_missing_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("nonexistent").join("config.toml");
        std::env::set_var("CONFIG_PATH", config_path.to_str().unwrap());

        assert!(SystemSecrets::load().is_none());

        std::env::remove_var("CONFIG_PATH");
    }

    #[test]
    fn system_secrets_debug() {
        let s = SystemSecrets {
            jwt_secret: "secret".into(),
        };
        let debug = format!("{:?}", s);
        assert!(debug.contains("secret"));
    }

    #[test]
    fn system_secrets_path_derives_from_config() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        std::env::set_var("CONFIG_PATH", config_path.to_str().unwrap());

        let path = SystemSecrets::path();
        assert!(path.ends_with("system-secrets.json"));
        assert!(path.contains(dir.path().to_str().unwrap()));

        std::env::remove_var("CONFIG_PATH");
    }

    #[test]
    fn config_path_default() {
        std::env::remove_var("CONFIG_PATH");
        let path = AppConfig::config_path();
        assert_eq!(path, "/app/config/config.toml");
    }

    #[test]
    fn local_vault_secrets_load_missing_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("nonexistent").join("config.toml");
        std::env::set_var("CONFIG_PATH", config_path.to_str().unwrap());

        assert!(LocalVaultSecrets::load().is_none());

        std::env::remove_var("CONFIG_PATH");
    }

    #[test]
    fn local_vault_secrets_path_derives_from_config() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        std::env::set_var("CONFIG_PATH", config_path.to_str().unwrap());

        let path = LocalVaultSecrets::path();
        assert!(path.ends_with("vault-secrets.json"));

        std::env::remove_var("CONFIG_PATH");
    }

    // ── parse_guacd_instances tests ───────────────────────────

    #[test]
    fn parse_guacd_instances_single() {
        assert_eq!(parse_guacd_instances("guacd2:4823"), vec!["guacd2:4823"]);
    }

    #[test]
    fn parse_guacd_instances_multiple() {
        assert_eq!(
            parse_guacd_instances("host1:4822,host2:4823,host3:4824"),
            vec!["host1:4822", "host2:4823", "host3:4824"]
        );
    }

    #[test]
    fn parse_guacd_instances_with_whitespace() {
        assert_eq!(
            parse_guacd_instances(" host1:4822 , host2:4823 "),
            vec!["host1:4822", "host2:4823"]
        );
    }

    #[test]
    fn parse_guacd_instances_empty() {
        let result: Vec<String> = parse_guacd_instances("");
        assert!(result.is_empty());
    }

    #[test]
    fn parse_guacd_instances_trailing_comma() {
        assert_eq!(parse_guacd_instances("host1:4822,"), vec!["host1:4822"]);
    }

    #[test]
    fn parse_guacd_instances_only_commas() {
        let result: Vec<String> = parse_guacd_instances(",,,");
        assert!(result.is_empty());
    }

    // ── parse_port_with_default tests ───────────────────────────

    #[test]
    fn parse_port_valid() {
        assert_eq!(parse_port_with_default(Some("8080"), 4822), 8080);
    }

    #[test]
    fn parse_port_none() {
        assert_eq!(parse_port_with_default(None, 4822), 4822);
    }

    #[test]
    fn parse_port_invalid() {
        assert_eq!(parse_port_with_default(Some("abc"), 4822), 4822);
    }

    #[test]
    fn parse_port_empty() {
        assert_eq!(parse_port_with_default(Some(""), 4822), 4822);
    }

    #[test]
    fn parse_port_overflow() {
        assert_eq!(parse_port_with_default(Some("99999"), 4822), 4822);
    }

    #[test]
    fn parse_port_zero() {
        assert_eq!(parse_port_with_default(Some("0"), 4822), 0);
    }

    // ── detect_database_mode tests ───────────────────────────

    #[test]
    fn detect_local_mode() {
        assert_eq!(
            detect_database_mode("postgresql://strata:pass@postgres-local:5432/strata"),
            DatabaseMode::Local
        );
    }

    #[test]
    fn detect_external_mode() {
        assert_eq!(
            detect_database_mode("postgresql://strata:pass@db.example.com:5432/strata"),
            DatabaseMode::External
        );
    }

    #[test]
    fn detect_external_mode_empty() {
        assert_eq!(detect_database_mode(""), DatabaseMode::External);
    }

    #[test]
    fn detect_local_in_path() {
        assert_eq!(
            detect_database_mode("postgresql://user@host/postgres-local-db"),
            DatabaseMode::Local
        );
    }
}
