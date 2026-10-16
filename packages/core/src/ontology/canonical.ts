import { createHash } from 'node:crypto';
import { OntologyError } from './policy';

/** 稳定摘要只接受有界 JSON；对象属性顺序不影响幂等语义。 */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 32) throw new OntologyError('ACTION_INPUT_INVALID', '结构化输入过深');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const input = value as Record<string, unknown>;
    const keys = Object.keys(input).filter(key => input[key] !== undefined).sort();
    if (keys.length > 10000) throw new OntologyError('ACTION_INPUT_INVALID', '结构化输入字段过多');
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(input[key], depth + 1)}`).join(',')}}`;
  }
  throw new OntologyError('ACTION_INPUT_INVALID', '输入必须为有限 JSON 值');
}

export function valueHash(value: unknown): string {
  const text = canonicalJson(value);
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new OntologyError('ACTION_INPUT_INVALID', '动作输入超过 2 MiB');
  return createHash('sha256').update(text).digest('hex');
}
