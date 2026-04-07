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
