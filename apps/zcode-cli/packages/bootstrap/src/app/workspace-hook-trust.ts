// INV-01 无快照即无安全面：守住位置 首行早退；改错故障 无 hook 的工作区凭空建 coordinator。
// INV-02 rollout 关闭保持旧 hard block 且不读 Trust 文件：守住位置 trustEnabled 分支；改错故障 关掉开关后既有信任仍生效。
// INV-03 控制器创建需要三条件同时成立：守住位置 if 判断；改错故障 缺 host 时 requestReview 抛错而不是返回 unavailable。
// INV-04 unavailable 原因码取决于开关而不是 wiring：守住位置 三元；改错故障 用户看到「未启用」但其实只是没接 host。
// INV-05 Trust 读取 fail-closed：守住位置 loadWorkspaceHookTrustStore 的捕获；改错故障 损坏文件被当成全部信任。
// INV-06 reloadTrust 必须重放 admission 状态：守住位置 activate 的 resume；改错故障 行内信任后 banner 仍显示旧 pending。
// INV-07 pendingCount 为 0 也要发事件：守住位置 activate 约定；改错故障 banner 永远清不掉。
// INV-08 读取不写配置：守住位置 全文件无写盘；改错故障 启动过程产生配置副作用。
// INV-09 emit 失败只 warn：守住位置 捕获；改错故障 观测发射失败导致会话创建失败。
// INV-10 coordinatorEpoch 每次装配唯一：守住位置 随机 UUID；改错故障 重载后旧 revision 仍被接受。
// INV-11 admission 的 enabled 跟随 trustEnabled：守住位置 创建入参；改错故障 开关与准入状态不一致。
// INV-12 每会话自己 load 一次 Trust：守住位置 装配时序；改错故障 多会话共享一份陈旧镜像。
// INV-13 homeDir 仅测试注入：守住位置 条件展开；改错故障 生产把信任写到临时目录。
//
// 模块职责：为会话装配 Workspace Hook 的准入与审核安全面。
// 阅读顺序：先看开关与 store 创建，再看控制器装配，最后看 reloadTrust 与 fail-closed 读取。
import {
  createDefaultFileWorkspaceHookTrustStore,
} from "@zcode/adapters/storage";
import {
  InMemoryWorkspaceHookPolicyProvider,
  WorkspaceHookTrustCoordinator,
  createWorkspaceHookRuntimeAdmission,
  emitWorkspaceHookTelemetry,
  type WorkspaceHookAdmissionState,
  type WorkspaceHookReviewTarget,
  type WorkspaceHookRuntimeAdmissionPort,
  type WorkspaceHookPolicyProvider,
} from "@zcode/core";
import { SessionEventType } from "@zcode/contracts";
import type {
  Logger,
  SessionId,
  WorkspaceHookBundleSnapshot,
  WorkspaceHookPolicy,
  WorkspaceHookAdmissionUpdatedPayload,
} from "@zcode/contracts";
import type {
  WorkspaceHookReviewDecision,
  WorkspaceHookReviewRequestPayload,
  WorkspaceHookTrustRevokeTarget,
} from "@zcode/shared/zcode-protocol-v4";
import type { WorkspaceHookRuntimeRoot } from "@zcode/shared/workspace-hook-discovery";
import {
  WorkspaceHookReviewController,
  type WorkspaceHookReviewCommandResult,
  type WorkspaceHookReviewHostPort,
  type WorkspaceHookReviewLifecycleEvent,
} from "./workspace-hook-review-controller.js";
import { createWorkspaceHookReviewMutationPort } from "./workspace-hook-review-mutation.js";
import type { WorkspaceHookReviewHostContext } from "./types.js";

/**
 * 本会话的 Workspace Hook 安全面（admission + 审核控制器的只读句柄）。
 *
 * `snapshot` 是装配时的那一份不可变审核快照；`reloadTrust` 供 Settings 行内信任写盘后把文件
 * 重载进本会话 coordinator（否则运行中会话继续用旧内存镜像）；其余方法全部委托 controller，
 * 控制器缺席时统一回结构化 unavailable，不抛错。方法不改变 admission 的启用态。
 */
export interface WorkspaceHookRuntimeSecurity {
  admission: WorkspaceHookRuntimeAdmissionPort;
  snapshot: WorkspaceHookBundleSnapshot;
  /**
   * Trust store 是文件，而 coordinator 的
   * persistentRecords 是 per-session 内存镜像，只在 session 创建时 load 一次。
   * Settings 行内信任（无 task 的 pretrust 路径）直接写文件后返回，运行中 session
   * 的 coordinator 既不更新记录也不 bump revision——已信任 Hook 继续被拒、banner
   * pendingCount 停留旧值。pretrust 授权成功后必须调用本方法把文件内容重载进本
   * session 的 coordinator 并重发 admission 状态，与 task 内 respond 路径对齐。
   */
  reloadTrust(): Promise<void>;
  /** 软门禁:按需开审核 flow,无 pending 项时为安全 no-op */
  requestReview(target: {
    workspaceIdentity: string;
    bundleDigest: string;
  }): Promise<WorkspaceHookReviewCommandResult>;
  respond(
    target: WorkspaceHookReviewTarget,
    decision: WorkspaceHookReviewDecision,
  ): Promise<WorkspaceHookReviewCommandResult>;
  toggle(
    target: WorkspaceHookReviewTarget,
    reviewItemId: string,
    enabled: boolean,
  ): Promise<
    WorkspaceHookReviewCommandResult & {
      request?: WorkspaceHookReviewRequestPayload;
    }
  >;
  revoke(
    target: WorkspaceHookReviewTarget,
    reviewItemIds: readonly string[],
  ): Promise<WorkspaceHookReviewCommandResult>;
  revokeCurrent(target: WorkspaceHookTrustRevokeTarget): Promise<WorkspaceHookReviewCommandResult>;
}

/**
 * 装配 Workspace Hook 的运行时安全面；没有快照时回 undefined（该 workspace 没有 hook 可审）。
 *
 * 三层条件是独立的：trustEnabled 决定是否创建 / 读取 Trust store 与 admission 的 enabled；
 * 只有 trustEnabled **且** 同时给了 reviewHost 与 emitReviewEvent 才创建审核控制器（否则
 * requestReview 等返回 unavailable）。rollout 关闭时保持旧 hard block 且不读 Trust 文件（文件
 * 保留以便重新打开后继续使用）。启动即异步 load store（fail-closed：损坏 / 读取失败视为空信任）。
 * `onAdmissionStateChanged` 把 pendingCount / bundleDigest 投成会话事件，emit 失败只 warn。
 * 副作用：建 coordinator / admission（可能异步 activate）、读信任文件；不写任何配置。
 */
export function createWorkspaceHookRuntimeSecurity(input: {
  appVersion?: string;
  emitAdmissionEvent?: (event: {
    type: typeof SessionEventType.WorkspaceHookAdmissionUpdated;
    payload: WorkspaceHookAdmissionUpdatedPayload;
  }) => Promise<void>;
  emitReviewEvent?: (event: WorkspaceHookReviewLifecycleEvent) => Promise<void>;
  logger: Logger;
  projectConfigPath?: string;
  policy?: WorkspaceHookPolicy;
  policyProvider?: WorkspaceHookPolicyProvider;
  reviewHost?: WorkspaceHookReviewHostContext;
  workspaceHookTrustEnabled?: boolean;
  runtimeRoot: WorkspaceHookRuntimeRoot;
  sessionId: SessionId;
  snapshot?: WorkspaceHookBundleSnapshot;
  userConfigPath: string;
  workingDirectory: string;
  /** 测试注入临时 HOME；生产不传，Trust store 落在真实 ~/.zcode/security。 */
  homeDir?: string;
}): WorkspaceHookRuntimeSecurity | undefined {
  // 没有快照就没有可审内容，直接不提供安全面。
  // 注意这不是禁用：返回 undefined 表示该工作区根本没有 hook 面。
  if (!input.snapshot) return undefined;
  const policyProvider =
    input.policyProvider ?? new InMemoryWorkspaceHookPolicyProvider(input.policy);
  const coordinator = new WorkspaceHookTrustCoordinator({
    coordinatorEpoch: crypto.randomUUID(),
    policyProvider,
  });
  // Rollout 关闭时必须保持旧 hard block，且不能读取已有 Trust store；Trust 文件保留，
  // 方便后续重新打开开关后继续使用用户已做出的选择。
  // 只有显式 true 才开启，undefined 与 false 都按关闭处理。
  // 关闭时不创建 store，也就不读用户已有信任文件。
  // 信任文件保留，重新打开开关后可继续沿用。
  const trustEnabled = input.workspaceHookTrustEnabled === true;
  const store = trustEnabled
    ? createDefaultFileWorkspaceHookTrustStore({
        userConfigPath: input.userConfigPath,
        ...(input.homeDir ? { homeDir: input.homeDir } : {}),
      })
    : undefined;
  const ready = trustEnabled
    ? loadWorkspaceHookTrustStore({
        coordinator,
        logger: input.logger,
        store: store as NonNullable<typeof store>,
      })
    : Promise.resolve();
  // 控制器是可选件：没有 host 或没有 emit 时保持 undefined。
  // 后续所有审核方法都据此回退到 unavailable。
  // 这一层不改变 admission 的启用态。
  let controller: WorkspaceHookReviewController | undefined;
  // 软门禁:onAdmissionStateChanged → 发射 WorkspaceHookAdmissionUpdated 会话事件。
  // activate() 完成 evaluate 后、replaceSnapshot 后均会触发,供投影层写入 snapshot 字段。
  const onAdmissionStateChanged:
    | ((state: WorkspaceHookAdmissionState) => void)
    | undefined = input.emitAdmissionEvent
    ? (state) => {
        void input.emitAdmissionEvent!({
          type: SessionEventType.WorkspaceHookAdmissionUpdated,
          payload: {
            pendingCount: state.pendingCount,
            bundleDigest: state.bundleDigest,
            ...(state.workspaceIdentity
              ? { workspaceIdentity: state.workspaceIdentity }
              : {}),
          },
        }).catch((error: unknown) => {
          input.logger.warn("Failed to emit WorkspaceHookAdmissionUpdated", {
            errorType: error instanceof Error ? error.name : typeof error,
            event: "workspace_hook.admission_event_emit_failed",
            module: "bootstrap.workspace_hook_trust",
          });
        });
      }
    : undefined;
  const admission = createWorkspaceHookRuntimeAdmission({
    coordinator,
    enabled: trustEnabled,
    logger: input.logger,
    ready,
    ...(onAdmissionStateChanged ? { onAdmissionStateChanged } : {}),
    snapshot: input.snapshot,
  });

  // 三个条件必须同时成立，缺一个都不装配控制器。
  // host 通过展开注入 emit，控制器只认 host 端口。
  // mutation 端口绑定当前工作目录与运行根，避免跨区写。
  if (trustEnabled && input.reviewHost && input.emitReviewEvent) {
    const host: WorkspaceHookReviewHostPort = {
      ...input.reviewHost,
      emit: input.emitReviewEvent,
    };
    controller = new WorkspaceHookReviewController({
      admission,
      appVersion: input.appVersion,
      coordinator,
      host,
      logger: input.logger,
      mutation: createWorkspaceHookReviewMutationPort({
        workingDirectory: input.workingDirectory,
        workspaceIdentity: input.snapshot.workspaceIdentity,
        projectConfigPath: input.projectConfigPath,
        runtimeRoot: input.runtimeRoot,
      }),
      sessionId: input.sessionId,
      store: store as NonNullable<typeof store>,
    });
  }

  const unavailable = (): WorkspaceHookReviewCommandResult => ({
    accepted: false,
    reasonCode: trustEnabled
      ? "workspace_hooks_require_trust_capable_host"
      : "workspace_hooks_feature_disabled",
  });
  return {
    admission,
    snapshot: input.snapshot,
    // 关闭态与无 store 时是安全 no-op。
    // 重载后 activate 幂等，会重新 evaluate 并重发状态。
    // pendingCount 为 0 也发，用于清空 banner。
    reloadTrust: async () => {
      if (!trustEnabled || !store) return;
      await loadWorkspaceHookTrustStore({ coordinator, logger: input.logger, store });
      // replacePersistentTrustRecords 已 bump revision 并清空 evaluation 缓存；
      // activate 幂等（跳过 ready 等待），重新 evaluate 并重发 admission 状态
      // （pendingCount === 0 也会发，用于清空 banner）。
      await admission.activate("resume");
    },
    requestReview: (target) =>
      controller
        ? controller.requestReview(target)
        : Promise.resolve(unavailable()),
    respond: (target, decision) =>
      controller ? controller.respond(target, decision) : Promise.resolve(unavailable()),
    toggle: (target, reviewItemId, enabled) =>
      controller
        ? controller.toggle(target, reviewItemId, enabled)
        : Promise.resolve(unavailable()),
    revoke: (target, reviewItemIds) =>
      controller ? controller.revoke(target, reviewItemIds) : Promise.resolve(unavailable()),
    revokeCurrent: (target) =>
      controller ? controller.revokeCurrent(target) : Promise.resolve(unavailable()),
  };
}

async function loadWorkspaceHookTrustStore(input: {
  coordinator: WorkspaceHookTrustCoordinator;
  logger: Logger;
  store: ReturnType<typeof createDefaultFileWorkspaceHookTrustStore>;
}): Promise<void> {
  try {
    // store 本身是 Promise，先 await 再 load。
    // loaded.status 原样透传给 coordinator，corrupt 时附带恢复路径。
    const loaded = await (await input.store).load();
    input.coordinator.replacePersistentTrustRecords(loaded.records, {
      status: loaded.status,
      ...(loaded.status === "corrupt" ? { recoveredCorruptPath: loaded.recoveredCorruptPath } : {}),
    });
  } catch (error) {
    input.coordinator.replacePersistentTrustRecords([], { status: "corrupt" });
    emitWorkspaceHookTelemetry(input.logger, "workspace_hook.trust_store_failure", {
      reasonCode: "workspace_hooks_trust_store_corrupt",
    });
    input.logger.warn("Workspace Hook Trust store bootstrap failed closed", {
      errorType: error instanceof Error ? error.name : typeof error,
      event: "workspace_hook.trust_store.bootstrap_failed",
      module: "bootstrap.workspace_hook_trust",
      reasonCode: "workspace_hooks_trust_store_corrupt",
      status: "completed",
    });
  }
}
