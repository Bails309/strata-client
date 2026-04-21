import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

// Mock the API
vi.mock("../api", () => ({
  getMyConnections: vi.fn(),
}));

// Mock SessionManager
vi.mock("../components/SessionManager", () => ({
  useSessionManager: vi.fn(),
}));

import { getMyConnections } from "../api";
import { useSessionManager } from "../components/SessionManager";
import CommandPalette from "../components/CommandPalette";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockConnections = [
  {
    id: "c1",
    name: "Dev Server",
    protocol: "rdp",
    hostname: "dev.local",
    port: 3389,
    folder_name: "Work",
  },
  {
    id: "c2",
    name: "Prod DB",
    protocol: "ssh",
    hostname: "db.prod.local",
    port: 22,
    description: "Production database",
  },
  { id: "c3", name: "QA Desktop", protocol: "vnc", hostname: "qa.local", port: 5900 },
];

function setup(open = true) {
  const onClose = vi.fn();
  (getMyConnections as ReturnType<typeof vi.fn>).mockResolvedValue(mockConnections);
  (useSessionManager as ReturnType<typeof vi.fn>).mockReturnValue({
    sessions: [{ connectionId: "c1" }], // Dev Server is "active"
  });

  const result = render(
    <MemoryRouter>
      <CommandPalette open={open} onClose={onClose} />
    </MemoryRouter>
  );
  return { onClose, ...result };
}

describe("CommandPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockReset();
  });

  it("renders nothing when closed", () => {
    const { container } = setup(false);
    expect(container.innerHTML).toBe("");
  });

  it("renders search input and fetches connections", async () => {
    setup();
    expect(screen.getByPlaceholderText("Search connections...")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Dev Server")).toBeInTheDocument();
      expect(screen.getByText("Prod DB")).toBeInTheDocument();
      expect(screen.getByText("QA Desktop")).toBeInTheDocument();
    });
  });

  it("shows Active badge for connected sessions", async () => {
    setup();
    await waitFor(() => {
      expect(screen.getByText("Active")).toBeInTheDocument();
    });
  });

  it("filters connections by name", async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => expect(screen.getByText("Dev Server")).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText("Search connections..."), "prod");
    expect(screen.queryByText("Dev Server")).not.toBeInTheDocument();
    expect(screen.getByText("Prod DB")).toBeInTheDocument();
  });

  it("filters connections by hostname", async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => expect(screen.getByText("Dev Server")).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText("Search connections..."), "qa.local");
    expect(screen.queryByText("Dev Server")).not.toBeInTheDocument();
    expect(screen.getByText("QA Desktop")).toBeInTheDocument();
  });

  it("filters connections by folder name", async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => expect(screen.getByText("Dev Server")).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText("Search connections..."), "Work");
    expect(screen.getByText("Dev Server")).toBeInTheDocument();
    expect(screen.queryByText("Prod DB")).not.toBeInTheDocument();
  });

  it("shows empty state for no matches", async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => expect(screen.getByText("Dev Server")).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText("Search connections..."), "zzzznotfound");
    expect(screen.getByText(/No connections found/)).toBeInTheDocument();
  });

  it("navigates on Enter key", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    const input = screen.getByPlaceholderText("Search connections...");
    await waitFor(() => expect(screen.getByText("Dev Server")).toBeInTheDocument());

    input.focus();
    await user.keyboard("{Enter}");
    expect(onClose).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/session/c1");
  });

  it("navigates with ArrowDown + Enter to select second item", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    const input = screen.getByPlaceholderText("Search connections...");
    await waitFor(() => expect(screen.getByText("Dev Server")).toBeInTheDocument());

    input.focus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onClose).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/session/c2");
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    const input = screen.getByPlaceholderText("Search connections...");
    await waitFor(() => expect(screen.getByText("Dev Server")).toBeInTheDocument());

    input.focus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on backdrop click", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await waitFor(() => expect(screen.getByText("Dev Server")).toBeInTheDocument());

    // Click the backdrop (the outer overlay element)
    const backdrop = screen.getByText("Dev Server").closest(".fixed");
    if (backdrop) await user.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it("navigates on mouse click on a connection", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await waitFor(() => expect(screen.getByText("QA Desktop")).toBeInTheDocument());

    await user.click(screen.getByText("QA Desktop"));
    expect(onClose).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/session/c3");
  });

  it("shows protocol info in subtitle", async () => {
    setup();
    await waitFor(() => {
      expect(screen.getByText(/RDP/)).toBeInTheDocument();
      expect(screen.getByText(/SSH/)).toBeInTheDocument();
      expect(screen.getByText(/VNC/)).toBeInTheDocument();
    });
  });

  it("ArrowUp does not go below 0", async () => {
    const user = userEvent.setup();
    setup();
    const input = screen.getByPlaceholderText("Search connections...");
    await waitFor(() => expect(screen.getByText("Dev Server")).toBeInTheDocument());

    // Press up at index 0, should stay at 0, then Enter launches first item
    input.focus();
    await user.keyboard("{ArrowUp}{Enter}");
    expect(mockNavigate).toHaveBeenCalledWith("/session/c1");
  });

  it("renders default protocol icon for unknown protocols", async () => {
    (getMyConnections as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "c4", name: "Telnet Box", protocol: "telnet", hostname: "legacy.local", port: 23 },
    ]);
    (useSessionManager as ReturnType<typeof vi.fn>).mockReturnValue({ sessions: [] });

    render(
      <MemoryRouter>
        <CommandPalette open={true} onClose={vi.fn()} />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("Telnet Box")).toBeInTheDocument());
    // Should render a generic monitor icon SVG (not crash)
    expect(screen.getByText("Telnet Box").closest('[role="option"]')).toBeInTheDocument();
  });
});
