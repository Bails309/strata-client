use axum::extract::ws::WebSocket;
use std::collections::HashMap;

use crate::error::AppError;
use crate::services::file_store::FileStore;
use crate::services::session_registry::SessionRegistry;

/// Convert a serde_json::Value (expected to be an Object) into a flat
/// HashMap<String, String>.  Strings are kept as-is, booleans and numbers
/// are converted via `to_string()`, and all other types are skipped.
pub fn json_to_string_map(value: &serde_json::Value) -> HashMap<String, String> {
    match value {
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
        _ => HashMap::new(),
    }
}

/// Optional NVR context — when provided the session captures engine→client
/// frames into a ring buffer and broadcasts them to admin observers.
pub struct NvrContext {
    pub registry: SessionRegistry,
    pub session_id: String,
    pub connection_id: uuid::Uuid,
    pub connection_name: String,
    pub protocol: String,
    pub user_id: uuid::Uuid,
    pub username: String,
    pub client_ip: String,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub db_pool: sqlx::Pool<sqlx::Postgres>,
    pub file_store: FileStore,
}

/// Everything the session engine needs to open a connection to the target.
///
/// Parameter names are the Guacamole ones the admin UI and the database
/// have always used, so a connection row means the same thing it did
/// before the engine was rewritten in Rust.
pub struct HandshakeParams {
    pub protocol: String,
    pub hostname: String,
    /// Address to dial, when the tunnel route resolved `hostname` against
    /// operator-configured nameservers. `hostname` is still what reaches
    /// TLS verification and the Kerberos SPN.
    pub connect_addr: Option<std::net::IpAddr>,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub domain: Option<String>,
    /// RDP security layer requested by the connection. The native engine
    /// always negotiates CredSSP/NLA, so this is reported rather than
    /// honoured — see `session_engine::warn_unsupported_rdp_params`.
    pub security: Option<String>,
    pub ignore_cert: bool,
    pub recording_path: Option<String>,
    pub recording_name: Option<String>,
    pub width: u32,
    pub height: u32,
    /// Carried through from the client: applied by the RDP engine to negotiate
    /// native desktop scaling (100%..=500%) over Display Control.
    pub dpi: u32,
    /// Additional connection parameters from the `extra` JSONB column.
    /// Keys are Guacamole arg names (e.g. "enable-wallpaper", "color-depth").
    pub extra: std::collections::HashMap<String, String>,
    /// Policy applied to SFTP transfers before they reach either side:
    /// AV scanning, and the outbound approval queue for downloads.
    pub transfer_gate: Option<std::sync::Arc<dyn strata_session::engine::sftp::TransferGate>>,
}

/// Run a session between a WebSocket (frontend) and the native engine.
///
/// The browser still speaks the Guacamole wire protocol; the engine on
/// this side of it is native Rust (ADR-0015). A connection the engine
/// cannot serve is refused with the reason rather than being handed to a
/// proxy that no longer exists.
pub async fn proxy(
    ws: WebSocket,
    mut handshake: HandshakeParams,
    nvr: Option<NvrContext>,
    watchdog_token: Option<String>,
    user_id: uuid::Uuid,
) -> Result<(), AppError> {
    crate::session_engine::resolve_global_kdc(&mut handshake, nvr.as_ref().map(|ctx| &ctx.db_pool))
        .await;

    let Some(protocol) = crate::session_engine::select_native(&handshake) else {
        return Err(AppError::Validation(format!(
            "the session engine cannot serve this connection (protocol `{}`). \
             See the backend log for the protocol or parameter responsible.",
            handshake.protocol
        )));
    };

    crate::session_engine::run_native(ws, handshake, protocol, nvr, watchdog_token, user_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── json_to_string_map ─────────────────────────────────────────

    #[test]
    fn json_to_string_map_object_strings() {
        let val = serde_json::json!({"color-depth": "24", "enable-wallpaper": "true"});
        let m = json_to_string_map(&val);
        assert_eq!(m["color-depth"], "24");
        assert_eq!(m["enable-wallpaper"], "true");
    }

    #[test]
    fn json_to_string_map_mixed_types() {
        let val = serde_json::json!({"str": "hello", "bool": true, "num": 42, "arr": [1,2]});
        let m = json_to_string_map(&val);
        assert_eq!(m["str"], "hello");
        assert_eq!(m["bool"], "true");
        assert_eq!(m["num"], "42");
        assert!(!m.contains_key("arr"), "arrays should be skipped");
    }

    #[test]
    fn json_to_string_map_empty_object() {
        let val = serde_json::json!({});
        let m = json_to_string_map(&val);
        assert!(m.is_empty());
    }

    #[test]
    fn json_to_string_map_non_object() {
        let val = serde_json::json!("just a string");
        let m = json_to_string_map(&val);
        assert!(m.is_empty());
    }

    #[test]
    fn json_to_string_map_null() {
        let val = serde_json::Value::Null;
        let m = json_to_string_map(&val);
        assert!(m.is_empty());
    }

    #[test]
    fn json_to_string_map_array() {
        let val = serde_json::json!([1, 2, 3]);
        let m = json_to_string_map(&val);
        assert!(m.is_empty());
    }

    #[test]
    fn json_to_string_map_nested_object_skipped() {
        let val = serde_json::json!({"key": "val", "nested": {"a": "b"}});
        let m = json_to_string_map(&val);
        assert_eq!(m.len(), 1);
        assert_eq!(m["key"], "val");
    }

    #[test]
    fn json_to_string_map_bool_false() {
        let val = serde_json::json!({"flag": false});
        let m = json_to_string_map(&val);
        assert_eq!(m["flag"], "false");
    }

    #[test]
    fn json_to_string_map_number_float() {
        let val = serde_json::json!({"dpi": 96.5});
        let m = json_to_string_map(&val);
        assert_eq!(m["dpi"], "96.5");
    }

    #[test]
    fn json_to_string_map_number_negative() {
        let val = serde_json::json!({"offset": -10});
        let m = json_to_string_map(&val);
        assert_eq!(m["offset"], "-10");
    }

    #[test]
    fn json_to_string_map_empty_string_value() {
        let val = serde_json::json!({"empty": ""});
        let m = json_to_string_map(&val);
        assert_eq!(m["empty"], "");
    }

    #[test]
    fn json_to_string_map_null_value_skipped() {
        let val = serde_json::json!({"present": "yes", "absent": null});
        let m = json_to_string_map(&val);
        assert_eq!(m.len(), 1);
        assert_eq!(m["present"], "yes");
    }
}
