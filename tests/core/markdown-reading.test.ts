import assert from 'node:assert/strict';
import test from 'node:test';
import type { Root } from 'hast';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import {
  detectUnsupportedMarkdownExtensions,
  findVisibleTextMatches,
  readingSanitizeSchema,
  rehypeReadingHtmlPolicy,
  remarkReadingDangerousHtmlPolicy,
} from '../../src/core/markdown-reading.ts';

test('detects only conservative unsupported extension spellings outside metadata and code', () => {
  const source = [
    '---',
    'sample: "[[metadata]]"',
    '---',
    '# 正文',
    '这里有 [[知识链接]]。',
    '',
    '$$',
    'x + y',
    '$$',
    '',
    ':::note',
    '内容',
    ':::',
    '',
    '```md',
    '[[代码不是扩展提示]]',
    '$$',
    ':::code',
    '```',
    '转义的 \\[[普通文字]] 不应触发第二种检测。',
  ].join('\n');

  assert.deepEqual(detectUnsupportedMarkdownExtensions(source), ['display-math', 'wiki-link', 'directive']);
  assert.deepEqual(detectUnsupportedMarkdownExtensions([
    '价格是 $5，代码 `[[x]]` 与 `:note[x]`。',
    '\\:note[转义文本] 与 \\[[普通文字]]。',
    '````md',
    '```js',
    '[[仍在四反引号围栏中]]',
    '````',
    '    [[缩进代码]]',
    '> ```md',
    '> [[引用中的围栏代码]]',
    '> ```',
    '[普通链接](https://example.test/?q=[[url-only]])',
  ].join('\n')), []);
  assert.deepEqual(detectUnsupportedMarkdownExtensions([
    '::leaf[块指令]',
    '段落内的 :abbr[HTML]{title="说明"}。',
  ].join('\n')), ['directive']);
});

test('HTML policy preserves allowed semantics and replaces unsupported or dangerous subtrees once', () => {
  const tree: Root = {
    type: 'root',
    children: [
      { type: 'element', tagName: 'mark', properties: {}, children: [{ type: 'text', value: '保留' }] },
      { type: 'element', tagName: 'custom-widget', properties: {}, children: [{ type: 'text', value: '不可回落' }] },
      { type: 'element', tagName: 'video', properties: {}, children: [{ type: 'text', value: '媒体文本' }] },
      { type: 'element', tagName: 'script', properties: {}, children: [{ type: 'text', value: '危险文本' }] },
    ],
  };

  rehypeReadingHtmlPolicy()(tree);
  assert.equal(tree.children[0].type === 'element' ? tree.children[0].tagName : '', 'mark');
  assert.equal(tree.children[1].type === 'element' ? tree.children[1].tagName : '', 'span');
  assert.equal(tree.children[2].type === 'element' ? tree.children[2].tagName : '', 'span');
  assert.equal(tree.children[3].type === 'element' ? tree.children[3].tagName : '', 'span');
  assert.doesNotMatch(JSON.stringify(tree), /不可回落|媒体文本|危险文本/);
  assert.match(JSON.stringify(tree), /暂不显示/);
  assert.match(JSON.stringify(tree), /不安全的 HTML 内容已隐藏/);
});

test('HTML sanitizer removes spoofing attributes and dangerous protocols while retaining internal placeholders', () => {
  const tree: Root = {
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'a',
        properties: {
          href: 'javascript:alert(1)', id: 'spoof', ariaLabel: 'spoof', onClick: 'alert(1)', style: 'color:red', title: '保留',
        },
        children: [{ type: 'text', value: '链接' }],
      },
      {
        type: 'element', tagName: 'span', properties: { className: ['html-placeholder'], role: 'note' },
        children: [{ type: 'text', value: '普通内容' }],
      },
      {
        type: 'element', tagName: 'iframe', properties: {},
        children: [{ type: 'text', value: '绝不保留的子文本' }],
      },
    ],
  };

  rehypeReadingHtmlPolicy()(tree);
  const sanitized = rehypeSanitize(readingSanitizeSchema)(tree) as Root;
  assert.deepEqual(sanitized.children[0].type === 'element' ? sanitized.children[0].properties : {}, { title: '保留' });
  assert.deepEqual(sanitized.children[1].type === 'element' ? sanitized.children[1].properties : {}, {});
  assert.deepEqual(sanitized.children[2].type === 'element' ? sanitized.children[2].properties : {}, {
    className: ['html-placeholder'], role: 'note',
  });
  assert.doesNotMatch(JSON.stringify(sanitized), /绝不保留的子文本|javascript|onClick|ariaLabel|style|spoof/);
});

test('pre-raw policy blocks HTML5 foster parenting from leaking dangerous container children', async () => {
  const source = [
    '<mark title="保留">允许内容</mark>',
    '',
    '<video>',
    '<table>VIDEO_FOSTER_SECRET</table>',
    '</video>',
    '<mark title="保留后段">同一 HTML 块仍保留</mark>',
    '',
    '<audio><table><img src="secret.png" alt="AUDIO_IMAGE_SECRET"></table></audio><img src="https://safe.example/kept.png" alt="SAFE_IMAGE">',
    '',
    '<noscript><table>NOSCRIPT_FOSTER_SECRET</table></noscript>',
    '',
    '<custom-widget><table>CUSTOM_FOSTER_SECRET</table><img src="custom-secret.png" alt="CUSTOM_IMAGE_SECRET"></custom-widget>',
  ].join('\n');
  const processor = unified()
    .use(remarkParse)
    .use(remarkReadingDangerousHtmlPolicy)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeReadingHtmlPolicy)
    .use(rehypeSanitize, readingSanitizeSchema);

  const tree = await processor.run(processor.parse(source)) as Root;
  const serialized = JSON.stringify(tree);
  assert.match(serialized, /允许内容/);
  assert.match(serialized, /同一 HTML 块仍保留/);
  assert.match(serialized, /SAFE_IMAGE/);
  assert.match(serialized, /https:\/\/safe\.example\/kept\.png/);
  assert.match(serialized, /此 HTML 内容暂不显示（custom-widget）/);
  assert.equal((serialized.match(/不安全的 HTML 内容已隐藏/g) ?? []).length, 3);
  assert.doesNotMatch(serialized,
    /VIDEO_FOSTER_SECRET|AUDIO_IMAGE_SECRET|NOSCRIPT_FOSTER_SECRET|CUSTOM_FOSTER_SECRET|CUSTOM_IMAGE_SECRET|(?:custom-)?secret\.png/);
});

test('visible text matching is literal, case insensitive, Unicode safe, and non-overlapping', () => {
  assert.deepEqual(findVisibleTextMatches('Alpha alpha 中文😀 Alpha', 'ALPHA'), [
    { start: 0, end: 5 },
    { start: 6, end: 11 },
    { start: 17, end: 22 },
  ]);
  assert.deepEqual(findVisibleTextMatches('a.b a-b a.b', 'a.b'), [
    { start: 0, end: 3 },
    { start: 8, end: 11 },
  ]);
  assert.deepEqual(findVisibleTextMatches('aaaa', 'aa'), [
    { start: 0, end: 2 },
    { start: 2, end: 4 },
  ]);
  assert.deepEqual(findVisibleTextMatches('正文', ''), []);
  assert.deepEqual(findVisibleTextMatches('A😀e\u0301B', '\ud83d'), []);
  assert.deepEqual(findVisibleTextMatches('A😀e\u0301B', '\u0301'), []);
  assert.deepEqual(findVisibleTextMatches('一 二 三 四', ' ', 2), [
    { start: 1, end: 2 },
    { start: 3, end: 4 },
  ]);
});
