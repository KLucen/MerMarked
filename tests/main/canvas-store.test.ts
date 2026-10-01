import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadCanvasFile, saveCanvasFile } from '../../src/main/canvas-store.ts';
import { reconcileCanvasState } from '../../src/core/canvas-state.ts';
import { serializeAnnotationYaml } from '../../src/core/annotations.ts';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-canvas-store-'));
  const documentPath = path.join(directory, 'doc.md');
  const content = '# A\nbody\n# B\nother\n';
  const bytes = Buffer.from(content);
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(documentPath, bytes);
  let next = 0;
  const { model } = await reconcileCanvasState(null, { bytes, content, sha256: sourceSha256 }, () => `card-${next++}`);
  return { directory, documentPath, sourceSha256, model, bytes };
}

test('canvas saves only JSON and keeps Markdown and annotation bytes unchanged', async () => {
  const { directory, documentPath, sourceSha256, model, bytes } = await fixture();
  try {
    const annotations = serializeAnnotationYaml({ schemaVersion: 1, source: { sha256: sourceSha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' }, tags: [], annotations: [] });
    await writeFile(`${documentPath}.annotations.yaml`, annotations);
    assert.equal((await loadCanvasFile(documentPath)).model, null);
    const saved = await saveCanvasFile({ documentPath, sourceSha256, expectedSidecarSha256: null, model });
    assert.equal(saved.status, 'saved');
    assert.deepEqual(await readFile(documentPath), bytes);
    assert.equal(await readFile(`${documentPath}.annotations.yaml`, 'utf8'), annotations);
    const loaded = await loadCanvasFile(documentPath);
    assert.deepEqual(loaded.model, model);
    assert.equal(loaded.sidecarSha256, saved.sidecarSha256);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('external Markdown or JSON changes win over a stale canvas save', async () => {
  const { directory, documentPath, sourceSha256, model } = await fixture();
  try {
    const first = await saveCanvasFile({ documentPath, sourceSha256, expectedSidecarSha256: null, model });
    await writeFile(`${documentPath}.mermarkd.json`, 'external JSON');
    assert.equal((await saveCanvasFile({ documentPath, sourceSha256, expectedSidecarSha256: first.sidecarSha256!, model })).status, 'conflict');
    assert.equal(await readFile(`${documentPath}.mermarkd.json`, 'utf8'), 'external JSON');
    await writeFile(documentPath, '# External\n');
    assert.equal((await saveCanvasFile({ documentPath, sourceSha256, expectedSidecarSha256: null, model })).status, 'conflict');
    assert.equal(await readFile(documentPath, 'utf8'), '# External\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
