import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock the markdown imports and marked
vi.mock("@docs/architecture.md?raw", () => ({ default: "# Architecture\nArch content here" }));
vi.mock("@docs/security.md?raw", () => ({ default: "# Security\nSecurity content here" }));
vi.mock("@docs/api-reference.md?raw", () => ({ default: "# API Reference\nAPI content here" }));

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
});
