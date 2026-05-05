/* eslint-disable react-hooks/refs --
   react-hooks v7 compiler-strict suppressions: legitimate prop->state sync, session
   decoration, or render-time time/derivation patterns. See
   eslint.config.js W4-1 commentary. */
import { useState, useCallback, useRef } from "react";
import Guacamole from "guacamole-common-js";

interface FileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  mimetype?: string;
}

interface Props {
  filesystem: { object: Guacamole.GuacObject; name: string };
  onClose: () => void;
}

/**
 * File browser for Guacamole filesystem objects (RDP drive, SFTP).
 * Supports directory navigation, file download, and file upload.
 */
export default function FileBrowser({ filesystem, onClose }: Props) {
  const [path, setPath] = useState<string[]>([]);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploads, setUploads] = useState<{ name: string; progress: number }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadedRef = useRef(false);

  const loadDirectory = useCallback(
    (dirPath: string[]) => {
      setLoading(true);
      const streamPath = "/" + dirPath.join("/");

      filesystem.object.requestInputStream(streamPath, (stream, mimetype) => {
        // The root/directory listing comes as a JSON stream index
        if (mimetype === "application/vnd.glyptodon.guacamole.stream-index+json") {
          const reader = new Guacamole.StringReader(stream);
          let json = "";
          reader.ontext = (text: string) => {
            json += text;
          };
          reader.onend = () => {
            try {
              const index = JSON.parse(json);
              const items: FileEntry[] = Object.keys(index).map((name) => {
                const mimetype = index[name];
                const isDir = mimetype === "application/vnd.glyptodon.guacamole.stream-index+json";
                return {
                  name,
                  type: isDir ? ("directory" as const) : ("file" as const),
                  mimetype,
                };
              });
              items.sort((a, b) => {
                if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
                return a.name.localeCompare(b.name);
              });
              setEntries(items);
            } catch {
              setEntries([]);
            }
            setLoading(false);
          };
        } else {
          setLoading(false);
        }
      });
    },
    [filesystem.object]
  );

  // Load root on first render
  if (!loadedRef.current) {
    loadedRef.current = true;
    loadDirectory([]);
  }

  const navigateTo = useCallback(
    (dirName: string) => {
      const newPath = [...path, dirName];
      setPath(newPath);
      loadDirectory(newPath);
    },
    [path, loadDirectory]
  );

  const navigateUp = useCallback(
    (index: number) => {
      const newPath = path.slice(0, index);
      setPath(newPath);
      loadDirectory(newPath);
    },
    [path, loadDirectory]
  );

  const downloadFile = useCallback(
    (fileName: string) => {
      const filePath = "/" + [...path, fileName].join("/");
      filesystem.object.requestInputStream(filePath, (stream, mimetype) => {
        const reader = new Guacamole.BlobReader(stream, mimetype);
        reader.onend = () => {
          const blob = reader.getBlob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        };
      });
    },
    [path, filesystem.object]
  );

  const handleUpload = useCallback(
    (files: FileList) => {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const uploadPath = "/" + [...path, file.name].join("/");
        const stream = filesystem.object.createOutputStream(
          file.type || "application/octet-stream",
          uploadPath
        );
        const writer = new Guacamole.BlobWriter(stream);

        const uploadEntry = { name: file.name, progress: 0 };
        setUploads((prev) => [...prev, uploadEntry]);

        writer.onprogress = (_blob: Blob, offset: number) => {
          setUploads((prev) =>
            prev.map((u) =>
              u.name === file.name ? { ...u, progress: Math.round((offset / file.size) * 100) } : u
            )
          );
        };

        writer.oncomplete = () => {
          setUploads((prev) =>
            prev.map((u) => (u.name === file.name ? { ...u, progress: 100 } : u))
          );
          // Refresh directory listing after upload
          setTimeout(() => {
            loadDirectory(path);
            setUploads((prev) => prev.filter((u) => u.name !== file.name));
          }, 500);
        };

        writer.onerror = () => {
          setUploads((prev) => prev.filter((u) => u.name !== file.name));
        };

        writer.sendBlob(file);
      }
    },
    [path, filesystem.object, loadDirectory]
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span className="text-[0.8125rem] font-semibold">{filesystem.name}</span>
        <button
          onClick={onClose}
          className="btn-sm"
          style={{ padding: "2px 8px", fontSize: "0.75rem" }}
        >
          Back
        </button>
      </div>

      {/* Breadcrumbs */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          fontSize: "0.75rem",
          flexWrap: "wrap",
        }}
      >
        <button
          onClick={() => navigateUp(0)}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "2px 4px",
            color: "var(--color-accent)",
            fontWeight: 600,
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </button>
        {path.map((segment, i) => (
          <span key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span className="text-txt-tertiary">/</span>
            <button
              onClick={() => navigateUp(i + 1)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "2px 4px",
                color: i === path.length - 1 ? "var(--color-txt-primary)" : "var(--color-accent)",
                fontWeight: i === path.length - 1 ? 600 : 400,
              }}
            >
              {segment}
            </button>
          </span>
        ))}
      </div>

      {/* File list */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          border: "1px solid var(--color-border)",
          borderRadius: 4,
          background: "var(--color-input-bg)",
        }}
      >
        {loading ? (
          <div className="text-txt-tertiary text-center py-4 text-[0.75rem]">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="text-txt-tertiary text-center py-4 text-[0.75rem]">Empty directory</div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.name}
              role="button"
              tabIndex={0}
              onDoubleClick={() => {
                if (entry.type === "directory") navigateTo(entry.name);
                else downloadFile(entry.name);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (entry.type === "directory") navigateTo(entry.name);
                  else downloadFile(entry.name);
                }
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 10px",
                cursor: "pointer",
                fontSize: "0.75rem",
                borderBottom: "1px solid var(--color-border)",
              }}
              className="hover:bg-surface-secondary"
              title={
                entry.type === "directory" ? "Double-click to open" : "Double-click to download"
              }
            >
              {entry.type === "directory" ? (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="var(--color-accent)"
                  stroke="none"
                >
                  <path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                </svg>
              ) : (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--color-txt-tertiary)"
                  strokeWidth="2"
                >
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              )}
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {entry.name}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Upload area */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            handleUpload(e.target.files);
            e.target.value = "";
          }
        }}
      />
      <button
        className="btn-sm-primary w-full"
        style={{ justifyContent: "center" }}
        onClick={() => fileInputRef.current?.click()}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        Upload Files
      </button>

      {/* Upload progress */}
      {uploads.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {uploads.map((u) => (
            <div key={u.name} style={{ fontSize: "0.7rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                <span
                  className="text-txt-secondary"
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: "80%",
                  }}
                >
                  {u.name}
                </span>
                <span>{u.progress}%</span>
              </div>
              <div
                style={{
                  height: 3,
                  borderRadius: 2,
                  background: "var(--color-border)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${u.progress}%`,
                    background: "var(--color-accent)",
                    transition: "width 0.2s",
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
