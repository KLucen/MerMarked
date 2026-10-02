import { StrictMode, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps, DragEvent as ReactDragEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import type { Components, ExtraProps } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import { Clock3, FilePlus2, FolderOpen, X } from 'lucide-react';
import {
  detectUnsupportedMarkdownExtensions,
  readingSanitizeSchema,
  rehypeReadingHtmlPolicy,
  remarkReadingDangerousHtmlPolicy,
} from '../core/markdown-reading';
import { markdownToEditorText } from '../core/editor-text';
import { activeSectionAtMarker, countGraphemes } from '../core/reader-navigation';
import { extractSections, sectionFragmentIds } from '../core/sections';
import { buildSelectionMap, resolveSelection, resolveStoredHighlight } from '../core/selection-map';
import {
  applyReaderMappedTextEdit,
  isReaderMappedTextBlock,
  resolveReaderInlineFormatSelection,
} from '../core/reader-edit';
import { applyMarkdownSelectionCommand } from '../core/markdown-selection-commands';
import type { MarkdownSourceSelectionAction } from '../core/markdown-selection-commands';
import type { AnnotationColor } from '../core/annotations';
import type {
  AnnotationDocumentView,
  AnnotationSaveResult,
  AnnotationSelectionInput,
  NoteTagInput,
  OpenedMarkdownDocument,
  SectionStructurePreview,
  DocumentRecoveryItem, DocumentRecoveryPreview,
  RecentMarkdownDocument,
} from '../types/reader-api';
import type { SectionTransformOperation } from '../core/section-transform';
import { AppShell } from './app-shell';
import type { AppMode, AppNotice, NoticeKind, RecentDocumentItem } from './app-shell';
import { EditorView } from './editor-view';
import { ReaderView } from './reader-view';
import { ReaderEditableBlock } from './reader-editable-block';
import { CanvasView } from './canvas-view';
import { DocumentRecoveryView } from './document-recovery-view';
import { collectVisibleSearchMatches } from './reader-search';
import type { VisibleSearchMatch } from './reader-search';
import { useMarkdownEditor } from './use-markdown-editor';
import './style.css';

type SelectionProbeResult = ReturnType<typeof resolveSelection>;
type SuccessfulSelectionProbe = Extract<SelectionProbeResult, { ok: true }>;

interface ReaderContextMenuState {
  readonly left: number;
  readonly top: number;
  readonly probe: SuccessfulSelectionProbe;
  readonly epoch: number;
  readonly sourceSha256: string;
}

interface ValidatedSelectionTarget {
  readonly epoch: number;
  readonly sourceSha256: string;
  readonly probe: SuccessfulSelectionProbe;
  readonly range: Range;
  readonly origin: HTMLElement;
}

interface SelectionToolbarPosition {
  readonly top: number;
  readonly placement: 'above' | 'below';
}

interface ClearSelectionOptions {
  readonly clearNative?: boolean;
  readonly restoreFocus?: boolean;
}

const HIGHLIGHT_COLORS: ReadonlyArray<{ value: AnnotationColor; name: string }> = [
  { value: 'amber', name: '琥珀' },
  { value: 'sage', name: '鼠尾草' },
  { value: 'blue', name: '浅蓝' },
  { value: 'rose', name: '浅玫瑰' },
];
const ANNOTATION_MARK_NAMES = [
  ...HIGHLIGHT_COLORS.flatMap(({ value }) => [
  `mermarkd-${value}`, `mermarkd-selected-${value}`,
  ]),
  'mermarkd-note',
  'mermarkd-selected-note',
];
const ACTIVE_SELECTION_MARK_NAME = 'mermarkd-active-selection';
const SEARCH_MARK_NAME = 'mermarkd-search-match';
const CURRENT_SEARCH_MARK_NAME = 'mermarkd-current-search-match';
const READING_POSITION_TOP = 148;

const NO_TAG = '__none__';
const NEW_TAG = '__new__';
const TAG_VALUE_PREFIX = 'tag:';
const UNSUPPORTED_EXTENSION_NAMES = {
  'display-math': '数学公式',
  'wiki-link': 'Wiki Link',
  directive: '自定义指令',
} as const;

interface NoteComposer {
  selection: AnnotationSelectionInput;
  quote: string;
}

function noteTagInput(choice: string, newName: string): NoteTagInput {
  if (choice === NEW_TAG) return { mode: 'new', name: newName };
  if (choice === NO_TAG) return { mode: 'none' };
  return { mode: 'existing', id: choice.slice(TAG_VALUE_PREFIX.length) };
}

function relocationLabel(state: AnnotationDocumentView['items'][number]['relocation']): string {
  if (state === 'available') return '可安全重定位';
  if (state === 'source-missing') return '原选文已删除或改写';
  if (state === 'source-repeated') return '当前有多处相同选文';
  if (state === 'context-mismatch') return '上下文无法确认';
  if (state === 'rendered-range-unresolved') return '当前阅读视图无法精确映射';
  if (state === 'target-range-collision') return '新位置与其他批注冲突';
  return '当前位置无法核验';
}

function selectionReasonForReader(reason: string): string {
  if (reason.startsWith('请先') || reason.startsWith('目前只支持')) return reason;
  if (reason.includes('组合字符')) return '请完整选择一个字符后重试。';
  if (reason.includes('软换行')) return '目前不支持跨行选取，请在同一行内选择。';
  if (reason.includes('范围无效') || reason.includes('无法读取')) return '无法读取这次选择，请重新选择文字。';
  return '这段文字包含复杂格式，目前不能安全添加批注。请缩小选区后重试。';
}

function highlightRegistry(): MapLikeHighlightRegistry | null {
  if (typeof CSS === 'undefined' || typeof Highlight === 'undefined') return null;
  const css = CSS as typeof CSS & { highlights?: MapLikeHighlightRegistry };
  return typeof Highlight === 'function' && css.highlights ? css.highlights : null;
}

interface MapLikeHighlightRegistry {
  set(name: string, highlight: Highlight): void;
  delete(name: string): boolean;
}

function textRange(block: HTMLElement, start: number, end: number, expected: string): Range | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current instanceof Text) nodes.push(current);
  }
  let cursor = 0;
  let startPoint: { node: Text; offset: number } | null = null;
  let endPoint: { node: Text; offset: number } | null = null;
  for (const node of nodes) {
    const next = cursor + node.length;
    if (!startPoint && cursor <= start && start < next) startPoint = { node, offset: start - cursor };
    if (!endPoint && cursor < end && end <= next) endPoint = { node, offset: end - cursor };
    cursor = next;
  }
  if (!startPoint || !endPoint) return null;
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range.toString() === expected ? range : null;
}

function sourceBlockFor(node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>('[data-source-block-start]') ?? null;
}

function isExternalUrl(value: string): boolean {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isRelativeImage(value: string): boolean {
  return Boolean(value) && !value.startsWith('/') && !value.startsWith('\\') &&
    !value.includes('\\') && !/^[a-z][a-z\d+.-]*:/i.test(value);
}

function hasDraggedFiles(event: ReactDragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

function LocalImage({ src, alt, documentPath }: {
  readonly src?: string;
  readonly alt?: string;
  readonly documentPath: string;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    setImageUrl(null);
    setLoaded(false);
    if (!src || !isRelativeImage(src)) {
      setLoaded(true);
      return () => { active = false; };
    }
    void window.mermarkd.readDocumentImage(src)
      .then((result) => {
        if (active) {
          setImageUrl(result);
          setLoaded(true);
        }
      })
      .catch(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [src, documentPath]);

  return imageUrl
    ? <img className="article-image" src={imageUrl} alt={alt ?? ''} />
    : <span className="image-placeholder" role="img" aria-label={alt || '图片'}>
        <span aria-hidden="true">▧</span>
        {alt || '图片'} · {loaded ? '无法读取本地图片或不支持该地址' : '正在加载图片'}
      </span>;
}

function relativeRecentLabel(openedAt: number): string {
  const elapsed = Math.max(0, Date.now() - openedAt);
  if (elapsed < 60_000) return '刚刚打开';
  if (elapsed < 3_600_000) return `${Math.max(1, Math.floor(elapsed / 60_000))} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.max(1, Math.floor(elapsed / 3_600_000))} 小时前`;
  return new Date(openedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function StartPage({
  opening,
  recentDocuments,
  onOpen,
  onNew,
  onOpenRecent,
  onRemoveRecent,
}: {
  readonly opening: boolean;
  readonly recentDocuments: readonly RecentDocumentItem[];
  readonly onOpen: () => void;
  readonly onNew: () => void;
  readonly onOpenRecent: (path: string) => void;
  readonly onRemoveRecent: (path: string) => void;
}) {
  return <main className="start-page">
    <section className="start-hero" aria-labelledby="start-page-title">
      <span className="start-eyebrow">MER MARKD WORKSPACE</span>
      <h1 id="start-page-title">从一份 Markdown 开始</h1>
      <p>在同一个安静的工作区里阅读、编辑和整理章节结构。</p>
      <div className="start-actions">
        <button className="welcome-open" type="button" data-start-open="true" onClick={onOpen} disabled={opening}>
          <FolderOpen size={16} aria-hidden="true" />{opening ? '正在打开…' : '打开 Markdown'}
        </button>
        <button className="start-secondary-action" type="button" data-start-new="true" onClick={onNew} disabled={opening}>
          <FilePlus2 size={16} aria-hidden="true" />新建文档
        </button>
      </div>
      <span className="welcome-note">文件保存在本地；模式切换和阅读批注不会改写 Markdown。</span>
    </section>
    <section className="start-recent" aria-labelledby="recent-documents-title">
      <div className="start-section-heading"><div><span className="start-section-kicker"><Clock3 size={13} aria-hidden="true" />RECENT</span><h2 id="recent-documents-title">最近打开</h2></div>
        <span>{recentDocuments.length ? `${recentDocuments.length} 份` : '空'}</span></div>
      {recentDocuments.length === 0 ? <p className="start-recent-empty">打开过的 Markdown 会出现在这里。</p> : <ul className="start-recent-list">
        {recentDocuments.map((item) => <li key={item.path}>
          <button type="button" onClick={() => onOpenRecent(item.path)} disabled={opening} title={item.path}>
            <strong>{item.name}</strong><span>{item.path}</span><small>{relativeRecentLabel(item.openedAt)}</small>
          </button>
          <button type="button" className="start-recent-remove" onClick={() => onRemoveRecent(item.path)} aria-label={`移除最近文档 ${item.name}`}><X size={14} /></button>
        </li>)}
      </ul>}
    </section>
  </main>;
}

function App() {
  const [openedDocument, setOpenedDocument] = useState<OpenedMarkdownDocument | null>(null);
  const [recentDocuments, setRecentDocuments] = useState<readonly RecentMarkdownDocument[]>([]);
  const [activeMode, setActiveMode] = useState<AppMode>('reader');
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(false);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [editorFocusRequest, setEditorFocusRequest] = useState(0);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState<AppNotice | null>(null);
  const [activeSection, setActiveSection] = useState<number | null>(null);
  const [selectionProbe, setSelectionProbe] = useState<SelectionProbeResult | null>(null);
  const [readerContextMenu, setReaderContextMenu] = useState<ReaderContextMenuState | null>(null);
  const readerContextMenuRef = useRef<HTMLDivElement>(null);
  const readerContextMenuTrigger = useRef<HTMLElement | null>(null);
  const [selectionChecking, setSelectionChecking] = useState(false);
  const [selectionToolbarPosition, setSelectionToolbarPosition] = useState<SelectionToolbarPosition | null>(null);
  const [selectionAnnouncement, setSelectionAnnouncement] = useState('');
  const [readerSearchOpen, setReaderSearchOpen] = useState(false);
  const [readerSearchQuery, setReaderSearchQuery] = useState('');
  const [readerSearchIndex, setReaderSearchIndex] = useState(0);
  const [readerSearchCount, setReaderSearchCount] = useState(0);
  const [readerSearchTruncated, setReaderSearchTruncated] = useState(false);
  const [annotationView, setAnnotationView] = useState<AnnotationDocumentView | null>(null);
  const [annotationLoading, setAnnotationLoading] = useState(false);
  const [annotationSaving, setAnnotationSaving] = useState(false);
  const [summaryCopying, setSummaryCopying] = useState(false);
  const [annotationError, setAnnotationError] = useState<string | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [unpaintableIds, setUnpaintableIds] = useState<readonly string[]>([]);
  const [highlightSupported, setHighlightSupported] = useState(true);
  const [annotationPanelOpen, setAnnotationPanelOpen] = useState(
    () => window.matchMedia('(min-width: 1101px)').matches,
  );
  const [narrowLayout, setNarrowLayout] = useState(
    () => window.matchMedia('(max-width: 1100px)').matches,
  );
  const [noteFilter, setNoteFilter] = useState('all');
  const [noteComposer, setNoteComposer] = useState<NoteComposer | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteTagChoice, setNoteTagChoice] = useState(NO_TAG);
  const [newTagName, setNewTagName] = useState('');
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editNoteDraft, setEditNoteDraft] = useState('');
  const [editTagChoice, setEditTagChoice] = useState(NO_TAG);
  const [editNewTagName, setEditNewTagName] = useState('');
  const [reattachTargetId, setReattachTargetId] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const dropDepth = useRef(0);
  const documentEpoch = useRef(0);
  const paintedRanges = useRef(new Map<string, Range>());
  const mutationInFlight = useRef(false);
  const selectionTarget = useRef<ValidatedSelectionTarget | null>(null);
  const selectionFeedbackRange = useRef<Range | null>(null);
  const selectionFrame = useRef<number | null>(null);
  const selectionAnnouncementTimer = useRef<number | null>(null);
  const readerSearchMatches = useRef<readonly VisibleSearchMatch[]>([]);
  const sectionNavigationLock = useRef<number | null>(null);
  const sectionNavigationTimer = useRef<number | null>(null);
  const noteComposerRef = useRef<HTMLTextAreaElement>(null);
  const annotationToggleRef = useRef<HTMLButtonElement>(null);
  const annotationSidebarRef = useRef<HTMLElement>(null);
  const annotationCloseRef = useRef<HTMLButtonElement>(null);

  const setMessage = useCallback((text: string | null, kind: NoticeKind = 'status') => {
    setNotice(text ? { kind, text } : null);
  }, []);

  const closeReaderContextMenu = useCallback((restoreFocus = true) => {
    const trigger = readerContextMenuTrigger.current;
    readerContextMenuTrigger.current = null;
    setReaderContextMenu(null);
    if (restoreFocus) window.requestAnimationFrame(() => trigger?.focus({ preventScroll: true }));
  }, []);

  const refreshRecentDocuments = useCallback(async () => {
    try { setRecentDocuments(await window.mermarkd.listRecentDocuments()); }
    catch { setRecentDocuments([]); }
  }, []);

  useEffect(() => { void refreshRecentDocuments(); }, [refreshRecentDocuments]);

  const clearReaderSelection = useCallback((options: ClearSelectionOptions = {}) => {
    if (selectionFrame.current !== null) {
      window.cancelAnimationFrame(selectionFrame.current);
      selectionFrame.current = null;
    }
    if (selectionAnnouncementTimer.current !== null) {
      window.clearTimeout(selectionAnnouncementTimer.current);
      selectionAnnouncementTimer.current = null;
    }
    const previous = selectionTarget.current;
    selectionTarget.current = null;
    selectionFeedbackRange.current = null;
    setSelectionProbe(null);
    closeReaderContextMenu(false);
    setSelectionChecking(false);
    setSelectionToolbarPosition(null);
    setSelectionAnnouncement('');
    highlightRegistry()?.delete(ACTIVE_SELECTION_MARK_NAME);
    if (options.clearNative) window.getSelection()?.removeAllRanges();
    if (options.restoreFocus && previous?.origin.isConnected) {
      if (!previous.origin.hasAttribute('tabindex')) previous.origin.setAttribute('tabindex', '-1');
      previous.origin.focus({ preventScroll: true });
    }
  }, [closeReaderContextMenu]);

  useEffect(() => {
    if (!readerContextMenu) return;
    const close = () => closeReaderContextMenu(false);
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeReaderContextMenu(true);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', closeOnKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', closeOnKey);
    };
  }, [closeReaderContextMenu, readerContextMenu]);

  useEffect(() => {
    if (!readerContextMenu) return;
    const focusFirst = () => readerContextMenuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    focusFirst();
    const frame = window.requestAnimationFrame(focusFirst);
    return () => window.cancelAnimationFrame(frame);
  }, [readerContextMenu]);

  const clearReaderSearchPaint = useCallback(() => {
    const registry = highlightRegistry();
    registry?.delete(SEARCH_MARK_NAME);
    registry?.delete(CURRENT_SEARCH_MARK_NAME);
    readerSearchMatches.current = [];
    window.document.querySelectorAll<HTMLElement>('[data-search-current]')
      .forEach((element) => element.removeAttribute('data-search-current'));
  }, []);

  const refreshAnnotations = useCallback(async (epoch: number) => {
    setAnnotationLoading(true);
    setAnnotationError(null);
    try {
      const view = await window.mermarkd.loadAnnotations();
      if (documentEpoch.current === epoch) setAnnotationView(view);
    } catch (error) {
      if (documentEpoch.current === epoch) {
        setAnnotationView(null);
        setAnnotationError(error instanceof Error ? error.message : '读取批注状态失败。');
      }
    } finally {
      if (documentEpoch.current === epoch) setAnnotationLoading(false);
    }
  }, []);

  const acceptEditorDocument = useCallback((opened: OpenedMarkdownDocument) => {
    clearReaderSelection({ clearNative: true });
    clearReaderSearchPaint();
    const epoch = ++documentEpoch.current;
    setOpenedDocument(opened);
    setActiveSection(null);
    setReaderSearchOpen(false);
    setReaderSearchQuery('');
    setReaderSearchIndex(0);
    setReaderSearchCount(0);
    setReaderSearchTruncated(false);
    setAnnotationView(null);
    setSelectedAnnotationId(null);
    setUnpaintableIds([]);
    setNoteComposer(null);
    setEditingNoteId(null);
    setReattachTargetId(null);
    setAnnotationSaving(false);
    setSummaryCopying(false);
    void refreshAnnotations(epoch);
  }, [clearReaderSearchPaint, clearReaderSelection, refreshAnnotations]);

  const editorController = useMarkdownEditor(
    openedDocument,
    acceptEditorDocument,
    acceptEditorDocument,
    (message, alert) => setMessage(message, alert ? 'alert' : 'status'),
  );
  const dirtyPreview = Boolean(editorController.editor?.dirty);
  const commitReaderTextEdit = useCallback(async (blockStart: number, sourceText: string, replacement: string) => {
    if (activeMode !== 'reader' || !openedDocument || dirtyPreview) return;
    const epoch = documentEpoch.current;
    const sourcePath = openedDocument.path;
    const sourceSha256 = openedDocument.sourceSha256;
    const sourceContent = openedDocument.content;
    const result = applyReaderMappedTextEdit(sourceContent, openedDocument.bomByteLength, {
      blockStart,
      sourceText,
      replacement,
    });
    if (!result.ok) {
      setMessage(result.reason, 'alert');
      return;
    }
    const editor = editorController.editor ?? await editorController.open();
    if (!editor) return;
    if (activeMode !== 'reader' || documentEpoch.current !== epoch ||
      openedDocument?.path !== sourcePath || openedDocument?.sourceSha256 !== sourceSha256 ||
      openedDocument?.content !== sourceContent || editor.content !== sourceContent || editor.dirty) {
      setMessage('文档在阅读编辑期间发生变化，请重新载入后再试。', 'alert');
      return;
    }
    editorController.changeEditorText(markdownToEditorText(result.content));
    setMessage('正文修改已暂存到编辑缓冲区；切换到编辑模式后可预览并保存。');
  }, [activeMode, dirtyPreview, editorController, openedDocument, setMessage]);
  const [canvasStructurePreview, setCanvasStructurePreview] = useState<SectionStructurePreview | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryItems, setRecoveryItems] = useState<readonly DocumentRecoveryItem[]>([]);
  const [recoveryPreview, setRecoveryPreview] = useState<DocumentRecoveryPreview | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const readerDocument = useMemo(() => {
    if (!openedDocument || !editorController.editor?.dirty) return openedDocument;
    return { ...openedDocument, content: editorController.editor.content };
  }, [editorController.editor, openedDocument]);
  const documentForReaderAnalysis = activeMode === 'reader' ? readerDocument : openedDocument;
  const sectionTree = useMemo(
    () => documentForReaderAnalysis ? extractSections(documentForReaderAnalysis.content) : null,
    [documentForReaderAnalysis],
  );
  const selectionMap = useMemo(
    () => documentForReaderAnalysis && activeMode === 'reader' && !dirtyPreview
      ? buildSelectionMap(documentForReaderAnalysis.content, documentForReaderAnalysis.bomByteLength)
      : null,
    [activeMode, dirtyPreview, documentForReaderAnalysis],
  );
  const sectionIds = useMemo(() => {
    if (!sectionTree) return [];
    return sectionFragmentIds(sectionTree);
  }, [sectionTree]);
  const headingByOffset = useMemo(() => {
    const result = new Map<number, number>();
    const bomOffset = documentForReaderAnalysis?.content.startsWith('\uFEFF') ? 1 : 0;
    sectionTree?.sections.forEach((section) => result.set(section.headingRange.start - bomOffset, section.index));
    return result;
  }, [documentForReaderAnalysis, sectionTree]);
  const unsupportedExtensions = useMemo(
    () => documentForReaderAnalysis ? detectUnsupportedMarkdownExtensions(documentForReaderAnalysis.content) : [],
    [documentForReaderAnalysis],
  );
  const editorText = useMemo(
    () => editorController.editor ? markdownToEditorText(editorController.editor.content) : '',
    [editorController.editor],
  );
  const deferredEditorText = useDeferredValue(editorText);
  const editorSections = useMemo(() => {
    if (!deferredEditorText) return [];
    const tree = extractSections(deferredEditorText);
    return tree.sections.map((section) => {
      let depth = 1;
      let parent = section.parentIndex;
      while (parent !== null) {
        depth += 1;
        parent = tree.sections[parent].parentIndex;
      }
      return {
        key: String(section.index),
        title: section.title,
        depth,
        headingDepth: section.depth,
        sourceOffset: section.headingRange.start,
      };
    });
  }, [deferredEditorText]);

  const showOpenedDocument = useCallback((opened: OpenedMarkdownDocument) => {
    setCanvasStructurePreview(null);
    editorController.reset();
    clearReaderSelection({ clearNative: true });
    clearReaderSearchPaint();
    sectionNavigationLock.current = null;
    if (sectionNavigationTimer.current !== null) {
      window.clearTimeout(sectionNavigationTimer.current);
      sectionNavigationTimer.current = null;
    }
    const epoch = ++documentEpoch.current;
    setOpenedDocument(opened);
    setActiveMode('reader');
    setActiveSection(null);
    setReaderSearchOpen(false);
    setReaderSearchQuery('');
    setReaderSearchIndex(0);
    setReaderSearchCount(0);
    setReaderSearchTruncated(false);
    setAnnotationView(null);
    setSelectedAnnotationId(null);
    setUnpaintableIds([]);
    setNoteFilter('all');
    setNoteComposer(null);
    setEditingNoteId(null);
    setReattachTargetId(null);
    setAnnotationPanelOpen(window.matchMedia('(min-width: 1101px)').matches);
    setLeftSidebarOpen(false);
    setRightSidebarOpen(false);
    setFocusMode(false);
    setAnnotationSaving(false);
    setSummaryCopying(false);
    window.scrollTo({ top: 0 });
    void refreshRecentDocuments();
    void refreshAnnotations(epoch);
  }, [clearReaderSearchPaint, clearReaderSelection, editorController.reset, refreshAnnotations, refreshRecentDocuments]);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1101px)');
    let lastMatches = media.matches;
    const updatePanelForViewport = () => {
      const matches = media.matches;
      setNarrowLayout(!matches);
      if (matches !== lastMatches) setAnnotationPanelOpen(matches);
      lastMatches = matches;
    };
    media.addEventListener('change', updatePanelForViewport);
    window.addEventListener('resize', updatePanelForViewport);
    return () => {
      media.removeEventListener('change', updatePanelForViewport);
      window.removeEventListener('resize', updatePanelForViewport);
    };
  }, []);

  useEffect(() => {
    if (noteComposer) noteComposerRef.current?.focus();
  }, [noteComposer]);

  useEffect(() => {
    if (!reattachTargetId || !annotationView) return;
    const target = annotationView.items.find((item) => item.id === reattachTargetId);
    if (target && target.status !== 'resolved') return;
    setReattachTargetId(null);
    clearReaderSelection({ clearNative: true });
  }, [annotationView, clearReaderSelection, reattachTargetId]);

  useEffect(() => {
    if (!annotationPanelOpen) return;
    if (!narrowLayout) return;
    const composer = noteComposerRef.current;
    if (noteComposer && composer && !composer.disabled) composer.focus();
    else annotationCloseRef.current?.focus();
    const containDrawerFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const panel = annotationSidebarRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
        'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href], [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', containDrawerFocus);
    return () => window.removeEventListener('keydown', containDrawerFocus);
  }, [annotationPanelOpen, narrowLayout, noteComposer]);

  useEffect(() => {
    const registry = highlightRegistry();
    const article = document.querySelector<HTMLElement>('.markdown-body');
    paintedRanges.current.clear();
    ANNOTATION_MARK_NAMES.forEach((name) => registry?.delete(name));
    setHighlightSupported(Boolean(registry));
    const groups = new Map<string, Range[]>();
    const failures: string[] = [];
    if (activeMode === 'reader' && article && selectionMap && annotationView && !dirtyPreview) {
      const blockElements = new Map<number, HTMLElement>();
      article.querySelectorAll<HTMLElement>('[data-source-block-start]').forEach((element) => {
        blockElements.set(Number(element.dataset.sourceBlockStart), element);
      });
      const sourceBlocks = new Map(selectionMap.blocks.map((block) => [block.blockStart, block]));
      for (const item of annotationView.items) {
        if (item.status !== 'resolved') continue;
        if (item.kind === 'highlight' && (!item.color || !HIGHLIGHT_COLORS.some(({ value }) => value === item.color))) {
          failures.push(item.id);
          continue;
        }
        const mapped = resolveStoredHighlight(selectionMap, item.anchor);
        if (!mapped.ok) {
          failures.push(item.id);
          continue;
        }
        const block = blockElements.get(mapped.blockStart);
        const mappedBlock = sourceBlocks.get(mapped.blockStart);
        if (!block || !mappedBlock || block.textContent !== mappedBlock.visibleText) {
          failures.push(item.id);
          continue;
        }
        const range = textRange(block, mapped.visibleStart, mapped.visibleEnd, item.anchor.displayQuote);
        if (!range) {
          failures.push(item.id);
          continue;
        }
        paintedRanges.current.set(item.id, range);
        const baseName = item.color ? item.color : 'note';
        const name = item.id === selectedAnnotationId
          ? `mermarkd-selected-${baseName}` : `mermarkd-${baseName}`;
        if (registry) {
          const group = groups.get(name) ?? [];
          group.push(range);
          groups.set(name, group);
        }
      }
    }
    if (registry) {
      for (const [name, ranges] of groups) {
        const highlight = new Highlight(...ranges);
        const colorIndex = HIGHLIGHT_COLORS.findIndex(({ value }) => name.endsWith(value));
        highlight.priority = name.includes('selected') ? 10 : colorIndex < 0 ? 4 : colorIndex;
        registry.set(name, highlight);
      }
    }
    setUnpaintableIds(failures);
    return () => {
      ANNOTATION_MARK_NAMES.forEach((name) => registry?.delete(name));
      paintedRanges.current.clear();
    };
  }, [activeMode, annotationView, dirtyPreview, openedDocument?.path,
    openedDocument?.sourceSha256, selectedAnnotationId, selectionMap]);

  const openMarkdown = useCallback(async () => {
    if (dirtyPreview) {
      setMessage('请先保存或放弃当前编辑，再打开另一份 Markdown。', 'alert');
      return;
    }
    setOpening(true);
    setMessage(null);
    try {
      const opened = await window.mermarkd.openMarkdown();
      if (opened) showOpenedDocument(opened);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '打开文档失败，请重试。', 'alert');
    } finally {
      setOpening(false);
    }
  }, [dirtyPreview, setMessage, showOpenedDocument]);

  const newMarkdown = useCallback(async () => {
    if (dirtyPreview) {
      setMessage('请先保存或放弃当前编辑，再新建 Markdown。', 'alert');
      return;
    }
    setOpening(true);
    setMessage(null);
    try {
      const opened = await window.mermarkd.newMarkdown();
      if (opened) {
        showOpenedDocument(opened);
        setMessage('已创建未命名 Markdown；首次保存时选择文件位置。');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '新建 Markdown 失败，请重试。', 'alert');
    } finally {
      setOpening(false);
    }
  }, [dirtyPreview, setMessage, showOpenedDocument]);

  const openRecentMarkdown = useCallback(async (documentPath: string) => {
    if (dirtyPreview) {
      setMessage('请先保存或放弃当前编辑，再打开最近文档。', 'alert');
      return;
    }
    setOpening(true);
    setMessage(null);
    try {
      const opened = await window.mermarkd.openRecentMarkdown(documentPath);
      showOpenedDocument(opened);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '最近文档无法打开，可能已被移动或删除。', 'alert');
      void refreshRecentDocuments();
    } finally {
      setOpening(false);
    }
  }, [dirtyPreview, refreshRecentDocuments, setMessage, showOpenedDocument]);

  const removeRecentMarkdown = useCallback(async (documentPath: string) => {
    try {
      await window.mermarkd.removeRecentDocument(documentPath);
      await refreshRecentDocuments();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法移除最近文档记录。', 'alert');
    }
  }, [refreshRecentDocuments, setMessage]);

  const openDroppedMarkdown = useCallback(async (file: File) => {
    if (opening || dirtyPreview) {
      if (dirtyPreview) setMessage('请先保存或放弃当前编辑，再拖入另一份 Markdown。', 'alert');
      return;
    }
    setOpening(true);
    setMessage(null);
    try {
      const opened = await window.mermarkd.openDroppedMarkdown(file);
      showOpenedDocument(opened);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '拖入文档失败，请重试。', 'alert');
    } finally {
      setOpening(false);
    }
  }, [dirtyPreview, opening, setMessage, showOpenedDocument]);

  const reloadMarkdown = useCallback(async () => {
    if (opening || !openedDocument) return;
    if (dirtyPreview) {
      setMessage('请先保存或放弃当前编辑，再从磁盘重新载入。', 'alert');
      return;
    }
    setOpening(true);
    setMessage(null);
    try {
      const opened = await window.mermarkd.reloadMarkdown();
      showOpenedDocument(opened);
      setMessage('已从磁盘重新载入 Markdown，请审查批注的新位置。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '重新载入文档失败。', 'alert');
    } finally {
      setOpening(false);
    }
  }, [dirtyPreview, openedDocument, opening, setMessage, showOpenedDocument]);

  const onDropTargetEnter = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    if (dirtyPreview) return;
    dropDepth.current += 1;
    setDropActive(true);
  }, [dirtyPreview]);

  const onDropTargetOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = dirtyPreview ? 'none' : 'copy';
    if (dirtyPreview) return;
    setDropActive(true);
  }, [dirtyPreview]);

  const onDropTargetLeave = useCallback(() => {
    if (dropDepth.current === 0) return;
    dropDepth.current = Math.max(0, dropDepth.current - 1);
    if (dropDepth.current === 0) setDropActive(false);
  }, []);

  const onDropTargetDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dropDepth.current = 0;
    setDropActive(false);
    if (dirtyPreview) {
      setMessage('请先保存或放弃当前编辑，再拖入另一份 Markdown。', 'alert');
      return;
    }
    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) {
      setMessage('请一次只拖入一份 .md 文件。', 'alert');
      return;
    }
    const file = files[0];
    if (!file.name.toLowerCase().endsWith('.md')) {
      setMessage('请选择 .md 文件。', 'alert');
      return;
    }
    void openDroppedMarkdown(file);
  }, [dirtyPreview, openDroppedMarkdown, setMessage]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        if (!opening && !dirtyPreview) void openMarkdown();
        else if (dirtyPreview) setMessage('请先保存或放弃当前编辑，再打开另一份 Markdown。', 'alert');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dirtyPreview, openMarkdown, opening, setMessage]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (reattachTargetId) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setReattachTargetId(null);
        clearReaderSelection({ clearNative: true, restoreFocus: true });
        setMessage('已取消重新选择，批注文件未修改。');
        return;
      }
      if (annotationPanelOpen && narrowLayout) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setAnnotationPanelOpen(false);
        annotationToggleRef.current?.focus();
        return;
      }
      if (readerSearchOpen) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setReaderSearchOpen(false);
        clearReaderSearchPaint();
        return;
      }
      if (selectionProbe || selectionChecking) {
        event.preventDefault();
        event.stopImmediatePropagation();
        clearReaderSelection({ clearNative: true, restoreFocus: true });
        return;
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [annotationPanelOpen, clearReaderSearchPaint, clearReaderSelection, narrowLayout,
    readerSearchOpen, reattachTargetId, selectionChecking, selectionProbe, setMessage]);

  useEffect(() => {
    const preventFileNavigation = (event: DragEvent) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', preventFileNavigation);
    window.addEventListener('drop', preventFileNavigation);
    return () => {
      window.removeEventListener('dragover', preventFileNavigation);
      window.removeEventListener('drop', preventFileNavigation);
    };
  }, []);

  const holdNavigatedSection = useCallback((index: number) => {
    sectionNavigationLock.current = index;
    setActiveSection(index);
    if (sectionNavigationTimer.current !== null) window.clearTimeout(sectionNavigationTimer.current);
    sectionNavigationTimer.current = window.setTimeout(() => {
      sectionNavigationLock.current = null;
      sectionNavigationTimer.current = null;
      window.dispatchEvent(new Event('scroll'));
    }, 700);
  }, []);

  useEffect(() => () => {
    if (sectionNavigationTimer.current !== null) window.clearTimeout(sectionNavigationTimer.current);
  }, []);

  const jumpToSection = useCallback((index: number) => {
    const id = sectionIds[index];
    const target = id ? window.document.getElementById(id) : null;
    if (!target) return;
    holdNavigatedSection(index);
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.focus({ preventScroll: true });
  }, [holdNavigatedSection, sectionIds]);

  useEffect(() => {
    if (activeMode !== 'reader' || !readerDocument || sectionIds.length === 0) {
      setActiveSection(null);
      return;
    }
    let frame: number | null = null;
    const updateActiveSection = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (sectionNavigationLock.current !== null) {
          setActiveSection((current) => current === sectionNavigationLock.current
            ? current : sectionNavigationLock.current);
          return;
        }
        const positions = sectionIds.flatMap((id, index) => {
          const headingElement = window.document.getElementById(id);
          return headingElement ? [{ index, top: headingElement.getBoundingClientRect().top }] : [];
        });
        const documentHeight = window.document.documentElement.scrollHeight;
        const atDocumentEnd = documentHeight > window.innerHeight + 2 &&
          window.scrollY + window.innerHeight >= documentHeight - 2;
        const next = atDocumentEnd && positions.length
          ? positions[positions.length - 1].index
          : activeSectionAtMarker(positions, READING_POSITION_TOP);
        setActiveSection((current) => current === next ? current : next);
      });
    };
    updateActiveSection();
    window.addEventListener('scroll', updateActiveSection, { passive: true });
    window.addEventListener('resize', updateActiveSection);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', updateActiveSection);
      window.removeEventListener('resize', updateActiveSection);
    };
  }, [activeMode, readerDocument, sectionIds]);

  const openLink = useCallback((event: MouseEvent<HTMLAnchorElement>, href: string | undefined) => {
    event.preventDefault();
    if (!href) return;
    if (href.startsWith('#')) {
      try {
        const target = window.document.getElementById(decodeURIComponent(href.slice(1)));
        if (target) {
          const targetIndex = sectionIds.indexOf(target.id);
          if (targetIndex >= 0) holdNavigatedSection(targetIndex);
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          target.focus({ preventScroll: true });
          setMessage(null);
        } else setMessage('未找到文档内的目标章节。', 'alert');
      } catch {
        setMessage('此章节链接无效。', 'alert');
      }
      return;
    }
    if (isExternalUrl(href)) {
      void window.mermarkd.openExternal(href)
        .then((opened) => { if (!opened) setMessage('无法打开此链接。', 'alert'); })
        .catch(() => setMessage('无法打开此链接。', 'alert'));
      return;
    }
    setMessage('当前版本暂不支持打开文档中的相对链接。');
  }, [holdNavigatedSection, sectionIds, setMessage]);

  const positionSelectionFeedback = useCallback((range: Range) => {
    const rect = range.getBoundingClientRect();
    if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) {
      setSelectionToolbarPosition(null);
      return;
    }
    const placement: SelectionToolbarPosition['placement'] = rect.top >= 112 ? 'above' : 'below';
    setSelectionToolbarPosition({
      top: placement === 'above' ? Math.max(8, rect.top - 10) : Math.min(window.innerHeight - 8, rect.bottom + 10),
      placement,
    });
  }, []);

  const resolveRangeSelection = useCallback((range: Range): SelectionProbeResult => {
    const article = window.document.querySelector<HTMLElement>('.markdown-body');
    if (!selectionMap || !article || range.collapsed ||
        !article.contains(range.startContainer) || !article.contains(range.endContainer)) {
      return { ok: false, reason: '请先在正文中选择一段文字。' };
    }
    const startBlock = sourceBlockFor(range.startContainer);
    const endBlock = sourceBlockFor(range.endContainer);
    if (!startBlock || startBlock !== endBlock || !article.contains(startBlock)) {
      return { ok: false, reason: '目前只支持同一标题或段落内的选区。' };
    }

    const blockStart = Number(startBlock.dataset.sourceBlockStart);
    const block = selectionMap.blocks.find((candidate) => candidate.blockStart === blockStart);
    if (!block || startBlock.textContent !== block.visibleText) {
      return { ok: false, reason: '渲染文字与源码映射不一致，已拒绝定位。' };
    }

    try {
      const prefix = window.document.createRange();
      prefix.setStart(startBlock, 0);
      prefix.setEnd(range.startContainer, range.startOffset);
      const visibleStart = prefix.toString().length;
      const visibleEnd = visibleStart + range.toString().length;
      if (block.visibleText.slice(visibleStart, visibleEnd) !== range.toString()) {
        return { ok: false, reason: '选中文字与源码映射不一致，已拒绝定位。' };
      }
      return resolveSelection(selectionMap, blockStart, visibleStart, visibleEnd);
    } catch {
      return { ok: false, reason: '无法读取当前选区，请重新选择文字。' };
    }
  }, [selectionMap]);

  const rememberSelection = useCallback((range: Range, result: SelectionProbeResult) => {
    if (selectionAnnouncementTimer.current !== null) {
      window.clearTimeout(selectionAnnouncementTimer.current);
      selectionAnnouncementTimer.current = null;
    }
    setSelectionChecking(false);
    setSelectionProbe(result);
    positionSelectionFeedback(range);
    highlightRegistry()?.delete(ACTIVE_SELECTION_MARK_NAME);
    selectionFeedbackRange.current = range.cloneRange();
    if (!result.ok) {
      selectionTarget.current = null;
      setSelectionAnnouncement(`此选区暂不能批注。${selectionReasonForReader(result.reason)}`);
      return;
    }
    const origin = sourceBlockFor(range.startContainer) ??
      window.document.querySelector<HTMLElement>('.markdown-body');
    if (!origin || !openedDocument) return;
    const preservedRange = range.cloneRange();
    selectionTarget.current = {
      epoch: documentEpoch.current,
      sourceSha256: openedDocument.sourceSha256,
      probe: result,
      range: preservedRange,
      origin,
    };
    const registry = highlightRegistry();
    if (registry) {
      const activeSelection = new Highlight(preservedRange);
      activeSelection.priority = 20;
      registry.set(ACTIVE_SELECTION_MARK_NAME, activeSelection);
    }
    selectionAnnouncementTimer.current = window.setTimeout(() => {
      setSelectionAnnouncement(`已选择 ${countGraphemes(result.displayQuote)} 个字符，可以添加高亮或批注。`);
      selectionAnnouncementTimer.current = null;
    }, 180);
  }, [openedDocument, positionSelectionFeedback]);

  const readSelection = useCallback((): SelectionProbeResult => {
    const cached = selectionTarget.current;
    if (cached && openedDocument && cached.epoch === documentEpoch.current &&
        cached.sourceSha256 === openedDocument.sourceSha256) return cached.probe;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
      return { ok: false, reason: '请先在正文中选择一段文字。' };
    }
    const range = selection.getRangeAt(0).cloneRange();
    const result = resolveRangeSelection(range);
    rememberSelection(range, result);
    return result;
  }, [openedDocument, rememberSelection, resolveRangeSelection]);

  const openReaderContextMenu = useCallback((event: MouseEvent<HTMLElement>) => {
    if (dirtyPreview || !openedDocument) return;
    const article = window.document.querySelector<HTMLElement>('.markdown-body');
    const selection = window.getSelection();
    if (!article || !selection || selection.rangeCount !== 1 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!article.contains(range.startContainer) || !article.contains(range.endContainer)) return;
    const probe = readSelection();
    if (!probe.ok) return;
    event.preventDefault();
    readerContextMenuTrigger.current = event.currentTarget;
    setReaderContextMenu({
      left: Math.max(8, Math.min(event.clientX, window.innerWidth - 244)),
      top: Math.max(8, Math.min(event.clientY, window.innerHeight - 310)),
      probe,
      epoch: documentEpoch.current,
      sourceSha256: openedDocument.sourceSha256,
    });
  }, [dirtyPreview, openedDocument, readSelection]);

  const handleReaderContextMenuKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')];
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeReaderContextMenu(true); return; }
    if (items.length === 0) return;
    const current = window.document.activeElement instanceof HTMLButtonElement ? items.indexOf(window.document.activeElement) : -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      (window.document.activeElement as HTMLButtonElement | null)?.click();
    }
  }, [closeReaderContextMenu]);

  const handleReaderContextShortcut = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (activeMode !== 'reader' || dirtyPreview || !openedDocument ||
        !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return;
    // The context-menu state may lag one render behind after Escape. The
    // mounted menu is authoritative so a second keyboard invocation is not
    // dropped during that transition.
    if (window.document.querySelector('[data-reader-context-menu]')) return;
    const probe = readSelection();
    if (!probe.ok) return;
    event.preventDefault();
    event.stopPropagation();
    const box = event.currentTarget.getBoundingClientRect();
    readerContextMenuTrigger.current = event.currentTarget;
    setReaderContextMenu({
      left: Math.max(8, Math.min(box.left + 12, window.innerWidth - 244)),
      top: Math.max(8, Math.min(box.top + 28, window.innerHeight - 310)),
      probe, epoch: documentEpoch.current, sourceSha256: openedDocument.sourceSha256,
    });
  }, [activeMode, dirtyPreview, openedDocument, readSelection]);

  const copyReaderContextSelection = useCallback(async () => {
    const menu = readerContextMenu;
    if (!menu || menu.epoch !== documentEpoch.current || !openedDocument ||
        menu.sourceSha256 !== openedDocument.sourceSha256) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('当前环境不支持剪贴板写入。');
      await navigator.clipboard.writeText(menu.probe.displayQuote);
      if (documentEpoch.current !== menu.epoch) return;
      setMessage('已复制所选正文。');
      closeReaderContextMenu();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '复制失败。', 'alert');
    }
  }, [closeReaderContextMenu, openedDocument, readerContextMenu, setMessage]);

  const canApplyReaderFormat = useCallback((action: MarkdownSourceSelectionAction, menu: ReaderContextMenuState | null) => {
    if (!menu || !openedDocument || dirtyPreview || (action !== 'bold' && action !== 'italic' && action !== 'quote')) return false;
    return resolveReaderInlineFormatSelection(
      openedDocument.content,
      openedDocument.bomByteLength,
      action,
      menu.probe,
    ).ok;
  }, [dirtyPreview, openedDocument]);

  const applyReaderContextFormat = useCallback(async (
    action: Extract<MarkdownSourceSelectionAction, 'bold' | 'italic' | 'quote'>,
    frozenProbe: SuccessfulSelectionProbe,
  ) => {
    if (activeMode !== 'reader' || dirtyPreview || !openedDocument) return;
    const epoch = documentEpoch.current;
    const sourcePath = openedDocument.path;
    const sourceSha256 = openedDocument.sourceSha256;
    const sourceContent = openedDocument.content;
    const resolved = resolveReaderInlineFormatSelection(
      sourceContent,
      openedDocument.bomByteLength,
      action,
      frozenProbe,
    );
    if (!resolved.ok) {
      setMessage(resolved.reason, 'alert');
      return;
    }
    // The renderer session uses LF offsets. Convert the proven source span
    // without guessing through a CRLF or a leading BOM.
    const sourceOffset = sourceContent.startsWith('\uFEFF') ? 1 : 0;
    const normalized = markdownToEditorText(sourceContent);
    const start = markdownToEditorText(sourceContent.slice(0, sourceOffset + resolved.sourceStart)).length;
    const end = markdownToEditorText(sourceContent.slice(0, sourceOffset + resolved.sourceEnd)).length;
    let editor = editorController.editor;
    if (!editor) editor = await editorController.open();
    if (!editor || activeMode !== 'reader' || documentEpoch.current !== epoch ||
        openedDocument?.path !== sourcePath || openedDocument?.sourceSha256 !== sourceSha256 ||
        openedDocument?.content !== sourceContent || editor.dirty || editor.content !== sourceContent) {
      setMessage('文档在阅读格式编辑期间发生变化，请重新载入后再试。', 'alert');
      return;
    }
    if (action === 'quote' && sourceContent.startsWith('\uFEFF') && resolved.sourceStart === 0) {
      setMessage('带 BOM 的文档首段暂不能直接加引用格式，请在源码视图完成。', 'alert');
      return;
    }
    try {
      const next = applyMarkdownSelectionCommand(normalized, { start, end }, action);
      if (!next.changed) return;
      editorController.changeEditorText(next.content);
      setMessage(action === 'bold' ? '已在阅读模式暂存加粗。' : action === 'italic' ? '已在阅读模式暂存斜体。' : '已在阅读模式暂存引用格式。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '阅读格式编辑失败。', 'alert');
    }
  }, [activeMode, dirtyPreview, editorController, openedDocument, setMessage]);

  useEffect(() => {
    closeReaderContextMenu(false);
  }, [activeMode, closeReaderContextMenu, openedDocument?.sourceSha256]);

  useEffect(() => {
    if (activeMode !== 'reader' || !openedDocument || dirtyPreview) return;
    const epoch = documentEpoch.current;
    const sourceSha256 = openedDocument.sourceSha256;
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      const article = window.document.querySelector<HTMLElement>('.markdown-body');
      if (!selection || !article || selection.rangeCount !== 1) return;
      const range = selection.getRangeAt(0);
      const startsInArticle = article.contains(range.startContainer);
      const endsInArticle = article.contains(range.endContainer);
      if (!startsInArticle || !endsInArticle) {
        if (!range.collapsed && (selectionTarget.current || selectionFeedbackRange.current)) clearReaderSelection();
        return;
      }
      if (range.collapsed) {
        clearReaderSelection();
        return;
      }
      if (selectionFrame.current !== null) window.cancelAnimationFrame(selectionFrame.current);
      selectionTarget.current = null;
      highlightRegistry()?.delete(ACTIVE_SELECTION_MARK_NAME);
      setSelectionProbe(null);
      setSelectionAnnouncement('');
      positionSelectionFeedback(range);
      setSelectionChecking(true);
      const pendingRange = range.cloneRange();
      selectionFrame.current = window.requestAnimationFrame(() => {
        selectionFrame.current = null;
        const currentArticle = window.document.querySelector<HTMLElement>('.markdown-body');
        if (documentEpoch.current !== epoch || openedDocument.sourceSha256 !== sourceSha256 || !currentArticle ||
            !currentArticle.contains(pendingRange.startContainer) || !currentArticle.contains(pendingRange.endContainer)) return;
        rememberSelection(pendingRange, resolveRangeSelection(pendingRange));
      });
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      clearReaderSelection();
    };
  }, [activeMode, clearReaderSelection, dirtyPreview, openedDocument,
    positionSelectionFeedback, rememberSelection, resolveRangeSelection]);

  useEffect(() => {
    if (!selectionProbe) return;
    let frame: number | null = null;
    const updatePosition = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const range = selectionTarget.current?.range ?? selectionFeedbackRange.current;
        if (range) positionSelectionFeedback(range);
      });
    };
    window.addEventListener('scroll', updatePosition, { passive: true });
    window.addEventListener('resize', updatePosition);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', updatePosition);
      window.removeEventListener('resize', updatePosition);
    };
  }, [positionSelectionFeedback, selectionProbe]);

  const paintReaderSearch = useCallback((index: number, scrollToMatch: boolean) => {
    const matches = readerSearchMatches.current;
    const registry = highlightRegistry();
    registry?.delete(SEARCH_MARK_NAME);
    registry?.delete(CURRENT_SEARCH_MARK_NAME);
    window.document.querySelectorAll<HTMLElement>('[data-search-current]')
      .forEach((element) => element.removeAttribute('data-search-current'));
    if (!matches.length) return;
    const currentIndex = Math.min(Math.max(index, 0), matches.length - 1);
    if (registry) {
      const otherRanges = matches.filter((_, matchIndex) => matchIndex !== currentIndex)
        .map((match) => match.range);
      if (otherRanges.length) {
        const allMatches = new Highlight(...otherRanges);
        allMatches.priority = 11;
        registry.set(SEARCH_MARK_NAME, allMatches);
      }
      const currentMatch = new Highlight(matches[currentIndex].range);
      currentMatch.priority = 12;
      registry.set(CURRENT_SEARCH_MARK_NAME, currentMatch);
    }
    const match = matches[currentIndex];
    match.block.dataset.searchCurrent = 'true';
    if (scrollToMatch) {
      const rect = match.range.getBoundingClientRect();
      window.scrollBy({ top: rect.top - Math.min(window.innerHeight * .4, 240), behavior: 'smooth' });
    }
  }, []);

  useEffect(() => {
    clearReaderSearchPaint();
    setReaderSearchCount(0);
    setReaderSearchIndex(0);
    setReaderSearchTruncated(false);
    if (activeMode !== 'reader' || !readerSearchOpen || !readerSearchQuery || !readerDocument) return;
    const article = window.document.querySelector<HTMLElement>('.markdown-body');
    if (!article) return;
    const result = collectVisibleSearchMatches(article, readerSearchQuery);
    readerSearchMatches.current = result.matches;
    setReaderSearchCount(result.matches.length);
    setReaderSearchTruncated(result.truncated);
    if (result.matches.length) paintReaderSearch(0, true);
    return () => clearReaderSearchPaint();
  }, [activeMode, clearReaderSearchPaint, paintReaderSearch, readerDocument,
    readerSearchOpen, readerSearchQuery]);

  const moveReaderSearch = useCallback((direction: 1 | -1) => {
    const total = readerSearchMatches.current.length;
    if (!total) return;
    setReaderSearchIndex((current) => {
      const next = (current + direction + total) % total;
      paintReaderSearch(next, true);
      return next;
    });
  }, [paintReaderSearch]);

  const closeReaderSearch = useCallback(() => {
    setReaderSearchOpen(false);
    clearReaderSearchPaint();
  }, [clearReaderSearchPaint]);

  const openReaderSearch = useCallback(() => {
    if (readerDocument && activeMode === 'reader') setReaderSearchOpen(true);
  }, [activeMode, readerDocument]);

  const runAnnotationMutation = useCallback(async (
    action: () => Promise<AnnotationSaveResult>,
    successMessage: string,
    afterSaved?: (result: AnnotationSaveResult) => void,
    allowRelocation = false,
  ) => {
    const allowedStatus = annotationView?.status === 'ready' ||
      (allowRelocation && annotationView?.status === 'needs-relocation');
    if (dirtyPreview || activeMode !== 'reader' || !allowedStatus || annotationView.pendingDraftCount > 0 ||
        annotationLoading || mutationInFlight.current) return;
    const epoch = documentEpoch.current;
    mutationInFlight.current = true;
    setAnnotationSaving(true);
    setMessage(null);
    try {
      const result = await action();
      if (documentEpoch.current !== epoch) return;
      await refreshAnnotations(epoch);
      if (result.status === 'saved') {
        afterSaved?.(result);
        setMessage(successMessage);
      } else if (result.status === 'conflict') {
        clearReaderSelection({ clearNative: true });
        setMessage(result.draftPath
          ? `文件已发生变化，未覆盖批注文件。待处理草稿：${result.draftPath}`
          : result.reason ?? '批注状态已变化，请重新打开文档后再试。', 'alert');
      } else {
        clearReaderSelection({ clearNative: true });
        setMessage(`批注尚未写回同目录。待保存草稿：${result.draftPath ?? '应用数据目录'}`, 'alert');
      }
    } catch (error) {
      if (documentEpoch.current === epoch) {
        setMessage(error instanceof Error ? error.message : '保存批注失败。', 'alert');
      }
    } finally {
      mutationInFlight.current = false;
      if (documentEpoch.current === epoch) setAnnotationSaving(false);
    }
  }, [activeMode, annotationLoading, annotationView, clearReaderSelection, dirtyPreview,
    refreshAnnotations, setMessage]);

  const createHighlight = useCallback((color: AnnotationColor, frozenProbe?: SuccessfulSelectionProbe) => {
    const probe = frozenProbe ?? readSelection();
    setSelectionProbe(probe);
    if (!probe.ok) return;
    const selection = {
      startByte: probe.startByte,
      endByte: probe.endByte,
      sourceExact: probe.sourceExact,
      displayQuote: probe.displayQuote,
    };
    void runAnnotationMutation(
      () => window.mermarkd.createHighlight({ selection, color }),
      '高亮已保存，Markdown 原文未修改。',
      (result) => {
        clearReaderSelection({ clearNative: true });
        setSelectedAnnotationId(result.id ?? null);
      },
    );
  }, [clearReaderSelection, readSelection, runAnnotationMutation]);

  const recolorHighlight = useCallback((id: string, color: AnnotationColor) => {
    void runAnnotationMutation(
      () => window.mermarkd.recolorHighlight({ id, color }),
      '高亮颜色已更新。',
    );
  }, [runAnnotationMutation]);

  const deleteHighlight = useCallback((id: string) => {
    void runAnnotationMutation(
      () => window.mermarkd.deleteHighlight(id),
      '高亮已删除。',
      () => { if (selectedAnnotationId === id) setSelectedAnnotationId(null); },
    );
  }, [runAnnotationMutation, selectedAnnotationId]);

  const jumpToAnnotation = useCallback((id: string) => {
    const range = paintedRanges.current.get(id);
    if (!range) return;
    setSelectedAnnotationId(id);
    if (window.matchMedia('(max-width: 1100px)').matches) setAnnotationPanelOpen(false);
    const rect = range.getBoundingClientRect();
    window.scrollBy({ top: rect.top - Math.min(window.innerHeight * .3, 180), behavior: 'smooth' });
    const block = sourceBlockFor(range.commonAncestorContainer);
    if (block) {
      if (!block.hasAttribute('tabindex')) block.setAttribute('tabindex', '-1');
      block.focus({ preventScroll: true });
    }
  }, []);

  const openNoteComposer = useCallback((frozenProbe?: SuccessfulSelectionProbe) => {
    const probe = frozenProbe ?? readSelection();
    setSelectionProbe(probe);
    if (!probe.ok) return;
    setNoteComposer({
      selection: {
        startByte: probe.startByte,
        endByte: probe.endByte,
        sourceExact: probe.sourceExact,
        displayQuote: probe.displayQuote,
      },
      quote: probe.displayQuote,
    });
    setNoteDraft('');
    setNoteTagChoice(NO_TAG);
    setNewTagName('');
    setEditingNoteId(null);
    setAnnotationPanelOpen(true);
  }, [readSelection]);

  const createNote = useCallback((event: FormEvent) => {
    event.preventDefault();
    if (!noteComposer || !noteDraft.trim() ||
        (noteTagChoice === NEW_TAG && !newTagName.trim())) return;
    void runAnnotationMutation(
      () => window.mermarkd.createNote({
        selection: noteComposer.selection,
        note: noteDraft,
        tag: noteTagInput(noteTagChoice, newTagName),
      }),
      '批注已保存，Markdown 原文未修改。',
      (result) => {
        setNoteComposer(null);
        clearReaderSelection({ clearNative: true });
        setSelectedAnnotationId(result.id ?? null);
      },
    );
  }, [clearReaderSelection, newTagName, noteComposer, noteDraft, noteTagChoice, runAnnotationMutation]);

  const beginEditNote = useCallback((id: string) => {
    const item = annotationView?.items.find((candidate) => candidate.id === id && candidate.kind === 'note');
    if (!item) return;
    setEditingNoteId(id);
    setEditNoteDraft(item.note ?? '');
    setEditTagChoice(item.tagId ? `${TAG_VALUE_PREFIX}${item.tagId}` : NO_TAG);
    setEditNewTagName('');
    setSelectedAnnotationId(id);
  }, [annotationView]);

  const updateNote = useCallback((event: FormEvent, id: string) => {
    event.preventDefault();
    if (!editNoteDraft.trim() || (editTagChoice === NEW_TAG && !editNewTagName.trim())) return;
    void runAnnotationMutation(
      () => window.mermarkd.updateNote({
        id,
        note: editNoteDraft,
        tag: noteTagInput(editTagChoice, editNewTagName),
      }),
      '批注已更新。',
      () => setEditingNoteId(null),
    );
  }, [editNewTagName, editNoteDraft, editTagChoice, runAnnotationMutation]);

  const deleteNote = useCallback((id: string) => {
    void runAnnotationMutation(
      () => window.mermarkd.deleteNote(id),
      '批注已删除。',
      () => {
        if (selectedAnnotationId === id) setSelectedAnnotationId(null);
        if (editingNoteId === id) setEditingNoteId(null);
      },
    );
  }, [editingNoteId, runAnnotationMutation, selectedAnnotationId]);

  const beginReattach = useCallback((id: string) => {
    const item = annotationView?.items.find((candidate) => candidate.id === id);
    if (!annotationView || !item || item.status === 'resolved' || annotationView.status === 'read-only' ||
        annotationView.pendingDraftCount > 0 || annotationSaving || annotationLoading) return;
    setReattachTargetId(id);
    setSelectedAnnotationId(id);
    clearReaderSelection({ clearNative: true });
    setNoteComposer(null);
    setEditingNoteId(null);
    setMessage(`请在当前正文中选择“${item.anchor.displayQuote}”的新位置，然后确认。按 Escape 可取消。`);
    if (window.matchMedia('(max-width: 1100px)').matches) setAnnotationPanelOpen(false);
  }, [annotationLoading, annotationSaving, annotationView, clearReaderSelection, setMessage]);

  const confirmReattach = useCallback(() => {
    if (!reattachTargetId) return;
    const probe = readSelection();
    setSelectionProbe(probe);
    if (!probe.ok) return;
    const selection = {
      startByte: probe.startByte,
      endByte: probe.endByte,
      sourceExact: probe.sourceExact,
      displayQuote: probe.displayQuote,
    };
    void runAnnotationMutation(
      () => window.mermarkd.reattachAnnotation({ id: reattachTargetId, selection }),
      '新位置已保存，便签、标签和高亮属性保持不变。',
      () => {
        setReattachTargetId(null);
        clearReaderSelection({ clearNative: true });
      },
      true,
    );
  }, [clearReaderSelection, readSelection, reattachTargetId, runAnnotationMutation]);

  const applyRelocations = useCallback(() => {
    void runAnnotationMutation(
      () => window.mermarkd.applyAnnotationRelocations(),
      '已保存可安全确认的重定位结果；其余记录仍保持待定位。',
      undefined,
      true,
    );
  }, [runAnnotationMutation]);

  const copySummary = useCallback(async () => {
    if (!annotationView?.canCopySummary || summaryCopying) return;
    const epoch = documentEpoch.current;
    setSummaryCopying(true);
    try {
      const filter = noteFilter === 'all'
        ? { mode: 'all' as const }
        : noteFilter === 'untagged'
          ? { mode: 'untagged' as const }
          : { mode: 'tag' as const, tagId: noteFilter.slice(TAG_VALUE_PREFIX.length) };
      const result = await window.mermarkd.copyReadingSummary(filter);
      if (documentEpoch.current === epoch) {
        setMessage(`已复制阅读摘要（${result.count} 条），文档与批注均未修改。`);
      }
    } catch (error) {
      if (documentEpoch.current === epoch) {
        setMessage(error instanceof Error ? error.message : '复制阅读摘要失败。', 'alert');
      }
    } finally {
      if (documentEpoch.current === epoch) setSummaryCopying(false);
    }
  }, [annotationView, noteFilter, setMessage, summaryCopying]);

  const heading = useCallback((tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6', props: ComponentProps<'h1'> & ExtraProps) => {
    const { node, children, ...rest } = props;
    const blockStart = node?.position?.start.offset;
    const index = blockStart === undefined ? undefined : headingByOffset.get(blockStart);
    const id = index === undefined ? undefined : sectionIds[index];
    const block = blockStart === undefined ? undefined : selectionMap?.blocks.find((candidate) => candidate.blockStart === blockStart);
    if (activeMode === 'reader' && !dirtyPreview && blockStart !== undefined && block && isReaderMappedTextBlock(selectionMap!, block)) {
      return <ReaderEditableBlock as={tag} blockStart={blockStart} sourceText={block.visibleText} enabled
        onCommit={commitReaderTextEdit} id={id} tabIndex={id ? -1 : undefined} className={rest.className}>
        {children}
      </ReaderEditableBlock>;
    }
    const Tag = tag;
    return <Tag {...rest} id={id} tabIndex={id ? -1 : undefined}
      data-source-block-start={node?.position?.start.offset}>{children}</Tag>;
  }, [activeMode, commitReaderTextEdit, dirtyPreview, headingByOffset, sectionIds, selectionMap]);

  const components = useMemo<Components>(() => ({
    h1: (props) => heading('h1', props),
    h2: (props) => heading('h2', props),
    h3: (props) => heading('h3', props),
    h4: (props) => heading('h4', props),
    h5: (props) => heading('h5', props),
    h6: (props) => heading('h6', props),
    p: ({ node, children, ...props }) => {
      const blockStart = node?.position?.start.offset;
      const block = blockStart === undefined ? undefined : selectionMap?.blocks.find((candidate) => candidate.blockStart === blockStart);
      if (activeMode === 'reader' && !dirtyPreview && block && blockStart !== undefined && isReaderMappedTextBlock(selectionMap!, block)) {
        return <ReaderEditableBlock as="p" blockStart={blockStart} sourceText={block.visibleText} enabled
          onCommit={commitReaderTextEdit} className={props.className}>{children}</ReaderEditableBlock>;
      }
      return <p {...props} data-source-block-start={blockStart}>{children}</p>;
    },
    table: ({ node: _node, children, ...props }) => (
      <div className="table-scroll" role="region" aria-label="表格，可水平滚动" tabIndex={0}>
        <table {...props}>{children}</table>
      </div>
    ),
    pre: ({ node: _node, children, ...props }) => (
      <pre {...props} tabIndex={0} aria-label="代码块，可水平滚动">{children}</pre>
    ),
    a: ({ node: _node, href, children, ...props }) => (
      <a {...props} href={href} onClick={(event) => openLink(event, href)}>{children}</a>
    ),
    img: ({ node: _node, src, alt }) => (
      <LocalImage src={src} alt={alt} documentPath={openedDocument?.path ?? ''} />
    ),
    input: ({ node: _node, ...props }) => <input {...props} disabled readOnly />,
  }), [activeMode, commitReaderTextEdit, dirtyPreview, heading, openedDocument?.path, openLink, selectionMap]);

  const highlightItems = annotationView?.items.filter((item) => item.kind === 'highlight') ?? [];
  const noteItems = annotationView?.items.filter((item) => item.kind === 'note') ?? [];
  const tags = annotationView?.tags ?? [];
  const tagById = new Map(tags.map((tag) => [tag.id, tag.name]));
  const filteredNotes = noteItems.filter((item) => noteFilter === 'all' ||
    (noteFilter === 'untagged' ? !item.tagId : `${TAG_VALUE_PREFIX}${item.tagId ?? ''}` === noteFilter));
  const unpaintableSet = new Set(unpaintableIds);
  const canChangeAnnotations = activeMode === 'reader' && !openedDocument?.recoveryPending && !dirtyPreview && annotationView?.status === 'ready' &&
    annotationView.pendingDraftCount === 0 && !annotationSaving && !annotationLoading && !reattachTargetId;
  const canReviewRelocation = activeMode === 'reader' && !openedDocument?.recoveryPending && !dirtyPreview &&
    (annotationView?.status === 'ready' || annotationView?.status === 'needs-relocation') &&
    annotationView.pendingDraftCount === 0 && !annotationSaving && !annotationLoading;
  const canStartRelocationAction = canReviewRelocation && !reattachTargetId;
  const reattachTarget = reattachTargetId
    ? annotationView?.items.find((item) => item.id === reattachTargetId)
    : undefined;

  const moveSelectionToolbarFocus = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    if (!controls.length) return;
    const currentIndex = controls.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex = currentIndex < 0 ? 0 : currentIndex;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = controls.length - 1;
    else if (event.key === 'ArrowRight') nextIndex = (Math.max(currentIndex, -1) + 1) % controls.length;
    else nextIndex = currentIndex <= 0 ? controls.length - 1 : currentIndex - 1;
    event.preventDefault();
    controls[nextIndex].focus();
  }, []);

  const changeMode = useCallback(async (mode: AppMode) => {
    if (!openedDocument || mode === activeMode) return;
    clearReaderSelection({ clearNative: true });
    closeReaderSearch();
    setNoteComposer(null);
    setEditingNoteId(null);
    setReattachTargetId(null);
    if (mode === 'reader') {
      setActiveMode('reader');
      if (activeSection !== null) window.requestAnimationFrame(() => jumpToSection(activeSection));
      else window.scrollTo({ top: 0 });
      return;
    }
    if (mode === 'cards') {
      setAnnotationPanelOpen(false);
      setActiveMode('cards');
      window.scrollTo({ top: 0 });
      return;
    }
    const next = editorController.editor ?? await editorController.open();
    if (!next) return;
    setAnnotationPanelOpen(false);
    setActiveMode('editor');
    window.scrollTo({ top: 0 });
  }, [activeMode, activeSection, clearReaderSelection, closeReaderSearch, editorController, jumpToSection, openedDocument]);

  const editCanvasSection = useCallback((index: number | null) => {
    setActiveSection(index);
    setEditorFocusRequest((request) => request + 1);
    void changeMode('editor');
  }, [changeMode]);

  const previewCanvasStructure = useCallback(async (operation: SectionTransformOperation) => {
    const editor = editorController.editor ?? await editorController.open();
    if (!editor || editor.dirty) throw new Error('请先保存或放弃源码编辑，再调整章节结构。');
    const preview = await window.mermarkd.previewSectionStructure(operation);
    if (preview.status !== 'ready') throw new Error(preview.rejection?.message ?? '章节结构没有变化。');
    setCanvasStructurePreview(preview);
    setActiveMode('editor'); window.scrollTo({ top: 0 });
  }, [editorController]);

  const cancelCanvasStructure = useCallback(() => {
    const token = canvasStructurePreview?.token;
    if (token) void window.mermarkd.cancelSectionStructure(token).catch(() => undefined);
    setCanvasStructurePreview(null);
    setMessage('结构预览已取消，卡片位置与原文件保持不变。');
  }, [canvasStructurePreview]);

  const openDocumentRecovery = useCallback(async () => {
    setRecoveryOpen(true); setRecoveryBusy(true); setRecoveryError(null); setRecoveryPreview(null);
    try { setRecoveryItems(await window.mermarkd.listDocumentRecovery()); }
    catch { setRecoveryError('恢复记录暂时无法载入；可以选择同目录的 .journal.json 文件重新核验。'); }
    finally { setRecoveryBusy(false); }
  }, []);
  const previewDocumentRecovery = useCallback(async (id?: string) => {
    setRecoveryBusy(true); setRecoveryError(null);
    try {
      const preview = id ? await window.mermarkd.previewDocumentRecovery(id) : await window.mermarkd.selectDocumentRecovery();
      if (preview) setRecoveryPreview(preview);
    } catch { setRecoveryError('恢复记录无法安全核验，请保留原文件和快照后重新检查。'); }
    finally { setRecoveryBusy(false); }
  }, []);
  const closeDocumentRecovery = useCallback(() => {
    if (recoveryBusy) return;
    if (recoveryPreview) void window.mermarkd.cancelDocumentRecovery(recoveryPreview.token).catch(() => undefined);
    setRecoveryOpen(false); setRecoveryPreview(null);
  }, [recoveryBusy, recoveryPreview]);
  const confirmDocumentRecovery = useCallback(async () => {
    if (!recoveryPreview || recoveryBusy) return;
    setRecoveryBusy(true); setRecoveryError(null);
    try {
      const result = await window.mermarkd.confirmDocumentRecovery(recoveryPreview.token);
      if (result.status === 'recovered') {
        setRecoveryOpen(false); setRecoveryPreview(null); showOpenedDocument(result.document); setMessage(result.message);
      } else setRecoveryError(result.message);
    } catch { setRecoveryError('恢复尚未完成，请保留快照并重新检查。'); }
    finally { setRecoveryBusy(false); }
  }, [recoveryBusy, recoveryPreview, showOpenedDocument]);

  return (
    <AppShell document={openedDocument} activeMode={activeMode} dirty={dirtyPreview}
      opening={opening || editorController.opening} dropActive={dropActive} notice={notice}
      recentDocuments={recentDocuments}
      leftSidebarOpen={leftSidebarOpen} rightSidebarOpen={rightSidebarOpen} focusMode={focusMode}
      onNewDocument={() => void newMarkdown()}
      onOpenRecent={(documentPath) => void openRecentMarkdown(documentPath)}
      onRemoveRecent={(documentPath) => void removeRecentMarkdown(documentPath)}
      onToggleLeftSidebar={() => { setLeftSidebarOpen((open) => !open); setRightSidebarOpen(false); }}
      onToggleRightSidebar={() => { setRightSidebarOpen((open) => !open); setLeftSidebarOpen(false); }}
      onToggleFocusMode={() => { setFocusMode((open) => !open); setLeftSidebarOpen(false); setRightSidebarOpen(false); }}
      sourceChangeMessage={!dirtyPreview && annotationView?.canReloadSource
        ? annotationView.reason ?? '原 Markdown 已在外部修改，请重新载入后继续。' : null}
      search={{ open: readerSearchOpen, query: readerSearchQuery,
        currentIndex: readerSearchIndex, total: readerSearchCount, truncated: readerSearchTruncated }}
      onOpen={() => void openMarkdown()} onModeChange={(mode) => void changeMode(mode)}
      onDocumentRecovery={() => void openDocumentRecovery()}
      onReloadSource={() => void reloadMarkdown()}
      onOpenSearch={openReaderSearch} onCloseSearch={closeReaderSearch}
      onSearchQueryChange={setReaderSearchQuery}
      onSearchNext={() => moveReaderSearch(1)} onSearchPrevious={() => moveReaderSearch(-1)}
      onDismissNotice={() => setMessage(null)}
      onDropTargetEnter={onDropTargetEnter} onDropTargetOver={onDropTargetOver}
      onDropTargetLeave={onDropTargetLeave} onDropTargetDrop={onDropTargetDrop}>
      {recoveryOpen && <DocumentRecoveryView items={recoveryItems} preview={recoveryPreview} busy={recoveryBusy} error={recoveryError}
        onPreview={(id) => void previewDocumentRecovery(id)} onSelect={() => void previewDocumentRecovery()}
        onConfirm={() => void confirmDocumentRecovery()} onClose={closeDocumentRecovery} />}
      {openedDocument?.recoveryPending && <p className="canvas-warning" role="alert" data-document-recovery-pending="true">
        文档存在未完成保存，编辑、批注与画布写入已暂停。请打开“检查保存恢复”核验。</p>}
      {openedDocument && editorController.editor && <div hidden={activeMode !== 'editor'}>
        <EditorView documentKey={editorController.editor.epoch} documentName={openedDocument.name}
          active={activeMode === 'editor' && !recoveryOpen}
          value={editorText} sourceFormat={editorController.editor.sourceFormat}
          dirty={editorController.editor.dirty} saving={editorController.busy}
          readOnly={!editorController.editor.editable}
          readOnlyReason={editorController.editor.readOnlyReason}
          saveMessage={editorController.error}
          sections={editorSections}
          activeSectionKey={activeSection === null ? null : String(activeSection)}
          focusOffset={editorFocusRequest > 0 && activeSection !== null ? editorSections.find((section) => section.key === String(activeSection))?.sourceOffset : undefined}
          focusRequestKey={editorFocusRequest}
          recoveryDrafts={editorController.editor.recoveryDrafts}
          recoveryMessage={editorController.editor.recoveryDrafts.length > 0
            ? `${editorController.editor.recoveryDrafts.length} 份恢复草稿等待处理；只有与当前磁盘基线一致的草稿可以直接恢复。` : null}
          recoveringDraft={editorController.busy}
          latestSourceBackupId={editorController.editor.latestSourceBackupId}
          onChange={editorController.changeEditorText}
          sharedEditSession={editorController.editSession}
          onUndo={editorController.undo}
          onRedo={editorController.redo}
          onSave={() => void editorController.save()}
          onRecoverDraft={(id) => void editorController.restoreDraft(id)}
          onDiscardDraft={(id) => void editorController.discardDraft(id)}
          onDiscardChanges={() => { setCanvasStructurePreview(null); void editorController.discardChanges(); }}
          onDiscardSourceBackup={(id) => void editorController.discardSourceBackup(id)}
          canvasStructurePreview={canvasStructurePreview}
          onCancelCanvasStructure={cancelCanvasStructure}
          onConfirmCanvasStructure={async (token, accept) => {
            const accepted = await editorController.confirmStructure(token, accept);
            if (accepted) setCanvasStructurePreview(null);
            return accepted;
          }} />
      </div>}
      {!openedDocument ? (
        <StartPage opening={opening} recentDocuments={recentDocuments} onOpen={() => void openMarkdown()}
          onNew={() => void newMarkdown()} onOpenRecent={(documentPath) => void openRecentMarkdown(documentPath)}
          onRemoveRecent={(documentPath) => void removeRecentMarkdown(documentPath)} />
      ) : activeMode === 'cards' ? (
        <CanvasView document={readerDocument!} dirty={dirtyPreview} activeSection={activeSection}
          onSectionChange={setActiveSection} onEditSection={editCanvasSection} onStructurePreview={previewCanvasStructure} />
      ) : activeMode === 'editor' ? editorController.editor ? null : (
        <main className="source-editor-loading" role="status">正在准备源码编辑器…</main>
      ) : (
        <ReaderView sectionTree={sectionTree!} sectionIds={sectionIds} activeSection={activeSection}
          annotationsOpen={!dirtyPreview && annotationPanelOpen} onJumpToSection={jumpToSection}>
          <main className="reading-main">
            <div className="document-kicker">MARKDOWN 文档</div>
            <div className="document-heading-row">
              <h1 className="document-name">{openedDocument.name}</h1>
              <span className="read-only-badge">{dirtyPreview ? '未保存预览' : '只读'}</span>
              {!dirtyPreview && <button ref={annotationToggleRef} type="button" className="annotation-panel-toggle"
                aria-expanded={annotationPanelOpen} aria-controls="annotation-sidebar"
                onClick={() => setAnnotationPanelOpen((open) => !open)}>
                {annotationPanelOpen ? '收起批注' : `批注 ${noteItems.length}`}
              </button>}
            </div>
            {dirtyPreview ? <div className="annotation-summary dirty-preview" role="status" data-dirty-preview="true">
              <strong>未保存阅读预览</strong>
              <span>正文来自当前编辑缓冲区。旧批注不着色，新增、修改、删除与重定位均已暂停。</span>
            </div> : <div className="annotation-summary" role="region" aria-label="批注状态与操作">
              <strong>批注状态</strong>
              {annotationLoading ? <span>正在检查…</span> : annotationView ? <>
                <span>{annotationView.count} 条记录</span>
                {annotationView.unresolvedCount > 0 && <span>{annotationView.unresolvedCount} 条待定位</span>}
                {unpaintableIds.length > 0 && <span className="annotation-warning">{unpaintableIds.length} 条无法核验可见位置，未着色</span>}
                {annotationView.pendingDraftCount > 0 && <span className="annotation-pending">{annotationView.pendingDraftCount} 份草稿尚未写回同目录，暂停修改批注</span>}
                {(annotationView.unreadableDraftCount ?? 0) > 0 && <span className="annotation-warning">其中 {annotationView.unreadableDraftCount} 份草稿无法读取，请检查应用数据目录</span>}
                {annotationView.status === 'read-only' && !annotationView.canReloadSource &&
                  <span className="annotation-warning">只读：{annotationView.reason ?? '批注文件不可安全修改'}</span>}
                {annotationView.status === 'needs-relocation' && <span className="annotation-warning">{annotationView.reason}</span>}
                {annotationView.relocatableCount > 0 && <span>{annotationView.relocatableCount} 条可安全重定位</span>}
                {!annotationView.canReloadSource && <button type="button" className="annotation-inline-action"
                  onClick={() => void refreshAnnotations(documentEpoch.current)}
                  disabled={annotationLoading || Boolean(reattachTargetId)}>重新检查</button>}
                {canStartRelocationAction && (annotationView.status === 'needs-relocation' || annotationView.relocatableCount > 0) &&
                  <button type="button" className="annotation-inline-action" onClick={applyRelocations}>
                    {annotationView.relocatableCount > 0
                      ? `应用 ${annotationView.relocatableCount} 条安全重定位`
                      : '确认当前版本并保留待定位'}
                  </button>}
                {!highlightSupported && <span className="annotation-warning">当前环境不支持正文高亮着色</span>}
              </> : <span className="annotation-warning">{annotationError ?? '尚未读取批注状态'}</span>}
            </div>}
            {unsupportedExtensions.length > 0 && <div className="reading-dialect-notice" role="status">
              <strong>部分扩展按普通文字显示</strong>
              <span>检测到：{unsupportedExtensions.map((kind) => UNSUPPORTED_EXTENSION_NAMES[kind]).join('、')}。</span>
            </div>}
            {dirtyPreview ? <p className="selection-hint">保存源码或放弃编辑后，批注操作会重新启用。</p>
              : reattachTarget ? <div className="reattach-controls" role="region" aria-label="人工重新选择批注位置">
              <div><strong>为待定位批注重新选择</strong><span>旧引文：“{reattachTarget.anchor.displayQuote}”</span></div>
              <button type="button" className="primary" onMouseDown={(event) => event.preventDefault()}
                onClick={confirmReattach} disabled={!canReviewRelocation}>确认所选新位置</button>
              <button type="button" onClick={() => {
                setReattachTargetId(null);
                clearReaderSelection({ clearNative: true, restoreFocus: true });
                setMessage('已取消重新选择，批注文件未修改。');
              }}>取消</button>
            </div> : <p className="selection-hint">选择正文文字后，可直接添加高亮或批注。</p>}
            {selectionChecking && !selectionProbe && <div className="selection-checking" role="status">
              正在检查所选文字…
            </div>}
            {selectionProbe?.ok && selectionToolbarPosition && <div className="selection-toolbar" role="toolbar"
              aria-label="所选文字操作" data-placement={selectionToolbarPosition.placement}
              style={{ top: selectionToolbarPosition.top }} onKeyDown={moveSelectionToolbarFocus}>
              <span className="selection-quote" title={selectionProbe.displayQuote}>
                “{selectionProbe.displayQuote.length > 48
                  ? `${selectionProbe.displayQuote.slice(0, 48)}…` : selectionProbe.displayQuote}”
              </span>
              <span className="selection-meta">{countGraphemes(selectionProbe.displayQuote)} 字</span>
              {!reattachTarget && <div className="selection-toolbar-actions">
                <div className="highlight-palette" role="group" aria-label="高亮所选文字">
                  {HIGHLIGHT_COLORS.map(({ value, name }) => <button key={value} type="button"
                    className="highlight-choice" data-color={value} onMouseDown={(event) => event.preventDefault()}
                    onClick={() => createHighlight(value)} disabled={!canChangeAnnotations || !highlightSupported}
                    aria-label={`用${name}色高亮所选文字`}>
                    <span className="highlight-swatch" aria-hidden="true" />{name}
                  </button>)}
                </div>
                <button type="button" className="add-note-button" onMouseDown={(event) => event.preventDefault()}
                  onClick={() => openNoteComposer()} disabled={!canChangeAnnotations}
                  aria-controls="annotation-sidebar">添加批注</button>
              </div>}
              <button type="button" className="selection-toolbar-close"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => clearReaderSelection({ clearNative: true, restoreFocus: true })}
                aria-label="取消当前选区">×</button>
            </div>}
            {selectionProbe && !selectionProbe.ok && selectionToolbarPosition &&
              <div className="selection-feedback unsupported" role="status"
                data-placement={selectionToolbarPosition.placement} style={{ top: selectionToolbarPosition.top }}>
                <strong>此选区暂不能批注</strong><span>{selectionReasonForReader(selectionProbe.reason)}</span>
                <button type="button" className="selection-toolbar-close"
                  onClick={() => clearReaderSelection({ clearNative: true, restoreFocus: true })}
                  aria-label="关闭选区提示">×</button>
              </div>}
            <span className="sr-only" aria-live="polite">{selectionAnnouncement}</span>
            <div className="document-divider" />
            {readerDocument!.content.trim() ? <article className="markdown-body" aria-label="Markdown 正文" tabIndex={0}
              onContextMenu={openReaderContextMenu} onKeyDown={handleReaderContextShortcut}>
              <Markdown remarkPlugins={[remarkGfm, remarkFrontmatter, remarkReadingDangerousHtmlPolicy]}
                rehypePlugins={[rehypeRaw, rehypeReadingHtmlPolicy, [rehypeSanitize, readingSanitizeSchema]]}
                components={components}>
                {readerDocument!.content.startsWith('\uFEFF')
                  ? readerDocument!.content.slice(1)
                  : readerDocument!.content}
              </Markdown>
            </article> : <div className="empty-document"><h2>这份文档目前没有内容</h2><p>可以打开另一份 Markdown 文件继续阅读。</p></div>}
            {readerContextMenu && <div ref={readerContextMenuRef} className="editor-context-menu reader-context-menu" role="menu" aria-label="正文选区操作" data-reader-context-menu="true" tabIndex={-1}
              style={{ left: readerContextMenu.left, top: readerContextMenu.top }} onPointerDown={(event) => event.stopPropagation()} onKeyDown={handleReaderContextMenuKeyDown}>
              <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()}
                onClick={() => void copyReaderContextSelection()}>复制正文</button>
              <span className="editor-context-separator" role="separator" />
              <span className="reader-context-label">格式</span>
              {([
                ['bold', '加粗'],
                ['italic', '斜体'],
                ['quote', '引用'],
              ] as const).map(([action, label]) => {
                const enabled = canApplyReaderFormat(action, readerContextMenu);
                return <button key={action} type="button" role="menuitem" disabled={!enabled}
                  title={enabled ? undefined : '仅支持单个可逆 Markdown 文字片段'}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    const probe = readerContextMenu.probe;
                    closeReaderContextMenu();
                    void applyReaderContextFormat(action, probe);
                  }}>{label}</button>;
              })}
              <span className="editor-context-separator" role="separator" />
              <span className="reader-context-label">高亮选区</span>
              <div className="reader-context-palette" role="group" aria-label="选择高亮颜色">
                {HIGHLIGHT_COLORS.map(({ value, name }) => <button key={value} type="button" role="menuitem"
                  className="reader-context-color" data-color={value} aria-label={`用${name}色高亮所选正文`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => { const probe = readerContextMenu.probe; closeReaderContextMenu(); createHighlight(value, probe); }}
                  disabled={!canChangeAnnotations || !highlightSupported}><span className="highlight-swatch" aria-hidden="true" />{name}</button>)}
              </div>
              <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()}
                onClick={() => { const probe = readerContextMenu.probe; closeReaderContextMenu(); openNoteComposer(probe); }} disabled={!canChangeAnnotations}>添加批注</button>
              <span className="reader-context-note">复杂选区请切到源码视图编辑</span>
            </div>}
          </main>
          {!dirtyPreview && annotationPanelOpen && <>
            <button type="button" className="annotation-drawer-backdrop" aria-label="关闭批注栏"
              onClick={() => { setAnnotationPanelOpen(false); annotationToggleRef.current?.focus(); }} />
            <aside ref={annotationSidebarRef} id="annotation-sidebar" className="annotation-sidebar"
              aria-label="批注边栏" aria-labelledby="annotation-sidebar-title"
              role={narrowLayout ? 'dialog' : undefined} aria-modal={narrowLayout ? true : undefined} tabIndex={-1}>
              <div className="annotation-sidebar-inner">
                <header className="annotation-sidebar-header">
                  <div><h2 id="annotation-sidebar-title">批注</h2><span>{noteItems.length} 条便签</span></div>
                  <button ref={annotationCloseRef} type="button" className="annotation-close" aria-label="关闭批注栏"
                    onClick={() => { setAnnotationPanelOpen(false); annotationToggleRef.current?.focus(); }}>×</button>
                </header>

                {noteComposer && <form className="note-composer" onSubmit={createNote}>
                  <div className="note-form-heading">为选文添加批注</div>
                  <blockquote>{noteComposer.quote}</blockquote>
                  <label htmlFor="new-note-body">批注内容</label>
                  <textarea id="new-note-body" ref={noteComposerRef} rows={5} value={noteDraft}
                    disabled={!canChangeAnnotations}
                    onChange={(event) => setNoteDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }} placeholder="写下这段文字带来的想法…" />
                  <label htmlFor="new-note-tag">标签</label>
                  <select id="new-note-tag" value={noteTagChoice} disabled={!canChangeAnnotations}
                    onChange={(event) => setNoteTagChoice(event.target.value)}>
                    <option value={NO_TAG}>无标签</option>
                    {tags.map((tag) => <option key={tag.id} value={`${TAG_VALUE_PREFIX}${tag.id}`}>{tag.name}</option>)}
                    <option value={NEW_TAG}>新建标签…</option>
                  </select>
                  {noteTagChoice === NEW_TAG && <>
                    <label htmlFor="new-note-tag-name">新标签名称</label>
                    <input id="new-note-tag-name" value={newTagName} disabled={!canChangeAnnotations}
                      onChange={(event) => setNewTagName(event.target.value)} />
                  </>}
                  <div className="note-form-actions">
                    <button type="button" onClick={() => setNoteComposer(null)}>取消</button>
                    <button type="submit" className="primary" disabled={!canChangeAnnotations || !noteDraft.trim() ||
                      (noteTagChoice === NEW_TAG && !newTagName.trim())}>
                      {annotationSaving ? '正在保存…' : '保存批注'}
                    </button>
                  </div>
                  <span className="keyboard-hint">Ctrl+Enter 保存</span>
                </form>}

                <section className="note-records" aria-labelledby="note-records-heading">
                  <div className="note-records-toolbar">
                    <h3 id="note-records-heading">便签记录</h3>
                    <div className="note-summary-actions">
                      <label><span>筛选</span><select value={noteFilter} onChange={(event) => setNoteFilter(event.target.value)}>
                        <option value="all">全部</option>
                        <option value="untagged">无标签</option>
                        {tags.map((tag) => <option key={tag.id} value={`${TAG_VALUE_PREFIX}${tag.id}`}>{tag.name}</option>)}
                      </select></label>
                      <button type="button" onClick={() => void copySummary()}
                        disabled={!annotationView?.canCopySummary || summaryCopying}
                        title="按当前标签筛选并按章节复制 Markdown 摘要">
                        {summaryCopying ? '复制中…' : '复制摘要'}
                      </button>
                    </div>
                  </div>
                  {filteredNotes.length ? <ol className="note-list">{filteredNotes.map((item) => {
                    const available = item.status === 'resolved' && !unpaintableSet.has(item.id) &&
                      paintedRanges.current.has(item.id);
                    const locationLabel = item.status !== 'resolved' ? relocationLabel(item.relocation)
                      : unpaintableSet.has(item.id) ? '无法安全显示' : '正在定位';
                    const selected = selectedAnnotationId === item.id;
                    const editing = editingNoteId === item.id;
                    const tagName = item.tagId ? tagById.get(item.tagId) : undefined;
                    return <li key={item.id} className={selected ? 'note-card selected' : 'note-card'}>
                      <div className="note-card-topline">
                        {item.color && <span className="highlight-record-swatch" data-color={item.color} aria-label="保留的高亮颜色" />}
                        <button type="button" className="note-quote" onClick={() => jumpToAnnotation(item.id)}
                          disabled={!available} aria-pressed={selected}
                          title={available ? '跳转到原文' : `${locationLabel}，暂不跳转`}>
                          “{item.anchor.displayQuote}”
                        </button>
                        {!available && <span className="note-location-state">{locationLabel}</span>}
                      </div>
                      {editing ? <form className="note-edit-form" onSubmit={(event) => updateNote(event, item.id)}>
                        <label htmlFor={`note-body-${item.id}`}>批注内容</label>
                        <textarea id={`note-body-${item.id}`} rows={5} value={editNoteDraft}
                          disabled={!canChangeAnnotations}
                          onChange={(event) => setEditNoteDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                              event.preventDefault();
                              event.currentTarget.form?.requestSubmit();
                            }
                          }} />
                        <label htmlFor={`note-tag-${item.id}`}>标签</label>
                        <select id={`note-tag-${item.id}`} value={editTagChoice} disabled={!canChangeAnnotations}
                          onChange={(event) => setEditTagChoice(event.target.value)}>
                          <option value={NO_TAG}>无标签</option>
                          {tags.map((tag) => <option key={tag.id} value={`${TAG_VALUE_PREFIX}${tag.id}`}>{tag.name}</option>)}
                          <option value={NEW_TAG}>新建标签…</option>
                        </select>
                        {editTagChoice === NEW_TAG && <>
                          <label htmlFor={`note-new-tag-${item.id}`}>新标签名称</label>
                          <input id={`note-new-tag-${item.id}`} value={editNewTagName} disabled={!canChangeAnnotations}
                            onChange={(event) => setEditNewTagName(event.target.value)} />
                        </>}
                        <div className="note-form-actions">
                          <button type="button" onClick={() => setEditingNoteId(null)}>取消</button>
                          <button type="submit" className="primary" disabled={!canChangeAnnotations || !editNoteDraft.trim() ||
                            (editTagChoice === NEW_TAG && !editNewTagName.trim())}>保存</button>
                        </div>
                      </form> : <>
                        {tagName && <span className="note-tag">{tagName}</span>}
                        <p className="note-body">{item.note}</p>
                        <div className="note-card-actions">
                          {item.status !== 'resolved' && <button type="button" onClick={() => beginReattach(item.id)}
                            disabled={!canStartRelocationAction}>重新选择</button>}
                          <button type="button" onClick={() => beginEditNote(item.id)} disabled={!canChangeAnnotations || !available}>编辑</button>
                          <button type="button" onClick={() => deleteNote(item.id)} disabled={!canChangeAnnotations || !available}>删除</button>
                        </div>
                      </>}
                    </li>;
                  })}</ol> : <p className="notes-empty">{noteItems.length ? '当前筛选下没有批注。' : '选中文字并选择“添加批注”开始记录。'}</p>}
                </section>

                <details className="highlight-records">
                  <summary>高亮记录 <span>{highlightItems.length}</span></summary>
                  {highlightItems.length ? <ol className="highlight-list">{highlightItems.map((item) => {
                    const available = item.status === 'resolved' && !unpaintableSet.has(item.id) &&
                      paintedRanges.current.has(item.id);
                    const locationLabel = item.status !== 'resolved' ? relocationLabel(item.relocation)
                      : unpaintableSet.has(item.id) ? '无法安全显示' : '正在定位';
                    return <li key={item.id} className={selectedAnnotationId === item.id ? 'selected' : undefined}>
                      <span className="highlight-record-swatch" data-color={item.color} aria-hidden="true" />
                      <button type="button" className="highlight-jump" onClick={() => jumpToAnnotation(item.id)}
                        disabled={!available} aria-pressed={selectedAnnotationId === item.id}
                        title={available ? '跳转到原文' : `${locationLabel}，暂不跳转`}>{item.anchor.displayQuote}</button>
                      {!available && <span className="highlight-unresolved">{locationLabel}</span>}
                      {item.status !== 'resolved' && <button type="button" className="highlight-reattach"
                        onClick={() => beginReattach(item.id)} disabled={!canStartRelocationAction}>重新选择</button>}
                      <select value={item.color ?? 'amber'} aria-label={`更改“${item.anchor.displayQuote}”的高亮颜色`}
                        disabled={!canChangeAnnotations || !available}
                        onChange={(event) => recolorHighlight(item.id, event.target.value as AnnotationColor)}>
                        {HIGHLIGHT_COLORS.map(({ value, name }) => <option key={value} value={value}>{name}</option>)}
                      </select>
                      <button type="button" className="highlight-delete" onClick={() => deleteHighlight(item.id)}
                        disabled={!canChangeAnnotations || !available} aria-label={`删除“${item.anchor.displayQuote}”的高亮`}>删除</button>
                    </li>;
                  })}</ol> : <p>还没有单独的高亮。</p>}
                </details>
              </div>
            </aside>
          </>}
        </ReaderView>
      )}
    </AppShell>
  );
}

createRoot(window.document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
