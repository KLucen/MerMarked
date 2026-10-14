import type { SourceOutlineSection } from '../core/source-outline';

export interface OutlineRequest { readonly id: number; readonly source: string }
export type OutlineResponse = { readonly id: number; readonly sections: readonly SourceOutlineSection[] }
  | { readonly id: number; readonly error: true };
export type OutlineWorker = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'>;

/** One in-flight parse; terminating the old worker also interrupts synchronous parsing. */
export class SourceOutlineTask {
  private generation = 0;
  private active: { worker: OutlineWorker; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly factory: () => OutlineWorker;
  private readonly timeoutMs: number;

  constructor(factory: () => OutlineWorker, timeoutMs = 15_000) {
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

  run(source: string, onResult: (sections: readonly SourceOutlineSection[] | null) => void) {
    this.cancel();
    const id = this.generation;
    const complete = (sections: readonly SourceOutlineSection[] | null) => {
      if (id !== this.generation) return;
      this.cancel();
      onResult(sections);
    };
    try {
      const worker = this.factory();
      this.active = { worker, timer: setTimeout(() => complete(null), this.timeoutMs) };
      worker.onmessage = (event: MessageEvent<OutlineResponse>) => {
        if (event.data.id === id) complete('sections' in event.data ? event.data.sections : null);
      };
      worker.onerror = (event) => { event.preventDefault(); complete(null); };
      worker.onmessageerror = () => complete(null);
      worker.postMessage({ id, source } satisfies OutlineRequest);
    } catch {
      complete(null);
    }
  }
}
