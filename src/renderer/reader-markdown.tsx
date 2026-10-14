import { memo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import type { PluggableList } from 'unified';
import { readingSanitizeSchema, rehypeReadingHtmlPolicy, remarkReadingDangerousHtmlPolicy } from '../core/markdown-reading';

const remarkPlugins: PluggableList = [remarkGfm, remarkFrontmatter, remarkReadingDangerousHtmlPolicy];
const rehypePlugins: PluggableList = [rehypeRaw, rehypeReadingHtmlPolicy, [rehypeSanitize, readingSanitizeSchema]];

/** Search/chrome state must not reparse or replace an unchanged reading DOM. */
export const ReaderMarkdown = memo(function ReaderMarkdown({ content, components }: {
  readonly content: string; readonly components: Components;
}) {
  return <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
    {content.startsWith('\uFEFF') ? content.slice(1) : content}
  </Markdown>;
});
