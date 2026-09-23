import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import squirrelStartup from 'electron-squirrel-startup';
import type {
  AnnotationDocumentView, AnnotationSaveResult, AnnotationSelectionInput,
  CreateHighlightInput, CreateNoteInput, NoteTagInput, OpenedMarkdownDocument,
  RecolorHighlightInput, UpdateNoteInput,
} from '../types/reader-api';
import { makeAnnotationAnchor } from '../core/annotation-anchor';
import { classifyAnnotationAnchors, parseAnnotationYaml, serializeAnnotationYaml } from '../core/annotations';
import type { AnnotationColor, AnnotationSidecar } from '../core/annotations';
import { loadAnnotationFile, saveAnnotationFile } from './annotation-store';
import {
  createHighlightCandidate, createNoteCandidate, deleteHighlightCandidate, deleteNoteCandidate,
  recolorHighlightCandidate, updateNoteCandidate,
} from '../core/annotation-mutations';
import type { AnnotationMutation } from '../core/annotation-mutations';
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
  annotationWriteInProgress?: boolean;
  annotationRevision?: number;
}

const documentSessions = new Map<number, DocumentSession>();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

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

function objectWithFields(value: unknown, label: string, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}参数无效。`);
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).some((key) => !fields.includes(key)) || fields.some((key) => !Object.hasOwn(entry, key))) {
    throw new Error(`${label}参数无效。`);
  }
  return entry;
}

function validEncodedText(value: unknown, label: string, maxBytes: number, options?: {
  trim?: boolean;
  singleLine?: boolean;
}): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是文本。`);
  const result = options?.trim ? value.trim() : value;
  if (!result.trim() || result.includes('\0') || (options?.singleLine && /[\r\n]/.test(result))) {
    throw new Error(`${label}包含不支持的字符或为空。`);
  }
  const bytes = textEncoder.encode(result);
  if (bytes.length > maxBytes || textDecoder.decode(bytes) !== result) {
    throw new Error(`${label}不能超过 ${maxBytes} 个 UTF-8 字节。`);
  }
  return result;
}

function validSelection(value: unknown): AnnotationSelectionInput {
  const entry = objectWithFields(value, '选区', ['startByte', 'endByte', 'sourceExact', 'displayQuote']);
  if (!Number.isSafeInteger(entry.startByte) || !Number.isSafeInteger(entry.endByte) ||
      (entry.startByte as number) < 0 || (entry.endByte as number) <= (entry.startByte as number) ||
      typeof entry.sourceExact !== 'string' || typeof entry.displayQuote !== 'string') {
    throw new Error('选区参数无效。');
  }
  const sourceExact = validEncodedText(entry.sourceExact, '选区原文', 16_384);
  const displayQuote = validEncodedText(entry.displayQuote, '选区文字', 16_384);
  if (textEncoder.encode(sourceExact).length !== (entry.endByte as number) - (entry.startByte as number)) {
    throw new Error('选区字节范围与原文不一致。');
  }
  return {
    startByte: entry.startByte as number,
    endByte: entry.endByte as number,
    sourceExact,
    displayQuote,
  };
}

function validColor(value: unknown): AnnotationColor {
  if (value !== 'amber' && value !== 'sage' && value !== 'blue' && value !== 'rose') {
    throw new Error('高亮颜色无效。');
  }
  return value;
}

function validId(value: unknown): string {
  if (typeof value !== 'string' || !idPattern.test(value)) {
    throw new Error('批注 ID 无效。');
  }
  return value;
}

function validCreateHighlight(value: unknown): CreateHighlightInput {
  const entry = objectWithFields(value, '高亮', ['selection', 'color']);
  return { selection: validSelection(entry.selection), color: validColor(entry.color) };
}

function validRecolorHighlight(value: unknown): RecolorHighlightInput {
  const entry = objectWithFields(value, '高亮', ['id', 'color']);
  return { id: validId(entry.id), color: validColor(entry.color) };
}

function validNoteTag(value: unknown): NoteTagInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('标签参数无效。');
  const mode = (value as Record<string, unknown>).mode;
  if (mode === 'none') {
    objectWithFields(value, '标签', ['mode']);
    return { mode };
  }
  if (mode === 'existing') {
    const entry = objectWithFields(value, '标签', ['mode', 'id']);
    return { mode, id: validId(entry.id) };
  }
  if (mode === 'new') {
    const entry = objectWithFields(value, '标签', ['mode', 'name']);
    return { mode, name: validEncodedText(entry.name, '标签名称', 256, { trim: true, singleLine: true }) };
  }
  throw new Error('标签参数无效。');
}

function validCreateNote(value: unknown): CreateNoteInput {
  const entry = objectWithFields(value, '便签', ['selection', 'note', 'tag']);
  return {
    selection: validSelection(entry.selection),
    note: validEncodedText(entry.note, '便签正文', 32_768),
    tag: validNoteTag(entry.tag),
  };
}

function validUpdateNote(value: unknown): UpdateNoteInput {
  const entry = objectWithFields(value, '便签', ['id', 'note', 'tag']);
  return {
    id: validId(entry.id),
    note: validEncodedText(entry.note, '便签正文', 32_768),
    tag: validNoteTag(entry.tag),
  };
}

async function loadAnnotations(session: DocumentSession): Promise<AnnotationDocumentView> {
  const revision = session.annotationRevision ?? 0;
  const setLoadedState = (state: DocumentSession['annotations']): void => {
    if ((session.annotationRevision ?? 0) === revision && !session.annotationWriteInProgress) {
      session.annotations = state;
    }
  };
  if (session.annotationWriteInProgress) {
    return {
      status: 'read-only', count: 0, unresolvedCount: 0, pendingDraftCount: 0,
      sidecarPath: `${session.document.path}.annotations.yaml`, tags: [], items: [],
      reason: '批注正在保存，请稍后重新载入。',
    };
  }
  let loaded: Awaited<ReturnType<typeof loadAnnotationFile>>;
  try {
    loaded = await loadAnnotationFile(session.document.path, annotationDraftDirectory());
  } catch (error) {
    setLoadedState(undefined);
    return {
      status: 'read-only', count: 0, unresolvedCount: 0, pendingDraftCount: 0, tags: [], items: [],
      sidecarPath: `${session.document.path}.annotations.yaml`,
      reason: error instanceof Error ? error.message : '无法读取批注文件。',
    };
  }
  const view: AnnotationDocumentView = {
    status: 'ready', count: 0, unresolvedCount: 0,
    pendingDraftCount: loaded.pendingDrafts.length + loaded.unreadableDraftPaths.length,
    unreadableDraftCount: loaded.unreadableDraftPaths.length,
    sidecarPath: loaded.sidecarPath,
    tags: [],
    items: [],
  };
  let sourceBytes: Buffer;
  try {
    sourceBytes = await readFile(session.document.path);
  } catch (error) {
    setLoadedState(undefined);
    return { ...view, status: 'read-only', reason: error instanceof Error ? error.message : '无法读取原 Markdown。' };
  }
  const currentHash = createHash('sha256').update(sourceBytes).digest('hex');

  let model: AnnotationSidecar;
  try {
    model = loaded.sidecarText === null ? emptySidecar(currentHash) : parseAnnotationYaml(loaded.sidecarText);
  } catch (error) {
    setLoadedState(undefined);
    return { ...view, status: 'read-only', reason: error instanceof Error ? error.message : '批注文件无法解析。' };
  }
  view.count = model.annotations.length;
  view.tags = model.tags.map((tag) => ({ id: tag.id, name: tag.name }));
  const sourceIsCurrent = currentHash === loaded.sourceSha256 && currentHash === session.document.sourceSha256;
  const sidecarIsCurrent = model.source.sha256 === currentHash;
  const anchorStatuses = sourceIsCurrent && sidecarIsCurrent
    ? await classifyAnnotationAnchors(model.annotations.map((item) => item.anchor), sourceBytes)
    : model.annotations.map(() => 'unresolved' as const);
  view.items = model.annotations.map((item, index) => ({
    id: item.id,
    kind: item.kind,
    ...(item.color && { color: item.color }),
    ...(item.note !== undefined && { note: item.note }),
    ...(item.tagId && { tagId: item.tagId }),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    anchor: {
      startByte: item.anchor.startByte,
      endByte: item.anchor.endByte,
      sourceExact: item.anchor.sourceExact,
      displayQuote: item.anchor.displayQuote,
    },
    status: anchorStatuses[index],
  }));
  view.unresolvedCount = anchorStatuses.filter((status) => status === 'unresolved').length;
  if (!sourceIsCurrent) {
    setLoadedState(undefined);
    return { ...view, status: 'read-only', reason: '原 Markdown 已在外部修改；请重新打开后再保存批注。' };
  }
  if (model.source.sha256 !== currentHash) {
    setLoadedState(undefined);
    return { ...view, status: 'read-only', reason: '批注文件关联旧版 Markdown；现有锚点已冻结，需先处理版本差异。' };
  }
  if (view.pendingDraftCount > 0) {
    setLoadedState(undefined);
    return { ...view, status: 'read-only', reason: '存在待处理的批注恢复草稿；请先处理草稿以避免覆盖。' };
  }
  setLoadedState({ model, sidecarSha256: loaded.sidecarSha256 });
  return view;
}

async function persistAnnotationMutation(
  event: IpcMainInvokeEvent,
  session: DocumentSession,
  state: NonNullable<DocumentSession['annotations']>,
  mutation: AnnotationMutation,
): Promise<AnnotationSaveResult> {
  if (session.annotationWriteInProgress) return { status: 'conflict', reason: '另一项批注操作仍在保存，请稍后重试。' };
  if (documentSessions.get(event.sender.id) !== session) throw new Error('文档已切换，请重新选择文字。');
  if (!mutation.changed) return { status: 'saved', count: state.model.annotations.length, id: mutation.id };
  const text = serializeAnnotationYaml(mutation.model);
  session.annotationWriteInProgress = true;
  session.annotationRevision = (session.annotationRevision ?? 0) + 1;
  try {
    const result = await saveAnnotationFile({
      documentPath: session.document.path,
      draftDirectory: annotationDraftDirectory(),
      expectedSourceSha256: session.document.sourceSha256,
      expectedSidecarSha256: state.sidecarSha256,
      text,
    });
    if (documentSessions.get(event.sender.id) !== session) throw new Error('文档已切换，请重新查看批注状态。');
    if (result.status === 'saved') {
      session.annotations = { model: mutation.model, sidecarSha256: result.sidecarSha256 };
      return { status: 'saved', count: mutation.model.annotations.length, id: mutation.id };
    }
    session.annotations = undefined;
    return { status: result.status, reason: result.reason, draftPath: result.draftPath };
  } catch (error) {
    session.annotations = undefined;
    throw error;
  } finally {
    session.annotationWriteInProgress = false;
    session.annotationRevision = (session.annotationRevision ?? 0) + 1;
  }
}

async function createHighlight(
  event: IpcMainInvokeEvent,
  selection: AnnotationSelectionInput,
  color: AnnotationColor,
): Promise<AnnotationSaveResult> {
  const session = sessionFor(event);
  if (!session) throw new Error('请先打开 Markdown 文档。');
  const state = session.annotations;
  if (!state) return { status: 'conflict', reason: '批注文件尚未就绪或处于只读状态，请重新打开文档。' };
  const anchor = makeAnnotationAnchor(
    session.document.content, session.document.bomByteLength, session.document.sourceSha256, selection,
  );
  const mutation = createHighlightCandidate(state.model, anchor, color, randomUUID(), new Date().toISOString());
  return persistAnnotationMutation(event, session, state, mutation);
}

async function createNote(
  event: IpcMainInvokeEvent,
  input: CreateNoteInput,
): Promise<AnnotationSaveResult> {
  const session = sessionFor(event);
  if (!session) throw new Error('请先打开 Markdown 文档。');
  const state = session.annotations;
  if (!state) return { status: 'conflict', reason: '批注文件尚未就绪或处于只读状态，请重新打开文档。' };
  const anchor = makeAnnotationAnchor(
    session.document.content, session.document.bomByteLength, session.document.sourceSha256, input.selection,
  );
  const mutation = createNoteCandidate(
    state.model,
    anchor,
    input.note,
    input.tag,
    randomUUID(),
    input.tag.mode === 'new' ? randomUUID() : undefined,
    new Date().toISOString(),
  );
  return persistAnnotationMutation(event, session, state, mutation);
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

  ipcMain.handle('annotations:load', async (event): Promise<AnnotationDocumentView> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    const revision = session.annotationRevision ?? 0;
    const view = await loadAnnotations(session);
    if (documentSessions.get(event.sender.id) !== session) throw new Error('文档已切换，请重新查看批注状态。');
    if ((session.annotationRevision ?? 0) !== revision) throw new Error('批注状态已变化，请重新载入。');
    return view;
  });

  ipcMain.handle('annotations:create-highlight', async (event, value: unknown): Promise<AnnotationSaveResult> => {
    if (!sessionFor(event)) throw new Error('请先打开 Markdown 文档。');
    const input = validCreateHighlight(value);
    return createHighlight(event, input.selection, input.color);
  });

  ipcMain.handle('annotations:recolor-highlight', async (event, value: unknown): Promise<AnnotationSaveResult> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    const state = session.annotations;
    if (!state) return { status: 'conflict', reason: '批注文件尚未就绪或处于只读状态，请重新打开文档。' };
    const input = validRecolorHighlight(value);
    const mutation = recolorHighlightCandidate(state.model, input.id, input.color, new Date().toISOString());
    return persistAnnotationMutation(event, session, state, mutation);
  });

  ipcMain.handle('annotations:delete-highlight', async (event, value: unknown): Promise<AnnotationSaveResult> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    const state = session.annotations;
    if (!state) return { status: 'conflict', reason: '批注文件尚未就绪或处于只读状态，请重新打开文档。' };
    const mutation = deleteHighlightCandidate(state.model, validId(value));
    return persistAnnotationMutation(event, session, state, mutation);
  });

  ipcMain.handle('annotations:create-note', async (event, value: unknown): Promise<AnnotationSaveResult> => {
    if (!sessionFor(event)) throw new Error('请先打开 Markdown 文档。');
    return createNote(event, validCreateNote(value));
  });

  ipcMain.handle('annotations:update-note', async (event, value: unknown): Promise<AnnotationSaveResult> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    const state = session.annotations;
    if (!state) return { status: 'conflict', reason: '批注文件尚未就绪或处于只读状态，请重新打开文档。' };
    const input = validUpdateNote(value);
    const mutation = updateNoteCandidate(
      state.model,
      input.id,
      input.note,
      input.tag,
      input.tag.mode === 'new' ? randomUUID() : undefined,
      new Date().toISOString(),
    );
    return persistAnnotationMutation(event, session, state, mutation);
  });

  ipcMain.handle('annotations:delete-note', async (event, value: unknown): Promise<AnnotationSaveResult> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    const state = session.annotations;
    if (!state) return { status: 'conflict', reason: '批注文件尚未就绪或处于只读状态，请重新打开文档。' };
    const mutation = deleteNoteCandidate(state.model, validId(value));
    return persistAnnotationMutation(event, session, state, mutation);
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
