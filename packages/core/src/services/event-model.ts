// 标准事件的运行时校验、身份范围与查询快照，禁止依赖任意脚本。
import { createHash } from 'node:crypto';
import type { DbAdapter } from '../db';
import type { ExternalEventInput, ExternalEventRecord, EventSubscription, RuntimeActor } from '../runtime-types';
import { ensureValidDateStr } from '../utils/date';
import { instant, ensureTimezone, runtimeError } from '../utils/schedule';

export const canonical = (v: unknown): string => {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}';
  return runtimeError('CONTRACT_INVALID', '输入必须是有限、可序列化的 JSON 数据');
};
export const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
export const positiveRevision = (n: number) => { if (!Number.isSafeInteger(n) || n < 0) runtimeError('CONTRACT_INVALID', '修订须为非负整数'); };
const fields = new Set(['externalId', 'title', 'timeKind', 'startAt', 'endAt', 'startDate', 'endDateExclusive', 'sourceTimezone', 'status', 'sourceUrl', 'payload']);
export function normalizeEvent(input: ExternalEventInput): ExternalEventInput {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !fields.has(k))) return runtimeError('EVENT_INVALID', '事件包含未知字段或结构错误');
  for (const key of ['externalId', 'title'] as const) if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 200) return runtimeError('EVENT_INVALID', '事件标识/标题须为 1—200 字文本');
  if (!['scheduled', 'postponed', 'cancelled', 'finished'].includes(input.status)) return runtimeError('EVENT_INVALID', '未知来源状态');
  let url: URL; try { url = new URL(input.sourceUrl); } catch { return runtimeError('EVENT_INVALID', '来源 URL 不合法'); }
  if (url.protocol !== 'https:' || url.username || url.password || input.sourceUrl.length > 2048) return runtimeError('EVENT_INVALID', '来源须为不带凭据的 HTTPS 链接');
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) return runtimeError('EVENT_INVALID', '领域字段必须是 JSON 对象');
  if (Buffer.byteLength(canonical(input.payload)) > 16384) return runtimeError('EVENT_INVALID', '领域字段超过 16 KiB');
  if (input.sourceTimezone != null) ensureTimezone(input.sourceTimezone);
  for (const key of ['startAt', 'endAt', 'startDate', 'endDateExclusive'] as const) if (!Object.hasOwn(input, key)) return runtimeError('EVENT_INVALID', '四个时间字段须显式提供，未知填 null');
  const base = { externalId: input.externalId, title: input.title.trim(), status: input.status, sourceUrl: input.sourceUrl, payload: input.payload, sourceTimezone: input.sourceTimezone ?? null };
  if (input.timeKind === 'timed') {
    if (input.startDate !== null || input.endDateExclusive !== null || !input.startAt || (input.endAt !== null && typeof input.endAt !== 'string')) return runtimeError('EVENT_INVALID', '定时事件字段冲突');
    const startAt = instant(input.startAt), endAt = input.endAt === null ? null : instant(input.endAt);
    if (endAt && endAt <= startAt) return runtimeError('EVENT_INVALID', '结束时刻不晚于开始');
    return { ...base, timeKind: 'timed', startAt, endAt, startDate: null, endDateExclusive: null };
  }
  if (input.timeKind === 'all_day') {
    if (input.startAt !== null || input.endAt !== null || !input.startDate || !input.endDateExclusive) return runtimeError('EVENT_INVALID', '全天事件字段冲突');
    ensureValidDateStr(input.startDate); ensureValidDateStr(input.endDateExclusive);
    if (input.endDateExclusive <= input.startDate) return runtimeError('EVENT_INVALID', '全天区间须左闭右开且非空');
    return { ...base, timeKind: 'all_day', startAt: null, endAt: null, startDate: input.startDate, endDateExclusive: input.endDateExclusive };
  }
  if (input.timeKind === 'tbd' && input.startAt === null && input.endAt === null && input.startDate === null && input.endDateExclusive === null) return { ...base, timeKind: 'tbd', startAt: null, endAt: null, startDate: null, endDateExclusive: null };
  return runtimeError('EVENT_INVALID', '待定事件不能携带确定时间');
}
export function providerFor(db: DbAdapter, id: string, actor: RuntimeActor, capability: string, write = false) {
  const row = db.prepare('SELECT p.*,e.status AS extension_status,c.owner_extension_id FROM event_providers p JOIN extensions e ON e.id=p.extension_id JOIN calendar_collections c ON c.id=p.collection_id WHERE p.id=?').get(id);
  if (!row) return runtimeError('PROVIDER_NOT_FOUND', '数据源不存在');
  if (row.owner_extension_id !== row.extension_id) return runtimeError('CONTRACT_INVALID', '分类与数据源所有者不一致');
  if ((write || actor.extensionId) && (!row.enabled || row.extension_status !== 'active')) return runtimeError('PERMISSION_DENIED', '工具或数据源已停用');
  if (actor.extensionId && (row.extension_id !== actor.extensionId || !db.prepare('SELECT 1 FROM extension_grants WHERE extension_id=? AND capability=? AND scope=?').get(actor.extensionId, capability, id))) return runtimeError('PERMISSION_DENIED', '数据源不在实际授予范围');
  return row;
}
export function subscriptionRow(db: DbAdapter, row: Record<string, unknown>): EventSubscription {
  const revision = Number(db.prepare('SELECT revision FROM external_events WHERE id=?').get(row.event_id)!.revision);
  const applied = Number(row.applied_event_revision);
  return { id: String(row.id), eventId: String(row.event_id), todoId: row.todo_id == null ? null : Number(row.todo_id), status: row.status as EventSubscription['status'], syncMode: row.sync_mode as EventSubscription['syncMode'], appliedEventRevision: applied, pendingEventRevision: revision === applied ? null : revision };
}
export function eventRow(db: DbAdapter, row: Record<string, unknown>): ExternalEventRecord {
  const sub = db.prepare('SELECT * FROM event_subscriptions WHERE event_id=?').get(row.id);
  const input = normalizeEvent({ externalId: String(row.external_id), title: String(row.title), timeKind: row.time_kind, startAt: row.start_at, endAt: row.end_at, startDate: row.start_date, endDateExclusive: row.end_date_exclusive, sourceTimezone: row.source_timezone, status: row.status, sourceUrl: row.source_url, payload: JSON.parse(String(row.payload_json)) } as ExternalEventInput);
  return { ...input, id: String(row.id), providerId: String(row.provider_id), revision: Number(row.revision), updatedAt: String(row.updated_at), subscription: sub ? subscriptionRow(db, sub) : null };
}
export function pageOffset(db: DbAdapter, actor: RuntimeActor, query: unknown, cursor?: string): { revision: number; offset: number; fingerprint: string } {
  const revision = Number(db.prepare('SELECT revision FROM runtime_revision WHERE id=1').get()!.revision);
  const grants = actor.extensionId ? db.prepare('SELECT capability,scope,grant_revision,authorization_digest FROM extension_grants WHERE extension_id=? ORDER BY capability,scope').all(actor.extensionId) : null;
  const fingerprint = digest({ actor: actor.extensionId ?? 'host', grants, query }); let offset = 0;
  if (cursor) {
let c: { revision: number; offset: number; fingerprint: string }; try { c = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { return runtimeError('CONTRACT_INVALID', '游标不合法'); }
    if (c.revision !== revision || c.fingerprint !== fingerprint) return runtimeError('REVISION_CONFLICT', '查询条件、授权范围或数据修订已变化');
    if (!Number.isSafeInteger(c.offset) || c.offset < 0) return runtimeError('CONTRACT_INVALID', '游标位置不合法'); offset = c.offset;
  }
  return { revision, offset, fingerprint };
}
export function makePage<T>(items: T[], offset: number, limit: number, revision: number, fingerprint: string) {
  const more = items.length > limit; return { revision, items: items.slice(0, limit), nextCursor: more ? Buffer.from(JSON.stringify({ revision, fingerprint, offset: offset + limit })).toString('base64url') : null, truncated: more };
}
