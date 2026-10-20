import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function verifyCanvasWorker({ page, main, click, wait, frame, key, screenshot, snapshot, fixture, workspace }) {
  const baseline = await snapshot();
  const ready = 'document.querySelector("[data-canvas-preparation]")?.dataset.canvasPreparation==="ready"';
  const pending = 'document.querySelector("[data-canvas-preparation]")?.dataset.canvasPreparation==="pending"';
  await click('[data-mode="reader"]');
  await page.evaluate(`window.__canvasWorkers=[];window.__canvasReplies=[];window.__holdCanvas=true;window.__failCanvas=false;
    const NativeCanvasWorker=window.Worker;
    window.Worker=class extends NativeCanvasWorker {
      constructor(...args){const canvas=String(args[0]).includes('canvas-preparation.worker');
        if(canvas&&window.__failCanvas)throw Error('QA canvas worker startup failure');super(...args);
        if(canvas)window.__canvasWorkers.push(this);
        this.addEventListener('message',event=>{if(canvas){this.received=true;if(window.__holdCanvas){event.stopImmediatePropagation();window.__canvasReplies.push(()=>this.onmessage?.(event));}}});}
      terminate(){this.wasTerminated=true;this.terminatedAt=performance.now();super.terminate();}
    };`);
  await click('[data-mode="cards"]');
  await wait('window.__canvasReplies.length===1','real canvas response held');
  await wait(pending,'pending canvas');
  assert.equal(await page.evaluate('document.querySelectorAll(".react-flow__node").length'),0);
  assert.equal(await page.evaluate('document.querySelector("[data-canvas-save]").disabled'),true);
  await screenshot('worker-pending');
  await click('[data-mode="editor"]');
  assert.equal(await page.evaluate('window.__canvasWorkers[0].wasTerminated'),true);
  await page.evaluate('window.__canvasReplies.shift()()'); await frame();
  assert.equal(await page.evaluate('Boolean(document.querySelector("[data-editor-textarea]"))'),true);

  // Interrupt actual work before its reply; record response to a mode switch separately from throughput samples.
  await page.evaluate('window.__holdCanvas=false');
  await click('[data-mode="cards"]');
  await wait('window.__canvasWorkers.length===2','second worker created');
  assert.equal(await page.evaluate('Boolean(window.__canvasWorkers[1].received)'),false,'cancel before real preparation replies');
  await page.evaluate(`window.__canvasLeaveStart=performance.now();document.querySelector('[data-mode="editor"]').click()`);
  await wait('Boolean(document.querySelector("[data-editor-textarea]"))','source while preparing');
  assert.equal(await page.evaluate('window.__canvasWorkers[1].wasTerminated'),true);
  console.log('canvas cancellation', await page.evaluate('({cancelMs:Math.round(window.__canvasWorkers[1].terminatedAt-window.__canvasLeaveStart)})'));

  // A dirty snapshot and its queued reply cannot survive undo back to the persisted source.
  await page.evaluate('(()=>{const e=document.querySelector("[data-editor-textarea]");e.focus();e.setSelectionRange(0,0)})()');
  await page.send('Input.insertText',{text:'# Pending canvas candidate\n\n'});
  await wait('document.querySelector(".app-shell").dataset.dirty==="true"','dirty source');
  await page.evaluate('window.__holdCanvas=true');
  await click('[data-mode="cards"]'); await wait('window.__canvasReplies.length===1','dirty reply held');
  await click('[data-mode="editor"]');
  await page.evaluate('document.querySelector("[data-editor-textarea]").focus()');
  await key('z','KeyZ',90,2); await wait('document.querySelector(".app-shell").dataset.dirty==="false"','undo clean');
  await page.evaluate('window.__canvasReplies.shift()();window.__holdCanvas=false');
  await click('[data-mode="cards"]'); await wait(ready,'clean preparation');
  assert.equal(await page.evaluate('document.querySelector("[data-id=card-0] .canvas-card-heading strong")?.textContent'),'Heading 0');
  assert.deepEqual(await snapshot(),baseline,'cancellation and buffer undo write nothing');

  // Open another document while the first document has a queued reply.
  await click('[data-mode="reader"]'); await page.evaluate('window.__holdCanvas=true');
  await click('[data-mode="cards"]'); await wait('window.__canvasReplies.length===1','old document response');
  const second = path.join(workspace,'second-canvas.md');
  const secondSource = '# Current canvas document\n\nSecond body 中文😀\n';
  await writeFile(second,secondSource);
  const openFile = async file => {
    await main.evaluate('process.mainModule.require("electron").dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+JSON.stringify(file)+']})');
    await click('[aria-label="打开文档"]');
    await wait('document.querySelector(".file-name")?.textContent==='+JSON.stringify(path.basename(file)),'opened document');
  };
  await openFile(second); await click('[data-mode="cards"]'); await wait('window.__canvasReplies.length===2','new document response');
  await page.evaluate('window.__canvasReplies.shift()()'); await frame(); await wait(pending,'old reply rejected');
  assert.equal(await page.evaluate('document.querySelectorAll(".react-flow__node").length'),0);
  await page.evaluate('window.__canvasReplies.shift()();window.__holdCanvas=false'); await wait(ready,'new document canvas');
  assert.equal(await page.evaluate('document.querySelector(".canvas-card-heading strong").textContent'),'Current canvas document');
  assert.equal(await readFile(second,'utf8'),secondSource);
  for(const suffix of ['.annotations.yaml','.mermarkd.json']) await assert.rejects(stat(second+suffix),{code:'ENOENT'});

  await openFile(fixture); await page.evaluate('window.__failCanvas=true'); await click('[data-mode="cards"]');
  await wait('document.querySelector("[data-canvas-preparation]")?.dataset.canvasPreparation==="error"','worker startup failure');
  assert.equal(await page.evaluate('document.querySelectorAll(".react-flow__node").length'),0);
  assert.equal(await page.evaluate('document.querySelector("[data-canvas-save]").disabled'),true);
  await screenshot('worker-error');
  await page.evaluate('window.__failCanvas=false');
  await click('[title="放弃当前未保存画布候选并重新载入"]'); await wait(ready,'retry canvas');
  assert.equal(await page.evaluate('document.querySelectorAll(".react-flow__node").length'),200);
  assert.deepEqual(await snapshot(),baseline,'failure, retry and document switches write nothing');
  assert.equal(await page.evaluate('window.__canvasWorkers.every(worker=>worker.wasTerminated)'),true,'completed and cancelled workers release resources');
  console.log('PERF3G worker checks passed: real worker, pending/cancel/queued replies, document and dirty source changes, failure/retry, no missing sidecar creation.');
}
