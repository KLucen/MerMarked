import type { Nodes } from 'mdast';
import { extensionsFromSnapshot } from './markdown-reading.ts';
import { parseMarkdownSnapshot } from './markdown-snapshot.ts';

export interface DocumentCopyPortability {
  readonly portable: boolean;
  /** Includes local, unknown, malformed and unsupported destinations. */
  readonly localReferenceCount: number;
  /** Raw HTML fragments, including comments; not a count of elements. */
  readonly htmlNodeCount: number;
  /** Distinct known unsupported extension kinds, not their occurrences. */
  readonly unsupportedExtensionCount: number;
}

function directoryIndependentDestination(value: string): boolean {
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value === '' || value.startsWith('#')) return true;
  // Require explicit schemes. In particular, //host, encoded schemes and
  // Windows paths must not become remote URLs through normalization or a base.
  if (!/^(?:https?:\/\/|mailto:)/i.test(value)) return false;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return false;
    if (parsed.protocol === 'mailto:') return Boolean(parsed.pathname);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Audit saved source under the current Markdown dialect without reading any
 * resource or exposing URLs. Inspect the untouched MDAST: the reading HTML
 * policy deliberately hides source that a future editor could still interpret.
 */
export async function inspectDocumentCopyPortability(content: string): Promise<DocumentCopyPortability> {
  const snapshot = parseMarkdownSnapshot(content);
  let localReferenceCount = 0, htmlNodeCount = 0;
  const pending: Nodes[] = [snapshot.root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'html') htmlNodeCount += 1;
    if ((node.type === 'link' || node.type === 'image' || node.type === 'definition') &&
        !directoryIndependentDestination(node.url)) localReferenceCount += 1;
    if ('children' in node) for (const child of node.children) pending.push(child);
  }
  const unsupportedExtensionCount = extensionsFromSnapshot(snapshot).length;
  return { portable: localReferenceCount === 0 && htmlNodeCount === 0 && unsupportedExtensionCount === 0,
    localReferenceCount, htmlNodeCount, unsupportedExtensionCount };
}
