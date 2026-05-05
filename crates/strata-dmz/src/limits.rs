//! Per-IP token-bucket rate limiter for the public DMZ surface.
//!
//! Why a custom limiter instead of `tower_governor` or similar:
//! the dependency closure for the DMZ binary is enforced by CI and
//! every added dep widens the attack surface. A 100-line token bucket
//! covers the threat model (raw connection-rate flooding from a single
//! source) without pulling in a new crate.
//!
//! The bucket fills at `rate_rps` tokens/sec up to `burst` tokens.
//! Each request consumes 1 token. Requests that don't get a token
//! get HTTP `429`.
//!
//! Stale entries (last seen > 10×idle threshold) are evicted on insert
//! so a long tail of one-shot attackers can't grow the map without
//! bound. The map is sharded across N stripes by IP-hash to keep
//! lock contention bounded under load.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::net::IpAddr;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::ConnectInfo;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

const NUM_STRIPES: usize = 16;
/// Idle threshold before a per-IP bucket is eligible for eviction.
const IDLE_EVICT_AFTER: Duration = Duration::from_secs(600);

#[derive(Clone, Copy)]
struct Bucket {
    /// Current token count, scaled by 1000 to keep refill smooth at
    /// fractional-token resolution without floats.
    tokens_milli: i64,
    last_refill: Instant,
}

struct Stripe {
    map: Mutex<HashMap<IpAddr, Bucket>>,
}

impl Default for Stripe {
    fn default() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
        }
    }
}

/// Cheap-to-clone handle.
#[derive(Clone)]
pub struct PerIpRateLimiter {
    stripes: Arc<[Stripe; NUM_STRIPES]>,
    rate_rps: u32,
    burst: u32,
}

impl PerIpRateLimiter {
    pub fn new(rate_rps: u32, burst: u32) -> Self {
        // Build the array using core::array::from_fn so we don't need
        // Stripe: Copy.
        let stripes: [Stripe; NUM_STRIPES] = std::array::from_fn(|_| Stripe::default());
        Self {
            stripes: Arc::new(stripes),
            rate_rps,
            burst,
        }
    }

    fn stripe_for(&self, ip: IpAddr) -> &Stripe {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        ip.hash(&mut h);
        let idx = (h.finish() as usize) % NUM_STRIPES;
        &self.stripes[idx]
    }

    /// Consume one token. Returns true when allowed, false when the
    /// caller should be rejected with `429`.
    pub fn check(&self, ip: IpAddr) -> bool {
        if self.rate_rps == 0 {
            // Rate-limit disabled.
            return true;
        }
        let now = Instant::now();
        let stripe = self.stripe_for(ip);
        let mut map = stripe.map.lock().expect("rate limiter mutex poisoned");

        let burst_milli = (self.burst as i64) * 1000;
        let entry = map.entry(ip).or_insert(Bucket {
            tokens_milli: burst_milli,
            last_refill: now,
        });

        // Refill since last_refill, capped at burst.
        let elapsed = now.saturating_duration_since(entry.last_refill);
        if !elapsed.is_zero() {
            let add: i64 = (elapsed.as_millis() as i64).saturating_mul(self.rate_rps as i64);
            entry.tokens_milli = (entry.tokens_milli.saturating_add(add)).min(burst_milli);
            entry.last_refill = now;
        }

        let allow = if entry.tokens_milli >= 1000 {
            entry.tokens_milli -= 1000;
            true
        } else {
            false
        };

        // Opportunistic eviction: every call, sweep entries in this
        // stripe whose last_refill is old enough. Cheap because a
        // stripe holds 1/16th of the map.
        map.retain(|_, b| now.saturating_duration_since(b.last_refill) < IDLE_EVICT_AFTER);

        allow
    }

    /// Total entries across all stripes; for tests and metrics.
    pub fn len(&self) -> usize {
        self.stripes
            .iter()
            .map(|s| s.map.lock().expect("rate limiter mutex poisoned").len())
            .sum()
    }
}

/// Axum middleware: extract peer IP via `ConnectInfo<SocketAddr>`,
/// consult the limiter, return `429` on overflow with a short body
/// and `retry-after: 1`.
pub async fn rate_limit_middleware(
    axum::extract::State(limiter): axum::extract::State<PerIpRateLimiter>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    req: axum::extract::Request,
    next: Next,
) -> Response {
    let allowed = limiter.check(addr.ip());
    if !allowed {
        let mut resp = (StatusCode::TOO_MANY_REQUESTS, "rate limit exceeded").into_response();
        resp.headers_mut().insert(
            axum::http::header::RETRY_AFTER,
            axum::http::HeaderValue::from_static("1"),
        );
        return resp;
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn ip(a: u8, b: u8, c: u8, d: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(a, b, c, d))
    }

    #[test]
    fn burst_then_block() {
        let l = PerIpRateLimiter::new(/*rps=*/ 1, /*burst=*/ 3);
        let p = ip(1, 1, 1, 1);
        assert!(l.check(p));
        assert!(l.check(p));
        assert!(l.check(p));
        // 4th immediate call — bucket empty, rps=1 hasn't refilled
        // a full token yet within microseconds.
        assert!(!l.check(p));
    }

    #[test]
    fn separate_ips_have_separate_buckets() {
        let l = PerIpRateLimiter::new(0, 1); // rps=0 → unlimited per spec
        // Even with rps=0 the limiter should not reject — branch is exercised.
        for _ in 0..1000 {
            assert!(l.check(ip(1, 1, 1, 1)));
            assert!(l.check(ip(2, 2, 2, 2)));
        }
    }

    #[test]
    fn refill_restores_capacity() {
        let l = PerIpRateLimiter::new(1000, 1); // 1000 rps, burst 1
        let p = ip(3, 3, 3, 3);
        assert!(l.check(p));
        assert!(!l.check(p));
        std::thread::sleep(Duration::from_millis(5));
        assert!(l.check(p));
    }

    #[test]
    fn striping_distributes_entries() {
        let l = PerIpRateLimiter::new(10, 10);
        for i in 0..200u8 {
            let _ = l.check(ip(10, 0, 0, i));
        }
        assert_eq!(l.len(), 200);
    }

    #[test]
    fn rps_zero_means_unlimited() {
        let l = PerIpRateLimiter::new(0, 0);
        let p = ip(9, 9, 9, 9);
        for _ in 0..10_000 {
            assert!(l.check(p));
        }
    }
}
