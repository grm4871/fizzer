// Electron Forge config. The packaged app is a thin shell that loads
// https://cscd.online (see main.cjs) and includes the local agent runtime.
// The zip maker works everywhere; native installers (.dmg/.exe/.deb/.rpm) are
// gated behind the platform tooling that produces them.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';

const has = (bin) => {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); return true; }
  catch { return false; }
};
const configDir = path.dirname(fileURLToPath(import.meta.url));

// Always: a runnable zipped app bundle for whichever --platform is requested.
const makers = [new MakerZIP({}, ['darwin', 'linux', 'win32'])];

// Native installers, only where the toolchain exists.
if (process.platform === 'darwin') makers.push(new MakerDMG({}));
if (process.platform === 'win32' || (has('wine') && has('mono'))) makers.push(new MakerSquirrel({ name: 'Fizzer' }));
if (has('dpkg') && has('fakeroot')) makers.push(new MakerDeb({ options: { name: 'fizzer', productName: 'Fizzer' } }));
if (has('rpmbuild')) makers.push(new MakerRpm({ options: { name: 'fizzer', productName: 'Fizzer' } }));

export default {
  packagerConfig: {
    name: 'Fizzer',
    executableName: 'cascade',
    asar: true,
    // agent-runner.cjs loads the generated local-agent implementation from
    // resources/dist at runtime. Packaging only this Electron directory makes
    // a shell that opens but cannot run or reap agents.
    extraResource: [path.resolve(configDir, '..', 'dist')],
  },
  makers,
};
