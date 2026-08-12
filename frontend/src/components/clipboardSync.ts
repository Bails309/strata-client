import Guacamole from "guacamole-common-js";
import { preparePastePayload } from "./pastePayload";

/**
 * Centralised local → remote clipboard transmission, plus a diagnostic
 * ring buffer covering both directions.
 *
 * Why this module exists
 * ----------------------
 * Pushing the local clipboard to the remote used to be an inline copy of
 * the same "open a clipboard stream, chunk the text, sendEnd" dance in
 * five places: SessionManager's `mouseenter`/`mousedown`/`focus` handler,
 * SessionManager's window `paste` handler, the pop-out window's *own*
 * pair of handlers (registered on the *same* `displayEl`), the session
 * menu textarea, and the command palette.
 *
 * A single click on a popped-out session therefore fired up to four of
 * those copies. Each one re-read `session.remoteClipboard` *before* any
 * of them had finished writing, so the "have we already sent this?" guard
 * passed for all of them, and each opened its own Guacamole clipboard
 * stream. The large-payload path awaits between chunks, so the `blob`
 * instructions from the concurrent streams interleave on the wire.
 *
 * guacd's RDP clipboard is a single shared buffer that is reset by the
 * `clipboard` instruction and appended to by every `blob` regardless of
 * stream index. Interleaved streams therefore splice two payloads
 * together and announce the result over CLIPRDR twice. Windows' clipboard
 * owner (`rdpclip.exe`) can be left waiting on a format-data response
 * that never matches, at which point copy *and* paste stay dead for the
 * remainder of the Windows session — reconnecting the tunnel does not
 * help, because the wedged state lives in the Windows session, not in
 * guacd. Logging off and back on restarts `rdpclip.exe` and clears it.
 *
 * Routing every push through {@link sendClipboardToRemote} serialises
 * transmission per session, so only one clipboard stream is ever open at
 * a time.
 */

/** Max characters per `blob` instruction. Keeps us well under guacd's instruction cap. */
const CHUNK_SIZE = 4096;

/** Pause between chunks so guacd's reassembly buffer is not burst-flooded. */
const CHUNK_DELAY_MS = 5;

/** Entries retained by the in-memory diagnostic ring buffer. */
const LOG_RING_SIZE = 500;

/**
 * `Guacamole.Tunnel.State.CLOSED`, inlined. The vendor enum is not
 * reachable on every build (and is absent under test mocks), but the
 * numeric protocol values are stable.
 */
const TUNNEL_CLOSED = 2;

export type ClipboardDirection = "out" | "in";

export interface ClipboardLogEntry {
  /** `Date.now()` at the moment the event was recorded. */
  at: number;
  /** Owning `GuacSession.id`. */
  sessionId: string;
  /** `out` = local → remote, `in` = remote → local. */
  dir: ClipboardDirection;
  /** Short machine-readable event name. */
  event: string;
  detail?: Record<string, unknown>;
}

/** Per-session transmission state. Lives on the session object. */
export interface ClipboardTxState {
  /** Serialisation chain — each send awaits the previous one. */
  chain: Promise<void>;
  /** Text of the most recently *queued* send, for duplicate suppression. */
  queued: string | null;
  /** Monotonic sequence number, for log correlation. */
  seq: number;
}

/**
 * The subset of `GuacSession` this module needs. Declared structurally so
 * `clipboardSync` does not import from `SessionManager` (which imports
 * this module).
 */
export interface ClipboardTarget {
  id: string;
  protocol: string;
  client: Guacamole.Client;
  tunnel: Guacamole.Tunnel;
  remoteClipboard: string;
  _clipboardTx?: ClipboardTxState;
}

// ── Diagnostics ────────────────────────────────────────────────────────

const ring: ClipboardLogEntry[] = [];
let ringNext = 0;
let verbose = readVerboseFlag();

function readVerboseFlag(): boolean {
  try {
    return globalThis.localStorage?.getItem("strata.debug.clipboard") === "1";
  } catch {
    // localStorage throws in sandboxed iframes / when storage is blocked.
    return false;
  }
}

/**
 * Non-reversible 32-bit FNV-1a digest. Lets two log entries be compared
 * for "same text" without ever writing clipboard contents to the console
 * or to a support bundle.
 */
export function clipboardFingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Record a clipboard lifecycle event. Always written to the ring buffer
 * (so a user can be asked for a dump *after* hitting the bug); echoed to
 * the console only while verbose logging is enabled.
 */
export function clipboardDiag(
  sessionId: string,
  dir: ClipboardDirection,
  event: string,
  detail?: Record<string, unknown>
): void {
  const entry: ClipboardLogEntry = { at: Date.now(), sessionId, dir, event, detail };
  ring[ringNext % LOG_RING_SIZE] = entry;
  ringNext++;
  if (verbose) {
    console.debug(`[clipboard:${dir}] ${event}`, { sessionId, ...detail });
  }
}

function snapshot(): ClipboardLogEntry[] {
  if (ringNext <= LOG_RING_SIZE) return ring.slice(0, ringNext);
  const start = ringNext % LOG_RING_SIZE;
  return [...ring.slice(start), ...ring.slice(0, start)];
}

export interface ClipboardDiagnosticsApi {
  /** Turn on console echoing and persist the preference across reloads. */
  enable(): void;
  disable(): void;
  /** Structured entries, oldest first. */
  dump(): ClipboardLogEntry[];
  /** Console table of the ring buffer, for pasting into a bug report. */
  print(): void;
  clear(): void;
}

declare global {
  // eslint-disable-next-line no-var
  var strataClipboard: ClipboardDiagnosticsApi | undefined;
}

/**
 * Publish the diagnostics API on `window.strataClipboard`. Called once
 * from SessionManager module scope so support can walk a user through
 * `strataClipboard.enable()` → reproduce → `strataClipboard.print()`
 * without a new build.
 */
export function installClipboardDiagnostics(): void {
  if (typeof globalThis === "undefined") return;
  globalThis.strataClipboard = {
    enable() {
      verbose = true;
      try {
        globalThis.localStorage?.setItem("strata.debug.clipboard", "1");
      } catch {
        /* storage blocked — verbose still applies for this page load */
      }
      console.info("[clipboard] verbose logging enabled");
    },
    disable() {
      verbose = false;
      try {
        globalThis.localStorage?.removeItem("strata.debug.clipboard");
      } catch {
        /* ignore */
      }
    },
    dump: snapshot,
    print() {
      console.table(
        snapshot().map((e) => ({
          time: new Date(e.at).toISOString(),
          dir: e.dir,
          event: e.event,
          session: e.sessionId,
          ...e.detail,
        }))
      );
    },
    clear() {
      ring.length = 0;
      ringNext = 0;
    },
  };
}

// ── Transmission ───────────────────────────────────────────────────────

function tunnelIsLive(tunnel: Guacamole.Tunnel | undefined): boolean {
  if (!tunnel) return false;
  return tunnel.state !== TUNNEL_CLOSED;
}

function txState(target: ClipboardTarget): ClipboardTxState {
  target._clipboardTx ??= { chain: Promise.resolve(), queued: null, seq: 0 };
  return target._clipboardTx;
}

/**
 * Forget what we believe the remote clipboard holds, so the next push is
 * transmitted even if the text is unchanged. Called when a tunnel
 * (re)connects: the remote end is a brand-new guacd process whose
 * clipboard is empty, and after a reconnect to an *existing* Windows
 * session the CLIPRDR channel has been renegotiated, so re-priming it is
 * the difference between paste working and silently doing nothing.
 */
export function resetRemoteClipboardEcho(target: ClipboardTarget, reason: string): void {
  const tx = txState(target);
  tx.queued = null;
  target.remoteClipboard = "";
  clipboardDiag(target.id, "out", "echo-reset", { reason });
}

export interface SendClipboardOptions {
  /**
   * Transmit even when the text matches what we believe the remote
   * already holds. Used by explicit user commands (command-palette
   * paste-text / open-path, session-bar Paste) where the keystroke that
   * follows is worthless if our belief turns out to be stale.
   */
  force?: boolean;
}

/**
 * Queue `text` for transmission to the session's remote clipboard.
 *
 * Sends are serialised per session, so concurrent callers (the three
 * focus-ish listeners, the window `paste` handler, and the pop-out's own
 * handlers) can never interleave two clipboard streams on the wire.
 *
 * Resolves `true` when the payload was written and acknowledged as sent,
 * `false` when it was suppressed (duplicate / disconnected) or failed.
 * `remoteClipboard` is only updated on success, so a send that lands on a
 * dead tunnel does not poison the duplicate-suppression guard and
 * permanently swallow later pastes of the same text.
 */
export function sendClipboardToRemote(
  target: ClipboardTarget,
  text: string,
  source: string,
  options: SendClipboardOptions = {}
): Promise<boolean> {
  if (!text) return Promise.resolve(false);

  const tx = txState(target);

  if (!options.force && (text === target.remoteClipboard || text === tx.queued)) {
    clipboardDiag(target.id, "out", "skip-duplicate", {
      source,
      chars: text.length,
      fp: clipboardFingerprint(text),
    });
    return Promise.resolve(false);
  }

  if (!tunnelIsLive(target.tunnel)) {
    clipboardDiag(target.id, "out", "skip-disconnected", {
      source,
      chars: text.length,
      tunnelState: target.tunnel?.state,
    });
    return Promise.resolve(false);
  }

  const seq = ++tx.seq;
  tx.queued = text;
  clipboardDiag(target.id, "out", "queued", {
    source,
    seq,
    chars: text.length,
    fp: clipboardFingerprint(text),
  });

  const run = tx.chain.then(() => writeClipboardStream(target, text, source, seq));
  // Keep the chain usable after a failure — an unhandled rejection here
  // would wedge every subsequent push for the session.
  tx.chain = run.then(
    () => undefined,
    () => undefined
  );
  return run.then(
    (ok) => ok,
    () => false
  );
}

async function writeClipboardStream(
  target: ClipboardTarget,
  text: string,
  source: string,
  seq: number
): Promise<boolean> {
  const tx = txState(target);
  const clearQueued = () => {
    if (tx.queued === text) tx.queued = null;
  };

  // Re-check: the tunnel may have dropped while we waited our turn.
  if (!tunnelIsLive(target.tunnel)) {
    clipboardDiag(target.id, "out", "abort-disconnected", { source, seq });
    clearQueued();
    return false;
  }

  const payload = preparePastePayload(text, target.protocol);
  const chunks = Math.max(1, Math.ceil(payload.length / CHUNK_SIZE));
  const startedAt = Date.now();

  clipboardDiag(target.id, "out", "stream-open", {
    source,
    seq,
    chars: text.length,
    payloadChars: payload.length,
    chunks,
    fp: clipboardFingerprint(text),
  });

  let stream: Guacamole.OutputStream;
  try {
    stream = target.client.createClipboardStream("text/plain");
  } catch (err) {
    clipboardDiag(target.id, "out", "stream-open-failed", { source, seq, err: String(err) });
    clearQueued();
    return false;
  }

  const writer = new Guacamole.StringWriter(stream);
  let acks = 0;
  writer.onack = (status: Guacamole.Status) => {
    acks++;
    // guacd acks every blob. A stream that stops being acked mid-transfer
    // is the signature of a wedged CLIPRDR channel on the remote side.
    if (status?.isError?.()) {
      clipboardDiag(target.id, "out", "ack-error", {
        seq,
        acks,
        code: status.code,
        message: status.message,
      });
    } else if (verbose) {
      clipboardDiag(target.id, "out", "ack", { seq, acks });
    }
  };

  try {
    for (let i = 0; i < payload.length; i += CHUNK_SIZE) {
      if (!tunnelIsLive(target.tunnel)) {
        clipboardDiag(target.id, "out", "abort-mid-stream", {
          source,
          seq,
          sentChars: i,
          acks,
        });
        clearQueued();
        return false;
      }
      writer.sendText(payload.substring(i, i + CHUNK_SIZE));
      if (chunks > 1) await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
    }
    writer.sendEnd();
  } catch (err) {
    clipboardDiag(target.id, "out", "stream-failed", { source, seq, err: String(err), acks });
    clearQueued();
    return false;
  }

  target.remoteClipboard = text;
  clearQueued();
  clipboardDiag(target.id, "out", "stream-end", {
    source,
    seq,
    chunks,
    acks,
    ms: Date.now() - startedAt,
  });
  return true;
}
