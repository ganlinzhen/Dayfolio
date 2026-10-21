import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'sports-validator-')); });
afterEach(() => rmSync(work, { recursive: true, force: true }));

it('经技能目录软链接执行时，真实校验合法与非法配置并输出结果', () => {
  const skill = fileURLToPath(new URL('../skills/dayfolio', import.meta.url));
  const entry = join(work, 'skills/dayfolio');
  mkdirSync(join(work, 'skills'));
  symlinkSync(skill, entry, 'dir');
  const config = join(work, 'sports-page.json');
  const page = {
    schemaVersion: 1, pageId: 'isolated-validator-probe', revision: 1,
    event: { id: 'probe', name: '模拟赛事', sport: '模拟', edition: '验收', scope: 'single_sport' },
    participantKinds: ['team'], modules: ['schedule'], preferences: {},
    target: { kind: 'local', entry: 'index.html' }, stages: [], sources: [], records: [],
  };
  writeFileSync(config, JSON.stringify(page));
  const run = () => spawnSync(process.execPath, [join(entry, 'scripts/validate-page.mjs'), config], { encoding: 'utf8', timeout: 10_000 });
  const valid = run();
  expect(valid.status).toBe(0);
  expect(valid.stdout.trim()).not.toBe('');
  expect(JSON.parse(valid.stdout)).toMatchObject({ ok: true, pageId: page.pageId, errors: [] });

  const source = { id: 'roster-report', kind: 'web_page', url: 'https://example.org/edition-roster', coverage: '第三方当届名单报道', status: 'ok' };
  writeFileSync(config, JSON.stringify({ ...page, sources: [source] }));
  expect(JSON.parse(run().stdout)).toMatchObject({ ok: true });
  writeFileSync(config, JSON.stringify({ ...page, sources: [{ ...source, url: null }] }));
  const missingSourceUrl = run();
  expect(missingSourceUrl.status).toBe(1);
  expect(JSON.parse(missingSourceUrl.stdout).errors).toContain('事实来源 roster-report 缺少网址');

  writeFileSync(config, JSON.stringify({ ...page, target: { kind: 'local', entry: '../escape.html' } }));
  const invalid = run();
  expect(invalid.status).toBe(1);
  expect(JSON.parse(invalid.stdout)).toMatchObject({ ok: false });
  expect(JSON.parse(invalid.stdout).errors.length).toBeGreaterThan(0);
});
