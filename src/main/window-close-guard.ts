import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainEvent } from 'electron';
import { randomUUID } from 'node:crypto';

/** Ask the owning renderer before the existing source-save close flow. Fail closed. */
export function createWindowCloseGuard(window: BrowserWindow) {
  let ready = false;
  let mountedOnce = false;
  let activeId: string | null = null;
  let resolve: ((allowed: boolean) => void) | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const ownFrame = (event: IpcMainEvent) => event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame;
  const settle = (allowed: boolean) => {
    if (timeout) clearTimeout(timeout);
    timeout = null;
    const pending = resolve; resolve = null; pending?.(allowed);
  };
  const onReady = (event: IpcMainEvent, value: unknown) => {
    if (!ownFrame(event) || typeof value !== 'boolean') return;
    ready = value;
    mountedOnce ||= ready;
    if (!ready) settle(false);
  };
  const onReply = (event: IpcMainEvent, id: unknown, allowed: unknown) => {
    if (!ownFrame(event) || id !== activeId || typeof allowed !== 'boolean') return;
    settle(allowed);
  };
  ipcMain.on('workspace:close-ready', onReady);
  ipcMain.on('workspace:close-reply', onReply);
  window.webContents.on('render-process-gone', () => { ready = false; settle(false); });
  window.once('closed', () => {
    settle(false);
    ipcMain.removeListener('workspace:close-ready', onReady);
    ipcMain.removeListener('workspace:close-reply', onReply);
  });
  return {
    async authorize(): Promise<boolean> {
      if (!ready) return !mountedOnce; // A crashed/unmounted editor cannot authorize leaving.
      if (activeId) return false;
      activeId = randomUUID();
      return new Promise((done) => {
        resolve = done;
        timeout = setTimeout(() => settle(false), 120_000);
        window.webContents.send('workspace:close-request', activeId);
      });
    },
    finish() {
      const id = activeId; activeId = null;
      settle(false);
      if (id && !window.isDestroyed()) window.webContents.send('workspace:close-finished', id);
    },
  };
}
