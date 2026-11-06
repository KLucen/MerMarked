import { analyzeReadingSnapshot } from '../core/reading-analysis';
import { parseMarkdownSnapshot } from '../core/markdown-snapshot';
import { prepareCanvasFromReading } from '../core/canvas-preparation';
import type { ReadingAnalysisRequest, ReadingAnalysisResponse } from './reading-analysis-task';

self.onmessage = async (event: MessageEvent<ReadingAnalysisRequest>) => {
  const { id, source, bomByteLength } = event.data;
  self.postMessage({ id, started: true } satisfies ReadingAnalysisResponse);
  let response: ReadingAnalysisResponse;
  try {
    const started = performance.now();
    const snapshot = parseMarkdownSnapshot(source);
    const reading = analyzeReadingSnapshot(snapshot, bomByteLength);
    // An optional display projection must not prevent reading if it cannot be prepared.
    const canvas = await prepareCanvasFromReading(snapshot, bomByteLength).catch(() => undefined);
    const result = { ...reading, canvas };
    response = { id, result, analysisMs: performance.now() - started, analysisStartedAt: performance.timeOrigin + started };
  }
  catch { response = { id, error: true }; }
  self.postMessage(response);
};
