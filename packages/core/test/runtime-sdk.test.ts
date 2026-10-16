import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { mkCore } from './helpers';
import { writePackage } from './extension-fixtures';
import { eventFixture } from './runtime-fixtures';
import { createRuntimeDispatcher, validateRuntimeRequest } from '../src/services/runtime-sdk';
import type { TodoDeskCore } from '../src';

function install(core: TodoDeskCore, directory: string, id: string) {
  const capabilities = ['events.read', 'events.import', 'subscriptions.write', 'navigation.openTodo', 'providers.refresh'] as const;
  writePackage(directory, { id, capabilities: capabilities.map(name => ({ name, providerLocalId: 'main' })) });
  const preview = core.extensions.previewInstall({ stagingDirectory: directory });
  const input = { stagingDirectory: directory, expectedPackageDigest: preview.digest, expectedExtensionRevision: preview.currentRevision };
  core.extensions.install({ ...input, authorizationRef: core.commands.human.authorizeExtensionInstall(input).authorizationRef });
  return core.externalEvents.list({ providerId: `ext:${id}/main` }).items[0];
}
const request = (method: string, params: object = {}) => ({ apiMajor: 1, requestId: '测试请求', method, params });

describe('生产 SDK 固定分发合同', () => {
  it('拒绝额外身份、任意方法、参数扩展和普通信封超限', () => {
    expect(() => validateRuntimeRequest({ ...request('runtime.describe'), extensionId: 'forged' })).toThrow('CONTRACT_INVALID');
    expect(() => validateRuntimeRequest(request('raw.ipc'))).toThrow('CONTRACT_INVALID');
    expect(() => validateRuntimeRequest(request('subscriptions.subscribe', { eventId: 'x', extensionId: 'forged' }))).toThrow('CONTRACT_INVALID');
    expect(() => validateRuntimeRequest(request('events.list', { providerId: 'x', limit: 501 }))).toThrow('CONTRACT_INVALID');
    expect(() => validateRuntimeRequest(request('events.list', { providerId: 'x', cursor: 'x'.repeat(70000) }))).toThrow('CONTRACT_INVALID');
  });
  it('两工具复用固定分发器，归属逐次校验，导航仅返回实际关联待办', () => {
    const { core, dbPath, cleanup } = mkCore(); try {
      const own = install(core, join(dirname(dbPath), 'a'), 'test.alpha'), other = install(core, join(dirname(dbPath), 'b'), 'test.beta');
      const opened: unknown[] = [], dispatch = createRuntimeDispatcher(core, 'test.alpha', { openTodo: target => opened.push(target) });
      expect(dispatch(request('runtime.describe'))).toMatchObject({ extensionId: 'test.alpha', api: { major: 1 } });
      expect(() => dispatch(request('events.list', { providerId: other.providerId }))).toThrow('PERMISSION_DENIED');
      expect(() => dispatch(request('subscriptions.subscribe', { eventId: other.id }))).toThrow('PERMISSION_DENIED');
      expect(() => dispatch(request('navigation.openTodo', { eventId: other.id }))).toThrow('PERMISSION_DENIED');
      const result = dispatch(request('subscriptions.subscribe', { eventId: own.id })) as { todo: { id: number } };
      core.todos.update(result.todo.id, { notes: '私人备注', tags: ['私人标签'] });
      expect(dispatch(request('navigation.openTodo', { eventId: own.id }))).toEqual({ opened: true, target: { objectType: 'todo', id: result.todo.id } });
      expect(opened).toEqual([{ objectType: 'todo', id: result.todo.id }]);
      const read = dispatch(request('subscriptions.get', { eventId: own.id })) as { todo: object };
      expect(Object.keys(read.todo).sort()).toEqual(['id', 'revision', 'status', 'title']);
      core.db.prepare("DELETE FROM extension_grants WHERE extension_id=? AND capability='navigation.openTodo'").run('test.alpha');
      expect(() => dispatch(request('navigation.openTodo', { eventId: own.id }))).toThrow('PERMISSION_DENIED');
    } finally { cleanup(); }
  });
  it('SDK 导入与订阅仍走公共命令、整批事务和业务幂等', () => {
    const { core, dbPath, cleanup } = mkCore(); try {
      const event = install(core, join(dirname(dbPath), 'a'), 'test.alpha'), dispatch = createRuntimeDispatcher(core, 'test.alpha');
      const input = request('events.import', { providerId: event.providerId, batchId: 'sdk-1', expectedProviderRevision: 1, events: [{ ...eventFixture(), title: '来源改期' }] });
      const first = dispatch(input); expect(dispatch(input)).toEqual(first);
      core.ontology.updateActionType('add_todo', { status: 'disabled' }); const rev = core.runtime.getRevision();
      expect(() => dispatch(request('subscriptions.subscribe', { eventId: event.id }))).toThrow('ACTION_DISABLED');
      expect(core.todos.list()).toHaveLength(0); expect(core.runtime.getRevision()).toBe(rev);
      core.ontology.updateActionType('add_todo', { status: 'active' });
      expect(dispatch(request('subscriptions.subscribe', { eventId: event.id }))).toMatchObject({ effect: 'created' });
      expect(dispatch(request('subscriptions.subscribe', { eventId: event.id }))).toMatchObject({ effect: 'reused' });
      expect(core.todos.list()).toHaveLength(1);
      expect(dispatch(request('providers.refresh', { providerId: event.providerId }))).toMatchObject({effect:'queued',run:{mode:'external-agent',status:'queued'}});
    } finally { cleanup(); }
  });
  it('缓存分发器也即时服从撤权、停用和卸载', () => {
    const { core, dbPath, cleanup } = mkCore(); try {
      const event = install(core, join(dirname(dbPath), 'a'), 'test.alpha'), dispatch = createRuntimeDispatcher(core, 'test.alpha');
      core.db.prepare("DELETE FROM extension_grants WHERE extension_id=? AND capability='subscriptions.write'").run('test.alpha');
      expect(() => dispatch(request('subscriptions.subscribe', { eventId: event.id }))).toThrow('PERMISSION_DENIED');
      const extension = core.extensions.get({ extensionId: 'test.alpha' })!;
      core.extensions.setEnabled({ extensionId: extension.id, expectedRevision: extension.revision, enabled: false });
      expect(() => dispatch(request('runtime.describe'))).toThrow('SESSION_REVOKED');
      const current = core.extensions.get({ extensionId: 'test.alpha' })!;
      core.extensions.uninstall({ extensionId: current.id, expectedRevision: current.revision });
      expect(() => dispatch(request('events.list', { providerId: event.providerId }))).toThrow('SESSION_REVOKED');
    } finally { cleanup(); }
  });
});
