// INV-01 一个会话最多一个 pending，槽位由 currentBySession 独占——守住位置：唯一在审查请求的登记处；改错故障：同一会话并行发起两轮审查时，用户应答错配到另一个交互。
// INV-02 open 对同代际（reviewFlowId/generation/interactionId/bundleDigest 四元组）幂等并复用已登记 flow——守住位置：重复渲染与网络重试的唯一收敛点；改错故障：把重放当新请求而生成第二个 pending。
// INV-03 pending 期间出现不同代际时 open 必须抛错而非替换——守住位置：显式 supersede 的入口守门；改错故障：静默顶掉用户正看着的旧请求，其应答永远悬空。
// INV-04 supersede 先结算旧代际再登记新代际，顺序不可颠倒——守住位置：旧 Promise 的结算时机；改错故障：先覆盖槽位再结算，迟到应答会命中新请求。
// INV-05 替换请求必须保持 sessionId 与 reviewFlowId 不变且 generation 严格递增——守住位置：同一条 flow 的代际单调性；改错故障：旧代际覆盖当前请求，界面与内存态错位。
// INV-06 校验顺序固定为 存在性 → 代际与 pending → 快照，不得重排——守住位置：两类拒绝码的判定优先级；改错故障：先判快照会把已取代误报为 snapshot_mismatch。
// INV-07 快照比对覆盖 sessionId/taskId/runId/remoteSessionId/workspaceIdentity/bundleDigest——守住位置：跨会话与跨运行的隔离边界；改错故障：把 A 会话的选择应用到 B 会话。
// INV-08 决策中每个 reviewItemId 必须属于当前请求的 items，未知 id 归为 snapshot_mismatch——守住位置：请求快照与 UI 快照的一致性；改错故障：接受别的快照里的 item 造成越界改动。
// INV-09 决策 schema 解析失败以异常抛出，而不是返回 accepted:false——守住位置：畸形输入与合法拒绝的分界；改错故障：把解析错误吞成 superseded 让调用方误判为过期。
// INV-10 resolve 先走完整 validate 再 settle，且决策被解析两次——守住位置：接受与结算之间的原子前置条件；改错故障：跳过复验让校验后、结算前的状态变化漏过。
// INV-11 settle 只从 pending 出发并保证 resolveResult 恰好调用一次——守住位置：Promise 只结算一次的保证；改错故障：迟到应答二次结算，调用方拿到两份 outcome。
// INV-12 settle 入口先 clearTimeout 再改 state——守住位置：定时器与状态迁移的先后；改错故障：先改状态后清定时器，到期回调在已结算的 flow 上再跑一遍。
// INV-13 fail 与 closeWithoutDecision 前置条件相同，差别只在 state 与 reasonCode——守住位置：两条退出口的语义区分；改错故障：混用让审计无法分辨是失败还是无决策关闭。
// INV-14 getCurrent 与 flow.state 都返回浅拷贝，内部 state 对象不对外泄露——守住位置：状态读写隔离；改错故障：调用方改返回对象污染注册表里的真实代际。
// INV-15 deadline 定时器延迟取 deadlineAt 与当前时刻之差、负数夹到 0——守住位置：超时延迟的下界；改错故障：已过期请求被延后收口，pending 长时间悬挂。
// INV-16 定时器必须 unref，审查等待不得阻止进程退出——守住位置：进程生命周期的归属；改错故障：遗留 pending 定时器把 CLI 拖住不退出。
// INV-17 超时回调进入 settle 前复查 pending，避免与手动 resolve 竞争——守住位置：超时与应答的竞态窗口；改错故障：两边都触发收口，Promise 结果与 state 不一致。
// INV-18 槽位被新 flow 覆盖后，旧 flow 只能靠自身 timer 或已捕获引用结算——守住位置：旧代际的结算路径；改错故障：依赖槽位反查旧 flow，旧 Promise 永远 pending。
//
// 模块职责：维护会话内工作区 Hook 审查请求的代际登记、应答校验与 Promise 收口，不含持久化与 UI 呈现。
// 状态所有权：currentBySession 是唯一真相，public.state 与 getCurrent 只给出浅拷贝快照。
// 阅读顺序：先 open/supersede 建立代际，再 validate/resolve 接受应答，最后由 fail 与 closeWithoutDecision 收尾。
/**
 * ============================================================================
 * hooks/workspace-hook-review-flow.ts —— 工作区 Hook 审查交互的"代际"管理
 * ============================================================================
 *
 * 每个会话最多一个 pending 的审查请求;每次请求由
 *   reviewFlowId + generation + interactionId + bundleDigest
 * 共同标识。用户/UI 的应答必须与当前代际完全匹配才被接受,否则:
 *   superseded        旧交互已被新请求取代(或根本不存在);
 *   snapshot_mismatch 代际相同但快照(会话/运行/工作区)不一致。
 *
 * 本文件只管理"内存态 + Promise 结果",不做持久化、也不发 UI 事件:
 * 持久化/呈现由调用方负责,这样 review 生命周期可以随 runtime 重建。
 *
 * 【时序】open 可对同代际重复调用(幂等返回现有 flow);要换请求必须显式
 * supersede(且 generation 必须递增);deadline 到点自动 timed_out 并 settle。
 * ============================================================================
 */
import type { WorkspaceHookReasonCode, WorkspaceHookReviewFlowState } from "@zcode/contracts";
import { workspaceHookReviewFlowStateSchema } from "@zcode/contracts";
import {
  workspaceHookReviewDecisionSchema,
  workspaceHookReviewRequestPayloadSchema,
  type WorkspaceHookReviewDecision,
  type WorkspaceHookReviewRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";

export interface WorkspaceHookReviewTarget {
  sessionId: string;
  taskId: string;
  runId: string;
  remoteSessionId?: string;
  workspaceIdentity: string;
  bundleDigest: string;
  reviewFlowId: string;
  generation: number;
  interactionId: string;
}

export interface WorkspaceHookReviewOutcome {
  action: WorkspaceHookReviewDecision["action"] | "no_change";
  reviewItemIds: string[];
  reasonCode: WorkspaceHookReasonCode | undefined;
}

export type WorkspaceHookReviewResolveResult =
  | { accepted: true; reviewItemIds: string[] }
  | {
      accepted: false;
      reasonCode: "workspace_hooks_review_superseded" | "workspace_hooks_snapshot_mismatch";
    };

export interface WorkspaceHookReviewFlow {
  readonly request: WorkspaceHookReviewRequestPayload;
  readonly result: Promise<WorkspaceHookReviewOutcome>;
  readonly state: WorkspaceHookReviewFlowState;
}

interface MutableWorkspaceHookReviewFlow {
  request: WorkspaceHookReviewRequestPayload;
  result: Promise<WorkspaceHookReviewOutcome>;
  resolveResult: (outcome: WorkspaceHookReviewOutcome) => void;
  state: WorkspaceHookReviewFlowState;
  timer?: ReturnType<typeof setTimeout>;
  public: WorkspaceHookReviewFlow;
}

/** Runtime-owned review generation registry. It contains no persistence or UI behavior. */
export class WorkspaceHookReviewFlowRegistry {
  // 注册表按 sessionId 索引，一个会话只保留当前一条 flow，不存历史。
  // 覆盖写入只发生在 open 或 supersede 成功之后，因此任一时刻 map 里至多一条 pending。
  // 旧 flow 被覆盖后无法再从 map 反查，只能由自身 timer 或已捕获的引用完成结算。
  // 并发安全依赖单线程：open/validate/resolve/settle 之间没有 await，不会被交错。
  // 若将来在此引入异步，必须重新论证校验与结算之间状态不变的这一前提。
  // 进程重启即全部丢失，恢复责任在调用方，本类不做任何回放。
  private readonly currentBySession = new Map<string, MutableWorkspaceHookReviewFlow>();

  open(value: WorkspaceHookReviewRequestPayload): WorkspaceHookReviewFlow {
    const request = workspaceHookReviewRequestPayloadSchema.parse(value);
    const current = this.currentBySession.get(request.sessionId);
    if (current && current.state.state === "pending") {
      // 同代际重复 open 视为幂等(网络重试/重复渲染):返回现有 flow,
      // 绝不为同一 interaction 创建第二个 pending。
      if (sameGeneration(current.request, request)) return current.public;
      // 不同代际且已有 pending:必须显式 supersede,否则会静默丢弃用户正在看的旧请求。
      throw new Error("A pending Workspace Hook review must be superseded explicitly");
    }
    const flow = this.createFlow(request);
    this.currentBySession.set(request.sessionId, flow);
    return flow.public;
  }

  supersede(
    target: WorkspaceHookReviewTarget,
    replacement: WorkspaceHookReviewRequestPayload,
  ): WorkspaceHookReviewFlow {
    const current = this.currentBySession.get(target.sessionId);
    if (!current || !matchesGeneration(current.request, target)) {
      throw new Error("Cannot supersede an unknown Workspace Hook review generation");
    }
    // supersede 的前置条件是槽中存在与 target 代际一致的 flow。
    // 找不到或代际不符直接抛错，不静默降级为一次新的 open。
    // 替换必须落在同一条 review flow 上：session 与 flowId 不可变，generation 严格大于当前值。
    // 三个条件任一不满足都是编排错误而非可恢复交互，直接 throw 让 supersede 的调用方暴露 bug。
    // 先解析替换负载再做比较，保证后续 createFlow 用到的是已校验对象。
    const nextRequest = workspaceHookReviewRequestPayloadSchema.parse(replacement);
    if (
      // 替换必须是"同一条 review flow 的下一代":
      //   - session/flowId 不能变(换 flow 等于另起一个交互);
      //   - generation 必须严格递增(防止用旧代际覆盖当前请求)。
      nextRequest.sessionId !== current.request.sessionId ||
      nextRequest.reviewFlowId !== current.request.reviewFlowId ||
      nextRequest.generation <= current.request.generation
    ) {
      throw new Error("Replacement must advance the same Workspace Hook review flow");
    }
    this.settle(current, {
      state: "superseded",
      supersededByInteractionId: nextRequest.interactionId,
      outcome: {
        action: "no_change",
        reviewItemIds: [],
        reasonCode: "workspace_hooks_review_superseded",
      },
    });
    const next = this.createFlow(nextRequest);
    this.currentBySession.set(nextRequest.sessionId, next);
    return next.public;
  }

  validate(
    target: WorkspaceHookReviewTarget,
    decisionValue: WorkspaceHookReviewDecision,
  ): WorkspaceHookReviewResolveResult {
    const current = this.currentBySession.get(target.sessionId);
    if (!current) {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_review_superseded",
      };
    }
    if (!matchesGeneration(current.request, target) || current.state.state !== "pending") {
      // 代际不符或已 settle:应答的是"上一屏"的交互,必须拒绝而不是套用到当前。
      return {
        accepted: false,
        reasonCode: "workspace_hooks_review_superseded",
      };
    }
    // 走到这里代际与 pending 均已匹配，剩下唯一能拒的是会话/运行/工作区快照。
    // 顺序不能与上一段对调：快照相同但代际已过期也必须先报 superseded。
    // bundleDigest 同时出现在代际与快照比对里，任一侧不一致都会被拦下。
    // 拿到 snapshot_mismatch 的调用方应丢弃本地缓存并重新拉取审查请求。
    // 此分支不抛异常，拒绝属于正常的用户交互结果。
    if (!matchesSnapshot(current.request, target)) {
      // 代际相同但会话/运行/工作区快照不一致:不允许把 A 会话的选择应用到 B 会话。
      return {
        accepted: false,
        reasonCode: "workspace_hooks_snapshot_mismatch",
      };
    }
    const decision = workspaceHookReviewDecisionSchema.parse(decisionValue);
    const reviewItemIds = resolveDecisionItemIds(current.request, decision);
    const knownItems = new Set(current.request.items.map((item) => item.reviewItemId));
    if (reviewItemIds.some((reviewItemId) => !knownItems.has(reviewItemId))) {
      // 决策里出现本次请求不存在的 itemId:说明 UI 拿的是别的快照,按 mismatch 拒绝。
      return {
        accepted: false,
        reasonCode: "workspace_hooks_snapshot_mismatch",
      };
    }
    return { accepted: true, reviewItemIds };
  }

  resolve(
    target: WorkspaceHookReviewTarget,
    decisionValue: WorkspaceHookReviewDecision,
  ): WorkspaceHookReviewResolveResult {
    // resolve 不自带准入判断，完全复用 validate 的结论。
    // 中间没有 await，校验通过到 settle 之间不存在槽位被替换的窗口。
    // 决策再次解析是为了拿到强类型对象写 outcome，schema 已在上一步验证过。
    // resolved 态的 reasonCode 固定为 undefined，不携带任何失败原因。
    const validation = this.validate(target, decisionValue);
    if (!validation.accepted) return validation;
    const current = this.currentBySession.get(target.sessionId);
    if (!current) {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_review_superseded",
      };
    }
    const decision = workspaceHookReviewDecisionSchema.parse(decisionValue);
    this.settle(current, {
      state: "resolved",
      outcome: {
        action: decision.action,
        reviewItemIds: validation.reviewItemIds,
        reasonCode: undefined,
      },
    });
    return validation;
  }

  // fail 供上游运行失败或取消使用，要求 pending + 代际 + 快照三重匹配。
  // 任一不满足返回 false 而不抛错，调用方据此判断是否需要补偿。
  // 结算态写 cancelled，reasonCode 原样透传给 Promise 消费者。
  // 它与 closeWithoutDecision 共用前置条件，区分点只在 state 与 reasonCode。
  // 旧代际的 fail 在此天然被挡掉，不会污染当前 flow。
  fail(target: WorkspaceHookReviewTarget, reasonCode: WorkspaceHookReasonCode): boolean {
    const current = this.currentBySession.get(target.sessionId);
    if (
      !current ||
      current.state.state !== "pending" ||
      !matchesGeneration(current.request, target) ||
      !matchesSnapshot(current.request, target)
    ) {
      return false;
    }
    this.settle(current, {
      state: "cancelled",
      outcome: { action: "no_change", reviewItemIds: [], reasonCode },
    });
    return true;
  }

  // 无决策关闭同样要求 pending + 代际 + 快照三重匹配，否则返回 false。
  // 结算态写 resolved 而非 cancelled，outcome 是 no_change 空列表且无 reasonCode。
  // 从 Promise 结果看它与 fail 可能无法区分，调用方需读 getCurrent 的 state 才能分辨。
  // closeWithoutDecision 不产生新请求，只把 current 这一代 settle 成 resolved 并释放槽位。
  closeWithoutDecision(target: WorkspaceHookReviewTarget): boolean {
    const current = this.currentBySession.get(target.sessionId);
    if (
      !current ||
      current.state.state !== "pending" ||
      !matchesGeneration(current.request, target) ||
      !matchesSnapshot(current.request, target)
    ) {
      return false;
    }
    this.settle(current, {
      state: "resolved",
      outcome: { action: "no_change", reviewItemIds: [], reasonCode: undefined },
    });
    return true;
  }

  getCurrentFlow(sessionId: string): WorkspaceHookReviewFlow | undefined {
    return this.currentBySession.get(sessionId)?.public;
  }

  getCurrent(sessionId: string): WorkspaceHookReviewFlowState | undefined {
    const state = this.currentBySession.get(sessionId)?.state;
    return state ? { ...state } : undefined;
  }

  private createFlow(request: WorkspaceHookReviewRequestPayload): MutableWorkspaceHookReviewFlow {
    let resolveResult!: (outcome: WorkspaceHookReviewOutcome) => void;
    const result = new Promise<WorkspaceHookReviewOutcome>((resolve) => {
      resolveResult = resolve;
    });
    const state = workspaceHookReviewFlowStateSchema.parse({
      reviewFlowId: request.reviewFlowId,
      generation: request.generation,
      interactionId: request.interactionId,
      sessionId: request.sessionId,
      workspaceIdentity: request.workspaceIdentity,
      bundleDigest: request.bundleDigest,
      state: "pending",
      createdAt: request.createdAt,
      deadlineAt: request.deadlineAt,
    });
    const flow = {} as MutableWorkspaceHookReviewFlow;
    const publicFlow: WorkspaceHookReviewFlow = {
      request,
      result,
      get state() {
        return { ...flow.state };
      },
    };
    Object.assign(flow, {
      request,
      result,
      resolveResult,
      state,
      public: publicFlow,
    });
    // 定时器只做超时兜底：延迟取 deadline 与当前时刻之差，负数被夹到 0。
    // 回调里先复查 pending，因为 resolve 或 fail 可能已经把这条 flow 结算掉。
    // 超时的 outcome 固定为 no_change + 空 item 列表 + interaction_timeout。
    // 这里不清空 map 槽位：flow 仍可能被 getCurrent 读取用于 UI 收尾。
    flow.timer = setTimeout(
      () => {
        // deadline 到点自动收口为 timed_out:不能让 pending 永久挂着,
        // 否则后续同代际 open 会一直幂等返回一个永远不会被应答的请求。
        if (flow.state.state !== "pending") return;
        this.settle(flow, {
          state: "timed_out",
          outcome: {
            action: "no_change",
            reviewItemIds: [],
            reasonCode: "workspace_hooks_interaction_timeout",
          },
        });
      },
      Math.max(0, request.deadlineAt - Date.now()),
    );
    // unref:审查等待不应阻止进程退出;请求本身由调用方持有。
    // unref 让审查等待不成为进程退出的阻塞源，非 Node 环境无此方法故用可选调用。
    // 即便 unref，settle 仍会 clearTimeout，避免死链定时器长期驻留。
    // 除该 timer 外不持有其他资源句柄，flow 生命周期与 Promise 同步。
    // 调用方若持有 result 却不消费，超时结算后相关引用仍会被释放。
    flow.timer.unref?.();
    return flow;
  }

  private settle(
    flow: MutableWorkspaceHookReviewFlow,
    input: {
      state: "resolved" | "superseded" | "timed_out" | "cancelled";
      supersededByInteractionId?: string;
      outcome: WorkspaceHookReviewOutcome;
    },
  ): void {
    // 只有 pending 能 settle:resolved/superseded/timed_out 之后再来的
    // resolve/fail 都只被视为迟到响应,静默忽略(validate 已在入口拒绝)。
    if (flow.state.state !== "pending") return;
    if (flow.timer) clearTimeout(flow.timer);
    flow.state = workspaceHookReviewFlowStateSchema.parse({
      ...flow.state,
      state: input.state,
      ...(input.supersededByInteractionId
        ? { supersededByInteractionId: input.supersededByInteractionId }
        : {}),
    });
    flow.resolveResult(input.outcome);
  }
}

function sameGeneration(
  left: WorkspaceHookReviewRequestPayload,
  right: WorkspaceHookReviewRequestPayload,
): boolean {
  return (
    left.reviewFlowId === right.reviewFlowId &&
    left.generation === right.generation &&
    left.interactionId === right.interactionId &&
    left.bundleDigest === right.bundleDigest
  );
}

function matchesSnapshot(
  request: WorkspaceHookReviewRequestPayload,
  target: WorkspaceHookReviewTarget,
): boolean {
  return (
    request.sessionId === target.sessionId &&
    request.taskId === target.taskId &&
    request.runId === target.runId &&
    request.remoteSessionId === target.remoteSessionId &&
    request.workspaceIdentity === target.workspaceIdentity &&
    request.bundleDigest === target.bundleDigest
  );
}

function matchesGeneration(
  request: WorkspaceHookReviewRequestPayload,
  target: WorkspaceHookReviewTarget,
): boolean {
  return (
    request.reviewFlowId === target.reviewFlowId &&
    request.generation === target.generation &&
    request.interactionId === target.interactionId
  );
}

function resolveDecisionItemIds(
  _request: WorkspaceHookReviewRequestPayload,
  decision: WorkspaceHookReviewDecision,
): string[] {
  return unique(decision.reviewItemIds);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
