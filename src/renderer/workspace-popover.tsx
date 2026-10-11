import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/** A disclosure with native Tab navigation; not an ARIA application menu. */
export function WorkspacePopover({ label, trigger, children, className = '' }: {
  readonly label: string;
  readonly trigger: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  return <div ref={root} className={`workspace-popover ${className}`}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && open) {
        event.preventDefault(); event.stopPropagation(); setOpen(false); button.current?.focus();
      }
    }}>
    <button ref={button} type="button" className="workspace-popover-trigger" aria-label={label}
      aria-expanded={open} onClick={() => setOpen((value) => !value)}>{trigger}</button>
    {open && <div className="workspace-popover-panel" role="group" aria-label={label}>{children}</div>}
  </div>;
}
