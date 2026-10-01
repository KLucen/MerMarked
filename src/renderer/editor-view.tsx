import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { MarkdownSourceFormat } from '../core/markdown-source';
import { countGraphemes } from '../core/reader-navigation';
import { editorToMarkdownText, markdownToEditorText } from '../core/editor-text';
import { previewSectionTransform } from '../core/section-transform';
import type { SectionTransformPreview } from '../core/section-transform';
import type { MarkdownAnnotationImpact, MarkdownRecoveryDraftView, SectionStructurePreview } from '../types/reader-api';

const MAX_EDITOR_SEARCH_MATCHES = 10_000;
const MAX_EDITOR_HISTORY_ENTRIES = 500;

interface EditorSelection {
  readonly start: number;
  readonly end: number;
  readonly direction: 'forward' | 'backward' | 'none';
}

interface EditorHistoryEntry {
  readonly start: number;
  readonly deleted: string;
  readonly inserted: string;
  readonly selectionBefore: EditorSelection;
  readonly selectionAfter: EditorSelection;
}

interface EditorHistory {
  past: EditorHistoryEntry[];
  future: EditorHistoryEntry[];
}

export interface SourceEditorSection {
  readonly key: string;
  readonly title: string;
  readonly depth: number;
  /** Raw Markdown heading depth, which may differ from the tree indentation depth. */
  readonly headingDepth?: number;
  /** UTF-16 offset in the LF-normalized editor text. */
  readonly sourceOffset: number;
}

export interface SourceEditorCursor {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly selectionLength: number;
}

export interface MarkdownEditorViewProps {
  readonly active?: boolean;
  /** Changes whenever another document replaces the current session. */
  readonly documentKey: string;
  readonly documentName: string;
  /**
   * The single editable session buffer. It must use LF internally. The owner
   * converts LF back to sourceFormat.lineEnding before staging or saving.
   */
  readonly value: string;
  /** Persisted source format used to materialize exact Markdown bytes. */
  readonly sourceFormat: MarkdownSourceFormat;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly readOnly?: boolean;
  readonly readOnlyReason?: string | null;
  readonly saveMessage?: string | null;
  readonly sections?: readonly SourceEditorSection[];
  readonly activeSectionKey?: string | null;
  readonly focusOffset?: number | null;
  readonly focusRequestKey?: string | number | null;
  readonly recoveryDrafts?: readonly MarkdownRecoveryDraftView[];
  readonly recoveryMessage?: string | null;
  readonly recoveringDraft?: boolean;
  readonly latestSourceBackupId?: string;
  readonly onChange: (editorText: string) => void;
  readonly onSave: () => void;
  readonly onCursorChange?: (cursor: SourceEditorCursor) => void;
  readonly onRecoverDraft?: (id: string) => void;
  readonly onDiscardDraft?: (id: string) => void;
  readonly onDiscardChanges?: () => void;
  readonly onDiscardSourceBackup?: (id: string) => void;
  readonly canvasStructurePreview?: SectionStructurePreview | null;
  readonly onConfirmCanvasStructure?: (token: string, onAccepted: (content: string) => void) => Promise<boolean>;
  readonly onCancelCanvasStructure?: () => void;
}

function recoveryRelationshipLabel(relationship: MarkdownRecoveryDraftView['relationship']): string {
  if (relationship === 'recoverable') return '可从当前磁盘版本恢复';
  if (relationship === 'already-saved') return '内容已存在于磁盘';
  if (relationship === 'conflict') return '磁盘版本已变化，只能保留或丢弃';
  if (relationship === 'source-missing') return '源文件缺失，暂不能直接恢复';
  return '源文件暂时无法读取';
}

function selectionFor(textarea: HTMLTextAreaElement): EditorSelection {
  return {
    start: textarea.selectionStart,
    end: textarea.selectionEnd,
    direction: textarea.selectionDirection ?? 'none',
  };
}

function changedSpan(
  before: string,
  after: string,
  selectionBefore: EditorSelection,
  selectionAfter: EditorSelection,
): EditorHistoryEntry | null {
  if (before === after) return null;
  let start = 0;
  const sharedLimit = Math.min(before.length, after.length);
  while (start < sharedLimit && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;

  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    before.charCodeAt(beforeEnd - 1) === after.charCodeAt(afterEnd - 1)
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  return {
    start,
    deleted: before.slice(start, beforeEnd),
    inserted: after.slice(start, afterEnd),
    selectionBefore,
    selectionAfter,
  };
}

function cursorFor(text: string, selection: EditorSelection): SourceEditorCursor {
  const safeOffset = Math.max(0, Math.min(selection.start, text.length));
  const prefix = text.slice(0, safeOffset);
  const lastLineBreak = prefix.lastIndexOf('\n');
  return {
    offset: safeOffset,
    line: prefix.split('\n').length,
    column: countGraphemes(prefix.slice(lastLineBreak + 1)) + 1,
    selectionLength: countGraphemes(text.slice(selection.start, selection.end)),
  };
}

function literalMatches(text: string, query: string): {
  readonly offsets: readonly number[];
  readonly truncated: boolean;
} {
  if (!query) return { offsets: [], truncated: false };
  const offsets: number[] = [];
  let offset = 0;
  while (offset <= text.length - query.length) {
    const found = text.indexOf(query, offset);
    if (found < 0) break;
    if (offsets.length === MAX_EDITOR_SEARCH_MATCHES) {
      return { offsets, truncated: true };
    }
    offsets.push(found);
    offset = found + Math.max(1, query.length);
  }
  return { offsets, truncated: false };
}

function lineEndingLabel(format: MarkdownSourceFormat, editorText: string): string {
  const current = format.lineEnding === 'none' && editorText.includes('\n') ? 'lf' : format.lineEnding;
  if (current === 'crlf') return 'CRLF';
  if (current === 'cr') return 'CR';
  if (current === 'mixed') return '混合换行';
  if (current === 'none') return '无换行';
  return 'LF';
}

export function MarkdownEditorView({
  active = true,
  documentKey,
  documentName,
  value,
  sourceFormat,
  dirty,
  saving,
  readOnly = false,
  readOnlyReason = null,
  saveMessage = null,
  sections,
  activeSectionKey,
  focusOffset = null,
  focusRequestKey = null,
  recoveryDrafts = [],
  recoveryMessage = null,
  recoveringDraft = false,
  latestSourceBackupId,
  onChange,
  onSave,
  onCursorChange,
  onRecoverDraft,
  onDiscardDraft,
  onDiscardChanges,
  onDiscardSourceBackup,
  canvasStructurePreview = null,
  onConfirmCanvasStructure,
  onCancelCanvasStructure,
}: MarkdownEditorViewProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const currentValue = useRef(value);
  const pendingValue = useRef<string | null>(null);
  const selection = useRef<EditorSelection>({ start: 0, end: 0, direction: 'none' });
  const history = useRef<EditorHistory>({ past: [], future: [] });
  const selectionFrame = useRef<number | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [cursor, setCursor] = useState<SourceEditorCursor>(() => cursorFor(value, selection.current));
  const [searchOpen, setSearchOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [confirmDiscardChanges, setConfirmDiscardChanges] = useState(false);
  const [moveSourceIndex, setMoveSourceIndex] = useState<number | null>(null);
  const [moveTargetIndex, setMoveTargetIndex] = useState<number | null>(null);
  const [levelSectionIndex, setLevelSectionIndex] = useState<number | null>(null);
  const [levelTargetDepth, setLevelTargetDepth] = useState(1);
  const [structurePreview, setStructurePreview] = useState<SectionTransformPreview | null>(null);
  const [annotationImpact, setAnnotationImpact] = useState<MarkdownAnnotationImpact | null>(null);

  useEffect(() => {
    setAnnotationImpact(null);
    if (structurePreview?.status !== 'ready' || structurePreview.source !== value) return;
    let cancelled = false;
    const content = editorToMarkdownText(structurePreview.candidate,
      sourceFormat.lineEnding === 'mixed' ? 'lf' : sourceFormat.lineEnding);
    void window.mermarkd.previewMarkdownAnnotationImpact({ epoch: documentKey, content })
      .then((impact) => { if (!cancelled) setAnnotationImpact(impact); })
      .catch(() => { if (!cancelled) setAnnotationImpact({ status: 'deferred', mappedCount: 0, unresolved: [],
        message: '批注影响暂无法核验，现有批注会在保存时再次检查；不能证明的位置保留待定位。' }); });
    return () => { cancelled = true; };
  }, [documentKey, sourceFormat.lineEnding, structurePreview, value]);

  const search = useMemo(() => literalMatches(value, query), [query, value]);
  const canUndo = history.current.past.length > 0;
  const canRedo = history.current.future.length > 0;

  const updateHistoryControls = useCallback(() => setHistoryRevision((revision) => revision + 1), []);
  void historyRevision;

  const reportSelection = useCallback((next: EditorSelection) => {
    selection.current = next;
    const nextCursor = cursorFor(currentValue.current, next);
    setCursor(nextCursor);
    onCursorChange?.(nextCursor);
  }, [onCursorChange]);

  const selectAfterRender = useCallback((next: EditorSelection, focus = true) => {
    if (selectionFrame.current !== null) window.cancelAnimationFrame(selectionFrame.current);
    selectionFrame.current = window.requestAnimationFrame(() => {
      selectionFrame.current = null;
      const textarea = textareaRef.current;
      if (!textarea) return;
      const start = Math.max(0, Math.min(next.start, textarea.value.length));
      const end = Math.max(start, Math.min(next.end, textarea.value.length));
      textarea.setSelectionRange(start, end, next.direction);
      if (focus) textarea.focus({ preventScroll: true });
      reportSelection({ ...next, start, end });
    });
  }, [reportSelection]);

  const emitValue = useCallback((nextValue: string, nextSelection: EditorSelection) => {
    pendingValue.current = nextValue;
    currentValue.current = nextValue;
    onChange(nextValue);
    selectAfterRender(nextSelection);
  }, [onChange, selectAfterRender]);

  const recordAndEmit = useCallback((nextValue: string, nextSelection: EditorSelection) => {
    const before = currentValue.current;
    const entry = changedSpan(before, nextValue, selection.current, nextSelection);
    if (!entry) {
      reportSelection(nextSelection);
      return;
    }
    history.current.past.push(entry);
    if (history.current.past.length > MAX_EDITOR_HISTORY_ENTRIES) history.current.past.shift();
    history.current.future = [];
    updateHistoryControls();
    setActionMessage(null);
    setConfirmDiscardChanges(false);
    emitValue(nextValue, nextSelection);
  }, [emitValue, reportSelection, updateHistoryControls]);

  const clearHistory = useCallback(() => {
    history.current = { past: [], future: [] };
    updateHistoryControls();
  }, [updateHistoryControls]);

  useEffect(() => {
    currentValue.current = value;
    pendingValue.current = null;
    selection.current = { start: 0, end: 0, direction: 'none' };
    setCursor(cursorFor(value, selection.current));
    setSearchOpen(false);
    setReplaceOpen(false);
    setQuery('');
    setReplacement('');
    setSearchIndex(0);
    setActionMessage(null);
    clearHistory();
    setMoveSourceIndex(null);
    setMoveTargetIndex(null);
    setLevelSectionIndex(null);
    setLevelTargetDepth(1);
    setStructurePreview(null);
  }, [clearHistory, documentKey]);

  useEffect(() => {
    if (!sections?.length) {
      setMoveSourceIndex(null);
      setMoveTargetIndex(null);
      setLevelSectionIndex(null);
      setStructurePreview(null);
      return;
    }
    const indexes = new Set(sections.map((section) => Number(section.key)));
    const first = Number(sections[0].key);
    const nextSource = moveSourceIndex !== null && indexes.has(moveSourceIndex) ? moveSourceIndex : first;
    const nextTarget = moveTargetIndex !== null && indexes.has(moveTargetIndex) ? moveTargetIndex : first;
    const nextLevel = levelSectionIndex !== null && indexes.has(levelSectionIndex) ? levelSectionIndex : first;
    if (nextSource !== moveSourceIndex) setMoveSourceIndex(nextSource);
    if (nextTarget !== moveTargetIndex) setMoveTargetIndex(nextTarget);
    if (nextLevel !== levelSectionIndex) setLevelSectionIndex(nextLevel);
    const selected = sections.find((section) => Number(section.key) === nextLevel);
    if (selected && levelTargetDepth >= (selected.headingDepth ?? selected.depth)) {
      setLevelTargetDepth(Math.max(1, (selected.headingDepth ?? selected.depth) - 1));
    }
  }, [levelSectionIndex, levelTargetDepth, moveSourceIndex, moveTargetIndex, sections]);

  useEffect(() => {
    if (pendingValue.current === value) {
      pendingValue.current = null;
      currentValue.current = value;
      return;
    }
    if (currentValue.current !== value) {
      currentValue.current = value;
      clearHistory();
      const nextSelection = {
        ...selection.current,
        start: Math.min(selection.current.start, value.length),
        end: Math.min(selection.current.end, value.length),
      };
      reportSelection(nextSelection);
    }
  }, [clearHistory, reportSelection, value]);

  useEffect(() => () => {
    if (selectionFrame.current !== null) window.cancelAnimationFrame(selectionFrame.current);
  }, []);

  useEffect(() => {
    if (!active || focusRequestKey === null || focusOffset === null) return;
    const offset = Math.max(0, Math.min(focusOffset, currentValue.current.length));
    selectAfterRender({ start: offset, end: offset, direction: 'none' });
  }, [active, focusOffset, focusRequestKey, selectAfterRender]);

  useEffect(() => {
    setSearchIndex((index) => Math.min(index, Math.max(0, search.offsets.length - 1)));
  }, [search.offsets.length]);

  const focusMatch = useCallback((index: number) => {
    if (!query || search.offsets.length === 0) return;
    const normalized = (index + search.offsets.length) % search.offsets.length;
    const start = search.offsets[normalized];
    setSearchIndex(normalized);
    selectAfterRender({ start, end: start + query.length, direction: 'forward' });
  }, [query, search.offsets, selectAfterRender]);

  const openSearch = useCallback((withReplace: boolean) => {
    const selected = currentValue.current.slice(selection.current.start, selection.current.end);
    if (selected && !/[\r\n]/.test(selected)) setQuery(selected);
    setSearchOpen(true);
    setReplaceOpen(withReplace);
    setActionMessage(null);
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setReplaceOpen(false);
    textareaRef.current?.focus({ preventScroll: true });
  }, []);

  const undo = useCallback(() => {
    if (readOnly || saving) return;
    const entry = history.current.past.pop();
    if (!entry) return;
    const text = currentValue.current;
    if (text.slice(entry.start, entry.start + entry.inserted.length) !== entry.inserted) {
      clearHistory();
      setActionMessage('编辑历史已因外部缓冲区更新而重置。');
      return;
    }
    const next = text.slice(0, entry.start) + entry.deleted + text.slice(entry.start + entry.inserted.length);
    history.current.future.push(entry);
    updateHistoryControls();
    setActionMessage('已撤销上一步源码修改。');
    emitValue(next, entry.selectionBefore);
  }, [clearHistory, emitValue, readOnly, saving, updateHistoryControls]);

  const redo = useCallback(() => {
    if (readOnly || saving) return;
    const entry = history.current.future.pop();
    if (!entry) return;
    const text = currentValue.current;
    if (text.slice(entry.start, entry.start + entry.deleted.length) !== entry.deleted) {
      clearHistory();
      setActionMessage('编辑历史已因外部缓冲区更新而重置。');
      return;
    }
    const next = text.slice(0, entry.start) + entry.inserted + text.slice(entry.start + entry.deleted.length);
    history.current.past.push(entry);
    updateHistoryControls();
    setActionMessage('已重做源码修改。');
    emitValue(next, entry.selectionAfter);
  }, [clearHistory, emitValue, readOnly, saving, updateHistoryControls]);

  const replaceCurrent = useCallback(() => {
    if (readOnly || saving || !query || search.offsets.length === 0) return;
    const index = Math.min(searchIndex, search.offsets.length - 1);
    const start = search.offsets[index];
    const next = value.slice(0, start) + replacement + value.slice(start + query.length);
    const nextSelection = { start, end: start + replacement.length, direction: 'forward' as const };
    recordAndEmit(next, nextSelection);
    setActionMessage('已替换当前匹配。');
  }, [query, readOnly, recordAndEmit, replacement, saving, search.offsets, searchIndex, value]);

  const replaceAll = useCallback(() => {
    if (readOnly || saving || !query || search.offsets.length === 0 || search.truncated) return;
    const next = value.split(query).join(replacement);
    if (next === value) return;
    const lastStart = Math.max(0, next.length - replacement.length);
    recordAndEmit(next, { start: lastStart, end: next.length, direction: 'forward' });
    setActionMessage(`已替换 ${search.offsets.length} 处匹配。`);
  }, [query, readOnly, recordAndEmit, replacement, saving, search.offsets.length, search.truncated, value]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!active) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLocaleLowerCase();
      if (key === 'f') {
        event.preventDefault();
        openSearch(false);
      } else if (key === 'h') {
        event.preventDefault();
        openSearch(true);
      } else if (key === 's') {
        event.preventDefault();
        if (!saving && !readOnly) onSave();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [active, onSave, openSearch, readOnly, saving]);

  const handleEditorKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLocaleLowerCase();
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      undo();
    } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
      redo();
    }
  };

  const handleTextChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const textarea = event.currentTarget;
    recordAndEmit(textarea.value, selectionFor(textarea));
  };

  const previewMove = useCallback(() => {
    if (moveSourceIndex === null || moveTargetIndex === null) return;
    setStructurePreview(previewSectionTransform(currentValue.current, {
      kind: 'move', sourceIndex: moveSourceIndex, targetIndex: moveTargetIndex,
    }));
  }, [moveSourceIndex, moveTargetIndex]);

  const previewLevelChange = useCallback(() => {
    if (levelSectionIndex === null) return;
    setStructurePreview(previewSectionTransform(currentValue.current, {
      kind: 'promote', sectionIndex: levelSectionIndex, targetDepth: levelTargetDepth,
    }));
  }, [levelSectionIndex, levelTargetDepth]);

  const applyStructurePreview = useCallback(() => {
    const preview = structurePreview;
    if (!preview || readOnly || saving || !annotationImpact) return;
    if (preview.status !== 'ready') {
      setActionMessage(preview.rejection.message);
      return;
    }
    if (preview.source !== currentValue.current) {
      setStructurePreview(null);
      setActionMessage('源码在预览后发生变化，请重新生成结构变更预览。');
      return;
    }
    recordAndEmit(preview.candidate, { start: 0, end: 0, direction: 'none' });
    setStructurePreview(null);
    setActionMessage(`${preview.summary} 已加入源码编辑历史，可用“撤销”恢复。`);
  }, [annotationImpact, readOnly, recordAndEmit, saving, structurePreview]);

  const applyCanvasStructure = async () => {
    if (!canvasStructurePreview?.token || !onConfirmCanvasStructure || saving || readOnly ||
      markdownToEditorText(canvasStructurePreview.source) !== currentValue.current) return;
    await onConfirmCanvasStructure(canvasStructurePreview.token, (content) => {
      const next = markdownToEditorText(content);
      const nextSelection: EditorSelection = { start: 0, end: 0, direction: 'none' };
      const entry = changedSpan(currentValue.current, next, selection.current, nextSelection);
      if (entry) { history.current.past.push(entry); history.current.future = []; updateHistoryControls(); }
      pendingValue.current = next; currentValue.current = next; selectAfterRender(nextSelection);
      setActionMessage('结构变更已加入撤销栈，保存前可撤销。');
    });
  };

  const sectionOptionLabel = useCallback((section: SourceEditorSection) => {
    const indentation = '　'.repeat(Math.max(0, section.depth - 1));
    return `${indentation}${section.title}`;
  }, []);

  const selectedLevelSection = sections?.find((section) => Number(section.key) === levelSectionIndex);
  const selectedHeadingDepth = selectedLevelSection?.headingDepth ?? selectedLevelSection?.depth ?? 1;

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSearch();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      focusMatch(searchIndex + (event.shiftKey ? -1 : 1));
    }
  };

  const effectiveActiveSection = activeSectionKey ?? sections?.reduce<string | null>(
    (active, section) => section.sourceOffset <= cursor.offset ? section.key : active,
    null,
  );
  const currentTrailingLineEnding = value.endsWith('\n');
  const sourceIsReadOnly = readOnly || sourceFormat.lineEnding === 'mixed';
  const effectiveReadOnlyReason = readOnlyReason ?? (
    sourceFormat.lineEnding === 'mixed' ? '这份文档包含混合换行，当前仅可查看源码。' : null
  );

  return <div className={sections ? 'source-editor-layout with-outline' : 'source-editor-layout'} data-editor-view="true">
    {sections && <aside className="source-outline" aria-label="源码章节目录">
      <div className="source-outline-inner">
        <div className="source-outline-heading">源码目录 <span>{sections.length}</span></div>
        {sections.length > 0 ? <ol className="source-outline-list">
          {sections.map((section) => <li key={section.key} style={{ '--source-depth': Math.max(0, section.depth - 1) } as CSSProperties}>
            <button type="button" className={effectiveActiveSection === section.key ? 'active' : undefined}
              aria-current={effectiveActiveSection === section.key ? 'location' : undefined}
              data-editor-section={section.key}
              data-source-offset={section.sourceOffset}
              title={section.title}
              onClick={() => selectAfterRender({
                start: section.sourceOffset,
                end: section.sourceOffset,
                direction: 'none',
              })}>
              {section.title}
            </button>
          </li>)}
        </ol> : <p>这份文档没有章节标题。</p>}
      </div>
    </aside>}
    <main className="source-editor-main">
      <header className="source-editor-header">
        <div>
          <span className="source-editor-kicker">MARKDOWN 源码</span>
          <h1>{documentName}</h1>
        </div>
        <div className="source-editor-actions" aria-label="源码编辑操作">
          <button type="button" data-editor-undo="true" onClick={undo}
            disabled={!canUndo || sourceIsReadOnly || saving}>撤销</button>
          <button type="button" data-editor-redo="true" onClick={redo}
            disabled={!canRedo || sourceIsReadOnly || saving}>重做</button>
          <button type="button" data-editor-find="true" onClick={() => openSearch(false)}>查找</button>
          <button type="button" data-editor-replace="true" onClick={() => openSearch(true)}
            disabled={sourceIsReadOnly}>替换</button>
          <button type="button" className="primary" data-editor-save="true" onClick={onSave}
            disabled={sourceIsReadOnly || saving}>{saving ? '正在保存…' : '保存'}</button>
          {dirty && onDiscardChanges && !confirmDiscardChanges && <button type="button"
            data-editor-discard-changes="true" onClick={() => setConfirmDiscardChanges(true)} disabled={saving}>
            放弃并重载
          </button>}
          {dirty && onDiscardChanges && confirmDiscardChanges && <span className="source-discard-confirm" role="group"
            aria-label="确认放弃未保存源码">
            <span>确定放弃未保存内容？</span>
            <button type="button" className="danger" data-editor-confirm-discard="true"
              onClick={() => { setConfirmDiscardChanges(false); onDiscardChanges(); }} disabled={saving}>确定放弃</button>
            <button type="button" onClick={() => setConfirmDiscardChanges(false)} disabled={saving}>取消</button>
          </span>}
        </div>
      </header>

      {recoveryDrafts.length > 0 && <section className="source-recovery" role="status" data-editor-recovery="true">
        <div>
          <strong>发现未完成的源码草稿</strong>
          <span>{recoveryMessage ?? `${recoveryDrafts.length} 份草稿等待处理。恢复前不会改写 Markdown。`}</span>
        </div>
        <ol className="source-recovery-list">{recoveryDrafts.map((draft) => <li key={draft.id}>
          <div><strong>{draft.preview}</strong><span>{recoveryRelationshipLabel(draft.relationship)}</span></div>
          <div className="source-recovery-actions">
            {draft.relationship === 'recoverable' && onRecoverDraft && <button type="button" className="primary"
              data-editor-recover-draft={draft.id} onClick={() => onRecoverDraft(draft.id)}
              disabled={recoveringDraft || saving}>{recoveringDraft ? '正在处理…' : '恢复'}</button>}
            {onDiscardDraft && <button type="button" data-editor-discard-draft={draft.id}
              onClick={() => onDiscardDraft(draft.id)} disabled={recoveringDraft || saving}>丢弃</button>}
          </div>
        </li>)}</ol>
      </section>}

      {latestSourceBackupId && <section className="source-backup" role="status" data-editor-source-backup="true">
        <span>本次改写前的原始字节已保留为恢复文件。</span>
        {onDiscardSourceBackup && <button type="button" data-editor-discard-backup="true"
          onClick={() => onDiscardSourceBackup(latestSourceBackupId)} disabled={saving}>清理本次恢复文件</button>}
      </section>}

      {canvasStructurePreview && <section className="source-structure source-structure-preview" aria-label="卡片结构变更预览" data-canvas-structure-preview="true">
        <p><strong>卡片结构变更：</strong>{canvasStructurePreview.summary}</p>
        <p>{canvasStructurePreview.impact?.message}</p>
        {canvasStructurePreview.impact?.unresolved.length ? <ul>{canvasStructurePreview.impact.unresolved.map((item) =>
          <li key={item.id}>{item.quote}</li>)}</ul> : null}
        <div className="source-structure-diff">
          <div><span>变更前</span><pre>{canvasStructurePreview.source}</pre></div>
          <div><span>变更后</span><pre data-canvas-structure-after="true">{canvasStructurePreview.candidate}</pre></div>
        </div>
        <p>确认只更新未保存源码；显式保存后同步批注与画布。继续改动源码时，保存将保守核验无法证明的批注和卡片身份。</p>
        <button type="button" className="primary" data-canvas-structure-confirm="true" onClick={() => void applyCanvasStructure()}
          disabled={saving || sourceIsReadOnly || markdownToEditorText(canvasStructurePreview.source) !== value}>确认并加入撤销栈</button>
        <button type="button" data-canvas-structure-cancel="true" onClick={onCancelCanvasStructure} disabled={saving}>取消预览</button>
        {markdownToEditorText(canvasStructurePreview.source) !== value && <p role="alert">源码在预览后变化，请取消并重新生成预览。</p>}
      </section>}

      {!canvasStructurePreview && sections && sections.length > 0 && <section className="source-structure" aria-label="章节源码变换" data-editor-structure="true">
        <div className="source-structure-heading">
          <div><strong>章节源码变换</strong><span>所有操作先生成候选，确认后作为一次编辑进入撤销栈。</span></div>
        </div>
        <div className="source-structure-controls">
          <label>源章节
            <select data-structure-source="true" value={moveSourceIndex ?? ''} onChange={(event) => {
              setMoveSourceIndex(Number(event.target.value)); setStructurePreview(null);
            }} disabled={sourceIsReadOnly || saving}>
              {sections.map((section) => <option key={section.key} value={section.key}>{sectionOptionLabel(section)}</option>)}
            </select>
          </label>
          <label>目标章节
            <select data-structure-target="true" value={moveTargetIndex ?? ''} onChange={(event) => {
              setMoveTargetIndex(Number(event.target.value)); setStructurePreview(null);
            }} disabled={sourceIsReadOnly || saving}>
              {sections.map((section) => <option key={section.key} value={section.key}>{sectionOptionLabel(section)}</option>)}
            </select>
          </label>
          <button type="button" data-editor-preview-move="true" onClick={previewMove}
            disabled={sourceIsReadOnly || saving || moveSourceIndex === null || moveTargetIndex === null}>预览移动为子章节</button>
        </div>
        <div className="source-structure-controls">
          <label>提升章节
            <select data-structure-level-section="true" value={levelSectionIndex ?? ''} onChange={(event) => {
              const next = Number(event.target.value);
              setLevelSectionIndex(next);
              const section = sections.find((item) => Number(item.key) === next);
              setLevelTargetDepth(Math.max(1, (section?.headingDepth ?? section?.depth ?? 1) - 1));
              setStructurePreview(null);
            }} disabled={sourceIsReadOnly || saving}>
              {sections.map((section) => <option key={section.key} value={section.key}>{sectionOptionLabel(section)}</option>)}
            </select>
          </label>
          <label>新标题级别
            <select data-structure-level-depth="true" value={levelTargetDepth} onChange={(event) => {
              setLevelTargetDepth(Number(event.target.value)); setStructurePreview(null);
            }} disabled={sourceIsReadOnly || saving}>
              {Array.from({ length: Math.max(1, selectedHeadingDepth - 1) }, (_, index) => index + 1)
                .map((depth) => <option key={depth} value={depth}>第 {depth} 级</option>)}
            </select>
          </label>
          <button type="button" data-editor-preview-level="true" onClick={previewLevelChange}
            disabled={sourceIsReadOnly || saving || levelSectionIndex === null || selectedHeadingDepth <= 1}>预览提升章节</button>
          <span className="source-structure-hint">当前第 {selectedHeadingDepth} 级</span>
        </div>
        {structurePreview && <div className="source-structure-preview" role="status" data-editor-structure-preview="true">
          {structurePreview.status !== 'ready' ? <p className="source-editor-readonly">{structurePreview.rejection.message}</p> : <>
            <p><strong>变更预览：</strong>{structurePreview.summary}</p>
            <div data-editor-annotation-impact="true">
              <p>{annotationImpact?.message ?? '正在核验批注影响…'}</p>
              {annotationImpact && annotationImpact.unresolved.length > 0 && <ul>
                {annotationImpact.unresolved.map((item) => <li key={item.id}>{item.quote}</li>)}
              </ul>}
            </div>
            <div className="source-structure-diff">
              <div><span>变更前</span><pre>{structurePreview.source}</pre></div>
              <div><span>变更后</span><pre data-editor-structure-after="true">{structurePreview.candidate}</pre></div>
            </div>
            <button type="button" className="primary" data-editor-apply-structure="true"
              onClick={applyStructurePreview} disabled={sourceIsReadOnly || saving || !annotationImpact || structurePreview.source !== value}>确认并加入撤销栈</button>
          </>}
          <button type="button" data-editor-cancel-structure="true" onClick={() => setStructurePreview(null)}>取消预览</button>
        </div>}
      </section>}

      {effectiveReadOnlyReason && <div className="source-editor-readonly" role="alert">
        {effectiveReadOnlyReason}
      </div>}

      {searchOpen && <div className="source-findbar" role="search" data-editor-search="true">
        <label htmlFor="source-find-input">查找源码</label>
        <input ref={searchInputRef} id="source-find-input" data-editor-find-input="true" type="search"
          value={query} onChange={(event) => { setQuery(event.target.value); setSearchIndex(0); }}
          onKeyDown={handleSearchKeyDown} autoComplete="off" spellCheck={false} />
        {replaceOpen && <>
          <label htmlFor="source-replace-input">替换为</label>
          <input id="source-replace-input" data-editor-replace-input="true" value={replacement}
            onChange={(event) => setReplacement(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeSearch();
              }
            }} autoComplete="off" spellCheck={false} />
        </>}
        <output aria-live="polite">{query
          ? search.offsets.length > 0
            ? `${Math.min(searchIndex + 1, search.offsets.length)} / ${search.offsets.length}${search.truncated ? '（仅检查前 10000 项）' : ''}`
            : '没有匹配'
          : '输入原始源码文字'}</output>
        <div className="source-find-actions">
          <button type="button" aria-label="上一个源码匹配" onClick={() => focusMatch(searchIndex - 1)}
            disabled={search.offsets.length === 0}>↑</button>
          <button type="button" aria-label="下一个源码匹配" onClick={() => focusMatch(searchIndex + 1)}
            disabled={search.offsets.length === 0}>↓</button>
          {replaceOpen && <>
            <button type="button" data-editor-replace-current="true" onClick={replaceCurrent}
              disabled={sourceIsReadOnly || saving || search.offsets.length === 0}>替换</button>
            <button type="button" data-editor-replace-all="true" onClick={replaceAll}
              disabled={sourceIsReadOnly || saving || search.offsets.length === 0 || search.truncated}>全部替换</button>
          </>}
          <button type="button" aria-label="关闭源码查找" onClick={closeSearch}>×</button>
        </div>
      </div>}

      <div className="source-editor-frame">
        <textarea ref={textareaRef} className="source-editor-textarea" data-editor-textarea="true"
          aria-label="Markdown 源码" value={value} readOnly={sourceIsReadOnly || saving}
          onChange={handleTextChange} onKeyDown={handleEditorKeyDown}
          onSelect={(event) => reportSelection(selectionFor(event.currentTarget))}
          autoCapitalize="off" autoCorrect="off" spellCheck={false} wrap="off" />
      </div>

      <footer className="source-editor-status" data-editor-status="true" role="status">
        <span className={dirty ? 'dirty' : undefined}>{dirty ? '未保存' : '已保存'}</span>
        <span>{sourceFormat.bomByteLength === 3 ? 'UTF-8 BOM' : 'UTF-8'}</span>
        <span>{lineEndingLabel(sourceFormat, value)}</span>
        <span>{currentTrailingLineEnding ? '末尾有换行' : '末尾无换行'}</span>
        <span>行 {cursor.line}，列 {cursor.column}</span>
        {cursor.selectionLength > 0 && <span>已选 {cursor.selectionLength} 字</span>}
        {(saveMessage || actionMessage) && <span className="source-editor-message">{saveMessage ?? actionMessage}</span>}
      </footer>
    </main>
  </div>;
}

/** Concise alias used by the renderer composition root. */
export const EditorView = MarkdownEditorView;
