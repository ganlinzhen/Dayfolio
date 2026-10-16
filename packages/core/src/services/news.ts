// 新闻服务（agent-only，2026-10-11 起）：
// App 与本地进程不再抓取 RSS、不管理新闻源与任何凭证、不运行定时抓取；
// 新闻生产唯一入口是「新闻任务」——agent 经 MCP 认领待执行任务，自行搜索、核实后
// 提交带原始来源链接与摘要的条目。所有写入口做硬校验：
// 任务状态 / 认领令牌 / 认领时间窗 / 条数预算 / 来源 URL / 事件去重 / 字段参数；
// 预算按任务累计（跨批次与重试最多 max_items 条新入库，重复提交不能绕过）。
// 旧新闻与收藏（is_starred）只读保留，展示不受预算限制。
// 内容形态（2026-10-13）：'url'=详情页内嵌来源网页（默认）；'html'=本地快照——
// X/Twitter 等无法内嵌的来源，agent 提交可选 html 字段，消毒后写入 dirname(db)/news。
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { DbAdapter } from '../db';
import { mapNews } from '../db';
import type { NewsDeleteResult, NewsItem, NewsSubmissionItem, NewsTask } from '../types';
import { newsDedupKey } from '../utils/news-dedup';
import { addDays, isoAfter, nowIso, todayStr } from '../utils/date';

// ---------- 授权约束常量（用户 2026-10-11 批准，测试共用引用） ----------

/** 每个任务「新入库」条数硬上限（跨批次与重试累计；历史展示不受此限） */
export const NEWS_TASK_MAX_ITEMS = 10;
/** 单次提交的条数上限（一次 submit_news_items 最多多少条） */
export const NEWS_SUBMIT_BATCH_MAX = 10;
/** 认领租约时长（毫秒）：到期未提交即失效，任务可被重新认领（跨批次接力） */
export const NEWS_TASK_LEASE_MS = 30 * 60_000;
/** 未终结（pending/claimed）任务数上限，防无限堆积 */
export const NEWS_TASK_MAX_OPEN = 50;
/** 任务时间窗默认值：只接受最近 24 小时内发布的新闻 */
export const NEWS_TASK_WINDOW_DEFAULT_HOURS = 24;
/** 任务时间窗允许范围（小时） */
export const NEWS_TASK_WINDOW_MIN_HOURS = 1;
export const NEWS_TASK_WINDOW_MAX_HOURS = 720;
/** 单条本地 HTML 快照的最大字符数（消毒前；足够容纳整页推文/长文快照） */
export const NEWS_HTML_MAX_CHARS = 1_000_000;
/** 本地快照目录名：位于 dirname(db)/news（与 tools/courses 同一应用数据推导规则） */
export const NEWS_DIR_NAME = 'news';

/** 本地快照根目录：dirname(db)/news（App 的 news-file:// 协议与 MCP 共用同一推导） */
export function newsRootForDb(dbPath: string): string {
  return join(resolve(dbPath, '..'), NEWS_DIR_NAME);
}

/** 快照相对路径 → 绝对路径（仅允许 news 根目录内的单段安全文件名，防路径逃逸） */
function htmlAbsPath(root: string, htmlRel: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.html?$/i.test(htmlRel)) throw new Error(`快照路径不安全：${htmlRel}`);
  const abs = resolve(root, htmlRel);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`快照路径越界：${htmlRel}`);
  return abs;
}

/** 快照 HTML 消毒：剥离脚本与危险属性、中和危险属性与协议；**保留 https 外链图片**
 *  （推文配图在 pbs.twimg.com 等图床上，必须远程加载才能展示）。App 侧 iframe 渲染，双重防线。 */
const SAFE_URL_PREFIXES = ['#', '/', './', '../', 'https://', 'http://', 'mailto:'];
export function sanitizeNewsHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?<\/embed>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*>/gi, '')
    // 事件属性 on*="..."
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // href/src 只放行白名单协议/相对地址（javascript:/data:/file:/协议相对 // 等一律中和为 #）
    .replace(/\s(href|src)\s*=\s*(["'])([^"']*)\2/gi, (m, attr: string, quote: string, rawUrl: string) => {
      const u = rawUrl.trim().toLowerCase();
      return SAFE_URL_PREFIXES.some((p) => u.startsWith(p)) ? m : ` ${attr}=${quote}#${quote}`;
    })
    .replace(/\ssrcset\s*=\s*(["'])[^"']*\1/gi, '')
    // 内联 style 中的 expression/url(javascript:)
    .replace(/style\s*=\s*(["'])\s*[^"']*(?:expression|javascript:)[^"']*\1/gi, '');
}

/** 保证快照是自带 UTF-8 声明的完整文档（自定义协议响应头不带 charset，靠 meta 兜底，防中文乱码） */
export function ensureStandaloneNewsHtml(html: string, title: string): string {
  const safeTitle = title.replace(/</g, '&lt;').slice(0, 120);
  if (/<html[\s>]/i.test(html)) {
    return /<meta[^>]+charset/i.test(html)
      ? html
      : html.replace(/<head([^>]*)>/i, `<head$1><meta charset="utf-8">`);
  }
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 20px 24px 40px; font: 15px/1.75 -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; color: #1a1a1a; background: #fff; }
  img, video { max-width: 100%; height: auto; border-radius: 10px; }
  a { color: #0b57d0; }
</style>
</head>
<body>
${html}
</body>
</html>`;
}

/** 精确发布时间（ISO）→ 北京时间日期 YYYY-MM-DD（供展示与「今天」判定） */
export function beijingDateOf(iso: string): string {
  return new Date(new Date(iso).getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 保守同事件归一：去链接/@提及/空白与标点后小写——**完全一致**才视为同事件。
 *  与既有 dedup 哲学一致：不确定（归一后不同）一律不并，宁可保留。 */
export function normalizeNewsEventTitle(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\uFF08(]?https?\/\/[^\s)]*[\uFF09)]?/g, '')
    .replace(/@[^\s@\p{P}\p{S}]+/gu, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 剥离控制字符（保留换行转空格）：标题/摘要/名称入库前的统一清洗 */
function sanitizeText(s: unknown): string {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .trim();
}

/** 删除指纹：只存带类型前缀的 sha256 哈希——不含明文正文、标题或 URL，不可反推内容。
 *  link=按 dedup_key（规范链接身份）防同链接回流；event=按归一化标题防同事件回流。 */
function deletedFingerprint(kind: 'link' | 'event', value: string): string {
  return `${kind}:${createHash('sha256').update(value).digest('hex')}`;
}

/** 安全来源 URL：仅 http(s)、host 含点、拒绝本地/内网地址（javascript:/data: 等一律拒绝） */
export function validateSourceUrl(raw: string): string {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('来源链接不能为空（必须是原始来源网页的 http(s) 地址）');
  if (s.length > 2048) throw new Error('来源链接过长（>2048 字符）');
  if (/\s/.test(s)) throw new Error('来源链接不能包含空白字符');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`来源链接无效：${s.slice(0, 80)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('来源链接仅支持 http(s)');
  const host = u.hostname.toLowerCase();
  if (!host.includes('.')) throw new Error('来源链接主机名无效（须为真实域名）');
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^(10\.|127\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error('来源链接不能指向本地/内网地址');
  }
  return u.toString();
}

/** 跨进程原子段：BEGIN IMMEDIATE 立即取写锁（认领/提交的并发边界） */
function immediateTx<T>(db: DbAdapter, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 保留原始错误 */
    }
    throw e;
  }
}

export function createNewsService(db: DbAdapter, opts: { dbPath?: string; leaseMs?: number } = {}) {
  const LEASE_MS = Math.max(opts.leaseMs ?? NEWS_TASK_LEASE_MS, 1);
  const leaseUntil = (): string => isoAfter(LEASE_MS);
  // 本地快照根目录：必须从数据库路径推导（App 与 MCP 共用；缺省交给 createCore 传真实路径）
  const htmlRoot = opts.dbPath ? newsRootForDb(opts.dbPath) : null;

  const taskRow = (id: number): Record<string, unknown> | undefined =>
    db.prepare('SELECT * FROM news_tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;

  const mapTask = (r: Record<string, unknown>): NewsTask => {
    const inserted = Number(
      (db.prepare('SELECT COUNT(*) AS n FROM news WHERE task_id = ?').get(r.id) as { n: number }).n,
    );
    // 历史累计收录数：v11 起由提交时递增维护（迁移已按存量回填）；与现存计数取大兜底防漂移
    const accepted = Math.max(Number(r.accepted_count ?? 0), inserted);
    const maxItems = Number(r.max_items);
    return {
      id: Number(r.id),
      title: String(r.title),
      instructions: String(r.instructions ?? ''),
      max_items: maxItems,
      window_hours: Number(r.window_hours),
      status: r.status as NewsTask['status'],
      created_by: String(r.created_by ?? ''),
      claimed_by: (r.claimed_by as string | null) ?? null,
      claim_expires_at: (r.claim_expires_at as string | null) ?? null,
      attempts: Number(r.attempts ?? 0),
      inserted_count: inserted,
      accepted_count: accepted,
      remaining: Math.max(maxItems - accepted, 0),
      completed_at: (r.completed_at as string | null) ?? null,
      completed_note: (r.completed_note as string | null) ?? null,
      last_error: (r.last_error as string | null) ?? null,
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    };
  };

  /** 任务可被认领的条件：待执行，或认领租约已过期（执行方失联后跨批次接力） */
  const claimable = (status: string, expiresAt: string | null, now: string): boolean =>
    status === 'pending' || (status === 'claimed' && expiresAt != null && expiresAt <= now);

  // ---------- 任务：创建 / 查询 ----------

  const createTask = (
    input: { title: string; instructions?: string; max_items?: number; window_hours?: number },
    createdBy = 'mcp',
  ): NewsTask => {
    const title = sanitizeText(input.title);
    if (!title) throw new Error('任务标题不能为空');
    if (title.length > 200) throw new Error('任务标题过长（≤200 字）');
    const instructions = sanitizeText(input.instructions ?? '');
    if (instructions.length > 2000) throw new Error('任务规则说明过长（≤2000 字）');
    const maxItems = input.max_items ?? NEWS_TASK_MAX_ITEMS;
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > NEWS_TASK_MAX_ITEMS) {
      throw new Error(`每任务新入库上限须为 1~${NEWS_TASK_MAX_ITEMS} 的整数`);
    }
    const windowHours = input.window_hours ?? NEWS_TASK_WINDOW_DEFAULT_HOURS;
    if (!Number.isInteger(windowHours) || windowHours < NEWS_TASK_WINDOW_MIN_HOURS || windowHours > NEWS_TASK_WINDOW_MAX_HOURS) {
      throw new Error(`任务时间窗须为 ${NEWS_TASK_WINDOW_MIN_HOURS}~${NEWS_TASK_WINDOW_MAX_HOURS} 小时的整数`);
    }
    const open = db
      .prepare("SELECT COUNT(*) AS n FROM news_tasks WHERE status IN ('pending', 'claimed')")
      .get() as { n: number };
    if (Number(open.n) >= NEWS_TASK_MAX_OPEN) {
      throw new Error(`未终结的新闻任务已达上限（${NEWS_TASK_MAX_OPEN}）：请先完成/取消现有任务`);
    }
    const now = nowIso();
    const res = db
      .prepare('INSERT INTO news_tasks (title, instructions, max_items, window_hours, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(title, instructions, maxItems, windowHours, 'pending', sanitizeText(createdBy) || 'mcp', now, now);
    return mapTask(taskRow(Number(res.lastInsertRowid))!);
  };

  const getTask = (id: number): NewsTask => {
    const row = taskRow(Number(id));
    if (!row) throw new Error(`新闻任务 ${id} 不存在`);
    return mapTask(row);
  };

  const listTasks = (filter: { status?: NewsTask['status']; limit?: number } = {}): NewsTask[] => {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const rows = filter.status
      ? db.prepare('SELECT * FROM news_tasks WHERE status = ? ORDER BY id DESC LIMIT ?').all(filter.status, limit)
      : db.prepare('SELECT * FROM news_tasks ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map((r) => mapTask(r as Record<string, unknown>));
  };

  // ---------- 任务：认领 / 提交 / 完成 / 释放 / 取消 ----------

  /** 认领待执行任务（缺省取最早的待执行/租约过期任务）。原子段内完成认领条件检查与 CAS 写入，
   *  两个进程同时认领同一任务只会有一个成功。返回的 claim_token 是后续提交/完成/释放的凭证。 */
  const claimTask = (taskId?: number, claimedBy = 'agent'): { task: NewsTask; claim_token: string; claim_expires_at: string; lease_minutes: number } => {
    const by = sanitizeText(claimedBy) || 'agent';
    if (by.length > 80) throw new Error('认领者标识过长（≤80 字）');
    return immediateTx(db, () => {
      const now = nowIso();
      const row = taskId != null
        ? taskRow(Number(taskId))
        : (db
            .prepare("SELECT * FROM news_tasks WHERE status = 'pending' OR (status = 'claimed' AND claim_expires_at <= ?) ORDER BY id LIMIT 1")
            .get(now) as Record<string, unknown> | undefined);
      if (!row) throw new Error(taskId != null ? `新闻任务 ${taskId} 不存在` : '当前没有可认领的待执行新闻任务');
      if (!claimable(String(row.status), (row.claim_expires_at as string | null) ?? null, now)) {
        throw new Error(
          String(row.status) === 'claimed'
            ? `任务 #${row.id} 已被「${row.claimed_by ?? '未知'}」认领且租约未到期（${row.claim_expires_at}），请勿重复执行`
            : `任务 #${row.id} 已${String(row.status) === 'completed' ? '完成' : '取消'}，不可认领`,
        );
      }
      const token = randomUUID();
      const expires = leaseUntil();
      const res = db
        .prepare(
          `UPDATE news_tasks SET status = 'claimed', claim_token = ?, claimed_by = ?, claim_expires_at = ?, attempts = attempts + 1, updated_at = ?
           WHERE id = ? AND (status = 'pending' OR (status = 'claimed' AND claim_expires_at <= ?))`,
        )
        .run(token, by, expires, now, Number(row.id), now);
      if (!res.changes) throw new Error('并发冲突：任务刚被其他会话认领，请重新选择任务');
      return { task: mapTask(taskRow(Number(row.id))!), claim_token: token, claim_expires_at: expires, lease_minutes: Math.round(LEASE_MS / 60_000) };
    });
  };

  /** 持有有效认领的校验（供 submit/complete/release 共用；须在原子段内调用） */
  const assertHeldClaim = (taskId: number, claimToken: string): Record<string, unknown> => {
    const row = taskRow(taskId);
    if (!row) throw new Error(`新闻任务 ${taskId} 不存在`);
    const status = String(row.status);
    if (status !== 'claimed') throw new Error(`任务 #${taskId} 状态为 ${status}（非执行中），无有效认领`);
    if (!claimToken || String(row.claim_token ?? '') !== claimToken) throw new Error('认领令牌不匹配：请用 claim_news_task 返回的 claim_token');
    const expiresAt = (row.claim_expires_at as string | null) ?? null;
    if (expiresAt == null || expiresAt <= nowIso()) {
      throw new Error(`认领已过期（${expiresAt ?? '无到期时间'}）：租约超时后任务自动回到待执行，请重新 claim_news_task 接力`);
    }
    return row;
  };

  /** 校验并清洗一条提交（返回可直接入库的字段）；任何一项不合法即抛错（整批拒绝） */
  const validateItem = (raw: NewsSubmissionItem, windowHours: number, now: number, index: number) => {
    const label = `第 ${index + 1} 条`;
    if (raw == null || typeof raw !== 'object') throw new Error(`${label}：不是合法对象`);
    const title = sanitizeText(raw.title);
    if (!title) throw new Error(`${label}：标题不能为空`);
    if (title.length > 300) throw new Error(`${label}：标题过长（≤300 字）`);
    const summary = sanitizeText(raw.summary);
    if (!summary) throw new Error(`${label}：摘要不能为空（须附你核实后的内容摘要，不接受空摘要）`);
    if (summary.length > 2000) throw new Error(`${label}：摘要过长（≤2000 字）`);
    const sourceName = sanitizeText(raw.source_name ?? '');
    if (sourceName.length > 120) throw new Error(`${label}：来源名称过长（≤120 字）`);
    const url = validateSourceUrl(raw.source_url);
    const publishedRaw = String(raw.published_at ?? '').trim();
    if (!publishedRaw) throw new Error(`${label}：缺少发布时间（用来源页面上真实的发布时间，ISO 格式）`);
    const ts = Date.parse(publishedRaw);
    if (Number.isNaN(ts)) throw new Error(`${label}：发布时间无效（${publishedRaw.slice(0, 40)}）`);
    if (ts > now + 5 * 60_000) throw new Error(`${label}：发布时间在未来（不接受未发布/时钟异常的条目）`);
    const windowMs = windowHours * 3600_000;
    if (ts < now - windowMs) throw new Error(`${label}：发布时间超出任务时间窗（任务要求最近 ${windowHours} 小时内）`);
    // 可选本地 HTML 快照：X/Twitter 等无法内嵌展示的来源，把核实到的原文整理成自包含 HTML
    let html: string | null = null;
    if (raw.html != null) {
      const rawHtml = String(raw.html);
      if (!rawHtml.trim()) throw new Error(`${label}：html 快照不能为空字符串（不需要快照就别传该字段）`);
      if (rawHtml.length > NEWS_HTML_MAX_CHARS) throw new Error(`${label}：html 快照过长（>${NEWS_HTML_MAX_CHARS} 字符）`);
      html = ensureStandaloneNewsHtml(sanitizeNewsHtml(rawHtml), title);
    }
    return { title, summary, url, sourceName, publishedAt: new Date(ts).toISOString(), html };
  };

  /** 提交一批新闻（整批原子：任何一条不合法/重复/超预算 → 全部拒绝，绝不部分入库）。
   *  预算 = 该任务已入库条数 + 本批条数 ≤ max_items（跨批次累计，重试不重置）。 */
  const submitItems = (
    taskId: number,
    claimToken: string,
    items: NewsSubmissionItem[],
  ): { task: NewsTask; inserted: number; items: NewsItem[] } => {
    if (!Array.isArray(items) || items.length === 0) throw new Error('提交内容不能为空');
    if (items.length > NEWS_SUBMIT_BATCH_MAX) throw new Error(`单次提交最多 ${NEWS_SUBMIT_BATCH_MAX} 条（收到 ${items.length} 条），请分批`);
    return immediateTx(db, () => {
      const row = assertHeldClaim(Number(taskId), String(claimToken ?? ''));
      const task = mapTask(row);
      const now = Date.now();
      const cleaned = items.map((it, i) => validateItem(it, task.window_hours, now, i));

      // 批内去重：规范 URL 或 归一化标题 完全一致 → 同事件
      const batchUrlKeys = new Set<string>();
      const batchTitleKeys = new Set<string>();
      for (let i = 0; i < cleaned.length; i++) {
        const urlKey = newsDedupKey('generic', cleaned[i].url, '');
        if (batchUrlKeys.has(urlKey)) throw new Error(`第 ${i + 1} 条与本批前面的条目重复（相同来源链接）`);
        batchUrlKeys.add(urlKey);
        const tKey = normalizeNewsEventTitle(cleaned[i].title);
        if (tKey && batchTitleKeys.has(tKey)) throw new Error(`第 ${i + 1} 条与本批前面的条目重复（同事件：归一化标题一致）`);
        if (tKey) batchTitleKeys.add(tKey);
      }
      // 库内去重：同规范 URL（dedup_key）或同事件（归一化标题）已存在 → 拒绝（不占预算，也不允许绕过预算重复入库）
      const existingTitles = new Set<string>();
      for (const r of db.prepare('SELECT title FROM news').all() as Array<{ title: string }>) {
        const k = normalizeNewsEventTitle(String(r.title));
        if (k) existingTitles.add(k);
      }
      for (let i = 0; i < cleaned.length; i++) {
        const urlKey = newsDedupKey('generic', cleaned[i].url, '');
        const dup = db.prepare('SELECT id FROM news WHERE dedup_key = ?').get(urlKey);
        if (dup) throw new Error(`第 ${i + 1} 条已在库中（相同来源链接，news id=${dup.id}），不要重复提交`);
        const tKey = normalizeNewsEventTitle(cleaned[i].title);
        if (tKey && existingTitles.has(tKey)) throw new Error(`第 ${i + 1} 条与库内已有新闻同事件（归一化标题一致），不要重复提交`);
      }
      // 删除指纹（用户删除后防回流）：同链接或同事件命中即拒绝，不给「删了又进来」留通道
      const fpHit = db.prepare('SELECT 1 FROM news_deleted_fingerprints WHERE fingerprint = ?');
      for (let i = 0; i < cleaned.length; i++) {
        const urlKey = newsDedupKey('generic', cleaned[i].url, '');
        if (fpHit.get(deletedFingerprint('link', urlKey))) {
          throw new Error(`第 ${i + 1} 条对应的新闻已被用户删除，不接受相同来源链接重新提交`);
        }
        const tKey = normalizeNewsEventTitle(cleaned[i].title);
        if (tKey && fpHit.get(deletedFingerprint('event', tKey))) {
          throw new Error(`第 ${i + 1} 条与用户已删除的新闻为同一事件，不接受重新提交`);
        }
      }
      // 预算（跨批次累计，按历史累计收录数 accepted_count 计）：整批超限即整体拒绝；删除不返还预算
      if (task.accepted_count + cleaned.length > task.max_items) {
        throw new Error(
          `超出任务预算：任务 #${task.id} 历史已收录 ${task.accepted_count}/${task.max_items} 条（删除不返还），本次提交 ${cleaned.length} 条——请削减后重试`,
        );
      }
      if (cleaned.some((c) => c.html) && !htmlRoot) {
        throw new Error('本地快照未配置存储目录（dbPath），无法提交 html 条目');
      }
      const nowStr = nowIso();
      const insert = db.prepare(
        `INSERT INTO news (source, title, url, summary, published_date, published_at, fetched_at, dedup_key, is_read, is_starred, task_id, source_name, content_kind, html_rel)
         VALUES ('agent', ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
      );
      const inserted: NewsItem[] = [];
      // 先落盘快照文件再入库；后续任一 INSERT 失败则回滚并清理已写文件（不留孤儿快照）
      const written: string[] = [];
      try {
        mkdirSync(htmlRoot!, { recursive: true });
        for (const c of cleaned) {
          const htmlRel = c.html ? `${randomUUID()}.html` : null;
          if (c.html && htmlRel) {
            const abs = htmlAbsPath(htmlRoot!, htmlRel);
            writeFileSync(abs, c.html, 'utf8');
            written.push(abs);
            const res = insert.run(c.title, c.url, c.summary, beijingDateOf(c.publishedAt), c.publishedAt, nowStr, newsDedupKey('generic', c.url, ''), Number(task.id), c.sourceName || null, 'html', htmlRel);
            inserted.push(mapNews(db.prepare('SELECT * FROM news WHERE id = ?').get(res.lastInsertRowid) as Record<string, unknown>));
          } else {
            const res = insert.run(c.title, c.url, c.summary, beijingDateOf(c.publishedAt), c.publishedAt, nowStr, newsDedupKey('generic', c.url, ''), Number(task.id), c.sourceName || null, 'url', null);
            inserted.push(mapNews(db.prepare('SELECT * FROM news WHERE id = ?').get(res.lastInsertRowid) as Record<string, unknown>));
          }
        }
      } catch (e) {
        for (const abs of written) {
          try { unlinkSync(abs); } catch { /* 尽力清理，不掩盖原始错误 */ }
        }
        throw e;
      }
      // 历史累计收录数随提交递增（删除不减）：预算跨批次/跨重试累计的唯一依据
      db.prepare('UPDATE news_tasks SET accepted_count = accepted_count + ?, updated_at = ? WHERE id = ?')
        .run(cleaned.length, nowStr, Number(task.id));
      return { task: mapTask(taskRow(Number(task.id))!), inserted: cleaned.length, items: inserted };
    });
  };

  /** 完成任务（允许 0 条入库：agent 诚实汇报「没有找到合格新闻」也是完成） */
  const completeTask = (taskId: number, claimToken: string, note?: string): NewsTask => {
    const completedNote = sanitizeText(note ?? '');
    if (completedNote.length > 500) throw new Error('完成说明过长（≤500 字）');
    return immediateTx(db, () => {
      const row = assertHeldClaim(Number(taskId), String(claimToken ?? ''));
      const now = nowIso();
      db.prepare(
        "UPDATE news_tasks SET status = 'completed', completed_at = ?, completed_note = ?, claim_token = NULL, claim_expires_at = NULL, claimed_by = NULL, updated_at = ? WHERE id = ?",
      ).run(now, completedNote || null, now, Number(row.id));
      return mapTask(taskRow(Number(row.id))!);
    });
  };

  /** 释放认领：任务回到待执行（下一批次可接力；已入库条数保留计入预算） */
  const releaseTask = (taskId: number, claimToken: string, reason?: string): NewsTask => {
    const why = sanitizeText(reason ?? '');
    if (why.length > 300) throw new Error('释放原因过长（≤300 字）');
    return immediateTx(db, () => {
      const row = taskRow(Number(taskId));
      if (!row) throw new Error(`新闻任务 ${taskId} 不存在`);
      // 过期认领也允许释放（清理现场）；令牌仍须匹配
      if (String(row.status) !== 'claimed') throw new Error(`任务 #${taskId} 状态为 ${row.status}，无认领可释放`);
      if (!claimToken || String(row.claim_token ?? '') !== String(claimToken)) throw new Error('认领令牌不匹配：请用 claim_news_task 返回的 claim_token');
      db.prepare(
        "UPDATE news_tasks SET status = 'pending', claim_token = NULL, claim_expires_at = NULL, claimed_by = NULL, last_error = ?, updated_at = ? WHERE id = ?",
      ).run(why || null, nowIso(), Number(row.id));
      return mapTask(taskRow(Number(row.id))!);
    });
  };

  /** 取消任务（仅待执行或认领已过期；由用户经 agent 明确要求时调用） */
  const cancelTask = (taskId: number): NewsTask => {
    return immediateTx(db, () => {
      const now = nowIso();
      const res = db
        .prepare(
          "UPDATE news_tasks SET status = 'cancelled', claim_token = NULL, claim_expires_at = NULL, claimed_by = NULL, updated_at = ? WHERE id = ? AND (status = 'pending' OR (status = 'claimed' AND claim_expires_at <= ?))",
        )
        .run(now, Number(taskId), now);
      if (!res.changes) {
        const row = taskRow(Number(taskId));
        if (!row) throw new Error(`新闻任务 ${taskId} 不存在`);
        throw new Error(`任务 #${taskId} 当前为 ${String(row.status)}${String(row.status) === 'claimed' ? '（认领未过期）' : ''}，不可取消`);
      }
      return mapTask(taskRow(Number(taskId))!);
    });
  };

  // ---------- 新闻：查询 / 阅读状态（App 展示与 MCP 共读共写） ----------

  /** 行时间戳语义（与 SQL 谓词一致）：优先精确发布时间；旧数据无 published_at 时按北京时间当日末尾（宽松包含，不伪装精确） */
  const ROW_TS_SQL = "julianday(COALESCE(published_at, published_date || 'T23:59:59+08:00'))";

  const list = (opts: { days?: number; source?: string; task_id?: number; search?: string; filter?: 'all' | 'unread' | 'starred'; since?: string; limit?: number; offset?: number } = {}): NewsItem[] => {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (opts.days && opts.days > 0) {
      where.push('published_date >= ?');
      params.push(addDays(todayStr(), -(opts.days - 1)));
    }
    if (opts.source) {
      where.push('source = ?');
      params.push(opts.source);
    }
    if (opts.task_id) {
      where.push('task_id = ?');
      params.push(Number(opts.task_id));
    }
    if (opts.filter === 'unread') where.push('is_read = 0');
    if (opts.filter === 'starred') where.push('is_starred = 1');
    if (opts.search?.trim()) {
      where.push('(title LIKE ? OR summary LIKE ?)');
      const term = `%${opts.search.trim()}%`;
      params.push(term, term);
    }
    if (opts.since) {
      const sinceTs = Date.parse(opts.since);
      if (!Number.isNaN(sinceTs)) {
        // 时间窗谓词下推 SQL：**先筛选再限量**（若 LIMIT 后才在 JS 过滤，排序靠前但不在窗口内的
        // 行会占满名额，把排序靠后的窗口内行挤出结果）。julianday 统一处理 ISO（Z/偏移）与纯日期。
        where.push(`${ROW_TS_SQL} >= julianday(?)`);
        params.push(opts.since);
      }
    }
    params.push(opts.limit && opts.limit > 0 ? opts.limit : 100);
    params.push(opts.offset && opts.offset > 0 ? opts.offset : 0);
    return db
      .prepare(
        `SELECT * FROM news WHERE ${where.join(' AND ')}
         ORDER BY ${ROW_TS_SQL} DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params)
      .map((r) => mapNews(r as Record<string, unknown>));
  };

  /** 已读/收藏（用户操作，持久化；幂等） */
  const markRead = (id: number, read: boolean): NewsItem => {
    if (!db.prepare('UPDATE news SET is_read = ? WHERE id = ?').run(read ? 1 : 0, id).changes) throw new Error(`新闻 ${id} 不存在`);
    return mapNews(db.prepare('SELECT * FROM news WHERE id = ?').get(id) as Record<string, unknown>);
  };
  const markStarred = (id: number, starred: boolean): NewsItem => {
    if (!db.prepare('UPDATE news SET is_starred = ? WHERE id = ?').run(starred ? 1 : 0, id).changes) throw new Error(`新闻 ${id} 不存在`);
    return mapNews(db.prepare('SELECT * FROM news WHERE id = ?').get(id) as Record<string, unknown>);
  };
  /** 全部标记已读（可限定任务或来源视野），返回影响条数 */
  const markAllRead = (scope: { task_id?: number; source?: string } = {}): number => {
    const where: string[] = ['is_read = 0'];
    const params: unknown[] = [];
    if (scope.task_id) {
      where.push('task_id = ?');
      params.push(Number(scope.task_id));
    }
    if (scope.source) {
      where.push('source = ?');
      params.push(scope.source);
    }
    return db.prepare(`UPDATE news SET is_read = 1 WHERE ${where.join(' AND ')}`).run(...params).changes;
  };

  const lastFetchedAt = (): string | null => {
    const row = db.prepare('SELECT MAX(fetched_at) AS m FROM news').get() as { m: string | null } | undefined;
    return row?.m ?? null;
  };

  const countBySource = (): Record<string, number> => {
    const rows = db.prepare('SELECT source, COUNT(*) AS n FROM news GROUP BY source').all() as Array<{ source: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [String(r.source), Number(r.n)]));
  };

  /** 用户手动删除单条新闻（不可恢复；仅用户明确确认后调用）。单事务内完成：
   *  1) 写入最小哈希去重指纹（链接身份 + 事件身份，均 sha256，不含明文正文/标题/URL），
   *     防后续 agent 同链接/同事件立即回流；
   *  2) 清理仅新闻独占的关联：旧版话题链接行随新闻删除；
   *  3) 自媒体选题/素材（media_topics/media_materials）是独立成果：保留行与其来源快照
   *     （source_note 已含标题与链接），仅把失效的 source_news_id 置空；
   *  4) 删除新闻正文行（收藏/已读状态随行消失），本地 HTML 快照文件一并移除（新闻独占资产）。
   *  任务预算按历史累计（accepted_count），删除不返还；幂等：条目不存在时返回 deleted:false。 */
  const deleteItem = (
    id: number,
  ): NewsDeleteResult => {
    return immediateTx(db, () => {
      const numId = Number(id);
      if (!Number.isInteger(numId) || numId <= 0) throw new Error('新闻 id 无效');
      const row = db.prepare('SELECT * FROM news WHERE id = ?').get(numId) as Record<string, unknown> | undefined;
      if (!row) {
        // 幂等：重复删除/并发已删 → 成功返回未删（不报错、不重复计指纹）
        return { deleted: false, id: numId, topic_links_removed: 0, media_refs_cleared: 0, fingerprints_kept: 0, html_removed: 0 };
      }
      const now = nowIso();
      const fps = new Set<string>([deletedFingerprint('link', String(row.dedup_key ?? ''))]);
      const tKey = normalizeNewsEventTitle(String(row.title ?? ''));
      if (tKey) fps.add(deletedFingerprint('event', tKey));
      const insFp = db.prepare('INSERT OR IGNORE INTO news_deleted_fingerprints (fingerprint, deleted_at) VALUES (?, ?)');
      let fingerprintsKept = 0;
      for (const fp of fps) fingerprintsKept += insFp.run(fp, now).changes;
      const topicLinksRemoved = db.prepare('DELETE FROM news_topic_links WHERE news_id = ?').run(numId).changes;
      const mediaRefsCleared =
        db.prepare('UPDATE media_topics SET source_news_id = NULL, updated_at = ? WHERE source_news_id = ?').run(now, numId).changes +
        db.prepare('UPDATE media_materials SET source_news_id = NULL, updated_at = ? WHERE source_news_id = ?').run(now, numId).changes;
      // 本地快照是新闻独占资产：随行删除（事务提交后执行；失败不阻断删除本身）
      const htmlRel = (row.html_rel as string | null) ?? null;
      let htmlRemoved = 0;
      let pendingRemove: string | null = null;
      if (row.content_kind === 'html' && htmlRel && htmlRoot) {
        try {
          pendingRemove = htmlAbsPath(htmlRoot, htmlRel);
        } catch {
          pendingRemove = null; // 路径异常：不删任意文件，行照常删除
        }
      }
      db.prepare('DELETE FROM news WHERE id = ?').run(numId);
      if (pendingRemove) {
        try {
          unlinkSync(pendingRemove);
          htmlRemoved = 1;
        } catch {
          /* 文件缺失/占用：不阻断删除，行已删即可 */
        }
      }
      return { deleted: true, id: numId, topic_links_removed: topicLinksRemoved, media_refs_cleared: mediaRefsCleared, fingerprints_kept: fingerprintsKept, html_removed: htmlRemoved };
    });
  };

  /** 读取一条新闻的本地快照（content_kind='html' 专用；agent 核对与 App 兜底展示共用）。
   *  url 形态返回 html:null；快照文件缺失时 missing:true（不抛错，调用方自行降级）。 */
  const readHtml = (
    id: number,
  ): { id: number; content_kind: 'url' | 'html'; html_rel: string | null; html: string | null; missing: boolean } => {
    const row = db.prepare('SELECT * FROM news WHERE id = ?').get(Number(id)) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`新闻 ${id} 不存在`);
    const htmlRel = (row.html_rel as string | null) ?? null;
    if (row.content_kind !== 'html' || !htmlRel) return { id: Number(id), content_kind: 'url', html_rel: null, html: null, missing: false };
    if (!htmlRoot) throw new Error('本地快照未配置存储目录（dbPath），无法读取');
    let html: string | null = null;
    let missing = true;
    try {
      const abs = htmlAbsPath(htmlRoot, htmlRel);
      if (existsSync(abs)) {
        html = readFileSync(abs, 'utf8');
        missing = false;
      }
    } catch (e) {
      throw new Error(`快照路径不安全或不可读：${htmlRel}（${(e as Error).message}）`);
    }
    return { id: Number(id), content_kind: 'html', html_rel: htmlRel, html, missing };
  };

  return {
    createTask, getTask, listTasks, claimTask, submitItems, completeTask, releaseTask, cancelTask,
    list, markRead, markStarred, markAllRead, deleteItem, readHtml, lastFetchedAt, countBySource,
  };
}

export type NewsService = ReturnType<typeof createNewsService>;
