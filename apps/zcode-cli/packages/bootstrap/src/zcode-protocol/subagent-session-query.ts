// zcode-protocol/subagent-session-query —— 父会话子代理投影与 ended 游标分页的纯查询层。
//
// 职责：从父会话工具调用与 spawn/stop 事件识别子代理，结合 child 会话事实与 background task，
// 产出 running/ended 两个列表。不负责读盘、发事件、写投影缓存、创建或结束子会话。
//
// INV-01 断言：合成 childSessionId 必须与 runtime 的 subagent_<agentId> 规则一致 —— 守住它的位置：candidateFromToolPart 的 createSessionId 兜底 —— 改错故障：同一子代理出现真实 id 与合成 id 两行，running 重复且真实行永久 lost
// INV-02 断言：只有 taskType 等于 subagent_child 的会话才参与投影 —— 守住它的位置：projectSessionSubagents 循环内的 continue 守卫 —— 改错故障：普通子会话被当成子代理渲染，或真实子代理因缺 child 记录整条消失
// INV-03 断言：父 tool part 的 completed 不等于子会话终态 —— 守住它的位置：runningStatus 与 lastChildOutcome —— 改错故障：异步 Agent 启动后立刻从 running 消失，running 行被清空且无法自愈
// INV-04 断言：stream recovery 作废的半截 assistant 不是终态证据 —— 守住它的位置：lastChildOutcome 的提前返回 —— 改错故障：恢复期子代理闪一次 failed，重发后 ended 列表仍残留失败行
// INV-05 断言：只有不含 tool part 的最终 assistant 才能判成功 —— 守住它的位置：lastChildOutcome 的 hasToolRound 分支 —— 改错故障：多步工具轮次中途被当成功，长任务子代理提前进入 ended
// INV-06 断言：终态优先级固定为 background、child 投影、part 错误、spawn stop、output status、兜底 —— 守住它的位置：endedStatus —— 改错故障：两次刷新之间同一子代理在 success 与 failed 间反复抖动
// INV-07 断言：spawn/stop 事件只能作为最后的兜底数据源 —— 守住它的位置：candidateFromToolPart 中 relation 排在末位 —— 改错故障：陈旧事件覆盖 tool output 的新 childSessionId，投影指向错误子会话
// INV-08 断言：Spawned 与 Stopped 以 parentToolCallId 为唯一关联键 —— 守住它的位置：subagentEventRelations —— 改错故障：并行子代理状态互相串写，A 的停止时间落到 B 上
// INV-09 断言：running 兜底分支用 undefined 判存在性而不是真假值 —— 守住它的位置：runningStatus 的 async 分支 —— 改错故障：endedAt 为 0 或空投影被误判成已有终态，运行中 Agent 被移出 running
// INV-10 断言：只遍历活动分支上的消息 —— 守住它的位置：activeBranchMessages 与 collectCandidates —— 改错故障：rewind 后已回滚分支的旧 Agent 调用重新出现在列表里
// INV-11 断言：本文件所有导出都是纯函数，不读盘不发事件 —— 守住它的位置：projectSessionSubagents 与分页函数 —— 改错故障：同一 revision 多次调用结果不一致，客户端快照对不上
// INV-12 断言：revision 必须原样透传父投影的值 —— 守住它的位置：projectSessionSubagents 的返回值 —— 改错故障：客户端按 revision 去重时把新数据当旧数据丢弃
// INV-13 断言：游标解码失败按无游标处理而不是报错 —— 守住它的位置：decodeCursor 的 catch —— 改错故障：翻页接口 500 或整页空白，客户端无法继续加载历史
// INV-14 断言：nextCursor 只在确有余页时给出 —— 守住它的位置：paginateEndedSubagents 的返回构造 —— 改错故障：客户端无限下拉，反复请求同一页并拼出重复条目
// INV-15 断言：可选字段用条件展开，不写显式 undefined —— 守住它的位置：candidateFromToolPart 与投影 common 的字段构造 —— 改错故障：undefined 覆盖合并端已有值，JSON 往返后丢字段
// INV-16 断言：取消判定只作用于错误 name —— 守住它的位置：CANCELLATION_PATTERN 的两处使用 —— 改错故障：正文里出现 cancel 字样被当成取消，failed 被翻成 cancelled
// INV-17 断言：候选去重键是 childSessionId —— 守住它的位置：collectCandidates 的 Map —— 改错故障：同一子会话被重复渲染成多行，计数与分页错乱
// INV-18 断言：任何脏输入都降级为空值而不是抛出 —— 守住它的位置：asRecord、parseJsonObject、decodeCursor —— 改错故障：一条脏 output 让整个会话列表接口 500，历史全部不可见
// INV-19 断言：分页比较方向必须与排序方向一致 —— 守住它的位置：ended.sort 与 paginate 的 findIndex 条件 —— 改错故障：区间重叠，漏取或重复返回同一条
// INV-20 断言：输出字段必须可直接 JSON 序列化 —— 守住它的位置：running 与 ended 的 push 构造 —— 改错故障：协议层序列化时丢字段或抛错，客户端拿不到 endedAt
import { Buffer } from "node:buffer";
import {
  createSessionId,
  SessionEventType,
  selectActiveConversationBranch,
  type BackgroundTaskInfo,
  type MessageWithParts,
  type SessionEvent,
  type SessionInfo,
  type SessionProjection,
  type ToolPart,
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
} from "@zcode/contracts";
import type { ZCodeSessionEndedSubagent, ZCodeSessionRunningSubagent } from "@zcode/shared";

// [契约] 只有这三种工具名被视为子代理入口：Agent 是当前命名，Task 是历史名，
// subagent 是低层别名。三者共用同一套候选解析，缺任何一个都会让旧会话里的子代理整体消失。
// 父消息是 cold query 唯一可用的线索，没有其它路径能把漏掉的工具调用补回来。
// 新增工具名时必须同步确认 runtime 侧会写 Spawned/Stopped 事件，否则只剩孤立的 ended 行。
// 也不要改成前缀或子串匹配，那会把名字里带 agent 的普通工具卷进来。
const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "subagent"]);
const CANCELLATION_PATTERN = /abort|cancel|interrupt|stop/i;

interface SubagentCandidate {
  agentId?: string;
  childSessionId: string;
  runInBackground: boolean;
  output: Record<string, unknown> | null;
  part: ToolPart;
  subagentType: string;
  summary?: string;
  startedAt?: number;
  stoppedAt?: number;
  stoppedStatus?: "success" | "failed" | "cancelled";
  title: string;
}

interface SubagentEventRelation {
  agentId?: string;
  childSessionId?: string;
  description?: string;
  startedAt?: number;
  stoppedAt?: number;
  stoppedStatus?: "success" | "failed" | "cancelled";
  subagentType?: string;
  summary?: string;
}

/**
 * 父会话的子代理产品投影：running/ended 两个列表都按时间倒序，revision 与父投影对齐。
 */
export interface SessionSubagentProjection {
  revision: number;
  running: ZCodeSessionRunningSubagent[];
  ended: ZCodeSessionEndedSubagent[];
}

/**
 * 投影所需输入：父会话/消息用于发现 Agent 工具调用，child* 映射提供子会话事实，
 * parentProjection/parentEvents 用于 background task 与 spawn/stop 关系恢复。
 */
export interface ProjectSessionSubagentsInput {
  revision: number;
  parentSession: SessionInfo;
  messages: readonly MessageWithParts[];
  childSessionsById: ReadonlyMap<string, SessionInfo>;
  childMessagesById: ReadonlyMap<string, readonly MessageWithParts[]>;
  childProjectionsById: ReadonlyMap<string, SessionProjection>;
  parentProjection?: SessionProjection;
  parentEvents?: readonly SessionEvent[];
}

// [契约] 非对象与数组一律降级为空对象，调用方因此可以无条件读取字段。
// 不要改成返回 null：下游每一处取值都要加空判，且会改变整条 ?? 兜底链的走向。
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringField(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = nonEmptyString(source[key]);
    if (value) return value;
  }
  return undefined;
}

// [失败路径] 工具 output 既可能是 JSON，也可能是后台 Agent 的纯文本 launch ACK。
// JSON.parse 失败必须静默返回 null，不能抛错：一条脏 output 会让整个会话列表接口 500。
// 返回 null 不代表没有信息，调用方还会走文本 ACK 与 metadata 两条兜底。
// 所以这里吞掉异常不会丢子代理，只是少一个字段来源，属于有意为之的降级。
// [失败路径] 捕获后返回 null 而不记日志重抛：会话列表按条目容错，单条脏 output 不能升级成整个接口失败。
function parseJsonObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

// [契约] 标准 launch ACK 形如 agentId: xxx (...)，正则只在行首或换行后匹配。
// 这样能避免把正文里顺带提到的 agentId 误认成自己的 id。
// 字符集排除空白与左括号：ACK 中 agentId 之后紧跟空格或括号注释。
// 若放宽成贪婪匹配会把后续文字吞进 id，合成出的 childSessionId 随之整体错位。
// 只取第一个捕获组，ACK 末尾的其它字段不参与判断。
function agentIdFromLaunchAcknowledgement(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return nonEmptyString(value.match(/(?:^|\n)agentId:\s*([^\s(]+)/)?.[1]);
}

function contentBlocksToText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((block) => nonEmptyString(asRecord(block).text))
    .filter((item): item is string => Boolean(item))
    .join("\n\n");
  return text || undefined;
}

// [并发] spawn 与 stop 可能乱序到达，也可能只有 stop 而没有 spawn。
// 这里以 parentToolCallId 为条目做浅合并，所有字段都回退到 current，先写的不被覆盖。
// 因此 stop 单独到达也能产出一条可用 relation，只是缺 startedAt。
// 不要改成最新事件整条覆盖：那会把 spawn 写入的 childSessionId 抹成 undefined。
// Spawned 的 description 允许从 prompt 回退，保证缺 description 的老事件也有标题。
// 父工具调用 id 是唯一关联键；Spawned 只记录起始，Stopped 合并终止状态与摘要。
function subagentEventRelations(
  events: readonly SessionEvent[] | undefined,
): ReadonlyMap<string, SubagentEventRelation> {
  const relations = new Map<string, SubagentEventRelation>();
  for (const event of events ?? []) {
    if (
      event.type !== SessionEventType.SubagentSpawned &&
      event.type !== SessionEventType.SubagentStopped
    ) {
      continue;
    }
    const payload = asRecord(event.payload);
    const parentToolCallId = stringField(payload, "parentToolCallId");
    if (!parentToolCallId) continue;
    const current = relations.get(parentToolCallId) ?? {};
    if (event.type === SessionEventType.SubagentSpawned) {
      relations.set(parentToolCallId, {
        ...current,
        agentId: stringField(payload, "agentId") ?? current.agentId,
        childSessionId: stringField(payload, "childSessionId") ?? current.childSessionId,
        description: stringField(payload, "description", "prompt") ?? current.description,
        startedAt: event.timestamp.getTime(),
        subagentType: stringField(payload, "agentType") ?? current.subagentType,
      });
      continue;
    }
    const status = stringField(payload, "status");
    relations.set(parentToolCallId, {
      ...current,
      agentId: stringField(payload, "agentId") ?? current.agentId,
      childSessionId: stringField(payload, "childSessionId") ?? current.childSessionId,
      stoppedAt: event.timestamp.getTime(),
      stoppedStatus:
        status === "cancelled" || status === "stopped"
          ? "cancelled"
          : status === "failed" || status === "error"
            ? "failed"
            : "success",
      summary:
        stringField(payload, "summaryText", "result", "error", "description") ?? current.summary,
    });
  }
  return relations;
}

// [契约] 必须经 selectActiveConversationBranch 过滤，不能直接遍历 messages。
// rewind 之后被回滚分支上的 Agent 调用仍留在 messages 里，直接遍历会让已撤销的子代理重现。
// revert 的四个字段全部原样传入，不要在本地按 id 自行裁剪。
// 分支切割与保留集合的组合边界由 contracts 统一裁决，本地重复实现必然与其漂移。
// 父会话与 child 会话都要走同一套规则，否则父子判定的活动分支会不一致。
function activeBranchMessages(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
): MessageWithParts[] {
  return selectActiveConversationBranch(messages, {
    branchCutAfterMessageId: session.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: session.revert?.createdMessageID,
    rewindKeptMessageIds: session.revert?.keptMessageIDs,
    rewindTargetMessageId: session.revert?.targetMessageID,
  });
}

// 优先从 output/metadata/spawn relation 取 childSessionId，缺 agentId 时按 runtime 规则合成；
// 两处都拿不到才跳过该工具调用。
function candidateFromToolPart(
  part: ToolPart,
  relation?: SubagentEventRelation,
): SubagentCandidate | null {
  // [契约] 先按工具名过滤再解析字段，顺序不能反。
  // 其它工具也可能输出带 agentId 形状的 payload，例如普通 MCP 调用。
  // 先解析会把它们误投影成子代理，并在列表里产生点不开的条目。
  // 返回 null 是唯一的跳过方式，调用方据此决定是否懒加载该 child 会话。
  // 不要把过滤下沉到 collectCandidates：那里拿不到 part.tool，语义会变含糊。
  if (!SUBAGENT_TOOL_NAMES.has(part.tool)) return null;
  const completedOutput =
    part.state.status === "completed" ? nonEmptyString(part.state.output) : undefined;
  const output = parseJsonObject(completedOutput);
  const input = asRecord(part.state.input);
  const stateMetadata = "metadata" in part.state ? asRecord(part.state.metadata) : {};
  const metadata = { ...asRecord(part.metadata), ...stateMetadata };
  // [契约] agentId 优先级：output 大于 launch ACK，再大于 metadata，最后是 spawn relation。
  // 后台 Agent 在 cold query 时往往只剩纯文本 ACK，metadata 与 relation 都可能缺失。
  // 跳过 ACK 这一层会让真实在跑的 Agent 整条消失，这是已经修过的线上故障。
  // 最后退回 part.callID，保证后续按 toolCallId 匹配 background task 不落空。
  // 但这个兜底值不能反推 childSessionId，合成规则只接受真正的 agentId。
  const agentId =
    stringField(output ?? {}, "agentId") ??
    // 后台 Agent 的持久化 launch ACK 是纯文本，cold query 未携带
    // 临时 spawn event 时无法恢复 childSessionId，导致真实 running Agent 被整条跳过。
    // 标准 ACK 自带 agentId，按该稳定字段恢复，与 runtime 的 session id 规则对齐。
    agentIdFromLaunchAcknowledgement(completedOutput) ??
    stringField(metadata, "agentId") ??
    relation?.agentId;
  const childSessionId =
    stringField(output ?? {}, "childSessionId") ??
    stringField(metadata, "childSessionId") ??
    relation?.childSessionId ??
    (agentId ? createSessionId(`subagent_${agentId}`) : undefined);
  // [契约] childSessionId 按 output 大于 metadata、大于 relation、最后合成的顺序取。
  // 合成规则是 runtime 的 subagent_<agentId>，必须与真实 child 会话 id 完全一致。
  // 不一致会让同一子代理出现两行：一行真实，一行永远查不到 child 记录。
  // 两者都拿不到时直接放弃该候选，不要用 callID 等替代值硬凑。
  // 错误 id 会在去重 Map 里占据独立键，生成永不消失的影子条目。
  if (!childSessionId) return null;
  const title =
    stringField(output ?? {}, "description") ??
    stringField(input, "description") ??
    stringField(metadata, "description") ??
    relation?.description ??
    stringField(input, "prompt") ??
    "Subagent";
  return {
    childSessionId,
    runInBackground: input.run_in_background === true,
    part,
    output,
    agentId: agentId ?? part.callID,
    subagentType:
      stringField(output ?? {}, "agentType") ??
      stringField(metadata, "agentType") ??
      relation?.subagentType ??
      stringField(input, "subagent_type", "agent", "agentType") ??
      "subagent",
    title,
    summary:
      contentBlocksToText(output?.content) ??
      stringField(output ?? {}, "result", "summary") ??
      (part.state.status === "error" ? nonEmptyString(part.state.error) : undefined) ??
      relation?.summary,
    ...(relation?.startedAt !== undefined ? { startedAt: relation.startedAt } : {}),
    ...(relation?.stoppedAt !== undefined ? { stoppedAt: relation.stoppedAt } : {}),
    ...(relation?.stoppedStatus ? { stoppedStatus: relation.stoppedStatus } : {}),
  };
}

// [并发] 以 childSessionId 为键去重，后写入覆盖先写入。
// 同一子会话可能对应多个 tool part，例如重试或 resume 后再次调用，只保留最后解析到的一条。
// Map 的插入顺序即首次出现顺序，最终排序统一在 projectSessionSubagents 里做。
// 这里不要提前 sort，否则调用方看到的候选顺序会随解析细节变化。
// 也不要在去重后回填消息，候选只承载投影需要的事实。
function collectCandidates(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
  parentEvents?: readonly SessionEvent[],
): SubagentCandidate[] {
  const candidates = new Map<string, SubagentCandidate>();
  const relations = subagentEventRelations(parentEvents);
  for (const message of activeBranchMessages(session, messages)) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      const candidate = candidateFromToolPart(part, relations.get(part.callID));
      if (candidate) candidates.set(candidate.childSessionId, candidate);
    }
  }
  return [...candidates.values()];
}

/** 只返回父会话中可识别的子会话 id，供批量加载与投影前的 child 数据抓取。 */
export function collectSubagentChildSessionIds(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
  parentEvents?: readonly SessionEvent[],
): string[] {
  return collectCandidates(session, messages, parentEvents).map(
    (candidate) => candidate.childSessionId,
  );
}

function lastChildOutcome(messages: readonly MessageWithParts[] | undefined): {
  endedAt?: number;
  status?: "success" | "failed" | "cancelled";
  summary?: string;
} {
  // [失败路径] 没有任何消息时返回空对象，而不是失败。
  // cold query 尚未加载 child 消息是常态，把它当失败会让运行中的子代理被标成 failed。
  // 一旦被标 failed 就会从 running 挪到 ended，并且不会自行回到 running。
  // 空对象同时表示「还没有终态证据」，后续由 background 与 spawn relation 继续裁决。
  // 因此调用方必须用 undefined 判存在性，不能把空对象当成已完成的 outcome。
  if (!messages || messages.length === 0) return {};
  const assistantMessages = messages.filter((message) => message.info.role === "assistant");
  const last = assistantMessages.at(-1);
  if (!last || last.info.role !== "assistant") return {};
  // stream recovery 作废的半截 assistant 带 error 落盘，但子会话紧接着会从锚点
  // 重发；它是最后一条只说明恢复仍在进行或进程已退出，都不是「子会话失败」的终态。
  // [失败路径] stream recovery 作废的半截 assistant 会带 error 落盘，但紧接着从锚点重发。
  // 它出现在末尾只说明恢复仍在进行或进程已退出，都不是子会话的终态。
  // 这里必须提前返回空对象：改成 failed 会让恢复期的子代理闪一次失败。
  // 重发完成后 ended 列表里仍会残留那条失败行，因为列表按 revision 合并而不是重建。
  // 错误名比较用共享常量而非常量字符串，避免名字调整后此处静默失效。
  if (last.info.error && last.info.error.name === STREAM_RECOVERY_DISCARDED_ERROR_NAME) {
    return {};
  }
  const text = last.parts
    .flatMap((part) => (part.type === "text" && part.ignored !== true ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n\n");
  const errorName = last.info.error?.name;
  const errorSummary = last.info.error
    ? (stringField(last.info.error.data ?? {}, "message", "error", "detail") ?? errorName)
    : undefined;
  // [契约] 只有不含 tool part 的最终 assistant 才算成功终态。
  // assistant 发出 tool call 后该 model step 也会写 completed 与 finish，此时子会话仍在执行工具。
  // 把本轮结束当成子会话结束会让长任务子代理提前进入 ended。
  // 随后真实完成的第二次上报又生成新行，UI 上表现为同一条子代理反复闪烁。
  // 所以 hasToolRound 必须基于全部 part 计算，不能只看最后一条 part 的类型。
  const hasToolRound = last.parts.some((part) => part.type === "tool");
  return {
    ...(last.info.time.completed ? { endedAt: last.info.time.completed } : {}),
    ...(text || errorSummary ? { summary: text || errorSummary } : {}),
    ...(errorName
      ? { status: CANCELLATION_PATTERN.test(errorName) ? "cancelled" : "failed" }
      : // Bug 根因：assistant 发出 tool call 后，该 model step 也会写 completed/finish；
        // 但 child session 仍在执行 Bash 等工具，不能把“本轮结束”当成“子会话终态”。
        // 只有不含 tool part 的最终 assistant message 才能提供成功 outcome。
        !hasToolRound && (last.info.time.completed || last.info.finish)
        ? { status: "success" }
        : {}),
  };
}

function findBackgroundTask(
  projection: SessionProjection | undefined,
  candidate: SubagentCandidate,
): BackgroundTaskInfo | undefined {
  return projection?.backgroundTasks.find(
    (task) =>
      task.taskKind === "subagent" &&
      (task.childSessionId === candidate.childSessionId ||
        task.toolCallId === candidate.part.callID ||
        task.taskId === candidate.agentId),
  );
}

function runningStatus(input: {
  background?: BackgroundTaskInfo;
  candidate: SubagentCandidate;
  childOutcome: ReturnType<typeof lastChildOutcome>;
  childProjection?: SessionProjection;
  parentProjection?: SessionProjection;
}): ZCodeSessionRunningSubagent["status"] | undefined {
  // [契约] running 判定顺序固定：background 权威状态，然后 child projection 的 waiting/running，
  // 接着是 async 兜底，再到父投影 activeToolCalls，最后才是父 tool part 状态，顺序不可调换。
  // 兜底分支只看字段是否不存在，而不是真假值：异步 Agent 的父 tool part 在 launch
  // ACK 后立刻 completed，partial parent projection 也可能暂时不带 background task。
  // 此时若按 tool part 判 ended，cold seed 会把 V4 的 running 行清空且无法自愈。
  if (input.background?.status === "running") {
    return input.background.blocked ? "blocked" : "running";
  }
  if (input.childProjection?.status === "waiting") return "waiting";
  if (input.childProjection?.status === "running") return "running";
  // async Agent 的父 tool part 在 launch ACK 后立即标成 completed，
  // partial parent projection 又可能暂时不带仍运行的 background task。此时仅按
  // tool part 会把 child 误判为 ended，并在 cold seed 时清空 V4 running 行。
  // child 还没有终态输出、spawn relation 也没有 stop 时，background input 本身
  // 是可恢复的 running 事实；真实终态仍由 background/child projection/outcome 优先。
  if (
    input.candidate.runInBackground &&
    input.background === undefined &&
    input.childProjection === undefined &&
    input.candidate.stoppedStatus === undefined &&
    input.childOutcome.status === undefined
  ) {
    return "running";
  }
  if (
    input.parentProjection?.activeToolCalls.some(
      (tool) =>
        tool.toolCallId === input.candidate.part.callID &&
        (tool.status === "pending" || tool.status === "running"),
    )
  ) {
    return "running";
  }
  return input.parentProjection &&
    (input.candidate.part.state.status === "pending" ||
      input.candidate.part.state.status === "running")
    ? "running"
    : undefined;
}

// [契约] lost 是独立终态而非 failed：它表示后台任务失去跟踪，例如重启或丢连接。
// UI 需要保留可恢复语义，映射成 failed 会让用户以为子代理真的报错并去重试。
function terminalBackgroundStatus(
  task: BackgroundTaskInfo | undefined,
): ZCodeSessionEndedSubagent["status"] | undefined {
  switch (task?.status) {
    case "completed":
      return "success";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "timed_out":
    case "spawn_error":
      return "failed";
    case "lost":
      return "lost";
    default:
      return undefined;
  }
}

// 终态优先级：background 权威状态 > 子会话投影 > tool part 错误 > spawn stop >
// 输出 status > completed/lost 兜底。
// [契约] 优先级：background、child projection、tool part error、spawn stop，然后是
// output status，最后 completed 与 lost 兜底，顺序不可调换。
// child projection 的 completed 排在 tool part error 之前，因为子会话自身投影包含
// 错误之外的完成语义；把 part error 提前会让已恢复成功的子代理被标 failed。
// 已后台启动不是终态，继续用 child outcome 判，拿不到就落 lost。
function endedStatus(input: {
  background?: BackgroundTaskInfo;
  candidate: SubagentCandidate;
  childOutcome: ReturnType<typeof lastChildOutcome>;
  childProjection?: SessionProjection;
}): ZCodeSessionEndedSubagent["status"] {
  const backgroundStatus = terminalBackgroundStatus(input.background);
  if (backgroundStatus) return backgroundStatus;
  if (input.childProjection?.status === "error") return "failed";
  if (input.childProjection?.status === "completed") return "success";
  if (input.candidate.part.state.status === "error") {
    return CANCELLATION_PATTERN.test(input.candidate.part.state.error) ? "cancelled" : "failed";
  }
  if (input.candidate.stoppedStatus) return input.candidate.stoppedStatus;
  const outputStatus = stringField(input.candidate.output ?? {}, "status");
  if (outputStatus === "cancelled" || outputStatus === "stopped") return "cancelled";
  if (outputStatus === "failed" || outputStatus === "error") return "failed";
  if (outputStatus === "async_launched") return input.childOutcome.status ?? "lost";
  if (input.candidate.part.state.status === "completed") return "success";
  return input.childOutcome.status ?? "lost";
}

function startedAt(
  candidate: SubagentCandidate,
  background?: BackgroundTaskInfo,
): number | undefined {
  if (background?.startedAt) return background.startedAt.getTime();
  if (candidate.startedAt !== undefined) return candidate.startedAt;
  return "time" in candidate.part.state ? candidate.part.state.time.start : undefined;
}

/**
 * 把父会话里的 Agent/Task/subagent 工具调用投影成 running/ended 子代理列表。
 * live 判定优先 background/child projection，父 tool part 的 completed 不代表子会话终态；
 * ended 的摘要与结束时间按 background → spawn stop → tool state → child outcome 兜底。
 */
export function projectSessionSubagents(
  input: ProjectSessionSubagentsInput,
): SessionSubagentProjection {
  const running: ZCodeSessionRunningSubagent[] = [];
  const ended: ZCodeSessionEndedSubagent[] = [];
  // [契约] child 记录缺失或 taskType 不是 subagent_child 时整条跳过，不产出 ended 占位。
  // 调用方需先用 collectSubagentChildSessionIds 批量加载 child 会话再投影。
  // 若改成缺 child 也输出一行，历史列表会出现无标题、无时间、点不开的幽灵条目。
  // 反过来对非 subagent_child 放行，会把普通子会话错误地渲染成子代理。
  // 过滤放在循环首行，保证后续分支不必重复校验同一个条件。
  for (const candidate of collectCandidates(
    input.parentSession,
    input.messages,
    input.parentEvents,
  )) {
    const childSession = input.childSessionsById.get(candidate.childSessionId);
    if (!childSession || childSession.taskType !== "subagent_child") continue;
    const childProjection = input.childProjectionsById.get(candidate.childSessionId);
    const background = findBackgroundTask(input.parentProjection, candidate);
    const childOutcome = lastChildOutcome(input.childMessagesById.get(candidate.childSessionId));
    const liveStatus = runningStatus({
      background,
      candidate,
      childOutcome,
      childProjection,
      parentProjection: input.parentProjection,
    });
    const common = {
      childSessionId: candidate.childSessionId,
      ...(candidate.agentId ? { agentId: candidate.agentId } : {}),
      toolCallId: candidate.part.callID,
      subagentType: candidate.subagentType,
      title: candidate.title,
      ...(startedAt(candidate, background) !== undefined
        ? { startedAt: startedAt(candidate, background) }
        : {}),
    };
    if (liveStatus) {
      running.push({ ...common, status: liveStatus });
      continue;
    }
    const stateEndedAt =
      "time" in candidate.part.state && "end" in candidate.part.state.time
        ? candidate.part.state.time.end
        : undefined;
    ended.push({
      ...common,
      status: endedStatus({ background, candidate, childOutcome, childProjection }),
      ...(candidate.summary || childOutcome.summary
        ? { summary: candidate.summary ?? childOutcome.summary }
        : {}),
      endedAt:
        background?.completedAt?.getTime() ??
        candidate.stoppedAt ??
        stateEndedAt ??
        childOutcome.endedAt ??
        childSession.time.updated,
    });
  }
  running.sort(
    (left, right) =>
      (right.startedAt ?? 0) - (left.startedAt ?? 0) ||
      right.childSessionId.localeCompare(left.childSessionId),
  );
  ended.sort(
    (left, right) =>
      (right.endedAt ?? 0) - (left.endedAt ?? 0) ||
      right.childSessionId.localeCompare(left.childSessionId),
  );
  return { revision: input.revision, running, ended };
}

function encodeCursor(item: ZCodeSessionEndedSubagent): string {
  return Buffer.from(
    JSON.stringify({ childSessionId: item.childSessionId, endedAt: item.endedAt ?? 0 }),
  ).toString("base64url");
}

// [失败路径] 游标是 base64url 编码的 childSessionId 与 endedAt，结构极简。
// 任何解码失败或形状不合法都返回 null，并按无游标从首页重来。
// 不抛错也不返回空页：翻页失败退化成重新加载首页，比 500 或空白更可接受。
// 不要做宽松修复，例如把 endedAt 转成字符串再比较，排序键类型不一致会让
// nextCursor 之后的分页区间重叠，出现漏取或重复返回同一条。
function decodeCursor(cursor: string | undefined): {
  childSessionId: string;
  endedAt: number;
} | null {
  if (!cursor) return null;
  try {
    const value = asRecord(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown,
    );
    const childSessionId = nonEmptyString(value.childSessionId);
    const endedAt = value.endedAt;
    return childSessionId && typeof endedAt === "number" ? { childSessionId, endedAt } : null;
  } catch {
    return null;
  }
}

/**
 * 对已结束子代理做游标分页：游标编码 (endedAt, childSessionId)，按同一排序键继续向后取，
 * 返回 nextCursor 仅在确有余页时给出。
 */
export function paginateEndedSubagents(
  ended: readonly ZCodeSessionEndedSubagent[],
  options: { cursor?: string; limit: number },
): { items: ZCodeSessionEndedSubagent[]; nextCursor?: string } {
  const cursor = decodeCursor(options.cursor);
  const start = cursor
    ? ended.findIndex(
        (item) =>
          (item.endedAt ?? 0) < cursor.endedAt ||
          ((item.endedAt ?? 0) === cursor.endedAt &&
            item.childSessionId.localeCompare(cursor.childSessionId) < 0),
      )
    : 0;
  if (start < 0) return { items: [] };
  const items = ended.slice(start, start + options.limit);
  const last = items.at(-1);
  return {
    items,
    ...(last && start + items.length < ended.length ? { nextCursor: encodeCursor(last) } : {}),
  };
}
