import { RewindScope } from "../deps.js";
import type { MessageId } from "../deps.js";
import type { ParsedRewindCommand } from "../types.js";

/**
 * 解析 `/compact` 命令，返回三态结果。
 *
 * - undefined：是 compact 命令但没有附加指令（`/compact` 或空白参数）；
 * - string：是 compact 命令并带自定义指令（已 trim）；
 * - null：不是 compact 命令，交由其它命令解析器处理。
 * 用 null 而不是 undefined 区分"不是该命令"，避免调用方把普通输入当成 compact。
 * 纯函数，无副作用。
 */
export function parseCompactCommand(input: string): string | undefined | null {
  const trimmed = input.trim();
  if (trimmed === "/compact") {
    return undefined;
  }
  if (trimmed.startsWith("/compact ")) {
    const instructions = trimmed.slice("/compact ".length).trim();
    return instructions.length > 0 ? instructions : undefined;
  }
  return null;
}

/**
 * 解析 `/fork` 与 `/rewind` 系列命令（含 message/cascade/checkpoint 目标）。
 *
 * 解析顺序（先精确、后前缀，保证不被误判）：
 * 1. `/fork`、`/fork ...` → fork（可带 checkpointId）；
 * 2. `/rewind`、空参数/status/help → status 查询；
 * 3. `fork` 子命令 → fork；
 * 4. `cascade <scope> <messageId>` → cascade-message；
 * 5. `<scope> <messageId>` → 单 message 回滚；
 * 6. `latest` → apply 最新检查点；
 * 7. 其余非空参数一律当作 checkpointId → apply。
 *
 * 输入：用户原始输入（可能带首尾空白）。
 * 输出：ParsedRewindCommand；不是该系列命令返回 null。
 * 失败语义：参数格式不合法但不匹配任何规则时不会返回 null，而是退化为
 * "把整段当作 checkpointId"的 apply；这是既有交互约定，由执行层报"找不到检查点"。
 * 纯函数，无副作用。
 */
export function parseRewindCommand(input: string): ParsedRewindCommand | null {
  const trimmed = input.trim();
  if (trimmed === "/fork") {
    return { action: "fork" };
  }
  if (trimmed.startsWith("/fork ")) {
    const args = trimmed.slice("/fork ".length).trim();
    return parseForkCommandArgs(args);
  }
  if (trimmed === "/rewind") {
    return { action: "status" };
  }
  if (!trimmed.startsWith("/rewind ")) {
    return null;
  }

  const args = trimmed.slice("/rewind ".length).trim();
  if (args.length === 0 || args === "status" || args === "help" || args === "-h") {
    return { action: "status" };
  }
  if (args === "fork") {
    return { action: "fork" };
  }
  if (args.startsWith("fork ")) {
    return parseForkCommandArgs(args.slice("fork ".length).trim());
  }
  if (args.startsWith("cascade ")) {
    const cascadeCommand = parseMessageRewindArgs(args.slice("cascade ".length).trim());
    if (cascadeCommand?.action === "message") {
      return {
        ...cascadeCommand,
        action: "cascade-message",
      };
    }
  }
  const messageCommand = parseMessageRewindArgs(args);
  if (messageCommand) {
    return messageCommand;
  }
  if (args === "latest") {
    return { action: "apply" };
  }

  return {
    action: "apply",
    targetCheckpointId: args,
  };
}

/**
 * 解析"作用域 + 消息 id"两段式回滚参数。
 *
 * 必须恰好两段：第一段必须是已知作用域（conversation/message、code/workspace、both），
 * 第二段作为 MessageId。段数不符或作用域未知返回 null，让调用方尝试其它解释。
 * 纯函数，无副作用。
 */
function parseMessageRewindArgs(args: string): ParsedRewindCommand | null {
  const parts = args.split(/\s+/).filter(Boolean);
  if (parts.length !== 2) return null;

  const scope = rewindScopeFromCommand(parts[0]!);
  if (!scope) return null;

  return {
    action: "message",
    scope,
    targetMessageId: parts[1]! as MessageId,
  };
}

/**
 * 把命令别名映射到 RewindScope 枚举。
 *
 * 别名分组：conversation/message → Conversation（仅对话），code/workspace → Workspace
 * （仅代码），both → Both。未知值返回 undefined，由调用方判为参数非法。
 * 纯函数，无副作用。
 */
function rewindScopeFromCommand(value: string): RewindScope | undefined {
  switch (value) {
    case "conversation":
    case "message":
      return RewindScope.Conversation;
    case "code":
    case "workspace":
      return RewindScope.Workspace;
    case "both":
      return RewindScope.Both;
    default:
      return undefined;
  }
}

/**
 * 解析 `/fork` 的参数：空参数或 `latest` 表示从最新检查点 fork，其余视为 checkpointId。
 *
 * 总是返回 action=fork，不做合法性失败——目标不存在由执行层报错，解析层保持宽松。
 * 纯函数，无副作用。
 */
function parseForkCommandArgs(args: string): ParsedRewindCommand {
  if (args.length === 0 || args === "latest") {
    return { action: "fork" };
  }
  return {
    action: "fork",
    targetCheckpointId: args,
  };
}
