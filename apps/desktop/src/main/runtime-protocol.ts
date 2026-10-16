// 宿主与各工具使用独立来源；协议只提供清单内资源，并强制工具 CSP。
import { protocol } from 'electron';
import { readFileSync, realpathSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { TodoDeskCore } from '../../../../packages/core/src';
import { RUNTIME_SDK_TEMPLATE } from './runtime-sdk-source';
import { STORAGE_BRIDGE_PATH, STORAGE_BRIDGE_HTML } from './storage-preferences';

export const HOST_SCHEME = 'dayfolio-app';
export const RUNTIME_SCHEME = 'dayfolio-tool';
export const HOST_ORIGIN = HOST_SCHEME + '://app';
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
export function registerRuntimeProtocols(core: TodoDeskCore, rendererRoot: string, hostOrigin = HOST_ORIGIN) {
  const root = realpathSync(rendererRoot);
  protocol.handle(HOST_SCHEME, request => {
    try {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.host !== 'app') return new Response(null, { status: 403 });
      if (url.pathname === STORAGE_BRIDGE_PATH) return new Response(STORAGE_BRIDGE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'" } });
      const path = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
      if (path !== 'index.html' && !path.startsWith('assets/')) return new Response(null, { status: 404 });
      const file = realpathSync(join(root, path));
      if (relative(root, file).split(sep).includes('..')) return new Response(null, { status: 403 });
      return new Response(new Uint8Array(readFileSync(file)), { headers: { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } });
    } catch { return new Response(null, { status: 404 }); }
  });
  protocol.handle(RUNTIME_SCHEME, request => {
    try {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.search || url.username || url.password) return new Response(null, { status: 403 });
      const extension = core.extensions.list().find(item => item.origin === RUNTIME_SCHEME + '://' + url.host);
      if (!extension || extension.status !== 'active') return new Response(null, { status: 404 });
      const parts = decodeURIComponent(url.pathname).slice(1).split('/');
      const sdk = parts.join('/') === '__dayfolio_sdk__/v1.js';
      if (!sdk && parts.shift() !== extension.digest) return new Response(null, { status: 403 });
      const path = parts.join('/');
      const content = path === '__dayfolio_sdk__/v1.js'
        ? Buffer.from(RUNTIME_SDK_TEMPLATE.replace('__HOST_ORIGIN_JSON__', JSON.stringify(hostOrigin)))
        : core.extensions.readAsset({ extensionId: extension.id, releaseDigest: extension.digest, path });
      return new Response(new Uint8Array(content), { headers: {
        'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors " + hostOrigin,
      } });
    } catch { return new Response(null, { status: 404 }); }
  });
}
