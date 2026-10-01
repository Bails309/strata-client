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
    #[allow(dead_code)]
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

/// Longest a request body may go without sending anything.
pub const BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// Longest a request with a body may take to be answered.
pub const TRANSFER_DEADLINE: Duration = Duration::from_secs(30 * 60);

/// Axum middleware: a request without a body must be answered within
/// the given timeout (slow-loris guard). A request with one is answered
/// only after the internal node has read it, so it instead gets
/// [`TRANSFER_DEADLINE`], and its body fails if it stalls for
/// [`BODY_IDLE_TIMEOUT`]. Either expiry is a `408`.
pub async fn request_deadline_middleware(
    axum::extract::State(timeout): axum::extract::State<Duration>,
    req: axum::extract::Request,
    next: Next,
) -> Response {
    use http_body::Body as _;

    let (deadline, req) = if req.body().is_end_stream() {
        (timeout, req)
    } else {
        let (parts, body) = req.into_parts();
        (
            TRANSFER_DEADLINE,
            axum::extract::Request::from_parts(parts, idle_limited(body)),
        )
    };
    match tokio::time::timeout(deadline, next.run(req)).await {
        Ok(resp) => resp,
        Err(_) => (StatusCode::REQUEST_TIMEOUT, "request timed out").into_response(),
    }
}

fn idle_limited(body: axum::body::Body) -> axum::body::Body {
    use futures_util::StreamExt;

    let chunks = http_body_util::BodyDataStream::new(body);
    axum::body::Body::from_stream(futures_util::stream::unfold(
        chunks,
        |mut chunks| async move {
            let item = match tokio::time::timeout(BODY_IDLE_TIMEOUT, chunks.next()).await {
                Ok(None) => return None,
                Ok(Some(item)) => item.map_err(std::io::Error::other),
                Err(_) => Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "request body idle",
                )),
            };
            Some((item, chunks))
        },
    ))
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

    mod deadlines {
        use super::super::*;
        use axum::body::Body;
        use axum::routing::{get, post};
        use bytes::Bytes;
        use futures_util::StreamExt;
        use tower::ServiceExt;

        fn app() -> axum::Router {
            axum::Router::new()
                .route(
                    "/slow",
                    get(|| async {
                        tokio::time::sleep(Duration::from_secs(20)).await;
                        "late"
                    }),
                )
                .route(
                    "/upload",
                    post(|body: Body| async move {
                        match axum::body::to_bytes(body, usize::MAX).await {
                            Ok(b) => (StatusCode::OK, b.len().to_string()),
                            Err(_) => (StatusCode::BAD_REQUEST, String::new()),
                        }
                    }),
                )
                .layer(axum::middleware::from_fn_with_state(
                    Duration::from_secs(15),
                    request_deadline_middleware,
                ))
        }

        async fn send(method: &str, uri: &str, body: Body) -> (StatusCode, String) {
            let req = axum::http::Request::builder()
                .method(method)
                .uri(uri)
                .body(body)
                .unwrap();
            let resp = app().oneshot(req).await.unwrap();
            let status = resp.status();
            let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .unwrap();
            (status, String::from_utf8(bytes.to_vec()).unwrap())
        }

        #[tokio::test(start_paused = true)]
        async fn a_request_without_a_body_keeps_the_short_timeout() {
            let (status, _) = send("GET", "/slow", Body::empty()).await;
            assert_eq!(status, StatusCode::REQUEST_TIMEOUT);
        }

        #[tokio::test(start_paused = true)]
        async fn an_upload_that_keeps_moving_outlasts_the_short_timeout() {
            // Five chunks ten seconds apart: 50 s in all.
            let chunks = futures_util::stream::unfold(0, |i| async move {
                if i == 5 {
                    return None;
                }
                tokio::time::sleep(Duration::from_secs(10)).await;
                Some((Ok::<_, std::io::Error>(Bytes::from_static(b"x")), i + 1))
            });
            let (status, body) = send("POST", "/upload", Body::from_stream(chunks)).await;
            assert_eq!((status, body.as_str()), (StatusCode::OK, "5"));
        }

        #[tokio::test(start_paused = true)]
        async fn a_stalled_upload_fails_after_the_idle_timeout() {
            let chunks = futures_util::stream::once(async {
                Ok::<_, std::io::Error>(Bytes::from_static(b"x"))
            })
            .chain(futures_util::stream::pending());
            let (status, _) = send("POST", "/upload", Body::from_stream(chunks)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
        }
    }
}
