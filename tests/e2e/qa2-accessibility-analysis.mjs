import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Offline only. No app launch, live inspector connection, product or OS writes.
// node <this-file> <complete-timings-manifest> <complete-trace-manifest|-> <new-output.json>
const [timingsPath, tracePath, outputPath] = process.argv.slice(2);
assert.ok(timingsPath && tracePath && outputPath && process.argv.length === 5,
  'usage: node helper.mjs <complete-timings-manifest> <complete-trace-manifest|-> <new-output.json>');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function load(file, expected) {
  const bytes = await readFile(file);
  const identity = { bytes: bytes.length, sha256: sha(bytes) };
  if (expected) {
    assert.equal(identity.bytes, expected.bytes, `bytes mismatch: ${path.basename(file)}`);
    assert.equal(identity.sha256, expected.sha256.toLowerCase(), `hash mismatch: ${path.basename(file)}`);
  }
  return { data: JSON.parse(bytes.toString('utf8')), identity };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = values => [...values].sort();
const sameFlags = (a, b) => same(sorted(a), sorted(b));
const fields = ['elapsedMs', 'inputToReadyPaintMs', 'inputToFeedbackPaintMs', 'maxFrameGapMs',
  'interactionMaxFrameGapMs', 'preInputMaxFrameGapMs', 'usedHeapMiB'];
const stats = values => {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  return { values, finite: finite.length, median: finite.length ? finite[Math.floor(finite.length / 2)] : null,
    worst: finite.length ? finite.at(-1) : null };
};
async function cohort(file, mode, expectedRuns) {
  const { data: manifest, identity } = await load(file);
  assert.equal(manifest.mode, mode); assert.equal(manifest.status, 'complete');
  assert.equal(manifest.runs.length, expectedRuns);
  const samples = [];
  for (const run of manifest.runs) {
    assert.equal(run.status, 'passed'); assert.equal(run.functionalStatus, 'passed');
    const { data } = await load(run.result, run.resultIdentity);
    const { data: start } = await load(run.startEvidence.path, run.startEvidence);
    assert.deepEqual(start.accessibilityConfiguration, data.accessibilityConfiguration);
    assert.deepEqual(start.environmentBeforeTiming, data.environmentSnapshots.before);
    assert.equal(data.sourceBytes, 5271609); assert.equal(data.headings, 200); assert.equal(data.annotations, 500);
    assert.equal(data.measurements.find(row => row.name === 'fit-200-cards')?.visibleCards, 200);
    assert.deepEqual(data.retainedHeap, []);
    assert.deepEqual(data.diagnosticOverrides,
      { hideGrid: false, profile: mode === 'trace', accessibilityObserved: run.exposure === 'observed' });
    samples.push({ run, data });
  }
  return { manifest, identity, samples };
}
const timing = await cohort(timingsPath, 'timings', 10);
const names = timing.samples[0].data.measurements.map(row => row.name);
assert.equal(names.length, 10); assert.equal(new Set(names).size, 10);
for (const { data } of timing.samples) assert.deepEqual(data.measurements.map(row => row.name), names);
const coverage = [];
for (const name of names) for (const field of fields) {
  const entries = timing.samples.map(({ run, data }) => {
    const row = data.measurements.find(row => row.name === name);
    return { label: run.label, present: Object.hasOwn(row, field), value: Object.hasOwn(row, field) ? row[field] : null };
  });
  const expectedFinite = field === 'inputToReadyPaintMs' ? !(/^canvas-drag-/.test(name) || name === 'annotations-ready')
    : field === 'inputToFeedbackPaintMs' ? name === 'open-reader' : true;
  const complete = !expectedFinite || entries.every(entry => entry.present && Number.isFinite(entry.value));
  coverage.push({ name, field, expectedFinite, complete, entries });
}
const contrast = Array.from({ length: 5 }, (_, index) => {
  const a = timing.samples.find(sample => sample.run.round === index + 1 && sample.run.exposure === 'default');
  const b = timing.samples.find(sample => sample.run.round === index + 1 && sample.run.exposure === 'observed');
  assert.ok(a && b);
  const base = a.data.environmentSnapshots.before.accessibilitySupportFeatures;
  const actual = b.data.environmentSnapshots.before.accessibilitySupportFeatures;
  const expected = [...new Set([...base, 'webContents', 'extendedProperties'])];
  const established = !a.data.accessibilityConfiguration.setterCalled && b.data.accessibilityConfiguration.setterCalled &&
    sameFlags(base, b.data.accessibilityConfiguration.beforeFeatures) && sameFlags(expected, actual) && !sameFlags(base, actual) &&
    sameFlags(base, a.data.environmentSnapshots.after.accessibilitySupportFeatures) && sameFlags(actual, b.data.environmentSnapshots.after.accessibilitySupportFeatures);
  return { round: index + 1, established, defaultFeatures: base, observedFeatures: actual,
    deltasObservedMinusDefault: names.map(name => ({ name, ...Object.fromEntries(fields.map(field => {
      const x = a.data.measurements.find(row => row.name === name)[field];
      const y = b.data.measurements.find(row => row.name === name)[field];
      return [field, Number.isFinite(x) && Number.isFinite(y) ? y - x : null];
    })) })) };
});
const recomputed = ['default', 'observed'].map(exposure => ({ exposure,
  measurements: names.map(name => ({ name, ...Object.fromEntries(fields.map(field => [field,
    stats(timing.samples.filter(sample => sample.run.exposure === exposure).map(sample =>
      sample.data.measurements.find(row => row.name === name)[field] ?? null))])) })) }));
for (const group of recomputed) for (const row of group.measurements) for (const field of fields) {
  const saved = timing.manifest.summary.groups.find(item => item.exposure === group.exposure).measurements.find(item => item.name === row.name)[field];
  assert.equal(row[field].median, saved?.median ?? null, `summary median mismatch: ${group.exposure}/${row.name}/${field}`);
  assert.equal(row[field].worst, saved?.worst ?? null, `summary worst mismatch: ${group.exposure}/${row.name}/${field}`);
}
function unionMs(events) {
  const intervals = events.map(e => [e.ts, e.ts + e.dur]).sort((a, b) => a[0] - b[0]);
  let sum = 0, start = null, end = null;
  for (const [a, b] of intervals) {
    if (start === null) { start = a; end = b; }
    else if (a > end) { sum += end - start; start = a; end = b; }
    else end = Math.max(end, b);
  }
  return (sum + (start === null ? 0 : end - start)) / 1000;
}
const isAX = event => /[Aa]ccessibility|\bAX[A-Z_]|BlinkAX|BrowserAccessibility/.test(`${event.name} ${event.cat}`);
const isTask = event => /RunTask|ProcessTask|ThreadController|ThreadPool_RunTask/.test(event.name) || /(?:^|,)toplevel(?:,|$)/.test(event.cat);
function analyzeTrace(data) {
  const raw = Array.isArray(data) ? data : data.traceEvents;
  assert.ok(Array.isArray(raw), 'traceEvents missing');
  const processes = new Map(), threads = new Map(), stacks = new Map(), events = [];
  let unmatchedEnds = 0, mismatchedEnds = 0;
  for (const event of raw) {
    const key = `${event.pid}:${event.tid}`;
    if (event.ph === 'M' && event.name === 'process_name') processes.set(event.pid, event.args?.name);
    if (event.ph === 'M' && event.name === 'thread_name') threads.set(key, event.args?.name);
    if (event.ph === 'X' && Number.isFinite(event.ts) && Number.isFinite(event.dur) && event.dur >= 0) events.push(event);
    else if (event.ph === 'B') {
      const stack = stacks.get(key) ?? []; stack.push(event); stacks.set(key, stack);
    } else if (event.ph === 'E') {
      const begin = stacks.get(key)?.pop();
      if (!begin) unmatchedEnds++;
      else if (event.name && event.name !== begin.name) mismatchedEnds++;
      else if (Number.isFinite(begin.ts) && Number.isFinite(event.ts) && event.ts >= begin.ts)
        events.push({ ...begin, dur: event.ts - begin.ts, paired: true });
    }
  }
  const origin = events.reduce((minimum, event) => Math.min(minimum, event.ts), Infinity);
  const eventInfo = event => ({ name: event.name, category: event.cat, phase: event.paired ? 'B/E' : 'X',
    startFromFirstEventMs: (event.ts - origin) / 1000, durationMs: event.dur / 1000 });
  const byThread = new Map();
  for (const event of events) {
    const key = `${event.pid}:${event.tid}`; const list = byThread.get(key) ?? [];
    list.push(event); byThread.set(key, list);
  }
  return { rawEvents: raw.length, durationEvents: events.length, unmatchedEnds, mismatchedEnds,
    unclosedBegins: [...stacks.values()].reduce((count, stack) => count + stack.length, 0),
    asynchronousOrFlowEventsExcludedFromDurations: raw.filter(e => ['b', 'e', 'n', 's', 't', 'f', 'S', 'T', 'F'].includes(e.ph)).length,
    threads: [...byThread].map(([key, list], index) => {
      const ax = list.filter(isAX), tasks = list.filter(isTask);
      const descending = values => [...values].sort((a, b) => b.dur - a.dur);
      const coverage = values => ({ events: values.length, intervalUnionMs: unionMs(values),
        inclusiveSumMs: values.reduce((sum, e) => sum + e.dur, 0) / 1000 });
      return { label: `thread-${index + 1}`, process: processes.get(list[0].pid) ?? 'unnamed', thread: threads.get(key) ?? 'unnamed',
        recorded: coverage(list), accessibilityNameOrCategoryMatch: coverage(ax), taskNameOrCategoryMatch: coverage(tasks),
        longestEvents: descending(list).slice(0, 15).map(eventInfo), longestAXEvents: descending(ax).slice(0, 15).map(eventInfo),
        longestTasks: descending(tasks).slice(0, 15).map(task => ({ ...eventInfo(task),
          overlappingAXIntervalUnionMs: unionMs(ax.filter(e => e.ts < task.ts + task.dur && e.ts + e.dur > task.ts)
            .map(e => ({ ...e, ts: Math.max(e.ts, task.ts), dur: Math.min(e.ts + e.dur, task.ts + task.dur) - Math.max(e.ts, task.ts) }))) })) };
    }).sort((a, b) => b.recorded.intervalUnionMs - a.recorded.intervalUnionMs),
    limits: ['Only complete X and matched synchronous B/E durations are aggregated.',
      'Intervals are unioned per thread; inclusive sums are nested event durations, not CPU time.',
      'Name/category matches are trace evidence labels. Semantic meaning and critical-path causality require inspection.',
      'No common explicit marker links renderer performance.now frameStalls to trace timestamps; alignment is stage-only.'] };
}
function analyzeCPU(profile) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const samples = profile.samples ?? [], deltas = profile.timeDeltas ?? [];
  const weighted = samples.length > 0 && samples.length === deltas.length && deltas.every(Number.isFinite);
  const counts = new Map();
  samples.forEach((id, index) => {
    const item = counts.get(id) ?? { id, samples: 0, sampledSelfMs: weighted ? 0 : null };
    item.samples++; if (weighted) item.sampledSelfMs += deltas[index] / 1000; counts.set(id, item);
  });
  return { samples: samples.length, timeDeltas: deltas.length, weighted,
    topSampledFrames: [...counts.values()].sort((a, b) => weighted ? b.sampledSelfMs - a.sampledSelfMs : b.samples - a.samples).slice(0, 25)
      .map(item => { const frame = nodes.get(item.id)?.callFrame ?? {}; return { ...item, function: frame.functionName,
        module: (frame.url ?? '').split(/[\\/]/).at(-1), zeroBasedLine: frame.lineNumber }; }),
    limit: 'Sampled JS frames and special (program)/(idle)/(garbage collector) buckets do not resolve native AX stack attribution.' };
}
let trace = null;
if (tracePath !== '-') {
  const traced = await cohort(tracePath, 'trace', 1);
  for (const field of ['sha256', 'bytes', 'sourceCommit', 'sourceTree']) assert.equal(traced.manifest.package[field], timing.manifest.package[field]);
  assert.deepEqual(traced.manifest.package.buildReceipt, timing.manifest.package.buildReceipt);
  assert.deepEqual(traced.manifest.scripts, timing.manifest.scripts);
  const { run, data } = traced.samples[0]; const artifacts = [];
  for (const artifact of run.profileArtifacts) {
    const { data: content } = await load(artifact.path, artifact);
    artifacts.push({ file: path.basename(artifact.path), identity: { sha256: artifact.sha256, bytes: artifact.bytes },
      analysis: artifact.path.endsWith('.trace.json') ? analyzeTrace(content) : analyzeCPU(content) });
  }
  trace = { manifestIdentity: traced.identity, featureConfiguration: data.accessibilityConfiguration,
    environmentSnapshots: data.environmentSnapshots, traceConfiguration: data.traceConfiguration,
    measurements: data.measurements, artifacts };
}
const result = { kind: 'offline-accessibility-feature-analysis', generatedAt: new Date().toISOString(),
  helperSha256: sha(await readFile(new URL(import.meta.url))), timingsManifestIdentity: timing.identity,
  sourceIdentity: { sourceCommit: timing.manifest.package.sourceCommit, sourceTree: timing.manifest.package.sourceTree,
    asarSha256: timing.manifest.package.sha256, asarBytes: timing.manifest.package.bytes,
    buildReceiptSha256: timing.manifest.package.buildReceipt.sha256, scripts: timing.manifest.scripts },
  coverageCompleteForExpectedFiniteFields: coverage.every(row => row.complete), coverage,
  featureContrast: contrast, recomputedSummary: recomputed,
  savedBudgetStatus: timing.manifest.summary.budgetStatus, savedViolations: timing.manifest.summary.violations,
  environmentSnapshots: timing.samples.map(sample => ({ label: sample.run.label, ...sample.data.environmentSnapshots })),
  rawFrameStalls: timing.samples.map(sample => ({ label: sample.run.label,
    measurements: sample.data.measurements.map(({ name, frameStalls }) => ({ name, frameStalls })) })), trace,
  limits: ['Five pairs from one fixed package and fixture are descriptive, not a statistical generalization.',
    'Observed adds process features before timers. It is not a native assistive-client run or an activation-cost measurement.',
    'Start/end snapshots do not prove continuous focus, visibility, or feature stability between snapshots.',
    'Row frame metrics are read in successive inspector calls and can include different final frames. Preserve original values.',
    'readingTrace.longTasks covers first open only; trace stages cover open/cards/return, not repeat-open.',
    'Separate profiled trace timings must not replace ordinary timing samples. Lack of reproduced 500ms frames does not explain QA1 A.',
    'Feature contrast and native AX activity cannot alone establish the cause of a specific frame stall.'] };
await writeFile(outputPath, JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output: path.basename(outputPath), coverageComplete: result.coverageCompleteForExpectedFiniteFields,
  contrastEstablished: contrast.every(pair => pair.established), budgetStatus: result.savedBudgetStatus,
  violations: result.savedViolations.length, traceArtifacts: trace?.artifacts.length ?? 0 }));
