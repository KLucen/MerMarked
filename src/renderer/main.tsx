import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import type { ComponentProps, CSSProperties, MouseEvent } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import type { Components, ExtraProps } from 'react-markdown';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import { extractSections } from '../core/sections';
import './style.css';

interface OpenDocument {
  readonly path: string;
  readonly name: string;
  readonly content: string;
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
  const [openedDocument, setOpenedDocument] = useState<OpenDocument | null>(null);
  const [opening, setOpening] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<number | null>(null);

  const sectionTree = useMemo(
    () => openedDocument ? extractSections(openedDocument.content) : null,
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

  const openMarkdown = useCallback(async () => {
    setOpening(true);
    setMessage(null);
    try {
      const opened = await window.mermarkd.openMarkdown();
      if (opened) {
        setOpenedDocument(opened);
        setActiveSection(null);
        window.scrollTo({ top: 0 });
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '打开文档失败，请重试。');
    } finally {
      setOpening(false);
    }
  }, []);

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

  const heading = useCallback((tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6', props: ComponentProps<'h1'> & ExtraProps) => {
    const { node, children, ...rest } = props;
    const index = node?.position?.start.offset === undefined ? undefined : headingByOffset.get(node.position.start.offset);
    const id = index === undefined ? undefined : sectionIds[index];
    const Tag = tag;
    return <Tag {...rest} id={id} tabIndex={id ? -1 : undefined}>{children}</Tag>;
  }, [headingByOffset, sectionIds]);

  const components = useMemo<Components>(() => ({
    h1: (props) => heading('h1', props),
    h2: (props) => heading('h2', props),
    h3: (props) => heading('h3', props),
    h4: (props) => heading('h4', props),
    h5: (props) => heading('h5', props),
    h6: (props) => heading('h6', props),
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
        <button className="open-button" type="button" onClick={() => void openMarkdown()} disabled={opening}>
          {opening ? '正在打开…' : '打开 Markdown'}<span className="shortcut" aria-hidden="true">Ctrl+O</span>
        </button>
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
