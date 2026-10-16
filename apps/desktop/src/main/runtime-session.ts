// 会话只绑定真实子 frame、当前文档、release 与实际授权；令牌不发送给工具页面。
import { ipcMain, type IpcMainInvokeEvent, type WebContents, type WebFrameMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { type TodoDeskCore, runtimeErrorInfo } from '../../../../packages/core/src';
import { digest } from '../../../../packages/core/src/services/event-model';
import { readSnapshot } from '../../../../packages/core/src/db';
import { createRuntimeDispatcher, type RuntimeSdkHooks } from '../../../../packages/core/src/services/runtime-sdk';
import { runtimeError } from '../../../../packages/core/src/utils/schedule';
import { HOST_ORIGIN } from './runtime-protocol';

interface Session { token: string; owner: WebContents; frame: WebFrameMain; generation: number; nonce: string; extensionId: string; identity: string; url: string }
export function registerRuntimeSessions(core: TodoDeskCore, options: { hostOrigin?: string; hooks?: RuntimeSdkHooks } = {}) {
  const hostOrigin = options.hostOrigin ?? HOST_ORIGIN;
  const sessions = new Map<string, Session>(), generations = new WeakMap<WebFrameMain, number>(), observed = new Set<number>();
  const assertHost = (event: IpcMainInvokeEvent) => {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame || !frame.url.startsWith(hostOrigin + '/')) return runtimeError('PERMISSION_DENIED', '仅允许受信宿主主页面');
    return frame;
  };
  const revoke = (contents: WebContents, frame?: WebFrameMain | null) => {
    for (const [token, session] of sessions) if (session.owner === contents && (!frame || frame === contents.mainFrame || session.frame === frame)) sessions.delete(token);
    if (frame) generations.set(frame, (generations.get(frame) ?? 0) + 1);
  };
  const watch = (contents: WebContents) => {
    if (observed.has(contents.id)) return;
    observed.add(contents.id);
    contents.on('did-start-navigation', details => { if (!details.isSameDocument) revoke(contents, details.isMainFrame ? null : details.frame); });
    contents.once('destroyed', () => { revoke(contents); observed.delete(contents.id); });
    contents.on('render-process-gone', () => revoke(contents));
  };
  const identity = (extensionId: string) => readSnapshot(core.db, () => {
    const extension = core.extensions.get({ extensionId });
    if (!extension || extension.status !== 'active') return runtimeError('SESSION_REVOKED', '工具已停用或卸载');
    const grants = core.db.prepare('SELECT capability,scope,grant_revision,authorization_digest FROM extension_grants WHERE extension_id=? ORDER BY capability,scope').all(extensionId);
    return { extension, fingerprint: digest({ digest: extension.digest, revision: extension.revision, grants }) };
  });
  const nonceOf = async (frame: WebFrameMain) => {
    let timer: ReturnType<typeof setTimeout>|undefined;
    try { return await Promise.race([frame.executeJavaScript('window.__DAYFOLIO_DOCUMENT_NONCE__'),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('工具文档响应超时'),{code:'REQUEST_TIMEOUT'})),5000);})]); }
    finally { if(timer)clearTimeout(timer); }
  };
  const currentFrame = (session: Session) => {
    if (session.owner.isDestroyed() || session.frame.isDestroyed() || session.frame.detached || session.frame.parent !== session.owner.mainFrame || session.frame.url.split('#')[0] !== session.url || (generations.get(session.frame) ?? 0) !== session.generation) return runtimeError('SESSION_REVOKED', '工具文档会话已失效');
    if (identity(session.extensionId).fingerprint !== session.identity) return runtimeError('SESSION_REVOKED', '工具版本或授权已变化');
  };
  const handle = (channel: string, fn: (event: IpcMainInvokeEvent, input: unknown) => unknown) => ipcMain.handle(channel, async (event, input) => {
    try { assertHost(event); return { ok: true, data: await fn(event, input) }; }
    catch (error) { const info = runtimeErrorInfo(error); return { ok: false, error: info.message, code: info.code, retryable: info.retryable }; }
  });
  handle('extensions:bindSession', async (event, raw) => {
    const input = raw as { extensionId?: unknown; nonce?: unknown };
    if (!input || typeof input.extensionId !== 'string' || typeof input.nonce !== 'string' || !/^[0-9a-f-]{36}$/.test(input.nonce) || Object.keys(input).some(name => !['extensionId', 'nonce'].includes(name))) return runtimeError('CONTRACT_INVALID', '会话握手参数错误');
    const { extension, fingerprint } = identity(input.extensionId);
    watch(event.sender);
    const url = extension.origin + '/' + extension.digest + '/' + extension.entry;
    const candidates = event.sender.mainFrame.frames.filter(frame => frame.url.split('#')[0] === url && !frame.isDestroyed() && !frame.detached);
    let selected: Session | undefined;
    for (const frame of candidates) {
      const generation = generations.get(frame) ?? 0;
      const nonce = await nonceOf(frame);
      if (nonce !== input.nonce) continue;
      const session = { token: randomUUID(), owner: event.sender, frame, generation, nonce: input.nonce, extensionId: extension.id, identity: fingerprint, url };
      currentFrame(session);
      if (selected) return runtimeError('PERMISSION_DENIED', '工具文档身份不唯一');
      selected = session;
    }
    if (!selected) return runtimeError('SESSION_REVOKED', '实际工具文档与握手不一致');
    for (const [token, prior] of sessions) if (prior.owner === selected.owner && prior.frame === selected.frame) sessions.delete(token);
    sessions.set(selected.token, selected);
    return { sessionToken: selected.token, releaseDigest: extension.digest };
  });
  handle('extensions:releaseSession', (event, raw) => {
    const token = (raw as { sessionToken?: string })?.sessionToken, session = token ? sessions.get(token) : null;
    if (session?.owner === event.sender) sessions.delete(session.token);
    return true;
  });
  handle('extensions:sdkRequest', async (event, raw) => {
    const input = raw as { sessionToken?: string; request?: unknown }, session = sessions.get(input?.sessionToken ?? '');
    if (!session || session.owner !== event.sender) return runtimeError('SESSION_REVOKED', '工具会话已撤销');
    try {
      currentFrame(session);
      if (await nonceOf(session.frame) !== session.nonce) return runtimeError('SESSION_REVOKED', '工具文档已替换');
      currentFrame(session);
      const dispatcher = createRuntimeDispatcher(core, session.extensionId, {
        ...options.hooks,
        openTodo: target => { event.sender.send('extensions:openTodo', target); options.hooks?.openTodo?.(target); },
      });
      return dispatcher(input.request);
    } catch (error) { if (runtimeErrorInfo(error).code === 'SESSION_REVOKED') sessions.delete(session.token); throw error; }
  });
  return { revoke, size: () => sessions.size };
}
