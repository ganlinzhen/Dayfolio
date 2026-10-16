import { describe, it, expect } from 'vitest';
import { mkCore } from './helpers';
import { provisionProvider, eventFixture, importOne } from './runtime-fixtures';
import type { ExternalEventInput } from '../src';

describe('标准事件与订阅事务', () => {
  it('批次重放、稳定身份、整批校验与基线冲突', () => {
    const { core, cleanup } = mkCore(); try {
      expect(core.ontology.listLinkTypes().find(l=>l.apiName==='external_event__event_subscription')!.cardinality).toBe('one_to_one');
      expect(core.ontology.listLinkTypes().find(l=>l.apiName==='todo__event_subscription')!.cardinality).toBe('one_to_one');
      const { providerId } = provisionProvider(core); const raw = eventFixture(); const input = { providerId, batchId: 'b1', expectedProviderRevision: 0, events: [raw] };
      const first = core.externalEvents.import(input); const id = core.externalEvents.list({ providerId }).items[0].id;
      expect(core.externalEvents.import(input)).toEqual(first);
      expect(() => core.externalEvents.import({ ...input, events: [{ ...raw, title: '另一个内容' }] })).toThrow('BATCH_CONTENT_CONFLICT');
      const rev = core.runtime.getRevision();
      expect(() => core.externalEvents.import({ providerId, batchId: 'bad', expectedProviderRevision: 1, events: [{ ...raw, title: '不应写入' }, { ...raw, externalId: 'bad', endAt: '2026-10-30T00:00:00Z' }] })).toThrow();
      expect(core.runtime.getRevision()).toBe(rev); expect(core.externalEvents.get({ eventId: id }).title).toBe(raw.title);
      expect(() => core.externalEvents.import({ providerId, batchId: 'stale', expectedProviderRevision: 0, events: [raw] })).toThrow('REVISION_CONFLICT');
      const changed = importOne(core, providerId, { ...raw, startAt: '2026-11-02T19:00:00Z' }, 'b2'); expect(changed.event.id).toBe(id);
    } finally { cleanup(); }
  });
  it('订阅经公共待办命令且幂等；动作停用及失败关联完整回滚', () => {
    const { core, cleanup } = mkCore(); try {
      const { providerId } = provisionProvider(core); const { event } = importOne(core, providerId, eventFixture());
      core.ontology.updateActionType('add_todo', { status: 'disabled' }); let before = core.runtime.getRevision();
      expect(() => core.subscriptions.subscribe({ eventId: event.id })).toThrow('ACTION_DISABLED'); expect(core.todos.list()).toHaveLength(0); expect(core.runtime.getRevision()).toBe(before);
      core.ontology.updateActionType('add_todo', { status: 'active' });
      before = core.runtime.getRevision();
      core.db.exec("CREATE TRIGGER test_fail_link BEFORE INSERT ON event_subscriptions BEGIN SELECT RAISE(ABORT,'关联故障'); END;");
      expect(() => core.subscriptions.subscribe({ eventId: event.id })).toThrow('关联故障'); expect(core.todos.list()).toHaveLength(0); expect(core.runtime.getRevision()).toBe(before);
      core.db.exec('DROP TRIGGER test_fail_link');
      const a = core.subscriptions.subscribe({ eventId: event.id }); const b = core.subscriptions.subscribe({ eventId: event.id });
      expect(a.effect).toBe('created'); expect(b.effect).toBe('reused'); expect(a.todo!.id).toBe(b.todo!.id); expect(core.todos.list()).toHaveLength(1);
      expect(a.todo).toMatchObject({ time_mode: 'instant', start_time: '03:00', due_date: '2026-11-01' });
    } finally { cleanup(); }
  });
  it('改期更新原待办且不覆盖备注、优先级与标签', () => {
    const { core, cleanup } = mkCore(); try {
      const { providerId } = provisionProvider(core); const raw = eventFixture(); const { event } = importOne(core, providerId, raw); const a = core.subscriptions.subscribe({ eventId: event.id });
      core.todos.update(a.todo!.id, { notes: '我的备注', priority: 'high', tags: ['观赛'] });
      expect(core.subscriptions.get({ eventId: event.id }).subscription?.syncMode).toBe('follow');
      importOne(core, providerId, { ...raw, title: '确认比赛', startAt: '2026-11-02T19:00:00Z' }, 'reschedule');
      expect(core.subscriptions.get({ eventId: event.id }).todo).toMatchObject({ id: a.todo!.id, title: '确认比赛', due_date: '2026-11-03', notes: '我的备注', priority: 'high', tags: ['观赛'] });
    } finally { cleanup(); }
  });
  it('用户通过业务动作修改标题即接管，恢复跟随有双修订保护', () => {
    const { core, cleanup } = mkCore(); try {
      const { providerId } = provisionProvider(core); const raw = eventFixture(); const { event } = importOne(core, providerId, raw); const a = core.subscriptions.subscribe({ eventId: event.id });
      core.actions.execute('update_todo', { id: a.todo!.id, patch: { title: '我来安排' } });
      importOne(core, providerId, { ...raw, title: '来源新标题', startAt: '2026-11-05T19:00:00Z' }, 'changed');
      const current = core.subscriptions.get({ eventId: event.id }); expect(current.subscription).toMatchObject({ syncMode: 'manual', pendingEventRevision: 2 }); expect(current.todo!.title).toBe('我来安排');
      expect(() => core.subscriptions.resumeFollowing({ eventId: event.id, expectedEventRevision: 1, expectedTodoRevision: current.todo!.revision })).toThrow('REVISION_CONFLICT');
      core.todos.update(current.todo!.id, { notes: '又改了' });
      expect(() => core.subscriptions.resumeFollowing({ eventId: event.id, expectedEventRevision: 2, expectedTodoRevision: current.todo!.revision })).toThrow('REVISION_CONFLICT');
      const result = core.subscriptions.resumeFollowing({ eventId: event.id, expectedEventRevision: 2, expectedTodoRevision: core.todos.get(current.todo!.id).revision });
      expect(result.todo!.title).toBe('来源新标题'); expect(result.subscription!.syncMode).toBe('follow');
    } finally { cleanup(); }
  });
  it('兼容界面编辑固定时刻会转 floating 并保护；相同值重写不会接管', () => {
    const { core, cleanup } = mkCore(); try {
      const { providerId } = provisionProvider(core); const { event } = importOne(core, providerId, eventFixture()); const a = core.subscriptions.subscribe({ eventId: event.id }); const todo = a.todo!;
      core.todos.update(todo.id, { due_date: todo.due_date, start_time: todo.start_time, end_time: todo.end_time, title: todo.title }); expect(core.subscriptions.get({ eventId: event.id }).subscription!.syncMode).toBe('follow');
      core.todos.update(todo.id, { start_time: '04:00' }); expect(core.todos.get(todo.id)).toMatchObject({ time_mode: 'floating', scheduled_start_at: null, start_time: '04:00' }); expect(core.subscriptions.get({ eventId: event.id }).subscription!.syncMode).toBe('manual');
    } finally { cleanup(); }
  });
  it('已完成待办及完成记录不被改期、来源结束或恢复跟随重开', () => {
    const { core, cleanup } = mkCore(); try {
      const { providerId } = provisionProvider(core); const raw = eventFixture(); const { event } = importOne(core, providerId, raw); const a = core.subscriptions.subscribe({ eventId: event.id }); const completed = core.todos.complete(a.todo!.id);
      importOne(core, providerId, { ...raw, status: 'finished', title: '来源已结束' }, 'finished');
      const after = core.subscriptions.get({ eventId: event.id }); expect(after.todo).toMatchObject({ title: completed.title, status: 'done', completed_at: completed.completed_at });
      expect(core.subscriptions.resumeFollowing({ eventId: event.id, expectedEventRevision: 2, expectedTodoRevision: after.todo!.revision }).protectedCompleted).toBe(true);
      expect(() => core.subscriptions.unsubscribe({ eventId: event.id, todoPolicy: 'delete_open' })).toThrow('COMPLETED_TODO_PROTECTED');
      expect(core.subscriptions.get({ eventId: event.id }).subscription!.status).toBe('active');
    } finally { cleanup(); }
  });
  it('来源取消/待定保留未完成待办，时间恢复后沿原订阅排期', () => {
    const { core, cleanup } = mkCore(); try {
      const { providerId } = provisionProvider(core); const raw = eventFixture(); const { event } = importOne(core, providerId, raw); const a = core.subscriptions.subscribe({ eventId: event.id });
      importOne(core, providerId, { ...raw, status: 'cancelled' }, 'cancel'); expect(core.todos.get(a.todo!.id)).toMatchObject({ due_date: null, status: 'open' });
      const pending: ExternalEventInput = { ...raw, timeKind: 'tbd', startAt: null, endAt: null, startDate: null, endDateExclusive: null, status: 'postponed' };
      importOne(core, providerId, pending, 'pending'); expect(core.todos.get(a.todo!.id).due_date).toBeNull();
      importOne(core, providerId, { ...raw, startAt: '2026-11-09T19:00:00Z' }, 'confirmed'); expect(core.todos.get(a.todo!.id).due_date).toBe('2026-11-10');
      const next = importOne(core, providerId, { ...pending, externalId: 'pending-2' }, 'new-pending'); expect(core.subscriptions.subscribe({ eventId: next.event.id }).todo!.due_date).toBeNull();
    } finally { cleanup(); }
  });
  it('取消订阅保留并转基础分类，再订阅复用；直接删除后刷新不复活', () => {
    const { core, cleanup } = mkCore(); try {
      const { providerId } = provisionProvider(core); const raw = eventFixture(); const { event } = importOne(core, providerId, raw); const a = core.subscriptions.subscribe({ eventId: event.id });
      const kept = core.subscriptions.unsubscribe({ eventId: event.id, todoPolicy: 'keep' }); expect(kept.todo!.collection_id).toBe('builtin.todo'); expect(kept.subscription!.status).toBe('unsubscribed');
      expect(core.subscriptions.subscribe({ eventId: event.id }).todo!.id).toBe(a.todo!.id);
      core.todos.remove(a.todo!.id); expect(core.subscriptions.get({ eventId: event.id })).toMatchObject({ subscription: { status: 'unsubscribed', todoId: null }, todo: null });
      importOne(core, providerId, { ...raw, title: '不能复活' }, 'again'); expect(core.todos.list()).toHaveLength(0);
      expect(core.subscriptions.subscribe({ eventId: event.id }).todo!.id).not.toBe(a.todo!.id);
    } finally { cleanup(); }
  });
  it('修改来源时底层命令停用导致整个导入回滚，批次可原样重试', () => {
    const { core, cleanup } = mkCore(); try {
      const { providerId } = provisionProvider(core); const raw = eventFixture(); const { event } = importOne(core, providerId, raw); const a = core.subscriptions.subscribe({ eventId: event.id });
      const input = { providerId, batchId: 'retry', expectedProviderRevision: 1, events: [{ ...raw, title: '新标题' }] };
      core.ontology.updateActionType('update_todo', { status: 'disabled' }); const rev = core.runtime.getRevision(); expect(() => core.externalEvents.import(input)).toThrow('ACTION_DISABLED'); expect(core.runtime.getRevision()).toBe(rev); expect(core.externalEvents.get({ eventId: event.id }).title).toBe(raw.title);
      core.ontology.updateActionType('update_todo', { status: 'active' }); core.externalEvents.import(input); expect(core.todos.get(a.todo!.id).title).toBe('新标题');
    } finally { cleanup(); }
  });
  it('时区切换不接管订阅；用户主动隐藏不会被新订阅覆盖', () => {
    const { core, cleanup } = mkCore(); try {
      const { providerId, collectionId } = provisionProvider(core); const { event } = importOne(core, providerId, eventFixture()); core.runtime.setVisibility({ collectionId, visible: false });
      expect(core.subscriptions.subscribe({ eventId: event.id }).collectionVisible).toBe(false); core.runtime.setDisplayTimezone('Europe/London'); expect(core.subscriptions.get({ eventId: event.id }).subscription!.syncMode).toBe('follow');
      expect(core.runtime.listCollections().find(c => c.id === collectionId)!.visible).toBe(false);
    } finally { cleanup(); }
  });
  it('工具范围每次读写验证实际授权，不信任另一个事件 ID', () => {
    const { core, cleanup } = mkCore(); try {
      const a = provisionProvider(core), b = provisionProvider(core, 'local.concert'); const ea = importOne(core, a.providerId, eventFixture()); const eb = importOne(core, b.providerId, eventFixture()); const tool = core.forExtension(a.extensionId);
      expect(() => tool.externalEvents.get({ eventId: eb.event.id })).toThrow('PERMISSION_DENIED'); expect(() => tool.subscriptions.subscribe({ eventId: eb.event.id })).toThrow('PERMISSION_DENIED');
      const scoped = tool.subscriptions.subscribe({ eventId: ea.event.id }); expect(Object.keys(scoped.todo!).sort()).toEqual(['id', 'revision', 'status', 'title']); expect(Object.keys(tool.subscriptions.get({ eventId: ea.event.id }).todo!).sort()).toEqual(['id', 'revision', 'status', 'title']); core.db.prepare("DELETE FROM extension_grants WHERE extension_id=? AND capability='subscriptions.write'").run(a.extensionId);
      expect(() => tool.subscriptions.subscribe({ eventId: ea.event.id })).toThrow('PERMISSION_DENIED');
      expect(() => tool.externalEvents.updateProvider({ providerId: a.providerId, expectedRevision: 1, enabled: false })).toThrow('PERMISSION_DENIED');
    } finally { cleanup(); }
  });
  it('分页绑定查询和修订；缺失项不取消、历史引用不可物理删除', () => {
    const { core, cleanup } = mkCore(); try {
      const { providerId } = provisionProvider(core); core.externalEvents.import({ providerId, batchId: 'many', expectedProviderRevision: 0, events: [eventFixture('a'), eventFixture('b')] });
      const page = core.externalEvents.list({ providerId, limit: 1 }); expect(page.truncated).toBe(true); expect(core.externalEvents.list({ providerId, limit: 1, cursor: page.nextCursor! }).items).toHaveLength(1);
      expect(() => core.externalEvents.list({ providerId, status: 'finished', cursor: page.nextCursor! })).toThrow('REVISION_CONFLICT');
      const a = page.items[0]; core.subscriptions.subscribe({ eventId: a.id }); expect(() => core.externalEvents.deleteUnused({ eventId: a.id })).toThrow('EVENT_IN_USE');
      expect(() => core.externalEvents.list({ providerId, cursor: page.nextCursor! })).toThrow('REVISION_CONFLICT');
      core.externalEvents.import({ providerId, batchId: 'only-one', expectedProviderRevision: 1, events: [eventFixture('a')] }); expect(core.externalEvents.list({ providerId }).items).toHaveLength(2);
    } finally { cleanup(); }
  });
});


describe('冻结合同边界补充', () => {
  it('订阅写权限独立生效，内部读取不扩大公开读取权限', () => {
    const { core, cleanup } = mkCore(); try {
      const own = provisionProvider(core), other = provisionProvider(core, 'local.other');
      const { event } = importOne(core, own.providerId, eventFixture());
      const foreign = importOne(core, other.providerId, eventFixture());
      core.db.prepare("DELETE FROM extension_grants WHERE extension_id=? AND capability!='subscriptions.write'").run(own.extensionId);
      const tool = core.forExtension(own.extensionId);
      expect(() => tool.subscriptions.get({ eventId: event.id })).toThrow('PERMISSION_DENIED');
      expect(() => tool.subscriptions.list({ providerId: own.providerId })).toThrow('PERMISSION_DENIED');
      expect(() => tool.externalEvents.get({ eventId: event.id })).toThrow('PERMISSION_DENIED');
      expect(() => tool.subscriptions.subscribe({ eventId: foreign.event.id })).toThrow('PERMISSION_DENIED');
      const first = tool.subscriptions.subscribe({ eventId: event.id });
      expect(first.effect).toBe('created');
      expect(Object.keys(first.todo!).sort()).toEqual(['id', 'revision', 'status', 'title']);
      expect(() => tool.subscriptions.get({ eventId: event.id })).toThrow('PERMISSION_DENIED');
      expect(tool.subscriptions.subscribe({ eventId: event.id }).effect).toBe('reused');
      core.todos.update(first.todo!.id, { title: '个人标题', notes: '仅宿主可读' });
      const current = core.subscriptions.get({ eventId: event.id });
      expect(tool.subscriptions.resumeFollowing({ eventId: event.id, expectedEventRevision: event.revision, expectedTodoRevision: current.todo!.revision }).todo!.title).toBe(event.title);
      expect(core.todos.get(first.todo!.id).notes).toBe('仅宿主可读');
      expect(tool.subscriptions.unsubscribe({ eventId: event.id, todoPolicy: 'keep' }).subscription!.status).toBe('unsubscribed');
      expect(tool.subscriptions.subscribe({ eventId: event.id }).effect).toBe('reactivated');
      expect(tool.subscriptions.unsubscribe({ eventId: event.id, todoPolicy: 'delete_open' }).todo).toBeNull();
      core.db.prepare("DELETE FROM extension_grants WHERE extension_id=?").run(own.extensionId);
      expect(() => tool.subscriptions.subscribe({ eventId: event.id })).toThrow('PERMISSION_DENIED');
    } finally { cleanup(); }
  });
  it('空身份拒绝，撤权后源同步不可借内部回调写待办', () => {
    const { core, cleanup } = mkCore(); try {
      const p = provisionProvider(core); expect(() => core.forExtension('')).toThrow('PERMISSION_DENIED'); expect(() => core.forExtension('missing')).toThrow('PERMISSION_DENIED');
      const raw = eventFixture(); const { event } = importOne(core, p.providerId, raw); const a = core.subscriptions.subscribe({ eventId: event.id }); const scoped = core.forExtension(p.extensionId);
      core.db.prepare("DELETE FROM extension_grants WHERE capability='subscriptions.write'").run();
      expect(() => scoped.externalEvents.import({ providerId: p.providerId, batchId: 'denied', expectedProviderRevision: 1, events: [{ ...raw, title: '越权写' }] })).toThrow('PERMISSION_DENIED');
      expect(core.todos.get(a.todo!.id).title).toBe(raw.title); expect(core.externalEvents.get({ eventId: event.id }).revision).toBe(1);
    } finally { cleanup(); }
  });
  it('来源停用后历史可读、宿主可取消，范围工具不可继续写', () => {
    const { core, cleanup } = mkCore(); try {
      const p = provisionProvider(core); const { event } = importOne(core, p.providerId, eventFixture()); const a = core.subscriptions.subscribe({ eventId: event.id });
      core.externalEvents.updateProvider({ providerId: p.providerId, expectedRevision: 1, enabled: false }); expect(core.subscriptions.get({ eventId: event.id }).todo!.id).toBe(a.todo!.id);
      expect(() => core.forExtension(p.extensionId).subscriptions.unsubscribe({ eventId: event.id, todoPolicy: 'keep' })).toThrow('PERMISSION_DENIED');
      expect(core.subscriptions.unsubscribe({ eventId: event.id, todoPolicy: 'keep' }).subscription!.status).toBe('unsubscribed');
    } finally { cleanup(); }
  });
  it('全天左闭右开、待定不猜测日期、手动安排仍显式返回来源取消', () => {
    const { core, cleanup } = mkCore(); try {
      const p = provisionProvider(core); const raw: ExternalEventInput = { ...eventFixture(), timeKind: 'all_day', startAt: null, endAt: null, startDate: '2026-11-01', endDateExclusive: '2026-11-04' };
      const { event } = importOne(core, p.providerId, raw); const a = core.subscriptions.subscribe({ eventId: event.id }); expect(a.todo).toMatchObject({ due_date: '2026-11-01', end_date: '2026-11-03', time_mode: 'floating' });
      expect(core.today.getToday('2026-11-03').due_today_todos.some(t => t.id === a.todo!.id)).toBe(true); expect(core.today.getToday('2026-11-04').due_today_todos).toHaveLength(0);
      core.todos.update(a.todo!.id, { title: '个人安排' }); importOne(core, p.providerId, { ...raw, status: 'cancelled' }, 'cancel');
      expect(core.todos.get(a.todo!.id)).toMatchObject({ title: '个人安排', due_date: '2026-11-01', source_status: 'cancelled' });
      expect(core.todos.list().find(t => t.id === a.todo!.id)!.source_status).toBe('cancelled');
    } finally { cleanup(); }
  });
  it('标准事件输入拒绝不完整快照、错误日期、未知字段及超限领域数据', () => {
    const { core, cleanup } = mkCore(); try {
      const p = provisionProvider(core); const raw = eventFixture();
      const bads = [{ ...raw, endAt: undefined }, { ...raw, endAt: '' }, { ...raw, startAt: '2026-02-30T00:00:00Z' }, { ...raw, sql: 'DROP TABLE todos' }, { ...raw, payload: { huge: '中'.repeat(6000) } }, { ...raw, startAt: '2026-11-01T03:00:00' }];
      for (const event of bads) expect(() => core.externalEvents.import({ providerId: p.providerId, batchId: 'invalid', expectedProviderRevision: 0, events: [event as ExternalEventInput] })).toThrow();
      expect(core.externalEvents.list({ providerId: p.providerId }).items).toHaveLength(0);
      expect(() => core.externalEvents.import({ providerId: p.providerId, batchId: 'large', expectedProviderRevision: 0, events: Array.from({ length: 501 }, (_, i) => eventFixture(String(i))) })).toThrow();
      expect(() => core.externalEvents.list({providerId:p.providerId,fromDate:''})).toThrow();
      expect(() => core.externalEvents.list({ providerId: p.providerId, fromDate: '2026-01-01', toDateExclusive: '2026-12-01' })).toThrow('RANGE_TOO_LARGE');
    } finally { cleanup(); }
  });
  it('游标绑定真实授权修订，权限重授后必须重新查询', () => {
    const { core, cleanup } = mkCore(); try {
      const p = provisionProvider(core); core.externalEvents.import({ providerId: p.providerId, batchId: 'page', expectedProviderRevision: 0, events: [eventFixture('1'), eventFixture('2')] }); const scoped = core.forExtension(p.extensionId); const page = scoped.externalEvents.list({ providerId: p.providerId, limit: 1 });
      core.db.prepare('UPDATE extension_grants SET grant_revision=grant_revision+1 WHERE extension_id=?').run(p.extensionId);
      expect(() => scoped.externalEvents.list({ providerId: p.providerId, cursor: page.nextCursor! })).toThrow('REVISION_CONFLICT');
    } finally { cleanup(); }
  });
});
