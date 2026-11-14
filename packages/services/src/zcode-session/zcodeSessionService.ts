/* eslint-disable max-lines -- zcodeSessionService 聚合 desktop-continuous session 操作、draft lifecycle 和 task index 同步边界，拆分需要单独设计。 */
// 文件职责：desktop-continuous 会话服务门面。对上提供 session 生命周期与配置操作，对下把 agent 返回的 snapshot 归一
// （retry 字段、空导入修复），并驱动 task index 同步与 workspace 广播。
// INV-01：任何会改变 session 状态的操作，返回前必须 notifySyncer 建立 shadow 订阅，否则 runtime 事件进不了 sqlite。
//         守住位置：createSession / resumeSession / setModel / promoteDeferredDraftSession。
// INV-02：deferred draft 绝不进入 task index 与广播。守住位置：createSession 的 deferred 分支、setModel 的 isDeferredDraft 分支。
//         破坏后侧边栏会出现没有用户输入、重启后无法 resume 的脏会话。
// INV-03：广播必须在 agent 写入完成之后、且使用最终 snapshot；顺序颠倒会让 sqlite 停在旧值。
//         守住位置：createSession 的 notifySyncer → broadcastSnapshot 顺序、resumeSession 的 thoughtLevel 重放后再播。
// INV-04：task index 同步失败只 warn 不抛（守住位置：broadcastSnapshot 的 catch），列表是可恢复的派生视图。
// INV-05：deferredDraftSessions 是「该 session 是否在 task index 中」的唯一判据，forget 必须覆盖 close / promote 两条路径。
import type { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";
import type { ZCodeTaskIndexSyncer } from "#src/zcode-agent/zcodeTaskIndexSyncer.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  createSessionTraceId,
  type ZCodeSessionStateSnapshot,
  type ZCodeWorkspaceTaskListChanged,
} from "@zcode/shared";
import type {
  IZCodeSessionService,
  ZCodeSessionCreateParams,
  ZCodeSessionEventsParams,
  ZCodeSessionListParams,
  ZCodeSessionMessagesParams,
  ZCodeSessionReadParams,
  ZCodeSessionReadWorkspacePresentationParams,
  ZCodeSessionResumeParams,
  ZCodeSessionSetModeParams,
  ZCodeSessionSetModelParams,
  ZCodeSessionSetThoughtLevelParams,
  ZCodeTaskTarget,
  ZCodeSessionWorkspaceTarget,
} from "#src/zcode-session/zcodeSession.js";
import { formatModelPickerValue } from "#src/zcode-agent/zcodeConfigOptions.js";
import { createZCodeSessionApiRetryRuntimeTracker } from "#src/zcode-session/zcodeSessionApiRetry.js";
import { appendWorkspaceToFilesystemMcpServers } from "#src/session/mcpWorkspaceScope.js";
import { repairEmptyImportedClaudeSessionSnapshot } from "#src/zcode-session/importedClaudeSessionRepair.js";
import { createZCodeDeferredDraftRegistry } from "#src/zcode-session/zcodeSessionDraftRegistry.js";
import type { CuaProductMcpServerResolver } from "#src/cua-permission-broker/index.js";

// scope 固定为 zcode-session-service，按模块过滤日志时不必匹配 message 文本；未绑定 session 的调用传 undefined，避免伪造无法关联的 trace id。
const logger = createServiceLogger("zcode-session-service");

// 依赖全部经构造参数注入：agentService 是唯一状态所有者，syncer 与 CUA 解析器是可选协作者，缺省时服务仍可工作。
interface CreateZCodeSessionServiceOptions {
  agentService: IZCodeAgentService;
  /**
   * 后台 task index sqlite 同步器。注入后，每次 session 被创建/恢复/发送 prompt 或
   * 订阅事件时都会通知 syncer 维护 shadow 订阅，保证 desktop-continuous 路径下
   * sqlite 仍能跟随 runtime 状态收敛；同时每次会变更 session 状态的操作完成后会
   * 主动把最新 snapshot 同步到 sqlite 并广播 workspace_task_list_changed，
   * 让侧边栏列表立刻看到 first_input title 和 updatedAt 排序刷新。
   */
  taskIndexSyncer?: ZCodeTaskIndexSyncer;
// CUA 的产品级 MCP（socket/token）只在发往 runtime 时注入，不落到用户配置；可选注入让不启用 CUA 的宿主完全不引入这条依赖。
  cuaProductMcpServerResolver?: CuaProductMcpServerResolver;
}

// 工厂闭包持有 retry tracker 与草稿注册表：两者生命周期与 service 实例绑定，每个窗口创建独立实例。
// 草稿集合不能跨窗口共享，否则多窗口会把对方尚未发送的 draft 当成已提升的 task。
export function createZCodeSessionService({
  agentService,
  taskIndexSyncer,
  cuaProductMcpServerResolver,
}: CreateZCodeSessionServiceOptions): IZCodeSessionService {
// tracker 在实例内共享，才能跨多次 create/resume/read 累积同一 session 的重试次数；
// 它也要求所有 agent 返回值都必须过一遍 withApiRetryRuntime，保证字段来源唯一。
  const { withApiRetryRuntime } = createZCodeSessionApiRetryRuntimeTracker();
// [权衡] 草稿集合只存在内存：重启即清空是有意设计——草稿没有落盘价值，持久化反而会留下无法 resume 的空会话。
  const deferredDraftSessions = createZCodeDeferredDraftRegistry();

// shadow 订阅是 sqlite 跟随 runtime 的唯一通道；未注入 syncer 时静默返回而不是抛错，让服务在精简宿主中保持可用。
  function notifySyncer(target: ZCodeTaskTarget): void {
    if (!taskIndexSyncer) {
      return;
    }
    taskIndexSyncer.ensureSessionSubscription({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      sessionId: target.sessionId,
    });
  }

// 诊断字段只读且必须容错：日志统计失败不能反向打断 snapshot 恢复，
// 因此对 messages/pendingRequestIds 做数组兜底，但不修改返回给 UI 的 snapshot 本体。
  function getSessionSnapshotDiagnostics(snapshot: ZCodeSessionStateSnapshot) {
    // 日志诊断不能假设测试 mock 或未来 partial snapshot 一定带齐 messages/pendingRequestIds。
    // 原因是 readSession 的业务结果已经由 agent 层校验，服务层这里只记录观测字段；若日志读取抛错，会反过来打断
    // desktop-continuous snapshot 恢复。这里仅对诊断值做空数组统计，不修改返回给 UI 的 snapshot 本体。
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    const pendingRequestIds = Array.isArray(snapshot.runtime.pendingRequestIds)
      ? snapshot.runtime.pendingRequestIds
      : [];
    return {
      activeTurnId: snapshot.runtime.activeTurnId ?? null,
      eventSeq: snapshot.runtime.eventSeq,
      messageCount: messages.length,
      pendingRequestCount: pendingRequestIds.length,
      sessionStatus: snapshot.session.status,
      stateRevision: snapshot.runtime.stateRevision,
    };
  }

// 三态返回值是重放判断的基础：null 表示「能力未知」（放行，保持旧行为），空 Set 表示「该模型明确没有思考强度」，
// 非空 Set 是可选值白名单。把未知与不支持混成一个空集合，会让旧 agent 上报缺失时用户的思考强度被静默丢弃。
// 列表元素既可能是字符串也可能是 { value } 对象，两种形态都要归一成字符串再比较。
  function readSnapshotAvailableThoughtLevels(
    snapshot: ZCodeSessionStateSnapshot,
  ): Set<string> | null {
    const thoughtLevel = snapshot.settings.thoughtLevel;
    if (!thoughtLevel.enabled) {
      return new Set();
    }
    const available = Array.isArray(thoughtLevel.available)
      ? (thoughtLevel.available as readonly unknown[])
      : [];
    if (available.length === 0) {
      return null;
    }
    const values = available
      .map((option) => {
        if (typeof option === "string") {
          return option.trim();
        }
        if (typeof option === "object" && option !== null && "value" in option) {
          const value = (option as { value?: unknown }).value;
          return typeof value === "string" ? value.trim() : "";
        }
        return "";
      })
      .filter((value) => value.length > 0);
    return values.length > 0 ? new Set(values) : null;
  }

// 只有 snapshot 明确列出可选项且不含目标值时才放弃重放；未知能力一律放行，避免版本协商期间误删用户设置。
  function canReplayThoughtLevelFromResumeSnapshot(params: {
    snapshot: ZCodeSessionStateSnapshot;
    thoughtLevel: string;
  }): boolean {
    const availableThoughtLevels = readSnapshotAvailableThoughtLevels(params.snapshot);
    return availableThoughtLevels === null || availableThoughtLevels.has(params.thoughtLevel);
  }

  // zcodeSessionService 是 desktop-continuous 主路径，状态变更后必须
  // 广播 snapshot，否则 sqlite 永远停留在 createSession 时写的 "New session"，侧边栏也收不到
  // workspace_task_list_changed。旧写路径（send/steer/fork/compact/rewind pass-through）
  // 已删除，仅剩 createSession/resumeSession/setModel 等生命周期与配置 op 调用本方法。
// [事件顺序] 调用点必须保证 agent 写入已完成：本函数只把最终 snapshot 推给 sqlite 并广播，不做回写或二次读取，
// 因此传入的 snapshot 就是该操作的权威结果。
// [失败路径] 同步失败只 warn：列表是派生视图，下一次成功广播即可收敛，不能因 sqlite 故障把 session 操作判死。
  async function broadcastSnapshot(
    snapshot: ZCodeSessionStateSnapshot,
    tag: string,
    options: {
      modelOverride?: string;
      thoughtLevelOverride?: string;
      moveGroupedTaskToTop?: boolean;
      /** 设计修正：必填，发射点必须声明变更类别。 */
      broadcastReason: ZCodeWorkspaceTaskListChanged["reason"];
    },
  ): Promise<void> {
    if (!taskIndexSyncer) {
      return;
    }
    try {
      // 排查日志（左侧列表随输入框操作刷新）：确认是哪个生命周期 op（setModel/createSession/resumeSession）触发了 snapshot 广播。
      logger.debug(
        undefined,
        `[list-refresh-trace] broadcastSnapshot tag=${tag} taskId=${snapshot.session.sessionId}`,
      );
// 同步与广播在同一次调用内完成，中间不插入其它 await，避免 UI 先收到列表刷新却读不到新行。
      await taskIndexSyncer.syncSnapshotAndBroadcast(snapshot, options);
    } catch (error) {
      logger.warn(
        undefined,
        `[zcode-session-service] ${tag} syncSnapshotAndBroadcast 失败 taskId=${snapshot.session.sessionId}`,
        error,
      );
    }
  }

// 导入的 Claude 会话可能 snapshot 为空但磁盘有历史：修复必须在读取之后、任何广播之前完成，否则空快照会被当成事实写进 sqlite。
// 修复结果同样要过 withApiRetryRuntime，因为修复过程会重读文件并重建 runtime 字段。
  async function repairEmptyImportedClaudeSession(
    snapshot: ZCodeSessionStateSnapshot,
    params: ZCodeSessionResumeParams | ZCodeSessionReadParams,
  ): Promise<ZCodeSessionStateSnapshot> {
    return withApiRetryRuntime(
      await repairEmptyImportedClaudeSessionSnapshot({
        agentService,
        snapshot,
        target: params,
      }),
    );
  }

// MCP 解析只作用于「本次发往 runtime 的参数」：workspace 注入补项目授权，CUA 解析器补 product broker 的 socket/token。
// 两者都不回写用户配置；返回新对象而非原地修改，因为调用方可能仍持有原始 params 用于日志或重试。
  async function withResolvedMcpServers<
    T extends ZCodeSessionCreateParams | ZCodeSessionResumeParams,
  >(params: T): Promise<T> {
// filesystem MCP 需要当前 workspace 作为授权范围；desktop-continuous 绕过 legacy adapter，缺这一步会让首发工具调用被拒。
    const mcpServers = appendWorkspaceToFilesystemMcpServers(
      params.mcpServers,
      params.workspacePath,
    );
    const resolvedMcpServers = cuaProductMcpServerResolver
      ? await cuaProductMcpServerResolver.resolveMcpServers(mcpServers, {
          workspacePath: params.workspacePath,
        })
      : mcpServers;
    if (resolvedMcpServers === params.mcpServers) {
      return params;
    }
    // desktop-continuous session 路径绕过 legacy task adapter，之前不会执行
    // filesystem MCP 的 workspace 注入，导致同一 MCP 在直接 session 首发时缺少当前项目授权。
    // 这里只改发往 runtime 的临时参数，不回写用户配置，避免污染跨 workspace 的 MCP 设置；
    // product CUA broker socket/token 同样只注入 runtime 参数。
    return { ...params, mcpServers: resolvedMcpServers };
  }

  return {
// workspace 预热点：v4 命令路径不经过本 service 的 session 入口，
// 因此 workspace 级常驻订阅只能在这里建立，否则纯 v4 会话的终态与标题永远进不了 sqlite。
    async initializeWorkspace(params: ZCodeSessionWorkspaceTarget) {
// 先完成 agent 初始化再决定订阅：available=false 时不该留下一条指向未就绪 workspace 的空订阅。
      const result = await agentService.initialize(params);
      // task index 的 v4 摄入（sessions-index/workspace-config）是
      // workspace 级常驻订阅。v4 命令路径（createSession/sendText 走 v4/command）
      // 不再经过本 service 的 session 操作入口，必须在 workspace 预热点建立订阅，
      // 否则纯 v4 会话的终态/标题/配置目录永远进不了 sqlite 与 workspace 广播。
      if (result.available && taskIndexSyncer) {
        taskIndexSyncer.ensureWorkspaceSubscription({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        });
      }
      return result;
    },

    getWorkspaceRuntimeIdentity(params: ZCodeSessionWorkspaceTarget) {
      return agentService.getWorkspaceRuntimeIdentity(params);
    },

    readWorkspacePresentation(params: ZCodeSessionReadWorkspacePresentationParams) {
      return agentService.readWorkspacePresentation(params);
    },

// 生命周期第一步。sessionTraceId 必须在进 agent 之前分配：create 日志、runtime trace 与 snapshot 广播共用同一个 id，
// 事后才能按 id 串起整条链路。本 service 不缓存 snapshot，agent 是唯一状态所有者。
    async createSession(params: ZCodeSessionCreateParams) {
      const startedAt = Date.now();
      const sessionTraceId = params.sessionTraceId ?? createSessionTraceId();
// [权衡] 用展开复制而不是改 params：调用方可能复用入参做重试，就地覆盖 sessionTraceId 会让两次创建共用一个 trace。
      const agentParams = await withResolvedMcpServers({ ...params, sessionTraceId });
      logger.info(sessionTraceId, "[zcode-session-service] createSession 分配 session trace", {
        persistence: agentParams.persistence,
        workspaceIdentity: agentParams.workspaceIdentity,
        workspacePath: agentParams.workspacePath,
      });
      const snapshot = await agentService.createSession(agentParams);
      logger.info(sessionTraceId, "[zcode-session-service] createSession agent 返回", {
        durationMs: Date.now() - startedAt,
        mcpServerCount: agentParams.mcpServers?.length ?? 0,
        persistence: agentParams.persistence,
        snapshotTraceId: snapshot.session.traceId ?? null,
        sessionId: snapshot.session.sessionId,
        workspaceIdentity: agentParams.workspaceIdentity,
        workspacePath: agentParams.workspacePath,
      });
// [事务] deferred 分支必须在任何 syncer 调用之前返回：先 notifySyncer 再 return 会让草稿进入 sqlite，
// 而 sqlite 没有删除草稿的回滚路径，只能等重启清理。
// [权衡] 用请求参数里的 persistence 判断而不是 snapshot 字段，是为了与调用方意图一致。
      if (agentParams.persistence === "deferred") {
        // 未发送前的草稿 session 只用于让 toolbar 和 agent runtime 共用同一份状态。
        // 这类空 session 不能进入 app 的 task index sqlite，否则侧边栏/搜索会出现没有用户输入的会话。
        // 同时记录这个草稿，后续 setModel 等状态变更也必须被挡在 task index 之外。
// [资源] 记住草稿，供后续 setModel/close/promote 识别；该注册表是唯一判据，
// 任何新增的 session 操作都必须先查它，否则会绕过 defer 规则。
        deferredDraftSessions.remember(agentParams, snapshot);
        return snapshot;
      }
      // desktop-continuous 路径不会经过 ZCode task adapter，sqlite 的 task index 全靠
      // syncer 的 shadow 订阅刷新。createSession 成功后立刻 ensure，保证后续 runtime
      // 事件首条到达前订阅已就位。
// 先建 shadow 订阅再广播：runtime 的首批事件可能在广播 await 期间到达，订阅晚建会永久丢失这一批事件。
      notifySyncer({
        workspacePath: snapshot.session.workspace.workspacePath,
        workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
        sessionId: snapshot.session.sessionId,
      });
      // 立刻把初始 snapshot 也同步到 sqlite + 广播，让 UI 列表第一时间看到新会话行。
      // desktop-continuous 首发不会经过 legacy createTask，必须在这里同步写 grouped 顶部顺序。
      const snapshotWithRuntime = withApiRetryRuntime(snapshot);
      const broadcastStartedAt = Date.now();
// 首发必须置顶：desktop-continuous 不走 legacy createTask，没有其它路径维护 grouped 顺序；广播用与返回值同一份 snapshot。
      await broadcastSnapshot(snapshotWithRuntime, "createSession", {
        moveGroupedTaskToTop: true,
        // 首发广播沿用 task_meta_changed 旧语义（低频，一个任务一次）；
        // 语义化成 task_created（insert-active）需连同乐观插入去重一起改。
        broadcastReason: "task_meta_changed",
      });
      logger.info(sessionTraceId, "[zcode-session-service] createSession task index 同步完成", {
        broadcastDurationMs: Date.now() - broadcastStartedAt,
        durationMs: Date.now() - startedAt,
        sessionId: snapshot.session.sessionId,
        workspaceIdentity: params.workspaceIdentity,
        workspacePath: params.workspacePath,
      });
      return snapshotWithRuntime;
    },

// 恢复是快照收敛而非纯读：agent 读取 → 必要时重放 thoughtLevel → 建订阅 → 广播。
// 每步都可能替换 snapshot，广播必须用链路上最后一个值；中间任何一步失败都直接上抛，不广播半成品。
    async resumeSession(params: ZCodeSessionResumeParams) {
      const startedAt = Date.now();
// [权衡] 把控制位从参数里摘掉，避免它被透传给不认识的 agent；默认 true 保持既有调用方语义，手机链路显式传 false。
      const { broadcastSnapshot: shouldBroadcastSnapshot = true, ...resumeParams } = params;
      const agentParams = await withResolvedMcpServers(resumeParams);
      let snapshot = await repairEmptyImportedClaudeSession(
        withApiRetryRuntime(await agentService.resumeSession(agentParams)),
        agentParams,
      );
// trim 后再比较：task config 可能带多余空白，直接比对会把合法值判成不一致，从而触发一次不必要的 agent 写入。
      const requestedThoughtLevelOverride = agentParams.thoughtLevel?.trim();
      let thoughtLevelOverride = requestedThoughtLevelOverride;
      if (
        requestedThoughtLevelOverride &&
        snapshot.settings.thoughtLevel.current !== requestedThoughtLevelOverride
      ) {
        if (
          !canReplayThoughtLevelFromResumeSnapshot({
            snapshot,
            thoughtLevel: requestedThoughtLevelOverride,
          })
        ) {
          // 恢复历史 task 时，模型已经被切回 task-local 模型，但旧 task config
          // 仍可能带着上一模型的 thoughtLevel，例如 GLM-5-Turbo 被传入 max。
          // snapshot.settings.thoughtLevel.available 是当前模型能力事实源，不支持时不能再重放给 agent。
          thoughtLevelOverride = undefined;
          logger.warn(
            undefined,
            "[zcode-session-service] resumeSession 跳过不支持的 task 思考强度",
            {
              availableThoughtLevels: Array.from(
                readSnapshotAvailableThoughtLevels(snapshot) ?? [],
              ),
              requestedThoughtLevel: requestedThoughtLevelOverride,
              sessionId: agentParams.sessionId,
              snapshotThoughtLevel: snapshot.settings.thoughtLevel.current ?? null,
              workspaceIdentity: agentParams.workspaceIdentity ?? null,
              workspacePath: agentParams.workspacePath,
            },
          );
        }
      }
// 只在与当前快照不一致时重放；重放会写 agent 状态，因此必须用重放返回的新 snapshot，
// 并在其后重新广播，否则 syncer 会把同 workspace 草稿的思考强度写回该任务。
      if (thoughtLevelOverride && snapshot.settings.thoughtLevel.current !== thoughtLevelOverride) {
        logger.info(undefined, "[zcode-session-service] resumeSession 重放 task 思考强度", {
          requestedThoughtLevel: thoughtLevelOverride,
          sessionId: agentParams.sessionId,
          snapshotThoughtLevel: snapshot.settings.thoughtLevel.current ?? null,
          workspaceIdentity: agentParams.workspaceIdentity ?? null,
          workspacePath: agentParams.workspacePath,
        });
        // 打开历史 task 时，resume 返回的 snapshot 可能仍带同 workspace 草稿态的最新思考强度。
        // 这里对同一个 session 显式重放 task-local thoughtLevel，再把修正后的 snapshot 广播出去；
        // 否则 syncer/UI 会把草稿的 high 写回原本是 max 的 active task。
        snapshot = await repairEmptyImportedClaudeSession(
          withApiRetryRuntime(
            await agentService.setThoughtLevel({
              workspacePath: agentParams.workspacePath,
              workspaceIdentity: agentParams.workspaceIdentity,
              sessionId: agentParams.sessionId,
              thoughtLevel: thoughtLevelOverride,
            }),
          ),
          agentParams,
        );
      }
      const agentDurationMs = Date.now() - startedAt;
// 订阅在广播前建立，且由 syncer 侧去重，重复 resume 同一 session 不会产生多条 shadow 订阅。
      notifySyncer(agentParams);
      const broadcastStartedAt = Date.now();
      const modelOverride = agentParams.model
        ? formatModelPickerValue(agentParams.model)
        : undefined;
      const syncOptions =
        modelOverride || thoughtLevelOverride
          ? {
              ...(modelOverride ? { modelOverride } : {}),
              ...(thoughtLevelOverride ? { thoughtLevelOverride } : {}),
            }
          : undefined;
// [权衡] 打开任务属于快照收敛，用 task_status_changed 而不是缺省 task_meta_changed，避免每次点开任务都触发全局 membership 重拉。
      if (shouldBroadcastSnapshot) {
        // 打开/恢复任务是快照收敛，不改变 pin/archive/unread 归属；
        // 缺省 task_meta_changed 会让"每次点开任务"都触发全局 membership 重拉。
        await broadcastSnapshot(snapshot, "resumeSession", {
          ...syncOptions,
          broadcastReason: "task_status_changed",
        });
// 不广播的路径仍要把 model 落到 sqlite，否则手机端看到的模型会滞后一次操作。
      } else if (modelOverride && taskIndexSyncer) {
        await taskIndexSyncer.syncTaskModel(
          {
            workspacePath: agentParams.workspacePath,
            workspaceIdentity: agentParams.workspaceIdentity,
            sessionId: agentParams.sessionId,
          },
          modelOverride,
        );
      }
      logger.info(undefined, "[zcode-session-service] resumeSession 历史恢复完成", {
        agentDurationMs,
        broadcastDurationMs: shouldBroadcastSnapshot ? Date.now() - broadcastStartedAt : 0,
        broadcastSnapshot: shouldBroadcastSnapshot,
        durationMs: Date.now() - startedAt,
        mcpServerCount: agentParams.mcpServers?.length ?? 0,
        sessionId: agentParams.sessionId,
        snapshot: getSessionSnapshotDiagnostics(snapshot),
        workspaceIdentity: agentParams.workspaceIdentity ?? null,
        workspacePath: agentParams.workspacePath,
      });
      return snapshot;
    },

    listSessions(params: ZCodeSessionListParams) {
      return agentService.listSessions(params);
    },

// 只读路径不订阅、不广播：读历史不改变状态；修复空导入快照是为了让 UI 拿到可用历史，而不是把空白当成真实状态。
    async readSession(params: ZCodeSessionReadParams) {
      const startedAt = Date.now();
      const snapshot = await repairEmptyImportedClaudeSession(
        withApiRetryRuntime(await agentService.readSession(params)),
        params,
      );
      logger.info(undefined, "[zcode-session-service] readSession 历史快照读取完成", {
        deliveryKind: params.deliveryKind,
        durationMs: Date.now() - startedAt,
        messageLimit: params.messageLimit ?? null,
        sessionId: params.sessionId,
        snapshot: getSessionSnapshotDiagnostics(snapshot),
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return snapshot;
    },

    readSessionMessages(params: ZCodeSessionMessagesParams) {
      return agentService.readSessionMessages(params);
    },

    readSessionEvents(params: ZCodeSessionEventsParams) {
      return agentService.readSessionEvents(params);
    },

// [事务] 提升草稿：先用 has 记下结论再 forget，顺序固定——先 forget 再判断会让 wasDeferredDraft 恒为 false，订阅与日志都被跳过。
// 非草稿直接 resolve，调用方无需分支判断。
// 手机 replayable 首发由 task facade 消费草稿，这里必须清标记并通知 syncer，否则桌面后续控制同一 task 仍会按 deferred 规则跳过同步。
    promoteDeferredDraftSession(params: ZCodeTaskTarget) {
      const wasDeferredDraft = deferredDraftSessions.has(params);
      deferredDraftSessions.forget(params);
      if (!wasDeferredDraft) {
        return Promise.resolve();
      }
      // 手机 replayable 首发由 task facade 消费 deferred draft，需要在这里清除草稿标记
      // 并通知 task index 同步，避免桌面后续控制同一 task 时仍按 deferred 规则跳过同步。
      notifySyncer(params);
      logger.info(undefined, "[zcode-session-service] deferred draft session 已提升为 task", {
        sessionId: params.sessionId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return Promise.resolve();
    },

// [资源] 先失效草稿标记再关闭：close 失败也不能让标记残留，否则该 session 之后的所有写入都会被 defer 规则永久跳过。
    closeSession(params: ZCodeTaskTarget) {
      deferredDraftSessions.forget(params);
      return agentService.closeSession(params).then(() => undefined);
    },

// [失败路径] 条件关闭：expectedPersistence=deferred 让 agent 拒绝关闭已被提升的 active task，避免误关其它客户端正在使用的会话。
// 旧 agent 不认识该字段会抛错，安全降级是保留旧 session 并让调用方新建草稿，
// 绝不回退到无条件 close。
    async closeDeferredDraftSession(params: ZCodeTaskTarget) {
      try {
        const closed = await agentService.closeSession({
          ...params,
          expectedPersistence: "deferred",
        });
        if (closed) {
          deferredDraftSessions.forget(params);
        }
        return closed;
      } catch (error) {
        // 旧 Agent 会拒绝 expectedPersistence。安全降级是保留旧 session 并创建新草稿，
        // 不能回退到无条件 close，否则可能关闭刚被其他客户端提升的 active task。
        logger.warn(
          undefined,
          "[zcode-session-service] 条件关闭 deferred draft 失败，保留旧 session",
          {
            error: error instanceof Error ? error.message : String(error),
            sessionId: params.sessionId,
            workspaceIdentity: params.workspaceIdentity ?? null,
            workspacePath: params.workspacePath,
          },
        );
        return false;
      }
    },

// 配置变更也参与列表排序（updatedAt 与模型标签），顺序仍是先订阅、再写 agent、最后广播。
// 广播原因固定 task_model_changed：落到缺省 task_meta_changed 会被 UI 误判为归属变更，触发整表刷新。
    async setModel(params: ZCodeSessionSetModelParams) {
// 先取一次快照再决策：has 与后续分支之间若有并发提升，单次判断能保证本次调用行为自洽，不出现「订阅了却按草稿返回」的混合路径。
      const isDeferredDraft = deferredDraftSessions.has(params);
      if (!isDeferredDraft) {
        notifySyncer(params);
      }
      const snapshot = withApiRetryRuntime(await agentService.setModel(params));
// 草稿分支必须在广播之前返回，保证 task index 永远不会出现无消息的空会话。
      if (isDeferredDraft) {
        // deferred draft 只存在于 runtime 内存中，setModel 返回的是无消息空快照。
        // 如果这里订阅/写入 task index，进程重启后列表会留下无法 resume 的 "Session not found" 脏会话。
        return snapshot;
      }
// snapshot 已是 agent 写入后的结果，直接广播，不再二次读取。
      await broadcastSnapshot(snapshot, "setModel", {
        modelOverride: formatModelPickerValue(params.model),
        // 切模型属于纯配置变更，广播必须用 task_model_changed；
        // 之前落到缺省 task_meta_changed，UI 会误判为归属相关变更，
        // 触发全局 membership 重拉 + 左侧所有列表整刷。
        broadcastReason: "task_model_changed",
      });
      return snapshot;
    },

// 不广播也不通知 syncer：思考强度不改变列表归属、顺序或模型标签；
// 需要落库的场景由 resumeSession 的显式重放路径负责，避免每次切换都整表刷新。
    async setThoughtLevel(params: ZCodeSessionSetThoughtLevelParams) {
      return withApiRetryRuntime(await agentService.setThoughtLevel(params));
    },

    async setMode(params: ZCodeSessionSetModeParams) {
      return withApiRetryRuntime(await agentService.setMode(params));
    },

    respondProviderRuntimeHeaders(params) {
      return agentService.respondProviderRuntimeHeaders(params);
    },

    // M5 删波次 2：onDynamicSessionEvent（renderer 侧旧 session/subscribe 订阅面）已删。
    // v4 UI 的会话事件走 agentService 的 conversation 帧通道，本 service 不再向
    // agentService.onDynamicSessionEvent 建立任何订阅。
  };
}
