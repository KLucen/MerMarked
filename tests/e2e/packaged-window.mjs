import { spawn as spawnProcess, execFileSync } from 'node:child_process';
import path from 'node:path';
import { build } from 'vite';
import { connectCdp } from './cdp-client.mjs';

let bridgeScript;
async function sourceBridge() {
  bridgeScript ??= build({configFile:false,logLevel:'error',build:{write:false,
    lib:{entry:'tests/prototypes/source-controls.ts',name:'SourceTestControls',formats:['iife']}}})
    .then(result=>(Array.isArray(result)?result[0]:result).output.find(item=>item.type==='chunk').code);
  return bridgeScript;
}

// Use an actual foreground window. Windows may otherwise defer rAF, layout and
// screenshots even when BrowserWindow reports that it is visible/focused.
// Product throttling and rendering settings remain untouched.
export async function spawn(executable, args, options) {
  const userDataSwitches = args.filter(value => value === '--user-data-dir' || value.startsWith('--user-data-dir='));
  const userDataDirectory = userDataSwitches[0]?.slice('--user-data-dir='.length);
  if (userDataSwitches.length !== 1 || !userDataDirectory?.trim() || !path.isAbsolute(userDataDirectory)) {
    throw Error('A packaged-window test requires exactly one nonempty absolute --user-data-dir.');
  }
  const expectedUserData = path.resolve(userDataDirectory);
  const script = await sourceBridge();
  const remotePort = Number(args.find(value=>value.startsWith('--remote-debugging-port='))?.split('=')[1]);
  if (!remotePort) throw Error('A packaged-window test requires a renderer debugging port.');
  const existingInspector = args.find(value=>value.startsWith('--inspect='));
  const inspectorPort = existingInspector ? Number(existingInspector.split('=').at(-1).split(':').at(-1)) : remotePort+8000;
  const child = spawnProcess(executable, existingInspector ? args : [...args,`--inspect=127.0.0.1:${inspectorPort}`],{...options,windowsHide:false});
  let main;
  try {
    main = await connectCdp(inspectorPort,t=>t.type==='node');
    // The inspector accepts requests before Electron loads the application's
    // CommonJS entry. Wait for that entry before using its require function.
    const entryDeadline = Date.now() + 15000;
    let entryReady = false;
    while (!(entryReady = await main.evaluate('typeof process.mainModule?.require === "function"')) && Date.now() < entryDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!entryReady) throw Error('Packaged application entry did not load.');
    const actualUserData = await main.evaluate(`(async()=>{
      const {app}=process.mainModule.require('electron');await app.whenReady();
      return app.getPath('userData');
    })()`);
    const normalizeUserData = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (typeof actualUserData !== 'string' || normalizeUserData(actualUserData) !== normalizeUserData(expectedUserData)) {
      throw Error('The packaged application did not use the explicit isolated user-data directory.');
    }
    await main.evaluate(`(async()=>{
      const {app,BrowserWindow}=process.mainModule.require('electron');await app.whenReady();
      const deadline=Date.now()+15000;let w;
      while(!(w=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed()))&&Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,50));
      if(!w) throw Error('Packaged app window did not open.');
      const inject=()=>w.webContents.executeJavaScript(${JSON.stringify(script)});
      if(w.webContents.isLoadingMainFrame()) await new Promise(resolve=>w.webContents.once('did-finish-load',resolve));
      await inject();
      w.webContents.on('did-finish-load',()=>{void inject().catch(error=>console.error('Source test bridge failed',error));});
      w.restore();w.setAlwaysOnTop(true);w.show();w.focus();
    })()`);
    return child;
  } catch(error) {
    try {execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});} catch {child.kill('SIGKILL');}
    throw error;
  } finally {main?.close();}
}
