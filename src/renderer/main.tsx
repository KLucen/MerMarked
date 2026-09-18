import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps, CSSProperties, DragEvent as ReactDragEvent, MouseEvent } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import type { Components, ExtraProps } from 'react-markdown';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import { extractSections } from '../core/sections';
import { buildSelectionMap, resolveSelection, resolveStoredHighlight } from '../core/selection-map';
import type { AnnotationColor } from '../core/annotations';
import type { AnnotationDocumentView, AnnotationSaveResult, OpenedMarkdownDocument } from '../types/reader-api';
import './style.css';

type SelectionProbeResult = ReturnType<typeof resolveSelection>;

const HIGHLIGHT_COLORS: ReadonlyArray<{ value: AnnotationColor; name: string }> = [
  { value: 'amber', name: '琥珀' },
  { value: 'sage', name: '鼠尾草' },
  { value: 'blue', name: '浅蓝' },
  { value: 'rose', name: '浅玫瑰' },
];
const HIGHLIGHT_NAMES = HIGHLIGHT_COLORS.flatMap(({ value }) => [
  `mermarkd-${value}`, `mermarkd-selected-${value}`,
]);

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

function slugify(title: string): string {
  return title.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
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

function App() {
  const [openedDocument, setOpenedDocument] = useState<OpenedMarkdownDocument | null>(null);
  const [opening, setOpening] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<number | null>(null);
  const [selectionProbe, setSelectionProbe] = useState<SelectionProbeResult | null>(null);
  const [annotationView, setAnnotationView] = useState<AnnotationDocumentView | null>(null);
  const [annotationLoading, setAnnotationLoading] = useState(false);
  const [annotationSaving, setAnnotationSaving] = useState(false);
  const [annotationError, setAnnotationError] = useState<string | null>(null);
  const [selectedHighlightId, setSelectedHighlightId] = useState<string | null>(null);
  const [unpaintableIds, setUnpaintableIds] = useState<readonly string[]>([]);
  const [highlightSupported, setHighlightSupported] = useState(true);
  const [dropActive, setDropActive] = useState(false);
  const dropDepth = useRef(0);
  const documentEpoch = useRef(0);
  const paintedRanges = useRef(new Map<string, Range>());
  const mutationInFlight = useRef(false);

  const sectionTree = useMemo(
    () => openedDocument ? extractSections(openedDocument.content) : null,
    [openedDocument],
  );
  const selectionMap = useMemo(
    () => openedDocument ? buildSelectionMap(openedDocument.content, openedDocument.bomByteLength) : null,
    [openedDocument],
  );
  const sectionIds = useMemo(() => {
    if (!sectionTree) return [];
    const used = new Set<string>();
    return sectionTree.sections.map((section) => {
      const base = slugify(section.title) || 'section';
      let candidate = base;
      let suffix = 1;
      while (used.has(candidate)) {
        candidate = `${base}-${suffix}`;
        suffix += 1;
      }
      used.add(candidate);
      return candidate;
    });
  }, [sectionTree]);
  const headingByOffset = useMemo(() => {
    const result = new Map<number, number>();
    const bomOffset = openedDocument?.content.startsWith('\uFEFF') ? 1 : 0;
    sectionTree?.sections.forEach((section) => result.set(section.headingRange.start - bomOffset, section.index));
    return result;
  }, [openedDocument, sectionTree]);

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

  const showOpenedDocument = useCallback((opened: OpenedMarkdownDocument) => {
    const epoch = ++documentEpoch.current;
    setOpenedDocument(opened);
    setActiveSection(null);
    setSelectionProbe(null);
    setAnnotationView(null);
    setSelectedHighlightId(null);
    setUnpaintableIds([]);
    setAnnotationSaving(false);
    window.scrollTo({ top: 0 });
    void refreshAnnotations(epoch);
  }, [refreshAnnotations]);

  useEffect(() => {
    const registry = highlightRegistry();
    const article = document.querySelector<HTMLElement>('.markdown-body');
    paintedRanges.current.clear();
    HIGHLIGHT_NAMES.forEach((name) => registry?.delete(name));
    if (!registry) {
      setHighlightSupported(false);
      setUnpaintableIds([]);
      return;
    }
    setHighlightSupported(true);
    const groups = new Map<string, Range[]>();
    const failures: string[] = [];
    if (article && selectionMap && annotationView) {
      const blockElements = new Map<number, HTMLElement>();
      article.querySelectorAll<HTMLElement>('[data-source-block-start]').forEach((element) => {
        blockElements.set(Number(element.dataset.sourceBlockStart), element);
      });
      const sourceBlocks = new Map(selectionMap.blocks.map((block) => [block.blockStart, block]));
      for (const item of annotationView.items) {
        if (item.kind !== 'highlight' || item.status !== 'resolved') continue;
        if (!item.color || !HIGHLIGHT_COLORS.some(({ value }) => value === item.color)) {
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
        const name = item.id === selectedHighlightId
          ? `mermarkd-selected-${item.color}` : `mermarkd-${item.color}`;
        const group = groups.get(name) ?? [];
        group.push(range);
        groups.set(name, group);
      }
    }
    for (const [name, ranges] of groups) {
      const highlight = new Highlight(...ranges);
      const colorIndex = HIGHLIGHT_COLORS.findIndex(({ value }) => name.endsWith(value));
      highlight.priority = name.includes('selected') ? 10 : colorIndex;
      registry.set(name, highlight);
    }
    setUnpaintableIds(failures);
    return () => {
      HIGHLIGHT_NAMES.forEach((name) => registry.delete(name));
      paintedRanges.current.clear();
    };
  }, [annotationView, openedDocument?.path, openedDocument?.sourceSha256, selectedHighlightId, selectionMap]);

  const openMarkdown = useCallback(async () => {
    setOpening(true);
    setMessage(null);
    try {
      const opened = await window.mermarkd.openMarkdown();
      if (opened) showOpenedDocument(opened);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '打开文档失败，请重试。');
    } finally {
      setOpening(false);
    }
  }, [showOpenedDocument]);

  const openDroppedMarkdown = useCallback(async (file: File) => {
    if (opening) return;
    setOpening(true);
    setMessage(null);
    try {
      const opened = await window.mermarkd.openDroppedMarkdown(file);
      showOpenedDocument(opened);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '拖入文档失败，请重试。');
    } finally {
      setOpening(false);
    }
  }, [opening, showOpenedDocument]);

  const onDropTargetEnter = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dropDepth.current += 1;
    setDropActive(true);
  }, []);

  const onDropTargetOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDropActive(true);
  }, []);

  const onDropTargetLeave = useCallback(() => {
    if (dropDepth.current === 0) return;
    dropDepth.current = Math.max(0, dropDepth.current - 1);
    if (dropDepth.current === 0) setDropActive(false);
  }, []);

  const onDropTargetDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dropDepth.current = 0;
    setDropActive(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) {
      setMessage('请一次只拖入一份 .md 文件。');
      return;
    }
    const file = files[0];
    if (!file.name.toLowerCase().endsWith('.md')) {
      setMessage('请选择 .md 文件。');
      return;
    }
    void openDroppedMarkdown(file);
  }, [openDroppedMarkdown]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        if (!opening) void openMarkdown();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openMarkdown, opening]);

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

  const jumpToSection = useCallback((index: number) => {
    const id = sectionIds[index];
    const target = id ? window.document.getElementById(id) : null;
    if (!target) return;
    setActiveSection(index);
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.focus({ preventScroll: true });
  }, [sectionIds]);

  const openLink = useCallback((event: MouseEvent<HTMLAnchorElement>, href: string | undefined) => {
    event.preventDefault();
    if (!href) return;
    if (href.startsWith('#')) {
      try {
        const target = window.document.getElementById(decodeURIComponent(href.slice(1)));
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          target.focus({ preventScroll: true });
          setMessage(null);
        } else setMessage('未找到文档内的目标章节。');
      } catch {
        setMessage('此章节链接无效。');
      }
      return;
    }
    if (isExternalUrl(href)) {
      void window.mermarkd.openExternal(href)
        .then((opened) => { if (!opened) setMessage('无法打开此链接。'); })
        .catch(() => setMessage('无法打开此链接。'));
      return;
    }
    setMessage('当前版本暂不支持打开文档中的相对链接。');
  }, []);

  const readSelection = useCallback((): SelectionProbeResult => {
    const selection = window.getSelection();
    const article = window.document.querySelector<HTMLElement>('.markdown-body');
    if (!selectionMap || !article || !selection || selection.rangeCount !== 1 || selection.isCollapsed) {
      return { ok: false, reason: '请先在正文中选择一段文字。' };
    }

    const range = selection.getRangeAt(0);
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

  const runHighlightMutation = useCallback(async (
    action: () => Promise<AnnotationSaveResult>,
    successMessage: string,
    afterSaved?: (result: AnnotationSaveResult) => void,
  ) => {
    if (annotationView?.status !== 'ready' || annotationView.pendingDraftCount > 0 ||
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
        setSelectionProbe(null);
        setMessage(result.draftPath
          ? `文件已发生变化，未覆盖批注文件。待处理草稿：${result.draftPath}`
          : result.reason ?? '批注状态已变化，请重新打开文档后再试。');
      } else {
        setSelectionProbe(null);
        setMessage(`批注尚未写回同目录。待保存草稿：${result.draftPath ?? '应用数据目录'}`);
      }
    } catch (error) {
      if (documentEpoch.current === epoch) {
        setMessage(error instanceof Error ? error.message : '保存高亮失败。');
      }
    } finally {
      mutationInFlight.current = false;
      if (documentEpoch.current === epoch) setAnnotationSaving(false);
    }
  }, [annotationLoading, annotationView, refreshAnnotations]);

  const createHighlight = useCallback((color: AnnotationColor) => {
    const selectionProbe = readSelection();
    setSelectionProbe(selectionProbe);
    if (!selectionProbe.ok) return;
    const selection = {
      startByte: selectionProbe.startByte,
      endByte: selectionProbe.endByte,
      sourceExact: selectionProbe.sourceExact,
      displayQuote: selectionProbe.displayQuote,
    };
    void runHighlightMutation(
      () => window.mermarkd.createHighlight({ selection, color }),
      '高亮已保存到批注 sidecar，Markdown 原文未修改。',
      (result) => {
        setSelectionProbe(null);
        setSelectedHighlightId(result.id ?? null);
        window.getSelection()?.removeAllRanges();
      },
    );
  }, [readSelection, runHighlightMutation]);

  const recolorHighlight = useCallback((id: string, color: AnnotationColor) => {
    void runHighlightMutation(
      () => window.mermarkd.recolorHighlight({ id, color }),
      '高亮颜色已更新。',
    );
  }, [runHighlightMutation]);

  const deleteHighlight = useCallback((id: string) => {
    void runHighlightMutation(
      () => window.mermarkd.deleteHighlight(id),
      '高亮已删除。',
      () => { if (selectedHighlightId === id) setSelectedHighlightId(null); },
    );
  }, [runHighlightMutation, selectedHighlightId]);

  const jumpToHighlight = useCallback((id: string) => {
    const range = paintedRanges.current.get(id);
    if (!range) return;
    setSelectedHighlightId(id);
    const rect = range.getBoundingClientRect();
    window.scrollBy({ top: rect.top - Math.min(window.innerHeight * .3, 180), behavior: 'smooth' });
  }, []);

  const heading = useCallback((tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6', props: ComponentProps<'h1'> & ExtraProps) => {
    const { node, children, ...rest } = props;
    const index = node?.position?.start.offset === undefined ? undefined : headingByOffset.get(node.position.start.offset);
    const id = index === undefined ? undefined : sectionIds[index];
    const Tag = tag;
    return <Tag {...rest} id={id} tabIndex={id ? -1 : undefined}
      data-source-block-start={node?.position?.start.offset}>{children}</Tag>;
  }, [headingByOffset, sectionIds]);

  const components = useMemo<Components>(() => ({
    h1: (props) => heading('h1', props),
    h2: (props) => heading('h2', props),
    h3: (props) => heading('h3', props),
    h4: (props) => heading('h4', props),
    h5: (props) => heading('h5', props),
    h6: (props) => heading('h6', props),
    p: ({ node, children, ...props }) => (
      <p {...props} data-source-block-start={node?.position?.start.offset}>{children}</p>
    ),
    table: ({ node: _node, children, ...props }) => (
      <div className="table-scroll" role="region" aria-label="表格，可水平滚动" tabIndex={0}>
        <table {...props}>{children}</table>
      </div>
    ),
    a: ({ node: _node, href, children, ...props }) => (
      <a {...props} href={href} onClick={(event) => openLink(event, href)}>{children}</a>
    ),
    img: ({ node: _node, src, alt }) => (
      <LocalImage src={src} alt={alt} documentPath={openedDocument?.path ?? ''} />
    ),
    input: ({ node: _node, ...props }) => <input {...props} disabled readOnly />,
  }), [openedDocument?.path, heading, openLink]);

  const highlightItems = annotationView?.items.filter((item) => item.kind === 'highlight') ?? [];
  const unpaintableSet = new Set(unpaintableIds);
  const canChangeHighlights = annotationView?.status === 'ready' &&
    annotationView.pendingDraftCount === 0 && !annotationSaving && !annotationLoading;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="MerMarkd"><span className="brand-mark" aria-hidden="true">M</span><span className="brand-name">MerMarkd</span></div>
        <div className="file-meta">
          <strong className="file-name" title={openedDocument?.path}>{openedDocument?.name ?? '未打开文档'}</strong>
          <span className="file-status">{openedDocument ? '只读 · 未修改' : '本地 Markdown 阅读器'}</span>
        </div>
        <div className={dropActive ? 'open-drop-target active' : 'open-drop-target'}
          data-markdown-drop-target="true" onDragEnter={onDropTargetEnter} onDragOver={onDropTargetOver}
          onDragLeave={onDropTargetLeave} onDrop={onDropTargetDrop}>
          <span className="drop-hint" aria-hidden="true">{dropActive ? '松开打开 .md' : '拖入 .md'}</span>
          <button className="open-button" type="button" onClick={() => void openMarkdown()} disabled={opening}>
            {opening ? '正在打开…' : '打开 Markdown'}<span className="shortcut" aria-hidden="true">Ctrl+O</span>
          </button>
        </div>
      </header>
      <nav className="modebar" aria-label="视图模式">
        <span className="mode-tab current" aria-current="page">阅读模式</span>
        <span className="mode-tab unavailable" title="将在后续批次实现">编辑模式 · 即将推出</span>
        <span className="mode-tab unavailable" title="将在后续批次实现">卡片模式 · 即将推出</span>
      </nav>
      {message && <div className="notice" role="alert"><span>{message}</span><button type="button" onClick={() => setMessage(null)} aria-label="关闭提示">×</button></div>}

      {!openedDocument ? (
        <main className="welcome">
          <div className="welcome-icon" aria-hidden="true">#</div>
          <h1>从一份 Markdown 开始</h1>
          <p>打开本地 .md 文件，阅读排版后的正文，并通过目录快速定位章节。</p>
          <button className="welcome-open" type="button" onClick={() => void openMarkdown()} disabled={opening}>{opening ? '正在打开…' : '选择 Markdown 文件'}</button>
          <span className="welcome-note">文件以只读方式载入，本次阅读不会修改原文。</span>
        </main>
      ) : (
        <div className="reading-layout">
          <aside className="toc" aria-label="章节目录"><div className="toc-inner">
            <div className="toc-heading">章节目录 <span>{sectionTree?.sections.length ?? 0}</span></div>
            {sectionTree?.sections.length ? <nav aria-label="文档章节"><ol className="toc-list">
              {sectionTree.sections.map((section) => {
                let level = 0;
                let parent = section.parentIndex;
                while (parent !== null) { level += 1; parent = sectionTree.sections[parent].parentIndex; }
                return <li key={section.index} style={{ '--toc-level': Math.min(level, 5) } as CSSProperties}>
                  <button type="button" className={activeSection === section.index ? 'toc-link active' : 'toc-link'}
                    onClick={() => jumpToSection(section.index)} aria-current={activeSection === section.index ? 'location' : undefined} title={section.title}>
                    <span className="toc-depth">H{section.depth}</span><span className="toc-title">{section.title}</span>
                  </button>
                </li>;
              })}
            </ol></nav> : <p className="toc-empty">这份文档没有章节标题。</p>}
          </div></aside>
          <main className="reading-main">
            <div className="document-kicker">MARKDOWN 文档</div>
            <div className="document-heading-row"><h1 className="document-name">{openedDocument.name}</h1><span className="read-only-badge">只读</span></div>
            <div className="annotation-summary" role="status">
              <strong>批注 sidecar</strong>
              {annotationLoading ? <span>正在检查…</span> : annotationView ? <>
                <span>{annotationView.count} 条记录</span>
                {annotationView.unresolvedCount > 0 && <span>{annotationView.unresolvedCount} 条待定位</span>}
                {unpaintableIds.length > 0 && <span className="annotation-warning">{unpaintableIds.length} 条无法核验可见位置，未着色</span>}
                {annotationView.pendingDraftCount > 0 && <span className="annotation-pending">{annotationView.pendingDraftCount} 份草稿尚未写回同目录，暂停修改高亮</span>}
                {(annotationView.unreadableDraftCount ?? 0) > 0 && <span className="annotation-warning">其中 {annotationView.unreadableDraftCount} 份草稿无法读取，请检查应用数据目录</span>}
                {annotationView.status === 'read-only' && <span className="annotation-warning">只读：{annotationView.reason ?? '批注文件不可安全修改'}</span>}
                {!highlightSupported && <span className="annotation-warning">当前环境不支持正文高亮着色</span>}
                <span className="annotation-location" title={annotationView.sidecarPath}>{annotationView.sidecarPath}</span>
              </> : <span className="annotation-warning">{annotationError ?? '尚未读取批注状态'}</span>}
            </div>
            <div className="selection-probe-controls">
              <span>选中文字后选择高亮颜色</span>
              <div className="highlight-palette" role="group" aria-label="高亮所选文字">
                {HIGHLIGHT_COLORS.map(({ value, name }) => <button key={value} type="button"
                  className="highlight-choice" data-color={value} onMouseDown={(event) => event.preventDefault()}
                  onClick={() => createHighlight(value)} disabled={!canChangeHighlights || !highlightSupported}
                  aria-label={`用${name}色高亮所选文字`}>
                  <span className="highlight-swatch" aria-hidden="true" />{name}
                </button>)}
              </div>
              <button type="button" className="selection-check-button" onMouseDown={(event) => event.preventDefault()}
                onClick={() => setSelectionProbe(readSelection())}>检查选区定位</button>
            </div>
            {selectionProbe && <div className="selection-probe-result" role="status">
              {selectionProbe.ok ? <>
                <strong>已定位到原文</strong>
                <span>UTF-8 字节范围 [{selectionProbe.startByte}, {selectionProbe.endByte})</span>
                <span>可见选文：<code>{selectionProbe.displayQuote}</code></span>
                <span>原文片段：<code>{selectionProbe.sourceExact}</code></span>
              </> : <><strong>无法安全定位</strong><span>{selectionProbe.reason}</span></>}
            </div>}
            <details className="highlight-records">
              <summary>高亮记录 <span>{highlightItems.length}</span></summary>
              {highlightItems.length ? <ol className="highlight-list">{highlightItems.map((item) => {
                const available = item.status === 'resolved' && !unpaintableSet.has(item.id) &&
                  paintedRanges.current.has(item.id) && highlightSupported;
                const locationLabel = item.status !== 'resolved' ? '待定位'
                  : !highlightSupported ? '当前环境无法显示'
                    : unpaintableSet.has(item.id) ? '无法安全显示' : '正在定位';
                return <li key={item.id} className={selectedHighlightId === item.id ? 'selected' : undefined}>
                  <span className="highlight-record-swatch" data-color={item.color} aria-hidden="true" />
                  <button type="button" className="highlight-jump" onClick={() => jumpToHighlight(item.id)}
                    disabled={!available} aria-pressed={selectedHighlightId === item.id}
                    title={available ? '跳转到原文' : `${locationLabel}，暂不跳转`}>{item.anchor.displayQuote}</button>
                  {!available && <span className="highlight-unresolved">{locationLabel}</span>}
                  <select value={item.color ?? 'amber'} aria-label={`更改“${item.anchor.displayQuote}”的高亮颜色`}
                    disabled={!canChangeHighlights || !available}
                    onChange={(event) => recolorHighlight(item.id, event.target.value as AnnotationColor)}>
                    {HIGHLIGHT_COLORS.map(({ value, name }) => <option key={value} value={value}>{name}</option>)}
                  </select>
                  <button type="button" className="highlight-delete" onClick={() => deleteHighlight(item.id)}
                    disabled={!canChangeHighlights || !available} aria-label={`删除“${item.anchor.displayQuote}”的高亮`}>删除</button>
                </li>;
              })}</ol> : <p>还没有高亮。选中文字并选择颜色即可创建。</p>}
            </details>
            <div className="document-divider" />
            {openedDocument.content.trim() ? <article className="markdown-body" aria-label="Markdown 正文">
              <Markdown remarkPlugins={[remarkGfm, remarkFrontmatter]} skipHtml components={components}>
                {openedDocument.content.startsWith('\uFEFF') ? openedDocument.content.slice(1) : openedDocument.content}
              </Markdown>
            </article> : <div className="empty-document"><h2>这份文档目前没有内容</h2><p>可以打开另一份 Markdown 文件继续阅读。</p></div>}
          </main>
        </div>
      )}
    </div>
  );
}

createRoot(window.document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
