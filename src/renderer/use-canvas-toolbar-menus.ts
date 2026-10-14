import { useEffect, type RefObject } from 'react';

/** Native disclosure semantics with bounded positioning and keyboard dismissal. */
export function useCanvasToolbarMenus(toolbar: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const host = toolbar.current;
    if (!host) return;
    const menus = () => [...host.querySelectorAll<HTMLDetailsElement>('details')];
    const trigger = (menu: HTMLDetailsElement) => menu.querySelector('summary');
    const close = (menu: HTMLDetailsElement, restoreFocus = false) => {
      menu.open = false;
      if (restoreFocus) trigger(menu)?.focus({ preventScroll: true });
    };
    const position = () => {
      for (const menu of menus().filter(item => item.open)) {
        const button = trigger(menu);
        const panel = menu.querySelector<HTMLElement>('[role="group"]');
        if (!button || !panel) continue;
        const anchor = button.getBoundingClientRect();
        if (anchor.bottom <= 12 || anchor.top >= window.innerHeight - 12 ||
            anchor.right <= 0 || anchor.left >= window.innerWidth) {
          close(menu);
          continue;
        }
        const width = panel.getBoundingClientRect().width;
        const below = window.innerHeight - anchor.bottom - 18;
        const above = anchor.top - 18;
        const placeAbove = below < Math.min(panel.scrollHeight, 180) && above > below;
        const available = Math.max(40, placeAbove ? above : below);
        panel.style.setProperty('--canvas-menu-left', `${Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))}px`);
        panel.style.setProperty('--canvas-menu-top', `${placeAbove ? Math.max(12, anchor.top - Math.min(panel.scrollHeight, available) - 6) : anchor.bottom + 6}px`);
        panel.style.setProperty('--canvas-menu-height', `${available}px`);
      }
    };
    const onToggle = (event: Event) => {
      const menu = event.target;
      if (!(menu instanceof HTMLDetailsElement) || !menu.open) return;
      for (const other of menus()) if (other !== menu) close(other);
      position();
    };
    const onOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      for (const menu of menus()) if (menu.open && !menu.contains(target)) close(menu);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // React Flow listens on document for Space to activate panning. Keep the
      // summary's native Space activation local without cancelling its default.
      if (event.key === ' ' && event.target instanceof HTMLElement && event.target.tagName === 'SUMMARY') {
        event.stopPropagation(); return;
      }
      const menu = menus().find(item => item.open && item.contains(event.target as Node));
      if (!menu) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); close(menu, true); return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const actions = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      if (!actions.length) return;
      const index = actions.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? actions.length - 1
        : event.key === 'ArrowDown' ? (index + 1) % actions.length
          : index <= 0 ? actions.length - 1 : index - 1;
      event.preventDefault(); event.stopPropagation(); actions[next].focus();
    };
    const onAction = (event: MouseEvent) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      const menu = button?.closest('details');
      if (!button || button.disabled || !(menu instanceof HTMLDetailsElement)) return;
      // Let React dispatch the action before hiding its target.
      queueMicrotask(() => { if (host.isConnected) close(menu, menu.contains(document.activeElement)); });
    };
    const observer = new ResizeObserver(position);
    observer.observe(host);
    for (const menu of menus()) {
      const panel = menu.querySelector('[role="group"]');
      if (panel) observer.observe(panel);
    }
    host.addEventListener('toggle', onToggle, true);
    host.addEventListener('keydown', onKeyDown);
    host.addEventListener('click', onAction);
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('focusin', onOutside);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      observer.disconnect();
      host.removeEventListener('toggle', onToggle, true);
      host.removeEventListener('keydown', onKeyDown);
      host.removeEventListener('click', onAction);
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('focusin', onOutside);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [toolbar]);
}
