// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the api module before importing the unit under test.
// `vi.hoisted` keeps the mock fn instance available inside the hoisted
// `vi.mock(...)` factory.
const { getMyConnections } = vi.hoisted(() => ({ getMyConnections: vi.fn() }));
vi.mock("../api", () => ({
  getMyConnections,
}));

import { createPopoutPalette } from "../utils/popoutPalette";

const sampleConnections = [
  { id: "c1", name: "Alpha Server", protocol: "rdp", hostname: "alpha.example", port: 3389 },
  { id: "c2", name: "Beta Server", protocol: "ssh", hostname: "beta.example", port: 22 },
  { id: "c3", name: "Gamma DB", protocol: "rdp", hostname: "gamma.example", port: 3389 },
];

async function flush(): Promise<void> {
  // The palette chains: getMyConnections().then().catch().finally().then(render).
  // Drain a generous number of microtasks so renders complete in tests.
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("popoutPalette", () => {
  let popup: Window;
  let opener: Window;

  beforeEach(() => {
    document.body.innerHTML = "";
    getMyConnections.mockReset().mockResolvedValue(sampleConnections);
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

  it("filters by typing into the input", async () => {
    const p = createPopoutPalette(popup, opener);
    p.open();
    await flush();
    const input = document.querySelector("input") as HTMLInputElement;
    input.value = "beta";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const rows = document.querySelectorAll("[data-index]");
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("Beta Server");
  });

  it("filters by hostname and protocol too", async () => {
    const p = createPopoutPalette(popup, opener);
    p.open();
    await flush();
    const input = document.querySelector("input") as HTMLInputElement;
    input.value = "ssh";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelectorAll("[data-index]").length).toBe(1);
    input.value = "gamma.example";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelectorAll("[data-index]").length).toBe(1);
    expect(document.querySelector("[data-index]")?.textContent).toContain("Gamma DB");
  });

  it("shows Loading… before connections arrive and No connections. when empty", async () => {
    let resolveFn: (v: typeof sampleConnections) => void = () => {};
    getMyConnections.mockReset().mockReturnValue(
      new Promise<typeof sampleConnections>((r) => {
        resolveFn = r;
      })
    );
    const p = createPopoutPalette(popup, opener);
    p.open();
    expect(document.body.textContent).toContain("Loading…");
    resolveFn([]);
    await flush();
    expect(document.body.textContent).toContain("No connections.");
  });

  it("does not crash when fetch rejects", async () => {
    getMyConnections.mockReset().mockRejectedValue(new Error("boom"));
    const p = createPopoutPalette(popup, opener);
    p.open();
    await flush();
    // After rejection the source intentionally leaves the palette in its
    // "Loading…" state (no error UI) and does not throw. The overlay is
    // still mounted and Escape still closes cleanly.
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
    getMyConnections.mockReset().mockResolvedValue([]);
    const p = createPopoutPalette(popup, opener);
    p.open();
    await flush();
    const consumed = p.handleKeyDown(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(consumed).toBe(true);
    expect(opener.postMessage).not.toHaveBeenCalled();
  });

  it("Arrow keys with no rows are consumed without crashing", async () => {
    getMyConnections.mockReset().mockResolvedValue([]);
    const p = createPopoutPalette(popup, opener);
    p.open();
    await flush();
    expect(p.handleKeyDown(new KeyboardEvent("keydown", { key: "ArrowDown" }))).toBe(true);
    expect(p.handleKeyDown(new KeyboardEvent("keydown", { key: "ArrowUp" }))).toBe(true);
  });

  it("escapes HTML in connection metadata to avoid injection", async () => {
    getMyConnections.mockReset().mockResolvedValue([
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
