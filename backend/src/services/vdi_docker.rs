//! Live Docker driver for the `vdi` connection protocol — shipped in
//! v0.30.0.
//!
//! ## Threat model
//!
//! Mounting `/var/run/docker.sock` into the Strata backend container
//! grants the backend root on the host. This driver is therefore only
//! constructed when the operator explicitly opts in via the
//! `docker-compose.vdi.yml` overlay (`docker compose -f docker-compose.yml
//! -f docker-compose.vdi.yml up -d`) which carries an `⚠️ HOST-ROOT MOUNT`
//! warning block at the top of that file.
//!
//! When the env var `STRATA_VDI_ENABLED` is unset (the default for
//! plain `docker compose up -d`), [`crate::services::vdi::NoopVdiDriver`]
//! is returned instead and every `ensure_container` call fails fast
//! with a clear `DriverUnavailable` message.
//!
//! ## Behaviour
//!
//! * `ensure_container` is idempotent. The deterministic name
//!   produced by [`super::vdi::container_name_for`] lets re-opens of
//!   the same `(connection, user)` pair land on the same container
//!   so persistent home and (when the user has logged out cleanly,
//!   the reaper has destroyed the container; when the tab merely
//!   closed, the reaper retains it) ephemeral state are preserved.
//! * Containers are placed on the same docker network as the backend
//!   (default: `guac-internal`) so the tunnel layer connects via
//!   `<container_name>:3389` — no host port publishing, no
//!   `host.docker.internal` hop.
//! * Every Strata-managed container carries the labels
//!   `strata.managed=true`, `strata.connection_id=<uuid>`,
//!   `strata.user_id=<uuid>`. The reaper uses the first to detect
//!   orphans across backend restarts.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bollard::container::{
    Config, CreateContainerOptions, ListContainersOptions, NetworkingConfig,
    RemoveContainerOptions, StartContainerOptions, StopContainerOptions,
};
use bollard::exec::{CreateExecOptions, StartExecOptions};
use bollard::models::{
    EndpointSettings, HostConfig, HostConfigLogConfig, RestartPolicy, RestartPolicyNameEnum,
};
use bollard::Docker;
use uuid::Uuid;

use super::vdi::{
    container_name_for, vdi_env_vars, ManagedContainer, VdiDriver, VdiEndpoint, VdiError,
    VdiSpawnSpec, VDI_DEFAULT_PORT,
};

/// Default docker network the backend places spawned VDI containers on.
/// Mirrors the network name used by the rest of the compose stack.
pub const DEFAULT_VDI_NETWORK: &str = "guac-internal";

/// Label keys identifying Strata-managed VDI containers. `strata.managed`
/// is the orphan-detection key the reaper filters on.
const LABEL_MANAGED: &str = "strata.managed";
const LABEL_CONNECTION_ID: &str = "strata.connection_id";
const LABEL_USER_ID: &str = "strata.user_id";
/// Image label — set so the image-change detector (rustguac parity
/// item A5, deferred to the runtime) can compare without an inspect
/// call.
const LABEL_IMAGE: &str = "strata.image";

/// Live Docker driver. Owned by `AppState` as `Arc<dyn VdiDriver>`.
#[derive(Clone)]
pub struct DockerVdiDriver {
    docker: Arc<Docker>,
    /// Docker network the spawned containers join. Must be reachable
    /// from the backend container (typically the same network the
    /// backend itself runs on).
    network: String,
}

impl std::fmt::Debug for DockerVdiDriver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DockerVdiDriver")
            .field("network", &self.network)
            .finish_non_exhaustive()
    }
}

impl DockerVdiDriver {
    /// Connect to docker via the default unix socket
    /// (`/var/run/docker.sock`) and place spawned containers on
    /// [`DEFAULT_VDI_NETWORK`].
    ///
    /// Returns an error when the socket isn't mounted or the docker
    /// daemon refuses the ping — caller should fall back to
    /// [`super::vdi::NoopVdiDriver`].
    #[allow(dead_code)]
    pub fn connect_default() -> Result<Self, VdiError> {
        Self::connect(DEFAULT_VDI_NETWORK)
    }

    /// Connect to docker via the default unix socket and place spawned
    /// containers on `network`.
    pub fn connect(network: &str) -> Result<Self, VdiError> {
        let docker = Docker::connect_with_defaults()
            .map_err(|e| VdiError::DriverUnavailable(format!("docker connect failed: {e}")))?;
        Ok(Self {
            docker: Arc::new(docker),
            network: network.to_owned(),
        })
    }

    /// Wrap an already-built `bollard::Docker`. Used by tests with a
    /// faked transport.
    #[cfg(test)]
    pub fn from_docker(docker: Docker, network: impl Into<String>) -> Self {
        Self {
            docker: Arc::new(docker),
            network: network.into(),
        }
    }

    /// Build the bollard `Config` for a fresh container. Pure function —
    /// extracted so the env-var, label, mount, and resource-limit logic
    /// is unit-testable without a docker daemon.
    ///
    /// Returns `Err(VdiError::InvalidEnv)` when an operator-supplied
    /// env var has an invalid name (non `[A-Za-z0-9_]`) or a value
    /// containing a newline. This mirrors rustguac's validation
    /// (parity item A4) and closes an env-injection vector where a
    /// crafted value like `FOO=bar\nLD_PRELOAD=/tmp/x.so` would inject
    /// a second variable.
    pub(crate) fn build_create_config(
        spec: &VdiSpawnSpec,
        connection_id: Uuid,
        user_id: Uuid,
        network: &str,
    ) -> Result<Config<String>, VdiError> {
        // Validate operator-supplied env keys + values BEFORE layering
        // in `VDI_USERNAME` / `VDI_PASSWORD` (which are runtime-trusted).
        for (k, v) in &spec.env {
            if k.is_empty() || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return Err(VdiError::InvalidEnv(format!("invalid env var name: {k:?}")));
            }
            if v.contains('\n') || v.contains('\r') {
                return Err(VdiError::InvalidEnv(format!(
                    "env var {k:?} value contains newline"
                )));
            }
        }

        // Final env layered with reserved-key overrides so the runtime
        // credential always wins over anything in operator-supplied
        // env_vars.
        let env_map = vdi_env_vars(&spec.username, &spec.password, &spec.env);
        let env: Vec<String> = env_map.iter().map(|(k, v)| format!("{k}={v}")).collect();

        // Resource limits. bollard takes nano-CPUs (1e9 == 1 core) and
        // memory in bytes. Both `None` ⇒ unbounded.
        let nano_cpus = spec
            .cpu_limit
            .map(|c| (c as f64 * 1_000_000_000.0) as i64)
            .filter(|&n| n > 0);
        let memory_bytes = spec.memory_limit_mb.map(|mb| (mb as i64) * 1024 * 1024);

        // Persistent home: bind <home_base>/<container_name> →
        // /home/<username> with `nosuid,nodev` (rustguac parity item A8 —
        // defence in depth against setuid binaries planted in the home
        // volume). The legacy `binds` field is used here rather than
        // the typed `mounts` API because `Mount` does not expose
        // `nosuid`/`nodev` flags directly.
        let binds = if spec.persistent_home {
            let host_dir = spec
                .home_base
                .join(container_name_for(connection_id, user_id))
                .to_string_lossy()
                .into_owned();
            Some(vec![format!(
                "{}:/home/{}:rw,nosuid,nodev",
                host_dir, spec.username
            )])
        } else {
            None
        };

        let mut labels: HashMap<String, String> = HashMap::with_capacity(4);
        labels.insert(LABEL_MANAGED.to_owned(), "true".to_owned());
        labels.insert(LABEL_CONNECTION_ID.to_owned(), connection_id.to_string());
        labels.insert(LABEL_USER_ID.to_owned(), user_id.to_string());
        // rustguac parity A10 — record the launched image so the
        // image-change detector (deferred to the runtime, item A5) can
        // compare without a full inspect.
        labels.insert(LABEL_IMAGE.to_owned(), spec.image.clone());

        let mut endpoints = HashMap::new();
        endpoints.insert(
            network.to_owned(),
            EndpointSettings {
                ..Default::default()
            },
        );

        // Cap container log size so a noisy guest can't fill the host
        // disk. 10×10 MiB JSON files = 100 MiB ceiling per container.
        let log_config = HostConfigLogConfig {
            typ: Some("json-file".to_owned()),
            config: Some(HashMap::from([
                ("max-size".to_owned(), "10m".to_owned()),
                ("max-file".to_owned(), "10".to_owned()),
            ])),
        };

        let host_config = HostConfig {
            binds,
            nano_cpus,
            memory: memory_bytes,
            // No automatic restart — Strata explicitly destroys + recreates
            // on logout/idle-timeout. Auto-restart would defeat the reaper.
            restart_policy: Some(RestartPolicy {
                name: Some(RestartPolicyNameEnum::NO),
                maximum_retry_count: None,
            }),
            // Defence-in-depth: keep the spawned container from
            // re-escalating capabilities. xrdp itself runs as root
            // inside the container, but cannot acquire new privileges
            // from setuid binaries.
            security_opt: Some(vec!["no-new-privileges:true".to_owned()]),
            log_config: Some(log_config),
            ..Default::default()
        };

        Ok(Config {
            image: Some(spec.image.clone()),
            env: Some(env),
            labels: Some(labels),
            // The xrdp process inside the container listens on 3389;
            // we do not publish a host port — the backend reaches it
            // by container_name on the shared docker network.
            exposed_ports: Some({
                let mut m: HashMap<String, HashMap<(), ()>> = HashMap::new();
                m.insert(format!("{}/tcp", VDI_DEFAULT_PORT), HashMap::new());
                m
            }),
            host_config: Some(host_config),
            networking_config: Some(NetworkingConfig {
                endpoints_config: endpoints,
            }),
            ..Default::default()
        })
    }

    /// True when a container with `name` exists (any state). Returns
    /// the image label and running status so the caller can detect
    /// image changes (rustguac parity item A5) without a second
    /// inspect call.
    async fn container_exists(&self, name: &str) -> Result<Option<ContainerSummary>, VdiError> {
        let mut filters: HashMap<String, Vec<String>> = HashMap::new();
        filters.insert("name".to_owned(), vec![name.to_owned()]);
        let opts = ListContainersOptions::<String> {
            all: true,
            filters,
            ..Default::default()
        };
        let list = self
            .docker
            .list_containers(Some(opts))
            .await
            .map_err(|e| VdiError::Docker(e.to_string()))?;
        // bollard's name filter is a substring match — confirm exact
        // (docker prefixes names with "/").
        let want = format!("/{name}");
        for c in list {
            if let Some(names) = &c.names {
                if names.iter().any(|n| n == &want) {
                    let labels = c.labels.unwrap_or_default();
                    let image = labels
                        .get(LABEL_IMAGE)
                        .cloned()
                        .or_else(|| c.image.clone())
                        .unwrap_or_default();
                    return Ok(Some(ContainerSummary {
                        running: c.state.as_deref() == Some("running"),
                        image,
                    }));
                }
            }
        }
        Ok(None)
    }

    /// Rotate the in-container user password via `docker exec chpasswd`.
    /// Mirrors rustguac's per-reuse rotation (parity item A6) so each
    /// new RDP login uses a fresh credential.
    ///
    /// `username` and `password` are validated belt-and-suspenders
    /// against an alphanumeric+`_-` set to prevent shell injection
    /// even though both are derived from server-trusted state. Hostile
    /// values cause an early `InvalidEnv` rather than reaching the
    /// container shell.
    async fn rotate_password(
        &self,
        container: &str,
        username: &str,
        password: &str,
    ) -> Result<(), VdiError> {
        if !username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(VdiError::InvalidEnv("username has shell metachars".into()));
        }
        if !password.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(VdiError::InvalidEnv(
                "password must be alphanumeric for chpasswd rotation".into(),
            ));
        }
        let cmd = format!("printf '%s:%s' '{username}' '{password}' | chpasswd");
        let exec = self
            .docker
            .create_exec(
                container,
                CreateExecOptions {
                    cmd: Some(vec!["sh".to_owned(), "-c".to_owned(), cmd]),
                    attach_stdout: Some(false),
                    attach_stderr: Some(false),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| VdiError::Docker(format!("create_exec chpasswd: {e}")))?;
        self.docker
            .start_exec(&exec.id, None::<StartExecOptions>)
            .await
            .map_err(|e| VdiError::Docker(format!("start_exec chpasswd: {e}")))?;
        Ok(())
    }

    /// Poll TCP connect against `host:port` until success or `deadline`
    /// elapses. Mirrors rustguac's xrdp readiness wait (parity item A7).
    /// Without this, the first guacd connect after a fresh container
    /// races the xrdp listener and looks like an authentication failure
    /// to the operator.
    async fn wait_for_ready(
        &self,
        host: &str,
        port: u16,
        deadline: Duration,
    ) -> Result<(), VdiError> {
        let addr = format!("{host}:{port}");
        let start = std::time::Instant::now();
        loop {
            if start.elapsed() > deadline {
                return Err(VdiError::Docker(format!(
                    "xrdp not ready on {addr} after {}s",
                    deadline.as_secs()
                )));
            }
            if tokio::net::TcpStream::connect(&addr).await.is_ok() {
                // xrdp binds the port before fully initialising — give
                // it a moment to load TLS certs and start the listener
                // loop. Matches rustguac's 3s grace window.
                tokio::time::sleep(Duration::from_secs(3)).await;
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
}

/// Minimal projection of the bollard summary the driver actually needs.
struct ContainerSummary {
    running: bool,
    /// Value of the `strata.image` label, falling back to the bollard
    /// `image` field. Used by image-change detection (A5).
    image: String,
}

#[async_trait]
impl VdiDriver for DockerVdiDriver {
    async fn ensure_container(
        &self,
        connection_id: Uuid,
        user_id: Uuid,
        spec: &VdiSpawnSpec,
    ) -> Result<VdiEndpoint, VdiError> {
        let name = container_name_for(connection_id, user_id);

        // Reuse an existing container when present (the basis of the
        // persistent-home story). Start it if it's stopped.
        if let Some(summary) = self.container_exists(&name).await? {
            // rustguac parity A5 — image-change detection. If the
            // operator updated `connections.extra.image` since the
            // container was created, destroy + recreate so the next
            // session runs the new image. Without this the persistent
            // container silently pins the old image forever.
            if summary.image != spec.image {
                tracing::info!(
                    container = %name,
                    old_image = %summary.image,
                    new_image = %spec.image,
                    "VDI image changed — replacing container"
                );
                self.destroy_container(&name).await?;
                // Fall through to fresh-create path.
            } else {
                if !summary.running {
                    self.docker
                        .start_container(&name, None::<StartContainerOptions<String>>)
                        .await
                        .map_err(|e| VdiError::Docker(e.to_string()))?;
                }
                // rustguac parity A7 — wait for xrdp before returning.
                self.wait_for_ready(&name, VDI_DEFAULT_PORT, Duration::from_secs(30))
                    .await?;
                // rustguac parity A6 — rotate the in-container password
                // on every reuse so each session has a fresh credential.
                if let Err(e) = self
                    .rotate_password(&name, &spec.username, &spec.password)
                    .await
                {
                    tracing::warn!(
                        container = %name,
                        error = %e,
                        "Password rotation failed; continuing with stale credential"
                    );
                }
                return Ok(VdiEndpoint {
                    host: name.clone(),
                    port: VDI_DEFAULT_PORT,
                    container_name: name,
                });
            }
        }

        // Fresh create.
        let config = Self::build_create_config(spec, connection_id, user_id, &self.network)?;
        self.docker
            .create_container(
                Some(CreateContainerOptions {
                    name: name.clone(),
                    platform: None,
                }),
                config,
            )
            .await
            .map_err(|e| VdiError::Docker(e.to_string()))?;

        self.docker
            .start_container(&name, None::<StartContainerOptions<String>>)
            .await
            .map_err(|e| VdiError::Docker(e.to_string()))?;

        // rustguac parity A7 — wait for xrdp on the fresh container
        // before handing the endpoint to guacd.
        self.wait_for_ready(&name, VDI_DEFAULT_PORT, Duration::from_secs(30))
            .await?;

        Ok(VdiEndpoint {
            host: name.clone(),
            port: VDI_DEFAULT_PORT,
            container_name: name,
        })
    }

    async fn destroy_container(&self, name: &str) -> Result<(), VdiError> {
        // Stop is best-effort: bollard returns an error if the container
        // is already stopped, which is fine for our idempotent destroy
        // contract. Same for remove with a missing container.
        let _ = self
            .docker
            .stop_container(name, Some(StopContainerOptions { t: 10 }))
            .await;
        match self
            .docker
            .remove_container(
                name,
                Some(RemoveContainerOptions {
                    force: true,
                    v: true, // also remove anonymous volumes (the home dir is a bind, not anonymous)
                    ..Default::default()
                }),
            )
            .await
        {
            Ok(()) => Ok(()),
            // Docker returns 404 for "no such container"; treat as success.
            Err(bollard::errors::Error::DockerResponseServerError {
                status_code: 404, ..
            }) => Ok(()),
            Err(e) => Err(VdiError::Docker(e.to_string())),
        }
    }

    async fn list_managed_containers(&self) -> Result<Vec<String>, VdiError> {
        let mut filters: HashMap<String, Vec<String>> = HashMap::new();
        filters.insert("label".to_owned(), vec!["strata.managed=true".to_owned()]);
        let opts = ListContainersOptions::<String> {
            all: true,
            filters,
            ..Default::default()
        };
        let list = self
            .docker
            .list_containers(Some(opts))
            .await
            .map_err(|e| VdiError::Docker(e.to_string()))?;

        let mut names = Vec::with_capacity(list.len());
        for c in list {
            if let Some(ns) = c.names {
                if let Some(first) = ns.into_iter().next() {
                    // Strip docker's leading "/".
                    names.push(first.trim_start_matches('/').to_owned());
                }
            }
        }
        Ok(names)
    }

    async fn list_managed_containers_detail(&self) -> Result<Vec<ManagedContainer>, VdiError> {
        // rustguac parity A11 — rich rows for the planned admin
        // "active desktops" UI (`/api/admin/vdi/containers`).
        let mut filters: HashMap<String, Vec<String>> = HashMap::new();
        filters.insert("label".to_owned(), vec!["strata.managed=true".to_owned()]);
        let opts = ListContainersOptions::<String> {
            all: true,
            filters,
            ..Default::default()
        };
        let list = self
            .docker
            .list_containers(Some(opts))
            .await
            .map_err(|e| VdiError::Docker(e.to_string()))?;

        let mut out = Vec::with_capacity(list.len());
        for c in list {
            let labels = c.labels.clone().unwrap_or_default();
            let container_name = c
                .names
                .as_ref()
                .and_then(|ns| ns.first().cloned())
                .map(|n| n.trim_start_matches('/').to_owned())
                .unwrap_or_default();
            let connection_id = labels
                .get(LABEL_CONNECTION_ID)
                .and_then(|s| Uuid::parse_str(s).ok());
            let user_id = labels
                .get(LABEL_USER_ID)
                .and_then(|s| Uuid::parse_str(s).ok());
            let image = labels
                .get(LABEL_IMAGE)
                .cloned()
                .or_else(|| c.image.clone())
                .unwrap_or_default();
            let running = c.state.as_deref() == Some("running");
            out.push(ManagedContainer {
                container_id: c.id.unwrap_or_default(),
                container_name,
                connection_id,
                user_id,
                image,
                running,
            });
        }
        Ok(out)
    }

    async fn health_check(&self) -> Result<(), VdiError> {
        // rustguac parity A12 — used by `/api/admin/vdi/images` to
        // differentiate "driver unavailable" from "no images
        // configured" and by the readiness probe to expose backend
        // state.
        self.docker
            .ping()
            .await
            .map_err(|e| VdiError::Docker(format!("docker ping failed: {e}")))?;
        Ok(())
    }
}

// ── Tests ──────────────────────────────────────────────────────────
//
// We can't exercise the live docker calls without a daemon, so the
// tests here cover the pure config-builder surface. Integration tests
// against a real docker socket are tracked in the parity tracker.

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn fixture_spec() -> VdiSpawnSpec {
        let mut env = BTreeMap::new();
        env.insert("LANG".to_owned(), "en_GB.UTF-8".to_owned());
        env.insert("TZ".to_owned(), "Europe/London".to_owned());
        // These should be stripped by `vdi_env_vars` and replaced with
        // the runtime credentials.
        env.insert("VDI_USERNAME".to_owned(), "attacker".to_owned());
        env.insert("VDI_PASSWORD".to_owned(), "leaked".to_owned());
        VdiSpawnSpec {
            image: "strata/vdi-sample:1.0.0".to_owned(),
            username: "alice".to_owned(),
            password: "s3cret".to_owned(),
            env,
            cpu_limit: Some(2.0),
            memory_limit_mb: Some(4096),
            persistent_home: true,
            home_base: PathBuf::from("/var/lib/strata/vdi-homes"),
        }
    }

    fn build_for(spec: &VdiSpawnSpec, conn: Uuid, user: Uuid, net: &str) -> Config<String> {
        DockerVdiDriver::build_create_config(spec, conn, user, net).expect("fixture spec is valid")
    }

    #[test]
    fn create_config_uses_runtime_credentials_not_extra_env() {
        let mut spec = fixture_spec();
        // Drop the reserved-key probes — vdi_env_vars strips them but
        // the new validation rejects names starting with VDI_PASSWORD
        // only by the layered overwrite, not name validation. Keep the
        // probe specifically on `VdiConfig::from_extra` (in `vdi.rs`).
        spec.env.remove("VDI_USERNAME");
        spec.env.remove("VDI_PASSWORD");
        let cfg = build_for(&spec, Uuid::new_v4(), Uuid::new_v4(), "guac-internal");
        let env = cfg.env.expect("env present");
        assert!(env.iter().any(|e| e == "VDI_USERNAME=alice"));
        assert!(env.iter().any(|e| e == "VDI_PASSWORD=s3cret"));
        assert!(env.iter().any(|e| e == "LANG=en_GB.UTF-8"));
    }

    #[test]
    fn create_config_rejects_invalid_env_var_name() {
        // rustguac parity A4 — env var keys outside `[A-Za-z0-9_]`
        // are rejected before the container is created.
        let mut spec = fixture_spec();
        spec.env.clear();
        spec.env.insert("BAD-NAME".to_owned(), "value".to_owned());
        let err = DockerVdiDriver::build_create_config(
            &spec,
            Uuid::new_v4(),
            Uuid::new_v4(),
            "guac-internal",
        )
        .expect_err("should reject hyphen in env name");
        assert!(matches!(err, VdiError::InvalidEnv(_)));
    }

    #[test]
    fn create_config_rejects_env_value_with_newline() {
        // rustguac parity A4 — env-injection guard. A value containing
        // `\n` would inject a second variable into the docker create
        // call.
        let mut spec = fixture_spec();
        spec.env.clear();
        spec.env
            .insert("OK_KEY".to_owned(), "line1\nLD_PRELOAD=/x.so".to_owned());
        let err = DockerVdiDriver::build_create_config(
            &spec,
            Uuid::new_v4(),
            Uuid::new_v4(),
            "guac-internal",
        )
        .expect_err("should reject newline in env value");
        assert!(matches!(err, VdiError::InvalidEnv(_)));
    }

    #[test]
    fn create_config_emits_strata_managed_labels() {
        let mut spec = fixture_spec();
        spec.env.remove("VDI_USERNAME");
        spec.env.remove("VDI_PASSWORD");
        let conn = Uuid::new_v4();
        let user = Uuid::new_v4();
        let cfg = build_for(&spec, conn, user, "guac-internal");
        let labels = cfg.labels.expect("labels present");
        assert_eq!(
            labels.get("strata.managed").map(String::as_str),
            Some("true")
        );
        assert_eq!(
            labels.get("strata.connection_id").map(String::as_str),
            Some(conn.to_string()).as_deref()
        );
        assert_eq!(
            labels.get("strata.user_id").map(String::as_str),
            Some(user.to_string()).as_deref()
        );
        // rustguac parity A10 — image label so the deferred
        // image-change detector can compare without a full inspect.
        assert_eq!(
            labels.get("strata.image").map(String::as_str),
            Some("strata/vdi-sample:1.0.0")
        );
    }

    #[test]
    fn create_config_translates_cpu_and_memory_limits() {
        let mut spec = fixture_spec();
        spec.env.remove("VDI_USERNAME");
        spec.env.remove("VDI_PASSWORD");
        let cfg = build_for(&spec, Uuid::new_v4(), Uuid::new_v4(), "guac-internal");
        let host = cfg.host_config.expect("host config");
        // 2.0 cores → 2 * 1e9 nano-CPUs.
        assert_eq!(host.nano_cpus, Some(2_000_000_000));
        // 4096 MiB → 4 GiB in bytes.
        assert_eq!(host.memory, Some(4096 * 1024 * 1024));
    }

    #[test]
    fn create_config_omits_resource_limits_when_unset() {
        let mut spec = fixture_spec();
        spec.env.remove("VDI_USERNAME");
        spec.env.remove("VDI_PASSWORD");
        spec.cpu_limit = None;
        spec.memory_limit_mb = None;
        let cfg = build_for(&spec, Uuid::new_v4(), Uuid::new_v4(), "guac-internal");
        let host = cfg.host_config.expect("host config");
        assert_eq!(host.nano_cpus, None);
        assert_eq!(host.memory, None);
    }

    #[test]
    fn create_config_skips_zero_cpu_limit() {
        let mut spec = fixture_spec();
        spec.env.remove("VDI_USERNAME");
        spec.env.remove("VDI_PASSWORD");
        spec.cpu_limit = Some(0.0);
        let cfg = build_for(&spec, Uuid::new_v4(), Uuid::new_v4(), "guac-internal");
        // 0 cores ⇒ bollard expects None, not Some(0). Verifies the
        // filter clause in build_create_config so a UI default of 0
        // doesn't end up pinning the container to literally zero CPU.
        assert_eq!(cfg.host_config.unwrap().nano_cpus, None);
    }

    #[test]
    fn create_config_emits_persistent_home_bind_with_nosuid_nodev() {
        // rustguac parity A8 — the bind mount carries `nosuid,nodev`
        // so a setuid binary planted in the home volume can't be used
        // for in-container privilege escalation.
        let mut spec = fixture_spec();
        spec.env.remove("VDI_USERNAME");
        spec.env.remove("VDI_PASSWORD");
        let conn = Uuid::new_v4();
        let user = Uuid::new_v4();
        let cfg = build_for(&spec, conn, user, "guac-internal");
        let binds = cfg
            .host_config
            .unwrap()
            .binds
            .expect("persistent_home should produce a bind");
        assert_eq!(binds.len(), 1);
        let bind = &binds[0];
        assert!(
            bind.ends_with(":/home/alice:rw,nosuid,nodev"),
            "bind should end with target + nosuid,nodev opts: {bind}"
        );
        assert!(bind.starts_with("/var/lib/strata/vdi-homes/"));
        assert!(bind.contains(&container_name_for(conn, user)));
    }

    #[test]
    fn create_config_omits_binds_when_persistent_home_disabled() {
        let mut spec = fixture_spec();
        spec.env.remove("VDI_USERNAME");
        spec.env.remove("VDI_PASSWORD");
        spec.persistent_home = false;
        let cfg = build_for(&spec, Uuid::new_v4(), Uuid::new_v4(), "guac-internal");
        assert!(cfg.host_config.unwrap().binds.is_none());
    }

    #[test]
    fn create_config_attaches_to_named_network() {
        let mut spec = fixture_spec();
        spec.env.remove("VDI_USERNAME");
        spec.env.remove("VDI_PASSWORD");
        let cfg = build_for(&spec, Uuid::new_v4(), Uuid::new_v4(), "custom-net");
        let endpoints = cfg.networking_config.unwrap().endpoints_config;
        assert!(endpoints.contains_key("custom-net"));
    }

    #[test]
    fn create_config_pins_no_new_privileges_and_no_restart() {
        let mut spec = fixture_spec();
        spec.env.remove("VDI_USERNAME");
        spec.env.remove("VDI_PASSWORD");
        let cfg = build_for(&spec, Uuid::new_v4(), Uuid::new_v4(), "guac-internal");
        let host = cfg.host_config.unwrap();
        assert!(host
            .security_opt
            .as_ref()
            .unwrap()
            .iter()
            .any(|s| s == "no-new-privileges:true"));
        assert_eq!(
            host.restart_policy.unwrap().name,
            Some(RestartPolicyNameEnum::NO)
        );
    }

    #[test]
    fn create_config_caps_log_volume() {
        // Defence against a noisy VDI container filling the host disk.
        let mut spec = fixture_spec();
        spec.env.remove("VDI_USERNAME");
        spec.env.remove("VDI_PASSWORD");
        let cfg = build_for(&spec, Uuid::new_v4(), Uuid::new_v4(), "guac-internal");
        let log = cfg.host_config.unwrap().log_config.unwrap();
        assert_eq!(log.typ.as_deref(), Some("json-file"));
        let opts = log.config.unwrap();
        assert_eq!(opts.get("max-size").map(String::as_str), Some("10m"));
        assert_eq!(opts.get("max-file").map(String::as_str), Some("10"));
    }

    #[test]
    fn create_config_exposes_xrdp_port() {
        let mut spec = fixture_spec();
        spec.env.remove("VDI_USERNAME");
        spec.env.remove("VDI_PASSWORD");
        let cfg = build_for(&spec, Uuid::new_v4(), Uuid::new_v4(), "guac-internal");
        assert!(cfg.exposed_ports.unwrap().contains_key("3389/tcp"));
    }
}
