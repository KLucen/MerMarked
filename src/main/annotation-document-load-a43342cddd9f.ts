import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseAnnotationYaml } from '../core/annotations.ts';
import type { AnnotationSidecar } from '../core/annotations.ts';
import type { AnnotationDocumentErrorCode } from '../types/reader-api';
import { loadAnnotationFile } from './annotation-store.ts';
import type { LoadedAnnotationFile } from './annotation-store.ts';

const publicFailureMessages: Readonly<Record<AnnotationDocumentErrorCode, string>> = {
  'annotation-read-failed': '无法读取批注状态。请确认原文和批注文件可访问后重新检查。',
  'source-read-failed': '无法核对当前 Markdown。请确认文件仍可读取后重新载入。',
  'sidecar-invalid': '批注文件格式无效，已按只读处理。请修复或移走批注文件后重新检查。',
};

export type AnnotationDocumentLoadResult =
  | {
      readonly ok: true;
      readonly loaded: LoadedAnnotationFile;
      readonly sourceBytes: Uint8Array;
      readonly currentHash: string;
      readonly model: AnnotationSidecar;
    }
  | {
      readonly ok: false;
      readonly errorCode: AnnotationDocumentErrorCode;
      readonly reason: string;
      /** Available when loading reached the source recheck or YAML parse stage. */
      readonly loaded?: LoadedAnnotationFile;
    };

export interface AnnotationDocumentLoadOperations {
  readonly loadFile?: typeof loadAnnotationFile;
  readonly readSource?: (documentPath: string) => Promise<Uint8Array>;
  readonly parseSidecar?: typeof parseAnnotationYaml;
  readonly logError?: (code: AnnotationDocumentErrorCode, error: unknown) => void;
}

function emptySidecar(sourceSha256: string): AnnotationSidecar {
  return {
    schemaVersion: 1,
    source: { sha256: sourceSha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' },
    tags: [],
    annotations: [],
  };
}

function publicFailure(
  code: AnnotationDocumentErrorCode,
  error: unknown,
  loaded: LoadedAnnotationFile | undefined,
  logError: NonNullable<AnnotationDocumentLoadOperations['logError']>,
): Extract<AnnotationDocumentLoadResult, { ok: false }> {
  logError(code, error);
  return {
    ok: false,
    errorCode: code,
    reason: publicFailureMessages[code],
    ...(loaded ? { loaded } : {}),
  };
}

/**
 * Main-process boundary for data used to build AnnotationDocumentView.
 * Raw filesystem/YAML errors are logged here and never cross the IPC boundary.
 */
export async function loadAnnotationDocumentData(
  documentPath: string,
  draftDirectory: string,
  operations: AnnotationDocumentLoadOperations = {},
): Promise<AnnotationDocumentLoadResult> {
  const loadFile = operations.loadFile ?? loadAnnotationFile;
  const readSource = operations.readSource ?? ((sourcePath: string) => readFile(sourcePath));
  const parseSidecar = operations.parseSidecar ?? parseAnnotationYaml;
  const logError = operations.logError ?? ((code, error) => {
    console.error(`[annotations:${code}]`, error);
  });

  let loaded: LoadedAnnotationFile;
  try {
    loaded = await loadFile(documentPath, draftDirectory);
  } catch (error) {
    return publicFailure('annotation-read-failed', error, undefined, logError);
  }

  let sourceBytes: Uint8Array;
  try {
    sourceBytes = await readSource(documentPath);
  } catch (error) {
    return publicFailure('source-read-failed', error, loaded, logError);
  }
  const currentHash = createHash('sha256').update(sourceBytes).digest('hex');

  let model: AnnotationSidecar;
  try {
    model = loaded.sidecarText === null ? emptySidecar(currentHash) : parseSidecar(loaded.sidecarText);
  } catch (error) {
    return publicFailure('sidecar-invalid', error, loaded, logError);
  }

  return { ok: true, loaded, sourceBytes, currentHash, model };
}
