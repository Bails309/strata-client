# Threat Model — Strata Client

**Methodology:** STRIDE per component. **Scope:** v1 core (remote access, local + OIDC auth, RBAC, Vault credentials, AD sync, recordings, audit). VDI and Web-Kiosk are explicitly out-of-scope for v1 hardening and gated as `experimental`.

**Status:** Living document. Last reviewed: see `git log -- docs/threat-model.md`.

> **STRIDE legend:** S — Spoofing · T — Tampering · R — Repudiation · I — Information disclosure · D — Denial of service · E — Elevation of privilege

---

## 1. System Decomposition

### 1.1 Trust boundaries

```
[ Browser ] ──TLS──▶ [ Nginx (frontend) ] ──HTTP──▶ [ Backend (Rust/Axum) ]
                                                          │
                              ┌───────────────────────────┼───────────────────────────┐
                              ▼                           ▼                           ▼
                       [ PostgreSQL ]               [ HashiCorp Vault ]        [ guacd pool ]
                                                                                      │
                                                                                      ▼
                                                                           [ Target servers (RDP/VNC/SSH) ]
                              ▲
                              │ (LDAP/LDAPS)
                       [ Active Directory ]
```

### 1.2 Trust zones

| Zone | Components | Trusted by |
|------|------------|------------|
| **Untrusted** | Browser, end-user network | Nobody |
| **Edge** | Nginx (terminates TLS, serves SPA) | Backend |
| **Application** | Backend, internal Docker network | Vault, DB |
| **Data** | PostgreSQL, Vault | Backend only |
| **Target** | RDP/VNC/SSH targets, AD | Backend (via guacd) |

### 1.3 Critical assets

1. **Privileged credentials** in Vault (target server passwords, AD bind, Vault root token).
2. **Session recordings** (contain on-screen secrets).
3. **JWT signing key** (loss → arbitrary user impersonation).
4. **Database** (audit logs, password hashes, RBAC).
5. **Active sessions** in `guacd` (live RDP/VNC/SSH streams).

---

## 2. Component-by-component STRIDE

### 2.1 Browser ↔ Nginx (TLS edge)

| Threat | Vector | Mitigation | Residual |
|---|---|---|---|
| **S** Server impersonation | Cert MITM | TLS 1.2+, HSTS, customer-provided cert in `certs/` | Trust on first use; depends on operator PKI |
| **T** Response tampering | Stripped TLS | HSTS preload not advertised; document that operators must front with their own LB if exposed publicly | Operator responsibility |
| **I** Token leakage in URL | OAuth code/state in `Referer` | OIDC state + PKCE; tokens never placed in URL | OK |
| **D** Volumetric DoS | SYN flood, slowloris | Out of scope for app — operator deploys behind WAF/LB | Documented |

### 2.2 Browser SPA (frontend)

| Threat | Vector | Mitigation | Residual |
|---|---|---|---|
| **S** CSRF | Cross-site form post | Access tokens stored in `httpOnly; Secure; SameSite=Strict; Path=/api` cookies; double-submit `csrf_token` cookie + `X-CSRF-Token` header validated in constant time on every cookie-authenticated mutating request; GET/HEAD/OPTIONS, WS upgrades, and Bearer-authed requests are exempt. **W4-3 complete.** | OK — covered by `e2e/tests/rbac.spec.ts` CSRF suite |
| **T** Stored XSS | User-supplied HTML in connection names, tags, descriptions | All UI uses React's escaping; no `dangerouslySetInnerHTML` outside vendored Guacamole client; CSP policy in `frontend/common.fragment` | Audit CSP regularly |
| **T** DOM XSS | `eval`, dynamic URLs | ESLint `security/*` rules enforced; no `eval`, no `new Function` | OK |
| **R** Action origin denial | "I didn't click that" | Every state-changing API call audit-logged server-side with actor + IP | OK |
| **I** Token theft via XSS | localStorage access | Access + refresh tokens both `httpOnly` cookies; never readable from JS. **W4-3 complete.** | OK |
| **D** Resource exhaustion | Large response renders | Pagination on all list endpoints; virtualization for session lists | Audit per page |
| **E** Client-side route bypass | Toggle React route guards | Every protected route asserts permission **server-side**; UI guards are UX only | Covered by W4-4 RBAC test pack |

### 2.3 Backend API (Axum)

| Threat | Vector | Mitigation | Residual |
|---|---|---|---|
| **S** JWT forgery | Algorithm confusion, weak secret | RS256 for OIDC (verifies against IdP JWKS); HS256 for local with persisted random secret ≥256 bits, refused to start if missing | OK |
| **S** Token replay after revoke | Stolen token used post-logout | Revocation list (`revoked_tokens` table) checked on every request | OK |
| **T** SQL injection | Crafted query params | sqlx compile-time checked queries everywhere | OK |
| **T** Mass-assignment | Extra JSON fields update protected columns | Each handler explicitly destructures input DTO; no `serde(flatten)` from request → DB row | OK |
| **R** No audit trail | Action without log | `audit_logs` write inside the handler tx for every mutating route; FK `ON DELETE SET NULL` to preserve trail | OK |
| **I** PII in logs | User emails / passwords leaking | `tracing` field redaction; secret types use `Secret<T>` with `serde::Serialize` denied | Spot-check on every PR |
| **I** Timing oracle on login | Username enumeration | Argon2 verify always runs (against a dummy hash if user missing); per-IP and per-username rate-limit | OK |
| **D** Auth brute force | Credential stuffing | Per-IP + per-user rate limit; account lockout after N failures | Tune thresholds |
| **D** Slow handler | Long-running DB query | `tower_http::timeout`; sqlx statement timeout | OK |
| **E** RBAC bypass | Direct API hit on hidden route | Automated negative-test pack `e2e/tests/rbac.spec.ts` exercises every protected route with (a) no auth, (b) authenticated-but-unprivileged Bearer, and (c) cookie auth without/with bad CSRF; admin routes must return 403 to a no-permission user. **W4-4 complete.** | OK |
| **E** IDOR | `/api/connections/:id` for another user's connection | Every row-scoped query joins on `user_permissions`/`role_permissions`; covered by `rbac.spec.ts` wrong-role probes. **W4-4 complete.** | OK |

### 2.4 Tunnel proxy (WS ↔ guacd)

| Threat | Vector | Mitigation | Residual |
|---|---|---|---|
| **S** Tunnel hijack | Stealing a tunnel ticket | Tickets are single-use, scoped to (user, connection, expiry < 60s), validated on `/tunnel` upgrade | OK |
| **T** Mid-stream injection | MITM on internal hop | Internal Docker network only; backend ↔ guacd is non-routed | Acceptable for default deployment |
| **R** Session attribution | "Who opened this RDP session?" | Tunnel ticket binds to user; `audit_logs.session_open` row written before WS upgrade | OK |
| **I** Session recording theft | Direct file access | Recordings stored on disk with per-session ownership token; download via capability-token URL with short TTL | OK |
| **I** Credential exposure to guacd | Plaintext password sent on `connect` | Internal network only; never logged; in-memory only | Acceptable |
| **D** Tunnel exhaustion | Open many tunnels | Per-user concurrent session cap (`max_concurrent_sessions`) | OK |
| **E** Connection swap | Open ticket for connection A, talk to B | guacd handshake uses the params encoded in the ticket; mismatch closes the WS | OK |

### 2.5 Vault integration

| Threat | Vector | Mitigation | Residual |
|---|---|---|---|
| **S** Vault impersonation | DNS spoof of Vault host | TLS + pinned CA bundle when configured | Document for operators |
| **T** Secret tampering | Replace secret in transit | TLS only | OK |
| **R** Secret-access attribution | "Who read this password?" | Backend uses one Vault token per process; the `audit_logs.secret_read` row in our DB carries the actor; Vault's own audit log carries the backend identity | Two-log correlation required |
| **I** Embedded Vault root token leakage | Auto-init writes root token to disk | File mode `0600`, owned by backend user; **production deployments MUST use external Vault** — checklist in `deployment.md` | **Risk:** boot mode must refuse external traffic if embedded Vault is in use |
| **I** Unseal-key disclosure | Auto-unseal key on disk | Same protections; same recommendation to externalize | Same |
| **D** Vault sealed | Backend can't read secrets | Fail closed: routes that need secrets return 503 with operator-actionable message | OK |
| **E** Token over-privilege | One backend token can read all paths | Token policy scoped to `secret/data/strata/*` only; rotate via Vault on operator-set schedule | Document rotation playbook |

### 2.6 Active Directory sync

| Threat | Vector | Mitigation | Residual |
|---|---|---|---|
| **S** Rogue AD response | DNS poisoning to fake DC | LDAPS + CA pinning when `ldap_ca_cert` configured | Recommend LDAPS in deployment guide |
| **T** Group-membership tampering | AD compromise → arbitrary RBAC | RBAC mapping is operator-defined per-group; AD membership only grants what the operator configured | Acceptable — AD is authoritative by design |
| **I** Bind credential leak | Storage of AD bind password | Stored in Vault, never in DB | OK |
| **D** Sync runaway | AD with 500k users | Pagination + worker timeout; sync runs in a background worker, never blocks HTTP | OK |
| **E** Privilege escalation via group rename | Renaming an AD group to match a privileged role | Mapping uses AD `objectGUID`, not name | OK |

### 2.7 PostgreSQL

| Threat | Vector | Mitigation | Residual |
|---|---|---|---|
| **T** At-rest tampering | Direct DB write bypassing app | Out of scope — operator owns DB host security | Documented |
| **I** Backup theft | DB dump leaking hashes / audit | Operator responsibility; passwords are Argon2id hashed; secrets are in Vault not DB | OK |
| **D** Connection exhaustion | sqlx pool exhausted | Pool size + acquire timeout; circuit breaker on failure | OK |
| **E** SQL injection → arbitrary write | See 2.3 — sqlx checked queries | OK |

### 2.8 guacd (and the vendored Guacamole patches)

| Threat | Vector | Mitigation | Residual |
|---|---|---|---|
| **T** Patched guacd diverges from upstream CVE fixes | Custom H.264 patches missed in upgrade | `guacd/patches/` is small and reviewed on every guacamole-server bump; CI pin to image digest | Maintenance burden — acknowledged |
| **I** RDP credential logging | Verbose guacd logs | Default log level excludes secrets; audit on bump | Spot-check |
| **D** Buggy patch crashes guacd | OOM, segfault | Pool replaces failed instance; per-pool circuit breaker | OK |
| **E** Container escape from guacd | Kernel exploit | Container runs with dropped caps + read-only root; no privileged mode; non-root user | OK for default; document any custom override |

### 2.9 VDI driver (experimental)

> **VDI is gated behind `feature = vdi` and labelled experimental in the UI. The threats below are why.**

| Threat | Vector | Mitigation | Residual |
|---|---|---|---|
| **E** Container escape → host root | Mounting `/var/run/docker.sock` is host-root by definition | **Cannot be fully mitigated** while we use the docker socket. Long-term: replace with Sysbox / Kata / podman rootless. | Open — tracked under W5-* |
| **I** Cross-tenant container view | One user lists/inspects another's container | All docker calls are namespaced by `strata.user_id` label; admin endpoints required to enumerate cross-user | Acceptable |
| **D** Resource starvation | One user spawns 100 VDIs | Per-user concurrent VDI cap; operator-set max-containers cap | OK |

### 2.10 Web-kiosk (experimental)

| Threat | Vector | Mitigation | Residual |
|---|---|---|---|
| **T** Egress to arbitrary internet | Kiosk renders attacker-controlled site | Per-connection allow-list of hostnames; Chromium `--host-rules`; backend egress firewall | Document operator firewall expectations |
| **I** Cookie/state leak between sessions | Kiosk container reused | New container per session; volumes are `tmpfs` | OK |
| **E** Kiosk → backend pivot | Compromised page reaches backend internal API | Kiosk runs in its own Docker network, no route to backend network | OK |

---

## 3. Cross-cutting controls

### 3.1 Secrets management
- JWT secret persisted with `0600`, refused to start if missing in production mode.
- Vault tokens never logged.
- ESLint `security/*` rules + gitleaks in CI to catch accidental commits.

### 3.2 Supply chain
- `cargo audit --deny unsound --deny unmaintained` in CI.
- `npm audit --audit-level=high` in CI.
- `gitleaks` on every PR.
- Container base images pinned to digest.
- **Planned (W5-*):** SBOM (CycloneDX), cosign-signed images.

### 3.3 Logging & audit
- All mutating routes write to `audit_logs` inside the same transaction as the change.
- `ON DELETE SET NULL` on user FK preserves attribution after user deletion.
- Operator can ship logs to SIEM via stdout / syslog / journald.

### 3.4 Production-mode boot guard *(planned, not yet implemented — W5-*)*
- Refuses to boot when `STRATA_PROFILE=production` AND any of:
  - embedded Vault active,
  - default JWT secret,
  - CORS allow-list `*`,
  - debug logging,
  - registration enabled without admin approval,
  - self-signed cert without explicit `STRATA_ALLOW_SELF_SIGNED=1`.

---

## 4. Open issues / tracked work

| ID | Item | Linked threat | Status |
|----|------|---------------|--------|
| W4-3 | Move access token to `httpOnly` cookie + CSRF double-submit | 2.2 I (token theft via XSS) | ✅ Done |
| W4-4 | RBAC negative-test pack | 2.3 E (RBAC bypass / IDOR) | ✅ Done |
| W5-1 | Production-mode boot guard | 3.4 | Open |
| W5-2 | SBOM + cosign signing | 3.2 | Open |
| W5-3 | VDI: replace `docker.sock` with rootless runtime | 2.9 E | Open |
| W5-4 | Operator playbook: Vault token rotation | 2.5 E | Open |
| W5-5 | External-Vault-only enforcement in production mode | 2.5 I | Open |

---

## 5. Out of scope for v1

- Hardware-backed key storage (HSM, TPM).
- Multi-tenant isolation beyond per-row RBAC.
- Continuous behavioural anomaly detection.
- Customer-facing bug bounty (disclosure policy still required — W5-*).
