import { useState, useEffect } from 'react';

const STORAGE_KEY = 'strata-whats-new-dismissed';
const WELCOME_KEY = 'strata-welcome-dismissed';

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
    version: '0.19.1',
    subtitle: 'DNS Search Domains & Docker DNS Fallback',
    sections: [
      {
        title: 'DNS Search Domains',
        description:
          'The Network tab now supports configurable DNS search domains alongside DNS servers. Search domains enable short-name resolution for internal zones (e.g. .local, .dmz.local) — equivalent to the Domains= directive in systemd-resolved on your host OS.',
      },
      {
        title: 'Docker DNS Fallback',
        description:
          'Custom DNS configuration now preserves Docker\'s embedded DNS resolver as a fallback. Existing connections that resolve via public DNS or Docker service discovery continue working without reconfiguration when custom DNS is enabled.',
      },
      {
        title: 'Migration Backfill (047)',
        description:
          'A new migration automatically backfills the dns_search_domains setting for instances that already ran migration 046. No manual database changes needed.',
      },
    ],
  },
  {
    version: '0.19.0',
    subtitle: 'DNS Configuration, Dynamic Tab Titles & guacd Improvements',
    sections: [
      {
        title: 'DNS Configuration (Network Tab)',
        description:
          'A new Network tab in Admin Settings lets you configure custom DNS servers and search domains for guacd containers. Enter your internal DNS server IPs and search domains, save, and restart guacd — no more editing docker-compose.yml for internal hostname resolution (e.g. .local, .dmz.local domains).',
      },
      {
        title: 'Dynamic Browser Tab Title',
        description:
          'The browser tab now shows the active session\'s server name (e.g. "SERVER01 — Strata") while connected, making it easy to identify which server you\'re on when the sidebar is collapsed or switching between browser tabs.',
      },
      {
        title: 'guacd Entrypoint Wrapper',
        description:
          'The guacd container now uses a custom entrypoint that applies DNS configuration from a shared volume before starting the daemon, with proper privilege dropping via su-exec.',
      },
    ],
  },
  {
    version: '0.18.0',
    subtitle: 'Approval Role Scoping, Approvals Redesign & Decided-By Tracking',
    sections: [
      {
        title: 'Approval Role Account Scoping',
        description:
          'Approval roles now use explicit account-to-role mapping instead of LDAP filter matching. Each role is scoped to specific managed AD accounts via a searchable dropdown with chip tags — precise, auditable control over which accounts each approver can approve checkouts for.',
      },
      {
        title: 'Approvals Page Redesign',
        description:
          'The Pending Approvals page has been completely redesigned with a premium card layout. Each request card shows the requester\'s avatar and username, the account CN (with full DN below), formatted duration, and a highlighted justification section. Approve and deny buttons use SVG icons with disabled state during processing.',
      },
      {
        title: 'Approver Navigation Visibility',
        description:
          'The "Pending Approvals" sidebar link now only appears for users assigned to at least one approval role. Non-approvers no longer see the link.',
      },
      {
        title: 'Decided-By Tracking',
        description:
          'The Checkout Requests table in Admin Settings now shows who approved or denied each request — the approver\'s username, "Self Approved" when the approver is also the requester, or "—" for undecided requests.',
      },
      {
        title: 'Bug Fixes',
        description:
          'Fixed managed credential override in tunnel connections, checkout expiry calculation (now computed from approval time), and pending approvals scope enforcement so approvers only see requests for their assigned accounts.',
      },
    ],
  },
  {
    version: '0.17.0',
    subtitle: 'Password Management, Connection Health & UI Polish',
    sections: [
      {
        title: 'Password Management',
        description:
          'Full privileged account password checkout and rotation for AD-managed accounts. Admins configure approval roles and map AD accounts to Strata users. Users request time-limited password checkouts with inline reveal and countdown timers. Passwords are auto-generated per policy, reset via LDAP, and sealed in Vault — no human ever sees the stored password.',
      },
      {
        title: 'AD Sync Password Management Config',
        description:
          'Each AD Sync source now has a collapsible Password Management section: enable/disable PM, choose bind credentials (reuse AD source creds or provide separate PM-specific ones), set the target account LDAP filter, configure password generation policy (length, character requirements), and enable zero-knowledge auto-rotation on a schedule.',
      },
      {
        title: 'Target Filter Preview',
        description:
          'A "Preview" button next to the target account filter lets you test your LDAP filter against Active Directory before saving. See a table of matching accounts (name, DN, description) with a total count — no more guessing whether your filter is correct.',
      },
      {
        title: 'Connection Health Checks',
        description:
          'All connections are now automatically probed every 2 minutes via TCP. A green, red, or gray status dot on each connection row and recent card shows whether the target machine is online, offline, or not yet checked. Hover for the last check timestamp.',
      },
      {
        title: 'Credentials & Approvals Reorganization',
        description:
          '"Request Checkout" and "My Checkouts" have moved from the Approvals page to the Credentials page, consolidating all credential-related actions in one place. The Approvals page now focuses solely on pending approval decisions.',
      },
    ],
  },
  {
    version: '0.16.3',
    subtitle: 'Display Tags for Active Sessions',
    sections: [
      {
        title: 'Pin a Tag to Session Thumbnails',
        description:
          'You can now assign a single display tag to each connection, visible as a colored badge on session thumbnails in the Active Sessions sidebar. Click the tag icon on any thumbnail to choose from your existing tags, or select "None" to clear it. Display tags are optional and per-user — each user can pick a different tag for the same connection.',
      },
      {
        title: 'Tag Picker Dropdown',
        description:
          'A compact dropdown on each session thumbnail shows all your tags with their color swatches. Select a tag to pin it, or choose "None" to remove the badge. The picker closes automatically when you click outside it.',
      },
      {
        title: 'Persistent & Synced',
        description:
          'Display tag assignments are saved to the server and persist across sessions and devices. The assignment is per-user per-connection — your display tags won\'t affect other users.',
      },
    ],
  },
  {
    version: '0.16.2',
    subtitle: 'Command Palette, Keyboard Shortcuts & Quick Share Visibility',
    sections: [
      {
        title: 'Command Palette (Ctrl+K)',
        description:
          'Press Ctrl+K while connected to any session to open an instant search overlay. Find and launch any connection by name, protocol, hostname, or folder — all from the keyboard. Arrow keys navigate, Enter launches, Escape closes. Active sessions show a green badge.',
      },
      {
        title: 'Keyboard Shortcut Proxy',
        description:
          'Ctrl+Alt+` sends Win+Tab (Task View) to the remote session. Right Ctrl acts as the Win key — hold it with another key for Win+combos (Win+E, Win+R, etc.), or tap it alone for the Start menu.',
      },
      {
        title: 'Keyboard Lock (Fullscreen + HTTPS)',
        description:
          'In fullscreen mode over HTTPS, OS-level shortcuts (Win, Alt+Tab, Escape) are captured directly by the browser and forwarded to the remote session via the Keyboard Lock API — no proxy keys needed.',
      },
      {
        title: 'Conditional Quick Share',
        description:
          'The Quick Share upload button now only appears when the connection has file transfer enabled (drive or SFTP). Connections without file transfer configured no longer show an unusable upload button.',
      },
      {
        title: 'Session Bar Keyboard Help',
        description:
          'The Session Bar now includes a keyboard mappings reference showing all available shortcuts: Right Ctrl → Win, Ctrl+Alt+` → Win+Tab, Ctrl+K → Quick Launch, plus tips on fullscreen capture.',
      },
    ],
  },
  {
    version: '0.16.1',
    subtitle: 'Multi-Monitor Rendering, Cursor Sync & Layout Improvements',
    sections: [
      {
        title: 'Multi-Monitor Rendering Fix',
        description:
          'Secondary monitors now render correctly using the default layer canvas instead of display.flatten(), which allocated a new full-resolution canvas every frame and caused black screens from GC pressure.',
      },
      {
        title: 'Cursor Visible on All Monitors',
        description:
          'The remote cursor (arrow, resize handle, text beam, etc.) is now mirrored to all secondary monitor windows in real time via a MutationObserver on the Guacamole display element.',
      },
      {
        title: 'Horizontal Layout Only',
        description:
          'All monitors are placed in a flat left-to-right horizontal row regardless of their physical vertical position. The best supported configuration is all landscape monitors side by side. Monitors above or below the primary appear as slices to the right — scroll/move rightward to reach them.',
      },
      {
        title: 'Popup Auto-Maximize & Screen Detection',
        description:
          'Secondary popup windows now auto-maximize to fill their target screen. Pop-out windows detect when dragged to a different monitor and re-scale automatically.',
      },
    ],
  },
  {
    version: '0.16.0',
    subtitle: 'Security Hardening, Granular RBAC & Multi-Monitor 2D Layout',
    sections: [
      {
        title: 'Granular Permission Enforcement',
        description:
          'All admin API endpoints now enforce fine-grained permission checks (manage system, manage users, manage connections, view audit logs, view sessions) instead of a blanket admin role check. Limited-privilege admin users can no longer access endpoints beyond their assigned permissions.',
      },
      {
        title: 'Multi-Monitor 2D Layout',
        description:
          'Multi-monitor mode now uses physical screen coordinates to build a true 2D layout, correctly handling stacked, L-shaped, grid, and mixed-resolution monitor arrangements. Previously all screens were forced into a horizontal row regardless of physical placement.',
      },
      {
        title: 'Credential Security',
        description:
          'Tunnel tickets now zeroize username and password from memory on drop. The refresh token endpoint re-reads the user\'s role from the database so role demotions take effect immediately. Tag color values are validated as hex codes on both user and admin endpoints.',
      },
      {
        title: 'Non-blocking File I/O',
        description:
          'The session file store now uses fully async I/O (tokio::fs) and releases its lock before performing disk operations, eliminating async runtime blocking during file uploads, downloads, and cleanup.',
      },
      {
        title: 'Database Optimizations',
        description:
          'Bulk tag assignment uses a single INSERT ... SELECT unnest() instead of N+1 individual inserts. Role and Kerberos realm updates use a single COALESCE query. Session stats use a single CTE query instead of six separate queries. New indexes on soft-deleted users and connection access.',
      },
      {
        title: 'Bug Fixes',
        description:
          'Custom roles with connection management permissions are no longer incorrectly blocked. Deleting or updating a nonexistent tag now returns a proper 404. Two theoretical JSON serialization panics in the auth module have been replaced with proper error handling.',
      },
    ],
  },
  {
    version: '0.15.3',
    subtitle: 'Quick Share, Multi-Monitor Fixes & Polish',
    sections: [
      {
        title: 'Quick Share',
        description:
          'Upload files from the Session Bar and get a random download URL to paste into the remote session\'s browser. Files are session-scoped and automatically deleted when the tunnel disconnects. Supports drag-and-drop, up to 20 files per session (500 MB each), and one-click copy-to-clipboard URLs.',
      },
      {
        title: 'Multi-Monitor Screen Count',
        description:
          'The multi-monitor button tooltip now shows the number of detected screens (e.g. "Multi-monitor (3 screens detected)"), updating live when monitors are plugged in or out.',
      },
      {
        title: 'Multi-Monitor Popup Blocker Fix',
        description:
          'Opening three or more monitors no longer triggers Chrome\'s popup blocker. The hook now calls getScreenDetails() inside the click handler, extending Chrome\'s user activation so all secondary windows open successfully.',
      },
      {
        title: 'Quick Share Upload Fix',
        description:
          'Large file uploads (over 10 MB) no longer fail with a 413 error. Both the nginx reverse proxy body size limit and the Axum multipart body limit now match the backend\'s 500 MB cap.',
      },
      {
        title: 'Quick Share Delete Fix',
        description:
          'Deleting a Quick Share file no longer throws a "Unexpected end of JSON input" error. The API client now handles empty response bodies correctly.',
      },
      {
        title: 'Disclaimer Scroll Fix',
        description:
          'The "I Accept" button on the Session Recording Disclaimer is no longer permanently disabled on screens tall enough to display the full content without scrolling.',
      },
    ],
  },
  {
    version: '0.15.0',
    subtitle: 'Multi-Monitor Improvements',
    sections: [
      {
        title: 'Brave & Privacy Browser Compatibility',
        description:
          'Multi-monitor mode now works in Brave and other privacy-focused browsers that zero out screen dimensions from the Window Management API. Screen sizes automatically fall back to window.screen values and popup placement uses computed tile offsets.',
      },
      {
        title: 'Dynamic Secondary Window Scaling',
        description:
          'Secondary monitor windows now dynamically resize their canvas when the window is resized, stretching the remote desktop slice to fill the available space. The primary monitor preserves 1:1 scale matching the browser viewport.',
      },
    ],
  },
  {
    version: '0.14.9',
    subtitle: 'Multi-Monitor Support',
    sections: [
      {
        title: 'Browser-Based Multi-Monitor',
        description:
          'Span your remote desktop across multiple physical monitors. Enable multi-monitor mode from the Session Bar and each secondary screen gets its own browser window showing the correct slice of the remote desktop. Mouse and keyboard input works seamlessly across all windows. Requires Chromium 100+ with the Window Management API.',
      },
    ],
  },
  {
    version: '0.14.8',
    subtitle: 'Display Resize Fix',
    sections: [
      {
        title: 'Remote Display Resize Fix',
        description:
          'Fixed an issue where maximising a window inside a remote desktop session (e.g. RDP) caused the display to become unreadable. The session view now automatically rescales when the remote resolution changes, both in the main window and in pop-out windows.',
      },
    ],
  },
  {
    version: '0.14.7',
    subtitle: 'Live Session Sharing & Admin Tags',
    sections: [
      {
        title: 'Live Session Sharing',
        description:
          'Share links now show your live session in real time. Viewers see exactly what you see — no separate connection to the server. Control mode lets shared viewers send keyboard and mouse input to your session.',
      },
      {
        title: 'Admin Tags',
        description:
          'Administrators can create system-wide tags and assign them to connections. Tags are visible to all users on the Dashboard for easy categorization.',
      },
      {
        title: 'Bug Fixes',
        description:
          'Fixed share button not appearing in the Session Bar, 403 errors for non-admin users loading settings, tag dropdowns going off-screen, and recording files not being cleaned up when users are deleted.',
      },
    ],
  },
  {
    version: '0.14.6',
    subtitle: 'Terms of Service & NVR Pause',
    sections: [
      {
        title: 'Recording Disclaimer',
        description:
          'A mandatory terms-of-service modal is now shown on first login, covering session recording consent, acceptable use, and data protection. Users must scroll through and accept before accessing the application.',
      },
      {
        title: 'NVR Play/Pause',
        description:
          'The live session player now has a play/pause button. Pausing freezes the display while the stream stays connected — resume to pick up from the current live point.',
      },
    ],
  },
  {
    version: '0.14.5',
    subtitle: 'NVR & Popout Fixes',
    sections: [
      {
        title: 'Live Rewind Black Screen Fix',
        description:
          'Rewinding a live session no longer shows a black screen. All rewind durations (30s, 1m, 3m, 5m) now render the target frame instantly.',
      },
      {
        title: 'NVR Player Speed Improvements',
        description:
          'The NVR player now defaults to 1× speed, and changing speed during a live session no longer causes an unnecessary reconnect.',
      },
      {
        title: 'Popout Window Close Fix',
        description:
          'Closing a popped-out session window now correctly returns you to the session page instead of leaving a white screen.',
      },
    ],
  },
  {
    version: '0.14.4',
    subtitle: 'Recording Skip & Speed Controls',
    sections: [
      {
        title: 'Skip Forward & Back',
        description:
          'Jump to any point in a recording with skip buttons — 30 seconds, 1 minute, 3 minutes, or 5 minutes forward or back.',
      },
      {
        title: 'Playback Speed',
        description:
          'Play recordings at 1×, 2×, 4×, or 8× speed. The speed selector is in the bottom-right of the player controls.',
      },
      {
        title: 'Smoother Playback & Seeking',
        description:
          'Recordings no longer freeze during idle periods, and seeking to a position renders instantly instead of showing a black screen.',
      },
    ],
  },
  {
    version: '0.14.3',
    subtitle: 'Fullscreen Recordings & User Session Observe',
    sections: [
      {
        title: 'Recording Player Fullscreen',
        description:
          'The historical recording player now has a fullscreen button for distraction-free playback. The default modal is also wider for a better viewing experience.',
      },
      {
        title: 'Live/Rewind for Your Own Sessions',
        description:
          'Users with the "View own sessions" permission can now use the Live and Rewind buttons on their own active sessions — no admin privileges required.',
      },
    ],
  },
  {
    version: '0.14.2',
    subtitle: 'NVR & Sessions Permission Fixes',
    sections: [
      {
        title: 'NVR Observer Connection Fix',
        description:
          'Live session observation no longer fails silently when your access token has expired. The player now refreshes the token before connecting and shows clear error messages with a Retry button if something goes wrong.',
      },
      {
        title: 'Sessions Sidebar Visibility Fix',
        description:
          'Users with the "View own sessions" role permission can now see the Sessions link in the sidebar. Previously this was hidden because the auth check endpoint was missing the permission field.',
      },
    ],
  },
  {
    version: '0.14.1',
    subtitle: 'Credential Renewal & Clipboard Fix',
    sections: [
      {
        title: 'Renew Expired Credentials at Connect Time',
        description:
          'When you connect to a session with an expired credential profile, the prompt now shows the expired profile with an "Update & Connect" form. Enter new credentials to renew and connect instantly, or dismiss to enter one-time manual credentials.',
      },
      {
        title: 'Popout Clipboard Fix',
        description:
          'Copying text from a remote session in a pop-out window now correctly writes to your local clipboard. Previously the clipboard write was silently denied because it targeted the unfocused main window.',
      },
    ],
  },
  {
    version: '0.14.0',
    subtitle: 'Unified Sessions & RBAC',
    sections: [
      {
        title: 'Unified Sessions Page',
        description:
          'New dedicated Sessions page in the sidebar combining live session monitoring and recording history into a single tabbed interface. Replaces the old admin-only Active Sessions panel.',
      },
      {
        title: 'Role-Based Session Access',
        description:
          'New "View own sessions" permission lets users see their own live sessions and recordings. Admins with Manage System or Audit Logs see all users\' sessions with kill, observe, and rewind controls.',
      },
      {
        title: 'Admin Sessions Tab Refined',
        description:
          'The Admin Settings Sessions tab now focuses purely on analytics — stats, charts, leaderboards, and guacd capacity. Live session management has moved to the dedicated Sessions page.',
      },
    ],
  },
  {
    version: '0.13.2',
    subtitle: 'Docs, Stability & CI',
    sections: [
      {
        title: 'In-App Documentation',
        description:
          'New Docs page in the sidebar with Architecture, Security, and API Reference rendered inline, plus a full release history carousel covering every version back to v0.1.0.',
      },
      {
        title: 'Session Idle Timeout Fix',
        description:
          'Active users are no longer logged out after 20 minutes while using remote sessions. The access token now proactively refreshes in the background when activity is detected.',
      },
      {
        title: 'Backend CI Fix',
        description:
          'Fixed missing watermark field in five backend test struct initialisers that caused cargo clippy failures in CI.',
      },
    ],
  },
  {
    version: '0.13.1',
    subtitle: 'Improvements & Fixes',
    sections: [
      {
        title: "What's New Carousel",
        description:
          'This modal now lets you browse all previous release notes with navigation arrows — no more missing what changed in earlier versions.',
      },
      {
        title: 'guacd Scaling Fix',
        description:
          'The GUACD_INSTANCES environment variable is now correctly forwarded to the backend container, so scaled guacd pools are detected on startup.',
      },
      {
        title: 'Architecture Docs Refreshed',
        description:
          'Removed stale Caddy references and updated documentation to reflect the current nginx-based gateway with SSL termination and security headers.',
      },
    ],
  },
  {
    version: '0.13.0',
    subtitle: 'New Features & Fixes',
    sections: [
      {
        title: 'Per-Connection Watermark',
        description:
          'Connections now have their own watermark setting (Inherit / Always on / Always off) that overrides the global toggle, giving admins fine-grained control.',
      },
      {
        title: 'Persistent Favorites Filter',
        description:
          'The dashboard favorites toggle now remembers your preference across sessions — no need to re-enable it every time you log in.',
      },
      {
        title: 'Clipboard in Popout Windows',
        description:
          'Pasting text copied after a session was popped out now works correctly. The popout window syncs its own clipboard with the remote session.',
      },
    ],
  },
  {
    version: '0.12.0',
    subtitle: 'Security Update',
    sections: [
      {
        title: 'Enhanced Session Security',
        description:
          'Sessions now use short-lived 20-minute access tokens with automatic silent refresh. A countdown toast warns you 2 minutes before expiry with an option to extend your session.',
      },
      {
        title: 'Password Management',
        description:
          'New password policy enforces a minimum of 12 characters. Users can now change their own password, and admins can force-reset passwords from the user management panel.',
      },
      {
        title: 'CSP Hardened',
        description:
          "Content Security Policy now blocks inline scripts for stronger XSS protection, with no impact to the application's functionality.",
      },
    ],
  },
  {
    version: '0.11.2',
    subtitle: 'Fixes & Modernisation',
    sections: [
      {
        title: 'Migration Checksum Auto-Repair',
        description:
          'Deploying after line-ending normalisation no longer causes crash loops. The migrator detects and auto-repairs stale checksums on startup.',
      },
      {
        title: 'Role Dropdown Modernised',
        description:
          'The admin user-role dropdown now uses the unified custom Select component with portal rendering and animations, matching all other dropdowns.',
      },
    ],
  },
  {
    version: '0.11.1',
    subtitle: 'Role Management & Fixes',
    sections: [
      {
        title: 'User Role Management',
        description:
          'Admins can now change a user\'s role directly from the Users table via an inline dropdown, with audit logging of role changes.',
      },
      {
        title: 'Case-Insensitive Login',
        description:
          'SSO and local login now use case-insensitive email and username matching, fixing login failures when providers return differently-cased emails.',
      },
      {
        title: 'Session Watermark Visibility',
        description:
          'The session watermark now renders with both dark and light text passes, making it visible over any remote desktop background.',
      },
    ],
  },
  {
    version: '0.11.0',
    subtitle: 'Productivity & Analytics',
    sections: [
      {
        title: 'Windows Key Proxy (Right Ctrl)',
        description:
          'Hold Right Ctrl + key to send Win+key to the remote session. Tap Right Ctrl alone to open the Start menu. Works in single sessions, tiled view, and pop-outs.',
      },
      {
        title: 'Analytics Dashboard',
        description:
          'New admin analytics with daily usage trends, session duration stats, bandwidth tracking, protocol distribution, and peak hours histogram.',
      },
      {
        title: 'Dynamic Capacity Gauge',
        description:
          'The guacd capacity gauge now calculates recommended sessions per instance dynamically based on host CPU and RAM.',
      },
    ],
  },
  {
    version: '0.10.6',
    subtitle: 'Folder View & Cleanup',
    sections: [
      {
        title: 'Folder View Auto-Select',
        description:
          'The dashboard now automatically enables folder view when connections belong to folders, with folders collapsed by default for a cleaner layout.',
      },
      {
        title: 'Persistent Folder Preferences',
        description:
          'Folder view toggle and per-folder expand/collapse states are persisted in localStorage so your dashboard layout is remembered across sessions.',
      },
      {
        title: 'Recording Form Cleanup',
        description:
          'Removed system-managed recording fields from VNC and AD Sync forms, leaving only the user-configurable options.',
      },
    ],
  },
  {
    version: '0.10.5',
    subtitle: 'Session Labels & Test Coverage',
    sections: [
      {
        title: 'Session Label Overlay',
        description:
          'Active session thumbnails now display the connection name and protocol as a sleek overlay with a dark gradient and backdrop blur for readability.',
      },
      {
        title: 'Backend Test Coverage',
        description:
          'Comprehensive unit test suite for the GuacamoleParser covering Unicode handling, partial data buffering, and malformed input recovery.',
      },
    ],
  },
  {
    version: '0.10.4',
    subtitle: 'Pop-Out Stability',
    sections: [
      {
        title: 'Pop-Out Session Persistence',
        description:
          'Pop-out windows now survive navigation between the dashboard and session views. State is stored on the session object instead of local React refs.',
      },
      {
        title: 'Multi-Session Pop-Out Fix',
        description:
          'Disconnecting one popped-out session no longer causes other pop-out sessions to go black or become unresponsive.',
      },
    ],
  },
  {
    version: '0.10.3',
    subtitle: 'Session Redirect Fix',
    sections: [
      {
        title: 'Auto-Redirect on Session End',
        description:
          'When a remote session ends and other sessions are still active, the client now automatically redirects to the next active session instead of freezing on a stale screen.',
      },
    ],
  },
  {
    version: '0.10.2',
    subtitle: 'Vault Credentials & Recordings',
    sections: [
      {
        title: 'One-Off Vault Credentials',
        description:
          'Select a saved vault credential profile directly from the connection prompt for a single session, without permanently mapping it to the connection.',
      },
      {
        title: 'NVR Playback Controls',
        description:
          'Session recordings now include a progress bar, speed selector (1×/2×/4×/8×), and server-paced replay with proper inter-frame timing.',
      },
      {
        title: 'Per-User Recent Connections',
        description:
          'Connection access history is now tracked per-user, so each user sees only their own recent connections on the dashboard.',
      },
    ],
  },
  {
    version: '0.10.1',
    subtitle: 'Stability & Fixes',
    sections: [
      {
        title: 'Build Stabilisation',
        description:
          'Resolved critical build-time regressions in both the Rust backend and TypeScript frontend, including CSS syntax and Azure recording streaming.',
      },
      {
        title: 'Permission Fixes',
        description:
          'Fixed folder-level permission tunnel access, admin tab visibility for restricted roles, and hardened tunnel ticket creation with comprehensive permission validation.',
      },
    ],
  },
  {
    version: '0.10.0',
    subtitle: 'Session Bar & AD Sync Defaults',
    sections: [
      {
        title: 'Unified Session Bar',
        description:
          'All session controls (Sharing, File Browser, Fullscreen, Pop-out, On-Screen Keyboard) consolidated into a single sleek right-side dock.',
      },
      {
        title: 'AD Sync Connection Defaults',
        description:
          'AD sync sources can now specify default Guacamole parameters (RDP performance flags, recording settings) applied to all synced connections.',
      },
      {
        title: 'Connection Parameter Tooltips',
        description:
          'All connection settings now display descriptive hover tooltips sourced from the official Apache Guacamole documentation.',
      },
    ],
  },
  {
    version: '0.9.0',
    subtitle: 'Live Sessions & Admin Tools',
    sections: [
      {
        title: 'Active Sessions Dashboard',
        description:
          'New real-time admin dashboard for monitoring all active tunnel connections, including bandwidth tracking, duration, and remote host metadata.',
      },
      {
        title: 'Administrative Session Kill',
        description:
          'Admins can now terminate any active session directly from the Live Sessions dashboard for instant access revocation.',
      },
      {
        title: 'Reconnection Stability',
        description:
          'Overhauled session reconnection logic with 10-second stability thresholds and explicit retry counters to prevent infinite loops on permanent failures.',
      },
    ],
  },
  {
    version: '0.8.0',
    subtitle: 'Infrastructure & Security',
    sections: [
      {
        title: 'Nginx Gateway',
        description:
          'Removed Caddy reverse proxy. Nginx now handles SSL termination, API/WebSocket proxying, security headers, and automatic HTTP-to-HTTPS redirection.',
      },
      {
        title: 'Manual SSL Support',
        description:
          'Mount your own SSL certificates (cert.pem, key.pem) to the certs/ volume for HTTPS without an external proxy.',
      },
      {
        title: 'User Restoration',
        description:
          'Administrators can now restore soft-deleted user accounts from the Admin Settings dashboard within the 7-day retention window.',
      },
    ],
  },
  {
    version: '0.7.0',
    subtitle: 'RBAC & Folders',
    sections: [
      {
        title: 'Granular RBAC Permissions',
        description:
          'Nine role-based permissions for fine-grained access control over system, users, connections, audit logs, and sharing profiles.',
      },
      {
        title: 'Connection Folders',
        description:
          'Renamed connection groups to folders across the full stack with CRUD endpoints, collapsible folder headers, and per-folder connection counts.',
      },
      {
        title: 'Docker Security Hardening',
        description:
          'Backend and frontend containers now run as non-root users with pre-created directories and correct volume permissions.',
      },
    ],
  },
  {
    version: '0.6.2',
    subtitle: 'Test Coverage & Hardening',
    sections: [
      {
        title: 'Test Coverage Expansion',
        description:
          'Branch coverage raised from ~55% to 70% across 605 tests. Coverage thresholds enforced: statements 74%, branches 69%, functions 62%, lines 75%.',
      },
      {
        title: 'Backend Security Hardening',
        description:
          'Fixed Unicode protocol parsing, NVR instruction filtering, Kerberos temp file handling, OIDC issuer validation, and Content-Disposition header injection.',
      },
    ],
  },
  {
    version: '0.6.1',
    subtitle: 'Security & Performance',
    sections: [
      {
        title: 'Security Fixes',
        description:
          'Fixed tunnel soft-delete bypass, OIDC issuer validation, shared tunnel pool bypass, and Content-Disposition header injection.',
      },
      {
        title: 'AD Sync Bulk Operations',
        description:
          'Replaced individual LDAP-to-DB updates with high-performance bulk upsert and soft-delete queries for faster Active Directory sync.',
      },
    ],
  },
  {
    version: '0.6.0',
    subtitle: 'SSO / OIDC',
    sections: [
      {
        title: 'SSO / OIDC Support',
        description:
          'Integrated OpenID Connect authentication with Keycloak support, including automatic OIDC discovery and secure client secret storage via Vault.',
      },
      {
        title: 'Configurable Auth Methods',
        description:
          'Admins can toggle between Local Authentication and SSO/OIDC in the Security settings, with strict backend enforcement.',
      },
    ],
  },
  {
    version: '0.5.0',
    subtitle: 'Active Directory Sync',
    sections: [
      {
        title: 'AD LDAP Sync',
        description:
          'Automatic computer account import from Active Directory via LDAP/LDAPS with scheduled background sync, soft-delete lifecycle, and multiple search bases.',
      },
      {
        title: 'Multi-Realm Kerberos',
        description:
          'Support for multiple Kerberos realms with dynamic krb5.conf generation, per-realm KDC configuration, and keytab-based authentication for AD sync.',
      },
      {
        title: 'Credential Profiles',
        description:
          'Saved credential profiles with optional TTL expiry. Pick a saved profile from the connection card or enter credentials inline.',
      },
    ],
  },
  {
    version: '0.4.0',
    subtitle: 'Recordings, Sharing & Scaling',
    sections: [
      {
        title: 'Azure Blob Session Recordings',
        description:
          'Session recordings can be synced to Azure Blob Storage with background upload, automatic fallback download, and SharedKey authentication.',
      },
      {
        title: 'Control Mode Shares',
        description:
          'Share links now support View (read-only) and Control (full keyboard and mouse) modes with distinct icons and colour badges.',
      },
      {
        title: 'guacd Scaling & PWA',
        description:
          'Round-robin connection pool across multiple guacd instances, plus Progressive Web App support with service worker caching and touch toolbar.',
      },
    ],
  },
  {
    version: '0.3.0',
    subtitle: 'Live NVR & Organisation',
    sections: [
      {
        title: 'Live Session NVR',
        description:
          'In-memory ring buffer captures up to 5 minutes of session activity. Admins can observe live sessions and rewind to see what happened before a support call.',
      },
      {
        title: 'Connection Groups & Favorites',
        description:
          'Organise connections into collapsible folder groups. Star/unstar connections for quick access with a favorites filter on the dashboard.',
      },
      {
        title: 'Theme Toggle',
        description:
          'Light/dark/system theme toggle in the sidebar with refined dark theme surfaces and premium animated checkboxes.',
      },
    ],
  },
  {
    version: '0.2.0',
    subtitle: 'Multi-Session & Vault',
    sections: [
      {
        title: 'Multi-Session Tiled View',
        description:
          'Tiled multi-session layout with responsive grid, per-tile focus, Ctrl/Cmd+click multi-focus, and keyboard broadcast to all focused tiles.',
      },
      {
        title: 'Clipboard & File Transfer',
        description:
          'Bidirectional clipboard sync, drag-and-drop file upload, in-browser file browser with directory navigation, and RDP virtual drive mounting.',
      },
      {
        title: 'Bundled HashiCorp Vault',
        description:
          'Auto-initialised Vault container with Transit envelope encryption, automatic unseal on startup, and setup wizard mode selector.',
      },
    ],
  },
  {
    version: '0.1.0',
    subtitle: 'Initial Release',
    sections: [
      {
        title: 'Core Platform',
        description:
          'Docker Compose orchestration, custom guacd with FreeRDP 3 and Kerberos support, Rust/Axum backend with PostgreSQL, and React/Vite frontend.',
      },
      {
        title: 'Session Management',
        description:
          'WebSocket tunnel to guacd with Guacamole protocol handshake, role-based connection access, dynamic Kerberos config, and session recording.',
      },
      {
        title: 'Security Foundation',
        description:
          'Vault Transit envelope encryption (AES-256-GCM) with memory zeroisation, OIDC token validation, SHA-256 hash-chained audit logging, and admin RBAC.',
      },
    ],
  },
];

/* ── Component ─────────────────────────────────────────────────────── */

interface WhatsNewModalProps {
  /** User ID — used to scope dismissal per-user */
  userId: string | undefined;
}

type ModalMode = 'welcome' | 'whats-new';

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
      setMode('welcome');
      setVisible(true);
      return;
    }

    // 2. Fallback to what's new check
    const dismissedVersion = localStorage.getItem(`${STORAGE_KEY}-${userId}`);
    if (dismissedVersion !== WHATS_NEW_VERSION) {
      setMode('whats-new');
      setCardIndex(0);
      setVisible(true);
    }
  }, [userId]);

  function dismiss() {
    if (!userId) {
      setVisible(false);
      return;
    }

    if (mode === 'welcome') {
      localStorage.setItem(`${WELCOME_KEY}-${userId}`, 'true');
      // Proactively dismiss current what's-new so they don't get double-popped
      localStorage.setItem(`${STORAGE_KEY}-${userId}`, WHATS_NEW_VERSION);
    } else {
      localStorage.setItem(`${STORAGE_KEY}-${userId}`, WHATS_NEW_VERSION);
    }

    setVisible(false);
  }

  if (!visible || !mode) return null;

  const isWelcome = mode === 'welcome';
  const card = RELEASE_CARDS[cardIndex];
  const totalCards = RELEASE_CARDS.length;
  const hasPrev = cardIndex > 0;
  const hasNext = cardIndex < totalCards - 1;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(4px)' }}
      onClick={dismiss}
    >
      <div
        className="relative w-full max-w-lg rounded-xl overflow-hidden"
        style={{
          background: 'var(--color-surface-secondary)',
          border: '1px solid var(--color-glass-border)',
          boxShadow:
            '0 8px 32px rgba(0,0,0,0.4), 0 24px 64px rgba(0,0,0,0.3), inset 0 1px 0 var(--color-glass-highlight-strong)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header accent bar */}
        <div
          className="h-1"
          style={{ background: 'linear-gradient(90deg, var(--color-accent), var(--color-accent-light))' }}
        />

        <div className="p-6 max-h-[75vh] overflow-y-auto custom-scrollbar">
          {/* Title */}
          <div className="flex items-center gap-3 mb-1">
            <span className="text-xl">{isWelcome ? '👋' : '🚀'}</span>
            <h2 className="!mb-0 text-xl font-semibold tracking-tight">
              {isWelcome ? 'Welcome to Strata Client!' : `What's New in ${card.version}`}
            </h2>
          </div>
          <p className="text-xs text-txt-tertiary mb-6 uppercase tracking-widest font-medium">
            {isWelcome ? 'The modern remote gateway' : card.subtitle}
          </p>

          <div className="space-y-5 text-[0.875rem] leading-relaxed text-txt-secondary">
            {isWelcome ? (
              <>
                <p>
                  We're excited to have you here! Strata is your unified gateway for high-performance remote access.
                </p>
                <div className="grid gap-4 mt-2">
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center text-accent">
                      <span className="text-sm">🖥️</span>
                    </div>
                    <div>
                      <h4 className="font-semibold text-txt-primary text-sm mb-0.5">Clientless Remotes</h4>
                      <p className="text-xs">Connect to RDP, SSH, and VNC directly in your browser with no plugins required.</p>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center text-accent">
                      <span className="text-sm">🤝</span>
                    </div>
                    <div>
                      <h4 className="font-semibold text-txt-primary text-sm mb-0.5">Seamless Collaboration</h4>
                      <p className="text-xs">Share your active sessions via Control or View-only links for instant support.</p>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center text-accent">
                      <span className="text-sm">📂</span>
                    </div>
                    <div>
                      <h4 className="font-semibold text-txt-primary text-sm mb-0.5">Integrated File Browser</h4>
                      <p className="text-xs">Seamlessly transfer files between your local device and remote hosts.</p>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center text-accent">
                      <span className="text-sm">🎥</span>
                    </div>
                    <div>
                      <h4 className="font-semibold text-txt-primary text-sm mb-0.5">Admin Session Replay</h4>
                      <p className="text-xs">Review connection history with DVR-style NVR playback for full administrative auditing.</p>
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
                onClick={() => setCardIndex(i => i - 1)}
                disabled={!hasPrev}
                aria-label="Newer release"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
              <span className="text-xs text-txt-tertiary tabular-nums">
                {cardIndex + 1} / {totalCards}
              </span>
              <button
                className="w-8 h-8 rounded-lg flex items-center justify-center text-txt-secondary transition-colors disabled:opacity-30 disabled:cursor-default hover:enabled:bg-surface-tertiary hover:enabled:text-txt-primary"
                onClick={() => setCardIndex(i => i + 1)}
                disabled={!hasNext}
                aria-label="Older release"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
            </div>
          ) : (
            <div />
          )}

          <button
            className="btn-primary min-w-[100px] hover:scale-105 active:scale-95 transition-transform"
            onClick={dismiss}
          >
            {isWelcome ? "Let's Go!" : 'Got it'}
          </button>
        </div>
      </div>
    </div>
  );
}
