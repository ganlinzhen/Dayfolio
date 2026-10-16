import type { ToolRegistrar, McpContext } from '../shared/context';
import { z } from 'zod';
import { wrap } from '../shared/response';

export function registerTools(server: ToolRegistrar, { core }: McpContext): void {
  // ---------- 本体（对象/链接/动作类型） ----------

  server.tool(
    'list_object_types',
    '列出 Dayfolio 本体的全部对象类型、链接类型与动作类型（含属性、主键、标题属性、链接基数等元数据）。想了解这个 App 有哪些数据结构、或 query_objects/invoke_action 该传什么参数时先调这个',
    {},
    wrap(() => {
      const objects = core.ontology.listObjectTypes().map((t) => ({
        apiName: t.apiName,
        title: t.title,
        description: t.description,
        writeMode: t.writeMode,
        extensionWritable: t.extensionWritable,
        visibility: t.visibility,

        isSystem: t.isSystem,
        isVirtual: t.isVirtual,
        primaryKey: t.primaryKey,
        titleProperty: t.titleProperty,
        count: t.isVirtual ? null : core.objects.count(t.apiName),
        properties: t.properties.map((p) => ({
          apiName: p.apiName,
          dataType: p.dataType,
          nullable: p.nullable,
          enumValues: p.enumValues,
          origin: p.origin,
          readable: p.readable !== false,
        })),
      }));
      const links = core.ontology.listLinkTypes();
      const actions = core.ontology.listActionTypes().map((a) => ({
        apiName: a.apiName,
        title: a.title,
        isBuiltin: a.isBuiltin,
        status: a.status,
        parameters: a.parameters,
        operations: a.operations,
        targetBindings: a.targetBindings,
        allowedChannels: a.allowedChannels,
        needsReview: a.needsReview,
        template: a.template,
        composable: a.composable,
      }));
      return { objectTypes: objects, linkTypes: links, actionTypes: actions };
    }),
  );

  server.tool(
    'query_objects',
    '查询任意非虚拟对象类型。新调用传 query（version=1、objectType、select、where 的 and/or/not、orderBy、page、includeTotal），结构先用 get_query_contract 查看。旧 object_type/search/filters/limit/offset 继续支持；新旧两套参数不得混用。只读查询不会触发采集或写入',
    {
      query: z.record(z.string(), z.unknown()).optional().describe('完整 v1 查询合同，由 core 统一验证'),
      object_type: z.string().min(1).optional().describe("旧合同的对象类型 apiName；新调用放在 query.objectType"),
      search: z.string().optional().describe('对文本属性模糊搜索'),
      filters: z
        .array(
          z.object({
            property: z.string().min(1).describe('属性 apiName'),
            op: z.enum(['eq', 'ne', 'like', 'in', 'gte', 'lte']).describe('比较方式'),
            value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number(), z.boolean()]))]).describe('比较值，in 支持数组'),
          }),
        )
        .optional()
        .describe('过滤条件，多个条件之间为 AND'),
      limit: z.number().int().positive().max(500).optional().describe('默认 50，最大 500'),
      offset: z.number().int().nonnegative().optional().describe('分页偏移'),
    },
    async ({ query, object_type, search, filters, limit, offset }) => wrap(() => {
      if (query !== undefined) {
        if ([object_type, search, filters, limit, offset].some(v => v !== undefined)) throw new Error('QUERY_INVALID：新旧查询参数不得混用');
        return core.queries.list(query);
      }
      if (!object_type) throw new Error('QUERY_INVALID：须提供 query 或 object_type');
      return core.objects.list(object_type, { search, where: filters, limit, offset });
    })(),
  );

  server.tool('get_query_contract', '查看某对象类型支持的统一查询版本、字段运算符、日期语义和限额。构造 query_objects 的 query 前调用；不会返回不可读字段', {
    object_type: z.string().min(1),
  }, async ({ object_type }) => wrap(() => core.queries.describe(object_type))());

  server.tool('aggregate_objects', '对对象筛选后统计或分组。query 合同：version=1、objectType、可选 where/search/groupBy（最多两字段）、必填 metrics（op=count/sum/avg/min/max、可选 property、必填 as）；having.property 引用指标别名，orderBy 引用 property 维度或 metric 指标，page 分页。返回 dimensions/metrics、objectCount、groupCount。先用 get_query_contract 查看字段能力；跨关系条件只做单跳 exists，不扩大计数', {
    query: z.record(z.string(), z.unknown()),
  }, async ({ query }) => wrap(() => core.queries.aggregate(query))());

  server.tool('query_related_objects', '分页读取对象的一类关联实体，支持字段投影和筛选。query 合同：version=1、objectType、id、linkType、side=left/right，以及可选 select/where/orderBy/page/includeTotal。只返回实际存在的对端对象；历史悬空引用请用 list_object_links 查看；关系页最大 200', {
    query: z.record(z.string(), z.unknown()),
  }, async ({ query }) => wrap(() => core.queries.related(query))());

  server.tool(
    'invoke_action',
    '执行内置、基础模板或声明式动作。先查看 list_object_types 的 parameters；纯数据库动作可传 options.idempotencyKey 避免重试重复写，并使用 preview_action 返回的 expectedDefinitionRevision/expectedObjects 防止覆盖并发修改。文件或人工业务不支持通用幂等选项，继续走专用恢复与确认。返回 executionId 可查执行记录',
    {
      action: z.string().min(1).describe('动作 apiName，如 add_todo / complete_todo / checkin'),
      params: z.record(z.string(), z.unknown()).optional().describe('动作参数，与动作定义的 parameters 对应'),
      options: z.record(z.string(), z.unknown()).optional().describe('可选 idempotencyKey、expectedDefinitionRevision、expectedObjects；由 core 统一验证'),
    },
    async ({ action, params, options }) => wrap(() => core.actions.execute(action, params ?? {}, options, 'mcp'))(),
  );

  server.tool('preview_action', '只读取得动作定义和当前可识别对象的修订，不执行动作。将 definitionRevision 和 targets 分别作为 invoke_action.options.expectedDefinitionRevision/expectedObjects。targetsComplete=false 表示新增对象、结果引用或业务联动无法由此预览穷尽；预览不代替人工确认', {
    action: z.string().min(1), params: z.record(z.string(), z.unknown()).optional(),
  }, async ({ action, params }) => wrap(() => core.actions.preview(action, params ?? {}))());

  server.tool('list_action_executions', '分页查看动作执行成功/失败记录、重试次数和入口；返回的 executionId 可定位本次操作。只读，不返回幂等键、参数摘要、私有结果或认领凭证', {
    action: z.string().optional(), status: z.enum(['succeeded', 'failed']).optional(), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional(),
  }, async input => wrap(() => core.actionRuns.list(input))());

  // ---------- 本体：通用实例 CRUD（任意对象类型，含自定义类型） ----------

  const propertyInputSchema = z.object({
    api_name: z.string().min(1).describe('属性名，小写 snake_case（如 rating）'),
    data_type: z.enum(['string', 'integer', 'float', 'boolean', 'date', 'json', 'enum']).describe('数据类型'),
    nullable: z.boolean().optional().describe('是否可空，默认 true'),
    enum_values: z.array(z.string()).optional().describe('枚举取值清单（data_type=enum 时必填）'),
    indexed: z.boolean().optional().describe('是否建索引，默认否'),
  });

  type PropertyDataTypes = 'string' | 'integer' | 'float' | 'boolean' | 'date' | 'json' | 'enum';

  const toPropertyInput = (p: { api_name: string; data_type: PropertyDataTypes; nullable?: boolean; enum_values?: string[]; indexed?: boolean }) => ({
    apiName: p.api_name,
    dataType: p.data_type,
    nullable: p.nullable ?? true,
    enumValues: p.enum_values,
    indexed: p.indexed,
  });

  server.tool(
    'get_object',
    '读取单个对象的完整详情：全部属性值 + 出链/入链（它引用了谁、谁引用了它）。配合 query_objects 拿到 id 后深入查看',
    {
      query: z.record(z.string(), z.unknown()).optional().describe('新 v1 单对象合同：version、objectType、id、可选 select；不能和旧参数混用，返回投影行或 null'),
      object_type: z.string().min(1).optional().describe('旧合同的对象类型 apiName'),
      id: z.union([z.string(), z.number()]).optional().describe('旧合同的对象主键值'),
    },
    async ({ query, object_type, id }) => wrap(() => {
      if (query !== undefined) {
        if (object_type !== undefined || id !== undefined) throw new Error('QUERY_INVALID：新旧查询参数不得混用');
        return core.queries.get(query);
      }
      if (!object_type || id === undefined) throw new Error('QUERY_INVALID：须提供完整对象引用');
      const row = core.objects.get(object_type, id);
      if (!row) throw new Error(`对象不存在：${object_type}#${String(id)}`);
      return { row, links: core.objects.resolveLinks(object_type, row), groups:core.relations.groups(object_type,id) };
    })(),
  );

  server.tool(
    'create_object',
    '在任意对象类型（含用户自定义类型）上创建一条实例。注意：对系统类型（todo 等）建议优先用专用工具（add_todo 等，业务联动更完整），本工具仅允许创建自定义类型，系统对象请调用推荐业务动作',
    {
      object_type: z.string().min(1).describe('对象类型 apiName'),
      values: z.record(z.string(), z.unknown()).describe('属性值（apiName → 值），必填属性不能缺省；id/created_at/updated_at 自动生成'),
    },
    async ({ object_type, values }) => wrap(() => core.actions.writeObject(object_type, 'create', undefined, values, {}, 'mcp'))(),
  );

  server.tool(
    'update_object',
    '更新自定义对象或系统对象允许的用户扩展字段；系统内置字段请使用业务动作，混合 patch 整体拒绝',
    {
      object_type: z.string().min(1).describe('对象类型 apiName'),
      id: z.union([z.string(), z.number()]).describe('对象主键值'),
      values: z.record(z.string(), z.unknown()).describe('要更新的属性值'),
    },
    async ({ object_type, id, values }) => wrap(() => core.actions.writeObject(object_type, 'update', id, values, {}, 'mcp'))(),
  );

  server.tool(
    'delete_object',
    '删除自定义对象实例并遵守关系删除约束。系统业务对象请使用专用删除动作；历史记录和知识库索引不可裸删',
    {
      object_type: z.string().min(1).describe('对象类型 apiName'),
      id: z.union([z.string(), z.number()]).describe('对象主键值'),
    },
    async ({ object_type, id }) =>
      wrap(() => {
        core.actions.writeObject(object_type, 'delete', id, {}, {}, 'mcp');
        return true;
      })(),
  );

  // ---------- 本体：类型管理（对象/链接/动作类型） ----------

  server.tool('list_object_links','分页查看对象的一类关系，支持两端和多对多。想查看全部关联或从素材查引用它的内容时调用；side 为当前对象处于 left 或 right',{
    object_type:z.string(),id:z.union([z.string(),z.number()]),link_type:z.string(),side:z.enum(['left','right']),
    limit:z.number().int().positive().max(200).optional(),offset:z.number().int().nonnegative().optional(),
  },async p=>wrap(()=>core.relations.list(p.object_type,p.id,p.link_type,p.side,p.limit,p.offset))());
  server.tool('create_link','建立自定义对象关联，或关联内容与素材。目标须存在，重复请求不重复插入；已有其他目标须先解除。不会直接修改系统业务关系',{
    link_type:z.string(),left_id:z.union([z.string(),z.number()]),right_id:z.union([z.string(),z.number()]),properties:z.record(z.string(),z.unknown()).optional(),
  },async p=>wrap(()=>core.actions.writeRelation(p.link_type,'create',p.left_id,p.right_id,p.properties,{},'mcp'))());
  server.tool('delete_link','解除给定两端之间的关联。必填关联不可置空；对象已换绑时拒绝，避免删除新关联。重复解除同一关系无副作用',{
    link_type:z.string(),left_id:z.union([z.string(),z.number()]),right_id:z.union([z.string(),z.number()]),
  },async p=>wrap(()=>core.actions.writeRelation(p.link_type,'delete',p.left_id,p.right_id,undefined,{},'mcp'))());

  server.tool(
    'create_object_type',
    '创建自定义对象类型（自动建表 ont_obj_<api_name>，附带 id/created_at/updated_at）。属性类型：string/integer/float/boolean/date/json/enum。建好后即可用 create_object 写入、create_link_type 建关系',
    {
      api_name: z.string().min(1).describe('类型标识，小写 snake_case（如 book）'),
      title: z.string().min(1).describe('显示名（如 书）'),
      description: z.string().optional().describe('说明'),
      title_property: z.string().optional().describe('列表主显属性，默认第一个属性'),
      generate_actions: z.boolean().optional().describe('是否生成新增/编辑/删除基础动作，默认 true；关闭后只能通过显式自定义动作写入'),
      properties: z.array(propertyInputSchema).describe('属性清单（不含自动附带的 id/created_at/updated_at）'),
    },
    async ({ api_name, title, description, title_property, properties, generate_actions }) =>
      wrap(() =>
        core.ontology.createObjectType({
          apiName: api_name,
          title,
          description,
          titleProperty: title_property,
          generateActions: generate_actions,
          properties: properties.map(toPropertyInput),
        }),
      )(),
  );

  server.tool(
    'update_object_type',
    '修改对象类型：改显示名/说明/标题属性、追加属性（自动加列）、删除后加的属性（连同该列数据）。内置属性受保护不可删；删除被链接或动作引用的属性会被拒绝',
    {
      api_name: z.string().min(1).describe('对象类型 apiName'),
      patch: z
        .object({
          title: z.string().optional(),
          description: z.string().optional(),
          title_property: z.string().optional().describe('标题属性 apiName'),
          add_properties: z.array(propertyInputSchema).optional().describe('要追加的属性（系统类型只允许可空属性）'),
          drop_property: z.string().optional().describe('要删除的属性 apiName（仅限后加属性）'),
        })
        .describe('要修改的字段，只传需要改的'),
    },
    async ({ api_name, patch }) =>
      wrap(() =>
        core.ontology.updateObjectType(api_name, {
          title: patch.title,
          description: patch.description,
          titleProperty: patch.title_property,
          addProperties: patch.add_properties?.map(toPropertyInput),
          dropProperty: patch.drop_property,
        }),
      )(),
  );

  server.tool(
    'delete_object_type',
    '删除自定义对象类型：连同物理表与全部数据，不可恢复。系统类型不可删。仍被链接或动作引用时会被拒绝（先删引用方）',
    {
      api_name: z.string().min(1).describe('对象类型 apiName'),
    },
    async ({ api_name }) =>
      wrap(() => {
        core.ontology.deleteObjectType(api_name);
        return true;
      })(),
  );

  server.tool(
    'create_link_type',
    '创建链接类型（对象间关系）。一对一/一对多：外键属性须已存在于右（多）侧类型上且与左侧主键同类型（可先用 update_object_type 加）；多对多：须先建一个中间表对象类型并带左右两个引用属性',
    {
      api_name: z.string().min(1).describe('链接标识，小写 snake_case（如 folder__note）'),
      title: z.string().optional().describe('显示名，缺省用 api_name'),
      left_type: z.string().min(1).describe('「一」侧类型 apiName'),
      right_type: z.string().min(1).describe('「多」侧类型 apiName（外键挂这侧）'),
      cardinality: z.enum(['one_to_one', 'one_to_many', 'many_to_many']).describe('基数'),
      fk_column: z.string().optional().describe('一对一/一对多必填：right 侧的外键属性 apiName'),
      on_delete: z.enum(['restrict','set_null']).optional().describe('删除左对象时：默认阻止删除；set_null 要求右侧引用属性可空'),
      link_table: z.string().optional().describe('多对多必填：中间表对象类型 apiName'),
      backing_left_property: z.string().optional().describe('多对多必填：中间表上指向 left 主键的属性'),
      backing_right_property: z.string().optional().describe('多对多必填：中间表上指向 right 主键的属性'),
    },
    async (input) =>
      wrap(() =>
        core.ontology.createLinkType({
          apiName: input.api_name,
          title: input.title ?? input.api_name,
          leftType: input.left_type,
          rightType: input.right_type,
          cardinality: input.cardinality,
          fkColumn: input.fk_column,
          onDelete: input.on_delete,
          linkTable: input.link_table,
          backingLeftProperty: input.backing_left_property,
          backingRightProperty: input.backing_right_property,
        }),
      )(),
  );

  server.tool(
    'delete_link_type',
    '删除自定义链接类型（纯元数据操作，不动实例数据）。仍被动作引用时会被拒绝',
    {
      api_name: z.string().min(1).describe('链接类型 apiName'),
    },
    async ({ api_name }) =>
      wrap(() => {
        core.ontology.deleteLinkType(api_name);
        return true;
      })(),
  );

  server.tool(
    'create_action_type',
    '创建自定义数据库事务动作。五类对象/关系操作沿用 list_object_types 的 operations 结构；还可 {kind:"invoke_command",command:"add_todo",params:{title:{literal:"复习"}}} 调用 composable=true 的白名单命令。值映射支持 source.parameter、literal、fn=now/uuid，以及 {result:{step:前步从0开始的编号,path:["objectId"]}}；命令返回值路径使用 ["value","id"]。最多50步，不接受文件、联网、人工审核或前向引用',
    {
      api_name: z.string().min(1).describe('动作标识，小写 snake_case（如 log_reading）'),
      title: z.string().min(1).describe('显示名'),
      description: z.string().optional().describe('说明'),
      parameters: z
        .array(
          z.object({
            name: z.string().min(1).describe('参数名，小写 snake_case'),
            data_type: z.enum(['string', 'integer', 'float', 'boolean', 'date', 'json']).describe('参数类型'),
            required: z.boolean().optional().describe('是否必填，默认否'),
            description: z.string().optional(),
            object_type: z.string().optional().describe('可选的对象引用类型，执行时检查目标存在'),
            json_schema: z.record(z.string(), z.unknown()).optional().describe('结构化参数校验，支持 type/const/enum/anyOf/items/properties/required/additionalProperties'),
          }),
        )
        .describe('参数清单'),
      operations: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .describe('写规则数组（见工具描述中的形态说明），引用的参数必须已声明'),
    },
    async ({ api_name, title, description, parameters, operations }) =>
      wrap(() =>
        core.ontology.createActionType({
          apiName: api_name,
          title,
          description,
          parameters: parameters.map((p) => ({ name: p.name, dataType: p.data_type, required: p.required ?? false, description: p.description, objectType: p.object_type, jsonSchema: p.json_schema })),
          operations: operations as never,
        }),
      )(),
  );

  server.tool(
    'update_action_type',
    '修改动作类型：改显示名/说明/启停状态。内置动作不可删除但可停用（停用后 invoke_action 拒绝执行）',
    {
      api_name: z.string().min(1).describe('动作 apiName'),
      patch: z
        .object({
          title: z.string().optional(),
          description: z.string().optional(),
          status: z.enum(['active', 'disabled']).optional().describe('启停状态'),
        })
        .describe('要修改的字段'),
    },
    async ({ api_name, patch }) => wrap(() => core.ontology.updateActionType(api_name, patch))(),
  );

  server.tool(
    'delete_action_type',
    '删除自定义动作类型（内置动作不可删，可停用）',
    {
      api_name: z.string().min(1).describe('动作 apiName'),
    },
    async ({ api_name }) =>
      wrap(() => {
        core.ontology.deleteActionType(api_name);
        return true;
      })(),
  );
}
