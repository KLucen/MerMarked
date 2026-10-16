import type { Root } from 'hast';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { readingSanitizeSchema, rehypeReadingHtmlPolicy, remarkReadingDangerousHtmlPolicy } from './markdown-reading.ts';
import type { MarkdownSnapshot } from './markdown-snapshot.ts';

// Same order as the reading pipeline: reject containers before HTML5 parsing,
// then enforce the element and attribute policies. Never split the source.
const processor = unified()
  .use(remarkReadingDangerousHtmlPolicy)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeReadingHtmlPolicy)
  .use(rehypeSanitize, readingSanitizeSchema);

/** A disposable, cloneable display projection; never a persisted content model. */
export function readingRenderFromSnapshot(snapshot: MarkdownSnapshot): Root {
  // The HTML policy mutates MDAST. Other source/anchor consumers own a read-only snapshot.
  return processor.runSync(structuredClone(snapshot.root), snapshot.body) as Root;
}
