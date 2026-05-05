//! Configuration for the internal-side DMZ link.

use std::collections::HashMap;
use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

/// Single configured DMZ endpoint to maintain a link to.
#[derive(Debug, Clone)]
pub struct LinkEndpoint {
    /// Origin URL the connector should dial, e.g. `wss://dmz1:8444/link`
    /// or `tls://dmz1:8444`. Interpretation is connector-specific; the
    /// supervisor treats it as opaque.
    pub url: String,
}

/// Aggregate link configuration, loaded from environment variables.
#[derive(Clone)]
pub struct LinkConfig {
    /// Logical cluster id (e.g. `"production"`).
    pub cluster_id: String,
    /// Stable id of this internal node.
    pub node_id: String,
    /// Strata software version, advertised in `AuthHello`.
    pub software_version: String,
    /// Endpoints to maintain links to. Empty → standalone mode (no
    /// supervisors spawned).
    pub endpoints: Vec<LinkEndpoint>,
    /// Map of `psk_id` → raw PSK bytes. Populated from
    /// `STRATA_DMZ_LINK_PSK_<id>` env vars (base64).
    pub psks: HashMap<String, Vec<u8>>,
    /// Path to the PEM-encoded mTLS client cert chain (read by the TLS
    /// connector in Phase 1d).
    pub client_cert_path: Option<PathBuf>,
    /// Path to the PEM-encoded mTLS client private key.
    pub client_key_path: Option<PathBuf>,
    /// Path to the PEM-encoded private CA bundle that signs the DMZ's
    /// server certificate.
    pub link_ca_path: Option<PathBuf>,
}

impl std::fmt::Debug for LinkConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print PSK bytes.
        f.debug_struct("LinkConfig")
            .field("cluster_id", &self.cluster_id)
            .field("node_id", &self.node_id)
            .field("software_version", &self.software_version)
            .field("endpoints", &self.endpoints)
            .field("psk_ids", &self.psks.keys().collect::<Vec<_>>())
            .field("client_cert_path", &self.client_cert_path)
            .field("client_key_path", &self.client_key_path)
            .field("link_ca_path", &self.link_ca_path)
            .finish()
    }
}

impl LinkConfig {
    /// Load from environment variables. Returns `Ok(None)` if
    /// `STRATA_DMZ_ENDPOINTS` is unset or empty (standalone mode); a
    /// configured endpoint with no PSKs is treated as a fatal misconfig.
    pub fn from_env() -> anyhow::Result<Option<Self>> {
        Self::from_env_inner(
            |k| std::env::var(k).ok(),
            |prefix| {
                std::env::vars()
                    .filter(move |(k, _)| k.starts_with(prefix))
                    .collect()
            },
        )
    }

    /// Test seam: parse from arbitrary env-like sources.
    fn from_env_inner<G, P>(get: G, prefixed: P) -> anyhow::Result<Option<Self>>
    where
        G: Fn(&str) -> Option<String>,
        P: Fn(&str) -> Vec<(String, String)>,
    {
        let endpoints_raw = match get("STRATA_DMZ_ENDPOINTS") {
            Some(v) if !v.trim().is_empty() => v,
            _ => return Ok(None),
        };

        let endpoints: Vec<LinkEndpoint> = endpoints_raw
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| LinkEndpoint { url: s.to_string() })
            .collect();
        if endpoints.is_empty() {
            return Ok(None);
        }

        let cluster_id = get("STRATA_CLUSTER_ID").ok_or_else(|| {
            anyhow::anyhow!("STRATA_CLUSTER_ID required when STRATA_DMZ_ENDPOINTS set")
        })?;
        let node_id = get("STRATA_NODE_ID").ok_or_else(|| {
            anyhow::anyhow!("STRATA_NODE_ID required when STRATA_DMZ_ENDPOINTS set")
        })?;
        let software_version = get("CARGO_PKG_VERSION")
            .or_else(|| get("STRATA_SOFTWARE_VERSION"))
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());

        // PSKs: any env var of form STRATA_DMZ_LINK_PSK_<id>=<b64>.
        let mut psks: HashMap<String, Vec<u8>> = HashMap::new();
        for (k, v) in prefixed("STRATA_DMZ_LINK_PSK_") {
            let id = k.trim_start_matches("STRATA_DMZ_LINK_PSK_").to_lowercase();
            if id.is_empty() {
                continue;
            }
            let raw = B64
                .decode(v.trim())
                .map_err(|e| anyhow::anyhow!("STRATA_DMZ_LINK_PSK_{id}: invalid base64: {e}"))?;
            psks.insert(id, raw);
        }
        if psks.is_empty() {
            anyhow::bail!(
                "no STRATA_DMZ_LINK_PSK_<id> env vars set — DMZ link cannot authenticate"
            );
        }

        Ok(Some(Self {
            cluster_id,
            node_id,
            software_version,
            endpoints,
            psks,
            client_cert_path: get("STRATA_DMZ_LINK_TLS_CLIENT_CERT").map(PathBuf::from),
            client_key_path: get("STRATA_DMZ_LINK_TLS_CLIENT_KEY").map(PathBuf::from),
            link_ca_path: get("STRATA_DMZ_LINK_CA").map(PathBuf::from),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + '_ {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        move |k| map.get(k).cloned()
    }

    fn prefixed(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Vec<(String, String)> + '_ {
        move |prefix| {
            pairs
                .iter()
                .filter(|(k, _)| k.starts_with(prefix))
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect()
        }
    }

    #[test]
    fn unset_endpoints_returns_none() {
        let r = LinkConfig::from_env_inner(vars(&[]), prefixed(&[])).unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn empty_endpoints_returns_none() {
        let r = LinkConfig::from_env_inner(vars(&[("STRATA_DMZ_ENDPOINTS", "  ")]), prefixed(&[]))
            .unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn missing_cluster_id_errors() {
        let pairs = &[
            ("STRATA_DMZ_ENDPOINTS", "tls://dmz1:8444"),
            ("STRATA_DMZ_LINK_PSK_CURRENT", &B64.encode(b"k")),
        ];
        let r = LinkConfig::from_env_inner(vars(pairs), prefixed(pairs));
        assert!(r.is_err());
        let msg = format!("{}", r.unwrap_err());
        assert!(msg.contains("STRATA_CLUSTER_ID"));
    }

    #[test]
    fn missing_psk_errors() {
        let pairs = &[
            ("STRATA_DMZ_ENDPOINTS", "tls://dmz1:8444"),
            ("STRATA_CLUSTER_ID", "production"),
            ("STRATA_NODE_ID", "internal-1"),
        ];
        let r = LinkConfig::from_env_inner(vars(pairs), prefixed(pairs));
        assert!(r.is_err());
        let msg = format!("{}", r.unwrap_err());
        assert!(msg.contains("STRATA_DMZ_LINK_PSK"));
    }

    #[test]
    fn invalid_psk_base64_errors() {
        let pairs = &[
            ("STRATA_DMZ_ENDPOINTS", "tls://dmz1:8444"),
            ("STRATA_CLUSTER_ID", "production"),
            ("STRATA_NODE_ID", "internal-1"),
            ("STRATA_DMZ_LINK_PSK_CURRENT", "!!!not base64!!!"),
        ];
        let r = LinkConfig::from_env_inner(vars(pairs), prefixed(pairs));
        assert!(r.is_err());
    }

    #[test]
    fn full_config_parses() {
        let psk_b64 = B64.encode(b"shared-link-psk");
        let pairs = &[
            ("STRATA_DMZ_ENDPOINTS", "tls://dmz1:8444,tls://dmz2:8444"),
            ("STRATA_CLUSTER_ID", "production"),
            ("STRATA_NODE_ID", "internal-1"),
            ("STRATA_DMZ_LINK_PSK_CURRENT", psk_b64.as_str()),
            ("STRATA_DMZ_LINK_TLS_CLIENT_CERT", "/run/secrets/c.pem"),
            ("STRATA_DMZ_LINK_TLS_CLIENT_KEY", "/run/secrets/k.pem"),
            ("STRATA_DMZ_LINK_CA", "/run/secrets/ca.pem"),
        ];
        let cfg = LinkConfig::from_env_inner(vars(pairs), prefixed(pairs))
            .unwrap()
            .unwrap();
        assert_eq!(cfg.cluster_id, "production");
        assert_eq!(cfg.node_id, "internal-1");
        assert_eq!(cfg.endpoints.len(), 2);
        assert_eq!(cfg.endpoints[0].url, "tls://dmz1:8444");
        assert_eq!(
            cfg.psks.get("current").unwrap().as_slice(),
            b"shared-link-psk"
        );
        assert_eq!(
            cfg.client_cert_path.as_ref().unwrap().to_string_lossy(),
            "/run/secrets/c.pem"
        );
    }

    #[test]
    fn debug_format_does_not_leak_psk_bytes() {
        let pairs = &[
            ("STRATA_DMZ_ENDPOINTS", "tls://dmz1:8444"),
            ("STRATA_CLUSTER_ID", "production"),
            ("STRATA_NODE_ID", "internal-1"),
            (
                "STRATA_DMZ_LINK_PSK_CURRENT",
                &B64.encode(b"super-secret-psk-bytes"),
            ),
        ];
        let cfg = LinkConfig::from_env_inner(vars(pairs), prefixed(pairs))
            .unwrap()
            .unwrap();
        let dbg = format!("{cfg:?}");
        assert!(!dbg.contains("super-secret-psk-bytes"));
        assert!(!dbg.contains("115, 117, 112")); // first three bytes of "sup"
        assert!(dbg.contains("current")); // psk_id is fine to show
    }
}
