// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the api module before importing the unit under test.
// `vi.hoisted` keeps the mock fn instance available inside the hoisted
// `vi.mock(...)` factory.
const { getMyConnectionsPage } = vi.hoisted(() => ({ getMyConnectionsPage: vi.fn() }));
vi.mock("../api", () => ({
  getMyConnectionsPage,
}));

import { createPopoutPalette } from "../utils/popoutPalette";

const sampleConnections = [
  { id: "c1", name: "Alpha Server", protocol: "rdp", hostname: "alpha.example", port: 3389 },
  { id: "c2", name: "Beta Server", protocol: "ssh", hostname: "beta.example", port: 22 },
  { id: "c3", name: "Gamma DB", protocol: "rdp", hostname: "gamma.example", port: 3389 },
];

/** Answer searches the way the server does, from `list`. */
function serve(list: typeof sampleConnections) {
  getMyConnectionsPage
    .mockReset()
    .mockImplementation(async (_page: number, _per: number, f: { search?: string }) => {
      const q = (f?.search ?? "").toLowerCase();
      const items = list.filter(
        (c) => !q || [c.name, c.hostname, c.protocol].some((s) => s.toLowerCase().includes(q))
      );
      return { items, total: items.length };
    });
}

async function flush(): Promise<void> {
  // Past the search debounce, draining the promise chain behind it.
  await vi.advanceTimersByTimeAsync(250);
}

describe("popoutPalette", () => {
  let popup: Window;
  let opener: Window;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    serve(sampleConnections);
    // The popup is "about:blank" same-origin so document/body work; using
    // jsdom's window/document avoids cross-realm contortions.
    popup = window;
    // Stub a minimal opener distinct from popup so we can spy on postMessage.
    opener = {
      postMessage: vi.fn(),
      focus: vi.fn(),
      location: { origin: "https://opener.example" },
    } as unknown as Window;
    Object.defineProperty(popup, "closed", { value: false, configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens once and is idempotent", () => {
    const p = createPopoutPalette(popup, opener);
    expect(p.isOpen()).toBe(false);
    p.open();
    expect(p.isOpen()).toBe(true);
    p.open();
    expect(document.querySelectorAll("[data-strata-popout-palette]").length).toBe(1);
  });

  it("does not open when popup is closed", () => {
    Object.defineProperty(popup, "closed", { value: true, configurable: true });
    const p = createPopoutPalette(popup, opener);
    p.open();
    expect(p.isOpen()).toBe(false);
  });

  it("loads connections and renders rows", async () => {
    const p = createPopoutPalette(popup, opener);
    p.open();
    await flush();
    const rows = document.querySelectorAll("[data-index]");
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain("Alpha Server");
    expect(rows[1].textContent).toContain("Beta Server");
  });

  it("searches the server as you type", async () => {
    const p = createPopoutPalette(popup, opener);
    p.open();
    await flush();
    const input = document.querySelector("input") as HTMLInputElement;
    input.value = "beta";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(getMyConnectionsPage).toHaveBeenLastCalledWith(1, 50, { search: "beta" });
    const rows = document.querySelectorAll("[data-index]");
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("Beta Server");
  });

  it("only the last of several quick keystrokes is searched", async () => {
    const p = createPopoutPalette(popup, opener);
    p.open();
    await flush();
    getMyConnectionsPage.mockClear();
    const input = document.querySelector("input") as HTMLInputElement;
    for (const v of ["g", "ga", "gamma.example"]) {
      input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await flush();
    expect(getMyConnectionsPage).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("[data-index]").length).toBe(1);
    expect(document.querySelector("[data-index]")?.textContent).toContain("Gamma DB");
  });

  it("shows Loading… before connections arrive and No connections. when empty", async () => {
    let resolveFn: (v: { items: typeof sampleConnections; total: number }) => void = () => {};
    getMyConnectionsPage.mockReset().mockReturnValue(
      new Promise((r) => {
        resolveFn = r;
      })
    );
    const p = createPopoutPalette(popup, opener);
    p.open();
    expect(document.body.textContent).toContain("Loading…");
    resolveFn({ items: [], total: 0 });
    await flush();
    expect(document.body.textContent).toContain("No connections.");
  });

  it("does not crash when fetch rejects", async () => {
    getMyConnectionsPage.mockReset().mockRejectedValue(new Error("boom"));
    const p = createPopoutPalette(popup, opener);
    p.open();
    await flush();
    expect(p.isOpen()).toBe(true);
    expect(document.querySelectorAll("[data-index]").length).toBe(0);
  });

  it("ArrowDown / ArrowUp move selection and wrap around", async () => {
    const p = createPopoutPalette(popup, opener);
    p.open();
    await flush();
    expect(p.handleKeyDown(new KeyboardEvent("keydown", { key: "ArrowDown" }))).toBe(true);
    expect(p.handleKeyDown(new KeyboardEvent("keydown", { key: "ArrowDown" }))).toBe(true);
    // index now 2 (Gamma)
    let rows = document.querySelectorAll("[data-index]");
    expect((rows[2] as HTMLElement).style.background).toContain("rgb(55, 65, 81)");
    // wrap forward
    p.handleKeyDown(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    rows = document.querySelectorAll("[data-index]");
    expect((rows[0] as HTMLElement).style.background).toContain("rgb(55, 65, 81)");
    // wrap backward
    p.handleKeyDown(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    rows = document.querySelectorAll("[data-index]");
    expect((rows[2] as HTMLElement).style.background).toContain("rgb(55, 65, 81)");
  });

  it("Escape closes the palette", () => {
    const p = createPopoutPalette(popup, opener);
    p.open();
    expect(p.isOpen()).toBe(true);
    expect(p.handleKeyDown(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(true);
    expect(p.isOpen()).toBe(false);
  });

  it("Enter on selected row posts strata:open-connection to opener and closes", async () => {
    const p = createPopoutPalette(popup, opener);
    p.open();
    await flush();
    const consumed = p.handleKeyDown(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(consumed).toBe(true);
    expect(opener.postMessage).toHaveBeenCalledWith(
      { type: "strata:open-connection", id: "c1" },
      "https://opener.example"
    );
    expect(opener.focus).toHaveBeenCalled();
    expect(p.isOpen()).toBe(false);
  });

  it("clicking a row dispatches selection (event delegation)", async () => {
    const p = createPopoutPalette(popup, opener);
    p.open();
    await flush();
    const rows = document.querySelectorAll("[data-index]");
    rows[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(opener.postMessage).toHaveBeenCalledWith(
      { type: "strata:open-connection", id: "c2" },
      "https://opener.example"
    );
    expect(p.isOpen()).toBe(false);
  });

  it("mousemove over a row updates the selection highlight", async () => {
    const p = createPopoutPalette(popup, opener);
    p.open();
    await flush();
    const rows = document.querySelectorAll("[data-index]");
    rows[2].dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    const after = document.querySelectorAll("[data-index]");
    expect((after[2] as HTMLElement).style.background).toContain("rgb(55, 65, 81)");
  });

  it("mousedown on the dimmed backdrop closes the palette", () => {
    const p = createPopoutPalette(popup, opener);
    p.open();
    const overlay = document.querySelector("[data-strata-popout-palette]") as HTMLElement;
    overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(p.isOpen()).toBe(false);
  });

  it("non-special keys are not consumed and refocus the input if focus drifted", async () => {
    const p = createPopoutPalette(popup, opener);
    p.open();
    await flush();
    const input = document.querySelector("input") as HTMLInputElement;
    // Drift focus elsewhere.
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);
    const consumed = p.handleKeyDown(new KeyboardEvent("keydown", { key: "a" }));
    expect(consumed).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it("handleKeyDown returns false when the palette is closed", () => {
    const p = createPopoutPalette(popup, opener);
    expect(p.handleKeyDown(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(false);
  });

  it("destroy removes the overlay", () => {
    const p = createPopoutPalette(popup, opener);
    p.open();
    p.destroy();
    expect(p.isOpen()).toBe(false);
    expect(document.querySelectorAll("[data-strata-popout-palette]").length).toBe(0);
  });

  it("Enter with no rows is consumed without posting", async () => {
    serve([]);
    const p = createPopoutPalette(popup, opener);
    p.open();
    await flush();
    const consumed = p.handleKeyDown(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(consumed).toBe(true);
    expect(opener.postMessage).not.toHaveBeenCalled();
  });

  it("Arrow keys with no rows are consumed without crashing", async () => {
    serve([]);
    const p = createPopoutPalette(popup, opener);
    p.open();
    await flush();
    expect(p.handleKeyDown(new KeyboardEvent("keydown", { key: "ArrowDown" }))).toBe(true);
    expect(p.handleKeyDown(new KeyboardEvent("keydown", { key: "ArrowUp" }))).toBe(true);
  });

  it("escapes HTML in connection metadata to avoid injection", async () => {
    serve([
      {
        id: "x1",
        name: "<script>alert(1)</script>",
        protocol: "rdp",
        hostname: "<b>nope</b>",
        port: 3389,
      },
    ]);
    const p = createPopoutPalette(popup, opener);
    p.open();
    await flush();
    const row = document.querySelector("[data-index]") as HTMLElement;
    expect(row.innerHTML).not.toContain("<script>");
    expect(row.innerHTML).toContain("&lt;script&gt;");
    expect(row.innerHTML).toContain("&lt;b&gt;nope&lt;/b&gt;");
  });
});
