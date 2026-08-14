package com.cascade.browser;

import android.os.Bundle;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

/**
 * Capacitor host for Pixel / fold / targetSdk 36.
 *
 * Do NOT call EdgeToEdge.enable() before super — that races the Android 12+
 * splash handoff and left a permanent white "Cascade" splash strip over the
 * WebView. Install the splash, let BridgeActivity set content + theme, then
 * draw behind system bars so CSS env(safe-area-inset-*) can pad the chrome.
 */
public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    // Required when the launch theme parents Theme.SplashScreen — without this
    // the splash window can stick forever on API 31+ (white Cascade banner).
    SplashScreen.installSplashScreen(this);
    registerPlugin(BatteryMonitorPlugin.class);
    registerPlugin(LocalCodexPlugin.class);
    super.onCreate(savedInstanceState);

    // After content view exists: draw under system bars (no light letterbox).
    // Safe-area is applied in CSS (viewport-fit=cover) — do not also pad the
    // native host or double-inset stacks into empty bands above the keyboard.
    WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

    WindowInsetsControllerCompat controller =
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
    if (controller != null) {
      // Graphite UI → light status/nav glyphs.
      controller.setAppearanceLightStatusBars(false);
      controller.setAppearanceLightNavigationBars(false);
    }
  }
}
