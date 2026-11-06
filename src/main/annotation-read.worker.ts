import { parentPort, workerData } from 'node:worker_threads';
import { readAndVerifyAnnotations, type AnnotationReadInput } from './annotation-read.ts';

void readAndVerifyAnnotations(workerData as AnnotationReadInput).then(
  result => parentPort?.postMessage({ result }),
  () => parentPort?.postMessage({ error: true }),
);
