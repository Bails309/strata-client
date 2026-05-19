import { useEffect } from "react";
import { getStatus } from "../api";
import { useToast } from "./ToastProvider";

const POLL_INTERVAL_MS = 60_000; // Poll every 60 seconds
const STORAGE_KEY = "strata.lastNotifiedVersion.v1";

export default function VersionWatcher({ pollIntervalMs = POLL_INTERVAL_MS } = {}) {
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;

    async function evaluateVersion(): Promise<void> {
      try {
        const statusRes = await getStatus();
        if (cancelled) return;

        const serverVersion = statusRes.version;
        const clientVersion = __APP_VERSION__;

        if (serverVersion && serverVersion !== clientVersion) {
          // Check if we've already notified the user about this particular version mismatch to avoid spamming
          const lastNotified = window.sessionStorage.getItem(STORAGE_KEY);
          if (lastNotified === serverVersion) {
            return;
          }

          toast.warning({
            title: "New Update Available",
            description: `A new version of Strata Client is available (v${serverVersion}). Reload to receive the latest updates, bug fixes, and security enhancements.`,
            key: "version-mismatch-alert",
            duration: null, // Sticky so the user sees it and can act on it
            action: {
              label: "Update now",
              onClick: () => {
                window.sessionStorage.setItem(STORAGE_KEY, serverVersion);
                window.location.reload();
              },
            },
          });
        }
      } catch {
        // Silently ignore network or fetch errors to avoid disrupting the user experience
      }
    }

    // Evaluate once on boot/mount
    void evaluateVersion();

    const intervalId = setInterval(() => void evaluateVersion(), pollIntervalMs);

    // Re-evaluate when tab becomes active / focused to catch updates immediately upon return
    function handleWake() {
      void evaluateVersion();
    }
    window.addEventListener("focus", handleWake);
    document.addEventListener("visibilitychange", handleWake);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
      window.removeEventListener("focus", handleWake);
      document.removeEventListener("visibilitychange", handleWake);
    };
  }, [toast, pollIntervalMs]);

  return null;
}
