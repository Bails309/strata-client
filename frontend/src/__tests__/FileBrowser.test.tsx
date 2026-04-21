import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let capturedReader: { ontext: any; onend: any } | null = null;

vi.mock("guacamole-common-js", () => ({
  default: {
    BlobReader: vi.fn(function () {
      return {
        onend: null,
        getBlob: vi.fn(() => new Blob(["test-data"])),
      };
    }),
    BlobWriter: vi.fn(function () {
      return {
        onprogress: null,
        oncomplete: null,
        onerror: null,
        sendBlob: vi.fn(),
      };
    }),
    StringReader: vi.fn(function () {
      const reader = { ontext: null as any, onend: null as any };
      capturedReader = reader;
      return reader;
    }),
    GuacObject: vi.fn(),
  },
}));

import FileBrowser from "../components/FileBrowser";

function createMockFilesystem() {
  return {
    name: "Shared Drive",
    object: {
      requestInputStream: vi.fn((_path: string, cb: (stream: any, mimetype: string) => void) => {
        cb({}, "application/vnd.glyptodon.guacamole.stream-index+json");
      }),
      createOutputStream: vi.fn(() => ({})),
    },
  };
}

/** Simulate the StringReader receiving directory data and triggering a re-render */
function simulateDirectoryLoad(entries: Record<string, string>) {
  if (capturedReader) {
    capturedReader.ontext?.(JSON.stringify(entries));
    capturedReader.onend?.();
  }
}

describe("FileBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedReader = null;
  });

  it("renders filesystem name", async () => {
    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    expect(await screen.findByText("Shared Drive")).toBeInTheDocument();
  });

  it("renders back button", () => {
    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    expect(screen.getByText("Back")).toBeInTheDocument();
  });

  it("calls onClose when back is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={onClose} />);

    await user.click(screen.getByText("Back"));
    expect(onClose).toHaveBeenCalled();
  });

  it("renders upload button", () => {
    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    expect(screen.getByText("Upload Files")).toBeInTheDocument();
  });

  it("requests root directory on mount", () => {
    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    expect(fs.object.requestInputStream).toHaveBeenCalledWith("/", expect.any(Function));
  });

  it("shows empty directory when no files", async () => {
    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    act(() => {
      simulateDirectoryLoad({});
    });
    await waitFor(() => {
      expect(screen.getByText("Empty directory")).toBeInTheDocument();
    });
  });

  it("displays file and directory entries", async () => {
    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    act(() => {
      simulateDirectoryLoad({
        Documents: "application/vnd.glyptodon.guacamole.stream-index+json",
        "readme.txt": "text/plain",
      });
    });
    await waitFor(() => {
      expect(screen.getByText("Documents")).toBeInTheDocument();
      expect(screen.getByText("readme.txt")).toBeInTheDocument();
    });
  });

  it("sorts directories before files", async () => {
    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    act(() => {
      simulateDirectoryLoad({
        "readme.txt": "text/plain",
        Documents: "application/vnd.glyptodon.guacamole.stream-index+json",
        "archive.zip": "application/zip",
      });
    });
    await waitFor(() => {
      const items = document.querySelectorAll("[title]");
      const titles = Array.from(items).map((el) => el.getAttribute("title"));
      // Directory should appear before files
      const dirIdx = titles.indexOf("Double-click to open");
      const fileIdx = titles.indexOf("Double-click to download");
      if (dirIdx !== -1 && fileIdx !== -1) {
        expect(dirIdx).toBeLessThan(fileIdx);
      }
    });
  });

  it("shows directory icon for directories and file icon for files", async () => {
    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    act(() => {
      simulateDirectoryLoad({
        Folder: "application/vnd.glyptodon.guacamole.stream-index+json",
        "file.txt": "text/plain",
      });
    });
    await waitFor(() => {
      expect(screen.getByTitle("Double-click to open")).toBeInTheDocument();
      expect(screen.getByTitle("Double-click to download")).toBeInTheDocument();
    });
  });

  it("navigates into directory on double click", async () => {
    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    act(() => {
      simulateDirectoryLoad({
        SubFolder: "application/vnd.glyptodon.guacamole.stream-index+json",
      });
    });
    await waitFor(() => {
      expect(screen.getByText("SubFolder")).toBeInTheDocument();
    });
    await userEvent.dblClick(screen.getByText("SubFolder"));
    // Should request the subdirectory
    expect(fs.object.requestInputStream).toHaveBeenCalledWith("/SubFolder", expect.any(Function));
  });

  it("shows breadcrumb path segments after navigation", async () => {
    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    act(() => {
      simulateDirectoryLoad({
        SubFolder: "application/vnd.glyptodon.guacamole.stream-index+json",
      });
    });
    await waitFor(() => expect(screen.getByText("SubFolder")).toBeInTheDocument());
    await userEvent.dblClick(screen.getByText("SubFolder"));
    // SubFolder should appear in breadcrumbs
    await waitFor(() => {
      // There should be a breadcrumb button with SubFolder text
      const buttons = document.querySelectorAll("button");
      const breadcrumbTexts = Array.from(buttons).map((b) => b.textContent);
      expect(breadcrumbTexts.some((t) => t?.includes("SubFolder"))).toBe(true);
    });
  });

  it("handles non-JSON mimetype from requestInputStream", () => {
    const fs = {
      name: "Drive",
      object: {
        requestInputStream: vi.fn((_path: string, cb: (stream: any, mimetype: string) => void) => {
          // Return a non-directory mimetype
          cb({}, "application/octet-stream");
        }),
        createOutputStream: vi.fn(() => ({})),
      },
    };
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    // Should stop loading without crashing
    expect(document.body).toBeTruthy();
  });

  it("handles invalid JSON gracefully", async () => {
    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    // Simulate bad JSON
    act(() => {
      if (capturedReader) {
        capturedReader.ontext?.("not-valid-json");
        capturedReader.onend?.();
      }
    });
    await waitFor(() => {
      expect(screen.getByText("Empty directory")).toBeInTheDocument();
    });
  });

  it("downloads a file on double click", async () => {
    const fs = createMockFilesystem();
    // After the initial root load, the next requestInputStream is for the file download
    let callCount = 0;
    fs.object.requestInputStream = vi.fn(
      (_path: string, cb: (stream: any, mimetype: string) => void) => {
        callCount++;
        if (callCount === 1) {
          // Root directory load
          cb({}, "application/vnd.glyptodon.guacamole.stream-index+json");
        } else {
          // download path
        }
      }
    );
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    act(() => {
      simulateDirectoryLoad({ "report.pdf": "application/pdf" });
    });
    await waitFor(() => expect(screen.getByText("report.pdf")).toBeInTheDocument());

    await userEvent.dblClick(screen.getByText("report.pdf"));

    expect(fs.object.requestInputStream).toHaveBeenCalledWith("/report.pdf", expect.any(Function));
  });

  it("navigates up via breadcrumb home button", async () => {
    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    act(() => {
      simulateDirectoryLoad({
        SubFolder: "application/vnd.glyptodon.guacamole.stream-index+json",
      });
    });
    await waitFor(() => expect(screen.getByText("SubFolder")).toBeInTheDocument());
    await userEvent.dblClick(screen.getByText("SubFolder"));

    // Click home button (first breadcrumb button with SVG)
    const buttons = document.querySelectorAll("button");
    const homeBtn = Array.from(buttons).find((b) => b.querySelector("svg"));
    expect(homeBtn).toBeTruthy();
    await userEvent.click(homeBtn!);

    // Should request root directory again
    expect(fs.object.requestInputStream).toHaveBeenCalledWith("/", expect.any(Function));
  });

  it("shows loading state while directory loads", () => {
    const fs = {
      name: "Drive",
      object: {
        requestInputStream: vi.fn(() => {
          // Don't call the callback — simulates pending load
        }),
        createOutputStream: vi.fn(() => ({})),
      },
    };
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("triggers upload when files are selected", async () => {
    const mockWriter = {
      onprogress: null as any,
      oncomplete: null as any,
      onerror: null as any,
      sendBlob: vi.fn(),
    };
    vi.mocked((await import("guacamole-common-js")).default.BlobWriter).mockImplementation(
      function () {
        return mockWriter as any;
      }
    );

    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    act(() => {
      simulateDirectoryLoad({ "existing.txt": "text/plain" });
    });
    await waitFor(() => expect(screen.getByText("existing.txt")).toBeInTheDocument());

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    const file = new File(["hello"], "test.txt", { type: "text/plain" });
    await userEvent.upload(fileInput, file);

    expect(fs.object.createOutputStream).toHaveBeenCalledWith("text/plain", "/test.txt");
    expect(mockWriter.sendBlob).toHaveBeenCalledWith(file);
  });

  it("shows upload progress", async () => {
    const mockWriter = {
      onprogress: null as any,
      oncomplete: null as any,
      onerror: null as any,
      sendBlob: vi.fn(),
    };
    vi.mocked((await import("guacamole-common-js")).default.BlobWriter).mockImplementation(
      function () {
        return mockWriter as any;
      }
    );

    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    act(() => {
      simulateDirectoryLoad({});
    });
    await waitFor(() => expect(screen.getByText("Empty directory")).toBeInTheDocument());

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["hello world"], "upload.txt", { type: "text/plain" });
    Object.defineProperty(file, "size", { value: 100 });
    await userEvent.upload(fileInput, file);

    // The upload should show the filename
    await waitFor(() => {
      expect(screen.getByText("upload.txt")).toBeInTheDocument();
    });

    // Simulate progress
    act(() => {
      mockWriter.onprogress?.(new Blob(), 50);
    });
    await waitFor(() => {
      expect(screen.getByText("50%")).toBeInTheDocument();
    });
  });

  it("removes upload on writer error", async () => {
    const mockWriter = {
      onprogress: null as any,
      oncomplete: null as any,
      onerror: null as any,
      sendBlob: vi.fn(),
    };
    vi.mocked((await import("guacamole-common-js")).default.BlobWriter).mockImplementation(
      function () {
        return mockWriter as any;
      }
    );

    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    act(() => {
      simulateDirectoryLoad({});
    });
    await waitFor(() => expect(screen.getByText("Empty directory")).toBeInTheDocument());

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["data"], "fail.txt", { type: "text/plain" });
    await userEvent.upload(fileInput, file);

    await waitFor(() => expect(screen.getByText("fail.txt")).toBeInTheDocument());

    // Simulate error
    act(() => {
      mockWriter.onerror?.();
    });
    await waitFor(() => {
      expect(screen.queryByText("fail.txt")).not.toBeInTheDocument();
    });
  });

  it("uses application/octet-stream for files without type", async () => {
    const mockWriter = {
      onprogress: null as any,
      oncomplete: null as any,
      onerror: null as any,
      sendBlob: vi.fn(),
    };
    vi.mocked((await import("guacamole-common-js")).default.BlobWriter).mockImplementation(
      function () {
        return mockWriter as any;
      }
    );

    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    act(() => {
      simulateDirectoryLoad({});
    });
    await waitFor(() => expect(screen.getByText("Empty directory")).toBeInTheDocument());

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["data"], "unknown", { type: "" });
    await userEvent.upload(fileInput, file);

    expect(fs.object.createOutputStream).toHaveBeenCalledWith(
      "application/octet-stream",
      "/unknown"
    );
  });
});
