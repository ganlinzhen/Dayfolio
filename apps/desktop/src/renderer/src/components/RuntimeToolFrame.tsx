import ActionButton from './ActionButton';
import { IconChevronLeft } from './icons';
// 每个真实 iframe 独享 MessagePort；会话令牌只在受信父页面闭包中保存。
import { useEffect, useRef, useState } from 'react';
import { api, call } from '../api';
import type { TodoDeskCore } from '../../../../../../packages/core/src';
import EmbeddedFrame from './EmbeddedFrame';
import { useRuntimeRefresh } from './useRuntimeRefresh';

type Extension = NonNullable<ReturnType<TodoDeskCore['extensions']['get']>>;
export default function RuntimeToolFrame({ extensionId, onClose }: { extensionId: string; onClose: () => void }) {
  const [extension, setExtension] = useState<Extension | null>(null), [error, setError] = useState('');
  const iframe = useRef<HTMLIFrameElement>(null), port = useRef<MessagePort | null>(null);
  const refresh = async () => {
    try {
      const next = await call<Extension|null>(() => api.extensions.get({ extensionId }));
      if (!next || next.status !== 'active') { setExtension(null); setError('此历史入口已移除，请返回工具箱打开 HTML 工具。'); return; }
      setExtension(previous => previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      const revision = await call(() => api.runtime.revision());
      port.current?.postMessage({ type: 'dayfolio:changed', event: { revision, providerIds: next.grantedCapabilities.map(cap => cap.providerId).filter((id, i, all) => all.indexOf(id) === i), reason: 'runtime_revision' } });
    } catch (error) { setError((error as Error).message); }
  };
  useRuntimeRefresh(refresh);
  const identity = extension ? extension.digest + ':' + extension.revision + ':' + extension.authorizationRevision : '';
  useEffect(() => {
    if (!extension) return;
    let stopped = false, binding = false, sessionToken = '', boundNonce = '', activePort: MessagePort | null = null, inFlight = 0;
    const hostExtension = extension;
    const release = () => {
      activePort?.close(); activePort = null; port.current = null;
      if (sessionToken) { void api.extensions.releaseSession({ sessionToken }); sessionToken = ''; }
      boundNonce = '';
    };
    const hello = async (event: MessageEvent) => {
      if (stopped || binding || event.source !== iframe.current?.contentWindow || event.origin !== hostExtension.origin || event.data?.type !== 'dayfolio:hello' || event.data?.apiMajor !== 1 || typeof event.data.nonce !== 'string') return;
      if (sessionToken && boundNonce === event.data.nonce) return;
      release();
      binding = true;
      try {
        const bound = await call<{sessionToken:string;releaseDigest:string}>(() => api.extensions.bindSession({ extensionId: hostExtension.id, nonce: event.data.nonce }));
        if (stopped) { void api.extensions.releaseSession({ sessionToken: bound.sessionToken }); return; }
        sessionToken = bound.sessionToken;
        boundNonce = event.data.nonce;
        const channel = new MessageChannel(); activePort = channel.port1; port.current = activePort;
        activePort.onmessage = async message => {
          const request = message.data, requestId = typeof request?.requestId === 'string' ? request.requestId : '';
          if (stopped || !activePort) return;
          const responsePort = activePort, token = sessionToken;
          if (inFlight >= 32) { activePort.postMessage({ ok: false, requestId, error: { code: 'REQUEST_LIMIT', message: '请求过多，请稍后重试', retryable: true } }); return; }
          inFlight++;
          try {
            const result = await api.extensions.sdkRequest({ sessionToken:token, request });
            if (stopped || activePort !== responsePort) return;
            responsePort.postMessage(result.ok ? { ok: true, requestId, data: result.data } : { ok: false, requestId, error: { code: result.code ?? 'CONTRACT_INVALID', message: result.error ?? '请求失败', retryable: result.retryable ?? false } });
            if (result.ok && /^(events\.import|subscriptions\.(subscribe|unsubscribe|resumeFollowing))$/.test(String(request?.method))) window.dispatchEvent(new Event('dayfolio:changed'));
          } catch (error) {
            if (!stopped && activePort === responsePort) responsePort.postMessage({ok:false,requestId,error:{code:'REQUEST_TIMEOUT',message:(error as Error).message,retryable:true}});
          } finally { inFlight--; }
        };
        activePort.start();
        iframe.current?.contentWindow?.postMessage({ type: 'dayfolio:port', nonce: event.data.nonce }, hostExtension.origin, [channel.port2]);
        setError('');
      } catch (error) { if (!stopped) setError((error as Error).message); }
      finally { binding = false; }
    };
    window.addEventListener('message', hello);
    return () => { stopped = true; release(); window.removeEventListener('message', hello); };
  }, [extensionId, identity]);
  return <div className="tool-frame"><EmbeddedFrame label="运行时工具" title={extension?.title ?? '运行时工具'} meta="HTML 页面" className="tool-embed" allowFullscreen={false} leading={<ActionButton icon={IconChevronLeft} className="tool-crumb-back" onClick={onClose}>返回</ActionButton>}>
    {error && <div className="notice error" role="alert">{error}</div>}
    {extension && <iframe ref={iframe} key={identity} className="tool-iframe" title={extension.title} sandbox="allow-scripts allow-same-origin" src={extension.origin + '/' + extension.digest + '/' + extension.entry} />}
  </EmbeddedFrame></div>;
}
