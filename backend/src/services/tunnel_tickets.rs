use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Instant;
use uuid::Uuid;

/// A one-time-use tunnel ticket that carries connection parameters
/// so that credentials never appear in WebSocket URLs.
#[allow(dead_code)]
pub struct TunnelTicket {
    pub user_id: Uuid,
    pub connection_id: Uuid,
    pub username: Option<String>,
    pub password: Option<String>,
    pub width: u32,
    pub height: u32,
    pub dpi: u32,
    pub ignore_cert: bool,
    pub created_at: Instant,
}

static TICKETS: LazyLock<Mutex<HashMap<String, TunnelTicket>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const TICKET_TTL_SECS: u64 = 30;

/// Create a ticket and return its opaque ID.
pub fn create(ticket: TunnelTicket) -> String {
    let id = Uuid::new_v4().to_string();
    let mut map = TICKETS.lock().unwrap();
    // Opportunistic purge of expired tickets
    map.retain(|_, t| t.created_at.elapsed().as_secs() < TICKET_TTL_SECS * 2);
    map.insert(id.clone(), ticket);
    id
}

/// Consume a ticket by its ID (one-time use). Returns `None` if not found or expired.
pub fn consume(id: &str) -> Option<TunnelTicket> {
    let mut map = TICKETS.lock().unwrap();
    let ticket = map.remove(id)?;
    if ticket.created_at.elapsed().as_secs() > TICKET_TTL_SECS {
        return None; // expired
    }
    Some(ticket)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_ticket() -> TunnelTicket {
        TunnelTicket {
            user_id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            username: Some("testuser".into()),
            password: Some("testpass".into()),
            width: 1920,
            height: 1080,
            dpi: 96,
            ignore_cert: false,
            created_at: Instant::now(),
        }
    }

    #[test]
    fn create_and_consume() {
        let ticket = make_ticket();
        let conn_id = ticket.connection_id;
        let id = create(ticket);
        assert!(!id.is_empty());

        let consumed = consume(&id).expect("ticket should be consumable");
        assert_eq!(consumed.connection_id, conn_id);
        assert_eq!(consumed.width, 1920);
    }

    #[test]
    fn consume_is_one_time() {
        let id = create(make_ticket());
        assert!(consume(&id).is_some());
        assert!(consume(&id).is_none()); // second consume fails
    }

    #[test]
    fn consume_nonexistent_returns_none() {
        assert!(consume("nonexistent-ticket-id").is_none());
    }

    #[test]
    fn expired_ticket_returns_none() {
        let ticket = TunnelTicket {
            created_at: Instant::now() - std::time::Duration::from_secs(TICKET_TTL_SECS + 10),
            ..make_ticket()
        };
        let id = create(ticket);
        assert!(consume(&id).is_none());
    }

    #[test]
    fn ticket_ttl_constant() {
        assert_eq!(TICKET_TTL_SECS, 30);
    }

    #[test]
    fn ticket_fields_preserved() {
        let uid = Uuid::new_v4();
        let cid = Uuid::new_v4();
        let ticket = TunnelTicket {
            user_id: uid,
            connection_id: cid,
            username: Some("alice".into()),
            password: Some("pass123".into()),
            width: 2560,
            height: 1440,
            dpi: 144,
            ignore_cert: true,
            created_at: Instant::now(),
        };
        let id = create(ticket);
        let consumed = consume(&id).unwrap();
        assert_eq!(consumed.user_id, uid);
        assert_eq!(consumed.connection_id, cid);
        assert_eq!(consumed.username.as_deref(), Some("alice"));
        assert_eq!(consumed.password.as_deref(), Some("pass123"));
        assert_eq!(consumed.width, 2560);
        assert_eq!(consumed.height, 1440);
        assert_eq!(consumed.dpi, 144);
        assert!(consumed.ignore_cert);
    }

    #[test]
    fn ticket_without_credentials() {
        let ticket = TunnelTicket {
            user_id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            username: None,
            password: None,
            width: 1920,
            height: 1080,
            dpi: 96,
            ignore_cert: false,
            created_at: Instant::now(),
        };
        let id = create(ticket);
        let consumed = consume(&id).unwrap();
        assert!(consumed.username.is_none());
        assert!(consumed.password.is_none());
    }

    #[test]
    fn create_returns_uuid_format() {
        let id = create(make_ticket());
        // UUIDs are 36 chars: 8-4-4-4-12
        assert_eq!(id.len(), 36);
        assert!(Uuid::parse_str(&id).is_ok());
    }
}
