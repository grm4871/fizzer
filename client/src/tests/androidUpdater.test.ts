import { describe, expect, it } from 'vitest';
import { isAndroidUpdateAvailable } from '../androidUpdater';

describe('Android updater', () => {
  it('offers only a published version newer than the installed APK', () => {
    const metadata = { available: true, versionCode: 10, versionName: 'ten', url: '/download/android' };
    expect(isAndroidUpdateAvailable(9, metadata)).toBe(true);
    expect(isAndroidUpdateAvailable(10, metadata)).toBe(false);
    expect(isAndroidUpdateAvailable(11, metadata)).toBe(false);
    expect(isAndroidUpdateAvailable(9, { ...metadata, available: false })).toBe(false);
  });
});
