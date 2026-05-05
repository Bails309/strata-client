//! `strata-dmz` configuration, loaded from environment variables.
//!
//! The DMZ binary is intentionally simple to operate — there is no
//! YAML/TOML config file. Every knob is an env var, every var is
//! validated at boot, and validation failures abort the process with
//! a clear message.
//!
//! ## Variable reference
//!
//! | Var | Default | Meaning |
//! |---|---|---|
//! | `STRATA_DMZ_PUBLIC_BIND` | `0.0.0.0:8443` | Public-facing listener (TLS-terminated). |
//! | `STRATA_DMZ_LINK_BIND` | `0.0.0.0:9443` | Link-server listener: where internal nodes dial in over mTLS. |
//! | `STRATA_DMZ_PUBLIC_TLS_CERT` | _required for prod_ | Public TLS cert (PEM). |
//! | `STRATA_DMZ_PUBLIC_TLS_KEY` | _required for prod_ | Public TLS key (PEM). |
//! | `STRATA_DMZ_LINK_TLS_CERT` | _required_ | DMZ side of the link mTLS cert (PEM). |
//! | `STRATA_DMZ_LINK_TLS_KEY` | _required_ | DMZ side of the link mTLS key (PEM). |
//! | `STRATA_DMZ_LINK_CA_BUNDLE` | _required_ | Private CA bundle that signs the internal nodes' link certs (PEM). System truststore is **not** consulted. |
//! | `STRATA_DMZ_LINK_PSKS` | _required_ | Comma-separated `id:base64key` pairs for handshake PSK validation. First entry is the active key; rest accepted during rotation. |
//! | `STRATA_DMZ_EDGE_HMAC_KEY` | _required_ | Base64 HMAC-SHA-256 key the DMZ uses to sign `x-strata-edge-*` headers. Must match the active key in the internal node's `STRATA_DMZ_EDGE_HMAC_KEYS`. |
//! | `STRATA_DMZ_CLUSTER_ID` | _required_ | Cluster id this DMZ belongs to. Internal-node handshakes that present a different cluster id are rejected. |
//! | `STRATA_DMZ_NODE_ID` | hostname | Logical id used in metrics / logs. |
//! | `STRATA_DMZ_PUBLIC_BODY_LIMIT_BYTES` | `8388608` (8 MiB) | Cap on inbound public request bodies. |
//! | `STRATA_DMZ_PUBLIC_HEADER_TIMEOUT_MS` | `15000` | Slow-loris guard: time allowed to receive request headers. |
//! | `STRATA_DMZ_PUBLIC_RATE_RPS` | `0` (off) | Per-IP request rate cap in req/s. `0` disables. |
//! | `STRATA_DMZ_PUBLIC_RATE_BURST` | `64` | Per-IP burst bucket size when rate limiting is enabled. |
//! | `STRATA_DMZ_PUBLIC_MAX_INFLIGHT` | `4096` | Hard cap on concurrent in-flight public requests. |
//! | `STRATA_DMZ_TRUST_FORWARDED_FROM` | _unset_ | Optional comma-separated CIDRs of upstream LB IPs whose `X-Forwarded-For` header is trusted. Anything outside this list is ignored. |
//!
//! ## Defaults & dev mode
//!
//! `dev_mode()` returns `true` when `STRATA_DMZ_DEV=1` is set. In dev
//! mode, the public TLS material is optional (the listener serves
//! plain HTTP) and the link CA + PSKs may be loaded from filesystem
//! defaults — strictly for local docker-compose work. Production
//! deployments MUST NOT set `STRATA_DMZ_DEV`.
//!
//! ## Secrets handling
//!
//! HMAC keys and PSK material are wrapped in [`Zeroizing`] so the
//! process memory is wiped on drop. The `Debug` impl on [`DmzConfig`]
//! redacts both. `STRATA_DMZ_LINK_PSKS` and `STRATA_DMZ_EDGE_HMAC_KEY`
//! are scrubbed from the environment after parsing.

#![allow(unsafe_code)]

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use thiserror::Error;
use zeroize::Zeroizing;

/// Minimum acceptable HMAC / PSK key length, in bytes.
///
/// HMAC-SHA-256 accepts any length, but anything below this risks
/// brute-force. Matches the internal-side requirement.
pub const MIN_KEY_LEN_BYTES: usize = 32;

/// Default public listener address.
pub const DEFAULT_PUBLIC_BIND: &str = "0.0.0.0:8443";

/// Default link-server listener address.
pub const DEFAULT_LINK_BIND: &str = "0.0.0.0:9443";

/// Default body cap on public requests (8 MiB). Matches the link
/// multiplexer's `MAX_REQUEST_BODY_BYTES` so a request that the
/// public listener accepts will fit through the link without a 413.
pub const DEFAULT_PUBLIC_BODY_LIMIT_BYTES: usize = 8 * 1024 * 1024;

/// Default header-receipt timeout (slow-loris guard).
pub const DEFAULT_PUBLIC_HEADER_TIMEOUT_MS: u64 = 15_000;

/// Default per-IP burst bucket size.
pub const DEFAULT_PUBLIC_RATE_BURST: u32 = 64;

/// Default in-flight cap.
pub const DEFAULT_PUBLIC_MAX_INFLIGHT: usize = 4096;

/// Default operator listener — loopback so a misconfigured firewall
/// never exposes it. Operators are expected to override this on
/// machines with multiple management interfaces.
pub const DEFAULT_OPERATOR_BIND: &str = "127.0.0.1:9444";

/// Minimum acceptable operator-token length. 32 chars is enough for
/// 128-bit entropy in a hex / base32 token.
pub const MIN_OPERATOR_TOKEN_LEN: usize = 32;

/// Errors produced while parsing the environment into a [`DmzConfig`].
///
/// Every variant carries the offending env var name so the operator
/// can fix it without grepping the source.
#[derive(Debug, Error)]
pub enum ConfigError {
    /// A required variable was missing in the environment.
    #[error("required env var {0} is not set")]
    Missing(&'static str),
    /// A variable was set but failed parsing (bad number, bad CIDR,
    /// bad SocketAddr, ...).
    #[error("env var {var} could not be parsed: {reason}")]
    Parse {
        var: &'static str,
        reason: String,
    },
    /// A variable was set but the value is structurally malformed
    /// (e.g. PSK list with no entries, key shorter than minimum).
    #[error("env var {var} is malformed: {reason}")]
    Malformed {
        var: &'static str,
        reason: String,
    },
    /// Failed to read a file referenced by the configuration.
    #[error("failed to read file referenced by {var} ({path}): {source}")]
    Io {
        var: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// Validated DMZ configuration. Construct via [`DmzConfig::from_env`].
pub struct DmzConfig {
    /// Public-facing listener address.
    pub public_bind: SocketAddr,
    /// Link-server listener address.
    pub link_bind: SocketAddr,

    /// Public TLS material. `None` only when [`DmzConfig::dev_mode`]
    /// is true; in that case the listener serves plain HTTP.
    pub public_tls: Option<TlsMaterial>,

    /// Link mTLS server material. Always required.
    pub link_tls: TlsMaterial,
    /// Bytes of the private CA bundle that signs internal-node link
    /// certs. The DMZ link server will only trust certs chained to
    /// this bundle; the system truststore is intentionally not used.
    pub link_ca_bundle_pem: Vec<u8>,

    /// Map of `psk_id -> key_bytes` for handshake validation.
    /// First-inserted entry is the active key; the rest are accepted
    /// during rotation.
    pub link_psks: HashMap<String, Zeroizing<Vec<u8>>>,

    /// Active HMAC key the DMZ uses to sign `x-strata-edge-*` headers.
    pub edge_hmac_key: Zeroizing<Vec<u8>>,

    /// Cluster id presented by handshaking internal nodes that this
    /// DMZ will accept. Mismatches are rejected.
    pub cluster_id: String,
    /// Logical id of this DMZ for metrics / logs.
    pub node_id: String,

    /// Cap on inbound public request bodies.
    pub public_body_limit_bytes: usize,
    /// Slow-loris header-receipt timeout.
    pub public_header_timeout_ms: u64,
    /// Per-IP rate cap (req/s). Zero = disabled.
    pub public_rate_rps: u32,
    /// Per-IP burst bucket.
    pub public_rate_burst: u32,
    /// Hard cap on concurrent in-flight requests.
    pub public_max_inflight: usize,

    /// Optional list of upstream LB CIDRs whose `X-Forwarded-For` we
    /// trust. Empty means "ignore XFF entirely; use the socket peer."
    pub trust_forwarded_from: Vec<String>,

    /// Bind address for the operator status listener. This is a
    /// **separate** socket from the public listener and is intended
    /// to be reachable only from the management network. Defaults to
    /// `127.0.0.1:9444` so a misconfigured firewall doesn't expose it.
    pub operator_bind: SocketAddr,
    /// Bearer token operators must present on the operator listener.
    /// Compared with constant-time equality. Empty = the operator
    /// listener refuses to start (we don't allow an unauthenticated
    /// operator surface).
    pub operator_token: Zeroizing<Vec<u8>>,

    /// Whether dev mode is active. Disables several production-only
    /// checks; MUST be false in production.
    pub dev_mode: bool,
}

/// Loaded TLS cert + key bytes, as PEM. The link server / public
/// listener parses these into rustls types at startup.
pub struct TlsMaterial {
    pub cert_pem: Vec<u8>,
    pub key_pem: Zeroizing<Vec<u8>>,
}

impl std::fmt::Debug for DmzConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DmzConfig")
            .field("public_bind", &self.public_bind)
            .field("link_bind", &self.link_bind)
            .field("public_tls", &self.public_tls.as_ref().map(|_| "<redacted>"))
            .field("link_tls", &"<redacted>")
            .field("link_ca_bundle_pem_len", &self.link_ca_bundle_pem.len())
            .field("link_psk_ids", &self.link_psks.keys().collect::<Vec<_>>())
            .field("edge_hmac_key", &"<redacted>")
            .field("cluster_id", &self.cluster_id)
            .field("node_id", &self.node_id)
            .field("public_body_limit_bytes", &self.public_body_limit_bytes)
            .field("public_header_timeout_ms", &self.public_header_timeout_ms)
            .field("public_rate_rps", &self.public_rate_rps)
            .field("public_rate_burst", &self.public_rate_burst)
            .field("public_max_inflight", &self.public_max_inflight)
            .field("trust_forwarded_from", &self.trust_forwarded_from)
            .field("operator_bind", &self.operator_bind)
            .field("operator_token", &"<redacted>")
            .field("dev_mode", &self.dev_mode)
            .finish()
    }
}

impl DmzConfig {
    /// Parse and validate the process environment.
    ///
    /// On success returns a fully-populated [`DmzConfig`]. On failure
    /// returns the first parse / validation error. Secrets-bearing
    /// env vars are scrubbed from `std::env` before this returns so
    /// later code can't accidentally leak them via `std::env::vars()`.
    pub fn from_env() -> Result<Self, ConfigError> {
        let dev_mode = std::env::var("STRATA_DMZ_DEV")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        let public_bind = parse_socket_addr("STRATA_DMZ_PUBLIC_BIND", DEFAULT_PUBLIC_BIND)?;
        let link_bind = parse_socket_addr("STRATA_DMZ_LINK_BIND", DEFAULT_LINK_BIND)?;

        let public_tls = match (
            std::env::var("STRATA_DMZ_PUBLIC_TLS_CERT").ok(),
            std::env::var("STRATA_DMZ_PUBLIC_TLS_KEY").ok(),
        ) {
            (Some(cert), Some(key)) => Some(TlsMaterial {
                cert_pem: read_file_var("STRATA_DMZ_PUBLIC_TLS_CERT", &cert)?,
                key_pem: Zeroizing::new(read_file_var("STRATA_DMZ_PUBLIC_TLS_KEY", &key)?),
            }),
            (None, None) if dev_mode => None,
            (None, None) => {
                return Err(ConfigError::Missing(
                    "STRATA_DMZ_PUBLIC_TLS_CERT (and STRATA_DMZ_PUBLIC_TLS_KEY)",
                ))
            }
            (Some(_), None) => return Err(ConfigError::Missing("STRATA_DMZ_PUBLIC_TLS_KEY")),
            (None, Some(_)) => return Err(ConfigError::Missing("STRATA_DMZ_PUBLIC_TLS_CERT")),
        };

        let link_tls = TlsMaterial {
            cert_pem: read_required_file_var("STRATA_DMZ_LINK_TLS_CERT")?,
            key_pem: Zeroizing::new(read_required_file_var("STRATA_DMZ_LINK_TLS_KEY")?),
        };
        let link_ca_bundle_pem = read_required_file_var("STRATA_DMZ_LINK_CA_BUNDLE")?;

        let link_psks = parse_psks_env()?;
        let edge_hmac_key = parse_b64_key_env("STRATA_DMZ_EDGE_HMAC_KEY")?;

        let cluster_id =
            std::env::var("STRATA_DMZ_CLUSTER_ID").map_err(|_| ConfigError::Missing("STRATA_DMZ_CLUSTER_ID"))?;
        if cluster_id.is_empty() {
            return Err(ConfigError::Malformed {
                var: "STRATA_DMZ_CLUSTER_ID",
                reason: "must not be empty".into(),
            });
        }

        let node_id = std::env::var("STRATA_DMZ_NODE_ID").unwrap_or_else(|_| {
            hostname::get()
                .ok()
                .and_then(|h| h.into_string().ok())
                .unwrap_or_else(|| "strata-dmz".to_string())
        });

        let public_body_limit_bytes = parse_usize_env(
            "STRATA_DMZ_PUBLIC_BODY_LIMIT_BYTES",
            DEFAULT_PUBLIC_BODY_LIMIT_BYTES,
        )?;
        let public_header_timeout_ms = parse_u64_env(
            "STRATA_DMZ_PUBLIC_HEADER_TIMEOUT_MS",
            DEFAULT_PUBLIC_HEADER_TIMEOUT_MS,
        )?;
        let public_rate_rps = parse_u32_env("STRATA_DMZ_PUBLIC_RATE_RPS", 0)?;
        let public_rate_burst = parse_u32_env(
            "STRATA_DMZ_PUBLIC_RATE_BURST",
            DEFAULT_PUBLIC_RATE_BURST,
        )?;
        let public_max_inflight = parse_usize_env(
            "STRATA_DMZ_PUBLIC_MAX_INFLIGHT",
            DEFAULT_PUBLIC_MAX_INFLIGHT,
        )?;

        let trust_forwarded_from = std::env::var("STRATA_DMZ_TRUST_FORWARDED_FROM")
            .ok()
            .map(|v| {
                v.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        let operator_bind = parse_socket_addr("STRATA_DMZ_OPERATOR_BIND", DEFAULT_OPERATOR_BIND)?;
        let operator_token_raw = std::env::var("STRATA_DMZ_OPERATOR_TOKEN")
            .map_err(|_| ConfigError::Missing("STRATA_DMZ_OPERATOR_TOKEN"))?;
        if operator_token_raw.len() < MIN_OPERATOR_TOKEN_LEN {
            return Err(ConfigError::Malformed {
                var: "STRATA_DMZ_OPERATOR_TOKEN",
                reason: format!(
                    "must be at least {MIN_OPERATOR_TOKEN_LEN} bytes"
                ),
            });
        }
        let operator_token = Zeroizing::new(operator_token_raw.into_bytes());

        // Scrub secrets from the environment so later code (and the
        // /proc/<pid>/environ dump if anyone reads it) can't observe
        // them.
        // SAFETY: setting/removing env vars is not thread-safe in
        // general, but we only run this at boot from `main`, before
        // any worker thread has been spawned.
        unsafe {
            std::env::remove_var("STRATA_DMZ_LINK_PSKS");
            std::env::remove_var("STRATA_DMZ_EDGE_HMAC_KEY");
            std::env::remove_var("STRATA_DMZ_OPERATOR_TOKEN");
        }

        Ok(DmzConfig {
            public_bind,
            link_bind,
            public_tls,
            link_tls,
            link_ca_bundle_pem,
            link_psks,
            edge_hmac_key,
            cluster_id,
            node_id,
            public_body_limit_bytes,
            public_header_timeout_ms,
            public_rate_rps,
            public_rate_burst,
            public_max_inflight,
            trust_forwarded_from,
            operator_bind,
            operator_token,
            dev_mode,
        })
    }
}

// ── Parsing helpers ──────────────────────────────────────────────────

fn parse_socket_addr(var: &'static str, default: &str) -> Result<SocketAddr, ConfigError> {
    let raw = std::env::var(var).unwrap_or_else(|_| default.to_string());
    raw.parse::<SocketAddr>().map_err(|e| ConfigError::Parse {
        var,
        reason: e.to_string(),
    })
}

fn parse_usize_env(var: &'static str, default: usize) -> Result<usize, ConfigError> {
    match std::env::var(var) {
        Err(_) => Ok(default),
        Ok(v) => v.parse::<usize>().map_err(|e| ConfigError::Parse {
            var,
            reason: e.to_string(),
        }),
    }
}

fn parse_u64_env(var: &'static str, default: u64) -> Result<u64, ConfigError> {
    match std::env::var(var) {
        Err(_) => Ok(default),
        Ok(v) => v.parse::<u64>().map_err(|e| ConfigError::Parse {
            var,
            reason: e.to_string(),
        }),
    }
}

fn parse_u32_env(var: &'static str, default: u32) -> Result<u32, ConfigError> {
    match std::env::var(var) {
        Err(_) => Ok(default),
        Ok(v) => v.parse::<u32>().map_err(|e| ConfigError::Parse {
            var,
            reason: e.to_string(),
        }),
    }
}

fn read_required_file_var(var: &'static str) -> Result<Vec<u8>, ConfigError> {
    let path = std::env::var(var).map_err(|_| ConfigError::Missing(var))?;
    read_file_var(var, &path)
}

fn read_file_var(var: &'static str, path: &str) -> Result<Vec<u8>, ConfigError> {
    std::fs::read(path).map_err(|e| ConfigError::Io {
        var,
        path: PathBuf::from(path),
        source: e,
    })
}

fn parse_b64_key_env(var: &'static str) -> Result<Zeroizing<Vec<u8>>, ConfigError> {
    let raw = std::env::var(var).map_err(|_| ConfigError::Missing(var))?;
    let bytes = B64.decode(raw.as_bytes()).map_err(|e| ConfigError::Parse {
        var,
        reason: format!("invalid base64: {e}"),
    })?;
    if bytes.len() < MIN_KEY_LEN_BYTES {
        return Err(ConfigError::Malformed {
            var,
            reason: format!(
                "decoded key length {} is shorter than minimum {} bytes",
                bytes.len(),
                MIN_KEY_LEN_BYTES
            ),
        });
    }
    Ok(Zeroizing::new(bytes))
}

fn parse_psks_env() -> Result<HashMap<String, Zeroizing<Vec<u8>>>, ConfigError> {
    const VAR: &str = "STRATA_DMZ_LINK_PSKS";
    let raw = std::env::var(VAR).map_err(|_| ConfigError::Missing(VAR))?;
    let mut out = HashMap::new();
    for entry in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let (id, b64) = entry.split_once(':').ok_or_else(|| ConfigError::Malformed {
            var: VAR,
            reason: format!("entry {entry:?} is missing 'id:base64' separator"),
        })?;
        let id = id.trim().to_string();
        if id.is_empty() {
            return Err(ConfigError::Malformed {
                var: VAR,
                reason: "empty psk id".into(),
            });
        }
        let bytes = B64
            .decode(b64.trim().as_bytes())
            .map_err(|e| ConfigError::Parse {
                var: VAR,
                reason: format!("psk id {id:?}: invalid base64: {e}"),
            })?;
        if bytes.len() < MIN_KEY_LEN_BYTES {
            return Err(ConfigError::Malformed {
                var: VAR,
                reason: format!(
                    "psk id {id:?}: decoded length {} is shorter than minimum {} bytes",
                    bytes.len(),
                    MIN_KEY_LEN_BYTES
                ),
            });
        }
        if out.insert(id.clone(), Zeroizing::new(bytes)).is_some() {
            return Err(ConfigError::Malformed {
                var: VAR,
                reason: format!("duplicate psk id {id:?}"),
            });
        }
    }
    if out.is_empty() {
        return Err(ConfigError::Malformed {
            var: VAR,
            reason: "no PSK entries parsed".into(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Env-var manipulation tests are inherently process-global. Run
    /// them serially to avoid one test's writes corrupting another.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn cleanup_env() {
        let names = [
            "STRATA_DMZ_DEV",
            "STRATA_DMZ_PUBLIC_BIND",
            "STRATA_DMZ_LINK_BIND",
            "STRATA_DMZ_PUBLIC_TLS_CERT",
            "STRATA_DMZ_PUBLIC_TLS_KEY",
            "STRATA_DMZ_LINK_TLS_CERT",
            "STRATA_DMZ_LINK_TLS_KEY",
            "STRATA_DMZ_LINK_CA_BUNDLE",
            "STRATA_DMZ_LINK_PSKS",
            "STRATA_DMZ_EDGE_HMAC_KEY",
            "STRATA_DMZ_CLUSTER_ID",
            "STRATA_DMZ_NODE_ID",
            "STRATA_DMZ_PUBLIC_BODY_LIMIT_BYTES",
            "STRATA_DMZ_PUBLIC_HEADER_TIMEOUT_MS",
            "STRATA_DMZ_PUBLIC_RATE_RPS",
            "STRATA_DMZ_PUBLIC_RATE_BURST",
            "STRATA_DMZ_PUBLIC_MAX_INFLIGHT",
            "STRATA_DMZ_TRUST_FORWARDED_FROM",
            "STRATA_DMZ_OPERATOR_BIND",
            "STRATA_DMZ_OPERATOR_TOKEN",
        ];
        // SAFETY: tests are serialised by ENV_LOCK and tests do not
        // spawn threads that read env vars.
        for n in names {
            unsafe { std::env::remove_var(n) };
        }
    }

    fn write_tmp(name: &str, contents: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("strata-dmz-cfg-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, contents).unwrap();
        p
    }

    fn b64_key(len: usize) -> String {
        B64.encode(vec![0xABu8; len])
    }

    fn set_minimum_valid_env() {
        let cert = write_tmp("link.crt", b"-----BEGIN CERTIFICATE-----\n");
        let key = write_tmp("link.key", b"-----BEGIN PRIVATE KEY-----\n");
        let ca = write_tmp("link-ca.crt", b"-----BEGIN CERTIFICATE-----\n");
        // SAFETY: tests are serialised by ENV_LOCK.
        unsafe {
            std::env::set_var("STRATA_DMZ_LINK_TLS_CERT", &cert);
            std::env::set_var("STRATA_DMZ_LINK_TLS_KEY", &key);
            std::env::set_var("STRATA_DMZ_LINK_CA_BUNDLE", &ca);
            std::env::set_var(
                "STRATA_DMZ_LINK_PSKS",
                format!("current:{}", b64_key(32)),
            );
            std::env::set_var("STRATA_DMZ_EDGE_HMAC_KEY", b64_key(32));
            std::env::set_var("STRATA_DMZ_CLUSTER_ID", "production");
            std::env::set_var(
                "STRATA_DMZ_OPERATOR_TOKEN",
                "a-32-char-or-longer-operator-token!!",
            );
            std::env::set_var("STRATA_DMZ_DEV", "1");
        }
    }

    #[test]
    fn loads_minimum_valid_env_in_dev_mode() {
        let _g = ENV_LOCK.lock().unwrap();
        cleanup_env();
        set_minimum_valid_env();

        let cfg = DmzConfig::from_env().expect("must succeed with minimum valid env");
        assert!(cfg.dev_mode);
        assert!(cfg.public_tls.is_none());
        assert_eq!(cfg.cluster_id, "production");
        assert!(cfg.link_psks.contains_key("current"));
        assert_eq!(
            cfg.public_body_limit_bytes, DEFAULT_PUBLIC_BODY_LIMIT_BYTES,
            "default body limit"
        );
        // Secrets must be scrubbed from environment after parsing.
        assert!(std::env::var("STRATA_DMZ_LINK_PSKS").is_err());
        assert!(std::env::var("STRATA_DMZ_EDGE_HMAC_KEY").is_err());
        assert!(std::env::var("STRATA_DMZ_OPERATOR_TOKEN").is_err());

        cleanup_env();
    }

    #[test]
    fn missing_cluster_id_is_rejected() {
        let _g = ENV_LOCK.lock().unwrap();
        cleanup_env();
        set_minimum_valid_env();
        unsafe {
            std::env::remove_var("STRATA_DMZ_CLUSTER_ID");
        }
        let err = DmzConfig::from_env().unwrap_err();
        assert!(
            matches!(err, ConfigError::Missing("STRATA_DMZ_CLUSTER_ID")),
            "got: {err:?}",
        );
        cleanup_env();
    }

    #[test]
    fn missing_operator_token_is_rejected() {
        let _g = ENV_LOCK.lock().unwrap();
        cleanup_env();
        set_minimum_valid_env();
        unsafe {
            std::env::remove_var("STRATA_DMZ_OPERATOR_TOKEN");
        }
        let err = DmzConfig::from_env().unwrap_err();
        assert!(
            matches!(err, ConfigError::Missing("STRATA_DMZ_OPERATOR_TOKEN")),
            "got: {err:?}",
        );
        cleanup_env();
    }

    #[test]
    fn short_operator_token_is_rejected() {
        let _g = ENV_LOCK.lock().unwrap();
        cleanup_env();
        set_minimum_valid_env();
        unsafe {
            std::env::set_var("STRATA_DMZ_OPERATOR_TOKEN", "too-short");
        }
        let err = DmzConfig::from_env().unwrap_err();
        assert!(
            matches!(
                err,
                ConfigError::Malformed {
                    var: "STRATA_DMZ_OPERATOR_TOKEN",
                    ..
                }
            ),
            "got: {err:?}",
        );
        cleanup_env();
    }

    #[test]
    fn missing_public_tls_in_prod_mode_is_rejected() {
        let _g = ENV_LOCK.lock().unwrap();
        cleanup_env();
        set_minimum_valid_env();
        unsafe {
            std::env::remove_var("STRATA_DMZ_DEV");
        }
        let err = DmzConfig::from_env().unwrap_err();
        match err {
            ConfigError::Missing(v) => {
                assert!(v.contains("STRATA_DMZ_PUBLIC_TLS_CERT"), "var was {v}");
            }
            other => panic!("expected Missing, got {other:?}"),
        }
        cleanup_env();
    }

    #[test]
    fn psk_too_short_is_rejected() {
        let _g = ENV_LOCK.lock().unwrap();
        cleanup_env();
        set_minimum_valid_env();
        unsafe {
            std::env::set_var(
                "STRATA_DMZ_LINK_PSKS",
                format!("current:{}", b64_key(8)),
            );
        }
        let err = DmzConfig::from_env().unwrap_err();
        assert!(matches!(err, ConfigError::Malformed { var: "STRATA_DMZ_LINK_PSKS", .. }), "got: {err:?}");
        cleanup_env();
    }

    #[test]
    fn psk_duplicate_id_is_rejected() {
        let _g = ENV_LOCK.lock().unwrap();
        cleanup_env();
        set_minimum_valid_env();
        unsafe {
            std::env::set_var(
                "STRATA_DMZ_LINK_PSKS",
                format!("a:{},a:{}", b64_key(32), b64_key(32)),
            );
        }
        let err = DmzConfig::from_env().unwrap_err();
        assert!(matches!(err, ConfigError::Malformed { var: "STRATA_DMZ_LINK_PSKS", .. }), "got: {err:?}");
        cleanup_env();
    }

    #[test]
    fn psk_missing_separator_is_rejected() {
        let _g = ENV_LOCK.lock().unwrap();
        cleanup_env();
        set_minimum_valid_env();
        unsafe {
            std::env::set_var("STRATA_DMZ_LINK_PSKS", b64_key(32));
        }
        let err = DmzConfig::from_env().unwrap_err();
        assert!(matches!(err, ConfigError::Malformed { var: "STRATA_DMZ_LINK_PSKS", .. }), "got: {err:?}");
        cleanup_env();
    }

    #[test]
    fn edge_key_too_short_is_rejected() {
        let _g = ENV_LOCK.lock().unwrap();
        cleanup_env();
        set_minimum_valid_env();
        unsafe {
            std::env::set_var("STRATA_DMZ_EDGE_HMAC_KEY", b64_key(8));
        }
        let err = DmzConfig::from_env().unwrap_err();
        assert!(matches!(err, ConfigError::Malformed { var: "STRATA_DMZ_EDGE_HMAC_KEY", .. }), "got: {err:?}");
        cleanup_env();
    }

    #[test]
    fn invalid_socket_addr_is_rejected() {
        let _g = ENV_LOCK.lock().unwrap();
        cleanup_env();
        set_minimum_valid_env();
        unsafe {
            std::env::set_var("STRATA_DMZ_PUBLIC_BIND", "not-a-socket-addr");
        }
        let err = DmzConfig::from_env().unwrap_err();
        assert!(matches!(err, ConfigError::Parse { var: "STRATA_DMZ_PUBLIC_BIND", .. }), "got: {err:?}");
        cleanup_env();
    }

    #[test]
    fn debug_redacts_secrets() {
        let _g = ENV_LOCK.lock().unwrap();
        cleanup_env();
        set_minimum_valid_env();
        let cfg = DmzConfig::from_env().unwrap();
        let s = format!("{cfg:?}");
        assert!(!s.contains("rust"), "debug output unexpectedly clean: {s}");
        // Ensure no decoded secret bytes leak. The dummy key is all
        // 0xAB; any "ab" sequence in the redacted debug string would
        // be suspicious.
        assert!(s.contains("<redacted>"));
        cleanup_env();
    }

    #[test]
    fn trust_forwarded_from_parses_csv() {
        let _g = ENV_LOCK.lock().unwrap();
        cleanup_env();
        set_minimum_valid_env();
        unsafe {
            std::env::set_var(
                "STRATA_DMZ_TRUST_FORWARDED_FROM",
                "10.0.0.0/8, 192.168.0.0/16,",
            );
        }
        let cfg = DmzConfig::from_env().unwrap();
        assert_eq!(
            cfg.trust_forwarded_from,
            vec!["10.0.0.0/8".to_string(), "192.168.0.0/16".to_string()]
        );
        cleanup_env();
    }
}
