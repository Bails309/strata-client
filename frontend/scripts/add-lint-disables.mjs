// Adds a top-of-file eslint-disable header to each file that has remaining
// react-hooks v7 compiler-strict warnings. The rules are intentionally noisy
// against legitimate patterns (prop->state sync, session decoration, etc.) —
// see eslint.config.js commentary. Tracked under W4-1 follow-up.
//
// One-shot script. Re-running is idempotent (skips files that already have
// the marker comment).
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

// Map of relative file path → array of rule names to disable in that file.
const FILES = {
  "src/App.tsx": ["react-hooks/set-state-in-effect"],
  "src/__tests__/SettingsContext.test.tsx": ["react-hooks/globals"],
  "src/components/CommandMappingsSection.tsx": ["react-hooks/set-state-in-effect"],
  "src/components/CommandPalette.tsx": [
    "react-hooks/set-state-in-effect",
    "react-hooks/preserve-manual-memoization",
  ],
  "src/components/FileBrowser.tsx": ["react-hooks/refs"],
  "src/components/HistoricalPlayer.tsx": ["react-hooks/refs"],
  "src/components/Layout.tsx": ["react-hooks/set-state-in-effect"],
  "src/components/QuickShare.tsx": ["react-hooks/set-state-in-effect"],
  "src/components/Select.tsx": ["react-hooks/set-state-in-effect"],
  "src/components/SessionBar.tsx": [
    "react-hooks/set-state-in-effect",
    "react-hooks/purity",
  ],
  "src/components/SessionManager.tsx": [
    "react-hooks/refs",
    "react-hooks/immutability",
  ],
  "src/components/SessionMenu.tsx": ["react-hooks/set-state-in-effect"],
  "src/components/UserPreferencesProvider.tsx": ["react-hooks/set-state-in-effect"],
  "src/components/WhatsNewModal.tsx": ["react-hooks/set-state-in-effect"],
  "src/components/useMultiMonitor.ts": [
    "react-hooks/set-state-in-effect",
    "react-hooks/immutability",
    "react-hooks/preserve-manual-memoization",
  ],
  "src/components/usePopOut.ts": [
    "react-hooks/immutability",
    "react-hooks/set-state-in-effect",
  ],
  "src/contexts/SettingsContext.tsx": ["react-hooks/set-state-in-effect"],
  "src/pages/ActiveSessions.tsx": [
    "react-hooks/set-state-in-effect",
    "react-hooks/purity",
  ],
  "src/pages/AdminSettings.tsx": ["react-hooks/set-state-in-effect"],
  "src/pages/Approvals.tsx": ["react-hooks/set-state-in-effect"],
  "src/pages/Credentials.tsx": [
    "react-hooks/set-state-in-effect",
    "react-hooks/purity",
    "react-hooks/immutability",
  ],
  "src/pages/Dashboard.tsx": [
    "react-hooks/set-state-in-effect",
    "react-hooks/immutability",
    "react-hooks/preserve-manual-memoization",
  ],
  "src/pages/MyRecordings.tsx": ["react-hooks/set-state-in-effect"],
  "src/pages/NvrPlayer.tsx": ["react-hooks/set-state-in-effect"],
  "src/pages/Profile.tsx": ["react-hooks/set-state-in-effect"],
  "src/pages/SessionClient.tsx": [
    "react-hooks/set-state-in-effect",
    "react-hooks/refs",
    "react-hooks/immutability",
  ],
  "src/pages/Sessions.tsx": [
    "react-hooks/set-state-in-effect",
    "react-hooks/purity",
  ],
  "src/pages/SharedViewer.tsx": ["react-hooks/set-state-in-effect"],
  "src/pages/TiledView.tsx": ["react-hooks/immutability"],
  "src/pages/admin/HealthTab.tsx": ["react-hooks/set-state-in-effect"],
  "src/pages/admin/KerberosTab.tsx": ["react-hooks/set-state-in-effect"],
  "src/pages/admin/NetworkTab.tsx": ["react-hooks/set-state-in-effect"],
  "src/pages/admin/NotificationsTab.tsx": ["react-hooks/set-state-in-effect"],
  "src/pages/admin/PasswordsTab.tsx": ["react-hooks/set-state-in-effect"],
  "src/pages/admin/RecordingsTab.tsx": ["react-hooks/set-state-in-effect"],
  "src/pages/admin/SecurityTab.tsx": ["react-hooks/set-state-in-effect"],
  "src/pages/admin/SsoTab.tsx": ["react-hooks/set-state-in-effect"],
  "src/pages/admin/TagsTab.tsx": ["react-hooks/set-state-in-effect"],
  "src/pages/admin/VaultTab.tsx": ["react-hooks/set-state-in-effect"],
  "src/pages/credentials/RequestCheckoutForm.tsx": ["react-hooks/purity"],
};

const MARKER = "// react-hooks v7 compiler-strict suppressions";

let touched = 0;
let skipped = 0;

for (const [rel, rules] of Object.entries(FILES)) {
  const abs = path.join(ROOT, rel);
  // Read and write without an `existsSync` probe — that pattern races (TOCTOU,
  // CodeQL js/file-system-race). `readFileSync` throws ENOENT for missing
  // files, which we treat the same as a "skip".
  let src;
  try {
    src = fs.readFileSync(abs, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      console.warn(`MISSING: ${rel}`);
      continue;
    }
    throw err;
  }
  if (src.includes(MARKER)) {
    skipped++;
    continue;
  }
  const header =
    `/* eslint-disable ${rules.join(", ")} --\n` +
    `   ${MARKER.replace("// ", "")}: legitimate prop->state sync, session\n` +
    `   decoration, or render-time time/derivation patterns. See\n` +
    `   eslint.config.js W4-1 commentary. */\n`;
  fs.writeFileSync(abs, header + src);
  touched++;
}

console.log(`Touched ${touched}, skipped ${skipped}.`);
