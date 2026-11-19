import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { XYFLOW_ORIGINAL_SHA256, XYFLOW_PATCHED_SHA256, XYFLOW_VERSION,
  patchXyflowAutopan, patchXyflowAutopanBytes } from '../../scripts/patch-xyflow-autopan.mjs';

const packageRoot = new URL('../../node_modules/@xyflow/system/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', packageRoot), 'utf8'));
assert.equal(manifest.version, XYFLOW_VERSION, 'The exact locked dependency contract must be reviewed on upgrade.');
const installed = await readFile(new URL('dist/esm/index.mjs', packageRoot));
const launch = '            if (!autoPanStarted && autoPanOnNodeDrag && dragStarted) {\n' +
  '                autoPanStarted = true;\n                autoPan();\n            }\n';
const capture = '            const shouldStartAutoPan = !autoPanStarted && autoPanOnNodeDrag && dragStarted;\n';
const deferredLaunch = launch.replace('!autoPanStarted && autoPanOnNodeDrag && dragStarted', 'shouldStartAutoPan');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// Both install states are valid test inputs. Reconstruct the original from the
// exact approved patched bytes; its complete checksum must match the vendor.
const original = sha256(installed) === XYFLOW_PATCHED_SHA256
  ? Buffer.from(installed.toString('utf8').replace(capture, launch).replace(deferredLaunch, '')) : installed;
assert.equal(sha256(original), XYFLOW_ORIGINAL_SHA256, 'Tests never silently accept a changed vendor source.');
const patched = patchXyflowAutopanBytes(original).bytes;

test('the patch changes only the pinned first-auto-pan ordering and verifies both complete byte hashes', () => {
  const result = patchXyflowAutopanBytes(original);
  assert.equal(result.changed, true);
  assert.ok(result.bytes.length > original.length, 'one captured start decision preserves the threshold-event timing');
  assert.equal(sha256(result.bytes), XYFLOW_PATCHED_SHA256);
  assert.equal(result.bytes.toString('utf8').split(deferredLaunch).length, 2);
  assert.equal(result.bytes.toString('utf8').split(capture).length, 2);
  const originalTail = original.toString('utf8').slice(original.toString('utf8').indexOf("            .on('end'"));
  const patchedTail = result.bytes.toString('utf8').slice(result.bytes.toString('utf8').indexOf("            .on('end'"));
  assert.equal(patchedTail, originalTail, 'release/cancellation behavior is byte-identical');
});

test('an already-patched dependency is idempotent without returning an alias to its input', () => {
  const result = patchXyflowAutopanBytes(patched);
  assert.equal(result.changed, false); assert.deepEqual(result.bytes, patched);
  result.bytes[0] ^= 1;
  assert.equal(sha256(patched), XYFLOW_PATCHED_SHA256);
});

test('changed, truncated, CRLF-converted or spoofed source is rejected', () => {
  const changed = Buffer.from(original); changed[0] ^= 1;
  const discardedPrototype = Buffer.from(patched.toString('utf8').replace(capture, '').replace(deferredLaunch, launch));
  assert.equal(sha256(discardedPrototype), '034d97f2651d9c941eeecac784c91914885b7f1b18d62f40432235215a962a68');
  for (const bytes of [changed, original.subarray(0, original.length - 1), Buffer.from(original.toString('utf8').replaceAll('\n', '\r\n')),
    Buffer.from(patched.toString('utf8') + '\n'), Buffer.from(launch), discardedPrototype]) {
    assert.throws(() => patchXyflowAutopanBytes(bytes), /checksum/);
  }
});

async function temporaryPackage(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-xyflow-patch-'));
  try {
    await mkdir(path.join(directory, 'dist/esm'), { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: '@xyflow/system', version: XYFLOW_VERSION }));
    for (const name of ['index.js', 'index.mjs']) await writeFile(path.join(directory, 'dist/esm', name), original);
    await run(directory);
  } finally {
    const actual = await realpath(directory), temporary = await realpath(os.tmpdir());
    const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
    assert.ok(pathKey(actual).startsWith(pathKey(temporary) + path.sep) && path.basename(actual).startsWith('mermarkd-xyflow-patch-'));
    await rm(actual, { recursive: true, force: true });
  }
}

test('both ESM entries are patched, independently verified and repeatable', async () => {
  await temporaryPackage(async directory => {
    assert.equal((await patchXyflowAutopan(directory)).filter(row => row.changed).length, 2);
    for (const name of ['index.js', 'index.mjs']) assert.equal(sha256(await readFile(path.join(directory, 'dist/esm', name))), XYFLOW_PATCHED_SHA256);
    assert.ok((await patchXyflowAutopan(directory)).every(row => !row.changed));
  });
});

test('an interrupted install with one approved entry patched can complete safely', async () => {
  await temporaryPackage(async directory => {
    await writeFile(path.join(directory, 'dist/esm/index.js'), patched);
    const changes = await patchXyflowAutopan(directory);
    assert.deepEqual(changes.map(row => row.changed), [false, true]);
  });
});

test('unsupported versions and a changed second entry fail before either file is patched', async () => {
  await temporaryPackage(async directory => {
    const first = path.join(directory, 'dist/esm/index.js'), second = path.join(directory, 'dist/esm/index.mjs');
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: '@xyflow/system', version: '0.0.84' }));
    await assert.rejects(patchXyflowAutopan(directory), /version/);
    assert.equal(sha256(await readFile(first)), XYFLOW_ORIGINAL_SHA256);
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: '@xyflow/system', version: XYFLOW_VERSION }));
    await writeFile(second, Buffer.concat([original, Buffer.from('\n')]));
    await assert.rejects(patchXyflowAutopan(directory), /checksum/);
    assert.equal(sha256(await readFile(first)), XYFLOW_ORIGINAL_SHA256);
  });
});

function handlerWithDeferredPan(bytes, zoom, initiallyDragging = true) {
  const source = bytes.toString('utf8');
  const autoStart = source.indexOf('        async function autoPan() {'), autoEnd = source.indexOf('        function startDrag(event)', autoStart);
  const dragStart = source.indexOf("            .on('drag', (event) => {"), dragEnd = source.indexOf("        })\n            .on('end'", dragStart);
  assert.ok(autoStart >= 0 && autoEnd > autoStart && dragStart >= 0 && dragEnd > dragStart);
  const autoPan = source.slice(autoStart, autoEnd);
  const drag = source.slice(dragStart + "            .on('drag', (event) => {".length, dragEnd);
  const context = { zoom, initiallyDragging };
  runInNewContext(`
    let transform=[0,0,zoom],lastPos={x:100/zoom,y:100/zoom},mousePosition={x:100,y:100};
    let autoPanStarted=false,dragStarted=initiallyDragging,abortDrag=false,dragEvent,autoPanId;
    const containerBounds={},nodeId='card-0',dragItems=new Map([[nodeId,{}]]),positions=[];
    let releasePan,panRequests=0;
    const panBy=({x,y})=>{panRequests++;transform=[transform[0]+x,transform[1]+y,zoom];return new Promise(resolve=>{releasePan=()=>resolve(true);});};
    const getStoreItems=()=>({transform,panBy,autoPanSpeed:15,autoPanOnNodeDrag:true,snapGrid:[1,1],snapToGrid:false,nodeDragThreshold:1,nodeLookup:new Map([[nodeId,{}]])});
    const getPointerPosition=(event,{transform})=>({x:(event.clientX-transform[0])/zoom,y:(event.clientY-transform[1])/zoom,xSnapped:(event.clientX-transform[0])/zoom,ySnapped:(event.clientY-transform[1])/zoom});
    const getEventPosition=event=>({x:event.clientX,y:event.clientY});
    const calcAutoPan=()=>[10.5,0];
    const requestAnimationFrame=()=>1,cancelAnimationFrame=()=>{};
    function updateNodes({x,y}){lastPos={x,y};positions.push({x,y});}
    function startDrag(event){dragStarted=true;lastPos=getPointerPosition(event.sourceEvent,{transform});}
    ${autoPan}
    const handle=event=>{${drag}};
    globalThis.begin=(clientX=99)=>handle({sourceEvent:{type:'mousemove',clientX,clientY:100}});
    globalThis.release=()=>releasePan();
    globalThis.snapshot=()=>JSON.stringify({positions,transform,lastPos,autoPanStarted,dragStarted,panRequests});
  `, context);
  return context;
}

test('the real threshold-event handler keeps auto-pan waiting until the following drag event', async () => {
  for (const bytes of [original, patched]) {
    const handler = handlerWithDeferredPan(bytes, 0.11, false);
    handler.begin(97);
    const threshold = JSON.parse(handler.snapshot());
    assert.equal(threshold.dragStarted, true);
    assert.equal(threshold.autoPanStarted, false);
    assert.equal(threshold.panRequests, 0, 'crossing the threshold does not add an earlier pan');
    handler.begin(96);
    assert.equal(JSON.parse(handler.snapshot()).panRequests, 1);
    handler.release(); await Promise.resolve();
  }
});

for (const zoom of [0.11, 1, 2]) {
  test(`the real deferred auto-pan/drag handlers preserve the pointer position at zoom ${zoom}`, async () => {
    const old = handlerWithDeferredPan(original, zoom), fixed = handlerWithDeferredPan(patched, zoom);
    old.begin(); fixed.begin();
    old.release(); fixed.release(); await Promise.resolve();
    const previous = JSON.parse(old.snapshot()), next = JSON.parse(fixed.snapshot());
    const expected = (99 - 10.5) / zoom;
    assert.ok(Math.abs((previous.lastPos.x - expected) * zoom - 10.5) < 1e-10, 'old source overwrites the pending pan compensation with pre-pan pointer coordinates');
    assert.ok(Math.abs((next.lastPos.x - expected) * zoom) < 1e-10, 'patched source updates pointer coordinates before beginning pan');
    assert.equal(next.transform[0], previous.transform[0], 'same pan distance and speed contract');
    assert.equal(next.autoPanStarted, true);
  });
}
