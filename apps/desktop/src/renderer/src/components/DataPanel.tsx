// 数据面板：本体（对象/链接/动作类型）管理 + 存储总览 + 对象浏览 + 维护（备份/导出/体检）
// 布局复用帮助面板的左侧目录结构。
import { useCallback, useEffect, useState } from 'react';
import { api, call } from '../api';
import { toast } from './Toast';
import { ActionTypeManager, LinkTypeManager, ObjectTypeManager } from './DataTypes';
import DataObjects from './DataObjects';
import { fmtBytes, type ActionTypeDef, type LinkTypeDef, type ObjectTypeDef } from './data-shared';

type View = 'overview' | 'objects' | 'otypes' | 'ltypes' | 'atypes' | 'care';

const VIEWS: Array<{ key: View; label: string; hint: string }> = [
  { key: 'overview', label: '总览', hint: '这个 App 的全部数据存储' },
  { key: 'objects', label: '对象', hint: '按类型浏览实例数据' },
  { key: 'otypes', label: '对象类型', hint: 'ObjectType 管理' },
  { key: 'ltypes', label: '链接类型', hint: 'LinkType 管理' },
  { key: 'atypes', label: '动作类型', hint: 'ActionType 管理' },
  { key: 'care', label: '维护', hint: '备份 / 导出 / 体检' },
];

interface Overview {
  db: { path: string; sizeBytes: number; userVersion: number };
  tables: Array<{ apiName: string; title: string; isSystem: boolean; count: number }>;
  meta: { objectTypes: number; linkTypes: number; actionTypes: number };
  toolsDir: { path: string; sizeBytes: number; toolCount: number };
}

export default function DataPanel() {
  const [view, setView] = useState<View>('overview');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [types, setTypes] = useState<ObjectTypeDef[]>([]);
  const [links, setLinks] = useState<LinkTypeDef[]>([]);
  const [actions, setActions] = useState<ActionTypeDef[]>([]);
  const [health, setHealth] = useState<string>('');

  const refreshMeta = useCallback(async () => {
    try {
      const res = await call<{ objects: ObjectTypeDef[]; links: LinkTypeDef[]; actions: ActionTypeDef[] }>(() => api.data.listTypes());
      setTypes(res.objects);
      setLinks(res.links);
      setActions(res.actions);
    } catch (e) {
      toast((e as Error).message);
    }
  }, []);

  const refreshOverview = useCallback(async () => {
    try {
      setOverview(await call<Overview>(() => api.data.getOverview()));
    } catch (e) {
      toast((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refreshMeta();
    void refreshOverview();
  }, [refreshMeta, refreshOverview]);

  const refreshAll = () => {
    void refreshMeta();
    void refreshOverview();
  };

  return (
    <section className="panel">
      <div className="help-layout data-layout">
        <nav className="help-toc data-toc">
          <div className="help-toc-title">数据</div>
          {VIEWS.map((v, i) => (
            <button key={v.key} className={`help-toc-item${view === v.key ? ' on' : ''}`} onClick={() => setView(v.key)}>
              <span className="help-toc-num">{String(i + 1).padStart(2, '0')}</span>
              <span className="help-toc-text">
                {v.label}
                <span className="help-toc-desc">{v.hint}</span>
              </span>
            </button>
          ))}
        </nav>
        <div className="data-view">
          {view === 'overview' && <OverviewView overview={overview} onOpenDir={(which) => void openDir(which)} />}
          {view === 'objects' && <DataObjects types={types} actions={actions} />}
          {view === 'otypes' && <ObjectTypeManager types={types} links={links} onChanged={refreshAll} />}
          {view === 'ltypes' && <LinkTypeManager types={types} links={links} onChanged={refreshAll} />}
          {view === 'atypes' && <ActionTypeManager actions={actions} types={types} links={links} onChanged={refreshAll} />}
          {view === 'care' && <CareView health={health} setHealth={setHealth} onChanged={refreshAll} />}
        </div>
      </div>
    </section>
  );

  async function openDir(which: 'db' | 'tools' | 'backups') {
    try {
      await call(() => api.data.openDataDir({ which }));
    } catch (e) {
      toast((e as Error).message);
    }
  }
}

function OverviewView({ overview, onOpenDir }: { overview: Overview | null; onOpenDir: (which: 'db' | 'tools' | 'backups') => void }) {
  if (!overview) return <p className="empty">加载中…</p>;
  return (
    <div>
      <div className="panel-head">
        <h2>存储总览</h2>
        <span className="sub">App 的全部持久化数据都在这里</span>
      </div>
      <div className="data-cards">
        <section className="data-card">
          <h3>SQLite 主库</h3>
          <div className="stat-row">
            <div className="stat">
              <div className="stat-num">{fmtBytes(overview.db.sizeBytes)}</div>
              <div className="stat-label">库大小（含 WAL）</div>
            </div>
            <div className="stat">
              <div className="stat-num">{overview.tables.reduce((s, t) => s + t.count, 0)}</div>
              <div className="stat-label">实例总数</div>
            </div>
            <div className="stat">
              <div className="stat-num">v{overview.db.userVersion}</div>
              <div className="stat-label">迁移版本</div>
            </div>
          </div>
          <p className="mono sub data-path">{overview.db.path}</p>
          <div className="btn-row">
            <button className="btn slim ghost" onClick={() => onOpenDir('db')}>
              打开数据目录
            </button>
            <button className="btn slim ghost" onClick={() => onOpenDir('backups')}>
              打开备份目录
            </button>
          </div>
        </section>
        <section className="data-card">
          <h3>本体</h3>
          <div className="stat-row">
            <div className="stat">
              <div className="stat-num">{overview.meta.objectTypes}</div>
              <div className="stat-label">对象类型</div>
            </div>
            <div className="stat">
              <div className="stat-num">{overview.meta.linkTypes}</div>
              <div className="stat-label">链接类型</div>
            </div>
            <div className="stat">
              <div className="stat-num">{overview.meta.actionTypes}</div>
              <div className="stat-label">动作类型</div>
            </div>
          </div>
          <table className="data-table inner">
            <tbody>
              {overview.tables.map((t) => (
                <tr key={t.apiName}>
                  <td>
                    {t.title} <span className="sub mono">{t.apiName}</span>
                  </td>
                  <td className="mono">{t.count} 行</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="data-card">
          <h3>工具箱文件</h3>
          <div className="stat-row">
            <div className="stat">
              <div className="stat-num">{overview.toolsDir.toolCount}</div>
              <div className="stat-label">工具数</div>
            </div>
            <div className="stat">
              <div className="stat-num">{fmtBytes(overview.toolsDir.sizeBytes)}</div>
              <div className="stat-label">磁盘占用</div>
            </div>
          </div>
          <p className="mono sub data-path">{overview.toolsDir.path}</p>
          <div className="btn-row">
            <button className="btn slim ghost" onClick={() => onOpenDir('tools')}>
              打开工具目录
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function CareView({ health, setHealth, onChanged }: { health: string; setHealth: (s: string) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState('');

  const run = async (name: string, fn: () => Promise<string>) => {
    setBusy(name);
    try {
      const msg = await fn();
      toast(msg);
      setHealth(msg);
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div>
      <div className="panel-head">
        <h2>维护</h2>
        <span className="sub">备份使用 SQLite 在线备份（VACUUM INTO），不影响其他进程读写</span>
      </div>
      <div className="data-cards">
        <section className="data-card">
          <h3>备份与导出</h3>
          <div className="btn-row">
            <button className="btn primary" disabled={busy !== ''} onClick={() => void run('backup', () => call(() => api.data.backup()))}>
              {busy === 'backup' ? '备份中…' : '备份数据库'}
            </button>
            <button className="btn" disabled={busy !== ''} onClick={() => void run('export', () => call(() => api.data.exportJson()))}>
              {busy === 'export' ? '导出中…' : '导出 JSON'}
            </button>
          </div>
          <p className="sub">产物在 userData/Backups/ 下，JSON 含类型元数据与全部实例数据。</p>
        </section>
        <section className="data-card">
          <h3>体检与压缩</h3>
          <div className="btn-row">
            <button className="btn" disabled={busy !== ''} onClick={() => void run('health', async () => {
              const res = await call<{ integrityOk: boolean; integrityMessages: string[]; foreignKeyViolations: number }>(() => api.data.healthCheck());
              return `完整性：${res.integrityMessages.join('; ')}；外键违规：${res.foreignKeyViolations}`;
            })}>
              运行体检
            </button>
            <button className="btn ghost" disabled={busy !== ''} onClick={() => void run('vacuum', async () => {
              await call(() => api.data.vacuum());
              return 'VACUUM 完成';
            })}>
              压缩主库
            </button>
          </div>
          {health && <p className="mono data-result">{health}</p>}
        </section>
      </div>
    </div>
  );
}
