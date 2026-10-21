import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconX } from './icons';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  description?: string;
  wide?: boolean;
  className?: string;
  busy?: boolean;
  dismissOnBackdrop?: boolean;
}

/** 共用标题、滚动正文与固定操作区，统一键盘关闭及焦点管理。 */
export default function Modal({ title, onClose, children, footer, description, wide = false, className = '', busy = false, dismissOnBackdrop = true }: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const latest = useRef({ onClose, busy });
  latest.current = { onClose, busy };

  useEffect(() => {
    const previousFocus = opener.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = dialogRef.current!;
    if (!dialog.contains(document.activeElement)) dialog.focus();
    const handleKey = (event: KeyboardEvent) => {
      // 多层弹窗只由最上层处理键盘，避免误关下层。
      if (Array.from(document.querySelectorAll('.modal')).at(-1) !== dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!latest.current.busy) latest.current.onClose();
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]'))
        .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); dialog.focus(); return; }
      if (!dialog.contains(document.activeElement) || document.activeElement === dialog || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return createPortal(
    <div className="modal-mask" onClick={event => { if (event.target === event.currentTarget && dismissOnBackdrop && !busy) onClose(); }}>
      <div ref={dialogRef} className={`modal${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} aria-busy={busy || undefined} tabIndex={-1}>
        <header className="modal-head">
          <div className="modal-heading"><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId} className="modal-description">{description}</p>}</div>
          <button type="button" className="icon-btn modal-close" aria-label="关闭弹窗" disabled={busy} onClick={onClose}><IconX width={16} height={16} /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>, document.body,
  );
}
