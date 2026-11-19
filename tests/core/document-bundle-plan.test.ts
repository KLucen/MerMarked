import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_DOCUMENT_BUNDLE_IMAGES, planDocumentBundle } from '../../src/core/document-bundle-plan.ts';

const empty = { portable: true, images: [], remoteReferenceCount: 0, blockedReferenceCount: 0,
  htmlNodeCount: 0, unsupportedExtensionCount: 0 };
const link = (value: string) => `[resource](<${value}>)`;

test('plain text, empty documents and current-document destinations need no resources', async () => {
  for (const content of ['', '# 中文 😀\n\n普通文字。', '[本页]() [章节](#标题) ![empty]()']) {
    assert.deepEqual(await planDocumentBundle(content), empty);
  }
});

test('supported raster images and image links form a source-ordered unique plan', async () => {
  const content = '![one](images/a.png) [view](images/b.JPG) ![again](images/a.png)\n\n' +
    '![gif](images/c.gif) ![webp](d.webp) ![jpeg](e.jpeg)';
  assert.deepEqual(await planDocumentBundle(content), {
    ...empty, images: ['images/a.png', 'images/b.JPG', 'images/c.gif', 'd.webp', 'e.jpeg'].map(path => ({ path })),
  });
});

test('local reference definitions are included whether reused, unused or duplicated', async () => {
  const content = '[read][pic] ![show][PIC]\n\n[pic]: images/one.png\n[unused]: images/two.png\n[pic]: images/three.png';
  assert.deepEqual((await planDocumentBundle(content)).images, [
    { path: 'images/one.png' }, { path: 'images/two.png' }, { path: 'images/three.png' },
  ]);
});

test('references in quotes, nested lists, GFM tables and footnotes are traversed', async () => {
  const content = '> ![quote](quote.png)\n\n- [list](list.jpg)\n\n| A | B |\n| - | - |\n| ![table](table.gif) | text |\n\nfoot[^x]\n\n[^x]: ![note](note.webp)';
  assert.deepEqual((await planDocumentBundle(content)).images, [
    { path: 'quote.png' }, { path: 'list.jpg' }, { path: 'table.gif' }, { path: 'note.webp' },
  ]);
});

test('strict network and mail destinations are retained without local image entries', async () => {
  const content = '[site](https://example.com/a?q=1#x) ![image](HTTP://example.com/a.png) ' +
    '<https://example.com> <user@example.com>\n\n[unused]: mailto:other@example.com';
  assert.deepEqual(await planDocumentBundle(content), { ...empty, remoteReferenceCount: 5 });
});

test('relative nonimages and unsupported local or network-looking destinations refuse', async () => {
  for (const value of ['notes.md', 'report.pdf', 'a.svg', 'a.bmp', 'a.avif', '.png', 'file:///C:/a.png',
    '//host/a.png', 'data:image/png;base64,AAAA', 'custom:a.png', 'javascript:alert(1)', 'http:example.com/a.png',
    'https:/example.com/a.png', 'https://', 'https://example.com:bad/a.png', 'https://user:pw@example.com/a.png', 'mailto:']) {
    const plan = await planDocumentBundle(link(value));
    assert.equal(plan.portable, false, value); assert.equal(plan.blockedReferenceCount, 1, value);
    assert.deepEqual(plan.images, [], value);
  }
});

test('absolute, drive, UNC, backslash, empty and dot segments cannot enter ZIP paths', async () => {
  for (const value of ['/a.png', 'C:/a.png', 'C:\\a.png', '\\\\server\\a.png', 'images\\a.png',
    './a.png', '../a.png', 'images/../a.png', 'images/./a.png', 'images//a.png', 'images/',
    '%2Fa.png', '%2e%2e/a.png', 'images%2F..%2Fa.png', 'images%5Ca.png']) {
    const plan = await planDocumentBundle(link(value));
    assert.equal(plan.portable, false, value); assert.equal(plan.blockedReferenceCount, 1, value);
    assert.deepEqual(plan.images, [], value);
  }
});

test('query and fragment variants are refused rather than silently stripping source destinations', async () => {
  for (const value of ['a.png?raw=1', 'a.png#view', 'a%3F.png', 'a%23.png', '?a.png', '%23a.png']) {
    assert.equal((await planDocumentBundle(link(value))).blockedReferenceCount, 1, value);
  }
});

test('one URI decode preserves Unicode, spaces and literal percent filename characters', async () => {
  const content = '![一](images/中文😀.png) ![二](images/two%20words.jpg) ![三](100%25.png) ' +
    '![same](images/%E4%B8%AD%E6%96%87%F0%9F%98%80.png) ![once](%252e%252e/a.png)';
  assert.deepEqual(await planDocumentBundle(content), { ...empty, images: [
    { path: 'images/中文😀.png' }, { path: 'images/two words.jpg' }, { path: '100%.png' }, { path: '%2e%2e/a.png' },
  ] });
});

test('invalid URI encoding, controls and illegal Windows filename characters refuse', async () => {
  for (const value of ['bad%.png', 'bad%GG.png', '%C0%AFa.png', 'a%00.png', 'a%0A.png', 'a%7F.png',
    'a%85.png', 'a%3A.png', 'a%22.png', 'a%3C.png', 'a%3E.png', 'a%7C.png', 'a%2A.png']) {
    const plan = await planDocumentBundle(link(value));
    assert.equal(plan.portable, false, value); assert.equal(plan.blockedReferenceCount, 1, value);
  }
  assert.equal((await planDocumentBundle('[bad](https://example.com/&#10;private)')).blockedReferenceCount, 1);
});

test('reserved device names, trailing dots or spaces and oversized path segments refuse', async () => {
  for (const value of ['CON.png', 'aux.JPG', 'NUL/image.png', 'COM1.png', 'lpt9.png', 'COM%C2%B9.png',
    'images./a.png', 'images%20/a.png', 'image.png%20', 'image.png.', `${'x'.repeat(252)}.png`]) {
    assert.equal((await planDocumentBundle(link(value))).blockedReferenceCount, 1, value);
  }
  assert.equal((await planDocumentBundle(link('COM0.png'))).portable, true, 'COM0 is not a Windows device alias');
});

test('different case and Unicode normalization spellings refuse instead of creating aliases', async () => {
  for (const content of ['![a](images/a.png) ![b](IMAGES/A.PNG)', '![a](café.png) ![b](cafe%CC%81.png)']) {
    const plan = await planDocumentBundle(content);
    assert.equal(plan.portable, false); assert.equal(plan.blockedReferenceCount, 1); assert.equal(plan.images.length, 1);
  }
  assert.deepEqual(await planDocumentBundle('![a](%69mg.png) ![b](img.png)'), { ...empty, images: [{ path: 'img.png' }] });
});

test('the image limit permits exact duplicates but rejects additional unique resources', async () => {
  const content = Array.from({ length: MAX_DOCUMENT_BUNDLE_IMAGES }, (_, i) => `![${i}](images/${i}.png)`).join('\n');
  const exact = await planDocumentBundle(content + '\n![again](images/0.png)');
  assert.equal(exact.portable, true); assert.equal(exact.images.length, MAX_DOCUMENT_BUNDLE_IMAGES);
  const over = await planDocumentBundle(content + '\n![over](images/extra.png)');
  assert.equal(over.portable, false); assert.equal(over.blockedReferenceCount, 1); assert.equal(over.images.length, MAX_DOCUMENT_BUNDLE_IMAGES);
});

test('all raw HTML, including comments and hidden resource-bearing containers, refuses', async () => {
  for (const content of ['<img src="a.png">', 'x <em>safe-looking</em> y', '<!-- local image a.png -->',
    '<script>![hidden](a.png)</script>', '<base href="../other/">']) {
    const plan = await planDocumentBundle(content); assert.equal(plan.portable, false); assert.ok(plan.htmlNodeCount > 0);
  }
});

test('literal code, YAML and escaped image examples do not create file requests', async () => {
  const content = '---\ncover: private.png\nwiki: "[[literal]]"\n---\n\n`![inline](inline.png)`\n\n' +
    '```md\n![fenced](fenced.png)\n<img src="html.png">\n```\n\n    ![indented](indented.png)\n\n\\![escaped]\\(escaped.png\\)';
  assert.deepEqual(await planDocumentBundle(content), empty);
});

test('known unsupported dialects block and unresolved reference spellings remain literal', async () => {
  assert.deepEqual(await planDocumentBundle('[literal][missing] ![literal][missing]'), empty);
  const plan = await planDocumentBundle('[[local note]]\n\n$$\nx^2\n$$\n\n:::note\nbody\n:::');
  assert.equal(plan.portable, false); assert.equal(plan.unsupportedExtensionCount, 3);
});

test('Markdown entity and escape processing happen before local path validation', async () => {
  assert.deepEqual(await planDocumentBundle('![a](images&sol;one.png) ![b](two\\(x\\).png)'), {
    ...empty, images: [{ path: 'images/one.png' }, { path: 'two(x).png' }],
  });
});

test('BOM/CRLF source is untouched and plans expose only relative files and fixed counts', async () => {
  const content = '\ufeff# 中文😀\r\n\r\n![图片](images/%E4%B8%AD%E6%96%87.png)\r\n\r\n[remote](https://secret.example/path)';
  const before = Buffer.from(content), plan = await planDocumentBundle(content);
  assert.deepEqual(plan, { ...empty, images: [{ path: 'images/中文.png' }], remoteReferenceCount: 1 });
  assert.deepEqual(Buffer.from(content), before);
  assert.doesNotMatch(JSON.stringify(plan), /secret|https|# 中文/);
  assert.deepEqual(Object.keys(plan).sort(), ['blockedReferenceCount', 'htmlNodeCount', 'images', 'portable', 'remoteReferenceCount', 'unsupportedExtensionCount']);
});
