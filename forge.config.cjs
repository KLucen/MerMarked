module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'MerMarkd',
    // Allows deterministic offline packaging from an already verified Electron ZIP.
    electronZipDir: process.env.MERMARKD_ELECTRON_ZIP_DIR,
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'MerMarkd',
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        build: [
          { entry: 'src/main/main.ts', config: 'vite.main.config.mjs' },
          { entry: 'src/preload/preload.ts', config: 'vite.preload.config.mjs' },
        ],
        renderer: [
          { name: 'main_window', config: 'vite.renderer.config.mjs' },
        ],
      },
    },
  ],
};
