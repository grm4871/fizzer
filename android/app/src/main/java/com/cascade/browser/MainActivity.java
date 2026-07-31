package com.cascade.browser;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

/**
 * Capacitor host. Explicit edge-to-edge so targetSdk 36 / Pixel fold does not
 * letterbox the WebView with light system-bar strips on top and bottom.
 */
public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    // Before super so BridgeActivity's content view inherits edge-to-edge layout.
    EdgeToEdge.enable(this);
    super.onCreate(savedInstanceState);

    WindowInsetsControllerCompat controller =
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
    if (controller != null) {
      // Dark graphite UI → light (white) status/nav glyphs.
      controller.setAppearanceLightStatusBars(false);
      controller.setAppearanceLightNavigationBars(false);
    }
  }
}
