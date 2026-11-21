import { createElement, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, ClipboardEvent, FormEvent } from 'react';
import { createReaderEditSession } from './reader-edit-session';

interface ReaderEditableBlockProps {
  readonly documentKey: string;
  readonly as: 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  readonly blockStart: number;
  readonly sourceText: string;
  readonly enabled: boolean;
  readonly onCommit: (blockStart: number, sourceText: string, text: string) => Promise<boolean>;
  readonly onDraftChange: (dirty: boolean) => void;
  readonly onActivityChange: (kind: 'composing' | 'committing', active: boolean) => void;
  readonly onRestricted: (blockStart: number, reason: string, draftText?: string) => void;
  readonly children: ReactNode;
  readonly className?: string;
  readonly id?: string;
  readonly tabIndex?: number;
}

function insertPlainText(text: string): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1) return false;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/**
 * A deliberately narrow contenteditable surface for one plain Markdown block.
 * It never serializes the rendered article. The owner receives only this
 * block's visible text and maps it back to a proven source range.
 */
export function ReaderEditableBlock({
  documentKey,
  as,
  blockStart,
  sourceText,
  enabled,
  onCommit,
  onDraftChange,
  onActivityChange,
  onRestricted,
  children,
  className,
  id,
  tabIndex,
}: ReaderEditableBlockProps) {
  // Chromium does not name editable headings from their contents automatically.
  // Refer to the live DOM text so unsaved input is reflected without a stale label.
  const generatedId = useId();
  const headingId = as === 'p' ? undefined : (id ?? `reader-heading-${generatedId}`);
  const elementRef = useRef<HTMLElement | null>(null);
  const [restoreVersion, setRestoreVersion] = useState(0);
  const nativeMutationRef = useRef(false);
  const retainedDraftRef = useRef(true);
  const sourceIdentityRef = useRef({ documentKey, as, blockStart, sourceText, id });
  const sessionRef = useRef<ReturnType<typeof createReaderEditSession> | null>(null);
  const callbacks = useRef({ onCommit, onDraftChange, onRestricted });
  callbacks.current = { onCommit, onDraftChange, onRestricted };
  useLayoutEffect(() => {
    const previous = sourceIdentityRef.current;
    const replaced = previous.documentKey !== documentKey || previous.as !== as ||
      previous.blockStart !== blockStart || previous.sourceText !== sourceText || previous.id !== id;
    sourceIdentityRef.current = { documentKey, as, blockStart, sourceText, id };
    // Preserve a draft paused before handoff (for example, a rejected paste).
    // Once handed off, the source/feedback owns its text: restore the rendered
    // children even if disabling disposes this session before its reply arrives.
    // Untouched DOM and its live ranges always stay connected.
    if ((replaced || !retainedDraftRef.current) && nativeMutationRef.current) {
      nativeMutationRef.current = false;
      setRestoreVersion(version => version + 1);
    }
    if (!enabled) return;
    const session = createReaderEditSession({
      sourceText,
      readText: () => elementRef.current?.isConnected ? elementRef.current.textContent ?? '' : null,
      isFocused: () => document.activeElement === elementRef.current,
      restoreChildren: () => {
        nativeMutationRef.current = false;
        setRestoreVersion(version => version + 1);
      },
      onCommit: text => callbacks.current.onCommit(blockStart, sourceText, text),
      onDraftChange: dirty => callbacks.current.onDraftChange(dirty),
      onRestricted: (reason, text) => callbacks.current.onRestricted(blockStart, reason, text),
      // Only own committing leases. Window capture owns composing activity.
      onCommittingChange: active => onActivityChange('committing', active),
      scheduler: {
        frame: run => { const frame = requestAnimationFrame(run); return () => cancelAnimationFrame(frame); },
        task: run => { const task = window.setTimeout(run, 0); return () => window.clearTimeout(task); },
      },
    });
    sessionRef.current = session;
    // Adopt a paused draft even if disabling moved focus away. Its ownership
    // must survive another pause; this does not move the DOM focus or caret.
    if ((nativeMutationRef.current && retainedDraftRef.current) || document.activeElement === elementRef.current) session.focus();
    return () => {
      retainedDraftRef.current = session.ownsDraft();
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [documentKey, as, blockStart, sourceText, enabled, id, onActivityChange]);

  const handlePaste = (event: ClipboardEvent<HTMLElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    if (/\r|\n/u.test(text)) {
      onRestricted(blockStart, '多行内容请在源码中粘贴，当前正文未改变。', text);
      return;
    }
    if (insertPlainText(text)) {
      nativeMutationRef.current = true;
      sessionRef.current?.input();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (sessionRef.current?.composing() || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      elementRef.current?.blur();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      onRestricted(blockStart, '阅读中暂不拆分段落，请在源码中换行。');
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      sessionRef.current?.restore();
      elementRef.current?.blur();
      return;
    }
  };

  return createElement(as, {
    key: restoreVersion,
    ref: (element: HTMLElement | null) => { elementRef.current = element; },
    id: headingId ?? id,
    'aria-labelledby': headingId,
    tabIndex,
    className: [className, enabled ? 'reader-editable-block' : undefined].filter(Boolean).join(' ') || undefined,
    contentEditable: enabled,
    suppressContentEditableWarning: true,
    'data-reader-editable': enabled ? 'true' : undefined,
    'data-source-block-start': blockStart,
    'aria-description': enabled ? '点击正文直接编辑；换行或复杂编辑可在源码中继续' : undefined,
    onFocus: enabled ? () => sessionRef.current?.focus() : undefined,
    onCompositionStart: enabled ? () => {
      nativeMutationRef.current = true;
      sessionRef.current?.compositionStart();
    } : undefined,
    onCompositionEnd: enabled ? () => sessionRef.current?.compositionEnd() : undefined,
    onBeforeInput: (event: FormEvent<HTMLElement>) => {
      if (!enabled) { event.preventDefault(); return; }
      const inputType = (event.nativeEvent as InputEvent).inputType;
      if (!sessionRef.current?.composing() && (inputType === 'insertParagraph' || inputType === 'insertLineBreak' || inputType.startsWith('format'))) {
        event.preventDefault();
        onRestricted(blockStart, inputType.startsWith('format')
          ? '这项格式操作请使用选文菜单，或在源码中继续。'
          : '阅读中暂不拆分段落，请在源码中换行。');
      }
    },
    onInput: enabled ? () => {
      nativeMutationRef.current = true;
      sessionRef.current?.input();
    } : undefined,
    onPaste: enabled ? handlePaste : undefined,
    onKeyDown: enabled ? handleKeyDown : undefined,
    onBlur: () => sessionRef.current?.blur(),
  }, children);
}
