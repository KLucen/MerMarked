import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps, CSSProperties, DragEvent as ReactDragEvent, MouseEvent } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import type { Components, ExtraProps } from 'react-markdown';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import { extractSections } from '../core/sections';
import { buildSelectionMap, resolveSelection } from '../core/selection-map';
import type { AnnotationSummary, OpenedMarkdownDocument } from '../types/reader-api';
import './style.css';

type SelectionProbeResult = ReturnType<typeof resolveSelection>;

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
  const [annotationSummary, setAnnotationSummary] = useState<AnnotationSummary | null>(null);
  const [annotationLoading, setAnnotationLoading] = useState(false);
  const [annotationSaving, setAnnotationSaving] = useState(false);
  const [annotationError, setAnnotationError] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const dropDepth = useRef(0);
  const documentEpoch = useRef(0);

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

  const refreshAnnotationSummary = useCallback(async (epoch: number) => {
    setAnnotationLoading(true);
    setAnnotationError(null);
    try {
      const summary = await window.mermarkd.loadAnnotationSummary();
      if (documentEpoch.current === epoch) setAnnotationSummary(summary);
    } catch (error) {
      if (documentEpoch.current === epoch) {
        setAnnotationSummary(null);
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
    setAnnotationSummary(null);
    setAnnotationSaving(false);
    window.scrollTo({ top: 0 });
    void refreshAnnotationSummary(epoch);
  }, [refreshAnnotationSummary]);

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

  const probeSelection = useCallback(() => {
    const selection = window.getSelection();
    const article = window.document.querySelector<HTMLElement>('.markdown-body');
    if (!selectionMap || !article || !selection || selection.rangeCount !== 1 || selection.isCollapsed) {
      setSelectionProbe({ ok: false, reason: '请先在正文中选择一段文字。' });
      return;
    }

    const range = selection.getRangeAt(0);
    const startBlock = sourceBlockFor(range.startContainer);
    const endBlock = sourceBlockFor(range.endContainer);
    if (!startBlock || startBlock !== endBlock || !article.contains(startBlock)) {
      setSelectionProbe({ ok: false, reason: '当前原型只支持同一标题或段落内的选区。' });
      return;
    }

    const blockStart = Number(startBlock.dataset.sourceBlockStart);
    const block = selectionMap.blocks.find((candidate) => candidate.blockStart === blockStart);
    if (!block || startBlock.textContent !== block.visibleText) {
      setSelectionProbe({ ok: false, reason: '渲染文字与源码映射不一致，已拒绝定位。' });
      return;
    }

    try {
      const prefix = window.document.createRange();
      prefix.setStart(startBlock, 0);
      prefix.setEnd(range.startContainer, range.startOffset);
      const visibleStart = prefix.toString().length;
      const visibleEnd = visibleStart + range.toString().length;
      if (block.visibleText.slice(visibleStart, visibleEnd) !== range.toString()) {
        setSelectionProbe({ ok: false, reason: '选中文字与源码映射不一致，已拒绝定位。' });
        return;
      }
      setSelectionProbe(resolveSelection(selectionMap, blockStart, visibleStart, visibleEnd));
    } catch {
      setSelectionProbe({ ok: false, reason: '无法读取当前选区，请重新选择文字。' });
    }
  }, [selectionMap]);

  const saveSelectionProbe = useCallback(async () => {
    if (!selectionProbe?.ok || annotationSummary?.status !== 'ready' ||
        annotationSummary.pendingDraftCount > 0 || annotationSaving) return;
    const epoch = documentEpoch.current;
    setAnnotationSaving(true);
    setMessage(null);
    try {
      const result = await window.mermarkd.saveSelectionProbe({
        startByte: selectionProbe.startByte,
        endByte: selectionProbe.endByte,
        sourceExact: selectionProbe.sourceExact,
        displayQuote: selectionProbe.displayQuote,
      });
      if (documentEpoch.current !== epoch) return;
      await refreshAnnotationSummary(epoch);
      if (result.status === 'saved') {
        setSelectionProbe(null);
        setMessage('测试高亮锚点已保存到同目录的批注 sidecar。');
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
        setMessage(error instanceof Error ? error.message : '保存测试高亮锚点失败。');
      }
    } finally {
      if (documentEpoch.current === epoch) setAnnotationSaving(false);
    }
  }, [annotationSaving, annotationSummary, refreshAnnotationSummary, selectionProbe]);

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
    a: ({ node: _node, href, children, ...props }) => (
      <a {...props} href={href} onClick={(event) => openLink(event, href)}>{children}</a>
    ),
    img: ({ node: _node, src, alt }) => (
      <LocalImage src={src} alt={alt} documentPath={openedDocument?.path ?? ''} />
    ),
    input: ({ node: _node, ...props }) => <input {...props} disabled readOnly />,
  }), [openedDocument?.path, heading, openLink]);

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
              {annotationLoading ? <span>正在检查…</span> : annotationSummary ? <>
                <span>{annotationSummary.count} 条记录</span>
                {annotationSummary.unresolvedCount > 0 && <span>{annotationSummary.unresolvedCount} 条待定位</span>}
                {annotationSummary.pendingDraftCount > 0 && <span className="annotation-pending">{annotationSummary.pendingDraftCount} 份草稿尚未写回同目录，暂停新增测试锚点</span>}
                {(annotationSummary.unreadableDraftCount ?? 0) > 0 && <span className="annotation-warning">其中 {annotationSummary.unreadableDraftCount} 份草稿无法读取，请检查应用数据目录</span>}
                {annotationSummary.status === 'read-only' && <span className="annotation-warning">只读：{annotationSummary.reason ?? '批注文件不可安全修改'}</span>}
                <span className="annotation-location" title={annotationSummary.sidecarPath}>{annotationSummary.sidecarPath}</span>
              </> : <span className="annotation-warning">{annotationError ?? '尚未读取批注状态'}</span>}
            </div>
            <div className="selection-probe-controls">
              <button type="button" className="selection-probe-button" onMouseDown={(event) => event.preventDefault()}
                onClick={probeSelection}>验证选区</button>
              <span>选中一段正文后点击 · 仅保存可核验的测试锚点</span>
            </div>
            {selectionProbe && <div className="selection-probe-result" role="status">
              {selectionProbe.ok ? <>
                <strong>已定位到原文</strong>
                <span>UTF-8 字节范围 [{selectionProbe.startByte}, {selectionProbe.endByte})</span>
                <span>可见选文：<code>{selectionProbe.displayQuote}</code></span>
                <span>原文片段：<code>{selectionProbe.sourceExact}</code></span>
                <div className="selection-save-row">
                  <button type="button" className="selection-probe-button" onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void saveSelectionProbe()} disabled={annotationSaving || annotationLoading ||
                      annotationSummary?.status !== 'ready' || annotationSummary.pendingDraftCount > 0}>
                    {annotationSaving ? '正在保存…' : '保存测试高亮锚点'}
                  </button>
                  <span>当前仅验证 sidecar 持久化，正文着色将在后续批次加入。</span>
                </div>
              </> : <><strong>无法安全定位</strong><span>{selectionProbe.reason}</span></>}
            </div>}
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
