import { canvasCardContent } from './canvas-card-content.ts';
import type { CanvasBinding } from './canvas-state.ts';
import type { CanvasStateV2 } from './canvas-state-v2.ts';
import { CANVAS_DEFAULT_CARD_SIZE } from './canvas-state-v2.ts';
import type { SectionTree } from './sections.ts';

export const CANVAS_GROUP_PREFIX = 'group:';
export const CANVAS_CONTENT_PREFIX = 'content:';

export interface CanvasSceneV2Group {
  readonly id: string;
  readonly cardId: string;
  readonly sectionIndex: number | null;
  readonly parentId?: string;
  readonly hidden: boolean;
  readonly hiddenDescendants: number;
  readonly position: { readonly x: number; readonly y: number };
  readonly width: number;
  readonly height: number;
}

export interface CanvasSceneV2Content {
  readonly id: string;
  readonly cardId: string;
  readonly groupId: string;
  readonly sectionIndex: number | null;
  readonly hidden: boolean;
  readonly position: { readonly x: number; readonly y: number };
  readonly width: number;
  readonly height: number;
  readonly bodyDisplay: CanvasStateV2['cards'][number]['bodyDisplay'];
  readonly title: string;
  readonly summary: string;
  readonly childCount: number;
}

export interface CanvasSceneV2Link {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly hiddenEndpoint: boolean;
}

/** Compatibility projection consumed by the current React Flow adapter while
 * the group boundary nodes are introduced in the next canvas slice. */
export interface CanvasSceneV2Card {
  readonly id: string;
  readonly sectionIndex: number | null;
  readonly parentId?: string;
  readonly hidden: boolean;
  readonly width: number;
  readonly height: number;
  readonly hiddenDescendants: number;
  readonly position: { readonly x: number; readonly y: number };
  readonly contentPosition: { readonly x: number; readonly y: number };
  readonly size: { readonly width: number; readonly height: number };
  readonly bodyDisplay: CanvasStateV2['cards'][number]['bodyDisplay'];
  readonly descendantsCollapsed: boolean;
}

export interface CanvasSceneV2 {
  readonly groups: readonly CanvasSceneV2Group[];
  readonly contents: readonly CanvasSceneV2Content[];
  readonly cards: readonly CanvasSceneV2Card[];
  readonly links: readonly CanvasSceneV2Link[];
}

export interface CanvasViewportLike {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface CanvasSceneBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Return the scene bounds in React Flow's world coordinates. Child cards use
 * coordinates relative to their parent group, so their ancestors are folded
 * into the result before calculating the bounds.
 */
export function canvasSceneBounds(cards: readonly CanvasSceneV2Card[]): CanvasSceneBounds | null {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const cache = new Map<string, { x: number; y: number }>();
  const absolutePosition = (card: CanvasSceneV2Card, visiting = new Set<string>()): { x: number; y: number } => {
    const cached = cache.get(card.id);
    if (cached) return cached;
    if (visiting.has(card.id) || !card.parentId) {
      const result = { x: card.position.x, y: card.position.y };
      cache.set(card.id, result);
      return result;
    }
    visiting.add(card.id);
    const parent = byId.get(card.parentId);
    const parentPosition = parent ? absolutePosition(parent, visiting) : { x: 0, y: 0 };
    const result = { x: parentPosition.x + card.position.x, y: parentPosition.y + card.position.y };
    cache.set(card.id, result);
    return result;
  };
  const visible = cards.filter((card) => !card.hidden);
  if (!visible.length) return null;
  const positions = visible.map((card) => ({ card, position: absolutePosition(card) }));
  const left = Math.min(...positions.map(({ position }) => position.x));
  const top = Math.min(...positions.map(({ position }) => position.y));
  const right = Math.max(...positions.map(({ card, position }) => position.x + card.width));
  const bottom = Math.max(...positions.map(({ card, position }) => position.y + card.height));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/**
 * A persisted viewport is usable only when its visible world rectangle
 * intersects the current scene. This protects against stale sidecars that
 * restore a valid-but-useless transform far away from the current cards.
 */
export function isCanvasViewportVisible(
  viewport: CanvasViewportLike,
  cards: readonly CanvasSceneV2Card[],
  viewportWidth = 1_200,
  viewportHeight = 800,
): boolean {
  if (!Number.isFinite(viewport.x) || !Number.isFinite(viewport.y) || !Number.isFinite(viewport.zoom) || viewport.zoom <= 0 ||
    !Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight) || viewportWidth <= 0 || viewportHeight <= 0) return false;
  const bounds = canvasSceneBounds(cards);
  if (!bounds) return false;
  const view = { x: -viewport.x / viewport.zoom, y: -viewport.y / viewport.zoom,
    width: viewportWidth / viewport.zoom, height: viewportHeight / viewport.zoom };
  return view.x < bounds.x + bounds.width && view.x + view.width > bounds.x &&
    view.y < bounds.y + bounds.height && view.y + view.height > bounds.y;
}

function groupId(cardId: string): string { return `${CANVAS_GROUP_PREFIX}${cardId}`; }
function contentId(cardId: string): string { return `${CANVAS_CONTENT_PREFIX}${cardId}`; }

/**
 * Projects the persistent v2 model into two visual responsibilities: a
 * chapter group boundary and an independently positioned content card. Group
 * coordinates remain the persisted chapter position while content coordinates
 * remain local to that group, so a parent card can move within its group.
 */
export function buildCanvasSceneV2(
  content: string,
  tree: SectionTree,
  state: CanvasStateV2,
  bindings: readonly CanvasBinding[],
  minimumHeights: Readonly<Record<string, number>> = {},
): CanvasSceneV2 {
  const cardById = new Map(state.cards.map((card) => [card.id, card]));
  const idBySection = new Map(bindings.filter((item) => item.sectionIndex !== null).map((item) => [item.sectionIndex!, item.id]));
  const sectionByCard = new Map(bindings.map((item) => [item.id, item.sectionIndex]));
  const groups: CanvasSceneV2Group[] = [];
  const contents: CanvasSceneV2Content[] = [];
  const hiddenById = new Map<string, boolean>();

  for (const binding of bindings) {
    const card = cardById.get(binding.id);
    if (!card) continue;
    const section = binding.sectionIndex === null ? null : tree.sections[binding.sectionIndex];
    let hidden = false;
    let ancestor = section?.parentIndex ?? null;
    while (ancestor !== null) {
      const ancestorId = idBySection.get(ancestor);
      if (ancestorId && cardById.get(ancestorId)?.descendantsCollapsed) hidden = true;
      ancestor = tree.sections[ancestor].parentIndex;
    }
    hiddenById.set(binding.id, hidden);
    const parentCardId = section?.parentIndex === null || section?.parentIndex === undefined
      ? undefined : idBySection.get(section.parentIndex);
    const hiddenDescendants = section
      ? tree.sections.filter((item) => item.index !== section.index && item.headingRange.start >= section.headingRange.start && item.headingRange.start < section.subtreeRange.end).length
      : 0;
    const preferredSize = card.size ?? CANVAS_DEFAULT_CARD_SIZE;
    const bodyHeight = card.bodyDisplay === 'full' ? Math.max(preferredSize.height, 220, minimumHeights[binding.id] ?? 220)
      : Math.max(preferredSize.height, 176);
    groups.push({ id: groupId(binding.id), cardId: binding.id, sectionIndex: binding.sectionIndex,
      ...(parentCardId ? { parentId: groupId(parentCardId) } : {}), hidden,
      hiddenDescendants: card.descendantsCollapsed ? hiddenDescendants : 0,
      position: { ...card.position }, width: 360, height: bodyHeight + 80 });
    const cardContent = canvasCardContent(content, tree, binding.sectionIndex);
    contents.push({ id: contentId(binding.id), cardId: binding.id, groupId: groupId(binding.id), sectionIndex: binding.sectionIndex,
      hidden, position: { x: Math.max(16, card.contentPosition.x), y: Math.max(38, card.contentPosition.y) },
      width: preferredSize.width, height: bodyHeight, bodyDisplay: card.bodyDisplay,
      title: cardContent.title, summary: cardContent.summary, childCount: cardContent.childCount });
  }

  // Grow group boundaries around visible child groups without mutating saved
  // coordinates. The content card itself can remain anywhere inside the box.
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const current = groups[index];
    const children = groups.filter((item) => item.parentId === current.id && !item.hidden);
    const childContent = contents.find((item) => item.groupId === current.id);
    const width = Math.max(current.width, (childContent?.position.x ?? 16) + (childContent?.width ?? 328) + 16,
      ...children.map((child) => child.position.x + child.width + 16));
    const height = Math.max(current.height, (childContent?.position.y ?? 38) + (childContent?.height ?? 176) + 16,
      ...children.map((child) => child.position.y + child.height + 16));
    groups[index] = { ...current, width, height };
  }

  const visibleEndpoint = (cardId: string): string | null => {
    let current = cardId;
    while (hiddenById.get(current)) {
      const sectionIndex = sectionByCard.get(current);
      if (sectionIndex === null || sectionIndex === undefined) return null;
      const parentIndex = tree.sections[sectionIndex].parentIndex;
      if (parentIndex === null) return null;
      const parentId = idBySection.get(parentIndex);
      if (!parentId) return null;
      current = parentId;
    }
    return current;
  };
  const links = state.links.flatMap((link): CanvasSceneV2Link[] => {
    const from = visibleEndpoint(link.from);
    const to = visibleEndpoint(link.to);
    if (!from || !to) return [];
    return [{ ...link, from, to, hiddenEndpoint: from !== link.from || to !== link.to }];
  });
  const cards = groups.map((group): CanvasSceneV2Card => {
    const content = contents.find((item) => item.cardId === group.cardId)!;
    const parentGroup = groups.find((item) => item.id === group.parentId);
    return { id: group.cardId, sectionIndex: group.sectionIndex, ...(parentGroup ? { parentId: parentGroup.cardId } : {}),
      hidden: group.hidden, width: group.width, height: group.height, hiddenDescendants: group.hiddenDescendants,
      position: { ...group.position }, contentPosition: { ...content.position }, size: { width: content.width, height: content.height },
      bodyDisplay: content.bodyDisplay,
      descendantsCollapsed: cardById.get(group.cardId)!.descendantsCollapsed };
  });
  return { groups, contents, cards, links };
}

