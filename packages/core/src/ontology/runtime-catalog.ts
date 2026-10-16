// 标准事件对象只登记一次，具体工具不新增系统类型或表。
import type { ObjectTypeDef, LinkTypeDef, PropertyDef } from './types';
type Definition = Omit<ObjectTypeDef, 'createdAt' | 'updatedAt'>;
type Column = [string, PropertyDef['dataType'], boolean?];
function define(apiName: string, title: string, tableName: string, columns: Column[], sortOrder: number): Definition {
  return { apiName, title, description: `${title}：经公共业务命令维护，禁止通用接口改写系统字段。`, tableName, isVirtual: false, isSystem: true, primaryKey: 'id', titleProperty: columns.some(c => c[0] === 'title') ? 'title' : 'id', status: 'active', sortOrder, properties: columns.map(([apiName, dataType, nullable = false]) => ({ apiName, dataType, nullable, origin: 'builtin', isPrimaryKey: apiName === 'id' })) };
}
export const RUNTIME_OBJECTS: Definition[] = [
  define('tool_extension', '工具扩展', 'extensions', [['id', 'string'], ['origin_key', 'string'], ['active_release_id', 'string', true], ['status', 'string'], ['revision', 'integer'], ['created_at', 'date'], ['updated_at', 'date']], 300),
  define('calendar_collection', '日历分类', 'calendar_collections', [['id', 'string'], ['owner_extension_id', 'string', true], ['title', 'string'], ['color', 'string'], ['sort_order', 'integer'], ['archived', 'integer']], 301),
  define('event_provider', '事件数据源', 'event_providers', [['id', 'string'], ['extension_id', 'string'], ['collection_id', 'string'], ['kind', 'string'], ['config_json', 'json'], ['revision', 'integer'], ['enabled', 'integer'], ['refresh_seconds','integer',true], ['updated_at', 'date']], 302),
  define('external_event', '外部事件', 'external_events', [['id', 'string'], ['provider_id', 'string'], ['external_id', 'string'], ['title', 'string'], ['time_kind', 'string'], ['start_at', 'date', true], ['end_at', 'date', true], ['start_date', 'date', true], ['end_date_exclusive', 'date', true], ['source_timezone', 'string', true], ['status', 'string'], ['source_url', 'string'], ['payload_json', 'json'], ['revision', 'integer'], ['archived', 'integer'], ['created_at', 'date'], ['updated_at', 'date']], 303),
  define('event_subscription', '事件订阅', 'event_subscriptions', [['id', 'string'], ['event_id', 'string'], ['todo_id', 'integer', true], ['status', 'string'], ['sync_mode', 'string'], ['applied_event_revision', 'integer'], ['last_applied_json', 'json'], ['created_at', 'date'], ['updated_at', 'date']], 304),
];
type Link = Omit<LinkTypeDef, 'createdAt'>;
export const RUNTIME_LINKS: Link[] = [
  ['tool_extension', 'calendar_collection', 'owner_extension_id'], ['tool_extension', 'event_provider', 'extension_id'], ['calendar_collection', 'event_provider', 'collection_id'], ['event_provider', 'external_event', 'provider_id'], ['external_event', 'event_subscription', 'event_id'], ['todo', 'event_subscription', 'todo_id'],
].map(([leftType, rightType, fkColumn], i) => ({ apiName: `${leftType}__${rightType}`, title: `${leftType} 与 ${rightType}`, leftType, rightType, cardinality: i>=4?'one_to_one' as const:'one_to_many' as const, fkColumn, leftLinkName: rightType + 's', rightLinkName: leftType, isSystem: true, onDelete: 'none' as const, referenceKind: 'strong' as const, sortOrder: 300 + i }));
