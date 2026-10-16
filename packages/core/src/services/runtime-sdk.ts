// 固定 SDK 分发合同：身份由主进程会话提供，消息只携带业务参数。
import Ajv from 'ajv';
import protocolSchema from '../contracts/protocol.schema.json';
import type { TodoDeskCore } from '../index';
import type { EventImportInput, EventListInput, ResumeFollowingInput, SubscriptionInput, UnsubscribeInput } from '../runtime-types';
import { canonical, providerFor } from './event-model';
import { runtimeError } from '../utils/schedule';

const ajv = new Ajv({ allErrors: true, strict: false });
const envelope = ajv.compile<RuntimeRequest>(protocolSchema);
const text = { type: 'string', minLength: 1, maxLength: 2048 };
const revision = { type: 'integer', minimum: 0 };
const shape = (properties: Record<string, unknown>, required: string[]) => ajv.compile({ type: 'object', properties, required, additionalProperties: false });
const eventId = { eventId: text };
const providerId = { providerId: text };
const validators = {
  'runtime.describe': shape({}, []),
  'events.list': shape({ ...providerId, fromDate: text, toDateExclusive: text, status: { enum: ['scheduled', 'postponed', 'cancelled', 'finished'] }, cursor: text, limit: { type: 'integer', minimum: 1, maximum: 500 } }, ['providerId']),
  'events.import': shape({ ...providerId, batchId: { type: 'string', minLength: 1, maxLength: 200 }, expectedProviderRevision: revision, events: { type: 'array', maxItems: 500, items: { type: 'object' } } }, ['providerId', 'batchId', 'expectedProviderRevision', 'events']),
  'providers.refresh': shape(providerId, ['providerId']),
  'providers.getStatus': shape(providerId, ['providerId']),
  'subscriptions.subscribe': shape(eventId, ['eventId']),
  'subscriptions.get': shape(eventId, ['eventId']),
  'subscriptions.unsubscribe': shape({ ...eventId, todoPolicy: { enum: ['keep', 'delete_open'] }, expectedTodoRevision: revision }, ['eventId', 'todoPolicy']),
  'subscriptions.resumeFollowing': shape({ ...eventId, expectedEventRevision: revision, expectedTodoRevision: revision }, ['eventId', 'expectedEventRevision', 'expectedTodoRevision']),
  'navigation.openTodo': shape(eventId, ['eventId']),
};
export type RuntimeMethod = keyof typeof validators;
export interface RuntimeRequest { apiMajor: 1; requestId: string; method: RuntimeMethod; params: Record<string, unknown> }
export const SDK_LIMITS = { packageBytes: 20 * 1024 * 1024, eventBatchCount: 500, eventBatchBytes: 5 * 1024 * 1024, pageSize: 500, maxRangeDays: 100, requestBytes: 65536 };

export function validateRuntimeRequest(input: unknown): RuntimeRequest {
  if (!envelope(input)) return runtimeError('CONTRACT_INVALID', 'SDK 消息不符合 v1 信封合同');
  const request = input;
  const max = request.method === 'events.import' ? SDK_LIMITS.eventBatchBytes + SDK_LIMITS.requestBytes : SDK_LIMITS.requestBytes;
  let serialized: string;
  try { serialized = canonical(request); } catch { return runtimeError('CONTRACT_INVALID', 'SDK 参数必须是有限、无循环的 JSON'); }
  if (Buffer.byteLength(serialized) > max) return runtimeError('CONTRACT_INVALID', 'SDK 请求超过限额');
  if (!validators[request.method](request.params)) return runtimeError('CONTRACT_INVALID', 'SDK 方法参数不合法或包含额外字段');
  return request;
}

export interface RuntimeSdkHooks {
  openTodo?: (target: { objectType: 'todo'; id: number }) => void;
  refresh?: (extensionId: string, providerId: string) => unknown;
  getStatus?: (extensionId: string, providerId: string) => unknown;
}
export function createRuntimeDispatcher(core: TodoDeskCore, extensionId: string, hooks: RuntimeSdkHooks = {}) {
  return (input: unknown): unknown => {
    const request = validateRuntimeRequest(input);
    const extension = core.extensions.get({ extensionId });
    if (!extension || extension.status !== 'active') return runtimeError('SESSION_REVOKED', '工具已停用或卸载');
    const scope = core.forExtension(extensionId), params = request.params;
    switch (request.method) {
      case 'runtime.describe': return { api: { major: 1, minor: 0 }, extensionId, releaseDigest: extension.digest, grantedCapabilities: extension.grantedCapabilities, limits: SDK_LIMITS };
      case 'events.list': return scope.externalEvents.list(params as unknown as EventListInput);
      case 'events.import': return scope.externalEvents.import(params as unknown as EventImportInput);
      case 'subscriptions.subscribe': return scope.subscriptions.subscribe(params as unknown as SubscriptionInput);
      case 'subscriptions.get': return scope.subscriptions.get(params as unknown as SubscriptionInput);
      case 'subscriptions.unsubscribe': return scope.subscriptions.unsubscribe(params as unknown as UnsubscribeInput);
      case 'subscriptions.resumeFollowing': return scope.subscriptions.resumeFollowing(params as unknown as ResumeFollowingInput);
      case 'providers.refresh':
      case 'providers.getStatus': {
        providerFor(core.db, String(params.providerId), { extensionId }, request.method === 'providers.refresh' ? 'providers.refresh' : 'events.read', request.method === 'providers.refresh');
        if(request.method==='providers.refresh')return hooks.refresh?hooks.refresh(extensionId,String(params.providerId)):scope.externalEvents.refresh({providerId:String(params.providerId)});
        return hooks.getStatus?hooks.getStatus(extensionId,String(params.providerId)):scope.externalEvents.getStatus({providerId:String(params.providerId)});
      }
      case 'navigation.openTodo': {
        const event = core.db.prepare('SELECT provider_id FROM external_events WHERE id=?').get(params.eventId);
        if (!event) return runtimeError('EVENT_NOT_FOUND', '事件不存在');
        providerFor(core.db, String(event.provider_id), { extensionId }, 'navigation.openTodo');
        const subscription = core.subscriptions.get({ eventId: String(params.eventId) });
        if (!subscription.todo) return runtimeError('SUBSCRIPTION_INACTIVE', '事件尚未关联可打开的待办');
        const target = { objectType: 'todo' as const, id: subscription.todo.id };
        if (!hooks.openTodo) return runtimeError('METHOD_NOT_IMPLEMENTED', '当前宿主未提供待办导航');
        hooks.openTodo(target);
        return { opened: true, target };
      }
    }
  };
}
