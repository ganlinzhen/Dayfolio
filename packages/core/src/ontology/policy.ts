import type { ObjectTypeDef } from './types';

export class OntologyError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(`${code}：${message}`);
  }
}

const READ_ONLY = new Set(['news_topic', 'course_overview', 'vault_note', 'plan_adjustment', 'card_export', 'action_execution']);
export function objectPolicy(apiName: string, isSystem: boolean, isVirtual: boolean) {
  const writeMode = isVirtual ? 'virtual' : !isSystem ? 'custom' : READ_ONLY.has(apiName) ? 'read_only' : 'managed';
  return { writeMode, extensionWritable: writeMode === 'managed', visibility: apiName === 'news_topic' ? 'history' : 'normal' } as const;
}

export function assertObjectWrite(def: ObjectTypeDef, kind: 'create' | 'update' | 'delete', values: Record<string, unknown> = {}) {
  const policy = objectPolicy(def.apiName, def.isSystem, def.isVirtual);
  if (policy.writeMode === 'custom') return;
  if (kind === 'update' && policy.extensionWritable && Object.keys(values).every(key => def.properties.some(p => p.apiName === key && p.origin === 'user'))) return;
  throw new OntologyError('WRITE_REQUIRES_ACTION', `${def.title}须通过业务动作${kind === 'delete' ? '删除' : '写入'}，通用接口只能编辑允许的用户扩展字段`, { objectType: def.apiName });
}
