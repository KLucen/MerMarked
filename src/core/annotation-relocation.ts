import { extractSections } from './sections.ts';
import { buildSelectionMap, resolveStoredHighlight, type SelectionMap } from './selection-map.ts';
import type { AnnotationAnchor, AnnotationSidecar } from './annotations';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const sha256Pattern = /^[0-9a-f]{64}$/;
const utcTimestampPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;

export interface AnnotationRelocationSource {
  /** Complete file bytes, including an optional UTF-8 BOM. */
  readonly bytes: Uint8Array;
  /** The decoded Markdown view. A leading UTF-8 BOM is not included. */
  readonly content: string;
  /** SHA-256 of `bytes`. */
  readonly sha256: string;
}

export type AnnotationRelocationReason =
  | 'current-range-mismatch'
  | 'source-exact-missing'
  | 'source-exact-repeated'
  | 'context-mismatch'
  | 'rendered-range-unresolved'
  | 'target-range-collision';

export type AnnotationAnchorRelocation =
  | { readonly status: 'unchanged'; readonly anchor: AnnotationAnchor }
  | { readonly status: 'relocated'; readonly anchor: AnnotationAnchor }
  | {
      readonly status: 'unresolved';
      readonly anchor: AnnotationAnchor;
      readonly reason: AnnotationRelocationReason;
    };

export type AnnotationRelocationItemResult =
  | { readonly id: string; readonly status: 'unchanged' | 'relocated' }
  | { readonly id: string; readonly status: 'unresolved'; readonly reason: AnnotationRelocationReason };

export interface AnnotationSidecarRelocation {
  readonly model: AnnotationSidecar;
  readonly changed: boolean;
  readonly relocatedCount: number;
  readonly unresolvedCount: number;
  readonly items: readonly AnnotationRelocationItemResult[];
}

interface PreparedSource extends AnnotationRelocationSource {
  readonly bytes: Uint8Array;
  readonly bomByteLength: 0 | 3;
  readonly sections: ReturnType<typeof extractSections>['sections'];
  readonly selectionMap: SelectionMap;
}

function invalidSource(message: string): never {
  throw new Error(`无法重定位批注：${message}`);
}

function hashHex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return globalThis.crypto.subtle.digest('SHA-256', buffer).then((digest) =>
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''));
}

async function prepareSource(source: AnnotationRelocationSource): Promise<PreparedSource> {
  if (!sha256Pattern.test(source.sha256)) invalidSource('当前原文摘要无效。');

  // Freeze the caller-owned view before the asynchronous digest so all derived values
  // refer to one immutable byte snapshot.
  const bytes = Uint8Array.from(source.bytes);
  let decoded: string;
  try {
    // TextDecoder removes one leading UTF-8 BOM from its string view.
    decoded = decoder.decode(bytes);
  } catch {
    invalidSource('当前原文不是有效的 UTF-8。');
  }
  if (decoded !== source.content) invalidSource('当前原文字节与文本视图不一致。');

  const actualSha256 = await hashHex(bytes);
  if (actualSha256 !== source.sha256) invalidSource('当前原文摘要与字节不一致。');

  return {
    bytes,
    content: source.content,
    sha256: source.sha256,
    bomByteLength: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0,
    sections: extractSections(source.content).sections,
    selectionMap: buildSelectionMap(
      source.content,
      bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0,
    ),
  };
}

function exactRangeMatches(anchor: AnnotationAnchor, source: PreparedSource): boolean {
  if (
    !Number.isSafeInteger(anchor.startByte) ||
    !Number.isSafeInteger(anchor.endByte) ||
    anchor.startByte < source.bomByteLength ||
    anchor.endByte <= anchor.startByte ||
    anchor.endByte > source.bytes.length
  ) {
    return false;
  }
  try {
    const exact = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(source.bytes.subarray(anchor.startByte, anchor.endByte));
    return exact === anchor.sourceExact &&
      encoder.encode(exact).length === anchor.endByte - anchor.startByte;
  } catch {
    return false;
  }
}

function firstOccurrences(content: string, exact: string): number[] {
  if (!exact) return [];
  const offsets: number[] = [];
  for (let from = 0; from <= content.length;) {
    const offset = content.indexOf(exact, from);
    if (offset < 0) break;
    offsets.push(offset);
    if (offsets.length === 2) break;
    // Advance one UTF-16 code unit so overlapping occurrences also make a
    // candidate ambiguous. A valid exact match itself still starts and ends on
    // Unicode scalar boundaries because both strings came from valid UTF-8.
    from = offset + 1;
  }
  return offsets;
}

function context(content: string, start: number, end: number): { prefix: string; suffix: string } {
  return {
    prefix: Array.from(content.slice(0, start)).slice(-48).join(''),
    suffix: Array.from(content.slice(end)).slice(0, 48).join(''),
  };
}

function sectionAt(source: PreparedSource, start: number, end: number): string | undefined {
  const containing = source.sections
    .filter((section) => section.headingRange.start <= start && section.subtreeRange.end >= end)
    .sort((left, right) => right.depth - left.depth || right.headingRange.start - left.headingRange.start)[0];
  return containing?.title || undefined;
}

function hasHighConfidenceContext(
  anchor: AnnotationAnchor,
  content: string,
  start: number,
  end: number,
): boolean {
  const prefixMatches = anchor.prefix.length === 0
    ? start === 0
    : content.slice(0, start).endsWith(anchor.prefix);
  const suffixMatches = anchor.suffix.length === 0
    ? end === content.length
    : content.slice(end).startsWith(anchor.suffix);

  // Both original sides must still meet the candidate. A file boundary is a
  // side too, so an empty prefix only matches byte zero and an empty suffix only
  // matches EOF. Section titles are useful metadata but never repair a missing
  // adjacent context: the original may have been deleted while a copy remained
  // under the same heading.
  return prefixMatches && suffixMatches;
}

function byteOffset(content: string, bomByteLength: 0 | 3, utf16Offset: number): number {
  return bomByteLength + encoder.encode(content.slice(0, utf16Offset)).length;
}

function relocatePrepared(anchor: AnnotationAnchor, source: PreparedSource): AnnotationAnchorRelocation {
  if (anchor.basisSha256 === source.sha256) {
    if (!exactRangeMatches(anchor, source)) {
      return { status: 'unresolved', anchor, reason: 'current-range-mismatch' };
    }
    return resolveStoredHighlight(source.selectionMap, anchor).ok
      ? { status: 'unchanged', anchor }
      : { status: 'unresolved', anchor, reason: 'rendered-range-unresolved' };
  }

  const candidates = firstOccurrences(source.content, anchor.sourceExact);
  if (candidates.length === 0) {
    return { status: 'unresolved', anchor, reason: 'source-exact-missing' };
  }
  // Never use an old offset to break a tie. A copied or intrinsically repeated
  // exact source is left for explicit reattachment even if one context looks better.
  if (candidates.length !== 1) {
    return { status: 'unresolved', anchor, reason: 'source-exact-repeated' };
  }

  const start = candidates[0];
  const end = start + anchor.sourceExact.length;
  const currentSection = sectionAt(source, start, end);
  if (!hasHighConfidenceContext(anchor, source.content, start, end)) {
    return { status: 'unresolved', anchor, reason: 'context-mismatch' };
  }

  const newContext = context(source.content, start, end);
  const relocated: AnnotationAnchor = {
    basisSha256: source.sha256,
    startByte: byteOffset(source.content, source.bomByteLength, start),
    endByte: byteOffset(source.content, source.bomByteLength, end),
    sourceExact: anchor.sourceExact,
    prefix: newContext.prefix,
    suffix: newContext.suffix,
    displayQuote: anchor.displayQuote,
    ...(currentSection ? { sectionHint: currentSection } : {}),
  };
  if (!resolveStoredHighlight(source.selectionMap, relocated).ok) {
    return { status: 'unresolved', anchor, reason: 'rendered-range-unresolved' };
  }
  return { status: 'relocated', anchor: relocated };
}

function rejectRangeCollisions(
  results: readonly AnnotationAnchorRelocation[],
  originalAnchors: readonly AnnotationAnchor[],
): AnnotationAnchorRelocation[] {
  const occupied = new Map<string, number[]>();
  results.forEach((result, index) => {
    if (result.status === 'unresolved') return;
    const key = `${result.anchor.startByte}:${result.anchor.endByte}`;
    const indexes = occupied.get(key);
    if (indexes) indexes.push(index);
    else occupied.set(key, [index]);
  });

  const collidedRelocations = new Set<number>();
  for (const indexes of occupied.values()) {
    if (indexes.length < 2) continue;
    for (const index of indexes) {
      if (results[index].status === 'relocated') collidedRelocations.add(index);
    }
  }
  return results.map((result, index) => collidedRelocations.has(index) && result.status === 'relocated'
    ? { status: 'unresolved', anchor: originalAnchors[index], reason: 'target-range-collision' }
    : result);
}

/**
 * Conservatively relocate one anchor against an immutable current source.
 * This function never ranks candidates by their old position.
 */
export async function relocateAnnotationAnchor(
  anchor: AnnotationAnchor,
  currentSource: AnnotationRelocationSource,
): Promise<AnnotationAnchorRelocation> {
  return relocatePrepared(anchor, await prepareSource(currentSource));
}

function validTimestamp(value: string): boolean {
  return utcTimestampPattern.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}

/**
 * Build a sidecar candidate for the new source without mutating the input.
 * The top-level source hash records the last checked document. Unresolved
 * records intentionally retain their older per-anchor basis hash, so a mixed
 * sidecar remains explicit and cannot make a stale byte range look current.
 */
export async function relocateAnnotationSidecarCandidate(
  sidecar: AnnotationSidecar,
  currentSource: AnnotationRelocationSource,
  relocatedAt: string,
): Promise<AnnotationSidecarRelocation> {
  if (!validTimestamp(relocatedAt)) invalidSource('重定位时间无效。');
  const source = await prepareSource(currentSource);
  const initialResults = sidecar.annotations.map((annotation) => relocatePrepared(annotation.anchor, source));
  const results = rejectRangeCollisions(initialResults, sidecar.annotations.map((annotation) => annotation.anchor));

  for (let index = 0; index < results.length; index += 1) {
    if (results[index].status === 'relocated' &&
        Date.parse(relocatedAt) < Date.parse(sidecar.annotations[index].updatedAt)) {
      invalidSource('重定位时间早于批注现有更新时间。');
    }
  }

  let relocatedCount = 0;
  let unresolvedCount = 0;
  const annotations = sidecar.annotations.map((annotation, index) => {
    const result = results[index];
    if (result.status === 'relocated') {
      relocatedCount += 1;
      return { ...annotation, anchor: result.anchor, updatedAt: relocatedAt };
    }
    if (result.status === 'unresolved') unresolvedCount += 1;
    return annotation;
  });
  const sourceChanged = sidecar.source.sha256 !== source.sha256;
  const changed = sourceChanged || relocatedCount > 0;

  return {
    model: changed ? {
      ...sidecar,
      source: { ...sidecar.source, sha256: source.sha256 },
      annotations,
    } : sidecar,
    changed,
    relocatedCount,
    unresolvedCount,
    items: sidecar.annotations.map((annotation, index) => {
      const result = results[index];
      return result.status === 'unresolved'
        ? { id: annotation.id, status: result.status, reason: result.reason }
        : { id: annotation.id, status: result.status };
    }),
  };
}
