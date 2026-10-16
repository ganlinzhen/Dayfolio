// 数据首页依次展示总览、对象类型与维护；对象类型详情集中展示结构、关系、动作与实例。
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, call } from '../api';
import { toast } from './Toast';
import { ActionTypeManager, LinkTypeManager, ObjectTypeManager } from './DataTypes';
import DataObjects from './DataObjects';
import { actionsForType, fmtBytes, type ActionTypeDef, type LinkTypeDef, type ObjectTypeDef } from './data-shared';

type DetailTab = 'schema' | 'relations' | 'actions' | 'objects';
const DETAIL_TABS: Array<{ key: DetailTab; label: string }> = [
  { key: 'schema', label: '表结构' },
  { key: 'relations', label: '关系' },
  { key: 'actions', label: '动作' },
  { key: 'objects', label: '已有对象' },
];

interface Overview {
  db: { path: string; sizeBytes: number; userVersion: number };
  tables: Array<{ apiName: string; title: string; isSystem: boolean; count: number }>;
  meta: { objectTypes: number; linkTypes: number; actionTypes: number };
  toolsDir: { path: string; sizeBytes: number; toolCount: number };
}

export default function DataPanel() {
  const [selectedType, setSelectedType] = useState('');
  const [tab, setTab] = useState<DetailTab>('schema');
  const [objectId, setObjectId] = useState<string | number | undefined>();
  const homeRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const backRef = useRef<HTMLButtonElement>(null);
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

  const current = types.find((t) => t.apiName === selectedType);
  const relatedLinks = current ? links.filter((l) => l.leftType === current.apiName || l.rightType === current.apiName || l.linkTable === current.apiName) : [];
  const relatedActions = current ? actionsForType(current.apiName, actions, links) : [];
  const counts = Object.fromEntries(overview?.tables.map((t) => [t.apiName, t.count]) ?? []);

  const openType = (apiName: string, nextTab: DetailTab = 'schema', id?: string | number) => {
    if (!selectedType) openerRef.current = document.activeElement as HTMLElement;
    setSelectedType(apiName);
    setTab(nextTab);
    setObjectId(id);
    void refreshOverview();
  };
  const backHome = () => {
    setSelectedType('');
    setObjectId(undefined);
    requestAnimationFrame(() => openerRef.current?.focus());
  };
  useEffect(() => {
    if (selectedType && types.length && !current) { setSelectedType(''); setObjectId(undefined); }
  }, [selectedType, types, current]);
  useEffect(() => {
    if (selectedType) backRef.current?.focus();
  }, [selectedType]);

  return (
    <section className="panel">
      <div className="data-view">
        <header className="panel-head data-head">
          {current ? <>
            <button ref={backRef} className="btn slim ghost" onClick={backHome}>← 返回数据首页</button>
            <span className="panel-context">{current.title}</span>
            <span className="sub mono">{current.apiName}</span>
          </> : <span className="head-meta mono">{types.length} 种对象类型</span>}
          <div className="spacer" />
          <button className="btn slim ghost" onClick={refreshAll}>刷新数据</button>
        </header>
        <div className="data-home" ref={homeRef} hidden={!!current}>
          <section className="data-home-section" aria-labelledby="data-overview-title">
            <h2 id="data-overview-title">总览</h2>
            <OverviewView overview={overview} onOpenDir={(which) => void openDir(which)} />
          </section>
          <section className="data-home-section" aria-labelledby="data-types-title">
            <h2 id="data-types-title">对象类型 <span className="sub">{types.length} 种</span></h2>
            <ObjectTypeManager types={types.filter(t=>t.visibility!=='history')} links={links} counts={counts} onChanged={refreshAll} onOpenType={openType} />
            {types.some(t=>t.visibility==='history') && <div className="data-history"><h3>历史数据（只读）</h3><ObjectTypeManager types={types.filter(t=>t.visibility==='history')} links={links} counts={counts} onChanged={refreshAll} onOpenType={openType}/></div>}
          </section>
          <section className="data-home-section" aria-labelledby="data-care-title">
            <h2 id="data-care-title">维护</h2>
            <CareView health={health} setHealth={setHealth} onChanged={refreshAll} />
          </section>
        </div>
        {current && <div className="data-type-detail" key={current.apiName}>
          <p className="sub data-type-description">{current.description || '未填写类型说明'}</p>
          <dl className="data-type-meta">
            <div><dt>物理表</dt><dd className="mono">{current.tableName ?? '虚拟类型，无物理表'}</dd></div>
            <div><dt>主键</dt><dd className="mono">{current.primaryKey}</dd></div>
            <div><dt>标题属性</dt><dd className="mono">{current.titleProperty}</dd></div>
            <div><dt>来源</dt><dd>{current.isSystem ? '系统内置' : '自定义'}</dd></div><div><dt>写入方式</dt><dd>{current.writeMode==='managed'?'业务动作':current.writeMode==='read_only'?'只读记录或索引':current.writeMode==='virtual'?'虚拟对象':'自定义对象'}</dd></div>
          </dl>
          <div className="data-detail-tabs" role="tablist" aria-label="对象类型详情">
            {DETAIL_TABS.map((item) => <button key={item.key} id={`data-tab-${item.key}`} role="tab" aria-selected={tab === item.key} aria-controls="data-type-tabpanel" tabIndex={tab === item.key ? 0 : -1} className={tab === item.key ? 'active' : ''}
              onClick={() => setTab(item.key)} onKeyDown={(e) => {
                const index = DETAIL_TABS.findIndex((t) => t.key === item.key);
                let next = index;
                if (e.key === 'ArrowRight') next = (index + 1) % DETAIL_TABS.length;
                else if (e.key === 'ArrowLeft') next = (index + DETAIL_TABS.length - 1) % DETAIL_TABS.length;
                else if (e.key === 'Home') next = 0;
                else if (e.key === 'End') next = DETAIL_TABS.length - 1;
                else return;
                e.preventDefault(); setTab(DETAIL_TABS[next].key); document.getElementById(`data-tab-${DETAIL_TABS[next].key}`)?.focus();
              }}>{item.label}{item.key === 'schema' ? ` ${current.properties.length}` : item.key === 'relations' ? ` ${relatedLinks.length}` : item.key === 'actions' ? ` ${relatedActions.length}` : current.isVirtual ? '' : ` ${counts[current.apiName] ?? '…'}`}</button>)}
          </div>
          <div className="data-type-content" id="data-type-tabpanel" role="tabpanel" aria-labelledby={`data-tab-${tab}`}>
            {tab === 'schema' && <ObjectTypeManager types={types} links={links} detailType={current} onChanged={refreshAll} />}
            {tab === 'relations' && <>
              {relatedLinks.length === 0 && <p className="sub">暂无与此类型关联的关系，可新建链接类型。</p>}
              <LinkTypeManager types={types} links={links} focusedType={current.apiName} onChanged={refreshAll} />
            </>}
            {tab === 'actions' && <>
              {relatedActions.length === 0 && <p className="sub">暂无与此类型关联的动作，可新建动作类型。</p>}
              <ActionTypeManager actions={relatedActions} composableCommands={actions.filter(action => action.isBuiltin && action.composable)} types={types} links={links} focusedType={current.apiName} onChanged={refreshAll} />
            </>}
            {tab === 'objects' && (current.isVirtual ? <p className="empty">这是虚拟对象类型，没有独立的物理表。可在「关系」中查看它与其他类型的关联。</p> : <DataObjects key={current.apiName} types={types} actions={relatedActions} objectType={current.apiName} initialObjectId={objectId} onChanged={refreshAll} onJump={(apiName, id) => openType(apiName, 'objects', id)} />)}
          </div>
        </div>}
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
    <div className="data-overview-summary">
      <dl className="data-overview-stats">
        <div><dt>数据库大小</dt><dd>{fmtBytes(overview.db.sizeBytes)}</dd></div>
        <div><dt>已有对象</dt><dd>{overview.tables.reduce((sum, table) => sum + table.count, 0)} 条</dd></div>
        <div><dt>对象类型</dt><dd>{overview.meta.objectTypes} 种</dd></div>
        <div><dt>关系</dt><dd>{overview.meta.linkTypes} 种</dd></div>
        <div><dt>动作</dt><dd>{overview.meta.actionTypes} 种</dd></div>
        <div><dt>迁移版本</dt><dd>v{overview.db.userVersion}</dd></div>
      </dl>
      <div className="data-storage-row">
        <div><strong>SQLite 主库</strong><p className="mono data-path">{overview.db.path}</p></div>
        <div className="btn-row"><button className="btn slim ghost" onClick={() => onOpenDir('db')}>打开数据目录</button><button className="btn slim ghost" onClick={() => onOpenDir('backups')}>打开备份目录</button></div>
      </div>
      <div className="data-storage-row">
        <div><strong>工具箱文件</strong><span className="sub"> {overview.toolsDir.toolCount} 个工具 · {fmtBytes(overview.toolsDir.sizeBytes)}</span><p className="mono data-path">{overview.toolsDir.path}</p></div>
        <button className="btn slim ghost" onClick={() => onOpenDir('tools')}>打开工具目录</button>
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
      <p className="sub data-note">备份使用 SQLite 在线备份（VACUUM INTO），不影响其他进程读写</p>
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
              const res = await call<{ integrityOk: boolean; integrityMessages: string[]; foreignKeyViolations: number; relationIssues:unknown[] }>(() => api.data.healthCheck());
              return `完整性：${res.integrityMessages.join('; ')}；外键违规：${res.foreignKeyViolations}；待修复关系：${res.relationIssues.length}`;
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
