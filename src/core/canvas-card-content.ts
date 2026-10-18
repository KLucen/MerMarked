import { toString } from 'mdast-util-to-string';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import { unified } from 'unified';
import type { SectionTree } from './sections.ts';

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter);

export interface CanvasCardContent {
  readonly title: string;
  readonly summary: string;
  readonly fullText?: string;
  readonly childCount: number;
}

/** Scoped to one immutable source/tree pair. Retains text, never parser trees. */
export interface CanvasCardContentCache {
  readonly source: string;
  readonly tree: SectionTree;
  readonly get: (sectionIndex: number | null) => CanvasCardContent;
}

export function createCanvasCardContentCache(content: string, tree: SectionTree): CanvasCardContentCache {
  const entries = new Map<number | null, CanvasCardContent>();
  return Object.freeze({
    source: content,
    tree,
    get(sectionIndex: number | null) {
      let entry = entries.get(sectionIndex);
      if (!entry) {
        entry = Object.freeze(canvasCardContent(content, tree, sectionIndex));
        entries.set(sectionIndex, entry);
      }
      return entry;
    },
  });
}

export function canvasCardContent(content: string, tree: SectionTree, sectionIndex: number | null): CanvasCardContent {
  const section = sectionIndex === null ? null : tree.sections[sectionIndex];
  const range = section?.directContentRange ?? tree.virtualCard?.sourceRange;
  const root = processor.parse(range ? content.slice(range.start, range.end) : '');
  root.children = root.children.filter((node) => !['html', 'definition', 'yaml'].includes(node.type));
  const fullText = toString(root).replace(/\s+/g, ' ').trim();
  // Preserve the existing 160-code-point excerpt without materializing an
  // array containing every character of a potentially multi-megabyte chapter.
  const excerpt: string[] = [];
  for (const character of fullText) {
    if (excerpt.length === 160) break;
    excerpt.push(character);
  }
  return {
    title: section?.title ?? (tree.virtualCard?.kind === 'preamble' ? '文档前言' : '全文'),
    summary: excerpt.join(''),
    fullText,
    childCount: section?.childIndexes.length ?? 0,
  };
}
