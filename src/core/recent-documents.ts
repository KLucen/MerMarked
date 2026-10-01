/**
 * A small, renderer-safe model for the workspace's recent Markdown files.
 *
 * The model deliberately stores no display name, file metadata, or existence
 * bit. Callers decide whether a path is still usable before presenting it.
 */

export interface RecentDocument {
  /** An absolute path supplied by the document opener. */
  readonly path: string;
  /** Unix epoch time in milliseconds when the document was opened. */
  readonly openedAt: number;
}

export interface RecentDocumentsOptions {
  /** Maximum number of records returned by normalization and recording. */
  readonly maxEntries?: number;
}

export const DEFAULT_RECENT_DOCUMENT_LIMIT = 12;
/** A corrupted preference file must not be able to allocate an unbounded list. */
export const MAX_RECENT_DOCUMENT_LIMIT = 1000;

const encoder = new TextEncoder();
const windowsDrivePath = /^[A-Za-z]:[\\/]/u;
const windowsUncPath = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u;

function invalid(message = '最近文件记录无效。'): never {
  throw new Error(message);
}

function isWindowsPath(value: string): boolean {
  return windowsDrivePath.test(value) || windowsUncPath.test(value);
}

/**
 * Checks only lexical absoluteness. Existence and Markdown extension checks
 * belong to the caller that has access to the filesystem.
 */
export function isAbsoluteDocumentPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false;
  return value.startsWith('/') || windowsDrivePath.test(value) || windowsUncPath.test(value);
}

function validatePath(value: unknown): string {
  if (!isAbsoluteDocumentPath(value)) invalid('最近文件路径必须是绝对路径。');
  // TextEncoder rejects neither lone surrogates nor malformed UTF-16, so use a
  // strict round trip to avoid persisting strings JSON cannot represent safely.
  const text = value as string;
  if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(encoder.encode(text)) !== text) {
    invalid('最近文件路径不是有效的 Unicode 文本。');
  }
  return text;
}

function validateOpenedAt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid('最近文件打开时间无效。');
  }
  return value;
}

function maxEntries(options: RecentDocumentsOptions | undefined): number {
  const value = options?.maxEntries ?? DEFAULT_RECENT_DOCUMENT_LIMIT;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_RECENT_DOCUMENT_LIMIT) {
    invalid('最近文件记录上限无效。');
  }
  return value;
}

/**
 * Produces a stable identity key without resolving symlinks or touching disk.
 * Windows drive and UNC paths are case-insensitive; POSIX paths retain case.
 */
function pathKey(value: string): string {
  if (!isWindowsPath(value)) return value;
  let key = value.replace(/\//gu, '\\');
  if (key.startsWith('\\\\')) {
    key = `\\\\${key.slice(2).replace(/\\{2,}/gu, '\\')}`;
  } else {
    key = key.replace(/\\{2,}/gu, '\\');
  }
  // A trailing separator does not distinguish a file path identity. Preserve
  // the root separator so C:\\ and C: are never treated as equal.
  if (key.length > 3 && key.endsWith('\\')) key = key.slice(0, -1);
  return key.toLocaleLowerCase('en-US');
}

function clone(record: RecentDocument): RecentDocument {
  return { path: record.path, openedAt: record.openedAt };
}

/**
 * Validates, de-duplicates, sorts newest-first, and applies the configured
 * limit. Equal timestamps retain their first-seen order (stable sorting).
 */
export function normalizeRecentDocuments(
  entries: readonly RecentDocument[],
  options?: RecentDocumentsOptions,
): RecentDocument[] {
  if (!Array.isArray(entries)) invalid();
  const limit = maxEntries(options);
  const byPath = new Map<string, { record: RecentDocument; order: number }>();
  entries.forEach((entry, order) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      Object.keys(entry).length !== 2 || !Object.hasOwn(entry, 'path') || !Object.hasOwn(entry, 'openedAt')) {
      invalid();
    }
    const record: RecentDocument = {
      path: validatePath(entry.path),
      openedAt: validateOpenedAt(entry.openedAt),
    };
    const key = pathKey(record.path);
    const previous = byPath.get(key);
    // Keep the newest observation. On a timestamp tie retain the earlier
    // record, making normalization deterministic and stable.
    if (!previous || record.openedAt > previous.record.openedAt) byPath.set(key, { record, order });
  });
  return [...byPath.values()]
    .sort((left, right) => right.record.openedAt - left.record.openedAt || left.order - right.order)
    .slice(0, limit)
    .map(({ record }) => clone(record));
}

/** Records a document as most recently opened without touching the filesystem. */
export function recordRecentDocument(
  entries: readonly RecentDocument[],
  path: string,
  openedAt = Date.now(),
  options?: RecentDocumentsOptions,
): RecentDocument[] {
  const documentPath = validatePath(path);
  const timestamp = validateOpenedAt(openedAt);
  return normalizeRecentDocuments([...entries, { path: documentPath, openedAt: timestamp }], options);
}

/** Alias useful at call sites that model the list as an append-only preference. */
export const addRecentDocument = recordRecentDocument;

/** Removes one path by the same lexical identity used for de-duplication. */
export function removeRecentDocument(
  entries: readonly RecentDocument[],
  path: string,
  options?: RecentDocumentsOptions,
): RecentDocument[] {
  const key = pathKey(validatePath(path));
  return normalizeRecentDocuments(entries, options).filter((entry) => pathKey(entry.path) !== key);
}

/**
 * Applies a caller-owned availability check. This function never calls fs or
 * attempts to resolve symlinks; unavailable paths can therefore be removed or
 * merely hidden according to the caller's product policy.
 */
export function filterRecentDocuments(
  entries: readonly RecentDocument[],
  predicate: (entry: RecentDocument) => boolean,
  options?: RecentDocumentsOptions,
): RecentDocument[] {
  if (typeof predicate !== 'function') invalid('最近文件过滤器无效。');
  return normalizeRecentDocuments(entries, options).filter((entry) => predicate(entry));
}

/** Strict JSON persistence containing only path and openedAt for each entry. */
export function serializeRecentDocuments(
  entries: readonly RecentDocument[],
  options?: RecentDocumentsOptions,
): string {
  const normalized = normalizeRecentDocuments(entries, options);
  const serialized = `${JSON.stringify(normalized)}\n`;
  if (encoder.encode(serialized).length > 256 * 1024) invalid('最近文件记录过大。');
  return serialized;
}

export function parseRecentDocuments(
  serialized: string,
  options?: RecentDocumentsOptions,
): RecentDocument[] {
  if (typeof serialized !== 'string' || encoder.encode(serialized).length > 256 * 1024) invalid();
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { invalid('最近文件记录不是有效 JSON。'); }
  if (!Array.isArray(value)) invalid();
  return normalizeRecentDocuments(value, options);
}
