// ============================================================
// executor/approval-gate.ts —— ask 的最后一道路由：工具自报的审批门 + 选项策略
// ============================================================
// permission-flow 已判定 ask 之后才调用这里：把工具 `prepareApproval` 的回答（proceed / 带预览的 ask）
// 与 `permission.askOptions.allowAlways` 折叠成"这次确认窗该携带什么"，不改判定本身。
// 单向不变量：只能把 ask 变成 proceed 或补上预览，永远不能把 allow/deny 反向改成 ask。
// fail-closed：预览生成失败只降级预览，ask 照旧成立——生成预览的钩子无权替用户放行。
// 这里的输出会一路带到 broker 载荷与 UI，因此 display/optionsPolicy 的缺席都各有语义，见字段注释。

import {
  traceContextToLogContext,
  type PermissionOptionsPolicy,
  type ToolResultDisplayPayload,
  type TraceContext,
} from "@zcode/contracts";
import type { ExecutableToolCall, ToolEntry } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";

interface ResolvedToolApproval {
  // proceed = 工具声明"这份输入无需人工确认"，permission-flow 会直接放行且不累计审批等待；
  // ask = 仍要弹确认窗（默认值，也是工具没声明审批门时的结果）。
  gate: "ask" | "proceed";
  // 确认窗里的预览载荷；只在 ask 且 prepareApproval 返回了 display 时出现，proceed 不带。
  display?: ToolResultDisplayPayload;
  // 选项收窄策略；undefined = 不额外收窄，保持 broker 的默认选项集合。
  optionsPolicy?: PermissionOptionsPolicy;
}

/**
 * 在权限服务已判定 ask 之后调用工具自报的 `prepareApproval`，并把它的答复与工具声明的
 * 选项策略折叠成"这次 ask 该携带什么"。
 *
 * 方向是单向收窄：钩子只能把 ask 放行成 proceed 或给它补上预览，永远不能把 allow 变成 ask。
 * 没有声明钩子的工具一律照旧弹窗。
 */
function resolveOptionsPolicy(
  allowAlways: false | "session" | undefined,
): PermissionOptionsPolicy | undefined {
  switch (allowAlways) {
    // false = 工具明确禁止"永久允许"（例如每次脚本都不同的 CreateWorkflow）：
    // 持久规则记不住可比的决定，只会永久关掉这道确认。
    case false:
      return "no-always-allow";
    // "session" = 只写 runtime 内存的会话规则，重启/冷恢复即失效，不落项目规则。
    case "session":
      return "session-always-allow";
    default:
      // 未声明（undefined）= 沿用 broker 默认选项集，不做任何收窄。
      return undefined;
  }
}

/**
 * 把工具的审批门结论翻译成 permission-flow 可消费的 gate。
 * 输入是当前待执行入参（与 handler 将拿到的同一份），输出只描述"这次 ask 携带什么"；
 * 不做 durable 写入，唯一副作用是预览失败时的一条 warn 日志。
 * 规则/deny 已在调用前判定，这里既看不到也不改变判定；即使 prepareApproval 认为可执行，
 * 也只是"无需预览式确认"，不是对 deny 的推翻。
 */
export function resolveToolApproval(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  entry: ToolEntry,
  executionInput: unknown,
  traceContext: TraceContext,
): ResolvedToolApproval {
  // `permission` 类型上是必填，但 executor 也会被只声明了一部分字段的 entry 驱动
  // （测试桩、动态注册的工具）。周边代码靠 spread 而不是读字段来容忍这一点，gate 同理。
  const optionsPolicy = resolveOptionsPolicy(entry.permission?.askOptions?.allowAlways);

  if (!entry.prepareApproval) {
    // 未声明审批门的工具一律弹窗；optionsPolicy 仍要透传——选项收窄与"有没有预览"是两件事。
    return { gate: "ask", ...(optionsPolicy ? { optionsPolicy } : {}) };
  }

  try {
    // 工作目录与 handler 拿到的是同一个来源（deps 的 getWorkingDirectory 在 impl.ts 里已把
    // 静态 workingDirectory 兜进去），否则预览会去看一个目录、执行会去写另一个。
    const gate = entry.prepareApproval(executionInput);
    // proceed 是工具自报的"无需人工确认"：permission-flow 会按 allow 收口且不累计等待，
    // 因此这里不再附带 display/optionsPolicy（它们只对确认窗有意义）。
    if (gate.gate === "proceed") return { gate: "proceed" };
    return {
      gate: "ask",
      ...(gate.display ? { display: gate.display } : {}),
      ...(optionsPolicy ? { optionsPolicy } : {}),
    };
  } catch (error) {
    // Bug 预防：负责生成预览的钩子绝不能决定"用户是否被询问"。向执行侧 fail-open 等于
    // 静默运行了一个未获批准的工具，所以这里 ask 照旧成立，只让预览降级。
    deps.logger?.warn("Tool approval preview failed; asking without a preview", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "tool.permission.approval_preview_failed",
      module: "core.tool.executor",
      status: "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    return { gate: "ask", ...(optionsPolicy ? { optionsPolicy } : {}) };
  }
}
