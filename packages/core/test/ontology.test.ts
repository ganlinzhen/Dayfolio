// 本体层单测：bootstrap 同步/双向校验、动态建类型、链接管理、动作 DSL 执行、仓储 CRUD
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkCore, type TestCtx } from './helpers';
import { openNodeSqliteDb } from '../src/adapters/node-sqlite';
import { createCore, initDb, runMigrations, inTx } from '../src/index';

let ctx: TestCtx | null = null;
const core = () => {
  ctx = mkCore();
  return ctx.core;
};

afterEach(() => ctx?.cleanup());

describe('bootstrap 与校验', () => {
  it('内置业务对象、关系与共用命令同步进元数据表', () => {
    const c = core();
    const objects = c.ontology.listObjectTypes();
    expect(objects.map((o) => o.apiName)).toEqual(
      expect.arrayContaining(['todo', 'study_plan', 'plan_item', 'checkin', 'news_item', 'tool', 'tool_category', 'day']),
    );
    expect(objects).toHaveLength(37);
    expect(objects.map(o=>o.apiName)).toEqual(expect.arrayContaining(['tool_follow_source','tool_follow_rule']));
    expect(objects.find(o => o.apiName === 'action_execution')?.writeMode).toBe('read_only');
    expect(objects.filter((o) => o.isVirtual)).toHaveLength(1);
    expect(c.ontology.listLinkTypes()).toHaveLength(35);
    const actions = c.ontology.listActionTypes();
    expect(actions.filter((a) => a.isBuiltin).length).toBeGreaterThan(50);
  });

  it('启动校验：定义与物理表结构一致时不抛错；漂移时抛错', () => {
    const c = core();
    expect(() => c.ontology.validateAgainstSchema()).not.toThrow();
    // 构造漂移：直接删掉一行 todo 定义，再次校验必须报错
    inTx(c.db, () => {
      const def = c.ontology.getObjectType('todo');
      const props = def.properties.filter((p) => p.apiName !== 'notes');
      c.db.prepare('UPDATE ont_object_types SET properties = ? WHERE api_name = ?').run(JSON.stringify(props), 'todo');
    });
    expect(() => c.ontology.validateAgainstSchema()).toThrow(/notes/);
  });

  it('user_version 迁移幂等：重复启动不重放、版本号递增', () => {
    const c = core();
    const v = (c.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    expect(v).toBeGreaterThanOrEqual(1);
    expect(runMigrations(c.db)).toBe(v); // 再跑无新增
    expect((c.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(v);
  });

  it('老库（无元数据表）直接 createCore 可无损升级', () => {
    ctx = null; // 本用例自管库文件，避免 afterEach 重复清理上一个用例
    // 造一个只有旧 7 表的库（模拟线上旧版本数据）
    const dir = mkdtempSync(join(tmpdir(), 'tododesk-legacy-'));
    const path = join(dir, 'legacy.db');
    const db = openNodeSqliteDb(path);
    initDb(db);
    db.prepare('INSERT INTO todos (title, notes, priority, status, tags, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run(
      '旧数据', '', 'medium', 'open', '[]', 'app', '2026-01-01', '2026-01-01',
    );
    db.close();
    // 用新版本 createCore 打开同一文件：迁移 + bootstrap 同步 + 校验全部通过
    const db2 = openNodeSqliteDb(path);
    // dbPath 必传：老库升级路径同样不得让资产根回退到真实应用数据目录
    const c2 = createCore(db2, { dbPath: path });
    expect(c2.ontology.listObjectTypes()).toHaveLength(37);
    expect(c2.todos.list()).toHaveLength(1);
    db2.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('自定义对象类型', () => {
  it('搜索实例时，可空文本或日期字段不会遮蔽其他字段的匹配', () => {
    const c = core();
    const todo = c.todos.add({ title: '阅读搜索验收' });
    expect(todo.due_date).toBeNull();
    expect(c.objects.list('todo', { search: '搜索验收' }).rows.map((row) => row.id)).toEqual([todo.id]);
    c.ontology.createObjectType({
      apiName: 'search_note', title: '搜索笔记',
      properties: [{ apiName: 'title', dataType: 'string' }, { apiName: 'notes', dataType: 'string' }],
    });
    const row = c.objects.insert('search_note', { title: '可空字段验收', notes: null });
    expect(c.objects.list('search_note', { search: '可空字段' }).rows.map((r) => r.id)).toEqual([row.id]);
    expect(c.objects.list('search_note', { search: '不存在' }).total).toBe(0);
  });

  it('建类型→动态建表→仓储写入→按属性查询', () => {
    const c = core();
    c.ontology.createObjectType({
      apiName: 'book',
      title: '书',
      properties: [
        { apiName: 'title', dataType: 'string', nullable: false },
        { apiName: 'rating', dataType: 'float' },
        { apiName: 'read', dataType: 'boolean' },
      ],
    });
    const def = c.ontology.getObjectType('book');
    expect(def.tableName).toBe('ont_obj_book');
    expect(def.properties.map((p) => p.apiName)).toEqual(['id', 'created_at', 'updated_at', 'title', 'rating', 'read']);

    const row = c.objects.insert('book', { title: '三体', rating: 9.4, read: true });
    expect(row.id).toBeTruthy();
    expect(row.read).toBe(true);
    expect(c.objects.count('book')).toBe(1);

    const hit = c.objects.list('book', { search: '三体' });
    expect(hit.total).toBe(1);
    const byWhere = c.objects.list('book', { where: [{ property: 'rating', op: 'gte', value: 9 }] });
    expect(byWhere.total).toBe(1);

    c.objects.update('book', row.id, { rating: 9.9 });
    expect(c.objects.get('book', row.id)!.rating).toBe(9.9);
    c.objects.remove('book', row.id);
    expect(c.objects.count('book')).toBe(0);
  });

  it('非法 apiName / 重复类型 / 枚举缺取值被拒绝', () => {
    const c = core();
    expect(() => c.ontology.createObjectType({ apiName: 'Bad-Name', title: 'x', properties: [] })).toThrow();
    expect(() => c.ontology.createObjectType({ apiName: 'todo', title: 'x', properties: [] })).toThrow('已存在');
    expect(() =>
      c.ontology.createObjectType({ apiName: 'tag', title: '标签', properties: [{ apiName: 'level', dataType: 'enum' }] }),
    ).toThrow('枚举');
  });

  it('系统类型：可加 nullable 属性并真实落列；内置属性不可删；类型不可删', () => {
    const c = core();
    c.ontology.updateObjectType('todo', { addProperties: [{ apiName: 'energy', dataType: 'integer', enumValues: undefined, nullable: true }] });
    const def = c.ontology.getObjectType('todo');
    const added = def.properties.find((p) => p.apiName === 'energy')!;
    expect(added.origin).toBe('user');
    // 旧服务写入不受影响，新列可写
    const t = c.todos.add({ title: 'x' });
    c.db.prepare('UPDATE todos SET energy = 3 WHERE id = ?').run(t.id);
    expect(() => c.ontology.updateObjectType('todo', { dropProperty: 'title' })).toThrow('受保护');
    expect(() => c.ontology.deleteObjectType('todo')).toThrow('系统类型');
  });

  it('自定义类型：可删 user 属性（列被真实删除）、被链接引用时拒绝删', () => {
    const c = core();
    c.ontology.createObjectType({ apiName: 'note', title: '笔记', properties: [{ apiName: 'content', dataType: 'string' }] });
    c.ontology.createObjectType({ apiName: 'folder', title: '文件夹', properties: [{ apiName: 'name', dataType: 'string' }] });
    c.ontology.updateObjectType('note', { addProperties: [{ apiName: 'folder_id', dataType: 'string' }] });
    c.ontology.createLinkType({ apiName: 'folder__note', title: '文件夹的笔记', leftType: 'folder', rightType: 'note', cardinality: 'one_to_many', fkColumn: 'folder_id' });
    // folder_id 被链接占用 → 拒删
    expect(() => c.ontology.updateObjectType('note', { dropProperty: 'folder_id' })).toThrow('链接');
    c.ontology.deleteLinkType('folder__note');
    c.ontology.updateObjectType('note', { dropProperty: 'folder_id' });
    const cols = c.db.prepare('PRAGMA table_info("ont_obj_note")').all().map((x) => String(x.name));
    expect(cols).not.toContain('folder_id');
    // 删类型：先清引用
    c.ontology.deleteObjectType('note');
    expect(c.ontology.findObjectType('note')).toBeNull();
  });

  it('链接校验：外键类型不匹配 / 外键属性不存在被拒绝', () => {
    const c = core();
    expect(() =>
      c.ontology.createLinkType({ apiName: 'todo__tool', title: 'x', leftType: 'todo', rightType: 'tool', cardinality: 'one_to_many', fkColumn: 'title' }),
    ).toThrow('类型须与左侧主键一致');
    expect(() =>
      c.ontology.createLinkType({ apiName: 'todo__tool2', title: 'x', leftType: 'todo', rightType: 'tool', cardinality: 'one_to_many', fkColumn: 'nope' }),
    ).toThrow('不在');
  });
});

describe('多对多链接与动作 DSL', () => {
  const setup = (c: ReturnType<typeof mkCore>['core']) => {
    c.ontology.createObjectType({ apiName: 'student', title: '学生', properties: [{ apiName: 'name', dataType: 'string', nullable: false }] });
    c.ontology.createObjectType({ apiName: 'custom_course', title: '课程', properties: [{ apiName: 'name', dataType: 'string', nullable: false }] });
    c.ontology.createObjectType({
      apiName: 'enrollment',
      title: '选课',
      properties: [
        { apiName: 'student_id', dataType: 'string' },
        { apiName: 'course_id', dataType: 'string' },
      ],
    });
    c.ontology.createLinkType({
      apiName: 'student__course',
      title: '学生的课程',
      leftType: 'student',
      rightType: 'custom_course',
      cardinality: 'many_to_many',
      linkTable: 'enrollment',
      backingLeftProperty: 'student_id',
      backingRightProperty: 'course_id',
    });
  };

  it('N:N 链接：create_link 落中间表、delete_link 清理', () => {
    const c = core();
    setup(c);
    const s = c.objects.insert('student', { name: '小明' });
    const c1 = c.objects.insert('custom_course', { name: '数学' });
    const c2 = c.objects.insert('custom_course', { name: '物理' });
    c.ontology.createActionType({
      apiName: 'enroll',
      title: '选课',
      parameters: [
        { name: 'student_id', dataType: 'string', required: true },
        { name: 'course_id', dataType: 'string', required: true },
      ],
      operations: [{ kind: 'create_link', linkType: 'student__course', leftId: { source: { parameter: 'student_id' } }, rightId: { source: { parameter: 'course_id' } } }],
    });
    const ex1 = c.actions.execute('enroll', { student_id: s.id, course_id: c1.id });
    const ex2 = c.actions.execute('enroll', { student_id: s.id, course_id: c2.id });
    expect(ex1.results[0].objectId).toBeTruthy();
    expect(c.objects.count('enrollment')).toBe(2);
    // 入链解析：学生的详情能看到两门课
    const links = c.objects.resolveLinks('student', s);
    expect(links.filter((l) => l.direction === 'in' && l.linkApiName === 'student__course').map((l) => l.targetTitle).sort()).toEqual(['数学', '物理']);
    // 解除一门
    c.ontology.createActionType({
      apiName: 'drop_course',
      title: '退课',
      parameters: [
        { name: 'student_id', dataType: 'string', required: true },
        { name: 'course_id', dataType: 'string', required: true },
      ],
      operations: [{ kind: 'delete_link', linkType: 'student__course', leftId: { source: { parameter: 'student_id' } }, rightId: { source: { parameter: 'course_id' } } }],
    });
    c.actions.execute('drop_course', { student_id: s.id, course_id: c1.id });
    expect(c.objects.count('enrollment')).toBe(1);
    void ex2;
  });

  it('create/modify/delete object 动作 + 参数校验 + 事务原子性', () => {
    const c = core();
    setup(c);
    c.ontology.createActionType({
      apiName: 'add_student',
      title: '新增学生',
      parameters: [
        { name: 'name', dataType: 'string', required: true },
        { name: 'bio', dataType: 'string' },
      ],
      operations: [{ kind: 'create_object', objectType: 'student', propertyMappings: { name: { source: { parameter: 'name' } }, created_at: { fn: 'now' } } }],
    });
    const ex = c.actions.execute('add_student', { name: '小红' });
    const sid = ex.results[0].objectId as string;
    expect(c.objects.get('student', sid)!.name).toBe('小红');

    // 缺必填参数
    expect(() => c.actions.execute('add_student', {})).toThrow('name');
    // 引用未声明参数的动作定义被注册表拒绝
    expect(() =>
      c.ontology.createActionType({
        apiName: 'bad',
        title: '坏动作',
        parameters: [{ name: 'a', dataType: 'string' }],
        operations: [{ kind: 'create_object', objectType: 'student', propertyMappings: { name: { source: { parameter: 'b' } } } }],
      }),
    ).toThrow('未声明的参数');

    // 事务原子性：第二个操作在运行期失败（缺必填值），第一个的写入一起回滚
    c.ontology.createActionType({
      apiName: 'two_steps',
      title: '两步',
      parameters: [{ name: 'name', dataType: 'string', required: true }],
      operations: [
        { kind: 'create_object', objectType: 'student', propertyMappings: { name: { source: { parameter: 'name' } } } },
        { kind: 'create_object', objectType: 'student', propertyMappings: { created_at: { fn: 'now' } } },
      ],
    });
    const before = c.objects.count('student');
    expect(() => c.actions.execute('two_steps', { name: 'ZZ' })).toThrow();
    expect(c.objects.count('student')).toBe(before);
  });
});

describe('内置动作与既有行为回归', () => {
  it('invoke complete_todo 走核心服务：完成 + 联动打卡', () => {
    const c = core();
    const added = c.actions.execute('add_todo', { title: '读完一章' });
    const id = (added.result as { id: number }).id;
    c.actions.execute('complete_todo', { id });
    expect(c.todos.get(id).status).toBe('done');
    expect(c.checkins.stats().active_days_last_7).toBeGreaterThanOrEqual(1);
  });

  it('停用的动作不可执行；内置动作不可删但可停用', () => {
    const c = core();
    c.ontology.updateActionType('add_todo', { status: 'disabled' });
    expect(() => c.actions.execute('add_todo', { title: 'x' })).toThrow('停用');
    expect(() => c.ontology.deleteActionType('add_todo')).toThrow('不可删除');
    c.ontology.updateActionType('add_todo', { status: 'active' });
    expect(c.actions.execute('add_todo', { title: 'y' }).builtin).toBe(true);
  });

  it('bootstrap 同步不会覆盖用户加的属性与停用状态', () => {
    const c = core();
    c.ontology.updateObjectType('todo', { addProperties: [{ apiName: 'mood', dataType: 'string' }] });
    c.ontology.updateActionType('checkin', { status: 'disabled' });
    // 重新 createCore 同一库：user 属性保留、status 保留（dbPath 必传，资产根不回退真实目录）
    const db2 = openNodeSqliteDb(ctx!.dbPath);
    const c2 = createCore(db2, { dbPath: ctx!.dbPath });
    expect(c2.ontology.getObjectType('todo').properties.some((p) => p.apiName === 'mood')).toBe(true);
    expect(c2.ontology.getActionType('checkin').status).toBe('disabled');
    db2.close();
  });
});
