const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    asar: true,
    // Add your app icon (omit the extension, Forge finds .icns or .ico)
//    icon: './assets/icons/icon', 
    // This name appears in the Applications folder/Taskbar
    executableName: 'netaris', 
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel', // Windows
      config: {
        name: 'netaris',
        // The .exe icon for the installer itself
        setupIcon: './assets/icons/icon.ico', 
      },
    },
    {
      name: '@electron-forge/maker-zip', // macOS (Universal/Intel/ARM)
      platforms: ['darwin'],
    },
    {
      // macOS DMG: Highly recommended for Mac distribution
      name: '@electron-forge/maker-dmg',
      config: {
        //icon: './assets/icons/icon.icns',
        format: 'ULFO',
      },
    },
    {
      name: '@electron-forge/maker-deb', // Linux
      config: {
        options: {
          icon: './assets/icons/icon.png',
        }
      },
    },
    {
      name: '@electron-forge/maker-rpm', // Linux
      config: {},
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
