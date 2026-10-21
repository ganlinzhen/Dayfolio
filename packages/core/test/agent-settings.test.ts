import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkCore, type TestCtx } from './helpers';

describe('通用 Agent 配置', () => {
  let ctx: TestCtx;
  beforeEach(() => { ctx = mkCore(); });
  afterEach(() => ctx.cleanup());
  it('默认不接入，切换供应商保留各自路径，停用不删除配置', () => {
    expect(ctx.core.agentSettings.get().provider).toBe(null);
    ctx.core.agentSettings.update({ provider: 'codex', binary: '/tmp/codex', model: 'test', expected_revision: 0 });
    ctx.core.agentSettings.update({ provider: 'claude', binary: '/tmp/claude', expected_revision: 1 });
    const saved = ctx.core.agentSettings.update({ provider: null, expected_revision: 2 });
    expect(saved.profiles.codex).toEqual({ binary: '/tmp/codex', model: 'test' });
    expect(saved.profiles.claude.binary).toBe('/tmp/claude');
    expect(saved.provider).toBe(null);
  });
  it('拒绝过期修订及命令文本，写入遵守动作启停', () => {
    expect(() => ctx.core.agentSettings.update({ provider: 'codex', binary: 'codex --arg', expected_revision: 0 })).toThrow('绝对路径');
    expect(() => ctx.core.agentSettings.update({ provider: 'codex', expected_revision: 4 })).toThrow('重新加载');
    ctx.core.ontology.updateActionType('update_agent_settings', { status: 'disabled' });
    expect(() => ctx.core.agentSettings.update({ provider: 'codex', expected_revision: 0 })).toThrow();
    expect(ctx.core.agentSettings.get().revision).toBe(0);
  });
});
