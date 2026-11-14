import type { CanvasBinding } from './canvas-state.ts';
import { CANVAS_DEFAULT_CARD_SIZE, type CanvasCardV2, type CanvasStateV2 } from './canvas-state-v2.ts';
import type { SectionTree } from './sections.ts';

const maximumPosition = 1_000_000;
const gap = 36;
type Point = { readonly x: number; readonly y: number };
interface Bounds { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
interface LayoutCard {
  readonly card: CanvasCardV2;
  readonly parentId: string | undefined;
  readonly sectionIndex: number | null;
  position: Point;
  width: number;
  height: number;
  bounds: Bounds;
}

function unavailable(): never {
  throw new Error('新增章节无法在画布坐标范围内安全放置，请调整现有布局后重试。');
}

function translated(bounds: Bounds, position: Point): Bounds {
  return { left: bounds.left + position.x, right: bounds.right + position.x,
    top: bounds.top + position.y, bottom: bounds.bottom + position.y };
}

function union(bounds: readonly Bounds[]): Bounds {
  return { left: Math.min(...bounds.map(item => item.left)), top: Math.min(...bounds.map(item => item.top)),
    right: Math.max(...bounds.map(item => item.right)), bottom: Math.max(...bounds.map(item => item.bottom)) };
}

function overlap(left: Bounds, right: Bounds): boolean {
  return left.left < right.right + gap && left.right + gap > right.left &&
    left.top < right.bottom + gap && left.bottom + gap > right.top;
}

/**
 * Place only newly bound identities, preserving all existing presentation data.
 * Positions are relative to the current Markdown parent, as in the v2 model.
 * Parent changes caused by source editing therefore still change world space.
 * Folded subtrees reserve space without requiring hidden DOM measurements.
 * No file is written and neither the model nor its input collections are mutated.
 */
export function placeNewCanvasCardsV2(
  content: string,
  tree: SectionTree,
  state: CanvasStateV2,
  bindings: readonly CanvasBinding[],
  knownCardIds: ReadonlySet<string>,
  minimumHeights: Readonly<Record<string, number>> = {},
): CanvasStateV2 {
  if (!bindings.some(binding => !knownCardIds.has(binding.id))) return state;
  if (tree.sourceLength !== content.length) throw new Error('新增章节布局与当前 Markdown 不一致。');
  const cardsById = new Map(state.cards.map(card => [card.id, card]));
  const idBySection = new Map(bindings.filter(binding => binding.sectionIndex !== null)
    .map(binding => [binding.sectionIndex!, binding.id]));
  if (idBySection.size !== bindings.filter(binding => binding.sectionIndex !== null).length) {
    throw new Error('新增章节布局的卡片身份无效。');
  }
  const groups = new Map<string | undefined, LayoutCard[]>();
  const nodes = new Map<string, LayoutCard>();
  for (const binding of bindings) {
    const card = cardsById.get(binding.id);
    const section = binding.sectionIndex === null ? null : tree.sections[binding.sectionIndex];
    if (!card || nodes.has(binding.id) || (binding.sectionIndex !== null && !section)) {
      throw new Error('新增章节布局的卡片身份无效。');
    }
    const parentId = section?.parentIndex === null || section?.parentIndex === undefined
      ? undefined : idBySection.get(section.parentIndex);
    if (section?.parentIndex !== null && section?.parentIndex !== undefined && !parentId) {
      throw new Error('新增章节布局缺少父章节。');
    }
    const node: LayoutCard = { card, parentId, sectionIndex: binding.sectionIndex, position: card.position,
      width: 0, height: 0, bounds: { left: 0, top: 0, right: 0, bottom: 0 } };
    nodes.set(card.id, node);
    const siblings = groups.get(parentId) ?? [];
    siblings.push(node); groups.set(parentId, siblings);
  }
  for (const siblings of groups.values()) siblings.sort((left, right) =>
    (left.sectionIndex ?? -1) - (right.sectionIndex ?? -1));

  const newPositions = new Map<string, Point>();
  const visiting = new Set<string>();
  const completed = new Set<string>();
  const layout = (parent: LayoutCard | undefined): void => {
    if (parent) {
      if (visiting.has(parent.card.id)) throw new Error('新增章节布局的层级无效。');
      visiting.add(parent.card.id);
    }
    const siblings = groups.get(parent?.card.id) ?? [];
    for (const sibling of siblings) layout(sibling);

    // Match v2 content/group geometry, extending the reservation for the actual
    // measured body where available. Folding affects display, not this reserve.
    const preferredSize = parent?.card.size ?? CANVAS_DEFAULT_CARD_SIZE;
    const measured = parent ? minimumHeights[parent.card.id] : undefined;
    if (measured !== undefined && (!Number.isFinite(measured) || measured <= 0)) unavailable();
    const contentX = parent ? Math.max(16, parent.card.contentPosition.x) : 0;
    const contentY = parent ? Math.max(38, parent.card.contentPosition.y) : 0;
    const bodyHeight = Math.max(preferredSize.height, parent?.card.bodyDisplay === 'full' ? 220 : 176,
      measured === undefined ? 0 : measured - 16);
    const ownContent: Bounds | undefined = parent ? { left: contentX, top: contentY,
      right: contentX + preferredSize.width, bottom: contentY + bodyHeight } : undefined;
    const occupied = siblings.filter(sibling => knownCardIds.has(sibling.card.id))
      .map(sibling => translated(sibling.bounds, sibling.position));
    if (ownContent) occupied.push(ownContent);
    let extent = occupied.length ? union(occupied) : null;
    const base = { x: parent ? 24 : 80, y: ownContent ? ownContent.bottom + gap : 80 };
    let hasPlacedNew = false;
    for (const sibling of siblings) {
      if (knownCardIds.has(sibling.card.id)) continue;
      // Four bounded exterior candidates avoid an unbounded packing/grid loop.
      // A conservative refusal is preferable to moving an existing card.
      const candidates: Point[] = extent ? [
        ...(ownContent && occupied.length === 1 && !hasPlacedNew ? [base] : []),
        { x: Math.max(base.x, extent.right + gap - sibling.bounds.left), y: base.y },
        { x: base.x, y: Math.max(base.y, extent.bottom + gap - sibling.bounds.top) },
        { x: Math.min(base.x, extent.left - gap - sibling.bounds.right), y: base.y },
        { x: base.x, y: Math.min(base.y, extent.top - gap - sibling.bounds.bottom) },
      ] : [base];
      const position = candidates.find(candidate => Number.isFinite(candidate.x) && Number.isFinite(candidate.y) &&
        candidate.x >= (parent ? 24 : -maximumPosition) && candidate.x <= maximumPosition &&
        candidate.y >= (parent ? base.y : -maximumPosition) && candidate.y <= maximumPosition &&
        (!extent || !overlap(translated(sibling.bounds, candidate), extent)));
      if (!position) unavailable();
      sibling.position = position;
      newPositions.set(sibling.card.id, position);
      hasPlacedNew = true;
      const placed = translated(sibling.bounds, position);
      extent = extent ? union([extent, placed]) : placed;
    }
    if (parent) {
      parent.width = Math.max(360, ownContent!.right + 16,
        ...siblings.map(child => child.position.x + child.width + 16));
      parent.height = Math.max(bodyHeight + 80, ownContent!.bottom + 16,
        ...siblings.map(child => child.position.y + child.height + 16));
      parent.bounds = union([{ left: 0, top: 0, right: parent.width, bottom: parent.height },
        ...siblings.map(child => translated(child.bounds, child.position))]);
      visiting.delete(parent.card.id); completed.add(parent.card.id);
    }
  };
  layout(undefined);
  if (completed.size !== nodes.size) throw new Error('新增章节布局的层级无效。');
  return { ...state, cards: state.cards.map(card => {
    const position = newPositions.get(card.id);
    return position ? { ...card, position } : card;
  }) };
}
