import { createElement, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, ClipboardEvent, FormEvent } from 'react';

interface ReaderEditableBlockProps {
  readonly as: 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  readonly blockStart: number;
  readonly sourceText: string;
  readonly enabled: boolean;
  readonly onCommit: (blockStart: number, sourceText: string, text: string) => Promise<boolean>;
  readonly onDraftChange: (dirty: boolean) => void;
  readonly onRestricted: (blockStart: number, reason: string, draftText?: string) => void;
  readonly children: ReactNode;
  readonly className?: string;
  readonly id?: string;
  readonly tabIndex?: number;
}

function insertPlainText(text: string): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * A deliberately narrow contenteditable surface for one plain Markdown block.
 * It never serializes the rendered article. The owner receives only this
 * block's visible text and maps it back to a proven source range.
 */
export function ReaderEditableBlock({
  as,
  blockStart,
  sourceText,
  enabled,
  onCommit,
  onDraftChange,
  onRestricted,
  children,
  className,
  id,
  tabIndex,
}: ReaderEditableBlockProps) {
  const elementRef = useRef<HTMLElement | null>(null);
  const originalRef = useRef(sourceText);
  const [restoreVersion, setRestoreVersion] = useState(0);
  const draftRef = useRef(sourceText);
  const editingRef = useRef(false);
  const composingRef = useRef(false);
  const pendingBlurRef = useRef(false);

  useEffect(() => {
    if (editingRef.current) return;
    originalRef.current = sourceText;
    draftRef.current = sourceText;
  }, [sourceText]);

  const restore = () => {
    const element = elementRef.current;
    if (!element) return;
    // Recreate the original React children so formatting and link handlers survive Escape.
    setRestoreVersion((version) => version + 1);
    draftRef.current = originalRef.current;
    onDraftChange(false);
  };

  const handleInput = (event: FormEvent<HTMLElement>) => {
    const text = event.currentTarget.textContent ?? '';
    if (/\r|\n/u.test(text)) {
      onRestricted(blockStart, '换行请在源码中继续，已保留未应用的输入。', text);
      restore();
      return;
    }
    draftRef.current = text;
    onDraftChange(text !== originalRef.current);
  };

  const handlePaste = (event: ClipboardEvent<HTMLElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    if (/\r|\n/u.test(text)) {
      onRestricted(blockStart, '多行内容请在源码中粘贴，当前正文未改变。', text);
      return;
    }
    insertPlainText(text);
    draftRef.current = event.currentTarget.textContent ?? '';
    onDraftChange(draftRef.current !== originalRef.current);
  };

  const commitDraft = () => {
    editingRef.current = false;
    const next = draftRef.current;
    onDraftChange(false);
    if (next !== originalRef.current) void onCommit(blockStart, originalRef.current, next).then((accepted) => {
      if (!accepted && elementRef.current?.isConnected) restore();
    });
  };

  const handleBlur = () => {
    if (composingRef.current) {
      pendingBlurRef.current = true;
      return;
    }
    commitDraft();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (composingRef.current || event.nativeEvent.isComposing) return;
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
      restore();
      elementRef.current?.blur();
      return;
    }
  };

  return createElement(as, {
    key: restoreVersion,
    ref: (element: HTMLElement | null) => { elementRef.current = element; },
    id,
    tabIndex,
    className: [className, enabled ? 'reader-editable-block' : undefined].filter(Boolean).join(' ') || undefined,
    contentEditable: enabled,
    suppressContentEditableWarning: true,
    'data-reader-editable': enabled ? 'true' : undefined,
    'data-source-block-start': blockStart,
    title: enabled ? '点击正文直接编辑；换行或复杂编辑可在源码中继续' : undefined,
    onFocus: () => { editingRef.current = true; },
    onCompositionStart: () => { composingRef.current = true; pendingBlurRef.current = false; },
    onCompositionEnd: () => {
      composingRef.current = false;
      if (pendingBlurRef.current && document.activeElement !== elementRef.current) {
        pendingBlurRef.current = false;
        commitDraft();
      }
    },
    onBeforeInput: (event: FormEvent<HTMLElement>) => {
      const inputType = (event.nativeEvent as InputEvent).inputType;
      if (!composingRef.current && (inputType === 'insertParagraph' || inputType === 'insertLineBreak' || inputType.startsWith('format'))) {
        event.preventDefault();
        onRestricted(blockStart, inputType.startsWith('format')
          ? '这项格式操作请使用选文菜单，或在源码中继续。'
          : '阅读中暂不拆分段落，请在源码中换行。');
      }
    },
    onInput: handleInput,
    onPaste: handlePaste,
    onKeyDown: handleKeyDown,
    onBlur: handleBlur,
  }, children);
}
