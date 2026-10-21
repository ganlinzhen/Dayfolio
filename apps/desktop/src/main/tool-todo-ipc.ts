// 仅受信主页面可调用；工具身份还须与当前实际加载的直属 iframe 对应。
import { ipcMain } from 'electron';
import { runtimeErrorInfo, type TodoDeskCore } from '../../../../packages/core/src';

export function registerToolTodoIpc(core: TodoDeskCore) {
  const routes = {
    'toolTodos:preview': core.toolTodos.preview,
    'toolTodos:create': core.toolTodos.create,
    'toolTodos:getStatus': core.toolTodos.getStatus,
  };
  for (const [channel, handler] of Object.entries(routes)) ipcMain.handle(channel, (event, input) => {
    try {
      const main = event.sender.mainFrame;
      if (event.senderFrame !== main || !main.frames.some(frame => {
        try {
          const url = new URL(frame.url);
          return !frame.detached && url.protocol === 'tool-file:' && url.hostname === 't' && Number(url.pathname.split('/')[1]) === input?.toolId;
        } catch { return false; }
      })) throw Object.assign(new Error('工具页面身份已失效，请重新打开工具'), { code: 'PERMISSION_DENIED' });
      return { ok: true, data: handler(input) };
    } catch (error) {
      const info = runtimeErrorInfo(error);
      return { ok: false, error: info.message, code: info.code, retryable: info.retryable };
    }
  });
}
