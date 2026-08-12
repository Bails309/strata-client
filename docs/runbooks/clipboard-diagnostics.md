# Runbook — Clipboard failure diagnosis and recovery

## Purpose

Identify which of the two known clipboard failure modes a user has hit,
recover the affected session, and capture content-free diagnostic
evidence for a bug report.

## When to use

A user reports any of the following against an RDP session:

- "Copy stopped working" / "paste stopped working" / "copy and paste
  stopped working".
- Text copied inside the remote desktop no longer reaches the local
  clipboard.
- Text copied locally no longer reaches the remote desktop.
- Clipboard works after reconnecting, then breaks again.
- Clipboard is dead and **reconnecting does not help**.

## Prerequisites

- The reporting user can open their browser devtools console
  (`F12` → **Console**) on the Strata session tab.
- For backend tracing: shell access to the host running the backend
  container, and permission to restart it.
- Strata **v1.14.4 or later** for the `strataClipboard` console helper
  and `STRATA_CLIPBOARD_TRACE`. On older builds, skip to
  [Triage](#procedure--triage) and use the browser console warnings
  emitted by the v1.14.1 stall watchdog instead.

## Safety checks

Before changing anything:

1. **Confirm the transport basics.** Clipboard reads require a secure
   context. Confirm the user reaches Strata over `https://` (or
   `localhost`). On an insecure origin the browser denies
   `navigator.clipboard.readText()` outright and _nothing_ transfers in
   either direction — that is a deployment fault, not this incident.
2. **Confirm clipboard is not administratively disabled.** In
   **Admin → Connections → _connection_ → Clipboard**, check
   `disable-copy` / `disable-paste`. Both default to `false`; a
   connection with either set to `true` is behaving as configured.
3. **Do not disconnect the user's session yet.** The diagnostic ring
   buffer lives in page memory and is lost on reload. Capture it
   _first_ (step 2 below).
4. Nothing in this runbook is destructive to Strata state. The only
   disruptive action is logging off the user's **Windows** session,
   which is flagged below.

## Procedure — triage

### 1. Classify the failure mode

Ask the user one question: **"If you disconnect the session tab and
reconnect to the same server, does copy/paste come back?"**

| Answer                           | Mode                         | Meaning                                                                                                                                     |
| -------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Yes, reconnecting fixes it       | **A — stalled transfer**     | A single clipboard transfer opened on RDP's CLIPRDR channel and never closed. Server-side channel state; a fresh `guacd` process clears it. |
| No, still broken after reconnect | **B — wedged `rdpclip.exe`** | The Windows-side clipboard owner is stuck. Reconnecting reattaches to the _same_ still-logged-on Windows session, so it cannot help.        |

Mode B is the v1.14.4 defect. Mode A is the v1.14.1 defect, which
should now degrade to a partial copy plus a console warning rather
than a silent dead clipboard.

### 2. Capture browser evidence — do this before any reload

A 500-entry diagnostic ring buffer is **always recording**, so the
user does not need to reproduce the fault with logging switched on.
Have them run this in the session tab's console and paste the output
into the ticket:

```js
strataClipboard.print();
```

If you need the raw structured entries instead of the table:

```js
copy(JSON.stringify(strataClipboard.dump(), null, 2));
```

To watch events live while reproducing (persists across reloads):

```js
strataClipboard.enable();
// …reproduce…
strataClipboard.disable();
```

**What the events mean:**

| Event                                                           | Direction | Interpretation                                                                                                                   |
| --------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `queued` → `stream-open` → `stream-end`                         | out       | A healthy local → remote push.                                                                                                   |
| `skip-duplicate`                                                | out       | Suppressed because the remote is believed to already hold this text. Expected for the burst of triggers a single click produces. |
| `skip-disconnected` / `abort-disconnected` / `abort-mid-stream` | out       | The tunnel was closed. Look for a preceding `tunnel-closed`.                                                                     |
| `stream-failed` / `stream-open-failed`                          | out       | The Guacamole client rejected the write.                                                                                         |
| `ack-error`                                                     | out       | `guacd` rejected a chunk; `code` identifies why.                                                                                 |
| `echo-reset`                                                    | out       | Normal on every (re)connect — the clipboard belief was cleared so the channel gets re-primed.                                    |
| `stream-open` with no `stream-end`                              | in        | Mode A. Should be followed by `stream-stalled` from the watchdog.                                                                |
| `stream-stalled` with `blobs: 0`                                | in        | The remote announced a clipboard format and produced nothing.                                                                    |
| `local-write-failed`                                            | in        | The browser refused the clipboard write (permissions / focus / insecure origin).                                                 |

> Neither tracer records clipboard **contents**. Entries carry
> opcodes, stream indices, payload **lengths**, timings, and a
> non-reversible digest (`fp`) used only to tell whether two entries
> carried the same text. Output is safe to attach to a ticket.

### 3. Capture backend evidence (optional, for a reproducible case)

Enable the tunnel tracer:

```bash
# On the backend host — add to .env or docker-compose.override.yml
echo 'STRATA_CLIPBOARD_TRACE=1' >> .env
docker compose up -d backend
```

The variable is read **once per tunnel at connect time**, so the user
must open a _new_ session for it to take effect. When disabled the
tracer performs no parsing at all, so leaving it off costs nothing.

Then follow the logs while the user reproduces:

```bash
docker compose logs -f backend | grep -i clipboard
```

Expected healthy output:

```
INFO  clipboard stream-open dir="client->guacd" index="7" mimetype="text/plain"
INFO  clipboard stream-end  dir="client->guacd" index="7" blobs=3 payload_chars=9812 acks=3 ms=41
```

**Signals to look for:**

| Log line                                                                         | Meaning                                                | Action                                                                                                                                              |
| -------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WARN clipboard stream opened while another is still open in the same direction` | Two transfers overlapping. This is the Mode B trigger. | If seen on v1.14.4+, the client is **not** serialising — capture the full trace and raise a bug; a non-Strata client may be attached to the tunnel. |
| `WARN clipboard stream never received end` (at teardown)                         | Mode A — a transfer was abandoned.                     | Correlate with the browser's `stream-stalled` entry.                                                                                                |
| `INFO clipboard stream-end … blobs=0`                                            | The remote announced a format then produced nothing.   | Usually a delayed-render clipboard owner on the Windows side.                                                                                       |
| `WARN clipboard stream ack reported an error`                                    | `guacd` rejected a chunk.                              | Check the `code`; correlate with `guacd` logs.                                                                                                      |

To correlate with `guacd`'s own CLIPRDR handling, raise its log level
in the same window:

```bash
# docker-compose.override.yml
services:
  guacd:
    environment:
      GUACD_LOG_LEVEL: debug
```

Remember to remove `STRATA_CLIPBOARD_TRACE` and `GUACD_LOG_LEVEL`
after the capture.

## Procedure — recovery

### Mode A — stalled transfer

1. Have the user disconnect the session tab and reconnect to the same
   host. This spawns a fresh `guacd` process with a clean CLIPRDR
   channel.
2. Confirm copy works again.

No server-side action is required. On v1.14.1+ the stall watchdog
already flushes whatever text arrived, so the user should have
received a partial copy rather than stale content.

### Mode B — wedged `rdpclip.exe`

Reconnecting will **not** work. The wedged state lives in the Windows
session, not in `guacd` or in Strata.

1. Have the user connect to the affected host.
2. ⚠ **Log off the Windows session** — Start → user icon → **Sign
   out**. This is _not_ the same as disconnecting the Strata tab, and
   it will close the user's remote applications. Confirm they have
   saved their work first.
3. Log back in.
4. Confirm copy **and** paste both work.

If a full log off is not acceptable right now, restarting the
clipboard service in the remote session is a lighter-touch
alternative:

```powershell
# Run inside the affected Windows session
Stop-Process -Name rdpclip -Force
Start-Process rdpclip
```

This is unsupported by Microsoft as a general remedy but is
non-destructive and frequently sufficient. If it does not restore the
clipboard, fall back to the log off.

### Preventing recurrence

Mode B was caused by overlapping local → remote clipboard transfers
and is fixed in **v1.14.4**, which serialises every clipboard push so
only one transfer is ever in flight. Confirm the deployment is on
v1.14.4 or later:

```bash
docker compose exec backend /app/strata-backend --version
# or
cat VERSION
```

Upgrading does **not** retroactively clear a Windows session that is
already wedged — those still need the one-time log off above.

## Verification

- Copy text inside the remote desktop → paste locally. Text matches.
- Copy text locally → click into the session → paste in the remote
  desktop. Text matches.
- Repeat with a **large** payload (several thousand lines) to exercise
  the multi-chunk path.
- Repeat with the session **popped out** into its own window — that is
  the configuration that fires the most concurrent clipboard triggers.
- `strataClipboard.dump()` shows `queued` → `stream-open` →
  `stream-end` with no `ack-error` and no overlapping streams.

## Rollback

Nothing in this runbook changes persistent Strata state, so there is
no rollback to perform. If you enabled tracing, undo it:

```bash
# Remove STRATA_CLIPBOARD_TRACE from .env / compose overrides
docker compose up -d backend
```

In the browser:

```js
strataClipboard.disable();
strataClipboard.clear();
```

## Related

- [../architecture.md](../architecture.md#local--remote-clipboard-serialisation-v1144) — why the local → remote path is serialised.
- [../architecture.md](../architecture.md#remote--local-clipboard-stall-watchdog-v1141) — the receive-side stall watchdog.
- [../architecture.md](../architecture.md#clipboard-diagnostics-v1144) — full event and log-signal reference.
- [../security.md](../security.md) — why the diagnostics are content-free by construction.
- [../deployment.md](../deployment.md#diagnosing-clipboard-problems-v1144) — operator quick reference.
- [../api-reference.md](../api-reference.md#tunnel-diagnostics-environment) — `STRATA_CLIPBOARD_TRACE` and the clipboard stream-concurrency contract for third-party tunnel clients.
- [../../CHANGELOG.md](../../CHANGELOG.md) — v1.14.1 and v1.14.4 root-cause write-ups.

---

_Last reviewed: 2026-08-12._
