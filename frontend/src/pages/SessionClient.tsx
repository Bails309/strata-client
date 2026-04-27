import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import Guacamole from "guacamole-common-js";
import {
  getConnectionInfo,
  getConnections,
  createTunnelTicket,
  getCredentialProfiles,
  updateCredentialProfile,
  requestCheckout,
  linkCheckoutToProfile,
  CredentialProfile,
  ConnectionInfo,
} from "../api";
import { useSessionManager, GuacSession } from "../components/SessionManager";
import { useSidebarWidth } from "../components/Layout";
import { usePopOut } from "../components/usePopOut";
import { useMultiMonitor } from "../components/useMultiMonitor";
import SessionWatermark from "../components/SessionWatermark";
import Select from "../components/Select";
import { createWinKeyProxy } from "../utils/winKeyProxy";
import { installShortcutProxy } from "../utils/shortcutProxy";
import { installKeyboardLock } from "../utils/keyboardLock";
import CommandPalette from "../components/CommandPalette";
import { useUserPreferences } from "../components/UserPreferencesProvider";
import {
  parseBinding,
  matchesBinding,
  DEFAULT_COMMAND_PALETTE_BINDING,
} from "../utils/keybindings";

/*
 * Phases:
 *  1. "loading"   – fetching connection info from the backend
 *  2. "prompt"    – no stored credentials; show pre-connect credential form
 *  3. "connected" – WebSocket tunnel open, Guacamole session running
 */
type Phase = "loading" | "prompt" | "connected";

/** Reconnection state (null = not reconnecting) */
interface ReconnectState {
  attempt: number;
  maxAttempts: number;
}

const RECONNECT_MAX_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY = 1000; // 1 second
const RECONNECT_MAX_DELAY = 30000; // 30 seconds

export default function SessionClient() {
  const { connectionId } = useParams<{ connectionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    sessions,
    activeSessionId,
    setActiveSessionId,
    createSession,
    closeSession,
    getSession,
    barWidth,
  } = useSessionManager();
  const sidebarWidth = useSidebarWidth();

  const [phase, setPhase] = useState<Phase>("loading");
  const [protocol, setProtocol] = useState("");
  const [connectionName, setConnectionName] = useState("");
  const [credForm, setCredForm] = useState<Record<string, string>>({
    username: "",
    password: "",
    domain: "",
  });
  const [error, setError] = useState("");
  const [sshRequired, setSshRequired] = useState<string[] | null>(null);
  const [hasDomain, setHasDomain] = useState(false);
  const [ignoreCert, setIgnoreCert] = useState(false);
  const [connectionWatermark, setConnectionWatermark] = useState<string>("inherit");
  const [fileTransferEnabled, setFileTransferEnabled] = useState(false);
  const [vaultProfiles, setVaultProfiles] = useState<CredentialProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [expiredProfile, setExpiredProfile] = useState<ConnectionInfo["expired_profile"]>();
  const [renewMode, setRenewMode] = useState(false);
  const [renewDuration, setRenewDuration] = useState(60);
  const [renewForm, setRenewForm] = useState({ username: "", password: "" });
  const [renewJustification, setRenewJustification] = useState("");
  const [renewError, setRenewError] = useState("");
  const [renewLoading, setRenewLoading] = useState(false);
  const pendingCredsRef = useRef<{
    username: string;
    password: string;
    credential_profile_id?: string;
  }>({ username: "", password: "" });

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const commandPaletteOpenRef = useRef(false);
  const containerFocusedRef = useRef(false);

  // Live ref to the user-configured command-palette binding. Stored as a
  // pre-parsed object so the hot keydown trap doesn't re-parse on every
  // press. Updated whenever the user changes the preference, without
  // needing to re-bind the keydown listener.
  const { preferences: userPrefs } = useUserPreferences();
  const commandPaletteBindingRef = useRef(
    parseBinding(userPrefs.commandPaletteBinding ?? DEFAULT_COMMAND_PALETTE_BINDING)
  );
  useEffect(() => {
    commandPaletteBindingRef.current = parseBinding(
      userPrefs.commandPaletteBinding ?? DEFAULT_COMMAND_PALETTE_BINDING
    );
  }, [userPrefs.commandPaletteBinding]);

  const [reconnecting, setReconnecting] = useState<ReconnectState | null>(null);
  const [reconnectLoading, setReconnectLoading] = useState(false);
  const userDisconnectRef = useRef(false);
  const serverDisconnectRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wireHandlersRef = useRef<((session: GuacSession, attempt: number) => void) | undefined>(
    undefined
  );
  /** Ref mirror of `error` so effects always read the latest value. */
  const errorRef = useRef("");
  /** Ref mirror of sessions for stable access inside tunnel-close callbacks. */
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  // Find the session for this connection
  const currentSession =
    sessions.find((s) => s.connectionId === connectionId && s.id === activeSessionId) ||
    sessions.find((s) => s.connectionId === connectionId);

  const { isPoppedOut, popOut, returnDisplay } = usePopOut(currentSession, containerRef);
  const {
    isMultiMonitor,
    canMultiMonitor,
    screenCount,
    enableMultiMonitor,
    disableMultiMonitor,
    getLayout,
    updatePrimarySize,
  } = useMultiMonitor(currentSession, containerRef);

  // Keep errorRef in sync with the error state.
  errorRef.current = error;

  // ── Reset stale state when switching to a different connection ──
  const prevConnectionIdRef = useRef(connectionId);
  useEffect(() => {
    if (connectionId !== prevConnectionIdRef.current) {
      prevConnectionIdRef.current = connectionId;
      setError("");
      setReconnecting(null);
      setSshRequired(null);
      setPhase("loading");
      serverDisconnectRef.current = false;
      userDisconnectRef.current = false;
    }
  }, [connectionId]);

  // ── Update browser tab title with connection name ──
  useEffect(() => {
    const name = currentSession?.name || connectionName;
    if (name) {
      document.title = `${name} — Strata`;
    }
    return () => {
      document.title = "Strata Client";
    };
  }, [currentSession?.name, connectionName]);

  // ── Phase 1: Check for existing session or fetch connection info ──
  useEffect(() => {
    if (!connectionId) return;

    const existing = getSession(connectionId);
    if (existing) {
      setActiveSessionId(existing.id);
      setPhase("connected");
      setProtocol(existing.protocol);
      setConnectionName(existing.name);
      return;
    }

    // Don't re-fetch connection info if the session just ended with an error
    // (e.g. server disconnected).  Without this guard, removing the dead session
    // from SessionManager causes getSession to change → this effect re-runs →
    // fetches info → sets phase to 'connected' → Phase 3 creates a new session.
    if (errorRef.current) return;

    let cancelled = false;
    Promise.all([
      getConnectionInfo(connectionId),
      getConnections()
        .then((conns) => conns.find((c) => c.id === connectionId))
        .catch(() => undefined),
    ])
      .then(([info, connDetail]) => {
        if (cancelled) return;
        setProtocol(info.protocol);
        setConnectionName(connDetail?.name || info.protocol.toUpperCase());
        setHasDomain(!!connDetail?.domain);
        setIgnoreCert(!!info.ignore_cert);
        setConnectionWatermark(info.watermark || "inherit");
        setFileTransferEnabled(!!info.file_transfer_enabled);
        if (info.expired_profile) {
          setExpiredProfile(info.expired_profile);
          setRenewMode(true);
          setPhase("prompt"); // Show the checkout / renewal prompt
        } else if (info.has_credentials) {
          setPhase("connected");
        } else if (info.protocol === "rdp") {
          // RDP needs Strata-stored credentials (or the prompt) —
          // there's no host-side mechanism to provision them. VDI
          // bypasses this branch even though it tunnels as RDP:
          // Strata controls both ends of the auth and auto-generates
          // ephemeral creds on the WS handshake.
          setPhase("prompt");
        } else {
          setPhase("connected");
        }
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load connection info");
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, getSession, setActiveSessionId]);

  // Fetch vault credential profiles when the prompt is shown
  useEffect(() => {
    if (phase !== "prompt") return;
    getCredentialProfiles()
      .then((profiles) =>
        setVaultProfiles(
          profiles.filter(
            // Hide expired profiles and internal [managed] placeholder profiles.
            // [managed] profiles are created by the checkout system and are
            // always intended to be consumed via a linked user-named profile
            // (e.g. "CAPITA-ICS SA1"); selecting them directly would send a DN
            // as the username to the remote host.
            (p) => !p.expired && !p.label.startsWith("[managed]")
          )
        )
      )
      .catch(() => {}); // Vault may not be configured
  }, [phase]);

  // ── Phase 2 → 3: user submits credentials ──
  const handlePreConnectSubmit = useCallback(() => {
    pendingCredsRef.current = selectedProfileId
      ? { username: "", password: "", credential_profile_id: selectedProfileId }
      : { username: credForm.username || "", password: credForm.password || "" };
    setPhase("connected");
  }, [credForm, selectedProfileId]);

  // ── Renew expired profile + connect ──
  const handleRenewAndConnect = useCallback(async () => {
    if (!expiredProfile) return;

    setRenewLoading(true);
    setRenewError("");

    try {
      if (expiredProfile.managed_ad_dn) {
        // Managed account — submit checkout request (works for both self-approve and approval-required)
        if (!renewJustification.trim()) {
          setRenewError("Justification is required.");
          setRenewLoading(false);
          return;
        }

        const checkout = await requestCheckout({
          managed_ad_dn: expiredProfile.managed_ad_dn,
          ad_sync_config_id: expiredProfile.ad_sync_config_id,
          requested_duration_mins: renewDuration,
          justification_comment: renewJustification,
        });

        if (checkout.status === "Active") {
          // Self-approved and activated — link and connect immediately
          await linkCheckoutToProfile(expiredProfile.id, checkout.id);
          pendingCredsRef.current = {
            username: "",
            password: "",
            credential_profile_id: expiredProfile.id,
          };
          setPhase("connected");
        } else {
          // Approval required — inform the user and block connection
          setRenewError(
            "Checkout request submitted and is pending administrator approval. You will be able to connect once the request is approved."
          );
          setRenewLoading(false);
        }
      } else {
        // Standard manual renewal
        if (!renewForm.username || !renewForm.password) {
          setRenewError("Username and password are required.");
          setRenewLoading(false);
          return;
        }
        await updateCredentialProfile(expiredProfile.id, {
          username: renewForm.username,
          password: renewForm.password,
        });
        pendingCredsRef.current = {
          username: "",
          password: "",
          credential_profile_id: expiredProfile.id,
        };
        setPhase("connected");
      }
    } catch (err: any) {
      setRenewError(err?.message || "Failed to update credentials.");
    } finally {
      setRenewLoading(false);
    }
  }, [expiredProfile, renewForm, renewDuration, renewJustification]);

  // ── Auto-reconnect: attempt to re-establish a dropped session ──
  const attemptReconnect = useCallback(
    (attempt: number): void => {
      if (!connectionId || !containerRef.current || userDisconnectRef.current) return;

      setReconnecting({ attempt, maxAttempts: RECONNECT_MAX_ATTEMPTS });
      setError("");
      serverDisconnectRef.current = false;

      const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, attempt - 1), RECONNECT_MAX_DELAY);

      reconnectTimerRef.current = setTimeout(async () => {
        if (userDisconnectRef.current) return;
        const container = containerRef.current;
        if (!container) return;

        try {
          const token = localStorage.getItem("access_token") || "";
          const dpr = window.devicePixelRatio || 1;

          const resp = await createTunnelTicket({
            connection_id: connectionId,
            width: container.clientWidth,
            height: container.clientHeight,
            dpi: Math.round(96 * dpr),
            ignore_cert: ignoreCert,
          });

          if (userDisconnectRef.current) return;

          const connectParams = new URLSearchParams();
          connectParams.set("token", token);
          connectParams.set("ticket", resp.ticket);
          connectParams.set("width", String(container.clientWidth));
          connectParams.set("height", String(container.clientHeight));
          connectParams.set("dpi", String(Math.round(96 * dpr)));

          const session = createSession({
            connectionId,
            name: connectionName || protocol.toUpperCase(),
            protocol,
            containerEl: container,
            connectParams,
          });

          session.fileTransferEnabled = fileTransferEnabled;
          wireHandlersRef.current?.(session, attempt);
          attachSession(session, container);
          setReconnecting(null);
        } catch {
          if (attempt >= RECONNECT_MAX_ATTEMPTS) {
            setReconnecting(null);
            setError("Connection lost. Automatic reconnection failed after multiple attempts.");
          } else {
            attemptReconnect(attempt + 1);
          }
        }
      }, delay);
    },
    [connectionId, connectionName, protocol, ignoreCert, createSession]
  );

  // ── Wire error/close handlers onto a session for UI feedback ──
  // Session cleanup (removing from SessionManager) is handled by the
  // tunnel.onstatechange in SessionManager.createSession.  This handler
  // only manages UI: showing the "Session Ended" overlay or triggering
  // reconnection.
  const wireSessionErrorHandlers = useCallback(
    (session: GuacSession, attempt = 0): void => {
      // Tracks whether tunnel.onerror fired BEFORE the tunnel reached CLOSED.
      let tunnelHadError = false;

      const handleTunnelClosed = () => {
        // If the caller explicitly marked this as user-initiated (e.g. manual
        // reconnect), skip all UI side-effects — the caller handles what's next.
        if (userDisconnectRef.current) return;

        // ── Check for remaining sessions ──
        // Redirecting to a live session is safe regardless of how this tunnel
        // closed (server disconnect or clean close without prior error).
        if (serverDisconnectRef.current || !tunnelHadError) {
          const remaining = sessionsRef.current.filter((s) => s.id !== session.id && !s.error);
          if (remaining.length > 0) {
            const next = remaining[remaining.length - 1];
            setActiveSessionId(next.id);

            // Attach the next session's display immediately — unless it's in a
            // pop-out window (stealing its displayEl would black-out the popup).
            const container = containerRef.current;
            if (container && !(next._popout && !next._popout.window.closed)) {
              container.innerHTML = "";
              container.appendChild(next.displayEl);
              const display = next.client.getDisplay();
              const dw = display.getWidth();
              const dh = display.getHeight();
              if (dw > 0 && dh > 0) {
                display.scale(Math.min(container.clientWidth / dw, container.clientHeight / dh));
              }
            }

            navigateRef.current(`/session/${next.connectionId}`);
            return;
          }

          // Last session — always show the "Session Ended" overlay even if
          // userDisconnectRef is stale from prior session switches.
          setReconnecting(null);
          setError(
            session.error || "The remote session has ended. You may have logged out of the server."
          );
          return;
        }

        // Error-based closure (network drop, timeout) → attempt reconnection.
        const elapsed = Date.now() - session.createdAt;
        const nextAttempt = elapsed > 10000 ? 1 : attempt + 1;

        if (nextAttempt > RECONNECT_MAX_ATTEMPTS) {
          setReconnecting(null);
          setError("Connection lost. Automatic reconnection failed after multiple attempts.");
        } else {
          attemptReconnect(nextAttempt);
        }
      };

      // ── Intercept guacd instructions to detect server-initiated disconnects ──
      const clientInstructionHandler = session.tunnel.oninstruction;
      session.tunnel.oninstruction = function (opcode: string, args: string[]) {
        if (opcode === "disconnect" || opcode === "error") {
          serverDisconnectRef.current = true;
        }
        if (clientInstructionHandler) {
          clientInstructionHandler.call(this, opcode, args);
        }
      };

      // ── Wrap tunnel.onstatechange (preserve the SessionManager handler) ──
      const managerTunnelStateHandler = session.tunnel.onstatechange;
      session.tunnel.onstatechange = (state: number) => {
        // Let SessionManager clean up the session from its list first.
        if (managerTunnelStateHandler) {
          managerTunnelStateHandler(state);
        }
        // Then handle UI (overlay / reconnection).
        if (state === 2 /* CLOSED */) {
          handleTunnelClosed();
        }
      };

      // ── Wrap tunnel.onerror (preserve SessionManager handler) ──
      const managerTunnelErrorHandler = session.tunnel.onerror;
      session.tunnel.onerror = (status: Guacamole.Status) => {
        tunnelHadError = true;
        session.error = status.message || "Connection failed";
        if (managerTunnelErrorHandler) {
          managerTunnelErrorHandler(status);
        }
      };

      // ── Wrap client.onerror ──
      const managerClientErrorHandler = session.client.onerror;
      session.client.onerror = (status: Guacamole.Status) => {
        session.error = status.message || "Connection failed";
        if (managerClientErrorHandler) {
          managerClientErrorHandler(status);
        }
      };

      session.client.onrequired = (parameters: string[]) => {
        setSshRequired(parameters);
      };
    },
    [attemptReconnect]
  );

  wireHandlersRef.current = wireSessionErrorHandlers;

  // ── Manual reconnect (imperative — bypasses effect dependency chains) ──
  const handleManualReconnect = useCallback(async () => {
    if (!connectionId || !containerRef.current) return;

    // Keep the error overlay visible during the async reconnect to avoid a
    // black screen flash.  Only clear error after the session is attached.
    setReconnectLoading(true);
    errorRef.current = "";
    setReconnecting(null);
    serverDisconnectRef.current = false;

    // Mark user-initiated so tunnel-close handlers don't fire error overlays
    // or redirect to other sessions.
    userDisconnectRef.current = true;

    // Close any existing live session for this connection first.
    // Capture the session's name before closing — component state may still
    // hold a stale name from a different connection when triggered via the
    // SessionBar reconnect navigate.
    const existing = getSession(connectionId);
    const sessionName = existing?.name || connectionName || protocol.toUpperCase();
    const sessionProtocol = existing?.protocol || protocol;
    if (existing) {
      closeSession(existing.id);
    }

    // Now allow the new session to set up its own error handlers
    userDisconnectRef.current = false;

    const container = containerRef.current;
    const token = localStorage.getItem("access_token") || "";
    const dpr = window.devicePixelRatio || 1;

    try {
      const resp = await createTunnelTicket({
        connection_id: connectionId,
        width: container.clientWidth,
        height: container.clientHeight,
        dpi: Math.round(96 * dpr),
        ignore_cert: ignoreCert,
      });

      const connectParams = new URLSearchParams();
      connectParams.set("token", token);
      connectParams.set("ticket", resp.ticket);
      connectParams.set("width", String(container.clientWidth));
      connectParams.set("height", String(container.clientHeight));
      connectParams.set("dpi", String(Math.round(96 * dpr)));

      const session = createSession({
        connectionId,
        name: sessionName,
        protocol: sessionProtocol,
        containerEl: container,
        connectParams,
      });

      session.fileTransferEnabled = fileTransferEnabled;
      wireHandlersRef.current?.(session, 0);
      attachSession(session, container);

      // Session is created & display attached — now clear the overlay
      setError("");
      errorRef.current = "";
      // Sync component state with the session we just created
      setConnectionName(sessionName);
      setProtocol(sessionProtocol);
      setPhase("connected");
    } catch {
      setError("Failed to reconnect. Please try again.");
    } finally {
      setReconnectLoading(false);
    }
  }, [connectionId, connectionName, protocol, ignoreCert, createSession, closeSession, getSession]);

  // ── Handle reconnect signal from SessionBar ──
  const reconnectStampRef = useRef<number>(0);
  useEffect(() => {
    const stamp = (location.state as any)?.reconnect;
    if (stamp && stamp !== reconnectStampRef.current) {
      reconnectStampRef.current = stamp;
      // Clear router state so a page refresh doesn't re-trigger
      navigate(location.pathname, { replace: true, state: {} });
      handleManualReconnect();
    }
  }, [location.state, location.pathname, navigate, handleManualReconnect]);

  // ── Phase 3: Create or attach session ──
  useEffect(() => {
    if (phase !== "connected" || !connectionId || !containerRef.current) return;

    // Don't create a new session if the previous one ended in an error.
    // Without this guard, cleaning up the dead session triggers a re-render
    // that re-runs this effect and auto-connects to the same (dead) server.
    if (errorRef.current) return;

    const existing = getSession(connectionId);
    if (existing) {
      attachSession(existing, containerRef.current);
      return;
    }

    const container = containerRef.current;

    // Defer to next frame so the fixed-position portal container has its final layout dimensions.
    let cancelled = false;
    const raf = requestAnimationFrame(async () => {
      const token = localStorage.getItem("access_token") || "";
      const dpr = window.devicePixelRatio || 1;
      const creds = pendingCredsRef.current;

      // Obtain a one-time tunnel ticket so credentials never appear in the WebSocket URL
      let ticketId: string | undefined;
      try {
        const resp = await createTunnelTicket({
          connection_id: connectionId,
          username: creds.username || undefined,
          password: creds.password || undefined,
          credential_profile_id: creds.credential_profile_id || undefined,
          width: container.clientWidth,
          height: container.clientHeight,
          dpi: Math.round(96 * dpr),
          ignore_cert: ignoreCert,
        });
        ticketId = resp.ticket;
      } catch {
        if (!cancelled) setError("Failed to create tunnel ticket");
        return;
      }

      if (cancelled) return;

      const connectParams = new URLSearchParams();
      connectParams.set("token", token);
      connectParams.set("ticket", ticketId);
      connectParams.set("width", String(container.clientWidth));
      connectParams.set("height", String(container.clientHeight));
      connectParams.set("dpi", String(Math.round(96 * dpr)));

      const session = createSession({
        connectionId,
        name: connectionName || protocol.toUpperCase(),
        protocol,
        containerEl: container,
        connectParams,
      });

      session.fileTransferEnabled = fileTransferEnabled;
      wireSessionErrorHandlers(session);

      pendingCredsRef.current = { username: "", password: "" };
      setCredForm({ username: "", password: "", domain: "" });

      attachSession(session, container);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [
    phase,
    connectionId,
    protocol,
    connectionName,
    fileTransferEnabled,
    createSession,
    getSession,
    wireSessionErrorHandlers,
    ignoreCert,
  ]);

  // Re-attach when switching back to an existing session
  useEffect(() => {
    if (!currentSession || !containerRef.current || phase !== "connected") return;
    // In multi-monitor mode, ensure the display element is in the container
    // but don't override the scale (multi-monitor manages its own scaling).
    if (currentSession._multiMonitor) {
      const el = currentSession.displayEl;
      if (el.parentElement !== containerRef.current) {
        containerRef.current.innerHTML = "";
        containerRef.current.appendChild(el);
      }
      return;
    }
    attachSession(currentSession, containerRef.current);
  }, [activeSessionId, currentSession, phase]);

  // Handle resize
  useEffect(() => {
    if (!currentSession || !containerRef.current) return;
    const container = containerRef.current!;
    const client = currentSession.client;
    const display = client.getDisplay();

    // ── Ghost-pixel mitigation for RDP GFX / H.264 minimise animations ──
    //
    // Symptom: minimising / maximising a Windows window over RDP
    // occasionally leaves stale pixels in the display canvas. The pixel
    // data is correct at the protocol level (Guacamole.Display has
    // already processed the draw instructions) but the browser
    // compositor doesn't know it needs to repaint the affected region
    // because no CSS property on the display element has changed. Any
    // browser-side resize (sidebar collapse, window resize) clears the
    // ghost because it triggers display.scale() with a different factor,
    // which changes the CSS transform and forces recomposition.
    //
    // Fix: re-apply the current scale with a sub-pixel nudge. This
    // changes the CSS transform (forcing compositor invalidation) but
    // is imperceptible visually. Much cheaper than toggling a layout
    // property and safe to call at any time.
    function forceDisplayRepaint() {
      const cw = container!.clientWidth;
      const ch = container!.clientHeight;
      const dw = display.getWidth();
      const dh = display.getHeight();
      if (cw <= 0 || ch <= 0 || dw <= 0 || dh <= 0) return;
      const baseScale = Math.min(cw / dw, ch / dh);
      // Sub-pixel nudge: scale slightly off base so the CSS transform
      // string differs, then restore on the next frame. This is the
      // cheapest way to force the browser compositor to invalidate its
      // cached tile for the display layer.
      //
      // Why `1 / dw` rather than a fixed `1e-4`: on hardware-accelerated
      // compositors some Chromium builds round transforms to device
      // pixels before deciding whether to repaint, so a fixed tiny
      // delta can be collapsed to a no-op. `1 / dw` guarantees the
      // delta is exactly one source pixel when the display is
      // rendered at 1:1, which is below the visible threshold at any
      // realistic viewport size but always crosses the rounding gate.
      //
      // The synchronous read of `offsetHeight` between the two scale()
      // calls forces a layout flush, so the intermediate scale is
      // actually committed to the layer tree before we restore. Without
      // this, browsers are free to collapse the pair into a single
      // no-op transform.
      const displayEl = display.getElement();
      display.scale(baseScale + 1 / Math.max(dw, 1));
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      displayEl.offsetHeight; // force synchronous layout
      requestAnimationFrame(() => display.scale(baseScale));
    }

    // `forceDisplayRepaint` only clears ghosts that are compositor-level
    // (correct pixel data, stale cached tile in the GPU compositor).
    // This covers the common case where a minimise/snap animation leaves
    // visible edge artefacts that a transform change can invalidate.
    //
    // It does NOT fix pixel-data ghosts — if FreeRDP's H.264 GFX encoder
    // has accumulated reference-frame corruption (symptom: multiple
    // overlapping window states on the canvas, persisting through mouse
    // movement and across sweeps), no client-side operation can recover
    // the true frame. The only reliable fix is a full session
    // teardown+reconnect, which users can trigger via the Reconnect
    // button in the Session Bar — that cleanly re-initialises the codec
    // state on both ends of the tunnel.
    //
    // See: docs/architecture.md § "H.264 GFX reference-frame corruption"
    // for the full diagnosis and the v0.27.0 roadmap fix (guacd patch to
    // expose RDP Refresh Rect for in-session IDR request without reconnect).

    // Fire a handful of forced repaints at the timings that cover
    // Windows 10/11's default minimise-animation duration (~200ms) and
    // one late sweep at 500ms for the occasional slow animation. Coarse
    // but effective; the work per call is trivial (one CSS transform).
    const ghostSweepTimers: number[] = [];
    function scheduleGhostSweep() {
      ghostSweepTimers.forEach((id) => window.clearTimeout(id));
      ghostSweepTimers.length = 0;
      for (const delay of [50, 200, 500]) {
        ghostSweepTimers.push(window.setTimeout(forceDisplayRepaint, delay));
      }
    }

    // Drives a double two-step SuppressOutput toggle in our forked guacd
    // (see guacd/patches/004-refresh-on-noop-size.patch):
    //   t=0    : sendSize → guacd: SuppressOutput(allow=0)   [pair 1 step 1]
    //   t=150ms: sendSize → guacd: SuppressOutput(allow=1)   [pair 1 step 2]
    //   t=400ms: sendSize → guacd: SuppressOutput(allow=0)   [pair 2 step 1]
    //   t=550ms: sendSize → guacd: SuppressOutput(allow=1)   [pair 2 step 2]
    //
    // Empirically Windows Server's RDP GFX encoder requires TWO full
    // suppress/resume cycles before it commits to a fresh IDR keyframe
    // rather than retransmitting P-frames against the already-corrupted
    // reference chain. One cycle leaves the H.264 ghost intact; two
    // cycles reliably clears it. The state machine in guacd resets its
    // internal timestamp to 0 after each step 2, so pair 2 step 1 hits
    // the "last == 0" branch and is accepted unconditionally.
    //
    // Stock (un-patched) guacd silently ignores no-op resize instructions
    // so this is safe against servers without our patch applied.
    const manualRefreshTimers: number[] = [];
    function manualRefresh() {
      forceDisplayRepaint();
      // Cancel any pending stages from a prior invocation.
      manualRefreshTimers.forEach((id) => window.clearTimeout(id));
      manualRefreshTimers.length = 0;

      const cw = container!.clientWidth;
      const ch = container!.clientHeight;
      if (cw <= 0 || ch <= 0) return;

      const sendStage = (label: string) => {
        try {
          const cw2 = container?.clientWidth ?? 0;
          const ch2 = container?.clientHeight ?? 0;
          // Abort mid-sequence if the container was actually resized —
          // no point driving a ghost-refresh when a real resize is
          // already in flight.
          if (cw2 !== cw || ch2 !== ch) return;
          client.sendSize(cw, ch);
        } catch (e) {
          console.warn(`manualRefresh ${label}: sendSize failed`, e);
        }
      };

      // Stage 0 runs inline; stages 1-3 are scheduled.
      sendStage("pair1/step1");
      for (const [delay, label] of [
        [150, "pair1/step2"],
        [400, "pair2/step1"],
        [550, "pair2/step2"],
      ] as const) {
        manualRefreshTimers.push(window.setTimeout(() => sendStage(label), delay));
      }
    }

    // Auto-refresh is now handled SERVER-SIDE by our forked guacd
    // (see guacd/patches/004-refresh-on-noop-size.patch). guacd watches
    // the RDPGFX frame stream for the burst-then-idle pattern that
    // indicates a Windows window-management animation has completed
    // (the exact situation that desynchronises the H.264 reference
    // chain) and issues the SuppressOutput toggle itself. Detecting
    // this pattern browser-side proved unreliable — every input-level
    // signal we tried either over-fired (causing screen flashes on
    // normal double-clicks) or under-fired (missing real ghosts).
    //
    // The frontend retains the `manualRefresh` function so the Refresh
    // Display button in the session bar remains available as an
    // explicit user-invoked fallback.

    function handleResize() {
      const cw = container!.clientWidth;
      const ch = container!.clientHeight;
      if (cw <= 0 || ch <= 0) return;

      const dw = display.getWidth();
      const dh = display.getHeight();
      if (dw <= 0 || dh <= 0) return;

      // In multi-monitor mode, scale so the primary monitor's slice fills the container.
      // The display element is wider than the container (aggregate resolution) so
      // overflow:hidden on the container clips to just the primary region.
      // The negative margin offset on displayEl ensures the primary region is visible
      // and Guacamole.Mouse coordinates naturally include the aggregate offset.
      const layout = getLayout();
      if (layout) {
        // Recalculate aggregate layout with new container dimensions.
        // This sends a new sendSize() if the container width/height changed
        // (e.g. sidebar collapse), so the remote desktop fills the space.
        updatePrimarySize(cw, ch);

        // Re-read the layout after the update
        const updatedLayout = getLayout();
        const primaryW = updatedLayout ? updatedLayout.primary.width : layout.primary.width;
        const primaryH = updatedLayout ? updatedLayout.primary.height : layout.primary.height;
        const primaryTile = updatedLayout ? updatedLayout.primaryTile : layout.primaryTile;
        const scale = Math.min(cw / primaryW, ch / primaryH);
        display.scale(scale);
        // Update display offset to match current scale
        const displayEl = display.getElement();
        displayEl.style.marginLeft = `-${primaryTile.sliceX * scale}px`;
        displayEl.style.marginTop = `-${primaryTile.sliceY * scale}px`;
      } else {
        // Reset any leftover offset from multi-monitor mode
        const displayEl = display.getElement();
        displayEl.style.marginLeft = "";
        displayEl.style.marginTop = "";
        display.scale(Math.min(cw / dw, ch / dh));
        client.sendSize(cw, ch);
      }
    }

    // Rescale when the remote display resolution changes (e.g. maximising
    // a window inside the remote desktop triggers a server-side resize).
    const prevOnResize = display.onresize;
    // `display.onresize` can fire many times in quick succession during a
    // Windows snap/minimise animation (FreeRDP 3's GFX pipeline emits
    // partial size updates). Coalesce them: we only need the LAST size,
    // and we only need to issue one `sendSize` per animation frame.
    let resizeFramePending = false;
    display.onresize = (width: number, height: number) => {
      if (prevOnResize) prevOnResize(width, height);
      if (!resizeFramePending) {
        resizeFramePending = true;
        requestAnimationFrame(() => {
          resizeFramePending = false;
          handleResize();
        });
      }
      // Windows minimise/maximise animations run for roughly 200–250ms.
      // During that window FreeRDP 3's GFX pipeline occasionally sends
      // partial updates that leave ghost pixels in the display canvas.
      // `scheduleGhostSweep` internally cancels any prior pending timers,
      // so rapid-fire resizes don't stack their repaint sweeps.
      scheduleGhostSweep();
    };

    // Hook `display.onflush` to auto-clear ghost pixels after any burst
    // of drawing activity settles — this covers minimise/maximise and
    // window-move animations *inside* the remote session, which do NOT
    // change the desktop resolution and therefore do NOT fire onresize.
    //
    // Behaviour:
    //  - Every flush reschedules the sweep timers (50/200/500ms cascade).
    //  - Continuous activity (video playback, scrolling) keeps rescheduling
    //    the 50ms timer so the first sweep in the cascade never runs until
    //    activity actually settles. No flicker during video.
    //  - Once activity stops, the 50ms timer fires and does a sub-pixel
    //    compositor nudge (one source pixel of scale delta + forced
    //    reflow) — imperceptible visually but forces the browser to
    //    discard any stale cached tile.
    //  - The 200/500ms follow-ups catch the occasional slow animation.
    //
    // Per-sweep cost is a single CSS transform change, not a canvas
    // repaint, so even pathological "flush every frame" clients stay
    // cheap. Ghost frames from `copy`/`rect` animation artefacts now
    // self-heal without any user interaction.
    const prevOnFlush = display.onflush;
    display.onflush = () => {
      if (prevOnFlush) prevOnFlush();
      scheduleGhostSweep();
    };

    // Safety-net sweep on user input. Covers the residual case where
    // guacd coalesces `sync` instructions under load so `onflush` never
    // fires for a batch that produced a ghost frame. When the user is
    // actively interacting with the session (mouse movement, keystroke),
    // any visible ghost gets swept within 50ms of the next input event.
    //
    // `scheduleGhostSweep` already debounces via timer cancellation:
    //  - Continuous mouse movement → timers keep resetting → no flicker.
    //  - User pauses → 50ms later the sweep runs once → ghost cleared.
    //  - Idle → no input → no sweeps → no cost.
    //
    // NOTE: this only catches compositor-level ghosts. Pixel-data ghosts
    // (H.264 reference-frame corruption) need a full session reconnect
    // via the Session Bar's Reconnect button — there is no reliable
    // client-side recovery.
    //
    // We listen on the display element itself (not `container`) so we
    // don't fire sweeps for movements over the sidebar or session bar.
    // `passive: true` guarantees we never delay scroll/input handling.
    const displayEl = display.getElement();
    const onInputActivity = () => scheduleGhostSweep();
    displayEl.addEventListener("pointermove", onInputActivity, { passive: true });
    displayEl.addEventListener("pointerdown", onInputActivity, { passive: true });
    window.addEventListener("keydown", onInputActivity, { passive: true });

    const observer = new ResizeObserver(() => {
      handleResize();
    });

    observer.observe(container);

    // Fallback for window resize too
    window.addEventListener("resize", handleResize);

    // Expose the manual refresh to the SessionBar's "Refresh display"
    // button. Auto-refresh on ghost detection is implemented SERVER-SIDE
    // in guacd/patches/004-refresh-on-noop-size.patch; the frontend only
    // exposes this as a manual fallback. Stock guacd silently ignores
    // no-op resize instructions so the manual path is also safe against
    // un-patched servers.
    currentSession.refreshDisplay = manualRefresh;

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("keydown", onInputActivity);
      displayEl.removeEventListener("pointermove", onInputActivity);
      displayEl.removeEventListener("pointerdown", onInputActivity);
      ghostSweepTimers.forEach((id) => window.clearTimeout(id));
      manualRefreshTimers.forEach((id) => window.clearTimeout(id));
      manualRefreshTimers.length = 0;
      // Restore previous handlers (if any) to avoid leaking our closures.
      display.onresize = prevOnResize ?? null;
      display.onflush = prevOnFlush ?? null;
      if (currentSession.refreshDisplay === manualRefresh) {
        currentSession.refreshDisplay = undefined;
      }
    };
  }, [currentSession, isMultiMonitor, getLayout]);

  // Keyboard management — focus-scoped with capture-phase key trap
  useEffect(() => {
    if (!currentSession) return;
    const kb = currentSession.keyboard;
    const client = currentSession.client;
    const dialogOpen = phase === "prompt" || sshRequired !== null;

    if (dialogOpen || currentSession.id !== activeSessionId) {
      kb.onkeydown = null;
      kb.onkeyup = null;
      return () => {
        kb.onkeydown = null;
        kb.onkeyup = null;
      };
    }

    const winProxy = createWinKeyProxy((p, k) => client.sendKeyEvent(p, k));
    kb.onkeydown = (keysym: number) => {
      if (!containerFocusedRef.current || commandPaletteOpenRef.current) {
        winProxy.reset();
        return false;
      }
      return winProxy.onkeydown(keysym);
    };
    kb.onkeyup = (keysym: number) => {
      if (!containerFocusedRef.current || commandPaletteOpenRef.current) {
        winProxy.reset();
        return;
      }
      winProxy.onkeyup(keysym);
    };

    // Capture-phase listener intercepts keys BEFORE the browser can act on
    // them (Tab focus-navigation, F5 refresh, Alt+Left back-navigation, etc.).
    // Guacamole.Keyboard uses the bubbling phase with delayed key
    // identification, so by the time it calls preventDefault() the browser
    // has already processed certain default actions.
    const trapKeyDown = (e: KeyboardEvent) => {
      if (!containerFocusedRef.current) return;
      // Allow browser dev-tools shortcuts through
      if (e.key === "F12") return;
      if (e.ctrlKey && e.shiftKey && (e.key === "I" || e.key === "J")) return;
      // User-configurable command-palette shortcut (default Ctrl+K).
      if (matchesBinding(e, commandPaletteBindingRef.current)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        // Flush any keys currently held down (typically Ctrl/Meta) to the
        // remote BEFORE flipping the guard — otherwise the keyup events
        // raised by kb.reset() are dropped and the modifier stays stuck
        // on the server after the palette closes.
        kb.reset();
        setCommandPaletteOpen(true);
        commandPaletteOpenRef.current = true;
        return;
      }
      // While command palette is open, don't trap keys — let it handle them
      if (commandPaletteOpenRef.current) return;
      e.preventDefault();
    };
    document.addEventListener("keydown", trapKeyDown, true);

    // Shortcut proxy: Ctrl+Alt+Tab → Alt+Tab, Ctrl+Alt+` → Win+Tab
    const removeShortcutProxy = installShortcutProxy(
      document,
      (p, k) => client.sendKeyEvent(p, k),
      () => containerFocusedRef.current
    );

    // Keyboard Lock: capture OS-level shortcuts (Win, Alt+Tab, etc.) in fullscreen
    const removeKeyboardLock = installKeyboardLock(document);

    // Listen for Ctrl+K relay from popout/multi-monitor windows
    const handlePaletteMessage = (e: MessageEvent) => {
      // Origin check — only accept messages from our own origin. The popout
      // and multi-monitor child windows are `window.open()`ed from this same
      // origin, so `e.origin === window.location.origin` is the correct
      // invariant. Reject cross-origin frames that may also relay postMessage.
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === "strata:open-command-palette") {
        // Release any held keys on the server BEFORE flipping the guard
        // so the generated keyup events are not swallowed.
        kb.reset();
        setCommandPaletteOpen(true);
        commandPaletteOpenRef.current = true;
      }
    };
    window.addEventListener("message", handlePaletteMessage);

    return () => {
      kb.onkeydown = null;
      kb.onkeyup = null;
      document.removeEventListener("keydown", trapKeyDown, true);
      window.removeEventListener("message", handlePaletteMessage);
      removeShortcutProxy();
      removeKeyboardLock();
    };
  }, [currentSession, activeSessionId, phase, sshRequired]);

  // Auto-focus the session container when a session becomes active
  useEffect(() => {
    if (phase === "connected" && containerRef.current) {
      containerRef.current.focus();
    }
  }, [phase, activeSessionId]);

  // ── Drag-and-drop file upload ──
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !currentSession) return;

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0 || currentSession.filesystems.length === 0) return;
      const fs = currentSession.filesystems[0];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const stream = fs.object.createOutputStream(
          file.type || "application/octet-stream",
          "/" + file.name
        );
        const writer = new Guacamole.BlobWriter(stream);
        writer.sendBlob(file);
      }
    };
    container.addEventListener("dragover", handleDragOver);
    container.addEventListener("drop", handleDrop);
    return () => {
      container.removeEventListener("dragover", handleDragOver);
      container.removeEventListener("drop", handleDrop);
    };
  }, [currentSession]);

  // Cleanup reconnect timer on unmount and mark user-initiated disconnect
  useEffect(() => {
    return () => {
      userDisconnectRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, []);

  // ── Detect when our session is removed and redirect to next active session ──
  // This handles the case where tunnel handlers reference stale refs from a
  // prior component instance (React Router may unmount/remount SessionClient
  // when navigating between /session/:connectionId routes).
  const hadSessionRef = useRef(false);
  if (currentSession) hadSessionRef.current = true;
  useEffect(() => {
    // Reset only when switching to a different connection
    hadSessionRef.current = false;
  }, [connectionId]);
  useEffect(() => {
    if (!connectionId || error || reconnecting || reconnectLoading) return;
    if (phase !== "connected") return;
    // Only act if we previously had a session that has now disappeared.
    // This avoids false-positives during initial session creation.
    if (!hadSessionRef.current) return;

    // Check if our session still exists in the session list
    const ourSession = sessions.find((s) => s.connectionId === connectionId);
    if (ourSession) return; // still alive

    // Session was removed by SessionManager. Redirect to remaining healthy session.
    const remaining = sessions.filter((s) => !s.error);
    if (remaining.length > 0) {
      const next =
        remaining.find((s) => s.id === activeSessionId) || remaining[remaining.length - 1];
      setActiveSessionId(next.id);

      // Attach display — unless the next session is in a pop-out window.
      const container = containerRef.current;
      if (container && !(next._popout && !next._popout.window.closed)) {
        container.innerHTML = "";
        container.appendChild(next.displayEl);
        const display = next.client.getDisplay();
        const dw = display.getWidth();
        const dh = display.getHeight();
        if (dw > 0 && dh > 0) {
          display.scale(Math.min(container.clientWidth / dw, container.clientHeight / dh));
        }
      }

      navigate(`/session/${next.connectionId}`);
    } else {
      // Last session ended — show overlay.
      setError("The remote session has ended. You may have logged out of the server.");
    }
  }, [
    sessions,
    connectionId,
    activeSessionId,
    error,
    reconnecting,
    phase,
    setActiveSessionId,
    navigate,
  ]);

  // SSH runtime credentials
  const submitSshCredentials = useCallback(() => {
    if (!currentSession || !sshRequired) return;
    for (const param of sshRequired) {
      const value = credForm[param] || "";
      const stream = currentSession.client.createArgumentValueStream("text/plain", param);
      const writer = new Guacamole.StringWriter(stream);
      writer.sendText(value);
      writer.sendEnd();
    }
    setSshRequired(null);
  }, [sshRequired, credForm, currentSession]);

  const paramLabels: Record<string, string> = {
    username: "Username",
    password: "Password",
    domain: "Domain",
  };
  const preConnectFields =
    protocol === "rdp" || protocol === "vdi"
      ? hasDomain
        ? ["username", "password"]
        : ["username", "password", "domain"]
      : ["username", "password"];

  // Render via portal into document.body to escape the .main-content container.
  return createPortal(
    <div
      style={{
        position: "fixed",
        top: 0,
        left: sidebarWidth,
        right: barWidth,
        bottom: 0,
        zIndex: 5,
        transition:
          "left 0.2s cubic-bezier(0.4, 0, 0.2, 1), right 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
      }}
    >
      <div
        ref={containerRef}
        tabIndex={0}
        onFocus={() => {
          containerFocusedRef.current = true;
        }}
        onBlur={() => {
          // Release any keys still held on the remote before disabling the trap
          currentSession?.keyboard.reset();
          containerFocusedRef.current = false;
        }}
        onMouseDown={() => {
          containerRef.current?.focus();
        }}
        style={{
          width: "100%",
          height: "100%",
          background: "#000",
          overflow: "hidden",
          // The remote cursor is rendered as a CSS `cursor: url(...)` on the
          // inner display element by SessionManager (`display.oncursor`).
          // Keep the container cursor as `default` so the OS pointer is
          // visible in letterbox bars and before the first cursor frame.
          cursor: "default",
          outline: "none",
        }}
      />

      {/* Registration of pop-out actions with SessionManager */}
      {
        useEffect(() => {
          if (currentSession) {
            currentSession.isPoppedOut = isPoppedOut;
            currentSession.popOut = popOut;
            currentSession.popIn = returnDisplay;
          }
        }, [currentSession, isPoppedOut, popOut, returnDisplay]) as any
      }

      {/* Registration of multi-monitor actions with SessionManager */}
      {
        useEffect(() => {
          if (currentSession) {
            currentSession.isMultiMonitor = isMultiMonitor;
            currentSession.screenCount = screenCount;
            currentSession.enableMultiMonitor =
              canMultiMonitor && !isPoppedOut ? enableMultiMonitor : undefined;
            currentSession.disableMultiMonitor = isMultiMonitor ? disableMultiMonitor : undefined;
          }
        }, [
          currentSession,
          isMultiMonitor,
          canMultiMonitor,
          isPoppedOut,
          enableMultiMonitor,
          disableMultiMonitor,
          screenCount,
        ]) as any
      }

      {/* Touch controls and watermark */}
      {currentSession && <SessionWatermark connectionWatermark={connectionWatermark} />}

      {/* Pop-out placeholder */}
      {isPoppedOut && (
        <div
          className="absolute inset-0 flex items-center justify-center z-10"
          style={{ background: "rgba(0,0,0,0.9)" }}
        >
          <div className="card max-w-[400px] text-center !p-8">
            <div className="text-3xl mb-3">🖥️</div>
            <h3 className="text-lg font-semibold mb-2">Session Popped Out</h3>
            <p className="text-txt-secondary text-sm mb-4">
              This session is displayed in a separate window. Close that window or click below to
              return it here.
            </p>
            <button className="btn-primary" onClick={returnDisplay}>
              Return to Main Window
            </button>
          </div>
        </div>
      )}

      {/* Multi-monitor controls */}
      {isMultiMonitor && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
          <button
            className="btn text-xs px-3 py-1.5 bg-black/70 hover:bg-black/90 text-white border-white/20 backdrop-blur"
            onClick={disableMultiMonitor}
          >
            Exit Multi-Monitor
          </button>
        </div>
      )}

      {phase === "loading" && !error && !reconnecting && (
        <div className="absolute inset-0 flex items-center justify-center bg-black z-10">
          <p className="text-gray-500">Loading connection…</p>
        </div>
      )}

      {/* Reconnecting overlay */}
      {reconnecting && (
        <div
          className="absolute inset-0 flex items-center justify-center z-20"
          style={{ background: "rgba(0,0,0,0.85)" }}
        >
          <div className="card max-w-[400px] text-center !p-8">
            <div className="mb-4">
              <svg
                className="animate-spin h-10 w-10 mx-auto text-blue-500"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            </div>
            <h3 className="text-lg font-semibold mb-2">Reconnecting…</h3>
            <p className="text-txt-secondary text-sm mb-4">
              Connection lost. Attempting to reconnect ({reconnecting.attempt}/
              {reconnecting.maxAttempts})
            </p>
            <button
              className="btn text-sm"
              onClick={() => {
                userDisconnectRef.current = true;
                if (reconnectTimerRef.current) {
                  clearTimeout(reconnectTimerRef.current);
                  reconnectTimerRef.current = null;
                }
                setReconnecting(null);
                setError("Connection lost. Reconnection cancelled.");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && !reconnecting && !sshRequired && phase !== "prompt" && (
        <div
          className="absolute inset-0 flex items-center justify-center z-10 animate-in fade-in duration-300"
          style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(4px)" }}
        >
          <div className="card max-w-[400px] text-center !p-8 shadow-2xl scale-in-center">
            <div className="flex items-center justify-center w-16 h-16 rounded-full bg-danger/10 text-danger mx-auto mb-6">
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
                <line x1="12" y1="2" x2="12" y2="12" />
              </svg>
            </div>
            <h3 className="text-xl font-bold mb-2">
              {error.toLowerCase().includes("terminated")
                ? "Session Terminated"
                : error.toLowerCase().includes("session has ended")
                  ? "Session Ended"
                  : "Connection Error"}
            </h3>
            <p className="text-txt-secondary text-sm mb-8 leading-relaxed">
              {error.toLowerCase().includes("terminated")
                ? "Your session has been terminated by an administrator. Any unsaved work may be lost."
                : error}
            </p>
            <div className="flex gap-3">
              <button
                className="btn flex-1"
                onClick={() => navigate("/")}
                disabled={reconnectLoading}
              >
                Exit to Dashboard
              </button>
              {!error.toLowerCase().includes("terminated") && (
                <button
                  className="btn-primary flex-1"
                  onClick={handleManualReconnect}
                  disabled={reconnectLoading}
                >
                  {reconnectLoading ? "Reconnecting…" : "Reconnect"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {phase === "prompt" && (
        <div
          className="absolute inset-0 flex items-center justify-center z-10 overflow-auto p-4"
          style={{ background: "var(--color-surface)" }}
        >
          <div className="card w-full max-w-[400px] m-auto">
            <h2 className="!mb-1">Connect to {protocol.toUpperCase()}</h2>
            <p className="text-txt-secondary text-sm mb-4">
              Enter credentials for the remote server.
            </p>

            {/* ── Expired profile renewal banner ── */}
            {expiredProfile && (
              <div
                style={{
                  background: "var(--color-surface-secondary)",
                  border: "1px solid var(--color-glass-border)",
                  borderRadius: "0.75rem",
                  padding: "0.75rem 1rem",
                  marginBottom: "1rem",
                }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span style={{ color: "var(--color-error)", fontSize: "0.85rem" }}>●</span>
                  <span className="text-sm font-medium">{expiredProfile.label}</span>
                  <span className="text-xs" style={{ color: "var(--color-error)" }}>
                    (expired)
                  </span>
                </div>
                {!renewMode ? (
                  <button
                    className="text-xs mt-1"
                    style={{
                      color: "var(--color-primary)",
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      textDecoration: "underline",
                    }}
                    onClick={() => setRenewMode(true)}
                  >
                    {expiredProfile.managed_ad_dn
                      ? "Request checkout & connect"
                      : "Update credentials & connect"}
                  </button>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleRenewAndConnect();
                    }}
                    className="mt-2"
                  >
                    {expiredProfile.managed_ad_dn ? (
                      <>
                        {!expiredProfile.can_self_approve && (
                          <div className="mb-3">
                            <div className="p-2 rounded-lg bg-warning/10 border border-warning/20 text-warning text-xs leading-relaxed">
                              <strong>Approval Required:</strong> This checkout will be submitted
                              for administrator approval. You will be able to connect once approved.
                            </div>
                          </div>
                        )}
                        <div className="form-group !mb-3">
                          <label className="text-[0.625rem] uppercase tracking-wider font-bold text-txt-tertiary mb-1.5">
                            Checkout Duration
                          </label>
                          <Select
                            value={String(renewDuration)}
                            onChange={(v) => setRenewDuration(parseInt(v))}
                            options={[
                              { value: "30", label: "30 Minutes" },
                              { value: "60", label: "1 Hour" },
                              { value: "240", label: "4 Hours" },
                              { value: "480", label: "8 Hours" },
                              { value: "720", label: "12 Hours" },
                            ]}
                          />
                        </div>
                        <div className="form-group !mb-3">
                          <label className="text-[0.625rem] uppercase tracking-wider font-bold text-txt-tertiary mb-1.5">
                            Justification / Comment
                          </label>
                          <textarea
                            className="w-full text-xs p-2 rounded-md bg-input-bg border border-border"
                            rows={2}
                            placeholder="Why do you need this checkout?"
                            value={renewJustification}
                            onChange={(e) => setRenewJustification(e.target.value)}
                            required
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="form-group !mb-2">
                          <label className="text-xs">Username</label>
                          <input
                            type="text"
                            value={renewForm.username}
                            onChange={(e) =>
                              setRenewForm((f) => ({ ...f, username: e.target.value }))
                            }
                            autoFocus
                          />
                        </div>
                        <div className="form-group !mb-2">
                          <label className="text-xs">Password</label>
                          <input
                            type="password"
                            value={renewForm.password}
                            onChange={(e) =>
                              setRenewForm((f) => ({ ...f, password: e.target.value }))
                            }
                          />
                        </div>
                      </>
                    )}
                    {renewError && (
                      <p
                        className="text-xs mb-2"
                        style={{
                          color: renewError.includes("pending administrator approval")
                            ? "var(--color-warning)"
                            : "var(--color-error)",
                        }}
                      >
                        {renewError}
                      </p>
                    )}
                    <div className="flex gap-2">
                      <button
                        className="btn-primary flex-1 !text-sm !py-1.5"
                        type="submit"
                        disabled={renewLoading}
                      >
                        {renewLoading
                          ? "Submitting…"
                          : expiredProfile.managed_ad_dn
                            ? expiredProfile.can_self_approve
                              ? "Self-Approve & Connect"
                              : "Request Checkout"
                            : "Update & Connect"}
                      </button>
                      <button
                        className="btn flex-1 !text-sm !py-1.5"
                        type="button"
                        onClick={() => {
                          setRenewMode(false);
                          setRenewError("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}

            {/* ── Manual / saved profile form ── */}
            {!renewMode && (
              <>
                {expiredProfile && (
                  <div className="flex items-center gap-2 mb-3">
                    <div
                      style={{ flex: 1, height: "1px", background: "var(--color-glass-border)" }}
                    />
                    <span className="text-xs text-txt-secondary">
                      or enter credentials manually
                    </span>
                    <div
                      style={{ flex: 1, height: "1px", background: "var(--color-glass-border)" }}
                    />
                  </div>
                )}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handlePreConnectSubmit();
                  }}
                >
                  {vaultProfiles.length > 0 && (
                    <div className="form-group">
                      <label>Saved Credential Profile</label>
                      <Select
                        value={selectedProfileId}
                        onChange={(val) => {
                          setSelectedProfileId(val);
                          if (val) setCredForm({ username: "", password: "", domain: "" });
                        }}
                        options={[
                          { value: "", label: "— Enter manually —" },
                          ...vaultProfiles.map((p) => ({ value: p.id, label: p.label })),
                        ]}
                      />
                    </div>
                  )}
                  {!selectedProfileId &&
                    preConnectFields.map((field) => (
                      <div className="form-group" key={field}>
                        <label>{paramLabels[field] || field}</label>
                        <input
                          type={field === "password" ? "password" : "text"}
                          value={credForm[field] || ""}
                          onChange={(e) => setCredForm({ ...credForm, [field]: e.target.value })}
                          autoFocus={!expiredProfile && field === preConnectFields[0]}
                        />
                      </div>
                    ))}
                  <button className="btn-primary w-full" type="submit">
                    Connect
                  </button>
                  <button className="btn w-full mt-2" type="button" onClick={() => navigate("/")}>
                    Cancel
                  </button>
                </form>
              </>
            )}

            {/* Cancel button when in renew mode */}
            {renewMode && (
              <button className="btn w-full mt-2" type="button" onClick={() => navigate("/")}>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {/* Command Palette (Ctrl+K) */}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => {
          setCommandPaletteOpen(false);
          commandPaletteOpenRef.current = false;
          containerRef.current?.focus();
        }}
      />

      {sshRequired && (
        <div
          className="absolute inset-0 flex items-center justify-center z-10"
          style={{ background: "rgba(0,0,0,0.85)" }}
        >
          <div className="card w-full max-w-[400px]">
            <h2 className="!mb-1">Credentials Required</h2>
            <p className="text-txt-secondary text-sm mb-4">
              The remote server requires authentication.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitSshCredentials();
              }}
            >
              {sshRequired.map((param) => (
                <div className="form-group" key={param}>
                  <label>{paramLabels[param] || param}</label>
                  <input
                    type={param === "password" ? "password" : "text"}
                    value={credForm[param] || ""}
                    onChange={(e) => setCredForm({ ...credForm, [param]: e.target.value })}
                    autoFocus={param === sshRequired[0]}
                  />
                </div>
              ))}
              <button className="btn-primary w-full" type="submit">
                Connect
              </button>
            </form>
          </div>
        </div>
      )}
    </div>,
    document.getElementById("root")!
  );
}

/** Attach a session's display element into a container and scale to fit. */
function attachSession(session: GuacSession, container: HTMLElement) {
  // Don't steal the display element from an open popup window
  if (session._popout && !session._popout.window.closed) return;
  // Don't interfere with multi-monitor scaling — it manages its own scale
  if (session._multiMonitor) return;

  const display = session.client.getDisplay();
  const el = session.displayEl;

  if (el.parentElement !== container) {
    container.innerHTML = "";
    container.appendChild(el);
  }

  const dw = display.getWidth();
  const dh = display.getHeight();
  if (dw > 0 && dh > 0) {
    display.scale(Math.min(container.clientWidth / dw, container.clientHeight / dh));
  }

  container.focus();
}
