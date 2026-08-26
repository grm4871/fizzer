import type { DragEvent } from 'react';
import type { Folder } from '../../api';

/**
 * DnD contract: notes move into a folder or between same-parent siblings;
 * folders additionally support before/inside/after placement. Every position
 * is calculated after removing the moving item, so both drag directions match
 * the persisted order and a folder can never be dropped into its descendants.
 */
export const FOLDER_DND_TYPE = 'application/x-cascade-folder';
export const ROOT_DROP_ID = '__root__';

export type DropPlacement = 'before' | 'inside' | 'after';

/** Final insertion index after removing the dragged item from its old slot. */
export function sidebarInsertionIndex(
  orderedIds: string[],
  movingId: string,
  targetId: string,
  placement: Exclude<DropPlacement, 'inside'>,
): number {
  const withoutMoving = orderedIds.filter((id) => id !== movingId);
  const targetIndex = withoutMoving.indexOf(targetId);
  if (targetIndex < 0) return withoutMoving.length;
  return targetIndex + (placement === 'after' ? 1 : 0);
}

export function isInvalidFolderTarget(
  folderId: string,
  targetFolderId: string | null,
  folders: Folder[],
): boolean {
  if (folderId === targetFolderId) return true;
  let current = targetFolderId ? folders.find((folder) => folder.id === targetFolderId) : undefined;
  while (current) {
    if (current.parent_id === folderId) return true;
    current = current.parent_id ? folders.find((folder) => folder.id === current!.parent_id) : undefined;
  }
  return false;
}

export function nextFolderPosition(
  childFolders: Map<string | null, Folder[]>,
  parentId: string | null,
  movingFolderId: string,
): number {
  return (childFolders.get(parentId) ?? []).filter((folder) => folder.id !== movingFolderId).length;
}

export function rowPlacement(event: DragEvent, allowInside: boolean): DropPlacement {
  const rect = event.currentTarget.getBoundingClientRect();
  const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
  if (!allowInside) return ratio < 0.5 ? 'before' : 'after';
  if (ratio < 0.25) return 'before';
  if (ratio > 0.75) return 'after';
  return 'inside';
}
