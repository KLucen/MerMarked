module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'MerMarkd',
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
