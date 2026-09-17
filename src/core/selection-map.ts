import type { Heading, Paragraph, PhrasingContent, Root } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

interface TextLeaf {
  readonly visibleStart: number;
  readonly visibleEnd: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly exact: boolean;
  readonly commonPrefix: number;
  readonly commonSuffix: number;
}

export interface SelectionBlock {
  /** UTF-16 offset in the BOM-stripped Markdown passed to the parser. */
  readonly blockStart: number;
  readonly visibleText: string;
  readonly supported: boolean;
  readonly reason?: string;
  readonly leaves: readonly TextLeaf[];
}

export interface SelectionMap {
  readonly blocks: readonly SelectionBlock[];
  /** Decoded source without a leading UTF-8 BOM; line endings are unchanged. */
  readonly source: string;
  readonly bomByteLength: 0 | 3;
}

export type SelectionResolution =
  | {
      readonly ok: true;
      /** Half-open UTF-8 byte range in the original file, including BOM bytes. */
      readonly startByte: number;
      readonly endByte: number;
      /** Original Markdown syntax between the selected visible characters. */
      readonly sourceExact: string;
      readonly displayQuote: string;
    }
  | { readonly ok: false; readonly reason: string };

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, 'yaml');
const encoder = new TextEncoder();
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function commonEdges(raw: string, value: string): { prefix: number; suffix: number } {
  let prefix = 0;
  while (prefix < raw.length && prefix < value.length && raw[prefix] === value[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < raw.length - prefix &&
    suffix < value.length - prefix &&
    raw[raw.length - 1 - suffix] === value[value.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return { prefix, suffix };
}

function addTextLeaf(
  node: Extract<PhrasingContent, { type: 'text' }>,
  source: string,
  blockStart: number,
  blockEnd: number,
  visibleText: string,
  leaves: TextLeaf[],
): string | null {
  const sourceStart = node.position?.start.offset;
  const sourceEnd = node.position?.end.offset;
  if (
    sourceStart === undefined || sourceEnd === undefined ||
    sourceStart < blockStart || sourceEnd > blockEnd || sourceEnd < sourceStart ||
    node.value.length === 0
  ) {
    return '解析器未提供可用的原文位置。';
  }
  const raw = source.slice(sourceStart, sourceEnd);
  const { prefix, suffix } = commonEdges(raw, node.value);
  leaves.push({
    visibleStart: visibleText.length,
    visibleEnd: visibleText.length + node.value.length,
    sourceStart,
    sourceEnd,
    exact: raw === node.value,
    commonPrefix: prefix,
    commonSuffix: suffix,
  });
  return null;
}

function buildBlock(node: Heading | Paragraph, source: string): SelectionBlock {
  const blockStart = node.position?.start.offset;
  const blockEnd = node.position?.end.offset;
  if (blockStart === undefined || blockEnd === undefined) {
    return { blockStart: -1, visibleText: '', supported: false, reason: '解析器未提供块位置。', leaves: [] };
  }

  let visibleText = '';
  const leaves: TextLeaf[] = [];
  let reason: string | undefined;
  const visit = (inline: PhrasingContent): void => {
    if (reason) return;
    if (inline.type === 'text') {
      reason = addTextLeaf(inline, source, blockStart, blockEnd, visibleText, leaves) ?? undefined;
      if (!reason) visibleText += inline.value;
      return;
    }
    if (
      inline.type === 'emphasis' || inline.type === 'strong' ||
      inline.type === 'delete' || inline.type === 'link' || inline.type === 'linkReference'
    ) {
      inline.children.forEach(visit);
      return;
    }
    reason = `当前选区所在块包含暂不支持的 ${inline.type} 内容。`;
  };
  node.children.forEach(visit);
  return { blockStart, visibleText, supported: !reason && leaves.length > 0, reason, leaves };
}

/** Build a source map for rendered paragraphs and headings without changing Markdown. */
export function buildSelectionMap(content: string, bomByteLength: number): SelectionMap {
  if (bomByteLength !== 0 && bomByteLength !== 3) {
    throw new Error('无效的 UTF-8 BOM 长度。');
  }
  if (content.startsWith('\uFEFF') && bomByteLength !== 3) {
    throw new Error('正文和 BOM 元数据不一致。');
  }
  const source = content.startsWith('\uFEFF') ? content.slice(1) : content;
  const root = processor.parse(source) as Root;
  const blocks: SelectionBlock[] = [];
  const visit = (node: { type: string; children?: readonly unknown[] }): void => {
    if (node.type === 'heading' || node.type === 'paragraph') {
      blocks.push(buildBlock(node as Heading | Paragraph, source));
      return;
    }
    node.children?.forEach((child) => visit(child as { type: string; children?: readonly unknown[] }));
  };
  visit(root);
  return { blocks, source, bomByteLength };
}

function atGraphemeBoundary(text: string, offset: number): boolean {
  if (offset === 0 || offset === text.length) return true;
  for (const { index } of graphemeSegmenter.segment(text)) {
    if (index === offset) return true;
    if (index > offset) return false;
  }
  return false;
}

function sourceBoundary(leaf: TextLeaf, offset: number, side: 'start' | 'end'): number | null {
  const relative = offset - leaf.visibleStart;
  const length = leaf.visibleEnd - leaf.visibleStart;
  if (relative === 0 && side === 'start') return leaf.sourceStart;
  if (relative === length && side === 'end') return leaf.sourceEnd;
  if (leaf.exact || relative <= leaf.commonPrefix) return leaf.sourceStart + relative;
  if (relative >= length - leaf.commonSuffix) return leaf.sourceEnd - (length - relative);
  return null;
}

function cutsEncodedSource(leaf: TextLeaf, boundary: number, source: string): boolean {
  if (boundary <= leaf.sourceStart || boundary >= leaf.sourceEnd) return false;
  const raw = source.slice(leaf.sourceStart, leaf.sourceEnd);
  const relative = boundary - leaf.sourceStart;
  const encoded = /&(?:#(?:[xX][0-9a-fA-F]+|[0-9]+)|[A-Za-z][A-Za-z0-9]+);?|\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]|\r\n/g;
  for (const match of raw.matchAll(encoded)) {
    if (match.index < relative && relative < match.index + match[0].length) return true;
  }
  return false;
}

/** Resolve a nonempty selection in one rendered block to original file bytes. */
export function resolveSelection(
  map: SelectionMap,
  blockStart: number,
  visibleStart: number,
  visibleEnd: number,
): SelectionResolution {
  const block = map.blocks.find((entry) => entry.blockStart === blockStart);
  if (!block) return { ok: false, reason: '选区不在可映射的段落或标题内。' };
  if (!block.supported) return { ok: false, reason: block.reason ?? '当前块暂不支持精确映射。' };
  if (
    !Number.isInteger(visibleStart) || !Number.isInteger(visibleEnd) ||
    visibleStart < 0 || visibleEnd > block.visibleText.length || visibleStart >= visibleEnd
  ) {
    return { ok: false, reason: '选区范围无效或为空。' };
  }
  if (
    !atGraphemeBoundary(block.visibleText, visibleStart) ||
    !atGraphemeBoundary(block.visibleText, visibleEnd)
  ) {
    return { ok: false, reason: '选区边界落在组合字符内部。' };
  }
  if (/[\r\n]/.test(block.visibleText.slice(visibleStart, visibleEnd))) {
    return { ok: false, reason: '当前原型暂不支持包含软换行的选区。' };
  }

  const first = block.leaves.find((leaf) => leaf.visibleStart <= visibleStart && visibleStart < leaf.visibleEnd);
  const last = block.leaves.find((leaf) => leaf.visibleStart < visibleEnd && visibleEnd <= leaf.visibleEnd);
  if (!first || !last) return { ok: false, reason: '无法确定选区的源码边界。' };
  const sourceStart = sourceBoundary(first, visibleStart, 'start');
  const sourceEnd = sourceBoundary(last, visibleEnd, 'end');
  if (
    sourceStart === null || sourceEnd === null || sourceStart >= sourceEnd ||
    cutsEncodedSource(first, sourceStart, map.source) ||
    cutsEncodedSource(last, sourceEnd, map.source)
  ) {
    return { ok: false, reason: '选区包含无法精确定位的转义或实体边界。' };
  }
  return {
    ok: true,
    startByte: map.bomByteLength + encoder.encode(map.source.slice(0, sourceStart)).length,
    endByte: map.bomByteLength + encoder.encode(map.source.slice(0, sourceEnd)).length,
    sourceExact: map.source.slice(sourceStart, sourceEnd),
    displayQuote: block.visibleText.slice(visibleStart, visibleEnd),
  };
}
