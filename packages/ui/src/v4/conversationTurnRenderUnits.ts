// INV-01 每个 turnId 恰好对应一个渲染单元，首个匹配行创建、后续行复用；守住位置：getOrCreateUnit 与 unitByTurnId；改错故障：同一轮出现重复卡片、滚动定位跳动
// INV-02 单元输出顺序严格等于输入行中 turnId 首次出现顺序；守住位置：units 入列与末尾统一映射；改错故障：对话时间线倒序或消息错位
// INV-03 turnHeader 只作为轮次边界写入 header，不进入 orderedRows；守住位置：isTurnHeaderRow 分支；改错故障：轮头行被当成工作内容渲染出来
// INV-04 用户输入、hook 调用、助手工作行各有独立分桶且同时保留在 orderedRows；守住位置：主循环三个 continue；改错故障：输入丢失或跨桶顺序重排
// INV-05 可见输入必须从 renderedRows 过滤得到，启动轮用户行需排除；守住位置：materializeDraftUnit 的 visibleUserInputs；改错故障：启动轮重复显示用户气泡
// INV-06 无可见内容的回合必须被 shouldKeepRenderUnit 丢弃；守住位置：keptUnits 过滤；改错故障：出现空白单元、虚拟列表高度异常
// INV-07 直接启动轮即使无可见输入与助手内容也必须保留；守住位置：workflowLaunch 分支；改错故障：run 卡消失、用户看不到启动中的任务
// INV-08 运行中的单元永不被空回合过滤掉；守住位置：shouldKeepRenderUnit 的 isRunning；改错故障：进行中的轮次整块从界面消失
// INV-09 空 reasoning 与 EnterPlanMode 工具行不得进入可见工作集合；守住位置：isVisibleAssistantWorkRow；改错故障：出现无意义工具调用与空行
// INV-10 轮尾 timelineMarker 与 artifact 后缀必须从 flow 中切出；守住位置：splitTurnTailRows；改错故障：最终答复被卷进已工作折叠区并默认展开
// INV-11 浏览器轮尾截图行必须单独抽出并从正文流剔除；守住位置：browserTurnEndRows 与 orderedBodyRows 过滤；改错故障：同一张截图渲染两次或顺序错乱
// INV-12 轻边界行只作为轮顶边界，不再计入 assistantWorkRows；守住位置：leadingBoundaryRows 与 bodyRows；改错故障：modelChange 标记混进工作段
// INV-13 只含时间线标记的单元不产生轻边界与轮尾拆分；守住位置：timelineOnly 三元分支；改错故障：纯标记轮被拆成空主体或丢标记
// INV-14 展开态以 turnHeader 为权威，缺失时才回退 sessionPhase；守住位置：resolveTurnRunning 与 shouldForceOpenAbnormalHistory；改错故障：中断或失败上下文被自动收起
// INV-15 后台工具与子代理运行不得把已终态主轮重新推成运行中；守住位置：isCompletionBlockingWorkRowRunning；改错故障：完成的轮次一直显示转圈
// INV-16 单元 key 必须只依赖协议稳定的 turnId；守住位置：createDraftUnit；改错故障：补页后节点重挂、丢失测高缓存与视口锚点
// INV-17 最终答复优先取带 canFork 或 canRetry 的助手正文；守住位置：actionAssistantTextRow 与 latestAssistantTextRow；改错故障：分叉与重试按钮挂到错误正文
// INV-18 工作段与 flowItems 必须由 buildConversationTurnWorkSegments 统一产出；守住位置：materializeDraftUnit 末段；改错故障：折叠边界与渲染内容不一致
// INV-19 renderRows 平面视图必须服从 CLI 行全序且已剔除边界与截图行；守住位置：visibleOrderedRows；改错故障：查找诊断命中重复或缺失行
//
// 本文件把协议行投影为渲染单元：分桶、过滤、折叠分段三步，全部在纯函数内部完成，不回写协议投影
// 唯一副作用是末尾的高速页脚标记，输入不变则输出稳定，便于虚拟列表复用与快照比对
// 改动时先定位出错的阶段：分桶看主循环，顺序看 units，折叠看 workSegments，不要跨阶段补兜底
import type {
  ConversationTurnRenderUnit,
  BuildConversationTurnRenderUnitsOptions,
} from "@/v4/conversationTurnRenderUnitTypes.js";
export type {
  ConversationTurnRenderUnit,
  BuildConversationTurnRenderUnitsOptions,
} from "@/v4/conversationTurnRenderUnitTypes.js";
import type {
  AssistantTextRow,
  ConversationRow,
  HookInvocationRow,
  SessionPhase,
  TimelineMarkerRow,
  TurnHeaderRow,
  UserInputRow,
// 协议行类型是唯一输入契约，所有分支都先把 ConversationRow 收窄再分桶
// [权衡] 新增行 kind 必须同步登记守卫，否则会静默落进 assistantWork 分桶
} from "@zcode/shared/zcode-protocol-v4";
import type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
import {
  isWorkflowLaunchUserInputRow,
  resolveWorkflowLaunchMeta,
} from "@/v4/workflowLaunchTurn.js";
import {
  buildConversationTurnWorkSegments,
  resolveConversationTurnWorkDurationMs,
  resolveConversationTurnWorkStatus,
} from "@/v4/conversationTurnWorkSegments.js";
// 高速页脚标记是整条链路的唯一副作用，单独收口以便主体保持纯函数
// 顺序不可提前，必须排在淘汰与归一之后，否则被丢弃的单元也会被打标
import { markHighspeedOutputFooterUnits } from "@/highspeed/highspeedOutputFooter.js";

export type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
export type {
  ConversationTurnWorkSegment,
  ConversationTurnWorkStatus,
} from "@/v4/conversationTurnWorkSegments.js";
export { resolveNextHighspeedExpiryMs } from "@/highspeed/highspeedConversationRows.js";

// Draft 是累加期结构：先按 turnId 收齐原始行，再一次性物化，避免边扫描边算状态
// header 允许缺省，冷快照尾窗会裁掉轮头，缺省时改走 session phase 兜底
// orderedRows 保留 CLI 全序，供跨分桶还原渲染顺序，不能只依赖三个分桶
interface DraftTurnRenderUnit {
  key: string;
  turnId: string;
  header?: TurnHeaderRow;
  userInputs: UserInputRow[];
  assistantWorkRows: AssistantWorkRow[];
  hookInvocations: HookInvocationRow[];
  orderedRows: ConversationRow[];
}

function isAssistantTextRow(row: ConversationRow): row is AssistantTextRow {
  return row.kind === "assistantText";
}

function isTurnHeaderRow(row: ConversationRow): row is TurnHeaderRow {
  return row.kind === "turnHeader";
}

function isUserInputRow(row: ConversationRow): row is UserInputRow {
  return row.kind === "userInput";
}

function isTimelineMarkerRow(row: ConversationRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker";
}

function isHookInvocationRow(row: ConversationRow): row is HookInvocationRow {
  return row.kind === "hookInvocation";
}

// 可见性只在渲染单元边界执行，不改协议投影，桌面连续与手机回放共用同一判定
// 空 reasoning 是流式收尾产物，completed 态同样会留下，必须在此裁掉
// [失败路径] 新增内部工具时忘记补排除，会泄露一条没有用户价值的工具调用
function isVisibleAssistantWorkRow(row: AssistantWorkRow): boolean {
  if (row.kind === "reasoning" && row.text.trim().length === 0) {
    // reasoning_start/reasoning_end 可能形成空的终态 block；只在共享
    // render-unit 边界裁掉它，避免 completed 状态绕过 streaming renderer 的空行过滤。
    return false;
  }
  // EnterPlanMode 只是内部模式切换边界，把它当普通工具放进“已工作”，
  // 会显示一条没有用户价值的“工具调用已执行”。只在 render unit 过滤，不改写协议投影，
  // 以保留 desktop continuous / web remote replayable 共用的运行态与恢复语义。
  return row.kind !== "toolCall" || row.toolName !== "EnterPlanMode";
}

function isVisibleConversationRow(row: ConversationRow): boolean {
  // 用户输入行恒可见，轮头与 hook 行在此判假，各自由专属字段承载
  if (isUserInputRow(row)) return true;
  if (isTurnHeaderRow(row)) return false;
  if (isHookInvocationRow(row)) return false;
  return isVisibleAssistantWorkRow(row);
}

// 落位语义（lane）由 CLI 投影裁决下发（UI 不得按 marker type 自行推断）。
// lane 缺省（不应发生）按 assistantWork 兜底——降级进折叠组，不丢行。
// 落位语义由 CLI 投影裁决下发，UI 不得按 marker 类型自行推断轮尾
// 缺省 lane 按 assistantWork 兜底，降级进折叠组也好过丢掉整行
function isTurnEndingTimelineMarkerRow(row: AssistantWorkRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker" && row.lane === "turnTailBoundary";
}

/**
 * artifact 行是分享投影追加到轮尾的产出物（insertDiscoveredArtifacts 插在该
 * productTurn 最后一行之后），但它同样属于 AssistantWorkRow，会成为 flow 的最后一行。
 * 于是折叠锚点的兜底条件「最后一行是 assistantText」失效——公开投影禁止 actions，
 * 分享页只有这条兜底——最终答复被卷进「已工作」并整轮默认展开。
 *
 * 它是追加的产出物、不属于对话流，按轮尾处理即可；与 browserTurnEndRows 摘轮尾截图同理。
 * 注意不能改成「取 flow 里最后一条 assistantText」：那会把 CUA 响应中途的正文
 * 提升成最终答复，拆散同一个 assistantResponseId 的分组。
 */
function isTurnTrailingArtifactRow(row: AssistantWorkRow): boolean {
  return row.kind === "artifact";
}

// 只从尾部连续后缀剥离轮尾标记与 artifact，遇到普通行立即停止
// [事务] 纯切片不改入参，flow 与 tail 拼回等于原数组，便于对照排查
// 若改成全量筛选，中间的轮尾标记会被搬到轮底，计划与工具顺序随之错乱
function splitTurnTailRows(rows: readonly AssistantWorkRow[]): {
  flowRows: AssistantWorkRow[];
  tailRows: AssistantWorkRow[];
} {
  let tailStart = rows.length;
  while (
    tailStart > 0 &&
    (isTurnEndingTimelineMarkerRow(rows[tailStart - 1]!) ||
      isTurnTrailingArtifactRow(rows[tailStart - 1]!))
  ) {
    tailStart -= 1;
  }
  return {
    flowRows: rows.slice(0, tailStart),
    tailRows: rows.slice(tailStart),
  };
}

// 自动截图以完成态工具行落在最终正文之后，只能按 display 来源识别
// 识别结果同时用于轮尾展示与正文剔除，两处同源才不会重复渲染
// [失败路径] 来源字段改名会让截图重新混入折叠区而彻底不可见
function isBrowserTurnEndRow(row: AssistantWorkRow): boolean {
  // 自动截图以完成态 tool row 持久化在最终正文之后，旧分组只把
  // timeline boundary 识别为轮尾，导致截图被搬进上方“已工作”折叠区而不可见。
  return (
    row.kind === "toolCall" &&
    row.display?.kind === "node_repl_images" &&
    row.display.source === "browser_turn_end"
  );
}

// 轻边界仅认 lane 为 lightBoundary 的标记，lane 缺省时归入工作流而非轮顶
function isLightBoundaryMarkerRow(row: AssistantWorkRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker" && row.lane === "lightBoundary";
}

// 只有前台流式行与前台运行中的工具、子代理才阻塞主轮完成
// [并发] backgrounded 为真的行算后台任务，不参与主轮运行态判定
// 时间线标记读取 marker 上的 running 状态，缺 status 视为不阻塞
function isCompletionBlockingWorkRowRunning(row: AssistantWorkRow): boolean {
  switch (row.kind) {
    case "assistantText":
    case "reasoning":
      return row.state === "streaming";
    case "toolCall":
      return (
        row.backgrounded !== true &&
        (row.status === "inputStreaming" ||
          row.status === "pendingApproval" ||
          row.status === "running")
      );
    case "subagent":
      return row.backgrounded !== true && row.status === "running";
    case "timelineMarker":
      return "status" in row.marker && row.marker.status === "running";
    default:
      return false;
  }
}

// 轮头存在时它就是权威边界，controlOnly 轮恒判为非运行
// 轮头缺失时终态 session phase 优先，避免孤立的运行行把冷快照推成思考中
// 最后那层兜底只服务缺少轮头的旧投影，新调用方不应依赖
function resolveTurnRunning(
  draft: DraftTurnRenderUnit,
  options: BuildConversationTurnRenderUnitsOptions,
): boolean {
  if (draft.header) {
    if (draft.header.executionKind === "controlOnly") return false;
    // turnHeader 是 projection 的权威轮次边界；已终态主轮不能被
    // 同轮仍在运行的 background tool/subagent 行重新推成 running。
    return draft.header.state === "running";
  }
  if (
    options.sessionPhase === "completedSuccess" ||
    options.sessionPhase === "completedInterrupted" ||
    options.sessionPhase === "error"
  ) {
    // cold snapshot 只保留尾窗时可能裁掉 turnHeader；旧 fallback 会把
    // 孤立的 inputStreaming/running tool row 重新推成 thinking，终态 control 必须优先。
    return false;
  }
  // 仅兼容缺少 turnHeader 的旧投影；background-only work 不阻塞主轮完成。
  return draft.assistantWorkRows.some(isCompletionBlockingWorkRowRunning);
}

function shouldForceOpenAbnormalHistory(
  header: TurnHeaderRow | undefined,
  sessionPhase: SessionPhase | undefined,
): boolean {
  if (header) {
    return header.state === "completedInterrupted" || header.state === "failed";
  }
  return sessionPhase === "completedInterrupted" || sessionPhase === "error";
}

function materializeDraftUnit(
  draft: DraftTurnRenderUnit,
  index: number,
  total: number,
  options: BuildConversationTurnRenderUnitsOptions,
): ConversationTurnRenderUnit {
  const workflowLaunch = resolveWorkflowLaunchMeta(draft.header, draft.userInputs);
  // 启动轮的用户行由 run 卡代言，不进可见输入也不进流。
  const renderedRows =
    workflowLaunch === undefined
      ? draft.orderedRows
      : draft.orderedRows.filter((row) => !isWorkflowLaunchUserInputRow(row));
  const visibleUserInputs = renderedRows.filter(isUserInputRow);
  const visibleAssistantWorkRows = draft.assistantWorkRows.filter(isVisibleAssistantWorkRow);
  const visibleOrderedRows = renderedRows.filter(isVisibleConversationRow);
  // 只有标记、没有可见输入与正文的单元是纯时间线轮，折叠与边界规则整体降级
  // 该判定同时决定轻边界是否抽出、轮尾是否切分、工作段是否重建
  // [资源] 纯标记轮通常极短，跳过工作段生成可省下一批分段开销
  const timelineOnly =
    visibleUserInputs.length === 0 &&
    visibleAssistantWorkRows.length > 0 &&
    visibleAssistantWorkRows.every(isTimelineMarkerRow);

  // modelChange 是轮顶轻边界，渲染在 user 输入之前，不进工作流。
  const leadingBoundaryRows = timelineOnly
    ? []
    : visibleAssistantWorkRows.filter(isLightBoundaryMarkerRow);
  const leadingBoundaryRowIds = new Set(leadingBoundaryRows.map((row) => row.rowId));
  const bodyRows = timelineOnly
    ? visibleAssistantWorkRows
    : visibleAssistantWorkRows.filter((row) => !isLightBoundaryMarkerRow(row));
  // Browser 自动截图要越过 file diff 摘要成为最后内容块，因此先单独抽取；
  // 其余 row 仍按 CLI 全序处理，只有连续的真实轮尾 marker 后缀可从 flow 拆出。
  const browserTurnEndRows: AssistantWorkRow[] = [];
  const nonBrowserRows: AssistantWorkRow[] = [];
  if (!timelineOnly) {
    for (const row of bodyRows) {
      if (isBrowserTurnEndRow(row)) {
        browserTurnEndRows.push(row);
      } else {
        nonBrowserRows.push(row);
      }
    }
  }
  // 不能用 filter 抽取所有 turnTailBoundary，并把 ExitPlanMode 也强行归入 tail，
  // 会把计划和中间 marker 从原 tool row 搬到轮底。其余 row 必须留在 flow 中。
  // 非纯标记轮才做轮尾切分，纯标记轮两段均为空，主体全留在 bodyRows
  // 解构命名区分助手侧 tail 与单元级 tail，避免同名概念互相混淆
  const { flowRows, tailRows: assistantTailRows } = timelineOnly
    ? { flowRows: [], tailRows: [] }
    : splitTurnTailRows(nonBrowserRows);

  const isLastTurn = index === total - 1;
  const isRunning = resolveTurnRunning(draft, options);
  const isInterrupted = draft.header
    ? draft.header.state === "completedInterrupted"
    : options.sessionPhase === "completedInterrupted";
  // 旧展开规则只看 running 和最终正文，异常终态一旦保留 partial assistant text
  // 就会被当作正常完成而收起，隐藏中断/失败上下文。终态必须以 header 为权威；冷恢复
  // 尾窗缺 header 时才回退 session phase，desktop continuous 与 mobile replayable 共用此边界。
  const forceOpenHistory = shouldForceOpenAbnormalHistory(draft.header, options.sessionPhase);

  // product turn 的最终正文仍是唯一 action target；视觉工作段只改变折叠边界。
  const assistantTextRows = flowRows.filter(isAssistantTextRow);
  const actionAssistantTextRow = assistantTextRows.find(
    (row) => row.actions?.canFork === true || row.actions?.canRetry === true,
  );
  const lastFlowRow = flowRows.at(-1);
  // 带分叉或重试动作的正文优先成为最终答复，它是唯一的动作挂载点
  // 非运行态且末行恰为助手文本才回退到末行，运行中提升中途正文会拆散同组
  // [权衡] 不回退搜索整段 flow，否则 CUA 中途正文会被误判为最终答复
  const latestAssistantTextRow =
    actionAssistantTextRow ??
    (!isRunning && lastFlowRow && isAssistantTextRow(lastFlowRow) ? lastFlowRow : undefined);
  const workDurationMs = resolveConversationTurnWorkDurationMs(draft.header, options, isRunning);
  const workStatus = resolveConversationTurnWorkStatus(
    draft.header,
    bodyRows,
    isRunning,
    workDurationMs,
    isInterrupted,
  );
  // 预先构建 rowId 集合，后续剔除按 O(1) 查找，避免过滤回调内反复线性扫描
  const browserTurnEndRowIds = new Set(browserTurnEndRows.map((row) => row.rowId));
  const orderedBodyRows = visibleOrderedRows.filter(
    // main 的 workSegments 会从 orderedRows 重建 flow；如果这里只从
    // bodyRows 抽取截图，它仍会被塞回正文流并在轮尾再次渲染，造成重复和顺序错乱。
    (row) => !leadingBoundaryRowIds.has(row.rowId) && !browserTurnEndRowIds.has(row.rowId),
  );
  // 折叠分段整体外置，本文件只负责准备有序主体行、尾行与运行态输入
  // orderedBodyRows 已剔除轻边界与截图行，避免重建时把截图塞回正文造成重复
  // [事务] 分段结果不可二次改写，后续仅读取其 flow 与历史行
  const workSegments = buildConversationTurnWorkSegments({
    key: draft.key,
    header: draft.header,
    orderedRows: orderedBodyRows,
    assistantTailRows,
    latestAssistantTextRow,
    isRunning,
    isLastTurn,
    isInterrupted,
    forceOpenHistory,
    timelineOnly,
    nowMs: options.nowMs,
    ...(options.pluginUiPinResolver ? { pluginUiPinResolver: options.pluginUiPinResolver } : {}),
  });
  const orderedAssistantHistoryRows = workSegments.flatMap(
    (segment) => segment.assistantHistoryRows,
  );
  const assistantFollowingRows = workSegments.flatMap((segment) => segment.assistantFollowingRows);
  const flowItems = workSegments.flatMap((segment) => segment.flowItems);
  const mustOpenHistory = workSegments.at(-1)?.assistantHistoryDefaultOpen ?? false;
  return {
    key: draft.key,
    turnId: draft.turnId,
    ...(draft.header ? { header: draft.header } : {}),
    visibleUserInputs,
    // 轻边界已经由 leadingBoundaryRows 独立承载，不能再算作 assistant work。
    assistantWorkRows: bodyRows,
    assistantHistoryRows: orderedAssistantHistoryRows,
    assistantFollowingRows,
    assistantTailRows,
    browserTurnEndRows,
    hookInvocations: draft.hookInvocations,
    assistantTextRows,
    leadingBoundaryRows,
    ...(latestAssistantTextRow ? { latestAssistantTextRow } : {}),
    flowItems,
    workSegments,
    // renderRows 是查找/诊断用的平面视图，也必须服从 CLI row 全序。
    renderRows: visibleOrderedRows,
    isLastTurn,
    isRunning,
    assistantHistoryDefaultOpen: mustOpenHistory,
    timelineOnly,
    ...(workStatus ? { workStatus } : {}),
    ...(draft.header ? { startedAt: draft.header.startedAt } : {}),
    ...(workflowLaunch ? { workflowLaunch } : {}),
  };
}

function createDraftUnit(turnId: string): DraftTurnRenderUnit {
  return {
    // cold snapshot 可能从同一 turn 的 assistant/tool 行中间截断，补到
    // turnHeader 后首个可见 rowId 会变化。虚拟列表 key 必须只依赖协议稳定的 turnId，
    // 否则补页会把原 turn 当成新节点重挂，丢失测高缓存和视口锚点。
    key: turnId,
    turnId,
    userInputs: [],
    assistantWorkRows: [],
    hookInvocations: [],
    orderedRows: [],
  };
}

// [失败路径] 过滤过严会吞掉正在运行的轮，过松会留下空白节点
// 可见输入、工作行、真正执行过的 hook、轻边界、启动轮任一存在即保留
// hook 只有实际执行过才算内容，空调用不应撑起一个可见单元
function shouldKeepRenderUnit(unit: ConversationTurnRenderUnit): boolean {
  // 隐形行清零后（投影不再产不可渲染 marker），任何工作行都可渲染；
  // 「哪些 marker 可渲染」不再是 UI 的判断。
  return (
    unit.visibleUserInputs.length > 0 ||
    unit.assistantWorkRows.length > 0 ||
    unit.hookInvocations.some((row) => row.executions.some((execution) => execution.didExecute)) ||
    unit.leadingBoundaryRows.length > 0 ||
    // 直接启动轮：用户行不可见、无助手内容，轮由 run 卡呈现——它当然要留下。
    unit.workflowLaunch !== undefined ||
    unit.isRunning
  );
}

// 位置字段在过滤之后重算，末轮判定以保留后的长度为准
// 无字段变化时直接复用原对象，减少虚拟列表的无谓重渲染
function normalizeRenderUnitPosition(
  unit: ConversationTurnRenderUnit,
  index: number,
  total: number,
  options: BuildConversationTurnRenderUnitsOptions,
): ConversationTurnRenderUnit {
  const isLastTurn = index === total - 1;
  const forceOpenHistory = shouldForceOpenAbnormalHistory(unit.header, options.sessionPhase);
  const assistantHistoryDefaultOpen =
    unit.workSegments && unit.workSegments.length > 0
      ? !unit.timelineOnly &&
        (forceOpenHistory ||
          (isLastTurn && unit.workSegments.at(-1)?.workStatus?.state === "running") ||
          (unit.workSegments.length === 1 &&
            unit.latestAssistantTextRow === undefined &&
            unit.assistantWorkRows.length > 0))
      : !unit.timelineOnly &&
        (forceOpenHistory ||
          (isLastTurn && unit.workStatus?.state === "running") ||
          (unit.latestAssistantTextRow === undefined && unit.assistantWorkRows.length > 0));
  const workSegments = unit.workSegments?.map((segment, segmentIndex, segments) =>
    segmentIndex === segments.length - 1
      ? {
          ...segment,
          assistantHistoryDefaultOpen:
            !unit.timelineOnly &&
            (forceOpenHistory ||
              (isLastTurn && segment.workStatus?.state === "running") ||
              (segments.length === 1 &&
                unit.latestAssistantTextRow === undefined &&
                segment.assistantWorkRows.length > 0)),
        }
      : segment,
  );
  if (
    unit.isLastTurn === isLastTurn &&
    unit.assistantHistoryDefaultOpen === assistantHistoryDefaultOpen &&
    workSegments?.at(-1)?.assistantHistoryDefaultOpen ===
      unit.workSegments?.at(-1)?.assistantHistoryDefaultOpen
  ) {
    return unit;
  }
  return {
    ...unit,
    isLastTurn,
    assistantHistoryDefaultOpen,
    ...(workSegments ? { workSegments } : {}),
  };
}

// 入口只做三件事：按 turnId 分桶、物化并淘汰、按新位置归一
// 输出顺序等于 turnId 首次出现顺序，也等于输入顺序，全程不做重排
// [事务] 不修改入参 rows，调用方可安全复用同一份快照
export function buildConversationTurnRenderUnits(
  rows: readonly ConversationRow[],
  options: BuildConversationTurnRenderUnitsOptions = {},
): ConversationTurnRenderUnit[] {
  const units: DraftTurnRenderUnit[] = [];
  const unitByTurnId = new Map<string, DraftTurnRenderUnit>();

  const getOrCreateUnit = (turnId: string) => {
    const existing = unitByTurnId.get(turnId);
    if (existing) {
      return existing;
    }
    const unit = createDraftUnit(turnId);
    units.push(unit);
    unitByTurnId.set(turnId, unit);
    return unit;
  };

  for (const row of rows) {
    const unit = getOrCreateUnit(row.turnId);
    if (isTurnHeaderRow(row)) {
      unit.header = row;
      continue;
    }
    unit.orderedRows.push(row);
    if (isUserInputRow(row)) {
      unit.userInputs.push(row);
      continue;
    }
    if (isHookInvocationRow(row)) {
      unit.hookInvocations.push(row);
      continue;
    }
    unit.assistantWorkRows.push(row);
  }

  const materializedUnits = units.map((unit, index) =>
    materializeDraftUnit(unit, index, units.length, options),
  );
  // 过滤后总长会缩短，末轮索引与展开默认值必须按保留结果重新计算
  const keptUnits = materializedUnits.filter(shouldKeepRenderUnit);
  const normalizedUnits = keptUnits.map((unit, index) =>
    normalizeRenderUnitPosition(unit, index, keptUnits.length, options),
  );
  // 时间基准优先取调用方注入的 nowMs，缺省才读当前时刻，便于快照稳定
  // 这是导出链的最后一步，此前的计算保持纯函数，方便比对与单测
  return markHighspeedOutputFooterUnits(normalizedUnits, options.nowMs ?? Date.now());
}
