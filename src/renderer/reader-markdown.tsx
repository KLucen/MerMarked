import { memo, useMemo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import type { Root } from 'hast';
import type { PluggableList } from 'unified';
import { preparedReadingPlugin } from './prepared-reading-plugin';

/** Search/chrome state must not reparse or replace an unchanged reading DOM. */
export const ReaderMarkdown = memo(function ReaderMarkdown({ tree, components }: {
  readonly tree: Root; readonly components: Components;
}) {
  const rehypePlugins = useMemo<PluggableList>(() => [preparedReadingPlugin(tree)], [tree]);
  // Only an empty source reaches the parser. react-markdown still performs its
  // URL transform and JSX conversion with the original node positions/components.
  return <Markdown rehypePlugins={rehypePlugins} components={components}>{''}</Markdown>;
});
