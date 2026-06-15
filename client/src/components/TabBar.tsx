interface TabBarProps {
  tabs: { id: string; title: string; dirty: boolean }[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab }: TabBarProps) {
  if (tabs.length === 0) {
    return (
      <div className="tab-bar">
        <div className="tab-bar-empty">No open notes</div>
      </div>
    );
  }

  return (
    <div className="tab-bar" id="tab-bar">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          id={`tab-${tab.id}`}
          className={`tab-item ${tab.id === activeTabId ? 'active' : ''}`}
          onClick={() => onSelectTab(tab.id)}
          onMouseDown={(e) => {
            // Middle-click to close
            if (e.button === 1) {
              e.preventDefault();
              onCloseTab(tab.id);
            }
          }}
        >
          {tab.dirty && <span className="tab-dirty" />}
          <span className="tab-title">{tab.title || 'Untitled'}</span>
          <button
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation();
              onCloseTab(tab.id);
            }}
            title="Close tab"
          >
            ×
          </button>
        </button>
      ))}
    </div>
  );
}
