// 工具箱服务：分类（新增/重名/排序/删除联动）+ 工具 CRUD（必填校验/分类校验/更新）
import { afterEach, describe, expect, it } from 'vitest';
import { mkCore, type TestCtx } from './helpers';

let ctx: TestCtx | null = null;
const core = () => {
  ctx = mkCore();
  return ctx.core;
};

afterEach(() => ctx?.cleanup());

describe('工具箱分类', () => {
  it('新增并按 sort_order 排序列出', () => {
    const c = core();
    c.tools.addCategory({ name: '效率' });
    c.tools.addCategory({ name: '开发' });
    expect(c.tools.listCategories().map((x) => x.name)).toEqual(['效率', '开发']);
  });

  it('空名与重名被拒绝', () => {
    const c = core();
    expect(() => c.tools.addCategory({ name: '  ' })).toThrow('不能为空');
    c.tools.addCategory({ name: '效率' });
    expect(() => c.tools.addCategory({ name: '效率' })).toThrow('同名');
  });

  it('改名：同名（排除自身）冲突报错，改名生效', () => {
    const c = core();
    const a = c.tools.addCategory({ name: 'A' });
    c.tools.addCategory({ name: 'B' });
    expect(() => c.tools.renameCategory(a.id, 'B')).toThrow('同名');
    c.tools.renameCategory(a.id, '甲');
    expect(c.tools.listCategories().map((x) => x.name)).toEqual(['甲', 'B']);
    expect(() => c.tools.renameCategory(9999, 'X')).toThrow('不存在');
  });

  it('reorderCategories 按传入顺序重排', () => {
    const c = core();
    const a = c.tools.addCategory({ name: 'A' });
    const b = c.tools.addCategory({ name: 'B' });
    const d = c.tools.addCategory({ name: 'C' });
    c.tools.reorderCategories([d.id, b.id, a.id]);
    expect(c.tools.listCategories().map((x) => x.name)).toEqual(['C', 'B', 'A']);
  });

  it('删除分类后其下工具变为未分类', () => {
    const c = core();
    const cat = c.tools.addCategory({ name: '效率' });
    const t = c.tools.addTool({ title: '调色板', category_id: cat.id, entry_file: 'index.html' });
    c.tools.deleteCategory(cat.id);
    expect(c.tools.listCategories()).toHaveLength(0);
    expect(c.tools.getTool(t.id).category_id).toBeNull();
  });
});

describe('工具条目', () => {
  it('新增：必填校验与默认图标', () => {
    const c = core();
    expect(() => c.tools.addTool({ title: ' ', entry_file: 'a.html' })).toThrow('不能为空');
    expect(() => c.tools.addTool({ title: 'T', entry_file: '' })).toThrow('入口文件');
    expect(() => c.tools.addTool({ title: 'T', entry_file: 'manifest.json' })).toThrow('必须是 HTML');
    expect(() => c.tools.addTool({ title: 'T', entry_file: 'a.html', category_id: 999 })).toThrow('分类不存在');
    const t = c.tools.addTool({ title: '调色板', entry_file: 'index.html' });
    expect(t.icon).toBe('tool');
    expect(t.category_id).toBeNull();
    expect(c.tools.listTools()).toHaveLength(1);
  });

  it('更新：可改标题/图标/分类，未知工具报错', () => {
    const c = core();
    const cat = c.tools.addCategory({ name: '效率' });
    const t = c.tools.addTool({ title: '调色板', entry_file: 'index.html' });
    expect(() => c.tools.updateTool(t.id, { entry_file: 'app.js' })).toThrow('必须是 HTML');
    const up = c.tools.updateTool(t.id, { title: '取色器', icon: 'color', category_id: cat.id });
    expect(up).toMatchObject({ title: '取色器', icon: 'color', category_id: cat.id });
    expect(() => c.tools.updateTool(999, { title: 'x' })).toThrow('不存在');
  });

  it('删除工具', () => {
    const c = core();
    const t = c.tools.addTool({ title: 'T', entry_file: 'a.html' });
    c.tools.deleteTool(t.id);
    expect(c.tools.listTools()).toHaveLength(0);
    expect(() => c.tools.getTool(t.id)).toThrow('不存在');
  });

  it('列表按 sort_order 排序（先加的在前）', () => {
    const c = core();
    c.tools.addTool({ title: '一', entry_file: 'a.html' });
    c.tools.addTool({ title: '二', entry_file: 'b.html' });
    expect(c.tools.listTools().map((x) => x.title)).toEqual(['一', '二']);
  });
});
