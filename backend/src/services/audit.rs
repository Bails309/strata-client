use crate::error::AppError;
use sqlx::{Pool, Postgres, QueryBuilder};
use uuid::Uuid;

/// Paginated audit-log row as returned to admin clients. Joins the author's
/// username and any connection referenced via `details->>'connection_id'`.
#[derive(serde::Serialize, sqlx::FromRow)]
pub struct AuditLogRow {
    pub id: i64,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub user_id: Option<Uuid>,
    pub username: Option<String>,
    pub action_type: String,
    pub details: serde_json::Value,
    pub current_hash: String,
    pub connection_name: Option<String>,
}

/// Optional filter set for [`list_paginated`]. Every field is an
/// `Option`; `None` means "do not filter on this column". Passing
/// `AuditFilters::default()` reproduces the previous unfiltered
/// behaviour.
#[derive(Default, Debug, Clone)]
pub struct AuditFilters {
    /// Exact match on `audit_logs.action_type`.
    pub action_type: Option<String>,
    /// Prefix match — matches `action_type` equal to the prefix or
    /// beginning with `<prefix>.` (so `tunnel` matches `tunnel.connected`
    /// and `tunnel.failed` but not `tunnels.x`).
    pub action_prefix: Option<String>,
    /// Case-insensitive substring match on `users.username`.
    pub username: Option<String>,
    /// Inclusive lower bound on `created_at`.
    pub from: Option<chrono::DateTime<chrono::Utc>>,
    /// Inclusive upper bound on `created_at`.
    pub to: Option<chrono::DateTime<chrono::Utc>>,
    /// Free-text substring search across `action_type`, the rendered
    /// `details` JSON, and the joined `connection_name`.
    pub search: Option<String>,
}

/// Fetch audit rows in reverse-chronological order (newest first), joined
/// with `users` and `connections` for display.
///
/// `before` is a keyset cursor (the last id of the previous page); when it
/// is set `offset` is ignored, so deep pages cost the same as the first.
/// Only the filters in use reach the SQL, so each combination gets a plan
/// that can use its indexes.
pub async fn list_paginated(
    pool: &Pool<Postgres>,
    limit: i64,
    offset: i64,
    before: Option<i64>,
    filters: &AuditFilters,
) -> Result<Vec<AuditLogRow>, AppError> {
    let mut q = QueryBuilder::<Postgres>::new(
        "SELECT a.id, a.created_at, a.user_id, u.username, a.action_type, a.details, a.current_hash,
                c.name AS connection_name
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN connections c ON c.id = (a.details->>'connection_id')::uuid
         WHERE TRUE",
    );
    if let Some(before) = before {
        q.push(" AND a.id < ").push_bind(before);
    }
    if let Some(action) = &filters.action_type {
        q.push(" AND a.action_type = ").push_bind(action);
    }
    if let Some(prefix) = &filters.action_prefix {
        q.push(" AND (a.action_type = ")
            .push_bind(prefix)
            .push(" OR a.action_type LIKE ")
            .push_bind(format!("{prefix}.%"))
            .push(")");
    }
    if let Some(username) = &filters.username {
        q.push(" AND a.user_id = ANY(ARRAY(SELECT id FROM users WHERE username ILIKE ")
            .push_bind(format!("%{username}%"))
            .push("))");
    }
    if let Some(from) = filters.from {
        q.push(" AND a.created_at >= ").push_bind(from);
    }
    if let Some(to) = filters.to {
        q.push(" AND a.created_at <= ").push_bind(to);
    }
    if let Some(search) = &filters.search {
        // Each branch is on `audit_logs` alone so the trigram and
        // connection-id indexes can serve it; `= ANY(ARRAY(..))` rather
        // than `IN (..)`, which the planner would run per row instead.
        let pattern = format!("%{search}%");
        q.push(" AND (a.action_type ILIKE ")
            .push_bind(pattern.clone())
            .push(" OR a.details::text ILIKE ")
            .push_bind(pattern.clone())
            .push(" OR a.details->>'connection_id' = ANY(ARRAY(SELECT id::text FROM connections WHERE name ILIKE ")
            .push_bind(pattern)
            .push(")))");
    }
    q.push(" ORDER BY a.id DESC LIMIT ").push_bind(limit);
    if before.is_none() {
        q.push(" OFFSET ").push_bind(offset);
    }
    let rows = q.build_query_as().fetch_all(pool).await?;
    Ok(rows)
}

/// Append an audit entry to the hash chain.
///
/// `audit_append` (migration 098) takes the chain lock, hashes the entry
/// with the previous digest and inserts it in one round trip.
pub async fn log(
    pool: &Pool<Postgres>,
    user_id: Option<Uuid>,
    action_type: &str,
    details: &serde_json::Value,
) -> anyhow::Result<()> {
    // Merge the verified DMZ edge attribution into `details._edge` if a
    // request-scoped context is active. This is the single integration
    // point for W6-4 (audit cross-check): every audit call site benefits
    // without per-route plumbing, and standalone deployments (no edge
    // headers configured) get the unmodified payload.
    let owned_details;
    let details = match crate::services::edge_header::current_edge_context() {
        Some(edge) if details.is_object() => {
            let mut map = details.as_object().cloned().unwrap_or_default();
            map.insert(
                "_edge".to_string(),
                serde_json::json!({
                    "client_ip": edge.client_ip,
                    "tls_version": edge.tls_version,
                    "tls_cipher": edge.tls_cipher,
                    "tls_ja3": edge.tls_ja3,
                    "user_agent": edge.user_agent,
                    "request_id": edge.request_id,
                    "link_id": edge.link_id,
                }),
            );
            owned_details = serde_json::Value::Object(map);
            &owned_details
        }
        _ => details,
    };

    sqlx::query("SELECT audit_append($1, $2, $3)")
        .bind(user_id)
        .bind(action_type)
        .bind(details)
        .execute(pool)
        .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs `TEST_DATABASE_URL` pointing at a migrated database.
    #[tokio::test]
    async fn keyset_pages_and_every_filter_run() {
        let Some(pool) = std::env::var("TEST_DATABASE_URL")
            .ok()
            .and_then(|url| sqlx::PgPool::connect_lazy(&url).ok())
        else {
            eprintln!("TEST_DATABASE_URL unset, skipping");
            return;
        };
        let action = format!("listtest.{}", Uuid::new_v4().simple());
        for n in 0..3 {
            log(&pool, None, &action, &serde_json::json!({ "n": n }))
                .await
                .unwrap();
        }
        let only = AuditFilters {
            action_type: Some(action.clone()),
            ..AuditFilters::default()
        };

        let first = list_paginated(&pool, 2, 0, None, &only).await.unwrap();
        assert_eq!(first.len(), 2);
        let rest = list_paginated(&pool, 2, 0, Some(first[1].id), &only)
            .await
            .unwrap();
        assert_eq!(rest.len(), 1);
        assert!(rest[0].id < first[1].id);
        assert_eq!(rest[0].details["n"], 0);

        let all = AuditFilters {
            action_type: Some(action.clone()),
            action_prefix: Some("listtest".into()),
            username: Some("nobody-has-this-name".into()),
            from: Some(chrono::Utc::now() - chrono::Duration::hours(1)),
            to: Some(chrono::Utc::now()),
            search: Some("\"n\": 1".into()),
        };
        assert!(list_paginated(&pool, 10, 0, None, &all)
            .await
            .unwrap()
            .is_empty());
        let searched = AuditFilters {
            username: None,
            ..all
        };
        let hits = list_paginated(&pool, 10, 0, None, &searched).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].details["n"], 1);
    }
}
