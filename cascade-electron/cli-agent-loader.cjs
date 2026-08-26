/** Cache-busting loader for the compiled ESM provider facade. */
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
let cliAgentModulePromise = null;
let cliAgentModuleMtimeMs = -1;
const activeCliAgentModules = new Map();
let warnedStaleCliAgentBuildAt = 0;

/**
 * CLI agents run from `dist/`, never from the TypeScript sources. Editing
 * `cli-agents/cli-agent.ts` without rebuilding therefore changes nothing at
 * runtime, and the symptom is indistinguishable from the fix not working. Say
 * so out loud instead of silently running last build's code.
 */
function warnIfCliAgentBuildIsStale(modPath, builtMtimeMs) {
  const srcPath = path.join(__dirname, '..', 'cli-agents', 'cli-agent.ts');
  let srcMtimeMs = 0;
  try { srcMtimeMs = fs.statSync(srcPath).mtimeMs; } catch { return; }
  if (!builtMtimeMs || srcMtimeMs <= builtMtimeMs) return;
  // Once a minute is enough; this is checked before every CLI launch.
  if (Date.now() - warnedStaleCliAgentBuildAt < 60_000) return;
  warnedStaleCliAgentBuildAt = Date.now();
  console.warn(
    `[agent-runner] STALE BUILD: ${srcPath} is newer than ${modPath}. `
    + 'CLI agents are running the previous build — run `npm run build` to apply your changes.',
  );
}

async function loadCliAgentModule() {
  const modPath = path.join(__dirname, '..', 'dist', 'cli-agents', 'cli-agent.js');
  // Bust cache when dist rebuilds so harness fixes apply without killing Electron.
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(modPath).mtimeMs; } catch { /* ignore */ }
  warnIfCliAgentBuildIsStale(modPath, mtimeMs);
  if (!cliAgentModulePromise) {
    cliAgentModuleMtimeMs = mtimeMs;
    const href = pathToFileURL(modPath).href + `?t=${mtimeMs || Date.now()}`;
    cliAgentModulePromise = import(href);
  } else if (cliAgentModuleMtimeMs !== mtimeMs && activeCliAgentModules.size === 0) {
    // A cache-busted ESM import creates a second module singleton. Shut down
    // the idle warm app-server before replacing it; otherwise both children
    // retain writer leases for different copies of the same session.
    const previousModule = cliAgentModulePromise;
    cliAgentModuleMtimeMs = mtimeMs;
    const href = pathToFileURL(modPath).href + `?t=${mtimeMs || Date.now()}`;
    cliAgentModulePromise = (async () => {
      const previous = await previousModule;
      previous.shutdownPersistentCliAgents?.();
      return import(href);
    })();
  }
  const mod = await cliAgentModulePromise;
  // Run before every CLI launch, not just module import. That makes recovery
  // deterministic in tests and also cleans up a prior runner host that died
  // without requiring an entire Electron relaunch.
  if (typeof mod.reapOrphanedCliAgentProcesses === 'function') {
    const reaped = await mod.reapOrphanedCliAgentProcesses();
    if (Array.isArray(reaped) && reaped.length > 0) {
      console.warn(`[agent-runner] reaped orphaned CLI runs after desktop crash: ${reaped.join(', ')}`);
    }
  }
  return mod;
}


module.exports = { activeCliAgentModules, loadCliAgentModule };
