import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { MAX_ANNOTATION_YAML_BYTES, parseAnnotationYaml } from '../core/annotations.ts';

const draftSchemaVersion = 1;
const maxSidecarBytes = MAX_ANNOTATION_YAML_BYTES;
// JSON escapes may expand a control character from one UTF-8 byte to six ASCII bytes.
const maxDraftBytes = maxSidecarBytes * 6 + 16 * 1024;

export interface PendingAnnotationDraft {
  path: string;
  text: string;
  expectedSourceSha256: string;
  expectedSidecarSha256: string | null;
  /** Present when a reviewed relocation migrates a sidecar from an older source hash. */
  expectedExistingSourceSha256?: string;
  createdAt: string;
}

export interface LoadedAnnotationFile {
  documentPath: string;
  sidecarPath: string;
  sourceSha256: string;
  sidecarText: string | null;
  sidecarSha256: string | null;
  pendingDrafts: PendingAnnotationDraft[];
  unreadableDraftPaths: string[];
}

export interface SaveAnnotationFileInput {
  documentPath: string;
  draftDirectory: string;
  expectedSourceSha256: string;
  expectedSidecarSha256: string | null;
  /** Explicitly authorizes replacing a sidecar bound to this older source hash. */
  expectedExistingSourceSha256?: string;
  text: string;
}

export type SaveAnnotationFileResult =
  | { status: 'saved'; sidecarPath: string; sourceSha256: string; sidecarSha256: string }
  | {
      status: 'conflict';
      reason: 'source-changed' | 'sidecar-changed' | 'sidecar-invalid' | 'sidecar-source-mismatch' | 'busy';
      draftPath: string;
      sourceSha256: string;
      sidecarSha256: string | null;
    }
  | {
      status: 'pending-draft';
      reason: 'read-only' | 'write-error';
      draftPath: string;
      sourceSha256: string;
      sidecarSha256: string | null;
    };

/** Narrow fault injection for file-system failure tests; production uses fs.rename. */
export interface AnnotationStoreOperations {
  replaceSidecar?: typeof rename;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validSha256(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label}无效，未写入任何文件。`);
  return value;
}

function decodeUtf8(bytes: Uint8Array, description: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${description} 不是有效的 UTF-8 文件，未修改任何文件。`);
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isReadOnlyError(error: unknown): boolean {
  return ['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '');
}

function existingSidecarIssue(
  text: string | null,
  expectedSourceSha256: string,
): 'sidecar-invalid' | 'sidecar-source-mismatch' | null {
  if (text === null) return null;
  try {
    return parseAnnotationYaml(text).source.sha256 === expectedSourceSha256
      ? null : 'sidecar-source-mismatch';
  } catch {
    return 'sidecar-invalid';
  }
}

async function readSidecar(sidecarPath: string): Promise<{ text: string | null; sha256: string | null }> {
  let bytes: Buffer;
  try {
    if ((await stat(sidecarPath)).size > maxSidecarBytes) {
      throw new Error('批注文件超过 1 MiB 上限，已按只读处理。');
    }
    bytes = await readFile(sidecarPath);
  } catch (error) {
    if (isMissing(error)) return { text: null, sha256: null };
    throw error;
  }
  if (bytes.byteLength > maxSidecarBytes) {
    throw new Error('批注文件超过 1 MiB 上限，已按只读处理。');
  }
  return { text: decodeUtf8(bytes, '批注文件'), sha256: sha256(bytes) };
}

async function readSourceSha256(documentPath: string): Promise<string> {
  return sha256(await readFile(documentPath));
}

async function canonicalDocumentPath(documentPath: string): Promise<string> {
  if (!path.isAbsolute(documentPath) || path.extname(documentPath).toLowerCase() !== '.md') {
    throw new Error('批注只能保存到已打开的本地 .md 文档。');
  }
  const canonicalPath = await realpath(documentPath);
  if (path.extname(canonicalPath).toLowerCase() !== '.md') {
    throw new Error('批注只能保存到已打开的本地 .md 文档。');
  }
  return canonicalPath;
}

function draftPrefix(documentPath: string): string {
  return `${sha256(Buffer.from(documentPath, 'utf8'))}.annotations.pending.`;
}

async function readPendingDrafts(documentPath: string, draftDirectory: string): Promise<{
  drafts: PendingAnnotationDraft[];
  unreadablePaths: string[];
}> {
  let names: string[];
  try {
    names = await readdir(draftDirectory);
  } catch (error) {
    if (isMissing(error)) return { drafts: [], unreadablePaths: [] };
    throw error;
  }

  const prefix = draftPrefix(documentPath);
  const drafts: PendingAnnotationDraft[] = [];
  const unreadablePaths: string[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const draftPath = path.join(draftDirectory, name);
    try {
      if ((await stat(draftPath)).size > maxDraftBytes) throw new Error('草稿过大');
      const bytes = await readFile(draftPath);
      if (bytes.byteLength > maxDraftBytes) throw new Error('草稿过大');
      const data: unknown = JSON.parse(decodeUtf8(bytes, '批注恢复草稿'));
      if (
        typeof data !== 'object' || data === null ||
        !('schemaVersion' in data) || data.schemaVersion !== draftSchemaVersion ||
        !('documentPath' in data) || data.documentPath !== documentPath ||
        !('text' in data) || typeof data.text !== 'string' ||
        Buffer.byteLength(data.text, 'utf8') > maxSidecarBytes ||
        !('expectedSourceSha256' in data) || typeof data.expectedSourceSha256 !== 'string' ||
        !('expectedSidecarSha256' in data) ||
        (data.expectedSidecarSha256 !== null && typeof data.expectedSidecarSha256 !== 'string') ||
        ('expectedExistingSourceSha256' in data &&
          typeof data.expectedExistingSourceSha256 !== 'string') ||
        !('createdAt' in data) || typeof data.createdAt !== 'string'
      ) {
        throw new Error('草稿格式无效');
      }
      drafts.push({
        path: draftPath,
        text: data.text,
        expectedSourceSha256: data.expectedSourceSha256,
        expectedSidecarSha256: data.expectedSidecarSha256,
        ...('expectedExistingSourceSha256' in data
          ? { expectedExistingSourceSha256: data.expectedExistingSourceSha256 as string }
          : {}),
        createdAt: data.createdAt,
      });
    } catch {
      // Preserve malformed drafts for manual recovery while keeping the valid sidecar readable.
      unreadablePaths.push(draftPath);
    }
  }
  return {
    drafts: drafts.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.path.localeCompare(b.path)),
    unreadablePaths,
  };
}

async function savePendingDraft(input: SaveAnnotationFileInput, documentPath: string): Promise<string> {
  await mkdir(input.draftDirectory, { recursive: true });
  const filename = `${draftPrefix(documentPath)}${Date.now()}-${randomUUID()}.json`;
  const draftPath = path.join(input.draftDirectory, filename);
  const temporaryPath = `${draftPath}.tmp`;
  const payload = JSON.stringify({
    schemaVersion: draftSchemaVersion,
    documentPath,
    expectedSourceSha256: input.expectedSourceSha256,
    expectedSidecarSha256: input.expectedSidecarSha256,
    ...(input.expectedExistingSourceSha256
      ? { expectedExistingSourceSha256: input.expectedExistingSourceSha256 }
      : {}),
    text: input.text,
    createdAt: new Date().toISOString(),
  }, null, 2);
  if (Buffer.byteLength(payload, 'utf8') > maxDraftBytes) {
    throw new Error('批注恢复草稿超过大小上限，未写入任何文件。');
  }
  try {
    const file = await open(temporaryPath, 'wx', 0o600);
    try {
      await file.writeFile(payload, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, draftPath);
    return draftPath;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function loadAnnotationFile(documentPath: string, draftDirectory: string): Promise<LoadedAnnotationFile> {
  const canonicalPath = await canonicalDocumentPath(documentPath);
  const sidecarPath = `${canonicalPath}.annotations.yaml`;
  const [sourceSha256, sidecar, pending] = await Promise.all([
    readSourceSha256(canonicalPath),
    readSidecar(sidecarPath),
    readPendingDrafts(canonicalPath, draftDirectory),
  ]);
  return {
    documentPath: canonicalPath,
    sidecarPath,
    sourceSha256,
    sidecarText: sidecar.text,
    sidecarSha256: sidecar.sha256,
    pendingDrafts: pending.drafts,
    unreadableDraftPaths: pending.unreadablePaths,
  };
}

export async function saveAnnotationFile(
  input: SaveAnnotationFileInput,
  operations: AnnotationStoreOperations = {},
): Promise<SaveAnnotationFileResult> {
  if (Buffer.byteLength(input.text, 'utf8') > maxSidecarBytes) {
    throw new Error('批注文件超过 1 MiB 上限，未写入任何文件。');
  }
  const candidate = parseAnnotationYaml(input.text);
  if (candidate.source.sha256 !== input.expectedSourceSha256) {
    throw new Error('批注 YAML 的原文摘要与保存基线不一致，未写入任何文件。');
  }
  validSha256(input.expectedSourceSha256, '原文保存基线');
  const expectedExistingSourceSha256 = validSha256(
    input.expectedExistingSourceSha256 ?? input.expectedSourceSha256,
    '现有批注原文基线',
  );
  if (input.expectedExistingSourceSha256 && input.expectedSidecarSha256 === null) {
    throw new Error('重定位保存缺少现有批注文件基线，未写入任何文件。');
  }
  const documentPath = await canonicalDocumentPath(input.documentPath);
  const sidecarPath = `${documentPath}.annotations.yaml`;
  const lockPath = `${sidecarPath}.lock`;
  let sourceSha256 = await readSourceSha256(documentPath);
  let sidecar = await readSidecar(sidecarPath);

  const conflict = async (reason: Extract<SaveAnnotationFileResult, { status: 'conflict' }>['reason']):
    Promise<Extract<SaveAnnotationFileResult, { status: 'conflict' }>> => ({
    status: 'conflict',
    reason,
    draftPath: await savePendingDraft(input, documentPath),
    sourceSha256,
    sidecarSha256: sidecar.sha256,
  });
  const pending = async (error: unknown):
    Promise<Extract<SaveAnnotationFileResult, { status: 'pending-draft' }>> => ({
    status: 'pending-draft',
    reason: isReadOnlyError(error) ? 'read-only' : 'write-error',
    draftPath: await savePendingDraft(input, documentPath),
    sourceSha256,
    sidecarSha256: sidecar.sha256,
  });

  if (sourceSha256 !== input.expectedSourceSha256) return conflict('source-changed');
  if (sidecar.sha256 !== input.expectedSidecarSha256) return conflict('sidecar-changed');
  const initialSidecarIssue = existingSidecarIssue(sidecar.text, expectedExistingSourceSha256);
  if (initialSidecarIssue) return conflict(initialSidecarIssue);

  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return conflict('busy');
    return pending(error);
  }

  let temporaryPath: string | null = null;
  try {
    // Recheck inside the lock: two cooperating windows may have loaded the same baseline.
    sourceSha256 = await readSourceSha256(documentPath);
    sidecar = await readSidecar(sidecarPath);
    if (sourceSha256 !== input.expectedSourceSha256) return conflict('source-changed');
    if (sidecar.sha256 !== input.expectedSidecarSha256) return conflict('sidecar-changed');
    const lockedSidecarIssue = existingSidecarIssue(sidecar.text, expectedExistingSourceSha256);
    if (lockedSidecarIssue) return conflict(lockedSidecarIssue);

    temporaryPath = `${sidecarPath}.${randomUUID()}.tmp`;
    const file = await open(temporaryPath, 'wx', 0o600);
    try {
      await file.writeFile(input.text, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }

    // Catch external changes made while the replacement was being prepared.
    sourceSha256 = await readSourceSha256(documentPath);
    sidecar = await readSidecar(sidecarPath);
    if (sourceSha256 !== input.expectedSourceSha256) return conflict('source-changed');
    if (sidecar.sha256 !== input.expectedSidecarSha256) return conflict('sidecar-changed');
    const finalSidecarIssue = existingSidecarIssue(sidecar.text, expectedExistingSourceSha256);
    if (finalSidecarIssue) return conflict(finalSidecarIssue);

    await (operations.replaceSidecar ?? rename)(temporaryPath, sidecarPath);
    return { status: 'saved', sidecarPath, sourceSha256, sidecarSha256: sha256(Buffer.from(input.text, 'utf8')) };
  } catch (error) {
    return pending(error);
  } finally {
    if (temporaryPath !== null) await rm(temporaryPath, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
