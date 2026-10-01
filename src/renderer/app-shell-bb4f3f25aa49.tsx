import { useEffect, useRef } from 'react';
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { OpenedMarkdownDocument } from '../types/reader-api';

export type NoticeKind = 'status' | 'alert';

export interface AppNotice {
  readonly kind: NoticeKind;
  readonly text: string;
}

export interface ReaderSearchState {
  readonly open: boolean;
  readonly query: string;
  readonly currentIndex: number;
  readonly total: number;
  readonly truncated: boolean;
}

interface AppShellProps {
  readonly document: OpenedMarkdownDocument | null;
  readonly opening: boolean;
  readonly dropActive: boolean;
  readonly notice: AppNotice | null;
  readonly sourceChangeMessage: string | null;
  readonly search: ReaderSearchState;
  readonly onOpen: () => void;
  readonly onReloadSource: () => void;
  readonly onOpenSearch: () => void;
  readonly onCloseSearch: () => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSearchNext: () => void;
  readonly onSearchPrevious: () => void;
  readonly onDismissNotice: () => void;
  readonly onDropTargetEnter: (event: ReactDragEvent<HTMLDivElement>) => void;
  readonly onDropTargetOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  readonly onDropTargetLeave: () => void;
  readonly onDropTargetDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
  readonly children: ReactNode;
}

function ModeNavigation() {
  return <nav className="modebar" aria-label="视图模式">
    <button type="button" className="mode-tab current" aria-current="page">阅读模式</button>
    <button type="button" className="mode-tab unavailable" disabled aria-label="编辑模式，尚未开放">
      编辑模式 <span>尚未开放</span>
    </button>
    <button type="button" className="mode-tab unavailable" disabled aria-label="卡片模式，尚未开放">
      卡片模式 <span>尚未开放</span>
    </button>
  </nav>;
}

export function AppShell({
  document,
  opening,
  dropActive,
  notice,
  sourceChangeMessage,
  search,
  onOpen,
  onReloadSource,
  onOpenSearch,
  onCloseSearch,
  onSearchQueryChange,
  onSearchNext,
  onSearchPrevious,
  onDismissNotice,
  onDropTargetEnter,
  onDropTargetOver,
  onDropTargetLeave,
  onDropTargetDrop,
  children,
}: AppShellProps) {
  const searchInput = useRef<HTMLInputElement>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);

  const closeSearchAndRestoreFocus = () => {
    onCloseSearch();
    window.requestAnimationFrame(() => searchTrigger.current?.focus());
  };

  useEffect(() => {
    const handleFindShortcut = (event: KeyboardEvent) => {
      if (!document || !(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== 'f') return;
      event.preventDefault();
      onOpenSearch();
    };
    window.addEventListener('keydown', handleFindShortcut);
    return () => window.removeEventListener('keydown', handleFindShortcut);
  }, [document, onOpenSearch]);

  useEffect(() => {
    if (!search.open) return;
    searchInput.current?.focus();
    searchInput.current?.select();
  }, [search.open]);

  const handleSearchKeys = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeSearchAndRestoreFocus();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) onSearchPrevious();
      else onSearchNext();
    }
  };

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand" aria-label="MerMarkd">
        <span className="brand-mark" aria-hidden="true">M</span>
        <span className="brand-name">MerMarkd</span>
      </div>
      <div className="file-meta">
        <strong className="file-name" title={document?.path}>{document?.name ?? '未打开文档'}</strong>
        <span className="file-status">{document ? '只读 · 未修改' : '本地 Markdown 阅读器'}</span>
      </div>
      <div className={dropActive ? 'open-drop-target active' : 'open-drop-target'}
        data-markdown-drop-target="true"
        onDragEnter={onDropTargetEnter}
        onDragOver={onDropTargetOver}
        onDragLeave={onDropTargetLeave}
        onDrop={onDropTargetDrop}>
        <span className="drop-hint" aria-hidden="true">{dropActive ? '松开打开 .md' : '拖入 .md'}</span>
        <button className="open-button" type="button" onClick={onOpen} disabled={opening}>
          {opening ? '正在打开…' : '打开 Markdown'}
          <span className="shortcut" aria-hidden="true">Ctrl+O</span>
        </button>
      </div>
    </header>
    <div className="modebar-row">
      <ModeNavigation />
      <button ref={searchTrigger} type="button" className="search-open-button" onClick={onOpenSearch} disabled={!document}
        aria-expanded={search.open} aria-controls="reader-searchbar">
        查找正文 <span aria-hidden="true">Ctrl+F</span>
      </button>
    </div>
    {search.open && <div id="reader-searchbar" className="reader-searchbar" role="search"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.target === searchInput.current) return;
        event.preventDefault();
        event.stopPropagation();
        closeSearchAndRestoreFocus();
      }}>
      <label htmlFor="reader-search-input">查找可见正文</label>
      <input id="reader-search-input" ref={searchInput} type="search" value={search.query}
        onChange={(event) => onSearchQueryChange(event.target.value)} onKeyDown={handleSearchKeys}
        autoComplete="off" spellCheck={false} />
      <output aria-live="polite">{search.query
        ? search.total > 0
          ? `${search.currentIndex + 1} / ${search.total}${search.truncated ? '（仅显示前 1000 项）' : ''}`
          : '没有匹配'
        : '输入文字开始查找'}</output>
      <button type="button" onClick={onSearchPrevious} disabled={search.total === 0} aria-label="上一个匹配">↑</button>
      <button type="button" onClick={onSearchNext} disabled={search.total === 0} aria-label="下一个匹配">↓</button>
      <button type="button" onClick={closeSearchAndRestoreFocus} aria-label="关闭正文查找">×</button>
    </div>}
    {sourceChangeMessage && <div className="source-change-notice" role="alert">
      <span>{sourceChangeMessage}</span>
      <button type="button" onClick={onReloadSource} disabled={opening}>重新载入原文</button>
    </div>}
    {notice && <div className={`notice ${notice.kind}`} role={notice.kind}>
      <span>{notice.text}</span>
      <button type="button" onClick={onDismissNotice} aria-label="关闭提示">×</button>
    </div>}
    {children}
  </div>;
}
