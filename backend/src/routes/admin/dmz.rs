//! Admin-only DMZ link visibility.
//!
//! Surfaces the per-endpoint state of the inbound mTLS link supervisor
//! (`services::dmz_link`) so the admin UI can show "DMZ link up /
//! down / backoff" plus a force-reconnect button.
//!
//! Mounted at `/api/admin/dmz-links` (GET) and
//! `/api/admin/dmz-links/reconnect` (POST). Both go through the
//! existing `require_admin` + `require_auth` + `require_csrf` layer
//! stack, so authn / authz / CSRF are inherited from the parent
//! router.
//!
//! Phase 3c: read-only snapshot + lightweight "reconnect now" hook.
//! The hook does NOT physically tear down the connection (the
//! supervisor owns the socket); it instead nudges the supervisor by
//! marking every endpoint `Backoff` so the next supervisor tick
//! re-dials. A future Phase 4 may wire a CancellationToken-per-link
//! so a real "drop the socket NOW" verb is available.

use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::error::AppError;
use crate::services::app_state::SharedState;
use crate::services::dmz_link::{LinkState, LinkStatus};

/// One row in the response. Stable JSON shape — the frontend depends
/// on these field names.
#[derive(Debug, Serialize)]
pub struct DmzLinkRow {
    /// Configured endpoint URL.
    pub endpoint: String,
    /// Current state, one of: initializing, connecting, authenticating,
    /// up, backoff, stopped.
    pub state: &'static str,
    /// True iff this row counts toward `/readyz`.
    pub ready: bool,
    /// Reason for the most recent failure, if any.
    pub last_error: Option<String>,
    /// Wall-clock time of the most recent state transition (Unix
    /// seconds — frontend renders relative).
    pub since_unix_secs: u64,
    /// Total successful handshakes since process start.
    pub connects: u64,
    /// Total dial / handshake / runtime failures since process start.
    pub failures: u64,
}

impl From<LinkStatus> for DmzLinkRow {
    fn from(s: LinkStatus) -> Self {
        let since_unix_secs = s
            .since
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        DmzLinkRow {
            endpoint: s.endpoint,
            state: s.state.as_str(),
            ready: s.state.is_ready(),
            last_error: s.last_error,
            since_unix_secs,
            connects: s.connects,
            failures: s.failures,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct DmzLinksResponse {
    /// True if the supervisor is configured (DMZ mode is enabled).
    /// When false, `links` is empty and the admin UI should render
    /// "DMZ mode disabled" rather than "no links up".
    pub configured: bool,
    pub links: Vec<DmzLinkRow>,
}

/// `GET /api/admin/dmz-links` — snapshot every link.
pub async fn list_links(
    State(state): State<SharedState>,
) -> Result<Json<DmzLinksResponse>, AppError> {
    let registry = {
        let g = state.read().await;
        g.dmz_link_registry.clone()
    };
    let resp = match registry {
        None => DmzLinksResponse {
            configured: false,
            links: Vec::new(),
        },
        Some(r) => {
            let mut rows: Vec<DmzLinkRow> =
                r.snapshot().into_iter().map(DmzLinkRow::from).collect();
            // Stable ordering for the UI.
            rows.sort_by(|a, b| a.endpoint.cmp(&b.endpoint));
            DmzLinksResponse {
                configured: true,
                links: rows,
            }
        }
    };
    Ok(Json(resp))
}

#[derive(Debug, Serialize)]
pub struct ReconnectResponse {
    pub nudged: usize,
}

/// `POST /api/admin/dmz-links/reconnect` — best-effort "kick the
/// supervisor". Marks every link `Backoff` with `last_error =
/// "admin-requested reconnect"`, which causes the supervisor's next
/// tick to redial. Returns the number of endpoints touched.
pub async fn reconnect_links(
    State(state): State<SharedState>,
) -> Result<Json<ReconnectResponse>, AppError> {
    let registry = {
        let g = state.read().await;
        g.dmz_link_registry.clone()
    };
    let Some(registry) = registry else {
        return Ok(Json(ReconnectResponse { nudged: 0 }));
    };
    let snap = registry.snapshot();
    let mut nudged = 0usize;
    for s in &snap {
        registry.set_state(
            &s.endpoint,
            LinkState::Backoff,
            Some("admin-requested reconnect".into()),
        );
        nudged += 1;
    }
    tracing::info!(actor = "admin", count = nudged, "DMZ links nudged to reconnect");
    Ok(Json(ReconnectResponse { nudged }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(s: LinkState) -> LinkStatus {
        LinkStatus {
            endpoint: "https://dmz-1.example.com".into(),
            state: s,
            last_error: None,
            since: std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(42),
            connects: 3,
            failures: 1,
        }
    }

    #[test]
    fn row_from_status_maps_fields() {
        let row: DmzLinkRow = st(LinkState::Up).into();
        assert_eq!(row.endpoint, "https://dmz-1.example.com");
        assert_eq!(row.state, "up");
        assert!(row.ready);
        assert_eq!(row.since_unix_secs, 42);
        assert_eq!(row.connects, 3);
        assert_eq!(row.failures, 1);
    }

    #[test]
    fn row_from_backoff_is_not_ready() {
        let row: DmzLinkRow = st(LinkState::Backoff).into();
        assert_eq!(row.state, "backoff");
        assert!(!row.ready);
    }
}
