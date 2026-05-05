import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  getMyConnections,
  getConnectionInfo,
  Connection,
  getFavorites,
  toggleFavorite,
  getCredentialProfiles,
  getProfileMappings,
  getMyCheckouts,
  setCredentialMapping,
  removeCredentialMapping,
  CredentialProfile,
  CheckoutRequest,
  createTunnelTicket,
  getStatus,
  getTags,
  getConnectionTags,
  setConnectionTags,
  createTag,
  deleteTag,
  UserTag,
  getAdminTags,
  getAdminConnectionTags,
} from "../api";
import { useSessionManager } from "../components/SessionManager";
import Select from "../components/Select";
import { useSettings } from "../contexts/SettingsContext";

const PAGE_SIZE = 50;
const FOLDER_VIEW_KEY = "strata-folder-view";
const EXPANDED_FOLDERS_KEY = "strata-expanded-folders";
const SHOW_FAVORITES_KEY = "strata-show-favorites";
const TAG_FILTERS_KEY = "strata-tag-filters";
const TAG_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#f97316",
];

function ProtocolIcon({ protocol }: { protocol: string }) {
  const p = protocol.toLowerCase();
  if (p === "rdp") {
    return (
      <svg width="20" height="20" viewBox="0 0 88 88" fill="currentColor">
        <path d="M0 12.4l35.687-4.86.016 34.423-35.67.143L0 12.4zm35.67 33.529l.028 34.453L0 75.39V45.71h35.67V45.93zM40.336 6.326L87.971 0v41.527H40.33l.006-35.2zM87.971 46.26l-.011 41.74-47.624-6.661V46.26h47.635z" />
      </svg>
    );
  }
  if (p === "ssh") {
    return (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 17l6-6-6-6" />
        <path d="M12 19h8" />
      </svg>
    );
  }
  if (p === "db") {
    return (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M3 5V19C3 20.6569 7.02944 22 12 22C16.9706 22 21 20.6569 21 19V5" />
        <path d="M3 12C3 13.6569 7.02944 15 12 15C16.9706 15 21 13.6569 21 12" />
      </svg>
    );
  }
  if (p === "web") {
    // Globe — Web Browser session (rustguac parity Phase 2).
    return (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    );
  }
  if (p === "vdi") {
    // Stacked container blocks — VDI desktop container (rustguac parity Phase 3).
    return (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="4" width="18" height="5" rx="1" />
        <rect x="3" y="11" width="18" height="5" rx="1" />
        <path d="M3 18h18" />
      </svg>
    );
  }
  if (p === "kubernetes") {
    // Stylised Kubernetes wheel — heptagon + radial spokes (v1.4.0).
    return (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="12,2 20,7 20,17 12,22 4,17 4,7" />
        <circle cx="12" cy="12" r="3" />
        <line x1="12" y1="2" x2="12" y2="9" />
        <line x1="20" y1="7" x2="14.5" y2="10.5" />
        <line x1="20" y1="17" x2="14.5" y2="13.5" />
        <line x1="12" y1="22" x2="12" y2="15" />
        <line x1="4" y1="17" x2="9.5" y2="13.5" />
        <line x1="4" y1="7" x2="9.5" y2="10.5" />
      </svg>
    );
  }
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

/** Connections that need credentials before tiled open */
interface TiledCredPrompt {
  /** Connections that need credential input (no vault creds, RDP protocol) */
  needsCreds: Connection[];
  /** Connections that are ready to connect (have vault creds or non-RDP) */
  ready: Connection[];
}

export default function Dashboard() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [page, setPage] = useState(1);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [tiledCredPrompt, setTiledCredPrompt] = useState<TiledCredPrompt | null>(null);
  const [tiledCreds, setTiledCreds] = useState<
    Record<string, { username: string; password: string; credential_profile_id?: string }>
  >({});
  const [vaultConfigured, setVaultConfigured] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [showFavorites, setShowFavorites] = useState(
    () => localStorage.getItem(SHOW_FAVORITES_KEY) === "true"
  );
  const [folderView, setFolderView] = useState(
    () => localStorage.getItem(FOLDER_VIEW_KEY) === "true"
  );
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(EXPANDED_FOLDERS_KEY);
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });
  const [credProfiles, setCredProfiles] = useState<CredentialProfile[]>([]);
  /** Map of connection_id → profile_id currently assigned */
  const [connProfileMap, setConnProfileMap] = useState<Record<string, string>>({});
  const [tags, setTags] = useState<UserTag[]>([]);
  const [adminTags, setAdminTags] = useState<UserTag[]>([]);
  const [connTagMap, setConnTagMap] = useState<Record<string, string[]>>({});
  const [adminConnTagMap, setAdminConnTagMap] = useState<Record<string, string[]>>({});
  const [activeTagFilters, setActiveTagFilters] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(TAG_FILTERS_KEY);
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });
  const [allCheckouts, setAllCheckouts] = useState<CheckoutRequest[]>([]);
  const { formatDateTime } = useSettings();
  const navigate = useNavigate();
  const { createSession, setTiledSessionIds, setFocusedSessionIds, setActiveSessionId } =
    useSessionManager();
  const selectAllRef = useRef<HTMLInputElement>(null);

  const loadProfiles = useCallback(async () => {
    try {
      const profiles = await getCredentialProfiles();
      setCredProfiles(profiles);
      // Build reverse map: connection_id → profile_id
      const map: Record<string, string> = {};
      await Promise.all(
        profiles.map(async (p) => {
          try {
            const mappings = await getProfileMappings(p.id);
            for (const m of mappings) {
              map[m.connection_id] = p.id;
            }
          } catch {
            /* ignore */
          }
        })
      );
      setConnProfileMap(map);
    } catch {
      /* vault may not be configured */
    }
  }, []);

  const loadCheckouts = useCallback(async () => {
    try {
      setAllCheckouts(await getMyCheckouts());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    getMyConnections()
      .then((conns) => {
        setConnections(conns);
        // Auto-enable folder view if folders exist and user hasn't set a preference
        if (localStorage.getItem(FOLDER_VIEW_KEY) === null && conns.some((c) => c.folder_id)) {
          setFolderView(true);
          localStorage.setItem(FOLDER_VIEW_KEY, "true");
        }
      })
      .catch(() => {});
    getStatus()
      .then((s) => setVaultConfigured(s.vault_configured))
      .catch(() => {});
    getFavorites()
      .then((ids) => setFavorites(new Set(ids)))
      .catch(() => {});
    getTags()
      .then(setTags)
      .catch(() => {});
    getConnectionTags()
      .then(setConnTagMap)
      .catch(() => {});
    getAdminTags()
      .then(setAdminTags)
      .catch(() => {});
    getAdminConnectionTags()
      .then(setAdminConnTagMap)
      .catch(() => {});
    loadProfiles();
    loadCheckouts();
  }, [loadProfiles, loadCheckouts]);

  // Set of admin tag IDs (for disabling toggles in row UI)
  const adminTagIds = useMemo(() => new Set(adminTags.map((t) => t.id)), [adminTags]);

  // Merge user tags + admin tags
  const allTags = useMemo(() => {
    return [...adminTags, ...tags.filter((t) => !adminTagIds.has(t.id))];
  }, [tags, adminTags, adminTagIds]);

  // Merge connection tag maps (union of user + admin assigned tags per connection)
  const allConnTagMap = useMemo(() => {
    const merged: Record<string, string[]> = {};
    const allKeys = new Set([...Object.keys(connTagMap), ...Object.keys(adminConnTagMap)]);
    for (const connId of allKeys) {
      const userTids = connTagMap[connId] || [];
      const adminTids = adminConnTagMap[connId] || [];
      merged[connId] = [...new Set([...userTids, ...adminTids])];
    }
    return merged;
  }, [connTagMap, adminConnTagMap]);

  // Derived: filtered profiles list (hides [managed] profiles if already linked to a named one)
  const filteredProfiles = useMemo(() => {
    return credProfiles.filter((p) => {
      if (!p.label.startsWith("[managed]")) return true;
      // It's a [managed] profile -> show it ONLY if there isn't another profile linked to the same AD account
      const dn = p.label.replace("[managed] ", "");
      const isLinkedElsewhere = credProfiles.some((other) => {
        if (other.id === p.id || !other.checkout_id) return false;
        return allCheckouts.find((c) => c.id === other.checkout_id)?.managed_ad_dn === dn;
      });
      return !isLinkedElsewhere;
    });
  }, [credProfiles, allCheckouts]);

  const filtered = useMemo(() => {
    let list = connections;
    if (showFavorites) {
      list = list.filter((c) => favorites.has(c.id));
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.hostname.toLowerCase().includes(q) ||
          (c.description || "").toLowerCase().includes(q)
      );
    }
    if (typeFilter) {
      list = list.filter((c) => c.protocol.toLowerCase() === typeFilter.toLowerCase());
    }
    if (activeTagFilters.size > 0) {
      list = list.filter((c) => {
        const cTags = allConnTagMap[c.id] || [];
        return [...activeTagFilters].some((tid) => cTags.includes(tid));
      });
    }
    return list;
  }, [connections, search, typeFilter, showFavorites, favorites, activeTagFilters, allConnTagMap]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Build grouped structure for folder view — uses ALL filtered connections
  // (not paged) so folders aren't split across pages.
  const groupedConnections = useMemo(() => {
    if (!folderView) return null;
    const folderMap = new Map<string, { name: string; connections: Connection[] }>();
    const ungrouped: Connection[] = [];
    for (const conn of filtered) {
      const fid = conn.folder_id;
      if (fid && conn.folder_name) {
        if (!folderMap.has(fid)) folderMap.set(fid, { name: conn.folder_name, connections: [] });
        folderMap.get(fid)!.connections.push(conn);
      } else {
        ungrouped.push(conn);
      }
    }
    return { folders: [...folderMap.entries()], ungrouped };
  }, [folderView, filtered]);

  const toggleFolderCollapse = useCallback((fid: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(fid)) next.delete(fid);
      else next.add(fid);
      try {
        localStorage.setItem(EXPANDED_FOLDERS_KEY, JSON.stringify([...next]));
      } catch {
        // localStorage may be unavailable (private mode, quota); persistence
        // is best-effort and not required for correctness.
      }
      return next;
    });
  }, []);

  // ── Checkout Status Helpers ──

  /** Is this checkout truly active (Active status AND not past expires_at) */
  const isCheckoutLive = useCallback((c: CheckoutRequest) => {
    return c.status === "Active" && c.expires_at && new Date(c.expires_at!).getTime() > Date.now();
  }, []);

  // The visible connections: folder view shows all filtered, flat view shows paged slice
  const visibleConnections = folderView ? filtered : paged;

  // Drive indeterminate state on the "select all" checkbox
  useEffect(() => {
    if (selectAllRef.current) {
      const some = checked.size > 0 && checked.size < visibleConnections.length;
      selectAllRef.current.indeterminate = some;
    }
  }, [checked, visibleConnections.length]);

  const protocols = useMemo(
    () => [...new Set(connections.map((c) => c.protocol.toUpperCase()))].sort(),
    [connections]
  );

  const handleProfileChange = useCallback(async (connectionId: string, profileId: string) => {
    try {
      if (profileId === "") {
        await removeCredentialMapping(connectionId);
        setConnProfileMap((prev) => {
          const next = { ...prev };
          delete next[connectionId];
          return next;
        });
      } else {
        await setCredentialMapping(profileId, connectionId);
        setConnProfileMap((prev) => ({ ...prev, [connectionId]: profileId }));
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    setPage(1);
  }, [search, typeFilter, showFavorites, activeTagFilters]);

  const handleToggleFavorite = useCallback(async (connectionId: string) => {
    const result = await toggleFavorite(connectionId);
    setFavorites((prev) => {
      const next = new Set(prev);
      if (result.favorited) next.add(connectionId);
      else next.delete(connectionId);
      return next;
    });
  }, []);

  const handleSetConnectionTags = useCallback(
    async (connectionId: string, tagIds: string[]) => {
      try {
        // Only send user-owned tag IDs to the user endpoint; admin tags are read-only
        const userOnly = tagIds.filter((tid) => !adminTagIds.has(tid));
        await setConnectionTags(connectionId, userOnly);
        setConnTagMap((prev) => ({ ...prev, [connectionId]: userOnly }));
      } catch {
        /* ignore */
      }
    },
    [adminTagIds]
  );

  const handleCreateTag = useCallback(async (name: string, color: string): Promise<UserTag> => {
    const tag = await createTag(name, color);
    setTags((prev) => [...prev, tag]);
    return tag;
  }, []);

  const handleDeleteTag = useCallback(async (tagId: string) => {
    try {
      await deleteTag(tagId);
      setTags((prev) => prev.filter((t) => t.id !== tagId));
      setConnTagMap((prev) => {
        const next = { ...prev };
        for (const connId of Object.keys(next)) {
          next[connId] = next[connId].filter((tid) => tid !== tagId);
        }
        return next;
      });
      setActiveTagFilters((prev) => {
        const next = new Set(prev);
        next.delete(tagId);
        localStorage.setItem(TAG_FILTERS_KEY, JSON.stringify([...next]));
        return next;
      });
    } catch {
      /* ignore */
    }
  }, []);

  const toggleChecked = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAllChecked = useCallback(() => {
    setChecked((prev) =>
      prev.size === visibleConnections.length
        ? new Set()
        : new Set(visibleConnections.map((c) => c.id))
    );
  }, [visibleConnections]);

  const openTiled = useCallback(async () => {
    if (checked.size < 2) return;

    // Check which connections need credentials
    const checkedConns = [...checked]
      .map((id) => connections.find((c) => c.id === id))
      .filter(Boolean) as Connection[];

    const infos = await Promise.all(
      checkedConns.map(async (conn) => {
        try {
          const info = await getConnectionInfo(conn.id);
          return { conn, info };
        } catch {
          return { conn, info: { protocol: conn.protocol, has_credentials: false } };
        }
      })
    );

    const needsCreds: Connection[] = [];
    const ready: Connection[] = [];
    const expiredNames: string[] = [];

    for (const { conn, info } of infos) {
      if (info.expired_profile) {
        expiredNames.push(conn.name);
      } else if (info.has_credentials || conn.protocol.toLowerCase() !== "rdp") {
        ready.push(conn);
      } else {
        needsCreds.push(conn);
      }
    }

    if (expiredNames.length > 0) {
      window.alert(
        `The following connections were skipped because their managed credential profiles are expired and require renewal:\n\n${expiredNames.join("\n")}\n\nPlease connect to them individually to renew credentials.`
      );
    }

    if (needsCreds.length > 0) {
      // Show credential prompt before connecting
      setTiledCredPrompt({ needsCreds, ready });
      // Initialize empty cred forms
      const initial: Record<string, { username: string; password: string }> = {};
      for (const conn of needsCreds) {
        initial[conn.id] = { username: "", password: "" };
      }
      setTiledCreds(initial);
    } else if (ready.length > 0) {
      // All connections have vault credentials – open immediately
      launchTiled(ready, {});
    }
    // launchTiled is defined below; including it would create a circular dep cycle
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, connections]);

  /** Create all tiled sessions and navigate */
  const launchTiled = useCallback(
    async (
      conns: Connection[],
      creds: Record<string, { username: string; password: string; credential_profile_id?: string }>
    ) => {
      const ids: string[] = [];
      const containerEl = document.createElement("div");
      containerEl.style.width = "800px";
      containerEl.style.height = "600px";

      for (const conn of conns) {
        const dpr = window.devicePixelRatio || 1;
        const connCreds = creds[conn.id];

        // Obtain a one-time tunnel ticket so credentials never appear in the WebSocket URL
        let ticketId: string | undefined;
        try {
          const resp = await createTunnelTicket({
            connection_id: conn.id,
            username: connCreds?.credential_profile_id
              ? undefined
              : connCreds?.username || undefined,
            password: connCreds?.credential_profile_id
              ? undefined
              : connCreds?.password || undefined,
            credential_profile_id: connCreds?.credential_profile_id || undefined,
            width: 800,
            height: 600,
            dpi: Math.round(96 * dpr),
          });
          ticketId = resp.ticket;
        } catch {
          continue; // skip this connection on ticket failure
        }

        const connectParams = new URLSearchParams();
        // Authentication: the HttpOnly access_token cookie is sent
        // automatically on the WebSocket upgrade. The ticket binds this
        // connection request to the credentials we just submitted.
        connectParams.set("ticket", ticketId);
        connectParams.set("width", "800");
        connectParams.set("height", "600");
        connectParams.set("dpi", String(Math.round(96 * dpr)));

        const session = createSession({
          connectionId: conn.id,
          name: conn.name,
          protocol: conn.protocol,
          containerEl,
          connectParams,
        });
        ids.push(session.id);
      }

      if (ids.length > 0) {
        setTiledSessionIds(ids);
        setFocusedSessionIds([ids[0]]);
        setActiveSessionId(ids[0]);
        navigate("/tiled");
      }
      setChecked(new Set());
      setTiledCredPrompt(null);
      setTiledCreds({});
    },
    [createSession, setTiledSessionIds, setFocusedSessionIds, setActiveSessionId, navigate]
  );

  /** Submit the tiled credential prompt form */
  const handleTiledCredSubmit = useCallback(() => {
    if (!tiledCredPrompt) return;
    const allConns = [...tiledCredPrompt.ready, ...tiledCredPrompt.needsCreds];
    launchTiled(allConns, tiledCreds);
  }, [tiledCredPrompt, tiledCreds, launchTiled]);

  // ── Top 5 most recently accessed connections for the hero cards ──
  const recentConnections = useMemo(() => {
    return [...connections]
      .filter((c) => c.last_accessed)
      .sort((a, b) => new Date(b.last_accessed!).getTime() - new Date(a.last_accessed!).getTime())
      .slice(0, 5);
  }, [connections]);

  /** Get credential status for a connection based on its mapped profile */
  const getCredStatus = useCallback(
    (connId: string): "active" | "expired" | "none" => {
      const profileId = connProfileMap[connId];
      if (!profileId) return "none";
      const profile = credProfiles.find((p) => p.id === profileId);
      if (!profile) return "none";
      if (profile.expired) return "expired";

      // If linked to a checkout, that checkout must be live
      if (profile.checkout_id) {
        const checkout = allCheckouts.find((c) => c.id === profile.checkout_id);
        if (checkout && !isCheckoutLive(checkout)) return "expired";
      }

      return "active";
    },
    [connProfileMap, credProfiles, allCheckouts, isCheckoutLive]
  );

  return (
    <div>
      <h1>My Connections</h1>

      {/* ── Recent Connections — Premium Glass Cards ── */}
      {recentConnections.length > 0 && (
        <div className="recent-cards-section">
          <div className="recent-cards-grid">
            {recentConnections.map((conn) => {
              const status = getCredStatus(conn.id);
              // Bounded {3} repetition, no nested quantifiers — not ReDoS-vulnerable.
              // eslint-disable-next-line security/detect-unsafe-regex
              const isIP = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(conn.hostname);
              const domainLabel =
                conn.domain || (isIP ? "" : conn.hostname.split(".").slice(1).join("."));
              return (
                <div
                  key={conn.id}
                  className="recent-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/session/${conn.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(`/session/${conn.id}`);
                    }
                  }}
                >
                  {/* Status indicator dot */}
                  <div
                    className="recent-card-dot"
                    style={{
                      background:
                        status === "active"
                          ? "#22c55e"
                          : status === "expired"
                            ? "#ef4444"
                            : "#8b5cf6",
                      boxShadow:
                        status === "active"
                          ? "0 0 8px rgba(34, 197, 94, 0.6)"
                          : status === "expired"
                            ? "0 0 8px rgba(239, 68, 68, 0.6)"
                            : "0 0 8px rgba(139, 92, 246, 0.6)",
                    }}
                  />

                  {/* Card protocol icon */}
                  <div className="recent-card-icon-badge">
                    <ProtocolIcon protocol={conn.protocol} />
                  </div>

                  {/* Card content */}
                  <h3 className="recent-card-title">{conn.name}</h3>
                  <p className="recent-card-detail">
                    <span
                      style={{
                        display: "inline-block",
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        marginRight: 6,
                        verticalAlign: "middle",
                        background:
                          conn.health_status === "online"
                            ? "#22c55e"
                            : conn.health_status === "offline"
                              ? "#ef4444"
                              : "#6b7280",
                        boxShadow:
                          conn.health_status === "online"
                            ? "0 0 6px rgba(34,197,94,0.6)"
                            : conn.health_status === "offline"
                              ? "0 0 6px rgba(239,68,68,0.6)"
                              : "none",
                      }}
                    />
                    {conn.protocol.toUpperCase()} - {conn.hostname}:{conn.port}
                  </p>
                  <div className="recent-card-meta">
                    <p>
                      Status: {domainLabel ? `${domainLabel} ` : ""}
                      <span
                        style={{
                          color:
                            status === "active"
                              ? "#22c55e"
                              : status === "expired"
                                ? "#ef4444"
                                : "var(--color-txt-tertiary)",
                        }}
                      >
                        ({status === "none" ? "no profile" : status})
                      </span>
                    </p>
                    <p>Last Accessed: {formatDateTime(conn.last_accessed!)}</p>
                  </div>

                  {/* Connect button */}
                  <button
                    className="btn-connect-glass w-full"
                    style={
                      {
                        "--btn-border":
                          status === "active"
                            ? "rgba(34, 197, 94, 0.4)"
                            : status === "expired"
                              ? "rgba(239, 68, 68, 0.4)"
                              : "rgba(139, 92, 246, 0.4)",
                        "--btn-text":
                          status === "active"
                            ? "#22c55e"
                            : status === "expired"
                              ? "#ef4444"
                              : "#a78bfa",
                        "--btn-glow":
                          status === "active"
                            ? "rgba(34, 197, 94, 0.15)"
                            : status === "expired"
                              ? "rgba(239, 68, 68, 0.15)"
                              : "rgba(139, 92, 246, 0.15)",
                      } as React.CSSProperties
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/session/${conn.id}`);
                    }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      stroke="none"
                    >
                      <polygon points="5,3 19,12 5,21" />
                    </svg>
                    Connect
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-4 mb-5 flex-wrap">
        <div
          className="flex items-center gap-2 flex-1 max-w-xs rounded-sm px-3 transition-all duration-200 focus-within:ring-3 focus-within:ring-accent-dim"
          style={{ background: "var(--color-input-bg)", border: "1px solid var(--color-border)" }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 text-txt-tertiary"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="text"
            placeholder="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="!border-none !bg-transparent !shadow-none py-2 text-[0.8125rem] w-full focus:!shadow-none"
          />
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="dashboard-type-filter" className="!mb-0 text-xs uppercase text-txt-tertiary font-semibold tracking-wide">
            Type
          </label>
          <div className="min-w-[140px]">
            <Select
              id="dashboard-type-filter"
              value={typeFilter}
              onChange={setTypeFilter}
              placeholder="Select select"
              options={[
                { value: "", label: "All" },
                ...protocols.map((p) => ({ value: p, label: p })),
              ]}
            />
          </div>
        </div>

        <button
          className={`btn-sm inline-flex items-center gap-1.5 ${showFavorites ? "!border-accent !text-accent" : ""}`}
          onClick={() => {
            const next = !showFavorites;
            setShowFavorites(next);
            localStorage.setItem(SHOW_FAVORITES_KEY, String(next));
          }}
          title={showFavorites ? "Show all connections" : "Show favorites only"}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill={showFavorites ? "var(--color-accent)" : "none"}
            stroke={showFavorites ? "var(--color-accent)" : "currentColor"}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
          Favorites{favorites.size > 0 ? ` (${favorites.size})` : ""}
        </button>

        <button
          className={`btn-sm inline-flex items-center gap-1.5 ${folderView ? "!border-accent !text-accent" : ""}`}
          onClick={() => {
            const next = !folderView;
            setFolderView(next);
            localStorage.setItem(FOLDER_VIEW_KEY, String(next));
          }}
          title={folderView ? "Flat list view" : "Group by folder"}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke={folderView ? "var(--color-accent)" : "currentColor"}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
          </svg>
          Folders
        </button>

        {allTags.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs uppercase text-txt-tertiary font-semibold tracking-wide">
              Tags
            </span>
            {allTags.map((tag) => (
              <button
                key={tag.id}
                className="btn-sm inline-flex items-center gap-1 text-xs !py-0.5 !px-2"
                style={{
                  borderColor: activeTagFilters.has(tag.id) ? tag.color : undefined,
                  color: activeTagFilters.has(tag.id) ? tag.color : undefined,
                  background: activeTagFilters.has(tag.id) ? `${tag.color}15` : undefined,
                }}
                onClick={() => {
                  setActiveTagFilters((prev) => {
                    const next = new Set(prev);
                    if (next.has(tag.id)) next.delete(tag.id);
                    else next.add(tag.id);
                    localStorage.setItem(TAG_FILTERS_KEY, JSON.stringify([...next]));
                    return next;
                  });
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: tag.color,
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                {tag.name}
                {!adminTags.some((at) => at.id === tag.id) && (
                  <span
                    className="ml-0.5 opacity-50 hover:opacity-100"
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteTag(tag.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        handleDeleteTag(tag.id);
                      }
                    }}
                    title="Delete tag"
                  >
                    ×
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {checked.size >= 2 && (
          <button className="btn-sm-primary" onClick={openTiled}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            Open Tiled ({checked.size})
          </button>
        )}
      </div>

      {/* ── Table ── */}
      <div className="card !p-0 !overflow-hidden">
        <table>
          <thead>
            <tr>
              <th style={{ width: 40 }}>
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={
                    visibleConnections.length > 0 && checked.size === visibleConnections.length
                  }
                  onChange={toggleAllChecked}
                  className="checkbox"
                  title="Select all"
                  aria-label="Select all connections"
                />
              </th>
              <th>Connection Name</th>
              <th>Type</th>
              <th>Status</th>
              <th>Details</th>
              <th>Last Accessed</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {folderView && groupedConnections ? (
              <>
                {groupedConnections.folders.map(([fid, folder]) => (
                  <ConnectionFolderRows
                    key={fid}
                    folderId={fid}
                    folderName={folder.name}
                    connections={folder.connections}
                    collapsed={!expandedFolders.has(fid)}
                    onToggleCollapse={() => toggleFolderCollapse(fid)}
                    checked={checked}
                    toggleChecked={toggleChecked}
                    favorites={favorites}
                    onToggleFavorite={handleToggleFavorite}
                    vaultConfigured={vaultConfigured}
                    credProfiles={filteredProfiles}
                    allCheckouts={allCheckouts}
                    connProfileMap={connProfileMap}
                    onProfileChange={handleProfileChange}
                    navigate={navigate}
                    tags={allTags}
                    connTagMap={allConnTagMap}
                    onSetConnectionTags={handleSetConnectionTags}
                    onCreateTag={handleCreateTag}
                    adminTagIds={adminTagIds}
                  />
                ))}
                {groupedConnections.ungrouped.length > 0 && (
                  <ConnectionFolderRows
                    key="__ungrouped"
                    folderId="__ungrouped"
                    folderName="Ungrouped"
                    connections={groupedConnections.ungrouped}
                    collapsed={!expandedFolders.has("__ungrouped")}
                    onToggleCollapse={() => toggleFolderCollapse("__ungrouped")}
                    checked={checked}
                    toggleChecked={toggleChecked}
                    favorites={favorites}
                    onToggleFavorite={handleToggleFavorite}
                    vaultConfigured={vaultConfigured}
                    credProfiles={filteredProfiles}
                    allCheckouts={allCheckouts}
                    connProfileMap={connProfileMap}
                    onProfileChange={handleProfileChange}
                    navigate={navigate}
                    tags={allTags}
                    connTagMap={allConnTagMap}
                    onSetConnectionTags={handleSetConnectionTags}
                    onCreateTag={handleCreateTag}
                    adminTagIds={adminTagIds}
                  />
                )}
              </>
            ) : (
              paged.map((conn) => (
                <ConnectionRow
                  key={conn.id}
                  conn={conn}
                  checked={checked.has(conn.id)}
                  onToggleChecked={() => toggleChecked(conn.id)}
                  isFavorite={favorites.has(conn.id)}
                  onToggleFavorite={() => handleToggleFavorite(conn.id)}
                  vaultConfigured={vaultConfigured}
                  credProfiles={filteredProfiles}
                  allCheckouts={allCheckouts}
                  assignedProfileId={connProfileMap[conn.id] || ""}
                  onProfileChange={handleProfileChange}
                  onConnect={() => navigate(`/session/${conn.id}`)}
                  tags={allTags}
                  connTagIds={allConnTagMap[conn.id] || []}
                  onSetTags={handleSetConnectionTags}
                  onCreateTag={handleCreateTag}
                  adminTagIds={adminTagIds}
                />
              ))
            )}
            {visibleConnections.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center py-8 text-txt-secondary">
                  {connections.length === 0
                    ? "No connections available. Ask your administrator to assign connections to your role."
                    : "No connections match your filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Pagination (hidden in folder view) ── */}
      {folderView && filtered.length > 0 && (
        <div className="mt-4">
          <span className="text-[0.8125rem] text-txt-secondary">
            {filtered.length} connection{filtered.length !== 1 ? "s" : ""} in{" "}
            {groupedConnections
              ? groupedConnections.folders.length +
                (groupedConnections.ungrouped.length > 0 ? 1 : 0)
              : 0}{" "}
            folder
            {(groupedConnections
              ? groupedConnections.folders.length +
                (groupedConnections.ungrouped.length > 0 ? 1 : 0)
              : 0) !== 1
              ? "s"
              : ""}
          </span>
        </div>
      )}
      {!folderView && filtered.length > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-4 flex-wrap gap-4">
          <span className="text-[0.8125rem] text-txt-secondary">
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of{" "}
            {filtered.length} connections
          </span>
          <div className="flex items-center gap-1">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="btn-sm inline-flex items-center gap-1"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
              Previous
            </button>
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              const p = i + 1;
              return (
                <button
                  key={p}
                  className={`btn w-8 h-8 !p-0 inline-flex items-center justify-center text-[0.8125rem] rounded-sm ${
                    page === p ? "text-white !border-transparent" : ""
                  }`}
                  style={
                    page === p
                      ? { background: "var(--color-accent)", boxShadow: "var(--shadow-accent)" }
                      : undefined
                  }
                  onClick={() => setPage(p)}
                >
                  {p}
                </button>
              );
            })}
            <button
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="btn-sm inline-flex items-center gap-1"
            >
              Next
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* ── Tiled credential prompt modal ── */}
      {tiledCredPrompt && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Enter Credentials"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.5)",
          }}
        >
          <button
            type="button"
            aria-label="Cancel"
            tabIndex={-1}
            onClick={() => setTiledCredPrompt(null)}
            className="absolute inset-0 cursor-default bg-transparent border-0"
          />
          <div
            className="card"
            style={{ maxWidth: 440, width: "100%", maxHeight: "80vh", overflow: "auto", position: "relative" }}
          >
            <h3 style={{ marginBottom: 4 }}>Enter Credentials</h3>
            <p className="text-[0.8125rem] text-txt-secondary" style={{ marginBottom: 16 }}>
              The following connections require credentials to connect.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleTiledCredSubmit();
              }}
            >
              {tiledCredPrompt.needsCreds.map((conn) => (
                <div key={conn.id} style={{ marginBottom: 16 }}>
                  <div className="text-[0.8125rem] font-semibold" style={{ marginBottom: 6 }}>
                    <span className="badge badge-accent" style={{ marginRight: 8 }}>
                      {conn.protocol.toUpperCase()}
                    </span>
                    {conn.name}
                  </div>
                  {filteredProfiles.filter((p: CredentialProfile) => !p.expired).length > 0 && (
                    <div className="form-group" style={{ marginBottom: 6 }}>
                      <Select
                        value={tiledCreds[conn.id]?.credential_profile_id || ""}
                        onChange={(val) =>
                          setTiledCreds((prev) => ({
                            ...prev,
                            [conn.id]: val
                              ? { username: "", password: "", credential_profile_id: val }
                              : {
                                  username: prev[conn.id]?.username || "",
                                  password: prev[conn.id]?.password || "",
                                },
                          }))
                        }
                        options={[
                          { value: "", label: "— Enter manually —" },
                          ...filteredProfiles
                            .filter((p: CredentialProfile) => !p.expired)
                            .map((p: CredentialProfile) => {
                              const checkout = p.checkout_id
                                ? allCheckouts.find((c) => c.id === p.checkout_id)
                                : null;
                              const effectivelyExpired =
                                p.checkout_id && checkout && !isCheckoutLive(checkout);
                              return {
                                value: p.id,
                                label: effectivelyExpired ? `${p.label} (expired)` : p.label,
                              };
                            }),
                        ]}
                      />
                    </div>
                  )}
                  {!tiledCreds[conn.id]?.credential_profile_id && (
                    <div className="flex gap-2">
                      <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                        <input
                          type="text"
                          placeholder="Username"
                          value={tiledCreds[conn.id]?.username || ""}
                          onChange={(e) =>
                            setTiledCreds((prev) => ({
                              ...prev,
                              [conn.id]: { ...prev[conn.id], username: e.target.value },
                            }))
                          }
                        />
                      </div>
                      <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                        <input
                          type="password"
                          placeholder="Password"
                          value={tiledCreds[conn.id]?.password || ""}
                          onChange={(e) =>
                            setTiledCreds((prev) => ({
                              ...prev,
                              [conn.id]: { ...prev[conn.id], password: e.target.value },
                            }))
                          }
                        />
                      </div>
                    </div>
                  )}
                </div>
              ))}
              <div className="flex gap-2 justify-end" style={{ marginTop: 8 }}>
                <button type="button" className="btn-sm" onClick={() => setTiledCredPrompt(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn-sm-primary">
                  Connect All ({tiledCredPrompt.ready.length + tiledCredPrompt.needsCreds.length})
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Connection Row Component ────────────────────────────────────────

function ConnectionRow({
  conn,
  checked,
  onToggleChecked,
  isFavorite,
  onToggleFavorite,
  vaultConfigured,
  credProfiles,
  allCheckouts,
  assignedProfileId,
  onProfileChange,
  onConnect,
  tags,
  connTagIds,
  onSetTags,
  onCreateTag,
  adminTagIds,
}: {
  conn: Connection;
  checked: boolean;
  onToggleChecked: () => void;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  vaultConfigured: boolean;
  credProfiles: CredentialProfile[];
  allCheckouts: CheckoutRequest[];
  assignedProfileId: string;
  onProfileChange: (connectionId: string, profileId: string) => void;
  onConnect: () => void;
  tags: UserTag[];
  connTagIds: string[];
  onSetTags: (connectionId: string, tagIds: string[]) => void;
  onCreateTag: (name: string, color: string) => Promise<UserTag>;
  adminTagIds: Set<string>;
}) {
  const { formatDateTime } = useSettings();
  const [showTagMenu, setShowTagMenu] = useState(false);
  const [menuPos, setMenuPos] = useState<{
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  }>({});
  const [newTagName, setNewTagName] = useState("");
  const tagMenuRef = useRef<HTMLDivElement>(null);

  /** Is this checkout truly active (Active status AND not past expires_at) */
  const isCheckoutLive = useCallback((c: CheckoutRequest) => {
    return c.status === "Active" && c.expires_at && new Date(c.expires_at!).getTime() > Date.now();
  }, []);

  useEffect(() => {
    if (!showTagMenu) return;
    const handler = (e: MouseEvent) => {
      if (tagMenuRef.current && !tagMenuRef.current.contains(e.target as Node))
        setShowTagMenu(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showTagMenu]);

  const status: "active" | "expired" | "none" = useMemo(() => {
    const profile = credProfiles.find((p) => p.id === assignedProfileId);
    if (!profile) return "none";
    if (profile.expired) return "expired";

    if (profile.checkout_id) {
      const checkout = allCheckouts.find((c) => c.id === profile.checkout_id);
      if (checkout && !isCheckoutLive(checkout)) return "expired";
    }
    return "active";
  }, [credProfiles, assignedProfileId, allCheckouts, isCheckoutLive]);

  const connTags = useMemo(() => tags.filter((t) => connTagIds.includes(t.id)), [tags, connTagIds]);

  const statusColors = {
    active: { border: "rgba(34, 197, 94, 0.4)", text: "#22c55e", glow: "rgba(34, 197, 94, 0.15)" },
    expired: { border: "rgba(239, 68, 68, 0.4)", text: "#ef4444", glow: "rgba(239, 68, 68, 0.15)" },
    none: { border: "rgba(139, 92, 246, 0.4)", text: "#a78bfa", glow: "rgba(139, 92, 246, 0.15)" },
  }[status];

  return (
    <tr>
      <td>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggleChecked}
          className="checkbox"
          aria-label={`Select connection ${conn.name}`}
        />
      </td>
      <td>
        <div className="font-medium">{conn.name}</div>
        {conn.description && (
          <div className="text-[0.75rem] text-txt-tertiary mt-0.5">{conn.description}</div>
        )}
        {connTags.length > 0 && (
          <div className="flex gap-1 mt-1 flex-wrap">
            {connTags.map((tag) => (
              <span
                key={tag.id}
                className="inline-flex items-center gap-1 text-[0.625rem] px-1.5 rounded-full"
                style={{
                  background: `${tag.color}20`,
                  color: tag.color,
                  border: `1px solid ${tag.color}40`,
                  lineHeight: "1.4",
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: tag.color,
                    flexShrink: 0,
                  }}
                />
                {tag.name}
              </span>
            ))}
          </div>
        )}
      </td>
      <td>
        <div className="flex items-center gap-2.5 text-accent-light">
          <ProtocolIcon protocol={conn.protocol} />
          <span className="badge badge-accent">{conn.protocol.toUpperCase()}</span>
        </div>
      </td>
      <td>
        <span
          title={
            conn.health_checked_at
              ? `Checked: ${formatDateTime(conn.health_checked_at)}`
              : "Not yet checked"
          }
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            borderRadius: "50%",
            background:
              conn.health_status === "online"
                ? "#22c55e"
                : conn.health_status === "offline"
                  ? "#ef4444"
                  : "#6b7280",
            boxShadow:
              conn.health_status === "online"
                ? "0 0 6px rgba(34,197,94,0.6)"
                : conn.health_status === "offline"
                  ? "0 0 6px rgba(239,68,68,0.6)"
                  : "none",
          }}
        />
      </td>
      <td className="text-[0.8125rem] text-txt-secondary">
        {conn.protocol.toUpperCase()} — {conn.hostname}:{conn.port}
      </td>
      <td className="text-[0.8125rem] text-txt-secondary">
        {conn.last_accessed ? formatDateTime(conn.last_accessed) : "—"}
      </td>
      <td>
        <div className="flex gap-2">
          <button
            className="btn-sm !px-2"
            onClick={onToggleFavorite}
            title={isFavorite ? "Remove from favorites" : "Add to favorites"}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill={isFavorite ? "var(--color-warning, #f59e0b)" : "none"}
              stroke={isFavorite ? "var(--color-warning, #f59e0b)" : "currentColor"}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </button>
          <div ref={tagMenuRef} style={{ position: "relative" }}>
            <button
              className={`btn-sm !px-2 ${connTagIds.length > 0 ? "!border-accent !text-accent" : ""}`}
              onClick={() => {
                if (!showTagMenu && tagMenuRef.current) {
                  const rect = tagMenuRef.current.getBoundingClientRect();
                  const dropUp = rect.bottom + 260 > window.innerHeight;
                  const dropLeft = rect.right - 200 >= 0;
                  setMenuPos({
                    ...(dropUp
                      ? { bottom: window.innerHeight - rect.top + 4 }
                      : { top: rect.bottom + 4 }),
                    ...(dropLeft ? { right: window.innerWidth - rect.right } : { left: rect.left }),
                  });
                }
                setShowTagMenu(!showTagMenu);
              }}
              title="Manage tags"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
                <line x1="7" y1="7" x2="7.01" y2="7" />
              </svg>
            </button>
            {showTagMenu && (
              <div
                className="card !p-2"
                style={{ position: "fixed", zIndex: 30, minWidth: 200, ...menuPos }}
              >
                {tags.length === 0 && (
                  <div className="text-xs text-txt-tertiary py-1 px-1">No tags yet</div>
                )}
                {tags.map((tag) => {
                  const isAdmin = adminTagIds.has(tag.id);
                  return (
                    <label
                      key={tag.id}
                      className={`flex items-center gap-2 py-1 px-1 rounded text-[0.8125rem] ${isAdmin ? "opacity-60" : "cursor-pointer"}`}
                      style={{ whiteSpace: "nowrap" }}
                    >
                      <input
                        type="checkbox"
                        className="checkbox"
                        checked={connTagIds.includes(tag.id)}
                        disabled={isAdmin}
                        onChange={() => {
                          const next = connTagIds.includes(tag.id)
                            ? connTagIds.filter((t) => t !== tag.id)
                            : [...connTagIds, tag.id];
                          onSetTags(conn.id, next);
                        }}
                      />
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          background: tag.color,
                          flexShrink: 0,
                        }}
                      />
                      {tag.name}
                      {isAdmin && (
                        <span className="text-[0.625rem] text-txt-tertiary ml-1">(global)</span>
                      )}
                    </label>
                  );
                })}
                <div
                  className="flex gap-1 mt-1 pt-1"
                  style={{ borderTop: "1px solid var(--color-border)" }}
                >
                  <input
                    type="text"
                    placeholder="New tag…"
                    value={newTagName}
                    onChange={(e) => setNewTagName(e.target.value)}
                    onKeyDown={async (e) => {
                      if (e.key === "Enter" && newTagName.trim()) {
                        const tag = await onCreateTag(
                          newTagName.trim(),
                          TAG_COLORS[tags.length % TAG_COLORS.length]
                        );
                        onSetTags(conn.id, [...connTagIds, tag.id]);
                        setNewTagName("");
                      }
                    }}
                    className="text-xs !py-1 flex-1"
                    style={{ minWidth: 0 }}
                  />
                  <button
                    className="btn-sm !px-2 !py-1 text-xs"
                    onClick={async () => {
                      if (newTagName.trim()) {
                        const tag = await onCreateTag(
                          newTagName.trim(),
                          TAG_COLORS[tags.length % TAG_COLORS.length]
                        );
                        onSetTags(conn.id, [...connTagIds, tag.id]);
                        setNewTagName("");
                      }
                    }}
                  >
                    +
                  </button>
                </div>
              </div>
            )}
          </div>
          <button
            className="btn-connect-glass"
            style={
              {
                "--btn-border": statusColors.border,
                "--btn-text": statusColors.text,
                "--btn-glow": statusColors.glow,
                padding: "0.35rem 0.8rem",
                fontSize: "0.75rem",
              } as React.CSSProperties
            }
            onClick={onConnect}
          >
            Connect
          </button>
          {vaultConfigured && (
            <div className="w-[200px] shrink-0">
              <Select
                value={assignedProfileId}
                onChange={(v) => onProfileChange(conn.id, v)}
                placeholder="No profile"
                options={[
                  { value: "", label: "None" },
                  ...credProfiles.map((p: CredentialProfile) => {
                    const checkout = p.checkout_id
                      ? allCheckouts.find((c) => c.id === p.checkout_id)
                      : null;
                    const effectivelyExpired =
                      p.expired || (p.checkout_id && checkout && !isCheckoutLive(checkout));
                    return {
                      value: p.id,
                      label: effectivelyExpired ? `${p.label} (expired)` : p.label,
                    };
                  }),
                ]}
              />
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

// ── Connection Folder Rows ───────────────────────────────────────────

function ConnectionFolderRows({
  folderId: _fid,
  folderName,
  connections,
  collapsed,
  onToggleCollapse,
  checked,
  toggleChecked,
  favorites,
  onToggleFavorite,
  vaultConfigured,
  credProfiles,
  allCheckouts,
  connProfileMap,
  onProfileChange,
  navigate,
  tags,
  connTagMap,
  onSetConnectionTags,
  onCreateTag,
  adminTagIds,
}: {
  folderId: string;
  folderName: string;
  connections: Connection[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  checked: Set<string>;
  toggleChecked: (id: string) => void;
  favorites: Set<string>;
  onToggleFavorite: (id: string) => void;
  vaultConfigured: boolean;
  credProfiles: CredentialProfile[];
  allCheckouts: CheckoutRequest[];
  connProfileMap: Record<string, string>;
  onProfileChange: (connectionId: string, profileId: string) => void;
  navigate: (path: string) => void;
  tags: UserTag[];
  connTagMap: Record<string, string[]>;
  onSetConnectionTags: (connectionId: string, tagIds: string[]) => void;
  onCreateTag: (name: string, color: string) => Promise<UserTag>;
  adminTagIds: Set<string>;
}) {
  return (
    <>
      <tr
        onClick={onToggleCollapse}
        style={{ cursor: "pointer", background: "var(--color-surface-secondary)" }}
      >
        <td />
        <td colSpan={6} className="!py-2">
          <div className="flex items-center gap-2 font-semibold text-[0.8125rem] -ml-2">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
            </svg>
            <span>{folderName}</span>
            <span className="text-txt-tertiary font-normal">({connections.length})</span>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="ml-auto"
              style={{
                transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
                transition: "transform 0.15s",
              }}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
        </td>
      </tr>
      {!collapsed &&
        connections.map((conn) => (
          <ConnectionRow
            key={conn.id}
            conn={conn}
            checked={checked.has(conn.id)}
            onToggleChecked={() => toggleChecked(conn.id)}
            isFavorite={favorites.has(conn.id)}
            onToggleFavorite={() => onToggleFavorite(conn.id)}
            vaultConfigured={vaultConfigured}
            credProfiles={credProfiles}
            allCheckouts={allCheckouts}
            assignedProfileId={connProfileMap[conn.id] || ""}
            onProfileChange={onProfileChange}
            onConnect={() => navigate(`/session/${conn.id}`)}
            tags={tags}
            connTagIds={connTagMap[conn.id] || []}
            onSetTags={onSetConnectionTags}
            onCreateTag={onCreateTag}
            adminTagIds={adminTagIds}
          />
        ))}
    </>
  );
}
