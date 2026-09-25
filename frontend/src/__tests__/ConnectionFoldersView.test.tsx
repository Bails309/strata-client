import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

vi.mock("../api", () => ({
  createConnectionFolder: vi.fn(),
  updateConnectionFolder: vi.fn(),
  deleteConnectionFolder: vi.fn(),
}));

import {
  createConnectionFolder,
  deleteConnectionFolder,
  updateConnectionFolder,
  type Connection,
  type ConnectionFolder,
} from "../api";
import ConnectionFoldersView from "../pages/admin/ConnectionFoldersView";
import { buildFolderTree } from "../utils/folderTree";

const FOLDERS: ConnectionFolder[] = [
  { id: "prod", name: "Production" },
  { id: "web", name: "Web tier", parent_id: "prod" },
  { id: "db", name: "Databases", parent_id: "prod" },
  { id: "lab", name: "Lab" },
];

const conn = (id: string, name: string, folder_id?: string) =>
  ({ id, name, protocol: "rdp", hostname: `${id}.local`, port: 3389, folder_id }) as Connection;

const CONNECTIONS = [
  conn("c1", "webserver01", "web"),
  conn("c2", "webserver02", "web"),
  conn("c3", "sql01", "db"),
  conn("c4", "jump", "prod"),
];

function Harness({ initial = FOLDERS }: { initial?: ConnectionFolder[] }) {
  const [folders, setFolders] = useState(initial);
  return (
    <ConnectionFoldersView
      folders={folders}
      connections={CONNECTIONS}
      onFoldersChanged={setFolders}
    />
  );
}

describe("buildFolderTree", () => {
  it("nests folders, sorts siblings and aggregates connection counts", () => {
    const tree = buildFolderTree(FOLDERS, CONNECTIONS);
    expect(tree.map((n) => n.folder.name)).toEqual(["Lab", "Production"]);
    const prod = tree[1];
    expect(prod.children.map((n) => n.folder.name)).toEqual(["Databases", "Web tier"]);
    expect(prod.directCount).toBe(1);
    expect(prod.totalCount).toBe(4);
  });

  it("treats folders with unknown parents as roots", () => {
    const tree = buildFolderTree([{ id: "x", name: "Orphan", parent_id: "gone" }]);
    expect(tree).toHaveLength(1);
  });
});

describe("ConnectionFoldersView", () => {
  beforeEach(() => {
    vi.mocked(createConnectionFolder).mockReset();
    vi.mocked(updateConnectionFolder).mockReset();
    vi.mocked(deleteConnectionFolder).mockReset();
  });

  it("shows aggregate connection counts and expands on demand", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const prod = screen.getByRole("treeitem", { name: "Production" });
    expect(within(prod).getByText("4 connections")).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: "Web tier" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Expand All" }));
    expect(screen.getByRole("treeitem", { name: "Web tier" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Collapse All" }));
    expect(screen.queryByRole("treeitem", { name: "Web tier" })).toBeNull();
  });

  it("searches connections and reveals the folder path that holds them", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText("Search folders or connections"), "sql");
    expect(screen.getByRole("treeitem", { name: "Production" })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "Databases" })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: "Web tier" })).toBeNull();
    expect(screen.queryByRole("treeitem", { name: "Lab" })).toBeNull();
    expect(screen.getByText("↳ sql01")).toBeInTheDocument();
  });

  it("supports arrow-key traversal and expansion", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const lab = screen.getByRole("treeitem", { name: "Lab" });
    lab.focus();
    await user.keyboard("{ArrowDown}");
    const prod = screen.getByRole("treeitem", { name: "Production" });
    await waitFor(() => expect(prod).toHaveFocus());
    await user.keyboard("{ArrowRight}");
    expect(prod).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(screen.getByRole("treeitem", { name: "Databases" })).toHaveFocus());
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(prod).toHaveFocus());
    await user.keyboard("{ArrowLeft}");
    expect(prod).toHaveAttribute("aria-expanded", "false");
  });

  it("renames inline with F2 and keeps the folder under its parent", async () => {
    const user = userEvent.setup();
    vi.mocked(updateConnectionFolder).mockResolvedValue({
      id: "db",
      name: "Data stores",
      parent_id: "prod",
    });
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Expand All" }));
    screen.getByRole("treeitem", { name: "Databases" }).focus();
    await user.keyboard("{F2}");
    const input = screen.getByLabelText("New name for Databases");
    await user.clear(input);
    await user.type(input, "Data stores{Enter}");
    expect(updateConnectionFolder).toHaveBeenCalledTimes(1);
    expect(updateConnectionFolder).toHaveBeenCalledWith("db", {
      name: "Data stores",
      parent_id: "prod",
    });
    expect(await screen.findByRole("treeitem", { name: "Data stores" })).toBeInTheDocument();
  });

  it("cancels a rename with Escape without saving", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.dblClick(screen.getByText("Lab"));
    await user.type(screen.getByLabelText("New name for Lab"), "X{Escape}");
    expect(updateConnectionFolder).not.toHaveBeenCalled();
    expect(screen.getByRole("treeitem", { name: "Lab" })).toBeInTheDocument();
  });

  it("creates a subfolder inline and expands its parent", async () => {
    const user = userEvent.setup();
    vi.mocked(createConnectionFolder).mockResolvedValue({
      id: "new",
      name: "Sandbox",
      parent_id: "lab",
    });
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Add subfolder to Lab" }));
    await user.type(screen.getByLabelText("New subfolder name"), "Sandbox{Enter}");
    expect(createConnectionFolder).toHaveBeenCalledWith({ name: "Sandbox", parent_id: "lab" });
    expect(await screen.findByRole("treeitem", { name: "Sandbox" })).toHaveAttribute(
      "aria-level",
      "2"
    );
    expect(screen.getByRole("treeitem", { name: "Lab" })).toHaveAttribute("aria-expanded", "true");
  });

  it("blocks deleting a folder that still has subfolders or connections", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Delete Production" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("2 subfolders and 1 connection");
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("deletes an empty folder", async () => {
    const user = userEvent.setup();
    vi.mocked(deleteConnectionFolder).mockResolvedValue({ status: "deleted" });
    render(<Harness />);
    screen.getByRole("treeitem", { name: "Lab" }).focus();
    await user.keyboard("{Delete}");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(deleteConnectionFolder).toHaveBeenCalledWith("lab");
    await waitFor(() => expect(screen.queryByRole("treeitem", { name: "Lab" })).toBeNull());
  });

  it("surfaces API errors inline", async () => {
    const user = userEvent.setup();
    vi.mocked(createConnectionFolder).mockRejectedValue(new Error("Name already exists"));
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "+ New Root Folder" }));
    await user.type(screen.getByLabelText("New root folder name"), "Lab{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Name already exists");
  });
});
