// 权限/交互 broker：把 core 的 PermissionBrokerPort 适配到 v3 反向 RPC 与 v4 pending interaction。
// 做：按工具名分流请求、双通道竞速、协议错误翻译、把应答归一成 broker 结果或工具输入。
// 不做：决定权限策略、持久化规则、UI 展示；不持有会话状态，也不直接访问网络。
// 依赖：context.requestClient（旧 RPC）、context.v4Gateway（v4 投影）、permission-options（选项合成）。
// 边界：只做协议适配与语义归一；任何策略变更必须先改 spec 再改这里。
//
// INV-01 断言：分流顺序必须是 AskUserQuestion → ExitPlanMode → 普通权限 —— 守住它的位置：requestPermission 三元 —— 改错故障：AskUserQuestion 走权限通道，UI 显示成允许/拒绝。
// INV-02 断言：registered 必须在请求登记时 resolve，而不是在结果返回时 —— 守住它的位置：onRegistered → ready.resolve —— 改错故障：core 等不到登记信号，请求永远不发出。
// INV-03 断言：result 的错误分支与 ready 的 reject 必须共用同一个派生 promise —— 守住它的位置：result 与 result.then —— 改错故障：两处各自 catch，出现未处理拒绝或错误被吞。
// INV-04 断言：ready.promise 必须挂空 catch —— 守住它的位置：ready.promise.catch —— 改错故障：旧调用方不观察 registered 时进程抛 unhandledRejection。
// INV-05 断言：只有 guarded 模式才翻译 ProtocolRequestError —— 守住它的位置：request.mode === "guarded" —— 改错故障：非 guarded 请求被当成 CoreError，core 误判为用户拒绝。
// INV-06 断言：错误码映射固定为 cancelled→ToolCancelled、timedOut→PermissionTimeout、noClientAttached→ConfigurationError —— 守住它的位置：三段三元 —— 改错故障：超时被当成普通失败，重试策略失效。
// INV-07 断言：未知错误必须原样 rethrow，不得兜底成 deny —— 守住它的位置：throw error —— 改错故障：基础设施故障伪装成用户拒绝，问题被永久掩盖。
// INV-08 断言：必须同时合成 v4 完整选项与 legacy 选项 —— 守住它的位置：legacyPermissionOptions —— 改错故障：旧桌面收到认不出的 option，回传原文导致解析失败。
// INV-09 断言：会话免确认选项只允许出现在 v4 通道 —— 守住它的位置：toLegacyPermissionOptionsPolicy —— 改错故障：旧桌面回传 response 原文，会话语义丢失。
// INV-10 断言：fullAccess 的五个前提缺一不可 —— 守住它的位置：fullAccess 展开条件 —— 改错故障：不该全量放行的场景直接授权，绕过审批。
// INV-11 断言：fullAccess 必须先 claimResponse 再授权，claim 失败即抛 —— 守住它的位置：分支前两行 —— 改错故障：重复应答，或界面已放行但会话未生效。
// INV-12 断言：fullAccess 必须等待 waitForPermissionGrantCommit —— 守住它的位置：分支最后一个 await —— 改错故障：v4 客户端仍显示 pending，用户重复点击。
// INV-13 断言：deny 且无 reason 时必须补 PERMISSION_DENIED_BY_USER_CONTENT —— 守住它的位置：返回对象展开 —— 改错故障：core 回退通用文案，无法阻止绕过式尝试。
// INV-14 断言：v4 应答必须先处理 workflow Refine 特判，再走 optionId 精确匹配 —— 守住它的位置：v4AnswerToPermissionResponse —— 改错故障：Refine 反馈被当普通 deny，无法升级为用户消息。
// INV-15 断言：Refine 特判必须同时校验工具名、optionId、非空 freeText —— 守住它的位置：该 if —— 改错故障：伪造 optionId 即可把任意文本注入用户消息通道。
// INV-16 断言：未知 optionId 一律 deny，绝不放行 —— 守住它的位置：函数末尾 —— 改错故障：权限语义下未知应答变成允许，形成提权面。
// INV-17 断言：sessionPermissionUpdates 必须在 broker 侧合成，不能塞进 option.response —— 守住它的位置：SESSION_ALLOW 分支 —— 改错故障：wire schema 是 strict，旧桌面直接丢事件。
// INV-18 断言：MCP elicitation 无 sessionId 或无 record 必须 decline，不得猜会话 —— 守住它的位置：requestMcpElicitation 早退 —— 改错故障：提问挂到别的会话，用户答非所问。
// INV-19 断言：合成事件 sequenceNumber 必须为 0 —— 守住它的位置：ingestSynthetic 的事件体 —— 改错故障：沿用持久化高水位+1，第二条合成事件被当重放丢弃，pending 永不清。
// INV-20 断言：合成 PermissionResolved 必须在 finally 中执行且吞掉错误 —— 守住它的位置：finally —— 改错故障：竞速抛错时 pending 残留，投影永远停在等待中。
//
// 阅读顺序：先看 INV 清单，再看分流、竞速、归一三段的顺序标注。
// 约束：新增应答字段时必须同时考虑旧桌面 strict schema，只增不改语义。
import { randomUUID } from "node:crypto";
import { raceClientRequestWithV4Interaction } from "./interaction-response-race.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  CoreErrorType,
  createCoreError,
  AskUserQuestionInputSchema,
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
  SessionEventType,
  createEventId,
  type AskUserQuestion,
  type McpElicitationRequest,
  type McpElicitationResult,
  type PermissionBrokerPort,
  type PermissionBrokerRequest,
  type PermissionBrokerRequestOptions,
  type PermissionBrokerResult,
  type SessionEvent,
} from "@zcode/contracts";
import {
  MCP_ELICITATION_INTERACTION,
  MCP_ELICITATION_TOOL_NAME,
  mcpElicitationContentFromAnswers,
  mcpElicitationQuestions,
} from "../zcode-protocol-v4/mcp-elicitation.js";
import {
  WORKFLOW_REFINE_PERMISSION_OPTION_ID,
  zcodePermissionResponseSchema,
  zcodeProtocolMethods,
  zcodeUserInputResponseSchema,
  type ZCodePermissionOption,
  type ZCodePermissionResponse,
  type ZCodeUserInputQuestion,
  type ZCodeUserInputResponse,
} from "@zcode/shared";
import type {
  V4InteractionAnswer,
  V4InteractionRegistrationOptions,
} from "../zcode-protocol-v4/interaction-registry.js";
import {
  PROTOCOL_CLIENT_REQUEST_ERROR_CODES,
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";
import {
  buildProtocolPermissionOptions,
  buildSessionPermissionUpdates,
  SESSION_ALLOW_PERMISSION_OPTION_KIND,
  toLegacyPermissionOptionsPolicy,
  buildPermissionDeniedContent,
  PERMISSION_DENIED_BY_USER_CONTENT,
} from "./permission-options.js";
import { withWorkflowSettingsAdjustment } from "./workflow-settings-answer.js";

const EXIT_PLAN_MODE_APPROVAL_QUESTION = "Review this implementation plan.";
const EXIT_PLAN_MODE_APPROVAL_APPROVE = "approve";
const INTERACTION_REQUEST_REANNOUNCE_INTERVAL_MS = 1_000;

interface RegisteredRequestOptions extends PermissionBrokerRequestOptions {
  onRegistered?: () => void;
}

/**
 * 构造权限/交互 broker（PermissionBrokerPort 适配器）。requestPermission 按工具名分流：
 * AskUserQuestion → 用户输入，ExitPlanMode → 计划审批，其余 → 普通权限。
 * 返回 result 附带 registered Promise，供 core 在请求已登记/无需等待 UI 时继续。
 */
// [契约] 返回的端口对象只暴露 requestPermission，其它能力一律不加。
// [失败路径] 在此处缓存 context 的会话或权限状态，会让 broker 变成第二个状态源。
// [权衡] 工厂函数而非类：无需生命周期，也不需要注入额外依赖。
// [资源] 该工厂无副作用，可在每次握手时重复调用。
// [边界] context 是唯一入口，broker 不读全局配置。
export function createProtocolInteractionBroker(
  context: ZCodeProtocolAgentServerContext,
): PermissionBrokerPort {
  return {
    requestPermission(request, options) {
      // [契约] ready 只表达「请求已登记」，与「请求已应答」是两个独立信号。
      // [失败路径] 若改成在结果返回时 resolve，core 会一直等到超时才发请求。
      // [并发] registeredOptions 必须同步构造，onRegistered 只能在登记瞬间触发一次。
      // [权衡] 用 withResolvers 而不是手写 Promise executor：避免额外的闭包状态。
      // [边界] ready 不携带结果值，结果始终从 result 读取。
      const ready = Promise.withResolvers<void>();
      const registeredOptions = { ...options, onRegistered: () => ready.resolve() };
      const requestResult =
        request.toolName === ASK_USER_QUESTION_TOOL_NAME
          ? requestUserInput(context, request, registeredOptions)
          : request.toolName === EXIT_PLAN_MODE_TOOL_NAME
            ? requestExitPlanModeApproval(context, request, registeredOptions)
            : requestPermission(context, request, registeredOptions);
      // [契约] 这是唯一的协议错误翻译层：core 不认识传输错误码，只认识 CoreError。
      // [失败路径] 把翻译下沉到各 request* 函数会导致四处重复且语义漂移。
      // [并发] catch 必须返回新 promise，不能同步抛出，否则 ready 的 reject 拿不到同一错误。
      // [权衡] 只在 guarded 模式翻译：非 guarded 调用方自己处理传输错误。
      // [边界] 翻译后的错误标记 recoverable，允许上层继续尝试。
      const result = requestResult.catch((error: unknown) => {
        // 协议错误只在适配层翻译；core 不识别传输错误码，也不能把基础设施故障当用户拒绝。
        if (request.mode === "guarded" && error instanceof ProtocolRequestError) {
          const type =
            error.code === PROTOCOL_CLIENT_REQUEST_ERROR_CODES.cancelled
              ? CoreErrorType.ToolCancelled
              : error.code === PROTOCOL_CLIENT_REQUEST_ERROR_CODES.timedOut
                ? CoreErrorType.PermissionTimeout
                : error.code === PROTOCOL_CLIENT_REQUEST_ERROR_CODES.noClientAttached
                  ? CoreErrorType.ConfigurationError
                  : CoreErrorType.ToolExecutionFailed;
          throw createCoreError(type, error.message, { cause: error, recoverable: true });
        }
        throw error;
      });
      void result.then(
        () => ready.resolve(),
        (error: unknown) => ready.reject(error),
      );
      // 旧调用方只消费 result；它们不观察登记信号时也不能产生未处理拒绝。
      // [契约] 这行是「未观察 registered 也不炸进程」的唯一保险。
      // [失败路径] 删掉后旧调用方只在 result 上挂 catch，ready 的 reject 会成为未处理拒绝。
      // [权衡] 用空 catch 而不是包 try：注册侧只需要吞掉，不需要日志噪音。
      // [边界] 该 catch 不改变 ready 对真正观察者的行为。
      // [并发] 必须在返回前挂上，晚一拍就可能已经 reject。
      void ready.promise.catch(() => {});
      return Object.assign(result, { registered: ready.promise });
    },
  };
}

// [契约] 普通权限通道：先合成两套选项，再双通道竞速，最后补齐 deny 文案。
// [失败路径] 先竞速后合成选项会让 v4 回调拿到不完整的 option 表。
// [并发] 本次请求的 requestId 是唯一关联键，不能在此重新生成。
// [边界] 该函数不处理 AskUserQuestion 与 ExitPlanMode。
// [资源] 两套选项都在 await 之前算完，避免竞速期间的额外分配。
async function requestPermission(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
  options?: RegisteredRequestOptions,
): Promise<PermissionBrokerResult> {
  // [契约] v4 选项必须由 permission-options 统一合成，术语文案不在本文件出现。
  // [失败路径] 手工拼选项会漏掉 permissionUpdates，allow_project 的持久化规则丢失。
  // [并发] optionId 在 v4 应答回传时用于精确匹配，本函数内不得重排。
  // [权衡] 两套选项各算一次而不是复用后裁剪：legacy 需要不同的 option 集合。
  // [边界] 该结果只在本函数生命周期内有效。
  const permissionOptions = buildProtocolPermissionOptions(request);
  // v3 反向 RPC 的选项列表：会话免确认只在 v4 投放（旧桌面回传 response 原文，认不出会话语义）。
  // [契约] legacy 选项必须走 toLegacyPermissionOptionsPolicy 降级。
  // [失败路径] 直接复用 v4 选项会让旧桌面收到会话免确认这类它不认识的 option。
  // [权衡] 传展开后的 request 而不是改原对象：原 request 还要给 v4 通道使用。
  // [边界] legacy 通道只承载 option 列表差异，其余字段完全一致。
  const legacyPermissionOptions = buildProtocolPermissionOptions({
    ...request,
    optionsPolicy: toLegacyPermissionOptionsPolicy(request.optionsPolicy),
  });
  // 双通道竞速：同时发旧反向 RPC 并登记 v4 pending interaction，谁先应答用谁；
  // v4 应答命中会经内部 signal 取消悬空的反向 RPC。
  // [契约] 双通道竞速：旧反向 RPC 与 v4 pending interaction 谁先应答用谁。
  // [失败路径] 顺序改成串行会让不支持 v4 的旧桌面必须等超时后才能作答。
  // [并发] v4 命中时由内部 signal 取消悬空的反向 RPC，避免双写结果。
  // [权衡] 竞速逻辑封装在 race 里，本文件只提供两条通道的构造。
  // [边界] 传出的 signal 已级联外层 options.signal，此处不重复监听。
  const response = await raceClientRequestWithV4Interaction(
    context,
    request.requestId,
    options?.signal,
    (signal) =>
      context.requestClient(
        zcodeProtocolMethods.interactionRequestPermission,
        {
          input: request.input,
          reason: request.reason,
          requestId: request.requestId,
          riskLevel: request.riskLevel,
          sessionId: request.sessionId,
          ...(request.origin ? { origin: request.origin } : {}),
          options: legacyPermissionOptions,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          turnId: request.turnId,
        },
        zcodePermissionResponseSchema,
        withInteractionRequestRecovery(options, signal),
      ),
    // v4 answer → ZCodePermissionResponse：optionId 语义来自 v4 reducer 合成的
    // allowOnce/allowAlways/deny（见 product-projection onPermissionRequested）。
    (answer) => {
      // 工作流确认窗里调整过的设置随放行应答一起走（docs/dynamic-workflow/launch.md
      // 「Adjusting the settings in the window」）。
      // [契约] v4 answer 必须先映射成完整 ZCodePermissionResponse，再做工作流设置修补。
      // [失败路径] 先修补后映射会让 sessionPermissionUpdates 被覆盖。
      // [并发] 映射依赖本次请求的 permissionOptions 快照，不能用全局缓存。
      // [权衡] preserveReasonFormatting 只在 deny 且有自由文本时置真。
      // [边界] 该函数不产生副作用，仅做纯映射。
      const base = v4AnswerToPermissionResponse(answer, permissionOptions, request.toolName);
      const response = withWorkflowSettingsAdjustment(base, answer, request.toolName);
      return response.decision === "deny" && answer.freeText?.trim()
        ? { ...response, preserveReasonFormatting: true }
        : response;
    },
    {
      ...createInteractionRegistrationOptions(request, "other"),
      ...(request.approvalMode !== "user-once" && !request.origin &&
      !request.optionsPolicy &&
      options?.claimResponse &&
      context.deps?.sessionStore?.commitPermissionFullAccess
        ? {
            fullAccess: async () => {
              // 全量放行：先 claim 唯一应答权，再让 runtime 授权并等待 v4 提交完成，
              // 防止重复应答与“界面已放行但会话尚未生效”的竞态。
              // [契约] 全量放行必须先抢占唯一应答权，抢不到立即抛错。
              // [失败路径] 先授权后 claim 会出现两次放行，第二次覆盖第一次的事件。
              // [并发] claim 与 signal 检查必须相邻：claim 之后立刻确认未取消。
              // [权衡] 抛普通 Error 而非 CoreError：这是内部竞态，不该被翻译成用户可见错误。
              // [边界] 该分支只在 fullAccess 条件下可达。
              if (!options.claimResponse!()) throw new Error("Permission response already settled");
              options.signal?.throwIfAborted();
              const record = context.sessions.get(String(request.sessionId));
              if (!record) throw new Error("Permission session unavailable");
              const eventId = await record.app.runtime.grantPermissionFullAccess(
                request.requestId,
                options.signal,
              );
              // [契约] 授权后必须等待 v4 提交完成再返回，顺序不可交换。
              // [失败路径] 不等待会让界面仍显示 pending，用户重复点击触发 claim 冲突。
              // [并发] 该 await 位于 claim 之后，任何提前返回都会绕过提交。
              // [边界] gateway 不存在时可选链直接跳过，兼容无 v4 的宿主。
              await context.v4Gateway?.waitForPermissionGrantCommit(
                String(request.sessionId),
                eventId,
              );
            },
          }
        : {}),
    },
    options?.onRegistered,
  );
  return {
    ...response,
    // 兼容原因：legacy 客户端允许省略 reason；普通用户拒绝仍需向模型明确工具未执行，
    // 否则 core 会回退为通用的 `Permission denied for <tool>`，无法阻止绕过式尝试。
    // [契约] 兼容旧客户端：deny 且无 reason 时必须补标准拒绝文案。
    // [失败路径] 不补会让 core 回退为通用文案，无法阻止绕过式尝试。
    // [权衡] 只在 reason 为空时补，用户自定义理由必须原样保留。
    // [边界] 该修补只针对 deny，allow 不写 reason。
    // [并发] resolvedAt 在修补之后统一赋值，保证时间戳同源。
    ...(response.decision === "deny" && !response.reason?.trim()
      ? { reason: PERMISSION_DENIED_BY_USER_CONTENT }
      : {}),
    resolvedAt: new Date(),
  };
}

/**
 * v4 permission 应答映射：优先按 optionId 精确匹配 buildProtocolPermissionOptions
 * 合成的选项（allow_project 携带 permissionUpdates 持久化规则，不能丢）；投影侧
 * 合成的 allowAlways 语义等价 allow_project。未知 optionId 按 deny 兜底——权限
 * 语义下宁可拒绝也不放行未知应答。
 *
 * workflow Refine：该选项只在 v4 投影
 * 合成、不进 legacy 选项列表，所以在精确匹配之前特判。freeText 为空、或非
 * CreateWorkflow 工具伪造该 optionId，都落到既有 deny 兜底且不带 reasonSource——
 * 反馈升级为 user message 的通道必须只对真实用户输入开放。
 */
// [契约] 映射优先级固定：workflow Refine → optionId 精确匹配 → allowAlways → allowOnce → deny。
// [失败路径] 顺序调整会让 Refine 反馈落进 deny 兜底并丢失 reasonSource。
// [权衡] 未知 optionId 按 deny 兜底：权限语义宁可拒绝也不放行。
// [边界] 该函数不认识 UI 文案，只认 optionId 与 kind。
// [并发] v4AnswerToPermissionResponse 只读入参并返回新对象，不碰 handler 状态；多个 resolve 竞速时调用顺序不影响结果。
function v4AnswerToPermissionResponse(
  answer: V4InteractionAnswer,
  permissionOptions: ZCodePermissionOption[],
  toolName: string,
): ZCodePermissionResponse & {
  reasonSource?: PermissionBrokerResult["reasonSource"];
  sessionPermissionUpdates?: PermissionBrokerResult["sessionPermissionUpdates"];
} {
  // [契约] Refine 反馈只从 freeText 取，且必须 trim 后非空。
  // [失败路径] 用 content 或 answers 取值会让伪造 payload 绕过工具名校验。
  // [权衡] 不在此处校验长度：长度上限由 schema 与 UI 负责。
  // [边界] 空字符串等同于没有反馈，落回普通 deny。
  // [并发] 该变量在三个条件判断前一次求值，避免重复 trim 结果不一致。
  const refineFeedback = answer.freeText?.trim();
  if (
    (toolName === CREATE_WORKFLOW_TOOL_NAME || toolName === AMEND_WORKFLOW_TOOL_NAME) &&
    answer.optionId === WORKFLOW_REFINE_PERMISSION_OPTION_ID &&
    refineFeedback
  ) {
    return {
      decision: "deny",
      reason: refineFeedback,
      reasonSource: "workflow_refine_feedback",
    };
  }
  // [契约] 精确匹配是唯一能带出 permissionUpdates 的路径。
  // [失败路径] 跳过精确匹配直接看 kind 会丢掉 allow_project 的持久化规则。
  // [权衡] 用 find 而不是 Map：选项数量个位数，且需保持原顺序。
  // [边界] 匹配不到时进入下面的语义兜底分支。
  const exact = permissionOptions.find((option) => option.optionId === answer.optionId);
  if (exact) {
    if (exact.kind === "deny") {
      return { decision: "deny", reason: buildPermissionDeniedContent(answer.freeText) };
    }
    // 会话免确认：会话语义在这里合成，而不是放进
    // option.response——wire 上 zcodePermissionUpdateSchema 是 strict，旧桌面多一个字段就丢事件。
    // [契约] 会话免确认必须在 broker 侧合成 sessionPermissionUpdates。
    // [失败路径] 把该字段塞进 option.response 会被 wire strict schema 丢弃。
    // [权衡] 只对 exact 命中生效：伪造 optionId 无法合成会话级放行。
    // [边界] 合成内容由 buildSessionPermissionUpdates 统一生成，不在此写死。
    // [并发] 该分支不触发额外 IO，纯内存构造。
    if (exact.kind === SESSION_ALLOW_PERMISSION_OPTION_KIND) {
      return {
        ...exact.response,
        sessionPermissionUpdates: buildSessionPermissionUpdates(toolName),
      };
    }
    return exact.response;
  }
  // [契约] allowAlways 是 v4 投影合成的语义别名，必须映射到 allow_always 选项。
  // [失败路径] 找不到对应选项时不能退化成 allow，必须继续走到 deny 兜底。
  // [权衡] 别名兼容只保留这两个固定值，其余 optionId 不猜。
  // [边界] allowOnce 直接构造 allow，不查选项表。
  if (answer.optionId === "allowAlways") {
    const allowAlways = permissionOptions.find((option) => option.kind === "allow_always");
    if (allowAlways) {
      return allowAlways.response;
    }
  }
  if (answer.optionId === "allowOnce") {
    return { decision: "allow", reason: "Approved once" };
  }
  // deny/rejectOnce/rejectAlways、未知 optionId、无 optionId 全部落 deny。
  return { decision: "deny", reason: buildPermissionDeniedContent(answer.freeText) };
}

/**
 * MCP elicitation：server 在工具执行中向用户提问。
 * 复用 AskUserQuestion 的两条通道——旧 RPC interaction/requestUserInput 与 v4 pending interaction——
 * 后者靠合成（不持久化）的 PermissionRequested / PermissionResolved 事件推进投影。
 */
// [契约] elicitation 复用 AskUserQuestion 的两条通道，只是 requestId 由本地合成。
// [失败路径] 四种失败路径（无会话、取消、拒绝、schema 不匹配）都必须有明确出口。
// [并发] 合成事件只进 live 投影、不落盘，seq 由 gateway 分配。
// [权衡] 提问内容由 mcpElicitationQuestions 生成，本文件不解释 JSON Schema。
// [边界] 返回 decline 而不是抛错，让 MCP server 自己决定降级。
export async function requestMcpElicitation(
  context: ZCodeProtocolAgentServerContext,
  request: McpElicitationRequest,
  options?: { signal?: AbortSignal },
): Promise<McpElicitationResult> {
  const sessionId = request.trace?.sessionId;
  const record = sessionId ? context.sessions?.get(sessionId) : undefined;
  if (!sessionId || !record) {
    // 没有正在执行的工具调用可归属（如 server 在空闲时主动提问）：拒绝而不是猜会话。
    return { action: "decline" };
  }
  // [契约] 必须在本地生成唯一 interactionId：server 侧没有可复用的请求 id。
  // [失败路径] 用 serverName 或时间戳会让并发提问互相覆盖 pending。
  // [权衡] 前缀带 mcp-elicit，便于日志与投影侧识别来源。
  // [边界] 该 id 只作为 requestId 使用，不写进持久化事件序号。
  const interactionId = `mcp-elicit-${randomUUID()}`;
  const toolCallId = request.trace?.toolCallId ?? interactionId;
  const questions = mcpElicitationQuestions(request.message, request.requestedSchema);
  const input = {
    serverName: request.serverName,
    message: request.message,
    requestedSchema: request.requestedSchema,
  };
  const traceId = request.trace?.traceId ?? String(record.traceContext.traceId);
  const ingestSynthetic = async (
    type: typeof SessionEventType.PermissionRequested | typeof SessionEventType.PermissionResolved,
    payload: Record<string, unknown>,
  ) => {
    const gateway = context.v4Gateway;
    if (!gateway) return;
    const event: SessionEvent = {
      id: createEventId(),
      sessionId: sessionId as never,
      ...(request.trace?.turnId ? { turnId: request.trace.turnId as never } : {}),
      type,
      timestamp: new Date(),
      traceId: traceId as never,
      // 只进 live 投影、不落盘：raw seq 置 0，让 v4 gateway 分配 transport 序号。
      // 若沿用持久化高水位 +1，第二条合成事件会因 seq 不高于游标被当作重放丢弃，pending 永远清不掉。
      // [契约] 合成事件必须把 seq 置 0，交给 gateway 分配 transport 序号。
      // [失败路径] 沿用持久化高水位+1 时，第二条合成事件会因 seq 不高于游标被当重放丢弃。
      // [失败路径] seq 一旦被判重放，PermissionResolved 永远不会推进，pending 清不掉。
      // [权衡] 0 是「未持久化」的显式标记，不是合法游标值。
      // [边界] 该规则只适用于 ingestSynthetic，真实事件仍用持久化序号。
      sequenceNumber: 0,
      payload: payload as never,
    };
    gateway.ingest(sessionId, event);
  };
  await ingestSynthetic(SessionEventType.PermissionRequested, {
    requestId: interactionId,
    toolCallId,
    toolName: MCP_ELICITATION_TOOL_NAME,
    riskLevel: "low",
    reason: request.message,
    input,
  });
  let response: ZCodeUserInputResponse;
  try {
    response = await raceClientRequestWithV4Interaction(
      context,
      interactionId,
      options?.signal,
      (signal) =>
        context.requestClient(
          zcodeProtocolMethods.interactionRequestUserInput,
          {
            input,
            prompt: request.message,
            questions,
            requestId: interactionId,
            schema: {
              interaction: MCP_ELICITATION_INTERACTION,
              serverName: request.serverName,
              requestedSchema: request.requestedSchema,
            },
            sessionId,
            toolCallId,
            toolName: MCP_ELICITATION_TOOL_NAME,
            ...(request.trace?.turnId ? { turnId: request.trace.turnId } : {}),
          },
          zcodeUserInputResponseSchema,
          withInteractionRequestRecovery(options, signal),
        ),
      (answer) => v4AnswerToUserInputResponse(answer),
      { sessionId, kind: "other" },
    );
  // [契约] PermissionResolved 必须在 finally 中合成，保证竞速抛错也会清理。
  // [失败路径] 放在 try 尾部会被提前 return 与异常绕过，pending 残留。
  // [权衡] catch(() => undefined) 吞掉清理失败：清理不应掩盖原始错误。
  // [边界] finally 只清理投影，不修改本次返回值。
  } finally {
    await ingestSynthetic(SessionEventType.PermissionResolved, {
      requestId: interactionId,
      toolCallId,
      decision: "allow",
    }).catch(() => undefined);
  }
  if (response.action !== "accept") return { action: response.action };
  return {
    action: "accept",
    content: mcpElicitationContentFromAnswers(request.requestedSchema, questions, response.content),
  };
}

// [契约] AskUserQuestion 必须先用 schema 收敛输入，非法输入直接 deny。
// [失败路径] 跳过 safeParse 会把脏数据透传给 UI，客户端可能崩溃。
// [并发] 自动继续状态必须在竞速之前读取，作为登记参数的一部分。
// [权衡] 非法输入返回 deny 而不是抛错：工具调用需要拿到结构化结果。
// [边界] 该函数不负责把 answers 写回工具输入，见 userInputResponseToBrokerResult。
async function requestUserInput(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
  options?: RegisteredRequestOptions,
): Promise<PermissionBrokerResult> {
  // 输入先按 AskUserQuestion schema 收敛；非法输入直接 deny，避免把脏数据透传给 UI。
  const parsed = AskUserQuestionInputSchema.safeParse(request.input);
  if (!parsed.success) {
    return {
      decision: "deny",
      reason: `Invalid AskUserQuestion input: ${
        parsed.error.issues[0]?.message ?? "schema validation failed"
      }`,
      resolvedAt: new Date(),
    };
  }

  const initialAutoResolution = await readPersistedAutoResolution(context, request);

  const response = await raceClientRequestWithV4Interaction(
    context,
    request.requestId,
    options?.signal,
    (signal) =>
      context.requestClient(
        zcodeProtocolMethods.interactionRequestUserInput,
        {
          input: request.input,
          prompt: request.reason,
          questions: parsed.data.questions.map(mapAskUserQuestion),
          requestId: request.requestId,
          schema: { toolName: request.toolName },
          sessionId: request.sessionId,
          ...(request.origin ? { origin: request.origin } : {}),
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          turnId: request.turnId,
        },
        zcodeUserInputResponseSchema,
        withInteractionRequestRecovery(options, signal),
      ),
    // v4 答 AskUserQuestion：freeText/optionId 落到单题 answer 槽位
    // （normalizeAskUserQuestionResponseContent 的 content.answer 兼容路径）；
    // deny 落 decline。多题场景等 v4 投影建模 userInput kind 后再精确映射。
    (answer) => v4AnswerToUserInputResponse(answer),
    createInteractionRegistrationOptions(
      request,
      "askUserQuestion",
      context,
      initialAutoResolution,
    ),
    options?.onRegistered,
  );

  return userInputResponseToBrokerResult(request, response);
}

// [契约] answer.action 存在时按旧 respondUserInput 语义精确直传。
// [失败路径] 忽略 action 会让 host adapter 收敛后的多题 answers 被降级成单题。
// [权衡] freeText 与 allowOnce 只是兼容旧投影的兜底，不是主路径。
// [边界] 其余情况一律 decline，不猜用户意图。
function v4AnswerToUserInputResponse(answer: V4InteractionAnswer): ZCodeUserInputResponse {
  // answer.action 存在（host adapter respondElicitation 收敛路径）
  // 时按旧 respondUserInput 语义精确直传——content 携带多题 answers/annotations，
  // normalizeAskUserQuestionResponseContent 继续负责 schema 收敛。
  if (answer.action) {
    return answer.action === "accept"
      ? { action: "accept", content: answer.content ?? {} }
      : { action: answer.action };
  }
  const text = answer.freeText?.trim();
  if (text) {
    return { action: "accept", content: { answer: text } };
  }
  if (answer.optionId === "allowOnce" || answer.optionId === "allowAlways") {
    return { action: "accept", content: {} };
  }
  return { action: "decline" };
}

// [契约] 计划审批复用 userInput 通道，用 schema.interaction=plan_approval 区分 UI。
// [失败路径] 改走权限通道会丢失自由文本反馈，无法形成 plan_approval_feedback。
// [权衡] 只有一个 Approve 选项，拒绝通过 decline 或自由文本表达。
// [边界] 问题文案与选项值都是常量，不在投影侧硬编码。
async function requestExitPlanModeApproval(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
  options?: RegisteredRequestOptions,
): Promise<PermissionBrokerResult> {
  // 计划审批复用 userInput 通道，但 schema 标记 interaction=plan_approval 供宿主区分 UI。
  const response = await raceClientRequestWithV4Interaction(
    context,
    request.requestId,
    options?.signal,
    (signal) =>
      context.requestClient(
        zcodeProtocolMethods.interactionRequestUserInput,
        {
          input: request.input,
          prompt: request.reason,
          questions: [createExitPlanModeApprovalQuestion()],
          requestId: request.requestId,
          schema: { interaction: "plan_approval", toolName: request.toolName },
          sessionId: request.sessionId,
          ...(request.origin ? { origin: request.origin } : {}),
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          turnId: request.turnId,
        },
        zcodeUserInputResponseSchema,
        withInteractionRequestRecovery(options, signal),
      ),
    // v4 答 plan approval：allow 类 optionId = 批准；freeText = 计划反馈
    // （planApprovalResponseToBrokerResult 走 plan_approval_feedback deny）；否则 decline。
    (answer) => v4AnswerToPlanApprovalResponse(answer),
    createInteractionRegistrationOptions(request, "other"),
    options?.onRegistered,
  );

  return planApprovalResponseToBrokerResult(response);
}

function v4AnswerToPlanApprovalResponse(answer: V4InteractionAnswer): ZCodeUserInputResponse {
  // 同 v4AnswerToUserInputResponse——host adapter 收敛路径直传
  // action/content，planApprovalResponseToBrokerResult 继续做 approve/feedback 归一。
  if (answer.action) {
    return answer.action === "accept"
      ? { action: "accept", content: answer.content ?? {} }
      : { action: answer.action };
  }
  if (answer.optionId === "allowOnce" || answer.optionId === "allowAlways") {
    return {
      action: "accept",
      content: { answer: EXIT_PLAN_MODE_APPROVAL_APPROVE },
    };
  }
  const feedback = answer.freeText?.trim();
  if (feedback) {
    return { action: "accept", content: { answer: feedback } };
  }
  return { action: "decline" };
}

function createExitPlanModeApprovalQuestion(): ZCodeUserInputQuestion {
  return {
    header: "Plan",
    options: [
      {
        description: "Exit plan mode and start implementation.",
        label: "Approve",
        value: EXIT_PLAN_MODE_APPROVAL_APPROVE,
      },
    ],
    question: EXIT_PLAN_MODE_APPROVAL_QUESTION,
  };
}

// [契约] 内部 signal 与 reannounce 间隔必须一起下发，缺一都会让恢复链路失效。
// [失败路径] 丢掉 signal 会让 v4 应答无法取消悬空的反向 RPC。
// [权衡] 按固定 1s 重发现而不是指数退避：等待窗口内需要稳定可预测的登记。
// [边界] 外层 options 其余字段原样透传，不在此过滤。
function withInteractionRequestRecovery(
  options: PermissionBrokerRequestOptions | undefined,
  signal: AbortSignal,
): PermissionBrokerRequestOptions & { reannounceIntervalMs: number } {
  return {
    ...options,
    // v4 竞速：内部 signal 已级联外层 options.signal（见 raceClientRequestWithV4Interaction），
    // v4 应答命中时经它取消悬空的反向 RPC。
    signal,
    // 桌面/恢复链路里 UI 可能只从 snapshot 恢复出 pending 交互，
    // 但 host 里原 protocol id 对应的内存登记已丢失。等待用户响应期间按同一业务
    // requestId 重发现有协议请求，让 host 重新登记可响应的 protocolRequestId。
    reannounceIntervalMs: INTERACTION_REQUEST_REANNOUNCE_INTERVAL_MS,
  };
}

function mapAskUserQuestion(question: AskUserQuestion): ZCodeUserInputQuestion {
  return {
    header: question.header,
    multiSelect: question.multiSelect,
    options: question.options.map((option) => ({
      description: option.description,
      label: option.label,
      preview: option.preview,
      value: option.label,
    })),
    question: question.question,
  };
}

// 把 userInput 应答归一成 broker 结果：accept → modify（合并规范化后的 answers），
// 其他动作 → deny，并区分 cancelled 与 declined 文案。
function userInputResponseToBrokerResult(
  request: PermissionBrokerRequest,
  response: ZCodeUserInputResponse,
): PermissionBrokerResult {
  if (response.action !== "accept") {
    return {
      decision: "deny",
      reason:
        response.reason ??
        (response.action === "cancel"
          ? "AskUserQuestion was cancelled"
          : "AskUserQuestion was declined"),
      resolvedAt: new Date(),
    };
  }

  const input = isRecord(request.input) ? request.input : {};
  const content = normalizeAskUserQuestionResponseContent(input, response.content);
  return {
    decision: "modify",
    modifiedInput: {
      ...input,
      ...content,
    },
    reason: response.reason,
    resolvedAt: new Date(),
  };
}

// 计划审批语义：批准 → allow；自由文本 → deny 且带 plan_approval_feedback，
// 让反馈升级为用户消息；空应答 → 普通 deny。
function planApprovalResponseToBrokerResult(
  response: ZCodeUserInputResponse,
): PermissionBrokerResult {
  if (response.action !== "accept") {
    return {
      decision: "deny",
      reason: response.reason,
      resolvedAt: new Date(),
    };
  }

  const answer = normalizePlanApprovalAnswer(response.content);
  if (answer === EXIT_PLAN_MODE_APPROVAL_APPROVE) {
    return {
      decision: "allow",
      reason: response.reason,
      resolvedAt: new Date(),
    };
  }

  if (!answer) {
    return {
      decision: "deny",
      reason: response.reason,
      resolvedAt: new Date(),
    };
  }

  return {
    decision: "deny",
    reason: answer,
    reasonSource: "plan_approval_feedback",
    resolvedAt: new Date(),
  };
}

function normalizePlanApprovalAnswer(
  content: Record<string, unknown> | undefined,
): string | undefined {
  if (!content) {
    return undefined;
  }
  const answers = isRecord(content.answers) ? content.answers : {};
  const answer = normalizeAnswerValue(
    answers[EXIT_PLAN_MODE_APPROVAL_QUESTION] ?? content.answer_0 ?? content.answer,
  )?.trim();
  return answer && answer.length > 0 ? answer : undefined;
}

// [契约] 只保留 schema 明确允许的 answers 与 annotations 两个字段。
// [失败路径] 把 answer_0 / answer 合并回工具输入会触发 strict schema 校验失败。
// [权衡] strict schema 是刻意选择：放宽会掩盖前端字段漂移。
// [边界] 空 content 返回空对象，不是 undefined。
// [并发] 纯函数，不读写会话状态。
function normalizeAskUserQuestionResponseContent(
  input: Record<string, unknown>,
  content: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!content) {
    return {};
  }

  const normalized: Record<string, unknown> = {};
  const answers = normalizeAskUserQuestionAnswers(input, content);
  if (answers) {
    normalized.answers = answers;
  }

  const annotations = normalizeAskUserQuestionAnnotations(content.annotations);
  if (annotations) {
    normalized.annotations = annotations;
  }

  // UI 为兼容旧单题路径会同时提交 answer_0 / answer。
  // AskUserQuestionInputSchema 是 strict，直接把这些旧字段合并回 tool input 会触发
  // Tool input failed inputSchema validation，所以这里只保留 schema 明确允许的字段。
  return normalized;
}

function normalizeAskUserQuestionAnswers(
  input: Record<string, unknown>,
  content: Record<string, unknown>,
): Record<string, string> | undefined {
  const questionTexts = readAskUserQuestionTexts(input);
  if (questionTexts.length === 0) {
    return undefined;
  }

  const rawAnswers = isRecord(content.answers) ? content.answers : {};
  const answers: Record<string, string> = {};
  questionTexts.forEach((questionText, index) => {
    const rawAnswer =
      rawAnswers[questionText] ??
      content[`answer_${index}`] ??
      (questionTexts.length === 1 ? content.answer : undefined);
    const answer = normalizeAnswerValue(rawAnswer);
    if (answer !== undefined) {
      answers[questionText] = answer;
    }
  });

  // action=accept + content.answers={} 是 runtime 自动继续的显式成功语义；
  // 必须保留空对象，和 content 完全缺失（旧客户端批准但未提供答案）区分。
  // [契约] accept + 空 answers 是「runtime 自动继续」的显式成功语义，必须保留空对象。
  // [失败路径] 返回 undefined 会与「旧客户端批准但没给答案」混为一谈。
  // [权衡] 判空必须在归一化之后，不能用 answers 变量代替原始 content。
  // [边界] 该分支只影响返回值，不触发额外日志。
  if (isRecord(content.answers) && Object.keys(content.answers).length === 0) {
    return {};
  }
  return Object.keys(answers).length > 0 ? answers : undefined;
}

// 生成 v4 交互登记参数；askUserQuestion 额外接上自动继续状态的持久化回调，
// 使倒计时/暂存状态在恢复链路上可重建。
function createInteractionRegistrationOptions(
  request: PermissionBrokerRequest,
  kind: V4InteractionRegistrationOptions["kind"],
  context?: ZCodeProtocolAgentServerContext,
  initialAutoResolution?: V4InteractionRegistrationOptions["initialAutoResolution"],
): V4InteractionRegistrationOptions {
  return {
    sessionId: String(request.sessionId),
    kind,
    ...(initialAutoResolution ? { initialAutoResolution } : {}),
    ...(kind === "askUserQuestion" && context
      ? {
          onAutoResolutionUpdated: async (autoResolution) => {
            const record = context.sessions?.get(String(request.sessionId));
            if (!record) return;
            try {
              await record.app.runtime.recordUserInputAutoResolutionUpdate({
                interactionId: request.requestId,
                toolCallId: request.toolCallId,
                autoResolution,
                traceContext: {
                  ...record.traceContext,
                  traceId: request.traceId,
                  turnId: request.turnId,
                },
              });
            } catch (error) {
              context.logger?.error(
                "Failed to persist user input auto-resolution state",
                error instanceof Error ? error : new Error(String(error)),
                {
                  interactionId: request.requestId,
                  sessionId: request.sessionId,
                },
              );
            }
          },
        }
      : {}),
  };
}

// 从 session entry 恢复最近一次自动继续状态：按 interactionId + toolCallId 精确匹配；
// 读取失败只告警并返回 undefined，不能阻断新的交互请求。
async function readPersistedAutoResolution(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
): Promise<V4InteractionRegistrationOptions["initialAutoResolution"]> {
  const sessionStore = context.deps?.sessionStore;
  if (!sessionStore?.sessionEntries) return undefined;
  try {
    const entries = await sessionStore.sessionEntries({
      sessionID: request.sessionId,
      type: SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
    });
    const matching = entries
      .filter((entry) => {
        const data = isRecord(entry.data) ? entry.data : {};
        return (
          data.interactionId === request.requestId &&
          String(data.toolCallId ?? "") === String(request.toolCallId)
        );
      })
      .sort((left, right) => right.time.updated - left.time.updated)[0];
    if (!matching || !isRecord(matching.data)) return undefined;
    return parsePersistedAutoResolution(matching.data.autoResolution);
  } catch (error) {
    context.logger?.warn("Failed to restore user input auto-resolution state", {
      error: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.user_input_auto_resolution_restore_failed",
      interactionId: request.requestId,
      module: "bootstrap.zcode_protocol",
      sessionId: request.sessionId,
    });
    return undefined;
  }
}

function parsePersistedAutoResolution(
  value: unknown,
): V4InteractionRegistrationOptions["initialAutoResolution"] {
  if (!isRecord(value) || typeof value.startedAt !== "number") return undefined;
  if (
    (value.state === "hiddenGrace" || value.state === "visibleCountdown") &&
    typeof value.visibleAt === "number" &&
    typeof value.deadlineAt === "number"
  ) {
    return {
      state: value.state,
      startedAt: value.startedAt,
      visibleAt: value.visibleAt,
      deadlineAt: value.deadlineAt,
    };
  }
  if (value.state === "snoozed" && typeof value.snoozedAt === "number") {
    return {
      state: "snoozed",
      startedAt: value.startedAt,
      snoozedAt: value.snoozedAt,
    };
  }
  return undefined;
}

function readAskUserQuestionTexts(input: Record<string, unknown>): string[] {
  const questions = input.questions;
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions
    .map((question) =>
      isRecord(question) && typeof question.question === "string" ? question.question : undefined,
    )
    .filter((question): question is string => question !== undefined);
}

function normalizeAnswerValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    // 旧客户端曾用空字符串表示跳过；统一丢弃 blank，避免其进入
    // answers 后被 core 当作用户偏好。非空答案同时在协议边界去除外围空白。
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0)
      .join(", ");
  }
  return undefined;
}

function normalizeAskUserQuestionAnnotations(
  value: unknown,
): Record<string, { preview?: string; notes?: string }> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .map(([question, annotation]) => {
      if (!isRecord(annotation)) {
        return undefined;
      }
      const normalizedAnnotation = {
        ...(typeof annotation.preview === "string" ? { preview: annotation.preview } : {}),
        ...(typeof annotation.notes === "string" ? { notes: annotation.notes } : {}),
      };
      return Object.keys(normalizedAnnotation).length > 0
        ? ([question, normalizedAnnotation] as const)
        : undefined;
    })
    .filter(
      (entry): entry is readonly [string, { preview?: string; notes?: string }] =>
        entry !== undefined,
    );

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
