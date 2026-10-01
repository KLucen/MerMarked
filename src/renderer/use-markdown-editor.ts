import { useCallback, useEffect, useRef, useState } from 'react';
import { editorToMarkdownText, markdownToEditorText } from '../core/editor-text';
import {
  applyMarkdownTextEdit,
  createMarkdownEditSession,
  redoMarkdownEdit,
  undoMarkdownEdit,
  type MarkdownEditSelection,
  type MarkdownEditSession,
} from '../core/markdown-edit-transaction';
import { inspectMarkdownSourceFormat } from '../core/markdown-source';
import type { EditableMarkdownLineEnding } from '../core/editor-text';
import type {
  MarkdownEditorSaveResult,
  MarkdownEditorView,
  OpenedMarkdownDocument,
} from '../types/reader-api';

const draftDelayMs = 700;
const maxSharedHistoryEntries = 500;

interface MarkdownEditorController {
  readonly editor: MarkdownEditorView | null;
  /** The renderer-side transaction shared by the source editor across mode switches. */
  readonly editSession: MarkdownEditSession | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly opening: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  open(): Promise<MarkdownEditorView | null>;
  changeEditorText(editorText: string): void;
  undo(): MarkdownEditSelection | null;
  redo(): MarkdownEditSelection | null;
  save(): Promise<MarkdownEditorSaveResult | null>;
  discardChanges(): Promise<void>;
  restoreDraft(id: string): Promise<void>;
  discardDraft(id: string): Promise<void>;
  discardSourceBackup(id: string): Promise<void>;
  confirmStructure(token: string, onAccepted: (content: string) => void): Promise<boolean>;
  reset(): void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function preferredLineEnding(editor: MarkdownEditorView): EditableMarkdownLineEnding {
  const ending = editor.sourceFormat.lineEnding;
  return ending === 'mixed' ? 'lf' : ending;
}

function changedRange(before: string, after: string): { start: number; end: number; replacement: string } | null {
  if (before === after) return null;
  let start = 0;
  const shared = Math.min(before.length, after.length);
  while (start < shared && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start &&
    before.charCodeAt(beforeEnd - 1) === after.charCodeAt(afterEnd - 1)) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  const isHighSurrogate = (value: number) => value >= 0xd800 && value <= 0xdbff;
  const isLowSurrogate = (value: number) => value >= 0xdc00 && value <= 0xdfff;
  while (start > 0 && (
    (isLowSurrogate(before.charCodeAt(start)) && isHighSurrogate(before.charCodeAt(start - 1))) ||
    (isLowSurrogate(after.charCodeAt(start)) && isHighSurrogate(after.charCodeAt(start - 1)))
  )) start -= 1;
  while (beforeEnd < before.length && isLowSurrogate(before.charCodeAt(beforeEnd)) &&
    isHighSurrogate(before.charCodeAt(beforeEnd - 1))) beforeEnd += 1;
  while (afterEnd < after.length && isLowSurrogate(after.charCodeAt(afterEnd)) &&
    isHighSurrogate(after.charCodeAt(afterEnd - 1))) afterEnd += 1;
  return { start, end: beforeEnd, replacement: after.slice(start, afterEnd) };
}

function boundHistory(session: MarkdownEditSession): MarkdownEditSession {
  if (session.past.length <= maxSharedHistoryEntries) return session;
  return { ...session, past: session.past.slice(-maxSharedHistoryEntries) };
}

/**
 * Keeps renderer edits ordered against the main-process session. The optimistic
 * view makes typing immediate, while the promise chain preserves monotonic
 * revisions for IPC, draft checkpoints, and explicit saves.
 */
export function useMarkdownEditor(
  document: OpenedMarkdownDocument | null,
  onDocumentSaved: (document: OpenedMarkdownDocument) => void,
  onDocumentDiscarded: (document: OpenedMarkdownDocument) => void,
  onStatus: (message: string, alert?: boolean) => void,
): MarkdownEditorController {
  const [editor, setEditor] = useState<MarkdownEditorView | null>(null);
  const [editSession, setEditSession] = useState<MarkdownEditSession | null>(null);
  const [opening, setOpening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<MarkdownEditorView | null>(null);
  const confirmedEditorRef = useRef<MarkdownEditorView | null>(null);
  const editSessionRef = useRef<MarkdownEditSession | null>(null);
  const documentRef = useRef(document);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const draftTimerRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const mutationTokenRef = useRef(0);

  const publish = useCallback((next: MarkdownEditorView | null) => {
    editorRef.current = next;
    setEditor(next);
  }, []);

  const publishSession = useCallback((next: MarkdownEditSession | null) => {
    editSessionRef.current = next;
    setEditSession(next);
  }, []);

  const clearDraftTimer = useCallback(() => {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    generationRef.current += 1;
    mutationTokenRef.current += 1;
    clearDraftTimer();
    queueRef.current = Promise.resolve();
    publish(null);
    confirmedEditorRef.current = null;
    publishSession(null);
    setOpening(false);
    setBusy(false);
    setError(null);
  }, [clearDraftTimer, publish, publishSession]);

  useEffect(() => {
    documentRef.current = document;
  }, [document]);

  useEffect(() => () => clearDraftTimer(), [clearDraftTimer]);

  const acceptServerView = useCallback((next: MarkdownEditorView, generation: number) => {
    if (generationRef.current !== generation) return;
    const current = editorRef.current;
    if (!current || current.epoch !== next.epoch || next.revision >= current.revision) {
      confirmedEditorRef.current = next;
      publish(next);
      const session = editSessionRef.current;
      const normalized = markdownToEditorText(next.content);
      if (!session || session.current.content !== normalized) {
        publishSession(createMarkdownEditSession(normalized));
      }
    }
  }, [publish, publishSession]);

  const recoverRejectedUpdate = useCallback(async (generation: number, message: string) => {
    mutationTokenRef.current += 1;
    try {
      const next = await window.mermarkd.openMarkdownEditor();
      if (generationRef.current !== generation) return;
      confirmedEditorRef.current = next;
      publish(next);
      publishSession(createMarkdownEditSession(markdownToEditorText(next.content)));
      setError(message);
      onStatus(`${message} 已恢复到主进程确认的版本。`, true);
    } catch (caught) {
      if (generationRef.current !== generation) return;
      const fallback = confirmedEditorRef.current;
      if (fallback) {
        publish(fallback);
        publishSession(createMarkdownEditSession(markdownToEditorText(fallback.content)));
      }
      setError(errorMessage(caught, message));
      onStatus(message, true);
    }
  }, [onStatus, publish, publishSession]);

  const enqueue = useCallback((operation: () => Promise<void>): Promise<void> => {
    const next = queueRef.current.catch(() => undefined).then(operation);
    queueRef.current = next;
    return next;
  }, []);

  const checkpoint = useCallback((generation: number) => {
    clearDraftTimer();
    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = null;
      void enqueue(async () => {
        const current = editorRef.current;
        if (!current || generationRef.current !== generation) return;
        try {
          const next = await window.mermarkd.persistMarkdownEditorDraft({
            epoch: current.epoch,
            revision: current.revision,
            content: current.content,
          });
          acceptServerView(next, generation);
          setError(null);
        } catch (caught) {
          if (generationRef.current !== generation) return;
          const message = errorMessage(caught, '无法保存 Markdown 恢复草稿。');
          setError(message);
          onStatus(message, true);
        }
      });
    }, draftDelayMs);
  }, [acceptServerView, clearDraftTimer, enqueue, onStatus]);

  const open = useCallback(async (): Promise<MarkdownEditorView | null> => {
    // Opening is idempotent across mode switches and reader-side edits. A
    // stale mode callback may call this after the editor has already been
    // created; reopening would rebuild the shared undo session and lose the
    // reader edit history while leaving the dirty text visible.
    if (!documentRef.current || opening || editorRef.current) return editorRef.current;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    clearDraftTimer();
    queueRef.current = Promise.resolve();
    setOpening(true);
    setError(null);
    try {
      const next = await window.mermarkd.openMarkdownEditor();
      if (generationRef.current !== generation) return null;
      confirmedEditorRef.current = next;
      publish(next);
      publishSession(createMarkdownEditSession(markdownToEditorText(next.content)));
      return next;
    } catch (caught) {
      if (generationRef.current === generation) {
        const message = errorMessage(caught, '无法进入编辑模式。');
        setError(message);
        onStatus(message, true);
      }
      return null;
    } finally {
      if (generationRef.current === generation) setOpening(false);
    }
  }, [clearDraftTimer, onStatus, opening, publish, publishSession]);

  const changeEditorText = useCallback((editorText: string) => {
    const current = editorRef.current;
    const persisted = documentRef.current;
    if (!current || !persisted || !current.editable || busy) return;
    const content = editorToMarkdownText(editorText, preferredLineEnding(current));
    const normalized = markdownToEditorText(content);
    let session = editSessionRef.current;
    if (!session || session.current.content !== markdownToEditorText(current.content)) {
      session = createMarkdownEditSession(markdownToEditorText(current.content));
    }
    const change = changedRange(session.current.content, normalized);
    if (!change) return;
    const nextSession = boundHistory(applyMarkdownTextEdit(session, {
      expectedRevision: session.revision,
      selection: { start: change.start, end: change.end },
      replacement: change.replacement,
    }));
    publishSession(nextSession);
    const revision = current.revision + 1;
    const optimistic: MarkdownEditorView = {
      ...current,
      revision,
      content,
      dirty: content !== persisted.content,
      format: inspectMarkdownSourceFormat(content, persisted.bomByteLength),
      draftPersisted: false,
    };
    const generation = generationRef.current;
    const mutationToken = mutationTokenRef.current;
    publish(optimistic);
    setError(null);
    void enqueue(async () => {
      if (generationRef.current !== generation || mutationTokenRef.current !== mutationToken) return;
      try {
        const next = await window.mermarkd.updateMarkdownEditor({
          epoch: optimistic.epoch,
          revision,
          content,
        });
        acceptServerView(next, generation);
      } catch (caught) {
        if (generationRef.current !== generation) return;
        const message = errorMessage(caught, '源码编辑未被主进程接受。');
        await recoverRejectedUpdate(generation, message);
      }
    });
    checkpoint(generation);
  }, [acceptServerView, busy, checkpoint, enqueue, onStatus, publish, publishSession, recoverRejectedUpdate]);

  const applySessionContent = useCallback((nextSession: MarkdownEditSession, generation: number) => {
    const current = editorRef.current;
    if (!current || !current.editable || generationRef.current !== generation) return;
    const content = editorToMarkdownText(nextSession.current.content, preferredLineEnding(current));
    if (content === current.content) {
      publishSession(nextSession);
      return;
    }
    const revision = current.revision + 1;
    const persisted = documentRef.current;
    const optimistic: MarkdownEditorView = {
      ...current,
      revision,
      content,
      dirty: Boolean(persisted && content !== persisted.content),
      format: inspectMarkdownSourceFormat(content, persisted?.bomByteLength ?? current.sourceFormat.bomByteLength),
      draftPersisted: false,
    };
    const mutationToken = mutationTokenRef.current;
    publishSession(nextSession);
    publish(optimistic);
    setError(null);
    void enqueue(async () => {
      if (generationRef.current !== generation || mutationTokenRef.current !== mutationToken) return;
      try {
        const next = await window.mermarkd.updateMarkdownEditor({ epoch: optimistic.epoch, revision, content });
        acceptServerView(next, generation);
      } catch (caught) {
        if (generationRef.current !== generation) return;
        const message = errorMessage(caught, '源码编辑未被主进程接受。');
        await recoverRejectedUpdate(generation, message);
      }
    });
    checkpoint(generation);
  }, [acceptServerView, checkpoint, enqueue, onStatus, publish, publishSession, recoverRejectedUpdate]);

  const undo = useCallback((): MarkdownEditSelection | null => {
    const current = editSessionRef.current;
    const editorView = editorRef.current;
    if (!current || !editorView || busy || !editorView.editable) return null;
    const next = undoMarkdownEdit(current);
    if (next === current) return null;
    applySessionContent(next, generationRef.current);
    return next.current.selection;
  }, [applySessionContent, busy]);

  const redo = useCallback((): MarkdownEditSelection | null => {
    const current = editSessionRef.current;
    const editorView = editorRef.current;
    if (!current || !editorView || busy || !editorView.editable) return null;
    const next = redoMarkdownEdit(current);
    if (next === current) return null;
    applySessionContent(next, generationRef.current);
    return next.current.selection;
  }, [applySessionContent, busy]);

  const save = useCallback(async (): Promise<MarkdownEditorSaveResult | null> => {
    const generation = generationRef.current;
    const initial = editorRef.current;
    if (!initial || busy || !initial.editable) return null;
    clearDraftTimer();
    setBusy(true);
    setError(null);
    try {
      await queueRef.current;
      const current = editorRef.current;
      if (!current || generationRef.current !== generation) return null;
      const result = await window.mermarkd.saveMarkdownEditor({
        epoch: current.epoch,
        revision: current.revision,
        content: current.content,
      });
      if (generationRef.current !== generation) return null;
      confirmedEditorRef.current = result.editor;
      publish(result.editor);
      if (result.status === 'saved') {
        publishSession(createMarkdownEditSession(markdownToEditorText(result.editor.content)));
        onDocumentSaved(result.document);
      }
      else setError(result.message);
      onStatus(result.message, result.status !== 'saved');
      return result;
    } catch (caught) {
      if (generationRef.current === generation) {
        const message = errorMessage(caught, '保存 Markdown 失败。');
        setError(message);
        onStatus(message, true);
      }
      return null;
    } finally {
      if (generationRef.current === generation) setBusy(false);
    }
  }, [busy, clearDraftTimer, onDocumentSaved, onStatus, publish, publishSession]);

  const confirmStructure = useCallback(async (token: string, onAccepted: (content: string) => void) => {
    if (busy) return false;
    const generation = generationRef.current;
    clearDraftTimer(); setBusy(true);
    try {
      await queueRef.current;
      const result = await window.mermarkd.confirmSectionStructure(token);
      if (generationRef.current !== generation) return false;
      onStatus(result.message, result.status !== 'staged');
      if (result.status !== 'staged') return false;
      // The editor records the single undo command before the new prop arrives.
      const currentSession = editSessionRef.current;
      if (currentSession) {
        const normalized = markdownToEditorText(result.editor.content);
        const change = changedRange(currentSession.current.content, normalized);
        if (change) {
          const nextSession = boundHistory(applyMarkdownTextEdit(currentSession, {
            expectedRevision: currentSession.revision,
            selection: { start: change.start, end: change.end },
            replacement: change.replacement,
          }));
          publishSession(nextSession);
        }
      } else publishSession(createMarkdownEditSession(markdownToEditorText(result.editor.content)));
      onAccepted(result.editor.content);
      confirmedEditorRef.current = result.editor;
      publish(result.editor); setError(null); checkpoint(generation);
      return true;
    } catch (caught) {
      const message = errorMessage(caught, '无法确认章节结构变更。');
      setError(message); onStatus(message, true); return false;
    } finally { if (generationRef.current === generation) setBusy(false); }
  }, [busy, checkpoint, clearDraftTimer, onStatus, publish, publishSession]);

  const discardChanges = useCallback(async () => {
    const current = editorRef.current;
    if (!current || busy) return;
    clearDraftTimer();
    setBusy(true);
    try {
      await queueRef.current;
      const result = await window.mermarkd.discardMarkdownEditorChanges(current.epoch);
      onDocumentDiscarded(result.document);
      confirmedEditorRef.current = result.editor;
      publish(result.editor);
      publishSession(createMarkdownEditSession(markdownToEditorText(result.editor.content)));
      setError(null);
      onStatus('已放弃未保存编辑，并从磁盘重新载入 Markdown。');
    } catch (caught) {
      const message = errorMessage(caught, '无法放弃并重新载入 Markdown。');
      setError(message);
      onStatus(message, true);
    } finally {
      setBusy(false);
    }
  }, [busy, clearDraftTimer, onDocumentDiscarded, onStatus, publish, publishSession]);

  const runRecoveryAction = useCallback(async (
    action: (current: MarkdownEditorView) => Promise<MarkdownEditorView>,
    success: string,
  ) => {
    const current = editorRef.current;
    if (!current || busy) return;
    clearDraftTimer();
    setBusy(true);
    try {
      await queueRef.current;
      const next = await action(current);
      confirmedEditorRef.current = next;
      publish(next);
      if (next.content !== current.content) {
        publishSession(createMarkdownEditSession(markdownToEditorText(next.content)));
      }
      setError(null);
      onStatus(success);
    } catch (caught) {
      const message = errorMessage(caught, '无法处理 Markdown 恢复项。');
      setError(message);
      onStatus(message, true);
    } finally {
      setBusy(false);
    }
  }, [busy, clearDraftTimer, onStatus, publish, publishSession]);

  const restoreDraft = useCallback(async (id: string) => {
    await runRecoveryAction(
      (current) => window.mermarkd.restoreMarkdownEditorDraft({ epoch: current.epoch, id }),
      '已将恢复草稿载入编辑缓冲区；磁盘 Markdown 尚未修改。',
    );
    checkpoint(generationRef.current);
  }, [checkpoint, runRecoveryAction]);

  const discardDraft = useCallback((id: string) => runRecoveryAction(
    (current) => window.mermarkd.discardMarkdownEditorDraft({ epoch: current.epoch, id }),
    '恢复草稿已丢弃。',
  ), [runRecoveryAction]);

  const discardSourceBackup = useCallback((id: string) => runRecoveryAction(
    (current) => window.mermarkd.discardMarkdownSourceBackup({ epoch: current.epoch, id }),
    '本次保存的恢复文件已清理。',
  ), [runRecoveryAction]);

  return {
    editor,
    editSession,
    canUndo: Boolean(editSession?.past.length),
    canRedo: Boolean(editSession?.future.length),
    opening,
    busy,
    error,
    open,
    changeEditorText,
    undo,
    redo,
    save,
    discardChanges,
    restoreDraft,
    discardDraft,
    discardSourceBackup,
    confirmStructure,
    reset,
  };
}
