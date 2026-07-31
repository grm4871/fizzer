import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Solo-user **dev build**: the WebView loads the live site, so client deploys
 * land without reinstalling the APK. Reinstall only when native shell changes
 * (splash, edge-to-edge, permissions, etc.).
 *
 * Launcher label is "Cascade Dev". Bundled `webDir` is only a cold-start
 * fallback if the device is offline at launch.
 */
const LIVE_APP_URL =
  process.env.CASCADE_ANDROID_LIVE_URL?.trim() || 'https://cscd.online/app.html';

const config: CapacitorConfig = {
  appId: 'com.cascade.browser',
  appName: 'Cascade Dev',
  webDir: 'client/dist',
  android: {
    allowMixedContent: true,
  },
  server: {
    androidScheme: 'https',
    // Remote shell — production SPA + API same-origin on cscd.online.
    url: LIVE_APP_URL,
    cleartext: false,
  },
};

export default config;