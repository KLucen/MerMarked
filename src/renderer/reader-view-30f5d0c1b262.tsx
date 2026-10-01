import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { SectionTree } from '../core/sections';

interface ReaderViewProps {
  readonly sectionTree: SectionTree;
  readonly sectionIds: readonly string[];
  readonly activeSection: number | null;
  readonly annotationsOpen: boolean;
  readonly onJumpToSection: (index: number) => void;
  readonly children: ReactNode;
}

export function ReaderView({
  sectionTree,
  sectionIds,
  activeSection,
  annotationsOpen,
  onJumpToSection,
  children,
}: ReaderViewProps) {
  const tocScroller = useRef<HTMLDivElement>(null);
  const activeLink = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const scroller = tocScroller.current;
    const link = activeLink.current;
    if (!scroller || !link) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();
    if (linkRect.top < scrollerRect.top) scroller.scrollTop -= scrollerRect.top - linkRect.top;
    else if (linkRect.bottom > scrollerRect.bottom) scroller.scrollTop += linkRect.bottom - scrollerRect.bottom;
    if (linkRect.left < scrollerRect.left) scroller.scrollLeft -= scrollerRect.left - linkRect.left;
    else if (linkRect.right > scrollerRect.right) scroller.scrollLeft += linkRect.right - scrollerRect.right;
  }, [activeSection]);

  return <div className={annotationsOpen ? 'reading-layout annotations-open' : 'reading-layout'}>
    <aside className="toc" aria-label="章节目录">
      <div ref={tocScroller} className="toc-inner">
        <div className="toc-heading">章节目录 <span>{sectionTree.sections.length}</span></div>
        {sectionTree.sections.length ? <nav aria-label="文档章节"><ol className="toc-list">
          {sectionTree.sections.map((section) => {
            let level = 0;
            let parent = section.parentIndex;
            while (parent !== null) {
              level += 1;
              parent = sectionTree.sections[parent].parentIndex;
            }
            const current = activeSection === section.index;
            return <li key={section.index} style={{ '--toc-level': Math.min(level, 5) } as CSSProperties}>
              <button type="button" className={current ? 'toc-link active' : 'toc-link'}
                ref={current ? activeLink : undefined}
                onClick={() => onJumpToSection(section.index)}
                aria-current={current ? 'location' : undefined}
                aria-label={`第 ${level + 1} 层章节：${section.title}`}
                title={section.title}>
                <span className="toc-title">{section.title}</span>
              </button>
            </li>;
          })}
        </ol></nav> : <p className="toc-empty">这份文档没有章节标题。</p>}
      </div>
    </aside>
    {children}
  </div>;
}
