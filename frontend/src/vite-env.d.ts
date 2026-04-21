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
