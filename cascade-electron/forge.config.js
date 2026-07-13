// Electron Forge config. The packaged app is a thin shell that loads
// https://cscd.online (see main.cjs), plus a local better-sqlite3-backed runner
// host — so the native module is platform-specific and correct installers must
// be built on their target OS (or CI). The zip maker is pure-JS and works
// everywhere; native installers (.dmg/.exe/.deb/.rpm) are gated behind the
// platform tooling that produces them, so a build host only runs the makers it
// can actually satisfy.
import { execSync } from 'node:child_process';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';

const has = (bin) => {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); return true; }
  catch { return false; }
};

// Always: a runnable zipped app bundle for whichever --platform is requested.
const makers = [new MakerZIP({}, ['darwin', 'linux', 'win32'])];

// Native installers, only where the toolchain exists.
if (process.platform === 'darwin') makers.push(new MakerDMG({}));
if (process.platform === 'win32' || (has('wine') && has('mono'))) makers.push(new MakerSquirrel({ name: 'Cascade' }));
if (has('dpkg') && has('fakeroot')) makers.push(new MakerDeb({ options: { name: 'cascade', productName: 'Cascade' } }));
if (has('rpmbuild')) makers.push(new MakerRpm({ options: { name: 'cascade', productName: 'Cascade' } }));

export default {
  packagerConfig: {
    name: 'Cascade',
    executableName: 'cascade',
    asar: true,
  },
  makers,
  plugins: [new AutoUnpackNativesPlugin({})],
};
