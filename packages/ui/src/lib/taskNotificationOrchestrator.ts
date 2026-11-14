// INV-01 终态只认三个阶段：守住位置 阶段判定函数；改错故障 对话中途也发完成通知。
// INV-02 完成与失败分开映射：守住位置 两个分支；改错故障 中断被当成失败。
// INV-03 无前值不通知：守住位置 映射命中判断；改错故障 首次加载刷出一批旧通知。
// INV-04 状态未变不重复：守住位置 前后状态比较；改错故障 每次更新都推同一条通知。
// INV-05 标题先裁剪：守住位置 去空白；改错故障 全空白标题进入通知正文。
// INV-06 标题缺省走兜底：守住位置 备用消息标识；改错故障 通知正文为空。
// INV-07 文案统一国际化：守住位置 格式化函数入参；改错故障 通知语言与界面不一致。
// INV-08 会话标识直接复用：守住位置 任务标识赋值；改错故障 通知点击跳错会话。
// INV-09 权限请求优先：守住位置 种类分支；改错故障 权限卡被当成普通提问。
// INV-10 计划审批单独识别：守住位置 工具名判断；改错故障 计划审批显示为一般输入。
// INV-11 审批识别容错：守住位置 结构检查；改错故障 脏结构导致整轮通知失败。
// INV-12 工作流复核不发通知：守住位置 提前返回；改错故障 设置页入口被推到系统通知。
// INV-13 摘要为空退回标题：守住位置 或运算；改错故障 通知正文只有空白。
// INV-14 已见标识过滤：守住位置 集合查找；改错故障 同一请求反复弹通知。
// INV-15 空载荷被丢弃：守住位置 扁平映射；改错故障 数组里出现空元素。
// INV-16 请求标识透传：守住位置 请求字段；改错故障 点击通知无法定位来源请求。
// INV-17 纯函数无副作用：守住位置 模块不写状态；改错故障 通知收集改变会话数据。
// INV-18 输出顺序跟随输入：守住位置 顺序遍历；改错故障 通知到达顺序与界面相反。
//
// 模块职责：把会话阶段变化与待处理交互翻译成系统通知载荷。
// 状态所有权：本模块不持有状态，前值与已见集合由调用方注入。
// 阅读顺序：先看阶段映射，再看终态载荷，最后看待处理交互分发。
import type { TaskNotificationPayload } from "@zcode/shared";
import type {
  ConversationSnapshot,
  PendingInteraction,
  SessionPhase,
  SessionSummary,
  UserInputRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";
import type { IntlInstance } from "@/i18n/index.js";

type FormatMessage = IntlInstance["formatMessage"];

function terminalStatusForPhase(
  phase: SessionPhase,
): Extract<TaskNotificationPayload["status"], "completed" | "failed"> | null {
  // completedSuccess 与 completedInterrupted 都映射成 completed：对用户而言"跑完"与"被打断"是同一类结果，
  // 拆成两个状态会让通知文案与点击行为分叉（INV-02）。
  if (phase === "completedSuccess" || phase === "completedInterrupted") {
    return "completed";
  }
  // 只有 error 算失败；awaitingPermission 等中间态不产生终态通知。
  if (phase === "error") {
    return "failed";
  }
  // 返回 null 由调用方跳过：这里不抛错，阶段枚举新增成员时也不会打断整批收集（INV-01）。
  return null;
}

function taskTitleBody(
  title: string,
  fallbackMessageId: string,
  formatMessage: FormatMessage,
): string {
  const trimmedTitle = title.trim();
  // 只裁剪首尾空白，压缩中间内容会改变语义：会话标题里可能整段是代码或路径（INV-05）。
  if (trimmedTitle) {
    return formatMessage({ id: "notification.taskWithTitle" }, { title: trimmedTitle });
  }
  // 标题全空白时走 fallbackMessageId：调用方按场景传入 completedBody 或 error，
  // 保证通知正文永不为空（INV-06）。
  return formatMessage({ id: fallbackMessageId });
}

function terminalPayloadForSession(
  session: SessionSummary,
  status: Extract<TaskNotificationPayload["status"], "completed" | "failed">,
  formatMessage: FormatMessage,
): TaskNotificationPayload {
  if (status === "completed") {
    // taskId 直接复用 sessionId：点击通知要回到同一个会话，另造 id 就得维护映射表（INV-08）。
    return {
      taskId: session.sessionId,
      status,
      title: formatMessage({ id: "notification.completed" }),
      body: taskTitleBody(session.title, "notification.completedBody", formatMessage),
    };
  }

  // failed 分支复用同一套标题裁剪与 id 兜底逻辑，只是换文案：
  // 两处都调 taskTitleBody，才不会出现"完成通知带标题、失败通知只有正文"的不一致。
  return {
    taskId: session.sessionId,
    status,
    title: formatMessage({ id: "notification.error" }),
    body: taskTitleBody(session.title, "notification.error", formatMessage),
  };
}

export function collectTerminalTaskNotificationPayloads(params: {
  previousBySessionId: ReadonlyMap<string, SessionSummary>;
  sessions: readonly SessionSummary[];
  formatMessage: FormatMessage;
}): TaskNotificationPayload[] {
  const payloads: TaskNotificationPayload[] = [];
  // 顺序遍历而不是先筛后映射：push 顺序与 sessions 一致，通知到达顺序才不会与界面相反（INV-18）。
  // 全程只读 params，不修改 previousBySessionId 与 sessions（INV-17）。
  for (const session of params.sessions) {
    const status = terminalStatusForPhase(session.phase);
    // 非终态直接跳过：running/awaiting 阶段的变化不属于"任务结束"，不该弹系统通知（INV-01）。
    if (!status) continue;

    const previous = params.previousBySessionId.get(session.sessionId);
    // 找不到前值说明这是首次加载该会话，跳过可避免启动瞬间刷出一批历史完成通知（INV-03）。
    if (!previous) continue;

    const previousStatus = terminalStatusForPhase(previous.phase);
    // 只在跨终态时通知：前值与当前同为 completed 或同为 failed 时跳过（例如中断后又补完成）；当前不是终态的情况已在上方跳过（INV-04）。
    if (previousStatus === status) continue;

    payloads.push(terminalPayloadForSession(session, status, params.formatMessage));
  }
  return payloads;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  // 显式排除数组与 null：schema 只接受对象形态，数组的元素访问会静默退化成 undefined，
  // 后续 interaction/toolName 判断就会漏掉计划审批（INV-11）。
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlanApprovalInteraction(payload: UserInputRequestPayload): boolean {
  // 顶层 toolName 是两种协议版本的公共字段：老版本 payload 没有 schema，只看这里就能命中。
  if (payload.toolName === "ExitPlanMode") {
    return true;
  }
  // schema 不是对象时按"非计划审批"处理而不是抛错：脏结构最多让通知退化成普通提问，
  // 不应让整轮待处理交互收集失败（INV-11）。
  if (!isPlainRecord(payload.schema)) {
    return false;
  }
  // 兼容两种来源：新版用 interaction 标记，旧版回落到 schema.toolName。
  return (
    payload.schema.interaction === "plan_approval" || payload.schema.toolName === "ExitPlanMode"
  );
}

function pendingInteractionPayload(params: {
  snapshot: ConversationSnapshot;
  interaction: PendingInteraction;
  formatMessage: FormatMessage;
}): TaskNotificationPayload | null {
  const { snapshot, interaction, formatMessage } = params;
  // requestId 与会话标识原样透传：通知点击要靠 requestId 回到具体请求，
  // 另造 id 就得在系统通知与协议之间维护一份映射（INV-08/INV-16）。
  const requestId = interaction.interactionId;
  const taskId = snapshot.sessionId;
  const taskTitle = snapshot.meta.title;

  // workspace Hook review 的唯一入口是 Settings；不得把它伪装成
  // permission/elicitation 系统通知。
  // 返回 null 而不是改造载荷：丢弃发生在 flatMap 处，结果数组里不会留下空元素（INV-12/INV-15）。
  if (interaction.payload.kind === "workspaceHookReview") {
    return null;
  }

  if (interaction.payload.kind === "permission") {
    // permission 优先于计划审批判断：权限请求带自己的摘要，走通用 elicitation 会丢掉"在请求什么"。
    return {
      taskId,
      status: "permission_request",
      requestId,
      title: formatMessage({ id: "notification.permissionRequired" }),
      // 摘要为空时退回"会话标题 + 权限"模板：通知正文必须非空，否则系统通知只剩标题（INV-13）。
      body:
        interaction.payload.summary.trim() ||
        taskTitleBody(taskTitle, "notification.permissionRequired", formatMessage),
    };
  }

  if (isPlanApprovalInteraction(interaction.payload)) {
    // 计划审批用固定正文，因为审批内容在卡片里，通知只负责把人叫回来。
    return {
      taskId,
      status: "elicitation_request",
      requestId,
      title: formatMessage({ id: "notification.planApprovalRequired" }),
      body: formatMessage({ id: "notification.planApprovalBody" }),
    };
  }

  // 其余交互统一按 elicitation 处理：只有 permission 与计划审批需要单独文案，
  // 新增交互种类默认落到这里，不会因为漏配分支而丢通知（INV-09/INV-10）。
  return {
    taskId,
    status: "elicitation_request",
    requestId,
    title: formatMessage({ id: "notification.inputRequired" }),
    // prompt 与 permission 的 summary 同规则：裁剪后为空就退回标题模板，正文不留空白（INV-13）。
    body:
      interaction.payload.prompt.trim() ||
      taskTitleBody(taskTitle, "notification.inputRequired", formatMessage),
  };
}

export function collectPendingInteractionNotificationPayloads(params: {
  snapshot: ConversationSnapshot;
  seenRequestIds: ReadonlySet<string>;
  formatMessage: FormatMessage;
}): TaskNotificationPayload[] {
  // 已见集合先过滤：同一个 requestId 只通知一次，否则轮询每次快照都会重弹（INV-14）。
  // 纯函数：seenRequestIds 只读，返回新数组，不改快照内的 pendingInteractions（INV-17）。
  return params.snapshot.pendingInteractions
    .filter((interaction) => !params.seenRequestIds.has(interaction.interactionId))
    // flatMap 让 null 变成空数组：既保留顺序，又不会在结果里留下 undefined 元素（INV-15/INV-18）。
    .flatMap((interaction) => {
      const payload = pendingInteractionPayload({
        snapshot: params.snapshot,
        interaction,
        formatMessage: params.formatMessage,
      });
      return payload ? [payload] : [];
    });
}
