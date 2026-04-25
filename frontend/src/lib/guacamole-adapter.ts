/*
 * Guacamole client adapter.
 *
 * We ship a vendored copy of guacamole-common-js 1.6.0 (sourced from
 * sol1/rustguac, which forked from upstream Guacamole client) instead of
 * the stale npm package (npm only publishes up to 1.5.0). 1.6.0 contains
 * the rewritten guac_display frame composition pipeline that matches the
 * 1.6.x guacd we run, eliminating the H.264 / RDPGFX tile-cache ghosting
 * that 1.5.0 exhibited against a 1.6 server.
 *
 * The vendor bundle attaches `Guacamole` to `window`; this module just
 * re-exports it. A Vite alias in vite.config.ts redirects all
 *   import Guacamole from "guacamole-common-js"
 * imports to this file, so callers do not need to change.
 */

import "./guacamole-vendor.js";

import type GuacamoleNS from "guacamole-common-js";

declare global {
  interface Window {
    Guacamole: typeof GuacamoleNS;
  }
}

const Guacamole = window.Guacamole;
export default Guacamole;
