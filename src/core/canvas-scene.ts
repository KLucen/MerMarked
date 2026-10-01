import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import type { CanvasBinding, CanvasState } from './canvas-state.ts';
import type { SectionTree } from './sections.ts';

export interface CanvasSceneCard {
  readonly id: string;
  readonly sectionIndex: number | null;
  readonly parentId?: string;
  readonly hidden: boolean;
  readonly width: number;
  readonly height: number;
  readonly hiddenDescendants: number;
  readonly position: { readonly x: number; readonly y: number };
}

export interface CanvasSceneLink {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly hiddenEndpoint: boolean;
}

export function buildCanvasScene(tree: SectionTree, state: CanvasState, bindings: readonly CanvasBinding[], minimumHeights: Readonly<Record<string, number>> = {}): {
  readonly cards: readonly CanvasSceneCard[]; readonly links: readonly CanvasSceneLink[];
} {
  const cardById = new Map(state.cards.map((card) => [card.id, card]));
  const idBySection = new Map(bindings.filter((binding) => binding.sectionIndex !== null).map((binding) => [binding.sectionIndex!, binding.id]));
  const result: CanvasSceneCard[] = [];
  for (const binding of [...bindings].sort((a, b) => (a.sectionIndex ?? Number.MAX_SAFE_INTEGER) - (b.sectionIndex ?? Number.MAX_SAFE_INTEGER))) {
    const section = binding.sectionIndex === null ? null : tree.sections[binding.sectionIndex];
    const parentId = section?.parentIndex === null || section?.parentIndex === undefined ? undefined : idBySection.get(section.parentIndex);
    let hidden = false;
    let ancestor = section?.parentIndex ?? null;
    while (ancestor !== null) {
      const ancestorId = idBySection.get(ancestor);
      if (ancestorId && cardById.get(ancestorId)?.collapsed) hidden = true;
      ancestor = tree.sections[ancestor].parentIndex;
    }
    const card = cardById.get(binding.id)!;
    const descendants = section ? tree.sections.filter((item) => item.index !== section.index &&
      item.headingRange.start >= section.headingRange.start && item.headingRange.start < section.subtreeRange.end).length : 0;
    result.push({ id: binding.id, sectionIndex: binding.sectionIndex, parentId, hidden, width: 300, height: Math.max(150, minimumHeights[binding.id] ?? 150),
      hiddenDescendants: card.collapsed ? descendants : 0,
      position: parentId ? { x: Math.max(24, card.position.x), y: Math.max(150, minimumHeights[parentId] ?? 150, card.position.y) } : card.position });
  }
  // Child sizes are known before measuring their containing card. Positions
  // remain relative and folds never rewrite saved coordinates.
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const current = result[index];
    const card = cardById.get(current.id)!;
    const children = result.filter((item) => item.parentId === current.id && !item.hidden);
    if (!card.collapsed && children.length) {
      result[index] = { ...current,
        width: Math.max(300, ...children.map((child) => child.position.x + child.width + 24)),
        height: Math.max(current.height, ...children.map((child) => child.position.y + child.height + 24)) };
    }
  }
  const scenes = new Map(result.map((card) => [card.id, card]));
  const visibleEndpoint = (id: string): string | null => {
    let card = scenes.get(id);
    while (card?.hidden) card = card.parentId ? scenes.get(card.parentId) : undefined;
    return card?.id ?? null;
  };
  const links = state.links.flatMap((link): CanvasSceneLink[] => {
    const from = visibleEndpoint(link.from);
    const to = visibleEndpoint(link.to);
    if (!from || !to) return [];
    return [{ ...link, from, to, hiddenEndpoint: from !== link.from || to !== link.to }];
  });
  return { cards: result, links };
}

/** Layout only when first opened without saved positions, or explicitly requested. */
export async function arrangeCanvas(tree: SectionTree, state: CanvasState, bindings: readonly CanvasBinding[], minimumHeights: Readonly<Record<string, number>> = {}): Promise<CanvasState> {
  const elk = new ELK();
  let model = state;
  const children = new Map<string | undefined, CanvasSceneCard[]>();
  for (const card of buildCanvasScene(tree, { ...state, cards: state.cards.map((item) => ({ ...item, collapsed: false })) }, bindings, minimumHeights).cards) {
    children.set(card.parentId, [...(children.get(card.parentId) ?? []), card]);
  }
  const sizes = new Map<string, { width: number; height: number }>();
  const layoutGroup = async (parentId: string | undefined): Promise<void> => {
    const group = children.get(parentId) ?? [];
    for (const card of group) await layoutGroup(card.id);
    if (!group.length) return;
    const graph = await elk.layout<ElkNode>({ id: 'root', layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '36', 'elk.layered.spacing.nodeNodeBetweenLayers': '36', 'elk.padding': '[top=0,left=0,bottom=0,right=0]' },
      children: group.map((card) => ({ id: card.id, ...(sizes.get(card.id) ?? { width: 300, height: Math.max(150, minimumHeights[card.id] ?? 150) }) })),
      edges: group.slice(1).map((card, index) => ({ id: `order-${index}`, sources: [group[index].id], targets: [card.id] })) });
    const parentHeight = parentId ? Math.max(150, minimumHeights[parentId] ?? 150) : 0;
    const positions = new Map(graph.children?.map((node) => [node.id, { x: (node.x ?? 0) + (parentId ? 24 : 0), y: (node.y ?? 0) + parentHeight }]));
    model = { ...model, cards: model.cards.map((card) => positions.has(card.id) ? { ...card, position: positions.get(card.id)! } : card) };
    if (parentId) sizes.set(parentId, { width: Math.max(300, (graph.width ?? 0) + 48), height: (graph.height ?? 150) + parentHeight + 24 });
  };
  await layoutGroup(undefined);
  return model;
}
