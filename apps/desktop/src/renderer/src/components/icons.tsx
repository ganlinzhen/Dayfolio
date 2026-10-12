// 线性图标组件（1.5px 描边，Codex 风格，替代 emoji）
import type { ReactElement, SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

const base = (p: P) => ({
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...p,
});

export const IconCheck = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 12l5 5L20 6" />
  </svg>
);

export const IconList = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <path d="M4 6l.01 0M4 12l.01 0M4 18l.01 0" strokeWidth={2.2} />
  </svg>
);

export const IconBook = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H6.5A2.5 2.5 0 0 0 4 21z" />
    <path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20" />
  </svg>
);

export const IconFlame = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3c1 4-4 5.5-4 9a4 4 0 0 0 8 0c0-1.5-.8-2.6-1.6-3.4C13.7 9.8 13 8.5 13 7c0 0-1 3-3 3 0-2 2-4.5 2-7z" />
  </svg>
);

export const IconCalendar = (p: P) => (
  <svg {...base(p)}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </svg>
);

export const IconPlus = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconSearch = (p: P) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </svg>
);

export const IconX = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const IconChevronLeft = (p: P) => (
  <svg {...base(p)}>
    <path d="M14.5 5.5L8 12l6.5 6.5" />
  </svg>
);

export const IconRefresh = (p: P) => (
  <svg {...base(p)}>
    <path d="M20 11a8 8 0 1 0-.6 4M20 5v6h-6" />
  </svg>
);

/** 类型图标：learn 学习 / review 复习 / practice 练习 / rest 休息 */
export const IconItemType = ({ type, ...p }: P & { type: string }) =>
  type === 'review' ? (
    <svg {...base(p)}>
      <path d="M3.5 12a8.5 8.5 0 1 1 2.6 6.1M3.5 12v-5M3.5 12h5" />
    </svg>
  ) : type === 'practice' ? (
    <svg {...base(p)}>
      <path d="M4 20l4-1L19.5 7.5a2.1 2.1 0 0 0-3-3L5 16z" />
      <path d="M13.5 6.5l3 3" />
    </svg>
  ) : type === 'rest' ? (
    <svg {...base(p)}>
      <path d="M5 13a7 7 0 1 1 14 0v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" />
      <path d="M5 14h3l1.5-2.5L12 15l1.5-2.5L15 14h4" />
    </svg>
  ) : (
    <svg {...base(p)}>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H6.5A2.5 2.5 0 0 0 4 21z" />
      <path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20" />
    </svg>
  );

export const IconNews = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 5.5h13v13H5.5A1.5 1.5 0 0 1 4 17z" />
    <path d="M17 8h2.5A1.5 1.5 0 0 1 21 9.5v7A1.5 1.5 0 0 1 19.5 18H17" />
    <path d="M7 8.5h7M7 11.5h7M7 14.5h4.5" />
  </svg>
);

export const IconExternal = (p: P) => (
  <svg {...base(p)}>
    <path d="M14 4h6v6M20 4l-8.5 8.5" />
    <path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
  </svg>
);

/** 内嵌 HTML 内容：进入应用内全屏 */
export const IconExpand = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9" />
    <path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9" />
    <path d="M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15" />
    <path d="M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
  </svg>
);

/** 内嵌 HTML 内容：退出应用内全屏 */
export const IconCollapse = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 4v3.5A1.5 1.5 0 0 1 7.5 9H4" />
    <path d="M20 9h-3.5A1.5 1.5 0 0 1 15 7.5V4" />
    <path d="M15 20v-3.5a1.5 1.5 0 0 1 1.5-1.5H20" />
    <path d="M4 15h3.5A1.5 1.5 0 0 1 9 16.5V20" />
  </svg>
);

/** 帮助：圆 + 问号（侧边栏底部入口） */
export const IconHelp = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.4 9.5a2.6 2.6 0 0 1 5.1.6c0 1.7-2.5 2.2-2.5 3.7" />
    <path d="M12 16.6l.01 0" strokeWidth={2.2} />
  </svg>
);

/** MCP（侧边栏底部入口）：插头，AI 客户端由此接入 */
export const IconPlug = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 3.5v4M15 3.5v4" />
    <path d="M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0z" />
    <path d="M12 16v4.5" />
  </svg>
);

/** 工具箱（侧边栏入口）：手提工具箱 */
export const IconToolbox = (p: P) => (
  <svg {...base(p)}>
    <rect x="3.5" y="8" width="17" height="12" rx="2" />
    <path d="M8.5 8V6.5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2V8" />
    <path d="M3.5 12.5h17" />
  </svg>
);

// ---------- 工具箱可选图标集（新增工具弹窗里挑选） ----------

export const IconCalculator = (p: P) => (
  <svg {...base(p)}>
    <rect x="5" y="3.5" width="14" height="17" rx="2" />
    <path d="M8 7.5h8" />
    <path d="M8 12h.01M12 12h.01M16 12h.01M8 15.5h.01M12 15.5h.01M16 15.5h.01" strokeWidth={2.2} />
  </svg>
);

export const IconClock = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

export const IconConvert = (p: P) => (
  <svg {...base(p)}>
    <path d="M20 8H7l3-3" />
    <path d="M4 16h13l-3 3" />
  </svg>
);

export const IconColor = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3.5s6 6.2 6 10.2a6 6 0 0 1-12 0C6 9.7 12 3.5 12 3.5z" />
  </svg>
);

export const IconText = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 6V4.5h14V6" />
    <path d="M12 4.5v15M9.5 19.5h5" />
  </svg>
);

export const IconChart = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 20h16" />
    <path d="M7 20v-6M12 20V8M17 20v-9" />
  </svg>
);

export const IconTerminal = (p: P) => (
  <svg {...base(p)}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <path d="M7 9.5l3 2.5-3 2.5M12.5 15h4" />
  </svg>
);

export const IconImage = (p: P) => (
  <svg {...base(p)}>
    <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M3.5 16.5l4.5-4 3.5 3 3-2.5 6 5" />
  </svg>
);

export const IconMusic = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 18V6l10-2v12" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="16.5" cy="16" r="2.5" />
  </svg>
);

export const IconLink = (p: P) => (
  <svg {...base(p)}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2" />
  </svg>
);

export const IconCode = (p: P) => (
  <svg {...base(p)}>
    <path d="M8.5 7L4 12l4.5 5" />
    <path d="M15.5 7L20 12l-4.5 5" />
    <path d="M13 5l-2 14" />
  </svg>
);

export const IconDatabase = (p: P) => (
  <svg {...base(p)}>
    <ellipse cx="12" cy="5.5" rx="7" ry="2.5" />
    <path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13" />
    <path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
  </svg>
);

export const IconGlobe = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17" />
    <path d="M12 3.5c-2.7 2.3-4 5.2-4 8.5s1.3 6.2 4 8.5c2.7-2.3 4-5.2 4-8.5s-1.3-6.2-4-8.5z" />
  </svg>
);

export const IconLock = (p: P) => (
  <svg {...base(p)}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    <path d="M12 14.5v2" strokeWidth={2.2} />
  </svg>
);

export const IconWrench = (p: P) => (
  <svg {...base(p)}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
);

/** 工具可选图标清单（新增/编辑弹窗的图标网格） */
export const TOOL_ICONS: Array<{ key: string; label: string; Icon: (p: P) => ReactElement }> = [
  { key: 'tool', label: '工具', Icon: IconWrench },
  { key: 'calculator', label: '计算器', Icon: IconCalculator },
  { key: 'clock', label: '时钟', Icon: IconClock },
  { key: 'calendar', label: '日历', Icon: IconCalendar },
  { key: 'convert', label: '转换', Icon: IconConvert },
  { key: 'color', label: '取色', Icon: IconColor },
  { key: 'text', label: '文本', Icon: IconText },
  { key: 'chart', label: '图表', Icon: IconChart },
  { key: 'terminal', label: '终端', Icon: IconTerminal },
  { key: 'image', label: '图片', Icon: IconImage },
  { key: 'music', label: '音乐', Icon: IconMusic },
  { key: 'link', label: '链接', Icon: IconLink },
  { key: 'code', label: '代码', Icon: IconCode },
  { key: 'database', label: '数据', Icon: IconDatabase },
  { key: 'globe', label: '网络', Icon: IconGlobe },
  { key: 'lock', label: '加密', Icon: IconLock },
];

/** 按名称渲染工具图标（未知 key 回退扳手） */
export const IconTool = ({ name, ...p }: P & { name: string }) => {
  const def = TOOL_ICONS.find((i) => i.key === name);
  const Comp = def?.Icon ?? IconWrench;
  return <Comp {...p} />;
};

/** 编辑（铅笔） */
export const IconPencil = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 20l4-1L19.5 7.5a2.1 2.1 0 0 0-3-3L5 16z" />
    <path d="M13.5 6.5l3 3" />
  </svg>
);

/** 删除（垃圾桶） */
export const IconTrash = (p: P) => (
  <svg {...base(p)}>
    <path d="M4.5 7h15M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
    <path d="M6.5 7l1 12.5A1.5 1.5 0 0 0 9 21h6a1.5 1.5 0 0 0 1.5-1.5L17.5 7" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);

export const IconChevronUp = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 14.5l6-6 6 6" />
  </svg>
);

export const IconChevronDown = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 9.5l6 6 6-6" />
  </svg>
);

/** 上传文件 */
export const IconUpload = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 15.5V4M7 9l5-5 5 5" />
    <path d="M4.5 16v2.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V16" />
  </svg>
);

// 星标（新闻收藏）
export const IconStar = (p: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} {...p}>
    <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" strokeLinejoin="round" />
  </svg>
);

/** 知识库（侧边栏入口）：叠层卡片/书架，只读浏览 vault */
export const IconVault = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 6.5 12 3l8 3.5-8 3.5z" />
    <path d="M4 6.5v5L12 15l8-3.5v-5" />
    <path d="M4 11.5v5L12 20l8-3.5v-5" />
  </svg>
);

/** 自媒体（侧边栏入口）：喇叭，内容发布工作流 */
export const IconMegaphone = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 10.5v3a1.5 1.5 0 0 0 1.5 1.5H8l6 4.5V4.5L8 9H5.5A1.5 1.5 0 0 0 4 10.5z" />
    <path d="M17.5 9a4.5 4.5 0 0 1 0 6" />
  </svg>
);
