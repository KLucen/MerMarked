// Functional scale gate; timing samples use the same scenario in separate runs.
process.env.MERMARKD_PERF_SCALE = '1';
process.env.MERMARKD_PERF_MIB ??= '1';
process.env.MERMARKD_PERF_LABEL ??= 'scale-e2e';
await import('./perf3d-responsiveness-packaged.mjs');
