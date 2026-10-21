import Modal from './components/Modal';
import SettingsPanel from './components/SettingsPanel';
// 应用外壳：极简侧导航（Codex 风格：暖白底、hairline 分隔、衬线标题、线性图标）
import { useEffect, useMemo, useState } from 'react';
import DataPanel from './components/DataPanel';
import HelpPanel from './components/HelpPanel';
import { IconBook, IconCalendar, IconCheck, IconDatabase, IconHelp, IconList, IconMegaphone, IconNews, IconPlug, IconToolbox, IconVault, IconSettings } from './components/icons';
import McpPanel from './components/McpPanel';
import MediaPanel from './components/MediaPanel';
import NewsPanel from './components/NewsPanel';
import KnowledgePanel from './components/KnowledgePanel';
import PlanPanel from './components/PlanPanel';
import TodayPanel from './components/TodayPanel';
import TodoPanel from './components/TodoPanel';
import ToolsPanel from './components/ToolsPanel';
import { ToastHost } from './components/Toast';
import RuntimeToolFrame from './components/RuntimeToolFrame';
import RuntimeTodoDetails from './components/RuntimeTodoDetails';
import { api } from './api';

type Tab = 'today' | 'todos' | 'plans' | 'news' | 'knowledge' | 'media' | 'tools' | 'data' | 'mcp' | 'help' | 'settings';

/** 发版记录弹层：解析构建时注入的 CHANGELOG（## 版本 / ### 分类 / - 条目） */
function ChangelogModal({ onClose }: { onClose: () => void }) {
  const versions = useMemo(() => {
    const sections: { title: string; groups: { name: string; items: string[] }[] }[] = [];
    let cur: (typeof sections)[number] | null = null;
    let grp: { name: string; items: string[] } | null = null;
    for (const raw of __CHANGELOG__.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('## ')) {
        cur = { title: line.slice(3).trim(), groups: [] };
        sections.push(cur);
        grp = null;
      } else if (cur && line.startsWith('### ')) {
        grp = { name: line.slice(4).trim(), items: [] };
        cur.groups.push(grp);
      } else if (grp && line.startsWith('- ')) {
        grp.items.push(line.slice(2).trim());
      }
    }
    return sections;
  }, []);
  return (
    <Modal title="发版记录" onClose={onClose} wide className="changelog-modal">
      {versions.map((v, i) => (
        <section key={v.title} className="changelog-version">
          <div className="changelog-version-head">
            <h4>{v.title}</h4>
            {i === 0 && <span className="changelog-current">当前</span>}
          </div>
          {v.groups.map((g) => (
            <div key={g.name} className="changelog-group">
              <div className="changelog-group-name">{g.name}</div>
              <ul>
                {g.items.map((it) => (
                  <li key={it}>{it}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </Modal>
  );
}

// 数据/MCP 是次级入口，固定在侧栏底部，与主导航脱开；
// 帮助压在最底一行，右侧携带版本号（点击打开发版记录，不切换面板）。
// 学习入口只有「学习计划」一个：课程总览与逐日讲义在计划面板内部导航（原「课程」页已并入）
const TABS: Array<{ key: Tab; label: string; Icon: typeof IconList }> = [
  { key: 'today', label: '今日', Icon: IconCalendar },
  { key: 'todos', label: '待办', Icon: IconList },
  { key: 'news', label: '新闻', Icon: IconNews },
  { key: 'plans', label: '学习', Icon: IconBook },
  { key: 'knowledge', label: '知识库', Icon: IconVault },
  { key: 'media', label: '自媒体', Icon: IconMegaphone },
  { key: 'tools', label: '工具箱', Icon: IconToolbox },
];

const BOTTOM_TABS: Array<{ key: Tab; label: string; Icon: typeof IconList }> = [
  { key: 'settings', label: '设置', Icon: IconSettings },
  { key: 'mcp', label: 'MCP', Icon: IconPlug },
  { key: 'data', label: '数据', Icon: IconDatabase },
  { key: 'help', label: '帮助', Icon: IconHelp },
];

const TAB_LABEL = (tab: Tab) =>
  tab === 'settings' ? '设置' : tab === 'help' ? '帮助' : tab === 'mcp' ? 'MCP' : TABS.find((t) => t.key === tab)?.label ?? '';

export default function App() {
  const [tab, setTab] = useState<Tab>('today');
  const [settingsDirty, setSettingsDirty] = useState(false);
  const navigate = (next: Tab) => { if (tab === 'settings' && next !== tab && settingsDirty && !window.confirm('Agent 配置尚未保存，放弃修改？')) return; setRuntimeId(null); setTab(next); };
  const [showChangelog, setShowChangelog] = useState(false);
  const [runtimeId, setRuntimeId] = useState<string|null>(null), [runtimeTodo, setRuntimeTodo] = useState<number|null>(null);
  useEffect(()=>{
    const open=(event:Event)=>{const id=(event as CustomEvent<{extensionId?:unknown}>).detail?.extensionId;if(typeof id==='string'){setRuntimeId(id);setTab('tools');}};
    const settings = () => setTab('settings');
    window.addEventListener('dayfolio:openSettings', settings);
    window.addEventListener('dayfolio:openTool',open);
    const openTodo=(event:Event)=>{const id=(event as CustomEvent<{id?:unknown}>).detail?.id;if(typeof id==='number'&&Number.isSafeInteger(id)&&id>0)setRuntimeTodo(id);};
    window.addEventListener('dayfolio:openTodo',openTodo);
    const remove=api.extensions.onOpenTodo(target=>{if(target.objectType==='todo'&&Number.isSafeInteger(target.id))setRuntimeTodo(target.id);});
    return()=>{window.removeEventListener('dayfolio:openSettings',settings);window.removeEventListener('dayfolio:openTool',open);window.removeEventListener('dayfolio:openTodo',openTodo);remove();};
  },[]);

  // 窗口标题跟随当前面板，便于 Mission Control 辨认
  useEffect(() => {
    document.title = `Dayfolio — ${TAB_LABEL(tab)}`;
  }, [tab]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <IconCheck width={13} height={13} strokeWidth={2.4} />
          </span>
          <span className="brand-name">Dayfolio</span>
        </div>
        <nav className="nav">
          {TABS.map(({ key, label, Icon }) => (
            <button
              key={key}
              className={`nav-item ${tab === key ? 'active' : ''}`}
              onClick={() => navigate(key)}
            >
              <Icon />
              {label}
            </button>
          ))}
        </nav>
        {/* 次级入口固定在侧边栏最底：MCP / 数据 / 帮助（携带版本号），与主导航脱开 */}
        <div className="nav-extra">
          {BOTTOM_TABS.map(({ key, label, Icon }) => (
            <button
              key={key}
              className={`nav-item ${tab === key ? 'active' : ''}`}
              onClick={() => navigate(key)}
            >
              <Icon />
              {label}
              {key === 'help' && (
                <span
                  className="nav-item-version mono"
                  title="查看发版记录"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowChangelog(true);
                  }}
                >
                  v{__APP_VERSION__}
                </span>
              )}
            </button>
          ))}
        </div>
      </aside>
      <main key={tab} className="content">
        {tab === 'today' && <TodayPanel />}
        {tab === 'todos' && <TodoPanel />}
        {tab === 'plans' && <PlanPanel />}
        {tab === 'news' && <NewsPanel />}
        {tab === 'knowledge' && <KnowledgePanel />}
        {tab === 'media' && <MediaPanel />}
        {tab === 'tools' && (runtimeId?<RuntimeToolFrame extensionId={runtimeId} onClose={()=>setRuntimeId(null)}/>:<ToolsPanel />)}
        {tab === 'data' && <DataPanel />}
        {tab === 'mcp' && <McpPanel />}
        {tab === 'help' && <HelpPanel />}
        {tab === 'settings' && <SettingsPanel onDirtyChange={setSettingsDirty} />}
      </main>
      {showChangelog && <ChangelogModal onClose={() => setShowChangelog(false)} />}
      {runtimeTodo!==null && <RuntimeTodoDetails id={runtimeTodo} onClose={()=>setRuntimeTodo(null)}/>}
      <ToastHost />
    </div>
  );
}
