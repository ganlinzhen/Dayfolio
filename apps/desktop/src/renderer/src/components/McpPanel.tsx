// MCP 和技能目录由实际工具注册及能力包清单生成。
import { useEffect, useMemo, useState } from 'react';
import { MCP_SECTIONS as SECTIONS, AGENT_SKILLS } from '../generated/agentCatalog';
import { api, call } from '../api';
import type { AgentKitStatus } from '../../../../../../packages/agent-kit/types';

type McpGroup = (typeof SECTIONS)[number]['groups'][number];

const GROUPS: McpGroup[] = SECTIONS.flatMap((s) => s.groups);

const TOTAL = GROUPS.reduce((n, g) => n + g.tools.length, 0);

export default function McpPanel() {
  const [q, setQ] = useState('');
  const [kit, setKit] = useState<AgentKitStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const refresh = async () => {
    setError('');
    try { setKit(await call<AgentKitStatus>(() => api.agent.status())); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { let active = true; void call<AgentKitStatus>(() => api.agent.status()).then(value => { if (active) setKit(value); }).catch(e => { if (active) setError(String(e)); }); return () => { active = false; }; }, []);
  const exportKit = async () => {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await call<{ version: string; target: string } | null>(() => api.agent.export());
      if (result) { setMessage(`已导出 ${result.version} 到 ${result.target}。请按客户端方式加载；已有手工 MCP 配置继续有效。`); await refresh(); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const keyword = q.trim().toLowerCase();
  const skills = AGENT_SKILLS.filter(s => !keyword || `${s.id} ${s.title} ${s.description}`.toLowerCase().includes(keyword));

  // 关键词过滤：组标题/本体名/工具名/说明命中任一即保留该工具，无命中的分区整块隐藏
  const sections = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return SECTIONS;
    return SECTIONS.map((s) => ({
      ...s,
      groups: s.groups
        .map((g) => ({
          ...g,
          tools: g.tools.filter(
            (t) =>
              t.name.toLowerCase().includes(kw) ||
              t.desc.toLowerCase().includes(kw) ||
              g.title.toLowerCase().includes(kw) ||
              g.entity.toLowerCase().includes(kw),
          ),
        }))
        .filter((g) => g.tools.length > 0),
    })).filter((s) => s.groups.length > 0);
  }, [q]);

  const shown = sections.reduce((n, s) => n + s.groups.reduce((m, g) => m + g.tools.length, 0), 0);

  return (
    <div className="panel" role="region" aria-label="MCP">
      <header className="panel-head">
        <div className="searchbox mcp-search">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="筛选工具或技能…"
            aria-label="筛选 MCP 工具"
          />
        </div>
        <div className="head-meta mono">
          {GROUPS.length} 组 · {TOTAL} 个工具{q ? ` · 命中 ${shown}` : ''}
        </div>
      </header>
      <p className="sub mcp-intro">
        Dayfolio 内置 MCP Server，把这些能力暴露给 zcode 等 AI 客户端——与 App 读写同一个数据库，改动实时同步。
        通用、教学和赛事技能共用同一个服务入口。接入方式见「帮助 → MCP 与 AI 接入」。
      </p>
      <div className="mcp-section">
        <div className="mcp-section-label"><span>AI 能力包</span><span className="mcp-section-hint">随包 {kit?.bundledVersion ?? '待检查'} · 已导出 {kit?.exportedVersion ?? '暂无'}</span></div>
        <div className="toolbar">
          <button className="btn" disabled={busy} onClick={() => void exportKit()}>{busy ? '正在导出…' : '导出 / 更新能力包'}</button>
          <button className="btn" disabled={busy} onClick={() => void refresh()}>检查接入包</button>
        </div>
        {kit?.exportedPath && <p className="sub">导出位置：{kit.exportedPath}</p>}
        {kit && <p className="sub">PATH 中的 Node：{kit.clientNode ?? '未找到'}。这里检查文件和运行环境；客户端是否已加载需在客户端核对。</p>}
        {kit?.issues.map(issue => <p className="sub" key={issue}>{issue}</p>)}
        {message && <p role="status">{message}</p>}
        {error && <p role="alert">{error}</p>}
        <div className="mcp-grid">
          {skills.map(skill => <section key={skill.id} className="mcp-group">
            <header className="mcp-group-head"><span className="mcp-group-title serif">{skill.title}</span></header>
            <p className="mono">{skill.id}</p><p className="mcp-group-desc">{skill.description}</p>
          </section>)}
        </div>
      </div>
      {sections.map((s) => (
        <div key={s.title} className="mcp-section">
          <div className="mcp-section-label">
            <span>{s.title}</span>
            <span className="mcp-section-hint">{s.hint}</span>
          </div>
          <div className="mcp-grid">
            {s.groups.map((g) => (
              <section key={g.title} className="mcp-group">
                <header className="mcp-group-head">
                  <span className="mcp-group-title serif">{g.title}</span>
                  <span className="mono mcp-group-entity">{g.entity}</span>
                  <span className="group-count">{g.tools.length}</span>
                </header>
                <p className="mcp-group-desc">{g.desc}</p>
                <ul className="mcp-tools">
                  {g.tools.map((t) => (
                    <li key={t.name} className="mcp-tool">
                      <code className="mcp-tool-name">{t.name}</code>
                      <span className="mcp-tool-desc">{t.desc}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      ))}
      {sections.length === 0 && skills.length === 0 && (
        <div className="empty">
          <div className="empty-title">没有匹配「{q.trim()}」的工具</div>
          <div className="empty-hint">试试工具名（如 checkin）或关键词（如 打卡）</div>
        </div>
      )}
    </div>
  );
}
