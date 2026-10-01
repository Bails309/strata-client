//! Shared `reqwest::Client` factories (W3-1).
//!
//! Coding Standards §3.3 requires every outbound HTTP call to have a
//! bounded connect + overall timeout. Before this module existed, most
//! call sites used `reqwest::Client::new()`, which has **no timeout** —
//! a hung upstream (Azure Blob, OIDC IdP) would pin a tokio task forever
//! and eventually exhaust the connection pool.
//!
//! This module centralises three presets:
//!
//! * `default_client()` — general-purpose: 30s overall / 5s connect.
//! * `oidc_client()`    — 10s overall / 5s connect; OIDC endpoints should
//!   fail fast so login latency stays predictable.
//! * `azure_client()`   — 60s overall / 5s connect, `https_only = true`;
//!   blob uploads can legitimately run a while.
//!
//! Each preset is cached in a `OnceLock` so the connection pool is shared
//! across call sites. Tests should build their own clients directly if
//! they need a different configuration.

use std::sync::OnceLock;
use std::time::Duration;

static DEFAULT: OnceLock<reqwest::Client> = OnceLock::new();
static OIDC: OnceLock<reqwest::Client> = OnceLock::new();
static AZURE: OnceLock<reqwest::Client> = OnceLock::new();
static VAULT: OnceLock<reqwest::Client> = OnceLock::new();

fn builder(timeout: Duration, connect: Duration, https_only: bool) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(connect)
        .https_only(https_only)
        .user_agent(concat!("strata-backend/", env!("CARGO_PKG_VERSION")))
}

fn build(timeout: Duration, connect: Duration, https_only: bool) -> reqwest::Client {
    builder(timeout, connect, https_only)
        .build()
        .expect("reqwest client builder must succeed with static config")
}

/// General-purpose client (30s overall / 5s connect).
pub fn default_client() -> &'static reqwest::Client {
    DEFAULT.get_or_init(|| build(Duration::from_secs(30), Duration::from_secs(5), false))
}

/// Short-timeout client for OIDC discovery/token endpoints.
pub fn oidc_client() -> &'static reqwest::Client {
    OIDC.get_or_init(|| build(Duration::from_secs(10), Duration::from_secs(5), false))
}

/// HTTPS-only client for Azure Blob Storage.
pub fn azure_client() -> &'static reqwest::Client {
    AZURE.get_or_init(|| build(Duration::from_secs(60), Duration::from_secs(5), true))
}

/// Client for Vault: the default limits, also trusting the CA certificates
/// in `VAULT_CACERT` (the bundled Vault's private CA).
pub fn vault_client() -> &'static reqwest::Client {
    VAULT.get_or_init(|| {
        let mut b = builder(Duration::from_secs(30), Duration::from_secs(5), false);
        match vault_ca_certs() {
            Ok(certs) => {
                for cert in certs {
                    b = b.add_root_certificate(cert);
                }
            }
            // Without the CA the bundled Vault's certificate is refused, so this fails closed.
            Err(e) => tracing::error!("VAULT_CACERT not loaded, Vault calls will fail TLS: {e}"),
        }
        b.build()
            .expect("reqwest client builder must succeed with static config")
    })
}

fn vault_ca_certs() -> anyhow::Result<Vec<reqwest::Certificate>> {
    let Some(path) = std::env::var("VAULT_CACERT")
        .ok()
        .filter(|p| !p.trim().is_empty())
    else {
        return Ok(Vec::new());
    };
    let pem = std::fs::read(&path).map_err(|e| anyhow::anyhow!("{path}: {e}"))?;
    let certs = reqwest::Certificate::from_pem_bundle(&pem)?;
    anyhow::ensure!(!certs.is_empty(), "{path} holds no certificates");
    Ok(certs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clients_are_cached() {
        let a = default_client();
        let b = default_client();
        assert!(std::ptr::eq(a, b));
    }

    #[test]
    fn presets_are_distinct() {
        assert!(!std::ptr::eq(default_client(), oidc_client()));
        assert!(!std::ptr::eq(default_client(), azure_client()));
        assert!(!std::ptr::eq(oidc_client(), azure_client()));
    }
}
