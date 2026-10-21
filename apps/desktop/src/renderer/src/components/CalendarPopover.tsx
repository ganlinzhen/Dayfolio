import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconX } from './icons';

/** 浮层挂在页面根部，跟随锚点滚动并在窗口边缘换侧。 */
export default function CalendarPopover({ anchor, title, busy = false, onClose, children }: {
  anchor: HTMLElement; title: string; busy?: boolean; onClose: () => void; children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null), titleId = useId();
  const latest = useRef({ onClose, busy });
  latest.current = { onClose, busy };
  useLayoutEffect(() => {
    const element = panel.current!;
    const previous = anchor.matches('button, [tabindex]') ? anchor : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let rect = anchor.getBoundingClientRect();
    const place = () => {
      if (anchor.isConnected) rect = anchor.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const right = rect.right + 10, left = rect.left - box.width - 10;
      element.style.left = `${Math.max(12, Math.min(right + box.width <= innerWidth - 12 ? right : left >= 12 ? left : rect.left, innerWidth - box.width - 12))}px`;
      element.style.top = `${Math.max(12, Math.min(rect.top, innerHeight - box.height - 12))}px`;
    };
    place();
    (element.querySelector<HTMLElement>('[data-autofocus]') ?? element.querySelector<HTMLElement>('input, button') ?? element).focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!element.contains(event.target as Node) && !anchor.contains(event.target as Node) && !latest.current.busy) latest.current.onClose();
    };
    const key = (event: KeyboardEvent) => {
      // 内层弹窗自行处理关闭，避免同时关闭日历浮层。
      if (document.querySelector('.modal-mask')) return;
      if (event.key === 'Escape') { event.preventDefault(); if (!latest.current.busy) latest.current.onClose(); }
      if (event.key !== 'Tab') return;
      const controls = [...element.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex="0"]')].filter(node => !node.matches(':disabled') && node.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (first && last && (event.shiftKey ? document.activeElement === first : document.activeElement === last)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    };
    const observer = new ResizeObserver(place); observer.observe(element); observer.observe(anchor);
    const movement = new MutationObserver(place); movement.observe(anchor, { attributes: true, attributeFilter: ['style'] });
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', place, true); window.addEventListener('resize', place);
    return () => {
      observer.disconnect(); movement.disconnect(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [anchor]);
  return createPortal(<div ref={panel} className="cal-popover" role="dialog" aria-labelledby={titleId} aria-busy={busy || undefined} tabIndex={-1}>
    <header className="cal-popover-head"><h3 id={titleId}>{title}</h3><button className="icon-btn" aria-label="关闭日历浮层" disabled={busy} onClick={onClose}><IconX width={16} height={16}/></button></header>
    {children}
  </div>, document.body);
}
