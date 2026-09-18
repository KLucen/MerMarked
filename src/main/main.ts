import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import squirrelStartup from 'electron-squirrel-startup';
import type { AnnotationSaveResult, AnnotationSelectionInput, AnnotationSummary, OpenedMarkdownDocument } from '../types/reader-api';
import { makeAnnotationAnchor } from '../core/annotation-anchor';
import { classifyAnnotationAnchors, parseAnnotationYaml, serializeAnnotationYaml } from '../core/annotations';
import type { AnnotationSidecar } from '../core/annotations';
import { loadAnnotationFile, saveAnnotationFile } from './annotation-store';
import {
  decodeMarkdownSource,
  readDocumentImage,
  selectedMarkdownPath,
  validatedLocalMarkdownPath,
  validatedDroppedMarkdownPath,
  validatedExternalUrl,
} from './reader-file';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

interface DocumentSession {
  document: OpenedMarkdownDocument;
  annotations?: { model: AnnotationSidecar; sidecarSha256: string | null };
}

const documentSessions = new Map<number, DocumentSession>();

function sessionFor(event: IpcMainInvokeEvent): DocumentSession | null {
  if (!isMainFrame(event) || !BrowserWindow.fromWebContents(event.sender)) return null;
  return documentSessions.get(event.sender.id) ?? null;
}

function annotationDraftDirectory(): string {
  return path.join(app.getPath('userData'), 'annotation-drafts');
}

function emptySidecar(sourceSha256: string): AnnotationSidecar {
  return {
    schemaVersion: 1,
    source: { sha256: sourceSha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' },
    tags: [],
    annotations: [],
  };
}

function validSelection(value: unknown): AnnotationSelectionInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('选区参数无效。');
  const entry = value as Record<string, unknown>;
  if (!Number.isSafeInteger(entry.startByte) || !Number.isSafeInteger(entry.endByte) ||
      typeof entry.sourceExact !== 'string' || typeof entry.displayQuote !== 'string' ||
      entry.sourceExact.length > 16_384 || entry.displayQuote.length > 16_384) {
    throw new Error('选区参数无效。');
  }
  return entry as unknown as AnnotationSelectionInput;
}

async function loadSummary(session: DocumentSession): Promise<AnnotationSummary> {
  let loaded: Awaited<ReturnType<typeof loadAnnotationFile>>;
  try {
    loaded = await loadAnnotationFile(session.document.path, annotationDraftDirectory());
  } catch (error) {
    session.annotations = undefined;
    return {
      status: 'read-only', count: 0, unresolvedCount: 0, pendingDraftCount: 0,
      sidecarPath: `${session.document.path}.annotations.yaml`,
      reason: error instanceof Error ? error.message : '无法读取批注文件。',
    };
  }
  const summary: AnnotationSummary = {
    status: 'ready', count: 0, unresolvedCount: 0,
    pendingDraftCount: loaded.pendingDrafts.length + loaded.unreadableDraftPaths.length,
    unreadableDraftCount: loaded.unreadableDraftPaths.length,
    sidecarPath: loaded.sidecarPath,
  };
  const sourceBytes = await readFile(session.document.path);
  const currentHash = createHash('sha256').update(sourceBytes).digest('hex');
  if (currentHash !== loaded.sourceSha256 || currentHash !== session.document.sourceSha256) {
    session.annotations = undefined;
    return { ...summary, status: 'read-only', reason: '原 Markdown 已在外部修改；请重新打开后再保存批注。' };
  }

  let model: AnnotationSidecar;
  try {
    model = loaded.sidecarText === null ? emptySidecar(currentHash) : parseAnnotationYaml(loaded.sidecarText);
  } catch (error) {
    session.annotations = undefined;
    return { ...summary, status: 'read-only', reason: error instanceof Error ? error.message : '批注文件无法解析。' };
  }
  summary.count = model.annotations.length;
  const anchorStatuses = await classifyAnnotationAnchors(model.annotations.map((item) => item.anchor), sourceBytes);
  summary.unresolvedCount = anchorStatuses.filter((status) => status === 'unresolved').length;
  if (model.source.sha256 !== currentHash) {
    session.annotations = undefined;
    return { ...summary, status: 'read-only', reason: '批注文件关联旧版 Markdown；现有锚点已冻结，需先处理版本差异。' };
  }
  session.annotations = { model, sidecarSha256: loaded.sidecarSha256 };
  return summary;
}

function isMainFrame(event: IpcMainInvokeEvent): boolean {
  return event.senderFrame === event.sender.mainFrame;
}

async function loadMarkdownDocument(filePath: string): Promise<OpenedMarkdownDocument> {
  const bytes = await readFile(filePath);
  return { path: filePath, name: path.basename(filePath), ...decodeMarkdownSource(bytes) };
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

    const filePath = await validatedLocalMarkdownPath(selectedPath);
    const document = await loadMarkdownDocument(filePath);
    documentSessions.set(event.sender.id, { document });
    return document;
  });

  ipcMain.handle('document:open-dropped', async (event, droppedPath: unknown): Promise<OpenedMarkdownDocument> => {
    if (!isMainFrame(event) || !BrowserWindow.fromWebContents(event.sender)) {
      throw new Error('无法从当前窗口打开文件。');
    }

    const filePath = await validatedDroppedMarkdownPath(droppedPath);
    const document = await loadMarkdownDocument(filePath);
    documentSessions.set(event.sender.id, { document });
    return document;
  });

  ipcMain.handle('document:read-image', async (event, relativePath: unknown): Promise<string | null> => {
    if (!isMainFrame(event)) return null;
    const documentPath = sessionFor(event)?.document.path;
    return documentPath ? readDocumentImage(documentPath, relativePath) : null;
  });

  ipcMain.handle('annotations:load-summary', async (event): Promise<AnnotationSummary> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    const summary = await loadSummary(session);
    if (documentSessions.get(event.sender.id) !== session) throw new Error('文档已切换，请重新查看批注状态。');
    return summary;
  });

  ipcMain.handle('annotations:save-probe', async (event, value: unknown): Promise<AnnotationSaveResult> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    const state = session.annotations;
    if (!state) return { status: 'conflict', reason: '批注文件尚未就绪或处于只读状态，请重新打开文档。' };
    const selection = validSelection(value);
    const anchor = makeAnnotationAnchor(
      session.document.content, session.document.bomByteLength, session.document.sourceSha256, selection,
    );
    const now = new Date().toISOString();
    const candidate: AnnotationSidecar = {
      ...state.model,
      annotations: [...state.model.annotations, {
        id: randomUUID(), kind: 'highlight', color: 'amber', anchor, createdAt: now, updatedAt: now,
      }],
    };
    // Serialize through the restricted schema; the renderer cannot provide a sidecar path or YAML.
    const text = serializeAnnotationYaml(candidate);
    if (documentSessions.get(event.sender.id) !== session) throw new Error('文档已切换，请重新选择文字。');
    const result = await saveAnnotationFile({
      documentPath: session.document.path,
      draftDirectory: annotationDraftDirectory(),
      expectedSourceSha256: session.document.sourceSha256,
      expectedSidecarSha256: state.sidecarSha256,
      text,
    });
    if (documentSessions.get(event.sender.id) !== session) throw new Error('文档已切换，请重新查看批注状态。');
    if (result.status === 'saved') {
      session.annotations = { model: candidate, sidecarSha256: result.sidecarSha256 };
      return { status: 'saved', count: candidate.annotations.length };
    }
    session.annotations = undefined;
    return { status: result.status, reason: result.reason, draftPath: result.draftPath };
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
  window.webContents.on('destroyed', () => documentSessions.delete(window.webContents.id));

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
