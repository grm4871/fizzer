package com.cascade.browser;

import android.content.Context;
import android.os.BatteryManager;
import android.os.Build;
import android.os.PowerManager;
import android.os.Process;
import android.net.TrafficStats;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Lightweight, on-demand process and battery readings. No background service or wake lock. */
@CapacitorPlugin(name = "BatteryMonitor")
public class BatteryMonitorPlugin extends Plugin {
  private static void putBatteryProperty(JSObject result, BatteryManager manager, String key, int property) {
    int value = manager.getIntProperty(property);
    if (value != Integer.MIN_VALUE) result.put(key, value);
  }

  @PluginMethod
  public void getSnapshot(PluginCall call) {
    Context context = getContext();
    BatteryManager battery = (BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
    PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
    JSObject result = new JSObject();

    result.put("capturedAt", System.currentTimeMillis());
    result.put("elapsedRealtimeMs", android.os.SystemClock.elapsedRealtime());
    result.put("processCpuMs", Process.getElapsedCpuTime());
    result.put("uidRxBytes", TrafficStats.getUidRxBytes(Process.myUid()));
    result.put("uidTxBytes", TrafficStats.getUidTxBytes(Process.myUid()));
    result.put("powerSave", power != null && power.isPowerSaveMode());
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && power != null) {
      result.put("thermalStatus", power.getCurrentThermalStatus());
    }

    if (battery != null) {
      putBatteryProperty(result, battery, "levelPercent", BatteryManager.BATTERY_PROPERTY_CAPACITY);
      putBatteryProperty(result, battery, "chargeCounterUah", BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER);
      putBatteryProperty(result, battery, "currentNowUa", BatteryManager.BATTERY_PROPERTY_CURRENT_NOW);
      putBatteryProperty(result, battery, "currentAverageUa", BatteryManager.BATTERY_PROPERTY_CURRENT_AVERAGE);
      result.put("charging", battery.isCharging());
    }
    call.resolve(result);
  }
}
