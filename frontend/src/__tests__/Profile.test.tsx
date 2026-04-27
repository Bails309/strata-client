import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../api", () => ({
  getMe: vi.fn(),
  getUserPreferences: vi.fn(),
  updateUserPreferences: vi.fn(),
  getMyConnections: vi.fn().mockResolvedValue([]),
  getConnectionFolders: vi.fn().mockResolvedValue([]),
  getTags: vi.fn().mockResolvedValue([]),
  BUILTIN_COMMANDS: ["reload", "disconnect", "fullscreen", "commands", "close", "explorer"],
  COMMAND_MAPPING_PAGES: [
    "/dashboard",
    "/profile",
    "/credentials",
    "/settings",
    "/admin",
    "/audit",
    "/recordings",
  ],
  COMMAND_TRIGGER_RE: /^[a-z0-9_-]{1,32}$/,
  MAX_COMMAND_MAPPINGS: 50,
  MAX_PASTE_TEXT_LEN: 4096,
  MAX_OPEN_PATH_LEN: 1024,
}));

import Profile from "../pages/Profile";
import { UserPreferencesProvider, useUserPreferences } from "../components/UserPreferencesProvider";
import { getMe, getUserPreferences, updateUserPreferences } from "../api";

function renderWithProvider() {
  return render(
    <UserPreferencesProvider>
      <Profile />
    </UserPreferencesProvider>
  );
}

beforeEach(() => {
  vi.mocked(getMe).mockResolvedValue({
    username: "alice",
    full_name: "Alice Example",
    role: "admin",
  } as any);
  vi.mocked(getUserPreferences).mockResolvedValue({
    commandPaletteBinding: "Ctrl+K",
  });
  vi.mocked(updateUserPreferences).mockResolvedValue(undefined as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Profile page", () => {
  it("renders account info from getMe", async () => {
    renderWithProvider();
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    expect(screen.getByText("Alice Example")).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
  });

  it("renders em-dash when full_name is missing", async () => {
    vi.mocked(getMe).mockResolvedValue({
      username: "bob",
      full_name: "",
      role: "user",
    } as any);
    renderWithProvider();
    await waitFor(() => expect(screen.getByText("bob")).toBeInTheDocument());
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows current binding from preferences", async () => {
    renderWithProvider();
    const recorder = await screen.findByLabelText("Record command palette shortcut");
    expect(recorder).toHaveTextContent("Ctrl+K");
  });

  it("Reset button restores default and enables Save", async () => {
    vi.mocked(getUserPreferences).mockResolvedValue({ commandPaletteBinding: "Ctrl+P" });
    renderWithProvider();
    const recorder = await screen.findByLabelText("Record command palette shortcut");
    await waitFor(() => expect(recorder).toHaveTextContent("Ctrl+P"));
    await userEvent.click(screen.getByRole("button", { name: /Reset to Ctrl\+K/ }));
    expect(recorder).toHaveTextContent("Ctrl+K");
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
  });

  it("Disable button clears binding to empty (disabled)", async () => {
    renderWithProvider();
    const recorder = await screen.findByLabelText("Record command palette shortcut");
    await userEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(recorder).toHaveTextContent("(disabled)");
  });

  it("records a new shortcut from a key press", async () => {
    renderWithProvider();
    const recorder = await screen.findByLabelText("Record command palette shortcut");
    await userEvent.click(recorder);
    expect(recorder).toHaveTextContent("Press a shortcut…");
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", ctrlKey: true, bubbles: true })
      );
    });
    await waitFor(() => expect(recorder).toHaveTextContent("Ctrl+J"));
  });

  it("Escape cancels recording without changing the binding", async () => {
    renderWithProvider();
    const recorder = await screen.findByLabelText("Record command palette shortcut");
    await userEvent.click(recorder);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await waitFor(() => expect(screen.getByText("Recording cancelled.")).toBeInTheDocument());
    expect(recorder).toHaveTextContent("Ctrl+K");
  });

  it("ignores modifier-only key presses while recording", async () => {
    renderWithProvider();
    const recorder = await screen.findByLabelText("Record command palette shortcut");
    await userEvent.click(recorder);
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Control", ctrlKey: true, bubbles: true })
      );
    });
    // Still recording
    expect(recorder).toHaveTextContent("Press a shortcut…");
  });

  it("Save persists to backend and shows confirmation", async () => {
    renderWithProvider();
    await screen.findByLabelText("Record command palette shortcut");
    await userEvent.click(screen.getByRole("button", { name: "Disable" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateUserPreferences).toHaveBeenCalled());
    expect(screen.getByText("Saved.")).toBeInTheDocument();
  });

  it("Save surfaces backend error", async () => {
    vi.mocked(updateUserPreferences).mockRejectedValueOnce(new Error("boom"));
    renderWithProvider();
    await screen.findByLabelText("Record command palette shortcut");
    await userEvent.click(screen.getByRole("button", { name: "Disable" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText(/Save failed: boom/)).toBeInTheDocument());
  });
});

describe("UserPreferencesProvider", () => {
  it("falls back to defaults when not wrapped in provider", () => {
    function Probe() {
      const { preferences, loading } = useUserPreferences();
      return (
        <div>
          <span data-testid="binding">{preferences.commandPaletteBinding}</span>
          <span data-testid="loading">{String(loading)}</span>
        </div>
      );
    }
    render(<Probe />);
    expect(screen.getByTestId("binding")).toHaveTextContent("Ctrl+K");
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
  });

  it("rolls back optimistic update when backend rejects", async () => {
    vi.mocked(getUserPreferences).mockResolvedValue({ commandPaletteBinding: "Ctrl+K" });
    vi.mocked(updateUserPreferences).mockRejectedValue(new Error("nope"));

    let updateFn: any;
    let snapshot: any;
    function Probe() {
      const ctx = useUserPreferences();
      updateFn = ctx.update;
      snapshot = ctx.preferences;
      return <span data-testid="b">{ctx.preferences.commandPaletteBinding}</span>;
    }
    render(
      <UserPreferencesProvider>
        <Probe />
      </UserPreferencesProvider>
    );
    await waitFor(() => expect(screen.getByTestId("b")).toHaveTextContent("Ctrl+K"));

    await expect(
      act(async () => {
        await updateFn({ commandPaletteBinding: "Ctrl+J" });
      })
    ).rejects.toThrow();
    // After rollback should be back to original.
    await waitFor(() => expect(snapshot.commandPaletteBinding).toBe("Ctrl+K"));
  });

  it("falls back to defaults when getUserPreferences fails", async () => {
    vi.mocked(getUserPreferences).mockRejectedValue(new Error("401"));
    function Probe() {
      const { preferences, error, loading } = useUserPreferences();
      return (
        <div>
          <span data-testid="b">{preferences.commandPaletteBinding}</span>
          <span data-testid="err">{error ?? ""}</span>
          <span data-testid="loading">{String(loading)}</span>
        </div>
      );
    }
    render(
      <UserPreferencesProvider>
        <Probe />
      </UserPreferencesProvider>
    );
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    expect(screen.getByTestId("b")).toHaveTextContent("Ctrl+K");
    expect(screen.getByTestId("err")).toHaveTextContent("401");
  });
});
