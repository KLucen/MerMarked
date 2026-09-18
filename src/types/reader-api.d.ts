export interface OpenedMarkdownDocument {
  path: string;
  name: string;
  content: string;
  /** SHA-256 of the exact bytes read from disk, including any BOM and CRLF. */
  sourceSha256: string;
  bomByteLength: 0 | 3;
}

export interface AnnotationSelectionInput {
  startByte: number;
  endByte: number;
  sourceExact: string;
  displayQuote: string;
}

export interface AnnotationSummary {
  status: 'ready' | 'read-only';
  count: number;
  unresolvedCount: number;
  pendingDraftCount: number;
  unreadableDraftCount?: number;
  sidecarPath: string;
  reason?: string;
}

export interface AnnotationSaveResult {
  status: 'saved' | 'conflict' | 'pending-draft';
  reason?: string;
  draftPath?: string;
  count?: number;
}

export interface MerMarkdApi {
  readonly appName: 'MerMarkd';
  openMarkdown(): Promise<OpenedMarkdownDocument | null>;
  openDroppedMarkdown(file: File): Promise<OpenedMarkdownDocument>;
  readDocumentImage(relativePath: string): Promise<string | null>;
  loadAnnotationSummary(): Promise<AnnotationSummary>;
  saveSelectionProbe(input: AnnotationSelectionInput): Promise<AnnotationSaveResult>;
  openExternal(url: string): Promise<boolean>;
}

declare global {
  interface Window {
    mermarkd: MerMarkdApi;
  }
}
