pub mod admin;
pub mod auth;
pub mod health;
pub mod setup;
pub mod share;
pub mod tunnel;
pub mod user;

use axum::{
    middleware,
    routing::{delete, get, post, put},
    Router,
};
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::services::app_state::SharedState;
use crate::services::middleware::{require_admin, require_auth};

pub fn build_router(state: SharedState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // ── Public routes (no auth) ──────────────────────────────────────
    let public = Router::new()
        .route("/api/health", get(health::health_check))
        .route("/api/status", get(health::status))
        .route("/api/auth/login", post(auth::login))
        .route("/api/setup/initialize", post(setup::initialize))
        .route("/api/shared/tunnel/:share_token", get(share::ws_shared_tunnel));

    // ── Admin routes (auth + admin role) ─────────────────────────────
    let admin = Router::new()
        .route("/api/admin/settings", get(admin::get_settings))
        .route("/api/admin/settings", put(admin::update_settings))
        .route("/api/admin/settings/sso", put(admin::update_sso))
        .route("/api/admin/settings/kerberos", put(admin::update_kerberos))
        .route("/api/admin/settings/recordings", put(admin::update_recordings))
        .route("/api/admin/settings/vault", put(admin::update_vault))
        .route("/api/admin/health", get(health::service_health))
        .route("/api/admin/roles", get(admin::list_roles))
        .route("/api/admin/roles", post(admin::create_role))
        .route("/api/admin/connections", get(admin::list_connections))
        .route("/api/admin/connections", post(admin::create_connection))
        .route("/api/admin/connections/:id", put(admin::update_connection))
        .route("/api/admin/connections/:id", delete(admin::delete_connection))
        .route("/api/admin/connection-groups", get(admin::list_connection_groups))
        .route("/api/admin/connection-groups", post(admin::create_connection_group))
        .route("/api/admin/connection-groups/:id", put(admin::update_connection_group))
        .route("/api/admin/connection-groups/:id", delete(admin::delete_connection_group))
        .route("/api/admin/role-connections", put(admin::update_role_connections))
        .route("/api/admin/users", get(admin::list_users))
        .route("/api/admin/audit-logs", get(admin::list_audit_logs))
        .route("/api/admin/sessions", get(admin::list_active_sessions))
        .route("/api/admin/sessions/:session_id/observe", get(admin::observe_session))
        .route("/api/admin/metrics", get(admin::get_metrics))
        .layer(middleware::from_fn(require_admin))
        .layer(middleware::from_fn_with_state(state.clone(), require_auth));

    // ── Authenticated user routes ────────────────────────────────────
    let user_routes = Router::new()
        .route("/api/user/me", get(user::me))
        .route("/api/user/connections", get(user::my_connections))
        .route("/api/user/credentials", put(user::update_credential))
        .route("/api/user/favorites", get(user::list_favorites))
        .route("/api/user/favorites", post(user::toggle_favorite))
        .route("/api/user/connections/:connection_id/info", get(user::connection_info))
        .route("/api/tunnel/:connection_id", get(tunnel::ws_tunnel))
        .route("/api/recordings/:filename", get(user::get_recording))
        .route("/api/user/connections/:connection_id/share", post(share::create_share))
        .route("/api/user/shares/:share_id", delete(share::revoke_share))
        .layer(middleware::from_fn_with_state(state.clone(), require_auth));

    public
        .merge(admin)
        .merge(user_routes)
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state)
}
