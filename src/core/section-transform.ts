import type { Root, RootContent } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { extractSections, sectionFragmentIds } from './sections.ts';
import type { Section, SectionTree, SourceRange } from './sections.ts';

export type SectionTransformOperation =
  | { readonly kind: 'move'; readonly sourceIndex: number; readonly targetIndex: number }
  | { readonly kind: 'promote'; readonly sectionIndex: number; readonly targetDepth: number };

export type SectionTransformRejectionCode =
  | 'invalid-index' | 'same-section' | 'current-parent' | 'descendant-target'
  | 'invalid-depth' | 'depth-overflow' | 'unsupported-setext'
  | 'parse-failed' | 'candidate-mismatch' | 'unsafe-semantics';

export interface SectionTransformRejection {
  readonly code: SectionTransformRejectionCode;
  readonly message: string;
}

export interface ReadySectionTransformPreview {
  readonly status: 'ready';
  readonly operation: SectionTransformOperation;
  readonly source: string;
  readonly candidate: string;
  readonly sourceTree: SectionTree;
  readonly candidateTree: SectionTree;
  readonly changedRanges: readonly SourceRange[];
  /** Original section indexes in candidate order; suitable for identity mapping. */
  readonly sectionOrder: readonly number[];
  /** Exact, unchanged source spans and their candidate destinations (UTF-16). */
  readonly preservedSpans: readonly { readonly before: SourceRange; readonly after: SourceRange }[];
  readonly addedBoundaryLineEndings: number;
  readonly summary: string;
}

export interface RejectedSectionTransformPreview {
  readonly status: 'rejected' | 'noop';
  readonly operation: SectionTransformOperation;
  readonly source: string;
  readonly sourceTree: SectionTree;
  readonly rejection: SectionTransformRejection;
}

export type SectionTransformPreview = ReadySectionTransformPreview | RejectedSectionTransformPreview;

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, 'yaml');

function rejected(
  status: 'rejected' | 'noop', operation: SectionTransformOperation, source: string,
  sourceTree: SectionTree, code: SectionTransformRejectionCode, message: string,
): RejectedSectionTransformPreview {
  return { status, operation, source, sourceTree, rejection: { code, message } };
}

function validIndex(value: number, tree: SectionTree): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value < tree.sections.length;
}

function descendantsOf(section: Section, tree: SectionTree): Section[] {
  return tree.sections.filter((candidate) => candidate.headingRange.start >= section.headingRange.start &&
    candidate.headingRange.start < section.subtreeRange.end);
}

function adjustHeading(raw: string, section: Section, targetDepth: number): string | null {
  if (section.depth === targetDepth) return raw;
  if (section.syntax === 'atx') {
    const match = raw.match(/^( {0,3})#{1,6}(?=[ \t]|$)/);
    return match ? `${match[1]}${'#'.repeat(targetDepth)}${raw.slice(match[0].length)}` : null;
  }
  const lines = raw.split(/\r\n|\r|\n/);
  const ending = raw.match(/\r\n|\r|\n/)?.[0];
  if (!ending || lines.length !== 2 || !/^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[1])) return null;
  if (targetDepth <= 2) {
    return `${lines[0]}${ending}${lines[1].replace(/[=-]/g, targetDepth === 1 ? '=' : '-')}`;
  }
  const title = lines[0].match(/^( {0,3})(.*)$/);
  return title ? `${title[1]}${'#'.repeat(targetDepth)} ${title[2]}` : null;
}

function adjustBlock(source: string, section: Section, moved: readonly Section[], delta: number): string | null {
  let block = source.slice(section.subtreeRange.start, section.subtreeRange.end);
  for (const heading of [...moved].reverse()) {
    const raw = source.slice(heading.headingRange.start, heading.headingRange.end);
    const replacement = adjustHeading(raw, heading, heading.depth + delta);
    if (replacement === null) return null;
    const start = heading.headingRange.start - section.subtreeRange.start;
    const end = heading.headingRange.end - section.subtreeRange.start;
    block = block.slice(0, start) + replacement + block.slice(end);
  }
  return block;
}

function signature(value: unknown): string {
  return JSON.stringify(value, (key, entry: unknown) => key === 'position' ? undefined : entry);
}

interface SemanticDocument {
  readonly headings: readonly RootContent[];
  readonly bodies: readonly (readonly RootContent[])[];
  readonly preamble: readonly RootContent[];
  readonly definitions: ReadonlyMap<string, string>;
  readonly fragments: ReadonlySet<string>;
  readonly hasHtml: boolean;
}

function semantics(source: string): SemanticDocument {
  const root = processor.parse(source.replace(/^\uFEFF/, '')) as Root;
  const headings: RootContent[] = [];
  const bodies: RootContent[][] = [];
  const preamble: RootContent[] = [];
  const definitions = new Map<string, string>();
  const fragments = new Set<string>();
  let hasHtml = false;
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const node = value as { type?: string; identifier?: string; url?: string; title?: string; value?: string; children?: unknown[] };
    if (node.type === 'definition' && node.identifier && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, signature({ url: node.url, title: node.title }));
    }
    if (node.url?.startsWith('#')) {
      try { fragments.add(decodeURIComponent(node.url.slice(1))); } catch { fragments.add(node.url.slice(1)); }
    }
    // HTML tree construction crosses Markdown block boundaries. Until that
    // renderer contract is mapped, only standalone comments are provable here.
    if (node.type === 'html' && !/^\s*<!--(?:(?!-->)[\s\S])*-->\s*$/.test(node.value ?? '')) hasHtml = true;
    node.children?.forEach(inspect);
  };
  for (const node of root.children) {
    if (node.type === 'heading') { headings.push(node); bodies.push([]); }
    else (bodies.at(-1) ?? preamble).push(node);
    inspect(node);
  }
  return { headings, bodies, preamble, definitions, fragments, hasHtml };
}

function verifyCandidate(
  before: SectionTree, after: SectionTree, order: readonly number[], moved: ReadonlySet<number>,
  sourceIndex: number, parentIndex: number | null, delta: number,
): boolean {
  if (after.sections.length !== order.length) return false;
  return order.every((originalIndex, candidateIndex) => {
    const original = before.sections[originalIndex];
    const candidate = after.sections[candidateIndex];
    const candidateParent = candidate.parentIndex === null ? null : order[candidate.parentIndex];
    return candidate.title === original.title &&
      candidate.depth === original.depth + (moved.has(originalIndex) ? delta : 0) &&
      candidateParent === (originalIndex === sourceIndex ? parentIndex : original.parentIndex);
  });
}

function verifySemantics(source: string, candidate: string, before: SectionTree, after: SectionTree, order: readonly number[]): boolean {
  const original = semantics(source);
  const next = semantics(candidate);
  if (original.hasHtml || next.hasHtml || signature(original.preamble) !== signature(next.preamble)) return false;
  if (!order.every((index, nextIndex) => {
    const heading = original.headings[index];
    const candidateHeading = next.headings[nextIndex];
    return heading.type === 'heading' && candidateHeading.type === 'heading' &&
      signature(heading.children) === signature(candidateHeading.children) &&
      signature(original.bodies[index]) === signature(next.bodies[nextIndex]);
  })) return false;
  if (original.definitions.size !== next.definitions.size ||
    [...original.definitions].some(([id, value]) => next.definitions.get(id) !== value)) return false;
  const originalTargets = new Map(sectionFragmentIds(before).map((id, index) => [id, index]));
  const nextTargets = new Map(sectionFragmentIds(after).map((id, index) => [id, order[index]]));
  return [...original.fragments].every((id) => originalTargets.get(id) === nextTargets.get(id));
}

function boundarySuffix(text: string, ending: string): string {
  if (!text || text === '\uFEFF') return '';
  const breaks = text.match(/(?:\r\n|\r|\n)[ \t]*(?:(?:\r\n|\r|\n)[ \t]*)?$/)?.[0] ?? '';
  const count = [...breaks.matchAll(/\r\n|\r|\n/g)].length;
  return ending.repeat(Math.max(0, 2 - count));
}

export function previewSectionTransform(source: string, operation: SectionTransformOperation): SectionTransformPreview {
  let sourceTree: SectionTree;
  try { sourceTree = extractSections(source); } catch {
    const empty: SectionTree = { sourceLength: source.length, preambleRange: { start: 0, end: source.length }, rootIndexes: [], sections: [], virtualCard: null };
    return rejected('rejected', operation, source, empty, 'parse-failed', '当前 Markdown 无法安全解析。');
  }
  const reject = (code: SectionTransformRejectionCode, message: string, status: 'rejected' | 'noop' = 'rejected') =>
    rejected(status, operation, source, sourceTree, code, message);
  const sourceIndex = operation.kind === 'move' ? operation.sourceIndex : operation.sectionIndex;
  if (!validIndex(sourceIndex, sourceTree) || (operation.kind === 'move' && !validIndex(operation.targetIndex, sourceTree))) {
    return reject('invalid-index', '找不到源章节或目标章节。');
  }
  const section = sourceTree.sections[sourceIndex];
  const movedSections = descendantsOf(section, sourceTree);
  const moved = new Set(movedSections.map((entry) => entry.index));
  let targetDepth: number;
  let parentIndex: number | null;
  let destination: number;
  let summary: string;
  if (operation.kind === 'move') {
    const target = sourceTree.sections[operation.targetIndex];
    if (sourceIndex === target.index) return reject('same-section', '章节不能移动到自身。', 'noop');
    if (section.parentIndex === target.index) return reject('current-parent', '章节已在当前父章节中，无需变更。', 'noop');
    if (moved.has(target.index)) return reject('descendant-target', '不能把章节移动到自己的后代中。');
    targetDepth = target.depth + 1;
    parentIndex = target.index;
    destination = target.subtreeRange.end;
    summary = `将“${section.title}”及其后代移动到“${target.title}”的子章节末尾。`;
  } else {
    targetDepth = operation.targetDepth;
    if (!Number.isSafeInteger(targetDepth) || targetDepth < 1 || targetDepth > section.depth) {
      return reject('invalid-depth', '提升操作只能选择比当前更浅的标题级别；设为子章节请使用移动操作。');
    }
    if (targetDepth === section.depth) return reject('same-section', '目标级别与当前相同，无需变更。', 'noop');
    parentIndex = section.parentIndex;
    while (parentIndex !== null && sourceTree.sections[parentIndex].depth >= targetDepth) {
      parentIndex = sourceTree.sections[parentIndex].parentIndex;
    }
    destination = parentIndex === null ? source.length : sourceTree.sections[parentIndex].subtreeRange.end;
    summary = `将“${section.title}”及其后代提升为第 ${targetDepth} 级，放到${parentIndex === null ? '文档顶层' : '保留父章节的子章节'}末尾。`;
  }
  const delta = targetDepth - section.depth;
  if (movedSections.some((entry) => entry.depth + delta < 1 || entry.depth + delta > 6)) {
    return reject('depth-overflow', '此变更会使标题超出 1 到 6 级范围。');
  }
  const adjusted = adjustBlock(source, section, movedSections, delta);
  if (adjusted === null) return reject('unsupported-setext', '多行 Setext 标题不能由结构命令安全转换，请先在源码中调整。');
  const { start, end } = section.subtreeRange;
  const remaining = source.slice(0, start) + source.slice(end);
  const insertion = destination >= end ? destination - (end - start) : destination;
  const prefix = remaining.slice(0, insertion);
  const suffix = remaining.slice(insertion);
  const ending = source.match(/\r\n|\r|\n/)?.[0] ?? '\n';
  const beforeBoundary = boundarySuffix(prefix, ending);
  const afterBoundary = suffix ? boundarySuffix(adjusted, ending) : '';
  const candidate = prefix + beforeBoundary + adjusted + afterBoundary + suffix;
  const order = [
    ...sourceTree.sections.filter((entry) => !moved.has(entry.index) && entry.headingRange.start < destination).map((entry) => entry.index),
    ...movedSections.map((entry) => entry.index),
    ...sourceTree.sections.filter((entry) => !moved.has(entry.index) && entry.headingRange.start >= destination).map((entry) => entry.index),
  ];
  let candidateTree: SectionTree;
  try {
    candidateTree = extractSections(candidate);
    if (!verifyCandidate(sourceTree, candidateTree, order, moved, sourceIndex, parentIndex, delta)) {
      return reject('candidate-mismatch', '候选会改变其他章节的归属或标题结构，已拒绝变更。');
    }
    if (!verifySemantics(source, candidate, sourceTree, candidateTree, order)) {
      return reject('unsafe-semantics', '无法证明正文、引用链接或标题链接保持原义；含原始 HTML 的结构变更请在源码中处理。');
    }
  } catch {
    return reject('parse-failed', '候选 Markdown 无法完成安全重解析。');
  }
  const addedBoundaryLineEndings = [...(beforeBoundary + afterBoundary).matchAll(/\r\n|\r|\n/g)].length;
  const preservedSpans: { before: SourceRange; after: SourceRange }[] = [];
  const preserve = (oldStart: number, newStart: number, length: number) => {
    if (length > 0 && source.slice(oldStart, oldStart + length) === candidate.slice(newStart, newStart + length)) {
      preservedSpans.push({ before: { start: oldStart, end: oldStart + length }, after: { start: newStart, end: newStart + length } });
    }
  };
  preserve(0, 0, sourceTree.preambleRange.end);
  order.forEach((oldIndex, newIndex) => {
    const old = sourceTree.sections[oldIndex];
    const next = candidateTree.sections[newIndex];
    const oldHeading = source.slice(old.headingRange.start, old.headingRange.end);
    const nextHeading = candidate.slice(next.headingRange.start, next.headingRange.end);
    // Only a shared heading suffix may survive marker/Setext changes. Never
    // search by title: duplicate text keeps the verified section identity.
    let suffixLength = 0;
    while (suffixLength < Math.min(oldHeading.length, nextHeading.length) &&
      oldHeading.at(-suffixLength - 1) === nextHeading.at(-suffixLength - 1)) suffixLength += 1;
    preserve(old.headingRange.end - suffixLength, next.headingRange.end - suffixLength, suffixLength);
    preserve(old.directContentRange.start, next.directContentRange.start, old.directContentRange.end - old.directContentRange.start);
  });
  return {
    status: 'ready', operation, source, candidate, sourceTree, candidateTree, sectionOrder: order,
    changedRanges: [section.subtreeRange, { start: destination, end: destination }],
    addedBoundaryLineEndings, preservedSpans,
    summary: `${summary}${addedBoundaryLineEndings ? ` 预览包含 ${addedBoundaryLineEndings} 个必要的边界换行。` : ''}`,
  };
}

export function applySectionTransform(source: string, operation: SectionTransformOperation): string {
  const preview = previewSectionTransform(source, operation);
  if (preview.status !== 'ready') throw new Error(preview.rejection.message);
  return preview.candidate;
}
