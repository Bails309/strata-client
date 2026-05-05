/// <reference types="vite/client" />

/** App version injected from package.json at build time via Vite `define`. */
declare const __APP_VERSION__: string;

/** Allow importing .md files as raw strings via Vite ?raw suffix. */
declare module "*.md?raw" {
  const content: string;
  export default content;
}

declare module "@docs/*.md?raw" {
  const content: string;
  export default content;
}

// ── Window Management API ───────────────────────────────────────────
// Experimental API used by useMultiMonitor / usePopOut for multi-screen
// support. Not yet in lib.dom; minimal shape we actually consume.
interface ScreenDetailed {
  availLeft: number;
  availTop: number;
  availWidth: number;
  availHeight: number;
  isPrimary: boolean;
  isInternal: boolean;
  label: string;
  devicePixelRatio: number;
}

interface ScreenDetails extends EventTarget {
  readonly screens: ReadonlyArray<ScreenDetailed>;
  readonly currentScreen: ScreenDetailed;
}

interface Window {
  getScreenDetails?: () => Promise<ScreenDetails>;
}

// ── Intl.supportedValuesOf (ES2022) ─────────────────────────────────
// Available in all evergreen runtimes we target, but not in older lib
// targets. Augment minimally so `time.ts` doesn't need an `any` cast.
declare namespace Intl {
  function supportedValuesOf(
    key: "timeZone" | "calendar" | "currency" | "numberingSystem"
  ): string[];
}
