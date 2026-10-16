// 仅用于隔离测试的安装元数据安排；正式工具安装器在 P3 实现。
import type { TodoDeskCore, ExternalEventInput } from '../src';
export function provisionProvider(core: TodoDeskCore, id = 'local.ucl') {
  const now = new Date().toISOString(); const collectionId = `ext:${id}/schedule`, providerId = `ext:${id}/main`;
  core.db.prepare('INSERT INTO extensions(id,origin_key,created_at,updated_at) VALUES(?,?,?,?)').run(id, 'e-' + id, now, now);
  core.db.prepare('INSERT INTO calendar_collections(id,owner_extension_id,title,color) VALUES(?,?,?,?)').run(collectionId, id, '测试日程', 'violet');
  core.db.prepare('INSERT INTO event_providers(id,extension_id,collection_id,kind,updated_at) VALUES(?,?,?,?,?)').run(providerId, id, collectionId, 'import', now);
  for (const cap of ['events.read', 'events.import', 'subscriptions.write']) core.db.prepare('INSERT INTO extension_grants(extension_id,capability,scope,authorization_digest) VALUES(?,?,?,?)').run(id, cap, providerId, '隔离测试明确授权');
  return { providerId, collectionId, extensionId: id };
}
export const eventFixture = (externalId = 'match-1'): Extract<ExternalEventInput, { timeKind: 'timed' }> => ({ externalId, title: '【测试】比赛', timeKind: 'timed', startAt: '2026-10-31T19:00:00Z', endAt: null, startDate: null, endDateExclusive: null, status: 'scheduled', sourceUrl: 'https://example.invalid/' + externalId, payload: { home: '甲', away: '乙' } });
export function importOne(core: TodoDeskCore, providerId: string, event: ExternalEventInput, batchId = 'initial') {
  const revision = core.externalEvents.listProviders().find(p => p.id === providerId)!.revision;
  const result = core.externalEvents.import({ providerId, batchId, expectedProviderRevision: revision, events: [event] });
  return { event: core.externalEvents.list({ providerId }).items.find(e => e.externalId === event.externalId)!, result };
}
