import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSourceOutline, normalizeOutlineOffsets, projectSourceOutline } from '../src/core/source-outline.ts';
import { extractSections } from '../src/core/sections.ts';
import { markdownToEditorText } from '../src/core/editor-text.ts';
import { SourceOutlineTask } from '../src/renderer/source-outline-task.ts';

test('outline preserves exact offsets and semantic root headings with BOM, CRLF, Unicode and skipped levels', () => {
  const source = '\uFEFF---\r\nname: test\r\n---\r\n# 中文 😀\r\n\r\n> # quoted\r\n\r\n```md\r\n# code\r\n```\r\n\r\n### 同名\r\n\r\n同名\r\n---\r\n';
  assert.deepEqual(buildSourceOutline(source), [
    {key:'0',title:'中文 😀',depth:1,headingDepth:1,sourceOffset:source.indexOf('# 中文')},
    {key:'1',title:'同名',depth:2,headingDepth:3,sourceOffset:source.indexOf('### 同名')},
    {key:'2',title:'同名',depth:2,headingDepth:2,sourceOffset:source.lastIndexOf('同名')},
  ]);
  assert.deepEqual(buildSourceOutline('plain text'), []);
});

test('reuse of a parsed tree maps CRLF/CR/BOM and Unicode to the same exact editor outline', () => {
  for (const source of ['\uFEFF# 😀\r\n\r\nbody\r\n## 中文\r\n', '# A\r\rtext\r## B\r', '# A\n\n## B\n']) {
    assert.deepEqual(normalizeOutlineOffsets(source,projectSourceOutline(extractSections(source))),buildSourceOutline(markdownToEditorText(source)));
  }
});

class FakeWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  terminated = false;
  request = null;
  postMessage(value) { this.request = value; }
  terminate() { this.terminated = true; }
  reply(sections) { this.onmessage?.({data:{id:this.request.id,sections}}); }
}

test('superseding work interrupts parsing and ignores even an already queued old success or error', () => {
  const workers=[]; const results=[];
  const task = new SourceOutlineTask(() => { const worker=new FakeWorker();workers.push(worker);return worker; });
  task.run('old',value=>results.push(value));
  task.run('new',value=>results.push(value));
  assert.equal(workers[0].terminated,true);
  workers[0].reply([{key:'old'}]);
  workers[0].onerror({preventDefault(){}});
  assert.deepEqual(results,[]);
  workers[1].reply([{key:'new'}]);
  assert.deepEqual(results,[[{key:'new'}]]);
  assert.equal(workers[1].terminated,true);
  workers[1].reply([{key:'duplicate'}]);
  assert.equal(results.length,1);
});

test('cancellation on document change or unmount prevents publication', () => {
  const worker = new FakeWorker(); const task = new SourceOutlineTask(()=>worker);
  let called=false;
  task.run('document A',()=>{called=true;}); task.cancel();
  worker.reply([]);
  assert.equal(worker.terminated,true); assert.equal(called,false);
});

test('construction and postMessage failures are recoverable without synchronous parsing', () => {
  let failed=true; const worker=new FakeWorker(); const results=[];
  const task=new SourceOutlineTask(()=>{if(failed)throw Error('unavailable');return worker;});
  task.run('source',result=>results.push(result));
  assert.deepEqual(results,[null]);
  failed=false;
  task.run('source',result=>results.push(result)); worker.reply([]);
  assert.deepEqual(results,[null,[]]);
  const broken = new FakeWorker(); broken.postMessage=()=>{throw Error('clone failure');};
  new SourceOutlineTask(()=>broken).run('source',result=>assert.equal(result,null));
  assert.equal(broken.terminated,true);
});

test('worker exceptions, response errors and decoding failures release the worker', () => {
  for (const fail of [worker=>worker.onerror({preventDefault(){}}), worker=>worker.onmessageerror(),
    worker=>worker.onmessage({data:{id:worker.request.id,error:true}})]) {
    const worker=new FakeWorker(); const results=[]; const task=new SourceOutlineTask(()=>worker);
    task.run('source',result=>results.push(result)); fail(worker);
    assert.deepEqual(results,[null]); assert.equal(worker.terminated,true);
    worker.reply([]); assert.equal(results.length,1);
  }
});

test('a worker that never responds times out and cannot publish a late result', async () => {
  const worker=new FakeWorker(); const task=new SourceOutlineTask(()=>worker,5);
  const results=[];
  await new Promise(resolve=>task.run('source',result=>{results.push(result);resolve();}));
  worker.reply([]);
  assert.deepEqual(results,[null]); assert.equal(worker.terminated,true);
});
