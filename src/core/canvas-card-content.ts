import { toString } from 'mdast-util-to-string';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import { unified } from 'unified';
import type { SectionTree } from './sections.ts';
import type { MarkdownSnapshot } from './markdown-snapshot.ts';
import { remarkReadingDangerousHtmlPolicy } from './markdown-reading.ts';
import type { List, Nodes, PhrasingContent, Root, RootContent } from 'mdast';

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter);
const applyReadingHtmlPolicy = remarkReadingDangerousHtmlPolicy();
const inlineTextOptions = { includeHtml: false };

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
  // The reader policy can suppress content between separate raw HTML nodes.
  // Apply it to a copy only when present, so the shared Markdown snapshot stays intact.
  const safeRoot = containsRawHtml(root) ? copyHtmlPolicyTree(root) : root;
  if (safeRoot !== root) applyReadingHtmlPolicy(safeRoot);
  const fullText = blocksText(safeRoot.children);
  // Preserve the existing 160-code-point excerpt without materializing an
  // array containing every character of a potentially multi-megabyte chapter.
  let excerptEnd = 0;
  let codePoints = 0;
  for (const character of fullText) {
    excerptEnd += character.length;
    codePoints += 1;
    if (codePoints === 160) break;
  }
  return {
    title: section?.title ?? (tree.virtualCard?.kind === 'preamble' ? '文档前言' : '全文'),
    summary: fullText.slice(0, excerptEnd),
    fullText,
    childCount: section?.childIndexes.length ?? 0,
  };
}

function containsRawHtml(node: Nodes): boolean {
  return node.type === 'html' || ('children' in node && node.children.some(containsRawHtml));
}

function copyHtmlPolicyTree<T extends Nodes>(node: T): T {
  if ('children' in node) return { ...node, children: node.children.map(copyHtmlPolicyTree) };
  return node.type === 'html' ? { ...node } : node;
}

function inlineText(node: PhrasingContent): string {
  if (node.type === 'break') return '\n';
  if (node.type === 'html') return /^<br(?:\s|\/?>)/i.test(node.value) ? '\n' : '';
  if ('children' in node) return node.children.map(inlineText).join('');
  return toString(node, inlineTextOptions).replace(/\s+/g, ' ');
}

function phrasingText(children: readonly PhrasingContent[]): string {
  // Most card paragraphs have a single text node.
  if (children.length === 1 && children[0].type === 'text') return inlineText(children[0]).trim();
  return children.map(inlineText).join('').replace(/ *\n */g, '\n').replace(/ {2,}/g, ' ').trim();
}

function listText(list: List): string {
  const start = list.start ?? 1;
  return list.children.map((item, index) => {
    const marker = list.ordered ? `${start + index}.` : '•';
    const task = item.checked == null ? '' : item.checked ? ' ☑' : ' ☐';
    const parts: string[] = [];
    for (const child of item.children) {
      const text = blockText(child);
      if (!text) continue;
      if (child.type === 'list') parts.push('\n');
      else if (parts.length) parts.push('\n\n');
      parts.push(text);
    }
    const body = parts.join('').replace(/\n(?=[^\n])/g, '\n  ');
    const prefix = marker + task;
    return body ? prefix + (body.startsWith('\n') ? '' : ' ') + body : prefix;
  }).join('\n');
}

function blockText(node: RootContent): string {
  switch (node.type) {
    case 'heading':
    case 'paragraph':
      return phrasingText(node.children);
    case 'code':
      return node.value.replace(/\r\n?/g, '\n');
    case 'blockquote': {
      const text = blocksText(node.children);
      return text ? `│ ${text.replace(/\n/g, '\n│ ')}` : '';
    }
    case 'list':
      return listText(node);
    case 'table':
      return node.children.map(row => row.children.map(cell => phrasingText(cell.children)).join(' │ ')).join('\n');
    default:
      return '';
  }
}

function blocksText(nodes: readonly RootContent[]): string {
  return nodes.map(blockText).filter(Boolean).join('\n\n');
}
