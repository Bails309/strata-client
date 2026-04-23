import { useCallback, useEffect, useState } from "react";
import {
  Connection,
  UserTag,
  createAdminTag,
  deleteAdminTag,
  getAdminConnectionTagsAdmin,
  getAdminTagsAdmin,
  setAdminConnectionTags,
  updateAdminTag,
} from "../../api";

const ADMIN_TAG_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#f97316",
];

export default function TagsTab({
  connections,
  onSave,
}: {
  connections: Connection[];
  onSave: () => void;
}) {
  const [tags, setTags] = useState<UserTag[]>([]);
  const [connTagMap, setConnTagMap] = useState<Record<string, string[]>>({});
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(ADMIN_TAG_COLORS[0]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [assignTag, setAssignTag] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, m] = await Promise.all([getAdminTagsAdmin(), getAdminConnectionTagsAdmin()]);
      setTags(t);
      setConnTagMap(m);
    } catch {
      setError("Failed to load tags");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    setError("");
    try {
      const tag = await createAdminTag(newName.trim(), newColor);
      setTags((prev) => [...prev, tag]);
      setNewName("");
      setNewColor(ADMIN_TAG_COLORS[(tags.length + 1) % ADMIN_TAG_COLORS.length]);
      onSave();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to create tag");
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async (id: string) => {
    setSaving(true);
    setError("");
    try {
      const tag = await updateAdminTag(id, {
        name: editName.trim() || undefined,
        color: editColor || undefined,
      });
      setTags((prev) => prev.map((t) => (t.id === id ? tag : t)));
      setEditingId(null);
      onSave();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to update tag");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setSaving(true);
    setError("");
    try {
      await deleteAdminTag(id);
      setTags((prev) => prev.filter((t) => t.id !== id));
      setConnTagMap((prev) => {
        const next = { ...prev };
        for (const connId of Object.keys(next)) {
          next[connId] = next[connId].filter((tid) => tid !== id);
        }
        return next;
      });
      onSave();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to delete tag");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleConnection = async (tagId: string, connId: string) => {
    const current = connTagMap[connId] || [];
    const next = current.includes(tagId) ? current.filter((t) => t !== tagId) : [...current, tagId];
    try {
      await setAdminConnectionTags(connId, next);
      setConnTagMap((prev) => ({ ...prev, [connId]: next }));
    } catch {
      /* ignore */
    }
  };

  // Connections that have the currently-assigning tag
  const assignedConnIds = assignTag
    ? new Set(
        Object.entries(connTagMap)
          .filter(([, tids]) => tids.includes(assignTag))
          .map(([cid]) => cid)
      )
    : new Set<string>();

  return (
    <div className="card">
      <h3>Global Tags</h3>
      <p className="text-[0.8125rem] text-txt-secondary mb-4">
        Create tags that are visible to all users across the dashboard. Assign them to connections
        to help users organise their view.
      </p>

      {error && (
        <div className="rounded-md mb-3 px-3 py-2 bg-danger/10 text-danger text-[0.8125rem]">
          {error}
        </div>
      )}

      {/* Create new tag */}
      <div className="flex gap-2 items-end mb-6">
        <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
          <label>Tag Name</label>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Production, Staging, Critical"
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Color</label>
          <div className="flex gap-1">
            {ADMIN_TAG_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setNewColor(c)}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: "50%",
                  background: c,
                  border: newColor === c ? "2px solid white" : "2px solid transparent",
                  boxShadow: newColor === c ? `0 0 0 2px ${c}` : "none",
                  cursor: "pointer",
                }}
              />
            ))}
          </div>
        </div>
        <button
          className="btn-sm-primary"
          onClick={handleCreate}
          disabled={saving || !newName.trim()}
        >
          Create Tag
        </button>
      </div>

      {/* Tag list */}
      {tags.length === 0 ? (
        <p className="text-txt-tertiary text-[0.8125rem]">No global tags created yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Tag</th>
              <th>Connections</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tags.map((tag) => {
              const connCount = Object.values(connTagMap).filter((tids) =>
                tids.includes(tag.id)
              ).length;
              const isEditing = editingId === tag.id;
              return (
                <tr key={tag.id}>
                  <td>
                    {isEditing ? (
                      <div className="flex gap-2 items-center">
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="text-[0.8125rem] !py-1"
                          style={{ maxWidth: 160 }}
                          onKeyDown={(e) => e.key === "Enter" && handleUpdate(tag.id)}
                        />
                        <div className="flex gap-1">
                          {ADMIN_TAG_COLORS.map((c) => (
                            <button
                              key={c}
                              onClick={() => setEditColor(c)}
                              style={{
                                width: 18,
                                height: 18,
                                borderRadius: "50%",
                                background: c,
                                border:
                                  editColor === c ? "2px solid white" : "1px solid transparent",
                                boxShadow: editColor === c ? `0 0 0 1px ${c}` : "none",
                                cursor: "pointer",
                              }}
                            />
                          ))}
                        </div>
                      </div>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-[0.8125rem]">
                        <span
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: "50%",
                            background: tag.color,
                            display: "inline-block",
                          }}
                        />
                        {tag.name}
                      </span>
                    )}
                  </td>
                  <td className="text-[0.8125rem] text-txt-secondary">
                    {connCount} connection{connCount !== 1 ? "s" : ""}
                  </td>
                  <td>
                    <div className="flex gap-1">
                      {isEditing ? (
                        <>
                          <button
                            className="btn-sm text-xs"
                            onClick={() => handleUpdate(tag.id)}
                            disabled={saving}
                          >
                            Save
                          </button>
                          <button className="btn-sm text-xs" onClick={() => setEditingId(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className={`btn-sm text-xs ${assignTag === tag.id ? "!border-accent !text-accent" : ""}`}
                            onClick={() => setAssignTag(assignTag === tag.id ? null : tag.id)}
                          >
                            Assign
                          </button>
                          <button
                            className="btn-sm text-xs"
                            onClick={() => {
                              setEditingId(tag.id);
                              setEditName(tag.name);
                              setEditColor(tag.color);
                            }}
                          >
                            Edit
                          </button>
                          <button
                            className="btn-sm text-xs text-danger"
                            onClick={() => handleDelete(tag.id)}
                            disabled={saving}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* Connection assignment panel */}
      {assignTag && (
        <div className="mt-4 card" style={{ background: "var(--color-surface-secondary)" }}>
          <h4 className="text-[0.875rem] mb-2">
            Assign &ldquo;{tags.find((t) => t.id === assignTag)?.name}&rdquo; to connections
          </h4>
          <div style={{ maxHeight: 300, overflow: "auto" }}>
            {connections.length === 0 ? (
              <p className="text-txt-tertiary text-[0.8125rem]">No connections available.</p>
            ) : (
              connections.map((conn) => (
                <label
                  key={conn.id}
                  className="flex items-center gap-2 py-1 cursor-pointer text-[0.8125rem]"
                >
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={assignedConnIds.has(conn.id)}
                    onChange={() => handleToggleConnection(assignTag, conn.id)}
                  />
                  <span
                    className="badge badge-accent text-[0.625rem]"
                    style={{ padding: "1px 6px" }}
                  >
                    {conn.protocol.toUpperCase()}
                  </span>
                  {conn.name}
                  <span className="text-txt-tertiary ml-auto">
                    {conn.hostname}:{conn.port}
                  </span>
                </label>
              ))
            )}
          </div>
          <button className="btn-sm mt-3" onClick={() => setAssignTag(null)}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}
