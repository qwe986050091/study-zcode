// TUI 对外类型契约模块：定义 TuiOptions 注入的全部回调/读取接口与 UI 侧数据形状。
// 边界：只有类型声明，无运行时代码；这些形状是 CLI 与 TUI 之间的稳定契约，改动需同步调用方。
// 口径：回调返回 Promise 表示异步远端读取，缺省的注入项表示该能力不可用、相关 UI 静默降级。
// 失败语义：类型层不表达失败；运行时由调用方把异常转成状态文案或 system 消息。
import type { WorkflowRunProgressEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelection, ZCodeModelOption } from "@zcode/shared";
import type {
  CollaborationMode,
  InputDelivery,
  ModelUsageSummary,
  McpServerStatus,
  PermissionBrokerRequest,
  PermissionBrokerRequestOptions,
  PermissionBrokerResult,
  SessionEvent,
  SessionProjection,
  SupportedLocale,
  ToolResultDisplayPayload,
  UiThemeMode,
  UiThemePreference,
  TurnId,
  TurnSteerResult,
} from "@zcode/contracts";

// 上下文用量：已用 token 与窗口上限，用于输入区状态行的压缩提示。两字段均可缺省（尚未收到 projection）。
export type TuiContextUsage = Pick<SessionProjection, "contextUsed" | "contextWindow">;

// 会话元信息：本轮结果里会回写到 UI 的会话级字段，供恢复/切换会话时同步模式、模型与登录态。
export type TuiSessionMetadata = Pick<
  TuiSubmitPromptResult,
  "locale" | "model" | "theme" | "thoughtLevel" | "modelOptions" | "effortOptions" | "loginRequired"
>;

// TUI 可切换的协作模式子集：从 CollaborationMode 中取终端支持切换的五种，其余模式不提供入口。
export type TuiSwitchableMode = Extract<
  CollaborationMode,
  "plan" | "build" | "edit" | "yolo" | "guarded"
>;

// 切换模式的结果：mode 为切换后的实际模式（可能与请求不同），response 为可选提示文案。
export type TuiSetModeResult = {
  mode: CollaborationMode;
  response?: string;
};

// 模式切换回调：接受目标模式，同步或异步返回最终模式；失败直接抛错，由调用方转成状态文案。
export type TuiSetMode = (mode: TuiSwitchableMode) => Promise<TuiSetModeResult> | TuiSetModeResult;

// 提交附件：type 决定下游处理方式；path 用于文件/pdf/url，content 用于内联文本内容。
export type TuiPromptAttachment = {
  type: "file" | "image" | "pdf" | "url";
  path?: string;
  content?: string;
};

// prompt 输入的两种形态：纯文本，或带附件与模型引用的结构化对象。
// modelSelection 与展示文本分离保存，避免"/model xxx"改写过后的文本丢失模型 ref。
export type TuiPromptInput =
  | string
  | {
      text: string;
      attachments?: TuiPromptAttachment[];
      /** Model picker commands retain the reference separately from their display text. */
      modelSelection?: ModelSelection;
    };

// 剪贴板图片允许的 MIME 类型：下游只接受这四种，其他类型视为不可粘贴。
export type TuiImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

// 剪贴板图片载荷：dataUrl 为内联 base64 数据；sizeBytes 可选，仅用于展示/限制判断。
export type TuiClipboardImage = {
  dataUrl: string;
  mediaType: TuiImageMediaType;
  sizeBytes?: number;
};

// 读取剪贴板图片：无可粘贴图片时返回 null（而非抛错）；abortSignal 用于取消。
export type TuiReadClipboardImage = (options?: {
  abortSignal?: AbortSignal;
}) => Promise<TuiClipboardImage | null>;

// 写系统剪贴板：允许同步或异步实现，失败通过 Promise reject 上报给调用方。
export type TuiWriteClipboardText = (text: string) => Promise<void> | void;

// @ 路径候选类型：目录与文件在面板中有不同图标/选中行为。
export type TuiWorkspacePathKind = "directory" | "file";

// 单条路径候选：path 为相对工作区的展示路径，kind 决定补全后是否追加分隔符。
export type TuiWorkspacePathSuggestion = {
  kind: TuiWorkspacePathKind;
  path: string;
};

// 路径候选查询结果：items 为按服务端顺序返回的候选；truncated 表示结果被上限截断（可能还有更多）。
export type TuiWorkspacePathSuggestionResult = {
  items: readonly TuiWorkspacePathSuggestion[];
  truncated: boolean;
};

// 按 token 查询路径候选：limit 限制条数，abortSignal 允许取消在飞的查询。
export type TuiListWorkspacePathSuggestions = (request: {
  abortSignal?: AbortSignal;
  limit?: number;
  token: string;
}) => Promise<TuiWorkspacePathSuggestionResult>;

// 选择面板条目：primary 为主文案，command 为提交时使用的命令名或值；其余为可选的副标题/关键字。
// disabledReason 非空时条目不可选，并展示禁用原因；pending 表示该条目会转成输入态。
export type TuiSelectionItem = {
  command: string;
  disabledReason?: string;
  id: string;
  input?: TuiSelectionInput;
  keywords?: readonly string[];
  meta?: string;
  pending?: TuiSelectionPending;
  primary: string;
  secondary?: string;
};

// 条目选中后的输入态配置：placeholder/mask 控制输入框外观，各 status 文案用于输入过程的状态栏。
export type TuiSelectionInput = {
  cancelStatus?: string;
  clearStatus?: string;
  emptyStatus?: string;
  help?: string;
  mask?: boolean;
  placeholder?: string;
  primary: string;
  secondary?: string;
  status?: string;
  submitStatus?: string;
};

// 条目选中后的等待态配置：在异步命令执行期间展示 primary/help/status，cancelStatus 供取消提示。
export type TuiSelectionPending = {
  cancelStatus?: string;
  help?: string;
  primary: string;
  secondary?: string;
  status?: string;
};

// 选择面板数据：prompt/title 为头部文案，items 为候选列表，placement 决定渲染在输入框内联还是主区。
// selectedIndex 由 UI 临时维护（缺省从 0 开始）；emptyMessage 为无匹配时的文案。
export type TuiSelection = {
  emptyMessage: string;
  filterable?: boolean;
  help?: string;
  items: TuiSelectionItem[];
  placement?: "action" | "composer";
  prompt: string;
  selectedIndex?: number;
  title: string;
};

// 恢复会话的历史片段：text/thought 只带文本；tool 片段额外带 toolName/input 与可选结果展示，
// 供重建实时流的渲染形态（title/detailLines/diff）而不是退化成纯文本。
export type TuiRestoredTranscriptPart =
  | {
      text: string;
      type: "text";
    }
  | {
      text: string;
      type: "thought";
    }
  | {
      error?: string;
      input: Record<string, unknown>;
      output?: string;
      resultDisplay?: ToolResultDisplayPayload;
      status: "pending" | "running" | "completed" | "failed";
      title?: string;
      toolCallId: string;
      toolName: string;
      type: "tool";
    };

// 一轮提交/命令的结果：response 为本轮最终文本，其余字段按需回写 UI（模式、模型、用量、选区等）。
// resetSessionProjection 表示以空 transcript 重来；restoredMessages 表示用历史消息替换当前投影。
export type TuiSubmitPromptResult = {
  effortOptions?: readonly TuiEffortOption[];
  modelOptions?: readonly TuiModelOption[];
  locale?: SupportedLocale;
  loginRequired?: boolean;
  mode?: CollaborationMode;
  model?: string;
  theme?: UiThemePreference;
  projection?: Partial<TuiContextUsage>;
  response: string;
  resetSessionProjection?: boolean;
  restoredMessages?: Array<{
    id?: string;
    content: string;
    parts?: TuiRestoredTranscriptPart[];
    role: "agent" | "system" | "user";
  }>;
  selection?: TuiSelection;
  sessionId?: string;
  thoughtLevel?: string;
  traceId?: string;
  turnId?: string;
  usage?: ModelUsageSummary;
};

// 工具审批请求：把权限 broker 的请求与选项原样转交，返回其结果（允许/拒绝/带修改）。
export type TuiRequestPermission = (
  request: PermissionBrokerRequest,
  options?: PermissionBrokerRequestOptions,
) => Promise<PermissionBrokerResult>;

// 提交一轮 prompt：abortSignal 必填用于取消；onEvent 为该轮回合内的事件回调（回合结束即失效）。
export type TuiSubmitPrompt = (
  prompt: TuiPromptInput,
  options: {
    abortSignal: AbortSignal;
    onEvent?: (event: SessionEvent) => void | Promise<void>;
    requestPermission?: TuiRequestPermission;
  },
) => Promise<TuiSubmitPromptResult>;

// busy 期间追加输入的结果：新开一轮/返回命令结果，或 runtime 当前的 TurnSteerResult（通常是 queued）。
export type TuiSendInputResult =
  | {
      kind: "started_turn";
      result: TuiSubmitPromptResult;
    }
  | {
      kind: "command_result";
      result: TuiSubmitPromptResult;
    }
  | TurnSteerResult;

// 追加输入接口：delivery 控制投递策略，expectedTurnId 防止投到已结束的轮次上。
export type TuiSendInput = (
  input: TuiPromptInput,
  options: {
    abortSignal?: AbortSignal;
    delivery?: InputDelivery;
    expectedTurnId?: TurnId;
    onEvent?: (event: SessionEvent) => void | Promise<void>;
    requestPermission?: TuiRequestPermission;
  },
) => Promise<TuiSendInputResult>;

// 输入历史回溯：skip 表示继续向前翻的条数；无更多历史时返回 null，由 UI 保持当前草稿。
export type TuiRecallPreviousInput = (
  skip?: number,
) => Promise<{ attachments?: TuiPromptAttachment[]; text: string } | null>;

// 取消后台任务：返回值仅表示已提交取消，不保证任务已终止；失败由调用方转成状态文案。
export type TuiCancelBackgroundTask = (taskId: string) => Promise<unknown>;

// 读取子 Agent 目录：endedCursor 用于分页已结束项，缺省取第一页。
export type TuiReadSubagents = (input?: {
  endedCursor?: string;
  endedLimit?: number;
}) => Promise<import("@zcode/shared").ZCodeSessionSubagentsResult>;
// 子 Agent transcript 快照：messages 为持久化历史，events 为可重放的增量事件，
// replayMessageIds 标记哪些流式事件仍然有效（其余已在历史中，重放会造成重复）。
export type TuiSubagentTranscriptSnapshot = {
  sessionId: string;
  sequenceNumber: number;
  messages: NonNullable<TuiSubmitPromptResult["restoredMessages"]>;
  events: SessionEvent[];
  replayMessageIds: string[];
};
// 按 childSessionId 读取子会话详情快照；sessionId 不一致视为读取错误。
export type TuiReadSubagentTranscript = (
  childSessionId: string,
) => Promise<TuiSubagentTranscriptSnapshot>;

/**
 * 跨回合常驻的会话事件订阅。
 *
 * 为什么不复用 `submitPrompt` / `sendInput` 的 per-turn `onEvent`：dwf 进度是**出回合事件**
 * （turnId 为空），per-turn sink 在回合结束即死——这正是 TUI 今天丢 dwf 事件的结构性原因。
 * 后台完成通知驱动的模型回合同理（它由 runtime 命令队列自驱，没有任何 per-turn sink 在听）。
 *
 * 返回 unsubscribe；`replaceApp`（`/new` `/resume` `/fork`）时由 CLI 侧重挂。
 */
export type TuiSubscribeSessionEvents = (sink: (event: SessionEvent) => void) => () => void;

/**
 * 会话级 workflow run 摘要（`app.listDynamicWorkflowRuns`），用于冷启动/恢复时补种镜像。
 *
 * `label` / `updatedAt` 是 additive optional：老服务端不发这两个键，读侧退回 runId、不显示时间。
 * `resumable` 由服务端裁定，**绝不**在 TUI 重推导。
 */
export type TuiWorkflowRunSummary = {
  runId: string;
  toolCallId?: string;
  status: "completed" | "errored" | "pending" | "running" | "stopped";
  stopReason?: "user" | "model" | "provider" | "interrupted" | "superseded";
  label?: string;
  updatedAt?: number;
  resumable?: boolean;
};

// 列出会话级 workflow run 摘要；供冷启动补种展示名，失败时应向上抛错由调用方吞掉。
export type TuiListWorkflowRuns = () => Promise<readonly TuiWorkflowRunSummary[]>;

/**
 * workflow run 的冷回放：把本会话名下、镜像里
 * 还没有的 run 从 journal 回放成进度事件信封，逐条喂给镜像的共享 reducer——重启 / `/resume`
 * 之后卡片显示的是真实步数、用量与子代理，而不是 0/0 的空壳。
 */
export type TuiReplayWorkflowRuns = (input: {
  excludeRunIds: ReadonlySet<string>;
}) => Promise<readonly WorkflowRunProgressEnvelope[]>;

/**
 * 当前**主会话** id。是 getter 而不是值：`/new` `/resume` `/fork` 会换会话，
 * 快照下来的 id 会立刻过期，然后把整条转写误判成外来事件。
 */
export type TuiGetMainSessionId = () => string | undefined;

// 读取 MCP server 状态（以 server 名为键），用于侧边栏状态区；失败应抛错，由 hook 转成空状态。
export type TuiListMcpServers = () => Promise<Record<string, McpServerStatus>>;

// slash 命令候选：name 为命令名（提交时拼成 "/name"），usage/summary 用于候选面板展示，aliases 参与匹配。
export type TuiSlashCommandSuggestion = {
  aliases?: readonly string[];
  name: string;
  summary: string;
  usage: string;
};

// 模型选项直接复用共享的 ZCodeModelOption，避免 TUI 与协议层出现两份模型描述。
export type TuiModelOption = ZCodeModelOption;

// 思考档位选项：id 为提交时使用的值，label 为展示名，description 为可选说明。
export type TuiEffortOption = {
  description?: string;
  id: string;
  label: string;
};

// 模式选项：id 限定为 TUI 可切换模式，description/label 用于模式候选面板。
export type TuiModeOption = {
  description: string;
  id: TuiSwitchableMode;
  label: string;
};

// TUI 启动注入项：必需项为终端流与 submitPrompt，其余为可选能力，缺省即该功能静默不可用。
// 可选回调（读子 Agent、MCP、workflow、剪贴板等）由 CLI 适配层实现；TUI 只调用声明的契约。
// initial* 与 loginRequired 用于首帧即呈现确定状态，initialResult 为启动 sentinel 的重放结果。
export type TuiOptions = {
  /** Called after the startup screen has painted; runtime ownership stays in CLI. */
  loadStartupOptions?: () => Promise<TuiStartupOptions>;
  initialMode?: CollaborationMode;
  initialModel?: string;
  initialResult?: TuiSubmitPromptResult;
  initialThoughtLevel?: string;
  loginRequired?: boolean;
  locale?: SupportedLocale;
  theme?: UiThemePreference;
  initialThemeMode?: UiThemeMode;
  developerMode?: boolean;
  version?: string;
  workspaceDirectory?: string;
  workspaceGitBranch?: string;
  noColor: boolean;
  stderr: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  cancelBackgroundTask?: TuiCancelBackgroundTask;
  readSubagents?: TuiReadSubagents;
  readSubagentTranscript?: TuiReadSubagentTranscript;
  listWorkspacePathSuggestions?: TuiListWorkspacePathSuggestions;
  listMcpServers?: TuiListMcpServers;
  listWorkflowRuns?: TuiListWorkflowRuns;
  replayWorkflowRuns?: TuiReplayWorkflowRuns;
  getMainSessionId?: TuiGetMainSessionId;
  readClipboardImage?: TuiReadClipboardImage;
  recallPreviousInput?: TuiRecallPreviousInput;
  sendInput?: TuiSendInput;
  setMode?: TuiSetMode;
  effortOptions?: readonly TuiEffortOption[];
  modelOptions?: readonly TuiModelOption[];
  listModelOptions?: () => Promise<readonly TuiModelOption[]>;
  slashCommands?: readonly TuiSlashCommandSuggestion[];
  submitPrompt: TuiSubmitPrompt;
  subscribeSessionEvents?: TuiSubscribeSessionEvents;
  subscribeThemeMode?: (listener: (mode: UiThemeMode) => void) => () => void;
  setTerminalBackgroundColor?: (color: string) => void;
  writeClipboardText?: TuiWriteClipboardText;
};

// 启动选项子集：由 loadStartupOptions 在首帧后返回，只包含可延迟取得的初始会话信息。
// 这些字段会覆盖 TuiOptions 中同名初值；未返回的字段沿用原值。
export type TuiStartupOptions = Pick<
  TuiOptions,
  | "initialMode"
  | "initialModel"
  | "initialThoughtLevel"
  | "loginRequired"
  | "locale"
  | "theme"
  | "modelOptions"
  | "effortOptions"
  | "slashCommands"
  | "workspaceGitBranch"
>;
