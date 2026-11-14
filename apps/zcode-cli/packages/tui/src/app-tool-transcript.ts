// INV-01 单条工具事件只允许被投影一次，所有写入都经 setMessages 提交新数组；守住位置：applyToolTranscriptEvent 是唯一事件入口；改错故障：绕过入口就地修改 messages 会跳过 toolCallId 去重，重放事件会叠出重复卡片。
// INV-02 toolCallId 是卡片的唯一身份键，其余字段都只是可覆盖的属性；守住位置：入口处缺失即丢弃；改错故障：改用工具名或数组下标定位，会让并发的同名调用互相覆写。
// INV-03 阶段推进只能是 pending 到 running 再到 completed 或 failed，终态不得回退；守住位置：updateOrAppendToolPart 只在命中卡片时合并 patch；改错故障：允许 completed 回到 running 会让用户看到卡片闪回运行态。
// INV-04 工具名缓存先写后分派，乱序事件也能拿到正确名称；守住位置：每次事件都先刷新 toolNamesById 再判断事件类型；改错故障：只在 scheduled 阶段写缓存，会让早到的 result 退化成占位名 tool。
// INV-05 resultDisplay 只在 kind 为 file_diff 时结构化生成，其余一律不生成；守住位置：resultDisplayFromPayload 先校验 display.kind；改错故障：无条件格式化会把普通文本结果渲染成空 diff 块。
// INV-06 路径信息只走 title，详情行不重复路径；守住位置：readDetails 与 editDetails 的投影分工；改错故障：两处同时输出路径会让窄终端把变更内容挤出视野。
// INV-07 详情行数与单行宽度只能由 compactLines 收口，上限为 4 行与 100 列；守住位置：所有 details 都经该函数；改错故障：绕过它直接拼数组会让单个工具卡片撑破 transcript。
// INV-08 脱敏优先于折叠，敏感键命中后不再看值类型；守住位置：previewValue 的第一条判断；改错故障：先按值类型分支会把 token 类字符串当普通文本原样展示。
// INV-09 大文本键只报字符数，正文永不内联；守住位置：LARGE_TEXT_KEYS 与 previewValue 的字符串分支；改错故障：放行 content 与 old_string 会把整份文件正文塞进终端。
// INV-10 env 变更只展示变量名，值的部分绝不输出；守住位置：bashEnvLine 只取 set 的键与 unset 列表；改错故障：展开 env 对象会把密钥写进可回滚的 transcript。
// INV-11 上游字段类型漂移不得中断投影，非数组一律归空；守住位置：arrayField 与 stringArrayField 的统一收口；改错故障：直接对字段做数组遍历会在类型变化时抛错并丢掉整条事件。
// INV-12 卡片落位的降级链固定为精确消息、补建占位消息、末条 agent 消息、新建消息；守住位置：upsertToolPart 的分支顺序；改错故障：调换顺序会把卡片挂到错误消息上，破坏时间线。
// INV-13 顺序错乱时允许补建终态卡片，detailLines 为空但不阻塞结果展示；守住位置：updateOrAppendToolPart 的补建分支；改错故障：强制先建 pending 会让已完成卡片永远停在等待态。
// INV-14 所有 payload 读取都先经 asRecord 归一，null 与原始类型都不抛错；守住位置：各 details 函数入口；改错故障：直接属性访问会在畸形入参上抛出，整条事件丢失。
// INV-15 assistantMessageId 缺失属可接受态，卡片仍须落地；守住位置：反查表用可选链读取；改错故障：把它当必填会让早到的 result 事件被静默丢弃。
// INV-16 失败原因三段回退，任何路径都要有可读文案；守住位置：eventErrorMessage 的取值顺序；改错故障：只读 error.message 会让失败卡片显示空原因。
// INV-17 投影区保持纯函数，不写模块级可变状态；守住位置：buildToolTranscriptProjection 及其 details 子函数只返回新数组或对象；改错故障：在其中缓存字符串会让相同入参产生不同输出。
// INV-18 类型加固集中在文件底部的三个守卫，调用点不再各写一份判断；守住位置：arrayField、stringArrayField 与 previewText 的唯一实现；改错故障：各处复制判断会分叉出不一致的降级口径。
//
// 模块职责：把 SessionEvent 中的工具类事件投影为 ToolTranscriptPart，并生成已脱敏、已截断的入参摘要行。
// 状态所有权：messages 归调用方，本模块只提交新数组；toolNamesById 与 assistantMessageIdsByToolCallId 由调用方持有并跨事件复用。
// 阅读顺序：事件入口 → 投影分派 → 落位降级链 → 各工具 details → compactLines 收口 → previewValue 脱敏折叠。
// 工具事件投影模块：把工具类 SessionEvent 投影为 transcript 中的工具卡片，并负责入参摘要的生成。
// 边界：只更新调用方传入的 messages 与反查表，不读会话状态、不做 IO/持久化。
// 口径：同一 toolCallId 幂等 upsert；卡片状态按事件阶段推进（pending → running → completed/failed）。
// 失败语义：缺 toolCallId 的事件静默丢弃；畸形入参经 asRecord 降级为空对象，不抛错。
// 同时以 `export { formatFileDiffDisplay }` 转出 diff 展示实现，供恢复路径复用。
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type React from "react";
import type { Message, ToolResultDisplay, ToolTranscriptPart } from "./app-model.js";
import { formatFileDiffDisplay } from "./app-tool-diff-display.js";
import { formatToolFilePath } from "./app-tool-path-display.js";
import { truncateDisplay } from "./app-terminal-width.js";
import { asRecord, booleanField, stringField } from "./state.js";

// 工具入参投影最多展示 4 行详情，避免单条工具卡片挤压 transcript。
const MAX_DETAIL_LINES = 4;
// 单行详情按显示列宽截断到 100 列，防止参数长文本撑破终端。
const MAX_DETAIL_WIDTH = 100;
// 敏感字段键名匹配：命中即脱敏为 [redacted]，覆盖 token/secret/password/api key 等常见命名。
const SENSITIVE_KEY_PATTERN = /token|secret|password|api[_-]?key|authorization|credential|cookie/i;
// 大文本字段不展示内容，只展示字符数，避免把文件正文/替换串塞进 transcript。
const LARGE_TEXT_KEYS = new Set(["content", "old_string", "new_string"]);

export { formatFileDiffDisplay } from "./app-tool-diff-display.js";

// handlers 是宿主注入的唯一写入口；模块自身不持有 React state，也不订阅事件总线。
// toolNamesById 的生命周期必须长于单次事件：scheduled 时写入，后续 progress 与 result 只读。
// assistantMessageIdsByToolCallId 为可选，缺失时卡片按末条 agent 消息追加，属可接受降级。
// workspaceDirectory 只影响标题里的路径呈现，不改变 detailLines 的键值语义。
type ToolTranscriptHandlers = {
  // toolCallId → 其所属 assistant 消息 id；缺省时按末条 agent 消息追加。
  assistantMessageIdsByToolCallId?: Map<string, string>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  // toolCallId → 工具名缓存；后到的 started/progress/result 事件可借此还原名称。
  toolNamesById: Map<string, string>;
  // 用于把绝对路径折算成工作区相对路径；未传时保留原路径。
  workspaceDirectory?: string;
};

type ToolTranscriptInputProjection = {
  // 输入参数摘要行，已截断/脱敏，空数组表示无额外详情。
  detailLines: string[];
  // 可选标题（如 "Read <相对路径>"）；缺失时沿用工具名。
  title?: string;
};

// 将单条工具类 SessionEvent 投影进 transcript：调度→建 pending 卡，开始/进度→running，结果/错误→终态。
// payload 缺 toolCallId 时静默忽略（无法定位卡片）；toolName 回退顺序为事件字段→缓存→"tool"。
// 副作用：写 toolNamesById 缓存并通过 setMessages 触发 React 状态更新；无 IO/持久化。
// 同一 toolCallId 的事件幂等 upsert，不会产生重复卡片。
// 先取 toolCallId，缺失即返回，后续所有分支都建立在 id 非空的前提上。
// 四个事件分支互斥且都以 return 结束，避免同一事件被应用两次。
// 每次调用先刷新 toolNamesById，再按 type 分派，保证名称缓存对乱序事件同样有效。
// 副作用只有缓存写入与 setMessages 回调，无 IO，可安全重复调用。
export function applyToolTranscriptEvent(
  event: SessionEvent,
  handlers: ToolTranscriptHandlers,
): void {
  const payload = asRecord(event.payload);
  const toolCallId = stringField(payload, "toolCallId");
  // 没有 toolCallId 就无法关联卡片，直接丢弃，避免生成无法更新的孤儿条目。
  if (!toolCallId) return;

  // 名称解析先于阶段判断，因此所有终态事件都能带上正确的工具名。
  // 回退顺序是事件字段、缓存、占位名 tool，三段都不命中时也不会出现空标题。
  // 缓存写入是无条件覆盖：后到事件里更精确的名称会替换早先的占位值。
  // [边界] toolNameFromPayload 不校验名称合法性：非法名只污染展示标题，卡片仍按 toolCallId 定位与更新。
  const toolName = toolNameFromPayload(payload, handlers.toolNamesById);
  handlers.toolNamesById.set(toolCallId, toolName);
  const assistantMessageId = handlers.assistantMessageIdsByToolCallId?.get(toolCallId);

  if (event.type === SessionEventType.ToolCallScheduled) {
    const input = "input" in payload ? payload.input : undefined;
    const projection = buildToolTranscriptProjection(toolName, input, handlers.workspaceDirectory);
    const part: ToolTranscriptPart = {
      detailLines: projection.detailLines,
      status: "pending",
      title: projection.title,
      toolCallId,
      toolName,
      type: "tool",
    };
    handlers.setMessages((current) => upsertToolPart(current, part, assistantMessageId));
    return;
  }

  if (
    event.type === SessionEventType.ToolCallStarted ||
    event.type === SessionEventType.ToolCallProgress
  ) {
    handlers.setMessages((current) =>
      updateOrAppendToolPart(
        current,
        toolCallId,
        toolName,
        { status: "running" },
        assistantMessageId,
      ),
    );
    return;
  }

  if (event.type === SessionEventType.ToolCallResult) {
    handlers.setMessages((current) =>
      updateOrAppendToolPart(
        current,
        toolCallId,
        toolName,
        {
          resultDisplay: resultDisplayFromPayload(payload),
          status: "completed",
        },
        assistantMessageId,
      ),
    );
    return;
  }

  if (event.type === SessionEventType.ToolCallError) {
    handlers.setMessages((current) =>
      updateOrAppendToolPart(
        current,
        toolCallId,
        toolName,
        {
          error: eventErrorMessage(payload),
          status: "failed",
        },
        assistantMessageId,
      ),
    );
  }
}

// 把工具调用参数压缩成最多 4 行摘要，供抽出到通用 UI 的地方复用。
// 不修改输入；workspaceDirectory 不传时路径保持原样。
// 输出已脱敏并截断，调用方可直接作为单行/多行文本渲染，无需再过滤。
export function summarizeToolInput(toolName: string, input: unknown): string[] {
  return buildToolTranscriptProjection(toolName, input).detailLines;
}

// 按工具名分派入参投影规则（bash/read/write/edit/grep/glob/webfetch/todowrite/agent/skill）。
// 工具名大小写不敏感；未识别工具走通用投影（键值对，最多 4 行）。
// 返回 detailLines 已统一截断/脱敏；title 仅在 read/edit 且能解析路径时提供。
// 纯函数；非对象 input 经 asRecord 降级为空对象，不抛错。
// 分派按小写工具名做全等比较，因此大小写不同的同类工具共享同一套投影规则。
// 分支顺序固定为专用规则在前、通用兜底在后，新增工具必须插在兜底返回之前。
// 该函数及其 details 子函数均为纯函数，只读入参并返回新数组或对象。
// title 是可选字段，仅 read 与 edit 在解析出路径时提供，其余分支一律省略。
export function buildToolTranscriptProjection(
  toolName: string,
  input: unknown,
  workspaceDirectory?: string,
): ToolTranscriptInputProjection {
  const record = asRecord(input);
  const normalized = toolName.toLowerCase();

  if (normalized === "bash") return { detailLines: bashDetails(record) };
  if (normalized === "read") {
    return readDetails(record, workspaceDirectory);
  }
  if (normalized === "write") {
    return { detailLines: fileMutationDetails(record) };
  }
  if (normalized === "edit") return editDetails(record, workspaceDirectory);
  if (normalized === "grep") return { detailLines: grepDetails(record) };
  if (normalized === "glob")
    return {
      detailLines: compactLines([fieldLine(record, "pattern"), fieldLine(record, "path")]),
    };
  if (normalized === "webfetch") return { detailLines: webFetchDetails(record) };
  if (normalized === "todowrite") return { detailLines: todoWriteDetails(record) };
  if (normalized === "todoread") return { detailLines: ["todos: read current state"] };
  if (normalized === "agent") return { detailLines: agentDetails(record) };
  if (normalized === "skill")
    return {
      detailLines: compactLines([fieldLine(record, "name"), fieldLine(record, "args")]),
    };

  return { detailLines: genericInputDetails(record) };
}

// 优先按 toolCallId 在现有 parts 中做 upsert；命中则合并字段并保留原顺序。
// 未命中且已知 assistantMessageId 时挂到该消息（消息不存在则补建）；再退化为追加到末条 agent 消息。
// 总是返回新数组，避免就地修改触发 React 状态竞争。
// 第一轮遍历按 toolCallId 找卡片，命中即浅合并并保留原 parts 顺序。
// 未命中时的降级顺序不可调换：先精确消息，再补建占位消息，然后末条 agent，最后新建。
// 补建占位消息时带上 streaming 与 streamProjected，让后续增量渲染沿用同一条消息。
// 末条 agent 消息只有在无正文或已有 parts 时才并入，否则新开一条，防止污染正文气泡。
// found 标志区分了「全局找到」与「当前消息找到」，误用会让部分消息被重复拼接。
function upsertToolPart(
  messages: Message[],
  part: ToolTranscriptPart,
  assistantMessageId?: string,
): Message[] {
  let found = false;
  const updated = messages.map((message) => {
    if (!message.parts) return message;
    const parts = message.parts.map((item) => {
      if (item.type !== "tool" || item.toolCallId !== part.toolCallId) return item;
      found = true;
      return { ...item, ...part };
    });
    return found ? { ...message, parts } : message;
  });

  if (found) return updated;
  // 已知归属消息则精确插入；该消息尚未出现时补建占位消息，保证卡片不丢失。
  if (assistantMessageId) {
    let inserted = false;
    const withAssistantMessage = updated.map((message) => {
      if (message.id !== assistantMessageId) return message;
      inserted = true;
      return {
        ...message,
        parts: [...(message.parts ?? []), part],
        streamProjected: true,
      };
    });
    if (inserted) return withAssistantMessage;
    return [
      ...updated,
      {
        content: "",
        id: assistantMessageId,
        parts: [part],
        role: "agent",
        streamProjected: true,
        streaming: true,
      },
    ];
  }
  const last = updated.at(-1);
  // 末条 agent 消息尚未有正文时把卡片并入，避免每次工具事件都新开一条空壳消息。
  if (last?.role === "agent" && (last.parts || last.content.length === 0)) {
    return [...updated.slice(0, -1), { ...last, parts: [...(last.parts ?? []), part] }];
  }
  return [...updated, { content: "", parts: [part], role: "agent" }];
}

// 对已存在的工具卡片打补丁；卡片缺失时回落 upsertToolPart 新建，并保留 patch 中的错误/结果展示。
// 补丁对象刻意排除 toolCallId、toolName 与 type，避免调用方改写卡片身份。
// 命中卡片时先写 toolName 再展开 patch，确保终态事件能纠正早先的占位名称。
// 未命中时走 upsert 补建，并把 patch 里的 error 与 resultDisplay 带过去，防止终态丢失。
// 补建卡片的 detailLines 固定为空，因为入参摘要只在 scheduled 阶段生成一次。
// 该函数不合并 detailLines，晚到的 result 事件不会覆盖已有摘要。
function updateOrAppendToolPart(
  messages: Message[],
  toolCallId: string,
  toolName: string,
  patch: Partial<Omit<ToolTranscriptPart, "toolCallId" | "toolName" | "type">>,
  assistantMessageId?: string,
): Message[] {
  let found = false;
  const updated = messages.map((message) => {
    if (!message.parts) return message;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool" || part.toolCallId !== toolCallId) return part;
      found = true;
      return { ...part, toolName, ...patch };
    });
    return found ? { ...message, parts } : message;
  });

  if (found) return updated;
  // 事件顺序错乱（result 先于 scheduled 到达）时补建卡片，状态直接取 patch 的终态。
  return upsertToolPart(
    updated,
    {
      detailLines: [],
      status: patch.status ?? "pending",
      toolCallId,
      toolName,
      type: "tool",
      ...(patch.error ? { error: patch.error } : {}),
      ...(patch.resultDisplay ? { resultDisplay: patch.resultDisplay } : {}),
    },
    assistantMessageId,
  );
}

// 仅 file_diff 类型的 display 才转成结构化 diff；其他 kind 返回 undefined，让卡片走默认渲染。
function resultDisplayFromPayload(payload: Record<string, unknown>): ToolResultDisplay | undefined {
  const result = asRecord(payload.result);
  const display = asRecord(result.display);
  if (stringField(display, "kind") !== "file_diff") return undefined;
  return formatFileDiffDisplay(display);
}

// 工具名解析优先级：事件自带 > 缓存 > 占位 "tool"，保证缺名事件也不会显示空白。
function toolNameFromPayload(
  payload: Record<string, unknown>,
  toolNamesById: Map<string, string>,
): string {
  const toolCallId = stringField(payload, "toolCallId");
  return (
    stringField(payload, "toolName") ??
    (toolCallId ? toolNamesById.get(toolCallId) : undefined) ??
    "tool"
  );
}

// bash 摘要：命令、cwd、argv、超时、后台标记与 env 变更，空字段自动过滤。
function bashDetails(record: Record<string, unknown>): string[] {
  const argv = asRecord(record.argv);
  const argvFile = stringField(argv, "file");
  const argvArgs = stringArrayField(argv, "args");
  return compactLines([
    fieldLine(record, "command"),
    fieldLine(record, "cwd"),
    argvFile ? `argv: ${previewText([argvFile, ...argvArgs].join(" "))}` : undefined,
    fieldLine(record, "timeout"),
    booleanField(record, "run_in_background") ? "background: true" : undefined,
    bashEnvLine(record),
  ]);
}

// read 摘要：路径收进标题（相对工作区），详情只保留 offset/limit/pages。
// 路径只进 title，detailLines 仅保留 offset、limit、pages 三类分页参数。
// formatToolFilePath 在 workspaceDirectory 缺失时返回原路径，因此标题不会变成空串。
// title 通过条件展开注入，路径解析失败时整个字段消失而不是留下裸 Read 前缀。
// editDetails 复用同一取舍：diff 内容由结果事件提供，入参详情不再重复路径。
function readDetails(
  record: Record<string, unknown>,
  workspaceDirectory: string | undefined,
): ToolTranscriptInputProjection {
  const displayPath = formatToolFilePath(stringField(record, "file_path"), workspaceDirectory);
  return {
    detailLines: compactLines([
      fieldLine(record, "offset"),
      fieldLine(record, "limit"),
      fieldLine(record, "pages"),
    ]),
    ...(displayPath ? { title: `Read ${displayPath}` } : {}),
  };
}

// write 摘要：保留 file_path 与分页/替换参数，不读取文件正文。
function fileMutationDetails(record: Record<string, unknown>): string[] {
  return compactLines([
    fieldLine(record, "file_path"),
    fieldLine(record, "offset"),
    fieldLine(record, "limit"),
    fieldLine(record, "pages"),
    fieldLine(record, "replace_all"),
  ]);
}

function editDetails(
  record: Record<string, unknown>,
  workspaceDirectory: string | undefined,
): ToolTranscriptInputProjection {
  const displayPath = formatToolFilePath(stringField(record, "file_path"), workspaceDirectory);
  // 旧展示重复输出 file_path、replace_all 和 diff 元信息，窄终端会挤占真正变更内容；路径收进标题，详情留给 diff 行。
  return {
    detailLines: compactLines([
      fieldLine(record, "offset"),
      fieldLine(record, "limit"),
      fieldLine(record, "pages"),
    ]),
    ...(displayPath ? { title: `Edit ${displayPath}` } : {}),
  };
}

// grep 摘要：pattern/path/glob 独立成行，其余检索参数合并为 mode 行。
// pattern、path、glob 各自独立成行，便于按行扫读检索范围。
// 其余检索参数合并进 mode 行，用键值对形式压缩垂直空间。
// head_limit 与 offset 属于分页语义，混进独立行会与真正的过滤条件混淆。
// 全部字段经 compactLines 裁剪，缺失键由过滤剔除，不会留下空行。
function grepDetails(record: Record<string, unknown>): string[] {
  return compactLines([
    fieldLine(record, "pattern"),
    fieldLine(record, "path"),
    fieldLine(record, "glob"),
    combinedLine(record, "mode", ["output_mode", "type", "head_limit", "offset"]),
  ]);
}

// webfetch 摘要：URL 原样展示，prompt 走脱敏+截断预览。
function webFetchDetails(record: Record<string, unknown>): string[] {
  return compactLines([fieldLine(record, "url"), previewLine(record, "prompt")]);
}

// todowrite 摘要：只报总数与首个 in_progress 项，不逐条展开全部待办。
function todoWriteDetails(record: Record<string, unknown>): string[] {
  const todos = arrayField(record, "todos").map(asRecord);
  const inProgress = todos.find((todo) => stringField(todo, "status") === "in_progress");
  return compactLines([
    `todos: ${todos.length}`,
    inProgress
      ? `in_progress: ${previewText(stringField(inProgress, "content") ?? "")}`
      : undefined,
  ]);
}

// agent 摘要：描述/子代理类型/后台标记/prompt 预览，用于区分并行子任务。
function agentDetails(record: Record<string, unknown>): string[] {
  return compactLines([
    fieldLine(record, "description"),
    fieldLine(record, "subagent_type"),
    booleanField(record, "run_in_background") ? "background: true" : undefined,
    previewLine(record, "prompt"),
  ]);
}

// 未知工具的兜底投影：按插入顺序输出前 4 个键，值为截断/脱敏后的预览。
function genericInputDetails(record: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (lines.length >= MAX_DETAIL_LINES) break;
    lines.push(`${key}: ${previewValue(key, value)}`);
  }
  return lines;
}

// env 只展示变量名（set/unset），绝不输出变量值，避免密钥泄露到 transcript。
function bashEnvLine(record: Record<string, unknown>): string | undefined {
  const env = asRecord(record.env);
  if (Object.keys(env).length === 0) return undefined;
  const setNames = Object.keys(asRecord(env.set));
  const unsetNames = stringArrayField(env, "unset");
  const changes = compactLines([
    setNames.length > 0 ? `set ${setNames.join(",")}` : undefined,
    unsetNames.length > 0 ? `unset ${unsetNames.join(",")}` : undefined,
  ]).join("; ");
  return changes ? `env: ${changes}` : undefined;
}

// 字段存在即输出 "key: 预览值"；值本身为 undefined 时仍展示键名（区别于键缺失）。
function fieldLine(record: Record<string, unknown>, key: string): string | undefined {
  if (!(key in record)) return undefined;
  return `${key}: ${previewValue(key, record[key])}`;
}

// 仅非空字符串字段生成预览行；空串视为无内容直接隐藏。
function previewLine(record: Record<string, unknown>, key: string): string | undefined {
  const value = stringField(record, key);
  return value ? `${key}: ${previewText(value)}` : undefined;
}

// 把多个键合并成 "label: k=v, k=v"；全部缺失时返回 undefined 以便 compactLines 过滤。
function combinedLine(
  record: Record<string, unknown>,
  label: string,
  keys: readonly string[],
): string | undefined {
  const fields = keys.flatMap((key) => {
    if (!(key in record)) return [];
    return `${key}=${previewValue(key, record[key])}`;
  });
  return fields.length > 0 ? `${label}: ${fields.join(", ")}` : undefined;
}

// 统一收口：过滤 undefined、按显示列宽截断、再截到 MAX_DETAIL_LINES 行。
function compactLines(lines: Array<string | undefined>): string[] {
  return lines
    .filter((line): line is string => Boolean(line))
    .map((line) => truncateDisplay(line, MAX_DETAIL_WIDTH))
    .slice(0, MAX_DETAIL_LINES);
}

// 字段级脱敏与折叠：敏感键先返回 [redacted]（优先级最高，命中后不再看值类型）；
// 大文本键只报字符数，其余字符串/数字/布尔/数组/对象分别给紧凑描述。
// 判断顺序不可调换：敏感键优先，其次字符串（含大文本折叠），再次数字与布尔，最后是数组与对象。
// 敏感键命中后直接返回占位符，即使值是对象也不再展开键名。
// 大文本折叠只发生在字符串分支，非字符串的同名键仍按类型正常描述。
// 数组与对象只报长度或键数，避免深层结构被递归序列化进终端。
function previewValue(key: string, value: unknown): string {
  if (SENSITIVE_KEY_PATTERN.test(key)) return "[redacted]";
  if (typeof value === "string") {
    if (LARGE_TEXT_KEYS.has(key)) return `[${value.length} chars]`;
    return previewText(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (value && typeof value === "object") return `{${Object.keys(value).length} keys}`;
  return String(value);
}

// 压缩连续空白为单个空格并截断，避免多行命令/提示词破坏单行卡片布局。
function previewText(value: string): string {
  return truncateDisplay(value.replace(/\s+/g, " ").trim(), MAX_DETAIL_WIDTH);
}

// 错误文案优先级：error.message > payload.reason > "Tool failed"，保证卡片总有失败原因。
function eventErrorMessage(payload: Record<string, unknown>): string {
  const error = asRecord(payload.error);
  return stringField(error, "message") ?? stringField(payload, "reason") ?? "Tool failed";
}

// 非数组归为空数组，避免上游字段类型漂移导致投影崩溃。
function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

// 过滤非字符串元素，供 argv/env 列表安全拼接。
function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  return arrayField(record, key).filter((item): item is string => typeof item === "string");
}
