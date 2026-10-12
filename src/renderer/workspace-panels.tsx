import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type WorkspaceSide = 'left' | 'right';
export type WorkspaceRightPanel = 'task' | 'info';
interface PanelState {
  readonly leftOpen: boolean;
  readonly right: WorkspaceRightPanel | null;
  readonly activeSide: WorkspaceSide | null;
  readonly focused: boolean;
}
const initialPanels: PanelState = { leftOpen: true, right: null, activeSide: null, focused: false };

/** Session-only presentation state. Focus and viewport changes never discard panel contents. */
export function useWorkspacePanels() {
  const [state, setState] = useState(initialPanels);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1100px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)');
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const leftVisible = !state.focused && state.leftOpen && (!narrow || state.activeSide === 'left');
  const rightVisible = !state.focused && state.right !== null && (!narrow || state.activeSide === 'right');
  const toggleLeft = useCallback(() => setState((previous) => {
    const visible = !previous.focused && previous.leftOpen && (!narrow || previous.activeSide === 'left');
    return { ...previous, leftOpen: !visible, activeSide: visible ? null : 'left', focused: false };
  }), [narrow]);
  const openRight = useCallback((right: WorkspaceRightPanel = 'task') => setState((previous) =>
    ({ ...previous, right, activeSide: 'right', focused: false })), []);
  const toggleRight = useCallback((right: WorkspaceRightPanel = 'task') => setState((previous) => {
    const visible = !previous.focused && previous.right === right && (!narrow || previous.activeSide === 'right');
    return { ...previous, right: visible ? null : right, activeSide: visible ? null : 'right', focused: false };
  }), [narrow]);
  const close = useCallback((side: WorkspaceSide) => setState((previous) => ({
    ...previous, ...(side === 'left' ? { leftOpen: false } : { right: null }),
    activeSide: previous.activeSide === side ? null : previous.activeSide,
  })), []);
  const toggleFocus = useCallback(() => setState((previous) => ({ ...previous, focused: !previous.focused })), []);
  const reset = useCallback(() => setState(initialPanels), []);
  return { leftVisible, rightVisible, right: state.right, focused: state.focused, narrow,
    toggleLeft, toggleRight, openRight, close, toggleFocus, reset };
}

export type WorkspacePanels = ReturnType<typeof useWorkspacePanels>;
export const WorkspaceTaskHost = createContext<HTMLElement | null>(null);

/** A stable portal keeps task forms mounted while the shell hides or resizes their panel. */
export function WorkspaceTaskPanel({ children }: { readonly children: ReactNode }) {
  const host = useContext(WorkspaceTaskHost);
  return host ? createPortal(children, host) : null;
}
