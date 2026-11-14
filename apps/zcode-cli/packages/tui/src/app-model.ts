// TUI 的视图模型与共享展示类型聚合。
// 职责：定义消息分段、草稿附件、审批/提问、侧栏状态等渲染口径的类型。
// 边界：类型只描述投影后的 UI 形状，业务事实由 session 事件下发，本文件不持有状态。
// 副作用：无运行时逻辑，仅类型声明与审批决策常量。
// 口径：可选字段缺省表示“尚未提供/未投影”，占位与降级由渲染层负责。

import type {
  AskUserQuestionAnnotation,
  AskUserQuestionInput,
  McpServerStatus,
  ModelUsageSummary,
  PermissionBrokerRequest,
  PermissionBrokerResult,
  TodoItem,
} from "@zcode/contracts";
import type {
  TuiClipboardImage,
  TuiOptions,
  TuiSelection,
  TuiSelectionInput,
  TuiSelectionPending,
} from "./types.js";
import type { ModifiedFileStat } from "./app-modified-files.js";
export type { ModifiedFileStat } from "./app-modified-files.js";

// 转录中的单条消息：由 session 事件投影而来，TUI 只增补渲染用的临时字段。
// 口径：content 为空串是合法值（如纯工具消息）；id 缺失表示本地乐观消息，尚未获得服务端 id。
export type Message = {
  // 消息正文；timeline 事件类消息通常为空串，正文由 timeline 字段承载。
  content: string;
  // 服务端消息 id；本地插入/流式尚未回填时为 undefined，去重与增量合并依赖它。
  id?: string;
  // 分段结构（文本/思考/工具）；undefined 表示该消息尚未完成分段投影，按 content 整体渲染。
  parts?: TranscriptPart[];
  role: "agent" | "system" | "timeline" | "user";
  // 标记该消息已由流式事件写入，防止最终快照再次重复追加同一条。
  streamProjected?: boolean;
  // 仍在流式接收中；为 true 时渲染层可显示光标/增量效果，结束时由完成事件置回。
  streaming?: boolean;
  // role 为 "timeline" 时的事件详情，其它角色为 undefined。
  timeline?: TimelineMessage;
};

// 消息分段联合类型：文本、思考、工具三类，按顺序还原 provider 原始转录时序。
export type TranscriptPart = TextTranscriptPart | ThoughtTranscriptPart | ToolTranscriptPart;

// 上下文压缩等时间线事件的结构化记录，用于在转录中渲染分隔/状态行。
export type TimelineMessage = {
  // 当前重试轮次（从 1 起）；未重试时为 undefined。
  attempt?: number;
  // 触发该事件的命令文本（如 /compact），来源为提交值。
  command?: string;
  // 最大重试次数；与 attempt 一起决定是否展示 "2/3"。
  maxAttempts?: number;
  // 关联的 session 消息 id，用于回链到具体消息。
  messageId?: string;
  // 操作幂等标识；同一次操作的重试共享此值。
  operationId: string;
  // 跳过/失败原因；仅在 skipped/failed 等状态有值。
  reason?: string;
  // 状态机：started → retrying → completed/failed/skipped/interrupted，渲染据此选色与图标。
  status: "started" | "retrying" | "skipped" | "completed" | "failed" | "interrupted";
  // 触发来源（自动/手动等），由事件层透传，TUI 不解释其取值。
  trigger?: string;
  type: "context_compaction";
};

// 文本分段格式；markdown 走完整渲染，plain 退化为等宽文本。
export type TuiTextFormat = "markdown" | "plain";

// 文本分段：assistant 正文的最小可追加单元。
export type TextTranscriptPart = {
  // 是否按 Markdown 渲染；undefined 时调用方按默认格式处理。
  format?: TuiTextFormat;
  // 已由流式事件投影，避免最终快照重复合并。
  streamProjected?: boolean;
  // 文本内容；可为空串，表示占位但无可见内容。
  text: string;
  type: "text";
};

// 思考分段：记录推理内容与进度。
export type ThoughtTranscriptPart = {
  // 已累计的思考字符数，用于折叠态展示规模，不用于渲染截断。
  contentCharCount: number;
  // thinking=仍在生成，thought=已结束；决定是否显示动态指示。
  status: "thinking" | "thought";
  streamProjected?: boolean;
  // 思考文本；权限/脱敏由上游决定，TUI 原样展示。
  text: string;
  type: "thought";
};

// 工具调用分段：状态、标题与结果展示均由工具事件映射而来。
export type ToolTranscriptPart = {
  // 详情行的已预格式化文本（含缩进），渲染层不再二次折行。
  detailLines: string[];
  // 失败错误信息；成功或进行中为 undefined。
  error?: string;
  // 原始输出文本；大体积输出应由上游截断后再传入。
  output?: string;
  // 结构化结果展示（diff/文件路径等）；无结构化数据时为 undefined。
  resultDisplay?: ToolResultDisplay;
  // 调用状态机：pending → running → completed/failed，只前进不回退。
  status: "pending" | "running" | "completed" | "failed";
  // 用户可读标题；undefined 时回落到工具名。
  title?: string;
  // provider 的工具调用 id，用于与流式事件及结果回填关联。
  toolCallId: string;
  // 工具名（如 bash/read_file），用于选择渲染器与图标。
  toolName: string;
  type: "tool";
};

// 工具结果的富展示信息，各字段按工具类型可选填充。
export type ToolResultDisplay = {
  // unified diff 文本；仅编辑类工具提供。
  diff?: string;
  // 关联文件路径（展示口径，可能是相对路径）。
  filePath?: string;
  // 高亮所用的语言标识；undefined 表示按纯文本处理。
  filetype?: string;
  // 逐行内容与着色标记，渲染时按序输出。
  lines: ToolResultDisplayLine[];
  // 结构化 hunk 数据，供需要折叠/统计行号的渲染器使用。
  structuredPatch?: ToolResultDisplayHunk[];
  // 展示标题；undefined 时由调用方按工具名生成。
  title?: string;
  // 输出是否已截断；为 true 时界面需提示“已截断”。
  truncated?: boolean;
};

// 结果中的一行：text 为原始行文本，tone 决定前景色（新增/删除/上下文/元信息）。
export type ToolResultDisplayLine = {
  text: string;
  tone: "addition" | "context" | "deletion" | "meta";
};

// diff 单个 hunk 的行号区间；行号口径为文件内 1-based，oldLines/newLines 为 0 时表示该侧无内容。
export type ToolResultDisplayHunk = {
  lines: string[];
  newLines: number;
  newStart: number;
  oldLines: number;
  oldStart: number;
};

// 草稿中的图片附件：由剪贴板粘贴产生，尚未提交到 session。
export type DraftImageAttachment = {
  // data URL（含 base64），用于预览与最终上传；不在日志中输出。
  dataUrl: string;
  // 本地自增 id，仅在当前草稿内唯一，用于插入/删除定位。
  id: number;
  // 媒体类型，来源为剪贴板探测结果。
  mediaType: TuiClipboardImage["mediaType"];
  // 插入到输入框的占位文本（如 [Image #1]），提交前与正文一起解析。
  placeholder: string;
  // 原始字节数；未知时为 undefined，用于提示大小。
  sizeBytes?: number;
  type: "image";
};

// 草稿中的文件附件：@ 提及文件后生成，提交时转换为文件引用。
export type DraftFileAttachment = {
  id: number;
  // 文件路径；可为绝对或相对路径，由提及补全提供。
  path: string;
  // 输入框内的占位文本，与 path 一一对应。
  placeholder: string;
  type: "file";
};

// 草稿附件联合类型，按 type 字段区分渲染与提交转换路径。
export type DraftAttachment = DraftFileAttachment | DraftImageAttachment;

// 排队中的用户输入（busy 期间提交）：id 为客户端生成标识，text 为原始输入文本。
export type QueuedInput = {
  id: string;
  text: string;
};

// 审批决策枚举：单次允许、项目内允许、拒绝；顺序即界面按钮顺序。
export type ApprovalDecision = "allow_once" | "allow_project" | "deny";

// 交互式提问的 UI 状态：答案以问题 id 为键，和 input 内的题目一一对应。
export type QuestionPromptState = {
  // 每个问题的附加说明（如推荐选项），来源为请求 payload，可能为空对象。
  annotations: Record<string, AskUserQuestionAnnotation>;
  // 已确认答案（问题 id → 答案文本）；未回答的键不存在。
  answers: Record<string, string>;
  // 当前展示的题目下标，0-based，始终指向 input.questions 的有效范围。
  currentQuestionIndex: number;
  // 是否正在编辑“其他”自定义答案，为 true 时输入焦点在 otherBuffer。
  editingOther: boolean;
  // 原始提问输入，包含题目、选项与多选标记；只读，UI 不修改。
  input: AskUserQuestionInput;
  // 多选题的已选选项（问题 id → 选项值数组），单选题不使用。
  multiSelections: Record<string, string[]>;
  // “其他”答案的输入缓冲；切换题目时由 otherText 恢复。
  otherBuffer: string;
  // 已填写的“其他”答案，按问题 id 保存，用于返回上一题时回填。
  otherText: Record<string, string>;
  // 是否处于提交前复核页；为 true 时展示全部答案汇总。
  reviewing: boolean;
  // 当前题目的选中选项下标；-1 表示未选中任何预置项（此时走 otherBuffer）。
  selectedOptionIndex: number;
};

// 审批弹窗的完整上下文：持有 broker 的 resolve/reject 与清理钩子，必须且只能调用一次。
export type ApprovalPrompt = {
  // 关闭弹窗时的清理动作（移除监听/计时器），不改变审批结果。
  cleanup: () => void;
  // 附带交互式提问状态；非提问类审批为 undefined。
  questionState?: QuestionPromptState;
  // 拒绝回调；错误会作为审批结果回传 broker，调用后弹窗即结束。
  reject: (error: Error) => void;
  // 原始权限请求，展示命令/路径/风险说明的来源。
  request: PermissionBrokerRequest;
  // 允许/拒绝回调；result 必须符合 broker 协议，调用后不可再次调用。
  resolve: (result: PermissionBrokerResult) => void;
  // 当前高亮的决策项；仅 UI 选择态，提交时以最终选择为准。
  selectedDecision: ApprovalDecision;
};

// 正在等待用户补全的选区：带命令来源与条目 id，用于异步结果回填时定位。
export type ActiveSelectionPending = TuiSelectionPending & {
  command: string;
  itemId: string;
};

// 已完成输入的选区：value 为提交值，command/itemId 标识来源条目。
export type ActiveSelectionInput = TuiSelectionInput & {
  command: string;
  itemId: string;
  value: string;
};

// TUI 侧选区交互态：在通用 TuiSelection 上叠加过滤串、输入/等待上下文与选中下标。
export type SelectionState = TuiSelection & {
  // 当前过滤关键字；空串表示不过滤，展示全部候选。
  filter: string;
  // 已确定的输入；等待异步候选时为 undefined。
  input?: ActiveSelectionInput;
  // 正在等待后端返回候选；undefined 表示无进行中的请求。
  pending?: ActiveSelectionPending;
  // 当前高亮候选下标，0-based；候选为空时该值无意义，渲染前需夹取。
  selectedIndex: number;
};

// 提交输入的附加语义：abortStatus 为中断时显示的状态文案，
// preserveSelection 为 true 时提交后保留当前选区（用于重试同一命令）。
export type SubmitValueOptions = {
  abortStatus?: string;
  preserveSelection?: boolean;
};

// 斜杠命令候选，直接取自 TuiOptions 的数组元素类型，避免与宿主定义分叉。
export type SlashCommand = NonNullable<TuiOptions["slashCommands"]>[number];

// 斜杠命令建议的选择态；selectedIndex 为过滤后候选的 0-based 下标。
export type SlashSelectionState = {
  selectedIndex: number;
};

// /effort 建议的选择态，语义同 SlashSelectionState。
export type EffortCommandSelectionState = {
  selectedIndex: number;
};

// /model 建议的选择态，语义同 SlashSelectionState。
export type ModelCommandSelectionState = {
  selectedIndex: number;
};

// /mode 建议的选择态，语义同 SlashSelectionState。
export type ModeCommandSelectionState = {
  selectedIndex: number;
};

// 单次网络请求的观测记录，供侧栏网络面板展示；时间均为 ISO 字符串。
export type NetworkRequest = {
  // 重试轮次；首次请求为 undefined 或 1。
  attempt?: number;
  // 完成时间（ISO）；未完成时 undefined。
  completedAt?: string;
  // 耗时毫秒；由 start/complete 时间差得出，未完成时 undefined。
  durationMs?: number;
  // 失败原因摘要；成功时为 undefined。
  error?: string;
  // 客户端生成的记录 id，供列表 key 与更新匹配。
  id: string;
  // HTTP 方法（GET/POST 等）。
  method: string;
  // 请求使用的模型标识；非模型请求可为 undefined。
  model?: string;
  // provider 标识；非模型请求可为 undefined。
  provider?: string;
  // provider 侧请求 id，用于与服务端日志对账。
  requestId: string;
  // 请求来源分类（如 model/mcp），由调用方声明。
  source: string;
  // 开始时间（ISO）。
  startedAt: string;
  // 状态：pending 进行中、complete 成功、error 失败。
  status: "pending" | "complete" | "error";
  // HTTP 状态码；网络层失败时 undefined。
  statusCode?: number;
  // 最近更新时间（ISO），用于排序与判断陈旧记录。
  updatedAt: string;
  // 请求地址（可能已脱敏）；展示口径，不用于重放。
  url: string;
};

// 上下文用量：token 级计数，undefined 表示该值尚未由服务端提供。
export type ContextUsage = {
  // 已占用 token 数。
  contextUsed?: number;
  // 模型上下文窗口总 token 数；未知时无法计算占比。
  contextWindow?: number;
};

// 提示缓存统计：命中情况用于展示成本优化效果，字段均可缺省。
export type CacheStats = {
  // 命中缓存的消息数。
  cachedMessages?: number;
  // 从缓存读取的 token 数。
  cacheReadTokens?: number;
  // 最近一次请求是否命中缓存。
  lastCacheHit?: boolean;
  // 参与统计的消息总数。
  totalMessages?: number;
};

// MCP 侧栏状态：servers 为空对象表示无服务或尚未完成首次加载。
export type McpSidebarState = {
  // 最近一次拉取失败的错误信息；成功后整体替换 state 会清除该字段。
  error?: string;
  // 是否仍在首次加载（有数据后轮询不再置 true）。
  loading: boolean;
  // 按服务名索引的状态快照，来源为 listMcpServers 返回值。
  servers: Record<string, McpServerStatus>;
};

// 侧栏展示所需的聚合状态快照；由上层组装，TUI 只读。
export type SidebarState = {
  // 当前活跃 turn id；空闲时为 undefined。
  activeTurnId?: string;
  // agent 是否在运行（含流式输出）。
  busy: boolean;
  // 提示缓存统计；未启用或未知时 undefined。
  cacheStats?: CacheStats;
  // 上下文用量；字段内部可能部分缺省。
  contextUsage: ContextUsage;
  // 输入框草稿的镜像，仅用于展示，真正草稿由输入组件持有。
  draft: string;
  // 最近一次错误文案；无错误时 undefined。
  lastError?: string;
  // 最近一次事件的简短描述，用于状态栏。
  lastEvent: string;
  // 当前会话消息条数。
  messageCount: number;
  // 协作模式标识（字符串口径，可能包含界面未枚举的值）。
  mode: string;
  // MCP 状态；未接入 MCP 时为 undefined。
  mcpStatus?: McpSidebarState;
  // 当前模型标识，通常为 "provider/model" 形式。
  model: string;
  // 本次会话修改过的文件统计；空数组表示无修改。
  modifiedFiles: ModifiedFileStat[];
  // 网络请求记录列表，按时间排序；空数组表示尚无请求。
  networkRequests: NetworkRequest[];
  // 状态栏主文案。
  status: string;
  // 状态栏附加明细行；空数组表示无明细。
  statusDetails: string[];
  // 思考等级标识（如 low/high），字符串口径由上层定义。
  thoughtLevel: string;
  // 当前待办列表；空数组表示无待办。
  todos: TodoItem[];
  // 贯穿本次任务的 traceId；未建立链路时为 undefined。
  traceId?: string;
  // 模型用量汇总（token/费用）；服务端未返回时 undefined。
  usage?: ModelUsageSummary;
  // 工作区 Git 分支；非 Git 工作区为 undefined。
  workspaceGitBranch?: string;
  // 工作区目录展示路径；未解析时为 undefined。
  workspaceDirectory?: string;
};

export { palette } from "./theme/index.js";

// 审批决策的固定顺序清单，界面按钮与键盘映射都按此顺序渲染，保持操作一致。
export const approvalDecisions: ApprovalDecision[] = ["allow_once", "allow_project", "deny"];
