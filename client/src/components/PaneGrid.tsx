/**
 * @file PaneGrid.tsx — Recursive renderer for the tiling pane layout
 *
 * Walks a {@link LayoutNode} tree (see `../layout/tree.ts`) and renders it as
 * nested flex rows/columns with resizable dividers. Each leaf pane shows its own
 * tab strip plus the active tab's content (provided by the parent via
 * `renderContent`). Tabs can be dragged between panes; dropping near a pane edge
 * splits it, dropping in the centre (or on the strip) docks the tab into it.
 *
 * @component
 */

import { Fragment, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { FileText, ExternalLink, X, Hash, Plus } from 'lucide-react';
import type { Tab } from './TabBar';
import { isPane, type DropSide, type LayoutNode, type PaneNode, type SplitNode } from '../layout/tree';

const DRAG_MIME = 'application/x-cascade-tab';

export interface TabDragPayload {
  tabId: string;
  fromPaneId: string;
}

interface PaneGridProps {
  node: LayoutNode;
  openTabs: Tab[];
  focusedPaneId: string;
  onFocusPane: (paneId: string) => void;
  onSelectTab: (paneId: string, tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  /** A tab was dropped onto a pane; `index` only applies to `center` drops. */
  onDropTab: (payload: TabDragPayload, targetPaneId: string, side: DropSide, index?: number) => void;
  onResize: (splitId: string, sizes: number[]) => void;
  onCreateNote?: (paneId: string) => void;
  onCreateChat?: (paneId: string) => void;
  onPopOut?: (tabId: string) => void;
  /** A tab was dragged and released outside any pane; `screenX/screenY` are the
   *  drop point in screen pixels so the parent can pop it out at the cursor. */
  onDetachTab?: (tabId: string, screenX: number, screenY: number) => void;
  renderContent: (tab: Tab, paneId: string) => ReactNode;
}

const MIN_FRACTION = 0.12;

function readPayload(event: DragEvent): TabDragPayload | null {
  try {
    const raw = event.dataTransfer.getData(DRAG_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TabDragPayload;
    if (typeof parsed.tabId === 'string' && typeof parsed.fromPaneId === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Map pointer position within a rect to a drop side (centre vs the 4 edges). */
function sideFromPosition(rect: DOMRect, clientX: number, clientY: number): DropSide {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  const edge = 0.25;
  // Pick the nearest edge only when clearly outside the centre box.
  const distances: Array<{ side: DropSide; d: number }> = [
    { side: 'left', d: x },
    { side: 'right', d: 1 - x },
    { side: 'top', d: y },
    { side: 'bottom', d: 1 - y },
  ];
  distances.sort((a, b) => a.d - b.d);
  const nearest = distances[0];
  if (nearest.d > edge) return 'center';
  return nearest.side;
}

function TabIcon({ type }: { type: Tab['type'] }) {
  if (type === 'chat') return <Hash size={13} className="text-secondary" style={{ marginRight: 6 }} />;
  return <FileText size={13} className="text-tertiary" style={{ marginRight: 6 }} />;
}

// ─── Per-pane tab strip ─────────────────────────────────────────
function PaneTabStrip({
  pane,
  openTabs,
  isFocused,
  onSelectTab,
  onCloseTab,
  onDropTab,
  onCreateNote,
  onCreateChat,
  onPopOut,
  onDetachTab,
}: {
  pane: PaneNode;
  openTabs: Tab[];
  isFocused: boolean;
  onSelectTab: (paneId: string, tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onDropTab: PaneGridProps['onDropTab'];
  onCreateNote?: (paneId: string) => void;
  onCreateChat?: (paneId: string) => void;
  onPopOut?: (tabId: string) => void;
  onDetachTab?: (tabId: string, screenX: number, screenY: number) => void;
}) {
  const tabs = pane.tabIds
    .map((id) => openTabs.find((t) => t.id === id))
    .filter((t): t is Tab => Boolean(t));

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);

  useEffect(() => {
    const handleGlobalClick = () => setContextMenu(null);
    window.addEventListener('click', handleGlobalClick);
    return () => window.removeEventListener('click', handleGlobalClick);
  }, []);

  const handleContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      tabId,
    });
  };

  const handleDragStart = (event: DragEvent, tabId: string) => {
    const payload: TabDragPayload = { tabId, fromPaneId: pane.id };
    event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = 'move';
  };

  const handleStripDrop = (event: DragEvent, index?: number) => {
    const payload = readPayload(event);
    if (!payload) return;
    event.preventDefault();
    event.stopPropagation();
    onDropTab(payload, pane.id, 'center', index);
  };

  const allowDrop = (event: DragEvent) => {
    if (event.dataTransfer.types.includes(DRAG_MIME)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }
  };

  return (
    <div
      className={`tab-bar pane-tab-bar${isFocused ? ' is-focused' : ''}`}
      onDragOver={allowDrop}
      onDrop={(e) => handleStripDrop(e)}
    >
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          className={`tab-item ${tab.id === pane.activeTabId ? 'active' : ''}`}
          draggable
          onDragStart={(e) => handleDragStart(e, tab.id)}
          onDragEnd={(e) => {
            // dropEffect 'none' = released outside any pane drop target → detach
            // into its own window (the main process ignores in-window releases).
            if (e.dataTransfer.dropEffect === 'none') {
              onDetachTab?.(tab.id, e.screenX, e.screenY);
            }
          }}
          onDragOver={allowDrop}
          onDrop={(e) => handleStripDrop(e, index)}
          onClick={() => onSelectTab(pane.id, tab.id)}
          onContextMenu={(e) => handleContextMenu(e, tab.id)}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              onCloseTab(tab.id);
            }
          }}
          title={tab.title}
        >
          {tab.dirty && <span className="tab-dirty" />}
          <span className="tab-icon"><TabIcon type={tab.type} /></span>
          <span className="tab-title">{tab.title || 'Untitled'}</span>
          {onPopOut && (
            <span
              className="tab-popout"
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onPopOut(tab.id);
              }}
              title="Open in new window"
            >
              <ExternalLink size={11} />
            </span>
          )}
          <span
            className="tab-close"
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onCloseTab(tab.id);
            }}
            title="Close tab"
          >
            ×
          </span>
        </button>
      ))}
      {onCreateNote && (
        <button
          className="tab-new-btn"
          onClick={() => onCreateNote(pane.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            if (onCreateChat) onCreateChat(pane.id);
          }}
          title="New note (right-click for chat)"
          aria-label="New note"
        >
          <Plus size={14} />
        </button>
      )}
      {/* Right-click Context Menu */}
      {contextMenu && (
        <div
          className="tab-context-menu"
          style={{
            top: `${contextMenu.y}px`,
            left: `${contextMenu.x}px`,
          }}
        >
          {onPopOut && (
            <button
              onClick={() => {
                onPopOut(contextMenu.tabId);
              }}
            >
              <ExternalLink size={13} />
              Open in new window
            </button>
          )}
          <button
            onClick={() => {
              onCloseTab(contextMenu.tabId);
            }}
          >
            <X size={13} />
            Close tab
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Single pane ────────────────────────────────────────────────
function Pane({
  pane,
  openTabs,
  focusedPaneId,
  onFocusPane,
  onSelectTab,
  onCloseTab,
  onDropTab,
  onCreateNote,
  onCreateChat,
  onPopOut,
  onDetachTab,
  renderContent,
}: { pane: PaneNode } & Omit<PaneGridProps, 'node' | 'onResize'>) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [dropSide, setDropSide] = useState<DropSide | null>(null);
  // Keep visited tabs mounted (hidden) so switching doesn't remount ChatView /
  // NoteEditor and re-parse the whole transcript.
  const [mountedTabIds, setMountedTabIds] = useState<string[]>(() => (
    pane.activeTabId ? [pane.activeTabId] : []
  ));

  useEffect(() => {
    const active = pane.activeTabId;
    if (!active) return;
    setMountedTabIds((prev) => (prev.includes(active) ? prev : [...prev, active]));
  }, [pane.activeTabId]);

  useEffect(() => {
    // Drop keep-alives for tabs that left this pane.
    setMountedTabIds((prev) => {
      const next = prev.filter((id) => pane.tabIds.includes(id));
      return next.length === prev.length ? prev : next;
    });
  }, [pane.tabIds]);

  const handleDragOver = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes(DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const el = contentRef.current;
    if (el) setDropSide(sideFromPosition(el.getBoundingClientRect(), event.clientX, event.clientY));
  };

  const handleDrop = (event: DragEvent) => {
    const payload = readPayload(event);
    setDropSide(null);
    if (!payload) return;
    event.preventDefault();
    const el = contentRef.current;
    const side = el
      ? sideFromPosition(el.getBoundingClientRect(), event.clientX, event.clientY)
      : 'center';
    onDropTab(payload, pane.id, side);
  };

  const mountedTabs = mountedTabIds
    .map((id) => openTabs.find((t) => t.id === id))
    .filter((t): t is Tab => Boolean(t));

  return (
    <div
      className={`editor-pane pane${pane.id === focusedPaneId ? ' is-focused' : ''}`}
      style={{ flex: 1, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, minHeight: 0 }}
      onMouseDownCapture={() => onFocusPane(pane.id)}
    >
      <PaneTabStrip
        pane={pane}
        openTabs={openTabs}
        isFocused={pane.id === focusedPaneId}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onDropTab={onDropTab}
        onCreateNote={onCreateNote}
        onCreateChat={onCreateChat}
        onPopOut={onPopOut}
        onDetachTab={onDetachTab}
      />
      <div
        ref={(el) => {
          contentRef.current = el;
        }}
        className="pane-content"
        style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        onDragOver={handleDragOver}
        onDragLeave={() => setDropSide(null)}
        onDrop={handleDrop}
      >
        {mountedTabs.length === 0 ? (
          <div className="pane-empty">Empty pane</div>
        ) : (
          mountedTabs.map((tab) => {
            const active = tab.id === pane.activeTabId;
            return (
              <div
                key={tab.id}
                className="pane-tab-keepalive"
                hidden={!active}
                style={{
                  display: active ? 'flex' : 'none',
                  flex: 1,
                  minHeight: 0,
                  minWidth: 0,
                  flexDirection: 'column',
                  overflow: 'hidden',
                }}
              >
                {renderContent(tab, pane.id)}
              </div>
            );
          })
        )}
        {dropSide && <div className={`pane-dropzone pane-dropzone-${dropSide}`} />}
      </div>
    </div>
  );
}

// ─── Split (recursive) ──────────────────────────────────────────
function Split({ split, ...rest }: { split: SplitNode } & Omit<PaneGridProps, 'node'>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isRow = split.direction === 'row';

  const startResize = (event: React.MouseEvent, dividerIndex: number) => {
    event.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const total = isRow ? rect.width : rect.height;
    const start = isRow ? event.clientX : event.clientY;
    const startSizes = [...split.sizes];

    document.body.style.cursor = isRow ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';

    const onMove = (e: MouseEvent) => {
      const current = isRow ? e.clientX : e.clientY;
      let deltaFraction = (current - start) / total;
      const a = startSizes[dividerIndex];
      const b = startSizes[dividerIndex + 1];
      // Clamp so neither adjacent child shrinks below the minimum.
      deltaFraction = Math.max(-(a - MIN_FRACTION), Math.min(b - MIN_FRACTION, deltaFraction));
      const next = [...startSizes];
      next[dividerIndex] = a + deltaFraction;
      next[dividerIndex + 1] = b - deltaFraction;
      rest.onResize(split.id, next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      ref={containerRef}
      className="pane-split"
      style={{ display: 'flex', flexDirection: isRow ? 'row' : 'column', flex: 1, minWidth: 0, minHeight: 0, height: '100%', width: '100%' }}
    >
      {split.children.map((child, index) => (
        <Fragment key={child.id}>
          <div
            className="pane-split-child"
            style={{ display: 'flex', flexGrow: split.sizes[index] ?? 1, flexBasis: 0, minWidth: 0, minHeight: 0, overflow: 'hidden' }}
          >
            <PaneGrid node={child} {...rest} />
          </div>
          {index < split.children.length - 1 && (
            <div
              className={`pane-divider ${isRow ? 'pane-divider-vertical' : 'pane-divider-horizontal'}`}
              onMouseDown={(e) => startResize(e, index)}
              role="separator"
              aria-orientation={isRow ? 'vertical' : 'horizontal'}
              title="Drag to resize"
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}

export function PaneGrid(props: PaneGridProps) {
  const { node, ...rest } = props;
  if (isPane(node)) return <Pane pane={node} {...rest} />;
  return <Split split={node} {...rest} />;
}
