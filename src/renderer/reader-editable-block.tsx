import { createElement, useEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode, ClipboardEvent, FormEvent } from 'react';

interface ReaderEditableBlockProps {
  readonly as: 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  readonly blockStart: number;
  readonly sourceText: string;
  readonly enabled: boolean;
  readonly onCommit: (blockStart: number, sourceText: string, text: string) => void;
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
  children,
  className,
  id,
  tabIndex,
}: ReaderEditableBlockProps) {
  const elementRef = useRef<HTMLElement | null>(null);
  const originalRef = useRef(sourceText);
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
    element.textContent = originalRef.current;
    draftRef.current = originalRef.current;
  };

  const handleInput = (event: FormEvent<HTMLElement>) => {
    const text = event.currentTarget.textContent ?? '';
    if (/\r|\n/u.test(text)) {
      restore();
      return;
    }
    draftRef.current = text;
  };

  const handlePaste = (event: ClipboardEvent<HTMLElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    if (/\r|\n/u.test(text)) return;
    insertPlainText(text);
    draftRef.current = event.currentTarget.textContent ?? '';
  };

  const commitDraft = () => {
    editingRef.current = false;
    const next = draftRef.current;
    if (next !== originalRef.current) onCommit(blockStart, originalRef.current, next);
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
    ref: (element: HTMLElement | null) => { elementRef.current = element; },
    id,
    tabIndex,
    className: [className, enabled ? 'reader-editable-block' : undefined].filter(Boolean).join(' ') || undefined,
    contentEditable: enabled,
    suppressContentEditableWarning: true,
    'data-reader-editable': enabled ? 'true' : undefined,
    'data-source-block-start': blockStart,
    title: enabled ? '点击正文直接编辑；Enter 保持在当前段落' : undefined,
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
      }
    },
    onInput: handleInput,
    onPaste: handlePaste,
    onKeyDown: handleKeyDown,
    onBlur: handleBlur,
  }, children);
}
