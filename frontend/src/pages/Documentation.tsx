import { useState, useMemo, useEffect } from "react";
import { marked } from "marked";
import { RELEASE_CARDS, WHATS_NEW_VERSION } from "../components/WhatsNewModal";
import Select from "../components/Select";
import {
  getRoadmapStatuses,
  setRoadmapStatus,
  type MeResponse,
  type RoadmapStatus as ApiRoadmapStatus,
} from "../api";

// Raw markdown imports (bundled at build time via Vite ?raw)
import architectureMd from "@docs/architecture.md?raw";
import securityMd from "@docs/security.md?raw";
import apiReferenceMd from "@docs/api-reference.md?raw";

/* ── Sidebar sections ──────────────────────────────────────────────── */

interface DocSection {
  id: string;
  label: string;
  icon: JSX.Element;
  content: string | null; // null = custom renderer (What's New)
}

const ICON_SIZE = 16;

const SECTIONS: DocSection[] = [
  {
    id: "whats-new",
    label: "What's New",
    icon: (
      <svg
        width={ICON_SIZE}
        height={ICON_SIZE}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    ),
    content: null,
  },
  {
    id: "architecture",
    label: "Architecture",
    icon: (
      <svg
        width={ICON_SIZE}
        height={ICON_SIZE}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    ),
    content: architectureMd,
  },

  {
    id: "security",
    label: "Security",
    icon: (
      <svg
        width={ICON_SIZE}
        height={ICON_SIZE}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
    content: securityMd,
  },
  {
    id: "api-reference",
    label: "API Reference",
    icon: (
      <svg
        width={ICON_SIZE}
        height={ICON_SIZE}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    ),
    content: apiReferenceMd,
  },
  {
    id: "roadmap",
    label: "Roadmap",
    icon: (
      <svg
        width={ICON_SIZE}
        height={ICON_SIZE}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3V6z" />
        <path d="M9 3v15M15 6v15" />
      </svg>
    ),
    content: null,
  },
];

/* ── Markdown renderer config ──────────────────────────────────────── */

marked.setOptions({ gfm: true, breaks: false });

/* ── Component ─────────────────────────────────────────────────────── */

export default function Documentation({ user }: { user?: MeResponse | null }) {
  const [activeId, setActiveId] = useState(SECTIONS[0].id);
  const active = SECTIONS.find((s) => s.id === activeId)!;

  // Memoise parsed HTML per section to avoid re-parsing on every render
  const htmlCache = useMemo(() => {
    const cache: Record<string, string> = {};
    for (const s of SECTIONS) {
      if (s.content) {
        cache[s.id] = marked.parse(s.content) as string;
      }
    }
    return cache;
  }, []);

  return (
    <div className="flex gap-6 min-h-[calc(100vh-4rem)]">
      {/* ── Left nav ── */}
      <nav className="shrink-0 w-52 sticky top-8 self-start flex flex-col gap-0.5">
        <h2 className="text-xs uppercase tracking-widest text-txt-tertiary font-semibold mb-3 px-2.5">
          Documentation
        </h2>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setActiveId(s.id)}
            className={`flex items-center gap-2.5 rounded-md text-[0.8125rem] font-medium transition-all duration-150 py-2 px-2.5 text-left cursor-pointer
              ${
                activeId === s.id
                  ? "text-txt-primary bg-accent-dim font-semibold"
                  : "text-txt-secondary hover:text-txt-primary hover:bg-surface-secondary"
              }`}
          >
            {s.icon}
            {s.label}
          </button>
        ))}
      </nav>

      {/* ── Content area ── */}
      <div className="flex-1 min-w-0">
        {active.content !== null ? (
          <article
            className="prose-docs"
            dangerouslySetInnerHTML={{ __html: htmlCache[active.id] }}
          />
        ) : active.id === "roadmap" ? (
          <RoadmapContent user={user} />
        ) : (
          <WhatsNewContent />
        )}
      </div>
    </div>
  );
}

/* ── What's New tab (reuses RELEASE_CARDS) ─────────────────────────── */

function WhatsNewContent() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-txt-primary mb-1">What's New</h1>
        <p className="text-sm text-txt-tertiary">
          Release highlights for Strata Client. Current version:{" "}
          <span className="font-semibold text-accent">{WHATS_NEW_VERSION}</span>
        </p>
      </div>

      <div className="space-y-6">
        {RELEASE_CARDS.map((card, idx) => (
          <div
            key={card.version}
            className="rounded-xl overflow-hidden"
            style={{
              background: "var(--color-surface-secondary)",
              border: "1px solid var(--color-border)",
            }}
          >
            {/* Card header */}
            <div
              className="px-5 py-4 flex items-center gap-3"
              style={{ borderBottom: "1px solid var(--color-border)" }}
            >
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold shrink-0"
                style={{
                  background: idx === 0 ? "var(--color-accent)" : "var(--color-surface-tertiary)",
                  color: idx === 0 ? "white" : "var(--color-txt-secondary)",
                }}
              >
                {idx === 0 ? "✦" : card.version.split(".").pop()}
              </div>
              <div>
                <h3 className="text-sm font-semibold text-txt-primary leading-tight">
                  v{card.version}
                  {idx === 0 && (
                    <span className="ml-2 text-[0.625rem] uppercase tracking-wider font-bold text-accent bg-accent/10 px-1.5 py-0.5 rounded">
                      Latest
                    </span>
                  )}
                </h3>
                <p className="text-xs text-txt-tertiary">{card.subtitle}</p>
              </div>
            </div>

            {/* Card sections */}
            <div className="px-5 py-4 space-y-4">
              {card.sections.map((s, i) => (
                <div key={i}>
                  <h4 className="text-sm font-semibold text-txt-primary mb-1 flex items-center gap-2">
                    <span className="text-accent text-xs">●</span> {s.title}
                  </h4>
                  <p className="text-[0.8125rem] text-txt-secondary leading-relaxed">
                    {s.description}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Roadmap tab ───────────────────────────────────────────────────── */

type RoadmapStatus = ApiRoadmapStatus;

const ROADMAP_STATUSES: RoadmapStatus[] = ["Proposed", "Researching", "In Progress", "Shipped"];

interface RoadmapItem {
  id: string;
  title: string;
  status: RoadmapStatus;
  areas: string[];
  description: string;
  bullets?: string[];
}

interface RoadmapTheme {
  id: string;
  title: string;
  subtitle: string;
  accent: string;
  items: RoadmapItem[];
}

const ROADMAP: RoadmapTheme[] = [
  {
    id: "recordings",
    title: "Recording Enhancements",
    subtitle: "Capture, search, and protect playback.",
    accent: "#a78bfa",
    items: [
      {
        id: "recording-screenshots",
        title: "Historic Recording Screenshots",
        status: "Proposed",
        areas: ["Recordings", "Client"],
        description:
          "One-click frame capture during playback. A rolling buffer keeps the last 5 snapshots in-memory — the 6th overwrites the oldest. Download individually or as a zip; everything is discarded when the page closes.",
      },
      {
        id: "recording-pii-redaction",
        title: "Automatic PII Redaction",
        status: "Researching",
        areas: ["Recordings", "Privacy", "Compliance"],
        description:
          "OCR-driven scan of rendered frames blurs or redacts patterns like NI numbers, credit-card PANs, and email addresses before the recording is played back. Rules are per-tenant / per-tag with an audit trail of every change.",
      },
    ],
  },
  {
    id: "security",
    title: "Security & Zero Trust Access",
    subtitle: "Harden the most sensitive environments.",
    accent: "#f87171",
    items: [
      {
        id: "security-red-tiers",
        title: 'Color-Coded Security Tiers ("Red" Servers)',
        status: "Proposed",
        areas: ["Access Control", "Auth"],
        description:
          "Visible tiering for ultra-sensitive hosts (PCI, finance, DR). Red tier requires a genuine third factor — mutually-authenticated device cert or hardware token (YubiKey / FIDO2) — in addition to the normal login.",
      },
      {
        id: "security-immutable-flags",
        title: "Immutable Security Flags",
        status: "Proposed",
        areas: ["Access Control", "Governance"],
        description:
          "Red tier cannot be downgraded from the standard admin UI so a compromised admin account cannot quietly weaken a high-tier host.",
        bullets: [
          "Tier defined in read-only config / IaC loaded at boot",
          "DB constraint + two-person signed change-log, or",
          "Write-once column revertable only via filesystem / IaC",
        ],
      },
      {
        id: "security-device-posture",
        title: "Context-Aware Access (Device Posture)",
        status: "Proposed",
        areas: ["Access Control", "Client"],
        description:
          "Before connecting — especially to Red hosts — evaluate local posture and gate accordingly. Failures block, warn, or log depending on tier.",
        bullets: [
          "Source IP within a recognised corporate CIDR",
          "OS patch level within policy window",
          "Endpoint protection active with fresh signatures",
          "Disk encryption enabled",
        ],
      },
    ],
  },
  {
    id: "audit",
    title: "Auditing, Analytics & Compliance",
    subtitle: "Make the entire session archive first-class data.",
    accent: "#60a5fa",
    items: [
      {
        id: "audit-ocr",
        title: "OCR Over Recorded Sessions",
        status: "Proposed",
        areas: ["Auditing", "Search"],
        description:
          "Background job transcribes on-screen text from every recording into a searchable index. Auditors query the full archive and jump straight to matching timestamps.",
      },
      {
        id: "audit-anomaly-detection",
        title: "Anomaly Detection",
        status: "Researching",
        areas: ["Auditing", "Risk"],
        description:
          "Learn each user's normal servers, times, source IPs, and protocols. Deviations — a UK-hours dev suddenly hitting a finance DB at 03:00 from a new IP — trigger a block + JIT approval flow or real-time review.",
      },
      {
        id: "audit-personal-metrics",
        title: "Personal Metrics & Usage Reports",
        status: "Proposed",
        areas: ["Analytics"],
        description:
          "Per-user dashboards (my sessions this month, time per host) and admin views (top users, idle servers, peak concurrency), exportable to CSV / PDF for management reporting.",
      },
    ],
  },
  {
    id: "workflows",
    title: "Workflows & Collaboration",
    subtitle: "Turn the client into a team tool.",
    accent: "#34d399",
    items: [
      {
        id: "workflows-multiplayer",
        title: "Multiplayer / Co-Pilot Mode",
        status: "Proposed",
        areas: ["Sessions", "Collaboration"],
        description:
          "Extend share links into real-time collaboration with named multi-cursors, a chat overlay, optional WebRTC audio, and turn-based keyboard handoff. Built for pair programming, IT support, and on-boarding.",
      },
      {
        id: "workflows-quick-share-outbound",
        title: "Quick-Share Outbound (Approval-Gated)",
        status: "Proposed",
        areas: ["File Transfer", "DLP"],
        description:
          "Reverse of the current Quick-Share: a user exports a file from a session into an encrypted staging area. An admin (or automated DLP policy) approves before release; rejected files are purged. Every request + decision is logged.",
      },
    ],
  },
  {
    id: "notifications",
    title: "Notifications & Email",
    subtitle: "Keep humans in the loop with clear, consistent comms.",
    accent: "#f472b6",
    items: [
      {
        id: "notifications-managed-account-emails",
        title: "Modern Managed-Account Notification Emails",
        status: "Proposed",
        areas: ["Notifications", "Email", "Managed Accounts"],
        description:
          "Redesigned transactional emails for the full managed-account checkout lifecycle — approval, rejection, and self-approval — sent automatically with a consistent modern template that renders cleanly in Outlook (dark-mode safe) and mobile clients.",
        bullets: [
          "Event triggers: approval granted, request rejected, self-approval exercised",
          "Body always includes: requesting user, target AD account, justification, expiry time, and approver identity",
          "One-click links back to the approvals page and the audit log entry",
          "Tenant-brandable header + footer with neutral fallback styling",
        ],
      },
    ],
  },
];

function statusColors(status: RoadmapStatus): { bg: string; fg: string } {
  switch (status) {
    case "Shipped":
      return { bg: "rgba(52,211,153,0.15)", fg: "#34d399" };
    case "In Progress":
      return { bg: "rgba(96,165,250,0.15)", fg: "#60a5fa" };
    case "Researching":
      return { bg: "rgba(251,191,36,0.15)", fg: "#fbbf24" };
    case "Proposed":
    default:
      return { bg: "rgba(148,163,184,0.15)", fg: "#94a3b8" };
  }
}

function RoadmapContent({ user }: { user?: MeResponse | null }) {
  const canEdit = !!user?.can_manage_system;
  const [overrides, setOverrides] = useState<Record<string, RoadmapStatus>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getRoadmapStatuses()
      .then((res) => {
        if (!cancelled) setOverrides(res.statuses || {});
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err?.message || "Failed to load roadmap statuses");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const effectiveStatus = (item: RoadmapItem): RoadmapStatus => overrides[item.id] ?? item.status;

  const totals = useMemo(() => {
    const t: Record<RoadmapStatus, number> = {
      Proposed: 0,
      Researching: 0,
      "In Progress": 0,
      Shipped: 0,
    };
    for (const theme of ROADMAP) for (const it of theme.items) t[effectiveStatus(it)]++;
    return t;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides]);

  const handleChange = async (itemId: string, next: RoadmapStatus) => {
    const prev = overrides[itemId];
    setOverrides((o) => ({ ...o, [itemId]: next }));
    setSavingId(itemId);
    setSaveError(null);
    try {
      await setRoadmapStatus(itemId, next);
    } catch (err) {
      setOverrides((o) => {
        const copy = { ...o };
        if (prev === undefined) delete copy[itemId];
        else copy[itemId] = prev;
        return copy;
      });
      setSaveError((err as Error)?.message || "Failed to update status");
    } finally {
      setSavingId((s) => (s === itemId ? null : s));
    }
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-2xl font-bold tracking-tight text-txt-primary">Product Roadmap</h1>
          <span
            className="text-[0.625rem] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded"
            style={{ background: "rgba(167,139,250,0.15)", color: "#a78bfa" }}
          >
            Forward-Looking
          </span>
          {canEdit && (
            <span
              className="text-[0.625rem] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded"
              style={{ background: "rgba(96,165,250,0.15)", color: "#60a5fa" }}
              title="You can update roadmap item statuses"
            >
              Admin Editable
            </span>
          )}
        </div>
        <p className="text-sm text-txt-tertiary max-w-2xl">
          Proposed feature work beyond the current shipped releases. Items here represent direction
          and intent — not committed delivery dates. Shipped features move to the{" "}
          <strong className="text-txt-secondary font-semibold">What's New</strong> tab.
        </p>
        {loadError && (
          <p className="mt-2 text-xs" style={{ color: "#f87171" }}>
            Could not load saved statuses: {loadError}. Showing defaults.
          </p>
        )}
        {saveError && (
          <p className="mt-2 text-xs" style={{ color: "#f87171" }}>
            {saveError}
          </p>
        )}
      </div>

      {/* Status summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {(Object.keys(totals) as RoadmapStatus[]).map((s) => {
          const { bg, fg } = statusColors(s);
          return (
            <div
              key={s}
              className="rounded-lg px-4 py-3"
              style={{
                background: "var(--color-surface-secondary)",
                border: "1px solid var(--color-border)",
              }}
            >
              <div className="text-xs uppercase tracking-wider text-txt-tertiary font-semibold mb-1">
                {s}
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold" style={{ color: fg }}>
                  {totals[s]}
                </span>
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ background: bg, boxShadow: `0 0 0 2px ${fg}33` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Themes */}
      {ROADMAP.map((theme) => (
        <section key={theme.id} className="space-y-4">
          <div
            className="flex items-center gap-3 pb-2"
            style={{ borderBottom: "1px solid var(--color-border)" }}
          >
            <div className="w-1.5 h-8 rounded-full" style={{ background: theme.accent }} />
            <div>
              <h2 className="text-base font-semibold text-txt-primary leading-tight">
                {theme.title}
              </h2>
              <p className="text-xs text-txt-tertiary">{theme.subtitle}</p>
            </div>
            <span className="ml-auto text-[0.6875rem] text-txt-tertiary font-medium">
              {theme.items.length} item{theme.items.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {theme.items.map((item) => {
              const current = effectiveStatus(item);
              const sc = statusColors(current);
              const saving = savingId === item.id;
              return (
                <div
                  key={item.id}
                  className="rounded-xl p-5 flex flex-col gap-3 transition-colors"
                  style={{
                    background: "var(--color-surface-secondary)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-sm font-semibold text-txt-primary leading-snug">
                      {item.title}
                    </h3>
                    {canEdit ? (
                      <div className="shrink-0 w-40" title="Change status">
                        <Select
                          value={current}
                          onChange={(v) => handleChange(item.id, v as RoadmapStatus)}
                          disabled={saving}
                          options={ROADMAP_STATUSES.map((s) => ({ value: s, label: s }))}
                          className="w-40"
                        />
                      </div>
                    ) : (
                      <span
                        className="shrink-0 text-[0.625rem] uppercase tracking-wider font-bold px-2 py-0.5 rounded"
                        style={{ background: sc.bg, color: sc.fg }}
                      >
                        {current}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {item.areas.map((a) => (
                      <span
                        key={a}
                        className="text-[0.6875rem] px-2 py-0.5 rounded font-medium"
                        style={{
                          background: "var(--color-surface-tertiary)",
                          color: "var(--color-txt-secondary)",
                        }}
                      >
                        {a}
                      </span>
                    ))}
                  </div>
                  <p className="text-[0.8125rem] text-txt-secondary leading-relaxed">
                    {item.description}
                  </p>
                  {item.bullets && (
                    <ul
                      className="text-[0.8125rem] text-txt-secondary leading-relaxed space-y-1 pl-4"
                      style={{ listStyle: "disc" }}
                    >
                      {item.bullets.map((b, bi) => (
                        <li key={bi}>{b}</li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {/* Footer */}
      <div
        className="rounded-lg px-5 py-4 text-xs text-txt-tertiary"
        style={{
          background: "var(--color-surface-secondary)",
          border: "1px dashed var(--color-border)",
        }}
      >
        Have a feature suggestion? Raise an issue in the project tracker and tag it{" "}
        <code
          className="px-1 py-0.5 rounded text-txt-secondary"
          style={{ background: "var(--color-surface-tertiary)" }}
        >
          roadmap
        </code>
        .
      </div>
    </div>
  );
}
