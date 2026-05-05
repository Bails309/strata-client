pub mod admin;
pub mod auth;
pub mod files;
pub mod health;
pub mod notifications;
pub mod roadmap;
pub mod setup;
pub mod share;
pub mod tunnel;
pub mod user;

use axum::{
    extract::DefaultBodyLimit,
    middleware,
    routing::{delete, get, post, put},
    Router,
};
use axum_prometheus::PrometheusMetricLayer;
use tower_http::cors::CorsLayer;
use tower_http::trace::{DefaultMakeSpan, TraceLayer};

use crate::services::app_state::SharedState;
use crate::services::middleware::{require_admin, require_auth, require_csrf};

pub fn build_router(state: SharedState) -> Router {
    let cors = build_cors_layer();

    // W3-12 — Prometheus RED metrics per endpoint. The layer records
    // request count, latency histogram and in-flight gauge against the
    // matched route pattern (e.g. `/api/user/connections/:id`) so
    // cardinality stays bounded.
    let (prom_layer, prom_handle) = PrometheusMetricLayer::pair();

    // ── Public routes (no auth) ──────────────────────────────────────
    let public = Router::new()
        .route("/api/health", get(health::health_check))
        .route("/api/status", get(health::status))
        // /metrics is public at the HTTP layer — it is expected to be
        // firewalled or exposed only on an admin-only network policy per
        // Coding Standards §11.6 / W3-12.
        .route(
            "/metrics",
            get(move || {
                let handle = prom_handle.clone();
                async move { handle.render() }
            }),
        )
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/refresh", post(auth::refresh))
        .route("/api/auth/check", get(auth::check_auth))
        .route("/api/auth/sso/login", get(auth::sso_login))
        .route("/api/auth/sso/callback", get(auth::sso_callback))
        .route("/api/setup/initialize", post(setup::initialize))
        .route(
            "/api/shared/tunnel/{share_token}",
            get(share::ws_shared_tunnel),
        )
        .route("/api/files/{token}", get(files::download));

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
            "/api/admin/kerberos-realms/{id}",
            put(admin::update_kerberos_realm),
        )
        .route(
            "/api/admin/kerberos-realms/{id}",
            delete(admin::delete_kerberos_realm),
        )
        .route(
            "/api/admin/settings/recordings",
            put(admin::update_recordings),
        )
        .route("/api/admin/settings/vault", put(admin::update_vault))
        .route("/api/admin/settings/dns", put(admin::update_dns))
        .route(
            "/api/admin/notifications/smtp",
            get(notifications::get_smtp_config).put(notifications::update_smtp_config),
        )
        .route(
            "/api/admin/notifications/test-send",
            post(notifications::test_send),
        )
        .route(
            "/api/admin/notifications/deliveries",
            get(notifications::list_deliveries),
        )
        .route("/api/admin/health", get(health::service_health))
        .route(
            "/api/admin/roles",
            get(admin::list_roles).post(admin::create_role),
        )
        .route(
            "/api/admin/roles/{id}",
            put(admin::update_role).delete(admin::delete_role),
        )
        .route("/api/admin/connections", get(admin::list_connections))
        .route("/api/admin/connections", post(admin::create_connection))
        .route("/api/admin/connections/{id}", put(admin::update_connection))
        .route(
            "/api/admin/connections/{id}",
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
            "/api/admin/connection-folders/{id}",
            put(admin::update_connection_folder),
        )
        .route(
            "/api/admin/connection-folders/{id}",
            delete(admin::delete_connection_folder),
        )
        .route(
            "/api/admin/roles/{id}/mappings",
            get(admin::get_role_mappings).put(admin::update_role_mappings),
        )
        .route(
            "/api/admin/users",
            get(admin::list_users).post(admin::create_user),
        )
        .route(
            "/api/admin/users/{id}",
            delete(admin::delete_user)
                .post(admin::restore_user)
                .put(admin::update_user),
        )
        .route(
            "/api/admin/users/{id}/reset-password",
            post(admin::reset_user_password),
        )
        .route("/api/admin/audit-logs", get(admin::list_audit_logs))
        .route("/api/admin/sessions", get(admin::list_active_sessions))
        .route("/api/admin/sessions/kill", post(admin::kill_sessions))
        .route(
            "/api/admin/sessions/{id}/observe",
            get(admin::observe_session),
        )
        .route(
            "/api/admin/recordings",
            get(admin::recordings::list_recordings),
        )
        .route(
            "/api/admin/recordings/{id}/stream",
            get(admin::recordings::stream_recording),
        )
        .route(
            "/api/admin/session-stats",
            get(admin::recordings::session_stats),
        )
        .route("/api/admin/metrics", get(admin::get_metrics))
        .route(
            "/api/admin/kubernetes/parse-kubeconfig",
            post(admin::parse_kubeconfig),
        )
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
            "/api/admin/ad-sync-configs/test-filter",
            post(admin::test_pm_target_filter),
        )
        .route(
            "/api/admin/ad-sync-configs/{id}",
            put(admin::update_ad_sync_config),
        )
        .route(
            "/api/admin/ad-sync-configs/{id}",
            delete(admin::delete_ad_sync_config),
        )
        .route(
            "/api/admin/ad-sync-configs/{id}/sync",
            post(admin::trigger_ad_sync),
        )
        .route(
            "/api/admin/ad-sync-configs/{id}/runs",
            get(admin::list_ad_sync_runs),
        )
        .route(
            "/api/admin/tags",
            get(admin::list_admin_tags).post(admin::create_admin_tag),
        )
        .route(
            "/api/admin/tags/{tag_id}",
            put(admin::update_admin_tag).delete(admin::delete_admin_tag),
        )
        .route(
            "/api/admin/connection-tags",
            get(admin::list_admin_connection_tags).post(admin::set_admin_connection_tags),
        )
        // ── Trusted CA bundles for web kiosk ───────────────────────
        .route(
            "/api/admin/trusted-cas",
            get(admin::list_trusted_cas).post(admin::create_trusted_ca),
        )
        .route(
            "/api/admin/trusted-cas/{id}",
            put(admin::update_trusted_ca).delete(admin::delete_trusted_ca),
        )
        // Slim, read-only picker list for connection editors. Visible
        // to any authenticated user — exposes only id/name/subject.
        .route(
            "/api/user/trusted-cas",
            get(admin::list_trusted_cas_for_picker),
        )
        // ── Password Management admin routes ─────────────────────────
        .route(
            "/api/admin/approval-roles",
            get(admin::list_approval_roles).post(admin::create_approval_role),
        )
        .route(
            "/api/admin/approval-roles/{id}",
            put(admin::update_approval_role).delete(admin::delete_approval_role),
        )
        .route(
            "/api/admin/approval-roles/{id}/assignments",
            get(admin::list_role_assignments).put(admin::set_role_assignments),
        )
        .route(
            "/api/admin/approval-roles/{id}/accounts",
            get(admin::list_role_accounts).put(admin::set_role_accounts),
        )
        .route(
            "/api/admin/account-mappings",
            get(admin::list_account_mappings).post(admin::create_account_mapping),
        )
        .route(
            "/api/admin/account-mappings/{id}",
            delete(admin::delete_account_mapping).patch(admin::update_account_mapping),
        )
        .route(
            "/api/admin/ad-sync-configs/{id}/unmapped-accounts",
            get(admin::list_unmapped_accounts),
        )
        .route("/api/admin/pm/test-rotation", post(admin::test_rotation))
        .route(
            "/api/admin/checkout-requests",
            get(admin::list_checkout_requests),
        )
        .route("/api/admin/vdi/images", get(admin::list_vdi_images))
        .route("/api/admin/vdi/containers", get(admin::list_vdi_containers))
        .route("/api/admin/vdi/health", get(admin::vdi_health))
        .route(
            "/api/admin/web-sessions/stats",
            get(admin::web_sessions_stats),
        )
        .route("/api/recordings/{filename}", get(user::get_recording))
        .route("/api/admin/roadmap/{item_id}", put(roadmap::set_status))
        .layer(middleware::from_fn(require_admin))
        .layer(middleware::from_fn_with_state(state.clone(), require_auth))
        // CSRF runs first on the request path (outermost layer). It inspects
        // the Authorization header itself to decide whether to enforce, so
        // it's independent of `require_auth` having run yet.
        .layer(middleware::from_fn(require_csrf));

    // ── Authenticated user routes ────────────────────────────────────
    let user_routes = Router::new()
        .route("/api/auth/password", put(auth::change_password))
        .route("/api/user/me", get(user::me))
        .route("/api/user/accept-terms", post(user::accept_terms))
        .route("/api/user/preferences", get(user::get_preferences))
        .route("/api/user/preferences", put(user::update_preferences))
        .route("/api/user/command-audit", post(user::post_command_audit))
        .route("/api/roadmap", get(roadmap::get_statuses))
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
            "/api/user/credential-profiles/{profile_id}",
            put(user::update_credential_profile),
        )
        .route(
            "/api/user/credential-profiles/{profile_id}",
            delete(user::delete_credential_profile),
        )
        .route(
            "/api/user/credential-profiles/{profile_id}/mappings",
            get(user::get_profile_mappings),
        )
        .route(
            "/api/user/credential-profiles/{profile_id}/link-checkout",
            post(user::link_checkout_to_profile),
        )
        .route(
            "/api/user/credential-mappings",
            put(user::set_credential_mapping),
        )
        .route(
            "/api/user/credential-mappings/{connection_id}",
            delete(user::remove_credential_mapping),
        )
        .route("/api/user/favorites", get(user::list_favorites))
        .route("/api/user/favorites", post(user::toggle_favorite))
        .route("/api/user/tags", get(user::list_tags))
        .route("/api/user/tags", post(user::create_tag))
        .route("/api/user/tags/{tag_id}", put(user::update_tag))
        .route("/api/user/tags/{tag_id}", delete(user::delete_tag))
        .route("/api/user/connection-tags", get(user::list_connection_tags))
        .route("/api/user/connection-tags", post(user::set_connection_tags))
        .route("/api/user/display-tags", get(user::list_display_tags))
        .route("/api/user/display-tags", post(user::set_display_tag))
        .route(
            "/api/user/display-tags/{connection_id}",
            delete(user::remove_display_tag),
        )
        .route("/api/user/admin-tags", get(user::list_admin_tags))
        .route(
            "/api/user/admin-connection-tags",
            get(user::list_admin_connection_tags),
        )
        .route(
            "/api/user/display-settings",
            get(user::get_display_settings),
        )
        .route(
            "/api/user/connections/{connection_id}/info",
            get(user::connection_info),
        )
        .route("/api/tunnel/{connection_id}", get(tunnel::ws_tunnel))
        .route("/api/tunnel/ticket", post(tunnel::create_tunnel_ticket))
        .route(
            "/api/user/connections/{connection_id}/share",
            post(share::create_share),
        )
        .route("/api/user/shares/{share_id}", delete(share::revoke_share))
        .route("/api/user/recordings", get(user::my_recordings))
        .route(
            "/api/user/recordings/{id}/stream",
            get(user::my_recording_stream),
        )
        .route("/api/user/sessions", get(user::my_active_sessions))
        .route(
            "/api/user/sessions/{id}/observe",
            get(user::my_observe_session),
        )
        // ── Password checkout user routes ────────────────────────────
        .route("/api/user/managed-accounts", get(user::my_managed_accounts))
        .route(
            "/api/user/checkouts",
            get(user::my_checkouts).post(user::request_checkout),
        )
        .route(
            "/api/user/checkouts/{id}/decide",
            post(user::decide_checkout),
        )
        .route(
            "/api/user/checkouts/{id}/reveal",
            get(user::reveal_checkout_password),
        )
        .route(
            "/api/user/checkouts/{id}/retry",
            post(user::retry_checkout_activation),
        )
        .route(
            "/api/user/checkouts/{id}/checkin",
            post(user::checkin_checkout),
        )
        .route("/api/user/pending-approvals", get(user::pending_approvals))
        .route(
            "/api/files/upload",
            post(files::upload).layer(DefaultBodyLimit::max(500 * 1024 * 1024)),
        )
        .route(
            "/api/files/session/{session_id}",
            get(files::list_session_files),
        )
        .route("/api/files/delete/{token}", delete(files::delete_file))
        .layer(middleware::from_fn_with_state(state.clone(), require_auth))
        .layer(middleware::from_fn(require_csrf));

    public
        .merge(admin)
        .merge(user_routes)
        // W3-11 — inject/propagate `x-request-id` into a task-local so
        // outbound HTTP calls can stamp the same id on downstream
        // requests. `inject_request_id` runs *before* TraceLayer so the
        // span picks the id up as a field.
        .layer(middleware::from_fn(
            crate::services::request_id::inject_request_id,
        ))
        // DMZ — verify or strip `x-strata-edge-*` headers. No-op for
        // standalone deployments (env var not set). Runs after request-id
        // injection so debug logs are correlated.
        .layer(middleware::from_fn(
            crate::services::edge_header::verify_edge_headers,
        ))
        .layer(
            TraceLayer::new_for_http().make_span_with(
                DefaultMakeSpan::new()
                    .level(tracing::Level::INFO)
                    .include_headers(false),
            ),
        )
        .layer(prom_layer)
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

    #[tokio::test]
    async fn build_router_does_not_panic() {
        use std::sync::Arc;
        use tokio::sync::RwLock;
        let state: SharedState = Arc::new(RwLock::new(crate::services::app_state::AppState {
            phase: crate::services::app_state::BootPhase::Setup,
            config: None,
            db: None,
            session_registry: crate::services::session_registry::SessionRegistry::new(),
            guacd_pool: None,
            file_store: crate::services::file_store::FileStore::new(std::path::PathBuf::from(
                "/tmp/strata-files",
            ))
            .await,
            web_displays: std::sync::Arc::new(
                crate::services::web_session::WebDisplayAllocator::new(),
            ),
            web_runtime: std::sync::Arc::new(
                crate::services::web_runtime::WebRuntimeRegistry::new(std::sync::Arc::new(
                    crate::services::web_session::WebDisplayAllocator::new(),
                )),
            ),
            vdi_driver: std::sync::Arc::new(crate::services::vdi::NoopVdiDriver),
            dmz_link_registry: None,
            started_at: std::time::Instant::now(),
        }));
        std::env::remove_var("STRATA_ALLOWED_ORIGINS");
        std::env::remove_var("STRATA_DOMAIN");
        let _router = build_router(state);
    }
}
