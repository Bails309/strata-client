# Runbook — DMZ incident response

**Purpose:** Diagnose and recover from incidents affecting the
public-facing `strata-dmz` node or the link tunnel between the DMZ and
the internal `strata-backend`.

## When to use

- Admin UI's **DMZ Links** tab shows an endpoint stuck in `backoff` or
  `connecting`.
- Public users report `502 Bad Gateway` or `504 Gateway Timeout` from
  `https://<dmz-host>/...` while the backend is otherwise healthy.
- Operator `/status` returns `links_up: 0` but the backend container
  is running.
- Suspected compromise of the DMZ host (EDR alert, anomalous outbound
  connections from the DMZ container, unexpected processes).
- Suspected leak of the link PSK, the edge-HMAC key, or the operator
  bearer token.
- Scheduled rotation of any of the three DMZ secrets.

## Prerequisites

- Admin role in Strata.
- SSH / console access to the DMZ host **and** the internal host.
- The current operator token (`STRATA_DMZ_OPERATOR_TOKEN`) for live
  diagnostics — if you don't have it, treat that as a SEV-2 in itself
  and follow §Operator-token compromise.
- An open ticket in the incident tracker.

## Severity classes

| Sev | Example | First response |
|---|---|---|
| **SEV-1** | Suspected compromise of DMZ host, leak of link PSK or edge HMAC key, sustained `links_up: 0` while backend is healthy | Page on-call, start war-room, rotate the leaked secret per §Secret rotation |
| **SEV-2** | Single endpoint flapping >5×/hour, operator token leaked but the link itself is intact | Rotate just the affected secret; investigate flap cause |
| **SEV-3** | Single transient flap, latency spike <5 minutes that recovered on its own | Open ticket, attach the relevant `/links` snapshot, monitor |

---

## Scenario 1 — Link flap (endpoint stuck in `backoff`)

**Symptoms:** Admin UI **DMZ Links** tab shows one or more endpoints
red (`backoff` / `stopped`). `failures` counter incrementing.

1. **Snapshot the supervisor state.** From an admin browser session:

   ```http
   GET /api/admin/dmz-links
   ```

   Note the `last_error` field per endpoint — common values:

   - `tls handshake failed: <details>` — see §Cert rotation.
   - `connection refused` — DMZ host unreachable from internal; check
     internal-firewall egress rules.
   - `auth failed: bad psk` — see §Secret rotation, link PSK.
   - `auth failed: protocol version mismatch` — version skew between
     internal and DMZ binaries; align them.

2. **Force a reconnect.** Click **Force reconnect** in the admin UI
   (or `POST /api/admin/dmz-links/reconnect`). The supervisor will
   immediately re-dial every endpoint with no backoff.

3. **Inspect DMZ-side logs:**

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.dmz.yml \
       logs --tail=200 strata-dmz | grep -E 'link|handshake|tls'
   ```

4. **If the flap persists**, escalate to SEV-2 and check:
   - Clock skew between DMZ and internal (`HANDSHAKE_MAX_SKEW_MS = 30000`).
   - Network MTU on the link path (h2 over mTLS dislikes MSS-clamped
     paths that drop large frames silently).

---

## Scenario 2 — `links_up: 0` while backend is healthy

**Symptoms:** Operator `/status` returns `links_up: 0`. Backend
container reports healthy. Public traffic returns `503` from the DMZ.

1. **Confirm the backend is dialing.** From the internal host:

   ```bash
   docker compose logs --tail=100 backend | grep -E 'link|dmz'
   ```

   Expected: a periodic `[link] dialing strata-dmz:8444` log line. If
   absent, the backend isn't in DMZ mode — confirm
   `STRATA_DMZ_ENDPOINTS` is set in its environment.

2. **Confirm the DMZ is listening.** From the DMZ host:

   ```bash
   ss -tlnp | grep -E ':(8443|8444|9444)'
   ```

   Expected: three listening sockets. If 8444 is missing,
   `STRATA_DMZ_LINK_BIND` was misconfigured; restart the DMZ
   container after fixing it.

3. **Confirm the firewall path is open.** From the internal host:

   ```bash
   nc -vz <dmz-host> 8444
   ```

   If this fails, the firewall between internal and DMZ is denying
   the link. Open `internal → dmz:8444/tcp` and re-test.

4. **If TLS terminates but the handshake fails**, suspect a CA
   mismatch. Rotate per §Cert rotation if either side's cert was
   recently regenerated.

5. **If the internal node logs `certificate not valid for name
   "<hostname>"`**, the SNI it presents (taken from
   `STRATA_DMZ_ENDPOINTS`) is missing from the link server cert's
   SAN. Reissue `certs/dmz/server.crt` with the public DMZ hostname
   added — the CA, `server.key`, and client material can stay the
   same so nothing needs redistributing to the internal host:

   ```bash
   # On the DMZ host
   cd /opt/strata-client/certs/dmz
   sudo bash -c 'cat > server.ext <<EOF
   subjectAltName=DNS:<public-dmz-hostname>,DNS:strata-dmz,DNS:localhost,IP:127.0.0.1
   EOF'
   sudo openssl req -new -key server.key -subj "/CN=strata-dmz" -out server.csr
   sudo openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
       -days 30 -out server.crt -extfile server.ext
   sudo rm server.csr server.ext && sudo chmod 644 server.crt

   cd /opt/strata-client
   docker compose --env-file .env.dmz -f docker-compose.dmz-edge.yml \
       up -d --force-recreate strata-dmz
   ```

   For test stacks the easier path is `EXTRA_SERVER_SANS=<host>
   ./scripts/dmz/gen-test-certs.sh`, but that rotates the CA so you
   must redistribute to the internal host too (see §Cert rotation).

---

## Scenario 3 — Operator-token compromise (SEV-1/2)

**Symptoms:** Token appeared in a leaked log, screenshot, or commit;
or unauthenticated requests to `/links` are succeeding (they should
all be 401).

1. **Generate a fresh token** (32+ bytes, base64):

   ```bash
   openssl rand -base64 32
   ```

2. **Rotate the env var on the DMZ host** in `.env.dmz`:

   ```env
   STRATA_DMZ_OPERATOR_TOKEN=<new-value>
   ```

3. **Restart only the DMZ container.** No backend restart needed —
   the operator token is DMZ-local:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.dmz.yml \
       up -d strata-dmz
   ```

4. **Distribute the new token** through the secrets channel
   (HashiCorp Vault, 1Password, etc.). Rotate any tooling that had
   the old value baked in.

5. **Audit:** check `audit_logs` for the window between when the
   token might have been leaked and now. Filter on
   `actor_kind = 'dmz_operator'` if the operator action shows up
   there, or grep DMZ logs for `/links/{link_id}/disconnect` calls
   that didn't originate from your team.

---

## Scenario 4 — Edge-HMAC key compromise (SEV-1)

**Symptoms:** The HMAC key used by `HmacEdgeSigner` was exposed (e.g.
in a memory dump, a leaked env file, an EDR alert showing exfil from
the DMZ container).

> An attacker holding this key cannot decrypt anything — its only
> power is to forge `x-strata-edge-trusted-mac` headers and convince
> the internal node that an arbitrary public client has a particular
> client-IP / TLS metadata bundle. That bundle is then trusted by
> audit-log writes and rate-limit accounting on the internal side.

1. **Generate a fresh key** (32+ bytes, base64):

   ```bash
   openssl rand -base64 32
   ```

2. **Stage the new key as an additional verifier** on the internal
   node first. The internal verifier accepts the comma-separated set
   of currently-trusted keys:

   ```env
   STRATA_DMZ_EDGE_HMAC_KEYS=<new-key>,<old-key>
   ```

   Restart the backend. It now accepts MACs signed under either key.

3. **Promote the new key on the DMZ.** Update the DMZ's signer:

   ```env
   STRATA_DMZ_EDGE_HMAC_KEY=<new-key>
   ```

   Restart the DMZ container. From this moment forward, all freshly
   minted MACs are signed with the new key. Any forged MACs the
   attacker produces under the **old** key will still verify on the
   internal side until step 4.

4. **Drop the old key from the internal verifier:**

   ```env
   STRATA_DMZ_EDGE_HMAC_KEYS=<new-key>
   ```

   Restart the backend. The window during which the leaked key was
   useful is now closed.

5. **Audit:** review internal-side audit logs since the suspected
   leak time for `client_ip` / `user_agent` values that don't match
   the corresponding TCP peer in the proxy access log.

---

## Scenario 5 — Link PSK compromise (SEV-1)

**Symptoms:** The PSK that the internal node presents to the DMZ
during the strata-link/1.0 handshake was leaked.

> An attacker holding the PSK can dial the DMZ, complete the auth
> handshake, and start a parallel link as if they were the internal
> node — but they would also need a valid client cert (mTLS) to even
> reach the handshake. Treat this as SEV-1 on principle.

1. **Generate a fresh PSK** (32+ bytes, base64):

   ```bash
   openssl rand -base64 32
   ```

2. **Stage the new PSK on the DMZ side** as `current` while keeping
   the old one as `previous`:

   ```env
   STRATA_DMZ_LINK_PSKS=current:<new-psk>,previous:<old-psk>
   ```

   Restart the DMZ container.

3. **Update the internal node** to present the new PSK. The backend
   reads one env var per PSK id (`STRATA_DMZ_LINK_PSK_<ID>`):

   ```env
   STRATA_DMZ_LINK_PSK_CURRENT=<new-psk>
   ```

   Restart the backend. Force-reconnect via the admin UI to drop the
   existing link and redial under the new PSK.

4. **Drop the old PSK from the DMZ:**

   ```env
   STRATA_DMZ_LINK_PSKS=current:<new-psk>
   ```

   Restart the DMZ container.

5. **Audit:** check DMZ logs for any successful handshake from a
   client cert that doesn't match the internal node's expected SAN.

---

## Scenario 6 — Cert rotation (mTLS material)

The CA cert, link server cert, link client cert, and public TLS cert
all expire on independent schedules. Use this scenario when any of
them is within 30 days of expiry, or immediately on suspected
compromise.

1. **Issue replacements** with your normal CA tooling (or
   `scripts/dmz/gen-test-certs.sh` for non-production stacks).

2. **Distribute** the new files to `./certs/dmz/` on the DMZ host
   (and `./certs/dmz/client.{crt,key}` + `ca.crt` to the internal
   host).

3. **Rolling restart:**

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.dmz.yml \
       up -d strata-dmz
   docker compose up -d backend
   ```

4. **Verify** both endpoints come back to `up` in the admin UI.

---

## Scenario 7 — Suspected compromise of DMZ host (SEV-1)

If you have reason to believe the DMZ container or the host beneath
it has been compromised:

1. **Treat all three secrets as leaked.** Run §3, §4, and §5 in
   sequence (operator token → edge HMAC → link PSK).
2. **Rotate the link mTLS material** per §6 — both server cert and
   client cert.
3. **Rebuild the DMZ image from a known-good commit.** The DMZ
   container is read-only at runtime so any persistent foothold
   would be in mounted volumes (only `/certs:ro` and `/tmp` tmpfs)
   or in the image itself.
4. **Audit the internal side.** Because the DMZ holds no business
   secrets and signs every edge bundle with a key the internal node
   can revoke, the worst the attacker could achieve from the DMZ is
   forging the client-IP / user-agent that the audit log records
   for public-side requests during the compromise window. Review
   audit entries in that window for IP / UA values that don't
   correlate with TCP peer addresses in the proxy access log.

---

## Related

- [ADR-0009 — DMZ deployment mode](../adr/ADR-0009-dmz-deployment-mode.md)
- [DMZ implementation plan](../dmz-implementation-plan.md)
- [Grafana dashboard](../grafana/strata-dmz-dashboard.json)
- [Certificate rotation runbook](certificate-rotation.md)
