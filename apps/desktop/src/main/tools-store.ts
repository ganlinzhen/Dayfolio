// 工具箱文件存储与 tool-file:// 协议（Electron 侧薄封装）
// 文件读写逻辑已下沉到 packages/core（utils/tool-files），此处只负责：
// 1. 以数据库路径推导工具文件根目录（与 MCP Server 一致）；
// 2. 启动时把旧 userData/tools 迁移到新位置；
// 3. 注册 tool-file:// 协议供渲染层 iframe 加载。
import { join, resolve, sep } from 'node:path';
import { app, net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import { defaultDbPath, migrateToolFilesDir, toolsRootForDb } from '../../../../packages/core/src/index';
import { injectToolSdk, TOOL_SDK, TOOL_SDK_PATH } from './tool-sdk';

export const TOOL_SCHEME = 'tool-file';

/** 工具文件根目录：dirname(数据库路径)/tools */
export function toolsRoot(): string {
  return toolsRootForDb(defaultDbPath());
}

/**
 * 一次性迁移：旧位置 userData/tools → 数据库旁的 tools/。
 * 默认路径下两者相同（无操作）；TODODESK_DB 指向别处时才真正搬移。
 */
export function migrateLegacyToolsDir(): void {
  migrateToolFilesDir(join(app.getPath('userData'), 'tools'), toolsRoot());
}

/**
 * 注册 tool-file:// 协议处理器：tool-file://t/<toolId>/<相对路径> → tools/<toolId>/<相对路径>。
 * 只读、只圈定在 tools 根目录内，路径逃逸一律 403。
 * host 固定为字母 t（纯数字 host 会被 URL 规范化成 IPv4 地址），工具 id 放在路径首段。
 */
export function registerToolFileProtocol(): void {
  protocol.handle(TOOL_SCHEME, async (req) => {
    try {
      const u = new URL(req.url);
      if (u.hostname !== 't') return new Response('Forbidden', { status: 403 });
      if (u.pathname === '/' + TOOL_SDK_PATH) return new Response(TOOL_SDK, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' } });
      const parts = decodeURIComponent(u.pathname).replace(/^\/+/, '').split('/');
      const toolId = Number(parts[0]);
      const rel = parts.slice(1).join('/');
      if (!Number.isInteger(toolId) || toolId <= 0 || !rel) {
        return new Response('Bad Request', { status: 400 });
      }
      const base = resolve(toolsRoot(), String(toolId));
      const abs = resolve(base, rel);
      if (abs !== base && !abs.startsWith(base + sep)) {
        return new Response('Forbidden', { status: 403 });
      }
      const response = await net.fetch(pathToFileURL(abs).toString());
      if (/\.html?$/i.test(abs) && response.ok) return new Response(injectToolSdk(await response.text()), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      return response;
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
  });
}
