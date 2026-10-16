// 版本化迁移：PRAGMA user_version 驱动，顺序执行未跑过的迁移（只进不改）。
// 弥补裸 CREATE TABLE IF NOT EXISTS 无法做列级变更的结构性缺口。
import { inTx, type DbAdapter } from './db';
import { ONTOLOGY_META_DDL } from './ontology/registry';
import { newsDedupKey } from './utils/news-dedup';
import { randomBytes } from 'node:crypto';

interface Migration {
  version: number;
  name: string;
  up: (db: DbAdapter) => void;
}

/** 全部迁移（只进不改）。导出供测试构造「某版本一致性副本」（如 v8 副本验证升级路径），生产代码只用 runMigrations */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'ontology_meta',
    up: (db) => db.exec(ONTOLOGY_META_DDL),
  },
  {
    version: 2,
    name: 'study_loop',
    up: (db) =>
      db.exec(`
      -- 学习计划草案：agent 生成、用户预览确认后才成为正式计划（status: draft/confirmed/cancelled）
      CREATE TABLE IF NOT EXISTS study_plan_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        material_source TEXT NOT NULL DEFAULT '',
        daily_minutes INTEGER NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        knowledge_points TEXT NOT NULL DEFAULT '[]',
        items TEXT NOT NULL DEFAULT '[]',
        assumptions TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft',
        plan_id INTEGER,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        confirmed_at TEXT,
        cancelled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_study_drafts_status ON study_plan_drafts(status);

      -- 学习会话：一次真实学习记录。scope_key+attempt 唯一，保证重复提交幂等、支持多次尝试
      CREATE TABLE IF NOT EXISTS study_sessions (
        id TEXT PRIMARY KEY,
        plan_id INTEGER,
        plan_item_id INTEGER,
        scope_key TEXT NOT NULL,
        knowledge_key TEXT NOT NULL,
        topic TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        date TEXT NOT NULL,
        actual_minutes INTEGER NOT NULL,
        explanation TEXT NOT NULL DEFAULT '',
        questions TEXT NOT NULL DEFAULT '',
        material_source TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(scope_key, attempt)
      );
      CREATE INDEX IF NOT EXISTS idx_study_sessions_plan ON study_sessions(plan_id);
      CREATE INDEX IF NOT EXISTS idx_study_sessions_kp ON study_sessions(knowledge_key);

      -- 测评记录：题目/标准/原答案/评分/依据，来源显式（self=自评 objective=客观测试 ai_suggestion=AI建议）
      CREATE TABLE IF NOT EXISTS study_assessments (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        plan_id INTEGER,
        plan_item_id INTEGER,
        knowledge_key TEXT NOT NULL,
        topic TEXT NOT NULL,
        question TEXT NOT NULL,
        criteria TEXT NOT NULL DEFAULT '',
        answer TEXT NOT NULL,
        source TEXT NOT NULL,
        score INTEGER,
        objective_passed INTEGER,
        feedback TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '',
        corrections TEXT NOT NULL DEFAULT '[]',
        date TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_study_assessments_kp ON study_assessments(knowledge_key);
      CREATE INDEX IF NOT EXISTS idx_study_assessments_session ON study_assessments(session_id);

      -- 调整应用记录：apply_plan_adjustments 的审计痕迹（保留历史，可追溯）
      CREATE TABLE IF NOT EXISTS plan_adjustments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL,
        suggestions TEXT NOT NULL DEFAULT '[]',
        applied_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_plan_adjustments_plan ON plan_adjustments(plan_id);

      -- 卡片导出记录：card_key 唯一，防重复导出；content_hash 用于识别用户后续编辑
      CREATE TABLE IF NOT EXISTS card_exports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_key TEXT NOT NULL UNIQUE,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        exported_at TEXT NOT NULL
      );

      -- 计划级每日预算（草案确认时写入；旧计划为 NULL，调整建议按缺省预算 120 分钟处理）
      ALTER TABLE study_plans ADD COLUMN daily_minutes INTEGER;
      -- 条目关联知识点稳定标识（学习闭环草案确认时写入；普通条目为 NULL）
      ALTER TABLE plan_items ADD COLUMN knowledge_key TEXT;
      `),
  },
  {
    version: 3,
    name: 'news_dedup_and_runs',
    up: (db) => {
      // 全新库（SCHEMA 已是新结构，含 dedup_key 列）直接跳过重建，只补话题状态列
      const newsCols = db.prepare('PRAGMA table_info(news)').all().map((c) => String((c as { name: string }).name));
      if (!newsCols.includes('dedup_key')) {
        // 旧结构（UNIQUE(source,title)）无损重建：JS 逐行按共享规则回填 dedup_key；
        // 回填冲突（旧表允许同键多行）的行加 #<id> 后缀，绝不合并、不删除任何历史行。
        db.exec(`
        CREATE TABLE news_v3 (
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
          UNIQUE(dedup_key)
        );
        `);
        const rows = db.prepare('SELECT * FROM news ORDER BY id').all();
        const insert = db.prepare(
          'INSERT INTO news_v3 (id, source, title, url, summary, published_date, published_at, fetched_at, dedup_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        );
        const used = new Set<string>();
        for (const r of rows) {
          let key = newsDedupKey(String(r.source), String(r.url), String(r.title));
          if (used.has(key)) key = `${key}#${r.id}`; // 历史重复行保留原样，仅键加后缀
          used.add(key);
          insert.run(r.id, r.source, r.title, r.url, r.summary ?? '', r.published_date, null, r.fetched_at, key);
        }
        db.exec('DROP TABLE news; ALTER TABLE news_v3 RENAME TO news;');
        db.exec('CREATE INDEX IF NOT EXISTS idx_news_date ON news(published_date);');
      }
      // 新结构（全新库或刚重建）统一补已读索引
      db.exec('CREATE INDEX IF NOT EXISTS idx_news_read ON news(is_read);');
      // 话题抓取状态列（新库 SCHEMA 已带；旧库补列）
      const topicCols = db.prepare('PRAGMA table_info(news_topics)').all().map((c) => String((c as { name: string }).name));
      if (!topicCols.includes('last_checked_at')) db.exec('ALTER TABLE news_topics ADD COLUMN last_checked_at TEXT');
      if (!topicCols.includes('last_success_at')) db.exec('ALTER TABLE news_topics ADD COLUMN last_success_at TEXT');
      if (!topicCols.includes('last_error')) db.exec('ALTER TABLE news_topics ADD COLUMN last_error TEXT');
      if (!topicCols.includes('last_added')) db.exec('ALTER TABLE news_topics ADD COLUMN last_added INTEGER NOT NULL DEFAULT 0');
      // 采集任务表（全新库亦由此创建，幂等）
      db.exec(`
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
      `);
    },
  },
  {
    version: 4,
    name: 'news_published_at',
    up: (db) => {
      // 精确发布时间（X created_at 原样保留，供今日判定与北京时间展示；旧数据为 NULL）
      const cols = db.prepare('PRAGMA table_info(news)').all().map((c) => String((c as { name: string }).name));
      if (!cols.includes('published_at')) db.exec('ALTER TABLE news ADD COLUMN published_at TEXT');
    },
  },
  {
    version: 5,
    name: 'rss_sources',
    up: (db) => {
      // RSS/Atom 无认证源：feed 地址与源级抓取状态（X 源这些列为 NULL）
      const cols = db.prepare('PRAGMA table_info(news_sources)').all().map((c) => String((c as { name: string }).name));
      if (!cols.includes('url')) db.exec('ALTER TABLE news_sources ADD COLUMN url TEXT');
      if (!cols.includes('last_checked_at')) db.exec('ALTER TABLE news_sources ADD COLUMN last_checked_at TEXT');
      if (!cols.includes('last_error')) db.exec('ALTER TABLE news_sources ADD COLUMN last_error TEXT');
    },
  },
  {
    version: 6,
    name: 'courses',
    up: (db) =>
      db.exec(`
      -- 教学课程：导入的课程元数据与样课确认状态（纯增量；不改既有计划/条目）
      CREATE TABLE IF NOT EXISTS courses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'imported',
        plan_id INTEGER,
        sample_content_hash TEXT,
        sample_confirmed_at TEXT,
        version TEXT NOT NULL DEFAULT '1.0.0',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_courses_plan ON courses(plan_id);

      -- 课程讲义：html_rel 为导入时已消毒的安全相对路径；quiz/concepts/code_refs 为纯文本元数据
      CREATE TABLE IF NOT EXISTS course_lessons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        day INTEGER NOT NULL,
        title TEXT NOT NULL,
        html_rel TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        is_sample INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'generated',
        estimated_minutes INTEGER NOT NULL DEFAULT 45,
        concepts TEXT NOT NULL DEFAULT '[]',
        code_refs TEXT NOT NULL DEFAULT '[]',
        quiz TEXT NOT NULL DEFAULT '[]',
        quiz_answers TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(course_id, day)
      );
      CREATE INDEX IF NOT EXISTS idx_course_lessons_course ON course_lessons(course_id);

      -- 课程生成请求队列：确认样课后才允许创建；与实际执行（外部 agent）区分
      CREATE TABLE IF NOT EXISTS course_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        sample_content_hash TEXT NOT NULL,
        requested_by TEXT NOT NULL DEFAULT 'app',
        claimed_by TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        claimed_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_course_requests_status ON course_requests(status);
      `),
  },
  {
    version: 7,
    name: 'vault_and_media',
    up: (db) =>
      db.exec(`
      -- 知识库 vault 注册（只读联动：索引是可重建缓存，内容唯一来源是磁盘 Markdown）
      CREATE TABLE IF NOT EXISTS vaults (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        include_dirs TEXT NOT NULL DEFAULT '["knowledge/moc","knowledge/resources","knowledge/inbox-cards"]',
        include_raw INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_scan_at TEXT,
        last_scan_stats TEXT
      );

      -- vault 笔记索引（vault_id+rel_path 唯一；missing 保留历史不删）
      CREATE TABLE IF NOT EXISTS vault_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vault_id INTEGER NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        rel_path TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'other',
        level TEXT,
        status TEXT,
        frontmatter TEXT NOT NULL DEFAULT '{}',
        file_hash TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL,
        size INTEGER NOT NULL,
        missing INTEGER NOT NULL DEFAULT 0,
        links_cache TEXT NOT NULL DEFAULT '[]',
        search_text TEXT NOT NULL DEFAULT '',
        indexed_at TEXT NOT NULL,
        UNIQUE(vault_id, rel_path)
      );
      CREATE INDEX IF NOT EXISTS idx_vault_notes_vault ON vault_notes(vault_id);
      CREATE INDEX IF NOT EXISTS idx_vault_notes_kind ON vault_notes(vault_id, kind);

      -- 学习概念 ↔ 知识卡片 手动关联（只写 Dayfolio 库，绝不改 vault 文件）
      CREATE TABLE IF NOT EXISTS vault_concept_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vault_id INTEGER NOT NULL,
        note_id INTEGER NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
        knowledge_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(note_id, knowledge_key)
      );
      CREATE INDEX IF NOT EXISTS idx_vault_concept_kp ON vault_concept_links(knowledge_key);

      -- 自媒体选题（status: idea=点子 selected=已选用 dropped=放弃）
      CREATE TABLE IF NOT EXISTS media_topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        angle TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'idea',
        source TEXT NOT NULL DEFAULT 'manual',
        source_news_id INTEGER,
        source_note TEXT,
        source_desc TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_media_topics_status ON media_topics(status);

      -- 自媒体内容（母稿；一母稿多平台版本）
      CREATE TABLE IF NOT EXISTS media_contents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id INTEGER REFERENCES media_topics(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        master_content TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'drafting',
        retro_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_media_contents_topic ON media_contents(topic_id);

      -- 平台版本（draft→in_review→approved/rejected；审核通过才能排期）
      CREATE TABLE IF NOT EXISTS media_content_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_id INTEGER NOT NULL REFERENCES media_contents(id) ON DELETE CASCADE,
        platform TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        review_note TEXT NOT NULL DEFAULT '',
        reviewed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(content_id, platform)
      );
      CREATE INDEX IF NOT EXISTS idx_media_versions_content ON media_content_versions(content_id);
      CREATE INDEX IF NOT EXISTS idx_media_versions_status ON media_content_versions(status);

      -- 素材库（来源可追溯：新闻收藏/知识卡片/手工）
      CREATE TABLE IF NOT EXISTS media_materials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'text',
        content TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        source_news_id INTEGER,
        source_note TEXT,
        source_desc TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- 内容 ↔ 素材 关联（素材包导出范围）
      CREATE TABLE IF NOT EXISTS media_content_materials (
        content_id INTEGER NOT NULL REFERENCES media_contents(id) ON DELETE CASCADE,
        material_id INTEGER NOT NULL REFERENCES media_materials(id) ON DELETE CASCADE,
        PRIMARY KEY (content_id, material_id)
      );

      -- 发布日历（人工发布回填；planned→published/cancelled）
      CREATE TABLE IF NOT EXISTS media_calendar (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_version_id INTEGER NOT NULL REFERENCES media_content_versions(id) ON DELETE CASCADE,
        planned_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planned',
        published_at TEXT,
        publish_url TEXT,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_media_calendar_date ON media_calendar(planned_date);
      CREATE INDEX IF NOT EXISTS idx_media_calendar_status ON media_calendar(status);

      -- 手动指标（同排期同日唯一，重复录入覆盖；custom 存 JSON 键值）
      CREATE TABLE IF NOT EXISTS media_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        calendar_id INTEGER NOT NULL REFERENCES media_calendar(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        views INTEGER,
        likes INTEGER,
        comments INTEGER,
        shares INTEGER,
        favorites INTEGER,
        custom TEXT NOT NULL DEFAULT '{}',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(calendar_id, date)
      );
      `),
  },
  {
    version: 8,
    name: 'news_agent_tasks',
    up: (db) => {
      // agent-only 新闻（2026-10-11 起）：本地不再抓取 RSS/不管理源与凭证；
      // 新闻生产唯一入口 = 新闻任务（agent 经 MCP 认领 → 提交带原始来源链接与摘要的条目）。
      // 纯增量：不改既有 news 行、不动收藏；news_sources/news_topics/news_sync_runs 保留为历史数据。
      db.exec(`
      -- 新闻任务：规则（标题/说明/预算/时间窗）+ 认领租约（跨批次接力与崩溃恢复）
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
        completed_at TEXT,
        completed_note TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_news_tasks_status ON news_tasks(status);
      `);
      // news 表补 agent 提交列（全新库 SCHEMA 已带；旧库在此补齐，数据不动）
      const newsCols = db.prepare('PRAGMA table_info(news)').all().map((c) => String((c as { name: string }).name));
      if (!newsCols.includes('task_id')) db.exec('ALTER TABLE news ADD COLUMN task_id INTEGER');
      if (!newsCols.includes('source_name')) db.exec('ALTER TABLE news ADD COLUMN source_name TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_news_task ON news(task_id);');
    },
  },
  {
    version: 9,
    name: 'dateless_drafts',
    up: (db) => {
      // 真正无日期的学习专题草案（2026-10-11）：daily_minutes/start_date/end_date 改为可空
      // （NULL = 未排期：不排日程、不产待办、不占预算），新增 course_id 记录未确认样课课程的关联，
      // 新增 conflict_checked_at 标记「排期提交时已做预算冲突硬校验」：
      //   NULL = 旧路径（draft() 创建即排期），确认不设冲突门（旧行为保持）；
      //   非 NULL = 新排期路径（scheduleDraft），确认边界须重检冲突（并发变动兜底）。
      // SQLite 无法就地修改列约束，无损重建表：存量草案排期字段原值保留（v2 起三列均 NOT NULL 有值，
      // 重建后语义不变，旧 dated 草案行为完全一致，且 conflict_checked_at 为 NULL 落入旧路径豁免）。
      db.exec(`
      CREATE TABLE study_plan_drafts_v9 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        material_source TEXT NOT NULL DEFAULT '',
        daily_minutes INTEGER,
        start_date TEXT,
        end_date TEXT,
        knowledge_points TEXT NOT NULL DEFAULT '[]',
        items TEXT NOT NULL DEFAULT '[]',
        assumptions TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft',
        plan_id INTEGER,
        course_id INTEGER,
        conflict_checked_at TEXT,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        confirmed_at TEXT,
        cancelled_at TEXT
      );
      INSERT INTO study_plan_drafts_v9
        (id, title, goal, material_source, daily_minutes, start_date, end_date, knowledge_points, items, assumptions, status, plan_id, course_id, conflict_checked_at, notes, created_at, updated_at, confirmed_at, cancelled_at)
      SELECT id, title, goal, material_source, daily_minutes, start_date, end_date, knowledge_points, items, assumptions, status, plan_id, NULL, NULL, notes, created_at, updated_at, confirmed_at, cancelled_at
      FROM study_plan_drafts;
      DROP TABLE study_plan_drafts;
      ALTER TABLE study_plan_drafts_v9 RENAME TO study_plan_drafts;
      CREATE INDEX IF NOT EXISTS idx_study_drafts_status ON study_plan_drafts(status);
      CREATE INDEX IF NOT EXISTS idx_study_drafts_course ON study_plan_drafts(course_id);
      `);
    },
  },
  {
    version: 10,
    name: 'course_overviews',
    up: (db) => db.exec(`
      -- 课程总览独立于 D1..Dn；旧课程无总览时保持原有日课与学习记录不变。
      CREATE TABLE IF NOT EXISTS course_overviews (
        course_id INTEGER PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
        html_rel TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `),
  },
  {
    version: 11,
    name: 'news_deletion_fingerprints',
    up: (db) => {
      // 删除新闻后只保留不可反推正文的去重指纹；累计收录数不因删除而返还任务预算。
      db.exec(`
      CREATE TABLE IF NOT EXISTS news_deleted_fingerprints (
        fingerprint TEXT PRIMARY KEY,
        deleted_at TEXT NOT NULL
      );
      `);
      const cols = db.prepare('PRAGMA table_info(news_tasks)').all().map((c) => String((c as { name: string }).name));
      if (!cols.includes('accepted_count')) {
        db.exec('ALTER TABLE news_tasks ADD COLUMN accepted_count INTEGER NOT NULL DEFAULT 0');
        db.exec(`UPDATE news_tasks SET accepted_count = (
          SELECT COUNT(*) FROM news WHERE news.task_id = news_tasks.id
        )`);
      }
    },
  },
  {
    version: 12,
    name: 'news_content_kind',
    up: (db) => {
      // 内容形态（2026-10-13）：'url'=详情页内嵌来源网页（历史行为，默认）；
      // 'html'=本地 HTML 快照（X/Twitter 等无法内嵌的来源，agent 提交 html 字段，
      // core 消毒后写入 dirname(db)/news/<uuid>.html，相对路径存 html_rel）。
      // 纯增量：历史行不动，默认 'url' 行为不变。
      const newsCols = db.prepare('PRAGMA table_info(news)').all().map((c) => String((c as { name: string }).name));
      if (!newsCols.includes('content_kind')) db.exec("ALTER TABLE news ADD COLUMN content_kind TEXT NOT NULL DEFAULT 'url'");
      if (!newsCols.includes('html_rel')) db.exec('ALTER TABLE news ADD COLUMN html_rel TEXT');
    },
  },
  { version: 13, name: 'ontology_relations', up: (db) => {
    const cols=db.prepare('PRAGMA table_info(ont_link_types)').all();
    if (!cols.some(c=>c.name==='config')) db.exec("ALTER TABLE ont_link_types ADD COLUMN config TEXT NOT NULL DEFAULT '{}'");
  } },
  {
    version: 14,
    name: 'calendar_events',
    up: (db) =>
      db.exec(`
      -- 个人本地日程（2026-10-14，今日页日历）：start_time 为空即全天；
      -- end_date 为空即单日；不建 CHECK 约束，合法性由服务层校验（保持迁移弹性）。
      CREATE TABLE IF NOT EXISTS calendar_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        date TEXT NOT NULL,
        end_date TEXT,
        start_time TEXT,
        end_time TEXT,
        note TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT 'blue',
        source TEXT NOT NULL DEFAULT 'app',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_calendar_events_date ON calendar_events(date);
      `),
  },
  {
    version: 15,
    name: 'todo_time_range',
    up: (db) => {
      const columns = db.prepare('PRAGMA table_info(todos)').all().map(c => String(c.name));
      if (!columns.includes('start_time')) db.exec('ALTER TABLE todos ADD COLUMN start_time TEXT');
      if (!columns.includes('end_time')) db.exec('ALTER TABLE todos ADD COLUMN end_time TEXT');
    },
  },
  {
    version: 16,
    name: 'ontology_action_templates',
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS ont_action_templates (
        action_name TEXT PRIMARY KEY REFERENCES ont_action_types(api_name) ON DELETE CASCADE,
        target_kind TEXT NOT NULL,
        target_name TEXT NOT NULL,
        operation TEXT NOT NULL,
        template_version INTEGER NOT NULL DEFAULT 1,
        schema_digest TEXT NOT NULL,
        UNIQUE(target_kind, target_name, operation)
      );
      CREATE TABLE IF NOT EXISTS ont_template_preferences (
        object_type TEXT PRIMARY KEY REFERENCES ont_object_types(api_name) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 1
      );
    `),
  },
  {
    version: 17,
    name: 'ontology_action_executions',
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS ont_action_executions (
        id TEXT PRIMARY KEY,
        action_name TEXT NOT NULL,
        status TEXT NOT NULL,
        channel TEXT NOT NULL,
        request_key TEXT,
        scope TEXT NOT NULL DEFAULT 'local-user',
        params_hash TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        attempts INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        UNIQUE(scope,request_key)
      );
      CREATE INDEX IF NOT EXISTS idx_action_runs_name_time ON ont_action_executions(action_name,created_at);
    `),
  },
  {
    version: 18,
    name: 'ontology_query_cursor_key',
    up: db => {
      db.exec('CREATE TABLE IF NOT EXISTS ont_query_config(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
      db.prepare("INSERT OR IGNORE INTO ont_query_config(key,value) VALUES('cursor_key',?)").run(randomBytes(32).toString('hex'));
    },
  },
];

export function runMigrations(db: DbAdapter): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const current = Number(row?.user_version ?? 0);
  for (const m of MIGRATIONS.filter((x) => x.version > current)) {
    inTx(db, () => {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
    });
  }
  return MIGRATIONS.length;
}
