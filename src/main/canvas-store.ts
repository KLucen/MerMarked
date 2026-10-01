import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { MAX_CANVAS_JSON_BYTES, parseCanvasJson, serializeCanvasJson } from '../core/canvas-state.ts';
import { commitDocumentTransaction, prepareDocumentTransaction } from './document-transaction.ts';

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function sidecarPath(documentPath: string): string { return `${documentPath}.mermarkd.json`; }

export interface LoadedCanvasFile {
  readonly model: ReturnType<typeof parseCanvasJson> | null;
  readonly sidecarSha256: string | null;
}

export async function loadCanvasFile(documentPath: string): Promise<LoadedCanvasFile> {
  try {
    if ((await stat(sidecarPath(documentPath))).size > MAX_CANVAS_JSON_BYTES) throw new Error('Canvas too large');
    const bytes = await readFile(sidecarPath(documentPath));
    return { model: parseCanvasJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), sidecarSha256: digest(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { model: null, sidecarSha256: null };
    throw error;
  }
}

export async function saveCanvasFile(input: {
  readonly documentPath: string;
  readonly sourceSha256: string;
  readonly expectedSidecarSha256: string | null;
  readonly model: ReturnType<typeof parseCanvasJson>;
}): Promise<{ status: 'saved' | 'conflict' | 'pending'; sidecarSha256?: string; reason?: string }> {
  const text = serializeCanvasJson(input.model);
  const bytes = Buffer.from(text, 'utf8');
  if (input.model.source.sha256 !== input.sourceSha256) return { status: 'conflict', reason: 'source-changed' };
  try {
    const markdown = await readFile(input.documentPath);
    if (digest(markdown) !== input.sourceSha256) return { status: 'conflict', reason: 'source-changed' };
    let existing: Buffer | null = null;
    try { existing = await readFile(sidecarPath(input.documentPath)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if ((existing ? digest(existing) : null) !== input.expectedSidecarSha256) return { status: 'conflict', reason: 'sidecar-changed' };
    let annotations: Buffer | null = null;
    try { annotations = await readFile(`${input.documentPath}.annotations.yaml`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const before = { markdown, annotations, canvas: existing };
    const ref = await prepareDocumentTransaction({ documentPath: input.documentPath, before, after: { ...before, canvas: bytes } });
    const result = await commitDocumentTransaction(input.documentPath, ref);
    return result.status === 'committed' ? { status: 'saved', sidecarSha256: digest(bytes) }
      : { status: result.status === 'pending' ? 'pending' : 'conflict', reason: result.status };
  } catch (error) {
    return { status: 'pending', reason: (error as NodeJS.ErrnoException).code === 'EACCES' ? 'read-only' : 'write-failed' };
  }
}
