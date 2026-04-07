use serde::{Deserialize, Serialize};
use std::path::Path;

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
    pub token: String,
    pub transit_key: String,
    #[serde(default = "default_vault_mode")]
    pub mode: VaultMode,
    /// Unseal key for the bundled vault (single-key mode). Only stored for local vaults.
    #[serde(default)]
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
