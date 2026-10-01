import { extractSections } from './sections.ts';
import { buildSelectionMap, resolveStoredHighlight, type SelectionMap } from './selection-map.ts';
import type { AnnotationAnchor, AnnotationSidecar } from './annotations.ts';
import type { AnnotationRelocationSource } from './annotation-relocation.ts';
import { previewSectionTransform, type ReadySectionTransformPreview } from './section-transform.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const exactDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const sha256Pattern = /^[0-9a-f]{64}$/;
const utcTimestampPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;

export interface MarkdownEditPatch {
  /** Half-open range replaced in the persisted source, including the BOM in byte coordinates. */
  readonly beforeStartByte: number;
  readonly beforeEndByte: number;
  /** Half-open replacement range in the saved source, including the BOM in byte coordinates. */
  readonly afterStartByte: number;
  readonly afterEndByte: number;
}

export type AnnotationEditMapReason =
  | 'basis-mismatch'
  | 'current-range-mismatch'
  | 'edit-overlap'
  | 'rendered-range-unresolved'
  | 'target-range-collision';

export type AnnotationEditMapItemResult =
  | { readonly id: string; readonly status: 'unchanged' | 'mapped' }
  | { readonly id: string; readonly status: 'unresolved'; readonly reason: AnnotationEditMapReason };

export interface AnnotationEditMapping {
  readonly model: AnnotationSidecar;
  readonly patch: MarkdownEditPatch;
  readonly changed: boolean;
  readonly mappedCount: number;
  readonly unresolvedCount: number;
  readonly items: readonly AnnotationEditMapItemResult[];
}

interface PreparedSource extends AnnotationRelocationSource {
  readonly bytes: Uint8Array;
  readonly bomByteLength: 0 | 3;
  readonly sections: ReturnType<typeof extractSections>['sections'];
  readonly selectionMap: SelectionMap;
}

type AnchorMapResult =
  | { readonly status: 'unchanged' | 'mapped'; readonly anchor: AnnotationAnchor }
  | { readonly status: 'unresolved'; readonly anchor: AnnotationAnchor; readonly reason: AnnotationEditMapReason };

function invalid(message: string): never {
  throw new Error(`无法映射编辑后的批注：${message}`);
}

function hashHex(bytes: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return globalThis.crypto.subtle.digest('SHA-256', copy).then((digest) =>
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''));
}

async function prepareSource(source: AnnotationRelocationSource): Promise<PreparedSource> {
  if (!sha256Pattern.test(source.sha256)) invalid('原文摘要无效。');
  const bytes = Uint8Array.from(source.bytes);
  let content: string;
  try {
    content = decoder.decode(bytes);
  } catch {
    invalid('原文不是有效的 UTF-8。');
  }
  if (content !== source.content) invalid('原文字节与文本视图不一致。');
  if (await hashHex(bytes) !== source.sha256) invalid('原文摘要与字节不一致。');
  const bomByteLength: 0 | 3 = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return {
    bytes,
    content,
    sha256: source.sha256,
    bomByteLength,
    sections: extractSections(content).sections,
    selectionMap: buildSelectionMap(content, bomByteLength),
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function unsafeBoundary(content: string, offset: number): boolean {
  if (offset <= 0 || offset >= content.length) return false;
  return (
    isHighSurrogate(content.charCodeAt(offset - 1)) && isLowSurrogate(content.charCodeAt(offset))
  ) || (content[offset - 1] === '\r' && content[offset] === '\n');
}

function commonPrefixLength(before: string, after: string): number {
  const limit = Math.min(before.length, after.length);
  let length = 0;
  while (length < limit && before.charCodeAt(length) === after.charCodeAt(length)) length += 1;
  while (length > 0 && (unsafeBoundary(before, length) || unsafeBoundary(after, length))) length -= 1;
  return length;
}

function commonSuffixLength(before: string, after: string): number {
  let length = 0;
  while (
    length < before.length &&
    length < after.length &&
    before.charCodeAt(before.length - length - 1) === after.charCodeAt(after.length - length - 1)
  ) {
    length += 1;
  }
  while (length > 0 && (
    unsafeBoundary(before, before.length - length) ||
    unsafeBoundary(after, after.length - length)
  )) {
    length -= 1;
  }
  return length;
}

function byteOffset(content: string, bomByteLength: 0 | 3, utf16Offset: number): number {
  return bomByteLength + encoder.encode(content.slice(0, utf16Offset)).byteLength;
}

function derivePatch(before: PreparedSource, after: PreparedSource): MarkdownEditPatch {
  if (before.bomByteLength !== after.bomByteLength) invalid('普通编辑不能改变 UTF-8 BOM。');
  if (before.content === after.content) {
    const end = byteOffset(before.content, before.bomByteLength, before.content.length);
    return { beforeStartByte: end, beforeEndByte: end, afterStartByte: end, afterEndByte: end };
  }
  const prefixLength = commonPrefixLength(before.content, after.content);
  const suffixLength = commonSuffixLength(before.content, after.content);
  const unchangedLength = Math.min(
    prefixLength + suffixLength,
    Math.min(before.content.length, after.content.length),
  );
  // A repeated region can admit several equally small splices. For example,
  // deleting either copy from `AA` produces `A`. The renderer did not provide
  // an authoritative edit range, so take the union of every minimal alignment
  // instead of guessing which copy survived.
  let earliestStart = Math.max(0, unchangedLength - suffixLength);
  let latestStart = Math.min(prefixLength, unchangedLength);
  const beforeChangedLength = before.content.length - unchangedLength;
  const afterChangedLength = after.content.length - unchangedLength;
  while (earliestStart > 0 && (
    unsafeBoundary(before.content, earliestStart) || unsafeBoundary(after.content, earliestStart)
  )) earliestStart -= 1;
  let beforeLatestEnd = latestStart + beforeChangedLength;
  let afterLatestEnd = latestStart + afterChangedLength;
  while (
    (beforeLatestEnd < before.content.length && unsafeBoundary(before.content, beforeLatestEnd)) ||
    (afterLatestEnd < after.content.length && unsafeBoundary(after.content, afterLatestEnd))
  ) {
    latestStart += 1;
    beforeLatestEnd = latestStart + beforeChangedLength;
    afterLatestEnd = latestStart + afterChangedLength;
  }
  return {
    beforeStartByte: byteOffset(before.content, before.bomByteLength, earliestStart),
    beforeEndByte: byteOffset(before.content, before.bomByteLength, beforeLatestEnd),
    afterStartByte: byteOffset(after.content, after.bomByteLength, earliestStart),
    afterEndByte: byteOffset(after.content, after.bomByteLength, afterLatestEnd),
  };
}

function exactRangeMatches(anchor: AnnotationAnchor, source: PreparedSource): boolean {
  if (
    !Number.isSafeInteger(anchor.startByte) ||
    !Number.isSafeInteger(anchor.endByte) ||
    anchor.startByte < source.bomByteLength ||
    anchor.endByte <= anchor.startByte ||
    anchor.endByte > source.bytes.byteLength
  ) return false;
  try {
    const exact = exactDecoder.decode(source.bytes.subarray(anchor.startByte, anchor.endByte));
    return exact === anchor.sourceExact && encoder.encode(exact).byteLength === anchor.endByte - anchor.startByte;
  } catch {
    return false;
  }
}

function utf16OffsetAtByte(source: PreparedSource, byteOffsetValue: number): number | null {
  if (byteOffsetValue < source.bomByteLength || byteOffsetValue > source.bytes.byteLength) return null;
  try {
    return exactDecoder.decode(source.bytes.subarray(source.bomByteLength, byteOffsetValue)).length;
  } catch {
    return null;
  }
}

function context(content: string, start: number, end: number): { prefix: string; suffix: string } {
  return {
    prefix: Array.from(content.slice(0, start)).slice(-48).join(''),
    suffix: Array.from(content.slice(end)).slice(0, 48).join(''),
  };
}

function sectionAt(source: PreparedSource, start: number, end: number): string | undefined {
  return source.sections
    .filter((section) => section.headingRange.start <= start && section.subtreeRange.end >= end)
    .sort((left, right) => right.depth - left.depth || right.headingRange.start - left.headingRange.start)[0]
    ?.title || undefined;
}

function mapAnchor(
  anchor: AnnotationAnchor,
  before: PreparedSource,
  after: PreparedSource,
  patch: MarkdownEditPatch,
  preservedSpans?: ReadySectionTransformPreview['preservedSpans'],
): AnchorMapResult {
  if (anchor.basisSha256 === after.sha256) {
    if (!exactRangeMatches(anchor, after)) {
      return { status: 'unresolved', anchor, reason: 'current-range-mismatch' };
    }
    return resolveStoredHighlight(after.selectionMap, anchor).ok
      ? { status: 'unchanged', anchor }
      : { status: 'unresolved', anchor, reason: 'rendered-range-unresolved' };
  }
  if (anchor.basisSha256 !== before.sha256) {
    return { status: 'unresolved', anchor, reason: 'basis-mismatch' };
  }
  if (!exactRangeMatches(anchor, before)) {
    return { status: 'unresolved', anchor, reason: 'current-range-mismatch' };
  }
  if (!resolveStoredHighlight(before.selectionMap, anchor).ok) {
    return { status: 'unresolved', anchor, reason: 'rendered-range-unresolved' };
  }

  let startByte: number;
  let endByte: number;
  if (preservedSpans) {
    const start = utf16OffsetAtByte(before, anchor.startByte);
    const end = utf16OffsetAtByte(before, anchor.endByte);
    const span = start === null || end === null ? undefined : preservedSpans.find((entry) =>
      entry.before.start <= start && end <= entry.before.end);
    if (!span || start === null || end === null) return { status: 'unresolved', anchor, reason: 'edit-overlap' };
    startByte = byteOffset(after.content, after.bomByteLength, span.after.start + start - span.before.start);
    endByte = byteOffset(after.content, after.bomByteLength, span.after.start + end - span.before.start);
  } else if (anchor.endByte <= patch.beforeStartByte) {
    startByte = anchor.startByte;
    endByte = anchor.endByte;
  } else if (anchor.startByte >= patch.beforeEndByte) {
    const shift = patch.afterEndByte - patch.beforeEndByte;
    startByte = anchor.startByte + shift;
    endByte = anchor.endByte + shift;
  } else {
    return { status: 'unresolved', anchor, reason: 'edit-overlap' };
  }

  const start = utf16OffsetAtByte(after, startByte);
  const end = utf16OffsetAtByte(after, endByte);
  if (start === null || end === null || end <= start) {
    return { status: 'unresolved', anchor, reason: 'current-range-mismatch' };
  }
  const nearby = context(after.content, start, end);
  const sectionHint = sectionAt(after, start, end);
  const mapped: AnnotationAnchor = {
    ...anchor,
    basisSha256: after.sha256,
    startByte,
    endByte,
    prefix: nearby.prefix,
    suffix: nearby.suffix,
    ...(sectionHint ? { sectionHint } : { sectionHint: undefined }),
  };
  if (!exactRangeMatches(mapped, after)) {
    return { status: 'unresolved', anchor, reason: 'current-range-mismatch' };
  }
  if (!resolveStoredHighlight(after.selectionMap, mapped).ok) {
    return { status: 'unresolved', anchor, reason: 'rendered-range-unresolved' };
  }
  return { status: 'mapped', anchor: mapped };
}

function rejectRangeCollisions(
  results: readonly AnchorMapResult[],
  originalAnchors: readonly AnnotationAnchor[],
): AnchorMapResult[] {
  const occupied = new Map<string, number[]>();
  results.forEach((result, index) => {
    if (result.status === 'unresolved') return;
    const key = `${result.anchor.startByte}:${result.anchor.endByte}`;
    const indexes = occupied.get(key);
    if (indexes) indexes.push(index);
    else occupied.set(key, [index]);
  });
  const collided = new Set<number>();
  for (const indexes of occupied.values()) {
    if (indexes.length < 2) continue;
    for (const index of indexes) if (results[index].status === 'mapped') collided.add(index);
  }
  return results.map((result, index) => collided.has(index) && result.status === 'mapped'
    ? { status: 'unresolved', anchor: originalAnchors[index], reason: 'target-range-collision' }
    : result);
}

function validTimestamp(value: string): boolean {
  return utcTimestampPattern.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}

/**
 * Map anchors through the exact source transition produced by an in-app edit.
 * One conservative replacement span is derived from the longest shared prefix
 * and suffix. Anchors outside that span move deterministically; intersecting or
 * differently based anchors retain their old coordinates for later review.
 */
export async function mapAnnotationSidecarThroughEdit(
  sidecar: AnnotationSidecar,
  beforeSource: AnnotationRelocationSource,
  afterSource: AnnotationRelocationSource,
  mappedAt: string,
  structuralPreview?: ReadySectionTransformPreview,
): Promise<AnnotationEditMapping> {
  if (!validTimestamp(mappedAt)) invalid('映射时间无效。');
  const [before, after] = await Promise.all([prepareSource(beforeSource), prepareSource(afterSource)]);
  if (before.sha256 === after.sha256 && before.content !== after.content) invalid('相同摘要对应了不同源码。');
  if (sidecar.source.sha256 !== before.sha256) invalid('批注文件未绑定保存前的 Markdown。');
  const patch = derivePatch(before, after);
  let spans: ReadySectionTransformPreview['preservedSpans'] | undefined;
  if (structuralPreview) {
    const verified = previewSectionTransform(before.content, structuralPreview.operation);
    if (verified.status !== 'ready' || verified.candidate !== after.content ||
      structuralPreview.source !== before.content || structuralPreview.candidate !== after.content ||
      JSON.stringify(structuralPreview.sectionOrder) !== JSON.stringify(verified.sectionOrder)) invalid('结构预览已过期。');
    spans = verified.preservedSpans;
  }
  const initial = sidecar.annotations.map((annotation) => mapAnchor(annotation.anchor, before, after, patch, spans));
  const results = rejectRangeCollisions(initial, sidecar.annotations.map((annotation) => annotation.anchor));

  for (let index = 0; index < results.length; index += 1) {
    if (results[index].status === 'mapped' && Date.parse(mappedAt) < Date.parse(sidecar.annotations[index].updatedAt)) {
      invalid('映射时间早于批注现有更新时间。');
    }
  }

  let mappedCount = 0;
  let unresolvedCount = 0;
  const annotations = sidecar.annotations.map((annotation, index) => {
    const result = results[index];
    if (result.status === 'mapped') {
      mappedCount += 1;
      return { ...annotation, anchor: result.anchor, updatedAt: mappedAt };
    }
    if (result.status === 'unresolved') unresolvedCount += 1;
    return annotation;
  });
  const sourceChanged = sidecar.source.sha256 !== after.sha256;
  const changed = sourceChanged || mappedCount > 0;
  return {
    model: changed ? {
      ...sidecar,
      source: { ...sidecar.source, sha256: after.sha256 },
      annotations,
    } : sidecar,
    patch,
    changed,
    mappedCount,
    unresolvedCount,
    items: sidecar.annotations.map((annotation, index) => {
      const result = results[index];
      return result.status === 'unresolved'
        ? { id: annotation.id, status: result.status, reason: result.reason }
        : { id: annotation.id, status: result.status };
    }),
  };
}
