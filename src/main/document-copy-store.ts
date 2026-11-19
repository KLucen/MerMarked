import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';

export const DOCUMENT_COPY_SUFFIXES = ['', '.annotations.yaml', '.mermarkd.json'] as const;
export type DocumentCopySuffix = typeof DOCUMENT_COPY_SUFFIXES[number];
const limits = [32 * 1024 * 1024, 1024 * 1024, 4 * 1024 * 1024] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const activeCopies = new Set<string>();
type Identity = { dev: string; ino: string };
type FileRecord = Identity & { sha256: string; bytes: number };
type ReadFile = FileRecord & { data: Buffer };
type TargetDirectory = Identity & { path: string };
interface JournalBase {
  id: string; ownerPid: number; source: string; target: string;
  stage: Identity & { path: string }; files: (FileRecord | null)[];
}
type Journal = JournalBase & ({ version: 1 } | { version: 2; targetDirectory: TargetDirectory });
type SnapshotValidator = (files: readonly { suffix: DocumentCopySuffix; bytes: Buffer | null }[]) => Promise<void>;
export interface DocumentCopyOptions {
  sourcePath: string; targetPath: string; expectedSourceSha256: string; journalDirectory: string;
  validateSnapshot?: SnapshotValidator;
  /** Explicit portability review of the captured saved bytes, before staging. */
  crossDirectory?: { validateSnapshot: SnapshotValidator };
  beforePublish?: () => Promise<void>;
  afterPublish?: (suffix: DocumentCopySuffix) => Promise<void>;
}
export interface DocumentCopyReceipt {
  operationId: string; targetPath: string; copiedSuffixes: readonly DocumentCopySuffix[];
}
export class DocumentCopyError extends Error {
  readonly code: 'refused' | 'uncertain';
  constructor(code: 'refused' | 'uncertain') {
    super(code === 'uncertain' ? '副本状态需要检查，相关文件已保留。原文件未修改。'
      : '无法安全创建副本，请检查文件名、磁盘权限或文件是否已变化。原文件未修改。');
    this.code = code; this.name = 'DocumentCopyError';
  }
}
/** Fault injection only; a real interruption leaves the same durable state. */
export class CopyInterrupted extends Error {
  constructor() { super('Document copy interrupted for recovery.'); }
}
function fail(): never { throw new DocumentCopyError('refused'); }
function uncertain(): never { throw new DocumentCopyError('uncertain'); }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const identity = (stat: BigIntStats): Identity => ({ dev: String(stat.dev), ino: String(stat.ino) });
const sameIdentity = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a: FileRecord, b: FileRecord) => sameIdentity(a, b) && a.sha256 === b.sha256 && a.bytes === b.bytes;
const stageName = (id: string) => `.mermarkd-copy-${id}`;
const journalPrefix = (source: string) => `copy-${digest(Buffer.from(key(source)))}-`;
const journalName = (source: string, id: string) => `${journalPrefix(source)}${id}.json`;
function validName(name: string): boolean {
  return name.length > 3 && name.length <= 220 && /\.md$/i.test(name) &&
    !/[<>:"/\\|?*\0]/.test(name) && !/[ .]$/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}
async function location(file: string): Promise<string> {
  const absolute = path.resolve(file);
  return path.join(await fs.realpath(path.dirname(absolute)), path.basename(absolute));
}
async function readBounded(file: string, limit: number): Promise<ReadFile | null> {
  let before: BigIntStats;
  try { before = await fs.lstat(file, { bigint: true }); }
  catch (error) { if (missing(error)) return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(limit)) fail();
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(identity(before), identity(opened))) fail();
    const data = await handle.readFile();
    const after = await fs.lstat(file, { bigint: true });
    if (data.length > limit || after.isSymbolicLink() || !after.isFile() || !sameIdentity(identity(opened), identity(after))) fail();
    return { ...identity(opened), sha256: digest(data), bytes: data.length, data };
  } finally { await handle.close(); }
}
async function readSource(source: string): Promise<(ReadFile | null)[]> {
  const files: (ReadFile | null)[] = [];
  for (let i = 0; i < DOCUMENT_COPY_SUFFIXES.length; i++) files.push(await readBounded(source + DOCUMENT_COPY_SUFFIXES[i], limits[i]));
  if (!files[0]) fail();
  return files;
}
async function absent(file: string): Promise<void> {
  try { await fs.lstat(file); } catch (error) { if (missing(error)) return; throw error; }
  fail();
}
async function directoryIdentity(dir: string): Promise<Identity | null> {
  try {
    const stat = await fs.lstat(dir, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) uncertain();
    return identity(stat);
  } catch (error) { if (missing(error)) return null; throw error; }
}
async function checkTargetDirectory(expected: TargetDirectory | undefined): Promise<void> {
  if (!expected) return;
  const canonical = await fs.realpath(expected.path);
  if (key(canonical) !== key(expected.path)) uncertain();
  const current = await directoryIdentity(expected.path);
  if (!current || !sameIdentity(current, expected)) uncertain();
}
const targetDirectoryOf = (journal: Journal) => journal.version === 2 ? journal.targetDirectory : undefined;
async function writeNew(file: string, data: Buffer, created: (id: Identity) => void): Promise<FileRecord> {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    const id = identity(await handle.stat({ bigint: true })); created(id);
    await handle.writeFile(data); await handle.sync();
    return { ...id, sha256: digest(data), bytes: data.length };
  } finally { await handle.close(); }
}
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) uncertain();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== fields.length || fields.some(field => !Object.hasOwn(result, field))) uncertain();
  return result;
}
function validIdentity(value: Record<string, unknown>): boolean {
  return typeof value.dev === 'string' && /^-?\d{1,40}$/.test(value.dev) && typeof value.ino === 'string' && /^\d{1,40}$/.test(value.ino);
}
function ownerBusy(journal: Journal): boolean {
  if (journal.ownerPid === process.pid) return activeCopies.has(journal.id);
  try { process.kill(journal.ownerPid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function validateJournal(value: unknown, source: string, filename: string): Journal {
  const isCrossDirectory = value && typeof value === 'object' && 'version' in value && value.version === 2;
  const fields = ['version', 'id', 'ownerPid', 'source', 'target', 'stage', 'files'];
  const j = object(value, isCrossDirectory ? [...fields, 'targetDirectory'] : fields);
  if ((j.version !== 1 && j.version !== 2) || typeof j.id !== 'string' || !uuid.test(j.id) || typeof j.ownerPid !== 'number' ||
      !Number.isSafeInteger(j.ownerPid) || j.ownerPid <= 0 || j.ownerPid > 0x7fffffff ||
      typeof j.source !== 'string' || key(j.source) !== key(source) || filename !== journalName(source, j.id) ||
      typeof j.target !== 'string' || !path.isAbsolute(j.target) || path.normalize(j.target) !== j.target ||
      !validName(path.basename(j.target)) || key(j.target) === key(source)) uncertain();
  const targetParent = path.dirname(j.target);
  if (j.version === 1) {
    if (j.target !== path.join(path.dirname(source), path.basename(j.target))) uncertain();
  } else {
    const parent = object(j.targetDirectory, ['path', 'dev', 'ino']);
    if (!validIdentity(parent) || parent.path !== targetParent || key(targetParent) === key(path.dirname(source))) uncertain();
  }
  const stage = object(j.stage, ['path', 'dev', 'ino']);
  if (!validIdentity(stage) || stage.path !== path.join(targetParent, stageName(j.id))) uncertain();
  if (!Array.isArray(j.files) || j.files.length !== 3 || j.files[0] === null) uncertain();
  for (let i = 0; i < 3; i++) {
    if (j.files[i] === null) continue;
    const f = object(j.files[i], ['dev', 'ino', 'sha256', 'bytes']);
    if (!validIdentity(f) || typeof f.sha256 !== 'string' || !hashPattern.test(f.sha256) || typeof f.bytes !== 'number' ||
        !Number.isSafeInteger(f.bytes) || f.bytes < 0 || f.bytes > limits[i]) uncertain();
  }
  return j as unknown as Journal;
}
async function removeChecked(file: string, expected: FileRecord, limit: number): Promise<void> {
  const current = await readBounded(file, limit);
  if (!current) return;
  if (!sameFile(current, expected)) uncertain();
  await fs.unlink(file);
}
/** Validate every destination; only private staging and receipts may be removed. */
async function settle(source: string, journalRoot: string, filename: string, allowCompletion = false): Promise<'completed' | 'rolledBack'> {
  try {
    const receiptPath = path.join(journalRoot, filename), receipt = await readBounded(receiptPath, 64 * 1024);
    if (!receipt) uncertain();
    const j = validateJournal(JSON.parse(receipt.data.toString('utf8')), source, filename);
    const targetDirectory = targetDirectoryOf(j);
    await checkTargetDirectory(targetDirectory);
    const stageId = await directoryIdentity(j.stage.path);
    if (stageId && !sameIdentity(stageId, j.stage)) uncertain();
    const staged: (ReadFile | null)[] = [], targets: (ReadFile | null)[] = [];
    if (stageId) {
      const allowed = new Set(j.files.flatMap((f, i) => f ? [String(i)] : []));
      if ((await fs.readdir(j.stage.path)).some(name => !allowed.has(name))) uncertain();
    }
    for (let i = 0; i < 3; i++) {
      await checkTargetDirectory(targetDirectory);
      const expected = j.files[i];
      const candidate = stageId ? await readBounded(path.join(j.stage.path, String(i)), limits[i]) : null;
      const target = await readBounded(j.target + DOCUMENT_COPY_SUFFIXES[i], limits[i]);
      if (candidate && (!expected || !sameFile(candidate, expected))) uncertain();
      if (target && (!expected || !sameFile(target, expected))) uncertain();
      staged.push(candidate); targets.push(target);
    }
    let complete = j.files.every((f, i) => f ? targets[i] !== null : targets[i] === null);
    // Published targets are never deleted. Explicit recovery can finish a
    // partial bundle, but an existing Markdown with a missing companion is
    // identifiable external deletion and remains a conflict.
    if (!complete && allowCompletion && !targets[0] && targets.some(Boolean)) {
      for (const i of [1, 2, 0]) {
        if (!j.files[i] || targets[i]) continue;
        await checkTargetDirectory(targetDirectory);
        const candidate = await readBounded(path.join(j.stage.path, String(i)), limits[i]);
        if (!candidate || !sameFile(candidate, j.files[i]!)) uncertain();
        await fs.link(path.join(j.stage.path, String(i)), j.target + DOCUMENT_COPY_SUFFIXES[i]);
      }
      for (let i = 0; i < 3; i++) {
        await checkTargetDirectory(targetDirectory);
        const current = await readBounded(j.target + DOCUMENT_COPY_SUFFIXES[i], limits[i]);
        if (j.files[i] ? !current || !sameFile(current, j.files[i]!) : current !== null) uncertain();
      }
      complete = true;
    }
    if (!complete && targets.some(Boolean)) uncertain();
    if (stageId) {
      for (let i = 0; i < 3; i++) if (staged[i]) {
        await checkTargetDirectory(targetDirectory);
        await removeChecked(path.join(j.stage.path, String(i)), j.files[i]!, limits[i]);
      }
      await checkTargetDirectory(targetDirectory);
      const currentStage = await directoryIdentity(j.stage.path);
      if (currentStage && !sameIdentity(currentStage, j.stage)) uncertain();
      if (currentStage) await fs.rmdir(j.stage.path);
    }
    await removeChecked(receiptPath, receipt, 64 * 1024);
    return complete ? 'completed' : 'rolledBack';
  } catch { return uncertain(); }
}
/** Only unpublished private files created by this invocation. */
async function cleanPrivate(stage: string, stageId: Identity | null, made: readonly { file: string; id: Identity }[]): Promise<void> {
  if (!stageId) return;
  const actual = await directoryIdentity(stage);
  if (!actual || !sameIdentity(actual, stageId)) uncertain();
  for (const item of made) {
    let stat: BigIntStats;
    try { stat = await fs.lstat(item.file, { bigint: true }); } catch (error) { if (missing(error)) continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || !sameIdentity(identity(stat), item.id)) uncertain();
    await fs.unlink(item.file);
  }
  await fs.rmdir(stage);
}
export async function copyDocumentFiles(options: DocumentCopyOptions): Promise<DocumentCopyReceipt> {
  let source: string, target: string, snapshot: (ReadFile | null)[];
  let targetDirectory: TargetDirectory | undefined;
  try {
    source = await location(options.sourcePath); target = await location(options.targetPath);
    const crossDirectory = key(path.dirname(source)) !== key(path.dirname(target));
    if (!validName(path.basename(target)) || key(source) === key(target) ||
        (crossDirectory && typeof options.crossDirectory?.validateSnapshot !== 'function') ||
        !hashPattern.test(options.expectedSourceSha256.toLowerCase())) fail();
    if (crossDirectory) {
      const parent = path.dirname(target), id = await directoryIdentity(parent);
      if (!id) fail();
      targetDirectory = { path: parent, ...id };
      await checkTargetDirectory(targetDirectory);
    }
    snapshot = await readSource(source);
    if (snapshot[0]!.sha256 !== options.expectedSourceSha256.toLowerCase()) fail();
    for (const suffix of DOCUMENT_COPY_SUFFIXES) await absent(target + suffix);
    const files = snapshot.map((file, i) => ({ suffix: DOCUMENT_COPY_SUFFIXES[i], bytes: file?.data ?? null }));
    await options.validateSnapshot?.(files);
    if (crossDirectory) await options.crossDirectory!.validateSnapshot(files);
    await checkTargetDirectory(targetDirectory);
  } catch (error) { throw error instanceof DocumentCopyError ? error : new DocumentCopyError('refused'); }
  const id = randomUUID(), stage = path.join(path.dirname(target), stageName(id)), filename = journalName(source, id);
  const made: { file: string; id: Identity }[] = [];
  let stageId: Identity | null = null, journalReady = false, receiptId: Identity | null = null, journalRoot = '', receiptPath = '';
  const result = { operationId: id, targetPath: target, copiedSuffixes: DOCUMENT_COPY_SUFFIXES.filter((_, i) => snapshot[i] !== null) };
  activeCopies.add(id);
  try {
    await fs.mkdir(options.journalDirectory, { recursive: true }); journalRoot = await fs.realpath(options.journalDirectory);
    receiptPath = path.join(journalRoot, filename);
    await checkTargetDirectory(targetDirectory);
    await fs.mkdir(stage, { mode: 0o700 }); stageId = await directoryIdentity(stage); if (!stageId) fail();
    const files: (FileRecord | null)[] = [];
    for (let i = 0; i < 3; i++) {
      await checkTargetDirectory(targetDirectory);
      const file = path.join(stage, String(i));
      files.push(snapshot[i] ? await writeNew(file, snapshot[i]!.data, value => made.push({ file, id: value })) : null);
    }
    if (snapshot.some((file, i) => file ? files[i]?.sha256 !== file.sha256 || files[i]?.bytes !== file.bytes : files[i] !== null)) fail();
    const base: JournalBase = { id, ownerPid: process.pid, source, target, stage: { path: stage, ...stageId }, files };
    const j: Journal = targetDirectory ? { ...base, version: 2, targetDirectory } : { ...base, version: 1 };
    const receiptBytes = Buffer.from(JSON.stringify(j) + '\n');
    if (receiptBytes.length > 64 * 1024) fail();
    await writeNew(receiptPath, receiptBytes, value => { receiptId = value; }); journalReady = true;
    await options.beforePublish?.();
    await checkTargetDirectory(targetDirectory);
    const current = await readSource(source);
    if (snapshot.some((f, i) => f ? !current[i] || current[i]!.sha256 !== f.sha256 : current[i] !== null)) fail();
    for (const i of [1, 2, 0]) {
      if (!files[i]) continue;
      await checkTargetDirectory(targetDirectory);
      const candidate = await readBounded(path.join(stage, String(i)), limits[i]);
      if (!candidate || !sameFile(candidate, files[i]!)) uncertain();
      await fs.link(path.join(stage, String(i)), target + DOCUMENT_COPY_SUFFIXES[i]);
      await options.afterPublish?.(DOCUMENT_COPY_SUFFIXES[i]);
    }
    if (await settle(source, journalRoot, filename) !== 'completed') uncertain();
    return result;
  } catch (error) {
    if (error instanceof CopyInterrupted || error instanceof DocumentCopyError && error.code === 'uncertain') throw error;
    try {
      if (journalReady) { if (await settle(source, journalRoot, filename) === 'completed') return result; }
      else {
        await checkTargetDirectory(targetDirectory);
        await cleanPrivate(stage, stageId, made);
        if (receiptId) {
          const stat = await fs.lstat(receiptPath, { bigint: true });
          if (!stat.isFile() || stat.isSymbolicLink() || !sameIdentity(identity(stat), receiptId)) uncertain();
          await fs.unlink(receiptPath);
        }
      }
    } catch { return uncertain(); }
    throw error instanceof DocumentCopyError ? error : new DocumentCopyError('refused');
  } finally { activeCopies.delete(id); }
}
export async function recoverPendingDocumentCopies(options: { sourcePath: string; journalDirectory: string }): Promise<{
  completed: string[]; rolledBack: string[]; conflicts: string[]; busy: string[];
  completedTargets: { operationId: string; targetPath: string }[];
}> {
  const result = { completed: [] as string[], rolledBack: [] as string[], conflicts: [] as string[], busy: [] as string[], completedTargets: [] as { operationId: string; targetPath: string }[] };
  let source: string, journalRoot: string, filenames: string[];
  try {
    source = await location(options.sourcePath);
    try { journalRoot = await fs.realpath(options.journalDirectory); } catch (error) { if (missing(error)) return result; throw error; }
    filenames = (await fs.readdir(journalRoot)).sort();
  } catch { throw new DocumentCopyError('uncertain'); }
  for (const filename of filenames) {
    if (!filename.startsWith(journalPrefix(source)) || !filename.endsWith('.json')) continue;
    try {
      const raw = await readBounded(path.join(journalRoot, filename), 64 * 1024); if (!raw) continue;
      const journal = validateJournal(JSON.parse(raw.data.toString('utf8')), source, filename);
      if (ownerBusy(journal)) { result.busy.push(filename); continue; }
      const outcome = await settle(source, journalRoot, filename, true);
      result[outcome].push(filename);
      if (outcome === 'completed') result.completedTargets.push({ operationId: journal.id, targetPath: journal.target });
    } catch { result.conflicts.push(filename); }
  }
  return result;
}
/** Read-only inventory; actual recovery requires a separate explicit action. */
export async function inspectPendingDocumentCopies(options: { sourcePath: string; journalDirectory: string }): Promise<readonly { name: string | null; busy: boolean; targetPath?: string }[]> {
  const result: { name: string | null; busy: boolean; targetPath?: string }[] = [];
  try {
    const source = await location(options.sourcePath);
    let journalRoot: string;
    try { journalRoot = await fs.realpath(options.journalDirectory); } catch (error) { if (missing(error)) return result; throw error; }
    for (const filename of (await fs.readdir(journalRoot)).sort()) {
      if (!filename.startsWith(journalPrefix(source)) || !filename.endsWith('.json')) continue;
      try {
        const raw = await readBounded(path.join(journalRoot, filename), 64 * 1024); if (!raw) continue;
        const journal = validateJournal(JSON.parse(raw.data.toString('utf8')), source, filename);
        result.push({ name: path.basename(journal.target), busy: ownerBusy(journal), targetPath: journal.target });
      } catch { result.push({ name: null, busy: false }); }
    }
    return result;
  } catch { throw new DocumentCopyError('uncertain'); }
}
