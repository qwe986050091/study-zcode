// v4 命令原生执行器。
//
// 逐命令原生化的推进方式：handlers/ 注册表列出已原生的命令；binder 只在 supports
// 命中时走本执行器，未命中回落旧桥（binder 侧回落，随每条命令原生化逐条消失）。
// 完成定义：原生 handler + L2 闭环 + L3 e2e，且写路径不经旧协议代码。
import type { CommandEnvelope, CommandResult } from "@zcode/shared/zcode-protocol-v4";
import { NATIVE_HANDLERS } from "./handlers/index.js";
import type { V4CommandCoreHost } from "./types.js";

const SELECTION_SIDE_CHAT_RESTRICTED_COMMANDS = new Set<CommandEnvelope["type"]>([
  "sendGoalCommand",
  "pauseGoal",
  "resumeGoal",
  "editUserQuery",
  "retryTurn",
  "forkAssistant",
  "discardSharedContext",
]);

/**
 * 侧边会话（selection_side_chat）的命令白名单守卫。
 * 该任务类型的 child 会话只承接选区追问，不具备改写目标、历史与血统的能力
 * （goal / edit / retry / fork / 共享上下文撤销）。命中黑名单直接抛错，
 * 由 gateway 归入 rejected ACK；拒绝即拒绝，不得降级到父会话执行。
 * 无副作用：守卫在任何 handler 之前完成，失败时没有 durable 写入。
 */
export class V4SelectionSideChatRestrictedCommandError extends Error {
  readonly reasonCode = "guard.selectionSideChatRestrictedCommand";

  constructor(command: CommandEnvelope["type"]) {
    super(`selection_side_chat 不允许执行 ${command}`);
    this.name = "V4SelectionSideChatRestrictedCommandError";
  }
}

export { V4SessionNotFoundError } from "./record-access.js";

/**
 * v4 原生命令执行器：把已准入 envelope 分派给 handlers 注册表。
 * - supports() 是 binder 的分流依据；未命中回落旧桥（过渡期行为，不是错误）。
 * - execute() 只负责「是否允许执行 + 调用 handler」，不做幂等/CAS/定序——
 *   那些由 CommandInbox 在持有 session admission 期间完成。
 * - 本类不写 projection、不发 ACK；handler 的返回值与抛出错误由 gateway 统一收口
 *   （undefined = accepted 且无 result，不是失败）。
 * - 注入的 __v4Admission / __v4ExecutionContext 是内部锚点（admissionSeq 权威顺序、
 *   sourceCommandId/queueItemId 对账），不属于协议载荷，不回显给客户端。
 */
export class V4CommandExecutor {
  constructor(private readonly host: V4CommandCoreHost) {}

  /** 已原生化的命令集（binder 据此分流；全部命中后旧桥整体删除）。 */
  supports(type: CommandEnvelope["type"]): boolean {
    return type in NATIVE_HANDLERS;
  }

  /**
   * 执行单条已通过准入的命令。
   * 输入：envelope（commandId/clientId/sessionId/type/payload/baseRevision 等），
   * 可选 admission（admissionSeq/admittedAt/queueItemId）与 executionContext
   * （目前只有内部 auto-drain 的 autoDrainPromotion 标记）。
   * 输出：handler 的 CommandResult；undefined 表示「成功且无附加 result」。
   * 副作用：全部由 handler 决定（durable 写入 / core 事件 / 导航结果）；
   * 本方法只增加一道侧边会话守卫，不额外改状态。
   * 失败：命令未注册抛「不支持」，被禁命令抛受限错误，其余错误原样上抛（不吞错、
   * 不伪造成功），由 gateway 转成 rejected/failed ACK。
   */
  async execute(
    envelope: CommandEnvelope,
    admission?: V4CommandAdmission,
    executionContext?: V4CommandExecutionContext,
  ): Promise<CommandResult | undefined> {
    if (
      envelope.sessionId &&
      SELECTION_SIDE_CHAT_RESTRICTED_COMMANDS.has(envelope.type) &&
      this.host.getRecord(envelope.sessionId)?.taskType === "selection_side_chat"
    ) {
      throw new V4SelectionSideChatRestrictedCommandError(envelope.type);
    }
    const handler = NATIVE_HANDLERS[envelope.type as keyof typeof NATIVE_HANDLERS];
    if (!handler) {
      throw new Error(`v4 native executor does not support: ${envelope.type}`);
    }
    return handler(this.host, {
      ...envelope,
      ...(admission ? { __v4Admission: admission } : {}),
      ...(executionContext ? { __v4ExecutionContext: executionContext } : {}),
    });
  }
}

/**
 * 命令准入锚点（内存态，由 CommandInbox 在持有 session gate 期间生成）。
 * admissionSeq 是同一 session 内真实串行顺序的权威序号（不是 issuedAt）；
 * queueItemId 是 session_input 账本与 optimistic overlay 的收口 key，
 * 必须与 commandId 稳定绑定，重试时不得变化。
 * admittedAt 仅用于遥测与展示排序，不参与冲突裁决。
 */
export interface V4CommandAdmission {
  admissionSeq: number;
  admittedAt: number;
  queueItemId: string;
}

/**
 * 命令的内部执行上下文（不入协议）。目前只有 auto-drain 自动提升会置
 * autoDrainPromotion=true，提示 handler 必须以 idle-only 租约提升，不得抢占前台。
 */
export interface V4CommandExecutionContext {
  /** 内部 auto-drain 必须在 reserve 前由 handler 原子校验 Core idle。 */
  autoDrainPromotion?: true;
}

/** 带内部锚点的 envelope 视图；仅 commands 层内部使用。 */
export type V4AdmittedCommandEnvelope = CommandEnvelope & {
  __v4Admission?: V4CommandAdmission;
  __v4ExecutionContext?: V4CommandExecutionContext;
};

/**
 * 读取 envelope 上的准入锚点。
 * 缺失时（测试夹具、兼容直连）退化为 admissionSeq=0、admittedAt=now、
 * queueItemId=`queue_<commandId>`：仍由 commandId 稳定派生，保证幂等与 overlay
 * 对账可用，但不写任何持久事实，也不代表真实定序。
 */
export function commandAdmissionOf(envelope: CommandEnvelope): V4CommandAdmission {
  return (
    (envelope as V4AdmittedCommandEnvelope).__v4Admission ?? {
      admissionSeq: 0,
      admittedAt: Date.now(),
      queueItemId: `queue_${envelope.commandId}`,
    }
  );
}

/** 读取内部执行上下文；仅 auto-drain 自动提升会带 autoDrainPromotion。 */
export function commandExecutionContextOf(
  envelope: CommandEnvelope,
): V4CommandExecutionContext | undefined {
  return (envelope as V4AdmittedCommandEnvelope).__v4ExecutionContext;
}
