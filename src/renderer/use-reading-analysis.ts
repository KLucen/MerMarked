import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReadingAnalysis } from '../core/reading-analysis';
import { ReadingAnalysisTask } from './reading-analysis-task';

/** At most one cached snapshot; no old offsets are exposed while a new one is pending. */
export function useReadingAnalysis(key: string | null, source: string, bomByteLength: 0 | 3, enabled: boolean) {
  const task = useRef<ReadingAnalysisTask | null>(null);
  const resultVersion = useRef(0);
  const [retryKey, setRetryKey] = useState(0);
  const [started, setStarted] = useState<{ key: string; source: string; bomByteLength: 0 | 3; retryKey: number } | null>(null);
  const [result, setResult] = useState<{ key: string; source: string; bomByteLength: 0 | 3;
    retryKey: number; version: number; data: ReadingAnalysis | null } | null>(null);
  const current = result?.key === key && result.source === source && result.bomByteLength === bomByteLength &&
    result.retryKey === retryKey ? result : null;
  const retry = useCallback(() => setRetryKey(value => value + 1), []);
  const settled = current !== null;
  useEffect(() => {
    if (!key || !enabled || settled) return;
    task.current ??= new ReadingAnalysisTask(() => new Worker(new URL('./reading-analysis.worker.ts', import.meta.url), { type: 'module' }));
    const currentTask = task.current;
    currentTask.run(source, bomByteLength, data => setResult({ key, source, bomByteLength, retryKey, version: ++resultVersion.current, data }),
      () => setStarted({ key, source, bomByteLength, retryKey }));
    return () => currentTask.cancel();
  }, [key, source, bomByteLength, enabled, retryKey, settled]);

  return { data: current?.data ?? null,
    // Display retention only. Callers must hide/inert it until `data` matches.
    retained: result?.key === key ? result : null,
    started: started?.key === key && started.source === source && started.bomByteLength === bomByteLength && started.retryKey === retryKey,
    status: !key || !enabled ? 'idle' as const : !current ? 'pending' as const
      : current.data === null ? 'error' as const : 'ready' as const, retry };
}
