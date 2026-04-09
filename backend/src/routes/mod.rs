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
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::services::app_state::SharedState;
use crate::services::middleware::{require_admin, require_auth};

pub fn build_router(state: SharedState) -> Router {
    let cors = build_cors_layer();

    // ── Public routes (no auth) ──────────────────────────────────────
    let public = Router::new()
        .route("/api/health", get(health::health_check))
        .route("/api/status", get(health::status))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/sso/login", get(auth::sso_login))
        .route("/api/auth/sso/callback", get(auth::sso_callback))
        .route("/api/setup/initialize", post(setup::initialize))
        .route(
            "/api/shared/tunnel/:share_token",
            get(share::ws_shared_tunnel),
        );

    // ── Admin routes (auth + admin role) ─────────────────────────────
    let admin = Router::new()
        .route("/api/admin/settings", get(admin::get_settings))
        .route("/api/admin/settings", put(admin::update_settings))
        .route(
            "/api/admin/settings/auth-methods",
            put(admin::update_auth_methods),
        )
        .route("/api/admin/settings/sso", put(admin::update_sso))
        .route(
            "/api/admin/settings/sso/test",
            post(admin::test_sso_connection),
        )
        .route("/api/admin/settings/kerberos", put(admin::update_kerberos))
        .route(
            "/api/admin/kerberos-realms",
            get(admin::list_kerberos_realms),
        )
        .route(
            "/api/admin/kerberos-realms",
            post(admin::create_kerberos_realm),
        )
        .route(
            "/api/admin/kerberos-realms/:id",
            put(admin::update_kerberos_realm),
        )
        .route(
            "/api/admin/kerberos-realms/:id",
            delete(admin::delete_kerberos_realm),
        )
        .route(
            "/api/admin/settings/recordings",
            put(admin::update_recordings),
        )
        .route("/api/admin/settings/vault", put(admin::update_vault))
        .route("/api/admin/health", get(health::service_health))
        .route("/api/admin/roles", get(admin::list_roles).post(admin::create_role))
        .route(
            "/api/admin/roles/:id",
            put(admin::update_role).delete(admin::delete_role),
        )
        .route("/api/admin/connections", get(admin::list_connections))
        .route("/api/admin/connections", post(admin::create_connection))
        .route("/api/admin/connections/:id", put(admin::update_connection))
        .route(
            "/api/admin/connections/:id",
            delete(admin::delete_connection),
        )
        .route(
            "/api/admin/connection-folders",
            get(admin::list_connection_folders),
        )
        .route(
            "/api/admin/connection-folders",
            post(admin::create_connection_folder),
        )
        .route(
            "/api/admin/connection-folders/:id",
            put(admin::update_connection_folder),
        )
        .route(
            "/api/admin/connection-folders/:id",
            delete(admin::delete_connection_folder),
        )
        .route(
            "/api/admin/role-mappings/:id",
            get(admin::get_role_mappings),
        )
        .route(
            "/api/admin/role-mappings",
            put(admin::update_role_mappings),
        )
        .route(
            "/api/admin/users",
            get(admin::list_users).post(admin::create_user),
        )
        .route("/api/admin/users/:id", delete(admin::delete_user))
        .route("/api/admin/audit-logs", get(admin::list_audit_logs))
        .route("/api/admin/sessions", get(admin::list_active_sessions))
        .route(
            "/api/admin/sessions/:session_id/observe",
            get(admin::observe_session),
        )
        .route("/api/admin/metrics", get(admin::get_metrics))
        .route(
            "/api/admin/ad-sync-configs",
            get(admin::list_ad_sync_configs),
        )
        .route(
            "/api/admin/ad-sync-configs",
            post(admin::create_ad_sync_config),
        )
        .route(
            "/api/admin/ad-sync-configs/test",
            post(admin::test_ad_sync_connection),
        )
        .route(
            "/api/admin/ad-sync-configs/:id",
            put(admin::update_ad_sync_config),
        )
        .route(
            "/api/admin/ad-sync-configs/:id",
            delete(admin::delete_ad_sync_config),
        )
        .route(
            "/api/admin/ad-sync-configs/:id/sync",
            post(admin::trigger_ad_sync),
        )
        .route(
            "/api/admin/ad-sync-configs/:id/runs",
            get(admin::list_ad_sync_runs),
        )
        .route("/api/recordings/:filename", get(user::get_recording))
        .layer(middleware::from_fn(require_admin))
        .layer(middleware::from_fn_with_state(state.clone(), require_auth));

    // ── Authenticated user routes ────────────────────────────────────
    let user_routes = Router::new()
        .route("/api/user/me", get(user::me))
        .route("/api/user/connections", get(user::my_connections))
        .route("/api/user/credentials", put(user::update_credential))
        .route(
            "/api/user/credential-profiles",
            get(user::list_credential_profiles),
        )
        .route(
            "/api/user/credential-profiles",
            post(user::create_credential_profile),
        )
        .route(
            "/api/user/credential-profiles/:profile_id",
            put(user::update_credential_profile),
        )
        .route(
            "/api/user/credential-profiles/:profile_id",
            delete(user::delete_credential_profile),
        )
        .route(
            "/api/user/credential-profiles/:profile_id/mappings",
            get(user::get_profile_mappings),
        )
        .route(
            "/api/user/credential-mappings",
            put(user::set_credential_mapping),
        )
        .route(
            "/api/user/credential-mappings/:connection_id",
            delete(user::remove_credential_mapping),
        )
        .route("/api/user/favorites", get(user::list_favorites))
        .route("/api/user/favorites", post(user::toggle_favorite))
        .route(
            "/api/user/connections/:connection_id/info",
            get(user::connection_info),
        )
        .route("/api/tunnel/:connection_id", get(tunnel::ws_tunnel))
        .route("/api/tunnel/ticket", post(tunnel::create_tunnel_ticket))
        .route(
            "/api/user/connections/:connection_id/share",
            post(share::create_share),
        )
        .route("/api/user/shares/:share_id", delete(share::revoke_share))
        .layer(middleware::from_fn_with_state(state.clone(), require_auth));

    public
        .merge(admin)
        .merge(user_routes)
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state)
}

/// Build CORS layer from STRATA_ALLOWED_ORIGINS env var.
/// In production, STRATA_ALLOWED_ORIGINS must be set explicitly.
fn build_cors_layer() -> CorsLayer {
    use axum::http::{HeaderValue, Method};

    let allowed: Vec<HeaderValue> = std::env::var("STRATA_ALLOWED_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse::<HeaderValue>().ok())
        .collect();

    let origin_list: Vec<HeaderValue> = if allowed.is_empty() {
        // Try to derive from STRATA_DOMAIN if set
        let domain_origins: Vec<HeaderValue> = std::env::var("STRATA_DOMAIN")
            .ok()
            .filter(|d| !d.is_empty() && d != ":80")
            .map(|d| {
                vec![
                    format!("https://{d}").parse::<HeaderValue>().ok(),
                    format!("http://{d}").parse::<HeaderValue>().ok(),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        if domain_origins.is_empty() {
            tracing::error!(
                "STRATA_ALLOWED_ORIGINS not set and STRATA_DOMAIN not configured — \
                 cross-origin requests will be rejected. Set STRATA_ALLOWED_ORIGINS \
                 for production use."
            );
            vec![]
        } else {
            tracing::info!("CORS origins derived from STRATA_DOMAIN");
            domain_origins
        }
    } else {
        allowed
    };

    // Use a predicate so requests without Origin (e.g. Caddy reverse proxy,
    // curl, Postman) are allowed through, while browser cross-origin requests
    // are validated against the allowlist.
    let origin = tower_http::cors::AllowOrigin::predicate(move |origin, _parts| {
        origin_list.iter().any(|allowed| allowed == origin)
    });

    CorsLayer::new()
        .allow_origin(origin)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            axum::http::header::AUTHORIZATION,
            axum::http::header::CONTENT_TYPE,
            axum::http::header::ACCEPT,
        ])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The CORS layer builder must not panic regardless of env var state.
    /// We cannot inspect the internal origin list, but we can verify
    /// the returned CorsLayer is valid by construction.
    #[test]
    fn build_cors_layer_no_env_does_not_panic() {
        // Clear both vars so the fallback path runs
        std::env::remove_var("STRATA_ALLOWED_ORIGINS");
        std::env::remove_var("STRATA_DOMAIN");
        let _layer = build_cors_layer();
    }

    #[test]
    fn build_cors_layer_with_allowed_origins() {
        std::env::set_var(
            "STRATA_ALLOWED_ORIGINS",
            "https://app.example.com, https://dev.example.com",
        );
        std::env::remove_var("STRATA_DOMAIN");
        let _layer = build_cors_layer();
        std::env::remove_var("STRATA_ALLOWED_ORIGINS");
    }

    #[test]
    fn build_cors_layer_with_domain_fallback() {
        std::env::remove_var("STRATA_ALLOWED_ORIGINS");
        std::env::set_var("STRATA_DOMAIN", "strata.example.com");
        let _layer = build_cors_layer();
        std::env::remove_var("STRATA_DOMAIN");
    }

    #[test]
    fn build_cors_layer_ignores_empty_origins() {
        std::env::set_var("STRATA_ALLOWED_ORIGINS", "  ,  ,  ");
        std::env::remove_var("STRATA_DOMAIN");
        let _layer = build_cors_layer();
        std::env::remove_var("STRATA_ALLOWED_ORIGINS");
    }

    #[test]
    fn build_cors_layer_domain_port80_treated_as_unset() {
        std::env::remove_var("STRATA_ALLOWED_ORIGINS");
        std::env::set_var("STRATA_DOMAIN", ":80");
        let _layer = build_cors_layer();
        std::env::remove_var("STRATA_DOMAIN");
    }

    #[test]
    fn build_router_does_not_panic() {
        use std::sync::Arc;
        use tokio::sync::RwLock;
        let state: SharedState = Arc::new(RwLock::new(
            crate::services::app_state::AppState {
                phase: crate::services::app_state::BootPhase::Setup,
                config: None,
                db: None,
                session_registry: crate::services::session_registry::SessionRegistry::new(),
                guacd_pool: None,
            },
        ));
        std::env::remove_var("STRATA_ALLOWED_ORIGINS");
        std::env::remove_var("STRATA_DOMAIN");
        let _router = build_router(state);
    }
}
