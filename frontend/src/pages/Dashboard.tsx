/* eslint-disable react-hooks/set-state-in-effect, react-hooks/immutability, react-hooks/preserve-manual-memoization --
   react-hooks v7 compiler-strict suppressions: legitimate prop->state sync, session
   decoration, or render-time time/derivation patterns. See
   eslint.config.js W4-1 commentary. */
import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  getMyConnections,
  getConnectionInfo,
  Connection,
  getFavorites,
  toggleFavorite,
  getCredentialProfiles,
  getMyCredentialMappings,
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
  getMyConnectionFolders,
  ConnectionFolder,
} from "../api";
import { useSessionManager } from "../components/SessionManager";
import ConnectionCard from "../components/connections/ConnectionCard";
import {
  deriveHealth,
  deriveLease,
  deriveSession,
  formatDuration,
  HOST_HEALTH_LABEL,
  type TargetSessionState,
} from "../components/connections/connectionState";
import { useNow } from "../components/leaseStore";
import Select from "../components/Select";
import EnterpriseCheckbox from "../components/EnterpriseCheckbox";
import ConnectionEmptyState from "../components/ConnectionEmptyState";
import ActiveFilterChips from "../components/ActiveFilterChips";
import useConnectionFilter from "../hooks/useConnectionFilter";
import { useSettings } from "../contexts/SettingsContext";
import { isWebPSupported } from "../utils/browserCapabilities";

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
  const [folders, setFolders] = useState<ConnectionFolder[]>([]);
  const [page, setPage] = useState(1);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [tiledCredPrompt, setTiledCredPrompt] = useState<TiledCredPrompt | null>(null);
  const [tiledCreds, setTiledCreds] = useState<
    Record<string, { username: string; password: string; credential_profile_id?: string }>
  >({});
  const [vaultConfigured, setVaultConfigured] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
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
  const [allCheckouts, setAllCheckouts] = useState<CheckoutRequest[]>([]);
  const { formatDateTime } = useSettings();
  const navigate = useNavigate();
  const {
    createSession,
    setTiledSessionIds,
    setFocusedSessionIds,
    setActiveSessionId,
    sessions,
    closeSession,
  } = useSessionManager();
  // Keeps lease countdowns and live-session durations fresh.
  const now = useNow(30_000);

  const loadProfiles = useCallback(async () => {
    try {
      const [profiles, mappings] = await Promise.all([
        getCredentialProfiles(),
        getMyCredentialMappings().catch(() => []),
      ]);
      setCredProfiles(profiles);
      // Build reverse map: connection_id → profile_id
      const map: Record<string, string> = {};
      for (const m of mappings) {
        map[m.connection_id] = m.profile_id;
      }
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
    getMyConnectionFolders()
      .then(setFolders)
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

  const enrichedConnections = useMemo(() => {
    return connections.map((c) => ({
      ...c,
      isFavorite: favorites.has(c.id),
      tags: allConnTagMap[c.id] || [],
    }));
  }, [connections, favorites, allConnTagMap]);

  const {
    filters,
    setFilter,
    resetAllFilters,
    clearScope,
    filteredConnections: filtered,
    globalSearchMatches,
  } = useConnectionFilter(enrichedConnections, {
    searchQuery: "",
    favoritesOnly: localStorage.getItem(SHOW_FAVORITES_KEY) === "true",
    selectedTag: (() => {
      try {
        const saved = localStorage.getItem(TAG_FILTERS_KEY);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) return parsed[0];
        }
      } catch {
        /* ignore */
      }
      return null;
    })(),
    selectedProtocol: "ALL",
  });

  useEffect(() => {
    localStorage.setItem(SHOW_FAVORITES_KEY, String(filters.favoritesOnly));
  }, [filters.favoritesOnly]);

  useEffect(() => {
    if (filters.selectedTag) {
      localStorage.setItem(TAG_FILTERS_KEY, JSON.stringify([filters.selectedTag]));
    } else {
      localStorage.removeItem(TAG_FILTERS_KEY);
    }
  }, [filters.selectedTag]);

  useEffect(() => {
    setPage(1);
  }, [filters]);

  const selectedTagName = useMemo(() => {
    if (!filters.selectedTag) return null;
    return allTags.find((t) => t.id === filters.selectedTag)?.name || filters.selectedTag;
  }, [filters.selectedTag, allTags]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Build nested folder tree for folder view. Walks `folders` (which carry
  // `parent_id`) to construct the hierarchy and buckets each connection
  // under its leaf `folder_id`. Returns null when folder view is off.
  // Connections whose folder_id no longer matches any known folder fall into
  // the synthetic "Ungrouped" bucket alongside truly folderless ones.
  const folderTree = useMemo(() => {
    if (!folderView) return null;

    type Node = {
      id: string;
      name: string;
      children: Node[];
      connections: Connection[];
      /** Total connection count including all descendants. */
      totalCount: number;
    };

    const folderById = new Map(folders.map((f) => [f.id, f]));
    const nodes = new Map<string, Node>(
      folders.map((f) => [
        f.id,
        { id: f.id, name: f.name, children: [], connections: [], totalCount: 0 },
      ])
    );
    const roots: Node[] = [];
    for (const f of folders) {
      const node = nodes.get(f.id)!;
      if (f.parent_id && nodes.has(f.parent_id)) {
        nodes.get(f.parent_id)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    const ungrouped: Connection[] = [];
    for (const conn of filtered) {
      const fid = conn.folder_id;
      if (fid && nodes.has(fid)) {
        nodes.get(fid)!.connections.push(conn);
      } else {
        ungrouped.push(conn);
      }
    }

    // Compute descendant counts depth-first.
    const computeCount = (n: Node): number => {
      n.totalCount = n.connections.length + n.children.reduce((a, c) => a + computeCount(c), 0);
      return n.totalCount;
    };
    roots.forEach(computeCount);

    // Sort children alphabetically at every level for predictable display.
    const sortRec = (n: Node) => {
      n.children.sort((a, b) => a.name.localeCompare(b.name));
      n.children.forEach(sortRec);
    };
    roots.sort((a, b) => a.name.localeCompare(b.name));
    roots.forEach(sortRec);

    return { roots, ungrouped, folderById };
  }, [folderView, folders, filtered]);

  // When a search filter is active, auto-expand any folder containing
  // matches so users don't see an empty tree.
  const autoExpandedIds = useMemo(() => {
    if (!folderTree || !filters.searchQuery.trim()) return null;
    const ids = new Set<string>();
    type VisitNode = { id: string; children: VisitNode[]; totalCount: number };
    const visit = (node: VisitNode): boolean => {
      let hit = false;
      for (const c of node.children) {
        if (visit(c)) hit = true;
      }
      if (node.totalCount > 0 || hit) {
        ids.add(node.id);
        return true;
      }
      return false;
    };
    folderTree.roots.forEach((r) => visit(r));
    return ids;
  }, [folderTree, filters.searchQuery]);

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

  const handleDeleteTag = useCallback(
    async (tagId: string) => {
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
        if (filters.selectedTag === tagId) {
          setFilter("selectedTag", null);
        }
      } catch {
        /* ignore */
      }
    },
    [filters.selectedTag, setFilter]
  );

  const toggleChecked = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAllChecked = useCallback(
    (shouldSelectAll?: boolean) => {
      setChecked((prev) => {
        const selectAll =
          typeof shouldSelectAll === "boolean"
            ? shouldSelectAll
            : prev.size !== visibleConnections.length;
        return selectAll ? new Set(visibleConnections.map((c) => c.id)) : new Set();
      });
    },
    [visibleConnections]
  );

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
        const webpSupported = isWebPSupported();
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
            webp: webpSupported,
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
        connectParams.set("webp", String(webpSupported));

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

  const sessionStates = useMemo(() => {
    const map: Record<string, TargetSessionState> = {};
    for (const s of sessions) {
      const state = deriveSession(s, now);
      if (state.state !== "DISCONNECTED") map[s.connectionId] = state;
    }
    return map;
  }, [sessions, now]);

  return (
    <div className="strata-dashboard">
      <h1>My Connections</h1>

      {/* ── Recent Connections — Premium Glass Cards ── */}
      {recentConnections.length > 0 && (
        <div className="recent-cards-section">
          <div className="recent-cards-grid">
            {recentConnections.map((conn) => {
              const session = sessionStates[conn.id] ?? { state: "DISCONNECTED" as const };
              const profile = credProfiles.find((p) => p.id === connProfileMap[conn.id]);
              return (
                <ConnectionCard
                  key={conn.id}
                  conn={conn}
                  icon={<ProtocolIcon protocol={conn.protocol} />}
                  state={{
                    health: deriveHealth(conn),
                    lease: deriveLease(profile, allCheckouts, now),
                    session,
                  }}
                  lastAccessedLabel={formatDateTime(conn.last_accessed!)}
                  healthCheckedLabel={
                    conn.health_checked_at ? formatDateTime(conn.health_checked_at) : undefined
                  }
                  onConnect={() => navigate(`/session/${conn.id}`)}
                  // SessionClient opens its renewal prompt for expired profiles.
                  onRenewAndConnect={() => navigate(`/session/${conn.id}`)}
                  onResume={() => {
                    if (session.sessionId) setActiveSessionId(session.sessionId);
                    navigate(`/session/${conn.id}`);
                  }}
                  onDisconnect={() => session.sessionId && closeSession(session.sessionId)}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-4 mb-3 flex-wrap">
        <div className="dash-search flex items-center gap-2 flex-1 max-w-md rounded-sm px-3 transition-all duration-200 focus-within:ring-3 focus-within:ring-accent-dim">
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

          {/* Dynamic Inset Scope Badge */}
          {filters.favoritesOnly && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] bg-[#3ACEEF]/20 border border-[#3ACEEF]/40 text-xs text-[#3ACEEF] whitespace-nowrap shrink-0">
              ★ Favorites
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setFilter("favoritesOnly", false);
                }}
                className="hover:text-white cursor-pointer ml-0.5"
                title="Remove favorites scope"
                aria-label="Remove favorites scope"
              >
                ✕
              </button>
            </span>
          )}

          {filters.selectedTag && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] bg-[#3ACEEF]/20 border border-[#3ACEEF]/40 text-xs text-[#3ACEEF] whitespace-nowrap shrink-0">
              🏷️ {selectedTagName || filters.selectedTag}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setFilter("selectedTag", null);
                }}
                className="hover:text-white cursor-pointer ml-0.5"
                title="Remove tag scope"
                aria-label="Remove tag scope"
              >
                ✕
              </button>
            </span>
          )}

          <input
            type="text"
            placeholder={
              filters.favoritesOnly || filters.selectedTag
                ? "Search within filtered scope..."
                : "Search name, host, description or tag"
            }
            value={filters.searchQuery}
            onChange={(e) => setFilter("searchQuery", e.target.value)}
            className="!border-none !bg-transparent !shadow-none py-2 text-[0.8125rem] w-full focus:!shadow-none"
          />
          {filters.searchQuery && (
            <button
              type="button"
              onClick={() => setFilter("searchQuery", "")}
              className="text-txt-tertiary hover:text-txt-primary cursor-pointer text-xs shrink-0"
              aria-label="Clear search query"
            >
              ✕
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <label
            htmlFor="dashboard-type-filter"
            className="!mb-0 text-xs uppercase text-txt-tertiary font-semibold tracking-wide"
          >
            Type
          </label>
          <div className="dash-type-select min-w-[140px]">
            <Select
              id="dashboard-type-filter"
              value={filters.selectedProtocol === "ALL" ? "" : filters.selectedProtocol}
              onChange={(val) => setFilter("selectedProtocol", val || "ALL")}
              placeholder="Select select"
              options={[
                { value: "", label: "All" },
                ...protocols.map((p) => ({ value: p, label: p })),
              ]}
            />
          </div>
        </div>

        <button
          className={`dash-toggle btn-sm inline-flex items-center gap-1.5 ${
            filters.favoritesOnly ? "!border-accent !text-accent bg-accent/10" : ""
          }`}
          aria-pressed={filters.favoritesOnly}
          onClick={() => {
            const next = !filters.favoritesOnly;
            setFilter("favoritesOnly", next);
          }}
          title={filters.favoritesOnly ? "Show all connections" : "Show favorites only"}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill={filters.favoritesOnly ? "var(--color-accent)" : "none"}
            stroke={filters.favoritesOnly ? "var(--color-accent)" : "currentColor"}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
          {filters.favoritesOnly ? (
            <span className="inline-flex items-center gap-1">
              ★ Favorites{favorites.size > 0 ? ` (${favorites.size})` : ""} ✕
            </span>
          ) : (
            <span>Favorites{favorites.size > 0 ? ` (${favorites.size})` : ""}</span>
          )}
        </button>

        <button
          className={`dash-toggle btn-sm inline-flex items-center gap-1.5 ${folderView ? "!border-accent !text-accent" : ""}`}
          aria-pressed={folderView}
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

        {folderView &&
          folderTree &&
          (folderTree.roots.length > 0 || folderTree.ungrouped.length > 0) && (
            <>
              <button
                className="btn-sm inline-flex items-center gap-1.5"
                onClick={() => {
                  // Collect every folder ID in the tree (recursively) plus the
                  // synthetic ungrouped bucket so all rows pop open at once.
                  const all = new Set<string>();
                  type WalkNode = { id: string; children: WalkNode[] };
                  const walk = (n: WalkNode) => {
                    all.add(n.id);
                    n.children.forEach(walk);
                  };
                  folderTree.roots.forEach(walk);
                  if (folderTree.ungrouped.length > 0) all.add("__ungrouped");
                  setExpandedFolders(all);
                  try {
                    localStorage.setItem(EXPANDED_FOLDERS_KEY, JSON.stringify([...all]));
                  } catch {
                    /* localStorage may be unavailable; persistence best-effort. */
                  }
                }}
                title="Expand all folders"
              >
                Expand all
              </button>
              <button
                className="btn-sm inline-flex items-center gap-1.5"
                onClick={() => {
                  setExpandedFolders(new Set());
                  try {
                    localStorage.setItem(EXPANDED_FOLDERS_KEY, "[]");
                  } catch {
                    /* localStorage may be unavailable; persistence best-effort. */
                  }
                }}
                title="Collapse all folders"
              >
                Collapse all
              </button>
            </>
          )}

        {allTags.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs uppercase text-txt-tertiary font-semibold tracking-wide">
              Tags
            </span>
            {allTags.map((tag) => {
              const isSelected = filters.selectedTag === tag.id;
              return (
                <button
                  key={tag.id}
                  className="btn-sm inline-flex items-center gap-1 text-xs !py-0.5 !px-2 cursor-pointer"
                  style={{
                    borderColor: isSelected ? tag.color : undefined,
                    color: isSelected ? tag.color : undefined,
                    background: isSelected ? `${tag.color}15` : undefined,
                  }}
                  onClick={() => {
                    setFilter("selectedTag", isSelected ? null : tag.id);
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
              );
            })}
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

      {/* ── Active Filter Chips ── */}
      <ActiveFilterChips
        filters={filters}
        setFilter={setFilter}
        resetAllFilters={resetAllFilters}
        selectedTagName={selectedTagName}
        className="mb-3"
      />

      {/* ── Table ── */}
      <div className="dash-table-card card !p-0 !overflow-hidden">
        <table>
          <thead>
            <tr>
              <th className="py-3 px-4 w-10 text-left">
                <EnterpriseCheckbox
                  id="select-all-connections"
                  checked={
                    visibleConnections.length > 0 && checked.size === visibleConnections.length
                  }
                  indeterminate={checked.size > 0 && checked.size < visibleConnections.length}
                  onCheckedChange={toggleAllChecked}
                  title="Select all"
                  aria-label="Select all connections"
                />
              </th>
              <th>Connection Name</th>
              <th>Type</th>
              <th>Host</th>
              <th>Session</th>
              <th>Details</th>
              <th>Last Accessed</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {folderView && folderTree && filtered.length > 0 ? (
              <>
                {folderTree.roots.map((root) => (
                  <ConnectionFolderTree
                    key={root.id}
                    node={root}
                    depth={0}
                    expandedFolders={expandedFolders}
                    autoExpandedIds={autoExpandedIds}
                    onToggleCollapse={toggleFolderCollapse}
                    checked={checked}
                    toggleChecked={toggleChecked}
                    favorites={favorites}
                    onToggleFavorite={handleToggleFavorite}
                    vaultConfigured={vaultConfigured}
                    credProfiles={filteredProfiles}
                    allCheckouts={allCheckouts}
                    connProfileMap={connProfileMap}
                    sessionStates={sessionStates}
                    onProfileChange={handleProfileChange}
                    navigate={navigate}
                    tags={allTags}
                    connTagMap={allConnTagMap}
                    onSetConnectionTags={handleSetConnectionTags}
                    onCreateTag={handleCreateTag}
                    adminTagIds={adminTagIds}
                  />
                ))}
                {folderTree.ungrouped.length > 0 && (
                  <ConnectionFolderTree
                    key="__ungrouped"
                    node={{
                      id: "__ungrouped",
                      name: "Ungrouped",
                      children: [],
                      connections: folderTree.ungrouped,
                      totalCount: folderTree.ungrouped.length,
                    }}
                    depth={0}
                    expandedFolders={expandedFolders}
                    autoExpandedIds={autoExpandedIds}
                    onToggleCollapse={toggleFolderCollapse}
                    checked={checked}
                    toggleChecked={toggleChecked}
                    favorites={favorites}
                    onToggleFavorite={handleToggleFavorite}
                    vaultConfigured={vaultConfigured}
                    credProfiles={filteredProfiles}
                    allCheckouts={allCheckouts}
                    connProfileMap={connProfileMap}
                    sessionStates={sessionStates}
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
                  session={sessionStates[conn.id]}
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
                <td colSpan={8} className="p-0">
                  <ConnectionEmptyState
                    filters={filters}
                    filteredCount={filtered.length}
                    globalCount={globalSearchMatches.length}
                    onClearScope={clearScope}
                    onResetAll={resetAllFilters}
                    totalConnections={connections.length}
                  />
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
            {folderTree ? folderTree.roots.length + (folderTree.ungrouped.length > 0 ? 1 : 0) : 0}{" "}
            folder
            {(folderTree
              ? folderTree.roots.length + (folderTree.ungrouped.length > 0 ? 1 : 0)
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
            style={{
              maxWidth: 440,
              width: "100%",
              maxHeight: "80vh",
              overflow: "auto",
              position: "relative",
            }}
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
  session,
  onProfileChange,
  onConnect,
  tags,
  connTagIds,
  onSetTags,
  onCreateTag,
  adminTagIds,
  indentPx,
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
  session?: TargetSessionState;
  onProfileChange: (connectionId: string, profileId: string) => void;
  onConnect: () => void;
  tags: UserTag[];
  connTagIds: string[];
  onSetTags: (connectionId: string, tagIds: string[]) => void;
  onCreateTag: (name: string, color: string) => Promise<UserTag>;
  adminTagIds: Set<string>;
  /** Optional left indent in px applied to the name cell when this row is
   *  rendered inside a nested folder tree. Aligns the connection name with
   *  its parent folder header. */
  indentPx?: number;
}) {
  const { formatDateTime } = useSettings();
  const [showTagMenu, setShowTagMenu] = useState(false);
  const [menuPos, setMenuPos] = useState<{
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
    maxHeight?: number;
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

  const leaseStatus = useMemo(
    () =>
      deriveLease(
        credProfiles.find((p) => p.id === assignedProfileId),
        allCheckouts
      ).status,
    [credProfiles, assignedProfileId, allCheckouts]
  );

  const connTags = useMemo(() => tags.filter((t) => connTagIds.includes(t.id)), [tags, connTagIds]);
  const health = deriveHealth(conn);
  const isOffline = health === "OFFLINE";

  return (
    <tr
      key={conn.id}
      className={`
        border-b border-white/[0.07] transition-colors duration-150
        ${
          checked
            ? "bg-[#3ACEEF]/[0.06] border-l-2 border-l-[#3ACEEF]"
            : "border-l-2 border-l-transparent hover:bg-[#3ACEEF]/[0.03]"
        }
      `}
    >
      <td className="py-3 px-4 w-10">
        <EnterpriseCheckbox
          id={`select-${conn.id}`}
          checked={checked}
          onCheckedChange={onToggleChecked}
          aria-label={`Select ${conn.name}`}
        />
      </td>
      <td>
        <div
          className="font-medium"
          style={indentPx ? { paddingLeft: `${indentPx}px` } : undefined}
        >
          {conn.name}
        </div>
        {conn.description && (
          <div
            className="text-[0.75rem] text-txt-tertiary mt-0.5"
            style={indentPx ? { paddingLeft: `${indentPx}px` } : undefined}
          >
            {conn.description}
          </div>
        )}
        {connTags.length > 0 && (
          <div
            className="flex gap-1 mt-1 flex-wrap"
            style={indentPx ? { paddingLeft: `${indentPx}px` } : undefined}
          >
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
          <span className="badge badge-accent" data-protocol={conn.protocol.toLowerCase()}>
            {conn.protocol.toUpperCase()}
          </span>
        </div>
      </td>
      <td>
        <span
          className="dash-host-health"
          data-health={health.toLowerCase()}
          title={
            conn.health_checked_at
              ? `Checked: ${formatDateTime(conn.health_checked_at)}`
              : "Not yet checked"
          }
        >
          <span className="dash-state-dot" aria-hidden />
          {HOST_HEALTH_LABEL[health]}
        </span>
      </td>
      <td>
        {session?.state === "CONNECTED" ? (
          <span className="dash-session-live">
            <span className="dash-state-dot animate-pulse" aria-hidden />
            Live ({formatDuration(session.elapsedSeconds ?? 0)})
          </span>
        ) : session?.state === "CONNECTING" ? (
          <span className="dash-session-idle">Connecting…</span>
        ) : (
          <span className="dash-session-idle" aria-label="No active session">
            —
          </span>
        )}
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
            className="dash-action-icon dash-action-fav btn-sm !px-2"
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
              className={`dash-action-icon btn-sm !px-2 ${connTagIds.length > 0 ? "!border-accent !text-accent" : ""}`}
              onClick={() => {
                if (!showTagMenu && tagMenuRef.current) {
                  const rect = tagMenuRef.current.getBoundingClientRect();
                  const margin = 8; // breathing room from viewport edge
                  const spaceBelow = window.innerHeight - rect.bottom - margin;
                  const spaceAbove = rect.top - margin;
                  // Drop in whichever direction has more room. The menu's
                  // maxHeight is whatever space we actually have there, so
                  // long lists scroll inside the visible region instead of
                  // overflowing the viewport.
                  const dropUp = spaceAbove > spaceBelow;
                  const maxHeight = Math.max(120, dropUp ? spaceAbove : spaceBelow);
                  const dropLeft = rect.right - 200 >= 0;
                  setMenuPos({
                    ...(dropUp
                      ? { bottom: window.innerHeight - rect.top + 4 }
                      : { top: rect.bottom + 4 }),
                    ...(dropLeft ? { right: window.innerWidth - rect.right } : { left: rect.left }),
                    maxHeight,
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
                style={{
                  position: "fixed",
                  zIndex: 30,
                  minWidth: 200,
                  // maxHeight is computed from actual remaining viewport
                  // space (see button onClick) so the menu always fits and
                  // long lists scroll inside it.
                  overflowY: "auto",
                  ...menuPos,
                }}
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
            type="button"
            className="btn-connect-glass dash-row-connect"
            data-variant={leaseStatus === "EXPIRED" ? "renew" : undefined}
            style={{ padding: "0.35rem 0.8rem", fontSize: "0.75rem", whiteSpace: "nowrap" }}
            onClick={onConnect}
            disabled={isOffline}
            title={
              isOffline
                ? "Host is unreachable"
                : leaseStatus === "EXPIRED"
                  ? "Renew lease and connect"
                  : undefined
            }
          >
            {leaseStatus === "EXPIRED" ? "Renew & Connect" : "Connect"}
          </button>
          {vaultConfigured && (
            <div className="dash-account-select w-[200px] shrink-0">
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

// ── Connection Folder Tree ───────────────────────────────────────────
//
// Recursive nested-folder renderer. Each call produces:
//   • one <tr> for the folder header (chevron + name + descendant count)
//   • child folder rows (recursive)
//   • this folder's own connection rows
// Indentation is purely visual — applied via inline padding on the first cell.

interface FolderTreeNode {
  id: string;
  name: string;
  children: FolderTreeNode[];
  connections: Connection[];
  totalCount: number;
}

interface FolderTreeProps {
  node: FolderTreeNode;
  depth: number;
  expandedFolders: Set<string>;
  /** When set (i.e. a search filter is active), folders whose ID appears here
   *  are force-expanded regardless of the user's manual expand/collapse state. */
  autoExpandedIds: Set<string> | null;
  onToggleCollapse: (fid: string) => void;
  checked: Set<string>;
  toggleChecked: (id: string) => void;
  favorites: Set<string>;
  onToggleFavorite: (id: string) => void;
  vaultConfigured: boolean;
  credProfiles: CredentialProfile[];
  allCheckouts: CheckoutRequest[];
  connProfileMap: Record<string, string>;
  sessionStates: Record<string, TargetSessionState>;
  onProfileChange: (connectionId: string, profileId: string) => void;
  navigate: (path: string) => void;
  tags: UserTag[];
  connTagMap: Record<string, string[]>;
  onSetConnectionTags: (connectionId: string, tagIds: string[]) => void;
  onCreateTag: (name: string, color: string) => Promise<UserTag>;
  adminTagIds: Set<string>;
}

function ConnectionFolderTree(props: FolderTreeProps) {
  const { node, depth, expandedFolders, autoExpandedIds, onToggleCollapse } = props;
  const isExpanded = autoExpandedIds ? autoExpandedIds.has(node.id) : expandedFolders.has(node.id);
  const collapsed = !isExpanded;
  // Empty branches are hidden when search is active so the tree only shows hits.
  if (autoExpandedIds && node.totalCount === 0) return null;
  // 16px indent per depth level — matches VS Code Explorer / Outlook folder pane.
  const indentPx = 8 + depth * 16;
  const hasChildren = node.children.length > 0;

  return (
    <>
      <tr
        onClick={() => onToggleCollapse(node.id)}
        style={{ cursor: "pointer", background: "var(--color-surface-secondary)" }}
      >
        <td />
        <td colSpan={7} className="!py-2">
          <div
            className="flex items-center gap-2 font-semibold text-[0.8125rem]"
            style={{ paddingLeft: `${indentPx}px` }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
                transition: "transform 0.15s",
                opacity: hasChildren || node.connections.length > 0 ? 1 : 0.3,
              }}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
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
              {collapsed ? (
                <path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
              ) : (
                <path d="M2 7a2 2 0 012-2h5l2 2h9a2 2 0 012 2v1H2V7zm0 3h20l-2 8a2 2 0 01-2 1.5H6a2 2 0 01-2-1.5L2 10z" />
              )}
            </svg>
            <span>{node.name}</span>
            <span className="text-txt-tertiary font-normal">({node.totalCount})</span>
          </div>
        </td>
      </tr>
      {!collapsed && (
        <>
          {node.children.map((child) => (
            <ConnectionFolderTree key={child.id} {...props} node={child} depth={depth + 1} />
          ))}
          {node.connections.map((conn) => (
            <ConnectionRow
              key={conn.id}
              conn={conn}
              checked={props.checked.has(conn.id)}
              onToggleChecked={() => props.toggleChecked(conn.id)}
              isFavorite={props.favorites.has(conn.id)}
              onToggleFavorite={() => props.onToggleFavorite(conn.id)}
              vaultConfigured={props.vaultConfigured}
              credProfiles={props.credProfiles}
              allCheckouts={props.allCheckouts}
              assignedProfileId={props.connProfileMap[conn.id] || ""}
              session={props.sessionStates[conn.id]}
              onProfileChange={props.onProfileChange}
              onConnect={() => props.navigate(`/session/${conn.id}`)}
              tags={props.tags}
              connTagIds={props.connTagMap[conn.id] || []}
              onSetTags={props.onSetConnectionTags}
              onCreateTag={props.onCreateTag}
              adminTagIds={props.adminTagIds}
              indentPx={indentPx + 16}
            />
          ))}
        </>
      )}
    </>
  );
}
