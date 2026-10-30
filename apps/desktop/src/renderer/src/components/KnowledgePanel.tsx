import ActionButton from './ActionButton';
import { IconFolder, IconLink, IconUnlink } from './icons';
// 知识库面板：Obsidian vault 只读联动（注册 → 扫描 → 搜索/浏览 → 阅读 → 概念关联）。
// 布局为「列表页 ↔ 阅读页」两级导航（同课程讲义模式）：列表全宽展示，点开整页进入阅读，
// 返回按钮回列表并高亮刚才读过的那篇；阅读页内点链接/被引用直接切换目标卡片。
// 红线：本面板只读 vault 文件（索引与关联写在 Dayfolio 自己的库）；正文经安全渲染后
// 在 sandbox iframe 中展示（不加载附件图片、不执行任何脚本、不可导航）。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, call } from '../api';
import EmptyState from './EmptyState';
import EmbeddedFrame from './EmbeddedFrame';
import { toast } from './Toast';
import { IconChevronLeft, IconRefresh, IconSearch } from './icons';

interface VaultInfo {
  id: number;
  name: string;
  root_path: string;
  include_dirs: string[];
  include_raw: boolean;
  last_scan_at: string | null;
  last_scan_stats: { discovered: number; updated: number; missing: number; skipped: number } | null;
}

interface NoteRow {
  id: number;
  vault_id: number;
  rel_path: string;
  title: string;
  kind: 'moc' | 'card' | 'draft' | 'raw' | 'other';
  level: string | null;
  status: string | null;
  missing: boolean;
  size: number;
  indexed_at: string;
}

interface NoteDetail {
  note: NoteRow;
  markdown: string;
  html: string;
  stale: boolean;
  links: Array<{
    raw_target: string;
    resolved: { vault_id: number; rel_path: string; title: string } | null;
    candidates: Array<{ vault_id: number; rel_path: string; title: string }>;
  }>;
  backlinks: Array<{ vault_id: number; rel_path: string; title: string }>;
  concept_links: Array<{ id: number; knowledge_key: string }>;
}

const KIND_LABEL: Record<string, string> = { moc: 'MOC', card: '正式卡', draft: '待审', raw: '原料', other: '其他' };
const LEVEL_LABEL: Record<string, string> = { dao: '道', fa: '法', shu: '术', qi: '器' };
const STATUS_LABEL: Record<string, string> = { active: '有效', draft: '草稿', archived: '归档' };
const KB_CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">';

const fmtTime = (iso: string | null) => {
  if (!iso) return '从未';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
};

export default function KnowledgePanel() {
  const [vaults, setVaults] = useState<VaultInfo[]>([]);
  const [vaultId, setVaultId] = useState<number | null>(null);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<string>('all');
  const [level, setLevel] = useState<string>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [lastRead, setLastRead] = useState<string | null>(null);
  const [detail, setDetail] = useState<NoteDetail | null>(null);
  const [conceptInput, setConceptInput] = useState('');
  const [busy, setBusy] = useState(false);

  const activeVault = vaults.find((v) => v.id === vaultId) ?? null;

  const refreshVaults = useCallback(async () => {
    try {
      const list = await call<VaultInfo[]>(() => api.vault.list());
      setVaults(list);
      setVaultId((cur) => (cur && list.some((v) => v.id === cur) ? cur : list[0]?.id ?? null));
    } catch (e) {
      toast((e as Error).message);
    }
  }, []);

  const refreshNotes = useCallback(async () => {
    if (!vaultId) {
      setNotes([]);
      return;
    }
    try {
      const list = await call<NoteRow[]>(() =>
        api.vault.notes({ vault_id: vaultId, kind, level, search: search || undefined }),
      );
      setNotes(list);
    } catch (e) {
      toast((e as Error).message);
    }
  }, [vaultId, kind, level, search]);

  useEffect(() => {
    void refreshVaults();
  }, [refreshVaults]);
  useEffect(() => {
    void refreshNotes();
  }, [refreshNotes]);

  const openNote = useCallback(async (relPath: string) => {
    if (!vaultId) return;
    // 先切到详情页（点击立即反馈），数据到手后填充；失败则退回列表，避免卡在空详情
    setSelected(relPath);
    try {
      const d = await call<NoteDetail>(() => api.vault.getNote({ vault_id: vaultId, rel_path: relPath }));
      setDetail(d);
    } catch (e) {
      toast((e as Error).message);
      setSelected((cur) => (cur === relPath ? null : cur));
    }
  }, [vaultId]);

  const backToList = () => {
    setLastRead(selected);
    setSelected(null);
  };

  useEffect(() => {
    if (vaultId && selected) void openNote(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId]);

  const register = async () => {
    try {
      const root = await call<string | null>(() => api.vault.pickRoot());
      if (!root) return;
      const v = await call<VaultInfo>(() => api.vault.register({ root_path: root }));
      toast(`已注册知识库：${v.name}，开始首次扫描`);
      await refreshVaults();
      setVaultId(v.id);
      await doScan(v.id);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const doScan = async (id: number) => {
    setBusy(true);
    try {
      const s = await call<{ discovered: number; updated: number; unchanged: number; missing: number; skipped: number }>(
        () => api.vault.scan({ id }),
      );
      toast(`扫描完成：发现 ${s.discovered} 篇 · 更新 ${s.updated} · 缺失 ${s.missing}${s.skipped ? ` · 跳过 ${s.skipped}` : ''}`);
      await refreshVaults();
      await refreshNotes();
      if (selected) await openNote(selected);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeVault = async () => {
    if (!activeVault) return;
    const ok = window.confirm(`移除知识库「${activeVault.name}」？只删除 Dayfolio 内的索引与关联，不会动 vault 里的任何文件。`);
    if (!ok) return;
    try {
      await call(() => api.vault.remove({ id: activeVault.id }));
      setSelected(null);
      setLastRead(null);
      setDetail(null);
      await refreshVaults();
      await refreshNotes();
      toast('已移除（vault 文件未受影响）');
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const addConcept = async () => {
    if (!vaultId || !selected || !conceptInput.trim()) return;
    try {
      await call(() => api.vault.linkConcept({ vault_id: vaultId, rel_path: selected, knowledge_key: conceptInput.trim() }));
      setConceptInput('');
      await openNote(selected);
      toast('已关联概念');
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const removeConcept = async (id: number) => {
    try {
      await call(() => api.vault.unlinkConcept({ id }));
      if (selected) await openNote(selected);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const kindCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of notes) c[n.kind] = (c[n.kind] ?? 0) + 1;
    return c;
  }, [notes]);

  if (vaults.length === 0) {
    return (
      <div className="panel work-panel" role="region" aria-label="知识库">
        <header className="panel-head">
          <div className="head-meta mono">只读联动</div>
        </header>
        <EmptyState
          title="尚未注册知识库"
          hint="注册一个 Obsidian vault 目录（如 ~/Desktop/knowledge-base）。Dayfolio 只做只读索引：浏览、搜索、阅读卡片与关联学习概念；绝不写入或修改 vault 内任何文件，也不会触发 Git 提交。"
          action={<ActionButton icon={IconFolder} className="btn primary" onClick={register}>注册知识库目录</ActionButton>}
        />
      </div>
    );
  }

  // ---------- 阅读视图：整页替换列表（selected 非空即进入；返回按钮回列表并高亮刚才那篇） ----------
  const openDetail =
    detail && selected && detail.note.rel_path === selected && detail.note.vault_id === vaultId ? detail : null;
  if (selected) {
    return (
      <div className="panel work-panel" role="region" aria-label="知识库">
        <ActionButton icon={IconChevronLeft} className="backlink" onClick={backToList}>
           返回笔记列表
        </ActionButton>
        {!openDetail && <EmptyState title="正在加载…" hint="正在从磁盘读取笔记原文。" />}
        {openDetail && (
          <>
            <header className="panel-head kb-detail-head">
              <h1>{openDetail.note.title}</h1>
              <div className="head-meta mono kb-detail-meta">
                {openDetail.note.rel_path} · {Math.ceil(openDetail.note.size / 1024)}KB ·{' '}
                {KIND_LABEL[openDetail.note.kind]}
                {openDetail.note.level ? ` · ${LEVEL_LABEL[openDetail.note.level]}` : ''}
                {openDetail.note.status ? ` · ${STATUS_LABEL[openDetail.note.status] ?? openDetail.note.status}` : ''}
              </div>
              <div className="kb-detail-actions">
                <ActionButton icon={IconFolder}
                  className="btn slim ghost"
                  onClick={() =>
                    vaultId &&
                    selected &&
                    call(() => api.vault.revealInFinder({ vault_id: vaultId, rel_path: selected }))
                      .then(() => toast('已在 Finder 中定位'))
                      .catch((e: Error) => toast(e.message))
                  }
                >
                  在 Finder 中显示
                </ActionButton>
              </div>
            </header>

            {openDetail.stale && (
              <div className="notice warn">
                文件在上次扫描后已被修改（索引过期）。阅读内容是最新的；重新扫描可刷新索引与搜索。
                <div className="kb-stale-actions">
                  <ActionButton icon={IconRefresh} className="btn slim" onClick={() => activeVault && doScan(activeVault.id)} disabled={busy}>
                     立即重新扫描
                  </ActionButton>
                </div>
              </div>
            )}
            {openDetail.note.missing && (
              <div className="notice error">磁盘上已找不到此文件（可能被移动或删除）。记录与关联历史暂时保留。</div>
            )}

            <section className="group">
              <div className="group-label mono">关联学习概念（knowledge_key）</div>
              <div className="chip-tags">
                {openDetail.concept_links.map((c) => (
                  <span key={c.id} className="tag">
                    {c.knowledge_key}
                    <ActionButton icon={IconUnlink} className="tag-x" onClick={() => removeConcept(c.id)} aria-label={`解除关联 ${c.knowledge_key}`}>解除关联</ActionButton>
                  </span>
                ))}
                {openDetail.concept_links.length === 0 && <span className="sub">未关联。关联后可在学习计划/课程中引用这张卡。</span>}
              </div>
              <div className="kb-concept-add">
                <input
                  className="inline-input"
                  value={conceptInput}
                  onChange={(e) => setConceptInput(e.target.value)}
                  placeholder="如 ts/generics，回车关联"
                  onKeyDown={(e) => e.key === 'Enter' && addConcept()}
                />
                <ActionButton icon={IconLink} className="btn slim" onClick={addConcept}>关联</ActionButton>
              </div>
            </section>

            <EmbeddedFrame
              label={`知识卡正文：${openDetail.note.title}`}
              className="course-embed"
              title={openDetail.note.title}
              meta="安全渲染正文"
            >
              <iframe
                className="course-lesson-frame"
                sandbox=""
                title={openDetail.note.title}
                srcDoc={`<!doctype html><html><head><meta charset="utf-8">${KB_CSP}<style>body{font-family:-apple-system,'PingFang SC',sans-serif;line-height:1.8;padding:24px;max-width:76ch;margin:0 auto;color:#1a1a19}h1,h2,h3{line-height:1.4}pre{background:#f5f4f0;padding:12px;border-radius:8px;overflow-x:auto}table{border-collapse:collapse}td,th{border:1px solid #e8e7e3;padding:6px 10px}.wl{border-bottom:1px dashed #b9b6ad;color:#4a4a46}.md-img{color:#8a877e;background:#f5f4f0;padding:1px 6px;border-radius:4px;font-size:13px}.md-link{border-bottom:1px dotted #b9b6ad}blockquote{border-left:3px solid #e8e7e3;margin:0;padding:2px 14px;color:#5f5c55}</style></head><body>${openDetail.html}</body></html>`}
              />
            </EmbeddedFrame>

            {openDetail.links.length > 0 && (
              <section className="group">
                <div className="group-label mono">链接（{openDetail.links.length}）</div>
                {openDetail.links.map((l) => (
                  <div key={l.raw_target} className="kb-link-row">
                    <span className="mono sub">{l.raw_target}</span>
                    {l.resolved ? (
                      <button className="btn slim ghost" onClick={() => openNote(l.resolved!.rel_path)}>
                        → {l.resolved.title}
                      </button>
                    ) : l.candidates.length > 0 ? (
                      <span className="kb-candidates">
                        多义：
                        {l.candidates.map((c) => (
                          <button key={c.rel_path} className="btn slim ghost" onClick={() => openNote(c.rel_path)}>
                            {c.title}
                          </button>
                        ))}
                      </span>
                    ) : (
                      <span className="tag missing-tag">断链</span>
                    )}
                  </div>
                ))}
              </section>
            )}

            {openDetail.backlinks.length > 0 && (
              <section className="group">
                <div className="group-label mono">被引用（{openDetail.backlinks.length}）</div>
                {openDetail.backlinks.map((b) => (
                  <button key={b.rel_path} className="btn slim ghost kb-backlink" onClick={() => openNote(b.rel_path)}>
                    {b.title}
                  </button>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    );
  }

  // ---------- 列表视图 ----------
  return (
    <div className="panel work-panel" role="region" aria-label="知识库">
      <header className="panel-head kb-toolbar" aria-label="知识库管理">
        <select
          className="kb-vault-select"
          value={vaultId ?? undefined}
          onChange={(e) => {
            setVaultId(Number(e.target.value));
            setSelected(null);
            setLastRead(null);
            setDetail(null);
          }}
          aria-label="选择知识库"
        >
          {vaults.map((v) => (
            <option key={v.id} value={v.id}>{v.name}</option>
          ))}
        </select>
        <span className="head-meta">{notes.length} 篇笔记</span>
        <span className="spacer" />
        <span className="kb-scan-time">上次扫描 {fmtTime(activeVault?.last_scan_at ?? null)}</span>
        <ActionButton icon={IconRefresh} className="btn" onClick={() => activeVault && doScan(activeVault.id)} disabled={busy || !activeVault}>
           重新扫描
        </ActionButton>
        <details className="kb-settings">
          <summary className="btn ghost">管理知识库</summary>
          <div className="kb-settings-body">
            <div className="kb-root mono" title={activeVault?.root_path}>{activeVault?.root_path}</div>
            <div className="row-gap">
              <ActionButton icon={IconFolder} className="btn slim" onClick={register}>注册新库</ActionButton>
              <ActionButton icon={IconUnlink} className="btn slim danger" onClick={removeVault} disabled={!activeVault}>移除当前库</ActionButton>
            </div>
          </div>
        </details>
      </header>

      <div className="toolbar kb-filters">
        <div className="searchbox">
          <IconSearch />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索标题 / 路径 / 正文…"
            aria-label="搜索知识库"
          />
        </div>
        <div className="seg">
          {['all', 'moc', 'card', 'draft', 'raw'].map((k) => (
            <button key={k} className={`seg-item ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>
              {k === 'all' ? `全部 ${notes.length}` : `${KIND_LABEL[k]} ${kindCounts[k] ?? 0}`}
            </button>
          ))}
        </div>
        <select className="filter-select" aria-label="筛选知识层级" value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="all">全部层级</option>
          {['dao', 'fa', 'shu', 'qi'].map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
        </select>
      </div>

      <div className="kb-list">
        {notes.length === 0 && <EmptyState title="没有匹配的笔记" hint="调整搜索或过滤条件，或重新扫描。" />}
        {notes.map((n) => (
          <button
            key={n.id}
            className={`kb-note-row ${lastRead === n.rel_path ? 'active' : ''}`}
            onClick={() => openNote(n.rel_path)}
          >
            <span className="kb-note-title">{n.title}</span>
            <span className="kb-note-meta mono">
              {n.missing && <em className="tag missing-tag">缺失</em>}
              {KIND_LABEL[n.kind]}
              {n.level ? ` · ${LEVEL_LABEL[n.level]}` : ''}
              {n.status ? ` · ${STATUS_LABEL[n.status] ?? n.status}` : ''}
            </span>
            <span className="kb-note-path mono">{n.rel_path}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
