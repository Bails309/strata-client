import { useState, useRef, useCallback, useEffect } from 'react';
import { uploadQuickShareFile, listQuickShareFiles, deleteQuickShareFile, QuickShareFile } from '../api';

interface Props {
  connectionId: string;
  onClose: () => void;
  sidebarWidth: number;
  sessionBarCollapsed: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export default function QuickShare({ connectionId, onClose, sidebarWidth, sessionBarCollapsed }: Props) {
  const [files, setFiles] = useState<QuickShareFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const handleUpload = useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      for (const file of Array.from(fileList)) {
        await uploadQuickShareFile(connectionId, file);
      }
      await loadFiles();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [connectionId, loadFiles]);

  const handleDelete = useCallback(async (token: string) => {
    try {
      await deleteQuickShareFile(token);
      setFiles(f => f.filter(file => file.token !== token));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }, []);

  const copyUrl = useCallback((file: QuickShareFile) => {
    const url = `${window.location.origin}${file.download_url}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedToken(file.token);
      setTimeout(() => setCopiedToken(null), 2000);
    });
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleUpload(e.dataTransfer.files);
  }, [handleUpload]);

  return (
    <div
      className="fixed top-0 bottom-0 z-[101] w-[320px] bg-surface-secondary border-l border-white/10 shadow-2xl flex flex-col"
      style={{ right: sessionBarCollapsed ? 0 : sidebarWidth }}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-white/5 bg-black/20">
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span className="text-sm font-bold tracking-tight">Quick Share</span>
        </div>
        <button onClick={onClose} className="text-txt-secondary hover:text-txt-primary">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Upload area */}
      <div className="p-4 border-b border-white/5">
        <div
          className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer ${dragOver ? 'border-accent bg-accent/10' : 'border-white/10 hover:border-white/20 hover:bg-white/5'}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
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
              <svg className="animate-spin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" opacity="0.25" /><path d="M12 2a10 10 0 019.5 7" opacity="0.75" />
              </svg>
              <span className="text-[0.7rem] text-txt-secondary">Uploading...</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-txt-tertiary">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <span className="text-[0.7rem] text-txt-secondary">Drop files or click to upload</span>
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
          Files are temporary. Copy the URL and paste it in the remote session to download. Files are automatically deleted when the session ends.
        </p>
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
              <div key={file.token} className="p-3 rounded-lg bg-white/5 border border-white/5 hover:border-white/10 transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[0.75rem] font-medium text-txt-primary truncate" title={file.filename}>
                      {file.filename}
                    </div>
                    <div className="text-[0.6rem] text-txt-tertiary mt-0.5">
                      {formatSize(file.size)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      className={`p-1.5 rounded transition-colors ${copiedToken === file.token ? 'bg-green-500/20 text-green-400' : 'bg-white/5 hover:bg-white/10 text-txt-secondary hover:text-txt-primary'}`}
                      onClick={() => copyUrl(file)}
                      title="Copy download URL"
                    >
                      {copiedToken === file.token ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                        </svg>
                      )}
                    </button>
                    <button
                      className="p-1.5 rounded bg-white/5 hover:bg-red-500/20 text-txt-secondary hover:text-red-400 transition-colors"
                      onClick={() => handleDelete(file.token)}
                      title="Delete file"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
                      </svg>
                    </button>
                  </div>
                </div>
                {/* URL display */}
                <div className="mt-2 flex gap-1">
                  <input
                    type="text"
                    readOnly
                    value={`${window.location.origin}${file.download_url}`}
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
