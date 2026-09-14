//! Target hostname resolution against operator-configured nameservers.
//!
//! The backend container's own resolver has to keep pointing at Docker's
//! embedded DNS, because that is what finds `postgres-local`, `vault` and
//! `clamav`. Overwriting `/etc/resolv.conf` would lose them, and appending
//! nameservers after the embedded one does not help either: glibc only
//! moves to the next server on timeout or SERVFAIL, never on the NXDOMAIN
//! that Docker returns for a name it does not know.
//!
//! So target lookups happen here instead, against the nameservers an
//! administrator set on the Network tab, leaving infrastructure lookups
//! on the system resolver. Only the *socket* uses the result — the
//! hostname still goes to TLS verification and the Kerberos SPN, so a
//! pre-resolved connection authenticates exactly as a name-based one.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use hickory_resolver::config::{NameServerConfig, ResolveHosts, ResolverConfig, ResolverOpts};
use hickory_resolver::net::runtime::TokioRuntimeProvider;
use hickory_resolver::proto::rr::Name;
use hickory_resolver::TokioResolver;
use tokio::sync::RwLock;

use crate::services::settings;

/// How long to wait on the operator's nameservers before giving up and
/// letting the system resolver try. A target that is slow to resolve is
/// still better served late than refused.
const TIMEOUT: Duration = Duration::from_secs(5);

/// Nameservers and search domains as configured, or `None` when the
/// feature is switched off.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct DnsSettings {
    pub servers: Vec<IpAddr>,
    pub search: Vec<String>,
}

/// Parse the stored settings into something resolvable.
///
/// Entries may carry a `:port` suffix, which the admin form accepts;
/// resolution uses port 53 regardless, so the suffix is dropped rather
/// than rejected.
fn parse(servers: &str, search: &str) -> DnsSettings {
    let servers = servers
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter_map(|entry| {
            entry
                .parse::<IpAddr>()
                .ok()
                .or_else(|| entry.rsplit_once(':').and_then(|(ip, _)| ip.parse().ok()))
        })
        .collect();
    let search = search
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    DnsSettings { servers, search }
}

/// Read the DNS settings an administrator saved.
pub async fn load(pool: &sqlx::Pool<sqlx::Postgres>) -> Option<DnsSettings> {
    let enabled = settings::get(pool, "dns_enabled")
        .await
        .ok()
        .flatten()
        .is_some_and(|v| v == "true");
    if !enabled {
        return None;
    }
    let servers = settings::get(pool, "dns_servers")
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let search = settings::get(pool, "dns_search_domains")
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let parsed = parse(&servers, &search);
    (!parsed.servers.is_empty()).then_some(parsed)
}

/// The resolver, rebuilt only when the settings actually change.
///
/// Rebuilding per session would be wasteful, and caching without the
/// settings alongside would mean an administrator's edit never took
/// effect until a restart — the exact failure this feature had.
static CACHE: RwLock<Option<(DnsSettings, Arc<TokioResolver>)>> = RwLock::const_new(None);

async fn resolver_for(cfg: &DnsSettings) -> Arc<TokioResolver> {
    if let Some((cached_cfg, resolver)) = CACHE.read().await.as_ref() {
        if cached_cfg == cfg {
            return Arc::clone(resolver);
        }
    }

    let name_servers: Vec<NameServerConfig> = cfg
        .servers
        .iter()
        .copied()
        .map(NameServerConfig::udp_and_tcp)
        .collect();

    let mut search = Vec::new();
    for domain in &cfg.search {
        if let Ok(name) = domain.parse::<Name>() {
            search.push(name);
        }
    }

    let config = ResolverConfig::from_parts(None, search, name_servers);

    let mut opts = ResolverOpts::default();
    opts.timeout = TIMEOUT;
    opts.attempts = 1;
    // A short name entered as `server01` only resolves once the search
    // suffix is appended, which is the whole point of configuring one.
    opts.ndots = 1;
    // `/etc/hosts` belongs to the container, not to the target network.
    opts.use_hosts_file = ResolveHosts::Never;

    let resolver = Arc::new(
        TokioResolver::builder_with_config(config, TokioRuntimeProvider::default())
            .with_options(opts)
            .build()
            .expect("failed to build DNS resolver"),
    );
    *CACHE.write().await = Some((cfg.clone(), Arc::clone(&resolver)));
    resolver
}

/// Resolve `hostname` against the configured nameservers.
///
/// Returns `None` whenever the caller should just hand the hostname to
/// the system resolver: the feature is off, the name is already an
/// address, or the lookup found nothing. Failing open matters — a
/// misconfigured nameserver should not take every session down with it,
/// and the system resolver still reaches anything on public DNS.
pub async fn resolve(cfg: &DnsSettings, hostname: &str) -> Option<IpAddr> {
    if hostname.parse::<IpAddr>().is_ok() {
        return None;
    }
    let resolver = resolver_for(cfg).await;
    match resolver.lookup_ip(hostname).await {
        Ok(response) => {
            let addr = response.iter().next();
            match addr {
                Some(ip) => tracing::debug!(hostname, %ip, "resolved target via custom DNS"),
                None => tracing::warn!(hostname, "custom DNS returned no address"),
            }
            addr
        }
        Err(e) => {
            tracing::warn!(
                hostname,
                error = %e,
                "custom DNS lookup failed; falling back to the system resolver"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_addresses() {
        let cfg = parse("10.119.32.9, 10.119.33.9", "capita-ics.dmz.local");
        assert_eq!(
            cfg.servers,
            vec![
                "10.119.32.9".parse::<IpAddr>().unwrap(),
                "10.119.33.9".parse::<IpAddr>().unwrap()
            ]
        );
        assert_eq!(cfg.search, vec!["capita-ics.dmz.local".to_owned()]);
    }

    /// The admin form accepts `ip:port`, so the parser has to survive it
    /// rather than silently dropping the server.
    #[test]
    fn keeps_a_server_written_with_a_port() {
        let cfg = parse("10.0.0.1:5353", "");
        assert_eq!(cfg.servers, vec!["10.0.0.1".parse::<IpAddr>().unwrap()]);
    }

    #[test]
    fn ignores_blank_and_unparseable_entries() {
        let cfg = parse("10.0.0.1, , not-an-ip", " a.local , ");
        assert_eq!(cfg.servers, vec!["10.0.0.1".parse::<IpAddr>().unwrap()]);
        assert_eq!(cfg.search, vec!["a.local".to_owned()]);
    }

    #[test]
    fn accepts_ipv6_servers() {
        let cfg = parse("2001:4860:4860::8888", "");
        assert_eq!(
            cfg.servers,
            vec!["2001:4860:4860::8888".parse::<IpAddr>().unwrap()]
        );
    }

    /// An address needs no lookup, and sending one through the resolver
    /// would turn a working connection into a dependency on DNS.
    #[tokio::test]
    async fn an_address_is_never_looked_up() {
        let cfg = DnsSettings {
            servers: vec!["10.0.0.1".parse().unwrap()],
            search: vec![],
        };
        assert!(resolve(&cfg, "192.168.1.10").await.is_none());
    }

    /// The behaviour the feature exists for: a bare short name reaching a
    /// host only because the search suffix was appended. Ignored by
    /// default because it needs a real nameserver — run it with
    /// `cargo test -p strata-backend search_suffix -- --ignored`.
    #[tokio::test]
    #[ignore = "requires outbound DNS"]
    async fn a_short_name_resolves_through_the_search_suffix() {
        let cfg = DnsSettings {
            servers: vec!["1.1.1.1".parse().unwrap()],
            search: vec!["example.com".to_owned()],
        };
        assert!(
            resolve(&cfg, "www").await.is_some(),
            "`www` should have resolved as www.example.com"
        );
    }

    /// Unreachable nameservers must not take the session with them.
    #[tokio::test]
    #[ignore = "waits out the resolver timeout"]
    async fn a_dead_nameserver_falls_back_rather_than_erroring() {
        let cfg = DnsSettings {
            // TEST-NET-1, guaranteed not to answer.
            servers: vec!["192.0.2.1".parse().unwrap()],
            search: vec![],
        };
        assert!(resolve(&cfg, "example.com").await.is_none());
    }
}
