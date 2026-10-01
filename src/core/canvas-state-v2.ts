import type { CanvasAnchor, CanvasCard, CanvasLink, CanvasState } from './canvas-state.ts';
import { arrangeCanvas, buildCanvasScene } from './canvas-scene.ts';
import { mapCanvasThroughSectionTransform, parseCanvasJson, reconcileCanvasState, serializeCanvasJson, validateCanvasAnchor, validateCanvasState } from './canvas-state.ts';
import type { AnnotationRelocationSource } from './annotation-relocation.ts';
import type { ReadySectionTransformPreview } from './section-transform.ts';

export const CANVAS_SCHEMA_VERSION_V2 = 2 as const;
export const CANVAS_BODY_DISPLAYS = ['hidden', 'preview', 'full'] as const;
export type CanvasBodyDisplay = typeof CANVAS_BODY_DISPLAYS[number];

export interface CanvasCardV2 {
  readonly id: string;
  readonly anchor: CanvasAnchor;
  /** Relative position of the chapter group in its derived Markdown parent. */
  readonly position: { readonly x: number; readonly y: number };
  /** Position of this chapter's content card inside its own derived group. */
  readonly contentPosition: { readonly x: number; readonly y: number };
  readonly bodyDisplay: CanvasBodyDisplay;
  readonly descendantsCollapsed: boolean;
}

export interface CanvasStateV2 {
  readonly schemaVersion: typeof CANVAS_SCHEMA_VERSION_V2;
  readonly source: CanvasState['source'];
  readonly cards: readonly CanvasCardV2[];
  readonly links: readonly CanvasLink[];
  readonly viewport: CanvasState['viewport'];
}

export interface ReconciledCanvasV2 {
  readonly model: CanvasStateV2;
  readonly bindings: readonly { readonly id: string; readonly sectionIndex: number | null; readonly kind: CanvasAnchor['kind'] }[];
  readonly unresolvedCardIds: readonly string[];
  readonly unresolvedLinkIds: readonly string[];
}

const encoder = new TextEncoder();
const hashPattern = /^[0-9a-f]{64}$/;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const maxPosition = 1_000_000;

function invalid(): never {
  throw new Error('画布 v2 JSON 格式或版本无效，未修改文件。');
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== fields.length || fields.some((field) => !Object.hasOwn(result, field))) invalid();
  return result;
}

function finiteNumber(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid();
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !hashPattern.test(value)) invalid();
  return value;
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !idPattern.test(value)) invalid();
  return value;
}

function text(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.includes('\0') || encoder.encode(value).length > maxBytes ||
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(encoder.encode(value)) !== value) invalid();
  return value;
}

function cloneAnchor(value: CanvasAnchor): CanvasAnchor {
  return value.kind === 'heading'
    ? { ...value, titlePath: [...value.titlePath] }
    : { ...value };
}

function source(value: unknown): CanvasState['source'] {
  const entry = record(value, ['sha256', 'encoding', 'coordinateSystem']);
  if (entry.encoding !== 'utf-8' || entry.coordinateSystem !== 'utf8-byte') invalid();
  return { sha256: hash(entry.sha256), encoding: 'utf-8', coordinateSystem: 'utf8-byte' };
}

function viewport(value: unknown): CanvasState['viewport'] {
  const entry = record(value, ['x', 'y', 'zoom']);
  return { x: finiteNumber(entry.x, -maxPosition, maxPosition), y: finiteNumber(entry.y, -maxPosition, maxPosition),
    zoom: finiteNumber(entry.zoom, 0.05, 8) };
}

function position(value: unknown): { readonly x: number; readonly y: number } {
  const entry = record(value, ['x', 'y']);
  return { x: finiteNumber(entry.x, -maxPosition, maxPosition), y: finiteNumber(entry.y, -maxPosition, maxPosition) };
}

function links(value: unknown, cardIds: ReadonlySet<string>): readonly CanvasLink[] {
  if (!Array.isArray(value) || value.length > 20_000) invalid();
  const linkIds = new Set<string>();
  return value.map((item): CanvasLink => {
    const entry = record(item, ['id', 'from', 'to', 'label']);
    const linkId = id(entry.id);
    const from = id(entry.from);
    const to = id(entry.to);
    if (linkIds.has(linkId) || !cardIds.has(from) || !cardIds.has(to)) invalid();
    linkIds.add(linkId);
    return { id: linkId, from, to, label: text(entry.label, 512) };
  });
}

export function validateCanvasStateV2(value: unknown): CanvasStateV2 {
  const entry = record(value, ['schemaVersion', 'source', 'cards', 'links', 'viewport']);
  if (entry.schemaVersion !== CANVAS_SCHEMA_VERSION_V2) invalid();
  const sourceValue = source(entry.source);
  if (!Array.isArray(entry.cards) || entry.cards.length > 10_000) invalid();
  const cardIds = new Set<string>();
  const cards = entry.cards.map((item): CanvasCardV2 => {
    const card = record(item, ['id', 'anchor', 'position', 'contentPosition', 'bodyDisplay', 'descendantsCollapsed']);
    const cardId = id(card.id);
    if (cardIds.has(cardId) || typeof card.descendantsCollapsed !== 'boolean' ||
      !CANVAS_BODY_DISPLAYS.includes(card.bodyDisplay as CanvasBodyDisplay)) invalid();
    cardIds.add(cardId);
    return { id: cardId, anchor: validateCanvasAnchor(card.anchor), position: position(card.position),
      contentPosition: position(card.contentPosition), bodyDisplay: card.bodyDisplay as CanvasBodyDisplay,
      descendantsCollapsed: card.descendantsCollapsed };
  });
  return { schemaVersion: CANVAS_SCHEMA_VERSION_V2, source: sourceValue, cards, links: links(entry.links, cardIds), viewport: viewport(entry.viewport) };
}

/**
 * Upgrade only in memory. The v1 file is not rewritten until a later explicit
 * canvas save, so opening an old file remains a zero-write operation.
 */
export function migrateCanvasStateV1ToV2(value: CanvasState): CanvasStateV2 {
  const state = validateCanvasState(value);
  return validateCanvasStateV2({
    schemaVersion: CANVAS_SCHEMA_VERSION_V2,
    source: state.source,
    cards: state.cards.map((card: CanvasCard) => ({
      id: card.id,
      anchor: cloneAnchor(card.anchor),
      position: { ...card.position },
      contentPosition: { x: 0, y: 0 },
      bodyDisplay: 'preview',
      descendantsCollapsed: card.collapsed,
    })),
    links: state.links.map((link) => ({ ...link })),
    viewport: { ...state.viewport },
  });
}

export function parseCanvasStateV2Json(serialized: string): CanvasStateV2 {
  if (encoder.encode(serialized).length > 4 * 1024 * 1024) invalid();
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { invalid(); }
  return validateCanvasStateV2(value);
}

export function serializeCanvasStateV2Json(value: CanvasStateV2): string {
  const serialized = `${JSON.stringify(validateCanvasStateV2(value), null, 2)}\n`;
  if (encoder.encode(serialized).length > 4 * 1024 * 1024) invalid();
  return serialized;
}

export type CanvasStateDocument = CanvasState | CanvasStateV2;

export function isCanvasStateV2(value: CanvasStateDocument | null): value is CanvasStateV2 {
  return value?.schemaVersion === CANVAS_SCHEMA_VERSION_V2;
}

/** Parse either persisted canvas generation without changing the older v1 parser contract. */
export function parseCanvasStateJson(serialized: string): CanvasStateDocument {
  let version: unknown;
  try { version = (JSON.parse(serialized) as { schemaVersion?: unknown }).schemaVersion; } catch {
    return parseCanvasJson(serialized);
  }
  return version === CANVAS_SCHEMA_VERSION_V2 ? parseCanvasStateV2Json(serialized) : parseCanvasJson(serialized);
}

export function serializeCanvasStateJson(value: CanvasStateDocument): string {
  return isCanvasStateV2(value) ? serializeCanvasStateV2Json(value) : serializeCanvasJson(value);
}

export function validateCanvasStateDocument(value: unknown): CanvasStateDocument {
  if (value !== null && typeof value === 'object' && (value as { schemaVersion?: unknown }).schemaVersion === CANVAS_SCHEMA_VERSION_V2) {
    return validateCanvasStateV2(value);
  }
  return validateCanvasState(value);
}

function asV1(state: CanvasStateV2, collapsed = false): CanvasState {
  return { schemaVersion: 1, source: state.source,
    cards: state.cards.map((card) => ({ id: card.id, anchor: card.anchor, position: card.position,
      collapsed: collapsed || card.descendantsCollapsed })), links: state.links, viewport: state.viewport };
}

function fromV1(state: CanvasState, previous: ReadonlyMap<string, CanvasCardV2>): CanvasStateV2 {
  return validateCanvasStateV2({ schemaVersion: CANVAS_SCHEMA_VERSION_V2, source: state.source,
    cards: state.cards.map((card) => {
      const old = previous.get(card.id);
      return { id: card.id, anchor: card.anchor, position: { ...card.position },
        contentPosition: old ? { ...old.contentPosition } : { x: 0, y: 0 },
        bodyDisplay: old?.bodyDisplay ?? 'preview', descendantsCollapsed: old?.descendantsCollapsed ?? card.collapsed };
    }), links: state.links.map((link) => ({ ...link })), viewport: { ...state.viewport } });
}

/** Reconcile Markdown identities while retaining the independent v2 presentation fields. */
export async function reconcileCanvasStateV2(
  state: CanvasStateV2 | null, source: AnnotationRelocationSource, makeId = () => globalThis.crypto.randomUUID(),
): Promise<ReconciledCanvasV2> {
  const previous = new Map(state?.cards.map((card) => [card.id, card]) ?? []);
  const reconciled = await reconcileCanvasState(state ? asV1(state) : null, source, makeId);
  return { model: fromV1(reconciled.model, previous), bindings: reconciled.bindings,
    unresolvedCardIds: reconciled.unresolvedCardIds, unresolvedLinkIds: reconciled.unresolvedLinkIds };
}

export async function arrangeCanvasV2(
  tree: Parameters<typeof buildCanvasScene>[0], state: CanvasStateV2, bindings: ReconciledCanvasV2['bindings'],
  minimumHeights: Readonly<Record<string, number>> = {},
): Promise<CanvasStateV2> {
  const arranged = await arrangeCanvas(tree, asV1(state), bindings, minimumHeights);
  return fromV1(arranged, new Map(state.cards.map((card) => [card.id, card])));
}

/** Structural mapping keeps v2-only presentation state on the verified card identity. */
export async function mapCanvasThroughSectionTransformV2(
  state: CanvasStateV2, before: AnnotationRelocationSource, after: AnnotationRelocationSource,
  preview: ReadySectionTransformPreview, makeId = () => globalThis.crypto.randomUUID(),
): Promise<ReconciledCanvasV2> {
  const mapped = await mapCanvasThroughSectionTransform(asV1(state), before, after, preview, makeId);
  return { ...mapped, model: fromV1(mapped.model, new Map(state.cards.map((card) => [card.id, card]))) };
}

/**
 * Projects a v2 card back to the v1 shape used by the conservative source
 * reconciliation code. The projection is intentionally lossy only for the
 * v2-only display fields; callers merge the reconciled anchors and positions
 * back into the original v2 records by stable card id.
 */
export function projectCanvasStateV2ToV1(value: CanvasStateV2): CanvasState {
  const state = validateCanvasStateV2(value);
  return {
    schemaVersion: 1,
    source: { ...state.source },
    cards: state.cards.map((card): CanvasCard => ({
      id: card.id,
      anchor: cloneAnchor(card.anchor),
      position: { ...card.position },
      collapsed: card.descendantsCollapsed,
    })),
    links: state.links.map((link): CanvasLink => ({ ...link })),
    viewport: { ...state.viewport },
  };
}

/**
 * Merges a verified v1 reconciliation result into a v2 model. Unknown or
 * unresolved cards keep their v2 display state and coordinates; newly created
 * cards receive the v2 defaults used by the in-memory migration.
 */
export function mergeCanvasStateV1Reconciliation(
  original: CanvasStateV2,
  reconciled: CanvasState,
): CanvasStateV2 {
  const state = validateCanvasStateV2(original);
  const next = validateCanvasState(reconciled);
  const oldById = new Map(state.cards.map((card) => [card.id, card]));
  return validateCanvasStateV2({
    schemaVersion: CANVAS_SCHEMA_VERSION_V2,
    source: { ...next.source },
    cards: next.cards.map((card) => {
      const previous = oldById.get(card.id);
      return {
        id: card.id,
        anchor: cloneAnchor(card.anchor),
        position: { ...card.position },
        contentPosition: previous ? { ...previous.contentPosition } : { x: 0, y: 0 },
        bodyDisplay: previous?.bodyDisplay ?? 'preview',
        descendantsCollapsed: previous?.descendantsCollapsed ?? card.collapsed,
      };
    }),
    links: next.links.map((link) => ({ ...link })),
    viewport: { ...next.viewport },
  });
}
