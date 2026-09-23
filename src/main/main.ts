import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import squirrelStartup from 'electron-squirrel-startup';
import type {
  AnnotationDocumentView, AnnotationSaveResult, AnnotationSelectionInput,
  CreateHighlightInput, CreateNoteInput, NoteTagInput, OpenedMarkdownDocument,
  ReadingSummaryFilterInput, ReattachAnnotationInput, RecolorHighlightInput, UpdateNoteInput,
} from '../types/reader-api';
import {
  makeAnnotationAnchor, sectionHintForSelection, sectionLocationForSelection,
} from '../core/annotation-anchor';
import { extractSections } from '../core/sections';
import { buildSelectionMap, resolveStoredHighlight } from '../core/selection-map';
import { parseAnnotationYaml, serializeAnnotationYaml } from '../core/annotations';
import type { AnnotationColor, AnnotationSidecar } from '../core/annotations';
import { relocateAnnotationSidecarCandidate } from '../core/annotation-relocation';
import type { AnnotationRelocationReason } from '../core/annotation-relocation';
import { formatReadingSummary } from '../core/reading-summary';
import { loadAnnotationFile, saveAnnotationFile } from './annotation-store';
import {
  createHighlightCandidate, createNoteCandidate, deleteHighlightCandidate, deleteNoteCandidate,
  reattachAnnotationCandidate, recolorHighlightCandidate, updateNoteCandidate,
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
  annotations?: {
    model: AnnotationSidecar;
    sidecarSha256: string | null;
    mode: 'ready' | 'needs-relocation' | 'read-only';
    expectedExistingSourceSha256?: string;
  };
  annotationWriteInProgress?: boolean;
  annotationRevision?: number;
}

const documentSessions = new Map<number, DocumentSession>();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function documentBytes(document: OpenedMarkdownDocument): Uint8Array {
  const content = textEncoder.encode(document.content);
  if (document.bomByteLength === 0) return content;
  const bytes = new Uint8Array(content.length + 3);
  bytes.set([0xef, 0xbb, 0xbf]);
  bytes.set(content, 3);
  return bytes;
}

function safeTimestamp(model: AnnotationSidecar): string {
  const newestRecord = model.annotations.reduce(
    (latest, item) => Math.max(latest, Date.parse(item.createdAt), Date.parse(item.updatedAt)),
    0,
  );
  return new Date(Math.max(Date.now(), newestRecord)).toISOString();
}

function relocationView(reason: AnnotationRelocationReason) {
  if (reason === 'source-exact-missing') return 'source-missing' as const;
  if (reason === 'source-exact-repeated') return 'source-repeated' as const;
  if (reason === 'context-mismatch') return 'context-mismatch' as const;
  if (reason === 'rendered-range-unresolved') return 'rendered-range-unresolved' as const;
  if (reason === 'target-range-collision') return 'target-range-collision' as const;
  return 'range-mismatch' as const;
}

function verifiedAnchorForSelection(document: OpenedMarkdownDocument, selection: AnnotationSelectionInput) {
  const anchor = makeAnnotationAnchor(
    document.content,
    document.bomByteLength,
    document.sourceSha256,
    selection,
    sectionHintForSelection(document.content, document.bomByteLength, selection),
  );
  if (!resolveStoredHighlight(buildSelectionMap(document.content, document.bomByteLength), anchor).ok) {
    throw new Error('选区无法与当前阅读文字精确对应，请重新选择。');
  }
  return anchor;
}

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

function validReattachAnnotation(value: unknown): ReattachAnnotationInput {
  const entry = objectWithFields(value, '重新选择', ['id', 'selection']);
  return { id: validId(entry.id), selection: validSelection(entry.selection) };
}

function validSummaryFilter(value: unknown): ReadingSummaryFilterInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('摘要筛选参数无效。');
  const mode = (value as Record<string, unknown>).mode;
  if (mode === 'all' || mode === 'untagged') {
    objectWithFields(value, '摘要筛选', ['mode']);
    return { mode };
  }
  if (mode === 'tag') {
    const entry = objectWithFields(value, '摘要筛选', ['mode', 'tagId']);
    return { mode, tagId: validId(entry.tagId) };
  }
  throw new Error('摘要筛选参数无效。');
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
      status: 'read-only', count: 0, unresolvedCount: 0, relocatableCount: 0, pendingDraftCount: 0,
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
      status: 'read-only', count: 0, unresolvedCount: 0, relocatableCount: 0,
      pendingDraftCount: 0, tags: [], items: [],
      sidecarPath: `${session.document.path}.annotations.yaml`,
      reason: error instanceof Error ? error.message : '无法读取批注文件。',
    };
  }
  const view: AnnotationDocumentView = {
    status: 'ready', count: 0, unresolvedCount: 0, relocatableCount: 0,
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
  const relocation = sourceIsCurrent
    ? await relocateAnnotationSidecarCandidate(model, {
        bytes: sourceBytes,
        content: session.document.content,
        sha256: currentHash,
      }, safeTimestamp(model))
    : null;
  const anchorStatuses = relocation
    ? relocation.items.map((item) => item.status === 'unchanged' ? 'resolved' as const : 'unresolved' as const)
    : model.annotations.map(() => 'unresolved' as const);
  const relocationById = new Map(relocation?.items.map((item) => [item.id, item]));
  view.items = model.annotations.map((item, index) => {
    const relocationResult = relocationById.get(item.id);
    const relocationState = relocationResult?.status === 'relocated'
      ? 'available' as const
      : relocationResult?.status === 'unresolved'
        ? relocationView(relocationResult.reason)
        : undefined;
    return {
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
      ...(relocationState ? { relocation: relocationState } : {}),
    };
  });
  view.unresolvedCount = anchorStatuses.filter((status) => status === 'unresolved').length;
  view.relocatableCount = relocation?.relocatedCount ?? 0;
  if (!sourceIsCurrent) {
    setLoadedState(undefined);
    return {
      ...view,
      status: 'read-only',
      canReloadSource: true,
      reason: '原 Markdown 已在外部修改；请先重新载入原文，再审查批注位置。',
    };
  }
  if (view.pendingDraftCount > 0) {
    view.canCopySummary = true;
    setLoadedState({ model, sidecarSha256: loaded.sidecarSha256, mode: 'read-only' });
    return { ...view, status: 'read-only', reason: '存在待处理的批注恢复草稿；请先处理草稿以避免覆盖。' };
  }
  if (model.source.sha256 !== currentHash) {
    view.status = 'needs-relocation';
    view.canCopySummary = true;
    view.reason = view.relocatableCount > 0
      ? `检测到旧版锚点：${view.relocatableCount} 条可安全重定位，其余需人工重新选择。`
      : '批注来自旧版 Markdown；没有可自动确认的位置，请人工重新选择。';
    setLoadedState({
      model,
      sidecarSha256: loaded.sidecarSha256,
      mode: 'needs-relocation',
      expectedExistingSourceSha256: model.source.sha256,
    });
    return view;
  }
  setLoadedState({ model, sidecarSha256: loaded.sidecarSha256, mode: 'ready' });
  view.canCopySummary = true;
  return view;
}

async function persistAnnotationModel(
  event: IpcMainInvokeEvent,
  session: DocumentSession,
  state: NonNullable<DocumentSession['annotations']>,
  model: AnnotationSidecar,
  resultFields: Pick<AnnotationSaveResult, 'id' | 'relocatedCount'> = {},
): Promise<AnnotationSaveResult> {
  if (session.annotationWriteInProgress) return { status: 'conflict', reason: '另一项批注操作仍在保存，请稍后重试。' };
  if (documentSessions.get(event.sender.id) !== session) throw new Error('文档已切换，请重新选择文字。');
  const text = serializeAnnotationYaml(model);
  session.annotationWriteInProgress = true;
  session.annotationRevision = (session.annotationRevision ?? 0) + 1;
  try {
    const result = await saveAnnotationFile({
      documentPath: session.document.path,
      draftDirectory: annotationDraftDirectory(),
      expectedSourceSha256: session.document.sourceSha256,
      expectedSidecarSha256: state.sidecarSha256,
      ...(state.expectedExistingSourceSha256
        ? { expectedExistingSourceSha256: state.expectedExistingSourceSha256 }
        : {}),
      text,
    });
    if (documentSessions.get(event.sender.id) !== session) throw new Error('文档已切换，请重新查看批注状态。');
    if (result.status === 'saved') {
      session.annotations = { model, sidecarSha256: result.sidecarSha256, mode: 'ready' };
      return { status: 'saved', count: model.annotations.length, ...resultFields };
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

async function persistAnnotationMutation(
  event: IpcMainInvokeEvent,
  session: DocumentSession,
  state: NonNullable<DocumentSession['annotations']>,
  mutation: AnnotationMutation,
): Promise<AnnotationSaveResult> {
  if (state.mode !== 'ready') {
    return { status: 'conflict', reason: '请先确认旧锚点的重定位结果。' };
  }
  if (!mutation.changed) return { status: 'saved', count: state.model.annotations.length, id: mutation.id };
  return persistAnnotationModel(event, session, state, mutation.model, { id: mutation.id });
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
  const anchor = verifiedAnchorForSelection(session.document, selection);
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
  const anchor = verifiedAnchorForSelection(session.document, input.selection);
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

async function applyAnnotationRelocations(event: IpcMainInvokeEvent): Promise<AnnotationSaveResult> {
  const session = sessionFor(event);
  if (!session) throw new Error('请先打开 Markdown 文档。');
  const state = session.annotations;
  if (!state) return { status: 'conflict', reason: '批注审查尚未就绪，请重新载入批注。' };
  if (state.mode === 'read-only') return { status: 'conflict', reason: '存在待处理草稿，当前不能提交重定位。' };
  const relocation = await relocateAnnotationSidecarCandidate(state.model, {
    bytes: documentBytes(session.document),
    content: session.document.content,
    sha256: session.document.sourceSha256,
  }, safeTimestamp(state.model));
  if (!relocation.changed) {
    return {
      status: 'saved', count: state.model.annotations.length, relocatedCount: 0,
      reason: '没有可安全重定位的批注。',
    };
  }
  return persistAnnotationModel(event, session, state, relocation.model, {
    relocatedCount: relocation.relocatedCount,
  });
}

async function reattachAnnotation(
  event: IpcMainInvokeEvent,
  input: ReattachAnnotationInput,
): Promise<AnnotationSaveResult> {
  const session = sessionFor(event);
  if (!session) throw new Error('请先打开 Markdown 文档。');
  const state = session.annotations;
  if (!state) return { status: 'conflict', reason: '批注审查尚未就绪，请重新载入批注。' };
  if (state.mode === 'read-only') return { status: 'conflict', reason: '存在待处理草稿，当前不能重新绑定批注。' };
  const existingIndex = state.model.annotations.findIndex((item) => item.id === input.id);
  if (existingIndex < 0) throw new Error('批注不存在，请重新载入批注。');
  const currentReview = await relocateAnnotationSidecarCandidate(state.model, {
    bytes: documentBytes(session.document),
    content: session.document.content,
    sha256: session.document.sourceSha256,
  }, safeTimestamp(state.model));
  if (currentReview.items[existingIndex]?.status === 'unchanged') {
    throw new Error('这条批注已经定位，无需重新选择。');
  }

  const anchor = verifiedAnchorForSelection(session.document, input.selection);
  const occupiedBy = currentReview.items.findIndex((item, index) => {
    if (index === existingIndex || item.status === 'unresolved') return false;
    const occupied = currentReview.model.annotations[index].anchor;
    return occupied.basisSha256 === anchor.basisSha256 && occupied.startByte === anchor.startByte &&
      occupied.endByte === anchor.endByte;
  });
  if (occupiedBy >= 0) {
    throw new Error('这段文字将由另一条批注占用，请选择不同文字。');
  }
  const mutation = reattachAnnotationCandidate(state.model, input.id, anchor, safeTimestamp(state.model));
  const model = mutation.model.source.sha256 === session.document.sourceSha256
    ? mutation.model
    : {
        ...mutation.model,
        source: { ...mutation.model.source, sha256: session.document.sourceSha256 },
      };
  return persistAnnotationModel(event, session, state, model, { id: input.id });
}

async function copyReadingSummary(
  event: IpcMainInvokeEvent,
  filter: ReadingSummaryFilterInput,
): Promise<{ count: number }> {
  const session = sessionFor(event);
  if (!session) throw new Error('请先打开 Markdown 文档。');
  const state = session.annotations;
  if (!state) throw new Error('批注状态尚未就绪，请重新载入后再复制。');
  const bytes = documentBytes(session.document);
  const relocation = await relocateAnnotationSidecarCandidate(state.model, {
    bytes,
    content: session.document.content,
    sha256: session.document.sourceSha256,
  }, safeTimestamp(state.model));
  const statusByAnnotationId = Object.fromEntries(relocation.items.map((item) => [
    item.id,
    item.status === 'unchanged' ? 'resolved' as const : 'unresolved' as const,
  ]));
  const sectionTree = extractSections(session.document.content);
  const sectionByAnnotationId = Object.fromEntries(state.model.annotations.flatMap((item) => {
    if (statusByAnnotationId[item.id] !== 'resolved') return [];
    const section = sectionLocationForSelection(
      session.document.content,
      session.document.bomByteLength,
      item.anchor,
      sectionTree,
    );
    return section ? [[item.id, {
      key: String(section.index),
      title: section.path.join(' / '),
    }]] : [];
  }));
  const summary = formatReadingSummary(state.model, {
    documentName: session.document.name,
    statusByAnnotationId,
    sectionByAnnotationId,
    filter,
  });
  if (documentSessions.get(event.sender.id) !== session) {
    throw new Error('文档已切换，请重新复制阅读摘要。');
  }
  clipboard.writeText(summary);
  const count = state.model.annotations.filter((item) => filter.mode === 'all' ||
    (filter.mode === 'untagged' ? item.tagId === undefined : item.tagId === filter.tagId)).length;
  return { count };
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

  ipcMain.handle('document:reload', async (event): Promise<OpenedMarkdownDocument> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    const filePath = await validatedLocalMarkdownPath(session.document.path);
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

  ipcMain.handle('annotations:apply-relocations', async (event): Promise<AnnotationSaveResult> => {
    return applyAnnotationRelocations(event);
  });

  ipcMain.handle('annotations:reattach', async (event, value: unknown): Promise<AnnotationSaveResult> => {
    return reattachAnnotation(event, validReattachAnnotation(value));
  });

  ipcMain.handle('annotations:copy-summary', async (event, value: unknown): Promise<{ count: number }> => {
    return copyReadingSummary(event, validSummaryFilter(value));
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
