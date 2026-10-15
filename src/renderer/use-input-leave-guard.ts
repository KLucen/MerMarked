import { useCallback, useEffect, useRef, useState } from 'react';
import { authorizeInputLeave, type LeaveInputSnapshot } from '../core/input-leave';

/** Permissions apply to one exact in-memory snapshot, never to a later draft. */
export function useInputLeaveGuard(getSnapshot: () => LeaveInputSnapshot,
  onReturn: () => void, onBlocked: () => void) {
  const latest = useRef({ getSnapshot, onReturn, onBlocked });
  latest.current = { getSnapshot, onReturn, onBlocked };
  const occupied = useRef(false);
  const closeRequest = useRef<string | null>(null);
  const returnRequested = useRef(false);
  const origin = useRef<HTMLElement | null>(null);
  const [locked, setLocked] = useState(false);

  const authorize = useCallback(async () => {
    const answer = await authorizeInputLeave(() => latest.current.getSnapshot(), window.mermarkd.confirmLeaveInputs);
    if (answer === 'return') returnRequested.current = true;
    if (answer === 'blocked') latest.current.onBlocked();
    return answer === 'allow';
  }, []);

  const run = useCallback(async (action: () => Promise<void>) => {
    if (occupied.current) return;
    if (latest.current.getSnapshot().busy) { latest.current.onBlocked(); return; }
    origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    occupied.current = true;
    setLocked(true);
    try { if (await authorize()) await action(); }
    catch { latest.current.onBlocked(); }
    finally { occupied.current = false; setLocked(false); }
  }, [authorize]);

  useEffect(() => {
    if (locked) return;
    if (returnRequested.current) {
      returnRequested.current = false;
      latest.current.onReturn();
    } else if (origin.current?.isConnected) origin.current.focus({ preventScroll: true });
    origin.current = null;
  }, [locked]);

  useEffect(() => {
    const finish = window.mermarkd.onCloseRequestFinished((id) => {
      if (closeRequest.current !== id) return;
      closeRequest.current = null;
      occupied.current = false;
      setLocked(false);
    });
    const unsubscribe = window.mermarkd.onCloseRequest((id) => {
      if (occupied.current) { window.mermarkd.replyToCloseRequest(id, false); return; }
      if (latest.current.getSnapshot().busy) {
        latest.current.onBlocked(); window.mermarkd.replyToCloseRequest(id, false); return;
      }
      origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      occupied.current = true;
      closeRequest.current = id;
      setLocked(true);
      void authorize().then((allowed) => {
        if (closeRequest.current === id) window.mermarkd.replyToCloseRequest(id, allowed);
      }).catch(() => {
        if (closeRequest.current === id) window.mermarkd.replyToCloseRequest(id, false);
      });
    });
    return () => { unsubscribe(); finish(); };
  }, [authorize]);

  useEffect(() => {
    const blockShortcuts = (event: KeyboardEvent) => {
      if (!occupied.current) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', blockShortcuts, true);
    return () => window.removeEventListener('keydown', blockShortcuts, true);
  }, []);

  return { locked, run };
}
