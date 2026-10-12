// 知识库 vault 服务（只读联动）：
//   索引（可重建缓存）↔ 磁盘 Markdown（内容唯一来源）。本服务绝不写 vault 内任何文件、
//   不改 frontmatter、不触发 Git 提交；唯一写动作发生在 TodoDesk 自己的 SQLite（注册/索引/概念关联）。
//
// 安全红线：
// 1. 路径隔离：rel_path 必须是安全相对路径（拒绝绝对路径/..//反斜杠/控制字符），读取时逐组件
//    lstat 拒绝符号链接，resolve 后前缀校验留在 realpath(vault 根) 内——不向调用方暴露任意文件读取；
// 2. 体积与数量限制：单文件 2MB 上限，超限跳过并在扫描统计中报告；
// 3. 渲染安全：renderMarkdownHtml 先转义全部原始 HTML 再生成受控标签——脚本/事件属性/危险协议
//    不可能出现在输出中（App 侧再加 iframe sandbox 双保险）；附件图片一律不加载（显示占位）；
// 4. 缺失保留：磁盘上消失的笔记标 missing=1，记录与概念关联历史保留，绝不静默删除；
// 5. 概念关联只写 TodoDesk 库（vault_concept_links），knowledge_key 与 plan_items.knowledge_key
//    同一命名空间，一个概念可关联多张卡，一张卡可被多处引用。
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { DbAdapter } from '../db';
import type {
  Vault,
  VaultConceptLink,
  VaultNote,
  VaultNoteDetail,
  VaultNoteFilters,
  VaultNoteKind,
  VaultNoteLevel,
  VaultNoteLink,
  VaultScanStats,
} from '../types';
import { nowIso } from '../utils/date';

export const VAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const VAULT_DEFAULT_INCLUDE_DIRS = ['knowledge/moc', 'knowledge/resources', 'knowledge/inbox-cards'];
/** 单条搜索文本上限（超长正文截断入索引，阅读仍读全文） */
const SEARCH_TEXT_CAP = 100_000;
const LEVELS = ['dao', 'fa', 'shu', 'qi'] as const;

// ---------- 导出安全（草稿/素材包永不入 vault） ----------

/** 内置默认保护根：即使尚未注册也拒绝写入（真实 vault 的常见位置）。
 *  惰性求值 homedir：测试可用隔离 HOME 控制，不锁定启动时的家目录。 */
export function defaultProtectedVaultDirs(): string[] {
  return [join(homedir(), 'Desktop', 'knowledge-base')];
}

/** realpath 化可能不存在的路径：对存在的最深祖先做 realpath 再拼回剩余段。
 *  只 resolve 不 realpath 会被符号链接别名绕过（/tmp/alias → vault 时字符串前缀不匹配但写入穿透）。 */
export function realPathOfMaybeMissing(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail);
    } catch {
      /* 该段不存在：上溯到父目录 */
    }
    const idx = cur.lastIndexOf(sep);
    if (idx <= 0) return join(cur, ...tail);
    tail.unshift(cur.slice(idx + 1));
    cur = cur.slice(0, idx);
  }
}

/** 全部保护根：已注册 vault + 内置默认 + TODODESK_PROTECTED_DIRS（冒号分隔追加，测试/多 vault 机器用） */
export function protectedVaultRoots(db: DbAdapter): string[] {
  const roots: string[] = [];
  try {
    for (const r of db.prepare('SELECT root_path FROM vaults').all()) roots.push(String(r.root_path));
  } catch {
    /* vaults 表不存在（旧库未迁移）时忽略，仅剩内置与环境变量保护 */
  }
  roots.push(...defaultProtectedVaultDirs());
  const extra = process.env.TODODESK_PROTECTED_DIRS;
  if (extra) {
    for (const p of extra.split(':')) if (p.trim()) roots.push(resolve(p.trim()));
  }
  return roots;
}

/** 断言导出目录不在任何保护根内（symlink 安全）：study.exportCards 与 media.exportPackage 共用。 */
export function assertDirOutsideVaults(db: DbAdapter, absDir: string): void {
  const target = realPathOfMaybeMissing(absDir);
  for (const root of protectedVaultRoots(db)) {
    const rootReal = realPathOfMaybeMissing(root);
    if (target === rootReal || target.startsWith(rootReal + sep)) {
      throw new Error(
        `导出目录位于知识库 vault 内（${root}）：草稿与素材包不得写入 vault（可能被 Obsidian Git 自动发布），请选择 vault 外目录`,
      );
    }
  }
}

// ---------- 路径安全 ----------

/** vault 相对路径合法性：允许中日韩/空格等真实文件名，拒绝绝对路径、..、反斜杠、控制字符 */
export function isSafeVaultRelPath(rel: string): boolean {
  if (!rel || rel.length > 512) return false;
  if (rel.includes('\\')) return false;
  if (rel.startsWith('/') || rel.startsWith('~')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(rel)) return false;
  const parts = rel.split('/');
  return parts.every((p) => p !== '' && p !== '.' && p !== '..');
}

/** 逐组件拒绝符号链接 + resolve 前缀校验，返回绝对路径（调用方仅用于只读） */
function resolveInside(root: string, rel: string): string {
  if (!isSafeVaultRelPath(rel)) throw new Error(`不安全的笔记路径：${rel}`);
  const realRoot = realpathSync(root);
  let cur = realRoot;
  for (const part of rel.split('/')) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      throw new Error(`笔记不存在（可能已移动或删除，请重新扫描）：${rel}`);
    }
    if (st.isSymbolicLink()) throw new Error(`路径含符号链接（越界风险），拒绝读取：${rel}`);
  }
  const resolved = resolve(cur);
  if (resolved !== realRoot && !resolved.startsWith(realRoot + sep)) {
    throw new Error(`路径越出 vault 根目录，拒绝读取：${rel}`);
  }
  return resolved;
}

// ---------- frontmatter / 链接 解析 ----------

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** 极简 YAML 子集：`key: value` 标量 + 行内 [a, b] / 缩进 `- item` 列表；解析失败返回空对象（绝不让格式炸掉索引） */
export function parseFrontmatter(text: string): ParsedNote {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { frontmatter: {}, body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '---' || t === '...') {
      end = i;
      break;
    }
  }
  if (end === -1) return { frontmatter: {}, body: text };
  const fm: Record<string, unknown> = {};
  let lastKey = '';
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (m) {
      const key = m[1];
      let value = m[2].trim();
      if (value.startsWith('[') && value.endsWith(']')) {
        fm[key] = value
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter((s) => s.length > 0);
      } else {
        value = value.replace(/^["']|["']$/g, '');
        fm[key] = value;
      }
      lastKey = key;
    } else if (/^\s+-\s+/.test(line) && lastKey) {
      const item = line.replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, '');
      if (Array.isArray(fm[lastKey])) (fm[lastKey] as string[]).push(item);
      else if (fm[lastKey] === undefined || fm[lastKey] === '') fm[lastKey] = [item];
      else if (typeof fm[lastKey] === 'string') fm[lastKey] = [fm[lastKey] as string, item];
    }
  }
  return { frontmatter: fm, body: lines.slice(end + 1).join('\n') };
}

/** 提取 wikilink 目标：[[目标|别名]] / [[路径#标题]] → 目标（去别名、去锚点） */
export function extractWikiLinks(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\[\]]+?)\]\]/g)) {
    const raw = m[1];
    const target = raw.split('|')[0].split('#')[0].trim();
    if (target && !seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

// ---------- Markdown → 安全 HTML ----------

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Markdown 渲染为安全 HTML：先转义全部原始 HTML，再仅生成受控标签
 * （标题/粗斜体/代码/引用/列表/表格/分隔线/wikilink 占位）。输出不可能包含 script、
 * 事件属性或危险协议；链接不生成 <a>（沙箱 iframe 本就禁导航），图片仅占位不加载。
 */
export function renderMarkdownHtml(md: string): string {
  const lines = escapeHtml(md.replace(/\r\n/g, '\n')).split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let quote: string[] = [];
  let tableRows: string[][] | null = null;
  let inCode = false;
  let codeLang = '';
  let codeBuf: string[] = [];

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const closePara = () => {
    if (para.length > 0) {
      out.push(`<p>${para.join('<br>')}</p>`);
      para = [];
    }
  };
  const closeQuote = () => {
    if (quote.length > 0) {
      out.push(`<blockquote>${quote.join('<br>')}</blockquote>`);
      quote = [];
    }
  };
  const closeTable = () => {
    if (tableRows && tableRows.length > 0) {
      const [head, ...rest] = tableRows;
      const body = rest
        .filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c.trim())))
        .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
        .join('');
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`,
      );
    }
    tableRows = null;
  };
  const closeAll = () => {
    closePara();
    closeList();
    closeQuote();
    closeTable();
  };

  const fmtInline = (s: string): string => {
    let r = s;
    // 行内代码（先保护，避免内部再被替换）
    const codes: string[] = [];
    r = r.replace(/`([^`]+)`/g, (_m, c: string) => {
      codes.push(`<code>${c}</code>`);
      return `\u0000${codes.length - 1}\u0000`;
    });
    // wikilink（已转义，目标中不会再有 [ ]）
    r = r.replace(/\[\[([^\[\]]+?)\]\]/g, (_m, inner: string) => {
      const [target, alias] = inner.split('|');
      const label = (alias ?? target).trim() || target.trim();
      return `<span class="wl" data-wikilink="${target.trim().split('#')[0]}">${label}</span>`;
    });
    // 图片：不加载，仅占位
    r = r.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, path: string) =>
      `<span class="md-img">[图片未加载] ${alt || path}</span>`,
    );
    // 普通链接：不生成 <a>，保留文本与目标提示
    r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) =>
      `<span class="md-link">${text}（${url}）</span>`,
    );
    r = r.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    r = r.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    // 还原行内代码
    r = r.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? '');
    return r;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (inCode) {
      if (/^```/.test(line.trim())) {
        out.push(`<pre data-lang="${codeLang}"><code>${codeBuf.join('\n')}</code></pre>`);
        inCode = false;
        codeBuf = [];
        codeLang = '';
      } else {
        codeBuf.push(rawLine);
      }
      continue;
    }
    if (/^```/.test(line.trim())) {
      closeAll();
      inCode = true;
      codeLang = line.trim().slice(3).trim();
      continue;
    }
    // 表格行
    if (/^\s*\|.*\|\s*$/.test(line)) {
      closePara();
      closeList();
      closeQuote();
      const cells = line
        .trim()
        .slice(1, -1)
        .split('|')
        .map((c) => fmtInline(c.trim()));
      if (!tableRows) tableRows = [];
      tableRows.push(cells);
      continue;
    }
    closeTable();

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeAll();
      const level = heading[1].length;
      out.push(`<h${level}>${fmtInline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeAll();
      out.push('<hr>');
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      closePara();
      closeList();
      quote.push(fmtInline(line.replace(/^\s*>\s?/, '')));
      continue;
    }
    closeQuote();
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      closePara();
      const want = ul ? 'ul' : 'ol';
      if (listType !== want) {
        closeList();
        out.push(`<${want}>`);
        listType = want;
      }
      out.push(`<li>${fmtInline((ul ?? ol)![1])}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === '') {
      closePara();
      continue;
    }
    para.push(fmtInline(line));
  }
  if (inCode) out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`);
  closeAll();
  return out.join('\n');
}

// ---------- 行映射 ----------

function deriveKind(rel: string): VaultNoteKind {
  if (rel === 'knowledge/moc' || rel.startsWith('knowledge/moc/')) return 'moc';
  if (rel === 'knowledge/inbox-cards' || rel.startsWith('knowledge/inbox-cards/')) return 'draft';
  if (rel === 'raw' || rel.startsWith('raw/')) return 'raw';
  if (rel.startsWith('knowledge/resources/')) return 'card';
  return 'other';
}

function deriveLevel(rel: string): VaultNoteLevel {
  if (!rel.startsWith('knowledge/resources/')) return null;
  const rest = rel.slice('knowledge/resources/'.length);
  const seg = rest.split('/')[0];
  return (LEVELS as readonly string[]).includes(seg) ? (seg as VaultNoteLevel) : null;
}

function mapNote(row: Record<string, unknown>): VaultNote {
  let fm: Record<string, unknown> = {};
  try {
    fm = JSON.parse(String(row.frontmatter ?? '{}'));
  } catch {
    fm = {};
  }
  return {
    id: Number(row.id),
    vault_id: Number(row.vault_id),
    rel_path: String(row.rel_path),
    title: String(row.title),
    kind: row.kind as VaultNoteKind,
    level: (row.level as VaultNoteLevel) ?? null,
    status: (row.status as string | null) ?? null,
    frontmatter: fm,
    file_hash: String(row.file_hash),
    mtime_ms: Number(row.mtime_ms),
    size: Number(row.size),
    missing: Number(row.missing ?? 0) === 1,
    indexed_at: String(row.indexed_at),
  };
}

function mapVault(row: Record<string, unknown>): Vault {
  let stats: VaultScanStats | null = null;
  try {
    stats = row.last_scan_stats ? JSON.parse(String(row.last_scan_stats)) : null;
  } catch {
    stats = null;
  }
  return {
    id: Number(row.id),
    name: String(row.name),
    root_path: String(row.root_path),
    include_dirs: JSON.parse(String(row.include_dirs ?? '[]')),
    include_raw: Number(row.include_raw ?? 0) === 1,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    last_scan_at: (row.last_scan_at as string | null) ?? null,
    last_scan_stats: stats,
  };
}

// ---------- 服务 ----------

export interface VaultService {
  register(input: { root_path: string; name?: string; include_dirs?: string[]; include_raw?: boolean }): Vault;
  list(): Vault[];
  update(id: number, patch: { name?: string; include_dirs?: string[]; include_raw?: boolean }): Vault;
  remove(id: number): void;
  scan(vault_id: number): VaultScanStats;
  listNotes(filters?: VaultNoteFilters): Array<VaultNote & { vault_name?: string }>;
  getNote(vault_id: number, rel_path: string): VaultNoteDetail;
  linkConcept(input: { vault_id: number; rel_path: string; knowledge_key: string }): VaultConceptLink;
  unlinkConcept(link_id: number): void;
  listConceptLinks(filter: { knowledge_key?: string; note_id?: number }): VaultConceptLink[];
  /** 安全解析笔记绝对路径（App「在 Finder 显示」用；只读） */
  noteAbsolutePath(vault_id: number, rel_path: string): string;
  /** 任一注册 vault 的 realpath 根是否包含给定目录（素材包导出防写 vault 用） */
  isPathInsideAnyVault(absDir: string): boolean;
}

export function createVaultService(db: DbAdapter): VaultService {
  const now = () => nowIso();

  const getVaultRow = (id: number) => {
    const row = db.prepare('SELECT * FROM vaults WHERE id = ?').get(id);
    if (!row) throw new Error(`知识库不存在：${id}`);
    return row;
  };

  /** 递归收集 include_dirs（+raw）下全部 .md 相对路径；跳过隐藏目录与符号链接 */
  const walkVault = (vault: Vault): { files: string[]; invalidDirs: string[]; skipped: number } => {
    const roots = [...vault.include_dirs];
    if (vault.include_raw && !roots.includes('raw')) roots.push('raw');
    const files: string[] = [];
    const invalidDirs: string[] = [];
    let skipped = 0;
    let realRoot: string;
    try {
      realRoot = realpathSync(vault.root_path);
    } catch {
      // 外置盘未挂载/库被移动：给出明确指引，绝不把整个库判为删除（索引与历史保留）
      throw new Error(`vault 根目录不可访问（可能已被移动或所在磁盘未挂载）：${vault.root_path}；索引与历史已保留，恢复后重新扫描即可`);
    }
    for (const dirRel of roots) {
      if (!isSafeVaultRelPath(dirRel)) {
        invalidDirs.push(dirRel);
        continue;
      }
      let dirAbs: string;
      try {
        dirAbs = resolveInside(vault.root_path, dirRel);
      } catch {
        invalidDirs.push(dirRel);
        continue;
      }
      let st;
      try {
        st = statSync(dirAbs);
      } catch {
        invalidDirs.push(dirRel);
        continue;
      }
      if (!st.isDirectory()) {
        invalidDirs.push(dirRel);
        continue;
      }
      const walk = (abs: string, rel: string) => {
        for (const ent of readdirSync(abs, { withFileTypes: true })) {
          if (ent.name.startsWith('.')) continue;
          let est;
          try {
            est = lstatSync(join(abs, ent.name));
          } catch {
            skipped++;
            continue;
          }
          if (est.isSymbolicLink()) {
            skipped++;
            continue;
          }
          const childRel = rel ? `${rel}/${ent.name}` : ent.name;
          if (est.isDirectory()) {
            walk(join(abs, ent.name), childRel);
          } else if (est.isFile() && /\.md$/i.test(ent.name)) {
            if (est.size > VAULT_MAX_FILE_BYTES) {
              skipped++;
              continue;
            }
            files.push(childRel);
          }
        }
      };
      walk(dirAbs, dirRel);
    }
    void realRoot;
    return { files, invalidDirs, skipped };
  };

  const scan: VaultService['scan'] = (vault_id) => {
    const t0 = Date.now();
    const vault = mapVault(getVaultRow(vault_id));
    const { files, invalidDirs, skipped } = walkVault(vault);
    const existing = new Map<string, Record<string, unknown>>();
    for (const row of db.prepare('SELECT * FROM vault_notes WHERE vault_id = ?').all(vault_id)) {
      existing.set(String(row.rel_path), row);
    }
    const nowStr = now();
    let updated = 0;
    let unchanged = 0;
    const seen = new Set<string>();
    const upsert = db.prepare(
      `INSERT INTO vault_notes (vault_id, rel_path, title, kind, level, status, frontmatter, file_hash, mtime_ms, size, missing, links_cache, search_text, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT(vault_id, rel_path) DO UPDATE SET
         title = excluded.title, kind = excluded.kind, level = excluded.level, status = excluded.status,
         frontmatter = excluded.frontmatter, file_hash = excluded.file_hash, mtime_ms = excluded.mtime_ms,
         size = excluded.size, missing = 0, links_cache = excluded.links_cache, search_text = excluded.search_text,
         indexed_at = excluded.indexed_at`,
    );
    for (const rel of files) {
      seen.add(rel);
      const abs = resolveInside(vault.root_path, rel);
      const st = statSync(abs);
      const prev = existing.get(rel);
      if (
        prev &&
        Number(prev.mtime_ms) === Math.round(st.mtimeMs) &&
        Number(prev.size) === st.size &&
        Number(prev.missing ?? 0) === 0
      ) {
        unchanged++;
        continue;
      }
      const raw = readFileSync(abs, 'utf8');
      const hash = createHash('sha256').update(raw).digest('hex');
      if (prev && String(prev.file_hash) === hash && Number(prev.missing ?? 0) === 0) {
        // mtime/size 变了但内容一致（touch/重写同内容）：只刷元数据
        upsert.run(
          vault_id, rel, String(prev.title), String(prev.kind), prev.level as string | null, prev.status as string | null,
          String(prev.frontmatter), hash, Math.round(st.mtimeMs), st.size, String(prev.links_cache),
          String(prev.search_text), nowStr,
        );
        unchanged++;
        continue;
      }
      const { frontmatter, body } = parseFrontmatter(raw);
      const fmTitle = typeof frontmatter.title === 'string' ? frontmatter.title : '';
      const title = fmTitle || rel.split('/').pop()!.replace(/\.md$/i, '');
      const tags = Array.isArray(frontmatter.tags) ? (frontmatter.tags as string[]).join(' ') : '';
      const links = JSON.stringify(extractWikiLinks(body));
      const search = `${title}\n${rel}\n${tags}\n${body}`.slice(0, SEARCH_TEXT_CAP).toLowerCase();
      upsert.run(
        vault_id, rel, title, deriveKind(rel), deriveLevel(rel),
        typeof frontmatter.status === 'string' ? frontmatter.status : null,
        JSON.stringify(frontmatter), hash, Math.round(st.mtimeMs), st.size, links, search, nowStr,
      );
      updated++;
    }
    // 磁盘消失：标 missing，保留记录与关联
    let missing = 0;
    const markMissing = db.prepare('UPDATE vault_notes SET missing = 1 WHERE vault_id = ? AND rel_path = ?');
    for (const [rel, row] of existing) {
      if (!seen.has(rel) && Number(row.missing ?? 0) === 0) {
        markMissing.run(vault_id, rel);
        missing++;
      }
    }
    // 之前缺失、现在又在盘上的文件由 upsert 重置 missing=0（上面的 ON CONFLICT 已置 0）
    const stats: VaultScanStats = {
      discovered: files.length,
      updated,
      unchanged,
      missing,
      skipped,
      invalid_dirs: invalidDirs,
      duration_ms: Date.now() - t0,
    };
    db.prepare('UPDATE vaults SET last_scan_at = ?, last_scan_stats = ?, updated_at = ? WHERE id = ?').run(
      nowStr, JSON.stringify(stats), nowStr, vault_id,
    );
    return stats;
  };

  const resolveLinksFor = (vault_id: number, rawTargets: string[]): VaultNoteLink[] => {
    const notes = db
      .prepare('SELECT id, rel_path, title, missing FROM vault_notes WHERE vault_id = ?')
      .all(vault_id)
      .map((r) => ({
        rel_path: String(r.rel_path),
        title: String(r.title),
        missing: Number(r.missing ?? 0) === 1,
      }));
    return rawTargets.map((target) => {
      const base = target.split('#')[0];
      // 1) 精确相对路径（补 .md 后缀）
      const byPath = notes.filter(
        (n) => !n.missing && (n.rel_path === base || n.rel_path === `${base}.md`),
      );
      const asResolved = (n: { rel_path: string; title: string }) => ({ vault_id, rel_path: n.rel_path, title: n.title });
      if (byPath.length === 1) return { raw_target: target, resolved: asResolved(byPath[0]), candidates: [] };
      // 2) 同名候选（含多义）
      const byTitle = notes.filter((n) => !n.missing && n.title === base);
      const pool = byPath.length > 0 ? byPath : byTitle;
      if (pool.length === 1) return { raw_target: target, resolved: asResolved(pool[0]), candidates: [] };
      return {
        raw_target: target,
        resolved: null,
        candidates: pool.slice(0, 5).map((n) => ({ vault_id, rel_path: n.rel_path, title: n.title })),
      };
    });
  };

  const getNote: VaultService['getNote'] = (vault_id, rel_path) => {
    const vault = mapVault(getVaultRow(vault_id));
    const row = db
      .prepare('SELECT * FROM vault_notes WHERE vault_id = ? AND rel_path = ?')
      .get(vault_id, rel_path);
    const abs = resolveInside(vault.root_path, rel_path);
    const raw = readFileSync(abs, 'utf8');
    const hash = createHash('sha256').update(raw).digest('hex');
    const { frontmatter, body } = parseFrontmatter(raw);
    const note: VaultNote = row
      ? mapNote({ ...row, file_hash: hash, frontmatter: JSON.stringify(frontmatter) })
      : {
          id: 0,
          vault_id,
          rel_path,
          title: typeof frontmatter.title === 'string' ? frontmatter.title : rel_path.split('/').pop()!.replace(/\.md$/i, ''),
          kind: deriveKind(rel_path),
          level: deriveLevel(rel_path),
          status: typeof frontmatter.status === 'string' ? frontmatter.status : null,
          frontmatter,
          file_hash: hash,
          mtime_ms: 0,
          size: Buffer.byteLength(raw),
          missing: false,
          indexed_at: now(),
        };
    const rawTargets = extractWikiLinks(body);
    const links = resolveLinksFor(vault_id, rawTargets);
    const myTitles = new Set<string>([note.title, rel_path, rel_path.replace(/\.md$/i, '')]);
    const backlinks = db
      .prepare("SELECT rel_path, title, links_cache FROM vault_notes WHERE vault_id = ? AND missing = 0")
      .all(vault_id)
      .filter((r) => {
        try {
          const ls = JSON.parse(String(r.links_cache ?? '[]')) as string[];
          return ls.some((t) => myTitles.has(t.split('#')[0].split('|')[0].trim()));
        } catch {
          return false;
        }
      })
      .map((r) => ({ vault_id, rel_path: String(r.rel_path), title: String(r.title) }));
    const concept_links = db
      .prepare('SELECT * FROM vault_concept_links WHERE note_id = ? ORDER BY id')
      .all(note.id)
      .map((r) => ({
        id: Number(r.id),
        vault_id: Number(r.vault_id),
        note_id: Number(r.note_id),
        knowledge_key: String(r.knowledge_key),
        created_at: String(r.created_at),
      }));
    return {
      note,
      markdown: body,
      html: renderMarkdownHtml(body),
      stale: !!row && String(row.file_hash) !== hash,
      links,
      backlinks,
      concept_links,
    };
  };

  return {
    register({ root_path, name, include_dirs, include_raw }) {
      const abs = resolve(root_path);
      let st;
      try {
        st = statSync(abs);
      } catch {
        throw new Error(`目录不存在：${root_path}`);
      }
      if (!st.isDirectory()) throw new Error(`不是目录：${root_path}`);
      const real = realpathSync(abs);
      const dup = db.prepare('SELECT id FROM vaults WHERE root_path = ?').get(real);
      if (dup) throw new Error(`该目录已注册为知识库（id=${dup.id}），如需调整请直接编辑其设置`);
      const dirs = include_dirs && include_dirs.length > 0 ? include_dirs : VAULT_DEFAULT_INCLUDE_DIRS;
      for (const d of dirs) {
        if (!isSafeVaultRelPath(d)) throw new Error(`include_dirs 含不安全路径：${d}`);
      }
      const nowStr = now();
      const r = db
        .prepare(
          'INSERT INTO vaults (name, root_path, include_dirs, include_raw, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          name?.trim() || real.split('/').pop() || '知识库',
          real,
          JSON.stringify(dirs),
          include_raw ? 1 : 0,
          nowStr,
          nowStr,
        );
      return mapVault(getVaultRow(Number(r.lastInsertRowid)));
    },

    list() {
      return db.prepare('SELECT * FROM vaults ORDER BY id').all().map(mapVault);
    },

    update(id, patch) {
      getVaultRow(id);
      const cur = mapVault(getVaultRow(id));
      const name = patch.name?.trim() || cur.name;
      const dirs = patch.include_dirs ?? cur.include_dirs;
      for (const d of dirs) {
        if (!isSafeVaultRelPath(d)) throw new Error(`include_dirs 含不安全路径：${d}`);
      }
      db.prepare('UPDATE vaults SET name = ?, include_dirs = ?, include_raw = ?, updated_at = ? WHERE id = ?').run(
        name,
        JSON.stringify(dirs),
        (patch.include_raw ?? cur.include_raw) ? 1 : 0,
        now(),
        id,
      );
      return mapVault(getVaultRow(id));
    },

    remove(id) {
      getVaultRow(id);
      db.prepare('DELETE FROM vaults WHERE id = ?').run(id);
    },

    scan,

    listNotes(filters = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filters.vault_id !== undefined) {
        where.push('n.vault_id = ?');
        params.push(filters.vault_id);
      }
      if (filters.kind && filters.kind !== 'all') {
        where.push('n.kind = ?');
        params.push(filters.kind);
      }
      if (filters.level && filters.level !== 'all') {
        where.push('n.level = ?');
        params.push(filters.level);
      }
      if (filters.status) {
        where.push('n.status = ?');
        params.push(filters.status);
      }
      if (filters.missing !== undefined) {
        where.push('n.missing = ?');
        params.push(filters.missing ? 1 : 0);
      }
      if (filters.search?.trim()) {
        where.push('n.search_text LIKE ?');
        params.push(`%${filters.search.trim().toLowerCase()}%`);
      }
      const limit = Math.max(1, Math.min(filters.limit ?? 200, 1000));
      const sql = `SELECT n.*, v.name AS vault_name FROM vault_notes n JOIN vaults v ON v.id = n.vault_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY n.missing ASC, n.kind ASC, n.rel_path ASC LIMIT ${limit}`;
      return db.prepare(sql).all(...params).map((r) => ({ ...mapNote(r), vault_name: String(r.vault_name) }));
    },

    getNote,

    linkConcept({ vault_id, rel_path, knowledge_key }) {
      const key = knowledge_key.trim();
      if (!key) throw new Error('knowledge_key 不能为空');
      let row = db.prepare('SELECT * FROM vault_notes WHERE vault_id = ? AND rel_path = ?').get(vault_id, rel_path);
      if (!row) {
        // 未入索引也能关联：先确认文件真实存在（防指向任意路径）
        resolveInside(mapVault(getVaultRow(vault_id)).root_path, rel_path);
        getNote(vault_id, rel_path); // 触发一次完整读取校验
        row = db.prepare('SELECT * FROM vault_notes WHERE vault_id = ? AND rel_path = ?').get(vault_id, rel_path);
        if (!row) throw new Error('关联失败：笔记读取正常但未能入索引，请先扫描');
      }
      const dup = db
        .prepare('SELECT id FROM vault_concept_links WHERE note_id = ? AND knowledge_key = ?')
        .get(Number(row.id), key);
      if (dup) throw new Error(`该概念已关联此卡片（link_id=${dup.id}），请勿重复关联`);
      const r = db
        .prepare('INSERT INTO vault_concept_links (vault_id, note_id, knowledge_key, created_at) VALUES (?, ?, ?, ?)')
        .run(vault_id, Number(row.id), key, now());
      const out = db.prepare('SELECT * FROM vault_concept_links WHERE id = ?').get(Number(r.lastInsertRowid))!;
      return {
        id: Number(out.id),
        vault_id: Number(out.vault_id),
        note_id: Number(out.note_id),
        knowledge_key: String(out.knowledge_key),
        created_at: String(out.created_at),
      };
    },

    unlinkConcept(link_id) {
      const r = db.prepare('DELETE FROM vault_concept_links WHERE id = ?').run(link_id);
      if (r.changes === 0) throw new Error(`概念关联不存在：${link_id}`);
    },

    listConceptLinks(filter = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.knowledge_key) {
        where.push('knowledge_key = ?');
        params.push(filter.knowledge_key);
      }
      if (filter.note_id !== undefined) {
        where.push('note_id = ?');
        params.push(filter.note_id);
      }
      const rows = db
        .prepare(`SELECT * FROM vault_concept_links ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`)
        .all(...params);
      return rows.map((r) => ({
        id: Number(r.id),
        vault_id: Number(r.vault_id),
        note_id: Number(r.note_id),
        knowledge_key: String(r.knowledge_key),
        created_at: String(r.created_at),
      }));
    },

    noteAbsolutePath(vault_id, rel_path) {
      const vault = mapVault(getVaultRow(vault_id));
      return resolveInside(vault.root_path, rel_path);
    },

    isPathInsideAnyVault(absDir) {
      const target = realPathOfMaybeMissing(absDir);
      for (const v of db.prepare('SELECT root_path FROM vaults').all()) {
        const rootReal = realPathOfMaybeMissing(String(v.root_path));
        if (target === rootReal || target.startsWith(rootReal + sep)) return true;
      }
      return false;
    },
  };
}
