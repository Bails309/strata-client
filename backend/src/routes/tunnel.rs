use axum::extract::{Extension, Path, Query, State, WebSocketUpgrade};
use axum::response::IntoResponse;
use serde::Deserialize;
use uuid::Uuid;

use crate::error::AppError;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::middleware::AuthUser;
use crate::services::{recordings, vault};
use crate::tunnel::{self, HandshakeParams, NvrContext};

#[derive(Deserialize, Default)]
pub struct TunnelQuery {
    pub username: Option<String>,
    pub password: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub dpi: Option<u32>,
}

pub async fn ws_tunnel(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(connection_id): Path<Uuid>,
    Query(query): Query<TunnelQuery>,
) -> Result<impl IntoResponse, AppError> {
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
    let conn: (String, String, i32, Option<String>, String, serde_json::Value) = sqlx::query_as(
        "SELECT protocol, hostname, port, domain, name, extra FROM connections WHERE id = $1",
    )
    .bind(connection_id)
    .fetch_optional(&db.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Connection not found".into()))?;

    let (protocol, hostname, port, domain, connection_name, extra_json) = conn;

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

    // Attempt to load and decrypt user credentials
    let password = if let Some(vault_cfg) = &config.vault {
        let cred: Option<(Vec<u8>, Vec<u8>, Vec<u8>)> = sqlx::query_as(
            "SELECT encrypted_password, encrypted_dek, nonce
             FROM user_credentials WHERE user_id = $1 AND connection_id = $2",
        )
        .bind(user.id)
        .bind(connection_id)
        .fetch_optional(&db.pool)
        .await?;

        if let Some((enc_pass, enc_dek, nonce)) = cred {
            let plaintext = vault::unseal(vault_cfg, &enc_dek, &enc_pass, &nonce).await?;
            Some(String::from_utf8(plaintext).unwrap_or_default())
        } else {
            None
        }
    } else {
        None
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

    // Determine credentials: Vault first, then query-string fallback
    let (final_username, final_password) = if password.is_some() {
        // Vault-stored credentials – use the authenticated user's login name
        (Some(user.username.clone()), password)
    } else if query.password.is_some() {
        // Credentials supplied by the frontend credential form
        (query.username.or_else(|| Some(user.username.clone())), query.password)
    } else {
        (None, None)
    };

    let has_creds = final_password.is_some();

    let debug_msg = format!(
        "Tunnel creds: username={:?}, has_password={}, domain={:?}, protocol={}",
        &final_username, has_creds, &domain, &protocol
    );
    tracing::debug!(msg = debug_msg);

    // Use per-connection security/ignore-cert from extra, with fallback defaults
    let security = extra.get("security").cloned().or(Some("any".into()));
    let ignore_cert = extra.get("ignore-cert").map(|v| v == "true").unwrap_or(true);

    let handshake = HandshakeParams {
        protocol,
        hostname,
        port: port as u16,
        username: final_username,
        password: final_password,
        domain,
        security,
        ignore_cert,
        recording_path,
        create_recording_path: true,
        width: query.width.unwrap_or(1920),
        height: query.height.unwrap_or(1080),
        dpi: query.dpi.unwrap_or(96),
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
    let nvr_session_id = format!("{}-{}", connection_id, chrono::Utc::now().timestamp_millis());
    let nvr_connection_name = connection_name.clone();
    let nvr_protocol = handshake.protocol.clone();
    let nvr_user_id = user_id;
    let nvr_username = user.username.clone();

    Ok(ws.protocols(["guacamole"]).on_upgrade(move |socket| async move {
        let nvr = NvrContext {
            registry: session_registry,
            session_id: nvr_session_id,
            connection_id,
            connection_name: nvr_connection_name,
            protocol: nvr_protocol,
            user_id: nvr_user_id,
            username: nvr_username,
        };
        if let Err(e) = tunnel::proxy(socket, &guacd_host, guacd_port, handshake, Some(nvr)).await {
            tracing::error!("Tunnel error: {e}");
        }
    }))
}
