// 数据面板共享类型与工具（对象/链接/动作三类元数据的渲染层镜像）
export interface PropertyDef {
  apiName: string;
  dataType: 'string' | 'integer' | 'float' | 'boolean' | 'date' | 'json' | 'enum';
  nullable: boolean;
  enumValues?: string[];
  indexed?: boolean;
  isPrimaryKey?: boolean;
  origin: 'builtin' | 'user';
  description?: string;
  readable?: boolean;
}

export interface ObjectTypeDef {
  apiName: string;
  title: string;
  description: string;
  tableName: string | null;
  isVirtual: boolean;
  isSystem: boolean;
  primaryKey: string;
  titleProperty: string;
  properties: PropertyDef[];
  status: string;
  sortOrder: number;
  writeMode?: string;
  extensionWritable?: boolean;
  visibility?: string;
}

export interface LinkTypeDef {
  apiName: string;
  title: string;
  leftType: string;
  rightType: string;
  cardinality: 'one_to_one' | 'one_to_many' | 'many_to_many';
  leftLinkName: string | null;
  rightLinkName: string | null;
  fkColumn?: string;
  onDelete?: string;
  discriminatorColumn?: string;
  discriminatorValue?: string;
  refColumn?: string;
  linkTable?: string;
  backingLeftProperty?: string;
  backingRightProperty?: string;
  isSystem: boolean;
}

export interface ActionParamDef {
  jsonSchema?: unknown;
  objectType?: string;
  name: string;
  dataType: 'string' | 'integer' | 'float' | 'boolean' | 'date' | 'json';
  required: boolean;
  defaultValue?: unknown;
  description?: string;
}

export type ValueMapping =
  | { source: { parameter: string } }
  | { literal: unknown }
  | { fn: 'now' | 'uuid' }
  | { result: { step: number; path: string[] } };

export interface ActionOperation {
  kind: 'create_object' | 'modify_object' | 'delete_object' | 'create_link' | 'delete_link' | 'invoke_command';
  command?: string;
  params?: Record<string, ValueMapping>;
  objectType?: string;
  linkType?: string;
  selector?: { property: string; value: ValueMapping };
  propertyMappings?: Record<string, ValueMapping>;
  leftId?: ValueMapping;
  rightId?: ValueMapping;
}

export interface ActionTypeDef {
  composable?: boolean;
  template?: { targetKind: 'object' | 'link'; targetName: string; operation: 'create' | 'update' | 'delete' | 'extensions'; version: number; schemaDigest: string };
  targetBindings?: Array<{objectType:string;parameter?:string}>;
  allowedChannels?: string[];
  needsReview?: boolean;
  apiName: string;
  title: string;
  description: string;
  isBuiltin: boolean;
  status: 'active' | 'disabled';
  parameters: ActionParamDef[];
  operations: ActionOperation[];
}

export interface LinkRef {
  linkApiName: string;
  direction: 'out' | 'in';
  targetType: string;
  targetId: unknown;
  targetTitle: string | null;
  targetExists?: boolean;
}

export function actionsForType(apiName: string, actions: ActionTypeDef[], links: LinkTypeDef[]): ActionTypeDef[] {
  return actions.filter((action) => action.targetBindings?.some(binding => binding.objectType === apiName) || (action.isBuiltin
    ? action.targetBindings?.some(binding=>binding.objectType===apiName)
    : action.operations.some((op) => {
      if (op.objectType === apiName) return true;
      const link = links.find((l) => l.apiName === op.linkType);
      return link && (link.leftType === apiName || link.rightType === apiName || link.linkTable === apiName);
    })));
}

export const CARDINALITY_LABEL: Record<string, string> = {
  one_to_one: '一对一',
  one_to_many: '一对多',
  many_to_many: '多对多',
};

export const OP_LABEL: Record<string, string> = {
  create_object: '创建对象',
  modify_object: '修改对象',
  delete_object: '删除对象',
  create_link: '建立链接',
  delete_link: '解除链接',
  invoke_command: '调用业务命令',
};

export const DATA_TYPE_LABEL: Record<string, string> = {
  string: '文本',
  integer: '整数',
  float: '小数',
  boolean: '布尔',
  date: '日期',
  json: 'JSON',
  enum: '枚举',
};

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'object') {
    const json = JSON.stringify(v);
    return json.length > 42 ? `${json.slice(0, 42)}…` : json;
  }
  const s = String(v);
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      return JSON.stringify(JSON.parse(s));
    } catch {
      return s;
    }
  }
  return s.length > 42 ? `${s.slice(0, 42)}…` : s;
}
