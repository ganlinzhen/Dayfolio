// 通用空状态：图标 + 标题 + 引导文案 + 可选动作（空态要教用户下一步）
import type { ReactNode } from 'react';

export default function EmptyState({ icon, title, hint, action }: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty empty-state">
      {icon}
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
      {action}
    </div>
  );
}
