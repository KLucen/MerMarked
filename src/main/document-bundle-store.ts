import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { DOCUMENT_COPY_SUFFIXES, type DocumentCopySuffix } from './document-copy-store.ts';

const sourceLimits = [32 * 1024 * 1024, 1024 * 1024, 4 * 1024 * 1024] as const;
const maxImageBytes = 10 * 1024 * 1024;
const maxTotalBytes = 50 * 1024 * 1024;
const maxArchiveBytes = 52 * 1024 * 1024;
const maxImages = 32;
type Identity = { dev: string; ino: string };
type Captured = Identity & { data: Buffer; sha256: string; bytes: number };
type Directory = Identity & { path: string };
export interface BundleSnapshotFile { readonly suffix: DocumentCopySuffix; readonly bytes: Buffer | null }
export interface BundleReview {
  readonly targetPath: string;
  readonly files: readonly { readonly path: string; readonly bytes: number; readonly kind: 'markdown' | 'annotations' | 'canvas' | 'image' }[];
  readonly imageCount: number;
  readonly totalBytes: number;
  readonly archiveBytes: number;
}
export interface SavedDocumentBundleOptions {
  sourcePath: string;
  targetPath: string;
  expectedSourceSha256: string;
  validateSnapshot?: (files: readonly BundleSnapshotFile[]) => Promise<void>;
  planSnapshot: (files: readonly BundleSnapshotFile[]) => Promise<readonly string[]>;
  review: (summary: BundleReview) => Promise<void>;
  beforePublish?: () => Promise<void>;
  afterPublish?: () => Promise<void>;
}
export interface SavedDocumentBundleReceipt {
  readonly targetPath: string; readonly fileCount: number; readonly imageCount: number;
  readonly totalBytes: number; readonly archiveBytes: number; readonly sha256: string;
}
export class BundleStoreError extends Error {
  readonly code: 'refused' | 'uncertain';
  constructor(code: 'refused' | 'uncertain') {
    super(code === 'uncertain' ? '副本包状态需要检查，相关文件已保留。原文件未修改。'
      : '无法安全创建副本包，请检查图片、目标位置或文件是否已变化。原文件未修改。');
    this.name = 'BundleStoreError'; this.code = code;
  }
}
/** Test-only checkpoint matching a process ending before private cleanup. */
export class BundleInterrupted extends Error {}
function refused(): never { throw new BundleStoreError('refused'); }
function uncertain(): never { throw new BundleStoreError('uncertain'); }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const key = (value: string) => value.normalize('NFC').toLowerCase();
const pathKey = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const identity = (info: BigIntStats): Identity => ({ dev: String(info.dev), ino: String(info.ino) });
const sameIdentity = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a: Captured, b: Captured) => sameIdentity(a, b) && a.sha256 === b.sha256 && a.bytes === b.bytes;

function validSegment(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value !== '.' && value !== '..' &&
    !/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/.test(value) && !/[\uD800-\uDFFF]/u.test(value) && !/[ .]$/.test(value) &&
    !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value);
}
function validAsset(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && Buffer.byteLength(value) <= 4096 &&
    value.split('/').every(validSegment) && /\.(png|jpe?g|gif|webp)$/i.test(value);
}
async function readBounded(file: string, limit: number): Promise<Captured | null> {
  let before: BigIntStats;
  try { before = await fs.lstat(file, { bigint: true }); } catch (error) { if (missing(error)) return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(limit)) refused();
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(identity(before), identity(opened))) refused();
    const data = await handle.readFile();
    const after = await fs.lstat(file, { bigint: true });
    if (data.length > limit || !after.isFile() || after.isSymbolicLink() || !sameIdentity(identity(opened), identity(after))) refused();
    return { ...identity(opened), data, sha256: digest(data), bytes: data.length };
  } finally { await handle.close(); }
}
async function directory(dir: string): Promise<Directory> {
  const info = await fs.lstat(dir, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || pathKey(await fs.realpath(dir)) !== pathKey(dir)) refused();
  return { path: dir, ...identity(info) };
}
async function checkDirectory(expected: Directory): Promise<void> {
  if (!sameIdentity(await directory(expected.path), expected)) refused();
}
async function absent(file: string): Promise<void> {
  try { await fs.lstat(file); } catch (error) { if (missing(error)) return; throw error; }
  refused();
}
async function sourceFiles(source: string): Promise<(Captured | null)[]> {
  const files = [];
  for (let i = 0; i < 3; i++) files.push(await readBounded(source + DOCUMENT_COPY_SUFFIXES[i], sourceLimits[i]));
  if (!files[0]) refused();
  return files;
}
export function rasterSignature(file: string, bytes: Buffer): boolean {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0;
  if (ext === '.jpg' || ext === '.jpeg') return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
  if (ext === '.gif') return bytes.length >= 14 && /^(GIF87a|GIF89a)$/.test(bytes.toString('ascii', 0, 6)) && bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0 && bytes[bytes.length - 1] === 59;
  return ext === '.webp' && bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) + 8 === bytes.length &&
    bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16));
}
async function readAsset(root: Directory, relative: string, directories: Map<string, Directory>): Promise<Captured> {
  await checkDirectory(root);
  const parts = relative.split('/'); let parent = root.path;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    const current = await directory(parent), prior = directories.get(pathKey(parent));
    if (prior && !sameIdentity(current, prior)) refused();
    directories.set(pathKey(parent), prior ?? current);
  }
  const fullPath = path.join(root.path, ...parts);
  const file = await readBounded(fullPath, maxImageBytes);
  if (!file || pathKey(await fs.realpath(fullPath)) !== pathKey(fullPath) || !rasterSignature(relative, file.data)) refused();
  for (const expected of directories.values()) await checkDirectory(expected);
  await checkDirectory(root);
  return file;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
/** Stored ZIP32 with explicit UTF-8 names and no executable/symlink attributes. */
function archive(entries: readonly { path: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0, centralBytes = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path), crc = crc32(entry.data), header = Buffer.alloc(30), record = Buffer.alloc(46);
    if (!name.length || name.length > 4096) refused();
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(entry.data.length, 18);
    header.writeUInt32LE(entry.data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, entry.data);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8); record.writeUInt16LE(33, 14); record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(entry.data.length, 20); record.writeUInt32LE(entry.data.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(0x20, 38); record.writeUInt32LE(offset, 42); central.push(record, name);
    offset += header.length + name.length + entry.data.length; centralBytes += record.length + name.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes, 12); end.writeUInt32LE(offset, 16);
  if (offset + centralBytes + end.length > maxArchiveBytes) refused();
  return Buffer.concat([...local, ...central, end]);
}

export async function createSavedDocumentBundle(options: SavedDocumentBundleOptions): Promise<SavedDocumentBundleReceipt> {
  let target = '', stage = ''; let targetDirectory: Directory | undefined, stageId: Identity | undefined;
  let zip: Buffer | undefined, zipSha = '', written = false, published = false;
  let receipt: SavedDocumentBundleReceipt | undefined;
  const removeStage = async () => {
    if (!stageId || !targetDirectory || !zip) return;
    await checkDirectory(targetDirectory);
    const current = await readBounded(stage, maxArchiveBytes);
    if (!current) return;
    if (!sameIdentity(current, stageId) || (written ? current.sha256 !== zipSha :
      current.bytes > zip.length || !current.data.equals(zip.subarray(0, current.bytes)))) uncertain();
    await fs.unlink(stage);
  };
  const publishedComplete = async () => {
    if (!stageId || !targetDirectory || !receipt) return false;
    await checkDirectory(targetDirectory);
    const current = await readBounded(target, maxArchiveBytes);
    return Boolean(current && sameIdentity(current, stageId) && current.sha256 === zipSha && current.bytes === receipt.archiveBytes);
  };
  try {
    if (!path.isAbsolute(options.sourcePath) || !path.isAbsolute(options.targetPath) || !/^[a-f0-9]{64}$/i.test(options.expectedSourceSha256) ||
        !validSegment(path.basename(options.targetPath)) || path.basename(options.targetPath).length > 220 || path.extname(options.targetPath).toLowerCase() !== '.zip' ||
        typeof options.planSnapshot !== 'function' || typeof options.review !== 'function') refused();
    const sourceRoot = await directory(await fs.realpath(path.dirname(options.sourcePath)));
    const source = path.join(sourceRoot.path, path.basename(options.sourcePath));
    if (!validSegment(path.basename(source)) || path.extname(source).toLowerCase() !== '.md') refused();
    targetDirectory = await directory(await fs.realpath(path.dirname(options.targetPath)));
    target = path.join(targetDirectory.path, path.basename(options.targetPath)); await absent(target);
    const captured = await sourceFiles(source);
    if (captured[0]!.sha256 !== options.expectedSourceSha256.toLowerCase()) refused();
    const snapshot = captured.map((file, i) => ({ suffix: DOCUMENT_COPY_SUFFIXES[i], bytes: file?.data ?? null }));
    await options.validateSnapshot?.(snapshot);
    const planned = await options.planSnapshot(snapshot);
    if (!Array.isArray(planned) || planned.length > maxImages) refused();
    const names = new Set<string>(), entries: { path: string; data: Buffer }[] = [];
    const files: BundleReview['files'][number][] = [];
    for (let i = 0; i < 3; i++) if (captured[i]) {
      const name = path.basename(source) + DOCUMENT_COPY_SUFFIXES[i]; names.add(key(name));
      entries.push({ path: name, data: captured[i]!.data });
      files.push({ path: name, bytes: captured[i]!.bytes, kind: (['markdown', 'annotations', 'canvas'] as const)[i] });
    }
    const directories = new Map<string, Directory>(), images: { path: string; captured: Captured }[] = [];
    let totalBytes = captured.reduce((total, file) => total + (file?.bytes ?? 0), 0);
    for (const relative of planned) {
      if (!validAsset(relative) || names.has(key(relative))) refused(); names.add(key(relative));
      const image = await readAsset(sourceRoot, relative, directories); totalBytes += image.bytes;
      if (totalBytes > maxTotalBytes) refused();
      images.push({ path: relative, captured: image }); entries.push({ path: relative, data: image.data });
      files.push({ path: relative, bytes: image.bytes, kind: 'image' });
    }
    if (totalBytes > maxTotalBytes) refused();
    const checkBuffers = () => {
      for (const file of [...captured, ...images.map(image => image.captured)]) if (file && (digest(file.data) !== file.sha256 || file.data.length !== file.bytes)) refused();
    };
    const checkSource = async () => {
      await checkDirectory(sourceRoot);
      for (const expected of directories.values()) await checkDirectory(expected);
      const current = await sourceFiles(source);
      if (captured.some((file, i) => file ? !current[i] || current[i]!.sha256 !== file.sha256 : current[i] !== null)) refused();
      for (const image of images) if (!sameFile(await readAsset(sourceRoot, image.path, directories), image.captured)) refused();
      checkBuffers();
    };
    checkBuffers(); zip = archive(entries); zipSha = digest(zip);
    receipt = { targetPath: target, fileCount: files.length, imageCount: images.length, totalBytes, archiveBytes: zip.length, sha256: zipSha };
    await options.review({ targetPath: target, files: files.map(file => ({ ...file })), imageCount: images.length, totalBytes, archiveBytes: zip.length });
    await checkSource(); await checkDirectory(targetDirectory); await absent(target);
    stage = path.join(targetDirectory.path, `.mermarkd-bundle-${randomUUID()}.tmp`);
    const handle = await fs.open(stage, 'wx', 0o600);
    try { stageId = identity(await handle.stat({ bigint: true })); await handle.writeFile(zip); await handle.sync(); written = true; }
    finally { await handle.close(); }
    await options.beforePublish?.(); await checkSource(); await checkDirectory(targetDirectory);
    const candidate = await readBounded(stage, maxArchiveBytes);
    if (!candidate || !sameIdentity(candidate, stageId) || candidate.sha256 !== zipSha) refused();
    await fs.link(stage, target); published = true; await options.afterPublish?.();
    if (!await publishedComplete()) uncertain();
    await removeStage(); return receipt;
  } catch (error) {
    if (error instanceof BundleInterrupted) throw error;
    try {
      if (await publishedComplete()) { await removeStage(); return receipt!; }
      if (published) uncertain();
      await removeStage();
    } catch { return uncertain(); }
    throw error instanceof BundleStoreError ? error : new BundleStoreError('refused');
  }
}
