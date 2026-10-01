import type { CanvasAnchor, CanvasCard, CanvasLink, CanvasState } from './canvas-state.ts';
import { validateCanvasAnchor, validateCanvasState } from './canvas-state.ts';

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
