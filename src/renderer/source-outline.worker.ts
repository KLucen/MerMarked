import { buildSourceOutline } from '../core/source-outline';
import type { OutlineRequest, OutlineResponse } from './source-outline-task';

self.onmessage = (event: MessageEvent<OutlineRequest>) => {
  const { id, source } = event.data;
  let response: OutlineResponse;
  try { response = { id, sections: buildSourceOutline(source) }; }
  catch { response = { id, error: true }; }
  self.postMessage(response);
};
