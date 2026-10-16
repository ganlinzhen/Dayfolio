// 自媒体面板：概览 / 选题 / 内容 / 素材 / 日历 / 复盘 六视图工作流。
// 红线：不登录、不自动发布外部平台——「排期」只是本地计划，「已发布」由用户人工回填；
// 平台版本必须经人工审核（本面板的 通过/拒绝 按钮是用户动作，MCP 侧不提供审核通过）。
import { useCallback, useEffect, useState } from 'react';
import { api, call } from '../api';
import EmptyState from './EmptyState';
import { toast } from './Toast';
import { IconPlus, IconSearch, IconTrash, IconX } from './icons';

type View = 'overview' | 'topics' | 'contents' | 'materials' | 'calendar' | 'retro';

const VIEWS: Array<{ key: View; label: string; hint: string }> = [
  { key: 'overview', label: '概览', hint: '工作流全景：待审、排期与发布数' },
  { key: 'topics', label: '选题', hint: '点子池：可关联新闻或知识卡片' },
  { key: 'contents', label: '内容', hint: '一母稿多平台版本，每版本人工审核' },
  { key: 'materials', label: '素材', hint: '可追溯来源的素材库' },
  { key: 'calendar', label: '日历', hint: '排期与人工发布回填' },
  { key: 'retro', label: '复盘', hint: '手动指标汇总与经验回填' },
];

const PLATFORMS = ['xiaohongshu', 'weixin', 'douyin', 'bilibili', 'zhihu', 'weibo', 'x', 'video', 'other'];
const STATUS_LABEL: Record<string, string> = {
  idea: '点子', selected: '已选用', dropped: '已放弃',
  drafting: '撰写中', master_done: '母稿定稿',
  draft: '草稿', in_review: '待审核', approved: '已通过', rejected: '已拒绝',
  planned: '已排期', published: '已发布', cancelled: '已取消',
};
const KIND_LABEL: Record<string, string> = { text: '文本', image: '图片', link: '链接', note: '笔记' };
const todayStr = () => new Date().toLocaleDateString('sv-SE');

interface Overview {
  topics: { idea: number; selected: number; dropped: number };
  contents: { drafting: number; master_done: number };
  versions: { draft: number; in_review: number; approved: number; rejected: number };
  calendar: { planned: number; published: number; cancelled: number };
  published_last_30d: number;
  materials: number;
  pending_review: Array<{ id: number; content_id: number; content_title: string; platform: string; updated_at: string }>;
  upcoming: Array<{ id: number; planned_date: string; content_title: string; platform: string }>;
}

interface Topic {
  id: number;
  title: string;
  angle: string;
  status: string;
  source: string;
  source_desc: string;
  tags: string[];
  content_count: number;
  created_at: string;
}

interface Version {
  id: number;
  content_id: number;
  platform: string;
  body: string;
  status: string;
  review_note: string;
  updated_at: string;
}

interface Material {
  id: number;
  title: string;
  kind: string;
  content: string;
  source: string;
  source_desc: string;
  tags: string[];
}

interface CalendarEntry {
  id: number;
  content_version_id: number;
  content_id: number;
  content_title: string;
  platform: string;
  planned_date: string;
  status: string;
  published_at: string | null;
  publish_url: string | null;
  note: string;
}

interface ContentDetail {
  content: { id: number; topic_id: number | null; title: string; master_content: string; status: string; retro_note: string; created_at: string };
  topic: Topic | null;
  versions: Version[];
  materials: Material[];
  calendar: CalendarEntry[];
}

interface ContentRow {
  id: number;
  title: string;
  status: string;
  topic_id: number | null;
  version_count: number;
  platforms: string[];
  pending_review: number;
  updated_at: string;
}

interface MetricRow {
  id: number;
  calendar_id: number;
  date: string;
  platform: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  favorites: number | null;
  content_title: string;
}

interface PlatStat {
  platform: string;
  published: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  favorites: number;
}

const StatusBadge = ({ s }: { s: string }) => <span className={`tag st-${s}`}>{STATUS_LABEL[s] ?? s}</span>;

export default function MediaPanel() {
  const [view, setView] = useState<View>('overview');
  // 概览待审/排期点标题直达内容详情（ContentsView 重挂载时以此初始打开）
  const [jumpContentId, setJumpContentId] = useState<number | null>(null);
  const openContent = (id: number) => {
    setJumpContentId(id);
    setView('contents');
  };

  return (
    <div className="panel" role="region" aria-label="自媒体">
      <header className="panel-head" aria-label="自媒体视图">
        <div className="seg media-subnav" role="group" aria-label="自媒体视图">
          {VIEWS.map((v) => (
            <button key={v.key} className={`seg-item ${view === v.key ? 'active' : ''}`} onClick={() => setView(v.key)} title={v.hint}>
              {v.label}
            </button>
          ))}
        </div>
      </header>
      {view === 'overview' && <OverviewView openContent={openContent} />}
      {view === 'topics' && <TopicsView go={setView} />}
      {view === 'contents' && <ContentsView initialOpenId={jumpContentId} />}
      {view === 'materials' && <MaterialsView />}
      {view === 'calendar' && <CalendarView />}
      {view === 'retro' && <RetroView />}
    </div>
  );
}

// ---------- 概览 ----------

function OverviewView({ openContent }: { openContent: (id: number) => void }) {
  const [ov, setOv] = useState<Overview | null>(null);
  const refresh = useCallback(async () => {
    try {
      setOv(await call<Overview>(() => api.media.overview()));
    } catch (e) {
      toast((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const review = async (id: number, action: 'approve' | 'reject') => {
    try {
      await call(() => api.media.reviewVersion({ id, action }));
      toast(action === 'approve' ? '已通过审核，可排期发布' : '已拒绝，退回修改');
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  if (!ov) return <EmptyState title="正在读取概览…" />;
  return (
    <>
      <div className="stat-row">
        <div className="stat"><div className="stat-num serif">{ov.topics.selected}</div><div className="stat-label">已选用题</div></div>
        <div className="stat"><div className="stat-num serif">{ov.contents.drafting + ov.contents.master_done}</div><div className="stat-label">内容母稿</div></div>
        <div className="stat"><div className="stat-num serif">{ov.versions.in_review}</div><div className="stat-label">待人工审核</div></div>
        <div className="stat"><div className="stat-num serif">{ov.calendar.planned}</div><div className="stat-label">已排期待发</div></div>
        <div className="stat"><div className="stat-num serif">{ov.published_last_30d}</div><div className="stat-label">近 30 天已发布</div></div>
        <div className="stat"><div className="stat-num serif">{ov.materials}</div><div className="stat-label">素材</div></div>
      </div>

      <section className="group">
        <div className="group-label mono">待人工审核（{ov.pending_review.length}）——每版本须亲自过目后才能排期</div>
        {ov.pending_review.length === 0 && <div className="sub row-pad">暂无待审版本。版本在「内容」页提交审核后出现在这里。</div>}
        {ov.pending_review.map((p) => (
          <div key={p.id} className="media-review-row">
            <button className="media-review-title" onClick={() => openContent(p.content_id)}>{p.content_title}</button>
            <span className="tag">{p.platform}</span>
            <span className="sub mono">{new Date(p.updated_at).toLocaleString('zh-CN', { hour12: false })}</span>
            <span className="spacer" />
            <button className="btn slim primary" onClick={() => review(p.id, 'approve')}>通过</button>
            <button className="btn slim danger" onClick={() => review(p.id, 'reject')}>拒绝</button>
          </div>
        ))}
      </section>

      <section className="group">
        <div className="group-label mono">未来排期（{ov.upcoming.length}）</div>
        {ov.upcoming.length === 0 && <div className="sub row-pad">暂无排期。在「内容」页对已通过版本点「排期」。</div>}
        {ov.upcoming.map((u) => (
          <div key={u.id} className="media-review-row">
            <span className="mono">{u.planned_date}</span>
            <span>{u.content_title}</span>
            <span className="tag">{u.platform}</span>
            <span className="spacer" />
            <span className="sub">到「日历」回填发布</span>
          </div>
        ))}
      </section>

      <div className="notice">
        全程人工闭环：Dayfolio 不登录任何平台、不自动发布。排期只是本地计划；你在各平台手动发布后回填状态与链接，指标手动录入「复盘」。
      </div>
    </>
  );
}

// ---------- 选题 ----------

function TopicsView({ go }: { go: (v: View) => void }) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [title, setTitle] = useState('');
  const [angle, setAngle] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [newsList, setNewsList] = useState<Array<{ id: number; title: string; url: string }>>([]);
  const [pickedNews, setPickedNews] = useState<{ id: number; title: string; url: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setTopics(await call<Topic[]>(() => api.media.listTopics({ status, search: search || undefined })));
    } catch (e) {
      toast((e as Error).message);
    }
  }, [status, search]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openPicker = async () => {
    try {
      const list = await call<Array<{ id: number; title: string; url: string }>>(() => api.news.list({ limit: 15 }));
      setNewsList(list);
      setPickerOpen(true);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const add = async () => {
    if (!title.trim()) return;
    try {
      await call(() =>
        api.media.addTopic({
          title: title.trim(),
          angle: angle.trim() || undefined,
          source: pickedNews ? 'news' : 'manual',
          source_news_id: pickedNews?.id ?? null,
        }),
      );
      setTitle('');
      setAngle('');
      setPickedNews(null);
      await refresh();
      toast('选题已加入点子池');
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const act = async (id: number, patch: Record<string, unknown>) => {
    try {
      await call(() => api.media.updateTopic({ id, ...patch }));
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const createContent = async (t: Topic) => {
    try {
      const c = await call<{ id: number }>(() => api.media.addContent({ topic_id: t.id, title: t.title }));
      await act(t.id, { status: 'selected' });
      toast(`已创建内容「${t.title}」，前往内容页继续`);
      go('contents');
      void c;
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const del = async (id: number) => {
    try {
      await call(() => api.media.deleteTopic({ id }));
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <>
      <div className="group media-composer">
        <input className="inline-input" placeholder="选题标题" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input className="inline-input" placeholder="角度 / 立意（可选）" value={angle} onChange={(e) => setAngle(e.target.value)} />
        <button className="btn slim ghost" onClick={openPicker}>从新闻选择来源</button>
        {pickedNews && (
          <span className="tag">
            {pickedNews.title.slice(0, 18)}…
            <button className="tag-x" onClick={() => setPickedNews(null)} aria-label="清除来源"><IconX width={10} height={10} /></button>
          </span>
        )}
        <button className="btn primary" onClick={add}><IconPlus /> 加入点子池</button>
      </div>
      {pickerOpen && (
        <div className="group media-news-picker">
          <div className="group-label mono">最近新闻（点击作为选题来源，快照标题与链接）</div>
          {newsList.map((n) => (
            <button
              key={n.id}
              className="media-review-title"
              onClick={() => {
                setPickedNews(n);
                if (!title) setTitle(n.title.slice(0, 40));
                setPickerOpen(false);
              }}
            >
              {n.title}
            </button>
          ))}
          <button className="btn slim ghost" onClick={() => setPickerOpen(false)}>收起</button>
        </div>
      )}

      <div className="toolbar">
        <div className="searchbox">
          <IconSearch />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索选题…" aria-label="搜索选题" />
        </div>
        <div className="seg">
          {['all', 'idea', 'selected', 'dropped'].map((s) => (
            <button key={s} className={`seg-item ${status === s ? 'active' : ''}`} onClick={() => setStatus(s)}>
              {s === 'all' ? '全部' : STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      {topics.length === 0 && <EmptyState title="点子池还是空的" hint="把想做的题目记下来；也可从新闻一键带入来源。" />}
      {topics.map((t) => (
        <div key={t.id} className="media-topic-row">
          <div className="media-topic-main">
            <div className="media-topic-title">{t.title}</div>
            {t.angle && <div className="sub">{t.angle}</div>}
            {t.source_desc && <div className="media-src mono">来源：{t.source_desc.split('\n')[0]}</div>}
          </div>
          <div className="media-topic-side">
            <StatusBadge s={t.status} />
            {t.content_count > 0 && <span className="tag">{t.content_count} 内容</span>}
            {t.status === 'idea' && <button className="btn slim" onClick={() => act(t.id, { status: 'selected' })}>选用</button>}
            {t.status === 'dropped' && <button className="btn slim ghost" onClick={() => act(t.id, { status: 'idea' })}>恢复</button>}
            {t.status !== 'dropped' && t.content_count === 0 && (
              <>
                <button className="btn slim ghost" onClick={() => act(t.id, { status: 'dropped' })}>放弃</button>
                <button className="btn slim primary" onClick={() => createContent(t)}>建内容</button>
              </>
            )}
            {t.content_count === 0 && (
              <button className="icon-btn subtle" onClick={() => del(t.id)} aria-label="删除选题"><IconTrash /></button>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

// ---------- 内容（母稿 + 平台版本） ----------

function ContentsView({ initialOpenId = null }: { initialOpenId?: number | null }) {
  const [rows, setRows] = useState<ContentRow[]>([]);
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<number | null>(initialOpenId);
  const [newTitle, setNewTitle] = useState('');

  const refresh = useCallback(async () => {
    try {
      setRows(await call<ContentRow[]>(() => api.media.listContents({ search: search || undefined })));
    } catch (e) {
      toast((e as Error).message);
    }
  }, [search]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (openId !== null) {
    return <ContentDetailview id={openId} back={() => { setOpenId(null); void refresh(); }} />;
  }

  const add = async () => {
    if (!newTitle.trim()) return;
    try {
      await call(() => api.media.addContent({ title: newTitle.trim() }));
      setNewTitle('');
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <>
      <div className="group media-composer">
        <input className="inline-input" placeholder="新内容标题（母稿）" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
        <button className="btn primary" onClick={add}><IconPlus /> 建母稿</button>
      </div>
      <div className="toolbar">
        <div className="searchbox">
          <IconSearch />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索内容…" aria-label="搜索内容" />
        </div>
      </div>
      {rows.length === 0 && <EmptyState title="还没有内容" hint="从选题「建内容」进入，或直接新建母稿；一个母稿可适配多个平台版本。" />}
      {rows.map((r) => (
        <button key={r.id} className="media-content-row" onClick={() => setOpenId(r.id)}>
          <div className="media-topic-title">{r.title}</div>
          <div className="media-topic-side">
            <StatusBadge s={r.status} />
            {r.platforms.map((p) => <span key={p} className="tag">{p}</span>)}
            {r.pending_review > 0 && <span className="tag st-in_review">待审 {r.pending_review}</span>}
            <span className="sub mono">{new Date(r.updated_at).toLocaleDateString('sv-SE')}</span>
          </div>
        </button>
      ))}
    </>
  );
}

function ContentDetailview({ id, back }: { id: number; back: () => void }) {
  const [d, setD] = useState<ContentDetail | null>(null);
  const [master, setMaster] = useState('');
  const [retro, setRetro] = useState('');
  const [platform, setPlatform] = useState('xiaohongshu');
  const [body, setBody] = useState('');
  const [editVer, setEditVer] = useState<number | null>(null);
  const [editBody, setEditBody] = useState('');
  const [schedDate, setSchedDate] = useState(todayStr());
  const [pubUrl, setPubUrl] = useState<Record<number, string>>({});
  const [materials, setMaterials] = useState<Material[]>([]);
  const [attachId, setAttachId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const detail = await call<ContentDetail>(() => api.media.getContent({ id }));
      setD(detail);
      setMaster(detail.content.master_content);
      setRetro(detail.content.retro_note);
      const all = await call<Material[]>(() => api.media.listMaterials({}));
      setMaterials(all);
    } catch (e) {
      toast((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!d) return <EmptyState title="正在读取内容…" />;
  const c = d.content;

  const saveMaster = async () => {
    try {
      await call(() => api.media.updateContent({ id: c.id, master_content: master }));
      toast('母稿已保存');
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const toggleStatus = async () => {
    try {
      await call(() => api.media.updateContent({ id: c.id, status: c.status === 'master_done' ? 'drafting' : 'master_done' }));
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const saveRetro = async () => {
    try {
      await call(() => api.media.updateContent({ id: c.id, retro_note: retro }));
      toast('复盘笔记已保存');
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const addVersion = async () => {
    try {
      await call(() => api.media.addVersion({ content_id: c.id, platform, body }));
      setBody('');
      toast(`${platform} 版本已创建（草稿）`);
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const doReview = async (vid: number, action: 'submit' | 'approve' | 'reject' | 'revoke') => {
    try {
      await call(() => api.media.reviewVersion({ id: vid, action }));
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const saveEdit = async (vid: number) => {
    try {
      await call(() => api.media.updateVersion({ id: vid, body: editBody }));
      setEditVer(null);
      toast('版本正文已保存');
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const schedule = async (vid: number) => {
    try {
      await call(() => api.media.schedule({ content_version_id: vid, planned_date: schedDate }));
      toast(`已排期到 ${schedDate}`);
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const publish = async (entryId: number) => {
    try {
      await call(() => api.media.markPublished({ id: entryId, publish_url: pubUrl[entryId] || undefined }));
      toast('已回填发布（状态=已发布）');
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const cancelCal = async (entryId: number) => {
    try {
      await call(() => api.media.cancelSchedule({ id: entryId }));
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const remove = async () => {
    const ok = window.confirm(`删除内容「${c.title}」？其平台版本、排期与指标将一并删除，不可恢复。`);
    if (!ok) return;
    try {
      await call(() => api.media.deleteContent({ id: c.id }));
      toast('内容已删除（含版本/排期/指标）');
      back();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const exportPkg = async () => {
    try {
      const dir = await call<string | null>(() => api.media.pickExportDir());
      if (!dir) return;
      const out = await call<{ dir: string; files: string[] }>(() => api.media.exportPackage({ content_id: c.id, export_dir: dir }));
      toast(`素材包已导出：${out.dir}（${out.files.length} 个文件）`);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const attach = async () => {
    if (!attachId) return;
    try {
      await call(() => api.media.attachMaterial({ content_id: c.id, material_id: attachId }));
      setAttachId(null);
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const detach = async (mid: number) => {
    try {
      await call(() => api.media.detachMaterial({ content_id: c.id, material_id: mid }));
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <>
      <button className="backlink" onClick={back}>← 返回内容列表</button>
      <header className="panel-head">
        <h1>{c.title}</h1>
        <div className="head-meta mono">
          <StatusBadge s={c.status} />
          {d.topic && <span className="tag">选题：{d.topic.title}</span>}
          {d.versions.length} 个平台版本 · {d.calendar.filter((e) => e.status === 'published').length} 次已发布
        </div>
      </header>

      <section className="group">
        <div className="group-label mono">母稿（平台版本的上游）</div>
        <textarea className="media-editor" value={master} onChange={(e) => setMaster(e.target.value)} rows={8} aria-label="母稿正文" />
        <div className="media-actions">
          <button className="btn slim" onClick={saveMaster}>保存母稿</button>
          <button className="btn slim" onClick={toggleStatus}>
            {c.status === 'master_done' ? '撤销定稿' : '标记定稿'}
          </button>
        </div>
      </section>

      <section className="group">
        <div className="group-label mono">平台版本（{d.versions.length}）——每版本须人工审核后排期</div>
        {d.versions.map((v) => (
          <div key={v.id} className="media-version-row">
            <div className="media-version-head">
              <span className="tag">{v.platform}</span>
              <StatusBadge s={v.status} />
              {v.review_note && <span className="sub">审核备注：{v.review_note}</span>}
              <span className="spacer" />
              {(v.status === 'draft' || v.status === 'rejected') && (
                <button className="btn slim" onClick={() => doReview(v.id, 'submit')}>提交审核</button>
              )}
              {v.status === 'in_review' && (
                <>
                  <button className="btn slim primary" onClick={() => doReview(v.id, 'approve')}>通过</button>
                  <button className="btn slim danger" onClick={() => doReview(v.id, 'reject')}>拒绝</button>
                </>
              )}
              {v.status === 'approved' && (
                <>
                  <input
                    type="date"
                    className="inline-input narrow media-date"
                    value={schedDate}
                    onChange={(e) => setSchedDate(e.target.value)}
                    aria-label={`${v.platform} 排期日期`}
                  />
                  <button className="btn slim" onClick={() => schedule(v.id)}>排期</button>
                  <button className="btn slim ghost" onClick={() => doReview(v.id, 'revoke')}>撤回重编</button>
                </>
              )}
              {v.status !== 'approved' && v.id !== editVer && (
                <button
                  className="btn slim ghost"
                  onClick={() => {
                    setEditVer(v.id);
                    setEditBody(v.body);
                  }}
                >
                  编辑
                </button>
              )}
            </div>
            {v.id === editVer ? (
              <div className="media-version-edit">
                <textarea className="media-editor" value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={6} aria-label="版本正文" />
                <div className="media-actions">
                  <button className="btn slim primary" onClick={() => saveEdit(v.id)}>保存</button>
                  <button className="btn slim ghost" onClick={() => setEditVer(null)}>取消</button>
                </div>
              </div>
            ) : (
              v.body && <pre className="media-version-body">{v.body}</pre>
            )}
          </div>
        ))}
        <div className="media-composer">
          <select className="kb-vault-select" value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="平台">
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <button className="btn slim" onClick={addVersion}><IconPlus /> 加平台版本</button>
          <span className="sub">先在下方写正文，或创建后编辑</span>
        </div>
        <textarea className="media-editor" value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder="新版本正文…" aria-label="新版本正文" />
      </section>

      <section className="group">
        <div className="group-label mono">挂载素材（{d.materials.length}）</div>
        {d.materials.map((m) => (
          <div key={m.id} className="media-review-row">
            <span className="media-topic-title">{m.title}</span>
            <span className="tag">{KIND_LABEL[m.kind] ?? m.kind}</span>
            <span className="sub mono">{m.source_desc.split('\n')[0] || m.content.slice(0, 30)}</span>
            <span className="spacer" />
            <button className="icon-btn subtle" onClick={() => detach(m.id)} aria-label={`卸下素材 ${m.title}`}><IconX /></button>
          </div>
        ))}
        <div className="media-composer">
          <select
            className="kb-vault-select"
            value={attachId ?? undefined}
            onChange={(e) => setAttachId(Number(e.target.value))}
            aria-label="选择素材"
          >
            <option value="">选择素材…</option>
            {materials
              .filter((m) => !d.materials.some((x) => x.id === m.id))
              .map((m) => (
                <option key={m.id} value={m.id}>{m.title}</option>
              ))}
          </select>
          <button className="btn slim" onClick={attach} disabled={!attachId}>挂载</button>
        </div>
      </section>

      <section className="group">
        <div className="group-label mono">排期与发布回填（{d.calendar.length}）</div>
        {d.calendar.length === 0 && <div className="sub row-pad">无排期。通过审核的版本在上方「排期」。</div>}
        {d.calendar.map((e) => (
          <div key={e.id} className="media-review-row">
            <span className="mono">{e.planned_date}</span>
            <span className="tag">{e.platform}</span>
            <StatusBadge s={e.status} />
            {e.publish_url && <span className="media-src mono">{e.publish_url}</span>}
            <span className="spacer" />
            {e.status === 'planned' && (
              <>
                <input
                  className="inline-input narrow"
                  placeholder="作品链接（可选）"
                  value={pubUrl[e.id] ?? ''}
                  onChange={(ev) => setPubUrl({ ...pubUrl, [e.id]: ev.target.value })}
                  aria-label="作品链接"
                />
                <button className="btn slim primary" onClick={() => publish(e.id)}>我已手动发布</button>
                <button className="btn slim ghost" onClick={() => cancelCal(e.id)}>取消</button>
              </>
            )}
          </div>
        ))}
      </section>

      <section className="group">
        <div className="group-label mono">复盘笔记</div>
        <textarea className="media-editor" value={retro} onChange={(e) => setRetro(e.target.value)} rows={3} placeholder="发布后的经验：什么标题/封面/时间有效…" aria-label="复盘笔记" />
        <div className="media-actions">
          <button className="btn slim" onClick={saveRetro}>保存复盘</button>
        </div>
      </section>

      <div className="media-actions media-footer">
        <button className="btn" onClick={exportPkg}>导出素材包（选 vault 外目录）</button>
        <button className="btn danger ghost" onClick={remove}>删除内容</button>
      </div>
    </>
  );
}

// ---------- 素材 ----------

function MaterialsView() {
  const [rows, setRows] = useState<Material[]>([]);
  const [search, setSearch] = useState('');
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('text');
  const [content, setContent] = useState('');

  const refresh = useCallback(async () => {
    try {
      setRows(await call<Material[]>(() => api.media.listMaterials({ search: search || undefined })));
    } catch (e) {
      toast((e as Error).message);
    }
  }, [search]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async () => {
    if (!title.trim()) return;
    try {
      await call(() => api.media.addMaterial({ title: title.trim(), kind, content }));
      setTitle('');
      setContent('');
      await refresh();
      toast('素材已入库');
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const del = async (id: number) => {
    try {
      await call(() => api.media.deleteMaterial({ id }));
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <>
      <div className="group media-composer">
        <input className="inline-input" placeholder="素材标题" value={title} onChange={(e) => setTitle(e.target.value)} />
        <select className="kb-vault-select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="素材类型">
          {Object.entries(KIND_LABEL).map(([k, l]) => (
            <option key={k} value={k}>{l}</option>
          ))}
        </select>
        <button className="btn primary" onClick={add}><IconPlus /> 入库</button>
      </div>
      <textarea className="media-editor" value={content} onChange={(e) => setContent(e.target.value)} rows={3} placeholder="素材内容 / 链接 / 图片说明（图片文件不入库，导出素材包时按说明列出）" aria-label="素材内容" />
      <div className="toolbar">
        <div className="searchbox">
          <IconSearch />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索素材…" aria-label="搜索素材" />
        </div>
      </div>
      {rows.length === 0 && <EmptyState title="素材库是空的" hint="积累金句、数据、截图说明与参考链接；在「内容」页挂载到具体母稿。" />}
      {rows.map((m) => (
        <div key={m.id} className="media-topic-row">
          <div className="media-topic-main">
            <div className="media-topic-title">{m.title}</div>
            <div className="sub">{m.content.slice(0, 120) || '（无内容）'}</div>
            {m.source_desc && <div className="media-src mono">来源：{m.source_desc.split('\n')[0]}</div>}
          </div>
          <div className="media-topic-side">
            <span className="tag">{KIND_LABEL[m.kind] ?? m.kind}</span>
            {m.tags.map((t) => <span key={t} className="tag">{t}</span>)}
            <button className="icon-btn subtle" onClick={() => del(m.id)} aria-label="删除素材"><IconTrash /></button>
          </div>
        </div>
      ))}
    </>
  );
}

// ---------- 日历 ----------

function CalendarView() {
  const [rows, setRows] = useState<CalendarEntry[]>([]);
  const [status, setStatus] = useState('all');
  const [from, setFrom] = useState('');

  const refresh = useCallback(async () => {
    try {
      setRows(await call<CalendarEntry[]>(() => api.media.listCalendar({ status, from: from || undefined })));
    } catch (e) {
      toast((e as Error).message);
    }
  }, [status, from]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const [pubUrl, setPubUrl] = useState<Record<number, string>>({});
  const publish = async (id: number) => {
    try {
      await call(() => api.media.markPublished({ id, publish_url: pubUrl[id] || undefined }));
      toast('已回填发布');
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const cancel = async (id: number) => {
    try {
      await call(() => api.media.cancelSchedule({ id }));
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const openUrl = async (url: string) => {
    try {
      await call(() => api.news.openUrl({ url }));
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <>
      <div className="toolbar">
        <div className="seg">
          {['all', 'planned', 'published', 'cancelled'].map((s) => (
            <button key={s} className={`seg-item ${status === s ? 'active' : ''}`} onClick={() => setStatus(s)}>
              {s === 'all' ? '全部' : STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <input type="date" className="inline-input narrow" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="从该日期起" />
        <span className="sub">按计划日期倒序，最多 500 条</span>
      </div>
      {rows.length === 0 && <EmptyState title="日历上没有条目" hint="在「内容」页对已通过审核的版本排期；手动发布后在这里回填。" />}
      {rows.map((e) => (
        <div key={e.id} className="media-topic-row">
          <div className="media-topic-main">
            <div className="media-topic-title">
              <span className="mono media-date-chip">{e.planned_date}</span> {e.content_title}
            </div>
            {e.publish_url && (
              <button className="media-src mono media-link" onClick={() => openUrl(e.publish_url!)}>{e.publish_url}</button>
            )}
            {e.note && <div className="sub">{e.note}</div>}
          </div>
          <div className="media-topic-side">
            <span className="tag">{e.platform}</span>
            <StatusBadge s={e.status} />
            {e.status === 'planned' && (
              <>
                <input
                  className="inline-input narrow"
                  placeholder="作品链接（可选）"
                  value={pubUrl[e.id] ?? ''}
                  onChange={(ev) => setPubUrl({ ...pubUrl, [e.id]: ev.target.value })}
                  aria-label="作品链接"
                />
                <button className="btn slim primary" onClick={() => publish(e.id)}>我已手动发布</button>
                <button className="btn slim ghost" onClick={() => cancel(e.id)}>取消</button>
              </>
            )}
            {e.status === 'published' && <span className="sub">到「复盘」录指标</span>}
          </div>
        </div>
      ))}
    </>
  );
}

// ---------- 复盘 ----------

function RetroView() {
  const [stats, setStats] = useState<PlatStat[]>([]);
  const [metrics, setMetrics] = useState<MetricRow[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [form, setForm] = useState<Record<number, { views: string; likes: string; comments: string }>>({});

  const refresh = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([
        call<PlatStat[]>(() => api.media.stats({ from: from || undefined, to: to || undefined })),
        call<MetricRow[]>(() => api.media.listMetrics({ from: from || undefined, to: to || undefined })),
      ]);
      setStats(s);
      setMetrics(m);
    } catch (e) {
      toast((e as Error).message);
    }
  }, [from, to]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async (r: MetricRow) => {
    const f = form[r.id] ?? { views: '', likes: '', comments: '' };
    try {
      await call(() =>
        api.media.addMetric({
          calendar_id: r.calendar_id,
          date: r.date,
          views: f.views === '' ? null : Number(f.views),
          likes: f.likes === '' ? null : Number(f.likes),
          comments: f.comments === '' ? null : Number(f.comments),
        }),
      );
      toast('指标已保存');
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <>
      <div className="toolbar">
        <input type="date" className="inline-input narrow" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="起始日期" />
        <span className="sub">至</span>
        <input type="date" className="inline-input narrow" value={to} onChange={(e) => setTo(e.target.value)} aria-label="结束日期" />
        <span className="sub">指标全部手动录入；同日重复录入覆盖。复盘笔记在各内容详情页。</span>
      </div>

      <section className="group">
        <div className="group-label mono">平台汇总</div>
        {stats.length === 0 ? (
          <div className="sub row-pad">还没有指标。发布后在下方逐条录入。</div>
        ) : (
          <table className="media-table">
            <thead>
              <tr><th>平台</th><th>已发布</th><th>阅读/播放</th><th>赞</th><th>评论</th><th>转发</th><th>收藏</th></tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.platform}>
                  <td className="tag">{s.platform}</td>
                  <td className="mono">{s.published}</td>
                  <td className="mono">{s.views}</td>
                  <td className="mono">{s.likes}</td>
                  <td className="mono">{s.comments}</td>
                  <td className="mono">{s.shares}</td>
                  <td className="mono">{s.favorites}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="group">
        <div className="group-label mono">指标明细（{metrics.length}）</div>
        {metrics.length === 0 && <div className="sub row-pad">暂无指标记录。</div>}
        {metrics.map((r) => (
          <div key={r.id} className="media-metric-row">
            <div className="media-topic-main">
              <div className="media-topic-title">
                <span className="mono media-date-chip">{r.date}</span> {r.content_title}
              </div>
              <div className="sub mono">
                {r.platform} · 阅读 {r.views ?? '—'} · 赞 {r.likes ?? '—'} · 评 {r.comments ?? '—'}
              </div>
            </div>
            <div className="media-topic-side">
              <input
                className="inline-input narrow media-metric-input"
                placeholder="阅读"
                value={(form[r.id] ?? { views: '', likes: '', comments: '' }).views}
                onChange={(e) => setForm({ ...form, [r.id]: { ...(form[r.id] ?? { views: '', likes: '', comments: '' }), views: e.target.value } })}
                aria-label="阅读数"
              />
              <input
                className="inline-input narrow media-metric-input"
                placeholder="赞"
                value={(form[r.id] ?? { views: '', likes: '', comments: '' }).likes}
                onChange={(e) => setForm({ ...form, [r.id]: { ...(form[r.id] ?? { views: '', likes: '', comments: '' }), likes: e.target.value } })}
                aria-label="赞数"
              />
              <input
                className="inline-input narrow media-metric-input"
                placeholder="评论"
                value={(form[r.id] ?? { views: '', likes: '', comments: '' }).comments}
                onChange={(e) => setForm({ ...form, [r.id]: { ...(form[r.id] ?? { views: '', likes: '', comments: '' }), comments: e.target.value } })}
                aria-label="评论数"
              />
              <button className="btn slim" onClick={() => save(r)}>保存</button>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
