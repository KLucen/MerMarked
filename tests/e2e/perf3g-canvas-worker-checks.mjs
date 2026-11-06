import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function verifyCanvasWorker({ page, main, click, wait, frame, key, screenshot, snapshot, fixture, workspace }) {
  const baseline = await snapshot();
  const ready = 'document.querySelector("[data-canvas-preparation]")?.dataset.canvasPreparation==="ready"';
  const pending = 'document.querySelector("[data-canvas-preparation]")?.dataset.canvasPreparation==="pending"';
  await click('[data-mode="reader"]');
  await wait('document.querySelector("[data-reading-analysis]")?.dataset.readingAnalysis==="ready"','reader ready for projection reuse');
  await page.evaluate('window.__retainedHeading=document.querySelector(".markdown-body h1");window.__retainedText=document.querySelector(".markdown-body").textContent');
  await page.evaluate(`window.__canvasWorkers=[];window.__canvasReplies=[];window.__holdCanvas=true;window.__failCanvas=false;
    window.__holdReadingForCanvas=false;
    const NativeCanvasWorker=window.Worker;
    window.Worker=class extends NativeCanvasWorker {
      constructor(...args){const canvas=String(args[0]).includes('canvas-preparation.worker');
        if(canvas&&window.__failCanvas)throw Error('QA canvas worker startup failure');super(...args);
        if(canvas)window.__canvasWorkers.push(this);
        this.addEventListener('message',event=>{
          if(!canvas&&String(args[0]).includes('reading-analysis.worker')&&window.__holdReadingForCanvas)event.stopImmediatePropagation();
          if(canvas){this.received=true;if(window.__holdCanvas){event.stopImmediatePropagation();window.__canvasReplies.push(()=>this.onmessage?.(event));}}});}
      terminate(){this.wasTerminated=true;this.terminatedAt=performance.now();super.terminate();}
    };`);
  // A completed reading projection is reusable, but never supplies disk state.
  await page.evaluate(`window.__partialCanvasStates=[];
    window.__partialCanvasObserver=new MutationObserver(()=>{
      if(document.querySelector('[data-canvas-preparation]')?.dataset.canvasPreparation!=='pending')return;
      const nodes=document.querySelectorAll('.react-flow__node');
      if(!nodes.length||window.__partialCanvasStates.some(state=>state.count===nodes.length))return;
      const node=nodes[0];node.focus();
      window.__partialCanvasStates.push({count:nodes.length,inert:Boolean(node.closest('[inert]')),
        focusable:node.hasAttribute('tabindex'),focused:document.activeElement===node,
        saveDisabled:document.querySelector('[data-canvas-save]')?.disabled});
    });
    window.__partialCanvasObserver.observe(document.body,{subtree:true,childList:true,attributes:true,
      attributeFilter:['data-canvas-preparation','inert']});`);
  await click('[data-mode="cards"]'); await wait(ready,'warm reading projection');
  const partialStates=await page.evaluate('window.__partialCanvasObserver.disconnect();window.__partialCanvasStates');
  assert.ok(partialStates.some(state=>state.count>0&&state.count<200),'observe real partial node mounting');
  for(const state of partialStates){
    assert.equal(state.inert,true,'pending canvas remains inert');
    assert.equal(state.focusable,true,'probe an ordinarily focusable card');
    assert.equal(state.focused,false,'partial canvas cannot take focus');
    assert.equal(state.saveDisabled,true,'partial canvas cannot save');
  }
  assert.equal(await page.evaluate('window.__canvasWorkers.length'),0,'completed reading projection avoids re-parsing');
  assert.equal(await page.evaluate('window.__retainedHeading===document.querySelector(".markdown-body h1")'),true,'reader nodes survive a mode switch');
  assert.equal(await page.evaluate('getComputedStyle(document.querySelector(".markdown-body")).visibility'), 'hidden');
  assert.equal(await page.evaluate('(()=>{window.__retainedHeading.focus();return document.activeElement===window.__retainedHeading;})()'),false,'cached reader cannot take focus');
  await click('[data-mode="reader"]');
  await wait('document.querySelector("[data-reading-analysis]")?.dataset.readingAnalysis==="ready"','retained reader restored');
  assert.equal(await page.evaluate('window.__retainedHeading===document.querySelector(".markdown-body h1")'),true);
  assert.equal(await page.evaluate('document.querySelector(".markdown-body").textContent===window.__retainedText'),true,'all semantic blocks remain present');
  // Reopen with reading replies held to exercise every cold/cancellation path too.
  await page.evaluate('window.__holdReadingForCanvas=true');
  await main.evaluate('process.mainModule.require("electron").dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+JSON.stringify(fixture)+']})');
  await click('[aria-label="打开文档"]');
  await wait('document.querySelector(".app-shell")?.dataset.activeMode==="reader" && document.querySelector("[data-reading-analysis]")?.dataset.readingAnalysis==="pending"','reopened document epoch');
  await click('[data-mode="cards"]');
  await wait('window.__canvasReplies.length===1','real canvas response held');
  await wait(pending,'pending canvas');
  assert.equal(await page.evaluate('document.querySelectorAll(".react-flow__node").length'),0);
  assert.equal(await page.evaluate('document.querySelector("[data-canvas-save]").disabled'),true);
  await screenshot('worker-pending');
  await click('[data-mode="editor"]');
  assert.equal(await page.evaluate('window.__canvasWorkers[0].wasTerminated'),true);
  await page.evaluate('window.__canvasReplies.shift()()'); await frame();
  assert.equal(await page.evaluate('Boolean(__sourceControl())'),true);

  // Interrupt actual work before its reply; record response to a mode switch separately from throughput samples.
  await page.evaluate('window.__holdCanvas=false');
  await click('[data-mode="cards"]');
  await wait('window.__canvasWorkers.length===2','second worker created');
  assert.equal(await page.evaluate('Boolean(window.__canvasWorkers[1].received)'),false,'cancel before real preparation replies');
  await page.evaluate(`window.__canvasLeaveStart=performance.now();document.querySelector('[data-mode="editor"]').click()`);
  await wait('Boolean(__sourceControl())','source while preparing');
  assert.equal(await page.evaluate('window.__canvasWorkers[1].wasTerminated'),true);
  console.log('canvas cancellation', await page.evaluate('({cancelMs:Math.round(window.__canvasWorkers[1].terminatedAt-window.__canvasLeaveStart)})'));

  // A dirty snapshot and its queued reply cannot survive undo back to the persisted source.
  await page.evaluate('(()=>{const e=__sourceControl();e.focus();e.setSelectionRange(0,0)})()');
  await page.send('Input.insertText',{text:'# Pending canvas candidate\n\n'});
  await wait('document.querySelector(".app-shell").dataset.dirty==="true"','dirty source');
  await page.evaluate('window.__holdCanvas=true');
  await click('[data-mode="cards"]'); await wait('window.__canvasReplies.length===1','dirty reply held');
  await click('[data-mode="editor"]');
  await page.evaluate('__sourceControl().focus()');
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
  await page.evaluate('window.__holdReadingForCanvas=false');
  console.log('PERF3G worker checks passed: real worker, pending/cancel/queued replies, document and dirty source changes, failure/retry, no missing sidecar creation.');
}
