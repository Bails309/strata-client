//! VDI desktop container support — shipped in v0.30.0.
//!
//! This module is the **pure-logic foundation** for the `vdi` protocol:
//! typed views over `connections.extra`, image whitelist parsing,
//! deterministic container naming for reuse, and the [`VdiDriver`]
//! trait. The actual Docker driver (`bollard`) and idle reaper are
//! intentionally deferred to a follow-up commit because they pull in
//! `bollard` + the docker.sock mount, both of which need a security
//! review (mounting `/var/run/docker.sock` grants host root to the
//! backend container — the docker-compose change must ship with an
//! explicit operator opt-in).
//!
//! Everything in this file is synchronous, side-effect-free, and unit
//! testable without docker.

use std::collections::BTreeMap;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Default port the VDI container exposes for xrdp. Mirrors rustguac.
pub const VDI_DEFAULT_PORT: u16 = 3389;

/// Default idle timeout (minutes) before the reaper destroys an unused
/// container. Tunable per-connection via `extra.idle_timeout_mins`.
#[allow(dead_code)]
pub const VDI_DEFAULT_IDLE_TIMEOUT_MINS: u32 = 30;

/// Container-name prefix. Keeps Strata-managed containers easy to
/// distinguish from operator-deployed ones during `docker ps`.
pub const VDI_CONTAINER_PREFIX: &str = "strata-vdi";

// ─────────────────────────────────────────────────────────────────────
// Audit event action_type strings (stable operator-facing contract)
// ─────────────────────────────────────────────────────────────────────

// `#[allow(dead_code)]` on the audit/settings surface: the constants
// freeze the operator-facing contract ahead of the deferred runtime
// (DockerVdiDriver, idle reaper) that consumes them.

/// Emitted when a VDI container is created or reused. Details:
/// `{connection_id, user_id, container_name, image, reused}`.
#[allow(dead_code)]
pub const AUDIT_VDI_CONTAINER_ENSURE: &str = "vdi.container.ensure";

/// Emitted when a VDI container is destroyed (logout / idle timeout /
/// orphan reaper). Details: `{container_name, reason}`.
pub const AUDIT_VDI_CONTAINER_DESTROY: &str = "vdi.container.destroy";

/// Emitted when a connection's `extra.image` fails the operator
/// whitelist. Details: `{connection_id, image}`. Surfaces SSRF /
/// supply-chain attack attempts; never carries the image digest because
/// the rejection happens before any registry pull.
pub const AUDIT_VDI_IMAGE_REJECTED: &str = "vdi.image.rejected";

// ─────────────────────────────────────────────────────────────────────
// system_settings keys
// ─────────────────────────────────────────────────────────────────────

/// Newline-/comma-separated whitelist of permitted container images.
pub const SETTING_VDI_IMAGE_WHITELIST: &str = "vdi_image_whitelist";

/// Filesystem base for persistent-home bind mounts. Each connection
/// receives a `<home_base>/<container_name>` directory.
#[allow(dead_code)]
pub const SETTING_VDI_HOME_BASE: &str = "vdi_home_base";

/// Per-replica concurrency cap on simultaneous VDI containers. Stored
/// as a stringified `u32`; missing ⇒ unbounded (operator's responsibility).
#[allow(dead_code)]
pub const SETTING_MAX_VDI_CONTAINERS: &str = "max_vdi_containers";

// ── connections.extra typed view ───────────────────────────────────

/// Typed projection over the JSONB `connections.extra` column for `vdi`
/// connections. All fields are optional in the JSON; the parser is
/// lenient (unknown keys are ignored, blank strings collapse to
/// `None`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct VdiConfig {
    /// Container image to launch (e.g. `strata/vdi-ubuntu:latest`).
    /// Validated against the operator-supplied whitelist before any
    /// container is created.
    pub image: Option<String>,

    /// CPU limit in fractional cores (Docker `--cpus`). `None` ⇒ unbounded.
    pub cpu_limit: Option<f32>,

    /// Memory limit in megabytes (Docker `--memory`). `None` ⇒ unbounded.
    pub memory_limit_mb: Option<u32>,

    /// Idle timeout in minutes before the reaper destroys an unused
    /// container. Defaults to [`VDI_DEFAULT_IDLE_TIMEOUT_MINS`].
    pub idle_timeout_mins: Option<u32>,

    /// Operator-supplied environment variables injected into the
    /// container. Strata always injects `VDI_USERNAME` / `VDI_PASSWORD`
    /// at runtime — those keys are stripped from this map at read time
    /// to prevent accidental override.
    pub env_vars: BTreeMap<String, String>,

    /// When true, the reaper preserves the user's home volume between
    /// sessions (bind mount under `home_base`). When false, the home
    /// is destroyed with the container.
    pub persistent_home: bool,
}

impl VdiConfig {
    /// Parse a `connections.extra` JSON value into a typed config.
    /// Tolerant of missing keys and unexpected shapes — invalid entries
    /// are dropped rather than rejecting the whole config so a single
    /// stale field can never break the connection editor.
    pub fn from_extra(extra: &serde_json::Value) -> Self {
        let obj = match extra.as_object() {
            Some(o) => o,
            None => return Self::default(),
        };

        let image = obj
            .get("image")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);

        let cpu_limit = obj.get("cpu_limit").and_then(|v| match v {
            serde_json::Value::Number(n) => n.as_f64().map(|f| f as f32),
            serde_json::Value::String(s) => s.trim().parse::<f32>().ok(),
            _ => None,
        });

        let memory_limit_mb = obj.get("memory_limit_mb").and_then(|v| match v {
            serde_json::Value::Number(n) => n.as_u64().map(|u| u as u32),
            serde_json::Value::String(s) => s.trim().parse::<u32>().ok(),
            _ => None,
        });

        let idle_timeout_mins = obj.get("idle_timeout_mins").and_then(|v| match v {
            serde_json::Value::Number(n) => n.as_u64().map(|u| u as u32),
            serde_json::Value::String(s) => s.trim().parse::<u32>().ok(),
            _ => None,
        });

        let mut env_vars = BTreeMap::new();
        if let Some(serde_json::Value::Object(map)) = obj.get("env_vars") {
            for (k, v) in map {
                let key = k.trim();
                // Reserved injection keys — never honour from extra.
                if key.is_empty() || key == "VDI_USERNAME" || key == "VDI_PASSWORD" {
                    continue;
                }
                if let Some(val) = v.as_str() {
                    env_vars.insert(key.to_owned(), val.to_owned());
                }
            }
        }

        let persistent_home = obj
            .get("persistent_home")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        Self {
            image,
            cpu_limit,
            memory_limit_mb,
            idle_timeout_mins,
            env_vars,
            persistent_home,
        }
    }

    /// Returns the resolved idle timeout in minutes, falling back to
    /// the module default when unset.
    #[allow(dead_code)]
    pub fn effective_idle_timeout_mins(&self) -> u32 {
        self.idle_timeout_mins
            .filter(|m| *m > 0)
            .unwrap_or(VDI_DEFAULT_IDLE_TIMEOUT_MINS)
    }
}

// ── Image whitelist ────────────────────────────────────────────────

/// Operator-managed list of container images permitted as the `image`
/// field of a `vdi` connection. Backed by the `vdi_image_whitelist`
/// row in `system_settings` (newline- or comma-separated).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ImageWhitelist {
    images: Vec<String>,
}

impl ImageWhitelist {
    /// Parse a raw setting value (newline- or comma-separated). Blank
    /// entries and lines starting with `#` are ignored so operators
    /// can keep documented allow-lists.
    pub fn parse(raw: &str) -> Self {
        let images = raw
            .split(['\n', ','])
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.starts_with('#'))
            .map(str::to_owned)
            .collect();
        Self { images }
    }

    /// Returns true when `image` matches an entry exactly. Image
    /// matching is intentionally **strict**: there is no tag-glob or
    /// digest substitution because that would let a connection silently
    /// pin to a different artifact than the operator approved.
    pub fn is_allowed(&self, image: &str) -> bool {
        let candidate = image.trim();
        !candidate.is_empty() && self.images.iter().any(|i| i == candidate)
    }

    /// Snapshot of the whitelist for the admin API.
    pub fn images(&self) -> &[String] {
        &self.images
    }

    /// Number of whitelisted images.
    pub fn len(&self) -> usize {
        self.images.len()
    }

    /// True when no images are whitelisted (i.e. VDI is effectively
    /// disabled).
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.images.is_empty()
    }
}

// ── Container naming ───────────────────────────────────────────────

/// Deterministic container name for a (connection, user) pair so that
/// re-opening a connection reuses the same container — the basis of
/// the persistent-home story. Names are bounded to 63 chars to satisfy
/// the Docker name regex.
pub fn container_name_for(connection_id: Uuid, user_id: Uuid) -> String {
    let conn = connection_id.simple().to_string();
    let user = user_id.simple().to_string();
    format!("{VDI_CONTAINER_PREFIX}-{}-{}", &conn[..12], &user[..12])
}

// ── Env-var injection ──────────────────────────────────────────────

/// Build the final environment for the container by layering Strata's
/// authoritative credentials over the operator-supplied vars. Reserved
/// keys (`VDI_USERNAME`, `VDI_PASSWORD`) always come from the runtime
/// session, never from `extra`.
pub fn vdi_env_vars(
    username: &str,
    password: &str,
    extra: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = extra
        .iter()
        .filter(|(k, _)| k.as_str() != "VDI_USERNAME" && k.as_str() != "VDI_PASSWORD")
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    env.insert("VDI_USERNAME".to_owned(), username.to_owned());
    env.insert("VDI_PASSWORD".to_owned(), password.to_owned());
    env
}

// ── Ephemeral credentials ──────────────────────────────────────────

/// Default fallback for sanitised usernames that come back empty
/// (e.g. an entirely non-ASCII Strata username). Must satisfy the
/// POSIX login-name regex `^[a-z_][a-z0-9_-]{0,31}$`.
pub const VDI_FALLBACK_USERNAME: &str = "vdi_user";

/// Generated password length. 24 chars × ~6 bits of entropy per
/// alphanumeric char ≈ 144 bits — comfortably above what xrdp's PAM
/// module will see, and short enough to fit comfortably on a single
/// command line if an operator ever has to debug it.
pub const VDI_GENERATED_PASSWORD_LEN: usize = 24;

/// Sanitise an arbitrary Strata username into a POSIX-safe Linux
/// login name. Lower-cases everything, replaces any non-`[a-z0-9_-]`
/// character with `_`, ensures the first character is alphabetic or
/// `_` (prefixing `u_` if needed), trims to 32 chars, and falls back
/// to `VDI_FALLBACK_USERNAME` if the result would be empty.
///
/// Mirrors the regex enforced by the sample image's entrypoint
/// (`^[a-z_][a-z0-9_-]{0,31}$`); the entrypoint validation is
/// defence-in-depth — we always sanitise here first.
pub fn sanitise_posix_username(input: &str) -> String {
    let mut out: String = input
        .chars()
        .map(|c| c.to_ascii_lowercase())
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() {
        return VDI_FALLBACK_USERNAME.to_owned();
    }
    let first = out.chars().next().unwrap();
    if !(first.is_ascii_lowercase() || first == '_') {
        out.insert_str(0, "u_");
    }
    if out.len() > 32 {
        out.truncate(32);
    }
    out
}

/// Generate ephemeral per-session VDI credentials. The username is
/// derived from the Strata user's username (sanitised to POSIX) so
/// that `whoami` inside the session matches the operator the user
/// already authenticated as; the password is freshly random.
///
/// Both ends of the auth chain are Strata-controlled (the entrypoint
/// materialises the local account from `VDI_USERNAME`/`VDI_PASSWORD`,
/// guacd authenticates against xrdp with the same pair), so the
/// password never has to be stable or memorable — it's used once per
/// container lifecycle.
pub fn ephemeral_credentials(strata_username: &str) -> (String, String) {
    use rand::{distr::Alphanumeric, RngExt};
    let username = sanitise_posix_username(strata_username);
    let password: String = rand::rng()
        .sample_iter(&Alphanumeric)
        .take(VDI_GENERATED_PASSWORD_LEN)
        .map(char::from)
        .collect();
    (username, password)
}

// ── Disconnect classification ──────────────────────────────────────

/// Why a VDI session ended. Drives the reaper decision (logout ⇒
/// destroy container; tab-close ⇒ keep for reuse within the idle
/// window).
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisconnectReason {
    /// User explicitly logged out from inside the desktop session.
    Logout,
    /// Browser tab/window closed without a logout.
    TabClose,
    /// Idle timeout fired server-side.
    IdleTimeout,
    /// Anything else (network drop, server restart, error).
    Other,
}

impl DisconnectReason {
    /// xrdp reports a numeric reason on the WTSChannel disconnect
    /// frame. Mirrors the rustguac mapping exactly so behaviour is
    /// identical end-to-end.
    #[allow(dead_code)]
    pub fn from_xrdp_code(code: i32) -> Self {
        match code {
            0 => Self::Logout,
            // 1 = remote disconnect (the user closed the tab)
            1 => Self::TabClose,
            // 2 = idle/inactivity (server-initiated)
            2 => Self::IdleTimeout,
            _ => Self::Other,
        }
    }

    /// Whether the reaper should destroy the container immediately.
    /// Tab-closes are kept around so the user can resume; logouts and
    /// idle timeouts release the container.
    #[allow(dead_code)]
    pub fn should_destroy_immediately(self) -> bool {
        matches!(self, Self::Logout | Self::IdleTimeout)
    }
}

// ── Driver trait ───────────────────────────────────────────────────

/// Spec for a VDI backend. Implemented by `DockerVdiDriver` (deferred
/// to a follow-up commit) and by `NoopVdiDriver` for unit tests.
#[async_trait]
pub trait VdiDriver: Send + Sync {
    /// Ensure a container exists and is running for the given (connection,
    /// user). Returns the host:port the tunnel layer should connect to
    /// (typically `127.0.0.1:<ephemeral>` from `docker run -P`).
    async fn ensure_container(
        &self,
        connection_id: Uuid,
        user_id: Uuid,
        spec: &VdiSpawnSpec,
    ) -> Result<VdiEndpoint, VdiError>;

    /// Destroy a container by deterministic name.
    async fn destroy_container(&self, name: &str) -> Result<(), VdiError>;

    /// List Strata-managed VDI container names. Used by the reaper to
    /// detect orphans across restarts.
    async fn list_managed_containers(&self) -> Result<Vec<String>, VdiError>;

    /// List Strata-managed VDI containers with rich metadata, suitable
    /// for the admin "active desktops" UI (rustguac parity item A11).
    /// Default impl returns an empty vec so existing test fakes
    /// (`NoopVdiDriver`) don't have to implement it.
    async fn list_managed_containers_detail(&self) -> Result<Vec<ManagedContainer>, VdiError> {
        Ok(Vec::new())
    }

    /// Liveness check on the underlying container backend (rustguac
    /// parity item A12). Returns `Ok(())` when the backend is
    /// reachable. Used by `/api/admin/vdi/images` and the health probe
    /// to differentiate "driver unavailable" from other errors.
    /// Default impl returns `Ok(())` for stub drivers.
    async fn health_check(&self) -> Result<(), VdiError> {
        Ok(())
    }
}

/// Rich metadata for a Strata-managed VDI container — surfaced by the
/// admin "active desktops" UI. Mirrors rustguac's `ManagedContainer`
/// shape (rustguac parity item A11) with Strata's UUID-based identity
/// fields.
#[derive(Debug, Clone, Serialize)]
pub struct ManagedContainer {
    pub container_id: String,
    pub container_name: String,
    /// Strata connection UUID (from the `strata.connection_id` label).
    /// Optional because pre-A10 containers won't have it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<Uuid>,
    /// Strata user UUID (from the `strata.user_id` label).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<Uuid>,
    /// Image the container was launched from (from the `strata.image`
    /// label, falling back to the bollard `image` field).
    pub image: String,
    /// True when the container is currently running.
    pub running: bool,
}

#[derive(Debug, Clone)]
#[allow(dead_code)] // Surface for the deferred DockerVdiDriver implementation.
pub struct VdiSpawnSpec {
    pub image: String,
    pub username: String,
    pub password: String,
    pub env: BTreeMap<String, String>,
    pub cpu_limit: Option<f32>,
    pub memory_limit_mb: Option<u32>,
    pub persistent_home: bool,
    pub home_base: std::path::PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VdiEndpoint {
    pub host: String,
    pub port: u16,
    pub container_name: String,
}

#[derive(Debug, thiserror::Error)]
#[allow(dead_code)] // Surface for the deferred DockerVdiDriver implementation.
pub enum VdiError {
    #[error("image '{0}' is not in the operator whitelist")]
    ImageNotAllowed(String),
    #[error("docker driver not available: {0}")]
    DriverUnavailable(String),
    #[error("docker error: {0}")]
    Docker(String),
    #[error("invalid env var: {0}")]
    InvalidEnv(String),
    #[error("internal: {0}")]
    Internal(String),
}

/// Stub driver returned in environments where Docker is not mounted.
/// Every `ensure_container` call fails fast with a clear message so
/// the API surface can return a 503 rather than panicking.
#[derive(Debug, Clone, Default)]
pub struct NoopVdiDriver;

#[async_trait]
impl VdiDriver for NoopVdiDriver {
    async fn ensure_container(
        &self,
        _connection_id: Uuid,
        _user_id: Uuid,
        _spec: &VdiSpawnSpec,
    ) -> Result<VdiEndpoint, VdiError> {
        Err(VdiError::DriverUnavailable(
            "VDI driver not configured — mount /var/run/docker.sock and \
             enable the docker driver in system settings"
                .to_owned(),
        ))
    }

    async fn destroy_container(&self, _name: &str) -> Result<(), VdiError> {
        Ok(())
    }

    async fn list_managed_containers(&self) -> Result<Vec<String>, VdiError> {
        Ok(Vec::new())
    }
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn config_from_full_extra_round_trip() {
        let extra = json!({
            "image": "strata/vdi-ubuntu:latest",
            "cpu_limit": 2.0,
            "memory_limit_mb": 4096,
            "idle_timeout_mins": 45,
            "env_vars": { "LANG": "en_GB.UTF-8", "TZ": "Europe/London" },
            "persistent_home": true,
        });
        let cfg = VdiConfig::from_extra(&extra);
        assert_eq!(cfg.image.as_deref(), Some("strata/vdi-ubuntu:latest"));
        assert_eq!(cfg.cpu_limit, Some(2.0));
        assert_eq!(cfg.memory_limit_mb, Some(4096));
        assert_eq!(cfg.idle_timeout_mins, Some(45));
        assert_eq!(
            cfg.env_vars.get("LANG").map(String::as_str),
            Some("en_GB.UTF-8")
        );
        assert!(cfg.persistent_home);
    }

    #[test]
    fn config_from_string_typed_numbers() {
        // Some clients (form posts) send numbers as strings.
        let extra = json!({
            "image": "x:y",
            "cpu_limit": "1.5",
            "memory_limit_mb": "2048",
            "idle_timeout_mins": "10",
        });
        let cfg = VdiConfig::from_extra(&extra);
        assert_eq!(cfg.cpu_limit, Some(1.5));
        assert_eq!(cfg.memory_limit_mb, Some(2048));
        assert_eq!(cfg.idle_timeout_mins, Some(10));
    }

    #[test]
    fn config_strips_reserved_env_keys() {
        let extra = json!({
            "image": "x:y",
            "env_vars": {
                "VDI_USERNAME": "attacker",
                "VDI_PASSWORD": "leaked",
                "LANG": "en_GB.UTF-8",
                "": "blank-key-ignored",
            },
        });
        let cfg = VdiConfig::from_extra(&extra);
        assert!(!cfg.env_vars.contains_key("VDI_USERNAME"));
        assert!(!cfg.env_vars.contains_key("VDI_PASSWORD"));
        assert!(!cfg.env_vars.contains_key(""));
        assert_eq!(
            cfg.env_vars.get("LANG").map(String::as_str),
            Some("en_GB.UTF-8")
        );
    }

    #[test]
    fn config_blank_image_collapses_to_none() {
        let cfg = VdiConfig::from_extra(&json!({ "image": "   " }));
        assert!(cfg.image.is_none());
    }

    #[test]
    fn config_default_when_extra_not_object() {
        assert_eq!(VdiConfig::from_extra(&json!(null)), VdiConfig::default());
        assert_eq!(VdiConfig::from_extra(&json!("nope")), VdiConfig::default());
    }

    #[test]
    fn effective_idle_timeout_falls_back_when_zero_or_unset() {
        let mut cfg = VdiConfig::default();
        assert_eq!(
            cfg.effective_idle_timeout_mins(),
            VDI_DEFAULT_IDLE_TIMEOUT_MINS
        );
        cfg.idle_timeout_mins = Some(0);
        assert_eq!(
            cfg.effective_idle_timeout_mins(),
            VDI_DEFAULT_IDLE_TIMEOUT_MINS
        );
        cfg.idle_timeout_mins = Some(15);
        assert_eq!(cfg.effective_idle_timeout_mins(), 15);
    }

    #[test]
    fn whitelist_parse_handles_separators_and_comments() {
        let raw = "strata/a:1\nstrata/b:2, strata/c:3\n# comment line\n\nstrata/d:4";
        let wl = ImageWhitelist::parse(raw);
        assert_eq!(wl.len(), 4);
        assert!(wl.is_allowed("strata/a:1"));
        assert!(wl.is_allowed("strata/d:4"));
        assert!(!wl.is_allowed("strata/x:9"));
    }

    #[test]
    fn whitelist_empty_denies_everything() {
        let wl = ImageWhitelist::parse("");
        assert!(wl.is_empty());
        assert!(!wl.is_allowed("strata/anything:latest"));
    }

    #[test]
    fn whitelist_blank_image_is_denied_even_when_listed_blank() {
        // Defence in depth: filter out blank entries from the parser.
        let wl = ImageWhitelist::parse("\n\n,,\n");
        assert!(wl.is_empty());
        assert!(!wl.is_allowed(""));
    }

    #[test]
    fn whitelist_no_glob_matching() {
        // Strict equality only — pinning is a security feature.
        let wl = ImageWhitelist::parse("strata/vdi:1.0");
        assert!(wl.is_allowed("strata/vdi:1.0"));
        assert!(!wl.is_allowed("strata/vdi:1.0.1"));
        assert!(!wl.is_allowed("strata/vdi:latest"));
        assert!(!wl.is_allowed("strata/vdi"));
    }

    #[test]
    fn container_name_is_deterministic_and_bounded() {
        let conn = Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();
        let user = Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap();
        let a = container_name_for(conn, user);
        let b = container_name_for(conn, user);
        assert_eq!(a, b);
        assert!(a.starts_with(VDI_CONTAINER_PREFIX));
        assert!(a.len() <= 63, "docker name limit (got {} chars)", a.len());
    }

    #[test]
    fn container_name_differs_per_user() {
        let conn = Uuid::new_v4();
        let u1 = Uuid::new_v4();
        let u2 = Uuid::new_v4();
        assert_ne!(container_name_for(conn, u1), container_name_for(conn, u2));
    }

    #[test]
    fn vdi_env_vars_overrides_reserved_keys_with_runtime_values() {
        let mut extra = BTreeMap::new();
        extra.insert("LANG".to_owned(), "en_GB.UTF-8".to_owned());
        // Even if extra somehow smuggled the reserved keys in, we must override.
        extra.insert("VDI_USERNAME".to_owned(), "attacker".to_owned());
        extra.insert("VDI_PASSWORD".to_owned(), "leaked".to_owned());
        let env = vdi_env_vars("alice", "s3cret", &extra);
        assert_eq!(env.get("VDI_USERNAME").map(String::as_str), Some("alice"));
        assert_eq!(env.get("VDI_PASSWORD").map(String::as_str), Some("s3cret"));
        assert_eq!(env.get("LANG").map(String::as_str), Some("en_GB.UTF-8"));
    }

    #[test]
    fn disconnect_reason_classification() {
        assert_eq!(
            DisconnectReason::from_xrdp_code(0),
            DisconnectReason::Logout
        );
        assert_eq!(
            DisconnectReason::from_xrdp_code(1),
            DisconnectReason::TabClose
        );
        assert_eq!(
            DisconnectReason::from_xrdp_code(2),
            DisconnectReason::IdleTimeout
        );
        assert_eq!(
            DisconnectReason::from_xrdp_code(99),
            DisconnectReason::Other
        );
    }

    #[test]
    fn disconnect_reason_destroy_decision() {
        assert!(DisconnectReason::Logout.should_destroy_immediately());
        assert!(DisconnectReason::IdleTimeout.should_destroy_immediately());
        assert!(!DisconnectReason::TabClose.should_destroy_immediately());
        assert!(!DisconnectReason::Other.should_destroy_immediately());
    }

    #[tokio::test]
    async fn noop_driver_fails_ensure_with_clear_message() {
        let driver = NoopVdiDriver;
        let spec = VdiSpawnSpec {
            image: "x:y".to_owned(),
            username: "u".to_owned(),
            password: "p".to_owned(),
            env: BTreeMap::new(),
            cpu_limit: None,
            memory_limit_mb: None,
            persistent_home: false,
            home_base: std::path::PathBuf::from("/tmp"),
        };
        let err = driver
            .ensure_container(Uuid::new_v4(), Uuid::new_v4(), &spec)
            .await
            .unwrap_err();
        assert!(matches!(err, VdiError::DriverUnavailable(_)));
        assert!(driver.list_managed_containers().await.unwrap().is_empty());
        assert!(driver.destroy_container("anything").await.is_ok());
    }

    // ── Ephemeral credentials ─────────────────────────────────

    #[test]
    fn sanitise_posix_username_lowercases_and_strips_unsafe_chars() {
        assert_eq!(sanitise_posix_username("Alice.Smith"), "alice_smith");
        assert_eq!(
            sanitise_posix_username("user@example.com"),
            "user_example_com"
        );
        assert_eq!(sanitise_posix_username("ALICE"), "alice");
    }

    #[test]
    fn sanitise_posix_username_prefixes_when_first_char_is_digit() {
        // Pure-digit usernames would be rejected by the entrypoint regex;
        // prepend `u_` so they're valid POSIX login names.
        let out = sanitise_posix_username("1bob");
        assert!(out.starts_with("u_"));
        assert_eq!(out, "u_1bob");
    }

    #[test]
    fn sanitise_posix_username_truncates_to_32_chars() {
        let long = "a".repeat(80);
        let out = sanitise_posix_username(&long);
        assert_eq!(out.len(), 32);
        assert!(out.chars().all(|c| c == 'a'));
    }

    #[test]
    fn sanitise_posix_username_falls_back_when_empty() {
        assert_eq!(sanitise_posix_username(""), VDI_FALLBACK_USERNAME);
    }

    #[test]
    fn ephemeral_credentials_returns_safe_username_and_random_password() {
        let (u1, p1) = ephemeral_credentials("Alice.Smith");
        let (u2, p2) = ephemeral_credentials("Alice.Smith");
        // Username is deterministic per Strata user — we want
        // `whoami` inside the session to match across reconnects.
        assert_eq!(u1, "alice_smith");
        assert_eq!(u2, "alice_smith");
        // POSIX login regex compliance: ^[a-z_][a-z0-9_-]{0,31}$
        assert!(u1.len() <= 32);
        let mut chars = u1.chars();
        let first = chars.next().unwrap();
        assert!(first.is_ascii_lowercase() || first == '_');
        assert!(chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-'));
        // Password is fresh per call and the documented length.
        assert_eq!(p1.len(), VDI_GENERATED_PASSWORD_LEN);
        assert_eq!(p2.len(), VDI_GENERATED_PASSWORD_LEN);
        assert_ne!(p1, p2, "passwords must be regenerated each call");
        assert!(p1.chars().all(|c| c.is_ascii_alphanumeric()));
    }
}
