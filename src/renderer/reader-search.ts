import { findVisibleTextMatches } from '../core/markdown-reading';

export interface VisibleSearchMatch {
  readonly range: Range;
  readonly block: HTMLElement;
}

export interface VisibleSearchResults {
  readonly matches: readonly VisibleSearchMatch[];
  readonly truncated: boolean;
}

export const MAX_VISIBLE_SEARCH_MATCHES = 1000;

const SEARCH_BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, td, th, pre, blockquote, dl, dt, dd, details, summary';

interface TextSegment {
  readonly node: Text;
  readonly start: number;
  readonly end: number;
}

function nearestSearchBlock(node: Text, article: HTMLElement): HTMLElement {
  return node.parentElement?.closest<HTMLElement>(SEARCH_BLOCK_SELECTOR) ?? article;
}

function textNodeHasVisibleGeometry(node: Text): boolean {
  const range = document.createRange();
  range.selectNodeContents(node);
  return range.getClientRects().length > 0;
}

function hiddenByClosedDetails(parent: HTMLElement): boolean {
  const details = parent.closest<HTMLDetailsElement>('details:not([open])');
  if (!details) return false;
  const summary = parent.closest<HTMLElement>('summary');
  return !summary || summary.parentElement !== details;
}

export function collectVisibleSearchMatches(article: HTMLElement, query: string): VisibleSearchResults {
  if (!query) return { matches: [], truncated: false };
  const blocks = new Map<HTMLElement, Text[]>();
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (!(current instanceof Text) || !current.data) continue;
    const parent = current.parentElement;
    if (!parent || parent.closest('[hidden], [aria-hidden="true"], .html-placeholder')) continue;
    if (hiddenByClosedDetails(parent)) continue;
    if (!textNodeHasVisibleGeometry(current)) continue;
    const block = nearestSearchBlock(current, article);
    const nodes = blocks.get(block) ?? [];
    nodes.push(current);
    blocks.set(block, nodes);
  }

  const results: VisibleSearchMatch[] = [];
  for (const [block, nodes] of blocks) {
    const segments: TextSegment[] = [];
    let text = '';
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (index > 0) {
        const gap = document.createRange();
        gap.setStartAfter(nodes[index - 1]);
        gap.setEndBefore(node);
        const fragment = gap.cloneContents();
        if (fragment.querySelector?.('br')) text += '\u0000';
      }
      const start = text.length;
      text += node.data;
      segments.push({ node, start, end: text.length });
    }
    const remaining = MAX_VISIBLE_SEARCH_MATCHES + 1 - results.length;
    for (const match of findVisibleTextMatches(text, query, remaining)) {
      const startSegment = segments.find((segment) => segment.start <= match.start && match.start < segment.end);
      const endSegment = segments.find((segment) => segment.start < match.end && match.end <= segment.end);
      if (!startSegment || !endSegment) continue;
      const range = document.createRange();
      range.setStart(startSegment.node, match.start - startSegment.start);
      range.setEnd(endSegment.node, match.end - endSegment.start);
      if (range.getClientRects().length === 0) continue;
      results.push({ range, block });
      if (results.length > MAX_VISIBLE_SEARCH_MATCHES) {
        return { matches: results.slice(0, MAX_VISIBLE_SEARCH_MATCHES), truncated: true };
      }
    }
  }
  return { matches: results, truncated: false };
}
