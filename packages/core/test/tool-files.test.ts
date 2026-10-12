// 工具箱文件存储：路径清洗/入口挑选/写入回读/本地收集/目录迁移
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectToolFilesFromPaths,
  deleteToolFilesAt,
  listToolFiles,
  migrateToolFilesDir,
  pickEntryFile,
  sanitizeFileName,
  sanitizeToolPath,
  saveToolFilesTo,
  toolsRootForDb,
} from '../src/utils/tool-files';

let dirs: string[] = [];
const mkDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'tododesk-toolfiles-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('路径清洗', () => {
  it('sanitizeToolPath 保留子目录、拒绝 .. 逃逸与控制字符', () => {
    expect(sanitizeToolPath('assets/app.js')).toBe('assets/app.js');
    expect(sanitizeToolPath('a\\b/c.js')).toBe('a/b/c.js');
    expect(sanitizeToolPath('../../etc/passwd')).toBe('etc/passwd');
    expect(sanitizeToolPath('a<>:"|?*b.html')).toBe('ab.html');
    expect(sanitizeToolPath('   ')).toBe('index.html');
  });

  it('sanitizeFileName 只取最后一段（兼容旧语义）', () => {
    expect(sanitizeFileName('dir/sub/x.html')).toBe('x.html');
  });

  it('toolsRootForDb 从数据库路径推导 tools 目录', () => {
    expect(toolsRootForDb('/data/app/tododesk.db')).toBe(join('/data/app', 'tools'));
  });
});

describe('pickEntryFile 入口挑选', () => {
  it('优先 index.html；唯一 html 直接用', () => {
    expect(pickEntryFile(['a.js', 'index.html'])).toBe('index.html');
    expect(pickEntryFile(['app.css', 'page.htm'])).toBe('page.htm');
  });

  it('没有 html 报错；多个 html 且无 index.html 要求显式指定', () => {
    expect(() => pickEntryFile(['a.js'])).toThrow('缺少 HTML 入口');
    expect(() => pickEntryFile(['x.html', 'y.html'])).toThrow('entry_file');
  });
});

describe('saveToolFilesTo / listToolFiles / deleteToolFilesAt', () => {
  it('写入含子目录的文件集合并按相对路径读回；删除后目录消失', () => {
    const root = mkDir();
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    saveToolFilesTo(root, 7, [
      { name: 'index.html', contentBase64: b64('<h1>hi</h1>') },
      { name: 'assets/app.js', contentBase64: b64('console.log(1)') },
    ]);
    expect(listToolFiles(root, 7)).toEqual(['assets/app.js', 'index.html']);
    expect(existsSync(join(root, '7', 'assets', 'app.js'))).toBe(true);
    // 重复写入是整体重建：旧文件不残留
    saveToolFilesTo(root, 7, [{ name: 'index.html', contentBase64: b64('<h1>v2</h1>') }]);
    expect(listToolFiles(root, 7)).toEqual(['index.html']);
    deleteToolFilesAt(root, 7);
    expect(listToolFiles(root, 7)).toEqual([]);
  });

  it('.. 逃逸段被清洗为目录内文件，不会写到工具目录外', () => {
    const root = mkDir();
    saveToolFilesTo(root, 1, [{ name: '../../../escape.txt', contentBase64: '' }]);
    expect(existsSync(join(root, '1', 'escape.txt'))).toBe(true); // 清洗后落在工具目录内
    expect(existsSync(join(root, 'escape.txt'))).toBe(false); // 目录外无文件
  });
});

describe('collectToolFilesFromPaths 本地收集', () => {
  it('目录递归收集相对路径，跳过点文件；单文件取文件名', () => {
    const src = mkDir();
    mkdirSync(join(src, 'assets'));
    writeFileSync(join(src, 'index.html'), '<p>a</p>');
    writeFileSync(join(src, 'assets', 'app.js'), '1');
    writeFileSync(join(src, '.DS_Store'), 'junk');
    const files = collectToolFilesFromPaths([src]);
    expect(files.map((f) => f.name).sort()).toEqual(['assets/app.js', 'index.html']);
    const html = files.find((f) => f.name === 'index.html') as { contentBase64: string };
    expect(Buffer.from(html.contentBase64, 'base64').toString('utf8')).toBe('<p>a</p>');

    const single = collectToolFilesFromPaths([join(src, 'index.html')]);
    expect(single[0].name).toBe('index.html');
  });

  it('路径不存在报错；空结果报错', () => {
    expect(() => collectToolFilesFromPaths(['/nonexistent/xx.html'])).toThrow('不存在');
    const empty = mkDir();
    expect(() => collectToolFilesFromPaths([empty])).toThrow('没有收集到任何文件');
  });
});

describe('migrateToolFilesDir 目录迁移', () => {
  it('同路径无操作；不同路径逐目录搬移且不覆盖已有', () => {
    const base = mkDir();
    const legacy = join(base, 'legacy', 'tools');
    const target = join(base, 'new', 'tools');
    mkdirSync(join(legacy, '1'), { recursive: true });
    mkdirSync(join(legacy, '2'), { recursive: true });
    writeFileSync(join(legacy, '1', 'index.html'), 'a');
    mkdirSync(join(target, '2'), { recursive: true }); // 目标已有 2，不覆盖
    writeFileSync(join(legacy, '2', 'old.html'), 'old');

    migrateToolFilesDir(legacy, target); // 实际搬移
    expect(existsSync(join(target, '1', 'index.html'))).toBe(true);
    expect(existsSync(join(legacy, '1'))).toBe(false);
    expect(existsSync(join(target, '2', 'old.html'))).toBe(false); // 未覆盖

    migrateToolFilesDir(target, target); // 同路径：无操作不报错
    migrateToolFilesDir(join(base, 'none'), target); // 旧目录不存在：静默
  });
});
