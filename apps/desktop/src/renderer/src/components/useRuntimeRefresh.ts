// 自身写入立即刷新；外部 MCP 写入通过 2 秒修订检查与聚焦检查发现。
import { useEffect, useRef } from 'react';
import { api, call } from '../api';
export function useRuntimeRefresh(refresh: () => Promise<void>) {
  const callback = useRef(refresh); callback.current = refresh;
  useEffect(() => {
    let stopped = false, busy = false, queued = false, revision = -1;
    const check = async (force = false) => {
      if (busy) { queued ||= force; return; }
      busy = true;
      try {
        const next = await call<number>(() => api.runtime.revision());
        if (!stopped && (force || next !== revision)) { await callback.current(); revision = next; }
      } catch { /* 具体页面保留查询错误；瞬时观察错误由下一次检查恢复。 */ }
      finally { busy = false; if (queued && !stopped) { queued = false; void check(true); } }
    };
    const changed = () => void check(true);
    const focus = () => { if (!document.hidden) void check(true); };
    let ticks = 0;
    const timer = window.setInterval(() => { if (!document.hidden || ++ticks % 5 === 0) void check(); }, 2000);
    window.addEventListener('dayfolio:changed', changed); window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    void check(true);
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener('dayfolio:changed', changed); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, []);
}
