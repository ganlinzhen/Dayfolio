import ActionButton from './ActionButton';
import { useEffect, useState, type ReactNode } from 'react';
import { IconCollapse, IconExpand } from './icons';

interface EmbeddedFrameProps {
  /** 无障碍名称，同时用于屏幕阅读器区分多个内嵌内容 */
  label: string;
  title: ReactNode;
  meta?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** 工具箱等默认已占满内容区的场景关闭全屏按钮 */
  allowFullscreen?: boolean;
}

/**
 * 内嵌 HTML 的统一容器：工具栏 + 可伸缩内容区 + 应用内全屏。
 * 全屏不是操作系统全屏，而是覆盖侧边栏右侧的整个应用内容区，保留主导航。
 */
export default function EmbeddedFrame({
  label,
  title,
  meta,
  leading,
  actions,
  children,
  className = '',
  allowFullscreen = true,
}: EmbeddedFrameProps) {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fullscreen]);

  return (
    <section
      className={`embed-frame ${fullscreen ? 'is-fullscreen' : ''} ${className}`}
      aria-label={label}
      data-fullscreen={fullscreen ? 'true' : 'false'}
    >
      <header className="embed-frame-toolbar">
        {leading}
        <div className="embed-frame-heading">
          <span className="embed-frame-title">{title}</span>
          {meta && <span className="embed-frame-meta mono">{meta}</span>}
        </div>
        <span className="spacer" />
        <div className="embed-frame-actions">
          {actions}
          {allowFullscreen && (
            <ActionButton icon={fullscreen ? IconCollapse : IconExpand}
              className="btn slim ghost embed-fullscreen-button"
              onClick={() => setFullscreen((value) => !value)}
              title={fullscreen ? '退出全屏（Esc）' : '全屏显示'}
            >

              {fullscreen ? '退出全屏' : '全屏'}
            </ActionButton>
          )}
        </div>
      </header>
      <div className="embed-frame-body">{children}</div>
    </section>
  );
}
