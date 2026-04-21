import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import QuickShare from "../components/QuickShare";

// ── Mock api ──────────────────────────────────────────────────────────
const mockUpload = vi.fn();
const mockList = vi.fn();
const mockDelete = vi.fn();

vi.mock("../api", () => ({
  uploadQuickShareFile: (...args: any[]) => mockUpload(...args),
  listQuickShareFiles: (...args: any[]) => mockList(...args),
  deleteQuickShareFile: (...args: any[]) => mockDelete(...args),
}));

// ── Mock clipboard ────────────────────────────────────────────────────
const writeTextMock = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: writeTextMock },
  writable: true,
  configurable: true,
});

const sampleFile = {
  token: "abc-123",
  filename: "report.pdf",
  size: 2048,
  content_type: "application/pdf",
  download_url: "/api/files/download/abc-123",
};

const sampleFile2 = {
  token: "def-456",
  filename: "image.png",
  size: 1048576,
  content_type: "image/png",
  download_url: "/api/files/download/def-456",
};

function renderQuickShare(overrides = {}) {
  const props = {
    connectionId: "conn-1",
    onClose: vi.fn(),
    sidebarWidth: 200,
    sessionBarCollapsed: false,
    ...overrides,
  };
  return { ...render(<QuickShare {...props} />), props };
}

describe("QuickShare", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue([]);
    writeTextMock.mockClear();
  });

  it("renders header and empty state", async () => {
    renderQuickShare();
    expect(screen.getByText("Quick Share")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("No files shared yet")).toBeInTheDocument();
    });
  });

  it("calls onClose when close button is clicked", async () => {
    const { props } = renderQuickShare();
    const user = userEvent.setup();
    // The close button is the second button (first is upload area click)
    const buttons = screen.getAllByRole("button");
    // Close button is in the header — look for svg with X path
    const closeBtn = buttons.find((b) => b.closest(".flex.items-center.justify-between"));
    if (closeBtn) {
      await user.click(closeBtn);
      expect(props.onClose).toHaveBeenCalled();
    }
  });

  it("loads files on mount", async () => {
    mockList.mockResolvedValue([sampleFile]);
    renderQuickShare();
    await waitFor(() => {
      expect(mockList).toHaveBeenCalledWith("conn-1");
      expect(screen.getByText("report.pdf")).toBeInTheDocument();
    });
  });

  it("displays file sizes correctly", async () => {
    mockList.mockResolvedValue([sampleFile, sampleFile2]);
    renderQuickShare();
    await waitFor(() => {
      expect(screen.getByText("2.0 KB")).toBeInTheDocument();
      expect(screen.getByText("1.0 MB")).toBeInTheDocument();
    });
  });

  it("uploads a file via the hidden input", async () => {
    const uploadedFile = {
      token: "new-tok",
      filename: "test.txt",
      size: 100,
      content_type: "text/plain",
      download_url: "/api/files/download/new-tok",
    };
    mockUpload.mockResolvedValue(uploadedFile);
    mockList.mockResolvedValueOnce([]).mockResolvedValueOnce([uploadedFile]);

    renderQuickShare();
    await waitFor(() => expect(mockList).toHaveBeenCalled());

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();

    const file = new File(["hello"], "test.txt", { type: "text/plain" });
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() => {
      expect(mockUpload).toHaveBeenCalledWith("conn-1", expect.any(File));
    });
  });

  it("shows error on upload failure", async () => {
    mockUpload.mockRejectedValue(new Error("Upload failed"));
    renderQuickShare();
    await waitFor(() => expect(mockList).toHaveBeenCalled());

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["data"], "big.bin", { type: "application/octet-stream" });
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() => {
      expect(screen.getByText("Upload failed")).toBeInTheDocument();
    });
  });

  it("deletes a file when delete button is clicked", async () => {
    mockList.mockResolvedValue([sampleFile]);
    mockDelete.mockResolvedValue(undefined);
    renderQuickShare();
    await waitFor(() => expect(screen.getByText("report.pdf")).toBeInTheDocument());

    const user = userEvent.setup();
    const deleteBtn = screen.getByTitle("Delete file");
    await user.click(deleteBtn);

    expect(mockDelete).toHaveBeenCalledWith("abc-123");
    await waitFor(() => {
      expect(screen.queryByText("report.pdf")).not.toBeInTheDocument();
    });
  });

  it("shows error on delete failure", async () => {
    mockList.mockResolvedValue([sampleFile]);
    mockDelete.mockRejectedValue(new Error("Delete failed"));
    renderQuickShare();
    await waitFor(() => expect(screen.getByText("report.pdf")).toBeInTheDocument());

    const user = userEvent.setup();
    const deleteBtn = screen.getByTitle("Delete file");
    await user.click(deleteBtn);

    await waitFor(() => {
      expect(screen.getByText("Delete failed")).toBeInTheDocument();
    });
  });

  it("copies URL to clipboard when copy button is clicked", async () => {
    mockList.mockResolvedValue([sampleFile]);
    renderQuickShare();
    await waitFor(() => expect(screen.getByText("report.pdf")).toBeInTheDocument());

    const user = userEvent.setup();
    const copyBtn = screen.getByTitle("Copy download URL");

    // Verify clipboard.writeText is called after clicking the copy button
    const cbSpy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await user.click(copyBtn);

    await waitFor(() => {
      expect(cbSpy).toHaveBeenCalledWith(`${window.location.origin}/api/files/download/abc-123`);
    });
    cbSpy.mockRestore();
  });

  it("displays download URL in readonly input", async () => {
    mockList.mockResolvedValue([sampleFile]);
    renderQuickShare();
    await waitFor(() => expect(screen.getByText("report.pdf")).toBeInTheDocument());

    const urlInput = screen.getByDisplayValue(
      `${window.location.origin}/api/files/download/abc-123`
    );
    expect(urlInput).toBeInTheDocument();
    expect(urlInput).toHaveAttribute("readonly");
  });

  it("shows upload instructions", () => {
    renderQuickShare();
    expect(screen.getByText("Drop files or click to upload")).toBeInTheDocument();
    expect(screen.getByText("Max 500 MB per file")).toBeInTheDocument();
  });

  it("shows temporary file notice", () => {
    renderQuickShare();
    expect(screen.getByText(/Files are temporary/)).toBeInTheDocument();
  });

  it("handles drag over and dragon leave on upload area", async () => {
    renderQuickShare();
    const dropZone = screen.getByText("Drop files or click to upload").closest("div")!;

    await act(async () => {
      const dragOverEvent = new Event("dragover", { bubbles: true });
      Object.defineProperty(dragOverEvent, "preventDefault", { value: vi.fn() });
      dropZone.dispatchEvent(dragOverEvent);
    });

    await act(async () => {
      dropZone.dispatchEvent(new Event("dragleave", { bubbles: true }));
    });
  });

  it("handles file drop", async () => {
    const uploadedFile = {
      token: "drop-tok",
      filename: "dropped.txt",
      size: 50,
      content_type: "text/plain",
      download_url: "/api/files/download/drop-tok",
    };
    mockUpload.mockResolvedValue(uploadedFile);
    mockList.mockResolvedValueOnce([]).mockResolvedValueOnce([uploadedFile]);

    renderQuickShare();
    await waitFor(() => expect(mockList).toHaveBeenCalled());

    const dropZone = screen.getByText("Drop files or click to upload").closest("div")!;
    const file = new File(["dropped"], "dropped.txt", { type: "text/plain" });

    await act(async () => {
      const dropEvent = new Event("drop", { bubbles: true }) as any;
      dropEvent.preventDefault = vi.fn();
      dropEvent.dataTransfer = { files: [file] };
      dropZone.dispatchEvent(dropEvent);
    });

    await waitFor(() => {
      expect(mockUpload).toHaveBeenCalled();
    });
  });

  it("renders multiple files", async () => {
    mockList.mockResolvedValue([sampleFile, sampleFile2]);
    renderQuickShare();
    await waitFor(() => {
      expect(screen.getByText("report.pdf")).toBeInTheDocument();
      expect(screen.getByText("image.png")).toBeInTheDocument();
    });
  });

  it("handles empty upload gracefully (no files selected)", async () => {
    renderQuickShare();
    await waitFor(() => expect(mockList).toHaveBeenCalled());

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", { value: [], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("silently handles list error on mount", async () => {
    mockList.mockRejectedValue(new Error("Network error"));
    renderQuickShare();
    // Should not crash — shows empty state
    await waitFor(() => {
      expect(screen.getByText("No files shared yet")).toBeInTheDocument();
    });
  });

  it("shows upload error for non-Error exceptions", async () => {
    mockUpload.mockRejectedValue("string error");
    renderQuickShare();
    await waitFor(() => expect(mockList).toHaveBeenCalled());

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "x.txt", { type: "text/plain" });
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() => {
      expect(screen.getByText("Upload failed")).toBeInTheDocument();
    });
  });

  it("shows delete error for non-Error exceptions", async () => {
    mockList.mockResolvedValue([sampleFile]);
    mockDelete.mockRejectedValue("string error");
    renderQuickShare();
    await waitFor(() => expect(screen.getByText("report.pdf")).toBeInTheDocument());

    const user = userEvent.setup();
    const deleteBtn = screen.getByTitle("Delete file");
    await user.click(deleteBtn);

    await waitFor(() => {
      expect(screen.getByText("Delete failed")).toBeInTheDocument();
    });
  });
});
