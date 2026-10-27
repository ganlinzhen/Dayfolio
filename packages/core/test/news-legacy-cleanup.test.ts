import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCore, openNodeSqliteDb } from '../src';
import type { DbAdapter } from '../src/db';
import { cleanupLegacyNews } from '../src/services/news-legacy-cleanup';
import { createOntologyService } from '../src/ontology/registry';
import { createObjectRepo } from '../src/ontology/repo';
import { mkCore, mkLegacyDb } from './helpers';

const stamp = '2026-10-27T00:00:00.000Z';
function seedLegacy(db: DbAdapter, dbPath: string) {
  db.prepare("INSERT INTO news_tasks(id,title,instructions,created_at,updated_at) VALUES(41,'旧采集任务','旧提示词',?,?)").run(stamp, stamp);
  db.prepare("INSERT INTO news_agent_runs(id,task_id,status,progress,created_at) VALUES('legacy-run',41,'succeeded','旧执行',?)").run(stamp);
  db.prepare("INSERT INTO news(id,source,title,url,summary,published_date,fetched_at,dedup_key,is_read,is_starred,task_id,content_kind,html_rel) VALUES(51,'agent','旧新闻标题','https://example.com/legacy','旧摘要','2026-10-27',?,'legacy-cleanup',1,1,41,'html','legacy.html')").run(stamp);
  db.prepare("INSERT INTO news_sources(id,name) VALUES('legacy-source','旧来源')").run();
  db.prepare("INSERT INTO news_topics(id,source_id,name,query) VALUES(61,'legacy-source','旧话题','旧检索')").run();
  db.prepare('INSERT INTO news_topic_links(news_id,topic_id) VALUES(51,61)').run();
  db.prepare("INSERT INTO news_sync_runs(scope,status,created_at) VALUES('旧同步','completed',?)").run(stamp);
  db.prepare("INSERT INTO news_collection_settings(id,prompt,max_items,window_hours,revision,updated_at) VALUES(1,'旧长期提示词',11,24,2,?)").run(stamp);
  db.prepare("INSERT INTO news_deleted_fingerprints(fingerprint,deleted_at) VALUES('legacy-fingerprint',?)").run(stamp);
  db.prepare("INSERT INTO media_topics(id,title,source,source_news_id,source_desc,created_at,updated_at) VALUES(71,'独立创作选题','news',51,'用户原有备注',?,?)").run(stamp, stamp);
  db.prepare("INSERT INTO media_materials(id,title,content,source,source_news_id,created_at,updated_at) VALUES(81,'独立素材','素材正文','news',51,?,?)").run(stamp, stamp);
  db.prepare("INSERT INTO media_contents(id,topic_id,title,master_content,created_at,updated_at) VALUES(91,71,'独立母稿','母稿正文',?,?)").run(stamp, stamp);
  db.prepare("INSERT INTO media_content_versions(id,content_id,platform,body,created_at,updated_at) VALUES(101,91,'wechat','平台稿正文',?,?)").run(stamp, stamp);
  db.prepare('INSERT INTO media_content_materials(content_id,material_id) VALUES(91,81)').run();
  for (const [name, table] of [['news_source', 'news_sources'], ['news_topic', 'news_topics'], ['news_sync_run', 'news_sync_runs'], ['news_item', 'news'], ['news_task', 'news_tasks']]) {
    db.prepare("INSERT INTO ont_object_types(api_name,title,table_name,is_system,title_property,properties,created_at,updated_at) VALUES(?,?,?,1,'title','[]',?,?)").run(name, name, table, stamp, stamp);
  }
  db.prepare("INSERT INTO ont_link_types(api_name,title,left_type,right_type,cardinality,created_at) VALUES('retired_topic_link','旧新闻话题链接','news_item','news_topic','many_to_many',?)").run(stamp);
  db.prepare("INSERT INTO ont_link_types(api_name,title,left_type,right_type,cardinality,fk_column,created_at) VALUES('news_item__media_topic','新闻创作选题','news_item','media_topic','one_to_many','source_news_id',?)").run(stamp);
  for (const [action, target] of [['derived_legacy_topic', 'news_topic'], ['keep_news_task_action', 'news_task']]) {
    db.prepare("INSERT INTO ont_action_types(api_name,title,parameters,operations,created_at,updated_at) VALUES(?,?,'[]','[]',?,?)").run(action, action, stamp, stamp);
    db.prepare("INSERT INTO ont_action_templates(action_name,target_kind,target_name,operation,schema_digest) VALUES(?,'object',?,'create','fixture')").run(action, target);
  }
  db.prepare("INSERT INTO ont_template_preferences(object_type,enabled) VALUES('news_topic',0)").run();
  db.prepare("INSERT INTO ont_action_types(api_name,title,parameters,operations,created_at,updated_at) VALUES('derived_legacy_link','旧链接动作','[]','[]',?,?)").run(stamp, stamp);
  db.prepare("INSERT INTO ont_action_templates(action_name,target_kind,target_name,operation,schema_digest) VALUES('derived_legacy_link','link','retired_topic_link','link','fixture')").run();
  db.exec("CREATE TRIGGER ont_retired_topic_link_left_delete BEFORE DELETE ON news WHEN EXISTS(SELECT 1 FROM news_topic_links WHERE news_id=OLD.id) BEGIN SELECT RAISE(ABORT,'旧关系限制'); END");
  const assets = join(dirname(dbPath), 'news'); mkdirSync(assets, { recursive: true });
  const html = join(assets, 'legacy.html'); writeFileSync(html, '<h1>旧新闻资产备份</h1>');
  return html;
}

describe('旧新闻模型清理', () => {
  it('v29 升级清空旧新闻与专属本体，保留自媒体来源快照并能使用新模块', () => {
    const legacy = mkLegacyDb(29);
    try {
      const ontology = createOntologyService(legacy.db);
      const briefDef = ontology.createObjectType({ apiName: 'daily_brief', title: '每日简报', description: '北京时间每天 7 点的旧完整简报', properties: [{ apiName: 'title', dataType: 'string' }, { apiName: 'news_ids', dataType: 'json' }, { apiName: 'task_id', dataType: 'integer' }] });
      const objects = createObjectRepo(legacy.db, ontology);
      objects.insert('daily_brief', { title: '旧完整简报', news_ids: [51], task_id: 41 });
      const preserved = ontology.createObjectType({ apiName: 'reading_archive', title: '独立阅读资料', properties: [{ apiName: 'title', dataType: 'string' }] });
      objects.insert('reading_archive', { title: '与新闻无关的资料' });
      expect(legacy.db.prepare("SELECT COUNT(*) AS n FROM ont_action_templates WHERE target_kind='object' AND target_name='daily_brief'").get()?.n).toBe(3);
      const html = seedLegacy(legacy.db, legacy.dbPath);
      const core = createCore(legacy.db, { dbPath: legacy.dbPath });
      for (const table of ['news', 'news_tasks', 'news_agent_runs', 'news_sources', 'news_topics', 'news_topic_links', 'news_sync_runs', 'news_deleted_fingerprints']) expect(legacy.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
      expect(legacy.db.prepare("SELECT 1 FROM news_collection_settings WHERE prompt='旧长期提示词'").get()).toBeUndefined();
      for (const table of ['media_topics', 'media_materials']) {
        const row = legacy.db.prepare(`SELECT * FROM ${table}`).get()!;
        expect(row.source_news_id).toBeNull(); expect(row.source_desc).toContain('旧新闻标题'); expect(row.source_desc).toContain('https://example.com/legacy');
      }
      expect(legacy.db.prepare('SELECT source_desc FROM media_topics').get()?.source_desc).toContain('用户原有备注');
      expect(legacy.db.prepare('SELECT master_content FROM media_contents').get()?.master_content).toBe('母稿正文');
      expect(legacy.db.prepare('SELECT body FROM media_content_versions').get()?.body).toBe('平台稿正文');
      expect(legacy.db.prepare('SELECT COUNT(*) AS n FROM media_content_materials').get()?.n).toBe(1);
      expect(existsSync(html)).toBe(true);
      expect(core.ontology.listObjectTypes().some(type => ['news_source', 'news_topic', 'news_sync_run', 'daily_brief'].includes(type.apiName))).toBe(false);
      expect(legacy.db.prepare(`SELECT COUNT(*) AS n FROM "${briefDef.tableName}"`).get()?.n).toBe(0);
      expect(legacy.db.prepare("SELECT 1 FROM ont_action_types WHERE api_name IN ('object_daily_brief_create','object_daily_brief_update','object_daily_brief_delete')").get()).toBeUndefined();
      expect(legacy.db.prepare("SELECT 1 FROM ont_action_templates WHERE target_name='daily_brief'").get()).toBeUndefined();
      expect(legacy.db.prepare(`SELECT title FROM "${preserved.tableName}"`).get()?.title).toBe('与新闻无关的资料');
      expect(core.ontology.listObjectTypes().some(type => type.apiName === 'news_item')).toBe(true);
      expect(core.ontology.listObjectTypes().some(type => type.apiName === 'news_task')).toBe(true);
      expect(legacy.db.prepare("SELECT 1 FROM ont_link_types WHERE api_name='retired_topic_link'").get()).toBeUndefined();
      expect(legacy.db.prepare("SELECT 1 FROM ont_action_types WHERE api_name IN ('derived_legacy_topic','derived_legacy_link')").get()).toBeUndefined();
      const batch = core.newsFeed.startUpdate(), claim = core.news.claimTask(batch.next_task_id!);
      const submitted = core.news.submitItems(claim.task.id, claim.claim_token, [{ title: '升级后新模块新闻', summary: '按新模块独立整理的事实。', source_url: 'https://example.com/new-module', published_at: new Date(Date.now() - 60000).toISOString() }]);
      expect(submitted.inserted).toBe(1); expect(submitted.items[0].module_id).toBe('domestic');
      expect(core.newsFeed.getInterests().topics).toEqual([]);
      expect(legacy.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { legacy.cleanup(); }
  });

  it('直接清理可重复执行，不删除后来产生的模块任务、新闻或学习数据', () => {
    const { core, cleanup } = mkCore();
    try {
      const batch = core.newsFeed.startUpdate(), claim = core.news.claimTask(batch.next_task_id!);
      const n = core.news.submitItems(claim.task.id, claim.claim_token, [{ title: '新模块受保护新闻', summary: '保留新采集结果。', source_url: 'https://example.com/keep-module', published_at: new Date(Date.now() - 60000).toISOString() }]).items[0];
      const before = core.db.prepare('SELECT data_json FROM news_feed_batches WHERE id=?').get(batch.id)?.data_json;
      cleanupLegacyNews(core.db); cleanupLegacyNews(core.db);
      expect(core.news.list().map(item => item.id)).toEqual([n.id]);
      expect(core.news.getTask(claim.task.id).status).toBe('claimed');
      expect(core.db.prepare('SELECT data_json FROM news_feed_batches WHERE id=?').get(batch.id)?.data_json).toBe(before);
      expect(core.newsFeed.getTaskContext(claim.task.id)?.accepted_ids).toEqual([n.id]);
    } finally { cleanup(); }
  });

  it('清理失败整体回滚，空库安全且不访问资产目录', () => {
    const legacy = mkLegacyDb(29);
    try {
      const html = seedLegacy(legacy.db, legacy.dbPath);
      legacy.db.exec("CREATE TRIGGER stop_legacy_cleanup BEFORE DELETE ON news BEGIN SELECT RAISE(ABORT,'模拟清理失败'); END");
      expect(() => cleanupLegacyNews(legacy.db)).toThrow('模拟清理失败');
      expect(legacy.db.prepare('SELECT COUNT(*) AS n FROM news').get()?.n).toBe(1);
      expect(legacy.db.prepare('SELECT source_news_id FROM media_topics').get()?.source_news_id).toBe(51);
      expect(legacy.db.prepare("SELECT 1 FROM ont_object_types WHERE api_name='news_topic'").get()).toBeTruthy();
      expect(existsSync(html)).toBe(true);
    } finally { legacy.cleanup(); }
    const empty = openNodeSqliteDb(':memory:');
    try { expect(() => cleanupLegacyNews(empty)).not.toThrow(); } finally { empty.close(); }
  });
});
