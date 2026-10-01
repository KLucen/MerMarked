import { useEffect, useRef } from 'react';
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { FilePlus2, FolderOpen, Maximize2, Minimize2, PanelLeft, PanelRight, X } from 'lucide-react';
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

export interface RecentDocumentItem {
  readonly path: string;
  readonly name: string;
  readonly openedAt: number;
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
  readonly recentDocuments?: readonly RecentDocumentItem[];
  readonly leftSidebarOpen?: boolean;
  readonly rightSidebarOpen?: boolean;
  readonly focusMode?: boolean;
  readonly onNewDocument?: () => void;
  readonly onOpenRecent?: (path: string) => void;
  readonly onRemoveRecent?: (path: string) => void;
  readonly onToggleLeftSidebar?: () => void;
  readonly onToggleRightSidebar?: () => void;
  readonly onToggleFocusMode?: () => void;
  readonly rightSidebar?: ReactNode;
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
  recentDocuments = [],
  leftSidebarOpen = false,
  rightSidebarOpen = false,
  focusMode = false,
  onNewDocument,
  onOpenRecent,
  onRemoveRecent,
  onToggleLeftSidebar,
  onToggleRightSidebar,
  onToggleFocusMode,
  rightSidebar,
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
    ? document.temporary ? '新建 · 首次保存待处理'
      : activeMode === 'cards' ? dirty ? '结构预览 · 源码未保存' : '卡片画布 · 原文未修改' : activeMode === 'editor'
        ? dirty ? '源码编辑 · 未保存' : '源码编辑 · 已保存'
        : dirty ? '阅读预览 · 源码未保存' : '只读 · 未修改'
    : '本地 Markdown 阅读器');

  const documentStatus = dirty ? '未保存' : displayedFileStatus;

  return <div className="app-shell" data-active-mode={activeMode} data-dirty={dirty ? 'true' : 'false'}
    data-document-open={document ? 'true' : 'false'} data-focus-mode={focusMode ? 'true' : 'false'}>
    <header className="topbar">
      {!document ? <div className="brand" aria-label="MerMarkd">
        <span className="brand-mark" aria-hidden="true">M</span>
        <span className="brand-name">MerMarkd</span>
      </div> : <button type="button" className="workspace-icon-button" onClick={onToggleLeftSidebar}
        aria-label={leftSidebarOpen ? '收起左侧栏' : '展开左侧栏'} aria-expanded={leftSidebarOpen} title={leftSidebarOpen ? '收起左侧栏' : '展开左侧栏'}>
        <PanelLeft size={17} aria-hidden="true" />
      </button>}
      {document ? <ModeNavigation activeMode={activeMode} documentAvailable={true} onModeChange={onModeChange} /> : <div className="file-meta">
        <strong className="file-name">开始页</strong>
        <span className="file-status">打开、创建或继续最近的 Markdown</span>
      </div>}
      {document ? <div className="workspace-topbar-actions">
        <span className="file-name workspace-current-name" title={document.temporary ? '尚未保存到磁盘' : document.path}>{document.name}</span>
        <span className={dirty ? 'file-status dirty' : 'file-status'} title={document.temporary ? '尚未保存到磁盘' : document.path}>{documentStatus}</span>
        <button type="button" className="workspace-icon-button" onClick={onToggleFocusMode}
          aria-label={focusMode ? '退出专注模式' : '进入专注模式'} aria-pressed={focusMode}
          title={focusMode ? '退出专注模式' : '进入专注模式'}>
          {focusMode ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
        </button>
        <button type="button" className="workspace-icon-button" onClick={onToggleRightSidebar}
          aria-label={rightSidebarOpen ? '收起右侧栏' : '展开右侧栏'} aria-expanded={rightSidebarOpen} title={rightSidebarOpen ? '收起右侧栏' : '展开右侧栏'}>
          <PanelRight size={17} aria-hidden="true" />
        </button>
        <div className={dropActive ? 'open-drop-target active compact' : 'open-drop-target compact'}
          data-markdown-drop-target="true"
          onDragEnter={onDropTargetEnter}
          onDragOver={onDropTargetOver}
          onDragLeave={onDropTargetLeave}
          onDrop={onDropTargetDrop}>
          <button className="open-button" type="button" onClick={onOpen} disabled={opening || dirty}
            title={dirty ? '请先保存或放弃当前编辑' : '打开另一份 Markdown'}>
            <FolderOpen size={15} aria-hidden="true" />
            <span>{opening ? '正在打开…' : '打开'}</span>
          </button>
        </div>
      </div> : <div className={dropActive ? 'open-drop-target active' : 'open-drop-target'}
        data-markdown-drop-target="true"
        onDragEnter={onDropTargetEnter}
        onDragOver={onDropTargetOver}
        onDragLeave={onDropTargetLeave}
        onDrop={onDropTargetDrop}>
        <span className="drop-hint" aria-hidden="true">{dropActive ? '松开打开 .md' : '拖入 .md'}</span>
        <button className="open-button" type="button" onClick={onOpen} disabled={opening}
          title="打开 Markdown">
          <FolderOpen size={15} aria-hidden="true" />
          <span>{opening ? '正在打开…' : '打开 Markdown'}</span>
          <span className="shortcut" aria-hidden="true">Ctrl+O</span>
        </button>
      </div>}
    </header>
    {!document && <div className="startbar" aria-label="开始页操作"><span>本地优先的 Markdown 工作区</span>
      {onNewDocument && <button type="button" className="startbar-new" onClick={onNewDocument} disabled={opening}><FilePlus2 size={14} aria-hidden="true" />新建 Markdown</button>}
    </div>}
    {!focusMode && (onDocumentRecovery || document) && <div className="workspace-utilitybar">
      {onDocumentRecovery && <button type="button" className="search-open-button" data-open-document-recovery="true"
        onClick={onDocumentRecovery} disabled={opening}>检查保存恢复</button>}
      {activeMode === 'reader' && <button ref={searchTrigger} type="button" className="search-open-button"
        onClick={onOpenSearch} disabled={!document} aria-expanded={search.open} aria-controls="reader-searchbar">
        查找正文 <span aria-hidden="true">Ctrl+F</span>
      </button>}
    </div>}
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
    {document && !focusMode && leftSidebarOpen && <aside className="workspace-sidebar workspace-sidebar-left" aria-label="文档导航">
      <div className="workspace-sidebar-header"><div><span className="workspace-sidebar-kicker">WORKSPACE</span><h2>文档导航</h2></div>
        <button type="button" className="workspace-close-button" onClick={onToggleLeftSidebar} aria-label="收起左侧栏"><X size={15} /></button></div>
      <section className="workspace-sidebar-section"><h3>最近打开</h3>
        {recentDocuments.length === 0 ? <p className="workspace-sidebar-empty">还没有最近文档。</p> : <ul className="recent-document-list">
          {recentDocuments.map((item) => <li key={item.path} className={item.path === document.path ? 'current' : undefined}>
            <button type="button" onClick={() => onOpenRecent?.(item.path)} disabled={item.path === document.path || dirty} title={item.path}>
              <strong>{item.name}</strong><span>{item.path}</span></button>
            <button type="button" className="recent-remove" onClick={() => onRemoveRecent?.(item.path)} aria-label={`从最近文档移除 ${item.name}`}><X size={13} /></button>
          </li>)}
        </ul>}
      </section>
      <section className="workspace-sidebar-section workspace-sidebar-hint"><h3>当前工作区</h3><p>切换视图不会写入 Markdown。关闭侧栏可获得更宽的正文空间。</p></section>
    </aside>}
    {document && !focusMode && rightSidebarOpen && <aside className="workspace-sidebar workspace-sidebar-right" aria-label="文档信息">
      <div className="workspace-sidebar-header"><div><span className="workspace-sidebar-kicker">DOCUMENT</span><h2>文档信息</h2></div>
        <button type="button" className="workspace-close-button" onClick={onToggleRightSidebar} aria-label="收起右侧栏"><X size={15} /></button></div>
      {rightSidebar ?? <div className="workspace-sidebar-section"><dl className="document-info-list"><div><dt>文件名</dt><dd>{document.name}</dd></div><div><dt>路径</dt><dd title={document.temporary ? undefined : document.path}>{document.temporary ? '尚未保存到磁盘' : document.path}</dd></div><div><dt>编码</dt><dd>UTF-8{document.bomByteLength ? ' · BOM' : ''}</dd></div><div><dt>状态</dt><dd className={dirty || document.temporary ? 'dirty' : undefined}>{document.temporary ? '新建 · 待首次保存' : documentStatus}</dd></div></dl></div>}
    </aside>}
    <div className="workspace-content">{children}</div>
  </div>;
}
