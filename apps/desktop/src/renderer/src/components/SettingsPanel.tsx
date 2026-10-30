import ActionButton from './ActionButton';
import { IconCheck, IconCopy, IconFolder, IconRefresh, IconSave, IconUndo } from './icons';
import { useEffect, useState } from 'react';
import type { AgentProvider, AgentSettings } from '../../../../../../packages/core/src';
import type { AgentStatus } from '../../../main/agent-adapters';
import { api, call } from '../api';
import { toast } from './Toast';
import { IconChevronDown, IconChevronRight } from './icons';
import { agentConnectionPrompt } from './agentConnectionPrompt';

const providers: Array<{ id: AgentProvider; label: string; install: string; login: string }> = [
  { id: 'codex', label: 'Codex', install: 'npm install -g @openai/codex@latest', login: 'codex login' },
  { id: 'claude', label: 'Claude Code', install: 'npm install -g @anthropic-ai/claude-code@latest', login: 'claude auth login' },
  { id: 'gemini', label: 'Gemini CLI', install: 'npm install -g @google/gemini-cli@latest', login: 'gemini' },
];
export default function SettingsPanel({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const [saved, setSaved] = useState<AgentSettings | null>(null);
  const [provider, setProvider] = useState<AgentProvider | null>(null);
  const [expanded, setExpanded] = useState<AgentProvider | null>(null);
  const [binary, setBinary] = useState(''), [model, setModel] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const dirty = !!saved && (saved.provider !== provider || !!provider && (saved.profiles[provider].binary !== binary || saved.profiles[provider].model !== model));
  const reset = (value: AgentSettings) => {
    setSaved(value); setProvider(value.provider); setExpanded(null); setBinary(value.provider ? value.profiles[value.provider].binary : ''); setModel(value.provider ? value.profiles[value.provider].model : ''); setStatus(null);
  };
  const load = async () => { setBusy(true); setError(''); try { reset(await call<AgentSettings>(() => api.agentSettings.get())); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  useEffect(() => { void load(); }, []);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const choose = (id: AgentProvider | null) => {
    setProvider(id); setExpanded(id); setBinary(id ? saved?.profiles[id].binary ?? '' : ''); setModel(id ? saved?.profiles[id].model ?? '' : ''); setStatus(null); setError('');
  };
  const check = async () => {
    if (!provider) return;
    setBusy(true); setError('');
    try { setStatus(await call<AgentStatus>(() => api.agentSettings.check({ provider, binary, model }))); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!saved) return;
    setBusy(true); setError('');
    try { reset(await call<AgentSettings>(() => api.agentSettings.update({ provider, binary, model, expected_revision: saved.revision }))); toast('Agent 配置已保存'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const current = providers.find(p => p.id === provider);
  const copy = async (text: string, message = '命令已复制，请在终端执行') => { try { await call(() => api.study.copyPrompt({ text })); toast(message); } catch (e) { setError((e as Error).message); } };
  return <div className="panel settings-panel">
    <header className="panel-head"><h1>设置</h1></header>
    <nav className="settings-menu" aria-label="设置菜单"><button className="active" aria-current="page">配置 Agent</button></nav>
    <section className="agent-settings" aria-labelledby="agent-settings-title">
      <header className="settings-section-head"><h2 id="agent-settings-title">后台 Agent</h2><p>使用本机已安装并登录的 Agent 更新新闻。</p></header>
      {error && <div className="notice error" role="alert">{error}<ActionButton icon={IconRefresh} className="btn slim ghost" disabled={busy} onClick={() => void load()}>重新加载</ActionButton></div>}
      {!saved ? <p>{error ? '配置读取失败，请重新加载。' : '正在读取配置…'}</p> : <>
        <fieldset className="agent-provider-list" disabled={busy}><legend className="settings-sr-only">选择后台 Agent</legend>
          {providers.map(p => <div className="agent-provider-item" key={p.id}>
            <div className="agent-provider-head">
              <input type="radio" name="agent-provider" value={p.id} aria-label={`使用 ${p.label}`} checked={provider === p.id} onClick={() => { if (provider === p.id) setExpanded(p.id); }} onChange={() => choose(p.id)} />
              <button type="button" id={`agent-heading-${p.id}`} className="agent-provider-toggle" aria-label={`${p.label} 配置`} aria-expanded={expanded === p.id} aria-controls={`agent-profile-${p.id}`} onClick={() => { if (provider !== p.id) choose(p.id); else setExpanded(expanded === p.id ? null : p.id); }}>
                <span className="agent-provider-copy"><span className="agent-provider-name">{p.label}</span><span className="agent-provider-description">{p.id === 'codex' ? 'OpenAI 的本机 Agent' : p.id === 'claude' ? 'Anthropic 的本机 Agent' : 'Google 的本机 Agent'}</span></span><span className="agent-provider-kind">{provider === p.id ? '已选择' : '本机 CLI'}</span>{expanded === p.id ? <IconChevronDown /> : <IconChevronRight />}
              </button>
            </div>
            <div id={`agent-profile-${p.id}`} role="region" aria-labelledby={`agent-heading-${p.id}`} hidden={expanded !== p.id}>
              {expanded === p.id && current?.id === p.id && <div className="agent-provider-fields">
                <div className="agent-setting-row">
                  <div className="agent-setting-label"><label htmlFor="agent-binary">可执行文件</label><p>留空自动查找安装位置</p></div>
                  <div className="agent-path-row"><input id="agent-binary" className="form-input mono" placeholder={`自动查找 ${p.id}`} value={binary} disabled={busy} onChange={e => { setBinary(e.target.value); setStatus(null); }} /><ActionButton icon={IconFolder} className="btn slim" disabled={busy} onClick={() => { void call<string | null>(() => api.agentSettings.pickBinary()).then(path => { if (path) { setBinary(path); setStatus(null); } }).catch(e => setError(e.message)); }}>选择文件</ActionButton></div>
                </div>
                <div className="agent-setting-row">
                  <div className="agent-setting-label"><label htmlFor="agent-model">模型</label><p>可选，使用 CLI 默认模型</p></div>
                  <input id="agent-model" className="form-input" value={model} disabled={busy} maxLength={200} onChange={e => { setModel(e.target.value); setStatus(null); }} placeholder="默认模型" />
                </div>
                <div className="agent-setting-row">
                  <div className="agent-setting-label"><span>安装与登录</span><p>在终端完成首次配置</p></div>
                  <div className="agent-row-actions"><ActionButton icon={IconCopy} className="btn slim" onClick={() => void copy(p.install)}>复制安装命令</ActionButton><ActionButton icon={IconCopy} className="btn slim" onClick={() => void copy(binary ? `${"'"}${binary.replaceAll("'", "'\\''")}${"'"}${p.id === 'codex' ? ' login' : p.id === 'claude' ? ' auth login' : ''}` : p.login)}>复制登录命令</ActionButton></div>
                </div>
                <div className="agent-setting-row">
                  <div className="agent-setting-label"><span>连接与接入</span><p>检查 CLI，或交给 Agent 完成</p></div>
                  <div className="agent-row-actions">
                    <ActionButton icon={IconCheck} className="btn slim" disabled={busy} onClick={() => void check()}>{busy ? '处理中…' : '检查连接'}</ActionButton>
                    <ActionButton icon={IconCopy} className="btn slim" disabled={busy} onClick={() => void copy(agentConnectionPrompt({ provider: p.id, label: p.label, binary, model }), '接入提示词已复制，请粘贴到 Agent 对话中')}>复制给ai</ActionButton>
                  </div>
                </div>
                {status && <div className={`agent-connection-result agent-setting-row ${status.available ? 'ready' : ''}`} role="status"><strong>{status.available ? '连接检查通过' : '连接尚不可用'}</strong><div><p>{status.message}</p>{status.binary && <p className="mono">{status.binary}</p>}{status.version && <p className="mono">{status.version}</p>}</div></div>}
                <p className="settings-note agent-version-note">{p.id === 'codex' ? '需要 Codex 0.163.0 或更新版本。' : `请使用支持无界面执行的新版 ${p.label}。`}检查连接不消耗推理额度，模型与搜索权限在采集时验证。</p>
              </div>}
            </div>
          </div>)}
          <label className="agent-provider-none"><input type="radio" name="agent-provider" value="none" checked={!provider} onChange={() => choose(null)} /><span className="agent-provider-copy"><span className="agent-provider-name">暂不启用</span><span className="agent-provider-description">仍可在 Agent 对话中更新新闻</span></span></label>
        </fieldset>
        <footer className="agent-settings-actions"><span className="settings-save-status" role="status">{dirty ? '有未保存的修改' : saved.provider ? '配置已保存' : '尚未启用后台 Agent'}</span><span className="spacer" />{dirty && <ActionButton icon={IconUndo} className="btn ghost" disabled={busy} onClick={() => reset(saved)}>撤销修改</ActionButton>}<ActionButton icon={IconSave} className="btn primary" disabled={busy || !dirty} onClick={() => void save()}>保存配置</ActionButton></footer>
        <p className="settings-note">配置对下次任务生效。登录凭证由 CLI 管理，Dayfolio 不保存密钥。</p>
      </>}
    </section>
  </div>;
}
