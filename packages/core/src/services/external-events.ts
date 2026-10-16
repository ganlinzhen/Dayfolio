// 标准事件入库、可重放批次与范围查询；不在数据库事务里执行网络操作。
import { randomUUID } from 'node:crypto';
import { inTx, readSnapshot, type DbAdapter } from '../db';
import type { EventImportInput, EventImportResult, EventListInput, RuntimeActor, SubscriptionInput } from '../runtime-types';
import { normalizeEvent, eventRow, providerFor, digest, pageOffset, makePage, positiveRevision, canonical } from './event-model';
import { runtimeError, dateInZone, displayTimezone } from '../utils/schedule';
import { ensureValidDateStr } from '../utils/date';
import type { ProviderRefreshApi, RefreshContext } from '../provider-types';

export function createExternalEventService(db: DbAdapter, onChanged: (eventId: string) => void, actor: RuntimeActor = {}, importCapability:'events.import'|'providers.refresh'='events.import') {
  const load = (id: string, capability = 'events.read', write = false) => {
    const row = db.prepare('SELECT * FROM external_events WHERE id=?').get(id); if (!row) return runtimeError('EVENT_NOT_FOUND', '事件不存在');
    providerFor(db, String(row.provider_id), actor, capability, write); return row;
  };
  const get = (input: SubscriptionInput) => readSnapshot(db, () => eventRow(db, load(input.eventId)));
  const listProviders = () => readSnapshot(db, () => db.prepare('SELECT * FROM event_providers ORDER BY id').all().filter(p => !actor.extensionId || p.extension_id === actor.extensionId).map(p => { providerFor(db, String(p.id), actor, 'events.read'); return { id: String(p.id), extensionId: String(p.extension_id), collectionId: String(p.collection_id), kind: String(p.kind), revision: Number(p.revision), enabled: Boolean(p.enabled), config: JSON.parse(String(p.config_json)),refreshSeconds:p.refresh_seconds==null?null:Number(p.refresh_seconds) }; }));
  const importEvents = (input: EventImportInput): EventImportResult => inTx(db, () => {
    const provider = providerFor(db, input.providerId, actor, importCapability, true); positiveRevision(input.expectedProviderRevision);
    if (typeof input.batchId !== 'string' || !input.batchId.trim() || input.batchId.length > 200 || !Array.isArray(input.events) || input.events.length > 500) runtimeError('CONTRACT_INVALID', '批次标识或数量不合法');
    const raw = canonical(input.events); if (Buffer.byteLength(raw) > 5 * 1024 * 1024) runtimeError('CONTRACT_INVALID', '批次超过 5 MiB');
    const hash = digest(input.events); const replay = db.prepare('SELECT input_digest,result_json FROM provider_sync_runs WHERE provider_id=? AND batch_id=?').get(input.providerId, input.batchId);
    if (replay) { if (replay.input_digest !== hash) runtimeError('BATCH_CONTENT_CONFLICT', '同一批次 ID 不可提交不同内容'); return JSON.parse(String(replay.result_json)) as EventImportResult; }
    if (Number(provider.revision) !== input.expectedProviderRevision) runtimeError('REVISION_CONFLICT', '数据源基线已变化，请重新获取来源');
    const events = input.events.map(normalizeEvent); if (new Set(events.map(e => e.externalId)).size !== events.length) runtimeError('EVENT_INVALID', '一个批次不能包含重复事件标识');
    let created = 0, updated = 0, unchanged = 0; const now = new Date().toISOString();
    for (const event of events) {
      const existing = db.prepare('SELECT * FROM external_events WHERE provider_id=? AND external_id=?').get(input.providerId, event.externalId);
      const values = { title: event.title, time_kind: event.timeKind, start_at: event.startAt, end_at: event.endAt, start_date: event.startDate, end_date_exclusive: event.endDateExclusive, source_timezone: event.sourceTimezone ?? null, status: event.status, source_url: event.sourceUrl, payload_json: canonical(event.payload) };
      if (existing && Object.entries(values).every(([key, value]) => existing[key] === value)) { unchanged++; continue; }
      const id = existing ? String(existing.id) : randomUUID();
      if (existing) { db.prepare(`UPDATE external_events SET ${Object.keys(values).map(k => k + '=?').join(',')},revision=revision+1,updated_at=? WHERE id=?`).run(...Object.values(values), now, id); updated++; }
      else { const row = { id, provider_id: input.providerId, external_id: event.externalId, ...values, created_at: now, updated_at: now }; db.prepare(`INSERT INTO external_events (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row)); created++; }
      onChanged(id);
    }
    const revision = Number(provider.revision) + (created + updated > 0 ? 1 : 0);
    if (created + updated > 0) db.prepare('UPDATE event_providers SET revision=?,updated_at=? WHERE id=?').run(revision, now, input.providerId);
    const result = { batchId: input.batchId, revision, created, updated, unchanged };
    db.prepare('INSERT INTO provider_sync_runs(id,provider_id,batch_id,base_revision,status,input_digest,result_json,created_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), input.providerId, input.batchId, input.expectedProviderRevision, 'succeeded', hash, JSON.stringify(result), now, now);
    // 外部助手实际导入后才完成同一基线的请求；排队本身不表示已执行 AI。
    for(const run of db.prepare("SELECT * FROM provider_sync_runs WHERE provider_id=? AND request_kind='external' AND status='queued'").all(input.providerId)){
      const context=JSON.parse(String(run.context_json)) as RefreshContext;
      const extension=db.prepare('SELECT revision,active_release_id,status FROM extensions WHERE id=?').get(provider.extension_id);
      const grants=db.prepare('SELECT capability,scope,grant_revision,authorization_digest FROM extension_grants WHERE extension_id=? ORDER BY capability,scope').all(provider.extension_id);
      const valid=context.providerRevision===Number(provider.revision)&&context.extensionRevision===Number(extension?.revision)&&context.releaseId===extension?.active_release_id&&extension?.status==='active'&&context.grantDigest===digest(grants);
      db.prepare('UPDATE provider_sync_runs SET status=?,result_json=?,error=?,finished_at=? WHERE id=?').run(valid?'succeeded':'cancelled',valid?JSON.stringify(result):null,valid?null:JSON.stringify({code:'REVISION_CONFLICT',message:'等待更新期间来源或授权已改变，请核对当前导入结果',retryable:false}),now,run.id);
    }
    return result;
  });
  const list = (input: EventListInput) => readSnapshot(db, () => {
    providerFor(db, input.providerId, actor, 'events.read');
    const limit = input.limit ?? 100; if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) runtimeError('CONTRACT_INVALID', '分页范围为 1—500');
    if (input.fromDate !== undefined) ensureValidDateStr(input.fromDate); if (input.toDateExclusive !== undefined) ensureValidDateStr(input.toDateExclusive);
    if (input.fromDate && input.toDateExclusive && (input.toDateExclusive <= input.fromDate || (Date.parse(input.toDateExclusive) - Date.parse(input.fromDate)) / 86400000 > 100)) runtimeError('RANGE_TOO_LARGE', '日期区间须非空且不超过 100 天');
    if (input.status && !['scheduled', 'postponed', 'cancelled', 'finished'].includes(input.status)) runtimeError('CONTRACT_INVALID', '未知活动状态');
    const query = { providerId: input.providerId, fromDate: input.fromDate ?? null, toDateExclusive: input.toDateExclusive ?? null, status: input.status ?? null };
    const page = pageOffset(db, actor, query, input.cursor); const zone = displayTimezone(db);
    // 时间筛选先统一成显示时区日期；分页与计数保持同一只读快照。
    const rows = db.prepare('SELECT * FROM external_events WHERE provider_id=? AND archived=0 ORDER BY id').all(input.providerId).map(row => eventRow(db, row)).filter(e => {
      if (input.status && e.status !== input.status) return false;
      if (e.timeKind === 'tbd') return !input.fromDate && !input.toDateExclusive;
      const start = e.timeKind === 'timed' ? dateInZone(e.startAt, zone) : e.startDate;
      const end = e.timeKind === 'timed' ? (e.endAt ? dateInZone(new Date(Date.parse(e.endAt) - 1), zone) : start) : new Date(Date.parse(e.endDateExclusive) - 86400000).toISOString().slice(0, 10);
      return (!input.fromDate || end >= input.fromDate) && (!input.toDateExclusive || start < input.toDateExclusive);
    });
    return makePage(rows.slice(page.offset, page.offset + limit + 1), page.offset, limit, page.revision, page.fingerprint);
  });
  const archive = (input: SubscriptionInput) => inTx(db, () => {
    load(input.eventId, 'events.import', true);
    if (db.prepare("SELECT 1 FROM event_subscriptions WHERE event_id=? AND status='active'").get(input.eventId)) runtimeError('EVENT_IN_USE', '仍有订阅，请先取消');
    db.prepare('UPDATE external_events SET archived=1,revision=revision+1,updated_at=? WHERE id=? AND archived=0').run(new Date().toISOString(), input.eventId);
  });
  const deleteUnused = (input: SubscriptionInput) => inTx(db, () => {
    load(input.eventId, 'events.import', true);
    if (db.prepare('SELECT 1 FROM event_subscriptions WHERE event_id=?').get(input.eventId)) runtimeError('EVENT_IN_USE', '存在订阅历史，不能物理删除');
    db.prepare('DELETE FROM external_events WHERE id=?').run(input.eventId);
  });
  const updateProvider = (input: { providerId: string; expectedRevision: number; enabled: boolean }) => inTx(db, () => {
    if (actor.extensionId) runtimeError('PERMISSION_DENIED', '工具不能修改宿主的数据源配置');
    const provider = providerFor(db, input.providerId, actor, 'events.import'); positiveRevision(input.expectedRevision);
    if (provider.revision !== input.expectedRevision) runtimeError('REVISION_CONFLICT', '数据源已变化');
    if (typeof input.enabled !== 'boolean') runtimeError('CONTRACT_INVALID', '启用状态须为布尔值');
    if (Boolean(provider.enabled) !== input.enabled) db.prepare('UPDATE event_providers SET enabled=?,revision=revision+1,updated_at=? WHERE id=?').run(input.enabled ? 1 : 0, new Date().toISOString(), input.providerId);
    return listProviders().find(p => p.id === input.providerId)!;
  });
  return { get, list, listProviders, import: importEvents, archive, deleteUnused, updateProvider };
}
export type ExternalEventService = ReturnType<typeof createExternalEventService> & ProviderRefreshApi;
