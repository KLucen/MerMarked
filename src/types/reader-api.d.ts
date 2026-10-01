import type { AnnotationAnchorStatus, AnnotationColor } from '../core/annotations';
import type { CanvasState } from '../core/canvas-state';
import type { CanvasSceneCard, CanvasSceneLink } from '../core/canvas-scene';
import type { MarkdownSourceFormat } from '../core/markdown-source';
import type { SectionTransformOperation, SectionTransformRejection } from '../core/section-transform';

export type { AnnotationColor } from '../core/annotations';

export interface OpenedMarkdownDocument {
  path: string;
  name: string;
  content: string;
  /** SHA-256 of the exact bytes read from disk, including any BOM and CRLF. */
  sourceSha256: string;
  bomByteLength: 0 | 3;
  readonly recoveryPending?: boolean;
}

export interface DocumentRecoveryItem {
  readonly id: string;
  readonly status: 'prepared' | 'interrupted' | 'conflict' | 'incomplete' | 'invalid';
  readonly canPreview: boolean;
}

export interface DocumentRecoveryPreview {
  readonly token: string;
  readonly documentName: string;
  readonly source: string;
  readonly candidate: string;
  readonly files: readonly { readonly name: string; readonly status: 'before' | 'after' | 'interrupted' | 'conflict' }[];
  readonly recoverable: boolean;
  readonly message: string;
}

export type DocumentRecoveryResult =
  | { readonly status: 'recovered'; readonly document: OpenedMarkdownDocument; readonly message: string }
  | { readonly status: 'conflict' | 'pending'; readonly message: string };

export interface CanvasLoadResult {
  readonly status: 'missing' | 'ready' | 'stale' | 'invalid';
  readonly model: CanvasState | null;
  readonly sidecarSha256: string | null;
  readonly reason?: string;
}

export interface CanvasSaveInput {
  readonly sourceSha256: string;
  readonly expectedSidecarSha256: string | null;
  readonly model: CanvasState;
}

export type CanvasExportFormat = 'png' | 'jpg' | 'pdf';

export interface CanvasExportInput {
  readonly sourceSha256: string;
  readonly format: CanvasExportFormat;
  readonly cards: readonly CanvasSceneCard[];
  readonly links: readonly CanvasSceneLink[];
  readonly padding?: number;
  readonly background?: string;
}

export type CanvasExportResult =
  | { readonly status: 'saved'; readonly path: string; readonly format: CanvasExportFormat; readonly width: number; readonly height: number; readonly pages: number }
  | { readonly status: 'cancelled' }
  | { readonly status: 'error'; readonly reason: string };

export interface CanvasSaveResult {
  readonly status: 'saved' | 'conflict' | 'pending';
  readonly sidecarSha256?: string;
  readonly reason?: string;
}

export type MarkdownRecoveryRelationship =
  | 'recoverable'
  | 'already-saved'
  | 'conflict'
  | 'source-missing'
  | 'source-unreadable';

export interface MarkdownRecoveryDraftView {
  readonly id: string;
  readonly relationship: MarkdownRecoveryRelationship;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly preview: string;
}

export interface MarkdownEditorView {
  readonly epoch: string;
  readonly revision: number;
  readonly content: string;
  readonly dirty: boolean;
  readonly editable: boolean;
  readonly readOnlyReason?: string;
  /** Persisted Markdown format that editor LF text must reconstruct on save. */
  readonly sourceFormat: MarkdownSourceFormat;
  /** Format of the current source-style candidate held by the main process. */
  readonly format: MarkdownSourceFormat;
  readonly draftPersisted: boolean;
  readonly recoveryDrafts: readonly MarkdownRecoveryDraftView[];
  readonly unreadableDraftCount: number;
  readonly retainedTemporaryDraftCount: number;
  readonly latestSourceBackupId?: string;
}

export interface MarkdownEditorUpdateInput {
  readonly epoch: string;
  readonly revision: number;
  readonly content: string;
}

export interface MarkdownAnnotationImpactInput {
  readonly epoch: string;
  readonly content: string;
}

export interface MarkdownAnnotationImpact {
  readonly status: 'ready' | 'not-needed' | 'deferred';
  readonly mappedCount: number;
  readonly unresolved: readonly { readonly id: string; readonly quote: string }[];
  readonly message: string;
}

export interface SectionStructurePreview {
  readonly status: 'ready' | 'rejected' | 'noop';
  readonly token?: string;
  readonly operation: SectionTransformOperation;
  readonly sourceSha256: string;
  readonly source: string;
  readonly candidate?: string;
  readonly summary?: string;
  readonly impact?: MarkdownAnnotationImpact;
  readonly rejection?: SectionTransformRejection;
}

export type SectionStructureConfirmResult =
  | { readonly status: 'staged'; readonly editor: MarkdownEditorView; readonly impact: MarkdownAnnotationImpact; readonly message: string }
  | { readonly status: 'expired' | 'conflict'; readonly message: string };

export interface MarkdownRecoveryInput {
  readonly epoch: string;
  readonly id: string;
}

export interface MarkdownAnnotationMappingResult {
  readonly status: 'saved' | 'not-needed' | 'deferred' | 'conflict' | 'pending-draft';
  readonly mappedCount: number;
  readonly unresolvedCount: number;
  readonly message: string;
}

export type MarkdownEditorSaveResult =
  | {
      readonly status: 'saved';
      readonly changed: boolean;
      readonly document: OpenedMarkdownDocument;
      readonly editor: MarkdownEditorView;
      readonly message: string;
      readonly annotationMapping?: MarkdownAnnotationMappingResult;
    }
  | {
      readonly status: 'conflict' | 'pending-draft';
      readonly editor: MarkdownEditorView;
      readonly message: string;
    };

export interface MarkdownEditorDiscardResult {
  readonly document: OpenedMarkdownDocument;
  readonly editor: MarkdownEditorView;
}

export interface AnnotationSelectionInput {
  startByte: number;
  endByte: number;
  sourceExact: string;
  displayQuote: string;
}

export type AnnotationDocumentErrorCode =
  | 'annotation-read-failed'
  | 'source-read-failed'
  | 'sidecar-invalid';

export interface AnnotationSummary {
  status: 'ready' | 'needs-relocation' | 'read-only';
  count: number;
  unresolvedCount: number;
  relocatableCount: number;
  pendingDraftCount: number;
  unreadableDraftCount?: number;
  sidecarPath: string;
  /** Stable category for a main-process load failure. Detailed errors stay in main-process logs. */
  errorCode?: AnnotationDocumentErrorCode;
  /** User-facing text only. It must not contain paths, source excerpts, or byte ranges. */
  reason?: string;
  canReloadSource?: boolean;
  canCopySummary?: boolean;
}

export type AnnotationRelocationState =
  | 'available'
  | 'source-missing'
  | 'source-repeated'
  | 'context-mismatch'
  | 'range-mismatch'
  | 'rendered-range-unresolved'
  | 'target-range-collision';

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
  relocation?: AnnotationRelocationState;
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
  relocatedCount?: number;
}

export interface ReattachAnnotationInput {
  id: string;
  selection: AnnotationSelectionInput;
}

export type ReadingSummaryFilterInput =
  | { mode: 'all' }
  | { mode: 'untagged' }
  | { mode: 'tag'; tagId: string };

export interface ReadingSummaryCopyResult {
  count: number;
}

export interface MerMarkdApi {
  readonly appName: 'MerMarkd';
  openMarkdown(): Promise<OpenedMarkdownDocument | null>;
  openDroppedMarkdown(file: File): Promise<OpenedMarkdownDocument>;
  reloadMarkdown(): Promise<OpenedMarkdownDocument>;
  listDocumentRecovery(): Promise<readonly DocumentRecoveryItem[]>;
  previewDocumentRecovery(id: string): Promise<DocumentRecoveryPreview>;
  selectDocumentRecovery(): Promise<DocumentRecoveryPreview | null>;
  confirmDocumentRecovery(token: string): Promise<DocumentRecoveryResult>;
  cancelDocumentRecovery(token: string): Promise<void>;
  openMarkdownEditor(): Promise<MarkdownEditorView>;
  updateMarkdownEditor(input: MarkdownEditorUpdateInput): Promise<MarkdownEditorView>;
  previewMarkdownAnnotationImpact(input: MarkdownAnnotationImpactInput): Promise<MarkdownAnnotationImpact>;
  previewSectionStructure(operation: SectionTransformOperation): Promise<SectionStructurePreview>;
  confirmSectionStructure(token: string): Promise<SectionStructureConfirmResult>;
  cancelSectionStructure(token: string): Promise<{ readonly status: 'cancelled' | 'expired'; readonly message: string }>;
  persistMarkdownEditorDraft(input: MarkdownEditorUpdateInput): Promise<MarkdownEditorView>;
  saveMarkdownEditor(input: MarkdownEditorUpdateInput): Promise<MarkdownEditorSaveResult>;
  restoreMarkdownEditorDraft(input: MarkdownRecoveryInput): Promise<MarkdownEditorView>;
  discardMarkdownEditorDraft(input: MarkdownRecoveryInput): Promise<MarkdownEditorView>;
  discardMarkdownEditorChanges(epoch: string): Promise<MarkdownEditorDiscardResult>;
  discardMarkdownSourceBackup(input: MarkdownRecoveryInput): Promise<MarkdownEditorView>;
  readDocumentImage(relativePath: string): Promise<string | null>;
  loadCanvas(): Promise<CanvasLoadResult>;
  saveCanvas(input: CanvasSaveInput): Promise<CanvasSaveResult>;
  exportCanvas(input: CanvasExportInput): Promise<CanvasExportResult>;
  loadAnnotations(): Promise<AnnotationDocumentView>;
  createHighlight(input: CreateHighlightInput): Promise<AnnotationSaveResult>;
  recolorHighlight(input: RecolorHighlightInput): Promise<AnnotationSaveResult>;
  deleteHighlight(id: string): Promise<AnnotationSaveResult>;
  createNote(input: CreateNoteInput): Promise<AnnotationSaveResult>;
  updateNote(input: UpdateNoteInput): Promise<AnnotationSaveResult>;
  deleteNote(id: string): Promise<AnnotationSaveResult>;
  applyAnnotationRelocations(): Promise<AnnotationSaveResult>;
  reattachAnnotation(input: ReattachAnnotationInput): Promise<AnnotationSaveResult>;
  copyReadingSummary(filter: ReadingSummaryFilterInput): Promise<ReadingSummaryCopyResult>;
  openExternal(url: string): Promise<boolean>;
}

declare global {
  interface Window {
    mermarkd: MerMarkdApi;
  }
}
