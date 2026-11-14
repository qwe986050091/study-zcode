// 会话 CUA 分组投影：把连续的 Computer Use 工具调用与同 response 的正文、推理收成一张卡片
// INV-01 连续官方 CUA 工具调用归并进同一组；守住位置：appendCua 与 ensureGroup；改错故障：每一步截图或点击都生成独立卡片，时间线被同类条目冲散。
// INV-02 组内 rows 与 events 严格保持原始时间线顺序；守住位置：appendCua 与 appendAssistantMessage；改错故障：正文跑到工具调用之前，因果被读反。
// INV-03 组 key 优先用 assistant response id，缺失时退回首行 rowId；守住位置：buildCuaGroup 身份计算；改错故障：流式阶段组被反复重建，展开状态与滚动位置丢失。
// INV-04 组首工具行只作锚点，不要求是最小 rowId；守住位置：ensureGroup 的 anchorRow 传参；改错故障：先到的正文被弃用，组首缺失说明文字。
// INV-05 非 CUA 工具调用必须关闭当前组；守住位置：主循环工具分支的 else if；改错故障：后续普通工具被吞进 CUA 卡片，点击目标错位。
// INV-06 userInput 与已存在的 cuaGroup 项直接关闭当前组；守住位置：主循环前两个 continue 分支；改错故障：跨用户轮次错误合组，历史消息被并成一张卡片。
// INV-07 marker 与 todo/status 不构成工具边界，也不关闭组；守住位置：主循环末尾 else 分支；改错故障：状态提示把一次连续操作切成两段。
// INV-08 同一 response 内出现非 CUA 工具时，该 response 的正文与推理不得入组；守住位置：hasNonCuaTool 判定；改错故障：混合 response 的说明文字被藏进 CUA 卡片。
// INV-09 未分类的 streaming 正文只原位显示，既不吸收也不关闭旧组；守住位置：handleAssistantMessage 第二分支；改错故障：摘要出现后正文回跳，列表抖动。
// INV-10 无 responseId 的 reasoning 只原位显示；守住位置：handleReasoning 的缺失分支；改错故障：旧数据把相邻 response 错误并入，思考内容错位。
// INV-11 活动组在源项耗尽后按 stageTailIsRunning 决定是否收尾；守住位置：函数末尾的 closeGroup 判定；改错故障：运行中的组提前变灰，或结束后一直保持转圈。
// INV-12 关闭组时同步把虚拟工具状态改为 completed；守住位置：closeGroup 状态回写；改错故障：卡片状态与真实执行不一致，用户误判仍在运行。
// INV-13 关闭组只清空活动引用并回写状态，不删除已入组事件；守住位置：closeGroup；改错故障：历史步骤消失或已闭合组继续增长。
// INV-14 enabled 为 false 时返回源项的新数组副本；守住位置：函数入口早返回；改错故障：上游就地排序污染原始流，回滚开关后顺序异常。
// INV-15 assistantResponseIds 合并时去重追加；守住位置：ensureGroup 复用分支；改错故障：同一 response 重复计入，折叠与统计判断失真。
// INV-16 rows 由工具型 events 推导，两者必须同源；守住位置：buildCuaGroup 与 appendCua；改错故障：rows 与 events 数量不一致，工具树漏节点。
// INV-17 空输入返回空数组而非空值；守住位置：prepared 初值与主循环；改错故障：调用方对结果做映射时崩溃。
// INV-18 返回值始终是新数组，源项数组不被就地改写；守住位置：appendFlowRow 与 prepared 落盘；改错故障：上游命中缓存旧顺序，界面不刷新。
// 上述不变量共同保证同一输入得到同构分组，不依赖时间戳排序，也不猜测相邻 response 的归属。
// 修改前先确认破坏的是哪一条，再决定补判定还是改实现。
//
import type { AssistantTextRow, ReasoningRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnRenderUnits.js";
import type { ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";

// 组内事件三态：工具调用携带渲染节点，正文与推理只携带 row 引用
// events 保序，渲染层按此顺序铺排思考、正文与工具，不做二次排序
// 只有 tool 事件贡献子节点，正文与推理不进入工具树
export type ConversationCuaGroupEvent =
  | { kind: "tool"; row: ToolCallRow; node: TaskChatToolCallTreeNode }
  | { kind: "assistantMessage"; row: AssistantTextRow }
  | { kind: "reasoning"; row: ReasoningRow };

// 渲染项是对外唯一契约：kind 固定为 cuaGroup，其余字段由 prepare 系列函数填充
// active 表示该组仍可能吸收事件，node 是给工具树复用的合成节点
export interface ConversationCuaGroupRenderItem {
  kind: "cuaGroup";
  key: string;
  rowId: number;
  rows: ToolCallRow[];
  events: ConversationCuaGroupEvent[];
  node: TaskChatToolCallTreeNode;
  active: boolean;
  flowKind: "assistantHistory" | "assistantWork";
  assistantResponseIds: string[];
}

// 只有官方 Computer Use MCP 前缀算 CUA，插件的其他同名工具不得混入
// 两套前缀分别对应内置服务与插件形态，新增宿主需在此登记，否则整组不生效
// [权衡] 用前缀匹配而非精确白名单，换取工具版本升级后仍能归组，代价是依赖命名约束
const OFFICIAL_CUA_TOOL_PREFIXES = [
  "mcp__computer-use__",
  "mcp__plugin_zcode-cua_computer-use__",
] as const;

export const ENABLE_CUA_TOOL_CALL_GROUPING = true;

function isToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  return row.kind === "toolCall";
}

// 对外判定入口：先确认是 toolCall 行，再看工具名是否命中任一官方前缀
// 分类阶段与主循环共用同一判定，避免两处规则漂移导致正文与工具归属不一致
// 非工具行一律返回 false，调用方无需先做 kind 判断
export function isOfficialCuaToolCallRow(row: AssistantWorkRow): boolean {
  return (
    isToolCallRow(row) &&
    OFFICIAL_CUA_TOOL_PREFIXES.some((prefix) => row.toolName.startsWith(prefix))
  );
}

function buildCuaGroup(
  events: ConversationCuaGroupEvent[],
  active: boolean,
  flowKind: ConversationCuaGroupRenderItem["flowKind"],
  assistantResponseId?: string,
  anchorRow?: ToolCallRow,
): ConversationCuaGroupRenderItem {
  // rows 只由 tool 事件投影得到，正文与推理不进入工具树，二者数量必须同源
  const rows = events.flatMap((event) => (event.kind === "tool" ? [event.row] : []));
  const firstRow = anchorRow ?? rows[0];
  // 组身份优先用持久的 assistant response id，流式阶段就能定下 key
  // 缺少 response 时退回首个 ToolCall 的 rowId，兼容旧快照与无 ID 数据
  // [并发] key 稳定后 React 复用同一卡片，增量事件只更新内容而不重建组件
  // identity 同时用作虚拟 toolId 前缀，保证工具树与渲染项指向同一逻辑实体
  const identity = assistantResponseId
    ? `cua-response:${assistantResponseId}`
    : `cua:${firstRow?.rowId ?? "unknown"}`;
  const virtualToolId = assistantResponseId ? identity : `cua:${firstRow?.toolCallId ?? "unknown"}`;
  return {
    kind: "cuaGroup",
    // 以首个 ToolCall 为身份无法在正文流式阶段表达 response，也会让工具到达时
    // Group 被重建。新投影以持久 assistant message id 锚定 response，旧快照才退回 tool row。
    key: identity,
    rowId: firstRow?.rowId ?? 0,
    rows,
    events,
    active,
    flowKind,
    assistantResponseIds: assistantResponseId ? [assistantResponseId] : [],
    node: {
      toolCall: {
        toolId: virtualToolId,
        // 合成工具节点让 CUA 卡片复用既有工具渲染链路，无需独立组件分支
        // 状态随 active 切换：进行中为 in_progress，收尾后置 completed
        // startedAt 仅在首行带合法时间戳时透传，避免伪造排序依据
        toolName: "CuaGroup",
        kind: "cuaGroup",
        title: "Computer Use",
        input: {},
        // 合成节点的状态跟随 active，收尾时 closeGroup 会再覆盖一次 completed
        status: active ? "in_progress" : "completed",
        startedAt: typeof firstRow?.startedAt === "number" ? firstRow.startedAt : undefined,
      },
      childToolCalls: rows.map(toolCallRowToLegacyNode),
    },
  };
}

// 单个 response 的工具画像：是否含官方 CUA、是否含非 CUA 工具、首个 CUA 行
// 三者共同回答一个问题：这个 response 的正文与推理能否整体并入 CUA 组
interface ResponseClassification {
  hasOfficialCua: boolean;
  hasNonCuaTool: boolean;
  firstCuaRow?: ToolCallRow;
}

// 先全量扫描源项，按 assistantResponseId 建立工具画像，主循环只做查表
// [事务] 分类必须先于任何分组动作完成，否则先到的正文会按不完整事实归位
// 只统计带 response id 的工具行，缺 id 的旧数据不参与分类，也不被猜测
function classifyResponses(
  sourceItems: readonly ConversationTurnFlowItem[],
): Map<string, ResponseClassification> {
  const classifications = new Map<string, ResponseClassification>();
  const visit = (row: AssistantWorkRow) => {
    if (row.kind !== "toolCall" || !row.assistantResponseId) return;
    const current = classifications.get(row.assistantResponseId) ?? {
      hasOfficialCua: false,
      hasNonCuaTool: false,
    };
    if (isOfficialCuaToolCallRow(row)) {
      current.hasOfficialCua = true;
      current.firstCuaRow ??= row;
    } else {
      current.hasNonCuaTool = true;
    }
    classifications.set(row.assistantResponseId, current);
  };

  for (const item of sourceItems) {
    if (item.kind === "assistantHistory" || item.kind === "assistantWork") {
      for (const row of item.rows) visit(row);
    }
  }
  return classifications;
}

// 非 CUA 行的落盘入口：同 kind 的相邻项直接合并，否则新建一个流片段
// 合并只追加 rows，不改写既有片段，保持已交给调用方的数组元素稳定
// 它与 CUA 分支互斥，保证组外内容不会多出空片段
function appendFlowRow(
  items: ConversationTurnFlowItem[],
  kind: "assistantHistory" | "assistantWork",
  row: AssistantWorkRow,
): void {
  const previous = items.at(-1);
  // 相邻同 kind 才合并，跨 kind 必新建片段，组外内容因此不会出现空段
  if (previous?.kind === kind) previous.rows.push(row);
  else items.push({ kind, rows: [row] });
}

export function prepareCuaGroupFlowItems(
  sourceItems: readonly ConversationTurnFlowItem[],
  options: { enabled: boolean; stageTailIsRunning: boolean },
): ConversationTurnFlowItem[] {
  // 开关关闭时返回浅拷贝，调用方仍可安全排序，而源项数组不被就地改写
  // 关闭路径不建组也不分类，保证灰度回滚时零行为差异
  if (!options.enabled) return [...sourceItems];

  const prepared: ConversationTurnFlowItem[] = [];
  const responseClassifications = classifyResponses(sourceItems);
  let activeGroup: ConversationCuaGroupRenderItem | null = null;
  const closeGroup = () => {
    if (activeGroup) {
      activeGroup.active = false;
      activeGroup.node.toolCall.status = "completed";
    }
    activeGroup = null;
  };
  // 惰性建组：已有活动组直接复用，没有才构造并压入结果数组
  // 复用分支补登记 assistantResponseId 并去重，一个组可涵盖同一 response 的多段事件
  // [资源] anchorRow 在组内尚无工具时提供 rowId 与起始时间，避免组首身份漂移
  const ensureGroup = (
    flowKind: ConversationCuaGroupRenderItem["flowKind"],
    assistantResponseId?: string,
    anchorRow?: ToolCallRow,
  ): ConversationCuaGroupRenderItem => {
    if (activeGroup) {
      if (assistantResponseId && !activeGroup.assistantResponseIds.includes(assistantResponseId)) {
        activeGroup.assistantResponseIds.push(assistantResponseId);
      }
      return activeGroup;
    }
    activeGroup = buildCuaGroup([], true, flowKind, assistantResponseId, anchorRow);
    prepared.push(activeGroup);
    return activeGroup;
  };
  const appendCua = (row: ToolCallRow, flowKind: ConversationCuaGroupRenderItem["flowKind"]) => {
    const event: ConversationCuaGroupEvent = {
      kind: "tool",
      row,
      node: toolCallRowToLegacyNode(row),
    };
    const group = ensureGroup(flowKind, row.assistantResponseId, row);
    group.events.push(event);
    group.rows.push(row);
    group.node.childToolCalls.push(event.node);
  };
  const appendAssistantMessage = (
    row: AssistantTextRow,
    flowKind: ConversationCuaGroupRenderItem["flowKind"],
    classification: ResponseClassification,
  ) => {
    const group = ensureGroup(flowKind, row.assistantResponseId, classification.firstCuaRow);
    group.events.push({ kind: "assistantMessage", row });
  };
  const appendReasoning = (
    row: ReasoningRow,
    flowKind: ConversationCuaGroupRenderItem["flowKind"],
    classification: ResponseClassification,
  ) => {
    const group = ensureGroup(flowKind, row.assistantResponseId, classification.firstCuaRow);
    group.events.push({ kind: "reasoning", row });
  };
  const handleAssistantMessage = (
    row: AssistantTextRow,
    flowKind: ConversationCuaGroupRenderItem["flowKind"],
    appendOutside: () => void,
  ) => {
    const responseId = row.assistantResponseId;
    const classification = responseId ? responseClassifications.get(responseId) : undefined;
    if (classification?.hasOfficialCua && !classification.hasNonCuaTool) {
      appendAssistantMessage(row, flowKind, classification);
      return;
    }
    // [失败路径] 尚无工具事实的 streaming 正文只原位输出，绝不抢先入组
    // 此时也不关闭旧组，防止正文在摘要出现后被搬回组内造成跳位
    // 判定收窄到 streaming，已结束的未分类 response 仍按普通边界处理
    if (responseId && !classification && row.state === "streaming") {
      // 把活动 Group 后尚未分类的 streaming response 提前收纳会让正文
      // 在滚动摘要出现后还可能被移回外部。没有 tool 事实前只原位显示，且不关闭旧 Group。
      appendOutside();
      return;
    }
    closeGroup();
    appendOutside();
  };
  const handleReasoning = (
    row: ReasoningRow,
    flowKind: ConversationCuaGroupRenderItem["flowKind"],
    appendOutside: () => void,
  ) => {
    const responseId = row.assistantResponseId;
    const classification = responseId ? responseClassifications.get(responseId) : undefined;
    if (classification?.hasOfficialCua && !classification.hasNonCuaTool) {
      appendReasoning(row, flowKind, classification);
      return;
    }
    // 推理常早于正文与工具到达，缺分类不等于非 CUA，因此只原位展示
    // 旧的无 response 数据同样走此分支，保持不构成工具边界的兼容语义
    // [权衡] 宁可少归并一次，也不凭相邻位置猜归属，避免整段内容错组
    if (!responseId || !classification) {
      // reasoning 往往先于正文和工具完成；仅凭当前没有 tool 就关闭活动 Group，
      // 会把随后确认的纯 CUA response 错切成新组。未分类阶段和旧无 ID 数据都只原位展示；
      // 后者保持“不构成工具边界”的兼容语义，且不猜相邻 response。
      appendOutside();
      return;
    }
    closeGroup();
    appendOutside();
  };

  for (const item of sourceItems) {
    if (item.kind === "cuaGroup") {
      closeGroup();
      prepared.push(item);
      continue;
    }
    if (item.kind === "userInput") {
      closeGroup();
      prepared.push(item);
      continue;
    }
    if (item.kind === "assistantText") {
      handleAssistantMessage(item.row, "assistantWork", () => prepared.push(item));
      continue;
    }

    for (const row of item.rows) {
      if (row.kind === "toolCall" && isOfficialCuaToolCallRow(row)) {
        appendCua(row, item.kind);
      // 非官方 CUA 的工具调用是硬边界：先关闭当前组，再按流片段原样落盘
      // 边界关闭保证后续 CUA 另起新组，不会把两类工具混进同一张卡片
      // 关闭动作只改状态，已收进组的步骤全部保留
      } else if (row.kind === "toolCall") {
        closeGroup();
        appendFlowRow(prepared, item.kind, row);
      } else if (row.kind === "assistantText") {
        handleAssistantMessage(row, item.kind, () => appendFlowRow(prepared, item.kind, row));
      } else if (row.kind === "reasoning") {
        handleReasoning(row, item.kind, () => appendFlowRow(prepared, item.kind, row));
      } else {
        // marker、todo/status 只在 Group 外展示，不构成 response 工具边界。
        appendFlowRow(prepared, item.kind, row);
      }
    }
  }

  // 源项耗尽后按阶段是否仍在运行决定收尾：运行中保留 active 等待后续事件
  // [并发] 流式追加期间不主动闭合，避免下一批事件无处可去而新建重复组
  // 阶段结束后统一置 completed，卡片不再显示运行态
  if (activeGroup && !options.stageTailIsRunning) closeGroup();
  return prepared;
}

/** 仅供 timeline-only/旧工作项路径兼容；正常 product turn 在 flow 层完成混合聚合。 */
// 旧工作项路径的兼容壳：把扁平 rows 包成单一片段，复用同一分组投影
// 因此 timeline-only 调用方与主流程共享归并规则，不再维护第二套实现
// 输出再摊平成混合数组：cuaGroup 保留为渲染项，其余还原为原始 row
export function prepareCuaGroups(
  rows: readonly AssistantWorkRow[],
  enabled: boolean,
  stageTailIsRunning: boolean,
): Array<AssistantWorkRow | ConversationCuaGroupRenderItem> {
  const projected = prepareCuaGroupFlowItems([{ kind: "assistantWork", rows: [...rows] }], {
    enabled,
    stageTailIsRunning,
  });
  const flattened: Array<AssistantWorkRow | ConversationCuaGroupRenderItem> = [];
  for (const item of projected) {
    if (item.kind === "cuaGroup") flattened.push(item);
    else if (item.kind === "assistantHistory" || item.kind === "assistantWork") {
      flattened.push(...item.rows);
    } else if (item.kind === "assistantText") {
      flattened.push(item.row);
    }
  }
  return flattened;
}
