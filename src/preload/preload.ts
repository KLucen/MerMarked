import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  CanvasExportInput, CanvasSaveInput, CreateHighlightInput, CreateNoteInput, MerMarkdApi, ReadingSummaryFilterInput,
  MarkdownAnnotationImpactInput, MarkdownEditorUpdateInput, MarkdownRecoveryInput, ReattachAnnotationInput,
  RecolorHighlightInput, UpdateNoteInput,
} from '../types/reader-api';
import type { SectionTransformOperation } from '../core/section-transform';

const api: MerMarkdApi = Object.freeze({
  appName: 'MerMarkd',
  openMarkdown: () => ipcRenderer.invoke('document:open'),
  newMarkdown: () => ipcRenderer.invoke('document:new'),
  openRecentMarkdown: (documentPath: string) => ipcRenderer.invoke('document:open-recent', documentPath),
  listRecentDocuments: () => ipcRenderer.invoke('document:recent-list'),
  removeRecentDocument: (documentPath: string) => ipcRenderer.invoke('document:recent-remove', documentPath),
  openDroppedMarkdown: (file: File) => {
    let droppedPath: string;
    try {
      droppedPath = webUtils.getPathForFile(file);
    } catch {
      throw new Error('请拖入单个本地 .md 文件。');
    }
    if (!droppedPath) {
      throw new Error('请拖入单个本地 .md 文件。');
    }
    return ipcRenderer.invoke('document:open-dropped', droppedPath);
  },
  reloadMarkdown: () => ipcRenderer.invoke('document:reload'),
  listDocumentRecovery: () => ipcRenderer.invoke('document:recovery-list'),
  previewDocumentRecovery: (id: string) => ipcRenderer.invoke('document:recovery-preview', id),
  selectDocumentRecovery: () => ipcRenderer.invoke('document:recovery-select'),
  confirmDocumentRecovery: (token: string) => ipcRenderer.invoke('document:recovery-confirm', token),
  cancelDocumentRecovery: (token: string) => ipcRenderer.invoke('document:recovery-cancel', token),
  openMarkdownEditor: () => ipcRenderer.invoke('markdown-editor:open'),
  updateMarkdownEditor: (input: MarkdownEditorUpdateInput) =>
    ipcRenderer.invoke('markdown-editor:update', input),
  previewMarkdownAnnotationImpact: (input: MarkdownAnnotationImpactInput) =>
    ipcRenderer.invoke('markdown-editor:annotation-impact', input),
  previewSectionStructure: (operation: SectionTransformOperation) =>
    ipcRenderer.invoke('section-structure:preview', operation),
  confirmSectionStructure: (token: string) =>
    ipcRenderer.invoke('section-structure:confirm', token),
  cancelSectionStructure: (token: string) =>
    ipcRenderer.invoke('section-structure:cancel', token),
  persistMarkdownEditorDraft: (input: MarkdownEditorUpdateInput) =>
    ipcRenderer.invoke('markdown-editor:persist-draft', input),
  saveMarkdownEditor: (input: MarkdownEditorUpdateInput) =>
    ipcRenderer.invoke('markdown-editor:save', input),
  restoreMarkdownEditorDraft: (input: MarkdownRecoveryInput) =>
    ipcRenderer.invoke('markdown-editor:restore-draft', input),
  discardMarkdownEditorDraft: (input: MarkdownRecoveryInput) =>
    ipcRenderer.invoke('markdown-editor:discard-draft', input),
  discardMarkdownEditorChanges: (epoch: string) =>
    ipcRenderer.invoke('markdown-editor:discard-changes', epoch),
  discardMarkdownSourceBackup: (input: MarkdownRecoveryInput) =>
    ipcRenderer.invoke('markdown-editor:discard-source-backup', input),
  readDocumentImage: (relativePath: string) =>
    ipcRenderer.invoke('document:read-image', relativePath),
  loadCanvas: () => ipcRenderer.invoke('canvas:load'),
  saveCanvas: (input: CanvasSaveInput) => ipcRenderer.invoke('canvas:save', input),
  exportCanvas: (input: CanvasExportInput) => ipcRenderer.invoke('canvas:export', input),
  loadAnnotations: () => ipcRenderer.invoke('annotations:load'),
  createHighlight: (input: CreateHighlightInput) => ipcRenderer.invoke('annotations:create-highlight', input),
  recolorHighlight: (input: RecolorHighlightInput) => ipcRenderer.invoke('annotations:recolor-highlight', input),
  deleteHighlight: (id: string) => ipcRenderer.invoke('annotations:delete-highlight', id),
  createNote: (input: CreateNoteInput) => ipcRenderer.invoke('annotations:create-note', input),
  updateNote: (input: UpdateNoteInput) => ipcRenderer.invoke('annotations:update-note', input),
  deleteNote: (id: string) => ipcRenderer.invoke('annotations:delete-note', id),
  applyAnnotationRelocations: () => ipcRenderer.invoke('annotations:apply-relocations'),
  reattachAnnotation: (input: ReattachAnnotationInput) => ipcRenderer.invoke('annotations:reattach', input),
  copyReadingSummary: (filter: ReadingSummaryFilterInput) => ipcRenderer.invoke('annotations:copy-summary', filter),
  openExternal: (url: string) => ipcRenderer.invoke('external:open', url),
});

contextBridge.exposeInMainWorld('mermarkd', api);
