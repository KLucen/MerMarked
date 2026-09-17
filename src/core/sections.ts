import type { Heading, Root } from 'mdast';
import { toString } from 'mdast-util-to-string';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

/** Half-open offsets into the original JavaScript source string (UTF-16 code units). */
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

export type HeadingSyntax = 'atx' | 'setext';

/**
 * A parser-local section index is intentionally not a persistent card ID.
 * Persistent IDs will be matched separately when companion data is introduced.
 */
export interface Section {
  readonly index: number;
  readonly title: string;
  readonly depth: number;
  readonly syntax: HeadingSyntax;
  readonly parentIndex: number | null;
  readonly childIndexes: readonly number[];
  /** The heading syntax itself, without its terminating line ending. */
  readonly headingRange: SourceRange;
  /** From the end of the heading to the next root-level heading or EOF. */
  readonly directContentRange: SourceRange;
  /** From the heading start through all descendants, up to the next peer/ancestor heading or EOF. */
  readonly subtreeRange: SourceRange;
}

export interface VirtualCard {
  readonly kind: 'preamble' | 'whole-document';
  readonly sourceRange: SourceRange;
}

export interface SectionTree {
  readonly sourceLength: number;
  /** Everything before the first root-level heading, including metadata and whitespace. */
  readonly preambleRange: SourceRange;
  readonly rootIndexes: readonly number[];
  readonly sections: readonly Section[];
  /** Only present for renderable preamble content, or for a document with no headings. */
  readonly virtualCard: VirtualCard | null;
}

interface HeadingEntry {
  readonly node: Heading;
  readonly range: SourceRange;
}

interface MutableSection {
  index: number;
  title: string;
  depth: number;
  syntax: HeadingSyntax;
  parentIndex: number | null;
  childIndexes: number[];
  headingRange: SourceRange;
  directContentRange: SourceRange;
  subtreeRange: SourceRange;
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, 'yaml');

function requiredRange(node: Heading, sourceLength: number, offsetShift: number): SourceRange {
  const rawStart = node.position?.start.offset;
  const rawEnd = node.position?.end.offset;
  const start = rawStart === undefined ? undefined : rawStart + offsetShift;
  const end = rawEnd === undefined ? undefined : rawEnd + offsetShift;

  if (
    start === undefined ||
    end === undefined ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > sourceLength
  ) {
    throw new Error('Markdown parser did not provide a valid heading source range');
  }

  return { start, end };
}

function headingSyntax(source: string, range: SourceRange): HeadingSyntax {
  const firstLine = source.slice(range.start, range.end).split(/\r\n|\r|\n/, 1)[0];
  return /^ {0,3}#{1,6}(?:[ \t]|$)/.test(firstLine) ? 'atx' : 'setext';
}

function hasRenderablePreamble(root: Root, firstHeadingStart: number, offsetShift: number): boolean {
  return root.children.some((node) => {
    const rawStart = node.position?.start.offset;
    const start = rawStart === undefined ? undefined : rawStart + offsetShift;
    return (
      start !== undefined &&
      start < firstHeadingStart &&
      node.type !== 'yaml'
    );
  });
}

/**
 * Parse CommonMark + GFM + YAML frontmatter and extract document-root headings.
 * Headings inside block quotes or list items remain part of their enclosing content.
 * This function only observes source; it never rewrites or normalizes Markdown.
 */
export function extractSections(source: string): SectionTree {
  // A leading BOM belongs to the file, not to the first movable section.
  const offsetShift = source.startsWith('\uFEFF') ? 1 : 0;
  const root = processor.parse(source.slice(offsetShift)) as Root;
  const headings: HeadingEntry[] = root.children
    .filter((node): node is Heading => node.type === 'heading')
    .map((node) => ({ node, range: requiredRange(node, source.length, offsetShift) }));

  const firstHeadingStart = headings[0]?.range.start ?? source.length;
  const preambleRange = { start: 0, end: firstHeadingStart };
  const virtualCard: VirtualCard | null =
    headings.length === 0
      ? { kind: 'whole-document', sourceRange: { start: 0, end: source.length } }
      : hasRenderablePreamble(root, firstHeadingStart, offsetShift)
        ? { kind: 'preamble', sourceRange: preambleRange }
        : null;

  const sections: MutableSection[] = [];
  const rootIndexes: number[] = [];
  const openAncestors: number[] = [];

  for (let index = 0; index < headings.length; index += 1) {
    const { node, range } = headings[index];

    while (
      openAncestors.length > 0 &&
      sections[openAncestors[openAncestors.length - 1]].depth >= node.depth
    ) {
      const closingIndex = openAncestors.pop();
      if (closingIndex !== undefined) {
        sections[closingIndex].subtreeRange = {
          start: sections[closingIndex].headingRange.start,
          end: range.start,
        };
      }
    }

    const parentIndex = openAncestors.at(-1) ?? null;
    const nextHeadingStart = headings[index + 1]?.range.start ?? source.length;
    const section: MutableSection = {
      index,
      title: toString(node).replace(/\r\n?/g, '\n'),
      depth: node.depth,
      syntax: headingSyntax(source, range),
      parentIndex,
      childIndexes: [],
      headingRange: range,
      directContentRange: { start: range.end, end: nextHeadingStart },
      subtreeRange: { start: range.start, end: source.length },
    };

    sections.push(section);
    if (parentIndex === null) {
      rootIndexes.push(index);
    } else {
      sections[parentIndex].childIndexes.push(index);
    }
    openAncestors.push(index);
  }

  return {
    sourceLength: source.length,
    preambleRange,
    rootIndexes,
    sections,
    virtualCard,
  };
}
