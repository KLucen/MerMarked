import { analyzeReading } from '../core/reading-analysis';
import type { ReadingAnalysisRequest, ReadingAnalysisResponse } from './reading-analysis-task';

self.onmessage = (event: MessageEvent<ReadingAnalysisRequest>) => {
  const { id, source, bomByteLength } = event.data;
  let response: ReadingAnalysisResponse;
  try {
    const started = performance.now();
    const result = analyzeReading(source, bomByteLength);
    response = { id, result, analysisMs: performance.now() - started };
  }
  catch { response = { id, error: true }; }
  self.postMessage(response);
};
