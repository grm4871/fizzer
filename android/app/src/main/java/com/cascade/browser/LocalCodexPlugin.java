package com.cascade.browser;

import android.content.pm.ApplicationInfo;
import android.view.WindowManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** Foreground-only local Codex proof of concept for the Android beta. */
@CapacitorPlugin(name = "LocalCodex")
public class LocalCodexPlugin extends Plugin {
  private final ExecutorService executor = Executors.newCachedThreadPool();
  private final Map<Integer, Process> activeRuns = new ConcurrentHashMap<>();
  private volatile Process loginProcess;

  private File codexHome() {
    File directory = new File(getContext().getFilesDir(), "codex-home");
    directory.mkdirs();
    return directory;
  }

  private File workspace() {
    File directory = new File(getContext().getFilesDir(), "codex-workspace");
    directory.mkdirs();
    return directory;
  }

  private File codexConfigHome() {
    File directory = new File(codexHome(), ".codex");
    directory.mkdirs();
    return directory;
  }

  private String binaryPath() {
    ApplicationInfo info = getContext().getApplicationInfo();
    return new File(info.nativeLibraryDir, "libcodex.so").getAbsolutePath();
  }

  private ProcessBuilder process(List<String> arguments) {
    List<String> command = new ArrayList<>();
    command.add(binaryPath());
    command.addAll(arguments);
    ProcessBuilder builder = new ProcessBuilder(command);
    builder.directory(workspace());
    builder.redirectErrorStream(true);
    Map<String, String> environment = builder.environment();
    environment.put("HOME", codexHome().getAbsolutePath());
    environment.put("CODEX_HOME", codexConfigHome().getAbsolutePath());
    environment.put("TMPDIR", getContext().getCacheDir().getAbsolutePath());
    environment.put("PATH", "/system/bin:/system/xbin");
    environment.put("TERM", "dumb");
    return builder;
  }

  private void keepScreenOn(boolean keepOn) {
    if (getActivity() == null) return;
    getActivity().runOnUiThread(() -> {
      if (keepOn) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
      else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    });
  }

  private void emit(String kind, Integer runId, String line, Integer exitCode) {
    JSObject event = new JSObject();
    event.put("kind", kind);
    if (runId != null) event.put("runId", runId);
    if (line != null) event.put("line", line);
    if (exitCode != null) event.put("exitCode", exitCode);
    notifyListeners("localCodexEvent", event, true);
  }

  @PluginMethod
  public void getStatus(PluginCall call) {
    executor.execute(() -> {
      JSObject result = new JSObject();
      result.put("supported", new File(binaryPath()).canExecute());
      result.put("authenticated", new File(codexConfigHome(), "auth.json").isFile());
      result.put("enabled", getContext().getSharedPreferences("local-codex", 0).getBoolean("enabled", false));
      result.put("workspace", workspace().getAbsolutePath());
      try {
        Process child = process(List.of("--version")).start();
        String version;
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(child.getInputStream(), StandardCharsets.UTF_8))) {
          version = reader.readLine();
        }
        boolean exited = child.waitFor(10, TimeUnit.SECONDS);
        if (!exited) child.destroyForcibly();
        result.put("version", version == null ? "" : version.trim());
        if (!exited || child.exitValue() != 0) result.put("error", "Bundled Codex could not start on this device.");
      } catch (Exception error) {
        result.put("error", error.getMessage());
      }
      call.resolve(result);
    });
  }

  @PluginMethod
  public void setEnabled(PluginCall call) {
    boolean enabled = call.getBoolean("enabled", false);
    getContext().getSharedPreferences("local-codex", 0).edit().putBoolean("enabled", enabled).apply();
    JSObject result = new JSObject();
    result.put("enabled", enabled);
    call.resolve(result);
  }

  @PluginMethod
  public void login(PluginCall call) {
    if (loginProcess != null && loginProcess.isAlive()) {
      call.reject("Codex login is already running.");
      return;
    }
    String requestId = UUID.randomUUID().toString();
    JSObject accepted = new JSObject();
    accepted.put("requestId", requestId);
    call.resolve(accepted);
    executor.execute(() -> {
      keepScreenOn(true);
      try {
        loginProcess = process(List.of("login", "--device-auth")).start();
        emit("login-started", null, null, null);
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(loginProcess.getInputStream(), StandardCharsets.UTF_8))) {
          String line;
          while ((line = reader.readLine()) != null) emit("login-output", null, line, null);
        }
        int code = loginProcess.waitFor();
        emit(code == 0 ? "login-completed" : "login-failed", null, null, code);
      } catch (Exception error) {
        emit("login-failed", null, error.getMessage(), -1);
      } finally {
        loginProcess = null;
        if (activeRuns.isEmpty()) keepScreenOn(false);
      }
    });
  }

  @PluginMethod
  public void startAgentRun(PluginCall call) {
    Integer runId = call.getInt("runId");
    String prompt = call.getString("prompt", "").trim();
    if (runId == null || prompt.isEmpty()) {
      call.reject("runId and prompt are required.");
      return;
    }
    if (activeRuns.containsKey(runId)) {
      JSObject existing = new JSObject();
      existing.put("success", true);
      call.resolve(existing);
      return;
    }

    List<String> arguments = new ArrayList<>();
    arguments.add("exec");
    arguments.add("--json");
    arguments.add("--skip-git-repo-check");
    String sandbox = call.getString("sandbox", "");
    if ("read-only".equals(sandbox)) {
      arguments.add("--sandbox");
      arguments.add("read-only");
    } else {
      arguments.add("--dangerously-bypass-approvals-and-sandbox");
    }
    String model = call.getString("model");
    if (model != null && !model.isBlank()) {
      arguments.add("--model");
      arguments.add(model);
    }
    arguments.add("-C");
    arguments.add(workspace().getAbsolutePath());
    arguments.add(prompt);

    try {
      Process child = process(arguments).start();
      activeRuns.put(runId, child);
      keepScreenOn(true);
      JSObject result = new JSObject();
      result.put("success", true);
      call.resolve(result);
      emit("run-started", runId, null, null);
      executor.execute(() -> {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(child.getInputStream(), StandardCharsets.UTF_8))) {
          String line;
          while ((line = reader.readLine()) != null) emit("run-output", runId, line, null);
          int code = child.waitFor();
          emit(code == 0 ? "run-completed" : "run-failed", runId, null, code);
        } catch (Exception error) {
          emit("run-failed", runId, error.getMessage(), -1);
        } finally {
          activeRuns.remove(runId);
          if (activeRuns.isEmpty() && (loginProcess == null || !loginProcess.isAlive())) keepScreenOn(false);
        }
      });
    } catch (Exception error) {
      call.reject(error.getMessage());
    }
  }

  @PluginMethod
  public void cancelAgentRun(PluginCall call) {
    Integer runId = call.getInt("runId");
    Process child = runId == null ? null : activeRuns.get(runId);
    boolean success = child != null;
    if (child != null) child.destroy();
    JSObject result = new JSObject();
    result.put("success", success);
    call.resolve(result);
  }

  @PluginMethod
  public void getState(PluginCall call) {
    JSArray ids = new JSArray();
    for (Integer runId : activeRuns.keySet()) ids.put(runId);
    JSObject result = new JSObject();
    result.put("instanceId", "android-local-codex");
    result.put("activeRunIds", ids);
    call.resolve(result);
  }
}
