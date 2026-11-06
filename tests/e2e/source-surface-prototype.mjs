import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { spawn } from './packaged-window.mjs';
import { connectCdp } from './cdp-client.mjs';

const root = process.cwd(); const output = path.join(root, 'out/qa/source-surface-prototype');
await mkdir(output, { recursive: true });
await build({ configFile: false, logLevel: 'error', build: { outDir: output, emptyOutDir: false,
  lib: { entry: 'tests/prototypes/source-surface.ts', name: 'SourceSurfacePrototype', formats: ['iife'], fileName: () => 'surface.js' } } });
const html = path.join(output, 'index.html');
await writeFile(html, `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"><title>Source surface prototype</title><style>
html,body{height:100%;margin:0}#source{height:calc(100% - 40px);margin:20px;overflow:hidden;border:1px solid #cfd7e4;box-sizing:border-box}textarea{height:100%;width:100%;box-sizing:border-box;border:0;resize:none;padding:18px 20px;font:13px/1.65 Consolas,monospace;white-space:pre;tab-size:4}
</style><div id="source"></div><script src="surface.js"></script>`);
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-source-prototype-'));
const port = 17500 + Math.floor(Math.random() * 100);
const child = await spawn(path.join(root, 'out/MerMarkd-win32-x64/MerMarkd.exe'), [
  `--remote-debugging-port=${port}`, `--inspect=${port + 200}`, `--user-data-dir=${workspace}`,
], { stdio: 'ignore' });
let main, page;
try {
  main = await connectCdp(port + 200, t => t.type === 'node');
  await main.evaluate(`(async () => { const {BrowserWindow}=process.mainModule.require('electron'); BrowserWindow.getAllWindows().forEach(w=>w.hide()); const w=new BrowserWindow({width:1200,height:800,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false}}); w.setAlwaysOnTop(true); await w.loadFile(${JSON.stringify(html)});w.show();w.focus(); })()`);
  page = await connectCdp(port, t => t.type === 'page' && t.url.includes('source-surface-prototype'));
  assert.equal(await page.evaluate('document.visibilityState'), 'visible');
  const samples = [];
  for (const mib of [1, 5]) {
    const paragraph = '正文 English 😀 ' + 'plain content '.repeat(Math.ceil(mib * 1024 * 1024 / 200 / 14));
    const text = Array.from({ length: 200 }, (_, i) => `# Heading ${i}\n\n${paragraph}\n\n`).join('');
    await page.evaluate(`window.prototypeText=${JSON.stringify(text)}`);
    for (let run = 0; run < 5; run++) for (const kind of run % 2 ? ['codemirror', 'textarea'] : ['textarea', 'codemirror']) {
      await page.send('HeapProfiler.collectGarbage');
      const measured = await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>{
        const gaps=[];let last=performance.now(), frame;const tick=now=>{gaps.push(now-last);last=now;frame=requestAnimationFrame(tick)};frame=requestAnimationFrame(tick);
        const start=performance.now();sourcePrototype.mount('${kind}',prototypeText);
        requestAnimationFrame(()=>requestAnimationFrame(()=>{cancelAnimationFrame(frame);resolve({elapsedMs:performance.now()-start,maxFrameGapMs:Math.max(...gaps),stats:sourcePrototype.stats()})}));
      }))`);
      assert.equal(await page.evaluate('sourcePrototype.value()===prototypeText'), true, 'entire raw source retained');
      samples.push({ mib, run, kind, ...measured });
    }
    await page.evaluate(`sourcePrototype.mount('codemirror',prototypeText);sourcePrototype.select(prototypeText.length)`);
    await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const insertion = '\n多行输入😀\n**raw Markdown**';
    await main.evaluate(`process.mainModule.require('electron').clipboard.writeText(${JSON.stringify(insertion)})`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
    assert.equal(await page.evaluate(`sourcePrototype.value()===prototypeText+${JSON.stringify(insertion)}`), true,
      JSON.stringify(await page.evaluate(`({stats:sourcePrototype.stats(),end:sourcePrototype.value().slice(-70),active:document.activeElement?.outerHTML.slice(0,200),visibility:document.visibilityState})`)));
    await page.evaluate('sourcePrototype.readonly(true)');
    await page.send('Input.insertText', { text: '禁止写入' });
    assert.equal(await page.evaluate(`sourcePrototype.value().endsWith('**raw Markdown**')`), true, 'read-only rejects user input');
    await page.evaluate('sourcePrototype.readonly(false);sourcePrototype.select(0,sourcePrototype.value().length)');
    await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 });
    const copied = await main.evaluate(`process.mainModule.require('electron').clipboard.readText()`);
    assert.equal(copied.replaceAll('\r\n','\n'), text+'\n多行输入😀\n**raw Markdown**', 'copy includes unmounted lines');
  }
  await writeFile(path.join(output, 'measurements.json'), JSON.stringify({ status: 'passed', samples, boundaries: ['full raw source', 'multiline/emoji input at end', 'read-only', 'copy across virtualized lines'], note: 'Independent prototype; does not establish application exit gates.' }, null, 2));
  for (const mib of [1, 5]) for (const kind of ['textarea', 'codemirror']) {
    const rows = samples.filter(row => row.mib === mib && row.kind === kind);
    const median = values => values.sort((a,b)=>a-b)[2];
    console.log(JSON.stringify({ mib, kind, medianMs:median(rows.map(r=>r.elapsedMs)), worstMs:Math.max(...rows.map(r=>r.elapsedMs)), longestFrameMs:Math.max(...rows.map(r=>r.maxFrameGapMs)) }));
  }
} finally {
  page?.close();main?.close();
  try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { child.kill('SIGKILL'); }
  await rm(workspace, {recursive:true,force:true,maxRetries:10,retryDelay:100});
}
