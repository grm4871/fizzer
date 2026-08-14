package com.cascade.browser;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Signed sideload updater. Android's package installer retains final user consent. */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {
  private final ExecutorService executor = Executors.newSingleThreadExecutor();

  @PluginMethod
  public void getInstalledVersion(PluginCall call) {
    try {
      PackageInfo installed = installedInfo();
      JSObject result = new JSObject();
      result.put("versionCode", versionCode(installed));
      result.put("versionName", installed.versionName == null ? "" : installed.versionName);
      result.put("canInstall", canInstallPackages());
      call.resolve(result);
    } catch (Exception error) {
      call.reject(error.getMessage(), error);
    }
  }

  @PluginMethod
  public void install(PluginCall call) {
    String url = call.getString("url", "").trim();
    Integer expectedVersion = call.getInt("versionCode");
    if (!url.startsWith("https://") || expectedVersion == null) {
      call.reject("A secure update URL and version are required.");
      return;
    }
    try {
      if (expectedVersion <= versionCode(installedInfo())) {
        call.reject("The selected APK is not newer than this installation.");
        return;
      }
    } catch (Exception error) {
      call.reject(error.getMessage(), error);
      return;
    }
    if (!canInstallPackages()) {
      Intent permission = new Intent(
          Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
          Uri.parse("package:" + getContext().getPackageName())
      );
      permission.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      getContext().startActivity(permission);
      JSObject result = new JSObject();
      result.put("permissionRequired", true);
      call.resolve(result);
      return;
    }

    executor.execute(() -> {
      File updateDirectory = new File(getContext().getCacheDir(), "updates");
      File apk = new File(updateDirectory, "fizzer-update.apk");
      try {
        updateDirectory.mkdirs();
        download(url, apk);
        PackageInfo archive = archiveInfo(apk);
        if (archive == null || !getContext().getPackageName().equals(archive.packageName)) {
          throw new IllegalStateException("Downloaded APK is not a Fizzer package.");
        }
        long archiveVersion = versionCode(archive);
        if (archiveVersion != expectedVersion || archiveVersion <= versionCode(installedInfo())) {
          throw new IllegalStateException("Downloaded APK version does not match update metadata.");
        }
        if (!sameSigner(installedInfo(), archive)) {
          throw new SecurityException("Downloaded APK signature does not match installed Fizzer.");
        }

        Uri content = FileProvider.getUriForFile(
            getContext(),
            getContext().getPackageName() + ".fileprovider",
            apk
        );
        Intent installer = new Intent(Intent.ACTION_VIEW);
        installer.setDataAndType(content, "application/vnd.android.package-archive");
        installer.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(installer);
        JSObject result = new JSObject();
        result.put("installerOpened", true);
        call.resolve(result);
      } catch (Exception error) {
        apk.delete();
        call.reject(error.getMessage(), error);
      }
    });
  }

  private boolean canInstallPackages() {
    return Build.VERSION.SDK_INT < Build.VERSION_CODES.O
        || getContext().getPackageManager().canRequestPackageInstalls();
  }

  private void download(String source, File destination) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL(source).openConnection();
    connection.setConnectTimeout(20_000);
    connection.setReadTimeout(60_000);
    connection.setInstanceFollowRedirects(true);
    connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
    int status = connection.getResponseCode();
    if (status != HttpURLConnection.HTTP_OK) {
      connection.disconnect();
      throw new IllegalStateException("Update download failed with HTTP " + status + ".");
    }
    long total = connection.getContentLengthLong();
    long downloaded = 0;
    byte[] buffer = new byte[128 * 1024];
    try (BufferedInputStream input = new BufferedInputStream(connection.getInputStream());
         FileOutputStream output = new FileOutputStream(destination)) {
      int count;
      while ((count = input.read(buffer)) != -1) {
        output.write(buffer, 0, count);
        downloaded += count;
        if (downloaded == count || downloaded % (2 * 1024 * 1024) < count) {
          JSObject progress = new JSObject();
          progress.put("downloaded", downloaded);
          progress.put("total", total);
          notifyListeners("appUpdateProgress", progress);
        }
      }
      output.getFD().sync();
    } finally {
      connection.disconnect();
    }
  }

  @SuppressWarnings("deprecation")
  private PackageInfo archiveInfo(File apk) {
    int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
        ? PackageManager.GET_SIGNING_CERTIFICATES
        : PackageManager.GET_SIGNATURES;
    return getContext().getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), flags);
  }

  @SuppressWarnings("deprecation")
  private PackageInfo installedInfo() throws PackageManager.NameNotFoundException {
    int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
        ? PackageManager.GET_SIGNING_CERTIFICATES
        : PackageManager.GET_SIGNATURES;
    return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), flags);
  }

  @SuppressWarnings("deprecation")
  private long versionCode(PackageInfo info) {
    return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
  }

  @SuppressWarnings("deprecation")
  private Signature[] signers(PackageInfo info) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null) {
      return info.signingInfo.getApkContentsSigners();
    }
    return info.signatures == null ? new Signature[0] : info.signatures;
  }

  private boolean sameSigner(PackageInfo installed, PackageInfo archive) throws Exception {
    Signature[] current = signers(installed);
    Signature[] candidate = signers(archive);
    if (current.length == 0 || candidate.length == 0 || current.length != candidate.length) return false;
    byte[][] currentHashes = signatureHashes(current);
    byte[][] candidateHashes = signatureHashes(candidate);
    Arrays.sort(currentHashes, Arrays::compare);
    Arrays.sort(candidateHashes, Arrays::compare);
    return Arrays.deepEquals(currentHashes, candidateHashes);
  }

  private byte[][] signatureHashes(Signature[] signatures) throws Exception {
    byte[][] hashes = new byte[signatures.length][];
    for (int index = 0; index < signatures.length; index++) {
      hashes[index] = MessageDigest.getInstance("SHA-256").digest(signatures[index].toByteArray());
    }
    return hashes;
  }
}
