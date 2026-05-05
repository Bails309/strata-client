import { useEffect, useState } from "react";
import { updateDns } from "../../api";

export default function NetworkTab({
  settings,
  onSave,
}: {
  settings: Record<string, string>;
  onSave: () => void;
}) {
  const [dnsEnabled, setDnsEnabled] = useState(settings.dns_enabled === "true");
  const [dnsServers, setDnsServers] = useState(settings.dns_servers || "");
  const [dnsSearchDomains, setDnsSearchDomains] = useState(settings.dns_search_domains || "");
  const [saving, setSaving] = useState(false);
  const [restartNeeded, setRestartNeeded] = useState(false);

  useEffect(() => {
    setDnsEnabled(settings.dns_enabled === "true");
    setDnsServers(settings.dns_servers || "");
    setDnsSearchDomains(settings.dns_search_domains || "");
  }, [settings]);

  async function handleSave() {
    setSaving(true);
    setRestartNeeded(false);
    try {
      const res = await updateDns({
        dns_enabled: dnsEnabled,
        dns_servers: dnsServers.trim(),
        dns_search_domains: dnsSearchDomains.trim(),
      });
      if (res.restart_required) setRestartNeeded(true);
      onSave();
    } catch {
      /* handled by parent */
    }
    setSaving(false);
  }

  // Simple client-side validation of DNS server entries
  function validateServers(): string | null {
    if (!dnsEnabled || !dnsServers.trim()) return null;
    const entries = dnsServers
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const entry of entries) {
      // Accept ip or ip:port
      // Bounded \d{1,3} repetitions and a single optional port group — not ReDoS-vulnerable.
      // eslint-disable-next-line security/detect-unsafe-regex
      const ipPortMatch = entry.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::(\d+))?$/);
      if (!ipPortMatch) return `Invalid DNS server address: "${entry}". Use IP or IP:port format.`;
      const octets = ipPortMatch[1].split(".").map(Number);
      if (octets.some((o) => o > 255)) return `Invalid IP address: "${ipPortMatch[1]}"`;
      if (ipPortMatch[2] && (Number(ipPortMatch[2]) < 1 || Number(ipPortMatch[2]) > 65535)) {
        return `Invalid port number: "${ipPortMatch[2]}"`;
      }
    }
    return null;
  }

  const validationError = validateServers();

  // Validate search domains (alphanumeric + dots + hyphens, max 6)
  function validateSearchDomains(): string | null {
    if (!dnsEnabled || !dnsSearchDomains.trim()) return null;
    const domains = dnsSearchDomains
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (domains.length > 6) return "resolv.conf supports at most 6 search domains.";
    for (const d of domains) {
      // Optional middle group is single-quantifier; outer anchors prevent backtracking blowup.
      // eslint-disable-next-line security/detect-unsafe-regex
      if (!/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(d)) {
        return `Invalid domain: "${d}". Use only letters, numbers, dots, and hyphens.`;
      }
    }
    return null;
  }

  const searchDomainError = validateSearchDomains();

  return (
    <div className="card mt-6">
      <div className="flex items-center justify-between p-4 bg-surface-secondary/50 border-b border-border mb-6 -mx-7 -mt-7">
        <div>
          <h3 className="text-lg font-semibold text-txt-primary">Network &amp; DNS Settings</h3>
          <p className="text-sm text-txt-secondary mt-0.5">
            Configure custom DNS servers for the guacd proxy containers. This is required when
            target servers use internal DNS zones (e.g. <code>.dmz.local</code>) that Docker&apos;s
            built-in DNS cannot resolve.
          </p>
        </div>
      </div>

      <div className="space-y-6">
        <div>
          <h4 className="text-sm font-semibold text-txt-primary uppercase tracking-wider mb-4">
            Custom DNS Servers
          </h4>
          <p className="text-sm text-txt-secondary mb-4">
            When enabled, your DNS server IPs are applied to the guacd containers so they can
            resolve internal hostnames the same way your host operating system does. This preserves
            hostname-based authentication (including Kerberos/NLA).
          </p>
          <div className="form-group">
            <label
              className="flex items-center gap-3 cursor-pointer group"
              aria-label="Enable Custom DNS"
            >
              <input
                type="checkbox"
                checked={dnsEnabled}
                onChange={(e) => {
                  setDnsEnabled(e.target.checked);
                  setRestartNeeded(false);
                }}
                className="checkbox"
              />
              <div>
                <span className="font-medium group-hover:text-txt-primary transition-colors">
                  Enable Custom DNS
                </span>
                <p className="text-txt-secondary text-sm mt-0.5">
                  Apply custom nameservers to the guacd proxy containers.
                </p>
              </div>
            </label>
          </div>
        </div>

        {dnsEnabled && (
          <div className="pt-6 border-t border-border/10">
            <h4 className="text-sm font-semibold text-txt-primary uppercase tracking-wider mb-4">
              DNS Servers
            </h4>
            <div className="form-group">
              <label htmlFor="dns-server-addresses" className="form-label">
                DNS Server Addresses
              </label>
              <input
                id="dns-server-addresses"
                className="input"
                value={dnsServers}
                onChange={(e) => {
                  setDnsServers(e.target.value);
                  setRestartNeeded(false);
                }}
                placeholder="e.g. 10.179.46.52, 10.179.46.53"
              />
              <p className="text-sm text-txt-secondary mt-1">
                Comma-separated list of DNS server IP addresses (typically your corporate / Active
                Directory DNS servers).
              </p>
              {validationError && <p className="text-sm text-danger mt-1">{validationError}</p>}
            </div>

            <div className="form-group mt-6">
              <label htmlFor="dns-search-domains" className="form-label">
                Search Domains
              </label>
              <input
                id="dns-search-domains"
                className="input"
                value={dnsSearchDomains}
                onChange={(e) => {
                  setDnsSearchDomains(e.target.value);
                  setRestartNeeded(false);
                }}
                placeholder="e.g. example.local, corp.example.com"
              />
              <p className="text-sm text-txt-secondary mt-1">
                Comma-separated list of DNS search domains. Required for <code>.local</code> zones
                and allows short hostnames (e.g. <code>server01</code>) to resolve as{" "}
                <code>server01.example.local</code>. Equivalent to the <code>Domains=</code>{" "}
                directive in <code>systemd-resolved</code>.
              </p>
              {searchDomainError && <p className="text-sm text-danger mt-1">{searchDomainError}</p>}
            </div>

            <div className="mt-4 p-4 rounded-lg bg-surface-secondary/30 border border-border/30">
              <h5 className="text-sm font-medium text-txt-primary mb-2">How it works</h5>
              <ol className="text-sm text-txt-secondary space-y-1 list-decimal list-inside">
                <li>You configure your internal DNS server IPs here and save</li>
                <li>The DNS configuration is written to a shared config volume</li>
                <li>After restarting guacd, it reads the custom DNS config at startup</li>
                <li>guacd resolves hostnames using your DNS servers — just like your host OS</li>
              </ol>
            </div>
          </div>
        )}
      </div>

      {restartNeeded && (
        <div className="mt-4 rounded-md px-4 py-3 bg-warning/10 border border-warning/30">
          <p className="text-sm font-medium text-warning">Restart required</p>
          <p className="text-sm text-txt-secondary mt-1">
            DNS settings have been saved. Restart the guacd service(s) to apply:
          </p>
          <code className="block mt-2 text-sm bg-surface-secondary px-3 py-2 rounded font-mono">
            docker-compose restart guacd
          </code>
        </div>
      )}

      <div className="mt-8 pt-6 border-t border-border/10">
        <button
          className="btn btn-primary"
          onClick={handleSave}
          disabled={saving || (dnsEnabled && (!!validationError || !!searchDomainError))}
        >
          {saving ? "Saving..." : "Save Network Settings"}
        </button>
      </div>
    </div>
  );
}
