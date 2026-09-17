import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import squirrelStartup from 'electron-squirrel-startup';
import type { OpenedMarkdownDocument } from '../types/reader-api';
import {
  decodeMarkdownSource,
  readDocumentImage,
  selectedMarkdownPath,
  validatedExternalUrl,
} from './reader-file';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

const documentPaths = new Map<number, string>();

function isMainFrame(event: IpcMainInvokeEvent): boolean {
  return event.senderFrame === event.sender.mainFrame;
}

function registerReaderIpc(): void {
  ipcMain.handle('document:open', async (event): Promise<OpenedMarkdownDocument | null> => {
    if (!isMainFrame(event)) return null;
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) return null;

    const selection = await dialog.showOpenDialog(owner, {
      title: '打开 Markdown 文档',
      properties: ['openFile'],
      filters: [{ name: 'Markdown 文档', extensions: ['md'] }],
    });
    const selectedPath = selectedMarkdownPath(selection);
    if (!selectedPath) return null;

    const bytes = await readFile(selectedPath);
    const source = decodeMarkdownSource(bytes);

    documentPaths.set(event.sender.id, selectedPath);
    return { path: selectedPath, name: path.basename(selectedPath), ...source };
  });

  ipcMain.handle('document:read-image', async (event, relativePath: unknown): Promise<string | null> => {
    if (!isMainFrame(event)) return null;
    const documentPath = documentPaths.get(event.sender.id);
    return documentPath ? readDocumentImage(documentPath, relativePath) : null;
  });

  ipcMain.handle('external:open', async (event, value: unknown): Promise<boolean> => {
    if (!isMainFrame(event)) return false;
    const url = validatedExternalUrl(value);
    if (!url) return false;
    try {
      await shell.openExternal(url);
      return true;
    } catch {
      return false;
    }
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'MerMarkd',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('destroyed', () => documentPaths.delete(window.webContents.id));

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
}

if (squirrelStartup) {
  app.quit();
} else {
  void app.whenReady().then(() => {
    registerReaderIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
