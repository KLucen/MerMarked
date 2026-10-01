import { useCallback, useEffect, useRef, useState } from 'react';
import { editorToMarkdownText } from '../core/editor-text';
import { inspectMarkdownSourceFormat } from '../core/markdown-source';
import type { EditableMarkdownLineEnding } from '../core/editor-text';
import type {
  MarkdownEditorSaveResult,
  MarkdownEditorView,
  OpenedMarkdownDocument,
} from '../types/reader-api';

const draftDelayMs = 700;

interface MarkdownEditorController {
  readonly editor: MarkdownEditorView | null;
  readonly opening: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  open(): Promise<MarkdownEditorView | null>;
  changeEditorText(editorText: string): void;
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
  const [opening, setOpening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<MarkdownEditorView | null>(null);
  const documentRef = useRef(document);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const draftTimerRef = useRef<number | null>(null);
  const generationRef = useRef(0);

  const publish = useCallback((next: MarkdownEditorView | null) => {
    editorRef.current = next;
    setEditor(next);
  }, []);

  const clearDraftTimer = useCallback(() => {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    generationRef.current += 1;
    clearDraftTimer();
    queueRef.current = Promise.resolve();
    publish(null);
    setOpening(false);
    setBusy(false);
    setError(null);
  }, [clearDraftTimer, publish]);

  useEffect(() => {
    documentRef.current = document;
  }, [document]);

  useEffect(() => () => clearDraftTimer(), [clearDraftTimer]);

  const acceptServerView = useCallback((next: MarkdownEditorView, generation: number) => {
    if (generationRef.current !== generation) return;
    const current = editorRef.current;
    if (!current || current.epoch !== next.epoch || next.revision >= current.revision) publish(next);
  }, [publish]);

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
    if (!documentRef.current || opening) return editorRef.current;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    clearDraftTimer();
    queueRef.current = Promise.resolve();
    setOpening(true);
    setError(null);
    try {
      const next = await window.mermarkd.openMarkdownEditor();
      if (generationRef.current !== generation) return null;
      publish(next);
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
  }, [clearDraftTimer, onStatus, opening, publish]);

  const changeEditorText = useCallback((editorText: string) => {
    const current = editorRef.current;
    const persisted = documentRef.current;
    if (!current || !persisted || !current.editable || busy) return;
    const content = editorToMarkdownText(editorText, preferredLineEnding(current));
    if (content === current.content) return;
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
    publish(optimistic);
    setError(null);
    void enqueue(async () => {
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
        setError(message);
        onStatus(message, true);
      }
    });
    checkpoint(generation);
  }, [acceptServerView, busy, checkpoint, enqueue, onStatus, publish]);

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
      publish(result.editor);
      if (result.status === 'saved') onDocumentSaved(result.document);
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
  }, [busy, clearDraftTimer, onDocumentSaved, onStatus, publish]);

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
      onAccepted(result.editor.content);
      publish(result.editor); setError(null); checkpoint(generation);
      return true;
    } catch (caught) {
      const message = errorMessage(caught, '无法确认章节结构变更。');
      setError(message); onStatus(message, true); return false;
    } finally { if (generationRef.current === generation) setBusy(false); }
  }, [busy, checkpoint, clearDraftTimer, onStatus, publish]);

  const discardChanges = useCallback(async () => {
    const current = editorRef.current;
    if (!current || busy) return;
    clearDraftTimer();
    setBusy(true);
    try {
      await queueRef.current;
      const result = await window.mermarkd.discardMarkdownEditorChanges(current.epoch);
      onDocumentDiscarded(result.document);
      publish(result.editor);
      setError(null);
      onStatus('已放弃未保存编辑，并从磁盘重新载入 Markdown。');
    } catch (caught) {
      const message = errorMessage(caught, '无法放弃并重新载入 Markdown。');
      setError(message);
      onStatus(message, true);
    } finally {
      setBusy(false);
    }
  }, [busy, clearDraftTimer, onDocumentDiscarded, onStatus, publish]);

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
      publish(next);
      setError(null);
      onStatus(success);
    } catch (caught) {
      const message = errorMessage(caught, '无法处理 Markdown 恢复项。');
      setError(message);
      onStatus(message, true);
    } finally {
      setBusy(false);
    }
  }, [busy, clearDraftTimer, onStatus, publish]);

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
    opening,
    busy,
    error,
    open,
    changeEditorText,
    save,
    discardChanges,
    restoreDraft,
    discardDraft,
    discardSourceBackup,
    confirmStructure,
    reset,
  };
}
