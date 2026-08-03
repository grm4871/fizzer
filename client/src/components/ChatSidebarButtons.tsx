import type { MouseEvent, ReactNode } from 'react';
import { Bot, PanelRightClose, PanelRightOpen, Plus, Settings2, UserPlus } from 'lucide-react';

export type SidebarButtonItem = { id: string; icon: ReactNode; onClick: () => void; title: string; selected?: boolean; badge?: number };
export const createSidebarButton = (item: SidebarButtonItem) => item;

type Props = {
  collapsed: boolean; inviteSelected: boolean; agentSelected: boolean; settingsSelected: boolean;
  onToggleCollapsed: () => void; onInvite: () => void; onAgent: () => void; onSettings: () => void;
};

export function ChatSidebarButtons(p: Props) {
  const buttons = [
    createSidebarButton({ id: 'collapse', icon: p.collapsed ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />, onClick: p.onToggleCollapsed, title: p.collapsed ? 'Expand members' : 'Collapse members' }),
    createSidebarButton({ id: 'invite', icon: <UserPlus size={14} />, onClick: p.onInvite, title: 'Invite person', selected: p.inviteSelected }),
    createSidebarButton({ id: 'agent', icon: <><Bot size={14} /><Plus size={11} className="csb-plus" /></>, onClick: p.onAgent, title: 'Add agent', selected: p.agentSelected }),
    createSidebarButton({ id: 'settings', icon: <Settings2 size={14} />, onClick: p.onSettings, title: 'Agent settings', selected: p.settingsSelected }),
  ];
  const click = (event: MouseEvent<HTMLButtonElement>, item: SidebarButtonItem) => { event.stopPropagation(); item.onClick(); };
  return (
    <div className={`csb${p.collapsed ? ' is-collapsed' : ''}`} role="toolbar" aria-label="Channel members tools">
      {buttons.map((item) => (
        <button
          key={item.id}
          type="button"
          className={item.selected ? 'is-selected' : undefined}
          title={item.title}
          aria-label={item.title}
          aria-pressed={item.selected}
          onClick={(event) => click(event, item)}
        >
          {item.icon}
          {Boolean(item.badge) && <span className="csb-badge">{item.badge}</span>}
        </button>
      ))}
    </div>
  );
}
