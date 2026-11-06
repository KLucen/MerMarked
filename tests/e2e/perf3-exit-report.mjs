import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Functional completion of a sample is separate from meeting a time budget.
// Preserve every observation, including regressions and over-budget values.
const prefix = process.argv[2] ?? 'perf3-exit-ac';
const qa = path.resolve('out/qa');
const summary = { prefix, groups: [], failures: [], preparationFrameWarnings: [] };
function stats(values) {
  const sorted = values.filter(value => typeof value === 'number').sort((a, b) => a - b);
  return sorted.length ? { count: sorted.length, median: sorted[Math.floor(sorted.length / 2)], worst: sorted.at(-1), values } : null;
}
for (const cohort of ['canvas', 'loaded']) {
  const manifest = JSON.parse(await readFile(path.join(qa, `${prefix}-${cohort}-manifest.json`), 'utf8'));
  assert.equal(manifest.status, 'complete', `${cohort} cohort must be complete`);
  assert.equal(manifest.runs.length, 20);
  for (const mib of [1, 5]) for (const role of ['before', 'after']) {
    const runs = manifest.runs.filter(run => run.mib === mib && run.role === role);
    assert.equal(runs.length, 5);
    const samples = await Promise.all(runs.map(async run => {
      assert.equal(run.status, 'passed');
      const data = JSON.parse(await readFile(run.result, 'utf8'));
      assert.equal(data.headings, 200); assert.equal(data.annotations, 500);
      if (cohort === 'canvas') {
        assert.equal(data.retainedHeap.length, 0, 'ordinary timings must not force GC');
        assert.ok(!data.diagnosticOverrides || Object.values(data.diagnosticOverrides).every(value => value === false), 'ordinary samples must use the normal unprofiled product');
      }
      assert.equal(data.measurements.find(row => row.name === 'fit-200-cards').visibleCards, 200);
      return { run, data };
    }));
    const names = samples[0].data.measurements.map(row => row.name);
    const group = { cohort, mib, role, measurements: [] };
    if (cohort === 'loaded') {
      group.sourceEventToFrameMs = stats(samples.map(({ data }) => data.inputTrace.eventToFrameMs));
      assert.equal(group.sourceEventToFrameMs?.count, 5, 'all source input traces must be present');
      if (role === 'after') for (const { run, data } of samples) {
        if (data.inputTrace.eventToFrameMs > 150) summary.failures.push({ cohort, mib, name: 'source-input-next-frame', round: run.round, field: 'inputTrace.eventToFrameMs', value: data.inputTrace.eventToFrameMs, limit: 150 });
      }
    }
    for (const name of names) {
      const rows = samples.map(({ data }) => data.measurements.find(row => row.name === name));
      const row = { name };
      for (const field of ['elapsedMs', 'inputToReadyPaintMs', 'inputToFeedbackPaintMs', 'maxFrameGapMs', 'interactionMaxFrameGapMs', 'preInputMaxFrameGapMs', 'usedHeapMiB']) row[field] = stats(rows.map(value => value[field]));
      row.applicationWorkingSetMiB = stats(rows.map(value => value.application?.reduce((sum, process) => sum + process.workingSetMiB, 0)));
      row.applicationPrivateMiB = stats(rows.map(value => value.application?.reduce((sum, process) => sum + process.privateMiB, 0)));
      group.measurements.push(row);
      for (const field of ['elapsedMs', 'maxFrameGapMs', 'usedHeapMiB']) assert.equal(row[field]?.count, 5, `${cohort}/${name}/${field} must be complete`);
      if (name !== 'annotations-ready' && !name.startsWith('canvas-drag-')) assert.equal(row.inputToReadyPaintMs?.count, 5, `${cohort}/${name} must include all actual input timings`);
      if (cohort === 'canvas' && name === 'open-reader') assert.equal(row.inputToFeedbackPaintMs?.count, 5);
      if (role !== 'after') continue;
      for (let index = 0; index < rows.length; index++) {
        const sample = rows[index];
        const check = (field, limit) => {
          if (typeof sample[field] === 'number' && sample[field] > limit) summary.failures.push({ cohort, mib, name, round: samples[index].run.round, field, value: sample[field], limit });
        };
        // Keep the original whole automation-window gaps. The interaction budget
        // starts at the first actual input; preparatory CDP frames precede it.
        // A frame spanning input contributes its post-input portion. Legacy
        // samples without timestamps retain the original, stricter whole window.
        if (typeof sample.interactionMaxFrameGapMs === 'number') {
          check('interactionMaxFrameGapMs', 100);
          if (sample.maxFrameGapMs > 100 && sample.interactionMaxFrameGapMs <= 100) summary.preparationFrameWarnings.push({
            cohort, mib, name, round: samples[index].run.round, maxFrameGapMs: sample.maxFrameGapMs,
            preInputMaxFrameGapMs: sample.preInputMaxFrameGapMs, interactionMaxFrameGapMs: sample.interactionMaxFrameGapMs,
          });
        } else check('maxFrameGapMs', 100);
        check('inputToFeedbackPaintMs', 100);
        if (['switch-source', 'switch-200-cards', 'return-reader'].includes(name)) check('inputToReadyPaintMs', 300);
        if (name === 'canvas-search' || name === 'open-find' || name.startsWith('reader-find')) check('inputToReadyPaintMs', 200);
        if (name === 'source-input-next-frame') check('inputToReadyPaintMs', 150);
      }
      if (mib === 5 && ['open-reader', 'repeat-open-reader'].includes(name) && row.elapsedMs.median > 3000) summary.failures.push({ cohort, mib, name, field: 'median elapsedMs', value: row.elapsedMs.median, limit: 3000 });
    }
    summary.groups.push(group);
  }
}
summary.budgetStatus = summary.failures.length ? 'not-met' : 'met-for-recorded-actions';
summary.note = 'Automation wall clock, full-window frame gaps, pre-input gaps and actual-input interaction gaps are retained separately. The 100 ms normal-interaction budget uses only time at/after actual input, including a spanning frame remainder; actions without input use measurement start. Legacy samples keep full-window gating. This report does not cover pending cancellation, GC cycles, functional regressions or package acceptance.';
await writeFile(path.join(qa, `${prefix}-measurements.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ budgetStatus: summary.budgetStatus, failures: summary.failures }, null, 2));
if (summary.failures.length) process.exitCode = 1;
