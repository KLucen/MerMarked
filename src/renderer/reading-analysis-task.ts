import type { ReadingAnalysis } from '../core/reading-analysis';

export interface ReadingAnalysisRequest { readonly id: number; readonly source: string; readonly bomByteLength: 0 | 3 }
export type ReadingAnalysisResponse = { readonly id: number; readonly result: ReadingAnalysis; readonly analysisMs: number }
  | { readonly id: number; readonly error: true };
export type ReadingAnalysisWorker = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'>;

/** Termination interrupts parsing; generations also reject replies already queued. */
export class ReadingAnalysisTask {
  private generation = 0;
  private active: { worker: ReadingAnalysisWorker; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly factory: () => ReadingAnalysisWorker;
  private readonly timeoutMs: number;

  constructor(factory: () => ReadingAnalysisWorker, timeoutMs = 30_000) {
    this.factory = factory;
    this.timeoutMs = timeoutMs;
  }

  cancel() {
    this.generation += 1;
    if (!this.active) return;
    clearTimeout(this.active.timer);
    this.active.worker.terminate();
    this.active = null;
  }

  run(source: string, bomByteLength: 0 | 3, onResult: (result: ReadingAnalysis | null) => void) {
    this.cancel();
    const id = this.generation;
    const complete = (result: ReadingAnalysis | null) => {
      if (id !== this.generation) return;
      this.cancel();
      onResult(result);
    };
    try {
      const worker = this.factory();
      this.active = { worker, timer: setTimeout(() => complete(null), this.timeoutMs) };
      worker.onmessage = (event: MessageEvent<ReadingAnalysisResponse>) => {
        if (event.data.id === id) complete('result' in event.data ? event.data.result : null);
      };
      worker.onerror = (event) => { event.preventDefault(); complete(null); };
      worker.onmessageerror = () => complete(null);
      worker.postMessage({ id, source, bomByteLength } satisfies ReadingAnalysisRequest);
    } catch { complete(null); }
  }
}
