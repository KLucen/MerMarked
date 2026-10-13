import { useMemo, useRef, useEffect } from 'react';
import { extractSections } from '../core/sections';
import type { SectionStructurePreview } from '../types/reader-api';

interface Props {
  readonly preview: SectionStructurePreview;
  readonly stale: boolean;
  readonly busy: boolean;
  readonly confirmDisabled?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/** The same reviewed candidate is available from the canvas and source editor. */
export function CanvasStructurePreview({ preview, stale, busy, confirmDisabled = false, onConfirm, onCancel }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  const levels = useMemo(() => {
    const sections = extractSections(preview.source).sections;
    const operation = preview.operation;
    const source = sections[operation.kind === 'move' ? operation.sourceIndex : operation.sectionIndex];
    const next = operation.kind === 'move' ? (sections[operation.targetIndex]?.depth ?? 0) + 1 : operation.targetDepth;
    return source ? `${source.depth} 级 → ${next} 级；后代标题同步调整` : null;
  }, [preview]);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [preview.token]);
  return <section className="source-structure source-structure-preview canvas-structure-review"
    aria-label="卡片结构变更预览" data-canvas-structure-preview="true">
    <h2 ref={heading} tabIndex={-1} data-panel-autofocus>调整章节结构</h2>
    <p className="canvas-structure-summary">{preview.summary}</p>
    {levels && <p data-canvas-structure-levels="true">标题级别：{levels}</p>}
    <p>{preview.impact?.message}</p>
    {preview.impact?.unresolved.length ? <details><summary>{preview.impact.unresolved.length} 条批注需要检查位置</summary>
      <ul>{preview.impact.unresolved.map(item => <li key={item.id}>{item.quote}</li>)}</ul>
    </details> : null}
    <details key={preview.token} data-canvas-structure-diff="true">
      <summary>查看 Markdown 源码变化</summary>
      <div className="source-structure-diff">
        <div><span>变更前</span><pre>{preview.source}</pre></div>
        <div><span>变更后</span><pre data-canvas-structure-after="true">{preview.candidate}</pre></div>
      </div>
    </details>
    <p className="canvas-structure-hint">确认后可撤销；点击顶栏“保存”才会写入文件。</p>
    {stale && <p role="alert">正文在预览后变化，请取消并重新生成预览。</p>}
    <div className="canvas-review-actions">
      <button type="button" className="primary" data-canvas-structure-confirm="true" disabled={busy || stale || confirmDisabled}
        onClick={onConfirm}>确认调整</button>
      <button type="button" data-canvas-structure-cancel="true" disabled={busy} onClick={onCancel}>取消预览</button>
    </div>
  </section>;
}
