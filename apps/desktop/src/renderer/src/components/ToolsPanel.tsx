import Modal from './Modal';
// HTML 工具箱：浏览与编辑分离，整理操作仅在编辑模式展示。
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
  icon_background: string;
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
          reader.onload = () => resolve({ name: f.webkitRelativePath ? f.webkitRelativePath.split('/').slice(1).join('/') : f.name, contentBase64: toBase64(reader.result as ArrayBuffer) });
          reader.onerror = () => reject(new Error(`读取 ${f.name} 失败`));
          reader.readAsArrayBuffer(f);
        }),
    ),
  );

// 页面可使用内联图片作为入口图标，普通工具沿用内置图标。
const isImageIcon = (icon: string) => /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[a-zA-Z0-9+/=]+$/.test(icon);

function ToolIcon({ icon, background = 'auto' }: { icon: string; background?: string }) {
  return <span className={`tool-card-icon tool-tone-${icon === 'code' ? 'blue' : icon === 'trophy' ? 'violet' : 'green'}`}
    style={background !== 'auto' ? { background } : undefined}>
    {isImageIcon(icon) ? <img src={icon} width={36} height={36} alt="" /> : <IconTool name={icon} width={20} height={20} />}
  </span>;
}

export default function ToolsPanel() {
  const [cats, setCats] = useState<ToolCategory[]>([]);
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [catModalOpen, setCatModalOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editingTool, setEditingTool] = useState<ToolRow | null>(null);
  const [busy, setBusy] = useState(false);

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
      if (items.length > 0 || editing) out.push({ cat: c, items });
    }
    const none = tools.filter((t) => t.category_id === null);
    if (none.length > 0) out.push({ cat: null, items: none });
    return out;
  }, [cats, tools, editing]);

  const changeGroup = async (t: ToolRow, category: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await call(() => api.tools.update({ id: t.id, category_id: category ? Number(category) : null }));
      await refresh();
    } catch (e) {
      toast(`移动失败：${(e as Error).message}`);
    } finally { setBusy(false); }
  };

  const moveTool = async (t: ToolRow, neighbor: ToolRow) => {
    if (busy) return;
    const ids = tools.map(item => item.id);
    const a = ids.indexOf(t.id), b = ids.indexOf(neighbor.id);
    [ids[a], ids[b]] = [ids[b], ids[a]];
    setBusy(true);
    try {
      await call(() => api.tools.reorder({ ids }));
      await refresh();
    } catch (e) { toast(`排序失败：${(e as Error).message}`); await refresh(); }
    finally { setBusy(false); }
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
        {editing ? <>
          <button className="btn slim" disabled={busy} onClick={() => setCatModalOpen(true)}>管理分类</button>
          <button className="btn primary" disabled={busy} onClick={() => setEditing(false)}>完成编辑</button>
        </> : <>
          <button className="btn slim" onClick={() => setEditing(true)}><IconPencil width={13} height={13} />编辑</button>
          <button className="btn primary" onClick={() => setFormOpen(true)}><IconUpload width={13} height={13} />导入</button>
        </>}
      </header>

      {editing && <div className="tool-edit-notice" role="status"><strong>编辑模式</strong><span>点击工具编辑信息；用上下箭头排序，选择分类移动分组。整理操作即时保存。</span></div>}

      {error && <div className="notice error">{error}</div>}

      {tools.length === 0 && !editing ? (
        <div className="empty">
          <IconToolbox width={18} height={18} />
          <div className="empty-title">还没有工具</div>
          <div className="empty-hint">
            点击「导入」加入本地网页工具，可一并选择配套 CSS、JS 和图片。
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
              {items.map((t, index) => (
                <div key={t.id} className={`tool-card${editing ? ' is-editing' : ''}`}>
                  <button className="tool-card-open" disabled={busy} onClick={() => editing ? setEditingTool(t) : setOpenId(t.id)} title={editing ? `编辑${t.title}` : t.title}>
                    <ToolIcon icon={t.icon} background={t.icon_background} />
                    <span className="tool-card-title">{t.title}</span>
                    {editing && <IconPencil className="tool-edit-pencil" width={13} height={13} />}
                  </button>
                  {editing && <div className="tool-card-organize">
                    <select className="form-select" aria-label={`${t.title}的分类`} disabled={busy} value={t.category_id ?? ''} onChange={e => void changeGroup(t, e.target.value)}>
                      <option value="">未分类</option>
                      {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <button className="icon-btn" title={`上移${t.title}`} aria-label={`上移${t.title}`} disabled={busy || index === 0} onClick={() => void moveTool(t, items[index - 1])}><IconChevronUp width={14} height={14} /></button>
                    <button className="icon-btn" title={`下移${t.title}`} aria-label={`下移${t.title}`} disabled={busy || index === items.length - 1} onClick={() => void moveTool(t, items[index + 1])}><IconChevronDown width={14} height={14} /></button>
                  </div>}
                </div>
              ))}
            </div>
            {items.length === 0 && <p className="tool-empty-group">还没有工具，可通过工具的分类选项移入此组。</p>}
          </section>
        ))
      )}

      {catModalOpen && (
        <CategoryModal
          cats={cats}
          onClose={() => setCatModalOpen(false)}
          onChanged={refresh}
        />
      )}
      {(formOpen || editingTool) && (
        <ToolFormModal
          cats={cats}
          tool={editingTool}
          onClose={() => { setFormOpen(false); setEditingTool(null); }}
          onDeleted={async () => { setEditingTool(null); await refresh(); toast('已删除工具'); }}
          onSaved={async (t) => {
            setFormOpen(false);
            setEditingTool(null);
            await refresh();
            toast(`已${editingTool ? '保存' : '导入'}「${t.title}」`);
          }}
        />
      )}
    </div>
  );
}

// ---------- 分类管理：操作完成即保存，失败保留输入 ----------
function CategoryModal({ cats, onClose, onChanged }: {
  cats: ToolCategory[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [rows, setRows] = useState(cats);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameText, setRenameText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try { await action(); await onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const add = () => run(async () => {
    const c = await call<ToolCategory>(() => api.tools.addCategory({ name: newName.trim() }));
    setRows(rs => [...rs, c]); setNewName('');
  });
  const rename = () => run(async () => {
    if (renaming === null) return;
    const name = renameText.trim();
    await call(() => api.tools.renameCategory({ id: renaming, name }));
    setRows(rs => rs.map(r => r.id === renaming ? { ...r, name } : r));
    setRenaming(null);
  });
  const remove = (c: ToolCategory) => {
    if (!window.confirm(`删除分类「${c.name}」？其中工具会移入「未分类」。`)) return;
    void run(async () => { await call(() => api.tools.deleteCategory({ id: c.id })); setRows(rs => rs.filter(r => r.id !== c.id)); });
  };
  const move = (index: number, direction: number) => run(async () => {
    const next = [...rows];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    await call(() => api.tools.reorderCategories({ ids: next.map(r => r.id) }));
    setRows(next);
  });

  return <Modal title="管理分类" description="分类顺序即分组顺序，操作完成后即时保存" onClose={onClose} busy={busy} footer={<button className="btn primary" disabled={busy} onClick={onClose}>完成</button>}>
    {error && <div className="notice error" role="alert">{error}</div>}
    <fieldset className="tool-editor-fields" disabled={busy}>
      {rows.length === 0 && <p className="tool-field-hint">还没有分类，先添加一个。</p>}
      {rows.map((c, i) => <div className="cat-row" key={c.id}>
        {renaming === c.id ? <>
          <input className="inline-input" aria-label="分类新名称" autoFocus value={renameText} maxLength={24} onChange={e => setRenameText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void rename(); } }} />
          <button className="btn slim" onClick={() => void rename()}>保存名称</button>
          <button className="btn ghost slim" onClick={() => setRenaming(null)}>取消改名</button>
        </> : <>
          <span className="cat-name">{c.name}</span>
          <button className="icon-btn" title={`上移分类${c.name}`} aria-label={`上移分类${c.name}`} disabled={i === 0} onClick={() => void move(i, -1)}><IconChevronUp width={14} height={14} /></button>
          <button className="icon-btn" title={`下移分类${c.name}`} aria-label={`下移分类${c.name}`} disabled={i === rows.length - 1} onClick={() => void move(i, 1)}><IconChevronDown width={14} height={14} /></button>
          <button className="icon-btn" title={`重命名${c.name}`} aria-label={`重命名${c.name}`} onClick={() => { setRenaming(c.id); setRenameText(c.name); }}><IconPencil width={14} height={14} /></button>
          <button className="icon-btn danger" title={`删除分类${c.name}`} aria-label={`删除分类${c.name}`} onClick={() => remove(c)}><IconTrash width={14} height={14} /></button>
        </>}
      </div>)}
      <div className="cat-add">
        <input className="inline-input" aria-label="新分类名称" placeholder="新分类名称…" value={newName} maxLength={24} onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) { e.preventDefault(); void add(); } }} />
        <button className="btn slim" disabled={!newName.trim()} onClick={() => void add()}><IconPlus width={12} height={12} />添加</button>
      </div>
    </fieldset>
  </Modal>;
}

// ---------- 工具信息：导入与编辑共用，文件替换需要明确选择完整文件集 ----------
function ToolFormModal({ cats, tool, onClose, onSaved, onDeleted }: {
  cats: ToolCategory[];
  tool: ToolRow | null;
  onClose: () => void;
  onSaved: (t: ToolRow) => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const [title, setTitle] = useState(tool?.title ?? '');
  const [icon, setIcon] = useState(tool?.icon ?? 'tool');
  const [iconMode, setIconMode] = useState(isImageIcon(tool?.icon ?? '') ? 'image' : 'builtin');
  const [background, setBackground] = useState(tool?.icon_background ?? 'auto');
  const [categoryId, setCategoryId] = useState(String(tool?.category_id ?? ''));
  const [files, setFiles] = useState<UpFile[]>([]);
  const [existingFiles, setExistingFiles] = useState<string[]>([]);
  const [entryFile, setEntryFile] = useState(tool?.entry_file ?? '');
  const [loading, setLoading] = useState(!!tool);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const names = files.length ? files.map(f => f.name) : existingFiles;
  const htmlNames = names.filter(name => /\.html?$/i.test(name));

  useEffect(() => {
    if (!tool) return;
    let active = true;
    call<string[]>(() => api.tools.listFiles({ id: tool.id }))
      .then(list => { if (active) setExistingFiles(list); })
      .catch(e => { if (active) setError(`读取文件清单失败：${(e as Error).message}`); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [tool]);

  const pickFiles = async (fl: FileList | null) => {
    if (!fl?.length) return;
    setBusy(true);
    setError('');
    try {
      const picked = await readFiles(fl);
      const html = picked.filter(f => /\.html?$/i.test(f.name));
      if (!html.length) throw new Error('文件中缺少 HTML 页面，请重新选择');
      const entry = html.find(f => f.name === entryFile) ?? html.find(f => f.name === 'index.html') ?? html[0];
      setFiles(picked);
      setEntryFile(entry.name);
      if (!title.trim()) setTitle(entry.name.split('/').at(-1)!.replace(/\.html?$/i, '').slice(0, 40));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const pickImage = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'].includes(file.type)) throw new Error('请选择 PNG、JPEG、WebP、GIF 或 SVG 图片');
      if (file.size > 2 * 1024 * 1024) throw new Error('图片不能超过 2 MB，请选择较小的图片');
      const data = `data:${file.type};base64,${toBase64(await file.arrayBuffer())}`;
      const image = new Image();
      image.src = data;
      await image.decode();
      setIcon(data);
      setIconMode('image');
    } catch (e) { setError(`读取图标失败：${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  const submit = async () => {
    if (busy || loading) return;
    if (!title.trim()) { setError('请填写工具名称'); return; }
    if (iconMode === 'image' && !isImageIcon(icon)) { setError('请选择一张工具图片'); return; }
    if (!entryFile || !htmlNames.includes(entryFile)) { setError('请选择有效的 HTML 入口文件'); return; }
    setBusy(true);
    setError('');
    try {
      const payload = {
        title: title.trim(), icon, icon_background: background,
        category_id: categoryId ? Number(categoryId) : null,
        entry_file: entryFile,
        ...(files.length ? { files } : {}),
      };
      const saved = await call<ToolRow>(() => tool ? api.tools.update({ id: tool.id, ...payload }) : api.tools.add(payload));
      await onSaved(saved);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!tool || busy) return;
    if (!window.confirm(`删除工具「${tool.title}」？其文件会一并删除，不可恢复；停止该工具的持续关注，保留已创建的待办。`)) return;
    setBusy(true);
    try { await call(() => api.tools.delete({ id: tool.id })); await onDeleted(); }
    catch (e) { setError(`删除失败：${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  return (
    <Modal title={tool ? '编辑工具' : '导入 HTML'} description={tool ? '修改工具信息，保存后生效' : '选择本地 HTML 页面与配套资源'} onClose={onClose} busy={busy} footer={<>
      {tool && <button className="btn danger tool-editor-delete" disabled={busy || loading} onClick={() => void remove()}><IconTrash width={13} height={13} />删除工具</button>}
      <button className="btn" disabled={busy} onClick={onClose}>取消</button>
      <button className="btn primary" disabled={busy || loading} onClick={() => void submit()}>{busy ? '处理中…' : tool ? '保存修改' : '导入'}</button>
    </>}>
      {error && <div className="notice error" role="alert">{error}</div>}
      <fieldset className="tool-editor-fields" disabled={busy || loading}>
        <div className="form-row">
          <label className="form-label" htmlFor="tool-title">名称</label>
          <input id="tool-title" className="form-input" autoFocus placeholder="比如：颜色转换器" value={title} maxLength={40} onChange={e => setTitle(e.target.value)} />
        </div>
        <div className="form-row">
          <span className="form-label" id="tool-icon-label">工具图标</span>
          <div className="tool-appearance">
            <ToolIcon icon={icon} background={background} />
            <div className="seg" role="group" aria-labelledby="tool-icon-label">
              <button type="button" className={`seg-item${iconMode === 'builtin' ? ' active' : ''}`} aria-pressed={iconMode === 'builtin'} onClick={() => { setIconMode('builtin'); if (isImageIcon(icon)) setIcon('tool'); }}>内置图标</button>
              <button type="button" className={`seg-item${iconMode === 'image' ? ' active' : ''}`} aria-pressed={iconMode === 'image'} onClick={() => setIconMode('image')}>图片</button>
            </div>
          </div>
          {iconMode === 'builtin' ? <div className="icon-grid" role="group" aria-label="选择内置图标">
            {TOOL_ICONS.map(({ key, label, Icon }) => <button key={key} type="button" title={label} aria-label={label} aria-pressed={icon === key} className={`icon-cell ${icon === key ? 'active' : ''}`} onClick={() => setIcon(key)}><Icon width={17} height={17} /></button>)}
          </div> : <div className="tool-image-picker">
            <input ref={imageInput} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" onChange={e => { void pickImage(e.target.files?.[0]); e.target.value = ''; }} />
            <button className="btn slim" type="button" onClick={() => imageInput.current?.click()}><IconUpload width={13} height={13} />{isImageIcon(icon) ? '更换图片' : '选择图片'}</button>
            <span className="tool-field-hint">本地图片，最大 2 MB</span>
          </div>}
        </div>
        <div className="form-row">
          <label className="form-label" htmlFor="tool-background">图标背景</label>
          <div className="tool-background-picker">
            <button className={`btn slim${background === 'auto' ? ' primary' : ''}`} type="button" aria-pressed={background === 'auto'} onClick={() => setBackground('auto')}>默认</button>
            {['#217a6b', '#315bc8', '#6650bd', '#a24b31', '#55534e'].map(color => <button key={color} type="button" className={`tool-color-swatch${background === color ? ' active' : ''}`} style={{ background: color }} aria-label={`背景${color}`} aria-pressed={background === color} onClick={() => setBackground(color)} />)}
            <input id="tool-background" type="color" aria-label="自定义背景颜色" value={background === 'auto' ? '#217a6b' : background} onChange={e => setBackground(e.target.value)} />
          </div>
        </div>
        <div className="form-row">
          <label className="form-label" htmlFor="tool-category">分类</label>
          <select id="tool-category" className="form-select" value={categoryId} onChange={e => setCategoryId(e.target.value)}>
            <option value="">未分类</option>
            {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="form-row">
          <span className="form-label">页面与配套文件</span>
          <input ref={fileInput} className="tool-html-files" type="file" multiple hidden onChange={e => { void pickFiles(e.target.files); e.target.value = ''; }} />
          <input ref={folderInput} type="file" multiple hidden {...{ webkitdirectory: '' }} onChange={e => { void pickFiles(e.target.files); e.target.value = ''; }} />
          <div className="tool-file-actions">
            <button className="btn slim" type="button" onClick={() => fileInput.current?.click()}><IconUpload width={13} height={13} />{tool ? '替换文件' : '选择文件'}</button>
            <button className="btn slim" type="button" onClick={() => folderInput.current?.click()}>选择文件夹</button>
            {!!tool && files.length > 0 && <button className="btn ghost slim" type="button" onClick={() => { setFiles([]); setEntryFile(tool.entry_file); }}>保留原文件</button>}
          </div>
          <p className="tool-field-hint">{tool ? files.length ? '保存时将整体替换原文件，请包含 HTML、CSS、JS、图片和来源清单等全部资源。' : '未选择替换文件时，保留现有页面和全部配套资源。' : '可选择多个文件；含子目录的工具请选择整个文件夹。'}</p>
          {loading && <p role="status">正在读取文件清单…</p>}
          {names.length > 0 && <>
            <label className="form-label" htmlFor="tool-entry">HTML 入口</label>
            <select id="tool-entry" className="form-select" value={entryFile} onChange={e => setEntryFile(e.target.value)}>{htmlNames.map(name => <option key={name} value={name}>{name}</option>)}</select>
            <details className="tool-file-details"><summary>{names.length} 个{files.length && tool ? '待替换' : ''}文件</summary><ul className="file-list mono">{names.map(name => <li key={name} className={name === entryFile ? 'entry' : ''}>{name}{name === entryFile ? ' · 入口' : ''}</li>)}</ul></details>
          </>}
        </div>
      </fieldset>
      {tool && <p className="tool-field-hint">创建于 {new Date(tool.created_at).toLocaleDateString('zh-CN')} · ID {tool.id}</p>}
    </Modal>
  );
}
