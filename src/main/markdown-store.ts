import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  link,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import {
  assertMarkdownLineEndingsPreserved,
  decodeMarkdownBytes,
  encodeMarkdownBytes,
  inspectMarkdownSourceFormat,
} from '../core/markdown-source.ts';
import type { MarkdownSourceFormat } from '../core/markdown-source.ts';
import { extractSections } from '../core/sections.ts';

const draftSchemaVersion = 1;
const lockSchemaVersion = 1;
const maxMarkdownDraftSourceBytes = 32 * 1024 * 1024;
// A JSON string can expand one input byte into a six-byte escape sequence.
const maxMarkdownDraftBytes = maxMarkdownDraftSourceBytes * 6 + 64 * 1024;
const maxMarkdownLockBytes = 64 * 1024;
const draftFilenamePattern =
  /^([0-9a-f]{64})\.markdown\.pending\.([0-9]{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
const temporaryDraftFilenamePattern =
  /^(.*\.json)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tmp$/;

interface DraftFilenameInfo {
  readonly documentKey: string;
  readonly temporary: boolean;
  readonly publishedFilename: string;
}

interface PersistedMarkdownDraft {
  readonly schemaVersion: 1;
  readonly kind: 'markdown';
  /** Stable path spelling used when the draft was created, even for symlinks. */
  readonly documentIdentityPath: string;
  /** Canonical source target used for I/O while it existed. */
  readonly documentPath: string;
  readonly expectedSourceSha256: string;
  readonly candidateSha256: string;
  readonly bomByteLength: 0 | 3;
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PersistedMarkdownSaveLock {
  readonly schemaVersion: 1;
  readonly kind: 'markdown-save-lock';
  readonly documentPath: string;
  readonly ownerToken: string;
  readonly pid: number;
  readonly createdAt: string;
}

export interface MarkdownDraftRevision {
  readonly draftPath: string;
  readonly draftSha256: string;
}

export interface SaveMarkdownDraftInput {
  readonly documentPath: string;
  readonly draftDirectory: string;
  readonly expectedSourceSha256: string;
  readonly content: string;
  readonly bomByteLength: 0 | 3;
  /**
   * A prior immutable generation that this generation supersedes. It is
   * removed only after the new generation is durable and only by exact SHA.
   */
  readonly previousDraft?: MarkdownDraftRevision;
}

export type MarkdownDraftRelationship =
  | 'recoverable'
  | 'already-saved'
  | 'conflict'
  | 'source-missing'
  | 'source-unreadable';

export type MarkdownCleanupWarning =
  | 'superseded-draft-retained'
  | 'saved-draft-retained'
  | 'temporary-file-retained'
  | 'document-lock-retained'
  | 'source-backup-retained';

export interface MarkdownDraft extends MarkdownDraftRevision {
  readonly documentIdentityPath: string;
  readonly documentPath: string;
  readonly expectedSourceSha256: string;
  readonly candidateSha256: string;
  readonly content: string;
  readonly format: MarkdownSourceFormat;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly currentSourceSha256: string | null;
  readonly relationship: MarkdownDraftRelationship;
  readonly supersededDraftRetained: boolean;
  readonly cleanupWarnings: readonly MarkdownCleanupWarning[];
}

export interface UnreadableMarkdownDraft {
  readonly draftPath: string;
  readonly draftSha256: string | null;
  readonly documentKey: string;
  readonly reason: 'too-large' | 'invalid' | 'unreadable';
}

export interface MarkdownDraftInventory {
  readonly drafts: readonly MarkdownDraft[];
  /** Fully persisted temp hard links whose matching final generation exists. */
  readonly retainedTemporaryDrafts: readonly MarkdownDraft[];
  readonly unreadableDrafts: readonly UnreadableMarkdownDraft[];
}

export type LoadMarkdownDraftResult =
  | {
      readonly status: 'none';
      readonly documentPath: string;
    }
  | {
      readonly status: 'available';
      /** Newest valid generation. Older concurrent branches remain available. */
      readonly draft: MarkdownDraft;
      readonly branches: readonly MarkdownDraft[];
      readonly unreadableDrafts: readonly UnreadableMarkdownDraft[];
    }
  | {
      readonly status: 'unreadable';
      readonly documentPath: string;
      readonly unreadableDrafts: readonly UnreadableMarkdownDraft[];
    };

export type DiscardMarkdownDraftResult =
  | { readonly status: 'discarded' | 'missing'; readonly draftPath: string }
  | {
      readonly status: 'conflict';
      readonly draftPath: string;
      readonly currentDraftSha256: string;
    };

export interface SaveMarkdownFileInput extends SaveMarkdownDraftInput {}

interface SaveMarkdownResultBase {
  readonly documentPath: string;
  readonly draftPath: string;
  readonly draftSha256: string;
  readonly candidateSha256: string;
  readonly cleanupWarnings: readonly MarkdownCleanupWarning[];
}

export type SaveMarkdownFileResult =
  | SaveMarkdownResultBase & {
      readonly status: 'saved';
      readonly changed: boolean;
      readonly sourceSha256: string;
      readonly draftRetained: boolean;
      /** Original source inode retained for exact, explicit cleanup. */
      readonly sourceBackup: MarkdownSourceBackup | null;
    }
  | SaveMarkdownResultBase & {
      readonly status: 'conflict';
      readonly reason: 'source-changed' | 'busy';
      readonly currentSourceSha256: string;
    }
  | SaveMarkdownResultBase & {
      readonly status: 'pending-draft';
      readonly reason:
        | 'source-missing'
        | 'source-unreadable'
        | 'unsupported-format'
        | 'parse-error'
        | 'read-only'
        | 'write-error'
        | 'verify-error';
      readonly currentSourceSha256: string | null;
    };

export type InspectMarkdownSaveLockResult =
  | { readonly status: 'missing'; readonly lockPath: string }
  | {
      readonly status: 'locked';
      readonly lockPath: string;
      readonly lockSha256: string;
      readonly ownerToken: string;
      readonly pid: number;
      readonly createdAt: string;
      readonly processAlive: boolean;
    }
  | {
      readonly status: 'unreadable';
      readonly lockPath: string;
      readonly lockSha256: string | null;
    };

export type DiscardMarkdownSaveLockResult =
  | { readonly status: 'discarded' | 'missing'; readonly lockPath: string }
  | {
      readonly status: 'conflict';
      readonly lockPath: string;
      readonly currentLockSha256: string;
    }
  | {
      readonly status: 'active';
      readonly lockPath: string;
      readonly pid: number;
    }
  | {
      readonly status: 'unreadable';
      readonly lockPath: string;
      readonly lockSha256: string;
    };

export interface MarkdownSourceBackup {
  readonly documentPath: string;
  readonly backupPath: string;
  readonly backupSha256: string;
}

export interface UnreadableMarkdownSourceBackup {
  readonly documentPath: string;
  readonly backupPath: string;
  readonly reason: 'unreadable';
}

export interface MarkdownSourceBackupInventory {
  readonly backups: readonly MarkdownSourceBackup[];
  readonly unreadableBackups: readonly UnreadableMarkdownSourceBackup[];
}

export type RecoverMarkdownSourceBackupResult =
  | {
      readonly status: 'restored';
      readonly documentPath: string;
      readonly sourceSha256: string;
      readonly backupRetained: boolean;
    }
  | {
      readonly status: 'missing' | 'source-exists' | 'source-unreadable' | 'locked';
      readonly documentPath: string;
    }
  | {
      readonly status: 'conflict';
      readonly documentPath: string;
      readonly currentBackupSha256: string;
    };

export type DiscardMarkdownSourceBackupResult =
  | { readonly status: 'discarded' | 'missing' | 'locked'; readonly backupPath: string }
  | {
      readonly status: 'conflict';
      readonly backupPath: string;
      readonly currentBackupSha256: string;
    };

/** Narrow seams used to prove interruption and cleanup behavior. */
export interface MarkdownStoreOperations {
  readonly publishDraft?: typeof link;
  readonly moveDocumentToBackup?: typeof rename;
  readonly publishDocument?: typeof link;
  readonly removeDraft?: typeof rm;
  readonly removeSourceBackup?: typeof rm;
  readonly removeDocumentLock?: typeof rm;
  readonly removeTemporaryFile?: typeof rm;
  readonly afterDraftPersisted?: (draftPath: string) => Promise<void>;
  readonly afterTemporaryFileSync?: (temporaryPath: string, documentPath: string) => Promise<void>;
  readonly afterSourceMovedToBackup?: (
    backupPath: string,
    documentPath: string,
  ) => Promise<void>;
}

type SourceState =
  | { readonly status: 'available'; readonly bytes: Buffer; readonly sha256: string }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable' };

interface MarkdownDocumentIdentity {
  readonly identityPath: string;
  readonly documentPath: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sha256File(filePath: string): Promise<string> {
  const file = await open(filePath, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await file.close();
  }
}

async function readFileHandleLimited(
  file: Awaited<ReturnType<typeof open>>,
  maximumBytes: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  while (true) {
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maximumBytes) return null;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks, total);
}

function validSha256(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(label + '无效，未写入任何文件。');
  }
  return value;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isReadOnlyError(error: unknown): boolean {
  return ['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '');
}

function normalizedComparablePath(value: string): string {
  // Keep exact path spelling. Windows can enable case sensitivity per
  // directory, so unconditional case folding can merge two distinct files.
  return path.normalize(path.resolve(value));
}

function samePath(left: string, right: string): boolean {
  return normalizedComparablePath(left) === normalizedComparablePath(right);
}

function validateMarkdownPathShape(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.extname(value).toLowerCase() !== '.md'
  ) {
    throw new Error('Markdown 文档身份无效，未写入任何文件。');
  }
  return path.normalize(path.resolve(value));
}

async function recoverableMarkdownIdentity(value: unknown): Promise<MarkdownDocumentIdentity> {
  const normalized = validateMarkdownPathShape(value);
  try {
    const resolved = await realpath(normalized);
    const fileStat = await stat(resolved);
    if (!fileStat.isFile() || path.extname(resolved).toLowerCase() !== '.md') {
      throw new Error('Markdown 文档身份无效，未写入任何文件。');
    }
    return { identityPath: normalized, documentPath: resolved };
  } catch (error) {
    if (isMissing(error) || ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      // Recovery remains possible when the source was deleted or is temporarily
      // unreadable after the draft was created.
      return { identityPath: normalized, documentPath: normalized };
    }
    throw error;
  }
}

function validatedDraftDirectory(value: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error('Markdown 恢复草稿目录无效，未写入任何文件。');
  }
  return path.normalize(path.resolve(value));
}

function documentKey(documentPath: string): string {
  return sha256(Buffer.from(normalizedComparablePath(documentPath), 'utf8'));
}

function draftPrefix(documentPath: string): string {
  return documentKey(documentPath) + '.markdown.pending.';
}

function newDraftPath(documentPath: string, draftDirectory: string): string {
  const generation = Date.now().toString().padStart(13, '0') + '-' + randomUUID();
  return path.join(draftDirectory, draftPrefix(documentPath) + generation + '.json');
}

function draftFilenameInfo(filename: string): DraftFilenameInfo | null {
  const finalMatch = draftFilenamePattern.exec(filename);
  if (finalMatch !== null) {
    return { documentKey: finalMatch[1], temporary: false, publishedFilename: filename };
  }
  const temporaryMatch = temporaryDraftFilenamePattern.exec(filename);
  if (temporaryMatch === null) return null;
  const temporaryFinalMatch = draftFilenamePattern.exec(temporaryMatch[1]);
  if (temporaryFinalMatch === null) return null;
  return {
    documentKey: temporaryFinalMatch[1],
    temporary: true,
    publishedFilename: temporaryMatch[1],
  };
}

function assertOwnedDraftPath(
  draftPathInput: string,
  draftDirectory: string,
  documentPath: string,
): string {
  if (!path.isAbsolute(draftPathInput)) {
    throw new Error('Markdown 草稿路径无效。');
  }
  const draftPath = path.normalize(path.resolve(draftPathInput));
  const filenameInfo = draftFilenameInfo(path.basename(draftPath));
  if (
    !samePath(path.dirname(draftPath), draftDirectory) ||
    !path.basename(draftPath).startsWith(draftPrefix(documentPath)) ||
    filenameInfo === null
  ) {
    throw new Error('Markdown 草稿不属于当前文档。');
  }
  return draftPath;
}

function decodeDraftText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Markdown 恢复草稿不是有效的 UTF-8 文件。');
  }
}

function parsePersistedDraft(bytes: Uint8Array): PersistedMarkdownDraft {
  const value: unknown = JSON.parse(decodeDraftText(bytes));
  if (
    typeof value !== 'object' || value === null ||
    !('schemaVersion' in value) || value.schemaVersion !== draftSchemaVersion ||
    !('kind' in value) || value.kind !== 'markdown' ||
    !('documentIdentityPath' in value) || typeof value.documentIdentityPath !== 'string' ||
    !('documentPath' in value) || typeof value.documentPath !== 'string' ||
    !('expectedSourceSha256' in value) || typeof value.expectedSourceSha256 !== 'string' ||
    !('candidateSha256' in value) || typeof value.candidateSha256 !== 'string' ||
    !('bomByteLength' in value) || (value.bomByteLength !== 0 && value.bomByteLength !== 3) ||
    !('content' in value) || typeof value.content !== 'string' ||
    !('createdAt' in value) || typeof value.createdAt !== 'string' ||
    !('updatedAt' in value) || typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new Error('Markdown 恢复草稿格式无效。');
  }
  validateMarkdownPathShape(value.documentIdentityPath);
  validateMarkdownPathShape(value.documentPath);
  validSha256(value.expectedSourceSha256, 'Markdown 草稿原文基线');
  validSha256(value.candidateSha256, 'Markdown 草稿候选摘要');
  const candidateBytes = encodeMarkdownBytes(value.content, value.bomByteLength);
  if (candidateBytes.byteLength > maxMarkdownDraftSourceBytes) {
    throw new Error('Markdown 恢复草稿超过大小上限。');
  }
  if (sha256(candidateBytes) !== value.candidateSha256) {
    throw new Error('Markdown 恢复草稿内容与摘要不一致。');
  }
  return value as PersistedMarkdownDraft;
}

async function readDraftBytes(draftPath: string): Promise<Buffer> {
  const file = await open(draftPath, 'r');
  try {
    const fileStat = await file.stat();
    if (!fileStat.isFile() || fileStat.size > maxMarkdownDraftBytes) {
      throw Object.assign(new Error('Markdown 恢复草稿超过大小上限。'), {
        code: 'DRAFT_TOO_LARGE',
      });
    }
    const bytes = await readFileHandleLimited(file, maxMarkdownDraftBytes);
    if (bytes === null) {
      throw Object.assign(new Error('Markdown 恢复草稿超过大小上限。'), {
        code: 'DRAFT_TOO_LARGE',
      });
    }
    return bytes;
  } finally {
    await file.close();
  }
}

async function readSourceState(documentPath: string): Promise<SourceState> {
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    file = await open(documentPath, 'r');
    const fileStat = await file.stat();
    if (!fileStat.isFile() || fileStat.size > maxMarkdownDraftSourceBytes) {
      return { status: 'unreadable' };
    }
    const bytes = await readFileHandleLimited(file, maxMarkdownDraftSourceBytes);
    if (bytes === null) {
      return { status: 'unreadable' };
    }
    return { status: 'available', bytes, sha256: sha256(bytes) };
  } catch (error) {
    if (isMissing(error)) return { status: 'missing' };
    return { status: 'unreadable' };
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function draftRelationship(
  persisted: PersistedMarkdownDraft,
  source: SourceState,
): MarkdownDraftRelationship {
  if (source.status === 'missing') return 'source-missing';
  if (source.status === 'unreadable') return 'source-unreadable';
  if (persisted.candidateSha256 === source.sha256) return 'already-saved';
  if (persisted.expectedSourceSha256 === source.sha256) return 'recoverable';
  return 'conflict';
}

function materializeDraft(
  draftPath: string,
  draftBytes: Uint8Array,
  persisted: PersistedMarkdownDraft,
  source: SourceState,
  supersededDraftRetained = false,
  cleanupWarnings: readonly MarkdownCleanupWarning[] = [],
): MarkdownDraft {
  return {
    draftPath,
    draftSha256: sha256(draftBytes),
    documentIdentityPath: persisted.documentIdentityPath,
    documentPath: persisted.documentPath,
    expectedSourceSha256: persisted.expectedSourceSha256,
    candidateSha256: persisted.candidateSha256,
    content: persisted.content,
    format: inspectMarkdownSourceFormat(persisted.content, persisted.bomByteLength),
    createdAt: persisted.createdAt,
    updatedAt: persisted.updatedAt,
    currentSourceSha256: source.status === 'available' ? source.sha256 : null,
    relationship: draftRelationship(persisted, source),
    supersededDraftRetained,
    cleanupWarnings,
  };
}

function unreadableDraft(
  draftPath: string,
  documentKeyValue: string,
  reason: UnreadableMarkdownDraft['reason'],
  draftSha256: string | null,
): UnreadableMarkdownDraft {
  return { draftPath, draftSha256, documentKey: documentKeyValue, reason };
}

async function draftDirectoryEntries(draftDirectory: string) {
  try {
    return await readdir(draftDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

export async function listMarkdownDrafts(
  draftDirectoryInput: string,
): Promise<MarkdownDraftInventory> {
  const draftDirectory = validatedDraftDirectory(draftDirectoryInput);
  const drafts: MarkdownDraft[] = [];
  const retainedTemporaryDrafts: MarkdownDraft[] = [];
  const unreadableDrafts: UnreadableMarkdownDraft[] = [];
  const sourceStates = new Map<string, Promise<SourceState>>();

  for (const entry of await draftDirectoryEntries(draftDirectory)) {
    if (!entry.isFile()) continue;
    const filenameInfo = draftFilenameInfo(entry.name);
    if (filenameInfo === null) continue;
    const draftPath = path.join(draftDirectory, entry.name);
    let bytes: Buffer;
    try {
      bytes = await readDraftBytes(draftPath);
    } catch (error) {
      let draftSha256: string | null = null;
      try {
        draftSha256 = await sha256File(draftPath);
      } catch {
        // The file may be unreadable or may have disappeared during recovery.
      }
      unreadableDrafts.push(unreadableDraft(
        draftPath,
        filenameInfo.documentKey,
        (error as NodeJS.ErrnoException).code === 'DRAFT_TOO_LARGE'
          ? 'too-large'
          : 'unreadable',
        draftSha256,
      ));
      continue;
    }

    const draftSha256 = sha256(bytes);
    let persisted: PersistedMarkdownDraft;
    try {
      persisted = parsePersistedDraft(bytes);
      if (documentKey(persisted.documentIdentityPath) !== filenameInfo.documentKey) {
        throw new Error('Markdown 恢复草稿的文档身份不一致。');
      }
    } catch {
      unreadableDrafts.push(unreadableDraft(
        draftPath,
        filenameInfo.documentKey,
        'invalid',
        draftSha256,
      ));
      continue;
    }

    const comparable = normalizedComparablePath(persisted.documentPath);
    let sourcePromise = sourceStates.get(comparable);
    if (sourcePromise === undefined) {
      sourcePromise = readSourceState(persisted.documentPath);
      sourceStates.set(comparable, sourcePromise);
    }
    drafts.push(materializeDraft(draftPath, bytes, persisted, await sourcePromise));
  }

  // A crash after exclusive publication but before temp cleanup can expose two
  // hard links to the same generation. Keep the published generation as the
  // recovery candidate and expose the exact temp path for explicit cleanup.
  const draftsByPath = new Map(
    drafts.map((draft) => [normalizedComparablePath(draft.draftPath), draft] as const),
  );
  const recoveryDrafts = drafts.filter((draft) => {
    const filenameInfo = draftFilenameInfo(path.basename(draft.draftPath));
    if (filenameInfo?.temporary !== true) return true;
    const publishedPath = path.join(draftDirectory, filenameInfo.publishedFilename);
    const published = draftsByPath.get(normalizedComparablePath(publishedPath));
    if (published === undefined || published.draftSha256 !== draft.draftSha256) return true;
    retainedTemporaryDrafts.push(draft);
    return false;
  });
  drafts.splice(0, drafts.length, ...recoveryDrafts);
  drafts.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) ||
    right.draftPath.localeCompare(left.draftPath));
  unreadableDrafts.sort((left, right) => right.draftPath.localeCompare(left.draftPath));
  retainedTemporaryDrafts.sort((left, right) => right.draftPath.localeCompare(left.draftPath));
  return { drafts, retainedTemporaryDrafts, unreadableDrafts };
}

export async function loadMarkdownDraft(
  documentPathInput: string,
  draftDirectoryInput: string,
): Promise<LoadMarkdownDraftResult> {
  const draftDirectory = validatedDraftDirectory(draftDirectoryInput);
  const identity = await recoverableMarkdownIdentity(documentPathInput);
  const key = documentKey(identity.identityPath);
  const inventory = await listMarkdownDrafts(draftDirectory);
  const drafts = inventory.drafts.filter((draft) =>
    samePath(draft.documentIdentityPath, identity.identityPath) ||
    samePath(draft.documentPath, identity.documentPath));
  const unreadableDrafts = inventory.unreadableDrafts.filter(
    (draft) => draft.documentKey === key,
  );
  if (drafts.length > 0) {
    return {
      status: 'available',
      draft: drafts[0],
      branches: drafts.slice(1),
      unreadableDrafts,
    };
  }
  if (unreadableDrafts.length > 0) {
    return { status: 'unreadable', documentPath: identity.documentPath, unreadableDrafts };
  }
  return { status: 'none', documentPath: identity.documentPath };
}

async function removeDraftPath(
  draftPath: string,
  operations: MarkdownStoreOperations,
): Promise<void> {
  await (operations.removeDraft ?? rm)(draftPath);
}

export async function discardMarkdownDraft(input: {
  readonly documentPath: string;
  readonly draftDirectory: string;
  readonly draftPath: string;
  readonly expectedDraftSha256: string;
}, operations: MarkdownStoreOperations = {}): Promise<DiscardMarkdownDraftResult> {
  const draftDirectory = validatedDraftDirectory(input.draftDirectory);
  const identity = await recoverableMarkdownIdentity(input.documentPath);
  const draftPath = assertOwnedDraftPath(
    input.draftPath,
    draftDirectory,
    identity.identityPath,
  );
  validSha256(input.expectedDraftSha256, 'Markdown 草稿版本');
  let currentDraftSha256: string;
  try {
    currentDraftSha256 = await sha256File(draftPath);
  } catch (error) {
    if (isMissing(error)) return { status: 'missing', draftPath };
    throw error;
  }
  if (currentDraftSha256 !== input.expectedDraftSha256) {
    return { status: 'conflict', draftPath, currentDraftSha256 };
  }
  // Generation paths are immutable: MerMarkd never replaces a path after it
  // becomes visible. Exact-path removal therefore cannot delete a newer branch.
  await removeDraftPath(draftPath, operations);
  return { status: 'discarded', draftPath };
}

async function writeImmutableDraft(
  draftPath: string,
  payloadBytes: Buffer,
  operations: MarkdownStoreOperations,
): Promise<boolean> {
  let temporaryPath: string | null = draftPath + '.' + randomUUID() + '.tmp';
  let primaryError: unknown;
  let published = false;
  let temporaryRetained = false;
  try {
    const file = await open(temporaryPath, 'wx', 0o600);
    try {
      await file.writeFile(payloadBytes);
      await file.sync();
    } finally {
      await file.close();
    }
    // Hard-link publication is exclusive: an existing generation is never
    // replaced, even if a UUID collision or external file appears.
    await (operations.publishDraft ?? link)(temporaryPath, draftPath);
    published = true;
    const persisted = await readFile(draftPath);
    if (sha256(persisted) !== sha256(payloadBytes)) {
      throw new Error('Markdown 恢复草稿写入后校验失败。');
    }
    await operations.afterDraftPersisted?.(draftPath);
    try {
      await (operations.removeTemporaryFile ?? rm)(temporaryPath);
    } catch {
      temporaryRetained = true;
    }
    temporaryPath = null;
  } catch (error) {
    primaryError = error;
  } finally {
    if (temporaryPath !== null) {
      try {
        await (operations.removeTemporaryFile ?? rm)(temporaryPath, { force: true });
      } catch (cleanupError) {
        if (published) {
          temporaryRetained = true;
        } else if (primaryError === undefined) {
          primaryError = cleanupError;
        }
      }
    }
  }
  if (primaryError !== undefined) throw primaryError;
  return temporaryRetained;
}

export async function saveMarkdownDraft(
  input: SaveMarkdownDraftInput,
  operations: MarkdownStoreOperations = {},
): Promise<MarkdownDraft> {
  const draftDirectory = validatedDraftDirectory(input.draftDirectory);
  validSha256(input.expectedSourceSha256, 'Markdown 草稿原文基线');
  const identity = await recoverableMarkdownIdentity(input.documentPath);
  const candidateBytes = encodeMarkdownBytes(input.content, input.bomByteLength);
  if (candidateBytes.byteLength > maxMarkdownDraftSourceBytes) {
    throw new Error('Markdown 恢复草稿超过 32 MiB 上限，未写入任何文件。');
  }
  const candidateSha256 = sha256(candidateBytes);
  const now = new Date().toISOString();
  const payload: PersistedMarkdownDraft = {
    schemaVersion: 1,
    kind: 'markdown',
    documentIdentityPath: identity.identityPath,
    documentPath: identity.documentPath,
    expectedSourceSha256: input.expectedSourceSha256,
    candidateSha256,
    bomByteLength: input.bomByteLength,
    content: input.content,
    createdAt: now,
    updatedAt: now,
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload, null, 2) + '\n', 'utf8');
  if (payloadBytes.byteLength > maxMarkdownDraftBytes) {
    throw new Error('Markdown 恢复草稿超过大小上限，未写入任何文件。');
  }

  await mkdir(draftDirectory, { recursive: true });
  const draftPath = newDraftPath(identity.identityPath, draftDirectory);
  const temporaryRetained = await writeImmutableDraft(draftPath, payloadBytes, operations);

  let supersededDraftRetained = false;
  const cleanupWarnings: MarkdownCleanupWarning[] =
    temporaryRetained ? ['temporary-file-retained'] : [];
  if (input.previousDraft !== undefined && input.previousDraft.draftPath !== draftPath) {
    try {
      const discarded = await discardMarkdownDraft({
        documentPath: identity.identityPath,
        draftDirectory,
        draftPath: input.previousDraft.draftPath,
        expectedDraftSha256: input.previousDraft.draftSha256,
      }, operations);
      supersededDraftRetained = discarded.status === 'conflict';
    } catch {
      supersededDraftRetained = true;
    }
    if (supersededDraftRetained) {
      cleanupWarnings.push('superseded-draft-retained');
    }
  }

  const source = await readSourceState(identity.documentPath);
  return materializeDraft(
    draftPath,
    payloadBytes,
    payload,
    source,
    supersededDraftRetained,
    cleanupWarnings,
  );
}

function documentLockPath(documentPath: string): string {
  return documentPath + '.mermarkd-save.lock';
}

function parsePersistedLock(
  bytes: Uint8Array,
  expectedDocumentPath: string,
): PersistedMarkdownSaveLock {
  const value: unknown = JSON.parse(decodeDraftText(bytes));
  if (
    typeof value !== 'object' || value === null ||
    !('schemaVersion' in value) || value.schemaVersion !== lockSchemaVersion ||
    !('kind' in value) || value.kind !== 'markdown-save-lock' ||
    !('documentPath' in value) || typeof value.documentPath !== 'string' ||
    !samePath(value.documentPath, expectedDocumentPath) ||
    !('ownerToken' in value) || typeof value.ownerToken !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.ownerToken) ||
    !('pid' in value) || typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
    !('createdAt' in value) || typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error('Markdown 保存锁格式无效。');
  }
  return value as PersistedMarkdownSaveLock;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export async function inspectMarkdownSaveLock(
  documentPathInput: string,
): Promise<InspectMarkdownSaveLockResult> {
  const identity = await recoverableMarkdownIdentity(documentPathInput);
  const documentPath = identity.documentPath;
  const lockPath = documentLockPath(documentPath);
  let bytes: Buffer;
  try {
    const fileStat = await stat(lockPath);
    if (!fileStat.isFile()) {
      return { status: 'unreadable', lockPath, lockSha256: null };
    }
    if (fileStat.size > maxMarkdownLockBytes) {
      return {
        status: 'unreadable',
        lockPath,
        lockSha256: await sha256File(lockPath),
      };
    }
    bytes = await readFile(lockPath);
  } catch (error) {
    if (isMissing(error)) return { status: 'missing', lockPath };
    return { status: 'unreadable', lockPath, lockSha256: null };
  }
  const lockSha256 = sha256(bytes);
  try {
    const persisted = parsePersistedLock(bytes, documentPath);
    return {
      status: 'locked',
      lockPath,
      lockSha256,
      ownerToken: persisted.ownerToken,
      pid: persisted.pid,
      createdAt: persisted.createdAt,
      processAlive: processIsAlive(persisted.pid),
    };
  } catch {
    return { status: 'unreadable', lockPath, lockSha256 };
  }
}

export async function discardMarkdownSaveLock(input: {
  readonly documentPath: string;
  readonly expectedLockSha256: string;
  /** Malformed locks remain untouched unless the caller explicitly opts in. */
  readonly allowUnreadable?: boolean;
}): Promise<DiscardMarkdownSaveLockResult> {
  const identity = await recoverableMarkdownIdentity(input.documentPath);
  const documentPath = identity.documentPath;
  validSha256(input.expectedLockSha256, 'Markdown 保存锁版本');
  const lockPath = documentLockPath(documentPath);
  let currentLockSha256: string;
  let fileSize: number;
  try {
    const fileStat = await stat(lockPath);
    if (!fileStat.isFile()) {
      return { status: 'unreadable', lockPath, lockSha256: input.expectedLockSha256 };
    }
    fileSize = fileStat.size;
    currentLockSha256 = await sha256File(lockPath);
  } catch (error) {
    if (isMissing(error)) return { status: 'missing', lockPath };
    throw error;
  }
  if (currentLockSha256 !== input.expectedLockSha256) {
    return { status: 'conflict', lockPath, currentLockSha256 };
  }
  if (fileSize > maxMarkdownLockBytes) {
    if (input.allowUnreadable !== true) {
      return { status: 'unreadable', lockPath, lockSha256: currentLockSha256 };
    }
    await rm(lockPath);
    return { status: 'discarded', lockPath };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(lockPath);
  } catch (error) {
    if (isMissing(error)) return { status: 'missing', lockPath };
    throw error;
  }
  if (sha256(bytes) !== currentLockSha256) {
    return { status: 'conflict', lockPath, currentLockSha256: sha256(bytes) };
  }
  let persisted: PersistedMarkdownSaveLock;
  try {
    persisted = parsePersistedLock(bytes, documentPath);
  } catch {
    if (input.allowUnreadable !== true) {
      return { status: 'unreadable', lockPath, lockSha256: currentLockSha256 };
    }
    await rm(lockPath);
    return { status: 'discarded', lockPath };
  }
  if (processIsAlive(persisted.pid)) {
    return { status: 'active', lockPath, pid: persisted.pid };
  }
  await rm(lockPath);
  return { status: 'discarded', lockPath };
}

function sourceBackupPrefix(documentPath: string): string {
  return '.' + path.basename(documentPath) + '.';
}

function newSourceBackupPath(documentPath: string): string {
  return path.join(
    path.dirname(documentPath),
    sourceBackupPrefix(documentPath) + randomUUID() + '.mermarkd-backup',
  );
}

function assertOwnedSourceBackupPath(
  documentPath: string,
  backupPathInput: string,
): string {
  if (!path.isAbsolute(backupPathInput)) {
    throw new Error('Markdown 源文件备份路径无效。');
  }
  const backupPath = path.normalize(path.resolve(backupPathInput));
  const filename = path.basename(backupPath);
  const suffix = '.mermarkd-backup';
  const token = filename.slice(sourceBackupPrefix(documentPath).length, -suffix.length);
  if (
    !samePath(path.dirname(backupPath), path.dirname(documentPath)) ||
    !filename.startsWith(sourceBackupPrefix(documentPath)) ||
    !filename.endsWith(suffix) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(token)
  ) {
    throw new Error('Markdown 源文件备份不属于当前文档。');
  }
  return backupPath;
}

export async function listMarkdownSourceBackups(
  documentPathInput: string,
): Promise<MarkdownSourceBackupInventory> {
  const identity = await recoverableMarkdownIdentity(documentPathInput);
  const documentPath = identity.documentPath;
  const entries = await draftDirectoryEntries(path.dirname(documentPath));
  const backups: MarkdownSourceBackup[] = [];
  const unreadableBackups: UnreadableMarkdownSourceBackup[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const backupPath = path.join(path.dirname(documentPath), entry.name);
    try {
      assertOwnedSourceBackupPath(documentPath, backupPath);
    } catch {
      continue;
    }
    try {
      backups.push({
        documentPath,
        backupPath,
        backupSha256: await sha256File(backupPath),
      });
    } catch {
      unreadableBackups.push({
        documentPath,
        backupPath,
        reason: 'unreadable',
      });
    }
  }
  backups.sort((left, right) => right.backupPath.localeCompare(left.backupPath));
  unreadableBackups.sort((left, right) => right.backupPath.localeCompare(left.backupPath));
  return { backups, unreadableBackups };
}

export async function recoverMarkdownSourceBackup(input: {
  readonly documentPath: string;
  readonly backupPath: string;
  readonly expectedBackupSha256: string;
}): Promise<RecoverMarkdownSourceBackupResult> {
  const identity = await recoverableMarkdownIdentity(input.documentPath);
  const documentPath = identity.documentPath;
  const backupPath = assertOwnedSourceBackupPath(documentPath, input.backupPath);
  validSha256(input.expectedBackupSha256, 'Markdown 源文件备份版本');
  if ((await inspectMarkdownSaveLock(documentPath)).status !== 'missing') {
    return { status: 'locked', documentPath };
  }
  let currentBackupSha256: string;
  try {
    currentBackupSha256 = await sha256File(backupPath);
  } catch (error) {
    if (isMissing(error)) return { status: 'missing', documentPath };
    throw error;
  }
  if (currentBackupSha256 !== input.expectedBackupSha256) {
    return { status: 'conflict', documentPath, currentBackupSha256 };
  }
  const currentSource = await readSourceState(documentPath);
  if (currentSource.status === 'available') return { status: 'source-exists', documentPath };
  if (currentSource.status === 'unreadable') {
    return { status: 'source-unreadable', documentPath };
  }
  try {
    await link(backupPath, documentPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { status: 'source-exists', documentPath };
    }
    throw error;
  }
  const restored = await readSourceState(documentPath);
  if (restored.status !== 'available' || restored.sha256 !== currentBackupSha256) {
    return { status: 'source-unreadable', documentPath };
  }
  let backupRetained = false;
  try {
    await rm(backupPath);
  } catch {
    backupRetained = true;
  }
  return {
    status: 'restored',
    documentPath,
    sourceSha256: restored.sha256,
    backupRetained,
  };
}

export async function discardMarkdownSourceBackup(input: {
  readonly documentPath: string;
  readonly backupPath: string;
  readonly expectedBackupSha256: string;
}): Promise<DiscardMarkdownSourceBackupResult> {
  const identity = await recoverableMarkdownIdentity(input.documentPath);
  const documentPath = identity.documentPath;
  const backupPath = assertOwnedSourceBackupPath(documentPath, input.backupPath);
  validSha256(input.expectedBackupSha256, 'Markdown 源文件备份版本');
  if ((await inspectMarkdownSaveLock(documentPath)).status !== 'missing') {
    return { status: 'locked', backupPath };
  }
  let currentBackupSha256: string;
  try {
    currentBackupSha256 = await sha256File(backupPath);
  } catch (error) {
    if (isMissing(error)) return { status: 'missing', backupPath };
    throw error;
  }
  if (currentBackupSha256 !== input.expectedBackupSha256) {
    return { status: 'conflict', backupPath, currentBackupSha256 };
  }
  await rm(backupPath);
  return { status: 'discarded', backupPath };
}

function pendingResult(
  draft: MarkdownDraft,
  reason: Extract<SaveMarkdownFileResult, { status: 'pending-draft' }>['reason'],
  currentSourceSha256: string | null,
  extraWarnings: readonly MarkdownCleanupWarning[] = [],
): SaveMarkdownFileResult {
  return {
    status: 'pending-draft',
    reason,
    documentPath: draft.documentPath,
    draftPath: draft.draftPath,
    draftSha256: draft.draftSha256,
    candidateSha256: draft.candidateSha256,
    currentSourceSha256,
    cleanupWarnings: [...draft.cleanupWarnings, ...extraWarnings],
  };
}

function conflictResult(
  draft: MarkdownDraft,
  reason: Extract<SaveMarkdownFileResult, { status: 'conflict' }>['reason'],
  currentSourceSha256: string,
): SaveMarkdownFileResult {
  return {
    status: 'conflict',
    reason,
    documentPath: draft.documentPath,
    draftPath: draft.draftPath,
    draftSha256: draft.draftSha256,
    candidateSha256: draft.candidateSha256,
    currentSourceSha256,
    cleanupWarnings: draft.cleanupWarnings,
  };
}

async function cleanupSavedDraft(
  draft: MarkdownDraft,
  draftDirectory: string,
  operations: MarkdownStoreOperations,
): Promise<{
  readonly retained: boolean;
  readonly warnings: readonly MarkdownCleanupWarning[];
}> {
  try {
    const discarded = await discardMarkdownDraft({
      documentPath: draft.documentPath,
      draftDirectory,
      draftPath: draft.draftPath,
      expectedDraftSha256: draft.draftSha256,
    }, operations);
    if (discarded.status === 'discarded' || discarded.status === 'missing') {
      return { retained: false, warnings: [] };
    }
  } catch {
    // The source save is already committed. Surface cleanup separately.
  }
  return { retained: true, warnings: ['saved-draft-retained'] };
}

async function cleanupOwnedLock(
  lockPath: string,
  expectedLockSha256: string,
  operations: MarkdownStoreOperations,
): Promise<boolean> {
  try {
    const bytes = await readFile(lockPath);
    if (sha256(bytes) !== expectedLockSha256) return false;
    await (operations.removeDocumentLock ?? rm)(lockPath);
    return true;
  } catch (error) {
    return isMissing(error);
  }
}

export async function saveMarkdownFile(
  input: SaveMarkdownFileInput,
  operations: MarkdownStoreOperations = {},
): Promise<SaveMarkdownFileResult> {
  const draftDirectory = validatedDraftDirectory(input.draftDirectory);
  validSha256(input.expectedSourceSha256, 'Markdown 保存基线');

  // The exact candidate is made durable before any source-dependent gate.
  const draft = await saveMarkdownDraft(input, operations);
  const candidateBytes = encodeMarkdownBytes(input.content, input.bomByteLength);
  let source = await readSourceState(draft.documentPath);
  if (source.status === 'missing') {
    return pendingResult(draft, 'source-missing', null);
  }
  if (source.status === 'unreadable') {
    return pendingResult(draft, 'source-unreadable', null);
  }
  if (source.sha256 !== input.expectedSourceSha256) {
    return conflictResult(draft, 'source-changed', source.sha256);
  }

  let decodedSource: ReturnType<typeof decodeMarkdownBytes>;
  try {
    decodedSource = decodeMarkdownBytes(source.bytes);
  } catch {
    return pendingResult(draft, 'unsupported-format', source.sha256);
  }
  if (decodedSource.format.bomByteLength !== input.bomByteLength) {
    return pendingResult(draft, 'unsupported-format', source.sha256);
  }

  if (draft.candidateSha256 === source.sha256) {
    // Re-read before reporting a no-op so an edit observed after the first read
    // becomes a conflict and the candidate generation remains recoverable.
    source = await readSourceState(draft.documentPath);
    if (source.status === 'missing') return pendingResult(draft, 'source-missing', null);
    if (source.status === 'unreadable') return pendingResult(draft, 'source-unreadable', null);
    if (source.sha256 !== input.expectedSourceSha256) {
      return conflictResult(draft, 'source-changed', source.sha256);
    }
    const cleanup = await cleanupSavedDraft(draft, draftDirectory, operations);
    return {
      status: 'saved',
      changed: false,
      documentPath: draft.documentPath,
      draftPath: draft.draftPath,
      draftSha256: draft.draftSha256,
      candidateSha256: draft.candidateSha256,
      sourceSha256: source.sha256,
      draftRetained: cleanup.retained,
      sourceBackup: null,
      cleanupWarnings: [...draft.cleanupWarnings, ...cleanup.warnings],
    };
  }

  if (decodedSource.format.lineEnding === 'mixed') {
    return pendingResult(draft, 'unsupported-format', source.sha256);
  }
  try {
    const candidateFormat = inspectMarkdownSourceFormat(input.content, input.bomByteLength);
    assertMarkdownLineEndingsPreserved(decodedSource.format, candidateFormat);
  } catch {
    return pendingResult(draft, 'unsupported-format', source.sha256);
  }
  try {
    // Markdown is permissive, but this proves that section derivation can
    // consume the exact candidate before any source mutation.
    extractSections(input.content);
  } catch {
    return pendingResult(draft, 'parse-error', source.sha256);
  }

  const lockPath = documentLockPath(draft.documentPath);
  const ownerToken = randomUUID();
  const lockPayload: PersistedMarkdownSaveLock = {
    schemaVersion: 1,
    kind: 'markdown-save-lock',
    documentPath: draft.documentPath,
    ownerToken,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  const lockBytes = Buffer.from(JSON.stringify(lockPayload) + '\n', 'utf8');
  const lockSha256 = sha256(lockBytes);
  let lockFile: Awaited<ReturnType<typeof open>> | null = null;
  const lockCleanupWarnings: MarkdownCleanupWarning[] = [];
  try {
    lockFile = await open(lockPath, 'wx', 0o600);
    await lockFile.writeFile(lockBytes);
    await lockFile.sync();
    await lockFile.close();
    lockFile = null;
  } catch (error) {
    if (lockFile !== null) {
      await lockFile.close().catch(() => undefined);
      lockFile = null;
      // The successful wx open proves this path is ours even if writing or
      // syncing the lock payload failed before its SHA became verifiable.
      try {
        await (operations.removeDocumentLock ?? rm)(lockPath, { force: true });
      } catch {
        lockCleanupWarnings.push('document-lock-retained');
      }
    }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return {
        ...conflictResult(draft, 'busy', source.sha256),
        cleanupWarnings: [...draft.cleanupWarnings, ...lockCleanupWarnings],
      };
    }
    return pendingResult(
      draft,
      isReadOnlyError(error) ? 'read-only' : 'write-error',
      source.sha256,
      lockCleanupWarnings,
    );
  }

  let temporaryPath: string | null = null;
  let backupPath: string | null = null;
  let result: SaveMarkdownFileResult;
  let sourceCommitted = false;
  const cleanupWarnings: MarkdownCleanupWarning[] = [];
  try {
    result = await (async (): Promise<SaveMarkdownFileResult> => {
      source = await readSourceState(draft.documentPath);
      if (source.status === 'missing') return pendingResult(draft, 'source-missing', null);
      if (source.status === 'unreadable') return pendingResult(draft, 'source-unreadable', null);
      if (source.sha256 !== input.expectedSourceSha256) {
        return conflictResult(draft, 'source-changed', source.sha256);
      }

      temporaryPath = path.join(
        path.dirname(draft.documentPath),
        '.' + path.basename(draft.documentPath) + '.' + randomUUID() + '.tmp',
      );
      const documentMode = (await stat(draft.documentPath)).mode & 0o777;
      const temporary = await open(temporaryPath, 'wx', documentMode || 0o600);
      try {
        await temporary.writeFile(candidateBytes);
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      await operations.afterTemporaryFileSync?.(temporaryPath, draft.documentPath);

      source = await readSourceState(draft.documentPath);
      if (source.status === 'missing') return pendingResult(draft, 'source-missing', null);
      if (source.status === 'unreadable') return pendingResult(draft, 'source-unreadable', null);
      if (source.sha256 !== input.expectedSourceSha256) {
        return conflictResult(draft, 'source-changed', source.sha256);
      }

      // Move the verified baseline out of the destination before publishing.
      // The candidate is then linked into an absent path with O_EXCL
      // semantics, so an external recreation is never overwritten.
      backupPath = newSourceBackupPath(draft.documentPath);
      await (operations.moveDocumentToBackup ?? rename)(draft.documentPath, backupPath);
      await operations.afterSourceMovedToBackup?.(backupPath, draft.documentPath);

      const movedSource = await readSourceState(backupPath);
      if (
        movedSource.status !== 'available' ||
        movedSource.sha256 !== input.expectedSourceSha256
      ) {
        // Put the version that was actually moved back only if no external
        // writer has recreated the destination.
        try {
          await link(backupPath, draft.documentPath);
          const restored = await readSourceState(draft.documentPath);
          if (
            restored.status === 'available' &&
            movedSource.status === 'available' &&
            restored.sha256 === movedSource.sha256
          ) {
            await (operations.removeSourceBackup ?? rm)(backupPath);
            backupPath = null;
          }
        } catch {
          // The exact backup remains available through the recovery API.
        }
        if (movedSource.status === 'available') {
          return conflictResult(draft, 'source-changed', movedSource.sha256);
        }
        return pendingResult(draft, 'verify-error', null);
      }

      try {
        await (operations.publishDocument ?? link)(temporaryPath, draft.documentPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          const external = await readSourceState(draft.documentPath);
          if (external.status === 'available') {
            return conflictResult(draft, 'source-changed', external.sha256);
          }
          if (external.status === 'unreadable') {
            return pendingResult(draft, 'source-unreadable', null);
          }
          return pendingResult(draft, 'source-missing', null);
        }
        const destination = await readSourceState(draft.documentPath);
        if (destination.status === 'missing') {
          try {
            // Restore the moved baseline through an exclusive link. A writer
            // that recreated the path wins; it is never replaced here.
            await link(backupPath, draft.documentPath);
            const restored = await readSourceState(draft.documentPath);
            if (
              restored.status === 'available' &&
              restored.sha256 === input.expectedSourceSha256
            ) {
              await (operations.removeSourceBackup ?? rm)(backupPath);
              backupPath = null;
            }
          } catch {
            // If restoration cannot complete, the exact backup remains listed
            // for explicit recovery.
          }
        }
        throw error;
      }

      try {
        await (operations.removeTemporaryFile ?? rm)(temporaryPath);
        temporaryPath = null;
      } catch {
        cleanupWarnings.push('temporary-file-retained');
      }
      source = await readSourceState(draft.documentPath);
      if (source.status !== 'available' || source.sha256 !== draft.candidateSha256) {
        return pendingResult(
          draft,
          'verify-error',
          source.status === 'available' ? source.sha256 : null,
        );
      }

      // A writer that held the old inode can still modify the moved backup on
      // platforms with POSIX unlink semantics. Never discard that evidence.
      const verifiedBackup = await readSourceState(backupPath);
      if (
        verifiedBackup.status !== 'available' ||
        verifiedBackup.sha256 !== input.expectedSourceSha256
      ) {
        cleanupWarnings.push('source-backup-retained');
        return pendingResult(draft, 'verify-error', source.sha256);
      }
      const draftCleanup = await cleanupSavedDraft(draft, draftDirectory, operations);
      sourceCommitted = true;
      return {
        status: 'saved',
        changed: true,
        documentPath: draft.documentPath,
        draftPath: draft.draftPath,
        draftSha256: draft.draftSha256,
        candidateSha256: draft.candidateSha256,
        sourceSha256: source.sha256,
        draftRetained: draftCleanup.retained,
        sourceBackup: {
          documentPath: draft.documentPath,
          backupPath,
          backupSha256: verifiedBackup.sha256,
        },
        cleanupWarnings: [...draft.cleanupWarnings, ...draftCleanup.warnings],
      };
    })();
  } catch (error) {
    const current = await readSourceState(draft.documentPath);
    if (current.status === 'missing') {
      result = pendingResult(draft, 'source-missing', null);
    } else if (current.status === 'unreadable') {
      result = pendingResult(draft, 'source-unreadable', null);
    } else if (current.sha256 !== input.expectedSourceSha256) {
      result = conflictResult(draft, 'source-changed', current.sha256);
    } else {
      result = pendingResult(
        draft,
        isReadOnlyError(error) ? 'read-only' : 'write-error',
        current.sha256,
      );
    }
  } finally {
    if (temporaryPath !== null) {
      try {
        await (operations.removeTemporaryFile ?? rm)(temporaryPath, { force: true });
      } catch {
        cleanupWarnings.push('temporary-file-retained');
      }
    }
    if (
      backupPath !== null &&
      !sourceCommitted &&
      !cleanupWarnings.includes('source-backup-retained')
    ) {
      cleanupWarnings.push('source-backup-retained');
    }
    if (!await cleanupOwnedLock(lockPath, lockSha256, operations)) {
      cleanupWarnings.push('document-lock-retained');
    }
  }

  if (cleanupWarnings.length === 0) return result;
  return {
    ...result,
    cleanupWarnings: [...result.cleanupWarnings, ...cleanupWarnings],
  };
}
