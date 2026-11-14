// INV-01 只处理专用频道：守住位置 频道早退；改错故障 其他广播被当作任务事件。
// INV-02 载荷先过类型守卫：守住位置 isBotTaskBroadcastPayload；改错故障 脏数据进入 store 打崩侧栏。
// INV-03 事件名白名单：守住位置 validEvents；改错故障 新增事件未登记时静默丢消息。
// INV-04 必填三字段类型严格：守住位置 workspacePath / taskId / updatedAt；改错故障 缺字段的消息触发无主刷新。
// INV-05 可选字段逐个校验：守住位置 各 undefined 分支；改错故障 半截载荷混入并覆盖完整状态。
// INV-06 只在已打开工作区刷新：守住位置 hasOpenWorkspace；改错故障 未打开的项目也发请求。
// INV-07 工作区键统一构造：守住位置 buildTaskWorkspaceKey；改错故障 远程与本地路径被当成两个工作区。
// INV-08 非工作区页签不参与匹配：守住位置 isWorkspaceTab；改错故障 设置页签被计入打开判定。
// INV-09 未命中返回 null：守住位置 末尾三元；改错故障 调用方要多判断一次 undefined。
// INV-10 created 映射 creating：守住位置 首个 case；改错故障 新建任务先显示运行中。
// INV-11 error 映射 failed：守住位置 独立 case；改错故障 失败任务仍显示流式中。
// INV-12 权限与 elicitation 都算 streaming：守住位置 四个合并 case；改错故障 等待确认时状态跳回就绪。
// INV-13 updated 映射 ready：守住位置 最后一个 case；改错故障 改配置后对话一直转圈。
// INV-14 事件枚举穷尽：守住位置 switch 无 default；改错故障 新增事件返回 undefined 破坏状态机。
//
// 模块职责：Bot 任务广播的载荷校验、打开工作区过滤与运行状态映射。
// 阅读顺序：先看载荷守卫字段，再看刷新判定，最后看事件到状态的映射表。
import {
  BOT_TASK_BROADCAST_CHANNEL,
  type ZCodeTaskRuntimeStatus,
  type BotTaskBroadcastPayload,
} from "@zcode/shared";
import type { BroadcastMessage } from "@zcode/services";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import type { WindowTabState } from "@/store/tabStore.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

// isBotTaskBroadcastPayload 只做结构校验，不修改 payload，判定失败即返回 false。
function isBotTaskBroadcastPayload(
  payload: unknown,
): payload is BotTaskBroadcastPayload {
  // 非对象直接判为非法，避免属性访问抛错。
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const value = payload as Partial<BotTaskBroadcastPayload>;
  // 事件白名单与协议枚举保持同步。
  const validEvents = new Set<BotTaskBroadcastPayload["event"]>([
    "created",
    "prompt_sent",
    "resumed",
    "streaming",
    "permission_request",
    "permission_resolved",
    "elicitation_request",
    "elicitation_resolved",
    "updated",
    "completed",
    "error",
  ]);
  return (
    typeof value.workspacePath === "string" &&
    typeof value.taskId === "string" &&
    typeof value.updatedAt === "number" &&
    (value.workspaceIdentity === undefined ||
      typeof value.workspaceIdentity === "string") &&
    typeof value.event === "string" &&
    validEvents.has(value.event) &&
    (value.task === undefined ||
      (typeof value.task === "object" &&
        value.task !== null &&
        typeof value.task.taskId === "string" &&
        typeof value.task.workspacePath === "string")) &&
    (value.provider === undefined || typeof value.provider === "string") &&
    (value.configOptions === undefined || Array.isArray(value.configOptions)) &&
    (value.permissionRequest === undefined ||
      (typeof value.permissionRequest === "object" && value.permissionRequest !== null)) &&
    (value.elicitationRequest === undefined ||
      (typeof value.elicitationRequest === "object" && value.elicitationRequest !== null)) &&
    (value.prompt === undefined ||
      (typeof value.prompt === "object" &&
        value.prompt !== null &&
        typeof value.prompt.content === "string" &&
        typeof value.prompt.messageId === "string" &&
        typeof value.prompt.sentAt === "number")) &&
    (value.requestId === undefined || typeof value.requestId === "string") &&
    (value.error === undefined || typeof value.error === "string")
  );
}

// 只有命中已打开工作区才返回载荷。
export function resolveBotTaskBroadcastRefresh(
  message: BroadcastMessage,
  tabs: WindowTabState[],
): BotTaskBroadcastPayload | null {
  // message.channel 不等于 BOT_TASK_BROADCAST_CHANNEL 时直接返回 null，不进入结构校验。
  if (message.channel !== BOT_TASK_BROADCAST_CHANNEL) {
    return null;
  }
  // 结构不符同样视为无关消息。
  if (!isBotTaskBroadcastPayload(message.payload)) {
    return null;
  }
  // 目标键与页签键都由 buildTaskWorkspaceKey 构造，两处编码规则必须一致。
  const targetWorkspaceKey = buildTaskWorkspaceKey(
    message.payload.workspacePath,
    message.payload.workspaceIdentity,
  );
  // tabs.some 逐个比对工作区键，命中同一 targetWorkspaceKey 才算已打开。
  const hasOpenWorkspace = tabs.some(
    (tab) =>
      isWorkspaceTab(tab) &&
      buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity) ===
        targetWorkspaceKey,
  );
  return hasOpenWorkspace ? message.payload : null;
}

// 状态映射是纯函数，不读写外部状态。
export function resolveBotTaskBroadcastRuntimeStatus(
  event: BotTaskBroadcastPayload["event"],
): ZCodeTaskRuntimeStatus {
  switch (event) {
    case "created":
      return "creating";
    // 完成事件直接落到终态。
    case "completed":
      return "completed";
    case "error":
      return "failed";
    // 这些事件都表示仍在运行。
    case "prompt_sent":
    case "resumed":
    case "streaming":
    case "permission_request":
    case "permission_resolved":
    case "elicitation_request":
    case "elicitation_resolved":
      return "streaming";
    // 更新事件只同步元数据，不是新一轮流式。
    case "updated":
      // Bugfix: /model、/mode、/think 这类 Bot 配置更新只同步 task 元数据/configOptions，
      // 并没有启动一次 assistant streaming。之前把 updated 映射成 streaming，
      // 会让当前对话一直显示 loading。
      // updated 事件必须由 "streaming" 改回 "ready"，清掉 loading 指示，避免配置更新被当成流式。
      return "ready";
  }
}
