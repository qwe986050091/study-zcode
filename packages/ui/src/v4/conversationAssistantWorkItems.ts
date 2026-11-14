// 本文件把 assistant 工作区的原始行序列投影成渲染工作项序列，是 v4 会话视图的中间层。
// 输入是同一 turn 内的 AssistantWorkRow（reasoning / toolCall / subagent / cuaGroup 等），
// 输出是带稳定 key 的 ConversationAssistantWorkRenderItem，交给虚拟列表逐项渲染。
// 投影保持纯函数语义：相同 rows、visibility 与 options 必须产出完全相同的项与 key。
// 配对表与认领集合都是函数内局部状态，禁止提到模块作用域，否则二次调用会串数据。
//
// INV-01 输入 rows 的顺序即渲染顺序，投影不得重排或去重可见行；守住位置：buildAssistantWorkRenderItems 的主 while 推进；改错故障：流式输出时消息顺序跳动。
// INV-02 每个输入行最多被消费一次，已认领的 subagent 行不得二次渲染；守住位置：claimedSubagentRowIds 判断分支；改错故障：同一个子代理出现两个气泡、内容重复。
// INV-03 Agent 工具行与 subagent 行必须按 turnId 加 parentToolCallId 精确配对，禁止按出现位置配对；守住位置：pairSubagentRows 首轮扫描；改错故障：Agent 标题串到另一个子会话上。
// INV-04 只有缺少 parentToolCallId 的历史行才允许同 turn 唯一剩一对的兜底配对；守住位置：legacySubagentsByTurn 合并段；改错故障：并发 Agent 的工具行与子会话内容错乱。
// INV-05 分组 key 只能锚定首个真实 tool call，不得包含数量或末项；守住位置：三个 build 函数的 key 字段；改错故障：每次流式追加都重建组件并丢失展开状态。
// INV-06 分组 toolId 与 key 同源锚定首项，保证下游按 toolId 找回展开状态；守住位置：三个 build 函数的 node.toolCall.toolId；改错故障：父分组一刷新就自动折叠。
// INV-07 单个工具不得被包装成只有一个子项的分组；守住位置：三个分组分支的 groupRows.length === 1 回退；改错故障：用户看到多余的 Explore 或 Terminal 外壳。
// INV-08 父阶段状态表达的是阶段是否仍在进行，不是子工具状态的汇总；守住位置：resolveGroupStageStatus 与 buildChangesGroup 的 status；改错故障：子工具全部完成后父阶段仍转圈。
// INV-09 只有分组尾部正好落在 preparedRows 末尾时才允许 in_progress；守住位置：三处 stageTailIsRunning 与 index 比较；改错故障：早已结束的旧分组永远显示运行中。
// INV-10 分组内的行必须连续且同类，遇到 cuaGroup 或异类必须立即截断；守住位置：三个 while 循环的 break 条件；改错故障：不相干的工具被吞进同一个折叠块。
// INV-11 等待首条 command 的 Shell 行必须在配对与分组之前剔除；守住位置：shouldDeferUnclassifiedShellToolCall 过滤；改错故障：前一个阶段被误判为已结束、标题提前收起。
// INV-12 不可见的 reasoning 行同样必须在边界判断之前剔除；守住位置：visibleRows 的 reasoning 分支；改错故障：折叠思考内容后阶段边界错位。
// INV-13 过滤只作用于投影，不得回写或原地修改输入 rows；守住位置：visibleRows 使用 filter 复制；改错故障：同一份数据二次渲染时内容缺失。
// INV-14 投影必须幂等，重复调用不得累积状态或生成新 key；守住位置：全部 Map 与 Set 均为函数内局部变量；改错故障：React 严格模式双调用后视图出现重复项。
// INV-15 缺失 startedAt 时不得伪造时间戳，字段必须保持 undefined；守住位置：Explore 与 Execute 的 startedAt 类型判断；改错故障：时间线显示 1970 年或错误耗时。
// INV-16 缺失 parentToolCallId 的行必须降级到 legacy 通道而不是丢弃；守住位置：pairSubagentRows 的 legacySubagentRows 分支；改错故障：历史会话里的子代理内容整块消失。
// INV-17 分组身份只由 rowId 派生，不得引入数量或其他易变字段；守住位置：explore 与 execute 与 changes 三个前缀；改错故障：同一消息重渲染时 key 变化导致整块重挂载。
// INV-18 输出项的 key 在本次投影内必须全局唯一；守住位置：所有 items.push 的 key 表达式；改错故障：虚拟列表复用错节点、展开状态互相串。
// INV-19 分组 builder 只接受非空数组，禁止用伪造 identity 的兜底掩盖调用方错误；守住位置：firstRow 的非空断言；改错故障：空分组渲染出无标题的工具行。
// INV-20 投影复杂度必须保持 O(n)，不得为每一行重新扫描全量 rows；守住位置：index 单向前进的主循环；改错故障：长会话滚动时逐帧卡顿。
import type { SubagentRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import {
  isExecuteToolCall,
  isExploreToolCall,
  isShellToolCallAwaitingCommand,
} from "@/lib/exploreToolCall.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import {
  isConversationReasoningRowVisible,
  type ConversationReasoningVisibility,
} from "@/v4/conversationRowContext.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnRenderUnits.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import {
  ENABLE_CUA_TOOL_CALL_GROUPING,
  prepareCuaGroups,
  type ConversationCuaGroupRenderItem,
} from "@/v4/conversationCuaGroups.js";

// 渲染项的判别联合：每一项对应虚拟列表里的一个可复用槽位。
// kind 决定下游使用哪个渲染器，key 决定身份，二者都不是展示字段。
// 分组类变体刻意携带 rows 与 node 两份数据：rows 供分组内部再渲染，
// node 供仍沿用旧工具卡片的调用方，重复持有是为了兼容期不必再做一次适配。
// [权衡] 只保留 node 也能渲染，但按 rows 重新计算状态会多一次反查，流式期间每帧都要付这个成本。
export type ConversationAssistantWorkRenderItem =
  | {
      kind: "row";
      key: string;
      row: AssistantWorkRow;
    }
  | {
      kind: "exploreGroup";
      key: string;
      rowId: number;
      rows: ToolCallRow[];
      node: TaskChatToolCallTreeNode;
    }
  | ConversationCuaGroupRenderItem
  | {
      kind: "executeGroup";
      key: string;
      rowId: number;
      rows: ToolCallRow[];
      node: TaskChatToolCallTreeNode;
    }
  | {
      kind: "changesGroup";
      key: string;
      rowId: number;
      rows: ToolCallRow[];
      node: TaskChatToolCallTreeNode;
    }
  | {
      kind: "agentToolCall";
      key: string;
      row: ToolCallRow;
      subagentRow: SubagentRow;
    };

// 折叠能力分两档默认值：Explore 与 Terminal 默认开启，Changes 默认关闭。
// Changes 分组会吞掉逐文件的写入反馈，产品上尚未确认可接受，因此先留开关。
// [失败路径] 任一开关关闭时主循环必须退回 kind 为 row 的原始渲染，而不是只跳过构建函数。
export const ENABLE_EXPLORE_TOOL_CALL_GROUPING = true;
export { ENABLE_CUA_TOOL_CALL_GROUPING } from "@/v4/conversationCuaGroups.js";
export const ENABLE_TERMINAL_TOOL_CALL_GROUPING = true;
export const ENABLE_CHANGES_TOOL_CALL_GROUPING = false;

// 覆盖项全部可选，缺省含义是沿用模块级开关，而不是等价于 false。
// 这样调用方只想关掉某一类分组时，不必重复声明其余三类。
// 尾部状态由调用方显式传入，投影层自己不去猜当前是否还有内容在路上。
export interface ConversationAssistantWorkRenderOptions {
  stageTailIsRunning?: boolean;
  enableCuaGrouping?: boolean;
  enableExploreGrouping?: boolean;
  enableTerminalGrouping?: boolean;
  enableChangesGrouping?: boolean;
}

// 子代理工具名用白名单而不是前缀匹配，历史上同时存在 Agent 与 subagent 两种写法。
// [权衡] 改成包含匹配会把名字里带 agent 的普通工具误判成子代理，导致内容被折叠。
// 名单变更必须同步 pairSubagentRows 的两条分支，否则会退化成 legacy 兜底配对。
const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "subagent"]);

// 类型守卫只检查 kind，不校验 toolName 与 status，调用方据此可安全读取 toolCall 专有字段。
// 下面几个分类判定都先过这一层，缺了它后续读 legacyNode 会直接抛异常。
const isToolCallRow = (row: AssistantWorkRow): row is ToolCallRow => row.kind === "toolCall";

// Agent 行既是普通 toolCall，又要参与 subagent 配对，因此单独抽一层判定。
// 判定只看工具名，不看运行状态：已取消的 Agent 行仍须认领子会话，否则子会话会被重复渲染。
const isAgentToolCallRow = (row: AssistantWorkRow): row is ToolCallRow =>
  isToolCallRow(row) && SUBAGENT_TOOL_NAMES.has(row.toolName);

// 分类必须走 legacyNode 适配层，不能直接读 toolName，因为探索类工具的 kind 与 input 形态随版本变化。
// 适配层的异常由适配器自己兜底，本层不再包 try。
function isExploreToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) {
    return false;
  }
  const legacyNode = toolCallRowToLegacyNode(row);
  return isExploreToolCall({
    kind: legacyNode.toolCall.kind,
    input: legacyNode.toolCall.input,
  });
}

// Execute 与 Explore 的判定结构相同但语义互斥：前者是可写命令，后者只读检索。
// 两者共用同一份连续行聚合，靠 `groupKind` 把组类型与展示名分开。
function isExecuteToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) {
    return false;
  }
  const legacyNode = toolCallRowToLegacyNode(row);
  return isExecuteToolCall({
    kind: legacyNode.toolCall.kind,
    input: legacyNode.toolCall.input,
  });
}

// Changes 的判定不靠工具名，而靠工具身份解析出的 family，
// 因为写文件的工具有 Write 与 Edit 等多个名字但共享同一类 UI。
function isChangesToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) return false;
  return resolveToolCallIdentity(toolCallRowToLegacyNode(row).toolCall).family === "file-write";
}

// Shell 行拿到首条 command 之前只是占位，既不能分类也不能当作阶段边界。
// 只有 inputStreaming 与 running 两个状态值得延后，已完成或失败的行必须留在原位，
// 否则一次空命令执行的记录会被永久隐藏。
// [失败路径] 判定依赖 input 里的命令字段，字段缺失时视为仍在等待，交由下一帧重试。
function shouldDeferUnclassifiedShellToolCall(row: AssistantWorkRow): boolean {
  if (!isToolCallRow(row) || (row.status !== "inputStreaming" && row.status !== "running")) {
    return false;
  }
  const legacyNode = toolCallRowToLegacyNode(row);
  return isShellToolCallAwaitingCommand({
    kind: legacyNode.toolCall.kind,
    input: legacyNode.toolCall.input,
  });
}

// stageTailIsRunning 由调用方按“分组是否位于可见序列末尾”算好，这里不回看 rows 长度。
// [权衡] 让子工具状态参与汇总看起来更准确，但父阶段会在最后一条完成时提前收起，
// 而流式场景下紧接着还会到达子工具，视觉上会反复开合。
function resolveGroupStageStatus(
  rows: readonly ToolCallRow[],
  stageTailIsRunning: boolean,
): string {
  // Explore/Execute 父节点表达的是当前工作阶段，不是子工具执行状态的汇总。
  // 子工具可能已经全部完成，但只要当前运行工作段尚未出现下一条可见边界，父阶段仍在继续；
  // 反之，后续非当前分组内容已经出现时，即使迟到的子状态仍是 running，父阶段也必须结束。
  if (stageTailIsRunning) return "in_progress";
  return rows.some((row) => row.status === "cancelled") ? "stopped" : "completed";
}

// 前置契约：rows 非空、连续、且全部通过 Explore 判定，由调用方保证，builder 不再校验。
// toolCall.input 固定给空对象，因为父阶段不消费具体参数，填充它会让下游误以为可编辑。
// childToolCalls 保持模型输出顺序，不按时间戳重排，重排会打断流式追加的增量。
function buildExploreGroup(rows: ToolCallRow[], stageTailIsRunning: boolean) {
  // 分组 builder 只会在连续同类工具达到两项后调用；空数组不是合法状态，
  // 不再用伪造 identity 的兜底掩盖调用方错误。
  const firstRow = rows[0]!;
  const childToolCalls = rows.map(toolCallRowToLegacyNode);

  return {
    kind: "exploreGroup" as const,
    // 旧 key/toolId 包含末尾 row 和数量，每新增一个 Explore 子工具都会重建组件，
    // 并让 ToolLayout 用新的 toolId 读取不到用户刚保存的展开状态。聚合身份锚定首个子工具，
    // 后续只更新 children，保证流式增长期间 React identity 和展开状态 identity 都稳定。
    key: `explore:${firstRow.rowId}`,
    rowId: firstRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: `explore:${firstRow.toolCallId}`,
        toolName: "Explore",
        kind: "Explore",
        title: "Explore",
        input: {},
        status: resolveGroupStageStatus(rows, stageTailIsRunning),
        startedAt: typeof firstRow.startedAt === "number" ? firstRow.startedAt : undefined,
      },
      childToolCalls,
    },
  };
}

// 与 Explore 的唯一差别是组类型与展示名，其余字段保持同构，方便下游共用一套渲染。
// toolName 单独区分用于埋点与快捷键映射，不要与 kind 混用。
function buildExecuteGroup(rows: ToolCallRow[], stageTailIsRunning: boolean) {
  const firstRow = rows[0]!;
  return {
    kind: "executeGroup" as const,
    // 分组 identity 如果包含末项或数量，流式新增命令会重建父组件并丢失展开状态。
    // 与 Explore 一样锚定首个真实 tool call，后续只更新 children。
    key: `execute:${firstRow.rowId}`,
    rowId: firstRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: `execute:${firstRow.toolCallId}`,
        toolName: "ExecuteGroup",
        kind: "executeGroup",
        title: "Execute",
        input: {},
        status: resolveGroupStageStatus(rows, stageTailIsRunning),
        startedAt: typeof firstRow.startedAt === "number" ? firstRow.startedAt : undefined,
      },
      childToolCalls: rows.map(toolCallRowToLegacyNode),
    },
  };
}

// Changes 的 status 不走 resolveGroupStageStatus，因为它没有 cancelled 语义：
// 写入被取消时子项各自显示终态，父级只表达 `phase` 是否仍在可见序列尾部。
function buildChangesGroup(rows: ToolCallRow[], stageTailIsRunning: boolean) {
  const firstRow = rows[0]!;
  return {
    kind: "changesGroup" as const,
    // Changes 的展开状态必须在流式追加 Write/Edit 时保持稳定，因此身份锚定首个 tool。
    key: `changes:${firstRow.rowId}`,
    rowId: firstRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: `changes:${firstRow.toolCallId}`,
        toolName: "ChangesGroup",
        kind: "changesGroup",
        title: "Changes",
        input: {},
        // Changes 是 UI 阶段容器，不是真实工具；子项失败/取消只留在各自明细，
        // 父级仅表达当前阶段是否仍位于可见运行段尾部。
        status: stageTailIsRunning ? "in_progress" : "completed",
      },
      childToolCalls: rows.map(toolCallRowToLegacyNode),
    },
  };
}

/**
 * Agent 工具行 ↔ subagent 行必须按 parentToolCallId 精确配对。
 *
 * 同一轮并发 Agent 工具的 tool call 行按模型输出顺序出现，但 SubagentSpawned
 * 事件按异步调度顺序到达；旧 FIFO 会把一个 Agent 的标题与另一个 childSessionId 拼在一起。
 * 仅对缺少新字段的历史数据保留“同 turn 唯一剩余一对”的无歧义兼容。
 */
// 配对是本文件唯一的跨行状态推导，输出两张表供主循环做 O(1) 查询。
// 返回的 claimedSubagentRowIds 同时充当“已消费”标记，主循环据此跳过重复渲染。
// [并发] 同一 turn 内 Agent 工具的到达顺序与 SubagentSpawned 事件的到达顺序无关，
// 任何基于下标或先进先出的配对都会在并发场景下把标题和子会话错配。
function pairSubagentRows(rows: readonly AssistantWorkRow[]): {
  subagentByAgentToolRowId: Map<number, SubagentRow>;
  claimedSubagentRowIds: Set<number>;
} {
  const subagentByAgentToolRowId = new Map<number, SubagentRow>();
  const claimedSubagentRowIds = new Set<number>();
  const agentToolByTurnAndCallId = new Map<string, ToolCallRow>();
  const agentToolRows: ToolCallRow[] = [];
  const subagentRows: SubagentRow[] = [];
  const legacySubagentRows: SubagentRow[] = [];

  for (const row of rows) {
    if (isAgentToolCallRow(row)) {
      agentToolRows.push(row);
      agentToolByTurnAndCallId.set(`${row.turnId}\0${row.toolCallId}`, row);
    } else if (row.kind === "subagent") {
      subagentRows.push(row);
    }
  }
  for (const row of subagentRows) {
    // 缺 parentToolCallId 说明是旧版本写入的历史行，先收进 legacy 通道，等主配对结束后再尝试。
    // 不能在这里直接按 turn 配对，此时还分不清哪些工具行已被新字段占用。
    if (!row.parentToolCallId) {
      legacySubagentRows.push(row);
      continue;
    }
    const host = agentToolByTurnAndCallId.get(`${row.turnId}\0${row.parentToolCallId}`);
    // turnId 的二次比较不是冗余：键里虽已含 turnId，但跨 turn 复用的 toolCallId 仍可能撞上。
    // 已被占用的 host 直接跳过而不是覆盖，重复事件下先到者胜，保证结果与到达次数无关。
    if (host && host.turnId === row.turnId && !subagentByAgentToolRowId.has(host.rowId)) {
      subagentByAgentToolRowId.set(host.rowId, row);
      claimedSubagentRowIds.add(row.rowId);
    }
  }

  const remainingAgentToolsByTurn = new Map<string, ToolCallRow[]>();
  for (const row of agentToolRows) {
    if (subagentByAgentToolRowId.has(row.rowId)) continue;
    const turnRows = remainingAgentToolsByTurn.get(row.turnId);
    if (turnRows) {
      turnRows.push(row);
    } else {
      remainingAgentToolsByTurn.set(row.turnId, [row]);
    }
  }
  const legacySubagentsByTurn = new Map<string, SubagentRow[]>();
  for (const row of legacySubagentRows) {
    const turnRows = legacySubagentsByTurn.get(row.turnId);
    if (turnRows) {
      turnRows.push(row);
    } else {
      legacySubagentsByTurn.set(row.turnId, [row]);
    }
  }
  // 兜底条件必须同时满足工具行剩 1 个与 legacy 子会话剩 1 个，任一大于 1 都放弃配对。
  // [失败路径] 放弃配对不会丢数据：子会话行会以普通行身份继续渲染，宁可多渲染也不能吞内容。
  for (const [turnId, subagentRows] of legacySubagentsByTurn) {
    const toolRows = remainingAgentToolsByTurn.get(turnId);
    if (toolRows?.length !== 1 || subagentRows.length !== 1) continue;
    const host = toolRows[0];
    const subagent = subagentRows[0];
    if (!host || !subagent) continue;
    subagentByAgentToolRowId.set(host.rowId, subagent);
    claimedSubagentRowIds.add(subagent.rowId);
  }

  return { subagentByAgentToolRowId, claimedSubagentRowIds };
}

export function buildAssistantWorkRenderItems(
  rows: readonly AssistantWorkRow[],
  reasoningVisibility: ConversationReasoningVisibility,
  options?: ConversationAssistantWorkRenderOptions,
): ConversationAssistantWorkRenderItem[] {
  // items 是本次投影的唯一输出，key 一旦写入不再变更，调用方按 key 复用节点。
  // 主循环单向前进，任何回退都会让分组识别退化成二次复杂度。
  // [权衡] 把连续同类行收进一个项，牺牲了逐行独立的动画粒度，换来长会话下节点数可控。
  const items: ConversationAssistantWorkRenderItem[] = [];
  // 四个开关在入口一次性解析成局部常量，主循环内不再重复判空，避免热路径反复读 options。
  // 用空值合并而不是逻辑或：显式传入 false 必须能关掉分组，逻辑或会把它当成未设置。
  // 参数缺失与开关关闭走同一条回退路径，二者对渲染结果的影响必须一致。
  const enableExploreGrouping = options?.enableExploreGrouping ?? ENABLE_EXPLORE_TOOL_CALL_GROUPING;
  const enableCuaGrouping = options?.enableCuaGrouping ?? ENABLE_CUA_TOOL_CALL_GROUPING;
  const enableTerminalGrouping =
    options?.enableTerminalGrouping ?? ENABLE_TERMINAL_TOOL_CALL_GROUPING;
  const enableChangesGrouping = options?.enableChangesGrouping ?? ENABLE_CHANGES_TOOL_CALL_GROUPING;
  // Explore 的阶段边界和尾部状态必须基于用户实际可见的行序。等待 command 的 Shell
  // 若只在循环中跳过，仍会占据数组位置，导致前一个 Explore 被误判为已结束；
  // 隐藏 reasoning 也有相同问题。先统一剔除暂不可见行，再做配对、分组和尾部判断。
  const visibleRows = rows.filter((row) => {
    if (
      row.kind === "reasoning" &&
      !isConversationReasoningRowVisible(row.rowId, reasoningVisibility)
    ) {
      return false;
    }
    return !shouldDeferUnclassifiedShellToolCall(row);
  });
  // 配对基于可见行而不是原始 rows：被过滤掉的占位行不参与 Agent 与 subagent 的绑定。
  // 若改用原始 rows，一个尚未拿到命令的 Shell 会把位置信息带进配对表。
  const { subagentByAgentToolRowId, claimedSubagentRowIds } = pairSubagentRows(visibleRows);
  // CUA 分组在配对之后、主循环之前完成，保证下游看到的是同一份行集合的另一种视角。
  const preparedRows = prepareCuaGroups(
    visibleRows,
    enableCuaGrouping,
    options?.stageTailIsRunning === true,
  );
  let index = 0;

  // 主循环用 index 显式推进而不是 for 遍历，因为分组分支会一次性消费后续若干行。
  while (index < preparedRows.length) {
    const row = preparedRows[index];
    if (!row) {
      index += 1;
      continue;
    }

    if (row.kind === "cuaGroup") {
      items.push(row);
      index += 1;
      continue;
    }

    // 已配对进 Agent 块的 subagent 行：不再单独渲染。
    if (row.kind === "subagent" && claimedSubagentRowIds.has(row.rowId)) {
      index += 1;
      continue;
    }
    if (isToolCallRow(row)) {
      const pairedSubagent = subagentByAgentToolRowId.get(row.rowId);
      if (pairedSubagent) {
        items.push({
          kind: "agentToolCall",
          key: `agent:${row.rowId}`,
          row,
          subagentRow: pairedSubagent,
        });
        index += 1;
        continue;
      }
    }

    const isExploreRow = isExploreToolCallRow(row);
    // 非 Explore 行先试 Changes 与 Execute 两个分组分支，再退回普通行；顺序不能调换，
    // 因为一个工具可能同时满足两类判定，先命中的规则决定用户看到的组名。
    if (!isExploreRow) {
      if (enableChangesGrouping && isChangesToolCallRow(row)) {
        const groupRows: ToolCallRow[] = [row];
        index += 1;
        while (index < preparedRows.length) {
          const nextRow = preparedRows[index];
          if (!nextRow || nextRow.kind === "cuaGroup" || !isChangesToolCallRow(nextRow)) break;
          groupRows.push(nextRow);
          index += 1;
        }
        // 单个工具不需要额外的 UI 合成层；等第二个连续同类工具到达后再升级为父分组。
        if (groupRows.length === 1) {
          const singleRow = groupRows[0]!;
          items.push({ kind: "row", key: `row:${singleRow.rowId}`, row: singleRow });
          continue;
        }
        items.push(
          buildChangesGroup(
            groupRows,
            options?.stageTailIsRunning === true && index === preparedRows.length,
          ),
        );
        continue;
      }
      if (enableTerminalGrouping && isExecuteToolCallRow(row)) {
        const groupRows: ToolCallRow[] = [row];
        index += 1;
        while (index < preparedRows.length) {
          const nextRow = preparedRows[index];
          if (!nextRow || nextRow.kind === "cuaGroup" || !isExecuteToolCallRow(nextRow)) {
            break;
          }
          groupRows.push(nextRow);
          index += 1;
        }
        // 单个工具保留自身语义和渲染，避免只包含一个子项的 Terminal 容器。
        if (groupRows.length === 1) {
          const singleRow = groupRows[0]!;
          items.push({ kind: "row", key: `row:${singleRow.rowId}`, row: singleRow });
          continue;
        }
        items.push(
          buildExecuteGroup(
            groupRows,
            options?.stageTailIsRunning === true && index === preparedRows.length,
          ),
        );
        continue;
      }
      items.push({
        kind: "row",
        key: `row:${row.rowId}`,
        row,
      });
      index += 1;
      continue;
    }

    // 开关关闭时必须逐行输出，不能保留分组却把行内内容摊平，否则工具卡片会失去自己的状态区。
    // 这条回退在分类之前判断，因此关闭分组不影响行本身的分类判定。
    if (!enableExploreGrouping) {
      items.push({
        kind: "row",
        key: `row:${row.rowId}`,
        row,
      });
      index += 1;
      continue;
    }

    // 聚合循环的终止条件同时包含 cuaGroup 与异类行：CUA 分组已成型，不能再被吞进别的组。
    const groupRows: ToolCallRow[] = [row];
    index += 1;
    while (index < preparedRows.length) {
      const nextRow = preparedRows[index];
      if (!nextRow || nextRow.kind === "cuaGroup" || !isExploreToolCallRow(nextRow)) {
        break;
      }
      groupRows.push(nextRow);
      index += 1;
    }
    // Explore 只有在出现第二个连续只读工具后才成立；首项必须立即按原工具展示。
    // 单个 Explore 保持原工具卡片：合成父节点会把检索动作降级成一个无法展开的外壳。
    if (groupRows.length === 1) {
      items.push({ kind: "row", key: `row:${row.rowId}`, row });
      continue;
    }
    items.push(
      buildExploreGroup(
        groupRows,
        options?.stageTailIsRunning === true && index === preparedRows.length,
      ),
    );
  }

  return items;
}
