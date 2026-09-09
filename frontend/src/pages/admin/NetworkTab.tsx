/* eslint-disable react-hooks/set-state-in-effect --
   react-hooks v7 compiler-strict suppressions: legitimate prop->state sync, session
   decoration, or render-time time/derivation patterns. See
   eslint.config.js W4-1 commentary. */
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

  const dnsServerList = dnsServers
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <div className="card mt-6">
      <div className="flex items-center justify-between p-4 bg-surface-secondary/50 border-b border-border mb-6 -mx-7 -mt-7">
        <div>
          <h3 className="text-lg font-semibold text-txt-primary">Network &amp; DNS Settings</h3>
          <p className="text-sm text-txt-secondary mt-0.5">
            Configure the DNS servers the session engine resolves target hostnames with. This is
            required when targets sit in an internal zone (e.g. <code>.dmz.local</code>) that the
            host&apos;s resolver does not serve, or are entered as short names that only resolve
            with a search suffix.
          </p>
        </div>
      </div>

      <div className="space-y-6">
        <div>
          <h4 className="text-sm font-semibold text-txt-primary uppercase tracking-wider mb-4">
            Custom DNS Servers
          </h4>
          <p className="text-sm text-txt-secondary mb-4">
            When enabled, your DNS server IPs are applied to the backend container so it resolves
            internal hostnames the same way your host operating system does. Targets are still
            dialled by name, so hostname-based authentication (including Kerberos/NLA) and TLS
            certificate verification are unaffected.
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
                  Apply custom nameservers to the backend&apos;s target lookups.
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
                <li>The session engine resolves target hostnames against them</li>
                <li>
                  Short names are expanded with the search suffix, so{" "}
                  <code>server01</code> reaches <code>server01.example.local</code>
                </li>
                <li>
                  Targets are still dialled by name, so Kerberos/NLA and TLS certificate checks are
                  unaffected
                </li>
              </ol>
              <p className="text-sm text-txt-secondary mt-3">
                Applies to the next session started — no restart. If a lookup fails the engine
                falls back to the system resolver rather than refusing the session, so a
                mistyped nameserver degrades rather than takes everything down.
              </p>
            </div>
          </div>
        )}
      </div>

      {restartNeeded && (
        <div className="mt-4 rounded-md px-4 py-3 bg-success/10 border border-success/30">
          <p className="text-sm font-medium text-success">Saved</p>
          <p className="text-sm text-txt-secondary mt-1">
            Target hostnames will resolve against{" "}
            {dnsServerList.length > 0 ? dnsServerList.join(", ") : "the system resolver"} from the
            next session onwards. Sessions already running keep the address they connected with.
          </p>
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
