//! DB operations for per-user tags, connection↔tag mappings, display
//! tags and the read-only admin_tags view.
//!
//! Extracted from [`crate::routes::user`] so route handlers can be thin
//! orchestration layers over a typed service boundary (§3.1 / W4-6).

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Pool, Postgres};
use uuid::Uuid;

#[derive(Serialize, FromRow, Debug, Clone)]
pub struct UserTag {
    pub id: Uuid,
    pub name: String,
    pub color: String,
}

#[derive(Deserialize, Debug)]
pub struct CreateTagRequest {
    pub name: String,
    pub color: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct UpdateTagRequest {
    pub name: Option<String>,
    pub color: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct SetConnectionTagsRequest {
    pub connection_id: Uuid,
    pub tag_ids: Vec<Uuid>,
}

#[derive(Deserialize, Debug)]
pub struct SetDisplayTagRequest {
    pub connection_id: Uuid,
    pub tag_id: Uuid,
}

// ── User tags (owned) ──────────────────────────────────────────────────

pub async fn list_for_user(pool: &Pool<Postgres>, user_id: Uuid) -> Result<Vec<UserTag>, AppError> {
    let tags: Vec<UserTag> =
        sqlx::query_as("SELECT id, name, color FROM user_tags WHERE user_id = $1 ORDER BY name")
            .bind(user_id)
            .fetch_all(pool)
            .await?;
    Ok(tags)
}

pub async fn create(
    pool: &Pool<Postgres>,
    user_id: Uuid,
    name: &str,
    color: &str,
) -> Result<UserTag, AppError> {
    let tag: UserTag = sqlx::query_as(
        "INSERT INTO user_tags (user_id, name, color) VALUES ($1, $2, $3)
         RETURNING id, name, color",
    )
    .bind(user_id)
    .bind(name)
    .bind(color)
    .fetch_one(pool)
    .await?;
    Ok(tag)
}

pub async fn update(
    pool: &Pool<Postgres>,
    tag_id: Uuid,
    user_id: Uuid,
    name: Option<&str>,
    color: Option<&str>,
) -> Result<Option<UserTag>, AppError> {
    let tag: Option<UserTag> = sqlx::query_as(
        "UPDATE user_tags SET
            name  = COALESCE($3, name),
            color = COALESCE($4, color)
         WHERE id = $1 AND user_id = $2
         RETURNING id, name, color",
    )
    .bind(tag_id)
    .bind(user_id)
    .bind(name)
    .bind(color)
    .fetch_optional(pool)
    .await?;
    Ok(tag)
}

/// Delete a tag owned by the given user. Returns `true` if removed.
pub async fn delete(pool: &Pool<Postgres>, tag_id: Uuid, user_id: Uuid) -> Result<bool, AppError> {
    let result = sqlx::query("DELETE FROM user_tags WHERE id = $1 AND user_id = $2")
        .bind(tag_id)
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Check whether the given tag belongs to the given user.
pub async fn user_owns_tag(
    pool: &Pool<Postgres>,
    tag_id: Uuid,
    user_id: Uuid,
) -> Result<bool, AppError> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM user_tags WHERE id = $1 AND user_id = $2)")
            .bind(tag_id)
            .bind(user_id)
            .fetch_one(pool)
            .await?;
    Ok(exists)
}

// ── Connection ↔ tag mappings ──────────────────────────────────────────

#[derive(FromRow)]
pub struct ConnectionTagRow {
    pub connection_id: Uuid,
    pub tag_id: Uuid,
}

pub async fn list_connection_tags(
    pool: &Pool<Postgres>,
    user_id: Uuid,
) -> Result<Vec<ConnectionTagRow>, AppError> {
    let rows: Vec<ConnectionTagRow> =
        sqlx::query_as("SELECT connection_id, tag_id FROM user_connection_tags WHERE user_id = $1")
            .bind(user_id)
            .fetch_all(pool)
            .await?;
    Ok(rows)
}

/// Atomically replace the tag list for a connection.
pub async fn set_connection_tags(
    pool: &Pool<Postgres>,
    user_id: Uuid,
    connection_id: Uuid,
    tag_ids: &[Uuid],
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM user_connection_tags WHERE user_id = $1 AND connection_id = $2")
        .bind(user_id)
        .bind(connection_id)
        .execute(&mut *tx)
        .await?;

    if !tag_ids.is_empty() {
        sqlx::query(
            "INSERT INTO user_connection_tags (user_id, connection_id, tag_id)
             SELECT $1, $2, unnest($3::uuid[])
             ON CONFLICT DO NOTHING",
        )
        .bind(user_id)
        .bind(connection_id)
        .bind(tag_ids)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

// ── Display tags (pinned per connection) ───────────────────────────────

#[derive(FromRow)]
pub struct DisplayTagRow {
    pub connection_id: Uuid,
    pub id: Uuid,
    pub name: String,
    pub color: String,
}

pub async fn list_display_tags(
    pool: &Pool<Postgres>,
    user_id: Uuid,
) -> Result<Vec<DisplayTagRow>, AppError> {
    let rows: Vec<DisplayTagRow> = sqlx::query_as(
        "SELECT d.connection_id, t.id, t.name, t.color
         FROM user_connection_display_tags d
         JOIN user_tags t ON t.id = d.tag_id
         WHERE d.user_id = $1",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn upsert_display_tag(
    pool: &Pool<Postgres>,
    user_id: Uuid,
    connection_id: Uuid,
    tag_id: Uuid,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO user_connection_display_tags (user_id, connection_id, tag_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, connection_id)
         DO UPDATE SET tag_id = $3",
    )
    .bind(user_id)
    .bind(connection_id)
    .bind(tag_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn remove_display_tag(
    pool: &Pool<Postgres>,
    user_id: Uuid,
    connection_id: Uuid,
) -> Result<(), AppError> {
    sqlx::query(
        "DELETE FROM user_connection_display_tags WHERE user_id = $1 AND connection_id = $2",
    )
    .bind(user_id)
    .bind(connection_id)
    .execute(pool)
    .await?;
    Ok(())
}

// ── Admin tags (read-only for regular users) ───────────────────────────

pub async fn list_admin_tags(pool: &Pool<Postgres>) -> Result<Vec<UserTag>, AppError> {
    let tags: Vec<UserTag> = sqlx::query_as("SELECT id, name, color FROM admin_tags ORDER BY name")
        .fetch_all(pool)
        .await?;
    Ok(tags)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn user_tag_round_trips_through_json() {
        let id = Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap();
        let t = UserTag {
            id,
            name: "prod".into(),
            color: "#ff0000".into(),
        };
        let v = serde_json::to_value(&t).unwrap();
        assert_eq!(v["id"], json!(id.to_string()));
        assert_eq!(v["name"], json!("prod"));
        assert_eq!(v["color"], json!("#ff0000"));
    }

    #[test]
    fn create_tag_request_accepts_optional_color() {
        let body: CreateTagRequest =
            serde_json::from_value(json!({ "name": "qa" })).unwrap();
        assert_eq!(body.name, "qa");
        assert!(body.color.is_none());

        let body: CreateTagRequest =
            serde_json::from_value(json!({ "name": "qa", "color": "#00ff00" })).unwrap();
        assert_eq!(body.color.as_deref(), Some("#00ff00"));
    }

    #[test]
    fn update_tag_request_allows_renaming_only() {
        let body: UpdateTagRequest =
            serde_json::from_value(json!({ "name": "renamed" })).unwrap();
        assert_eq!(body.name.as_deref(), Some("renamed"));
        assert!(body.color.is_none());
    }

    #[test]
    fn set_connection_tags_request_can_clear_all_tags() {
        let body: SetConnectionTagsRequest = serde_json::from_value(json!({
            "connection_id": "33333333-3333-3333-3333-333333333333",
            "tag_ids": [],
        }))
        .unwrap();
        assert!(body.tag_ids.is_empty());
    }

    #[test]
    fn set_display_tag_request_requires_both_ids() {
        let err = serde_json::from_value::<SetDisplayTagRequest>(json!({
            "connection_id": "33333333-3333-3333-3333-333333333333",
        }))
        .unwrap_err();
        assert!(err.to_string().contains("tag_id"));
    }
}

