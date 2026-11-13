import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This is an isolated feature-exposure experiment, not screen-reader acceptance.
// Run timings on an otherwise idle machine. Run trace separately: profiling
// observations must never be substituted for ordinary timing observations.
// Required: MERMARKD_QA_EXE and the corresponding MERMARKD_QA_BUILD_MANIFEST.
// node tests/e2e/qa2-accessibility-observed-packaged.mjs timings <unique-prefix>
// node tests/e2e/qa2-accessibility-observed-packaged.mjs trace <unique-prefix>
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [mode = 'timings', prefix = 'qa2-accessibility-observed'] = process.argv.slice(2);
assert.ok(process.argv.length <= 4 && ['timings', 'trace'].includes(mode));
assert.match(prefix, /^[a-z0-9][a-z0-9-]{0,90}$/i, 'Use a short, unique artifact prefix.');
const executable = process.env.MERMARKD_QA_EXE;
const buildManifestPath = process.env.MERMARKD_QA_BUILD_MANIFEST;
assert.ok(executable && path.isAbsolute(executable), 'Select an absolute MERMARKD_QA_EXE.');
assert.ok(buildManifestPath && path.isAbsolute(buildManifestPath), 'Select its absolute MERMARKD_QA_BUILD_MANIFEST.');
const qa = path.join(root, 'out/qa');
await mkdir(qa, { recursive: true });
const manifestPath = path.join(qa, `${prefix}-${mode}-manifest.json`);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fileIdentity = async file => { const bytes = await readFile(file); return { bytes: bytes.length, sha256: digest(bytes) }; };
const asarPath = path.join(path.dirname(executable), 'resources/app.asar');
const asar = await fileIdentity(asarPath);
const receiptBytes = await readFile(buildManifestPath);
const receipt = JSON.parse(receiptBytes.toString('utf8'));
assert.match(receipt.sourceCommit ?? '', /^[a-f0-9]{40}$/i, 'The build receipt needs an exact source commit.');
const receiptAsars = Array.isArray(receipt.artifacts)
  ? receipt.artifacts.filter(item => path.basename(item.path ?? '').toLowerCase() === 'app.asar')
  : [receipt.artifacts?.asar].filter(Boolean);
assert.equal(receiptAsars.filter(item => item.sha256?.toLowerCase() === asar.sha256 && item.bytes === asar.bytes).length, 1,
  'The selected ASAR must match exactly one artifact in the build receipt.');
assert.equal(receipt.status ?? 'passed', 'passed', 'The source build must have passed.');
if (process.env.MERMARKD_QA_SOURCE_COMMIT) assert.equal(process.env.MERMARKD_QA_SOURCE_COMMIT.toLowerCase(), receipt.sourceCommit.toLowerCase());
const sourceTree = execFileSync('git', ['-C', root, 'rev-parse', `${receipt.sourceCommit}^{tree}`], { encoding: 'utf8', windowsHide: true }).trim();
if (receipt.sourceTree) assert.equal(sourceTree, receipt.sourceTree);
const scriptFiles = ['tests/e2e/qa2-accessibility-observed-packaged.mjs', 'tests/e2e/perf3e-canvas-packaged.mjs',
  'tests/e2e/packaged-window.mjs', 'tests/prototypes/source-controls.ts'];
const scripts = Object.fromEntries(await Promise.all(scriptFiles.map(async file => [file, await fileIdentity(path.join(root, file))])));
const manifest = { kind: 'isolated-additive-accessibility-feature-exposure', mode, prefix,
  startedAt: new Date().toISOString(), status: 'running', node: process.version, platform: process.platform,
  testCommit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
  package: { executable, asarPath, ...asar, sourceCommit: receipt.sourceCommit, sourceTree,
    buildReceipt: { path: buildManifestPath, sha256: digest(receiptBytes) } }, scripts,
  scope: 'One fixed package, 5 MiB generated fixture, 200 headings/cards and 500 attached highlights. New process and isolated profile each run; OS file cache is not flushed.',
  featurePolicy: 'default never invokes an AX setter. observed adds webContents and extendedProperties to every existing feature. No feature is removed; the process is destroyed after the sample.',
  tracePolicy: 'Trace mode is one separate observed sample with profiling and discovered accessibility trace categories; no timing budget is evaluated for it.',
  runs: [], warnings: [], summary: null };
await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
const save = () => writeFile(manifestPath, JSON.stringify(manifest, null, 2));
const tasks = mode === 'trace' ? [{ exposure: 'observed', round: 1 }]
  : Array.from({ length: 5 }, (_, index) => (index % 2 ? ['observed', 'default'] : ['default', 'observed'])
    .map(exposure => ({ exposure, round: index + 1 }))).flat();
const normalize = values => [...values].sort();
const stats = values => { const sorted = [...values].sort((a, b) => a - b); return { values, median: sorted[Math.floor(sorted.length / 2)], worst: sorted.at(-1) }; };
const sampleData = [];

async function assertFrozenInputs() {
  assert.deepEqual(await fileIdentity(asarPath), asar, 'The package changed during the experiment.');
  assert.equal(digest(await readFile(buildManifestPath)), manifest.package.buildReceipt.sha256, 'The build receipt changed.');
  for (const [file, identity] of Object.entries(scripts)) assert.deepEqual(await fileIdentity(path.join(root, file)), identity, `The test source changed: ${file}`);
}
async function runChild(env, log) {
  const output = createWriteStream(log, { flags: 'wx' });
  await new Promise((resolve, reject) => { output.once('open', resolve); output.once('error', reject); });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'tests/e2e/perf3e-canvas-packaged.mjs')],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
      catch { child.kill('SIGKILL'); }
    }, 180000);
    child.once('error', error => { clearTimeout(timeout); output.end(() => reject(error)); });
    child.once('exit', code => { clearTimeout(timeout); output.end(() => resolve({ code, timedOut })); });
  });
}
function validateSample(data, record) {
  assert.equal(data.sourceBytes, 5271609); assert.equal(data.headings, 200); assert.equal(data.annotations, 500);
  assert.equal(data.measurements.find(row => row.name === 'fit-200-cards')?.visibleCards, 200);
  assert.deepEqual(data.retainedHeap, [], 'The experiment must not run forced GC.');
  assert.deepEqual(data.diagnosticOverrides, { hideGrid: false, profile: mode === 'trace', accessibilityObserved: record.exposure === 'observed' });
  const configuration = data.accessibilityConfiguration;
  assert.equal(configuration.mode, record.exposure);
  assert.equal(configuration.setterCalled, record.exposure === 'observed');
  if (record.exposure === 'observed') {
    assert.deepEqual(configuration.additions, ['webContents', 'extendedProperties']);
    assert.deepEqual(normalize(configuration.requestedFeatures), normalize([...new Set([...configuration.beforeFeatures, ...configuration.additions])]));
    assert.ok(configuration.requestedFeatures.every(feature => configuration.afterFeatures.includes(feature)), 'Existing features must be preserved.');
  }
  for (const point of ['before', 'after']) {
    const snapshot = data.environmentSnapshots?.[point];
    assert.ok(snapshot && Array.isArray(snapshot.accessibilitySupportFeatures), `Missing actual ${point} features.`);
    assert.equal(snapshot.window?.visible, true); assert.equal(snapshot.window?.minimized, false);
    if (snapshot.window?.focused !== true) manifest.warnings.push({ label: record.label, point, kind: 'focus-not-observed', focused: snapshot.window?.focused });
    if (record.exposure === 'observed') assert.ok(configuration.requestedFeatures.every(feature => snapshot.accessibilitySupportFeatures.includes(feature)),
      'The requested additive features must remain present at both snapshots.');
  }
  assert.equal(data.traceConfiguration.accessibilityCategoriesRequested, mode === 'trace');
}
function summarize() {
  const groups = []; const violations = [];
  for (const exposure of mode === 'trace' ? ['observed'] : ['default', 'observed']) {
    const samples = sampleData.filter(sample => sample.record.exposure === exposure);
    const names = samples[0].data.measurements.map(row => row.name);
    const measurements = names.map(name => {
      const rows = samples.map(sample => sample.data.measurements.find(row => row.name === name));
      const result = { name };
      for (const field of ['elapsedMs', 'inputToReadyPaintMs', 'inputToFeedbackPaintMs', 'maxFrameGapMs', 'interactionMaxFrameGapMs', 'preInputMaxFrameGapMs', 'usedHeapMiB']) {
        const values = rows.map(row => row[field]).filter(value => Number.isFinite(value));
        result[field] = values.length ? stats(values) : null;
      }
      if (mode === 'timings') {
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index]; const check = (field, limit) => { if (Number.isFinite(row[field]) && row[field] > limit) violations.push({ exposure, round: samples[index].record.round, name, field, value: row[field], limit }); };
          check('interactionMaxFrameGapMs', 100); check('inputToFeedbackPaintMs', 100);
          if (['switch-source', 'switch-200-cards', 'return-reader'].includes(name)) check('inputToReadyPaintMs', 300);
          if (name === 'canvas-search') check('inputToReadyPaintMs', 200);
        }
        if (['open-reader', 'repeat-open-reader'].includes(name) && result.elapsedMs.median > 3000)
          violations.push({ exposure, name, field: 'median elapsedMs', value: result.elapsedMs.median, limit: 3000 });
      }
      return result;
    });
    groups.push({ exposure, samples: samples.length, measurements });
  }
  const pairs = mode === 'trace' ? [] : Array.from({ length: 5 }, (_, index) => {
    const baseline = sampleData.find(sample => sample.record.round === index + 1 && sample.record.exposure === 'default').data;
    const observed = sampleData.find(sample => sample.record.round === index + 1 && sample.record.exposure === 'observed').data;
    const baseBefore = baseline.environmentSnapshots.before.accessibilitySupportFeatures;
    const baseAfter = baseline.environmentSnapshots.after.accessibilitySupportFeatures;
    const actualBefore = observed.environmentSnapshots.before.accessibilitySupportFeatures;
    const actualAfter = observed.environmentSnapshots.after.accessibilitySupportFeatures;
    const expected = [...new Set([...baseBefore, 'webContents', 'extendedProperties'])];
    const same = (left, right) => JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
    return { round: index + 1, defaultFeatures: baseBefore, observedInitialFeatures: observed.accessibilityConfiguration.beforeFeatures,
      observedFeatures: actualBefore, distinct: !same(baseBefore, actualBefore),
      stable: same(baseBefore, baseAfter) && same(actualBefore, actualAfter),
      established: same(baseBefore, observed.accessibilityConfiguration.beforeFeatures) && same(expected, actualBefore) &&
        same(baseBefore, baseAfter) && same(actualBefore, actualAfter) && !same(baseBefore, actualBefore) };
  });
  return { groups, violations, budgetStatus: mode === 'trace' ? 'not-evaluated-profiled' : violations.length ? 'not-met' : 'met-for-recorded-actions',
    featureContrast: { status: mode === 'trace' ? 'not-applicable-profiled' : pairs.every(pair => pair.established) ? 'established-for-recorded-feature-pairs' : 'not-established-for-all-pairs', pairs },
    note: 'These are controlled process feature flags, not proof of behavior with any particular native assistive client. All observations and overruns remain; event names and native/JS attribution require inspection of the separate trace.' };
}

try {
  for (const task of tasks) {
    await assertFrozenInputs();
    const label = `${task.exposure}-5m-${task.round}`;
    const artifactPrefix = `${prefix}-${mode}-${label}`;
    const record = { ...task, label, artifactPrefix, startedAt: new Date().toISOString(), status: 'running', log: path.join(qa, `${artifactPrefix}.log`) };
    manifest.runs.push(record); await save();
    const env = { ...process.env, MERMARKD_QA_EXE: executable, MERMARKD_QA_ARTIFACT_PREFIX: artifactPrefix,
      MERMARKD_PERF_MIB: '5', MERMARKD_PERF_LABEL: 'run', MERMARKD_PERF_REPEAT_OPEN: '1', MERMARKD_PERF_AX_MODE: task.exposure };
    for (const key of ['MERMARKD_PERF_PROFILE', 'MERMARKD_PERF_PROFILE_CARDS', 'MERMARKD_PERF_INPUT_PROFILE', 'MERMARKD_PERF_TRACE_STAGE',
      'MERMARKD_PERF_HIDE_GRID', 'MERMARKD_PERF_GC_PROBE', 'MERMARKD_PERF_PENDING_SOURCE', 'MERMARKD_PERF_VERIFY_LIFECYCLE',
      'MERMARKD_PERF_VERIFY_CANVAS_WORKER', 'MERMARKD_PERF_SCALE', 'MERMARKD_PERF_DELAY_ANNOTATIONS',
      'MERMARKD_QA_RENDERER_URL', 'MERMARKD_PERF_AX_TRACE']) delete env[key];
    if (mode === 'trace') Object.assign(env, { MERMARKD_PERF_PROFILE: '1', MERMARKD_PERF_PROFILE_CARDS: '1', MERMARKD_PERF_AX_TRACE: '1' });
    Object.assign(record, await runChild(env, record.log));
    record.logIdentity = await fileIdentity(record.log); record.finishedAt = new Date().toISOString();
    record.functionalStatus = record.code === 0 && !record.timedOut ? 'passed' : 'failed';
    record.status = record.functionalStatus === 'passed' ? 'validating' : 'failed';
    await save();
    assert.equal(record.functionalStatus, 'passed', `Functional run failed; preserved ${record.log}`);
    record.result = path.join(qa, `${artifactPrefix}-run.json`);
    record.resultIdentity = await fileIdentity(record.result);
    const data = JSON.parse(await readFile(record.result, 'utf8')); validateSample(data, record);
    record.startEvidence = { path: path.join(qa, `${artifactPrefix}-run-ax-start.json`) };
    Object.assign(record.startEvidence, await fileIdentity(record.startEvidence.path));
    record.environmentSnapshots = data.environmentSnapshots; record.accessibilityConfiguration = data.accessibilityConfiguration;
    if (mode === 'trace') {
      record.traceConfiguration = data.traceConfiguration; record.profileArtifacts = [];
      for (const stage of ['open', 'cards', 'return']) for (const extension of ['trace.json', 'cpuprofile']) {
        const file = path.join(qa, `${artifactPrefix}-${stage}-run.${extension}`);
        record.profileArtifacts.push({ path: file, ...await fileIdentity(file) });
      }
      const file = path.join(qa, `${artifactPrefix}-drag-main-run.cpuprofile`);
      record.profileArtifacts.push({ path: file, ...await fileIdentity(file) });
    }
    record.status = 'passed'; sampleData.push({ record, data }); await save();
    console.log(`passed ${label}`);
  }
  await assertFrozenInputs(); manifest.summary = summarize(); manifest.status = 'complete';
  if (mode === 'timings' && (manifest.summary.violations.length || manifest.summary.featureContrast.status !== 'established-for-recorded-feature-pairs')) process.exitCode = 1;
} catch (error) {
  manifest.status = 'failed'; manifest.error = error.stack ?? String(error); process.exitCode = 1;
  if (manifest.runs.at(-1)?.status === 'validating' || manifest.runs.at(-1)?.status === 'running') {
    manifest.runs.at(-1).status = 'failed'; manifest.runs.at(-1).error = error.message;
  }
} finally {
  manifest.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ status: manifest.status, budgetStatus: manifest.summary?.budgetStatus,
    featureContrast: manifest.summary?.featureContrast.status, violations: manifest.summary?.violations.length, manifest: manifestPath }));
}
