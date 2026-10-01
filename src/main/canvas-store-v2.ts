import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import {
  migrateCanvasStateV1ToV2,
  parseCanvasStateV2Json,
  serializeCanvasStateV2Json,
  validateCanvasStateV2,
} from '../core/canvas-state-v2.ts';
import type { CanvasStateV2 } from '../core/canvas-state-v2.ts';
import { parseCanvasJson } from '../core/canvas-state.ts';
import { commitDocumentTransaction, prepareDocumentTransaction } from './document-transaction.ts';

const MAX_CANVAS_JSON_BYTES = 4 * 1024 * 1024;

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sidecarPath(documentPath: string): string {
  return `${documentPath}.mermarkd.json`;
}

function parseCanvasBytes(bytes: Uint8Array): { readonly model: CanvasStateV2; readonly sourceVersion: 1 | 2 } {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('画布 JSON 无效。'); }
  if (value && typeof value === 'object' && (value as { schemaVersion?: unknown }).schemaVersion === 2) {
    return { model: parseCanvasStateV2Json(text), sourceVersion: 2 };
  }
  return { model: migrateCanvasStateV1ToV2(parseCanvasJson(text)), sourceVersion: 1 };
}

export interface LoadedCanvasFileV2 {
  readonly model: CanvasStateV2 | null;
  readonly sidecarSha256: string | null;
  readonly sourceVersion: 1 | 2 | null;
}

export async function loadCanvasFileV2(documentPath: string): Promise<LoadedCanvasFileV2> {
  try {
    const file = sidecarPath(documentPath);
    if ((await stat(file)).size > MAX_CANVAS_JSON_BYTES) throw new Error('Canvas too large');
    const bytes = await readFile(file);
    const parsed = parseCanvasBytes(bytes);
    return {
      model: parsed.model,
      sidecarSha256: digest(bytes),
      sourceVersion: parsed.sourceVersion,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { model: null, sidecarSha256: null, sourceVersion: null };
    throw error;
  }
}

export async function saveCanvasFileV2(input: {
  readonly documentPath: string;
  readonly sourceSha256: string;
  readonly expectedSidecarSha256: string | null;
  readonly model: CanvasStateV2;
}): Promise<{ status: 'saved' | 'conflict' | 'pending'; sidecarSha256?: string; reason?: string }> {
  const model = validateCanvasStateV2(input.model);
  const bytes = Buffer.from(serializeCanvasStateV2Json(model), 'utf8');
  if (model.source.sha256 !== input.sourceSha256) return { status: 'conflict', reason: 'source-changed' };
  try {
    const markdown = await readFile(input.documentPath);
    if (digest(markdown) !== input.sourceSha256) return { status: 'conflict', reason: 'source-changed' };
    let existing: Buffer | null = null;
    try { existing = await readFile(sidecarPath(input.documentPath)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if ((existing ? digest(existing) : null) !== input.expectedSidecarSha256) return { status: 'conflict', reason: 'sidecar-changed' };
    let annotations: Buffer | null = null;
    try { annotations = await readFile(`${input.documentPath}.annotations.yaml`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const ref = await prepareDocumentTransaction({ documentPath: input.documentPath,
      before: { markdown, annotations, canvas: existing }, after: { markdown, annotations, canvas: bytes } });
    const result = await commitDocumentTransaction(input.documentPath, ref);
    return result.status === 'committed' ? { status: 'saved', sidecarSha256: digest(bytes) }
      : { status: result.status === 'pending' ? 'pending' : 'conflict', reason: result.status };
  } catch (error) {
    return { status: 'pending', reason: (error as NodeJS.ErrnoException).code === 'EACCES' ? 'read-only' : 'write-failed' };
  }
}
