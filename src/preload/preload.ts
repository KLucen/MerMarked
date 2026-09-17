import { contextBridge, ipcRenderer } from 'electron';
import type { MerMarkdApi } from '../types/reader-api';

const api: MerMarkdApi = Object.freeze({
  appName: 'MerMarkd',
  openMarkdown: () => ipcRenderer.invoke('document:open'),
  readDocumentImage: (relativePath: string) =>
    ipcRenderer.invoke('document:read-image', relativePath),
  openExternal: (url: string) => ipcRenderer.invoke('external:open', url),
});

contextBridge.exposeInMainWorld('mermarkd', api);
