import { toString } from 'mdast-util-to-string';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import { unified } from 'unified';
import type { SectionTree } from './sections.ts';
import type { MarkdownSnapshot } from './markdown-snapshot.ts';
import type { Root, Nodes } from 'mdast';

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
  return contentFromRoot(root, tree, sectionIndex);
}

/** Reuse complete root blocks; references retain the original per-chapter parser scope. */
export function canvasContentsFromSnapshot(snapshot: MarkdownSnapshot, tree: SectionTree): readonly (readonly [number | null, CanvasCardContent])[] {
  const referenceDependent = (node: Nodes): boolean => /(?:Reference|Definition)$/.test(node.type) ||
    ('children' in node && node.children.some(referenceDependent));
  return [...tree.sections.map(section => section.index), ...(tree.virtualCard ? [null] : [])].map(index => {
    const range = index === null ? tree.virtualCard!.sourceRange : tree.sections[index].directContentRange;
    const children = snapshot.root.children.filter(node => {
      const start = (node.position?.start.offset ?? -1) + snapshot.bomOffset;
      const end = (node.position?.end.offset ?? -1) + snapshot.bomOffset;
      return start >= range.start && end <= range.end;
    });
    // Local frontmatter and reference resolution depend on fragment context.
    // Fall back for metadata/definitions/references, not for ordinary prose.
    const fallback = children.some(node => referenceDependent(node) || node.type === 'definition' || node.type === 'yaml');
    return [index, fallback ? canvasCardContent(snapshot.source, tree, index)
      : contentFromRoot({ type: 'root', children }, tree, index)] as const;
  });
}

function contentFromRoot(root: Root, tree: SectionTree, sectionIndex: number | null): CanvasCardContent {
  const section = sectionIndex === null ? null : tree.sections[sectionIndex];
  root = { ...root };
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
