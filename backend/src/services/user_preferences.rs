//! Per-user UI preferences (keybindings, etc.).
//!
//! Stored as a single JSONB blob per user in `user_preferences`. Keeping
//! the schema open-ended lets us add new preferences without further
//! migrations — the frontend is the source of truth for the shape of the
//! object. The backend treats most of the blob as opaque JSON, with a few
//! explicitly-validated keys (e.g. `commandMappings`).

use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::AppError;

/// Built-in command names — user-defined mapping triggers must not collide
/// with these. Kept in sync with the frontend's built-in registry.
const BUILTIN_COMMANDS: &[&str] = &["reload", "disconnect", "fullscreen", "commands"];

/// Allowed `action` values for a command mapping.
const ALLOWED_ACTIONS: &[&str] = &[
    "open-connection",
    "open-folder",
    "open-tag",
    "open-page",
    "paste-text",
    "open-path",
];

/// Maximum length of a `paste-text` `args.text` value, in characters.
/// Caps the JSONB blob size and keeps individual mappings small enough
/// to send through the Guacamole clipboard stream without fragmentation
/// concerns. 4096 covers UNC paths, multi-line snippets, and short
/// commands — anything longer is almost certainly the wrong tool.
const MAX_PASTE_TEXT_LEN: usize = 4096;

/// Maximum length of an `open-path` `args.path` value, in characters.
/// Windows MAX_PATH is 260 for legacy APIs and 32767 for the
/// long-path-aware ones; 1024 is comfortably above any realistic UNC
/// path or `shell:` URI while still preventing accidental abuse of
/// the Win+R run dialog as a generic paste channel.
const MAX_OPEN_PATH_LEN: usize = 1024;

/// Allowed `path` values for the `open-page` action.
const ALLOWED_PAGES: &[&str] = &[
    "/dashboard",
    "/profile",
    "/credentials",
    "/settings",
    "/admin",
    "/audit",
    "/recordings",
];

/// Maximum number of mappings per user.
const MAX_COMMAND_MAPPINGS: usize = 50;

/// Validate the optional `commandMappings` array inside a preferences blob.
///
/// Returns `Ok(())` if absent, an empty array, or every entry is well-formed.
/// Returns `AppError::Validation` describing the first offending entry.
fn validate_command_mappings(prefs: &Value) -> Result<(), AppError> {
    let Some(arr) = prefs.get("commandMappings") else {
        return Ok(());
    };
    let arr = arr.as_array().ok_or_else(|| {
        AppError::Validation("commandMappings must be an array".into())
    })?;
    if arr.len() > MAX_COMMAND_MAPPINGS {
        return Err(AppError::Validation(format!(
            "commandMappings: too many entries ({}, max {})",
            arr.len(),
            MAX_COMMAND_MAPPINGS
        )));
    }

    let mut seen_triggers: std::collections::HashSet<String> = Default::default();

    for (i, entry) in arr.iter().enumerate() {
        let obj = entry.as_object().ok_or_else(|| {
            AppError::Validation(format!("commandMappings[{i}] must be an object"))
        })?;

        // Trigger
        let trigger = obj
            .get("trigger")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Validation(format!("commandMappings[{i}].trigger required")))?;
        if !is_valid_trigger(trigger) {
            return Err(AppError::Validation(format!(
                "commandMappings[{i}].trigger must match [a-z0-9_-]{{1,32}}"
            )));
        }
        let trigger_lower = trigger.to_ascii_lowercase();
        if BUILTIN_COMMANDS.contains(&trigger_lower.as_str()) {
            return Err(AppError::Validation(format!(
                "commandMappings[{i}].trigger '{trigger}' collides with a built-in command"
            )));
        }
        if !seen_triggers.insert(trigger_lower) {
            return Err(AppError::Validation(format!(
                "commandMappings: duplicate trigger '{trigger}'"
            )));
        }

        // Action
        let action = obj
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Validation(format!("commandMappings[{i}].action required")))?;
        if !ALLOWED_ACTIONS.contains(&action) {
            return Err(AppError::Validation(format!(
                "commandMappings[{i}].action '{action}' not in allow-list"
            )));
        }

        // Args (per-action)
        let args = obj.get("args").and_then(Value::as_object).ok_or_else(|| {
            AppError::Validation(format!("commandMappings[{i}].args must be an object"))
        })?;
        match action {
            "open-connection" => require_uuid(args, "connection_id", i)?,
            "open-folder" => require_uuid(args, "folder_id", i)?,
            "open-tag" => require_uuid(args, "tag_id", i)?,
            "open-page" => {
                let path = args.get("path").and_then(Value::as_str).ok_or_else(|| {
                    AppError::Validation(format!(
                        "commandMappings[{i}].args.path required"
                    ))
                })?;
                if !ALLOWED_PAGES.contains(&path) {
                    return Err(AppError::Validation(format!(
                        "commandMappings[{i}].args.path '{path}' not in allow-list"
                    )));
                }
            }
            "paste-text" => {
                let text = args.get("text").and_then(Value::as_str).ok_or_else(|| {
                    AppError::Validation(format!(
                        "commandMappings[{i}].args.text required"
                    ))
                })?;
                if text.is_empty() {
                    return Err(AppError::Validation(format!(
                        "commandMappings[{i}].args.text must not be empty"
                    )));
                }
                if text.chars().count() > MAX_PASTE_TEXT_LEN {
                    return Err(AppError::Validation(format!(
                        "commandMappings[{i}].args.text exceeds max length ({MAX_PASTE_TEXT_LEN} chars)"
                    )));
                }
            }
            "open-path" => {
                let path = args.get("path").and_then(Value::as_str).ok_or_else(|| {
                    AppError::Validation(format!(
                        "commandMappings[{i}].args.path required"
                    ))
                })?;
                if path.is_empty() {
                    return Err(AppError::Validation(format!(
                        "commandMappings[{i}].args.path must not be empty"
                    )));
                }
                if path.chars().count() > MAX_OPEN_PATH_LEN {
                    return Err(AppError::Validation(format!(
                        "commandMappings[{i}].args.path exceeds max length ({MAX_OPEN_PATH_LEN} chars)"
                    )));
                }
                // Reject control characters — open-path drives the
                // Windows Run dialog, which interprets newlines as
                // submit. Allowing them would let a stored mapping
                // execute arbitrary follow-up commands.
                if path.chars().any(|c| c.is_control()) {
                    return Err(AppError::Validation(format!(
                        "commandMappings[{i}].args.path must not contain control characters"
                    )));
                }
            }
            _ => unreachable!(),
        }
    }
    Ok(())
}

fn is_valid_trigger(s: &str) -> bool {
    if s.is_empty() || s.len() > 32 {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

fn require_uuid(
    args: &serde_json::Map<String, Value>,
    key: &str,
    i: usize,
) -> Result<(), AppError> {
    let s = args.get(key).and_then(Value::as_str).ok_or_else(|| {
        AppError::Validation(format!("commandMappings[{i}].args.{key} required"))
    })?;
    Uuid::parse_str(s)
        .map(|_| ())
        .map_err(|_| AppError::Validation(format!("commandMappings[{i}].args.{key} not a UUID")))
}

/// Fetch the preferences object for a user, or `{}` if no row exists.
pub async fn get(pool: &PgPool, user_id: Uuid) -> Result<Value, AppError> {
    let row: Option<(Value,)> =
        sqlx::query_as("SELECT preferences FROM user_preferences WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| AppError::Internal(format!("user_preferences fetch: {e}")))?;
    Ok(row.map(|(v,)| v).unwrap_or_else(|| json!({})))
}

/// Replace the entire preferences object for a user (upsert).
pub async fn set(pool: &PgPool, user_id: Uuid, prefs: &Value) -> Result<(), AppError> {
    if !prefs.is_object() {
        return Err(AppError::Validation(
            "preferences must be a JSON object".into(),
        ));
    }
    validate_command_mappings(prefs)?;
    sqlx::query(
        "INSERT INTO user_preferences (user_id, preferences, updated_at) \
         VALUES ($1, $2, NOW()) \
         ON CONFLICT (user_id) DO UPDATE \
         SET preferences = EXCLUDED.preferences, updated_at = NOW()",
    )
    .bind(user_id)
    .bind(prefs)
    .execute(pool)
    .await
    .map_err(|e| AppError::Internal(format!("user_preferences upsert: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapping(trigger: &str, action: &str, args: Value) -> Value {
        json!({ "trigger": trigger, "action": action, "args": args })
    }

    #[test]
    fn validates_no_mappings_key() {
        assert!(validate_command_mappings(&json!({})).is_ok());
    }

    #[test]
    fn validates_empty_array() {
        assert!(validate_command_mappings(&json!({ "commandMappings": [] })).is_ok());
    }

    #[test]
    fn rejects_non_array_mappings() {
        let err = validate_command_mappings(&json!({ "commandMappings": "nope" })).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn rejects_too_many_mappings() {
        let many: Vec<Value> = (0..51)
            .map(|i| {
                mapping(
                    &format!("t{i}"),
                    "open-page",
                    json!({ "path": "/dashboard" }),
                )
            })
            .collect();
        let err = validate_command_mappings(&json!({ "commandMappings": many })).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn accepts_valid_open_page_mapping() {
        let prefs = json!({
            "commandMappings": [
                mapping("dash", "open-page", json!({ "path": "/dashboard" }))
            ]
        });
        assert!(validate_command_mappings(&prefs).is_ok());
    }

    #[test]
    fn accepts_valid_open_connection_mapping() {
        let prefs = json!({
            "commandMappings": [
                mapping(
                    "jump",
                    "open-connection",
                    json!({ "connection_id": Uuid::new_v4().to_string() })
                )
            ]
        });
        assert!(validate_command_mappings(&prefs).is_ok());
    }

    #[test]
    fn rejects_unknown_action() {
        let prefs = json!({
            "commandMappings": [
                mapping("foo", "delete-everything", json!({}))
            ]
        });
        assert!(matches!(
            validate_command_mappings(&prefs).unwrap_err(),
            AppError::Validation(_)
        ));
    }

    #[test]
    fn rejects_builtin_collision() {
        let prefs = json!({
            "commandMappings": [
                mapping("reload", "open-page", json!({ "path": "/dashboard" }))
            ]
        });
        assert!(matches!(
            validate_command_mappings(&prefs).unwrap_err(),
            AppError::Validation(_)
        ));
    }

    #[test]
    fn rejects_invalid_trigger_chars() {
        let prefs = json!({
            "commandMappings": [
                mapping("Has Space", "open-page", json!({ "path": "/dashboard" }))
            ]
        });
        assert!(matches!(
            validate_command_mappings(&prefs).unwrap_err(),
            AppError::Validation(_)
        ));
    }

    #[test]
    fn rejects_duplicate_trigger() {
        let prefs = json!({
            "commandMappings": [
                mapping("foo", "open-page", json!({ "path": "/dashboard" })),
                mapping("foo", "open-page", json!({ "path": "/profile" }))
            ]
        });
        assert!(matches!(
            validate_command_mappings(&prefs).unwrap_err(),
            AppError::Validation(_)
        ));
    }

    #[test]
    fn rejects_non_uuid_connection_id() {
        let prefs = json!({
            "commandMappings": [
                mapping("jump", "open-connection", json!({ "connection_id": "not-a-uuid" }))
            ]
        });
        assert!(matches!(
            validate_command_mappings(&prefs).unwrap_err(),
            AppError::Validation(_)
        ));
    }

    #[test]
    fn rejects_unknown_page_path() {
        let prefs = json!({
            "commandMappings": [
                mapping("hack", "open-page", json!({ "path": "/etc/passwd" }))
            ]
        });
        assert!(matches!(
            validate_command_mappings(&prefs).unwrap_err(),
            AppError::Validation(_)
        ));
    }
}
