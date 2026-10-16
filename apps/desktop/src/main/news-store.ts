// 新闻本地快照文件与 news-file:// 协议（与 tools-store 同一模式）：
// 1. 快照根目录从数据库路径推导（dirname(db)/news，core 写入、App 与 MCP 共用）；
// 2. 注册 news-file:// 协议供渲染层 iframe 加载（webview 守卫只放行 HTTPS，快照走 iframe）。
// 只读、只圈定在 news 根目录内，路径逃逸一律 403。
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import { defaultDbPath, newsRootForDb } from '../../../../packages/core/src/index';

export const NEWS_SCHEME = 'news-file';

/** 新闻快照根目录：dirname(数据库路径)/news */
export function newsRoot(): string {
  return newsRootForDb(defaultDbPath());
}

/** 快照缺失时的占位页（iframe 内直接可读，不裸露 400/404 状态码） */
function snapshotMissingPage(): Response {
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    body { margin:0; padding:32px; font:14px/1.8 -apple-system,"PingFang SC",sans-serif; color:#666; background:#fff; }
  </style></head><body>本地快照文件缺失或已被移动。这条新闻的正文摘要仍在，可用上方「打开原文」访问来源页面。</body></html>`;
  return new Response(body, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/**
 * 注册 news-file:// 协议处理器：news-file://n/<uuid>.html → news/<uuid>.html。
 * host 固定为字母 n（与 tool-file 的 t 同理，避免数字 host 被规范化成 IP）。
 */
export function registerNewsFileProtocol(): void {
  protocol.handle(NEWS_SCHEME, (req) => {
    try {
      const u = new URL(req.url);
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      if (!rel) return new Response('Bad Request', { status: 400 });
      const root = newsRoot();
      const abs = resolve(root, rel);
      if (abs !== root && !abs.startsWith(root + sep)) {
        return new Response('Forbidden', { status: 403 });
      }
      if (!existsSync(abs)) return snapshotMissingPage();
      return net.fetch(pathToFileURL(abs).toString());
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
  });
}
