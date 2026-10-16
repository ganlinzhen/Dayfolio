// 运行时日程底座的增量结构；只由版本化迁移调用，不在工具安装时执行 DDL。
import type { DbAdapter } from '../db';

export function migrateRuntimeSchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS extensions (
      id TEXT PRIMARY KEY, origin_key TEXT NOT NULL UNIQUE, active_release_id TEXT REFERENCES extension_releases(id),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','uninstalled')),
      revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS extension_releases (
      id TEXT PRIMARY KEY, extension_id TEXT NOT NULL REFERENCES extensions(id), version TEXT NOT NULL,
      digest TEXT NOT NULL, manifest_json TEXT NOT NULL, relative_dir TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'prepared', created_at TEXT NOT NULL, UNIQUE(extension_id,version)
    );
    CREATE TABLE IF NOT EXISTS extension_grants (
      extension_id TEXT NOT NULL REFERENCES extensions(id), capability TEXT NOT NULL, scope TEXT NOT NULL,
      grant_revision INTEGER NOT NULL DEFAULT 1, authorization_digest TEXT NOT NULL,
      PRIMARY KEY(extension_id,capability,scope)
    );
    CREATE TABLE IF NOT EXISTS extension_operations (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, extension_id TEXT NOT NULL, base_revision INTEGER,
      target_digest TEXT NOT NULL, phase TEXT NOT NULL, lease_owner TEXT, lease_expires_at TEXT,
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS calendar_collections (
      id TEXT PRIMARY KEY, owner_extension_id TEXT REFERENCES extensions(id), title TEXT NOT NULL,
      color TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS calendar_collection_preferences (
      collection_id TEXT PRIMARY KEY REFERENCES calendar_collections(id), visible INTEGER NOT NULL CHECK(visible IN (0,1)), updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_providers (
      id TEXT PRIMARY KEY, extension_id TEXT NOT NULL REFERENCES extensions(id),
      collection_id TEXT NOT NULL REFERENCES calendar_collections(id), kind TEXT NOT NULL CHECK(kind IN ('import','http-json')),
      config_json TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS external_events (
      id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES event_providers(id), external_id TEXT NOT NULL,
      title TEXT NOT NULL, time_kind TEXT NOT NULL CHECK(time_kind IN ('timed','all_day','tbd')),
      start_at TEXT, end_at TEXT, start_date TEXT, end_date_exclusive TEXT, source_timezone TEXT,
      status TEXT NOT NULL CHECK(status IN ('scheduled','postponed','cancelled','finished')),
      source_url TEXT NOT NULL, payload_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(provider_id,external_id)
    );
    CREATE TABLE IF NOT EXISTS event_subscriptions (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES external_events(id),
      todo_id INTEGER UNIQUE REFERENCES todos(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK(status IN ('active','unsubscribed')),
      sync_mode TEXT NOT NULL CHECK(sync_mode IN ('follow','manual')),
      applied_event_revision INTEGER NOT NULL, last_applied_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_sync_runs (
      id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES event_providers(id), batch_id TEXT,
      base_revision INTEGER NOT NULL, lease_token TEXT, fencing_generation INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT, status TEXT NOT NULL, input_digest TEXT NOT NULL,
      result_json TEXT, error TEXT, created_at TEXT NOT NULL, finished_at TEXT,
      UNIQUE(provider_id,batch_id)
    );
    CREATE TABLE IF NOT EXISTS runtime_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0, contract_major INTEGER NOT NULL DEFAULT 1);
    INSERT OR IGNORE INTO runtime_revision(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS runtime_settings (id INTEGER PRIMARY KEY CHECK(id=1), display_timezone TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_events_provider_time ON external_events(provider_id,start_at,start_date);
    CREATE INDEX IF NOT EXISTS idx_events_status ON external_events(status,archived);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_todo ON event_subscriptions(todo_id);
    CREATE INDEX IF NOT EXISTS idx_sync_provider_status ON provider_sync_runs(provider_id,status);
    CREATE INDEX IF NOT EXISTS idx_operations_phase ON extension_operations(phase,lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_collections_order ON calendar_collections(sort_order,id);
  `);
  db.prepare('INSERT OR IGNORE INTO runtime_settings(id,display_timezone) VALUES(1,?)').run(Intl.DateTimeFormat().resolvedOptions().timeZone);
  for (const [id, title, color, order] of [['builtin.todo', '基础待办', 'blue', 0], ['builtin.study', '学习计划', 'green', 1], ['builtin.local', '本地日程', 'violet', 2]]) {
    db.prepare('INSERT OR IGNORE INTO calendar_collections(id,title,color,sort_order) VALUES(?,?,?,?)').run(id, title, color, order);
  }
  const cols = new Set(db.prepare('PRAGMA table_info(todos)').all().map(c => String(c.name)));
  for (const [name, type] of Object.entries({ collection_id: 'TEXT REFERENCES calendar_collections(id)', end_date: 'TEXT', time_mode: "TEXT NOT NULL DEFAULT 'floating' CHECK(time_mode IN ('floating','instant'))", scheduled_start_at: 'TEXT', scheduled_end_at: 'TEXT', revision: 'INTEGER NOT NULL DEFAULT 1' })) {
    if (!cols.has(name)) db.exec(`ALTER TABLE todos ADD COLUMN ${name} ${type}`);
  }
  const calCols = db.prepare('PRAGMA table_info(calendar_events)').all();
  if (!calCols.some(c => c.name === 'collection_id')) db.exec('ALTER TABLE calendar_events ADD COLUMN collection_id TEXT REFERENCES calendar_collections(id)');
  // 行修订也覆盖本体允许的用户扩展字段写入；服务会先跳过无实质变化的普通更新。
  db.exec(`CREATE TRIGGER IF NOT EXISTS todo_row_revision AFTER UPDATE ON todos
    WHEN NEW.revision=OLD.revision BEGIN UPDATE todos SET revision=OLD.revision+1 WHERE id=NEW.id; END;`);
  for (const table of ['todos', 'checkins', 'extension_grants', 'plan_items', 'study_plans', 'calendar_events', 'extensions', 'calendar_collections', 'calendar_collection_preferences', 'event_providers', 'external_events', 'event_subscriptions', 'runtime_settings']) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS revision_${table}_${operation} AFTER ${operation} ON ${table} BEGIN UPDATE runtime_revision SET revision=revision+1 WHERE id=1; END;`);
  }
}
