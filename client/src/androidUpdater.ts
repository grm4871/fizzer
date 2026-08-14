import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type AndroidUpdateMetadata = {
  available: boolean;
  versionCode: number;
  versionName: string;
  url: string;
};

type InstalledVersion = { versionCode: number; versionName: string; canInstall: boolean };
type UpdateProgress = { downloaded: number; total: number };
type AppUpdaterPlugin = {
  getInstalledVersion(): Promise<InstalledVersion>;
  install(options: { url: string; versionCode: number }): Promise<{ installerOpened?: boolean; permissionRequired?: boolean }>;
  addListener(eventName: 'appUpdateProgress', callback: (progress: UpdateProgress) => void): Promise<PluginListenerHandle>;
};

const updater = registerPlugin<AppUpdaterPlugin>('AppUpdater');

export function isAndroidUpdateAvailable(installed: number, metadata: AndroidUpdateMetadata): boolean {
  return metadata.available && Number.isFinite(metadata.versionCode) && metadata.versionCode > installed;
}

export async function checkAndroidUpdate(): Promise<{
  installed: InstalledVersion;
  metadata: AndroidUpdateMetadata;
} | null> {
  if (Capacitor.getPlatform() !== 'android') return null;
  const [installed, response] = await Promise.all([
    updater.getInstalledVersion(),
    fetch('/api/system/android-update', { credentials: 'include', cache: 'no-store' }),
  ]);
  if (!response.ok) throw new Error(`Update check failed with HTTP ${response.status}.`);
  const metadata = await response.json() as AndroidUpdateMetadata;
  return isAndroidUpdateAvailable(installed.versionCode, metadata) ? { installed, metadata } : null;
}

export function installAndroidUpdate(
  metadata: AndroidUpdateMetadata,
  onProgress: (progress: UpdateProgress) => void,
): Promise<{ installerOpened?: boolean; permissionRequired?: boolean; removeListener: () => Promise<void> }> {
  let handle: PluginListenerHandle | undefined;
  return updater.addListener('appUpdateProgress', onProgress).then((listener) => {
    handle = listener;
    return updater.install({
      url: new URL(metadata.url, window.location.origin).toString(),
      versionCode: metadata.versionCode,
    });
  }).then((result) => ({
    ...result,
    removeListener: () => handle?.remove() || Promise.resolve(),
  })).catch(async (error) => {
    await handle?.remove();
    throw error;
  });
}
