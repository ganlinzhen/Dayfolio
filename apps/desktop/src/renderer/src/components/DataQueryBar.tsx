import ActionButton from './ActionButton';
import { IconPlus, IconRefresh, IconSearch, IconX } from './icons';
import { useEffect, useState } from 'react';
import { api, call } from '../api';
import type { QueryService } from '../../../../../../packages/core/src/ontology/query';
import type { ObjectTypeDef } from './data-shared';

export interface QueryViewOptions {
  where?: unknown;
  orderBy?: Array<Record<string, string>>;
  groupBy?: string[];
  metrics?: Array<{ op: string; property?: string; as: string }>;
}
interface Filter { property: string; op: string; value: string; }
type Contract = ReturnType<QueryService['describe']>;
const OP_LABEL: Record<string, string> = { eq: '等于', ne: '不等于', in: '属于列表', gt: '大于', gte: '大于等于', lt: '小于', lte: '小于等于', is_null: '为空', not_null: '不为空', contains: '包含文本' };

export default function DataQueryBar({ def, onApply }: { def: ObjectTypeDef; onApply: (options: QueryViewOptions) => void }) {
  const [contract, setContract] = useState<Contract | null>(null);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [join, setJoin] = useState('and');
  const [sort, setSort] = useState('');
  const [direction, setDirection] = useState('asc');
  const [mode, setMode] = useState('rows');
  const [groups, setGroups] = useState(['', '']);
  const [metric, setMetric] = useState('count');
  const [metricProperty, setMetricProperty] = useState('');
  const [relation, setRelation] = useState('');
  const [exists, setExists] = useState('true');
  const [error, setError] = useState('');
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    let active = true;
    void call<Contract>(() => api.data.queryContract({ apiName: def.apiName })).then(value => { if (active) setContract(value); }).catch(e => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [def.apiName]);

  const updateFilter = (index: number, patch: Partial<Filter>) => setFilters(rows => rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  const properties = contract?.properties ?? [];
  const relatedOptions = contract?.relations.filter(link => link.filterable).flatMap(link => [
    ...(link.leftType === def.apiName ? [{ value: `${link.apiName}:left`, title: `${link.apiName} → ${link.rightType}` }] : []),
    ...(link.rightType === def.apiName ? [{ value: `${link.apiName}:right`, title: `${link.apiName} ← ${link.leftType}` }] : []),
  ]) ?? [];

  const apply = () => {
    try {
      const conditions: unknown[] = filters.map(filter => {
        const p = properties.find(p => p.apiName === filter.property);
        if (!p || !p.operators.includes(filter.op)) throw new Error('请选择有效的筛选字段与比较方式');
        if (filter.op === 'is_null' || filter.op === 'not_null') return { property: filter.property, op: filter.op };
        const convert = (value: string): unknown => {
          if (p.dataType === 'boolean') {
            if (value !== 'true' && value !== 'false') throw new Error('布尔值请选择“是”或“否”');
            return value === 'true';
          }
          if (p.dataType === 'integer' || p.dataType === 'float') {
            if (!value.trim() || !Number.isFinite(Number(value))) throw new Error('请输入有效数字');
            return Number(value);
          }
          return value;
        };
        const value = filter.op === 'in' ? (filter.value.trim() ? filter.value.split(/[,，]/).map(value => convert(value.trim())) : []) : convert(filter.value);
        return { property: filter.property, op: filter.op, value };
      });
      let where: unknown = conditions.length ? { [join]: conditions } : undefined;
      if (relation) {
        const [linkType, side] = relation.split(':');
        const related = { related: { linkType, side, exists: exists === 'true' } };
        where = where === undefined ? related : { and: [where, related] };
      }
      const options: QueryViewOptions = { where };
      if (mode === 'aggregate') {
        const groupBy = groups.filter(Boolean);
        if (new Set(groupBy).size !== groupBy.length) throw new Error('两个分组字段不能相同');
        if (metric !== 'count' && !metricProperty) throw new Error('请选择统计字段');
        options.groupBy = groupBy;
        options.metrics = [{ op: metric, ...(metricProperty ? { property: metricProperty } : {}), as: metric === 'count' ? 'count' : 'value' }];
      } else if (sort) options.orderBy = [{ property: sort, direction, nulls: 'last' }];
      setError(''); setApplied(true); onApply(options);
    } catch (e) { setError((e as Error).message); }
  };

  return <details className="data-query-controls">
    <summary>筛选、排序与分组{applied ? ' · 已应用' : ''}</summary>
    <form className="data-query-form" onSubmit={event => { event.preventDefault(); apply(); }}>
      {filters.length > 0 && <label className="data-query-field">匹配方式<select className="form-select" value={join} onChange={e => setJoin(e.target.value)}><option value="and">同时满足</option><option value="or">满足任一</option></select></label>}
      {filters.map((filter, index) => {
        const p = properties.find(p => p.apiName === filter.property);
        return <div className="data-query-row" key={index}>
          <select className="form-select" aria-label={`筛选字段 ${index + 1}`} value={filter.property} onChange={e => updateFilter(index, { property: e.target.value, op: 'is_null', value: '' })}><option value="">选择字段</option>{properties.map(p => <option key={p.apiName} value={p.apiName}>{p.apiName}</option>)}</select>
          <select className="form-select" aria-label={`比较方式 ${index + 1}`} value={filter.op} onChange={e => updateFilter(index, { op: e.target.value, value: '' })}>{(p?.operators ?? ['is_null']).map(op => <option key={op} value={op}>{OP_LABEL[op] ?? op}</option>)}</select>
          {!['is_null', 'not_null'].includes(filter.op) && (p?.dataType === 'boolean' && filter.op !== 'in'
            ? <select className="form-select" aria-label={`筛选值 ${index + 1}`} value={filter.value} onChange={e => updateFilter(index, { value: e.target.value })}><option value="">选择值</option><option value="true">是</option><option value="false">否</option></select>
            : <input className="form-input" aria-label={`筛选值 ${index + 1}`} value={filter.value} placeholder={filter.op === 'in' ? '多个值用逗号分隔' : p?.dataType === 'date' ? p.dateSemantics === 'date' ? 'YYYY-MM-DD' : 'ISO 时间戳' : '输入值'} onChange={e => updateFilter(index, { value: e.target.value })}/>)}
          <ActionButton icon={IconX} type="button" className="btn slim ghost" aria-label={`移除条件 ${index + 1}`} onClick={() => setFilters(rows => rows.filter((_, i) => i !== index))}>移除</ActionButton>
        </div>;
      })}
      <div className="data-query-row"><ActionButton icon={IconPlus} type="button" className="btn slim" disabled={!contract || filters.length >= 20} onClick={() => setFilters(rows => [...rows, { property: '', op: 'is_null', value: '' }])}>添加条件</ActionButton>
        <label className="data-query-field">关联<select className="form-select" aria-label="关系筛选" value={relation} onChange={e => setRelation(e.target.value)}><option value="">不限制</option>{relatedOptions.map(option => <option key={option.value} value={option.value}>{option.title}</option>)}</select></label>
        {relation && <select className="form-select" aria-label="关联存在性" value={exists} onChange={e => setExists(e.target.value)}><option value="true">有匹配对象</option><option value="false">无匹配对象</option></select>}
      </div>
      <div className="data-query-row"><label className="data-query-field">显示<select className="form-select" aria-label="查询显示方式" value={mode} onChange={e => setMode(e.target.value)}><option value="rows">对象列表</option><option value="aggregate">分组统计</option></select></label>
        {mode === 'rows' ? <>
          <label className="data-query-field">排序<select className="form-select" aria-label="排序字段" value={sort} onChange={e => setSort(e.target.value)}><option value="">主键倒序</option>{properties.filter(p => p.sortable).map(p => <option key={p.apiName} value={p.apiName}>{p.apiName}</option>)}</select></label>
          {sort && <select className="form-select" aria-label="排序方向" value={direction} onChange={e => setDirection(e.target.value)}><option value="asc">升序</option><option value="desc">降序</option></select>}
        </> : <>
          {groups.map((group, index) => <label className="data-query-field" key={index}>分组 {index + 1}<select className="form-select" aria-label={`分组字段 ${index + 1}`} value={group} onChange={e => setGroups(rows => rows.map((value, i) => i === index ? e.target.value : value))}><option value="">{index === 0 ? '整体统计' : '不使用'}</option>{properties.filter(p => p.groupable).map(p => <option key={p.apiName} value={p.apiName}>{p.apiName}</option>)}</select></label>)}
          <label className="data-query-field">指标<select className="form-select" aria-label="统计方式" value={metric} onChange={e => { setMetric(e.target.value); setMetricProperty(''); }}><option value="count">数量</option><option value="sum">合计</option><option value="avg">平均</option><option value="min">最小</option><option value="max">最大</option></select></label>
          <select className="form-select" aria-label="统计字段" value={metricProperty} onChange={e => setMetricProperty(e.target.value)}><option value="">{metric === 'count' ? '对象数量' : '选择字段'}</option>{properties.filter(p => p.aggregations.includes(metric)).map(p => <option key={p.apiName} value={p.apiName}>{p.apiName}</option>)}</select>
        </>}
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="data-query-row"><ActionButton icon={IconSearch} className="btn primary slim" disabled={!contract}>应用查询</ActionButton><ActionButton icon={IconRefresh} type="button" className="btn slim ghost" onClick={() => { setFilters([]); setSort(''); setMode('rows'); setGroups(['', '']); setMetric('count'); setMetricProperty(''); setRelation(''); setError(''); setApplied(false); onApply({}); }}>重置查询</ActionButton></div>
    </form>
  </details>;
}
