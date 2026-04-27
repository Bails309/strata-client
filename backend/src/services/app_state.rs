use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;

use crate::config::AppConfig;
use crate::db::Database;
use crate::services::file_store::FileStore;
use crate::services::guacd_pool::GuacdPool;
use crate::services::session_registry::SessionRegistry;
use crate::services::vdi::VdiDriver;
use crate::services::web_runtime::WebRuntimeRegistry;
use crate::services::web_session::WebDisplayAllocator;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootPhase {
    Setup,
    Running,
}

pub struct AppState {
    pub phase: BootPhase,
    pub config: Option<AppConfig>,
    pub db: Option<Database>,
    pub session_registry: SessionRegistry,
    pub guacd_pool: Option<GuacdPool>,
    pub file_store: FileStore,
    /// Allocator for X-display numbers used by `web` connections (Phase
    /// 2 of rustguac parity, see `services/web_session.rs`).
    pub web_displays: Arc<WebDisplayAllocator>,
    /// End-to-end web session spawn registry (Xvnc + Chromium kiosk
    /// orchestrator, rustguac parity Phase 2 spawn runtime). Shares
    /// the [`WebDisplayAllocator`] above so the admin stats endpoint
    /// can report a single in-use count.
    pub web_runtime: Arc<WebRuntimeRegistry>,
    /// Driver used to spawn / reap `vdi` connection containers (Phase 3
    /// of rustguac parity, see `services/vdi.rs`). Defaults to
    /// [`NoopVdiDriver`] which fails fast with `DriverUnavailable`.
    /// Replaced with [`crate::services::vdi_docker::DockerVdiDriver`] at
    /// boot when `STRATA_VDI_ENABLED=true` and `/var/run/docker.sock`
    /// is mounted (the `vdi` compose profile).
    pub vdi_driver: Arc<dyn VdiDriver>,
    pub started_at: Instant,
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("phase", &self.phase)
            .field("config", &self.config)
            .field("db", &self.db)
            .field("started_at", &self.started_at)
            .finish()
    }
}

pub type SharedState = Arc<RwLock<AppState>>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::vdi::NoopVdiDriver;

    #[test]
    fn boot_phase_default_is_setup() {
        let phase = BootPhase::Setup;
        assert_eq!(phase, BootPhase::Setup);
        assert_ne!(phase, BootPhase::Running);
    }

    #[test]
    fn boot_phase_clone_and_eq() {
        let a = BootPhase::Running;
        let b = a.clone();
        assert_eq!(a, b);
    }

    #[test]
    fn boot_phase_debug() {
        assert_eq!(format!("{:?}", BootPhase::Setup), "Setup");
        assert_eq!(format!("{:?}", BootPhase::Running), "Running");
    }

    #[tokio::test]
    async fn app_state_debug_format() {
        let state = AppState {
            phase: BootPhase::Setup,
            config: None,
            db: None,
            session_registry: SessionRegistry::new(),
            guacd_pool: None,
            file_store: FileStore::new(std::path::PathBuf::from("/tmp/strata-files")).await,
            web_displays: Arc::new(WebDisplayAllocator::new()),
            web_runtime: Arc::new(WebRuntimeRegistry::new(
                Arc::new(WebDisplayAllocator::new()),
            )),
            vdi_driver: Arc::new(NoopVdiDriver),
            started_at: Instant::now(),
        };
        let debug = format!("{:?}", state);
        assert!(debug.contains("Setup"));
        assert!(debug.contains("config: None"));
    }
}
