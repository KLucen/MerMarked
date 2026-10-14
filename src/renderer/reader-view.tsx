import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import type { SourceEditorSection } from './editor-view';

export function DocumentOutline({ sections, status = 'ready', onRetry, activeSection, sourceMode, onJumpToSection }: {
  readonly sections: readonly SourceEditorSection[];
  readonly status?: 'idle' | 'pending' | 'ready' | 'error';
  readonly onRetry?: () => void;
  readonly activeSection: number | null;
  readonly sourceMode: boolean;
  readonly onJumpToSection: (index: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const activeLink = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const container = scroller.current;
    const link = activeLink.current;
    if (!container || !link || !container.getClientRects().length) return;
    const bounds = container.getBoundingClientRect();
    const target = link.getBoundingClientRect();
    if (target.top < bounds.top) container.scrollTop -= bounds.top - target.top;
    else if (target.bottom > bounds.bottom) container.scrollTop += target.bottom - bounds.bottom;
  }, [activeSection]);
  return <div ref={scroller} className={sourceMode ? 'toc-inner source-outline' : 'toc-inner'} data-outline-status={status}
    aria-busy={status === 'pending'} aria-label={sourceMode ? '源码章节目录' : '章节目录'}>
    <div className="toc-heading">{sourceMode ? '源码目录' : '章节目录'} <span>{status === 'ready' ? sections.length : '—'}</span></div>
    {status === 'pending' || status === 'idle' ? <p className="toc-empty outline-status" role="status">正在更新目录…</p>
      : status === 'error' ? <div className="toc-empty outline-status" role="status"><p>目录暂不可用，正文仍可编辑和保存。</p>
        <button type="button" onClick={onRetry}>重试目录</button></div>
      : sections.length ? <nav aria-label="文档章节"><ol className="toc-list">
      {sections.map((section) => {
        const current = String(activeSection) === section.key;
        return <li key={section.key} style={{ '--toc-level': Math.min(section.depth - 1, 5) } as CSSProperties}>
          <button type="button" className={current ? 'toc-link active' : 'toc-link'} ref={current ? activeLink : undefined}
            data-editor-section={sourceMode ? section.key : undefined} data-source-offset={sourceMode ? section.sourceOffset : undefined}
            onClick={() => onJumpToSection(Number(section.key))} aria-current={current ? 'location' : undefined}
            aria-label={'第 ' + section.depth + ' 层章节：' + section.title} title={section.title}>
            <span className="toc-title">{section.title}</span>
          </button>
        </li>;
      })}
    </ol></nav> : <p className="toc-empty">这份文档没有章节标题。</p>}
  </div>;
}

export function ReaderView({ children }: { readonly children: ReactNode }) {
  return <div className="reading-layout">{children}</div>;
}
