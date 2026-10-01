import { useEffect, useRef } from 'react';
import type { DocumentRecoveryItem, DocumentRecoveryPreview } from '../types/reader-api';

const statusNames = { prepared: '已准备，尚未完成', interrupted: '保存中断', conflict: '文件已变化', incomplete: '恢复记录不完整', invalid: '恢复记录无法核验' };
const fileStatusNames = { before: '尚未更新', after: '已是候选版本', interrupted: '等待恢复原路径', conflict: '存在外部变化' };

export function DocumentRecoveryView({ items, preview, busy, error, onPreview, onSelect, onConfirm, onClose }: {
  items: readonly DocumentRecoveryItem[];
  preview: DocumentRecoveryPreview | null;
  busy: boolean;
  error: string | null;
  onPreview: (id: string) => void;
  onSelect: () => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => { if (origin?.isConnected) origin.focus({ preventScroll: true }); };
  }, []);
  return <div className="document-recovery-backdrop">
    <div ref={panel} tabIndex={-1} className="document-recovery-panel" role="dialog" aria-modal="true"
      aria-labelledby="document-recovery-title" data-document-recovery="true" onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && ['f', 'h', 's', 'o'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); }
        if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose(); }
        if (event.key !== 'Tab') return;
        const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []);
        const first = controls[0]; const last = controls.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
      }}>
      <header><h2 id="document-recovery-title">检查保存恢复</h2><button type="button" disabled={busy} onClick={onClose} aria-label="关闭保存恢复">关闭</button></header>
      <p>恢复只继续明确选择的保存记录。先核验原始、候选和当前三个文件，再确认写入。</p>
      {error && <p role="alert" className="canvas-warning">{error}</p>}
      {busy && <p role="status">正在核验或恢复…</p>}
      {!preview && <>
        {items.length ? <ol className="document-recovery-list">{items.map((item, index) => <li key={item.id}>
          <span>保存记录 {index + 1} · {statusNames[item.status]}</span>
          <button type="button" data-recovery-inspect={item.id} disabled={busy || !item.canPreview} onClick={() => onPreview(item.id)}>核验候选</button>
        </li>)}</ol> : <p>当前没有可列出的未完成保存。原 Markdown 路径缺失时，可以选择同目录的恢复记录。</p>}
      </>}
      {preview && <section className="source-structure-preview" data-recovery-preview="true">
        <h3>{preview.documentName}</h3><p>{preview.message}</p>
        <ul>{preview.files.map((file) => <li key={file.name}>{file.name}：{fileStatusNames[file.status]}</li>)}</ul>
        <div className="source-structure-diff">
          <div><span>保存前的原始源码</span><pre>{preview.source}</pre></div>
          <div><span>此次保存的候选源码</span><pre>{preview.candidate}</pre></div>
        </div>
        <button type="button" className="primary" data-recovery-confirm="true" disabled={busy || !preview.recoverable} onClick={onConfirm}>确认继续此保存</button>
      </section>}
      <button type="button" data-recovery-select="true" disabled={busy} onClick={onSelect}>选择其他 .journal.json 恢复记录</button>
      <p>取消和核验都不改文件。外部变化或未知保存锁会阻止恢复；原始与候选快照保留。</p>
    </div>
  </div>;
}
