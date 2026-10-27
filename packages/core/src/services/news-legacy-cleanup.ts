import { inTx, type DbAdapter } from '../db';
import { CUSTOM_TABLE_PREFIX, quoteIdent } from '../ontology/ddl';
import { dropRelationConstraints } from '../ontology/relations';

const LEGACY_TYPES = new Set(['news_source', 'news_topic', 'news_sync_run', 'daily_brief']);

/** 升级时移除旧新闻模型；不访问文件系统，也不删除独立的创作成果。 */
export function cleanupLegacyNews(db: DbAdapter): void {
  inTx(db, () => {
    const hasTable = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const columns = (name: string) => new Set(db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all().map(row => String(row.name)));
    const clear = (name: string) => { if (hasTable(name)) db.exec(`DELETE FROM ${quoteIdent(name)}`); };
    const legacyBrief = hasTable('ont_object_types') ? db.prepare("SELECT table_name,is_system FROM ont_object_types WHERE api_name='daily_brief'").get() : undefined;

    // 只删除退役类型所属的链接和派生动作；新 news_item/news_task 及用户独立动作保留。
    const retiredLinks = hasTable('ont_link_types') ? db.prepare('SELECT api_name,left_type,right_type,link_table FROM ont_link_types').all()
      .filter(row => [row.left_type, row.right_type, row.link_table].some(type => LEGACY_TYPES.has(String(type)))) : [];
    const linkNames = new Set(retiredLinks.map(row => String(row.api_name)));
    if (hasTable('ont_action_templates')) {
      for (const template of db.prepare('SELECT action_name,target_kind,target_name FROM ont_action_templates').all()) {
        if (!((template.target_kind === 'object' && LEGACY_TYPES.has(String(template.target_name))) || (template.target_kind === 'link' && linkNames.has(String(template.target_name))))) continue;
        if (hasTable('ont_action_executions')) db.prepare('DELETE FROM ont_action_executions WHERE action_name=?').run(template.action_name);
        db.prepare('DELETE FROM ont_action_templates WHERE action_name=?').run(template.action_name);
        if (hasTable('ont_action_types')) db.prepare('DELETE FROM ont_action_types WHERE api_name=?').run(template.action_name);
      }
    }
    for (const name of linkNames) {
      dropRelationConstraints(db, name);
      db.prepare('DELETE FROM ont_link_types WHERE api_name=?').run(name);
    }
    if (legacyBrief?.table_name) {
      const table = String(legacyBrief.table_name);
      if (Number(legacyBrief.is_system) !== 0 || !table.startsWith(CUSTOM_TABLE_PREFIX)) throw new Error('旧 daily_brief 物理表不符合自定义模型规则，已停止清理');
      clear(table);
    }
    for (const type of LEGACY_TYPES) {
      if (hasTable('ont_template_preferences')) db.prepare('DELETE FROM ont_template_preferences WHERE object_type=?').run(type);
      if (hasTable('ont_object_types')) db.prepare('DELETE FROM ont_object_types WHERE api_name=?').run(type);
    }

    // 正式迁移在新服务初始化前执行；这些保护也使重复调用不会删除后来产生的模块数据。
    const feedTables = ['news_feed_state', 'news_feed_events', 'news_feed_batches', 'news_feed_tasks', 'news_feed_members', 'news_feed_feedback', 'news_feed_candidates', 'news_feed_corrections'];
    const hasFeedData = feedTables.some(name => hasTable(name) && !!db.prepare(`SELECT 1 FROM ${quoteIdent(name)} LIMIT 1`).get());
    const protectNews: string[] = [];
    if (hasTable('news') && columns('news').has('module_id')) protectNews.push("COALESCE(n.module_id,'')<>''");
    for (const name of ['news_feed_members', 'news_feed_feedback', 'news_feed_corrections']) {
      if (hasTable(name)) protectNews.push(`EXISTS(SELECT 1 FROM ${quoteIdent(name)} f WHERE f.news_id=n.id)`);
    }
    if (hasTable('news_feed_tasks')) protectNews.push('EXISTS(SELECT 1 FROM news_feed_tasks f WHERE f.task_id=n.task_id)');
    const oldNews = hasTable('news') ? db.prepare(`SELECT n.id,n.title,n.url FROM news n${protectNews.length ? ` WHERE NOT (${protectNews.join(' OR ')})` : ''}`).all() : [];
    const mediaTables = ['media_topics', 'media_materials'].filter(hasTable).map(table => ({ table, fields: columns(table) })).filter(({ fields }) => fields.has('source_news_id'));
    const stamp = new Date().toISOString();
    for (const item of oldNews) {
      const title = String(item.title), url = String(item.url), snapshot = `${title}\n${url}`;
      for (const { table, fields } of mediaTables) {
        const assignments = ['source_news_id=NULL'], params: unknown[] = [];
        if (fields.has('source_desc')) {
          assignments.push("source_desc=CASE WHEN instr(COALESCE(source_desc,''),?)>0 AND instr(COALESCE(source_desc,''),?)>0 THEN source_desc WHEN trim(COALESCE(source_desc,''))='' THEN ? ELSE source_desc || char(10) || char(10) || ? END");
          params.push(title, url, snapshot, `原新闻来源：${snapshot}`);
        }
        if (fields.has('updated_at')) { assignments.push('updated_at=?'); params.push(stamp); }
        db.prepare(`UPDATE ${quoteIdent(table)} SET ${assignments.join(',')} WHERE source_news_id=?`).run(...params, item.id);
      }
    }
    clear('news_topic_links');
    for (const item of oldNews) db.prepare('DELETE FROM news WHERE id=?').run(item.id);

    if (hasTable('news_tasks')) {
      const protectedTasks = ['EXISTS(SELECT 1 FROM news n WHERE n.task_id=t.id)'];
      if (hasTable('news_feed_tasks')) protectedTasks.push('EXISTS(SELECT 1 FROM news_feed_tasks f WHERE f.task_id=t.id)');
      for (const task of db.prepare(`SELECT t.id FROM news_tasks t WHERE NOT (${protectedTasks.join(' OR ')})`).all()) {
        if (hasTable('news_agent_runs')) db.prepare('DELETE FROM news_agent_runs WHERE task_id=?').run(task.id);
        db.prepare('DELETE FROM news_tasks WHERE id=?').run(task.id);
      }
    }
    for (const table of ['news_topics', 'news_sources', 'news_sync_runs', 'news_collection_settings']) clear(table);
    if (!hasFeedData) clear('news_deleted_fingerprints');
  });
}
