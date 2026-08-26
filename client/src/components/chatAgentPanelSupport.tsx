import { formatChatTime } from '../chat/time';
import type { ChatAgentOption, PlanUsage, PlanUsageWindow } from '../chat/types';

export const CUSTOM_MODEL_VALUE = '__custom__';

export function resolveModelPicker(agent: ChatAgentOption | undefined, model: string): { choice: string; custom: string } {
  const trimmed = model.trim();
  if (!agent || agent.models.length === 0) return { choice: CUSTOM_MODEL_VALUE, custom: trimmed };
  if (!trimmed) return { choice: agent.models[0]?.id ?? '', custom: '' };
  if (agent.models.some((preset) => preset.id === trimmed)) return { choice: trimmed, custom: '' };
  return { choice: CUSTOM_MODEL_VALUE, custom: trimmed };
}

export function modelFromPicker(choice: string, custom: string) {
  return (choice === CUSTOM_MODEL_VALUE ? custom : choice).trim();
}

export const REASONING_EFFORTS = [
  { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' }, { id: 'max', label: 'Max' }, { id: 'ultra', label: 'Ultra' },
] as const;

export function ReasoningEffortSelect({ agentId, value, onChange }: { agentId: string; value: string; onChange: (value: string) => void }) {
  const defaultLabel = agentId === 'claude-code' ? 'Use Claude Code default' : 'Use Codex CLI default';
  const efforts = agentId === 'claude-code' ? REASONING_EFFORTS.filter((effort) => effort.id !== 'ultra') : REASONING_EFFORTS;
  return <select value={value} onChange={(event) => onChange(event.target.value)}><option value="">{defaultLabel}</option>{efforts.map((effort) => <option key={effort.id} value={effort.id}>{effort.label}</option>)}</select>;
}

export function planUsageProviderId(agentId: string) {
  if (agentId === 'akron-grok') return 'grok';
  if (agentId === 'hermes') return 'nous';
  return agentId;
}

function planUsageWindows(usage?: PlanUsage | null): PlanUsageWindow[] {
  if (!usage || usage.status !== 'ok') return [];
  if (usage.windows?.length) return usage.windows;
  if (typeof usage.usedPercent !== 'number') return [];
  return [{
    label: usage.windowMinutes ? `${Math.round(usage.windowMinutes / 60)}h` : 'usage',
    usedPercent: usage.usedPercent,
    ...(usage.windowMinutes ? { windowMinutes: usage.windowMinutes } : {}),
    ...(usage.resetsAt ? { resetsAt: usage.resetsAt } : {}),
    ...(usage.resetsLabel ? { resetsLabel: usage.resetsLabel } : {}),
  }];
}

function formatPlanUsageTitle(usage?: PlanUsage | null) {
  if (!usage) return '';
  if (usage.status !== 'ok') return usage.detail || 'Plan usage unavailable';
  const lines = planUsageWindows(usage).map((window) => {
    const reset = window.resetsLabel || (window.resetsAt ? formatChatTime(window.resetsAt) : '');
    return `${window.label}: ${Math.round(window.usedPercent)}% used${reset ? ` · ${reset}` : ''}`;
  });
  if (usage.planType) lines.push(`Plan: ${usage.planType}`);
  if (usage.detail) lines.push(usage.detail);
  return lines.join('\n');
}

export function PlanUsageMeters({ usage, stacked = false, decal = false }: { usage: PlanUsage; stacked?: boolean; decal?: boolean }) {
  const title = formatPlanUsageTitle(usage);
  if (usage.status !== 'ok') return decal ? null : <span className="chat-plan-meters is-unavailable" title={title}>usage unavailable</span>;
  const windows = planUsageWindows(usage).slice(0, 3);
  if (windows.length === 0) return null;
  return <span className={`chat-plan-meters${stacked ? ' is-stacked' : ''}${decal ? ' is-decal' : ''}`} title={title}>
    {windows.map((window, index) => {
      const percent = Math.round(window.usedPercent);
      return <span className="chat-plan-meter" key={`${window.label}:${index}`} role="progressbar" aria-label={`${window.label} plan usage ${percent}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span className="chat-plan-meter-label">{decal ? `${percent}%` : window.label}</span><span className="chat-plan-meter-track" aria-hidden="true"><span className="chat-plan-meter-fill" style={{ width: `${percent}%` }} /></span>{!decal && <span className="chat-plan-meter-value">{percent}%</span>}
      </span>;
    })}
    {!decal && usage.detail && (() => {
      const topUpMatch = usage.detail.match(/Top-up credits:\s*\$?([\d.]+)/i);
      const totalMatch = usage.detail.match(/Total usable:\s*\$?([\d.]+)/i);
      if (!topUpMatch && !totalMatch) return null;
      return <span className="chat-plan-meter-detail">{topUpMatch ? `top-up $${topUpMatch[1]}` : `usable $${totalMatch![1]}`}</span>;
    })()}
  </span>;
}
