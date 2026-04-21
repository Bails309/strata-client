//! Retry helpers with full-jitter exponential backoff.
//!
//! Used by outbound integrations (Vault, LDAP, keytab, Azure) to re-attempt
//! calls that fail with transient errors without letting concurrent callers
//! retry in lockstep.
//!
//! The helpers are deliberately generic over the future + error type so each
//! integration can supply its own `is_transient` predicate — e.g. LDAP bind
//! errors like `invalidCredentials` (data 52e) must **not** retry, while I/O
//! resets and connect timeouts must.
//!
//! # Backoff formula
//!
//! For attempt `n` (1-indexed, i.e. the delay _before_ attempt `n+1`):
//!
//! ```text
//! base_ms * 2^(n-1)  *  jitter,   where jitter ~ U[0.5, 1.0)
//! ```
//!
//! This is the "full-jitter" variant recommended in the AWS Architecture
//! Blog (2015). It keeps the worst case bounded while decorrelating retries
//! across concurrent callers.

use rand::Rng;
use std::future::Future;
use std::time::Duration;

/// Run `op` up to `max_attempts` times, sleeping with full-jitter exponential
/// backoff between failures that pass the `is_transient` predicate.
///
/// * `op` — async closure producing `Result<T, E>`. Re-invoked from scratch on
///   each retry, so callers are responsible for rebuilding any short-lived
///   state (connections, handles) inside the closure.
/// * `is_transient` — predicate. Return `true` to retry, `false` to fail fast.
/// * `max_attempts` — total attempts, including the first. Minimum 1.
/// * `base_delay` — base for the exponential backoff calculation.
///
/// The final error is returned if every attempt fails (or if a non-transient
/// error is encountered). Errors from non-final attempts are logged at
/// `warn` level with the attempt number.
pub async fn retry_transient_with_jitter<F, Fut, T, E>(
    label: &str,
    mut op: F,
    is_transient: impl Fn(&E) -> bool,
    max_attempts: u32,
    base_delay: Duration,
) -> Result<T, E>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    let attempts = max_attempts.max(1);
    let mut last_err: Option<E> = None;

    for attempt in 1..=attempts {
        if attempt > 1 {
            let base_ms = base_delay.as_millis() as u64;
            let exp = base_ms.saturating_mul(2u64.pow(attempt - 2));
            let jitter: f64 = 0.5 + rand::rng().random::<f64>() * 0.5;
            let delay_ms = ((exp as f64) * jitter) as u64;
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }

        match op().await {
            Ok(value) => return Ok(value),
            Err(e) => {
                if !is_transient(&e) || attempt == attempts {
                    return Err(e);
                }
                tracing::warn!(
                    "{label}: attempt {attempt}/{attempts} failed (retrying): {e}"
                );
                last_err = Some(e);
            }
        }
    }

    // Unreachable — the loop always returns on the last iteration — but keep
    // the compiler and future refactors honest.
    Err(last_err.expect("retry loop must record an error before exiting"))
}

/// True when an LDAP-side error string looks like a **transient** network /
/// IO / timeout problem that can safely be retried.
///
/// Deliberately conservative: any sub-status code the server produced
/// (`rc=49`, `data 52e`, etc.) is NOT transient — those are terminal
/// authentication or policy failures and a retry would either lock out the
/// account or just produce the same error again.
pub fn is_ldap_transient(err: &anyhow::Error) -> bool {
    let msg = err.to_string().to_lowercase();

    // Explicit terminal markers — bail out fast.
    if msg.contains("rc=49")              // invalidCredentials family
        || msg.contains("invalidcredentials")
        || msg.contains("data 52e")       // wrong password
        || msg.contains("data 525")       // user not found
        || msg.contains("data 530")       // logon hours
        || msg.contains("data 531")       // workstation restriction
        || msg.contains("data 532")       // password expired
        || msg.contains("data 533")       // account disabled
        || msg.contains("data 52f")       // account restriction
        || msg.contains("data 701")       // account expired
        || msg.contains("data 773")       // must change password
        || msg.contains("data 775")       // locked out
        || msg.contains("rc=50")          // insufficientAccessRights
        || msg.contains("rc=32")          // noSuchObject
        || msg.contains("rc=34")          // invalidDNSyntax
        || msg.contains("rc=53")          // unwillingToPerform
    {
        return false;
    }

    // Transient markers — network / timeout / connect issues.
    msg.contains("timed out")
        || msg.contains("timeout")
        || msg.contains("connection reset")
        || msg.contains("connection refused")
        || msg.contains("connection closed")
        || msg.contains("broken pipe")
        || msg.contains("io error")
        || msg.contains("server not reachable")
        || msg.contains("network is unreachable")
        || msg.contains("temporary failure in name resolution")
        || msg.contains("no route to host")
}

/// True when an outbound HTTP error is transient: network blip, timeout,
/// connection reset, or a 5xx response from the server.
///
/// Used by Azure Blob and keytab retry wrappers (W3-4). We deliberately do
/// NOT retry on 4xx — a 403 from Azure means the SAS/shared key is wrong,
/// and retrying won't fix it.
pub fn is_http_transient(err: &anyhow::Error) -> bool {
    // Walk the error chain looking for a reqwest::Error we can classify
    // structurally rather than by string match.
    for cause in err.chain() {
        if let Some(re) = cause.downcast_ref::<reqwest::Error>() {
            if re.is_timeout() || re.is_connect() || re.is_request() {
                return true;
            }
            if let Some(status) = re.status() {
                return status.is_server_error();
            }
        }
    }

    let msg = err.to_string().to_lowercase();
    // Server error in a bail! message (e.g. "Azure Blob upload failed (503): ...")
    if msg.contains("(5") && msg.contains("): ") {
        return true;
    }
    msg.contains("timed out")
        || msg.contains("timeout")
        || msg.contains("connection reset")
        || msg.contains("connection refused")
        || msg.contains("connection closed")
        || msg.contains("broken pipe")
        || msg.contains("temporary failure in name resolution")
        || msg.contains("no route to host")
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::anyhow;

    // ── W4-7 / W4-8: classify errors for retry ────────────────────

    #[test]
    fn is_http_transient_detects_timeout_wording() {
        let e = anyhow!("operation timed out after 30s");
        assert!(is_http_transient(&e));
    }

    #[test]
    fn is_http_transient_detects_5xx_bail_message() {
        // Matches the shape used by bail!("Azure Blob upload failed ({}): {}", status, body)
        let e = anyhow!("Azure Blob upload failed (503): upstream unavailable");
        assert!(is_http_transient(&e));
    }

    #[test]
    fn is_http_transient_rejects_4xx_bail_message() {
        // 403 is a terminal auth failure — retrying is a waste and leaks quota.
        let e = anyhow!("Azure Blob upload failed (403): authorization failed");
        assert!(!is_http_transient(&e));
    }

    #[test]
    fn is_http_transient_rejects_arbitrary_error() {
        let e = anyhow!("malformed request body");
        assert!(!is_http_transient(&e));
    }

    #[test]
    fn is_http_transient_detects_connection_reset() {
        let e = anyhow!("Connection reset by peer");
        assert!(is_http_transient(&e));
    }

    #[test]
    fn is_ldap_transient_rejects_invalid_credentials() {
        // rc=49 (invalid credentials) must NOT be retried — retrying locks the
        // account out.
        let e = anyhow!("LDAP bind failed: rc=49 data 52e");
        assert!(!is_ldap_transient(&e));
    }

    #[test]
    fn is_ldap_transient_accepts_server_down() {
        let e = anyhow!("LDAP bind failed: Connection refused");
        assert!(is_ldap_transient(&e));
    }
}
