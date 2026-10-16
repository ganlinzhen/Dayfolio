// 数据库抽象层：App 侧用 better-sqlite3，MCP 侧用 node:sqlite，
// 两个驱动 API 形态接近，这里统一成一个最小适配接口。
import type { CalendarColor, NewsItem, NewsSource, Priority, Todo, TodoStatus } from './types';
import { nowIso, todayStr } from './utils/date';

export interface SqlResult {
  changes: number;
  lastInsertRowid: number;
}

export interface SqlStatement {
  run(...params: unknown[]): SqlResult;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface DbAdapter {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

/** 手写事务（两个驱动都支持 exec BEGIN/COMMIT）。
 *  一律 BEGIN IMMEDIATE：deferred 事务先读后写时，若他进程（App ↔ MCP 共库）在中间提交，
 *  升级写锁会立刻抛 SQLITE_BUSY（快照冲突，busy_timeout 救不了）；立即取写锁则按
 *  busy_timeout 排队等待，是 SQLite 官方推荐的跨进程写法。 */
const transactionDepth = new WeakMap<DbAdapter, number>();
let savepointSequence = 0;
/** 同一连接上的内部组合使用保存点；外层仍持有 BEGIN IMMEDIATE 写锁。 */
export function inTx<T>(db: DbAdapter, fn: () => T): T {
  const depth=transactionDepth.get(db) ?? 0;
  const savepoint=`dayfolio_tx_${++savepointSequence}`;
  db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  transactionDepth.set(db,depth+1);
  try {
    const result=fn();
    db.exec(depth ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
    return result;
  } catch(error) {
    try { db.exec(depth ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK'); if(depth) db.exec(`RELEASE SAVEPOINT ${savepoint}`); } catch { /* 保留原始错误 */ }
    throw error;
  } finally { if(depth) transactionDepth.set(db,depth); else transactionDepth.delete(db); }
}

/** 同一次查询的计数和行列表共享短读快照；不提前取得写锁。 */
export function readSnapshot<T>(db: DbAdapter, fn: () => T): T {
  if (transactionDepth.has(db)) return fn();
  db.exec('BEGIN');
  transactionDepth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 保留原始查询错误 */ }
    throw error;
  } finally {
    transactionDepth.delete(db);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open',
  due_date TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'app',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
CREATE INDEX IF NOT EXISTS idx_todos_due ON todos(due_date);

CREATE TABLE IF NOT EXISTS study_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES study_plans(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  content TEXT NOT NULL,
  item_type TEXT NOT NULL DEFAULT 'learn',
  duration_min INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  todo_id INTEGER REFERENCES todos(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_items_plan ON plan_items(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_items_date ON plan_items(date);

CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_type TEXT NOT NULL,
  ref_id INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(ref_type, ref_id, date)
);
CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins(date);

CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  published_date TEXT NOT NULL,
  published_at TEXT,
  fetched_at TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  task_id INTEGER,
  source_name TEXT,
  content_kind TEXT NOT NULL DEFAULT 'url',
  html_rel TEXT,
  UNIQUE(dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_news_date ON news(published_date);
-- 注：idx_news_read 与 idx_news_task 由迁移创建（旧库 news 表先经迁移补列，SCHEMA 不能提前建索引）

-- 新闻任务（agent-only）：规则 + 认领租约；旧源/话题/采集任务表保留为历史数据，新代码不再读写
CREATE TABLE IF NOT EXISTS news_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  max_items INTEGER NOT NULL DEFAULT 10,
  window_hours INTEGER NOT NULL DEFAULT 24,
  status TEXT NOT NULL DEFAULT 'pending',
  created_by TEXT NOT NULL DEFAULT 'mcp',
  claim_token TEXT,
  claimed_by TEXT,
  claim_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  completed_note TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_news_tasks_status ON news_tasks(status);

-- 删除新闻只留下不可反推正文的去重指纹，防下一次 agent 提交后立即回流。
CREATE TABLE IF NOT EXISTS news_deleted_fingerprints (
  fingerprint TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS news_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  url TEXT,
  last_checked_at TEXT,
  last_error TEXT
);
INSERT OR IGNORE INTO news_sources (id, name, enabled) VALUES ('x', 'X', 1);

CREATE TABLE IF NOT EXISTS news_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES news_sources(id),
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  last_added INTEGER NOT NULL DEFAULT 0,
  UNIQUE(source_id, name)
);
CREATE INDEX IF NOT EXISTS idx_news_topics_source ON news_topics(source_id);

CREATE TABLE IF NOT EXISTS news_topic_links (
  news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  topic_id INTEGER NOT NULL REFERENCES news_topics(id) ON DELETE CASCADE,
  PRIMARY KEY (news_id, topic_id)
);
CREATE INDEX IF NOT EXISTS idx_news_topic_links_topic ON news_topic_links(topic_id);

-- 采集任务（持久共享入口：同范围合并、跨范围排队、租约互斥与崩溃恢复）
CREATE TABLE IF NOT EXISTS news_sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  requested_by TEXT NOT NULL DEFAULT 'app',
  results TEXT NOT NULL DEFAULT '[]',
  fetched INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  failed_topic_ids TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_news_sync_runs_status ON news_sync_runs(status);

CREATE TABLE IF NOT EXISTS tool_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'tool',
  category_id INTEGER REFERENCES tool_categories(id) ON DELETE SET NULL,
  entry_file TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tools_category ON tools(category_id);
`;

/** 初始化数据库：启用 WAL（多进程共享）+ 外键 + 建表 */
export function initDb(db: DbAdapter): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
}

// ---------- 行映射 ----------

export function mapTodo(row: Record<string, unknown>): Todo {
  const status = row.status as TodoStatus;
  const due = (row.due_date as string | null) ?? null;
  let tags: string[] = [];
  try {
    const parsed = JSON.parse((row.tags as string) || '[]');
    if (Array.isArray(parsed)) tags = parsed.map(String);
  } catch {
    tags = [];
  }
  return {
    id: Number(row.id),
    title: String(row.title),
    notes: String(row.notes ?? ''),
    priority: row.priority as Priority,
    status,
    due_date: due,
    start_time: (row.start_time as string | null) ?? null,
    end_time: (row.end_time as string | null) ?? null,
    tags,
    source: String(row.source ?? 'app'),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: (row.completed_at as string | null) ?? null,
    is_overdue: status === 'open' && due !== null && (row.end_time ? `${due}T${row.end_time}` <= nowIso().slice(0, 16) : due < todayStr()),
  };
}

export function mapPlan(row: Record<string, unknown>): StudyPlanRow {
  return {
    id: Number(row.id),
    title: String(row.title),
    goal: String(row.goal ?? ''),
    start_date: String(row.start_date),
    end_date: String(row.end_date),
    status: row.status as 'active' | 'done' | 'archived',
    notes: String(row.notes ?? ''),
    daily_minutes: row.daily_minutes === null || row.daily_minutes === undefined ? null : Number(row.daily_minutes),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export interface StudyPlanRow {
  id: number;
  title: string;
  goal: string;
  start_date: string;
  end_date: string;
  status: 'active' | 'done' | 'archived';
  notes: string;
  daily_minutes: number | null;
  created_at: string;
  updated_at: string;
}

export function mapPlanItem(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    plan_id: Number(row.plan_id),
    date: String(row.date),
    content: String(row.content),
    item_type: row.item_type as 'learn' | 'review' | 'practice' | 'rest',
    duration_min: row.duration_min === null || row.duration_min === undefined ? null : Number(row.duration_min),
    status: row.status as 'pending' | 'done' | 'skipped',
    todo_id: row.todo_id === null || row.todo_id === undefined ? null : Number(row.todo_id),
    knowledge_key: (row.knowledge_key as string | null) ?? null,
    sort_order: Number(row.sort_order ?? 0),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function mapCheckin(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    ref_type: row.ref_type as 'todo' | 'plan_item' | 'day',
    ref_id: Number(row.ref_id ?? 0),
    date: String(row.date),
    note: String(row.note ?? ''),
    created_at: String(row.created_at),
  };
}

export function mapCalendarEvent(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    title: String(row.title),
    date: String(row.date),
    end_date: (row.end_date as string | null) ?? null,
    start_time: (row.start_time as string | null) ?? null,
    end_time: (row.end_time as string | null) ?? null,
    note: String(row.note ?? ''),
    color: row.color as CalendarColor,
    source: row.source === 'mcp' ? 'mcp' as const : 'app' as const,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function mapNews(row: Record<string, unknown>): NewsItem {
  return {
    id: Number(row.id),
    source: row.source as 'x' | 'zhihu_daily' | 'hacker_news' | 'agent' | `rss/${string}`,
    title: String(row.title),
    url: String(row.url),
    summary: String(row.summary ?? ''),
    published_date: String(row.published_date),
    published_at: (row.published_at as string | null) ?? null,
    fetched_at: String(row.fetched_at),
    dedup_key: String(row.dedup_key ?? ''),
    is_read: Number(row.is_read ?? 0) === 1,
    is_starred: Number(row.is_starred ?? 0) === 1,
    task_id: row.task_id == null ? null : Number(row.task_id),
    source_name: (row.source_name as string | null) ?? null,
    content_kind: row.content_kind === 'html' ? 'html' : 'url',
    html_rel: (row.html_rel as string | null) ?? null,
  };
}

export function mapToolCategory(row: Record<string, unknown>): ToolCategoryRow {
  return {
    id: Number(row.id),
    name: String(row.name),
    sort_order: Number(row.sort_order ?? 0),
    created_at: String(row.created_at),
  };
}

export interface ToolCategoryRow {
  id: number;
  name: string;
  sort_order: number;
  created_at: string;
}

export function mapTool(row: Record<string, unknown>): ToolItemRow {
  return {
    id: Number(row.id),
    title: String(row.title),
    icon: String(row.icon ?? 'tool'),
    category_id: row.category_id === null || row.category_id === undefined ? null : Number(row.category_id),
    entry_file: String(row.entry_file),
    sort_order: Number(row.sort_order ?? 0),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export interface ToolItemRow {
  id: number;
  title: string;
  icon: string;
  category_id: number | null;
  entry_file: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}
