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

export type AppMode = 'reader' | 'editor' | 'cards';

export interface AppShellProps {
  readonly document: OpenedMarkdownDocument | null;
  readonly activeMode?: AppMode;
  readonly dirty?: boolean;
  readonly fileStatus?: string;
  readonly opening: boolean;
  readonly dropActive: boolean;
  readonly notice: AppNotice | null;
  readonly sourceChangeMessage: string | null;
  readonly search: ReaderSearchState;
  readonly onOpen: () => void;
  readonly onDocumentRecovery?: () => void;
  readonly onModeChange?: (mode: AppMode) => void;
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

function ModeNavigation({
  activeMode,
  documentAvailable,
  onModeChange,
}: {
  readonly activeMode: AppMode;
  readonly documentAvailable: boolean;
  readonly onModeChange?: (mode: AppMode) => void;
}) {
  return <nav className="modebar" aria-label="视图模式">
    <button type="button" className={activeMode === 'reader' ? 'mode-tab current' : 'mode-tab'}
      aria-current={activeMode === 'reader' ? 'page' : undefined}
      data-mode="reader" disabled={!documentAvailable}
      onClick={() => onModeChange?.('reader')}>阅读模式</button>
    <button type="button" className={activeMode === 'editor' ? 'mode-tab current' : 'mode-tab'}
      aria-current={activeMode === 'editor' ? 'page' : undefined}
      data-mode="editor" disabled={!documentAvailable || !onModeChange}
      onClick={() => onModeChange?.('editor')}>
      编辑模式
    </button>
    <button type="button" className={activeMode === 'cards' ? 'mode-tab current' : 'mode-tab'} data-mode="cards"
      aria-current={activeMode === 'cards' ? 'page' : undefined} disabled={!documentAvailable || !onModeChange}
      onClick={() => onModeChange?.('cards')}>
      卡片模式
    </button>
  </nav>;
}

export function AppShell({
  document,
  activeMode = 'reader',
  dirty = false,
  fileStatus,
  opening,
  dropActive,
  notice,
  sourceChangeMessage,
  search,
  onOpen,
  onDocumentRecovery,
  onModeChange,
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
      if (activeMode !== 'reader' || !document || !(event.ctrlKey || event.metaKey) ||
          event.key.toLocaleLowerCase() !== 'f') return;
      event.preventDefault();
      onOpenSearch();
    };
    window.addEventListener('keydown', handleFindShortcut);
    return () => window.removeEventListener('keydown', handleFindShortcut);
  }, [activeMode, document, onOpenSearch]);

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

  const displayedFileStatus = fileStatus ?? (document
    ? activeMode === 'cards' ? dirty ? '结构预览 · 源码未保存' : '卡片画布 · 原文未修改' : activeMode === 'editor'
      ? dirty ? '源码编辑 · 未保存' : '源码编辑 · 已保存'
      : dirty ? '阅读预览 · 源码未保存' : '只读 · 未修改'
    : '本地 Markdown 阅读器');

  return <div className="app-shell" data-active-mode={activeMode} data-dirty={dirty ? 'true' : 'false'}>
    <header className="topbar">
      <div className="brand" aria-label="MerMarkd">
        <span className="brand-mark" aria-hidden="true">M</span>
        <span className="brand-name">MerMarkd</span>
      </div>
      <div className="file-meta">
        <strong className="file-name" title={document?.path}>{document?.name ?? '未打开文档'}</strong>
        <span className={dirty ? 'file-status dirty' : 'file-status'}>{displayedFileStatus}</span>
      </div>
      <div className={dropActive ? 'open-drop-target active' : 'open-drop-target'}
        data-markdown-drop-target="true"
        onDragEnter={onDropTargetEnter}
        onDragOver={onDropTargetOver}
        onDragLeave={onDropTargetLeave}
        onDrop={onDropTargetDrop}>
        <span className="drop-hint" aria-hidden="true">{dirty ? '请先处理未保存源码' : dropActive ? '松开打开 .md' : '拖入 .md'}</span>
        <button className="open-button" type="button" onClick={onOpen} disabled={opening || dirty}
          title={dirty ? '请先保存或放弃当前编辑' : undefined}>
          {opening ? '正在打开…' : '打开 Markdown'}
          <span className="shortcut" aria-hidden="true">Ctrl+O</span>
        </button>
      </div>
    </header>
    <div className="modebar-row">
      <ModeNavigation activeMode={activeMode} documentAvailable={Boolean(document)} onModeChange={onModeChange} />
      {onDocumentRecovery && <button type="button" className="search-open-button" data-open-document-recovery="true"
        onClick={onDocumentRecovery} disabled={opening}>检查保存恢复</button>}
      {activeMode === 'reader' && <button ref={searchTrigger} type="button" className="search-open-button"
        onClick={onOpenSearch} disabled={!document} aria-expanded={search.open} aria-controls="reader-searchbar">
        查找正文 <span aria-hidden="true">Ctrl+F</span>
      </button>}
    </div>
    {activeMode === 'reader' && search.open && <div id="reader-searchbar" className="reader-searchbar" role="search"
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
      <button type="button" onClick={onReloadSource} disabled={opening || dirty}>重新载入原文</button>
    </div>}
    {notice && <div className={`notice ${notice.kind}`} role={notice.kind}>
      <span>{notice.text}</span>
      <button type="button" onClick={onDismissNotice} aria-label="关闭提示">×</button>
    </div>}
    {children}
  </div>;
}
