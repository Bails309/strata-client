import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import { getUserPreferences, updateUserPreferences, UserPreferences as Prefs } from "../api";
import { DEFAULT_COMMAND_PALETTE_BINDING } from "../utils/keybindings";

interface PreferencesContextValue {
  preferences: Prefs;
  loading: boolean;
  error: string | null;
  /** Update one or more keys; persists to the backend. */
  update: (patch: Prefs) => Promise<void>;
  /** Reload from the backend. */
  reload: () => Promise<void>;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

const DEFAULTS: Prefs = {
  commandPaletteBinding: DEFAULT_COMMAND_PALETTE_BINDING,
};

export function UserPreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<Prefs>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const prefs = await getUserPreferences();
      setPreferences({ ...DEFAULTS, ...prefs });
    } catch (e) {
      // Unauthenticated, server unreachable, etc. — fall back to defaults
      // so shortcuts still work for guests / on the login screen.
      setPreferences(DEFAULTS);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = useCallback(
    async (patch: Prefs) => {
      const next = { ...preferences, ...patch };
      // Optimistic update — UI reflects the change immediately.
      setPreferences(next);
      try {
        await updateUserPreferences(next);
      } catch (e) {
        // Roll back and surface the error.
        setPreferences(preferences);
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    [preferences]
  );

  return (
    <PreferencesContext.Provider value={{ preferences, loading, error, update, reload: load }}>
      {children}
    </PreferencesContext.Provider>
  );
}

export function useUserPreferences(): PreferencesContextValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) {
    // Safe fallback for tests / unauthenticated screens that don't mount
    // the provider — return defaults and a no-op updater.
    return {
      preferences: DEFAULTS,
      loading: false,
      error: null,
      update: async () => {},
      reload: async () => {},
    };
  }
  return ctx;
}
