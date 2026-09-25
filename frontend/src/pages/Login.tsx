import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { login, getStatus, StatusResponse } from "../api";
import { useTheme } from "../components/ThemeProvider";
import "./Login.css";

interface Props {
  onLogin: () => void;
}

type ThemePreference = "system" | "light" | "dark";
type ProviderVariant = "primary" | "capita" | "external";

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const FEATURES = [
  {
    icon: "privilege",
    title: "Advanced Privilege Management",
    text: "Multi-factor authentication and dynamic access control.",
  },
  {
    icon: "directory",
    title: "Unified Directory Integration",
    text: "Automated centralised identity sync and role-based access.",
  },
  {
    icon: "audit",
    title: "Comprehensive Auditing",
    text: "Continuous session monitoring and secure, tamper-evident logs.",
  },
] as const;

const HUB = { x: 230, y: 85 };
const SOURCES = [
  { x: 92, y: 34 },
  { x: 42, y: 85 },
  { x: 92, y: 136 },
];
const TARGETS = [
  { label: "RDP", y: 36 },
  { label: "SSH", y: 85 },
  { label: "VNC", y: 134 },
];
const PILL_X = 384;
const sourcePath = (s: { x: number; y: number }) => `M ${s.x} ${s.y} L ${HUB.x} ${HUB.y}`;
const targetPath = (y: number) => `M ${HUB.x} ${HUB.y} L ${PILL_X} ${y}`;

/** The first non-Capita provider is the primary; Capita keeps its brand styling. */
function providerVariants(providers: { name: string }[]): ProviderVariant[] {
  const isCapita = (name: string) => /capita/i.test(name);
  const primary = providers.findIndex((p) => !isCapita(p.name));
  return providers.map((p, i) =>
    isCapita(p.name) ? "capita" : i === primary ? "primary" : "external"
  );
}

export default function Login({ onLogin }: Props) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [redirectingTo, setRedirectingTo] = useState<string | null>(null);

  useEffect(() => {
    // Strip legacy fragment if present
    if (window.location.hash.includes("token=")) {
      window.history.replaceState(null, "", window.location.pathname);
    }

    async function init() {
      try {
        setStatus(await getStatus());
      } catch {
        setStatusFailed(true);
      }
    }
    init();
  }, [onLogin]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      await login({ username, password });
      onLogin();
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : t("login.errors.generic", "Sign-in failed. Please try again.")
      );
    } finally {
      setLoading(false);
    }
  }

  const providers = status?.sso_enabled ? (status.sso_providers ?? []) : [];
  const variants = providerVariants(providers);
  const showLocal = !!status?.local_auth_enabled;

  return (
    <div className="strata-login">
      <LoginBackground />

      {/* ── Left: feature showcase ── */}
      <section className="sl-feature" aria-label="About Strata Client">
        <img className="sl-logo" src="/logo-dark.png" alt="Strata Client" />

        <div>
          <h1 className="sl-h1">
            <span className="sl-h1-amber">Privileged Access.</span>
            <span className="sl-h1-blue">Secure Gateway.</span>
          </h1>
          <p className="sl-lead">
            Securely connect to critical infrastructure without VPNs, delivering high-performance
            remote access and unified security controls.
          </p>
        </div>

        <NetworkDiagram />

        <ul className="sl-features">
          {FEATURES.map((f) => (
            <li key={f.title} className="sl-feature-item">
              <span className="sl-feature-icon" aria-hidden="true">
                <FeatureIcon name={f.icon} />
              </span>
              <p className="sl-feature-copy">
                <strong className="sl-h2">{f.title}</strong> - {f.text}
              </p>
            </li>
          ))}
        </ul>
      </section>

      {/* ── Right: authentication ── */}
      <section className="sl-auth" aria-label="Sign in">
        <div className="sl-auth-top">
          <SystemMenu />
        </div>

        <div className="sl-auth-main">
          <h2 className="sl-h3">Welcome back</h2>
          <p className="sl-p3">Sign in to manage your connections</p>

          <div className="sl-card">
            {error && (
              <div className="sl-error" role="alert">
                {error}
              </div>
            )}

            {!status && !statusFailed && (
              <div className="sl-skeleton" role="status" aria-label="Loading sign-in options">
                <div className="sl-skeleton-bar" />
                <div className="sl-skeleton-bar" />
                <div className="sl-skeleton-bar" />
              </div>
            )}

            {statusFailed && (
              <div className="sl-error" role="alert">
                The authentication service could not be reached. Refresh the page to try again.
              </div>
            )}

            {providers.length > 0 && (
              <>
                <div className="sl-buttons">
                  {providers.map((provider, idx) => {
                    const variant = variants[idx];
                    const busy = redirectingTo === provider.id;
                    return (
                      <a
                        key={provider.id}
                        href={`/api/auth/sso/login?provider=${encodeURIComponent(provider.id)}`}
                        className={`sl-btn sl-btn-${variant}`}
                        aria-busy={busy || undefined}
                        onClick={() => setRedirectingTo(provider.id)}
                      >
                        {busy ? (
                          <span className="sl-spinner" aria-hidden="true" />
                        ) : (
                          <ProviderIcon variant={variant} />
                        )}
                        <span>{busy ? "Redirecting…" : `Sign in with ${provider.name}`}</span>
                      </a>
                    );
                  })}
                </div>
                <p className="sl-oidc-note">Secure enterprise login via OIDC</p>
              </>
            )}

            {providers.length > 0 && showLocal && (
              <div className="sl-separator">or use a local account</div>
            )}

            {showLocal && (
              <form onSubmit={handleSubmit} className="sl-form">
                <div>
                  <label htmlFor="login-username" className="sl-label">
                    {t("login.username", "Username")}
                  </label>
                  <input
                    id="login-username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="admin"
                    autoComplete="username"
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus={providers.length === 0}
                    required
                    className="sl-input"
                  />
                </div>
                <div>
                  <label htmlFor="login-password" className="sl-label">
                    {t("login.password", "Password")}
                  </label>
                  <input
                    id="login-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="current-password"
                    required
                    className="sl-input"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading || !username || !password}
                  className="sl-submit"
                >
                  {loading && <span className="sl-spinner" aria-hidden="true" />}
                  {loading
                    ? t("login.submitInProgress", "Signing in…")
                    : t("login.submit", "Sign in")}
                </button>
              </form>
            )}
          </div>
        </div>

        <footer className="sl-footer">Strata Client</footer>
      </section>
    </div>
  );
}

/* ── Top-right theme toggle (cycles system → light → dark) ────────── */

function SystemMenu() {
  const { preference, cycle, setPreference } = useTheme();
  const label = THEME_OPTIONS.find((o) => o.value === preference)?.label ?? "System";

  const handleCycle = () => {
    if (cycle) {
      cycle();
    } else if (setPreference) {
      const order: ThemePreference[] = ["system", "light", "dark"];
      const next = order[(order.indexOf(preference) + 1) % order.length];
      setPreference(next);
    }
  };

  return (
    <div className="sl-system">
      <button
        type="button"
        className="sl-system-trigger"
        aria-label={`Theme: ${label}. Click to cycle.`}
        title={`Theme: ${label}. Click to cycle.`}
        onClick={handleCycle}
      >
        <ThemeIcon value={preference} />
        <span>{label}</span>
      </button>
    </div>
  );
}

/* ── Full-page constellation: static nodes + pulsing, flowing overlay ── */

const BG_NODES: [number, number][] = [
  [60, 120],
  [210, 60],
  [360, 150],
  [150, 300],
  [300, 420],
  [90, 560],
  [260, 700],
  [470, 620],
  [560, 330],
  [700, 90],
  [760, 520],
  [520, 860],
  [900, 200],
  [1040, 90],
  [1160, 260],
  [980, 420],
  [1300, 140],
  [1440, 320],
  [1220, 560],
  [1060, 740],
  [1380, 700],
  [1540, 520],
  [1520, 860],
  [880, 820],
];

const BG_LINKS: [number, number][] = [
  [0, 1],
  [1, 2],
  [0, 3],
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 6],
  [4, 7],
  [6, 7],
  [2, 8],
  [8, 9],
  [1, 9],
  [7, 10],
  [8, 10],
  [6, 11],
  [7, 11],
  [9, 12],
  [12, 13],
  [12, 14],
  [13, 14],
  [12, 15],
  [14, 15],
  [13, 16],
  [14, 16],
  [16, 17],
  [14, 18],
  [15, 18],
  [18, 19],
  [10, 15],
  [18, 20],
  [17, 21],
  [20, 21],
  [20, 22],
  [19, 23],
  [11, 23],
  [10, 19],
];

const BG_FLOWS = [
  [1, 2, 8, 9],
  [3, 4, 7, 10],
  [5, 6, 11],
  [12, 14, 18, 20],
  [13, 16, 17, 21],
];

function LoginBackground() {
  const pt = (i: number) => BG_NODES[i];
  return (
    <div className="sl-bg" aria-hidden="true">
      <svg
        className="sl-bg-network"
        viewBox="0 0 1600 900"
        preserveAspectRatio="xMidYMid slice"
        xmlns="http://www.w3.org/2000/svg"
      >
        <g>
          {BG_LINKS.map(([a, b]) => (
            <line
              key={`${a}-${b}`}
              className="sl-bg-link"
              x1={pt(a)[0]}
              y1={pt(a)[1]}
              x2={pt(b)[0]}
              y2={pt(b)[1]}
            />
          ))}
          {BG_NODES.map(([x, y]) => (
            <circle key={`${x}-${y}`} className="sl-bg-node" cx={x} cy={y} r={2.5} />
          ))}
        </g>
        <g className="sl-bg-glow">
          {BG_FLOWS.map((chain) => (
            <path
              key={chain.join("-")}
              d={chain.map((i, n) => `${n === 0 ? "M" : "L"} ${pt(i)[0]} ${pt(i)[1]}`).join(" ")}
            />
          ))}
          {BG_NODES.filter((_, i) => i % 3 === 0).map(([x, y], i) => (
            <circle
              key={`${x}-${y}`}
              cx={x}
              cy={y}
              r={5}
              style={{ animationDelay: `${i * 0.7}s` }}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

/* ── Architecture diagram: identity sources → gateway → protocols ── */

function NetworkDiagram() {
  return (
    <svg
      className="sl-diagram"
      viewBox="0 0 460 170"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Identity, vault and credential sources connect through the Strata gateway to RDP, SSH and VNC targets"
    >
      {SOURCES.map((s, i) => (
        <path key={`sl${i}`} className="sl-diagram-link-amber" d={sourcePath(s)} />
      ))}
      {TARGETS.map((t) => (
        <path key={`tl${t.label}`} className="sl-diagram-link-cyan" d={targetPath(t.y)} />
      ))}

      {SOURCES.map((s, i) => (
        <path
          key={`sf${i}`}
          className="sl-diagram-flow sl-diagram-flow-amber"
          d={sourcePath(s)}
          style={{ animationDelay: `${-i * 0.6}s` }}
        />
      ))}
      {TARGETS.map((t, i) => (
        <path
          key={`tf${t.label}`}
          className="sl-diagram-flow sl-diagram-flow-cyan"
          d={targetPath(t.y)}
          style={{ animationDelay: `${-i * 0.6}s` }}
        />
      ))}

      {/* Data points travel each link, fading in and out */}
      {[...SOURCES.map(sourcePath), ...TARGETS.map((t) => targetPath(t.y))].map((d, i) => (
        <circle key={d} className="sl-diagram-packet" r={2.5}>
          <animateMotion path={d} dur="2s" begin={`${-i * 0.35}s`} repeatCount="indefinite" />
          <animate
            attributeName="opacity"
            values="0;1;1;0"
            keyTimes="0;0.15;0.85;1"
            dur="2s"
            begin={`${-i * 0.35}s`}
            repeatCount="indefinite"
          />
        </circle>
      ))}

      {/* Source 1: identity key */}
      <g transform={`translate(${SOURCES[0].x} ${SOURCES[0].y})`}>
        <circle className="sl-diagram-node-amber" r="15" />
        <circle className="sl-diagram-glyph-amber" cx="-3" cy="-3" r="4" />
        <path className="sl-diagram-glyph-amber" d="M0 0 L7 7 M4 4 L6 2 M6 6 L8 4" />
      </g>

      {/* Source 2: vault */}
      <g transform={`translate(${SOURCES[1].x} ${SOURCES[1].y})`}>
        <path className="sl-diagram-node-amber" d="M0 -17 L17 12 L-17 12 Z" />
        <path className="sl-diagram-glyph-amber" d="M-5 -2 L0 6 L5 -2" />
      </g>

      {/* Source 3: credential badge */}
      <g transform={`translate(${SOURCES[2].x} ${SOURCES[2].y})`}>
        <rect className="sl-diagram-node-amber" x="-15" y="-12" width="30" height="24" rx="4" />
        <circle className="sl-diagram-glyph-amber" cx="-6" cy="-2" r="3" />
        <path className="sl-diagram-glyph-amber" d="M-11 7 C-11 3, -1 3, -1 7 M3 -3 H10 M3 2 H8" />
      </g>

      {/* Gateway hub */}
      <g transform={`translate(${HUB.x} ${HUB.y})`}>
        <circle className="sl-diagram-pulse" r="26" />
        <circle className="sl-diagram-node-cyan" r="24" strokeWidth="2" />
        {[-8, 0, 8].map((dy) => (
          <g key={dy}>
            <rect
              className="sl-diagram-glyph-cyan"
              x="-10"
              y={dy - 3}
              width="20"
              height="6"
              rx="1"
            />
            <circle cx="-6" cy={dy} r="0.9" fill="#3ACEEF" />
          </g>
        ))}
      </g>

      {/* Protocol targets */}
      {TARGETS.map((t) => (
        <g key={t.label} transform={`translate(${PILL_X} ${t.y - 11})`}>
          <rect className="sl-diagram-node-cyan" width="58" height="22" rx="5" />
          <rect className="sl-diagram-glyph-cyan" x="7" y="6" width="10" height="7" rx="1" />
          <path className="sl-diagram-glyph-cyan" d="M12 13 V16 M10 16 H14" />
          <text className="sl-diagram-label" x="22" y="15">
            {t.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

/* ── Icons ──────────────────────────────────────────────────────── */

const svgProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function FeatureIcon({ name }: { name: (typeof FEATURES)[number]["icon"] }) {
  if (name === "privilege") {
    return (
      <svg width="18" height="18" {...svgProps}>
        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
      </svg>
    );
  }
  if (name === "directory") {
    return (
      <svg width="18" height="18" {...svgProps}>
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" {...svgProps}>
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
}

function ProviderIcon({ variant }: { variant: ProviderVariant }) {
  if (variant === "primary") {
    return (
      <svg className="sl-btn-icon" {...svgProps}>
        <circle cx="12" cy="12" r="10" />
        <circle cx="12" cy="10" r="3" />
        <path d="M6.5 18a6 6 0 0 1 11 0" />
      </svg>
    );
  }
  if (variant === "capita") {
    return (
      <svg className="sl-btn-icon" {...svgProps}>
        <circle cx="12" cy="12" r="10" />
        <path d="M15.5 9a4.5 4.5 0 1 0 0 6" strokeWidth={2.25} />
      </svg>
    );
  }
  return (
    <svg className="sl-btn-icon" {...svgProps}>
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </svg>
  );
}

function ThemeIcon({ value }: { value: ThemePreference }) {
  if (value === "light") {
    return (
      <svg width="14" height="14" {...svgProps} strokeWidth={2}>
        <circle cx="12" cy="12" r="5" />
        <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
      </svg>
    );
  }
  if (value === "dark") {
    return (
      <svg width="14" height="14" {...svgProps} strokeWidth={2}>
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" {...svgProps} strokeWidth={2}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}
