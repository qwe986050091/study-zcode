/**
 * workspace-hook-review-controller：Workspace Hook 软门禁的审核流程控制器（会话级单实例）。
 * 定位：命令（requestReview / respond / toggle / revoke / revokeCurrent）→ 串行化变更 → 校验 flow
 *   绑定（sessionId / workspaceIdentity / bundleDigest / interactionId / generation）→ 落 Trust 或改
 *   配置 → emit Settled / Superseded / Requested / AdmissionUpdated，并重建 pending flow。
 * 所有权：options.store 是 Promise（store 初始化可能晚于控制器构造），grant 前才 await；控制器
 *   自身不关闭 store，也不取消 supervisor。
 * 并发口径：所有变更走 mutationQueue 串行，respond/toggle/revoke 不会交错改同一 bundle；
 *   每次 supersede 递增 generation，旧 flow 的迟到回应一律 superseded。
 * 失败语义：错误分"写前拒绝"（精确 reasonCode 透传）与"写后重建失败"（fail flow + configuration_error）；
 *   catch-all 必须先判断 writeCommitted，不能把一切一律报成 store corrupt。
 */
import {
  SessionEventType,
  type WorkspaceHookBundleSnapshot,
  type WorkspaceHookReasonCode,
} from "@zcode/contracts";
import {
  WorkspaceHookReviewFlowRegistry,
  createWorkspaceHookTrustRecords,
  type WorkspaceHookReviewFlow,
  type WorkspaceHookReviewTarget,
  type WorkspaceHookRuntimeAdmissionPort,
  type WorkspaceHookSnapshotEvaluation,
  type WorkspaceHookTrustCoordinator,
} from "@zcode/core";
import type {
  WorkspaceHookReviewDecision,
  WorkspaceHookReviewRequestPayload,
  WorkspaceHookTrustRevokeTarget,
} from "@zcode/shared/zcode-protocol-v4";
import { WorkspaceHookMutationError } from "@zcode/shared/workspace-hook-mutation";

export type * from "./workspace-hook-review-types.js";
import type {
  WorkspaceHookReviewCommandResult,
  WorkspaceHookReviewControllerOptions,
  WorkspaceHookReviewHostPort,
  WorkspaceHookReviewMutationPort,
  WorkspaceHookTrustStoreMutationPort,
} from "./workspace-hook-review-types.js";
import {
  buildWorkspaceHookReviewRequest,
  resolveWorkspaceHookReviewDigests,
  toWorkspaceHookReviewTarget,
} from "./workspace-hook-review-request.js";
import { WorkspaceHookReviewTelemetry } from "./workspace-hook-review-telemetry.js";
import { superviseWorkspaceHookReviewFlow } from "./workspace-hook-review-supervisor.js";
import { applyWorkspaceHookRevoke } from "./workspace-hook-review-revoke.js";

/**
 * 状态：registry（当前 flow）、supervisedFlows（每 flow 一个监管 promise）、reviewFlowId/generation
 *  与 mutationQueue。WeakMap 保证 flow 被回收后自动解除监管引用。
 * 不变量：一个 flow 只被监管一次；generation 单调递增；reviewFlowId 会话内固定（由首个 flow 铸造）。
 */
export class WorkspaceHookReviewController {
  private readonly admission: WorkspaceHookRuntimeAdmissionPort;
  private readonly appVersion?: string;
  private readonly coordinator: WorkspaceHookTrustCoordinator;
  private readonly host: WorkspaceHookReviewHostPort;
  private readonly telemetry: WorkspaceHookReviewTelemetry;
  private readonly mutation: WorkspaceHookReviewMutationPort;
  private readonly sessionId: string;
  private readonly store: Promise<WorkspaceHookTrustStoreMutationPort>;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly registry = new WorkspaceHookReviewFlowRegistry();
  /** flow → 监管 promise。WeakMap 使 flow 被回收后自动移除，不额外持有引用。 */
  private readonly supervisedFlows = new WeakMap<
    WorkspaceHookReviewFlow,
    Promise<void>
  >();
  private reviewFlowId?: string;
  private generation = 0;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: WorkspaceHookReviewControllerOptions) {
    this.admission = options.admission;
    this.appVersion = options.appVersion;
    this.coordinator = options.coordinator;
    this.host = options.host;
    this.telemetry = new WorkspaceHookReviewTelemetry(
      this.admission,
      options.logger,
    );
    this.mutation = options.mutation;
    this.sessionId = options.sessionId;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  /**
   * 见 workspace-hook-review-supervisor：任何新开 flow 都必须交由它监管。
   *
   * openOrReuseFlow 会复用仍 pending 的同一 flow
   * 对象，因此重复 requestReview 与 revoke 重开路径可能给同一个 flow 各挂一个 supervisor，
   * timeout 时重复 emit ReviewSettled。重复监管与缺监管同病：
   * 按 flow 对象单例化，重复请求直接复用已有的监管 promise。
   */
  private superviseFlow(flow: WorkspaceHookReviewFlow): Promise<void> {
    const existing = this.supervisedFlows.get(flow);
    if (existing) return existing;
    const supervision = superviseWorkspaceHookReviewFlow({
      flow,
      host: this.host,
      registry: this.registry,
      sessionId: this.sessionId,
      telemetry: this.telemetry,
    });
    this.supervisedFlows.set(flow, supervision);
    return supervision;
  }

  /**
   * 软门禁:按需开审核 flow。
   *
   * 用户点击「去审核」时经 requestWorkspaceHookReview 命令调用。
   * 无 pending 项时为安全 no-op(返回 accepted)。
   * 已有活跃 flow 时幂等复用(openOrReuseFlow)。
   * 必须经 superviseFlow 监管——否则 flow 超时后会静默死亡、面板永久失效。
   */
  async requestReview(target: {
    workspaceIdentity: string;
    bundleDigest: string;
  }): Promise<WorkspaceHookReviewCommandResult> {
    const snapshot = this.admission.getCurrentSnapshot();
    if (
      target.workspaceIdentity !== snapshot.workspaceIdentity ||
      target.bundleDigest !== snapshot.bundleDigest
    ) {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_snapshot_mismatch" as const,
      };
    }
    const evaluation = this.coordinator.evaluateSnapshot({ snapshot });
    // 旧实现只把 configuredEnabled=true 的 pending 当成可审核项，导致
    // Settings 把未信任开关锁定后形成死锁——disabled Hook 不会运行、不会触发 Banner，
    // 也永远无法预先建立 Trust。配置 gate 与 Trust 正交；review request 本就携带全部
    // snapshot items，因此按 admissionClass 判断即可，disabled item 信任后仍不会运行。
    const hasPending = evaluation.items.some(
      (item) => item.admissionClass === "pending",
    );
    if (!hasPending) {
      if (evaluation.items.some((item) => item.trustState === "blocked_policy")) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_blocked_by_policy" as const,
        };
      }
      if (evaluation.storeStatus === "corrupt") {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_trust_store_corrupt" as const,
        };
      }
      // 无待审项:安全 no-op
      return { accepted: true, reviewItemIds: [] };
    }
    const flow = await this.openOrReuseFlow(snapshot, evaluation);
    void this.superviseFlow(flow).catch(() => undefined);
    return { accepted: true, reviewItemIds: [] };
  }

  /**
   * 逐项/整体信任裁决。顺序：validate（flow 绑定 + 决策形状）→ 快照绑定复核 → 策略资格前置检查
   *   → 落持久 Trust → registry.resolve → emit Settled → 重评 admission → 重建 pending flow。
   * 口径：落盘已成功但 resolve 被别的终态占用时，仍以 accepted 回报（授权确实生效），只额外记
   *   responseRejected 供观测——绝不把"授权成功"说成"审核过期"。
   * 失败语义：落盘失败透传脱敏 message 并归为 trust_store_corrupt（reasonCode 集合受 contracts 约束）。
   */
  respond(
    target: WorkspaceHookReviewTarget,
    decision: WorkspaceHookReviewDecision,
  ): Promise<WorkspaceHookReviewCommandResult> {
    return this.enqueueMutation(async () => {
      const validation = this.registry.validate(target, decision);
      if (!validation.accepted) {
        this.telemetry.responseRejected(target, validation.reasonCode);
        return validation;
      }
      const flow = this.registry.getCurrentFlow(this.sessionId);
      if (!flow) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_review_superseded" as const,
        };
      }
      const snapshot = this.admission.getCurrentSnapshot();
      // request 绑定打开时的 immutable snapshot bundle。今天
      // replaceSnapshot 只有 toggle 一个合法调用方（经 refreshPendingFlow supersede 旧
      // flow），等价校验靠这一隐式不变量；配置热监听 watcher 一旦成为第二
      // 个调用方且绕过 refreshPendingFlow，tombstone 缺失会让授权落到新 bundle 上。
      // 与 revokeCurrent 对齐显式校验，消除隐式依赖。
      if (
        target.workspaceIdentity !== snapshot.workspaceIdentity ||
        target.bundleDigest !== snapshot.bundleDigest
      ) {
        this.telemetry.responseRejected(
          target,
          "workspace_hooks_snapshot_mismatch",
        );
        return {
          accepted: false,
          reasonCode: "workspace_hooks_snapshot_mismatch" as const,
        };
      }
      // grant 前显式检查 persistent Trust 的 policy 资格：applyDecision 内
      // assertPersistentTrustMutationAllowed 抛出的策略拒绝若落入下方 catch-all，
      // 会被一律报成 trust_store_corrupt（“信任存储损坏”），企业策略收紧时
      // 用户看到的是错误诊断；与 revoke 路径对齐：前置检查 + 精确 reasonCode。
      if (
        !this.coordinator.canMutatePersistentTrust(snapshot.workspaceIdentity)
      ) {
        this.telemetry.responseRejected(
          target,
          "workspace_hooks_blocked_by_policy",
        );
        return {
          accepted: false,
          reasonCode: "workspace_hooks_blocked_by_policy" as const,
        };
      }
      let applied: { grantedRecordCount?: number };
      try {
        applied = await this.applyPersistentTrust(validation.reviewItemIds);
      } catch (error) {
        // applyDecision 可因非存储原因抛错——resolveWorkspaceHookReviewDigests
        // 对未知 reviewItemId、coordinator 内部错误、store 落盘失败等。裸 catch 会把全部
        // 失败一律报成 trust_store_corrupt 且把原始错误彻底丢弃，与 toggle 路径同类。
        // reasonCode 不变（新增需 contracts 评审），仅把
        // errorMessage 透传进 telemetry 供回溯。
        //
        // 脱敏：WorkspaceHookMutationError 的 message 已在上游脱敏
        // （见 workspace-hook-review-mutation.ts 使用 workspaceIdentitySummary / digestSummary）。
        // 对任意 Error 仅取 error.message——上游抛错点必须保证消息不含绝对路径/完整 digest
        // （禁止上报完整 workspace path / source path）。
        this.telemetry.trustStoreFailure(
          target.bundleDigest,
          error instanceof Error ? error.message : String(error),
        );
        return {
          accepted: false,
          reasonCode: "workspace_hooks_trust_store_corrupt" as const,
        };
      }
      this.telemetry.decisionAccepted(target, decision, {
        ...(applied.grantedRecordCount === undefined
          ? {}
          : { grantedRecordCount: applied.grantedRecordCount }),
        requestEnabledCount: flow.request.items.filter(
          (item) => item.configuredEnabled,
        ).length,
      });
      const resolved = this.registry.resolve(target, decision);
      // applyDecision 与 registry.resolve 非原子——两者之间若
      // registry 的 deadline timer 恰好触发，flow 变为 timed_out，resolve 返回
      // superseded，于是「Trust 已落盘」却回报「审核已过期」。用户据此重试、排障者
      // 据此以为没写成功——同样属于错误归属倒错。
      //
      // 决策已经生效（持久 Trust 已落盘），故按 accepted 回报并照发
      // Settled，让前端收敛到已决状态；resolve 被拒仅说明 flow 已被别的终态占用，
      // 不代表授权失败。此处只多不错：不会把未授权说成已授权。
      if (!resolved.accepted) {
        // 保留观测：flow 已被别的终态占用（通常是 deadline 恰好触发）。
        this.telemetry.responseRejected(target, resolved.reasonCode);
      }
      await this.host.emit({
        type: SessionEventType.WorkspaceHookReviewSettled,
        payload: { interactionId: target.interactionId, state: "resolved" },
      });
      // 软门禁:settle 后重新评估 pending 状态,通知投影层更新提示条
      await this.emitAdmissionUpdatedAfterMutation();
      // 行内逐条 Trust 不能让其他待审项一起失去操作入口。旧 generation settle 后，
      // 若仍有 pending 声明，立即发布下一 immutable generation；已信任行由 Settings
      // 刷新后消失，其他行继续可操作。
      await this.refreshPendingFlow(snapshot);
      return resolved.accepted
        ? resolved
        : {
            accepted: true as const,
            reviewItemIds: [...validation.reviewItemIds],
          };
    });
  }

  /**
   * 行内开关（只改配置，不写 Trust）。顺序：validate → 快照项必须 editable → mutation.toggle 写盘并
   *   替换 admission 快照 → 重建 pending flow → 重评 admission。
   * 失败语义：写盘前失败按 MutationError.code 精确透传（不能一律报 config_write_failed）；
   *   写盘后重建失败则 fail flow 并 emit configuration_error（配置已改，flow 不能继续 pending）。
   */
  toggle(
    target: WorkspaceHookReviewTarget,
    reviewItemId: string,
    enabled: boolean,
  ): Promise<
    WorkspaceHookReviewCommandResult & {
      request?: WorkspaceHookReviewRequestPayload;
    }
  > {
    return this.enqueueMutation(async () => {
      const validation = this.registry.validate(target, {
        action: "trust_selected",
        reviewItemIds: [reviewItemId],
      });
      if (!validation.accepted) return validation;
      const currentSnapshot = this.admission.getCurrentSnapshot();
      const entry = currentSnapshot.hooks.find(
        (item) => item.reviewItemId === reviewItemId,
      );
      if (!entry?.editable) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_snapshot_mismatch" as const,
        };
      }
      let writeCommitted = false;
      let nextSnapshot: WorkspaceHookBundleSnapshot;
      try {
        nextSnapshot = await this.mutation.toggle(
          { snapshot: currentSnapshot, reviewItemId, enabled },
          () => {
            writeCommitted = true;
            this.admission.invalidate("workspace_hooks_config_rebuild_failed");
          },
        );
        this.admission.replaceSnapshot(nextSnapshot);
      } catch (error) {
        if (!writeCommitted) {
          // 裸 catch 曾把 mutation port 的全部失败一律报成
          // config_write_failed——包括发生在写盘之前的 snapshot mismatch（review 后
          // bundle 已变/discovery 读败）。用户据此重试"写"永远失败，也掩盖真实原因。
          // 按 WorkspaceHookMutationError.code 透传；telemetry 补 cause 便于定位。
          const isMutationError =
            error instanceof WorkspaceHookMutationError ||
            (error instanceof Error &&
              error.name === "WorkspaceHookMutationError");
          const mutationCode = isMutationError
            ? ((error as WorkspaceHookMutationError)
                .code as WorkspaceHookReasonCode)
            : ("workspace_hooks_config_write_failed" as const);
          this.telemetry.toggleFailure(
            target.bundleDigest,
            mutationCode,
            error instanceof Error ? error.message : String(error),
          );
          return {
            accepted: false,
            reasonCode: mutationCode as WorkspaceHookReasonCode,
          };
        }
        this.telemetry.toggleFailure(
          target.bundleDigest,
          "workspace_hooks_config_rebuild_failed",
        );
        this.registry.fail(target, "workspace_hooks_config_rebuild_failed");
        await this.host.emit({
          type: SessionEventType.WorkspaceHookReviewSettled,
          payload: {
            interactionId: target.interactionId,
            state: "configuration_error",
            reasonCode: "workspace_hooks_config_rebuild_failed",
          },
        });
        return {
          accepted: false,
          reasonCode: "workspace_hooks_config_rebuild_failed" as const,
        };
      }

      const nextFlow = await this.refreshPendingFlow(nextSnapshot);
      // 软门禁:toggle 重建 bundle 后重新评估 pending 状态
      await this.emitAdmissionUpdatedAfterMutation();
      return {
        accepted: true,
        reviewItemIds: [reviewItemId],
        ...(nextFlow ? { request: nextFlow.request } : {}),
      };
    });
  }

  /**
   * 按 reviewItemIds 撤销持久 Trust（走 applyWorkspaceHookRevoke 共享流水线）。
   * 口径：只有 accepted 才刷新 flow 与 admission；拒绝原样返回，不做部分提交。
   */
  revoke(
    target: WorkspaceHookReviewTarget,
    reviewItemIds: readonly string[],
  ): Promise<WorkspaceHookReviewCommandResult> {
    return this.enqueueMutation(async () => {
      const validation = this.registry.validate(target, {
        action: "trust_selected",
        reviewItemIds: [...reviewItemIds],
      });
      if (!validation.accepted) return validation;
      const snapshot = this.admission.getCurrentSnapshot();
      const result = await applyWorkspaceHookRevoke({
        coordinator: this.coordinator,
        digests: resolveWorkspaceHookReviewDigests(
          snapshot,
          validation.reviewItemIds,
        ),
        reviewItemIds: validation.reviewItemIds,
        snapshot,
        store: this.store,
      });
      if (result.accepted) {
        this.telemetry.revoked(
          snapshot.bundleDigest,
          validation.reviewItemIds.length,
        );
        await this.refreshPendingFlow(snapshot);
        // 软门禁:revoke 后重新评估 pending 状态
        await this.emitAdmissionUpdatedAfterMutation();
      }
      return result;
    });
  }

  /**
   * 按 hookDeclarationDigests 撤销"当前快照"的信任（设置页入口）。
   * 校验比 revoke 更严：sessionId、host.remoteSessionId、workspaceIdentity、bundleDigest 必须全等，
   *   且每个 digest 都要在快照里唯一定位到一行——少一个就 snapshot_mismatch，绝不做模糊匹配。
   */
  revokeCurrent(
    target: WorkspaceHookTrustRevokeTarget,
  ): Promise<WorkspaceHookReviewCommandResult> {
    return this.enqueueMutation(async () => {
      const snapshot = this.admission.getCurrentSnapshot();
      if (
        target.sessionId !== this.sessionId ||
        target.remoteSessionId !== this.host.remoteSessionId ||
        target.workspaceIdentity !== snapshot.workspaceIdentity ||
        target.bundleDigest !== snapshot.bundleDigest
      ) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_snapshot_mismatch" as const,
        };
      }
      const digests = [...new Set(target.hookDeclarationDigests)];
      const entries = snapshot.hooks.filter((entry) =>
        digests.includes(entry.hookDeclarationDigest),
      );
      if (
        digests.length === 0 ||
        new Set(entries.map((entry) => entry.hookDeclarationDigest)).size !==
          digests.length
      ) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_snapshot_mismatch" as const,
        };
      }
      const result = await applyWorkspaceHookRevoke({
        coordinator: this.coordinator,
        digests,
        reviewItemIds: entries.map((entry) => entry.reviewItemId),
        snapshot,
        store: this.store,
      });
      if (result.accepted) {
        this.telemetry.revoked(snapshot.bundleDigest, digests.length);
        await this.refreshPendingFlow(snapshot);
        // 软门禁:revokeCurrent 后重新评估 pending 状态
        await this.emitAdmissionUpdatedAfterMutation();
      }
      return result;
    });
  }

  /**
   * 变更后重建当前审核视图：有 pending flow 则 supersede（generation+1）并 emit；若新视图
   *   pendingCount=0 立即无决策关闭（不让空审核挂在面板上）；没有 pending flow 时才考虑重开。
   * 顺序敏感：必须先把旧 interactionId 的 Superseded 发出去，再发新 id 的 Requested，
   *   否则前端会同时看到两个活跃 request。
   */
  private async refreshPendingFlow(
    snapshot: WorkspaceHookBundleSnapshot,
  ): Promise<WorkspaceHookReviewFlow | undefined> {
    const current = this.registry.getCurrentFlow(this.sessionId);
    if (!current || current.state.state !== "pending") {
      // 无 pending flow 时直接返回会让
      // 「授权 → review resolved → 撤销」之后，当前会话再没有任何重新授权入口，
      // 用户只能新建对话。
      //
      // revoke 的语义是 revoked → admission=pending，本就应重新征询，
      // 因此这里在确实产生了待审项时开启新 flow：不新增「直接授予信任」的旁路，
      // 授权仍只能经当前不可变 review 绑定的行内按钮完成。
      return await this.openReviewFlowForNewPendingItems(snapshot);
    }
    const target = toWorkspaceHookReviewTarget(current.request);
    const evaluation = this.coordinator.evaluateSnapshot({ snapshot });
    const replacement = this.buildRequest(snapshot, evaluation, {
      reviewFlowId: current.request.reviewFlowId,
      generation: current.request.generation + 1,
    });
    const nextFlow = this.registry.supersede(target, replacement);
    this.telemetry.superseded(replacement);
    this.generation = replacement.generation;
    await this.host.emit({
      type: SessionEventType.WorkspaceHookReviewSuperseded,
      payload: {
        interactionId: current.request.interactionId,
        supersededByInteractionId: replacement.interactionId,
      },
    });
    this.telemetry.requestCreated(replacement);
    await this.host.emit({
      type: SessionEventType.WorkspaceHookReviewRequested,
      payload: { request: replacement },
    });
    if (replacement.summary.pendingCount === 0) {
      this.registry.closeWithoutDecision(
        toWorkspaceHookReviewTarget(replacement),
      );
      await this.host.emit({
        type: SessionEventType.WorkspaceHookReviewSettled,
        payload: {
          interactionId: replacement.interactionId,
          state: "resolved",
        },
      });
    }
    return nextFlow;
  }

  /**
   * revoke 之后当前会话没有 pending flow 时，重新开启审核。
   *
   * 只在真的存在待审项时开启。开关只控制运行，信任只控制准入；因此当前审核
   * 快照中的 configured-disabled 声明也必须保留行内信任入口。开启走
   * openOrReuseFlow，与首次征询同一条路径，因此 generation / reviewFlowId /
   * interactionId 的既有语义不变。
   */
  private async openReviewFlowForNewPendingItems(
    snapshot: WorkspaceHookBundleSnapshot,
  ): Promise<WorkspaceHookReviewFlow | undefined> {
    const evaluation = this.coordinator.evaluateSnapshot({
      snapshot,
    });
    const hasPending = evaluation.items.some(
      (item) => item.admissionClass === "pending",
    );
    if (!hasPending) return undefined;
    const flow = await this.openOrReuseFlow(snapshot, evaluation);
    // 必须监管：否则该 flow 超时后静默死亡，面板永久失效（见 superviseFlow 注释）。
    // 这里刻意不 await——revoke 命令不能被 10 分钟的审核 deadline 阻塞；
    // catch 兜底避免未处理拒绝，flow 终结本身不产生需要向调用方冒泡的错误。
    void this.superviseFlow(flow).catch(() => undefined);
    return flow;
  }

  /** 同 bundleDigest 的 pending flow 直接复用；否则按当前 generation+1 开新 flow 并 emit Requested。 */
  private async openOrReuseFlow(
    snapshot: WorkspaceHookBundleSnapshot,
    evaluation: WorkspaceHookSnapshotEvaluation,
  ): Promise<WorkspaceHookReviewFlow> {
    const current = this.registry.getCurrentFlow(this.sessionId);
    if (
      current?.state.state === "pending" &&
      current.request.bundleDigest === snapshot.bundleDigest
    ) {
      return current;
    }
    this.reviewFlowId ??= `workspace-hook-review:${this.createId()}`;
    const request = this.buildRequest(snapshot, evaluation, {
      reviewFlowId: this.reviewFlowId,
      generation: this.generation + 1,
    });
    this.generation = request.generation;
    const flow = this.registry.open(request);
    this.telemetry.requestCreated(request);
    await this.host.emit({
      type: SessionEventType.WorkspaceHookReviewRequested,
      payload: { request },
    });
    return flow;
  }

  /** 请求构造的唯一入口：reviewFlowId/generation 由调用方决定，host/now/createId 注入以便测试。 */
  private buildRequest(
    snapshot: WorkspaceHookBundleSnapshot,
    evaluation: WorkspaceHookSnapshotEvaluation,
    flow: { reviewFlowId: string; generation: number },
  ): WorkspaceHookReviewRequestPayload {
    return buildWorkspaceHookReviewRequest({
      snapshot,
      evaluation,
      ...flow,
      sessionId: this.sessionId,
      host: this.host,
      now: this.now,
      createId: this.createId,
    });
  }

  /**
   * 把本次裁决落成持久 Trust：先 assert 策略允许，再按快照生成 records，grant 后同步 coordinator。
   * 副作用：写 trust store 并替换内存 records（成功后新准入立即可见）。
   * 失败语义：任一环节抛错都上抛，调用方负责归因（此处不做 catch-all，避免错误归属倒错）。
   */
  private async applyPersistentTrust(
    reviewItemIds: readonly string[],
  ): Promise<{ grantedRecordCount?: number }> {
    const snapshot = this.admission.getCurrentSnapshot();
    this.coordinator.assertPersistentTrustMutationAllowed(
      snapshot.workspaceIdentity,
    );
    const records = createWorkspaceHookTrustRecords({
      snapshot,
      reviewItemIds,
      grantedAt: new Date(this.now()).toISOString(),
      ...(this.appVersion ? { appVersion: this.appVersion } : {}),
    });
    const file = await (await this.store).grant(records);
    this.coordinator.replacePersistentTrustRecords(file.records, {
      status: "ok",
    });
    return { grantedRecordCount: records.length };
  }

  /**
   * 变更串行化：无论前一个操作成功或失败，都把它当作下一个操作的起点；本次结果原样返回给调用方，
   * 队列尾只吞结果不吞错误——否则一次失败会让后续所有命令静默错位。
   */
  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * 软门禁:mutation 完成后重新评估 pending 状态并发射 AdmissionUpdated。
   *
   * 口径与 admission 一致:configuredEnabled && admissionClass === "pending"。
   * pendingCount === 0 也要发,投影据此清空提示条。
   * 通过 admission 的 invalidate → 触发 evaluateDispatch 内的 refreshEvaluation;
   * 这里直接用 coordinator 重新评估快照,与 admission.emitAdmissionState 同源。
   */
  private async emitAdmissionUpdatedAfterMutation(): Promise<void> {
    const snapshot = this.admission.getCurrentSnapshot();
    const evaluation = this.coordinator.evaluateSnapshot({ snapshot });
    const pendingCount = evaluation.items.filter(
      (item) => item.configuredEnabled && item.admissionClass === "pending",
    ).length;
    await this.host.emit({
      type: SessionEventType.WorkspaceHookAdmissionUpdated,
      payload: {
        pendingCount,
        bundleDigest: snapshot.bundleDigest,
        ...(snapshot.workspaceIdentity
          ? { workspaceIdentity: snapshot.workspaceIdentity }
          : {}),
      },
    });
  }
}
