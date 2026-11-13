import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Run separately from ordinary timing cohorts, builds and other window suites.
const prefix = process.argv[2];
const mode = process.argv[3];
assert.ok(prefix && ['pending', 'memory'].includes(mode));
const qa = path.resolve('out/qa');
const executable = {
  before: path.join(qa, 'perf3-exit-perf3g-baseline/MerMarkd.exe'),
  after: path.resolve('out/MerMarkd-win32-x64/MerMarkd.exe'),
};
const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const packages = {};
for (const [role, exe] of Object.entries(executable)) packages[role] = {
  executable: exe, asarSha256: await sha(path.join(path.dirname(exe), 'resources/app.asar')),
};
const script = path.resolve('tests/e2e/perf3e-canvas-packaged.mjs');
const manifest = { prefix, mode, startedAt: new Date().toISOString(), packages, scriptSha256: await sha(script), runs: [] };
const manifestPath = path.join(qa, `${prefix}-${mode}-manifest.json`);
// Preserve every prior attempt, including incomplete runs.
try { await readFile(manifestPath); throw Error(`Manifest already exists: ${manifestPath}`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const save = () => writeFile(manifestPath, JSON.stringify(manifest, null, 2));
await save();
const tasks = mode === 'pending'
  ? Array.from({ length: 5 }, (_, index) => ({ role: 'after', mib: 5, label: `pending-5m-${index + 1}` }))
  : [{ role: 'before', mib: 1 }, { role: 'after', mib: 1 }, { role: 'after', mib: 5 }, { role: 'before', mib: 5 }]
    .map(task => ({ ...task, label: `memory-${task.role}-${task.mib}m` }));
for (const task of tasks) {
  assert.equal(await sha(path.join(path.dirname(executable[task.role]), 'resources/app.asar')), packages[task.role].asarSha256, 'package changed during probes');
  const env = { ...process.env, MERMARKD_QA_EXE: executable[task.role], MERMARKD_QA_ARTIFACT_PREFIX: prefix,
    MERMARKD_PERF_MIB: String(task.mib), MERMARKD_PERF_LABEL: task.label };
  for (const key of ['MERMARKD_PERF_PROFILE', 'MERMARKD_PERF_PROFILE_CARDS', 'MERMARKD_PERF_INPUT_PROFILE', 'MERMARKD_PERF_TRACE_STAGE',
    'MERMARKD_PERF_HIDE_GRID', 'MERMARKD_PERF_GC_PROBE', 'MERMARKD_PERF_PENDING_SOURCE', 'MERMARKD_PERF_VERIFY_LIFECYCLE',
    'MERMARKD_PERF_VERIFY_CANVAS_WORKER', 'MERMARKD_PERF_REPEAT_OPEN', 'MERMARKD_QA_RENDERER_URL', 'MERMARKD_PERF_AX_MODE', 'MERMARKD_PERF_AX_TRACE']) delete env[key];
  env[mode === 'pending' ? 'MERMARKD_PERF_PENDING_SOURCE' : 'MERMARKD_PERF_GC_PROBE'] = '1';
  const record = { ...task, startedAt: new Date().toISOString(), status: 'running', log: path.join(qa, `${prefix}-${task.label}.log`) };
  manifest.runs.push(record); await save();
  const output = createWriteStream(record.log);
  record.code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
    const timeout = setTimeout(() => {
      record.timedOut = true;
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
      catch { child.kill('SIGKILL'); }
    }, 180000);
    child.once('error', error => { clearTimeout(timeout); output.end(); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); output.end(() => resolve(code)); });
  });
  record.status = record.code === 0 && !record.timedOut ? 'passed' : 'failed';
  record.finishedAt = new Date().toISOString(); await save();
  assert.equal(record.status, 'passed', record.log);
  record.result = path.join(qa, `${prefix}-${task.label}.json`);
  const data = JSON.parse(await readFile(record.result, 'utf8'));
  assert.equal(data.headings, 200); assert.equal(data.annotations, 500);
  assert.equal(data.measurements.find(row => row.name === 'fit-200-cards').visibleCards, 200);
  assert.ok(Object.values(data.diagnosticOverrides).every(value => value === false));
  if (mode === 'pending') {
    const sample = data.measurements.find(row => row.name === 'pending-source');
    assert.ok(Number.isFinite(sample?.inputToReadyPaintMs));
    record.inputToReadyPaintMs = sample.inputToReadyPaintMs;
    record.maxFrameGapMs = sample.maxFrameGapMs;
    record.interactionMaxFrameGapMs = sample.interactionMaxFrameGapMs;
    await save();
    assert.ok(sample.inputToReadyPaintMs <= 200 && sample.interactionMaxFrameGapMs <= 100, 'pending-mode budget not met; original sample retained');
  } else {
    assert.deepEqual(data.retainedHeap.map(row => row.stage), ['cards-1', 'reader-1', 'cards-2', 'reader-2', 'cards-3', 'reader-3']);
    assert.ok(data.retainedHeap.every(row => Number.isFinite(row.usedHeapMiB) && row.application.length >= 3));
    record.retainedHeap = data.retainedHeap;
  }
  await save(); console.log(`passed ${task.label}`);
}
manifest.status = 'complete'; manifest.finishedAt = new Date().toISOString(); await save();
console.log(`Completed ${tasks.length} ${mode} probes. Memory snapshots require trend review; they do not prove absence of leaks.`);
