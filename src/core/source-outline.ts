import { extractSections, type SectionTree } from './sections.ts';

export interface SourceOutlineSection {
  readonly key: string;
  readonly title: string;
  readonly depth: number;
  readonly headingDepth: number;
  /** UTF-16 offset in the exact LF-normalized editor buffer. */
  readonly sourceOffset: number;
}

/** Read-only projection. Structural edits must still validate the full source. */
export function buildSourceOutline(source: string): readonly SourceOutlineSection[] {
  return projectSourceOutline(extractSections(source));
}

export function projectSourceOutline(tree: SectionTree): readonly SourceOutlineSection[] {
  const depths: number[] = [];
  return tree.sections.map(section => {
    const depth = section.parentIndex === null ? 1 : depths[section.parentIndex] + 1;
    depths[section.index] = depth;
    return { key: String(section.index), title: section.title, depth,
      headingDepth: section.depth, sourceOffset: section.headingRange.start };
  });
}

/** Reuse an already parsed reading tree with offsets in the LF editor buffer. */
export function normalizeOutlineOffsets(source: string, sections: readonly SourceOutlineSection[]): readonly SourceOutlineSection[] {
  let cursor = 0;
  let removed = 0;
  return sections.map(section => {
    while (cursor < section.sourceOffset) {
      if (source[cursor] === '\r' && source[cursor + 1] === '\n') { removed += 1; cursor += 2; }
      else cursor += 1;
    }
    return { ...section, sourceOffset: section.sourceOffset - removed };
  });
}
