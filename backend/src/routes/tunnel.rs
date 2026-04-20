use axum::extract::{ConnectInfo, Extension, Path, Query, State, WebSocketUpgrade};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::Instant;
use uuid::Uuid;

use crate::error::AppError;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::middleware::AuthUser;
use crate::services::{recordings, settings, tunnel_tickets, vault};
use crate::tunnel::{self, HandshakeParams, NvrContext};

/// Per-user rate limiter for WebSocket tunnel connections.
static TUNNEL_RATE_LIMIT: std::sync::LazyLock<Mutex<HashMap<Uuid, Vec<Instant>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Maximum tunnel connections per user within the window.
const MAX_TUNNEL_PER_USER: usize = 30;
/// Rate limit window in seconds.
const TUNNEL_WINDOW_SECS: u64 = 60;
/// Maximum entries in the tunnel rate limiter to prevent OOM.
const MAX_TUNNEL_RATE_ENTRIES: usize = 50_000;

/// Clamp display dimensions to safe bounds.
fn clamp_dimension(val: u32, min: u32, max: u32, default: u32) -> u32 {
    if val == 0 {
        default
    } else {
        val.clamp(min, max)
    }
}
const MIN_DIM: u32 = 64;
const MAX_WIDTH: u32 = 7680; // 8K
const MAX_HEIGHT: u32 = 4320; // 8K
const MAX_DPI: u32 = 600;

/// Credential source for the tunnel.  Each variant carries the username
/// and password available from that source.
pub struct CredentialSource {
    pub username: Option<String>,
    pub password: Option<String>,
}

/// Resolve final tunnel credentials using a priority cascade:
///   1. One-off vault credential profile (from ticket)
///   2. Permanently-mapped vault credential profile
///   3. One-time ticket credentials
///   4. Legacy query-string fallback
///   5. None
///
/// `fallback_username` is used when the chosen source has a password but no username.
pub fn resolve_credentials(
    oneoff: &CredentialSource,
    vault: &CredentialSource,
    ticket: Option<&CredentialSource>,
    query: &CredentialSource,
    fallback_username: &str,
) -> (Option<String>, Option<String>) {
    if oneoff.password.is_some() {
        (
            oneoff
                .username
                .clone()
                .or_else(|| Some(fallback_username.to_string())),
            oneoff.password.clone(),
        )
    } else if vault.password.is_some() {
        (
            vault
                .username
                .clone()
                .or_else(|| Some(fallback_username.to_string())),
            vault.password.clone(),
        )
    } else if let Some(tc) = ticket {
        (
            tc.username
                .clone()
                .or_else(|| Some(fallback_username.to_string())),
            tc.password.clone(),
        )
    } else if query.password.is_some() {
        (
            query
                .username
                .clone()
                .or_else(|| Some(fallback_username.to_string())),
            query.password.clone(),
        )
    } else {
        (None, None)
    }
}

#[derive(Deserialize, Default)]
pub struct TunnelQuery {
    pub username: Option<String>,
    pub password: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub dpi: Option<u32>,
    pub ticket: Option<String>,
}

// ── Ticket creation ────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateTicketRequest {
    pub connection_id: Uuid,
    pub username: Option<String>,
    pub password: Option<String>,
    pub credential_profile_id: Option<Uuid>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub dpi: Option<u32>,
    pub ignore_cert: Option<bool>,
}

pub async fn create_tunnel_ticket(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<CreateTicketRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Err(AppError::SetupRequired);
        }
        s.db.clone().ok_or(AppError::SetupRequired)?
    };

    // Users with can_manage_connections or can_manage_system bypass role-based access check
    if !user.can_access_all_connections() {
        let has_access: bool = sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM role_connections rc
                JOIN users u ON u.role_id = rc.role_id
                WHERE u.id = $1 AND rc.connection_id = $2
            ) OR EXISTS(
                SELECT 1 FROM role_folders rf
                JOIN connections c ON c.folder_id = rf.folder_id
                JOIN users u ON u.role_id = rf.role_id
                WHERE u.id = $1 AND c.id = $2
            )",
        )
        .bind(user.id)
        .bind(body.connection_id)
        .fetch_one(&db.pool)
        .await?;

        if !has_access {
            return Err(AppError::Forbidden);
        }
    }

    let ticket = tunnel_tickets::TunnelTicket {
        user_id: user.id,
        connection_id: body.connection_id,
        username: body.username,
        password: body.password,
        credential_profile_id: body.credential_profile_id,
        width: body.width.unwrap_or(1920),
        height: body.height.unwrap_or(1080),
        dpi: body.dpi.unwrap_or(96),
        ignore_cert: body.ignore_cert.unwrap_or(false),
        created_at: std::time::Instant::now(),
    };

    let ticket_id = tunnel_tickets::create(ticket);
    Ok(Json(serde_json::json!({ "ticket": ticket_id })))
}

pub async fn ws_tunnel(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(connection_id): Path<Uuid>,
    Query(query): Query<TunnelQuery>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    // ── Per-user tunnel rate limiting ──
    {
        let mut map = TUNNEL_RATE_LIMIT.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() > MAX_TUNNEL_RATE_ENTRIES {
            let cutoff = Instant::now() - std::time::Duration::from_secs(TUNNEL_WINDOW_SECS);
            map.retain(|_, attempts| {
                attempts.retain(|t| *t > cutoff);
                !attempts.is_empty()
            });
            if map.len() > MAX_TUNNEL_RATE_ENTRIES {
                map.clear();
            }
        }
        let cutoff = Instant::now() - std::time::Duration::from_secs(TUNNEL_WINDOW_SECS);
        let attempts = map.entry(user.id).or_default();
        attempts.retain(|t| *t > cutoff);
        if attempts.len() >= MAX_TUNNEL_PER_USER {
            return Err(AppError::Validation(
                "Too many tunnel connections. Please try again later.".into(),
            ));
        }
        attempts.push(Instant::now());
    }

    // Read state
    let (db, config, guacd_pool) = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Err(AppError::SetupRequired);
        }
        let db = s.db.clone().ok_or(AppError::SetupRequired)?;
        let cfg = s.config.clone().ok_or(AppError::SetupRequired)?;
        let pool = s.guacd_pool.clone();
        (db, cfg, pool)
    };

    // Verify the user has access to this connection via their role
    // Users with connection management permissions bypass role-based access check
    if !user.can_access_all_connections() {
        let has_access: bool = sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM role_connections rc
                JOIN users u ON u.role_id = rc.role_id
                WHERE u.id = $1 AND rc.connection_id = $2
            ) OR EXISTS(
                SELECT 1 FROM role_folders rf
                JOIN connections c ON c.folder_id = rf.folder_id
                JOIN users u ON u.role_id = rf.role_id
                WHERE u.id = $1 AND c.id = $2
            )",
        )
        .bind(user.id)
        .bind(connection_id)
        .fetch_one(&db.pool)
        .await?;

        if !has_access {
            return Err(AppError::Forbidden);
        }
    }

    // Fetch connection details
    let (protocol, hostname, port, domain, connection_name, extra_json): (
        String,
        String,
        i32,
        Option<String>,
        String,
        serde_json::Value,
    ) = sqlx::query_as(
        "SELECT protocol, hostname, port, domain, name, extra FROM connections WHERE id = $1 AND soft_deleted_at IS NULL",
    )
    .bind(connection_id)
    .fetch_optional(&db.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Connection not found".into()))?;

    // Parse extra JSONB into a HashMap for guacd params
    let extra = crate::tunnel::json_to_string_map(&extra_json);

    // Attempt to load and decrypt user credentials from credential profiles.
    // If the profile is linked to an active checkout, the managed credential's
    // username (sAMAccountName) and password fully replace the user's own profile
    // credentials — the user expects to connect AS the managed account.
    let (vault_username, vault_password) = if let Some(vault_cfg) = &config.vault {
        // Check if the profile is linked to an active checkout with a managed credential
        let managed_cred: Option<(Vec<u8>, Vec<u8>, Vec<u8>)> = sqlx::query_as(
            "SELECT managed.encrypted_password, managed.encrypted_dek, managed.nonce
             FROM credential_mappings cm
             JOIN credential_profiles cp ON cp.id = cm.credential_id
             JOIN password_checkout_requests pcr
                    ON pcr.id = cp.checkout_id AND pcr.status = 'Active'
             JOIN credential_profiles managed
                    ON managed.id = pcr.vault_credential_id
             WHERE cm.connection_id = $1 AND cp.user_id = $2
               AND cp.expires_at > now()",
        )
        .bind(connection_id)
        .bind(user.id)
        .fetch_optional(&db.pool)
        .await?;

        if let Some((enc_payload, enc_dek, nonce)) = managed_cred {
            // Managed checkout active — use its username and password directly
            let plaintext = vault::unseal(vault_cfg, &enc_dek, &enc_payload, &nonce).await?;
            let plain_str = String::from_utf8(plaintext).unwrap_or_default();
            let parsed: serde_json::Value = serde_json::from_str(&plain_str)
                .unwrap_or_else(|_| serde_json::json!({ "u": "", "p": plain_str }));
            let managed_user = parsed["u"].as_str().unwrap_or("").to_string();
            let managed_pass = parsed["p"].as_str().unwrap_or("").to_string();
            tracing::info!(
                "Tunnel using managed checkout credentials for connection {}, managed username={:?}",
                connection_id, managed_user
            );
            (
                if managed_user.is_empty() {
                    None
                } else {
                    Some(managed_user)
                },
                if managed_pass.is_empty() {
                    None
                } else {
                    Some(managed_pass)
                },
            )
        } else {
            // No active checkout — fall back to the user's own profile credentials
            let own_cred: Option<(Vec<u8>, Vec<u8>, Vec<u8>)> = sqlx::query_as(
                "SELECT cp.encrypted_password, cp.encrypted_dek, cp.nonce
                 FROM credential_mappings cm
                 JOIN credential_profiles cp ON cp.id = cm.credential_id
                 WHERE cm.connection_id = $1 AND cp.user_id = $2
                   AND cp.expires_at > now()",
            )
            .bind(connection_id)
            .bind(user.id)
            .fetch_optional(&db.pool)
            .await?;

            if let Some((enc_payload, enc_dek, nonce)) = own_cred {
                let plaintext = vault::unseal(vault_cfg, &enc_dek, &enc_payload, &nonce).await?;
                let plain_str = String::from_utf8(plaintext).unwrap_or_default();
                let parsed: serde_json::Value = serde_json::from_str(&plain_str)
                    .unwrap_or_else(|_| serde_json::json!({ "u": "", "p": plain_str }));
                let u = parsed["u"].as_str().unwrap_or("").to_string();
                let p = parsed["p"].as_str().unwrap_or("").to_string();
                (
                    if u.is_empty() { None } else { Some(u) },
                    if p.is_empty() { None } else { Some(p) },
                )
            } else {
                (None, None)
            }
        }
    } else {
        (None, None)
    };

    // Check recording config
    let rec_config = recordings::get_config(&db.pool).await?;
    let recording_path = if rec_config.enabled {
        Some("/var/lib/guacamole/recordings".to_string())
    } else {
        None
    };

    let guacd_host: String;
    let guacd_port: u16;
    if let Some(ref pool) = guacd_pool {
        let (h, p) = pool.next();
        guacd_host = h.to_string();
        guacd_port = p;
    } else {
        guacd_host = config.guacd_host.clone().unwrap_or_else(|| "guacd".into());
        guacd_port = config.guacd_port.unwrap_or(4822);
    };

    // ── Resolve credentials ──────────────────────────────────────────

    // Priority: Vault profile > ticket > query-string fallback
    // Consume the one-time ticket (if provided) to extract credentials
    let ticket_creds = query.ticket.as_deref().and_then(tunnel_tickets::consume);

    // Verify the ticket belongs to the authenticated user (prevent cross-user credential leakage)
    if let Some(ref tc) = ticket_creds {
        if tc.user_id != user.id {
            return Err(AppError::Auth(
                "Tunnel ticket does not belong to the authenticated user".into(),
            ));
        }
    }

    // If the ticket carries a one-off credential_profile_id, decrypt those
    // vault credentials directly (no permanent mapping required).
    // Same checkout-aware logic: prefer the managed profile's password but keep the profile's username.
    let oneoff_profile_id = ticket_creds.as_ref().and_then(|t| t.credential_profile_id);
    let (oneoff_username, oneoff_password) =
        if let (Some(profile_id), Some(vault_cfg)) = (oneoff_profile_id, &config.vault) {
            // Load the profile's own credentials
            let own_cred: Option<(Vec<u8>, Vec<u8>, Vec<u8>)> = sqlx::query_as(
                "SELECT cp.encrypted_password, cp.encrypted_dek, cp.nonce
                 FROM credential_profiles cp
                 WHERE cp.id = $1 AND cp.user_id = $2
                   AND cp.expires_at > now()",
            )
            .bind(profile_id)
            .bind(user.id)
            .fetch_optional(&db.pool)
            .await?;

            // Check for managed checkout credential
            let managed_cred: Option<(Vec<u8>, Vec<u8>, Vec<u8>)> = sqlx::query_as(
                "SELECT managed.encrypted_password, managed.encrypted_dek, managed.nonce
                 FROM credential_profiles cp
                 JOIN password_checkout_requests pcr
                        ON pcr.id = cp.checkout_id AND pcr.status = 'Active'
                 JOIN credential_profiles managed
                        ON managed.id = pcr.vault_credential_id
                 WHERE cp.id = $1 AND cp.user_id = $2
                   AND cp.expires_at > now()",
            )
            .bind(profile_id)
            .bind(user.id)
            .fetch_optional(&db.pool)
            .await?;

            if let Some((enc_payload, enc_dek, nonce)) = managed_cred {
                // Managed checkout active — use its username and password directly
                let plaintext = vault::unseal(vault_cfg, &enc_dek, &enc_payload, &nonce).await?;
                let plain_str = String::from_utf8(plaintext).unwrap_or_default();
                let parsed: serde_json::Value = serde_json::from_str(&plain_str)
                    .unwrap_or_else(|_| serde_json::json!({ "u": "", "p": plain_str }));
                let managed_user = parsed["u"].as_str().unwrap_or("").to_string();
                let managed_pass = parsed["p"].as_str().unwrap_or("").to_string();
                tracing::info!(
                    "Tunnel (one-off) using managed checkout credentials, managed username={:?}",
                    managed_user
                );
                (
                    if managed_user.is_empty() {
                        None
                    } else {
                        Some(managed_user)
                    },
                    if managed_pass.is_empty() {
                        None
                    } else {
                        Some(managed_pass)
                    },
                )
            } else if let Some((enc_payload, enc_dek, nonce)) = own_cred {
                // No active checkout — fall back to the profile's own credentials
                let plaintext = vault::unseal(vault_cfg, &enc_dek, &enc_payload, &nonce).await?;
                let plain_str = String::from_utf8(plaintext).unwrap_or_default();
                let parsed: serde_json::Value = serde_json::from_str(&plain_str)
                    .unwrap_or_else(|_| serde_json::json!({ "u": "", "p": plain_str }));
                let u = parsed["u"].as_str().unwrap_or("").to_string();
                let p = parsed["p"].as_str().unwrap_or("").to_string();
                (
                    if u.is_empty() { None } else { Some(u) },
                    if p.is_empty() { None } else { Some(p) },
                )
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };
    // If ticket provided dimensions, use them
    let effective_width = clamp_dimension(
        ticket_creds
            .as_ref()
            .map(|t| t.width)
            .or(query.width)
            .unwrap_or(1920),
        MIN_DIM,
        MAX_WIDTH,
        1920,
    );
    let effective_height = clamp_dimension(
        ticket_creds
            .as_ref()
            .map(|t| t.height)
            .or(query.height)
            .unwrap_or(1080),
        MIN_DIM,
        MAX_HEIGHT,
        1080,
    );
    let effective_dpi = clamp_dimension(
        ticket_creds
            .as_ref()
            .map(|t| t.dpi)
            .or(query.dpi)
            .unwrap_or(96),
        MIN_DIM,
        MAX_DPI,
        96,
    );

    let (final_username, final_password) = resolve_credentials(
        &CredentialSource {
            username: oneoff_username,
            password: oneoff_password,
        },
        &CredentialSource {
            username: vault_username,
            password: vault_password,
        },
        ticket_creds
            .as_ref()
            .map(|tc| CredentialSource {
                username: tc.username.clone(),
                password: tc.password.clone(),
            })
            .as_ref(),
        &CredentialSource {
            username: query.username.clone(),
            password: query.password.clone(),
        },
        &user.username,
    );

    let has_creds = final_password.is_some();

    let debug_msg = format!(
        "Tunnel creds: username={:?}, has_password={}, domain={:?}, protocol={}",
        &final_username, has_creds, &domain, &protocol
    );
    tracing::debug!(msg = debug_msg);

    // Use per-connection security/ignore-cert from extra, with fallback defaults.
    // The one-time ticket can override the 'ignore-cert' database setting.
    let security = extra.get("security").cloned().or(Some("any".into()));
    let ignore_cert = ticket_creds
        .as_ref()
        .map(|t| t.ignore_cert)
        .unwrap_or_else(|| {
            extra
                .get("ignore-cert")
                .map(|v| v == "true")
                .unwrap_or(false)
        });

    let safe_port: u16 = port
        .try_into()
        .map_err(|_| AppError::Validation("Invalid port number".into()))?;

    let recording_name = recording_path.as_ref().map(|_| {
        format!(
            "{}-{}.guac",
            connection_id,
            chrono::Utc::now().timestamp_millis()
        )
    });

    let handshake = HandshakeParams {
        protocol,
        hostname,
        port: safe_port,
        username: final_username,
        password: final_password,
        domain,
        security,
        ignore_cert,
        recording_path,
        recording_name: recording_name.clone(),
        create_recording_path: true,
        width: effective_width,
        height: effective_height,
        dpi: effective_dpi,
        extra,
    };

    // Audit log the tunnel connection
    let user_id = user.id;
    crate::services::audit::log(
        &db.pool,
        Some(user_id),
        "tunnel.connected",
        &serde_json::json!({ "connection_id": connection_id.to_string() }),
    )
    .await?;

    // Update per-user last_accessed timestamp
    sqlx::query(
        "INSERT INTO user_connection_access (user_id, connection_id, last_accessed)
         VALUES ($1, $2, now())
         ON CONFLICT (user_id, connection_id) DO UPDATE SET last_accessed = now()",
    )
    .bind(user_id)
    .bind(connection_id)
    .execute(&db.pool)
    .await?;

    // Extract client IP using the shared helper with ConnectInfo fallback
    let client_ip = crate::routes::auth::try_extract_client_ip(&headers)
        .unwrap_or_else(|| addr.ip().to_string());

    // Build NVR context for session recording into the in-memory ring buffer
    let (session_registry, file_store) = {
        let s = state.read().await;
        (s.session_registry.clone(), s.file_store.clone())
    };
    let nvr_session_id = format!(
        "{}-{}",
        connection_id,
        chrono::Utc::now().timestamp_millis()
    );
    let nvr_connection_name = connection_name.clone();
    let nvr_protocol = handshake.protocol.clone();
    let nvr_user_id = user_id;
    let nvr_username = user.username.clone();
    let started_at = chrono::Utc::now();

    // Log the start of the recording if enabled
    if let Some(ref rn) = recording_name {
        let pool_for_init = db.pool.clone();
        let sid = nvr_session_id.clone();
        let cid = connection_id;
        let cname = connection_name.clone();
        let uid = user_id;
        let uname = user.username.clone();
        let rname = rn.clone();

        tokio::spawn(async move {
            let res = sqlx::query(
                "INSERT INTO recordings (session_id, connection_id, connection_name, user_id, username, storage_path, storage_type, started_at)
                 VALUES ($1, $2, $3, $4, $5, $6, 'local', $7)"
            )
            .bind(sid)
            .bind(cid)
            .bind(cname)
            .bind(uid)
            .bind(uname)
            .bind(rname)
            .bind(started_at)
            .execute(&pool_for_init)
            .await;

            if let Err(e) = res {
                tracing::error!("Failed to log recording start: {e}");
            }
        });
    }

    // Fetch timezone for the Guacamole handshake
    let display_timezone = settings::get(&db.pool, "display_timezone")
        .await?
        .unwrap_or_else(|| "UTC".to_string());

    let audit_pool = db.pool.clone();
    Ok(ws
        .protocols(["guacamole"])
        .max_message_size(1024 * 1024)
        .on_upgrade(move |socket| async move {
            let nvr = NvrContext {
                registry: session_registry,
                session_id: nvr_session_id,
                connection_id,
                connection_name: nvr_connection_name,
                protocol: nvr_protocol,
                user_id: nvr_user_id,
                username: nvr_username,
                client_ip,
                started_at,
                db_pool: audit_pool.clone(),
                file_store,
            };
            if let Err(e) = tunnel::proxy(
                socket,
                &guacd_host,
                guacd_port,
                handshake,
                Some(nvr),
                display_timezone,
            )
            .await
            {
                tracing::error!("Tunnel error: {e}");
                // Audit log the tunnel failure
                let _ = crate::services::audit::log(
                    &audit_pool,
                    Some(user_id),
                    "tunnel.failed",
                    &serde_json::json!({
                        "connection_id": connection_id.to_string(),
                        "error": e.to_string()
                    }),
                )
                .await;
            }
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── clamp_dimension ────────────────────────────────────────────
    #[test]
    fn clamp_dimension_zero_returns_default() {
        assert_eq!(clamp_dimension(0, MIN_DIM, MAX_WIDTH, 1920), 1920);
    }

    #[test]
    fn clamp_dimension_below_min() {
        assert_eq!(clamp_dimension(10, MIN_DIM, MAX_WIDTH, 1920), MIN_DIM);
    }

    #[test]
    fn clamp_dimension_above_max() {
        assert_eq!(clamp_dimension(10000, MIN_DIM, MAX_WIDTH, 1920), MAX_WIDTH);
    }

    #[test]
    fn clamp_dimension_normal_passthrough() {
        assert_eq!(clamp_dimension(1024, MIN_DIM, MAX_WIDTH, 1920), 1024);
    }

    #[test]
    fn clamp_dimension_exactly_min() {
        assert_eq!(clamp_dimension(MIN_DIM, MIN_DIM, MAX_WIDTH, 1920), MIN_DIM);
    }

    #[test]
    fn clamp_dimension_exactly_max() {
        assert_eq!(
            clamp_dimension(MAX_WIDTH, MIN_DIM, MAX_WIDTH, 1920),
            MAX_WIDTH
        );
    }

    #[test]
    fn clamp_dpi_values() {
        assert_eq!(clamp_dimension(0, MIN_DIM, MAX_DPI, 96), 96);
        assert_eq!(clamp_dimension(700, MIN_DIM, MAX_DPI, 96), MAX_DPI);
        assert_eq!(clamp_dimension(144, MIN_DIM, MAX_DPI, 96), 144);
    }

    // ── TunnelQuery deserialization ────────────────────────────────
    #[test]
    fn tunnel_query_defaults() {
        let q: TunnelQuery = serde_json::from_str("{}").unwrap();
        assert!(q.username.is_none());
        assert!(q.password.is_none());
        assert!(q.width.is_none());
        assert!(q.height.is_none());
        assert!(q.dpi.is_none());
        assert!(q.ticket.is_none());
    }

    #[test]
    fn tunnel_query_with_values() {
        let q: TunnelQuery = serde_json::from_str(
            r#"{"username":"admin","password":"pw","width":1920,"height":1080,"dpi":96,"ticket":"abc"}"#,
        )
        .unwrap();
        assert_eq!(q.username.unwrap(), "admin");
        assert_eq!(q.password.unwrap(), "pw");
        assert_eq!(q.width.unwrap(), 1920);
    }

    // ── CreateTicketRequest deserialization ─────────────────────────
    #[test]
    fn create_ticket_request_minimal() {
        let json = r#"{"connection_id":"550e8400-e29b-41d4-a716-446655440000"}"#;
        let r: CreateTicketRequest = serde_json::from_str(json).unwrap();
        assert_eq!(
            r.connection_id.to_string(),
            "550e8400-e29b-41d4-a716-446655440000"
        );
        assert!(r.username.is_none());
        assert!(r.width.is_none());
    }

    // ── Dimension constants make sense ─────────────────────────────
    #[test]
    fn dimension_constants_valid() {
        const { assert!(MIN_DIM < MAX_WIDTH) };
        const { assert!(MIN_DIM < MAX_HEIGHT) };
        const { assert!(MIN_DIM < MAX_DPI) };
        const { assert!(MAX_WIDTH >= 3840) }; // at least 4K
        const { assert!(MAX_HEIGHT >= 2160) }; // at least 4K
    }

    #[test]
    fn clamp_dimension_height_variants() {
        assert_eq!(clamp_dimension(0, MIN_DIM, MAX_HEIGHT, 1080), 1080);
        assert_eq!(clamp_dimension(30, MIN_DIM, MAX_HEIGHT, 1080), MIN_DIM);
        assert_eq!(clamp_dimension(5000, MIN_DIM, MAX_HEIGHT, 1080), MAX_HEIGHT);
        assert_eq!(clamp_dimension(720, MIN_DIM, MAX_HEIGHT, 1080), 720);
    }

    #[test]
    fn clamp_dimension_boundary_values() {
        assert_eq!(clamp_dimension(1, MIN_DIM, MAX_WIDTH, 1920), MIN_DIM);
        assert_eq!(clamp_dimension(63, MIN_DIM, MAX_WIDTH, 1920), MIN_DIM);
        assert_eq!(clamp_dimension(65, MIN_DIM, MAX_WIDTH, 1920), 65);
        assert_eq!(clamp_dimension(7679, MIN_DIM, MAX_WIDTH, 1920), 7679);
        assert_eq!(clamp_dimension(7681, MIN_DIM, MAX_WIDTH, 1920), MAX_WIDTH);
    }

    #[test]
    fn tunnel_query_partial_values() {
        let q: TunnelQuery = serde_json::from_str(r#"{"width":2560}"#).unwrap();
        assert_eq!(q.width.unwrap(), 2560);
        assert!(q.height.is_none());
        assert!(q.dpi.is_none());
        assert!(q.username.is_none());
    }

    #[test]
    fn create_ticket_request_full() {
        let json = r#"{"connection_id":"550e8400-e29b-41d4-a716-446655440000","username":"admin","password":"secret","width":3840,"height":2160,"dpi":192}"#;
        let r: CreateTicketRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.username.as_deref(), Some("admin"));
        assert_eq!(r.password.as_deref(), Some("secret"));
        assert_eq!(r.width, Some(3840));
        assert_eq!(r.height, Some(2160));
        assert_eq!(r.dpi, Some(192));
    }

    // ── Additional clamp_dimension tests ───────────────────────────

    #[test]
    fn clamp_dimension_default_is_returned_for_zero() {
        // Different defaults for different use cases
        assert_eq!(clamp_dimension(0, MIN_DIM, MAX_WIDTH, 1920), 1920);
        assert_eq!(clamp_dimension(0, MIN_DIM, MAX_HEIGHT, 1080), 1080);
        assert_eq!(clamp_dimension(0, MIN_DIM, MAX_DPI, 96), 96);
    }

    #[test]
    fn clamp_dimension_u32_max() {
        assert_eq!(
            clamp_dimension(u32::MAX, MIN_DIM, MAX_WIDTH, 1920),
            MAX_WIDTH
        );
    }

    #[test]
    fn clamp_dimension_value_equals_default() {
        assert_eq!(clamp_dimension(1920, MIN_DIM, MAX_WIDTH, 1920), 1920);
    }

    // ── TunnelQuery edge cases ─────────────────────────────────────

    #[test]
    fn tunnel_query_with_ticket_only() {
        let q: TunnelQuery = serde_json::from_str(r#"{"ticket":"abc-ticket-123"}"#).unwrap();
        assert_eq!(q.ticket.as_deref(), Some("abc-ticket-123"));
        assert!(q.username.is_none());
    }

    // ── CreateTicketRequest edge cases ─────────────────────────────

    #[test]
    fn create_ticket_request_with_credential_profile() {
        let json = r#"{"connection_id":"550e8400-e29b-41d4-a716-446655440000","credential_profile_id":"660e8400-e29b-41d4-a716-446655440000"}"#;
        let r: CreateTicketRequest = serde_json::from_str(json).unwrap();
        assert!(r.credential_profile_id.is_some());
    }

    #[test]
    fn create_ticket_request_with_ignore_cert() {
        let json = r#"{"connection_id":"550e8400-e29b-41d4-a716-446655440000","ignore_cert":true}"#;
        let r: CreateTicketRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.ignore_cert, Some(true));
    }

    // ── Rate limit constants ───────────────────────────────────────

    #[test]
    fn tunnel_rate_limit_constants() {
        assert_eq!(MAX_TUNNEL_PER_USER, 30);
        assert_eq!(TUNNEL_WINDOW_SECS, 60);
        const { assert!(MAX_TUNNEL_RATE_ENTRIES >= 10_000) };
    }

    // ── Dimension constants for completeness ───────────────────────

    #[test]
    fn max_width_at_least_8k() {
        const { assert!(MAX_WIDTH >= 7680) };
    }

    #[test]
    fn max_height_at_least_8k() {
        const { assert!(MAX_HEIGHT >= 4320) };
    }

    #[test]
    fn max_dpi_is_reasonable() {
        const { assert!(MAX_DPI >= 300) };
        const { assert!(MAX_DPI <= 1200) };
    }

    // ── resolve_credentials ────────────────────────────────────────

    fn cred(u: Option<&str>, p: Option<&str>) -> CredentialSource {
        CredentialSource {
            username: u.map(|s| s.to_string()),
            password: p.map(|s| s.to_string()),
        }
    }

    #[test]
    fn resolve_creds_oneoff_wins() {
        let (u, p) = resolve_credentials(
            &cred(Some("oneoff_u"), Some("oneoff_p")),
            &cred(Some("vault_u"), Some("vault_p")),
            Some(&cred(Some("ticket_u"), Some("ticket_p"))),
            &cred(Some("query_u"), Some("query_p")),
            "fallback",
        );
        assert_eq!(u.as_deref(), Some("oneoff_u"));
        assert_eq!(p.as_deref(), Some("oneoff_p"));
    }

    #[test]
    fn resolve_creds_vault_wins_over_ticket() {
        let (u, p) = resolve_credentials(
            &cred(None, None),
            &cred(Some("vault_u"), Some("vault_p")),
            Some(&cred(Some("ticket_u"), Some("ticket_p"))),
            &cred(None, None),
            "fallback",
        );
        assert_eq!(u.as_deref(), Some("vault_u"));
        assert_eq!(p.as_deref(), Some("vault_p"));
    }

    #[test]
    fn resolve_creds_ticket_wins_over_query() {
        let (u, p) = resolve_credentials(
            &cred(None, None),
            &cred(None, None),
            Some(&cred(Some("ticket_u"), Some("ticket_p"))),
            &cred(Some("query_u"), Some("query_p")),
            "fallback",
        );
        assert_eq!(u.as_deref(), Some("ticket_u"));
        assert_eq!(p.as_deref(), Some("ticket_p"));
    }

    #[test]
    fn resolve_creds_query_fallback() {
        let (u, p) = resolve_credentials(
            &cred(None, None),
            &cred(None, None),
            None,
            &cred(Some("query_u"), Some("query_p")),
            "fallback",
        );
        assert_eq!(u.as_deref(), Some("query_u"));
        assert_eq!(p.as_deref(), Some("query_p"));
    }

    #[test]
    fn resolve_creds_none_when_empty() {
        let (u, p) = resolve_credentials(
            &cred(None, None),
            &cred(None, None),
            None,
            &cred(None, None),
            "fallback",
        );
        assert!(u.is_none());
        assert!(p.is_none());
    }

    #[test]
    fn resolve_creds_fallback_username_when_missing() {
        let (u, p) = resolve_credentials(
            &cred(None, Some("oneoff_p")),
            &cred(None, None),
            None,
            &cred(None, None),
            "fallback",
        );
        assert_eq!(u.as_deref(), Some("fallback"));
        assert_eq!(p.as_deref(), Some("oneoff_p"));
    }

    #[test]
    fn resolve_creds_vault_fallback_username() {
        let (u, p) = resolve_credentials(
            &cred(None, None),
            &cred(None, Some("vault_p")),
            None,
            &cred(None, None),
            "user1",
        );
        assert_eq!(u.as_deref(), Some("user1"));
        assert_eq!(p.as_deref(), Some("vault_p"));
    }

    #[test]
    fn resolve_creds_ticket_with_password_only() {
        let (u, p) = resolve_credentials(
            &cred(None, None),
            &cred(None, None),
            Some(&cred(None, Some("tp"))),
            &cred(None, None),
            "fb_user",
        );
        assert_eq!(u.as_deref(), Some("fb_user"));
        assert_eq!(p.as_deref(), Some("tp"));
    }

    #[test]
    fn resolve_creds_ticket_no_password_skipped() {
        // ticket with username but no password: still uses ticket source
        let (u, p) = resolve_credentials(
            &cred(None, None),
            &cred(None, None),
            Some(&cred(Some("tu"), None)),
            &cred(Some("qu"), Some("qp")),
            "fb",
        );
        // ticket has no password — username from ticket, password None
        assert_eq!(u.as_deref(), Some("tu"));
        assert!(p.is_none());
    }

    #[test]
    fn resolve_creds_query_fallback_username() {
        let (u, _p) = resolve_credentials(
            &cred(None, None),
            &cred(None, None),
            None,
            &cred(None, Some("qp")),
            "me",
        );
        assert_eq!(u.as_deref(), Some("me"));
    }

    #[test]
    fn resolve_creds_oneoff_priority() {
        let oneoff = cred(Some("oneoff"), Some("p1"));
        let vault = cred(Some("vault"), Some("p2"));
        let (u, p) = resolve_credentials(&oneoff, &vault, None, &vault, "fb");
        assert_eq!(u.as_deref(), Some("oneoff"));
        assert_eq!(p.as_deref(), Some("p1"));
    }

    #[test]
    fn resolve_creds_vault_priority() {
        let oneoff = cred(None, None);
        let vault = cred(Some("vault"), Some("p2"));
        let (u, p) = resolve_credentials(&oneoff, &vault, None, &vault, "fb");
        assert_eq!(u.as_deref(), Some("vault"));
        assert_eq!(p.as_deref(), Some("p2"));
    }

    #[test]
    fn resolve_creds_ticket_priority() {
        let none = cred(None, None);
        let ticket = cred(Some("ticket"), Some("p3"));
        let (u, p) = resolve_credentials(&none, &none, Some(&ticket), &none, "fb");
        assert_eq!(u.as_deref(), Some("ticket"));
        assert_eq!(p.as_deref(), Some("p3"));
    }

    #[test]
    fn resolve_creds_fallback_username_for_password_only() {
        let none = cred(None, None);
        let query = cred(None, Some("p4"));
        let (u, p) = resolve_credentials(&none, &none, None, &query, "john");
        assert_eq!(u.as_deref(), Some("john"));
        assert_eq!(p.as_deref(), Some("p4"));
    }

    #[test]
    fn resolve_creds_none_found() {
        let none = cred(None, None);
        let (u, p) = resolve_credentials(&none, &none, None, &none, "john");
        assert!(u.is_none());
        assert!(p.is_none());
    }

    fn cred(u: Option<&str>, p: Option<&str>) -> CredentialSource {
        CredentialSource {
            username: u.map(|s| s.to_string()),
            password: p.map(|s| s.to_string()),
        }
    }
}
