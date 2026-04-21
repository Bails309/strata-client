import { createContext, useContext, useEffect, useState, useCallback } from "react";

type Theme = "light" | "dark";
type ThemePreference = Theme | "system";

interface ThemeContextValue {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (pref: ThemePreference) => void;
  cycle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = "strata-theme-preference";

function getSystemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getSavedPreference(): ThemePreference {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "light" || saved === "dark" || saved === "system") return saved;
  return "system";
}

function resolveTheme(preference: ThemePreference): Theme {
  return preference === "system" ? getSystemTheme() : preference;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(getSavedPreference);
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(getSavedPreference()));

  const applyTheme = useCallback((t: Theme) => {
    const html = document.documentElement;
    html.classList.remove("dark", "light");
    html.classList.add(t);
    html.setAttribute("data-theme-transitioning", "");
    requestAnimationFrame(() => {
      setTimeout(() => {
        html.removeAttribute("data-theme-transitioning");
      }, 350);
    });
  }, []);

  const setPreference = useCallback(
    (pref: ThemePreference) => {
      setPreferenceState(pref);
      localStorage.setItem(STORAGE_KEY, pref);
      const resolved = resolveTheme(pref);
      setTheme(resolved);
      applyTheme(resolved);
    },
    [applyTheme]
  );

  const cycle = useCallback(() => {
    const order: ThemePreference[] = ["system", "light", "dark"];
    const next = order[(order.indexOf(preference) + 1) % order.length];
    setPreference(next);
  }, [preference, setPreference]);

  // Apply on mount (no transition)
  useEffect(() => {
    const html = document.documentElement;
    html.classList.remove("dark", "light");
    html.classList.add(theme);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for system theme changes when preference is 'system'
  useEffect(() => {
    if (preference !== "system") return;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      const t = e.matches ? "dark" : "light";
      setTheme(t);
      applyTheme(t);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [preference, applyTheme]);

  return (
    <ThemeContext.Provider value={{ theme, preference, setPreference, cycle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>");
  return ctx;
}
