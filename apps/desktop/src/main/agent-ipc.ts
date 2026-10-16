// 能力包只从已验收产物导出；目录由系统对话框选择，不修改客户端注册配置。
import { app, dialog, ipcMain } from 'electron';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defaultDbPath } from '../../../../packages/core/src/index';
import { installAgentKit, verifyAgentKit } from '../../../../packages/agent-kit/scripts/package.mjs';
import type { AgentKitStatus } from '../../../../packages/agent-kit/types';

const source = () => app.isPackaged ? join(process.resourcesPath, 'agent-kit') : resolve(__dirname, '../../../../dist/agent-kit');
const receipt = () => join(dirname(defaultDbPath()), 'agent-kit-install.json');

function status(): AgentKitStatus {
  const result: AgentKitStatus = { bundledVersion: null, exportedVersion: null, exportedPath: null, clientNode: null, issues: [] };
  try { result.bundledVersion = verifyAgentKit(source()).version; }
  catch (error) { result.issues.push('随包能力校验失败：' + (error instanceof Error ? error.message : String(error))); }
  if (existsSync(receipt())) {
    try {
      const saved: unknown = JSON.parse(readFileSync(receipt(), 'utf8'));
      if (!saved || typeof saved !== 'object' || !('target' in saved) || typeof saved.target !== 'string') throw new Error('导出记录不合法');
      result.exportedPath = saved.target;
      result.exportedVersion = verifyAgentKit(saved.target).version;
      if (result.exportedVersion !== result.bundledVersion) result.issues.push('导出副本与随包版本不同，可重新导出更新。');
    } catch (error) { result.issues.push('导出副本校验失败：' + (error instanceof Error ? error.message : String(error))); }
  }
  const node = spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 5000 });
  if (node.status === 0) {
    result.clientNode = node.stdout.trim();
    const [major, minor] = result.clientNode.split('.').map(Number);
    if (!((major === 22 && minor >= 13) || major === 24)) result.issues.push('PATH 中的 Node 版本不受支持；客户端需使用 22.13+ 的 22.x 或 24.x。');
  } else result.issues.push('App 的 PATH 中未找到 Node；已有接入若指定 Node 绝对路径，可继续使用。');
  return result;
}

export function registerAgentIpc(): void {
  const handle = (name: string, fn: () => unknown) => ipcMain.handle(name, async () => {
    try { return { ok: true, data: await fn() }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  });
  handle('agent:status', status);
  handle('agent:export', async () => {
    verifyAgentKit(source());
    const choice = await dialog.showOpenDialog({ title: '选择 Dayfolio 能力包导出位置', properties: ['openDirectory', 'createDirectory'] });
    if (choice.canceled || !choice.filePaths[0]) return null;
    const target = join(choice.filePaths[0], 'Dayfolio-Agent');
    const result = installAgentKit(source(), target);
    mkdirSync(dirname(receipt()), { recursive: true });
    writeFileSync(receipt(), JSON.stringify({ target }, null, 2) + '\n');
    return result;
  });
}
