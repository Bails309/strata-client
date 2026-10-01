import { useCallback, useMemo, useState } from "react";
import {
  ROLE_FLAGS,
  inheritedConnectionIds,
  symmetricDifferenceSize,
  type RoleDraft,
  type RoleFlag,
} from "./roleModel";

export interface RoleEditorInitial {
  draft: RoleDraft;
  folderIds: string[];
  connectionIds: string[];
}

const toggled = (set: ReadonlySet<string>, id: string) => {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

export function useRoleEditor(
  initial: RoleEditorInitial,
  connections: { id: string; folder_id?: string | null }[]
) {
  const [draft, setDraft] = useState<RoleDraft>(initial.draft);
  const [folderIds, setFolderIds] = useState<Set<string>>(() => new Set(initial.folderIds));
  const [connectionIds, setConnectionIds] = useState<Set<string>>(
    () => new Set(initial.connectionIds)
  );

  const inherited = useMemo(
    () => inheritedConnectionIds(folderIds, connections),
    [folderIds, connections]
  );

  const setField = useCallback((field: "name" | "description", value: string) => {
    setDraft((d) => ({ ...d, [field]: value }));
  }, []);

  const setSessionLimit = useCallback((limit: number) => {
    setDraft((d) => ({ ...d, sessionLimit: limit }));
  }, []);

  const toggleFlag = useCallback((flag: RoleFlag) => {
    setDraft((d) => ({ ...d, [flag]: !d[flag] }));
  }, []);

  const toggleFolder = useCallback((id: string) => setFolderIds((s) => toggled(s, id)), []);
  const toggleConnection = useCallback((id: string) => setConnectionIds((s) => toggled(s, id)), []);

  const initialFolders = useMemo(() => new Set(initial.folderIds), [initial.folderIds]);
  const initialConnections = useMemo(() => new Set(initial.connectionIds), [initial.connectionIds]);

  const permissionChanges = ROLE_FLAGS.filter((f) => draft[f] !== initial.draft[f]).length;
  const folderChanges = symmetricDifferenceSize(folderIds, initialFolders);
  const connectionChanges = symmetricDifferenceSize(connectionIds, initialConnections);
  const changeCount =
    (draft.name.trim() !== initial.draft.name.trim() ? 1 : 0) +
    (draft.description.trim() !== initial.draft.description.trim() ? 1 : 0) +
    (draft.sessionLimit !== initial.draft.sessionLimit ? 1 : 0) +
    permissionChanges +
    folderChanges +
    connectionChanges;

  return {
    draft,
    setField,
    setSessionLimit,
    toggleFlag,
    folderIds,
    toggleFolder,
    connectionIds,
    toggleConnection,
    inherited,
    changeCount,
    mappingsChanged: folderChanges + connectionChanges > 0,
  };
}
