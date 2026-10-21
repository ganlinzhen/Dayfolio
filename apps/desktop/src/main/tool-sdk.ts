// SDK 由宿主协议提供，无联网依赖；页面只获得待办草稿与自身关联状态能力。
export const TOOL_SDK_PATH = '__dayfolio__/todos-v1.js';
export const TOOL_SDK = String.raw`(() => {
  'use strict';
  if (window.dayfolio || window.parent === window) return;
  const nonce = crypto.randomUUID(), pending = new Map();
  let port, connected = false, sequence = 0, attempts = 0;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  const fail = (message, code) => Object.assign(new Error(message), { code });
  const receive = event => {
    if (event.source !== window.parent || event.data?.type !== 'dayfolio:tool:port' || event.data.nonce !== nonce || !event.ports[0]) return;
    if (connected) { event.ports[0].close(); return; }
    connected = true; clearInterval(timer); port = event.ports[0];
    port.onmessage = ({ data }) => {
      const task = pending.get(data?.requestId);
      if (!task) return;
      pending.delete(data.requestId); clearTimeout(task.timer);
      data.ok ? task.resolve(data.data) : task.reject(fail(data.error?.message || '待办请求失败', data.error?.code || 'REQUEST_FAILED'));
    };
    port.start(); resolveReady();
  };
  window.addEventListener('message', receive);
  const hello = () => {
    if (connected) return;
    if (++attempts > 40) { clearInterval(timer); rejectReady(fail('请在新版 Dayfolio 工具箱中打开此页面', 'HOST_UNAVAILABLE')); return; }
    window.parent.postMessage({ type: 'dayfolio:tool:hello', apiMajor: 1, nonce }, '*');
  };
  let timer;
  const connect = () => { timer = setInterval(hello, 250); hello(); };
  if (document.readyState === 'complete') setTimeout(connect, 0);
  else window.addEventListener('load', () => setTimeout(connect, 0), { once: true });
  const request = async (method, params) => {
    await ready;
    if (pending.size >= 8) throw fail('请求过多，请稍后再试', 'REQUEST_LIMIT');
    const requestId = String(++sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(fail('请求已超时，请重新打开工具', 'REQUEST_TIMEOUT')); }, 300000);
      pending.set(requestId, { resolve, reject, timer });
      try { port.postMessage({ apiMajor: 1, requestId, method, params }); }
      catch { pending.delete(requestId); clearTimeout(timer); reject(fail('待办参数必须能序列化为数据', 'CONTRACT_INVALID')); }
    });
  };
  const todos = Object.freeze({
    create: (item, options = {}) => request('todos.create', { ...options, items: [item] }),
    createMany: (items, options = {}) => request('todos.create', { ...options, items }),
    getStatus: sourceKeys => request('todos.getStatus', { sourceKeys }),
    open:sourceKey=>request('todos.open',{sourceKey}),
  });
  const following=Object.freeze({
    publish:snapshot=>request('following.publish',{snapshot}),
    preview:scope=>request('following.preview',{scope}),
    follow:scope=>request('following.follow',{scope}),
    unfollow:scope=>request('following.unfollow',{scope}),
    getState:(options={})=>request('following.getState',options),
  });
  Object.defineProperty(window, 'dayfolio', { value: Object.freeze({ apiMajor: 1, apiMinor:1,ready, todos,following }), writable: false, configurable: false });
  window.addEventListener('pagehide', () => {
    clearInterval(timer); port?.close();
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(fail('工具页面已关闭', 'SESSION_CLOSED')); }
    pending.clear();
  }, { once: true });
})();`;

export function injectToolSdk(html: string): string {
  const script = `<script src="/${TOOL_SDK_PATH}"></script>`;
  // 在页面已有脚本前注入，沿用其 CSP，不放宽 script-src 或执行内联代码。
  if (/<head\b[^>]*>/i.test(html)) {
    const start = html.search(/<script\b|<\/head\s*>/i);
    if (start >= 0) return html.slice(0, start) + script + html.slice(start);
    return html.replace(/<head\b[^>]*>/i, head => head + script);
  }
  return html.replace(/^(\s*<!doctype[^>]*>)?/i, prefix => prefix + script);
}
