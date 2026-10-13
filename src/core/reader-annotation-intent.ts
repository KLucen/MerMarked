import { buildSelectionMap, resolveSelection, type SelectionResolution } from './selection-map.ts';

export interface ReaderAnnotationIntent {
  readonly documentKey: string;
  readonly contentSnapshot: string;
  readonly bomByteLength: number;
  readonly blockStart: number;
  readonly visibleStart: number;
  readonly visibleEnd: number;
  readonly sourceExact: string;
  readonly displayQuote: string;
}

/** Rebuild the mapping after save. Never search for another occurrence of the quote. */
export function resolveReaderAnnotationIntent(
  intent: ReaderAnnotationIntent,
  documentKey: string,
  content: string,
  bomByteLength: number,
): SelectionResolution {
  if (intent.documentKey !== documentKey) {
    return { ok: false, reason: '文档已切换，请重新选择批注位置。' };
  }
  if (intent.contentSnapshot !== content || intent.bomByteLength !== bomByteLength) {
    return { ok: false, reason: '正文已变化，草稿已保留。请重新选择批注位置。' };
  }
  try {
    const mapped = resolveSelection(buildSelectionMap(content, bomByteLength),
      intent.blockStart, intent.visibleStart, intent.visibleEnd);
    if (mapped.ok && mapped.sourceExact === intent.sourceExact && mapped.displayQuote === intent.displayQuote) return mapped;
  } catch { /* Invalid source or mapping stays unresolved. */ }
  return { ok: false, reason: '无法确认原选文，草稿已保留。请重新选择批注位置。' };
}
