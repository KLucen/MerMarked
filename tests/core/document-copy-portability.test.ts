import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectDocumentCopyPortability } from '../../src/core/document-copy-portability.ts';

const portable = { portable: true, localReferenceCount: 0, htmlNodeCount: 0, unsupportedExtensionCount: 0 };

test('plain Markdown, headings and empty documents need no copied resources', async () => {
  for (const source of ['', '# 标题\n\n正文 **中文😀**。\n', '- [x] checked\n- [ ] next\n']) {
    assert.deepEqual(await inspectDocumentCopyPortability(source), portable);
  }
});

test('fragments, empty targets and explicit web/mail addresses are directory independent', async () => {
  const source = [
    '# 标题', '', '[章节](#标题) [本页]() ![empty]()', '',
    '[网络](https://example.com/a?q=1#fragment) [大写](HTTP://example.com)', '',
    '[邮件](mailto:user@example.com?subject=hello) <https://example.com>', '',
    'https://example.com/gfm www.example.com/gfm user@example.com', '',
    '[引用][external] ![网络图][external]', '', '[external]: https://example.com/x.png',
  ].join('\n');
  assert.deepEqual(await inspectDocumentCopyPortability(source), portable);
});

test('local, absolute, protocol-relative, unknown and malformed destinations all block', async () => {
  const destinations = [
    'assets/image.png', '../shared/image.png', '/images/a.png', '?version=1',
    'C:/work/image.png', 'C:\\work\\image.png', '\\\\server\\share\\image.png',
    '//example.com/image.png', 'file:///C:/work/image.png', 'data:image/png;base64,AAAA',
    'javascript:alert(1)', 'custom:attachment', 'http:example.com', 'https:/example.com',
    'https://', 'https://example.com:invalid', 'https://user:password@example.com', 'mailto:',
  ];
  for (const destination of destinations) {
    const audit = await inspectDocumentCopyPortability(`[目标](<${destination}>)`);
    assert.equal(audit.portable, false, destination);
    assert.equal(audit.localReferenceCount, 1, destination);
    assert.equal(audit.htmlNodeCount, 0, destination);
  }
});

test('inline links and images are counted without deduplicating away their source uses', async () => {
  assert.deepEqual(await inspectDocumentCopyPortability('[链接](same.png) ![图](same.png)'), {
    ...portable, portable: false, localReferenceCount: 2,
  });
});

test('reference definitions are audited once even when reused or unused', async () => {
  const source = '[复用][A] [再用][a] ![图][A]\n\n[A]: assets/shared.png\n\n[unused]: other.md';
  assert.deepEqual(await inspectDocumentCopyPortability(source), {
    ...portable, portable: false, localReferenceCount: 2,
  });
});

test('duplicate definitions cannot hide a later local destination behind an external one', async () => {
  const source = '[链接][same]\n\n[same]: https://example.com\n[same]: hidden/local.png';
  assert.equal((await inspectDocumentCopyPortability(source)).localReferenceCount, 1);
});

test('links nested in quotes, lists, tables and footnotes are inspected', async () => {
  const source = [
    '> [引用](quote.md)', '', '- ![图片](list.png)', '',
    '| 一 | 二 |', '| - | - |', '| [表格](table.md) | 正文 |', '',
    '脚注[^note]', '', '[^note]: ![脚注图片](footnote.png)',
  ].join('\n');
  assert.deepEqual(await inspectDocumentCopyPortability(source), {
    ...portable, portable: false, localReferenceCount: 4,
  });
});

test('raw tags and comments block even when reading would hide or sanitize them', async () => {
  for (const source of [
    '<img src="assets/image.png">', 'A <em>emphasis</em> B', '<!-- assets/image.png -->',
    '<script>![hidden](private.png)</script>', '<base href="../other/">', '<custom data-resource="local">x</custom>',
  ]) {
    const audit = await inspectDocumentCopyPortability(source);
    assert.equal(audit.portable, false, source);
    assert.ok(audit.htmlNodeCount > 0, source);
  }
});

test('code, inline code, escaped markup and YAML do not become live resources', async () => {
  const source = [
    '---', 'cover: assets/frontmatter.png', 'extension: "[[ignored]]"', '---', '',
    '`![example](inline.png) <img src="inline.png"> [[ignored]]`', '',
    '```md', '![example](fenced.png)', '<img src="fenced.png">', '[[ignored]]', '```', '',
    '    ![example](indented.png)', '', '\\![escaped]\\(literal.png\\)',
  ].join('\n');
  assert.deepEqual(await inspectDocumentCopyPortability(source), portable);
});

test('Markdown escapes and character entities are classified after parser decoding', async () => {
  const allowed = '[web](https&colon;//example.com/a) [anchor](&num;标题)';
  assert.deepEqual(await inspectDocumentCopyPortability(allowed), portable);
  const blocked = '![图](assets&sol;image.png) [链接](assets/one\\(two\\).md)';
  assert.equal((await inspectDocumentCopyPortability(blocked)).localReferenceCount, 2);
});

test('percent-encoded schemes and fragments are not decoded into permission to copy', async () => {
  const source = '[编码协议](%68%74%74%70%73://example.com) [编码锚点](%23heading) ![编码路径](assets%2Fimage.png)';
  assert.deepEqual(await inspectDocumentCopyPortability(source), {
    ...portable, portable: false, localReferenceCount: 3,
  });
});

test('control characters decoded by Markdown cannot become allowed web targets', async () => {
  assert.deepEqual(await inspectDocumentCopyPortability('[web](https://example.com/&#10;private)'), {
    ...portable, portable: false, localReferenceCount: 1,
  });
});

test('BOM and CRLF do not change auditing or the original source', async () => {
  const source = '\uFEFF# 中文😀\r\n\r\n[网络](https://example.com)\r\n\r\n![图](assets/image.png)\r\n';
  const before = Buffer.from(source);
  assert.equal((await inspectDocumentCopyPortability(source)).localReferenceCount, 1);
  assert.deepEqual(Buffer.from(source), before);
});

test('known unsupported extensions block and count distinct dialect kinds', async () => {
  const source = '[[Local note]] ![[image.png]]\n\n$$\nx^2\n$$\n\n:::note\ntext\n:::';
  assert.deepEqual(await inspectDocumentCopyPortability(source), {
    ...portable, portable: false, unsupportedExtensionCount: 3,
  });
});

test('unresolved reference spellings remain literal text under the current dialect', async () => {
  assert.deepEqual(await inspectDocumentCopyPortability('[literal][missing] ![literal][missing]'), portable);
});

test('the public audit exposes only fixed counters and never source or resource addresses', async () => {
  const audit = await inspectDocumentCopyPortability('![private](private/secret.png)\n\n<!-- private text -->');
  assert.deepEqual(Object.keys(audit).sort(), ['htmlNodeCount', 'localReferenceCount', 'portable', 'unsupportedExtensionCount']);
  assert.doesNotMatch(JSON.stringify(audit), /private|secret|png/);
});
