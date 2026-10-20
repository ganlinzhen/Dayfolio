import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { affectsApp, compareVersions, planRelease, releaseNotes, validateVersionChange } from './release.mjs';

describe('GitHub 发布合同', () => {
  it('按数值比较版本，拒绝不规范版本', () => {
    expect(compareVersions('0.21.0', '0.4.1')).toBe(1);
    expect(compareVersions('1.0.0', '0.99.9')).toBe(1);
    expect(compareVersions('0.21.0', '0.21.0')).toBe(0);
    for (const version of ['v1.0.0', '01.0.0', '1.0.0-beta.1', '1.0']) {
      expect(() => compareVersions(version, '1.0.0')).toThrow();
    }
  });

  it('覆盖 App、MCP、帮助、依赖和能力包，排除纯测试与仓库说明', () => {
    for (const path of ['apps/desktop/src/main/index.ts', 'apps/desktop/scripts/package.mjs', 'apps/help/docs/01-todo.md', 'apps/mcp/src/server.ts', 'packages/agent-kit/skills/dayfolio/SKILL.md', 'package-lock.json', 'scripts/generate-command-inputs.cjs']) expect(affectsApp(path)).toBe(true);
    for (const path of ['README.md', 'AGENTS.md', '.github/workflows/release.yml', 'scripts/release.mjs', 'packages/core/test/todo.test.ts', 'apps/desktop/scripts/ui-smoke-course.mjs', 'apps/desktop/scripts/ui-smoke-news.mjs']) expect(affectsApp(path)).toBe(false);
  });

  it('应用修改必须升版，纯说明修改可以保留版本，禁止回退', () => {
    expect(() => validateVersionChange({ version: '0.21.0', previousVersion: '0.21.0', paths: ['apps/help/docs/01-todo.md'] })).toThrow('必须递增版本号');
    expect(() => validateVersionChange({ version: '0.21.1', previousVersion: '0.21.0', paths: ['apps/desktop/src/main/index.ts'] })).not.toThrow();
    expect(() => validateVersionChange({ version: '0.21.0', previousVersion: '0.21.0', paths: ['README.md'] })).not.toThrow();
    expect(() => validateVersionChange({ version: '0.21.0', previousVersion: '0.21.0', paths: ['apps/desktop/scripts/ui-smoke-course.mjs'] })).not.toThrow();
    expect(() => validateVersionChange({ version: '0.20.0', previousVersion: '0.21.0', paths: [] })).toThrow('不能');
  });

  it('只提取当前版本的中文更新说明', () => {
    const changelog = '# 发版记录\n\n## 0.21.0 — 2026-10-16\n\n### 新增\n\n- 新功能\n\n## 0.20.0 — 2026-10-15\n\n### 修复\n\n- 旧修复\n';
    expect(releaseNotes(changelog, '0.21.0')).toBe('### 新增\n\n- 新功能');
    expect(() => releaseNotes(changelog, '0.20.0')).toThrow('首个版本');
    expect(() => releaseNotes(changelog.replace('## 0.20.0', '## 0.21.0'), '0.21.0')).toThrow('重复版本');
    expect(() => releaseNotes('## 0.21.0 — 2026-10-16\n\n待填写', '0.21.0')).toThrow('缺少');
  });
});

describe('真实 Git 历史中的发布计划', () => {
  // 真实 Git 子进程会与全套 MCP 测试争用机器资源，使用独立的集成测试时限。
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'dayfolio-release-test-'));
    directories.push(directory);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: directory, encoding: 'utf8' }).trim();
    const write = (path: string, value: unknown) => writeFileSync(join(directory, path), typeof value === 'string' ? value : JSON.stringify(value));
    mkdirSync(join(directory, 'apps/desktop'), { recursive: true });
    write('package.json', { version: '0.21.0' });
    write('apps/desktop/package.json', { version: '0.21.0' });
    write('package-lock.json', { version: '0.21.0', packages: { '': { version: '0.21.0' }, 'apps/desktop': { version: '0.21.0' } } });
    write('CHANGELOG.md', '## 0.21.0 — 2026-10-16\n\n### 新增\n\n- 新功能\n');
    git('init', '-b', 'main');
    const commit = () => {
      git('add', 'package.json', 'package-lock.json', 'apps', 'CHANGELOG.md');
      git('-c', 'user.name=发布测试', '-c', 'user.email=release@example.invalid', 'commit', '-qm', '发布测试提交');
      return git('rev-parse', 'HEAD');
    };
    const sha = commit();
    const env = { GITHUB_REPOSITORY: 'example/dayfolio', GITHUB_SHA: sha };
    return { directory, git, write, commit, sha, env };
  }

  it('补发当前版本，并写出与提交一致的发布说明及工作流输出', () => {
    const f = fixture();
    const output = join(f.directory, 'output');
    const event = join(f.directory, 'event.json');
    f.write('event.json', { before: f.sha });
    const plan = planRelease({ ...f.env, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output }, f.directory, () => null);
    expect(plan).toMatchObject({ publish: true, tag: 'v0.21.0', sha: f.sha, target: f.sha });
    expect(readFileSync(output, 'utf8')).toContain('publish=true\n');
    const notes = readFileSync(join(f.directory, 'dist/github-release/notes.md'), 'utf8');
    expect(notes).toContain('Dayfolio-0.21.0-macOS-arm64.zip');
    expect(notes).toContain('Dayfolio-0.21.0-macOS-x64.zip');
    expect(notes).toContain(f.sha);
  }, 15_000);

  it('同一版本只改仓库说明时跳过，草稿在原提交可继续发布', () => {
    const f = fixture();
    f.git('tag', 'v0.21.0');
    expect(planRelease(f.env, f.directory, () => ({ draft: true })).publish).toBe(true);
    f.write('README.md', '仓库说明');
    f.git('add', 'README.md');
    f.git('-c', 'user.name=发布测试', '-c', 'user.email=release@example.invalid', 'commit', '-qm', '更新说明');
    const env = { ...f.env, GITHUB_SHA: f.git('rev-parse', 'HEAD') };
    expect(planRelease(env, f.directory, () => ({ draft: false })).publish).toBe(false);
    expect(() => planRelease(env, f.directory, () => ({ draft: true }))).toThrow('在该标签提交上重跑');
  }, 15_000);

  it('允许尚未生成标签的同提交草稿恢复，拒绝其他提交或丢失标签的正式版', () => {
    const f = fixture();
    expect(planRelease(f.env, f.directory, () => ({ draft: true, target_commitish: f.sha })).publish).toBe(true);
    expect(() => planRelease(f.env, f.directory, () => ({ draft: true, target_commitish: '其他提交' }))).toThrow('检查发布目标');
    expect(() => planRelease(f.env, f.directory, () => ({ draft: false, target_commitish: f.sha }))).toThrow('检查发布目标');
  }, 15_000);

  it('阻止同版本 App 推送和已发布标签的内容漂移', () => {
    const f = fixture();
    f.git('tag', 'v0.21.0');
    f.write('apps/desktop/feature.ts', '// 功能变化');
    const sha = f.commit();
    f.write('event.json', { before: f.sha });
    const env = { ...f.env, GITHUB_SHA: sha, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: join(f.directory, 'event.json') };
    expect(() => planRelease(env, f.directory, () => null)).toThrow('必须递增版本号');
    expect(() => planRelease({ ...f.env, GITHUB_SHA: sha }, f.directory, () => ({ draft: false }))).toThrow('禁止移动已发布标签');
  }, 15_000);

  it('拒绝版本不同步、检出错误及 API 错误', () => {
    const f = fixture();
    expect(() => planRelease({ ...f.env, GITHUB_SHA: '错误提交' }, f.directory, () => null)).toThrow('检出提交');
    expect(() => planRelease(f.env, f.directory, () => { throw new Error('GitHub 认证失败'); })).toThrow('认证失败');
    f.write('apps/desktop/package.json', { version: '0.20.0' });
    expect(() => planRelease(f.env, f.directory, () => null)).toThrow('版本必须一致');
  }, 15_000);
});
