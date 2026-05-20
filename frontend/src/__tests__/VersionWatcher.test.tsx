import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getStatus } from "../api";
import ToastProvider from "../components/ToastProvider";
import VersionWatcher from "../components/VersionWatcher";

vi.mock("../api", () => ({
  getStatus: vi.fn(),
}));

// Mock window.location
const originalLocation = window.location;

describe("VersionWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.sessionStorage.clear();
    vi.mocked(getStatus).mockReset();

    // Define __APP_VERSION__ on global/window if not present, or override it
    (window as any).__APP_VERSION__ = "1.9.2";

    // Mock window.location.reload
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        reload: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    window.sessionStorage.clear();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  function mount() {
    return render(
      <ToastProvider>
        <VersionWatcher pollIntervalMs={1000} />
      </ToastProvider>
    );
  }

  it("stays silent when client and server versions match", async () => {
    vi.mocked(getStatus).mockResolvedValue({
      phase: "running",
      sso_enabled: false,
      local_auth_enabled: true,
      vault_configured: false,
      sso_providers: [],
      version: "1.9.2",
    });

    mount();

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("fires a warning toast when a new server version is available", async () => {
    vi.mocked(getStatus).mockResolvedValue({
      phase: "running",
      sso_enabled: false,
      local_auth_enabled: true,
      vault_configured: false,
      sso_providers: [],
      version: "1.9.3",
    });

    mount();

    await waitFor(() => expect(screen.getByText(/New Update Available/)).toBeInTheDocument());
    expect(
      screen.getByText(/A new version of Strata Client is available \(v1.9.3\)/)
    ).toBeInTheDocument();
  });

  it("does not repeat notification if session has already dismissed/seen it", async () => {
    vi.mocked(getStatus).mockResolvedValue({
      phase: "running",
      sso_enabled: false,
      local_auth_enabled: true,
      vault_configured: false,
      sso_providers: [],
      version: "1.9.3",
    });

    // Preset sessionStorage
    window.sessionStorage.setItem("strata.lastNotifiedVersion.v1", "1.9.3");

    mount();

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText(/New Update Available/)).toBeNull();
  });

  it("reloads page and stores notified version in sessionStorage when 'Update now' is clicked", async () => {
    vi.mocked(getStatus).mockResolvedValue({
      phase: "running",
      sso_enabled: false,
      local_auth_enabled: true,
      vault_configured: false,
      sso_providers: [],
      version: "1.9.3",
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <ToastProvider>
        <VersionWatcher pollIntervalMs={1000} />
      </ToastProvider>
    );

    await waitFor(() => expect(screen.getByText(/New Update Available/)).toBeInTheDocument());

    await user.click(screen.getByText("Update now"));

    expect(window.sessionStorage.getItem("strata.lastNotifiedVersion.v1")).toBe("1.9.3");
    expect(window.location.reload).toHaveBeenCalled();
  });

  it("stays silent when API status call fails", async () => {
    vi.mocked(getStatus).mockRejectedValue(new Error("API network failure"));

    mount();

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
