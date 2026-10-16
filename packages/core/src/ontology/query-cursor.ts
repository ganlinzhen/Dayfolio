import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DbAdapter } from '../db';
import { OntologyError } from './policy';

export type CursorValue = string | number | null;
const invalid = (): never => { throw new OntologyError('CURSOR_INVALID', '游标已失效或不属于当前查询，请重新开始分页'); };

/** 私有签名键由迁移初始化，App/MCP 共库和重连后可继续消费同一游标。 */
export function createCursorCodec(db: DbAdapter) {
  const key = db.prepare("SELECT value FROM ont_query_config WHERE key='cursor_key'").get()?.value;
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new OntologyError('QUERY_UNSUPPORTED', '查询游标配置缺失，请核对数据库迁移');
  const sign = (text: string) => createHmac('sha256', key).update(text).digest('hex');
  const encode = (fingerprint: string, values: CursorValue[]): string => {
    const body = Buffer.from(JSON.stringify({ version: 1, fingerprint, values })).toString('base64url');
    if (body.length > 65536) throw new OntologyError('QUERY_UNSUPPORTED', '排序值过大，不能生成有界游标，请使用普通分页');
    return `${body}.${sign(body)}`;
  };
  const decode = (token: unknown, fingerprint: string, valueCount: number): CursorValue[] => {
    if (typeof token !== 'string' || token.length > 65601) return invalid();
    const parts = token.split('.');
    if (parts.length !== 2 || !/^[a-f0-9]{64}$/.test(parts[1])) return invalid();
    const [body, signature] = parts;
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(body), 'hex'))) return invalid();
    try {
      if (Buffer.from(body, 'base64url').toString('base64url') !== body) return invalid();
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (payload.version !== 1 || payload.fingerprint !== fingerprint || !Array.isArray(payload.values) || payload.values.length !== valueCount || payload.values.some((value: unknown) => value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value)))) return invalid();
      return payload.values;
    } catch { return invalid(); }
  };
  return { encode, decode };
}
