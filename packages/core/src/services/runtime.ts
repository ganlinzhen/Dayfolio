// 运行时修订、分类偏好与统一显示时区；写入均由 Commands 包装。
import { inTx, type DbAdapter } from '../db';
import type { CalendarCollection } from '../runtime-types';
import type { TodoService } from './todo';
import { CALENDAR_COLORS } from '../types';
import { displayTimezone, ensureTimezone, runtimeError } from '../utils/schedule';

export function createRuntimeService(db: DbAdapter, deps: { todos: () => TodoService; managedWrite: <T>(fn: () => T) => T; guard: (name:string) => void }) {
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
  const deleteReason = (c:Record<string,unknown>):string|null => String(c.id).startsWith('builtin.') ? '系统内置分类不能删除，可取消勾选隐藏。' : c.owner_extension_id != null || c.has_provider ? '此分类由事件来源维护，不能单独删除，可取消勾选隐藏。' : null;
  const listCollections = ():CalendarCollection[] => db.prepare('SELECT c.*,p.visible,e.status AS extension_status,EXISTS(SELECT 1 FROM event_providers ep WHERE ep.collection_id=c.id) AS has_provider FROM calendar_collections c LEFT JOIN calendar_collection_preferences p ON p.collection_id=c.id LEFT JOIN extensions e ON e.id=c.owner_extension_id ORDER BY c.sort_order,c.id').all().map(c => ({ id: String(c.id), title: String(c.title), color: String(c.color), sortOrder: Number(c.sort_order), extensionStatus:(c.extension_status as CalendarCollection['extensionStatus'])??null, archived: Boolean(c.archived), ownerExtensionId: c.owner_extension_id == null ? null : String(c.owner_extension_id), visible: c.visible === undefined || c.visible === null ? String(c.id).startsWith('builtin.') : Boolean(c.visible), deleteBlockedReason:deleteReason(c) }));
  const currentCollection = (id:string, expectedTitle:string) => {
    const row=db.prepare('SELECT c.*,EXISTS(SELECT 1 FROM event_providers p WHERE p.collection_id=c.id) AS has_provider FROM calendar_collections c WHERE id=?').get(id);
    if(!row) return runtimeError('CONTRACT_INVALID','分类不存在，请刷新后重试');
    if(row.title!==expectedTitle) return runtimeError('REVISION_CONFLICT','分类名称已变化，请重新打开后操作');
    return row;
  };
  const updateCollection = (input:{collectionId:string;expectedTitle:string;expectedColor:string;title:string;color:string}):CalendarCollection => inTx(db,()=>{
    const row=currentCollection(input.collectionId,input.expectedTitle);
    if(row.color!==input.expectedColor) return runtimeError('REVISION_CONFLICT','分类颜色已变化，请重新打开后操作');
    const title=input.title.trim();
    if(!title||title.length>80||!CALENDAR_COLORS.includes(input.color as typeof CALENDAR_COLORS[number])) return runtimeError('CONTRACT_INVALID','分类名称须为 1—80 字，颜色须从提供的色板中选择');
    if(row.title!==title||row.color!==input.color) db.prepare('UPDATE calendar_collections SET title=?,color=? WHERE id=?').run(title,input.color,input.collectionId);
    return listCollections().find(c=>c.id===input.collectionId)!;
  });
  const deleteCollection = (input:{collectionId:string;expectedTitle:string}) => inTx(db,()=>{
    const row=currentCollection(input.collectionId,input.expectedTitle), reason=deleteReason(row);
    if(reason) return runtimeError('REFERENCE_CONFLICT',reason);
    // 只移除分类归属，待办仍走公共业务入口，保留完成、计划、来源与去重关联。
    const todos=db.prepare('SELECT id FROM todos WHERE collection_id=?').all(input.collectionId);
    deps.managedWrite(()=>{for(const todo of todos) deps.todos().update(Number(todo.id),{collection_id:'builtin.todo'});});
    const events=db.prepare('SELECT id FROM calendar_events WHERE collection_id=?').all(input.collectionId);
    if(events.length){
      deps.guard('update_calendar_event');
      db.prepare('UPDATE calendar_events SET collection_id=?,updated_at=? WHERE collection_id=?').run('builtin.local',new Date().toISOString(),input.collectionId);
    }
    db.prepare('DELETE FROM calendar_collection_preferences WHERE collection_id=?').run(input.collectionId);
    db.prepare('DELETE FROM calendar_collections WHERE id=?').run(input.collectionId);
    return {collectionId:input.collectionId,movedTodos:todos.length,movedEvents:events.length};
  });
  const setVisibility = (input: { collectionId: string; visible: boolean }) => inTx(db, () => {
    if (typeof input.visible !== 'boolean' || !db.prepare('SELECT 1 FROM calendar_collections WHERE id=?').get(input.collectionId)) runtimeError('CONTRACT_INVALID', '分类或显示设置不合法');
    const current = db.prepare('SELECT visible FROM calendar_collection_preferences WHERE collection_id=?').get(input.collectionId);
    if (current && Boolean(current.visible) === input.visible) return;
    db.prepare('INSERT INTO calendar_collection_preferences VALUES(?,?,?) ON CONFLICT(collection_id) DO UPDATE SET visible=excluded.visible,updated_at=excluded.updated_at').run(input.collectionId, input.visible ? 1 : 0, new Date().toISOString());
  });
  return { getRevision, getDisplayTimezone, setDisplayTimezone, listCollections, setVisibility, updateCollection, deleteCollection };
}
export type RuntimeService = ReturnType<typeof createRuntimeService>;
