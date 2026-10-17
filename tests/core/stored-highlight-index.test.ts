import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSelectionMap, createStoredHighlightResolver, resolveSelection, type SelectionMap } from '../../src/core/selection-map.ts';

type Anchor = Parameters<ReturnType<typeof createStoredHighlightResolver>>[0];

// Full-scan oracle: validate bytes and enumerate every matching visible range
// through the public selection-to-source contract (no index or block filtering).
function oracle(map: SelectionMap, anchor: Anchor) {
  const {startByte,endByte,sourceExact,displayQuote}=anchor;
  if(!Number.isSafeInteger(startByte)||!Number.isSafeInteger(endByte)||startByte<map.bomByteLength||startByte>=endByte||!sourceExact||!displayQuote)
    return {ok:false,reason:'存储的高亮锚点范围无效。'};
  const bytes=Buffer.from(map.source);const exact=Buffer.from(sourceExact);
  if(endByte-map.bomByteLength>bytes.length||exact.length!==endByte-startByte||!bytes.subarray(startByte-map.bomByteLength,endByte-map.bomByteLength).equals(exact))
    return {ok:false,reason:'存储的高亮锚点与当前原文不一致。'};
  let match;
  for(const block of map.blocks){
    if(!block.supported)continue;
    for(let start=block.visibleText.indexOf(displayQuote);start!==-1;start=block.visibleText.indexOf(displayQuote,start+1)){
      const end=start+displayQuote.length;const resolved=resolveSelection(map,block.blockStart,start,end);
      if(resolved.ok&&resolved.startByte===startByte&&resolved.endByte===endByte&&resolved.sourceExact===sourceExact&&resolved.displayQuote===displayQuote){
        if(match)return {ok:false,reason:'高亮锚点对应多个可见选区，无法安全绘制。'};
        match={blockStart:block.blockStart,visibleStart:start,visibleEnd:end};
      }
    }
  }
  return match?{ok:true,...match}:{ok:false,reason:'高亮锚点无法精确还原为当前阅读选区。'};
}

function freeze<T>(value:T):T {
  if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}
  return value;
}

test('batched anchors equal full-scan byte and visible-range verification across Unicode and Markdown',()=>{
  const sources=[
    '# 标题😀\r\n\r\n中文 é 👨‍👩‍👧‍👦 同名 同名\r\n\r\n同名。',
    '---\ntitle: metadata\n---\n\n标题\n====\n\n**粗体** *斜体* [链接](https://example.com) ~~删除~~。',
    'a &amp; b &#x1F600; \\*字\\*。\n\n`code 😀` and `` a ` b ``',
    '> 引文 **重复**\n>\n> 第二段\n\n- 列表\n  - 嵌套😀\n\n重复',
    '| 标题 | 数据 |\n| --- | --- |\n| 中😀文 | **强调** |\n',
    '软换\n行\n\n硬换  \n行\n\n<div>HTML 字符</div>\n\n```md\n# 代码\n```',
    '\uFEFF# BOM\r\n\r\nالعربية 中文 😀\r\n',
    '# Same\n\nxxx\n\n# Same\n\nxxx\n',
  ];
  let comparisons=0;
  for(const source of sources)for(const bom of [0,3]){
    if(source.startsWith('\uFEFF')&&bom===0)continue;
    const map=freeze(buildSelectionMap(source,bom));const resolve=createStoredHighlightResolver(map);
    for(const block of map.blocks){
      for(let start=0;start<block.visibleText.length;start++)for(let end=start+1;end<=Math.min(start+9,block.visibleText.length);end++){
        const selection=resolveSelection(map,block.blockStart,start,end);if(!selection.ok)continue;
        for(const anchor of [selection,{...selection,startByte:selection.startByte+1},{...selection,endByte:selection.endByte-1},
          {...selection,sourceExact:selection.sourceExact+'x'},{...selection,displayQuote:selection.displayQuote+'x'}]){
          assert.deepEqual(resolve(anchor),oracle(map,anchor));comparisons++;
        }
      }
    }
    for(const anchor of [{startByte:NaN,endByte:2,sourceExact:'a',displayQuote:'a'},
      {startByte:0,endByte:0,sourceExact:'',displayQuote:''}])assert.deepEqual(resolve(anchor),oracle(map,anchor));
  }
  assert.ok(comparisons>2000);
});

test('a resolver belongs to one source; duplicate blocks and ambiguous quotes never choose a match',()=>{
  const first=buildSelectionMap('第一段😀\n\n重复 重复\n',3);
  const block=first.blocks[1];const selected=resolveSelection(first,block.blockStart,0,2);assert.equal(selected.ok,true);if(!selected.ok)return;
  const resolveFirst=createStoredHighlightResolver(freeze(first));
  const second=freeze(buildSelectionMap('新增段落\n\n第一段😀\n\n重复 重复\n',3));
  assert.equal(resolveFirst(selected).ok,true);
  assert.equal(createStoredHighlightResolver(second)(selected).ok,false);
  const duplicated=freeze({...first,blocks:[...first.blocks,block]});
  assert.deepEqual(createStoredHighlightResolver(duplicated)(selected),oracle(duplicated,selected));
  assert.equal(createStoredHighlightResolver(duplicated)(selected).ok,false);
  const conflicting=freeze({...first,blocks:[...first.blocks,{...block,blockEnd:block.blockStart}]});
  assert.deepEqual(createStoredHighlightResolver(conflicting)(selected),oracle(conflicting,selected));
  assert.equal(createStoredHighlightResolver(conflicting)(selected).ok,false,'inconsistent duplicate positions do not hide ambiguity');
  assert.equal(resolveFirst(selected).ok,true,'another document cannot replace the index');
});
