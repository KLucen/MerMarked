import type { SectionTree } from './sections.ts';
import type { SectionTransformOperation } from './section-transform.ts';

/** A canvas-space rectangle. Coordinates are in the same space as the cards. */
export interface CanvasRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CanvasCardRect {
  readonly id: string;
  readonly rect: CanvasRect;
  /** Optional section identity used to reject a card's own descendants. */
  readonly sectionIndex?: number | null;
}

export interface CanvasOverlapMetrics {
  readonly intersection: CanvasRect | null;
  readonly intersectionArea: number;
  /** Shared area divided by the dragged card area. */
  readonly sourceCoverage: number;
  /** Shared area divided by the target card area. */
  readonly targetCoverage: number;
  /** Shared area divided by the smaller card area. */
  readonly overlapRatio: number;
}

export interface CanvasOverlapCandidate extends CanvasOverlapMetrics {
  readonly sourceId: string;
  readonly targetId: string;
  readonly status: 'candidate' | 'ready';
  readonly dwellMs: number;
}

export interface OverlapCandidateOptions {
  /** Ratio of the smaller card that must be covered. Defaults to 0.35. */
  readonly minimumRatio?: number;
  /** Avoid tiny accidental contact even when cards are very small. */
  readonly minimumArea?: number;
  /** Time the same overlap must remain stable before it can be confirmed. */
  readonly dwellMs?: number;
  /** Ratio at which the UI can switch from a soft hint to a confirmable target. */
  readonly readyRatio?: number;
  /** Optional source/target semantic guard supplied by the section binding. */
  readonly isEligible?: (source: CanvasCardRect, target: CanvasCardRect) => boolean;
}

export interface OverlapDwellState {
  readonly sourceId: string;
  readonly targetId: string;
  readonly startedAt: number;
}

export interface OverlapDwellResult {
  readonly state: OverlapDwellState | null;
  readonly dwellMs: number;
  readonly status: 'none' | 'candidate' | 'ready';
}

const DEFAULT_MINIMUM_RATIO = 0.35;
const DEFAULT_READY_RATIO = 0.5;
const DEFAULT_DWELL_MS = 280;
const EPSILON = 1e-9;

function area(rect: CanvasRect): number {
  return Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0
    ? rect.width * rect.height : 0;
}

function validRect(rect: CanvasRect): boolean {
  return Number.isFinite(rect.x) && Number.isFinite(rect.y) && area(rect) > 0;
}

/** Computes symmetric area metrics without mutating either input rectangle. */
export function measureCanvasOverlap(source: CanvasRect, target: CanvasRect): CanvasOverlapMetrics {
  if (!validRect(source) || !validRect(target)) {
    return { intersection: null, intersectionArea: 0, sourceCoverage: 0, targetCoverage: 0, overlapRatio: 0 };
  }
  const left = Math.max(source.x, target.x);
  const top = Math.max(source.y, target.y);
  const right = Math.min(source.x + source.width, target.x + target.width);
  const bottom = Math.min(source.y + source.height, target.y + target.height);
  const width = right - left;
  const height = bottom - top;
  const intersectionArea = width > 0 && height > 0 ? width * height : 0;
  const sourceArea = area(source);
  const targetArea = area(target);
  return {
    intersection: intersectionArea > 0 ? { x: left, y: top, width, height } : null,
    intersectionArea,
    sourceCoverage: intersectionArea / sourceArea,
    targetCoverage: intersectionArea / targetArea,
    overlapRatio: intersectionArea / Math.min(sourceArea, targetArea),
  };
}

function normalizedOptions(options: OverlapCandidateOptions): Required<OverlapCandidateOptions> {
  const minimumRatio = options.minimumRatio ?? DEFAULT_MINIMUM_RATIO;
  const readyRatio = options.readyRatio ?? Math.max(minimumRatio, DEFAULT_READY_RATIO);
  const dwellMs = options.dwellMs ?? DEFAULT_DWELL_MS;
  const minimumArea = options.minimumArea ?? 1;
  if (!Number.isFinite(minimumRatio) || minimumRatio < 0 || minimumRatio > 1 ||
    !Number.isFinite(readyRatio) || readyRatio < minimumRatio || readyRatio > 1 ||
    !Number.isFinite(dwellMs) || dwellMs < 0 || !Number.isFinite(minimumArea) || minimumArea < 0) {
    throw new Error('重叠候选阈值无效。');
  }
  return { minimumRatio, readyRatio, dwellMs, minimumArea, isEligible: options.isEligible ?? (() => true) };
}

/**
 * Finds the best structural target under a dragged card. The result is only a
 * visual candidate; callers must still show a source preview and explicitly
 * confirm the Markdown transform.
 */
export function findCanvasOverlapCandidate(
  source: CanvasCardRect,
  targets: readonly CanvasCardRect[],
  options: OverlapCandidateOptions = {},
): CanvasOverlapCandidate | null {
  const { minimumRatio, readyRatio, isEligible } = normalizedOptions(options);
  const candidates = targets
    .filter((target) => target.id !== source.id && isEligible(source, target))
    .map((target) => ({ target, metrics: measureCanvasOverlap(source.rect, target.rect) }))
    .filter(({ metrics }) => metrics.intersectionArea >= (options.minimumArea ?? 1) && metrics.overlapRatio + EPSILON >= minimumRatio)
    .sort((left, right) => right.metrics.overlapRatio - left.metrics.overlapRatio || right.metrics.intersectionArea - left.metrics.intersectionArea);
  const best = candidates[0];
  if (!best) return null;
  return { sourceId: source.id, targetId: best.target.id, ...best.metrics,
    status: best.metrics.overlapRatio + EPSILON >= readyRatio ? 'ready' : 'candidate', dwellMs: 0 };
}

/**
 * Semantic guard for a move candidate. It mirrors the structural transform's
 * self/current-parent/descendant checks without creating a Markdown candidate.
 */
export function isCanvasStructureTargetAllowed(tree: SectionTree, sourceIndex: number, targetIndex: number): boolean {
  const source = tree.sections[sourceIndex];
  const target = tree.sections[targetIndex];
  if (!source || !target || sourceIndex === targetIndex || source.parentIndex === targetIndex) return false;
  let ancestor: number | null = target.parentIndex;
  while (ancestor !== null) {
    if (ancestor === sourceIndex) return false;
    ancestor = tree.sections[ancestor]?.parentIndex ?? null;
  }
  return !(
    target.headingRange.start >= source.headingRange.start &&
    target.headingRange.start < source.subtreeRange.end
  );
}

/**
 * Tracks stable overlap by identity. Moving to another target or dropping
 * below the threshold resets the timer, preventing a transient crossing from
 * creating a structural command.
 */
export function updateCanvasOverlapDwell(
  previous: OverlapDwellState | null,
  candidate: CanvasOverlapCandidate | null,
  nowMs: number,
  options: OverlapCandidateOptions = {},
): OverlapDwellResult {
  const { dwellMs, readyRatio } = normalizedOptions(options);
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error('重叠停留时间无效。');
  if (!candidate) return { state: null, dwellMs: 0, status: 'none' };
  const same = previous?.sourceId === candidate.sourceId && previous.targetId === candidate.targetId;
  const state = same && previous ? previous : { sourceId: candidate.sourceId, targetId: candidate.targetId, startedAt: nowMs };
  const elapsed = Math.max(0, nowMs - state.startedAt);
  const ready = candidate.overlapRatio + EPSILON >= readyRatio && elapsed + EPSILON >= dwellMs;
  return { state, dwellMs: elapsed, status: ready ? 'ready' : 'candidate' };
}

export interface DragOutPromotionCandidate {
  readonly sourceIndex: number;
  readonly parentIndex: number;
  readonly escapeRatio: number;
  readonly status: 'candidate' | 'ready';
  readonly dwellMs: number;
  readonly operation: Extract<SectionTransformOperation, { kind: 'promote' }>;
}

export interface DragOutPromotionOptions {
  /** Portion of the child card outside its parent needed to show a hint. */
  readonly minimumEscapeRatio?: number;
  /** Portion outside the parent needed before the operation can be confirmed. */
  readonly readyEscapeRatio?: number;
  readonly dwellMs?: number;
  /** `top-level` makes the detached card independent from every parent. */
  readonly destination?: 'top-level' | 'one-level';
}

const DEFAULT_ESCAPE_RATIO = 0.35;
const DEFAULT_READY_ESCAPE_RATIO = 0.7;

/**
 * Determines whether a nested card has visibly left its direct parent. This
 * does not alter the canvas or Markdown; it produces a preview operation that
 * the caller may pass to `previewSectionTransform`.
 */
export function evaluateDragOutPromotion(
  tree: SectionTree,
  sourceIndex: number,
  sourceRect: CanvasRect,
  parentRect: CanvasRect,
  options: DragOutPromotionOptions = {},
): { readonly parentIndex: number; readonly escapeRatio: number; readonly operation: Extract<SectionTransformOperation, { kind: 'promote' }> } | null {
  const section = tree.sections[sourceIndex];
  if (!section || section.parentIndex === null || !validRect(sourceRect) || !validRect(parentRect)) return null;
  const escapeRatio = Math.max(0, Math.min(1, 1 - measureCanvasOverlap(sourceRect, parentRect).sourceCoverage));
  const destination = options.destination ?? 'top-level';
  const targetDepth = destination === 'one-level' ? Math.max(1, section.depth - 1) : 1;
  return { parentIndex: section.parentIndex, escapeRatio,
    operation: { kind: 'promote', sectionIndex: sourceIndex, targetDepth } };
}

/** Applies dwell thresholds to a drag-out sample while retaining the same operation semantics. */
export function classifyDragOutPromotion(
  sample: ReturnType<typeof evaluateDragOutPromotion>,
  previous: OverlapDwellState | null,
  sourceId: string,
  nowMs: number,
  options: DragOutPromotionOptions = {},
): { readonly state: OverlapDwellState | null; readonly status: 'none' | 'candidate' | 'ready'; readonly candidate: DragOutPromotionCandidate | null } {
  const minimumEscapeRatio = options.minimumEscapeRatio ?? DEFAULT_ESCAPE_RATIO;
  const readyEscapeRatio = options.readyEscapeRatio ?? Math.max(minimumEscapeRatio, DEFAULT_READY_ESCAPE_RATIO);
  const dwellMs = options.dwellMs ?? DEFAULT_DWELL_MS;
  if (!Number.isFinite(minimumEscapeRatio) || minimumEscapeRatio < 0 || minimumEscapeRatio > 1 ||
    !Number.isFinite(readyEscapeRatio) || readyEscapeRatio < minimumEscapeRatio || readyEscapeRatio > 1 ||
    !Number.isFinite(dwellMs) || dwellMs < 0) throw new Error('拖出提升阈值无效。');
  if (!sample || sample.escapeRatio < minimumEscapeRatio) return { state: null, status: 'none', candidate: null };
  const targetId = `parent:${sample.parentIndex}`;
  const state = previous?.sourceId === sourceId && previous.targetId === targetId
    ? previous : { sourceId, targetId, startedAt: nowMs };
  const elapsed = Math.max(0, nowMs - state.startedAt);
  const ready = sample.escapeRatio >= readyEscapeRatio && elapsed >= dwellMs;
  return { state, status: ready ? 'ready' : 'candidate', candidate: {
    sourceIndex: sample.operation.sectionIndex, parentIndex: sample.parentIndex, escapeRatio: sample.escapeRatio,
    status: ready ? 'ready' : 'candidate', dwellMs: elapsed, operation: sample.operation,
  } };
}
