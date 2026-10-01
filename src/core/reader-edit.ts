import { buildSelectionMap, resolveSelection } from './selection-map.ts';
import type { SelectionBlock, SelectionMap } from './selection-map.ts';

export interface ReaderPlainTextEdit {
  readonly blockStart: number;
  readonly sourceText: string;
  readonly replacement: string;
}

export type ReaderPlainTextEditResult =
  | {
      readonly ok: true;
      readonly content: string;
      /** UTF-16 offsets in the BOM-stripped source. */
      readonly sourceStart: number;
      readonly sourceEnd: number;
      readonly sourceExact: string;
    }
  | { readonly ok: false; readonly reason: string };

const encoder = new TextEncoder();

export function isReaderPlainTextBlock(map: SelectionMap, block: SelectionBlock): boolean {
  if (!block.supported) return false;
  const visibleText = block.visibleText;
  const blockSource = map.source.slice(block.blockStart, block.blockEnd);
  const plainBlockSource = block.kind === 'heading'
    ? blockSource
      .replace(/^ {0,3}#{1,6}[ \t]+/u, '')
      .replace(/[ \t]+#{1,}[ \t]*$/u, '')
    : blockSource;
  return plainBlockSource === visibleText && !/\r|\n/u.test(blockSource);
}

/** A reversible inline block has only exact text leaves and no line breaks. */
export function isReaderMappedTextBlock(map: SelectionMap, block: SelectionBlock): boolean {
  if (!block.supported || block.leaves.length === 0) return false;
  const sourceBlock = map.source.slice(block.blockStart, block.blockEnd);
  return !/[\r\n]/u.test(sourceBlock) && block.leaves.every((leaf) => leaf.exact);
}

/** Convert a UTF-8 byte offset to a UTF-16 offset without guessing inside a code point. */
function utf8ByteOffsetToUtf16(source: string, target: number): number | null {
  if (!Number.isSafeInteger(target) || target < 0) return null;
  let bytes = 0;
  for (let offset = 0; offset < source.length;) {
    if (bytes === target) return offset;
    const codePoint = source.codePointAt(offset);
    if (codePoint === undefined) return null;
    const value = String.fromCodePoint(codePoint);
    bytes += encoder.encode(value).length;
    offset += value.length;
    if (bytes > target) return null;
  }
  return bytes === target ? source.length : null;
}

/**
 * Apply one rendered paragraph/heading edit to its exact Markdown text span.
 *
 * This intentionally accepts only a block whose source text is byte-for-byte
 * the visible text. Inline Markdown syntax, entities, code, and line breaks
 * are rejected until a bidirectional mapping for those constructs exists.
 */
export function applyReaderPlainTextEdit(
  content: string,
  bomByteLength: number,
  edit: ReaderPlainTextEdit,
): ReaderPlainTextEditResult {
  if (typeof content !== 'string' || (bomByteLength !== 0 && bomByteLength !== 3)) {
    return { ok: false, reason: '阅读编辑的源文档或 BOM 信息无效。' };
  }
  if (content.startsWith('\uFEFF') !== (bomByteLength === 3)) {
    return { ok: false, reason: '正文和 BOM 元数据不一致。' };
  }
  if (!Number.isSafeInteger(edit.blockStart) || edit.blockStart < 0 ||
    typeof edit.sourceText !== 'string' || typeof edit.replacement !== 'string') {
    return { ok: false, reason: '阅读编辑范围无效。' };
  }
  if (/\r|\n/u.test(edit.replacement)) {
    return { ok: false, reason: '正文编辑暂只支持单行纯文本。' };
  }

  const map = (() => {
    try { return buildSelectionMap(content, bomByteLength); }
    catch { return null; }
  })();
  if (!map) return { ok: false, reason: '无法建立当前正文的安全映射。' };
  const block = map.blocks.find((candidate) => candidate.blockStart === edit.blockStart);
  if (!block || !block.supported) {
    return { ok: false, reason: block?.reason ?? '当前正文块暂不支持直接编辑。' };
  }
  if (block.visibleText !== edit.sourceText) {
    return { ok: false, reason: '正文块在编辑期间已变化，请重新聚焦后再试。' };
  }
  const visibleText = block.visibleText;
  const resolved = resolveSelection(map, block.blockStart, 0, visibleText.length);
  if (!resolved.ok || resolved.sourceExact !== resolved.displayQuote || !isReaderPlainTextBlock(map, block)) {
    return { ok: false, reason: '当前正文包含 Markdown 语法，暂不能安全直接编辑。' };
  }
  const sourceStart = utf8ByteOffsetToUtf16(map.source, resolved.startByte - bomByteLength);
  const sourceEnd = utf8ByteOffsetToUtf16(map.source, resolved.endByte - bomByteLength);
  if (sourceStart === null || sourceEnd === null || sourceEnd < sourceStart) {
    return { ok: false, reason: '无法确定正文在源码中的安全边界。' };
  }
  const nextSource = map.source.slice(0, sourceStart) + edit.replacement + map.source.slice(sourceEnd);
  const nextContent = bomByteLength === 3 ? `\uFEFF${nextSource}` : nextSource;
  return {
    ok: true,
    content: nextContent,
    sourceStart,
    sourceEnd,
    sourceExact: map.source.slice(sourceStart, sourceEnd),
  };
}

/**
 * Edit one visible text leaf while preserving surrounding Markdown syntax.
 * The changed visible range must stay inside one exact source leaf; this is
 * what keeps emphasis, links and other inline markers intact.
 */
export function applyReaderMappedTextEdit(
  content: string,
  bomByteLength: number,
  edit: ReaderPlainTextEdit,
): ReaderPlainTextEditResult {
  if (typeof content !== 'string' || (bomByteLength !== 0 && bomByteLength !== 3)) {
    return { ok: false, reason: '阅读编辑的源文档或 BOM 信息无效。' };
  }
  if (content.startsWith('\uFEFF') !== (bomByteLength === 3)) {
    return { ok: false, reason: '正文和 BOM 元数据不一致。' };
  }
  if (!Number.isSafeInteger(edit.blockStart) || edit.blockStart < 0 ||
    typeof edit.sourceText !== 'string' || typeof edit.replacement !== 'string') {
    return { ok: false, reason: '阅读编辑范围无效。' };
  }
  if (/[\r\n]/u.test(edit.replacement)) {
    return { ok: false, reason: '正文编辑暂只支持单行纯文本。' };
  }
  const map = (() => {
    try { return buildSelectionMap(content, bomByteLength); }
    catch { return null; }
  })();
  if (!map) return { ok: false, reason: '无法建立当前正文的安全映射。' };
  const block = map.blocks.find((candidate) => candidate.blockStart === edit.blockStart);
  if (!block || !isReaderMappedTextBlock(map, block)) {
    return { ok: false, reason: block?.reason ?? '当前正文包含无法安全保留的 Markdown 语法。' };
  }
  if (block.visibleText !== edit.sourceText) {
    return { ok: false, reason: '正文块在编辑期间已变化，请重新聚焦后再试。' };
  }
  if (block.visibleText === edit.replacement) {
    return { ok: true, content, sourceStart: block.blockStart, sourceEnd: block.blockEnd, sourceExact: map.source.slice(block.blockStart, block.blockEnd) };
  }

  let visibleStart = 0;
  const shared = Math.min(block.visibleText.length, edit.replacement.length);
  while (visibleStart < shared && block.visibleText[visibleStart] === edit.replacement[visibleStart]) visibleStart += 1;
  let visibleEnd = block.visibleText.length;
  let replacementEnd = edit.replacement.length;
  while (visibleEnd > visibleStart && replacementEnd > visibleStart &&
    block.visibleText[visibleEnd - 1] === edit.replacement[replacementEnd - 1]) {
    visibleEnd -= 1;
    replacementEnd -= 1;
  }
  const leaf = block.leaves.find((candidate) => candidate.visibleStart <= visibleStart && visibleEnd <= candidate.visibleEnd);
  if (!leaf) return { ok: false, reason: '阅读编辑不能跨越多个 Markdown 语法片段。' };

  let sourceStart: number;
  let sourceEnd: number;
  if (visibleStart === visibleEnd) {
    if (visibleStart < block.visibleText.length) {
      const boundary = resolveSelection(map, block.blockStart, visibleStart, visibleStart + 1);
      if (!boundary.ok) return { ok: false, reason: boundary.reason };
      sourceStart = boundary.sourceStart;
      sourceEnd = sourceStart;
    } else {
      const boundary = resolveSelection(map, block.blockStart, visibleStart - 1, visibleStart);
      if (!boundary.ok) return { ok: false, reason: boundary.reason };
      sourceStart = boundary.sourceEnd;
      sourceEnd = sourceStart;
    }
  } else {
    const boundary = resolveSelection(map, block.blockStart, visibleStart, visibleEnd);
    if (!boundary.ok) return { ok: false, reason: boundary.reason };
    if (boundary.sourceStart < leaf.sourceStart || boundary.sourceEnd > leaf.sourceEnd) {
      return { ok: false, reason: '阅读编辑不能跨越多个 Markdown 语法片段。' };
    }
    sourceStart = boundary.sourceStart;
    sourceEnd = boundary.sourceEnd;
  }
  const nextSource = map.source.slice(0, sourceStart) + edit.replacement.slice(visibleStart, replacementEnd) + map.source.slice(sourceEnd);
  const nextContent = bomByteLength === 3 ? `\uFEFF${nextSource}` : nextSource;
  return {
    ok: true,
    content: nextContent,
    sourceStart,
    sourceEnd,
    sourceExact: map.source.slice(sourceStart, sourceEnd),
  };
}
