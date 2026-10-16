import type { Root } from 'hast';
import type { Plugin } from 'unified';

/** Supply a worker-prepared HAST to react-markdown's existing component/URL adapter. */
export function preparedReadingPlugin(tree: Root): Plugin<[], Root> {
  return () => () => tree;
}
