// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

//! Roadmap status persistence.
//!
//! Roadmap items are defined statically on the frontend. Admins can override
//! each item's status (`Proposed | Researching | In Progress | Shipped`).
//! Overrides are stored as a single JSON blob in `system_settings` under the
//! key `roadmap_statuses`, shaped as `{ "<item-id>": "<status>" }`.

use axum::extract::{Path, State};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;

use crate::error::AppError;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::middleware::{check_system_permission, AuthUser};
use crate::services::settings;

const SETTINGS_KEY: &str = "roadmap_statuses";
const ALLOWED_STATUSES: &[&str] = &["Proposed", "Researching", "In Progress", "Shipped"];
const MAX_ITEM_ID_LEN: usize = 64;

async fn require_running(state: &SharedState) -> Result<crate::db::Database, AppError> {
    let s = state.read().await;
    if s.phase != BootPhase::Running {
        return Err(AppError::SetupRequired);
    }
    s.db.clone().ok_or(AppError::SetupRequired)
}

fn load_map(raw: Option<String>) -> BTreeMap<String, String> {
    raw.as_deref()
        .and_then(|s| serde_json::from_str::<BTreeMap<String, String>>(s).ok())
        .unwrap_or_default()
}

fn is_valid_item_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ITEM_ID_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// GET /api/roadmap — returns all stored status overrides.
/// Any authenticated user may read. Items not present use the frontend default.
pub async fn get_statuses(
    State(state): State<SharedState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    let raw = settings::get(&db.pool, SETTINGS_KEY).await?;
    let map = load_map(raw);
    Ok(Json(json!({ "statuses": map })))
}

#[derive(Deserialize)]
pub struct SetStatusRequest {
    pub status: String,
}

/// PUT /api/admin/roadmap/:item_id — upsert a single roadmap item's status.
pub async fn set_status(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(item_id): Path<String>,
    Json(body): Json<SetStatusRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    check_system_permission(&user)?;

    if !is_valid_item_id(&item_id) {
        return Err(AppError::Validation("Invalid roadmap item id".into()));
    }
    if !ALLOWED_STATUSES.iter().any(|s| *s == body.status) {
        return Err(AppError::Validation(format!(
            "Invalid status '{}'. Expected one of: {}",
            body.status,
            ALLOWED_STATUSES.join(", ")
        )));
    }

    let db = require_running(&state).await?;
    let raw = settings::get(&db.pool, SETTINGS_KEY).await?;
    let mut map = load_map(raw);
    map.insert(item_id.clone(), body.status.clone());

    let serialised = serde_json::to_string(&map)
        .map_err(|e| AppError::Internal(format!("Serialise roadmap statuses: {e}")))?;
    settings::set(&db.pool, SETTINGS_KEY, &serialised).await?;

    Ok(Json(json!({
        "ok": true,
        "item_id": item_id,
        "status": body.status,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_item_id() {
        assert!(is_valid_item_id("recordings-screenshots"));
        assert!(is_valid_item_id("abc_123"));
        assert!(!is_valid_item_id(""));
        assert!(!is_valid_item_id("has space"));
        assert!(!is_valid_item_id("semi;colon"));
        assert!(!is_valid_item_id(&"x".repeat(MAX_ITEM_ID_LEN + 1)));
    }

    #[test]
    fn load_map_handles_missing_and_invalid() {
        assert!(load_map(None).is_empty());
        assert!(load_map(Some("not json".into())).is_empty());
        let m = load_map(Some(r#"{"a":"Proposed","b":"Shipped"}"#.into()));
        assert_eq!(m.get("a").map(String::as_str), Some("Proposed"));
        assert_eq!(m.get("b").map(String::as_str), Some("Shipped"));
    }

    #[test]
    fn allowed_statuses_cover_all_values() {
        for s in ["Proposed", "Researching", "In Progress", "Shipped"] {
            assert!(ALLOWED_STATUSES.contains(&s));
        }
    }
}
