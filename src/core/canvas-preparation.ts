import { canvasCardContent, canvasContentsFromSnapshot, type CanvasCardContent, type CanvasCardContentCache } from './canvas-card-content.ts';
import { canvasDisplayDescriptors, createCanvasSourceSnapshot, reconcileDisplayDescriptors } from './canvas-state.ts';
import { mergeCanvasStateV1Reconciliation, migrateCanvasStateV1ToV2, projectCanvasStateV2ToV1, reconcileCanvasStateV2, type CanvasStateV2, type ReconciledCanvasV2 } from './canvas-state-v2.ts';
import { encodeMarkdownBytes } from './markdown-source.ts';
import { sectionsFromSnapshot, type SectionTree } from './sections.ts';
import type { MarkdownSnapshot } from './markdown-snapshot.ts';

/** Serializable, source-derived projection. No parser AST, file access or save authority. */
export interface PreparedCanvas {
  readonly tree: SectionTree;
  readonly reconciled: ReconciledCanvasV2;
  readonly contents: readonly (readonly [number | null, CanvasCardContent])[];
}

export async function prepareCanvas(source: string, bomByteLength: 0 | 3, model: CanvasStateV2 | null,
  makeId?: Parameters<typeof reconcileCanvasStateV2>[2]): Promise<PreparedCanvas> {
  const bytes = encodeMarkdownBytes(source, bomByteLength);
  const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  const sha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  const snapshot = createCanvasSourceSnapshot(source);
  const reconciled = await reconcileCanvasStateV2(model, { content: source, bytes, sha256 }, makeId, snapshot);
  const indexes = new Set(reconciled.bindings.map(binding => binding.sectionIndex));
  return { tree: snapshot.tree, reconciled,
    contents: [...indexes].map(index => [index, canvasCardContent(source, snapshot.tree, index)] as const) };
}

/** Reading already parsed this exact source. Only display data crosses the worker boundary. */
export async function prepareCanvasFromReading(snapshot: MarkdownSnapshot, bomByteLength: 0 | 3): Promise<PreparedCanvas> {
  const bytes = encodeMarkdownBytes(snapshot.source, bomByteLength);
  const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  const sha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  const tree = sectionsFromSnapshot(snapshot);
  const entries = await canvasDisplayDescriptors({ content: snapshot.source, bytes, sha256 }, tree);
  const empty = { schemaVersion: 1 as const, source: { sha256, encoding: 'utf-8' as const, coordinateSystem: 'utf8-byte' as const },
    cards: [], links: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const reconciled = reconcileDisplayDescriptors(empty, sha256, entries);
  return { tree, reconciled: { ...reconciled, model: migrateCanvasStateV1ToV2(reconciled.model) },
    contents: canvasContentsFromSnapshot(snapshot, tree) };
}

/** Reconcile a freshly loaded sidecar against the current reading projection; never a save validator. */
export function prepareCanvasFromProjection(projection: PreparedCanvas, model: CanvasStateV2 | null,
  makeId: () => string = () => globalThis.crypto.randomUUID()): PreparedCanvas {
  const seed = projectCanvasStateV2ToV1(projection.reconciled.model);
  const byId = new Map(seed.cards.map(card => [card.id, card.anchor]));
  const entries = projection.reconciled.bindings.map(binding => {
    const anchor = byId.get(binding.id);
    if (!anchor) throw Error('Incomplete canvas display projection.');
    return { sectionIndex: binding.sectionIndex, anchor };
  });
  const reconciled = reconcileDisplayDescriptors(model ? projectCanvasStateV2ToV1(model) : { ...seed, cards: [], links: [] }, seed.source.sha256, entries, makeId);
  return { ...projection, reconciled: { ...reconciled, model: model
    ? mergeCanvasStateV1Reconciliation(model, reconciled.model) : migrateCanvasStateV1ToV2(reconciled.model) } };
}
/** Hydrate only our worker's current projection; never parse lazily on the UI thread. */
export function preparedCanvasContent(source: string, prepared: PreparedCanvas): CanvasCardContentCache {
  if (prepared.tree.sourceLength !== source.length) throw Error('Canvas source length mismatch.');
  const entries = new Map(prepared.contents.map(([index, content]) => [index, Object.freeze({ ...content })]));
  for (const binding of prepared.reconciled.bindings) {
    if (!entries.has(binding.sectionIndex)) throw Error('Incomplete canvas projection.');
  }
  return Object.freeze({ source, tree: prepared.tree, get(index: number | null) {
    const entry = entries.get(index);
    if (!entry) throw Error('Missing prepared card content.');
    return entry;
  } });
}
