/**
 * i18n bootstrap — initialises `i18next` with `react-i18next` bindings
 * before any component reads a translation.
 *
 * Strata is shipping an i18n scaffold first and migrating strings
 * incrementally. The default and only locale today is English (`en`);
 * additional locales can be added by dropping a JSON file under
 * `src/i18n/locales/<lang>.json` and registering it in the `resources`
 * map below.
 *
 * Components use the standard `useTranslation()` hook from
 * `react-i18next`. For new strings, prefer `t("namespace.key")` over
 * inline literals so the migration can proceed without touching
 * untouched call sites.
 *
 * The resolved language is persisted in `localStorage` under the
 * `strata.lang` key. When that key is absent we fall back to the
 * browser's `navigator.language`, then to `en`.
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";

const STORAGE_KEY = "strata.lang";

const resources = {
  en: { translation: en },
} as const;

const detectInitialLanguage = (): string => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && stored in resources) return stored;
  } catch {
    // localStorage may be unavailable (private mode, SSR); fall through.
  }
  const navLang = (typeof navigator !== "undefined" && navigator.language) || "en";
  const short = navLang.split("-")[0];
  return short in resources ? short : "en";
};

void i18n.use(initReactI18next).init({
  resources,
  lng: detectInitialLanguage(),
  fallbackLng: "en",
  interpolation: {
    // React already escapes interpolated values, so we don't double-encode.
    escapeValue: false,
  },
  // Keep missing-key warnings in dev only. Production logs would be
  // overwhelming during the incremental string-migration phase.
  saveMissing: false,
  returnNull: false,
});

/** Persist the user's language choice and switch the active locale. */
export function setLanguage(lang: keyof typeof resources): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* ignore */
  }
  void i18n.changeLanguage(lang);
}

export default i18n;
