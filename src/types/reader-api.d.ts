import type { AnnotationAnchorStatus, AnnotationColor } from '../core/annotations';

export type { AnnotationColor } from '../core/annotations';

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

export interface AnnotationItemView {
  id: string;
  kind: 'highlight' | 'note';
  color?: AnnotationColor;
  note?: string;
  tagId?: string;
  createdAt: string;
  updatedAt: string;
  anchor: Pick<AnnotationSelectionInput, 'startByte' | 'endByte' | 'sourceExact' | 'displayQuote'>;
  status: AnnotationAnchorStatus;
}

export interface AnnotationTagView {
  id: string;
  name: string;
}

export interface AnnotationDocumentView extends AnnotationSummary {
  tags: AnnotationTagView[];
  items: AnnotationItemView[];
}

export interface CreateHighlightInput {
  selection: AnnotationSelectionInput;
  color: AnnotationColor;
}

export interface RecolorHighlightInput {
  id: string;
  color: AnnotationColor;
}

export type NoteTagInput =
  | { mode: 'none' }
  | { mode: 'existing'; id: string }
  | { mode: 'new'; name: string };

export interface CreateNoteInput {
  selection: AnnotationSelectionInput;
  note: string;
  tag: NoteTagInput;
}

export interface UpdateNoteInput {
  id: string;
  note: string;
  tag: NoteTagInput;
}

export interface AnnotationSaveResult {
  status: 'saved' | 'conflict' | 'pending-draft';
  reason?: string;
  draftPath?: string;
  count?: number;
  id?: string;
}

export interface MerMarkdApi {
  readonly appName: 'MerMarkd';
  openMarkdown(): Promise<OpenedMarkdownDocument | null>;
  openDroppedMarkdown(file: File): Promise<OpenedMarkdownDocument>;
  readDocumentImage(relativePath: string): Promise<string | null>;
  loadAnnotations(): Promise<AnnotationDocumentView>;
  createHighlight(input: CreateHighlightInput): Promise<AnnotationSaveResult>;
  recolorHighlight(input: RecolorHighlightInput): Promise<AnnotationSaveResult>;
  deleteHighlight(id: string): Promise<AnnotationSaveResult>;
  createNote(input: CreateNoteInput): Promise<AnnotationSaveResult>;
  updateNote(input: UpdateNoteInput): Promise<AnnotationSaveResult>;
  deleteNote(id: string): Promise<AnnotationSaveResult>;
  openExternal(url: string): Promise<boolean>;
}

declare global {
  interface Window {
    mermarkd: MerMarkdApi;
  }
}
