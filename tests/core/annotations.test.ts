import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  classifyAnnotationAnchor,
  classifyAnnotationAnchors,
  MAX_ANNOTATION_YAML_BYTES,
  parseAnnotationYaml,
  serializeAnnotationYaml,
  type AnnotationSidecar,
} from '../../src/core/annotations.ts';

const bytes = Buffer.from('\uFEFF# 示例\r\n这里有 **关键结论**，关键结论。\r\n', 'utf8');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const phrase = Buffer.from('**关键结论**', 'utf8');
const startByte = bytes.indexOf(phrase);

function sample(): AnnotationSidecar {
  return {
    schemaVersion: 1,
    source: { sha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' },
    tags: [{ id: 'tag-question', name: '疑问' }],
    annotations: [{
      id: 'annotation-1', kind: 'note', color: 'amber',
      anchor: {
        basisSha256: sha256,
        startByte,
        endByte: startByte + phrase.length,
        sourceExact: '**关键结论**',
        prefix: '这里有 ',
        suffix: '，关键结论。',
        displayQuote: '关键结论',
        sectionHint: '示例',
      },
      note: '需要继续核对这个判断。\n第二行。',
      tagId: 'tag-question',
      createdAt: '2026-09-17T10:00:00Z',
      updatedAt: '2026-09-17T10:00:00Z',
    }],
  };
}

test('version 1 YAML roundtrips Chinese text, raw Markdown anchor, and stable order', () => {
  const original = sample();
  const yaml = serializeAnnotationYaml(original);
  assert.match(yaml, /^schemaVersion: 1\nsource:\n/);
  assert.match(yaml, /tags:\n[\s\S]*annotations:\n/);
  assert.deepEqual(parseAnnotationYaml(yaml), original);
  assert.equal(serializeAnnotationYaml(parseAnnotationYaml(yaml)), yaml);
  assert.equal(yaml.endsWith('\n'), true);
});

test('editing one note keeps all unrelated canonical YAML lines unchanged', () => {
  const sidecar = sample();
  sidecar.annotations.push({
    ...sidecar.annotations[0],
    id: 'annotation-2',
    kind: 'highlight',
    note: undefined,
    tagId: undefined,
  });
  const before = serializeAnnotationYaml(sidecar);
  sidecar.annotations[0].note = '新的阅读想法。';
  const after = serializeAnnotationYaml(sidecar);
  const first = before.split('\n');
  const second = after.split('\n');
  // A multiline note may change its own line count; the later record must remain byte-identical.
  const secondRecord = '  - id: annotation-2\n';
  assert.equal(before.slice(before.indexOf(secondRecord)), after.slice(after.indexOf(secondRecord)));
  assert.equal(first.slice(0, first.findIndex((line) => line.startsWith('    note:'))).join('\n'),
    second.slice(0, second.findIndex((line) => line.startsWith('    note:'))).join('\n'));
});

test('rejects destructive or hostile YAML rather than discarding unsupported syntax', () => {
  const valid = serializeAnnotationYaml(sample());
  const invalid = [
    valid.replace('schemaVersion: 1', 'schemaVersion: 2'),
    valid.replace('schemaVersion: 1', 'schemaVersion: 1\nschemaVersion: 1'),
    valid.replace('schemaVersion: 1', 'schemaVersion: 1\nunknown: true'),
    valid.replace('schemaVersion: 1', '# keep this user comment\nschemaVersion: 1'),
    valid.replace('schemaVersion: 1', 'schemaVersion: 1 # keep this user comment'),
    valid.replace('tags:\n', 'tags: # keep nested comment\n'),
    valid.replace('  - id: tag-question', '  - id: tag-question # keep pair comment'),
    valid.replace('annotations:\n', 'annotations:\n  # keep sequence comment\n'),
    valid.replace('schemaVersion: 1', 'schemaVersion: &version 1'),
    valid.replace('schemaVersion: 1', 'schemaVersion: !!int 1'),
    valid.replace('schemaVersion: 1', 'schemaVersion: !custom 1'),
    valid.replace('schemaVersion: 1', 'schemaVersion: *version'),
    `---\n${valid}`,
    `%YAML 1.1\n---\n${valid}`,
    `%TAG !foo! tag:example.org,2026:\n---\n${valid}`,
    `${valid}---\nschemaVersion: 1\n`,
    valid.replace('schemaVersion: 1', 'schemaVersion: 1\n__proto__: { polluted: yes }'),
    'schemaVersion: 1\nsource: [1, 2, 3]\ntags: []\nannotations: []\n',
    'a:\n  b:\n    c:\n      d:\n        e:\n          f:\n            g:\n              h:\n                i:\n                  j: too-deep\n',
    ' '.repeat(MAX_ANNOTATION_YAML_BYTES + 1),
  ];
  for (const [index, yaml] of invalid.entries()) {
    assert.notEqual(yaml, valid, `case ${index} must alter the valid fixture`);
    assert.throws(() => parseAnnotationYaml(yaml), undefined, `case ${index}`);
  }
});

test('rejects duplicate IDs, bad references, invalid ranges and unsupported fields', () => {
  const bad: AnnotationSidecar[] = [];
  {
    const value = sample();
    value.tags.push({ ...value.tags[0] });
    bad.push(value);
  }
  {
    const value = sample();
    value.annotations.push({ ...value.annotations[0] });
    bad.push(value);
  }
  {
    const value = sample();
    value.annotations[0].tagId = 'missing';
    bad.push(value);
  }
  {
    const value = sample();
    value.annotations[0].anchor.endByte += 1;
    bad.push(value);
  }
  {
    const value = sample();
    value.annotations[0].createdAt = '2026-02-30T10:00:00Z';
    bad.push(value);
  }
  {
    const value = sample();
    Object.assign(value.annotations[0], { invented: 'field' });
    bad.push(value);
  }
  for (const value of bad) assert.throws(() => serializeAnnotationYaml(value));
});

test('a stale source hash or byte mismatch keeps the anchor unresolved', async () => {
  const anchor = sample().annotations[0].anchor;
  assert.equal(await classifyAnnotationAnchor(anchor, bytes), 'resolved');
  assert.equal(await classifyAnnotationAnchor({ ...anchor, basisSha256: '0'.repeat(64) }, bytes), 'unresolved');
  const changed = Buffer.from(bytes);
  changed[startByte] = 0x58;
  assert.equal(await classifyAnnotationAnchor(anchor, changed), 'unresolved');
  const changedOutsideAnchor = Buffer.from(bytes);
  changedOutsideAnchor[bytes.length - 3] = 0x58;
  assert.equal(await classifyAnnotationAnchor(anchor, changedOutsideAnchor), 'unresolved');
  assert.equal(await classifyAnnotationAnchor({ ...anchor, startByte: 1 }, bytes), 'unresolved');
  assert.equal(await classifyAnnotationAnchor({ ...anchor, displayQuote: 'visible text differs' }, bytes), 'resolved');
  assert.equal(await classifyAnnotationAnchor({
    ...anchor, startByte: 0, endByte: 3, sourceExact: '\uFEFF',
  }, bytes), 'resolved');
});

test('batch classification preserves anchor order and freezes all anchors after an outside edit', async () => {
  const anchor = sample().annotations[0].anchor;
  const anchors = [
    anchor,
    { ...anchor, basisSha256: '0'.repeat(64) },
    { ...anchor, startByte: anchor.startByte + 1 },
    { ...anchor, displayQuote: '可见文本与源码不同' },
  ];
  assert.deepEqual(await classifyAnnotationAnchors(anchors, bytes),
    ['resolved', 'unresolved', 'unresolved', 'resolved']);
  const edited = Buffer.from(bytes);
  edited[bytes.length - 3] = 0x58;
  assert.deepEqual(await classifyAnnotationAnchors(anchors, edited),
    ['unresolved', 'unresolved', 'unresolved', 'unresolved']);
  assert.deepEqual(await classifyAnnotationAnchors([], bytes), []);
});
