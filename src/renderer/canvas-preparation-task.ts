import type { PreparedCanvas } from '../core/canvas-preparation';
import type { CanvasStateV2 } from '../core/canvas-state-v2';

export interface CanvasPreparationRequest {
  readonly id: number;
  readonly source: string;
  readonly bomByteLength: 0 | 3;
  readonly model: CanvasStateV2 | null;
}
export type CanvasPreparationResponse = { readonly id: number; readonly result: PreparedCanvas }
  | { readonly id: number; readonly error: true };
export type CanvasPreparationWorker = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'>;

/** One request per worker. Cancellation settles the caller and interrupts synchronous parsing. */
export class CanvasPreparationTask {
  private generation = 0;
  private active: { worker: CanvasPreparationWorker; timer: ReturnType<typeof setTimeout>; settle: () => void } | null = null;
  private readonly factory: () => CanvasPreparationWorker;
  private readonly timeoutMs: number;
  constructor(factory: () => CanvasPreparationWorker, timeoutMs = 30_000) {
    this.factory = factory;
    this.timeoutMs = timeoutMs;
  }

  cancel() {
    this.generation += 1;
    const active = this.active;
    this.active = null;
    if (!active) return;
    clearTimeout(active.timer);
    active.worker.terminate();
    active.settle();
  }

  run(source: string, bomByteLength: 0 | 3, model: CanvasStateV2 | null): Promise<PreparedCanvas | null> {
    this.cancel();
    const id = this.generation;
    return new Promise(resolve => {
      const complete = (result: PreparedCanvas | null) => {
        if (id !== this.generation) return;
        // Resolve before cancel settles the abandoned case; only the first wins.
        resolve(result);
        this.cancel();
      };
      try {
        const worker = this.factory();
        this.active = { worker, timer: setTimeout(() => complete(null), this.timeoutMs), settle: () => resolve(null) };
        worker.onmessage = (event: MessageEvent<CanvasPreparationResponse>) => {
          if (event.data.id === id) complete('result' in event.data ? event.data.result : null);
        };
        worker.onerror = event => { event.preventDefault(); complete(null); };
        worker.onmessageerror = () => complete(null);
        worker.postMessage({ id, source, bomByteLength, model } satisfies CanvasPreparationRequest);
      } catch { complete(null); }
    });
  }
}
