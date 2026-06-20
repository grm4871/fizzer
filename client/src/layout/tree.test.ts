import { describe, it, expect } from 'vitest';
import {
  createPane,
  getAllPanes,
  findPaneByTab,
  getActiveTabIds,
  addTabToPane,
  removeTab,
  moveTab,
  splitPaneWithTab,
  setSplitSizes,
  simplify,
  ensureValid,
  migrateFromLegacy,
  isPane,
  type LayoutNode,
  type SplitNode,
} from './tree';

describe('layout tree', () => {
  it('creates a pane with the first tab active by default', () => {
    const pane = createPane(['a', 'b']);
    expect(pane.activeTabId).toBe('a');
    expect(pane.tabIds).toEqual(['a', 'b']);
  });

  it('adds a tab to a pane and makes it active', () => {
    let tree: LayoutNode = createPane(['a']);
    tree = addTabToPane(tree, tree.id, 'b');
    const pane = getAllPanes(tree)[0];
    expect(pane.tabIds).toEqual(['a', 'b']);
    expect(pane.activeTabId).toBe('b');
  });

  it('removes a tab and picks a sensible neighbour as active', () => {
    let tree: LayoutNode = createPane(['a', 'b', 'c'], 'b');
    tree = removeTab(tree, 'b');
    const pane = getAllPanes(tree)[0];
    expect(pane.tabIds).toEqual(['a', 'c']);
    expect(pane.activeTabId).toBe('a');
  });

  it('splits a pane to the right, moving the tab into a new pane', () => {
    let tree: LayoutNode = createPane(['a', 'b'], 'a');
    const rootPaneId = tree.id;
    tree = splitPaneWithTab(tree, rootPaneId, 'right', 'b');
    expect(isPane(tree)).toBe(false);
    const split = tree as SplitNode;
    expect(split.direction).toBe('row');
    expect(split.children).toHaveLength(2);
    const [left, right] = split.children.map((c) => getAllPanes(c)[0]);
    expect(left.tabIds).toEqual(['a']);
    expect(right.tabIds).toEqual(['b']);
  });

  it('keeps each tab in exactly one pane when moving across panes', () => {
    let tree: LayoutNode = createPane(['a', 'b'], 'a');
    tree = splitPaneWithTab(tree, tree.id, 'right', 'b');
    const [paneA] = getAllPanes(tree);
    // Move 'b' back into pane A.
    tree = moveTab(tree, 'b', paneA.id);
    expect(findPaneByTab(tree, 'b')?.id).toBe(paneA.id);
    // Only one pane remains after simplify collapses the emptied split child.
    expect(getAllPanes(tree)).toHaveLength(1);
    expect(getAllPanes(tree)[0].tabIds.sort()).toEqual(['a', 'b']);
  });

  it('collapses the tree when a pane empties out', () => {
    let tree: LayoutNode = createPane(['a'], 'a');
    tree = splitPaneWithTab(tree, tree.id, 'bottom', 'b');
    expect(getAllPanes(tree)).toHaveLength(2);
    tree = simplify(removeTab(tree, 'b'));
    expect(getAllPanes(tree)).toHaveLength(1);
    expect(getAllPanes(tree)[0].tabIds).toEqual(['a']);
  });

  it('flattens nested same-direction splits', () => {
    let tree: LayoutNode = createPane(['a'], 'a');
    tree = splitPaneWithTab(tree, tree.id, 'right', 'b'); // row [a | b]
    const rightPane = getAllPanes(tree)[1];
    tree = splitPaneWithTab(tree, rightPane.id, 'right', 'c'); // nested row inside row
    const split = tree as SplitNode;
    expect(split.direction).toBe('row');
    expect(split.children.every(isPane)).toBe(true);
    expect(split.children).toHaveLength(3);
  });

  it('preserves custom split sizes through a no-op simplify', () => {
    let tree: LayoutNode = createPane(['a'], 'a');
    tree = splitPaneWithTab(tree, tree.id, 'right', 'b');
    tree = setSplitSizes(tree, tree.id, [0.7, 0.3]);
    const after = simplify(tree) as SplitNode;
    expect(after.sizes[0]).toBeCloseTo(0.7);
    expect(after.sizes[1]).toBeCloseTo(0.3);
  });

  it('prunes unknown tab ids in ensureValid', () => {
    let tree: LayoutNode = createPane(['a', 'gone'], 'gone');
    tree = ensureValid(tree, new Set(['a']));
    const pane = getAllPanes(tree)[0];
    expect(pane.tabIds).toEqual(['a']);
    expect(pane.activeTabId).toBe('a');
  });

  it('migrates a legacy split session into a two-pane row', () => {
    const tree = migrateFromLegacy(['a', 'b', 'c'], 'a', 'b');
    expect(isPane(tree)).toBe(false);
    expect(getActiveTabIds(tree).sort()).toEqual(['a', 'b']);
    // 'c' rides along in the main pane.
    expect(findPaneByTab(tree, 'c')).not.toBeNull();
  });

  it('migrates a legacy single-pane session into one pane', () => {
    const tree = migrateFromLegacy(['a', 'b'], 'b', null);
    expect(isPane(tree)).toBe(true);
    expect(getAllPanes(tree)[0].activeTabId).toBe('b');
  });
});
