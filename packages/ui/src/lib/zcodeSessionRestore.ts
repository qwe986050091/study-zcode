// INV-01 必须先 resume 激活再 readSession 读取，顺序不可颠倒；守住位置：恢复函数的 try 首段；改错故障：历史 task 首次打开读取失败，界面停在加载态。
// INV-02 resume 必须透传 task meta 的 model 与 thoughtLevel；守住位置：resumeSession 参数的条件展开；改错故障：默认模型污染历史会话，续聊窗口与思考强度被改写。
// INV-03 只有 session 缺失与模型不可用两类错误可降级；守住位置：catch 的双条件白名单；改错故障：真实的 IO 或权限错误被吞成历史快照，用户看不到失败原因，也无从重试。
// INV-04 未注入 task 服务时任何 resume 失败都必须原样抛出；守住位置：catch 首个子条件；改错故障：错误被替换成半成品快照，上层拿不到可诊断的异常，只能上报未知错误。
// INV-05 legacy 降级必须按 desktop-continuous 取快照；守住位置：getTaskSnapshot 的 clientMode；改错故障：拿到手机语义的裁剪快照，历史消息条数与层级都对不上。
// INV-06 legacy 快照为空时必须抛回原始错误；守住位置：`if (!legacySnapshot)` 早退分支；改错故障：任务被当成已恢复但没有消息，用户失去重试入口，只能回到任务列表。
// INV-07 模型不可用降级必须同时产出 restoreWarning；守住位置：返回对象的条件展开；改错故障：界面只显示历史却不提示重选模型，用户点击续聊无反馈。
// INV-08 模型不可用诊断只记 providerId 与 modelId；守住位置：getRuntimeModelUnavailableDiagnostics 的返回结构；改错故障：日志体积暴涨并可能带出与恢复无关的字段。
// INV-09 restoreWarning 统一由 normalizeZCodeUiError 生成；守住位置：降级返回值的构造处；改错故障：错误码在两条链路间分裂，前端无法按码渲染提示。
// INV-10 正常路径必须同时返回投影快照与 resume 快照；守住位置：函数末尾的返回对象；改错故障：事件序号、pending 请求与 session 状态在恢复后丢失。
// INV-11 messageLimit 仅在为数字时透传；守住位置：两处 readSession 的条件展开；改错故障：显式 undefined 覆盖服务端默认值，首屏拉全量历史导致卡顿。
// INV-12 deliveryKind 决定裁剪语义，desktop 与 web 不得互换；守住位置：两处 readSession 的字面量；改错故障：手机拿到桌面全量快照，或桌面只拿到一条消息，两端表现都是历史缺失。
// INV-13 web replayable 只在给出 model 时先 resume；守住位置：readWebRemoteReplayableSessionConfigOptions 的 params.model 判断；改错故障：只读场景被强行激活，占用多余运行时。
// INV-14 web replayable 读取配置固定 messageLimit 为 1；守住位置：该函数 readSession 的参数；改错故障：为读配置拉全量历史，手机弱网下首屏明显变慢且流量翻倍。
// INV-15 配置选项只从 session settings 投影；守住位置：zcodeSessionSettingsToConfigOptions 的入参；改错故障：模型选项与实际会话不一致，用户改了不生效。
// INV-16 web 链路遇 session 不活跃返回 null；守住位置：catch 中的 isSessionMissingError 分支；改错故障：可选的配置读取把整页渲染打断，直接进入错误边界。
// INV-17 错误识别只按消息文本与稳定 code 匹配；守住位置：两个 isXxxError 函数；改错故障：跨进程传递后 instanceof 失效，降级分支永不触发，用户只能看到报错。
// INV-18 每个阶段只落一条 info 日志并带齐路径与耗时；守住位置：各阶段 logger.info 调用；改错故障：线上无法按阶段定位慢恢复。
//
// 模块职责：把会话恢复拆成先激活、再读取、失败降级三步，统一产出 UI 可直接消费的快照与提示。
// 状态所有权：本模块不缓存会话状态，session 归 zcodeSessionService，历史快照归 zcodeTaskService。
// 阅读顺序：先看错误分类与类型契约，再看 desktop 恢复三段，最后看 web replayable 的 null 语义。
import type { IZCodeSessionService, IZCodeTaskService } from "@zcode/services";
import type {
  ZCodeConfigOption,
  ModelSelection,
  ZCodeSessionStateSnapshot,
  ZCodeTaskSnapshot,
} from "@zcode/shared";
import {
  zcodeSessionSettingsToConfigOptions,
  zcodeSessionSnapshotToZCodeTaskSnapshot,
} from "@/lib/zcodeSessionProjection.js";
import { normalizeZCodeUiError, type ZCodeUiError } from "@/lib/zcodeUiError.js";
import { logger } from "@/logger.js";

// 依赖注入只暴露 readSession 与 resumeSession，测试替身不必实现整个会话服务。
// Pick 的是接口方法名而不是结构体，服务实现改签名时这里会一起报类型错。
// [权衡] resumeSession 的可选参数没有单独建模，能力边界仍由服务层签名决定。
export type ZCodeSessionRestoreService = Pick<
  IZCodeSessionService,
  "readSession" | "resumeSession"
>;
// legacy 兜底只需要 getTaskSnapshot，说明降级路径只读不写，不会反过来改动任务。
// 与上一个类型分开声明，web 侧只注入会话服务时不必被迫提供 task 服务。
// 可选性由调用方是否传入 zcodeTaskService 体现，缺省即关闭降级。
export type ZCodeLegacyTaskSnapshotRestoreService = Pick<IZCodeTaskService, "getTaskSnapshot">;

// snapshot 总是存在，是这条链路对 UI 的唯一事实来源，其余字段只补充来源与提示。
// resumedSessionSnapshot 只在正常路径出现，降级时缺席，调用方据此判断能否续聊。
// usedLegacySnapshot 是显式标记而不是靠字段有无推断，避免判断出现二义。
export interface DesktopContinuousSessionRestoreSnapshot {
  snapshot: ZCodeTaskSnapshot;
  restoreWarning?: ZCodeUiError;
  resumedSessionSnapshot?: ZCodeSessionStateSnapshot;
  usedLegacySnapshot?: boolean;
}

function isSessionMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  // [失败路径] 只识别两种固定句式，服务端改文案时降级会静默失效并冒泡原错。
  // 用不区分大小写的正则做包含匹配，兜住原因被拼在消息前缀的写法。
  // 非 Error 抛出物先转字符串再匹配，避免取值阶段二次抛错打断判断。
  return /\bSession (not found|is not active):/i.test(message);
}

function isRuntimeModelUnavailableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    // [权衡] 按 code 字段做鸭子类型判断，跨进程序列化后的错误对象仍能识别。
    // 只认这一个稳定错误码，文案差异不会改变降级结果。
    // 因此不要求错误对象是普通字面量，原型链上的 code 也能读到。
    error.code === "ZCODE_RUNTIME_MODEL_UNAVAILABLE"
  );
}

function getRuntimeModelUnavailableDiagnostics(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null || !("data" in error)) {
    return {};
  }
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) {
    return {};
  }
  const model = "model" in data ? (data as { model?: unknown }).model : undefined;
  return {
    errorData: data,
    errorModel:
      typeof model === "object" && model !== null
        ? {
            modelId: "modelId" in model ? (model as { modelId?: unknown }).modelId : null,
            providerId:
              "providerId" in model ? (model as { providerId?: unknown }).providerId : null,
          }
        : null,
  };
}

function getSessionSnapshotDiagnostics(snapshot: ZCodeSessionStateSnapshot) {
  return {
    activeTurnId: snapshot.runtime.activeTurnId ?? null,
    eventSeq: snapshot.runtime.eventSeq,
    messageCount: snapshot.messages.length,
    pendingRequestCount: snapshot.runtime.pendingRequestIds.length,
    sessionStatus: snapshot.session.status,
    stateRevision: snapshot.runtime.stateRevision,
  };
}

export async function readDesktopContinuousSessionRestoreSnapshot(params: {
  zcodeSessionService: ZCodeSessionRestoreService;
  zcodeTaskService?: ZCodeLegacyTaskSnapshotRestoreService;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  messageLimit?: number;
  model?: ModelSelection;
  thoughtLevel?: string;
}): Promise<DesktopContinuousSessionRestoreSnapshot> {
  // Bugfix: session/read 只能读取 runtime 里的活跃 session。
  // 历史 task 首次打开时必须先 resume 激活，再按 desktop continuous 读取限流快照。
  const startedAt = Date.now();
  // 变量声明在 try 之外，让正常路径的返回值能带上激活瞬间的 runtime 快照。
  // 声明时不赋初值，只有 resume 成功才写入，编译期即可拦住误用未激活快照。
  // 它与随后 readSession 的结果不是同一份对象：前者反映激活时刻，后者反映读取时刻。
  let resumedSessionSnapshot: ZCodeSessionStateSnapshot;
  try {
    const resumeStartedAt = Date.now();
    // 顺序是硬约束：先激活 runtime 里的 session，readSession 才有上下文可读。
    // workspaceIdentity 与 workspacePath 同时透传，身份隔离与路径语义不在本层合并。
    // resume 的错误不在这里被吞掉，交给 catch 按类别决定降级还是冒泡。
    resumedSessionSnapshot = await params.zcodeSessionService.resumeSession({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      sessionId: params.sessionId,
      // Bugfix: 历史 task 首次打开时必须带上 task meta 里的模型。
      // 同时带 task-local thoughtLevel，避免 draft/workspace 默认思考强度污染同模型 active task。
      ...(params.model ? { model: params.model } : {}),
      ...(params.thoughtLevel ? { thoughtLevel: params.thoughtLevel } : {}),
    });
    logger.info("[zcodeSessionRestore] desktop resumeSession 完成", {
      durationMs: Date.now() - resumeStartedAt,
      messageLimit: params.messageLimit ?? null,
      sessionId: params.sessionId,
      snapshot: getSessionSnapshotDiagnostics(resumedSessionSnapshot),
      totalDurationMs: Date.now() - startedAt,
      workspaceIdentity: params.workspaceIdentity ?? null,
      workspacePath: params.workspacePath,
    });
  } catch (error) {
    if (
      // 降级闸门是“有 task 服务”且“错误属于两类可降级错误”，缺一即原样抛出。
      // [失败路径] 未注入 task 服务时不返回半成品快照，错误语义在两条链路上一致。
      // 判断放在读取 legacy 之前，避免为不该降级的错误白打一次快照请求。
      !params.zcodeTaskService ||
      (!isSessionMissingError(error) && !isRuntimeModelUnavailableError(error))
    ) {
      throw error;
    }

    const runtimeModelUnavailable = isRuntimeModelUnavailableError(error);
    if (runtimeModelUnavailable) {
      logger.info(
        "[zcodeSessionRestore][diag:model-unavailable] desktop resumeSession 模型不可用",
        {
          messageLimit: params.messageLimit ?? null,
          requestedModelId: params.model?.modelId ?? null,
          requestedProviderId: params.model?.providerId ?? null,
          sessionId: params.sessionId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspacePath: params.workspacePath,
          ...getRuntimeModelUnavailableDiagnostics(error),
        },
      );
    }
    // Bugfix: 旧 ACP task 缺少 protocol session，或历史 task 的模型已从当前 registry 删除时，
    // 都不能继续伪造 active session。这里退回 task facade 的 snapshot 读取，只恢复历史显示；
    // 真正续聊必须等用户显式选择当前可用模型。
    const legacyStartedAt = Date.now();
    const legacySnapshot = await params.zcodeTaskService.getTaskSnapshot({
      taskId: params.sessionId,
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      ...(typeof params.messageLimit === "number" ? { messageLimit: params.messageLimit } : {}),
      clientMode: "desktop-continuous",
    });
    // [失败路径] 返回空表示这条任务连快照都没有，抛回原始错误更有诊断价值。
    // 不构造空快照返回，防止 UI 把查不到渲染成恢复成功但没有消息。
    // 空值判断用真值而不是字段检查，与 task 服务的可空约定保持一致。
    if (!legacySnapshot) {
      throw error;
    }
    logger.info("[zcodeSessionRestore] desktop legacy 快照读取完成", {
      durationMs: Date.now() - legacyStartedAt,
      messageCount: legacySnapshot.messages.length,
      messageLimit: params.messageLimit ?? null,
      sessionId: params.sessionId,
      totalDurationMs: Date.now() - startedAt,
      workspaceIdentity: params.workspaceIdentity ?? null,
      workspacePath: params.workspacePath,
    });
    return {
      snapshot: legacySnapshot,
      ...(runtimeModelUnavailable
        ? {
            restoreWarning: normalizeZCodeUiError(error, {
              fallbackCode: "ZCODE_RUNTIME_MODEL_UNAVAILABLE",
              taskId: params.sessionId,
            }),
          }
        : {}),
      // 该标记只在降级路径出现，调用方用它区分可续聊会话与仅可展示的历史。
      // 标记与 restoreWarning 相互独立：模型不可用会同时给出两者。
      // 该标记为 true 时不带 resumedSessionSnapshot，续聊前必须重新激活。
      usedLegacySnapshot: true,
    };
  }
  const readStartedAt = Date.now();
  // 正常路径固定使用 desktop-continuous，表示要桌面实时链路的限流快照。
  // 不再重复传 model 与 thoughtLevel：激活阶段已把模型写进 runtime。
  // messageLimit 仅在为数字时展开，缺席与服务端默认不限的约定一致。
  const readSessionSnapshot = await params.zcodeSessionService.readSession({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    sessionId: params.sessionId,
    deliveryKind: "desktop-continuous",
    ...(typeof params.messageLimit === "number" ? { messageLimit: params.messageLimit } : {}),
  });
  const readDurationMs = Date.now() - readStartedAt;
  const projectionStartedAt = Date.now();
  // 投影是纯函数：messages、settings 与 runtime 被拍平成 UI 侧的 task 快照。
  // 转换发生在日志之前，日志记的是转换后的条数与状态，便于对照渲染结果。
  // 本层不修改快照字段，裁剪与排序都由投影函数负责，避免两处规则不一致。
  const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot(readSessionSnapshot);
  logger.info("[zcodeSessionRestore] desktop readSession 快照转换完成", {
    durationMs: Date.now() - startedAt,
    messageLimit: params.messageLimit ?? null,
    projectionDurationMs: Date.now() - projectionStartedAt,
    readDurationMs,
    sessionId: params.sessionId,
    snapshot: {
      history: snapshot.history ?? null,
      messageCount: snapshot.messages.length,
      status: snapshot.meta.status,
    },
    workspaceIdentity: params.workspaceIdentity ?? null,
    workspacePath: params.workspacePath,
  });
  return {
    resumedSessionSnapshot,
    snapshot,
  };
}

export async function readWebRemoteReplayableSessionConfigOptions(params: {
  zcodeSessionService: ZCodeSessionRestoreService;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  model?: ModelSelection;
  thoughtLevel?: string;
}): Promise<ZCodeConfigOption[] | null> {
  const startedAt = Date.now();
  try {
    if (params.model) {
      const resumeStartedAt = Date.now();
      // Bugfix: 手机 replayable 配置读取会早于后续 resumeTask。
      // 先带历史模型激活 session，避免 readSession 读取到被默认模型污染的 settings/context window。
      // 只在带模型时先激活，让读到的 settings 属于历史模型而不是当前默认值。
      // [权衡] 这里不处理错误：是否跳过配置读取由上层决定，本函数只抛出异常。
      // 激活与读取的顺序不能反，反了会读到未激活 session 的缺省 settings。
      const resumed = await params.zcodeSessionService.resumeSession({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        sessionId: params.sessionId,
        model: params.model,
        ...(params.thoughtLevel ? { thoughtLevel: params.thoughtLevel } : {}),
      });
      logger.info("[zcodeSessionRestore] replayable task 配置读取前 resumeSession 完成", {
        durationMs: Date.now() - resumeStartedAt,
        requestedModelId: params.model.modelId,
        requestedProviderId: params.model.providerId,
        sessionId: params.sessionId,
        snapshot: getSessionSnapshotDiagnostics(resumed),
        totalDurationMs: Date.now() - startedAt,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
    }
    const snapshot = await params.zcodeSessionService.readSession({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      sessionId: params.sessionId,
      deliveryKind: "web-remote-replayable",
      // [权衡] 配置读取只关心 settings，把消息数压到 1，避免拉取全量历史。
      // 固定常量而不是由调用方传入，防止误传大 limit 把弱网首屏拖慢。
      // 与 desktop 链路的可选限流不同，这里的 1 是契约常量，改动需同步协议。
      messageLimit: 1,
    });
    const options = zcodeSessionSettingsToConfigOptions(snapshot.settings);
    logger.info("[zcodeSessionRestore] replayable task 配置读取完成", {
      configOptionCount: options.length,
      durationMs: Date.now() - startedAt,
      sessionId: params.sessionId,
      snapshot: getSessionSnapshotDiagnostics(snapshot),
      workspaceIdentity: params.workspaceIdentity ?? null,
      workspacePath: params.workspacePath,
    });
    return options;
  } catch (error) {
    // [失败路径] session 不活跃时返回 null，表示没有配置可读而不是读取失败。
    // 其余错误照旧冒泡，鉴权与网络问题不会被当成可选能力静默忽略。
    // 该分支仍记一条 info 日志，便于区分未激活跳过与真的读到空配置。
    if (isSessionMissingError(error)) {
      logger.info("[zcodeSessionRestore] replayable task 配置读取跳过，session 不活跃", {
        durationMs: Date.now() - startedAt,
        sessionId: params.sessionId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return null;
    }
    throw error;
  }
}
