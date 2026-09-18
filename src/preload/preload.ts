import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AnnotationSelectionInput, MerMarkdApi } from '../types/reader-api';

const api: MerMarkdApi = Object.freeze({
  appName: 'MerMarkd',
  openMarkdown: () => ipcRenderer.invoke('document:open'),
  openDroppedMarkdown: (file: File) => {
    let droppedPath: string;
    try {
      droppedPath = webUtils.getPathForFile(file);
    } catch {
      throw new Error('请拖入单个本地 .md 文件。');
    }
    if (!droppedPath) {
      throw new Error('请拖入单个本地 .md 文件。');
    }
    return ipcRenderer.invoke('document:open-dropped', droppedPath);
  },
  readDocumentImage: (relativePath: string) =>
    ipcRenderer.invoke('document:read-image', relativePath),
  loadAnnotationSummary: () => ipcRenderer.invoke('annotations:load-summary'),
  saveSelectionProbe: (input: AnnotationSelectionInput) => ipcRenderer.invoke('annotations:save-probe', input),
  openExternal: (url: string) => ipcRenderer.invoke('external:open', url),
});

contextBridge.exposeInMainWorld('mermarkd', api);
