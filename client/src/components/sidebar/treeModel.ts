import type { Folder, NoteSummary } from '../../api';

export function sortSidebarNotes(notes: NoteSummary[]): NoteSummary[] {
  return [...notes].sort((a, b) =>
    a.position - b.position
    || new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    || a.title.localeCompare(b.title),
  );
}

export interface SidebarTreeModel {
  visibleFolders: Folder[];
  rootFolders: Folder[];
  rootNotes: NoteSummary[];
  notesByFolder: Map<string | null, NoteSummary[]>;
  childFolders: Map<string | null, Folder[]>;
  flatFolders: { folder: Folder; depth: number }[];
}

/** Build the ordered, filtered indexes consumed by the tree and move menu. */
export function buildSidebarTreeModel(
  folders: Folder[],
  notes: NoteSummary[],
  showAgentMemory: boolean,
): SidebarTreeModel {
  const visibleFolders = filterVisibleFolders(folders, showAgentMemory);
  const rootFolders = visibleFolders
    .filter((folder) => folder.parent_id === null)
    .sort((a, b) => a.position - b.position);
  const listedNotes = notes.filter((note) => note.is_listed !== 0);
  const notesByFolder = new Map<string | null, NoteSummary[]>();
  for (const note of listedNotes) {
    const key = note.folder_id;
    if (!notesByFolder.has(key)) notesByFolder.set(key, []);
    notesByFolder.get(key)!.push(note);
  }
  for (const [key, folderNotes] of notesByFolder) notesByFolder.set(key, sortSidebarNotes(folderNotes));

  const childFolders = new Map<string | null, Folder[]>();
  for (const folder of visibleFolders) {
    const key = folder.parent_id;
    if (!childFolders.has(key)) childFolders.set(key, []);
    childFolders.get(key)!.push(folder);
  }
  for (const [, children] of childFolders) children.sort((a, b) => a.position - b.position);

  const flatFolders: { folder: Folder; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const folder of childFolders.get(parentId) ?? []) {
      flatFolders.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);

  return {
    visibleFolders,
    rootFolders,
    rootNotes: notesByFolder.get(null) ?? [],
    notesByFolder,
    childFolders,
    flatFolders,
  };
}

function filterVisibleFolders(folders: Folder[], showAgentMemory: boolean): Folder[] {
  if (showAgentMemory) return folders;
  const hidden = new Set(
    folders
      .filter((folder) => folder.parent_id === null && folder.name === '_agent')
      .map((folder) => folder.id),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (folder.parent_id && hidden.has(folder.parent_id) && !hidden.has(folder.id)) {
        hidden.add(folder.id);
        changed = true;
      }
    }
  }
  return folders.filter((folder) => !hidden.has(folder.id));
}
