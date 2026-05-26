/* eslint-disable react-hooks/set-state-in-effect --
   react-hooks v7 compiler-strict suppressions: legitimate prop->state sync, session
   decoration, or render-time time/derivation patterns. See
   eslint.config.js W4-1 commentary. */
import { useState, useEffect } from "react";

const STORAGE_KEY = "strata-whats-new-dismissed";
const WELCOME_KEY = "strata-welcome-dismissed";

/** Current app version — sourced from package.json via Vite define. */
export const WHATS_NEW_VERSION = __APP_VERSION__;

/* ── Release card data ─────────────────────────────────────────────── */

interface ReleaseSection {
  title: string;
  description: string;
}

export interface ReleaseCard {
  version: string;
  subtitle: string;
  sections: ReleaseSection[];
}

/**
 * Ordered newest-first. Add a new entry at the top for each release.
 * Only include versions with user-facing changes worth highlighting.
 */
export const RELEASE_CARDS: ReleaseCard[] = [
  {
    version: "1.10.2",
    subtitle:
      "Patch release — Safeguard automated token enrolment via one-shot codes. Operators now sign in to Safeguard via the browser RSTS flow and the token is automatically submitted back to Strata without manual copy-paste",
    sections: [
      {
        title: "Automated Safeguard token submission via enrolment codes",
        description:
          "The Safeguard sign-in card on the Credentials page now uses one-shot enrolment codes (8-character Crockford base-32, 5-minute TTL, single-use, rate-limited 5/min/user) to bridge the gap between the browser-based RSTS sign-in flow and automated token submission. Operators click Sign in, receive a copy-paste PowerShell snippet with an embedded enrolment code, run the snippet to Connect-Safeguard and post the resulting bearer token back to Strata via Invoke-RestMethod. The UI displays a live countdown timer (MM:SS) showing time remaining before the code window expires, and polls /api/user/safeguard/status to auto-close the modal when sign-in completes. A fallback text field (toggled via Having trouble?) is available for operators who need manual paste.",
      },
      {
        title: "One-shot enrolment code lifecycle",
        description:
          "Authed /api/user/safeguard/signin/start mints an 8-character code tied to the user's ID with a 5-minute expiry, rate-limited to 5 mints per minute per user. Unauthed /api/safeguard/enrol atomically validates the code (not used, not expired, valid alphabet), looks up the bound user_id, seals the bearer token via Vault, and stores it in safeguard_user_tokens (same path as v1.10.0 manual paste). Returns uniform Invalid or expired errors for all failure paths. Daily background job purges codes that expired >1 day ago.",
      },
      {
        title: "PowerShell auto-post snippet and countdown timer",
        description:
          "The modal renders a copy-paste PowerShell snippet with the embedded enrolment code already filled in. The snippet calls Connect-Safeguard to authenticate against the RSTS appliance, then Invoke-RestMethod to POST the code + bearer token to /api/safeguard/enrol. A countdown timer displays remaining time before the code window closes; when the window expires, operators click Get a new code to mint a fresh one. While the modal is open, the UI polls every 2 seconds and auto-closes when signed_in=true.",
      },
    ],
  },
  {
    version: "1.10.1",
    subtitle:
      "Patch release — Safeguard sign-in PowerShell snippet is now idempotent, plus routine dependency hygiene (nginx runtime base, frontend dev-deps, and pinned-by-SHA GitHub Actions)",
    sections: [
      {
        title: "Idempotent Safeguard sign-in PowerShell snippet",
        description:
          "The copy-paste PowerShell helper rendered by the Safeguard sign-in card on the Credentials page now wraps the Install-Module Safeguard-PS call in a Get-Module -ListAvailable guard and prefixes the snippet with Set-ExecutionPolicy RemoteSigned -Scope CurrentUser — matching the pattern Strata's other PowerShell helpers use. Operators who re-run the snippet at the start of every shift no longer pay the cost of a redundant module download against the PowerShell Gallery, and the Connect-Safeguard -Browser -IdentityProvider <alias> tail is unchanged so existing notes and runbooks keep working without edits.",
      },
      {
        title: "Dependency hygiene",
        description:
          "frontend/Dockerfile rebases onto nginx:1.31.1-alpine (pinned by digest) to pick up the latest upstream Alpine package security patches. Four frontend dev-dependencies are rolled forward lockfile-only — @types/react 19.2.14 → 19.2.15, @vitest/coverage-v8 4.1.6 → 4.1.7, vite 8.0.13 → 8.0.14, and vitest 4.1.6 → 4.1.7. Six pinned-by-SHA GitHub Actions are bumped per the repo's pinning policy — docker/setup-buildx-action v4.0.0 → v4.1.0, docker/build-push-action v7.1.0 → v7.2.0, docker/login-action v4.1.0 → v4.2.0, docker/metadata-action v6.0.0 → v6.1.0, github/codeql-action v4.35.5 → v4.36.0, and actions/stale v10.2.0 → v10.3.0. No runtime behaviour changes, no migrations, no configuration changes.",
      },
    ],
  },
  {
    version: "1.10.0",
    subtitle:
      "OneIdentity Safeguard JIT credential checkout — fetch privileged-account passwords from Safeguard at tunnel-open time with bulk checkout, per-user browser sign-in, A2A, optional Vault-sealed caching, and full hardening against every 8.x REST quirk",
    sections: [
      {
        title: "Just-in-time credential checkout against Safeguard",
        description:
          "A new safeguard credential-profile kind resolves its password from OneIdentity Safeguard for Privileged Passwords at the moment the tunnel is opened, instead of carrying a locally-stored password. Each tunnel runs a four-step REST dance against the appliance — preflight any stale request this user holds for the same target, post a fresh access request stamped with the user's justification and the profile's TTL, retrieve the released password via CheckoutPassword, and hand it to the existing Guacamole connection path. The username is built from AccountName + AccountDomainName so RDP receives the correct logon name rather than the numeric account id.",
      },
      {
        title: "Bulk Checkout and one-click check-in",
        description:
          "The Credentials page gains a Request Checkout tab pairing a Safeguard sign-in card with a Bulk Checkout card. Users supply a single mandatory Justification (sent verbatim as Safeguard's ReasonComment for every selected profile), pick any subset of their Safeguard-backed profiles via per-row checkboxes plus a master Select all toggle, and click Checkout selected to pre-fetch every password in one signed-in burst. Failures are inlined into the failing row with the full Safeguard error body, and a matching Check in all (N) button releases every cached credential back to the appliance in one POST.",
      },
      {
        title: "Per-user browser sign-in and A2A",
        description:
          "Per-user-browser auth has each user run Connect-Safeguard -Browser -IdentityProvider <alias> from the Safeguard PowerShell module and paste the resulting API token into the new sign-in card — every subsequent checkout is then attributed to the user's own identity in the Safeguard audit log. A2A authenticates Strata as a single application identity via client certificate + key + API key, ideal for shared-automation accounts where individual attribution isn't required. The default hybrid mode prefers the per-user token when available and falls back to A2A when it isn't.",
      },
      {
        title: "Optional Vault-sealed password cache",
        description:
          "When an administrator enables Cache released passwords, every successful JIT checkout is sealed via the same Vault envelope encryption Strata already uses for SMTP / AD bind / local-credential passwords and stored per (user_id, profile_id) for the lifetime configured by each profile's TTL slider. Subsequent tunnel opens for the same profile reuse the cached row without making any Safeguard API call — so a long-running shift no longer means a 15-minute sign-in carousel for the operator. Caching is opt-in and disabled by default.",
      },
      {
        title: "Hardened against every Safeguard 8.x REST quirk we found",
        description:
          "The integration absorbs Safeguard 8.2.x behaviours that aren't obvious from the documentation: Me/ActionableRequests returns rows under singular bucket keys (Requester/Approver/Reviewer/Admin) instead of pre-8.x plural keys, Cancel/CheckIn reject Content-Length: 0 and bare {} and need the JSON-encoded string body \"strata preflight\", and the Code 90010 'pending password reset' rotation race that fires immediately after a Cancel is now absorbed by a backoff loop on CheckoutPassword that retries the marker for up to ten seconds before surfacing any other error.",
      },
    ],
  },
  {
    version: "1.9.6",
    subtitle:
      "Multiplayer / Co-Pilot Mode for shared sessions — up to six participants with arbitrated input control, live cursors, and in-room chat",
    sections: [
      {
        title: "Multiplayer / Co-Pilot Mode for control-mode shares",
        description:
          "The Share popover gains a Multiplayer (co-pilot) toggle for control-mode shares with sub-controls for Max participants (2..=6), Allow chat (default on), and Allow audio (default off, wired through the schema for a follow-up release). The viewer page opens a sibling /api/shared/copilot/{share_token} WebSocket first, receives a Welcome envelope carrying its server-assigned pid, then opens the regular Guacamole tunnel with ?pid=<uuid> so the server can gate input forwarding on the in-memory input token.",
      },
      {
        title: "Server-arbitrated input token with idle-grant",
        description:
          "A single-holder input token decides whose keyboard and mouse actually drive the session. The owner starts holding it; peers can request it with Take control, and if the current holder has been idle for two seconds the request is granted automatically — so no participant can monopolise the session indefinitely. The owner can force-revoke at any time. Every transition is broadcast as a roster update and rendered in the new roster strip with a CTRL badge next to whoever currently holds the token.",
      },
      {
        title: "Live cursors and in-room chat",
        description:
          "Remote cursors are rendered live with name labels coloured from a deterministic 8-entry palette, throttled to ~30 Hz on the wire and decayed after 8 seconds of inactivity so a peer that drops without a clean leave doesn't leave a frozen pointer on screen. A collapsible chat panel (default on; capped at 500 characters per message and 200 messages in memory) keeps the cohort in sync without forcing them into a separate tool.",
      },
      {
        title: "Kill switch and audit trail",
        description:
          "Operators can disable the entire feature without rolling back the binary by setting multiplayer_share_enabled = false in system_settings — the share-creation route silently downgrades multiplayer flags to a standard single-viewer share when this is set. A new share_participant_audit table records pid, display name, owner flag, join / leave timestamps, client IP and user agent for every participant, and matching share.multiplayer.joined / share.multiplayer.left events flow into the existing audit_log table.",
      },
    ],
  },
  {
    version: "1.9.5",
    subtitle:
      "Server-side recordings search & pagination, per-user last-login tracking, configurable stale-account auto-cleanup, Client IP visibility on the Sessions blade, and DMZ peer version visibility on the Health blade",
    sections: [
      {
        title: "Server-side recordings search and pagination",
        description:
          "The Recordings tab on the Sessions page no longer caps at the most recent 200 rows. `GET /api/admin/recordings` and `GET /api/user/recordings` now accept an optional `search` query parameter (matched server-side against `connection_name` and `username` via `ILIKE`), and the page itself paginates with `PAGE_SIZE = 50`, a 300 ms debounced search input, and a Next / Previous footer driven by a `limit + 1` `hasMore` probe. A dedicated empty state distinguishes 'no recordings yet' from 'no results matching <query>' with a one-click Clear search filter button.",
      },
      {
        title: "Per-user Last Login on the Users blade",
        description:
          "Every successful local or SSO authentication now stamps `users.last_login_at` (migration 064) immediately before audit logging — best-effort, so a DB hiccup never blocks token issuance. The admin Users table renders a new Last Login column formatted via the operator's configured timezone / date / time format, with an italic Never placeholder for accounts that have not yet authenticated.",
      },
      {
        title: "Configurable stale-account auto-deletion",
        description:
          "A new Stale account auto-deletion (days) setting in Admin Settings → Security → Data Retention drives the existing daily user_cleanup worker. When the value is a positive integer (1–3650), users whose `last_login_at` is older than the threshold are soft-deleted and audited as `user.stale_auto_deleted`. Users with `last_login_at IS NULL` (never signed in) are deliberately excluded so freshly-provisioned AD-sync imports are not aged out solely on creation time, and a value of 0 (the upgrade default) disables the sweep entirely. Soft-deleted accounts continue to flow through the existing user_hard_delete_days retention window and remain restorable from Show Deleted Users.",
      },
      {
        title: "Client IP visibility on the Sessions blade",
        description:
          "The admin Live and Recordings tabs now render a new Client IP column showing the operator's public source address — resolved at handshake from the rightmost non-empty X-Forwarded-For entry, with a ConnectInfo peer-IP fallback. Live sessions reuse the existing in-memory session_registry value; recordings are backed by a new nullable `recordings.client_ip` column (migration 065) populated at the same call site that captures session_id and started_at. Recordings created before the migration render as an italic Unknown.",
      },
      {
        title: "DMZ peer version visibility on the Health blade",
        description:
          "In DMZ deployments, the Health tab now renders a new DMZ Version tile alongside the existing Strata Version tile, capturing the `strata-dmz` binary version over the existing mTLS link. The strata-link/1.0 handshake is extended so the DMZ echoes its own software_version back to the internal node in AuthOutcome::Accept; the new field is Option<String> with serde(default), so pre-1.9.5 DMZ binaries that don't emit it deserialise to None and the UI renders an explicit Unknown rather than refusing to handshake. Multi-DMZ deployments running heterogenous builds show a Mixed indicator with the full list of distinct versions; single-version deployments add a yellow Skew vs frontend warning when the DMZ version differs from __APP_VERSION__. The DMZ Links tab also gains a per-endpoint DMZ version column. No new ports — the whole exchange stays inside the existing mTLS + PSK link.",
      },
    ],
  },
  {
    version: "1.9.4",
    subtitle: "NVR live observer fix — drawing state now persists beyond the 5-minute ring buffer",
    sections: [
      {
        title: "Live observer no longer goes black after 5 minutes",
        description:
          "When admins clicked LIVE on a session that had been idle for more than five minutes, the viewer rendered a black canvas because the original wallpaper and layer-setup drawing instructions had aged out of the per-session ring buffer. Each session now keeps a separate persistent-state log of non-ephemeral drawing instructions which is replayed before live frames whenever a new observer attaches, so LIVE and share-link viewers see the correct desktop state for sessions of any age.",
      },
      {
        title: "Strict role-gating of Emergency Approval Bypass",
        description:
          "The Break-Glass option on the credential checkout form is now shown only when an Approval Role explicitly covers the managed account AND every covering role has emergency bypass enabled. Turning off bypass on an Approval Role — or leaving the role's account scope empty — now reliably hides the option for affected accounts.",
      },
      {
        title: "Credential redaction preserved across the new log",
        description:
          "The persistent-state log inherits its data from the same ingestion path as the ring buffer, so `7.connect` and `4.args` opcodes (which can carry credentials) are stripped before they can ever be salvaged. Ephemeral opcodes (`4.sync`, `3.nop`, `3.key`, `5.mouse`) are also excluded to avoid replaying stale input or bloating the log.",
      },
    ],
  },
  {
    version: "1.9.3",
    subtitle:
      "Option to disable Break Glass emergency bypass, dynamic empty connection folders pruning, and package cleanup",
    sections: [
      {
        title: "Break Glass Emergency Bypass Control",
        description:
          "Introduced a new configuration option within Approval Roles to completely toggle on or off the Break Glass emergency approval bypass. When disabled, users are strictly required to go through the standard request and approval workflow for checkout, ensuring tighter operational controls for highly sensitive accounts.",
      },
      {
        title: "Empty Folder Visibility Pruned",
        description:
          "Refined the Dashboard navigation tree to dynamically prune empty folders. Folders containing no assigned connections or active subfolders are now automatically hidden from the sidebar, completely removing empty noise and decluttering the operator viewport.",
      },
      {
        title: "Repository Clean Up and Formatting",
        description:
          "Removed all residual version reference strings from package manifests and unified Rust and frontend style formatting. Cleaned up CI formatting violations to ensure pristine build stability.",
      },
    ],
  },
  {
    version: "1.9.2",
    subtitle:
      "Premium RDP interaction improvements, seamless collapsible sidebar dragging, and theme visual contrast",
    sections: [
      {
        title: "Active Session Dragging Lag Fixed",
        description:
          "Redesigned the interactive collapsible session panel's vertical dragging toggle handle to be buttery smooth and instantaneous. By isolating specific CSS transitions to color, background, and border-color, we eliminated a layout interpolation delay during drag gestures.",
      },
      {
        title: "Session Control Visibility & Dark Mode Contrast",
        description:
          "Restored high-contrast premium glassmorphic borders and translucent backdrop-blur panels for the session toggle controls under Dark Theme. Added sleek interactive hover states for both light and dark systems to ensure chevrons are fully visible on dark session backgrounds.",
      },
      {
        title: "RDP Click Deadzone Resolved",
        description:
          "Solved a subtle layout bug where RDP/VNC sessions had an unresponsive top-left click region when the connection sidebar was collapsed. Dynamically toggling container pointer events ensures active sessions are 100% interactive across the entire screen real estate.",
      },
    ],
  },
  {
    version: "1.9.1",
    subtitle: "SSO Connection Editor fixes, Cache-Busting, and CodeQL variable cleanup",
    sections: [
      {
        title: "SSO Provider Edit Fixes",
        description:
          "Editing an existing SSO provider configuration (e.g., Entra ID, Okta) now correctly preserves existing client secrets when saving. The test connection utility also now accurately uses existing secrets to validate edited configurations, ensuring robust testing prior to saving.",
      },
      {
        title: "SPA Cache Invalidation (Cache-Busting)",
        description:
          "Configured Nginx's SPA routing to serve the main index.html entry point with strict cache-invalidation headers. This guarantees that browsers always pull the newest UI deployment files on reload, preventing clients from running legacy cached layouts.",
      },
      {
        title: "Code Quality and Technical Debt",
        description:
          "Resolved multiple CodeQL detections related to unused variables across the backend application components, ensuring cleaner execution flows and more maintainable code.",
      },
    ],
  },
  {
    version: "1.9.0",
    subtitle:
      "Multiple SSO / OIDC connections, dynamic login branding, Vault transit secrets, and BASE_URL port integrity",
    sections: [
      {
        title: "Multiple SSO / OIDC Connections Support",
        description:
          "Organizations can now configure, manage, and run multiple OpenID Connect (OIDC) / Single Sign-On (SSO) connections simultaneously. Operators can configure separate identity providers such as Microsoft Entra ID, Okta, and Keycloak side-by-side using the newly expanded admin SSO tab.",
      },
      {
        title: "Dynamic Login Screen Branding",
        description:
          "The login screen dynamically detects all active, configured OIDC providers and renders a branded sign-in button for each one. Admins can customize the labeling of each login button to guide users to the correct corporate identity provider.",
      },
      {
        title: "Multi-Tenant State Resolution (SSO_STATE_STORE)",
        description:
          "Rather than registering separate callback URLs for every OIDC provider, all configurations share a single callback endpoint (`/api/auth/sso/callback`). The backend securely routes incoming OAuth2 callbacks by matching state tokens against an in-memory, thread-safe, time-bounded store mapping to the originating provider ID.",
      },
      {
        title: "Individual Vault-Sealed Client Secrets",
        description:
          "Maintains Strata's strict security posture by dynamically sealing and unsealing each provider's client secret using separate HashiCorp Vault transit keys. Client secrets are never stored in plaintext in the database.",
      },
      {
        title: "Port Integrity via BASE_URL Configuration",
        description:
          "Added the `BASE_URL` configuration override to both `.env` and `.env.example`. This prevents downstream proxies or SSL terminators from stripping non-standard ports (e.g. `:8443`) from redirect URIs, resolving callback mismatches.",
      },
      {
        title: "Robust Database Migration and Error UX",
        description:
          "Migration `062_sso_providers.sql` seamlessly handles transitioning single-SSO environments to the new multi-provider schema. If HashiCorp Vault is unconfigured when saving an SSO provider, the backend now returns a clear HTTP 400 Bad Request instruction rather than a generic 500 error.",
      },
    ],
  },
  {
    version: "1.8.4",
    subtitle: "Vitest test suite stabilization and environment hardening",
    sections: [
      {
        title: "Robust and Stable Testing Environment",
        description:
          "v1.8.4 stabilizes the Vitest test suite by implementing a global fetch polyfill that correctly handles relative API paths and synchronizing authentication mocks across the entire frontend codebase. This ensures reliable feedback for developers and resolves regressions related to Node-based test environment limitations.",
      },
      {
        title: "Improved Mock Synchronization",
        description:
          "All component tests are now synchronized with the modern cookie-based authentication utilities, preventing unhandled promise rejections and component crashes during initialization in the testing environment.",
      },
      {
        title: "Drop-in upgrade \u2014 rebuild required",
        description:
          "No database migrations, no API contract changes. v1.8.4 is focused on development environment reliability and testing stability. Roll both backend and frontend containers together to ensure full synchronization across the workspace.",
      },
    ],
  },
  {
    version: "1.8.3",
    subtitle: "NJS-based security hardening, CSP frame-ancestors, and persistent sessions",
    sections: [
      {
        title: "Modern Anti-Clickjacking Protection",
        description:
          "Transitioned to `Content-Security-Policy: frame-ancestors 'none'` across all responses, replacing legacy `X-Frame-Options` with modern standards for superior anti-clickjacking protection.",
      },
      {
        title: "Technology Masking (NJS)",
        description:
          "Implemented a robust NJS-powered filter that masks the `Server` header as 'Strata' and removes `X-Powered-By` globally, preventing technology fingerprinting and satisfying security audits.",
      },
      {
        title: "Persistent Sessions Across Restarts",
        description:
          "Added a mandatory `JWT_SECRET` environment variable to ensure user sessions remain valid across backend restarts. This results in a much smoother experience for operators, especially in environments with frequent deployment cycles.",
      },
      {
        title: "Clean Browser Console",
        description:
          "Optimized the frontend startup sequence to eliminate noisy 401 errors during the login phase by gating preference and settings providers behind the authentication boundary.",
      },
      {
        title: "Drop-in upgrade \u2014 JWT_SECRET mandatory",
        description:
          "No database migrations. You MUST set a secure `JWT_SECRET` in your `.env` file to prevent session invalidation on restart. Roll both backend and frontend containers together for the cleanest upgrade.",
      },
    ],
  },
  {
    version: "1.8.2",
    subtitle: "Global security headers, session-timeout reliability, and CI hardening",
    sections: [
      {
        title: "Sensitive data is never cached",
        description:
          "Implemented a global security header policy (`Cache-Control: no-store`) on every API response to ensure authenticated data is never persisted to disk by browsers or proxies, hardening the application against local data leakage.",
      },
      {
        title: "Session-lifecycle stabilization",
        description:
          "Hardened the session-timeout warning system to prevent race conditions and ensure consistent state synchronization between the frontend and backend, ensuring users are never logged out mid-session.",
      },
      {
        title: "Drop-in upgrade \u2014 frontend rebuild only",
        description:
          "No database migrations, no environment-variable changes. v1.8.2 is a security and stability patch. Backend and frontend images should be rolled together but each remains backwards-compatible with v1.8.1 peers.",
      },
    ],
  },
  {
    version: "1.8.1",
    subtitle: "Credential-profile expiry watcher no longer toasts on profile creation",
    sections: [
      {
        title: "What was wrong",
        description:
          'The default standard credential-profile TTL is 12 hours, so every freshly-saved profile started life with `secsLeft = 43 200` \u2014 already inside the watcher\'s 24-hour ("1 day") warning window. As soon as the next 60-second poll fired, the watcher published a toast labelled `<profile> expires in 1 day`, which is technically true but carries no information: the user had just chosen a 12-hour TTL on purpose. The same shape of bug existed for any extended-expiry profile created with a TTL shorter than 7 days.',
      },
      {
        title: "What changed",
        description:
          "The watcher now filters its threshold list against each profile's own `ttl_hours * 3600` window before evaluating, dropping any threshold that is wider than (or equal to) the profile's whole lifetime. A 12-hour standard profile now sees only the `1 hour` and `10 minutes` warnings; a 25-hour profile sees `1 day`, `1 hour`, and `10 minutes` (the 1-day toast still fires when ~1 hour of the window has elapsed, as intended); a 7-day extended profile sees `1 day` and `1 hour`; a 90-day extended profile is unchanged. A regression test was added to the watcher suite to lock the behaviour in.",
      },
      {
        title: "Drop-in upgrade \u2014 frontend rebuild only",
        description:
          "No database migration, no API contract change, no environment-variable change, no new runtime dependencies. The backend image is byte-identical between v1.8.0 and v1.8.1. Tracker entries written by the v1.8.0 watcher are harmless under the new code path and clear themselves the next time the profile is renewed or deleted \u2014 no manual `localStorage` cleanup required.",
      },
    ],
  },
  {
    version: "1.8.0",
    subtitle:
      "Reusable toast notifications, credential-profile expiry warnings, SSH password-paste fix",
    sections: [
      {
        title: "You will know before a credential profile expires",
        description:
          "A new background watcher polls your credential profiles once a minute and surfaces a toast as each pre-expiry threshold is crossed — at **1 day**, **1 hour**, and **10 minutes** before a standard profile lapses, or at **7 days**, **1 day**, and **1 hour** for the longer-lived extended-expiry profiles introduced in v1.7.0. Only the tightest threshold you have currently crossed fires (a tab opened at the 30-minute mark sees only the 10-minute warning, never the 1-day one too), and once a profile actually expires, a sticky red toast labelled **`<profile> has expired`** appears with a **Renew now** action that deep-links straight to the credentials page. Sticky because if the profile is needed for an active connection, you genuinely cannot reconnect with it until it has been renewed — a 6-second flash would be too easy to miss.",
      },
      {
        title: "Cross-tab, sleep-aware, and self-cleaning",
        description:
          "Already-fired thresholds are persisted in `localStorage` under a namespaced key, so closing the tab and reopening it does not re-fire the same warning, and two tabs open side-by-side do not double-up. When a profile's TTL is re-issued (the password is rotated, `extended_expiry` is toggled, or the slider is bumped) every threshold for the new window re-arms automatically. Profiles deleted on the server are pruned from the tracker on the next poll. The watcher also re-evaluates on `focus` and `visibilitychange`, so a laptop that wakes from sleep after eight hours sees the expired toast within a second of clicking back into the tab rather than waiting for the next 60-second poll. Operators on a non-vault deployment pay no cost — the watcher only mounts when `vault_configured` is true on the signed-in user.",
      },
      {
        title: "A reusable toast notification system, themed to fit",
        description:
          'The toast surface that powers the watcher above is a generic provider — every component beneath the auth gate can call `useToast().info / .success / .warning / .error` to publish a notification. Each toast carries a title, an optional secondary description, an optional **action button** (with built-in busy-state handling so the button shows `Working…` while a long-running click handler resolves), and a `key` so a long-lived consumer can update the same toast in place rather than spawning duplicates. Variants pick their accent and dim background from the existing CSS custom properties, so any future palette tweak flows through without a code change. Auto-dismiss timing matches the variant: 6 s for info / success, 8 s for warning, and **error toasts are sticky** until dismissed. The viewport mounts via a `document.body` portal in the top-right (the bottom-right is reserved for the existing session-timeout warning) and respects screen readers via `aria-live="polite"` plus per-variant `role="alert"` / `role="status"`.',
      },
      {
        title: "Pasting a password into an SSH session works again",
        description:
          "Pasting a password into an SSH or telnet password prompt — `sudo`, `ssh` password auth, `passwd`, `mysql -p`, every Cisco / Juniper / Mikrotik device CLI — was failing with an `incorrect password` response even when the password was correct. The cause: the paste helper was wrapping every SSH / telnet clipboard payload in bracketed-paste markers (`ESC [ 200 ~ … ESC [ 201 ~`) so paste-aware shells like bash, zsh and vim could keep auto-indent off for the duration of a multi-line paste. But a password prompt is not running under bash — it reads stdin in raw no-echo mode and treats the literal escape bytes as part of the password. Single-line SSH / telnet pastes are now byte-transparent; multi-line pastes still get the bracketed-paste wrapping and the `\\n → \\r` translation that paste-aware shells rely on, so pasting a config block into `nano` or `vim` continues to work as intended.",
      },
      {
        title: "Drop-in upgrade — frontend rebuild only",
        description:
          "No database migrations, no new environment variables, no API contract changes, no new runtime dependencies. The backend image is byte-identical between v1.7.0 and v1.8.0 — only the frontend container needs to be rebuilt: `docker compose --env-file .env -f docker-compose.yml -f docker-compose.internal.yml up -d --build frontend`.",
      },
    ],
  },
  {
    version: "1.7.0",
    subtitle:
      "Extended-expiry credential profiles for service / break-glass accounts, themed range slider, dependency refresh",
    sections: [
      {
        title: "Opt a single credential profile in to a longer expiry window",
        description:
          "The standard credential profile keeps its existing 1–12 hour TTL ceiling and existing default — operators who need to keep a credential alive for a service or break-glass account can now tick a per-profile **Extended expiry** checkbox that lifts the cap to 90 days (2160 hours). The opt-in is per-profile, not per-deployment, so the standard short-lived TTL remains the policy default; an extended profile is a deliberate exception that has to be opted in to one row at a time. Existing profiles are unaffected; the new column defaults to `FALSE`.",
      },
      {
        title: "Server-side guarantees on the cap",
        description:
          "The 12-hour vs. 90-day choice is not an honour-system frontend toggle. A two-arm `CHECK` constraint on `credential_profiles.ttl_hours` enforces `1 ≤ ttl ≤ 12` when `extended_expiry = FALSE` and `1 ≤ ttl ≤ 2160` when `extended_expiry = TRUE`, so the relaxed bound is unreachable for a row that has not been opted in regardless of any code path that bypasses the API resolver. The backend resolver `resolve_profile_ttl(user_pref, admin_max, extended_expiry)` selects the correct cap and clamps the request, and re-encrypted profile updates compute the cap against the **incoming** `extended_expiry` value (not the persisted one), eliminating any race window where a request could persist a TTL above the cap implied by its own flag.",
      },
      {
        title: "A themed range slider replaces the native browser control",
        description:
          'Every TTL input across the credential-profile editor and the request-checkout form now renders the same accent-tinted custom slider — built once in `frontend/src/components/RangeSlider.tsx` — instead of the native `<input type="range">` whose appearance differs across Chromium, Firefox, and Safari and clashes with the rest of the dark-theme surface. Track, fill, thumb, and focus ring all derive from the same CSS custom properties as the buttons and form fields beside them, so a future palette tweak flows through without a code change.',
      },
      {
        title: "Drop-in upgrade with one schema migration",
        description:
          "Migration `061_credential_profile_extended_expiry.sql` adds the `extended_expiry BOOLEAN NOT NULL DEFAULT FALSE` column and the two-arm `CHECK` constraint above. No environment-variable changes, no new runtime dependencies, no API contract changes (the new field is additive on every credential-profile request and response). Roll backend and frontend together for the cleanest upgrade; running an older frontend against the new backend is supported but the **Extended expiry** checkbox will not be visible until the frontend image is rolled.",
      },
    ],
  },
  {
    version: "1.6.2",
    subtitle:
      "Connection folder hierarchy everywhere, tag-picker viewport overflow, SSH credential prompt",
    sections: [
      {
        title: "Connections now appear under their nested folders on the Dashboard",
        description:
          "Creating a folder hierarchy of e.g. `Root → Switches → Coventry` and adding a connection inside `Coventry` previously listed the connection only under `Coventry` itself, with the parent levels showing as empty. The Dashboard is now a real recursive tree: every parent folder shows a descendant-inclusive count badge so you can see how many connections live below it without expanding it, the chevron and folder icon flip open/closed, every connection row is indented (`8 + depth * 16` px) to match its real folder depth, and a new toolbar pair — **Expand all** / **Collapse all** — drives the whole tree at once. When you type in the search box, every folder containing a hit is auto-expanded so a match never hides behind a collapsed parent.",
      },
      {
        title: "Every admin folder picker now renders the same hierarchy in the same order",
        description:
          "The connection-edit Folder dropdown, the role-folder assignment checklist, the folder management table, and the AD-sync default-folder picker previously listed folders alphabetically with no nesting visible, so a child folder named `Coventry` would land between `Cardiff` and `Dover` rather than under its parent `Switches`. They now share a single helper (`orderFoldersByHierarchy` in `frontend/src/utils/folderTree.ts`) that produces a depth-first preorder traversal with alphabetic sibling ordering, and indent children with non-breaking-space padding (in HTML `<select>`) or `paddingLeft: depth * 16px` (everywhere else). It is now visually obvious which folder a new connection or role assignment will land under.",
      },
      {
        title: "Tag picker no longer disappears off the bottom of the viewport",
        description:
          "Opening the per-row tag picker on a connection low on the page used to push half the menu below the visible area with no scroll. The Dashboard now measures the available space above and below the pill button on open, drops the menu in whichever direction has more room, and clamps the menu height with `overflow-y: auto` so the picker is always fully reachable regardless of where the anchor row sits.",
      },
      {
        title: "Tag pill column lines up with the indented connection name",
        description:
          "The tag pill container on each connection row used to align flush-left even when the row's name was indented under a nested folder, producing a visible left-edge step that made the pill look like it belonged to a different connection. The pill container now mirrors the row's depth-derived `paddingLeft`, so name, description, and pill all share the same left margin.",
      },
      {
        title: "SSH now prompts for both username and password when none are preselected",
        description:
          "Opening an SSH connection without a preselected credential profile used to drop straight into the terminal with the SSH server prompting for a password in-band — and no way to specify which remote account to authenticate as. Root cause: the backend's credential cascade matched the ticket arm purely on `Some(&ticket)` regardless of whether the ticket actually carried a password, and quietly injected the Strata user's local username as the SSH username in the guacd handshake. Empty tickets are now treated as no-creds, the cascade falls through to `(None, None)`, and guacd's `required` instruction triggers the in-app credential modal with both Username and Password fields before the terminal opens.",
      },
      {
        title: "Drop-in upgrade — no migrations, no API contract changes",
        description:
          "No database migrations, no new environment variables, no new runtime dependencies, no bundle-size growth. One purely additive endpoint (`GET /api/user/connection-folders`) so non-admin users can render the same folder hierarchy admins authored. Backend and frontend images should be rolled together but each remains backwards-compatible with v1.6.1 peers during a rolling update.",
      },
    ],
  },
  {
    version: "1.6.1",
    subtitle: "Production hardening — paste fidelity, never logged out mid-session, faster SSO",
    sections: [
      {
        title: "Multi-line paste into SSH/Telnet now matches a real terminal",
        description:
          "Pastes into SSH and Telnet sessions are now wrapped with bracketed-paste markers (`ESC [ 200 ~` / `ESC [ 201 ~`) and `\\r\\n` is rewritten to a single `\\r`, so editors like `vim`, `nano`, `psql` and the `python` REPL see the payload as a single paste rather than as a sequence of separate keystrokes that each commit a half-formed command. Only `ssh` and `telnet` are affected — RDP, VNC, Kubernetes-exec and Quick-Share clipboard payloads are passed through verbatim.",
      },
      {
        title: "You will no longer be logged out while actively using a session",
        description:
          "The Guacamole vendor library hijacks document- and canvas-level mouse and keyboard events with `preventDefault()` + `stopPropagation()`, which used to prevent the proactive token-refresh logic from seeing your activity inside a remote session — so the access token quietly expired at the 20-minute mark even while you were typing. A new `sessionActivity` event bus now bridges Guacamole input back to the timeout warning across every window context (main, popout, multi-monitor, fullscreen). As long as you are interacting with a session, you cannot be signed out; the only hard cap on session length is the 8-hour refresh-token ceiling.",
      },
      {
        title: "SSO sign-in is faster on a cold cache",
        description:
          "The SSO callback used to perform four upstream HTTP round-trips to the IdP on a cold cache (discovery, token, discovery again, JWKS) because the discovery cache lived in the wrong module and JWKS was uncached. Both are now cached for 10 minutes inside `services::auth`, so the callback issues at most one upstream call on a warm cache and two on the first sign-in after process start. The `/api/auth/sso/login` redirect also gains `Cache-Control: no-store` to prevent BFCache replay of single-use `state` UUIDs from the browser's back/forward buttons.",
      },
      {
        title: "Diagnostic tracing for future SSO latency reports",
        description:
          'A new info-level tracing line on the `strata::auth::sso` target emits a per-step latency breakdown (`discovery_ms`, `token_exchange_ms`, `token_validate_ms`, `total_so_far_ms`) on every successful SSO callback. The next "SSO is slow" report can be triaged from the backend logs alone — if the numbers add up to the user-perceived wait the time was spent inside Strata; if they are tiny but the user still waited minutes, the time was spent inside Keycloak or a federated upstream IdP and the trail continues there.',
      },
      {
        title: "Drop-in upgrade — no migrations, no API contract changes",
        description:
          "No database migrations, no new environment variables, no new dependencies, no bundle-size growth. Backend and frontend images should be rolled together but each remains backwards-compatible with v1.6.0 peers during a rolling update.",
      },
    ],
  },
  {
    version: "1.6.0",
    subtitle:
      "Enterprise foundations — stable error codes, accessibility, i18n scaffold, and Kubernetes / API-lifecycle ops docs",
    sections: [
      {
        title: "Stable error codes on every API response",
        description:
          "Every backend error now carries a stable `code` field alongside the human-readable `error` message — `INTERNAL`, `DEPENDENCY_UNAVAILABLE`, `UNAUTHENTICATED`, `FORBIDDEN`, `INVALID_REQUEST`, `NOT_FOUND`, `SETUP_REQUIRED`. Frontend and external integrators can branch on the code instead of regex-matching the prose, and the mapping is now part of the documented API contract (see new `docs/API-LIFECYCLE.md`). The existing `error` field is unchanged for backwards compatibility.",
      },
      {
        title: "Skip-to-content link and focus-trapped confirm dialogs",
        description:
          "A skip link at the top of every page lets keyboard and screen-reader users jump past the persistent navigation rail directly to `<main>` (WCAG 2.4.1). Destructive-action confirmation dialogs (`ConfirmModal`) now trap focus inside the dialog while open and restore the previously-focused element on close (WCAG 2.4.3 / 2.1.2), via a new generic `useFocusTrap` hook reusable from any future modal.",
      },
      {
        title: "Internationalisation scaffold (English baseline)",
        description:
          "`i18next` + `react-i18next` are now wired in with an English baseline locale (`common` and `login` namespaces), language detection from `localStorage` → browser → English fallback, and a `setLanguage()` helper ready for a future user-settings toggle. The Login page is the migrated exemplar so subsequent PRs can adopt the pattern incrementally instead of needing a single big-bang refactor.",
      },
      {
        title: "API-lifecycle and Kubernetes deployment docs",
        description:
          "Two new operator-facing documents: `docs/API-LIFECYCLE.md` formalises the `/api/v1` versioning policy, support window, breaking-change definition, and `Deprecation`/`Sunset` headers per RFC 9745. `docs/deployment-kubernetes.md` covers production topology (backend stays at `replicas=1` because rate limits / settings cache / OIDC nonce cache / sessions are process-local), `ExternalSecrets` inventory, PVC sizing, ingress + `NetworkPolicy` YAML, split liveness/readiness probes, and a curated common-pitfalls section.",
      },
      {
        title: "Hardened a panic-free invariant in the user routes",
        description:
          "Replaced an `unwrap()` after a non-`None` guard in the checkout-activation handler with an explicit error path that returns the new stable `INTERNAL` error code. Logically unreachable in normal flow, but the explicit handling keeps the panic-free guarantee the rest of the route enforces under concurrent or adversarial inputs.",
      },
      {
        title: "Drop-in upgrade — no migrations, no API breakage",
        description:
          "No database migrations. The error response body gains a `code` field but the existing `error` field is unchanged, so v1.5.x clients keep working. Frontend bundle gains `i18next` + `react-i18next` (~30 KB gzipped). All four images (frontend, backend, DMZ edge, guacd) should be rolled together but each one is backwards-compatible with v1.5.5 peers during a rolling update.",
      },
    ],
  },
  {
    version: "1.5.5",
    subtitle:
      "Security review — second-pass hardening across auth, race conditions, DMZ link channel, and background sweepers",
    sections: [
      {
        title: "Auth — no more user enumeration via OIDC/SSO callbacks",
        description:
          "When the OIDC subject (or SAML/SSO email) does not match a provisioned user, the response is now the generic `Invalid or expired token` instead of including the offending claim, with the full claim only logged at debug. Closes a user-enumeration oracle reachable from any unauthenticated client that can reach the SSO callback URL. The `/auth/change-password` endpoint is also now rate-limited per user (5 attempts per hour) using the same mutex the login flow uses, so a stolen-cookie attacker can no longer brute-force the current password through the account-settings flow.",
      },
      {
        title: "Auth — refresh-rotated JWTs are recorded in active_sessions",
        description:
          "The refresh handler now calls `active_sessions::record(...)` after minting a new access token, so the admin “active sessions” view reflects the post-rotation `jti` and the per-user signout flow correctly revokes it. Previously a long-running session that rotated tokens disappeared from the dashboard but stayed valid until the original `jti` expired naturally.",
      },
      {
        title: "Auth — setup bootstrap-token check is constant-time on every path",
        description:
          "The previous short-circuit on empty input gave a measurable timing signal (`0` ns vs ~µs to compare). The new path always invokes `constant_time_eq` against a fixed-length expected value, so an attacker probing whether `STRATA_SETUP_TOKEN` is set sees identical timing for empty and non-empty input.",
      },
      {
        title:
          "LDAP filter validator — reject match-everything, control chars, oversize, deep nesting",
        description:
          "Replaced the legacy `validate_ldap_filter` with a stricter recursive-descent style validator. Caps total length at 2048 bytes and nesting depth at 32, rejects NUL and ASCII control characters, and explicitly refuses match-everything patterns (`(*)`, `(objectClass=*)`). Four new unit tests cover the new rejections; the original five tests still pass.",
      },
      {
        title: "Race fix — activate_checkout no longer holds a row lock across LDAP + Vault IO",
        description:
          "The v1.5.4 fix used `SELECT … FOR UPDATE` which serialised concurrent activators correctly but blocked every other approver on the same row for as long as the AD password modify took (seconds in the slow case). The new flow uses a session-scoped `pg_try_advisory_lock` keyed on the checkout UUID for mutual exclusion, performs the LDAP and Vault calls with **no DB lock held**, and only opens a fresh short-lived transaction for the final UPDATE and audit write.",
      },
      {
        title: "Share viewers — kicked when a share is revoked",
        description:
          "The viewer WebSocket now re-checks `find_active_by_token` every ~30 seconds inside the keepalive tick and closes the connection when the share row has been revoked, expired, or its underlying connection has been soft-deleted. Previously, revoke only prevented *new* viewers from joining — anyone already attached stayed attached for the rest of the owner's session.",
      },
      {
        title:
          "DMZ link channel — TLS resumption off, per-IP accept rate limit, h2 per-stream timeout",
        description:
          "TLS 1.3 session resumption is disabled on the link listener (`NoServerSessionStorage`, `send_tls13_tickets = 0`) — resumed handshakes do not re-present the client certificate, and for a private mTLS-only trust domain full handshake on every connect is the desired posture. The accept loop now sheds connections via the existing striped `PerIpRateLimiter` (default 5 rps, burst 30) **before** TLS handshake CPU spend. Regular HTTP/2 request handlers are wrapped in a 120 s timeout so a stalled handler cannot pin a stream slot indefinitely against `MAX_CONCURRENT_STREAMS`. WebSocket bridges are exempt; they own their own keepalive.",
      },
      {
        title: "DMZ — loopback handler hardening, edge-signer charset, WebSocket version pin",
        description:
          "The loopback upgrade handler now asserts its target is a loopback address at construction (crashes the process on misconfiguration rather than silently proxying to a public IP), and rejects HTTP/1.1 request paths and Host headers containing CR/LF/NUL before the request line is concatenated. The edge-signer `x-request-id` filter narrows from any printable ASCII to `[A-Za-z0-9_-]` only — the value is MACed by the edge and trusted verbatim by the backend, and the wider character set let a public client smuggle log-field separators (`=`, `,`, `;`, ` `) into the trusted audit context. WebSocket upgrade detection now requires `Sec-WebSocket-Version: 13`; older drafts used incompatible framing and accepting them publicly while the inner backend rejects them was a smuggling primitive.",
      },
      {
        title: "Sweepers — idempotency_keys is now part of the periodic cleanup",
        description:
          "The `idempotency_keys` table accumulates one row per write-with-`Idempotency-Key` for 24 hours. The live lookup already filtered expired rows, but without a sweep the table grew unboundedly. The new range delete piggybacks on the existing `active_sessions` cleanup tick (every 2 minutes) and uses the `idempotency_keys_expires_at_idx` index added in migration 053.",
      },
      {
        title: "Drop-in upgrade — no migrations, no API changes",
        description:
          "v1.5.5 has no database migrations, no /api/* contract changes, and no protocol changes. The DMZ link `LinkServerConfig` struct gains two new fields (`accept_rate_rps`, `accept_rate_burst`) but `crates/strata-dmz/src/main.rs` constructs them with sensible defaults; operators running the published binary need do nothing. All four images (frontend, backend, DMZ edge, guacd) should be rolled together but each one is backwards-compatible with v1.5.4 peers during a rolling update.",
      },
    ],
  },
  {
    version: "1.5.4",
    subtitle:
      "Security review — consolidated hardening pass across backend, DMZ link channel, and frontend",
    sections: [
      {
        title: "Backend — JWT secret length and password caps enforced",
        description:
          "v1.5.4 refuses to start if `JWT_SECRET` is shorter than 32 bytes (256 bits) and emits a remediation hint (`openssl rand -base64 32`), preventing accidental deployment with a placeholder or truncated secret. The login and registration password length cap drops from 1024 → 256 bytes — Argon2 hashes any input length in roughly constant time, so the previous cap was a free amplification vector for credential stuffing and DoS without buying any real-world passphrase headroom.",
      },
      {
        title: "Backend — optional one-shot bootstrap token on /api/setup/initialize",
        description:
          "When the new `STRATA_SETUP_TOKEN` env var is set, the first-boot `/api/setup/initialize` endpoint requires the matching `X-Strata-Setup-Token` header and compares it in constant time. Greenfield deploys without the env var keep the previous unauthenticated bootstrap flow, so existing first-boot scripts and orchestrated installs are unaffected. Operators who want defence-in-depth can now pin a one-shot token in the deployment manifest before exposing the backend to the network.",
      },
      {
        title: "Backend — audit, pagination, and error-handling fixes",
        description:
          "The `share` revoke path now writes an audit log entry matching the create/use side, closing the audit-trail gap on link revocation. Recordings list pagination uses a deterministic tiebreaker (`ORDER BY created_at DESC, id DESC`) so cursor pages no longer silently drop or duplicate rows when several recordings share a timestamp. The favorites list endpoint surfaces DB errors instead of swallowing them with `unwrap_or(empty)`, so broken queries log and return a proper 5xx instead of hiding the failure as “no favorites”. The active-session GC interval shortens from 5 min → 2 min so abandoned viewer rows expire from the dashboard sooner.",
      },
      {
        title: "DMZ link channel — TLS 1.3 pin, idle timeouts, streaming body cap",
        description:
          "TLS is pinned to 1.3 only on the operator ↔ edge link server — the control channel never needs TLS 1.2 fall-back, and restricting the protocol set removes an entire surface area of downgrade and cipher negotiation bugs. The WebSocket bridge enforces a 60 s I/O idle timeout on read/write/framing on both legs so a stalled inner TCP peer can no longer pin a goroutine + descriptor pair indefinitely. The HTTP body cap middleware now also wraps the streaming body with `http_body_util::Limited`, so chunked uploads that omit or lie about Content-Length are still bounded by the per-IP limit.",
      },
      {
        title: "DMZ link channel — proxy hygiene, deterministic PSK, IPv6 zone scrub",
        description:
          "The reverse proxy now strips the full RFC 7230 hop-by-hop header set before forwarding (Connection, Keep-Alive, Proxy-Authenticate, Proxy-Authorization, TE, Trailers, Transfer-Encoding, Upgrade) plus any header named in the inbound `Connection` value, matching what production-grade reverse proxies do. The active link PSK id is now deterministic (the first id parsed from `LINK_PSKS`) instead of `HashMap::keys().next()`, which the std-lib does not promise to keep stable across runs. The edge signer scrubs IPv6 zone identifiers (`fe80::1%eth0`) from X-Forwarded-For before signing, removing a header smuggling primitive.",
      },
      {
        title: "Frontend — Markdown sanitisation and ConfirmModal on destructive admin actions",
        description:
          "The Documentation viewer now sanitises rendered Markdown with DOMPurify before it lands in the DOM, treating `marked` output as untrusted and eliminating any chance of stored-XSS via doc content. The destructive admin actions in the Passwords tab (delete approval role, delete account mapping) use the existing `ConfirmModal` instead of the browser-native `window.confirm()`, matching the rest of the admin UX and avoiding click-jacking on the native dialog.",
      },
      {
        title: "Drop-in upgrade — confirm JWT_SECRET length, no migrations",
        description:
          "v1.5.4 has no database migrations, no /api/* contract changes, and no protocol changes. Before upgrading, confirm `JWT_SECRET` is at least 32 bytes; rotate via `openssl rand -base64 32` if you were running with the old default. Optionally set `STRATA_SETUP_TOKEN` before exposing the backend to the network for greenfield deploys. All four images (frontend, backend, DMZ edge, guacd) should be rolled together but each one is backwards-compatible with v1.5.3 peers during a rolling update.",
      },
    ],
  },
  {
    version: "1.5.3",
    subtitle:
      "Admin Settings — grouped sidebar navigation replaces the 17-tab horizontal row that no longer fit on a single line",
    sections: [
      {
        title: "From a 17-tab horizontal row to a five-section sidebar",
        description:
          "The Admin Settings page accumulated 17 tabs across the v1.4.x → v1.5.x line (Health, Display, Network, SSO / OIDC, Kerberos, Vault, Recordings, Access, Tags, AD Sync, Password Mgmt, Notifications, Sessions, VDI, Trusted CAs, DMZ Links, Security) and on common DPI / zoom settings the row no longer fit on a single line — operator laptops were forced to scroll horizontally to reach the right-hand tabs. v1.5.3 replaces that single row with a left sidebar grouped into five sections (Overview, Identity & Access, Connectivity, Workspace, Secrets & Security) modelled on the navigation patterns used by AWS Console, Azure Portal, and GitHub Settings.",
      },
      {
        title: "Permission-aware section collapse — non-admins see a smaller sidebar",
        description:
          "Sections become hidden from the nav entirely when the current user has no permission to see any item inside them, so a tag-only operator or an audit-only viewer sees a much smaller sidebar than a full system administrator. The per-item permission predicates (can_manage_system, can_manage_users, can_manage_connections, can_create_*, can_view_audit_logs, etc.) are unchanged from v1.5.2 — only the grouping and rendering moved. The default-tab heuristic (system admins land on Health, RBAC admins on Access, audit-only viewers on Sessions) is also unchanged.",
      },
      {
        title: "Responsive — wraps inline above content on tablets and phones",
        description:
          "On screens narrower than the Tailwind lg breakpoint (1024 px) the sidebar wraps inline above the content as a horizontal flex row of buttons, so mobile and tablet operators get the same content without a forced two-pane layout. On lg+ screens the sidebar is sticky to the top of the viewport so the section list stays in view while scrolling the long settings panels (Recordings, Notifications SMTP, the Access Control role editor are all longer than a typical viewport).",
      },
      {
        title: "Drop-in upgrade — frontend image only",
        description:
          "v1.5.3 is a UX-only patch release. There are no API changes, no database migrations, no protocol changes, no security changes, and no behavioural changes to any session, audit, or deployment code path. The backend, DMZ edge, and guacd images are bit-identical to v1.5.2 — operators only need to roll the frontend container. All 1329 frontend tests continue to pass, including the 220 AdminSettings unit tests, because the tab labels and the .tab-active CSS class were preserved verbatim.",
      },
    ],
  },
  {
    version: "1.5.2",
    subtitle:
      "DMZ link WebSocket forwarding — RFC 8441 Extended CONNECT brings end-to-end /api/tunnel through the public edge",
    sections: [
      {
        title: "Sessions launched through the DMZ now actually connect",
        description:
          "Until v1.5.2 the dual-node DMZ deployment forwarded REST traffic correctly (admin UI, OIDC, login) but silently dropped WebSocket upgrades — the public listener stripped the Upgrade header and the inner h2 multiplexer had no upgrade-aware code path, so any user who connected to the DMZ node and tried to launch a session saw the WebSocket fail mid-handshake. v1.5.2 closes the loop: the DMZ now negotiates an RFC 8441 Extended CONNECT stream on the link for every WebSocket upgrade, the internal node accepts it via a new UpgradeHandler trait, and a transparent byte-pump forwards frames in both directions for the lifetime of the session. WebSocket masking, ping/pong, fragmentation and close frames all flow through unmodified.",
      },
      {
        title: "RFC 8441 Extended CONNECT on the link, RFC 6455 on the public side",
        description:
          'On the link, the DMZ sends :method=CONNECT, :protocol=websocket, :path=<original> with the signed x-strata-edge-* bundle and every non-hop-by-hop header from the original request, then waits for :status=200 from the internal node before acknowledging the upgrade publicly. On the public side the DMZ returns 101 Switching Protocols with a correctly-computed Sec-WebSocket-Accept (RFC 6455 §1.3 — SHA-1 of the client Sec-WebSocket-Key concatenated with the magic GUID 258EAFA5-E914-47DA-95CA-C5AB0DC85B11, base64-encoded). Both ends use the h2 crate\'s enable_connect_protocol() / Protocol::from_static("websocket") plumbing so the wire is exactly what RFC-conformant peers expect.',
      },
      {
        title: "Loopback bridge keeps the existing tunnel.rs / RBAC / audit story intact",
        description:
          "On the internal side, the new LoopbackUpgradeHandler accepts the inbound Extended CONNECT stream and bridges it to a regular HTTP/1.1 WebSocket upgrade against 127.0.0.1:8080 (overridable via the new STRATA_DMZ_LOOPBACK_ADDR env var). The loopback target is the same axum router that serves direct connections — the existing verify_edge_headers middleware promotes the forwarded x-strata-edge-client-ip to the real client IP for audit / RBAC, the existing tunnel.rs ws_tunnel handler runs unchanged, and the guacd connection still originates from the internal node's IP, exactly as a single-node deployment behaves. No separate auth code path to keep in sync, no decrypted secrets ever touch the DMZ node.",
      },
      {
        title: "Streaming-aware resource caps",
        description:
          "WebSocket streams cannot be size-capped by the existing MAX_REQUEST_BODY_BYTES / MAX_PROXY_BODY_BYTES buffers because they are long-lived. Instead v1.5.2 caps individual h2 frame sizes at 8 MiB on the DMZ→public direction so a misbehaving internal node cannot make the DMZ buffer arbitrary memory before flushing to the public socket. h2 flow-control windows are honoured in both directions; back-pressure from a slow public client transparently slows the upstream guacd traffic via the link's RecvStream::release_capacity calls.",
      },
      {
        title: "Drop-in upgrade — both DMZ and internal images must roll together",
        description:
          "No database migration, no /api/* contract changes, no config.toml or environment-variable changes for existing operators. Optional new env var STRATA_DMZ_LOOPBACK_ADDR (default 127.0.0.1:8080) only matters if the internal node listens on a non-default address. Operators running a DMZ deployment must rebuild and redeploy both the strata-dmz and strata-backend images for WebSocket forwarding to work — both ends of the link need to negotiate the RFC 8441 settings extension. Single-node deployments (STRATA_DMZ_ENDPOINTS unset) are unaffected: the internal node continues serving public traffic directly with no link supervisor spawned.",
      },
      {
        title: "Test coverage holds",
        description:
          "DMZ side gains 7 unit tests covering is_websocket_upgrade detection (canonical, multi-token Connection, case-insensitive, rejection paths) and compute_accept against the RFC 6455 §1.3 worked example (dGhlIHNhbXBsZSBub25jZQ== → s3pPLMBiTxaQ9kYGzzhZRbK+xOo=). Internal side gains 10 unit tests covering Extended CONNECT detection, response-line parsing, CRLFCRLF scanning, header-forwarding allowlist, and oversized-line rejection. Existing h2_serve and supervisor tests were updated to thread a RejectUpgradeHandler through the new signature; all pre-existing test coverage continues to pass.",
      },
    ],
  },
  {
    version: "1.5.1",
    subtitle:
      "Pop-out window correctness fix release — F11 / F12, popup-local Ctrl+K Command Palette, clean teardown when the opener navigates away",
    sections: [
      {
        title: "F11 fullscreen and F12 now behave correctly inside pop-out windows",
        description:
          "Previously the pop-out's keydown trap was registered after the Guacamole.Keyboard capture-phase listener, so F11 was forwarded to the remote desktop as a keystroke instead of toggling the popup's local fullscreen, and F12 either opened DevTools or leaked a key release into the remote (where it would 'stick' until the next F12 press). Registration order is now fixed in frontend/src/components/usePopOut.ts: the trap installs before new Guacamole.Keyboard(popup.document), F11 toggles popup.document.fullscreenElement and is consumed before Guacamole sees it, F12 is preventDefault'd locally, and Ctrl+Shift+I / Ctrl+Shift+J are forwarded to the popup's own DevTools the same way.",
      },
      {
        title: "Ctrl+K now opens a popup-local Command Palette",
        description:
          "The main window's React-rooted Command Palette cannot render inside a pop-out window — different Window object, no React root, no router context. The new frontend/src/utils/popoutPalette.ts is a deliberately small vanilla-DOM palette rendered directly in the popup's document: dimmed backdrop, search input, filterable connection list styled to match the main palette. It fetches the user's connections lazily via the existing getMyConnections() and posts the chosen connection back to the opener as { type: 'strata:open-connection', id }. The opener's CommandPaletteProvider validates the id (typeof === 'string', length 1–255) and navigates to /session/${encodeURIComponent(id)}, reusing the existing routed-launch flow. Filter matches name / hostname / protocol (case-insensitive substring); arrow keys cycle with wrap-around; Enter activates; Escape closes; mousedown on a row activates; mousedown on the dimmed backdrop closes.",
      },
      {
        title: "No race with Guacamole's capture-phase keyboard listener",
        description:
          "The popup palette intentionally does NOT register its own document keydown listener — doing so would race against the Guacamole.Keyboard capture-phase listener that the popout already installs on popup.document. Instead the popup's existing trapKeyDown delegates to popoutPalette.handleKeyDown(e). While the palette is open the trap returns true from Guacamole.Keyboard.onkeydown (the contract is inverted: returning true means 'do not preventDefault') and onkeyup early-returns, so the <input> element receives typed characters normally and Guacamole never sees palette keys.",
      },
      {
        title: "Pop-out windows close cleanly when the opener navigates away",
        description:
          "A freeze in the opener — page reload, hard navigation, tab close — used to leave orphaned pop-out windows that could no longer talk to a parent JS realm. The opener now installs a pagehide handler that calls popup.close() for every tracked pop-out, mirroring what the per-session disconnect button already did.",
      },
      {
        title: "Coverage ratchet held in lock-step",
        description:
          "A new 19-test unit suite at frontend/src/__tests__/popoutPalette.test.ts drives the new vanilla-DOM palette to 95.07% statements, 88.57% branches, 100% functions, 98.47% lines. Global thresholds in frontend/vitest.config.ts are unchanged; the suite restores the global numbers that the new untested file would otherwise have dragged below the floor (statements 72.47, branches 64.38, functions 62.26, lines 74.38). All 1 329 frontend tests still pass; lint stays at zero warnings on the changed files.",
      },
      {
        title: "Drop-in upgrade from v1.5.0",
        description:
          "No database migrations, no /api/* contract changes, no config.toml or environment-variable changes. strata:open-connection is a same-origin postMessage event between the opener and its own pop-out window, not a public protocol. DMZ deployment mode is unaffected — pop-out windows are an in-browser concern and the link supervisor / edge-header HMAC paths are unchanged. Rebuild and roll: docker compose pull && docker compose up -d. Operators running the DMZ split should roll the internal node first and the DMZ edge second; the order is informational, not strictly required for v1.5.1.",
      },
    ],
  },
  {
    version: "1.5.0",
    subtitle:
      "DMZ deployment mode — split-topology release with a separate edge binary, HTTP/2-over-mTLS reverse tunnel, and zero-secret-overlap with the internal node",
    sections: [
      {
        title: "Public surface as a separate, minimal binary",
        description:
          "The new strata-dmz crate (crates/strata-dmz) is a deliberately small Axum binary that owns the public TLS listener (default 0.0.0.0:8443), a separate link-server listener for inbound mTLS from internal nodes (default 0.0.0.0:9443), the SPA static-serving path, the slow-loris / rate-limit / inflight-cap guards and the x-strata-edge-* HMAC header signer. It does NOT link in any Postgres, Vault, JWT-signing, OIDC-client-secret or recording-storage code. The zero-secret-overlap matrix in docs/architecture.md is CI-enforced: a Cargo deny rule rejects any DMZ-side dependency on the internal-only secret-handling crates. Single-node operators are not affected — when STRATA_DMZ_ENDPOINTS is unset the internal node continues serving public traffic directly with no link supervisor spawned.",
      },
      {
        title:
          "HTTP/2-over-mTLS reverse tunnel — every existing feature works through the DMZ on day one",
        description:
          "The internal node dials OUT to the DMZ over TLS 1.3 + mTLS using operator-supplied certs and a private CA bundle (the system trust store is NOT consulted on the link path). On top of TLS the wire format is HTTP/2: each user request becomes one HTTP/2 stream on the persistent link, WebSockets are carried as RFC 8441 Extended CONNECT streams (the same mechanism browsers use for WebSocket-over-HTTP/2), and per-stream WINDOW_UPDATE flow control gives back-pressure for free. No custom codec to fuzz; we lean on h2 and hyper. The internal node's existing axum::Router handles the request unmodified — every existing feature works through the DMZ on day one because the tunnel carries arbitrary HTTP requests rather than custom message types.",
      },
      {
        title: "PSK-bound handshake on top of mTLS plus rotation-aware edge-header HMAC",
        description:
          "Layered on top of the mTLS link is an application-level challenge–response: the DMZ sends a 32-byte random nonce, the internal node returns HMAC-SHA-256(psk_key, nonce ‖ cluster_id ‖ node_id) and an AuthHello frame. PSKs are configured per-id (STRATA_DMZ_LINK_PSK_<id>=<base64> on the internal node, STRATA_DMZ_LINK_PSKS=id:b64,id2:b64 on the DMZ — first active, rest accepted during rotation). A stolen mTLS cert alone is not enough to bring up a link. Once a request reaches the internal node from the DMZ it must carry a valid x-strata-edge-{ts,id,client-ip,sig} header set, signed by the DMZ with a key configured via STRATA_DMZ_EDGE_HMAC_KEYS. The internal-side verifier (backend/src/services/edge_header.rs) accepts any key in the comma-separated list (first active, rest accepted) so keys can be rotated without dropping live links. Constant-time compare, ±60s timestamp window, client IP from the header is what reaches RBAC and audit (the DMZ is an expensive NAT).",
      },
      {
        title: "Admin → DMZ Links tab",
        description:
          'A new Admin → DMZ Links page (frontend/src/pages/admin/DmzLinksTab.tsx) surfaces every supervisor\'s state (up / connecting / authenticating / initializing / backoff / stopped), connect counter, failure counter, last error and uptime. A Force reconnect button calls POST /api/admin/dmz-links/reconnect to drop and redial every link — used during scheduled DMZ restarts and as the first button in the incident-response runbook. The page auto-refreshes every 15 seconds. The configured-but-empty case ("no DMZ endpoints configured") and the disabled case ("DMZ mode is not enabled") render distinct empty-state cards so the operator can tell at a glance whether they\'re looking at a misconfiguration or a green-field single-node host.',
      },
      {
        title: "Operator-grade documentation, two new admin endpoints, drop-in upgrade",
        description:
          "Docs refreshed end-to-end: architecture.md gains a DMZ chapter with sequence diagrams and the zero-secret-overlap matrix; security.md gets a DMZ threat-model section (W6-1 through W6-5) covering compromised-DMZ blast radius, key-rotation runbook and abuse guards; deployment.md gets a full env-var reference for both binaries plus certificate generation and rotation procedures; api-reference.md documents the two new admin endpoints (GET /api/admin/dmz-links snapshot, POST /api/admin/dmz-links/reconnect kick). No database migrations, no breaking /api/* changes (additive only), no config.toml schema changes — DMZ is configured exclusively via environment variables so the same config file continues to work in both single-node and split deployments. Rebuild backend and frontend (docker compose build backend frontend && docker compose up -d) to roll v1.5.0 forward.",
      },
    ],
  },
  {
    version: "1.4.1",
    subtitle:
      "Tunnel watchdog regression fix, crypto crate refresh, and a 334-warning ESLint sweep",
    sections: [
      {
        title: "Active sessions no longer get reaped every 20 minutes",
        description:
          "v1.3.2 introduced a WebSocket-tunnel auth watchdog that captured the access token's exp claim once at upgrade time and force-closed the tunnel when that timestamp was reached. Access tokens carry a 20-minute TTL but the frontend's SessionTimeoutWarning rotates them via POST /api/auth/refresh on user activity — the already-open WebSocket has no way to learn about that rotation, so the watchdog held on to the original token's exp and tore down the session at T+20m even when the operator was actively using the UI. backend/src/routes/tunnel.rs ws_tunnel now drops the exp cache entirely; teardown comes from three sources only: token revocation (polled every 30s, audit reason='revoked'), TCP-level WebSocket close (browser-closed, network died), and a new 8-hour MAX_TUNNEL_DURATION wall-clock cap measured from upgrade time (audit reason='max_duration'). The audit reason enum gained 'max_duration' and dropped 'expired'; dashboards filtering on 'expired' should add 'max_duration' to the same defence-in-depth bucket.",
      },
      {
        title: "guacd build pin/patch story documented (no behaviour change)",
        description:
          "Between commits de0ba24 and 1064a8e on main the guacd image build was briefly broken while we attempted to drop our local 006-freerdp325-authenticate-ex.patch on the assumption that GUACAMOLE-2273 (upstream commit 7696572, the AuthenticateEx callback fix) had landed on staging/1.6.1. It hadn't — 7696572 still exists only as an unmerged PR — and pinning directly to that PR commit failed compilation against FreeRDP 3.25 with an undeclared AUTH_FIDO_PIN error from a post-3.25 rdp_auth_reason enum value. v1.4.1 keeps the working v1.4.0 combination (staging/1.6.1 HEAD 4163ead + patch 006 + the two grep guards in guacd/Dockerfile) and updates the Dockerfile comment block so the next maintainer doesn't re-walk the same path. Functionally a no-op vs. v1.4.0; only the pin/patch story changed.",
      },
      {
        title: "RustCrypto refresh on the Chromium autofill-import path",
        description:
          "backend/src/services/web_autofill.rs (Chromium-format Login Data decryption — PBKDF2 peanuts/saltysalt, AES-128-CBC, v10 prefix, used by the Chromium-export ingestion path under VDI / web sessions) gets aes 0.8→0.9, cbc 0.1→0.2, pbkdf2 0.12→0.13, and sha1 0.10→0.11. The decrypted secret is never written to disk by the backend; this path lives entirely behind the autofill-import feature toggle that is still gated by can_manage_system. Envelope encryption of stored credentials still goes through aes-gcm (unchanged) and Vault Transit (unchanged).",
      },
      {
        title: "Frontend ESLint debt cleared (334 → 0 warnings)",
        description:
          "Phases 1–7 of a frontend code-quality sweep eliminate every standing ESLint warning: explicit unknown-narrowing in error catches, removal of dead imports, JSX accessibility tightening, useCallback / useMemo dependency arrays normalised, optional-chaining where the type already permits undefined. No behavioural changes. The CI lint job now exits with 0 warnings instead of a noisy allow-list, and coverage thresholds in frontend/vitest.config.ts have been raised in lock-step against the new measured baseline (statements / branches / functions / lines) to prevent backsliding. Dependabot PRs for ESLint 10 / eslint-plugin-react-hooks 7.1.1 are held until eslint-plugin-react and eslint-plugin-jsx-a11y ship v10-compatible releases (the current latest still call the removed context.getFilename() and cap their peer range at eslint@^9 respectively).",
      },
      {
        title: "Drop-in upgrade from v1.4.0",
        description:
          "No database migrations, no /api/* contract changes (only the tunnel.terminated audit reason enum gained a member), no config.toml schema changes. Rebuild backend and frontend so the new bits actually run: docker compose build backend frontend && docker compose up -d. The guacd image build is unchanged from v1.4.0 — rebuild only if you want the documentation-only Dockerfile comment refresh. Other backend bumps: bollard 0.18.1 → 0.21.0 (typed models::* responses replace serde_json::Value in list_images / inspect_container; test-side adjustments in services/vdi_docker.rs), tokio 1.52.1 → 1.52.2. CI bumps: docker/login-action 3.7.0 → 4.1.0, actions/cache 4.3.0 → 5.0.5, github/codeql-action 4.35.2 → 4.35.3, plus the Trivy scan now prints the findings table on failure and the GHA OS-package build cache is dropped per-run so freshly-published patch CVEs surface same-day.",
      },
    ],
  },
  {
    version: "1.4.0",
    subtitle:
      "Kubernetes pod console as a first-class protocol — kubectl attach / exec rendered as a terminal, with kubeconfig importer",
    sections: [
      {
        title: "Apache Guacamole's kubernetes protocol arrives in Strata",
        description:
          "Pick Kubernetes Pod as the protocol on a new connection and Strata will tunnel kubectl attach / kubectl exec to the named pod through guacd's libguac-client-kubernetes.so driver, rendered as a terminal in the browser. The custom guacd image already builds the .so (libwebsockets-dev was already in the build deps), and the Dockerfile now hard-fails the image build if any of libguac-client-{rdp,ssh,vnc,kubernetes}.so is missing after make install rather than silently dropping the protocol at runtime. Backend tunnel.rs gets a kubernetes branch with terminal defaults (xterm-256color, gray-on-black, 1000-line scrollback, default namespace) and an extended is_allowed_guacd_param whitelist for namespace, pod, container, exec-command, use-ssl, ca-cert and client-cert. The protocol uses the same recording, audit, credential-profile and tunnel infrastructure as every other Strata session — no new sidecar, no parallel storage path.",
      },
      {
        title: "client-key never lands in the connections table",
        description:
          "mTLS to the K8s API needs both a client cert and the matching private key. Strata splits them deliberately: the cert is public PEM and lives in connections.extra (client-cert), but the private key lives only in a Vault-encrypted credential profile. routes/tunnel.rs special-cases wire_protocol == kubernetes and remaps the decrypted profile password slot into the guacd client-key parameter at handshake time, then clears username/password to avoid stray protocol arguments. The is_allowed_guacd_param whitelist deliberately excludes client-key, so a malicious admin cannot smuggle a private key in via connection extras either. The new POST /api/admin/kubernetes/parse-kubeconfig endpoint returns the extracted private key to the caller exactly once and does not persist it.",
      },
      {
        title: "Import kubeconfig — paste once, fields fill themselves",
        description:
          "The connection editor sprouts an Import kubeconfig textarea above the Kubernetes form sections. Paste your ~/.kube/config, click Parse and fill form, and the backend extracts the cluster server URL (split into hostname/port), the namespace, the cluster CA cert and the client cert into the right form fields. The client private key surfaces in a copy now panel with an amber border; copy it into the credential profile you'll assign to this connection and the panel goes away. The parser refuses to follow file-path references for cert material (certificate-authority: /path/to/ca.crt) — only embedded *-data base64 blobs are decoded — because the backend has no business reading random admin-controlled file paths. A 1 MiB body cap prevents YAML-bomb abuse.",
      },
      {
        title: "New protocol icons across the UI",
        description:
          "CommandPalette, Dashboard and ActiveSessions get a stylised Kubernetes wheel (heptagon + radial spokes) for the new protocol. ActiveSessions surfaces it as a k8s primary-coloured chip in the protocol column. The connection editor's protocol dropdown gains a Kubernetes Pod entry with default port 6443 (kubeadm-style); operators connecting to clusters on 8080 or 443 will need to override the port the same way they would for any other protocol.",
      },
      {
        title: "Migration 060, no API breaks",
        description:
          "One new migration: 060_kubernetes_protocol.sql widens the connections.protocol and ad_sync_configs.protocol CHECK constraints to include 'kubernetes'. No /api/* contract changes for existing protocols, no config.toml schema changes. Backwards compatible with v1.3.x — drop-in upgrade after rebuilding the backend, frontend, and guacd images. Live pod listing (POST /api/admin/kubernetes/list-pods backed by the kube Rust crate's ~80-deep transitive dep tree) is deferred to a later release; use kubectl get pods out-of-band today.",
      },
    ],
  },
  {
    version: "1.3.2",
    subtitle:
      "guacd FreeRDP 3.25 ABI fix, RDP resize ghost-region cleanup, idle-tunnel watchdog, and logout WebSocket teardown",
    sections: [
      {
        title: "guacd image builds again on Alpine edge (FreeRDP 3.25)",
        description:
          "FreeRDP 3.25 deleted the legacy Authenticate callback field from struct rdp_freerdp in favour of the new AuthenticateEx callback (which adds an rdp_auth_reason reason argument), so the moment Alpine edge bumped freerdp-dev from 3.24.2-r0 to 3.25.0-r0 the custom guacd image stopped compiling with 'struct rdp_freerdp has no member named Authenticate; did you mean AuthenticateEx?'. New patch 006-freerdp325-authenticate-ex.patch adds an explicit #include <freerdp/version.h> in rdp.c and uses FREERDP_VERSION_MAJOR / FREERDP_VERSION_MINOR to select the new five-argument AuthenticateEx signature on FreeRDP >= 3.25 while keeping the four-argument Authenticate signature on 3.24 and earlier. The added reason parameter is intentionally discarded because the existing implementation already requests whichever credentials are missing, regardless of why FreeRDP raised the callback. The Dockerfile gained two grep -q assertions immediately after the patch loop that fail the build with a clear error message if the version include or the AuthenticateEx assignment is missing — these would have caught the silent semantic regression of the first patch attempt in seconds rather than minutes. A new guacd/patches/.gitattributes pins *.patch to text eol=lf so contributors with core.autocrlf=true on Windows cannot accidentally introduce CRLF that misaligns hunk context.",
      },
      {
        title: "Black ghost regions after RDP desktop resize are gone",
        description:
          "When a Windows RDP server changed resolution mid-session (resolution change inside a VM, GFX channel renegotiation, monitor reconfiguration), the Strata canvas would render a solid-black margin along the edge of the new desktop area until the user moved a window across the affected region to force a repaint. Patch 005-refresh-rect-on-resize.patch on the custom guacd now marks the entire layer dirty after gdi_resize and asks the RDP server to re-send pixels for the full new desktop area via context->update->RefreshRect, with bounds-checks against UINT16_MAX so a pathological resize cannot produce a malformed PDU. Two new structured debug log lines ([strata] guac_rdp_gdi_desktop_resize: resizing ... and [strata] post-resize RefreshRect ... -> ok|FAILED) make the path observable at GUAC_LOG_DEBUG.",
      },
      {
        title: "Lost-tab tunnels close themselves now",
        description:
          "If the operator's browser tab was killed without a graceful close — OS task-killer, network drop, kernel OOM, hostile client, alt-tab into a process that took focus and never gave it back — the WebSocket tunnel kept proxying frames into a recording for as long as the OS held the underlying TCP socket open. The recording grew, the session_registry row stayed live, and the live-sessions admin page lied about who was actually connected. backend/src/routes/tunnel.rs ws_tunnel now decodes the access token's exp claim once at upgrade time and runs a 30-second tick loop that asks token_revocation::is_revoked(token) and compares now() to exp; either condition aborts the proxy loop, the recording flushes, and session_registry decrements within at most one tick. Polling cadence was chosen so an aggressive 1-minute access-token TTL still detects revocation in <= 30 s while a normal 20-minute TTL costs at most 40 ticks per session — negligible next to the WebSocket I/O.",
      },
      {
        title: "Clicking Log out closes your tunnels immediately",
        description:
          "Manual logout (and idle-timeout logout) used to flip React auth state without first closing any open Guacamole tunnels, so the backend kept proxying frames into a logged-out user's recording until the tab was eventually closed by the browser. SessionManager.tsx now exposes a module-level closeAllSessionsExternal() handler that App.tsx's handleLogout calls before clearing user state — the helper iterates every active session and runs the same cleanup path used by the per-session disconnect button (cleanupPopout, cleanupMultiMonitor, _cleanupPaste, keyboard reset, client.disconnect()), all wrapped in best-effort try / catch so a single failure cannot block the rest of the logout. handleLogout then issues a fire-and-forget apiLogout() to invalidate the refresh token and clear the auth cookies. The backend now sees clean WebSocket closes the moment the user clicks Log out, and the live-sessions list updates immediately rather than after the next watchdog tick.",
      },
      {
        title: "Drop-in upgrade — rebuild required",
        description:
          "All four fixes live in either the Rust backend binary, the React bundle, or the custom guacd image. Run docker compose up -d --build (or pull a freshly published CI tag); a docker compose pull of an old tag will leave you on the broken guacd image. No database migrations. No /api/* contract changes. No config.toml schema changes. Existing in-flight tunnels that were already connected before the upgrade get the watchdog the next time the user reconnects (the watchdog is wired in ws_tunnel, which only runs at upgrade time). FreeRDP 3.24 still works — the patch's #if guard means contributors on Debian 13 / Trixie (which still ships freerdp-3.24) build identically to before.",
      },
    ],
  },
  {
    version: "1.3.1",
    subtitle:
      "SSH terminal fidelity, phantom-selection mouse hygiene, recording-playback URL fix, and guacd patch resilience",
    sections: [
      {
        title: "SSH sessions look right out of the box",
        description:
          "Brand-new SSH connections now ship with the same terminal defaults that upstream rustguac uses: terminal-type=xterm-256color, color-scheme=gray-black, scrollback=1000, plus matching font / locale / backspace / server-alive parameters. The first one is load-bearing — without it guacd's bundled SSH terminal exports TERM=linux to the remote PTY, so nano and less cannot save and restore the alternate screen (the bug where closing nano leaves the file contents stuck on your terminal). The colour-scheme default fixes 16-colour-only rendering of vim syntax highlighting and ls --color. The scrollback default lifts guacd's in-buffer line count from ~256 to 1000 so a single journalctl invocation actually fits. Per-connection admin overrides via the extras allowlist still win — the defaults only fill in keys you haven't set.",
      },
      {
        title: "No more phantom text selection across the SSH terminal",
        description:
          "Long-running annoyance: click inside the SSH terminal, then move the cursor to the browser tab strip without physically releasing the mouse button, and guacd's terminal would keep extending a text selection across whatever the cursor passed over. Root cause is that when the matching mouseup lands outside the document (browser chrome, devtools, popped-out windows), the page never receives it and guacd stays in left-button-held state. SessionManager.tsx now wires a releaseMouseButtons handler to mouseleave on the canvas and blur on the window — when fired, it inspects the live mouse state and, if any button is still held, sends a buttons-released state to guacd. No-op when nothing is held, so it costs zero round-trips during normal use.",
      },
      {
        title: "Seek and speed buttons on the recording player work again",
        description:
          "Clicking any seek (30S, 1M, 3M, 5M either direction) or speed (2x, 4x, 8x) button on a recording-playback page would render a red Tunnel error badge over the player. The frontend URL builder in HistoricalPlayer.tsx prepended &seek=… and &speed=… to a base URL that didn't contain a ? yet, producing a malformed path like …/stream&seek=3114&speed=2 that the WebSocket route correctly rejected. Fixed by collecting params into a list and prepending ? when the base has no query string, & when it does. The /api/{user,admin}/recordings/:id/stream endpoint and its documented seek / speed query parameters were always correct; only the frontend was wrong. No backend or API changes.",
      },
      {
        title: "guacd image build is resilient to harmless context drift",
        description:
          'docker compose build guacd previously failed with error: patch does not apply if a hunk\'s surrounding context drifted by even a single whitespace line. The Dockerfile now installs the patch utility and falls back to patch -p1 -F3 <"$p" when git apply rejects a hunk, allowing up to three lines of fuzz. The upstream apache/guacamole-server commit pin (2980cf0) is unchanged and the actual patch contents are unchanged. A stray diagnostic patch (005-alt-screen-trace.patch) that was used during the SSH terminal investigation has been removed from the patches directory; the fix that superseded it lives entirely in backend tunnel.rs.',
      },
      {
        title: "Drop-in upgrade — rebuild required",
        description:
          "All fixes are confined to the backend Rust binary, the frontend bundle, and the guacd Dockerfile patch step. Run docker compose up -d --build (or pull freshly published CI tags); a docker compose pull of an old tag is not enough. No database migrations. No /api/* contract changes. No config.toml schema changes. Existing SSH connections pick up the new defaults on first reconnect; admin extras overrides keep winning.",
      },
    ],
  },
  {
    version: "1.3.0",
    subtitle:
      "Web-kiosk lifecycle correctness, Chromium trust-store fix, production-resilience hardening, and protocol-aware Quick Share",
    sections: [
      {
        title: "Trusted CAs that you uploaded under v1.2.0 actually work now",
        description:
          "v1.2.0 shipped the Trusted CA admin surface and faithfully created a per-session NSS database under <user-data-dir>/.pki/nssdb at kiosk launch — but Chromium on Linux reads NSS exclusively from $HOME/.pki/nssdb and ignores --user-data-dir for trust-store resolution, so every internally-signed site still tripped NET::ERR_CERT_AUTHORITY_INVALID despite a successful certutil -A. The kiosk spawner now explicitly sets HOME=<user_data_dir> on the Chromium child process so NSS resolves to exactly the directory the backend just populated. No re-upload needed: existing v1.2.0 bundles start working on the first kiosk spawn after the upgrade.",
      },
      {
        title: "Closing a web kiosk's browser tab actually closes the kiosk",
        description:
          'The web-protocol branch of the tunnel route used to spawn Chromium + Xvnc, hand the WebSocket pair to the proxy loop, and then forget about them — but the in-memory WebRuntimeRegistry kept holding the Arc<WebSessionHandle>, so closing the browser tab without first hitting Disconnect left both child processes (and the allocated X display, CDP port, and profile tempdir) running. Reopening the same connection then returned the stale handle (= a closed blank tab) instead of a fresh kiosk. The route now calls web_runtime.evict() after the proxy loop returns, dropping the registry\'s Arc; refcount-zero teardown SIGKILLs both children, releases the display + CDP slot, and removes the per-session tempdir (with its NSS DB inside). A web.session.end audit row is written with reason: "tunnel_disconnect" so the lifecycle is visible in the audit log.',
      },
      {
        title: "Quick Share knows your protocol",
        description:
          "When the active session is SSH or Telnet, Quick Share's copy button now hands you a curl -fLOJ '<url>' one-liner you can paste straight into the remote shell — -L follows redirects, -O writes to a file, -J keeps the original Content-Disposition filename, and -f fails fast on HTTP errors so you never end up with a 404 body silently saved as the file. RDP / VNC / web kiosks still get the bare URL because the user pastes it into a graphical browser. A new Copy as dropdown — rendered with the shared Select component to match the rest of the UI — lets you override per-session: URL, curl (Linux/macOS), wget --content-disposition (Linux), or Invoke-WebRequest -Uri … -OutFile … (Windows / OpenSSH-on-Windows). Every variant single-quotes the URL so an exotic origin character cannot break the shell command.",
      },
      {
        title: "No more yellow “unsupported flag” bar across every kiosk",
        description:
          "The Chromium kiosk runs as root inside the backend container, so we have always had to pass --no-sandbox; that in turn caused Chromium to paint a permanent ~28 px yellow bar across the top of every tab reading You are using an unsupported command-line flag: --no-sandbox. Stability and security will suffer. The argv builder now adds --test-type whenever it adds --no-sandbox, suppressing the bar (and a handful of other end-user prompts that have no meaning inside a single-tab kiosk: default-browser, session-restore). Critically, --test-type does NOT disable the sandbox; rendering, network stack, mojo IPC, JIT, and origin isolation are unchanged. Two new unit tests pin the pairing.",
      },
      {
        title: "Backend no longer crash-loops with exit 141 and empty logs",
        description:
          "On hosts with non-trivial recording history the backend container was crash-looping with exit code 141 and zero log output. Root cause: backend/entrypoint.sh reads the recordings volume's gid via find … | head -n1 under set -euo pipefail; head closes its stdin after the first line, find is killed with SIGPIPE (= 128 + 13 = 141), pipefail propagates that exit code, set -e aborts the script, and the container dies before gosu strata strata-backend ever runs. Wrapped just that one pipeline with set +o pipefail / set -o pipefail so the harmless SIGPIPE on find no longer kills startup, while preserving strict-mode safety everywhere else.",
      },
      {
        title: "nginx survives a backend restart without a manual kick",
        description:
          'The frontend nginx container used to die on boot with [emerg] host not found in upstream "backend" if the backend was even briefly unreachable when nginx came up — the typical case during docker compose up -d --build while the backend image was still finishing its build. The shared upstream fragment now declares resolver 127.0.0.11 valid=10s ipv6=off; (Docker\'s embedded DNS) and uses a set $backend_upstream variable as the proxy_pass target, forcing per-request resolution. Nginx now stays up and returns 502 Bad Gateway for the duration of any backend outage, recovering automatically when the upstream comes back. Side benefit: the stuck Login spinner that this bug caused is gone.',
      },
      {
        title: "Drop-in upgrade — rebuild required",
        description:
          "All four backend fixes (entrypoint pipefail, HOME=user_data_dir, --test-type, eviction-on-disconnect) live in either the entrypoint script or the Rust binary, both baked into the backend image. The nginx resolver fix is baked into the frontend image. Run docker compose up -d --build (or pull a freshly published CI tag); a docker compose pull of an old tag is not enough. No database migrations. No /api/* contract changes. Existing Trusted CA bundles uploaded under v1.2.0 start working on first kiosk spawn under v1.3.0.",
      },
    ],
  },
  {
    version: "1.2.0",
    subtitle:
      "Reusable Trusted CA bundles for Web Sessions, tenant-aware checkout-email rendering, and SMTP / NVR UX polish",
    sections: [
      {
        title: "Upload a PEM once, reuse it on every web kiosk",
        description:
          'A new admin surface — Admin → Trusted CAs — lets you upload a PEM bundle with a friendly name, description, and parsed metadata preview (subject, expiry, SHA-256 fingerprint), then attach it to any number of web-protocol connections via a dropdown in the connection editor. At kiosk launch the backend creates a per-session NSS database under <user-data-dir>/.pki/nssdb and runs certutil -A -d sql:<dir> -n <label> -t "C,," -i <pem> so Chromium trusts the supplied roots without resorting to --ignore-certificate-errors. PEMs are validated at upload time with rustls-pemfile + x509-parser; deletion of a CA still referenced by an active connection is refused with a clear error message. New endpoints: GET/POST /api/admin/trusted-cas, PUT/DELETE /api/admin/trusted-cas/{id}, plus a slim auth-only GET /api/user/trusted-cas for the connection-editor dropdown.',
      },
      {
        title: "Checkout emails now respect your tenant's display timezone and date format",
        description:
          "Approval / approved / rejected / self-approved checkout emails previously rendered every expiry timestamp as YYYY-MM-DD HH:MM UTC, regardless of the operator's settings. They now use a new format_datetime_for_display() helper backed by chrono-tz that reads system_settings.display_timezone (IANA zone), display_date_format (YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY, DD-MM-YYYY), and display_time_format (HH:mm, HH:mm:ss, hh:mm A, hh:mm:ss A). The zone abbreviation is appended (BST, EST, etc.) so the recipient can disambiguate the local time at a glance.",
      },
      {
        title: '"Target account" line on emails finally shows the friendly name',
        description:
          "Where an admin has set a friendly_name on the account mapping (or where the user's Credentials page checkout request stored one), that name is now what appears on the email. Otherwise the displayed Common Name is extracted with a proper RFC 4514-aware parser that handles escaped commas (CN=Smith\\, John,...), escaped plus signs, hex-encoded bytes (\\2C), and case-insensitive cn= attribute labels. Previously the naive dn.split(',').next() implementation displayed the full Distinguished Name on accounts whose CN contained an escaped comma.",
      },
      {
        title: "Inline cid:strata-logo banner on every transactional email",
        description:
          "The MJML templates already referenced cid:strata-logo in the banner image, but no inline part was actually being attached, so every recipient saw a broken-image icon. The dispatcher, retry worker, and admin test-send route now all attach templates/strata-logo.png as a multipart/related inline part with content-id strata-logo at every real send site, so the white wordmark renders on the accent banner across Outlook, Gmail, Apple Mail, Thunderbird, and K-9.",
      },
      {
        title: "SMTP TLS = none mode hides — and clears — credentials",
        description:
          'Selecting TLS = none under Admin → Notifications → SMTP (typical for an internal port-25 relay) now hides the username and password fields entirely and sends password: { action: "clear" } on save. Switching from STARTTLS or implicit-TLS to plaintext relay can no longer leave stale Vault-encrypted credentials behind. A short helper sentence under the TLS dropdown documents the unauthenticated-mode contract so operators don\'t have to read the source.',
      },
      {
        title: "Premium LIVE / Rewind buttons in the admin Sessions table",
        description:
          "The two NVR action buttons on the admin Sessions page have been reworked into an inverted, gradient-on-hover style with a dual-keyframe pulsing dot — a 1.1 s scaled core dot plus an expanding halo ring — so the broadcast-LIVE affordance reads instantly even on a busy table. Honours @media (prefers-reduced-motion: reduce) by disabling the pulse for affected users.",
      },
      {
        title: "Drop-in upgrade — but a rebuild is required",
        description:
          "One new database migration (059_trusted_ca_bundles.sql) runs automatically on first boot. The backend image gains the libnss3-tools apt package (provides certutil), so a docker compose pull is not enough — operators must docker compose up -d --build or rely on CI to publish a new image tag. No /api/* breaking changes; all five new endpoints are additive. Old connections.extra rows without trusted_ca_id continue to use the OS default trust store. cargo fmt / clippy clean; cargo test green; Sessions.test.tsx 38/38; NotificationsTab.test.tsx 17/17.",
      },
    ],
  },
  {
    version: "1.1.0",
    subtitle:
      "RDP graphics-pipeline parity with rustguac, recording-playback EACCES fix, sidebar collapse, stuck-key cleanup, and a new Playwright RBAC pack",
    sections: [
      {
        title: "RDP GFX & H.264 toggles now reflect the real wire state",
        description:
          'The Codecs panel of the connection form is reworked so the Enable graphics pipeline (GFX) checkbox is ticked only when disable-gfx === "false" — i.e. it reflects what the backend will actually negotiate, not the absence of a value. Toggling it writes the explicit string "false" or "true" to the parameter map so frontend and backend never disagree about the default. The companion Enable H.264 (AVC444) checkbox is rendered disabled whenever GFX is off (because guacd\'s H.264 path requires GFX to negotiate the video/h264 mimetype), ticking it forces disable-gfx="false" for you, and unticking GFX clears any previously-set enable-h264 so the form cannot be saved into an unreachable state. An amber warning under the H.264 row reminds admins that AVC444 needs a Windows host with a discrete GPU exposing RemoteFX vGPU / AVC444 codec support. The AdSync default-parameter tab is updated in lockstep so AD-synced new connections inherit the same interlock.',
      },
      {
        title: 'Historic recording playback no longer fails with "Tunnel error"',
        description:
          'A production-affecting bug where the Play button on a historic recording opened the player to a black canvas with a red "Tunnel error / Retry" badge has been fixed. Root cause: the shared guac-recordings Docker volume is written by guacd as guacd:guacd (uid/gid 100/101 inside the Alpine guacd container) at mode 0640 — group-only-read — but the backend container runs as strata:strata (uid/gid 996/996), so the file open returned EACCES. The fix is a runtime supplementary-group bootstrap in backend/entrypoint.sh that reads the gid off whichever guacd-written file is present, creates a matching local group inside the backend container, and adds strata to it. The backend\'s DAC_OVERRIDE capability is deliberately NOT used — standard POSIX group-read suffices, preserving least-privilege. All existing recordings become readable on first boot after the upgrade with no file-rewriting or chmod sweep needed; Azure-stored recordings are unaffected because that path streams blobs over HTTPS and never touches the local filesystem.',
      },
      {
        title: "Stuck-key cleanup — Ctrl+K mid-keystroke can no longer spam the previous remote",
        description:
          "Both keyboard-effect cleanup paths in SessionClient.tsx now invoke kb.reset() after nulling onkeydown / onkeyup. This cancels the synthetic auto-repeat timer that Guacamole.Keyboard.press() starts at 500 ms and ticks every 50 ms, and clears the internal pressed[] set so a key held down at the moment of teardown cannot resume hammering the remote when the effect re-attaches on return. Eliminates the regression where switching between sessions via the command palette while still pressing Enter / Space would cause the previous session to receive phantom keystrokes once focus came back.",
      },
      {
        title: 'Floating "Hide sidebar" button reclaims screen real-estate',
        description:
          "A new persistent affordance lets you collapse the left navigation column into a thin edge with a single click. The collapsed-state is stored in your existing settings context so the preference survives across sessions, browsers, and reload-cycles. Most useful on widescreen monitors during active sessions where every pixel of horizontal space matters for the remote canvas.",
      },
      {
        title: "Playwright RBAC + command-palette smoke pack",
        description:
          "Two new Playwright test files land under e2e/tests/. command-palette.spec.ts exercises the global Ctrl+K handler end-to-end (open, focus, Esc-close), with a hardened beforeEach that dismisses the Session Recording Disclaimer modal so a fresh-database admin's null terms_accepted_version doesn't block the palette mount. rbac.spec.ts is an RBAC negative pack covering the /api/admin/* and /api/user/* boundaries with no auth, expired bearer, mismatched CSRF, and forged-cookie variants — every case must return 401/403 and must not leak response bodies that would help an attacker fingerprint the routing layer.",
      },
      {
        title: "Drop-in upgrade — but a rebuild is mandatory",
        description:
          "No new database migrations land in v1.1.0; no /api/* contract changes; no config.toml schema changes. Operators on v1.0.0 must run docker compose pull && docker compose up -d --build (or the equivalent build --pull && up) so the entrypoint changes in both the backend and guacd images take effect. A docker compose pull alone is insufficient if your registry has not yet rebuilt — the recording-playback fix lives in the new entrypoint.sh layer, not in the Rust binary. Existing connections preserve their saved GFX/H.264 state; the form rework only changes how unset values are rendered. Frontend test suite is green at 1232/1232 across 47 files; npm audit reports 0 vulnerabilities; CodeQL alerts #85 and #88 resolved.",
      },
    ],
  },
  {
    version: "1.0.0",
    subtitle:
      "General availability — Strata Client reaches 1.0.0 with a formal SemVer commitment for the REST API, database schema, and on-disk config",
    sections: [
      {
        title: "Straight promotion of the v0.31.0 codebase",
        description:
          "Strata Client 1.0.0 is a version-only promotion of v0.31.0 — no source files outside VERSION, backend/Cargo.toml, backend/Cargo.lock, frontend/package.json, frontend/package-lock.json, and the README version badge changed in this release. Every feature shipped under v0.31.0 — built-in commands, personal :command mappings, ghost-text autocomplete, the new command.executed audit stream, and the validate_command_mappings server-side guard rail — carries forward verbatim. The 1232/1232 frontend test suite, 0-vulnerability npm audit, and clean cargo fmt / clippy state from v0.31.0 all apply to 1.0.0 unchanged.",
      },
      {
        title: "Formal SemVer commitment from 1.0.0 onward",
        description:
          "From this release the public REST API surface (/api/*), the database schema (managed by the numbered migrations under backend/migrations/), and the on-disk configuration shape (config.toml keys + environment variable contracts) are stable. Breaking changes to any of those three surfaces will require a v2.0.0 bump. Internal Rust modules, the frontend component tree, and the WhatsNew/CHANGELOG narrative remain free to evolve in minor and patch releases. This formalises what has been implicit through the 0.x series and gives operators a clear upgrade-safety contract.",
      },
      {
        title: "Drop-in upgrade — no migrations, no API changes, no UI changes",
        description:
          "Operators on v0.31.0 can docker compose pull && up without further action. No new database migrations land. No /api/* contract changes. No frontend UI changes beyond this WhatsNew card welcoming you to 1.0.0. The release pipeline publishes ghcr.io/<org>/strata-backend:1.0.0 and ghcr.io/<org>/strata-frontend:1.0.0 alongside the rolling :latest tag; the previous :0.31.0 images remain available and are byte-identical.",
      },
    ],
  },
  {
    version: "0.31.0",
    subtitle:
      "Built-in commands, personal `:command` mappings, ghost-text autocomplete, and a new `command.executed` audit stream",
    sections: [
      {
        title: "Type `:` to enter command mode — six built-ins out of the box",
        description:
          "Pressing your Command Palette binding (default Ctrl+K) and typing a colon switches the palette into command mode. Six built-in commands ship by default: :reload reconnects the active session and forces an IDR keyframe (same flow as the SessionBar reconnect button), :disconnect closes the active session and returns to the dashboard, :close is a friendlier alias for :disconnect that closes the current server page, :fullscreen toggles browser fullscreen with Keyboard Lock so OS shortcuts stay captured, :commands renders an inline list of every command available to you with a colour-coded pill for each kind, and :explorer <arg> drives the Windows Run dialog on the active session (Win+R → paste arg → Enter) so :explorer cmd opens a command prompt, :explorer \\\\server\\share opens a share, and :explorer notepad launches Notepad. Built-ins that aren't currently usable (e.g. :reload with no active session) are greyed and surface a clear reason instead of silently no-op'ing.",
      },
      {
        title: "Personal `:command` mappings — up to 50 per user, six action types",
        description:
          "Visit Profile → Command Palette Mappings to define up to 50 of your own :command triggers. Six action types are supported: open-connection (jump to a saved connection by UUID), open-folder (dashboard pre-filtered to a folder), open-tag (dashboard pre-filtered to a tag), open-page (in-app route from the seven-value allow-list), paste-text (sends free-form text into the active session via clipboard + Ctrl+V, up to 4096 chars), and the headline addition open-path — which drives the Windows Run dialog on the active remote session (Win+R → paste path → Enter) so a UNC share like \\\\computer456\\share, a local folder like C:\\Users\\Public, or a shell: URI like shell:startup opens directly in Explorer on the remote target. Triggers are validated against ^[a-z0-9_-]{1,32}$, must not collide with the six built-in command names, and must be unique within your own list. Mappings persist in the same user_preferences JSONB blob added in v0.30.1, so they follow you across browsers and devices with no new database migration.",
      },
      {
        title: "Ghost-text autocomplete and a friendly invalid state",
        description:
          'While typing in command mode the palette renders a low-opacity ghost-text overlay showing the longest unambiguous extension of your current input across every command available to you (built-ins plus your mappings). Press Tab or Right Arrow (when the caret is at end-of-input) to accept. Type something that doesn\'t resolve and the input border switches to var(--color-danger), a role="alert" reason line renders below, aria-invalid is set, and Enter becomes a hard no-op — no audit row, no navigation. The longest-common-prefix algorithm correctly disambiguates a user-defined :reset against the built-in :reload, so adding mappings never traps you in the wrong autocomplete.',
      },
      {
        title: "Every executed command writes one tamper-evident audit row",
        description:
          "Every successful command execution writes one command.executed entry to the existing append-only, SHA-256-chain-hashed audit_logs table via a new fire-and-forget POST /api/user/command-audit endpoint. The handler hard-codes action_type server-side so a malicious client cannot poison the audit-event taxonomy by passing a fake type through the request body, and uses the same advisory-locked chain-hash code path as every other Strata audit event. Security teams can review what operators ran, against which target, and when — with the same tamper-evidence guarantees as tunnel.connected, checkout.activated, and the rest of the existing audit stream.",
      },
      {
        title: "Defence-in-depth validation — server is the source of truth",
        description:
          "A new validate_command_mappings() helper in backend/src/services/user_preferences.rs enforces the mappings shape before the JSONB blob ever lands in PostgreSQL: array length ≤ 50, trigger regex ^[a-z0-9_-]{1,32}$, no built-in collision, unique-within-list triggers, action in the six-value allow-list, open-page path in the seven-value enum, paste-text ≤ 4096 chars, open-path ≤ 1024 chars and free of control characters (newline injection through the Run dialog would let a stored mapping execute follow-up commands), and UUID-parseable target IDs for the three target-id actions. 12 unit tests cover every rejection branch plus the happy paths for all action types. A frontend bypassing client-side validation still cannot poison the database — all server-side enums are authoritative and the frontend's mirrors are cosmetic.",
      },
      {
        title: "Drop-in upgrade — no migrations, defaults preserved",
        description:
          "No database migrations land in v0.31.0; mappings reuse the existing user_preferences.preferences JSONB column from v0.30.1. Operators on v0.30.2 can docker compose pull && up without further action. Existing users see exactly the same palette experience as v0.30.2 until they explicitly add a mapping; built-in commands become available to everyone immediately after upgrade with no per-user opt-in. Frontend test suite is green at 1232/1232 across 47 files; npm audit reports 0 vulnerabilities.",
      },
    ],
  },
  {
    version: "0.30.2",
    subtitle:
      "Maintenance & supply-chain hygiene — dependency bumps, action SHA pinning refresh, and a CodeQL credential finding cleared",
    sections: [
      {
        title: "CodeQL #83 — hardcoded credential finding cleared",
        description:
          "A CodeQL Critical alert (rust/hardcoded-credentials) flagged literal username/password values flowing through the vdi_env_vars test in backend/src/services/vdi.rs. The literals were never reachable outside the #[cfg(test)] module — there is no production code path that consumes them — but the static-analysis signal added noise to the security dashboard. The test now constructs all four values at runtime via Uuid::new_v4(), so no string literal flows into a credential parameter, and the override semantic (smuggled VDI_USERNAME / VDI_PASSWORD in extra get replaced by the runtime args) is unchanged.",
      },
      {
        title: "Dependency bumps — backend (rustls, axum-prometheus, mrml)",
        description:
          "rustls 0.23.38 → 0.23.39 (patch, Cargo.lock-only). axum-prometheus 0.7 → 0.10 (major) — Strata's only call site is PrometheusMetricLayer::pair() in backend/src/routes/mod.rs; none of the breaking-surface APIs (MakeDefaultHandle::make_default_handle(self) in 0.7, with_group_patterns_as matchit-pattern syntax in 0.8, or the metrics-exporter-prometheus 0.18 upgrade in 0.10) are reached. mrml 5 → 6 (major) — Strata's only call sites are mrml::parse(&str) and RenderOptions::default() in backend/src/services/email/templates.rs, both stable across the boundary; the 5→6 changelog is bug-fixes-and-deps-bump only.",
      },
      {
        title: "Dependency bumps — frontend (jsdom, vite)",
        description:
          "jsdom 29.0.2 → 29.1.0 (minor) and vite 8.0.9 → 8.0.10 (patch), both devDependencies (test runner / build tool). No runtime bundle change. npm audit reports 0 vulnerabilities.",
      },
      {
        title: "GitHub Actions SHA pinning refreshed (5 actions, 9 occurrences)",
        description:
          "Pinned-by-SHA-with-tag-comment workflow actions are bumped to their newest tagged commits. .github/workflows/ci.yml: actions/setup-node v4 → v6.4.0 (×3), actions/upload-artifact v4 → v7.0.1 (×3). .github/workflows/release.yml: docker/metadata-action v5 → v6.0.0, actions/upload-artifact v4 → v7.0.1, sigstore/cosign-installer v3 → v4.1.1, softprops/action-gh-release v2 → v3.0.0. Existing # vN.N.N trailing-comment convention preserved so Dependabot keeps tracking them.",
      },
      {
        title: "CI stability fixes",
        description:
          "(1) backend/src/services/web_login_script.rs — three tests (spawn_succeeds_with_zero_exit, spawn_surfaces_non_zero_exit, spawn_kills_on_timeout) intermittently failed on Linux CI with 'Text file busy' (ETXTBSY) because the temp script file was still being held by an fs::File handle when chmod+spawn ran. Now explicitly sync_all().unwrap() and drop(f) before set_permissions(). (2) frontend SessionWatermark 'uses N/A for missing client_ip' test asserted fillTextSpy synchronously after render() — the watermark paint actually runs in a useEffect a tick later, so the assertion is now wrapped in await waitFor(...). (3) .github/workflows/trivy.yml SARIF upload step now skips cleanly via if: always() && hashFiles(...) != '' when the prior Trivy scan errored out, instead of masking the real failure with a misleading upload-not-found error.",
      },
      {
        title: "Drop-in upgrade — no DB migrations, no API changes, no UI changes",
        description:
          "This is a pure maintenance release. Operators on v0.30.1 can docker compose pull && up without further action. No new database migrations. No /api/* contract changes. No frontend UI changes. Frontend test suite is green at 1232/1232 across 47 files.",
      },
    ],
  },
  {
    version: "0.30.1",
    subtitle: "Per-user preferences and a customisable Command Palette shortcut (default Ctrl+K)",
    sections: [
      {
        title: "Rebind Ctrl+K from your Profile page",
        description:
          "Strata's in-session Command Palette is bound to Ctrl+K by default — which collides with Visual Studio's Peek/Comment chord, JetBrains' commit-changes, Slack's quick-switcher, Obsidian's link-insert, and several other common host-side shortcuts. v0.30.1 lets every user remap that binding (or disable it entirely) from a brand-new Profile page, accessible by clicking the user avatar in the sidebar. The recorder accepts any Ctrl/Alt/Shift/Meta combination plus a printable or named key (Enter, Space, F1, etc.); modifier-only presses are ignored, and Esc cancels without committing.",
      },
      {
        title: "Stored server-side per user — follows you across devices",
        description:
          "The preference is persisted in a new user_preferences PostgreSQL table (migration 058_user_preferences.sql) keyed by user_id with a JSONB blob, exposed through GET / PUT /api/user/preferences. That means the binding survives browser-cache clears and follows the operator across browsers and devices. The blob is intentionally schema-less at the database layer so additional preferences can be added in future releases without further migrations — the frontend owns the shape.",
      },
      {
        title: "Cross-platform: Ctrl matches both Ctrl and ⌘",
        description:
          "The matcher treats Ctrl in a stored binding as 'Ctrl OR ⌘' so the same value works on every operator's OS without per-device configuration. A stored Ctrl+K matches Ctrl+K on Windows/Linux and ⌘+K on macOS. The matcher is also case-insensitive on the event side and modifier-order insensitive in the stored string. Cmd, Meta, Win, and Super are recognised aliases for the same modifier.",
      },
      {
        title: "Both keystroke traps now respect the preference",
        description:
          "The capture-phase trap in SessionClient.tsx (which fires before Guacamole's keyboard handler so the chord can't leak through to the remote OS) and the popout/multi-monitor trap in usePopOut.ts both read the user-configured binding through a useRef. The ref is updated whenever the preference changes so the keydown listener never has to be rebound mid-session. The cross-window postMessage relay is unchanged — it dispatches on message type, not on key.",
      },
      {
        title: "Drop-in upgrade — defaults preserved",
        description:
          "Until a user explicitly visits /profile and saves something, no preferences row exists for them. The frontend transparently substitutes commandPaletteBinding = 'Ctrl+K' in that case, so the experience is byte-identical to v0.30.0. The single new migration is additive (CREATE TABLE IF NOT EXISTS); no existing rows are mutated. 16 new vitest cases cover the parser/matcher/recorder edge cases.",
      },
    ],
  },
  {
    version: "0.30.0",
    subtitle:
      "Web Browser Sessions and VDI Desktop Containers — runtime delivery (rustguac parity, Shipped)",
    sections: [
      {
        title: "Web Sessions and VDI go live end-to-end",
        description:
          "v0.30.0 ships the live runtime spawn for both new connection protocols whose foundation landed in v0.29.0. Connecting to a `web` connection now actually spawns Xvnc + Chromium and tunnels them through guacd; connecting to a `vdi` connection now actually launches the Strata-managed Docker desktop container, attaches it to the compose-prefixed `guac-internal` network, and tunnels its xrdp through guacd. The roadmap items `protocols-web-sessions` and `protocols-vdi` move from In Progress to Shipped. Drop-in upgrade from v0.29.0 — no new database migrations.",
      },
      {
        title: "Web runtime — Xvnc + Chromium spawn pipeline",
        description:
          "New backend/src/services/web_runtime.rs ties the v0.29.0 foundation modules together into a single WebRuntimeRegistry::ensure call invoked from the tunnel route: allocate display + CDP port, write the per-profile Login Data autofill row (encrypted with Chromium's per-profile AES-128-CBC key), spawn Xvnc and wait for it to bind, spawn Chromium with the kiosk argv builder from v0.29.0, detect immediate-exit crashes, run the configured login script over CDP for SSO redirect handling, and register the handle so reconnects against the same connection-and-user reuse the live process pair. The kiosk's framebuffer geometry now matches the operator's actual browser window dimensions (window_width / window_height threaded through ChromiumLaunchSpec and WebSpawnSpec) so the Chromium tab fills the operator's viewport edge-to-edge with no letterboxing.",
      },
      {
        title: "VDI runtime — bollard-backed DockerVdiDriver",
        description:
          "New backend/src/services/vdi_docker.rs implements the VdiDriver trait against bollard 0.18 with default features so the unix-socket transport is available. ensure_container is idempotent: the deterministic name strata-vdi-{conn[..12]}-{user[..12]} lets a re-open of the same connection-and-user pair land on the same running container, preserving persistent home and ephemeral-but-sticky session state. The driver attaches new containers to the operator-configurable network (see Network resolution below) and writes a vdi_containers bookkeeping row so the reaper can find orphans across backend restarts.",
      },
      {
        title: "Auto-provisioned ephemeral RDP credentials for VDI",
        description:
          "Operators no longer have to populate username and password on a VDI connection row. When the credential cascade resolves to no password, the tunnel route now calls vdi::ephemeral_credentials(strata_username) which returns a sanitised POSIX username (deterministic per Strata user) and a fresh 24-character alphanumeric password. Both are injected into the spawned container as VDI_USERNAME and VDI_PASSWORD; xrdp inside the container authenticates against that env-var pair, so every VDI session gets a fresh password without any operator interaction. The frontend SessionClient.tsx RDP prompt branch is updated to skip the credentials dialog for vdi — users never see 'enter your credentials' for an internally managed account.",
      },
      {
        title: "VDI admin tab and Compose overlay sticky-form",
        description:
          "New admin tab (frontend/src/pages/admin/VdiTab.tsx) exposes vdi_image_whitelist (newline- or comma-separated, # comments) and max_vdi_containers via the generic PUT /api/admin/settings endpoint, registered alongside the other tabs in AdminSettings.tsx with a threat-model reminder linking to docs/vdi.md. The .env and .env.example files now ship and document a COMPOSE_FILE shortcut so plain `docker compose ...` commands automatically apply docker-compose.vdi.yml — without it, operators had to spell out both -f flags every command or risk silently dropping the docker.sock mount and the STRATA_VDI_ENABLED flag.",
      },
      {
        title: "Three runtime hot-fixes shipped in this release",
        description:
          "Three issues surfaced during live integration. (1) docker.sock permission: the backend runs as the unprivileged strata user via gosu, but Docker Desktop on Windows mounts /var/run/docker.sock inside containers as srw-rw---- root:root, and bollard's connect_with_defaults is lazy so startup looks fine but every real request fails with `Error in the hyper legacy client: client error (Connect)`. backend/entrypoint.sh now stats the socket at runtime and either creates a docker-host group with the socket's GID and adds strata to it (Linux distros) or chgrp + chmod g+rw the bind-mount in place (Docker Desktop). (2) Compose-prefixed network: docker compose prefixes networks with the project name, so the network the rest of the stack joins is strata-client_guac-internal, not guac-internal — every ensure_container failed with 404. New STRATA_VDI_NETWORK env var defaulted in docker-compose.vdi.yml to ${COMPOSE_PROJECT_NAME:-strata-client}_guac-internal. (3) xrdp TLS / dynamic-resize: the sample VDI image uses a per-container self-signed cert that Strata never trusts, and its display-update channel drops the RDP session on resize storms — the tunnel handler now forces ignore-cert=true, security=any, and resize-method='' for vdi protocol only. The frontend display layer continues to scale the fixed framebuffer to fit the viewport client-side, so users see a letterbox / scale rather than a disconnect.",
      },
      {
        title: "Audit events wired live, in-app docs updated",
        description:
          "The action-type strings declared as fixed contracts in v0.29.0 are now actually emitted by the runtime: web.session.start, web.session.end, web.autofill.write, vdi.container.ensure, vdi.container.destroy, vdi.image.rejected. The /docs page in the admin UI gains two dedicated left-rail entries — Web Sessions and VDI Desktop — wired to the rewritten docs/web-sessions.md and docs/vdi.md (architecture diagrams, full extras schema tables, ephemeral-credentials flow, reaper classification, network override, audit contract). docs/architecture.md gains an Extended protocols section diagramming both spawn pipelines; docs/security.md gains a full extended threat model; docs/api-reference.md documents the audit events and the GET /api/admin/vdi/images endpoint.",
      },
    ],
  },
  {
    version: "0.29.0",
    subtitle:
      "Foundation for Web Browser Sessions and VDI Desktop Containers (rustguac parity, runtime spawn deferred)",
    sections: [
      {
        title: "Two new connection protocols — `web` and `vdi`",
        description:
          "v0.29.0 lands the foundation for two new connections.protocol values. `web` publishes a controlled, tunnelled Chromium kiosk pointed at a single internal web app (think: an internal admin console behind a jumphost), tunnelled as VNC. `vdi` ships a Strata-managed Linux desktop container running xrdp, tunnelled as RDP, with optional persistent home and idle-timeout reaping. Both protocols are selectable in the connection editor today and reuse the existing recording / clipboard / file-browser / credential-mapping pipelines unchanged. The actual runtime spawn (Xvnc + Chromium for `web`, the bollard-backed DockerVdiDriver for `vdi`) is intentionally deferred to a follow-up release; both roadmap items remain marked In Progress in the admin UI.",
      },
      {
        title: "`web` protocol — allocator, egress guard, Chromium argv builder",
        description:
          "New backend/src/services/web_session.rs ships a thread-safe X-display allocator (:100–:199, 100-session cap per replica), the typed connections.extra schema (url / allowed_domains / login_script), the CIDR egress allow-list with fail-closed-on-empty semantics and all-resolved-IPs-must-pass for DNS hosts (defence against DNS rebinding via mixed A records), and the kiosk argv builder mirroring rustguac (--kiosk, ephemeral --user-data-dir, --host-rules for domain restriction, and crucially --remote-debugging-address=127.0.0.1 so the CDP socket is bound to localhost only and can never be reached from the network). Two new dependencies: ipnet 2 and url 2. 20 new unit tests cover the allocator, config edge cases, CIDR matching, host-lookup behaviour, and the kiosk argv emission.",
      },
      {
        title:
          "`vdi` protocol — driver trait, image whitelist, deterministic naming, env injection",
        description:
          "New backend/src/services/vdi.rs ships an async VdiDriver trait with a NoopVdiDriver stub, the typed VdiConfig view (image / cpu_limit / memory_limit_mb / idle_timeout_mins / env_vars / persistent_home), reserved-key stripping (VDI_USERNAME and VDI_PASSWORD are silently dropped from operator env_vars so the runtime always wins), the operator-managed ImageWhitelist parser with strict-equality matching (no glob, no tag substitution — pinning is a security feature), deterministic per-(connection, user) container naming for persistent-home reuse, and the xrdp WTSChannel disconnect classifier with should_destroy_immediately() so the future reaper has a deterministic input. 16 new unit tests cover all of the above.",
      },
      {
        title: "Admin UI, icons, badges, and a new admin endpoint",
        description:
          "The connection editor (connectionForm.tsx) gains WebSections (URL / allowed-domains / login-script) and VdiSections (image dropdown / CPU / memory / idle-timeout / env-vars / persistent-home), wired through AccessTab.tsx with port defaults 5900 (web) and 3389 (vdi). The image dropdown is populated from the new GET /api/admin/vdi/images endpoint exposing the operator-managed whitelist. New globe icon for `web` and stacked-container icon for `vdi` light up the dashboard tile grid and the command palette protocol filter. New protocol badges in the active-sessions and recordings pages with matching unit-test coverage. All 1192+ existing frontend tests continue to pass.",
      },
      {
        title: "Documentation — operator runbooks and extended threat model",
        description:
          "New runbooks at docs/web-sessions.md and docs/vdi.md cover when-to-use, architecture diagrams, the connections.extra schemas, the egress allow-list semantics, the image whitelist semantics, the reaper disconnect classification, and the planned audit events (web.session.start / web.session.end / web.autofill.write / vdi.container.ensure / vdi.container.destroy / vdi.image.rejected — strings are fixed now so the operator-facing contract is stable). docs/architecture.md gains an Extended protocols section. docs/security.md gains a Web Sessions and VDI extended threat model covering SSRF defence, profile reuse, autofill secrecy, CDP localhost-only binding, the docker.sock host-root warning, image-whitelist strictness, the reserved env-key rule, the reaper semantics, and the per-replica concurrency caps. docs/api-reference.md documents the new admin endpoint.",
      },
      {
        title: "What's deliberately NOT in v0.29.0",
        description:
          "The live `web` runtime (Xvnc + Chromium spawn, Chromium Login Data SQLite autofill writer with PBKDF2-SHA1 / AES-128-CBC v10 prefix, CDP login-script runner, web→vnc tunnel-handshake selector translation, max_web_sessions cap) is deferred — it needs Dockerfile package additions and a sandboxing review. The live `vdi` runtime (DockerVdiDriver via bollard, ensure_container reuse-by-name, persistent-home bind mount, idle reaper extension to services/session_cleanup.rs, contrib/vdi-sample/Dockerfile, opt-in /var/run/docker.sock mount in docker-compose.yml — that mount grants host root, hence opt-in — and the max_vdi_containers cap) is deferred to its own release because the docker.sock decision is an explicit operator opt-in, not a default-on capability. The audit-event wiring lands alongside the live spawn so each event is exercised end-to-end before it ships.",
      },
      {
        title: "No migrations, no API contract changes",
        description:
          "The two new connection types reuse the existing connections.extra JSONB column and the existing audit / recording / credential-mapping pipelines. No database migrations. No API-contract changes for existing protocols. Drop-in upgrade from v0.28.x. The roadmap items protocols-web-sessions and protocols-vdi remain marked In Progress in the admin UI — choosing the protocol in the connection editor today will let you save a row, but the live spawn is not in this release.",
      },
    ],
  },
  {
    version: "0.28.0",
    subtitle: "End-to-end H.264 GFX passthrough — no server-side transcode",
    sections: [
      {
        title: "RDP H.264 frames now stream straight to the browser",
        description:
          "v0.28.0 ships full rustguac-parity H.264 passthrough. RDP H.264 GFX frames now travel FreeRDP 3 → guacd → WebSocket → the browser's WebCodecs VideoDecoder without any server-side decode/re-encode step. The legacy bitmap path (PNG/JPEG/WebP tile transcode) is bypassed entirely when the RDP host has AVC444 enabled. On Windows targets configured for AVC444 + hardware encoding, expect roughly an order-of-magnitude bandwidth reduction over the bitmap path and meaningfully crisper text rendering during rapid window animations. The cross-frame ghost class that the v0.27.0 Refresh Rect mitigation targeted simply cannot occur with a passthrough decoder, so the in-session ghost-recovery path has been retired.",
      },
      {
        title: "New guacd patch + vendored 1.6.0 Guacamole client",
        description:
          "guacd/patches/004-h264-display-worker.patch is now a byte-identical port of upstream sol1/rustguac's H.264 display-worker patch (SHA 7a13504c…). It hooks FreeRDP's RDPGFX SurfaceCommand callback, queues AVC NAL units on each guac_display_layer, and emits them as a custom 4.h264 Guacamole instruction during the per-frame flush. The frontend bundles a vendored guacamole-common-js 1.6.0 (frontend/src/lib/guacamole-vendor.js) which is the first upstream version with H264Decoder, the 4.h264 opcode handler, and the waitForPending sync gate. Every existing import Guacamole from 'guacamole-common-js' resolves through the existing Vite alias, so no application code changed.",
      },
      {
        title: "Backend RDP defaults match rustguac",
        description:
          "backend/src/tunnel.rs full_param_map() now seeds the full RDP defaults block required for AVC444 negotiation: color-depth=32, disable-gfx=false, enable-h264=true, force-lossless=false, cursor=local, plus the explicit enable-* / disable-* toggles FreeRDP's settings.c requires (empty ≠ 'false' in many guacd code paths). The per-connection extras allowlist was extended with disable-gfx, disable-offscreen-caching, disable-auth, enable-h264, force-lossless and the related GFX toggles so the admin UI can drive them per connection.",
      },
      {
        title: "Disable H.264 codec checkbox is no longer dead",
        description:
          "The toggle introduced in v0.26.0 was wired to enable-gfx-h264 — a parameter name guacd does not recognise — so checking it had no effect. It is now bound to the correct enable-h264 parameter and honoured by the backend allowlist. The Color Depth dropdown's Auto option has also been relabelled to 'Default (32-bit, required for H.264)' and the lower-bit options now explicitly annotate that they disable H.264, so admins are not surprised when a 16-bit choice silently degrades them to RemoteFX.",
      },
      {
        title: "Configure-RdpAvc444.ps1 — Windows host helper script",
        description:
          "docs/Configure-RdpAvc444.ps1 is a read-first PowerShell helper that inspects the current Terminal Services and Terminal Server\\WinStations registry values, detects whether the host has a usable hardware GPU (filtering out Microsoft Basic Display / Hyper-V synthetic / RemoteFX adapters), reports the diff between current and recommended settings, and prompts before applying any change. It conditionally skips the GPU-only keys on hosts without a real GPU, prints the Event Viewer path for post-reboot verification (Event ID 162 = AVC444 active, 170 = HW encoding active), and offers an opt-in reboot at the end. Idempotent — re-running on an already-correct host is a no-op.",
      },
      {
        title: "New operator runbook: docs/h264-passthrough.md",
        description:
          "Covers the end-to-end pipeline (FreeRDP → guacd patch → WebCodecs), how to verify H.264 is actually flowing across four layers in priority order (Windows Event Viewer = authoritative, guacd logs, WebSocket trace, client._h264Decoder.stats()), the Windows host prerequisites the helper script automates, and a decision matrix for hosts without a hardware GPU (when software AVC is worth running vs when to keep the bitmap path).",
      },
      {
        title: "Known limitation: Chrome DevTools-induced ghosting",
        description:
          "DevTools open in Chromium-based browsers can produce visible ghosting that resembles a codec problem but is not. Chrome throttles GPU-canvas compositing and requestAnimationFrame cadence on tabs whose DevTools panel is open; cached tile blits fall behind the live frame stream and the user perceives ghosting. Closing DevTools (or detaching it to a separate window) restores normal compositor behaviour. If client._h264Decoder?.stats() shows framesDecoded > 0 and the canvas still ghosts, DevTools is the most likely cause.",
      },
      {
        title: "No migrations, no API contract changes",
        description:
          "Drop-in upgrade. The previously-shipped per-connection extras column accepts the corrected enable-h264 key without any migration. The v0.27.0 004-refresh-on-noop-size.patch is superseded by 004-h264-display-worker.patch; on first deploy the guacd image rebuilds against the new patch automatically.",
      },
    ],
  },
  {
    version: "0.27.0",
    subtitle: "In-session recovery from H.264 rendering corruption",
    sections: [
      {
        title: "Refresh Display now fixes the overlapping-window ghost",
        description:
          "v0.26.0 documented a class of rendering corruption where rapid window minimise/maximise cycles left multiple overlapping window states on the canvas, recoverable only by clicking Reconnect. v0.27.0 ships an in-session fix: our forked guacd now intercepts a no-op Guacamole size instruction (dimensions matching the current remote desktop) and sends an RDP Refresh Rect PDU to the RDP server, which on Windows servers triggers a fresh H.264 IDR keyframe and resets the decoder's reference chain. The Session Bar's Refresh Display button now drives this path — one click, no reconnect, no black-screen flash.",
      },
      {
        title: "Server-dependent behaviour, safe fallbacks remain",
        description:
          "MS-RDPEGFX specifies Refresh Rect as valid in GFX mode but does not mandate that servers emit an IDR in response. On Windows 10/11 and Windows Server 2019/2022 the ghost clears within one frame; on non-Microsoft or legacy RDP targets the PDU may be a no-op. Reconnect (full session reset) and the per-connection Disable H.264 codec toggle (shipped in v0.26.0) remain available as fallbacks, and a 1-second per-session cooldown in the patch prevents any possibility of flood conditions.",
      },
      {
        title: "Zero wire-protocol change, zero new opcodes",
        description:
          "The fix is implemented as a guacd patch (guacd/patches/004-refresh-on-noop-size.patch) plus a frontend wire-up — not a new Guacamole protocol opcode. That means stock guacamole-common-js keeps working unchanged and the frontend change is safe to run against an un-patched guacd (stock guacd silently ignores the no-op resize, the frontend's compositor nudge still fires). No migrations. No API-contract changes.",
      },
    ],
  },
  {
    version: "0.26.0",
    subtitle: "Security, audit & reliability hardening sweep",
    sections: [
      {
        title: "Input latency eliminated under bitmap bursts",
        description:
          "The single biggest user-facing fix in v0.26.0. The WebSocket tunnel used to call ws.send().await inline inside the guacd→browser select arm, so under a burst of draw instructions (e.g. Win+Arrow window snap) browser-side backpressure would block the arm and starve the ws.recv() input path — producing the classic rendering freeze, mouse-acceleration feel, and keyboard lag symptoms. The fix splits the WebSocket into sink + stream, moves the sink behind a bounded mpsc channel owned by a dedicated writer task, and coalesces display.onresize storms on the frontend so input latency is now independent of output-path backpressure.",
      },
      {
        title: "Known issue: H.264 rendering corruption — new opt-out toggle",
        description:
          "Some RDP hosts can desynchronise FreeRDP 3's H.264 reference-frame chain during rapid window minimise/maximise cycles, leaving overlapping window states visible on the canvas. No client-side operation recovers this — the in-browser decoder state is corrupt. Workarounds: click Reconnect in the Session Bar to reset the codec state on both ends, or (for connections that hit this regularly) tick the new Disable H.264 codec checkbox under Admin → Connection → Display to fall back to the RemoteFX codec. A proper fix shipping in v0.27.0 will patch guacd to expose RDP's Refresh Rect PDU so an in-session keyframe refresh can clear the corruption without a full reconnect.",
      },
      {
        title: "Share tokens now respect connection soft-deletes",
        description:
          "Before v0.26.0, a share link minted against a connection that was subsequently soft-deleted would continue resolving. find_active_by_token now JOINs connections and filters soft_deleted_at IS NULL, so a deleted connection's shares stop working the moment the delete commits.",
      },
      {
        title: "Brute-force isolation on shared tunnel rate-limit",
        description:
          "The rate-limit overflow path used to call map.clear(), letting an attacker spamming unique tokens reset every legitimate token's counter. It now does a two-step LRU eviction: drop expired-window entries first, then only if still over the cap evict the oldest-attempt entries. Real users' rate-limit state is unaffected by noise.",
      },
      {
        title: "New audit events for share & self-service paths",
        description:
          "connection.share_rate_limited, connection.share_invalid_token (with SHA-256-prefix token fingerprint + client IP), plus user.terms_accepted, user.credential_mapping_set/removed, checkout.retry_activation, checkout.checkin — self-service mutations that were previously silent now leave an audit trail.",
      },
      {
        title: "Vault error sanitization",
        description:
          "Vault server-error bodies and transport-error details are now logged at tracing::debug! only; API callers see a generic 'Vault <status>' / 'Vault request transport error' message. No more raw Vault JSON leaking through to the client on a misconfigured instance.",
      },
      {
        title: "Tunnel overflow emits a proper error frame",
        description:
          "When guacd sends an instruction larger than the pending-byte ceiling, the tunnel used to silently call pending.clear(). It now dispatches Guacamole error '…' '521' to the websocket and closes the stream cleanly, so clients see exactly why the session ended.",
      },
      {
        title: "Indexed email retry sweep (migration 056)",
        description:
          "The retry worker's SELECT … WHERE status='failed' AND attempts<3 ORDER BY created_at query went from a seq-scan over all deliveries to an indexed lookup of the small retryable subset via a new partial index. The index stays tiny because the retryable population is tiny.",
      },
      {
        title: "Settings cache TTL: 30 s → 5 s",
        description:
          "Operator toggles (feature flags, branding, SMTP enable) now propagate in ≤5 seconds across replicas, while the cache still absorbs the hot-path read burst from auth middleware. A pg NOTIFY-based invalidator remains on the roadmap for zero-staleness.",
      },
      {
        title: "Notifications tab — test-send template picker & real-settings preview",
        description:
          "The SMTP test-send panel gained a dropdown letting admins dry-run any of the real notification templates against their live relay. The preview now uses the live tenant_base_url and branding_accent_color so links and colours reflect the operator's actual config. Subject is prefixed with [TEST] so previews can't masquerade as real notifications.",
      },
      {
        title: "Port & TLS dropdowns are bidirectionally symmetric",
        description:
          "Picking a canonical port (25 / 465 / 587) now also snaps the TLS mode to the conventional pairing (port 465 → Implicit TLS, 587 → STARTTLS), mirroring the pre-existing TLS-mode-snaps-port behaviour. The two dropdowns can no longer drift into nonsensical combinations.",
      },
      {
        title: "SMTP password update is a discriminated union",
        description:
          "Frontend callers now pass password: { action: 'keep' | 'clear' | { action: 'set', value } } instead of the ambiguous undefined | '' | string. The wire format is unchanged — the API client serializes back at the request boundary.",
      },
    ],
  },
  {
    version: "0.25.2",
    subtitle: "Admin → Notifications tab — the SMTP configuration UI",
    sections: [
      {
        title: "Configure SMTP from the Admin UI",
        description:
          "The v0.25.0 release notes mentioned an admin SMTP UI that hadn't actually shipped — only the backend endpoints were in place. v0.25.2 delivers the real thing: a new Notifications tab under Admin Settings with the full relay configuration surface (host, port, TLS mode, username, From address, From name, brand accent colour), gated on Manage System.",
      },
      {
        title: "Vault-Aware Password Field",
        description:
          'Because the SMTP password is sealed in Vault server-side, the UI never shows the stored value. Instead, an empty input with a "•••••••• (sealed in Vault)" placeholder appears when a password is on file. A "Keep existing" button discards your edit; a "Clear" button (shown only when a value exists and you haven\'t started typing) removes the stored password on save. Three-state PUT semantics wire this end-to-end — undefined keeps, empty string clears, any other value replaces.',
      },
      {
        title: "Send Test Email & Deliveries Table",
        description:
          "A dedicated test-send panel round-trips through the live SmtpTransport using the saved settings and surfaces the actual SMTP response on error (connection refused, 550 rejected, certificate problems — all verbatim). Below it, the last 50 rows of email_deliveries are shown with a status filter (Queued / Sent / Failed / Bounced / Suppressed), attempt counts, and last-error tooltips — the same data the backend has been recording since v0.25.0 but previously observable only via curl.",
      },
      {
        title: "No Migrations, No API Changes",
        description:
          "Pure UI-layer addition on top of the v0.25.0 backend routes. Drop-in upgrade; nothing to run on the database side.",
      },
    ],
  },
  {
    version: "0.25.1",
    subtitle: "RDP display-refresh patch & zero-warning backend build",
    sections: [
      {
        title: 'RDP "Screen Clipping" Fix',
        description:
          "Some RDP users saw a stale rectangle of pixels remain visible after minimising and restoring the remote window, until they manually resized the browser. v0.25.1 introduces forceDisplayRepaint() — a sub-pixel scale nudge (baseScale + 1e-4) that the compositor treats as a transform change, invalidating every cached tile and forcing a full repaint of the guacamole-common-js display layers. Auto-scheduled at 50 / 200 / 500 ms after every display.onresize so the common minimise/restore/full-screen-toggle cases self-heal with no user action.",
      },
      {
        title: 'Manual "Refresh Display" Button',
        description:
          "For rarer edge cases (GFX pipeline stalls, out-of-order H.264 frames on flaky networks), a Refresh display button on the Session Bar gives users a one-click recovery path. The control only appears for sessions that publish the refresh helper — historical recording playback is unaffected.",
      },
      {
        title: "Zero-Warning Backend Release Build",
        description:
          "The 16 unused_imports / dead_code warnings from the v0.25.0 notification pipeline build have been eliminated. API surface reserved for future admin-UI work now carries targeted #[allow(dead_code)] annotations with rationale comments pointing to the consuming phase. cargo check --bin strata-backend --all-targets now reports 0 warnings, 0 errors.",
      },
      {
        title: "No Schema or API Changes",
        description:
          "Pure drop-in patch. GuacSession gained an optional refreshDisplay?: () => void field used only by in-memory frontend code. No migrations, no new endpoints, no breaking changes.",
      },
    ],
  },
  {
    version: "0.25.0",
    subtitle: "Modern Managed-Account Notification Emails",
    sections: [
      {
        title: "Mobile-Friendly HTML Emails for Checkout Events",
        description:
          "Strata now sends polished MJML-authored HTML emails for the four key managed-account checkout events — pending approval, approved, rejected, and self-approved (audit notice). Every message ships as multipart/related with a plain-text alternative and the Strata logo inlined as cid:strata-logo, tested across Gmail, Outlook, and Apple Mail.",
      },
      {
        title: 'Outlook Dark-Mode "Haze" Fixed',
        description:
          'Outlook desktop\'s dark-mode engine inverts bgcolor attributes, producing a visible lighter rectangle over HTML emails. v0.25.0 ships a reusable wrap_for_outlook_dark_mode helper that injects the VML namespace, a <v:background fill="t"> conditional block, and an Outlook-only stylesheet. VML backgrounds are immune to the inversion engine, so the result is a clean dark-themed email even in Outlook desktop dark mode. Future templates inherit the fix automatically.',
      },
      {
        title: "SMTP Password Is Vault-Only",
        description:
          "The new SMTP routes hard-require the relay password to live in Vault. PUT /api/admin/notifications/smtp refuses to save credentials when Vault is sealed or running in stub mode — SMTP credentials granting outbound mail are a high-value target and must never sit in plaintext on disk.",
      },
      {
        title: "Per-User Opt-Out with Audit Trail",
        description:
          "New users.notifications_opt_out boolean column. When set, the dispatcher suppresses all transactional messages for that user and records each suppression as a notifications.skipped_opt_out audit event. Self-approved audit notices intentionally bypass the flag — they exist for security visibility, not user convenience.",
      },
      {
        title: "Retry Worker with Exponential Backoff",
        description:
          "A background email retry worker (30 s tick, 60 s warm-up, 120 s per-attempt budget) re-attempts transient SMTP failures with exponential backoff and abandons rows after 3 attempts. Permanent 5xx failures are not retried.",
      },
    ],
  },
  {
    version: "0.24.0",
    subtitle: "Quick Share Permission & Unified Connection-Creation Role",
    sections: [
      {
        title: "New can_use_quick_share RBAC Flag",
        description:
          "The in-session Quick Share feature (ephemeral file upload / share-link) is now gated by a dedicated permission. The Quick Share button on the Session Bar and the POST /api/files/upload endpoint both respect it. Administrators (can_manage_system) retain full access.",
      },
      {
        title: 'Unified "Create Connections" Permission',
        description:
          "can_create_connections and can_create_connection_folders have been consolidated into a single can_create_connections flag. Users who can create connections can also organise them into folders — no more two checkboxes for the same mental model.",
      },
      {
        title: "Non-Breaking Migration",
        description:
          "Migration 054 OR's the old folder flag into the unified flag before dropping the column, so no existing role loses capability. Every existing role is also granted can_use_quick_share = true at upgrade time to preserve prior behaviour; administrators can restrict the feature to a subset of roles afterwards via Admin → Access → Roles.",
      },
      {
        title: "API Payload Change",
        description:
          "All role / user payloads now emit can_use_quick_share in place of can_create_connection_folders. External API consumers should update their field mappings accordingly.",
      },
    ],
  },
  {
    version: "0.23.1",
    subtitle: "Admin Settings Refactor & Compliance Tracker Retired",
    sections: [
      {
        title: "AdminSettings.tsx No Longer a Monolith",
        description:
          "The 8,402-line AdminSettings.tsx has been split into one module per tab under frontend/src/pages/admin/ (Security, Network, Display, SSO, Kerberos, Recordings, Vault, Tags, Health, Sessions, Passwords, AD Sync, Access). Shared connection-form helpers (Section, FieldGrid, RdpSections, SshSections, VncSections) moved to admin/connectionForm.tsx; shared RDP keyboard layouts to admin/rdpKeyboardLayouts.ts. The parent is now a 258-line dispatcher — a net reduction of 8,144 lines with zero behavioural changes. All 1,162 frontend tests pass green.",
      },
      {
        title: "Faster Reviews, Smaller Edits, Lower HMR Cost",
        description:
          "Each admin tab is now reviewed and tested in isolation. Touching the Vault tab no longer churns the whole file, Vite HMR only reloads the affected tab, and the directory layout is self-documenting for onboarding engineers.",
      },
      {
        title: "Compliance Tracker Retired — 62 / 62 Items Closed",
        description:
          "docs/compliance-tracker.md has been deleted after reaching 62 of 62 items across Waves 0–5. The artefacts it produced remain in their permanent homes: seven ADRs under docs/adr/ (rate limiting, CSRF, feature flags, guacd model, JWT/refresh, Vault envelope, emergency bypass), five runbooks under docs/runbooks/, and the architecture baseline in docs/adrs/0001-architecture-baseline.md.",
      },
      {
        title: "No Migrations, No Config Changes",
        description:
          "v0.23.1 is a pure refactor + documentation release. No schema changes, no settings changes, no restart-required semantics. The Rust 1.95 / React 19 / TypeScript 6 toolchain from v0.23.0 is unchanged.",
      },
    ],
  },
  {
    version: "0.23.0",
    subtitle: "Dependency Modernization — Rust 1.95, axum 0.8, React 19, TypeScript 6",
    sections: [
      {
        title: "Backend on Rust 1.95 and axum 0.8",
        description:
          "The Rust toolchain is bumped from 1.94 to 1.95 and every major backend dependency has moved to its current release — axum 0.7 → 0.8, axum-extra 0.9 → 0.12, tower 0.4 → 0.5, tower-http 0.5 → 0.6, rand 0.9 → 0.10, sha2 0.10 → 0.11, hmac 0.12 → 0.13. No API shape, wire format, or configuration changes: every one of the 817 backend tests passes on the new stack.",
      },
      {
        title: "Frontend on React 19 and TypeScript 6",
        description:
          "React is bumped from 18 to 19, react-router-dom from 6 to 7, and TypeScript from 5 to 6. All 1162 Vitest tests pass and the production build is clean. The new react-hooks 7 compiler-aware rules (set-state-in-effect, immutability, purity, refs) are enabled at warn level so they ride alongside the existing lint backlog until a dedicated cleanup sweep promotes them to errors.",
      },
      {
        title: "Hardened cargo-audit Configuration",
        description:
          "audit.toml has moved from backend/audit.toml to backend/.cargo/audit.toml — the canonical discovery path. The previous location was silently ignored by cargo-audit, meaning CI was fail-opening on the three RUSTSEC advisories we explicitly suppressed with justifications. The ignore list itself is unchanged; the file is now actually read.",
      },
      {
        title: "Container Base Image Refresh",
        description:
          "The backend runtime and guacd images are unified on alpine:3.23 (from 3.21 / 3.22), and the frontend builder moves to node:25-alpine. Trivy CRITICAL/HIGH scans are clean on every rebuilt image.",
      },
    ],
  },
  {
    version: "0.22.0",
    subtitle: "Data Retention Controls, ADRs & On-Call Runbooks",
    sections: [
      {
        title: "Recording Retention Now Deletes DB Rows and Azure Blobs",
        description:
          "The background recordings worker previously only purged local files when a recording aged past recordings_retention_days. As of 0.22.0 each sync pass also deletes the database row and the backing Azure blob (when Azure storage is configured), so retention is now end-to-end. Each pass logs purged_azure, purged_local, and deleted_rows counts for auditability.",
      },
      {
        title: "User Hard-Delete Window is Configurable (Default 90 Days)",
        description:
          "Soft-deleted users were previously hard-deleted after a hardcoded 7 days. That window is now a setting — default 90 days, valid range 1–3650 — editable in Admin Settings → Security → Data Retention. The background cleanup worker applies the value through parameter-bound make_interval(days => $1), so changing the window takes effect on the next pass without a restart.",
      },
      {
        title: "Architecture Decision Records",
        description:
          "Five new ADRs under docs/adr/ capture previously-undocumented decisions: feature-flag strategy (ADR-0003), guacd connection model and protocol allow-list (ADR-0004), JWT + refresh-token session design (ADR-0005), Vault Transit envelope encryption (ADR-0006), and emergency approval bypass + scheduled-start checkouts (ADR-0007).",
      },
      {
        title: "On-Call Runbooks",
        description:
          "Five step-by-step runbooks under docs/runbooks/: Disaster Recovery (RTO ≤ 4h / RPO ≤ 24h), Security Incident Response, Certificate Rotation (ACME + internal CA), Vault Operations (unseal, rotate, rekey), and Database Operations (replica promotion, migration rollback). Each follows the same template and is copy-pasteable.",
      },
    ],
  },
  {
    version: "0.21.0",
    subtitle: "Roadmap Page, Admin-Editable Statuses & Inline Self-Approve Toggle",
    sections: [
      {
        title: "Built-In Product Roadmap",
        description:
          "A new Roadmap section in the documentation menu renders a themed, modern view of proposed features across Recordings, Security & Zero Trust, Auditing, Workflows, and Notifications. Each item shows a coloured status badge (Proposed / Researching / In Progress / Shipped), area tags and a description, with a summary strip totalling items by status.",
      },
      {
        title: "Admins Can Change Roadmap Item Status In-Place",
        description:
          "Administrators with Manage System can update any roadmap item's status using a modern dropdown without leaving the page. Everyone else sees a read-only colour-coded badge. Changes are optimistic with rollback on error and persist server-side as a single JSON blob in system_settings — so statuses survive restarts and are shared across replicas.",
      },
      {
        title: "Self-Approve Toggle Now Editable on Existing Mappings",
        description:
          "The Self-Approve column in Admin → Password Management → Account Mappings now renders the shared modern dropdown. Admins can flip Yes / No directly in the row without deleting and re-creating the mapping. A new PATCH /api/admin/account-mappings/:id endpoint handles the partial update and writes an account_mapping.updated audit entry.",
      },
      {
        title: "CheckedIn Managed Profiles No Longer Attempt Scrambled Logins",
        description:
          'When a managed-account password was voluntarily checked in, the client previously still attempted to authenticate with the now-scrambled credential, producing a confusing "Authentication failure" error and — in some environments — an AD account lockout. The backend connection-info handler now treats any profile whose backing checkout is not Active (or whose checkout has itself expired) the same as a TTL-expired profile, so the SessionClient renewal prompt fires instead of a failed bind.',
      },
    ],
  },
  {
    version: "0.20.2",
    subtitle: "Justification Mandatory for Approval-Required Checkouts",
    sections: [
      {
        title: "Approvers Always See a Written Business Reason",
        description:
          "Any checkout that requires approval (i.e. the user does not have self-approval rights on the mapping) now requires a justification of at least 10 characters. Previously the 10-character floor only applied to Emergency Bypass; now it applies to every approver-visible request. The form shows the requirement inline with a live character counter, and the submit button is disabled until the minimum is met. Self-approving users are unaffected — their comments remain optional.",
      },
    ],
  },
  {
    version: "0.20.1",
    subtitle: "Emergency Bypass — 30-Minute Hard Cap",
    sections: [
      {
        title: "Exposure Window Tightened",
        description:
          "Emergency Approval Bypass checkouts are now hard-capped at 30 minutes, regardless of the duration submitted by the client. The server silently clamps any larger value before the row is written, the checkout form caps the duration input to 30 while the ⚡ Emergency Bypass checkbox is ticked, and an inline warning explains the limit. This reduces the window during which a credential released without approver review is valid.",
      },
    ],
  },
  {
    version: "0.20.0",
    subtitle: "Scheduled Password Release & Emergency Approval Bypass",
    sections: [
      {
        title: "Schedule a Future Password Release",
        description:
          'Request a password checkout that releases at a future moment (1 minute to 14 days ahead) instead of immediately. Perfect for change windows and planned maintenance. The checkout sits in a new "Scheduled" state with no password, no Vault material and no LDAP mutation until the scheduled moment arrives — at which point the backend automatically generates, resets and seals the credential.',
      },
      {
        title: "Emergency Approval Bypass (Break-Glass)",
        description:
          'Administrators can now enable a per-AD-sync-source "Emergency Approval Bypass" toggle. When an incident needs a credential right now and approvers are unreachable, users can tick the ⚡ Emergency Bypass checkbox, provide a 10-character justification, and activate the checkout immediately. Emergency bypass checkouts are hard-capped at 30 minutes to limit exposure while the approver chain is skipped. Every bypass event is flagged, badged with ⚡ Emergency across the UI, and recorded in the audit log as checkout.emergency_bypass for post-incident review.',
      },
      {
        title: "Mutually Exclusive Safeguards",
        description:
          'The checkout form hides the emergency option while scheduling is enabled — emergency means "immediate", scheduled means "future", and they cannot be combined. The submit button label changes dynamically to "Schedule Checkout", "Emergency Checkout" or "Request Checkout" so you always know which path you are on.',
      },
      {
        title: "Single Expiration Worker",
        description:
          "The existing 60-second checkout expiration worker has been extended to also activate due scheduled checkouts. No new background processes, no additional polling. A partial index on scheduled_start_at keeps the due-scan an indexed lookup.",
      },
    ],
  },
  {
    version: "0.19.4",
    subtitle: "Expired Managed Credentials — Inline Renewal & Tunnel Safety",
    sections: [
      {
        title: "Connect Now Prompts for a New Checkout",
        description:
          'Connecting with an expired or checked-in managed credential profile previously failed silently with an "Authentication failure" message. The session view now correctly opens the renewal prompt so you can request a new password without leaving the connection screen.',
      },
      {
        title: "Inline Checkout Request (Approval Required)",
        description:
          'Managed accounts that require administrator approval now show an inline request form (justification + duration) right on the connection screen. After you submit, the session is blocked with a clear "pending administrator approval" message — no need to navigate to the Credentials tab.',
      },
      {
        title: "One-Click Self-Approve & Connect",
        description:
          "If your account has self-approval rights, submitting the form immediately activates the checkout, links it to your profile, and connects — all in a single click.",
      },
      {
        title: "Tunnel Safety Check",
        description:
          "The backend now refuses to open a session when the only credential source is an expired managed profile. This prevents stale credentials from being sent to Active Directory — avoiding failed binds and helping to protect against inadvertent account lockout.",
      },
    ],
  },
  {
    version: "0.19.2",
    subtitle: "Connection Health Checks, Check-In & Migration Resilience",
    sections: [
      {
        title: "Connection Health Checks",
        description:
          "Background TCP probing of every connection's hostname:port every 2 minutes with a 5-second timeout. The Dashboard now displays green/red/gray status dots (online/offline/unknown) next to each connection for at-a-glance operational visibility — no agents required on target machines.",
      },
      {
        title: "Voluntary Checkout Check-In",
        description:
          "Users can now check-in (return) an active password checkout before it expires. Check-in immediately triggers password rotation so the previously issued credentials are invalidated — enabling secure early release of privileged access.",
      },
      {
        title: "Credential Profile ↔ Checkout Link",
        description:
          "Credential profiles can now reference the password checkout they were generated from, enabling automatic cleanup and full traceability between vault profiles and password management checkouts.",
      },
      {
        title: "Migration Resilience (048)",
        description:
          "Added an idempotent repair migration that ensures connection health columns exist even on environments where migration 042 was recorded as applied but the DDL did not take effect. Deployments that already have the columns are unaffected (no-op).",
      },
    ],
  },
  {
    version: "0.19.1",
    subtitle: "DNS Search Domains & Docker DNS Fallback",
    sections: [
      {
        title: "DNS Search Domains",
        description:
          "The Network tab now supports configurable DNS search domains alongside DNS servers. Search domains enable short-name resolution for internal zones (e.g. .local, .dmz.local) — equivalent to the Domains= directive in systemd-resolved on your host OS.",
      },
      {
        title: "Docker DNS Fallback",
        description:
          "Custom DNS configuration now preserves Docker's embedded DNS resolver as a fallback. Existing connections that resolve via public DNS or Docker service discovery continue working without reconfiguration when custom DNS is enabled.",
      },
      {
        title: "Migration Backfill (047)",
        description:
          "A new migration automatically backfills the dns_search_domains setting for instances that already ran migration 046. No manual database changes needed.",
      },
    ],
  },
  {
    version: "0.19.0",
    subtitle: "DNS Configuration, Dynamic Tab Titles & guacd Improvements",
    sections: [
      {
        title: "DNS Configuration (Network Tab)",
        description:
          "A new Network tab in Admin Settings lets you configure custom DNS servers and search domains for guacd containers. Enter your internal DNS server IPs and search domains, save, and restart guacd — no more editing docker-compose.yml for internal hostname resolution (e.g. .local, .dmz.local domains).",
      },
      {
        title: "Dynamic Browser Tab Title",
        description:
          "The browser tab now shows the active session's server name (e.g. \"SERVER01 — Strata\") while connected, making it easy to identify which server you're on when the sidebar is collapsed or switching between browser tabs.",
      },
      {
        title: "guacd Entrypoint Wrapper",
        description:
          "The guacd container now uses a custom entrypoint that applies DNS configuration from a shared volume before starting the daemon, with proper privilege dropping via su-exec.",
      },
    ],
  },
  {
    version: "0.18.0",
    subtitle: "Approval Role Scoping, Approvals Redesign & Decided-By Tracking",
    sections: [
      {
        title: "Approval Role Account Scoping",
        description:
          "Approval roles now use explicit account-to-role mapping instead of LDAP filter matching. Each role is scoped to specific managed AD accounts via a searchable dropdown with chip tags — precise, auditable control over which accounts each approver can approve checkouts for.",
      },
      {
        title: "Approvals Page Redesign",
        description:
          "The Pending Approvals page has been completely redesigned with a premium card layout. Each request card shows the requester's avatar and username, the account CN (with full DN below), formatted duration, and a highlighted justification section. Approve and deny buttons use SVG icons with disabled state during processing.",
      },
      {
        title: "Approver Navigation Visibility",
        description:
          'The "Pending Approvals" sidebar link now only appears for users assigned to at least one approval role. Non-approvers no longer see the link.',
      },
      {
        title: "Decided-By Tracking",
        description:
          'The Checkout Requests table in Admin Settings now shows who approved or denied each request — the approver\'s username, "Self Approved" when the approver is also the requester, or "—" for undecided requests.',
      },
      {
        title: "Bug Fixes",
        description:
          "Fixed managed credential override in tunnel connections, checkout expiry calculation (now computed from approval time), and pending approvals scope enforcement so approvers only see requests for their assigned accounts.",
      },
    ],
  },
  {
    version: "0.17.0",
    subtitle: "Password Management, Connection Health & UI Polish",
    sections: [
      {
        title: "Password Management",
        description:
          "Full privileged account password checkout and rotation for AD-managed accounts. Admins configure approval roles and map AD accounts to Strata users. Users request time-limited password checkouts with inline reveal and countdown timers. Passwords are auto-generated per policy, reset via LDAP, and sealed in Vault — no human ever sees the stored password.",
      },
      {
        title: "AD Sync Password Management Config",
        description:
          "Each AD Sync source now has a collapsible Password Management section: enable/disable PM, choose bind credentials (reuse AD source creds or provide separate PM-specific ones), set the target account LDAP filter, configure password generation policy (length, character requirements), and enable zero-knowledge auto-rotation on a schedule.",
      },
      {
        title: "Target Filter Preview",
        description:
          'A "Preview" button next to the target account filter lets you test your LDAP filter against Active Directory before saving. See a table of matching accounts (name, DN, description) with a total count — no more guessing whether your filter is correct.',
      },
      {
        title: "Connection Health Checks",
        description:
          "All connections are now automatically probed every 2 minutes via TCP. A green, red, or gray status dot on each connection row and recent card shows whether the target machine is online, offline, or not yet checked. Hover for the last check timestamp.",
      },
      {
        title: "Credentials & Approvals Reorganization",
        description:
          '"Request Checkout" and "My Checkouts" have moved from the Approvals page to the Credentials page, consolidating all credential-related actions in one place. The Approvals page now focuses solely on pending approval decisions.',
      },
    ],
  },
  {
    version: "0.16.3",
    subtitle: "Display Tags for Active Sessions",
    sections: [
      {
        title: "Pin a Tag to Session Thumbnails",
        description:
          'You can now assign a single display tag to each connection, visible as a colored badge on session thumbnails in the Active Sessions sidebar. Click the tag icon on any thumbnail to choose from your existing tags, or select "None" to clear it. Display tags are optional and per-user — each user can pick a different tag for the same connection.',
      },
      {
        title: "Tag Picker Dropdown",
        description:
          'A compact dropdown on each session thumbnail shows all your tags with their color swatches. Select a tag to pin it, or choose "None" to remove the badge. The picker closes automatically when you click outside it.',
      },
      {
        title: "Persistent & Synced",
        description:
          "Display tag assignments are saved to the server and persist across sessions and devices. The assignment is per-user per-connection — your display tags won't affect other users.",
      },
    ],
  },
  {
    version: "0.16.2",
    subtitle: "Command Palette, Keyboard Shortcuts & Quick Share Visibility",
    sections: [
      {
        title: "Command Palette (Ctrl+K)",
        description:
          "Press Ctrl+K while connected to any session to open an instant search overlay. Find and launch any connection by name, protocol, hostname, or folder — all from the keyboard. Arrow keys navigate, Enter launches, Escape closes. Active sessions show a green badge.",
      },
      {
        title: "Keyboard Shortcut Proxy",
        description:
          "Ctrl+Alt+` sends Win+Tab (Task View) to the remote session. Right Ctrl acts as the Win key — hold it with another key for Win+combos (Win+E, Win+R, etc.), or tap it alone for the Start menu.",
      },
      {
        title: "Keyboard Lock (Fullscreen + HTTPS)",
        description:
          "In fullscreen mode over HTTPS, OS-level shortcuts (Win, Alt+Tab, Escape) are captured directly by the browser and forwarded to the remote session via the Keyboard Lock API — no proxy keys needed.",
      },
      {
        title: "Conditional Quick Share",
        description:
          "The Quick Share upload button now only appears when the connection has file transfer enabled (drive or SFTP). Connections without file transfer configured no longer show an unusable upload button.",
      },
      {
        title: "Session Bar Keyboard Help",
        description:
          "The Session Bar now includes a keyboard mappings reference showing all available shortcuts: Right Ctrl → Win, Ctrl+Alt+` → Win+Tab, Ctrl+K → Quick Launch, plus tips on fullscreen capture.",
      },
    ],
  },
  {
    version: "0.16.1",
    subtitle: "Multi-Monitor Rendering, Cursor Sync & Layout Improvements",
    sections: [
      {
        title: "Multi-Monitor Rendering Fix",
        description:
          "Secondary monitors now render correctly using the default layer canvas instead of display.flatten(), which allocated a new full-resolution canvas every frame and caused black screens from GC pressure.",
      },
      {
        title: "Cursor Visible on All Monitors",
        description:
          "The remote cursor (arrow, resize handle, text beam, etc.) is now mirrored to all secondary monitor windows in real time via a MutationObserver on the Guacamole display element.",
      },
      {
        title: "Horizontal Layout Only",
        description:
          "All monitors are placed in a flat left-to-right horizontal row regardless of their physical vertical position. The best supported configuration is all landscape monitors side by side. Monitors above or below the primary appear as slices to the right — scroll/move rightward to reach them.",
      },
      {
        title: "Popup Auto-Maximize & Screen Detection",
        description:
          "Secondary popup windows now auto-maximize to fill their target screen. Pop-out windows detect when dragged to a different monitor and re-scale automatically.",
      },
    ],
  },
  {
    version: "0.16.0",
    subtitle: "Security Hardening, Granular RBAC & Multi-Monitor 2D Layout",
    sections: [
      {
        title: "Granular Permission Enforcement",
        description:
          "All admin API endpoints now enforce fine-grained permission checks (manage system, manage users, manage connections, view audit logs, view sessions) instead of a blanket admin role check. Limited-privilege admin users can no longer access endpoints beyond their assigned permissions.",
      },
      {
        title: "Multi-Monitor 2D Layout",
        description:
          "Multi-monitor mode now uses physical screen coordinates to build a true 2D layout, correctly handling stacked, L-shaped, grid, and mixed-resolution monitor arrangements. Previously all screens were forced into a horizontal row regardless of physical placement.",
      },
      {
        title: "Credential Security",
        description:
          "Tunnel tickets now zeroize username and password from memory on drop. The refresh token endpoint re-reads the user's role from the database so role demotions take effect immediately. Tag color values are validated as hex codes on both user and admin endpoints.",
      },
      {
        title: "Non-blocking File I/O",
        description:
          "The session file store now uses fully async I/O (tokio::fs) and releases its lock before performing disk operations, eliminating async runtime blocking during file uploads, downloads, and cleanup.",
      },
      {
        title: "Database Optimizations",
        description:
          "Bulk tag assignment uses a single INSERT ... SELECT unnest() instead of N+1 individual inserts. Role and Kerberos realm updates use a single COALESCE query. Session stats use a single CTE query instead of six separate queries. New indexes on soft-deleted users and connection access.",
      },
      {
        title: "Bug Fixes",
        description:
          "Custom roles with connection management permissions are no longer incorrectly blocked. Deleting or updating a nonexistent tag now returns a proper 404. Two theoretical JSON serialization panics in the auth module have been replaced with proper error handling.",
      },
    ],
  },
  {
    version: "0.15.3",
    subtitle: "Quick Share, Multi-Monitor Fixes & Polish",
    sections: [
      {
        title: "Quick Share",
        description:
          "Upload files from the Session Bar and get a random download URL to paste into the remote session's browser. Files are session-scoped and automatically deleted when the tunnel disconnects. Supports drag-and-drop, up to 20 files per session (500 MB each), and one-click copy-to-clipboard URLs.",
      },
      {
        title: "Multi-Monitor Screen Count",
        description:
          'The multi-monitor button tooltip now shows the number of detected screens (e.g. "Multi-monitor (3 screens detected)"), updating live when monitors are plugged in or out.',
      },
      {
        title: "Multi-Monitor Popup Blocker Fix",
        description:
          "Opening three or more monitors no longer triggers Chrome's popup blocker. The hook now calls getScreenDetails() inside the click handler, extending Chrome's user activation so all secondary windows open successfully.",
      },
      {
        title: "Quick Share Upload Fix",
        description:
          "Large file uploads (over 10 MB) no longer fail with a 413 error. Both the nginx reverse proxy body size limit and the Axum multipart body limit now match the backend's 500 MB cap.",
      },
      {
        title: "Quick Share Delete Fix",
        description:
          'Deleting a Quick Share file no longer throws a "Unexpected end of JSON input" error. The API client now handles empty response bodies correctly.',
      },
      {
        title: "Disclaimer Scroll Fix",
        description:
          'The "I Accept" button on the Session Recording Disclaimer is no longer permanently disabled on screens tall enough to display the full content without scrolling.',
      },
    ],
  },
  {
    version: "0.15.0",
    subtitle: "Multi-Monitor Improvements",
    sections: [
      {
        title: "Brave & Privacy Browser Compatibility",
        description:
          "Multi-monitor mode now works in Brave and other privacy-focused browsers that zero out screen dimensions from the Window Management API. Screen sizes automatically fall back to window.screen values and popup placement uses computed tile offsets.",
      },
      {
        title: "Dynamic Secondary Window Scaling",
        description:
          "Secondary monitor windows now dynamically resize their canvas when the window is resized, stretching the remote desktop slice to fill the available space. The primary monitor preserves 1:1 scale matching the browser viewport.",
      },
    ],
  },
  {
    version: "0.14.9",
    subtitle: "Multi-Monitor Support",
    sections: [
      {
        title: "Browser-Based Multi-Monitor",
        description:
          "Span your remote desktop across multiple physical monitors. Enable multi-monitor mode from the Session Bar and each secondary screen gets its own browser window showing the correct slice of the remote desktop. Mouse and keyboard input works seamlessly across all windows. Requires Chromium 100+ with the Window Management API.",
      },
    ],
  },
  {
    version: "0.14.8",
    subtitle: "Display Resize Fix",
    sections: [
      {
        title: "Remote Display Resize Fix",
        description:
          "Fixed an issue where maximising a window inside a remote desktop session (e.g. RDP) caused the display to become unreadable. The session view now automatically rescales when the remote resolution changes, both in the main window and in pop-out windows.",
      },
    ],
  },
  {
    version: "0.14.7",
    subtitle: "Live Session Sharing & Admin Tags",
    sections: [
      {
        title: "Live Session Sharing",
        description:
          "Share links now show your live session in real time. Viewers see exactly what you see — no separate connection to the server. Control mode lets shared viewers send keyboard and mouse input to your session.",
      },
      {
        title: "Admin Tags",
        description:
          "Administrators can create system-wide tags and assign them to connections. Tags are visible to all users on the Dashboard for easy categorization.",
      },
      {
        title: "Bug Fixes",
        description:
          "Fixed share button not appearing in the Session Bar, 403 errors for non-admin users loading settings, tag dropdowns going off-screen, and recording files not being cleaned up when users are deleted.",
      },
    ],
  },
  {
    version: "0.14.6",
    subtitle: "Terms of Service & NVR Pause",
    sections: [
      {
        title: "Recording Disclaimer",
        description:
          "A mandatory terms-of-service modal is now shown on first login, covering session recording consent, acceptable use, and data protection. Users must scroll through and accept before accessing the application.",
      },
      {
        title: "NVR Play/Pause",
        description:
          "The live session player now has a play/pause button. Pausing freezes the display while the stream stays connected — resume to pick up from the current live point.",
      },
    ],
  },
  {
    version: "0.14.5",
    subtitle: "NVR & Popout Fixes",
    sections: [
      {
        title: "Live Rewind Black Screen Fix",
        description:
          "Rewinding a live session no longer shows a black screen. All rewind durations (30s, 1m, 3m, 5m) now render the target frame instantly.",
      },
      {
        title: "NVR Player Speed Improvements",
        description:
          "The NVR player now defaults to 1× speed, and changing speed during a live session no longer causes an unnecessary reconnect.",
      },
      {
        title: "Popout Window Close Fix",
        description:
          "Closing a popped-out session window now correctly returns you to the session page instead of leaving a white screen.",
      },
    ],
  },
  {
    version: "0.14.4",
    subtitle: "Recording Skip & Speed Controls",
    sections: [
      {
        title: "Skip Forward & Back",
        description:
          "Jump to any point in a recording with skip buttons — 30 seconds, 1 minute, 3 minutes, or 5 minutes forward or back.",
      },
      {
        title: "Playback Speed",
        description:
          "Play recordings at 1×, 2×, 4×, or 8× speed. The speed selector is in the bottom-right of the player controls.",
      },
      {
        title: "Smoother Playback & Seeking",
        description:
          "Recordings no longer freeze during idle periods, and seeking to a position renders instantly instead of showing a black screen.",
      },
    ],
  },
  {
    version: "0.14.3",
    subtitle: "Fullscreen Recordings & User Session Observe",
    sections: [
      {
        title: "Recording Player Fullscreen",
        description:
          "The historical recording player now has a fullscreen button for distraction-free playback. The default modal is also wider for a better viewing experience.",
      },
      {
        title: "Live/Rewind for Your Own Sessions",
        description:
          'Users with the "View own sessions" permission can now use the Live and Rewind buttons on their own active sessions — no admin privileges required.',
      },
    ],
  },
  {
    version: "0.14.2",
    subtitle: "NVR & Sessions Permission Fixes",
    sections: [
      {
        title: "NVR Observer Connection Fix",
        description:
          "Live session observation no longer fails silently when your access token has expired. The player now refreshes the token before connecting and shows clear error messages with a Retry button if something goes wrong.",
      },
      {
        title: "Sessions Sidebar Visibility Fix",
        description:
          'Users with the "View own sessions" role permission can now see the Sessions link in the sidebar. Previously this was hidden because the auth check endpoint was missing the permission field.',
      },
    ],
  },
  {
    version: "0.14.1",
    subtitle: "Credential Renewal & Clipboard Fix",
    sections: [
      {
        title: "Renew Expired Credentials at Connect Time",
        description:
          'When you connect to a session with an expired credential profile, the prompt now shows the expired profile with an "Update & Connect" form. Enter new credentials to renew and connect instantly, or dismiss to enter one-time manual credentials.',
      },
      {
        title: "Popout Clipboard Fix",
        description:
          "Copying text from a remote session in a pop-out window now correctly writes to your local clipboard. Previously the clipboard write was silently denied because it targeted the unfocused main window.",
      },
    ],
  },
  {
    version: "0.14.0",
    subtitle: "Unified Sessions & RBAC",
    sections: [
      {
        title: "Unified Sessions Page",
        description:
          "New dedicated Sessions page in the sidebar combining live session monitoring and recording history into a single tabbed interface. Replaces the old admin-only Active Sessions panel.",
      },
      {
        title: "Role-Based Session Access",
        description:
          'New "View own sessions" permission lets users see their own live sessions and recordings. Admins with Manage System or Audit Logs see all users\' sessions with kill, observe, and rewind controls.',
      },
      {
        title: "Admin Sessions Tab Refined",
        description:
          "The Admin Settings Sessions tab now focuses purely on analytics — stats, charts, leaderboards, and guacd capacity. Live session management has moved to the dedicated Sessions page.",
      },
    ],
  },
  {
    version: "0.13.2",
    subtitle: "Docs, Stability & CI",
    sections: [
      {
        title: "In-App Documentation",
        description:
          "New Docs page in the sidebar with Architecture, Security, and API Reference rendered inline, plus a full release history carousel covering every version back to v0.1.0.",
      },
      {
        title: "Session Idle Timeout Fix",
        description:
          "Active users are no longer logged out after 20 minutes while using remote sessions. The access token now proactively refreshes in the background when activity is detected.",
      },
      {
        title: "Backend CI Fix",
        description:
          "Fixed missing watermark field in five backend test struct initialisers that caused cargo clippy failures in CI.",
      },
    ],
  },
  {
    version: "0.13.1",
    subtitle: "Improvements & Fixes",
    sections: [
      {
        title: "What's New Carousel",
        description:
          "This modal now lets you browse all previous release notes with navigation arrows — no more missing what changed in earlier versions.",
      },
      {
        title: "guacd Scaling Fix",
        description:
          "The GUACD_INSTANCES environment variable is now correctly forwarded to the backend container, so scaled guacd pools are detected on startup.",
      },
      {
        title: "Architecture Docs Refreshed",
        description:
          "Removed stale Caddy references and updated documentation to reflect the current nginx-based gateway with SSL termination and security headers.",
      },
    ],
  },
  {
    version: "0.13.0",
    subtitle: "New Features & Fixes",
    sections: [
      {
        title: "Per-Connection Watermark",
        description:
          "Connections now have their own watermark setting (Inherit / Always on / Always off) that overrides the global toggle, giving admins fine-grained control.",
      },
      {
        title: "Persistent Favorites Filter",
        description:
          "The dashboard favorites toggle now remembers your preference across sessions — no need to re-enable it every time you log in.",
      },
      {
        title: "Clipboard in Popout Windows",
        description:
          "Pasting text copied after a session was popped out now works correctly. The popout window syncs its own clipboard with the remote session.",
      },
    ],
  },
  {
    version: "0.12.0",
    subtitle: "Security Update",
    sections: [
      {
        title: "Enhanced Session Security",
        description:
          "Sessions now use short-lived 20-minute access tokens with automatic silent refresh. A countdown toast warns you 2 minutes before expiry with an option to extend your session.",
      },
      {
        title: "Password Management",
        description:
          "New password policy enforces a minimum of 12 characters. Users can now change their own password, and admins can force-reset passwords from the user management panel.",
      },
      {
        title: "CSP Hardened",
        description:
          "Content Security Policy now blocks inline scripts for stronger XSS protection, with no impact to the application's functionality.",
      },
    ],
  },
  {
    version: "0.11.2",
    subtitle: "Fixes & Modernisation",
    sections: [
      {
        title: "Migration Checksum Auto-Repair",
        description:
          "Deploying after line-ending normalisation no longer causes crash loops. The migrator detects and auto-repairs stale checksums on startup.",
      },
      {
        title: "Role Dropdown Modernised",
        description:
          "The admin user-role dropdown now uses the unified custom Select component with portal rendering and animations, matching all other dropdowns.",
      },
    ],
  },
  {
    version: "0.11.1",
    subtitle: "Role Management & Fixes",
    sections: [
      {
        title: "User Role Management",
        description:
          "Admins can now change a user's role directly from the Users table via an inline dropdown, with audit logging of role changes.",
      },
      {
        title: "Case-Insensitive Login",
        description:
          "SSO and local login now use case-insensitive email and username matching, fixing login failures when providers return differently-cased emails.",
      },
      {
        title: "Session Watermark Visibility",
        description:
          "The session watermark now renders with both dark and light text passes, making it visible over any remote desktop background.",
      },
    ],
  },
  {
    version: "0.11.0",
    subtitle: "Productivity & Analytics",
    sections: [
      {
        title: "Windows Key Proxy (Right Ctrl)",
        description:
          "Hold Right Ctrl + key to send Win+key to the remote session. Tap Right Ctrl alone to open the Start menu. Works in single sessions, tiled view, and pop-outs.",
      },
      {
        title: "Analytics Dashboard",
        description:
          "New admin analytics with daily usage trends, session duration stats, bandwidth tracking, protocol distribution, and peak hours histogram.",
      },
      {
        title: "Dynamic Capacity Gauge",
        description:
          "The guacd capacity gauge now calculates recommended sessions per instance dynamically based on host CPU and RAM.",
      },
    ],
  },
  {
    version: "0.10.6",
    subtitle: "Folder View & Cleanup",
    sections: [
      {
        title: "Folder View Auto-Select",
        description:
          "The dashboard now automatically enables folder view when connections belong to folders, with folders collapsed by default for a cleaner layout.",
      },
      {
        title: "Persistent Folder Preferences",
        description:
          "Folder view toggle and per-folder expand/collapse states are persisted in localStorage so your dashboard layout is remembered across sessions.",
      },
      {
        title: "Recording Form Cleanup",
        description:
          "Removed system-managed recording fields from VNC and AD Sync forms, leaving only the user-configurable options.",
      },
    ],
  },
  {
    version: "0.10.5",
    subtitle: "Session Labels & Test Coverage",
    sections: [
      {
        title: "Session Label Overlay",
        description:
          "Active session thumbnails now display the connection name and protocol as a sleek overlay with a dark gradient and backdrop blur for readability.",
      },
      {
        title: "Backend Test Coverage",
        description:
          "Comprehensive unit test suite for the GuacamoleParser covering Unicode handling, partial data buffering, and malformed input recovery.",
      },
    ],
  },
  {
    version: "0.10.4",
    subtitle: "Pop-Out Stability",
    sections: [
      {
        title: "Pop-Out Session Persistence",
        description:
          "Pop-out windows now survive navigation between the dashboard and session views. State is stored on the session object instead of local React refs.",
      },
      {
        title: "Multi-Session Pop-Out Fix",
        description:
          "Disconnecting one popped-out session no longer causes other pop-out sessions to go black or become unresponsive.",
      },
    ],
  },
  {
    version: "0.10.3",
    subtitle: "Session Redirect Fix",
    sections: [
      {
        title: "Auto-Redirect on Session End",
        description:
          "When a remote session ends and other sessions are still active, the client now automatically redirects to the next active session instead of freezing on a stale screen.",
      },
    ],
  },
  {
    version: "0.10.2",
    subtitle: "Vault Credentials & Recordings",
    sections: [
      {
        title: "One-Off Vault Credentials",
        description:
          "Select a saved vault credential profile directly from the connection prompt for a single session, without permanently mapping it to the connection.",
      },
      {
        title: "NVR Playback Controls",
        description:
          "Session recordings now include a progress bar, speed selector (1×/2×/4×/8×), and server-paced replay with proper inter-frame timing.",
      },
      {
        title: "Per-User Recent Connections",
        description:
          "Connection access history is now tracked per-user, so each user sees only their own recent connections on the dashboard.",
      },
    ],
  },
  {
    version: "0.10.1",
    subtitle: "Stability & Fixes",
    sections: [
      {
        title: "Build Stabilisation",
        description:
          "Resolved critical build-time regressions in both the Rust backend and TypeScript frontend, including CSS syntax and Azure recording streaming.",
      },
      {
        title: "Permission Fixes",
        description:
          "Fixed folder-level permission tunnel access, admin tab visibility for restricted roles, and hardened tunnel ticket creation with comprehensive permission validation.",
      },
    ],
  },
  {
    version: "0.10.0",
    subtitle: "Session Bar & AD Sync Defaults",
    sections: [
      {
        title: "Unified Session Bar",
        description:
          "All session controls (Sharing, File Browser, Fullscreen, Pop-out, On-Screen Keyboard) consolidated into a single sleek right-side dock.",
      },
      {
        title: "AD Sync Connection Defaults",
        description:
          "AD sync sources can now specify default Guacamole parameters (RDP performance flags, recording settings) applied to all synced connections.",
      },
      {
        title: "Connection Parameter Tooltips",
        description:
          "All connection settings now display descriptive hover tooltips sourced from the official Apache Guacamole documentation.",
      },
    ],
  },
  {
    version: "0.9.0",
    subtitle: "Live Sessions & Admin Tools",
    sections: [
      {
        title: "Active Sessions Dashboard",
        description:
          "New real-time admin dashboard for monitoring all active tunnel connections, including bandwidth tracking, duration, and remote host metadata.",
      },
      {
        title: "Administrative Session Kill",
        description:
          "Admins can now terminate any active session directly from the Live Sessions dashboard for instant access revocation.",
      },
      {
        title: "Reconnection Stability",
        description:
          "Overhauled session reconnection logic with 10-second stability thresholds and explicit retry counters to prevent infinite loops on permanent failures.",
      },
    ],
  },
  {
    version: "0.8.0",
    subtitle: "Infrastructure & Security",
    sections: [
      {
        title: "Nginx Gateway",
        description:
          "Removed Caddy reverse proxy. Nginx now handles SSL termination, API/WebSocket proxying, security headers, and automatic HTTP-to-HTTPS redirection.",
      },
      {
        title: "Manual SSL Support",
        description:
          "Mount your own SSL certificates (cert.pem, key.pem) to the certs/ volume for HTTPS without an external proxy.",
      },
      {
        title: "User Restoration",
        description:
          "Administrators can now restore soft-deleted user accounts from the Admin Settings dashboard within the 7-day retention window.",
      },
    ],
  },
  {
    version: "0.7.0",
    subtitle: "RBAC & Folders",
    sections: [
      {
        title: "Granular RBAC Permissions",
        description:
          "Nine role-based permissions for fine-grained access control over system, users, connections, audit logs, and sharing profiles.",
      },
      {
        title: "Connection Folders",
        description:
          "Renamed connection groups to folders across the full stack with CRUD endpoints, collapsible folder headers, and per-folder connection counts.",
      },
      {
        title: "Docker Security Hardening",
        description:
          "Backend and frontend containers now run as non-root users with pre-created directories and correct volume permissions.",
      },
    ],
  },
  {
    version: "0.6.2",
    subtitle: "Test Coverage & Hardening",
    sections: [
      {
        title: "Test Coverage Expansion",
        description:
          "Branch coverage raised from ~55% to 70% across 605 tests. Coverage thresholds enforced: statements 74%, branches 69%, functions 62%, lines 75%.",
      },
      {
        title: "Backend Security Hardening",
        description:
          "Fixed Unicode protocol parsing, NVR instruction filtering, Kerberos temp file handling, OIDC issuer validation, and Content-Disposition header injection.",
      },
    ],
  },
  {
    version: "0.6.1",
    subtitle: "Security & Performance",
    sections: [
      {
        title: "Security Fixes",
        description:
          "Fixed tunnel soft-delete bypass, OIDC issuer validation, shared tunnel pool bypass, and Content-Disposition header injection.",
      },
      {
        title: "AD Sync Bulk Operations",
        description:
          "Replaced individual LDAP-to-DB updates with high-performance bulk upsert and soft-delete queries for faster Active Directory sync.",
      },
    ],
  },
  {
    version: "0.6.0",
    subtitle: "SSO / OIDC",
    sections: [
      {
        title: "SSO / OIDC Support",
        description:
          "Integrated OpenID Connect authentication with Keycloak support, including automatic OIDC discovery and secure client secret storage via Vault.",
      },
      {
        title: "Configurable Auth Methods",
        description:
          "Admins can toggle between Local Authentication and SSO/OIDC in the Security settings, with strict backend enforcement.",
      },
    ],
  },
  {
    version: "0.5.0",
    subtitle: "Active Directory Sync",
    sections: [
      {
        title: "AD LDAP Sync",
        description:
          "Automatic computer account import from Active Directory via LDAP/LDAPS with scheduled background sync, soft-delete lifecycle, and multiple search bases.",
      },
      {
        title: "Multi-Realm Kerberos",
        description:
          "Support for multiple Kerberos realms with dynamic krb5.conf generation, per-realm KDC configuration, and keytab-based authentication for AD sync.",
      },
      {
        title: "Credential Profiles",
        description:
          "Saved credential profiles with optional TTL expiry. Pick a saved profile from the connection card or enter credentials inline.",
      },
    ],
  },
  {
    version: "0.4.0",
    subtitle: "Recordings, Sharing & Scaling",
    sections: [
      {
        title: "Azure Blob Session Recordings",
        description:
          "Session recordings can be synced to Azure Blob Storage with background upload, automatic fallback download, and SharedKey authentication.",
      },
      {
        title: "Control Mode Shares",
        description:
          "Share links now support View (read-only) and Control (full keyboard and mouse) modes with distinct icons and colour badges.",
      },
      {
        title: "guacd Scaling & PWA",
        description:
          "Round-robin connection pool across multiple guacd instances, plus Progressive Web App support with service worker caching and touch toolbar.",
      },
    ],
  },
  {
    version: "0.3.0",
    subtitle: "Live NVR & Organisation",
    sections: [
      {
        title: "Live Session NVR",
        description:
          "In-memory ring buffer captures up to 5 minutes of session activity. Admins can observe live sessions and rewind to see what happened before a support call.",
      },
      {
        title: "Connection Groups & Favorites",
        description:
          "Organise connections into collapsible folder groups. Star/unstar connections for quick access with a favorites filter on the dashboard.",
      },
      {
        title: "Theme Toggle",
        description:
          "Light/dark/system theme toggle in the sidebar with refined dark theme surfaces and premium animated checkboxes.",
      },
    ],
  },
  {
    version: "0.2.0",
    subtitle: "Multi-Session & Vault",
    sections: [
      {
        title: "Multi-Session Tiled View",
        description:
          "Tiled multi-session layout with responsive grid, per-tile focus, Ctrl/Cmd+click multi-focus, and keyboard broadcast to all focused tiles.",
      },
      {
        title: "Clipboard & File Transfer",
        description:
          "Bidirectional clipboard sync, drag-and-drop file upload, in-browser file browser with directory navigation, and RDP virtual drive mounting.",
      },
      {
        title: "Bundled HashiCorp Vault",
        description:
          "Auto-initialised Vault container with Transit envelope encryption, automatic unseal on startup, and setup wizard mode selector.",
      },
    ],
  },
  {
    version: "0.1.0",
    subtitle: "Initial Release",
    sections: [
      {
        title: "Core Platform",
        description:
          "Docker Compose orchestration, custom guacd with FreeRDP 3 and Kerberos support, Rust/Axum backend with PostgreSQL, and React/Vite frontend.",
      },
      {
        title: "Session Management",
        description:
          "WebSocket tunnel to guacd with Guacamole protocol handshake, role-based connection access, dynamic Kerberos config, and session recording.",
      },
      {
        title: "Security Foundation",
        description:
          "Vault Transit envelope encryption (AES-256-GCM) with memory zeroisation, OIDC token validation, SHA-256 hash-chained audit logging, and admin RBAC.",
      },
    ],
  },
];

/* ── Component ─────────────────────────────────────────────────────── */

interface WhatsNewModalProps {
  /** User ID — used to scope dismissal per-user */
  userId: string | undefined;
}

type ModalMode = "welcome" | "whats-new";

export default function WhatsNewModal({ userId }: WhatsNewModalProps) {
  const [visible, setVisible] = useState(false);
  const [mode, setMode] = useState<ModalMode | null>(null);
  const [cardIndex, setCardIndex] = useState(0);

  useEffect(() => {
    if (!userId) {
      if (visible) setVisible(false);
      return;
    }

    // 1. Check if welcome was ever seen
    const welcomeDismissed = localStorage.getItem(`${WELCOME_KEY}-${userId}`);
    if (!welcomeDismissed) {
      setMode("welcome");
      setVisible(true);
      return;
    }

    // 2. Fallback to what's new check
    const dismissedVersion = localStorage.getItem(`${STORAGE_KEY}-${userId}`);
    if (dismissedVersion !== WHATS_NEW_VERSION) {
      setMode("whats-new");
      setCardIndex(0);
      setVisible(true);
    }
    // `visible` is read only to short-circuit redundant state updates
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  function dismiss() {
    if (!userId) {
      setVisible(false);
      return;
    }

    if (mode === "welcome") {
      localStorage.setItem(`${WELCOME_KEY}-${userId}`, "true");
      // Proactively dismiss current what's-new so they don't get double-popped
      localStorage.setItem(`${STORAGE_KEY}-${userId}`, WHATS_NEW_VERSION);
    } else {
      localStorage.setItem(`${STORAGE_KEY}-${userId}`, WHATS_NEW_VERSION);
    }

    setVisible(false);
  }

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, mode, userId]);

  if (!visible || !mode) return null;

  const isWelcome = mode === "welcome";
  const card = RELEASE_CARDS[cardIndex];
  const totalCards = RELEASE_CARDS.length;
  const hasPrev = cardIndex > 0;
  const hasNext = cardIndex < totalCards - 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isWelcome ? "Welcome" : "What's new"}
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: "rgba(0, 0, 0, 0.6)", backdropFilter: "blur(4px)" }}
    >
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-transparent border-0"
      />
      <div
        className="relative w-full max-w-lg rounded-xl overflow-hidden"
        style={{
          background: "var(--color-surface-secondary)",
          border: "1px solid var(--color-glass-border)",
          boxShadow:
            "0 8px 32px rgba(0,0,0,0.4), 0 24px 64px rgba(0,0,0,0.3), inset 0 1px 0 var(--color-glass-highlight-strong)",
        }}
      >
        {/* Header accent bar */}
        <div
          className="h-1"
          style={{
            background: "linear-gradient(90deg, var(--color-accent), var(--color-accent-light))",
          }}
        />

        <div className="p-6 max-h-[75vh] overflow-y-auto custom-scrollbar">
          {/* Title */}
          <div className="flex items-center gap-3 mb-1">
            <span className="text-xl">{isWelcome ? "👋" : "🚀"}</span>
            <h2 className="!mb-0 text-xl font-semibold tracking-tight">
              {isWelcome ? "Welcome to Strata Client!" : `What's New in ${card.version}`}
            </h2>
          </div>
          <p className="text-xs text-txt-tertiary mb-6 uppercase tracking-widest font-medium">
            {isWelcome ? "The modern remote gateway" : card.subtitle}
          </p>

          <div className="space-y-5 text-[0.875rem] leading-relaxed text-txt-secondary">
            {isWelcome ? (
              <>
                <p>
                  We&apos;re excited to have you here! Strata is your unified gateway for
                  high-performance remote access.
                </p>
                <div className="grid gap-4 mt-2">
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center text-accent">
                      <span className="text-sm">🖥️</span>
                    </div>
                    <div>
                      <h4 className="font-semibold text-txt-primary text-sm mb-0.5">
                        Clientless Remotes
                      </h4>
                      <p className="text-xs">
                        Connect to RDP, SSH, and VNC directly in your browser with no plugins
                        required.
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center text-accent">
                      <span className="text-sm">🤝</span>
                    </div>
                    <div>
                      <h4 className="font-semibold text-txt-primary text-sm mb-0.5">
                        Seamless Collaboration
                      </h4>
                      <p className="text-xs">
                        Share your active sessions via Control or View-only links for instant
                        support.
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center text-accent">
                      <span className="text-sm">📂</span>
                    </div>
                    <div>
                      <h4 className="font-semibold text-txt-primary text-sm mb-0.5">
                        Integrated File Browser
                      </h4>
                      <p className="text-xs">
                        Seamlessly transfer files between your local device and remote hosts.
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center text-accent">
                      <span className="text-sm">🎥</span>
                    </div>
                    <div>
                      <h4 className="font-semibold text-txt-primary text-sm mb-0.5">
                        Admin Session Replay
                      </h4>
                      <p className="text-xs">
                        Review connection history with DVR-style NVR playback for full
                        administrative auditing.
                      </p>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                {card.sections.map((s, i) => (
                  <section key={i}>
                    <h3 className="text-sm font-semibold text-txt-primary mb-1.5 flex items-center gap-2">
                      <span className="text-accent">•</span> {s.title}
                    </h3>
                    <p>{s.description}</p>
                  </section>
                ))}
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 pt-2 flex items-center justify-between">
          {/* Navigation (only in whats-new mode with multiple cards) */}
          {!isWelcome && totalCards > 1 ? (
            <div className="flex items-center gap-3">
              <button
                className="w-8 h-8 rounded-lg flex items-center justify-center text-txt-secondary transition-colors disabled:opacity-30 disabled:cursor-default hover:enabled:bg-surface-tertiary hover:enabled:text-txt-primary"
                onClick={() => setCardIndex((i) => i - 1)}
                disabled={!hasPrev}
                aria-label="Newer release"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M10 3L5 8l5 5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <span className="text-xs text-txt-tertiary tabular-nums">
                {cardIndex + 1} / {totalCards}
              </span>
              <button
                className="w-8 h-8 rounded-lg flex items-center justify-center text-txt-secondary transition-colors disabled:opacity-30 disabled:cursor-default hover:enabled:bg-surface-tertiary hover:enabled:text-txt-primary"
                onClick={() => setCardIndex((i) => i + 1)}
                disabled={!hasNext}
                aria-label="Older release"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M6 3l5 5-5 5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          ) : (
            <div />
          )}

          <button
            className="btn-primary min-w-[100px] hover:scale-105 active:scale-95 transition-transform"
            onClick={dismiss}
          >
            {isWelcome ? "Let's Go!" : "Got it"}
          </button>
        </div>
      </div>
    </div>
  );
}
