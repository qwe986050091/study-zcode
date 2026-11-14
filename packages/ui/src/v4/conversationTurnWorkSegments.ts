// INV-01 守住位置：resolveConversationTurnWorkStatus 首行的 controlOnly 早退判定。改错故障：纯控制轮渲染出工作状态条，时间与折叠区一起冒出来。
// INV-02 守住位置：hasWork 对 agent 与非 agent 采用不同阈值。改错故障：agent 瞬时失败轮丢掉状态条，普通空跑轮却长出 0 秒工作条。
// INV-03 守住位置：durationMs 仅在已定义时用条件展开写入返回对象。改错故障：键始终存在，agent 的空时长被下游当成干过活。
// INV-04 守住位置：resolveConversationTurnWorkDurationMs 中 activeMs 的优先短路。改错故障：本地时钟差覆盖 CLI 记账，运行中工时不刷新而完成后跳变。
// INV-05 守住位置：endedAt 差值必须以 max 夹到 0 以上。改错故障：时钟回拨时负时长传入 UI，格式化出负秒或 NaN。
// INV-06 守住位置：nowMs 分支之前那道 isRunning 条件。改错故障：历史轮继续吃当前时钟，已工作秒数随时间无限增长。
// INV-07 守住位置：splitVisualWorkSegments 内的 guided 判定与当前段非空前置。改错故障：首个引导行切出空段，折叠区出现无内容的第 0 段。
// INV-08 守住位置：引导行在新段复位之后才进入有序行数组。改错故障：触发本轮的用户输入落在上一段，新段缺少 triggerRow。
// INV-09 守住位置：segmentKey 的三级兜底 entityId、rowId、段下标。改错故障：key 退化成 undefined 字符串，多段共用一键导致渲染串段。
// INV-10 守住位置：tailRowIds 由 assistantTailRows 一次性建集合后参与分流。改错故障：流式尾行同时出现在折叠历史与尾部，正文重复。
// INV-11 守住位置：segmentRunning 与中断标记都限定在最后一个段。改错故障：历史段被标成运行中或已中断，状态条常亮不灭。
// INV-12 守住位置：visibleAssistantTextRow 的两级回退。改错故障：末行是工具行时被当成可见答复，历史被切成两片。
// INV-13 守住位置：历史取可见下标之前、跟随取之后、可见行单独传递。改错故障：同一条助手文本在折叠区与可见区各渲染一次。
// INV-14 守住位置：timelineOnly 为真时历史切片直接取空数组。改错故障：分享只读时间线默认折叠过程，接收方看不到工具细节。
// INV-15 守住位置：历史切片之后的 isPluginUiPinnedToolRow 过滤。改错故障：插件卡片被收进折叠区，钉住语义失效。
// INV-16 守住位置：assistantHistoryDefaultOpen 的三段或条件。改错故障：单段纯过程轮默认折叠成空壳，用户看不到任何进展。
// INV-17 守住位置：workSegments 先按 triggerEntityId 匹配再按段下标回退。改错故障：旧 CLI 数据段错位，工时长到相邻段头上。
// INV-18 守住位置：旧快照边界取 triggerRow 与 nextTriggerRow 的 createdAt。改错故障：刷新后各段工时塌回整轮工时，段间不再可分。
//
// 模块职责：把一轮对话的原始行切成工作段，派生状态、工时、折叠历史与跟随区，产出可直接渲染的段描述。
// 状态所有权：全部为纯派生，输入是 header、行集合与运行标志，本模块不写 store、不发请求、不持有定时器。
// 阅读顺序：先读两个 resolve 系列定状态与工时口径，再看切段，最后读 build 的装配与折叠裁决。
import type {
  AssistantTextRow,
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  ENABLE_CUA_TOOL_CALL_GROUPING,
  prepareCuaGroupFlowItems,
} from "@/v4/conversationCuaGroups.js";
// Bugfix：必须直接引用纯函数模块，不能走 `@/plugin-ui/index.js` 桶文件。本文件在分享只读
// 时间线闭包里，桶文件会把 plugin-ui 全量组件 → V4ConversationContext → @zcode/services →
// @zcode/provider 拖进 web-share 构建，导致 `@zcode/shared/mcp-apps` 等子路径无法解析、构建失败。
import {
  isPluginUiPinnedToolRow,
  type PluginUiRowPinResolver,
} from "@/plugin-ui/domain/pluginUiRowPolicy.js";
import { buildConversationFlowItems } from "@/v4/conversationTurnFlowItems.js";
import type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";

export interface ConversationTurnWorkStatus {
  state: "running" | "completed" | "interrupted";
  durationMs?: number;
}

export interface ConversationTurnWorkSegment {
  key: string;
  triggerRow?: UserInputRow;
  flowItems: ConversationTurnFlowItem[];
  assistantWorkRows: AssistantWorkRow[];
  assistantHistoryRows: AssistantWorkRow[];
  assistantFollowingRows: AssistantWorkRow[];
  assistantHistoryDefaultOpen: boolean;
  workStatus?: ConversationTurnWorkStatus;
}

// 工作状态是纯派生量，不落盘也不缓存，每次渲染都从 header 与行集合重算。
// 三态优先级为运行中压过中断与完成，中断只可能出现在整轮结束且未成功的最后一刻。
// 返回 undefined 表示这一轮没有可展示的工作块，调用方据此整段不渲染，而不是渲染 0 秒。
// durationMs 用条件展开而非显式 undefined，键的存在性本身被下游当作工作量证据。
export function resolveConversationTurnWorkStatus(
  header: TurnHeaderRow | undefined,
  workRows: readonly AssistantWorkRow[],
  isRunning: boolean,
  durationMs: number | undefined,
  isInterrupted = false,
): ConversationTurnWorkStatus | undefined {
  if (header?.executionKind === "controlOnly") return undefined;
  // agent 轮只问 durationMs 是否给出，哪怕为 0 也算工作过：agent 可能瞬间失败但仍需露出状态条。
  // 非 agent 轮必须严格大于 0 秒，否则 controlOnly 之外的空跑 turn 会长出 0 秒工作条。
  // isRunning 短路在最前，运行中即使尚无任何行也立即呈现工作状态。
  // hasWork 为假时返回 undefined 而不是 completed，防止历史空轮被当成已完成工时。
  // 该判定同时服务整轮与单段两处调用，条件不能只按其中一处场景收紧。
  const hasWork =
    isRunning ||
    workRows.length > 0 ||
    (header?.executionKind === "agent" ? durationMs !== undefined : (durationMs ?? 0) > 0);
  if (!hasWork) return undefined;
  return {
    state: isRunning ? "running" : isInterrupted ? "interrupted" : "completed",
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

// 时长解析按 activeMs、endedAt 差值、运行中时钟的次序短路，先命中者胜出。
// activeMs 由 CLI 记账，优先于任何本地时间差，避免前端时钟与后端记账打架。
// endedAt 差值取 max 保底，容忍 startedAt 晚于 endedAt 的时钟回拨。
// nowMs 只在 isRunning 时参与，历史轮缺字段时宁可 undefined 也不吃当前时钟。
// header 缺失直接返回 undefined，调用方不能假设必有工时可用。
export function resolveConversationTurnWorkDurationMs(
  header: TurnHeaderRow | undefined,
  options: { nowMs?: number },
  isRunning: boolean,
): number | undefined {
  if (!header) return undefined;
  if (header.activeMs !== undefined) return header.activeMs;
  if (header.endedAt !== undefined) return Math.max(header.endedAt - header.startedAt, 0);
  // UI 每秒传入 nowMs 只用于运行中“工作中 N 秒”；完成态缺少
  // activeMs/endedAt 时不能继续吃当前时钟，否则历史“已工作”会随时间增长。
  if (isRunning && options.nowMs !== undefined) {
    return Math.max(options.nowMs - header.startedAt, 0);
  }
  return undefined;
}

interface DraftVisualWorkSegment {
  orderedRows: ConversationRow[];
  triggerRow?: UserInputRow;
}

function isUserInputRow(row: ConversationRow): row is UserInputRow {
  return row.kind === "userInput";
}

function isAssistantTextRow(row: ConversationRow): row is AssistantTextRow {
  return row.kind === "assistantText";
}

function isAssistantWorkRow(row: ConversationRow): row is AssistantWorkRow {
  return row.kind !== "turnHeader" && row.kind !== "userInput";
}

// 切段只看 guided 的用户输入行，且当前段必须已有内容，否则首个引导行会切出空段。
// 引导行本身归入新段：它是该段的用户意图来源，triggerRow 因此只在新段上有值。
// 段 0 没有 triggerRow，其 key 直接复用外部传入的整轮 key，保证首段键稳定。
// 非 guided 的用户输入不切段，同一段内可以夹着多轮普通追问。
// 末尾残余段在循环外补推，空输入集合返回空数组而非一个空段。
function splitVisualWorkSegments(rows: readonly ConversationRow[]): DraftVisualWorkSegment[] {
  const segments: DraftVisualWorkSegment[] = [];
  let current: DraftVisualWorkSegment = { orderedRows: [] };
  for (const row of rows) {
    if (isUserInputRow(row) && row.guided === true && current.orderedRows.length > 0) {
      segments.push(current);
      current = { orderedRows: [], triggerRow: row };
    }
    current.orderedRows.push(row);
  }
  if (current.orderedRows.length > 0) segments.push(current);
  return segments;
}

// 段工时先按 triggerRow 的 entityId 精确匹配 workSegments，匹配不到才退回段下标。
// 下标兜底安全的唯一前提是段顺序与行顺序一致，切段逻辑一旦重排就会错挂工时。
// 单段轮直接委托整轮时长解析，让非引导场景与旧行为逐字节一致。
// 旧快照缺 workSegments 时才用相邻引导行的 createdAt 作段边界，新数据不走这条路径。
// 边界缺失但段仍在跑时退化为起点到 nowMs，其余情况返回 undefined 让上层隐藏工时。
function resolveSegmentDurationMs(options: {
  header?: TurnHeaderRow;
  segmentIndex: number;
  triggerRow?: UserInputRow;
  nextTriggerRow?: UserInputRow;
  segmentRunning: boolean;
  segmentCount: number;
  nowMs?: number;
}): number | undefined {
  const fact =
    (options.triggerRow?.entityId
      ? options.header?.workSegments?.find(
          (candidate) => candidate.triggerEntityId === options.triggerRow?.entityId,
        )
      : undefined) ?? options.header?.workSegments?.[options.segmentIndex];
  if (fact?.activeMs !== undefined) return fact.activeMs;
  if (fact?.endedAt !== undefined) return Math.max(0, fact.endedAt - fact.startedAt);
  if (fact && options.segmentRunning && options.nowMs !== undefined) {
    return Math.max(0, options.nowMs - fact.startedAt);
  }
  if (options.segmentCount === 1) {
    return resolveConversationTurnWorkDurationMs(
      options.header,
      { nowMs: options.nowMs },
      options.segmentRunning,
    );
  }
  // 兼容旧 guide snapshot：新 CLI 会下发 workSegments；仅旧数据缺事实时才按
  // guided row 的稳定时间边界恢复，避免刷新后又退回整个 turn 的单一工时。
  const startedAt = options.triggerRow?.createdAt ?? options.header?.startedAt;
  const endedAt = options.nextTriggerRow?.createdAt ?? options.header?.endedAt;
  if (startedAt !== undefined && endedAt !== undefined) return Math.max(0, endedAt - startedAt);
  if (startedAt !== undefined && options.segmentRunning && options.nowMs !== undefined) {
    return Math.max(0, options.nowMs - startedAt);
  }
  return undefined;
}

export function buildConversationTurnWorkSegments(options: {
  key: string;
  header?: TurnHeaderRow;
  orderedRows: readonly ConversationRow[];
  assistantTailRows: readonly AssistantWorkRow[];
  latestAssistantTextRow?: AssistantTextRow;
  isRunning: boolean;
  isLastTurn: boolean;
  isInterrupted: boolean;
  forceOpenHistory: boolean;
  timelineOnly: boolean;
  nowMs?: number;
  /** 插件卡片进不进折叠区的裁决；缺省沿用"全部常驻"。 */
  pluginUiPinResolver?: PluginUiRowPinResolver;
}): ConversationTurnWorkSegment[] {
  const visualDrafts = splitVisualWorkSegments(options.orderedRows);
  const tailRowIds = new Set(options.assistantTailRows.map((row) => row.rowId));
  return visualDrafts.map((segment, segmentIndex) => {
    const segmentAssistantRows = segment.orderedRows.filter(isAssistantWorkRow);
    const segmentTailRows = segmentAssistantRows.filter((row) => tailRowIds.has(row.rowId));
    const segmentFlowRows = segmentAssistantRows.filter((row) => !tailRowIds.has(row.rowId));
    const lastSegmentFlowRow = segmentFlowRows.at(-1);
    const segmentCompleted = segmentIndex < visualDrafts.length - 1 || !options.isRunning;
    const productLatestAssistantTextRow = options.latestAssistantTextRow
      ? segmentFlowRows.find((row) => row.rowId === options.latestAssistantTextRow?.rowId)
      : undefined;
    const visibleAssistantTextRow =
      productLatestAssistantTextRow && isAssistantTextRow(productLatestAssistantTextRow)
        ? productLatestAssistantTextRow
        : segmentCompleted && lastSegmentFlowRow && isAssistantTextRow(lastSegmentFlowRow)
          ? lastSegmentFlowRow
          : undefined;
    // 可见助手文本是本段唯一切分点：它之前的行进折叠历史，之后的行进入跟随区。
    // 可见行本身不落在两侧任一片里，它被单独作为 visibleAssistantTextRow 传给流项构建。
    // 下标为 -1 表示本段没有可见答复，此时全部过程行归历史，跟随区为空。
    // 用 rowId 反查而不是对象引用，因为上游可能重建行对象却保持同一行标识。
    const visibleAssistantIndex = visibleAssistantTextRow
      ? segmentFlowRows.findIndex((row) => row.rowId === visibleAssistantTextRow.rowId)
      : -1;
    // 插件 UI 工具行留在折叠区外（与 assistantText 同级），过程行照常折叠；见 isPluginUiPinnedToolRow。
    // 折叠历史的边界只由可见下标决定，时间线模式直接清空历史、不做折叠。
    // 插件钉住的工具行从历史中剔除，它们要和可见答复同级常驻，不能被收进折叠区。
    // 剔除发生在切片之后，因此跟随区里的钉住行不受影响，仍按原顺序展示。
    // 被剔除的行不回填到 `segmentFollowingRows`，两片合计可能少于流程行总数：这是刻意让位。
    // 这里产出的是行原序子集，流项构建阶段不得再排序，否则工具行与文本的先后会错乱。
    const segmentHistoryRows = (
      options.timelineOnly
        ? []
        : visibleAssistantIndex < 0
          ? segmentFlowRows
          : segmentFlowRows.slice(0, visibleAssistantIndex)
    ).filter((row) => !isPluginUiPinnedToolRow(row, options.pluginUiPinResolver));
    const segmentFollowingRows =
      visibleAssistantIndex < 0 ? [] : segmentFlowRows.slice(visibleAssistantIndex + 1);
    const segmentRunning = segmentIndex === visualDrafts.length - 1 && options.isRunning;
    const segmentDurationMs = resolveSegmentDurationMs({
      header: options.header,
      segmentIndex,
      triggerRow: segment.triggerRow,
      nextTriggerRow: visualDrafts[segmentIndex + 1]?.triggerRow,
      segmentRunning,
      segmentCount: visualDrafts.length,
      nowMs: options.nowMs,
    });
    const segmentWorkStatus = resolveConversationTurnWorkStatus(
      options.header,
      segmentFlowRows,
      segmentRunning,
      segmentDurationMs,
      options.isInterrupted && segmentIndex === visualDrafts.length - 1,
    );
    // 段 key 必须在其生命周期内不变：首段用整轮 key，后续段由引导实体 id 派生。
    // 实体 id 缺失时退到 rowId，再退到段下标，三级兜底保证 key 永不为空串。
    // key 变化会让 React 卸载重建折叠区，历史展开状态与滚动位置随之丢失。
    // 后缀带 guide 前缀用于区分整轮 key，避免与首段或其他轮次撞键。
    const segmentKey =
      segmentIndex === 0
        ? options.key
        : `${options.key}:guide:${segment.triggerRow?.entityId ?? segment.triggerRow?.rowId ?? segmentIndex}`;
    const flowItems = buildConversationFlowItems({
      orderedRows: segment.orderedRows,
      assistantHistoryRows: segmentHistoryRows,
      assistantFollowingRows: segmentFollowingRows,
      assistantTailRows: segmentTailRows,
      ...(visibleAssistantTextRow ? { visibleAssistantTextRow } : {}),
      ...(options.latestAssistantTextRow
        ? { latestAssistantTextRow: options.latestAssistantTextRow }
        : {}),
      timelineOnly: options.timelineOnly,
    });
    return {
      key: segmentKey,
      ...(segment.triggerRow ? { triggerRow: segment.triggerRow } : {}),
      flowItems: prepareCuaGroupFlowItems(flowItems, {
        enabled: ENABLE_CUA_TOOL_CALL_GROUPING,
        stageTailIsRunning: segmentRunning,
      }),
      assistantWorkRows: segmentAssistantRows,
      assistantHistoryRows: segmentHistoryRows,
      assistantFollowingRows: segmentFollowingRows,
      assistantHistoryDefaultOpen:
        !options.timelineOnly &&
        (options.forceOpenHistory ||
          (options.isLastTurn && segmentWorkStatus?.state === "running") ||
          (visualDrafts.length === 1 &&
            visibleAssistantTextRow === undefined &&
            segmentFlowRows.length > 0)),
      ...(segmentWorkStatus ? { workStatus: segmentWorkStatus } : {}),
    };
  });
}
