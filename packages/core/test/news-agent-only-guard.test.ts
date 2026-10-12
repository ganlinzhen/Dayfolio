// agent-only 守卫回归：App 与本地代码不得再有任何 RSS 抓取 / 新闻源配置 / 凭证 / 定时抓取入口。
// 用文件级断言锁住结构（用户 2026-10-11 批准的授权边界），防止后续改动悄悄把抓取加回来。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

describe('新闻 agent-only 边界（App 无抓取/凭证/调度入口）', () => {
  it('本地抓取 CLI 与脚本入口已移除', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['news:fetch']).toBeUndefined();
    expect(existsSync(join(root, 'apps/news'))).toBe(false);
  });

  it('桌面主进程：无联网抓取通道、无源/话题管理、无定时抓取定时器、无凭证读写', () => {
    const ipc = read('apps/desktop/src/main/ipc.ts');
    for (const banned of [
      'news:refresh', 'news:syncStatus', 'news:sources', 'news:addTopic', 'news:addRssSource',
      'news:updateSource', 'news:deleteSource', 'news:getSettings', 'news:setSettings',
      'startNewsSync', 'rss_auto_refresh', 'setInterval', 'getXCredential',
    ]) {
      expect(ipc.includes(banned), `ipc.ts 不应包含 ${banned}`).toBe(false);
    }
  });

  it('preload 与渲染层：无抓取/源配置通道，面板无抓取触发入口', () => {
    const preload = read('apps/desktop/src/preload/index.ts');
    for (const banned of ['news:refresh', 'news:sources', 'news:addRssSource', 'news:setSettings', 'news:syncStatus']) {
      expect(preload.includes(banned), `preload 不应包含 ${banned}`).toBe(false);
    }
    // 结构性入口断言（文案里「不联网抓取」的说明允许存在，触发入口不允许）
    const panel = read('apps/desktop/src/renderer/src/components/NewsPanel.tsx');
    for (const banned of ['api.news.refresh', 'api.news.sources', 'api.news.addRssSource', 'api.news.setSettings', 'api.news.syncStatus', 'startRefresh', '源与定时设置', 'IconGlobe']) {
      expect(panel.includes(banned), `NewsPanel 不应包含 ${banned}`).toBe(false);
    }
  });

  it('core：RSS/采集任务/凭证服务文件已删除，入口不再导出', () => {
    expect(existsSync(join(root, 'packages/core/src/services/rss.ts'))).toBe(false);
    expect(existsSync(join(root, 'packages/core/src/services/news-sync.ts'))).toBe(false);
    expect(existsSync(join(root, 'packages/core/src/services/news-credential.ts'))).toBe(false);
    const idx = read('packages/core/src/index.ts');
    for (const banned of ['createNewsSyncService', 'fetchAllRss', 'getXCredential', 'TODODESK_X_BEARER_TOKEN']) {
      expect(idx.includes(banned), `core 入口不应包含 ${banned}`).toBe(false);
    }
  });

  it('MCP：不注册任何抓取/源管理工具（fetch_news / RSS 源 / X 话题 / 采集任务）', () => {
    const server = read('apps/mcp/src/server.ts');
    for (const banned of ["'fetch_news'", "'get_news_sync'", "'list_news_sources'", "'add_news_rss_source'", "'update_news_source'", "'delete_news_source'", "'add_news_topic'", "'update_news_topic'", "'delete_news_topic'", 'startNewsSync']) {
      expect(server.includes(banned), `MCP server 不应包含 ${banned}`).toBe(false);
    }
  });

  it('App 可发起任务但不可执行：有 createTask/cancelTask 通道，无认领/提交/完成/释放通道', () => {
    const preload = read('apps/desktop/src/preload/index.ts');
    expect(preload.includes("invoke('news:createTask')"), 'App 应提供用户发起任务的入口').toBe(true);
    expect(preload.includes("invoke('news:cancelTask')"), 'App 应提供取消待执行任务的入口').toBe(true);
    for (const banned of ["invoke('news:claimTask')", "invoke('news:submitItems')", "invoke('news:completeTask')", "invoke('news:releaseTask')"]) {
      expect(preload.includes(banned), `preload 不应包含 ${banned}（执行是 agent 经 MCP 的专属动作，离线不自动唤醒）`).toBe(false);
    }
    const ipc = read('apps/desktop/src/main/ipc.ts');
    expect(ipc.includes("core.news.createTask(p as never, 'app')")).toBe(true);
    for (const method of ['claimTask', 'submitItems', 'completeTask', 'releaseTask']) {
      expect(ipc.includes(`core.news.${method}`), `ipc 不应调用 core.news.${method}`).toBe(false);
    }
  });
});
