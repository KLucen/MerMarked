export interface TextMatch { readonly start: number; readonly end: number }

const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** Yield every candidate (null for an incomplete grapheme), so callers can yield/cancel. */
export function* scanVisibleTextMatches(text: string, query: string): Generator<TextMatch | null> {
  if (!query) return;
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  // Construct segmentation lazily: a block with no candidates needs no segmentation.
  let segments: Intl.Segments | undefined;
  const boundary = (offset: number): boolean => {
    if (offset === 0 || offset === text.length) return true;
    if (segmenter) {
      segments ??= segmenter.segment(text);
      return segments.containing(offset)?.index === offset;
    }
    // Preserve the previous fallback: code-point boundaries when Segmenter is absent.
    const current = text.charCodeAt(offset), previous = text.charCodeAt(offset - 1);
    return !(current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff);
  };
  for (let match = expression.exec(text); match; match = expression.exec(text)) {
    const end = match.index + match[0].length;
    yield boundary(match.index) && boundary(end) ? { start: match.index, end } : null;
  }
}

/** Non-overlapping literal Unicode matches, retaining UTF-16 DOM offsets. */
export function findVisibleTextMatches(text: string, query: string, limit = Number.POSITIVE_INFINITY): readonly TextMatch[] {
  const matches: TextMatch[] = [];
  if (limit <= 0) return matches;
  for (const match of scanVisibleTextMatches(text, query)) {
    if (!match) continue;
    matches.push(match);
    if (matches.length >= limit) break;
  }
  return matches;
}
