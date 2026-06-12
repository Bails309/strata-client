/* eslint-disable react-hooks/set-state-in-effect --
   react-hooks v7 compiler-strict suppressions: legitimate prop->state sync. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  issueOutboundShareIngestToken,
  listMyOutboundShares,
  outboundShareDownloadUrl,
  OutboundShare,
  OutboundShareIngestToken,
} from "../api";
import Select from "./Select";
import { useSessionManager } from "./SessionManager";

interface Props {
  onClose: () => void;
  sidebarWidth: number;
  sessionBarCollapsed: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function statusClasses(status: string): string {
  switch (status) {
    case "approved":
      return "bg-success-dim text-success";
    case "denied":
    case "purged":
      return "bg-danger/10 text-danger";
    case "downloaded":
      return "bg-accent/10 text-accent";
    case "pending":
    default:
      return "bg-warning-dim text-warning";
  }
}

// ── In-session upload snippet renderer ───────────────────────────────
//
// Mirrors the inbound QuickShare snippet formats, but adapted for an
// upload: each one POSTs a multipart `file` field at the tokenised
// ingest URL. `<your-file>` is a placeholder the user can either
// replace by hand inside the session shell, or fill in via the
// "File path" input on this panel — when supplied, it's substituted
// (with per-format quoting) at render time so the snippet is
// genuinely paste-and-run. `wget` is omitted because GNU wget does
// not construct multipart bodies natively.

type SnippetFormat = "curl" | "curl-win" | "powershell";

function defaultSnippetFormat(protocol: string): SnippetFormat {
  // SSH/Telnet sessions are almost always *nix; everything else
  // (rdp/vnc/kubernetes) is most often Windows, so default to a
  // Windows-friendly snippet.
  if (protocol === "ssh" || protocol === "telnet") return "curl";
  return "curl-win";
}

// ── Per-format path escaping ─────────────────────────────────────────
//
// The path the user pastes is plain text — we don't validate it (we
// can't, the path exists inside the remote session, not the browser),
// but we DO need to make sure characters that have meaning inside the
// quoting style each snippet uses get neutralised, so a path like
// `O'Brien\report.txt` doesn't accidentally close the surrounding
// quote and break the command.
function escapeShellSingleQuoted(path: string): string {
  // bash/zsh single-quoted strings can't contain `'` at all; the
  // canonical escape is `'\''` — close, escaped quote, reopen.
  return path.replace(/'/g, "'\\''");
}
function escapeWinDoubleQuoted(path: string): string {
  // curl.exe on Windows uses MSVCRT-style argv parsing — escape `"`
  // with `\"`. Backslashes are otherwise literal in paths.
  return path.replace(/"/g, '\\"');
}
function escapePowerShellSingleQuoted(path: string): string {
  // PowerShell single-quoted (literal) strings escape `'` by doubling it.
  return path.replace(/'/g, "''");
}

function snippetForOutbound(
  format: SnippetFormat,
  url: string,
  insecure: boolean,
  filePath: string
): string {
  // `--progress-bar` (curl) replaces the verbose default meter with
  // a clean one-line bar — works on multipart uploads (-F), unlike
  // some -X POST permutations that disable progress.
  //
  // `-H "Expect:"` disables curl's default `Expect: 100-continue`
  // header. Without this, curl waits for the server to send `100
  // Continue` before uploading the body. Our ingest endpoint
  // validates the one-shot token BEFORE reading the multipart, so
  // a stale/consumed token gets a 400 instantly and curl never
  // uploads the body — meaning the progress bar has nothing to
  // render. Forcing the body up immediately makes progress visible
  // for any non-trivial file even when the server eventually
  // rejects (e.g. AV block).
  //
  // `-w "..."` (write-out format) prints a one-line summary AFTER
  // the upload completes. We add it because `--progress-bar` may
  // not be visible in every terminal/curl combination — notably
  // (a) when the upload completes faster than curl's tty refresh
  // (LAN / localhost transfers of even 100+ MB can finish in well
  // under a second), and (b) on some Windows curl builds where
  // the bar's `\r` redraw is swallowed by the host. The `-w`
  // payload writes to stdout AFTER the response, so the user
  // always sees `Done: <N> bytes in <T>s (HTTP <code>)` regardless
  // of whether the live bar painted anything. `%{size_upload}` is
  // the actual body byte count curl pushed; `%{time_total}` is
  // wall-clock seconds from process start to last byte received;
  // `%{http_code}` is the final HTTP status — 200 on accept, 400
  // on stale-token / AV-block / payload-too-large, etc.
  // Substitute the `<your-file>` placeholder when the user has filled
  // in the path input. Each format has a slightly different anchor
  // string so the prefix (`./` for the *nix curl form) drops cleanly
  // when the user pastes an absolute path.
  const trimmedPath = filePath.trim();
  switch (format) {
    case "curl":
      return insecure
        ? `curl -kfL --progress-bar -H 'Expect:' -F 'file=@${
            trimmedPath ? escapeShellSingleQuoted(trimmedPath) : "./<your-file>"
          }' -w '\\nDone: %{size_upload} bytes in %{time_total}s (HTTP %{http_code})\\n' '${url}'`
        : `curl -fL --progress-bar -H 'Expect:' -F 'file=@${
            trimmedPath ? escapeShellSingleQuoted(trimmedPath) : "./<your-file>"
          }' -w '\\nDone: %{size_upload} bytes in %{time_total}s (HTTP %{http_code})\\n' '${url}'`;
    case "curl-win":
      return insecure
        ? `curl.exe -kfL --progress-bar -H "Expect:" -F "file=@${
            trimmedPath ? escapeWinDoubleQuoted(trimmedPath) : "<your-file>"
          }" -w "\\nDone: %{size_upload} bytes in %{time_total}s (HTTP %{http_code})\\n" "${url}"`
        : `curl.exe -fL --progress-bar -H "Expect:" -F "file=@${
            trimmedPath ? escapeWinDoubleQuoted(trimmedPath) : "<your-file>"
          }" -w "\\nDone: %{size_upload} bytes in %{time_total}s (HTTP %{http_code})\\n" "${url}"`;
    case "powershell": {
      // PowerShell 7+. Built around a streaming HttpClient + a
      // background-task poll loop so we can paint a Write-Progress
      // bar as bytes leave the box — `Invoke-WebRequest -Form` is
      // known to NOT emit progress for file uploads (only for the
      // response download), so it's useless for our purposes.
      //
      // The `${...}` substitutions below are JavaScript template
      // expressions — only the literal `${url}` and `${tlsBypass}`
      // are resolved at JS render time; every PowerShell `$x` is
      // backslash-escaped so it lands in the snippet as a literal
      // dollar sign.
      const tlsBypass = insecure
        ? "[Net.ServicePointManager]::ServerCertificateValidationCallback = {$true}\n"
        : "";
      return (
        tlsBypass +
        [
          `$file = Get-Item '${
            trimmedPath ? escapePowerShellSingleQuoted(trimmedPath) : "<your-file>"
          }'`,
          `$total = $file.Length`,
          `$client = [System.Net.Http.HttpClient]::new()`,
          `$client.Timeout = [TimeSpan]::FromHours(1)`,
          `$client.DefaultRequestHeaders.ExpectContinue = $false`,
          `$form = [System.Net.Http.MultipartFormDataContent]::new()`,
          `$stream = $file.OpenRead()`,
          `$content = [System.Net.Http.StreamContent]::new($stream)`,
          `$form.Add($content, 'file', $file.Name)`,
          `$task = $client.PostAsync('${url}', $form)`,
          `while (-not $task.IsCompleted) {`,
          `  $sent = $stream.Position`,
          `  $pct  = if ($total -gt 0) { [int](($sent / $total) * 100) } else { 0 }`,
          `  Write-Progress -Activity "Uploading $($file.Name)" -Status "$sent / $total bytes" -PercentComplete $pct`,
          `  Start-Sleep -Milliseconds 250`,
          `}`,
          `Write-Progress -Activity "Uploading $($file.Name)" -Completed`,
          `$stream.Close()`,
          `$response = $task.Result`,
          `$body = $response.Content.ReadAsStringAsync().Result`,
          `$client.Dispose()`,
          `if ($response.IsSuccessStatusCode) { Write-Host "Upload complete:" $body } else { Write-Error "HTTP $($response.StatusCode): $body"; exit 1 }`,
        ].join("\n")
      );
    }
  }
}

function formatExpiry(secondsLeft: number): string {
  if (secondsLeft <= 0) return "expired";
  const m = Math.floor(secondsLeft / 60);
  const s = secondsLeft % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Outbound Quick-Share panel — companion to the in-session interceptor
 * wired into `SessionManager.client.onfile`.
 *
 * Outbound file transfer is **triggered from inside the remote session**:
 * the user copies a file to the Strata virtual drive (mapped as a network
 * drive inside the RDP / VNC session — typically named "Strata" or
 * configured on the connection's "Drive" tab). guacd streams the bytes
 * back over the existing tunnel, the browser intercepts them, and
 * routes them to `/api/user/outbound-shares` for DLP scan + approval
 * gate instead of auto-downloading.
 *
 * This panel does not present a local file picker because that would
 * be exporting from the user's *laptop*, not from the *session*. Instead
 * it shows:
 *   1. How to trigger an outbound transfer from inside the session.
 *   2. A justification textarea — attached to the *next* file intercepted
 *      from the currently active session (cleared automatically after
 *      that file is submitted).
 *   3. The user's submission history with status + download links for
 *      approved files.
 */
export default function QuickShareOutbound({ onClose, sidebarWidth, sessionBarCollapsed }: Props) {
  const { sessions, activeSessionId, updateSession, outboundShareBypass } = useSessionManager();
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const driveName = activeSession?.filesystems[0]?.name ?? null;
  const driveProtocol = activeSession?.protocol?.toLowerCase() ?? "";

  // Backend chokepoint (`validate_outbound_justification`) requires at
  // least 10 chars of justification on every submission unless the
  // per-user approval bypass is on. We mirror the rule here so the UI
  // shows a clear "required" affordance, the snippet-mint button
  // disables until it's met, and the toast on a drive-redirected file
  // (raised by SessionManager) matches what the user sees in this
  // panel.
  const MIN_JUSTIFICATION_LEN = 10;
  const justificationRequired = !outboundShareBypass;

  const [history, setHistory] = useState<OutboundShare[]>([]);
  const [loading, setLoading] = useState(false);
  const [justification, setJustificationState] = useState<string>(
    activeSession?.pendingOutboundJustification ?? ""
  );

  // ── Status-transition notifications ───────────────────────────────
  //
  // The HTTPS-upload path mints a token and the upload happens inside
  // the remote session shell, so the in-session interceptor's
  // `strata:outbound-share-submitted` event never fires for this
  // panel. Without polling the user would have no idea that their
  // submission landed or was approved. We poll periodically (cheap:
  // backend query is indexed on user_id) and, when a row transitions
  // from `pending` to a terminal status, we surface a dismissible
  // banner at the top of the panel that links straight to the
  // download — so the user doesn't have to scroll past the upload
  // snippet to discover their file is ready.
  type StatusNotification = {
    id: string;
    filename: string;
    status: "approved" | "denied" | "purged";
    download_token?: string;
  };
  const [notifications, setNotifications] = useState<StatusNotification[]>([]);
  // Previous status keyed by share id. A ref so updates don't trigger
  // re-renders and so the very first refresh seeds the map without
  // firing spurious "approved" banners for shares that were already
  // approved before the panel opened.
  const prevStatusRef = useRef<Map<string, string> | null>(null);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((curr) => curr.filter((n) => n.id !== id));
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listMyOutboundShares();
      setHistory(list);

      // First load → just seed the previous-status map silently.
      if (prevStatusRef.current === null) {
        const seed = new Map<string, string>();
        for (const item of list) seed.set(item.id, item.status);
        prevStatusRef.current = seed;
      } else {
        const prev = prevStatusRef.current;
        const fresh: StatusNotification[] = [];
        for (const item of list) {
          const before = prev.get(item.id);
          if (
            before === "pending" &&
            (item.status === "approved" || item.status === "denied" || item.status === "purged")
          ) {
            fresh.push({
              id: item.id,
              filename: item.filename,
              status: item.status,
              download_token: item.download_token ?? undefined,
            });
          }
          prev.set(item.id, item.status);
        }
        if (fresh.length > 0) {
          // De-dupe by id in case a notification for this share is
          // still on-screen (e.g. user hasn't dismissed it yet).
          setNotifications((curr) => {
            const byId = new Map(curr.map((n) => [n.id, n] as const));
            for (const n of fresh) byId.set(n.id, n);
            return Array.from(byId.values());
          });
        }
      }
    } catch {
      // ignore — surface via empty state
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + refresh whenever the interceptor in SessionManager
  // dispatches the submitted event.
  useEffect(() => {
    refresh();
    const onSubmitted = () => {
      refresh();
    };
    window.addEventListener("strata:outbound-share-submitted", onSubmitted);
    return () => window.removeEventListener("strata:outbound-share-submitted", onSubmitted);
  }, [refresh]);

  // Poll while the panel is open so HTTPS-upload submissions and
  // approver decisions surface without the user having to manually
  // hit Refresh. 10 s is snappy enough to feel live but cheap enough
  // not to matter — the backend list query is indexed on user_id and
  // bounded by `LIMIT 50`.
  useEffect(() => {
    const id = window.setInterval(() => {
      refresh();
    }, 10_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Keep the textarea seeded with whatever pending justification the
  // session already has (so flipping between sessions doesn't lose text).
  useEffect(() => {
    setJustificationState(activeSession?.pendingOutboundJustification ?? "");
  }, [activeSession?.id, activeSession?.pendingOutboundJustification]);

  const setJustification = useCallback(
    (text: string) => {
      setJustificationState(text);
      if (activeSession) {
        updateSession(activeSession.id, {
          pendingOutboundJustification: text.trim() ? text : undefined,
        });
      }
    },
    [activeSession, updateSession]
  );

  // ── HTTPS upload-command flow ──────────────────────────────────────
  //
  // For environments where RDP drive redirection is blocked by GPO the
  // guacd `onfile` interception path never fires. The user instead
  // mints a single-use token here, pastes the generated `curl` /
  // `Invoke-WebRequest` snippet inside the remote session shell, and
  // the upload comes back over HTTPS to the public ingest endpoint.

  const [snippetFormat, setSnippetFormat] = useState<SnippetFormat>(() =>
    defaultSnippetFormat(driveProtocol)
  );
  const [insecureTls, setInsecureTls] = useState(false);
  // Optional file-path input. When non-empty it's substituted into the
  // snippet with per-format quoting so the user can paste a fully
  // run-ready command into the remote session shell without having to
  // hand-edit `<your-file>`.
  const [filePath, setFilePath] = useState("");
  const [ingestToken, setIngestToken] = useState<OutboundShareIngestToken | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Re-pick the snippet default when the active session's protocol
  // changes (e.g. switching from an RDP tab to an SSH tab).
  useEffect(() => {
    setSnippetFormat(defaultSnippetFormat(driveProtocol));
  }, [driveProtocol]);

  // Tick the expiry countdown only while a token is live.
  useEffect(() => {
    if (!ingestToken) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ingestToken]);

  const issueToken = useCallback(async () => {
    if (!activeSession) return;
    setIssuing(true);
    setIssueError(null);
    try {
      const minted = await issueOutboundShareIngestToken({
        session_id: activeSession.id,
        connection_id: activeSession.connectionId,
        justification: justification.trim() || undefined,
      });
      setIngestToken(minted);
      setCopied(false);
      setNowMs(Date.now());
    } catch (e) {
      setIssueError(e instanceof Error ? e.message : "Failed to mint upload token");
    } finally {
      setIssuing(false);
    }
  }, [activeSession, justification]);

  const uploadUrl = useMemo(
    () => (ingestToken ? `${window.location.origin}${ingestToken.upload_path}` : ""),
    [ingestToken]
  );
  const snippet = useMemo(
    () => (ingestToken ? snippetForOutbound(snippetFormat, uploadUrl, insecureTls, filePath) : ""),
    [ingestToken, snippetFormat, uploadUrl, insecureTls, filePath]
  );
  const expiresInSec = ingestToken
    ? Math.max(0, Math.floor((new Date(ingestToken.expires_at).getTime() - nowMs) / 1000))
    : 0;
  const tokenExpired = !!ingestToken && expiresInSec <= 0;

  const copySnippet = useCallback(async () => {
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied — user can still select manually */
    }
  }, [snippet]);

  return (
    <div
      className="fixed top-0 bottom-0 z-[101] w-[360px] bg-surface-secondary border-l border-white/10 shadow-2xl flex flex-col"
      style={{ right: sessionBarCollapsed ? 0 : sidebarWidth }}
    >
      {/* Single inline keyframe definition for the "awaiting scan"
          indeterminate bar on `pending` rows below. Defining the same
          @keyframes block twice (e.g. another instance of this panel
          opens) is a no-op per the CSS spec, so this is safe to
          inline even when React mounts multiple copies. */}
      <style>{`
        @keyframes strata-outbound-pending {
          0%   { left: -33%; }
          100% { left: 100%; }
        }
      `}</style>
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-white/5 bg-black/20">
        <div className="flex items-center gap-2">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 9v10a2 2 0 002 2h14a2 2 0 002-2V9" />
            <polyline points="7 4 12 9 17 4" />
            <line x1="12" y1="9" x2="12" y2="21" />
          </svg>
          <span className="text-sm font-bold tracking-tight">Outbound Share</span>
        </div>
        <button
          onClick={onClose}
          aria-label="Close outbound share panel"
          className="text-txt-secondary hover:text-txt-primary"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Status-change notifications (pending → approved/denied/purged) */}
      {notifications.length > 0 && (
        <div className="p-3 border-b border-white/5 space-y-2">
          {notifications.map((n) => {
            const isApproved = n.status === "approved";
            const tone = isApproved
              ? "bg-success-dim border-success/30"
              : "bg-danger/10 border-danger/30";
            const heading = isApproved
              ? "File approved — ready to download"
              : n.status === "denied"
                ? "File denied by approver"
                : "File purged";
            const headingColor = isApproved ? "text-success" : "text-danger";
            return (
              <div
                key={n.id}
                role="status"
                className={`rounded border ${tone} p-2 text-xs flex items-start gap-2`}
              >
                <div className="flex-1 min-w-0 space-y-1">
                  <div className={`font-semibold ${headingColor}`}>{heading}</div>
                  <div className="truncate text-txt-primary" title={n.filename}>
                    {n.filename}
                  </div>
                  {isApproved && n.download_token && (
                    <a
                      href={outboundShareDownloadUrl(n.download_token)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block mt-1 px-2 py-1 rounded bg-success text-bg-primary font-semibold text-[11px]"
                      onClick={() => dismissNotification(n.id)}
                    >
                      Download to this device →
                    </a>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => dismissNotification(n.id)}
                  aria-label="Dismiss notification"
                  className="text-txt-secondary hover:text-txt-primary"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Scrollable body — everything below the header and the
          (sticky) notifications banner. Wrapping all three sections
          in a single overflow-y-auto container ensures the user can
          always scroll the how-to + upload-snippet cards out of the
          way to reach the submissions history, no matter how tall
          the panel content gets. */}
      <div className="flex-1 overflow-y-auto">
        {/* How-to banner.
            Hidden when the active connection has file transfer disabled
            (drive redirection is the subject of this banner, so it's
            noise on connections where the user must fall back to the
            HTTPS upload below). Still shown when no session is active
            so the informational copy and the "open or focus a session"
            hint remain discoverable.

            The justification textarea was originally nested here too,
            which meant it disappeared on connections with file
            transfer disabled — exactly the case where the HTTPS upload
            card below NEEDS a justification to mint a token. v1.12.2
            pulled the textarea out into its own always-rendered block
            below so both surfaces (drive-channel interception AND the
            HTTPS snippet) share a single source of truth. */}
        {!(activeSession && !activeSession.fileTransferEnabled) && (
          <div className="p-4 border-b border-white/5 space-y-3 text-xs">
            <div className="rounded bg-accent/10 border border-accent/20 p-3 space-y-2">
              <div className="font-semibold text-accent-bright">
                How to export a file from this session
              </div>
              <ol className="list-decimal list-inside space-y-1 text-txt-secondary">
                <li>
                  Inside the remote desktop, open the Strata virtual drive
                  {driveName ? (
                    <span>
                      {" "}
                      (mapped as <span className="font-mono text-accent">{driveName}</span>)
                    </span>
                  ) : driveProtocol === "rdp" ? (
                    <span>
                      {" "}
                      (mapped under <span className="font-mono">This PC</span>)
                    </span>
                  ) : null}
                  .
                </li>
                <li>Copy or drag the file you want to export into that drive.</li>
                <li>
                  The file is intercepted here, scanned for sensitive data, and either auto-approved
                  or queued for an approver.
                </li>
                <li>Approved files appear below with a one-time download link.</li>
              </ol>
              {!activeSession && (
                <div className="text-warning text-[11px]">
                  Open or focus a session to enable outbound transfers.
                </div>
              )}
            </div>
          </div>
        )}

        {/* Justification textarea — always rendered (when a session is
            active OR even when not, so the user can see the rule).
            Both the drive-channel interception path AND the HTTPS
            upload-snippet path below feed the same backend pipeline,
            and both honour the same 10-char justification rule unless
            the user has approval-bypass. Keeping the field outside the
            how-to conditional above ensures it stays reachable when
            file transfer (drive redirection) is disabled and the
            HTTPS snippet is the user's ONLY way to export a file. */}
        <div className="p-4 border-b border-white/5 text-xs">
          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-txt-tertiary">
              Justification for the next file{" "}
              {justificationRequired ? (
                <span className="text-danger" aria-hidden="true">
                  *
                </span>
              ) : (
                <span className="normal-case">(optional)</span>
              )}
            </span>
            <textarea
              className="w-full mt-1 px-2 py-1 text-xs bg-black/20 border border-white/10 rounded resize-none"
              rows={2}
              placeholder={
                justificationRequired
                  ? 'Required — e.g. "Audit ticket INC-1234, exporting redacted log for review"'
                  : "Why does the next exported file need to leave the session?"
              }
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              maxLength={1000}
              disabled={!activeSession}
              aria-required={justificationRequired}
            />
            <span className="block mt-1 text-[10px] text-txt-tertiary">
              {justificationRequired
                ? `Required for your account (minimum ${MIN_JUSTIFICATION_LEN} characters). Attached to the next file intercepted from this session OR to the next HTTPS-snippet upload, then cleared.`
                : "Attached to the next file intercepted from this session OR to the next HTTPS-snippet upload, then cleared."}
            </span>
          </label>
        </div>

        {/* HTTPS upload snippet (fallback when drive redirection is blocked) */}
        <div className="p-4 border-b border-white/5 space-y-3 text-xs">
          <div className="rounded bg-warning/5 border border-warning/20 p-3 space-y-2">
            <div className="font-semibold text-warning">
              Drive redirection blocked? Use HTTPS upload
            </div>
            <p className="text-txt-secondary text-[11px] leading-snug">
              When the virtual drive isn&apos;t available (commonly because group policy blocks RDP
              drive redirection at the target), mint a one-shot upload command instead. Paste it
              into a terminal or PowerShell window
              <em> inside the remote session</em>; the file flows back over HTTPS on the same
              connection your browser is already using — no SMB, no port 445, no drive channel.
            </p>

            <div className="space-y-2">
              <label
                htmlFor="outbound-snippet-format"
                className="block text-[10px] font-bold uppercase tracking-wider text-txt-tertiary"
              >
                Snippet format
              </label>
              <Select
                id="outbound-snippet-format"
                value={snippetFormat}
                onChange={(v) => setSnippetFormat(v as SnippetFormat)}
                options={[
                  { value: "curl", label: "curl (Linux / macOS)" },
                  { value: "curl-win", label: "curl (Windows 10+)" },
                  { value: "powershell", label: "PowerShell 7+" },
                ]}
              />
              <label
                htmlFor="outbound-file-path"
                className="block text-[10px] font-bold uppercase tracking-wider text-txt-tertiary pt-1"
              >
                File path (optional)
              </label>
              <input
                id="outbound-file-path"
                type="text"
                value={filePath}
                onChange={(e) => setFilePath(e.target.value)}
                placeholder={
                  snippetFormat === "curl" ? "/home/user/report.pdf" : "C:\\Users\\you\\report.pdf"
                }
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="w-full px-2 py-1 text-xs font-mono rounded bg-black/40 border border-white/10 text-txt-primary placeholder:text-txt-tertiary focus:outline-none focus:border-accent"
              />
              <p className="text-[10px] text-txt-tertiary leading-snug">
                Paste the path of the file you want to export from inside the remote session and the
                snippet below becomes paste-and-run. Leave blank to keep the
                <span className="font-mono"> &lt;your-file&gt;</span> placeholder.
              </p>
              <label
                htmlFor="outbound-insecure-tls"
                className="flex items-center gap-2.5 cursor-pointer select-none group pt-1"
                title="Adds -k / ServicePointManager bypass so the snippet works against a Strata server with a self-signed or internal-CA TLS cert."
              >
                <input
                  id="outbound-insecure-tls"
                  type="checkbox"
                  checked={insecureTls}
                  onChange={(e) => setInsecureTls(e.target.checked)}
                  className="h-4 w-4 shrink-0 rounded border border-white/20 bg-white/5 accent-accent cursor-pointer"
                />
                <span className="text-xs text-txt-secondary group-hover:text-txt-primary transition-colors">
                  Skip TLS cert check
                </span>
              </label>
            </div>

            <button
              type="button"
              className="w-full px-3 py-1.5 text-xs rounded bg-accent text-bg-primary font-semibold disabled:opacity-50"
              onClick={issueToken}
              disabled={
                !activeSession ||
                issuing ||
                (justificationRequired && justification.trim().length < MIN_JUSTIFICATION_LEN)
              }
              title={
                justificationRequired && justification.trim().length < MIN_JUSTIFICATION_LEN
                  ? `Enter at least ${MIN_JUSTIFICATION_LEN} characters of justification above before generating the upload command.`
                  : undefined
              }
            >
              {issuing
                ? "Generating…"
                : ingestToken && !tokenExpired
                  ? "Regenerate upload command"
                  : "Generate upload command"}
            </button>

            {issueError && <div className="text-[11px] text-danger">{issueError}</div>}

            {ingestToken && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-[10px] text-txt-tertiary">
                  <span>
                    {tokenExpired
                      ? "Token expired — generate a new one."
                      : `Expires in ${formatExpiry(expiresInSec)}`}
                  </span>
                  <button
                    type="button"
                    onClick={copySnippet}
                    disabled={tokenExpired}
                    className="text-accent hover:text-accent-bright disabled:opacity-50"
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre className="text-[10px] whitespace-pre-wrap break-all bg-black/40 border border-white/5 rounded p-2 font-mono text-txt-primary">
                  {snippet}
                </pre>
                <p className="text-[10px] text-txt-tertiary leading-snug">
                  {filePath.trim() ? (
                    <>
                      The command is single-use — it stops working as soon as one upload completes
                      or the timer hits zero.
                    </>
                  ) : (
                    <>
                      Replace <span className="font-mono">&lt;your-file&gt;</span> with the path of
                      the file you want to export, or fill in the <em>File path</em> input above to
                      have it substituted automatically. The command is single-use — it stops
                      working as soon as one upload completes or the timer hits zero.
                    </>
                  )}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* History */}
        <div className="p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-txt-tertiary">
              My submissions
            </span>
            <button
              className="text-[10px] text-txt-secondary hover:text-txt-primary"
              onClick={refresh}
              disabled={loading}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {history.length === 0 ? (
            <div className="text-[11px] text-txt-tertiary italic">No submissions yet.</div>
          ) : (
            history.map((h) => (
              <div
                key={h.id}
                className="rounded border border-white/5 bg-black/20 p-2 text-xs space-y-1"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider ${statusClasses(h.status)}`}
                  >
                    {h.status}
                  </span>
                  {h.purged_at && h.status !== "purged" && (
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider bg-white/5 text-txt-tertiary"
                      title={`Sealed material removed from disk at ${new Date(h.purged_at).toLocaleString()}.`}
                    >
                      Cleaned
                    </span>
                  )}
                  <span className="truncate flex-1 font-medium">{h.filename}</span>
                </div>
                <div className="text-[10px] text-txt-tertiary">
                  {formatSize(h.size)} · DLP {h.dlp_score} ·{" "}
                  {new Date(h.created_at).toLocaleString()}
                </div>
                {/* Live AV-scan / approval-queue indicator. Backend has
                    no streaming progress for clamd INSTREAM scans, so
                    we render an indeterminate sweep while the row sits
                    in `pending` — it absorbs both the AV-scan window
                    and any subsequent approver-review wait, which from
                    the user's POV are indistinguishable. */}
                {h.status === "pending" && (
                  <div className="pt-1">
                    <div
                      role="progressbar"
                      aria-label={`Awaiting scan and approval: ${h.filename}`}
                      className="relative h-1 w-full overflow-hidden rounded bg-warning/10"
                    >
                      <div
                        className="absolute top-0 h-full w-1/3 rounded bg-warning/70"
                        style={{
                          animation: "strata-outbound-pending 1.4s ease-in-out infinite",
                        }}
                      />
                    </div>
                    <div className="text-[10px] text-txt-tertiary mt-0.5">
                      Awaiting AV scan{h.dlp_score === 0 ? " and approval" : ""}…
                    </div>
                  </div>
                )}
                {h.dlp_reasons.length > 0 && (
                  <div className="text-[10px] text-txt-tertiary">
                    Flags: {h.dlp_reasons.join(", ")}
                  </div>
                )}
                {h.decision_reason && (
                  <div className="text-[10px] text-txt-tertiary italic">
                    Approver: {h.decision_reason}
                  </div>
                )}
                {h.status === "approved" && h.download_token && (
                  <a
                    href={outboundShareDownloadUrl(h.download_token)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent underline text-[10px]"
                  >
                    Download →
                  </a>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
