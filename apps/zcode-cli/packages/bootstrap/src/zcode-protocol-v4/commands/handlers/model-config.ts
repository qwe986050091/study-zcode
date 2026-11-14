// 模型配置命令组：switchModelConfig（自旧 server-operations.switchModelConfig 语义搬运）
// + switchCollaborationMode（additive，UI 模式选择器）
// + applyRequestedSessionConfig（createSession.config 消费共用件）。
// 每个命令组一个文件：handler 纯函数 (host, envelope) → CommandResult|undefined，
// 决策逻辑直驱 core（app.setModel / app.setMode / runtime.emit*），不经旧协议 op。
import type { CollaborationMode, ModelSelection } from "@zcode/contracts";
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { V4CommandNoopError } from "../../v4-gateway.js";
import { runSessionModelConfigMutation } from "../../model-config-mutation.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";

/** 同值切换的 noop reasonCode。 */
const CONFIG_UNCHANGED = "config.unchanged";

/**
 * 目标 Provider 不在当前 Environment Registry。Gateway 将其映射为 failed ACK；
 * 调用方需要刷新当前 Environment 的 Provider Config，而不是向 Worker 重推 Host Snapshot。
 */
class V4ProviderNotInRegistryError extends Error {
  readonly reasonCode = "provider.notInRegistry";
  constructor(providerId: string) {
    super(`provider "${providerId}" is not in the workspace model registry`);
  }
}

/**
 * 切模型前确认目标 Provider 已存在于当前 Environment Registry。`applied:false` 转换为
 * 结构化领域错误（gateway → failed ACK）。Host 未注入能力时保持旧 Entry 行为。
 */
/**
 * 确保当前选择对应的 Provider Client 已就绪（start/firstInput 之前调用）。
 * 失败时抛 promptRejected（restoreWarning 原样) / modelUnavailable；
 * 不修改 record，不改选择。
 */
async function ensureProviderClientReady(
  host: V4CommandCoreHost,
  sessionId: string,
  providerId: string,
): Promise<void> {
  if (!host.ensureProviderAvailable) return;
  const outcome = await host.ensureProviderAvailable(sessionId, providerId);
  if (!outcome.available && outcome.reason === "provider_not_in_registry") {
    throw new V4ProviderNotInRegistryError(providerId);
  }
  // session_not_found 等其余原因：requireRecord 已在 handler 侧先行校验，理论不达；
  // 兜底不抛（让后续 setModel 走既有路径/报错），避免吞掉真实定位。
}

/**
 * 从输入拼装带 provider 归属的 ModelSelection。
 * accountSelection（Highspeed 卡账户）优先于 accountId；两者都没有时由调用方
 * 从会话常驻 selection 补齐，保证 Core 侧不会因缺 provider 失败。
 * 纯函数，不读会话。
 */
function createModelSelection(provider: string, model: string, thought: string | undefined) {
  return {
    providerId: provider,
    modelId: model,
    ...(thought ? { options: { reasoningLevel: thought } } : {}),
  };
}

/**
 * 读取「实际生效的 effort/thought」：开启 fast 时不呈现 thought（UI 应隐藏该维度）；
 * 副作用：模型请求时锁定 thought 的告警只写一次（thoughtPinnedAt 标记），
 * 避免每轮重复刷日志；读取失败按缺省（不把遥测失败变成业务失败）。
 */
function readActualThought(
  record: V4SessionRecordView,
  fallbackSelection?: ModelSelection,
): string {
  const thought = record.app.getThoughtLevel();
  if (thought !== undefined) return thought;
  return fallbackSelection?.options?.reasoningLevel ?? "";
}

/** switchCollaborationMode 命令值域（command.ts z.enum 同源；auto 非用户可切不在内）。 */
const SWITCHABLE_MODES: ReadonlySet<string> = new Set(["build", "edit", "plan", "yolo", "guarded"]);

/**
 * switchModelConfig：切换会话的 Provider/Model（可选同时切 thought 档位）。
 * ACK 只回答「选择是否被接纳」：同值切换返回 noop(config.unchanged) 而非 accepted，
 * 让客户端能区分「已生效」与「本来就这个值」，不靠静默吞掉。
 * durable 事实：跨模型时 setModel（持久 provider/model），同模型时 setThoughtLevel
 * （显式 pin 叶子），随后补发 ModelSelected 供 v4 投影与审计收口。
 * 副作用：可能重建 provider client；不打断进行中的 turn（与旧路径保持一致）。
 * 失败：Provider 未就绪 / 非法 thought 档位在写库前抛错，不留下半套 Selection；
 * 串行化临界区内快照 previous，避免与 queue promotion 交错导致 previous 过期。
 * 幂等：同 commandId 由持久 command fact 去重；本 handler 不缓存。
 */
/**
 * switchModelConfig：切换会话模型选型。跨模型时 app.setModel 换 provider client + 模型，
 * 同模型时 thought 才是显式思考深度切换，随后补发 ModelSelected——v4 投影的 config 区
 * 更新与中途切换的 modelChange marker 都靠这条事件（reducer onModelSelected）。
 *
 * 行为等价说明：旧协议路径无 active turn guard（运行中也允许切换），这里保持一致不加。
 */
async function switchModelConfig(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["switchModelConfig"];
  const record = requireRecord(host, envelope.sessionId);
  return runSessionModelConfigMutation(record.app, async () => {
    // previous 必须在串行化临界区内、setModel 之前快照。registry fallback 可能排在本命令
    // 前面，若在排队前读取会拿到过期 previous，并让 noop/事件顺序与 runtime 真值分裂。
    const previousSelection = record.app.runtime.getSessionModelSelection();
    const previousModelSelection =
      previousSelection &&
      createModelSelection(
        previousSelection.providerId,
        previousSelection.modelId,
        previousSelection.options?.reasoningLevel,
      );
    const previousThought = readActualThought(record, previousSelection);
    const modelIdentityChanged =
      previousSelection?.providerId !== payload.provider ||
      previousSelection?.modelId !== payload.model;
    const requestedThought = payload.thought.trim();
    const thoughtChanged =
      Boolean(requestedThought) && requestedThought !== previousSelection?.options?.reasoningLevel;
    // 同值切换收口：命中 runtime 当前值 → noop ACK（config.unchanged），
    // 不得以 accepted 静默吞掉——种子对齐后「UI 显示值 = runtime 真值」成立，
    // 客户端据此区分「已生效」与「本来就是这个值」。
    if (!modelIdentityChanged && !thoughtChanged) {
      throw new V4CommandNoopError(CONFIG_UNCHANGED);
    }
    // setModel 前由当前 Environment Registry 确认目标 Provider 可用。
    await ensureProviderClientReady(host, record.app.sessionId, payload.provider);
    let actualThought = previousThought;
    let nextModelSelection: ModelSelection;
    if (modelIdentityChanged) {
      const result = await record.app.setModel(`${payload.provider}/${payload.model}`);
      actualThought = result.thoughtLevel ?? readActualThought(record);
      if (requestedThought && record.app.listThoughtLevels().includes(requestedThought)) {
        // 用户即使显式选择了与默认值相同的档位，也是一项 pin。必须调用 setter 让
        // Session Selection 保存这个显式叶子，不能因为 effective 值相同而吞掉意图。
        const thoughtResult = await record.app.setThoughtLevel(requestedThought);
        actualThought = thoughtResult.thoughtLevel;
      }
      nextModelSelection = createModelSelection(
        payload.provider,
        payload.model,
        requestedThought && record.app.listThoughtLevels().includes(requestedThought)
          ? requestedThought
          : undefined,
      );
    } else {
      // provider/model 相同才表示用户显式切 thought；非法值在任何模型变更前失败。
      const result = await record.app.setThoughtLevel(requestedThought);
      actualThought = result.thoughtLevel;
      nextModelSelection = createModelSelection(payload.provider, payload.model, actualThought);
    }
    await record.app.runtime.emitModelSelected({
      modelSelection: nextModelSelection,
      ...(actualThought ? { effectiveReasoningLevel: actualThought } : {}),
      previousModelSelection,
      supportedThoughtLevels: record.app.listThoughtLevels(),
      // trace 链路结构透传自 record（会话根 trace），不在命令层另起无关联 traceId。
      traceContext: record.traceContext,
    });
    return undefined;
  });
}

/**
 * switchCollaborationMode：切换 agent 协作模式（plan/build/edit/yolo）。
 * ACK 只表示模式已接纳；模式与 planEnabled 必须一起收敛，否则会出现
 * mode=default 但 planEnabled=true 的分裂态（plan 关闭时由 setMode 重置）。
 * durable 事实：mode 持久化，事件 SessionModeChanged 由 app 层发布一次，命令层不补发。
 * 失败：落库失败向上抛；不伪造成功。
 */
/**
 * switchCollaborationMode：切换 agent 协作模式（plan/build/edit/yolo）。
 * app.setMode 统一更新独立执行状态、持久化并发布 SessionModeChanged，
 * 命令层不再补发第二次事件，
 * v4 投影 reducer onSessionModeChanged 据此更新 config.mode。
 * 同值切换 → noop ACK：静默 return undefined 会被当 accepted，若投影种子缺失
 * 会叠加成「点完全访问没反应」的用户可见问题——CLI 认为已是 yolo
 * 提前返回，投影却还停在种子 build，且客户端无从判别。因此必须显式 ACK。
 */
async function switchCollaborationMode(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["switchCollaborationMode"];
  const record = requireRecord(host, envelope.sessionId);
  const mode = payload.mode as CollaborationMode;
  const previousMode = record.app.getMode();
  if (previousMode === mode && !record.app.runtime.getPlanEnabled()) {
    throw new V4CommandNoopError(CONFIG_UNCHANGED);
  }
  await record.app.setMode(mode);
  return undefined;
}

/**
 * 把 createSession 请求里的 config 合并到已建会话（initial config 的唯一消费点）。
 * 输入：host + record + 请求 config（modelSelection / thought / fast / effort /
 * collaborationMode）。输出：无；事件补发即投影来源。
 * 副作用：可能改持久 selection、runtime effort/plan，并补发 ModelSelected /
 * SessionModeChanged（与 switch 命令同源，日志自足可重放）。
 * 失败：部分步骤失败降级为 warn（会话已创建，不连坐失败）；但模型/模式这类
 * 主配置失败仍按 guarded 语义抛错，由 createSession 关闭会话后拒绝（不静默半配置）。
 * 维护的不变量：只对与 runtime 当前值不同的字段生效，避免无意义事件噪音。
 */
/**
 * createSession.config 消费共用件（「createSession.config 必须被消费」）：
 * 以「请求 config 覆盖 runtime 缺省」归并，只对与 runtime 当前值不同的部分生效，
 * 并补发与 switch 命令同源的事件（ModelSelected / SessionModeChanged）——日志自足，
 * 投影经既有 reducer 收口，不依赖第二条写路径。
 *
 * 为什么走事件而不是直改种子：publisher 在 createSessionRecord 事件接线期间已创建，
 * 种子读的是应用请求 config 之前的 runtime 缺省；事件补发既修正投影，又让
 * 「首发用什么模型」这个事实进日志（冷恢复重放可复原）。首次选型 prev 为空时
 * reducer 不产 modelChange marker（onModelSelected「首次选型不算切换」），无噪音行。
 *
 * 部分失败语义：会话已创建成功，config 应用失败不应连坐 createSession（record 泄漏
 * 换一个 failed ACK 不值当）——调用方捕获后降级为 warn，会话保持 runtime 缺省。
 */
export async function applyRequestedSessionConfig(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  config: NonNullable<CommandPayloadMap["createSession"]["config"]>,
): Promise<void> {
  await runSessionModelConfigMutation(record.app, async () => {
    const previousSelection = record.app.runtime.getSessionModelSelection();
    const previousModelSelection =
      previousSelection &&
      createModelSelection(
        previousSelection.providerId,
        previousSelection.modelId,
        previousSelection.options?.reasoningLevel,
      );
    const previousThought = readActualThought(record, previousSelection);
    const requestedSelection = config.modelSelection;
    const targetProvider =
      requestedSelection?.providerId ?? config.provider?.trim() ?? previousSelection?.providerId;
    const targetModel =
      requestedSelection?.modelId ?? config.model?.trim() ?? previousSelection?.modelId;
    const targetThought =
      requestedSelection?.options?.reasoningLevel ?? config.thought?.trim() ?? "";
    const modelIdentityChanged =
      targetProvider !== previousSelection?.providerId ||
      targetModel !== previousSelection?.modelId;
    const thoughtChanged =
      Boolean(targetThought) &&
      targetThought !==
        (requestedSelection ? previousSelection?.options?.reasoningLevel : previousThought);
    if (targetProvider && targetModel && (modelIdentityChanged || thoughtChanged)) {
      // 首发 Provider 不在 Registry 时抛 provider.notInRegistry，createSession 处捕获降级为
      // warn（会话保持 runtime 缺省，不连坐创建），语义与既有 config 应用失败一致。
      await ensureProviderClientReady(host, record.app.sessionId, targetProvider);
      let actualThought = previousThought;
      if (modelIdentityChanged) {
        const result = await record.app.setModel(`${targetProvider}/${targetModel}`);
        actualThought = result.thoughtLevel ?? readActualThought(record);
      }
      if (targetThought && record.app.listThoughtLevels().includes(targetThought)) {
        const result = await record.app.setThoughtLevel(targetThought);
        actualThought = result.thoughtLevel;
      } else if (requestedSelection?.options?.reasoningLevel) {
        // 正式结构化 Selection 的显式 option 必须 fail-closed；只有旧 flat config
        // 保留“目标不支持则使用默认值”的已发布兼容行为。
        await record.app.setThoughtLevel(targetThought);
      }
      if (modelIdentityChanged || actualThought !== previousThought) {
        // 草稿预热 config 可能携带上一模型的 thought。目标模型不支持时保留
        // setModel 已解析出的兼容档位，仍发布目标模型事件，避免创建出 runtime/投影分裂的 session。
        await record.app.runtime.emitModelSelected({
          modelSelection: createModelSelection(
            targetProvider,
            targetModel,
            targetThought && record.app.listThoughtLevels().includes(targetThought)
              ? targetThought
              : undefined,
          ),
          ...(actualThought ? { effectiveReasoningLevel: actualThought } : {}),
          previousModelSelection,
          supportedThoughtLevels: record.app.listThoughtLevels(),
          traceContext: record.traceContext,
        });
      }
    }
  });

  // mode：payload.config.mode 是宽 string（schema default 兼容），值域在此收口。
  const mode = config.mode;
  if ((mode && SWITCHABLE_MODES.has(mode)) || config.planEnabled !== undefined) {
    await record.app.runtime.setExecutionState(
      {
        ...(mode && SWITCHABLE_MODES.has(mode) ? { mode } : {}),
        ...(config.planEnabled !== undefined ? { planEnabled: config.planEnabled } : {}),
      },
      record.traceContext,
    );
  }

  // followupMode：runtime 缺省即 queue（投影初值同），仅非缺省值需要显式写——
  // runtime.setFollowupMode 无同值守卫（无条件追加事件），显式传 "queue" 会产空转 delta。
  if (config.followupMode && config.followupMode !== "queue") {
    await record.app.setFollowupMode(config.followupMode);
  }
}

/** 本组原生命令注册表（模型/协作模式配置），供 handlers/index.ts 合并。 */
export const modelConfigHandlers = { switchModelConfig, switchCollaborationMode };
