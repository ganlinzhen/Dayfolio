// SDK 随宿主提供，不从 CDN 获取；工具页面通过保留路径引用。
export const RUNTIME_SDK_TEMPLATE = String.raw`(() => {
  'use strict';
  if (window.Dayfolio) return;
  const hostOrigin = __HOST_ORIGIN_JSON__;
  const nonce = crypto.randomUUID();
  Object.defineProperty(window, '__DAYFOLIO_DOCUMENT_NONCE__', { value: nonce });
  let port = null, settled = false;
  const pending = new Map(), listeners = new Set();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const hello = () => { if (!port && window.parent !== window) window.parent.postMessage({ type: 'dayfolio:hello', apiMajor: 1, nonce }, hostOrigin); };
  const timer = setInterval(hello, 250);
  const timeout = setTimeout(() => { if (!settled) { settled = true; clearInterval(timer); rejectReady(Object.assign(new Error('宿主连接超时'), { code: 'REQUEST_TIMEOUT', retryable: true })); } }, 5000);
  const receive = event => {
    const response = event.data;
    if (!response || typeof response !== 'object') return;
    if (response.type === 'dayfolio:changed') {
      for (const listener of listeners) { try { listener(response.event); } catch {} }
      return;
    }
    const request = pending.get(response.requestId);
    if (!request) return;
    pending.delete(response.requestId); clearTimeout(request.timer);
    if (response.ok) request.resolve(response.data);
    else request.reject(Object.assign(new Error(response.error?.message || '工具请求失败'), response.error || { code: 'CONTRACT_INVALID', retryable: false }));
  };
  window.addEventListener('message', event => {
    if (settled || event.source !== window.parent || event.origin !== hostOrigin || event.data?.type !== 'dayfolio:port' || event.data?.nonce !== nonce || event.ports.length !== 1) return;
    settled = true; port = event.ports[0]; port.onmessage = receive; port.start();
    clearTimeout(timeout); clearInterval(timer); resolveReady();
  });
  const call = async (method, params = {}) => {
    await ready;
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(Object.assign(new Error('请求超时，请查询结果后再重试'), { code: 'REQUEST_TIMEOUT', retryable: true })); }, 5000);
      pending.set(requestId, { resolve, reject, timer });
      try { port.postMessage({ apiMajor: 1, requestId, method, params }); }
      catch (error) { pending.delete(requestId); clearTimeout(timer); reject(error); }
    });
  };
  const onChanged = listener => { if (typeof listener !== 'function') throw new TypeError('监听器必须是函数'); listeners.add(listener); return () => listeners.delete(listener); };
  Object.defineProperty(window, 'Dayfolio', { value: Object.freeze({ ready, call, onChanged }) });
  // 页面未使用 SDK 时不制造未处理拒绝；调用者仍能通过 ready/call 得到真实错误。
  ready.catch(() => {});
  hello();
})();`;
