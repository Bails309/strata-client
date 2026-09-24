# Runbook — Unexpected session disconnects

## Purpose

Work out why a user's remote session ended, starting from the message the
user saw and finishing at the log line or audit row that proves the cause.

## When to use

- A user reports _"my session dropped"_, _"it kicked me out"_ or _"it said
  Connection Lost"_ and wants to know why.
- A user disputes an end message — _"it says I signed out, but I didn't"_.
- Several users lose sessions at once and you need to tell a target-side
  problem from a Strata-side one.

This runbook applies to **v2.1.1 and later**. Earlier native-engine builds
sent the same status for every end and sent nothing at all for engine
failures, so the overlay title on those builds is not evidence of anything.

## Prerequisites

- Shell access to the host running the backend container (`docker compose
logs backend`).
- Read access to the audit log (Admin → Audit, or SQL against `audit_logs`).
- From the user: the **exact heading and sentence** on the overlay, the
  **time** it happened (to the minute), and the **connection name**. A
  screenshot is ideal.

## Safety checks

1. **Do not restart the backend to "clear" a problem.** Every live session
   runs inside the backend process; a restart ends all of them.
2. Confirm the user saw the **session-ended overlay** (a card with **Exit to
   Dashboard** / **Reconnect**) and not the **Reconnecting…** spinner. The
   spinner means the link between the _browser_ and Strata dropped, which
   this runbook does not cover — check the user's network and any proxy in
   front of Strata first.

## Procedure

### 1. Classify from what the user saw

| Heading              | Status on the wire           | Who ended it                                                                      | Go to  |
| -------------------- | ---------------------------- | --------------------------------------------------------------------------------- | ------ |
| Session Ended        | `523` `SESSION_CLOSED`       | The user, the remote program, or a time limit                                     | Step 2 |
| Session Timed Out    | `522` `SESSION_TIMEOUT`      | The remote computer's idle-session policy                                         | Step 2 |
| Session Disconnected | `521` `SESSION_CONFLICT`     | Another client, or an administrator **on the remote computer**                    | Step 2 |
| Session Terminated   | `521` + _terminated_         | A **Strata** administrator                                                        | Step 4 |
| Connection Lost      | `515` `UPSTREAM_ERROR`       | The network between Strata and the target, or the target closing without a reason | Step 3 |
| Connection Refused   | `520` `UPSTREAM_UNAVAILABLE` | The remote computer (refusal, licensing, broker, memory)                          | Step 2 |
| Access Denied        | `769` `CLIENT_UNAUTHORIZED`  | The remote computer's access policy                                               | Step 2 |
| Connection Error     | `512` `SERVER_ERROR`         | A protocol violation or a crashed component on the target                         | Step 3 |

The status code itself is not written to the backend log; the heading is the
user-visible form of it, which is why the exact heading matters.

### 2. Target-reported ends (RDP)

The engine logs Windows' own reason before translating it:

```bash
docker compose logs --since 2h backend | grep "rdp target ended the session"
```

Expected output (abridged; one line per session end, `reason` is the
MS-RDPBCGR text):

```text
INFO rdp target ended the session reason=[Protocol independent error] The disconnection was initiated by the user logging off his or her session on the server
```

Match `reason` to the table:

| `reason` contains                                                 | Windows code    | Meaning                                                                     |
| ----------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------- |
| _user logging off his or her session_                             | `0x0C`          | The user signed out                                                         |
| _administrative tool on the server running in the user's session_ | `0x0B`          | The user chose **Start → Disconnect**; the Windows session is still running |
| _administrative tool on the server in another session_            | `0x01`          | An admin disconnected the session (Task Manager, `tsdiscon`, RD manager)    |
| _forced logoff initiated by an administrative tool_               | `0x02`          | An admin signed the session out (`logoff`, RD manager)                      |
| _Another user connected to the server_                            | `0x05`          | The same Windows session was opened from another client                     |
| _idle session limit timer_                                        | `0x03`          | Idle-session Group Policy                                                   |
| _active session limit timer_                                      | `0x04`          | Active-session time-limit Group Policy                                      |
| _licensing_                                                       | `0x100`–`0x10A` | RD licensing — check the RD Licensing server                                |
| _connection broker_                                               | `0x400`–`0x412` | RD Connection Broker placement failure                                      |
| `server initiated disconnect`                                     | MCS ultimatum   | The host ended the session without a code (often shutdown / restart)        |

For a disputed **Session Disconnected** (`0x05`), ask whether the user has
the same connection open in another tab, browser or device, or in `mstsc`.
For `0x01` / `0x02`, the Windows Security and
`TerminalServices-LocalSessionManager/Operational` event logs on the target
name the account that performed the action.

SSH, Kubernetes and VNC ends carry their reason in the overlay text itself
(exit status, signal, pod error) and need no log lookup.

### 3. Network and engine failures

```bash
docker compose logs --since 2h backend | grep -E "engine failure|tearing down session"
```

Expected output for a network failure (abridged):

```text
WARN engine failure session=... error=target transport failed: Connection reset by peer (os error 104)
INFO tearing down session session=... reason=engine failure: target transport failed: ...
```

| `error` shows                  | Likely cause                                                                         | Next check                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `Connection reset by peer`     | Target, firewall or load balancer reset the TCP connection                           | Firewall / LB idle-timeout settings between the backend and the target |
| `timed out`                    | Target stopped answering (hung, or a path blackholing traffic)                       | Ping / `nc -vz <host> 3389` from inside the backend container          |
| `target closed the connection` | Target closed cleanly with no reason — usually a restart or the RDP service stopping | Target's System event log for a restart at that time                   |
| `target protocol violation`    | The target sent something the engine could not parse                                 | Capture the full line and open an issue; this is a bug report          |
| `engine failure on input`      | The failure surfaced while the user was typing or moving the mouse                   | Same as above — the error text is what matters                         |

Several sessions to **different** targets failing within the same minute
points at the backend host's own network. Several sessions to the **same**
target points at that target.

### 4. Strata-initiated ends

```bash
docker compose logs --since 2h backend | grep "native session ending"
```

| `reason=`                     | Cause                                                                   | Evidence                                                                       |
| ----------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `terminated by administrator` | An admin used **Kill** on Active Sessions                               | Audit log: the admin's kill action for that session                            |
| `revoked`                     | The user's access token was revoked (sign-out elsewhere, forced logout) | Audit row `tunnel.watchdog_closed`, `reason: revoked`                          |
| `max_duration`                | The session reached `MAX_TUNNEL_DURATION` (8 h)                         | Audit row `tunnel.watchdog_closed`, `reason: max_duration`                     |
| `gateway shutting down`       | The backend was stopped or restarted                                    | Host / orchestrator logs. The browser shows **Reconnecting…**, not the overlay |

```sql
SELECT created_at, user_id, details
FROM audit_logs
WHERE action_type = 'tunnel.watchdog_closed'
  AND created_at > now() - interval '2 hours'
ORDER BY created_at DESC;
```

## Verification

You are done when the heading the user saw, the status in the table in
step 1, and a log line or audit row from steps 2–4 all name the same cause.
If they disagree — for example the user saw **Session Ended** but the log
shows `engine failure` — record both and raise an issue: the mapping in
`crates/strata-session/src/engine/rdp/mod.rs` (`describe_termination`) or
`crates/strata-session/src/actor/session.rs` (`describe_engine_failure`)
is wrong for that case.

## Rollback

This runbook changes nothing. If you changed firewall, load-balancer or
Group Policy settings as a result of it, revert those through their own
change process.

## Related

- [architecture.md § How a session ends](../architecture.md#how-a-session-ends-v211)
  — the full cause → status → title mapping.
- [api-reference.md § Session end: the `error` instruction](../api-reference.md#session-end-the-error-instruction-v211)
- [security.md § Session-end reporting](../security.md#session-end-reporting-v211)
- [faq.md § What do the messages mean when a session ends?](../faq.md#what-do-the-messages-mean-when-a-session-ends)
- [clipboard-diagnostics.md](clipboard-diagnostics.md)

_Last reviewed: 2026-09-24 (v2.1.1)._
