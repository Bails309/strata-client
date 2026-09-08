//! Wake-on-LAN, so a target that is asleep can be reached.
//!
//! Protocol-independent and therefore not part of any engine: guacd
//! offers it on RDP, SSH and VNC alike, and it happens before a
//! connection is attempted rather than over one.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::Duration;

use tokio::net::UdpSocket;

/// Default port for the magic packet. Nothing listens on it: the packet
/// is read by the network card, so the port only has to be one a switch
/// will forward as a broadcast.
pub const DEFAULT_PORT: u16 = 9;

/// Broadcast address used when the connection does not name one.
pub const DEFAULT_BROADCAST: &str = "255.255.255.255";

/// Build the magic packet for `mac`.
///
/// Returns `None` when the address is not six hex octets, because
/// broadcasting a malformed packet would wake nothing and report
/// success.
#[must_use]
pub fn magic_packet(mac: &str) -> Option<[u8; 102]> {
    let mut octets = [0u8; 6];
    let mut seen = 0;
    for part in mac.split([':', '-']) {
        let part = part.trim();
        if part.len() != 2 || seen == 6 {
            return None;
        }
        octets[seen] = u8::from_str_radix(part, 16).ok()?;
        seen += 1;
    }
    if seen != 6 {
        return None;
    }

    let mut packet = [0xFFu8; 102];
    let (repeats, _) = packet[6..].as_chunks_mut::<6>();
    for repeat in repeats {
        repeat.copy_from_slice(&octets);
    }
    Some(packet)
}

/// Errors that stop a target being woken.
#[derive(Debug, thiserror::Error)]
pub enum WolError {
    /// The MAC address could not be parsed.
    #[error("`{0}` is not a MAC address")]
    Mac(String),
    /// The broadcast address could not be resolved.
    #[error("`{0}` is not a broadcast address")]
    Broadcast(String),
    /// The packet could not be sent.
    #[error("sending the magic packet failed: {0}")]
    Send(#[from] std::io::Error),
}

/// Broadcast a magic packet for `mac`, then wait `settle` for the target
/// to finish booting.
///
/// The wait is the caller's whole point: a machine that has just been
/// woken refuses connections for some seconds, and connecting too early
/// reports the target as down.
pub async fn wake(mac: &str, broadcast: &str, port: u16, settle: Duration) -> Result<(), WolError> {
    let packet = magic_packet(mac).ok_or_else(|| WolError::Mac(mac.to_owned()))?;
    let target: Ipv4Addr = broadcast
        .trim()
        .parse()
        .map_err(|_| WolError::Broadcast(broadcast.to_owned()))?;

    let socket = UdpSocket::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0))).await?;
    socket.set_broadcast(true)?;
    socket
        .send_to(&packet, SocketAddrV4::new(target, port))
        .await?;

    tracing::info!(%mac, %broadcast, port, "sent wake-on-lan packet");
    if !settle.is_zero() {
        tokio::time::sleep(settle).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_magic_packet_is_six_ones_then_the_address_sixteen_times() {
        let packet = magic_packet("01:02:03:04:05:06").expect("valid mac");
        assert_eq!(&packet[..6], &[0xFF; 6]);
        let (repeats, _) = packet[6..].as_chunks::<6>();
        for repeat in repeats {
            assert_eq!(repeat, &[1, 2, 3, 4, 5, 6]);
        }
    }

    #[test]
    fn hyphens_are_accepted_as_well_as_colons() {
        assert_eq!(
            magic_packet("AA-BB-CC-DD-EE-FF"),
            magic_packet("aa:bb:cc:dd:ee:ff")
        );
    }

    /// A malformed address must not be broadcast: it would wake nothing
    /// and report success.
    #[test]
    fn an_address_that_is_not_six_octets_is_refused() {
        assert!(magic_packet("01:02:03:04:05").is_none());
        assert!(magic_packet("01:02:03:04:05:06:07").is_none());
        assert!(magic_packet("01:02:03:04:05:zz").is_none());
        assert!(magic_packet("1:2:3:4:5:6").is_none());
        assert!(magic_packet("").is_none());
    }
}
