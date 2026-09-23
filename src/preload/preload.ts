import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  CreateHighlightInput, CreateNoteInput, MerMarkdApi, RecolorHighlightInput, UpdateNoteInput,
} from '../types/reader-api';

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
  loadAnnotations: () => ipcRenderer.invoke('annotations:load'),
  createHighlight: (input: CreateHighlightInput) => ipcRenderer.invoke('annotations:create-highlight', input),
  recolorHighlight: (input: RecolorHighlightInput) => ipcRenderer.invoke('annotations:recolor-highlight', input),
  deleteHighlight: (id: string) => ipcRenderer.invoke('annotations:delete-highlight', id),
  createNote: (input: CreateNoteInput) => ipcRenderer.invoke('annotations:create-note', input),
  updateNote: (input: UpdateNoteInput) => ipcRenderer.invoke('annotations:update-note', input),
  deleteNote: (id: string) => ipcRenderer.invoke('annotations:delete-note', id),
  openExternal: (url: string) => ipcRenderer.invoke('external:open', url),
});

contextBridge.exposeInMainWorld('mermarkd', api);
