export interface HeadingViewportPosition {
  readonly index: number;
  readonly top: number;
}

/**
 * Return the last heading that has crossed the reading position marker.
 * Positions must use document order. Content before the first heading has no
 * active section, so this deliberately returns null in that region.
 */
export function activeSectionAtMarker(
  positions: readonly HeadingViewportPosition[],
  markerTop: number,
): number | null {
  let active: number | null = null;
  for (const position of positions) {
    if (!Number.isFinite(position.top) || position.top > markerTop) break;
    active = position.index;
  }
  return active;
}

/** Count user-perceived characters without assuming UTF-16 code units are characters. */
export function countGraphemes(value: string): number {
  if (typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(value)).length;
  }
  return Array.from(value).length;
}
