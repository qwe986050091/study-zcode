// SessionEvent payload → ConversationRow 的构造纯函数。
// row 自包含原则：这里产出的每一行都必须不依赖其它行即可渲染。
//
// 本文件只做 payload → 行字段的映射与截断，不读取 snapshot、不发 delta、不记账
// revision；调用方（ProductProjection）负责 rowId/turnId 分配、append/upsert 语义
// 以及把结果纳入同一次投影事务。映射表与 protocol §4.4 / formal-proof 的封闭枚举对齐，
// 新增来源时先扩展词表，再在这里补分支。
import type {
  CompactTimelineStatus,
  CompactTrigger,
  GoalStatus,
  SyntheticUserMessageSource,
  ToolResultPayload,
  TurnResultType,
  TurnStartedPayload,
} from "@zcode/contracts";
import type {
  GoalState,
  TimelineMarkerPayload,
  ToolOutput,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";

/** 行的基础字段：rowId 单调、turnId 决定分组、createdAt/Seq 决定同轮内排序与冷恢复对齐。 */
export interface RowBaseInput {
  rowId: number;
  turnId: string;
  createdAt: number;
  createdAtSeq: number;
}

/**
 * 合成输入来源 → turnHeader.origin 的封闭映射（protocol 10 §4.4.2）。
 *
 * 只影响轮次头的展示语义：background_task 表示后台结果轮，goal-continuation 表示
 * 目标续跑，rewind 表示编辑后重跑；其余（含未知/缺省）一律按真实用户输入。
 * 纯函数，不产 delta；新增 source 必须先扩词表，避免 UI 自行猜测。
 */
// inputSource → turnHeader.origin（10 §4.4.2）。
export function mapTurnHeaderOrigin(
  source: SyntheticUserMessageSource | undefined,
): TurnHeaderRow["origin"] {
  switch (source) {
    case "background_task":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    case "rewind":
      return "editRerun";
    default:
      return "userInput";
  }
}

/**
 * 合成输入来源 → userInput.origin 的封闭映射（protocol 10 §4.4.3）。
 *
 * background_task → backgroundResult；goal-continuation → goalContinuation；
 * subagent/subagent_message → mailbox（子代理回信）；fork/plugin_reference/rewind/
 * todo_reminder → synthetic（不是用户亲手输入）；其余为 realUser。
 * origin 直接决定 UI 是否展示编辑/重试入口，因此不能把未知来源默认成 realUser 之外的猜测。
 * 纯函数；调用方保证输入来自 canonical fact 而非 raw payload。
 */
// inputSource → userInput.origin（10 §4.4.3）。
export function mapUserInputOrigin(
  source: SyntheticUserMessageSource | undefined,
): UserInputRow["origin"] {
  switch (source) {
    case "background_task":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    case "subagent":
    case "subagent_message":
      return "mailbox";
    case "fork":
    case "plugin_reference":
    case "rewind":
    case "todo_reminder":
      return "synthetic";
    default:
      return "realUser";
  }
}

/**
 * 新建 turnHeader 行（state=running）。origin/executionKind/originMeta 来自
 * TurnStarted payload，startedAt 取行创建时间；工时后续由收口时的 activeMs 补齐。
 * 返回带 base 字段的纯数据，不登记索引——turnHeaderRowIdByTurnId 由调用方维护。
 */
export function buildTurnHeaderRow(base: RowBaseInput, payload: TurnStartedPayload): TurnHeaderRow {
  return {
    ...base,
    kind: "turnHeader",
    origin: mapTurnHeaderOrigin(payload.inputSource),
    executionKind: payload.executionKind ?? "agent",
    ...(payload.originMeta ? { originMeta: payload.originMeta } : {}),
    state: "running",
    startedAt: base.createdAt,
  };
}

/**
 * 新建 userInput 行。text 的选择规则：带 conversationQuotes / botGroupSource 时优先用
 * intent.text（原始输入被引用包装后的可见文本），否则用 payload.input。
 * 附件只携带展示元信息（fileName/mime/bytes），ref 缺失时以行内序号占位；
 * 展示层不得据 ref 读取内容（内容读取属于后续 attachment/get 查询）。
 * sourceCommandId/rootSourceCommandId 是命令去重、ACK 重放与 optimistic overlay 的共同锚点；
 * clientId/highspeed/epilogueStart 等可选字段只在存在时写入，保持行结构稀疏。
 * 纯函数，不分配 rowId、不登记 messageId。
 */
export function buildUserInputRow(base: RowBaseInput, payload: TurnStartedPayload): UserInputRow {
  // 附件渲染：TurnStarted 携带的展示元信息 → row.attachments。
  // ref 是内容引用占位（本地路径/artifact URI）；无稳定引用时以行内序号占位，
  // 展示层只用 fileName/mime/bytes，不据 ref 取内容（attachment/get query 属后续）。
  const attachments =
    payload.intent?.attachmentRefs ??
    payload.attachments?.map((meta, index) => ({
      ref: meta.ref ?? `turn-attachment/${base.rowId}/${index}`,
      fileName: meta.fileName,
      mime: meta.mime,
      bytes: meta.bytes,
    }));
  const sourceCommandId = payload.intent?.sourceCommandId ?? payload.inputId;
  const rootSourceCommandId = payload.intent?.provenance?.sourceCommandId ?? sourceCommandId;
  return {
    ...base,
    kind: "userInput",
    ...(payload.intent?.inputOrigin ? { inputOrigin: payload.intent.inputOrigin } : {}),
    ...(payload.intent?.conversationQuotes
      ? { conversationQuotes: payload.intent.conversationQuotes }
      : {}),
    ...(payload.intent?.botGroupSource ? { botGroupSource: payload.intent.botGroupSource } : {}),
    text:
      payload.intent?.conversationQuotes || payload.intent?.botGroupSource
        ? (payload.intent.text ?? payload.input)
        : payload.input,
    origin: mapUserInputOrigin(payload.inputSource),
    ...(sourceCommandId ? { sourceCommandId } : {}),
    ...(rootSourceCommandId ? { rootSourceCommandId } : {}),
    ...(payload.intent?.clientId ? { clientId: payload.intent.clientId } : {}),
    ...(payload.intent?.highspeed ? { highspeed: payload.intent.highspeed } : {}),
    ...(payload.epilogueStart === undefined ? {} : { epilogueStart: payload.epilogueStart }),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

/**
 * turn 终态结果 → turnHeader 终态。success → completedSuccess，cancelled →
 * completedInterrupted，其余（含旧词表未知值）→ failed。
 * 返回值刻意排除 running：running 只能由 TurnStarted/边界事件建立，收口路径不得停留运行态。
 * 纯函数；与 core TurnResultType 的封闭枚举一一对应。
 */
export function mapTurnResultToHeaderState(
  resultType: TurnResultType,
): Exclude<TurnHeaderRow["state"], "running"> {
  switch (resultType) {
    case "success":
      return "completedSuccess";
    case "cancelled":
      return "completedInterrupted";
    default:
      return "failed";
  }
}

/**
 * CompactTimelineStatus → compact marker.status 的语义归一。
 *
 * started/retrying 都属于运行中；skipped = 无事发生（noop）；interrupted = 被 stop
 * （cancelled）；completed → success；未知值保守落 failed。
 * marker 状态是 UI 唯一可用的 compact 结论，不能让客户端自行从事件序列推断。
 * 纯函数，不负责 marker 行的创建与 revision。
 */
// CompactTimelineStatus → compact marker.status。
// 语义映射：retrying 仍是运行中；skipped = 无事发生（noop）；interrupted = 被 stop（cancelled）。
export function mapCompactMarkerStatus(
  status: CompactTimelineStatus,
): Extract<TimelineMarkerPayload, { type: "compact" }>["status"] {
  switch (status) {
    case "started":
    case "retrying":
      return "running";
    case "completed":
      return "success";
    case "skipped":
      return "noop";
    case "interrupted":
      return "cancelled";
    default:
      return "failed";
  }
}

/**
 * CompactTrigger → marker.origin：UI 只区分「用户显式触发」与「系统触发」，
 * manual 之外（auto/partial/reactive/session_memory）一律归 auto。
 * 合并词表是刻意的产品裁决：新增 trigger 若需要独立展示，必须同时扩展 marker schema。
 */
// CompactTrigger → marker.origin：manual 之外（auto/partial/reactive/session_memory）
// 一律归 auto —— UI 只区分「用户点的」与「系统触发的」。
export function mapCompactMarkerOrigin(
  trigger: CompactTrigger,
): Extract<TimelineMarkerPayload, { type: "compact" }>["origin"] {
  return trigger === "manual" ? "manual" : "auto";
}

/**
 * 旧 GoalStatus → v4 GoalState.status 的兼容映射。
 *
 * active 保持 active；complete → verified（旧词表没有 verifying/notSatisfied 细分，
 * 终态语义等价）；budget_limited 等其余值 → paused：预算耗尽与被 stop 一样，
 * 都必须等待用户显式 resume。纯函数；v4 新事件走 canonical fact，不再依赖此映射。
 */
// 旧 GoalStatus → v4 GoalState.status。
// budget_limited 归 paused：预算耗尽与被 stop 一样等待用户显式 resume；
// complete 归 verified：旧词表没有 verifying/notSatisfied 细分，终态语义等价。
export function mapGoalStatus(status: GoalStatus): GoalState["status"] {
  switch (status) {
    case "active":
      return "active";
    case "complete":
      return "verified";
    default:
      return "paused";
  }
}

/**
 * ToolResultPayload → v4 ToolOutput，按统一终态截断档处理。
 *
 * 输入：core 工具结果与 toolCallId；输出：行内可直接渲染的 text/display，
 * 超过 head+tail（各 32K）时保留头尾并以 truncated.ref 标记，完整内容按需拉取。
 * display 只在非 node_repl_images 时保留：REPL 图片走 ToolCallRow.display 专用通道，
 * 避免实时投影与冷恢复因 V4 output 不独立携带 display 而丢图。
 * 纯函数，不做 artifact 落盘；ref 暂以 toolCallId 占位（artifact 存取属传输外壳期）。
 */
// 终态截断全档统一：head+tail 各 32K，超出部分以 truncated.ref 按需拉取。
// 阶段 ref 先用 toolCallId 占位（artifact 存取属传输外壳期）。
export function buildToolOutput(result: ToolResultPayload, toolCallId: string): ToolOutput {
  const text = result.content;
  // 模型可见文本只保留图片占位符，若 V4 output 不独立携带 display，
  // 实时投影和冷恢复都会丢失 CUA 截图。Node REPL 图片仍走 ToolCallRow.display 专用通道。
  const display = result.display?.kind === "node_repl_images" ? undefined : result.display;
  const headBytes = PROTOCOL_V4_LIMITS.toolOutputFinalHeadBytes;
  const tailBytes = PROTOCOL_V4_LIMITS.toolOutputFinalTailBytes;
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= headBytes + tailBytes) {
    return { text, ...(display ? { display } : {}) };
  }
  const buffer = Buffer.from(text, "utf8");
  const head = buffer.subarray(0, headBytes).toString("utf8");
  const tail = buffer.subarray(buffer.length - tailBytes).toString("utf8");
  return {
    text: `${head}\n…\n${tail}`,
    ...(display ? { display } : {}),
    truncated: { totalBytes, ref: `tool-output/${toolCallId}` },
  };
}
