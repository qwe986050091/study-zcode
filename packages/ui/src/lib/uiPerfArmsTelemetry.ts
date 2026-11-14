// ==========================================================================
// 文件头不变量表（uiPerfArmsTelemetry.ts，ui_perf 埋点唯一出口；共 18 条）：
// INV-01 未注入 reporter 即视为采样关闭，emit 必须在字段归一与上报之前返回；守住位置：emit 首行的 armsReporter 判空；改错故障：未启用埋点的构建仍走 ARMS 通道，启动期多出序列化与网络开销。
// INV-02 reporter 是模块级单例，只能经 setUiPerfArmsReporter 注入或置空；守住位置：armsReporter 变量与 setter；改错故障：多处各持一份 reporter，窗口重载后事件仍发往已销毁的通道。
// INV-03 上报失败必须完全内部消化，emit 不得向调用方抛异常或返回 rejected Promise；守住位置：emit 的 try/catch 与 catch 回调；改错故障：ARMS 断网瞬断时发送与渲染主流程被连带中断。
// INV-04 同步抛错与异步拒绝必须走同一兜底，emit 用 Promise.resolve 包住返回值；守住位置：void Promise.resolve(...).catch；改错故障：通道同步抛错逃逸到 UI 调用栈，输入框卡死。
// INV-05 model 字段只在本文件唯一出口归一，各 report 函数不得自行处理；守住位置：sanitizeModelProperty 与 emit 的 properties 覆盖；改错故障：新增事件漏脱敏，自定义 provider 的模型名原文外泄。
// INV-06 归一后模型名为空串时必须落成 undefined 而不是空串；守住位置：sanitizeModelProperty 的 model || undefined；改错故障：看板多出一个空字符串维度，与缺失维度分裂成两组。
// INV-07 事件名与分组必须成对出现，group 恒为 ui_perf；守住位置：每个 emit 调用的 group 字段与 UI_PERF_ARMS_GROUP；改错故障：事件落进别的分组，按 ui_perf 过滤后整批事件消失。
// INV-08 启动链路七条事件必须共享同一 properties 对象，一次启动只发一批；守住位置：reportUiLaunchToInput 的 properties 与 stages 循环；改错故障：各段无法按启动实例拼接，分段与总时长对不上。
// INV-09 六段之和必须恒等于 total，任一段为负即整批丢弃；守住位置：negativeStage 判定；改错故障：看板分段之和与总时长不等，团队据此误判某段优化收益。
// INV-10 total 必须落在 [0, 300000] 内，否则整批丢弃；守住位置：reportUiLaunchToInput 的首个哨兵；改错故障：休眠唤醒后的数十分钟被计入分布，p99 被单点污染。
// INV-11 所有上报数值经取整后必须为非负整数，取整统一四舍五入；守住位置：clampMs 与各 report 的 Math.round；改错故障：小数进时序聚合，均值与分位数被拉偏。
// INV-12 可选字段无效时必须省略（undefined），不得用 0 或空串占位；守住位置：optionalRoundedNumber；改错故障：未发生的等待被记成 0ms，成功率与耗时分布同时失真。
// INV-13 tool_call_detail 的 value 按 totalMs、commandRunMs、fsWriteMs、fsReadMs、0 顺序取首个有效值；守住位置：reportUiToolCallDetail 的 ?? 链；改错故障：把 0 当缺失继续回退，真实零耗时被替换成别的阶段时长。
// INV-14 exit_code 必须保留符号，负值代表被信号终止，不得钳到 0；守住位置：exit_code 的三元表达式；改错故障：崩溃退出与成功退出在看板上无法区分。
// INV-15 流式停顿以 per-task 上一个 chunk 时刻为基线，首个 chunk 只建基线不上报；守住位置：recordStreamChunkArrival 的 last 判空分支；改错故障：每轮对话开头必报一条假停顿。
// INV-16 停顿判定为严格大于阈值，等于阈值不上报；守住位置：gapMs 的早返回；改错故障：阈值附近的正常抖动产出大量噪声事件，抬高上报量与成本。
// INV-17 停顿基线必须由 clearStreamStallTracking 与测试钩子回收，不得依赖进程退出；守住位置：lastChunkAtByTask 的 delete 与 clear；改错故障：长会话按 taskId 累积，渲染进程内存单调上涨。
// INV-18 输入卡顿必须先排除程序化改写与 IME 组合态，再判阈值；守住位置：shouldReportInputLag；改错故障：粘贴长文与中文输入被记成打字卡顿，指标失去指导意义。
import {
  sanitizeTelemetryModelValue,
  type ArmsCustomEventPayload,
  type IPlatformService,
  type LaunchMarks,
} from "@zcode/shared";
import { logger } from "@/logger.js";

export const UI_PERF_ARMS_GROUP = "ui_perf";

export const UI_PERF_EVENT_LAUNCH_TO_INPUT = "perf_ui_launch_to_input";
export const UI_PERF_EVENT_LAUNCH_ELECTRON_INIT = "perf_ui_launch_electron_init_ms";
export const UI_PERF_EVENT_LAUNCH_APP_READY = "perf_ui_launch_app_ready_ms";
export const UI_PERF_EVENT_LAUNCH_WINDOW = "perf_ui_launch_window_ms";
export const UI_PERF_EVENT_LAUNCH_RENDERER_LOAD = "perf_ui_launch_renderer_load_ms";
export const UI_PERF_EVENT_LAUNCH_REACT_COMMIT = "perf_ui_launch_react_commit_ms";
export const UI_PERF_EVENT_LAUNCH_STARTUP_GATE = "perf_ui_launch_startup_gate_ms";

// 总时长超过该值视为时钟异常/挂起，整批丢弃，避免污染分布。
export const LAUNCH_TO_INPUT_SANITY_MAX_MS = 300000;

export const UI_PERF_EVENT_FIRST_TOKEN = "perf_ui_first_token";
export const UI_PERF_EVENT_MESSAGE_COMPLETE = "perf_ui_message_complete";
export const UI_PERF_EVENT_TURN_BREAKDOWN = "perf_ui_turn_breakdown";
export const UI_PERF_EVENT_TOOL_CALL_DETAIL = "perf_ui_tool_call_detail";
export const UI_PERF_EVENT_STREAM_STALL = "perf_ui_stream_stall";

// 超过该间隔(ms)未收到新 chunk 视为停顿并上报;value 仍为真实间隔。可据线上分布收紧。
// 工具调用(tool_call/tool_call_update)期间不计入:工具事件会 clearStreamStallTracking,
// 工具后第一个正文 chunk 视为首个,不与工具前的 chunk 比较,避免把工具执行误判为停顿。
export const STREAM_STALL_REPORT_THRESHOLD_MS = 3000;

type ArmsReporter = Pick<IPlatformService, "reportArmsCustomEvent">;

// [并发] armsReporter 是模块级可变单例，只在注入时整体替换，不存在局部修改。
// UI 侧读写发生在同一 JS 线程，无需加锁；但必须在调用前读一次并复用，避免上报途中被置空。
// 初值 null 是有语义的状态：未注入即采样关闭，emit 在归一与上报之前就返回。
// [资源] 置空只走 clearUiPerfArmsReporterForTest，它在清空 reporter 的同时清空停顿基线，避免测例互相污染。
// 生产路径重新注入 reporter 不会清 Map：停顿基线沿用上一个 reporter 的时刻，属预期行为。
// 不要把 reporter 改成逐层透传的参数：每个 report 函数都要扩签名，且新调用点容易忘记传。
// 也不要在 emit 里按需查找平台服务：启动期高频事件会被放大成多次服务定位。
// 改错故障：改为全局可变对象并在上报中重新读取，切换瞬间一半事件发往旧通道。
let armsReporter: ArmsReporter | null = null;

export function setUiPerfArmsReporter(reporter: ArmsReporter | null): void {
  armsReporter = reporter;
}

export function clearUiPerfArmsReporterForTest(): void {
  armsReporter = null;
  lastChunkAtByTask.clear();
}

/**
 * `model` 在本组事件里来自 `detail.model_name`，自定义 provider 下是用户命名的编码值。
 * 在唯一出口统一归一，避免每个 report 函数各自处理后漏掉新增事件；归一只影响上报值，
 * 不改变调用方拿到的模型选择和本地日志。
 */
function sanitizeModelProperty(
  properties: ArmsCustomEventPayload["properties"],
): ArmsCustomEventPayload["properties"] {
  if (!properties || typeof properties.model !== "string") {
    return properties;
  }
  const model = sanitizeTelemetryModelValue(properties.model);
  return { ...properties, model: model || undefined };
}

// 原因:ARMS 属观测链路,UI 主流程(启动/发送/渲染)不得因埋点失败而中断。
function emit(payload: ArmsCustomEventPayload): void {
  if (!armsReporter) {
    return;
  }
  const sanitized: ArmsCustomEventPayload = {
    ...payload,
    properties: sanitizeModelProperty(payload.properties),
  };
  try {
    void Promise.resolve(armsReporter.reportArmsCustomEvent(sanitized)).catch((error) => {
      logger.warn("[ui-perf] ARMS 上报失败", { name: payload.name, error });
    });
  } catch (error) {
    logger.warn("[ui-perf] ARMS 上报异常", { name: payload.name, error });
  }
}

interface LaunchToInputTimings {
  marks: LaunchMarks;
  /** renderer/src/main.tsx 模块顶部 Date.now()（T4） */
  rendererStart: number;
  /** zcode-react-startup-ready 触发时 Date.now()（T5） */
  reactCommit: number;
  /** 启动门禁清除、输入框可用时 Date.now()（T6） */
  inputReady: number;
  /** 同一次启动的关联键 */
  sessionId: string;
}

// 取整统一用四舍五入而非截断：截断会让每个阶段系统性偏小，六段相加后与 total 的偏差被放大。
// max(0,...) 只是保险：负段在调用点已被整批丢弃，这里不承担校验职责。
// [权衡] 不在此处做上限钳制：上限属于哨兵职责，混进来会把异常值悄悄改成合法值，看板看不出被截断。
// 返回 number 而不是可空：启动链路的 value 是必填聚合字段，缺值事件进不了分位统计。
// 该函数只服务启动七条事件；其它 report 各自 Math.round，口径相同但不能互相替代。
// [失败路径] 入参为 NaN 时结果仍是 NaN：Math.max 不吸收 NaN，只能依赖上游 marks 由真实时钟写入。
// 用 Math.round 而不是 toFixed：后者产出字符串，ARMS 会把它当维度而非数值聚合。
// 改错故障：改成截断后六段之和可能小于 total，恒等式告警，分段占比看板失真。
function clampMs(ms: number): number {
  return Math.max(0, Math.round(ms));
}

// [权衡] 无效值返回 undefined 而不是 0：ARMS 丢弃 undefined 属性，聚合端才能区分没发生与耗时 0。
// 负数一律视为缺失：跨进程偏移可能让某段为负，落成 0 等于伪造一次瞬时完成。
// 非有限值（NaN 与 Infinity）同样按缺失处理，避免序列化后变成 null 造成维度分裂。
// 只用于可空字段；value 字段必须走 clampMs，不能被省略成空。
// 不在这里统一处理 exit_code：它允许负值表达信号终止，走单独的三元表达式。
// 取整同样用 Math.round，与 value 字段保持同一精度，否则同一事件里出现两种口径。
// [资源] 纯函数无分配，可对十余个字段逐个调用而不构成热点。
// 改错故障：改成缺失即补 0 后，未触发的等待被计入耗时分布，成功率与均值同时虚高。
function optionalRoundedNumber(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.round(value);
  return rounded >= 0 ? rounded : undefined;
}

export function reportUiLaunchToInput(timings: LaunchToInputTimings): void {
  const { marks, rendererStart, reactCommit, inputReady, sessionId } = timings;
  // [并发] total 是跨进程差值：createdAt 来自主进程，inputReady 来自渲染进程，只能比差值，绝不能比绝对时刻。
  // rendererStart、reactCommit、inputReady 三点必须在同一次启动内采样，跨启动混用会算出负段或超长段。
  // stageMs 一次性算完再校验，避免边算边发导致前半批已上报、后半批被丢弃。
  // 先算 total 再进哨兵，是因为 total 是六段的参照基准，单独看某段无法判断是否存在跨进程偏移。
  // 丢弃路径只写 warn 日志，不重试、不补发补偿事件，避免异常场景在上报侧自我放大。
  // [权衡] 不用 performance.now 统一时钟：两个进程 timeOrigin 不同，跨进程差值反而更不可比。
  // [失败路径] marks 字段缺失时差值为 NaN，两个哨兵都不命中，NaN 会一路带到 value，依赖上游保证。
  // 改错故障：改成上报时再取时刻，跨进程延迟被计入最后一段，T6 系统性偏大。
  const total = inputReady - marks.createdAt;
  // 6 段原始时长(未钳)。在发送前全部算出,以便整批校验。
  const stageMs = {
    electronInit: marks.mainStart - marks.createdAt,
    appReady: marks.appReady - marks.mainStart,
    window: marks.loadUrl - marks.appReady,
    rendererLoad: rendererStart - marks.loadUrl,
    reactCommit: reactCommit - rendererStart,
    startupGate: inputReady - reactCommit,
  };
  // 哨兵:异常总时长(时钟跳变/进程挂起)整批丢弃。
  if (total < 0 || total > LAUNCH_TO_INPUT_SANITY_MAX_MS) {
    logger.warn("[ui-perf] launch_to_input 总时长异常,丢弃", { total });
    return;
  }
  // 任一段为负(主进程 T0–T3 与渲染进程 T4–T6 间跨进程时钟偏移)则整批丢弃,
  // 否则 sum(6 段) != total,破坏看板依赖的恒等式。与总时长哨兵保持全有或全无。
  const negativeStage = Object.entries(stageMs).find(([, ms]) => ms < 0);
  if (negativeStage) {
    logger.warn("[ui-perf] launch_to_input 某段为负(跨进程时钟偏移/回拨),整批丢弃", {
      stage: negativeStage[0],
      ms: negativeStage[1],
    });
    return;
  }
  // [事务] 同一个 properties 对象被七条事件共享，靠 session_id 把一次启动还原成一批。
  // 共享而不复制是安全的：emit 只做展开生成新对象，无 model 字段时归一原样返回，全程不写该对象。
  // 七条事件顺序固定：先总时长、再按 T0 到 T6 分段，消费端可据此推断阶段语义。
  // [权衡] 不合并成一条带七个属性的宽事件：合并会让按事件名建的看板全部失效，且属性数易超限。
  // stages 数组在循环外构造，条数与顺序可数；新增阶段必须同时补常量与这里。
  // properties 不放阶段名：阶段名已由事件名承载，重复放会制造两套口径。
  // [失败路径] sessionId 为空时按空串上报，事件仍发出，只失去关联能力，不能因此中断整批。
  // 改错故障：改成循环内重新构造 properties，七条事件拿到不同对象，后续补字段极易漏改一条。
  const properties = { session_id: sessionId };
  // 至此各段保证 >= 0,clampMs 的 max(0,...) 为冗余保险,仅用于一致的 Math.round 取整。
  const stages: { name: string; ms: number }[] = [
    { name: UI_PERF_EVENT_LAUNCH_TO_INPUT, ms: total },
    { name: UI_PERF_EVENT_LAUNCH_ELECTRON_INIT, ms: stageMs.electronInit },
    { name: UI_PERF_EVENT_LAUNCH_APP_READY, ms: stageMs.appReady },
    { name: UI_PERF_EVENT_LAUNCH_WINDOW, ms: stageMs.window },
    { name: UI_PERF_EVENT_LAUNCH_RENDERER_LOAD, ms: stageMs.rendererLoad },
    { name: UI_PERF_EVENT_LAUNCH_REACT_COMMIT, ms: stageMs.reactCommit },
    { name: UI_PERF_EVENT_LAUNCH_STARTUP_GATE, ms: stageMs.startupGate },
  ];
  for (const stage of stages) {
    emit({
      name: stage.name,
      group: UI_PERF_ARMS_GROUP,
      value: clampMs(stage.ms),
      properties,
    });
  }
}

export function reportUiFirstToken(params: {
  ttftMs: number;
  model?: string;
  talkId?: string;
  messageId?: string;
}): void {
  emit({
    name: UI_PERF_EVENT_FIRST_TOKEN,
    group: UI_PERF_ARMS_GROUP,
    value: Math.max(0, Math.round(params.ttftMs)),
    properties: {
      model: params.model,
      talk_id: params.talkId,
      message_id: params.messageId,
    },
  });
}

export function reportUiMessageComplete(params: {
  durationMs: number;
  result: string;
  model?: string;
  talkId?: string;
  messageId?: string;
}): void {
  emit({
    name: UI_PERF_EVENT_MESSAGE_COMPLETE,
    group: UI_PERF_ARMS_GROUP,
    value: Math.max(0, Math.round(params.durationMs)),
    properties: {
      result: params.result,
      model: params.model,
      talk_id: params.talkId,
      message_id: params.messageId,
    },
  });
}

export function reportUiTurnBreakdown(params: {
  durationMs: number;
  result: string;
  model?: string;
  talkId?: string;
  messageId?: string;
  ttftMs?: number;
  waitingMs?: number;
  toolCallTotal?: number;
  toolCallFailed?: number;
  agentStepCount?: number;
  retryCount?: number;
  fileChangeCount?: number;
  generatedCodeLines?: number;
}): void {
  const durationMs = Math.max(0, Math.round(params.durationMs));
  emit({
    name: UI_PERF_EVENT_TURN_BREAKDOWN,
    group: UI_PERF_ARMS_GROUP,
    value: durationMs,
    properties: {
      result: params.result,
      model: params.model,
      talk_id: params.talkId,
      message_id: params.messageId,
      duration_ms: durationMs,
      ttft_ms: optionalRoundedNumber(params.ttftMs),
      waiting_ms: optionalRoundedNumber(params.waitingMs),
      tool_call_total: optionalRoundedNumber(params.toolCallTotal),
      tool_call_failed: optionalRoundedNumber(params.toolCallFailed),
      agent_step_cnt: optionalRoundedNumber(params.agentStepCount),
      retry_cnt: optionalRoundedNumber(params.retryCount),
      file_change_cnt: optionalRoundedNumber(params.fileChangeCount),
      generated_code_lines: optionalRoundedNumber(params.generatedCodeLines),
    },
  });
}

export function reportUiToolCallDetail(params: {
  toolName?: string;
  status: string;
  talkId?: string;
  messageId?: string;
  toolCallId?: string;
  parentToolCallId?: string;
  childToolCallId?: string;
  childSessionId?: string;
  agentId?: string;
  agentType?: string;
  totalMs?: number;
  permissionWaitMs?: number;
  commandRunMs?: number;
  firstOutputMs?: number;
  noOutputMs?: number;
  exitCode?: number;
  timedOut?: boolean;
  outputBytes?: number;
  commandCategory?: string;
  commandName?: string;
  commandCount?: number;
  commandStatus?: string;
  fsReadMs?: number;
  fsWriteMs?: number;
  patchMatchMs?: number;
  fileCount?: number;
  totalBytes?: number;
  maxFileBytes?: number;
  hunkCount?: number;
  matchAttempts?: number;
  workspaceKind?: string;
}): void {
  // value 的回退链按最贴近工具实际执行的顺序排序：总耗时优先，其次命令执行、写盘、读盘。
  // [权衡] 用 ?? 而不是逻辑或：0 是合法耗时，逻辑或会跳过后面的阶段，把真实零耗时替换成别的数。
  // 全部缺失时取 0 而不是 undefined：value 是必填聚合字段，缺 value 的事件无法进分位统计。
  // 回退只影响 value；属性里各阶段字段仍独立上报，二者不互相替代。
  // total_ms 与 value 可能相等，这是有意的冗余，便于直接按 value 排序同时保留属性口径。
  // tool_name、status 等字符串字段不裁剪，长度由调用方保证，避免此处引入第二套截断口径。
  // 改错故障：把回退顺序改成写盘优先，读写混合工具的分类耗时整体错位。
  const totalMs = optionalRoundedNumber(params.totalMs);
  const value =
    totalMs ??
    optionalRoundedNumber(params.commandRunMs) ??
    optionalRoundedNumber(params.fsWriteMs) ??
    optionalRoundedNumber(params.fsReadMs) ??
    0;
  emit({
    name: UI_PERF_EVENT_TOOL_CALL_DETAIL,
    group: UI_PERF_ARMS_GROUP,
    value,
    properties: {
      tool_name: params.toolName,
      status: params.status,
      talk_id: params.talkId,
      message_id: params.messageId,
      tool_call_id: params.toolCallId,
      parent_tool_call_id: params.parentToolCallId,
      child_tool_call_id: params.childToolCallId,
      child_session_id: params.childSessionId,
      agent_id: params.agentId,
      agent_type: params.agentType,
      total_ms: totalMs,
      permission_wait_ms: optionalRoundedNumber(params.permissionWaitMs),
      command_run_ms: optionalRoundedNumber(params.commandRunMs),
      first_output_ms: optionalRoundedNumber(params.firstOutputMs),
      no_output_ms: optionalRoundedNumber(params.noOutputMs),
      exit_code:
        typeof params.exitCode === "number" && Number.isFinite(params.exitCode)
          ? Math.round(params.exitCode)
          : undefined,
      timed_out: params.timedOut,
      output_bytes: optionalRoundedNumber(params.outputBytes),
      command_category: params.commandCategory,
      command_name: params.commandName,
      command_count: optionalRoundedNumber(params.commandCount),
      command_status: params.commandStatus,
      fs_read_ms: optionalRoundedNumber(params.fsReadMs),
      fs_write_ms: optionalRoundedNumber(params.fsWriteMs),
      patch_match_ms: optionalRoundedNumber(params.patchMatchMs),
      file_count: optionalRoundedNumber(params.fileCount),
      total_bytes: optionalRoundedNumber(params.totalBytes),
      max_file_bytes: optionalRoundedNumber(params.maxFileBytes),
      hunk_count: optionalRoundedNumber(params.hunkCount),
      match_attempts: optionalRoundedNumber(params.matchAttempts),
      workspace_kind: params.workspaceKind,
    },
  });
}

// 流式停顿:per-task 记录上一个正文 chunk 到达时刻,间隔超阈值则上报真实间隔。
const lastChunkAtByTask = new Map<string, number>();

export function recordStreamChunkArrival(
  taskId: string,
  options?: {
    waitingTool?: boolean;
    /** tracker 可用 workspace-scoped 内部 key；上报仍保持真实 talk_id。 */
    talkId?: string;
    messageId?: string;
    model?: string;
    chunkType?: "message" | "thought" | "unknown";
    now?: number;
  },
): void {
  // [并发] lastChunkAtByTask 是单线程 Map，按 taskId 分区，同一 taskId 的读写天然串行。
  // now 可注入是为了测例确定性：线上恒走 Date.now，测例给固定时刻即可构造间隔。
  // 基线先写后判：无论是否上报，本 chunk 时刻都要成为下一次的基线，否则同一次停顿会被重复计算。
  // 首个 chunk（last 为 undefined）只建基线不上报，否则每个新任务都会产生一条假停顿。
  // [失败路径] 时钟回拨时 gapMs 为负，被小于等于阈值的早返回吞掉；基线却已改写成更早时刻，下一段间隔可能虚高误报。
  // [资源] 基线不会自动过期：任务结束必须调用 clearStreamStallTracking，否则该 taskId 条目常驻。
  // 改错故障：把 set 挪到上报之后，被丢弃的停顿会用旧基线重算，同一次停顿连报多次。
  const now = options?.now ?? Date.now();
  const last = lastChunkAtByTask.get(taskId);
  lastChunkAtByTask.set(taskId, now);
  if (last === undefined) {
    return;
  }
  const gapMs = now - last;
  if (gapMs <= STREAM_STALL_REPORT_THRESHOLD_MS) {
    return;
  }
  emit({
    name: UI_PERF_EVENT_STREAM_STALL,
    group: UI_PERF_ARMS_GROUP,
    value: Math.round(gapMs),
    properties: {
      stall_ms: Math.round(gapMs),
      waiting_tool: options?.waitingTool ?? false,
      model: options?.model,
      chunk_type: options?.chunkType,
      talk_id: options?.talkId ?? taskId,
      // 停顿结束时那个 chunk 的 messageId;正文/思考 chunk 常不带,取不到留空(与其它字段口径一致)。
      message_id: options?.messageId,
    },
  });
}

export function clearStreamStallTracking(taskId: string): void {
  lastChunkAtByTask.delete(taskId);
}

// 输入框卡顿:在 Lexical update listener 内测「单次输入处理耗时」(getEditorMarkdown+onChange 同步段)。
// 与 stream_stall(输出侧)区分:此为输入侧。只上报超阈卡点,事件量最小。
export const UI_PERF_EVENT_INPUT_LAG = "perf_ui_input_lag";

// 保守起点:只抓最严重卡顿。可据线上分布往下收紧。
export const INPUT_LAG_REPORT_THRESHOLD_MS = 500;
// 超此值大概率是断点调试/标签页挂起/设备休眠唤醒,丢弃避免污染分布。
export const INPUT_LAG_SANITY_MAX_MS = 5000;

// 判定抽成纯函数便于单测:程序化改写(粘贴/setText/mention/历史回填)与 IME 组合态
// 都不算打字卡顿,即使耗时超阈也跳过。
export function shouldReportInputLag(args: {
  lagMs: number;
  isProgrammatic: boolean;
  isComposing: boolean;
}): boolean {
  if (args.isProgrammatic || args.isComposing) {
    return false;
  }
  return args.lagMs > INPUT_LAG_REPORT_THRESHOLD_MS && args.lagMs <= INPUT_LAG_SANITY_MAX_MS;
}

export function recordInputLag(params: {
  lagMs: number;
  textLength: number;
  isProgrammatic: boolean;
  isComposing: boolean;
  taskId?: string;
}): void {
  if (
    !shouldReportInputLag({
      lagMs: params.lagMs,
      isProgrammatic: params.isProgrammatic,
      isComposing: params.isComposing,
    })
  ) {
    return;
  }
  // 取整发生在阈值判定之后：500.4ms 能过严格大于 500 的判定，却以 500 上报，边界样本与口径差 1ms。
  // [权衡] 不把取整提前进 shouldReportInputLag：判定保持纯函数、只吃原始毫秒，单测不必关心舍入。
  // 上报值同时写进 value 与 lag_ms，二者必须同源，否则按值排序与按属性过滤得到不同集合。
  // text_length 直接透传不截断：它是定位卡顿规模的关键信号，截断会掩盖超长文本。
  // [资源] 命中即发单条事件，无队列无聚合：卡顿本身低频，不值得为稀疏事件维护缓冲区。
  // taskId 可空（草稿态无任务），空值按缺失上报，不回落成随机 id。
  // 改错故障：把取整挪到判定前，500.4 会被判为不超阈整条丢弃，边界卡顿从此不可见。
  const lagMs = Math.round(params.lagMs);
  emit({
    name: UI_PERF_EVENT_INPUT_LAG,
    group: UI_PERF_ARMS_GROUP,
    value: lagMs,
    properties: {
      lag_ms: lagMs,
      text_length: params.textLength,
      // 草稿态无 taskId,留空与其它 ui_perf 事件口径一致。
      task_id: params.taskId,
    },
  });
}
