import { extractSections } from './sections.ts';
import type { SectionTree } from './sections.ts';
import type { AnnotationRelocationSource } from './annotation-relocation.ts';
import { previewSectionTransform } from './section-transform.ts';
import type { ReadySectionTransformPreview } from './section-transform.ts';

export const MAX_CANVAS_JSON_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const hashPattern = /^[0-9a-f]{64}$/;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export interface CanvasHeadingAnchor {
  readonly kind: 'heading';
  readonly basisSha256: string;
  readonly titlePath: readonly string[];
  readonly depth: number;
  readonly startByte: number;
  readonly endByte: number;
  readonly headingExact: string;
  readonly bodySha256: string;
}

export interface CanvasVirtualAnchor {
  readonly kind: 'preamble' | 'whole-document';
  readonly basisSha256: string;
  readonly bodySha256: string;
}

export type CanvasAnchor = CanvasHeadingAnchor | CanvasVirtualAnchor;

export interface CanvasCard {
  readonly id: string;
  readonly anchor: CanvasAnchor;
  /** Relative to the derived Markdown parent, never a second hierarchy. */
  readonly position: { readonly x: number; readonly y: number };
  readonly collapsed: boolean;
}

export interface CanvasLink {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label: string;
}

export interface CanvasState {
  readonly schemaVersion: 1;
  readonly source: { readonly sha256: string; readonly encoding: 'utf-8'; readonly coordinateSystem: 'utf8-byte' };
  /** Unresolved cards remain here so their positions and link endpoints survive. */
  readonly cards: readonly CanvasCard[];
  readonly links: readonly CanvasLink[];
  readonly viewport: { readonly x: number; readonly y: number; readonly zoom: number };
}

export interface CanvasBinding {
  readonly id: string;
  readonly sectionIndex: number | null;
  readonly kind: CanvasAnchor['kind'];
}

export interface ReconciledCanvas {
  readonly model: CanvasState;
  readonly bindings: readonly CanvasBinding[];
  readonly unresolvedCardIds: readonly string[];
  readonly unresolvedLinkIds: readonly string[];
}

interface Descriptor {
  readonly sectionIndex: number | null;
  readonly anchor: CanvasAnchor;
}

function invalid(): never { throw new Error('画布 JSON 格式或版本无效，未修改文件。'); }

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== fields.length || fields.some((field) => !Object.hasOwn(result, field))) invalid();
  return result;
}

function text(value: unknown, limit: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.length) || value.includes('\0') || encoder.encode(value).length > limit ||
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(encoder.encode(value)) !== value) invalid();
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

function number(value: unknown, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) invalid();
  return value;
}

function anchor(value: unknown): CanvasAnchor {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind === 'heading') {
    const entry = record(value, ['kind', 'basisSha256', 'titlePath', 'depth', 'startByte', 'endByte', 'headingExact', 'bodySha256']);
    if (!Array.isArray(entry.titlePath) || entry.titlePath.length < 1 || entry.titlePath.length > 6) invalid();
    const startByte = number(entry.startByte, 0, Number.MAX_SAFE_INTEGER, true);
    const endByte = number(entry.endByte, startByte + 1, Number.MAX_SAFE_INTEGER, true);
    const headingExact = text(entry.headingExact, 16_384);
    if (encoder.encode(headingExact).length !== endByte - startByte) invalid();
    return { kind, basisSha256: hash(entry.basisSha256), titlePath: entry.titlePath.map((item) => text(item, 4096, true)),
      depth: number(entry.depth, 1, 6, true), startByte, endByte, headingExact, bodySha256: hash(entry.bodySha256) };
  }
  if (kind !== 'preamble' && kind !== 'whole-document') invalid();
  const entry = record(value, ['kind', 'basisSha256', 'bodySha256']);
  return { kind, basisSha256: hash(entry.basisSha256), bodySha256: hash(entry.bodySha256) };
}

/** Shared strict anchor validation for newer in-memory canvas projections. */
export function validateCanvasAnchor(value: unknown): CanvasAnchor {
  return anchor(value);
}

export function validateCanvasState(value: unknown): CanvasState {
  const entry = record(value, ['schemaVersion', 'source', 'cards', 'links', 'viewport']);
  if (entry.schemaVersion !== 1) invalid();
  const source = record(entry.source, ['sha256', 'encoding', 'coordinateSystem']);
  if (source.encoding !== 'utf-8' || source.coordinateSystem !== 'utf8-byte') invalid();
  if (!Array.isArray(entry.cards) || entry.cards.length > 10_000 || !Array.isArray(entry.links) || entry.links.length > 20_000) invalid();
  const cardIds = new Set<string>();
  const cards = entry.cards.map((value): CanvasCard => {
    const card = record(value, ['id', 'anchor', 'position', 'collapsed']);
    const cardId = id(card.id);
    if (cardIds.has(cardId) || typeof card.collapsed !== 'boolean') invalid();
    cardIds.add(cardId);
    const position = record(card.position, ['x', 'y']);
    return { id: cardId, anchor: anchor(card.anchor),
      position: { x: number(position.x, -1_000_000, 1_000_000), y: number(position.y, -1_000_000, 1_000_000) }, collapsed: card.collapsed };
  });
  const linkIds = new Set<string>();
  const links = entry.links.map((value): CanvasLink => {
    const link = record(value, ['id', 'from', 'to', 'label']);
    const linkId = id(link.id);
    const from = id(link.from);
    const to = id(link.to);
    if (linkIds.has(linkId) || !cardIds.has(from) || !cardIds.has(to)) invalid();
    linkIds.add(linkId);
    return { id: linkId, from, to, label: text(link.label, 512, true) };
  });
  const viewport = record(entry.viewport, ['x', 'y', 'zoom']);
  return { schemaVersion: 1, source: { sha256: hash(source.sha256), encoding: 'utf-8', coordinateSystem: 'utf8-byte' }, cards, links,
    viewport: { x: number(viewport.x, -1_000_000, 1_000_000), y: number(viewport.y, -1_000_000, 1_000_000), zoom: number(viewport.zoom, 0.05, 8) } };
}

export function parseCanvasJson(source: string): CanvasState {
  if (encoder.encode(source).length > MAX_CANVAS_JSON_BYTES) invalid();
  let value: unknown;
  try { value = JSON.parse(source); } catch { invalid(); }
  return validateCanvasState(value);
}

export function serializeCanvasJson(value: CanvasState): string {
  const source = `${JSON.stringify(validateCanvasState(value), null, 2)}\n`;
  if (encoder.encode(source).length > MAX_CANVAS_JSON_BYTES) invalid();
  return source;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const result = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function descriptors(source: AnnotationRelocationSource): Promise<{ tree: SectionTree; entries: Descriptor[] }> {
  if (!hashPattern.test(source.sha256) || await digest(source.bytes) !== source.sha256 ||
    new TextDecoder('utf-8', { fatal: true }).decode(source.bytes) !== source.content) invalid();
  const bom = source.bytes[0] === 0xef && source.bytes[1] === 0xbb && source.bytes[2] === 0xbf ? 3 : 0;
  const tree = extractSections(source.content);
  const entries: Descriptor[] = [];
  let offset = 0;
  let byteOffset = bom;
  for (const section of tree.sections) {
    const path: string[] = [];
    let ancestor: number | null = section.index;
    while (ancestor !== null) { path.unshift(tree.sections[ancestor].title); ancestor = tree.sections[ancestor].parentIndex; }
    byteOffset += encoder.encode(source.content.slice(offset, section.headingRange.start)).length;
    const headingExact = source.content.slice(section.headingRange.start, section.headingRange.end);
    const endByte = byteOffset + encoder.encode(headingExact).length;
    entries.push({ sectionIndex: section.index, anchor: { kind: 'heading', basisSha256: source.sha256, titlePath: path, depth: section.depth,
      startByte: byteOffset, endByte, headingExact,
      bodySha256: await digest(encoder.encode(source.content.slice(section.directContentRange.start, section.directContentRange.end))) } });
    offset = section.headingRange.end;
    byteOffset = endByte;
  }
  if (tree.virtualCard) entries.push({ sectionIndex: null, anchor: { kind: tree.virtualCard.kind, basisSha256: source.sha256,
    bodySha256: await digest(encoder.encode(source.content.slice(tree.virtualCard.sourceRange.start, tree.virtualCard.sourceRange.end))) } });
  return { tree, entries };
}

function key(anchor: CanvasAnchor, exact: boolean): string {
  return JSON.stringify(anchor.kind === 'heading'
    ? [anchor.kind, anchor.titlePath, anchor.depth, anchor.headingExact, anchor.bodySha256,
      ...(exact ? [anchor.basisSha256, anchor.startByte, anchor.endByte] : [])]
    : [anchor.kind, anchor.bodySha256, ...(exact ? [anchor.basisSha256] : [])]);
}

function reconcile(
  state: CanvasState, sourceHash: string, entries: readonly Descriptor[],
  matches: ReadonlyMap<string, number>, makeId: () => string,
): ReconciledCanvas {
  const cards: CanvasCard[] = [];
  const bindings: CanvasBinding[] = [];
  const unresolvedCardIds: string[] = [];
  const occupied = new Set<string>(state.cards.map((card) => card.id));
  const assigned = new Set<number>();
  for (const card of state.cards) {
    const index = matches.get(card.id);
    if (index === undefined) { cards.push(card); unresolvedCardIds.push(card.id); continue; }
    if (assigned.has(index)) invalid();
    assigned.add(index);
    cards.push({ ...card, anchor: entries[index].anchor });
    bindings.push({ id: card.id, sectionIndex: entries[index].sectionIndex, kind: entries[index].anchor.kind });
  }
  entries.forEach((entry, index) => {
    if (assigned.has(index)) return;
    const newId = id(makeId());
    if (occupied.has(newId)) invalid();
    occupied.add(newId);
    cards.push({ id: newId, anchor: entry.anchor, position: { x: 0, y: 0 }, collapsed: false });
    bindings.push({ id: newId, sectionIndex: entry.sectionIndex, kind: entry.anchor.kind });
  });
  const unresolved = new Set(unresolvedCardIds);
  return { model: validateCanvasState({ ...state, source: { ...state.source, sha256: sourceHash }, cards }), bindings, unresolvedCardIds,
    unresolvedLinkIds: state.links.filter((link) => unresolved.has(link.from) || unresolved.has(link.to)).map((link) => link.id) };
}

/** External edits accept only a unique exact heading/path/body tuple on both sides. */
export async function reconcileCanvasState(
  state: CanvasState | null, source: AnnotationRelocationSource, makeId = () => globalThis.crypto.randomUUID(),
): Promise<ReconciledCanvas> {
  const current = state ? validateCanvasState(state) : { schemaVersion: 1 as const,
    source: { sha256: source.sha256, encoding: 'utf-8' as const, coordinateSystem: 'utf8-byte' as const },
    cards: [], links: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const { entries } = await descriptors(source);
  const candidates = current.cards.map((card) => entries.flatMap((entry, index) =>
    key(card.anchor, card.anchor.basisSha256 === source.sha256) === key(entry.anchor, card.anchor.basisSha256 === source.sha256) ? [index] : []));
  const proposed = new Map<number, string[]>();
  current.cards.forEach((card, index) => {
    if (candidates[index].length !== 1) return;
    const target = candidates[index][0];
    proposed.set(target, [...(proposed.get(target) ?? []), card.id]);
  });
  const matches = new Map<string, number>();
  for (const [target, ids] of proposed) if (ids.length === 1) matches.set(ids[0], target);
  return reconcile(current, source.sha256, entries, matches, makeId);
}

/** Verified structural commands preserve identities even when paths/markers change. */
export async function mapCanvasThroughSectionTransform(
  state: CanvasState, before: AnnotationRelocationSource, after: AnnotationRelocationSource,
  preview: ReadySectionTransformPreview, makeId = () => globalThis.crypto.randomUUID(),
): Promise<ReconciledCanvas> {
  const current = validateCanvasState(state);
  if (current.source.sha256 !== before.sha256 || preview.source !== before.content || preview.candidate !== after.content) invalid();
  const verified = previewSectionTransform(before.content, preview.operation);
  if (verified.status !== 'ready' || verified.candidate !== after.content ||
    JSON.stringify(verified.sectionOrder) !== JSON.stringify(preview.sectionOrder)) invalid();
  const original = await descriptors(before);
  const next = await descriptors(after);
  const matches = new Map<string, number>();
  const targets = new Map<number, string[]>();
  for (const card of current.cards) {
    const old = original.entries.find((entry) => key(entry.anchor, true) === key(card.anchor, true));
    if (!old) continue;
    const target = old.sectionIndex === null
      ? next.entries.findIndex((entry) => entry.anchor.kind === old.anchor.kind)
      : next.entries.findIndex((entry) => entry.sectionIndex === verified.sectionOrder.indexOf(old.sectionIndex!));
    if (target >= 0) targets.set(target, [...(targets.get(target) ?? []), card.id]);
  }
  for (const [target, ids] of targets) if (ids.length === 1) matches.set(ids[0], target);
  return reconcile(current, after.sha256, next.entries, matches, makeId);
}
