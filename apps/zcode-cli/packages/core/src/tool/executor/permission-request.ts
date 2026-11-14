// ============================================================
// executor/permission-request.ts —— 一次审批请求的生命周期
// ============================================================
// 把一个 ask 变成"已登记、已发布、已收口"的完整请求：broker 登记与应答、PermissionRequested
// 事件发布、PermissionRequest hook 竞速，以及外层取消。
// 输入：已判定的 decision、当前执行入参、建议规则、审批门产物（display/optionsPolicy）。
// 输出：竞速胜出的 PermissionBrokerResult（附 source=hook|broker），不含 durable 写入。
// 副作用：登记 broker 应答、发布 PermissionRequested、可能跑 PermissionRequest hook、写日志；
//   返回前无条件 abort 本地 controller 并解绑父 signal，避免监听器泄漏到下一次调用。
// 顺序不变量：事件发布必须晚于 broker 登记（否则立即响应会早于 deferred，确认窗可见却点不动）；
//   请求只发布一次；取消后不得再发布。
// 失败语义：取消 → ToolCancelled（recoverable）；broker 拒绝（超时/失败）原样上抛，由
//   permission-flow 统一决定它算权限拒绝还是执行失败。

import {
  CoreErrorType,
  createCoreError,
  traceContextToLogContext,
  type CollaborationMode,
  type PermissionBrokerRequest,
  type PermissionOptionsPolicy,
  type ToolResultDisplayPayload,
  type PermissionUpdate,
  type TraceContext,
} from "@zcode/contracts";
import type { PermissionDecisionResult } from "../../permission/service.js";
import type { ExecutableToolCall } from "../types.js";
import { emitPermissionRequested } from "./events.js";
import { runPermissionRequestHooks } from "./hook-flow.js";
import { racePermissionResponders } from "./permission-responder-race.js";
import { linkAbortSignal } from "./timeout.js";
import type { ToolExecutorDeps } from "./types.js";

/** 同一个请求生命周期；user-once 和重判后的请求只关闭 Hook 应答方，不另起审批流水线。 */
export async function requestPermissionResponse(params: {
  deps: ToolExecutorDeps;
  toolCall: ExecutableToolCall;
  input: unknown;
  decision: PermissionDecisionResult;
  mode: CollaborationMode;
  requestId: string;
  traceContext: TraceContext;
  suggestedPermissionUpdates: PermissionUpdate[];
  approval?: { display?: ToolResultDisplayPayload; optionsPolicy?: PermissionOptionsPolicy };
  runHooks: boolean;
  signal?: AbortSignal;
}) {
  const { deps, toolCall, input, decision, mode, requestId, traceContext, signal } = params;
  // 本地 controller 把"外层取消"与"竞速胜者 abort 败者"隔开：外层 signal 只单向转发进来。
  const controller = new AbortController();
  const unlink = linkAbortSignal(signal, controller);
  // registered 只在异步 broker 实现里存在；published 是"登记完成后再发布"的链。
  let published: Promise<void> | undefined;
  let registered: Promise<void> | undefined;
  // 取消走单独的 promise：它要能打断"等登记/等应答"，而不是等慢 IO 跑完。
  const cancellation = Promise.withResolvers<never>();
  const onAbort = () =>
    // 取消必须是 ToolCancelled（recoverable）：模型应理解为"这次没跑"，而不是权限拒绝。
    cancellation.reject(
      createCoreError(CoreErrorType.ToolCancelled, "Permission request cancelled", {
        recoverable: true,
      }),
    );
  controller.signal.addEventListener("abort", onAbort, { once: true });
  // 父 signal 已取消时 link 会同步 abort，这里补一次，避免"监听器注册晚于 abort"的窗口。
  if (controller.signal.aborted) onAbort();
  // 根因：先发布会让立即响应早于 deferred 登记；异步 broker 必须明确通知登记完成。
  const outcome = racePermissionResponders({
    signal: controller.signal,
    requestBroker: (brokerSignal, claimResponse) => {
      // 载荷只做投影，不改变判定：reason/riskLevel/ruleId 来自已判定的 decision，
      // optionsPolicy 来自工具审批门，approvalMode 决定客户端可选项（user-once 时不可持久化规则）。
      const response = deps.permissionBroker.requestPermission(
        {
          input,
          mode,
          requestId,
          requestedAt: new Date(),
          reason: decision.reason ?? "Tool requires approval",
          riskLevel: decision.riskLevel,
          ruleId: decision.ruleId,
          sessionId: deps.sessionId,
          sideEffectScope: decision.sideEffectScope,
          suggestedPermissionUpdates: params.suggestedPermissionUpdates,
          ...(decision.approvalMode ? { approvalMode: decision.approvalMode } : {}),
          ...(params.approval?.optionsPolicy
            ? { optionsPolicy: params.approval.optionsPolicy }
            : {}),
          toolCallId: toolCall.id as PermissionBrokerRequest["toolCallId"],
          toolName: toolCall.name,
          traceId: traceContext.traceId,
          turnId: traceContext.turnId ?? deps.turnId,
        },
        { signal: brokerSignal, timeoutMs: deps.permissionTimeoutMs, claimResponse },
      );
      // registered 只表示"请求可被响应"，不持有授权状态；绝不能据此放行。
      registered = response.registered;
      const publish = async () => {
        // 登记可能晚于取消收口；不能重新发布已经失效的请求。
        if (controller.signal.aborted) return;
        await emitPermissionRequested(
          deps,
          toolCall,
          input,
          requestId,
          decision.riskLevel,
          decision.reason,
          params.suggestedPermissionUpdates,
          traceContext,
          { ...params.approval, approvalMode: decision.approvalMode },
        );
      };
      // 有 registered 时发布排在登记之后；同步登记实现则直接发布，保证"可见即可答"。
      published = registered ? registered.then(publish) : publish();
      return response;
    },
    runHooks: async (hookSignal) => {
      // hook 与 broker 并发、但不占用确认窗：先等登记完成，再在 hookSignal 上跑链；
      // runHooks=false（user-once/重判轮）直接退赛，保证请求一定落到用户。
      if (!params.runHooks) return undefined;
      if (registered) await registered;
      if (hookSignal.aborted) return undefined;
      return runPermissionRequestHooks(
        deps,
        toolCall,
        input,
        requestId,
        decision,
        mode,
        traceContext,
        hookSignal,
      );
    },
    onHookFailure: (error) =>
      deps.logger?.warn("PermissionRequest hook chain failed; waiting for client decision", {
        // 拆分应答等待模块后仍保留原 trace/event，便于关联 Hook 退赛与最终用户响应。
        ...traceContextToLogContext(traceContext),
        event: "tool.permission.hook_race_forfeited",
        module: "core.tool.executor",
        requestId,
        status: "waiting",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
  });
  try {
    // 登记/发布与应答共同完成才可执行；取消或应答失败不等待慢 IO 的登记。
    // 两个完成条件并列：事件真的发出（published）+ 应答落地（outcome），任一取消都抢先 reject。
    const [, settled] = await Promise.race([
      Promise.all([published, outcome]),
      cancellation.promise,
    ]);
    // 竞速可能先拿到 allow，但父 signal 已取消时仍不能执行（取消语义优先于授权）。
    if (signal?.aborted)
      throw createCoreError(CoreErrorType.ToolCancelled, "Permission request cancelled", {
        recoverable: true,
      });
    return settled;
  } finally {
    // 先解绑本地监听，再 abort：胜者已 resolve，败者收到取消后自行收尾；unlink 防父 signal 监听器泄漏。
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
    unlink();
  }
}
