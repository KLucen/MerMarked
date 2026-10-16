import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { parseMarkdownSnapshot } from '../src/core/markdown-snapshot.ts';
import { readingRenderFromSnapshot } from '../src/core/reading-render.ts';
import { analyzeReading } from '../src/core/reading-analysis.ts';
import { preparedReadingPlugin } from '../src/renderer/prepared-reading-plugin.ts';
import { readingSanitizeSchema, rehypeReadingHtmlPolicy, remarkReadingDangerousHtmlPolicy } from '../src/core/markdown-reading.ts';

const remarkPlugins = [remarkGfm, remarkFrontmatter, remarkReadingDangerousHtmlPolicy];
const rehypePlugins = [rehypeRaw, rehypeReadingHtmlPolicy, [rehypeSanitize, readingSanitizeSchema]];
const legacy = unified().use(remarkParse).use(remarkPlugins).use(remarkRehype, {allowDangerousHtml:true}).use(rehypePlugins);
const fixtures = await Promise.all(['reading-dialect.md','reading-features.md'].map(name=>readFile(new URL('./fixtures/reader/'+name,import.meta.url),'utf8')));
const cases = [...fixtures, '', '\uFEFF# 中文 😀\r\n\r\n重复 **重点**。\r\n\r\n重复 **重点**。',
  '[前置引用][later] and ![image][pic]\n\n'+('# 中间\n\n内容\n\n'.repeat(40))+'[later]: https://example.com/target "标题"\n[pic]: relative.png\n',
  '脚注[^note]\n\n[^note]: 多行 **注解**\n\n    第二段\n',
  '<details><summary>外层</summary>\n\n内文\n\n<details><summary>内层</summary>隐藏</details></details>\n\n',
  '<video><table>SECRET_FOSTER<img src="secret.png"></table></video>\n\n<span class="html-placeholder" role="note">VISIBLE</span>\n\n<a href="javascript:alert(1)" onclick="alert(1)">safe</a>\n',
  '<div>\n\n**SECRET_SPLIT**\n\n<table>SECRET_TABLE</table>\n\n</div>\n\n正常尾部\n',
  '> - [x] 嵌套 **强调**\n>   - 子项\n\n| 左 | 右 |\n| :-- | --: |\n| 中文 | 😀 |\n\n~~~md\n# 原样代码\n~~~\n',
];

test('worker rendering matches the full legacy pipeline including HTML policy and source positions', () => {
  for (const source of cases) {
    const body=source.startsWith('\uFEFF')?source.slice(1):source;
    const expected=legacy.runSync(legacy.parse(body),body);
    assert.deepEqual(structuredClone(readingRenderFromSnapshot(parseMarkdownSnapshot(source))),expected);
  }
});

test('prepared HAST preserves React components, node positions and default URL filtering with empty parser input', () => {
  const components=Object.fromEntries(['h1','h2','p','td','pre','a','img'].map(tag=>[tag,({node,children,...props})=>
    createElement(tag,{...props,'data-test-offset':node.position?.start.offset},children)]));
  for (const source of cases) {
    const body=source.startsWith('\uFEFF')?source.slice(1):source;
    const oldMarkup=renderToStaticMarkup(createElement(Markdown,{remarkPlugins,rehypePlugins,components},body));
    const tree=structuredClone(analyzeReading(source,source.startsWith('\uFEFF')?3:0).renderTree);
    let emptyInput=false;
    const assertEmpty=()=>parsed=>{assert.equal(parsed.children.length,0);emptyInput=true;};
    const markup=renderToStaticMarkup(createElement(Markdown,{remarkPlugins:[assertEmpty],rehypePlugins:[preparedReadingPlugin(tree)],components},''));
    assert.equal(emptyInput,true);
    assert.equal(markup,oldMarkup);
    assert.equal(renderToStaticMarkup(createElement(Markdown,{rehypePlugins:[preparedReadingPlugin(tree)],components},'')),markup,'repeat rendering stays idempotent');
  }
});

test('render preparation never mutates the shared frozen source/anchor snapshot', () => {
  const snapshot=parseMarkdownSnapshot('\uFEFF# 标题\r\n\r\n保留 **重点**\r\n\r\n<script>SECRET</script>\r\n');
  const original=structuredClone(snapshot);
  const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}};
  freeze(snapshot);
  const tree=readingRenderFromSnapshot(snapshot);
  assert.deepEqual(snapshot,original);
  assert.doesNotMatch(JSON.stringify(tree),/SECRET|"tagName":"script"/);
  const heading=tree.children.find(node=>node.type==='element'&&node.tagName==='h1');
  assert.equal(heading.position.start.offset,0);
  assert.equal(snapshot.body.slice(heading.position.start.offset,heading.position.end.offset),'# 标题');
});
