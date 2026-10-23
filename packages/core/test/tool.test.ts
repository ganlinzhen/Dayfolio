// 工具箱服务：分类（新增/重名/排序/删除联动）+ 工具 CRUD（必填校验/分类校验/更新）
import { afterEach, describe, expect, it } from 'vitest';
import { mkCore, mkLegacyDb, type TestCtx } from './helpers';
import { createCore } from '../src';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

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
  it('旧版工具升级后沿用图标与顺序，背景默认为自动', () => {
    const old = mkLegacyDb(28);
    try {
      old.db.prepare('INSERT INTO tools(title,icon,entry_file,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('旧工具', 'code', 'index.html', 7, '2026-10-21', '2026-10-21');
      const c = createCore(old.db, { dbPath: old.dbPath });
      expect(c.tools.listTools()[0]).toMatchObject({ title: '旧工具', icon: 'code', sort_order: 7, icon_background: 'auto' });
      expect(createCore(old.db, { dbPath: old.dbPath }).tools.listTools()).toHaveLength(1);
    } finally { old.cleanup(); }
  });
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

  it('完整重排工具并拒绝过期与重复清单，不改变分组', () => {
    const c = core();
    const cat = c.tools.addCategory({ name: '效率' });
    const a = c.tools.addTool({ title: '一', category_id: cat.id, entry_file: 'a.html' });
    const b = c.tools.addTool({ title: '二', entry_file: 'b.html' });
    c.tools.reorderTools([b.id, a.id]);
    expect(c.tools.listTools().map(t => t.id)).toEqual([b.id, a.id]);
    expect(c.tools.getTool(a.id).category_id).toBe(cat.id);
    for (const ids of [[a.id], [b.id, b.id], [a.id, 999]]) expect(() => c.tools.reorderTools(ids)).toThrow('列表已变化');
    expect(c.tools.listTools().map(t => t.id)).toEqual([b.id, a.id]);
  });

  it('保存图片图标与背景，元信息更新保留图标并拒绝无效输入', () => {
    const c = core();
    const image = 'data:image/png;base64,aGVsbG8=';
    const t = c.tools.addTool({ title: '图片工具', icon: image, icon_background: '#315bc8', entry_file: 'a.html' });
    expect(t).toMatchObject({ icon: image, icon_background: '#315bc8' });
    expect(c.tools.updateTool(t.id, { title: '新名称' })).toMatchObject({ icon: image, icon_background: '#315bc8' });
    expect(() => c.tools.updateTool(t.id, { title: ' ' })).toThrow('不能为空');
    expect(() => c.tools.updateTool(t.id, { title: '长'.repeat(41) })).toThrow('最长');
    expect(() => c.tools.updateTool(t.id, { icon_background: 'url(https://example.com)' })).toThrow('图标背景');
    expect(() => c.tools.updateTool(t.id, { icon: 'data:text/html;base64,aA==' })).toThrow('本地图片');
    expect(c.tools.getTool(t.id).title).toBe('新名称');
  });

  it('编辑信息和入口保留全部资源，无效入口或替换失败保留原记录与文件', () => {
    const c = core();
    const files = ['index.html', 'pages/detail.html', 'assets/app.js', 'dayfolio-follow.txt'].map(name => ({ name, contentBase64: Buffer.from(name).toString('base64') }));
    const t = c.tools.addTool({ title: '原工具', entry_file: 'index.html', files });
    const root = join(dirname(ctx!.dbPath), 'tools', String(t.id));
    c.tools.updateTool(t.id, { title: '新工具', icon_background: '#6650bd', entry_file: 'pages/detail.html' });
    for (const file of files) expect(readFileSync(join(root, file.name), 'utf8')).toBe(file.name);
    expect(() => c.tools.updateTool(t.id, { title: '错误修改', entry_file: 'missing.html' })).toThrow('现有文件');
    expect(() => c.tools.updateTool(t.id, { title: '错误替换', entry_file: 'absent.html', files: [{ name: 'index.html', contentBase64: 'aA==' }] })).toThrow('本批文件');
    expect(c.tools.getTool(t.id)).toMatchObject({ title: '新工具', entry_file: 'pages/detail.html' });
    expect(existsSync(join(root, 'assets/app.js'))).toBe(true);
  });
});
