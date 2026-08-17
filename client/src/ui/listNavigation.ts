import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';

/** Keep a keyboard-selected list item valid when the list contents change. */
export function useListSelection<T extends HTMLElement>(
  listRef: RefObject<T | null>,
  selectedIndex: number,
  itemCount: number,
  setSelectedIndex: Dispatch<SetStateAction<number>>,
) {
  useEffect(() => {
    setSelectedIndex((current) => Math.min(Math.max(current, 0), Math.max(0, itemCount - 1)));
  }, [itemCount, setSelectedIndex]);

  useEffect(() => {
    const item = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [listRef, selectedIndex]);
}

export function moveListSelection(index: number, direction: -1 | 1, itemCount: number): number {
  return Math.min(Math.max(index + direction, 0), Math.max(0, itemCount - 1));
}
