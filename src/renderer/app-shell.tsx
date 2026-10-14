import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { FilePlus2, FolderOpen, Maximize2, Minimize2, MoreHorizontal, PanelLeft, PanelRight, RotateCcw, Save, Search, X } from 'lucide-react';
import type { OpenedMarkdownDocument } from '../types/reader-api';
import { summarizeWorkspaceStatus, type WorkspaceStatuses } from './workspace-status';
import { WorkspacePopover } from './workspace-popover';
import { WorkspaceTaskHost, type WorkspacePanels } from './workspace-panels';

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
  readonly saving?: boolean;
  readonly canSave?: boolean;
  readonly fileStatus?: string;
  readonly opening: boolean;
  readonly dropActive: boolean;
  readonly notice: AppNotice | null;
  readonly sourceChangeMessage: string | null;
  readonly recentDocuments?: readonly RecentDocumentItem[];
  readonly panels: WorkspacePanels;
  readonly outline?: ReactNode;
  readonly taskLabel: string;
  readonly taskAvailable: boolean;
  readonly onNewDocument?: () => void;
  readonly onOpenRecent?: (path: string) => void;
  readonly onRemoveRecent?: (path: string) => void;
  readonly onSave?: () => void;
  readonly onSaveAs?: () => void;
  readonly onDiscardChanges?: () => void;
  readonly workspaceStatuses?: WorkspaceStatuses;
  readonly annotationDetails?: ReactNode;
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
      onClick={() => onModeChange?.('reader')}>阅读</button>
    <button type="button" className={activeMode === 'editor' ? 'mode-tab current' : 'mode-tab'}
      aria-current={activeMode === 'editor' ? 'page' : undefined}
      data-mode="editor" disabled={!documentAvailable || !onModeChange}
      onClick={() => onModeChange?.('editor')}>
      源码
    </button>
    <button type="button" className={activeMode === 'cards' ? 'mode-tab current' : 'mode-tab'} data-mode="cards"
      aria-current={activeMode === 'cards' ? 'page' : undefined} disabled={!documentAvailable || !onModeChange}
      onClick={() => onModeChange?.('cards')}>
      卡片
    </button>
  </nav>;
}

export function AppShell({
  document,
  activeMode = 'reader',
  dirty = false,
  saving = false,
  canSave = true,
  fileStatus,
  opening,
  dropActive,
  notice,
  sourceChangeMessage,
  recentDocuments = [],
  panels,
  outline,
  taskLabel,
  taskAvailable,
  onNewDocument,
  onOpenRecent,
  onRemoveRecent,
  onSave,
  onSaveAs,
  onDiscardChanges,
  workspaceStatuses,
  annotationDetails,
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
  const leftSidebarTrigger = useRef<HTMLButtonElement>(null);
  const rightSidebarTrigger = useRef<HTMLButtonElement>(null);
  const leftSidebar = useRef<HTMLElement>(null);
  const rightSidebarElement = useRef<HTMLElement>(null);
  const focusReturn = useRef<HTMLElement | null>(null);
  const chrome = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const [taskHost, setTaskHost] = useState<HTMLDivElement | null>(null);
  const [leftTab, setLeftTab] = useState<'outline' | 'recent'>('outline');
  const leftSidebarOpen = Boolean(document) && panels.leftVisible;
  const rightSidebarOpen = Boolean(document) && panels.rightVisible;
  const focusMode = panels.focused;
  const modalSide = panels.narrow ? leftSidebarOpen ? 'left' : rightSidebarOpen ? 'right' : null : null;
  const showTask = taskAvailable && panels.right === 'task';
  const onToggleLeftSidebar = panels.toggleLeft;
  const onToggleRightSidebar = () => panels.toggleRight(taskAvailable ? 'task' : 'info');
  const onToggleFocusMode = useCallback(() => {
    const active = window.document.activeElement;
    if (!focusMode && active instanceof HTMLElement &&
        (leftSidebar.current?.contains(active) || rightSidebarElement.current?.contains(active))) {
      focusReturn.current = active;
    }
    panels.toggleFocus();
  }, [focusMode, panels.toggleFocus]);

  useEffect(() => {
    const target = focusMode ? window.document.querySelector<HTMLElement>(
      activeMode === 'editor' ? '[data-editor-textarea]' : activeMode === 'cards' ? '[data-canvas-flow]' : '.markdown-body',
    ) : focusReturn.current;
    if (!focusMode) focusReturn.current = null;
    const frame = window.requestAnimationFrame(() => {
      if (!target?.isConnected || !target.getClientRects().length) return;
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeMode, focusMode]);

  useEffect(() => {
    if (!chrome.current) return;
    const update = () => shell.current?.style.setProperty('--workspace-chrome-height',
      (chrome.current?.getBoundingClientRect().height ?? 64) + 'px');
    const observer = new ResizeObserver(update);
    observer.observe(chrome.current);
    update();
    return () => observer.disconnect();
  }, []);
  const [discardConfirmation, setDiscardConfirmation] = useState(false);

  const closeWorkspaceSidebar = (side: 'left' | 'right') => {
    panels.close(side);
    window.requestAnimationFrame(() => {
      (side === 'left' ? leftSidebarTrigger : rightSidebarTrigger).current?.focus({ preventScroll: true });
    });
  };

  const closeSearchAndRestoreFocus = () => {
    onCloseSearch();
    window.requestAnimationFrame(() => searchTrigger.current?.focus());
  };

  useEffect(() => {
    const handleFocusShortcut = (event: KeyboardEvent) => {
      if (!document || event.isComposing || !(event.ctrlKey || event.metaKey) || !event.shiftKey ||
          event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      onToggleFocusMode();
    };
    window.addEventListener('keydown', handleFocusShortcut);
    return () => window.removeEventListener('keydown', handleFocusShortcut);
  }, [document, onToggleFocusMode]);

  useEffect(() => {
    const handleFindShortcut = (event: KeyboardEvent) => {
      if (activeMode !== 'reader' || !document || event.shiftKey || !(event.ctrlKey || event.metaKey) ||
          event.key.toLocaleLowerCase() !== 'f') return;
      event.preventDefault();
      onOpenSearch();
    };
    window.addEventListener('keydown', handleFindShortcut);
    return () => window.removeEventListener('keydown', handleFindShortcut);
  }, [activeMode, document, onOpenSearch]);

  useEffect(() => {
    if (!dirty) setDiscardConfirmation(false);
  }, [dirty]);

  useEffect(() => {
    const handleSaveShortcut = (event: KeyboardEvent) => {
      if (!document || !(event.ctrlKey || event.metaKey) ||
          event.key.toLocaleLowerCase() !== 's') return;
      event.preventDefault();
      if (saving || event.isComposing) return;
      if (event.shiftKey) onSaveAs?.();
      else if (canSave && (dirty || document.temporary)) onSave?.();
    };
    window.addEventListener('keydown', handleSaveShortcut);
    return () => window.removeEventListener('keydown', handleSaveShortcut);
  }, [canSave, dirty, document, onSave, onSaveAs, saving]);

  useEffect(() => {
    if (!search.open) return;
    searchInput.current?.focus();
    searchInput.current?.select();
  }, [search.open]);

  useEffect(() => {
    const side = modalSide;
    const panel = side === 'left' ? leftSidebar.current : rightSidebarElement.current;
    if (!side || !panel) return;
    const previousOverflow = window.document.body.style.overflow;
    window.document.body.style.overflow = 'hidden';
    const focusPanel = window.requestAnimationFrame(() => {
      if (!panel.contains(window.document.activeElement)) {
        (panel.querySelector<HTMLElement>('[data-panel-autofocus]:not(:disabled)') ??
          panel.querySelector<HTMLElement>('.workspace-close-button'))?.focus({ preventScroll: true });
      }
    });
    const handleKeys = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeWorkspaceSidebar(side);
      } else if (event.key === 'Tab') {
        const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])',
        )).filter((element) => element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable.at(-1);
        const active = window.document.activeElement;
        if (!first || !last) { event.preventDefault(); panel.focus(); }
        else if (event.shiftKey && (active === first || !panel.contains(active))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (active === last || !panel.contains(active))) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', handleKeys);
    return () => {
      window.cancelAnimationFrame(focusPanel);
      window.removeEventListener('keydown', handleKeys);
      window.document.body.style.overflow = previousOverflow;
    };
  }, [modalSide, panels.close]);

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

  const summary = workspaceStatuses ? summarizeWorkspaceStatus(workspaceStatuses) : null;
  const documentStatus = fileStatus ?? summary?.text ?? (document?.temporary ? '待首次保存' : dirty ? '未保存' : '已保存');

  return <WorkspaceTaskHost.Provider value={taskHost}><div ref={shell} className="app-shell" data-active-mode={activeMode} data-dirty={dirty ? 'true' : 'false'}
    data-document-open={document ? 'true' : 'false'} data-focus-mode={focusMode ? 'true' : 'false'}>
    <div ref={chrome} className="workspace-chrome" inert={Boolean(modalSide)}><header className="topbar">
      {!document ? <div className="brand" aria-label="MerMarkd">
        <span className="brand-mark" aria-hidden="true">M</span>
        <span className="brand-name">MerMarkd</span>
      </div> : <button ref={leftSidebarTrigger} type="button" className="workspace-icon-button" onClick={onToggleLeftSidebar}
        aria-label={leftSidebarOpen ? '收起左侧栏' : '展开左侧栏'} aria-expanded={leftSidebarOpen} title={leftSidebarOpen ? '收起左侧栏' : '展开左侧栏'}>
        <PanelLeft size={17} aria-hidden="true" />
      </button>}
      {document ? <ModeNavigation activeMode={activeMode} documentAvailable={true} onModeChange={onModeChange} /> : <div className="file-meta">
        <strong className="file-name">开始页</strong>
        <span className="file-status">打开、创建或继续最近的 Markdown</span>
      </div>}
      {document ? <div className="workspace-topbar-actions">
        <span className="file-name workspace-current-name" title={document.temporary ? '尚未保存到磁盘' : document.path}>{document.name}</span>
        <WorkspacePopover key={`status-${document.path}`} label="文档状态" className={`workspace-document-status ${summary?.tone ?? 'neutral'}`}
          trigger={<span data-workspace-summary="true">{documentStatus}</span>}>
          {workspaceStatuses && <div className="workspace-status-details" aria-label="文档各部分状态">
            <span data-workspace-status="source" data-tone={workspaceStatuses.source.tone}>正文：{workspaceStatuses.source.text}</span>
            <span data-workspace-status="annotations" data-tone={workspaceStatuses.annotations.tone}>批注：{workspaceStatuses.annotations.text}</span>
            <span data-workspace-status="canvas" data-tone={workspaceStatuses.canvas.tone}>画布：{workspaceStatuses.canvas.text}</span>
          </div>}
          {annotationDetails}
        </WorkspacePopover>
        {activeMode === 'reader' && <button ref={searchTrigger} type="button" className="workspace-icon-button"
          onClick={onOpenSearch} aria-label="查找正文" title="查找正文（Ctrl+F）" aria-expanded={search.open} aria-controls="reader-searchbar">
          <Search size={17} aria-hidden="true" />
        </button>}
        {onSave && <div className="workspace-save-actions" role="group" aria-label="文档保存操作">
          <button type="button" className="workspace-save-button" data-workspace-save="true" aria-label="保存正文" aria-keyshortcuts="Control+S" onClick={onSave} disabled={!canSave || (!dirty && !document.temporary) || saving}
            title="保存 Markdown（Ctrl+S）">
            <Save size={15} aria-hidden="true" /><span>{saving ? '保存中…' : '保存'}</span>
          </button>
        </div>}
        <WorkspacePopover key={`menu-${document.path}`} label="文档菜单" trigger={<MoreHorizontal size={18} aria-hidden="true" />}>
          <button type="button" onClick={onOpen} disabled={opening || dirty}><FolderOpen size={15} aria-hidden="true" />打开文档 <kbd>Ctrl+O</kbd></button>
          {onSaveAs && <button type="button" data-workspace-save-as="true" aria-keyshortcuts="Control+Shift+S" onClick={onSaveAs} disabled={saving}>选择保存位置…</button>}
          {onDiscardChanges && !discardConfirmation && <button type="button" data-workspace-discard="true"
            onClick={() => setDiscardConfirmation(true)} disabled={!dirty || saving} title="放弃未保存的 Markdown 修改">
            <RotateCcw size={14} aria-hidden="true" />放弃未保存修改
          </button>}
          {onDiscardChanges && discardConfirmation && <span className="workspace-discard-confirm" role="group" aria-label="确认放弃未保存修改">
            <span>放弃修改？</span>
            <button type="button" className="workspace-discard-confirm-button" onClick={() => { setDiscardConfirmation(false); onDiscardChanges(); }} disabled={saving}>确定</button>
            <button type="button" className="workspace-discard-cancel-button" onClick={() => setDiscardConfirmation(false)} disabled={saving}>取消</button>
          </span>}
          <button type="button" onClick={() => panels.openRight('info')}>文档信息</button>
          {onDocumentRecovery && <button type="button" data-open-document-recovery="true" onClick={onDocumentRecovery} disabled={opening}>检查保存恢复</button>}
        <button type="button" className="workspace-icon-button" onClick={onToggleFocusMode}
          aria-label={focusMode ? '退出专注模式' : '进入专注模式'} aria-pressed={focusMode} aria-keyshortcuts="Control+Shift+F"
          title="切换专注模式（Ctrl+Shift+F）">
          {focusMode ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
          {focusMode ? '退出专注模式' : '进入专注模式'}
          <kbd>Ctrl+Shift+F</kbd>
        </button>
        </WorkspacePopover>
        <button ref={rightSidebarTrigger} type="button" className={`workspace-icon-button workspace-task-trigger ${activeMode === 'reader' ? 'annotation-panel-toggle' : ''}`} data-workspace-right-toggle="true" onClick={onToggleRightSidebar}
          aria-label={taskAvailable ? taskLabel : '文档信息'} aria-controls="workspace-right-panel" aria-expanded={rightSidebarOpen} title={taskAvailable ? taskLabel : '文档信息'}>
          <PanelRight size={17} aria-hidden="true" /><span>{taskAvailable ? taskLabel : '信息'}</span>
        </button>
        <div className={dropActive ? 'open-drop-target active compact' : 'open-drop-target compact'}
          data-markdown-drop-target="true"
          onDragEnter={onDropTargetEnter}
          onDragOver={onDropTargetOver}
          onDragLeave={onDropTargetLeave}
          onDrop={onDropTargetDrop}>
          <button type="button" className="workspace-icon-button" aria-label="打开文档" title="打开文档（Ctrl+O）" onClick={onOpen} disabled={opening || dirty}>
            <FolderOpen size={17} aria-hidden="true" />
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
    {!document && onDocumentRecovery && <button type="button" className="start-recovery" data-open-document-recovery="true"
      onClick={onDocumentRecovery} disabled={opening}>检查保存恢复</button>}
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
    </div>
    <div className="workspace-frame" data-left-open={leftSidebarOpen} data-right-open={rightSidebarOpen}>
    {modalSide && <button type="button" className="workspace-sidebar-backdrop" aria-label="关闭侧栏" tabIndex={-1}
      onClick={() => closeWorkspaceSidebar(modalSide)} />}
    <aside ref={leftSidebar} id="workspace-left-panel" hidden={!leftSidebarOpen}
      className="workspace-sidebar workspace-sidebar-left" role={modalSide === 'left' ? 'dialog' : undefined}
      aria-modal={modalSide === 'left' ? true : undefined} aria-label="文档导航" tabIndex={-1}>
      <div className="workspace-sidebar-header"><h2>文档导航</h2>
        <button type="button" className="workspace-close-button" onClick={() => closeWorkspaceSidebar('left')} aria-label="收起左侧栏"><X size={15} /></button></div>
      <div className="workspace-panel-tabs" role="group" aria-label="导航内容">
        <button type="button" aria-pressed={leftTab === 'outline'} onClick={() => setLeftTab('outline')}>目录</button>
        <button type="button" aria-pressed={leftTab === 'recent'} onClick={() => setLeftTab('recent')}>最近文件</button>
      </div>
      <div className="workspace-panel-scroll" hidden={leftTab !== 'outline'}>{outline}</div>
      <section className="workspace-panel-scroll workspace-sidebar-section" hidden={leftTab !== 'recent'} aria-label="最近文件">
        {recentDocuments.length === 0 ? <p className="workspace-sidebar-empty">还没有最近文档。</p> : <ul className="recent-document-list">
          {recentDocuments.map((item) => <li key={item.path} className={item.path === document?.path ? 'current' : undefined}>
            <button type="button" onClick={() => onOpenRecent?.(item.path)} disabled={item.path === document?.path || dirty} title={item.path}>
              <strong>{item.name}</strong><span>{item.path}</span></button>
            <button type="button" className="recent-remove" onClick={() => onRemoveRecent?.(item.path)} aria-label={'从最近文档移除 ' + item.name}><X size={13} /></button>
          </li>)}
        </ul>}
      </section>
    </aside>
    <div className="workspace-content" inert={Boolean(modalSide)}>{children}</div>
    <aside ref={rightSidebarElement} id="workspace-right-panel" hidden={!rightSidebarOpen}
      className="workspace-sidebar workspace-sidebar-right" role={modalSide === 'right' ? 'dialog' : undefined}
      aria-modal={modalSide === 'right' ? true : undefined} aria-label={showTask ? taskLabel : '文档信息'} tabIndex={-1}>
      <div className="workspace-sidebar-header"><h2>{showTask ? taskLabel : '文档信息'}</h2>
        <button type="button" className="workspace-close-button annotation-close" onClick={() => closeWorkspaceSidebar('right')}
          aria-label={showTask && activeMode === 'reader' ? '关闭批注栏' : '收起右侧栏'}><X size={15} /></button></div>
      {taskAvailable && <div className="workspace-panel-tabs" role="group" aria-label="面板内容">
        <button type="button" aria-pressed={showTask} onClick={() => panels.openRight('task')}>{taskLabel}</button>
        <button type="button" aria-pressed={!showTask} onClick={() => panels.openRight('info')}>文档信息</button>
      </div>}
      <div ref={setTaskHost} className="workspace-panel-scroll workspace-task-content" hidden={!showTask} />
      <div className="workspace-panel-scroll" hidden={showTask}>
        {rightSidebar ?? (document && <div className="workspace-sidebar-section"><dl className="document-info-list">
          <div><dt>文件名</dt><dd>{document.name}</dd></div>
          <div><dt>路径</dt><dd title={document.temporary ? undefined : document.path}>{document.temporary ? '尚未保存到磁盘' : document.path}</dd></div>
          <div><dt>编码</dt><dd>UTF-8{document.bomByteLength ? ' · BOM' : ''}</dd></div>
          <div><dt>状态</dt><dd>{documentStatus}</dd></div>
        </dl></div>)}
      </div>
    </aside>
    </div>
  </div></WorkspaceTaskHost.Provider>;
}
