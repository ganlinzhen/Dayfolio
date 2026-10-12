// 工具箱文件存储（与 Electron 解耦，App 主进程与 MCP Server 共用）
// 文件根目录从数据库路径推导：dirname(dbPath)/tools —— 保证 TODODESK_DB 指向哪里，
// 工具文件就跟随到哪里，App 与 MCP 永远写到同一个目录。
// 文件内容不进库：HTML 及配套资源存放为 tools/<toolId>/<相对路径>，
// 渲染层 iframe 通过 tool-file:// 协议加载。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** 单段文件名清理：去控制字符与路径非法字符；空名回退 index.html */
function sanitizeSegment(seg: string): string {
  return seg.replace(/[\u0000-\u001f<>:"|?*]+/g, '').trim();
}

/** 工具内相对路径清理：保留子目录结构，逐段清洗并拒绝 . / .. 逃逸段 */
export function sanitizeToolPath(name: string): string {
  const segs = name
    .split(/[\\/]+/)
    .map((s) => sanitizeSegment(s))
    .filter((s) => s.length > 0 && s !== '.' && s !== '..');
  if (segs.length === 0) return 'index.html';
  return segs.join('/');
}

/** 兼容旧语义：只取最后一段（平铺文件名） */
export function sanitizeFileName(name: string): string {
  const segs = sanitizeToolPath(name).split('/');
  return segs[segs.length - 1];
}

/** 工具文件根目录：数据库所在目录下的 tools/ */
export function toolsRootForDb(dbPath: string): string {
  return join(dirname(dbPath), 'tools');
}

/** 从一批文件名里挑 HTML 入口：优先 index.html；唯一一个 .html 则用它；多个则报错要求显式指定 */
export function pickEntryFile(names: string[]): string {
  const sanitized = names.map(sanitizeToolPath);
  const index = sanitized.find((n) => n.toLowerCase() === 'index.html');
  if (index) return index;
  const htmls = sanitized.filter((n) => /\.html?$/i.test(n));
  if (htmls.length === 0) throw new Error('文件中缺少 HTML 入口（须至少有一个 .html 文件）');
  if (htmls.length === 1) return htmls[0];
  throw new Error(`有多个 HTML 文件（${htmls.join('、')}），请用 entry_file 指定入口`);
}

/** 写入一个工具的文件集合（files: [{name, contentBase64}]），目标目录 tools/<id>/ 整体重建 */
export function saveToolFilesTo(root: string, toolId: number, files: Array<{ name: string; contentBase64: string }>): void {
  const dir = join(root, String(toolId));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const safe = sanitizeToolPath(f.name);
    const abs = resolve(dir, safe);
    if (!abs.startsWith(dir + sep)) continue; // sanitize 后理论上不可能，双保险
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.from(f.contentBase64, 'base64'));
  }
}

/** 删除工具目录（工具删除时调用；目录不存在时静默） */
export function deleteToolFilesAt(root: string, toolId: number): void {
  rmSync(join(root, String(toolId)), { recursive: true, force: true });
}

/** 单个工具允许的最大文件总量（防 MCP 误把超大目录收进工具箱） */
export const MAX_TOOL_FILES_BYTES = 50 * 1024 * 1024;

const SKIP_FILE = /^(\.|__MACOSX)/;

/**
 * 从本地路径收集工具文件：文件取其文件名，目录递归取相对路径。
 * 跳过点开头文件（.DS_Store 等）与 __MACOSX。返回 base64 文件集合，可直接交给 saveToolFilesTo。
 */
export function collectToolFilesFromPaths(paths: string[]): Array<{ name: string; contentBase64: string }> {
  const out: Array<{ name: string; contentBase64: string }> = [];
  let total = 0;
  const push = (name: string, abs: string) => {
    const buf = readFileSync(abs);
    total += buf.length;
    if (total > MAX_TOOL_FILES_BYTES) {
      throw new Error(`工具文件总量超过上限 ${Math.floor(MAX_TOOL_FILES_BYTES / 1024 / 1024)}MB`);
    }
    out.push({ name, contentBase64: buf.toString('base64') });
  };
  const walk = (dir: string, prefix: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_FILE.test(ent.name)) continue;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) walk(abs, prefix ? `${prefix}/${ent.name}` : ent.name);
      else if (ent.isFile()) push(prefix ? `${prefix}/${ent.name}` : ent.name, abs);
    }
  };
  for (const p of paths) {
    let st;
    try {
      st = statSync(p);
    } catch {
      throw new Error(`路径不存在或不可读：${p}`);
    }
    if (st.isDirectory()) walk(p, '');
    else if (st.isFile()) push(sanitizeToolPath(p).split('/').pop() as string, p);
  }
  if (out.length === 0) throw new Error('没有收集到任何文件（路径列表为空或目录为空）');
  return out;
}

/**
 * 迁移旧工具文件目录（App 启动时调用一次）。
 * 旧位置 userData/tools，新位置由数据库路径推导；默认路径下两者相同，仅在 TODODESK_DB
 * 指向别处时发生实际搬移。逐工具目录合并，不覆盖已存在的同名目录。
 */
export function migrateToolFilesDir(legacyRoot: string, targetRoot: string): void {
  if (resolve(legacyRoot) === resolve(targetRoot)) return;
  if (!existsSync(legacyRoot)) return;
  mkdirSync(targetRoot, { recursive: true });
  let entries: string[] = [];
  try {
    entries = readdirSync(legacyRoot);
  } catch {
    return;
  }
  for (const name of entries) {
    const from = join(legacyRoot, name);
    const to = join(targetRoot, name);
    try {
      if (existsSync(to)) continue;
      renameSync(from, to);
    } catch {
      // 单个目录搬移失败不阻断启动，遗留目录可手动处理
    }
  }
}

/** 相对 root 列出某工具目录下的全部文件（诊断/测试用） */
export function listToolFiles(root: string, toolId: number): string[] {
  const dir = join(root, String(toolId));
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, ent.name);
      if (ent.isDirectory()) walk(abs);
      else out.push(relative(dir, abs).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}
