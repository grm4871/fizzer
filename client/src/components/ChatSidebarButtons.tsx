import type { MouseEvent, ReactNode } from 'react';
import { Bot, PanelRightClose, PanelRightOpen, Plus, SlidersHorizontal, UserPlus } from 'lucide-react';

export type SidebarButtonItem = { id: string; icon: ReactNode; onClick: () => void; title: string; selected?: boolean; badge?: number };
export const createSidebarButton = (item: SidebarButtonItem) => item;

const styles = `
.csb{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;padding:7px 4px 6px}
.csb.collapsed{display:flex;flex-direction:column;align-items:center;padding:7px 0 0}
.csb button{position:relative;width:100%;min-height:24px;padding:3px 6px;display:inline-flex;align-items:center;justify-content:center;gap:1px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-surface);color:var(--text-secondary);cursor:pointer}
.csb.collapsed button{width:28px;padding:3px}
.csb button:hover,.csb button.selected{border-color:var(--border-active);background:var(--bg-raised)}
.csb-badge{position:absolute;top:-5px;right:-5px;min-width:14px;height:14px;padding:0 3px;border-radius:999px;background:var(--accent);color:var(--bg-base);font-size:.5625rem;font-weight:700;line-height:14px;text-align:center}
`;

type Props = {
  collapsed: boolean; inviteSelected: boolean; agentSelected: boolean; settingsSelected: boolean;
  onToggleCollapsed: () => void; onInvite: () => void; onAgent: () => void; onSettings: () => void;
};

export function ChatSidebarButtons(p: Props) {
  const buttons = [
    createSidebarButton({ id: 'collapse', icon: p.collapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />, onClick: p.onToggleCollapsed, title: p.collapsed ? 'Expand chat users' : 'Minimize chat users' }),
    createSidebarButton({ id: 'invite', icon: <UserPlus size={14} />, onClick: p.onInvite, title: 'Invite user', selected: p.inviteSelected }),
    createSidebarButton({ id: 'agent', icon: <><Bot size={14} /><Plus size={12} color="var(--text-tertiary)" /></>, onClick: p.onAgent, title: 'Add agent', selected: p.agentSelected }),
    // The agent-settings panel (working directory, task workspaces) had no way
    // to be opened before this button existed.
    createSidebarButton({ id: 'settings', icon: <SlidersHorizontal size={14} />, onClick: p.onSettings, title: 'Agent settings', selected: p.settingsSelected }),
  ];
  const click = (event: MouseEvent<HTMLButtonElement>, item: SidebarButtonItem) => { event.stopPropagation(); item.onClick(); };
  return <><style>{styles}</style><div className={`csb${p.collapsed ? ' collapsed' : ''}`}>{buttons.map((item) => (
    <button key={item.id} type="button" className={item.selected ? 'selected' : ''} title={item.title} aria-label={item.title} aria-pressed={item.selected} onClick={(event) => click(event, item)}>
      {item.icon}{Boolean(item.badge) && <span className="csb-badge">{item.badge}</span>}
    </button>
  ))}</div></>;
}
