// 「数据」面板 IPC：存储总览、对象浏览、三类型管理、动作执行、备份/导出/体检
import { app, shell } from 'electron';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ipcMain } from 'electron';
import { defaultDbPath, type TodoDeskCore } from '../../../../packages/core/src/index';
import { toolsRoot } from './tools-store';

const handle = (channel: string, fn: (payload: unknown) => unknown) => {
  ipcMain.handle(channel, (_event, payload) => {
    try {
      return { ok: true, data: fn(payload) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
};

const fileSize = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

const dirSize = (path: string): number => {
  try {
    return readdirSync(path, { withFileTypes: true }).reduce((sum, e) => sum + (e.isDirectory() ? dirSize(join(path, e.name)) : fileSize(join(path, e.name))), 0);
  } catch {
    return 0;
  }
};

const backupsDir = (): string => {
  const dir = join(app.getPath('userData'), 'Backups');
  mkdirSync(dir, { recursive: true });
  return dir;
};

const stamp = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export function registerDataIpc(core: TodoDeskCore): void {
  // ---------- 总览 ----------
  handle('data:getOverview', () => {
    const dbPath = defaultDbPath();
    const types = core.ontology.listObjectTypes().filter((t) => !t.isVirtual);
    const tables = types.map((t) => ({ apiName: t.apiName, title: t.title, isSystem: t.isSystem, count: core.objects.count(t.apiName) }));
    return {
      db: {
        path: dbPath,
        sizeBytes: fileSize(dbPath) + fileSize(`${dbPath}-wal`) + fileSize(`${dbPath}-shm`),
        walMode: true,
        userVersion: Number((core.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined)?.user_version ?? 0),
      },
      tables,
      meta: {
        objectTypes: core.ontology.listObjectTypes().length,
        linkTypes: core.ontology.listLinkTypes().length,
        actionTypes: core.ontology.listActionTypes().length,
      },
      toolsDir: { path: toolsRoot(), sizeBytes: dirSize(toolsRoot()), toolCount: core.tools.listTools().length },
      backupsDir: backupsDir(),
    };
  });

  // ---------- 类型与对象 ----------
  handle('data:listTypes', () => ({
    objects: core.ontology.listObjectTypes(),
    links: core.ontology.listLinkTypes(),
    actions: core.ontology.listActionTypes(),
  }));
  handle('data:listObjects', (p) => {
    const { apiName, search, limit, offset } = (p ?? {}) as { apiName: string; search?: string; limit?: number; offset?: number };
    return core.objects.list(apiName, { search, limit: limit ?? 50, offset: offset ?? 0 });
  });
  handle('data:getObject', (p) => {
    const { apiName, id } = (p ?? {}) as { apiName: string; id: string | number };
    const row = core.objects.get(apiName, id);
    if (!row) throw new Error(`对象不存在：${apiName}#${String(id)}`);
    return { row, links: core.objects.resolveLinks(apiName, row) };
  });

  // ---------- 对象类型管理 ----------
  handle('data:createObjectType', (p) => core.ontology.createObjectType(p as never));
  handle('data:updateObjectType', (p) => {
    const { apiName, patch } = (p ?? {}) as { apiName: string; patch: Record<string, unknown> };
    return core.ontology.updateObjectType(apiName, patch as never);
  });
  handle('data:deleteObjectType', (p) => {
    core.ontology.deleteObjectType(String((p as { apiName: string }).apiName));
    return true;
  });

  // ---------- 链接类型管理 ----------
  handle('data:createLinkType', (p) => core.ontology.createLinkType(p as never));
  handle('data:deleteLinkType', (p) => {
    core.ontology.deleteLinkType(String((p as { apiName: string }).apiName));
    return true;
  });

  // ---------- 动作类型管理 ----------
  handle('data:createActionType', (p) => core.ontology.createActionType(p as never));
  handle('data:updateActionType', (p) => {
    const { apiName, patch } = (p ?? {}) as { apiName: string; patch: Record<string, unknown> };
    return core.ontology.updateActionType(apiName, patch as never);
  });
  handle('data:deleteActionType', (p) => {
    core.ontology.deleteActionType(String((p as { apiName: string }).apiName));
    return true;
  });
  handle('data:invokeAction', (p) => {
    const { apiName, params } = (p ?? {}) as { apiName: string; params: Record<string, unknown> };
    return core.actions.execute(apiName, params ?? {});
  });

  // ---------- 维护 ----------
  // 备份：VACUUM INTO 在线备份（WAL 下直接拷贝主文件会得到不一致快照，禁止）
  handle('data:backup', () => {
    const file = join(backupsDir(), `tododesk-${stamp()}.db`);
    core.db.prepare('VACUUM INTO ?').run(file);
    return file;
  });
  handle('data:exportJson', () => {
    const dump = {
      exportedAt: new Date().toISOString(),
      types: {
        objects: core.ontology.listObjectTypes(),
        links: core.ontology.listLinkTypes(),
        actions: core.ontology.listActionTypes(),
      },
      data: {} as Record<string, unknown[]>,
    };
    for (const t of core.ontology.listObjectTypes()) {
      if (t.isVirtual || !t.tableName) continue;
      const rows: unknown[] = [];
      let offset = 0;
      for (;;) {
        const page = core.objects.list(t.apiName, { limit: 500, offset });
        rows.push(...page.rows);
        offset += 500;
        if (rows.length >= page.total || page.rows.length === 0) break;
      }
      dump.data[t.apiName] = rows;
    }
    const file = join(backupsDir(), `tododesk-${stamp()}.json`);
    writeFileSync(file, JSON.stringify(dump, null, 2), 'utf8');
    return file;
  });
  handle('data:healthCheck', () => {
    const integrity = (core.db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check?: string }>).map((r) => String(r.integrity_check ?? ''));
    const fk = core.db.prepare('PRAGMA foreign_key_check').all();
    return { integrityOk: integrity.every((x) => x === 'ok'), integrityMessages: integrity, foreignKeyViolations: fk.length };
  });
  handle('data:vacuum', () => {
    core.db.exec('VACUUM');
    return true;
  });
  handle('data:openDataDir', (p) => {
    const which = String((p as { which?: string })?.which ?? 'db');
    const dbPath = defaultDbPath();
    const dir =
      which === 'tools' ? toolsRoot() : which === 'backups' ? backupsDir() : dbPath.substring(0, dbPath.lastIndexOf('/'));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    void shell.openPath(dir);
    return dir;
  });
}
