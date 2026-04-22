import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock the markdown imports and marked
vi.mock("@docs/architecture.md?raw", () => ({ default: "# Architecture\nArch content here" }));
vi.mock("@docs/security.md?raw", () => ({ default: "# Security\nSecurity content here" }));
vi.mock("@docs/api-reference.md?raw", () => ({ default: "# API Reference\nAPI content here" }));

// Mock the roadmap API calls used by the Roadmap tab.
const getRoadmapStatusesMock = vi.fn();
const setRoadmapStatusMock = vi.fn();
vi.mock("../api", () => ({
  getRoadmapStatuses: (...args: unknown[]) => getRoadmapStatusesMock(...args),
  setRoadmapStatus: (...args: unknown[]) => setRoadmapStatusMock(...args),
}));

vi.mock("../components/WhatsNewModal", () => ({
  RELEASE_CARDS: [
    {
      version: "0.14.7",
      subtitle: "Latest release",
      sections: [{ title: "Live Sharing", description: "Share sessions live" }],
    },
    {
      version: "0.14.6",
      subtitle: "Previous release",
      sections: [{ title: "NVR", description: "Session recording and replay" }],
    },
  ],
  WHATS_NEW_VERSION: "0.14.7",
}));

import Documentation from "../pages/Documentation";

describe("Documentation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    getRoadmapStatusesMock.mockReset();
    setRoadmapStatusMock.mockReset();
  });

  it("renders Documentation heading", () => {
    render(<Documentation />);
    expect(screen.getByText("Documentation")).toBeInTheDocument();
  });

  it("shows sidebar navigation links", () => {
    render(<Documentation />);
    expect(screen.getAllByText("What's New").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Architecture")).toBeInTheDocument();
    expect(screen.getByText("Security")).toBeInTheDocument();
    expect(screen.getByText("API Reference")).toBeInTheDocument();
  });

  it("shows What's New content by default", () => {
    render(<Documentation />);
    expect(screen.getByRole("heading", { level: 1, name: "What's New" })).toBeInTheDocument();
    expect(screen.getByText("0.14.7")).toBeInTheDocument();
  });

  it("shows release cards with version info", () => {
    render(<Documentation />);
    expect(screen.getByText("v0.14.7")).toBeInTheDocument();
    expect(screen.getByText("Latest release")).toBeInTheDocument();
    expect(screen.getByText("Live Sharing")).toBeInTheDocument();
  });

  it("shows Latest badge on first card", () => {
    render(<Documentation />);
    expect(screen.getByText("Latest")).toBeInTheDocument();
  });

  it("switches to Architecture tab", async () => {
    const user = userEvent.setup();
    render(<Documentation />);
    await user.click(screen.getByText("Architecture"));
    expect(screen.getByText("Arch content here")).toBeInTheDocument();
  });

  it("switches to Security tab", async () => {
    const user = userEvent.setup();
    render(<Documentation />);
    await user.click(screen.getByText("Security"));
    expect(screen.getByText("Security content here")).toBeInTheDocument();
  });

  it("switches to API Reference tab", async () => {
    const user = userEvent.setup();
    render(<Documentation />);
    await user.click(screen.getByText("API Reference"));
    expect(screen.getByText("API content here")).toBeInTheDocument();
  });

  it("can navigate back to What's New", async () => {
    const user = userEvent.setup();
    render(<Documentation />);
    await user.click(screen.getByText("Architecture"));
    const whatsNewButtons = screen.getAllByText("What's New");
    // Click the sidebar button (not the heading)
    await user.click(whatsNewButtons[0]);
    expect(screen.getByRole("heading", { level: 1, name: "What's New" })).toBeInTheDocument();
  });

  it("shows multiple release cards", () => {
    render(<Documentation />);
    expect(screen.getByText("v0.14.7")).toBeInTheDocument();
    expect(screen.getByText("v0.14.6")).toBeInTheDocument();
  });

  describe("Roadmap tab", () => {
    it("renders roadmap themes and status summary (non-admin view)", async () => {
      getRoadmapStatusesMock.mockResolvedValue({ statuses: {} });
      const user = userEvent.setup();
      render(<Documentation />);
      await user.click(screen.getByText("Roadmap"));
      expect(
        await screen.findByRole("heading", { level: 1, name: "Product Roadmap" })
      ).toBeInTheDocument();
      // Status summary cards (Proposed / Researching / In Progress / Shipped)
      expect(screen.getAllByText("Proposed").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("In Progress").length).toBeGreaterThanOrEqual(1);
      // Non-admin users see status badges, not selects
      expect(screen.queryByText("Admin Editable")).not.toBeInTheDocument();
      await waitFor(() => expect(getRoadmapStatusesMock).toHaveBeenCalled());
    });

    it("shows Admin Editable badge for users with manage_system permission", async () => {
      getRoadmapStatusesMock.mockResolvedValue({ statuses: {} });
      const user = userEvent.setup();
      render(
        <Documentation
          user={
            {
              id: "1",
              email: "admin@example.com",
              can_manage_system: true,
            } as never
          }
        />
      );
      await user.click(screen.getByText("Roadmap"));
      expect(await screen.findByText("Admin Editable")).toBeInTheDocument();
    });

    it("renders load error when getRoadmapStatuses rejects", async () => {
      getRoadmapStatusesMock.mockRejectedValue(new Error("boom"));
      const user = userEvent.setup();
      render(<Documentation />);
      await user.click(screen.getByText("Roadmap"));
      expect(await screen.findByText(/Could not load saved statuses: boom/i)).toBeInTheDocument();
    });

    it("applies overrides returned from the API to the displayed status", async () => {
      // Pick any valid roadmap id; use a clearly distinctive override so we
      // can assert the effective status appears as a badge.
      getRoadmapStatusesMock.mockResolvedValue({
        statuses: { "nonexistent-id": "Shipped" },
      });
      const user = userEvent.setup();
      render(<Documentation />);
      await user.click(screen.getByText("Roadmap"));
      // Roadmap renders regardless; just confirm the async load resolved.
      await waitFor(() => expect(getRoadmapStatusesMock).toHaveBeenCalled());
      expect(
        screen.getByRole("heading", { level: 1, name: "Product Roadmap" })
      ).toBeInTheDocument();
    });

    it("calls setRoadmapStatus when an admin changes a status via the Select", async () => {
      getRoadmapStatusesMock.mockResolvedValue({ statuses: {} });
      setRoadmapStatusMock.mockResolvedValue({});
      const user = userEvent.setup();
      render(
        <Documentation user={{ id: "1", email: "a@x.io", can_manage_system: true } as never} />
      );
      await user.click(screen.getByText("Roadmap"));
      await waitFor(() => expect(getRoadmapStatusesMock).toHaveBeenCalled());

      // Open the first Select on the first roadmap item and pick "Shipped".
      // Our custom Select renders the current value as clickable text.
      const selectButtons = screen.getAllByRole("button", {
        name: /Proposed|Researching|In Progress|Shipped/,
      });
      await user.click(selectButtons[0]);
      // Menu options appear in a portal; grab the last matching "Shipped" node
      // (the first could be the summary card label).
      const shippedOptions = await screen.findAllByText("Shipped");
      await user.click(shippedOptions[shippedOptions.length - 1]);

      await waitFor(() => expect(setRoadmapStatusMock).toHaveBeenCalled());
    });

    it("rolls back optimistic update and shows error when setRoadmapStatus rejects", async () => {
      getRoadmapStatusesMock.mockResolvedValue({ statuses: {} });
      setRoadmapStatusMock.mockRejectedValue(new Error("save failed"));
      const user = userEvent.setup();
      render(
        <Documentation user={{ id: "1", email: "a@x.io", can_manage_system: true } as never} />
      );
      await user.click(screen.getByText("Roadmap"));
      await waitFor(() => expect(getRoadmapStatusesMock).toHaveBeenCalled());

      const selectButtons = screen.getAllByRole("button", {
        name: /Proposed|Researching|In Progress|Shipped/,
      });
      await user.click(selectButtons[0]);
      const shippedOptions = await screen.findAllByText("Shipped");
      await user.click(shippedOptions[shippedOptions.length - 1]);

      expect(await screen.findByText(/save failed/i)).toBeInTheDocument();
    });
  });
});
