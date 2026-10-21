// 受信 App 主页面的运行时数据接口；工具 iframe 由独立会话绑定范围。
import { ipcMain } from 'electron';
import { runtimeErrorInfo, type TodoDeskCore } from '../../../../packages/core/src';

export function registerRuntimeIpc(core: TodoDeskCore): void {
  const routes: Record<string, (input: never) => unknown> = {
    'runtime:revision': core.runtime.getRevision,
    'runtime:timezone': core.runtime.getDisplayTimezone,
    'runtime:setTimezone': (p: { zone: string }) => core.runtime.setDisplayTimezone(p.zone),
    'calendar:queryItems':core.calendar.queryItems,
    'calendar:listCollections': core.runtime.listCollections,
    'calendar:setVisibility': core.runtime.setVisibility,
    'calendar:updateCollection': core.runtime.updateCollection,
    'calendar:deleteCollection': core.runtime.deleteCollection,
    'events:listProviders': core.externalEvents.listProviders,
    'events:refresh':core.externalEvents.refresh,
    'events:getRun':core.externalEvents.getRun,
    'events:getStatus':core.externalEvents.getStatus,
    'events:updateProvider': core.externalEvents.updateProvider,
    'events:import': core.externalEvents.import,
    'events:list': core.externalEvents.list,
    'events:get': core.externalEvents.get,
    'events:archive': core.externalEvents.archive,
    'events:deleteUnused': core.externalEvents.deleteUnused,
    'subscriptions:subscribe': core.subscriptions.subscribe,
    'subscriptions:get': core.subscriptions.get,
    'subscriptions:list': core.subscriptions.list,
    'subscriptions:unsubscribe': core.subscriptions.unsubscribe,
    'subscriptions:resumeFollowing': core.subscriptions.resumeFollowing,
  };
  for (const [channel, handler] of Object.entries(routes)) ipcMain.handle(channel, (event, input: unknown) => {
    try {
      if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw Object.assign(new Error('只允许受信宿主主页面调用'), { code: 'PERMISSION_DENIED' });
      return { ok: true, data: handler(input as never) };
    } catch (e) { const info = runtimeErrorInfo(e); return { ok: false, error: info.message, code: info.code, retryable: info.retryable }; }
  });
}
