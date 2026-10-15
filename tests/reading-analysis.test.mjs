import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeReading } from '../src/core/reading-analysis.ts';
import { resolveSelection } from '../src/core/selection-map.ts';
import { ReadingAnalysisTask } from '../src/renderer/reading-analysis-task.ts';
import { parseMarkdownSnapshot } from '../src/core/markdown-snapshot.ts';
import { sectionsFromSnapshot } from '../src/core/sections.ts';
import { selectionMapFromSnapshot } from '../src/core/selection-map.ts';
import { extensionsFromSnapshot } from '../src/core/markdown-reading.ts';

test('all reading projections share a parsed snapshot without mutating its tree or source', () => {
  const snapshot=parseMarkdownSnapshot('\uFEFF# 标题\r\n\r\n正文 **重点** [[wiki]]\r\n');
  const original=structuredClone(snapshot);
  const freeze=value=>{if(value && typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}};
  freeze(snapshot);
  const sections=sectionsFromSnapshot(snapshot), selection=selectionMapFromSnapshot(snapshot,3), extensions=extensionsFromSnapshot(snapshot);
  assert.equal(sections.sections[0].headingRange.start,1);
  assert.equal(selection.source,snapshot.source.slice(1));
  assert.deepEqual(extensions,['wiki-link']);
  assert.deepEqual(snapshot,original);
});

test('cloned reading analysis preserves BOM/CRLF, headings, repeated quotes and exact UTF-8 anchors', () => {
  const source = '\uFEFF---\r\nname: test\r\n---\r\n# 中文 😀\r\n\r\n重复**重点**。\r\n\r\n重复**重点**。\r\n\r\n同名\r\n---\r\n\r\n### 同名\r\n\r\n> # quoted\r\n\r\n```md\r\n# code\r\n```\r\n';
  const result = structuredClone(analyzeReading(source, 3));
  assert.deepEqual(result.sections.sections.map(s => [s.title,s.depth,s.parentIndex]), [['中文 😀',1,null],['同名',2,0],['同名',3,1]]);
  const blocks = result.selection.blocks.filter(b => b.visibleText === '重复重点。');
  assert.equal(blocks.length,2);
  const anchors = blocks.map(block => resolveSelection(result.selection,block.blockStart,0,4));
  for (const anchor of anchors) {
    assert.equal(anchor.ok,true);
    assert.equal(Buffer.from(source).subarray(anchor.startByte,anchor.endByte).toString(),'重复**重点');
    assert.equal(anchor.displayQuote,'重复重点');
  }
  assert.ok(anchors[1].startByte > anchors[0].endByte);
  assert.throws(() => analyzeReading(source,0), /BOM/);
});

test('extension analysis excludes code, metadata and HTML; unsupported mapping stays conservative', () => {
  const source = '---\nname: "[[metadata]]"\n---\n\n```md\n[[code]]\n```\n\n<script>[[hidden]]</script>\n\nNormal &amp; text\n\n[[visible]]\n';
  const result=analyzeReading(source,0);
  assert.deepEqual(result.extensions,['wiki-link']);
  assert.equal(result.selection.blocks.some(b=>b.visibleText.includes('hidden')),false);
  assert.deepEqual(analyzeReading('```md\n[[code]]\n```\n',0).extensions,[]);
  assert.equal(analyzeReading('',0).selection.blocks.length,0);
});

class FakeWorker {
  onmessage=null; onerror=null; onmessageerror=null; terminated=false; request=null;
  postMessage(value) { this.request=value; }
  terminate() { this.terminated=true; }
  reply(result) { this.onmessage?.({data:{id:this.request.id,result}}); }
}

test('new reading work interrupts old parsing and ignores queued old success, errors and duplicate replies', () => {
  const workers=[]; const results=[];
  const task=new ReadingAnalysisTask(()=>{const worker=new FakeWorker();workers.push(worker);return worker;});
  task.run('A',0,result=>results.push(result));
  task.run('B',3,result=>results.push(result));
  assert.equal(workers[0].terminated,true);
  workers[0].reply({old:true}); workers[0].onerror({preventDefault(){}});
  assert.deepEqual(results,[]);
  workers[1].onmessage({data:{id:workers[1].request.id-1,result:{wrong:true}}});
  assert.deepEqual(results,[]);
  workers[1].reply({current:true}); workers[1].reply({duplicate:true});
  assert.deepEqual(results,[{current:true}]); assert.equal(workers[1].terminated,true);
  assert.equal(workers[1].request.bomByteLength,3);
});

test('leaving the document or reading mode cancels without publishing a later result', () => {
  const worker=new FakeWorker(); let called=false;
  const task=new ReadingAnalysisTask(()=>worker);
  task.run('A',0,()=>{called=true;}); task.cancel(); worker.reply({stale:true});
  assert.equal(worker.terminated,true); assert.equal(called,false);
});

test('worker failure paths and retry never fall back to synchronous parsing', async () => {
  const results=[]; let startupFails=true; const workers=[];
  const task=new ReadingAnalysisTask(()=>{if(startupFails)throw Error('startup');const worker=new FakeWorker();workers.push(worker);return worker;});
  task.run('A',0,value=>results.push(value)); assert.deepEqual(results,[null]); startupFails=false;
  task.run('B',0,value=>results.push(value)); workers[0].reply({retried:true});
  assert.deepEqual(results,[null,{retried:true}]);
  for(const mode of ['post','error','decode','response']) {
    const worker=new FakeWorker();
    if(mode==='post') worker.postMessage=()=>{throw Error('clone');};
    const task=new ReadingAnalysisTask(()=>worker);
    const result=new Promise(resolve=>task.run('source',0,resolve));
    if(mode==='error') worker.onerror({preventDefault(){}});
    if(mode==='decode') worker.onmessageerror();
    if(mode==='response') worker.onmessage({data:{id:worker.request.id,error:true}});
    assert.equal(await result,null); assert.equal(worker.terminated,true);
  }
});

test('timeout releases the worker and ignores a later success', async () => {
  const worker=new FakeWorker(); const task=new ReadingAnalysisTask(()=>worker,5); const results=[];
  await new Promise(resolve=>task.run('source',0,result=>{results.push(result);resolve();}));
  worker.reply({late:true}); assert.deepEqual(results,[null]); assert.equal(worker.terminated,true);
});
