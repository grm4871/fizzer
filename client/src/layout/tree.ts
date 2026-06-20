/**
 * @file tree.ts — Recursive pane-layout tree for the tiling grid
 *
 * The workspace is modelled as a binary-ish tree of panes and splits, decoupled
 * from the tab data itself: `openTabs` (in App.tsx) remains the global registry
 * of tab content, while this tree only references tabs by id and describes how
 * panes are arranged on screen. A `PaneNode` is a leaf that hosts a set of tabs
 * (with one active); a `SplitNode` lays its children out in a row or column.
 *
 * Every tab id lives in exactly one pane — moving a tab between panes removes it
 * from the source. This keeps a 1:1 mapping between a tab and the single live
 * <webview>/editor that renders it, so dragging a web tab between panes never
 * spawns a duplicate or reloads the page.
 *
 * All operations are pure and return a new tree (no mutation), which makes them
 * trivial to unit-test and safe to drop into React state.
 */

export type PaneNode = {
  type: 'pane';
  id: string;
  tabIds: string[];
  activeTabId: string | null;
};

export type SplitNode = {
  type: 'split';
  id: string;
  direction: 'row' | 'column';
  children: LayoutNode[];
  /** Fractions (summing to 1) giving each child's share of the split axis. */
  sizes: number[];
};

export type LayoutNode = PaneNode | SplitNode;

/** Where a dropped tab lands relative to a target pane. */
export type DropSide = 'left' | 'right' | 'top' | 'bottom' | 'center';

// ─── id generation ──────────────────────────────────────────────
let idCounter = 0;
function genId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

// ─── constructors / guards ──────────────────────────────────────
export function createPane(tabIds: string[] = [], activeTabId: string | null = null): PaneNode {
  return {
    type: 'pane',
    id: genId('pane'),
    tabIds: [...tabIds],
    activeTabId: activeTabId ?? tabIds[0] ?? null,
  };
}

export function isPane(node: LayoutNode): node is PaneNode {
  return node.type === 'pane';
}

// ─── queries ────────────────────────────────────────────────────
export function getAllPanes(node: LayoutNode): PaneNode[] {
  if (isPane(node)) return [node];
  return node.children.flatMap(getAllPanes);
}

/** The first pane in tree order — used as a focus fallback. */
export function getFirstPane(node: LayoutNode): PaneNode {
  return getAllPanes(node)[0] ?? createPane();
}

export function findPane(node: LayoutNode, paneId: string): PaneNode | null {
  return getAllPanes(node).find((pane) => pane.id === paneId) ?? null;
}

export function findPaneByTab(node: LayoutNode, tabId: string): PaneNode | null {
  return getAllPanes(node).find((pane) => pane.tabIds.includes(tabId)) ?? null;
}

/** Active tab id of every pane (excluding empty panes). */
export function getActiveTabIds(node: LayoutNode): string[] {
  return getAllPanes(node)
    .map((pane) => pane.activeTabId)
    .filter((id): id is string => Boolean(id));
}

// ─── internal helpers ───────────────────────────────────────────
function equalSizes(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count);
}

function normalize(sizes: number[]): number[] {
  const total = sizes.reduce((sum, value) => sum + (value > 0 ? value : 0), 0);
  if (!total) return equalSizes(sizes.length);
  return sizes.map((value) => (value > 0 ? value : 0) / total);
}

/** Replace the node whose id matches `targetId` with `replacer(node)`. */
function replaceNode(
  node: LayoutNode,
  targetId: string,
  replacer: (found: LayoutNode) => LayoutNode,
): LayoutNode {
  if (node.id === targetId) return replacer(node);
  if (isPane(node)) return node;
  return { ...node, children: node.children.map((child) => replaceNode(child, targetId, replacer)) };
}

/** Apply `fn` to every pane, rebuilding the tree immutably. */
function mapPanes(node: LayoutNode, fn: (pane: PaneNode) => PaneNode): LayoutNode {
  if (isPane(node)) return fn(node);
  return { ...node, children: node.children.map((child) => mapPanes(child, fn)) };
}

// ─── mutations (pure) ───────────────────────────────────────────
export function setActiveTab(tree: LayoutNode, paneId: string, tabId: string): LayoutNode {
  return mapPanes(tree, (pane) =>
    pane.id === paneId && pane.tabIds.includes(tabId) ? { ...pane, activeTabId: tabId } : pane,
  );
}

/** Insert (or reorder) `tabId` in a pane and make it active. */
export function addTabToPane(
  tree: LayoutNode,
  paneId: string,
  tabId: string,
  index?: number,
): LayoutNode {
  return mapPanes(tree, (pane) => {
    if (pane.id !== paneId) return pane;
    const without = pane.tabIds.filter((id) => id !== tabId);
    const at = index === undefined ? without.length : Math.max(0, Math.min(index, without.length));
    const tabIds = [...without.slice(0, at), tabId, ...without.slice(at)];
    return { ...pane, tabIds, activeTabId: tabId };
  });
}

/**
 * Remove a tab from whichever pane holds it. The pane stays in the tree even if
 * it becomes empty; call `simplify` afterwards to collapse it.
 */
export function removeTab(tree: LayoutNode, tabId: string): LayoutNode {
  return mapPanes(tree, (pane) => {
    if (!pane.tabIds.includes(tabId)) return pane;
    const tabIds = pane.tabIds.filter((id) => id !== tabId);
    let activeTabId = pane.activeTabId;
    if (activeTabId === tabId) {
      const removedAt = pane.tabIds.indexOf(tabId);
      activeTabId = tabIds[removedAt - 1] ?? tabIds[removedAt] ?? tabIds[tabIds.length - 1] ?? null;
    }
    return { ...pane, tabIds, activeTabId };
  });
}

/** Move a tab into `toPaneId` (also handles reordering within the same pane). */
export function moveTab(
  tree: LayoutNode,
  tabId: string,
  toPaneId: string,
  index?: number,
): LayoutNode {
  const removed = removeTab(tree, tabId);
  const added = addTabToPane(removed, toPaneId, tabId, index);
  return simplify(added);
}

/**
 * Split `paneId` along the given side, placing `tabId` in a new pane on that
 * side. `center` simply docks the tab into the target pane. The tab is removed
 * from its previous location first.
 */
export function splitPaneWithTab(
  tree: LayoutNode,
  paneId: string,
  side: DropSide,
  tabId: string,
): LayoutNode {
  if (side === 'center') return moveTab(tree, tabId, paneId);

  const detached = removeTab(tree, tabId);
  const newPane = createPane([tabId], tabId);
  const direction: SplitNode['direction'] = side === 'left' || side === 'right' ? 'row' : 'column';
  const before = side === 'left' || side === 'top';

  const next = replaceNode(detached, paneId, (target) => {
    const children = before ? [newPane, target] : [target, newPane];
    return { type: 'split', id: genId('split'), direction, children, sizes: equalSizes(2) };
  });

  return simplify(next);
}

/** Replace a split's child sizes (used by divider drag). */
export function setSplitSizes(tree: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  return replaceNode(tree, splitId, (node) => {
    if (isPane(node) || node.children.length !== sizes.length) return node;
    return { ...node, sizes: normalize(sizes) };
  }) as LayoutNode;
}

/**
 * Collapse empty panes, unwrap single-child splits, and flatten nested splits of
 * the same direction. Sizes are preserved when a split's child count is
 * unchanged and reset to equal otherwise. Always returns at least one pane.
 */
export function simplify(node: LayoutNode): LayoutNode {
  if (isPane(node)) return node;

  let children = node.children
    .map(simplify)
    .filter((child) => !(isPane(child) && child.tabIds.length === 0));

  // Flatten same-direction splits so resizing stays predictable.
  const flattened: LayoutNode[] = [];
  for (const child of children) {
    if (!isPane(child) && child.direction === node.direction) {
      flattened.push(...child.children);
    } else {
      flattened.push(child);
    }
  }
  children = flattened;

  if (children.length === 0) return createPane();
  if (children.length === 1) return children[0];

  const sizes =
    node.sizes && node.sizes.length === children.length
      ? normalize(node.sizes)
      : equalSizes(children.length);
  return { ...node, children, sizes };
}

/**
 * Validate a (possibly persisted) tree against the set of currently-open tab
 * ids: drop unknown tab ids, repair each pane's `activeTabId`, and simplify.
 * Always yields a tree with at least one pane.
 */
export function ensureValid(node: LayoutNode, validTabIds: Set<string>): LayoutNode {
  const pruned = mapPanes(node, (pane) => {
    const tabIds = pane.tabIds.filter((id) => validTabIds.has(id));
    const activeTabId =
      pane.activeTabId && tabIds.includes(pane.activeTabId) ? pane.activeTabId : tabIds[0] ?? null;
    return { ...pane, tabIds, activeTabId };
  });
  return simplify(pruned);
}

/**
 * Build a layout tree from the legacy single-pane + optional split-pane model so
 * sessions saved before the tiling grid keep their arrangement on first load.
 */
export function migrateFromLegacy(
  tabIds: string[],
  activeTabId: string | null,
  splitTabId: string | null,
): LayoutNode {
  const base = createPane(tabIds, activeTabId);
  if (splitTabId && splitTabId !== activeTabId && tabIds.includes(splitTabId)) {
    return splitPaneWithTab(base, base.id, 'right', splitTabId);
  }
  return base;
}
