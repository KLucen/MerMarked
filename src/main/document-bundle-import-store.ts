import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { parseDocumentBundleArchive } from '../core/document-bundle-archive.ts';
import { planDocumentBundle } from '../core/document-bundle-plan.ts';
import { decodeMarkdownBytes } from '../core/markdown-source.ts';
import { rasterSignature } from './document-bundle-store.ts';

const maxArchiveBytes = 52 * 1024 * 1024;
type ParsedBundle = ReturnType<typeof parseDocumentBundleArchive>;
type Identity = { dev: string; ino: string };
type Directory = Identity & { path: string };
type Captured = Identity & { data: Buffer; sha256: string };
type Published = Captured & { path: string };
type PrivateFile = Identity & { path: string; data: Buffer; complete: boolean };
export interface BundleImportReview {
  readonly directory: string;
  readonly documentPath: string;
  readonly files: readonly { readonly path: string; readonly bytes: number; readonly kind: 'markdown' | 'annotations' | 'canvas' | 'image' }[];
  readonly fileCount: number;
  readonly imageCount: number;
  readonly totalBytes: number;
}
export interface DocumentBundleImportOptions {
  archivePath: string;
  parentDirectory: string | (() => Promise<string>);
  validateBundle?: (bundle: ParsedBundle) => Promise<void>;
  review: (summary: BundleImportReview) => Promise<void>;
  beforePublish?: () => Promise<void>;
  afterPublish?: (relativePath: string) => Promise<void>;
}
export interface DocumentBundleImportReceipt {
  readonly directory: string;
  readonly documentPath: string;
  readonly fileCount: number;
  readonly imageCount: number;
  readonly totalBytes: number;
}
export class BundleImportError extends Error {
  readonly code: 'refused' | 'uncertain';
  readonly partialDirectory?: string;
  constructor(code: 'refused' | 'uncertain', partialDirectory?: string) {
    super(code === 'uncertain' ? '解包未完成，已生成的文件已保留。请重新选择位置解包，原副本包未修改。'
      : '无法安全打开副本包，请检查格式、图片或文件是否已变化。原副本包未修改。');
    this.name = 'BundleImportError'; this.code = code; this.partialDirectory = partialDirectory;
  }
}
/** Test-only checkpoint matching a process ending without cleanup. */
export class BundleImportInterrupted extends Error {}
function refused(): never { throw new BundleImportError('refused'); }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const identity = (info: BigIntStats): Identity => ({ dev: String(info.dev), ino: String(info.ino) });
const sameIdentity = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const pathKey = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const stableStat = (a: BigIntStats, b: BigIntStats) => sameIdentity(identity(a), identity(b)) &&
  a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** The extra byte detects growth without an unbounded readFile allocation. */
async function readBounded(file: string, limit: number): Promise<Captured> {
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(limit)) refused();
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !stableStat(before, opened)) refused();
    const storage = Buffer.allocUnsafe(Number(before.size) + 1); let length = 0;
    while (length < storage.length) {
      const read = await handle.read(storage, length, storage.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const afterHandle = await handle.stat({ bigint: true }), after = await fs.lstat(file, { bigint: true });
    if (length > limit || BigInt(length) !== before.size || !after.isFile() || after.isSymbolicLink() ||
      !stableStat(opened, afterHandle) || !stableStat(opened, after) || pathKey(await fs.realpath(file)) !== pathKey(file)) refused();
    const data = Buffer.from(storage.subarray(0, length));
    return { ...identity(opened), data, sha256: digest(data) };
  } finally { await handle.close(); }
}
async function directory(value: string): Promise<Directory> {
  const info = await fs.lstat(value, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || pathKey(await fs.realpath(value)) !== pathKey(value)) refused();
  return { path: value, ...identity(info) };
}
async function checkDirectory(expected: Directory): Promise<void> {
  if (!sameIdentity(await directory(expected.path), expected)) refused();
}
async function sameCaptured(file: string, expected: Captured): Promise<void> {
  const actual = await readBounded(file, expected.data.length);
  if (!sameIdentity(actual, expected) || actual.sha256 !== expected.sha256) refused();
}
function requiredDirectories(bundle: ParsedBundle): string[] {
  const directories = new Set<string>();
  for (const file of bundle.files) {
    const pieces = file.path.split('/');
    if (pieces.length > 33) refused();
    for (let count = 1; count < pieces.length; count++) directories.add(pieces.slice(0, count).join('/'));
  }
  if (directories.size > 128) refused();
  return [...directories].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}
async function validateContent(bundle: ParsedBundle): Promise<void> {
  const markdown = bundle.files.find(file => file.kind === 'markdown');
  if (!markdown) refused();
  const { content } = decodeMarkdownBytes(markdown.bytes), plan = await planDocumentBundle(content);
  const images = bundle.files.filter(file => file.kind === 'image');
  if (!plan.portable || images.length !== plan.images.length ||
    !images.every(file => plan.images.some(image => image.path === file.path)) ||
    !images.every(file => rasterSignature(file.path, Buffer.from(file.bytes)))) refused();
}

/**
 * A retained input ZIP and a fresh, exclusive directory form the recovery boundary.
 * Images and companions publish first; the Markdown file publishes only after the
 * complete captured set is rechecked. A retry always uses another new directory.
 */
export async function importDocumentBundle(options: DocumentBundleImportOptions): Promise<DocumentBundleImportReceipt> {
  let createdOutputPath: string | undefined; let privateFile: PrivateFile | undefined;
  const directories: Directory[] = [], published: Published[] = [];
  const checkDirectories = async () => { for (const expected of directories) await checkDirectory(expected); };
  const cleanupPrivate = async () => {
    if (!privateFile?.complete) return false;
    try {
      await checkDirectories();
      const actual = await readBounded(privateFile.path, privateFile.data.length);
      if (sameIdentity(actual, privateFile) && actual.sha256 === digest(privateFile.data)) { await fs.unlink(privateFile.path); return true; }
    } catch { /* A changed path is never removed, even when private cleanup fails. */ }
    return false;
  };
  try {
    if (!path.isAbsolute(options.archivePath) || path.extname(options.archivePath).toLowerCase() !== '.zip' ||
      typeof options.review !== 'function' || (typeof options.parentDirectory !== 'string' && typeof options.parentDirectory !== 'function')) refused();
    const archivePath = path.resolve(options.archivePath), archiveParent = await directory(path.dirname(archivePath));
    const source = await readBounded(archivePath, maxArchiveBytes), bundle = parseDocumentBundleArchive(source.data);
    const payloads = bundle.files.map(file => ({ bytes: file.bytes, sha256: digest(file.bytes) }));
    for (const file of bundle.files) Object.freeze(file);
    Object.freeze(bundle.files); Object.freeze(bundle);
    const directoryNames = requiredDirectories(bundle);
    await validateContent(bundle);
    await options.validateBundle?.(bundle);
    const parentPath = typeof options.parentDirectory === 'function' ? await options.parentDirectory() : options.parentDirectory;
    if (typeof parentPath !== 'string' || !path.isAbsolute(parentPath)) refused();
    const parent = await directory(path.resolve(parentPath)); directories.push(parent);
    const stem = Array.from(bundle.documentName.slice(0, -3)).slice(0, 80).join('');
    const outputPath = path.join(parent.path, `${stem} - 副本-${randomUUID().slice(0, 8)}`);
    const documentPath = path.join(outputPath, bundle.documentName);
    const receipt: DocumentBundleImportReceipt = { directory: outputPath, documentPath, fileCount: bundle.files.length, imageCount: bundle.imageCount, totalBytes: bundle.totalBytes };
    const summary: BundleImportReview = { ...receipt, files: bundle.files.map(file => ({ path: file.path, bytes: file.bytes.length, kind: file.kind })) };
    const checkCapture = async () => {
      if (digest(source.data) !== source.sha256 || !payloads.every(file => digest(file.bytes) === file.sha256)) refused();
      await checkDirectory(archiveParent); await sameCaptured(archivePath, source); await checkDirectories();
      for (const file of published) await sameCaptured(file.path, file);
    };
    await options.review(summary);
    await options.beforePublish?.();
    await checkCapture();
    await fs.mkdir(outputPath, { mode: 0o700 });
    createdOutputPath = outputPath;
    directories.push(await directory(outputPath));
    for (const relative of directoryNames) {
      await checkDirectories();
      const child = path.join(outputPath, ...relative.split('/'));
      await fs.mkdir(child, { mode: 0o700 });
      directories.push(await directory(child));
    }
    const ordered = [...bundle.files].sort((a, b) => Number(a.kind === 'markdown') - Number(b.kind === 'markdown') ||
      Number(a.kind !== 'image') - Number(b.kind !== 'image'));
    for (const file of ordered) {
      if (file.kind === 'markdown') { await options.beforePublish?.(); await checkCapture(); }
      await checkDirectories();
      const target = path.join(outputPath, ...file.path.split('/'));
      const temp = path.join(path.dirname(target), `.mermarkd-unpack-${randomUUID()}.tmp`);
      const data = Buffer.from(file.bytes), handle = await fs.open(temp, 'wx', 0o600);
      try {
        privateFile = { path: temp, ...identity(await handle.stat({ bigint: true })), data, complete: false };
        await handle.writeFile(data); await handle.sync(); privateFile.complete = true;
      } finally { await handle.close(); }
      await checkDirectories();
      const captured = await readBounded(temp, data.length);
      if (!sameIdentity(captured, privateFile) || captured.sha256 !== digest(data)) refused();
      if (file.kind === 'markdown') await checkCapture();
      // link is exclusive; an externally-created final path is never replaced.
      await fs.link(temp, target);
      const final = await readBounded(target, data.length);
      if (!sameIdentity(final, captured) || final.sha256 !== captured.sha256) refused();
      published.push({ path: target, ...final });
      if (!await cleanupPrivate()) refused();
      privateFile = undefined;
      await options.afterPublish?.(file.path);
    }
    await checkCapture();
    return receipt;
  } catch (error) {
    if (error instanceof BundleImportInterrupted) throw error;
    await cleanupPrivate();
    throw new BundleImportError(createdOutputPath ? 'uncertain' : 'refused', createdOutputPath);
  }
}
