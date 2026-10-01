import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseAnnotationYaml, MAX_ANNOTATION_YAML_BYTES } from '../core/annotations.ts';
import { MAX_CANVAS_JSON_BYTES, reconcileCanvasState } from '../core/canvas-state.ts';
import { parseCanvasStateJson, reconcileCanvasStateV2 } from '../core/canvas-state-v2.ts';
import type { CanvasStateDocument } from '../core/canvas-state-v2.ts';
import { assertMarkdownLineEndingsPreserved, decodeMarkdownBytes } from '../core/markdown-source.ts';
import { extractSections } from '../core/sections.ts';
import { buildSelectionMap, resolveStoredHighlight } from '../core/selection-map.ts';

export type DocumentFileKind = 'markdown' | 'annotations' | 'canvas';
const kinds: readonly DocumentFileKind[] = ['markdown', 'annotations', 'canvas'];
const limits = { markdown: 32 * 1024 * 1024, annotations: MAX_ANNOTATION_YAML_BYTES, canvas: MAX_CANVAS_JSON_BYTES };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hashPattern = /^[0-9a-f]{64}$/;

export interface DocumentBundle {
  readonly markdown: Uint8Array;
  readonly annotations: Uint8Array | null;
  readonly canvas: Uint8Array | null;
}

export interface DocumentTransactionRef {
  readonly id: string;
  readonly journalSha256: string;
}

interface Journal {
  readonly schemaVersion: 1;
  readonly kind: 'document-transaction';
  readonly id: string;
  readonly documentName: string;
  readonly createdAt: string;
  readonly before: Readonly<Record<DocumentFileKind, string | null>>;
  readonly after: Readonly<Record<DocumentFileKind, string | null>>;
}

export interface DocumentTransactionInventoryItem {
  readonly id: string;
  readonly status: 'prepared' | 'committed' | 'interrupted' | 'conflict' | 'incomplete' | 'invalid';
  readonly ref?: DocumentTransactionRef;
  readonly artifacts: readonly string[];
  /** A durable receipt separates historical snapshots from unfinished saves. */
  readonly completed?: boolean;
}

export interface DocumentTransactionResult {
  readonly status: 'committed' | 'conflict' | 'pending' | 'busy';
  readonly ref: DocumentTransactionRef;
}

/** Fault injection remains in main; no filesystem paths enter preload. */
export interface DocumentTransactionOperations {
  readonly afterDisplaced?: (kind: DocumentFileKind, documentPath: string) => Promise<void>;
  readonly beforePublished?: (kind: DocumentFileKind, documentPath: string) => Promise<void>;
  readonly afterPublished?: (kind: DocumentFileKind, documentPath: string) => Promise<void>;
}

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function invalid(): never { throw new Error('文档恢复事务无法安全核验，文件保持原样。'); }
function decode(bytes: Uint8Array): string { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
function same(left: Uint8Array | null, right: Uint8Array | null): boolean { return left === null || right === null ? left === right : digest(left) === digest(right); }

async function canonicalPath(documentPath: string): Promise<string> {
  if (!path.isAbsolute(documentPath) || path.extname(documentPath).toLowerCase() !== '.md') invalid();
  const result = path.join(await realpath(path.dirname(documentPath)), path.basename(documentPath));
  try { if ((await lstat(result)).isSymbolicLink()) invalid(); } catch (error) { if (!missing(error)) throw error; }
  return result;
}

function target(documentPath: string, kind: DocumentFileKind): string {
  return kind === 'markdown' ? documentPath : `${documentPath}${kind === 'annotations' ? '.annotations.yaml' : '.mermarkd.json'}`;
}

function prefix(documentPath: string, id: string): string { return `${documentPath}.mermarkd-txn.${id}`; }
function journalPath(documentPath: string, id: string): string { return `${prefix(documentPath, id)}.journal.json`; }
function snapshotPath(documentPath: string, id: string, kind: DocumentFileKind, version: 'before' | 'after'): string {
  return `${prefix(documentPath, id)}.${kind}.${version}`;
}

async function readBytes(filePath: string, max: number): Promise<Buffer | null> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > max) invalid();
    const bytes = await readFile(filePath);
    if (bytes.length > max) invalid();
    return bytes;
  } catch (error) { if (missing(error)) return null; throw error; }
}

async function writeSynced(filePath: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(filePath, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

function receiptPath(documentPath: string, ref: DocumentTransactionRef): string {
  return `${prefix(documentPath, ref.id)}.committed.json`;
}

function receiptBytes(ref: DocumentTransactionRef): Buffer {
  return Buffer.from(`${JSON.stringify({ schemaVersion: 1, id: ref.id, journalSha256: ref.journalSha256 })}\n`);
}

async function recordCompletion(documentPath: string, ref: DocumentTransactionRef): Promise<void> {
  const bytes = receiptBytes(ref);
  const existing = await readBytes(receiptPath(documentPath, ref), 1024);
  if (existing) { if (digest(existing) !== digest(bytes)) invalid(); return; }
  const temporary = `${receiptPath(documentPath, ref)}.${randomUUID()}.tmp`;
  await writeSynced(temporary, bytes);
  await link(temporary, receiptPath(documentPath, ref));
  await rm(temporary);
}

function bundleHashes(bundle: DocumentBundle): Record<DocumentFileKind, string | null> {
  return { markdown: digest(bundle.markdown), annotations: bundle.annotations === null ? null : digest(bundle.annotations), canvas: bundle.canvas === null ? null : digest(bundle.canvas) };
}

async function validateBundles(before: DocumentBundle, after: DocumentBundle): Promise<void> {
  for (const kind of kinds) {
    if ((before[kind]?.byteLength ?? 0) > limits[kind] || (after[kind]?.byteLength ?? 0) > limits[kind]) invalid();
    // Deletion needs its own preview/recovery policy; v1 only replaces or creates.
    if (before[kind] !== null && after[kind] === null) invalid();
  }
  const original = decodeMarkdownBytes(before.markdown);
  const next = decodeMarkdownBytes(after.markdown);
  const beforeHash = digest(before.markdown);
  const afterHash = digest(after.markdown);
  if (original.format.bomByteLength !== next.format.bomByteLength) invalid();
  if (beforeHash !== afterHash && original.format.lineEnding === 'mixed') invalid();
  assertMarkdownLineEndingsPreserved(original.format, next.format);
  extractSections(next.content);
  const oldAnnotations = before.annotations === null ? null : parseAnnotationYaml(decode(before.annotations));
  if (after.annotations !== null) {
    const model = parseAnnotationYaml(decode(after.annotations));
    if (!same(before.annotations, after.annotations)) {
      if (model.source.sha256 !== afterHash) invalid();
      const map = buildSelectionMap(next.content, next.format.bomByteLength);
      for (const item of model.annotations) {
        if (item.anchor.basisSha256 === afterHash) {
          if (!resolveStoredHighlight(map, item.anchor).ok) invalid();
        } else {
          const old = oldAnnotations?.annotations.find((record) => record.id === item.id);
          if (!old || JSON.stringify(old.anchor) !== JSON.stringify(item.anchor)) invalid();
        }
      }
    }
  }
  const oldCanvas: CanvasStateDocument | null = before.canvas === null ? null : parseCanvasStateJson(decode(before.canvas));
  if (after.canvas !== null) {
    const model = parseCanvasStateJson(decode(after.canvas));
    if (!same(before.canvas, after.canvas)) {
      if (model.source.sha256 !== afterHash) invalid();
      const unresolvedCardIds = model.schemaVersion === 2
        ? (await reconcileCanvasStateV2(model, { bytes: after.markdown, content: next.content, sha256: afterHash })).unresolvedCardIds
        : (await reconcileCanvasState(model, { bytes: after.markdown, content: next.content, sha256: afterHash })).unresolvedCardIds;
      for (const card of model.cards) {
        if (card.anchor.basisSha256 === afterHash) {
          if (unresolvedCardIds.includes(card.id)) invalid();
        } else {
          const old = oldCanvas?.cards.find((record) => record.id === card.id);
          if (!old || JSON.stringify(old.anchor) !== JSON.stringify(card.anchor)) invalid();
        }
      }
    }
  }
}

/** Immutable candidate/baseline copies and journal precede every target mutation. */
export async function prepareDocumentTransaction(input: {
  readonly documentPath: string; readonly before: DocumentBundle; readonly after: DocumentBundle;
}): Promise<DocumentTransactionRef> {
  const documentPath = await canonicalPath(input.documentPath);
  const before = { ...input.before, markdown: Uint8Array.from(input.before.markdown),
    annotations: input.before.annotations === null ? null : Uint8Array.from(input.before.annotations),
    canvas: input.before.canvas === null ? null : Uint8Array.from(input.before.canvas) };
  const after = { ...input.after, markdown: Uint8Array.from(input.after.markdown),
    annotations: input.after.annotations === null ? null : Uint8Array.from(input.after.annotations),
    canvas: input.after.canvas === null ? null : Uint8Array.from(input.after.canvas) };
  await validateBundles(before, after);
  const id = randomUUID();
  for (const kind of kinds) for (const [version, bundle] of [['before', before], ['after', after]] as const) {
    const bytes = bundle[kind];
    if (bytes !== null) await writeSynced(snapshotPath(documentPath, id, kind, version), bytes);
  }
  const journal: Journal = { schemaVersion: 1, kind: 'document-transaction', id, documentName: path.basename(documentPath),
    createdAt: new Date().toISOString(), before: bundleHashes(before), after: bundleHashes(after) };
  const bytes = Buffer.from(`${JSON.stringify(journal, null, 2)}\n`);
  const temporary = `${journalPath(documentPath, id)}.tmp`;
  await writeSynced(temporary, bytes);
  await link(temporary, journalPath(documentPath, id));
  await rm(temporary);
  return { id, journalSha256: digest(bytes) };
}

function parseJournal(bytes: Uint8Array, documentPath: string, ref: DocumentTransactionRef): Journal {
  if (!uuidPattern.test(ref.id) || !hashPattern.test(ref.journalSha256) || digest(bytes) !== ref.journalSha256) invalid();
  const value: unknown = JSON.parse(decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const entry = value as Journal;
  const fields = ['schemaVersion', 'kind', 'id', 'documentName', 'createdAt', 'before', 'after'];
  if (Object.keys(entry).length !== fields.length || fields.some((field) => !Object.hasOwn(entry, field)) ||
    entry.schemaVersion !== 1 || entry.kind !== 'document-transaction' || entry.id !== ref.id ||
    entry.documentName !== path.basename(documentPath) || typeof entry.createdAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.createdAt) || !Number.isFinite(Date.parse(entry.createdAt))) invalid();
  for (const version of [entry.before, entry.after]) {
    if (!version || typeof version !== 'object' || Object.keys(version).length !== 3 ||
      kinds.some((kind) => !Object.hasOwn(version, kind) || (version[kind] !== null && !hashPattern.test(version[kind]!)))) invalid();
  }
  if (entry.before.markdown === null || entry.after.markdown === null ||
    kinds.some((kind) => entry.before[kind] !== null && entry.after[kind] === null)) invalid();
  return entry;
}

async function loadTransaction(documentPath: string, ref: DocumentTransactionRef): Promise<{ journal: Journal; before: DocumentBundle; after: DocumentBundle }> {
  if (!uuidPattern.test(ref.id)) invalid();
  const bytes = await readBytes(journalPath(documentPath, ref.id), 16_384);
  if (!bytes) invalid();
  const journal = parseJournal(bytes, documentPath, ref);
  const load = async (version: 'before' | 'after'): Promise<DocumentBundle> => {
    const bundle = {} as Record<DocumentFileKind, Uint8Array | null>;
    for (const kind of kinds) {
      if (journal[version][kind] === null) { bundle[kind] = null; continue; }
      const snapshot = await readBytes(snapshotPath(documentPath, ref.id, kind, version), limits[kind]);
      if (!snapshot || digest(snapshot) !== journal[version][kind]) invalid();
      bundle[kind] = snapshot;
    }
    return bundle as DocumentBundle;
  };
  const before = await load('before');
  const after = await load('after');
  await validateBundles(before, after);
  return { journal, before, after };
}

async function states(documentPath: string, journal: Journal): Promise<Record<DocumentFileKind, 'before' | 'after' | 'interrupted' | 'conflict'>> {
  const result = {} as Record<DocumentFileKind, 'before' | 'after' | 'interrupted' | 'conflict'>;
  for (const kind of kinds) {
    const bytes = await readBytes(target(documentPath, kind), limits[kind]);
    const hash = bytes === null ? null : digest(bytes);
    if (hash === journal.after[kind]) result[kind] = 'after';
    else if (hash === journal.before[kind]) result[kind] = 'before';
    else if (hash === null && journal.before[kind] === null) result[kind] = 'before';
    else if (hash === null && journal.before[kind] !== null) {
      const displaced = await readBytes(`${prefix(documentPath, journal.id)}.${kind}.displaced`, limits[kind]);
      result[kind] = displaced !== null && digest(displaced) === journal.before[kind] ? 'interrupted' : 'conflict';
    } else result[kind] = 'conflict';
  }
  return result;
}

function lockPaths(documentPath: string): string[] {
  return [`${documentPath}.mermarkd-save.lock`, `${target(documentPath, 'annotations')}.lock`, `${target(documentPath, 'canvas')}.lock`];
}

async function acquireLocks(documentPath: string, id: string, recover: boolean): Promise<(() => Promise<void>) | null> {
  const acquired: { path: string; bytes: Uint8Array }[] = [];
  const release = async () => {
    for (const item of acquired.reverse()) {
      const current = await readBytes(item.path, 16_384);
      if (current && digest(current) === digest(item.bytes)) await rm(item.path);
    }
  };
  try {
    for (const lockPath of lockPaths(documentPath)) {
      if (recover) {
        const current = await readBytes(lockPath, 16_384);
        if (current) {
          try {
            const owner = JSON.parse(decode(current)) as { kind?: string; ownerToken?: string; pid?: number; documentPath?: string };
            if (owner.kind === 'markdown-save-lock' && owner.ownerToken === id && owner.documentPath === documentPath &&
              Number.isSafeInteger(owner.pid) && owner.pid! > 0) {
              let alive = true;
              try { process.kill(owner.pid!, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
              if (!alive && digest((await readBytes(lockPath, 16_384)) ?? new Uint8Array()) === digest(current)) await rm(lockPath);
            }
          } catch { /* Unknown locks are retained for explicit inspection. */ }
        }
      }
      const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'markdown-save-lock', documentPath, ownerToken: id, pid: process.pid, createdAt: new Date().toISOString() }));
      await writeSynced(lockPath, bytes);
      acquired.push({ path: lockPath, bytes });
    }
    return release;
  } catch { await release(); return null; }
}

async function publish(
  documentPath: string, ref: DocumentTransactionRef, recover: boolean, operations: DocumentTransactionOperations,
): Promise<DocumentTransactionResult> {
  const canonical = await canonicalPath(documentPath);
  const loaded = await loadTransaction(canonical, ref);
  const release = await acquireLocks(canonical, ref.id, recover);
  if (!release) return { status: 'busy', ref };
  try {
    for (const kind of kinds) {
      const current = await states(canonical, loaded.journal);
      if (kinds.some((entry) => current[entry] === 'conflict')) return { status: 'conflict', ref };
      if (current[kind] === 'after') continue;
      const destination = target(canonical, kind);
      if (current[kind] === 'before' && loaded.journal.before[kind] !== null) {
        let displaced = `${prefix(canonical, ref.id)}.${kind}.displaced`;
        if (await readBytes(displaced, limits[kind])) displaced += `.${randomUUID()}`;
        await rename(destination, displaced);
        const moved = await readBytes(displaced, limits[kind]);
        if (!moved || digest(moved) !== loaded.journal.before[kind]) {
          // Preserve a raced external version and restore only to an empty path.
          try { await link(displaced, destination); } catch { /* Never replace a recreated target. */ }
          return { status: 'conflict', ref };
        }
        await operations.afterDisplaced?.(kind, destination);
      }
      const bytes = loaded.after[kind];
      if (bytes === null) invalid();
      // A published hard link must not share the immutable recovery snapshot:
      // later in-place external writes would otherwise corrupt that snapshot.
      const temporary = `${prefix(canonical, ref.id)}.${kind}.publish.${randomUUID()}`;
      await writeSynced(temporary, bytes);
      await operations.beforePublished?.(kind, destination);
      const rechecked = await states(canonical, loaded.journal);
      if (kinds.some((entry) => rechecked[entry] === 'conflict')) return { status: 'conflict', ref };
      try { await link(temporary, destination); } catch (error) {
        return { status: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'conflict' : 'pending', ref };
      }
      await operations.afterPublished?.(kind, destination);
      await rm(temporary);
    }
    const current = await states(canonical, loaded.journal);
    if (!kinds.every((kind) => current[kind] === 'after')) return { status: 'conflict', ref };
    await recordCompletion(canonical, ref);
    return { status: 'committed', ref };
  } catch {
    return { status: 'pending', ref };
  } finally { await release(); }
}

export async function commitDocumentTransaction(documentPath: string, ref: DocumentTransactionRef, operations: DocumentTransactionOperations = {}): Promise<DocumentTransactionResult> {
  return publish(documentPath, ref, false, operations);
}

/** Explicit roll-forward; foreign edits/locks cause a conflict or busy result. */
export async function recoverDocumentTransaction(documentPath: string, ref: DocumentTransactionRef, operations: DocumentTransactionOperations = {}): Promise<DocumentTransactionResult> {
  return publish(documentPath, ref, true, operations);
}

export async function listDocumentTransactions(documentPath: string): Promise<DocumentTransactionInventoryItem[]> {
  const canonical = await canonicalPath(documentPath);
  const base = `${path.basename(canonical)}.mermarkd-txn.`;
  const groups = new Map<string, string[]>();
  for (const name of await readdir(path.dirname(canonical))) {
    if (!name.startsWith(base)) continue;
    const id = name.slice(base.length, base.length + 36);
    if (!uuidPattern.test(id) || name[base.length + 36] !== '.') continue;
    groups.set(id, [...(groups.get(id) ?? []), path.join(path.dirname(canonical), name)]);
  }
  const items: DocumentTransactionInventoryItem[] = [];
  for (const [id, artifacts] of groups) {
    try {
      const bytes = await readBytes(journalPath(canonical, id), 16_384);
      if (!bytes) { items.push({ id, status: 'incomplete', artifacts }); continue; }
      const ref = { id, journalSha256: digest(bytes) };
      const { journal } = await loadTransaction(canonical, ref);
      const receipt = await readBytes(receiptPath(canonical, ref), 1024);
      const completed = receipt !== null && digest(receipt) === digest(receiptBytes(ref));
      const current = await states(canonical, journal);
      const status = kinds.some((kind) => current[kind] === 'conflict') ? 'conflict'
        : kinds.every((kind) => current[kind] === 'after') ? 'committed'
        : kinds.some((kind) => current[kind] === 'after' && journal.before[kind] !== journal.after[kind] || current[kind] === 'interrupted') ? 'interrupted' : 'prepared';
      items.push({ id, status, ref, artifacts, completed });
    } catch { items.push({ id, status: 'invalid', artifacts }); }
  }
  return items;
}

/** Read-only inspection, including when displacement left Markdown absent. */
export async function inspectDocumentTransaction(documentPath: string, ref: DocumentTransactionRef) {
  const canonical = await canonicalPath(documentPath);
  const loaded = await loadTransaction(canonical, ref);
  return { ...loaded, current: await states(canonical, loaded.journal) };
}
