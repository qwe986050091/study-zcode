// 内核（runtime/contracts）→ v3 协议快照与事件的全部映射逻辑。
// 这里是跨进程边界：写出去的每个字段都会被旧桌面端的 strict schema 校验，
// 因此本文件的核心职责不是「多给信息」，而是「只给旧端认识的、且语义不降级的字段」。
//
// 不变量（INV）：
// INV-01 goal 权威状态以 DB 侧 session_target（input.target）为准，runtime projection 只兜底
//   （守住它的位置：buildSessionSnapshot 的 projection 合成）。恢复历史会话时 runtime 可能没有
//   target_changed 账本，反过来会让 goal 状态回退。
// INV-02 快照必须是稳定 JSON：Date 只能以 number/string 出现，undefined 不写入
//   （守住它的位置：protocolInstantValue 与各条件展开）。违者会被接收端整份丢弃。
// INV-03 v3 只做「源头剥离」，绝不把新字段漏进 strict schema（守住它的位置：
//   mapPendingPermission / mapPermissionRequestedPayload 的显式解构）。已经装出去的旧桌面
//   改 schema 也保护不了，新字段会让 permission.requested 整条 safeParse 失败——确认窗消失。
// INV-04 允许预览降级，不允许 gate 降级（守住它的位置：permission 映射）。
// INV-05 图片回填 data URL 上限 20MB，超限保留 artifact 引用（守住它的位置：
//   hydrateSnapshotFilePartUrl）。无上限会把整份快照撑爆 IPC。
// INV-06 附件回填失败必须静默保留原 part（守住它的位置：hydrateSnapshotFilePartUrl 的 catch）；
//   快照不能因为一张历史图片读不到而整体失败。
// INV-07 思考档位必须属于当前模型的可选列表，否则置空（守住它的位置：mapSessionSettings）；
//   setModel 过渡期会残留上一个模型的档位。
// INV-08 goal 轮次只能由 verifier 生命周期边界推进，消息本身不能开新轮（守住它的位置：
//   getGoalIterationForMessageTime）。
// INV-09 时间戳优先级：持久化 session 行 > 调用方 fallback > projection > now（守住它的位置：
//   mapSessionInfo）。刚创建的 session 会继承 draft 预热时间，不能当正式创建时间。
// INV-10 timeline 与 summary 合并必须按 (passed, reason, nextAction) 去重（守住它的位置：
//   mergeGoalVerificationSummaries）。否则同一次验证会出现两行。
// INV-11 todo 分组以 target + 内容指纹归并，同一事项只保留最后一次归属（守住它的位置：
//   buildTodoGroups 的 todoOwners）。
// INV-12 事件 seq 允许被投递序号覆盖，保证订阅端看到单调帧序（守住它的位置：mapSessionEvent）。
// INV-13 StreamingToolLedgerUpdated 与 DynamicWorkflowRunProgress 不透出（守住它的位置：
//   shouldExposeSessionEventToProtocol）。它们是内部账本，重复全量搬运大参数。
// INV-14 text/reasoning 空 delta 丢弃，tool_input_* 永不丢弃（守住它的位置：同一函数）。
// INV-15 context usage 的 breakdown 必须与 used/window 对齐，否则可能挂到旧分支或 sidecar 请求上
//   （守住它的位置：applyContextUsageBreakdown / latestContextUsageBreakdownFromEvents）。
// INV-16 压缩后水位只能取 user summary 的 compactBoundary，不能越过它扫描更早的 assistant
//   （守住它的位置：contextUsageFromPersistedMessages）。
// INV-17 mapSessionEventType 的 default 落到 session.updated：新事件类型不会被旧端拒收
//   （守住它的位置：该 switch 的 default）。
// INV-18 所有排序必须稳定：时间相同再比 sequenceNumber / id（守住它的位置：三个 compare 函数）。
//
// 阅读顺序：快照组装 → 附件回填 → settings/info → 事件映射与透出白名单 → projection/runtime →
// context usage → goal/todo 重建 → 事件类型表。
import {
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  getZCodeGoalActiveIterationCount,
  zcodeApiRetryFromModelNetworkStatusPayload,
  zcodeApiRetryFromStreamRecoveryPayload,
  zcodeContextUsageBreakdownSchema,
  type ZCodeActiveToolCall,
  type ZCodeContextUsageBreakdownItem,
  type ZCodeDeliveryKind,
  type ZCodePendingPermission,
  type ZCodeSessionContextUsage,
  type ZCodeSessionEvent,
  type ZCodeSessionGoal,
  type ZCodeSessionGoalVerification,
  type ZCodeSessionGoalVerificationTimeline,
  type ZCodeSessionGoalStats,
  type ZCodeSessionInfo,
  type ZCodeSessionKind,
  type ZCodeSessionProjection,
  type ZCodeSessionRuntimeState,
  type ZCodeSessionSettingsState,
  type ZCodeSessionStateSnapshot,
  type ZCodeSessionTodoGroup,
  type ZCodeWorkspaceRef,
  isMainAgentToolProjectionSource,
} from "@zcode/shared";
import {
  EventReducer,
  SessionEventType,
  getModelUsageContextTokens,
  type ActiveToolCall,
  type BackgroundTaskInfo,
  type GoalCompletionVerificationOutput,
  type MessageWithParts,
  type ModelCompletePayload,
  type PendingPermission,
  type SessionEvent,
  type SessionGoal,
  type SessionInfo,
  type SessionProjection,
  type TodoItem,
  type ToolState,
} from "@zcode/contracts";
import type { ZCodeApp } from "../app/types.js";
import { mapMessageWithParts } from "./message-mapper.js";
import { formatProtocolModelSelection, optionalModelSelectionFromString } from "./model-mapper.js";
import {
  buildProtocolPermissionOptions,
  toLegacyPermissionOptionsPolicy,
} from "./permission-options.js";
import {
  listProtocolSlashCommands,
  type ListProtocolSlashCommandsOptions,
} from "./slash-commands.js";

// 单张内联图上限 20MB（base64 后体积）；
// 超过上限时保留 zcode-artifact 引用，让客户端自行决定是否取，
// 而不是让整份快照因一张大图无法序列化。
const SNAPSHOT_INLINE_IMAGE_DATA_URL_MAX_BYTES = 20 * 1024 * 1024;

// 快照组装入口：把 runtime projection、DB 侧 goal 权威状态与消息流合并成同一份
// session 快照；messages/settings/slashCommands/todos 等子视图都从这里统一产出。
export async function buildSessionSnapshot(input: {
  app: ZCodeApp;
  deliveryKind?: ZCodeDeliveryKind;
  eventSeq: number;
  fallbackCreatedAt?: number;
  fallbackUpdatedAt?: number;
  lastError?: SessionProjection["lastError"];
  messages: MessageWithParts[];
  modelAvailability?: "all" | "current";
  persistedGoalVerificationEvents?: SessionEvent[];
  persistedContextUsageBreakdownEvents?: SessionEvent[];
  session?: SessionInfo | null;
  stateRevision: number;
  slashCommandOptions?: ListProtocolSlashCommandsOptions;
  target?: SessionGoal | null;
  todos?: TodoItem[];
  workspace: ZCodeWorkspaceRef;
// 快照的唯一组装点：messages/projection/runtime/session/settings/slashCommands/goal/todo；
// 所有子视图共享同一次 projection 计算，避免各自读 runtime 造成版本不一致。
// 它是 UI 与测试的共同事实源，字段缺失会被 strict schema 判为无效。
}): Promise<ZCodeSessionStateSnapshot> {
  // 运行期投影来自 eventStore reducer，是「内存里发生过什么」；
  // 它不能作为 goal 权威，但 activeTurn 等实时字段仍以它为准。
  const runtimeProjection = await input.app.runtime.getProjection();
  const activeTurn = input.app.runtime.getActiveTurnInfo();
  // 冷恢复时 runtime eventStore 不保留已完成 verifier 事件，必须用持久化事件重放；
  // 重放结果只补 timeline/summary，不覆盖 target 权威值。
  // 空事件列表会直接返回原投影，保持引用相等。
  const persistedGoalProjection = mergePersistedGoalVerificationEvents(
    runtimeProjection,
    input.persistedGoalVerificationEvents ?? [],
    // target 为 undefined 表示调用方没有 DB 读取结果，此时才允许使用 runtime 投影；
    // 显式 null 是有效值（表示无 goal），不能被 `??` 吞掉。
    input.target === undefined ? runtimeProjection.target : input.target,
  );
  // runtime projection 是运行期 eventStore reducer，恢复历史 session 时可能没有
  // target_changed 账本；session_target 表才是 goal 权威状态，snapshot 必须以 DB 读取值为准。
  // 只覆盖调用方明确给出的字段（target / lastError），其余沿用投影；
  // 用条件展开而不是写 undefined，避免把「没提供」变成「置空」。
  const projectionWithoutTitleFallback =
    input.target === undefined && input.lastError === undefined
      ? persistedGoalProjection
      : {
          ...persistedGoalProjection,
          ...(input.target === undefined ? {} : { target: input.target }),
          ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
        };
  // 老数据的 goal 可能没有 summaryTitle，用 session.title 补齐首轮标题；
  // 补齐需要三个条件同时满足（首条用户消息与 goal 目标一致、时间接近），避免误配标题。
  const projection = withGoalSummaryTitleFallback(
    projectionWithoutTitleFallback,
    input.session,
    input.messages,
  );
  // 消息映射是异步的（图片回填），必须 await 后再组装；
  // 它返回新数组，不修改入参，保证重试快照幂等。
  const messages = await mapSnapshotMessages(input.app, input.messages);
  return {
    messages,
    projection: mapSessionProjection(projection),
    protocol: {
      name: ZCODE_PROTOCOL_NAME,
      version: ZCODE_PROTOCOL_VERSION,
    },
    runtime: mapRuntimeState({
      activeTurn,
      deliveryKind: input.deliveryKind,
      eventSeq: input.eventSeq,
      messages: input.messages,
      persistedContextUsageBreakdownEvents: input.persistedContextUsageBreakdownEvents,
      projection,
      stateRevision: input.stateRevision,
    }),
    session: mapSessionInfo({
      app: input.app,
      fallbackCreatedAt: input.fallbackCreatedAt,
      fallbackUpdatedAt: input.fallbackUpdatedAt,
      projection,
      session: input.session,
      workspace: input.workspace,
    }),
    settings: await mapSessionSettings(input.app, {
      currentModelContextWindow: projection.contextWindow,
      modelAvailability: input.modelAvailability,
    }),
    slashCommands: await listProtocolSlashCommands({
      ...input.slashCommandOptions,
      workingDirectory: input.workspace.workspacePath,
    }),
    goalStats: buildGoalStats(projection, input.messages),
    todos: input.todos?.map(mapTodoItem) ?? [],
    todoGroups: buildTodoGroups(input.messages, input.todos ?? [], projection),
  };
}

// 先批量映射消息，再逐个 part 回填历史文件的可渲染 URL；回填失败保持原 part 不报错。
// 先整体 mapMessageWithParts，再逐个 part 回填 URL；
// 两层 Promise.all 保持消息内 part 顺序不变；
// 任一回填失败都由内层吞掉，不会 reject 整批。
async function mapSnapshotMessages(
  app: Pick<ZCodeApp, "readToolResultArtifact">,
  messages: readonly MessageWithParts[],
) {
  const mapped = messages.map(mapMessageWithParts);
  return await Promise.all(
    mapped.map(async (message) => ({
      ...message,
      parts: await Promise.all(message.parts.map((part) => hydrateSnapshotFilePartUrl(app, part))),
    })),
  );
}

// 只处理「图片 + 尚未是可用 data URL + 是 artifact 引用」三个条件同时成立的 part；
// 非图片附件不回填：协议端不负责把任意文件塞进快照；
// 所有异常统一 catch，返回原 part，保证快照永不因附件失败。
async function hydrateSnapshotFilePartUrl(
  app: Pick<ZCodeApp, "readToolResultArtifact">,
  part: ReturnType<typeof mapMessageWithParts>["parts"][number],
) {
  // 历史图片附件持久化后只剩 zcode-artifact:// 引用，UI/手机端不能直接渲染。
  // snapshot 出协议前在 agent 侧回填 data URL，避免把本地 artifact 目录读法泄漏给前端。
  // 快速路径：非文件、非图片、已是 data URL 的 part 原样返回；
  // 把判断放前面可以避免对历史消息做无谓的 artifact 读取。
  if (part.type !== "file" || !isImageMime(part.mime) || isUsableDataUrl(part.url)) {
    return part;
  }
  const artifactUri = snapshotFilePartArtifactUri(part);
  if (!artifactUri) {
    return part;
  }

  try {
    // 读取的是 agent 侧 artifact，data URL 在 agent 进程内生成；
    // 这样前端/手机端不需要知道 artifact 目录布局，避免泄漏本地路径读法。
    const artifact = await app.readToolResultArtifact(artifactUri);
    const dataUrl = dataUrlFromSnapshotArtifact(artifact.content, artifact.contentType, part.mime);
    // 无法确定具体 MIME（image/*）或超限时放弃回填；
    // 返回原 part 而不是 undefined，让上层仍能显示占位/下载入口。
    if (!dataUrl || Buffer.byteLength(dataUrl, "utf8") > SNAPSHOT_INLINE_IMAGE_DATA_URL_MAX_BYTES) {
      return part;
    }
    return { ...part, url: dataUrl };
  // artifact 丢失是历史数据的常态（清理、迁移），必须按可恢复处理；
  // 这里不记日志以免每次恢复都刷屏，埋点在上层快照耗时里。
  } catch {
    return part;
  }
}

// metadata.artifactUri 优先于 url：part 的 url 可能已被改写成预览地址；
// 只有 zcode-artifact:// 前缀才交给 artifact 读取器，http/data 一律不碰。
function snapshotFilePartArtifactUri(
  part: Extract<ReturnType<typeof mapMessageWithParts>["parts"][number], { type: "file" }>,
): string | undefined {
  const metadataArtifactUri =
    typeof part.metadata?.artifactUri === "string" ? part.metadata.artifactUri : undefined;
  const artifactUri = metadataArtifactUri ?? part.url;
  return artifactUri.startsWith("zcode-artifact://") ? artifactUri : undefined;
}

// 内容已是 usable data URL 时直接复用，避免二次编码；
// MIME 先信 contentType，再退到 part 声明的 fallback；
// 两者都不是具体 image/* 时返回 undefined（image/* 无法构造合法 data URL）。
function dataUrlFromSnapshotArtifact(
  content: string,
  contentType: string,
  fallbackMime: string,
): string | undefined {
  if (isUsableDataUrl(content)) {
    return content;
  }
  const mediaType = concreteImageMime(contentType) ?? concreteImageMime(fallbackMime);
  if (!mediaType) {
    return undefined;
  }
  return `data:${mediaType};base64,${content}`;
}

// 只要顶层类型是 image 就视为图片（含 image/svg+xml）；
// svg 也回填，是因为协议端预览只做内联展示，不执行脚本；
// svg 是否可执行交给客户端沙箱，isImageMime 不做过滤。
function isImageMime(mime: string): boolean {
  return mime === "image/*" || mime.startsWith("image/");
}

// 去掉 charset 等参数并小写归一；
// image/* 通配不是具体类型，必须返回 undefined。
function concreteImageMime(mime: string): string | undefined {
  const normalized = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalized.startsWith("image/") && normalized !== "image/*" ? normalized : undefined;
}

// 已是 data: 且声明了具体 MIME 的 URL 才算可用；
// 空 data:（无 media type）无法被浏览器渲染，仍需走 artifact 回填；
// 只做前缀判断，不解析 base64 内容。
function isUsableDataUrl(value: string): boolean {
  const commaIndex = value.indexOf(",");
  return value.startsWith("data:") && commaIndex >= 0 && value.slice(commaIndex + 1).length > 0;
}

// session 设置视图：模型、思考档位与权限模式。current 档位不在当前可选列表时
// 显式置空，避免 setModel 过渡期把上一个模型的档位当成有效值返回给 UI。
// settings 视图只表达「当前运行态」：模型、思考档位、权限模式；
// 模型市场按 modelAvailability 收窄，避免每次 session/read 都回传完整 catalog；
// 该函数会调用 app 的同步 getter，不产生 IO。
export async function mapSessionSettings(
  app: ZCodeApp,
  options: {
    currentModelContextWindow?: number;
    modelAvailability?: "all" | "current";
  } = {},
): Promise<ZCodeSessionSettingsState> {
  const thoughtLevels = app.listThoughtLevels();
  // setModel 后 runtime 可能短暂保留旧模型的档位；
  // 协议 snapshot 是 UI 与测试的共同事实源，不能返回不在列表里的 current。
  // 因此 mapSessionSettings 显式校验并置空，不原样透传。
  const rawCurrentThoughtLevel = app.getThoughtLevel();
  // setModel 后 runtime 可能短暂保留上一个模型的 thoughtLevel。
  // 协议 snapshot 是 UI/测试共同事实源，不能返回不在当前模型可选列表里的 current。
  const currentThoughtLevel =
    rawCurrentThoughtLevel && thoughtLevels.includes(rawCurrentThoughtLevel)
      ? rawCurrentThoughtLevel
      : undefined;
  const rawDefaultThoughtLevel = app.getDefaultThoughtLevel();
  const defaultThoughtLevel =
    rawDefaultThoughtLevel && thoughtLevels.includes(rawDefaultThoughtLevel)
      ? rawDefaultThoughtLevel
      : undefined;
  const currentModel = app.getModel();
  const currentModelOption = app.getCurrentModelOption?.();
  // modelAvailability=current 时只回传当前模型（含最新 contextWindow），
  // 且必须按 protocol 选择串过滤，保证与 current 同源；
  // all 模式才返回完整列表。
  // contextWindow 优先用调用方给的实时值，缺失才退回模型事实。
  const availableModels =
    options.modelAvailability === "current"
      ? currentModelOption
        ? [
            {
              ...currentModelOption,
              contextWindow:
                positiveInteger(options.currentModelContextWindow) ??
                currentModelOption.contextWindow,
            },
          ]
        : app
            .listModels()
            .filter((candidate) => formatProtocolModelSelection(candidate.ref) === currentModel)
      : app.listModels();
  return {
    mode: {
      current: app.getMode(),
    },
    model: {
      // app/stdio 场景下 provider catalog 属于 app 状态，不应随每次 session/read、
      // setModel 回包返回完整模型市场；session settings 只需要表达当前运行模型即可。
      // available 是「可选模型」而非「市场全量」；
      // 不要在这里补 provider 元数据，v3 旧端不认识新字段会整条拒收。
      available: availableModels,
      // Session 原选择是后续输入解析的依据；字符串和过滤后的档位会丢失原意图。
      // current 允许暂时不可执行，展示/派发的有效性由公共 Selection View 决定。
      // 保留 session 的原始选择串（含未过滤的意图），
      // 展示有效性由公共 Selection View 判断；
      // 用过滤后的 lastUsed 代替会丢失「用户选过但当前不可执行」的信息。
      current: app.runtime.getSessionModelSelection(),
      // lastUsed 是运行模型的结构化投影，可能与 current 意图不同；
      // 两者都写，UI 才能显示「已选择 A，但当前运行 B」。
      lastUsed: optionalModelSelectionFromString(currentModel),
    },
    permission: {
      mode: app.getMode(),
    },
    thoughtLevel: {
      available: thoughtLevels.map((level) => ({ label: level, value: level })),
      current: currentThoughtLevel,
      // 云端 reasoning.defaultLevel 只存在于模型事实中，旧 settings
      // 没有携带默认档位，UI 在 current 为空时只能误选 available[0]。
      // 只有模型事实提供了默认档位才写入；
      // 旧 settings 没带默认值时字段缺席，UI 据此避免误选 available[0]。
      ...(defaultThoughtLevel ? { defaultLevel: defaultThoughtLevel } : {}),
      enabled: thoughtLevels.length > 0,
    },
  };
}

// session 元信息映射：时间戳优先用持久化 session 行，缺失时使用调用方 fallback；
// mode/model/target 以 projection 为准，parentSessionId/traceId 兼取 session 与 app。
// session 元信息映射：时间戳、mode/model/target、父子关系与工作区；
// 函数允许只给 app 没有 session 行（刚创建的协议会话），因此各字段都有回落。
// 任何回落都不能用 draft 的预热值当正式值。
export function mapSessionInfo(input: {
  app?: Pick<ZCodeApp, "getMode" | "getModel" | "sessionId" | "traceId">;
  fallbackCreatedAt?: number;
  fallbackUpdatedAt?: number;
  projection?: SessionProjection;
  session?: SessionInfo | null;
  taskType?: SessionInfo["taskType"];
  parentSessionId?: string;
  workspace: ZCodeWorkspaceRef;
}): ZCodeSessionInfo {
  // 持久化行优先；没有行时退回 app 会话 id；
  // 最后才用 "unknown" 占位，保证协议字段非空但可被识别为异常。
  const sessionId = String(input.session?.id ?? input.app?.sessionId ?? "unknown");
  // 刚创建的 protocol session 可能还没有持久化 session 行。
  // 此时 runtime projection 的时间可能继承 workspace 预热 draft，不能作为正式 session 时间。
  // INV-09：session 行 > 调用方 fallback > projection > now；
  // projection 时间可能继承 workspace 预热 draft，只能排第三；
  // updatedAt 缺失时回落到 createdAt，而不是 now，避免出现 updated < created。
  const createdAt =
    input.session?.time.created ??
    input.fallbackCreatedAt ??
    input.projection?.createdAt.getTime() ??
    Date.now();
  const updatedAt =
    input.session?.time.updated ??
    input.fallbackUpdatedAt ??
    input.projection?.updatedAt.getTime() ??
    createdAt;
  return {
    createdAt,
    mode: input.projection?.mode ?? input.app?.getMode?.() ?? "build",
    model: input.app ? optionalModelSelectionFromString(input.app.getModel()) : undefined,
    parentSessionId: input.session?.parentID ?? input.parentSessionId,
    traceId: input.session?.traceID ?? input.app?.traceId,
    sessionId,
    // session 行是 taskType 的权威来源，调用方参数只补缺；
    // 默认 interactive：未知任务不应被当成后台任务隐藏。
    sessionKind: (input.session?.taskType ?? input.taskType ?? "interactive") as ZCodeSessionKind,
    status: input.projection?.status ?? "idle",
    target: mapSessionGoal(input.projection?.target),
    title: input.session?.title ?? "",
    titleSource: input.session?.titleSource,
    updatedAt,
    workspace: input.workspace,
  };
}

// 内核 SessionEvent → 协议事件。seq 允许被投递序号覆盖，保证订阅端看到单调帧序；
// payload 按事件类型走专门 mapper，未识别类型原样透传。
// 单事件映射：统一补齐 deliveryKind/eventId/sessionId/traceId/turnId/timestamp；
// payload 交给按类型分派的 mapper，未识别类型原样透传；
// seq 可被投递层覆盖，但 payload 不做二次加工。
export function mapSessionEvent(
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
  options: { seq?: number } = {},
): ZCodeSessionEvent {
  return {
    deliveryKind,
    eventId: String(event.id),
    payload: mapSessionEventPayload(event),
    // 投递序号优先：订阅首发帧需要与客户端看到的顺序一致；
    // 落库的 sequenceNumber 只在没有投递上下文时使用。
    seq: options.seq ?? event.sequenceNumber,
    sessionId: String(event.sessionId),
    timestamp: event.timestamp.getTime(),
    traceId: String(event.traceId),
    turnId: event.turnId ? String(event.turnId) : undefined,
    type: mapSessionEventType(event.type),
  };
}

// 协议出口先过透出白名单，纯内部账本事件返回 null 由批量层丢弃。
// 协议出口的单一闸门：先过透出白名单，再映射；
// 返回 null 由批量层丢弃，调用方不要自行再判一次类型。
export function mapSessionEventForProtocol(
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
  options: { seq?: number } = {},
): ZCodeSessionEvent | null {
  if (!shouldExposeSessionEventToProtocol(event)) {
    return null;
  }
  return mapSessionEvent(event, deliveryKind, options);
}

// 批量映射并过滤 null，供 subscribe 首发帧与事件读取共用。
// 批量映射保持输入顺序并过滤掉不透出的事件（null 由调用方丢弃）。
export function mapSessionEvents(
  events: readonly SessionEvent[],
  deliveryKind?: ZCodeDeliveryKind,
): ZCodeSessionEvent[] {
  return events
    .map((event) => mapSessionEventForProtocol(event, deliveryKind))
    .filter((event): event is ZCodeSessionEvent => event !== null);
}

// 这是带宽与兼容性的唯一决策点；
// 在此新增过滤必须确认旧端不依赖该事件，否则会表现为「某些面板永远不刷新」。
export function shouldExposeSessionEventToProtocol(event: SessionEvent): boolean {
  // INV-13：该事件是 runtime replay 账本，四个阶段会重复携带完整工具入参；
  // UI 已有 model.streaming/tool.updated 生命周期，继续透出只会放大流量；
  // mapper 也不消费它的内部状态。
  if (event.type === SessionEventType.StreamingToolLedgerUpdated) {
    // 性能修复：StreamingToolLedgerUpdated 是 runtime replay 账本，常在 closed/queued/started/committed
    // 阶段携带同一份完整 tool input。UI 协议流已有 model.streaming/tool.updated 生命周期，
    // 继续透出会造成大参数反复全量跨进程传输，且 mapper 最终也不会消费这些内部状态。
    return false;
  }

  // workflow run 进度对 v3 同构，v4 面已有 workflowRuns 权威投影；
  // 剥离不是防丢事件（新类型会被 default 收成 session.updated），纯为带宽与语义干净；
  // 不要在这里改成「有条件透出」，否则每个节点相位都会跨进程搬一次。
  if (event.type === SessionEventType.DynamicWorkflowRunProgress) {
    // 与上面同一个 seam、同一个理由：workflow run 事件对 v3 完全同构——v4 面已有权威投影
    // （workflowRuns 状态键），v3 mapper 不消费这些内部状态，继续透出只是把每个节点相位
    // 迁移都跨进程搬一遍。**注意与前置特性的偏斜危害不同**：这里的剥离不是为了防丢事件，
    // 新类型不会被 v3 拒收（mapSessionEventType 的 default 落到 session.updated，其 payload
    // 是宽松的 jsonObjectSchema），纯粹是带宽与语义干净。
    return false;
  }

  // 除 ModelStreaming 外一律透出，只有流式事件继续看 kind。
  // 后续判断只针对 model.streaming 的细分 kind。
  if (event.type !== SessionEventType.ModelStreaming) {
    return true;
  }

  const payload = asRecord(event.payload);
  const kind = stringValue(payload.kind);
  const delta = stringValue(payload.delta);
  // UI 已支持工具参数预览后，tool_input_* 不能再在协议边界丢弃；
  // 否则 Write/Edit 会在模型思考阶段完全不可见。小包压力由 runtime 合并 delta 控制。
  // INV-14：空 delta 丢弃，避免大量零长度帧；
  // tool_input_* 不在此分支，必须继续透出，否则 Write/Edit 在思考阶段不可见。
  if (kind === "text_delta" || kind === "reasoning_delta") {
    return Boolean(delta);
  }
  return (
    kind === "tool_input_start" ||
    kind === "tool_input_delta" ||
    kind === "tool_input_end" ||
    kind === "tool_call"
  );
}

// 按事件类型给 payload 补 kind 或做字段收敛，未识别类型原样返回；
// kind 是旧端 reducer 的分派依据，缺失会被当成未知工具状态。
// 新增类型若不改映射，会以原 payload 进入 session.updated。
function mapSessionEventPayload(event: SessionEvent): unknown {
  const payload = event.payload;
  switch (event.type) {
    case SessionEventType.ModelRequest:
      return mapModelRequestPayload(payload);
    case SessionEventType.ModelNetworkStatus:
      return mapModelNetworkStatusPayload(payload);
    case SessionEventType.StreamRecoveryAnchorCreated:
    case SessionEventType.StreamRecoveryStarted:
    case SessionEventType.StreamRecoveryAnchorSelected:
    case SessionEventType.StreamRecoveryRetryStarted:
    case SessionEventType.StreamRecoveryTailDiscarded:
    case SessionEventType.StreamRecoveryBlocked:
      return mapStreamRecoveryPayload(payload);
    case SessionEventType.ToolCallScheduled:
      return { ...(payload as Record<string, unknown>), kind: "scheduled" };
    case SessionEventType.ToolCallStarted:
      // started 事件需要时间兜底，因此单独传事件时间戳；
      // 其他工具事件只补 kind，不需要时间。
      return mapToolCallStartedPayload(payload, event.timestamp);
    case SessionEventType.ToolCallProgress:
      return { ...(payload as Record<string, unknown>), kind: "progress" };
    case SessionEventType.ToolCallResult:
      return { ...(payload as Record<string, unknown>), kind: "result" };
    case SessionEventType.ToolCallError:
      return { ...(payload as Record<string, unknown>), kind: "error" };
    case SessionEventType.ToolBatchComplete:
      return { ...(payload as Record<string, unknown>), kind: "batch" };
    case SessionEventType.PermissionRequested:
      return mapPermissionRequestedPayload(payload);
    case SessionEventType.PermissionDenied:
      return mapPermissionDeniedPayload(payload);
    default:
      return payload;
  }
}

// PermissionDenied 复用 permission.resolved 协议事件；
// 必须显式写 decision=deny，下游才会把已出现的工具卡收口成失败态。
// 缺这个字段会表现为「拒绝后卡片一直转圈」。
function mapPermissionDeniedPayload(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  return {
    ...record,
    // PermissionDenied 复用 permission.resolved 协议事件。
    // 下游投影依赖 decision=deny 才会把已出现的工具卡收口成失败态。
    decision: "deny",
  };
}

function mapToolCallStartedPayload(
  payload: unknown,
  eventTimestamp: Date,
): Record<string, unknown> {
  const record = asRecord(payload);
  return {
    ...record,
    // ToolCallStarted 的 startedAt 来自 runtime Date 对象；协议跨进程后必须是
    // 稳定 JSON 值，否则接收侧 strict schema 会把 started 事件当成无效消息丢弃。
    // INV-02：runtime 的 startedAt 是 Date 对象，跨进程后必须变成 JSON 值；
    // 否则接收端 strict schema 会把 started 事件当无效消息丢掉；
    // 无法转换时用事件时间兜底，保证字段始终存在。
    startedAt: protocolInstantValue(record.startedAt) ?? eventTimestamp.getTime(),
    kind: "started",
  };
}

// 接受 Date / 有限数字 / 非空字符串三种形态；
// 无效 Date（NaN）与空串都返回 undefined，交给调用方兜底。
function protocolInstantValue(value: unknown): number | string | undefined {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return undefined;
}

// 只输出计数与采样参数，不输出 messages 全量上下文；
// eventStore 淘汰 sealed turn 时 messages 会被瘦身为 messageCount，两种形态必须归一；
// 这是「工具轮次越多单包越大」的修复点，mapModelRequestPayload 只留计数。
function mapModelRequestPayload(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  // 内存 event store 淘汰 sealed turn 时把 messages 瘦身为 messageCount（session-event-store-retention.md），
  // 两种形态都要映射出同一个 messageCount。
  // 数字优先，其次数组长度，最后 0；
  // 不要把「没有 messages 字段」当成 1，UI 会显示错误的上下文规模。
  const messageCount =
    typeof record.messageCount === "number"
      ? record.messageCount
      : Array.isArray(record.messages)
        ? record.messages.length
        : 0;
  const result: Record<string, unknown> = {
    messageCount,
  };
  // 白名单拷贝：只允许这些已存在的 v3 字段；
  // 新增字段必须同时更新 shared schema，否则会被旧端拒收。
  for (const key of [
    "providerId",
    "modelId",
    "temperature",
    "maxTokens",
    "toolCount",
    "iteration",
  ]) {
    if (record[key] !== undefined) {
      result[key] = record[key];
    }
  }
  // model_request 的 messages 是发给模型的完整上下文，只用于 core 内部追踪。
  // 之前映射成 session.updated 后会把全量上下文反复推给桌面，工具轮次越多单包越大。
  return result;
}

// 网络重试是运行态而非消息内容，挂在 _meta.zcode.apiRetry 下；
// app 读取该私有 meta 写入 host runtime snapshot，旧 task 投影据此显示重试；
// 无法解析时原样返回，不制造空 meta。
function mapModelNetworkStatusPayload(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  const apiRetry = zcodeApiRetryFromModelNetworkStatusPayload(record);
  if (apiRetry === undefined) {
    return record;
  }
  const meta = asRecord(record._meta);
  const zcodeMeta = asRecord(meta.zcode);
  return {
    ...record,
    _meta: {
      ...meta,
      zcode: {
        ...zcodeMeta,
        // 网络重试是模型请求运行态，不属于可持久化消息内容。
        // 这里通过 app 私有 meta 暴露给旧 task 投影，app 再写入 host runtime snapshot。
        apiRetry,
      },
    },
  };
}

// 断流恢复的进度必须挂在 streamRecovery.updated 本身；
// 只在后续 model_request_started 补 meta 会让错过该事件的 UI 永远看不到重试次数。
function mapStreamRecoveryPayload(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  const apiRetry = zcodeApiRetryFromStreamRecoveryPayload(record);
  if (apiRetry === undefined) {
    return record;
  }
  const meta = asRecord(record._meta);
  const zcodeMeta = asRecord(meta.zcode);
  return {
    ...record,
    _meta: {
      ...meta,
      zcode: {
        ...zcodeMeta,
        // streamRecovery.updated 才是 SSE 断流恢复的核心进度事件。
        // 之前只在后续 model_request_started 上补 meta，UI 错过该事件时不会显示重试次数。
        apiRetry,
      },
    },
  };
}

// runtime projection → 协议投影视图；activeToolCalls/backgroundJobs/pendingPermissions
// 等集合逐项走子 mapper，保证跨进程字段都是稳定 JSON 值。
// projection 映射逐项走子 mapper，保证集合元素也是稳定 JSON；
// contextUsed/contextWindow 原样透传：口径由 runtime 决定，不在协议层重算。
export function mapSessionProjection(projection: SessionProjection): ZCodeSessionProjection {
  return {
    activeToolCalls: projection.activeToolCalls.map(mapActiveToolCall),
    backgroundJobs: projection.backgroundTasks.map(mapBackgroundTask),
    contextUsed: projection.contextUsed,
    contextWindow: projection.contextWindow,
    currentTurnId: projection.currentTurnId ? String(projection.currentTurnId) : undefined,
    lastError: projection.lastError,
    mode: projection.mode,
    pendingPermissions: projection.pendingPermissions.map(mapPendingPermission),
    sessionId: String(projection.id),
    status: projection.status,
    target: mapSessionGoal(projection.target),
    totalTokenCount: projection.totalTokenCount,
    turnCount: projection.turnCount,
  };
}

// 运行态字段以 runtime 实时状态与 projection 的 verifier 时间线为准；
// deliveryKind/eventSeq/stateRevision 由调用方注入，用于订阅帧去重与续传。
// runtime 字段以实时 activeTurn 与 projection 的 verifier 时间线为准；
// deliveryKind/eventSeq/stateRevision 由调用方注入，用于订阅去重与续传；
// 不要在快照里发明 runtime 没有的状态。
function mapRuntimeState(input: {
  activeTurn?: ReturnType<ZCodeApp["runtime"]["getActiveTurnInfo"]>;
  deliveryKind?: ZCodeDeliveryKind;
  eventSeq: number;
  messages: MessageWithParts[];
  persistedContextUsageBreakdownEvents?: readonly SessionEvent[];
  projection: SessionProjection;
  stateRevision: number;
}): ZCodeSessionRuntimeState {
  // projection.currentTurnId 是投影最后处理过的 turn，不代表当前仍在运行。
  // session 恢复/subscribe 快照如果把它回填成 runtime.activeTurnId，会让已 idle/complete 的任务误显示为 thinking。
  // INV：projection.currentTurnId 只表示「最后处理过的 turn」，不代表仍在运行；
  // 把它回填成 activeTurnId 会让 idle/complete 的任务显示成 thinking；
  // 因此只能取 runtime.getActiveTurnInfo 的实时值。
  const activeTurnId = input.activeTurn?.turnId;
  // context usage 同时依赖历史消息、持久化 breakdown 事件与 projection；
  // 三者缺一都会退化为部分信息，函数内部按对齐规则取舍。
  const contextUsage = resolveSessionContextUsage({
    messages: input.messages,
    persistedContextUsageBreakdownEvents: input.persistedContextUsageBreakdownEvents,
    projection: input.projection,
  });
  // 共享 runtime schema 已用 activeTurnId/activeTurnKind 表达运行中 turn；
  // mainActive 是旧 UI 派生字段，继续从 CLI 快照写出会让 bootstrap 独立 build 失败。
  return {
    activeTurnId: activeTurnId ? String(activeTurnId) : undefined,
    activeTurnKind: input.activeTurn?.kind,
    deliveryKind: input.deliveryKind,
    eventSeq: input.eventSeq,
    // 旧 UI 只认 requestId 列表；requestId 缺失时用 toolCallId 兜底，保证非空；
    // 顺序与 pendingPermissions 一致，不做排序。
    pendingRequestIds: input.projection.pendingPermissions.map(
      (permission) => permission.requestId ?? permission.toolCallId,
    ),
    ...(contextUsage ? { contextUsage } : {}),
    goalVerifications: mapGoalVerifications(input.projection.targetCompletionVerifications),
    goalVerificationTimeline: mapGoalVerificationTimeline(
      input.projection.targetCompletionVerificationTimeline,
    ),
    stateRevision: input.stateRevision,
  };
}

interface ContextUsageBreakdownCandidate {
  breakdown: ZCodeContextUsageBreakdownItem[];
  contextWindow?: number;
  used: number;
}

/**
 * legacy snapshot 与 V4 usage 窄种子的共享计算口径。
 *
 * V4 冷恢复只需要 context usage，过去却通过 full legacy snapshot 间接读取。
 * 抽出纯投影后，两条路径继续共享 active-branch token/cache 与 breakdown 对齐规则。
 */
// legacy 快照与 V4 窄种子的共享口径；
// 优先使用 projection（运行期权威），只有当 persisted 的 used 与 projection.contextUsed 完全一致时，
// 才把 persisted 的 cache 挂上去，避免把旧分支缓存算到当前水位。
export function resolveSessionContextUsage(input: {
  messages: readonly MessageWithParts[];
  persistedContextUsageBreakdownEvents?: readonly SessionEvent[];
  projection: SessionProjection;
}): ZCodeSessionContextUsage | undefined {
  const persistedContextUsage = contextUsageFromPersistedMessages(
    input.messages,
    input.projection.contextWindow,
  );
  // 投影结果优先，缺失才退回持久化消息推导；
  // breakdown 只在 used/window 对齐时应用；
  // 返回值 undefined 表示「没有可信 usage」，调用方不应补 0。
  return applyContextUsageBreakdown(
    contextUsageFromProjection(
      input.projection,
      persistedContextUsage?.used === input.projection.contextUsed
        ? persistedContextUsage.cache
        : undefined,
    ) ?? persistedContextUsage,
    latestContextUsageBreakdownFromEvents(input.persistedContextUsageBreakdownEvents ?? []),
  );
}

// 四项 gate 缺一不可：有 usage、有 candidate、candidate 非空、usage 自身没有 breakdown；
// used 或 window 不一致说明 candidate 属于其他分支/请求，必须放弃；
// 对齐后才合并，且不覆盖已有 breakdown。
function applyContextUsageBreakdown(
  contextUsage: ZCodeSessionContextUsage | undefined,
  candidate: ContextUsageBreakdownCandidate | undefined,
): ZCodeSessionContextUsage | undefined {
  if (!contextUsage || !candidate || candidate.breakdown.length === 0) {
    return contextUsage;
  }
  if (contextUsage.breakdown && contextUsage.breakdown.length > 0) {
    return contextUsage;
  }
  if (candidate.used !== contextUsage.used) {
    return contextUsage;
  }
  if (candidate.contextWindow !== undefined && candidate.contextWindow !== contextUsage.size) {
    return contextUsage;
  }
  return {
    ...contextUsage,
    breakdown: candidate.breakdown,
  };
}

// 从后往前找最近一条可用的 ModelComplete 事件；
// 只接受 main_turn（或未标注）的 querySource，排除 sidecar 模型请求；
// 解析失败、空 breakdown、缺 used 都跳过，继续向前找。
function latestContextUsageBreakdownFromEvents(
  events: readonly SessionEvent[],
): ContextUsageBreakdownCandidate | undefined {
  // 倒序扫描是「最近一次优先」的直接实现；
  // 不要先 sort 再 pop，事件列表可能很大且已按时间有序。
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== SessionEventType.ModelComplete) {
      continue;
    }
    const payload = event.payload as Partial<ModelCompletePayload>;
    // undefined 视为 main_turn（兼容旧事件）；
    // 其他值（如 sidecar）说明是小模型请求，其 token 不能挂到主任务 meter。
    const querySource = stringValue(payload.querySource);
    if (querySource !== undefined && querySource !== "main_turn") {
      continue;
    }
    const parsed = zcodeContextUsageBreakdownSchema.safeParse(payload.contextUsageBreakdown);
    const used = getModelUsageContextTokens(payload.usage);
    if (!parsed.success || parsed.data.length === 0 || used === undefined) {
      continue;
    }
    const contextWindow = positiveInteger(payload.contextWindow);
    // 冷恢复只能从 eventStore 重建 context breakdown；必须用 usage/window 对齐，
    // 避免把旧分支或 sidecar 模型请求的来源比例挂到当前 task meter 上。
    return {
      breakdown: parsed.data,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      used,
    };
  }
  return undefined;
}

// verifier 摘要只保留协议需要的三项；
// nextAction 缺失显式写 null，schema 要求可空而非缺席。
function mapGoalVerifications(
  verifications: SessionProjection["targetCompletionVerifications"] | undefined,
): ZCodeSessionGoalVerification[] {
  return (verifications ?? []).map((verification) => ({
    nextAction: verification.nextAction ?? null,
    passed: verification.passed,
    reason: verification.reason,
  }));
}

// 把内部 timeline 项展开为 v3 的 synthetic message 形态；
// version/kind/type/display 是旧端渲染分隔线的固定约定，不能改；
// 可选字段全部条件展开，避免 undefined 进入 JSON。
function mapGoalVerificationTimeline(
  timeline: SessionProjection["targetCompletionVerificationTimeline"] | undefined,
): ZCodeSessionGoalVerificationTimeline[] {
  return (timeline ?? []).map((item) => ({
    version: 1,
    kind: "synthetic",
    type: "goal_verification",
    display: "separator",
    targetId: item.targetId,
    verificationId: item.verificationId,
    status: item.status,
    ...(item.goalIteration ? { goalIteration: item.goalIteration } : {}),
    ...(item.anchorAssistantMessageId
      ? { anchorAssistantMessageId: item.anchorAssistantMessageId }
      : {}),
    ...(item.anchorTurnId ? { anchorTurnId: item.anchorTurnId } : {}),
    ...(item.verification
      ? {
          verification: {
            nextAction: item.verification.nextAction ?? null,
            passed: item.verification.passed,
            reason: item.verification.reason,
          },
        }
      : {}),
    ...(item.startedAt ? { startedAt: item.startedAt.getTime() } : {}),
    updatedAt: item.updatedAt.getTime(),
  }));
}

// used 或 window 非正时返回 undefined：0 不是有效水位；
// cache 只由调用方在对齐通过后传入。
function contextUsageFromProjection(
  projection: SessionProjection,
  cache: ZCodeSessionContextUsage["cache"] | undefined,
): ZCodeSessionContextUsage | undefined {
  if (projection.contextUsed <= 0 || projection.contextWindow <= 0) {
    return undefined;
  }
  return {
    ...(cache ? { cache } : {}),
    cost: null,
    size: projection.contextWindow,
    used: projection.contextUsed,
  };
}

// 冷恢复的主路径：从历史消息重建水位；
// 先算缓存汇总，再从后往前找最新有效 assistant 消息；
// 压缩成功后必须优先使用 compactBoundary，而不是继续向前扫。
function contextUsageFromPersistedMessages(
  messages: readonly MessageWithParts[],
  contextWindow: number,
): ZCodeSessionContextUsage | undefined {
  if (contextWindow <= 0) {
    return undefined;
  }
  const cache = contextCacheUsageFromMessages(messages);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    // INV-16：成功 compact 的 usage 落在 user summary 的 boundary 上；
    // 只扫 assistant 会越过它并恢复出压缩前水位；
    // truePostCompactTokenCount 优先于 postCompactTokenCount（后者可能含估算偏差）。
    if (message.info.role === "user" && message.info.summary) {
      const compactPart = message.parts.find(
        (part) => part.type === "compaction" && part.compactBoundary,
      );
      if (compactPart?.type === "compaction" && compactPart.compactBoundary) {
        const used = positiveInteger(
          compactPart.compactBoundary.truePostCompactTokenCount ??
            compactPart.compactBoundary.postCompactTokenCount,
        );
        // 成功 compact 的 usage 持久化在 user summary 的 boundary；
        // 只扫描 assistant 会越过它并恢复压缩前水位。旧 assistant boundary 和
        // 不完整历史仍走原有 fallback，且不能把压缩前 cache 重新挂到压缩后水位。
        if (used !== undefined) {
          return {
            cost: null,
            size: contextWindow,
            used,
          };
        }
      }
    }
    // assistant summary 是压缩产物，不是一次真实请求，不能作为水位来源；
    // assistant summary 是压缩产物，contextUsageFromPersistedMessages 跳过它继续向前。
    if (message.info.role !== "assistant" || message.info.summary) {
      continue;
    }
    const used = contextUsedFromTokens(message.info.tokens);
    if (used === undefined) {
      continue;
    }
    // protocol eventStore 是运行期内存账本，重启 resume 后 projection.contextUsed 会回到 0。
    // context window 消耗是 input + output；恢复时优先用 provider total，否则用持久化的 input/output 还原 meter。
    return {
      ...(cache ? { cache } : {}),
      cost: null,
      size: contextWindow,
      used,
    };
  }
  return undefined;
}

// 优先 provider total；缺失时用 input + output 还原；
// reasoning 与 cache 不计入「上下文窗口消耗」，口径与 runtime 保持一致。
// input 缺失即返回 undefined，不做 0 兜底。
function contextUsedFromTokens(
  tokens:
    | {
        total?: number;
        input: number;
        output?: number;
      }
    | undefined,
): number | undefined {
  if (!tokens) {
    return undefined;
  }

  const total = positiveInteger(tokens.total);
  if (total !== undefined) {
    return total;
  }

  const input = positiveInteger(tokens.input);
  if (input === undefined) {
    return undefined;
  }

  return input + (nonNegativeInteger(tokens.output) ?? 0);
}

// contextCacheUsageFromMessages 按请求累加，同时保留最后一次命中数据。
// 零 token 的 assistant 消息不计入 requestCount；
// latestHitRate 以最后一次为分母，hitRate 以全量为分母，两者不可互换。
function contextCacheUsageFromMessages(
  messages: readonly MessageWithParts[],
): ZCodeSessionContextUsage["cache"] | undefined {
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let requestCount = 0;
  let latestInputTokens = 0;
  let latestCacheReadTokens = 0;
  let latestCacheWriteTokens = 0;

  for (const message of messages) {
    if (message.info.role !== "assistant" || message.info.summary) {
      continue;
    }
    const input = nonNegativeInteger(message.info.tokens.input) ?? 0;
    const read = nonNegativeInteger(message.info.tokens.cache.read) ?? 0;
    const write = nonNegativeInteger(message.info.tokens.cache.write) ?? 0;
    if (input <= 0 && read <= 0 && write <= 0) {
      continue;
    }
    requestCount += 1;
    inputTokens += input;
    cacheReadTokens += read;
    cacheWriteTokens += write;
    latestInputTokens = input;
    latestCacheReadTokens = read;
    latestCacheWriteTokens = write;
  }

  if (requestCount <= 0) {
    return undefined;
  }
  return {
    inputTokens: latestInputTokens,
    cacheReadTokens: latestCacheReadTokens,
    cacheWriteTokens: latestCacheWriteTokens,
    latestHitRate: latestInputTokens > 0 ? latestCacheReadTokens / latestInputTokens : null,
    hitRate: inputTokens > 0 ? cacheReadTokens / inputTokens : null,
    hitRateRequestCount: requestCount,
    totalInputTokens: inputTokens,
    totalCacheReadTokens: cacheReadTokens,
    totalCacheWriteTokens: cacheWriteTokens,
  };
}

// INV-03/04 的核心落点：display 与 optionsPolicy 刻意不进入 v3 输出；
// 旧桌面用 strict schema 解析整份快照，多一个字段就会让 permission.requested 被静默丢弃，
// 确认窗直接消失——这是 gate 降级，绝不能发生。
// optionsPolicy 仍然生效：它在源头裁剪 allow_always，只让裁剪后的 options 过协议。
function mapPendingPermission(
  permission: PendingPermission,
): ZCodePendingPermission {
  // display / optionsPolicy 刻意不进 legacy v3 输出。
  // 根因不是"扩 schema 只能单向兼容"，而是 strict schema 随 packages/shared 打进每个桌面端
  // 的产物：今天把 zcodePendingPermissionSchema（shared/src/zcode-protocol/index.ts:1139）和
  // zcodePermissionRequestedEventPayloadSchema（同文件:1536）改成可选，也保护不了已经装出去
  // 的旧桌面。新 CLI 一旦在 v3 路径上带这两个字段，旧桌面会整份快照解析失败、并用 safeParse
  // 静默丢弃整个 permission.requested 事件——确认窗本身就没了，这违反"只允许预览降级、
  // 不允许 gate 降级"。剥离在源头是唯一对版本偏斜安全的做法；legacy 也没有画因果图的界面。
  // optionsPolicy 的效果仍然生效：它作为 buildProtocolPermissionOptions 的输入裁掉
  // allow_always，只有裁剪后的 options 列表过协议。会话免确认同样降级为裁剪：
  // 旧桌面回传的是 response 原文，认不出会话语义（见 toLegacyPermissionOptionsPolicy）。
  return {
    input: permission.input,
    ...(permission.origin ? { origin: permission.origin } : {}),
    // 会话语义（session-level 免确认）在旧端无法表达，因此降级为「裁剪选项」；
    // 旧端回传的 response 原文由 toLegacyPermissionOptionsPolicy 映射，
    // 不能把新语义直接塞进 options 数组。
    options: buildProtocolPermissionOptions({
      ...permission,
      optionsPolicy: toLegacyPermissionOptionsPolicy(permission.optionsPolicy),
    }),
    reason: permission.reason ?? "",
    requestId: permission.requestId ?? permission.toolCallId,
    requestedAt: permission.requestedAt.getTime(),
    riskLevel: permission.riskLevel,
    toolCallId: permission.toolCallId,
    toolName: permission.toolName,
  };
}

// 该 payload 是整体 spread，新字段必须在解构里显式剔除；
// 否则新 CLI 会把 display/optionsPolicy 漏进 strict schema，旧桌面整条事件解析失败；
// 与 mapPendingPermission 同一策略、同一理由。
function mapPermissionRequestedPayload(
  payload: unknown,
): Record<string, unknown> {
  // 同 mapPendingPermission：这个 payload 是整体 spread 出去的，新字段必须在这里显式解构
  // 剔除，否则会直接漏进 strict 的 zcodePermissionRequestedEventPayloadSchema。
  // 解构即白名单：未列出的新字段仍会进入 record，因此新增字段时必须同步在这里剔除；
  // 变量名前缀下划线表示有意丢弃，不是未使用告警。
  const { display: _display, optionsPolicy, ...record } = asRecord(payload);
  const toolName = stringValue(record.toolName) ?? "unknown";
  return {
    ...record,
    options: buildProtocolPermissionOptions({
      approvalMode: record.approvalMode === "user-once" ? "user-once" : undefined,
      input: record.input,
      suggestedPermissionUpdates: Array.isArray(record.suggestedPermissionUpdates)
        ? (record.suggestedPermissionUpdates as PendingPermission["suggestedPermissionUpdates"])
        : undefined,
      optionsPolicy: toLegacyPermissionOptionsPolicy(optionsPolicy),
      toolName,
    }),
  };
}

// 只透出 UI 需要的四项；Date 必须转毫秒，缺失保持 undefined。
function mapActiveToolCall(toolCall: ActiveToolCall): ZCodeActiveToolCall {
  return {
    startedAt: toolCall.startedAt?.getTime(),
    status: toolCall.status,
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
  };
}

// 后台任务结构由 contracts 定义且已 JSON 安全，浅拷贝隔离引用即可。
function mapBackgroundTask(task: BackgroundTaskInfo): Record<string, unknown> {
  return { ...task };
}

// 非对象（含数组与 null）统一归一为空对象，避免调用处到处判空；
// asRecord 只做类型收窄，不复制深层结构。
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

// 只接受非空字符串；数字等标量不隐式转换，避免把 0 变成 "0" 这类伪值；
// stringValue 只过类型，空串由调用处的 ?? 与真值判断兜底。
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// 只接受安全范围内的非负整数；小数直接拒绝，不做四舍五入；
// 用于 token/时长等计数类字段，防止 NaN 进入快照。
function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

// 只接受大于 0 的整数；
// 用于窗口/上限这类「0 无意义」的字段，0 返回 undefined 交给上层缺省。
function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

// 运行期 eventStore 不保留完成态 verifier 事件，冷恢复必须把持久化事件重放一遍
// 才能重建 timeline；重放按目标 id 过滤并与摘要合并去重，避免同一验证出现两次。
// 冷恢复专用：把持久化 verifier 事件重放进一个最小 projection；
// 只保留 TargetCompletionVerification 类型，按 targetId 过滤后按时间/序号稳定排序；
// 重放结果的 timeline 再排序，并与原摘要合并去重。
function mergePersistedGoalVerificationEvents(
  projection: SessionProjection,
  events: readonly SessionEvent[],
  target?: SessionGoal | null,
): SessionProjection {
  if (events.length === 0) {
    return projection;
  }

  const baseProjection = {
    ...projection,
    targetCompletionVerifications: projection.targetCompletionVerifications ?? [],
    targetCompletionVerificationTimeline: projection.targetCompletionVerificationTimeline ?? [],
  };
  const targetId = target?.targetID ?? projection.target?.targetID;
  // 复用 runtime 的 reducer 而不是自写状态机，保证同一事件在恢复与实时路径结果一致；
  // baseProjection 已把两个集合初始化为空数组，避免 reducer 处理 undefined。
  const reducer = new EventReducer();
  const restored = [...events]
    .filter((event) => event.type === SessionEventType.TargetCompletionVerification)
    .filter((event) => {
      const payload = asRecord(event.payload);
      const eventTargetId = stringValue(payload.targetId);
      return !targetId || !eventTargetId || eventTargetId === targetId;
    })
    .sort(compareEventsByTimelineTime)
    .reduce((current, event) => reducer.apply(current, event), baseProjection);
  const timeline = getTargetGoalVerificationTimeline(restored, target).sort(
    compareGoalVerificationTimeline,
  );
  return {
    ...restored,
    targetCompletionVerificationTimeline: timeline,
    targetCompletionVerifications: mergeGoalVerificationSummaries(
      restored.targetCompletionVerifications,
      timeline,
    ),
  };
}

// 先比时间再比 sequenceNumber；
// 同一毫秒内的事件顺序必须由序号决定，否则重放结果不稳定。
function compareEventsByTimelineTime(left: SessionEvent, right: SessionEvent): number {
  const byTime = left.timestamp.getTime() - right.timestamp.getTime();
  if (byTime !== 0) return byTime;
  return left.sequenceNumber - right.sequenceNumber;
}

// 摘要与 timeline 里可能各有一份同一验证，按 key 去重；
// 顺序保持「先摘要后 timeline」，UI 已有依赖。
function mergeGoalVerificationSummaries(
  verifications: readonly GoalCompletionVerificationOutput[],
  timeline: readonly SessionProjection["targetCompletionVerificationTimeline"][number][],
): GoalCompletionVerificationOutput[] {
  const result: GoalCompletionVerificationOutput[] = [];
  const seen = new Set<string>();
  for (const verification of [
    ...verifications,
    ...timeline
      .map((item) => item.verification)
      .filter((item): item is GoalCompletionVerificationOutput => item !== undefined),
  ]) {
    const key = goalVerificationSummaryKey(verification);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(verification);
  }
  return result;
}

// key 只由语义字段组成：(passed, reason, nextAction)；
// 用 \u0000 分隔避免文本中包含分隔符导致碰撞；
// 时间不参与 key：同一次验证的重放必须被视为同一条。
function goalVerificationSummaryKey(verification: GoalCompletionVerificationOutput): string {
  return [
    verification.passed ? "1" : "0",
    normalizeTodoContent(verification.reason),
    normalizeTodoContent(verification.nextAction ?? ""),
  ].join("\u0000");
}

// 只补「有 target、缺 summaryTitle、有 session.title」的旧数据；
// 用首条用户消息与 goal objective 做归一化比较，并用 5s 时间窗确认同源；
// 不满足任意一条都原样返回，宁可缺标题也不能张冠李戴。
function withGoalSummaryTitleFallback(
  projection: SessionProjection,
  session: SessionInfo | null | undefined,
  messages: readonly MessageWithParts[],
): SessionProjection {
  const target = projection.target;
  if (!target || target.summaryTitle || !session?.title) {
    return projection;
  }
  const firstUserMessage = messages
    .filter((message) => message.info.role === "user")
    .sort(compareMessagesByCreatedTime)[0];
  if (
    !firstUserMessage ||
    // 5s 是「同一次创建」的容差；
    // goal 可能由首条消息触发，但两者写入时间不会完全相等；
    // 放宽会把后续用户消息误认成 goal 目标。
    Math.abs(firstUserMessage.info.time.created - target.time.created) > 5_000
  ) {
    return projection;
  }
  if (normalizeText(readMessageText(firstUserMessage)) !== normalizeText(target.objective)) {
    return projection;
  }
  return {
    ...projection,
    target: {
      ...target,
      // 首条用户请求就是 goal 时，session 标题才是第一轮标题的持久来源；
      // 老数据可能没有写 target.summaryTitle，恢复后需要用 session.title 补齐首轮标题。
      summaryTitle: session.title,
    },
  };
}

// 拼接该消息所有 text part，用于 goal 标题同源判定；
// 忽略 reasoning/tool part：它们不能代表用户意图。
function readMessageText(message: MessageWithParts): string {
  return message.parts
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

// trim + 折叠空白 + 小写，仅用于「是否同一段文本」的比较；
// 不要把它用于展示或存储，会丢失用户原始格式。
function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

// undefined 与 null 语义不同：前者表示「调用方未提供」，后者表示「确实没有 goal」；
// 数值字段用 0/null 补齐，保证 schema 稳定；sessionId 统一字符串化。
function mapSessionGoal(goal: SessionGoal | null | undefined): ZCodeSessionGoal | null | undefined {
  if (goal === undefined) return undefined;
  if (goal === null) return null;
  return {
    createdAt: goal.time.created,
    objective: goal.objective,
    sessionId: String(goal.sessionID),
    status: goal.status,
    summaryTitle: goal.summaryTitle,
    targetId: goal.targetID,
    timeUsedSeconds: goal.timeUsedSeconds ?? 0,
    tokenBudget: goal.tokenBudget ?? null,
    tokensUsed: goal.tokensUsed ?? 0,
    activeInputId: goal.activeInputId ?? null,
    activeRunStartedAtMs: goal.activeRunStartedAtMs ?? null,
    activeRunLastSeenAtMs: goal.activeRunLastSeenAtMs ?? null,
    updatedAt: goal.time.updated,
  };
}

// 去掉内部字段，只保留 content/status/priority；
// capability 等运行期标记不进入历史重建结果。
function mapTodoItem(todo: TodoItem): TodoItem {
  return {
    content: todo.content,
    priority: todo.priority,
    status: todo.status,
  };
}

interface GoalIterationBucket {
  goalIteration: number;
  id: string;
  messageIds: Set<string>;
  startedAt?: number;
  targetId?: string;
  toolCallCount: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  updatedAt?: number;
}

// goal 统计优先信 DB 侧累计值，缺失才用历史消息推导；
// timeUsedSeconds 在 active run 存在时不能用推导值，否则会与 live run 双算；
// tokenBudget 缺失写 null，与 mapSessionGoal 口径一致。
function buildGoalStats(
  projection: SessionProjection,
  messages: readonly MessageWithParts[],
): ZCodeSessionGoalStats | undefined {
  const target = projection.target;
  if (!target) {
    return undefined;
  }
  const goalIterations = collectGoalIterationBuckets(messages, {
    projection,
    target,
  });
  const activeIterationCount = getGoalActiveIterationCount(projection, target);
  const derivedTokensUsed = goalIterations.reduce(
    (sum, iteration) => sum + iteration.tokensUsed,
    0,
  );
  const derivedTimeUsedSeconds = goalIterations.reduce(
    (sum, iteration) => sum + iteration.timeUsedSeconds,
    0,
  );
  return {
    contextUsed: projection.contextUsed,
    contextWindow: projection.contextWindow,
    // goal 轮次只能由 verifier 生命周期边界推进；用户消息、TodoWrite
    // 或手动继续都只是落入当前打开轮次，不能单独开新轮。
    iterationCount: activeIterationCount,
    // active goal run 已由 session_target.active_run_started_at 表达。
    // 运行中不能再用 assistant 消息推导出的时间当已结算 base，否则 UI 会再叠加 live run 导致切换恢复后双算。
    // 只要 target 已有累计时间或正在运行，就以 target 为准；
    // 否则退回按消息区间推导的秒数。
    // 这是「切换恢复后时间翻倍」的修复点，timeUsedSeconds 以 target 为准。
    timeUsedSeconds:
      target.timeUsedSeconds > 0 || target.activeRunStartedAtMs != null
        ? target.timeUsedSeconds
        : derivedTimeUsedSeconds,
    // 旧 session_target 行可能没有 tokenBudget；协议 schema 需要稳定 JSON 值，
    // 与 mapSessionGoal 保持一致用 null 表示未设置预算。
    tokenBudget: target.tokenBudget ?? null,
    // DB 累计为 0 视为尚未结算，用推导值补；
    // 不能用 `??`：0 是有效值但语义是「未开始」。
    tokensUsed: target.tokensUsed > 0 ? target.tokensUsed : derivedTokensUsed,
    toolCallCount: goalIterations.reduce((sum, iteration) => sum + iteration.toolCallCount, 0),
  };
}

// 从历史 TodoWrite 工具调用重建分组：按 goal 轮次归组，同 target 下同内容 todo
// 只保留最后归属，避免同一事项在多个轮次分组里重复出现；无历史时回落到当前 todos。
// 从历史 TodoWrite 工具调用重建分组，而不是只读当前 todos；
// 按 goal 轮次归组，同一 target 下同内容 todo 只保留最后归属；
// 没有任何历史时才回落成单个 session-current 组；
// 分组按 startedAt 升序、id 兜底，保证渲染顺序稳定。
function buildTodoGroups(
  messages: readonly MessageWithParts[],
  currentTodos: readonly TodoItem[],
  projection: SessionProjection,
): ZCodeSessionTodoGroup[] {
  const target = projection.target;
  const timeline = getTargetGoalVerificationTimeline(projection, target);
  const groups = new Map<string, ZCodeSessionTodoGroup>();
  const todoOwners = new Map<string, { fingerprint: string; groupId: string }>();
  const sortedMessages = [...messages].sort(compareMessagesByCreatedTime);

  for (const message of sortedMessages) {
    if (message.info.role !== "assistant") {
      continue;
    }
    const goalIteration = getGoalIterationForMessageTime(
      message.info.time.created,
      target,
      timeline,
    );
    for (const part of message.parts) {
      if (
        part.type !== "tool" ||
        !isTodoWriteToolName(part.tool) ||
        !isMainAgentToolProjectionSource(part.metadata, readToolStateMetadata(part.state))
      ) {
        continue;
      }
      const todos = readTodosFromToolInput(part.state.input);
      if (!todos) {
        continue;
      }
      const updatedAt =
        readToolStateUpdatedAt(part.state) ??
        message.info.time.completed ??
        message.info.time.created;
      const groupId = goalIteration ? `goal-iteration-${goalIteration}` : "session";
      const group = ensureTodoGroup(groups, {
        goalIteration,
        groupId,
        startedAt: goalIteration
          ? getGoalIterationStartedAt(goalIteration, target, timeline, message.info.time.created)
          : message.info.time.created,
        targetId: goalIteration ? target?.targetID : undefined,
        updatedAt,
      });
      for (const todo of todos) {
        const fingerprint = normalizeTodoContent(todo.content);
        // 归属键 = target + 内容指纹：跨 target 的同名 todo 不互相覆盖；
        // 用 \u0000 分隔避免内容里出现分隔符造成误合并。
        const ownerKey = `${target?.targetID ?? "session"}\u0000${fingerprint}`;
        const owner = todoOwners.get(ownerKey);
        if (owner) {
          const ownerGroup = groups.get(owner.groupId);
          if (ownerGroup) {
            addOrUpdateTodoInGroup(ownerGroup, owner.fingerprint, todo);
            ownerGroup.updatedAt = Math.max(ownerGroup.updatedAt ?? 0, updatedAt);
          }
          continue;
        }
        todoOwners.set(ownerKey, { fingerprint, groupId });
        addOrUpdateTodoInGroup(group, fingerprint, todo);
      }
    }
  }

  // 没有任何可重建历史时才使用当前快照，避免把旧 todos 重复展示；
  // 该组 id 固定，前端可据此识别「非历史重建」。
  if (groups.size === 0 && currentTodos.length > 0) {
    groups.set("session-current", {
      id: "session-current",
      source: "session",
      todos: currentTodos.map(mapTodoItem),
    });
  }

  return [...groups.values()].sort((left, right) => {
    const leftTime = left.startedAt ?? Number.MAX_SAFE_INTEGER;
    const rightTime = right.startedAt ?? Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return left.id.localeCompare(right.id);
  });
}

// 同组重复出现时只推进 updatedAt，不重建 todos；
// startedAt 取首次出现，保证轮次顺序不因后续消息变化。
function ensureTodoGroup(
  groups: Map<string, ZCodeSessionTodoGroup>,
  input: {
    goalIteration: number | undefined;
    groupId: string;
    startedAt: number;
    targetId?: string;
    updatedAt: number;
  },
): ZCodeSessionTodoGroup {
  const existing = groups.get(input.groupId);
  if (existing) {
    existing.updatedAt = Math.max(existing.updatedAt ?? 0, input.updatedAt);
    return existing;
  }
  const group: ZCodeSessionTodoGroup = {
    id: input.groupId,
    source: input.goalIteration ? "goal_iteration" : "session",
    ...(input.goalIteration ? { goalIteration: input.goalIteration } : {}),
    ...(input.targetId ? { targetId: input.targetId } : {}),
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
    todos: [],
  };
  groups.set(input.groupId, group);
  return group;
}

// 按内容指纹原位更新，保持用户看到的待办顺序；
// 不存在才追加，不做按状态重排。
function addOrUpdateTodoInGroup(
  group: ZCodeSessionTodoGroup,
  fingerprint: string,
  todo: TodoItem,
): void {
  const nextTodo = mapTodoItem(todo);
  const existingIndex = group.todos.findIndex(
    (item) => normalizeTodoContent(item.content) === fingerprint,
  );
  if (existingIndex >= 0) {
    group.todos[existingIndex] = nextTodo;
    return;
  }
  group.todos.push(nextTodo);
}

function getGoalActiveIterationCount(
  projection: SessionProjection,
  target?: SessionGoal | null,
): number {
  const timeline = getTargetGoalVerificationTimeline(projection, target);
  return getZCodeGoalActiveIterationCount({
    targetStatus: target?.status ?? null,
    timeline,
  });
}

// 按消息时间把 token 用量与消息数累加到对应 goal 轮次；
// 不属于任何轮次的消息直接跳过（目标之前或通过之后的闲聊）；
// 排序在最后统一做，避免依赖消息原始顺序。
function collectGoalIterationBuckets(
  messages: readonly MessageWithParts[],
  options: { projection: SessionProjection; target?: SessionGoal | null },
): GoalIterationBucket[] {
  const target = options.target ?? null;
  const timeline = getTargetGoalVerificationTimeline(options.projection, target);
  const buckets: GoalIterationBucket[] = [];
  const byIteration = new Map<number, GoalIterationBucket>();
  const sortedMessages = [...messages].sort(compareMessagesByCreatedTime);

  for (const message of sortedMessages) {
    if (message.info.role !== "assistant") {
      continue;
    }
    const goalIteration = getGoalIterationForMessageTime(
      message.info.time.created,
      target,
      timeline,
    );
    if (!goalIteration) {
      continue;
    }
    const bucket =
      byIteration.get(goalIteration) ??
      createGoalIterationBucket(goalIteration, target, timeline, message.info.time.created);
    if (!byIteration.has(goalIteration)) {
      byIteration.set(goalIteration, bucket);
      buckets.push(bucket);
    }
    const messageId = String(message.info.id);
    bucket.messageIds.add(messageId);
    const completedAt = message.info.time.completed ?? message.info.time.created;
    bucket.toolCallCount += message.parts.filter((part) => part.type === "tool").length;
    bucket.tokensUsed += tokenTotal(message.info.tokens);
    bucket.timeUsedSeconds += Math.max(
      0,
      Math.ceil((completedAt - message.info.time.created) / 1000),
    );
    bucket.updatedAt = Math.max(bucket.updatedAt ?? 0, completedAt);
  }

  return buckets;
}

// 桶的 startedAt 由轮次边界决定，id 固定为 iteration-N；
// tokensUsed 允许来源为 0 的消息，但仍会计入 messageCount。
function createGoalIterationBucket(
  goalIteration: number,
  target: SessionGoal | null,
  timeline: readonly SessionProjection["targetCompletionVerificationTimeline"][number][],
  fallbackStartedAt: number,
): GoalIterationBucket {
  return {
    goalIteration,
    id: `goal-iteration-${goalIteration}`,
    messageIds: new Set(),
    startedAt: getGoalIterationStartedAt(goalIteration, target, timeline, fallbackStartedAt),
    targetId: target?.targetID,
    toolCallCount: 0,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    updatedAt: fallbackStartedAt,
  };
}

// 从 projection 的 timeline 中筛出本 target 的验证项；
// 有持久化 timeline 时已由 merge 阶段合并，这里不再二次去重。
function getTargetGoalVerificationTimeline(
  projection: SessionProjection,
  target?: SessionGoal | null,
): SessionProjection["targetCompletionVerificationTimeline"] {
  const targetId = target?.targetID;
  return (projection.targetCompletionVerificationTimeline ?? [])
    .filter((item) => !targetId || item.targetId === targetId)
    .sort(compareGoalVerificationTimeline);
}

// compareGoalVerificationTimeline 先比时间，再比 verificationId。
// 稳定排序是轮次切分正确的前提。
function compareGoalVerificationTimeline(
  left: SessionProjection["targetCompletionVerificationTimeline"][number],
  right: SessionProjection["targetCompletionVerificationTimeline"][number],
): number {
  const leftIteration = left.goalIteration ?? 0;
  const rightIteration = right.goalIteration ?? 0;
  if (leftIteration !== rightIteration && leftIteration > 0 && rightIteration > 0) {
    return leftIteration - rightIteration;
  }
  const byTime = goalVerificationTimelineTime(left) - goalVerificationTimelineTime(right);
  if (byTime !== 0) return byTime;
  return left.verificationId.localeCompare(right.verificationId);
}

// 时间字段可能来自 timestamp 或 time.created；
// 无法解析时返回 0，让该项排在最前而不是随机插入。
function goalVerificationTimelineTime(
  item: SessionProjection["targetCompletionVerificationTimeline"][number],
): number {
  return (item.startedAt ?? item.updatedAt).getTime();
}

// 按 verifier 时间边界把消息时间归入 goal 轮次：started 推进当前轮，
// 非 passing 结束推进下一轮，passing 结束之后的普通消息不再计入 goal。
// INV-08：轮次边界只来自 verifier timeline；
// started 推进当前轮；非 passing 的结束推进下一轮；passing 结束之后的普通消息不再计入 goal；
// 目标创建之前的消息一律不属于 goal。
function getGoalIterationForMessageTime(
  messageCreatedAt: number,
  target: SessionGoal | null | undefined,
  timeline: readonly SessionProjection["targetCompletionVerificationTimeline"][number][],
): number | undefined {
  if (!target || messageCreatedAt < target.time.created) {
    return undefined;
  }
  let activeIteration = 1;
  for (const item of timeline) {
    const itemIteration = item.goalIteration ?? activeIteration;
    const boundaryTime = item.updatedAt.getTime();
    if (messageCreatedAt <= boundaryTime) {
      return itemIteration;
    }
    // started 是同一轮的起点，不推进编号；
    // 这里 continue 而不是 return，后续消息仍按当前轮归属。
    if (item.status === "started") {
      activeIteration = itemIteration;
      continue;
    }
    // 验证通过即 goal 完成，之后的消息属于普通对话；
    // 返回 undefined 而不是继续累加，避免完成后的闲聊被算进轮次。
    if (isPassingGoalVerification(item)) {
      return undefined;
    }
    activeIteration = itemIteration + 1;
  }
  return activeIteration;
}

// 第 1 轮从 target 创建时间开始；后续轮从上一轮最后一个「非 started」边界开始；
// 没有边界时退回消息自身时间，保证字段非空。
function getGoalIterationStartedAt(
  goalIteration: number,
  target: SessionGoal | null | undefined,
  timeline: readonly SessionProjection["targetCompletionVerificationTimeline"][number][],
  fallbackStartedAt: number,
): number {
  if (!target || goalIteration <= 1) {
    return target?.time.created ?? fallbackStartedAt;
  }
  const previousBoundary = [...timeline]
    .filter((item) => (item.goalIteration ?? 0) === goalIteration - 1)
    .filter((item) => item.status !== "started")
    .sort(compareGoalVerificationTimeline)
    .at(-1);
  return previousBoundary?.updatedAt.getTime() ?? fallbackStartedAt;
}

function isPassingGoalVerification(
  item: SessionProjection["targetCompletionVerificationTimeline"][number],
): boolean {
  return item.status === "completed" && item.verification?.passed === true;
}

function normalizeTodoContent(content: string): string {
  return normalizeText(content);
}

// todos 必须是数组；任一项非法则整批视为不可读（返回 undefined）；
// 部分解析会让分组缺失条目，比整批忽略更难排查。
function readTodosFromToolInput(input: Record<string, unknown>): TodoItem[] | undefined {
  const rawTodos = input.todos;
  if (!Array.isArray(rawTodos)) {
    return undefined;
  }
  const todos = rawTodos.map(readTodoItem).filter((todo): todo is TodoItem => todo !== null);
  return todos.length === rawTodos.length ? todos : undefined;
}

// content 去空白后必须非空；status/priority 必须是枚举值；
// 任何一项不合法都返回 null，由上层整批丢弃。
function readTodoItem(value: unknown): TodoItem | null {
  const record = asRecord(value);
  const content = stringValue(record.content)?.trim();
  const status = stringValue(record.status);
  const priority = stringValue(record.priority);
  if (!content || !isTodoStatus(status) || !isTodoPriority(priority)) {
    return null;
  }
  return { content, priority, status };
}

// 归一化大小写与 _/空格/连字符，兼容不同模型的工具命名；
// 只接受归一后等于 todowrite 的名字。
function isTodoWriteToolName(toolName: string): boolean {
  return toolName.toLowerCase().replace(/[_\s-]/g, "") === "todowrite";
}

// pending 没有 metadata；running/completed/error 才有；
// 该返回值为 undefined 时，主智能体来源判定会保守地不认领。
function readToolStateMetadata(state: ToolState): Record<string, unknown> | undefined {
  switch (state.status) {
    case "pending":
      return undefined;
    case "running":
    case "completed":
    case "error":
      return state.metadata;
  }
}

// 枚举收窄同时服务读取历史与运行期输入；
// 新增状态必须同步协议 schema，否则旧端渲染会落到 unknown。
function isTodoStatus(status: string | undefined): status is TodoItem["status"] {
  return status === "pending" || status === "in_progress" || status === "completed";
}

function isTodoPriority(priority: string | undefined): priority is TodoItem["priority"] {
  return priority === "high" || priority === "medium" || priority === "low";
}

// 完成/失败取 end，运行中取 start，pending 无时间；
// 用于 todo 组的 updatedAt 与归属覆盖顺序。
function readToolStateUpdatedAt(state: ToolState): number | undefined {
  if (state.status === "completed" || state.status === "error") {
    return state.time.end;
  }
  if (state.status === "running") {
    return state.time.start;
  }
  return undefined;
}

// provider total 优先；缺失时四项相加（input/output/reasoning/cache 读写）；
// 口径与 runtime 的 token 统计一致，避免 goal 统计与上下文 meter 对不上。
function tokenTotal(tokens: {
  cache: { read: number; write: number };
  input: number;
  output: number;
  reasoning: number;
  total?: number;
}): number {
  return (
    tokens.total ??
    tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  );
}

// 时间相同再按 id 字典序，保证排序稳定；
// 重建 todo 分组与 goal 桶都依赖这个稳定性。
function compareMessagesByCreatedTime(left: MessageWithParts, right: MessageWithParts): number {
  const byTime = left.info.time.created - right.info.time.created;
  if (byTime !== 0) return byTime;
  return String(left.info.id).localeCompare(String(right.info.id));
}

// 内部事件类型到 v3 协议类型的唯一映射表；
// 多个内部类型合并成同一协议类型（如所有工具阶段 → tool.updated）；
// 新增内部类型若不改这里，会落到 default 的 session.updated。
function mapSessionEventType(type: SessionEvent["type"]): ZCodeSessionEvent["type"] {
  switch (type) {
    case SessionEventType.SessionCreated:
      return "session.created";
    case SessionEventType.SessionResumed:
      return "session.resumed";
    case SessionEventType.SessionTitleUpdated:
      return "session.titleUpdated";
    case SessionEventType.SessionEnded:
      return "session.closed";
    case SessionEventType.TurnStarted:
      return "turn.started";
    case SessionEventType.TurnSteerQueued:
      return "turn.steerQueued";
    case SessionEventType.TurnSteerDrained:
      return "turn.steerDrained";
    case SessionEventType.TurnComplete:
      return "turn.completed";
    case SessionEventType.TurnError:
      return "turn.failed";
    case SessionEventType.UserMessage:
    case SessionEventType.AssistantMessage:
    case SessionEventType.SystemMessage:
      return "message.upserted";
    case SessionEventType.ModelStreaming:
      return "model.streaming";
    case SessionEventType.ToolCallScheduled:
    case SessionEventType.ToolCallStarted:
    case SessionEventType.ToolCallProgress:
    case SessionEventType.ToolCallResult:
    case SessionEventType.ToolCallError:
    case SessionEventType.ToolBatchComplete:
      return "tool.updated";
    case SessionEventType.PermissionRequested:
      return "permission.requested";
    case SessionEventType.PermissionResolved:
    case SessionEventType.PermissionDenied:
      return "permission.resolved";
    case SessionEventType.CheckpointCreated:
      return "checkpoint.created";
    case SessionEventType.RewindTriggered:
      return "rewind.triggered";
    case SessionEventType.StreamRecoveryAnchorCreated:
    case SessionEventType.StreamRecoveryStarted:
    case SessionEventType.StreamRecoveryAnchorSelected:
    case SessionEventType.StreamRecoveryRetryStarted:
    case SessionEventType.StreamRecoveryTailDiscarded:
    case SessionEventType.StreamRecoveryBlocked:
      return "streamRecovery.updated";
    default:
      // INV-17：default 是兼容性缓冲垫，新类型不会被旧端拒收；
      // 代价是语义丢失，因此需要 UI 感知的新事件必须显式加 case。
      return "session.updated";
  }
}
