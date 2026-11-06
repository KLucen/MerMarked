import type { Worker } from 'node:worker_threads';
import type { AnnotationReadInput, AnnotationReadResult } from './annotation-read.ts';

type ReadWorker = Pick<Worker, 'once' | 'removeAllListeners' | 'terminate'>;

/** A session owns at most one read task; cancellation also settles its caller. */
export class AnnotationReadTask {
  private stop: (() => void) | null = null;
  private active: { input: AnnotationReadInput; promise: Promise<AnnotationReadResult> } | null = null;
  private readonly factory: (input: AnnotationReadInput) => ReadWorker;
  private readonly timeoutMs: number;

  constructor(factory: (input: AnnotationReadInput) => ReadWorker, timeoutMs = 30_000) {
    this.factory = factory;
    this.timeoutMs = timeoutMs;
  }

  cancel(): void { this.stop?.(); }

  run(input: AnnotationReadInput): Promise<AnnotationReadResult> {
    const active = this.active;
    if (active && active.input.documentPath === input.documentPath && active.input.draftDirectory === input.draftDirectory &&
      active.input.content === input.content && active.input.sourceSha256 === input.sourceSha256 && active.input.revision === input.revision) {
      return active.promise;
    }
    this.cancel();
    const promise = new Promise<AnnotationReadResult>((resolve, reject) => {
      let worker: ReadWorker | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (result?: AnnotationReadResult, canceled = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.stop = null;
        this.active = null;
        worker?.removeAllListeners();
        void worker?.terminate().catch(() => undefined);
        if (result) resolve(result);
        else reject(new Error(canceled ? '批注读取已取消。' : '批注核验未能完成，请重新载入批注。'));
      };
      this.stop = () => finish(undefined, true);
      try {
        worker = this.factory(input);
        timer = setTimeout(() => finish(), this.timeoutMs);
        worker.once('message', (message: { result?: AnnotationReadResult }) => finish(message.result));
        worker.once('error', () => finish());
        worker.once('exit', () => finish());
      } catch { finish(); }
    });
    if (this.stop) this.active = { input, promise };
    return promise;
  }
}
