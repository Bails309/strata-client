use std::sync::Arc;
use tokio::sync::RwLock;

use crate::config::AppConfig;
use crate::db::Database;
use crate::services::guacd_pool::GuacdPool;
use crate::services::session_registry::SessionRegistry;

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
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("phase", &self.phase)
            .field("config", &self.config)
            .field("db", &self.db)
            .finish()
    }
}

pub type SharedState = Arc<RwLock<AppState>>;

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn app_state_debug_format() {
        let state = AppState {
            phase: BootPhase::Setup,
            config: None,
            db: None,
            session_registry: SessionRegistry::new(),
            guacd_pool: None,
        };
        let debug = format!("{:?}", state);
        assert!(debug.contains("Setup"));
        assert!(debug.contains("config: None"));
    }
}
