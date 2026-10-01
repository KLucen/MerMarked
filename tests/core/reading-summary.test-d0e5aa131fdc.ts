import assert from 'node:assert/strict';
import test from 'node:test';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { AnnotationRecord, AnnotationSidecar } from '../../src/core/annotations.ts';
import { formatReadingSummary } from '../../src/core/reading-summary.ts';

const hash = 'a'.repeat(64);

interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
}

function descendants(node: MarkdownNode): MarkdownNode[] {
  return [node, ...(node.children ?? []).flatMap(descendants)];
}

function annotation(
  id: string,
  startByte: number,
  overrides: Partial<AnnotationRecord> = {},
): AnnotationRecord {
  return {
    id,
    kind: 'note',
    anchor: {
      basisSha256: hash,
      startByte,
      endByte: startByte + 3,
      sourceExact: '词',
      prefix: '',
      suffix: '',
      displayQuote: `引文-${id}`,
    },
    note: `便签-${id}`,
    createdAt: '2026-09-23T00:00:00Z',
    updatedAt: '2026-09-23T00:00:00Z',
    ...overrides,
  };
}

function sidecar(annotations: AnnotationRecord[]): AnnotationSidecar {
  return {
    schemaVersion: 1,
    source: { sha256: hash, encoding: 'utf-8', coordinateSystem: 'utf8-byte' },
    tags: [
      { id: 'tag-question', name: '疑问' },
      { id: 'tag-risk', name: '风险' },
    ],
    annotations,
  };
}

test('formats resolved annotations by byte position and sends unresolved content to the final area', () => {
  const model = sidecar([
    annotation('later', 40, { tagId: 'tag-question', anchor: {
      ...annotation('x', 40).anchor, displayQuote: '后面', sectionHint: '第二章',
    } }),
    annotation('tie-highlight', 10, {
      kind: 'highlight', color: 'amber', note: undefined,
      anchor: { ...annotation('x', 10).anchor, displayQuote: '先记录的高亮' },
    }),
    annotation('tie-note', 10, {
      color: 'sage',
      anchor: { ...annotation('x', 10).anchor, displayQuote: '后记录的便签' },
      note: '第一行\n\n第三行',
    }),
  ]);

  const summary = formatReadingSummary(model, {
    documentName: '示例.md',
    statusByAnnotationId: { later: 'resolved', 'tie-highlight': 'unresolved', 'tie-note': 'resolved' },
    sectionByAnnotationId: { later: { key: 'section-2', title: '第一章 / 第二章' } },
  });

  assert.match(summary, /^# MerMarkd 阅读摘要\n/);
  assert.match(summary, /> 示例\.md/);
  assert.match(summary, /- 批注数：3/);
  assert.ok(summary.indexOf('后记录的便签') < summary.indexOf('后面'));
  assert.ok(summary.indexOf('后面') < summary.indexOf('先记录的高亮'));
  assert.match(summary, /- 状态：待定位（原位置未核验）/);
  assert.match(summary, /- 类型：高亮/);
  assert.match(summary, /- 高亮颜色：琥珀色/);
  assert.match(summary, /- 高亮颜色：鼠尾草绿/);
  assert.match(summary, /- 标签：无标签/);
  assert.match(summary, /## 章节分组 1\n\n- 分组：未标明章节/);
  assert.match(summary, /## 章节分组 2\n\n- 分组：已定位章节\n- 章节：\n\n> 第一章 \/ 第二章/);
  assert.match(summary, /- 便签：\n\n> 第一行\n>\n> 第三行/);
});

test('filters by one tag or untagged records without changing the model', () => {
  const model = sidecar([
    annotation('question', 1, { tagId: 'tag-question' }),
    annotation('risk', 2, { tagId: 'tag-risk' }),
    annotation('plain', 3),
  ]);
  const before = structuredClone(model);
  const statuses = { question: 'resolved', risk: 'resolved', plain: 'resolved' } as const;

  const tagged = formatReadingSummary(model, {
    documentName: '筛选.md', statusByAnnotationId: statuses,
    filter: { mode: 'tag', tagId: 'tag-question' },
  });
  assert.match(tagged, /- 筛选：指定标签\n\n> 疑问/);
  assert.match(tagged, /> 引文-question/);
  assert.doesNotMatch(tagged, /引文-risk|引文-plain/);

  const untagged = formatReadingSummary(model, {
    documentName: '筛选.md', statusByAnnotationId: statuses,
    filter: { mode: 'untagged' },
  });
  assert.match(untagged, /> 引文-plain/);
  assert.doesNotMatch(untagged, /引文-question|引文-risk/);
  assert.deepEqual(model, before);
});

test('retains unresolved content and treats a missing status conservatively', () => {
  const model = sidecar([annotation('stale', 12, {
    tagId: 'tag-question',
    anchor: { ...annotation('x', 12).anchor, displayQuote: '旧引文', sectionHint: '旧章节' },
    note: '必须保留的旧便签',
  })]);
  const summary = formatReadingSummary(model, { documentName: '改动后.md', statusByAnnotationId: {} });

  assert.match(summary, /- 状态：待定位（原位置未核验）/);
  assert.match(summary, /> 旧引文/);
  assert.match(summary, /## 待定位\n\n> [^\n]+sidecar[^\n]+/);
  assert.match(summary, /- 原章节线索：\n\n> 旧章节/);
  assert.match(summary, /> 必须保留的旧便签/);
  assert.match(summary, /> 疑问/);
});

test('escapes untrusted Markdown and HTML while preserving readable multiline text', () => {
  const model = sidecar([annotation('hostile', 0, {
    tagId: 'tag-question',
    anchor: {
      ...annotation('x', 0).anchor,
      displayQuote: '# 伪标题\n<script>alert(1)</script>\n[链接](javascript:alert(1))\n---',
      sectionHint: '> 伪引用',
    },
    note: '```html\n<img src=x onerror=alert(1)>\n```\n* 伪列表\n1. 伪有序列表\n    伪缩进代码\n\t伪 tab 代码\n===',
  })]);
  model.tags[0].name = '标签 | **粗体**';
  const summary = formatReadingSummary(model, {
    documentName: '# 伪文档\n[doc](https://example.invalid)',
    statusByAnnotationId: { hostile: 'resolved' },
    sectionByAnnotationId: { hostile: { key: 'hostile-section', title: '> 伪引用' } },
  });

  assert.match(summary, /> \\# 伪文档/);
  assert.ok(summary.includes('> \\[链接\\]\\(javascript:alert\\(1\\)\\)'));
  assert.ok(summary.includes('> \\<script\\>alert\\(1\\)\\</script\\>'));
  assert.ok(summary.includes('> \\`\\`\\`html'));
  assert.ok(summary.includes('> \\* 伪列表'));
  assert.ok(summary.includes('> 标签 \\| \\*\\*粗体\\*\\*'));
  assert.ok(summary.includes('> \\---'));
  assert.doesNotMatch(summary, /\n> <script>|\n> ```|\n> \[.*\]\(javascript:/);

  const tree = unified().use(remarkParse).parse(summary) as MarkdownNode;
  const quoteNodes = descendants(tree).filter((node) => node.type === 'blockquote');
  const forbiddenInsideQuotes = new Set([
    'blockquote', 'code', 'delete', 'emphasis', 'heading', 'html', 'image', 'imageReference',
    'inlineCode', 'link', 'linkReference', 'list', 'strong', 'thematicBreak',
  ]);
  for (const quote of quoteNodes) {
    assert.deepEqual(
      descendants(quote).slice(1).filter((node) => forbiddenInsideQuotes.has(node.type)).map((node) => node.type),
      [],
    );
  }
});

test('reports an empty filter and rejects an unknown tag', () => {
  const model = sidecar([annotation('plain', 0)]);
  const empty = formatReadingSummary(model, {
    documentName: 'empty.md', statusByAnnotationId: { plain: 'resolved' },
    filter: { mode: 'tag', tagId: 'tag-risk' },
  });
  assert.match(empty, /- 批注数：0/);
  assert.match(empty, /> 当前筛选条件下没有批注。/);
  assert.throws(() => formatReadingSummary(model, {
    documentName: 'empty.md', statusByAnnotationId: {},
    filter: { mode: 'tag', tagId: 'missing' },
  }), /标签不存在/);
});

test('mixed-basis records sort only resolved positions and keep unresolved sidecar order at the end', () => {
  const model = sidecar([
    annotation('stale-near', 1, { note: '待定位-原记录一' }),
    annotation('current-later', 80, { note: '已定位-后' }),
    annotation('stale-far', 8_000, { note: '待定位-原记录二' }),
    annotation('current-earlier', 20, { note: '已定位-前' }),
  ]);
  const summary = formatReadingSummary(model, {
    documentName: 'mixed.md',
    statusByAnnotationId: {
      'stale-near': 'unresolved',
      'current-later': 'resolved',
      'stale-far': 'unresolved',
      'current-earlier': 'resolved',
    },
  });

  const order = [
    '已定位-前',
    '已定位-后',
    '待定位-原记录一',
    '待定位-原记录二',
  ].map((value) => summary.indexOf(value));
  assert.ok(order.every((position) => position >= 0));
  assert.deepEqual(order, [...order].sort((left, right) => left - right));
  assert.equal(summary.match(/^## 待定位$/gm)?.length, 1);
  assert.doesNotMatch(summary, /UTF-8 字节/);
});

test('uses current section keys to keep adjacent duplicate titles in separate groups', () => {
  const model = sidecar([
    annotation('first-duplicate', 10, { anchor: {
      ...annotation('x', 10).anchor, displayQuote: '第一个重复章节引文', sectionHint: '重复',
    } }),
    annotation('second-duplicate', 50, { anchor: {
      ...annotation('x', 50).anchor, displayQuote: '第二个重复章节引文', sectionHint: '重复',
    } }),
  ]);
  const summary = formatReadingSummary(model, {
    documentName: 'duplicates.md',
    statusByAnnotationId: { 'first-duplicate': 'resolved', 'second-duplicate': 'resolved' },
    sectionByAnnotationId: {
      'first-duplicate': { key: 'section-0', title: '重复' },
      'second-duplicate': { key: 'section-1', title: '重复' },
    },
  });

  assert.equal(summary.match(/^## 章节分组 \d+$/gm)?.length, 2);
  assert.ok(summary.indexOf('第一个重复章节引文') < summary.indexOf('第二个重复章节引文'));
});
