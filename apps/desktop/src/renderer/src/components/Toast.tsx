import ActionButton from './ActionButton';
// 全局操作反馈 toast：模块级极简 store + Host 组件（App 挂载一次）
// 支持「撤销」类动作；提示自动消失，不打断输入
import { useSyncExternalStore } from 'react';
import type { ComponentType, ReactElement, SVGProps } from 'react';

export interface ToastAction {
  icon: ComponentType<SVGProps<SVGSVGElement>> | ReactElement;
  label: string;
  run: () => void;
}

interface ToastItem {
  id: number;
  text: string;
  action?: ToastAction;
}

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

const emit = () => listeners.forEach((l) => l());

export function toast(text: string, action?: ToastAction, ms = 4500) {
  const item: ToastItem = { id: ++seq, text, action };
  items = [item, ...items].slice(0, 3);
  emit();
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    items = [];
    emit();
  }, ms);
}

export function dismissToast(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export function ToastHost() {
  const list = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => items,
  );
  if (list.length === 0) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="toast">
          <span className="toast-text">{t.text}</span>
          {t.action && (
            <ActionButton icon={t.action.icon}
              className="toast-action"
              onClick={() => {
                t.action?.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </ActionButton>
          )}
          <button className="toast-close" aria-label="关闭提示" onClick={() => dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
