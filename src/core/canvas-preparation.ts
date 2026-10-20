import { canvasCardContent, type CanvasCardContent, type CanvasCardContentCache } from './canvas-card-content.ts';
import { createCanvasSourceSnapshot } from './canvas-state.ts';
import { reconcileCanvasStateV2, type CanvasStateV2, type ReconciledCanvasV2 } from './canvas-state-v2.ts';
import { encodeMarkdownBytes } from './markdown-source.ts';
import type { SectionTree } from './sections.ts';

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
