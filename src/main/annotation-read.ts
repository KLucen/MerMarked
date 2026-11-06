import { loadAnnotationDocumentData, type AnnotationDocumentLoadResult } from './annotation-document-load.ts';
import { relocateAnnotationSidecarCandidate, type AnnotationSidecarRelocation } from '../core/annotation-relocation.ts';

export interface AnnotationReadInput {
  readonly documentPath: string;
  readonly draftDirectory: string;
  readonly content: string;
  readonly sourceSha256: string;
  /** Separates concurrent reads from a later annotation mutation in this session. */
  readonly revision?: number;
}

export interface AnnotationReadResult {
  readonly data: Exclude<AnnotationDocumentLoadResult, { ok: true }> |
    Omit<Extract<AnnotationDocumentLoadResult, { ok: true }>, 'sourceBytes'>;
  readonly relocation: AnnotationSidecarRelocation | null;
}

/** Read-only verification. No renderer projection or cached anchor is trusted. */
export async function readAndVerifyAnnotations(input: AnnotationReadInput): Promise<AnnotationReadResult> {
  const data = await loadAnnotationDocumentData(input.documentPath, input.draftDirectory);
  if (!data.ok) {
    return { data, relocation: null };
  }
  const { sourceBytes, ...viewData } = data;
  if (data.currentHash !== data.loaded.sourceSha256 || data.currentHash !== input.sourceSha256) {
    return { data: viewData, relocation: null };
  }
  const newest = data.model.annotations.reduce((latest, item) =>
    Math.max(latest, Date.parse(item.createdAt), Date.parse(item.updatedAt)), 0);
  const relocation = await relocateAnnotationSidecarCandidate(data.model, {
    bytes: sourceBytes, content: input.content, sha256: data.currentHash,
  }, new Date(Math.max(Date.now(), newest)).toISOString());
  return { data: viewData, relocation };
}
