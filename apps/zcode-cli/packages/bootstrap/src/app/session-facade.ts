/**
 * session-facade：把 Session 存储、Provider Registry 视图、MCP/execution 端口与 AgentRuntime
 * 组装成 ZCodeApp 的会话读写面（模式/模型/思考档位/目标/checkpoint/MCP 资源与 App 工具）。
 * 资源所有权：只有 ownsSessionStore / ownsMcpPort / ownsExecutionPort 为 true 的对象才在 close 时释放；
 *   注入端口归调用方（Host）所有。close 幂等（closePromise 缓存），重复调用不会二次释放。
 * 关闭顺序（不可颠倒）：beginShutdown → drain 在飞 Memory Extraction → 停本会话 dwf run（此时仍可写
 *   journal）→ 并行关闭 browser/execution/mcp/node_repl（各自带 deadline）→ 最后关 session store。
 * 失败语义：任一资源关闭失败或超时只记 warn 并继续；绝不让一个卡住的 owner 阻塞其它资源释放。
 * 模型口径：读写都基于 Registry 视图；saveSessionEntry 持久化的是"已生效选择"，不是执行绑定。
 */
// session-facade（bootstrap/app）深注：只写看起来该改、其实不能改的约束，不重复类型声明。
// 做：把 SessionStore、Provider Registry 视图、MCP/execution 端口与 AgentRuntime 组装成 ZCodeApp 的会话读写面。
// 不做：不构造 store、不打开连接、不做恢复、不复制运行时状态；本文件只有薄适配与少量会话内缓存。
// 依赖：CreateSessionFacadeDeps 全量注入；三个 owns* 布尔是资源所有权的唯一判据，不是优化开关。
// 边界：状态真相分别在 runtime（已生效选择/工具注册表）、sessionStore（target/todos/entry）、providerRegistry（可选模型）。
// 边界：跨进程可见副作用统一走 runtime 事件出口；本文件不直接写协议帧、不直接落盘日志文件。
//
// INV-01 断言：close 只释放 owns* 为 true 的资源 —— 守住它的位置：close 构造 closeSessionResources 入参处 —— 改错故障：共享 store 或注入端口被关，其它 App 立即读写失败。
// INV-02 断言：closePromise 是唯一幂等闸门且最早建立 —— 守住它的位置：close 首行 —— 改错故障：并发 close 重入释放链，端口被二次关闭。
// INV-03 断言：beginShutdown 在任何 await 之前同步执行 —— 守住它的位置：关闭链第一拍 —— 改错故障：关闭窗口内仍有新调度，模型被唤醒到正在关闭的会话。
// INV-04 断言：停 dwf run 夹在 beginShutdown 之后、资源关闭之前 —— 守住它的位置：close 中段 —— 改错故障：终态通知叫醒会话，或 journal 已关无法写 stopped。
// INV-05 断言：dwf 关闭失败只 warn 不中断 —— 守住它的位置：该 try/catch —— 改错故障：一个卡住的引擎吃掉后续所有资源释放。
// INV-06 断言：session store 必须最后关 —— 守住它的位置：closeSessionResources 尾部 —— 改错故障：其它资源写审计日志时落点已消失。
// INV-07 断言：四个资源并行关闭且各自带 deadline —— 守住它的位置：Promise.all 与 race —— 改错故障：Browser 永不 settle 时 Execution/MCP 永不释放。
// INV-08 断言：closeSessionResources 永不向调用方抛错 —— 守住它的位置：三态收敛日志处 —— 改错故障：调用方误判关闭失败并跳过自身清理。
// INV-09 断言：模型选择只有一个事实源 —— 守住它的位置：readUserModelSelection —— 改错故障：两条写通道同时生效，冷恢复读到旧值。
// INV-10 断言：transient 切换只改 runtime、不落盘、不发通知 —— 守住它的位置：setModel 的两个 if —— 改错故障：应用/还原各刷一条聊天通知，且保存意图被污染。
// INV-11 断言：持久化的是已生效选择而非 workspace 默认 —— 守住它的位置：persistSessionModelSelection —— 改错故障：临时切换写进全局默认，影响其它会话。
// INV-12 断言：saveSessionEntry 必须 touchSession=false —— 守住它的位置：entry 字面量 —— 改错故障：配置补写刷新最近活跃时间，任务排序漂移。
// INV-13 断言：持久化失败只 warn、不回滚 runtime —— 守住它的位置：persist 的 catch —— 改错故障：已生效切换被报成失败，用户重试产生双写。
// INV-14 断言：setTarget 必须在首次持久化前走统一执行边界 —— 守住它的位置：setTargetStatus 头部 —— 改错故障：bash_shell_selection 缺失，冷恢复退回 legacy fallback。
// INV-15 断言：cleared 即使 store 原本为空也要投影 target:null —— 守住它的位置：cleared 分支 —— 改错故障：重连客户端继续显示旧目标面板。
// INV-16 断言：target 存 canonical objective，可见消息存 display text —— 守住它的位置：recordExternalUserPrompt —— 改错故障：/goal 原文丢失，首轮实时列表为空。
// INV-17 断言：读 target 前先补中断 run 收口 —— 守住它的位置：readTargetWithInterruptedRunRecovery —— 改错故障：离线时长被算进 goal 运行时长且永久偏大。
// INV-18 断言：owned=false 时不提供档位、不伪装默认值 —— 守住它的位置：currentRegistrySelection 消费点 —— 改错故障：默认档位被当成用户选择写回。
// INV-19 断言：MCP App 工具审批后必须复核连接 identity 与 generation —— 守住它的位置：callMcpToolForUi —— 改错故障：批准被复用到替换后的连接上。
// INV-20 断言：App 提供工具替换是先全量注销再逐条注册，且不覆盖既有工具 —— 守住它的位置：replaceMcpAppProvidedTools —— 改错故障：旧工具残留或内置工具被同名覆盖。
//
// 阅读顺序：先看 INV 判断能不能动，再看正文 [契约]/[并发]/[事务]/[资源]/[失败路径]/[权衡] 标记。
// 这些 INV 来自真实回归：每一条都对应过一次可复现的静默故障，不是通用最佳实践。
// 改动前自检：是否引入第二份模型选择事实源？是否让某个 owner 的释放变成条件执行？
// 改动前自检：是否把已生效选择和保存意图合并成一次写？是否让 transient 切换产生持久化？
// 改动前自检：是否把失败路径改成抛出，从而让 close 或持久化失败反向否定已生效状态？
// 失败语义：只有 close 与持久化吞错并 warn；命令类成员（setModel/setTarget/setLocale）一律上抛。
// 可观测性：所有 warn 都带 event 字段；缺 event 的日志在排障时无法被聚合查询命中。
// 权衡：刻意保留重复的 MCP 能力检查，换取每个入口独立可读、错误文案稳定。
// 权衡：关闭链拆成准入阻断、并行资源、store 最后三段，比单条串行链长，但不会互相拖死。
// 结束：以下正文按代码顺序给出，锚点均落在语句之间，不进入表达式内部。
import { updateUiLocaleInFileConfig, type ConfigResult } from "@zcode/adapters/config";
import {
  McpResourceSubscribeUnsupportedError,
  resolveMcpToolVisibility,
  SESSION_ENTRY_MODEL_SELECTION,
  traceContextToLogContext,
  type CollaborationMode,
  type ExecutionPort,
  type GoalStatus,
  type LocalSettingStorePort,
  type Logger,
  type LoggerFactory,
  type McpPort,
  type McpServerConfig,
  type MessageId,
  type ProjectId,
  type SessionId,
  type SessionStorePort,
  type SupportedLocale,
  type TraceContext,
  type TurnInputIntentMetadata,
  type UiLocale,
  type UiThemePreference,
} from "@zcode/contracts";
import {
  createMcpAppProvidedToolEntry,
  createMcpToolEntry,
  toMcpToolName,
  type AgentRuntime,
} from "@zcode/core";
import { resolveLocale } from "@zcode/i18n";
import { normalizeModelSelection, type ModelSelection } from "@zcode/provider";
import { listMcpServerStatuses } from "../mcp-config.js";
import { loadSessionTranscriptFromStore } from "../session-transcript.js";
import { getLocaleConfigPath } from "./locale-selection.js";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";
import {
  completeAuxiliaryRegistryModelSelection,
  getRegistryBackedModel,
  listRegistryBackedModels,
  requireRegistryThoughtLevel,
  resolveRegistryModelSelection,
  resolveRegistryOwnedModelSelection,
  resolveRegistryOwnedSelection,
  resolveRegistryThoughtLevel,
  type ResolvedRegistrySelection,
} from "./provider-registry-selection.js";
import { isClosableSessionStore } from "./session-store.js";
import { createSubagentObservation } from "./subagent-observation.js";
import type { PrepareUserExecutionBoundary, ZCodeApp } from "./types.js";
import type { CliDefaultSelection } from "./cli-default-selection.js";

type SessionFacade = Pick<
  ZCodeApp,
  | "readBackgroundBashOutput"
  | "cancelBackgroundTask"
  | "clearTarget"
  | "close"
  | "callMcpToolForUi"
  | "getMcpAppConnectionSnapshot"
  | "waitForMcpAppConnection"
  | "onMcpAppConnectionInvalidated"
  | "replaceMcpAppProvidedTools"
  | "connectMcpServer"
  | "disconnectMcpServer"
  | "generateWorkspaceText"
  | "sampleModel"
  | "testModelConnectivity"
  | "forkFromCheckpoint"
  | "getMode"
  | "getModel"
  | "getCurrentModelOption"
  | "getModelOption"
  | "getLocale"
  | "getDefaultThoughtLevel"
  | "getThoughtLevel"
  | "getTheme"
  | "listCheckpoints"
  | "listMcpServers"
  | "getMcpToolVisibility"
  | "listModels"
  | "listThoughtLevels"
  | "loadSessionTranscript"
  | "readMcpResource"
  | "readMcpResourceForUi"
  | "listMcpResourcesForUi"
  | "listMcpResourceTemplatesForUi"
  | "subscribeMcpResourceForUi"
  | "unsubscribeMcpResourceForUi"
  | "unsubscribeMcpResourcesForUi"
  | "readSubagents"
  | "readSubagentTranscript"
  | "readTodos"
  | "readTarget"
  | "setCustomSessionTitle"
  | "setMode"
  | "setModel"
  | "setThoughtLevel"
  | "setLocale"
  | "setTarget"
  | "updateTargetStatus"
>;

const DEFAULT_SESSION_RESOURCE_CLOSE_TIMEOUT_MS = 6_000;

/**
 * 关闭输入：每个 close* 成员都是可选的 owner，undefined 表示该资源不属于本 App 或未创建。
 * beginShutdown 只做准入阻断（失败也只 warn），不承担资源释放；timeoutMs 缺省用 6s。
 */
interface SessionResourceCloseInput {
  beginShutdown: () => void;
  closeBrowserSession: () => Promise<void>;
  closeExecution?: () => Promise<void> | void;
  closeMcp?: () => Promise<void> | void;
  closeNodeReplBrowserBroker?: () => Promise<void> | void;
  closeSessionStore?: () => void;
  logger: Logger;
  timeoutMs?: number;
}

/**
 * 门面依赖：runtime 与 sessionStore 是必需的事实源；三个 owns* 决定关闭时的所有权。
 * configuredMcpServers 是启动时可见的 server 集合（已含内建与信任裁剪），untrustedProjectMcpServers
 * 只参与状态投影与自动连接裁剪，不代表"不可见"。cliDefaultSelection 在场时模型读写走"保存意图"通道。
 */
interface CreateSessionFacadeDeps {
  cliDefaultSelection?: CliDefaultSelection;
  /**
   * 停下本会话拥有的 dwf run：
   * run service 的 `close()`。缺席即本装配没有 dwf 端口（journal 窄化失败、测试装配）。
   */
  closeDynamicWorkflowRuns?: () => Promise<void>;
  closeNodeReplBrowserBroker?: () => Promise<void> | undefined;
  configResult: ConfigResult;
  configuredMcpServers: Record<string, McpServerConfig>;
  configuredDefaultModelSelection?: ModelSelection;
  executionPort: ExecutionPort;
  localSettingStore?: LocalSettingStorePort;
  logger: Logger;
  loggerFactory: LoggerFactory;
  mcpPort?: McpPort;
  ownsExecutionPort: boolean;
  ownsMcpPort: boolean;
  ownsSessionStore: boolean;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  prepareResume(traceContext?: TraceContext): Promise<void>;
  projectID: ProjectId;
  providerRegistry: ProviderRegistryModelSource;
  resolveUiLocale(locale: UiLocale): SupportedLocale;
  runtime: AgentRuntime;
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  traceContext: TraceContext;
  untrustedProjectMcpServers: Set<string>;
  workingDirectory: string;
}

/**
 * 构造会话门面。同步建对象、惰性做副作用：不打开连接、不做恢复，只缓存引用与少量会话内状态
 * （currentLocale、appProvidedToolNames、closePromise）。
 * 输入：见 CreateSessionFacadeDeps；所有端口与 store 均已由 create-app 装配完成。
 * 输出：Pick<ZCodeApp, ...> 的会话面；成员多为 runtime/store 的薄适配，不复制状态。
 * 失败语义：多数成员把端口缺失转成稳定错误（如 "MCP is disabled"），`/goal` 与模型切换失败则上抛；
 *   关闭失败被吞成 warn（见 closeSessionResources）。
 * 不变量：模型选择只有一个事实源（cliDefaultSelection 或 runtime），二者不会同时被写。
 */
export function createSessionFacade(deps: CreateSessionFacadeDeps): SessionFacade {
  // [并发] closePromise 是 close 的幂等闸门：并发 close 只允许第一拍真正释放资源，后来者 await 同一 promise。
  // 不要在闸门内再加一个是否已关闭的布尔：布尔与 promise 之间会出现可观测的中间态。
  // 闸门必须在 beginShutdown 之前建立：否则第二次 close 会在第一拍完成前重入释放链。
  let closePromise: Promise<void> | undefined;
  let currentLocale = resolveLocale(deps.configResult.config.ui.locale);
  // [事务] appProvidedToolNames 保存上一次整体替换真正登记成功的名字，是注销的唯一依据。
  // 不能用 definitions 反推：冲突被跳过或 register 抛错时，反推会注销掉不属于本会话的工具。
  // 替换是两步：先全量注销旧集合，再逐条注册；两步之间不持有注册表快照。
  // App-Provided Tools：本会话当前登记在 ToolRegistry 里的模型侧名字（整体替换时先注销）。
  let appProvidedToolNames: string[] = [];
  // owned=false 表示当前选择不属于任何可见 provider（Registry 尚未就绪/账号权益未解析）：
  // 此时不提供档位列表，也不拿默认档位伪装成用户选择。
  // [契约] owned=false 的语义是选择不可归因到任何可见 provider，不是读取失败。
  // 这条分支决定档位列表与默认是否暴露；把 owned=false 当异常抛出会打断只读 UI。
  // resolved 缺失但仍 owned=true 表示模型存在、档位未解析：仍要暴露模型，只是不给档位列表。
  // 不要把 getProvider 与 resolveRegistryModelSelection 合并：前者判定归属，后者解析绑定。
  const currentRegistrySelection = ():
    | { owned: false }
    | {
        owned: true;
        registry: ProviderRegistryModelSource;
        selection?: ResolvedRegistrySelection;
      } => {
    const registry = deps.providerRegistry;
    const selection = readUserModelSelection(deps);
    if (!selection) return { owned: false };
    const { providerId } = selection;
    if (!registry.getProvider(providerId)) return { owned: false };
    const resolved = resolveRegistryModelSelection(registry, selection);
    return resolved ? { owned: true, registry, selection: resolved } : { owned: true, registry };
  };

  // 读 target 前先补一次中断 run 收口：没有活动轮却残留 activeRunStartedAtMs，说明上次进程退出
  // 没来得及结算；交给 store 用 last_seen 收口，避免把离线时间算进 goal 运行时长。
  // [事务] 收口只在三条同时成立时执行：没有活动轮、存在 activeRunStartedAtMs、store 支持恢复。
  // 不能用当前时间结算：离线时长会被算进 goal 运行时长，冷启动后统计永久偏大。
  // recoverInterruptedTargetRun 会写 store，因此必须先读 target 再判定，不能先写后读。
  // store 未实现恢复能力时宁可返回原 target，也不允许门面层自行改状态。
  const readTargetWithInterruptedRunRecovery = async () => {
    const target = await deps.sessionStore.readTarget({
      sessionID: deps.sessionId,
    });
    if (
      !deps.runtime.getActiveTurnInfo() &&
      target?.activeInputId &&
      target.activeRunStartedAtMs != null &&
      deps.sessionStore.recoverInterruptedTargetRun
    ) {
      // 上次 app/agent 退出可能留下未清空的 active_run_started_at。
      // 这里不能用当前时间结算，否则离线时间会被算进 goal 运行时长；store 会用 last_seen 收口。
      return await deps.sessionStore.recoverInterruptedTargetRun({
        sessionID: deps.sessionId,
      });
    }
    return target;
  };

  /**
   * /goal 的 set / status_updated / cleared 三态统一入口。
   * 顺序不可换：先走统一用户执行边界（保证 shell selection 在首次持久化前落定）→ 持久化会话 →
   *   读旧 target → 写新 target → 记录可见用户输入与状态提醒 → 投影 target 变更。
   * 副作用：写 session store 与 runtime 事件（外部可见）；cleared 即使 store 本来就是空也投影 target:null，
   *   否则重连的客户端会继续显示旧目标。
   * 失败语义：任一步抛错即上抛，不做补偿；各 store 写入是单条记录级原子操作。
   */
  // [事务] 三态共用一条顺序：执行边界、持久化会话、读旧 target、写新 target、提醒、投影。
  // prepareUserExecutionBoundary 必须在第一次持久化之前：bash_shell_selection 依赖此时 selection 已落定。
  // previousTarget 必须在写新 target 之前读取：写后读会把 from 与 to 都读成新值。
  // 提醒与投影都发生在写成功之后：写失败时不能先广播一条假的 target 变更。
  // 本函数不吞错：任一步抛错直接上抛，不做补偿写，也不返回半成品。
  const setTargetStatus = async (
    action: "cleared" | "set" | "status_updated",
    input: {
      objective?: string;
      displayText?: string;
      status?: GoalStatus;
      tokenBudget?: number | null;
      intent?: TurnInputIntentMetadata;
    },
  ) => {
    // [契约] visibleObjective 只对 set 求值：status_updated 与 cleared 不得偷偷改写 objective。
    // displayText 优先、objective 兜底：前者是用户原话，后者是规范化后的目标文本。
    // 两者都要 trim：空串与纯空白在协议层语义不同，落库前必须归一。
    const visibleObjective = action === "set" ? (input.objective ?? "").trim() : undefined;
    const visibleGoalQuery =
      action === "set" ? input.displayText?.trim() || visibleObjective : undefined;
    // /goal 不走普通 prompt 提交流程，但它会先把 session 持久化。
    // 必须在首次持久化前走统一用户执行边界，否则 runtime/bash_shell_selection
    // 会因为当时 selection 为空而缺失，冷恢复时退回 legacy shell fallback。
    // [契约] /goal 绕过普通 prompt 提交流程，但它仍是用户输入，必须先过统一执行边界。
    // 顺序一旦挪到持久化之后，runtime/bash_shell_selection 会因 selection 为空而缺失。
    // 缺 selection 的后果不是报错而是静默回退 legacy shell：冷恢复时表现为解释器被换掉。
    await deps.prepareUserExecutionBoundary({
      traceContext: deps.traceContext,
    });
    await deps.runtime.ensureSessionPersistedForExternalActivity(
      visibleObjective ?? `/goal ${input.status ?? "clear"}`,
      { traceContext: deps.traceContext },
    );
    const previousTarget = await deps.sessionStore.readTarget({
      sessionID: deps.sessionId,
    });
    const target =
      action === "set"
        ? await deps.sessionStore.setTarget({
            objective: visibleObjective ?? "",
            sessionID: deps.sessionId,
            status: input.status,
            tokenBudget: input.tokenBudget,
          })
        : action === "status_updated"
          ? await deps.sessionStore.updateTargetStatus({
              sessionID: deps.sessionId,
              status: input.status ?? "active",
            })
          : null;

    // [失败路径] cleared 分支即使 store 本来为空也要投影 target:null，否则重连客户端保留旧目标面板。
    // cleared 的返回值是 store 的布尔结果，不是是否发生变更；不要用它决定是否投影。
    // 该分支提前 return：不要落入下面的 target 判空逻辑，避免二次写提醒。
    if (action === "cleared") {
      const cleared = await deps.sessionStore.clearTarget({
        sessionID: deps.sessionId,
      });
      if (cleared) {
        await deps.runtime.recordGoalStateChangeReminder({
          text: goalStateChangeReminderText("cleared"),
          traceContext: deps.traceContext,
        });
      }
      // TUI 和协议客户端可能在重连或恢复后仍缓存旧 goal。
      // 即使 session store 已经是空，也要把显式 clear 投影成 target:null，
      // 让客户端不能只因为“No goal to clear.”这条文本而继续保留旧面板。
      await deps.runtime.recordTargetChanged({
        action,
        previousTarget,
        source: "command",
        target,
        traceContext: deps.traceContext,
      });
      return cleared;
    }
    // [契约] target 为空表示写操作没有产生记录，例如 status_updated 命中了不存在目标。
    // 此时不记录用户输入、不发提醒、不投影：缺少 targetID 的输入会污染 goal 关联。
    // 不要为看起来应该有一条目标而补造 target：store 是唯一事实源。
    if (target) {
      if (visibleObjective !== undefined) {
        // /goal 同时是控制命令和用户 query。旧路径只把解析后的 objective
        // 落库，且 live 事件里没有这条输入；因此首轮实时列表为空，冷恢复后也丢失
        // `/goal` / `/target` / `replace` 原文。target 继续存 canonical objective，
        // 可见消息单独保留协议层传入的原始 display text。
        await deps.runtime.recordExternalUserPrompt(visibleGoalQuery ?? visibleObjective, {
          goalSummaryTargetID: target.targetID,
          intent: input.intent,
          traceContext: deps.traceContext,
        });
      }
      // [契约] paused/resumed 由前后状态差推导，不看本次入参单独判断。
      // 同一状态重复提交不产生提醒：否则每次刷新状态都会刷一条系统消息。
      // 提醒文本与 target 投影是两条独立出口，不能只为发提醒而推迟投影。
      const reminderAction =
        input.status === "paused" && previousTarget?.status !== "paused"
          ? "paused"
          : input.status === "active" && previousTarget?.status === "paused"
            ? "resumed"
            : undefined;
      const reminderText = goalStateChangeReminderText(reminderAction);
      if (reminderText) {
        await deps.runtime.recordGoalStateChangeReminder({
          text: reminderText,
          traceContext: deps.traceContext,
        });
      }
      await deps.runtime.recordTargetChanged({
        action,
        previousTarget,
        source: "command",
        target,
        traceContext: deps.traceContext,
      });
    }
    return target;
  };

  return {
    // [并发] close 是唯一允许重复调用的成员；其余写成员都不具备幂等语义。
    // 返回 Promise 而不是 void：调用方需要等到资源真正释放后再退出进程。
    // 不要在 close 外层再加锁：闸门本身就是单飞，外层锁会引入死锁风险。
    close: async () => {
      // 幂等闸门：并发或重复 close 共享同一个 promise，资源释放只发生一次；后来者等待同一结果。
      closePromise ??= (async () => {
        // 关闭入口先阻止新调度并取消在飞 Memory Extraction，再等待取消链路收口。
        // [并发] beginShutdown 必须在任何 await 之前同步执行，它是关闭期的准入闸门。
        // 放进异步链之后，关闭窗口内仍可能接受新调度，模型会被唤醒到正在关闭的会话。
        // 它只做准入阻断，不承担资源释放；失败也只 warn，不能中断后续释放。
        deps.runtime.beginShutdown();
        await deps.runtime.drainMemoryExtractions(60_000);
        // 引擎归本 App 所有，所以关闭要主动停下它。
        // 位置是两个约束夹出来的：在 beginShutdown **之后**，结算带出的终态通知才会被丢掉
        // （background-notifications.ts 在 shuttingDown 时不入队），不会把正在关闭的会话的模型
        // 叫醒；在 closeSessionResources **之前**，子代理还有 execution / MCP / session store
        // 可以干净地中止，引擎也还有 journal 可以写自己那一笔 stopped(interrupted)。
        // [资源] dwf 引擎归本 App 所有，必须主动停；它不在 owns* 体系里，缺失即表示没有该端口。
        // 位置由两个约束夹出：beginShutdown 之后终态通知会被丢弃，资源关闭之前 journal 仍可写。
        // 关闭失败只 warn：卡住的引擎不能吃掉 browser/execution/mcp/store 的释放机会。
        // 最坏结果是留下一条孤儿 run 行，由下一次构造时收敛，而不是让进程无法退出。
        if (deps.closeDynamicWorkflowRuns !== undefined) {
          try {
            await deps.closeDynamicWorkflowRuns();
          } catch (error: unknown) {
            // 卡住或抛错的 dwf 关闭绝不能吃掉资源关闭（同下面并行关闭那条注释的论证）：
            // 记一条 warn 继续走，最坏情况是那个 run 留成孤儿行，下一次构造时被收敛。
            deps.logger.warn?.(
              "Closing dynamic workflow runs failed; continuing to close resources",
              {
                errorMessage: error instanceof Error ? error.message : String(error),
                event: "dynamic_workflow.service.close_failed",
                module: "bootstrap.app",
              },
            );
          }
        }
        // store 只在"本 App 拥有 + 真的实现了 close"时才关闭：共享 store 被关会让其它 App 的读写失效。
        // [资源] 共享 store 关闭会让其它 App 读写立即失效，因此必须同时满足拥有与实现了 close。
        // isClosableSessionStore 是能力判定，不是所有权判定；两者缺一都不能关。
        // 不要为了确保清理而无条件 close：那等于偷走注入方的资源生命周期。
        const closableSessionStore =
          deps.ownsSessionStore && isClosableSessionStore(deps.sessionStore)
            ? deps.sessionStore
            : undefined;
        // [资源] 传入的是闭包而不是已解析端口：能力缺失时传 undefined，让关闭链跳过该项。
        // ownsExecutionPort 与 ownsMcpPort 分别判定，不能合并成一个外部资源开关。
        // closeNodeReplBrowserBroker 由 Host 决定，本文件只透传，不判断归属。
        await closeSessionResources({
          beginShutdown: () => deps.runtime.beginShutdown(),
          closeBrowserSession: () => deps.runtime.closeBrowserSession(),
          closeExecution:
            deps.ownsExecutionPort && deps.executionPort.close
              ? () => deps.executionPort.close?.()
              : undefined,
          closeMcp: deps.ownsMcpPort && deps.mcpPort ? () => deps.mcpPort?.close() : undefined,
          closeNodeReplBrowserBroker: deps.closeNodeReplBrowserBroker,
          closeSessionStore: closableSessionStore ? () => closableSessionStore.close() : undefined,
          logger: deps.logger,
        });
      })();
      return await closePromise;
    },
    getMode: () => deps.runtime.getMode(),
    getModel: () => formatLegacyRuntimeModelValue(readUserModelSelection(deps)),
    getLocale: () => currentLocale,
    getTheme: () => deps.configResult.config.ui.theme as UiThemePreference,
    // [契约] 默认档位是模型建议值，不是用户选择；它不能写回会话选择。
    // Registry 未就绪时退回读取已保存 options：此时没有可解析默认值，不能编造。
    // owned=false 时不返回任何档位：UI 应显示未选择，而不是看似生效的值。
    getDefaultThoughtLevel: () => {
      const registryState = currentRegistrySelection();
      return registryState.owned
        ? resolveRegistryThoughtLevel(registryState.selection)
        : readUserModelSelection(deps)?.options?.reasoningLevel;
    },
    // 当前档位只读会话事实；缺失时不能借默认档位伪装成已完成选择。
    getThoughtLevel: () => readUserModelSelection(deps)?.options?.reasoningLevel,
    // [契约] transcript 只读 store，不触发恢复流程；恢复由 prepareResume 的调用点负责。
    // 不要在这里补写 session entry：读路径的副作用会让冷启动顺序变得不可预测。
    loadSessionTranscript: async () =>
      await loadSessionTranscriptFromStore({
        sessionId: deps.sessionId,
        sessionStore: deps.sessionStore,
      }),
    ...createSubagentObservation(deps),
    readTodos: async () => deps.sessionStore.readTodos({ sessionID: deps.sessionId }),
    // [契约] readTarget 直接复用带收口的实现，不要在对象字面量里再包一层异步箭头。
    // 多包一层会吞掉 traceContext 与错误类型，并让 store 的恢复能力判定变得不可见。
    // 该成员是只读入口，不得顺带写 target 或刷新 session 活跃时间。
    readTarget: readTargetWithInterruptedRunRecovery,
    setCustomSessionTitle: async (input) =>
      deps.runtime.setCustomSessionTitle({
        title: input.title,
        traceContext: input.traceContext ?? deps.traceContext,
      }),
    setTarget: async (input) =>
      (await setTargetStatus("set", input)) as Awaited<ReturnType<ZCodeApp["setTarget"]>>,
    updateTargetStatus: async (status) =>
      (await setTargetStatus("status_updated", { status })) as Awaited<
        ReturnType<ZCodeApp["updateTargetStatus"]>
      >,
    clearTarget: async () => (await setTargetStatus("cleared", {})) as boolean,
    // [契约] 模型列表完全来自 Registry 视图，本文件不做过滤、排序或补全。
    // 不要在门面层缓存列表：Registry 可在会话期间刷新，缓存会让 UI 看到过期模型。
    // 失败时返回空数组是 Registry 视图既有语义，不要在此改成上抛。
    listModels: () => {
      return listRegistryBackedModels(deps.providerRegistry);
    },
    getCurrentModelOption: () => {
      const selection = readUserModelSelection(deps);
      return selection && getRegistryBackedModel(deps.providerRegistry, selection);
    },
    getModelOption: (selection) => getRegistryBackedModel(deps.providerRegistry, selection),
    listThoughtLevels: () => {
      const registryState = currentRegistrySelection();
      return registryState.owned
        ? [...(registryState.selection?.model.config.optionSpecs.reasoningLevel.values ?? [])]
        : [];
    },
    listMcpServers: async () =>
      listMcpServerStatuses(
        deps.mcpPort,
        deps.configuredMcpServers,
        deps.untrustedProjectMcpServers,
      ),
    // [失败路径] 未配置与端口缺失是两种不同失败：文案分别指向配置和运行时能力，不能合并。
    // 连接使用 configuredMcpServers 的快照，不重新读配置：会话期间配置变更不应悄悄生效。
    // workingDirectory 必传：远端 MCP server 的 cwd 会影响其相对路径解析。
    connectMcpServer: async (name) => {
      const config = deps.configuredMcpServers[name];
      if (!config) {
        throw new Error(`MCP server is not configured: ${name}`);
      }
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      return deps.mcpPort.connectServer(name, config, {
        trace: deps.traceContext,
        workingDirectory: deps.workingDirectory,
      });
    },
    readMcpResource: async (serverName, uri, options) => {
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      if (!deps.mcpPort.readResource) {
        throw new Error("MCP resources are not supported by this runtime");
      }
      return deps.mcpPort.readResource(
        { serverName, uri, trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    readMcpResourceForUi: async (serverName, uri, options) => {
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      if (!deps.mcpPort.readResource) {
        throw new Error("MCP resources are not supported by this runtime");
      }
      return deps.mcpPort.readResource(
        { serverName, uri, trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    listMcpResourcesForUi: async (serverName, cursor, options) => {
      if (!deps.mcpPort) throw new Error("MCP is disabled");
      if (!deps.mcpPort.listResources) {
        throw new McpResourceSubscribeUnsupportedError(serverName);
      }
      return deps.mcpPort.listResources(
        { serverName, ...(cursor ? { cursor } : {}), trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    listMcpResourceTemplatesForUi: async (serverName, cursor, options) => {
      if (!deps.mcpPort) throw new Error("MCP is disabled");
      if (!deps.mcpPort.listResourceTemplates) {
        throw new McpResourceSubscribeUnsupportedError(serverName);
      }
      return deps.mcpPort.listResourceTemplates(
        { serverName, ...(cursor ? { cursor } : {}), trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    subscribeMcpResourceForUi: async (serverName, uri, subscriberKey, options) => {
      if (!deps.mcpPort) throw new Error("MCP is disabled");
      if (!deps.mcpPort.subscribeResource) {
        throw new McpResourceSubscribeUnsupportedError(serverName);
      }
      await deps.mcpPort.subscribeResource(
        { serverName, uri, subscriberKey, trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    unsubscribeMcpResourceForUi: async (serverName, uri, subscriberKey, options) => {
      if (!deps.mcpPort?.unsubscribeResource) return;
      await deps.mcpPort.unsubscribeResource(
        { serverName, uri, subscriberKey, trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    unsubscribeMcpResourcesForUi: async (subscriberKeyPrefix) => {
      if (!deps.mcpPort?.unsubscribeResourcesBySubscriber) return 0;
      return deps.mcpPort.unsubscribeResourcesBySubscriber(subscriberKeyPrefix);
    },
    onMcpAppConnectionInvalidated: (name, listener) =>
      deps.mcpPort?.onAppConnectionInvalidated?.(name, listener) ?? (() => {}),
    getMcpAppConnectionSnapshot: (name) => deps.mcpPort?.appConnectionSnapshot?.(name) ?? null,
    waitForMcpAppConnection: async (name) =>
      deps.mcpPort?.waitForAppConnection
        ? deps.mcpPort.waitForAppConnection(name)
        : (deps.mcpPort?.appConnectionSnapshot?.(name) ?? null),
    // [事务] 顺序不可换：取快照、找 descriptor、校验 app 可见性、审批、复核连接、调用。
    // descriptor 必须来自 listTools 的实时结果：缓存副本会让可见性判断落后于 server 声明。
    // 审批期间连接可能被替换，批准只属于原连接，执行前必须比对 identity 与 generation。
    // registry 中已有同名工具时复用它，避免同一次调用出现两套 metadata。
    callMcpToolForUi: async (serverName, toolName, args, options) => {
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      const snapshot = deps.mcpPort.appConnectionSnapshot?.(serverName);
      if (!snapshot) throw new Error("MCP App connection is unavailable");
      const descriptor = (await deps.mcpPort.listTools()).find(
        (tool) => tool.serverName === serverName && tool.toolName === toolName,
      );
      if (!descriptor || !resolveMcpToolVisibility(descriptor).includes("app"))
        throw new Error("Tool is not available to this App");
      const registry = deps.runtime.getToolRegistry();
      const registered = registry
        .list()
        .map((name) => registry.get(name))
        .find(
          (entry) =>
            entry?.metadata.mcpPresentation?.serverName === serverName &&
            entry.metadata.mcpPresentation.toolName === toolName,
        );
      const entry =
        registered ??
        createMcpToolEntry(toMcpToolName(descriptor), descriptor, deps.mcpPort, false);
      const executor = deps.runtime.getToolExecutor();
      if (!executor.authorizeAppTool) throw new Error("MCP App host authorization is unavailable");
      const input = await executor.authorizeAppTool(
        { id: crypto.randomUUID(), name: entry.metadata.name, input: args ?? {} },
        entry,
        { signal: options?.signal, traceContext: deps.traceContext },
      );
      // 审批期间连接可能被替换：批准只属于原连接，执行前必须再次验证。
      options?.signal?.throwIfAborted();
      const current = deps.mcpPort.appConnectionSnapshot?.(serverName);
      if (
        !current ||
        current.identity !== snapshot.identity ||
        current.generation !== snapshot.generation
      )
        throw new Error("MCP App connection changed during authorization");
      return deps.mcpPort.callTool(
        {
          serverName,
          toolName,
          arguments: input as Record<string, unknown>,
          trace: deps.traceContext,
          runtimeScope: "main",
        },
        { signal: options?.signal, appConnection: snapshot },
      );
    },
    // [事务] 先注销上一批、再注册新一批：反过来会让同名工具在注册阶段被判为冲突而丢失。
    // 不覆盖内置或 MCP 工具：app__ 前缀只是约定，冲突时以既有工具为准。
    // registry.has 与 registered 同时检查：前者防内置冲突，后者防本次 definitions 内部重名。
    // 结束后整体替换 appProvidedToolNames，并在同一拍失效工具缓存。
    replaceMcpAppProvidedTools: (definitions, execute) => {
      const registry = deps.runtime.getToolRegistry();
      for (const name of appProvidedToolNames) registry.unregister(name);
      const registered: string[] = [];
      for (const definition of definitions) {
        // 不覆盖内置 / MCP 工具：`app__` 前缀本不该冲突，冲突时以既有工具为准。
        if (registry.has(definition.modelName) || registered.includes(definition.modelName))
          continue;
        registry.register(createMcpAppProvidedToolEntry(definition, execute), {
          silentDuplicateWarning: true,
        });
        registered.push(definition.modelName);
      }
      appProvidedToolNames = registered;
      // 同回合下一次模型请求即可见：只是让 getTools 重建缓存；工具集合没变时发给模型的内容也不变。
      deps.runtime.invalidateToolCache();
      return registered;
    },
    getMcpToolVisibility: async (serverName, toolName) => {
      if (!deps.mcpPort) return null;
      // 真相是 adapter 归一化过的 descriptor（同一份 tools/list），不另存副本。
      const descriptor = (await deps.mcpPort.listTools()).find(
        (tool) => tool.serverName === serverName && tool.toolName === toolName,
      );
      return descriptor ? resolveMcpToolVisibility(descriptor) : null;
    },
    readBackgroundBashOutput: (workId, sessionId) =>
      deps.runtime.readBackgroundBashOutput(workId, sessionId),
    cancelBackgroundTask: async (taskId, options) =>
      deps.runtime.cancelBackgroundTask(taskId, {
        traceContext: options?.traceContext ?? deps.traceContext,
      }),
    // [失败路径] MCP 未启用时返回 undefined 而不是抛错：断开是幂等清理，不应因能力缺失失败。
    // 端口存在时把结果原样透传，本文件不解释 disconnect 的返回值。
    // [边界] disconnectMcpServer 只断连接，不注销已注册工具：工具卸载由 replaceMcpServer 单独负责；合并会让重连丢工具。
    disconnectMcpServer: async (name) => {
      if (!deps.mcpPort) return undefined;
      return deps.mcpPort.disconnectServer(name);
    },
    // [契约] 读取 checkpoint 前必须 prepareResume：workspace 未恢复时列表会缺当前会话产物。
    // prepareResume 不传 traceContext 时使用默认上下文，不能凭空造新的 traceId。
    // 列表来自 runtime，本文件不排序、不裁剪、不缓存。
    listCheckpoints: async (options) => {
      await deps.prepareResume();
      return deps.runtime.listWorkspaceCheckpoints(options);
    },
    forkFromCheckpoint: async (options) => {
      await deps.prepareResume(options?.traceContext);
      return deps.runtime.forkWorkspaceFromCheckpoint({
        targetCheckpointId: options?.targetCheckpointId,
        targetMessageId: options?.targetMessageId as MessageId | undefined,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    // [契约] traceContext 缺省用门面上下文：采样请求必须能归属到当前 traceId。
    // options 其余字段原样透传，门面不解释采样参数。
    sampleModel: (input, options) =>
      deps.runtime.sampleModel(input, {
        ...options,
        traceContext: options.traceContext ?? deps.traceContext,
      }),
    // [契约] 这里只规范化模型身份；最低档位由 Core 的辅助请求调用点决定，不在门面层补。
    // normalizeModelSelection 失败时保留原始 selection：宁可让下游报明确错误，也不要静默换模型。
    // abortSignal 必须透传：辅助文本请求同样要能被用户取消。
    generateWorkspaceText: async (input, options) => {
      // 辅助文本入口只规范化模型身份；具体的最低档位由 Core 的辅助请求调用点显式决定。
      const selection =
        normalizeModelSelection(deps.providerRegistry.getView(), input.selection) ??
        input.selection;
      return await deps.runtime.generateWorkspaceText(
        { ...input, selection },
        {
          abortSignal: options?.abortSignal,
          traceContext: options?.traceContext ?? deps.traceContext,
        },
      );
    },
    // [契约] 连接测试前必须补齐最低档位，否则严格 Factory 会先因缺档位失败，掩盖真实连通性问题。
    // 测试不写会话选择：它只验证当前输入的可用性。
    testModelConnectivity: async (input, options) => {
      // 连接测试用的 Model 也要先绑定最低档位，否则严格 Factory 会先因缺档位失败。
      const selection = completeAuxiliaryRegistryModelSelection(
        deps.providerRegistry,
        input.selection,
      );
      await deps.runtime.testModelConnectivity(
        { ...input, selection },
        {
          abortSignal: options?.abortSignal,
          traceContext: options?.traceContext ?? deps.traceContext,
        },
      );
    },
    // [事务] 群模式（permission.scope 为 session）只写会话，不写工作区默认，避免其它群或私聊继承。
    // 先写 session 再写 runtime 执行状态：反过来会让 runtime 短暂持有与 store 不一致的模式。
    // 本地偏好写入失败只 warn：模式已在运行时生效，不能因偏好落盘失败反报命令失败。
    // 日志里的 previousMode 取自 runtime 而非入参，反映真实前态。
    setMode: async (mode: CollaborationMode) => {
      const previousMode = deps.runtime.getMode();
      const session = await deps.sessionStore.getSession(deps.sessionId);
      // 群模式属于任务授权；不能写入工作区默认模式，让其他群或私聊继承。
      if (session?.permission?.scope === "session") {
        await deps.sessionStore.updateSession({
          id: deps.sessionId,
          permission: { ...session.permission, mode },
        });
      }
      await deps.runtime.setExecutionState({ mode }, deps.traceContext);
      if (deps.localSettingStore && session?.permission?.scope !== "session") {
        try {
          await deps.localSettingStore.saveProjectPermissionMode({
            mode: deps.runtime.getMode(),
            projectID: deps.projectID,
          });
        } catch (error) {
          deps.logger.warn("Project mode preference write failed", {
            ...traceContextToLogContext(deps.traceContext),
            error: error instanceof Error ? error.message : String(error),
            event: "local_setting.permission_mode.write_failed",
            mode,
            module: "bootstrap",
            projectId: deps.projectID,
            status: "failed",
          });
        }
      }
      deps.logger.info("Session mode updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.mode.updated",
        mode,
        module: "bootstrap",
        previousMode,
        status: "completed",
      });
      return {
        mode: deps.runtime.getMode(),
        previousMode,
        traceId: deps.traceContext.traceId,
      };
    },
    // [事务] 先把入参整体解析成完整选择，再一次性写入：分步写会留下模型换了档位没换的半次修改。
    // 字符串入口只改身份语义并允许缺档位；对象入口必须完整可解析。
    // cliDefaultSelection 存在且非 transient 时写保存意图，其余情况写 runtime，两条通道互斥。
    // transient 切换不产生 modelChange 通知也不落盘：成对的应用与还原不应刷两条聊天通知。
    setModel: async (modelId, options) => {
      // 配置命令已提交完整 Selection；转成字符串会丢档位。先整体校验再一次
      // 更新/保存，非法档位不能留下已换模型的半次修改。旧字符串入口保留只改身份语义。
      const registrySelection =
        typeof modelId === "string"
          ? resolveRegistryOwnedSelection(
              deps.providerRegistry,
              modelId,
              deps.configuredDefaultModelSelection,
              { allowMissingReasoning: true },
            )
          : resolveRegistryOwnedModelSelection(deps.providerRegistry, modelId);
      if (!registrySelection) {
        throw new Error(`Provider Registry 中不存在 Model: ${modelId}`);
      }
      const previousSelection = readUserModelSelection(deps);
      const previousModel = formatLegacyRuntimeModelValue(previousSelection);
      const model = formatLegacyRuntimeModelValue(registrySelection.selection);
      const sessionSelection: ModelSelection = {
        providerId: registrySelection.selection.providerId,
        modelId: registrySelection.selection.modelId,
        ...(typeof modelId !== "string" && registrySelection.selection.options
          ? { options: { ...registrySelection.selection.options } }
          : {}),
      };
      // 两条写通道互斥：cli-default 模式写 CliDefaultSelection（保存意图，供后续解析绑定），
      // 其它模式直接写 runtime 的会话选择；transient 切换只改 runtime，永不污染保存意图。
      if (deps.cliDefaultSelection && !options?.transient) {
        deps.cliDefaultSelection.set(sessionSelection);
      } else {
        deps.runtime.setSessionModelSelection(sessionSelection);
      }
      // transient 切换不产出 modelChange 聊天通知：应用/还原成对出现会刷出两条无意义通知。
      if (!options?.transient) {
        deps.runtime.recordPendingModelChange({
          fromModel: previousSelection,
          fromModelLabel: previousModel,
          toModel: sessionSelection,
          toModelLabel: model,
        });
        await persistSessionModelSelection(deps);
      }
      deps.logger.info("Session model updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.model.updated",
        model,
        module: "bootstrap",
        previousModel,
        status: "completed",
      });
      return {
        model,
        previousModel,
        traceId: deps.traceContext.traceId,
      };
    },
    // [契约] 档位只能作用在已归属 Registry 的模型上；owned=false 直接抛错，不回退到默认档位。
    // currentSelection 缺失时抛先选模型：没有模型就没有可写入的档位载体。
    // previousThoughtLevel 用 resolve 兜底，保证日志里总能给出前态。
    // 写通道与 setModel 保持同一条：有保存意图就写意图，否则写 runtime，然后统一持久化。
    setThoughtLevel: async (level) => {
      const registryState = currentRegistrySelection();
      if (registryState.owned) {
        const currentSelection = readUserModelSelection(deps);
        if (!currentSelection) throw new Error("Select a model before choosing reasoning effort");
        const registrySelection =
          registryState.selection ??
          resolveRegistryOwnedModelSelection(registryState.registry, {
            providerId: currentSelection.providerId,
            modelId: currentSelection.modelId,
          })!;
        const previousThoughtLevel = resolveRegistryThoughtLevel(
          registrySelection,
          currentSelection.options?.reasoningLevel,
        );
        const thoughtLevel = requireRegistryThoughtLevel(registrySelection, level);
        const nextSelection = {
          ...currentSelection,
          options: {
            ...currentSelection.options,
            reasoningLevel: thoughtLevel,
          },
        };
        if (deps.cliDefaultSelection) deps.cliDefaultSelection.set(nextSelection);
        else deps.runtime.setSessionModelSelection(nextSelection);
        await persistSessionModelSelection(deps);
        deps.logger.info("Session reasoning effort updated", {
          ...traceContextToLogContext(deps.traceContext),
          event: "session.reasoning_effort.updated",
          module: "bootstrap",
          previousThoughtLevel,
          status: "completed",
          thoughtLevel,
        });
        return {
          previousThoughtLevel,
          thoughtLevel,
          traceId: deps.traceContext.traceId,
        };
      }
      throw new Error("当前 Session Model 不属于 Provider Registry");
    },
    // [事务] 先写配置文件，再更新内存 currentLocale 与 configResult：反过来会让内存值领先于磁盘。
    // 写入的是 resolveUiLocale 归一后的 locale，原始请求值只出现在返回与日志里。
    // 落盘失败直接上抛：语言偏好是用户显式操作，不能静默丢掉一次修改。
    setLocale: async (locale) => {
      const previousLocale = currentLocale;
      const configPath = getLocaleConfigPath(deps.configResult);
      const persisted = await updateUiLocaleInFileConfig(configPath, locale);
      currentLocale = deps.resolveUiLocale(locale);
      deps.configResult.config.ui.locale = currentLocale;
      deps.logger.info("Session locale updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.locale.updated",
        locale: currentLocale,
        module: "bootstrap",
        previousLocale,
        requestedLocale: locale,
        status: "completed",
      });
      return {
        configPath: persisted.path,
        locale: currentLocale,
        previousLocale,
        requestedLocale: locale,
        traceId: deps.traceContext.traceId,
      };
    },
  };
}

/**
 * 关闭会话资源（导出以便协议进程等复用同一套所有权/超时语义）。
 * 顺序：beginShutdown 先阻断新准入（失败仅 warn，不能拦住后续释放）→ 四个资源并行、各自带 deadline
 *   → 最后关 session store（它是其它资源写日志/审计的落点，必须最后）。
 * 失败语义：任何 close 抛错或超时都只记 warn 并继续；本函数不向调用方抛错，关闭是尽力而为。
 * 不变量：并行关闭取代旧的串行 await，避免一个永不 settle 的 owner 拖住其余资源。
 */
// [并发] 顺序固定：准入阻断、四个 owner 并行且各自 deadline、store 最后。
// store 是其它资源写日志与审计的落点，提前关会让关闭期诊断信息丢失。
// 并行取代串行：一个永不 settle 的 owner 不能拖住其余资源。
// 本函数不向调用方抛错：关闭是尽力而为，失败只留 warn。
export async function closeSessionResources(input: SessionResourceCloseInput): Promise<void> {
  try {
    // 第一拍先关闭 runtime admission；后续 execution cancel 只能收口状态，不能再唤醒模型。
    input.beginShutdown();
  } catch (error) {
    input.logger.warn("Failed to begin runtime shutdown", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.shutdown_admission.failed",
    });
  }

  // [资源] deadline 至少 1ms：0 或负数会让竞速退化成必定超时，等于跳过释放。
  // timeoutMs 缺省走 6s 常量；调用方传入的非法值由 trunc 与 max 归一。
  // 超时后底层 close 仍可能在后台完成，本函数不再关心其结果。
  const timeoutMs = Math.max(
    1,
    Math.trunc(input.timeoutMs ?? DEFAULT_SESSION_RESOURCE_CLOSE_TIMEOUT_MS),
  );
  const resources: Array<[name: string, close: (() => Promise<void> | void) | undefined]> = [
    ["browser_session", input.closeBrowserSession],
    ["execution", input.closeExecution],
    ["mcp", input.closeMcp],
    ["node_repl_browser_broker", input.closeNodeReplBrowserBroker],
  ];

  // 旧关闭链串行 await；Browser close 永不 settle 时，Execution/MCP 永远不会执行。
  // 各 owner 并行、独立带 deadline，任何一个失败都不能跳过其它资源。
  // [并发] flatMap 只用于过滤掉 undefined 的 owner，不改变执行顺序语义。
  // Promise.all 不会因单项 rejection 提前返回，因为每项内部已把失败收敛为日志。
  // 不要在 map 里 await：那会退化成串行，重新引入互相拖死的问题。
  await Promise.all(
    resources.flatMap(([name, close]) =>
      close ? [closeSessionResourceWithinDeadline(name, close, timeoutMs, input.logger)] : [],
    ),
  );

  try {
    input.closeSessionStore?.();
  } catch (error) {
    input.logger.warn("Failed to close session store", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.resource_close.failed",
      resource: "session_store",
    });
  }
}

/**
 * 给单个资源关闭加 deadline：完成 / 失败 / 超时三态统一收敛为日志，永不让 close 悬挂阻塞调用方。
 * timer 在 race 结束后清理；超时后底层 close 仍可能在后台完成，此时不再关心其结果。
 */
// [资源] 完成、失败、超时三态统一收敛，函数永不 reject。
// timer 必须在竞速结束后清理，否则进程会因悬挂定时器延迟退出。
// Promise.resolve().then(close) 保证同步抛错也进入 Promise 通道，不跳过清理。
async function closeSessionResourceWithinDeadline(
  name: string,
  close: () => Promise<void> | void,
  timeoutMs: number,
  logger: Logger,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const closePromise = Promise.resolve().then(close);
  const outcome = await Promise.race([
    closePromise.then(
      () => ({ type: "completed" as const }),
      (error: unknown) => ({ type: "failed" as const, error }),
    ),
    new Promise<{ type: "timed_out" }>((resolve) => {
      timer = setTimeout(() => resolve({ type: "timed_out" }), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (outcome.type === "completed") return;
  if (outcome.type === "timed_out") {
    logger.warn("Session resource close timed out", {
      event: "session.resource_close.timed_out",
      resource: name,
      timeoutMs,
    });
    return;
  }
  logger.warn("Session resource close failed", {
    error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
    event: "session.resource_close.failed",
    resource: name,
  });
}

/**
 * 把当前会话模型选择写入稳定 session entry（type=SESSION_ENTRY_MODEL_SELECTION）。
 * 口径：写的是"已经生效"的完整选择（provider/model + reasoningLevel），不是 workspace 默认值；
 *   touchSession=false，配置补写不算用户活动、不刷新 session 的"最近活跃"时间。
 * 失败语义：持久化失败只记 warn，不能把已生效的切换反向报成失败（冷恢复会退回旧 entry）。
 * 无 saveSessionEntry 能力或当前无选择时直接跳过，不写空 entry 制造假事实。
 */
// [失败路径] 持久化失败只 warn：选择已在 runtime 生效，回滚会制造命令失败但实际已切换的错觉。
// 无 saveSessionEntry 能力或无选择时直接返回，不写空 entry 制造假事实。
// 固定 entry id 保证同一会话只有一条选型记录，重复写入是覆盖而不是追加。
async function persistSessionModelSelection(deps: CreateSessionFacadeDeps): Promise<void> {
  if (!deps.sessionStore.saveSessionEntry) return;
  const selection = readUserModelSelection(deps);
  if (!selection) return;
  const timestamp = Date.now();
  try {
    await deps.sessionStore.saveSessionEntry({
      id: `${deps.sessionId}:runtime-model-selection`,
      sessionID: deps.sessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      // 模型与思考档位是 session-local 原子选型；切换后立即落同一稳定 entry，
      // 不必等下一条消息，也不会在冷恢复时读取 workspace/draft 的全局最新选择。
      // 同时配置补写不代表用户新活动，不能触发 session.time_updated 变成“刚刚”。
      data: {
        modelId: selection.modelId,
        providerId: selection.providerId,
        ...(selection.options ? { options: selection.options } : {}),
      },
    });
  } catch (error) {
    // 选型已经在当前 runtime 生效；持久化失败不能反向伪装成切换失败，但必须留生产日志。
    deps.logger.warn("Session model selection persistence failed", {
      ...traceContextToLogContext(deps.traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "session.model_selection.persist_failed",
      modelId: selection.modelId,
      module: "bootstrap",
      providerId: selection.providerId,
      status: "failed",
      thoughtLevel: selection.options?.reasoningLevel,
    });
  }
}

/** 仅供仍以 provider/model 字符串工作的内部 App facade；不是 ModelSelection 序列化。 */
// [权衡] 该函数只服务仍以 provider/model 字符串工作的内部入口，不是 ModelSelection 的序列化。
// 不要用它反解析：字符串无法表达档位，反向构造必然丢信息。
function formatLegacyRuntimeModelValue(selection: ModelSelection | undefined): string {
  return selection ? `${selection.providerId}/${selection.modelId}` : "";
}

type GoalStateChangeReminderAction = "paused" | "resumed" | "cleared";

function goalStateChangeReminderText(action: GoalStateChangeReminderAction): string;
function goalStateChangeReminderText(action: undefined): undefined;
function goalStateChangeReminderText(
  action: GoalStateChangeReminderAction | undefined,
): string | undefined;
function goalStateChangeReminderText(
  action: GoalStateChangeReminderAction | undefined,
): string | undefined {
  switch (action) {
    case "paused":
      return "The active session goal is paused. Do not continue pursuing it unless the user resumes or replaces the goal.";
    case "resumed":
      return "The session goal is active again and will be pursued.";
    case "cleared":
      return "The session goal has been cleared. Do not continue pursuing any previous goal unless the user sets a new goal.";
    default:
      return undefined;
  }
}

// 读通道与写通道成对：cli-default 模式读"保存意图"，否则读 runtime 已绑定的会话选择。
// [契约] 读写通道成对：有保存意图读意图，否则读 runtime 已绑定选择。
// 两个来源不会同时有效：混读会让一次切换被拆成两条不相干的事实。
// 返回 undefined 表示尚未选择，调用方必须显式处理，不能当成空字符串。
function readUserModelSelection(deps: CreateSessionFacadeDeps): ModelSelection | undefined {
  return deps.cliDefaultSelection
    ? deps.cliDefaultSelection.get()
    : deps.runtime.getSessionModelSelection();
}
