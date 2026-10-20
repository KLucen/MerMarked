import { prepareCanvas } from '../core/canvas-preparation';
import type { CanvasPreparationRequest, CanvasPreparationResponse } from './canvas-preparation-task';

self.onmessage = async (event: MessageEvent<CanvasPreparationRequest>) => {
  const { id, source, bomByteLength, model } = event.data;
  let response: CanvasPreparationResponse;
  try { response = { id, result: await prepareCanvas(source, bomByteLength, model) }; }
  catch { response = { id, error: true }; }
  self.postMessage(response);
};
