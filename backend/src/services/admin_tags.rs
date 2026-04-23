//! Admin-managed global tags (and their forced-assignment pivot to
//! connections). Extracted from [`crate::routes::admin`] and
//! [`crate::routes::user`].

use crate::error::AppError;
use sqlx::PgPool;
use uuid::Uuid;

/// Full row for an admin tag. Mirrors `admin_tags` table.
#[derive(Debug, serde::Serialize, serde::Deserialize, sqlx::FromRow)]
pub struct AdminTag {
    pub id: Uuid,
    pub name: String,
    pub color: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

pub async fn list_tags(pool: &PgPool) -> Result<Vec<AdminTag>, AppError> {
    let rows = sqlx::query_as("SELECT id, name, color, created_at FROM admin_tags ORDER BY name")
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

pub async fn create_tag(pool: &PgPool, name: &str, color: &str) -> Result<AdminTag, AppError> {
    let tag = sqlx::query_as(
        "INSERT INTO admin_tags (name, color) VALUES ($1, $2) RETURNING id, name, color, created_at",
    )
    .bind(name)
    .bind(color)
    .fetch_one(pool)
    .await?;
    Ok(tag)
}

pub async fn update_tag(
    pool: &PgPool,
    tag_id: Uuid,
    name: Option<&str>,
    color: Option<&str>,
) -> Result<AdminTag, AppError> {
    let tag = sqlx::query_as(
        "UPDATE admin_tags SET name = COALESCE($2, name), color = COALESCE($3, color) \
         WHERE id = $1 RETURNING id, name, color, created_at",
    )
    .bind(tag_id)
    .bind(name)
    .bind(color)
    .fetch_one(pool)
    .await?;
    Ok(tag)
}

pub async fn delete_tag(pool: &PgPool, tag_id: Uuid) -> Result<(), AppError> {
    sqlx::query("DELETE FROM admin_tags WHERE id = $1")
        .bind(tag_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// All `(connection_id, tag_id)` mappings across the system.
pub async fn list_all_connection_tag_pairs(pool: &PgPool) -> Result<Vec<(Uuid, Uuid)>, AppError> {
    let rows = sqlx::query_as("SELECT connection_id, tag_id FROM admin_connection_tags")
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

/// Replace the tag set for a connection transactionally.
pub async fn set_connection_tags(
    pool: &PgPool,
    connection_id: Uuid,
    tag_ids: &[Uuid],
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM admin_connection_tags WHERE connection_id = $1")
        .bind(connection_id)
        .execute(&mut *tx)
        .await?;
    if !tag_ids.is_empty() {
        sqlx::query(
            "INSERT INTO admin_connection_tags (connection_id, tag_id)
             SELECT $1, unnest($2::uuid[])
             ON CONFLICT DO NOTHING",
        )
        .bind(connection_id)
        .bind(tag_ids)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}
