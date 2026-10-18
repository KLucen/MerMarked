process.env.MERMARKD_PERF_VERIFY_LIFECYCLE = '1';
process.env.MERMARKD_PERF_MIB ??= '1';
process.env.MERMARKD_PERF_LABEL ??= 'lifecycle';
await import('./perf3e-canvas-packaged.mjs');
