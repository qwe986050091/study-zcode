// INV-01 全文件只允许类型声明：五个导入块都带 type 修饰，守住位置：文件头 1 至 25 行的 import type；改错故障：一旦引入值导入，类型模块变成运行时依赖，打包后触发循环解析。
// INV-02 选项类型必须从 TUI 函数签名派生：TuiSubmitOptions 取 Parameters 的第二个泛型位，守住位置：第 27 至 28 行两个别名；改错故障：手写等价结构后 TUI 新增字段仍能编译，运行时静默丢事件。
// INV-03 模式集合先 NonNullable 再 Extract 白名单：守住位置：CommandCenterMode 与 SwitchableCommandCenterMode；改错故障：新增 mode 未经白名单校验就进入切换路径，切换后界面停在旧态。
// INV-04 [事务] 登录授权字段保留服务端 snake_case 原样：守住位置：CommandCenterLoginAuthorizeData 的四个字段；改错故障：改名为驼峰后授权回调取不到地址，登录流程停在轮询。
// INV-05 [失败路径] 卸载结果的 removed 用 null 表达本来未安装：守住位置：CommandCenterPluginUninstallResult；改错故障：改成抛错会让重复卸载失败，改成空对象会把未安装报告成已卸载。
// INV-06 [权衡] 能力面只有 submitPrompt 与 resume 必选：守住位置：CommandCenterApp 内带问号的成员；改错故障：改成必选后所有测试桩都要补全实现，命令层也失去按缺席降级的判据。
// INV-07 [失败路径] dwf 列表能力缺席代表 run service 未构造：守住位置：listDynamicWorkflowRuns 与 replayDynamicWorkflowRuns 的注释契约；改错故障：缺席时回空表，用户把服务不可用读成没有任务。
// INV-08 [事务] resume 拒绝走结构化 reason 而非异常：守住位置：resumeWorkflowRun 返回 DynamicWorkflowRunResumeResult；改错故障：客户端自行推导可恢复性，与服务端裁定相反时会重试已结算 run。
// INV-09 runId、taskId、workId 是同一把标识：守住位置：cancelBackgroundTask 的 taskId 参数与 dwf 注释；改错故障：另建一层 id 映射后，取消会落到相邻任务。
// INV-10 [并发] getApp 与 resumeApp 是 Deps 仅有的必选入口：守住位置：CommandCenterDeps 两个无问号成员；改错故障：改成可选后每条命令都要判空，漏判即空引用。
// INV-11 [权衡] setModel、setThoughtLevel、setLocale、setMode 允许同步或 Promise 返回：守住位置：四个成员的联合返回类型；改错故障：某处只走同步分支，把 Promise 当结果用，最终写入 undefined。
// INV-12 [事务] 默认模型偏好只在用户主动切换成功后保存：守住位置：saveDefaultModelSelection 的注释与 rememberCurrentModelSelection；改错故障：恢复会话时也写入，自动初始化覆盖用户默认选择。
// INV-13 workflowMode 缺席表示不设门，只有显式 disabled 才拦截：守住位置：CommandCenterDeps.workflowMode 注释与 dwf 的 isWorkflowModeEnabled 判断；改错故障：单测与嵌入方莫名丢失工作流命令。
// INV-14 MCP 的 status 是六态封闭联合、transport 是三态：守住位置：CommandCenterMcpStatus 的字面量联合；改错故障：新增态未同步渲染映射，该状态无处展示而被当成正常。
// INV-15 [事务] target 的四个 status 字符串是持久化值：守住位置：CommandCenterTargetStatus；改错故障：改名后旧会话读回的值不在联合内，目标面板落入未处理分支。
// INV-16 时间字段统一为 Date 或 number 或 string：守住位置：CommandCenterCheckpoint.createdAt 与 CommandCenterSession.updatedAt；改错故障：收窄成 Date 后读盘路径类型不成立，格式化处拿到字符串。
// INV-17 [资源] 长任务成员必须透传 abortSignal 与 onEvent：守住位置：submitPrompt、runExpertWorkflow、continueActiveTarget、resumeExpertWorkflow、stopExpertWorkflow 的 options；改错故障：取消无法中断在飞请求，进度事件丢失。
// INV-18 技能清单同时给出可见项与发现总数：守住位置：CommandCenterSkillListOutcome 的 totalDiscovered；改错故障：截断后用户以为技能只有这些，统计与分页口径错位。
//
// 模块职责：command-center 的类型契约层，只声明命令层与运行时之间的数据形状，不含任何实现、常量或状态。
// 状态所有权：会话、模型、目标、MCP、插件与 workflow 的真源都在运行时与 session 存储；本文件只描述读写面，命令层不得缓存或重新推导。
// 阅读顺序：先看顶部派生别名，再看各命令的结果类型，最后看 CommandCenterApp 的能力面与 CommandCenterDeps 的注入面。
import type {
  TuiPromptAttachment,
  TuiPromptInput,
  TuiSendInput,
  TuiSendInputResult,
  TuiSubmitPrompt,
  TuiSubmitPromptResult,
} from "@zcode/tui";
import type { SupportedLocale, UiLocale } from "@zcode/i18n";
import type { ModelSelection, ZCodeModelOption } from "@zcode/shared";
import type { DynamicWorkflowMode } from "@zcode/shared";
import type {
  BackgroundTaskCancelResult,
  DynamicWorkflowRunResumeResult,
  DynamicWorkflowRunProgressPayload,
  DynamicWorkflowRunSessionSummary,
  PluginLoadOutcome,
  PluginMetadata,
  WorkflowRunSnapshot,
  WorkflowRunStatus,
} from "@zcode/contracts";
import type {
  CommandCenterCustomCommandContent,
  CommandCenterCustomCommandListOutcome,
} from "../command-center-custom.js";

// 三个别名把 TUI 的函数签名转成命令层可用的选项类型，避免在两处重复描述事件与取消语义。
// TuiSubmitOptions 取 Parameters 的第二个泛型位，第一位是 prompt 本体，下标写错会静默换成输入类型。
// CommandCenterMode 先 NonNullable 再 Extract，保证下游拿到的是收窄后的字面量而不是可选字符串。
// [权衡] SwitchableCommandCenterMode 用显式白名单而非全量 mode：新增 mode 必须手动加入，换来切换逻辑与展示集合始终对齐。
// 改错故障：在这里手写等价结构，TUI 侧新增字段后 CLI 编译仍通过，运行时才丢字段。
export type TuiSubmitOptions = Parameters<TuiSubmitPrompt>[1];
export type TuiSendInputOptions = Parameters<TuiSendInput>[1];
export type CommandCenterMode = NonNullable<TuiSubmitPromptResult["mode"]>;
export type SwitchableCommandCenterMode = Extract<
  CommandCenterMode,
  "plan" | "build" | "edit" | "yolo" | "guarded"
>;

export type CommandCenterModelOption = ZCodeModelOption;

export type CommandCenterLocaleResult = {
  configPath?: string;
  locale: SupportedLocale;
  previousLocale?: SupportedLocale;
  requestedLocale: UiLocale;
};

// MCP 状态是命令层展示用的投影，字段与运行时 MCP 客户端一一对应，不在这里做归并。
// status 用六态封闭联合覆盖连接中、已连接、已禁用、已断开、失败与未授信，新增态需同步到 TUI 映射。
// [失败路径] error 与 failed 并存：状态表达阶段，error 保留原始原因供文案展示，不能只留其一。
// toolCount 与 updatedAt 是快照值，读取时不重新探测，避免列表刷新触发连接副作用。
// transport 收窄为 stdio、http、sse 三态，多一种传输必须同时扩展运行时适配器。
// 改错故障：把 status 放宽成 string 后，未知值让渲染落到兜底分支，失败会被显示成正常。
export type CommandCenterMcpStatus = {
  error?: string;
  status: "connecting" | "connected" | "disabled" | "disconnected" | "failed" | "untrusted";
  toolCount: number;
  transport: "stdio" | "http" | "sse";
  updatedAt: string;
};

export type CommandCenterPluginListOutcome = PluginLoadOutcome;

export type CommandCenterPluginSetResult = {
  enabled: boolean;
  path: string;
  plugin: PluginMetadata;
};

// 卸载结果只回传被移除插件的 id 与 name，不回传完整元数据，避免命令层依赖安装目录结构。
// [事务] removed 为 null 表示该插件本来未安装，属于幂等成功而非错误。
// 调用方据此区分已卸载与未安装两种文案，提示内容与成功判定都不同。
// 改错故障：把 null 改成抛错，重复执行卸载会失败；改成空对象，未安装会被报告成已卸载。
// [契约] CommandCenterPluginUninstallResult 被卸载命令与格式化函数共同消费：removed 为 null 时两处都必须走「未安装」文案。
export type CommandCenterPluginUninstallResult = {
  // null 表示该插件未安装（幂等 no-op）。
  removed: { id: string; name: string } | null;
};

export type CommandCenterSkill = {
  description: string;
  name: string;
  path: string;
  pluginName?: string;
  qualifiedName?: string;
  scope: string;
  source: string;
  whenToUse?: string;
};

export type CommandCenterSkillListOutcome = {
  skills: CommandCenterSkill[];
  totalDiscovered: number;
};

export type CommandCenterExpertWorkflowResult = {
  reportPath?: string;
  response: string;
  runId?: string;
  snapshot?: WorkflowRunSnapshot;
  status?: WorkflowRunStatus | string;
  traceId?: string;
};

export type CommandCenterForkResult = {
  copiedMessageCount?: number;
  forkedSessionId: string;
  response: string;
  restoredFileCount?: number;
  restoredFiles?: unknown[];
};

export type CommandCenterCheckpoint = {
  checkpointId: string;
  compactBoundaryId?: string;
  coveredByCompact?: boolean;
  createdAt: Date | number | string;
  fileCount?: number;
  messageId: string;
  preview?: string;
  scope: string;
};

export type CommandCenterSession = {
  directory: string;
  id: string;
  parentId?: string;
  title: string;
  updatedAt: Date | number | string;
};

export type CommandCenterTargetStatus = "active" | "paused" | "budget_limited" | "complete";

export type CommandCenterTarget = {
  objective: string;
  sessionID: string;
  status: CommandCenterTargetStatus;
  summaryTitle?: string | null;
  targetID: string;
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  time: {
    created: number;
    updated: number;
  };
};

export type CommandCenterLoginResult = {
  browser?: {
    opened: boolean;
    reason?: string;
  };
  configPath: string;
  credentialsPath: string;
  model: string;
  providerId?: "bigmodel" | "zai";
  user: {
    email?: string;
    name?: string;
    user_id: string;
  };
};

export type CommandCenterLoginAuthorizeData = {
  authorize_url: string;
  expires_at: number;
  flow_id: string;
  poll_interval_sec: number;
};

export type CommandCenterLoginOptions = {
  abortSignal?: AbortSignal;
  onAuthorizeUrl?: (data: CommandCenterLoginAuthorizeData) => Promise<void> | void;
};

export type CommandCenterBigmodelLoginAuthorizeData = CommandCenterLoginAuthorizeData;
export type CommandCenterBigmodelLoginOptions = CommandCenterLoginOptions;

export type CommandCenterBigmodelLoginResult = {
  browser?: {
    opened: boolean;
    reason?: string;
  };
  configPath: string;
  model: string;
  providerId: "bigmodel";
};

export type CommandCenterApiKeyOptions = {
  apiKey: string;
  providerId: "bigmodel" | "zai";
};

export type CommandCenterApiKeyResult = {
  configPath: string;
  model: string;
  providerId: "bigmodel" | "zai";
};

export type CommandCenterLogoutResult = {
  credentialsPath: string;
};

// 这是命令层面向运行时的唯一能力面，所有斜杠命令都通过它读写会话，不直接触碰 session-core。
// sessionId 与 traceId 声明为 readonly：它们是身份标识，由运行时创建，命令层只读取并回填到结果里。
// [权衡] 仅 submitPrompt 与 resume 必选，其余能力全部可选；缺少某能力时命令回不可用，而不是抛错。
// 可选能力必须用可选调用语法探测存在性，不能假定实现方一定提供。
// getMode、getModel、getTheme 等读取器保持同步，保证渲染路径不需要等待异步状态。
// listModels 与 listThoughtLevels 允许同步或异步返回，调用点统一 await 以抹平差异。
// [并发] 每个长任务成员都接受 abortSignal，取消由运行时落地，命令层只负责透传。
// submitPrompt 是唯一的对话入口，sendInput 只用于运行中追加输入，两者不可互换。
// 改错故障：给能力面加必选成员，会同时打破所有测试桩与嵌入方，并让降级分支失效。
export type CommandCenterApp = {
  readonly sessionId: string;
  readonly traceId: string;
  getMode?(): CommandCenterMode;
  getModel?(): string | undefined;
  getCurrentModelOption?(): CommandCenterModelOption | undefined;
  getLocale?(): TuiSubmitPromptResult["locale"];
  getTheme?(): TuiSubmitPromptResult["theme"];
  getThoughtLevel?(): string | undefined;
  loadSessionTranscript?(): Promise<NonNullable<TuiSubmitPromptResult["restoredMessages"]>>;
  readSubagents?: import("@zcode/tui").TuiReadSubagents;
  readSubagentTranscript?: import("@zcode/tui").TuiReadSubagentTranscript;
  readTarget?(): Promise<CommandCenterTarget | null>;
  setTarget?(input: {
    objective: string;
    status?: CommandCenterTargetStatus;
    tokenBudget?: number | null;
  }): Promise<CommandCenterTarget>;
  updateTargetStatus?(status: CommandCenterTargetStatus): Promise<CommandCenterTarget | null>;
  clearTarget?(): Promise<boolean>;
  continueActiveTarget?(options?: {
    abortSignal?: AbortSignal;
    onEvent?: TuiSubmitOptions["onEvent"];
  }): Promise<TuiSubmitPromptResult | null>;
  listModels?(): CommandCenterModelOption[] | Promise<CommandCenterModelOption[]>;
  listThoughtLevels?(): string[] | Promise<string[]>;
  listPlugins?(): Promise<CommandCenterPluginListOutcome>;
  setPluginEnabled?(plugin: string, enabled: boolean): Promise<CommandCenterPluginSetResult>;
  uninstallPlugin?(plugin: string): Promise<CommandCenterPluginUninstallResult>;
  listMcpServers?(): Promise<Record<string, CommandCenterMcpStatus>>;
  listCheckpoints?(options?: { limit?: number }): Promise<CommandCenterCheckpoint[]>;
  connectMcpServer?(name: string): Promise<CommandCenterMcpStatus>;
  disconnectMcpServer?(name: string): Promise<CommandCenterMcpStatus | undefined>;
  expertWorkflowStatus?(options?: {
    abortSignal?: AbortSignal;
    runId?: string;
  }): Promise<CommandCenterExpertWorkflowResult>;
  /**
   * workflow run 的枚举面，服务 `/dwf list`。可选能力：dwf journal 不可用时整个 run service
   * 不构造，此成员随之缺席——命令据此回「不可用」而不是空表。
   * 服务端已按父会话过滤（listRunsByParentSession），返回的每一行都属于本会话。
   */
  // 该成员服务 dwf 列表命令，返回会话摘要而非完整 run，避免列表拉取把大量进度载荷带进内存。
  // [失败路径] 成员缺席代表 dwf journal 不可用、run service 未构造，命令必须回不可用文案。
  // 服务端已按父会话过滤，命令层不再做二次归属判断，也不应把其他会话的 run 混入。
  // limit 由调用方给出，服务端另有上限，这里只表达一屏够看，不承担截断语义。
  // [资源] 列表是只读快照且不启动引擎，因此 disabled 模式下仍可查看。
  // 对应的 replayDynamicWorkflowRuns 走同一数据源，冷启动用它补齐 TUI 镜像。
  // replay 接收 excludeRunIds，避免与实时流已收到的 run 重复投影。
  // 改错故障：缺席时返回空数组，用户会把服务不可用读成没有任务。
  listDynamicWorkflowRuns?(input: { limit?: number }): Promise<DynamicWorkflowRunSessionSummary[]>;
  /**
   * workflow run 的冷回放，服务 TUI 镜像的冷启动：
   * journal → 与 live 同一种进度载荷。可选能力，缺席条件同 {@link listDynamicWorkflowRuns}。
   */
  replayDynamicWorkflowRuns?(input: {
    excludeRunIds: ReadonlySet<string>;
  }): Promise<DynamicWorkflowRunProgressPayload[]>;
  /**
   * workflow run 的取消面，服务 `/dwf cancel`。runId ≡ taskId ≡ workId（同一把标识）。
   */
  cancelBackgroundTask?(taskId: string): Promise<BackgroundTaskCancelResult>;
  /**
   * workflow run 的恢复面，服务 `/dwf resume`。失败走结构化 reason 而不是 throw，
   * 命令原样呈现服务端裁定——`resumable` 绝不在客户端重新推导。
   */
  resumeWorkflowRun?(input: {
    workId: string;
    name?: string;
  }): Promise<DynamicWorkflowRunResumeResult>;
  forkFromCheckpoint?(options?: { targetCheckpointId?: string }): Promise<CommandCenterForkResult>;
  recallPreviousInputHistory?(
    skip?: number,
  ): Promise<{ attachments?: TuiPromptAttachment[]; text: string } | null>;
  resume(options?: { onEvent?: TuiSubmitOptions["onEvent"] }): Promise<{
    appliedMessageCount: number;
    directory: string;
    interruptedToolCount: number;
    messageCount: number;
    partCount: number;
    traceId?: string;
  }>;
  resumeExpertWorkflow?(options?: {
    abortSignal?: AbortSignal;
    onEvent?: TuiSubmitOptions["onEvent"];
    runId?: string;
  }): Promise<CommandCenterExpertWorkflowResult>;
  submitPrompt(
    prompt: TuiPromptInput,
    options?: {
      abortSignal?: AbortSignal;
      onEvent?: TuiSubmitOptions["onEvent"];
    },
  ): Promise<TuiSubmitPromptResult>;
  runExpertWorkflow?(
    input: { task: string },
    options?: {
      abortSignal?: AbortSignal;
      onEvent?: TuiSubmitOptions["onEvent"];
    },
  ): Promise<CommandCenterExpertWorkflowResult>;
  sendInput?(input: TuiPromptInput, options?: TuiSendInputOptions): Promise<TuiSendInputResult>;
  setModel?(
    modelId: string | ModelSelection,
  ):
    | Promise<{ model: string; previousModel?: string; thoughtLevel?: string }>
    | { model: string; previousModel?: string; thoughtLevel?: string };
  setThoughtLevel?(
    level: string,
  ):
    | Promise<{ previousThoughtLevel?: string; thoughtLevel: string }>
    | { previousThoughtLevel?: string; thoughtLevel: string };
  setLocale?(locale: UiLocale): Promise<CommandCenterLocaleResult> | CommandCenterLocaleResult;
  stopExpertWorkflow?(options?: {
    abortSignal?: AbortSignal;
    runId?: string;
  }): Promise<CommandCenterExpertWorkflowResult>;
};

// Deps 是命令层的注入面，把运行时、登录、配置与偏好写入抽象成函数，命令实现因此可被单测替换。
// getApp 与 resumeApp 必选：前者取当前 app，后者按会话 id 重建 app，其余注入项全部可选。
// forkApp 与 newApp 分开表达从检查点分叉与全新会话，不用一个函数加布尔开关合并。
// [事务] login、configureApiKey、logout 都返回写入后的路径与模型，调用方据此展示落点，不自行拼接路径。
// loginBigmodel 与 login 拆开，是因为两者的结果形状与 providerId 不同，合并会丢失类型收窄。
// listSessions、listCustomCommands、listSkills 是只读枚举，失败应向上冒泡而不是回空列表。
// recordInputHistory 允许同步或异步返回，历史写入不阻塞命令结果。
// [事务] saveDefaultModelSelection 只在用户主动切换成功后调用，恢复会话与自动初始化不调用。
// setMode 与 setLocale 允许同步返回值，调用点统一 await，避免两种实现路径分叉。
// hasSelectableModels 用于判断是否需要引导选模型，只回布尔，不暴露模型清单。
// [失败路径] workflowMode 缺席表示不设门，只有显式 disabled 才拦截 workflow 与 dwf resume。
// 改错故障：把可选注入项改成必选，所有既有调用方与测试都要补桩，且降级路径被抹平。
export type CommandCenterDeps = {
  forkApp?: (targetCheckpointId?: string) => Promise<CommandCenterForkResult>;
  getApp(): Promise<CommandCenterApp>;
  getLocale?: () => TuiSubmitPromptResult["locale"];
  getMode?: () => CommandCenterMode;
  hasSelectableModels?: () => Promise<boolean> | boolean;
  listSessions?: () => Promise<CommandCenterSession[]>;
  listCustomCommands?: () => Promise<CommandCenterCustomCommandListOutcome>;
  listSkills?: () => Promise<CommandCenterSkillListOutcome>;
  login?: (options?: CommandCenterLoginOptions) => Promise<CommandCenterLoginResult>;
  loginBigmodel?: (
    options?: CommandCenterBigmodelLoginOptions,
  ) => Promise<CommandCenterBigmodelLoginResult>;
  configureApiKey?: (options: CommandCenterApiKeyOptions) => Promise<CommandCenterApiKeyResult>;
  loadCustomCommand?: (name: string) => Promise<CommandCenterCustomCommandContent>;
  newApp?: () => Promise<CommandCenterApp>;
  recordInputHistory?: (
    input: TuiPromptInput,
    kind?: "slash_command",
  ) => Promise<unknown> | unknown;
  resumeApp(sessionId?: string): Promise<CommandCenterApp>;
  /** 用户主动切换成功后保存完整默认选择；恢复会话与自动初始化不调用。 */
  saveDefaultModelSelection?: (selection: ModelSelection) => Promise<void>;
  logout?: () => Promise<CommandCenterLogoutResult>;
  setLocale?: (locale: UiLocale) => Promise<CommandCenterLocaleResult> | CommandCenterLocaleResult;
  setMode?: (mode: SwitchableCommandCenterMode) => Promise<CommandCenterMode> | CommandCenterMode;
  /**
   * 本进程的 `--workflow-mode`（launch.md「The standalone CLI: `--workflow-mode`」）。`disabled` 时
   * `/workflow` 与 `/dwf resume` 给本地提示；缺席不设门（单测、嵌入方），CLI 入口总会传入。
   */
  workflowMode?: DynamicWorkflowMode;
};
