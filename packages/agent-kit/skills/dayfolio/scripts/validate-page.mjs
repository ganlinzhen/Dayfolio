#!/usr/bin/env node
// 赛事页面最小契约与更新边界校验；不读取 App 数据库，也不获取网络数据。
import { readFileSync, realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const kinds = new Set(['api', 'official_page', 'web_page', 'derived', 'ai', 'user']);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));

export function validatePage(page, previous) {
  const errors = [];
  const require = (condition, message) => { if (!condition) errors.push(message); };
  if (!object(page)) return ['配置必须是 JSON 对象'];
  require(page.schemaVersion === 1, 'schemaVersion 必须为 1');
  require(text(page.pageId), '缺少稳定 pageId');
  require(Number.isInteger(page.revision) && page.revision > 0, 'revision 必须为正整数');
  require(object(page.event), '缺少赛事画像 event');
  for (const field of ['id', 'name', 'sport', 'edition', 'scope']) require(text(page.event?.[field]), `event.${field} 不能为空`);
  require(['single_sport', 'multi_sport'].includes(page.event?.scope), 'event.scope 需要区分单项与综合赛事');
  for (const field of ['participantKinds', 'modules']) require(Array.isArray(page[field]) && page[field].length > 0 && page[field].every(text) && new Set(page[field]).size === page[field].length, `${field} 必须为非空、唯一字符串数组`);
  require(object(page.preferences), '缺少 preferences');
  require(['dayfolio', 'local', 'hosted'].includes(page.target?.kind), 'target.kind 无效');
  const entry = page.target?.entry;
  require(text(entry) && !/^[/\\]|^[A-Za-z]:/.test(entry) && !entry.split(/[/\\]/).some(s => s === '..' || s === ''), 'target.entry 必须为工具包内安全相对路径');
  if (page.target?.toolId !== undefined) require(Number.isInteger(page.target.toolId) && page.target.toolId > 0, 'target.toolId 必须为真实正整数');
  const arrays = {};
  for (const key of ['stages', 'sources', 'records']) {
    const values = Array.isArray(page[key]) ? page[key] : [];
    require(Array.isArray(page[key]), `${key} 必须为数组`);
    require(values.every(v => object(v) && text(v.id)), `${key} 每项须有稳定 id`);
    require(new Set(values.map(v => v?.id)).size === values.length, `${key} 不允许重复 id`);
    arrays[key] = values.filter(object);
  }
  const checkTime = (value, label) => {
    if (value === null || value === undefined) return;
    require(timestamp(value), `${label} 必须为带时区 ISO 时间或 null`);
    if (timestamp(value)) require(Date.parse(value) <= Date.now() + 300000, `${label} 不能伪造未来获取时间`);
  };
  for (const field of ['lastCheckedAt', 'lastUpdatedAt']) checkTime(page[field], field);
  const sourceIds = new Set(arrays.sources.map(s => s.id));
  const stageIds = new Set(arrays.stages.map(s => s.id));
  for (const stage of arrays.stages) for (const field of ['name', 'format']) require(text(stage[field]), `阶段 ${stage.id} 缺少 ${field}`);
  for (const source of arrays.sources) {
    require(kinds.has(source.kind), `来源 ${source.id} 的 kind 无效`);
    require(text(source.coverage), `来源 ${source.id} 缺少覆盖范围`);
    require(['ok', 'pending', 'failed', 'stale'].includes(source.status), `来源 ${source.id} 状态无效`);
    if (source.kind === 'ai') require(text(source.prompt), `AI 来源 ${source.id} 缺少对应提示词`);
    if (source.url != null) {
      let valid = false;
      try { valid = ['https:', 'http:'].includes(new URL(source.url).protocol); } catch { /* 非网址 */ }
      require(valid, `来源 ${source.id} 网址无效`);
    }
    if (['api', 'official_page', 'web_page'].includes(source.kind)) require(text(source.url), `事实来源 ${source.id} 缺少网址`);
    checkTime(source.checkedAt, `来源 ${source.id}.checkedAt`);
    checkTime(source.lastSuccessAt, `来源 ${source.id}.lastSuccessAt`);
    if (timestamp(source.checkedAt) && timestamp(source.lastSuccessAt)) require(Date.parse(source.lastSuccessAt) <= Date.parse(source.checkedAt), `来源 ${source.id} 成功时间不能晚于检查时间`);
  }
  for (const record of arrays.records) {
    require(text(record.type) && object(record.data), `记录 ${record.id} 缺少 type/data`);
    require(sourceIds.has(record.sourceId), `记录 ${record.id} 引用了未知来源`);
    if (record.stageId != null) require(stageIds.has(record.stageId), `记录 ${record.id} 引用了未知阶段`);
    if (record.owner != null) require(['source', 'user'].includes(record.owner), `记录 ${record.id} owner 无效`);
    if (record.fieldOwners != null) require(object(record.fieldOwners) && Object.values(record.fieldOwners).every(v => ['source', 'user'].includes(v)), `记录 ${record.id} fieldOwners 无效`);
    for (const field of ['publishedAt', 'observedAt']) checkTime(record[field], `记录 ${record.id}.${field}`);
  }
  if (previous) {
    if (!object(previous) || !Array.isArray(previous.records) || !Array.isArray(previous.sources)) return [...errors, '旧配置无效，先修复或迁移后再比较'];
    require(page.pageId === previous.pageId, '数据更新不得更换 pageId');
    require(page.event?.id === previous.event?.id && page.event?.edition === previous.event?.edition, '数据更新不得切换赛事或届次');
    require(isDeepStrictEqual(page.target, previous.target), '数据更新不得更换交付目标');
    require(isDeepStrictEqual(page.preferences, previous.preferences), '数据更新不得覆盖用户偏好');
    if (!isDeepStrictEqual(page, previous)) require(page.revision > previous.revision, '配置变化后 revision 必须递增');
    else require(page.revision === previous.revision, '相同快照应保留 revision');
    const incoming = new Map(arrays.records.map(r => [r.id, r]));
    for (const old of previous.records) {
      const next = incoming.get(old.id);
      if (old.owner === 'user') require(isDeepStrictEqual(old, next), `人工记录 ${old.id} 被覆盖或删除`);
      for (const [field, owner] of Object.entries(old.fieldOwners || {})) {
        if (owner === 'user') require(next?.fieldOwners?.[field] === 'user' && isDeepStrictEqual(old.data?.[field], next?.data?.[field]), `记录 ${old.id} 的人工字段 ${field} 被覆盖或删除`);
      }
    }
    for (const old of previous.sources) {
      const next = arrays.sources.find(s => s.id === old.id);
      if (next?.status === 'failed') require(next.lastSuccessAt === old.lastSuccessAt, `来源 ${old.id} 失败时不得前移成功时间`);
    }
    const facts = rows => rows.map(r => ({ id:r.id, type:r.type, stageId:r.stageId, data:r.data })).sort((a,b) => a.id.localeCompare(b.id));
    if (isDeepStrictEqual(facts(page.records || []), facts(previous.records))) require(page.lastUpdatedAt === previous.lastUpdatedAt, '无事实变化不得更新 lastUpdatedAt');
    else require(timestamp(page.lastUpdatedAt) && page.lastUpdatedAt !== previous.lastUpdatedAt && (!timestamp(previous.lastUpdatedAt) || Date.parse(page.lastUpdatedAt) >= Date.parse(previous.lastUpdatedAt)), '事实变化后需要新的 lastUpdatedAt');
  }
  return errors;
}

// 技能发现入口通常是目录软链接，需比较解析后的路径，避免静默跳过命令行校验。
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try {
    if (!process.argv[2]) throw new Error('用法：node validate-page.mjs <sports-page.json> [旧配置.json]');
    const page = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const old = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : undefined;
    const errors = validatePage(page, old);
    console.log(JSON.stringify({ ok:errors.length === 0, pageId:page.pageId, revision:page.revision, errors }, null, 2));
    process.exitCode = errors.length ? 1 : 0;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
