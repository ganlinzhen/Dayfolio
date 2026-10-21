// 历史日历来源的导航信号，不再提供工具包管理界面。
export const openRuntimeTool = (extensionId: string) => window.dispatchEvent(new CustomEvent('dayfolio:openTool', { detail: { extensionId } }));
