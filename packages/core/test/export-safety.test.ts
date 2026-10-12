// 导出安全回归（2026-10-11 安全复核）：
// 1. 草稿/素材包必须硬拒绝写入 vault——即使该 vault 尚未注册（内置默认保护根 + TODODESK_PROTECTED_DIRS）；
// 2. resolve 字符串前缀检查会被符号链接别名/上级 symlink 绕过——必须 realpath 后再比较；
// 3. study.exportCards 的 vault 外约束在 core 层生效，不再仅靠提示文案。
// 全程隔离临时目录；本文件会临时接管 process.env.HOME（验证内置默认根），afterAll 恢复。
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openNodeSqliteDb } from '../src/adapters/node-sqlite';
import { createCore, realPathOfMaybeMissing, type TodoDeskCore } from '../src/index';

let dir: string;
let core: TodoDeskCore;
let vaultDir: string;
let okDir: string;
const realHome = process.env.HOME;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'td-export-safety-'));
  vaultDir = join(dir, 'kb');
  mkdirSync(join(vaultDir, 'knowledge/resources/fa'), { recursive: true });
  okDir = join(dir, 'ok-exports');
  mkdirSync(okDir, { recursive: true });
  const dbPath = join(dir, 'test.db');
  core = createCore(openNodeSqliteDb(dbPath), { dbPath });
});

afterAll(() => {
  if (realHome !== undefined) process.env.HOME = realHome; // 恢复，避免泄漏到同 worker 的后续文件
  rmSync(dir, { recursive: true, force: true });
});

const mkContent = () => {
  const c = core.media.addContent({ title: '导出安全' });
  core.media.addVersion(c.id, { platform: 'weixin', body: 'x' });
  return c;
};

describe('未注册 vault 也硬拒绝（内置默认根 + 环境变量扩展）', () => {
  it('TODODESK_PROTECTED_DIRS 指定的未注册目录：exportPackage 与 exportCards 均拒绝', () => {
    const protectedDir = join(dir, 'unregistered-vault');
    mkdirSync(protectedDir, { recursive: true });
    process.env.TODODESK_PROTECTED_DIRS = protectedDir;
    try {
      const c = mkContent();
      expect(() => core.media.exportPackage(c.id, join(protectedDir, 'out'))).toThrow('vault');
      expect(() => core.media.exportPackage(c.id, protectedDir)).toThrow('vault'); // 恰好等于根也拒绝
      expect(() => core.study.exportCards({}, join(protectedDir, 'cards'))).toThrow('vault');
    } finally {
      delete process.env.TODODESK_PROTECTED_DIRS;
    }
  });

  it('内置默认保护根 ~/Desktop/knowledge-base：未注册也拒绝（隔离 HOME 下验证）', () => {
    const isoHome = join(dir, 'iso-home');
    process.env.HOME = isoHome;
    if (homedir() !== isoHome) {
      // 防御：若运行时的 homedir 不跟随环境变量则跳过（不掩盖其他用例）
      process.env.HOME = realHome;
      return;
    }
    const builtinRoot = join(isoHome, 'Desktop', 'knowledge-base');
    mkdirSync(builtinRoot, { recursive: true });
    try {
      const c = mkContent();
      expect(() => core.media.exportPackage(c.id, builtinRoot)).toThrow('vault');
      expect(() => core.media.exportPackage(c.id, join(builtinRoot, 'sub', 'deeper'))).toThrow('vault');
      expect(() => core.study.exportCards({}, join(builtinRoot, 'cards'))).toThrow('vault');
      // vault 外目录不受影响（不误伤）；两侧都 realpath 再比（macOS /var → /private/var）
      const out = core.media.exportPackage(c.id, okDir);
      expect(realPathOfMaybeMissing(out.dir).startsWith(realPathOfMaybeMissing(okDir))).toBe(true);
    } finally {
      process.env.HOME = realHome; // 立即恢复，缩小窗口
    }
  });
});

describe('symlink 别名与上级 symlink 绕过防护', () => {
  it('注册 vault 后：直接别名 → vault 拒绝；别名 → vault 内子目录 拒绝', () => {
    core.vaults.register({ root_path: vaultDir });
    const alias = join(dir, 'alias-to-vault');
    symlinkSync(vaultDir, alias);
    const c = mkContent();
    expect(() => core.media.exportPackage(c.id, alias)).toThrow('vault'); // 修复前：resolve(alias) 字符串不含 vault 路径 → 会放行
    expect(() => core.media.exportPackage(c.id, join(alias, 'exports'))).toThrow('vault');
    expect(() => core.study.exportCards({}, alias)).toThrow('vault');
  });

  it('上级目录符号链接：target = link/vaultName/x 也拒绝', () => {
    const parentLink = join(dir, 'link-to-parent');
    symlinkSync(dir, parentLink); // dir 含 kb/
    const c = mkContent();
    // 修复前：resolve 得 /…/link-to-parent/kb/x，字符串前缀不匹配 realpath(vaultDir) → 放行
    expect(() => core.media.exportPackage(c.id, join(parentLink, 'kb', 'exports'))).toThrow('vault');
  });

  it('目标不存在的上级 symlink：realPathOfMaybeMissing 沿存在的最深祖先解析', () => {
    const alias = join(dir, 'alias2');
    symlinkSync(join(vaultDir, 'knowledge'), alias);
    const c = mkContent();
    // 导出目录本身不存在，但其上级（alias）是 symlink → 解析后落在 vault 内 → 拒绝
    expect(() => core.media.exportPackage(c.id, join(alias, 'resources', 'fa', 'new-dir'))).toThrow('vault');
    expect(realPathOfMaybeMissing(join(alias, 'resources'))).toContain(vaultDir);
  });

  it('指向 vault 外的符号链接不误伤', () => {
    const goodLink = join(dir, 'link-to-ok');
    symlinkSync(okDir, goodLink);
    const c = mkContent();
    const out = core.media.exportPackage(c.id, goodLink);
    // 返回的是真实落点（realpath 形式），两侧 realpath 再比
    expect(realPathOfMaybeMissing(out.dir).startsWith(realPathOfMaybeMissing(okDir))).toBe(true);
    expect(existsSync(join(out.dir, 'master.md'))).toBe(true);
  });
});

describe('study.exportCards 的 core 层硬约束', () => {
  it('已注册 vault 内导出拒绝；vault 外正常导出路径不受影响（返回空结果而非报错）', () => {
    const inner = join(vaultDir, 'exports');
    mkdirSync(inner, { recursive: true });
    expect(() => core.study.exportCards({}, inner)).toThrow('vault');
    // 无会话时空选择器在 vault 外目录：正常返回（exported=0）
    const r = core.study.exportCards({}, join(dir, 'study-out'));
    expect(r.exported).toBe(0);
  });
});
