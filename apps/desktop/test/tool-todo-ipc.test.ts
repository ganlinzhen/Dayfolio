import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkCore, type TestCtx } from '../../../packages/core/test/helpers';
import { injectToolSdk, TOOL_SDK_PATH } from '../src/main/tool-sdk';

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, input: unknown) => any>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (event: unknown, input: unknown) => any) => handlers.set(name, fn) } }));
import { registerToolTodoIpc } from '../src/main/tool-todo-ipc';

let ctx: TestCtx;
afterEach(() => { ctx?.cleanup(); handlers.clear(); });

describe('HTML 待办宿主边界', () => {
  it('只接受主页面代理当前真实直属 iframe，页面不能冒充其他工具或直接调用 IPC', () => {
    ctx = mkCore();
    const tool = ctx.core.tools.addTool({ title: '赛事', entry_file: 'index.html' });
    const other = ctx.core.tools.addTool({ title: '另一个', entry_file: 'index.html' });
    registerToolTodoIpc(ctx.core);
    const main = { frames: [{ url: `tool-file://t/${tool.id}/index.html` }] };
    const valid = { sender: { mainFrame: main }, senderFrame: main };
    const request = { toolId: tool.id, items: [{ sourceKey: 'a', title: 'A' }] };
    expect(handlers.get('toolTodos:preview')!(valid, request).ok).toBe(true);
    const snapshot={toolId:tool.id,snapshot:{schemaVersion:1,revision:1,groups:[{key:'g',title:'活动'}],items:[{sourceKey:'a',title:'A',groupKeys:['g']}]}};
    expect(handlers.get('toolFollowing:publish')!(valid,snapshot).ok).toBe(true);
    expect(handlers.get('toolFollowing:publish')!({...valid,senderFrame:main.frames[0]},snapshot).code).toBe('PERMISSION_DENIED');
    expect(handlers.get('toolFollowing:getState')!(valid,{toolId:other.id}).code).toBe('PERMISSION_DENIED');
    expect(ctx.core.todos.list()).toHaveLength(0);
    expect(handlers.get('toolTodos:create')!({ ...valid, senderFrame: main.frames[0] }, request).code).toBe('PERMISSION_DENIED');
    expect(handlers.get('toolTodos:create')!(valid, { ...request, toolId: other.id }).code).toBe('PERMISSION_DENIED');
    main.frames[0].url = 'https://example.com/';
    expect(handlers.get('toolTodos:create')!(valid, request).code).toBe('PERMISSION_DENIED');
    expect(ctx.core.todos.list()).toHaveLength(0);
  });

  it('SDK 在页面脚本前加载，保留既有 CSP；片段 HTML 也可接入', () => {
    const csp = '<meta http-equiv="Content-Security-Policy" content="script-src \'self\'">';
    const html = injectToolSdk(`<!doctype html><html><head>${csp}<script defer src="app.js"></script></head></html>`);
    expect(html).toContain(csp);
    expect(html.indexOf(csp)).toBeLessThan(html.indexOf(TOOL_SDK_PATH));
    expect(html.indexOf(TOOL_SDK_PATH)).toBeLessThan(html.indexOf('app.js'));
    expect(injectToolSdk('<h1>工具</h1>')).toContain(`<script src="/${TOOL_SDK_PATH}"></script><h1>`);
  });
});
