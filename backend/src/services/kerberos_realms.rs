//! DB operations for Kerberos realm configuration rows.
//!
//! Extracted from [`crate::routes::admin`] so route handlers can be thin
//! orchestration layers over a typed service boundary (§3.1 / W4-6).

use crate::error::AppError;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Pool, Postgres};
use uuid::Uuid;

#[derive(Serialize, FromRow, Debug, Clone)]
pub struct KerberosRealmRow {
    pub id: Uuid,
    pub realm: String,
    pub kdc_servers: String,
    pub admin_server: String,
    pub ticket_lifetime: String,
    pub renew_lifetime: String,
    pub is_default: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Deserialize, Debug)]
pub struct CreateKerberosRealmRequest {
    pub realm: String,
    pub kdc_servers: Vec<String>,
    pub admin_server: String,
    pub ticket_lifetime: Option<String>,
    pub renew_lifetime: Option<String>,
    pub is_default: Option<bool>,
}

#[derive(Deserialize, Debug)]
pub struct UpdateKerberosRealmRequest {
    pub realm: Option<String>,
    pub kdc_servers: Option<Vec<String>>,
    pub admin_server: Option<String>,
    pub ticket_lifetime: Option<String>,
    pub renew_lifetime: Option<String>,
    pub is_default: Option<bool>,
}

const SELECT_COLUMNS: &str =
    "id, realm, kdc_servers, admin_server, ticket_lifetime, renew_lifetime, is_default, created_at, updated_at";

/// List all realms ordered with default first.
pub async fn list_all(pool: &Pool<Postgres>) -> Result<Vec<KerberosRealmRow>, AppError> {
    let rows: Vec<KerberosRealmRow> = sqlx::query_as(&format!(
        "SELECT {SELECT_COLUMNS} FROM kerberos_realms ORDER BY is_default DESC, realm",
    ))
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Insert a new realm inside a transaction; if `is_default`, clears the
/// existing default in the same tx for atomicity.
pub async fn create(
    pool: &Pool<Postgres>,
    body: &CreateKerberosRealmRequest,
) -> Result<Uuid, AppError> {
    let ticket_lifetime = body.ticket_lifetime.as_deref().unwrap_or("10h");
    let renew_lifetime = body.renew_lifetime.as_deref().unwrap_or("7d");
    let is_default = body.is_default.unwrap_or(false);

    let mut tx = pool.begin().await?;

    if is_default {
        sqlx::query("UPDATE kerberos_realms SET is_default = false WHERE is_default = true")
            .execute(&mut *tx)
            .await?;
    }

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO kerberos_realms (realm, kdc_servers, admin_server, ticket_lifetime, renew_lifetime, is_default)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id",
    )
    .bind(&body.realm)
    .bind(body.kdc_servers.join(","))
    .bind(&body.admin_server)
    .bind(ticket_lifetime)
    .bind(renew_lifetime)
    .bind(is_default)
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(id)
}

/// Apply a partial update via COALESCE; returns `false` if the realm was
/// not found. Default flip is applied atomically within the same tx.
pub async fn update(
    pool: &Pool<Postgres>,
    realm_id: Uuid,
    body: &UpdateKerberosRealmRequest,
) -> Result<bool, AppError> {
    let mut tx = pool.begin().await?;

    if body.is_default == Some(true) {
        sqlx::query(
            "UPDATE kerberos_realms SET is_default = false WHERE is_default = true AND id != $1",
        )
        .bind(realm_id)
        .execute(&mut *tx)
        .await?;
    }

    let kdc_csv = body.kdc_servers.as_ref().map(|v| v.join(","));
    let result = sqlx::query(
        "UPDATE kerberos_realms SET
            realm = COALESCE($2, realm),
            kdc_servers = COALESCE($3, kdc_servers),
            admin_server = COALESCE($4, admin_server),
            ticket_lifetime = COALESCE($5, ticket_lifetime),
            renew_lifetime = COALESCE($6, renew_lifetime),
            is_default = COALESCE($7, is_default),
            updated_at = now()
         WHERE id = $1",
    )
    .bind(realm_id)
    .bind(body.realm.as_deref())
    .bind(kdc_csv.as_deref())
    .bind(body.admin_server.as_deref())
    .bind(body.ticket_lifetime.as_deref())
    .bind(body.renew_lifetime.as_deref())
    .bind(body.is_default)
    .execute(&mut *tx)
    .await?;

    if result.rows_affected() == 0 {
        return Ok(false);
    }

    tx.commit().await?;
    Ok(true)
}

/// Delete by id. Returns `false` if the realm was not found.
pub async fn delete(pool: &Pool<Postgres>, realm_id: Uuid) -> Result<bool, AppError> {
    let deleted = sqlx::query("DELETE FROM kerberos_realms WHERE id = $1")
        .bind(realm_id)
        .execute(pool)
        .await?;
    Ok(deleted.rows_affected() > 0)
}

/// Total realm count. Returns `0` on query failure (used for a best-effort
/// "disable kerberos_enabled when no realms remain" check).
pub async fn count(pool: &Pool<Postgres>) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM kerberos_realms")
        .fetch_one(pool)
        .await
        .unwrap_or(0)
}
