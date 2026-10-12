// 数据面板·三类类型管理：对象类型（建/加属性/删）、链接类型（建/删）、动作类型（建/启停/删/试运行）
import { useMemo, useState } from 'react';
import { api, call } from '../api';
import { toast } from './Toast';
import {
  CARDINALITY_LABEL,
  DATA_TYPE_LABEL,
  OP_LABEL,
  type ActionOperation,
  type ActionParamDef,
  type ActionTypeDef,
  type LinkTypeDef,
  type ObjectTypeDef,
  type ValueMapping,
} from './data-shared';

type Refresh = () => void;

const err = (e: unknown) => toast((e as Error).message);

// ---------- 对象类型管理 ----------

interface PropDraft {
  apiName: string;
  dataType: ActionParamDef['dataType'] | 'enum';
  nullable: boolean;
  enumValues: string;
  indexed: boolean;
}

const emptyProp = (): PropDraft => ({ apiName: '', dataType: 'string', nullable: true, enumValues: '', indexed: false });

export function ObjectTypeManager({ types, links, onChanged }: { types: ObjectTypeDef[]; links: LinkTypeDef[]; onChanged: Refresh }) {
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string>('');
  const [addingTo, setAddingTo] = useState('');
  const [addProp, setAddProp] = useState<PropDraft>(emptyProp());
  const [deleting, setDeleting] = useState<ObjectTypeDef | null>(null);
  const [confirmName, setConfirmName] = useState('');

  const openCreate = () => setCreating(true);

  const doAddProperty = async () => {
    try {
      await call(() =>
        api.data.updateObjectType({
          apiName: addingTo,
          patch: {
            addProperties: [
              {
                apiName: addProp.apiName,
                dataType: addProp.dataType,
                nullable: addProp.nullable,
                indexed: addProp.indexed,
                enumValues: addProp.dataType === 'enum' ? addProp.enumValues.split(/[,，\s]+/).filter(Boolean) : undefined,
              },
            ],
          },
        }),
      );
      toast(`已添加属性 ${addProp.apiName}`);
      setAddingTo('');
      setAddProp(emptyProp());
      onChanged();
    } catch (e) {
      err(e);
    }
  };

  const doDropProperty = async (apiName: string, prop: string) => {
    if (!window.confirm(`删除属性 ${prop}？该列数据将一并删除。`)) return;
    try {
      await call(() => api.data.updateObjectType({ apiName, patch: { dropProperty: prop } }));
      toast(`已删除属性 ${prop}`);
      onChanged();
    } catch (e) {
      err(e);
    }
  };

  const doDelete = async () => {
    if (!deleting) return;
    try {
      await call(() => api.data.deleteObjectType({ apiName: deleting.apiName }));
      toast(`已删除对象类型 ${deleting.title}（含表与数据）`);
      setDeleting(null);
      setConfirmName('');
      onChanged();
    } catch (e) {
      err(e);
    }
  };

  return (
    <div>
      <div className="toolbar">
        <span className="sub">对象类型定义了 App 里有哪些种类的数据（含属性与主键）。系统类型是内置结构，可追加属性；自定义类型完全可管理。</span>
        <div className="spacer" />
        <button className="btn primary slim" onClick={openCreate}>
          新建对象类型
        </button>
      </div>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>apiName</th>
              <th>属性</th>
              <th>来源</th>
              <th>标题属性</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {types.map((t) => (
              <>
                <tr key={t.apiName} onClick={() => setExpanded(expanded === t.apiName ? '' : t.apiName)}>
                  <td className="title-col">
                    {t.title}
                    {t.isVirtual && <span className="tag">虚拟</span>}
                  </td>
                  <td className="mono">{t.apiName}</td>
                  <td>{t.properties.length}</td>
                  <td>
                    <span className="tag">{t.isSystem ? '系统' : '自定义'}</span>
                  </td>
                  <td className="mono">{t.titleProperty}</td>
                  <td>
                    <button
                      className="btn slim ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        setAddingTo(t.apiName);
                        setAddProp(emptyProp());
                      }}
                    >
                      加属性
                    </button>
                    {!t.isSystem && (
                      <button
                        className="btn slim danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleting(t);
                          setConfirmName('');
                        }}
                      >
                        删除
                      </button>
                    )}
                  </td>
                </tr>
                {expanded === t.apiName && (
                  <tr key={`${t.apiName}-props`} className="data-subrow">
                    <td colSpan={6}>
                      <table className="data-table inner">
                        <thead>
                          <tr>
                            <th>属性</th>
                            <th>类型</th>
                            <th>可空</th>
                            <th>枚举值</th>
                            <th>索引</th>
                            <th>来源</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {t.properties.map((p) => (
                            <tr key={p.apiName}>
                              <td className="mono">
                                {p.apiName}
                                {p.apiName === t.primaryKey && <span className="tag">主键</span>}
                              </td>
                              <td>{DATA_TYPE_LABEL[p.dataType] ?? p.dataType}</td>
                              <td>{p.nullable ? '是' : '否'}</td>
                              <td className="sub">{p.enumValues?.join(' / ') ?? '—'}</td>
                              <td>{p.indexed ? '有' : '—'}</td>
                              <td>
                                <span className="tag">{p.origin === 'builtin' ? '内置' : '后加'}</span>
                              </td>
                              <td>
                                {p.origin === 'user' && (
                                  <button className="btn slim danger" onClick={() => void doDropProperty(t.apiName, p.apiName)}>
                                    删列
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>

      {addingTo && (
        <Modal title={`为 ${types.find((t) => t.apiName === addingTo)?.title ?? addingTo} 添加属性`} onClose={() => setAddingTo('')}>
          <PropertyForm draft={addProp} setDraft={setAddProp} />
          <footer className="modal-foot">
            <button className="btn ghost" onClick={() => setAddingTo('')}>
              取消
            </button>
            <button className="btn primary" disabled={!addProp.apiName.trim()} onClick={() => void doAddProperty()}>
              添加
            </button>
          </footer>
        </Modal>
      )}

      {deleting && (
        <Modal title={`删除对象类型「${deleting.title}」`} onClose={() => setDeleting(null)}>
          <p className="notice">
            将删除类型定义、物理表 <span className="mono">{deleting.tableName}</span> 与全部数据，且不可恢复。输入 apiName{' '}
            <span className="mono">{deleting.apiName}</span> 确认：
          </p>
          <input className="form-input" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={deleting.apiName} />
          <footer className="modal-foot">
            <button className="btn ghost" onClick={() => setDeleting(null)}>
              取消
            </button>
            <button className="btn danger" disabled={confirmName !== deleting.apiName} onClick={() => void doDelete()}>
              永久删除
            </button>
          </footer>
        </Modal>
      )}

      {creating && <CreateObjectTypeModal types={types} links={links} onClose={() => setCreating(false)} onDone={onChanged} />}
    </div>
  );
}

function PropertyForm({ draft, setDraft }: { draft: PropDraft; setDraft: (d: PropDraft) => void }) {
  return (
    <div className="form-row">
      <label className="form-label">属性名</label>
      <input
        className="form-input"
        value={draft.apiName}
        placeholder="小写字母/数字/下划线，如 rating"
        onChange={(e) => setDraft({ ...draft, apiName: e.target.value })}
      />
      <label className="form-label">类型</label>
      <select className="form-select" value={draft.dataType} onChange={(e) => setDraft({ ...draft, dataType: e.target.value as PropDraft['dataType'] })}>
        {['string', 'integer', 'float', 'boolean', 'date', 'json', 'enum'].map((t) => (
          <option key={t} value={t}>
            {DATA_TYPE_LABEL[t]}
          </option>
        ))}
      </select>
      {draft.dataType === 'enum' && (
        <>
          <label className="form-label">枚举值</label>
          <input
            className="form-input"
            value={draft.enumValues}
            placeholder="逗号分隔，如 todo/plan_item/day"
            onChange={(e) => setDraft({ ...draft, enumValues: e.target.value })}
          />
        </>
      )}
      <label className="form-label">可空</label>
      <input type="checkbox" checked={draft.nullable} onChange={(e) => setDraft({ ...draft, nullable: e.target.checked })} />
      <label className="form-label">建索引</label>
      <input type="checkbox" checked={draft.indexed} onChange={(e) => setDraft({ ...draft, indexed: e.target.checked })} />
    </div>
  );
}

function CreateObjectTypeModal({ types, links, onClose, onDone }: { types: ObjectTypeDef[]; links: LinkTypeDef[]; onClose: () => void; onDone: Refresh }) {
  const [apiName, setApiName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [props, setProps] = useState<PropDraft[]>([emptyProp()]);
  const [titleProperty, setTitleProperty] = useState('');
  const [busy, setBusy] = useState(false);
  const linkHint = useMemo(() => links.filter((l) => !l.isSystem).length, [links]);
  void types;

  const save = async () => {
    setBusy(true);
    try {
      const properties = props
        .filter((p) => p.apiName.trim())
        .map((p) => ({
          apiName: p.apiName.trim(),
          dataType: p.dataType,
          nullable: p.nullable,
          indexed: p.indexed,
          enumValues: p.dataType === 'enum' ? p.enumValues.split(/[,，\s]+/).filter(Boolean) : undefined,
        }));
      const created = await call<ObjectTypeDef>(() =>
        api.data.createObjectType({ apiName: apiName.trim(), title: title.trim(), description, titleProperty: titleProperty || undefined, properties }),
      );
      toast(`对象类型已创建：${created.title}（表 ${created.tableName}）`);
      onDone();
      onClose();
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="新建对象类型" onClose={onClose} wide>
      <div className="form-row">
        <label className="form-label">显示名 *</label>
        <input className="form-input" value={title} placeholder="如 书架" onChange={(e) => setTitle(e.target.value)} />
        <label className="form-label">apiName *</label>
        <input className="form-input mono" value={apiName} placeholder="如 book" onChange={(e) => setApiName(e.target.value)} />
        <label className="form-label">说明</label>
        <input className="form-input" value={description} placeholder="可选" onChange={(e) => setDescription(e.target.value)} />
      </div>
      <h4>属性（id / created_at / updated_at 自动附带）</h4>
      {props.map((p, i) => (
        <div className="data-prop-row" key={i}>
          <PropertyForm draft={p} setDraft={(d) => setProps(props.map((x, j) => (j === i ? d : x)))} />
          <button className="icon-btn danger" title="移除属性行" onClick={() => setProps(props.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      <button className="btn slim ghost" onClick={() => setProps([...props, emptyProp()])}>
        + 添加属性行
      </button>
      <div className="form-row">
        <label className="form-label">标题属性</label>
        <select className="form-select" value={titleProperty} onChange={(e) => setTitleProperty(e.target.value)}>
          <option value="">第一个属性</option>
          {props.filter((p) => p.apiName.trim()).map((p) => (
            <option key={p.apiName} value={p.apiName.trim()}>
              {p.apiName}
            </option>
          ))}
        </select>
      </div>
      {linkHint > 0 && <p className="sub">提示：创建后可在「链接类型」里把它与其他类型关联。</p>}
      <footer className="modal-foot">
        <button className="btn ghost" onClick={onClose}>
          取消
        </button>
        <button className="btn primary" disabled={busy || !apiName.trim() || !title.trim()} onClick={() => void save()}>
          创建
        </button>
      </footer>
    </Modal>
  );
}

// ---------- 链接类型管理 ----------

export function LinkTypeManager({ types, links, onChanged }: { types: ObjectTypeDef[]; links: LinkTypeDef[]; onChanged: Refresh }) {
  const [creating, setCreating] = useState(false);

  const doDelete = async (l: LinkTypeDef) => {
    if (!window.confirm(`删除链接 ${l.title}（${l.apiName}）？`)) return;
    try {
      await call(() => api.data.deleteLinkType({ apiName: l.apiName }));
      toast('链接已删除');
      onChanged();
    } catch (e) {
      err(e);
    }
  };

  const typeTitle = (apiName: string) => types.find((t) => t.apiName === apiName)?.title ?? apiName;

  return (
    <div>
      <div className="toolbar">
        <span className="sub">链接类型描述对象之间的关系：一对多用外键属性落地，多对多用中间表对象承载。</span>
        <div className="spacer" />
        <button className="btn primary slim" onClick={() => setCreating(true)}>
          新建链接类型
        </button>
      </div>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>关系</th>
              <th>基数</th>
              <th>落地方式</th>
              <th>方向命名</th>
              <th>来源</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.apiName}>
                <td className="title-col">{l.title}</td>
                <td>
                  {typeTitle(l.leftType)} <span className="sub mono">{l.leftType}</span> → {typeTitle(l.rightType)}{' '}
                  <span className="sub mono">{l.rightType}</span>
                </td>
                <td>{CARDINALITY_LABEL[l.cardinality]}</td>
                <td className="mono">
                  {l.fkColumn
                    ? `外键 ${l.fkColumn}`
                    : l.linkTable
                      ? `中间表 ${l.linkTable}(${l.backingLeftProperty}/${l.backingRightProperty})`
                      : `多态 ${l.discriminatorColumn}=${l.discriminatorValue}`}
                </td>
                <td className="mono sub">
                  {l.leftLinkName ?? '—'} / {l.rightLinkName ?? '—'}
                </td>
                <td>
                  <span className="tag">{l.isSystem ? '系统' : '自定义'}</span>
                </td>
                <td>
                  {!l.isSystem && (
                    <button className="btn slim danger" onClick={() => void doDelete(l)}>
                      删除
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating && <CreateLinkTypeModal types={types} onClose={() => setCreating(false)} onDone={onChanged} />}
    </div>
  );
}

function CreateLinkTypeModal({ types, onClose, onDone }: { types: ObjectTypeDef[]; onClose: () => void; onDone: Refresh }) {
  const solid = types.filter((t) => !t.isVirtual);
  const [apiName, setApiName] = useState('');
  const [title, setTitle] = useState('');
  const [leftType, setLeftType] = useState(solid[0]?.apiName ?? '');
  const [rightType, setRightType] = useState(solid[1]?.apiName ?? solid[0]?.apiName ?? '');
  const [cardinality, setCardinality] = useState<'one_to_many' | 'one_to_one' | 'many_to_many'>('one_to_many');
  const [fkColumn, setFkColumn] = useState('');
  const [linkTable, setLinkTable] = useState('');
  const [backingLeftProperty, setBackingLeftProperty] = useState('');
  const [backingRightProperty, setBackingRightProperty] = useState('');
  const [busy, setBusy] = useState(false);

  const left = solid.find((t) => t.apiName === leftType);
  const right = solid.find((t) => t.apiName === rightType);
  const leftPkType = left?.properties.find((p) => p.apiName === left.primaryKey)?.dataType;
  // 外键候选：right 上与 left 主键同类型的属性
  const fkCandidates = (right?.properties ?? []).filter((p) => p.dataType === leftPkType).map((p) => p.apiName);
  const backing = solid.find((t) => t.apiName === linkTable);
  const backingCandidates = backing?.properties ?? [];

  const save = async () => {
    setBusy(true);
    try {
      await call(() =>
        api.data.createLinkType({
          apiName: apiName.trim(),
          title: title.trim() || apiName.trim(),
          leftType,
          rightType,
          cardinality,
          fkColumn: cardinality === 'many_to_many' ? undefined : fkColumn,
          linkTable: cardinality === 'many_to_many' ? linkTable : undefined,
          backingLeftProperty: cardinality === 'many_to_many' ? backingLeftProperty : undefined,
          backingRightProperty: cardinality === 'many_to_many' ? backingRightProperty : undefined,
        }),
      );
      toast('链接类型已创建');
      onDone();
      onClose();
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="新建链接类型" onClose={onClose} wide>
      <div className="form-row">
        <label className="form-label">显示名</label>
        <input className="form-input" value={title} placeholder="如 文件的标签" onChange={(e) => setTitle(e.target.value)} />
        <label className="form-label">apiName *</label>
        <input className="form-input mono" value={apiName} placeholder="如 note__tag" onChange={(e) => setApiName(e.target.value)} />
      </div>
      <div className="form-row">
        <label className="form-label">左（一）侧</label>
        <select className="form-select" value={leftType} onChange={(e) => setLeftType(e.target.value)}>
          {solid.map((t) => (
            <option key={t.apiName} value={t.apiName}>
              {t.title}（{t.apiName}）
            </option>
          ))}
        </select>
        <label className="form-label">右（多）侧</label>
        <select className="form-select" value={rightType} onChange={(e) => setRightType(e.target.value)}>
          {solid.map((t) => (
            <option key={t.apiName} value={t.apiName}>
              {t.title}（{t.apiName}）
            </option>
          ))}
        </select>
        <label className="form-label">基数</label>
        <select className="form-select" value={cardinality} onChange={(e) => setCardinality(e.target.value as typeof cardinality)}>
          <option value="one_to_many">一对多（外键在右侧）</option>
          <option value="one_to_one">一对一（外键在右侧）</option>
          <option value="many_to_many">多对多（中间表）</option>
        </select>
      </div>
      {cardinality !== 'many_to_many' ? (
        <div className="form-row">
          <label className="form-label">外键属性 *</label>
          <select className="form-select" value={fkColumn} onChange={(e) => setFkColumn(e.target.value)}>
            <option value="">选择 {right?.title} 上的属性…</option>
            {fkCandidates.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          {fkCandidates.length === 0 && (
            <span className="notice">
              {right?.title} 上没有与 {left?.title} 主键同类型的属性——先去「对象类型」给 {right?.title} 加一个 {leftPkType === 'integer' ? '整数' : '文本'} 属性作外键。
            </span>
          )}
        </div>
      ) : (
        <div className="form-row">
          <label className="form-label">中间表对象 *</label>
          <select className="form-select" value={linkTable} onChange={(e) => setLinkTable(e.target.value)}>
            <option value="">选择中间表对象类型…</option>
            {solid.map((t) => (
              <option key={t.apiName} value={t.apiName}>
                {t.title}（{t.apiName}）
              </option>
            ))}
          </select>
          <label className="form-label">左引用属性 *</label>
          <select className="form-select" value={backingLeftProperty} onChange={(e) => setBackingLeftProperty(e.target.value)}>
            <option value="">…</option>
            {backingCandidates.map((p) => (
              <option key={p.apiName} value={p.apiName}>
                {p.apiName}
              </option>
            ))}
          </select>
          <label className="form-label">右引用属性 *</label>
          <select className="form-select" value={backingRightProperty} onChange={(e) => setBackingRightProperty(e.target.value)}>
            <option value="">…</option>
            {backingCandidates.map((p) => (
              <option key={p.apiName} value={p.apiName}>
                {p.apiName}
              </option>
            ))}
          </select>
        </div>
      )}
      <footer className="modal-foot">
        <button className="btn ghost" onClick={onClose}>
          取消
        </button>
        <button
          className="btn primary"
          disabled={busy || !apiName.trim() || (cardinality === 'many_to_many' ? !(linkTable && backingLeftProperty && backingRightProperty) : !fkColumn)}
          onClick={() => void save()}
        >
          创建
        </button>
      </footer>
    </Modal>
  );
}

// ---------- 动作类型管理 ----------

export function ActionTypeManager({
  actions,
  types,
  links,
  onChanged,
}: {
  actions: ActionTypeDef[];
  types: ObjectTypeDef[];
  links: LinkTypeDef[];
  onChanged: Refresh;
}) {
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<ActionTypeDef | null>(null);

  const toggleStatus = async (a: ActionTypeDef) => {
    try {
      await call(() => api.data.updateActionType({ apiName: a.apiName, patch: { status: a.status === 'active' ? 'disabled' : 'active' } }));
      onChanged();
    } catch (e) {
      err(e);
    }
  };

  const doDelete = async (a: ActionTypeDef) => {
    if (!window.confirm(`删除动作「${a.title}」？`)) return;
    try {
      await call(() => api.data.deleteActionType({ apiName: a.apiName }));
      toast('动作已删除');
      onChanged();
    } catch (e) {
      err(e);
    }
  };

  const linkables = links.filter((l) => l.fkColumn || l.linkTable);

  return (
    <div>
      <div className="toolbar">
        <span className="sub">动作 = 参数 + 一组写规则（建/改/删对象、建/删链接），在单事务内执行。内置动作绑定核心业务（含打卡联动）。</span>
        <div className="spacer" />
        <button className="btn primary slim" onClick={() => setCreating(true)}>
          新建动作类型
        </button>
      </div>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>apiName</th>
              <th>参数</th>
              <th>规则</th>
              <th>来源</th>
              <th>状态</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {actions.map((a) => (
              <tr key={a.apiName}>
                <td className="title-col">{a.title}</td>
                <td className="mono">{a.apiName}</td>
                <td className="sub">
                  {a.parameters.length === 0 ? '—' : a.parameters.map((p) => `${p.name}${p.required ? '*' : ''}`).join('、')}
                </td>
                <td>
                  {a.isBuiltin ? (
                    <span className="tag">核心服务</span>
                  ) : a.operations.length === 0 ? (
                    '—'
                  ) : (
                    a.operations.map((op, i) => (
                      <span key={i} className="tag">
                        {OP_LABEL[op.kind]}
                      </span>
                    ))
                  )}
                </td>
                <td>
                  <span className="tag">{a.isBuiltin ? '内置' : '自定义'}</span>
                </td>
                <td>
                  <button className="btn slim ghost" onClick={() => void toggleStatus(a)}>
                    {a.status === 'active' ? '启用中' : '已停用'}
                  </button>
                </td>
                <td>
                  <button className="btn slim ghost" onClick={() => setTesting(a)}>
                    试运行
                  </button>
                  {!a.isBuiltin && (
                    <button className="btn slim danger" onClick={() => void doDelete(a)}>
                      删除
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating && <CreateActionTypeModal types={types} links={linkables} onClose={() => setCreating(false)} onDone={onChanged} />}
      {testing && <RunActionModal action={testing} onClose={() => setTesting(null)} onDone={onChanged} />}
    </div>
  );
}

// 值映射编辑器：参数 / 字面量 / 内建函数
function MappingEditor({
  label,
  mapping,
  params,
  onChange,
}: {
  label: string;
  mapping: ValueMapping | undefined;
  params: ActionParamDef[];
  onChange: (m: ValueMapping) => void;
}) {
  const kind = mapping && 'source' in mapping ? 'parameter' : mapping && 'fn' in mapping ? 'fn' : 'literal';
  return (
    <div className="data-map-row">
      <span className="form-label">{label}</span>
      <select
        className="form-select"
        value={kind}
        onChange={(e) => {
          const k = e.target.value;
          onChange(k === 'parameter' ? { source: { parameter: params[0]?.name ?? '' } } : k === 'fn' ? { fn: 'now' } : { literal: '' });
        }}
      >
        <option value="parameter">参数</option>
        <option value="literal">字面量</option>
        <option value="fn">函数</option>
      </select>
      {kind === 'parameter' && (
        <select
          className="form-select"
          value={(mapping as { source: { parameter: string } }).source.parameter}
          onChange={(e) => onChange({ source: { parameter: e.target.value } })}
        >
          {params.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      {kind === 'literal' && (
        <input
          className="form-input"
          value={String((mapping as { literal: unknown }).literal ?? '')}
          onChange={(e) => {
            const raw = e.target.value;
            onChange({ literal: raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw });
          }}
        />
      )}
      {kind === 'fn' && (
        <select className="form-select" value={(mapping as { fn: string }).fn} onChange={(e) => onChange({ fn: e.target.value as 'now' | 'uuid' })}>
          <option value="now">now（当前时间）</option>
          <option value="uuid">uuid（随机标识）</option>
        </select>
      )}
    </div>
  );
}

function OperationEditor({
  op,
  ops,
  setOps,
  index,
  types,
  links,
  params,
}: {
  op: ActionOperation;
  ops: ActionOperation[];
  setOps: (o: ActionOperation[]) => void;
  index: number;
  types: ObjectTypeDef[];
  links: LinkTypeDef[];
  params: ActionParamDef[];
}) {
  const solid = types.filter((t) => !t.isVirtual);
  const patch = (next: Partial<ActionOperation>) => setOps(ops.map((o, i) => (i === index ? { ...o, ...next } : o)));
  const target = solid.find((t) => t.apiName === op.objectType) ?? null;
  const link = links.find((l) => l.apiName === op.linkType) ?? null;
  const mappings = op.propertyMappings ?? {};

  return (
    <div className="data-op-card">
      <div className="data-op-head">
        <select className="form-select" value={op.kind} onChange={(e) => patch({ kind: e.target.value as ActionOperation['kind'] })}>
          {Object.entries(OP_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        {(op.kind === 'create_object' || op.kind === 'modify_object' || op.kind === 'delete_object') && (
          <select className="form-select" value={op.objectType ?? ''} onChange={(e) => patch({ objectType: e.target.value, propertyMappings: {}, selector: undefined })}>
            <option value="">目标对象类型…</option>
            {solid.map((t) => (
              <option key={t.apiName} value={t.apiName}>
                {t.title}（{t.apiName}）
              </option>
            ))}
          </select>
        )}
        {(op.kind === 'create_link' || op.kind === 'delete_link') && (
          <select className="form-select" value={op.linkType ?? ''} onChange={(e) => patch({ linkType: e.target.value })}>
            <option value="">目标链接…</option>
            {links.map((l) => (
              <option key={l.apiName} value={l.apiName}>
                {l.title}（{l.leftType} → {l.rightType}）
              </option>
            ))}
          </select>
        )}
        <div className="spacer" />
        <button className="icon-btn danger" title="移除规则" onClick={() => setOps(ops.filter((_, i) => i !== index))}>
          ×
        </button>
      </div>

      {(op.kind === 'create_object' || op.kind === 'modify_object') && target && (
        <>
          <div className="data-mappings">
            {target.properties
              .filter((p) => p.apiName !== 'created_at' && p.apiName !== 'updated_at')
              .map((p) => (
                <MappingEditor
                  key={p.apiName}
                  label={p.apiName}
                  params={params}
                  mapping={mappings[p.apiName]}
                  onChange={(m) => patch({ propertyMappings: { ...mappings, [p.apiName]: m } })}
                />
              ))}
          </div>
        </>
      )}
      {(op.kind === 'modify_object' || op.kind === 'delete_object') && target && (
        <div className="data-op-sec">
          <span className="form-label">筛选（定位目标行）</span>
          <select
            className="form-select"
            value={op.selector?.property ?? target.primaryKey}
            onChange={(e) => patch({ selector: { property: e.target.value, value: op.selector?.value ?? { source: { parameter: params[0]?.name ?? '' } } } })}
          >
            {target.properties.map((p) => (
              <option key={p.apiName} value={p.apiName}>
                {p.apiName}
              </option>
            ))}
          </select>
          <MappingEditor
            label="值"
            params={params}
            mapping={op.selector?.value}
            onChange={(m) => patch({ selector: { property: op.selector?.property ?? target.primaryKey, value: m } })}
          />
        </div>
      )}
      {(op.kind === 'create_link' || op.kind === 'delete_link') && link && (
        <div className="data-op-sec">
          <MappingEditor
            label={`${link.leftType} 主键`}
            params={params}
            mapping={op.leftId}
            onChange={(m) => patch({ leftId: m })}
          />
          <MappingEditor
            label={`${link.rightType} 主键`}
            params={params}
            mapping={op.rightId}
            onChange={(m) => patch({ rightId: m })}
          />
        </div>
      )}
      {op.kind === 'create_link' && link?.linkTable && (
        <p className="sub">多对多链接将在中间表 {link.linkTable} 插入一行。</p>
      )}
    </div>
  );
}

const emptyOperation = (): ActionOperation => ({ kind: 'create_object', objectType: '', propertyMappings: {} });

function CreateActionTypeModal({
  types,
  links,
  onClose,
  onDone,
}: {
  types: ObjectTypeDef[];
  links: LinkTypeDef[];
  onClose: () => void;
  onDone: Refresh;
}) {
  const [apiName, setApiName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [params, setParams] = useState<ActionParamDef[]>([{ name: '', dataType: 'string', required: true }]);
  const [ops, setOps] = useState<ActionOperation[]>([emptyOperation()]);
  const [busy, setBusy] = useState(false);

  const cleanParams = params.filter((p) => p.name.trim());

  const save = async () => {
    setBusy(true);
    try {
      await call(() =>
        api.data.createActionType({
          apiName: apiName.trim(),
          title: title.trim(),
          description,
          parameters: cleanParams.map((p) => ({ name: p.name.trim(), dataType: p.dataType, required: p.required })),
          operations: ops.map((o) => {
            // 序列化前剔除未配置完整的部分
            const out: ActionOperation = { kind: o.kind } as ActionOperation;
            if (o.objectType) out.objectType = o.objectType;
            if (o.linkType) out.linkType = o.linkType;
            if (o.selector && o.selector.property) out.selector = o.selector;
            const pm = Object.fromEntries(Object.entries(o.propertyMappings ?? {}).filter(([, v]) => v !== undefined));
            if (Object.keys(pm).length > 0) out.propertyMappings = pm;
            if (o.leftId) out.leftId = o.leftId;
            if (o.rightId) out.rightId = o.rightId;
            return out;
          }),
        }),
      );
      toast('动作类型已创建');
      onDone();
      onClose();
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="新建动作类型" onClose={onClose} wide>
      <div className="form-row">
        <label className="form-label">显示名 *</label>
        <input className="form-input" value={title} placeholder="如 记一笔读书" onChange={(e) => setTitle(e.target.value)} />
        <label className="form-label">apiName *</label>
        <input className="form-input mono" value={apiName} placeholder="如 log_reading" onChange={(e) => setApiName(e.target.value)} />
        <label className="form-label">说明</label>
        <input className="form-input" value={description} placeholder="可选" onChange={(e) => setDescription(e.target.value)} />
      </div>
      <h4>参数</h4>
      {params.map((p, i) => (
        <div className="data-map-row" key={i}>
          <input
            className="form-input mono"
            value={p.name}
            placeholder="参数名"
            onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
          />
          <select
            className="form-select"
            value={p.dataType}
            onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, dataType: e.target.value as ActionParamDef['dataType'] } : x)))}
          >
            {['string', 'integer', 'float', 'boolean', 'date', 'json'].map((t) => (
              <option key={t} value={t}>
                {DATA_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <label className="data-check">
            <input
              type="checkbox"
              checked={p.required}
              onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))}
            />
            必填
          </label>
          <button className="icon-btn danger" onClick={() => setParams(params.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      <button className="btn slim ghost" onClick={() => setParams([...params, { name: '', dataType: 'string', required: false }])}>
        + 添加参数
      </button>
      <h4>执行规则（按顺序，单事务）</h4>
      {ops.map((op, i) => (
        <OperationEditor key={i} op={op} ops={ops} setOps={setOps} index={i} types={types} links={links} params={cleanParams} />
      ))}
      <button className="btn slim ghost" onClick={() => setOps([...ops, emptyOperation()])}>
        + 添加规则
      </button>
      <footer className="modal-foot">
        <button className="btn ghost" onClick={onClose}>
          取消
        </button>
        <button className="btn primary" disabled={busy || !apiName.trim() || !title.trim()} onClick={() => void save()}>
          创建
        </button>
      </footer>
    </Modal>
  );
}

function RunActionModal({ action, onClose, onDone }: { action: ActionTypeDef; onClose: () => void; onDone: Refresh }) {
  const [params, setParams] = useState<Record<string, string>>({});
  const [result, setResult] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setResult('');
    try {
      const payload: Record<string, unknown> = {};
      for (const p of action.parameters) {
        const raw = params[p.name] ?? '';
        if (raw === '') continue;
        payload[p.name] = p.dataType === 'integer' || p.dataType === 'float' ? Number(raw) : raw;
      }
      const res = await call<unknown>(() => api.data.invokeAction({ apiName: action.apiName, params: payload }));
      setResult(JSON.stringify(res, null, 2));
      onDone();
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`试运行「${action.title}」`} onClose={onClose}>
      {action.parameters.length === 0 && <p className="sub">该动作无参数，直接执行。</p>}
      {action.parameters.map((p) => (
        <div className="form-row" key={p.name}>
          <label className="form-label">
            {p.name}
            {p.required ? ' *' : ''} <span className="sub">{p.dataType}</span>
          </label>
          <input
            className="form-input"
            value={params[p.name] ?? ''}
            placeholder={p.description ?? ''}
            onChange={(e) => setParams({ ...params, [p.name]: e.target.value })}
          />
        </div>
      ))}
      {result && (
        <pre className="mono data-result">
          {result}
        </pre>
      )}
      <footer className="modal-foot">
        <button className="btn ghost" onClick={onClose}>
          关闭
        </button>
        <button className="btn primary" disabled={busy} onClick={() => void run()}>
          执行
        </button>
      </footer>
    </Modal>
  );
}

// ---------- 通用弹窗 ----------

function Modal({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className="modal-mask" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
