// 自媒体工作流服务：选题 → 内容（一母稿多平台版本，每版本人工审核）→ 素材（来源可追溯）
// → 日历（排期 + 人工发布回填）→ 复盘（手动指标）。
//
// 红线：
// 1. 不登录、不自动发布任何外部平台——排期只是本地计划，published 状态由用户人工回填；
// 2. 平台版本必须经人工审核（in_review → approved）才能排期；审核通过与撤回是用户在 App 内的
//    亲自动作，MCP 不暴露 approve（课程样课另有专用对话确认工具）；本服务层的 review 仅提供动作原语；
// 3. 素材包导出到用户显式指定的目录，且拒绝任何位于已注册知识库 vault 内的目标目录（草稿不进 vault）；
// 4. 指标全部手动录入（同排期同日唯一，重复录入覆盖），没有任何自动抓取。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DbAdapter } from '../db';
import type {
  MediaCalendarEntry,
  MediaContent,
  MediaContentVersion,
  MediaMaterial,
  MediaMetric,
  MediaOverview,
  MediaPackageExport,
  MediaPlatformStats,
  MediaTopic,
} from '../types';
import { ensureValidDateStr, nowIso, todayStr } from '../utils/date';
import { sanitizeFileName } from '../utils/tool-files';
import { assertDirOutsideVaults, realPathOfMaybeMissing } from './vault';

const PLATFORM_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const STATUSES = {
  topic: ['idea', 'selected', 'dropped'],
  version: ['draft', 'in_review', 'approved', 'rejected'],
  calendar: ['planned', 'published', 'cancelled'],
} as const;

function parseJsonArray(s: unknown): string[] {
  try {
    const v = JSON.parse(String(s ?? '[]'));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function mapTopic(row: Record<string, unknown>): MediaTopic & { content_count: number } {
  return {
    id: Number(row.id),
    title: String(row.title),
    angle: String(row.angle ?? ''),
    status: row.status as MediaTopic['status'],
    source: row.source as MediaTopic['source'],
    source_news_id: row.source_news_id === null || row.source_news_id === undefined ? null : Number(row.source_news_id),
    source_note: (row.source_note as string | null) ?? null,
    source_desc: String(row.source_desc ?? ''),
    tags: parseJsonArray(row.tags),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    content_count: Number(row.content_count ?? 0),
  };
}

function mapContent(row: Record<string, unknown>): MediaContent {
  return {
    id: Number(row.id),
    topic_id: row.topic_id === null || row.topic_id === undefined ? null : Number(row.topic_id),
    title: String(row.title),
    master_content: String(row.master_content ?? ''),
    status: row.status as MediaContent['status'],
    retro_note: String(row.retro_note ?? ''),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapVersion(row: Record<string, unknown>): MediaContentVersion {
  return {
    id: Number(row.id),
    content_id: Number(row.content_id),
    platform: String(row.platform),
    body: String(row.body ?? ''),
    status: row.status as MediaContentVersion['status'],
    review_note: String(row.review_note ?? ''),
    reviewed_at: (row.reviewed_at as string | null) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapMaterial(row: Record<string, unknown>): MediaMaterial {
  return {
    id: Number(row.id),
    title: String(row.title),
    kind: row.kind as MediaMaterial['kind'],
    content: String(row.content ?? ''),
    source: row.source as MediaMaterial['source'],
    source_news_id: row.source_news_id === null || row.source_news_id === undefined ? null : Number(row.source_news_id),
    source_note: (row.source_note as string | null) ?? null,
    source_desc: String(row.source_desc ?? ''),
    tags: parseJsonArray(row.tags),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapCalendar(row: Record<string, unknown>): MediaCalendarEntry {
  return {
    id: Number(row.id),
    content_version_id: Number(row.content_version_id),
    content_id: Number(row.content_id),
    content_title: String(row.content_title ?? ''),
    platform: String(row.platform ?? ''),
    planned_date: String(row.planned_date),
    status: row.status as MediaCalendarEntry['status'],
    published_at: (row.published_at as string | null) ?? null,
    publish_url: (row.publish_url as string | null) ?? null,
    note: String(row.note ?? ''),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapMetric(row: Record<string, unknown>): MediaMetric {
  let custom: Record<string, number> = {};
  try {
    const v = JSON.parse(String(row.custom ?? '{}'));
    if (v && typeof v === 'object') custom = v as Record<string, number>;
  } catch {
    custom = {};
  }
  const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));
  return {
    id: Number(row.id),
    calendar_id: Number(row.calendar_id),
    date: String(row.date),
    platform: String(row.platform ?? ''),
    views: num(row.views),
    likes: num(row.likes),
    comments: num(row.comments),
    shares: num(row.shares),
    favorites: num(row.favorites),
    custom,
    note: String(row.note ?? ''),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export interface MediaService {
  // 选题
  addTopic(input: {
    title: string;
    angle?: string;
    source?: 'news' | 'knowledge' | 'manual';
    source_news_id?: number | null;
    source_note?: { vault_id: number; rel_path: string } | string | null;
    source_desc?: string;
    tags?: string[];
  }): MediaTopic;
  listTopics(filter?: { status?: string; search?: string; limit?: number }): Array<MediaTopic & { content_count: number }>;
  updateTopic(id: number, patch: { title?: string; angle?: string | null; status?: string; tags?: string[] }): MediaTopic;
  deleteTopic(id: number): void;
  // 内容（母稿 + 平台版本）
  addContent(input: { topic_id?: number | null; title: string; master_content?: string }): MediaContent;
  listContents(filter?: { topic_id?: number; status?: string; search?: string; limit?: number }): Array<
    MediaContent & { version_count: number; platforms: string[]; pending_review: number }
  >;
  getContent(id: number): {
    content: MediaContent;
    topic: MediaTopic | null;
    versions: MediaContentVersion[];
    materials: MediaMaterial[];
    calendar: MediaCalendarEntry[];
  };
  updateContent(
    id: number,
    patch: { title?: string; master_content?: string; status?: string; retro_note?: string },
  ): MediaContent;
  deleteContent(id: number): void;
  addVersion(content_id: number, input: { platform: string; body?: string }): MediaContentVersion;
  updateVersion(id: number, patch: { body?: string }): MediaContentVersion;
  /** 版本审核流转：submit=提交人工审核 draft/rejected→in_review；approve/reject 仅限 in_review（App 侧用户动作）；revoke=approved→draft 撤回重编 */
  reviewVersion(id: number, action: 'submit' | 'approve' | 'reject' | 'revoke', note?: string): MediaContentVersion;
  // 素材
  addMaterial(input: {
    title: string;
    kind?: 'text' | 'image' | 'link' | 'note';
    content?: string;
    source?: 'news' | 'knowledge' | 'manual';
    source_news_id?: number | null;
    source_note?: { vault_id: number; rel_path: string } | string | null;
    source_desc?: string;
    tags?: string[];
  }): MediaMaterial;
  listMaterials(filter?: { search?: string; kind?: string; limit?: number }): MediaMaterial[];
  updateMaterial(
    id: number,
    patch: { title?: string; kind?: string; content?: string; tags?: string[] },
  ): MediaMaterial;
  deleteMaterial(id: number): void;
  attachMaterial(content_id: number, material_id: number): void;
  detachMaterial(content_id: number, material_id: number): void;
  // 日历（排期与人工发布回填）
  schedule(input: { content_version_id: number; planned_date: string; note?: string }): MediaCalendarEntry;
  listCalendar(filter?: { from?: string; to?: string; status?: string; content_id?: number }): MediaCalendarEntry[];
  markPublished(id: number, input?: { published_at?: string; publish_url?: string | null; note?: string }): MediaCalendarEntry;
  cancelSchedule(id: number): MediaCalendarEntry;
  // 指标与复盘
  addMetric(input: {
    calendar_id: number;
    date?: string;
    views?: number | null;
    likes?: number | null;
    comments?: number | null;
    shares?: number | null;
    favorites?: number | null;
    custom?: Record<string, number>;
    note?: string;
  }): MediaMetric;
  listMetrics(filter?: { calendar_id?: number; from?: string; to?: string }): Array<MediaMetric & {
    content_title: string;
    planned_date: string;
  }>;
  getOverview(): MediaOverview;
  getStats(filter?: { from?: string; to?: string }): MediaPlatformStats[];
  // 素材包导出（vault 内目录拒绝——含未注册的内置保护根与 symlink 别名，见 vault.assertDirOutsideVaults）
  exportPackage(content_id: number, export_dir: string): MediaPackageExport;
}

export function createMediaService(db: DbAdapter): MediaService {
  const now = () => nowIso();

  const getRow = (table: string, id: number) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!row) throw new Error(`记录不存在：${table}#${id}`);
    return row;
  };

  /** 来源校验与快照：news 需存在并快照标题/URL；knowledge 需 vault 卡片已入索引 */
  const resolveSource = (
    source: 'news' | 'knowledge' | 'manual',
    source_news_id?: number | null,
    source_note?: { vault_id: number; rel_path: string } | string | null,
    source_desc?: string,
  ): { source_news_id: number | null; source_note: string | null; source_desc: string } => {
    if (source === 'news') {
      if (!source_news_id) throw new Error('来源为新闻时必须提供 source_news_id（可从 list_news 获取）');
      const news = db.prepare('SELECT title, url FROM news WHERE id = ?').get(source_news_id);
      if (!news) throw new Error(`新闻不存在：id=${source_news_id}`);
      return {
        source_news_id,
        source_note: null,
        source_desc: source_desc?.trim() || `${String(news.title)}\n${String(news.url)}`,
      };
    }
    if (source === 'knowledge') {
      let ref: { vault_id: number; rel_path: string };
      if (typeof source_note === 'string') {
        try {
          ref = JSON.parse(source_note);
        } catch {
          throw new Error('source_note 需为 {vault_id, rel_path} 对象或其 JSON 字符串');
        }
      } else if (source_note && typeof source_note === 'object') {
        ref = source_note;
      } else {
        throw new Error('来源为知识卡片时必须提供 source_note（{vault_id, rel_path}）');
      }
      const note = db
        .prepare('SELECT title FROM vault_notes WHERE vault_id = ? AND rel_path = ?')
        .get(ref.vault_id, ref.rel_path);
      if (!note) throw new Error(`知识卡片未入索引（先扫描 vault）：${ref.rel_path}`);
      return {
        source_news_id: null,
        source_note: JSON.stringify(ref),
        source_desc: source_desc?.trim() || `${String(note.title)}（${ref.rel_path}）`,
      };
    }
    return { source_news_id: null, source_note: null, source_desc: source_desc?.trim() ?? '' };
  };

  const normPlatform = (platform: string): string => {
    const p = platform.trim().toLowerCase();
    if (!PLATFORM_RE.test(p)) {
      throw new Error(`平台标识不合法：${platform}（小写字母/数字/中划线，如 xiaohongshu、weixin、douyin）`);
    }
    return p;
  };

  const service: MediaService = {
    addTopic({ title, angle, source = 'manual', source_news_id, source_note, source_desc, tags }) {
      if (!title.trim()) throw new Error('选题标题不能为空');
      const src = resolveSource(source, source_news_id, source_note, source_desc);
      const t = now();
      const r = db
        .prepare(
          `INSERT INTO media_topics (title, angle, status, source, source_news_id, source_note, source_desc, tags, created_at, updated_at)
           VALUES (?, ?, 'idea', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(title.trim(), angle ?? '', source, src.source_news_id, src.source_note, src.source_desc, JSON.stringify(tags ?? []), t, t);
      return mapTopic(getRow('media_topics', Number(r.lastInsertRowid)));
    },

    listTopics(filter = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.status && filter.status !== 'all') {
        where.push('t.status = ?');
        params.push(filter.status);
      }
      if (filter.search?.trim()) {
        where.push('(t.title LIKE ? OR t.angle LIKE ? OR t.source_desc LIKE ?)');
        const kw = `%${filter.search.trim()}%`;
        params.push(kw, kw, kw);
      }
      const limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
      const rows = db
        .prepare(
          `SELECT t.*, (SELECT COUNT(*) FROM media_contents c WHERE c.topic_id = t.id) AS content_count
           FROM media_topics t ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY t.status = 'selected' DESC, t.updated_at DESC LIMIT ${limit}`,
        )
        .all(...params);
      return rows.map(mapTopic);
    },

    updateTopic(id, patch) {
      getRow('media_topics', id);
      if (patch.status && !STATUSES.topic.includes(patch.status as never)) {
        throw new Error(`选题状态不合法：${patch.status}（idea/selected/dropped）`);
      }
      const cur = mapTopic(getRow('media_topics', id));
      const title = patch.title?.trim() || cur.title;
      const angle = patch.angle !== undefined ? patch.angle : cur.angle;
      const status = patch.status ?? cur.status;
      const tags = patch.tags ?? cur.tags;
      db.prepare('UPDATE media_topics SET title = ?, angle = ?, status = ?, tags = ?, updated_at = ? WHERE id = ?').run(
        title, angle, status, JSON.stringify(tags), now(), id,
      );
      return mapTopic(getRow('media_topics', id));
    },

    deleteTopic(id) {
      const used = db.prepare('SELECT COUNT(*) AS n FROM media_contents WHERE topic_id = ?').get(id);
      if (Number(used?.n ?? 0) > 0) {
        throw new Error('该选题下已有内容，请先删除对应内容（或将其选题改绑后再删）');
      }
      const r = db.prepare('DELETE FROM media_topics WHERE id = ?').run(id);
      if (r.changes === 0) throw new Error(`选题不存在：${id}`);
    },

    addContent({ topic_id, title, master_content }) {
      if (!title.trim()) throw new Error('内容标题不能为空');
      if (topic_id !== null && topic_id !== undefined) {
        const topic = mapTopic(getRow('media_topics', topic_id));
        if (topic.status === 'dropped') throw new Error('选题已被放弃（dropped），不能基于它创建内容；请先恢复为 idea/selected');
      }
      const t = now();
      const r = db
        .prepare(
          `INSERT INTO media_contents (topic_id, title, master_content, status, retro_note, created_at, updated_at)
           VALUES (?, ?, ?, 'drafting', '', ?, ?)`,
        )
        .run(topic_id ?? null, title.trim(), master_content ?? '', t, t);
      return mapContent(getRow('media_contents', Number(r.lastInsertRowid)));
    },

    listContents(filter = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.topic_id !== undefined) {
        where.push('c.topic_id = ?');
        params.push(filter.topic_id);
      }
      if (filter.status && filter.status !== 'all') {
        where.push('c.status = ?');
        params.push(filter.status);
      }
      if (filter.search?.trim()) {
        where.push('(c.title LIKE ? OR c.master_content LIKE ?)');
        const kw = `%${filter.search.trim()}%`;
        params.push(kw, kw);
      }
      const limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
      const rows = db
        .prepare(
          `SELECT c.*,
             (SELECT COUNT(*) FROM media_content_versions v WHERE v.content_id = c.id) AS version_count,
             (SELECT COUNT(*) FROM media_content_versions v WHERE v.content_id = c.id AND v.status = 'in_review') AS pending_review
           FROM media_contents c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY c.updated_at DESC LIMIT ${limit}`,
        )
        .all(...params);
      return rows.map((row) => {
        const platforms = db
          .prepare('SELECT platform FROM media_content_versions WHERE content_id = ? ORDER BY platform')
          .all(Number(row.id))
          .map((p) => String(p.platform));
        return { ...mapContent(row), version_count: Number(row.version_count ?? 0), platforms, pending_review: Number(row.pending_review ?? 0) };
      });
    },

    getContent(id) {
      const content = mapContent(getRow('media_contents', id));
      const topic = content.topic_id
        ? mapTopic(getRow('media_topics', content.topic_id))
        : null;
      const versions = db
        .prepare('SELECT * FROM media_content_versions WHERE content_id = ? ORDER BY platform')
        .all(id)
        .map(mapVersion);
      const materials = db
        .prepare(
          `SELECT m.* FROM media_materials m JOIN media_content_materials cm ON cm.material_id = m.id
           WHERE cm.content_id = ? ORDER BY m.id`,
        )
        .all(id)
        .map(mapMaterial);
      const calendar = db
        .prepare(
          `SELECT ca.*, v.content_id AS content_id, v.platform AS platform, c.title AS content_title
           FROM media_calendar ca
           JOIN media_content_versions v ON v.id = ca.content_version_id
           JOIN media_contents c ON c.id = v.content_id
           WHERE v.content_id = ? ORDER BY ca.planned_date DESC, ca.id DESC`,
        )
        .all(id)
        .map(mapCalendar);
      return { content, topic, versions, materials, calendar };
    },

    updateContent(id, patch) {
      getRow('media_contents', id);
      if (patch.status && !['drafting', 'master_done'].includes(patch.status)) {
        throw new Error(`内容状态不合法：${patch.status}（drafting/master_done）`);
      }
      const cur = mapContent(getRow('media_contents', id));
      db.prepare(
        'UPDATE media_contents SET title = ?, master_content = ?, status = ?, retro_note = ?, updated_at = ? WHERE id = ?',
      ).run(
        patch.title?.trim() || cur.title,
        patch.master_content !== undefined ? patch.master_content : cur.master_content,
        patch.status ?? cur.status,
        patch.retro_note !== undefined ? patch.retro_note : cur.retro_note,
        now(),
        id,
      );
      return mapContent(getRow('media_contents', id));
    },

    deleteContent(id) {
      const r = db.prepare('DELETE FROM media_contents WHERE id = ?').run(id);
      if (r.changes === 0) throw new Error(`内容不存在：${id}`);
    },

    addVersion(content_id, { platform, body }) {
      getRow('media_contents', content_id);
      const p = normPlatform(platform);
      const dup = db
        .prepare('SELECT id FROM media_content_versions WHERE content_id = ? AND platform = ?')
        .get(content_id, p);
      if (dup) throw new Error(`该内容的 ${p} 平台版本已存在（id=${dup.id}），请直接编辑或撤回后重写`);
      const t = now();
      const r = db
        .prepare(
          `INSERT INTO media_content_versions (content_id, platform, body, status, created_at, updated_at)
           VALUES (?, ?, ?, 'draft', ?, ?)`,
        )
        .run(content_id, p, body ?? '', t, t);
      return mapVersion(getRow('media_content_versions', Number(r.lastInsertRowid)));
    },

    updateVersion(id, patch) {
      const cur = mapVersion(getRow('media_content_versions', id));
      if (cur.status === 'approved') {
        throw new Error('已通过人工审核的版本不可直接编辑；请先在 App 内撤回（revoke）再修改');
      }
      db.prepare('UPDATE media_content_versions SET body = ?, updated_at = ? WHERE id = ?').run(
        patch.body !== undefined ? patch.body : cur.body,
        now(),
        id,
      );
      return mapVersion(getRow('media_content_versions', id));
    },

    reviewVersion(id, action, note) {
      const cur = mapVersion(getRow('media_content_versions', id));
      const t = now();
      const fail = (msg: string): never => {
        throw new Error(msg);
      };
      if (action === 'submit') {
        if (cur.status !== 'draft' && cur.status !== 'rejected') {
          fail(`仅 draft/rejected 状态可提交审核，当前为 ${cur.status}`);
        }
        db.prepare("UPDATE media_content_versions SET status = 'in_review', review_note = ?, updated_at = ? WHERE id = ?").run(
          note ?? cur.review_note, t, id,
        );
      } else if (action === 'approve' || action === 'reject') {
        if (cur.status !== 'in_review') fail(`仅待审核（in_review）版本可 ${action}，当前为 ${cur.status}`);
        db.prepare('UPDATE media_content_versions SET status = ?, review_note = ?, reviewed_at = ?, updated_at = ? WHERE id = ?').run(
          action === 'approve' ? 'approved' : 'rejected', note ?? '', t, t, id,
        );
      } else if (action === 'revoke') {
        if (cur.status !== 'approved') fail(`仅已通过审核的版本可撤回，当前为 ${cur.status}`);
        db.prepare("UPDATE media_content_versions SET status = 'draft', review_note = ?, updated_at = ? WHERE id = ?").run(
          note ?? '撤回重编', t, id,
        );
      } else {
        fail(`未知审核动作：${action}`);
      }
      return mapVersion(getRow('media_content_versions', id));
    },

    addMaterial(input) {
      if (!input.title.trim()) throw new Error('素材标题不能为空');
      const src = resolveSource(input.source ?? 'manual', input.source_news_id, input.source_note, input.source_desc);
      if (input.kind && !['text', 'image', 'link', 'note'].includes(input.kind)) {
        throw new Error(`素材类型不合法：${input.kind}（text/image/link/note）`);
      }
      const t = now();
      const r = db
        .prepare(
          `INSERT INTO media_materials (title, kind, content, source, source_news_id, source_note, source_desc, tags, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.title.trim(), input.kind ?? 'text', input.content ?? '', input.source ?? 'manual',
          src.source_news_id, src.source_note, src.source_desc, JSON.stringify(input.tags ?? []), t, t,
        );
      return mapMaterial(getRow('media_materials', Number(r.lastInsertRowid)));
    },

    listMaterials(filter = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.kind && filter.kind !== 'all') {
        where.push('kind = ?');
        params.push(filter.kind);
      }
      if (filter.search?.trim()) {
        where.push('(title LIKE ? OR content LIKE ? OR source_desc LIKE ?)');
        const kw = `%${filter.search.trim()}%`;
        params.push(kw, kw, kw);
      }
      const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000));
      return db
        .prepare(`SELECT * FROM media_materials ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ${limit}`)
        .all(...params)
        .map(mapMaterial);
    },

    updateMaterial(id, patch) {
      getRow('media_materials', id);
      const cur = mapMaterial(getRow('media_materials', id));
      if (patch.kind && !['text', 'image', 'link', 'note'].includes(patch.kind)) {
        throw new Error(`素材类型不合法：${patch.kind}`);
      }
      db.prepare('UPDATE media_materials SET title = ?, kind = ?, content = ?, tags = ?, updated_at = ? WHERE id = ?').run(
        patch.title?.trim() || cur.title,
        patch.kind ?? cur.kind,
        patch.content !== undefined ? patch.content : cur.content,
        JSON.stringify(patch.tags ?? cur.tags),
        now(),
        id,
      );
      return mapMaterial(getRow('media_materials', id));
    },

    deleteMaterial(id) {
      const r = db.prepare('DELETE FROM media_materials WHERE id = ?').run(id);
      if (r.changes === 0) throw new Error(`素材不存在：${id}`);
    },

    attachMaterial(content_id, material_id) {
      getRow('media_contents', content_id);
      getRow('media_materials', material_id);
      db.prepare('INSERT OR IGNORE INTO media_content_materials (content_id, material_id) VALUES (?, ?)').run(
        content_id, material_id,
      );
    },

    detachMaterial(content_id, material_id) {
      db.prepare('DELETE FROM media_content_materials WHERE content_id = ? AND material_id = ?').run(
        content_id, material_id,
      );
    },

    schedule({ content_version_id, planned_date, note }) {
      const version = mapVersion(getRow('media_content_versions', content_version_id));
      if (version.status !== 'approved') {
        throw new Error(`仅已通过人工审核（approved）的版本可排期，当前为 ${version.status}`);
      }
      const date = ensureValidDateStr(planned_date);
      const existing = db
        .prepare("SELECT * FROM media_calendar WHERE content_version_id = ? AND status != 'cancelled'")
        .get(content_version_id);
      if (existing) {
        const ent = mapCalendar({ ...existing, content_title: '', platform: version.platform, content_id: version.content_id });
        if (ent.status === 'published') throw new Error('该版本已发布，不能改期；如需重发请新建版本');
        db.prepare('UPDATE media_calendar SET planned_date = ?, note = ?, updated_at = ? WHERE id = ?').run(
          date, note ?? ent.note, now(), ent.id,
        );
        return mapCalendar({ ...getRow('media_calendar', ent.id), content_title: '', platform: version.platform, content_id: version.content_id });
      }
      const t = now();
      const r = db
        .prepare(
          `INSERT INTO media_calendar (content_version_id, planned_date, status, note, created_at, updated_at)
           VALUES (?, ?, 'planned', ?, ?, ?)`,
        )
        .run(content_version_id, date, note ?? '', t, t);
      return mapCalendar({ ...getRow('media_calendar', Number(r.lastInsertRowid)), content_title: '', platform: version.platform, content_id: version.content_id });
    },

    listCalendar(filter = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.from) {
        where.push('ca.planned_date >= ?');
        params.push(ensureValidDateStr(filter.from));
      }
      if (filter.to) {
        where.push('ca.planned_date <= ?');
        params.push(ensureValidDateStr(filter.to));
      }
      if (filter.status && filter.status !== 'all') {
        where.push('ca.status = ?');
        params.push(filter.status);
      }
      if (filter.content_id !== undefined) {
        where.push('v.content_id = ?');
        params.push(filter.content_id);
      }
      return db
        .prepare(
          `SELECT ca.*, v.content_id AS content_id, v.platform AS platform, c.title AS content_title
           FROM media_calendar ca
           JOIN media_content_versions v ON v.id = ca.content_version_id
           JOIN media_contents c ON c.id = v.content_id
           ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY ca.planned_date DESC, ca.id DESC LIMIT 500`,
        )
        .all(...params)
        .map(mapCalendar);
    },

    markPublished(id, input) {
      const cur = mapCalendar({ ...getRow('media_calendar', id), content_title: '', platform: '', content_id: 0 });
      if (cur.status !== 'planned') throw new Error(`仅 planned 状态可回填发布，当前为 ${cur.status}`);
      if (input?.publish_url && !/^https?:\/\//.test(input.publish_url)) {
        throw new Error('publish_url 须为 http(s) 链接');
      }
      db.prepare(
        "UPDATE media_calendar SET status = 'published', published_at = ?, publish_url = ?, note = ?, updated_at = ? WHERE id = ?",
      ).run(
        input?.published_at ?? now(),
        input?.publish_url ?? null,
        input?.note ?? cur.note,
        now(),
        id,
      );
      const row = getRow('media_calendar', id);
      const version = mapVersion(getRow('media_content_versions', Number(row.content_version_id)));
      return mapCalendar({ ...row, content_title: '', platform: version.platform, content_id: version.content_id });
    },

    cancelSchedule(id) {
      const cur = mapCalendar({ ...getRow('media_calendar', id), content_title: '', platform: '', content_id: 0 });
      if (cur.status !== 'planned') throw new Error(`仅 planned 状态可取消，当前为 ${cur.status}`);
      db.prepare("UPDATE media_calendar SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), id);
      const row = getRow('media_calendar', id);
      const version = mapVersion(getRow('media_content_versions', Number(row.content_version_id)));
      return mapCalendar({ ...row, content_title: '', platform: version.platform, content_id: version.content_id });
    },

    addMetric(input) {
      const cal = getRow('media_calendar', input.calendar_id);
      if (String(cal.status) !== 'published') throw new Error('仅已发布（published）的排期可录入指标');
      const date = ensureValidDateStr(input.date ?? todayStr());
      const t = now();
      db.prepare(
        `INSERT INTO media_metrics (calendar_id, date, views, likes, comments, shares, favorites, custom, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(calendar_id, date) DO UPDATE SET
           views = excluded.views, likes = excluded.likes, comments = excluded.comments, shares = excluded.shares,
           favorites = excluded.favorites, custom = excluded.custom, note = excluded.note, updated_at = excluded.updated_at`,
      ).run(
        input.calendar_id, date, input.views ?? null, input.likes ?? null, input.comments ?? null,
        input.shares ?? null, input.favorites ?? null, JSON.stringify(input.custom ?? {}), input.note ?? '', t, t,
      );
      const saved = db
        .prepare('SELECT id FROM media_metrics WHERE calendar_id = ? AND date = ?')
        .get(input.calendar_id, date) as { id: number } | undefined;
      if (!saved) throw new Error('指标保存失败');
      const row = getRow('media_metrics', Number(saved.id));
      const version = mapVersion(getRow('media_content_versions', Number(cal.content_version_id)));
      return mapMetric({ ...row, platform: version.platform });
    },

    listMetrics(filter = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.calendar_id !== undefined) {
        where.push('m.calendar_id = ?');
        params.push(filter.calendar_id);
      }
      if (filter.from) {
        where.push('m.date >= ?');
        params.push(ensureValidDateStr(filter.from));
      }
      if (filter.to) {
        where.push('m.date <= ?');
        params.push(ensureValidDateStr(filter.to));
      }
      return db
        .prepare(
          `SELECT m.*, v.platform AS platform, c.title AS content_title, ca.planned_date AS planned_date
           FROM media_metrics m
           JOIN media_calendar ca ON ca.id = m.calendar_id
           JOIN media_content_versions v ON v.id = ca.content_version_id
           JOIN media_contents c ON c.id = v.content_id
           ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY m.date DESC, m.id DESC LIMIT 500`,
        )
        .all(...params)
        .map((r) => ({ ...mapMetric(r), content_title: String(r.content_title ?? ''), planned_date: String(r.planned_date ?? '') }));
    },

    getOverview() {
      const count = (sql: string, ...params: unknown[]) => Number(db.prepare(sql).get(...params)?.n ?? 0);
      const topicBy = Object.fromEntries(
        db.prepare('SELECT status, COUNT(*) AS n FROM media_topics GROUP BY status').all().map((r) => [String(r.status), Number(r.n)]),
      );
      const contentBy = Object.fromEntries(
        db.prepare('SELECT status, COUNT(*) AS n FROM media_contents GROUP BY status').all().map((r) => [String(r.status), Number(r.n)]),
      );
      const versionBy = Object.fromEntries(
        db.prepare('SELECT status, COUNT(*) AS n FROM media_content_versions GROUP BY status').all().map((r) => [String(r.status), Number(r.n)]),
      );
      const calBy = Object.fromEntries(
        db.prepare('SELECT status, COUNT(*) AS n FROM media_calendar GROUP BY status').all().map((r) => [String(r.status), Number(r.n)]),
      );
      const pending_review = db
        .prepare(
          `SELECT v.id, v.content_id, c.title AS content_title, v.platform, v.updated_at
           FROM media_content_versions v JOIN media_contents c ON c.id = v.content_id
           WHERE v.status = 'in_review' ORDER BY v.updated_at ASC LIMIT 50`,
        )
        .all()
        .map((r) => ({
          id: Number(r.id), content_id: Number(r.content_id), content_title: String(r.content_title),
          platform: String(r.platform), updated_at: String(r.updated_at),
        }));
      const upcoming = db
        .prepare(
          `SELECT ca.id, ca.planned_date, c.title AS content_title, v.platform
           FROM media_calendar ca
           JOIN media_content_versions v ON v.id = ca.content_version_id
           JOIN media_contents c ON c.id = v.content_id
           WHERE ca.status = 'planned' AND ca.planned_date >= ? ORDER BY ca.planned_date ASC LIMIT 50`,
        )
        .all(todayStr())
        .map((r) => ({
          id: Number(r.id), planned_date: String(r.planned_date), content_title: String(r.content_title),
          platform: String(r.platform),
        }));
      return {
        topics: { idea: topicBy.idea ?? 0, selected: topicBy.selected ?? 0, dropped: topicBy.dropped ?? 0 },
        contents: { drafting: contentBy.drafting ?? 0, master_done: contentBy.master_done ?? 0 },
        versions: {
          draft: versionBy.draft ?? 0, in_review: versionBy.in_review ?? 0,
          approved: versionBy.approved ?? 0, rejected: versionBy.rejected ?? 0,
        },
        calendar: { planned: calBy.planned ?? 0, published: calBy.published ?? 0, cancelled: calBy.cancelled ?? 0 },
        published_last_30d: count(
          "SELECT COUNT(*) AS n FROM media_calendar WHERE status = 'published' AND published_at >= datetime('now', '-30 days')",
        ),
        pending_review,
        upcoming,
        materials: count('SELECT COUNT(*) AS n FROM media_materials'),
      };
    },

    getStats(filter = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.from) {
        where.push('m.date >= ?');
        params.push(ensureValidDateStr(filter.from));
      }
      if (filter.to) {
        where.push('m.date <= ?');
        params.push(ensureValidDateStr(filter.to));
      }
      const rows = db
        .prepare(
          `SELECT v.platform AS platform,
             COUNT(DISTINCT ca.id) AS published,
             SUM(m.views) AS views, SUM(m.likes) AS likes, SUM(m.comments) AS comments,
             SUM(m.shares) AS shares, SUM(m.favorites) AS favorites
           FROM media_metrics m
           JOIN media_calendar ca ON ca.id = m.calendar_id
           JOIN media_content_versions v ON v.id = ca.content_version_id
           ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           GROUP BY v.platform ORDER BY published DESC`,
        )
        .all(...params);
      return rows.map((r) => ({
        platform: String(r.platform),
        published: Number(r.published ?? 0),
        views: Number(r.views ?? 0),
        likes: Number(r.likes ?? 0),
        comments: Number(r.comments ?? 0),
        shares: Number(r.shares ?? 0),
        favorites: Number(r.favorites ?? 0),
      }));
    },

    exportPackage(content_id, export_dir) {
      const detail = service.getContent(content_id);
      // realpath 化（含不存在尾段时沿最深祖先解析）：防 symlink 别名使写入与返回路径与保护判断不一致
      const target = realPathOfMaybeMissing(resolve(export_dir));
      // 硬拒绝：任何保护根内（已注册 vault / 内置默认 vault / TODODESK_PROTECTED_DIRS），symlink 安全
      assertDirOutsideVaults(db, target);
      const dirName = `media-${content_id}-${sanitizeFileName(detail.content.title).slice(0, 40) || 'untitled'}`;
      const pkgDir = join(target, dirName);
      if (existsSync(pkgDir)) {
        throw new Error(`导出子目录已存在（防覆盖）：${pkgDir}；请换一个导出目录或先移走旧包`);
      }
      mkdirSync(join(pkgDir, 'versions'), { recursive: true });
      const files: string[] = [];
      const stamp = now();
      const write = (rel: string, text: string) => {
        writeFileSync(join(pkgDir, rel), text, 'utf8');
        files.push(rel);
      };
      write(
        'master.md',
        `# ${detail.content.title}\n\n> 导出时间：${stamp} · 状态：${detail.content.status === 'master_done' ? '母稿定稿' : '母稿撰写中'}\n\n${detail.content.master_content || '（母稿为空）'}\n`,
      );
      for (const v of detail.versions) {
        write(
          `versions/${v.platform}.md`,
          `# ${detail.content.title} · ${v.platform} 版\n\n> 状态：${v.status}${v.reviewed_at ? ` · 审核于 ${v.reviewed_at}` : ''}${v.review_note ? ` · 审核备注：${v.review_note}` : ''}\n\n${v.body || '（正文为空）'}\n`,
        );
      }
      write(
        'materials.md',
        detail.materials.length === 0
          ? '# 素材\n\n（未挂素材）\n'
          : `# 素材（${detail.materials.length}）\n\n${detail.materials
              .map(
                (m) =>
                  `## ${m.title}（${m.kind}）\n\n- 来源：${m.source}${m.source_desc ? ` — ${m.source_desc}` : ''}\n- 标签：${m.tags.join('、') || '无'}\n\n${m.content}\n`,
              )
              .join('\n')}`,
      );
      write(
        'schedule.md',
        detail.calendar.length === 0
          ? '# 排期与发布\n\n（无排期）\n'
          : `# 排期与发布\n\n${detail.calendar
              .map(
                (c) =>
                  `- ${c.planned_date} · ${c.platform} · ${c.status}${c.published_at ? `（发布于 ${c.published_at}${c.publish_url ? `，${c.publish_url}` : ''}）` : ''}${c.note ? ` — ${c.note}` : ''}`,
              )
              .join('\n')}\n`,
      );
      write(
        'README.txt',
        [
          'Dayfolio 自媒体素材包',
          `内容：${detail.content.title}（id=${content_id}）`,
          `导出时间：${stamp}`,
          '',
          '流程提醒：本包只是导出物。平台版本须在 App 内经人工审核后排期；',
          '发布动作由你在各平台手动完成，发布后回填状态与链接，指标手动录入。',
          '素材包与草稿一律不写入知识库 vault。',
        ].join('\n'),
      );
      write(
        'package.json',
        JSON.stringify(
          {
            kind: 'tododesk-media-package',
            content_id,
            title: detail.content.title,
            exported_at: stamp,
            versions: detail.versions.map((v) => ({ platform: v.platform, status: v.status })),
            materials: detail.materials.map((m) => ({ id: m.id, title: m.title, kind: m.kind, source: m.source })),
          },
          null,
          2,
        ),
      );
      return {
        content_id,
        title: detail.content.title,
        dir: pkgDir,
        files,
        versions: detail.versions.length,
        materials: detail.materials.length,
      };
    },
  };

  return service;
}
