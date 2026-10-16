import type { ActionParamDef } from './data-shared';

interface FieldSchema { type?: string; enum?: unknown[]; anyOf?: FieldSchema[]; properties?: Record<string, FieldSchema>; required?: string[]; }

/** 基础动作的属性表单：保留“未提供”“显式空值”和有效值的区别。 */
export default function ActionValuesInput({ parameter, value, onChange, current = {} }: {
  parameter: ActionParamDef; value: string; onChange: (value: string) => void; current?: Record<string, unknown>;
}) {
  const schema = parameter.jsonSchema as FieldSchema | undefined;
  if (!schema?.properties) return <input className="form-input" aria-label={parameter.name} value={value} onChange={e => onChange(e.target.value)} placeholder="输入 JSON 对象"/>;
  let values: Record<string, unknown> = {};
  try { values = JSON.parse(value || '{}'); } catch { /* 非法手工输入由服务端拒绝，不覆盖原值 */ }
  const set = (name: string, value: unknown, omit = false) => {
    const next = { ...values };
    if (omit) delete next[name]; else next[name] = value;
    onChange(JSON.stringify(next));
  };
  const fields = Object.entries(schema.properties).filter(([name]) => !['id', 'created_at', 'updated_at'].includes(name));
  return <div className="action-values-fields">
    {fields.map(([name, raw]) => {
      const nullable = raw.anyOf?.some(item => item.type === 'null') ?? false;
      const field = raw.anyOf?.find(item => item.type !== 'null') ?? raw;
      const required = schema.required?.includes(name) ?? false;
      const supplied = Object.hasOwn(values, name);
      const mode = supplied ? values[name] === null ? 'null' : 'value' : required ? 'value' : 'omit';
      const shown = supplied && values[name] !== null ? typeof values[name] === 'object' ? JSON.stringify(values[name]) : String(values[name]) : '';
      return <div className="data-param action-value-field" key={name}>
        <label htmlFor={`action-value-${parameter.name}-${name}`}>{name}{required ? ' *' : ''}</label>
        {!required && <select className="form-select" aria-label={`${name} 输入方式`} value={mode} onChange={e => {
          if (e.target.value === 'omit') set(name, undefined, true);
          else if (e.target.value === 'null') set(name, null);
          else set(name, field.type === 'boolean' ? false : field.type === 'number' ? 0 : '');
        }}><option value="omit">不设置 / 保持原值</option>{nullable && <option value="null">设为空值</option>}<option value="value">填写值</option></select>}
        {mode === 'value' && (field.enum ? <select id={`action-value-${parameter.name}-${name}`} className="form-select" value={shown} onChange={e => set(name, e.target.value)}><option value="">选择值</option>{field.enum.map(v => <option key={String(v)} value={String(v)}>{String(v)}</option>)}</select>
          : field.type === 'boolean' ? <select id={`action-value-${parameter.name}-${name}`} className="form-select" value={shown} onChange={e => set(name, e.target.value === 'true')}><option value="">选择值</option><option value="true">是</option><option value="false">否</option></select>
          : <input id={`action-value-${parameter.name}-${name}`} className="form-input" value={shown} placeholder={current[name] === undefined ? field.type ? '填写属性值' : '填写 JSON 值' : `当前：${String(current[name]).slice(0, 80)}`} onChange={e => {
            const input = e.target.value;
            if (!field.type) { try { set(name, JSON.parse(input)); } catch { set(name, input); } }
            else set(name, field.type === 'number' && input.trim() && Number.isFinite(Number(input)) ? Number(input) : input);
          }}/ >)}
      </div>;
    })}
    {fields.length === 0 && <p className="sub">没有需要填写的属性，主键与时间由系统生成。</p>}
  </div>;
}
