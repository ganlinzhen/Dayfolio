# 数据库表结构明细

核对日期：2026-10-14。基于当前源码在隔离内存库初始化后的结构；本机实际库额外表见末尾。无业务记录内容。

[设计说明](database-design.md) · [程序可读 schema 快照](database-schema.json)

字段表的 NOT NULL 列记录 PRAGMA 声明值。INTEGER PRIMARY KEY 由 SQLite 行标识机制处理；TEXT 主键的非空要求还依赖写入规则。JSON、日期和枚举通常以 TEXT 保存，业务校验要求不完全等同于 SQL 约束。索引列表包含 SQLite 自动生成的主键和唯一索引。

## card_exports

卡片导出幂等键、路径和内容哈希

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `card_key` | `TEXT` | 0 | 是 | 无 |
| `file_path` | `TEXT` | 0 | 是 | 无 |
| `content_hash` | `TEXT` | 0 | 是 | 无 |
| `exported_at` | `TEXT` | 0 | 是 | 无 |

外键：
无声明的 SQL 外键。

索引：
- `sqlite_autoindex_card_exports_1`；唯一，来源 `u`。

建表 SQL：

```sql
CREATE TABLE card_exports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_key TEXT NOT NULL UNIQUE,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        exported_at TEXT NOT NULL
      );
```

## checkins

待办、条目或某日的打卡记录

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `ref_type` | `TEXT` | 0 | 是 | 无 |
| `ref_id` | `INTEGER` | 0 | 是 | `0` |
| `date` | `TEXT` | 0 | 是 | 无 |
| `note` | `TEXT` | 0 | 是 | `''` |
| `created_at` | `TEXT` | 0 | 是 | 无 |

外键：
无声明的 SQL 外键。

索引：
- `idx_checkins_date`；普通，来源 `c`。
- `sqlite_autoindex_checkins_1`；唯一，来源 `u`。

建表 SQL：

```sql
CREATE TABLE checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_type TEXT NOT NULL,
  ref_id INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(ref_type, ref_id, date)
);
```

## course_lessons

每日讲义路径、自测和阅读状态

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `course_id` | `INTEGER` | 0 | 是 | 无 |
| `day` | `INTEGER` | 0 | 是 | 无 |
| `title` | `TEXT` | 0 | 是 | 无 |
| `html_rel` | `TEXT` | 0 | 是 | 无 |
| `content_hash` | `TEXT` | 0 | 是 | 无 |
| `is_sample` | `INTEGER` | 0 | 是 | `0` |
| `status` | `TEXT` | 0 | 是 | `'generated'` |
| `estimated_minutes` | `INTEGER` | 0 | 是 | `45` |
| `concepts` | `TEXT` | 0 | 是 | `'[]'` |
| `code_refs` | `TEXT` | 0 | 是 | `'[]'` |
| `quiz` | `TEXT` | 0 | 是 | `'[]'` |
| `quiz_answers` | `TEXT` | 0 | 是 | `'[]'` |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `updated_at` | `TEXT` | 0 | 是 | 无 |

外键：
- `course_id → courses.id`；删除 `CASCADE`，更新 `NO ACTION`。

索引：
- `idx_course_lessons_course`；普通，来源 `c`。
- `sqlite_autoindex_course_lessons_1`；唯一，来源 `u`。

建表 SQL：

```sql
CREATE TABLE course_lessons (
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
```

## course_overviews

课程总览文件路径，一门课程最多一条

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `course_id` | `INTEGER` | 1 | 否 | 无 |
| `html_rel` | `TEXT` | 0 | 是 | 无 |
| `content_hash` | `TEXT` | 0 | 是 | 无 |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `updated_at` | `TEXT` | 0 | 是 | 无 |

外键：
- `course_id → courses.id`；删除 `CASCADE`，更新 `NO ACTION`。

索引：
无独立索引条目。

建表 SQL：

```sql
CREATE TABLE course_overviews (
        course_id INTEGER PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
        html_rel TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
```

## course_requests

课程生成请求、认领和完成状态

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `course_id` | `INTEGER` | 0 | 是 | 无 |
| `kind` | `TEXT` | 0 | 是 | 无 |
| `status` | `TEXT` | 0 | 是 | `'pending'` |
| `sample_content_hash` | `TEXT` | 0 | 是 | 无 |
| `requested_by` | `TEXT` | 0 | 是 | `'app'` |
| `claimed_by` | `TEXT` | 0 | 否 | 无 |
| `error` | `TEXT` | 0 | 否 | 无 |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `claimed_at` | `TEXT` | 0 | 否 | 无 |
| `completed_at` | `TEXT` | 0 | 否 | 无 |

外键：
- `course_id → courses.id`；删除 `CASCADE`，更新 `NO ACTION`。

索引：
- `idx_course_requests_status`；普通，来源 `c`。

建表 SQL：

```sql
CREATE TABLE course_requests (
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
```

## courses

课程元数据、计划绑定、样课确认状态

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `slug` | `TEXT` | 0 | 是 | 无 |
| `title` | `TEXT` | 0 | 是 | 无 |
| `goal` | `TEXT` | 0 | 是 | `''` |
| `status` | `TEXT` | 0 | 是 | `'imported'` |
| `plan_id` | `INTEGER` | 0 | 否 | 无 |
| `sample_content_hash` | `TEXT` | 0 | 否 | 无 |
| `sample_confirmed_at` | `TEXT` | 0 | 否 | 无 |
| `version` | `TEXT` | 0 | 是 | `'1.0.0'` |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `updated_at` | `TEXT` | 0 | 是 | 无 |

外键：
无声明的 SQL 外键。

索引：
- `idx_courses_plan`；普通，来源 `c`。
- `sqlite_autoindex_courses_1`；唯一，来源 `u`。

建表 SQL：

```sql
CREATE TABLE courses (
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
```

## media_calendar

发布排期、状态与结果链接

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `content_version_id` | `INTEGER` | 0 | 是 | 无 |
| `planned_date` | `TEXT` | 0 | 是 | 无 |
| `status` | `TEXT` | 0 | 是 | `'planned'` |
| `published_at` | `TEXT` | 0 | 否 | 无 |
| `publish_url` | `TEXT` | 0 | 否 | 无 |
| `note` | `TEXT` | 0 | 是 | `''` |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `updated_at` | `TEXT` | 0 | 是 | 无 |

外键：
- `content_version_id → media_content_versions.id`；删除 `CASCADE`，更新 `NO ACTION`。

索引：
- `idx_media_calendar_status`；普通，来源 `c`。
- `idx_media_calendar_date`；普通，来源 `c`。

建表 SQL：

```sql
CREATE TABLE media_calendar (
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
```

## media_content_materials

内容与素材的多对多中间表

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `content_id` | `INTEGER` | 1 | 是 | 无 |
| `material_id` | `INTEGER` | 2 | 是 | 无 |

外键：
- `material_id → media_materials.id`；删除 `CASCADE`，更新 `NO ACTION`。
- `content_id → media_contents.id`；删除 `CASCADE`，更新 `NO ACTION`。

索引：
- `sqlite_autoindex_media_content_materials_1`；唯一，来源 `pk`。

建表 SQL：

```sql
CREATE TABLE media_content_materials (
        content_id INTEGER NOT NULL REFERENCES media_contents(id) ON DELETE CASCADE,
        material_id INTEGER NOT NULL REFERENCES media_materials(id) ON DELETE CASCADE,
        PRIMARY KEY (content_id, material_id)
      );
```

## media_content_versions

平台版本、正文与审核状态

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `content_id` | `INTEGER` | 0 | 是 | 无 |
| `platform` | `TEXT` | 0 | 是 | 无 |
| `body` | `TEXT` | 0 | 是 | `''` |
| `status` | `TEXT` | 0 | 是 | `'draft'` |
| `review_note` | `TEXT` | 0 | 是 | `''` |
| `reviewed_at` | `TEXT` | 0 | 否 | 无 |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `updated_at` | `TEXT` | 0 | 是 | 无 |

外键：
- `content_id → media_contents.id`；删除 `CASCADE`，更新 `NO ACTION`。

索引：
- `idx_media_versions_status`；普通，来源 `c`。
- `idx_media_versions_content`；普通，来源 `c`。
- `sqlite_autoindex_media_content_versions_1`；唯一，来源 `u`。

建表 SQL：

```sql
CREATE TABLE media_content_versions (
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
```

## media_contents

母稿、选题绑定与复盘

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `topic_id` | `INTEGER` | 0 | 否 | 无 |
| `title` | `TEXT` | 0 | 是 | 无 |
| `master_content` | `TEXT` | 0 | 是 | `''` |
| `status` | `TEXT` | 0 | 是 | `'drafting'` |
| `retro_note` | `TEXT` | 0 | 是 | `''` |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `updated_at` | `TEXT` | 0 | 是 | 无 |

外键：
- `topic_id → media_topics.id`；删除 `SET NULL`，更新 `NO ACTION`。

索引：
- `idx_media_contents_topic`；普通，来源 `c`。

建表 SQL：

```sql
CREATE TABLE media_contents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id INTEGER REFERENCES media_topics(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        master_content TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'drafting',
        retro_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
```

## media_materials

素材正文与来源引用

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `title` | `TEXT` | 0 | 是 | 无 |
| `kind` | `TEXT` | 0 | 是 | `'text'` |
| `content` | `TEXT` | 0 | 是 | `''` |
| `source` | `TEXT` | 0 | 是 | `'manual'` |
| `source_news_id` | `INTEGER` | 0 | 否 | 无 |
| `source_note` | `TEXT` | 0 | 否 | 无 |
| `source_desc` | `TEXT` | 0 | 是 | `''` |
| `tags` | `TEXT` | 0 | 是 | `'[]'` |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `updated_at` | `TEXT` | 0 | 是 | 无 |

外键：
无声明的 SQL 外键。

索引：
无独立索引条目。

建表 SQL：

```sql
CREATE TABLE media_materials (
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
```

## media_metrics

排期对应的传播指标和自定义 JSON

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `calendar_id` | `INTEGER` | 0 | 是 | 无 |
| `date` | `TEXT` | 0 | 是 | 无 |
| `views` | `INTEGER` | 0 | 否 | 无 |
| `likes` | `INTEGER` | 0 | 否 | 无 |
| `comments` | `INTEGER` | 0 | 否 | 无 |
| `shares` | `INTEGER` | 0 | 否 | 无 |
| `favorites` | `INTEGER` | 0 | 否 | 无 |
| `custom` | `TEXT` | 0 | 是 | `'{}'` |
| `note` | `TEXT` | 0 | 是 | `''` |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `updated_at` | `TEXT` | 0 | 是 | 无 |

外键：
- `calendar_id → media_calendar.id`；删除 `CASCADE`，更新 `NO ACTION`。

索引：
- `sqlite_autoindex_media_metrics_1`；唯一，来源 `u`。

建表 SQL：

```sql
CREATE TABLE media_metrics (
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
```

## media_topics

创作选题与来源

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `title` | `TEXT` | 0 | 是 | 无 |
| `angle` | `TEXT` | 0 | 是 | `''` |
| `status` | `TEXT` | 0 | 是 | `'idea'` |
| `source` | `TEXT` | 0 | 是 | `'manual'` |
| `source_news_id` | `INTEGER` | 0 | 否 | 无 |
| `source_note` | `TEXT` | 0 | 否 | 无 |
| `source_desc` | `TEXT` | 0 | 是 | `''` |
| `tags` | `TEXT` | 0 | 是 | `'[]'` |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `updated_at` | `TEXT` | 0 | 是 | 无 |

外键：
无声明的 SQL 外键。

索引：
- `idx_media_topics_status`；普通，来源 `c`。

建表 SQL：

```sql
CREATE TABLE media_topics (
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
```

## news

新闻摘要、来源、阅读收藏状态和快照路径

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `source` | `TEXT` | 0 | 是 | 无 |
| `title` | `TEXT` | 0 | 是 | 无 |
| `url` | `TEXT` | 0 | 是 | 无 |
| `summary` | `TEXT` | 0 | 是 | `''` |
| `published_date` | `TEXT` | 0 | 是 | 无 |
| `published_at` | `TEXT` | 0 | 否 | 无 |
| `fetched_at` | `TEXT` | 0 | 是 | 无 |
| `dedup_key` | `TEXT` | 0 | 是 | 无 |
| `is_read` | `INTEGER` | 0 | 是 | `0` |
| `is_starred` | `INTEGER` | 0 | 是 | `0` |
| `task_id` | `INTEGER` | 0 | 否 | 无 |
| `source_name` | `TEXT` | 0 | 否 | 无 |
| `content_kind` | `TEXT` | 0 | 是 | `'url'` |
| `html_rel` | `TEXT` | 0 | 否 | 无 |

外键：
无声明的 SQL 外键。

索引：
- `idx_news_task`；普通，来源 `c`。
- `idx_news_read`；普通，来源 `c`。
- `idx_news_date`；普通，来源 `c`。
- `sqlite_autoindex_news_1`；唯一，来源 `u`。

建表 SQL：

```sql
CREATE TABLE news (
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
```

## news_deleted_fingerprints

删除后的去重指纹，防止新闻重新回流

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `fingerprint` | `TEXT` | 1 | 否 | 无 |
| `deleted_at` | `TEXT` | 0 | 是 | 无 |

外键：
无声明的 SQL 外键。

索引：
- `sqlite_autoindex_news_deleted_fingerprints_1`；唯一，来源 `pk`。

建表 SQL：

```sql
CREATE TABLE news_deleted_fingerprints (
  fingerprint TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
);
```

## news_sources

旧新闻来源配置，历史兼容

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `TEXT` | 1 | 否 | 无 |
| `name` | `TEXT` | 0 | 是 | 无 |
| `enabled` | `INTEGER` | 0 | 是 | `1` |
| `url` | `TEXT` | 0 | 否 | 无 |
| `last_checked_at` | `TEXT` | 0 | 否 | 无 |
| `last_error` | `TEXT` | 0 | 否 | 无 |

外键：
无声明的 SQL 外键。

索引：
- `sqlite_autoindex_news_sources_1`；唯一，来源 `pk`。

建表 SQL：

```sql
CREATE TABLE news_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  url TEXT,
  last_checked_at TEXT,
  last_error TEXT
);
```

## news_sync_runs

旧抓取任务和同步结果，历史兼容

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `scope` | `TEXT` | 0 | 是 | 无 |
| `status` | `TEXT` | 0 | 是 | `'queued'` |
| `requested_by` | `TEXT` | 0 | 是 | `'app'` |
| `results` | `TEXT` | 0 | 是 | `'[]'` |
| `fetched` | `INTEGER` | 0 | 是 | `0` |
| `added` | `INTEGER` | 0 | 是 | `0` |
| `failed_topic_ids` | `TEXT` | 0 | 是 | `'[]'` |
| `error` | `TEXT` | 0 | 否 | 无 |
| `lease_owner` | `TEXT` | 0 | 否 | 无 |
| `lease_expires_at` | `TEXT` | 0 | 否 | 无 |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `started_at` | `TEXT` | 0 | 否 | 无 |
| `finished_at` | `TEXT` | 0 | 否 | 无 |

外键：
无声明的 SQL 外键。

索引：
- `idx_news_sync_runs_status`；普通，来源 `c`。

建表 SQL：

```sql
CREATE TABLE news_sync_runs (
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
```

## news_tasks

新闻任务规则、租约、累计收录预算

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `title` | `TEXT` | 0 | 是 | 无 |
| `instructions` | `TEXT` | 0 | 是 | `''` |
| `max_items` | `INTEGER` | 0 | 是 | `10` |
| `window_hours` | `INTEGER` | 0 | 是 | `24` |
| `status` | `TEXT` | 0 | 是 | `'pending'` |
| `created_by` | `TEXT` | 0 | 是 | `'mcp'` |
| `claim_token` | `TEXT` | 0 | 否 | 无 |
| `claimed_by` | `TEXT` | 0 | 否 | 无 |
| `claim_expires_at` | `TEXT` | 0 | 否 | 无 |
| `attempts` | `INTEGER` | 0 | 是 | `0` |
| `accepted_count` | `INTEGER` | 0 | 是 | `0` |
| `completed_at` | `TEXT` | 0 | 否 | 无 |
| `completed_note` | `TEXT` | 0 | 否 | 无 |
| `last_error` | `TEXT` | 0 | 否 | 无 |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `updated_at` | `TEXT` | 0 | 是 | 无 |

外键：
无声明的 SQL 外键。

索引：
- `idx_news_tasks_status`；普通，来源 `c`。

建表 SQL：

```sql
CREATE TABLE news_tasks (
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
```

## news_topic_links

历史新闻与话题的中间表

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `news_id` | `INTEGER` | 1 | 是 | 无 |
| `topic_id` | `INTEGER` | 2 | 是 | 无 |

外键：
- `topic_id → news_topics.id`；删除 `CASCADE`，更新 `NO ACTION`。
- `news_id → news.id`；删除 `CASCADE`，更新 `NO ACTION`。

索引：
- `idx_news_topic_links_topic`；普通，来源 `c`。
- `sqlite_autoindex_news_topic_links_1`；唯一，来源 `pk`。

建表 SQL：

```sql
CREATE TABLE news_topic_links (
  news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  topic_id INTEGER NOT NULL REFERENCES news_topics(id) ON DELETE CASCADE,
  PRIMARY KEY (news_id, topic_id)
);
```

## news_topics

旧来源下的采集话题，历史兼容

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `source_id` | `TEXT` | 0 | 是 | 无 |
| `name` | `TEXT` | 0 | 是 | 无 |
| `query` | `TEXT` | 0 | 是 | 无 |
| `enabled` | `INTEGER` | 0 | 是 | `1` |
| `last_checked_at` | `TEXT` | 0 | 否 | 无 |
| `last_success_at` | `TEXT` | 0 | 否 | 无 |
| `last_error` | `TEXT` | 0 | 否 | 无 |
| `last_added` | `INTEGER` | 0 | 是 | `0` |

外键：
- `source_id → news_sources.id`；删除 `NO ACTION`，更新 `NO ACTION`。

索引：
- `idx_news_topics_source`；普通，来源 `c`。
- `sqlite_autoindex_news_topics_1`；唯一，来源 `u`。

建表 SQL：

```sql
CREATE TABLE news_topics (
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
```

## ont_action_types

本体元数据表

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `api_name` | `TEXT` | 1 | 否 | 无 |
| `title` | `TEXT` | 0 | 是 | 无 |
| `description` | `TEXT` | 0 | 是 | `''` |
| `is_builtin` | `INTEGER` | 0 | 是 | `0` |
| `status` | `TEXT` | 0 | 是 | `'active'` |
| `parameters` | `TEXT` | 0 | 是 | 无 |
| `operations` | `TEXT` | 0 | 是 | 无 |
| `sort_order` | `INTEGER` | 0 | 是 | `0` |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `updated_at` | `TEXT` | 0 | 是 | 无 |

外键：
无声明的 SQL 外键。

索引：
- `sqlite_autoindex_ont_action_types_1`；唯一，来源 `pk`。

建表 SQL：

```sql
CREATE TABLE ont_action_types (
  api_name TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_builtin INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  parameters TEXT NOT NULL,
  operations TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## ont_link_types

本体元数据表

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `api_name` | `TEXT` | 1 | 否 | 无 |
| `title` | `TEXT` | 0 | 是 | 无 |
| `left_type` | `TEXT` | 0 | 是 | 无 |
| `right_type` | `TEXT` | 0 | 是 | 无 |
| `cardinality` | `TEXT` | 0 | 是 | 无 |
| `left_link_name` | `TEXT` | 0 | 否 | 无 |
| `right_link_name` | `TEXT` | 0 | 否 | 无 |
| `fk_column` | `TEXT` | 0 | 否 | 无 |
| `on_delete` | `TEXT` | 0 | 否 | 无 |
| `discriminator_column` | `TEXT` | 0 | 否 | 无 |
| `discriminator_value` | `TEXT` | 0 | 否 | 无 |
| `ref_column` | `TEXT` | 0 | 否 | 无 |
| `link_table` | `TEXT` | 0 | 否 | 无 |
| `backing_left_property` | `TEXT` | 0 | 否 | 无 |
| `backing_right_property` | `TEXT` | 0 | 否 | 无 |
| `is_system` | `INTEGER` | 0 | 是 | `0` |
| `sort_order` | `INTEGER` | 0 | 是 | `0` |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `config` | `TEXT` | 0 | 是 | `'{}'` |

外键：
无声明的 SQL 外键。

索引：
- `sqlite_autoindex_ont_link_types_1`；唯一，来源 `pk`。

建表 SQL：

```sql
CREATE TABLE ont_link_types (
  api_name TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  left_type TEXT NOT NULL,
  right_type TEXT NOT NULL,
  cardinality TEXT NOT NULL,
  left_link_name TEXT,
  right_link_name TEXT,
  fk_column TEXT,
  on_delete TEXT,
  discriminator_column TEXT,
  discriminator_value TEXT,
  ref_column TEXT,
  link_table TEXT,
  backing_left_property TEXT,
  backing_right_property TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
, config TEXT NOT NULL DEFAULT '{}');
```

## ont_object_types

本体元数据表

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `api_name` | `TEXT` | 1 | 否 | 无 |
| `title` | `TEXT` | 0 | 是 | 无 |
| `description` | `TEXT` | 0 | 是 | `''` |
| `table_name` | `TEXT` | 0 | 否 | 无 |
| `is_virtual` | `INTEGER` | 0 | 是 | `0` |
| `is_system` | `INTEGER` | 0 | 是 | `0` |
| `primary_key` | `TEXT` | 0 | 是 | `'id'` |
| `title_property` | `TEXT` | 0 | 是 | 无 |
| `properties` | `TEXT` | 0 | 是 | 无 |
| `status` | `TEXT` | 0 | 是 | `'active'` |
| `sort_order` | `INTEGER` | 0 | 是 | `0` |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `updated_at` | `TEXT` | 0 | 是 | 无 |

外键：
无声明的 SQL 外键。

索引：
- `sqlite_autoindex_ont_object_types_2`；唯一，来源 `u`。
- `sqlite_autoindex_ont_object_types_1`；唯一，来源 `pk`。

建表 SQL：

```sql
CREATE TABLE ont_object_types (
  api_name TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  table_name TEXT UNIQUE,
  is_virtual INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 0,
  primary_key TEXT NOT NULL DEFAULT 'id',
  title_property TEXT NOT NULL,
  properties TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## plan_adjustments

计划调整审计，suggestions 为 JSON

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `plan_id` | `INTEGER` | 0 | 是 | 无 |
| `suggestions` | `TEXT` | 0 | 是 | `'[]'` |
| `applied_at` | `TEXT` | 0 | 是 | 无 |

外键：
无声明的 SQL 外键。

索引：
- `idx_plan_adjustments_plan`；普通，来源 `c`。

建表 SQL：

```sql
CREATE TABLE plan_adjustments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL,
        suggestions TEXT NOT NULL DEFAULT '[]',
        applied_at TEXT NOT NULL
      );
```

## plan_items

计划的每日条目，可关联待办与知识点

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `plan_id` | `INTEGER` | 0 | 是 | 无 |
| `date` | `TEXT` | 0 | 是 | 无 |
| `content` | `TEXT` | 0 | 是 | 无 |
| `item_type` | `TEXT` | 0 | 是 | `'learn'` |
| `duration_min` | `INTEGER` | 0 | 否 | 无 |
| `status` | `TEXT` | 0 | 是 | `'pending'` |
| `todo_id` | `INTEGER` | 0 | 否 | 无 |
| `sort_order` | `INTEGER` | 0 | 是 | `0` |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `updated_at` | `TEXT` | 0 | 是 | 无 |
| `knowledge_key` | `TEXT` | 0 | 否 | 无 |

外键：
- `todo_id → todos.id`；删除 `SET NULL`，更新 `NO ACTION`。
- `plan_id → study_plans.id`；删除 `CASCADE`，更新 `NO ACTION`。

索引：
- `idx_plan_items_date`；普通，来源 `c`。
- `idx_plan_items_plan`；普通，来源 `c`。

建表 SQL：

```sql
CREATE TABLE plan_items (
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
, knowledge_key TEXT);
```

## study_assessments

测评题目、原答案、评分与证据

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `TEXT` | 1 | 否 | 无 |
| `session_id` | `TEXT` | 0 | 否 | 无 |
| `plan_id` | `INTEGER` | 0 | 否 | 无 |
| `plan_item_id` | `INTEGER` | 0 | 否 | 无 |
| `knowledge_key` | `TEXT` | 0 | 是 | 无 |
| `topic` | `TEXT` | 0 | 是 | 无 |
| `question` | `TEXT` | 0 | 是 | 无 |
| `criteria` | `TEXT` | 0 | 是 | `''` |
| `answer` | `TEXT` | 0 | 是 | 无 |
| `source` | `TEXT` | 0 | 是 | 无 |
| `score` | `INTEGER` | 0 | 否 | 无 |
| `objective_passed` | `INTEGER` | 0 | 否 | 无 |
| `feedback` | `TEXT` | 0 | 是 | `''` |
| `evidence` | `TEXT` | 0 | 是 | `''` |
| `corrections` | `TEXT` | 0 | 是 | `'[]'` |
| `date` | `TEXT` | 0 | 是 | 无 |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `updated_at` | `TEXT` | 0 | 是 | 无 |

外键：
无声明的 SQL 外键。

索引：
- `idx_study_assessments_session`；普通，来源 `c`。
- `idx_study_assessments_kp`；普通，来源 `c`。
- `sqlite_autoindex_study_assessments_1`；唯一，来源 `pk`。

建表 SQL：

```sql
CREATE TABLE study_assessments (
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
```

## study_plan_drafts

草案、知识点与排期 JSON，确认后关联正式计划

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `title` | `TEXT` | 0 | 是 | 无 |
| `goal` | `TEXT` | 0 | 是 | `''` |
| `material_source` | `TEXT` | 0 | 是 | `''` |
| `daily_minutes` | `INTEGER` | 0 | 否 | 无 |
| `start_date` | `TEXT` | 0 | 否 | 无 |
| `end_date` | `TEXT` | 0 | 否 | 无 |
| `knowledge_points` | `TEXT` | 0 | 是 | `'[]'` |
| `items` | `TEXT` | 0 | 是 | `'[]'` |
| `assumptions` | `TEXT` | 0 | 是 | `'[]'` |
| `status` | `TEXT` | 0 | 是 | `'draft'` |
| `plan_id` | `INTEGER` | 0 | 否 | 无 |
| `course_id` | `INTEGER` | 0 | 否 | 无 |
| `conflict_checked_at` | `TEXT` | 0 | 否 | 无 |
| `notes` | `TEXT` | 0 | 是 | `''` |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `updated_at` | `TEXT` | 0 | 是 | 无 |
| `confirmed_at` | `TEXT` | 0 | 否 | 无 |
| `cancelled_at` | `TEXT` | 0 | 否 | 无 |

外键：
无声明的 SQL 外键。

索引：
- `idx_study_drafts_course`；普通，来源 `c`。
- `idx_study_drafts_status`；普通，来源 `c`。

建表 SQL：

```sql
CREATE TABLE "study_plan_drafts" (
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
```

## study_plans

正式学习计划、日期与每日预算

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `title` | `TEXT` | 0 | 是 | 无 |
| `goal` | `TEXT` | 0 | 是 | `''` |
| `start_date` | `TEXT` | 0 | 是 | 无 |
| `end_date` | `TEXT` | 0 | 是 | 无 |
| `status` | `TEXT` | 0 | 是 | `'active'` |
| `notes` | `TEXT` | 0 | 是 | `''` |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `updated_at` | `TEXT` | 0 | 是 | 无 |
| `daily_minutes` | `INTEGER` | 0 | 否 | 无 |

外键：
无声明的 SQL 外键。

索引：
无独立索引条目。

建表 SQL：

```sql
CREATE TABLE study_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, daily_minutes INTEGER);
```

## study_sessions

实际学习会话、尝试次数、解释与问题

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `TEXT` | 1 | 否 | 无 |
| `plan_id` | `INTEGER` | 0 | 否 | 无 |
| `plan_item_id` | `INTEGER` | 0 | 否 | 无 |
| `scope_key` | `TEXT` | 0 | 是 | 无 |
| `knowledge_key` | `TEXT` | 0 | 是 | 无 |
| `topic` | `TEXT` | 0 | 是 | 无 |
| `attempt` | `INTEGER` | 0 | 是 | 无 |
| `date` | `TEXT` | 0 | 是 | 无 |
| `actual_minutes` | `INTEGER` | 0 | 是 | 无 |
| `explanation` | `TEXT` | 0 | 是 | `''` |
| `questions` | `TEXT` | 0 | 是 | `''` |
| `material_source` | `TEXT` | 0 | 是 | `''` |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `updated_at` | `TEXT` | 0 | 是 | 无 |

外键：
无声明的 SQL 外键。

索引：
- `idx_study_sessions_kp`；普通，来源 `c`。
- `idx_study_sessions_plan`；普通，来源 `c`。
- `sqlite_autoindex_study_sessions_2`；唯一，来源 `u`。
- `sqlite_autoindex_study_sessions_1`；唯一，来源 `pk`。

建表 SQL：

```sql
CREATE TABLE study_sessions (
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
```

## todos

待办内容、优先级、状态与截止日期

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `title` | `TEXT` | 0 | 是 | 无 |
| `notes` | `TEXT` | 0 | 是 | `''` |
| `priority` | `TEXT` | 0 | 是 | `'medium'` |
| `status` | `TEXT` | 0 | 是 | `'open'` |
| `due_date` | `TEXT` | 0 | 否 | 无 |
| `tags` | `TEXT` | 0 | 是 | `'[]'` |
| `source` | `TEXT` | 0 | 是 | `'app'` |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `updated_at` | `TEXT` | 0 | 是 | 无 |
| `completed_at` | `TEXT` | 0 | 否 | 无 |

外键：
无声明的 SQL 外键。

索引：
- `idx_todos_due`；普通，来源 `c`。
- `idx_todos_status`；普通，来源 `c`。

建表 SQL：

```sql
CREATE TABLE todos (
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
```

## tool_categories

工具分类

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `name` | `TEXT` | 0 | 是 | 无 |
| `sort_order` | `INTEGER` | 0 | 是 | `0` |
| `created_at` | `TEXT` | 0 | 是 | 无 |

外键：
无声明的 SQL 外键。

索引：
- `sqlite_autoindex_tool_categories_1`；唯一，来源 `u`。

建表 SQL：

```sql
CREATE TABLE tool_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
```

## tools

工具元数据、入口文件与分类

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `title` | `TEXT` | 0 | 是 | 无 |
| `icon` | `TEXT` | 0 | 是 | `'tool'` |
| `category_id` | `INTEGER` | 0 | 否 | 无 |
| `entry_file` | `TEXT` | 0 | 是 | 无 |
| `sort_order` | `INTEGER` | 0 | 是 | `0` |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `updated_at` | `TEXT` | 0 | 是 | 无 |

外键：
- `category_id → tool_categories.id`；删除 `SET NULL`，更新 `NO ACTION`。

索引：
- `idx_tools_category`；普通，来源 `c`。

建表 SQL：

```sql
CREATE TABLE tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'tool',
  category_id INTEGER REFERENCES tool_categories(id) ON DELETE SET NULL,
  entry_file TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## vault_concept_links

知识点语义键与笔记的关联

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `vault_id` | `INTEGER` | 0 | 是 | 无 |
| `note_id` | `INTEGER` | 0 | 是 | 无 |
| `knowledge_key` | `TEXT` | 0 | 是 | 无 |
| `created_at` | `TEXT` | 0 | 是 | 无 |

外键：
- `note_id → vault_notes.id`；删除 `CASCADE`，更新 `NO ACTION`。

索引：
- `idx_vault_concept_kp`；普通，来源 `c`。
- `sqlite_autoindex_vault_concept_links_1`；唯一，来源 `u`。

建表 SQL：

```sql
CREATE TABLE vault_concept_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vault_id INTEGER NOT NULL,
        note_id INTEGER NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
        knowledge_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(note_id, knowledge_key)
      );
```

## vault_notes

笔记索引、元信息、缓存与搜索文本

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `vault_id` | `INTEGER` | 0 | 是 | 无 |
| `rel_path` | `TEXT` | 0 | 是 | 无 |
| `title` | `TEXT` | 0 | 是 | 无 |
| `kind` | `TEXT` | 0 | 是 | `'other'` |
| `level` | `TEXT` | 0 | 否 | 无 |
| `status` | `TEXT` | 0 | 否 | 无 |
| `frontmatter` | `TEXT` | 0 | 是 | `'{}'` |
| `file_hash` | `TEXT` | 0 | 是 | 无 |
| `mtime_ms` | `INTEGER` | 0 | 是 | 无 |
| `size` | `INTEGER` | 0 | 是 | 无 |
| `missing` | `INTEGER` | 0 | 是 | `0` |
| `links_cache` | `TEXT` | 0 | 是 | `'[]'` |
| `search_text` | `TEXT` | 0 | 是 | `''` |
| `indexed_at` | `TEXT` | 0 | 是 | 无 |

外键：
- `vault_id → vaults.id`；删除 `CASCADE`，更新 `NO ACTION`。

索引：
- `idx_vault_notes_kind`；普通，来源 `c`。
- `idx_vault_notes_vault`；普通，来源 `c`。
- `sqlite_autoindex_vault_notes_1`；唯一，来源 `u`。

建表 SQL：

```sql
CREATE TABLE vault_notes (
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
```

## vaults

知识库注册目录与扫描配置

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `INTEGER` | 1 | 否 | 无 |
| `name` | `TEXT` | 0 | 是 | 无 |
| `root_path` | `TEXT` | 0 | 是 | 无 |
| `include_dirs` | `TEXT` | 0 | 是 | `'["knowledge/moc","knowledge/resources","knowledge/inbox-cards"]'` |
| `include_raw` | `INTEGER` | 0 | 是 | `0` |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `updated_at` | `TEXT` | 0 | 是 | 无 |
| `last_scan_at` | `TEXT` | 0 | 否 | 无 |
| `last_scan_stats` | `TEXT` | 0 | 否 | 无 |

外键：
无声明的 SQL 外键。

索引：
- `sqlite_autoindex_vaults_1`；唯一，来源 `u`。

建表 SQL：

```sql
CREATE TABLE vaults (
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
```

## news_config_meta

本机实际库额外表

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `key` | `TEXT` | 1 | 否 | 无 |
| `value` | `TEXT` | 0 | 是 | 无 |

外键：
无声明的 SQL 外键。

索引：
- `sqlite_autoindex_news_config_meta_1`；唯一，来源 `pk`。

建表 SQL：

```sql
CREATE TABLE news_config_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

## ont_obj_daily_brief

本机实际库额外表

| 字段 | SQL 类型 | 主键顺序 | 声明 NOT NULL | 默认值 |
| --- | --- | ---: | --- | --- |
| `id` | `TEXT` | 1 | 否 | 无 |
| `brief_date` | `TEXT` | 0 | 否 | 无 |
| `title` | `TEXT` | 0 | 否 | 无 |
| `content` | `TEXT` | 0 | 否 | 无 |
| `source_urls` | `TEXT` | 0 | 否 | 无 |
| `news_ids` | `TEXT` | 0 | 否 | 无 |
| `item_count` | `INTEGER` | 0 | 否 | 无 |
| `task_id` | `INTEGER` | 0 | 否 | 无 |
| `status` | `TEXT` | 0 | 否 | 无 |
| `window_start` | `TEXT` | 0 | 否 | 无 |
| `window_end` | `TEXT` | 0 | 否 | 无 |
| `created_at` | `TEXT` | 0 | 是 | 无 |
| `updated_at` | `TEXT` | 0 | 是 | 无 |

外键：
无声明的 SQL 外键。

索引：
- `idx_ont_obj_daily_brief_brief_date`；普通，来源 `c`。
- `sqlite_autoindex_ont_obj_daily_brief_1`；唯一，来源 `pk`。

建表 SQL：

```sql
CREATE TABLE "ont_obj_daily_brief" (id TEXT PRIMARY KEY, "brief_date" TEXT, "title" TEXT, "content" TEXT, "source_urls" TEXT, "news_ids" TEXT, "item_count" INTEGER, "task_id" INTEGER, "status" TEXT, "window_start" TEXT, "window_end" TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
```
