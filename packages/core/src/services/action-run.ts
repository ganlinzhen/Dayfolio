// 动作执行记录与事务幂等；不持有外部模型、网络或文件副作用。
import { randomUUID } from 'node:crypto';
import { inTx, readSnapshot, type DbAdapter } from '../db';
import { nowIso } from '../utils/date';
import { OntologyError } from '../ontology/policy';
import { valueHash } from '../ontology/canonical';
import type { ActionExecution, ActionExecutionOptions } from '../ontology/action';

export interface ActionRun {
  id: string; action: string; status: 'succeeded' | 'failed'; channel: string; attempts: number;
  errorCode: string | null; error: string | null; createdAt: string; completedAt: string;
}

export function createActionRunService(db: DbAdapter) {
  const project = (row: Record<string, unknown>): ActionRun => ({ id: String(row.id), action: String(row.action_name),
    status: row.status as ActionRun['status'], channel: String(row.channel), attempts: Number(row.attempts),
    errorCode: row.error_code === null ? null : String(row.error_code), error: row.error_message === null ? null : String(row.error_message),
    createdAt: String(row.created_at), completedAt: String(row.completed_at) });
  const list = (options: { action?: string; status?: 'succeeded' | 'failed'; limit?: number; offset?: number } = {}) => {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['action', 'status', 'limit', 'offset'].includes(key))) throw new OntologyError('ACTION_INPUT_INVALID', '执行记录查询参数无效');
    if (options.action !== undefined && (typeof options.action !== 'string' || options.action.length > 200)) throw new OntologyError('ACTION_INPUT_INVALID', '动作名称无效');
    const limit = options.limit ?? 50, offset = options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) throw new OntologyError('ACTION_INPUT_INVALID', '执行记录分页无效');
    if (options.status !== undefined && options.status !== 'succeeded' && options.status !== 'failed') throw new OntologyError('ACTION_INPUT_INVALID', '执行状态无效');
    const clauses: string[] = [], params: unknown[] = [];
    if (options.action !== undefined) { clauses.push('action_name=?'); params.push(options.action); }
    if (options.status !== undefined) { clauses.push('status=?'); params.push(options.status); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return readSnapshot(db, () => ({
      rows: db.prepare(`SELECT * FROM ont_action_executions${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset).map(project),
      total: Number(db.prepare(`SELECT COUNT(*) AS n FROM ont_action_executions${where}`).get(...params)?.n ?? 0),
    }));
  };
  const get = (id: string): ActionRun | null => {
    const row = db.prepare('SELECT * FROM ont_action_executions WHERE id=?').get(id);
    return row ? project(row) : null;
  };
  const track = (action: string, params: Record<string, unknown>, definitionHash: string, atomic: boolean, options: ActionExecutionOptions,
    channel: 'app' | 'mcp' | 'core', body: () => ActionExecution): ActionExecution => {
    const key = options.idempotencyKey;
    if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 200)) throw new OntologyError('ACTION_INPUT_INVALID', '幂等键须为不超过 200 字符的非空文本');
    if (!atomic && (key !== undefined || options.expectedDefinitionRevision !== undefined || options.expectedObjects !== undefined)) throw new OntologyError('ACTION_NOT_ATOMIC', '该业务命令使用专用恢复流程，不支持通用事务幂等或修订前置条件');
    const paramsHash = valueHash(params);
    let executionId: string = randomUUID();
    let createdAt = nowIso();
    let attempts = 1;
    const existing = () => key === undefined ? undefined : db.prepare("SELECT * FROM ont_action_executions WHERE scope='local-user' AND request_key=?").get(key);
    const save = (status: 'succeeded' | 'failed', result: ActionExecution | null, error?: unknown, requestKey: string | null | undefined = key) => {
      const code = error instanceof OntologyError ? error.code : error ? 'ACTION_FAILED' : null;
      const message = error instanceof OntologyError ? error.message.slice(0, 500) : error ? '动作失败，请核对输入、业务状态与关联约束' : null;
      db.prepare(`INSERT INTO ont_action_executions(id,action_name,status,channel,request_key,scope,params_hash,definition_hash,result_json,error_code,error_message,attempts,created_at,completed_at)
        VALUES(?,?,?,?,?,'local-user',?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,result_json=excluded.result_json,error_code=excluded.error_code,error_message=excluded.error_message,attempts=excluded.attempts,completed_at=excluded.completed_at`)
        .run(executionId, action, status, channel, requestKey ?? null, paramsHash, definitionHash, result && atomic ? JSON.stringify(result) : null, code, message, attempts, createdAt, nowIso());
    };
    const failed = (error: unknown) => {
      try { inTx(db, () => {
        const prior = existing();
        const same = prior && prior.action_name === action && prior.params_hash === paramsHash;
        if (same && prior.status === 'failed') { executionId = String(prior.id); createdAt = String(prior.created_at); attempts = Number(prior.attempts) + 1; }
        else if (prior) { executionId = randomUUID(); createdAt = nowIso(); attempts = 1; }
        save('failed', null, error, prior && (!same || prior.status === 'succeeded') ? null : key);
      }); } catch { /* 审计写失败不覆盖业务原始错误 */ }
    };
    if (!atomic) {
      let result: ActionExecution;
      try { result = { ...body(), executionId }; } catch (error) { failed(error); throw error; }
      try { inTx(db, () => save('succeeded', result)); } catch { return { ...result, auditStatus: 'unavailable' }; }
      return result;
    }
    try { return inTx(db, () => {
      const prior = existing();
      if (prior && (prior.action_name !== action || prior.params_hash !== paramsHash)) throw new OntologyError('IDEMPOTENCY_CONFLICT', '同一幂等键已经绑定其他动作或参数');
      if (prior?.status === 'succeeded' && typeof prior.result_json === 'string') return { ...JSON.parse(prior.result_json) as ActionExecution, replayed: true };
      if (prior) { executionId = String(prior.id); createdAt = String(prior.created_at); attempts = Number(prior.attempts) + 1; }
      const result = { ...body(), executionId };
      save('succeeded', result);
      return result;
    }); } catch (error) { failed(error); throw error; }
  };
  return { public: { list, get }, track };
}

export type ActionRunStore = ReturnType<typeof createActionRunService>;
export type ActionRunService = ActionRunStore['public'];
