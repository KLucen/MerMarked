import { useCallback, useEffect, useRef, useState } from 'react';
import type { SourceOutlineSection } from '../core/source-outline';
import { SourceOutlineTask } from './source-outline-task';

const EMPTY: readonly SourceOutlineSection[] = [];

export function useSourceOutline(documentKey: string | null, source: string, parsedSections?: readonly SourceOutlineSection[]) {
  const task = useRef<SourceOutlineTask | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [result, setResult] = useState<{ key: string; source: string; retryKey: number;
    sections: readonly SourceOutlineSection[] | null } | null>(null);
  const retry = useCallback(() => setRetryKey(value => value + 1), []);
  useEffect(() => {
    if (documentKey === null || parsedSections) { setResult(null); return; }
    task.current ??= new SourceOutlineTask(() => new Worker(new URL('./source-outline.worker.ts', import.meta.url), { type: 'module' }));
    const currentTask = task.current;
    // Coalesce fast typing; cancellation terminates a parse already in progress.
    const timer = window.setTimeout(() => currentTask.run(source, sections => {
      setResult({ key: documentKey, source, retryKey, sections });
    }), 120);
    return () => { window.clearTimeout(timer); currentTask.cancel(); };
  }, [documentKey, source, retryKey, parsedSections]);

  // Invalidate during render, before effect cleanup: stale offsets are never clickable.
  const current = result?.key === documentKey && result.source === source && result.retryKey === retryKey ? result : null;
  return { sections: parsedSections ?? current?.sections ?? EMPTY,
    status: parsedSections ? 'ready' as const : documentKey === null ? 'idle' as const : !current ? 'pending' as const
      : current.sections === null ? 'error' as const : 'ready' as const, retry };
}
