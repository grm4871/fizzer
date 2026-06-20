#!/usr/bin/env bash
set -euo pipefail

SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
CMD_TOOLS="$SDK_ROOT/cmdline-tools/latest"
DOWNLOAD_URL="https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip"

if [[ -x "$CMD_TOOLS/bin/sdkmanager" ]]; then
  echo "Android SDK command-line tools already installed at $CMD_TOOLS"
else
  echo "Installing Android SDK command-line tools into $SDK_ROOT"
  mkdir -p "$SDK_ROOT/cmdline-tools"
  tmp_zip="$(mktemp /tmp/cmdline-tools.XXXXXX.zip)"
  curl -fsSL "$DOWNLOAD_URL" -o "$tmp_zip"
  tmp_dir="$(mktemp -d)"
  unzip -q "$tmp_zip" -d "$tmp_dir"
  rm -rf "$CMD_TOOLS"
  mv "$tmp_dir/cmdline-tools" "$CMD_TOOLS"
  rm -rf "$tmp_dir" "$tmp_zip"
fi

export ANDROID_HOME="$SDK_ROOT"
export ANDROID_SDK_ROOT="$SDK_ROOT"
export PATH="$CMD_TOOLS/bin:$SDK_ROOT/platform-tools:$PATH"

yes | sdkmanager --licenses >/dev/null
sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"

cat > "$SDK_ROOT/../android-sdk.env" <<EOF
export ANDROID_HOME="$SDK_ROOT"
export ANDROID_SDK_ROOT="$SDK_ROOT"
export PATH="$CMD_TOOLS/bin:$SDK_ROOT/platform-tools:\$PATH"
EOF

echo "Android SDK ready."
echo "Source $SDK_ROOT/../android-sdk.env before building."
echo "Android builds require JDK 21 (JDK 26 is unsupported by Gradle)."
echo "Portable JDK 21 is expected at: $HOME/.local/jdks/jdk-21.0.11+10"