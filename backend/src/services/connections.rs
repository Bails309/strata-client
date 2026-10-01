//! DB operations for connection rows (RDP/VNC/SSH targets).
//!
//! Extracted from [`crate::routes::admin`] so route handlers can be thin
//! orchestration layers over a typed service boundary (§3.1 / W4-6).

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Pool, Postgres, QueryBuilder};
use uuid::Uuid;

/// Columns returned by list/create/update in a stable order.
pub const SELECT_COLUMNS: &str = "id, name, protocol, hostname, port, domain, description, folder_id, extra, last_accessed, watermark, health_status, health_checked_at";

#[derive(Serialize, FromRow, Debug, Clone)]
pub struct ConnectionRow {
    pub id: Uuid,
    pub name: String,
    pub protocol: String,
    pub hostname: String,
    pub port: i32,
    pub domain: Option<String>,
    pub description: String,
    pub folder_id: Option<Uuid>,
    pub extra: serde_json::Value,
    pub last_accessed: Option<chrono::DateTime<chrono::Utc>>,
    pub watermark: String,
    pub health_status: String,
    pub health_checked_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Deserialize, Debug)]
pub struct CreateConnectionRequest {
    pub name: String,
    pub protocol: String,
    pub hostname: String,
    pub port: Option<i32>,
    pub domain: Option<String>,
    #[serde(default)]
    pub description: String,
    pub folder_id: Option<Uuid>,
    #[serde(default)]
    pub extra: serde_json::Value,
    #[serde(default = "default_watermark")]
    pub watermark: String,
}

fn default_watermark() -> String {
    "inherit".to_string()
}

/// Normalise the `extra` JSON field: turn `null` into an empty object `{}`.
pub fn normalize_extra(extra: &serde_json::Value) -> serde_json::Value {
    if extra.is_null() {
        serde_json::json!({})
    } else {
        extra.clone()
    }
}

// ── Credential-bearing extras (SEC-12) ─────────────────────────────────

/// `extra` keys that carry credentials. Stored as `vault:` envelopes and
/// never returned by the API.
pub const SECRET_EXTRA_KEYS: [&str; 6] = [
    "password",
    "private-key",
    "passphrase",
    "sftp-password",
    "sftp-private-key",
    "sftp-passphrase",
];

/// Returned in place of a stored secret. Sent back unchanged, it keeps the
/// stored value; an empty string clears it.
pub const SECRET_PLACEHOLDER: &str = "********";

/// Replace every stored secret in `extra` with [`SECRET_PLACEHOLDER`].
pub fn redact_secret_extras(extra: &mut serde_json::Value) {
    let Some(map) = extra.as_object_mut() else {
        return;
    };
    for key in SECRET_EXTRA_KEYS {
        if let Some(v) = map.get_mut(key) {
            if v.as_str().is_some_and(|s| !s.is_empty()) {
                *v = serde_json::Value::String(SECRET_PLACEHOLDER.into());
            }
        }
    }
}

/// Prepare submitted `extra` for storage: placeholders keep the value in
/// `existing`, new values are sealed. Requires Vault for any new secret.
pub async fn seal_secret_extras(
    vault: Option<&crate::config::VaultConfig>,
    extra: &mut serde_json::Value,
    existing: Option<&serde_json::Value>,
) -> Result<(), AppError> {
    let Some(map) = extra.as_object_mut() else {
        return Ok(());
    };
    for key in SECRET_EXTRA_KEYS {
        let Some(value) = map.get(key).and_then(|v| v.as_str()).map(str::to_owned) else {
            continue;
        };
        if value.is_empty() {
            continue;
        }
        if value == SECRET_PLACEHOLDER {
            match existing.and_then(|e| e.get(key)).cloned() {
                Some(stored) => map.insert(key.to_owned(), stored),
                None => map.remove(key),
            };
            continue;
        }
        if value.starts_with("vault:") {
            return Err(AppError::Validation(format!(
                "`{key}` must be supplied as plaintext"
            )));
        }
        let vault = vault.ok_or_else(|| {
            AppError::Validation(
                "Vault must be configured before storing connection credentials.".into(),
            )
        })?;
        let sealed = crate::services::vault::seal_setting(vault, &value).await?;
        map.insert(key.to_owned(), serde_json::Value::String(sealed));
    }
    Ok(())
}

/// Decrypt sealed secrets in a tunnel's parameter map in place. Legacy
/// plaintext values pass through unchanged.
pub async fn unseal_secret_extras(
    vault: Option<&crate::config::VaultConfig>,
    extra: &mut std::collections::HashMap<String, String>,
) -> Result<(), AppError> {
    for key in SECRET_EXTRA_KEYS {
        let Some(value) = extra.get(key).filter(|v| v.starts_with("vault:")) else {
            continue;
        };
        let vault = vault.ok_or_else(|| {
            AppError::Vault("Connection credentials are encrypted but Vault is unavailable".into())
        })?;
        let plain = crate::services::vault::unseal_setting(vault, value).await?;
        extra.insert(key.to_owned(), plain);
    }
    Ok(())
}

/// Seal credential extras written before SEC-12. Runs once at boot; a
/// failure leaves the row as it was and is retried on the next boot.
pub async fn seal_legacy_secret_extras(
    pool: &Pool<Postgres>,
    vault: &crate::config::VaultConfig,
) -> Result<usize, AppError> {
    let keys: Vec<String> = SECRET_EXTRA_KEYS.iter().map(|k| k.to_string()).collect();
    let rows: Vec<(Uuid, serde_json::Value)> =
        sqlx::query_as("SELECT id, extra FROM connections WHERE extra ?| $1")
            .bind(&keys)
            .fetch_all(pool)
            .await?;
    let mut sealed = 0;
    for (id, mut extra) in rows {
        let Some(map) = extra.as_object_mut() else {
            continue;
        };
        let mut changed = false;
        for key in SECRET_EXTRA_KEYS {
            let Some(value) = map.get(key).and_then(|v| v.as_str()) else {
                continue;
            };
            if value.is_empty() || value.starts_with("vault:") {
                continue;
            }
            let envelope = crate::services::vault::seal_setting(vault, value).await?;
            map.insert(key.to_owned(), serde_json::Value::String(envelope));
            changed = true;
        }
        if changed {
            sqlx::query("UPDATE connections SET extra = $1 WHERE id = $2")
                .bind(&extra)
                .bind(id)
                .execute(pool)
                .await?;
            sealed += 1;
        }
    }
    Ok(sealed)
}

/// Stored `extra` for a live connection.
pub async fn get_extra(
    pool: &Pool<Postgres>,
    id: Uuid,
) -> Result<Option<serde_json::Value>, AppError> {
    let extra: Option<serde_json::Value> = sqlx::query_scalar(
        "SELECT extra FROM connections WHERE id = $1 AND soft_deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(extra)
}

pub async fn list_all(pool: &Pool<Postgres>) -> Result<Vec<ConnectionRow>, AppError> {
    let sql = format!(
        "SELECT {SELECT_COLUMNS} FROM connections WHERE soft_deleted_at IS NULL ORDER BY name"
    );
    let rows: Vec<ConnectionRow> = sqlx::query_as(&sql).fetch_all(pool).await?;
    Ok(rows)
}

/// Row returned to end-users for their connection list. Differs from
/// [`ConnectionRow`] by omitting `domain`/`extra` and joining in the
/// per-user `last_accessed` and `folder_name`.
#[derive(Serialize, FromRow, Debug)]
pub struct UserConnectionRow {
    pub id: Uuid,
    pub name: String,
    pub protocol: String,
    pub hostname: String,
    pub port: i32,
    pub description: String,
    pub folder_id: Option<Uuid>,
    pub folder_name: Option<String>,
    pub last_accessed: Option<chrono::DateTime<chrono::Utc>>,
    pub watermark: String,
    pub health_status: String,
    pub health_checked_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// List connections visible to `user_id`. `see_all` = admins/managers that
/// bypass role-based filtering.
pub async fn list_for_user(
    pool: &Pool<Postgres>,
    user_id: Uuid,
    see_all: bool,
) -> Result<Vec<UserConnectionRow>, AppError> {
    let rows = if see_all {
        sqlx::query_as(
            "SELECT c.id, c.name, c.protocol, c.hostname, c.port, c.description,
                    c.folder_id, cf.name AS folder_name, uca.last_accessed, c.watermark,
                    c.health_status, c.health_checked_at
             FROM connections c
             LEFT JOIN connection_folders cf ON cf.id = c.folder_id
             LEFT JOIN user_connection_access uca ON uca.connection_id = c.id AND uca.user_id = $1
             WHERE c.soft_deleted_at IS NULL
             ORDER BY c.name",
        )
        .bind(user_id)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as(
            "SELECT DISTINCT c.id, c.name, c.protocol, c.hostname, c.port, c.description,
                    c.folder_id, cf.name AS folder_name, uca.last_accessed, c.watermark,
                    c.health_status, c.health_checked_at
             FROM connections c
             LEFT JOIN connection_folders cf ON cf.id = c.folder_id
             LEFT JOIN user_connection_access uca ON uca.connection_id = c.id AND uca.user_id = $1
             JOIN users u ON u.id = $1
             WHERE c.soft_deleted_at IS NULL
             AND (
                 EXISTS (SELECT 1 FROM role_connections rc WHERE rc.role_id = u.role_id AND rc.connection_id = c.id)
                 OR
                 EXISTS (SELECT 1 FROM role_folders rf WHERE rf.role_id = u.role_id AND rf.folder_id = c.folder_id)
             )
             ORDER BY c.name",
        )
        .bind(user_id)
        .fetch_all(pool)
        .await?
    };
    Ok(rows)
}

// ── Paged listings (PERF-08) ───────────────────────────────────────────

/// One page of a listing and how many rows match in all.
#[derive(Serialize, Debug)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: i64,
    /// Pass as `after` for the rows following this page; absent on the last.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
}

/// Opaque continuation token holding the sort key of the last row sent.
pub fn encode_cursor<T: Serialize>(key: &T) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(key).unwrap_or_default())
}

pub fn decode_cursor<T: serde::de::DeserializeOwned>(s: &str) -> Result<T, AppError> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or_else(|| AppError::Validation("after is not a cursor from this listing".into()))
}

/// Comma-separated ids, at most 200.
pub fn parse_ids(s: &str) -> Result<Vec<Uuid>, AppError> {
    let ids = s
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.parse()
                .map_err(|_| AppError::Validation("ids must be comma-separated ids".into()))
        })
        .collect::<Result<Vec<Uuid>, _>>()?;
    if ids.len() > 200 {
        return Err(AppError::Validation("at most 200 ids".into()));
    }
    Ok(ids)
}

/// `ILIKE` pattern matching `s` anywhere, with its wildcards taken literally.
pub fn contains_pattern(s: &str) -> String {
    let escaped = s
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

fn non_empty(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// Filters for the admin connection table.
#[derive(Deserialize, Debug, Default)]
pub struct AdminConnectionQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
    /// Substring of name, host, port, description, folder or protocol.
    pub search: Option<String>,
    pub protocol: Option<String>,
    /// A folder id (that folder and its subfolders) or `unfiled`.
    pub folder: Option<String>,
    /// `online`, `offline` or `unknown`.
    pub health: Option<String>,
}

const ADMIN_FROM: &str = " FROM connections c
     LEFT JOIN connection_folders cf ON cf.id = c.folder_id
     WHERE c.soft_deleted_at IS NULL";

fn push_admin_filters(
    q: &mut QueryBuilder<'_, Postgres>,
    f: &AdminConnectionQuery,
) -> Result<(), AppError> {
    if let Some(search) = non_empty(&f.search) {
        q.push(
            " AND concat_ws(E'\\n', c.name, c.hostname, c.port::text, c.description, cf.name, c.protocol) ILIKE ",
        )
        .push_bind(contains_pattern(search));
    }
    if let Some(protocol) = non_empty(&f.protocol) {
        q.push(" AND c.protocol = ").push_bind(protocol.to_owned());
    }
    match non_empty(&f.folder) {
        None => {}
        Some("unfiled") => {
            q.push(" AND c.folder_id IS NULL");
        }
        Some(id) => {
            let id: Uuid = id.parse().map_err(|_| {
                AppError::Validation("folder must be a folder id or `unfiled`".into())
            })?;
            q.push(
                " AND c.folder_id IN (WITH RECURSIVE sub(id) AS (SELECT ",
            )
            .push_bind(id)
            .push(
                "::uuid UNION SELECT f.id FROM connection_folders f JOIN sub ON f.parent_id = sub.id) SELECT id FROM sub)",
            );
        }
    }
    match non_empty(&f.health) {
        None => {}
        Some(h @ ("online" | "offline")) => {
            q.push(" AND c.health_status = ").push_bind(h.to_owned());
        }
        Some("unknown") => {
            q.push(" AND c.health_status NOT IN ('online', 'offline')");
        }
        Some(_) => {
            return Err(AppError::Validation(
                "health must be online, offline or unknown".into(),
            ))
        }
    }
    Ok(())
}

/// One page of the admin connection table, ordered by name.
pub async fn admin_page(
    pool: &Pool<Postgres>,
    f: &AdminConnectionQuery,
    limit: i64,
    offset: i64,
) -> Result<Page<ConnectionRow>, AppError> {
    let mut count = QueryBuilder::new(format!("SELECT COUNT(*){ADMIN_FROM}"));
    push_admin_filters(&mut count, f)?;
    let total: i64 = count.build_query_scalar().fetch_one(pool).await?;

    let mut q = QueryBuilder::new(format!(
        "SELECT c.id, c.name, c.protocol, c.hostname, c.port, c.domain, c.description,
                c.folder_id, c.extra, c.last_accessed, c.watermark, c.health_status,
                c.health_checked_at{ADMIN_FROM}"
    ));
    push_admin_filters(&mut q, f)?;
    q.push(" ORDER BY c.name, c.id LIMIT ")
        .push_bind(limit)
        .push(" OFFSET ")
        .push_bind(offset);
    let items = q.build_query_as().fetch_all(pool).await?;
    Ok(Page {
        items,
        total,
        next: None,
    })
}

/// Enough of a connection to name it in a picker or a bulk action.
#[derive(Serialize, FromRow, Debug, Clone)]
pub struct ConnectionRef {
    pub id: Uuid,
    pub name: String,
    pub protocol: String,
    pub hostname: String,
    pub port: i32,
    pub folder_id: Option<Uuid>,
    /// The target of a `web` connection.
    pub url: Option<String>,
}

/// Every connection matching `f`, without `extra`.
pub async fn admin_refs(
    pool: &Pool<Postgres>,
    f: &AdminConnectionQuery,
) -> Result<Vec<ConnectionRef>, AppError> {
    let mut q = QueryBuilder::new(format!(
        "SELECT c.id, c.name, c.protocol, c.hostname, c.port, c.folder_id, c.extra->>'url' AS url{ADMIN_FROM}"
    ));
    push_admin_filters(&mut q, f)?;
    q.push(" ORDER BY c.name, c.id");
    Ok(q.build_query_as().fetch_all(pool).await?)
}

#[derive(Serialize, FromRow, Debug, Default)]
pub struct FleetCounts {
    pub total: i64,
    pub online: i64,
    pub offline: i64,
    /// Connections with at least one posture alert.
    pub alert_count: i64,
    pub legacy_sec: i64,
    pub unpinned: i64,
    pub cert_ignored: i64,
    pub last_sweep: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Serialize, FromRow, Debug)]
pub struct ProtocolCount {
    pub protocol: String,
    pub count: i64,
}

/// Whole-fleet figures for the admin summary strip.
#[derive(Serialize, Debug)]
pub struct FleetSummary {
    #[serde(flatten)]
    pub counts: FleetCounts,
    pub protocols: Vec<ProtocolCount>,
}

/// Mirrors the alerting badges in the admin fleet view (`policiesFor`).
pub async fn fleet_summary(pool: &Pool<Postgres>) -> Result<FleetSummary, AppError> {
    let counts: FleetCounts = sqlx::query_as(
        "SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE health_status = 'online') AS online,
                COUNT(*) FILTER (WHERE health_status = 'offline') AS offline,
                COUNT(*) FILTER (WHERE legacy OR unpinned OR cert) AS alert_count,
                COUNT(*) FILTER (WHERE legacy) AS legacy_sec,
                COUNT(*) FILTER (WHERE unpinned) AS unpinned,
                COUNT(*) FILTER (WHERE cert) AS cert_ignored,
                MAX(health_checked_at) AS last_sweep
         FROM (
             SELECT health_status, health_checked_at,
                    protocol IN ('rdp', 'vdi') AND COALESCE(extra->>'security', '') = 'rdp' AS legacy,
                    protocol = 'ssh' AND COALESCE(extra->>'host-key', '') = '' AS unpinned,
                    COALESCE(extra->>'ignore-cert', '') = 'true' AS cert
             FROM connections WHERE soft_deleted_at IS NULL
         ) c",
    )
    .fetch_one(pool)
    .await?;
    let protocols = sqlx::query_as(
        "SELECT protocol, COUNT(*) AS count FROM connections
         WHERE soft_deleted_at IS NULL GROUP BY protocol ORDER BY count DESC, protocol",
    )
    .fetch_all(pool)
    .await?;
    Ok(FleetSummary { counts, protocols })
}

/// Move connections into `folder_id` (or to the root). Returns what moved.
pub async fn move_to_folder(
    pool: &Pool<Postgres>,
    ids: &[Uuid],
    folder_id: Option<Uuid>,
) -> Result<Vec<(Uuid, String)>, AppError> {
    let rows = sqlx::query_as(
        "UPDATE connections SET folder_id = $1, updated_at = now()
         WHERE id = ANY($2) AND soft_deleted_at IS NULL
         RETURNING id, name",
    )
    .bind(folder_id)
    .bind(ids)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Filters for a user's dashboard.
#[derive(Deserialize, Debug, Default)]
pub struct UserConnectionQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
    /// Substring of name, host or description.
    pub search: Option<String>,
    pub protocol: Option<String>,
    pub favorites: Option<bool>,
    /// A user tag or admin tag id.
    pub tag: Option<Uuid>,
    /// A folder id (that folder only) or `none`.
    pub folder: Option<String>,
    /// `recent`: most recently opened first, opened ones only.
    pub sort: Option<String>,
    /// `next` from the previous page; replaces `page`.
    pub after: Option<String>,
    /// Only these connections (comma-separated ids).
    pub ids: Option<String>,
}

/// `FROM`/`WHERE` for the connections `user_id` may open.
fn push_user_base(q: &mut QueryBuilder<'_, Postgres>, user_id: Uuid, see_all: bool) {
    q.push(
        " FROM connections c
         LEFT JOIN connection_folders cf ON cf.id = c.folder_id
         LEFT JOIN user_connection_access uca ON uca.connection_id = c.id AND uca.user_id = ",
    )
    .push_bind(user_id)
    .push(" WHERE c.soft_deleted_at IS NULL");
    if !see_all {
        q.push(
            " AND (EXISTS (SELECT 1 FROM role_connections rc JOIN users u ON u.role_id = rc.role_id
                           WHERE u.id = ",
        )
        .push_bind(user_id)
        .push(
            " AND rc.connection_id = c.id)
                 OR EXISTS (SELECT 1 FROM role_folders rf JOIN users u ON u.role_id = rf.role_id
                           WHERE u.id = ",
        )
        .push_bind(user_id)
        .push(" AND rf.folder_id = c.folder_id))");
    }
}

/// Name, host, description, folder, protocol, or a tag the user sees on it.
fn push_user_search(q: &mut QueryBuilder<'_, Postgres>, user_id: Uuid, search: &str) {
    let pattern = contains_pattern(search);
    q.push(
        " AND (concat_ws(E'\\n', c.name, c.hostname, c.description, cf.name, c.protocol) ILIKE ",
    )
    .push_bind(pattern.clone())
    .push(
        " OR EXISTS (SELECT 1 FROM user_connection_tags t JOIN user_tags ut ON ut.id = t.tag_id
                        WHERE t.connection_id = c.id AND t.user_id = ",
    )
    .push_bind(user_id)
    .push(" AND ut.name ILIKE ")
    .push_bind(pattern.clone())
    .push(
        ") OR EXISTS (SELECT 1 FROM admin_connection_tags t JOIN admin_tags at ON at.id = t.tag_id
                         WHERE t.connection_id = c.id AND at.name ILIKE ",
    )
    .push_bind(pattern)
    .push("))");
}

/// Every filter but the folder.
fn push_user_filters(q: &mut QueryBuilder<'_, Postgres>, user_id: Uuid, f: &UserConnectionQuery) {
    if let Some(search) = non_empty(&f.search) {
        push_user_search(q, user_id, search);
    }
    if let Some(protocol) = non_empty(&f.protocol) {
        q.push(" AND lower(c.protocol) = lower(")
            .push_bind(protocol.to_owned())
            .push(")");
    }
    if f.favorites == Some(true) {
        q.push(" AND EXISTS (SELECT 1 FROM user_favorites fv WHERE fv.connection_id = c.id AND fv.user_id = ")
            .push_bind(user_id)
            .push(")");
    }
    if let Some(tag) = f.tag {
        q.push(" AND (EXISTS (SELECT 1 FROM user_connection_tags t WHERE t.connection_id = c.id AND t.user_id = ")
            .push_bind(user_id)
            .push(" AND t.tag_id = ")
            .push_bind(tag)
            .push(") OR EXISTS (SELECT 1 FROM admin_connection_tags t WHERE t.connection_id = c.id AND t.tag_id = ")
            .push_bind(tag)
            .push("))");
    }
}

/// One page of the connections `user_id` may open.
pub async fn user_page(
    pool: &Pool<Postgres>,
    user_id: Uuid,
    see_all: bool,
    f: &UserConnectionQuery,
    limit: i64,
    offset: i64,
) -> Result<Page<UserConnectionRow>, AppError> {
    let recent = match non_empty(&f.sort) {
        None => false,
        Some("recent") => true,
        Some(_) => return Err(AppError::Validation("sort must be `recent`".into())),
    };
    let ids = non_empty(&f.ids).map(parse_ids).transpose()?;
    let push_where = |q: &mut QueryBuilder<'_, Postgres>| -> Result<(), AppError> {
        push_user_base(q, user_id, see_all);
        push_user_filters(q, user_id, f);
        match non_empty(&f.folder) {
            None => {}
            Some("none") => {
                q.push(" AND c.folder_id IS NULL");
            }
            Some(id) => {
                let id: Uuid = id.parse().map_err(|_| {
                    AppError::Validation("folder must be a folder id or `none`".into())
                })?;
                q.push(" AND c.folder_id = ").push_bind(id);
            }
        }
        if let Some(ids) = &ids {
            q.push(" AND c.id = ANY(").push_bind(ids.clone()).push(")");
        }
        if recent {
            q.push(" AND uca.last_accessed IS NOT NULL");
        }
        Ok(())
    };

    let mut count = QueryBuilder::new("SELECT COUNT(*)");
    push_where(&mut count)?;
    let total: i64 = count.build_query_scalar().fetch_one(pool).await?;

    let mut q = QueryBuilder::new(
        "SELECT c.id, c.name, c.protocol, c.hostname, c.port, c.description,
                c.folder_id, cf.name AS folder_name, uca.last_accessed, c.watermark,
                c.health_status, c.health_checked_at",
    );
    push_where(&mut q)?;
    let after = non_empty(&f.after);
    if let Some(after) = after {
        if recent {
            let (at, name, id): (chrono::DateTime<chrono::Utc>, String, Uuid) =
                decode_cursor(after)?;
            q.push(" AND (uca.last_accessed < ")
                .push_bind(at)
                .push(" OR (uca.last_accessed = ")
                .push_bind(at)
                .push(" AND (c.name, c.id) > (")
                .push_bind(name)
                .push(", ")
                .push_bind(id)
                .push(")))");
        } else {
            let (name, id): (String, Uuid) = decode_cursor(after)?;
            q.push(" AND (c.name, c.id) > (")
                .push_bind(name)
                .push(", ")
                .push_bind(id)
                .push(")");
        }
    }
    q.push(if recent {
        " ORDER BY uca.last_accessed DESC, c.name, c.id"
    } else {
        " ORDER BY c.name, c.id"
    });
    q.push(" LIMIT ").push_bind(limit);
    if after.is_none() {
        q.push(" OFFSET ").push_bind(offset);
    }
    let items: Vec<UserConnectionRow> = q.build_query_as().fetch_all(pool).await?;
    let next = match items.last() {
        Some(last) if items.len() as i64 == limit => Some(if recent {
            encode_cursor(&(last.last_accessed, &last.name, last.id))
        } else {
            encode_cursor(&(&last.name, last.id))
        }),
        _ => None,
    };
    Ok(Page { items, total, next })
}

#[derive(Serialize, FromRow, Debug)]
pub struct FolderCount {
    /// `None`: connections in no folder.
    pub folder_id: Option<Uuid>,
    pub count: i64,
}

/// Counts that let the dashboard draw its folder tree and filters without
/// loading every connection.
#[derive(Serialize, Debug)]
pub struct UserConnectionFacets {
    /// Matching every filter.
    pub total: i64,
    /// Matching the search alone.
    pub search_total: i64,
    /// Every connection the user may open.
    pub all_total: i64,
    /// Protocols among every connection the user may open.
    pub protocols: Vec<String>,
    /// Matches by the folder they are filed in directly.
    pub folders: Vec<FolderCount>,
}

pub async fn user_facets(
    pool: &Pool<Postgres>,
    user_id: Uuid,
    see_all: bool,
    f: &UserConnectionQuery,
) -> Result<UserConnectionFacets, AppError> {
    let mut q = QueryBuilder::new("SELECT c.folder_id, COUNT(*) AS count");
    push_user_base(&mut q, user_id, see_all);
    push_user_filters(&mut q, user_id, f);
    q.push(" GROUP BY c.folder_id");
    let folders: Vec<FolderCount> = q.build_query_as().fetch_all(pool).await?;

    let mut q = QueryBuilder::new("SELECT COUNT(*), COUNT(*) FILTER (WHERE TRUE");
    if let Some(search) = non_empty(&f.search) {
        push_user_search(&mut q, user_id, search);
    }
    q.push(
        "), COALESCE(array_agg(DISTINCT c.protocol) FILTER (WHERE c.protocol IS NOT NULL), '{}')",
    );
    push_user_base(&mut q, user_id, see_all);
    let (all_total, search_total, protocols): (i64, i64, Vec<String>) =
        q.build_query_as().fetch_one(pool).await?;

    Ok(UserConnectionFacets {
        total: folders.iter().map(|f| f.count).sum(),
        search_total,
        all_total,
        protocols,
        folders,
    })
}

pub async fn create(
    pool: &Pool<Postgres>,
    body: &CreateConnectionRequest,
) -> Result<ConnectionRow, AppError> {
    let port = body.port.unwrap_or(3389);
    let extra = normalize_extra(&body.extra);
    let sql = format!(
        "INSERT INTO connections (name, protocol, hostname, port, domain, description, folder_id, extra, watermark)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING {SELECT_COLUMNS}"
    );
    let row: ConnectionRow = sqlx::query_as(&sql)
        .bind(&body.name)
        .bind(&body.protocol)
        .bind(&body.hostname)
        .bind(port)
        .bind(&body.domain)
        .bind(&body.description)
        .bind(body.folder_id)
        .bind(&extra)
        .bind(&body.watermark)
        .fetch_one(pool)
        .await?;
    Ok(row)
}

pub async fn update(
    pool: &Pool<Postgres>,
    id: Uuid,
    body: &CreateConnectionRequest,
) -> Result<Option<ConnectionRow>, AppError> {
    let port = body.port.unwrap_or(3389);
    let extra = normalize_extra(&body.extra);
    let sql = format!(
        "UPDATE connections SET name = $1, protocol = $2, hostname = $3, port = $4, domain = $5, description = $6, folder_id = $7, extra = $8, watermark = $9, updated_at = now()
         WHERE id = $10 AND soft_deleted_at IS NULL
         RETURNING {SELECT_COLUMNS}"
    );
    let row: Option<ConnectionRow> = sqlx::query_as(&sql)
        .bind(&body.name)
        .bind(&body.protocol)
        .bind(&body.hostname)
        .bind(port)
        .bind(&body.domain)
        .bind(&body.description)
        .bind(body.folder_id)
        .bind(&extra)
        .bind(&body.watermark)
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

/// Soft-delete a connection. Returns `Some(name)` if a row was updated, `None` if
/// no active row with that id exists.
pub async fn soft_delete(pool: &Pool<Postgres>, id: Uuid) -> Result<Option<String>, AppError> {
    let row: Option<(String,)> = sqlx::query_as(
        "UPDATE connections SET soft_deleted_at = now() WHERE id = $1 AND soft_deleted_at IS NULL RETURNING name",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(name,)| name))
}

// ── Connection Folders ─────────────────────────────────────────────────

#[derive(Serialize, FromRow, Debug, Clone)]
pub struct ConnectionFolderRow {
    pub id: Uuid,
    pub name: String,
    pub parent_id: Option<Uuid>,
}

#[derive(Deserialize, Debug)]
pub struct FolderRequest {
    pub name: String,
    pub parent_id: Option<Uuid>,
}

pub async fn list_folders(pool: &Pool<Postgres>) -> Result<Vec<ConnectionFolderRow>, AppError> {
    let rows: Vec<ConnectionFolderRow> =
        sqlx::query_as("SELECT id, name, parent_id FROM connection_folders ORDER BY name")
            .fetch_all(pool)
            .await?;
    Ok(rows)
}

pub async fn list_folders_for_user(
    pool: &Pool<Postgres>,
    user_id: Uuid,
    see_all: bool,
) -> Result<Vec<ConnectionFolderRow>, AppError> {
    if see_all {
        return list_folders(pool).await;
    }

    let rows: Vec<ConnectionFolderRow> = sqlx::query_as(
        "WITH RECURSIVE active_folders AS (
            SELECT cf.id, cf.name, cf.parent_id
            FROM connection_folders cf
            WHERE cf.id IN (
                SELECT DISTINCT c.folder_id 
                FROM connections c
                JOIN users u ON u.id = $1
                WHERE c.soft_deleted_at IS NULL
                AND c.folder_id IS NOT NULL
                AND (
                    EXISTS (SELECT 1 FROM role_connections rc WHERE rc.role_id = u.role_id AND rc.connection_id = c.id)
                    OR
                    EXISTS (SELECT 1 FROM role_folders rf WHERE rf.role_id = u.role_id AND rf.folder_id = c.folder_id)
                )
            )
            
            UNION
            
            SELECT parent.id, parent.name, parent.parent_id
            FROM connection_folders parent
            JOIN active_folders child ON child.parent_id = parent.id
        )
        SELECT DISTINCT id, name, parent_id 
        FROM active_folders
        ORDER BY name"
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    Ok(rows)
}

pub async fn create_folder(
    pool: &Pool<Postgres>,
    body: &FolderRequest,
) -> Result<ConnectionFolderRow, AppError> {
    let row: ConnectionFolderRow = sqlx::query_as(
        "INSERT INTO connection_folders (name, parent_id) VALUES ($1, $2) RETURNING id, name, parent_id",
    )
    .bind(&body.name)
    .bind(body.parent_id)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn update_folder(
    pool: &Pool<Postgres>,
    id: Uuid,
    body: &FolderRequest,
) -> Result<Option<ConnectionFolderRow>, AppError> {
    let row: Option<ConnectionFolderRow> = sqlx::query_as(
        "UPDATE connection_folders SET name = $1, parent_id = $2 WHERE id = $3 RETURNING id, name, parent_id",
    )
    .bind(&body.name)
    .bind(body.parent_id)
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn delete_folder(
    pool: &Pool<Postgres>,
    id: Uuid,
) -> Result<Option<ConnectionFolderRow>, AppError> {
    let row: Option<ConnectionFolderRow> = sqlx::query_as(
        "DELETE FROM connection_folders WHERE id = $1 RETURNING id, name, parent_id",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Minimal fields used by `connection_info` to decide client-side auth prompts.
/// Tuple shape: (protocol, extra, watermark, name).
pub type ConnectionSessionInfo = (String, Option<serde_json::Value>, String, String);

/// Fetch protocol/extra/watermark/name for a non-soft-deleted connection.
pub async fn get_session_info(
    pool: &Pool<Postgres>,
    id: Uuid,
) -> Result<Option<ConnectionSessionInfo>, AppError> {
    let row = sqlx::query_as(
        "SELECT protocol, extra, watermark, name FROM connections WHERE id = $1 AND soft_deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Check whether `user_id` has role-based access (direct role→connection
/// or role→folder→connection) to `connection_id`.
pub async fn user_has_role_access(
    pool: &Pool<Postgres>,
    user_id: Uuid,
    connection_id: Uuid,
) -> Result<bool, AppError> {
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
    .bind(user_id)
    .bind(connection_id)
    .fetch_one(pool)
    .await?;
    Ok(has_access)
}

/// Tunnel-handshake fields for a non-soft-deleted connection:
/// (protocol, hostname, port, domain, name, extra).
pub type TunnelConnectionDetails = (
    String,
    String,
    i32,
    Option<String>,
    String,
    serde_json::Value,
);

/// Fetch protocol/hostname/port/domain/name/extra for the tunnel handshake.
pub async fn fetch_tunnel_details(
    pool: &Pool<Postgres>,
    id: Uuid,
) -> Result<Option<TunnelConnectionDetails>, AppError> {
    let row = sqlx::query_as(
        "SELECT protocol, hostname, port, domain, name, extra
         FROM connections
         WHERE id = $1 AND soft_deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Upsert `user_connection_access.last_accessed = now()` for `(user_id, connection_id)`.
pub async fn touch_user_access(
    pool: &Pool<Postgres>,
    user_id: Uuid,
    connection_id: Uuid,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO user_connection_access (user_id, connection_id, last_accessed)
         VALUES ($1, $2, now())
         ON CONFLICT (user_id, connection_id) DO UPDATE SET last_accessed = now()",
    )
    .bind(user_id)
    .bind(connection_id)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_search_pattern_matches_wildcards_literally() {
        assert_eq!(contains_pattern("50%_off\\"), "%50\\%\\_off\\\\%");
    }

    /// Needs `TEST_DATABASE_URL` pointing at a migrated database.
    #[tokio::test]
    async fn paged_listings_filter_authorise_and_count() {
        let Some(pool) = std::env::var("TEST_DATABASE_URL")
            .ok()
            .and_then(|url| sqlx::PgPool::connect_lazy(&url).ok())
        else {
            eprintln!("TEST_DATABASE_URL unset, skipping");
            return;
        };
        let tag = Uuid::new_v4().simple().to_string();
        let role: Uuid = sqlx::query_scalar("INSERT INTO roles (name) VALUES ($1) RETURNING id")
            .bind(format!("r-{tag}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        let user: Uuid = sqlx::query_scalar(
            "INSERT INTO users (username, email, role_id) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(format!("u-{tag}"))
        .bind(format!("{tag}@example.test"))
        .bind(role)
        .fetch_one(&pool)
        .await
        .unwrap();
        let folder = |name: String, parent: Option<Uuid>| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, Uuid>(
                    "INSERT INTO connection_folders (name, parent_id) VALUES ($1, $2) RETURNING id",
                )
                .bind(name)
                .bind(parent)
                .fetch_one(&pool)
                .await
                .unwrap()
            }
        };
        let a = folder(format!("a-{tag}"), None).await;
        let b = folder(format!("b-{tag}"), Some(a)).await;
        let conn = |name: &str,
                    protocol: &str,
                    folder: Option<Uuid>,
                    health: &str,
                    extra: serde_json::Value| {
            let pool = pool.clone();
            let name = format!("{tag}-{name}");
            let protocol = protocol.to_owned();
            let health = health.to_owned();
            async move {
                sqlx::query_scalar::<_, Uuid>(
                    "INSERT INTO connections (name, protocol, hostname, port, folder_id, health_status, extra)
                     VALUES ($1, $2, 'h', 1, $3, $4, $5) RETURNING id",
                )
                .bind(name)
                .bind(protocol)
                .bind(folder)
                .bind(health)
                .bind(extra)
                .fetch_one(&pool)
                .await
                .unwrap()
            }
        };
        let c1 = conn(
            "c1",
            "rdp",
            Some(a),
            "online",
            json!({"ignore-cert": "true"}),
        )
        .await;
        let c2 = conn("c2", "ssh", Some(b), "offline", json!({})).await;
        let c3 = conn("c3", "rdp", None, "unknown", json!({})).await;
        let c4 = conn("c4", "ssh", Some(b), "unknown", json!({"host-key": "k"})).await;
        // A folder grant covers only connections filed directly in it.
        sqlx::query("INSERT INTO role_folders (role_id, folder_id) VALUES ($1, $2)")
            .bind(role)
            .bind(a)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO role_connections (role_id, connection_id) VALUES ($1, $2)")
            .bind(role)
            .bind(c3)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO user_favorites (user_id, connection_id) VALUES ($1, $2)")
            .bind(user)
            .bind(c3)
            .execute(&pool)
            .await
            .unwrap();

        let admin = |f: AdminConnectionQuery| {
            let pool = pool.clone();
            async move {
                let page = admin_page(&pool, &f, 50, 0).await.unwrap();
                (
                    page.total,
                    page.items.into_iter().map(|c| c.id).collect::<Vec<_>>(),
                )
            }
        };
        let mine = || AdminConnectionQuery {
            search: Some(tag.clone()),
            ..Default::default()
        };
        assert_eq!(admin(mine()).await, (4, vec![c1, c2, c3, c4]));
        let in_a = AdminConnectionQuery {
            folder: Some(a.to_string()),
            ..mine()
        };
        assert_eq!(admin(in_a).await, (3, vec![c1, c2, c4]), "subfolders count");
        let unfiled = AdminConnectionQuery {
            folder: Some("unfiled".into()),
            ..mine()
        };
        assert_eq!(admin(unfiled).await, (1, vec![c3]));
        let online = AdminConnectionQuery {
            health: Some("online".into()),
            ..mine()
        };
        assert_eq!(admin(online).await, (1, vec![c1]));
        let unknown = AdminConnectionQuery {
            health: Some("unknown".into()),
            ..mine()
        };
        assert_eq!(admin(unknown).await, (2, vec![c3, c4]));
        let ssh = AdminConnectionQuery {
            protocol: Some("ssh".into()),
            ..mine()
        };
        assert_eq!(admin(ssh).await, (2, vec![c2, c4]));
        let by_folder = AdminConnectionQuery {
            search: Some(format!("b-{tag}")),
            ..Default::default()
        };
        assert_eq!(
            admin(by_folder).await,
            (2, vec![c2, c4]),
            "folder name is searched"
        );
        let second = admin_page(&pool, &mine(), 2, 2).await.unwrap();
        assert_eq!(second.total, 4);
        assert_eq!(
            second.items.iter().map(|c| c.id).collect::<Vec<_>>(),
            vec![c3, c4]
        );
        let refs = admin_refs(
            &pool,
            &AdminConnectionQuery {
                folder: Some(b.to_string()),
                ..mine()
            },
        )
        .await
        .unwrap();
        assert_eq!(refs.iter().map(|r| r.id).collect::<Vec<_>>(), vec![c2, c4]);
        assert!(fleet_summary(&pool).await.unwrap().counts.unpinned >= 1);

        let user_q = |f: UserConnectionQuery| {
            let pool = pool.clone();
            async move {
                let page = user_page(&pool, user, false, &f, 50, 0).await.unwrap();
                (
                    page.total,
                    page.items.into_iter().map(|c| c.id).collect::<Vec<_>>(),
                )
            }
        };
        assert_eq!(
            user_q(UserConnectionQuery::default()).await,
            (2, vec![c1, c3]),
            "only granted"
        );
        let in_a = UserConnectionQuery {
            folder: Some(a.to_string()),
            ..Default::default()
        };
        assert_eq!(user_q(in_a).await, (1, vec![c1]));
        let none = UserConnectionQuery {
            folder: Some("none".into()),
            ..Default::default()
        };
        assert_eq!(user_q(none).await, (1, vec![c3]));
        let favs = UserConnectionQuery {
            favorites: Some(true),
            ..Default::default()
        };
        assert_eq!(user_q(favs).await, (1, vec![c3]));

        // Walking with cursors returns each row once, even if one is renamed mid-walk.
        let first = user_page(&pool, user, false, &UserConnectionQuery::default(), 1, 0)
            .await
            .unwrap();
        assert_eq!(first.items[0].id, c1);
        sqlx::query("UPDATE connections SET name = $1 WHERE id = $2")
            .bind(format!("{tag}-c0"))
            .bind(c1)
            .execute(&pool)
            .await
            .unwrap();
        let after = |next: Option<String>| UserConnectionQuery {
            after: next,
            ..Default::default()
        };
        let second = user_page(&pool, user, false, &after(first.next), 1, 0)
            .await
            .unwrap();
        assert_eq!(second.items[0].id, c3);
        let third = user_page(&pool, user, false, &after(second.next), 1, 0)
            .await
            .unwrap();
        assert!(third.items.is_empty() && third.next.is_none());
        sqlx::query("UPDATE connections SET name = $1 WHERE id = $2")
            .bind(format!("{tag}-c1"))
            .bind(c1)
            .execute(&pool)
            .await
            .unwrap();
        assert!(user_page(
            &pool,
            user,
            false,
            &after(Some("not-a-cursor".into())),
            1,
            0
        )
        .await
        .is_err());

        let only = |ids: String| UserConnectionQuery {
            ids: Some(ids),
            ..Default::default()
        };
        assert_eq!(
            user_q(only(format!("{c3},{c2}"))).await,
            (1, vec![c3]),
            "ids never widen access"
        );

        let label: Uuid =
            sqlx::query_scalar("INSERT INTO admin_tags (name) VALUES ($1) RETURNING id")
                .bind(format!("t{tag}"))
                .fetch_one(&pool)
                .await
                .unwrap();
        sqlx::query("INSERT INTO admin_connection_tags (tag_id, connection_id) VALUES ($1, $2)")
            .bind(label)
            .bind(c3)
            .execute(&pool)
            .await
            .unwrap();
        let by_tag = UserConnectionQuery {
            search: Some(format!("t{tag}")),
            ..Default::default()
        };
        assert_eq!(
            user_q(by_tag).await,
            (1, vec![c3]),
            "tag names are searched"
        );
        sqlx::query("DELETE FROM admin_tags WHERE id = $1")
            .bind(label)
            .execute(&pool)
            .await
            .unwrap();
        let only = UserConnectionQuery {
            ids: Some(format!("{c3},{c2}")),
            ..Default::default()
        };
        assert_eq!(user_q(only).await, (1, vec![c3]), "ids stay authorised");

        let user_tag: Uuid = sqlx::query_scalar(
            "INSERT INTO user_tags (user_id, name) VALUES ($1, $2) RETURNING id",
        )
        .bind(user)
        .bind(format!("ut-{tag}"))
        .fetch_one(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO user_connection_tags (user_id, connection_id, tag_id) VALUES ($1, $2, $3)",
        )
        .bind(user)
        .bind(c1)
        .bind(user_tag)
        .execute(&pool)
        .await
        .unwrap();
        let admin_tag: Uuid =
            sqlx::query_scalar("INSERT INTO admin_tags (name) VALUES ($1) RETURNING id")
                .bind(format!("at-{tag}"))
                .fetch_one(&pool)
                .await
                .unwrap();
        sqlx::query("INSERT INTO admin_connection_tags (tag_id, connection_id) VALUES ($1, $2)")
            .bind(admin_tag)
            .bind(c3)
            .execute(&pool)
            .await
            .unwrap();
        let search = |s: String| UserConnectionQuery {
            search: Some(s),
            ..Default::default()
        };
        assert_eq!(user_q(search(format!("ut-{tag}"))).await, (1, vec![c1]));
        assert_eq!(user_q(search(format!("at-{tag}"))).await, (1, vec![c3]));

        // Same last-opened time, so the cursor has to break the tie by name.
        sqlx::query(
            "INSERT INTO user_connection_access (user_id, connection_id, last_accessed)
             SELECT $1, unnest($2::uuid[]), now()",
        )
        .bind(user)
        .bind(vec![c1, c3])
        .execute(&pool)
        .await
        .unwrap();
        for sort in [None, Some("recent".to_owned())] {
            let mut seen = Vec::new();
            let mut after = None;
            loop {
                let f = UserConnectionQuery {
                    sort: sort.clone(),
                    after: after.take(),
                    ..Default::default()
                };
                let page = user_page(&pool, user, false, &f, 1, 0).await.unwrap();
                assert_eq!(page.total, 2);
                seen.extend(page.items.iter().map(|c| c.id));
                match page.next {
                    Some(n) => after = Some(n),
                    None => break,
                }
            }
            assert_eq!(seen, vec![c1, c3], "{sort:?}");
        }
        assert!(user_page(
            &pool,
            user,
            false,
            &UserConnectionQuery {
                after: Some("not-a-cursor".into()),
                ..Default::default()
            },
            1,
            0,
        )
        .await
        .is_err());
        let facets = user_facets(
            &pool,
            user,
            false,
            &UserConnectionQuery {
                // The dash keeps it from matching inside the random hex tag.
                search: Some("-c1".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            (facets.total, facets.search_total, facets.all_total),
            (1, 1, 2)
        );
        assert_eq!(facets.protocols, vec!["rdp".to_owned()]);
        assert_eq!(facets.folders.len(), 1);
        assert_eq!(facets.folders[0].folder_id, Some(a));

        let users = crate::services::users::page(
            &pool,
            &crate::services::users::UserPageQuery {
                search: Some(tag.clone()),
                role_id: Some(role),
                ..Default::default()
            },
            50,
            0,
        )
        .await
        .unwrap();
        assert_eq!((users.total, users.items[0].id), (1, user));
        let by_tag = |after: Option<String>| crate::services::users::UserPageQuery {
            search: Some(tag.clone()),
            after,
            ..Default::default()
        };
        let first = crate::services::users::page(&pool, &by_tag(None), 1, 0)
            .await
            .unwrap();
        assert_eq!(first.items[0].id, user);
        let rest = crate::services::users::page(&pool, &by_tag(first.next), 1, 0)
            .await
            .unwrap();
        assert!(rest.items.is_empty() && rest.next.is_none());
        let refs = |f: crate::services::users::UserRefQuery| {
            let pool = pool.clone();
            async move {
                crate::services::users::refs(&pool, &f)
                    .await
                    .unwrap()
                    .into_iter()
                    .map(|u| u.id)
                    .collect::<Vec<_>>()
            }
        };
        assert_eq!(
            refs(crate::services::users::UserRefQuery {
                search: Some(tag.clone()),
                ..Default::default()
            })
            .await,
            vec![user]
        );
        assert_eq!(
            refs(crate::services::users::UserRefQuery {
                ids: Some(user.to_string()),
                ..Default::default()
            })
            .await,
            vec![user]
        );

        sqlx::query("DELETE FROM admin_tags WHERE id = $1")
            .bind(admin_tag)
            .execute(&pool)
            .await
            .unwrap();

        for id in [c1, c2, c3, c4] {
            sqlx::query("DELETE FROM connections WHERE id = $1")
                .bind(id)
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query("DELETE FROM connection_folders WHERE id = ANY($1)")
            .bind(vec![b, a])
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM roles WHERE id = $1")
            .bind(role)
            .execute(&pool)
            .await
            .unwrap();
    }

    #[test]
    fn redact_hides_every_secret_but_keeps_other_extras() {
        let mut extra = json!({
            "sftp-password": "vault:{}",
            "private-key": "-----BEGIN",
            "passphrase": "",
            "color-depth": "24",
        });
        redact_secret_extras(&mut extra);
        assert_eq!(extra["sftp-password"], SECRET_PLACEHOLDER);
        assert_eq!(extra["private-key"], SECRET_PLACEHOLDER);
        assert_eq!(extra["passphrase"], "");
        assert_eq!(extra["color-depth"], "24");
    }

    #[tokio::test]
    async fn placeholder_keeps_stored_secret_or_drops_it() {
        let existing = json!({ "sftp-password": "vault:stored" });
        let mut extra =
            json!({ "sftp-password": SECRET_PLACEHOLDER, "passphrase": SECRET_PLACEHOLDER });
        seal_secret_extras(None, &mut extra, Some(&existing))
            .await
            .unwrap();
        assert_eq!(extra["sftp-password"], "vault:stored");
        assert!(extra.get("passphrase").is_none());
    }

    #[tokio::test]
    async fn new_secret_requires_vault_and_plaintext() {
        let mut extra = json!({ "password": "hunter2" });
        assert!(seal_secret_extras(None, &mut extra, None).await.is_err());
        let mut forged = json!({ "password": "vault:{\"ct\":\"\"}" });
        assert!(seal_secret_extras(None, &mut forged, None).await.is_err());
    }

    #[tokio::test]
    async fn plaintext_legacy_values_pass_through_unseal() {
        let mut extra =
            std::collections::HashMap::from([("sftp-password".to_string(), "legacy".to_string())]);
        unseal_secret_extras(None, &mut extra).await.unwrap();
        assert_eq!(extra["sftp-password"], "legacy");
    }

    #[test]
    fn normalize_extra_null_becomes_empty_object() {
        let out = normalize_extra(&serde_json::Value::Null);
        assert_eq!(out, json!({}));
    }

    #[test]
    fn normalize_extra_passes_through_object() {
        let input = json!({ "ignore-cert": true, "security": "nla" });
        let out = normalize_extra(&input);
        assert_eq!(out, input);
    }

    #[test]
    fn normalize_extra_passes_through_array() {
        // Schema-wise extra is expected to be an object, but the helper
        // intentionally only special-cases null. Anything non-null is
        // passed through verbatim so the caller can validate elsewhere.
        let input = json!([1, 2, 3]);
        let out = normalize_extra(&input);
        assert_eq!(out, input);
    }

    #[test]
    fn create_connection_request_defaults() {
        let body: CreateConnectionRequest = serde_json::from_value(json!({
            "name": "prod-rdp",
            "protocol": "rdp",
            "hostname": "host.example.com",
        }))
        .unwrap();
        assert_eq!(body.name, "prod-rdp");
        assert_eq!(body.protocol, "rdp");
        assert_eq!(body.hostname, "host.example.com");
        assert!(body.port.is_none());
        // #[serde(default)] fields populate without being in the payload
        assert_eq!(body.description, "");
        assert!(body.extra.is_null());
        // default_watermark()
        assert_eq!(body.watermark, "inherit");
    }

    #[test]
    fn create_connection_request_explicit_watermark() {
        let body: CreateConnectionRequest = serde_json::from_value(json!({
            "name": "x",
            "protocol": "ssh",
            "hostname": "h",
            "watermark": "always",
        }))
        .unwrap();
        assert_eq!(body.watermark, "always");
    }

    #[test]
    fn create_connection_request_extra_can_be_object() {
        let body: CreateConnectionRequest = serde_json::from_value(json!({
            "name": "x",
            "protocol": "vnc",
            "hostname": "h",
            "extra": { "ignore-cert": true },
        }))
        .unwrap();
        assert_eq!(body.extra, json!({ "ignore-cert": true }));
    }

    #[test]
    fn folder_request_root_folder_has_null_parent() {
        let body: FolderRequest = serde_json::from_value(json!({ "name": "Production" })).unwrap();
        assert_eq!(body.name, "Production");
        assert!(body.parent_id.is_none());
    }

    #[test]
    fn select_columns_lists_every_connection_row_field() {
        // SELECT_COLUMNS must stay in lock-step with ConnectionRow.
        for col in [
            "id",
            "name",
            "protocol",
            "hostname",
            "port",
            "domain",
            "description",
            "folder_id",
            "extra",
            "last_accessed",
            "watermark",
            "health_status",
            "health_checked_at",
        ] {
            assert!(
                SELECT_COLUMNS.contains(col),
                "SELECT_COLUMNS missing `{col}`"
            );
        }
    }

    #[test]
    fn connection_row_serialize_shape() {
        let row = ConnectionRow {
            id: Uuid::nil(),
            name: "prod".into(),
            protocol: "rdp".into(),
            hostname: "h".into(),
            port: 3389,
            domain: Some("CORP".into()),
            description: "".into(),
            folder_id: None,
            extra: json!({}),
            last_accessed: None,
            watermark: "inherit".into(),
            health_status: "unknown".into(),
            health_checked_at: None,
        };
        let v = serde_json::to_value(&row).unwrap();
        assert_eq!(v["protocol"], json!("rdp"));
        assert_eq!(v["port"], json!(3389));
        assert_eq!(v["domain"], json!("CORP"));
        assert!(v.get("soft_deleted_at").is_none(), "leaked tombstone field");
    }
}
