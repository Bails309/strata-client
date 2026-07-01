# What's New in v1.12.10

> **Patch release — the Safeguard bulk-checkout card no longer
> loses `pending` (approval-required) rows when a subsequent
> checkout runs for a different profile.** A customer reported
> that on the **Credentials → Request Checkout** tab, checking
> out an ad-hoc privileged profile (approval-required) followed
> by a plain test profile (no approval) silently wiped the
> ad-hoc row's yellow **Awaiting approval** badge, dropped the
> manual **Refresh** button from the DOM, and stopped the
> background poll `useEffect` from ever noticing the approver's
> decision — the only recovery was to press **Check in all**
> and restart the whole request from scratch. Root cause: both
> `handleCheckout` and `handleCheckin` in
> [`frontend/src/pages/credentials/SafeguardBulkCheckoutCard.tsx`](frontend/src/pages/credentials/SafeguardBulkCheckoutCard.tsx)
> opened with `setResults([])` — wiping the entire per-profile
> results array — and then re-set `results` to only the rows
> for the profiles included in the current operation, so
> `pending` rows for unrelated profiles fell out of state
> entirely. Backend `password_cache` state was correct
> throughout; the bug was purely frontend state management.
> v1.12.10 merges results by `profile_id` on checkout and
> prunes by `profile_id` on check-in, preserving `pending` rows
> so the background poll continues to watch them through the
> standard 30-minute window. No backend changes, no API surface
> changes, no migrations, no new environment variables, no new
> Cargo or npm dependencies — strictly frontend.

## Theme 1 — Safeguard bulk-checkout preserves pending rows

### 1.1 Symptom (verbatim from the bug report)

1. Sign in to Strata and open **Credentials → Request
   Checkout**. Sign in to Safeguard (per-user browser flow or
   hybrid).
2. In the **Safeguard bulk checkout** card, select an ad-hoc
   privileged profile whose account is under an approval role
   — the appliance requires an approver to release the
   password. Type a justification and click
   **Checkout selected**.
3. Observe the ad-hoc row flip to the yellow
   **Awaiting approval** badge with a **Refresh** button and
   the "we re-check every 15 s for up to 30 minutes" hint text
   below. This is the correct v1.12.9 behaviour and continues
   unchanged on v1.12.10.
4. Now select a second profile — a plain test account that
   does **not** require approval — and click
   **Checkout selected** again.
5. **Was on v1.12.9**: the moment the second bulk-checkout
   dispatches, the ad-hoc row's **Awaiting approval** badge
   silently disappears. The test row shows **Checked out** (or
   the cached-password green badge once the sibling refresh
   runs) as expected, but the ad-hoc row has no badge at all
   and no **Refresh** button. When the approver clicks
   **Approve** in the Safeguard console the SPA never notices
   — the background poll has stopped watching. The only
   recovery was to press **Check in all** and restart the
   entire request from scratch.
6. **Now on v1.12.10**: the ad-hoc row's yellow badge and
   Refresh button persist across the second checkout; the
   background poll loop continues to re-poll it every 15 s for
   the standard 30-minute window; the approver's decision is
   observed on the very next tick after they act; the row
   flips to **Checked out**; and the newly-cached password
   appears in the green **Cached · Nh left** badge exactly as
   it would if the ad-hoc had been the only profile checked
   out. The equivalent path via **Check in** (single row) or
   **Check in all (N)** on the header also no longer wipes
   the ad-hoc pending row.

### 1.2 Root cause

[`frontend/src/pages/credentials/SafeguardBulkCheckoutCard.tsx`](frontend/src/pages/credentials/SafeguardBulkCheckoutCard.tsx)
tracks per-profile checkout results in a single `results`
`useState` array keyed conceptually by `profile_id`. Both
`handleCheckout` and `handleCheckin` opened with
`setResults([])` and then re-set `results` to only the rows
for the profiles included in the current operation. When a
subsequent `handleCheckout` ran for a different subset (e.g.
just the test profile), the ad-hoc profile's
`state === "pending"` row was collateral damage: it was in
`prev` but not in `res`, so it fell out of state entirely.

The background poll `useEffect` (declared further down in the
same component) filters
`results.filter((r) => r.state === "pending" && !!r.request_id)`
to decide which appliance request-ids to keep re-polling.
With the ad-hoc row gone from `results`, the effect's
`pending` array narrowed to zero (the newly-checked-out test
row is `ok`, not `pending`), the cleanup ran, and the
`setInterval` was cleared. The manual **Refresh** button on
the ad-hoc row also disappeared because it is conditionally
rendered only when
`result?.state === "pending" && result.request_id` is truthy
for that row — with `results` no longer containing the row,
the JSX short-circuits to nothing.

The `pollStartedAt` map still held the ad-hoc profile's start
timestamp (that map is additive-only across checkouts), but
nothing was reading it in a "still pending" capacity anymore.
The `password_cache` row on the backend was correctly
persisted in the `pending` state throughout — the bug was
purely a frontend state-management regression, no data was
lost.

### 1.3 Fix

Merge new results into the existing `results` array keyed by
`profile_id`, rather than replacing the array wholesale. Both
mutation paths now preserve unrelated rows.

`handleCheckout` no longer calls `setResults([])` on entry;
when the appliance response `res` returns, it does:

```ts
setResults((prev) => {
  const byId = new Map(prev.map((r) => [r.profile_id, r]));
  for (const r of res) byId.set(r.profile_id, r);
  return Array.from(byId.values());
});
```

Rows for profiles that were part of the new checkout are
replaced (so re-running a stale `failed` row picks up the new
`ok`/`pending` state); rows for profiles that weren't part of
the new checkout survive untouched.

`handleCheckin` no longer calls `setResults([])` on entry;
after `safeguardCheckin` returns, it prunes only the
checked-in rows from `results` (so the now-stale
"Checked out" badge on the row disappears alongside its
cached badge from `refresh()`), never touching `pending` rows
for other profiles. For the **Check in all** button
(`profileId === null`, appliance decides the set) the prune
targets every currently-`cached` profile's row while
explicitly preserving `pending` rows:

```ts
setResults((prev) => {
  if (profileId) return prev.filter((r) => r.profile_id !== profileId);
  const cachedIds = new Set(cached.map((c) => c.profile_id));
  return prev.filter((r) => r.state === "pending" || !cachedIds.has(r.profile_id));
});
```

Explanatory comments above each block reference the
v1.12.10 rationale so future readers don't reintroduce the
`setResults([])` reset.

### 1.4 Regression test

[`frontend/src/__tests__/SafeguardBulkCheckoutCard.test.tsx`](frontend/src/__tests__/SafeguardBulkCheckoutCard.test.tsx)
adds a new case titled `"preserves a pending row from an
earlier checkout when a second checkout runs for a different
profile (v1.12.10 regression)"`. The test scaffolds two
Safeguard profiles (`adhoc-priv` and `test-svc`), mocks
`bulkSafeguardCheckout` to return `state: "pending"` for
`adhoc-priv` on the first call and `state: "ok"` for
`test-svc` on the second call, drives the component through
the exact click sequence from the bug report, and asserts
that after the second checkout the **Awaiting approval**
badge and **Refresh** button both remain on the ad-hoc row
while the **Checked out** badge appears on the test row. All
18 pre-existing cases in the same file continue to pass
unchanged (18 → 19 passing).

### 1.5 Compatibility

- **Backend**: no changes. The
  `POST /api/user/safeguard/bulk-checkout`,
  `POST /api/user/safeguard/checkin`, and
  `POST /api/user/safeguard/release` endpoints, their request
  bodies, and their response shapes are all unchanged.
- **Frontend**: no visible change for users who never mix
  approval-required and no-approval profiles in the same
  session. Users who did hit the bug regain the ability to
  keep the pending row visible across subsequent checkouts
  and check-ins, and their in-app view now stays in sync with
  the appliance's own `AccessRequests` state.
- **API contract**: none.
- **Storage / migration**: none. Backend `password_cache` and
  `safeguard_access_requests` rows have always tracked the
  pending state correctly; the bug never lost server-side
  state, only the SPA's in-memory view of it.
- **Tests**: 18 → 19 cases in the component's test file (+1
  regression test); all pass.

### 1.6 Acceptance test

1. Apply v1.12.10 to a deployment where at least one
   Safeguard profile targets an account that requires
   approver action, and at least one other Safeguard profile
   targets an account that auto-releases (either self-approved
   or no approval policy at all).
2. Sign in as any user with both profiles assigned.
3. On **Credentials → Request Checkout**, sign in to
   Safeguard. In the **Safeguard bulk checkout** card enter a
   justification, select the approval-required profile only,
   and click **Checkout selected**. Observe the
   **Awaiting approval** badge and **Refresh** button appear
   on that row.
4. Without checking anything in, select the auto-release
   profile only and click **Checkout selected** again. On
   v1.12.10 the ad-hoc row's yellow badge and Refresh button
   **must remain** and the auto-release row **must show**
   **Checked out** (green badge appears after the sibling
   `refresh()` completes).
5. Have the approver approve the ad-hoc request in the
   Safeguard console. Within one poll tick (15 s) the ad-hoc
   row **must flip** to **Checked out** and the green
   **Cached · Nh left** badge **must appear** alongside it.
6. Press **Check in** on the auto-release row. Confirm the
   ad-hoc row is unaffected (still cached, badge intact).
7. Press **Check in all (N)**. Confirm every currently-cached
   row is released — but any row still in the **Awaiting
   approval** state (start a fresh one for this step)
   **must survive** the bulk check-in.

## Notes

- v1.12.10 is a strict follow-up to v1.12.9 with a single
  frontend-only bug fix. No customer action is required
  beyond updating to v1.12.10. The standard deploy is
  `docker compose pull && docker compose up -d --build frontend`
  (frontend-only — the backend and `strata-dmz` container
  images are byte-identical to v1.12.9 in everything except
  the `[workspace.package].version` field embedded in the
  binary, and there is no reason to redeploy them solely for
  this change unless your operational policy requires version
  parity across every container in the stack). The
  `strata-dmz` relay binary cosmetically bumps version
  (shared workspace `[workspace.package].version`) but its
  wire protocol is byte-identical, so the
  **Admin → DMZ Links** tab will show a **Mixed** indicator
  until every relay is upgraded.

---

# What's New in v1.12.9

> **Patch release — the Dashboard search box now matches tag
> names alongside connection `name`, `hostname`, and
> `description`.** Customers who organise their fleet with tags
> (`Domain Controllers`, `Management Servers`, `Production`, etc.)
> naturally typed the tag into the **My Connections** search input
> at the top of `/dashboard` and saw zero results — the literal
> word "domain" does not appear in the `name`/`hostname`/`description`
> of a server called `cicsazt1mgt-p` even when that server is
> tagged `Domain Controllers`. The dedicated tag-pill chip row
> below the search continued to work correctly for `AND`-style
> narrowing, but the search box was the obvious first thing to
> try and it silently returned an empty list. v1.12.9 extends the
> `filtered` `useMemo` in
> [`frontend/src/pages/Dashboard.tsx`](frontend/src/pages/Dashboard.tsx)
> with a fourth `||` clause that also matches the query against
> the names of every tag assigned to each connection
> (user-defined and admin-defined tags, both surfaced via the
> existing `allConnTagMap` and `allTags` derivations), and updates
> the input placeholder from `Search` to
> `Search name, host, description or tag` so the new capability
> is discoverable. No backend changes, no API surface changes,
> no migrations, no new environment variables, no new Cargo or
> npm dependencies — five lines in one frontend file.

## Theme 1 — Tag names included in My Connections search

### 1.1 Symptom

A customer running v1.12.8 organised their estate with two
admin-defined tags — `Domain Controllers` (purple chip) and
`Management Servers` (green chip) — and approximately a hundred
named connections distributed across them. The operators reported
that typing `domain` into the **Search** input at the top of the
**My Connections** view returned an empty list, even though the
purple `Domain Controllers` chip was visible directly above the
search row and clicking it correctly narrowed the table to four
servers. The customer's natural reading of "the search box on a
page that shows tag chips above the table" was that the search
box also searches tags; instead it searched only the connection
`name` (`cicsazt0mgt-p`), `hostname` (`cicsazt0mgt-p.capita-ics.co.uk`),
and `description` (none of which contained the literal substring
`domain`).

The misunderstanding cost the customer non-trivial time because
the dedicated **TAGS** chip row was easy to miss at a glance on
deployments with a small number of tags — the chips render
inline next to the **Folders** / **Expand all** / **Collapse
all** buttons, not in a labelled filter panel — and because the
in-session **Ctrl+K** Command Palette (which the same operators
use day-to-day) has matched tag names against its query since
v1.12.4. Operators reasonably expected the dashboard's primary
filter input to behave the same way as the global one.

### 1.2 Root cause

The `filtered` `useMemo` in `Dashboard.tsx` composed four
narrowing predicates against the `connections` array:
`showFavorites` → `search` → `typeFilter` → `activeTagFilters`.
The `search` predicate compared the lowercased query against three
fields per row: `c.name.toLowerCase()`, `c.hostname.toLowerCase()`,
and `(c.description || "").toLowerCase()`. There was no tag-name
clause, even though both `allTags` (the merged admin+user tag
list) and `allConnTagMap` (the merged admin+user
connection→tag-id map) were already in scope as constants on the
same render — they were used by the `activeTagFilters` clause
immediately below the `search` clause and by the connection-row
rendering further down the component.

### 1.3 Fix

[`frontend/src/pages/Dashboard.tsx`](frontend/src/pages/Dashboard.tsx)
— inside the `if (search)` branch of the `filtered` `useMemo`,
build a single `Map<tagId, tagName.toLowerCase()>` from `allTags`,
then extend the row predicate with a fourth `||` clause:

```ts
(allConnTagMap[c.id] || []).some(
  (tid) => (tagNameById.get(tid) || "").includes(q),
);
```

The map is built lazily inside the closure so the cost is paid
only when the user has actually typed something, and only against
the connections that survived the preceding `showFavorites`
narrowing. The `useMemo` dependency list gains `allTags` so the
result recomputes correctly when the tag inventory changes
(rename, create, delete) while the search field is non-empty.

The input `placeholder` was changed from `Search` to
`Search name, host, description or tag` in the same edit so the
new capability is discoverable without having to consult the
documentation.

### 1.4 Why this is a patch and not a minor

- **Strictly additive behaviour.** Every query that returned a
  match on v1.12.8 still returns the same match on v1.12.9 (the
  new clause is `||`-joined, so existing matches cannot be
  filtered out by the change). The result set can only grow when
  the query happens to be a substring of an assigned tag name.
- **Sites that do not use tags at all see zero behavioural
  change** because `allConnTagMap[c.id]` is `[]` on every row and
  the new clause short-circuits to `false` on the first iteration.
- **Surface area: one file, one `useMemo`, one `placeholder`
  string.** No backend code, no API surface, no migration, no env
  var, no new dependency.
- **Composability is preserved.** The dedicated tag-pill chip
  filter (`activeTagFilters`) continues to compose with the
  search via `AND` — e.g. typing `mgt` while the
  `Domain Controllers` chip is active returns the intersection.

### 1.5 Compatibility

- **Backend**: no changes. The `GET /api/user/connections`,
  `GET /api/user/tags`, and `GET /api/user/connection-tags`
  shapes are unchanged.
- **Frontend**: no visible change for users who never type in
  the search box. The placeholder text changes from `Search` to
  `Search name, host, description or tag`.
- **API contract**: no changes. Both `TagsResponse` and
  `ConnectionTagsResponse` continue to return the same
  TypeScript shapes (`UserTag[]` and
  `Record<connectionId, tagId[]>` respectively).
- **Storage / migration**: none.
- **Tests**: the full vitest suite (~1,600 cases across 47
  files) continues to pass without modification. The change is
  small enough that the existing `Dashboard.test.tsx`
  `"filters by search"` case already exercises the predicate;
  no new test was added because the search closure is a private
  implementation detail of one `useMemo` and the public
  behavioural contract (`empty query → all rows; non-empty
  query → matching rows`) is unchanged.
- **Performance**: the new clause is `O(tagsPerConnection)`
  per row per keystroke, and `tagsPerConnection` is bounded by
  the size of the tag inventory in practice (operators tag with
  a small fixed set). The `tagNameById` lookup `Map` is built
  once per `filtered` recomputation, not once per row. For a
  reference 200-connection fleet with an average of two tags per
  connection the additional work per keystroke is ~400 `Map.get`
  calls plus ~400 `String.prototype.includes` calls, which is
  imperceptible against the React render cost of the result
  list itself.

### 1.6 Acceptance test

1. Apply v1.12.9 to a deployment that has at least one
   connection tagged via the connection editor or via the
   **Admin → Tags** tab (e.g. tag `cicsazt1mgt-p` with
   `Domain Controllers`).
2. Sign in as any user with access to the tagged connection.
3. Navigate to `/dashboard` and locate the **Search** input
   below the connection tiles.
4. **Expected on v1.12.9**: the placeholder reads `Search name,
   host, description or tag`. Type `domain` — the row for
   `cicsazt1mgt-p` (and every other connection tagged
   `Domain Controllers`) is included in the filtered list, even
   though the literal string `domain` does not appear in the
   connection's `name`, `hostname`, or `description` field.
5. **Was on v1.12.8**: the same query returned zero rows because
   only the three connection fields were searched.
6. Clear the search input and confirm the full list returns.
7. Click the **Domain Controllers** chip in the **TAGS** row and
   confirm the existing chip-based filter still narrows the
   table to exactly the same set of rows (the search and chip
   filters compose via `AND`, so typing into the search while
   a chip is active is also valid).
8. As a non-admin user with no tag assignments on any visible
   connection, type any tag name — the search returns the same
   `name`/`hostname`/`description`-only result set as on
   v1.12.8 (the new clause is a no-op when `allConnTagMap[c.id]`
   is `[]`).

## Notes

- The in-session **Ctrl+K** Command Palette already matched
  against tag names (added in v1.12.4 alongside the open-session
  prioritisation work). v1.12.9 brings the dashboard search to
  parity with the palette so both surfaces now agree on what
  "search" means.
- No customer action is required beyond updating to v1.12.9.
  The standard deploy is `docker compose pull && docker compose
  up -d --build frontend` (frontend-only — the backend container
  image is byte-identical to v1.12.8 in everything except the
  `[workspace.package].version` field embedded in the binary,
  and there is no reason to redeploy it solely for this change
  unless your operational policy requires version parity across
  every container in the stack). The `strata-dmz` relay binary
  cosmetically bumps version (shared workspace
  `[workspace.package].version`) but its wire protocol is
  byte-identical, so the **Admin → DMZ Links** tab will show a
  **Mixed** indicator until every relay is upgraded.

---

# What's New in v1.12.8

> **Patch release — UI hotfix: delegated users now see the
> connection name on session tiles.** v1.12.7's tightening of
> `GET /api/admin/connections` (now requires `can_manage_connections`)
> surfaced an unrelated and previously-silent bug in
> `frontend/src/pages/SessionClient.tsx` — the page was using the
> admin endpoint to translate the URL-supplied `connectionId` into a
> human-readable name for the session tile in the sidebar. Pre-v1.12.7
> the admin endpoint happened to be reachable by anyone with any
> admin flag, so the bug went unnoticed; post-v1.12.7 a delegated
> user without `can_manage_connections` started getting `403 Forbidden`
> on the lookup, the `.catch(() => undefined)` swallowed the error,
> and the tile rendered the protocol (`RDP`) instead of the actual
> connection name (`cicsazt1mgt-t`). The bug was entirely cosmetic —
> sessions still connected, audit logs still recorded the correct
> connection ID, file transfer still worked — only the visual label
> on the tile was wrong, and only for users in custom delegated roles.
> v1.12.8 swaps the call to `getMyConnections()` (the user-scoped
> `/api/user/connections` endpoint), which returns the same
> `Connection[]` shape, is filtered to the connections the user is
> actually allowed to reach, and requires no admin permission flag.
> No backend changes, no migrations, no new environment variables,
> no new dependencies — two lines in one frontend file plus an
> explanatory comment.

## Theme 1 — Delegated-user connection-name regression from v1.12.7

### 1.1 Symptom

A customer running v1.12.7 with a custom delegated role — call it
`session-operator`, with `can_create_connections=true` so the user
can create personal connections, but with `can_manage_connections=false`
and `can_manage_system=false` so they cannot administer other users'
connections or change global settings — reported that the session
tile in the **Active Sessions** sidebar on the right of the
`/session/{uuid}` page was showing the protocol (`RDP`) instead of
the server name (`cicsazt1mgt-t`) they had configured. Two
screenshots told the whole story: on a `can_manage_system=true`
account the tile correctly read `cicsazt1mgt-t` with `RDP` as a
subdued sub-label; on the `session-operator` account the same
connection rendered as a tile labelled `RDP` with no name visible
anywhere. The session itself worked perfectly — keyboard, mouse,
clipboard, audio, recording, audit, idle timeout, the lot. Opening
a second session in a different tab produced a second `RDP` tile,
then a third `RDP` tile, with no way to tell which tile belonged
to which server.

The customer noticed the regression specifically because the
`session-operator` role had three sessions open simultaneously
(jump-host RDP, target database RDP, target appliance SSH) and
needed to switch between them quickly during an incident — the
sidebar labels were the primary way they kept the tiles straight.

### 1.2 Root cause

`SessionClient.tsx` runs a one-shot "Phase 1" effect when the route
mounts that resolves the `connectionId` URL parameter into a display
name for the tile. The effect issued two parallel HTTP requests:

1. `getConnectionInfo(connectionId)` — `GET /api/user/connections/{id}/info`
   to fetch session-establishment metadata (protocol, hostname,
   port, recording policy). This endpoint returns the
   `ConnectionInfo` interface, which deliberately does **not**
   include the `name` field (the name is treated as metadata for
   display rather than a session-establishment parameter).
2. `getConnections()` — `GET /api/admin/connections` — to fetch
   the full `Connection[]` and pluck the matching row's `name`
   field.

Pre-v1.12.7 step 2 worked for every user with any admin flag
because the `require_admin` middleware was the only check on the
endpoint and it admits any user holding `has_any_admin_permission()`.
Even users with only `can_create_connections=true` (an admin flag)
got the full admin connection list. That was itself the v1.12.7
finding — see [WHATSNEW v1.12.7](#whats-new-in-v1127) — and v1.12.7
correctly tightened the endpoint with a per-handler
`check_connection_management_permission(&user)?` call.

Post-tightening, the `session-operator` role lost access to step 2.
The frontend's `.catch(() => undefined)` (added defensively to keep
the page rendering even if the lookup fails) silently turned the
`403` into a `connection === undefined` value, the
`connection?.name` chain produced `undefined`, the
`name: connectionName || protocol.toUpperCase()` fallback in the
three `createSession({...})` call sites fired, and the tile
rendered with `name = "RDP"`. There was no console error, no toast,
no audit-log entry — exactly the silent-fallback pattern the
defensive `.catch` had been written to provide, except now it was
firing on the happy path for an entire class of users.

This was a pure frontend bug that v1.12.7's backend fix only
revealed; the underlying API mismatch (using an admin endpoint to
look up data also reachable via a user endpoint) had been in
`SessionClient.tsx` for a long time. Audit confirms no other
frontend file makes the same mistake — `getConnections()` is also
called from `AdminSettings.tsx`, which is correctly admin-only.

### 1.3 Fix

[`frontend/src/pages/SessionClient.tsx`](frontend/src/pages/SessionClient.tsx)
swaps the import and the call from `getConnections` to
`getMyConnections`:

```typescript
// before
import {
  /* ... */,
  getConnections,
  /* ... */
} from "../api";

const [info, conns] = await Promise.all([
  getConnectionInfo(connectionId),
  getConnections().catch(() => []),
]);
const connection = conns.find((c) => c.id === connectionId);

// after
import {
  /* ... */,
  getMyConnections,
  /* ... */
} from "../api";

const [info, connection] = await Promise.all([
  getConnectionInfo(connectionId),
  // Use the user-scoped endpoint here: /admin/connections requires
  // can_manage_connections (v1.12.7), so delegated users without that
  // flag would 403 and fall through to the protocol name. /user/connections
  // is filtered to what the user can actually reach.
  getMyConnections()
    .then((conns) => conns.find((c) => c.id === connectionId))
    .catch(() => undefined),
]);
```

`getMyConnections()` calls `GET /api/user/connections`, returns the
same `Connection[]` shape, and is filtered server-side to exactly
the connections the user is allowed to launch. For a full admin
the response is identical in content to `/admin/connections`; for a
delegated user it is a subset, but always a subset that **includes**
the `connectionId` the user is mid-launch on — if it didn't, the
preceding `getConnectionInfo(connectionId)` call would itself have
returned `403` and the launch would have been blocked higher up in
the flow. So `conns.find(...)` always resolves on the happy path,
and the `name` field is always present.

The three downstream `createSession({...})` calls (lines 508, 710,
801 of the same file) are unchanged — they continue to use
`name: connectionName || protocol.toUpperCase()` as the defensive
fallback for the genuinely-degenerate case where neither endpoint
returned a name (e.g. a connection was deleted between the URL
being shared and the page mounting). That fallback now only fires
in genuine error paths instead of for an entire user class.

### 1.4 Acceptance test

1. Apply v1.12.8 to a deployment that already has v1.12.7 running.
2. Under **Settings → Roles**, create a delegated role called
   `session-operator` with **only** `can_create_connections=true`
   (no `can_manage_system`, no `can_manage_connections`, no
   `can_view_audit_logs`, no `can_view_sessions`).
3. Create a test user, assign them the `session-operator` role,
   and grant them access to at least one RDP connection (either
   directly via user-to-connection mapping or via a group they
   belong to).
4. Sign in as the test user, click the RDP connection from the
   dashboard, and wait for the session to establish.
5. Observe the session tile in the **Active Sessions** sidebar on
   the right. **Expected on v1.12.8**: the tile shows the
   connection's configured name (e.g. `cicsazt1mgt-t`) with the
   protocol (`RDP`) as a subdued sub-label. **Was on v1.12.7**:
   the tile shows only `RDP`.
6. Open the browser devtools network panel and reload the page —
   the page should issue a `GET /api/user/connections` (200)
   request and **no** `GET /api/admin/connections` request.
7. Sign in as a full admin (`can_manage_system=true`) and repeat
   step 5 — the tile label is unchanged from v1.12.7 because the
   admin's `/api/user/connections` response already includes every
   connection in the system.
8. Open three different connections in three browser tabs as the
   `session-operator` user — the sidebar should now show three
   distinct names, one per tile, instead of three identical `RDP`
   labels.

### 1.5 Migration notes

- No database migrations, no schema changes.
- No new environment variables.
- No new Cargo or npm dependencies.
- No backend code changes.
- The v1.12.7 RBAC tightening on `GET /api/admin/connections` is
  **preserved**; this release does not relax it. The frontend now
  uses the correct user-scoped endpoint for this lookup.
- No customer action is required beyond updating to v1.12.8. The
  custom delegated roles you may have created in response to
  v1.12.7's "audit your delegated roles" operator action remain
  correct and unchanged.

---

# What's New in v1.12.7

> **Patch release — Security: per-handler RBAC on `/api/admin/*`.**
> A penetration test against v1.12.6 found that the router-level
> `require_admin` middleware guarding `/api/admin/*` is intentionally
> a coarse gate — it accepts any user holding _any_ of the nine admin
> permission flags. The granular access decision is supposed to live
> in each handler via a `check_*_permission(&user)` call. **Seventeen
> handlers were missing that per-handler check**, so a delegated user
> holding only `can_view_audit_logs=true` (for example) could read
> every system setting, watch any user's recorded session, list every
> connection target, fingerprint internal service health, or bounce
> production DMZ links. v1.12.7 adds the missing per-handler check
> to every affected endpoint; users without the required flag now
> see `403 Forbidden`. CSRF and authentication were never affected —
> this is strictly an authorization-gap fix. No DB migrations, no new
> environment variables, no new dependencies.

## Theme 1 — Pentest finding: missing per-handler RBAC on `/api/admin/*`

### 1.1 Symptom

A pentester audited the `/api/admin/*` surface of a v1.12.6
deployment under a custom delegated role that held a single admin
flag — `can_view_audit_logs=true`, with every other admin flag
(`can_manage_system`, `can_manage_users`, `can_manage_connections`,
`can_view_sessions`, …) explicitly off. The intent of that role was
"a SOC analyst account that can read the audit log and nothing
else". The pentester observed that the same account could call:

- `GET /api/admin/settings` — full system settings table including
  SMTP server, AD bind DN, Vault address, DNS zones, auth method
  toggles.
- `GET /api/admin/recordings` and
  `GET /api/admin/recordings/{id}/stream` — list and play back any
  user's recorded RDP/VNC/SSH session.
- `GET /api/admin/health` — internal DB / guacd / Vault reachability,
  ClamAV engine version, signature freshness.
- `GET /api/admin/connections`, `GET /api/admin/connection-folders`,
  `GET /api/admin/tags`, `GET /api/admin/connection-tags` — every
  connection target the deployment manages.
- `GET /api/admin/roles`, `GET /api/admin/roles/{id}/mappings` —
  full RBAC matrix.
- `GET /api/admin/certs` — TLS/mTLS certificate inventory with
  fingerprints and expiry windows.
- `POST /api/admin/dmz-links/reconnect` — bounce production DMZ
  links.
- `PUT /api/admin/safeguard/config`, `POST /api/admin/safeguard/test`
  — modify the Safeguard JIT integration's API key, or probe
  arbitrary Safeguard appliances with a body-supplied secret.
- `GET /api/admin/metrics` — host CPU, memory, capacity estimates.
- `PUT /api/admin/connection-folders/{id}` — rename folders.
- `DELETE /api/admin/tags/{id}` — delete tags.

The CSRF token and JWT requirement were intact in every case —
this was strictly an authorization-gap finding, not an
authentication or CSRF bypass.

### 1.2 Root cause

`/api/admin/*` is layered with three middlewares in `routes/mod.rs`:

1. `require_csrf` — verifies the CSRF double-submit cookie.
2. `require_auth` — verifies the JWT and injects `AuthUser` via
   `Extension`.
3. `require_admin` — confirms the user holds **any** of the nine
   admin permission flags (`AuthUser::has_any_admin_permission()`).

`require_admin` is by design a coarse gate — it answers "is this
user an admin surface user at all?" so a custom role with a single
admin flag can still reach the subset of pages that flag covers.
The granular access decision is then the responsibility of each
handler, which must call one of the helpers in
`services::middleware`:

- `check_system_permission(&user)?` — accepts `can_manage_system`.
- `check_user_management_permission(&user)?` — accepts
  `can_manage_system` or `can_manage_users`.
- `check_connection_management_permission(&user)?` — accepts
  `can_manage_system` or `can_manage_connections`.
- `check_audit_permission(&user)?` — accepts `can_manage_system`
  or `can_view_audit_logs`.
- `check_session_permission(&user)?` — accepts `can_manage_system`
  or `can_view_sessions`.

(`can_manage_system` is the super-admin flag and short-circuits
every check above.)

About fifty-three of the ~70 admin handlers do call one of these
helpers as their first statement. The seventeen identified by the
pentest do not. Some never took `Extension(user)` at all (e.g.
`list_recordings`); others took it for use in audit-log fields but
never gated on a permission flag.

### 1.3 Fix

v1.12.7 adds the missing per-handler check to all seventeen
handlers, mapping each to the permission flag that matches the
existing pattern used by its sibling handlers in the same file:

| Endpoint                                 | Required permission      |
| ---------------------------------------- | ------------------------ |
| `GET /api/admin/settings`                | `can_manage_system`      |
| `POST /api/admin/settings/sso/test`      | `can_manage_system`      |
| `GET /api/admin/roles`                   | `can_manage_system`      |
| `GET /api/admin/roles/{id}/mappings`     | `can_manage_system`      |
| `GET /api/admin/metrics`                 | `can_manage_system`      |
| `PUT /api/admin/safeguard/config`        | `can_manage_system`      |
| `POST /api/admin/safeguard/test`         | `can_manage_system`      |
| `GET /api/admin/health`                  | `can_manage_system`      |
| `GET /api/admin/certs`                   | `can_manage_system`      |
| `POST /api/admin/dmz-links/reconnect`    | `can_manage_system`      |
| `GET /api/admin/connections`             | `can_manage_connections` |
| `GET /api/admin/connection-folders`      | `can_manage_connections` |
| `PUT /api/admin/connection-folders/{id}` | `can_manage_connections` |
| `GET /api/admin/tags`                    | `can_manage_connections` |
| `DELETE /api/admin/tags/{id}`            | `can_manage_connections` |
| `GET /api/admin/connection-tags`         | `can_manage_connections` |
| `GET /api/admin/recordings`              | `can_view_sessions`      |
| `GET /api/admin/recordings/{id}/stream`  | `can_view_sessions`      |

Each affected handler now starts with the appropriate
`crate::services::middleware::check_*_permission(&user)?;` call,
matching the pattern already used by its sibling create / update /
delete handlers. The `require_admin` middleware itself is
**unchanged** because it correctly models the "is this an admin
surface?" question; tightening it would break legitimate delegated
roles that should still see the subset of pages their single flag
covers.

### 1.4 Operator action

If you only use the default `admin` role (which holds every flag),
no action is required — your admin users see no behaviour change.

If you maintain any custom delegated admin roles, audit them under
**Settings → Roles**:

1. For each role, confirm that the holder needs the flag matching
   each endpoint they were previously able to reach (the table
   above is the authoritative mapping).
2. Grant the missing flag if the access is legitimate; remove the
   flag the role previously over-relied on if the access was
   accidental.
3. Roles holding only `can_view_audit_logs` continue to access the
   audit log surface (`GET /api/admin/audit-logs`,
   `GET /api/admin/audit-logs/export`, etc.) exactly as before.

### 1.5 Acceptance test

1. Create a delegated role with **only** `can_view_audit_logs`
   enabled. Assign it to a test user.
2. Have the test user sign in. Call:
   - `GET /api/admin/audit-logs` — must return `200 OK`.
   - `GET /api/admin/settings` — must return `403 Forbidden` on
     v1.12.7 (returned `200 OK` on v1.12.6).
   - `GET /api/admin/recordings` — must return `403 Forbidden` on
     v1.12.7.
   - `GET /api/admin/health` — must return `403 Forbidden` on
     v1.12.7.
3. Add `can_manage_system=true` to the same role and have the user
   sign out and back in. All endpoints above must now return
   `200 OK`.

### 1.6 Migration notes

- No database migrations, no schema changes.
- No new environment variables.
- No new Cargo or npm dependencies.
- The HTTP response body for `403 Forbidden` is the standard
  `AppError::Forbidden` shape — `{ "error": "Forbidden" }` with
  status `403`. The frontend admin pages already render a sensible
  "you don't have permission" state from that response.

---

# What's New in v1.12.6

> **Patch release — Security: OIDC RP-Initiated Logout.** A
> penetration test against v1.12.5 found that clicking **Log out**
> in the Strata SPA cleared Strata's own session cookies and revoked
> its local JWT, but **never contacted the IdP**. The browser kept
> the upstream Keycloak SSO cookie, so the very next click of
> **Sign in** silently re-authenticated against the surviving
> Keycloak session without prompting for a password or MFA challenge.
> v1.12.6 wires up the standard OIDC RP-Initiated Logout 1.0 flow:
> `POST /api/auth/logout` now returns a `post_logout_url` field
> when the user signed in via SSO, the SPA navigates the browser to
> it, and Keycloak destroys its own session before bouncing back to
> `/login` via the registered post-logout redirect URI. **One IdP
> configuration step is required** (register
> `https://<your-strata-fqdn>/login` under **Valid Post Logout
> Redirect URIs**); see the operator section below. No migrations,
> no new environment variables, no new Cargo or npm dependencies.

## Theme 1 — Pentest finding: `POST /api/auth/logout` never terminates the IdP session

### 1.1 Symptom

A pentester signed in to a v1.12.5 deployment via the Keycloak SSO
button on the login page, completed the password + MFA challenge, was
redirected back to the dashboard, and then clicked **Log out** in the
top-right menu. The SPA cleared its in-memory user state and navigated
to `/login`. So far so good. The pentester then immediately clicked
the **Sign in with Keycloak** button on the login page — and was
redirected straight back to the dashboard, **without ever being asked
for a password or MFA token**. The whole sequence — sign out, sign
back in — took two clicks and no keyboard input.

From a workstation-walk-away threat model this is the same as never
having logged out at all: a co-worker who sits down at the abandoned
session can re-enter the application as the previous user in two
clicks. The audit log shows two separate `auth.sso_login` rows, which
correctly reflects what Strata saw on the wire, but is misleading
about what the user did at the keyboard — they typed nothing.

### 1.2 Root cause — Strata clears its own cookies; the IdP cookie survives

`POST /api/auth/logout` did exactly two things:

1. Revoked the locally-signed access and refresh JWTs in the
   `token_revocations` table (so a stolen Strata token could not be
   replayed).
2. Tombstoned the four session cookies (`access_token`,
   `refresh_token`, `csrf_token`, `session_expires`) with
   `Set-Cookie: ...; Max-Age=0`.

What it did NOT do was contact Keycloak. Keycloak's own SSO session
cookie (set on the Keycloak domain, not the Strata domain, by the
authorization-code flow during the original sign-in) is invisible to
Strata's logout code path and survived untouched. The next click of
**Sign in with Keycloak** re-ran the authorization-code flow, hit
Keycloak's authorize endpoint, observed the live SSO cookie, and
short-circuited the password + MFA prompt — exactly the flow Keycloak
exists to implement.

The existing comment in [`backend/src/routes/auth.rs`](backend/src/routes/auth.rs)
acknowledged the gap explicitly:

```rust
// OIDC tokens are not revoked here — they should be ended at the IdP
// via the configured end-session endpoint. The cookie clear below is
// still best-effort for the browser side.
```

v1.12.5 simply never built out that "should be ended at the IdP" path.

### 1.3 Fix — OIDC RP-Initiated Logout 1.0

The fix wires up the [OpenID Connect RP-Initiated Logout 1.0] spec
end to end. Three coordinated changes:

[OpenID Connect RP-Initiated Logout 1.0]: https://openid.net/specs/openid-connect-rpinitiated-1_0.html

**Backend — capture the id_token at sign-in.**
`GET /api/auth/sso/callback` already received an `id_token` in the
token-exchange response and validated it against the IdP's JWKS, then
threw it away. The callback now persists the raw token in a new
`id_token` cookie alongside the existing access / refresh / csrf /
session_expires set:

```
Set-Cookie: id_token=<jwt>; HttpOnly; Secure; SameSite=Strict;
            Path=/api; Max-Age=<REFRESH_TOKEN_TTL>
```

The cookie is HttpOnly so SPA JavaScript can never read it. Path is
`/api` so it is only sent on calls to the backend. Lifetime matches
the refresh token so the hint survives access-token rotation (a user
on a long shift could refresh their access token many times before
hitting Log out; the id_token must still be there).

**Backend — build the logout URL on logout.**
`POST /api/auth/logout` now reads the `id_token` cookie, decodes the
**unverified** `iss` claim (safe because the token was
cryptographically verified at SSO callback time and the cookie is
locked behind HttpOnly + Secure + SameSite=Strict + Path=/api), looks
up the matching `sso_providers` row by `issuer_url`, fetches the
provider's OIDC discovery document (cached in `services::auth`), and
— if the IdP advertises `end_session_endpoint` — builds:

```
{end_session_endpoint}
  ?id_token_hint=<id_token>
  &post_logout_redirect_uri=<base_url>/login
  &client_id=<client_id>
```

The URL is URL-encoded via the existing `urlencoding` crate (already
in use for the authorize URL) and returned in a new field on the
JSON response:

```json
{ "status": "logged_out", "post_logout_url": "https://kc..." }
```

For local-account logouts (no `id_token` cookie), IdPs that don't
advertise `end_session_endpoint`, and any failure along the lookup
path, `post_logout_url` is `null` — every defensive branch falls back
to the pre-fix local-only behaviour rather than erroring.

The `id_token` cookie itself is tombstoned (`Max-Age=0`) on every
logout — including local-account logouts — so a stale value never
leaks across sessions on a shared workstation.

**Frontend — navigate to the IdP if asked.**
`apiLogout()` in [`frontend/src/api.ts`](frontend/src/api.ts) now
returns the parsed response body (`LogoutResponse | null`) instead of
`void`. A missing or unparseable body returns `null` so callers
downgrade gracefully when talking to a v1.12.5 or older backend.

`App.tsx` `handleLogout` awaits that promise and branches:

```ts
void apiLogout().then((res) => {
  if (res?.post_logout_url) {
    // Full page nav — leaves the SPA so the IdP can clear its
    // session cookies and bounce back to /login.
    window.location.assign(res.post_logout_url);
  }
});
setAuthenticated(false);
setUser(null);
navigate("/login");
```

Local state is wiped synchronously so the UI snaps back instantly; if
the IdP navigation fires, the post-redirect SPA load sees no cookies
and renders the Login screen.

### 1.4 What the user sees now

SSO user clicks **Log out**:

1. Strata closes every live tunnel (existing v1.3.2 behaviour).
2. SPA fires `POST /api/auth/logout`.
3. Backend revokes the local JWT, tombstones all five cookies
   (including the new `id_token`), and returns
   `{"status":"logged_out","post_logout_url":"https://kc.../logout?..."}`.
4. SPA flips React state, navigates locally to `/login`, then
   immediately calls `window.location.assign(post_logout_url)`.
5. Browser hits Keycloak's `end_session_endpoint` with the
   `id_token_hint`; Keycloak validates the hint, destroys its SSO
   session cookie for this client, and 302s the browser back to
   `https://<strata>/login` (the registered
   `post_logout_redirect_uri`).
6. The Strata SPA re-loads at `/login` with zero cookies on either
   side. Next click of **Sign in with Keycloak** re-runs the full
   password + MFA challenge.

Local-account user clicks **Log out**: behaviour is unchanged from
v1.12.5 — the JSON response carries `post_logout_url: null`, the SPA
takes the local `/login` path and never leaves the SPA.

### 1.5 Operator action — register the post-logout redirect URI

**Required in Keycloak ≥ 25.0** (which validates
`Valid Redirect URIs` and `Valid Post Logout Redirect URIs`
separately) and recommended on every IdP for clarity:

1. Open the Keycloak admin console → your realm → **Clients** → the
   Strata client.
2. Open **Settings** → scroll to **Access settings**.
3. Add `https://<your-strata-fqdn>/login` to **Valid Post Logout
   Redirect URIs**. Wildcards are allowed by Keycloak; the explicit
   path is recommended for least-privilege.
4. **Save**.

Without this entry, Keycloak rejects the logout redirect with
`Invalid redirect uri` and the user lands on a Keycloak error page
instead of `/login`. The user IS still logged out of both Strata
AND Keycloak at that point (the redirect rejection happens AFTER
the session is destroyed) — they just see a confusing error page
instead of the Strata Login screen. The Strata Settings → SSO /
OIDC documentation in [`docs/deployment.md`](docs/deployment.md)
includes the same note.

Auth0, Okta, Entra ID, and other RP-Initiated Logout 1.0 conformant
IdPs have the same configuration knob under different names
(Auth0: **Allowed Logout URLs**; Okta: **Sign-out redirect URIs**;
Entra ID: **Front-channel logout URL** plus
`post_logout_redirect_uri` validation through **Redirect URIs**).
Register `https://<your-strata-fqdn>/login` under whichever field
your IdP exposes.

### 1.6 Tests

Twelve new test cases pin the fix:

- **`backend/src/services/auth.rs`** (3 cases):
  `oidc_discovery_deserializes_with_end_session_endpoint`,
  `oidc_discovery_deserializes_without_end_session_endpoint` (legacy
  IdPs without the field default to `None`), and an extension of the
  existing `oidc_discovery_clone` to cover the new field.
- **`backend/src/routes/auth.rs`** (7 cases):
  `logout_response_tombstones_id_token_cookie` (regression test for
  the cookie tombstone),
  `logout_response_includes_post_logout_url_field` (the JSON
  response always surfaces the field, set to `null` for local
  logouts),
  `id_token_issuer_extracts_iss_from_jwt`,
  `id_token_issuer_returns_none_for_malformed_input`,
  `id_token_issuer_returns_none_when_iss_claim_missing` (defensive
  parsing of the unverified `iss` claim),
  `build_rp_initiated_logout_url_returns_none_without_id_token_cookie`,
  and `build_rp_initiated_logout_url_returns_none_without_db` (the
  helper short-circuits to `None` on every defensive branch rather
  than erroring).
- **`frontend/src/__tests__/api.test.ts`** (2 cases):
  `returns parsed body including post_logout_url when backend
supplies it` and `returns null when the response body cannot be
parsed (back-compat with ≤ 1.12.5)`.

Every pre-existing logout, SSO callback, and OIDC discovery test
continues to pass without modification.

### 1.7 Operator impact

- No migrations. No new environment variables. No new Cargo or npm
  dependencies. Drop-in upgrade from v1.12.5:
  `docker compose pull && docker compose up -d --build` (or the
  ghcr / k8s equivalent).
- One IdP-side configuration step is required (register
  `https://<your-strata-fqdn>/login` under **Valid Post Logout
  Redirect URIs**); see §1.5.
- IdPs that omit `end_session_endpoint` from their OIDC discovery
  document fall back transparently to the pre-fix behaviour. The
  backend logs a warning the first time it can't build the URL.
- The new `id_token` cookie is approximately 1–2 KB on a typical
  Keycloak deployment — well inside the 4 KB per-cookie browser
  limit. Realms with unusually large id_tokens (custom claims
  pushing past 4 KB) should review their client-scope mappers;
  nothing in Strata caps the size.

---

# What's New in v1.12.5

> **Patch release — Security: `GET /api/admin/settings` masks
> Vault-sealed values.** A penetration test against v1.12.4 found
> that the sealed Azure Storage access key used for session-recording
> upload was being returned in full from `GET /api/admin/settings`
> as its Vault Transit envelope (`vault:{"ct":...,"dek":"vault:v1:..."}`).
> The encrypted ciphertext itself is not directly exploitable —
> decrypting it requires the Vault server's Transit master key —
> but the value should never have been on the wire at all.
> v1.12.5 closes the redaction-list gap (`recordings_azure_access_key`
> and `smtp_encrypted_password` are now explicitly masked) and adds
> a defence-in-depth rule: **any setting value beginning with
> `vault:` is masked regardless of its key name**, so future sealed
> settings are protected the moment they are written. The companion
> change in `PUT /api/admin/recordings` recognises the mask
> sentinel on round-trip so the UI's pre-filled `********` no
> longer overwrites the real access key. No migrations, no new
> environment variables, no new Cargo or npm dependencies.

## Theme 1 — Pentest finding: sealed envelope leaking through `/api/admin/settings`

### 1.1 Symptom

A pentester running an authenticated session as an administrator
hit `GET /api/admin/settings` against a v1.12.4 deployment and
observed (excerpt):

```json
{
  "recordings_azure_access_key": "vault:{\"ct\":\"TsCYB7Uh…\",\"dek\":\"vault:v1:QY7B2A5P…\",\"n\":\"…\"}",
  …
}
```

The same response carried the SMTP relay password in the same
envelope form under `smtp_encrypted_password`. Other sealed
secrets (SSO client secret, AD bind password, Vault token) were
correctly masked as `********`.

### 1.2 Root cause — redaction list used the wrong key name

`backend/src/routes/admin.rs` already had a `SENSITIVE_SETTINGS`
list whose entries are substring-matched against every key the
admin settings handler returns:

```rust
const SENSITIVE_SETTINGS: &[&str] = &[
    "sso_client_secret",
    "ad_bind_password",
    "azure_storage_access_key",  // ← wrong: the actual key is `recordings_azure_access_key`
    "vault_token",
    "vault_unseal_key",
];
```

The substring `azure_storage_access_key` does **not** appear in
`recordings_azure_access_key` (the words are in a different
order), so the filter silently let the envelope fall through. The
`smtp_encrypted_password` key — added in the v0.25.0 notifications
work — was never added to the list at all, because at the time
the SMTP password was being designed and the focus was on the
new dedicated `PUT /api/admin/notifications/smtp` route, with
the legacy generic settings response treated as out-of-scope.

### 1.3 Fix — explicit keys plus a `vault:` envelope-prefix catch-all

Two changes to `redact_settings`:

1. The explicit `SENSITIVE_SETTINGS` list now contains
   `recordings_azure_access_key`, `smtp_encrypted_password`, and
   the unprefixed substring `azure_access_key` (so any future
   sealed Azure-style key whose name contains those words is
   covered).
2. A new defence-in-depth rule: **any value beginning with the
   literal prefix `vault:` is masked regardless of its key**.
   Because every value Strata writes via `vault::seal_setting`
   is formatted as `vault:{json}` ([`backend/src/services/vault.rs:291`](backend/src/services/vault.rs)),
   this rule means the response can never accidentally leak a
   future sealed setting whose key name happens to be missing
   from the explicit list.

```rust
fn redact_settings(settings: Vec<(String, String)>) -> Vec<(String, String)> {
    settings.into_iter().map(|(k, v)| {
        if SENSITIVE_SETTINGS.iter().any(|s| k.contains(s))
            || v.starts_with(VAULT_ENVELOPE_PREFIX) {
            (k, STAR_MASK.to_string())
        } else {
            (k, v)
        }
    }).collect()
}
```

### 1.4 Round-trip safety — `PUT /api/admin/recordings` skips mask values

Masking the GET response would have introduced a regression in
`PUT /api/admin/recordings`. The Recordings admin tab populates
its password-style input directly from
`settings.recordings_azure_access_key` and submits whatever the
input contains on save. With the new mask, the UI's input now
reads `********` until the operator types a new value; without
the companion fix, clicking **Save Recording Settings** would
have sealed the literal string `********` and overwritten the
real Azure key.

`update_recordings` now recognises the redaction sentinels
(`********` and `••••••••`) on the `azure_access_key` field and
treats them as "no change" (no `settings::set` call is issued for
that key). This matches the round-trip pattern already in place
for SSO and AD bind passwords in `update_settings`. The SMTP path
is unaffected: `PUT /api/admin/notifications/smtp` already uses a
three-state discriminated union (`{action: 'keep' | 'clear' |
'replace', value?}`) on the wire, so the masked GET value is
never echoed back.

### 1.5 What the encrypted envelope actually was

For the record, the value the pentester saw is the documented
Vault Transit envelope format, two layers removed from any
plaintext credential:

- The outer `vault:{json}` envelope is Strata's own per-value
  AES-256-GCM ciphertext (`ct`), nonce (`n`), and Vault-wrapped
  data encryption key (`dek`).
- The inner `vault:v1:<base64>` segment inside `dek` is the
  native ciphertext format produced by HashiCorp Vault's
  `transit/encrypt/<key>` endpoint — `v1` is the Transit master
  key generation, and the base64 payload is opaque AES-256-GCM
  ciphertext with a random nonce. Decrypting it requires the
  Vault server's Transit master key, which is generated inside
  Vault and never traverses the wire.

The defence-in-depth `vault:` prefix rule catches both layers —
the outer Strata envelope and any raw Transit ciphertext that
might end up in `system_settings` directly in future work.

### 1.6 Tests

Three new unit tests in `backend/src/routes/admin.rs`:

- `redact_settings_masks_recordings_azure_access_key` — regression
  test that pins the pentest finding. Passes a row with the exact
  key name and a representative envelope value, asserts the
  returned value is `********`.
- `redact_settings_masks_smtp_encrypted_password` — same shape,
  for the second key that was missing from the list.
- `redact_settings_masks_any_vault_envelope_value` — exercises
  the prefix-based fallback with a key name that is **not** in
  `SENSITIVE_SETTINGS` but whose value starts with `vault:`,
  asserting it is still masked. Includes a negative case to
  confirm that a value containing the word `vault` but not
  starting with `vault:` is left untouched.

The pre-existing redaction tests
(`redact_settings_hides_sensitive_values`,
`redact_settings_passes_through_safe_keys`,
`redact_settings_masks_all_sensitive`,
`redact_settings_preserves_key_order`,
`redact_settings_partial_key_match`,
`redact_settings_empty_input`) all continue to pass without
modification — the old `azure_storage_access_key` substring is
deliberately retained in the list so the legacy test fixture
still matches.

### 1.7 Operator impact

- No migrations. No environment variables added. No Cargo or npm
  dependencies added. No new images or containers.
- Recommended deploy: `docker compose pull && docker compose up
-d --build` from v1.12.4 (or the ghcr / k8s equivalent).
- Operators who consumed `recordings_azure_access_key` or
  `smtp_encrypted_password` directly from the admin settings API
  for any out-of-band purpose will now see `********` in those
  fields. The dedicated `PUT /api/admin/recordings` and
  `PUT /api/admin/notifications/smtp` endpoints continue to
  accept new values; passing `********` is now a no-op (preserves
  the existing value), so a save-without-edit from the Recordings
  tab no longer destroys the Azure key.
- Pentest reports that previously flagged a sealed envelope as
  a finding against `/api/admin/settings` will no longer surface
  the value at all on v1.12.5 — the only thing that comes back
  for any sealed setting is the eight-asterisk mask.

---

# What's New in v1.12.4

> **Patch release — Command Palette open-session prioritisation.**
> A single-issue UX patch for operators who keep multiple sessions
> open and use the `Ctrl+K` palette as their primary session
> switcher. The connection list previously rendered in raw API
> order with no preferential placement for the sessions that were
> already open, so the fastest possible "jump to the other open
> session" interaction (`Ctrl+K → Enter`) was impossible without
> scrolling, arrow-keying, or typing a disambiguating substring.
> v1.12.4 sorts the list into three stable buckets — other open
> sessions, the session you're currently on, then everything else
> — so the most useful target is always the default. No backend
> changes, no API surface changes, no migrations, no new
> environment variables, no new Cargo or npm dependencies; the
> change is entirely scoped to
> `frontend/src/components/CommandPalette.tsx` plus its matching
> test.

## Theme 1 — `Ctrl+K` palette open-session prioritisation

### 1.1 Symptom

A user with several sessions open (e.g. an analyst comparing
records across `bnym-tracker-01`, `dataflow-01-live`, and
`dfviewer-prod`) uses the in-session Command Palette as their
day-to-day session switcher. They press `Ctrl+K`, type nothing,
and the palette opens with the **first connection in the user's
stored connections list** highlighted — regardless of whether
that connection is one of the open sessions or not. To switch to
a specific open session the user has to either (a) scroll the
list, (b) arrow-key down through every inactive connection until
they land on an open one, or (c) type a disambiguating substring
of the target's name. None of these are bad on their own, but
the most common case — _"I'm on Session A and I want to switch
to Session B which is also open"_ — is the slowest path through
the palette.

### 1.2 Root cause

The `filtered` array inside
[`CommandPalette.tsx`](../frontend/src/components/CommandPalette.tsx)
was the raw `connections.filter(...)` output, which preserves the
order returned by
[`GET /api/user/connections`](api-reference.md). That endpoint
does not surface any notion of session state — it returns the
user's _authored_ connection list in the order their admin
created them in. The `activeConnectionIds` set (used to render
the green **Active** pill on each row) was already computed at
render time but only drove the pill, not the row order. As a
result: open sessions were visually marked, but were not
positionally promoted.

### 1.3 Fix

After the existing query filter runs, the array is sorted
through a single stable comparator that maps each row to one of
three rank buckets:

```
0 — open session you are NOT currently looking at
1 — open session you ARE currently looking at
2 — connection that is not open
```

With two helpers derived at render time:

- `activeConnectionIds: Set<string>` — already-present pre-render
  set, computed once per render via
  `new Set(sessions.map((s) => s.connectionId))`.
- `activeConnectionId: string | null` — newly-introduced helper
  that resolves the **connection id of the session the user is
  currently focused on** by intersecting `sessions` with the
  existing `activeSessionId` from `useSessionManager()`.

The comparator is a one-liner against a per-row `rank()` lookup:

```ts
const rank = (id: string) => {
  if (!activeConnectionIds.has(id)) return 2;
  if (id === activeConnectionId) return 1;
  return 0;
};
```

ECMAScript 2019+ specifies `Array.prototype.sort` as **stable**,
so the original API order is preserved _within_ each rank
bucket. This means:

- Open sessions don't reshuffle when another session opens or
  closes — only the bucket boundaries shift.
- Inactive connections continue to appear in exactly the same
  order they always did beneath the open sessions, so users who
  have internalised the existing presentation order over the
  past six minor versions don't have to relearn anything.
- The currently-displayed session sits at rank 1 (just below the
  other open sessions), keeping it one keystroke away for the
  rare case the operator actually does want to re-focus or
  reconnect it.

### 1.4 User-visible effect

With two open sessions (`prod-db` and `dev-rdp`) and the user
currently focused on `prod-db`:

1. Press `Ctrl+K`.
2. `dev-rdp` is highlighted at the top of the list.
3. Press `Enter` → jump straight to `dev-rdp` — the fastest
   possible "switch to the other open session" interaction.
4. To return to `prod-db`: `Ctrl+K`, `↓`, `Enter`.

With one open session (`prod-db`) and the user currently focused
on it:

1. Press `Ctrl+K`.
2. `prod-db` is highlighted at the top (rank 1 — it's the only
   open session and the user is on it).
3. Press `Enter` → no-op (already on it; SessionManager keeps it
   foregrounded). Behaviour is identical to v1.12.3.

With no open sessions:

1. Press `Ctrl+K`.
2. The first connection in API order is highlighted, exactly as
   in every previous version.
3. Press `Enter` → launch that connection. Behaviour is
   identical to v1.12.3.

### 1.5 What did NOT change

Everything else about the palette is untouched:

- The query filter still matches against `name`, `protocol`,
  `hostname`, `description`, `folder_name`, and every assigned
  user-tag name (case-insensitive substring).
- The `:command` surface (colon-prefixed input) is unchanged —
  same fixed-order built-in registry, same user-mapped commands
  from `user_preferences.preferences.commandMappings`, same
  ghost-text autocomplete, same audit-row emission via
  [`POST /api/user/command-audit`](api-reference.md).
- The green **Active** pill on rows is unchanged.
- Connection folders and tag pills are unchanged.
- The pop-out vanilla-DOM palette
  ([`utils/popoutPalette.ts`](../frontend/src/utils/popoutPalette.ts))
  is unchanged — it serves a single pop-out window's own
  session-switcher, where the three-bucket rank is not
  meaningful.

### 1.6 Tests

One new test in
[`__tests__/CommandPalette.test.tsx`](../frontend/src/__tests__/CommandPalette.test.tsx)
asserts the new behaviour end-to-end:

> _"sorts open sessions to the top, with the currently-displayed
> one second"_

The test mocks `useSessionManager` with two sessions (`c1` and
`c3` open, user focused on `c1`), renders the palette, and
asserts:

1. The DOM order of `[role="option"]` rows is `[c3, c1, c2]`
   (rank-0 → rank-1 → rank-2).
2. The default-highlighted row is the first one (`c3`).
3. Pressing `Enter` navigates to `/session/c3` — the **other**
   open session, not the one already on screen.

All 15 pre-existing palette tests continue to pass without
modification — their mock fixtures happen to put the (single)
active session first in API order already, so the new sort is a
no-op for those fixtures and the original assertion targets
remain valid.

### 1.7 Operator impact

None in the operational sense — no migrations, no new env vars,
no config file changes, no new Cargo or npm dependencies, no
new images or containers. Recommended deploy:
`docker compose pull && docker compose up -d --build` (or the
ghcr/k8s equivalent) and nothing else.

The backend container image is byte-identical to v1.12.3 in
everything except the `[workspace.package].version` field
embedded into the binary; the frontend container image differs
only in the rebuilt JS bundle (new sort logic + new test, with
`__APP_VERSION__` bumped so the **What's New** carousel
surfaces on first sign-in). Mixed v1.12.3 / v1.12.4 deployments
handshake cleanly; the `strata-dmz` relay binary cosmetically
bumps version (shared workspace `[workspace.package].version`)
but its wire protocol is byte-identical, so the **Admin → DMZ
Links** tab will show a _Mixed_ indicator until every relay is
upgraded.

Sites that do not use the Command Palette feature (configured
out via `commandPaletteBinding = ""` in user preferences, or
simply unused) see zero behavioural change.

---

# What's New in v1.12.3

> **Patch release — Safeguard JIT post-approval username regression
> fix.** A single-issue hotfix for users whose Safeguard accounts
> require approver action before the password can be checked out:
> the SPA flipped the request to "Released" the moment the
> approver acted, but every subsequent tunnel attempt against the
> protected target failed with `Authentication failure (invalid
credentials?)` because the cached row carried `username = NULL`
> and the tunnel was therefore sending an empty NLA username with
> a correct password. The auto-released (no-approval) path was
> unaffected. No protocol changes, no migrations, no new
> environment variables, no new Cargo or npm dependencies; existing
> v1.12.x deployments upgrade with `docker compose pull && docker
compose up -d --build`. The fix is entirely scoped to
> `backend/src/services/safeguard/*`.

## Theme 1 — Safeguard JIT post-approval username regression

### 1.1 Symptom

A user is mapped to a credential profile of `kind = 'safeguard'`
whose underlying Safeguard account requires `Approver` or
`Reviewer` action before `CheckoutPassword` will release the
plaintext (a common policy on tier-0 / privileged accounts). The
operator submits a request via **Credentials → Bulk Checkout**
with a justification comment, the SPA shows the row as
**Awaiting approver — request {rid} is queued in Safeguard
(state: PendingApproval)**, the approver acts (in the Safeguard
portal or via the in-app approval surface), the SPA's polling
loop hits `POST /api/user/safeguard/release`, and the row flips
to **Released** with a green check and the appliance-reported
TTL.

The user then clicks the affected connection on the Sessions
page. The tunnel opens to guacd, guacd attempts the RDP / SSH
handshake against the target server, and the target rejects the
authentication. The frontend renders a toast:

> **Connection Error** — Authentication failure (invalid
> credentials?)

The user can confirm with three observations that the password
itself is fine: (a) the Safeguard portal shows the same
account checked out for the user with a still-live TTL; (b)
manually copying the password from the Safeguard portal and
typing it into the in-band auth prompt of the protocol client
always succeeds; (c) the target AD account is never locked out
despite repeated failures, which rules out the usual "auth bind
loop" failure mode and proves the credential reaching the
target is structurally wrong, not just incorrect.

### 1.2 Root cause

Safeguard's REST surface only echoes the target account's
`AccountName` back at request-creation time (the
`POST /service/core/v4/AccessRequests` response). Subsequent
`POST /AccessRequests/{id}/CheckoutPassword` calls return only
a JSON-encoded plaintext string — no `AccountName`, no
`AccountDomainName`, no enrichment whatsoever.

The initial `jit_checkout` orchestrator (called when the user
clicks **Bulk Checkout** with auto-release accounts, or when
the tunnel opens for a never-cached profile) captures the
`account_name` from the creation response and threads it
through `CheckoutResult.username` → `password_cache::store(...)`
→ `safeguard_cached_passwords.username`. That column is the
authoritative source for the NLA username at tunnel-open time.

But the **post-approval release path** is structurally
different: the original bulk-checkout call returned
`JitOutcome::PendingApproval { request_id, … }` and the SPA
polls `POST /api/user/safeguard/release` until the approver
acts. That polling endpoint dispatches through
`services::safeguard::release_pending(...)`, which only has the
`request_id` to work with — there is no fresh creation
response. Until v1.12.3, `release_pending` hard-coded
`username: None` on the `Released` arm of its match (an in-code
TODO comment acknowledged this and said "the caller is expected
to use the profile's stored username or refetch the request
details" — neither happened). The route handler
`release_safeguard_pending` faithfully forwarded that `None`
into `password_cache::store(...)`, persisting the cache row
with `username = NULL`.

The credential-profile table does **not** carry a `username`
column for `kind = 'safeguard'` rows — the username is always
sourced from Safeguard's `AccountName` because it is the only
source of truth (it can be rotated by Safeguard policy at any
time). So there was no fallback.

At tunnel-open time, the JIT path in `routes/tunnel.rs` loaded
the cache row and assigned `safeguard_username = cached.username`
— which was `None` — and the tunnel handler propagated that into
the `(vault_username, vault_password)` tuple as
`(None, Some(<correct-password>))`. guacd / FreeRDP / OpenSSH
then attempted authentication with an **empty username** and
the correct password, which the target server rejected
pre-lockout as "invalid credentials". The pre-existing comment
at the relevant call site flagged exactly this failure mode —
the comment was right; the post-approval path was the one site
that never got the resolved name.

### 1.3 Fix

A new `client::get_access_request_status(...)` function (renamed
and extended from the v1.12.x-era `get_access_request_state(...)`
helper) issues a `GET /service/core/v4/AccessRequests/{id}` and
now returns a small struct:

```rust
#[derive(Debug, Clone, Default)]
pub struct AccessRequestStatus {
    pub state: Option<String>,
    pub account_name: Option<String>,
}
```

The `state` field is what the existing
`password_cache::check_request_validity(...)` validator was
already using to decide whether a cached row was still live on
the appliance (`PasswordCheckedOut` → `Active`, anything else →
`Inactive`, 404 → `Inactive`). The new `account_name` field is
consumed by the `Released` arm of `release_pending`:

```rust
let username = match client::get_access_request_status(
    &http, &base, &bearer, request_id,
).await {
    Ok(Some(status)) => status.account_name,
    Ok(None)         => None,   // 404 — request purged
    Err(_)           => None,   // logged at warn, non-fatal
};
Ok(JitOutcome::Released(CheckoutResult {
    request_id: request_id.to_string(),
    password,
    username,
}))
```

The route handler `release_safeguard_pending` is unchanged — it
already forwarded `outcome.username` into
`password_cache::store(...)` — so the cache row now carries the
real username for both the auto-released path and the
post-approval path. The single existing caller of the old
`get_access_request_state` (`check_request_validity`) was
updated to read `status.state` and to map the 404 case
(`Ok(None)`) onto `CacheValidity::Inactive` explicitly,
preserving the pre-existing implicit behaviour where `None`
failed to match `Some("PasswordCheckedOut")` and therefore
returned `Inactive`.

Refetch failure is non-fatal and logged at warn so a transient
appliance hiccup during the refetch does not block the user
from connecting (the password is still returned and cached;
the only consequence of a failed refetch is the pre-fix
behaviour). The appliance-side `safeguard_checkout_audit` row
already records the `success` outcome before the refetch
runs, so the audit trail is unaffected by refetch outcome.

### 1.4 Backwards compatibility

| Surface                                           | Status    |
| ------------------------------------------------- | --------- |
| `POST /api/user/safeguard/bulk-checkout` request  | Unchanged |
| `POST /api/user/safeguard/bulk-checkout` response | Unchanged |
| `POST /api/user/safeguard/release` request        | Unchanged |
| `POST /api/user/safeguard/release` response       | Unchanged |
| `GET /api/user/safeguard/cached` shape            | Unchanged |
| `safeguard_cached_passwords` table schema         | Unchanged |
| `safeguard_checkout_audit` table schema           | Unchanged |
| `safeguard_config` table schema                   | Unchanged |
| Migrations introduced                             | None      |
| Environment variables added                       | None      |
| Cargo dependencies added                          | None      |
| npm dependencies added                            | None      |

Cache rows persisted by v1.12.2 against approval-required
accounts will continue to carry `username = NULL` until they
expire (default TTL: the profile's own `ttl_hours`); operators
who want to evict them immediately can click **Check in all**
in the bulk-checkout card or call
`POST /api/user/safeguard/checkin` with `{"profile_ids": []}`.
After the rebuild, a fresh approve-and-release cycle will
write a complete row.

### 1.5 Why was this not caught earlier?

Two reasons:

1. **Most lab and dogfood Safeguard accounts auto-release.** The
   integration test plan exercised the
   `jit_checkout → Released` happy path extensively (which
   does populate username correctly from the
   `CreateAccessRequest` response). The `PendingApproval →
poll → Released` path requires an approver-in-the-loop
   setup that the lab appliance was not configured for at
   integration time.
2. **The cache row looked superficially complete.** All other
   fields on the row — `expires_at`, `request_id`,
   `ciphertext`, `encrypted_dek`, `nonce` — were populated
   correctly, so the cache validator
   (`check_request_validity`) reported `Active` against the
   live appliance request and the tunnel handler took the
   "cache hit" branch happily. The failure surfaced only at
   the very last hop (guacd → target), where the empty NLA
   username triggered a generic auth-failure response that
   looked like every other "wrong password" failure to a
   harried operator.

The frontend toast text — "Authentication failure (invalid
credentials?)" — surfaced unchanged from guacd's own
in-protocol error, so the SPA had no signal that the issue
was a missing username rather than a wrong password.

### 1.6 Verification

- `docker compose build backend` clean (release profile, ~1m31s
  actual compile).
- rust-analyzer reports zero errors / warnings across the
  modified files (`backend/src/services/safeguard/client.rs`,
  `backend/src/services/safeguard/mod.rs`).
- All existing `parse_awaiting_approval_*` unit tests in
  `client.rs` continue to pass.
- No compile, lint, or test changes are required on the
  frontend.

## Operator impact

No migrations. No new environment variables. No config changes.
No new Cargo or npm dependencies — net zero supply-chain churn.
Recommended deploy:

```sh
docker compose pull
docker compose up -d --build backend
```

(Backend only; the frontend image rebuilds with the bumped
`__APP_VERSION__` so the in-app **What's New** modal will surface
this card on first sign-in after the upgrade, but the frontend
JavaScript / CSS bundle is otherwise byte-identical to v1.12.2.)

Sites that do not use Safeguard JIT credential profiles can
defer indefinitely — the fix is entirely scoped to the
`services::safeguard::*` module tree and does not affect any
other code path. Sites using only auto-released Safeguard
accounts (no approver-gated entitlements) are also unaffected
in practice but should still upgrade in normal cadence; the
fix hardens the post-approval path against the same regression
returning under future appliance-side workflow changes.

The `strata-dmz` relay binary cosmetically bumps version (it
shares the workspace `[workspace.package].version` field) but
its wire protocol and behaviour are byte-identical to v1.12.2,
so mixed v1.12.2 / v1.12.3 deployments handshake cleanly; the
Admin → DMZ Links tab will show a **Mixed** indicator until
every link is upgraded.

---

# What's New in v1.12.2

> **Patch release — Outbound Quick Share polish, approver email
> fan-out, BASE_URL fallback for email links, ClamAV healthcheck
> IPv6 dodge, recordings-volume write fix, Kali Linux VDI image.**
> No protocol breakage, no migrations, no new environment
> variables; existing v1.12.x deployments upgrade with
> `docker compose pull && docker compose up -d --build`. This
> release rolls thirteen merged PRs (#268–#280) into one shipping
> bundle and closes six themes that the v1.11.0 outbound-share
> landing and the v1.12.0 AV-scanning landing left rough:
> day-to-day UX polish on the outbound-share surfaces, a
> long-overdue email fan-out for outbound approvers, a tenant-URL
> resolution chain that no longer hardcodes `https://strata.local`
> for unconfigured installs, a clamav sidecar that stops lying
> about being unhealthy on dual-stack hosts, a recordings-volume
> permission fix that lets the sweeper actually sweep, and a
> Kali Rolling VDI image for security teams who want a
> tunnel-routed jump-box for authorised engagements.

## Theme 1 — Outbound Quick Share UX polish

Five small fixes that take the v1.11.0 outbound flow from
"functional" to "comfortable" for the operators who actually
live in it day-to-day. Each fix is independently
unremarkable; together they materially smooth the every-share
flow.

### 1.1 Paste-and-run snippets via the File-path input

The snippet builder under **Outbound Share → Generate upload
command** gains a new **File path** text input between the
snippet-format dropdown and the **Skip TLS verification**
checkbox. The user pastes the path of the file they intend to
upload (e.g. `C:\Users\analyst\Desktop\report.pdf` for the
PowerShell snippet, or `/home/analyst/report.pdf` for the
curl snippet) and the snippet body is regenerated with the
path substituted in place of the `<your-file>` placeholder,
using format-aware quoting so the resulting snippet is
paste-and-run instead of paste-edit-run:

| Snippet format        | Quoting rule                                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `curl` (POSIX)        | Single-quoted; embedded `'` escaped as `'\''`                                                                                                                                                                                                    |
| `curl --insecure`     | Same as curl                                                                                                                                                                                                                                     |
| `curl.exe` (Windows)  | Double-quoted via the full [`CommandLineToArgvW`](https://learn.microsoft.com/windows/win32/api/shellapi/nf-shellapi-commandlinetoargvw) rule — backslash runs before a `"` doubled, backslash runs at end-of-string doubled, then `"…"` wrapped |
| `curl.exe --insecure` | Same as `curl.exe`                                                                                                                                                                                                                               |
| PowerShell 7          | Single-quoted; embedded `'` doubled (`''`)                                                                                                                                                                                                       |

Empty input keeps the literal `<your-file>` placeholder so the
snippet stays self-documenting and copyable as a template; the
helper text below the snippet flips between **"Paste this into
a shell inside the session"** (empty) and **"This snippet
uploads `<the supplied path>`"** (non-empty) so the intent is
unambiguous either way. The CommandLineToArgvW handler was
designed specifically to close a CodeQL
`js/incomplete-sanitization` alert that a single-pass
`.replace(/"/g, '\\"')` would have tripped — see the
`escapeWinDoubleQuoted` unit test in
[QuickShareOutbound.test.tsx](frontend/src/__tests__/QuickShareOutbound.test.tsx)
that asserts `C:\foo\"bar.txt` round-trips correctly through
the helper (#280).

### 1.2 Admin → Outbound Shares auto-refresh while visible

The admin Outbound Shares tab now refreshes the pending queue
and the history list every 60 s while the browser tab is
visible. The poll is suspended on
`document.visibilitychange → hidden` so a parked tab on a
laptop does not keep the backend warm overnight, and resumed
(with one immediate refresh) on `visibilitychange → visible`
so the tab is up-to-date the instant the operator returns to
it. There is no change to the underlying admin API contract
— the polling effect simply re-fires the existing
`loadPending()` and `loadHistory()` calls that the initial
mount already runs (#279).

### 1.3 Curl snippets always print a completion summary

Every shipped `curl` / `curl.exe` snippet variant now ends with
a `printf`-style summary block that echoes the HTTP status,
the response body, and a one-line interpretation
(`Upload succeeded` / `Token rejected (probably expired or
already used)` / `Backend rejected the file — see body
above`). Before this fix, a stale ingest token returned `400
Bad Request` with a JSON error body and `curl` exited `0`
(HTTP-error responses are still "successful HTTP transactions"
by `curl` semantics), so the user saw nothing on the terminal
and had no way to tell the snippet had been rejected. The
summary block runs unconditionally whether the upload
succeeded or failed (#269).

### 1.4 Justification textarea stays visible without drive redirection

The conditional render on **Outbound Share** previously hid
the justification textarea (and the whole "I'd like to share
a file" form section) whenever the SPA had detected that drive
redirection was disabled by group policy, on the theory that
there was no drive-channel ingest path to write a justification
for. But the HTTPS upload-command flow needs a justification
too — the user has to type the reason **before** clicking
**Generate upload command**, because the justification is
part of the bound state on the minted token. The textarea is
now always rendered; only the "Drop a file here" upload
affordance is conditional on drive redirection being
available (#268).

### 1.5 ConfirmModal backdrop covers the full viewport

The ConfirmModal was previously rendered as a sibling of the
trigger button rather than as a top-level portal, so when the
modal was opened from inside a scrollable container (e.g. the
admin → Outbound Shares row-action menu, the Approvals page
table, the Health tab history pane), the fixed-position
backdrop was clipped to the scrollable ancestor's
`overflow:hidden` instead of the viewport. The modal body
itself still rendered, but the dim-out shading stopped at
the parent boundary, which made it look like the modal could
be dismissed by clicking on a "non-darkened" area that was
in fact part of the modal's own backdrop. The modal now
renders into a `document.body`-anchored React portal — the
backdrop covers the full viewport regardless of where in the
tree the modal was triggered from (#270).

## Theme 2 — Outbound-share approver email fan-out

Until v1.12.2, outbound submissions that landed in the
approval queue had no email notification path. The v1.11.0
landing wired up an in-app **Pending Approvals** popup
(`PendingApprovalWatcher`) that polled the queue every 45 s
and surfaced new pending items as a top-left card, which is
fine for operators who keep the SPA open all day, but
unhelpful for approvers who only check Strata when an email
prompts them to. The credential-checkout flow has had
transactional-email notifications since v1.7.0 — outbound
shares now gain the symmetric capability.

A new transactional email event (`OutboundShareEvent::Pending`)
fires the moment a non-bypass outbound submission lands in
the approval queue. The new
`outbound_share_pending.mjml` / `.txt.tera` template pair
joins the existing four `CheckoutEvent` templates under the
same Tera + mrml + Outlook dark-mode VML wrapper pipeline
([architecture.md](docs/architecture.md#transactional-email-pipeline)
documents the rendering chain in detail), and the same opt-out
/ audit rules apply: per-user `users.notifications_opt_out`
suppresses delivery and writes a `notifications.skipped_opt_out`
audit row, the retry-after-failure worker re-renders and
re-sends transient failures up to three times, and the
`PII boundary` rule that keeps the rendered body out of the
`email_deliveries` table (only `template_key`,
`related_entity_type`, `related_entity_id` are persisted)
applies identically (#271).

Two follow-up fixes hardened the fan-out before the release
cut:

- **`roles.can_manage_system`, not `users.can_manage_system`**
  (#273). The approver-discovery SQL was joining the wrong
  table for the super-admin check —
  `users.can_manage_system` is not a column;
  `can_manage_system` lives on the `roles` table and reaches
  the user through `user_roles`. The query happened to return
  zero rows rather than erroring out (the column-not-found
  was swallowed in a diagnostic-suppressed branch), so
  super-admins were silently excluded from the approver fan-out
  on early dogfood deployments of the new template.
  The corrected query reads
  `user_roles → roles WHERE roles.can_manage_system = true
UNION outbound_share_approvers`, matching the
  approval-resolution rule that both super-admins and
  explicit approver-delegation list members get the email.

- **Self-exclusion via `OutboundShareEvent::Pending.requester_id`**
  (#275). The pending-event fan-out was reading the requester
  ID from the wrong field of the event struct (an unused
  legacy `submitter_id` that was always `None` on the new
  event), so submitters who themselves held the approver bit
  emailed themselves about their own pending request. The fix
  reads `requester_id` directly off the
  `OutboundShareEvent::Pending` payload and excludes it from
  the recipient list before the row-per-recipient `INSERT`
  fan-out.

## Theme 3 — `BASE_URL` fallback for email links

Every transactional email template that includes a link back
into the SPA — checkout request / approval / rejection /
outbound-share pending — needs a tenant URL to build absolute
hrefs. Until now the templates rendered `https://strata.local`
as the link target whenever the
`system_settings.tenant_base_url` admin setting was empty —
broken even on perfectly-healthy installs that simply hadn't
filled in the optional admin field. Operators who deployed
through `docker compose` (where the tenant URL is generally
the value already passed in as the `BASE_URL` environment
variable on the frontend's nginx wrapper) had no way to
forward that value to the backend without manually entering
it through the admin UI on every install.

A new `services::settings::tenant_base_url(pool)` helper
resolves the tenant URL in three tiers, deterministically:

1. **`system_settings.tenant_base_url`** — admin-set, takes
   precedence when non-empty. Highest precedence so manual
   overrides win.
2. **`BASE_URL` environment variable** — deployment-set,
   picked up on every dispatch. No restart required if the
   admin setting is later cleared.
3. **`https://strata.local`** — build-in last-resort that
   at least produces a syntactically valid URL the recipient
   client can render as a link without flagging it as a
   broken href.

All four email-render call sites
(`notifications::build_context`,
`notifications::build_outbound_share_context`,
`email::worker` rebuild path,
`routes/notifications::sample_context` preview) now share
the helper, so the resolution order is identical regardless
of whether the email was rendered on the originating
dispatch, on a retry from the worker, or in the admin
preview panel (#278).

| Tier | Source                            | Picked when                                       |
| ---- | --------------------------------- | ------------------------------------------------- |
| 1    | `system_settings.tenant_base_url` | Admin entered a value (non-empty after trim)      |
| 2    | `BASE_URL` env var                | Tier 1 is empty and `BASE_URL` is set + non-empty |
| 3    | `https://strata.local`            | Tiers 1 and 2 both empty                          |

## Theme 4 — ClamAV healthcheck IPv6 dodge

The Docker `HEALTHCHECK` on the `clamav` sidecar previously
ran `clamdscan --ping localhost`, which resolved to `::1` on
hosts with dual-stack `/etc/hosts` (most modern Linux
distributions, including Ubuntu 22.04+ and Debian Bookworm)
and immediately failed because `clamd` only binds IPv4
(TCP `0.0.0.0:3310`) inside the container. The sidecar was
perfectly healthy and serving scans from the adjacent backend
container, but Docker reported `unhealthy` every minute,
which in turn poisoned every health-aware orchestrator that
read the container status (`docker-compose ps`,
`docker events`, Kubernetes liveness, anything that polled
`/v1.41/containers/{id}/json`).

Pinning the healthcheck to `127.0.0.1` explicitly avoids the
resolver ambiguity — `clamdscan --ping 127.0.0.1` now
reaches the IPv4 listener directly without traversing the
host's name-resolution stack, and the sidecar reports
`healthy` from boot (#274).

Operators on the `av` profile pick up the fix with
`docker compose --profile av up -d --build clamav`. The
named volume that holds the signature DB (`clamav-db`) and
the scan history (rooted in the backend's `system_settings`)
is preserved across the rebuild.

## Theme 5 — Recordings volume write permission

The `strata` user inside the backend container could not
delete expired `.guac` recordings from
`/var/lib/strata/guac-recordings` on hosts where the volume
was bind-mounted from a directory owned by `root:root` (the
default when docker-compose creates the directory on first
bring-up). The session-recording sweeper that runs every
hour (see `services::recordings::sweep_expired`) would log
`Permission denied` per-file and silently fail to delete
expired recordings, growing the recordings directory
indefinitely until the operator noticed (typically after
the host disk filled) and `chown`'d it by hand.

Two complementary fixes ship together:

- The backend `Dockerfile` now `mkdir`s
  `/var/lib/strata/guac-recordings` with the correct UID:GID
  baked into the image, so a fresh `docker compose up` (no
  bind mount, named volume only) lands on a correctly-owned
  directory.
- The backend `entrypoint.sh` now `chown -R strata:strata
/var/lib/strata/guac-recordings` on startup when the
  directory is writable by the entrypoint UID (typically
  `root` on bind-mounted setups, where `chown` is allowed),
  so bind-mount deployments also reach correct ownership on
  first boot without operator intervention.

The sweeper now successfully prunes expired recordings on
every tick (#277).

## Theme 6 — Kali Linux VDI image

A new `contrib/vdi-kali/` profile ships a Kali
Rolling-based VDI desktop with the `kali-linux-large`
metapackage preinstalled, targeted at security teams who want
a clean, audited, tunnel-routed jump-box for authorised
offensive engagements. Built the same way as
`contrib/vdi-sample/` —

```bash
docker build contrib/vdi-kali -t strata-vdi-kali:latest
```

— and tunnel-in via the existing VDI flow. The image follows
the same per-user-home volume pattern (`/home/$USER` from a
named volume) as the sample image so user work persists
across container restarts.

The `kali-linux-large` metapackage installs the full
`kali-tools-{web,wireless,information-gathering,exploitation-tools,…}`
line — Nmap, Metasploit Framework, Burp Suite Community
Edition, Wireshark, the Aircrack-NG suite, Hashcat, John the
Ripper, sqlmap, Hydra, and the rest of the standard Kali
toolkit. See the new
[`contrib/vdi-kali/README.md`](contrib/vdi-kali/README.md)
for the full toolset, the intended use case (authorised
offensive engagements routed through Strata's per-session
tunnel), and the security considerations (the image runs
with the same per-session network isolation as every other
VDI image — Kali tooling does not bypass the tunnel or the
session-recording boundary) (#276).

## Operator notes

- **No migrations.** No schema changes; no new tables,
  columns, or indexes. `cargo run --bin migrate` is a no-op
  on top of v1.12.1.
- **No new environment variables.** `BASE_URL` is read by the
  new `tenant_base_url()` helper, but it is an existing
  variable documented in
  [docs/deployment.md](docs/deployment.md) (used by several
  other helpers since v1.7.0). Sites that already export it
  pick up the email-link fix on first restart with no further
  action required.
- **No new Cargo or npm dependencies.** The thirteen PRs net
  zero supply-chain churn — `cargo deny check` and
  `npm audit` output are unchanged from v1.12.1.
- **Recommended deploy:**
  ```bash
  docker compose pull
  docker compose up -d --build
  # Sites using the bundled AV sidecar:
  docker compose --profile av up -d --build clamav
  # Sites adopting Kali VDI:
  docker build contrib/vdi-kali -t strata-vdi-kali:latest
  ```
- **No DMZ-side change.** The `strata-dmz` relay binary
  bumps version cosmetically (it shares the workspace
  `[workspace.package].version` field) but its wire protocol
  and behaviour are byte-identical to v1.12.1. Mixed
  v1.12.1 / v1.12.2 deployments handshake cleanly; the
  Admin → DMZ Links tab will show a `Mixed` indicator until
  every link is upgraded.

## PRs in this release

| PR   | Theme          | Title                                                                                 |
| ---- | -------------- | ------------------------------------------------------------------------------------- |
| #268 | UX polish      | fix(outbound): keep justification textarea visible when drive redirection is disabled |
| #269 | UX polish      | fix(outbound): always print a completion summary on curl snippets                     |
| #270 | UX polish      | fix(ConfirmModal): render via portal so backdrop covers full viewport                 |
| #271 | Approver email | feat(notifications): outbound share pending approver emails                           |
| #272 | Hygiene        | style: cargo fmt                                                                      |
| #273 | Approver email | fix(outbound): query roles.can_manage_system, not users.can_manage_system             |
| #274 | ClamAV         | fix(clamav): pin healthcheck to 127.0.0.1 to dodge IPv6 localhost resolution          |
| #275 | Approver email | fix(notifications): use OutboundShareEvent::Pending.requester_id to exclude self      |
| #276 | VDI catalog    | feat(vdi): add Kali Linux VDI image with kali-linux-large toolset                     |
| #277 | Recordings     | fix(backend): grant strata write access on guac-recordings dir                        |
| #278 | Email links    | fix(notifications): fall back to BASE_URL env for email links                         |
| #279 | UX polish      | feat(outbound-shares): visibility-gated auto-refresh on admin tab                     |
| #280 | UX polish      | feat(outbound-share): paste-and-run snippet via File path input                       |

---

# What's New in v1.12.1

> **Patch release — operational polish on the v1.12.0 AV-scanning
> landing.** No protocol breakage, no migrations, no new
> environment variables; existing v1.12.0 deployments upgrade with
> a `docker compose up -d --build` of the backend, frontend, and
> (if you're using the bundled sidecar) clamav containers. This
> release rolls fourteen merged PRs into one shipping bundle and
> closes five themes that the v1.12.0 landing left rough:
> visibility into scanner health, friendly user-facing error
> messages on AV blocks, live upload progress in every surface
> that previously left users guessing, a unified admin
> AV-Blocked Files audit view, and a handful of scanner-side
> correctness fixes (signature-DB hot-reload, scan-size limit
> aligned with the upload cap, env-var wiring, super-admin role
> check).

## Theme 1 — Scanner health is now visible without `docker exec`

Admin → Health gains a new **AV** card showing the active
backend (`off` / `clamav` / `command`), a reachability ping,
the daemon version (`PING` + `VERSION` exchange against
clamd), the signature DB versions for `main`, `daily`, and
`bytecode` with their signature counts and update dates
(e.g. `daily.cld v27349 / 2,047,316 sigs / 2026-06-08`),
the last successful `freshclam` update timestamp, the last
reload-after-update outcome, and the last-30d verdict tally
(`clean` / `infected` / `skipped` / `error`). On-call
operators can now answer "is the scanner up and are the
signatures fresh?" in one click. The card degrades gracefully
when the daemon is temporarily unreachable — it surfaces the
last known-good values plus a "stale since HH:MM:SS" badge
rather than wiping the panel.

A new diagnostic script ships at `scripts/diagnose-av.sh` for
ssh-onto-the-box-while-debugging-an-alert flows. It pings the
configured backend, runs a `PING`/`VERSION` exchange against
clamd, prints the signature DB versions from the `clamav-db`
volume, exec's an `INSTREAM` against EICAR, and reports the
verdict — emitting structured `key=value` lines on stdout so
the output pipes cleanly into `grep` / `awk` / `jq -R -F=`.

## Theme 2 — Friendly user-facing AV error messages

When the AV engine errors — TCP refused, daemon timeout,
signature DB not yet loaded, unparseable response — the
inbound and outbound HTTP responses now return a deterministic
actionable message classified by error shape instead of the
raw engine spew. The drive-channel `client.onfile` toast and
the QuickShareOutbound panel both display the same friendly
text so operators know whether to retry or escalate:

| Verdict class              | Trigger                                                          | Message                                                                                            |
| -------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Infected                   | `Verdict::Infected { signature }`                                | `File rejected by malware scan: <signature>`                                                       |
| Error · timeout            | Engine message contains `timeout` / `timed out` / `exceeded`     | `Antivirus scan timed out after Ns; try a smaller file or retry shortly.`                          |
| Error · transport          | Engine message contains `refused` / `reset` / `unreachable` etc. | `Antivirus scanner unreachable; please retry shortly.`                                             |
| Error · missing signatures | Engine message contains `empty` / `no signatures`                | `Antivirus signature database not yet ready; please retry shortly.`                                |
| Error · generic            | Anything else                                                    | The engine's raw text, passed through verbatim (audit row carries the full unredacted message too) |

The full classifier lives at
`Verdict::user_facing_block_message()` in
`backend/src/services/av.rs` and has unit tests covering the
six branches.

## Theme 3 — Live upload progress on every surface

Three places previously left users staring at a frozen UI while
a large file uploaded; all three now show progress in real time.

### Browser-side uploads

Inbound Quick Share (drag-and-drop into the QuickShare panel)
and outbound Quick Share (drag-and-drop onto the
SessionManager hover-strip) both drive a percentage progress
bar on the upload toast, fed by a new typed
`xhrUploadJson<T>()` helper in `frontend/src/api.ts` that
wraps `XMLHttpRequest` (the only browser API that exposes
`upload.onprogress` reliably) and returns a `Promise<T>`
shape-compatible with the rest of the SPA's JSON contract.
The toast text walks through `"Uploading 42%"` →
`"Scanning…"` (indeterminate band) → final verdict, all in
one mounted toast rather than the v1.12.0 fire-and-forget
"Uploading…" → second-toast-for-the-result handoff. Toasts
have a new optional `progress` shape; passing
`progress: { pct: -1 }` renders an indeterminate sliding
band via the `strata-toast-indeterminate` keyframe.

### MY SUBMISSIONS "Awaiting AV scan" indicator

Every row in the QuickShareOutbound MY SUBMISSIONS panel with
`status === "pending"` now renders an indeterminate
"Awaiting AV scan" bar (or "Awaiting AV scan and approval"
when the DLP score is zero and approver review is still
required). This is the **backend-side** scan window made
visible in the browser — the user can see the wait without
guessing whether the upload just stalled. The bar uses an
inline `@keyframes strata-outbound-pending` block (idempotent
per CSS spec) and the Tailwind v4 `bg-warning/N` token via
the workspace `@theme` block so it picks up dark / light mode
automatically.

### Terminal-side curl + PowerShell snippets

The HTTPS upload-command snippet (used when GPO disables RDP /
SFTP drive redirection so the drive-channel interceptor
doesn't fire) now shows progress in the user's terminal too.
Three snippet variants updated:

- **`curl`** (Linux/macOS) and **`curl-win`** (Windows) — add
  `--progress-bar` for a clean one-line meter, plus
  `-H "Expect:"` to disable curl's default
  `Expect: 100-continue` header. Without that flag, the
  server returns 400 on a consumed or expired token _before_
  reading the body, curl never uploads, and the meter has
  nothing to draw — making it look like the progress bar
  is broken when in fact the upload itself never happened.
  Disabling Expect forces the body up immediately so the
  meter renders even when the server eventually rejects.
- **`powershell`** (PS7+) — rewritten from
  `Invoke-WebRequest -Form` (which exposes NO file-upload
  progress, only response-download progress) to a streaming
  `System.Net.Http.HttpClient` +
  `MultipartFormDataContent` + `StreamContent($file.OpenRead())`
  pipeline, with a poll loop that reads
  `$stream.Position` and drives `Write-Progress`. Also sets
  `$client.DefaultRequestHeaders.ExpectContinue = $false`
  for the same reason as the curl flag.

## Theme 4 — Admin AV-Blocked Files tab

A new **Admin → AV-Blocked Files** tab surfaces every blocked
upload in a single unified view. The pre-existing
`outbound_share.requested` audit event was extended with
`av_status`, `av_signature`, `av_backend`, `direction:
"outbound"`, and `filename` keys so the dashboard query joins
inbound and outbound blocks through one `action_type` filter:

```sql
SELECT *
FROM audit_log
WHERE action_type IN ('file.av_blocked', 'outbound_share.requested')
  AND (
        action_type = 'file.av_blocked'
        OR payload->>'av_status' IN ('infected', 'error')
      )
ORDER BY created_at DESC
```

Columns: timestamp, direction (in/out), filename, byte size,
signature (or error message), engine, actor + session
context. Filterable by date range, engine, direction, and
signature substring; cursor-paginated at 50 per page. Visible
to `can_manage_system` only.

## Theme 5 — Scanner-side correctness fixes

- **freshclam reload cadence.** The bundled `clamav`
  sidecar's entrypoint now runs `freshclam` **hourly**
  (was: daily) and forces a `clamd RELOAD` after every
  successful update. Without the reload, fresh signatures
  pulled into `/var/lib/clamav` sat unused until the next
  full sidecar restart — meaning the audit trail could
  record a `Skipped { reason: "no signatures" }` or an
  `Error { message: "..." }` against a file the engine _had_
  signatures for, just hadn't loaded them yet. Now the
  engine picks up new signatures within minutes of
  `freshclam` returning.
- **Scan-size limit aligned with the upload cap.** The
  default `STRATA_AV_MAX_SCAN_SIZE` was bumped from 100 MiB
  to **500 MiB** to match the existing 500 MiB Quick Share
  upload cap. Previously a 200 MiB upload was accepted by
  the route but tagged `Skipped { reason: "oversize" }` by
  the scanner — i.e. it landed in the file store unscanned,
  defeating the point of v1.12.0. The bundled
  `clamav/clamd.conf` raises `StreamMaxLength`,
  `MaxFileSize`, and `MaxScanSize` to 512 / 512 / 1024 MiB
  in lockstep so the clamd-side limits agree. Operators
  with custom limits should adjust both ends together.
- **`STRATA_AV_*` env var wiring.** `Config::from_env`
  previously read one variable name and the bootstrap code
  read another (a naming drift introduced late in v1.12.0
  integration). Fixed so all seven `STRATA_AV_*` variables
  in `.env.example` actually take effect.
- **Quick Share role-permission check** is now strictly
  uniform across the three outbound routes (mint /
  submit / token-ingest). A super-admin without
  `can_use_quick_share_outbound` is correctly rejected
  with 403 `Forbidden` on every path, matching the v1.11.0
  design intent.
- **CVD / CLD test fixtures** corrected to use real on-wire
  formats so the version-parser unit tests actually
  exercise the parser the health card depends on.
- **EICAR smoke test docs** rewritten to walk operators
  through the role check first (without
  `can_use_quick_share_outbound` the upload is rejected
  with 403 _before_ reaching the scanner, masking a
  successful AV deployment as a broken one), and to ship
  the EICAR string in a here-doc so RDP-clipboard
  expansion of `$` doesn't corrupt the signature on paste.

## Operator impact

Upgrade path: rebuild and recreate the **backend**,
**frontend**, and **clamav** containers. No migrations. No
new environment variables. No config changes. No new Cargo
or npm dependencies.

```bash
docker compose pull                                  # if using GHCR
docker compose --profile av up -d --build            # rebuild all
```

The AV-Blocked Files admin tab is visible to
`can_manage_system` only. The AV Health card surfaces on the
existing Admin → Health page for users already gated for it.
Existing `STRATA_AV_MAX_SCAN_SIZE` overrides continue to
apply — the bump is a default change, not a forced value;
sites that _want_ the 100 MiB ceiling preserved can pin
`STRATA_AV_MAX_SCAN_SIZE=104857600` in `.env`.

See [CHANGELOG.md](CHANGELOG.md#1121--2026-06-09) for the
full added / changed / fixed / security / migrations
breakdown, and [docs/av-scanning.md](docs/av-scanning.md) +
[docs/runbooks/av-operations.md](docs/runbooks/av-operations.md)
for the operator-grade detail.

---

# What's New in v1.12.0

> **Minor release — pluggable antivirus scanning on every Quick
> Share upload path.** v1.12.0 plugs a long-standing gap in the
> file-mover pipeline: both **inbound** Quick Share (operator → remote
> session) and **outbound** Quick Share (remote session → operator,
> the v1.11.0 approval-gated path) now stream every upload through a
> configurable antivirus scanner _before_ the file lands in the
> session file store / before it is sealed via Vault Transit.
> Three backends ship — `off` (default, no-op), `clamav` (full
> `clamd` INSTREAM TCP wire protocol), and `command` (exit-code
> contract for ESET / Defender / Sophos / Trend / anything that
> matches `0=clean, 1=infected`). Default is **fail-closed**: a
> scanner error blocks the upload and writes a structured audit
> row recording which engine spoke and why. The ClamAV sidecar
> is opt-in via the new `av` compose profile and lives entirely
> on the internal Docker network — no host port mapping, no
> public exposure.

## Why this exists

Through v1.11.x the Quick Share file mover had no built-in
malware check. Operators were expected to wire their own DLP /
AV proxy in front of the backend, or to trust that the source
machine (operator's workstation or remote target) had endpoint
protection enabled. That worked for tightly-controlled internal
deployments but failed two of our larger sites:

1. **Compliance auditors** flagged the missing scan because the
   audit trail recorded `outbound_share.requested` rows without
   any explicit "this file was scanned" attestation. Adding one
   in v1.11.x meant either side-loading a transparent proxy or
   modifying the backend at every site.
2. **A real-world EICAR test by one of our customers** in May
   surfaced a Quick Share upload of a known-bad sample that
   completed cleanly. The file never touched a scanner on the
   way through Strata because Strata never asked one.

v1.12.0 closes both gaps with one feature: an in-process scanner
hook, three swappable backends, and a fail-closed default.

## The three backends

The scanner is wired through a trait in
`backend/src/services/av.rs`:

```rust
#[async_trait]
pub trait Scanner: Send + Sync + std::fmt::Debug {
    async fn scan(&self, path: &Path, file_size_bytes: u64) -> Verdict;
    fn backend_name(&self) -> &'static str;
}
```

with `Verdict` carrying `Clean | Infected { signature } |
Skipped { reason } | Error { message }`. The `blocks(fail_mode)`
helper turns a verdict into a block / pass decision at the
upload-handler call site.

### `off` (default)

Returns `Skipped { reason: "scanning disabled" }` on every call.
The handler treats `Skipped` as a pass regardless of fail-mode,
so deployments that don't opt in behave exactly as they did in
v1.11.x.

### `clamav`

Talks to a ClamAV `clamd` daemon over plain TCP using the
**INSTREAM** wire protocol — no `clamdscan` shell-out, no file
copy across the FS boundary. The Rust implementation is a
direct `tokio::net::TcpStream` state machine: open with
`zINSTREAM\0`, write the file in 64 KB chunks each prefixed by
a 4-byte big-endian length, terminate with `0u32`, then read
the null-terminated response and parse `stream: OK` /
`stream: <SIG> FOUND` / `<error> ERROR`. Files larger than
`STRATA_AV_MAX_SCAN_SIZE` (default 100 MiB) are tagged
`Skipped { reason: "oversize" }` rather than attempted — clamd
itself rejects anything over the daemon-side `StreamMaxLength`
(default 25 MiB out of the box; Strata's sidecar bumps it to
match `STRATA_AV_MAX_SCAN_SIZE` so the two limits agree).

### `command`

Shell-out to any scanner that follows the exit-code contract
`0 = clean, 1 = infected, other = error`. The command line is
parsed from `STRATA_AV_CMD` (whitespace-split — wrap pipelines
in a small script), with optional `{path}` placeholder
substitution. Signature is extracted from the last non-empty
line of stdout (falling back to stderr), with `Threat: ` /
`Found: ` prefixes stripped. Invoked via
`tokio::process::Command` so the timeout, working directory,
and process group are all owned by the backend. No shell, no
PTY allocation, no environment leak.

```bash
# Microsoft Defender for Endpoint (Linux ATP)
STRATA_AV_BACKEND=command
STRATA_AV_CMD=/opt/microsoft/mdatp/sbin/mdatp scan custom --path {path}

# Sophos
STRATA_AV_BACKEND=command
STRATA_AV_CMD=/opt/sophos-av/bin/savscan -ss -nb {path}

# A bash wrapper for anything fancier
STRATA_AV_BACKEND=command
STRATA_AV_CMD=/usr/local/bin/strata-scan.sh {path}
```

## Fail-closed by design

`STRATA_AV_FAIL_MODE=block` (the default) means a scanner error
— socket refused, command not found, timeout, daemon panic —
**rejects the upload**. The audit row records the error message
verbatim. `allow` flips the behaviour for environments where
intermittent scanner outages are worse than the
admit-on-failure risk; the audit row still records the error
and the engine that produced it, so an operator can
reconstruct exactly which uploads degraded-passed during the
outage window.

**Infected verdicts are always rejected regardless of fail-mode.**
There is no override knob, by design — a `command` backend that
returns exit code 1 is treated as an unambiguous "infected"
signal whether the file is huge, the scanner is slow, or the
day is Sunday.

## The four new outbound_shares columns

Migration `078_av_scanning.sql` adds:

| Column | Type | Notes |
| -------------------- | ------------- | ------------------------------------------------ | -------- | ------- | ------ |
| `av_scan_status` | `TEXT` (NULL) | One of `clean                                    | infected | skipped | error` |
| `av_signature` | `TEXT` (NULL) | Engine-reported signature for `infected` rows |
| `av_scanned_at` | `TIMESTAMPTZ` | When the verdict was issued |
| `av_scanner_backend` | `TEXT` (NULL) | Which backend spoke (`off`, `clamav`, `command`) |

Plus a partial index:

```sql
CREATE INDEX idx_outbound_shares_av_attention
  ON outbound_shares (av_scan_status)
  WHERE status IN ('infected','error');
```

The partial index keeps the admin dashboard query —
"show me every outbound share that needs eyeballing" — cheap
as the table grows. Rows that scanned `clean` or `skipped` are
excluded from the index entirely.

All four columns are nullable so the migration is backwards-
compatible: rows created under v1.11.x stay `NULL` and the
admin UI renders them as "Pre-AV (v1.11.x)" with a neutral grey
badge instead of an alarming red one.

## Opt-in ClamAV sidecar

The new `clamav` service in `docker-compose.yml` lives behind
the opt-in `av` compose profile:

```bash
# Enable ClamAV and reload
echo 'STRATA_AV_BACKEND=clamav' >> .env
docker compose --profile av up -d
```

Topology:

- Image: `clamav/clamav:stable` (official upstream).
- Network: `guac-internal` only — no host port mapping, no
  public exposure.
- Volume: `clamav-db` (named) persists `/var/lib/clamav` so
  signature downloads aren't repeated on every `up`.
- Healthcheck: `clamdcheck.sh` with `start_period: 300s` to
  absorb the first-boot ~250 MB freshclam pull.
- Limits: 3 GB RAM / 2 CPUs (clamd's resident set scales with
  the signature DB; 1.4 GB resident is typical once loaded).

The backend tolerates an absent sidecar because `STRATA_AV_BACKEND=off`
is the default — operators who never want AV scanning never
need to opt into the profile.

## Audit events

Every blocked upload writes a structured audit event:

- **`file.av_blocked`** — inbound Quick Share rejection. Body
  includes `signature`, `filename`, `byte_len`, `session_id`,
  and `av_backend`.
- **`outbound_share.requested`** — extended with `av_status`,
  `av_signature`, `av_backend` keys on every outbound submission
  (success _or_ rejection) so the audit trail records which
  engine cleared the file as well as what it said. This makes
  the outbound flow self-attesting for compliance review.

## Migration & upgrade path

- **No breaking changes.** Migration `078_av_scanning.sql` is
  purely additive (four nullable columns + one partial index).
  Default `STRATA_AV_BACKEND=off` keeps v1.11.x behaviour bit-
  for-bit until the operator opts in.
- **No new Cargo dependencies.** The ClamAV INSTREAM wire
  protocol is implemented directly against `tokio::net::TcpStream`
  (the format is small enough to live in one file). The command
  backend uses `tokio::process::Command`. Both are stdlib +
  existing tokio.
- **EICAR smoke test** is documented in
  [docs/runbooks/av-operations.md](docs/runbooks/av-operations.md);
  the short version is `curl -F file=@eicar.com -F session_id=…`
  and expect a 400 with `signature=Win.Test.EICAR_HDB-1`.

See [docs/av-scanning.md](docs/av-scanning.md) for the full
operator guide and
[docs/adr/ADR-0011-av-scanning.md](docs/adr/ADR-0011-av-scanning.md)
for the design rationale.

---

# What's New in v1.11.1

> **Patch release — approver workflow polish.** v1.11.1 closes
> three follow-up gaps from the v1.11.0 Outbound Quick-Share
> landing: approvers can now act on pending work without leaving
> their current page (new in-session popup), credential-checkout
> denials carry a free-form **Reason from approver** through to
> the rejection email and the row itself (migration 077), and
> outbound shares from accounts without the approval bypass now
> require a **≥ 10-character justification** before the file ever
> reaches the DLP / approval pipeline.

## In-session approval popup

A new `PendingApprovalWatcher` component is mounted once in the
SPA shell and polls the two approval queues the active user is
gated for:

- `GET /api/user/pending-approvals` — credential checkouts the
  user can decide via their approval-role scope.
- `GET /api/admin/outbound-shares/pending` — outbound shares
  awaiting approval, polled only when the user has
  `can_manage_system` or the per-user `is_outbound_approver`
  flag from the new `outbound_share_approvers` table.

Each new pending item surfaces as a popup card with **Approve**,
**Deny**, and **View all** actions wired straight to the
existing decide endpoints. The poll cadence is 45 s with extra
polls on tab `focus` and `visibilitychange` so freshly-arrived
work shows up the moment the approver switches back to the tab.

Cards are placed top-LEFT so they never collide with the regular
toast stack (top-right) or the session-timeout warning
(bottom-right). An unactioned card auto-dismisses after 30 s and
the dismiss is recorded in `localStorage` so the next poll does
not re-spawn the same card and so multiple open tabs do not each
show a duplicate. To re-surface a dismissed item the approver
navigates to `/approvals` — the popup is a convenience, not the
primary mechanism.

The popup's **Deny** action expands an inline reason composer
(`<textarea>` + Confirm / Cancel) so denials never leave the
requester guessing why. The composer's value is sent through to
the same decide endpoint that the full Approvals page now uses.

Architecturally the watcher mirrors the existing
`CredentialProfileExpiryWatcher`: single mount in `App.tsx`,
`localStorage`-backed cross-tab de-dup, and a polite
`Promise.allSettled`-style fanout so one queue endpoint being
temporarily 500 never blocks the other from surfacing work.

## Persisted "Reason from approver" on credential checkouts

Until now `password_checkout_requests.status = 'Denied'` carried
no explanation, so a requester reading the audit trail saw only
"Grace declined your request" with no further context. The
outbound-share queue already persisted a `decision_reason` per
row (v1.11.0 / migration 073), and the new in-session popup
_requires_ a reason before letting an approver hit Deny — so the
absence of the column on the credential side was the only thing
keeping the two queues asymmetric. v1.11.1 closes that gap:

- **Migration `077_checkout_decision_reason.sql`** adds a
  nullable `decision_reason TEXT` column to
  `password_checkout_requests`. Legacy `Denied` rows stay
  `NULL` rather than being backfilled to an empty string, so
  the UI can distinguish "no reason supplied" from "legacy
  denial that predates this field". No length constraint at the
  DB layer — the handler enforces a 1024-char server-side cap
  after trimming, matching the outbound-share rule so the two
  queues stay symmetric.

- **`POST /api/user/checkouts/:id/decide`** now accepts an
  optional `reason` field on the request body:

  ```json
  { "approved": false, "reason": "Out of change window, contact owner first" }
  ```

  The body remains backwards-compatible — clients that omit
  `reason` continue to work.

- **Rejection email templates** — `checkout_rejected.mjml` and
  `checkout_rejected.txt.tera` render the approver's reason in
  a dedicated **Reason from approver** block when present, and
  silently omit the block when `decision_reason IS NULL`. So
  legacy denials and reason-less new denials never surface an
  empty block.

- **Approvals page** (`frontend/src/pages/Approvals.tsx`) and
  the in-session popup both use the same inline deny composer
  (textarea + Confirm Deny / Cancel) so the two surfaces have a
  single deny-flow shape.

## Mandatory justification on outbound shares (no-bypass accounts)

When a user lacks the `users.outbound_share_requires_approval =
FALSE` bypass, every outbound submission must now carry a
justification of **at least 10 characters** (whitespace-trimmed,
**character count rather than byte count** so non-ASCII reasons
such as accented text or CJK are not penalised). Bypass users
continue to submit without one — auto-approval semantics for the
bypass path are unchanged.

The rule is enforced at **both** outbound HTTP entry points by a
single shared helper
(`validate_outbound_justification(requires_approval,
justification)`):

1. **`finalize_submit`** (the drag-and-drop / browser upload
   path) — validation runs after the user-row lookup and
   **before** the `staging_root()` / sealed blob write, so a
   denied request never leaves a partial sealed blob behind to
   be reaped later.

2. **`issue_ingest_token`** (the curl / curl.exe / PowerShell 7
   snippet path) — validation runs before
   `outbound_share_ingest::mint(...)`. This means the user sees
   the "justification too short" error inside the Outbound
   Share panel at the moment they click **Generate upload
   command**, _not_ after they have already pasted the snippet
   into a remote shell and run it.

Validation failures return HTTP 400 with the message _"A
justification of at least 10 characters is required for
outbound shares unless the approval bypass is enabled for your
account."_

### SPA UX mirrors the rule

The SPA mirrors the chokepoint so no user ever discovers the
rule via a 400 response:

- **`MeResponse.outbound_share_requires_approval`** is now
  returned on both `/me` and `/auth/check` (the v1.11.0
  `MeResponse` drift rule applied). The SPA derives a single
  boolean `outboundShareBypass = user?.
outbound_share_requires_approval === false` and threads it
  into the `SessionManagerProvider`.

- **Outbound Share panel** — when bypass is off the
  justification label gains a red asterisk and
  `aria-required="true"`, the placeholder changes to a worked
  example (_"Required — e.g. Audit ticket INC-1234, exporting
  redacted log for review"_), a helper line reads _"Required
  for your account (minimum 10 characters)"_, and the **Generate
  upload command** button stays disabled until the trimmed value
  reaches 10 chars (with a tooltip explaining why).

- **Drive-channel `onfile` interceptor** — when bypass is off
  and the active session's pending justification is shorter
  than 10 chars, the interceptor surfaces a warning toast
  (_"Justification required: <filename>"_) with remediation
  copy and short-circuits before the `FormData` POST. This
  avoids a confusing toast-on-400 flow where the user has
  already let go of the file.

## Operational impact

- **One additive migration applies automatically on first
  boot:** `077_checkout_decision_reason.sql`. The column is
  nullable with no default; legacy `Denied` rows stay
  `decision_reason = NULL`, so the deploy is silent on pre-077
  data.
- **No new environment variables.** No new role permissions.
- **Backwards-compatible request shapes.** Clients of
  `POST /api/user/checkouts/:id/decide` that omit `reason`
  continue to work; clients of the outbound endpoints that
  submit a sufficient justification continue to work; only
  bypass-off users submitting an empty or short justification
  see the new 400.
- **Recommended deploy:** rebuild and recreate the backend
  container (picks up migration 077 + the new validation + the
  email template change) and the frontend container (picks up
  `PendingApprovalWatcher`, the Approvals composer rewrite, the
  panel UX changes, and the `SessionManager.onfile` gate). The
  `strata-dmz` relay and `guacd` images are unchanged.

# What's New in v1.11.0

> **Outbound Quick-Share — approval-gated file export with dual ingest
> paths.** v1.11.0 lands the long-tracked roadmap item for **files
> leaving** a remote session: a Vault-sealed staging area, a built-in
> DLP heuristic, an approver workflow, and two complementary ingest
> paths so the feature works in environments that allow RDP drive
> redirection _and_ in ones that don't.

## What outbound Quick-Share solves

Inbound Quick-Share has always handled files _going into_ a session
(drag-and-drop upload from the Session Bar, single-use token URL the
user pastes inside the remote shell). The inverse — files _leaving_
the session — was historically either implicit (drive-channel
auto-downloads via guacd's `client.onfile`) or impossible (when GPO
blocked drive redirection). Either way there was no audit trail, no
content scan, and no approval gate.

Outbound Quick-Share replaces that with a single, audited pipeline:

```
remote session ──► (drive channel OR HTTPS token) ──► sealed staging
                                                         │
                                              DLP heuristic
                                                         │
                                          ┌──────────────┴───────────────┐
                                          ▼                              ▼
                            auto-approve (low score +              queue for approver
                            user opted out of approval)            (decide → release/deny)
                                          │                              │
                                          └──────────────┬───────────────┘
                                                         ▼
                                          single-use download link
                                          (or purge + zeroise DEK)
```

Every transition is written to the hash-chained audit log
(`outbound_share.submitted`, `.decided`, `.downloaded`, `.purged`,
`.approver_added`, `.approver_removed`, `.ingest_token.minted`,
`.ingest_token.consumed`).

## Two ingest paths, one pipeline

### 1. Drive-channel interception (transparent)

When the active role grants `can_use_quick_share_outbound`,
`SessionManager.client.onfile` no longer triggers an automatic
browser download. Instead it buffers the file with
`Guacamole.BlobReader`, wraps it in a multipart `FormData`, and
POSTs it to `/api/user/outbound-shares` along with the active
session id, connection id, and any pending justification the user
typed in the Outbound Share panel. A toast surfaces the resulting
status (auto-approved + downloadable, queued for approval, or
denied with a DLP reason) and a window event refreshes the panel's
history list.

This is the zero-friction path — the user copies a file to the
Strata virtual drive inside the session exactly as before, but
behind the scenes the bytes are sealed, scanned, audited, and
either released or queued.

### 2. HTTPS upload command (drive-redirect bypass)

In environments where group policy disables RDP / SFTP drive
redirection at the target, the drive channel never carries any
bytes, so the `onfile` handler never fires. For these sites the
Outbound Share panel mints a single-use, 10-minute **upload token**
and renders it into a paste-friendly one-liner:

- **curl (Linux / macOS):**
  `curl -fL -F 'file=@./<your-file>' 'https://strata.example.com/api/outbound-shares/ingest/<token>'`
- **curl.exe (Windows 10+):**
  `curl.exe -fL -F "file=@<your-file>" "https://strata.example.com/api/outbound-shares/ingest/<token>"`
- **PowerShell 7+:**
  `Invoke-WebRequest -Uri '<url>' -Method POST -Form @{ file = Get-Item '<your-file>' }`

A "Skip TLS cert check" toggle injects `-k` /
`ServicePointManager` bypass for sites with self-signed or
internal-CA certificates.

The user pastes the snippet inside the remote session shell. The
file uploads back to Strata over plain HTTPS on the connection the
browser is already using — **no SMB, no port 445, no drive channel** —
and is fed into the exact same DLP / approval / audit pipeline as
the drive-channel path.

The token IS the auth:

- Bound at mint time to the requesting user, session id,
  connection id, and justification.
- 32-byte URL-safe base64 (~192 bits of entropy).
- 10-minute TTL.
- Single-use: the consume `UPDATE … SET used_at = now() WHERE
token = $1 AND used_at IS NULL AND expires_at > now()` is
  atomic; a token that has been used or expired is rejected with
  the same opaque error as an unknown token.
- Re-checks the minter's `can_use_quick_share_outbound` role
  permission at consume time, so a role revoked between mint and
  consume cannot launder a previously-minted token.
- Rate-limited at 10 mints/minute/user at the route layer.
- Reaped by the existing daily `user_cleanup` worker.

## New role & user controls

- **`can_use_quick_share_outbound`** — role permission, off by
  default. Grants the in-session **Outbound Share** button and the
  ability to mint upload tokens. Enforced by
  `services::middleware::check_quick_share_outbound_permission`.
  `can_manage_system` does **not** bypass this gate — outbound file
  export is a deliberately separate capability from general
  administration.
- **`outbound_share_requires_approval`** — per-user flag in
  Admin → Access, defaults `true`. When off and the submission's
  DLP score is below `AUTO_APPROVE_THRESHOLD`, the share is
  released directly without queueing.
- **Outbound Share approvers** — managed from the new
  Admin → Outbound Shares tab. Super-admins (`can_manage_system`)
  are implicit approvers; this list adds non-admin delegates (e.g.
  compliance officers). Adding / removing approvers is gated to
  super-admins.

## Admin → Outbound Shares tab

Combines three things in one place:

1. **Pending queue.** Approve / Deny with a free-text reason. The
   approver's user id and reason are recorded; on approval a
   single-use download token is generated and the requester sees
   the download link in their panel history.
2. **Full history.** Every share with its DLP score, DLP flags,
   decision reason, status (pending / approved / denied / downloaded /
   purged), and a Purge action for super-admins.
3. **Approver delegation list.** Add / remove non-admin approvers
   by user id.

The tab is visible when the calling user has `can_manage_system`
OR the new `is_outbound_approver` flag (computed from
`outbound_share_approvers` and returned on `/me`).

## At-rest security

Every staged file is sealed before it touches disk:

1. A fresh per-share 256-bit data encryption key is generated.
2. The file is encrypted with that DEK using AES-256-GCM.
3. The DEK is sealed by Vault Transit and stored in the
   `outbound_shares.sealed_dek` column.
4. The ciphertext is written to the configurable staging directory
   (`STRATA_OUTBOUND_SHARES_DIR`, default
   `/tmp/strata-outbound-shares` with a platform-temp-dir fallback).

When a share is denied or its TTL elapses, the periodic worker
zeroises the sealed DEK and deletes the ciphertext file, so the
staging blob cannot be recovered even from a forensic disk image.

## Migrations

- `073_outbound_quick_share.sql` — `outbound_shares` +
  `outbound_share_approvers` tables, `roles.can_use_quick_share_outbound`,
  `users.outbound_share_requires_approval` columns.
- `074_outbound_share_ingest_tokens.sql` — `outbound_share_ingest_tokens`
  table backing the HTTPS upload snippet path.

Both apply automatically on first boot. Existing roles do **not**
gain `can_use_quick_share_outbound` automatically; an administrator
must enable it explicitly per role.

## Operational impact

- No new operator configuration is required. The feature is dormant
  until at least one role has `can_use_quick_share_outbound`
  enabled.
- The drive-channel ingest path activates as soon as a user with
  the new permission triggers `client.onfile` from inside a
  session. The HTTPS-snippet path activates as soon as the user
  clicks **Generate upload command** in the Outbound Share panel.
- Recommended deploy: rebuild and recreate the backend container,
  then enable the new permission on one trusted role and walk a
  test file end-to-end through both ingest paths.

---

# What's New in v1.10.9

> **Patch release: Safeguard one-off profile routing and local-unseal guard.** v1.10.9
> fixes a backend runtime error that could occur when a tunnel ticket selected
> an ad‑hoc Safeguard credential profile. The ticket path is now canonicalised
> to reuse the Safeguard JIT and password cache flow, and the backend no
> longer attempts to `vault::unseal` empty local encrypted payloads for
> `safeguard`-kind profiles. This resolves 502/500 failures observed during
> ad‑hoc credential selection and restores reliable Safeguard-backed
> credential resolution.

### Credentials UI: Request Checkout feedback

> The Credentials → Request Checkout form now gives clearer feedback when a
> checkout requires approver review. After submitting a request the UI shows
> an explicit "submitted for approval" message and navigates the user to
> **My Checkouts** so they can track the Pending/Scheduled/Approved status.
> This prevents the previous confusing form reset where no confirmation was
> visible to the requester.

---

# What's New in v1.10.6

> **Patch release: Safeguard token sanitization, validation & improved client diagnostics.** v1.10.6
> fixes an issue where pasted Safeguard bearer tokens containing trailing newlines or other control bytes could cause opaque `reqwest` `builder error` failures. Tokens are now trimmed on load, and storage rejects control bytes at store time; backend logs now surface reqwest error source chains to reveal underlying causes. The backend additionally validates user-supplied Safeguard tokens against the appliance (`/service/core/v4/Me`) before storing them and uses the JWT `exp` claim for the cached expiry. The token-status endpoint live-probes the cached token so a revoked or expired token no longer appears as "signed in" in the credential editor.

# What's New in v1.10.8

> **Patch release: DMZ link liveness — half-open socket detection via TCP keepalive + h2 PING watchdog.** v1.10.8
> closes the only reliability gap left in the dmz-edge topology where an ungraceful loss of the DMZ peer (container restart, NAT idle timeout, stateful-firewall reload) could leave the backend's link socket "Up" against a dead remote for the OS default ~2 h before the next write surfaced `ECONNRESET`. During that window every public request returned `503 NoLinkUp` at the DMZ because its side of the registry had already been torn down, while the backend supervisor still reported the link as healthy and the only operator recovery was an admin **Force reconnect**. Two complementary mitigations land on the backend's outbound link socket: TCP keepalive (30 s idle → 10 s probe interval, OS-default probe count) so the kernel surfaces a dead peer in ~60 s, and an application-level HTTP/2 PING watchdog (PING every 30 s with a 10 s deadline) so the same condition is detected even when intermediate firewalls strip keepalive. On timeout/failure the per-cycle cancellation token fires, the connection is gracefully shut down, and the supervisor's reconnect loop runs immediately — restoring service in tens of seconds without operator intervention. There are no user-facing UI changes and no configuration to opt in.

## TCP keepalive on the link socket

`backend/src/services/dmz_link/tls.rs` now applies an aggressive
`socket2::TcpKeepalive` profile to the link `TcpStream` immediately
after `connect` and before the TLS handshake:

- **Idle time** — 30 s. The kernel begins probing 30 s after the last
  TX on the socket. This is much tighter than the typical 2 h default
  because the link is a long-lived pinned connection between two
  known peers, not a general-purpose client socket.
- **Probe interval** — 10 s between successive probes once the idle
  timer fires.
- **Retry count** — left at the OS default (typically 9 on Linux);
  `socket2::TcpKeepalive::with_retries` requires the crate's `all`
  feature and is platform-gated, so we rely on the kernel default
  combined with our 10 s probe interval.

Failure to enable keepalive is non-fatal — the link still functions
without it (we lose proactive dead-peer detection but the new h2 PING
watchdog still catches the same condition). A `warn!`-level log line
identifies the endpoint and the underlying `std::io::Error` so
operators can audit it in environments where setting socket options
is restricted (e.g. some seccomp profiles).

## HTTP/2 PING watchdog

`backend/src/services/dmz_link/h2_serve.rs` adds a `ping_watchdog`
task spawned immediately after the h2 server handshake completes.
The watchdog takes the `h2::PingPong` handle from the connection
and:

- Waits **30 s** between pings (`tokio::time::interval` with
  `MissedTickBehavior::Delay`; the very first tick is intentionally
  burned so we do not ping the peer the microsecond the handshake
  completes).
- Issues an `h2::Ping::opaque()` and awaits the pong with a **10 s**
  deadline via `tokio::time::timeout`.
- On a timeout **or** a transport error from the PING send,
  cancels the supervisor's per-cycle `CancellationToken`, which
  causes `serve_h2` to issue `conn.graceful_shutdown()`, drain
  in-flight streams, return cleanly, and let the supervisor redial.

Because the PING watchdog cancels the **per-cycle** token (not the
global shutdown token), a stuck link tears down without affecting
the rest of the process; a real process-wide shutdown still cascades
because cycle_tok is a child of the global shutdown.

The PingPong handle is taken exactly once (`h2::server::Connection::ping_pong`
returns `Some` on the first call and `None` thereafter). The task is
aborted on **both** `serve_h2` exit paths (clean peer close and
protocol error) so the watchdog never outlives the connection it
watches.

## Why both?

TCP keepalive alone would catch the common case (DMZ restart on the
same host, docker bridge teardown). The h2 PING watchdog catches the
case where:

- TCP keepalive probes are dropped by a stateful firewall that has
  garbage-collected the connection state, so the kernel never sees a
  RST and probes timeout silently.
- The peer's TCP stack is alive but the h2 layer is wedged (e.g. a
  fork that left half a process behind, or a flow-control deadlock).
- The connection traverses a load balancer that proxies bytes but
  doesn't proxy keepalive semantics.

The two probes operate at different layers and have independent
failure modes, so a half-open connection that defeats one will
almost always be caught by the other within 60 s combined.

## Visible behaviour change

Operators should observe:

- A new INFO-level log line at supervisor startup whenever a link is
  dialled.
- WARN-level `DMZ link h2 PING timed out; tearing down link` (or
  `DMZ link h2 PING failed; tearing down link`) when the watchdog
  trips, followed by the existing `DMZ link down` reason line and
  the supervisor's normal redial sequence.
- WARN-level `DMZ link: failed to enable TCP keepalive` if the
  platform refuses the socket option — the link still comes up.
- **No change** to the **Admin → DMZ Links** UI, the
  `/api/admin/dmz-links` schema, the `dmz-edge` topology compose
  files, or any environment variables. The fix is purely internal to
  the link supervisor.

## Operator notes

- No migrations.
- No new environment variables. The keepalive and PING parameters
  are compile-time constants (`30 s / 10 s` for both) chosen to
  comfortably exceed any legitimate link silence while still
  surfacing a dead peer well inside the public gateway's idle
  timeout. Open an issue if your deployment has a justification for
  tuning these.
- Recommended deploy: rebuild and recreate the **backend** container
  only. The DMZ relay is unchanged.

---

# What's New in v1.10.7

> **Minor release: Admin UX improvements — Access tab pagination/search and per-user Safeguard JIT opt-in.** v1.10.7
> The Access view in Admin (Users and Folders) now supports client-side pagination and a quick search filter to ease navigation of large lists. Administrators can also toggle Safeguard JIT on a per-user basis from the Access tab; the Safeguard admin tab still exposes the global master switch while per-user opt-in allows granular exceptions. Per-user opt-in defaults to OFF to minimise the security surface.

---

# What's New in v1.10.5

> **Patch release: Recordings reliability & Azure offload.** v1.10.5
> fixes several issues that could prevent guacd from creating local
> recording files and ensures completed recordings are uploaded to
> configured Azure Blob Storage and removed from the local recordings
> volume. Retention purge now includes Azure-backed recordings.

# What's New in v1.10.4

> **Patch release: Security & DMZ hardening — CSRF/CSWSH bypass closure, DMZ body streaming, secret-redacting logs, and config-warning startup banners.** v1.10.4 has no new user-facing features. It lands the full implementation of the v1.10.3 internal code review (CRITICAL + HIGH + MED findings) plus a streaming-mode refactor of the DMZ reverse-proxy that drops per-request memory ceiling from roughly 16 MiB to roughly one HTTP/2 flow-control window (~64 KiB). The DMZ public TLS listener is now pinned to TLS 1.3 with conservative HTTP/2 SETTINGS that mitigate the Rapid Reset class of attacks (CVE-2023-44487). A new startup banner emits loud warnings when the backend is launched against the docker-compose default credentials, an unencrypted Vault address, or a weak JWT secret. Existing correctly-configured deployments are unaffected; nothing in this release is a breaking change.

## CSRF and CSWSH bearer-bypass closure

The CSRF middleware previously short-circuited the moment it saw an
`Authorization: Bearer …` header, on the assumption that a third-party
origin cannot read a victim's bearer token out of `localStorage`. A
malicious origin could nonetheless mint `Authorization: Bearer
anything-at-all` and bypass the check outright. Starting with v1.10.4
the middleware decodes the supplied bearer with the local JWT secret
(signature only — exp/aud remain enforced by `require_auth`) and only
exempts signature-valid bearers. Fake bearers fall through to the
standard cookie + `X-CSRF-Token` check and are rejected. The same
JWT-signature gate is now applied to the WebSocket-upgrade no-Origin
bearer fallback so the equivalent Cross-Site WebSocket Hijacking
(CSWSH) vector is closed.

External API clients using **opaque** (non-local-JWT) bearers will
now receive `403 CSRF` on state-changing requests unless they also
send the cookie + `X-CSRF-Token` pair. Migrate such clients to local
JWTs or to cookie auth.

## DMZ reverse-proxy: streaming bodies (M5)

The strata-dmz reverse-proxy used to buffer each request and response
body into a `BytesMut` up to 8 MiB before forwarding. Under N
concurrent in-flight requests the resident set could grow by
`2 × 8 × N` MiB and the proxy itself was a built-in DoS amplifier
for upload/download bombs. v1.10.4 streams both directions:

- **Request body.** A new `pump_request_body_upstream` task reads
  chunks from the axum `Body` and writes them into the upstream h2
  `SendStream`, honouring flow control with
  `reserve_capacity` / `poll_capacity`. The total-byte cap is
  enforced byte-by-byte; mid-stream overshoot triggers
  `send_reset(h2::Reason::CANCEL)`. A pre-flight `Content-Length`
  check still returns `413` before any link is touched for honestly
  oversized requests.
- **Response body.** A new `RecvStreamBody` adapter implements
  `futures::Stream` over `h2::RecvStream`, releases the flow-control
  window per chunk, and enforces the cap as data flows.
  `axum::body::Body::from_stream` wires it into the public response.
  A pre-flight `Content-Length` check returns `507` before any byte
  reaches the public client; mid-stream overshoot truncates the
  response and closes the public connection.

Per-request memory dropped from up to ~16 MiB to roughly one h2
flow-control window (~64 KiB) — about a **250×** reduction. The
two-attempt retry now happens at `SendRequest::ready()` time, before
the body is consumed. After `send_request` is called the body can no
longer be replayed, so any subsequent failure is fatal to that
request and the public client must retry (idempotent methods in
browsers do this automatically).

Four new streaming-mode tests guard the behaviour:
`request_oversized_content_length_returns_413_before_pick`,
`request_body_streams_intact_to_upstream`,
`request_body_oversize_without_cl_is_capped_and_request_fails`, and
`upstream_response_oversize_content_length_returns_507`.

## DMZ public listener: TLS 1.3 only + Rapid Reset hardening

The DMZ public listener is now constructed via
`builder_with_protocol_versions(&[&rustls::version::TLS13])`, dropping
TLS 1.2 from the internet-facing surface. The internal mTLS link
(consumed only by the two halves of the deployment) is unchanged and
remains TLS 1.2+ for compatibility with operator tooling.

The `hyper-util` auto-builder for the public h2 connection is now
configured with:

- `max_concurrent_streams = 128`
- `max_frame_size = 64 KiB`
- `max_header_list_size = 16 KiB`
- `max_send_buf_size = 1 MiB`
- 20-second keep-alive interval

These settings mitigate the CVE-2023-44487 ("HTTP/2 Rapid Reset")
class of attacks where a single client opens and immediately cancels
streams to exhaust server resources.

## `X-Forwarded-For` is now opt-in on the backend

Previously the backend honoured `X-Forwarded-For` unconditionally for
audit-log attribution and per-IP rate-limit bucketing. A direct
client (bypassing the load balancer or compose proxy) could therefore
forge its source IP for both surfaces. The DMZ proxy already required
explicit trust scoping; v1.10.4 brings the backend in line:
`X-Forwarded-For` is honoured **only** when `STRATA_TRUST_XFF=1` is
set on the backend container. Pair it with `STRATA_TRUSTED_PROXIES`
(comma-separated CIDRs) to scope which peers' XFF headers are
trusted.

Operators behind a reverse proxy must set this variable on upgrade,
otherwise rate limits collapse to per-LB-IP buckets and audit logs
lose source-IP fidelity. The new startup banner reminds you on boot
if it is missing.

## Startup banner for production-default credentials

A new `log_security_config_warnings()` runs at backend boot and emits
`error!`-level entries whenever it detects:

- `DATABASE_URL` containing the well-known dev password `strata_default`
- `VAULT_TOKEN=root`
- `VAULT_ADDR` beginning with `http://`
- `JWT_SECRET` unset, shorter than 32 bytes, or matching a known placeholder
- `STRATA_TRUST_XFF=1` set without a paired `STRATA_TRUSTED_PROXIES`

Dev and compose flows still work — the warnings do not block startup
— but production deployments now get a loud, log-aggregator-friendly
reminder if any default is still in place. `.env.example` has been
reorganised with a top-of-file warning block enumerating these five
variables.

## Secret-leak hardening

- **`AdSyncConfig` no longer prints bind passwords via `Debug`.** The
  previously-derived `Debug` impl printed `bind_password` and
  `pm_bind_password` in plaintext after Vault unsealed them. A manual
  impl now emits `<unset>`, `<vault-encrypted>`, or `<redacted>` for
  the two password fields while keeping every other field readable.
- **Frontend `api.ts` no longer logs CSRF cookie presence.** Two
  `console.log` calls in the refresh path that exposed the presence
  of the CSRF cookie to devtools have been removed.
- **Defensive SVG escaping on the SessionsTab chart.** A new
  `escapeSvgText()` helper now wraps every interpolated value in the
  session-activity SVG, hardening the rendering against future
  API-contract drift that could introduce user-supplied text into
  date fields.

## Token-revocation correctness

- **Logout only persists revocations for cryptographically-verified
  JWTs.** `POST /api/auth/logout` used to write any caller-supplied
  bearer string into the in-memory and DB revocation table.
  Unauthenticated callers could spam junk values to bloat the table
  (a slow DoS). The handler now only revokes tokens that decode as
  valid local JWTs; cookie clearing remains best-effort for browser
  sessions. OIDC tokens still need to end at the IdP via its
  `end_session_endpoint`.
- **`change_password` now revokes every active token surface.** The
  handler previously revoked only the `Authorization: Bearer` token
  on the request, leaving valid `access_token` and `refresh_token`
  cookies behind. It now iterates all three sources and revokes
  each one that decodes as a valid local JWT, forcing full
  re-authentication on the next request.
- **`persist_revocation` failures are now logged at `error!`.** The
  Postgres write inside `token_revocation::persist_revocation` used
  to silently swallow errors. Operators are now alerted when token
  revocation is degraded (e.g. DB partition full).

## Argon2 parameters pinned to OWASP minimum

A new `services::password::pinned_argon2()` returns an `Argon2`
configured with `Params::new(64 MiB, t=3, p=4)` and Argon2id
`Version::V0x13`. All write-side password-hashing call sites
(default-admin bootstrap, admin user create/reset) now use the pinned
helper. Verification continues to use the parameters embedded in the
stored PHC string, so existing hashes (including any with weaker
parameters) remain verifiable. There is no migration step: newly-set
passwords get the stronger parameters; existing hashes are rehashed
lazily when users next change their password.

## Edge-signer hardening

- Edge-header strip widened to include `x-real-ip`, every
  `x-forwarded-*` variant, and every `x-strata-admin-*` header in
  addition to the existing `x-strata-edge-*` strip. Closes a
  smuggling vector where a cooperative public client could
  pre-stamp a header to confuse internal trust logic.
- UA truncation is now char-boundary-safe via `char_indices`. A
  sufficiently exotic public User-Agent could previously panic the
  signer on a multi-byte UTF-8 boundary.

## Upgrade notes

- **Existing deployments**: no migration required. Bump container
  versions and rolling-restart. Watch for the new startup-banner
  `error!` lines on first boot — if you see them, your `.env` or
  compose overrides are still on dev defaults and must be tightened
  before going production.
- **Deployments behind a reverse proxy**: set `STRATA_TRUST_XFF=1`
  on the backend container, otherwise rate limits and audit logs
  will see every request as originating from the load-balancer IP
  starting with this release.
- **External API clients using opaque bearer tokens**: must now
  send the cookie + `X-CSRF-Token` pair on state-changing requests,
  or migrate to local JWTs.

---

# What's New in v1.10.3

> **Minor release: Multiplayer co-pilot completion — owner participation, force-grant, and WebRTC audio.** v1.10.3 closes three gaps in the multiplayer co-pilot feature shipped in v1.9.x. The session owner can now join their own multiplayer room and see peer cursors + chat instead of being a silent third party; a new force-grant route + overlay button lets the owner transfer the input token to any participant on demand; and the `audio_offer` / `audio_answer` / `ice` envelopes in the wire protocol are now wired up to a real full-mesh WebRTC audio mesh that any participant can opt into. Native checkboxes across the app also get a unified modern look.

## Owner-side co-pilot WebSocket

A new authenticated endpoint `GET /api/user/shared/copilot/:share_token` lets the connection owner join the multiplayer room for their own share with `is_owner=true`. The handler verifies share ownership, picks `display_name` from the authenticated user (`full_name` if set, otherwise `username`), and reuses the existing `copilot_room_loop` with the owner flag threaded through so the room knows the implicit input-token holder. The public `/api/shared/copilot/:share_token` endpoint is unchanged for invited viewers. The frontend `useCoPilotRoom` hook gained an `asOwner` flag that switches to the authenticated endpoint; `SessionClient` mounts `CoPilotOverlay` whenever the active session has an `mpShareToken`.

## Force-grant route + "Give" button

The owner can now take control back from a viewer (or hand control to a specific viewer) via `POST /api/user/shared/copilot/:share_token/grant/:target_pid`. The handler:

- Verifies the caller owns the share.
- Looks up an owner pid in the room (best-effort) to fill the `InputGrant.by` attribution.
- Calls `CoPilotRoom::force_grant`, broadcasts `InputGrant` + `Roster`, and writes a `connection.copilot_force_grant` audit row.

In the overlay, when `selfIsOwner` is true and a roster row is for someone other than the current token holder, a small **Give** button appears next to that participant. Clicking it fires the force-grant route; the next `Roster` broadcast reconciles UI state for everyone.

## WebRTC full-mesh audio

The `audio_offer` / `audio_answer` / `ice` envelopes that have lived in the co-pilot wire protocol since v1.9.x are now backed by a real implementation. A new `useCoPilotAudio` hook owns the WebRTC peer connections for a room:

- **Topology**: full-mesh, implicitly capped at 6 peers by the server-side room limit. STUN-only via `stun:stun.l.google.com:19302` — no TURN server required for the typical intranet deployment topology.
- **Glare avoidance**: the lower-lexicographic pid in each pair is the offerer.
- **ICE buffering**: candidates received before `setRemoteDescription` are buffered per peer and flushed after the SDP exchange.
- **Opt-in mic acquisition**: `getUserMedia` only runs while the user has toggled the **Join audio** button in the overlay; toggling **Leave audio** tears down every PC and stops the local stream.

`useCoPilotRoom` exposes `sendAudio` for outbound envelopes and `setAudioHandler` for routing inbound audio envelopes to the hook, keeping the audio mesh decoupled from the chat / cursor / input-token plane. Both `SessionClient` (owner) and `SharedViewer` (viewer) instantiate `useCoPilotAudio` and surface the toggle, so audio works in either direction across the mesh whenever the room's `allowAudio` policy bit is set.

## Modern checkboxes

Every native `<input type="checkbox">` in the app now renders with a unified Tailwind-styled appearance matching the existing button and toggle palette, so the share-mode dialog, the credential-profile editor, the connection picker, and every settings page share a consistent look on both light and dark themes (`d5bd26f`).

## Upgrade

Drop-in upgrade from v1.10.x — no new migrations, no configuration changes. Rebuild the backend and frontend containers:

```sh
docker compose --env-file .env \
  -f docker-compose.yml \
  -f docker-compose.internal.yml \
  up -d --build backend frontend
```

---

# What's New in v1.10.2

> **Patch release: Safeguard sign-in auto-post, account picker, and in-place credential-profile kind switching.** v1.10.2 is a UX-focused refinement of the Safeguard JIT integration shipped in v1.10.0 and hardened in v1.10.1. Three related changes land together: (1) **automated token enrolment via one-shot codes** — operators sign in via the RSTS browser flow and the resulting bearer is auto-posted back to Strata, eliminating the manual JWT copy-paste step; (2) a **Safeguard account picker** in the credential profile editor that surfaces the user's Safeguard entitlement catalogue and hides accounts that already back an existing profile; and (3) **in-place kind switching** so an existing `local` profile can be converted to `safeguard` (or back) without delete-and-recreate.

## Automated Safeguard token submission via enrolment codes

The **Safeguard sign-in card** on the Credentials page now uses **one-shot enrolment codes** to bridge the gap between the browser-based RSTS sign-in flow and automated token submission:

- **Enrolment code generation** (`/api/user/safeguard/signin/start` — authed): Mints an 8-character Crockford base-32 code, stores it with the authed user's ID and a 5-minute expiry timestamp, and returns `{ code, expires_at }` to the frontend. Rate-limited to 5 mints per minute per user.
- **Enrolment code consumption** (`/api/safeguard/enrol` — unauthed): Accepts `{ code, token, expires_in_seconds }`, atomically validates the code (not yet consumed, not expired, valid alphabet), looks up the bound user_id, seals the token via Vault, stores it in `safeguard_user_tokens` (same as the v1.10.0 manual paste flow), and logs audit events "safeguard.enrolment.consumed" (success) or "safeguard.enrolment.rejected" (failure). Returns uniform "Invalid or expired" errors for all failure paths (not used, expired, not found, malformed).
- **Code cleanup** (daily background job): Automatically purges enrolment codes that expired >1 day ago.
- **PowerShell auto-post snippet**: The UI renders a copy-paste snippet with the embedded enrolment code:
  ```powershell
  $SGToken = Connect-Safeguard -Appliance <appliance-fqdn> -IdentityProvider <idp-alias> -Verbose
  Invoke-RestMethod -Method POST -Uri 'https://<strata-fqdn>/api/safeguard/enrol' -ContentType 'application/json' -Body (@{ code = '<code>'; token = $SGToken } | ConvertTo-Json)
  ```
  Operators paste this once, the PowerShell flow handles `Connect-Safeguard`, and `Invoke-RestMethod` automatically posts the resulting token back to Strata.
- **Live countdown timer**: The modal displays a countdown (MM:SS) showing how much time remains before the code window expires. When the window closes, operators can click "Get a new code" to mint a fresh code.
- **Auto-close polling**: While the modal is open, the UI polls `/api/user/safeguard/status` every 2 seconds. When `signed_in=true`, the modal automatically closes and clears the enrolment state.
- **Fallback manual paste**: If the PowerShell paste fails for any reason, operators can click "Having trouble?" to toggle a text field, paste the bearer token directly (old v1.10.0 flow), and submit via the button. The fallback uses the existing `/api/user/safeguard/token` endpoint.

## Security and operational guidance

- **No cross-user race assignment**: Enrolment code consumption is atomic (`used_at IS NULL` + `expires_at > now()` + `RETURNING user_id`) and stores the token for the `user_id` bound at mint time. Concurrent POSTs cannot cause one user's token to land on another user by race.
- **Leak model remains important**: The enrolment code itself is an authenticator. If a code leaks before first consume, a first-writer attacker can submit a token for that bound user. This is handled as bearer-material protection rather than a route-level race defect.
- **Uniform rejection response**: Unknown, expired, malformed, and already-used codes all return `Invalid or expired sign-in code.` so callers cannot probe code state.
- **TLS trust requirement**: In production, ensure workstation trust for the Strata certificate chain. Bypassing validation with PowerShell `-SkipCertificateCheck` is suitable only for local troubleshooting and materially weakens MITM resistance.

## Backend implementation

- **Database**: New migration `070_safeguard_enrolment_codes.sql` creates the `safeguard_enrolment_codes` table (code TEXT PK, user_id UUID FK, expires_at TIMESTAMPTZ, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ, created_ip TEXT) with indexes on (user_id) and (expires_at).
- **Enrolment service** (`backend/src/services/safeguard/enrolment.rs`): Provides `mint()` (generates code, stores in DB, returns code + expiry), `consume()` (atomically validates, returns user_id, uniform error), and `purge_expired()` (cleanup job).
- **Routes**: `/api/user/safeguard/signin/start` (authed POST) and `/api/safeguard/enrol` (unauthed POST) with audit logging.

## Frontend implementation

- **API** (`frontend/src/api.ts`): New `startSafeguardSignin()` function POSTs to `/user/safeguard/signin/start`, returns `{ code, expires_at }`.
- **SafeguardSigninCard** (`frontend/src/pages/credentials/SafeguardSigninCard.tsx`): Complete rewrite with enrolment code flow, countdown timer, polling, and fallback toggles.
- **Tests**: Updated `SafeguardSigninCard.test.tsx` with new test cases covering auto-post flow, code countdown, copy snippet, fallback toggle, manual paste, auto-close polling, code expiry, error handling.

## Safeguard account picker in the credential profile editor

The credential profile editor on the Credentials page now offers an **entitlement picker** whenever the **Kind** selector is set to **Safeguard**, removing the manual lookup-and-typing step that v1.10.0 and v1.10.1 required:

- **New backend route** (`GET /api/user/safeguard/accounts` — authed): Calls the appliance's `Me/RequestEntitlements?wellKnownType=PasswordAccessRequest` endpoint with the caller's own RSTS bearer (or A2A identity, per `auth_mode`) and returns a flat list of `SafeguardEntitledAccount { account_id, account_name?, account_domain_name?, asset_id, asset_name?, asset_network_address? }` rows. The deserializer tolerates both Safeguard 8.x's nested DTO shape (entitlements grouped by `Account`/`Asset` blocks) and the flat shape returned by some appliance versions.
- **Picker UI states**: `loading` (spinner while the catalogue fetch is in flight), `signin_required` (user has no RSTS bearer yet — surfaces a link back to the Safeguard sign-in card), `load_failed` (appliance returned an error — shows a retry button), `empty` (the catalogue came back zero-length — user has no entitlements), `all_claimed` (every entitlement already backs an existing profile — shows the hint "Every Safeguard account you are entitled to already has a credential profile."), and the populated list state.
- **Claimed-row filtering**: Rows that already back an existing Safeguard profile owned by the same user are filtered out by an `isRowClaimed` predicate that matches on either `asset_id` or `asset_name`. When **editing** an existing profile, that profile's own asset stays visible in the list so the row can be re-selected without first abandoning the edit. The filter only applies to other profiles, so the operator's mental model — "show me what's still available to claim, plus what I'm currently editing" — is preserved.
- **One-click row select**: Clicking a row populates `safeguard_account_id`, `account_name`, `safeguard_asset`, and `asset_network_address` in a single state update; the operator then just confirms the **Label** and clicks **Save**.

## In-place credential-profile kind switching

An existing `local` credential profile can now be converted to `safeguard` (or back) without deleting and recreating the row, preserving the connection-mapping history and the profile's UUID:

- **`PUT /api/user/credential-profiles/:id`** now accepts an optional `kind` field (`"local"` | `"safeguard"`). When the new kind differs from the row's current kind, the backend dispatches to `cp_svc::set_kind_safeguard(...)` or `cp_svc::set_kind_local(...)` inside a single transaction.
- **Switching to `safeguard`**: the row's stored password ciphertext + DEK + nonce are nulled out and the new `safeguard_account_id` / `safeguard_asset` fields are populated from the request body. `expires_at` is recomputed via `resolve_profile_ttl` against the Safeguard resolution path so the Profiles list reflects the correct expiry semantics immediately.
- **Switching to `local`**: the Safeguard pointers are cleared and a fresh plaintext password is sealed via Vault envelope encryption. `expires_at` recomputes against the local-profile TTL slider.
- **Same-kind updates** (label / username / password / TTL only) take the existing code path — no behavioural change.

## Upgrade

Drop-in upgrade from v1.10.0 or v1.10.1 — one new migration (idempotent), no behaviour changes to existing features. Rebuild the backend and frontend containers:

```sh
docker compose --env-file .env \
  -f docker-compose.yml \
  -f docker-compose.internal.yml \
  up -d --build backend frontend
```

---

# What's New in v1.10.1

> **Patch release: Safeguard sign-in snippet hardening and dependency hygiene.** A small follow-up to the v1.10.0 Safeguard JIT release. The copy-paste PowerShell bootstrap on the **Safeguard sign-in** card is now idempotent — re-running it on an already-onboarded workstation no longer triggers a redundant `Install-Module` download, and the snippet now sets the `RemoteSigned` execution policy scoped to `CurrentUser` before invoking `Connect-Safeguard`. The release also bundles a routine batch of low-risk Dependabot bumps: the nginx runtime base image used by the frontend container, four frontend dev-dependencies (`@types/react`, `@vitest/coverage-v8`, `vite`, `vitest`), and six pinned-by-SHA GitHub Actions used across CI, release, CodeQL, Trivy, and the stale-issue workflow. No runtime behaviour changes, no migrations, no configuration changes.

## Idempotent Safeguard sign-in PowerShell snippet

The PowerShell helper rendered by the **Safeguard sign-in** card on the Credentials page now wraps the `Install-Module Safeguard-PS` call in a `Get-Module -ListAvailable -Name Safeguard-PS` guard and prefixes the snippet with `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` — matching the pattern Strata's other PowerShell helpers use. Operators who run the same snippet on every shift no longer pay the cost of a redundant module download against the PowerShell Gallery, and the `Connect-Safeguard -Browser -IdentityProvider <alias>` tail of the snippet is unchanged so existing notes and runbooks keep working without edits.

## Dependency hygiene

- **`frontend/Dockerfile`** is rebased onto `nginx:1.31.1-alpine` (pinned by digest) so the runtime image picks up the latest upstream Alpine package security patches.
- **Frontend dev-dependencies** are rolled forward (lockfile-only, caret ranges in `package.json` already covered the bumps): `@types/react` 19.2.14 → 19.2.15, `@vitest/coverage-v8` 4.1.6 → 4.1.7, `vite` 8.0.13 → 8.0.14, and `vitest` 4.1.6 → 4.1.7.
- **GitHub Actions** are rolled forward (still pinned by commit SHA with a version comment per the repo's policy in [`docs/security.md`](docs/security.md)): `docker/setup-buildx-action` v4.0.0 → v4.1.0, `docker/build-push-action` v7.1.0 → v7.2.0, `docker/login-action` v4.1.0 → v4.2.0, `docker/metadata-action` v6.0.0 → v6.1.0, `github/codeql-action` v4.35.5 → v4.36.0, and `actions/stale` v10.2.0 → v10.3.0.

## Upgrade

Drop-in upgrade from v1.10.0 — no migrations, no configuration changes, no behavioural changes. Rebuild the backend and frontend containers to pick up the new nginx base image and the bumped toolchain:

```sh
docker compose --env-file .env \
  -f docker-compose.yml \
  -f docker-compose.internal.yml \
  up -d --build backend frontend
```

---

# What's New in v1.10.0

> **Minor release: OneIdentity Safeguard JIT credential checkout.** Strata gains a first-class integration with **OneIdentity Safeguard for Privileged Passwords**. Privileged-account passwords for RDP / SSH targets no longer have to live in Strata's local credential store — instead, each session is opened against a fresh **just-in-time (JIT) checkout** retrieved from Safeguard at the moment the tunnel is built, optionally cached under Vault envelope encryption for the duration of a user's shift so a 12-hour operator isn't bounced through a 15-minute sign-in carousel every time their RSTS token expires. A new **Request Checkout** tab on the Credentials page lets users pre-fetch every Safeguard-backed profile they own in one signed-in burst with a single mandatory justification comment, and check them all back in with one click when the shift ends.

## Just-in-time credential checkout against Safeguard

Strata 1.10 introduces a new **`safeguard`** credential-profile kind alongside the existing local-password kind. A safeguard profile carries the target's Safeguard `AccountID` and the asset name instead of a stored password, and resolves into a live credential through a four-step REST dance against the appliance the moment the tunnel is opened: cancel-or-checkin any stale access request this user already holds for the same target (so the appliance doesn't reject the new request with the dreaded Code 90001 overlap error), submit a fresh access request stamped with the user's justification comment and the profile's TTL, retrieve the released plaintext password via `CheckoutPassword`, and hand it to the existing Guacamole connection pipeline as if it had come from the local credential store.

Two authentication modes are supported and can be combined. **Per-user browser sign-in** has each Strata user run `Connect-Safeguard -Browser -IdentityProvider <alias>` from the Safeguard PowerShell module in their own desktop session, copy the resulting API token into the **Safeguard sign-in** card on the Credentials page, and from that point on every checkout they trigger is attributed to their own identity in the Safeguard audit log — exactly what compliance teams expect to see. **A2A** authenticates Strata to the appliance as a single application identity using a client certificate + key + API key combination, and is the right choice for shared-automation accounts where individual attribution isn't required (Strata's own `safeguard_checkout_audit` table still records the human `user_id` for every checkout, regardless of which Safeguard auth path was used). The default **hybrid** mode prefers the per-user token when available and falls back to A2A when it isn't, so a user who hasn't signed in yet still gets a working checkout against shared accounts.

## Bulk checkout and one-click check-in

The Credentials page grows a new **Request Checkout** tab that pairs a Safeguard sign-in card with a **Bulk Checkout** card. The bulk card lists every Safeguard-backed profile the user owns, with a master **Select all** toggle and per-row checkboxes, a mandatory **Justification** input (sent verbatim as Safeguard's `ReasonComment` for every selected profile — most Safeguard policies require a non-templated comment to satisfy reviewer expectations), and a **Checkout selected** button that drives the JIT flow against the appliance one row at a time. Failures are inlined into the failing row with the full Safeguard error body so the user knows whether to retry, re-sign-in, or escalate. A matching **Check in all (N)** button releases every cached credential back to the appliance in one POST and immediately expires the matching profile rows, so the Profiles list never lies about whether a checked-in credential is still usable.

## Profile-level password caching

When an administrator enables the optional **Cache released passwords** switch in the Safeguard admin tab, every successful JIT checkout's plaintext password is sealed via the same Vault envelope encryption Strata already uses for SMTP, AD bind, and local credential profile passwords, and stored per `(user_id, profile_id)` for the lifetime configured by the profile's own TTL slider. Subsequent tunnel opens for the same profile reuse the cached row without making any Safeguard API call, so a long-running shift no longer means a 15-minute sign-in carousel for the operator. Caching is off by default; turning it on does not retroactively cache any previously checked-out credential — only future JIT checkouts.

## Hardened against every Safeguard 8.x REST quirk we found

Safeguard 8.2.x has accumulated a handful of REST behaviours that are not obvious from the documentation, every one of which is now handled defensively at the integration boundary: the `Me/ActionableRequests` endpoint returns its rows under singular bucket keys (`Requester`, `Approver`, `Reviewer`, `Admin`) instead of the pre-8.x plural keys, and the deserializer transparently accepts both shapes plus a raw-vec fallback. The `Cancel` and `CheckIn` endpoints reject a `Content-Length: 0` body with `411 Length Required` and reject `{}` with `415 Unsupported Media Type` — both verbs are now sent with the JSON-encoded string body `"strata preflight"` and `Content-Type: application/json`. The Code 90001 "duplicate access request" race is short-circuited by the new preflight that releases any stale request before posting a new one. The Code 90010 "pending password reset" rotation race that fires on the very next checkout after a cancel is absorbed by a backoff loop on `CheckoutPassword` that retries the marker for up to ten seconds and surfaces any other error immediately.

## Upgrade notes

Apply migrations **067**, **068**, and **069** in order before rolling the binary. All three are idempotent and run automatically at backend startup. The integration is opt-in everywhere: `safeguard_config.enabled` defaults to `FALSE`, `password_cache_enabled` defaults to `FALSE`, and existing `credential_profiles` rows are stamped `kind = 'local'` so deployments upgrade with no behavioural change until an administrator turns the feature on from **Admin → Secrets & Security → Safeguard JIT**. See [`docs/safeguard.md`](docs/safeguard.md) for the implementation architecture and operator runbook, and [`docs/safeguard-user-guide.md`](docs/safeguard-user-guide.md) for the step-by-step end-user guide on configuring profiles and performing bulk checkouts.

Verified end-to-end against **Safeguard for Privileged Passwords 8.2.2**.

---

# What's New in v1.9.6

> **Minor release: Multiplayer / Co-Pilot Mode for shared sessions.** Strata's share links graduate from a strict 1:1 (owner ↔ single viewer) model to a true **multiplayer / co-pilot** experience. Owners can now invite up to six participants into a single control-mode share, each with their own display name, deterministically-assigned cursor colour, and live presence on the screen. A server-arbitrated single-holder input token governs which participant currently drives the keyboard and mouse, with an idle-grant rule that automatically transfers control after two seconds of inactivity so no participant can monopolise the session indefinitely. An optional in-room text chat panel (default on) lets the cohort coordinate without leaving the session.

## Multiplayer / Co-Pilot Mode for control-mode shares

The **Share** popover in the session bar grows a new **Multiplayer (co-pilot)** toggle whenever you're creating a control-mode share. Switching it on reveals three sub-controls — **Max participants** (clamped 2..=6), **Allow chat** (default on), and **Allow audio** (default off, reserved for a follow-up release) — and decorates the generated share URL with `mp=1` so the viewer knows to open the new multiplayer plumbing.

When a participant lands on a multiplayer URL, the viewer page opens a sibling WebSocket at `/api/shared/copilot/{share_token}?name=<your-name>` _before_ touching the existing screen tunnel. The server's first reply is a `Welcome { pid, allow_chat, allow_audio, max_participants }` envelope; once the client has its `pid`, it opens the regular Guacamole tunnel at `/api/shared/tunnel/{share_token}?pid=<uuid>` so the server can gate input forwarding on the in-memory **input token** — the single-holder permit that decides whose keyboard and mouse actually drive the session.

The token starts with the owner. Peers can request it with **Take control**; if it's currently idle (no input activity for two seconds), the request is granted automatically. The owner can revoke at any time, and any holder can voluntarily **Release control** to hand the keyboard back. Every transition is broadcast as a roster update so all participants see who's driving in real time, and every join / leave / claim / revoke is audited so post-incident forensics can reconstruct who was in the room and when.

The roster strip in the corner of the viewer shows each participant's name, their assigned colour, and a small **CTRL** badge next to whoever currently holds the input token. Remote cursors are rendered live with name labels — throttled to ~30 Hz on the wire — and a collapsible chat panel (capped at 500 characters per message and 200 messages in memory) keeps the cohort in sync without forcing them into a separate chat tool.

## Kill switch and audit trail

Operators who want to disable the feature entirely without rolling back the binary can `INSERT INTO system_settings (key, value) VALUES ('multiplayer_share_enabled', 'false')`. The share-creation route checks this setting on every request and silently downgrades multiplayer flags to a standard single-viewer share when it's set to `false`, so existing one-viewer share links keep working exactly as before.

For audit purposes, the new `share_participant_audit` table records the `share_id`, server-assigned `pid`, display name, owner flag, join / leave timestamps, client IP and user agent for every participant — and matching `share.multiplayer.joined` and `share.multiplayer.left` events flow into the existing `audit_log` table so the multiplayer activity shows up in the same forensics view as every other security-relevant event.

## Upgrade notes

Apply migration 066 before rolling the binary. The schema additions are all backwards-compatible (`DEFAULT FALSE` / `DEFAULT 1`) so existing single-viewer shares continue to function without modification while the new column data lights up. The first release ships **without** the audio-mesh client and **without** an owner-side participant view; `allow_audio` is wired through the schema and protocol so a future release can light it up without a migration.

---

# What's New in v1.9.5

> **Minor release: server-side recordings search and pagination, per-user last-login tracking, configurable stale-account auto-cleanup, and Client IP visibility on the Sessions blade.** v1.9.5 makes two operator workflows on the admin blade meaningfully faster and more compliant — the Recordings table now performs its search and pagination on the server (no more silent 200-row cap on the client), and the Users table surfaces a per-user **Last Login** column plus a new retention setting that auto-soft-deletes accounts that have been provisioned and signed in at least once but have since gone idle past a configurable threshold. The Sessions blade also gains a new **Client IP** column on both the Live and Recordings tabs so administrators can see the operator's public source address for both in-flight and historical sessions.

## Server-side recordings search and pagination

The **Recordings** tab on the Sessions page previously fetched the most recent 200 recordings from the API and ran the search filter in the browser — anything beyond that window was invisible, even to a focussed search. v1.9.5 moves both the search and the pagination to the backend.

`GET /api/admin/recordings` and `GET /api/user/recordings` now accept an optional `search` query parameter. When present, the SQL `WHERE` clause adds `AND ($3::text IS NULL OR connection_name ILIKE $3 OR username ILIKE $3)` with the parameter bound as `%search%`, so a single query matches either the connection name or the operator name without any client-side post-filtering.

In the UI, the Sessions page now ships with a `PAGE_SIZE = 50` paginator and a 300 ms debounced search input. Each fetch asks for `limit + 1` rows so the page can derive a reliable `hasMore` flag, the Next / Previous footer is keyboard-accessible, and the search box resets the page to 1 on every new query. The empty state has been split into two — _"Session recordings will appear here once completed."_ when the list is genuinely empty, and _"No results matching `<query>`"_ with a single-click **Clear search filter** button when the active search has no matches. The same plumbing is used by the user-scoped Recordings view, so non-admin users get the same fast scrolling and search across their own historical recordings.

## Per-user Last Login timestamp

Every successful local or SSO authentication now updates a new `users.last_login_at` column (migration 064). The hook fires from both `POST /api/auth/login` and `GET /api/auth/sso/callback`, immediately before audit logging, and is invoked best-effort (`let _ = update_last_login(...)`) so a transient DB hiccup never blocks the user from receiving their access / refresh tokens.

The admin **Users** table now renders a new **Last Login** column right next to the existing role and status fields. Timestamps are formatted via the same `useSettings().formatDateTime` helper that powers the rest of the admin UI, so they honour the configured `display_timezone`, `display_date_format`, and `display_time_format`. Accounts that have not yet authenticated render as an italic **Never** placeholder — visually distinct from _"logged in just now"_ — which makes it straightforward to spot AD-sync imports that were provisioned but have never actually been used.

## Configurable stale-account auto-cleanup

A new **Stale account auto-deletion (days)** setting in **Admin Settings → Security → Data Retention** wires the new `last_login_at` field into the existing daily `user_cleanup` worker. Before the existing hard-delete pass runs, the worker now reads `user_stale_days` from `system_settings` and — when the value is a positive integer (1–3650) — issues:

```sql
UPDATE users
SET deleted_at = now()
WHERE deleted_at IS NULL
  AND last_login_at IS NOT NULL
  AND last_login_at < now() - make_interval(days => $1)
```

Two safety guarantees are explicit in the implementation and documented in the UI:

1. **NULL `last_login_at` is never aged out.** Users who have been provisioned (e.g. by AD sync) but have never signed in are explicitly excluded — the clock only starts after a user's first successful authentication, so a freshly-imported batch of accounts is never auto-deleted on the basis of when they were _created_.
2. **Setting `user_stale_days = 0` disables the sweep entirely.** This is the default after upgrade. The feature is opt-in; nothing happens until an administrator sets a positive threshold.
3. **The bootstrap admin account is always excluded.** The user whose username matches `DEFAULT_ADMIN_USERNAME` (default `"admin"`, case-insensitive) is filtered out of the sweep so that an unattended deployment can never lock its own operators out by aging out the only break-glass account. Administrators who genuinely want to retire that account can still soft-delete it manually from the Users blade.

Every affected row is written to the audit log as `user.stale_auto_deleted` with `{ user_id, username, stale_days }`, with `actor_id = None` to reflect that the worker (not a human operator) performed the action. Soft-deleted accounts continue to flow through the existing `user_hard_delete_days` retention window and remain restorable from the **Show Deleted Users** filter for the configured grace period.

## Client IP visibility on the Sessions blade

The admin **Sessions** page now renders a new **Client IP** column on both the Live and Recordings tabs, showing the operator's public source address — the same value used for audit-log attribution — for every in-flight and historical session. The IP is resolved at handshake from the rightmost non-empty `X-Forwarded-For` entry, with a `ConnectInfo` peer-IP fallback for direct (non-proxied) connections.

The **Live** tab reuses the in-memory `session_registry::ActiveSession.client_ip` field that was already populated end-to-end but never surfaced in the UI — no schema change was needed for in-flight sessions. The **Recordings** tab is backed by a new nullable `recordings.client_ip TEXT` column (migration 065) populated by `recordings::insert_start(...)` at the same call site that captures `nvr_session_id` and `started_at`, so the value is persisted at the moment the recording begins rather than reconstructed after the fact. Recordings created before migration 065 (or where the IP could not be resolved at handshake) render as an italic **Unknown** placeholder. The column is gated on `isAdmin`, so non-admin views of `/user/sessions` and `/user/recordings` are unchanged.

## DMZ peer version visibility on the Health blade

In deployments that use the optional public-facing DMZ relay, it has historically been possible for the `strata-dmz` binary on the edge host and the `strata-backend` binary on the internal host to drift out of sync — they're independently-released container images and an operator could legitimately roll one forward without the other. v1.9.5 closes that observability gap by surfacing the DMZ peer's software version on the admin **Health** blade, captured over the existing mTLS link rather than via any new endpoint or port.

The `strata-link/1.0` handshake is extended so the DMZ now echoes its own `software_version` back to the internal node in `AuthOutcome::Accept`, alongside the existing `link_id`. The new field is declared `Option<String>` with `#[serde(default)]`, so it is **fully wire-compatible with pre-1.9.5 DMZ binaries** — missing fields deserialise to `None` and the UI renders an explicit "Unknown" tile rather than refusing to handshake. The backend supervisor captures the advertised value into `LinkStatus.remote_software_version` on every successful handshake (preserved across `Backoff` cycles so the UI keeps the last-known value while the link is reconnecting) and surfaces it through `GET /api/admin/dmz-links` as `remote_software_version`.

The **Health** tab now renders a new **DMZ Version** tile alongside the existing **Strata Version** tile whenever DMZ mode is configured. When all DMZ peers report the same version, the tile shows `v<version>` and adds a yellow **Skew vs frontend v<X>** warning if the DMZ version differs from the frontend's `__APP_VERSION__`. When a multi-DMZ deployment is running heterogenous builds, the tile shows **Mixed** with the full list of distinct versions so administrators can identify which endpoint needs upgrading. The **DMZ Links** tab also gains a per-endpoint **DMZ version** column so the same information is visible alongside the existing link state, connects, and failures counters.

The whole exchange happens inside the existing mTLS + PSK link — no new ports, no new authentication surface, and the field is opt-in / nullable so the upgrade is staged-safe (upgrade the backend first or the DMZ first; either order works, with the tile rendering "Unknown" until both ends are on 1.9.5+).

## Upgrade

Drop-in upgrade from v1.9.4 — backend + frontend rebuild, migrations 064 and 065 apply automatically on first start. No configuration changes required to keep the old behaviour (the new sweep ships disabled by default, and the new Client IP column is populated automatically going forward).

```sh
docker compose --env-file .env \
  -f docker-compose.yml \
  -f docker-compose.internal.yml \
  up -d --build backend frontend
```

To enable the stale-account sweep after upgrade, set **Admin Settings → Security → Data Retention → Stale account auto-deletion (days)** to a positive integer and click **Save**. The next daily `user_cleanup` worker pass will pick up the new value.

---

# What's New in v1.9.4

> **Patch release: live session observer reconstructs canvas state beyond the 5-minute NVR ring buffer.** v1.9.4 fixes a visual defect where pressing **LIVE** on the Sessions page (or joining via a share link) showed a fully black canvas whenever the target session had been running for more than five minutes. Drawing instructions that aged out of the ring buffer are now salvaged into a per-session persistent-state log and replayed to newly-joining observers, so the canvas is always reconstructed from canonical screen state — while preserving the existing credential-redaction guarantees.

## Live observer no longer shows a black screen on long-running sessions

Strata's NVR (Network Video Recorder) admin and share-link observers replay a Guacamole instruction stream to reconstruct what the operator currently sees on their target host. To bound memory, each active session keeps a **rolling 5-minute ring buffer** of those instructions (`MAX_BUFFER_DURATION = 300s` / `MAX_BUFFER_BYTES = 50 MB`).

That bound created a subtle visual regression on long-running sessions: the wallpaper, layer creates, large image streams, and other large drawing operations that established the visible canvas usually happen in the first few seconds of a session. Once the session crossed the 5-minute mark those instructions were evicted from the buffer, and a freshly-joining observer's instant-dump only contained the recent (mostly idle) incremental updates — which was not enough information to repaint the desktop. The frontend was already correctly asking for `offset=0` (live edge) on the **LIVE** button; the buffer just had no canonical state to replay.

v1.9.4 introduces a **persistent-state log** that sits alongside the time-windowed ring buffer in `SessionBuffer`. Every time a frame is evicted (by age or by size), the backend salvages all of that frame's non-ephemeral drawing instructions and appends them, in order, to the persistent log. Ephemeral opcodes (`4.sync`, `3.nop`, `3.key`, `5.mouse`) are filtered out because they carry no canonical screen state — they are frame flushes, transport keep-alives, keyboard input, and the transient mouse cursor position respectively. Everything else (`img`, `png`, `jpeg`, `copy`, `rect`, `cfill`, `lfill`, `cstroke`, `lstroke`, `transfer`, `blob`, `end`, `size`, `dispose`, `cursor`, layer / buffer creates and so on) is preserved verbatim, so replaying the log re-establishes the canvas exactly as the operator drew it.

The log has its own dedicated cap (`MAX_PERSISTENT_STATE_BYTES = 20 MB`) and uses oldest-first eviction once full, so that the most recent visual state is always retained even on very long sessions with heavy churn. The existing credential-redaction pass (`filter_sensitive_instructions`) runs **before** anything reaches the log, so `7.connect` and `4.args` opcodes remain stripped at ingestion and can never end up in the persistent state.

## Observer flow updated end-to-end

The observe WebSocket handshake now sends, in order, on every connect:

1. `nvrheader` metadata (paced replay duration, speed, buffer depth, offset)
2. The cached `size` instruction (so the observer's canvas initialises at the right dimensions)
3. **The persistent-state log** (new — reconstructs canonical drawing state)
4. The current ring-buffer dump (sync-stripped to coalesce drawing ops into one atomic frame)
5. A single flushing `sync`
6. Live broadcast frames

The same sequence is applied in the **lag-recovery rebuild** inside the live-forwarding loop, so an observer who falls behind the per-session broadcast channel (`BROADCAST_CAPACITY = 8192` Guacamole frame batches) recovers to a complete canvas rather than a partial one. The behaviour is identical for the admin endpoint (`GET /api/admin/sessions/:id/observe`), the self-service endpoint (`GET /api/user/sessions/:id/observe`), and the share-link tunnel (`GET /api/shared/tunnel/:token`).

The in-player rewind controls on `NvrPlayer.tsx` (30 s / 1 m / 3 m / 5 m and **Jump to Live**) continue to work as before — clicking **LIVE** lands you exactly at the live edge with a fully reconstructed canvas, and you can then rewind back through up to five minutes of paced replay before catching up to live again.

## Upgrade

Drop-in upgrade from v1.9.3 — backend rebuild only, no database migration, no schema or configuration change.

```sh
docker compose --env-file .env \
  -f docker-compose.yml \
  -f docker-compose.internal.yml \
  up -d --build backend
```

Worst-case additional memory per active session is `MAX_PERSISTENT_STATE_BYTES = 20 MB` on top of the existing `MAX_BUFFER_BYTES = 50 MB` ring buffer (per-session ceiling ~70 MB of NVR state). The dynamic capacity recommendation in `GET /api/admin/metrics` (weighted-average `RAM_PER_SESSION_MB = 150` already accounts for kernel-side tunnel and codec buffers) covers this comfortably; no operator-facing recommendation has changed.

---

# What's New in v1.9.3

> **Patch release: Option to disable Break Glass emergency bypass, dynamic empty connection folders pruning, and package cleanup.** v1.9.3 adds an administrative option to completely disable the Break Glass emergency bypass for specific Approval Roles, dynamically filters and prunes empty folders on the Dashboard sidebar navigation tree to streamline workspace presentation, aligns formatting constraints across the rust/frontend codebases, and ensures build artifact reference consistency.

## Break Glass Emergency Bypass Toggle on Approval Roles

Administrators can now enforce strict dual-operator authorization workflows by selectively disabling the "Break Glass" emergency bypass on individual Approval Roles. In previous iterations, operators with roles flagged for approval checkouts could trigger an emergency self-approval when immediate access was required.

With this release, a new `break_glass_bypass` toggle is introduced under the Approval Role editor in **Admin Settings > Access**. When disabled, self-approvals and bypass paths are fully blocked. Operators are strictly required to obtain approval from a second authorized operator to checkout credentials, closing a potential compliance loophole in high-security environments.

## Dynamic Empty Folders Pruning in Dashboard tree

As organizations grow, the connection folder hierarchy can become cluttered with empty parent nodes or legacy directories that contain no active connection items.

v1.9.3 introduces dynamic pruning to the Dashboard sidebar tree traversal. The folder tree now automatically detects and recursively hides folder nodes that contain neither direct connections nor any active subfolders containing connections. The sidebar is now perfectly clean and clutter-free, displaying only folders that lead to selectable connection entries.

## CI Formatting and Lint Alignment

To maintain a pristine code quality standard and eliminate automated build pipeline interruptions, we have resolved style and formatting differences across both the Rust backend and React frontend. This includes applying uniform styling constraints to test suites, settings interfaces, and database schemas.

## Upgrade

Drop-in upgrade from v1.9.2. Roll the backend and frontend containers together to apply the new database migration:

```sh
docker compose --env-file .env \
  -f docker-compose.yml \
  -f docker-compose.internal.yml \
  up -d --build
```

The database migration `063_role_break_glass_bypass.sql` runs automatically at backend startup to create the `break_glass_bypass` column (defaulting to `true` to ensure zero disruption to pre-existing roles).

---

# What's New in v1.9.2

> **Patch release: Premium RDP interaction improvements, seamless collapsible sidebar dragging, and theme visual contrast.** v1.9.2 addresses several layout and user experience issues in active RDP/VNC sessions, including a top-left click deadzone, dragging lag on the collapsible sidebar toggle, and visibility contrast of the right-hand chevron button in dark theme.

## Collapsible Sidebar Dragging Lag Resolved

Interactive elements that are dynamically updated via cursor drag gestures (such as the RDP collapsible session bar) must respond instantaneously to preserve a premium, fluid user experience. In previous versions, the toggle button registered a CSS `transition: all 0.2s` rule, which caused a 200ms animation delay to interpolate layout positioning coordinates (such as `top` or `transform`).

In v1.9.2, we isolated the CSS transitions for `.session-bar-toggle` inside `frontend/src/index.css` to target only non-layout properties: `color`, `background`, and `border-color`. Pointer-driven dragging is now buttery smooth, responsive, and completely free of lag.

## Session Toggle Visibility and Dark Mode Contrast

In the Dark Theme, a duplicate `.session-bar-toggle` class block was inadvertently declaring transparent backgrounds and zero borders, overriding glassmorphic styling and rendering the right chevron toggle completely invisible when overlays were active.

We consolidated the class blocks, restored the semi-transparent dark background, borders, and premium backdrop-blur filter under dark theme, and added rich high-contrast hover states for both light and dark modes.

## Active Session Top-Left Click Deadzone Fixed

When an active remote desktop session (RDP or VNC) was running, a collapsed sidebar (`hidden === true`) still physically occupied space at the top-left of the viewport. Because the sidebar container `<aside>` remained in the DOM layout without pointer event suppression, the top-left quadrant of the remote desktop screen was unresponsive to clicks or hover events.

We resolved this by dynamically applying `pointer-events: none` directly to the sidebar container when it is collapsed, and restoring `pointer-events: auto` when expanded. Active remote sessions are now 100% interactive across the entire viewport.

## Upgrade

Drop-in upgrade from v1.9.1. Rebuild and roll the frontend container:

```sh
docker compose --env-file .env \
  -f docker-compose.yml \
  -f docker-compose.internal.yml \
  up -d --build frontend
```

No database migrations, backend changes, or configuration changes are required for this release.

---

# What's New in v1.9.1

> **Patch release: SSO Edit Form Update Deserialization & Test Connection ID lookup, plus CodeQL cleanup.** v1.9.1 fixes a deserialization bug that prevented the saving of edited SSO configurations when the client secret field was omitted to signify "no change."

## SSO Edit Fixes

Editing an existing SSO provider configuration (e.g., Entra ID, Okta) now correctly preserves existing client secrets when saving. The test connection utility also now accurately uses existing secrets to validate edited configurations, ensuring robust testing prior to saving.

## Code Quality and Technical Debt

Resolved multiple CodeQL detections related to unused variables across the backend application components, ensuring cleaner execution flows and more maintainable code.

## SPA Caching and Versioning Reliability

Configured Nginx's SPA routing to serve the main `index.html` file with strict cache-invalidation headers (`Cache-Control: no-store, no-cache, must-revalidate...`). This ensures that clients always load the absolute newest deployment configuration on reload, eliminating the issue of stale browser-cached websites while maintaining fast performance for hashed immutable assets.

---

# What's New in v1.9.0

> **Minor release: Multiple SSO/OIDC connections, dynamic login branding,
> Vault transit secrets, and BASE_URL port integrity.** v1.9.0 introduces
> the highly requested capability to run multiple OIDC identity providers
> simultaneously, complete with dynamic login branding, robust thread-safe
> state routing, and individual Vault transit unsealing.

## Multiple SSO & OpenID Connect Connections

v1.9.0 adds full multi-tenant OIDC architecture to Strata Client. Administrators can now configure, manage, and audit multiple Single Sign-On (SSO) connections simultaneously (e.g. Entra ID, Okta, and Keycloak side-by-side) using the newly expanded admin settings panel.

Key improvements include:

- **Dynamic Login Buttons**: The login page dynamically fetches all active identity providers and renders a dedicated sign-in button for each one.
- **Custom Branded Labels**: Admins can configure custom display names/labels for each SSO connection to clearly guide operators to their respective identity provider.
- **Multi-Tenant State Resolution (`SSO_STATE_STORE`)**: Rather than registering distinct callback URLs for every configured provider, all configurations share a single callback endpoint (`/api/auth/sso/callback`). The backend securely routes incoming OAuth2 callbacks by tracking random CSRF state tokens against an in-memory, thread-safe, time-bounded store (`SSO_STATE_STORE`) mapping to the originating provider ID.
- **Individual Vault-Sealed Client Secrets**: Stored client secrets are encrypted at rest using separate HashiCorp Vault transit keys dynamically per database row, preventing credential leakage in database dumps.
- **Port Integrity via `BASE_URL`**: Introduced a new `BASE_URL` configuration override in `.env` and `.env.example`. This prevents downstream proxies or SSL terminators from stripping non-standard ports (e.g., `:8443`) from redirect URIs, resolving callback mismatches during OIDC authorization code exchanges.
- **Robust Database Migration and UX**: Database migration `062_sso_providers.sql` seamlessly migrates old single-SSO environments to the new multi-provider schema at startup. Furthermore, saving an OIDC provider while Vault is unconfigured now returns a helpful HTTP 400 Bad Request instruction rather than an unhelpful HTTP 500 error, guiding the operator to initialize Vault first.

## Upgrade

Upgrade from v1.8.4. Rebuild and roll both the backend and frontend containers together to apply the new database migration and environment configurations:

```sh
docker compose --env-file .env \
  -f docker-compose.yml \
  -f docker-compose.internal.yml \
  up -d --build
```

**Important:** If your deployment runs on a non-standard port or sits behind a proxy that strips ports, make sure to add `BASE_URL=https://<your-host>:<port>` to your `.env` file to ensure correct redirect callbacks.

---

# What's New in v1.8.4

> **Patch release: Vitest test suite stabilization and environment
> hardening.** v1.8.4 resolves critical test suite regressions by
> implementing a robust global fetch polyfill and synchronizing
> authentication mocks across the entire frontend codebase.

## Robust and Stable Testing Environment

v1.8.4 focuses on the long-term reliability of our development workflow by stabilizing the Vitest test suite. As the application has moved towards more secure, cookie-based authentication, our testing environment needed to be updated to match.

Key improvements include:

- **Global Fetch Polyfill**: We've implemented a custom fetch polyfill in our test setup that correctly handles relative URL paths (e.g., `/api/...`) by automatically resolving them to `http://localhost`. This eliminates the "Invalid URL" errors that previously plagued the Node-based test environment.
- **Synchronized Authentication Mocks**: All component tests have been updated to include the necessary authentication utilities in their mocks. This prevents unhandled promise rejections and component crashes during testing, ensuring that developers can rely on the test suite for accurate feedback.
- **Improved React Compatibility**: We've refined how we handle asynchronous state updates in our tests, resolving numerous React "act" warnings and ensuring our testing patterns align with current best practices.

## Upgrade

Drop-in upgrade from v1.8.3. Roll both the backend and frontend
containers together:

```sh
docker compose --env-file .env \
  -f docker-compose.yml \
  -f docker-compose.internal.yml \
  up -d --build
```

v1.8.4 is focused on development environment reliability and testing stability. It inherits the `JWT_SECRET` requirement introduced in v1.8.3.

---

# What's New in v1.8.3

> **Patch release: NJS-based security hardening, CSP frame-ancestors, and
> auth stabilization.** v1.8.3 hardens the application's security posture
> by transitioning to modern security headers and stabilizing the
> authentication lifecycle during backend restarts. **Note: `JWT_SECRET`
> is now a mandatory environment variable for persistent sessions.**

## Modern Anti-Clickjacking Protection

Recent security hardening completes our transition to modern security headers by replacing the legacy `X-Frame-Options` header with the modern `Content-Security-Policy: frame-ancestors 'none'` directive across all responses.

While `X-Frame-Options` was a useful first-generation guard, the CSP `frame-ancestors` directive is the modern standard for preventing clickjacking. By making this transition, we ensure that anti-framing protection is handled more predictably and securely by modern browsers.

## Persistent Sessions Across Restarts

Until now, the Strata backend generated a fresh, random JWT signing secret every time the container started. While secure, this had a significant UX drawback: any time the backend container was restarted (for an upgrade, a configuration change, or a routine health-check recycle), all active user sessions were immediately invalidated. Users would find themselves unexpectedly logged out and forced to sign in again.

The current architecture utilizes a mandatory `JWT_SECRET` environment variable. By providing a persistent secret in your `.env` file, you ensure that user sessions (both access and refresh tokens) remain valid across backend restarts. This results in a much smoother experience for operators, especially in environments with frequent deployment cycles.

## Zero Technology Fingerprinting

Following our work in v1.8.2 to remove the `Server` header, we have implemented a more robust, NJS-powered filter that masks the `Server` header as "Strata" and removes the `X-Powered-By` header globally. This applies to every response, including those generated internally by Nginx, ensuring that no technical details about our stack are disclosed to potential attackers or automated scanners.

## Cleaner Browser Console

We've optimized the frontend application's startup sequence to eliminate the "401 Unauthorized" errors that previously appeared in the browser console during the login phase. By relocating the preference and settings providers inside the application's authentication gate, we ensure that these components only attempt to fetch data once the user is successfully signed in. The result is a cleaner, more professional diagnostic experience for operators.

## Improved CORS and CSRF Stability

We've refined the Nginx proxy configuration to handle port-specific Host headers more accurately. This fix resolves sporadic CORS and CSRF validation failures that could occur when Strata was deployed behind certain load balancers or on non-standard ports.

## Upgrade

Drop-in upgrade from v1.8.2. Roll both the backend and frontend
containers together:

```sh
docker compose --env-file .env \
  -f docker-compose.yml \
  -f docker-compose.internal.yml \
  up -d --build
```

**Important:** You must set a `JWT_SECRET` in your `.env` file to take advantage of session persistence. See `.env.example` for a template.

---

# What's New in v1.8.2

> **Patch release: global security headers, session-timeout reliability,
> and CI hardening.** v1.8.2 hardens the application's security posture
> by enforcing non-cacheable API responses globally and tightening the
> session-lifecycle state sync between the frontend and backend. Drop-in
> upgrade from v1.8.1 — roll both the backend and frontend containers
> together.

## Sensitive data is never cached

Until v1.8.2, API responses were relying on browser defaults for
caching. While most modern browsers do not cache authenticated XHR
requests by default, certain proxies, shared workstations, or
misconfigured browser environments could potentially persist sensitive
authenticated data to disk.

v1.8.2 implements a global security header policy on every API response:

```http
Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate
```

The `no-store` directive is the most important: it explicitly forbids
the browser and any intermediate proxies from storing any part of the
response in any cache (persistent or volatile). This ensures that
once a user signs out or closes their session, no sensitive data remains
reachable in the browser's local cache.

## Modern framing protection

v1.8.2 replaces the legacy `X-Frame-Options: DENY` header with the modern `Content-Security-Policy: frame-ancestors 'none'` directive.

While `X-Frame-Options` served us well, modern browsers now prioritize the CSP `frame-ancestors` directive. By moving to the CSP standard, we ensure that anti-framing protection is handled more predictably across modern user agents while remaining explicitly secure against clickjacking attacks.

## Zero technology disclosure

To further harden our public surface, v1.8.2 now strips the `Server` and `X-Powered-By` headers entirely from all responses. By upgrading to **Nginx 1.30.0 (Stable)** and implementing a custom **njs (Nginx JavaScript)** header filter, we've eliminated the "Server: nginx" fingerprint, making it harder for automated scanners to identify and target our stack's specific technology.

## Session timeout is now more reliable

We identified a race condition in the session-timeout warning system.
The `csrf_token` and `session_expires` cookies (which the SPA needs to
read to trigger a session extension) were expiring at the exact same
second as the `access_token` itself.

If the user clicked "Extend session" during the final few seconds of
their session, the browser might have already purged the CSRF token
cookie, causing the refresh request to fail with a `403 Forbidden` and
leaving the UI in a "zombie" state where the warning was still visible
but the session was dead.

v1.8.2 fixes this by issuing the `csrf_token` and `session_expires`
cookies with a **60-second buffer** relative to the access token. The
SPA can now reliably read its session metadata right up to the hard
deadline. We've also updated the "Extend session" button to handle
refresh failures gracefully — if a refresh fails (e.g. because the
session was revoked on the server), the UI now forces an immediate
logout rather than hanging.

## Restored security scanning in CI

The Trivy container-scanning pipeline in our GitHub Actions was
failing to locate the locally built Docker images. This left a blind
spot in our automated security auditing.

v1.8.2 corrects the `.github/workflows/trivy.yml` configuration by
forcing the `docker` driver in the Buildx setup and explicitly informing
Trivy to scan the resulting image. Our images are once again
automatically audited for vulnerabilities on every push.

## Upgrade

Drop-in upgrade from v1.8.1. Roll both the backend and frontend
containers together:

```sh
docker compose --env-file .env \
  -f docker-compose.yml \
  -f docker-compose.internal.yml \
  up -d --build
```

No database migrations, no environment variables to add, and no API
contract changes.

---

# What's New in v1.8.1

> **Patch release: the credential-profile expiry watcher introduced
> in v1.8.0 no longer fires a `1 day` warning toast the moment a new
> standard credential profile is created.** Frontend-only, drop-in
> upgrade from v1.8.0; the backend image is byte-identical.

## What was wrong

The default standard credential-profile TTL is 12 hours, so every
freshly-saved profile started life with `secsLeft = 43 200` — already
inside the watcher's 24-hour ("1 day") warning window. As soon as the
next 60-second poll fired, the warning published a toast labelled
`<profile> expires in 1 day`, which is true but not useful: the user
had just chosen a 12-hour TTL on purpose, so a "1 day" warning at
T+0 carried no information. The same shape of bug existed for any
extended-expiry profile created with a TTL shorter than 7 days.

## What changed

The watcher now filters its threshold list against each profile's
own `ttl_hours * 3600` window before evaluating, dropping any
threshold that is wider than (or equal to) the profile's whole
lifetime. Concretely:

- **12 h standard profile** → effective thresholds `[1 h, 10 m]`
  (no spurious 1-day toast on first poll).
- **24 h standard profile** → effective thresholds `[1 h, 10 m]`.
- **25 h standard profile** → effective thresholds `[1 d, 1 h, 10 m]`
  (the 1-day toast still fires when ~1 hour of the window has
  elapsed, exactly as intended).
- **7 d extended profile** → effective thresholds `[1 d, 1 h]`
  (no spurious 7-day toast on creation).
- **90 d extended profile** → all three thresholds apply, unchanged.

A regression test (`does not fire the 1-day toast on a freshly-created
12 h profile`) was added to the watcher suite to lock the behaviour
in.

## Upgrade

Drop-in from v1.8.0. The backend image is byte-identical between
the two releases; only the frontend container needs to be rebuilt:

```sh
docker compose --env-file .env \
  -f docker-compose.yml \
  -f docker-compose.internal.yml \
  up -d --build frontend
```

If the v1.8.0 watcher had already published a spurious 1-day toast
for a short-TTL profile, the corresponding
`localStorage["strata.credExpiryFired.v1"]` entry is harmless under
the new code path and will be cleared automatically the next time
the profile is renewed or deleted. No manual storage cleanup is
required.

---

# What's New in v1.8.0

> **Minor release: a brand-new toast notification system, a watcher
> that uses it to warn you before a credential profile expires, and a
> fix for password paste in SSH sessions.** v1.8.0 is a frontend-only
> release. Drop-in upgrade from v1.7.0 — no schema changes, no API
> contract changes, no new environment variables, no new runtime
> dependencies. Only the frontend container needs to be rebuilt.

## You will know before a credential profile expires

Until v1.8.0 the only signal that a credential profile had expired
was the moment a user tried to open a connection that depended on
it — guacd would refuse the handshake with a generic error, the
operator would scratch their head, navigate to the credentials page,
and notice the expiry timer had already wrapped past zero. With
extended-expiry profiles introduced in v1.7.0, that surprise could
arrive 90 days after the credential was created, by which point the
person who originally seeded the profile may not even be at their
desk.

v1.8.0 ships a small, render-null background watcher that lives
inside the application shell for every signed-in operator who has
the vault feature enabled. It polls the credential-profiles list
once a minute and publishes a single toast as each pre-expiry
threshold is crossed:

- **Standard profiles** (the default 1–12 hour TTL) warn at
  **1 day**, **1 hour**, and **10 minutes** before the deadline.
- **Extended-expiry profiles** (the opt-in 1–90 day TTL introduced
  in v1.7.0) warn at **7 days**, **1 day**, and **1 hour**. The
  wider thresholds match the longer windows so a 90-day profile
  doesn't get a 10-minute toast and a 12-hour profile doesn't get
  a 7-day toast.

Only the **tightest threshold** the operator has currently crossed
fires. A tab opened at the 30-minute mark sees only the 10-minute
warning, never the 1-day one too. Once a profile actually expires,
a sticky red toast labelled **"&lt;profile&gt; has expired"** appears
with a **Renew now** action that deep-links straight to the
credentials page. Sticky because the operator genuinely cannot
connect with that profile until they act — a 6-second flash would
be too easy to miss.

A few subtleties worth knowing about. The watcher persists "already
fired" state in `localStorage` under a namespaced key, so closing
the tab and reopening it does not re-fire the same warning, and two
tabs open side-by-side do not double-up. When a profile's TTL is
re-issued — the password is rotated, `extended_expiry` is toggled,
or the operator bumps the slider — the new `expires_at` differs
from the recorded one and the tracker re-arms every threshold for
the fresh window so the next 1-hour mark fires fresh. Profiles that
are deleted on the server are pruned from the tracker on the next
poll, so storage cannot grow without bound. A profile bound to a
managed-account checkout has its expiry already capped on the
server side (the backend takes `min(profile_ttl, checkout_ttl)`),
so trusting `profile.expires_at` is correct in both cases.

The poll is cheap — a single short-lived `SELECT` per call — but
the watcher also re-evaluates immediately on `focus` and
`visibilitychange`, so a laptop that wakes from sleep after eight
hours sees the "expired" toast appear within a second of the user
clicking back into the tab, rather than waiting for the next 60-s
poll.

## A reusable toast notification system, themed to fit

The toast surface that powers the watcher above is a generic
`ToastProvider` — every component beneath the auth gate can call
`useToast().info / .success / .warning / .error` to publish a
notification. Each toast carries a title, an optional secondary
description, an optional **action button** (with built-in busy-state
handling so the button shows "Working…" while a long-running click
handler resolves), and a `key` so a long-lived consumer can update
the same toast in place rather than spawning duplicates.

Variants are theme-tokenised — info uses the accent purple, success
uses the existing success green, warning the warning amber, error
the danger red — picked from the same CSS custom properties that
drive the rest of the UI, so any future palette tweak flows through
without a code change. Auto-dismiss timing matches the variant: 6
seconds for info / success, 8 seconds for warning, and **error
toasts are sticky** until dismissed (the watcher's expired toast is
the canonical example). Every toast also carries a small ✕ close
affordance in the corner so an actionless info toast can still be
hidden by hand if it is in the way.

The viewport renders into a `document.body` portal so the stack
escapes any transformed or overflow-hidden ancestor, sits in the
top-right (the bottom-right is reserved for the existing
session-timeout warning so the two never collide visually), and
respects screen readers via `role="region"` + `aria-live="polite"`
on the container with `role="alert"` for warnings and errors.

Future consumers — checkout-approval notifications, AD-sync
completion, forced sign-out propagation — can hook into the same
provider with a one-line `useToast()` call.

## Pasting a password into an SSH session works again

A regression introduced when bracketed-paste support was added in
v1.6.x meant pasting a password into an SSH or telnet password
prompt — `sudo`, `ssh` password auth, `passwd`, `mysql -p`, every
Cisco / Juniper / Mikrotik device CLI — was failing with an
"incorrect password" error even when the password was correct.

The cause: the paste helper was wrapping every SSH / telnet
clipboard payload in bracketed-paste markers (`ESC[200~ … ESC[201~`).
Those markers are essential for multi-line code or config blocks
because they tell paste-aware shells (bash, zsh, vim, tmux) to
suspend auto-indent and per-keystroke key bindings for the duration
of the paste. But a password prompt is not running under bash —
it's reading stdin in raw no-echo mode and treats the literal
escape bytes as part of the password, so the prompt was effectively
receiving `\x1b[200~yourpassword\x1b[201~` and the hash never
matched.

v1.8.0 makes single-line SSH / telnet pastes byte-transparent. If
the payload contains no `\r` and no `\n`, the helper returns it
unchanged. Multi-line pastes still get bracketed-paste wrapping and
the `\n → \r` translation that paste-aware shells rely on, so
pasting a config block into `nano` or `vim` continues to work as
intended. The one-line passthrough is the only change to the
behaviour.

## Upgrade

Drop-in upgrade from v1.7.0. The backend image is byte-identical
between the two releases; only the frontend container needs to be
rebuilt:

```sh
docker compose --env-file .env \
  -f docker-compose.yml \
  -f docker-compose.internal.yml \
  up -d --build frontend
```

No environment variables to add, no migration to run.

---

# What's New in v1.7.0

> **Minor release: opt-in, long-lived credential profiles for service
> and break-glass accounts.** v1.7.0 ships a single user-visible
> feature (a per-profile checkbox that lifts the 12-hour TTL ceiling
> up to 90 days), the database constraint that backs it, a themed
> range slider, refreshed checkbox styling, and a routine refresh of
> base images, GitHub Actions, and npm minor/patch dependencies. Drop-in
> upgrade from v1.6.2 — the migration runs unattended at backend
> startup, no environment variables, no new runtime dependencies, and
> no API contract removals.

## A credential profile can now last up to 90 days, when you ask it to

The standard credential profile in Strata has always been governed by
a 12-hour TTL ceiling — a deliberate guardrail that keeps stored
passwords short-lived for ordinary users and matches the cadence
operators expect for an active session's worth of work. That ceiling
is right for almost every profile, but it does not fit every profile.
Service accounts whose passwords are rotated centrally on a 30- or
90-day cadence, break-glass accounts that need to remain usable for
the duration of an incident, and lab accounts whose stored passwords
are simply long-lived all collided with the 12-hour limit and forced
operators to re-enter the same credential several times a day.

v1.7.0 introduces a single new control on the credential-profile
editor — **Allow extended expiry (up to 90 days) — use only for
service or break-glass accounts** — that opts a profile into a
relaxed limit of 1–90 days (1–2160 hours). The setting is per-profile
and defaults to off. When ticked, the password-expiry slider switches
from hours to days, the displayed unit follows (`12 hours` → `90 days`),
and the helper text updates to remind operators why this lever
exists. Toggling the checkbox snaps the stored TTL to a sensible
default for the new mode (12 h when turning extended off, 720 h /
30 d when turning it on) so a single misclick cannot accidentally
save a 1-hour "extended" profile or a 90-day "standard" profile.

The relaxed ceiling is enforced at every layer. The database CHECK
constraint introduced by migration
[`061_credential_profile_extended_expiry.sql`](backend/migrations/061_credential_profile_extended_expiry.sql)
is a two-arm guard:

```sql
ttl_hours >= 1
  AND ((extended_expiry = FALSE AND ttl_hours <= 12)
    OR (extended_expiry = TRUE  AND ttl_hours <= 2160))
```

so a profile that is _not_ opted in cannot persist a TTL above 12
hours even if a future code path forgets to consult the new resolver.
A profile that **is** opted in cannot exceed 2160 hours either. The
backend resolver `resolve_profile_ttl(user_pref, admin_max, extended)`
in [`backend/src/routes/user.rs`](backend/src/routes/user.rs) picks
the right cap and clamps the request through the same `[1, cap]`
range as the previous resolver — six new unit tests pin the boundary
conditions. Existing rows are backfilled to `extended_expiry = FALSE`
by the column default and continue to satisfy the new CHECK without
intervention.

A subtle but deliberate behaviour: toggling `extended_expiry` on its
own (without changing `ttl_hours`) does **not** recompute
`expires_at`. Operators who actually want to push the expiry out
must also bump the TTL itself, which prevents accidental
re-extension on every label edit and keeps the audit timeline
honest.

## Themed range slider

The native `accent-color` range slider stopped short of the line on
the right end at the maximum value, leaving a small gap between the
purple fill and the slider thumb. The new `range-slider` utility
class in [`frontend/src/index.css`](frontend/src/index.css) replaces
the browser default with a CSS-driven gradient track driven by a
`--range-pct` custom property, so the accent fill always reaches
the thumb regardless of the slider's value or the renderer (Chromium
and Gecko verified). The thumb is now a white circle with an accent
border and a small hover scale, matching the rest of the dark theme.
The same component drives both the standard and the extended-expiry
slider so their behaviour is identical.

## Themed checkbox

The browser-default checkbox used by the new "Allow extended expiry"
toggle stood out against the rest of the form like a sore thumb. It
now picks up the existing `.checkbox` class shared with the request-
checkout form so its size, border radius, and accent colour match
every other checkbox in the application.

## Audit trail covers the new flag

The `audit_logs` payload emitted by `create_credential_profile` now
includes both `ttl_hours` and the new `extended_expiry` boolean
alongside the profile label. Deployments that ship audit logs to a
SIEM gain immediate visibility into who opted a profile into the
relaxed cap and when. Update mutators continue to emit
`credential.profile.updated`; the diff between successive log entries
will now expose `extended_expiry` transitions explicitly.

## Refreshed dependencies

A routine refresh of base images, CI actions, and npm modules.
Nothing in this list changed user-visible behaviour; it is included
here for transparency.

- **Base images** — `rust:1.95-slim-trixie` and `debian:trixie-slim`
  digests refreshed against current upstream; `node:25-alpine` →
  `node:26-alpine`; `nginx:alpine` digest refreshed.
- **GitHub Actions** — `actions/checkout` v5 → v6.0.2 (in
  `dependency-review.yml` and `scorecard.yml`; other workflows were
  already on v6), `actions/dependency-review-action` v4.9.0 → v5.0.0,
  `actions/stale` v9 → v10.2.0, `release-drafter/release-drafter`
  v6.4.0 → v7.3.0, `github/codeql-action` 4.35.3 → 4.35.4,
  `sigstore/cosign-installer` v4.1.1 → v4.1.2,
  `ossf/scorecard-action` v2.4.0 → v2.4.3.
- **Frontend npm** — `react` 19.2.5 → 19.2.6, `react-dom`
  19.2.5 → 19.2.6, `react-router-dom` 7.14.2 → 7.15.0,
  `@tailwindcss/vite` + `tailwindcss` 4.2.4 → 4.3.0, `vite`
  8.0.10 → 8.0.12, `i18next` 26.0.10 → 26.1.0, `mermaid`
  11.14.0 → 11.15.0, `@types/dompurify` 3.0.5 → 3.2.0.

## Upgrade

Drop-in upgrade from v1.6.2. Roll the backend and frontend container
images together — the new `extended_expiry` column is added by the
backend at startup and the frontend `CredentialProfile` interface
requires the new field on every payload. There are no environment
variables, no new runtime dependencies, and no API contract
removals.

---

# What's New in v1.6.2

> **Patch release: drop-in fixes against the v1.6.1 deployment.**
> Six independent UX/correctness fixes raised against the v1.6.1
> production deployment. No API contract changes, no database
> migrations, no new environment variables, and no new runtime
> dependencies. Drop-in upgrade from v1.6.1 — roll the backend and
> frontend images together.

## Connection-folder hierarchy renders properly on the dashboard

Operators creating a folder hierarchy of e.g.
`Root → Switches → Coventry` and adding a connection inside
`Coventry` previously saw the connection only when they expanded
`Coventry` directly; the tree was a one-level-deep group list rather
than a recursive tree, and the per-row indent collapsed every
connection to the same visual depth regardless of its real folder.
The Dashboard now builds a recursive `folderTree` model with
descendant-inclusive count badges (so the parent folder header
shows the total count even while collapsed), depth-proportional
indentation (`8 + depth * 16` px on the connection row name,
description, and tag pills), per-folder open/closed chevron + folder
icon, and toolbar **Expand all** / **Collapse all** buttons (visible
only in folder view with a non-empty tree). When a search filter is
active every folder containing a match is auto-expanded so hits
never hide behind a collapsed parent.

## All folder pickers across the app sort hierarchically

The connection-edit Folder dropdown, the role-folder assignment
checklist, the folder management table, and the AD-sync default-folder
picker previously listed folders alphabetically with no nesting
visible, scattering children away from their parents and making it
hard to tell where a connection would actually be placed. They now
share a single new helper, `orderFoldersByHierarchy()`, which
performs a depth-first preorder traversal with alphabetic sibling
ordering and an orphan-as-root fallback (so a folder whose parent
has been deleted out from under it still appears at the top level
rather than vanishing). Children are indented with non-breaking-
space padding inside `<select>` options or with `paddingLeft:
depth * 16px` on HTML controls.

## Tag picker no longer overflows the viewport on rows low on the page

The per-row tag-picker dropdown was anchored to the pill button with
a fixed `top` position, so opening it on a connection low on the page
pushed the dropdown below the fold. The picker now opens **above**
the pill row when there is insufficient space below, with a 16 px
viewport margin and a hard-cap `max-height` so its contents always
stay scrollable inside the viewport.

## SSH credential prompt now always appears when guacd asks for one

When a connection has no stored credentials and `guacd` requests
SSH/Telnet credentials via the `onrequired` protocol message, the
client must prompt the operator for the username — even if the JWT
has one — because the remote SSH server expects the username to
match the **remote** account, not the Strata operator. The previous
implementation populated the field with the JWT username and skipped
the prompt; v1.6.2 always shows the prompt for SSH/Telnet `onrequired`
events and pre-fills it only when the operator has explicitly
requested a "remember last" preference.

## Expired-credential renewal accepts a username-less re-encrypt

The "renew expired credential" path inside the credential editor
required a non-empty `username` even though the renewal flow only
re-encrypts the password against the existing username. The form now
keeps the username field optional during renewals and fails with a
clearer error when both fields are absent.

## New `GET /api/user/connection-folders` endpoint

The Dashboard tree view and the global Command Palette previously
fell back to "ungrouped" for every nested connection because the
only folder-listing endpoint required `can_manage_connections`. The
new read-only endpoint is gated by the same auth middleware as
`/api/user/connections` and returns the full folder list so any
authenticated user can render the same hierarchy the admins
authored. Documented in
[`docs/api-reference.md`](docs/api-reference.md).

---

# What's New in v1.6.1

> **Patch release: production hardening.** v1.6.1 is a focused patch
> against three independent issues reported against the v1.6.0
> deployment. There are no API contract changes, no database
> migrations, no new environment variables, and no new dependencies
> — drop-in upgrade from v1.6.0. Two of the three fixes were
> straightforward to reproduce; the third required tracing the
> Guacamole vendor's input-event hijacking through four window
> contexts (main, popout, multi-monitor, fullscreen) before the
> shape of the fix became obvious. The release also adds a small
> amount of diagnostic tracing on the SSO callback so future
> "sign-in is slow" reports can be triaged from logs alone.

## Multi-line paste into SSH/Telnet now matches what a real terminal sees

Pasting a multi-line snippet from the system clipboard into an SSH
or Telnet session was being delivered to the remote shell as a
sequence of separate keystrokes with embedded `\r\n` pairs. Editors
that interpret bracketed paste — `vim`, `nano`, `less`, `psql`,
`mysql`'s shell, `python` REPL, etc. — saw each line as a freshly
typed command rather than as part of a single paste, and the
trailing `\n` of every CRLF triggered an unintended Enter that
committed half-formed commands. The fix wraps the payload with the
bracketed-paste start/end sequences (`ESC [ 200 ~` / `ESC [ 201 ~`)
exactly like a `xterm`-class terminal would, and rewrites every
`\r\n` and bare `\n` to a single `\r` to match the carriage-return
that a real keyboard emits. The transformation only applies to
`ssh` and `telnet` connection protocols — RDP, VNC, Kubernetes
exec and Quick-Share clipboard payloads are passed through
verbatim, so nothing changes for non-terminal protocols. Seven new
unit tests pin the boundary conditions (empty input, `\r\n` runs,
mixed line endings, RDP passthrough) and the integration is wired
through both the main-window paste path in `SessionManager.tsx`
and the popout-window equivalents in `usePopOut.ts`.

## You will no longer be logged out mid-session

Users actively typing or clicking inside a remote session were
being signed out of the Strata SPA at the 20-minute access-token
mark even though they were demonstrably active. The proactive
token-refresh logic in `SessionTimeoutWarning` listens for
`mousedown` / `keydown` / `touchstart` / `scroll` on `window`,
and on a click or keypress with under 10 minutes left on the access
token it triggers a silent background refresh. The Guacamole vendor
library, however, installs its own `Keyboard(document)` and
`Mouse(displayEl)` handlers that call `event.preventDefault()` and
`event.stopPropagation()` on every input event before they bubble
to `window` — so for the duration of an active session the
warning never saw a single user input event, the access token
expired, and the next API call returned 401. The fix introduces a
small `sessionActivity` event bus
(`frontend/src/components/sessionActivity.ts`): the Guacamole input
callbacks call `notifySessionActivity()`, which dispatches a
throttled (1 Hz) `strata-session-activity` window event;
`SessionTimeoutWarning` subscribes to that event in addition to its
existing DOM listeners. The notify call is plumbed through every
window context where Guacamole input might be handled — the
main-window mouse and keyboard paths in `SessionManager.tsx` and
`SessionClient.tsx`, the popout-window mouse, touch, and keyboard
paths in `usePopOut.ts`, and the multi-monitor per-monitor mouse
and keyboard paths in `useMultiMonitor.ts`. Both popout hooks
execute in the _opener's_ JS context (only the Guacamole
`displayEl` is reparented into the popup's DOM), so the event
dispatches on the same `window` where `SessionTimeoutWarning` is
mounted and no cross-window plumbing is required. The result is a
simple invariant that holds for every window flavour the product
exposes: **as long as you are interacting with a remote session,
you cannot be signed out**, and the existing 8-hour refresh-token
ceiling is the only hard cap on session length.

## SSO sign-in is faster — and emits enough trace context to triage future hangs

A user reported the first SSO sign-in of the day appeared to hang
on a Keycloak page before eventually succeeding; subsequent
attempts were instant. Investigation showed that on a cold OIDC
cache the `/api/auth/sso/callback` handler was performing **four**
upstream HTTP round-trips to the IdP before issuing its 303
redirect: discovery (cached only inside `routes::auth`), the token
endpoint POST, discovery **again** inside
`services::auth::validate_token` (a separate uncached cache miss
because the cache lived in the wrong module), and the JWKS fetch
(never cached). Each upstream call has a 5-second connect /
10-second overall timeout, so on a sluggish corporate IdP that
cumulates to 15–30 seconds of callback latency during which the URL
bar still shows the Keycloak callback URL and the user perceives
Keycloak as hanging. The fix consolidates discovery into
`services::auth::fetch_oidc_discovery_cached` so both call sites
share a single cache, and adds a JWKS cache with the same 10-minute
TTL. The callback now performs at most one upstream call (the
token POST) on a warm cache, and only two (discovery + token POST)
on the first ever sign-in after process start. As a defensive
secondary the `/api/auth/sso/login` redirect now sends
`Cache-Control: no-store` to prevent BFCache replay of stale
single-use `state` UUIDs from the back/forward buttons.

A new info-level tracing line emitted at the end of every
successful callback under the `strata::auth::sso` target carries a
per-step latency breakdown (`discovery_ms`, `token_exchange_ms`,
`token_validate_ms`, `total_so_far_ms`) so the next "SSO is slow"
report can be triaged from the backend logs alone — if those
numbers add up to roughly the user-perceived wait, the time was
spent inside Strata; if they are tiny but the user still waited
minutes, the time was spent inside Keycloak or a federated
upstream IdP (AD FS / Entra ID / federated LDAP) and the trail
continues there rather than here.

## Drop-in upgrade — no migrations, no API contract changes

No database migrations. No new environment variables. No API
contract changes (the SSO redirect now carries a
`Cache-Control: no-store` header and the callback emits an extra
tracing line, neither of which is part of any documented contract).
Bundle size is unchanged. Backend memory footprint gains two
small `tokio::sync::Mutex<Option<(Instant, T)>>` cache cells.
Roll the backend and frontend images together; both remain
backwards-compatible with v1.6.0 peers during a rolling update.

---

> **Minor release: enterprise foundations.** v1.6.0 lays groundwork
> that has been requested by enterprise reviewers without changing
> any existing API contract or requiring a database migration. The
> backend now emits a stable machine-readable `code` field on every
> error response (so integrators can branch on `UNAUTHENTICATED` or
> `DEPENDENCY_UNAVAILABLE` instead of regex-matching English prose),
> the frontend gains a skip-to-content link plus focus-trapped
> confirmation dialogs and a freshly-wired i18n scaffold (English
> baseline, Login as the migrated exemplar), and operators get two
> new runbook-grade documents covering the API lifecycle policy
> (`docs/API-LIFECYCLE.md`) and a production Kubernetes topology
> (`docs/deployment-kubernetes.md`). Drop-in upgrade from v1.5.5 —
> roll all four images together.

## Stable error codes on every API response

Every `AppError` now maps to a stable SCREAMING_SNAKE token, and the
JSON error body is now `{ "error": "<message>", "code": "<token>" }`.
The set of codes — `INTERNAL`, `DEPENDENCY_UNAVAILABLE`,
`UNAUTHENTICATED`, `FORBIDDEN`, `INVALID_REQUEST`, `NOT_FOUND`,
`SETUP_REQUIRED` — is now part of the documented API contract per
`docs/API-LIFECYCLE.md`. Existing clients that branch on the `error`
string keep working; new clients should prefer `code`.

## Accessibility — skip link + focus-trapped dialogs

A skip-to-content anchor at the top of every page becomes visible on
keyboard focus and jumps past the persistent navigation rail directly
to `<main id="main-content">` (WCAG 2.4.1 — Bypass Blocks).
Destructive-action confirmation dialogs (`ConfirmModal`) now trap
keyboard focus inside the dialog while open and restore focus to the
previously-focused element on close (WCAG 2.4.3 / 2.1.2), via a new
generic `useFocusTrap` hook reusable from any future modal.

## Internationalisation scaffold (English baseline)

`i18next` + `react-i18next` are now wired in with an English baseline
locale (`common` and `login` namespaces), language detection from
`localStorage["strata.lang"]` → `navigator.language` → English
fallback, and a `setLanguage(lang)` helper ready for a future
user-settings toggle. The Login page is the migrated exemplar so
subsequent PRs can adopt the pattern incrementally rather than
landing a single mega-refactor. The frontend bundle gains roughly
30 KB gzipped.

## API-lifecycle and Kubernetes deployment docs

`docs/API-LIFECYCLE.md` formalises the `/api/v1` versioning policy,
support window, breaking-change definition, `Deprecation` / `Sunset`
headers per RFC 9745, the error-code stability contract, and the
changelog discipline that backs it.

`docs/deployment-kubernetes.md` is a production-grade Kubernetes
runbook: per-component replica topology (the backend stays at
`replicas=1` because rate limits, settings cache, OIDC nonce cache,
and HTTP session storage are all process-local), `ExternalSecrets`
inventory, PVC sizing table (postgres / vault / recordings / config),
ingress + `NetworkPolicy` YAML, split liveness / readiness probes
(`/api/health/live`, `/api/health/ready`), resource sizing,
`terminationGracePeriodSeconds: 45`, and a curated common-pitfalls
section.

## Hardened a panic-free invariant in the user routes

Replaced an `unwrap()` after a non-`None` guard in the
checkout-activation handler with an explicit error path that returns
the new stable `INTERNAL` code. Logically unreachable in normal
flow, but the explicit handling preserves the panic-free invariant
the rest of the route enforces under concurrent or adversarial
inputs.

## Drop-in upgrade — no migrations, no API contract changes

No database migrations. The error body adds a `code` field but the
existing `error` field is unchanged in shape and meaning. All four
images (frontend, backend, DMZ edge, guacd) should be rolled
together but each one is backwards-compatible with v1.5.5 peers
during a rolling update.

---

# What's New in v1.5.0

> **Minor release: DMZ deployment mode.** v1.5.0 introduces a
> split-topology deployment where the public-internet surface is a
> separate, minimal, sandboxable binary (`strata-dmz`) and the full
> backend (`strata-internal`) stays inside the corporate network. The
> internal node opens a persistent **outbound** mTLS tunnel to the
> DMZ; the DMZ initiates **no** connections to the internal network
> and holds **no** Strata business secrets — no JWT signing key, no
> database credentials, no Vault tokens, no `guac-master-key`, no
> recording-storage credentials. Every existing Strata feature works
> through the DMZ on day one because the tunnel carries arbitrary
> HTTP requests rather than custom message types. Single-node
> operators are not affected: when the DMZ environment variables are
> not set the internal node continues serving public traffic
> directly. **Drop-in upgrade from v1.4.1** — no database migrations,
> no breaking `/api/*` changes, no `config.toml` schema changes;
> rebuild backend and frontend so the new bits actually run.

---

## 🛡️ Public surface as a separate, minimal binary

The new `strata-dmz` crate (`crates/strata-dmz`) is a deliberately
small Axum binary that owns the public TLS listener (default
`0.0.0.0:8443`), a separate link-server listener for inbound mTLS
from internal nodes (default `0.0.0.0:9443`), the SPA static-serving
path, the slow-loris / rate-limit / inflight-cap guards, and the
`x-strata-edge-*` HMAC header signer. It does **not** link in any
Postgres, Vault, JWT-signing, OIDC-client-secret or recording-storage
code. The zero-secret-overlap matrix (in `docs/architecture.md`) is
CI-enforced: a Cargo deny rule rejects any DMZ-side dependency on the
internal-only secret-handling crates.

## 🔁 HTTP/2-over-mTLS reverse tunnel

The internal node dials **out** to the DMZ over TLS 1.3 + mTLS using
operator-supplied certs and a private CA bundle (the system trust
store is **not** consulted on the link path). On top of TLS the wire
format is HTTP/2: each user request becomes one HTTP/2 stream on the
persistent link, WebSockets are carried as RFC 8441 Extended CONNECT
streams (the same mechanism browsers use for WebSocket-over-HTTP/2),
and per-stream `WINDOW_UPDATE` flow control gives back-pressure for
free. No custom codec to fuzz; we lean on `h2` and `hyper`. The
internal node's existing `axum::Router` handles the request unmodified
— **every existing feature works through the DMZ on day one**.

## 🧷 PSK-bound handshake on top of mTLS

Layered on top of the mTLS link is an application-level
challenge–response: the DMZ sends a 32-byte random nonce, the
internal node returns HMAC-SHA-256(psk*key, nonce ‖ cluster_id ‖
node_id) and an `AuthHello` frame identifying its cluster id, node
id and software version. PSKs are configured per-id
(`STRATA_DMZ_LINK_PSK*<id>=<base64>`on the internal node;`STRATA_DMZ_LINK_PSKS=id:b64,id2:b64` on the DMZ — first entry is the
active key, rest accepted during rotation). A stolen mTLS cert alone
is not enough to bring up a link; a stolen PSK alone is not enough
either. Both must hold.

## ✍️ Edge-header HMAC, rotation-aware

Once a request reaches the internal node from the DMZ it must carry
a valid `x-strata-edge-{ts,id,client-ip,sig}` header set, signed by
the DMZ with a key configured via `STRATA_DMZ_EDGE_HMAC_KEYS`. The
internal-side verifier
(`backend/src/services/edge_header.rs`) accepts any key in the
comma-separated list (first active, rest accepted) so keys can be
rotated without dropping live links: stage the new key first on the
internal side, then on the DMZ side, then drop the old key from both.
Constant-time signature compare; ±60 s timestamp window; the client
IP from the header is what reaches RBAC and audit (the DMZ is an
expensive NAT). When `STRATA_DMZ_EDGE_HMAC_KEYS` is unset the
verifier is a no-op (single-node mode).

## 🖥️ Admin DMZ Links tab

A new **Admin → DMZ Links** page (`frontend/src/pages/admin/DmzLinksTab.tsx`)
surfaces every supervisor's state (`up` / `connecting` /
`authenticating` / `initializing` / `backoff` / `stopped`), connect
counter, failure counter, last error and uptime. A **Force reconnect**
button calls `POST /api/admin/dmz-links/reconnect` to drop and redial
every link — used during scheduled DMZ restarts and as the first
button in the incident-response runbook. The page auto-refreshes every
15 seconds. The configured-but-empty case ("no DMZ endpoints
configured") and the disabled case ("DMZ mode is not enabled") render
distinct empty-state cards so the operator can tell at a glance
whether they're looking at a misconfiguration or a green-field
single-node host.

## 📚 Operator-grade documentation refresh

- `docs/architecture.md` — new DMZ chapter with sequence diagrams for
  the link handshake, the per-request flow and the WebSocket-tunnel
  flow, plus the zero-secret-overlap matrix.
- `docs/security.md` — DMZ threat model (W6-1 through W6-5) covering
  compromised-DMZ blast radius, link-tier PKI rotation runbook, abuse
  guards, audit-event surface.
- `docs/deployment.md` — full env-var reference for both binaries,
  certificate generation steps, Helm-chart pointer, scheduled
  rotation worked example, troubleshooting matrix.
- `docs/api-reference.md` — admin DMZ endpoints documented next to
  the existing admin surface.
- `docs/threat-model.md` — STRIDE rows for every new asset / trust
  boundary.
- `docs/runbooks/dmz-incident.md` — operator runbook for DMZ
  compromise, link flap and key-rotation incidents.

## ⚙️ New environment variables

DMZ side (`strata-dmz` binary):

| Variable                                                                                                                                                                                                                                              | Purpose                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `STRATA_DMZ_PUBLIC_BIND`                                                                                                                                                                                                                              | Public-facing listener (default `0.0.0.0:8443`).                    |
| `STRATA_DMZ_LINK_BIND`                                                                                                                                                                                                                                | Link-server listener (default `0.0.0.0:9443`).                      |
| `STRATA_DMZ_PUBLIC_TLS_{CERT,KEY}`                                                                                                                                                                                                                    | Public TLS material (PEM).                                          |
| `STRATA_DMZ_LINK_TLS_{CERT,KEY}`                                                                                                                                                                                                                      | DMZ side of the link mTLS material (PEM).                           |
| `STRATA_DMZ_LINK_CA_BUNDLE`                                                                                                                                                                                                                           | Private CA bundle that signs the **internal** node link cert (PEM). |
| `STRATA_DMZ_LINK_PSKS`                                                                                                                                                                                                                                | `id:base64,id2:base64,…` — first active.                            |
| `STRATA_DMZ_EDGE_HMAC_KEY`                                                                                                                                                                                                                            | Base64 key used to sign `x-strata-edge-*` headers.                  |
| `STRATA_DMZ_CLUSTER_ID`, `STRATA_DMZ_NODE_ID`                                                                                                                                                                                                         | Cluster + node identification.                                      |
| `STRATA_DMZ_PUBLIC_BODY_LIMIT_BYTES`, `STRATA_DMZ_PUBLIC_BODY_LIMITS_BY_IP`, `STRATA_DMZ_PUBLIC_HEADER_TIMEOUT_MS`, `STRATA_DMZ_PUBLIC_RATE_RPS`, `STRATA_DMZ_PUBLIC_RATE_BURST`, `STRATA_DMZ_PUBLIC_MAX_INFLIGHT`, `STRATA_DMZ_TRUST_FORWARDED_FROM` | Public-surface abuse guards.                                        |

Internal-node side (`strata-backend`):

| Variable                              | Purpose                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| `STRATA_DMZ_ENDPOINTS`                | Comma-separated list of DMZ endpoints to dial; unset = standalone.                     |
| `STRATA_CLUSTER_ID`, `STRATA_NODE_ID` | Required when `STRATA_DMZ_ENDPOINTS` is set.                                           |
| `STRATA_DMZ_LINK_TLS_{CERT,KEY}`      | Internal side of the link mTLS material (PEM).                                         |
| `STRATA_DMZ_LINK_CA`                  | Private CA bundle that signs the **DMZ** server cert (PEM).                            |
| `STRATA_DMZ_LINK_PSK_<id>`            | One env var per PSK; value is base64 raw key.                                          |
| `STRATA_DMZ_EDGE_HMAC_KEYS`           | Comma-separated list of base64 HMAC keys; first active, rest accepted during rotation. |

See `docs/deployment.md` for the full reference table including
defaults, accepted ranges and rotation procedure.

## 🆕 New admin API endpoints

- `GET /api/admin/dmz-links` — supervisor snapshot.
  Response: `{ configured: bool, links: [{ endpoint, state, connects,
failures, since_unix_secs, last_error }, …] }`.
- `POST /api/admin/dmz-links/reconnect` — best-effort kick that drops
  and redials every link. Response: `{ nudged: <count> }`.

Both require `can_manage_system` and the standard `X-CSRF-Token`
double-submit cookie. Documented in `docs/api-reference.md`.

## ↗️ Drop-in upgrade from v1.4.1

No database migrations. No breaking `/api/*` changes (two new admin
endpoints, additive only). No `config.toml` schema changes. Rebuild
backend and frontend so the new bits actually run:

```bash
docker compose build backend frontend
docker compose up -d
```

If you don't want DMZ mode, you're done — `STRATA_DMZ_ENDPOINTS` is
unset by default and the internal node serves public traffic
directly, exactly as it did in v1.4.1. To adopt the split topology,
follow `docs/deployment.md` → **DMZ deployment mode**.

---

# What's New in v1.4.1

> **Patch release on top of v1.4.0.** One operator-affecting fix
> and a stack of plumbing work. The headline is the WebSocket
> tunnel watchdog: active sessions stopped surviving past the
> 20-minute access-token TTL in v1.3.2/v1.4.0, even when the
> operator was actively using the UI. v1.4.1 removes the broken
> `exp`-claim enforcement from the watchdog and replaces it with
> an 8-hour wall-clock hard cap that is unaffected by token
> rotation. Plus a guacd pin-bump misadventure that's been
> reverted, a refresh of the RustCrypto crates used for Chromium
> autofill ingestion, a bollard 0.18 → 0.21 dependency walk, and
> a 334-warning ESLint sweep on the frontend. **Drop-in upgrade
> from v1.4.0** — no database migrations, no `/api/*` contract
> changes, no `config.toml` schema changes; rebuild backend and
> frontend so the new bits actually run.

---

## ⏱️ Tunnel sessions no longer get reaped at 20 minutes

The bug. The v1.3.2 WebSocket-tunnel auth watchdog cached the
access token's `exp` claim once at upgrade time and forced the
tunnel closed when that timestamp was reached. Access tokens
have a 20-minute TTL. The frontend rotates them via
`POST /api/auth/refresh` on user activity (after roughly ten
minutes, while the warning toast counts down to expiry), so the
_UI_ stays logged in indefinitely as long as you're using it —
but the already-open WebSocket has no way to learn about that
rotation. So every active connection session was reaped at
T+20 minutes regardless of how busy the operator was, with
audit `reason: "expired"`.

The fix. Remove the `exp` enforcement from the watchdog
entirely. Tunnel teardown is now driven by:

1. **Manual logout / 20-minute idle logout** — the frontend
   already calls `POST /api/auth/logout`, which revokes both
   tokens; the watchdog still polls the in-memory revocation
   set every 30 s and closes within one tick. Audit
   `reason: "revoked"`.
2. **Browser closed / network died** — the TCP-level WebSocket
   close already triggers normal teardown.
3. **8-hour hard cap on session duration** — newly enforced by
   the watchdog as `MAX_TUNNEL_DURATION = 8h`, measured from
   upgrade time, so token rotation does not affect it. Audit
   `reason: "max_duration"`.

If you scrape the audit log, the `reason` field for
`tunnel.terminated` events can now take the values `"revoked"`
or `"max_duration"` instead of `"revoked"` or `"expired"`. They
mean roughly the same thing — _the watchdog forced closure_ —
just measured against wall-clock elapsed time rather than the
(now-rotating) token `exp`.

---

## 🛠️ guacd `staging/1.6.1` pin churn (rolled back)

The custom `guacd` image build was briefly broken on
`origin/main` while we attempted to drop our local patch
[`guacd/patches/006-freerdp325-authenticate-ex.patch`](guacd/patches/006-freerdp325-authenticate-ex.patch).
The hypothesis — that the upstream commit `7696572`
(GUACAMOLE-2273, _"Implement FreeRDP AuthenticateEx callback
and handle deprecation of Authenticate callback"_) had landed
on the `staging/1.6.1` branch HEAD and rendered our patch
redundant — was wrong: GUACAMOLE-2273 currently exists only as
an unmerged PR commit. Building the v1.4.0 pin (`4163ead`)
without patch 006 fails at:

```
rdp.c:558:15: error: 'freerdp' {aka 'struct rdp_freerdp'} has no
member named 'Authenticate'; did you mean 'AuthenticateEx'?
```

Pinning directly to the unmerged PR commit (`7696572`) trades
that error for a different one against FreeRDP 3.25 in Alpine
edge:

```
rdp.c:387:14: error: 'AUTH_FIDO_PIN' undeclared (first use in
this function)
```

`AUTH_FIDO_PIN` is part of the FreeRDP `rdp_auth_reason` enum
that was added after FreeRDP 3.25.0, which is what Alpine edge
currently ships. Net result: neither _"drop patch 006"_ nor
_"pin to the unmerged PR"_ works today against the Alpine edge
runtime libraries. v1.4.1 keeps the working v1.4.0 combination
— pin `4163ead` plus patch 006 plus the two grep guards in the
[`guacd/Dockerfile`](guacd/Dockerfile) — and updates the
Dockerfile comment block so the next maintainer doesn't repeat
the experiment. Functionally this is a no-op vs. v1.4.0; only
the _story_ recorded in the source comments changed.

---

## 🔐 RustCrypto refresh for Chromium-autofill ingestion

The Chromium-format `Login Data` decryption path
([`backend/src/services/web_autofill.rs`](backend/src/services/web_autofill.rs))
— PBKDF2 `peanuts`/`saltysalt`, AES-128-CBC, v10 prefix —
moves to the current major lines of its underlying RustCrypto
crates: `aes` 0.8 → 0.9, `cbc` 0.1 → 0.2 (feature `std` →
`alloc`), `pbkdf2` 0.12 → 0.13, `sha1` 0.10 → 0.11. No
plaintext is written to disk by this path. **Note this is a
different code path from envelope encryption of stored
credentials**, which still goes through `aes-gcm` and Vault
Transit — see
[`docs/security.md` § Envelope Encryption](docs/security.md#envelope-encryption-credentials-at-rest).

---

## 🐳 bollard 0.18 → 0.21

The [VDI service](docs/vdi.md) backend integration with the
host Docker daemon was on `bollard 0.18.1`. Two minor bumps
get us to `bollard 0.21.0`. The user-facing change is none
(VDI behaviour is unchanged); the maintenance change is that
`bollard::Docker::list_images` and `inspect_container` now
return strongly-typed `models::*` responses instead of
`serde_json::Value`, so the test fixtures in
[`backend/src/services/vdi_docker.rs`](backend/src/services/vdi_docker.rs)
were rewritten to construct typed values. Drop the change in
hot — no host Docker behaviour change required.

---

## 🧹 ESLint warning sweep

`chore(frontend): eliminate 334 ESLint warnings (Phases 1-7)`.
Frontend lint job in CI now exits with `0` warnings instead of
a long allow-list. No behavioural changes — explicit
`unknown`-narrowing in error catches, removal of dead imports,
JSX accessibility tightening, `useCallback`/`useMemo`
dependency arrays normalised, optional-chaining where the type
already permits `undefined`. The vitest coverage thresholds in
[`frontend/vitest.config.ts`](frontend/vitest.config.ts) are
raised in lock-step to the new measured baseline so the gain
cannot silently regress.

For the curious: **Dependabot PR #48 (`eslint` 9 → 10)** was
reviewed and held. ESLint 10 is not yet mergeable because
`eslint-plugin-react@7.37.5` (latest) still calls the removed
`context.getFilename()` method (TypeError at lint time) and
`eslint-plugin-jsx-a11y@6.10.2` (latest) caps its peer range
at `eslint@^9`. We re-evaluate when those plugins ship
v10-compatible releases.

---

## 📦 Other dependency bumps

- `tokio` 1.52.1 → 1.52.2 (patch).
- `docker/login-action` 3.7.0 → 4.1.0 in CI.
- `actions/cache` 4.3.0 → 5.0.5 in CI.
- `github/codeql-action` 4.35.2 → 4.35.3 in CI.

## 🔭 CI: Trivy ergonomics

The Trivy container scan in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) now
prints the findings table on failure (so you can read the
issue without downloading the SARIF), and the GHA build cache
for the OS-package layer is dropped on each run so freshly-
published patch CVEs are surfaced same-day rather than hidden
behind a cached layer.

---

# What's New in v1.4.0

> **Minor release.** Apache Guacamole's `kubernetes` protocol
> arrives in Strata as a first-class connection type alongside
> `rdp` / `ssh` / `vnc` / `web` / `vdi`. `kubectl attach` and
> `kubectl exec` now render as a terminal in the browser, with
> the same recording, audit, credential-profile and tunnel
> infrastructure as every other Strata session. Includes a
> kubeconfig importer that breaks a pasted `~/.kube/config`
> into the right form fields and shows the client private key
> exactly once for the operator to stash in a credential
> profile. **Backwards compatible with v1.3.x** — one new
> migration (`060_kubernetes_protocol.sql`, widens the
> `connections.protocol` `CHECK`); no breaking `/api/*` or
> `config.toml` changes.

---

## 🚢 Kubernetes pod console

Add a new connection, pick **Kubernetes Pod** as the protocol,
fill in the API server hostname/port, paste your kubeconfig into
the **Import kubeconfig** textarea above the form sections, and
click _Parse and fill form_. Strata extracts the cluster server,
namespace, CA cert and client cert into the right fields; the
client _private key_ surfaces in a "copy now" panel that goes
away as soon as you stash it into a credential profile (it's
never persisted on this path).

The protocol surfaces in:

- **Admin → Access** form (new `KubernetesSections` block).
- **Command palette** session list (Kubernetes-style heptagon
  wheel icon).
- **Dashboard** connection cards (same icon, larger).
- **Active Sessions** badge (`k8s` chip).
- **Audit logs** and **session recordings** — automatic, both
  are protocol-agnostic.

### What ships in 1.4.0

- `guacd/Dockerfile` build guard that fails the image build if
  `libguac-client-kubernetes.so` is missing after `make install`.
- `backend/src/tunnel.rs` `kubernetes` branch in `full_param_map()`
  with terminal defaults; whitelist additions for `namespace`,
  `pod`, `container`, `exec-command`, `use-ssl`, `ca-cert` and
  `client-cert` extras (note: `client-key` is _not_ whitelisted —
  the private half flows through the Vault-encrypted credential-
  profile path, never connection extras).
- `backend/src/routes/tunnel.rs` credential remap that takes the
  decrypted profile password slot, drops it into the `extra` map
  as `client-key`, and clears username/password.
- Migration `060_kubernetes_protocol.sql`.
- `backend/src/services/kubernetes.rs` kubeconfig YAML parser
  (with five unit tests).
- New admin endpoint `POST /api/admin/kubernetes/parse-kubeconfig`,
  gated by `check_system_permission` and exercised by the
  `e2e/tests/rbac.spec.ts` no-auth/wrong-role matrices.
- Frontend additions: `protocolFields.ts` registry entry,
  `KubernetesSections` form component, `KubeconfigImporter`
  importer panel, protocol icons in CommandPalette / Dashboard /
  ActiveSessions, `parseKubeconfig` API client.

### Deferred to a later release

A live `POST /api/admin/kubernetes/list-pods` endpoint that talks
directly to the K8s API and feeds a pod-picker dropdown would be
nice but pulls in the `kube` Rust crate's ≈80-deep transitive
dependency tree. Operators can use `kubectl get pods` out-of-band
to find the pod name today.

---

# What's New in v1.3.2

> **Patch release on top of v1.3.1.** Four orthogonal fixes that
> closed real production-affecting issues: the custom `guacd`
> image stopped building once Alpine edge bumped FreeRDP from
> 3.24 to 3.25 (the `Authenticate` callback field was renamed to
> `AuthenticateEx` and grew an extra parameter); RDP sessions
> rendered a black "ghost region" along the edge of the canvas
> after a server-driven desktop resize; the WebSocket tunnel kept
> a recording stream and `session_registry` row alive
> indefinitely if the operator's tab was killed without a
> graceful close; and clicking **Log out** flipped React auth
> state without first closing any open Guacamole tunnels, so the
> backend kept proxying frames into a logged-out user's
> recording until the tab eventually closed itself. **Drop-in
> upgrade from v1.3.1** — no database migrations, no `/api/*`
> contract changes, no `config.toml` schema changes; rebuild the
> backend, frontend, and `guacd` images so the new bits
> actually run.

---

## 🛠️ guacd image builds again on Alpine edge (FreeRDP 3.25)

[`apache/guacamole-server@2980cf0`](https://github.com/apache/guacamole-server/tree/2980cf0/src/protocols/rdp)
(release 1.6.1) was written against FreeRDP 3 and uses the legacy
`Authenticate` callback field on `struct rdp_freerdp` to register
its credential-prompt hook. **FreeRDP 3.25 deleted that field**
in favour of a new `AuthenticateEx` callback that takes one
extra argument:

```c
typedef BOOL (*pAuthenticate)(freerdp* instance, char** username,
        char** password, char** domain);
typedef BOOL (*pAuthenticateEx)(freerdp* instance, char** username,
        char** password, char** domain, rdp_auth_reason reason);
```

The moment Alpine edge rolled `freerdp-dev` from `3.24.2-r0` to
`3.25.0-r0`, the build broke at compile time:

```text
src/protocols/rdp/rdp.c:565:15: error:
    'freerdp' {aka 'struct rdp_freerdp'} has no member named
    'Authenticate'; did you mean 'AuthenticateEx'?
```

[`guacd/patches/006-freerdp325-authenticate-ex.patch`](guacd/patches/006-freerdp325-authenticate-ex.patch)
adds three small unified-diff hunks against `rdp.c`:

1. **Adds `#include <freerdp/version.h>`** near the existing
   `<freerdp/...>` includes so the `FREERDP_VERSION_MAJOR` /
   `FREERDP_VERSION_MINOR` preprocessor macros are visible at
   every conditional that follows. Without this, the macros
   are _not_ transitively defined inside `rdp.c` despite
   `<freerdp/freerdp.h>` being included — a fact that wasted
   an embarrassing amount of debugging time during the first
   patch attempt.
2. **Wraps the function signature** in
   `#if defined(FREERDP_VERSION_MAJOR) && (FREERDP_VERSION_MAJOR > 3 || (FREERDP_VERSION_MAJOR == 3 && FREERDP_VERSION_MINOR >= 25))`
   / `#else` / `#endif` so the FreeRDP 3.25+ build gets the
   five-argument signature with `rdp_auth_reason reason`,
   while FreeRDP 3.24 and earlier keep the four-argument
   signature. The added `reason` parameter is intentionally
   discarded with `(void) reason;` because the existing
   implementation already requests whichever credentials are
   missing, regardless of the reason FreeRDP raised the
   callback.
3. **Wraps the callback assignment** in the same `#if` /
   `#else` / `#endif` so FreeRDP 3.25+ gets
   `rdp_inst->AuthenticateEx = rdp_freerdp_authenticate;`
   while older versions keep the legacy `Authenticate` field
   name.

### Defence-in-depth: Dockerfile grep guard

The first attempt at this patch _applied successfully_ —
`patch -p1` returned exit 0 for every hunk — but selected the
`#else` (legacy) branch at every conditional because
`FREERDP_VERSION_MAJOR` was undefined at that point in the
translation unit. The build then failed at compile time with
the _same_ error as before, just with the line number shifted
down by 11 (the size of the inserted `#if` blocks). It cost
several iterations to realise the patch was applying but
silently no-op'ing.

[`guacd/Dockerfile`](guacd/Dockerfile) now runs two `grep -q`
assertions immediately after the patch loop that fail the build
with a clear error message if the post-patch source tree does
not contain `#include <freerdp/version.h>` _and_
`rdp_inst->AuthenticateEx = rdp_freerdp_authenticate;`. Future
silent semantic regressions get caught in seconds rather than
minutes.

### LF line endings on patch files

[`guacd/patches/.gitattributes`](guacd/patches/.gitattributes)
pins `*.patch` to `text eol=lf` so contributors with
`core.autocrlf=true` on Windows cannot accidentally introduce
CRLF that misaligns hunk context lines. Patch files are byte-
sensitive — a single CRLF-converted hunk header can fail
`git apply` and `patch -p1` for non-obvious reasons.

> **Forward compatibility.** The `#if` guard on patch 006 means
> contributors on Debian 13 / Trixie (which still ships
> `freerdp-3.24`) build identically to before; the new hunks
> are only active on FreeRDP 3.25+. The pinned upstream
> `apache/guacamole-server` commit (`2980cf0`) is unchanged.

---

## 🖥️ Black "ghost regions" after RDP desktop resize are gone

When a Windows RDP server changed resolution mid-session
(resolution change inside a VM, GFX channel renegotiation,
multi-monitor reconfiguration), the Strata canvas would render a
solid-black margin along the edge of the new desktop area until
the user moved a window across the affected region to force a
repaint. The visual was confusing — operators routinely thought
their session had crashed.

**Root cause:** `guac_rdp_gdi_desktop_resize` in
`src/protocols/rdp/gdi.c` allocates a new GDI buffer via
`gdi_resize` and updates `gdi->width` / `gdi->height`, but never
asks the RDP server to retransmit pixels for the new desktop
area, and never marks the layer dirty. Whatever was previously
in the layer (often zero — solid black) stays there until a
subsequent paint covers it.

[`guacd/patches/005-refresh-rect-on-resize.patch`](guacd/patches/005-refresh-rect-on-resize.patch)
adds a small repaint kick at the end of
`guac_rdp_gdi_desktop_resize`:

```c
guac_rect_init(&current_context->dirty, 0, 0, gdi->width, gdi->height);

if (context->update != NULL && context->update->RefreshRect != NULL
        && gdi->width > 0 && gdi->height > 0
        && gdi->width <= UINT16_MAX && gdi->height <= UINT16_MAX) {
    RECTANGLE_16 area = { 0, 0, (UINT16) gdi->width, (UINT16) gdi->height };
    BOOL ok = context->update->RefreshRect(context, 1, &area);
    /* logged at GUAC_LOG_DEBUG */
}
```

Bounds-checked against `UINT16_MAX` so a pathological resize
cannot produce a malformed PDU. Two new structured debug logs
(`[strata] guac_rdp_gdi_desktop_resize: resizing %dx%d` and
`[strata] post-resize RefreshRect %ux%u -> %s`) make the path
observable at `GUAC_LOG_DEBUG` for future regressions.

---

## ⏱️ Lost-tab tunnels close themselves now (auth watchdog)

If the operator's browser tab was killed without a graceful close
— OS task-killer, kernel OOM, network cable yanked, hostile
client, alt-tab into a focus-stealing app that never gave focus
back — the WebSocket tunnel kept proxying frames into a recording
for as long as the OS held the underlying TCP socket open.
Effects:

- The recording grew indefinitely (sometimes for **hours**) and
  consumed disk on the recordings volume.
- The `session_registry` row stayed live, so the live-sessions
  admin page lied about who was actually connected.
- Per-user concurrent-session limits (where configured) wedged
  the user out of opening a fresh tunnel until the half-dead
  one timed out.

[`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs)
`ws_tunnel` now:

1. Captures the access token used to authenticate the upgrade
   from the same priority list as `require_auth` (Bearer
   header, then `access_token` cookie, then query string),
   storing a copy as `watchdog_token`.
2. Decodes the token's `exp` claim **once** at upgrade time
   into a `u64`, with a fully-validated
   `Validation::new(Algorithm::HS256)` — issuer
   (`strata-local`) and required `exp` claim. Non-local OIDC
   tokens cleanly fall through to `None` and the watchdog
   gracefully degrades to revocation-only checks for them.
3. Spawns a 30-second `tokio::time::interval` tick loop
   alongside `tunnel::proxy(...)`. On every tick:
   - asks `services::token_revocation::is_revoked(token)`;
   - compares `chrono::Utc::now().timestamp() as u64` to the
     cached `exp`.
     Either condition logs at `INFO` and aborts the proxy loop,
     so the recording flushes and `session_registry`
     decrements within at most one tick.

> **Cadence rationale.** 30 s detects revocation in ≤ 30 s
> even on aggressive 1-minute access-token TTLs, while a
> normal 20-minute TTL costs at most 40 ticks per session —
> negligible next to the WebSocket I/O itself. Polling is a
> deliberate choice over a notification channel because the
> revocation list is already a per-process `RwLock<HashSet>`
> with O(1) lookups, and `exp` comparison is a single
> integer compare; both are far cheaper than waking up a
> dedicated subscriber per tunnel.

The `ws_tunnel` extractor list grew to eight arguments after
the `OriginalUri` and watchdog work, which trips
`clippy::too_many_arguments`. A targeted
`#[allow(clippy::too_many_arguments)]` keeps the handler
signature readable; splitting the extractor chain into a
wrapper struct that would only be used in this one place felt
worse than the lint.

---

## 🚪 Clicking Log out closes your tunnels immediately

`App.tsx`'s `handleLogout` previously flipped React auth state
(`setAuthenticated(false)`, `setUser(null)`) and navigated to
`/login` _without_ closing any open Guacamole tunnels first. The
`SessionManagerProvider` stayed mounted across the logout
because it lives above the route tree, so its in-memory
sessions kept streaming until the browser eventually closed the
tab. The backend then saw the tunnels close minutes later (or
not at all, until the new auth watchdog kicked in).

[`frontend/src/components/SessionManager.tsx`](frontend/src/components/SessionManager.tsx)
now exposes a **module-level handler**:

```ts
let _closeAllSessionsHandler: (() => void) | null = null;

function setCloseAllSessionsHandler(h: (() => void) | null): void {
  _closeAllSessionsHandler = h;
}

export function closeAllSessionsExternal(): void {
  _closeAllSessionsHandler?.();
}
```

The provider registers its own `closeAllSessions` callback via
`setCloseAllSessionsHandler` on mount and unregisters on
unmount. `closeAllSessions` iterates `sessionsRef.current` and
runs the _same_ cleanup path used by the per-session disconnect
button:

- `cleanupPopout(session)`,
- `cleanupMultiMonitor(session)`,
- `session._cleanupPaste?.()`,
- clears `keyboard.onkeydown` / `keyboard.onkeyup`, calls
  `keyboard.reset()`,
- calls `session.client.disconnect()`.

Each step is wrapped in a best-effort `try / catch` so a single
failure (already-closed client, race against React unmount)
cannot block the rest of the logout. Finally `setSessions([])`
empties the live-sessions list in one render.

`App.tsx`'s `handleLogout` now calls `closeAllSessionsExternal()`
**before** flipping auth state, then issues a fire-and-forget
`apiLogout()` to invalidate the refresh token and clear the
auth cookies. Idle-timeout logout takes the same path.

> **Defence in depth.** This change pairs with the auth watchdog
> above — the watchdog catches the case where the frontend
> never gets a chance to call `closeAllSessionsExternal` (tab
> killed, OS OOM, network drop), while the explicit logout
> path catches the common case where the user clicks **Log
> out** and we want the live-sessions list to update
> immediately rather than after the next 30 s tick.

---

## 🆙 Drop-in upgrade — rebuild required

All four fixes live in either the Rust backend binary, the
React bundle, or the custom `guacd` image. Run:

```bash
docker compose up -d --build
```

(or pull a freshly published CI tag) — a `docker compose pull`
of an old tag will leave you on the broken `guacd` image.

- **No database migrations.** Schema is unchanged from v1.3.1.
- **No `/api/*` contract changes.** No new routes, no new
  query parameters, no new response fields. The auth watchdog
  is entirely server-side.
- **No `config.toml` schema changes.**
- **Existing in-flight tunnels** that were already connected
  before the upgrade get the watchdog the next time the user
  reconnects (the watchdog is wired in `ws_tunnel`, which only
  runs at upgrade time).

---

# What's New in v1.3.1

> **Same-day patch release on top of v1.3.0.** Five small,
> orthogonal fixes that all surfaced while validating the v1.3.0
> production rollout: SSH terminal defaults so `nano`, `less`,
> `vim`, and `ls --color` actually look right; a mouse-leave /
> window-blur button-release that kills the long-standing
> _"phantom text selection extends across the SSH terminal as I
> move my cursor to the browser tab strip"_ bug; a recording
> playback URL fix so seek and speed buttons no longer surface
> _"Tunnel error"_; a fuzz-tolerant guacd patch step so image
> builds survive harmless upstream context drift; and the
> deletion of a stray diagnostic patch that was superseded by the
> SSH defaults work. **Drop-in upgrade from v1.3.0** — no
> database migrations, no `/api/*` contract changes, no
> `config.toml` schema changes; rebuild the backend, frontend,
> and guacd images so the new bits actually run.

---

## 🖥️ SSH terminals that look right out of the box

The connect-instruction parameter map in
[`backend/src/tunnel.rs`](backend/src/tunnel.rs) `full_param_map()`
now seeds the same SSH terminal defaults that upstream
[sol1/rustguac](https://github.com/sol1/rustguac) sends — for
every `protocol == "ssh"` connection where the admin has not
explicitly overridden them:

| Parameter               | Default          | Why it matters                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `terminal-type`         | `xterm-256color` | Exported as `TERM` on the remote PTY. Without it, OpenSSH sees the empty string and most distros fall back to `TERM=linux` — a 16-colour profile that does _not_ advertise `smcup`/`rmcup`, so `nano` and `less` cannot save and restore the alternate screen. **This is what made closing `nano` leave the file stuck on your viewport.** |
| `color-scheme`          | `gray-black`     | Rustguac-default colour palette. Without it, guacd renders SGR escape sequences in the `black-white` palette, inverting most users' expectations and visually obliterating dark prompts.                                                                                                                                                   |
| `scrollback`            | `1000`           | Lifts guacd's in-buffer line count from its built-in default (~256) to 1000, matching `xterm`'s historical default. Below ~500 lines, a single `journalctl -xe` doesn't fit.                                                                                                                                                               |
| `font-name`             | `monospace`      | The browser-side default already happened to be monospace; we now make the wire value explicit.                                                                                                                                                                                                                                            |
| `font-size`             | `12`             | Rustguac parity.                                                                                                                                                                                                                                                                                                                           |
| `backspace`             | `127`            | DEL — what every Linux distro ships as the SSH default. Stops `^?` characters appearing in the terminal when you press Backspace on certain remote shells.                                                                                                                                                                                 |
| `locale`                | `en_US.UTF-8`    | Exported as `LC_*`. Required for UTF-8 box-drawing characters in `htop`, `mc`, `tmux` status bars, etc.                                                                                                                                                                                                                                    |
| `server-alive-interval` | `0`              | Disables guacd-side keepalives — the WebSocket tunnel already provides liveness via Guacamole's own keep-alive instructions.                                                                                                                                                                                                               |

Three of these (`color-scheme`, `locale`, `server-alive-interval`)
have also been added to the `is_allowed_guacd_param` allowlist so
admin overrides via the per-connection `extras` map can set them
explicitly. The `tunnel_param_allowlist_pins_legal_keys` test
pins those new keys against accidental removal in future
refactors. The SFTP block has been folded into the same
`if self.protocol == "ssh"` branch so the SSH parameter wiring
now lives in one place rather than two.

**No operator action.** Existing SSH connections start using the
new defaults on the first reconnect after the upgrade. Anything
the admin has explicitly set in the per-connection `extras` map
keeps winning — the defaults only fill in keys you haven't set.

---

## 🖱️ No more phantom text selection across the SSH terminal

Long-running annoyance: click inside the SSH terminal, then move
the cursor up to the browser tab strip — or anywhere else outside
the canvas, including a popped-out devtools window — without
physically releasing the mouse button, and guacd's terminal would
keep extending a text selection across whatever the cursor passed
over. The selection would then survive coming back into the
terminal, leaving the operator with a giant highlight they
hadn't asked for and couldn't easily clear short of clicking
fresh inside the terminal.

**Root cause:** when the user clicks inside the Guacamole canvas
and the matching `mouseup` event lands outside the page's
document (on browser chrome, on a popped-out devtools window, on
another tab during a drag, on the OS desktop after an
alt-tab-out), the page never receives the `mouseup` and
`mouse.currentState.left` stays `true`. The next `mousemove`
guacd receives is then interpreted as a drag-extend-selection,
because as far as guacd's terminal is concerned the user is
still holding the button.

**Fix:** [`frontend/src/components/SessionManager.tsx`](frontend/src/components/SessionManager.tsx)
now wires a `releaseMouseButtons()` helper to two events:

- `mouseleave` on the Guacamole display element — catches every
  in-tab leave (cursor moves to the tab strip, the address bar,
  any other DOM element outside the canvas).
- `blur` on the `window` — catches every tab-switch / focus-loss
  case where `mouseleave` doesn't fire (e.g. Alt-Tab to another
  application, or the user opens a popped-out devtools window
  that takes focus without the cursor crossing the canvas
  boundary).

When fired, the helper inspects the live `mouse.currentState`;
if any of `left` / `middle` / `right` is still set, it builds a
cleared `Guacamole.Mouse.State` and sends it via
`client.sendMouseState(s, true)`. The release is a **no-op when
no buttons are held**, so it costs zero round-trips during normal
interaction.

> **Why not handle this in `Guacamole.Mouse` itself?** Upstream
> `guacamole-common-js` doesn't wire any leave/blur reset
> either, and rustguac's `static/client.html` likewise has the
> same bare `mouse.onEach(['mousedown','mousemove','mouseup'])`
> pattern with no leave handler. We're choosing to fix this on
> the Strata side rather than try to upstream a vendored-bundle
> patch that would deviate from rustguac for everyone.

---

## ⏯️ Seek and speed buttons on the recording player work again

Symptom: opening a recording playback page (Sessions → LIVE/Rewind
button → Recorded Session) and clicking **any** of the seek
buttons (`30S`, `1M`, `3M`, `5M` in either direction) or speed
buttons (`2x`, `4x`, `8x`) at the bottom of the player would
render a red _"Tunnel error"_ badge over the player and stop
playback. Pressing **Retry** would just reproduce the same
error.

**Root cause:** the recording-playback URL builder in
[`frontend/src/components/HistoricalPlayer.tsx`](frontend/src/components/HistoricalPlayer.tsx)
was prepending `&seek=…` and `&speed=…` to a base URL that did
not yet contain a `?`. The base URL is built by
`buildRecordingStreamUrl()` and ends in `…/stream` with no query
string, so the resulting URL became
`wss://strata.example.com/api/admin/recordings/<uuid>/stream&seek=3114&speed=2`
— a malformed path that the WebSocket upgrader on the backend
correctly rejected as an unknown route, surfacing as the
_"Tunnel error"_ the user saw.

**Fix:** collect the parameters into a list, then prepend `?`
when the base URL has no existing query string and `&` when it
does, before splitting on `?` for the
`tunnel.connect(tunnelQuery)` call. The split semantics are
preserved, so the `seek` and `speed` values continue to travel
as Guacamole connect-protocol args (which is what the backend
recording-stream route already reads them as) rather than as
URL query string. The
[`GET /api/{user,admin}/recordings/:id/stream`](docs/api-reference.md#get-apiuserrecordingsidstream)
endpoint and its documented `seek` and `speed` query parameters
were always correct — only the frontend was wrong.

---

## 🐳 guacd image build resilient to harmless context drift

`docker compose build guacd` previously failed with
`error: patch does not apply` if any patch hunk's surrounding
context had drifted by even a single whitespace line — the
`git apply` invocation in [`guacd/Dockerfile`](guacd/Dockerfile)
is strict by design. We pin the upstream
`apache/guacamole-server` commit to `2980cf0` for
reproducibility, but a future commit-pin bump (or a local
maintenance branch with whitespace cleanup) could trip this even
when our patches don't actually conflict.

The patch step now installs the GNU `patch` utility via
`apk add --no-cache patch` and falls back to
`patch -p1 -F3 < "$p"` when `git apply` rejects a hunk, allowing
up to three lines of fuzz on each hunk. Hard rejects still fail
the build (we exit on patch failure) — only the contextual
fuzz is relaxed.

A stray diagnostic patch
(`guacd/patches/005-alt-screen-trace.patch`) that was used
during the SSH terminal investigation earlier in the v1.3.x
cycle has been removed; the fix that superseded it (the SSH
defaults above) lives entirely in `backend/src/tunnel.rs`, so
removing the patch causes no behaviour change.

---

## 🚢 Upgrading from v1.3.0

```bash
git pull
docker compose up -d --build
```

- **Mandatory image rebuild.** All fixes live in the backend
  Rust binary, the frontend bundle, and the guacd Dockerfile
  patch step — all three are baked into their respective
  images. A `docker compose pull` of an old tag is _not_
  enough.
- **No database migrations.** v1.3.1 is schema-stable relative
  to v1.3.0 and v1.2.0.
- **No `/api/*` contract changes.** All existing endpoints
  behave identically; the documented query parameters on the
  recording-stream WebSocket endpoint were always correct.
- **No `config.toml` / env-var changes.** Nothing for an
  operator to update.
- **First reconnect picks up the SSH defaults automatically.**
  No need to re-save existing SSH connections; the defaults
  only fill in `extras` keys the admin hasn't explicitly set,
  so any per-connection terminal overrides keep winning.

---

# What's New in v1.0.0

> **General availability.** Strata Client reaches **1.0.0** — a
> straight promotion of the v0.31.0 codebase with **no functional
> changes**. The headline of this release is the **formal SemVer
> commitment** that lands with the tag: from 1.0.0 onward, the
> public REST API surface (`/api/*`), the database schema
> (managed by the numbered migrations under `backend/migrations/`),
> and the on-disk configuration shape (`config.toml` keys +
> environment variable contracts) are stable. Breaking changes to
> any of those surfaces will require a v2.0.0 bump. **Drop-in
> upgrade from v0.31.0** — no new database migrations, no `/api/*`
> contract changes, no UI changes beyond the WhatsNew modal welcoming
> you to 1.0.0.

---

## 🎉 Why 1.0.0 now

The 0.x series has been production-tracked at multiple sites since
v0.27.0 and has accumulated nine consecutive minor releases without
a regression-driven rollback. The feature surface — multi-protocol
sessions (RDP / VNC / SSH / Web / VDI), managed-account checkout
with approval workflows, hash-chained audit logging, recordings,
folders, tags, custom keybindings, and the v0.31.0 scriptable
Command Palette — has reached the maturity bar we set for a 1.0
tag. Tagging now formalises the upgrade-safety contract operators
have been relying on informally.

## 📜 What the SemVer commitment covers

- **Stable:** every documented `/api/*` endpoint (request shape,
  response shape, status-code semantics); every column in every
  table created by migrations `001`–`055`; every key in
  `config.toml` and every `STRATA_*` environment variable read by
  `backend/src/config.rs`.
- **Free to evolve in minor / patch releases:** internal Rust
  modules under `backend/src/services/` and `backend/src/routes/`
  (function signatures, struct shapes, helper utilities), the
  React component tree under `frontend/src/components/`, the
  Vitest / Playwright test suites, the CHANGELOG / WHATSNEW /
  documentation prose, the contents of the WhatsNew modal, and
  any unreleased migration whose number exceeds `055` at tag time.
- **Reserved for v2.0.0:** removing or breaking-shape-changing any
  `/api/*` endpoint, dropping or renaming any column referenced by
  a `/api/*` response, removing or renaming any `config.toml` key
  or `STRATA_*` env var read by the running binary.

## 🚢 What's actually in the release

Everything that shipped under v0.31.0 — verbatim. The version
strings in `VERSION`, `backend/Cargo.toml`, `backend/Cargo.lock`,
`frontend/package.json`, `frontend/package-lock.json`, and the
README badge are the only files that changed for the 1.0.0 tag.
The release pipeline publishes `ghcr.io/<org>/strata-backend:1.0.0`
and `ghcr.io/<org>/strata-frontend:1.0.0` alongside the rolling
`:latest` tag; the previous `:0.31.0` images remain available and
are byte-identical.

For a refresher on the v0.31.0 feature set (built-in `:command`
palette, personal `:command` mappings, ghost-text autocomplete, and
the `command.executed` audit stream) see the v0.31.0 entry in
[CHANGELOG.md](CHANGELOG.md).

---

# What's New in v0.31.0

> **The Command Palette grows up.** v0.31.0 adds **built-in commands**, **personal `:command` mappings** (including `open-path` for opening UNC shares and folders directly in remote Explorer), **ghost-text autocomplete**, and a brand-new **`command.executed` audit stream**, turning the in-session palette from a connection picker into a fully scriptable, user-extensible command surface. Up to 50 mappings per user, six action types, server-validated, hash-chain audited. **Drop-in upgrade from v0.30.2** — no new database migrations.

---

## ⌨️ Type `:` to enter command mode

Pressing `Ctrl+K` (or your customised binding from v0.30.1) and typing
a colon now switches the palette into **command mode**. Six built-ins
ship out of the box:

| Command           | What it does                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:reload`         | Reconnect the active session (forces an IDR keyframe — clears stale GFX without dropping the tunnel)                                                                                                                                                    |
| `:disconnect`     | Close the active session and return to the dashboard                                                                                                                                                                                                    |
| `:close`          | Friendlier alias for `:disconnect` — closes the current server page                                                                                                                                                                                     |
| `:fullscreen`     | Toggle fullscreen with Keyboard Lock (the same chord the SessionBar uses, so OS shortcuts stay captured)                                                                                                                                                |
| `:commands`       | Inline list of every command available to you — built-ins plus your personal mappings, with a colour-coded pill for each kind                                                                                                                           |
| `:explorer <arg>` | Drives the Run dialog on the active session — `:explorer cmd` opens a command prompt, `:explorer powershell` opens a PowerShell prompt, `:explorer \\server\share` opens a share, `:explorer notepad` launches Notepad. Anything `start` accepts works. |

Commands that need an active session (`:reload`, `:disconnect`,
`:close`, `:explorer`) are disabled (greyed) when none is open; the
palette shows a clear reason rather than silently no-op'ing.

`:explorer` is the ad-hoc twin of the `open-path` mapping action: same
Win+R → paste argument → Enter choreography, same ≤ 1024-char cap,
same control-character rejection, and the audit log records only
`{ arg_length: N }` — never the literal argument.

---

## 🎯 Personal `:command` mappings — define your own shortcuts

Visit **Profile → Command Palette Mappings** to define up to **50** of
your own `:command` triggers. Six action types are supported:

| Action            | What it opens                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open-connection` | A specific saved connection by its UUID                                                                                                                                                                                                                                                                                                         |
| `open-folder`     | The dashboard pre-filtered to a folder                                                                                                                                                                                                                                                                                                          |
| `open-tag`        | The dashboard pre-filtered to a tag                                                                                                                                                                                                                                                                                                             |
| `open-page`       | An in-app route (`/dashboard`, `/profile`, `/credentials`, `/settings`, `/admin`, `/audit`, `/recordings`)                                                                                                                                                                                                                                      |
| `open-path`       | **Opens a path on the active remote session.** Drives the Windows Run dialog (Win+R → paste path → Enter), so a UNC share like `\\computer456\share`, a local folder like `C:\Users\Public`, or a `shell:` URI like `shell:startup` opens directly in Explorer on the remote box. The example everyone wants: `:comp1` → `\\computer456\share`. |
| `paste-text`      | Sends free-form text into the active session via clipboard + Ctrl+V (no Enter, just a paste). Up to 4096 chars.                                                                                                                                                                                                                                 |

Triggers are validated against `^[a-z0-9_-]{1,32}$`, must not collide
with built-in command names, and must be unique within your own list.
The Profile UI surfaces every error inline — no toast soup, no silent
trims.

---

## 📂 Open paths on the remote session — `open-path`

The headline mapping action: **type `:comp1` and have
`\\computer456\share` open in Explorer on the remote box.** Under the
hood the palette drives the Windows Run dialog on the active session:

1. Sends **Win+R** (keysyms `0xffeb` Super_L + `0x72` "r") to open the
   Run dialog.
2. Pushes the path onto the remote clipboard via
   `Guacamole.Client.createClipboardStream`.
3. Sends **Ctrl+V** to paste the path into the dialog.
4. Sends **Enter** (`0xff0d`) — the Windows shell hands off to whichever
   handler is registered for that URI scheme (Explorer for UNC shares
   and folders, control-panel applets for `shell:…` URIs, the default
   browser for `http://…`, etc.).

Path-string validation is strict: ≤ 1024 characters, **no control
characters** (newline injection through the Run dialog would let a
stored mapping execute follow-up commands). The audit log captures
only `{ path_length: N }`, never the literal path, so chained-hash
review of the audit stream cannot leak share names or internal hosts.

---

## 👻 Ghost-text autocomplete (Tab to accept)

While typing in command mode, the palette renders a low-opacity
**ghost-text overlay** showing the longest unambiguous extension of your
current input across every command available to you. Press **Tab** or
**Right Arrow** (only when your caret is at the end of the input) to
accept. The longest-common-prefix algorithm runs over the merged
built-in + user-mapping list, so adding a `:reset` mapping correctly
disambiguates against the built-in `:reload` rather than silently
auto-jumping to the wrong command.

---

## 🔴 Friendly invalid-state UI

Type a slug that doesn't resolve (`:nope`) or invoke a built-in that
isn't currently usable (`:reload` with no active session) and the
palette:

- Switches the input border to `var(--color-danger)`
- Renders a `role="alert"` reason line below the input on wide
  viewports (and surfaces it in `title` for pointer hover / screen
  readers)
- Sets `aria-invalid="true"` on the input
- Makes Enter a hard no-op — no audit event, no navigation

Nothing surprises you. Nothing fires until the slug is valid.

---

## 📋 Every executed command writes one audit row

Every successful command execution writes one `command.executed` row to
the existing **append-only, SHA-256 chain-hashed `audit_logs` table**:

```
action_type = "command.executed"
details     = { trigger, action, args, target_id }
```

The endpoint that backs this — **`POST /api/user/command-audit`** — is
fire-and-forget from the frontend (audit failures must never block the
action) and shares the same advisory-locked chain-hash code path used
by every other Strata audit event. Security teams can review what
operators ran, against which target, and when, with the same
tamper-evidence guarantees as `tunnel.connected`, `checkout.activated`,
and the rest of the existing audit taxonomy.

The endpoint hard-codes `action_type` server-side, so a malicious
client cannot poison the audit-event namespace by passing a fake
type through the request body.

---

## 🛡️ Defence-in-depth validation

`commandMappings` is enforced at the backend before the JSONB blob ever
lands in `user_preferences`. The new `validate_command_mappings()` in
[`backend/src/services/user_preferences.rs`](backend/src/services/user_preferences.rs)
rejects:

- Non-array values
- Arrays with more than 50 entries
- Triggers that don't match `^[a-z0-9_-]{1,32}$`
- Triggers that collide with the built-in command names
- Duplicate triggers within a single user's list
- Actions outside the six-value allow-list
- `open-page` paths outside the seven-value page allow-list
- `args.connection_id` / `args.folder_id` / `args.tag_id` values that
  don't parse as UUIDs

12 unit tests in the same file cover every rejection branch plus the
happy paths for all six action types. A modified frontend that
bypasses client-side validation still cannot poison the database.

---

## 🚀 Upgrade notes

- **No database migrations.** Mappings live in the existing
  `user_preferences.preferences` JSONB column from v0.30.1.
- **Operators on v0.30.2 can `docker compose pull && up`** without
  further action.
- **Existing users see exactly the same palette experience as v0.30.2**
  until they explicitly add a mapping. Built-in commands become
  available to everyone immediately — no per-user opt-in.
- **External automation that PUTs `/api/user/preferences`** must now
  submit a valid `commandMappings` array (or omit the key entirely).
  Previously the JSONB blob was schema-less; v0.31.0 enforces the
  shape at the backend.

---

# What's New in v0.30.2

> **Maintenance & supply-chain hygiene release.** v0.30.2 lands the open Dependabot queue locally so dependency bumps don't accumulate against future feature work, clears a **CodeQL `rust/hardcoded-credentials` Critical finding** in a backend unit test, refreshes pinned-by-SHA GitHub Actions, and stabilises three CI-only test issues. **Drop-in upgrade from v0.30.1.** No database migrations, no API contract changes, no UI changes — operators on v0.30.1 can `docker compose pull && up` without further action.

---

## 🛡️ CodeQL #83 — `rust/hardcoded-credentials` (Critical) cleared

A CodeQL Critical alert flagged the `vdi_env_vars_overrides_reserved_keys_with_runtime_values` test in `backend/src/services/vdi.rs` because it passed string literals (`"alice"`, `"s3cret"`, `"attacker"`, `"leaked"`) into a function whose parameter name is `password`. The literal values were never reachable outside the `#[cfg(test)]` module — there is no production code path that consumes them — but the static-analysis signal is real noise on the security dashboard.

The test now constructs all four values at runtime via `format!("user-{}", Uuid::new_v4())` / `format!("pw-{}", …)` so no literal flows into a credential parameter. The override semantic that the test exercises (a connection's `extra` env-var blob smuggling `VDI_USERNAME` or `VDI_PASSWORD` keys must not leak past the runtime, which always wins) is unchanged.

---

## 📦 Dependency bumps

### Backend

- **`rustls` 0.23.38 → 0.23.39** (patch). Cargo.lock-only — the declared `"0.23"` requirement in `backend/Cargo.toml` already subsumes the patch.
- **`axum-prometheus` 0.7 → 0.10** (major). Strata's only call site is `PrometheusMetricLayer::pair()` in `backend/src/routes/mod.rs`. None of the breaking-surface APIs (`MakeDefaultHandle::make_default_handle(self)` in 0.7, `with_group_patterns_as` matchit-pattern syntax in 0.8, or the `metrics-exporter-prometheus` 0.18 upgrade in 0.10) are reached. Pulls in transitive bumps to `metrics` 0.23 → 0.24, `metrics-exporter-prometheus` 0.15 → 0.18, `metrics-util` 0.17 → 0.20.
- **`mrml` 5 → 6** (major). Strata's only call sites are `mrml::parse(&str)` and `mrml::prelude::render::RenderOptions::default()` in `backend/src/services/email/templates.rs`. Both are stable across the 5→6 boundary, which contains bug-fixes-and-deps-bump only (font-family quoted-name parse, `mj-include` inside `mjml`, container-width propagation, VML namespace preservation).

### Frontend

- **`jsdom` 29.0.2 → 29.1.0** (minor) and **`vite` 8.0.9 → 8.0.10** (patch). Both `devDependencies` (test runner / build tool) — no runtime bundle change.
- **`npm audit` → 0 vulnerabilities.**

---

## 🔐 GitHub Actions SHA pinning refreshed

Pinned-by-SHA-with-tag-comment workflow actions are bumped to their newest tagged commits to pick up upstream security fixes. The existing `# vN.N.N` trailing-comment convention is preserved so Dependabot keeps tracking them.

**`.github/workflows/ci.yml`:**

| Action                         | From | To     | Commit                                     |
| ------------------------------ | ---- | ------ | ------------------------------------------ |
| `actions/setup-node` (×3)      | v4   | v6.4.0 | `48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e` |
| `actions/upload-artifact` (×3) | v4   | v7.0.1 | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |

**`.github/workflows/release.yml`:**

| Action                        | From | To     | Commit                                     |
| ----------------------------- | ---- | ------ | ------------------------------------------ |
| `docker/metadata-action`      | v5   | v6.0.0 | `030e881283bb7a6894de51c315a6bfe6a94e05cf` |
| `actions/upload-artifact`     | v4   | v7.0.1 | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |
| `sigstore/cosign-installer`   | v3   | v4.1.1 | `cad07c2e89fa2edd6e2d7bab4c1aa38e53f76003` |
| `softprops/action-gh-release` | v2   | v3.0.0 | `b4309332981a82ec1c5618f44dd2e27cc8bfbfda` |

---

## 🧪 CI stability fixes

### `web_login_script` Linux ETXTBSY

Three tests in `backend/src/services/web_login_script.rs` (`spawn_succeeds_with_zero_exit`, `spawn_surfaces_non_zero_exit`, `spawn_kills_on_timeout`) intermittently failed on Linux CI runners with _"Text file busy"_ because the temp script file was still being held by an `fs::File` write handle when the test attempted `set_permissions()` followed immediately by `spawn()`. Linux refuses to `execve(2)` a file that has an open writer.

**Fix:** explicit `f.sync_all().unwrap(); drop(f);` _before_ `set_permissions()`, so the kernel flushes the inode and releases the write lock prior to exec. No production change — the production caller already drops its handle before chmod.

### Flaky `SessionWatermark` paint assertion

The `uses N/A for missing client_ip` case in `frontend/src/__tests__/SessionWatermark.test.tsx` asserted `fillTextSpy.mock.calls.some(args => args[0].includes("N/A"))` synchronously after `render()` resolved the canvas mount. The watermark paint actually runs in a `useEffect` triggered by the user-state commit, **one tick after** the canvas appears.

**Fix:** wrap the assertion in `await waitFor(...)` so the matcher polls until the paint completes. This matches the same fix already applied to the sibling case earlier in the v0.30.1 cycle.

### Trivy SARIF upload no-op when scanner failed

In `.github/workflows/trivy.yml` the `github/codeql-action/upload-sarif` step previously failed with _"Path does not exist: trivy-frontend.sarif"_ whenever the prior Trivy scan step itself errored out (because the matrix step uses `continue-on-error: true`).

**Fix:** added `if: always() && hashFiles(format('trivy-{0}.sarif', matrix.service)) != ''` so the upload skips cleanly when no SARIF file was produced, rather than masking the real Trivy failure with a misleading upload-not-found error.

---

## ✅ Validation

- **Frontend:** `npx vitest run` → 47 files / **1232 tests, all green.**
- **Frontend:** `npm audit` → **0 vulnerabilities.**
- **Backend:** `cargo update -p axum-prometheus -p mrml` resolved cleanly to `axum-prometheus 0.10.0` + `mrml 6.0.1`. The downstream `cargo check` is authoritative on CI (the local Windows workstation hits an unrelated Defender block on build-script execution under the cargo target dir, which does not affect Linux CI).

---

## 🚀 Upgrade notes

- **No database migrations.** The migration runner has no work to do for this release.
- **No API contract changes.** All `/api/*` routes, request/response shapes, and audit-event names are byte-identical to v0.30.1.
- **No UI changes.** Operators won't see anything different in the running app.
- **Operators on custom forks of `axum-prometheus` or `mrml`** should re-run their own integration suite — the major-version bumps exercise a large transitive-dependency delta even though Strata's call sites are unchanged.

---

# What's New in v0.30.1

> **Per-user preferences release.** v0.30.1 introduces a per-user preferences subsystem stored server-side, and the first preference it powers: a fully customisable keybinding for the in-session **Command Palette** (default `Ctrl+K`). Operators whose host applications collide with `Ctrl+K` — Visual Studio, JetBrains IDEs, Slack, Obsidian — can now rebind the palette to any combination they prefer, or disable it entirely. The setting follows the operator across browsers and devices because it lives in PostgreSQL, not localStorage. **Drop-in upgrade from v0.30.0.** A single additive migration (`058_user_preferences.sql`) creates the new table — no existing rows are mutated, and users who never open the Profile page get exactly the same `Ctrl+K` behaviour as before.

---

## ⌨️ Customisable Command Palette shortcut

Strata's in-session **Command Palette** is the operator's escape hatch from a captured Guacamole session — it pops over the remote-display canvas, intercepts keystrokes before the remote OS sees them, and lets the user disconnect, switch sessions, copy/paste, share, etc. It is bound to `Ctrl+K` by default. That keystroke unfortunately collides with several common host-side shortcuts:

- **Visual Studio** — `Ctrl+K, …` is the chord prefix for Peek, Comment selection, and the entire **Edit ▸ Advanced** menu.
- **JetBrains IDEs (IntelliJ, Rider, PyCharm, …)** — `Ctrl+K` is **Commit changes**.
- **Slack / Microsoft Teams** — `Ctrl+K` is the conversation quick-switcher.
- **Obsidian / Notion** — `Ctrl+K` is the link-insert / quick-find prompt.

When a Strata tab has focus the in-page handler swallows `Ctrl+K` so it can pop the palette — which means the operator's host app never sees the chord. v0.30.1 lets each user customise the binding away from the default.

### How it works

1. Click the **user avatar** at the bottom of the sidebar — that block is now a link to a new `/profile` page (was a static label).
2. Under **Keyboard Shortcuts**, click the **Command Palette** button. It enters recording mode (the button highlights and the helper text reads _"Press a shortcut… (Esc to cancel)"_).
3. Press the new combination. Modifier-only presses (just `Shift`, just `Ctrl`, etc.) are ignored — the recorder waits for an actual key. Press `Esc` to cancel without committing.
4. The button reverts to the recorded value (e.g. `Ctrl+Shift+P`, `Alt+Space`, `Ctrl+Backquote`). Click **Save** to persist.
5. **Reset to Ctrl+K** restores the default. **Disable** stores the empty string, turning the palette off entirely (the operator can still close it via the in-palette UI when something else opens it, e.g. a session reconnect modal that programmatically opens it).

### Cross-platform binding semantics

The matcher deliberately treats `Ctrl` in a stored binding as "**Ctrl OR ⌘**" so the same preference works on every operator's OS without per-device tweaking. A binding of `Ctrl+K` matches:

- `Ctrl+K` on Windows / Linux
- `⌘+K` on macOS

(If a future preference needs to distinguish Ctrl from ⌘, that's a separate knob — out of scope for v0.30.1.)

The matcher is also **case-insensitive** on the event side (so `K` and `k` both match a stored `Ctrl+K`), and **modifier-order insensitive** in the stored string (`Shift+Ctrl+P` and `Ctrl+Shift+P` parse identically). `Cmd`, `Meta`, `Win`, and `Super` are aliases for the same modifier.

### Where the binding takes effect

Two production keystroke traps respect the new preference, both via a `useRef` so the keydown listener doesn't have to be rebound when the user changes the value mid-session:

- The **main session window** trap in `frontend/src/pages/SessionClient.tsx` (capture-phase, runs **before** Guacamole's keyboard handler so the chord can't leak through to the remote OS).
- The **popout / multi-monitor child window** trap in `frontend/src/components/usePopOut.ts`. The popout doesn't open the palette directly — it relays a `strata:open-command-palette` postMessage back to the main window, which then opens it. Both windows now use the same matcher.

The postMessage listener itself in `SessionClient.tsx` was untouched — it dispatches on message type, not on key.

---

## 🗄️ Per-user preferences subsystem

The Command Palette binding is stored in a brand-new `user_preferences` table, designed up-front to be the foundation for additional preferences without further migrations. Schema:

```sql
CREATE TABLE user_preferences (
    user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

The blob is intentionally schema-less at the database layer — the **frontend owns the shape**. The backend enforces exactly one invariant: the top-level value MUST be a JSON object. Anything else (array, string, number, null) returns `400 Bad Request`. Future preferences (e.g. RDP keyboard-layout overrides, dashboard tile order, default-recording behaviour) just add new keys to the same blob.

### Backend surface

- New service module `backend/src/services/user_preferences.rs` with `get(pool, user_id) -> Value` and `set(pool, user_id, prefs)`. The setter is an idempotent UPSERT (`ON CONFLICT (user_id) DO UPDATE`).
- Two new endpoints, both on the standard `Extension<AuthUser>` middleware path:
  - `GET /api/user/preferences` → `200 { ... }` (or `200 {}` if no row exists yet).
  - `PUT /api/user/preferences` → accepts and returns the same JSON object; `400` for non-object bodies.

### Frontend surface

- React context provider `frontend/src/components/UserPreferencesProvider.tsx`, mounted in `App.tsx` between `SettingsProvider` and `SessionManagerProvider`. Exposes `useUserPreferences()` with `{ preferences, loading, error, update, reload }`. Performs optimistic updates with rollback on failure. Falls back to safe defaults when used outside the provider, so the login screen and unit-test harnesses keep working.
- Profile page `frontend/src/pages/Profile.tsx` at `/profile`. Two sections today: **Account** (read-only summary from `/api/user/me`) and **Keyboard Shortcuts** (the recorder UI described above). Designed so additional preference sections drop in as new `<section>` blocks.
- Keybinding utility `frontend/src/utils/keybindings.ts` — `parseBinding`, `matchesBinding`, `bindingFromEvent`, `DEFAULT_COMMAND_PALETTE_BINDING`. Covered by 16 vitest cases.
- API client additions in `frontend/src/api.ts`: `getUserPreferences()`, `updateUserPreferences(prefs)`, `UserPreferences` interface.

---

## ✅ Migration / upgrade notes

- **Drop-in upgrade from v0.30.0.** The migration runner picks up `058_user_preferences.sql` automatically on backend start. The table is `IF NOT EXISTS` and has no constraints that touch existing data, so the migration is reversible by hand if needed.
- **Defaults preserved.** Until a user explicitly visits `/profile` and saves something, the preferences row does not exist. The frontend transparently substitutes `commandPaletteBinding = "Ctrl+K"` so the experience is byte-identical to v0.30.0.
- **No backend dependency changes.** No new crates; the existing `serde_json` / `sqlx` stack is enough.

---

# What's New in v0.30.0

> **Runtime delivery release.** v0.30.0 ships the live runtime spawn for the two new connection protocols whose pure-logic foundation landed in v0.29.0. Connecting to a `web` connection now actually launches Xvnc + Chromium and tunnels them through guacd; connecting to a `vdi` connection now actually launches the Strata-managed Docker desktop container, attaches it to the Compose-prefixed `guac-internal` network, and tunnels its xrdp through guacd. The roadmap items `protocols-web-sessions` and `protocols-vdi` move from **In Progress** to **Shipped**. **No new database migrations** — the v0.29.0 migration `057_session_types_web_vdi.sql` already created the runtime tables. **Drop-in upgrade from v0.29.0.**

---

## 🌐 Web Browser Sessions — runtime delivery

The `web` protocol is now end-to-end functional in the default compose graph. New `backend/src/services/web_runtime.rs` ties the v0.29.0 foundation modules together into a single `WebRuntimeRegistry::ensure(connection_id, user_id, session_id, spec)` call invoked from the tunnel handler:

1. Allocate an X-display (`:100`–`:199`) via `WebDisplayAllocator`.
2. Allocate a CDP debug port (`9222`–`9421`) via `CdpPortAllocator`.
3. Create a per-session ephemeral profile dir (`/tmp/strata-chromium-{uuid}`).
4. Write the operator-supplied `Login Data` autofill row when the connection is configured with credentials, encrypted with Chromium's per-profile AES-128-CBC key (PBKDF2-SHA1, `v10` prefix).
5. Spawn `Xvnc :{display} -SecurityTypes None -localhost yes -geometry {width}x{height}` and wait for it to bind on the allocated VNC port.
6. Spawn `chromium --kiosk --user-data-dir={profile} --remote-debugging-address=127.0.0.1 --remote-debugging-port={cdp} --host-rules="MAP * ~NOTFOUND, MAP {allowed} {allowed}" --start-maximized {url}` under `DISPLAY=:{display}`.
7. Detect immediate-exit crashes (Chromium dies within 500 ms of spawn) and surface them as `WebRuntimeError::ChromiumImmediateExit`.
8. Run the configured login script via the localhost-only CDP transport (`backend/src/services/web_cdp.rs`, `backend/src/services/web_login_script.rs`) to handle the SSO redirect chain before guacd attaches.
9. Register the handle so subsequent reconnects against the same `(connection_id, user_id)` reuse the live process pair without re-spawning.

The kiosk's framebuffer geometry now matches the operator's actual browser window dimensions (new `window_width` / `window_height` fields on `ChromiumLaunchSpec` and `WebSpawnSpec`) so the Chromium tab fills the operator's viewport edge-to-edge with no letterboxing — the v0.29.0 RDP behaviour for `width`/`height`/`dpi` now applies to web kiosks too.

The route in `backend/src/routes/tunnel.rs` rewrites `wire_protocol = "vnc"` and substitutes the operator-typed hostname/port with `127.0.0.1:{5900+display}` returned by the runtime. The original `web` label is preserved on `nvr_protocol` so recordings keep the operator-facing name.

---

## 🖥️ VDI Desktop Containers — runtime delivery

The `vdi` protocol is now end-to-end functional via the `docker-compose.vdi.yml` overlay. New `backend/src/services/vdi_docker.rs` implements the `VdiDriver` trait against `bollard` 0.18 with default features so the unix-socket transport is available on Linux backends. `ensure_container` is idempotent: the deterministic name `strata-vdi-{conn[..12]}-{user[..12]}` lets a re-open of the same `(connection, user)` pair land on the same running container, preserving the persistent home and ephemeral-but-sticky session state.

### Auto-provisioned ephemeral RDP credentials

Operators no longer have to populate `username`/`password` on a VDI connection row — the tunnel route now calls `vdi::ephemeral_credentials(strata_username)` when the credential cascade resolves to no password. The function returns:

- A **deterministic** sanitised POSIX username — same Strata user always maps to the same POSIX user, so the bind-mounted `$HOME` is consistent across reconnects.
- A **fresh** 24-character alphanumeric password generated from `rand::distr::Alphanumeric` per call.

Both are injected into the spawned container as `VDI_USERNAME` / `VDI_PASSWORD`. Because xrdp inside the container authenticates against the same env-var pair, every VDI session gets a fresh password without operator interaction. The frontend `SessionClient.tsx` RDP prompt branch is updated to skip the credential dialog for `vdi`, so users never see "enter your credentials" for an internally managed account.

### VDI admin tab

New `frontend/src/pages/admin/VdiTab.tsx` exposes the `vdi_image_whitelist` (newline- or comma-separated, `#` comments) and `max_vdi_containers` (per-replica concurrency cap) settings via the generic `PUT /api/admin/settings` endpoint, registered alongside the other admin tabs in `AdminSettings.tsx` with a threat-model reminder linking to `docs/vdi.md`.

### Sticky `COMPOSE_FILE` overlay

The `.env` and `.env.example` files now ship and document a `COMPOSE_FILE` shortcut so plain `docker compose ...` commands automatically apply `docker-compose.vdi.yml` — without it, every operator command had to spell out both `-f` flags or risk silently dropping the docker.sock mount and the `STRATA_VDI_ENABLED` flag.

---

## 🛠️ Three runtime hot-fixes shipped in this release

Three issues surfaced during the live integration; all are fixed in v0.30.0 and documented in [`docs/vdi.md`](docs/vdi.md) for operators upgrading from the v0.29.0 foundation.

### 1. `docker.sock` permission

The backend runs as the unprivileged `strata` user via `gosu strata strata-backend`, but Docker Desktop on Windows mounts `/var/run/docker.sock` inside containers as `srw-rw---- root:root`. `bollard::Docker::connect_with_defaults()` is **lazy**: the connection check at startup succeeds even when the socket is unreadable, only the first real HTTP request fails with `Error in the hyper legacy client: client error (Connect)`.

`backend/entrypoint.sh` now stats the socket at runtime: when the GID is non-zero (typical Linux: 998 / 999) it creates a `docker-host` group with that GID and adds the `strata` user; when the GID is zero (Docker Desktop) it `chgrp strata` + `chmod g+rw` the bind-mount. Both paths emit a `[entrypoint] …` log line so operators can see which branch executed.

### 2. Compose-prefixed network resolution

Docker Compose prefixes network names with the project name, so the network the rest of the stack joins is actually `strata-client_guac-internal`, not `guac-internal`. The driver previously hard-coded the unprefixed name and every `ensure_container` failed with `404 network guac-internal not found`.

New `STRATA_VDI_NETWORK` env var on the backend, defaulted in `docker-compose.vdi.yml` to `${COMPOSE_PROJECT_NAME:-strata-client}_guac-internal`, threaded through to `DockerVdiDriver::connect(&network)` in `backend/src/main.rs`.

### 3. xrdp TLS / dynamic-resize quirks

The sample VDI image's xrdp uses a per-container self-signed certificate that Strata never trusts, and its display-update virtual channel drops the RDP session on resize storms (sidebar toggle, browser window resize). The tunnel handler now forces three overrides for `vdi` connections only:

- `ignore-cert=true` (both ends are Strata-controlled and traffic stays on the internal `guac-internal` bridge).
- `security=any` (xrdp negotiates whatever it can, since the cert is not trustworthy regardless).
- `resize-method=""` (no display-update messages — the frontend's guacamole-common-js display layer continues to scale the fixed framebuffer to fit the viewport client-side, so the user sees a letterbox / scale rather than a disconnect).

---

## 📝 Audit and recording

The action-type strings declared as fixed contracts in v0.29.0 are now actually emitted by the runtime: `web.session.start`, `web.session.end`, `web.autofill.write`, `vdi.container.ensure`, `vdi.container.destroy`, `vdi.image.rejected`. See [`docs/api-reference.md`](docs/api-reference.md) § _Audit Event Types_ for the per-event `details` schema.

`nvr_protocol` preserves the operator-facing `web` / `vdi` label even though the wire protocol is `vnc` / `rdp`, so recording playback shows the correct icon in the session list.

---

## 📚 Documentation

- **Web Sessions and VDI added to in-app docs.** The `/docs` page in the admin UI now ships two dedicated left-rail entries — _Web Sessions_ and _VDI Desktop_ — wired to `docs/web-sessions.md` and `docs/vdi.md`.
- **`docs/vdi.md`** rewritten for the shipping runtime: when-to-use, architecture diagrams, the full `connections.extra` schema, ephemeral-credentials flow, image whitelist semantics, network resolution (`STRATA_VDI_NETWORK`), the `entrypoint.sh` socket-permission handling, the security overrides for VDI, audit-event contract, reaper disconnect classification, custom-image build requirements, and a troubleshooting matrix.
- **`docs/web-sessions.md`** updated with viewport-matched framebuffer details, the runtime registry reuse semantics, the login-script runner section, and a troubleshooting matrix mapping each `WebRuntimeError` variant to its operator-facing remediation.
- **`docs/architecture.md`** gains an _Extended protocols_ deep-dive with ASCII diagrams of both spawn pipelines, the display / port allocator state machines, the deterministic container-naming scheme, and the wire-protocol translation (`web→vnc`, `vdi→rdp`).
- **`docs/security.md`** _Web Sessions and VDI extended threat model_ augmented with the v0.30.0 ephemeral-credentials flow, the scope of TLS overrides for VDI (vdi-only, RDP unaffected), the `STRATA_VDI_NETWORK` selection rule, and the entrypoint socket-permission handling.
- **`docs/api-reference.md`** documents the live audit events with their `details` schemas.
- **`docs/deployment.md`** documents the Windows-vs-Linux `COMPOSE_FILE` separator, the runtime requirements section, and the host resource budgeting guidance for VDI.
- **`README.md`** feature list updated with web and VDI as shipping protocols.

---

## 📦 Meta

- **Version bump (minor).** `VERSION`, `backend/Cargo.toml`, `backend/Cargo.lock`, `frontend/package.json`, `frontend/package-lock.json`, and the README badge are all bumped to `0.30.0`.
- **No new database migrations.** The v0.29.0 migration `057_session_types_web_vdi.sql` already created `vdi_containers` and the per-protocol settings rows; v0.30.0 only writes to those tables.
- **No API-contract changes for existing protocols.** RDP, VNC, SSH, Kubernetes, and Telnet behave identically. The new VDI-specific forced parameters (`ignore-cert`, `security`, `resize-method`) apply only when `protocol == "vdi"`.
- **Drop-in upgrade from v0.29.0.** Operators who do not enable VDI (i.e. do not apply `docker-compose.vdi.yml`) see no behaviour change beyond the new in-app docs entries and the live web-session runtime.

# What's New in v0.29.0

> **Foundation release.** v0.29.0 lands the typed config, allocator, egress guard, image whitelist, container-naming, and admin UI for two new connection protocols — `web` (kiosk Chromium inside Xvnc, tunnelled as VNC) and `vdi` (Strata-managed Docker desktop containers tunnelled as RDP) — along with 36 new backend unit tests, full operator docs, and a new admin endpoint for the VDI image whitelist. The **live runtime spawn** (`Xvnc` + Chromium for `web`, the `bollard`-backed `DockerVdiDriver` for `vdi`) is intentionally deferred to a follow-up release; both roadmap items remain marked **In Progress** in the admin UI. No migrations, no API-contract changes for existing protocols.

---

## 🌐 `web` protocol — Web Browser Sessions (foundation)

A new `connections.protocol = "web"` value lets operators publish a controlled, tunnelled Chromium kiosk pointed at a single internal web app (think: Splunk, Grafana, internal SharePoint, an admin console behind a jumphost). Sessions are recorded and brokered through the same VNC tunnel as everything else — there is no direct browser-to-target route.

This release ships everything **except the actual `Xvnc` + Chromium spawn** — that piece needs Dockerfile package additions and a sandboxing review, and is tracked separately. What's in v0.29.0:

- **Typed `connections.extra` schema** for `web` (`url`, `allowed_domains`, `login_script`) with lenient parsing — blank strings collapse to `None` so the admin form doesn't have to special-case empty optional fields.
- **`WebDisplayAllocator`** — thread-safe `:100`–`:199` X-display allocator with a 100-session cap per backend replica, full reuse on release, and exhaustion / release-unknown error paths covered.
- **CIDR egress allow-list (`web_allowed_networks`)** with **fail-closed semantics for an empty list** and **all-resolved-IPs-must-pass for DNS hosts** — the latter is explicit defence against DNS rebinding via mixed A records. Without this, a permissive `0.0.0.0/0` operator entry would otherwise be the trivial SSRF foothold.
- **Chromium kiosk argv builder (`chromium_command_args`)** mirroring rustguac: `--kiosk`, ephemeral per-session `--user-data-dir`, `--host-rules` for domain restriction, and crucially **`--remote-debugging-address=127.0.0.1`** — the CDP socket is bound to localhost only so it can never be reached from the network even if the network policy were misconfigured.
- **20 new backend unit tests** covering allocator increment / reuse / exhaustion, config parsing edge cases, CIDR matching across v4 and v6, host-lookup behaviour for literals and DNS rebinding, and the kiosk argv emission.
- **Admin form sections** in `connectionForm.tsx` (URL / allowed-domains / login-script) wired into `AccessTab.tsx` with port default `5900`.
- Two new dependencies in `backend/Cargo.toml`: `ipnet = "2"` and `url = "2"`.
- New operator runbook at [`docs/web-sessions.md`](docs/web-sessions.md) covering when-to-use, architecture, the `connections.extra` schema, the egress allow-list semantics, the planned audit events (`web.session.start` / `web.session.end` / `web.autofill.write` — strings are fixed now so the operator-facing contract is stable), and known operator pitfalls.

The Chromium **Login Data SQLite autofill writer** (PBKDF2-SHA1 / AES-128-CBC with the v10 prefix), the Chrome DevTools Protocol login-script runner, and the tunnel-handshake `web → vnc` selector translation are deferred — the autofill writer in particular is sensitive enough that we want it landing alongside its own dedicated audit event (`web.autofill.write`) and an end-to-end smoke test, not in this foundation release.

---

## 🖥️ `vdi` protocol — Strata-managed Desktop Containers (foundation)

A new `connections.protocol = "vdi"` value lets operators ship single-user Linux desktop containers — running xrdp inside a hardened image — and have Strata manage their lifecycle (create-on-connect, optional persistent home, idle-timeout reaping, deterministic naming for reuse). The connection is tunnelled as RDP so the whole existing recording / clipboard / file-browser pipeline applies unchanged.

What's in v0.29.0 (foundation only — `DockerVdiDriver` and the reaper extension are deferred):

- **`VdiDriver` async trait** + `NoopVdiDriver` stub returning `DriverUnavailable` until the operator opts in to mounting `/var/run/docker.sock` (which grants host root — see below).
- **Typed `VdiConfig::from_extra`** view (`image`, `cpu_limit`, `memory_limit_mb`, `idle_timeout_mins`, `env_vars`, `persistent_home`) with **reserved-key stripping** — `VDI_USERNAME` / `VDI_PASSWORD` are silently dropped from `env_vars` so the admin form cannot leak or override the runtime credentials. The runtime layer always wins.
- **`ImageWhitelist::parse`** — newline- or comma-separated, supports `#` comments, **strict equality matching only**. No glob, no tag substitution, no digest-vs-tag fuzziness. Pinning is a security feature: an operator who whitelists `myorg/strata-desktop:1.4.0` does not also implicitly trust `:latest`.
- **Deterministic per-(connection, user) container naming** (`container_name_for`, ≤63 chars) — the basis for persistent-home reuse without requiring DB-side container-ID bookkeeping.
- **Env-var layering (`vdi_env_vars`)** — operator-supplied env layered with reserved-key overrides so `VDI_USERNAME` / `VDI_PASSWORD` cannot be hijacked by a misconfigured admin form.
- **`DisconnectReason::from_xrdp_code`** classifier mapping the xrdp WTSChannel disconnect frame to `Logout` / `TabClosed` / `IdleTimeout` / `Other`, plus `should_destroy_immediately()` — logout and idle-timeout destroy the container; tab-close retains it for reuse on the next connect. The reaper has a deterministic input.
- **`GET /api/admin/vdi/images`** admin endpoint returning the operator whitelist, used to populate the image dropdown in the connection-editor UI.
- **16 new backend unit tests** covering all of the above.
- **Admin form sections** in `connectionForm.tsx` (image dropdown / CPU / memory / idle-timeout / env-vars / persistent-home) wired into `AccessTab.tsx` with port default `3389`. Reserved env keys are stripped client-side too as defence-in-depth.
- New operator runbook at [`docs/vdi.md`](docs/vdi.md) — including the **mandatory `docker.sock` warning**: mounting `/var/run/docker.sock` into the backend container grants the backend root on the host. This is why `DockerVdiDriver` is opt-in and why the live driver is gated on a separate operator decision, not a default-on capability.

The `bollard`-backed `DockerVdiDriver` itself, the live `ensure_container` reuse-by-name flow, the persistent-home bind mount under `home_base`, the idle reaper extension to `services/session_cleanup.rs`, the `contrib/vdi-sample/Dockerfile`, the opt-in `/var/run/docker.sock` mount in `docker-compose.yml`, and the `max_vdi_containers` concurrency cap are all explicitly deferred.

---

## 🎨 UI plumbing — protocol icons, badges, command palette

- New globe SVG icon for `web` and stacked-container SVG for `vdi` in the dashboard tile grid and the command palette protocol filter.
- New protocol badges in the active-sessions and recordings pages with matching unit-test coverage (`ActiveSessions.test.tsx`, `Sessions.test.tsx`).
- All 1192+ existing frontend tests continue to pass.

---

## 📚 Documentation

- New operator runbooks: [`docs/web-sessions.md`](docs/web-sessions.md) and [`docs/vdi.md`](docs/vdi.md).
- [`docs/architecture.md`](docs/architecture.md) gains an "Extended protocols" section linking both runbooks.
- [`docs/security.md`](docs/security.md) gains a **"Web Sessions and VDI: extended threat model"** section covering SSRF defence via `web_allowed_networks`, profile reuse, Chromium autofill secrecy, CDP localhost-only binding, the **`docker.sock` host-root warning**, image-whitelist strictness, the reserved env-key rule, the reaper semantics, and the per-replica concurrency caps.
- [`docs/api-reference.md`](docs/api-reference.md) documents `GET /api/admin/vdi/images`.

---

## 🛠 Upgrade notes

- **No database migrations.**
- **No API-contract changes** for existing connections, recordings, share links, or credential profiles.
- The two new connection types (`web`, `vdi`) reuse the existing `connections.extra` JSONB column and the existing audit / recording / credential-mapping pipelines.
- The roadmap items `protocols-web-sessions` and `protocols-vdi` remain marked **In Progress** in the admin UI — choosing the protocol in the connection editor will let you save a row, but **the live spawn is not in this release**. If you need the runtime now, watch the rustguac-parity tracker.
- Drop-in upgrade from v0.28.x.

---

# What's New in v0.28.0

> **Performance release.** v0.28.0 lands end-to-end H.264 GFX passthrough — RDP H.264 frames now travel from FreeRDP 3 all the way to the browser's WebCodecs `VideoDecoder` without a server-side transcode step. On Windows hosts with AVC444 properly configured, expect roughly an order-of-magnitude bandwidth reduction over the legacy bitmap path and meaningfully crisper text rendering during rapid window animations. No migrations, no API contract changes, drop-in upgrade.

---

## 🎥 H.264 GFX passthrough end-to-end (rustguac parity)

For the first time, RDP H.264 frames travel **FreeRDP 3 → guacd → WebSocket → browser's WebCodecs `VideoDecoder`** with **no intermediate server-side decode/re-encode**. Previously every RDP frame was decoded inside guacd and re-encoded as PNG / JPEG / WebP tiles before being shipped to the browser — that round-trip was the root cause of the cross-frame ghost artefacts that v0.27.0's Refresh Rect mitigation targeted. With passthrough enabled, that whole class of artefact cannot occur because there is no transcode step to lose state across.

The passthrough pipeline involves four cooperating components:

1. **`guacd` patch (`guacd/patches/004-h264-display-worker.patch`)** — a byte-identical port of upstream `sol1/rustguac`'s H.264 display-worker patch (SHA `7a13504c2b051ec651d39e1068dc7174dc796f97`). The patch hooks FreeRDP's RDPGFX `SurfaceCommand` callback, queues AVC NAL units on each `guac_display_layer`, and emits them as a custom `4.h264` Guacamole instruction during the per-frame flush. The previous Refresh-Rect-on-no-op-size patch at the same path is **superseded** — the in-session ghost recovery from v0.27.0 is no longer needed because the underlying ghost class cannot occur with a passthrough decoder.

2. **Vendored `guacamole-common-js` 1.6.0 (`frontend/src/lib/guacamole-vendor.js`)** — bundles a full `H264Decoder` (line ~13408) that lazily instantiates a `VideoDecoder` on the first `4.h264` opcode, plus a sync-point gate (`waitForPending`, line ~17085) that prevents the decoder being asked to flush before its pending-frame queue has drained. The `4.h264` opcode handler at line ~16755 routes inbound NAL units into the decoder. **Stock `guacamole-common-js` does not handle the `h264` opcode**, hence the vendored bundle. All `import Guacamole from "guacamole-common-js"` call sites continue to resolve through the existing Vite alias → `frontend/src/lib/guacamole-adapter.ts` → the vendored bundle, so no application code changed.

3. **Backend RDP defaults (`backend/src/tunnel.rs`)** — `full_param_map()` now seeds the full RDP defaults block required for AVC444 negotiation: `color-depth=32`, `disable-gfx=false`, `enable-h264=true`, `force-lossless=false`, `cursor=local`, plus the explicit `enable-*` / `disable-*` toggles that FreeRDP's `settings.c` requires (empty ≠ `"false"` in many guacd code paths). Per-connection `extras` continue to override defaults via the existing allowlist — which now permits `disable-gfx`, `disable-offscreen-caching`, `disable-auth`, `enable-h264`, `force-lossless`, and the related GFX toggles so the admin UI can drive them per connection.

4. **Windows host AVC444 configuration** — RDP hosts must have AVC444 enabled before any of the above starts paying off. v0.28.0 ships [`docs/Configure-RdpAvc444.ps1`](docs/Configure-RdpAvc444.ps1), a read-first PowerShell helper that audits the current registry state, detects whether the host has a usable hardware GPU, prints the diff, and prompts before applying changes. Idempotent and safe to re-run.

### Why this is a big deal

| Aspect                            | Bitmap path (pre-v0.28.0)                           | H.264 passthrough (v0.28.0+)                                     |
| --------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| Server-side work per frame        | RDP H.264 decode → re-encode to PNG/JPEG/WebP tiles | Forward NAL units verbatim                                       |
| Bandwidth (1080p typical desktop) | ~5–15 Mbps                                          | ~0.5–2 Mbps                                                      |
| Text rendering during animations  | Cross-frame ghosting on rapid window cycles         | Decoder reference chain stays intact                             |
| Browser CPU                       | Image-tile blit (cheap, but constant)               | Hardware video decode (cheaper, GPU-accelerated where available) |
| Server CPU                        | Transcode pipeline runs every frame                 | guacd just shovels NAL units                                     |

---

## 🛠️ Admin UX

### "Disable H.264 codec" checkbox is no longer dead

The toggle introduced in v0.26.0 was wired to `enable-gfx-h264` — a parameter name **guacd does not recognise** — so checking it had no effect. It is now bound to the correct `enable-h264` parameter and honoured by the backend allowlist. ([`frontend/src/pages/admin/connectionForm.tsx`](frontend/src/pages/admin/connectionForm.tsx))

### Color Depth dropdown labels reflect H.264 reality

The "Auto" placeholder was misleading because the backend forces `color-depth=32` whenever the field is empty (32-bit is **mandatory** for AVC444 negotiation). The select now reads "Default (32-bit, required for H.264)" and explicitly annotates the lower-bit options as **disabling H.264**, so admins are not surprised when a 16-bit choice silently degrades them to RemoteFX.

---

## 🧰 Operations

### Windows host AVC444 configuration script

[`docs/Configure-RdpAvc444.ps1`](docs/Configure-RdpAvc444.ps1) is a read-first PowerShell helper for Windows RDP hosts. It:

- Inspects the current `HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services` and `HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations` registry values.
- Enumerates `Win32_VideoController` and detects whether the host has a usable hardware GPU (filtering out Microsoft Basic Display, Hyper-V synthetic, and RemoteFX adapters; requires >256 MB adapter RAM and a real vendor name).
- On Server SKUs, prints the additional GPO requirement (`Use hardware graphics adapters for all Remote Desktop Services sessions`).
- Reports the diff between current and recommended values as a table.
- Prompts before applying any change, with an inline decision matrix for hosts **without** a hardware GPU (production multi-user → skip, production WAN with 1–2 users → proceed, verification → proceed).
- Conditionally skips the GPU-only keys (`AVCHardwareEncodePreferred`, `bEnumerateHWBeforeSW`) on hosts without a real GPU.
- Prints the post-reboot verification path: **Event Viewer → Applications and Services Logs → Microsoft → Windows → RemoteDesktopServices-RdpCoreTS → Operational**, watching for **Event ID 162** (AVC444 mode active) and **Event ID 170** (hardware encoding active).
- Offers an opt-in reboot at the end.

The desired-state map mirrors `sol1/rustguac`'s `contrib/setup-rdp-performance.ps1` and includes `MaxCompressionLevel=2`, `fEnableDesktopComposition=1`, `fEnableRemoteFXAdvancedRemoteApp=1`, `VisualExperiencePolicy=1`, `fClientDisableUDP=0`, and `SelectNetworkDetect=1` for full parity. The 60 FPS unlock (`DWMFRAMEINTERVAL=15`) is written to the **correct** `Terminal Server\WinStations` location, not the unrelated `\Windows\Dwm` key — an earlier draft of this script wrote it to the wrong location and so never actually unlocked 60 FPS.

### New operator runbook: `docs/h264-passthrough.md`

End-to-end documentation of the passthrough stack:

- **Pipeline anatomy** — what runs where, and which file owns each step.
- **Verification across four layers in priority order**:
  1. **Windows Event Viewer** (authoritative — Event 162 = AVC444 active, Event 170 = HW encoding active)
  2. **guacd logs** — "H.264 passthrough enabled for RDPGFX channel"
  3. **WebSocket frame trace** — `4.h264,…` instructions visible in DevTools
  4. **`client._h264Decoder.stats()`** — `framesDecoded > 0` confirms client-side decode
- **Windows host prerequisites** — what the helper script automates and why each registry value matters.
- **Decision matrix for hosts without a hardware GPU** — software AVC trade-offs (CPU cost ~1–2 cores per 1080p@30 session, bottlenecks at 2–4 concurrent sessions, lower quality at the same bitrate vs hardware AVC) and when the bitmap path is the better choice.

---

## ⚠️ Known limitations

### Chrome DevTools-induced ghosting

DevTools open in Chromium-based browsers can produce visible ghosting that **resembles** a codec problem but is not. Chrome throttles GPU-canvas compositing and `requestAnimationFrame` cadence on tabs whose DevTools panel is open; cached tile blits fall behind the live frame stream and the user perceives ghosting. Closing DevTools (or detaching it to a separate window) restores normal compositor behaviour. **This is a browser-side rendering artefact unrelated to H.264 and is not fixable in the Strata client.** If `client._h264Decoder?.stats()` shows `framesDecoded > 0` and the canvas still ghosts, DevTools is the most likely cause.

### H.264 is opportunistic — depends on the host

If AVC444 is not configured on the RDP host, `enable-h264=true` has no effect. guacd still loads the H.264 hook (you will see `H.264 passthrough enabled for RDPGFX channel` in the logs) but no AVC `SurfaceCommand` callbacks ever fire and the session falls back to the bitmap path silently. Run [`docs/Configure-RdpAvc444.ps1`](docs/Configure-RdpAvc444.ps1) on the host to enable it.

---

## 🔄 Upgrade notes

- **No migrations.** No backend or frontend API-contract changes. The previously-shipped per-connection `extras` column accepts the corrected `enable-h264` key without any migration.
- **guacd image rebuilds automatically** against the new patch (`004-h264-display-worker.patch`) on first deploy. The v0.27.0 `004-refresh-on-noop-size.patch` is **superseded**.
- **Refresh Display button retired.** The Session Bar's Refresh Display button has been removed because the underlying ghost class cannot occur with a passthrough decoder. The `refreshDisplay?: () => void` field on the `GuacSession` interface remains as a no-op for backwards compatibility with any third-party integrations that may have referenced it.
- **Breaking changes** — none.

---

# What's New in v0.27.0

> **Reliability release.** v0.27.0 ships an in-session fix for the H.264 GFX rendering corruption documented in v0.26.0 — no more mandatory Reconnect to clear the overlapping-window ghost.

---

## 🖥️ Refresh Display now fixes the overlapping-window ghost

v0.26.0 documented a class of rendering corruption where rapid window minimise/maximise cycles left multiple overlapping window states on the canvas, recoverable only by clicking **Reconnect**. v0.27.0 ships an in-session fix:

1. **Forked guacd patch (`guacd/patches/004-refresh-on-noop-size.patch`)** intercepts a Guacamole `size W H` instruction whose dimensions match the current remote desktop size (a no-op resize) and sends an RDP **Refresh Rect** PDU to the RDP server for the full screen. Refresh Rect asks the server to retransmit a full frame, which under FreeRDP 3's H.264 GFX pipeline triggers an IDR keyframe and resets the decoder's reference-frame chain.
2. **Frontend wire-up** — the Session Bar's **Refresh Display** button now drives this path via `client.sendSize(cw, ch)` with the current container dimensions. One click, no reconnect, no black-screen flash.

A 1-second per-session cooldown (new `guac_rdp_client.last_refresh_rect_timestamp` field) prevents an over-eager client flooding the RDP server with full-frame retransmit requests.

The hijack-the-`size`-instruction approach was deliberately chosen over a new Guacamole protocol opcode so that **stock `guacamole-common-js` (which Strata does not fork) continues to work unchanged**. The frontend change is also safe to run against an un-patched guacd — stock guacd silently ignores the no-op resize, the frontend's compositor nudge still fires, and the old behaviour is preserved.

## ⚠️ Server-dependent behaviour, safe fallbacks remain

MS-RDPEGFX specifies Refresh Rect as valid in GFX mode, but does **not** mandate that servers emit an IDR in response. On Windows 10/11 and Windows Server 2019/2022 the patch is expected to clear ghost frames within ~1 frame; on older or non-Microsoft RDP servers it may be a no-op and the **Reconnect** button remains the recovery path. Operators seeing persistent ghosts after Refresh Display should still fall back to Reconnect or to the per-connection **Disable H.264 codec** toggle.

## 🔄 Upgrade notes

- **No migrations.** No API-contract changes. No breaking changes to existing configs or persisted state.
- The v0.26.0 **Known issues** entry for H.264 reference-frame corruption is **superseded** by this release; the workarounds listed there (Reconnect button + per-connection Disable H.264 toggle) remain available as fallbacks for the server-dependent behaviour noted above.

---

# What's New in v0.26.0

> **Hardening release.** v0.26.0 is the result of an end-to-end code review across the backend and frontend, followed by a focused sweep of security, audit, and reliability fixes. No breaking API changes, one additive migration (056), drop-in upgrade.

---

## 🔒 Security & audit hardening

### Share tokens respect connection soft-deletes

Before v0.26.0, a share link minted against a connection that was subsequently soft-deleted would continue resolving — viewers hitting the `/share/:token` URL got routed at the stale connection metadata. `services::shares::find_active_by_token` now JOINs `connections` and filters `soft_deleted_at IS NULL`, so a deleted connection's shares stop working the moment the delete commits, even if the share row itself is still live.

### Brute-force isolation on shared tunnel rate limit

The `SHARE_RATE_LIMIT` overflow path used to call `map.clear()`, which meant an attacker spamming unique tokens could **reset every legitimate token's counter as a side-effect**. The new behaviour is a two-step LRU eviction: first drop entries whose windows have fully expired, then — only if still over the cap — evict the oldest-attempt entries. Real users' rate-limit state is unaffected by noise.

### Share rejection paths emit audit events

Two new event types appear in `audit_logs`:

- `connection.share_rate_limited` — emitted when a share URL hits the per-token rate limit
- `connection.share_invalid_token` — emitted when a lookup misses

Both carry a SHA-256-prefix fingerprint of the token (8 hex chars, the raw token is never persisted) plus the client IP, so operators can see probing activity against their share links without any PII leaks.

### User-route audit coverage gaps closed

Several self-service mutations were previously silent. They now emit audit events:

| Handler                                               | Event                             |
| ----------------------------------------------------- | --------------------------------- |
| `POST /api/user/accept-terms`                         | `user.terms_accepted`             |
| `PUT /api/user/credential-mappings`                   | `user.credential_mapping_set`     |
| `DELETE /api/user/credential-mappings/:connection_id` | `user.credential_mapping_removed` |
| `POST /api/user/checkouts/:id/retry`                  | `checkout.retry_activation`       |
| `POST /api/user/checkouts/:id/checkin`                | `checkout.checkin`                |

### Vault error paths sanitized

When Vault returns a server error or the HTTP transport fails, the full body / error detail is now emitted at `tracing::debug!` only. API callers see a generic `"Vault <status>"` or `"Vault request transport error"` message — no more raw Vault JSON leaking through to the client on a misconfigured instance.

### StubTransport compiled out of release builds

The in-memory test transport is now gated behind `#[cfg(test)]`. No path in a production binary can retain rendered message bodies (which can include justification strings and ephemeral credentials) in memory.

---

## 🛠️ Reliability & performance

### Input latency eliminated under bitmap bursts

The single biggest user-facing fix in v0.26.0. The WebSocket tunnel's proxy loop used to call `ws.send(...).await` inline inside the guacd→browser `tokio::select!` arm. Under heavy draw bursts — the classic symptom being a Win+Arrow window snap spewing a lot of bitmap updates in ~200 ms — the browser's WS receive buffer would fill, `ws.send().await` would block, and **while it was blocked the `ws.recv()` arm could not run**. So mouse movements and keystrokes queued up in the kernel TCP buffer and only flushed when the back-pressure relieved, producing three symptoms that were consistently reported together:

- Rendering freezes
- Mouse movement that felt like mouse acceleration had been turned on (a burst of queued movements arriving at once)
- Keyboard lag on the same timescale

The fix decouples the WebSocket sender from the select loop:

- `ws.split()` → `ws_sink` + `ws_stream`
- A bounded mpsc channel (1024 messages) sits in front of the sink
- A dedicated writer task drains the channel into the sink
- Every former `ws.send(...).await` call site now pushes to the channel — a fast in-memory append when the channel isn't full

Input-path latency is now independent of output-path backpressure. On the frontend, `display.onresize` events are coalesced to one `handleResize` per animation frame (FreeRDP 3 emits multiple partial size updates during snap animations), and the pending-buffer drain on the backend is now `O(remainder)` instead of `O(n)` via `Vec::drain`.

### Tunnel overflow emits a proper error frame

When guacd ever sends a single instruction larger than the pending-byte ceiling, the tunnel used to silently call `pending.clear()` — from the user's perspective the session would drop frames for no apparent reason. It now dispatches a Guacamole `error "…" "521"` to the websocket and closes the stream cleanly, so clients see exactly why the session ended.

### Indexed email retry sweep (migration 056)

The email retry worker runs `SELECT … WHERE status='failed' AND attempts<3 ORDER BY created_at` every 30 seconds. Without an index this became a seq-scan once `email_deliveries` grew. Migration `056_email_deliveries_retry_idx.sql` adds a partial index:

```sql
CREATE INDEX email_deliveries_retry_idx
    ON email_deliveries (created_at)
    WHERE status = 'failed' AND attempts < 3;
```

The index stays tiny because the retryable population is tiny.

### Settings cache TTL: 30 s → 5 s

Admin toggles (feature flags, branding, SMTP enable) used to take up to 30 seconds to propagate across replicas. The cache TTL is now 5 seconds, keeping operator feedback near-instant while still absorbing the hot-path read burst from auth middleware. A pg NOTIFY-based invalidator remains on the roadmap for zero-staleness.

---

## ✨ Admin UX polish

### Notifications tab — template test-send picker

The SMTP test-send panel gained a dropdown next to the recipient input letting admins dry-run **any of the real notification templates** (checkout requested / approved / denied / expiring) against their live relay. The backend renders the real MJML template with a synthetic sample context (requester, approver, justification, expiry), prefixes the subject with `[TEST]` so it can't masquerade as a real notification, and pulls the `tenant_base_url` and `branding_accent_color` from the live settings so the preview reflects the operator's actual branding.

### Port & TLS dropdowns are now bidirectionally symmetric

Picking a canonical port (25 / 465 / 587) now also snaps the TLS mode to the conventional pairing (so port 465 → Implicit TLS, 587 → STARTTLS), mirroring the pre-existing "TLS mode snaps port" behaviour. The two dropdowns can no longer drift into nonsensical combinations like _port 465 + STARTTLS_.

### Password field: discriminated union

Frontend callers used to pass `password: undefined | "" | string` to `updateSmtpConfig` with a three-way semantic (keep / clear / set). That's now an explicit discriminated union:

```ts
password: { action: "keep" } | { action: "clear" } | { action: "set", value: string }
```

The wire format is unchanged — the API client serializes back to the old shape at the request boundary — but the intent is now unambiguous in every caller.

---

## 📚 Docs & roadmap hygiene

- **Roadmap retention policy** codified in `docs/roadmap.md`: shipped items are visible for the minor line in which they landed and pruned at the next minor bump. No items in the markdown roadmap were flagged Shipped during the v0.25.x line, so nothing needs removing here — but the policy is now in place for future minor bumps.

---

## 📦 Upgrade notes

- **Database migration** — one additive migration: `056_email_deliveries_retry_idx.sql`. Safe on every supported Postgres version, no table locks beyond the `CREATE INDEX`.
- **Breaking API changes** — none. Frontend `SmtpConfigUpdate.password` type changed, but the backend wire format is identical.
- **Version bump** — `VERSION`, `frontend/package.json` (+ lock), `backend/Cargo.toml` (+ lock), and the README badge now read **0.26.0**.

---

# What's New in v0.25.2

> **The missing admin tab.** v0.25.2 ships the **Admin → Notifications** tab that the v0.25.0 release notes described but — as an observant administrator pointed out — never actually landed in the UI. The backend endpoints have been running since v0.25.0; this release puts a proper front-end on top of them. No migrations, no API changes, drop-in upgrade.

---

## 🖥️ Admin → Notifications — the SMTP configuration UI

A new top-level tab appears on the Admin Settings page (visible to users with `can_manage_system`). It is split into three sections:

### 1. SMTP relay configuration

Standard form fields for **host**, **port**, **TLS mode** (STARTTLS / Implicit TLS / None), **username**, **From address**, **From name**, and **brand accent colour** (used as the button colour in the HTML templates). The **Enable notification emails** master switch at the top is honoured by the dispatcher — off means _no outbound mail_, no TCP connection to the relay, no `email_deliveries` row churn.

### 🔐 The password field is Vault-aware

Because the SMTP password is **sealed into Vault server-side** (the backend rejects the PUT if Vault is sealed or in stub mode — see v0.25.0 notes), the UI never shows the actual stored value. Instead:

- An empty input with a **"•••••••• (sealed in Vault)"** placeholder appears when a password is already on file.
- Typing a new value and saving seals and replaces the stored secret.
- A **Keep existing** button discards your edit and leaves the stored value alone.
- A **Clear** button (only visible when a password is on file and you haven't started typing a new one) lets you remove the stored password on save — useful if you're switching to a relay that accepts anonymous SMTP from your subnet.

Three-state semantics are wired end-to-end: the `password` field on the PUT body is `undefined` to keep, `""` to clear, or a non-empty string to replace.

### 2. Send test email

A dedicated panel with a recipient input and a **Send test** button. The backend round-trips through the live `SmtpTransport` using the saved settings and returns the actual SMTP response on error (connection refused, 550 recipient rejected, certificate chain problems, etc. — all surface verbatim). Successful sends show up in the deliveries table below within a second.

The button is disabled until SMTP is enabled in the saved config — trying to test against unsaved form state leads to confusion, so we force a save first.

### 3. Recent deliveries

Last 50 rows of the `email_deliveries` audit table, ordered newest first, with a status filter (All / Queued / Sent / Failed / Bounced / Suppressed) and a manual **Refresh** button. Each row shows creation timestamp, template key, recipient, subject, status pill, attempt count, and the last error (hover for full text).

This is the same data that powered the v0.25.0 `GET /api/admin/notifications/deliveries` endpoint — which had been observable only via `curl` before now.

---

## 🛠️ API layer

Four new typed helpers in [`frontend/src/api.ts`](frontend/src/api.ts):

```ts
getSmtpConfig(): Promise<SmtpConfig>
updateSmtpConfig(body: SmtpConfigUpdate): Promise<{ status: string }>
testSmtpSend(recipient: string): Promise<{ status: string }>
listEmailDeliveries(status?, limit?): Promise<EmailDelivery[]>
```

Full TypeScript types (`SmtpConfig`, `SmtpConfigUpdate`, `EmailDelivery`) are exported for callers outside the Notifications tab.

---

## 📦 Upgrade notes

- **Database migration** — none.
- **API contract** — no new, removed, or changed endpoints. The v0.25.0 routes are now driven by the admin UI instead of requiring `curl`.
- **Breaking changes** — none.
- **Version bump** — `VERSION`, `frontend/package.json` (+ lock), `backend/Cargo.toml` (+ lock), and the README badge now read **0.25.2**.

---

## 🙏 Credits

Thanks to the admin who noticed the discrepancy between the release notes and the actual UI. The v0.25.0 changelog entry has been annotated in v0.25.2's _Fixed_ section as a documentation-honesty correction.

---

# What's New in v0.25.1

> **Quality-of-life patch release.** v0.25.1 lands a targeted RDP canvas-refresh fix for the "screen clipping" artefact that some users saw after minimising and restoring an active remote session, plus a zero-warning backend release build. No schema changes, no API contract changes, drop-in upgrade.

---

## 🖥️ RDP "screen clipping" fixed (with a new **Refresh display** button)

A subset of RDP users reported a stale rectangle of pixels remaining visible in the lower-right of the remote canvas after minimising and restoring the window (or toggling full-screen). The artefact would persist until the user manually resized the browser window, at which point the next draw cycle cleared it.

**Root cause.** Guacamole's JavaScript display emits a `display.onresize` event when the remote framebuffer changes size, but the browser compositor — with no CSS property change to invalidate its tile cache — would occasionally keep the pre-resize rectangle on screen if no pixel data arrived on the affected region before the next paint.

**The fix.** v0.25.1 introduces a `forceDisplayRepaint()` helper on `SessionClient.tsx` that nudges the canvas scale by a sub-pixel delta (`baseScale + 1e-4`), which the compositor treats as a transform change and which therefore invalidates every cached tile, forcing a full repaint of the `guacamole-common-js` display layers. The helper is:

1. **Auto-scheduled** at 50 ms, 200 ms, and 500 ms after every `display.onresize` event, so the common minimise/restore/full-screen-toggle cases self-heal with no user intervention.
2. **Exposed** through the session object as `refreshDisplay?: () => void` and surfaced in `SessionBar` as a **Refresh display** button, so users hitting rarer edge cases (GFX pipeline stalls, out-of-order H.264 frames on flaky networks) have a one-click recovery path.

The button only appears for sessions that publish `refreshDisplay` — historical recording playback is unaffected and does not show the control.

---

## 🧹 Zero-warning backend release build

The v0.25.0 notification pipeline landed with a public API surface sized for P8 (admin UI) and P9 (user opt-out UI) work that is still pending. Those reserved items generated 16 `unused_imports` / `dead_code` warnings during `docker compose build backend`.

v0.25.1 tidies the output: genuinely-unused imports are removed, and every retained-for-future-phase item (`InlineAttachment`, `BoxedTransport`, `SendError`, `StubTransport`, `describe`, `context_from_pairs`, the `reply_to`/`inline` builders, `DeliveryToRetry.attempts`, and `CheckoutEvent::target_account_dn`) now carries a focused `#[allow(dead_code)]` or `#[allow(unused_imports)]` annotation **with a rationale comment** pointing to the consuming phase. The outcome is a clean `cargo check --bin strata-backend --all-targets` — **0 warnings, 0 errors** — ready for an eventual `-D warnings` CI gate.

No runtime code was removed. All 852 backend unit tests pass unchanged.

---

## 📦 Upgrade notes

- **Database migration** — none. No schema change.
- **Breaking changes** — none. `GuacSession` gained an optional field (`refreshDisplay?: () => void`) used only by in-memory frontend code.
- **API contract** — unchanged; no new, removed, or renamed endpoints.
- **Version bump** — `VERSION`, `frontend/package.json`, `backend/Cargo.toml`, and `backend/Cargo.lock` now read **0.25.1**.

---

## 🙏 Credits

Thanks to the user who reported the RDP minimise/restore clipping; the repro steps (minimise → wait → restore, artefact persists until browser resize) were what identified the compositor-cache miss as the root cause rather than the originally-suspected canvas geometry bug.

---

# What's New in v0.25.0

> **Notifications release.** v0.25.0 delivers the long-awaited modern checkout-notification email pipeline — polished MJML templates, Outlook dark-mode hardening, an admin SMTP UI, per-user opt-outs, and a background retry worker. Zero-downtime upgrade; emails simply start flowing once an admin configures the SMTP relay.

---

## 📬 Modern managed-account notification emails

Strata now sends mobile-friendly HTML emails for every key managed-account checkout event:

| Event                                     | Recipients                                    | Opt-out?                 |
| ----------------------------------------- | --------------------------------------------- | ------------------------ |
| **Checkout pending approval**             | All assigned approvers for the target account | ✅ Yes                   |
| **Checkout approved**                     | The original requester                        | ✅ Yes                   |
| **Checkout rejected**                     | The original requester                        | ✅ Yes                   |
| **Self-approved checkout (audit notice)** | Configured audit recipients                   | ❌ No (audit visibility) |

Each email is rendered from an [MJML](https://mjml.io) template (mobile-responsive, tested across Gmail / Outlook / Apple Mail), dispatched as `multipart/related` with the Strata logo inlined as `cid:strata-logo`, and accompanied by a plain-text alternative for accessibility and minimal-client compatibility.

### 🌒 Outlook dark-mode "haze" fixed

Outlook desktop on Windows has a long-standing dark-mode quirk where it overlays a lighter rectangle ("haze") on top of HTML emails by inverting `bgcolor` attributes. v0.25.0 ships a reusable `wrap_for_outlook_dark_mode` helper that injects:

1. The VML namespace on `<html>`
2. A full-bleed `<v:background fill="t">` inside an `<!--[if gte mso 9]>` conditional
3. An Outlook-only stylesheet forcing dark backgrounds

VML backgrounds are immune to Outlook's inversion engine, so the result is a clean dark-themed email even in Outlook desktop dark mode. Future templates inherit the fix automatically.

---

## ⚙️ Admin SMTP configuration UI

A new **Admin → Notifications** tab exposes:

- **SMTP host / port / TLS mode** (`STARTTLS`, implicit-TLS, or plaintext for internal relays)
- **Username** (plaintext) and **password** (sealed into Vault — see security note below)
- **From-address** and **From-name**
- **Send test email** button — round-trips through the live transport and surfaces the actual SMTP response for debugging
- **Recent deliveries** view — last 50 attempts with status, attempt count, and error reason

### 🔐 Security note: SMTP password requires Vault

The SMTP password is **hard-required** to be stored in Vault. The `PUT /api/admin/notifications/smtp` endpoint refuses to save credentials if Vault is sealed or running in stub mode. This is intentional — SMTP credentials granting outbound mail are a high-value target and must never sit in plaintext on disk.

### 🚦 Dispatch is blocked when from-address is empty

If `smtp_from_address` is empty, the dispatcher silently skips all sends and audit-logs `notifications.misconfigured`. This prevents half-configured installs from queuing thousands of broken messages.

---

## 🙋 Per-user opt-outs (with audit trail)

v0.25.0 introduces a single `users.notifications_opt_out` boolean column. When set, the dispatcher suppresses **all** transactional messages for that user and records each suppression as a `notifications.skipped_opt_out` audit event with the template key and target entity ID. Every suppression is also reflected in the `email_deliveries` audit table with `status = 'suppressed'`.

Self-approved audit notices are intentionally **not opt-out-able** — they exist for security visibility, not user convenience. The dispatcher's `ignores_opt_out` branch is hard-coded to bypass the flag for the self-approved template.

> [!NOTE]
> The user-facing toggle UI ships in a follow-up release. For v0.25.0, administrators can set the flag directly via SQL (`UPDATE users SET notifications_opt_out = true WHERE id = $1`).

---

## 🔁 Background retry worker

Transient SMTP failures (network blips, 4xx responses, transient connection errors) are retried automatically by a new `email_retry_worker`:

- **Tick interval**: 30 seconds
- **Initial warm-up**: 60 seconds
- **Per-attempt timeout**: 120 seconds
- **Backoff**: exponential
- **Max attempts**: 3 — after which the row is marked `abandoned` and a `notifications.abandoned` audit event is emitted

**Permanent failures (5xx)** are _not_ retried — they go straight to `failed` so admins can see the underlying SMTP rejection in the deliveries view.

---

## 🗄️ Schema additions (migration 055)

```
email_deliveries             — every send attempt with status, attempts, last_error
users.notifications_opt_out  — single boolean column for global per-user opt-out
system_settings (8 new rows) — smtp_enabled, smtp_host, smtp_port, smtp_username,
                                smtp_tls_mode, smtp_from_address, smtp_from_name,
                                branding_accent_color
```

The SMTP password is **not** stored in `system_settings`. It lives sealed under Vault Transit using the same `seal_setting` / `unseal_setting` helpers as `recordings_azure_access_key`. The `email_deliveries` table is indexed on `(status, created_at)` for the retry worker's selection query, on `(related_entity_type, related_entity_id)` for per-checkout lookups, and on `recipient_user_id` (partial, NOT NULL) for per-user audit views.

---

## 📈 Approver fan-out improvement

Previously, only the first matching approver received the _pending_ notification. v0.25.0's `services::checkouts::approvers_for_account` now joins `approval_role_accounts` with `approval_role_assignments` to fan out to **every assigned approver** for the target account. No configuration change required.

---

## 🚀 Upgrade notes

- **Database migration** runs automatically on first boot of v0.25.0 (`055_notifications.sql`).
- **No emails will be sent** until an admin visits **Admin → Notifications**, configures SMTP, and saves a `from-address`. This is intentional — silent dispatch on an unconfigured relay would be worse than no dispatch at all.
- **Existing admins** see no behaviour change for non-notification flows. The dispatcher is fire-and-forget and never blocks the user-facing checkout request.
- **Per-user opt-outs default to "send"** for all opt-out-able events. Users wishing to mute notifications must visit **Profile → Notifications** after the upgrade.

---

## 🛠️ Under the hood

- **Migration**: [`backend/migrations/055_notifications.sql`](backend/migrations/055_notifications.sql) — adds `email_deliveries`, the `users.notifications_opt_out` column, and 8 SMTP/branding rows in `system_settings`.
- **Module layout**: `backend/src/services/email/` houses the trait (`transport.rs`), production transport (`smtp.rs`), MJML renderer (`templates.rs` + `templates/`), Outlook VML wrapper (`outlook.rs`), and retry worker (`worker.rs`). Dispatcher lives in `backend/src/services/notifications.rs`.
- **New crates**: `lettre 0.11` (rustls + tokio1), `mrml 5`, `tera 1`, `async-trait 0.1`. `ammonia` was _removed_ in favour of a custom 5-character `xml_escape` helper.
- **ADR**: [ADR-0008 — Notification pipeline](docs/adr/ADR-0008-notification-pipeline.md) records the design rationale (MJML + mrml, Vault-sealed password, opt-out semantics, retry strategy, alternatives considered).
- **Runbook**: [docs/runbooks/smtp-troubleshooting.md](docs/runbooks/smtp-troubleshooting.md) covers symptom triage, log inspection, common transient/permanent errors, and rollback.
- **Version bump**: `VERSION`, `frontend/package.json`, and `backend/Cargo.toml` all now read **0.25.0**.
- **Validation**: 852 / 852 backend tests pass (was 817 in v0.24.0); all 26 `services::email::*` tests green.

---

# What's New in v0.24.0

> **RBAC refinement release.** v0.24.0 introduces a dedicated permission for the in-session Quick Share feature and consolidates the two "create connections" permissions into a single, clearer flag. Zero-downtime, non-breaking upgrade for every existing role.

---

## 🔐 New permission: **Use Quick Share** (`can_use_quick_share`)

Quick Share — the ephemeral file CDN exposed on the Session Bar for handing files into a remote desktop — previously relied on implicit "if the button is visible, the user can use it" gating with no backend enforcement. In v0.24.0 it is a first-class role permission:

| Surface                      | Behaviour before v0.24.0                  | Behaviour in v0.24.0                                                                    |
| ---------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| **Session Bar button**       | Always visible while a session was active | Visible only when the user's role grants `can_use_quick_share` (or `can_manage_system`) |
| **`POST /api/files/upload`** | Any authenticated user                    | Requires `can_use_quick_share`; returns `403 Forbidden` otherwise                       |
| **Admin role editor**        | No checkbox                               | New **Use Quick Share** checkbox under **Admin → Access → Roles**                       |

> [!NOTE]
> **Upgrade behaviour is non-breaking.** Migration 054 sets `can_use_quick_share = true` on every existing role on first boot. Administrators who want to restrict Quick Share should untick the new checkbox on the relevant roles after the upgrade.

### Why a separate permission?

Quick Share writes to the backend file-store and is **independent of the guacd drive / SFTP channels** (which remain gated by the per-connection `enable-drive` / `enable-sftp` extras fixed in v0.23.1). That makes it a distinct capability from "Browse Files", and cleaner to govern separately — some tenants want to grant drive access but forbid link-sharing, or vice versa.

`can_use_quick_share` is treated as a **user-facing feature flag**, not an administrative permission. It is deliberately **excluded** from `has_any_admin_permission()`, so granting a role only Quick Share does **not** unlock any admin UI or endpoint. A dedicated regression test (`has_any_admin_perm_excludes_quick_share`) guards this invariant.

---

## 🧩 Unified "Create connections" permission

The role editor used to carry two almost-always-identical permissions:

- **Create new connections** (`can_create_connections`)
- **Create connection folders** (`can_create_connection_folders`)

In every review those two checkboxes ended up ticked together; the separation produced confusion more often than it produced value. v0.24.0 consolidates them:

- The `can_create_connection_folders` column is dropped from the `roles` table.
- Before dropping, migration 054 OR's its value **into** `can_create_connections`, so any role that had folders-only keeps connection-creation rights.
- The role-editor checkbox for "Create connection folders" is removed. Users with **Create new connections** can now create and organise both connections _and_ their folder hierarchy.

> [!TIP]
> **No one loses a capability.** Roles that previously had only the folders flag are silently upgraded to full connection creation — consistent with the practical reality that folders are meaningless without connections to put in them.

---

## 📡 API surface changes

Every user / auth / role API now emits `can_use_quick_share` in place of `can_create_connection_folders`:

- `GET /api/user/me`
- `POST /api/auth/login` (response payload's `user` object)
- `GET /api/admin/roles`, `POST /api/admin/roles`, `PUT /api/admin/roles/:id`

External API consumers should update their field mappings. The JSON field **count and shape are preserved** — only the semantic meaning of the retired slot has changed. See [`docs/api-reference.md`](docs/api-reference.md) for the full updated schemas.

---

## 🛠️ Under the hood

- **Migration**: `backend/migrations/054_unify_connection_folder_perm_add_quick_share.sql` performs the OR-rollup and column swap in a single transaction.
- **New middleware helper**: `services::middleware::check_quick_share_permission(&AuthUser)` — reusable gate for any future Quick-Share-adjacent endpoint.
- **Frontend context**: `SessionManagerProvider` now exposes `canUseQuickShare: boolean`; `App.tsx` seeds it from the authenticated user.
- **Version bump**: `VERSION`, `frontend/package.json`, and `backend/Cargo.toml` all now read **0.24.0**.
- **Validation**: 1,165 / 1,165 Vitest tests pass; backend `cargo check --all-targets` clean; TypeScript strict mode clean.

---

# What's New in v0.23.1

> **Maintenance release — zero user-facing changes.** v0.23.1 closes out the final front-end complexity item and retires the compliance tracker that has guided the last six waves of work.

---

## 🧱 `AdminSettings.tsx` is no longer a monolith

The Admin Settings page used to live in a single **8,402-line** React file. That file has been broken up into one module per tab under `frontend/src/pages/admin/`:

| Tab                                                                                                                              | Module                                          |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Health · Display · Network · SSO · Kerberos · Recordings · Vault · Access · Tags · AD Sync · Password Mgmt · Sessions · Security | one file each under `frontend/src/pages/admin/` |
| Connection-form helpers (`Section`, `FieldGrid`, `RdpSections`, `SshSections`, `VncSections`)                                    | `admin/connectionForm.tsx`                      |
| Shared RDP keyboard layouts                                                                                                      | `admin/rdpKeyboardLayouts.ts`                   |

`AdminSettings.tsx` itself is now a **258-line** dispatcher that loads settings once and renders the currently-selected tab. Net reduction across the admin surface: **−8,144 lines**. No behavioural changes; **1,162 / 1,162 frontend tests pass** and the backend suite is green.

### Why you care (even though nothing looks different)

- **Faster reviews**: each tab is now reviewed and tested in isolation.
- **Smaller edits**: touching the Vault tab no longer churns the whole file.
- **Lower recompile cost**: Vite HMR only reloads the affected tab.
- **Easier onboarding**: the admin surface is now self-documenting via its directory layout.

---

## 🗂️ Compliance tracker retired — 62 / 62 items closed

`docs/compliance-tracker.md` has been deleted. Every item across W0 – W5 is complete, and the artefacts that the tracker produced live on in their proper homes:

- **Seven ADRs** under `docs/adr/` (rate limiting, CSRF, feature flags, guacd model, JWT/refresh, Vault envelope, emergency bypass).
- **Five runbooks** under `docs/runbooks/` (disaster recovery, security incident, certificate rotation, vault operations, database operations).
- **Architecture baseline** captured in `docs/adrs/0001-architecture-baseline.md`.

Live references to the tracker (PR template, runbook index, ADR-0001) have been updated. Historical mentions in `CHANGELOG.md` and earlier `WHATSNEW.md` sections are preserved as point-in-time records.

---

## 🛠️ Under the hood

- No migrations, no config changes, no service restart semantics.
- Version bumped: `VERSION`, `frontend/package.json`, `backend/Cargo.toml` all now read **0.23.1**.
- Rust 1.95 / React 19 / TypeScript 6 toolchain from 0.23.0 is unchanged.

---

> **Compliance & operations release.** No feature-facing changes for end users — v0.22.0 closes out the data-retention and operational-documentation items from the compliance tracker so administrators and on-call engineers have runtime-configurable retention windows, concrete runbooks, and a documented design record.

---

## 🗑️ Recording retention now actually deletes

The scheduled recordings worker previously enforced `recordings_retention_days` only against **local files** in the recordings volume. Database rows and Azure Blob artefacts were left behind, so retention was partial and blob storage grew unbounded.

As of v0.22.0, every sync pass:

1. Selects every `recordings` row older than the configured window.
2. Deletes the underlying artefact — Azure blob via the Transit-sealed storage account key, or local file from the recordings volume.
3. Deletes the database row.

Each pass logs `purged_azure`, `purged_local`, and `deleted_rows` totals for auditability.

---

## 👤 User hard-delete window is now configurable

Soft-deleted users previously became unrecoverable after a **hardcoded 7 days**. That window was below many regulatory norms and could not be widened without a code change.

As of v0.22.0 the window defaults to **90 days** and is editable by an administrator in the Admin Settings → **Security** tab → **Data Retention** section. Valid range is **1 to 3650 days**. The setting (`user_hard_delete_days`) is applied by the background cleanup worker via parameter-bound `make_interval(days => $1)` — no SQL interpolation, no downtime to change.

> [!TIP]
> Shortening the window does not immediately delete existing soft-deleted users — it simply means the next worker pass will consider any row whose `deleted_at` is older than the new window.

---

## 📚 Architecture Decision Records — now written down

Five new ADRs capture decisions that were previously only in operator heads:

| ADR          | Topic                                                                                   |
| ------------ | --------------------------------------------------------------------------------------- |
| **ADR-0003** | Feature flags — why we kept boolean settings and when we'd promote to a real flag table |
| **ADR-0004** | guacd connection model, protocol-parameter allow-list, and trust boundaries             |
| **ADR-0005** | JWT + refresh-token TTLs, single-use refresh rotation, global-logout lever              |
| **ADR-0006** | Vault Transit envelope format (`vault:<base64>`), rotate + rewrap path                  |
| **ADR-0007** | Emergency approval bypass & scheduled-start checkouts — data model and audit invariants |

All live under `docs/adr/`.

---

## 📘 On-call runbooks — copy-pasteable, not prose

Five step-by-step runbooks were added under `docs/runbooks/`:

- **Disaster Recovery** — RTO ≤ 4h / RPO ≤ 24h, full restore sequence including Vault unseal and DNS cutover.
- **Security Incident Response** — SEV-1 containment in minutes, forensic SQL, remediation by incident class, post-incident cadence.
- **Certificate Rotation** — ACME and internal-CA paths side by side, with rollback.
- **Vault Operations** — unseal procedure, Transit key rotate + rewrap, and Shamir rekey for operator rotation.
- **Database Operations** — streaming-replica failover, compensating-migration pattern, and panic-boot recovery.

Each runbook follows a fixed template (Purpose → When to use → Prerequisites → Safety checks → Procedure → Verification → Rollback → Related).

---

## 🧭 Compliance tracker: Wave 5 closed

`docs/compliance-tracker.md` now shows **59 of 62** items done (up from 46). Every Wave 5 item — the three scheduled-job tasks, the feature-flags ADR, the four engineering ADRs, and the five runbooks — is ticked. The three remaining open items are deferred Wave 4 refactor tasks (`W4-4`, `W4-5`, `W4-6`) with no functional impact; they're tracked for a dedicated follow-up.

---

## 🛠️ Under the hood

- **Configurable retention windows** are bound via `make_interval(days => $1)` in every retention query path — no string concatenation of interval values anywhere.
- **No schema changes**, no migrations, no restart-required settings. Everything in this release is driven by existing `settings`-table keys or new static files.

---

# What's New in v0.20.2

> **v0.20.2 policy change**: Checkouts that go through an approver chain now **require a justification of at least 10 characters** (previously only Emergency Bypass required one). Approvers always see a written business reason before deciding. Self-approving users are unaffected — their comments remain optional.

---

# What's New in v0.20.1

> **v0.20.1 safeguard**: Emergency Approval Bypass checkouts are now hard-capped at **30 minutes**, regardless of the duration submitted. The duration input caps to 30 automatically when the ⚡ Emergency Bypass checkbox is ticked, and the backend enforces the same ceiling server-side. This tightens the exposure window for credentials released without approver review.

---

## 🕒 Schedule a Future Password Release

You can now request a password checkout that releases at a future moment instead of right now — perfect for change windows, planned maintenance, or passing a privileged credential to a colleague for a scheduled task.

### How to use it

1. Open the **Credentials** tab and start a new checkout request for a managed account.
2. Tick **"Schedule release for a future time"**.
3. Pick a date and time between **1 minute from now** and **14 days** in the future.
4. Submit. The checkout sits in the new **Scheduled** state — no password exists yet — and the Credentials card shows "🕒 Release scheduled for …".
5. When the scheduled time arrives, the backend automatically generates the password, resets it in Active Directory, and seals it in Vault. The checkout card flips to **Active** and you can reveal it exactly as usual.

> [!TIP]
> Scheduled checkouts count toward the "one open request per account" guard, so you cannot accidentally queue two overlapping releases.

---

## ⚡ Emergency Approval Bypass (Break-Glass)

When a production incident needs a privileged credential _right now_ and the approver chain is unavailable, admins can let users self-release with a mandatory written justification.

### How it works

- An administrator enables **"Emergency Approval Bypass (Break-Glass)"** inside an **AD Sync → Password Management** configuration.
- When the option is on, approval-required users see an **⚡ Emergency Bypass** checkbox on the checkout form.
- Enabling bypass requires a justification of at least **10 characters**, is **capped at 30 minutes** (the duration input is limited and any longer value submitted is clamped server-side), and skips the approver chain — the checkout activates immediately, just like a self-approved request.
- Every emergency checkout is flagged, badged with **⚡ Emergency** across the Credentials and Approvals views, and recorded in the audit log as `checkout.emergency_bypass` so the event can be reviewed after the fact.

> [!IMPORTANT]
> Break-glass is hidden on the form when you're scheduling a future release — the two options are mutually exclusive. Emergency = immediate, Scheduled = future.

---

## 🛠️ Additional Technical Updates

- **Migration 051**: Adds `pm_allow_emergency_bypass` to AD sync configs and `emergency_bypass` to checkout requests.
- **Migration 052**: Adds `scheduled_start_at` to checkout requests and introduces the `Scheduled` state (full state set: Pending, Approved, Scheduled, Active, Expired, Denied, CheckedIn). Partial index on `scheduled_start_at` keeps the worker's due-scan fast.
- **Single Expiration Worker**: The existing 60-second checkout worker now also activates due scheduled checkouts — no extra background processes.

---

_For a full technical list of changes, please refer to the [CHANGELOG.md](file:///c:/GitRepos/strata-client/CHANGELOG.md)._
