import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import squirrelStartup from 'electron-squirrel-startup';
import type {
  AnnotationDocumentView, AnnotationSaveResult, AnnotationSelectionInput,
  CanvasExportFormat, CanvasExportInput, CanvasExportResult, CanvasLoadResult, CanvasSaveResult,
  CreateHighlightInput, CreateNoteInput, NoteTagInput, OpenedMarkdownDocument,
  MarkdownAnnotationImpact, MarkdownAnnotationMappingResult, MarkdownEditorDiscardResult, MarkdownEditorSaveResult, MarkdownEditorUpdateInput,
  MarkdownEditorView, MarkdownRecoveryInput, ReadingSummaryFilterInput,
  ReattachAnnotationInput, RecolorHighlightInput, UpdateNoteInput,
  SectionStructureConfirmResult, SectionStructurePreview,
  DocumentRecoveryItem, DocumentRecoveryPreview, DocumentRecoveryResult, RecentMarkdownDocument,
} from '../types/reader-api';
import {
  makeAnnotationAnchor, sectionHintForSelection, sectionLocationForSelection,
} from '../core/annotation-anchor';
import { extractSections } from '../core/sections';
import { buildSelectionMap, resolveStoredHighlight } from '../core/selection-map';
import { serializeAnnotationYaml } from '../core/annotations';
import type { AnnotationColor, AnnotationSidecar } from '../core/annotations';
import { relocateAnnotationSidecarCandidate } from '../core/annotation-relocation';
import type { AnnotationRelocationReason } from '../core/annotation-relocation';
import { mapAnnotationSidecarThroughEdit } from '../core/annotation-edit-map';
import { formatReadingSummary } from '../core/reading-summary';
import { decodeMarkdownBytes, encodeMarkdownBytes } from '../core/markdown-source';
import { previewSectionTransform } from '../core/section-transform';
import type { SectionTransformOperation } from '../core/section-transform';
import { saveAnnotationFile } from './annotation-store';
import { loadAnnotationDocumentData } from './annotation-document-load';
import { MarkdownEditorSession } from './markdown-editor-session';
import { loadCanvasFile, saveCanvasFile } from './canvas-store';
import { parseCanvasJson, validateCanvasState } from '../core/canvas-state';
import { prepareSectionStructurePlan } from './section-structure-store';
import { inspectDocumentTransaction, listDocumentTransactions, recoverDocumentTransaction } from './document-transaction';
import type { DocumentTransactionRef } from './document-transaction';
import { assertCanvasExportSize, buildCanvasExportScene, canvasSceneToSvg } from '../core/canvas-export';
import { canvasCardContent } from '../core/canvas-card-content';
import type { CanvasSceneCard, CanvasSceneLink } from '../core/canvas-scene';
import { parseRecentDocuments, recordRecentDocument, removeRecentDocument, serializeRecentDocuments } from '../core/recent-documents';
import type { RecentDocument } from '../core/recent-documents';
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
  editor?: MarkdownEditorSession;
  annotations?: {
    model: AnnotationSidecar;
    sidecarSha256: string | null;
    mode: 'ready' | 'needs-relocation' | 'read-only';
    expectedExistingSourceSha256?: string;
  };
  annotationWriteInProgress?: boolean;
  annotationRevision?: number;
  markdownOperationInProgress?: boolean;
  canvasWriteInProgress?: boolean;
  canvasExportInProgress?: boolean;
  sectionStructurePreview?: {
    readonly token: string;
    readonly plan: Awaited<ReturnType<typeof prepareSectionStructurePlan>>;
  };
}

const documentSessions = new Map<number, DocumentSession>();
const recoveryPreviews = new Map<number, { token: string; documentPath: string; ref: DocumentTransactionRef; session: DocumentSession | null }>();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const opaqueIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maxEditableMarkdownBytes = 32 * 1024 * 1024;
const maxCanvasExportDimension = 12_000;

function documentBytes(document: OpenedMarkdownDocument): Uint8Array {
  return encodeMarkdownBytes(document.content, document.bomByteLength);
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

function markdownDraftDirectory(): string {
  return path.join(app.getPath('userData'), 'markdown-drafts');
}

function annotationMutationBlocked(session: DocumentSession): AnnotationSaveResult | null {
  if (session.document.recoveryPending || session.editor?.pendingStructureTransactionId) return { status: 'conflict', reason: '文档存在未完成保存，请先检查保存恢复。' };
  if (session.canvasWriteInProgress) return { status: 'conflict', reason: '画布正在保存，请稍后重试。' };
  if (session.annotationWriteInProgress) {
    return { status: 'conflict', reason: '批注正在保存，请稍后重试。' };
  }
  if (session.markdownOperationInProgress || session.editor?.writeInProgress) {
    return { status: 'conflict', reason: 'Markdown 正在保存或处理恢复文件，请稍后重试批注操作。' };
  }
  if (session.editor?.dirty) {
    return { status: 'conflict', reason: 'Markdown 有未保存修改；请先保存或放弃源码编辑。' };
  }
  return null;
}

function assertDocumentCanBeReplaced(session: DocumentSession | null): void {
  if (!session) return;
  if (session.canvasWriteInProgress) throw new Error('画布正在保存，请完成后再切换文档。');
  if (session.canvasExportInProgress) throw new Error('画布正在导出，请完成后再切换文档。');
  if (session.annotationWriteInProgress) {
    throw new Error('批注正在保存，请完成后再打开或重新载入文档。');
  }
  if (session.markdownOperationInProgress || session.editor?.writeInProgress) {
    throw new Error('Markdown 正在保存或处理恢复文件，请完成后再切换文档。');
  }
  if (session.editor?.dirty) {
    throw new Error('Markdown 有未保存修改；请先保存或放弃修改，再切换文档。');
  }
}

function assertCurrentSession(event: IpcMainInvokeEvent, expected: DocumentSession | null): void {
  if ((documentSessions.get(event.sender.id) ?? null) !== expected) {
    throw new Error('文档已切换，请重新执行操作。');
  }
}

function validOpaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !opaqueIdPattern.test(value)) {
    throw new Error(`${label}无效。`);
  }
  return value;
}

function validMarkdownEditorUpdate(value: unknown): MarkdownEditorUpdateInput {
  const entry = objectWithFields(value, 'Markdown 编辑', ['epoch', 'revision', 'content']);
  const epoch = validOpaqueId(entry.epoch, 'Markdown 文档版本');
  if (!Number.isSafeInteger(entry.revision) || (entry.revision as number) < 0) {
    throw new Error('Markdown 编辑版本无效。');
  }
  if (typeof entry.content !== 'string') {
    throw new Error('Markdown 编辑内容必须是文本。');
  }
  const bytes = textEncoder.encode(entry.content);
  if (bytes.byteLength > maxEditableMarkdownBytes) {
    throw new Error('Markdown 缓冲区超过 32 MiB，未接受本次编辑。');
  }
  if (textDecoder.decode(bytes) !== entry.content) {
    throw new Error('Markdown 缓冲区包含不完整的 Unicode 字符。');
  }
  return {
    epoch,
    revision: entry.revision as number,
    content: entry.content,
  };
}

function validMarkdownRecoveryInput(value: unknown): MarkdownRecoveryInput {
  const entry = objectWithFields(value, 'Markdown 恢复', ['epoch', 'id']);
  return {
    epoch: validOpaqueId(entry.epoch, 'Markdown 文档版本'),
    id: validOpaqueId(entry.id, 'Markdown 恢复项标识'),
  };
}

function validSectionStructureOperation(value: unknown): SectionTransformOperation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('章节结构变更参数无效。');
  }
  const entry = value as Record<string, unknown>;
  if (entry.kind === 'move') {
    objectWithFields(value, '章节结构变更', ['kind', 'sourceIndex', 'targetIndex']);
    if (!Number.isSafeInteger(entry.sourceIndex) || !Number.isSafeInteger(entry.targetIndex) ||
        (entry.sourceIndex as number) < 0 || (entry.targetIndex as number) < 0) {
      throw new Error('章节索引无效。');
    }
    return { kind: 'move', sourceIndex: entry.sourceIndex as number, targetIndex: entry.targetIndex as number };
  }
  if (entry.kind === 'promote') {
    objectWithFields(value, '章节结构变更', ['kind', 'sectionIndex', 'targetDepth']);
    if (!Number.isSafeInteger(entry.sectionIndex) || !Number.isSafeInteger(entry.targetDepth) ||
        (entry.sectionIndex as number) < 0 || (entry.targetDepth as number) < 1) {
      throw new Error('章节级别参数无效。');
    }
    return { kind: 'promote', sectionIndex: entry.sectionIndex as number, targetDepth: entry.targetDepth as number };
  }
  throw new Error('章节结构变更类型无效。');
}

function currentEditor(session: DocumentSession): MarkdownEditorSession {
  if (!session.editor) throw new Error('请先进入 Markdown 编辑模式。');
  return session.editor;
}

function assertEditorEpoch(editor: MarkdownEditorSession, epoch: string): void {
  if (editor.epoch !== epoch) throw new Error('文档已切换，请重新进入编辑模式。');
}

function assertEditorCanMutate(session: DocumentSession): void {
  if (session.document.recoveryPending || session.editor?.pendingStructureTransactionId) throw new Error('文档存在未完成保存，请先检查保存恢复。');
  if (session.canvasWriteInProgress) throw new Error('画布正在保存，请完成后再编辑。');
  if (session.canvasExportInProgress) throw new Error('画布正在导出，请完成后再编辑。');
  if (session.annotationWriteInProgress) {
    throw new Error('批注正在保存，请完成后再编辑 Markdown。');
  }
  if (session.markdownOperationInProgress || session.editor?.writeInProgress) {
    throw new Error('Markdown 正在保存或处理恢复文件，请稍后重试。');
  }
}

async function withMarkdownOperation<T>(
  session: DocumentSession,
  operation: () => Promise<T>,
): Promise<T> {
  assertEditorCanMutate(session);
  session.markdownOperationInProgress = true;
  try {
    return await operation();
  } finally {
    session.markdownOperationInProgress = false;
  }
}

type AnnotationEditBaseline =
  | { readonly status: 'ready'; readonly model: AnnotationSidecar; readonly sidecarSha256: string; readonly sourceBytes: Uint8Array }
  | { readonly status: 'not-needed'; readonly message: string }
  | { readonly status: 'deferred'; readonly message: string };

async function prepareAnnotationEditBaseline(session: DocumentSession): Promise<AnnotationEditBaseline> {
  const loaded = await loadAnnotationDocumentData(session.document.path, annotationDraftDirectory());
  if (!loaded.ok) {
    return { status: 'deferred', message: '批注文件无法安全读取；Markdown 已保存，批注保持原样并等待阅读模式审查。' };
  }
  if (loaded.currentHash !== session.document.sourceSha256 || loaded.loaded.sourceSha256 !== loaded.currentHash) {
    return { status: 'deferred', message: 'Markdown 基线在保存前发生变化；未自动更新批注。' };
  }
  if (loaded.loaded.pendingDrafts.length > 0 || loaded.loaded.unreadableDraftPaths.length > 0) {
    return { status: 'deferred', message: '存在待处理的批注恢复草稿；未自动覆盖批注文件。' };
  }
  if (loaded.loaded.sidecarText === null) {
    return { status: 'not-needed', message: '当前没有批注文件，未创建空 sidecar。' };
  }
  if (loaded.model.source.sha256 !== session.document.sourceSha256 || loaded.loaded.sidecarSha256 === null) {
    return { status: 'deferred', message: '批注仍绑定旧版 Markdown；本次保存未跳过现有审查流程。' };
  }
  return {
    status: 'ready',
    model: loaded.model,
    sidecarSha256: loaded.loaded.sidecarSha256,
    sourceBytes: loaded.sourceBytes,
  };
}

function mappingMessage(mapping: MarkdownAnnotationMappingResult): string {
  return ` ${mapping.message}`;
}

async function saveMarkdownWithAnnotationMapping(
  session: DocumentSession,
  editor: MarkdownEditorSession,
  input: MarkdownEditorUpdateInput,
): Promise<MarkdownEditorSaveResult> {
  // Validate and accept the final revision before reading any sidecar baseline.
  editor.update(input);
  if (editor.hasStructureEdit && editor.dirty) {
    const annotationBaseline = await prepareAnnotationEditBaseline(session);
    if (annotationBaseline.status === 'deferred') return { status: 'conflict', editor: editor.view(),
      message: '批注基线或恢复草稿需要先处理；结构保存已暂停，候选仍在编辑缓冲区。' };
    const saved = await editor.save(input);
    if (saved.status === 'saved') {
      session.document = saved.document;
      session.annotations = undefined;
      session.annotationRevision = (session.annotationRevision ?? 0) + 1;
      session.sectionStructurePreview = undefined;
    }
    return saved;
  }
  const beforeDocument = session.document;
  const baseline = editor.dirty
    ? await prepareAnnotationEditBaseline(session)
    : { status: 'not-needed', message: '' } as const;
  const saved = await editor.save(input);
  if (saved.status !== 'saved') return saved;

  session.document = saved.document;
  if (!saved.changed) return saved;
  session.annotations = undefined;
  session.annotationRevision = (session.annotationRevision ?? 0) + 1;

  if (baseline.status !== 'ready') {
    const annotationMapping: MarkdownAnnotationMappingResult = {
      status: baseline.status,
      mappedCount: 0,
      unresolvedCount: 0,
      message: baseline.message,
    };
    return { ...saved, annotationMapping, message: saved.message + mappingMessage(annotationMapping) };
  }

  session.annotationWriteInProgress = true;
  session.annotationRevision = (session.annotationRevision ?? 0) + 1;
  try {
    const mapping = await mapAnnotationSidecarThroughEdit(
      baseline.model,
      {
        bytes: baseline.sourceBytes,
        content: beforeDocument.content,
        sha256: beforeDocument.sourceSha256,
      },
      {
        bytes: documentBytes(saved.document),
        content: saved.document.content,
        sha256: saved.document.sourceSha256,
      },
      safeTimestamp(baseline.model),
    );
    const annotationResult = await saveAnnotationFile({
      documentPath: saved.document.path,
      draftDirectory: annotationDraftDirectory(),
      expectedSourceSha256: saved.document.sourceSha256,
      expectedSidecarSha256: baseline.sidecarSha256,
      expectedExistingSourceSha256: beforeDocument.sourceSha256,
      text: serializeAnnotationYaml(mapping.model),
    });
    if (annotationResult.status === 'saved') {
      session.annotations = {
        model: mapping.model,
        sidecarSha256: annotationResult.sidecarSha256,
        mode: 'ready',
      };
      const annotationMapping: MarkdownAnnotationMappingResult = {
        status: 'saved',
        mappedCount: mapping.mappedCount,
        unresolvedCount: mapping.unresolvedCount,
        message: mapping.unresolvedCount > 0
          ? `已同步 ${mapping.mappedCount} 条批注位置；${mapping.unresolvedCount} 条与编辑范围相交或基线不明，已保留为待定位。`
          : `已同步 ${mapping.mappedCount} 条批注位置。`,
      };
      return { ...saved, annotationMapping, message: saved.message + mappingMessage(annotationMapping) };
    }

    session.annotations = undefined;
    const annotationMapping: MarkdownAnnotationMappingResult = {
      status: annotationResult.status,
      mappedCount: mapping.mappedCount,
      unresolvedCount: mapping.unresolvedCount,
      message: annotationResult.status === 'conflict'
        ? 'Markdown 已保存；批注文件同时发生变化，未覆盖外部版本，完整映射候选已保留为恢复草稿。'
        : 'Markdown 已保存；批注映射暂未写回同目录，完整候选已保留为恢复草稿。',
    };
    return { ...saved, annotationMapping, message: saved.message + mappingMessage(annotationMapping) };
  } catch (error) {
    console.error('[annotations:edit-map]', error);
    session.annotations = undefined;
    const annotationMapping: MarkdownAnnotationMappingResult = {
      status: 'deferred',
      mappedCount: 0,
      unresolvedCount: baseline.model.annotations.length,
      message: 'Markdown 已保存；批注映射未能完成，原 sidecar 保持不变，请在阅读模式审查位置。',
    };
    return { ...saved, annotationMapping, message: saved.message + mappingMessage(annotationMapping) };
  } finally {
    session.annotationWriteInProgress = false;
    session.annotationRevision = (session.annotationRevision ?? 0) + 1;
  }
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

function validCanvasNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label}超出允许范围。`);
  }
  return value;
}

function validCanvasExportCard(value: unknown): CanvasSceneCard {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('导出卡片参数无效。');
  const entry = value as Record<string, unknown>;
  const allowed = ['id', 'sectionIndex', 'parentId', 'hidden', 'width', 'height', 'hiddenDescendants', 'position'];
  if (Object.keys(entry).some((key) => !allowed.includes(key)) ||
      ['id', 'sectionIndex', 'hidden', 'width', 'height', 'hiddenDescendants', 'position'].some((key) => !Object.hasOwn(entry, key))) {
    throw new Error('导出卡片参数无效。');
  }
  const id = validId(entry.id);
  const sectionIndex = entry.sectionIndex === null
    ? null
    : Number.isSafeInteger(entry.sectionIndex) && (entry.sectionIndex as number) >= 0 ? entry.sectionIndex as number : (() => { throw new Error('导出卡片章节索引无效。'); })();
  const parentId = entry.parentId === undefined ? undefined : validId(entry.parentId);
  if (typeof entry.hidden !== 'boolean' || !Number.isSafeInteger(entry.hiddenDescendants) ||
      (entry.hiddenDescendants as number) < 0 || (entry.hiddenDescendants as number) > 100_000) {
    throw new Error('导出卡片状态无效。');
  }
  const position = entry.position;
  if (position === null || typeof position !== 'object' || Array.isArray(position)) throw new Error('导出卡片位置无效。');
  const positionEntry = position as Record<string, unknown>;
  if (Object.keys(positionEntry).some((key) => key !== 'x' && key !== 'y') ||
      !Object.hasOwn(positionEntry, 'x') || !Object.hasOwn(positionEntry, 'y')) throw new Error('导出卡片位置无效。');
  return {
    id,
    sectionIndex,
    ...(parentId ? { parentId } : {}),
    hidden: entry.hidden,
    width: validCanvasNumber(entry.width, '导出卡片宽度', 1, maxCanvasExportDimension),
    height: validCanvasNumber(entry.height, '导出卡片高度', 1, maxCanvasExportDimension),
    hiddenDescendants: entry.hiddenDescendants as number,
    position: {
      x: validCanvasNumber(positionEntry.x, '导出卡片横坐标', -1_000_000_000, 1_000_000_000),
      y: validCanvasNumber(positionEntry.y, '导出卡片纵坐标', -1_000_000_000, 1_000_000_000),
    },
  };
}

function validCanvasExportLink(value: unknown): CanvasSceneLink {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('导出箭头参数无效。');
  const entry = value as Record<string, unknown>;
  const allowed = ['id', 'from', 'to', 'label', 'hiddenEndpoint'];
  if (Object.keys(entry).some((key) => !allowed.includes(key)) || allowed.some((key) => !Object.hasOwn(entry, key))) {
    throw new Error('导出箭头参数无效。');
  }
  if (typeof entry.label !== 'string' || entry.label.length > 512 || entry.label.includes('\0') ||
      typeof entry.hiddenEndpoint !== 'boolean') throw new Error('导出箭头参数无效。');
  return { id: validId(entry.id), from: validId(entry.from), to: validId(entry.to), label: entry.label, hiddenEndpoint: entry.hiddenEndpoint };
}

function validCanvasExport(value: unknown): CanvasExportInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('画布导出参数无效。');
  const entry = value as Record<string, unknown>;
  const allowed = ['sourceSha256', 'format', 'cards', 'links', 'padding', 'background'];
  if (Object.keys(entry).some((key) => !allowed.includes(key)) || ['sourceSha256', 'format', 'cards', 'links'].some((key) => !Object.hasOwn(entry, key))) {
    throw new Error('画布导出参数无效。');
  }
  if (typeof entry.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sourceSha256)) throw new Error('导出文档版本无效。');
  if (entry.format !== 'png' && entry.format !== 'jpg' && entry.format !== 'pdf') throw new Error('导出格式无效。');
  if (!Array.isArray(entry.cards) || entry.cards.length > 5000 || !Array.isArray(entry.links) || entry.links.length > 10_000) {
    throw new Error('导出场景规模超出限制。');
  }
  const cards = entry.cards.map(validCanvasExportCard);
  const ids = new Set<string>();
  for (const card of cards) {
    if (ids.has(card.id)) throw new Error('导出场景包含重复卡片。');
    ids.add(card.id);
  }
  for (const card of cards) {
    if (!card.parentId) continue;
    if (card.parentId === card.id || !ids.has(card.parentId)) throw new Error('导出卡片父级不存在。');
    const seen = new Set<string>([card.id]);
    let parentId: string | undefined = card.parentId;
    while (parentId) {
      if (seen.has(parentId)) throw new Error('导出场景包含循环父级。');
      seen.add(parentId);
      parentId = cards.find((candidate) => candidate.id === parentId)?.parentId;
    }
  }
  const links = entry.links.map(validCanvasExportLink);
  const linkIds = new Set<string>();
  for (const link of links) {
    if (linkIds.has(link.id)) throw new Error('导出场景包含重复箭头。');
    if (!ids.has(link.from) || !ids.has(link.to)) throw new Error('导出箭头端点不存在。');
    linkIds.add(link.id);
  }
  const padding = entry.padding === undefined ? undefined : validCanvasNumber(entry.padding, '导出留白', 0, 2000);
  const background = entry.background === undefined ? undefined
    : typeof entry.background === 'string' && /^#[0-9a-fA-F]{6}$/.test(entry.background) ? entry.background : (() => { throw new Error('导出背景色无效。'); })();
  return { sourceSha256: entry.sourceSha256, format: entry.format as CanvasExportFormat, cards, links, ...(padding === undefined ? {} : { padding }), ...(background === undefined ? {} : { background }) };
}

function exportExtension(format: CanvasExportFormat): string { return `.${format}`; }

function sameWindowsPath(left: string, right: string): boolean {
  return path.resolve(left).toLocaleLowerCase() === path.resolve(right).toLocaleLowerCase();
}

async function exportCanvasFor(event: IpcMainInvokeEvent, value: unknown): Promise<CanvasExportResult> {
  const session = sessionFor(event);
  if (!session) throw new Error('请先打开 Markdown 文档。');
  if (session.document.recoveryPending || session.editor?.pendingStructureTransactionId) return { status: 'error', reason: '请先完成文档保存恢复，再导出画布。' };
  if (session.editor?.dirty || session.markdownOperationInProgress || session.editor?.writeInProgress) {
    return { status: 'error', reason: 'Markdown 尚未保存或正在保存，请处理后再导出。' };
  }
  const input = validCanvasExport(value);
  const document = session.document;
  if (input.sourceSha256 !== document.sourceSha256) return { status: 'error', reason: '导出文档版本已变化，请重新载入画布。' };
  const tree = extractSections(document.content);
  const idBySection = new Map(input.cards.map((card) => [card.sectionIndex, card.id]));
  if (idBySection.size !== input.cards.length || input.cards.length !== tree.sections.length + (tree.virtualCard ? 1 : 0)) {
    return { status: 'error', reason: '导出章节尚未完整核验，请重新载入画布。' };
  }
  for (const card of input.cards) {
    const section = card.sectionIndex === null ? null : tree.sections[card.sectionIndex];
    if ((!section && (card.sectionIndex !== null || !tree.virtualCard)) ||
        card.parentId !== (section?.parentIndex === null || section?.parentIndex === undefined ? undefined : idBySection.get(section.parentIndex))) {
      return { status: 'error', reason: '导出卡片层级与当前 Markdown 不一致，请重新载入画布。' };
    }
  }
  const scene = buildCanvasExportScene(input.cards, input.links, input);
  let size: { width: number; height: number };
  try { size = assertCanvasExportSize(scene.bounds); }
  catch (error) { return { status: 'error', reason: (error as Error).message }; }
  const { width, height } = size;
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner) throw new Error('窗口已关闭。');
  const extension = exportExtension(input.format);
  const baseName = path.basename(session.document.path, path.extname(session.document.path));
  const defaultPath = path.join(path.dirname(session.document.path), `${baseName}.mermarkd${extension}`);
  const selected = await dialog.showSaveDialog(owner, {
    title: '导出卡片画布',
    defaultPath,
    filters: [{ name: input.format.toUpperCase(), extensions: [input.format] }],
  });
  if (selected.canceled || !selected.filePath) return { status: 'cancelled' };
  const target = path.extname(selected.filePath).toLocaleLowerCase() === extension
    ? selected.filePath : `${selected.filePath}${extension}`;
  if ([session.document.path, `${session.document.path}.annotations.yaml`, `${session.document.path}.mermarkd.json`].some((reserved) => sameWindowsPath(target, reserved))) {
    return { status: 'error', reason: '导出目标不能覆盖 Markdown 或其 sidecar。' };
  }
  const content = new Map(scene.cards.map((card) => [card.id, canvasCardContent(document.content, tree, card.sectionIndex)]));
  const svg = canvasSceneToSvg(scene, input, content);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>@page{size:${width}px ${height}px;margin:0}html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden;background:${input.background ?? '#f3f6f8'}}</style></head><body>${svg}</body></html>`;
  let renderer: BrowserWindow | undefined;
  try {
    renderer = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      backgroundColor: input.background ?? '#f3f6f8',
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    renderer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await renderer.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const fits = await renderer.webContents.executeJavaScript(`(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return [...document.querySelectorAll('.export-card')].every((card) => card.scrollHeight <= card.parentElement.height.baseVal.value && card.scrollWidth <= 300)
        && [...document.querySelectorAll('[data-link] text')].every((text) => {
          const box = text.getBBox(); return box.x >= 0 && box.y >= 0 && box.x + box.width <= ${width} && box.y + box.height <= ${height};
        });
    })()`);
    if (!fits) return { status: 'error', reason: '导出文字超出卡片或场景边界，已停止导出；请自动整理后重试。' };
    let bytes: Buffer;
    if (input.format === 'pdf') {
      bytes = await renderer.webContents.printToPDF({
          displayHeaderFooter: false,
          landscape: width > height,
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          pageSize: { width: width / 96, height: height / 96 },
          preferCSSPageSize: true,
          printBackground: true,
        });
    } else {
      const image = await renderer.webContents.capturePage({ x: 0, y: 0, width, height }, { stayHidden: true });
      const actualSize = image.getSize();
      if (image.isEmpty() || actualSize.width !== width || actualSize.height !== height) {
        return { status: 'error', reason: `导出引擎返回 ${actualSize.width} × ${actualSize.height}，预期 ${width} × ${height}；已停止保存以避免裁切。` };
      }
      bytes = input.format === 'jpg' ? image.toJPEG(92) : image.toPNG();
    }
    if (!bytes.length) throw new Error('Empty export output.');
    assertCurrentSession(event, session);
    if (session.document !== document || session.editor?.dirty || createHash('sha256').update(await readFile(document.path)).digest('hex') !== document.sourceSha256) {
      return { status: 'error', reason: '导出期间 Markdown 发生变化，请重新载入画布后重试。' };
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx');
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
    return { status: 'saved', path: target, format: input.format, width, height, pages: 1 };
  } catch (error) {
    console.error('[canvas:export]', error);
    return { status: 'error', reason: '画布导出失败，未能写入完整文件。' };
  } finally {
    if (renderer && !renderer.isDestroyed()) renderer.destroy();
  }
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
  const result = await loadAnnotationDocumentData(session.document.path, annotationDraftDirectory());
  if (!result.ok) {
    setLoadedState(undefined);
    const loaded = result.loaded;
    return {
      status: 'read-only', count: 0, unresolvedCount: 0, relocatableCount: 0,
      pendingDraftCount: loaded ? loaded.pendingDrafts.length + loaded.unreadableDraftPaths.length : 0,
      ...(loaded && { unreadableDraftCount: loaded.unreadableDraftPaths.length }),
      tags: [], items: [],
      sidecarPath: loaded?.sidecarPath ?? `${session.document.path}.annotations.yaml`,
      errorCode: result.errorCode,
      reason: result.reason,
    };
  }
  const { loaded, sourceBytes, currentHash, model } = result;
  const view: AnnotationDocumentView = {
    status: 'ready', count: 0, unresolvedCount: 0, relocatableCount: 0,
    pendingDraftCount: loaded.pendingDrafts.length + loaded.unreadableDraftPaths.length,
    unreadableDraftCount: loaded.unreadableDraftPaths.length,
    sidecarPath: loaded.sidecarPath,
    tags: [],
    items: [],
  };
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
  const blocked = annotationMutationBlocked(session);
  if (blocked) return blocked;
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
  const blocked = annotationMutationBlocked(session);
  if (blocked) return blocked;
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
  const blocked = annotationMutationBlocked(session);
  if (blocked) return blocked;
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
  const blocked = annotationMutationBlocked(session);
  if (blocked) return blocked;
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
  const blocked = annotationMutationBlocked(session);
  if (blocked) return blocked;
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
  const blocked = annotationMutationBlocked(session);
  if (blocked) return blocked;
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
  const blocked = annotationMutationBlocked(session);
  if (blocked) throw new Error(blocked.reason ?? 'Markdown 状态正在变化，请稍后重新复制摘要。');
  const state = session.annotations;
  if (!state) throw new Error('批注状态尚未就绪，请重新载入后再复制。');
  const annotationRevision = session.annotationRevision ?? 0;
  const sourceSha256 = session.document.sourceSha256;
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
  if (
    documentSessions.get(event.sender.id) !== session ||
    (session.annotationRevision ?? 0) !== annotationRevision ||
    session.document.sourceSha256 !== sourceSha256 ||
    annotationMutationBlocked(session)
  ) {
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
  const inventory = await listDocumentTransactions(filePath);
  const recoveryPending = inventory.some((item) => !item.completed && item.status !== 'committed');
  return { path: filePath, name: path.basename(filePath), ...decodeMarkdownSource(bytes), ...(recoveryPending ? { recoveryPending } : {}) };
}

function recentDocumentsPath(): string {
  return path.join(app.getPath('userData'), 'recent-documents.json');
}

async function readRecentDocuments(): Promise<RecentDocument[]> {
  try {
    const text = await readFile(recentDocumentsPath(), 'utf8');
    return parseRecentDocuments(text);
  } catch {
    return [];
  }
}

async function writeRecentDocuments(entries: readonly RecentDocument[]): Promise<void> {
  try {
    await writeFile(recentDocumentsPath(), serializeRecentDocuments(entries), 'utf8');
  } catch (error) {
    // Recent files are a convenience; a preferences failure must never block
    // opening or saving the user's Markdown document.
    console.error('[recent-documents]', error);
  }
}

async function recordOpenedDocument(document: OpenedMarkdownDocument): Promise<void> {
  const entries = await readRecentDocuments();
  await writeRecentDocuments(recordRecentDocument(entries, document.path));
}

async function recentDocumentViews(): Promise<RecentMarkdownDocument[]> {
  const entries = await readRecentDocuments();
  const available: RecentDocument[] = [];
  let changed = false;
  for (const entry of entries) {
    try {
      const validated = await validatedLocalMarkdownPath(entry.path);
      available.push(validated === entry.path ? entry : { ...entry, path: validated });
      changed ||= validated !== entry.path;
    } catch {
      changed = true;
    }
  }
  if (changed) await writeRecentDocuments(available);
  return available.map((entry) => ({ path: entry.path, name: path.basename(entry.path), openedAt: entry.openedAt }));
}

function selectedNewMarkdownPath(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.extname(value).toLowerCase() !== '.md') {
    throw new Error('请选择以 .md 结尾的新文件。');
  }
  return path.normalize(value);
}

async function recoveryPreviewFor(event: IpcMainInvokeEvent, documentPath: string, ref: DocumentTransactionRef): Promise<DocumentRecoveryPreview> {
  const session = sessionFor(event);
  const inspected = await inspectDocumentTransaction(documentPath, ref);
  assertCurrentSession(event, session);
  const token = randomUUID();
  const recoverable = Object.values(inspected.current).every((state) => state !== 'conflict');
  recoveryPreviews.set(event.sender.id, { token, documentPath, ref, session });
  return { token, documentName: path.basename(documentPath),
    source: decodeMarkdownBytes(inspected.before.markdown).content,
    candidate: decodeMarkdownBytes(inspected.after.markdown).content,
    files: (['markdown', 'annotations', 'canvas'] as const).map((kind) => ({
      name: kind === 'markdown' ? 'Markdown' : kind === 'annotations' ? '批注 YAML' : '画布 JSON', status: inspected.current[kind],
    })), recoverable, message: recoverable
      ? '候选和原始快照已核验。确认将继续此次保存，并同步尚未完成的文件；原始快照保留。'
      : '至少一份文件已被外部修改，当前不能恢复；外部文件和恢复快照均保留。' };
}

function registerReaderIpc(): void {
  ipcMain.handle('document:recovery-list', async (event): Promise<readonly DocumentRecoveryItem[]> => {
    const session = sessionFor(event);
    if (!session) return [];
    const inventory = await listDocumentTransactions(session.document.path);
    assertCurrentSession(event, session);
    return inventory.filter((item) => !item.completed && (item.status !== 'committed' || item.id === session.editor?.pendingStructureTransactionId))
      .map((item) => ({ id: item.id, status: item.status === 'committed' ? 'interrupted' : item.status as DocumentRecoveryItem['status'], canPreview: Boolean(item.ref) }));
  });

  ipcMain.handle('document:recovery-preview', async (event, value: unknown): Promise<DocumentRecoveryPreview> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开文档，或选择文档恢复记录。');
    const id = validOpaqueId(value, '文档恢复记录');
    const item = (await listDocumentTransactions(session.document.path)).find((entry) => entry.id === id && !entry.completed &&
      (entry.status !== 'committed' || entry.id === session.editor?.pendingStructureTransactionId));
    if (!item?.ref) throw new Error('恢复记录无法核验，请重新检查。');
    return recoveryPreviewFor(event, session.document.path, item.ref);
  });

  ipcMain.handle('document:recovery-select', async (event): Promise<DocumentRecoveryPreview | null> => {
    if (!isMainFrame(event)) return null;
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) return null;
    const session = sessionFor(event);
    const selected = await dialog.showOpenDialog(owner, { title: '选择文档保存恢复记录（.journal.json）', properties: ['openFile'],
      ...(session ? { defaultPath: path.dirname(session.document.path) } : {}), filters: [{ name: '文档恢复记录', extensions: ['json'] }] });
    assertCurrentSession(event, session);
    if (selected.canceled || selected.filePaths.length !== 1) return null;
    const journalPath = await realpath(selected.filePaths[0]);
    const match = /^(.*\.md)\.mermarkd-txn\.([0-9a-f-]{36})\.journal\.json$/i.exec(path.basename(journalPath));
    if (!match) throw new Error('请选择文档同目录的 MerMarkd .journal.json 恢复记录。');
    const id = validOpaqueId(match[2], '文档恢复记录');
    const documentPath = path.join(path.dirname(journalPath), match[1]);
    const item = (await listDocumentTransactions(documentPath)).find((entry) => entry.id === id);
    if (!item?.ref) throw new Error('恢复记录无法安全核验，请保留原文件和快照。');
    return recoveryPreviewFor(event, documentPath, item.ref);
  });

  ipcMain.handle('document:recovery-cancel', (event, value: unknown) => {
    const token = validOpaqueId(value, '恢复预览');
    if (recoveryPreviews.get(event.sender.id)?.token === token) recoveryPreviews.delete(event.sender.id);
  });

  ipcMain.handle('document:recovery-confirm', async (event, value: unknown): Promise<DocumentRecoveryResult> => {
    if (!isMainFrame(event) || !BrowserWindow.fromWebContents(event.sender)) throw new Error('无法从当前窗口恢复文档。');
    const token = validOpaqueId(value, '恢复预览');
    const preview = recoveryPreviews.get(event.sender.id);
    const session = sessionFor(event);
    if (!preview || preview.token !== token || preview.session !== session) return { status: 'conflict', message: '恢复预览已过期，请重新检查。' };
    if (session?.editor?.dirty && (session.document.path !== preview.documentPath || session.editor.pendingStructureTransactionId !== preview.ref.id)) {
      return { status: 'conflict', message: '当前源码有其他未保存修改，请先保存或放弃编辑，再恢复文档。' };
    }
    if (session && (session.canvasWriteInProgress || session.canvasExportInProgress || session.annotationWriteInProgress || session.markdownOperationInProgress || session.editor?.writeInProgress)) {
      return { status: 'conflict', message: '文档正在处理，请稍后继续恢复。' };
    }
    if (session) session.markdownOperationInProgress = true;
    try {
      const result = await recoverDocumentTransaction(preview.documentPath, preview.ref);
      if (result.status !== 'committed') return { status: result.status === 'pending' ? 'pending' : 'conflict',
        message: result.status === 'busy' ? '文档保存锁仍存在，恢复暂时停止，文件与快照保留。'
          : '恢复尚未完成或文件发生外部变化，未覆盖外部版本；请保留快照并重新检查。' };
      const document = await loadMarkdownDocument(preview.documentPath);
      assertCurrentSession(event, session);
      documentSessions.set(event.sender.id, { document });
      recoveryPreviews.delete(event.sender.id);
      return { status: 'recovered', document, message: '本次保存已恢复，三个文件已核验；原始和候选快照仍保留。' };
    } catch (error) {
      console.error('[document:recovery]', error);
      return { status: 'pending', message: '恢复未能完成，文件与快照保留；请重新检查保存恢复。' };
    } finally { if (session) session.markdownOperationInProgress = false; }
  });

  ipcMain.handle('document:recent-list', async (): Promise<readonly RecentMarkdownDocument[]> => recentDocumentViews());

  ipcMain.handle('document:recent-remove', async (event, value: unknown): Promise<void> => {
    if (!isMainFrame(event)) return;
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('最近文件路径无效。');
    const entries = await readRecentDocuments();
    await writeRecentDocuments(removeRecentDocument(entries, value));
  });

  ipcMain.handle('document:open-recent', async (event, value: unknown): Promise<OpenedMarkdownDocument> => {
    if (!isMainFrame(event) || !BrowserWindow.fromWebContents(event.sender)) {
      throw new Error('无法从当前窗口打开最近文档。');
    }
    const existingSession = sessionFor(event);
    assertDocumentCanBeReplaced(existingSession);
    const filePath = await validatedLocalMarkdownPath(value);
    const document = await loadMarkdownDocument(filePath);
    assertCurrentSession(event, existingSession);
    assertDocumentCanBeReplaced(existingSession);
    documentSessions.set(event.sender.id, { document });
    await recordOpenedDocument(document);
    return document;
  });

  ipcMain.handle('document:new', async (event): Promise<OpenedMarkdownDocument | null> => {
    if (!isMainFrame(event)) return null;
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) return null;
    const existingSession = sessionFor(event);
    assertDocumentCanBeReplaced(existingSession);
    const selection = await dialog.showSaveDialog(owner, {
      title: '新建 Markdown 文档',
      defaultPath: path.join(app.getPath('documents'), '未命名.md'),
      filters: [{ name: 'Markdown 文档', extensions: ['md'] }],
    });
    if (selection.canceled || !selection.filePath) return null;
    const filePath = selectedNewMarkdownPath(selection.filePath);
    try {
      await writeFile(filePath, new Uint8Array(), { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('目标文件已存在，请选择其他名称；未覆盖原文件。');
      }
      throw new Error('无法创建 Markdown 文件，请确认目标目录可写。');
    }
    const document = await loadMarkdownDocument(filePath);
    assertCurrentSession(event, existingSession);
    assertDocumentCanBeReplaced(existingSession);
    documentSessions.set(event.sender.id, { document });
    await recordOpenedDocument(document);
    return document;
  });

  ipcMain.handle('document:open', async (event): Promise<OpenedMarkdownDocument | null> => {
    if (!isMainFrame(event)) return null;
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) return null;
    const existingSession = sessionFor(event);
    assertDocumentCanBeReplaced(existingSession);

    const selection = await dialog.showOpenDialog(owner, {
      title: '打开 Markdown 文档',
      properties: ['openFile'],
      filters: [{ name: 'Markdown 文档', extensions: ['md'] }],
    });
    const selectedPath = selectedMarkdownPath(selection);
    if (!selectedPath) return null;

    const filePath = await validatedLocalMarkdownPath(selectedPath);
    const document = await loadMarkdownDocument(filePath);
    assertCurrentSession(event, existingSession);
    assertDocumentCanBeReplaced(existingSession);
    documentSessions.set(event.sender.id, { document });
    await recordOpenedDocument(document);
    return document;
  });

  ipcMain.handle('document:open-dropped', async (event, droppedPath: unknown): Promise<OpenedMarkdownDocument> => {
    if (!isMainFrame(event) || !BrowserWindow.fromWebContents(event.sender)) {
      throw new Error('无法从当前窗口打开文件。');
    }
    const existingSession = sessionFor(event);
    assertDocumentCanBeReplaced(existingSession);

    const filePath = await validatedDroppedMarkdownPath(droppedPath);
    const document = await loadMarkdownDocument(filePath);
    assertCurrentSession(event, existingSession);
    assertDocumentCanBeReplaced(existingSession);
    documentSessions.set(event.sender.id, { document });
    await recordOpenedDocument(document);
    return document;
  });

  ipcMain.handle('document:reload', async (event): Promise<OpenedMarkdownDocument> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    assertDocumentCanBeReplaced(session);
    const filePath = await validatedLocalMarkdownPath(session.document.path);
    const document = await loadMarkdownDocument(filePath);
    assertCurrentSession(event, session);
    assertDocumentCanBeReplaced(session);
    documentSessions.set(event.sender.id, { document });
    await recordOpenedDocument(document);
    return document;
  });

  ipcMain.handle('markdown-editor:open', async (event): Promise<MarkdownEditorView> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    assertEditorCanMutate(session);
    if (!session.editor) {
      const editor = await MarkdownEditorSession.create(session.document, markdownDraftDirectory());
      assertCurrentSession(event, session);
      session.editor ??= editor;
    }
    return session.editor.view();
  });

  ipcMain.handle('markdown-editor:update', (event, value: unknown): MarkdownEditorView => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    assertEditorCanMutate(session);
    return currentEditor(session).update(validMarkdownEditorUpdate(value));
  });

  ipcMain.handle('markdown-editor:annotation-impact', async (event, value: unknown): Promise<MarkdownAnnotationImpact> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    const editor = currentEditor(session);
    const entry = objectWithFields(value, '批注影响预览', ['epoch', 'content']);
    const input = validMarkdownEditorUpdate({ ...entry, revision: 0 });
    assertEditorEpoch(editor, input.epoch);
    const document = session.document;
    const revision = session.annotationRevision ?? 0;
    const baseline = await prepareAnnotationEditBaseline(session);
    assertCurrentSession(event, session);
    assertEditorEpoch(currentEditor(session), input.epoch);
    if (session.document !== document || (session.annotationRevision ?? 0) !== revision ||
      session.annotationWriteInProgress || session.markdownOperationInProgress) {
      throw new Error('文档或批注已变化，请重新预览。');
    }
    if (baseline.status !== 'ready') {
      return { status: baseline.status, mappedCount: 0, unresolved: [],
        message: baseline.status === 'not-needed' ? '当前没有批注，预览不会创建批注文件。'
          : '现有批注基线或恢复草稿需要先审查；保存时会保留现有批注，不自动迁移。' };
    }
    const bytes = encodeMarkdownBytes(input.content, document.bomByteLength);
    const mapping = await mapAnnotationSidecarThroughEdit(baseline.model,
      { bytes: baseline.sourceBytes, content: document.content, sha256: document.sourceSha256 },
      { bytes, content: input.content, sha256: createHash('sha256').update(bytes).digest('hex') },
      safeTimestamp(baseline.model));
    assertCurrentSession(event, session);
    if (session.document !== document || (session.annotationRevision ?? 0) !== revision) {
      throw new Error('文档或批注已变化，请重新预览。');
    }
    const unresolvedIds = new Set(mapping.items.filter((item) => item.status === 'unresolved').map((item) => item.id));
    return { status: 'ready', mappedCount: mapping.mappedCount,
      unresolved: baseline.model.annotations.filter((item) => unresolvedIds.has(item.id))
        .map((item) => ({ id: item.id, quote: Array.from(item.anchor.displayQuote).slice(0, 120).join('') })),
      message: `${mapping.mappedCount} 条批注可随保存同步；${mapping.unresolvedCount} 条将保留旧位置，待阅读模式重新定位。` };
  });

  ipcMain.handle('section-structure:preview', async (event, value: unknown): Promise<SectionStructurePreview> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    if (session.editor?.dirty) throw new Error('Markdown 有未保存修改；请先保存或放弃源码编辑。');
    assertEditorCanMutate(session);
    session.sectionStructurePreview = undefined;
    const operation = validSectionStructureOperation(value);
    const document = session.document;
    const quick = previewSectionTransform(document.content, operation);
    if (quick.status !== 'ready') {
      return { status: quick.status, operation, sourceSha256: document.sourceSha256, source: document.content, rejection: quick.rejection };
    }
    session.markdownOperationInProgress = true;
    try {
      if ((await prepareAnnotationEditBaseline(session)).status === 'deferred') {
        throw new Error('请先在阅读模式处理批注基线或恢复草稿，再预览结构变更。');
      }
      const plan = await prepareSectionStructurePlan(document, operation);
      assertCurrentSession(event, session);
      const token = randomUUID();
      session.sectionStructurePreview = { token, plan };
      return {
        status: 'ready', token, operation, sourceSha256: document.sourceSha256,
        source: plan.preview.source, candidate: plan.preview.candidate, summary: plan.preview.summary, impact: plan.impact,
      };
    } finally {
      session.markdownOperationInProgress = false;
    }
  });

  ipcMain.handle('section-structure:cancel', (event, value: unknown): { status: 'cancelled' | 'expired'; message: string } => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    const token = validOpaqueId(value, '结构预览');
    if (!session.sectionStructurePreview || session.sectionStructurePreview.token !== token) {
      return { status: 'expired', message: '结构预览已过期，请重新生成。' };
    }
    session.sectionStructurePreview = undefined;
    return { status: 'cancelled', message: '结构变更预览已取消。' };
  });

  ipcMain.handle('section-structure:confirm', async (event, value: unknown): Promise<SectionStructureConfirmResult> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    const token = validOpaqueId(value, '结构预览');
    const stored = session.sectionStructurePreview;
    if (!stored || stored.token !== token) return { status: 'expired', message: '结构预览已过期，请重新生成。' };
    if (session.editor?.dirty) {
      session.sectionStructurePreview = undefined;
      return { status: 'expired', message: 'Markdown 在确认前出现未保存修改，预览已失效。' };
    }
    assertEditorCanMutate(session);
    const document = session.document;
    session.markdownOperationInProgress = true;
    try {
      if ((await prepareAnnotationEditBaseline(session)).status === 'deferred') {
        throw new Error('批注基线或恢复草稿已变化。');
      }
      session.editor ??= await MarkdownEditorSession.create(document, markdownDraftDirectory());
      const editor = await session.editor.stageSectionStructure(stored.plan);
      session.sectionStructurePreview = undefined;
      return { status: 'staged', editor, impact: stored.plan.impact, message: '结构变更已进入未保存源码，可撤销；显式保存后再同步三个文件。' };
    } catch (error) {
      console.error('[section-structure:confirm]', error);
      session.sectionStructurePreview = undefined;
      return { status: 'expired', message: '文档、批注或画布在预览后发生变化，未接受变更；请重新生成预览。' };
    } finally {
      session.markdownOperationInProgress = false;
    }
  });

  ipcMain.handle('markdown-editor:persist-draft', async (event, value: unknown): Promise<MarkdownEditorView> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    const editor = currentEditor(session);
    const input = validMarkdownEditorUpdate(value);
    return withMarkdownOperation(session, async () => {
      const view = await editor.persistDraft(input);
      assertCurrentSession(event, session);
      return view;
    });
  });

  ipcMain.handle('markdown-editor:save', async (event, value: unknown): Promise<MarkdownEditorSaveResult> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    const editor = currentEditor(session);
    const input = validMarkdownEditorUpdate(value);
    return withMarkdownOperation(session, async () => {
      const result = await saveMarkdownWithAnnotationMapping(session, editor, input);
      assertCurrentSession(event, session);
      return result;
    });
  });

  ipcMain.handle('markdown-editor:restore-draft', (event, value: unknown): MarkdownEditorView => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    assertEditorCanMutate(session);
    const editor = currentEditor(session);
    const input = validMarkdownRecoveryInput(value);
    assertEditorEpoch(editor, input.epoch);
    return editor.restoreRecoveryDraft(input.id);
  });

  ipcMain.handle('markdown-editor:discard-draft', async (event, value: unknown): Promise<MarkdownEditorView> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    const editor = currentEditor(session);
    const input = validMarkdownRecoveryInput(value);
    assertEditorEpoch(editor, input.epoch);
    return withMarkdownOperation(session, async () => {
      const view = await editor.discardRecoveryDraft(input.id);
      assertCurrentSession(event, session);
      return view;
    });
  });

  ipcMain.handle('markdown-editor:discard-changes', async (event, value: unknown): Promise<MarkdownEditorDiscardResult> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    const editor = currentEditor(session);
    const epoch = validOpaqueId(value, 'Markdown 文档版本');
    assertEditorEpoch(editor, epoch);
    return withMarkdownOperation(session, async () => {
      const filePath = await validatedLocalMarkdownPath(session.document.path);
      const document = await loadMarkdownDocument(filePath);
      assertCurrentSession(event, session);
      await editor.discardChanges();
      const replacement = await MarkdownEditorSession.create(document, markdownDraftDirectory());
      assertCurrentSession(event, session);
      session.document = document;
      session.editor = replacement;
      session.sectionStructurePreview = undefined;
      session.annotations = undefined;
      session.annotationRevision = (session.annotationRevision ?? 0) + 1;
      return { document, editor: replacement.view() };
    });
  });

  ipcMain.handle('markdown-editor:discard-source-backup', async (event, value: unknown): Promise<MarkdownEditorView> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    const editor = currentEditor(session);
    const input = validMarkdownRecoveryInput(value);
    assertEditorEpoch(editor, input.epoch);
    return withMarkdownOperation(session, async () => {
      const view = await editor.discardLatestSourceBackup(input.id);
      assertCurrentSession(event, session);
      return view;
    });
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

  ipcMain.handle('canvas:load', async (event): Promise<CanvasLoadResult> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    try {
      const candidate = session.editor?.structureCanvas;
      if (candidate !== undefined) return { status: candidate === null ? 'missing' : 'ready',
        model: candidate === null ? null : parseCanvasJson(textDecoder.decode(candidate)), sidecarSha256: null };
      const loaded = await loadCanvasFile(session.document.path);
      assertCurrentSession(event, session);
      return { ...loaded, status: loaded.model === null ? 'missing'
        : loaded.model.source.sha256 === session.document.sourceSha256 ? 'ready' : 'stale' };
    } catch (error) {
      console.error('[canvas:load]', error);
      return { status: 'invalid', model: null, sidecarSha256: null, reason: '画布文件无法安全读取，原文件保留；请检查后重新载入。' };
    }
  });

  ipcMain.handle('canvas:save', async (event, value: unknown): Promise<CanvasSaveResult> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    if (session.document.recoveryPending || session.editor?.pendingStructureTransactionId) return { status: 'conflict', reason: '请先检查文档保存恢复。' };
    if (session.editor?.dirty) return { status: 'conflict', reason: 'Markdown 未保存，画布写入已暂停。' };
    if (session.canvasExportInProgress) return { status: 'conflict', reason: '画布正在导出，请稍后再保存布局。' };
    if (session.canvasWriteInProgress || session.annotationWriteInProgress || session.markdownOperationInProgress || session.editor?.writeInProgress) {
      return { status: 'conflict', reason: '另一项文档保存仍在进行。' };
    }
    const entry = objectWithFields(value, '画布保存', ['sourceSha256', 'expectedSidecarSha256', 'model']);
    if (entry.sourceSha256 !== session.document.sourceSha256 ||
      (entry.expectedSidecarSha256 !== null && (typeof entry.expectedSidecarSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.expectedSidecarSha256)))) {
      return { status: 'conflict', reason: '文档版本已变化，请重新载入画布。' };
    }
    const model = validateCanvasState(entry.model);
    session.canvasWriteInProgress = true;
    try {
      const result = await saveCanvasFile({ documentPath: session.document.path, sourceSha256: session.document.sourceSha256,
        expectedSidecarSha256: entry.expectedSidecarSha256 as string | null, model });
      assertCurrentSession(event, session);
      return result.status === 'saved' ? result : { ...result, reason: result.status === 'conflict'
        ? '原文或画布在外部发生变化，未覆盖；当前画布候选仍保留。'
        : '画布暂未保存，当前候选仍保留；已准备的事务可用于恢复。' };
    } finally { session.canvasWriteInProgress = false; }
  });

  ipcMain.handle('canvas:export', async (event, value: unknown): Promise<CanvasExportResult> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    if (session.canvasExportInProgress) return { status: 'error', reason: '画布仍在导出，请稍后重试。' };
    session.canvasExportInProgress = true;
    try { return await exportCanvasFor(event, value); }
    catch (error) {
      console.error('[canvas:export]', error);
      return { status: 'error', reason: '导出参数无效或场景无法核验，请重新载入画布后重试。' };
    } finally { session.canvasExportInProgress = false; }
  });

  ipcMain.handle('annotations:create-highlight', async (event, value: unknown): Promise<AnnotationSaveResult> => {
    if (!sessionFor(event)) throw new Error('请先打开 Markdown 文档。');
    const input = validCreateHighlight(value);
    return createHighlight(event, input.selection, input.color);
  });

  ipcMain.handle('annotations:recolor-highlight', async (event, value: unknown): Promise<AnnotationSaveResult> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    const blocked = annotationMutationBlocked(session);
    if (blocked) return blocked;
    const state = session.annotations;
    if (!state) return { status: 'conflict', reason: '批注文件尚未就绪或处于只读状态，请重新打开文档。' };
    const input = validRecolorHighlight(value);
    const mutation = recolorHighlightCandidate(state.model, input.id, input.color, new Date().toISOString());
    return persistAnnotationMutation(event, session, state, mutation);
  });

  ipcMain.handle('annotations:delete-highlight', async (event, value: unknown): Promise<AnnotationSaveResult> => {
    const session = sessionFor(event);
    if (!session) throw new Error('请先打开 Markdown 文档。');
    const blocked = annotationMutationBlocked(session);
    if (blocked) return blocked;
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
    const blocked = annotationMutationBlocked(session);
    if (blocked) return blocked;
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
    const blocked = annotationMutationBlocked(session);
    if (blocked) return blocked;
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
  window.webContents.on('destroyed', () => {
    documentSessions.delete(window.webContents.id);
    recoveryPreviews.delete(window.webContents.id);
  });

  let allowClose = false;
  let resolvingClose = false;
  window.on('close', (event) => {
    if (allowClose) return;
    const session = documentSessions.get(window.webContents.id);
    if (!session) return;
    const editor = session.editor;
    const busy = Boolean(
      session.canvasWriteInProgress ||
      session.canvasExportInProgress ||
      session.annotationWriteInProgress ||
      session.markdownOperationInProgress ||
      editor?.writeInProgress,
    );
    if (!busy && !editor?.dirty) return;

    event.preventDefault();
    if (resolvingClose) return;
    resolvingClose = true;
    void (async () => {
      if (busy) {
        await dialog.showMessageBox(window, {
          type: 'info',
          title: '保存仍在进行',
          message: '文档或批注仍在保存，请稍后再关闭窗口。',
          buttons: ['确定'],
          defaultId: 0,
        });
        return;
      }
      if (!editor?.dirty) return;

      if (editor.pendingStructureTransactionId) {
        const choice = await dialog.showMessageBox(window, { type: 'warning', title: '结构保存尚待恢复',
          message: '此次保存尚未完成，原始和候选快照已经保留。',
          detail: '返回应用可通过“检查保存恢复”继续核验；关闭后也可选择同目录的 journal 恢复记录。',
          buttons: ['返回检查恢复', '保留恢复记录并关闭'], defaultId: 0, cancelId: 0, noLink: true });
        if (choice.response === 1) { allowClose = true; window.close(); }
        return;
      }

      const choice = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'Markdown 尚未保存',
        message: '要在关闭窗口前保存 Markdown 修改吗？',
        detail: '保存会再次核验磁盘版本；外部冲突时窗口会保持打开，候选内容会留在恢复草稿中。',
        buttons: ['保存', '不保存', '取消'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (choice.response === 2) return;

      if (choice.response === 0) {
        const view = editor.view();
        const result = await withMarkdownOperation(session, () => saveMarkdownWithAnnotationMapping(session, editor, {
          epoch: view.epoch,
          revision: view.revision,
          content: view.content,
        }));
        if (result.status !== 'saved') {
          await dialog.showMessageBox(window, {
            type: 'error',
            title: 'Markdown 未保存',
            message: result.message,
            buttons: ['返回编辑'],
            defaultId: 0,
          });
          return;
        }
      } else {
        await withMarkdownOperation(session, () => editor.discardChanges());
      }

      allowClose = true;
      window.close();
    })().catch(async (error: unknown) => {
      console.error('Failed to resolve Markdown state before closing the window.', error);
      if (!window.isDestroyed()) {
        await dialog.showMessageBox(window, {
          type: 'error',
          title: '无法关闭文档',
          message: error instanceof Error ? error.message : '处理未保存的 Markdown 时发生错误。',
          buttons: ['返回编辑'],
          defaultId: 0,
        });
      }
    }).finally(() => {
      resolvingClose = false;
    });
  });

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
