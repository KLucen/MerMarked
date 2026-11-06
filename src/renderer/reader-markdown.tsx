import { memo, useLayoutEffect, useMemo, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import type { Root } from 'hast';
import type { PluggableList } from 'unified';
import { preparedReadingPlugin } from './prepared-reading-plugin';

/** Search/chrome state must not reparse or replace an unchanged reading DOM. */
const ReadingChunk = memo(function ReadingChunk({ tree, components }: {
  readonly tree: Root; readonly components: Components;
}) {
  const rehypePlugins = useMemo<PluggableList>(() => [preparedReadingPlugin(tree)], [tree]);
  // Only an empty source reaches the parser. react-markdown still performs its
  // URL transform and JSX conversion with the original node positions/components.
  return <Markdown rehypePlugins={rehypePlugins} components={components}>{''}</Markdown>;
});

/** Split only the already resolved/sanitized HAST at complete root-block boundaries. */
export const ReaderMarkdown = memo(function ReaderMarkdown({ tree, components, active = true, onReady }: {
  readonly tree: Root; readonly components: Components; readonly active?: boolean;
  readonly onReady?: (tree: Root | null) => void;
}) {
  const chunks = useMemo(() => {
    const result: Root[] = [];
    for (let offset = 0; offset < tree.children.length; offset += 128) {
      result.push({ ...tree, children: tree.children.slice(offset, offset + 128) });
    }
    return result;
  }, [tree]);
  const [progress, setProgress] = useState({ tree, count: 1 });
  const count = progress.tree === tree ? progress.count : 1;
  useLayoutEffect(() => {
    if (!active || count >= chunks.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      // Let this batch paint before committing the next complete semantic blocks.
      timer = setTimeout(() => setProgress({ tree, count: count + 1 }), 0);
    });
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [active, chunks.length, count, tree]);
  useLayoutEffect(() => {
    if (count < chunks.length) return;
    onReady?.(tree);
    return () => onReady?.(null);
  }, [chunks.length, count, onReady, tree]);
  return <>{chunks.slice(0, count).map((chunk, index) => <ReadingChunk key={index} tree={chunk} components={components} />)}</>;
});
