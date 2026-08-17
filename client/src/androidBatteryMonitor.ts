import { Capacitor, registerPlugin } from '@capacitor/core';
import { api } from './api';

type BatterySnapshot = {
  capturedAt: number;
  elapsedRealtimeMs: number;
  processCpuMs: number;
  uidRxBytes: number;
  uidTxBytes: number;
  powerSave: boolean;
  thermalStatus?: number;
  levelPercent?: number;
  chargeCounterUah?: number;
  currentNowUa?: number;
  currentAverageUa?: number;
  charging?: boolean;
};

type BatteryMonitorPlugin = {
  getSnapshot(): Promise<BatterySnapshot>;
};

const BatteryMonitor = registerPlugin<BatteryMonitorPlugin>('BatteryMonitor');
const SAMPLE_INTERVAL_MS = 15 * 60 * 1000;
const SESSION_ID = typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export async function recordAndroidBatterySnapshot(reason: 'launch' | 'interval' | 'background' | 'resume') {
  if (Capacitor.getPlatform() !== 'android') return;
  try {
    const snapshot = await BatteryMonitor.getSnapshot();
    await api('/api/diagnostics/android-battery', {
      method: 'POST',
      body: JSON.stringify({
        ...snapshot,
        sessionId: SESSION_ID,
        reason,
        foreground: document.visibilityState === 'visible',
      }),
    });
  } catch (error) {
    // Diagnostics must never affect app behavior or create retry traffic.
    console.debug('Battery diagnostic sample skipped', error);
  }
}

export function startAndroidBatteryMonitoring() {
  if (Capacitor.getPlatform() !== 'android') return () => {};
  void recordAndroidBatterySnapshot('launch');
  const timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void recordAndroidBatterySnapshot('interval');
  }, SAMPLE_INTERVAL_MS);
  const onVisibility = () => {
    void recordAndroidBatterySnapshot(document.visibilityState === 'visible' ? 'resume' : 'background');
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
