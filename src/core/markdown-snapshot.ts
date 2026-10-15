import type { Root } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, 'yaml');

/** Parser tree and exact source travel together. Consumers must not mutate the tree. */
export interface MarkdownSnapshot {
  readonly source: string;
  readonly body: string;
  readonly bomOffset: 0 | 1;
  readonly root: Root;
}

export function parseMarkdownSnapshot(source: string): MarkdownSnapshot {
  const bomOffset = source.startsWith('\uFEFF') ? 1 : 0;
  const body = source.slice(bomOffset);
  return { source, body, bomOffset, root: processor.parse(body) as Root };
}
