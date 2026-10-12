// 本体层类型契约：对齐常见本体服务的 ObjectType / LinkType / ActionType 三类元数据。
// 约定：apiName 一律 snake_case，且与物理列同名（系统类型的 apiName 与既有实体字段一致，
// 避免引入一层映射；自定义类型建表时列名 = apiName）。

/** 属性数据类型（SQLite 落地：string/date/enum/json→TEXT，integer/boolean→INTEGER，float→REAL） */
export type OntoDataType = 'string' | 'integer' | 'float' | 'boolean' | 'date' | 'json' | 'enum';

export interface PropertyDef {
  apiName: string;
  dataType: OntoDataType;
  nullable: boolean;
  /** dataType='enum' 时的取值清单 */
  enumValues?: string[];
  /** 是否建了索引（数据面板提示用） */
  indexed?: boolean;
  isPrimaryKey?: boolean;
  /** builtin=随代码/建表自带（系统类型里不可删改）；user=管理界面后加的，可删 */
  origin: 'builtin' | 'user';
  description?: string;
}

export interface ObjectTypeDef {
  apiName: string;
  title: string;
  description: string;
  /** 物理表名；虚拟类型（如 day）为 null */
  tableName: string | null;
  isVirtual: boolean;
  /** 系统类型：随代码 bootstrap 同步，管理界面只能加属性 */
  isSystem: boolean;
  primaryKey: string;
  /** 列表页主显属性 */
  titleProperty: string;
  properties: PropertyDef[];
  status: 'active' | 'disabled';
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewPropertyInput {
  apiName: string;
  dataType: OntoDataType;
  nullable?: boolean;
  enumValues?: string[];
  indexed?: boolean;
  description?: string;
}

export interface CreateObjectTypeInput {
  apiName: string;
  title: string;
  description?: string;
  titleProperty?: string;
  properties: NewPropertyInput[];
}

export interface UpdateObjectTypeInput {
  title?: string;
  description?: string;
  titleProperty?: string;
  /** 系统类型也允许追加 nullable 属性（ALTER TABLE ADD COLUMN） */
  addProperties?: NewPropertyInput[];
  /** 只允许删 origin='user' 的属性 */
  dropProperty?: string;
}

export type LinkCardinality = 'one_to_one' | 'one_to_many' | 'many_to_many';

export interface LinkTypeDef {
  apiName: string;
  title: string;
  /** 「一」侧（one_to_many 时外键/判别列挂在 right 侧表上） */
  leftType: string;
  rightType: string;
  cardinality: LinkCardinality;
  /** 左/右对象上的反向属性名（leftObjectLinkName/rightObjectLinkName） */
  leftLinkName: string | null;
  rightLinkName: string | null;
  /** 落地形态一：外键列（1:1 / 1:N），挂在 right 侧表 */
  fkColumn?: string;
  onDelete?: 'cascade' | 'set_null' | 'none';
  /** 落地形态二：多态判别列 + 引用列（right 侧表）；仅系统链接使用 */
  discriminatorColumn?: string;
  discriminatorValue?: string;
  /** 多态链接的引用列（存左侧对象主键值，如 checkins.ref_id） */
  refColumn?: string;
  /** 落地形态三：中间表（N:N）= backing 对象类型 + 两个引用属性（backing object 模型） */
  linkTable?: string;
  backingLeftProperty?: string;
  backingRightProperty?: string;
  isSystem: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface CreateLinkTypeInput {
  apiName: string;
  title: string;
  leftType: string;
  rightType: string;
  cardinality: LinkCardinality;
  leftLinkName?: string;
  rightLinkName?: string;
  /** 1:1/1:N 必填：right 侧表上的外键属性 apiName，类型须与 left 主键一致 */
  fkColumn?: string;
  /** N:N 必填：中间表对象类型 apiName 及其左右引用属性 */
  linkTable?: string;
  backingLeftProperty?: string;
  backingRightProperty?: string;
}

export type ParamDataType = 'string' | 'integer' | 'float' | 'boolean' | 'date' | 'json';

export interface ActionParamDef {
  name: string;
  dataType: ParamDataType;
  required: boolean;
  defaultValue?: unknown;
  description?: string;
}

export interface ActionParamInput extends Partial<ActionParamDef> {
  name: string;
}

/** 值来源三选一（参数引用 / 字面量 / 内建函数） */
export type ValueMapping =
  | { source: { parameter: string } }
  | { literal: unknown }
  | { fn: 'now' | 'uuid' };

export interface SelectorDef {
  property: string;
  value: ValueMapping;
}

export type ActionOperation =
  | { kind: 'create_object'; objectType: string; propertyMappings: Record<string, ValueMapping> }
  | { kind: 'modify_object'; objectType: string; selector: SelectorDef; propertyMappings: Record<string, ValueMapping> }
  | { kind: 'delete_object'; objectType: string; selector: SelectorDef }
  | { kind: 'create_link'; linkType: string; leftId: ValueMapping; rightId: ValueMapping }
  | { kind: 'delete_link'; linkType: string; leftId: ValueMapping; rightId: ValueMapping };

export type ActionOperationInput = ActionOperation;

export interface ActionTypeDef {
  apiName: string;
  title: string;
  description: string;
  /** builtin 动作绑定核心服务方法（operations 为空）；否则走声明式 DSL 执行器 */
  isBuiltin: boolean;
  status: 'active' | 'disabled';
  parameters: ActionParamDef[];
  operations: ActionOperation[];
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateActionTypeInput {
  apiName: string;
  title: string;
  description?: string;
  parameters: ActionParamInput[];
  operations: ActionOperationInput[];
}

export interface UpdateActionTypeInput {
  title?: string;
  description?: string;
  status?: 'active' | 'disabled';
}
