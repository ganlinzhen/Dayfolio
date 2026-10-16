// 运行时修订、分类偏好与统一显示时区；写入均由 Commands 包装。
import { inTx, type DbAdapter } from '../db';
import type { CalendarCollection } from '../runtime-types';
import type { TodoService } from './todo';
import { displayTimezone, ensureTimezone, runtimeError } from '../utils/schedule';

export function createRuntimeService(db: DbAdapter, deps: { todos: () => TodoService; managedWrite: <T>(fn: () => T) => T }) {
  const getRevision = () => Number(db.prepare('SELECT revision FROM runtime_revision WHERE id=1').get()!.revision);
  const getDisplayTimezone = () => displayTimezone(db);
  const setDisplayTimezone = (zone: string) => inTx(db, () => {
    ensureTimezone(zone); if (zone === displayTimezone(db)) return zone;
    db.prepare('UPDATE runtime_settings SET display_timezone=? WHERE id=1').run(zone);
    deps.managedWrite(() => {
      for (const row of db.prepare("SELECT id,scheduled_start_at,scheduled_end_at FROM todos WHERE time_mode='instant'").all()) deps.todos().update(Number(row.id), { time_mode: 'instant', scheduled_start_at: String(row.scheduled_start_at), scheduled_end_at: row.scheduled_end_at as string | null });
    });
    return zone;
  });
  const listCollections = ():CalendarCollection[] => db.prepare('SELECT c.*,p.visible,e.status AS extension_status FROM calendar_collections c LEFT JOIN calendar_collection_preferences p ON p.collection_id=c.id LEFT JOIN extensions e ON e.id=c.owner_extension_id ORDER BY c.sort_order,c.id').all().map(c => ({ id: String(c.id), title: String(c.title), color: String(c.color), sortOrder: Number(c.sort_order), extensionStatus:(c.extension_status as CalendarCollection['extensionStatus'])??null, archived: Boolean(c.archived), ownerExtensionId: c.owner_extension_id == null ? null : String(c.owner_extension_id), visible: c.visible === undefined || c.visible === null ? String(c.id).startsWith('builtin.') : Boolean(c.visible) }));
  const setVisibility = (input: { collectionId: string; visible: boolean }) => inTx(db, () => {
    if (typeof input.visible !== 'boolean' || !db.prepare('SELECT 1 FROM calendar_collections WHERE id=?').get(input.collectionId)) runtimeError('CONTRACT_INVALID', '分类或显示设置不合法');
    const current = db.prepare('SELECT visible FROM calendar_collection_preferences WHERE collection_id=?').get(input.collectionId);
    if (current && Boolean(current.visible) === input.visible) return;
    db.prepare('INSERT INTO calendar_collection_preferences VALUES(?,?,?) ON CONFLICT(collection_id) DO UPDATE SET visible=excluded.visible,updated_at=excluded.updated_at').run(input.collectionId, input.visible ? 1 : 0, new Date().toISOString());
  });
  return { getRevision, getDisplayTimezone, setDisplayTimezone, listCollections, setVisibility };
}
export type RuntimeService = ReturnType<typeof createRuntimeService>;
