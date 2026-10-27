// 每日模块记录保存采集批次的并集；读取不回写状态，AI 总结单独绑定已核实新闻与修订。
import { createHash } from 'node:crypto';
import { inTx, mapNews, readSnapshot, type DbAdapter } from '../db';
import type { NewsDailyEdition, NewsDailyEditionDetailQuery, NewsDailyEditionPage, NewsDailyEditionQuery, NewsDailyEditionSummaryInput, NewsFeedItem, NewsTaskDailyEdition } from '../news-types';

const EDITION_ROWS = `INSERT INTO news_daily_editions(id,date,module_id,module_name,created_at,updated_at)
  SELECT date(json_extract(b.data_json,'$.created_at'),'+8 hours') || ':' || json_extract(m.value,'$.module_id'),
    date(json_extract(b.data_json,'$.created_at'),'+8 hours'),json_extract(m.value,'$.module_id'),json_extract(m.value,'$.name'),
    json_extract(b.data_json,'$.created_at'),COALESCE(json_extract(b.data_json,'$.finished_at'),json_extract(b.data_json,'$.created_at'))
  FROM news_feed_batches b,json_each(b.data_json,'$.modules') m`;

/** 只由版本迁移调用；回填保留所有既有新闻，不重新解释其发布时间或学习状态。 */
export function migrateNewsDailyEditions(db: DbAdapter): void {
  db.exec(`CREATE TABLE news_daily_editions (
    id TEXT PRIMARY KEY,date TEXT NOT NULL,module_id TEXT NOT NULL,module_name TEXT NOT NULL,
    summary TEXT,summary_news_ids_json TEXT NOT NULL DEFAULT '[]',summary_basis_digest TEXT,
    summary_source_revision INTEGER,revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(date,module_id)
  );
  CREATE TABLE news_daily_edition_members (
    edition_id TEXT NOT NULL REFERENCES news_daily_editions(id) ON DELETE CASCADE,
    news_id INTEGER NOT NULL,added_at TEXT NOT NULL,PRIMARY KEY(edition_id,news_id)
  );
  CREATE INDEX news_daily_edition_date ON news_daily_editions(date DESC,module_id);
  CREATE INDEX news_daily_edition_news ON news_daily_edition_members(news_id);
  ${EDITION_ROWS} ORDER BY json_extract(b.data_json,'$.created_at'),b.rowid
    ON CONFLICT(date,module_id) DO UPDATE SET module_name=excluded.module_name,updated_at=MAX(news_daily_editions.updated_at,excluded.updated_at);
  INSERT OR IGNORE INTO news_daily_edition_members(edition_id,news_id,added_at)
    SELECT date(json_extract(b.data_json,'$.created_at'),'+8 hours') || ':' || f.module_id,f.news_id,json_extract(b.data_json,'$.created_at')
    FROM news_feed_members f JOIN news_feed_batches b ON b.id=f.batch_id;
  UPDATE news_daily_editions SET revision=(SELECT COUNT(*) FROM news_daily_edition_members m WHERE m.edition_id=news_daily_editions.id);
  CREATE TRIGGER news_daily_batch_insert AFTER INSERT ON news_feed_batches BEGIN
    ${EDITION_ROWS} WHERE b.id=NEW.id
      ON CONFLICT(date,module_id) DO UPDATE SET module_name=excluded.module_name,updated_at=MAX(news_daily_editions.updated_at,excluded.updated_at);
  END;
  CREATE TRIGGER news_daily_batch_update AFTER UPDATE OF data_json ON news_feed_batches BEGIN
    ${EDITION_ROWS} WHERE b.id=NEW.id
      ON CONFLICT(date,module_id) DO UPDATE SET module_name=excluded.module_name,updated_at=MAX(news_daily_editions.updated_at,excluded.updated_at);
  END;
  CREATE TRIGGER news_daily_member_insert AFTER INSERT ON news_feed_members BEGIN
    INSERT OR IGNORE INTO news_daily_edition_members(edition_id,news_id,added_at)
      SELECT date(json_extract(b.data_json,'$.created_at'),'+8 hours') || ':' || NEW.module_id,NEW.news_id,
        strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM news_feed_batches b WHERE b.id=NEW.batch_id;
  END;
  CREATE TRIGGER news_daily_member_revision AFTER INSERT ON news_daily_edition_members BEGIN
    UPDATE news_daily_editions SET revision=revision+1,updated_at=MAX(updated_at,NEW.added_at) WHERE id=NEW.edition_id;
  END;
  CREATE TRIGGER news_daily_news_delete AFTER DELETE ON news BEGIN
    UPDATE news_daily_editions SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id IN (SELECT edition_id FROM news_daily_edition_members WHERE news_id=OLD.id);
  END;
  CREATE TRIGGER news_daily_news_content AFTER UPDATE OF title,summary,published_at,url,background,impact,uncertainty ON news BEGIN
    UPDATE news_daily_editions SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id IN (SELECT edition_id FROM news_daily_edition_members WHERE news_id=NEW.id);
  END;
  CREATE TRIGGER news_daily_news_correction AFTER INSERT ON news_feed_corrections BEGIN
    UPDATE news_daily_editions SET revision=revision+1,updated_at=NEW.created_at
      WHERE id IN (SELECT edition_id FROM news_daily_edition_members WHERE news_id=NEW.news_id);
  END;`);
}

export function createNewsDailyEditionService(db: DbAdapter) {
  const row = (id: string) => { const value = db.prepare('SELECT * FROM news_daily_editions WHERE id=?').get(id); if (!value) throw new Error('每日模块记录不存在'); return value; };
  const corrections = (id: number) => db.prepare('SELECT * FROM news_feed_corrections WHERE news_id=? ORDER BY created_at DESC').all(id).map(c => ({ id: String(c.id), news_id: Number(c.news_id), summary: String(c.summary), evidence_url: String(c.evidence_url), created_at: String(c.created_at), acknowledged: !!c.acknowledged }));
  const allItems = (id: string): NewsFeedItem[] => db.prepare(`SELECT n.*,
    EXISTS(SELECT 1 FROM news_feed_feedback f WHERE f.news_id=n.id AND f.kind='hide') AS hidden
    FROM news_daily_edition_members m JOIN news n ON n.id=m.news_id WHERE m.edition_id=?
    ORDER BY COALESCE(n.published_at,n.published_date) DESC,n.id DESC`).all(id).map(n => ({ ...mapNews(n), hidden: !!n.hidden, corrections: corrections(Number(n.id)) }));
  const digest = (items: NewsFeedItem[], ids: number[]): string | null => {
    const sources = ids.map(id => items.find(item => item.id === id));
    if (sources.some(source => !source || source.hidden)) return null;
    return createHash('sha256').update(JSON.stringify(sources.map(source => {
      const item = source!; return [item.id,item.title,item.summary,item.url,item.published_at,item.background,item.impact,item.uncertainty,item.corrections.map(c => [c.id,c.summary,c.evidence_url])];
    }))).digest('hex');
  };
  const matches = (item: NewsFeedItem, query: NewsDailyEditionQuery): boolean => {
    if (query.filter === 'hidden' ? !item.hidden : item.hidden) return false;
    if (query.filter === 'unread' && item.is_read) return false;
    if (query.filter === 'starred' && !item.is_starred) return false;
    const search = query.search?.trim().toLocaleLowerCase();
    return !search || [item.title,item.summary,item.background,item.impact,item.source_name].some(value => value?.toLocaleLowerCase().includes(search));
  };
  const validateQuery = (query: NewsDailyEditionQuery, defaultLimit: number) => {
    if (query.filter && !['all','unread','starred','hidden'].includes(query.filter)) throw new Error('新闻筛选无效');
    if (query.search != null && (typeof query.search !== 'string' || query.search.length > 500)) throw new Error('新闻搜索内容过长');
    const limit = query.limit ?? defaultLimit, offset = query.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0) throw new Error('新闻分页范围无效');
    return { limit, offset };
  };
  const project = (source: Record<string, unknown>, items: NewsFeedItem[], query: NewsDailyEditionQuery): NewsDailyEdition => {
    const ids = JSON.parse(String(source.summary_news_ids_json)) as number[];
    const currentDigest = ids.length ? digest(items, ids) : null;
    const changedSources = !!source.summary && (!currentDigest || currentDigest !== source.summary_basis_digest);
    const summary = changedSources ? null : source.summary == null ? null : String(source.summary);
    return { id: String(source.id), date: String(source.date), module_id: String(source.module_id), module_name: String(source.module_name),
      summary, summary_news_ids: ids, summary_status: !source.summary ? 'pending' : changedSources || Number(source.summary_source_revision) !== Number(source.revision) ? 'stale' : 'ready',
      news_count: items.length, matching_count: items.filter(item => matches(item, query)).length,
      unread_count: items.filter(item => !item.hidden && !item.is_read).length, starred_count: items.filter(item => !item.hidden && item.is_starred).length,
      hidden_count: items.filter(item => item.hidden).length, revision: Number(source.revision), created_at: String(source.created_at), updated_at: String(source.updated_at),
      preview_titles: items.filter(item => matches(item, query)).slice(0,3).map(item => item.title) };
  };
  const listDailyEditions = (query: NewsDailyEditionQuery = {}): NewsDailyEdition[] => readSnapshot(db, () => {
    const { limit, offset } = validateQuery(query, 100);
    const config = db.prepare('SELECT config_json FROM news_feed_state WHERE id=1').get();
    const modules: Array<{ id: string }> = config ? JSON.parse(String(config.config_json)).modules : [];
    const conditions = ["m.edition_id=e.id", `${query.filter === 'hidden' ? '' : 'NOT '}EXISTS(SELECT 1 FROM news_feed_feedback f WHERE f.news_id=n.id AND f.kind='hide')`];
    const params: unknown[] = [];
    if(query.filter==='unread') conditions.push('n.is_read=0');
    if(query.filter==='starred') conditions.push('n.is_starred=1');
    if(query.search?.trim()) {
      conditions.push(`(${['title','summary','background','impact','source_name'].map(field=>`(instr(COALESCE(n.${field},''),?)>0 OR instr(lower(COALESCE(n.${field},'')),?)>0)`).join(' OR ')})`);
      params.push(...Array.from({length:5},()=>[query.search!.trim(),query.search!.trim().toLocaleLowerCase()]).flat());
    }
    let where=`EXISTS(SELECT 1 FROM news_daily_edition_members m JOIN news n ON n.id=m.news_id WHERE ${conditions.join(' AND ')})`;
    if(!query.search?.trim()&&(!query.filter||query.filter==='all')) where+=` OR NOT EXISTS(SELECT 1 FROM news_daily_edition_members m JOIN news n ON n.id=m.news_id WHERE m.edition_id=e.id)`;
    const order=modules.length ? `CASE e.module_id ${modules.map((_,index)=>`WHEN ? THEN ${index}`).join(' ')} ELSE 100 END` : '100';
    params.push(...modules.map(module=>module.id),limit,offset);
    // 先在数据库内筛选、排序和分页，正文及依据摘要只为这一页投影，不扫描多年归档的全部新闻。
    return db.prepare(`SELECT e.* FROM news_daily_editions e WHERE (${where}) ORDER BY e.date DESC,${order},e.id LIMIT ? OFFSET ?`).all(...params)
      .map(source=>project(source,allItems(String(source.id)),query));
  });
  const getDailyEdition = (query: NewsDailyEditionDetailQuery): NewsDailyEditionPage => readSnapshot(db, () => {
    const { limit, offset } = validateQuery(query, 10), source = row(query.id), items = allItems(query.id), edition = project(source,items,query);
    const priorities = new Map(edition.summary_news_ids.map((id,index) => [id,index]));
    const matched = items.filter(item => matches(item,query)).sort((a,b) => (priorities.get(a.id) ?? 100) - (priorities.get(b.id) ?? 100));
    return { edition,items:matched.slice(offset,offset+limit),total:matched.length,has_more:offset+limit<matched.length };
  });
  const saveDailyEditionSummary = (input: NewsDailyEditionSummaryInput): NewsDailyEdition => inTx(db, () => {
    const source = row(input.edition_id);
    if (!Number.isInteger(input.expected_revision) || Number(source.revision) !== input.expected_revision) throw new Error('每日模块内容已更新，请重新读取后整理总结');
    if (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 2000) throw new Error('模块重点总结须为不超过2000字的非空内容');
    if (!Array.isArray(input.news_ids) || input.news_ids.length < 1 || input.news_ids.length > 30 || input.news_ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('总结依据须为1~30个有效新闻身份');
    const ids = [...new Set(input.news_ids)], items = allItems(input.edition_id), basis = digest(items,ids);
    if (!basis) throw new Error('总结依据不属于当前每日模块，或已被隐藏、删除');
    const revision = Number(source.revision) + 1;
    db.prepare('UPDATE news_daily_editions SET summary=?,summary_news_ids_json=?,summary_basis_digest=?,summary_source_revision=?,revision=?,updated_at=? WHERE id=?')
      .run(input.summary.trim(),JSON.stringify(ids),basis,revision,revision,new Date().toISOString(),input.edition_id);
    return project(row(input.edition_id),items,{});
  });
  const forTask = (createdAt: string, moduleId: string, taskId: number): NewsTaskDailyEdition => {
    const date = new Date(Date.parse(createdAt) + 8*3600_000).toISOString().slice(0,10), id = `${date}:${moduleId}`;
    const page = getDailyEdition({ id,limit:1000 });
    // 新消息优先，确保后续更新不会只拿到当天早期的旧消息；摘要依据也必须保留在公开上下文内。
    const items = [...page.items].sort((a,b) => (b.fetched_at || '').localeCompare(a.fetched_at || '') || b.id-a.id);
    const basis = page.edition.summary_news_ids.map(id => items.find(item => item.id===id)).filter((item): item is NewsFeedItem => !!item);
    const current = items.filter(item => item.task_id===taskId);
    const visible = [...new Map([...current,...items.slice(0,10),...basis,...items].map(item => [item.id,item])).values()].slice(0,30);
    return { edition:page.edition,news:visible.map(({id,title,summary,published_at,url,corrections}) => ({id,title,summary,published_at:published_at ?? null,url,corrections})) };
  };
  return { listDailyEditions,getDailyEdition,saveDailyEditionSummary,forTask };
}
