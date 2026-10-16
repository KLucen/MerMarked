import { scanVisibleTextMatches } from '../core/visible-text-search';

export interface VisibleSearchMatch { readonly range: Range; readonly block: HTMLElement }
export interface VisibleSearchResults { readonly matches: readonly VisibleSearchMatch[]; readonly truncated: boolean }
export const MAX_VISIBLE_SEARCH_MATCHES = 1000;
const SEARCH_BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, td, th, pre, blockquote, dl, dt, dd, details, summary';
interface TextSegment { readonly node: Text; readonly start: number; readonly end: number }
interface SearchBlock { readonly block: HTMLElement; text: string; readonly segments: TextSegment[]; lastBreak: number }

function hiddenByClosedDetails(parent: HTMLElement): boolean {
  for (let details = parent.closest('details:not([open])'); details; details = details.parentElement?.closest('details:not([open])') ?? null) {
    const summary = details.querySelector(':scope > summary');
    if (!summary?.contains(parent)) return true;
  }
  return false;
}

function segmentAt(segments: readonly TextSegment[], offset: number): TextSegment | undefined {
  let low = 0, high = segments.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (segments[middle].end <= offset) low = middle + 1;
    else high = middle;
  }
  const segment = segments[low];
  return segment && segment.start <= offset ? segment : undefined;
}

/** One index per connected reading DOM. Invalidation cancels in-flight traversals. */
export class VisibleSearchIndex {
  private blocks: readonly SearchBlock[] | null = null;
  private revision = 0;
  private disposed = false;
  private readonly observer: MutationObserver;
  private readonly article: HTMLElement;
  private readonly onInvalidate: () => void;

  constructor(article: HTMLElement, onInvalidate: () => void) {
    this.article = article;
    this.onInvalidate = onInvalidate;
    this.observer = new MutationObserver(() => this.invalidate());
    this.observer.observe(article, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['open', 'hidden', 'aria-hidden', 'style', 'class'] });
    window.addEventListener('resize', this.invalidate);
  }

  private invalidate = () => {
    this.revision += 1;
    this.blocks = null;
    this.onInvalidate();
  };

  dispose() {
    this.disposed = true;
    this.observer.disconnect();
    window.removeEventListener('resize', this.invalidate);
    this.revision += 1;
    this.blocks = null;
  }

  get connected() { return !this.disposed && this.article.isConnected; }

  async search(query: string, signal: AbortSignal): Promise<VisibleSearchResults> {
    const revision = this.revision;
    const check = () => {
      if (signal.aborted || revision !== this.revision || !this.connected) throw new DOMException('Search cancelled', 'AbortError');
    };
    let deadline = performance.now() + 6;
    const pause = async () => {
      check();
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      check();
      deadline = performance.now() + 6;
    };
    await pause();
    if (!query) return { matches: [], truncated: false };
    if (!this.blocks) {
      const blocks: SearchBlock[] = [];
      const walker = document.createTreeWalker(this.article, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      let breaks = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (performance.now() >= deadline) await pause();
        if (node instanceof HTMLBRElement) { breaks += 1; continue; }
        if (!(node instanceof Text) || !node.data) continue;
        const parent = node.parentElement;
        if (!parent || parent.closest('[hidden], [aria-hidden="true"], .html-placeholder') || hiddenByClosedDetails(parent)) continue;
        const geometry = document.createRange();
        geometry.selectNodeContents(node);
        if (!geometry.getClientRects().length) continue;
        const block = parent.closest<HTMLElement>(SEARCH_BLOCK_SELECTOR) ?? this.article;
        let entry = blocks.at(-1);
        // A nested block or br interrupts the text. Separate entries cannot be
        // bridged even by a query containing an internal separator character.
        if (entry?.block !== block || entry.lastBreak !== breaks) {
          entry = { block, text: '', segments: [], lastBreak: breaks }; blocks.push(entry);
        }
        const start = entry.text.length;
        entry.text += node.data;
        entry.segments.push({ node, start, end: entry.text.length });
        entry.lastBreak = breaks;
      }
      check();
      this.blocks = blocks;
    }
    const results: VisibleSearchMatch[] = [];
    for (const { block, text, segments } of this.blocks) {
      if (performance.now() >= deadline) await pause();
      for (const match of scanVisibleTextMatches(text, query)) {
        if (performance.now() >= deadline) await pause();
        if (!match) continue;
        const start = segmentAt(segments, match.start), end = segmentAt(segments, match.end - 1);
        if (!start || !end) continue;
        const range = document.createRange();
        range.setStart(start.node, match.start - start.start);
        range.setEnd(end.node, match.end - end.start);
        if (!range.getClientRects().length) continue;
        results.push({ range, block });
        if (results.length > MAX_VISIBLE_SEARCH_MATCHES) {
          check();
          return { matches: results.slice(0, MAX_VISIBLE_SEARCH_MATCHES), truncated: true };
        }
      }
    }
    check();
    return { matches: results, truncated: false };
  }
}
