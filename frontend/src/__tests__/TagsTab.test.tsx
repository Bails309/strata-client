import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TagsTab from "../pages/admin/TagsTab";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    getAdminTagsAdmin: vi.fn(),
    getAdminConnectionTagsAdmin: vi.fn(),
    createAdminTag: vi.fn(),
    updateAdminTag: vi.fn(),
    deleteAdminTag: vi.fn(),
    setAdminConnectionTags: vi.fn(),
  };
});

import {
  getAdminTagsAdmin,
  getAdminConnectionTagsAdmin,
  createAdminTag,
  deleteAdminTag,
  Connection,
  UserTag,
} from "../api";

const conn = (over: Partial<Connection> = {}): Connection => ({
  id: "c1",
  name: "prod-db",
  protocol: "ssh",
  hostname: "10.0.0.1",
  port: 22,
  ...over,
});

const tag = (over: Partial<UserTag> = {}): UserTag => ({
  id: "t1",
  name: "production",
  color: "#ef4444",
  ...over,
});

const onSave = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  onSave.mockReset();
  vi.mocked(getAdminTagsAdmin).mockResolvedValue([]);
  vi.mocked(getAdminConnectionTagsAdmin).mockResolvedValue({});
  vi.mocked(createAdminTag).mockResolvedValue(tag());
  vi.mocked(deleteAdminTag).mockResolvedValue({ ok: true });
});

describe("TagsTab", () => {
  it("shows empty-state copy when no tags exist", async () => {
    render(<TagsTab connections={[conn()]} onSave={onSave} />);
    await waitFor(() => expect(getAdminTagsAdmin).toHaveBeenCalled());
    expect(await screen.findByText(/No global tags created yet/i)).toBeInTheDocument();
  });

  it("loads and lists existing tags", async () => {
    vi.mocked(getAdminTagsAdmin).mockResolvedValue([tag(), tag({ id: "t2", name: "qa" })]);
    render(<TagsTab connections={[conn()]} onSave={onSave} />);
    expect(await screen.findByText("production")).toBeInTheDocument();
    expect(await screen.findByText("qa")).toBeInTheDocument();
  });

  it("disables 'Create Tag' until a name is typed", async () => {
    render(<TagsTab connections={[conn()]} onSave={onSave} />);
    await waitFor(() => expect(getAdminTagsAdmin).toHaveBeenCalled());
    const btn = screen.getByRole("button", { name: /Create Tag/i });
    expect(btn).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Tag Name/i), "prod");
    expect(btn).toBeEnabled();
  });

  it("creates a tag with the trimmed name and fires onSave", async () => {
    render(<TagsTab connections={[conn()]} onSave={onSave} />);
    await waitFor(() => expect(getAdminTagsAdmin).toHaveBeenCalled());
    await userEvent.type(screen.getByLabelText(/Tag Name/i), "  production  ");
    await userEvent.click(screen.getByRole("button", { name: /Create Tag/i }));
    await waitFor(() => expect(createAdminTag).toHaveBeenCalled());
    const [name] = vi.mocked(createAdminTag).mock.calls[0];
    expect(name).toBe("production");
    expect(onSave).toHaveBeenCalled();
  });

  it("surfaces a load error when the API rejects", async () => {
    vi.mocked(getAdminTagsAdmin).mockRejectedValue(new Error("nope"));
    render(<TagsTab connections={[conn()]} onSave={onSave} />);
    expect(await screen.findByText(/Failed to load tags/i)).toBeInTheDocument();
  });
});
