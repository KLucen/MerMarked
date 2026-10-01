import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makeAnnotationAnchor } from '../../src/core/annotation-anchor.ts';
import { parseAnnotationYaml, serializeAnnotationYaml } from '../../src/core/annotations.ts';
import { parseCanvasJson, reconcileCanvasState, serializeCanvasJson } from '../../src/core/canvas-state.ts';
import { encodeMarkdownBytes } from '../../src/core/markdown-source.ts';
import { listDocumentTransactions } from '../../src/main/document-transaction.ts';
import { MarkdownEditorSession } from '../../src/main/markdown-editor-session.ts';
import { assertStructureBaseline, bundleDigest, prepareSectionStructurePlan } from '../../src/main/section-structure-store.ts';

async function fixture(withSidecars = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-structure-'));
  const documentPath = path.join(root, 'doc.md');
  const content = '# A\r\n重复😀。\r\n## B\r\n重复😀。\r\n### C\r\n后代正文。\r\n# D\r\n末节正文。\r\n';
  const bytes = encodeMarkdownBytes(content, 3);
  const document = { path: documentPath, name: 'doc.md', content, sourceSha256: bundleDigest(bytes)!, bomByteLength: 3 as const };
  await writeFile(documentPath, bytes);
  const source = { content, bytes, sha256: document.sourceSha256 };
  const reconciled = await reconcileCanvasState(null, source, (() => { let id = 0; return () => `card-${id++}`; })());
  const canvas = { ...reconciled.model, links: [{ id: 'arrow', from: 'card-2', to: 'card-3', label: '保留关系' }] };
  const annotations = { schemaVersion: 1 as const, source: { sha256: source.sha256, encoding: 'utf-8' as const, coordinateSystem: 'utf8-byte' as const }, tags: [],
    annotations: [content.indexOf('重复😀'), content.lastIndexOf('重复😀')].map((start, i) => {
      const startByte = 3 + Buffer.byteLength(content.slice(0, start));
      return { id: `note-${i}`, kind: 'note' as const, note: `便签${i}`, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
        anchor: makeAnnotationAnchor(content, 3, source.sha256, { startByte, endByte: startByte + Buffer.byteLength('重复😀'), sourceExact: '重复😀', displayQuote: '重复😀' }) };
    }) };
  if (withSidecars) {
    await writeFile(`${documentPath}.annotations.yaml`, serializeAnnotationYaml(annotations));
    await writeFile(`${documentPath}.mermarkd.json`, serializeCanvasJson(canvas));
  }
  return { root, document, canvas, annotations, draftDirectory: path.join(root, 'drafts') };
}
async function clean(root: string) { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 40 }); }

test('preview, confirmation, undo/redo and dirty canvas projection do not change three-file bytes or mtimes', async () => {
  const f = await fixture();
  try {
    const paths = [f.document.path, `${f.document.path}.annotations.yaml`, `${f.document.path}.mermarkd.json`];
    const before = await Promise.all(paths.map(async (name) => ({ bytes: await readFile(name), mtime: (await stat(name)).mtimeMs })));
    const plan = await prepareSectionStructurePlan(f.document, { kind: 'move', sourceIndex: 1, targetIndex: 3 });
    assert.equal(plan.impact.mappedCount, 2);
    const editor = await MarkdownEditorSession.create(f.document, f.draftDirectory);
    const staged = await editor.stageSectionStructure(plan);
    assert.equal(staged.dirty, true); assert.equal(staged.revision, 1);
    assert.deepEqual(parseCanvasJson(Buffer.from(editor.structureCanvas!).toString()).links, f.canvas.links);
    editor.update({ epoch: editor.epoch, revision: 2, content: f.document.content });
    assert.equal(editor.dirty, false); assert.equal(editor.structureCanvas, undefined);
    editor.update({ epoch: editor.epoch, revision: 3, content: plan.preview.candidate });
    await editor.persistDraft({ epoch: editor.epoch, revision: 3, content: plan.preview.candidate });
    for (let i = 0; i < paths.length; i++) {
      assert.deepEqual(await readFile(paths[i]), before[i].bytes); assert.equal((await stat(paths[i])).mtimeMs, before[i].mtime);
    }
    assert.equal((await listDocumentTransactions(f.document.path)).length, 0);
    const saved = await editor.save({ epoch: editor.epoch, revision: 3, content: plan.preview.candidate });
    assert.equal(saved.status, 'saved'); assert.equal(saved.editor.dirty, false);
    assert.deepEqual(await readFile(f.document.path), Buffer.from(plan.after.markdown));
    const yaml = parseAnnotationYaml(await readFile(paths[1], 'utf8'));
    assert.ok(yaml.annotations[1].anchor.startByte > yaml.annotations[0].anchor.startByte);
    for (const item of yaml.annotations) assert.equal(item.anchor.basisSha256, bundleDigest(plan.after.markdown));
    const canvas = parseCanvasJson(await readFile(paths[2], 'utf8'));
    assert.deepEqual(canvas.links, f.canvas.links);
    assert.deepEqual(canvas.cards.map((card) => card.id), f.canvas.cards.map((card) => card.id));
    assert.deepEqual(canvas.cards[1].anchor.kind === 'heading' && canvas.cards[1].anchor.titlePath, ['D', 'B']);
    assert.equal((await listDocumentTransactions(f.document.path))[0].status, 'committed');
  } finally { await clean(f.root); }
});

test('every independently versioned file is rechecked after preview and before structural save', async () => {
  for (const suffix of ['', '.annotations.yaml', '.mermarkd.json']) {
    const f = await fixture();
    try {
      const plan = await prepareSectionStructurePlan(f.document, { kind: 'move', sourceIndex: 1, targetIndex: 3 });
      const editor = await MarkdownEditorSession.create(f.document, f.draftDirectory);
      const name = f.document.path + suffix;
      const external = Buffer.concat([await readFile(name), Buffer.from('\r\n')]);
      await writeFile(name, external);
      await assert.rejects(assertStructureBaseline(f.document.path, plan.before));
      await assert.rejects(editor.stageSectionStructure(plan)); assert.equal(editor.dirty, false);
      await writeFile(name, plan.before[suffix === '' ? 'markdown' : suffix === '.annotations.yaml' ? 'annotations' : 'canvas']!);
      const staged = await editor.stageSectionStructure(plan);
      await writeFile(name, external);
      const saved = await editor.save({ epoch: editor.epoch, revision: staged.revision, content: staged.content });
      assert.equal(saved.status, 'conflict'); assert.equal(saved.editor.dirty, true);
      assert.deepEqual(await readFile(name), external);
      assert.equal((await listDocumentTransactions(f.document.path)).length, 0);
    } finally { await clean(f.root); }
  }
});

test('additional source edits keep ambiguous moved annotations and links unresolved rather than guessing', async () => {
  const f = await fixture();
  try {
    const plan = await prepareSectionStructurePlan(f.document, { kind: 'move', sourceIndex: 1, targetIndex: 3 });
    const editor = await MarkdownEditorSession.create(f.document, f.draftDirectory);
    await editor.stageSectionStructure(plan);
    const content = plan.preview.candidate + '新增正文\r\n';
    const result = await editor.save({ epoch: editor.epoch, revision: 2, content });
    assert.equal(result.status, 'saved');
    const yaml = parseAnnotationYaml(await readFile(`${f.document.path}.annotations.yaml`, 'utf8'));
    assert.deepEqual(yaml.annotations[1].anchor, f.annotations.annotations[1].anchor);
    const canvas = parseCanvasJson(await readFile(`${f.document.path}.mermarkd.json`, 'utf8'));
    const reconciled = await reconcileCanvasState(canvas, { content, bytes: encodeMarkdownBytes(content, 3), sha256: bundleDigest(encodeMarkdownBytes(content, 3))! });
    assert.ok(reconciled.unresolvedLinkIds.includes('arrow'));
  } finally { await clean(f.root); }
});

test('discard and undo-to-baseline save keep source unchanged; missing sidecars remain absent', async () => {
  const f = await fixture(false);
  try {
    const plan = await prepareSectionStructurePlan(f.document, { kind: 'move', sourceIndex: 1, targetIndex: 3 });
    const editor = await MarkdownEditorSession.create(f.document, f.draftDirectory);
    await editor.stageSectionStructure(plan); await editor.discardChanges();
    assert.equal(editor.dirty, false); assert.equal(editor.hasStructureEdit, false);
    await editor.stageSectionStructure(plan);
    const saved = await editor.save({ epoch: editor.epoch, revision: editor.view().revision + 1, content: f.document.content });
    assert.equal(saved.status, 'saved'); if (saved.status === 'saved') assert.equal(saved.changed, false);
    assert.deepEqual(await readFile(f.document.path), plan.before.markdown);
    await editor.stageSectionStructure(plan);
    const result = await editor.save({ epoch: editor.epoch, revision: editor.view().revision, content: editor.view().content });
    assert.equal(result.status, 'saved');
    await assert.rejects(stat(`${f.document.path}.annotations.yaml`), { code: 'ENOENT' });
    await assert.rejects(stat(`${f.document.path}.mermarkd.json`), { code: 'ENOENT' });
  } finally { await clean(f.root); }
});
