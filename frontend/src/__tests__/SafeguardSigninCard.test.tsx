import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("../api", () => ({
  getSafeguardSigninStatus: vi.fn(),
  submitSafeguardToken: vi.fn(),
  clearSafeguardToken: vi.fn(),
}));

vi.mock("../contexts/SettingsContext", () => ({
  useSettings: () => ({
    formatDateTime: (d: unknown) => (d ? new Date(d as string).toISOString() : "—"),
  }),
}));

import SafeguardSigninCard from "../pages/credentials/SafeguardSigninCard";
import {
  getSafeguardSigninStatus,
  submitSafeguardToken,
  clearSafeguardToken,
  type SafeguardSigninStatus,
} from "../api";

const makeStatus = (over: Partial<SafeguardSigninStatus> = {}): SafeguardSigninStatus => ({
  signed_in: false,
  appliance_fqdn: "sg.corp.example",
  idp_alias: "corp-sso",
  auth_mode: "per_user_browser",
  enabled: true,
  ...over,
});

describe("SafeguardSigninCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // jsdom doesn't provide clipboard by default
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("renders nothing while loading", () => {
    (getSafeguardSigninStatus as any).mockReturnValue(new Promise(() => {}));
    const { container } = render(<SafeguardSigninCard />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when JIT is disabled", async () => {
    (getSafeguardSigninStatus as any).mockResolvedValue(makeStatus({ enabled: false }));
    const { container } = render(<SafeguardSigninCard />);
    await flush();
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing in a2a mode", async () => {
    (getSafeguardSigninStatus as any).mockResolvedValue(makeStatus({ auth_mode: "a2a" }));
    const { container } = render(<SafeguardSigninCard />);
    await flush();
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when status fetch fails", async () => {
    (getSafeguardSigninStatus as any).mockRejectedValue(new Error("nope"));
    const { container } = render(<SafeguardSigninCard />);
    await flush();
    expect(container.firstChild).toBeNull();
  });

  it("shows signed-out state with Sign in button", async () => {
    (getSafeguardSigninStatus as any).mockResolvedValue(makeStatus());
    render(<SafeguardSigninCard />);
    await flush();
    expect(screen.getByText("Signed out")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows signed-in state with minutes remaining and Refresh button", async () => {
    const expires = new Date(Date.now() + 12 * 60_000).toISOString();
    (getSafeguardSigninStatus as any).mockResolvedValue(
      makeStatus({ signed_in: true, expires_at: expires })
    );
    render(<SafeguardSigninCard />);
    await flush();
    expect(screen.getByText(/Signed in · 12 min left/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh token" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("opens form, copies snippet, submits token, and notifies parent", async () => {
    (getSafeguardSigninStatus as any)
      .mockResolvedValueOnce(makeStatus())
      .mockResolvedValueOnce(
        makeStatus({ signed_in: true, expires_at: new Date(Date.now() + 600_000).toISOString() })
      );
    (submitSafeguardToken as any).mockResolvedValue({ signed_in: true, expires_at: "x" });
    const onStatusChange = vi.fn();
    render(<SafeguardSigninCard onStatusChange={onStatusChange} />);
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const textarea = screen.getByPlaceholderText(/eyJ\.\.\./);

    // Copy snippet
    fireEvent.click(screen.getByRole("button", { name: "Copy snippet" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("Connect-Safeguard sg.corp.example")
    );

    fireEvent.change(textarea, { target: { value: "  my-token  " } });
    fireEvent.submit(textarea.closest("form")!);
    await flush();

    expect(submitSafeguardToken).toHaveBeenCalledWith("my-token");
    expect(onStatusChange).toHaveBeenCalled();
  });

  it("ignores submit when token input is empty", async () => {
    (getSafeguardSigninStatus as any).mockResolvedValue(makeStatus());
    render(<SafeguardSigninCard />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const submit = screen.getByRole("button", { name: "Submit token" });
    expect(submit).toBeDisabled();
    // Force submit via form to exercise the early-return branch
    fireEvent.submit(screen.getByPlaceholderText(/eyJ\.\.\./).closest("form")!);
    await flush();
    expect(submitSafeguardToken).not.toHaveBeenCalled();
  });

  it("shows error when submit fails", async () => {
    (getSafeguardSigninStatus as any).mockResolvedValue(makeStatus());
    (submitSafeguardToken as any).mockRejectedValue(new Error("bad token"));
    render(<SafeguardSigninCard />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const textarea = screen.getByPlaceholderText(/eyJ\.\.\./);
    fireEvent.change(textarea, { target: { value: "tok" } });
    fireEvent.submit(textarea.closest("form")!);
    await flush();
    expect(screen.getByText("bad token")).toBeInTheDocument();
  });

  it("shows generic error message when submit throws non-Error", async () => {
    (getSafeguardSigninStatus as any).mockResolvedValue(makeStatus());
    (submitSafeguardToken as any).mockRejectedValue("oops");
    render(<SafeguardSigninCard />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const textarea = screen.getByPlaceholderText(/eyJ\.\.\./);
    fireEvent.change(textarea, { target: { value: "tok" } });
    fireEvent.submit(textarea.closest("form")!);
    await flush();
    expect(screen.getByText("Failed to submit token")).toBeInTheDocument();
  });

  it("cancels the sign-in form", async () => {
    (getSafeguardSigninStatus as any).mockResolvedValue(makeStatus());
    render(<SafeguardSigninCard />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByPlaceholderText(/eyJ\.\.\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByPlaceholderText(/eyJ\.\.\./)).not.toBeInTheDocument();
  });

  it("signs out and refreshes status", async () => {
    (getSafeguardSigninStatus as any)
      .mockResolvedValueOnce(
        makeStatus({ signed_in: true, expires_at: new Date(Date.now() + 600_000).toISOString() })
      )
      .mockResolvedValueOnce(makeStatus());
    (clearSafeguardToken as any).mockResolvedValue({ signed_in: false });
    const onStatusChange = vi.fn();
    render(<SafeguardSigninCard onStatusChange={onStatusChange} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await flush();
    expect(clearSafeguardToken).toHaveBeenCalled();
    expect(onStatusChange).toHaveBeenCalled();
  });

  it("uses placeholder fqdn/idp in snippet when missing", async () => {
    (getSafeguardSigninStatus as any).mockResolvedValue(
      makeStatus({ appliance_fqdn: "", idp_alias: "" })
    );
    render(<SafeguardSigninCard />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByText(/<appliance-fqdn>/)).toBeInTheDocument();
    expect(screen.getByText(/<idp-alias>/)).toBeInTheDocument();
  });

  it("sets up a polling interval on mount", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    (getSafeguardSigninStatus as any).mockResolvedValue(makeStatus());
    render(<SafeguardSigninCard />);
    await flush();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    setIntervalSpy.mockRestore();
  });
});
