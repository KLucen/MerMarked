import { sectionsFromSnapshot, type SectionTree } from './sections.ts';
import { selectionMapFromSnapshot, type SelectionMap } from './selection-map.ts';
import { extensionsFromSnapshot, type UnsupportedMarkdownExtension } from './markdown-reading.ts';
import { parseMarkdownSnapshot } from './markdown-snapshot.ts';

export interface ReadingAnalysis {
  readonly sections: SectionTree;
  readonly selection: SelectionMap;
  readonly extensions: readonly UnsupportedMarkdownExtension[];
}

/** All projections belong to one exact, unchanged source snapshot. No persistence. */
export function analyzeReading(source: string, bomByteLength: 0 | 3): ReadingAnalysis {
  const snapshot = parseMarkdownSnapshot(source);
  return {
    sections: sectionsFromSnapshot(snapshot),
    selection: selectionMapFromSnapshot(snapshot, bomByteLength),
    extensions: extensionsFromSnapshot(snapshot),
  };
}
