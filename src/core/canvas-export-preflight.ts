import { assertCanvasExportSize, buildCanvasExportScene, type CanvasExportOptions } from './canvas-export.ts';
import type { CanvasSceneCard, CanvasSceneLink } from './canvas-scene.ts';

export interface CanvasExportPreflight {
  readonly width: number;
  readonly height: number;
  readonly visibleCardCount: number;
  readonly linkCount: number;
  readonly hiddenCardCount: number;
  readonly allowed: boolean;
  readonly reason: string | null;
}

/** Measure the same complete scene as the exporter, including routed links and
 * labels. Folded cards are counted once each, rather than adding the overlapping
 * descendant counts stored on nested chapter groups. Invalid geometry still
 * fails through the export builder; size failures retain their actual bounds. */
export function preflightCanvasExport(
  cards: readonly CanvasSceneCard[],
  links: readonly CanvasSceneLink[],
  options: CanvasExportOptions = {},
): CanvasExportPreflight {
  const scene = buildCanvasExportScene(cards, links, options);
  const result = {
    width: Math.ceil(scene.bounds.width),
    height: Math.ceil(scene.bounds.height),
    visibleCardCount: scene.cards.length,
    linkCount: scene.links.length,
    hiddenCardCount: cards.length - scene.cards.length,
  };
  try {
    assertCanvasExportSize(scene.bounds);
    return { ...result, allowed: true, reason: null };
  } catch (error) {
    return { ...result, allowed: false, reason: (error as Error).message };
  }
}
