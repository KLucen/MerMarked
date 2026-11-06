import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Run on an otherwise idle machine. Never run a second window suite, build,
// profiler or forced-GC probe alongside this cohort. A failure stops the run;
// the manifest preserves it rather than replacing a slow/failed observation.
const root = process.cwd();
const cohort = process.argv[2] ?? 'canvas';
assert.ok(['canvas','loaded'].includes(cohort));
const prefix = process.env.MERMARKD_PERF_COHORT_PREFIX ?? 'perf3-exit-ac';
const qa = path.join(root,'out/qa'); await mkdir(qa,{recursive:true});
const candidates = {
  before:path.join(root,'out/qa/perf3-exit-perf3g-baseline/MerMarkd.exe'),
  after:path.join(root,'out/MerMarkd-win32-x64/MerMarkd.exe'),
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const packages = {};
for(const [role,executable] of Object.entries(candidates)) packages[role]={executable,asarSha256:digest(await readFile(path.join(path.dirname(executable),'resources/app.asar')))};
const scripts={};
for(const file of ['perf3e-canvas-packaged.mjs','perf3d-responsiveness-packaged.mjs','packaged-window.mjs','../prototypes/source-controls.ts']) scripts[file]=digest(await readFile(path.join(root,'tests/e2e',file)));
const manifest={cohort,prefix,startedAt:new Date().toISOString(),node:process.version,platform:process.platform,
  cpus:os.cpus().map(cpu=>cpu.model),totalMemoryBytes:os.totalmem(),packages,scripts,
  coldDefinition:'New application process and user-data directory, first document open; OS file cache is not flushed.',
  frameWindowDefinition:'Original full automation window retained; separate normal-interaction window begins at first actual input (spanning intervals clipped at input), or measurement start for actions without input.',
  repeatDefinition:cohort==='canvas'?'Reopen the same file in the same process; all semantic DOM and 500 attached highlights required.':null,
  note:'Ordinary samples: no forced GC or CPU profiler. Tests inject the same public-API source control bridge into both packages.',runs:[]};
const manifestPath=path.join(qa,`${prefix}-${cohort}-manifest.json`);
const save=()=>writeFile(manifestPath,JSON.stringify(manifest,null,2));
await save();
for(const mib of [1,5]) for(let round=1;round<=5;round++) for(const role of round%2?['before','after']:['after','before']) {
  const label=`${cohort}-${role}-${mib}m-${round}`;
  const log=path.join(qa,`${prefix}-${label}.log`);
  const env={...process.env,MERMARKD_QA_EXE:candidates[role],MERMARKD_QA_ARTIFACT_PREFIX:prefix,
    MERMARKD_PERF_MIB:String(mib),MERMARKD_PERF_LABEL:cohort==='canvas'?label:`${prefix}-${label}`};
  for(const key of ['MERMARKD_PERF_PROFILE','MERMARKD_PERF_PROFILE_CARDS','MERMARKD_PERF_INPUT_PROFILE','MERMARKD_PERF_TRACE_STAGE','MERMARKD_PERF_HIDE_GRID','MERMARKD_PERF_GC_PROBE','MERMARKD_PERF_PENDING_SOURCE','MERMARKD_PERF_VERIFY_LIFECYCLE','MERMARKD_PERF_VERIFY_CANVAS_WORKER','MERMARKD_PERF_REPEAT_OPEN','MERMARKD_PERF_SCALE','MERMARKD_QA_RENDERER_URL']) delete env[key];
  if(cohort==='canvas') env.MERMARKD_PERF_REPEAT_OPEN='1'; else env.MERMARKD_PERF_SCALE='1';
  const record={mib,round,role,label,log,startedAt:new Date().toISOString(),status:'running'};
  manifest.runs.push(record);await save();
  const stream=createWriteStream(log);
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(root,'tests/e2e',cohort==='canvas'?'perf3e-canvas-packaged.mjs':'perf3d-responsiveness-packaged.mjs')],{cwd:root,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false});
    let timedOut=false;
    const timeout=setTimeout(()=>{timedOut=true;try{execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});}catch{child.kill('SIGKILL');}},180000);
    child.once('error',error=>{clearTimeout(timeout);stream.end();reject(error);});
    child.once('exit',code=>{clearTimeout(timeout);stream.end(()=>resolve({code,timedOut}));});
  });
  Object.assign(record,{...result,finishedAt:new Date().toISOString(),status:result.code===0&&!result.timedOut?'passed':'failed'});
  if(record.status==='passed'){
    const json=path.join(qa,cohort==='canvas'?`${prefix}-${label}.json`:`perf3d-${prefix}-${label}.json`);
    const data=JSON.parse(await readFile(json,'utf8'));
    assert.equal(data.headings,200);assert.equal(data.annotations,500);
    assert.equal(data.measurements.find(row=>row.name==='fit-200-cards').visibleCards,200);
    record.result=json;record.sourceBytes=data.sourceBytes;
  }
  await save();console.log(`${record.status} ${label}`);
  assert.equal(record.status,'passed',`See ${log}; incomplete cohort retained in ${manifestPath}`);
}
manifest.finishedAt=new Date().toISOString();manifest.status='complete';await save();
console.log(`Completed ${manifest.runs.length} ${cohort} samples.`);
