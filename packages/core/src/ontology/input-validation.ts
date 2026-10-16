// 静态业务输入契约的有限校验；不执行用户脚本或任意表达式。
interface Schema { type?:string; const?:unknown; enum?:unknown[]; anyOf?:Schema[]; items?:Schema; properties?:Record<string,Schema>; required?:string[]; additionalProperties?:boolean|Schema; }
/** 自定义动作只接受实际支持的 schema 子集，避免忽略未知校验规则。 */
export function validateActionSchema(value: unknown, depth = 0): void {
  if (depth > 10 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('动作 jsonSchema 须为深度不超过 10 的对象');
  const schema = value as Record<string, unknown>;
  for (const key of Object.keys(schema)) if (!['type', 'const', 'enum', 'anyOf', 'items', 'properties', 'required', 'additionalProperties'].includes(key)) throw new Error(`动作 jsonSchema 不支持 ${key}`);
  if (schema.type !== undefined && !['null', 'string', 'boolean', 'number', 'array', 'object'].includes(String(schema.type))) throw new Error('动作 jsonSchema 类型不支持');
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) throw new Error('enum 须为数组');
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || !schema.anyOf.length || schema.anyOf.length > 20) throw new Error('anyOf 须为有界非空数组');
    schema.anyOf.forEach(item => validateActionSchema(item, depth + 1));
  }
  if (schema.items !== undefined) validateActionSchema(schema.items, depth + 1);
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties) || Object.keys(schema.properties).length > 100) throw new Error('properties 须为有界属性对象');
    Object.values(schema.properties).forEach(item => validateActionSchema(item, depth + 1));
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties ?? {}, key)))) throw new Error('required 只能引用已定义属性');
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') validateActionSchema(schema.additionalProperties, depth + 1);
}
export function validateCommandInput(rawSchema:unknown,value:unknown,path:string):void {
  if(value===undefined)return;
  const schema=rawSchema as Schema;
  if(!schema)return;
  if(schema.anyOf){for(const candidate of schema.anyOf){try{validateCommandInput(candidate,value,path);return;}catch{/* 尝试其他联合类型 */}}throw new Error(`${path} 不符合业务字段结构`);}
  if(Object.hasOwn(schema,'const')&&value!==schema.const)throw new Error(`${path} 必须为 ${String(schema.const)}`);
  if(schema.enum&&!schema.enum.includes(value))throw new Error(`${path.endsWith('.priority')?'无效优先级：':path.endsWith('.kind')?'素材类型不合法：':''}${path} 须为 ${schema.enum.join(' / ')}`);
  if(schema.type==='null'){if(value!==null)throw new Error(`${path} 须为空`);return;}
  if(schema.type==='number'){if(typeof value!=='number'||!Number.isFinite(value))throw new Error(`${path} 须为有限数字`);return;}
  if(schema.type==='string'||schema.type==='boolean'){if(typeof value!==schema.type)throw new Error(`${path} 须为${schema.type==='string'?'文本':'布尔值'}`);return;}
  if(schema.type==='array'){if(!Array.isArray(value))throw new Error(`${path} 须为数组`);value.forEach((v,i)=>validateCommandInput(schema.items,v,`${path}[${i}]`));return;}
  if(schema.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${path} 须为对象`);
    const record=value as Record<string,unknown>;
    for(const key of schema.required??[])if(record[key]===undefined)throw new Error(`${path}.${key} 必填`);
    for(const [key,v] of Object.entries(record)){if(schema.additionalProperties===false&&!Object.hasOwn(schema.properties??{},key))throw new Error(`${path}.${key} 是未知字段`);validateCommandInput(schema.properties?.[key]??(typeof schema.additionalProperties==='object'?schema.additionalProperties:undefined),v,`${path}.${key}`);}
  }
}
