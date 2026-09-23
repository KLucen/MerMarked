import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { serializeAnnotationYaml } from '../../src/core/annotations.ts';
import { loadAnnotationFile, saveAnnotationFile } from '../../src/main/annotation-store.ts';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-annotations-'));
  const documentPath = path.join(directory, 'sample.md');
  const draftDirectory = path.join(directory, 'app-data', 'annotation-drafts');
  const markdown = Buffer.from('# 标题\r\n含有 😀。\r\n', 'utf8');
  await writeFile(documentPath, markdown);
  return { directory, documentPath, draftDirectory, markdown };
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validYaml(sourceSha256: string, tag?: string): string {
  return serializeAnnotationYaml({
    schemaVersion: 1,
    source: { sha256: sourceSha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' },
    tags: tag ? [{ id: `tag-${digest(Buffer.from(tag)).slice(0, 12)}`, name: tag }] : [],
    annotations: [],
  });
}

test('sidecar creates on first save and reopens without changing Markdown bytes', async () => {
  const f = await fixture();
  try {
    const initial = await loadAnnotationFile(f.documentPath, f.draftDirectory);
    assert.equal(initial.sidecarPath, `${f.documentPath}.annotations.yaml`);
    assert.equal(initial.sidecarText, null);
    assert.equal(initial.sidecarSha256, null);
    assert.equal(initial.sourceSha256, digest(f.markdown));
    assert.deepEqual(initial.pendingDrafts, []);

    const yaml = validYaml(initial.sourceSha256);
    const result = await saveAnnotationFile({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      expectedSourceSha256: initial.sourceSha256,
      expectedSidecarSha256: initial.sidecarSha256,
      text: yaml,
    });
    assert.equal(result.status, 'saved');
    const reopened = await loadAnnotationFile(f.documentPath, f.draftDirectory);
    assert.equal(reopened.sidecarText, yaml);
    assert.equal(reopened.sidecarSha256, digest(Buffer.from(yaml)));
    assert.deepEqual(await readFile(f.documentPath), f.markdown);
    assert.deepEqual(reopened.pendingDrafts, []);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('changed Markdown blocks sidecar save and preserves candidate as a separate draft', async () => {
  const f = await fixture();
  try {
    const baseline = await loadAnnotationFile(f.documentPath, f.draftDirectory);
    const changed = Buffer.from('# 新标题\r\n含有 😀。\r\n', 'utf8');
    await writeFile(f.documentPath, changed);
    const candidate = validYaml(baseline.sourceSha256, 'source');
    const result = await saveAnnotationFile({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      expectedSourceSha256: baseline.sourceSha256,
      expectedSidecarSha256: baseline.sidecarSha256,
      text: candidate,
    });
    assert.equal(result.status, 'conflict');
    if (result.status !== 'conflict') return;
    assert.equal(result.reason, 'source-changed');
    assert.equal(await readFile(`${f.documentPath}.annotations.yaml`).catch(() => null), null);
    assert.deepEqual(await readFile(f.documentPath), changed);
    const reopened = await loadAnnotationFile(f.documentPath, f.draftDirectory);
    assert.equal(reopened.pendingDrafts.length, 1);
    assert.equal(reopened.pendingDrafts[0].text, candidate);
    assert.equal(reopened.pendingDrafts[0].path, result.draftPath);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('external sidecar edit blocks overwrite and preserves candidate draft', async () => {
  const f = await fixture();
  try {
    const sidecarPath = `${f.documentPath}.annotations.yaml`;
    await writeFile(sidecarPath, 'external: before\n');
    const baseline = await loadAnnotationFile(f.documentPath, f.draftDirectory);
    await writeFile(sidecarPath, 'external: after\n');
    const candidate = validYaml(baseline.sourceSha256, 'safe');
    const result = await saveAnnotationFile({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      expectedSourceSha256: baseline.sourceSha256,
      expectedSidecarSha256: baseline.sidecarSha256,
      text: candidate,
    });
    assert.equal(result.status, 'conflict');
    if (result.status !== 'conflict') return;
    assert.equal(result.reason, 'sidecar-changed');
    assert.equal(await readFile(sidecarPath, 'utf8'), 'external: after\n');
    assert.equal((await loadAnnotationFile(f.documentPath, f.draftDirectory)).pendingDrafts[0].text, candidate);
    assert.deepEqual(await readFile(f.documentPath), f.markdown);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('cooperating concurrent saves cannot silently overwrite and retain the losing candidate', async () => {
  const f = await fixture();
  try {
    const baseline = await loadAnnotationFile(f.documentPath, f.draftDirectory);
    const common = {
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      expectedSourceSha256: baseline.sourceSha256,
      expectedSidecarSha256: baseline.sidecarSha256,
    };
    const aText = validYaml(baseline.sourceSha256, 'A');
    const bText = validYaml(baseline.sourceSha256, 'B');
    const results = await Promise.all([
      saveAnnotationFile({ ...common, text: aText }),
      saveAnnotationFile({ ...common, text: bText }),
    ]);
    assert.equal(results.filter((result) => result.status === 'saved').length, 1);
    assert.equal(results.filter((result) => result.status === 'conflict').length, 1);
    const persisted = await readFile(`${f.documentPath}.annotations.yaml`, 'utf8');
    assert.ok(persisted === aText || persisted === bText);
    const reopened = await loadAnnotationFile(f.documentPath, f.draftDirectory);
    assert.equal(reopened.pendingDrafts.length, 1);
    assert.notEqual(reopened.pendingDrafts[0].text, persisted);
    assert.deepEqual(await readFile(f.documentPath), f.markdown);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('simulated read-only replacement keeps candidate in app-data draft and clears temp/lock', async () => {
  const f = await fixture();
  try {
    const baseline = await loadAnnotationFile(f.documentPath, f.draftDirectory);
    const candidate = validYaml(baseline.sourceSha256, 'retained');
    const result = await saveAnnotationFile({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      expectedSourceSha256: baseline.sourceSha256,
      expectedSidecarSha256: baseline.sidecarSha256,
      text: candidate,
    }, {
      replaceSidecar: async () => {
        throw Object.assign(new Error('read only'), { code: 'EACCES' });
      },
    });
    assert.equal(result.status, 'pending-draft');
    if (result.status !== 'pending-draft') return;
    assert.equal(result.reason, 'read-only');
    assert.equal(await readFile(result.draftPath, 'utf8').then((text) => JSON.parse(text).text), candidate);
    assert.equal((await loadAnnotationFile(f.documentPath, f.draftDirectory)).pendingDrafts[0].text, candidate);
    assert.equal(await readFile(`${f.documentPath}.annotations.yaml`).catch(() => null), null);
    assert.deepEqual(await readFile(f.documentPath), f.markdown);
    assert.deepEqual((await readdir(f.directory)).filter((name) => name.includes('.lock') || name.endsWith('.tmp')), []);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('1 MiB byte cap rejects oversized sidecar reads and candidate writes', async () => {
  const f = await fixture();
  try {
    const baseline = await loadAnnotationFile(f.documentPath, f.draftDirectory);
    const oversized = 'x'.repeat(1024 * 1024 + 1);
    await assert.rejects(saveAnnotationFile({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      expectedSourceSha256: baseline.sourceSha256,
      expectedSidecarSha256: null,
      text: oversized,
    }), /1 MiB/);
    assert.equal(await readFile(`${f.documentPath}.annotations.yaml`).catch(() => null), null);
    await writeFile(`${f.documentPath}.annotations.yaml`, oversized);
    await assert.rejects(loadAnnotationFile(f.documentPath, f.draftDirectory), /1 MiB/);
    assert.deepEqual(await readFile(f.documentPath), f.markdown);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('invalid candidate YAML or a mismatched source fingerprint never reaches disk', async () => {
  const f = await fixture();
  try {
    const baseline = await loadAnnotationFile(f.documentPath, f.draftDirectory);
    const input = {
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      expectedSourceSha256: baseline.sourceSha256,
      expectedSidecarSha256: baseline.sidecarSha256,
    };
    await assert.rejects(saveAnnotationFile({ ...input, text: 'unknown: value\n' }), /批注 YAML 无效/);
    await assert.rejects(saveAnnotationFile({ ...input, text: validYaml('0'.repeat(64)) }), /摘要与保存基线不一致/);
    assert.equal(await readFile(`${f.documentPath}.annotations.yaml`).catch(() => null), null);
    assert.deepEqual((await loadAnnotationFile(f.documentPath, f.draftDirectory)).pendingDrafts, []);
    assert.deepEqual(await readFile(f.documentPath), f.markdown);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('existing unknown or stale sidecar cannot be overwritten even with its exact byte baseline', async () => {
  const f = await fixture();
  try {
    const sidecarPath = `${f.documentPath}.annotations.yaml`;
    const candidate = validYaml(digest(f.markdown), 'safe');
    for (const [existing, expectedReason] of [
      ['schemaVersion: 2\n', 'sidecar-invalid'],
      [validYaml('0'.repeat(64)), 'sidecar-source-mismatch'],
    ] as const) {
      await writeFile(sidecarPath, existing);
      const baseline = await loadAnnotationFile(f.documentPath, f.draftDirectory);
      const result = await saveAnnotationFile({
        documentPath: f.documentPath,
        draftDirectory: f.draftDirectory,
        expectedSourceSha256: baseline.sourceSha256,
        expectedSidecarSha256: baseline.sidecarSha256,
        text: candidate,
      });
      assert.equal(result.status, 'conflict');
      if (result.status === 'conflict') assert.equal(result.reason, expectedReason);
      assert.equal(await readFile(sidecarPath, 'utf8'), existing);
    }
    const reopened = await loadAnnotationFile(f.documentPath, f.draftDirectory);
    assert.equal(reopened.pendingDrafts.length, 2);
    assert.deepEqual(await readFile(f.documentPath), f.markdown);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('reviewed relocation can migrate an exact stale sidecar baseline to the current source hash', async () => {
  const f = await fixture();
  try {
    const oldSourceSha256 = digest(f.markdown);
    const sidecarPath = `${f.documentPath}.annotations.yaml`;
    const staleText = validYaml(oldSourceSha256, '旧标签');
    await writeFile(sidecarPath, staleText);
    const changed = Buffer.from('# 新标题\r\n含有 😀。\r\n', 'utf8');
    await writeFile(f.documentPath, changed);

    const baseline = await loadAnnotationFile(f.documentPath, f.draftDirectory);
    const currentSourceSha256 = digest(changed);
    assert.equal(baseline.sourceSha256, currentSourceSha256);
    const candidate = validYaml(currentSourceSha256, '已重定位');
    const result = await saveAnnotationFile({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      expectedSourceSha256: currentSourceSha256,
      expectedSidecarSha256: baseline.sidecarSha256,
      expectedExistingSourceSha256: oldSourceSha256,
      text: candidate,
    });

    assert.equal(result.status, 'saved');
    assert.equal(await readFile(sidecarPath, 'utf8'), candidate);
    assert.deepEqual(await readFile(f.documentPath), changed);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('reviewed relocation still rejects a wrong old-source claim and preserves its complete draft', async () => {
  const f = await fixture();
  try {
    const oldSourceSha256 = digest(f.markdown);
    const sidecarPath = `${f.documentPath}.annotations.yaml`;
    const staleText = validYaml(oldSourceSha256, '旧标签');
    await writeFile(sidecarPath, staleText);
    const changed = Buffer.from('# 新标题\r\n含有 😀。\r\n', 'utf8');
    await writeFile(f.documentPath, changed);
    const baseline = await loadAnnotationFile(f.documentPath, f.draftDirectory);
    const currentSourceSha256 = digest(changed);
    const candidate = validYaml(currentSourceSha256, '候选');

    const result = await saveAnnotationFile({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      expectedSourceSha256: currentSourceSha256,
      expectedSidecarSha256: baseline.sidecarSha256,
      expectedExistingSourceSha256: '0'.repeat(64),
      text: candidate,
    });

    assert.equal(result.status, 'conflict');
    if (result.status !== 'conflict') return;
    assert.equal(result.reason, 'sidecar-source-mismatch');
    assert.equal(await readFile(sidecarPath, 'utf8'), staleText);
    const draft = (await loadAnnotationFile(f.documentPath, f.draftDirectory)).pendingDrafts.at(-1);
    assert.equal(draft?.text, candidate);
    assert.equal(draft?.expectedExistingSourceSha256, '0'.repeat(64));
    assert.deepEqual(await readFile(f.documentPath), changed);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('malformed and oversized drafts are reported without blocking a valid sidecar or draft', async () => {
  const f = await fixture();
  try {
    const sidecarPath = `${f.documentPath}.annotations.yaml`;
    await writeFile(sidecarPath, 'schemaVersion: 1\n');
    const baseline = await loadAnnotationFile(f.documentPath, f.draftDirectory);
    await writeFile(sidecarPath, 'schemaVersion: 1\n# external edit\n');
    const candidate = validYaml(baseline.sourceSha256, 'retained');
    const conflict = await saveAnnotationFile({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      expectedSourceSha256: baseline.sourceSha256,
      expectedSidecarSha256: baseline.sidecarSha256,
      text: candidate,
    });
    assert.equal(conflict.status, 'conflict');
    const prefix = `${digest(Buffer.from(baseline.documentPath, 'utf8'))}.annotations.pending.`;
    const brokenPath = path.join(f.draftDirectory, `${prefix}broken.json`);
    const oversizedPath = path.join(f.draftDirectory, `${prefix}oversized.json`);
    await writeFile(brokenPath, '{broken');
    await writeFile(oversizedPath, 'x'.repeat(7 * 1024 * 1024));

    const reopened = await loadAnnotationFile(f.documentPath, f.draftDirectory);
    assert.equal(reopened.sidecarText, 'schemaVersion: 1\n# external edit\n');
    assert.equal(reopened.pendingDrafts.length, 1);
    assert.equal(reopened.pendingDrafts[0].text, candidate);
    assert.deepEqual(reopened.unreadableDraftPaths.sort(), [brokenPath, oversizedPath].sort());
    assert.deepEqual(await readFile(f.documentPath), f.markdown);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
