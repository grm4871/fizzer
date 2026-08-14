# Android local Codex preview

The Android beta can act as the account's Fizzer runner without Termux. The
APK packages the official ARM64 Linux-musl Codex executable as
`lib/arm64-v8a/libcodex.so`; Android extracts it into the app's executable
native-library directory. Codex uses only Fizzer's private app storage:

- `files/codex-home/.codex` for device-login credentials and Codex state;
- `files/codex-workspace` for the agent workspace;
- `cache` for temporary files.

Settings → Local Codex performs device-code login and explicitly switches the
account runner to the phone. Enabling is never automatic because the backend
has one active runner per owner; registering the phone intentionally replaces
the desktop runner until the desktop reconnects.

Runs are foreground-only. Fizzer holds `FLAG_KEEP_SCREEN_ON` while Codex or
device login is active and clears it afterward. Closing/backgrounding the app
is not yet a durable pause/resume boundary.

`npm run android:apk` downloads the pinned official ARM64 package, verifies the
embedded executable SHA-256, and produces the beta APK. The binary is not
checked into Git. This preview currently supports ARM64 Android only, a single
private workspace, plain prompt execution, streamed agent messages, and
cancellation. Images, durable event replay across WebView death, Git tooling,
and native workspace import/export remain outside the proof of concept.
