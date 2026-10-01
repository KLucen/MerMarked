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

export function canvasCardContent(content: string, tree: SectionTree, sectionIndex: number | null): CanvasCardContent {
  const section = sectionIndex === null ? null : tree.sections[sectionIndex];
  const range = section?.directContentRange ?? tree.virtualCard?.sourceRange;
  const root = processor.parse(range ? content.slice(range.start, range.end) : '');
  root.children = root.children.filter((node) => !['html', 'definition', 'yaml'].includes(node.type));
  const fullText = toString(root).replace(/\s+/g, ' ').trim();
  return {
    title: section?.title ?? (tree.virtualCard?.kind === 'preamble' ? '文档前言' : '全文'),
    summary: Array.from(fullText).slice(0, 160).join(''),
    fullText,
    childCount: section?.childIndexes.length ?? 0,
  };
}
