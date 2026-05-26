import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("../api", () => ({
  getSafeguardSigninStatus: vi.fn(),
  startSafeguardSignin: vi.fn(),
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
  startSafeguardSignin,
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

  it("calls startSafeguardSignin and opens form with code on Sign in click", async () => {
    (getSafeguardSigninStatus as any).mockResolvedValue(makeStatus());
    (startSafeguardSignin as any).mockResolvedValue({
      code: "ABCD-1234",
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    render(<SafeguardSigninCard />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await flush();
    expect(startSafeguardSignin).toHaveBeenCalled();
    // Snippet should contain the code
    expect(screen.getByText(/ABCD-1234/)).toBeInTheDocument();
    // Should show countdown badge
    expect(screen.getByText(/Waiting for sign-in/)).toBeInTheDocument();
  });

  it("shows Copy snippet button and code countdown", async () => {
    (getSafeguardSigninStatus as any).mockResolvedValue(makeStatus());
    (startSafeguardSignin as any).mockResolvedValue({
      code: "TEST-5678",
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    render(<SafeguardSigninCard />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Copy snippet" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("Connect-Safeguard sg.corp.example")
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("TEST-5678")
    );
  });

  it("shows 'Having trouble?' toggle to reveal fallback paste form", async () => {
    (getSafeguardSigninStatus as any).mockResolvedValue(makeStatus());
    (startSafeguardSignin as any).mockResolvedValue({
      code: "CODE-1234",
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    render(<SafeguardSigninCard />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await flush();
    // Fallback is initially hidden
    expect(screen.queryByPlaceholderText(/eyJ\.\.\./)).not.toBeInTheDocument();
    // Toggle it on
    fireEvent.click(
      screen.getByRole("button", { name: "Having trouble? Paste the token manually" })
    );
    expect(screen.getByPlaceholderText(/eyJ\.\.\./)).toBeInTheDocument();
  });

  it("accepts manual paste via fallback form", async () => {
    (getSafeguardSigninStatus as any)
      .mockResolvedValueOnce(makeStatus())
      .mockResolvedValueOnce(
        makeStatus({ signed_in: true, expires_at: new Date(Date.now() + 600_000).toISOString() })
      );
    (startSafeguardSignin as any).mockResolvedValue({
      code: "CODE-XXXX",
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    (submitSafeguardToken as any).mockResolvedValue({ signed_in: true, expires_at: "x" });
    const onStatusChange = vi.fn();
    render(<SafeguardSigninCard onStatusChange={onStatusChange} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await flush();
    // Open fallback
    fireEvent.click(
      screen.getByRole("button", { name: "Having trouble? Paste the token manually" })
    );
    const textarea = screen.getByPlaceholderText(/eyJ\.\.\./);
    fireEvent.change(textarea, { target: { value: "  manual-token  " } });
    fireEvent.click(screen.getByRole("button", { name: "Submit token" }));
    await flush();
    expect(submitSafeguardToken).toHaveBeenCalledWith("manual-token");
    expect(onStatusChange).toHaveBeenCalled();
  });

  it("auto-closes modal when polling detects signed_in=true", async () => {
    const initialStatus = makeStatus();
    const signedInStatus = makeStatus({
      signed_in: true,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    (getSafeguardSigninStatus as any)
      .mockResolvedValueOnce(initialStatus) // Initial fetch
      .mockResolvedValueOnce(initialStatus) // After startSafeguardSignin
      .mockResolvedValueOnce(signedInStatus); // Polling finds it signed in
    (startSafeguardSignin as any).mockResolvedValue({
      code: "CODE-POLL",
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    const onStatusChange = vi.fn();
    render(<SafeguardSigninCard onStatusChange={onStatusChange} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await flush();
    // Modal is open
    expect(screen.getByText(/Waiting for sign-in/)).toBeInTheDocument();
    // Advance time past one polling tick (2s)
    await act(async () => {
      vi.advanceTimersByTime(2500);
      await Promise.resolve();
    });
    // Modal should be closed
    expect(screen.queryByText(/Waiting for sign-in/)).not.toBeInTheDocument();
    expect(onStatusChange).toHaveBeenCalled();
  });

  it("shows 'Code expired' badge and 'Get a new code' button when code expires", async () => {
    const now = Date.now();
    (getSafeguardSigninStatus as any).mockResolvedValue(makeStatus());
    (startSafeguardSignin as any).mockResolvedValue({
      code: "EXPIRES-123",
      expires_at: new Date(now + 5 * 60_000).toISOString(),
    });
    render(<SafeguardSigninCard />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await flush();
    // Wait for code to expire (5 min + 1 sec)
    await act(async () => {
      vi.advanceTimersByTime(301_000);
      await Promise.resolve();
    });
    expect(screen.getByText("Code expired")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get a new code" })).toBeInTheDocument();
  });

  it("ignores empty token in fallback form submit", async () => {
    (getSafeguardSigninStatus as any).mockResolvedValue(makeStatus());
    (startSafeguardSignin as any).mockResolvedValue({
      code: "CODE-EMPTY",
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    render(<SafeguardSigninCard />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await flush();
    fireEvent.click(
      screen.getByRole("button", { name: "Having trouble? Paste the token manually" })
    );
    const submit = screen.getByRole("button", { name: "Submit token" });
    expect(submit).toBeDisabled();
    // Even if we force submit, it should return early
    fireEvent.submit(screen.getByPlaceholderText(/eyJ\.\.\./).closest("form")!);
    await flush();
    expect(submitSafeguardToken).not.toHaveBeenCalled();
  });

  it("shows error when startSafeguardSignin fails", async () => {
    (getSafeguardSigninStatus as any).mockResolvedValue(makeStatus());
    (startSafeguardSignin as any).mockRejectedValue(new Error("rate limited"));
    render(<SafeguardSigninCard />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await flush();
    expect(screen.getByText("rate limited")).toBeInTheDocument();
  });

  it("shows error when submitSafeguardToken (fallback) fails", async () => {
    (getSafeguardSigninStatus as any).mockResolvedValue(makeStatus());
    (startSafeguardSignin as any).mockResolvedValue({
      code: "CODE-FAIL",
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    (submitSafeguardToken as any).mockRejectedValue(new Error("bad token"));
    render(<SafeguardSigninCard />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await flush();
    fireEvent.click(
      screen.getByRole("button", { name: "Having trouble? Paste the token manually" })
    );
    const textarea = screen.getByPlaceholderText(/eyJ\.\.\./);
    fireEvent.change(textarea, { target: { value: "invalid-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit token" }));
    await flush();
    expect(screen.getByText("bad token")).toBeInTheDocument();
  });

  it("cancels the sign-in form and clears state", async () => {
    (getSafeguardSigninStatus as any).mockResolvedValue(makeStatus());
    (startSafeguardSignin as any).mockResolvedValue({
      code: "CODE-CANCEL",
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    render(<SafeguardSigninCard />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await flush();
    expect(screen.getByText(/Waiting for sign-in/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/Waiting for sign-in/)).not.toBeInTheDocument();
  });

  it("uses placeholder fqdn/idp in snippet when missing", async () => {
    (getSafeguardSigninStatus as any).mockResolvedValue(
      makeStatus({ appliance_fqdn: "", idp_alias: "" })
    );
    (startSafeguardSignin as any).mockResolvedValue({
      code: "CODE-PLACEHOLDER",
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    render(<SafeguardSigninCard />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await flush();
    expect(screen.getByText(/<appliance-fqdn>/)).toBeInTheDocument();
    expect(screen.getByText(/<idp-alias>/)).toBeInTheDocument();
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

  it("sets up a polling interval on mount", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    (getSafeguardSigninStatus as any).mockResolvedValue(makeStatus());
    render(<SafeguardSigninCard />);
    await flush();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    setIntervalSpy.mockRestore();
  });
});
