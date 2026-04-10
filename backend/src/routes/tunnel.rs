use axum::extract::{Extension, Path, Query, State, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;
use uuid::Uuid;

use crate::error::AppError;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::middleware::AuthUser;
use crate::services::{recordings, tunnel_tickets, vault};
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
    let _db = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Err(AppError::SetupRequired);
        }
        s.db.clone().ok_or(AppError::SetupRequired)?
    };

    let ticket = tunnel_tickets::TunnelTicket {
        user_id: user.id,
        connection_id: body.connection_id,
        username: body.username,
        password: body.password,
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
) -> Result<impl IntoResponse, AppError> {
    // ── Per-user tunnel rate limiting ──
    {
        let mut map = TUNNEL_RATE_LIMIT.lock().unwrap();
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
    // Admins bypass this check
    if user.role != "admin" {
        let has_access: bool = sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM role_connections rc
                JOIN users u ON u.role_id = rc.role_id
                WHERE u.id = $1 AND rc.connection_id = $2
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
    let extra: std::collections::HashMap<String, String> = match &extra_json {
        serde_json::Value::Object(map) => map
            .iter()
            .filter_map(|(k, v)| {
                let val = match v {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Bool(b) => b.to_string(),
                    serde_json::Value::Number(n) => n.to_string(),
                    _ => return None,
                };
                Some((k.clone(), val))
            })
            .collect(),
        _ => std::collections::HashMap::new(),
    };

    // Attempt to load and decrypt user credentials from credential profiles
    let (vault_username, vault_password) = if let Some(vault_cfg) = &config.vault {
        let cred: Option<(Vec<u8>, Vec<u8>, Vec<u8>)> = sqlx::query_as(
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

        if let Some((enc_payload, enc_dek, nonce)) = cred {
            let plaintext = vault::unseal(vault_cfg, &enc_dek, &enc_payload, &nonce).await?;
            let plain_str = String::from_utf8(plaintext).unwrap_or_default();
            // Parse the combined JSON payload { "u": username, "p": password }
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

    let (final_username, final_password) = if vault_password.is_some() {
        // Vault-stored credential profile – use stored username (or Strata login as fallback)
        (
            vault_username.or_else(|| Some(user.username.clone())),
            vault_password,
        )
    } else if let Some(ref tc) = ticket_creds {
        // Credentials from one-time ticket
        (
            tc.username.clone().or_else(|| Some(user.username.clone())),
            tc.password.clone(),
        )
    } else if query.password.is_some() {
        // Legacy: credentials supplied as query params (kept for backward compat)
        (
            query
                .username
                .clone()
                .or_else(|| Some(user.username.clone())),
            query.password.clone(),
        )
    } else {
        (None, None)
    };

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

    // Update last_accessed timestamp on the connection
    sqlx::query("UPDATE connections SET last_accessed = now() WHERE id = $1")
        .bind(connection_id)
        .execute(&db.pool)
        .await?;

    // Build NVR context for session recording into the in-memory ring buffer
    let session_registry = {
        let s = state.read().await;
        s.session_registry.clone()
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

    let audit_pool = db.pool.clone();
    Ok(ws
        .protocols(["guacamole"])
        .on_upgrade(move |socket| async move {
            let nvr = NvrContext {
                registry: session_registry,
                session_id: nvr_session_id,
                connection_id,
                connection_name: nvr_connection_name,
                protocol: nvr_protocol,
                user_id: nvr_user_id,
                username: nvr_username,
            };
            if let Err(e) =
                tunnel::proxy(socket, &guacd_host, guacd_port, handshake, Some(nvr)).await
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
}
