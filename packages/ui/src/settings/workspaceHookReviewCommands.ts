// INV-01 先登记再发送：守住位置 命令信封登记；改错故障 回执到达时找不到对应命令。
// INV-02 回执必应用：守住位置 收尾块之前的调用；改错故障 待定表永久残留。
// INV-03 三种状态都算接受：守住位置 布尔表达式；改错故障 幂等重放被当成失败。
// INV-04 原因码只在存在时附带：守住位置 条件展开；改错故障 出现未定义字段。
// INV-05 结算通知必定执行：守住位置 收尾块；改错故障 异常路径下调用方一直等待。
// INV-06 目标转换只透传精确字段：守住位置 映射函数；改错故障 多余字段跨进程泄漏。
// INV-07 远程会话可选：守住位置 条件展开；改错故障 本地会话被写成远程。
// INV-08 摘要与代次一起带上：守住位置 字段列表；改错故障 审核请求对不上产物。
// INV-09 工作区键优先显式身份：守住位置 空值合并；改错故障 同一路径不同身份被混用。
// INV-10 身份不一致直接拒绝：守住位置 入口判断；改错故障 为其他工作区授予信任。
// INV-11 无绑定才走兜底授权：守住位置 命令绑定查找之后；改错故障 有会话时绕过了审核。
// INV-12 兜底不可用返回能力错误：守住位置 早退分支；改错故障 用户看到无原因失败。
// INV-13 请求失败可降级为快照授权：守住位置 原因码白名单；改错故障 保存新钩子后完全无法信任。
// INV-14 等待有上限：守住位置 默认超时常量；改错故障 请求丢失时界面永久挂起。
// INV-15 超时给出专用原因码：守住位置 空绑定分支；改错故障 上层只能看到泛化错误。
// INV-16 审核只信任单一评审项：守住位置 决策数组；改错故障 一次点击信任整批钩子。
// INV-17 单次动作只响应一次：守住位置 响应命令；改错故障 重复响应被服务端拒绝。
// INV-18 静态快照只提供目标：守住位置 键的选择；改错故障 用本地快照替代权威审核。
//
// 模块职责：把设置页的钩子信任动作翻译成协议命令并处理等待与降级。
// 状态所有权：无本地状态，绑定与待定命令都来自共享 store 与注册表。
// 阅读顺序：先看命令发送与目标映射，再看信任流程的分支顺序。
import type {
  CommandPayloadMap,
  CommandType,
  WorkspaceHookReviewRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";
import type { Hook } from "@zcode/shared";
import {
  findWorkspaceHookCommandBinding,
  findWorkspaceHookReviewBindingForItem,
  useWorkspaceHookReviewStore,
  waitForWorkspaceHookReviewBindingForItem,
  type WorkspaceHookCommandBinding,
} from "@/store/workspaceHookReviewStore.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";

// 先 createCommandEnvelope + pendingCommandRegistry.record() 落待定命令。
// ack 无论 accepted 与否都走 pendingCommandRegistry.applyAck()。
// accepted 由 accepted / duplicate / noop 三种 status 取或。
// reasonCode 只在 ack 里有时才展开进返回值。
// finally 里调 binding.onCommandSettled(commandId) 通知调用方。
export async function sendWorkspaceHookCommand<T extends CommandType>(
  binding: Pick<WorkspaceHookCommandBinding, "sendCommand" | "onCommandSettled">,
  sessionId: string,
  type: T,
  payload: CommandPayloadMap[T],
): Promise<{ accepted: boolean; reasonCode?: string }> {
  const envelope = createCommandEnvelope({ type, sessionId, payload } as never);
  pendingCommandRegistry.record(envelope);
  try {
    const ack = await binding.sendCommand(envelope);
    pendingCommandRegistry.applyAck(envelope, ack);
    return {
      accepted: ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop",
      ...(ack.reasonCode ? { reasonCode: ack.reasonCode } : {}),
    };
  } finally {
    binding.onCommandSettled?.(envelope.commandId);
  }
}

// 只转发 sessionId 等精确目标字段，不把整个 request 展开。
// remoteSessionId 有值才展开，远程会话可选。
// workspaceIdentity 与 bundleDigest 原样携带。
// reviewFlowId 与 generation 用于运行时对齐审核流。
// interactionId 指向本次请求，回执按它匹配。
export function toWorkspaceHookReviewCommandTarget(request: WorkspaceHookReviewRequestPayload) {
  return {
    sessionId: request.sessionId,
    taskId: request.taskId,
    runId: request.runId,
    ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
    workspaceIdentity: request.workspaceIdentity,
    bundleDigest: request.bundleDigest,
    reviewFlowId: request.reviewFlowId,
    generation: request.generation,
    interactionId: request.interactionId,
  };
}

const DEFAULT_REVIEW_WAIT_TIMEOUT_MS = 5_000;

function shouldGrantCurrentWorkspaceSnapshot(reasonCode: string | undefined): boolean {
  return (
    reasonCode === "workspace_hooks_require_trust_capable_host" ||
    reasonCode === "workspace_hooks_snapshot_mismatch" ||
    reasonCode === "workspace_hooks_bundle_changed"
  );
}

/**
 * Settings 行内 Trust 的单次用户动作：已有精确 flow 时直接 respond；否则先通过当前
 * session command binding 请求 flow，再等待 Runtime 投影出的 immutable request。
 * 当前 session 的 immutable snapshot 无法审核 Settings bundle 时，转由 workspace
 * Agent authority 重新发现 canonical snapshot；UI 静态 snapshot 始终只提供 exact target。
 */
// workspaceKey 取 workspaceIdentity?.trim()，为空才回落到 workspacePath。
// 键为空或与 workspaceHook.workspaceIdentity 不等时返回 snapshot_mismatch。
// 没有 commandBinding 时先试 grantCurrentWorkspaceSnapshot 兜底。
// 兜底也拿不到授权就返回 require_trust_capable_host。
// request 被拒且 shouldGrantCurrentWorkspaceSnapshot 命中时再兜底一次。
export async function trustWorkspaceHookWithReview(input: {
  hook: Hook;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  reviewWaitTimeoutMs?: number;
  grantWithoutSession?: (target: {
    workspacePath: string;
    workspaceIdentity?: string;
    bundleDigest: string;
    hookDeclarationDigest: string;
  }) => Promise<{ accepted: boolean; reasonCode?: string }>;
}): Promise<{ accepted: boolean; reasonCode?: string }> {
  const workspaceHook = input.hook.workspaceHook;
  const workspaceKey = input.workspaceIdentity?.trim() || input.workspacePath;
  if (!workspaceHook || !workspaceKey || workspaceHook.workspaceIdentity !== workspaceKey) {
    return { accepted: false, reasonCode: "workspace_hooks_snapshot_mismatch" };
  }
  const grantCurrentWorkspaceSnapshot = () => {
    if (!input.grantWithoutSession || !input.workspacePath) return undefined;
    return input.grantWithoutSession({
      workspacePath: input.workspacePath,
      ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
      bundleDigest: workspaceHook.bundleDigest,
      hookDeclarationDigest: workspaceHook.hookDeclarationDigest,
    });
  };
  const reviewTarget = {
    workspacePath: input.workspacePath,
    workspaceIdentity: input.workspaceIdentity,
    bundleDigest: workspaceHook.bundleDigest,
    reviewItemId: workspaceHook.reviewItemId,
  };
  let reviewBinding = findWorkspaceHookReviewBindingForItem(
    useWorkspaceHookReviewStore.getState().bindings,
    reviewTarget,
  );

  if (!reviewBinding) {
    const commandBinding = findWorkspaceHookCommandBinding(
      useWorkspaceHookReviewStore.getState().commandBindings,
      input.workspacePath,
      input.workspaceIdentity,
    );
    if (!commandBinding) {
      const granted = grantCurrentWorkspaceSnapshot();
      if (granted) return granted;
      return {
        accepted: false,
        reasonCode: "workspace_hooks_require_trust_capable_host",
      };
    }
    const requested = await sendWorkspaceHookCommand(
      commandBinding,
      commandBinding.sessionId,
      "requestWorkspaceHookReview",
      {
        sessionId: commandBinding.sessionId,
        ...(commandBinding.remoteSessionId
          ? { remoteSessionId: commandBinding.remoteSessionId }
          : {}),
        workspaceIdentity: workspaceHook.workspaceIdentity,
        bundleDigest: workspaceHook.bundleDigest,
      },
    );
    if (!requested.accepted) {
      // 只要存在活跃 session binding 就把 Trust 固定路由给该
      // session；Settings 保存新 Hook 后，活跃 session 仍持有启动时不可变 snapshot，
      // 因而无法审核当前 bundle，却也阻断了本来安全可用的 workspace pretrust。
      if (shouldGrantCurrentWorkspaceSnapshot(requested.reasonCode)) {
        const granted = grantCurrentWorkspaceSnapshot();
        if (granted) return granted;
      }
      return requested;
    }

    reviewBinding = await waitForWorkspaceHookReviewBindingForItem(
      reviewTarget,
      input.reviewWaitTimeoutMs ?? DEFAULT_REVIEW_WAIT_TIMEOUT_MS,
    );
    if (!reviewBinding) {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_interaction_timeout",
      };
    }
  }

  const request = reviewBinding.request;
  return sendWorkspaceHookCommand(reviewBinding, request.sessionId, "respondWorkspaceHookReview", {
    ...toWorkspaceHookReviewCommandTarget(request),
    decision: {
      action: "trust_selected",
      reviewItemIds: [workspaceHook.reviewItemId],
    },
  });
}
