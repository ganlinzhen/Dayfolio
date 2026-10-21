import Modal from './Modal';
// HTML 工具箱：分类排列横向入口，工具仅支持导入与删除。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, call } from '../api';
import EmbeddedFrame from './EmbeddedFrame';
import HtmlToolFrame from './HtmlToolFrame';
import { toast } from './Toast';
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronUp,
  IconPencil,
  IconPlus,
  IconTool,
  IconToolbox,
  IconTrash,
  IconUpload,
  TOOL_ICONS,
} from './icons';

interface ToolCategory {
  id: number;
  name: string;
  sort_order: number;
  created_at: string;
}

interface ToolRow {
  id: number;
  title: string;
  icon: string;
  category_id: number | null;
  entry_file: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** 待上传文件（内容 base64，主 .html + 可选配套资源） */
interface UpFile {
  name: string;
  contentBase64: string;
}

const toBase64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000; // 分块拼接避免 String.fromCharCode 参数上限
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
};

const readFiles = async (fileList: FileList): Promise<UpFile[]> =>
  Promise.all(
    Array.from(fileList).map(
      (f) =>
        new Promise<UpFile>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve({ name: f.name, contentBase64: toBase64(reader.result as ArrayBuffer) });
          reader.onerror = () => reject(new Error(`读取 ${f.name} 失败`));
          reader.readAsArrayBuffer(f);
        }),
    ),
  );

// 页面可使用内联图片作为入口图标，普通工具沿用内置图标。
const isImageIcon = (icon: string) => /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[a-zA-Z0-9+/=]+$/.test(icon);

export default function ToolsPanel() {
  const [cats, setCats] = useState<ToolCategory[]>([]);
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [catModalOpen, setCatModalOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [c, t] = await Promise.all([
        call<ToolCategory[]>(() => api.tools.listCategories()),
        call<ToolRow[]>(() => api.tools.list()),
      ]);
      setCats(c);
      setTools(t);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openTool = tools.find((t) => t.id === openId) ?? null;

  // 列表分组：按分类顺序展示有工具的分类，无分类的工具归入「未分类」
  const groups = useMemo(() => {
    const out: Array<{ cat: ToolCategory | null; items: ToolRow[] }> = [];
    for (const c of cats) {
      const items = tools.filter((t) => t.category_id === c.id);
      if (items.length > 0) out.push({ cat: c, items });
    }
    const none = tools.filter((t) => t.category_id === null);
    if (none.length > 0) out.push({ cat: null, items: none });
    return out;
  }, [cats, tools]);

  const deleteTool = async (t: ToolRow) => {
    if (!window.confirm(`删除工具「${t.title}」？其文件会一并删除，不可恢复。`)) return;
    try {
      await call(() => api.tools.delete({ id: t.id }));
      toast('已删除工具');
      if (openId === t.id) setOpenId(null);
      await refresh();
    } catch (e) {
      toast(`删除失败：${(e as Error).message}`);
    }
  };

  // ---------- 应用内打开：面包屑 + iframe（不出浏览器） ----------
  if (openTool) {
    return (
      <div className="tool-frame">
        <EmbeddedFrame
          label={`HTML 工具：${openTool.title}`}
          className="tool-embed"
          allowFullscreen={false}
          title={openTool.title}
          meta="HTML 工具"
          leading={
            <button className="tool-crumb-back" onClick={() => setOpenId(null)}>
              <IconChevronLeft width={13} height={13} />
              工具箱
            </button>
          }
        >
          <HtmlToolFrame toolId={openTool.id} title={openTool.title} entryFile={openTool.entry_file} />
        </EmbeddedFrame>
      </div>
    );
  }

  return (
    <div className="panel" role="region" aria-label="工具箱">
      <header className="panel-head">
        <div className="head-meta mono">{tools.length} 个工具</div>
        <span className="spacer" />
        <button className="btn slim" onClick={() => setCatModalOpen(true)}>
          管理分类
        </button>
        <button
          className="btn primary"
          onClick={() => {
            setFormOpen(true);
          }}
        >
          <IconPlus width={13} height={13} />
          导入 HTML
        </button>
      </header>

      {error && <div className="notice error">{error}</div>}

      {tools.length === 0 ? (
        <div className="empty">
          <IconToolbox width={18} height={18} />
          <div className="empty-title">还没有工具</div>
          <div className="empty-hint">
            点击「导入 HTML」加入本地网页工具，可一并选择配套 CSS、JS 和图片。
          </div>
        </div>
      ) : (
        groups.map(({ cat, items }) => (
          <section className="group" key={cat ? cat.id : 'none'}>
            <div className="group-label mono">
              {cat ? cat.name : '未分类'}
              <span className="group-count">{items.length}</span>
            </div>
            <div className="tool-grid">
              {items.map((t) => (
                <div key={t.id} className="tool-card">
                  <button className="tool-card-open" onClick={() => setOpenId(t.id)} title={t.title}>
                    <span className={`tool-card-icon tool-tone-${t.icon === 'code' ? 'blue' : t.icon === 'trophy' ? 'violet' : 'green'}`}>
                      {isImageIcon(t.icon) ? <img src={t.icon} width={36} height={36} alt="" /> : <IconTool name={t.icon} width={20} height={20} />}
                    </span>
                    <span className="tool-card-title">{t.title}</span>
                  </button>
                  <button className="icon-btn subtle tool-card-delete" title={`删除${t.title}`} aria-label={`删除${t.title}`} onClick={() => void deleteTool(t)}>
                    <IconTrash width={14} height={14} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        ))
      )}

      {catModalOpen && (
        <CategoryModal
          cats={cats}
          onClose={() => setCatModalOpen(false)}
          onChanged={refresh}
          onGoAddTool={() => {
            setCatModalOpen(false);
            setFormOpen(true);
          }}
        />
      )}
      {formOpen && (
        <ToolFormModal
          cats={cats}
          onClose={() => setFormOpen(false)}
          onSaved={async (t) => {
            setFormOpen(false);
            await refresh();
            toast(`已导入「${t.title}」`);
          }}
        />
      )}
    </div>
  );
}

// ---------- 分类管理弹窗：新增 / 改名 / 上下移排序 / 删除 ----------
function CategoryModal({ cats, onClose, onChanged, onGoAddTool }: {
  cats: ToolCategory[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  onGoAddTool: () => void;
}) {
  const [rows, setRows] = useState(cats);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameText, setRenameText] = useState('');
  const [busy, setBusy] = useState(false);
  const originalIds = useRef(cats.map((c) => c.id));

  const orderChanged = () => rows.some((r, i) => r.id !== originalIds.current[i]);

  const close = async () => {
    if (orderChanged()) {
      try {
        await call(() => api.tools.reorderCategories({ ids: rows.map((r) => r.id) }));
      } catch (e) {
        toast(`保存排序失败：${(e as Error).message}`);
      }
    }
    onClose();
    await onChanged();
  };

  const add = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const c = await call<ToolCategory>(() => api.tools.addCategory({ name }));
      setRows((rs) => [...rs, c]);
      setNewName('');
      originalIds.current = [...originalIds.current, c.id];
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rename = async (id: number) => {
    const name = renameText.trim();
    setRenaming(null);
    if (!name || name === rows.find((r) => r.id === id)?.name) return;
    try {
      await call(() => api.tools.renameCategory({ id, name }));
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, name } : r)));
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const remove = async (id: number, name: string) => {
    if (!window.confirm(`删除分类「${name}」？其中工具会移入「未分类」。`)) return;
    try {
      await call(() => api.tools.deleteCategory({ id }));
      setRows((rs) => rs.filter((r) => r.id !== id));
      originalIds.current = originalIds.current.filter((i) => i !== id);
      toast(`已删除分类「${name}」，工具移入未分类`);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const move = (idx: number, dir: -1 | 1) => {
    const next = [...rows];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    setRows(next);
  };

  return (
    <Modal title="管理分类" description="顺序即列表展示顺序" onClose={() => void close()} busy={busy} footer={<>
      <button className="btn ghost" disabled={busy} onClick={onGoAddTool}>
        去导入 HTML
      </button>
      <button className="btn primary" disabled={busy} onClick={() => void close()}>
        完成
      </button>
    </>}>
      {rows.length === 0 && <div className="empty" style={{ padding: '24px 0' }}>还没有分类，先建一个</div>}
      {rows.map((c, i) => (
        <div className="cat-row" key={c.id}>
          <span className="cat-order mono">{String(i + 1).padStart(2, '0')}</span>
          {renaming === c.id ? (
            <input
              className="inline-input"
              autoFocus
              value={renameText}
              maxLength={24}
              onChange={(e) => setRenameText(e.target.value)}
              onBlur={() => void rename(c.id)}
              onKeyDown={(e) => e.key === 'Enter' && void rename(c.id)}
            />
          ) : (
            <span className="cat-name" onDoubleClick={() => { setRenaming(c.id); setRenameText(c.name); }}>
              {c.name}
            </span>
          )}
          <button className="icon-btn" title="上移" disabled={i === 0} onClick={() => move(i, -1)}>
            <IconChevronUp width={14} height={14} />
          </button>
          <button className="icon-btn" title="下移" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
            <IconChevronDown width={14} height={14} />
          </button>
          <button
            className="icon-btn"
            title="重命名"
            onClick={() => {
              setRenaming(c.id);
              setRenameText(c.name);
            }}
          >
            <IconPencil width={14} height={14} />
          </button>
          <button className="icon-btn danger" title="删除分类" onClick={() => void remove(c.id, c.name)}>
            <IconTrash width={14} height={14} />
          </button>
        </div>
      ))}
      <div className="cat-add">
        <input
          className="inline-input"
          placeholder="新分类名称…"
          value={newName}
          maxLength={24}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
        <button className="btn slim" disabled={busy || !newName.trim()} onClick={() => void add()}>
          <IconPlus width={12} height={12} />
          添加
        </button>
      </div>
    </Modal>
  );
}

// ---------- 导入 HTML：名称、图标、分类与页面文件 ----------
function ToolFormModal({ cats, onClose, onSaved }: {
  cats: ToolCategory[];
  onClose: () => void;
  onSaved: (t: ToolRow) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [icon, setIcon] = useState('tool');
  const [categoryId, setCategoryId] = useState<string>('');
  const [files, setFiles] = useState<UpFile[]>([]);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const pickFiles = async (fl: FileList | null) => {
    if (!fl || fl.length === 0) return;
    try {
      setBusy(true);
      setFiles(await readFiles(fl));
      if (!title.trim()) setTitle(Array.from(fl).find(f => /\.html?$/i.test(f.name))?.name.replace(/\.html?$/i, '').slice(0, 40) ?? '');
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!title.trim()) {
      toast('请填写工具名称');
      return;
    }
    const hasHtml = files.some((f) => /\.html?$/i.test(f.name));
    if (!hasHtml) {
      toast('请选择一个 HTML 文件作为入口');
      return;
    }
    setBusy(true);
    const catId = categoryId ? Number(categoryId) : null;
    try {
      const payload = {
        title: title.trim(),
        icon,
        category_id: catId,
        ...(files.length > 0 ? { files } : {}),
      };
      const saved = await call<ToolRow>(() => api.tools.add(payload));
      await onSaved(saved);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="导入 HTML" description="HTML 文件在应用内打开" onClose={onClose} busy={busy} footer={<>
      <button className="btn" disabled={busy} onClick={onClose}>
        取消
      </button>
      <button className="btn primary" disabled={busy} onClick={() => void submit()}>
        {busy ? '导入中…' : '导入'}
      </button>
    </>}>
      <div className="form-row">
        <label className="form-label">名称</label>
        <input
          className="form-input"
          autoFocus
          placeholder="比如：颜色转换器"
          value={title}
          maxLength={40}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
      </div>
      <div className="form-row">
        <label className="form-label">图标</label>
        <div className="icon-grid">
          {TOOL_ICONS.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              title={label}
              className={`icon-cell ${icon === key ? 'active' : ''}`}
              onClick={() => setIcon(key)}
            >
              <Icon width={17} height={17} />
            </button>
          ))}
        </div>
      </div>
      <div className="form-row">
        <label className="form-label">分类</label>
        <select className="form-select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">未分类</option>
          {cats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label className="form-label">HTML 文件</label>
        <label className="file-drop">
          <input
            ref={fileInput}
            type="file"
            multiple
            disabled={busy}
            accept=".html,.htm,.css,.js,.png,.jpg,.jpeg,.gif,.svg,.json,.txt,.woff,.woff2"
            hidden
            onChange={(e) => void pickFiles(e.target.files)}
          />
          <IconUpload width={15} height={15} />
          <span>选择 HTML 文件，可多选配套 CSS、JS 和图片</span>
        </label>
        {files.length > 0 && (
          <ul className="file-list mono">
            {files.map((f) => (
              <li key={f.name} className={/\.html?$/i.test(f.name) ? 'entry' : ''}>
                {f.name}
                {/\.html?$/i.test(f.name) ? ' · 入口' : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
