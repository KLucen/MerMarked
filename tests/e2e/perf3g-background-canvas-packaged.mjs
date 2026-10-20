process.env.MERMARKD_PERF_VERIFY_CANVAS_WORKER = '1';
process.env.MERMARKD_QA_ARTIFACT_PREFIX ??= 'perf3g';
process.env.MERMARKD_PERF_LABEL ??= 'lifecycle';
await import('./perf3e-lifecycle-packaged.mjs');
