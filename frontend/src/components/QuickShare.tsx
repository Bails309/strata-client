import { useState, useRef, useCallback, useEffect } from "react";
import {
  uploadQuickShareFile,
  listQuickShareFiles,
  deleteQuickShareFile,
  QuickShareFile,
} from "../api";
import Select from "./Select";

interface Props {
  connectionId: string;
  /**
   * Wire protocol of the active session — used to pick a sensible
   * default "copy" format. SSH / Telnet sessions get a `curl`
   * one-liner because the remote side is a shell; RDP / VNC / web
   * sessions get a plain URL because the user typically pastes it
   * into a graphical browser inside the kiosk.
   */
  protocol?: string;
  onClose: () => void;
  sidebarWidth: number;
  sessionBarCollapsed: boolean;
}

/**
 * Snippet format the copy button + readonly input render.
 *
 * - `url`        — bare HTTPS URL. Best for graphical browsers (RDP, VNC, web).
 * - `curl`       — `curl -fLOJ '<url>'` one-liner. Best for SSH / Telnet shells
 *                  on Linux/macOS hosts. `-J` honours the `Content-Disposition`
 *                  filename the backend already sends, so the saved file keeps
 *                  its original name instead of being saved as the token.
 * - `wget`       — `wget --content-disposition '<url>'` one-liner. Same idea
 *                  as curl but for hosts where `wget` is the default.
 * - `powershell` — `Invoke-WebRequest -Uri '<url>' -OutFile '<filename>'`.
 *                  Best for Windows shells reached over SSH (OpenSSH on
 *                  Windows Server) where neither `curl.exe` nor `wget`
 *                  may be on PATH for the logged-in account.
 */
type SnippetFormat = "url" | "curl" | "wget" | "powershell";

function defaultFormatFor(protocol: string | undefined): SnippetFormat {
  // Normalise so callers passing "SSH" / "Ssh" / undefined all work.
  switch ((protocol ?? "").toLowerCase()) {
    case "ssh":
    case "telnet":
      return "curl";
    default:
      return "url";
  }
}

/**
 * Build the snippet text the user will paste into the remote session.
 *
 * `filename` is shell-quoted by Chrome's clipboard verbatim, so we
 * single-quote any field that originated outside our control. The
 * URL itself is composed from `window.location.origin` (browser-
 * controlled) and the backend-issued opaque token, both of which are
 * already URL-safe — but we still wrap them in single quotes so an
 * exotic origin (e.g. one with `&` in a query string from a future
 * change) cannot break out of the command.
 */
function snippetFor(format: SnippetFormat, url: string, filename: string): string {
  // Escape any single quote in the filename so it survives single-
  // quoted shell interpolation: `O'Brien.pdf` -> `O'\''Brien.pdf`.
  const safeFilename = filename.replace(/'/g, "'\\''");
  switch (format) {
    case "url":
      return url;
    case "curl":
      // -f: fail loudly on HTTP errors instead of writing the error body.
      // -L: follow redirects (the SPA may redirect /api/files/* in future).
      // -O: write to a file rather than stdout.
      // -J: honour Content-Disposition for the filename.
      return `curl -fLOJ '${url}'`;
    case "wget":
      // --content-disposition: same intent as curl -J.
      return `wget --content-disposition '${url}'`;
    case "powershell":
      return `Invoke-WebRequest -Uri '${url}' -OutFile '${safeFilename}'`;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export default function QuickShare({
  connectionId,
  protocol,
  onClose,
  sidebarWidth,
  sessionBarCollapsed,
}: Props) {
  const [files, setFiles] = useState<QuickShareFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Default format picked from the connection protocol but operator-
  // overridable via the dropdown — e.g. an SSH user on Windows might
  // want the PowerShell variant instead of curl.
  const [format, setFormat] = useState<SnippetFormat>(() => defaultFormatFor(protocol));
  const fileInputRef = useRef<HTMLInputElement>(null);

  // If the active session changes (different protocol) reset the
  // format to the new protocol's default. The user's per-session
  // override is intentionally not persisted across sessions.
  useEffect(() => {
    setFormat(defaultFormatFor(protocol));
  }, [protocol]);

  const loadFiles = useCallback(async () => {
    try {
      const list = await listQuickShareFiles(connectionId);
      setFiles(list);
    } catch {
      // ignore — may not have any files yet
    }
  }, [connectionId]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  const handleUpload = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      setError(null);
      setUploading(true);
      try {
        for (const file of Array.from(fileList)) {
          await uploadQuickShareFile(connectionId, file);
        }
        await loadFiles();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Upload failed");
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [connectionId, loadFiles]
  );

  const handleDelete = useCallback(async (token: string) => {
    try {
      await deleteQuickShareFile(token);
      setFiles((f) => f.filter((file) => file.token !== token));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }, []);

  const buildSnippet = useCallback(
    (file: QuickShareFile) => {
      const url = `${window.location.origin}${file.download_url}`;
      return snippetFor(format, url, file.filename);
    },
    [format]
  );

  const copyUrl = useCallback(
    (file: QuickShareFile) => {
      const text = buildSnippet(file);
      navigator.clipboard.writeText(text).then(() => {
        setCopiedToken(file.token);
        setTimeout(() => setCopiedToken(null), 2000);
      });
    },
    [buildSnippet]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      handleUpload(e.dataTransfer.files);
    },
    [handleUpload]
  );

  return (
    <div
      className="fixed top-0 bottom-0 z-[101] w-[320px] bg-surface-secondary border-l border-white/10 shadow-2xl flex flex-col"
      style={{ right: sessionBarCollapsed ? 0 : sidebarWidth }}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-white/5 bg-black/20">
        <div className="flex items-center gap-2">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span className="text-sm font-bold tracking-tight">Quick Share</span>
        </div>
        <button onClick={onClose} className="text-txt-secondary hover:text-txt-primary">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Upload area */}
      <div className="p-4 border-b border-white/5">
        <div
          role="button"
          tabIndex={0}
          aria-label="Drop files or click to browse"
          className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer ${dragOver ? "border-accent bg-accent/10" : "border-white/10 hover:border-white/20 hover:bg-white/5"}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => handleUpload(e.target.files)}
          />
          {uploading ? (
            <div className="flex flex-col items-center gap-2">
              <svg
                className="animate-spin"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="10" opacity="0.25" />
                <path d="M12 2a10 10 0 019.5 7" opacity="0.75" />
              </svg>
              <span className="text-[0.7rem] text-txt-secondary">Uploading...</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-txt-tertiary"
              >
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <span className="text-[0.7rem] text-txt-secondary">
                Drop files or click to upload
              </span>
              <span className="text-[0.6rem] text-txt-tertiary">Max 500 MB per file</span>
            </div>
          )}
        </div>
        {error && (
          <div className="mt-2 p-2 rounded bg-red-500/10 border border-red-500/20 text-[0.7rem] text-red-400">
            {error}
          </div>
        )}
        <p className="mt-2 text-[0.6rem] text-txt-tertiary leading-relaxed">
          Files are temporary. Copy the URL and paste it in the remote session to download. Files
          are automatically deleted when the session ends.
        </p>
      </div>

      {/* Snippet format picker. Only meaningful when there are files
          to copy, but always rendering it keeps the layout stable. */}
      <div className="px-4 py-2 border-b border-white/5 flex items-center gap-3">
        <span className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary shrink-0">
          Copy as
        </span>
        <div className="flex-1">
          <Select
            value={format}
            onChange={(v) => setFormat(v as SnippetFormat)}
            options={[
              { value: "url", label: "URL" },
              { value: "curl", label: "curl (Linux / macOS)" },
              { value: "wget", label: "wget (Linux)" },
              { value: "powershell", label: "PowerShell (Windows)" },
            ]}
          />
        </div>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-auto p-4">
        {files.length === 0 ? (
          <div className="text-center text-[0.7rem] text-txt-tertiary py-8">
            No files shared yet
          </div>
        ) : (
          <div className="space-y-2">
            {files.map((file) => (
              <div
                key={file.token}
                className="p-3 rounded-lg bg-white/5 border border-white/5 hover:border-white/10 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div
                      className="text-[0.75rem] font-medium text-txt-primary truncate"
                      title={file.filename}
                    >
                      {file.filename}
                    </div>
                    <div className="text-[0.6rem] text-txt-tertiary mt-0.5">
                      {formatSize(file.size)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      className={`p-1.5 rounded transition-colors ${copiedToken === file.token ? "bg-green-500/20 text-green-400" : "bg-white/5 hover:bg-white/10 text-txt-secondary hover:text-txt-primary"}`}
                      onClick={() => copyUrl(file)}
                      title="Copy download URL"
                    >
                      {copiedToken === file.token ? (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <rect x="9" y="9" width="13" height="13" rx="2" />
                          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                        </svg>
                      )}
                    </button>
                    <button
                      className="p-1.5 rounded bg-white/5 hover:bg-red-500/20 text-txt-secondary hover:text-red-400 transition-colors"
                      onClick={() => handleDelete(file.token)}
                      title="Delete file"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                        <path d="M10 11v6" />
                        <path d="M14 11v6" />
                        <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
                      </svg>
                    </button>
                  </div>
                </div>
                {/* URL display */}
                <div className="mt-2 flex gap-1">
                  <input
                    type="text"
                    readOnly
                    value={buildSnippet(file)}
                    className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-1 text-[0.6rem] font-mono text-txt-secondary"
                    onClick={(e) => {
                      (e.target as HTMLInputElement).select();
                      copyUrl(file);
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
