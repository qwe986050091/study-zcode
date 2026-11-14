/* eslint-disable max-lines -- Treemapping v1 的 tool call 解析规则需要集中保持优先级一致，避免 UI 和测试分散维护后产生识别差异。 */
// 职责边界（treemappingActivity）：把一条 assistant message 的 toolCalls 投影成文件/目录活动模型。
// 做：判定读/写动作 → 解析路径候选 → 规范化路径 → 按文件/目录聚合增删行数、查看次数与 pending 状态。
// 不做：渲染 treemap、读取文件系统、决定工具权限；输入只有 TaskChatMessage 与 workspacePath。
// 依赖：fileSummaries 的文件变更摘要、resolveToolCallIdentity 的工具族判定、path 工具。
// 边界：模型是“消息内事件的聚合视图”，不是 workspace 真实状态；同一路径可同时出现在 files 与 directories。
// 数据流：toolCalls → collectWritable/Structured/Fallback/Read → addFile/DirectoryEvent(Map) → 按 path 排序输出。
// 记账单位是事件而非工具调用：一次调用可产生多个路径事件，聚合值全部按事件累加。
//
// INV 不变量表（每条都对应一种静默故障，改前先确认它守的是什么）
// INV-01 断言：事件拼装顺序是 writable → structured → fallback mutation → read —— 守住它的位置：入口的 events 数组 —— 改错故障：同一变更被重复记账
// INV-02 断言：structured 与 fallback 只在 writable 为空时执行 —— 守住它的位置：条件展开 —— 改错故障：一次编辑被记成三份
// INV-03 断言：read 事件始终追加，不参与互斥 —— 守住它的位置：入口 events 数组 —— 改错故障：边写边读的调用丢失 view 事件
// INV-04 断言：先聚合进 Map 再排序输出 —— 守住它的位置：addFileEvent/addDirectoryEvent —— 改错故障：逐条输出产生重复文件行
// INV-05 断言：kind 只升不降（deleted > written > modified > viewed）—— 守住它的位置：mergeKind —— 改错故障：删除被后续 view 覆盖回可编辑态
// INV-06 断言：added/removed 按事件累加 —— 守住它的位置：addFileEvent —— 改错故障：多次编辑只保留最后一次行数
// INV-07 断言：views 只在 view 动作时 +1 —— 守住它的位置：两处聚合 —— 改错故障：写操作把查看次数刷高
// INV-08 断言：pendingToolCallIds 去重后 push —— 守住它的位置：addFileEvent —— 改错故障：重复事件让 pending 角标虚高
// INV-09 断言：lastTouchedAt 取 max —— 守住它的位置：两处聚合 —— 改错故障：晚到事件让时间倒退、排序抖动
// INV-10 断言：路径只规范化一次 —— 守住它的位置：normalizePath 调用点 —— 改错故障：同一文件出现两个 Map key
// INV-11 断言：workspace 前缀剥离必须带分隔符 —— 守住它的位置：startsWith 判断 —— 改错故障：workspace2 被误当成 workspace 子路径
// INV-12 断言：workspacePath 先去掉尾斜杠 —— 守住它的位置：normalizedWorkspace —— 改错故障：拼出双斜杠后前缀永不命中
// INV-13 断言：绝对路径去前导斜杠后仍按相对处理 —— 守住它的位置：isAbsoluteFilePath 分支 —— 改错故障：本机绝对路径泄露到 UI
// INV-14 断言：目录路径必须去掉尾斜杠 —— 守住它的位置：normalizeDirectoryPath —— 改错故障：src 与 src/ 各占一行
// INV-15 断言：search 无结果时按目录记账 —— 守住它的位置：target 三元 —— 改错故障：伪造一个不存在的文件
// INV-16 断言：search 命中只取 output 候选 —— 守住它的位置：readSearchResultPathCandidates —— 改错故障：把搜索范围当成命中文件
// INV-17 断言：读动作先看 identity 再看语义词 —— 守住它的位置：inferReadAction —— 改错故障：自定义工具族无法识别为读
// INV-18 断言：mutation 只信结构化字段，不信 title —— 守住它的位置：collectWritableEvents 的 action 判定 —— 改错故障：kind=edit/title=Write 被染成写入
// INV-19 断言：无路径的活跃调用只计数不建行 —— 守住它的位置：runningWithoutPathCount —— 改错故障：空路径文件污染面板
// INV-20 断言：输出按 path 的 localeCompare 排序 —— 守住它的位置：入口返回处 —— 改错故障：Map 插入序随工具顺序变化导致面板抖动
//
// 阅读顺序：动作判定（read/mutation）→ 路径候选 → 规范化 → add*Event → 入口函数。
// 入口函数放在文件末尾：所有 collect 与 add 函数都是它的私有步骤，导出前不应出现第二条调用链。
// 纯函数边界：除缺少 startedAt 时读 Date.now() 外，不触碰时钟、IO、store 或 React 状态。
import type { TaskChatMessage, TaskChatToolCall } from "@/lib/taskChatMessageTypes.js";
import { getPathLeaf, isAbsoluteFilePath } from "@/lib/path.js";
import { readRawToolCallFileSummaries } from "@/ToolCallBlocks/fileSummaries.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";

export type TreemappingFileKind = "viewed" | "written" | "modified" | "deleted";
export type TreemappingEventAction = "view" | "write" | "modify" | "delete";

export interface TreemappingActivityEvent {
  toolCallId: string;
  toolName: string;
  action: TreemappingEventAction;
  path: string;
  target: "file" | "directory";
  added: number;
  removed: number;
  timestamp: number;
  pending: boolean;
}

export interface TreemappingFileActivity {
  path: string;
  kind: TreemappingFileKind;
  added: number;
  removed: number;
  views: number;
  pendingToolCallIds: string[];
  lastTouchedAt: number;
  events: TreemappingActivityEvent[];
}

export interface TreemappingDirectoryActivity {
  path: string;
  views: number;
  lastTouchedAt: number;
  events: TreemappingActivityEvent[];
}

export interface TreemappingActivityModel {
  files: TreemappingFileActivity[];
  directories: TreemappingDirectoryActivity[];
  runningWithoutPathCount: number;
}

// [契约] pending 判定只认这两个状态：pending 与 in_progress 都代表“尚未结算”。
// 不要把 cancelled/failed 加进来：它们已结算，计入 pending 会让面板永久转圈。
// 也不要用取反（非 completed 即 pending）：未知状态会被误当在飞，计数只增不减。
// 该集合是模块级常量，任何调用方都不得就地修改。
// 状态字符串来自 TaskChatToolCall，新增状态时要同时检查这里与去重逻辑。
// pending 只影响展示与去重键，不参与 action 判定。
const ACTIVE_TOOL_CALL_STATUSES = new Set(["pending", "in_progress"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// [契约] 两个字段读取器都只接受 plain record，数组与 null 一律视为缺失。
// readStringField 跳过纯空白字符串：空路径不是“未知路径”，不能进入候选集合。
// 键顺序就是优先级：前面的键命中即返回，调换会改变工具之间的解析结果。
// readNumberField 做 max(0) 与 round：负增量会让面积反向，小数会让累计失真。
// Number.isFinite 过滤 NaN/Infinity，否则统计列会出现 NaN。
// 这两个读取器是纯读，不允许写回输入对象。
// 不要把默认值 0 塞进读取器：缺失与 0 业务含义不同，由调用方用 ?? 区分。
// 嵌套对象必须逐层判 plain record，不能直接下标访问。
function readStringField(value: unknown, keys: readonly string[]): string | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return undefined;
}

function readNumberField(value: unknown, keys: readonly string[]): number | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.max(0, Math.round(candidate));
    }
  }

  return undefined;
}

// [契约] 路径规范化只做一次：所有事件路径都必须经过这里再进 Map。
// 先 trim 再把反斜杠换成正斜杠：同一会话里 Windows 与 POSIX 输出会混用。
// 包含换行的路径直接丢弃：它几乎必然是多行文本误入 path 字段。
// workspace 前缀剥离必须带分隔符，裸 startsWith 会把 workspace2 误判成子路径。
// workspacePath 自身要去掉尾斜杠，否则拼出的双斜杠永远匹配不上。
// 绝对路径去前导斜杠后仍按“相对 workspace”处理，避免把本机绝对路径带进 UI。
// 不以 ./ 开头的相对路径保持原样，不要补前缀：面板按 workspace 相对路径聚合。
// 返回 null 表示不可用，调用方必须 filter 掉，不能用空串兜底。
// 不要在规范化里做大小写折叠：大小写敏感平台会把两个真实文件合并。
// 本函数不做 URL 解码，artifact URI 由上层另行处理。
function normalizePath(path: string, workspacePath: string): string | null {
  const decodedPath = path.trim().replace(/\\/g, "/");
  if (!decodedPath || decodedPath.includes("\n")) {
    return null;
  }

  const normalizedWorkspace = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalizedWorkspace && decodedPath.startsWith(`${normalizedWorkspace}/`)) {
    return decodedPath.slice(normalizedWorkspace.length + 1);
  }

  if (isAbsoluteFilePath(decodedPath)) {
    return decodedPath.replace(/^\/+/, "");
  }

  return decodedPath.replace(/^\.?\//, "");
}

// [契约] 目录路径在 normalizePath 之后还要去掉尾斜杠，否则 src 与 src/ 会被记成两行。
// 空串结果返回 null：根目录事件不能退化成“整个 workspace”。
// 不要在这里补 workspace 前缀：展示层已按相对路径渲染。
// 目录规范化只允许这一处实现，文件路径不得借用。
// 多次尾斜杠要一次去净，正则用 /+$ 而不是单个斜杠。
function normalizeDirectoryPath(path: string, workspacePath: string): string | null {
  const normalizedPath = normalizePath(path, workspacePath);
  return normalizedPath?.replace(/\/+$/, "") || null;
}

// [契约] 工具名解析顺序固定：identity → title → kind → tool，前者优先。
// title 是展示文案，只在 identity 缺席时兜底，不能反过来覆盖 identity。
// 返回空串会让 UI 无法分组，因此最后必须有 tool 字面量兜底。
// 这里只读 identity，不缓存解析结果：toolCall 是不可变入参。
// toolName 只用于展示与事件标记，不参与动作判定。
function getToolName(toolCall: TaskChatToolCall): string {
  const identity = resolveToolCallIdentity(toolCall);
  return (identity.toolName ?? toolCall.title?.trim()) || toolCall.kind || "tool";
}

function getSemanticText(toolCall: TaskChatToolCall): string {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawInput = raw && isPlainRecord(raw.rawInput) ? raw.rawInput : null;
  const rawTitle = raw && typeof raw.title === "string" ? raw.title : "";
  const rawKind = raw && typeof raw.kind === "string" ? raw.kind : "";
  const inputAction = readStringField(toolCall.input, [
    "action",
    "operation",
    "mode",
    "kind",
    "title",
  ]);
  const rawInputAction = readStringField(rawInput, [
    "action",
    "operation",
    "mode",
    "kind",
    "title",
  ]);
  return [toolCall.kind, toolCall.title, rawKind, rawTitle, inputAction, rawInputAction]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function getMutationSemanticText(toolCall: TaskChatToolCall): string {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawInput = raw && isPlainRecord(raw.rawInput) ? raw.rawInput : null;
  const rawKind = raw && typeof raw.kind === "string" ? raw.kind : "";
  const inputAction = readStringField(toolCall.input, ["action", "operation", "mode", "kind"]);
  const rawInputAction = readStringField(rawInput, ["action", "operation", "mode", "kind"]);
  return [toolCall.kind, rawKind, inputAction, rawInputAction]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

// [契约] 读动作先看 identity.family，再看语义词；两套判定不能交换顺序。
// family 为 search/web-fetch 时，Glob 归目录语义，其余按 search 处理。
// 语义正则必须带词边界：否则 read 会命中 already，list 会命中 blacklist。
// directory 判定必须排在 search 之前：ls/list 同时含搜索词根，顺序反了会误判。
// 返回 null 表示“不是读”，调用方据此不产生 view 事件。
// 不要在这里读路径候选：动作判定与路径解析分离才能复用候选源。
// 新增工具族优先补 identity，不要往正则里堆特例。
// 正则全部带 i 之后仍要保持词边界，避免中文路径文本误命中。
function inferReadAction(toolCall: TaskChatToolCall): "file" | "directory" | "search" | null {
  const identity = resolveToolCallIdentity(toolCall);
  if (identity.family === "file-read") {
    return "file";
  }
  if (identity.family === "search" || identity.family === "web-fetch") {
    return identity.toolName === "Glob" ? "directory" : "search";
  }

  const semanticText = getSemanticText(toolCall);
  if (/\b(ls|list|readdir|tree)\b/.test(semanticText)) {
    return "directory";
  }
  if (/\b(search|grep|rg|ripgrep|find|glob)\b/.test(semanticText)) {
    return "search";
  }
  if (/\b(read|view|open|cat|head|tail)\b/.test(semanticText)) {
    return "file";
  }
  return null;
}

// [契约] 路径候选来自两组键：直接路径字段优先，数组字段其次。
// 直接字段用 readStringField 的键序优先级，第一个非空即返回，后面的不再看。
// 数组字段接受字符串与对象两种形态，嵌套对象只取 path 家族键。
// 用 Set 去重并保持插入序：后续 [...] 的稳定顺序依赖它。
// 不要递归展开任意深度：无界递归会让恶意输出耗尽调用栈。
// cwd 也在候选里：工具可能只报工作目录，由规范化阶段决定是否可用。
// matches/results 是搜索结果专用键，读取器保持通用，由调用方选来源。
// 返回空数组而不是 null，调用方无需判空。
// 数组元素里的空白字符串与空对象都要跳过。
function readPathCandidates(value: unknown): string[] {
  if (!isPlainRecord(value)) {
    return [];
  }

  const paths = new Set<string>();
  const directPath = readStringField(value, [
    "path",
    "filePath",
    "file_path",
    "targetPath",
    "target_path",
    "sourcePath",
    "source_path",
    "oldPath",
    "old_path",
    "newPath",
    "new_path",
    "filename",
    "file",
    "directory",
    "dir",
    "cwd",
  ]);
  if (directPath) {
    paths.add(directPath);
  }

  for (const key of ["paths", "files", "filePaths", "file_paths", "matches", "results"] as const) {
    const candidate = value[key];
    if (!Array.isArray(candidate)) {
      continue;
    }
    for (const item of candidate) {
      if (typeof item === "string" && item.trim()) {
        paths.add(item);
      } else {
        const nestedPath = readStringField(item, [
          "path",
          "filePath",
          "file_path",
          "filename",
          "file",
        ]);
        if (nestedPath) {
          paths.add(nestedPath);
        }
      }
    }
  }

  return [...paths];
}

// [契约] 候选合并顺序：input → output → rawInput → rawOutput → raw，去重由调用方做。
// input 在前是因为写入类工具的真实目标是入参，不是输出回显。
// raw 放最后：它的键最杂，最容易把无关字段当成路径。
// 这里只收集不判定，动作与 target 由 collect* 决定。
// search 命中用单独函数，只取 output：范围参数不是命中文件。
// 所有来源都先过 isPlainRecord，非对象直接贡献空数组。
// 不要在合并时规范化路径：规范化必须由消费方统一执行一次。
function readToolCallPathCandidates(toolCall: TaskChatToolCall): string[] {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawInput = raw && isPlainRecord(raw.rawInput) ? raw.rawInput : null;
  const rawOutput = raw && isPlainRecord(raw.rawOutput) ? raw.rawOutput : null;
  return [
    ...readPathCandidates(toolCall.input),
    ...readPathCandidates(toolCall.output),
    ...readPathCandidates(rawInput),
    ...readPathCandidates(rawOutput),
    ...readPathCandidates(raw),
  ];
}

function readSearchResultPathCandidates(toolCall: TaskChatToolCall): string[] {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawOutput = raw && isPlainRecord(raw.rawOutput) ? raw.rawOutput : null;
  return [...readPathCandidates(toolCall.output), ...readPathCandidates(rawOutput)];
}

function readSearchScopePathCandidates(toolCall: TaskChatToolCall): string[] {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawInput = raw && isPlainRecord(raw.rawInput) ? raw.rawInput : null;
  return [...readPathCandidates(toolCall.input), ...readPathCandidates(rawInput)];
}

function readStructuredChangeStats(value: unknown): {
  added: number;
  removed: number;
} {
  const added = readNumberField(value, ["added", "additions", "insertions", "linesAdded"]) ?? 0;
  const removed = readNumberField(value, ["removed", "deletions", "deleted", "linesRemoved"]) ?? 0;
  return { added, removed };
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (isPlainRecord(value)) {
    return value;
  }

  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// [契约] delete/remove 必须先于 create/update 匹配，否则删除会被记成写入。
// update/edit/modify 统一映射 modify，不要新增同义分支。
// 未知类型返回 null，表示“没有结构化结论”，由上层继续回退。
// 比较前 trim 并转小写：协议里的 type 大小写并不稳定。
// undefined 直接走 default，不要用空串参与 switch。
// 映射表是唯一事实源，调用点不得重复写字符串比较。
function mapRawContentTypeToAction(type: string | undefined): TreemappingEventAction | null {
  switch (type?.trim().toLowerCase()) {
    case "create":
    case "add":
    case "write":
      return "write";
    case "delete":
    case "remove":
    case "removed":
      return "delete";
    case "update":
    case "edit":
    case "modify":
      return "modify";
    default:
      return null;
  }
}

function readRawOutputContentAction(toolCall: TaskChatToolCall): TreemappingEventAction | null {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawOutput = raw && isPlainRecord(raw.rawOutput) ? raw.rawOutput : null;
  const output = isPlainRecord(toolCall.output) ? toolCall.output : null;

  for (const source of [rawOutput, output]) {
    const content = parseJsonRecord(source?.content);
    const action = mapRawContentTypeToAction(
      typeof content?.type === "string" ? content.type : undefined,
    );
    if (action) {
      return action;
    }
  }

  return null;
}

function inferMutationAction(toolCall: TaskChatToolCall): TreemappingEventAction | null {
  const identity = resolveToolCallIdentity(toolCall);
  if (identity.family === "file-write") {
    return identity.toolName === "Write" ? "write" : "modify";
  }

  const semanticText = getMutationSemanticText(toolCall);
  if (/\b(delete|remove|unlink|rm)\b/.test(semanticText)) {
    return "delete";
  }
  if (/\b(create|write)\b/.test(semanticText)) {
    return "write";
  }
  if (/\b(edit|multiedit|patch|replace|update|apply_patch)\b/.test(semanticText)) {
    return "modify";
  }
  return null;
}

// [聚合] 目录只累计 views 与最后触达时间，不记增删行数。
// existing.views 只在 action=view 时 +1：其他动作进目录说明是宿主补的路径。
// lastTouchedAt 取 max：事件不保证按时间到达，直接赋值会让时间倒退。
// events 全量保留：UI 需要按事件展开，不能只留聚合值。
// 目录与文件用两个 Map：同一路径可能既是文件又是目录，合并会互相污染。
// Map key 必须是规范化后的路径，禁止在聚合层再做一次 normalize。
// 新条目的 events 初值必须是单元素数组，不能与调用方共享同一个数组实例。
// 聚合层不做任何过滤：能否记账由 collect* 决定。
function addDirectoryEvent(
  directories: Map<string, TreemappingDirectoryActivity>,
  event: TreemappingActivityEvent,
) {
  const existing = directories.get(event.path);
  if (existing) {
    existing.views += event.action === "view" ? 1 : 0;
    existing.lastTouchedAt = Math.max(existing.lastTouchedAt, event.timestamp);
    existing.events.push(event);
    return;
  }

  directories.set(event.path, {
    path: event.path,
    views: event.action === "view" ? 1 : 0,
    lastTouchedAt: event.timestamp,
    events: [event],
  });
}

// [聚合] kind 只升不降：deleted > written > modified > viewed。
// 优先级表是唯一事实源，不要在调用点写 if 链。
// 同一文件先 view 后 write 应显示 written；先 write 后 view 仍是 written。
// 删除后再被读取仍保持 deleted：这是“当前 workspace 已不存在”的结论。
// 新增 kind 时必须同时补优先级与 addFileEvent 的映射，否则会被静默当成 viewed。
// 相等时返回 current，保持对象引用不变。
// 优先级数值不要复用业务枚举下标：顺序调整必须显式改表。
// 本函数无副作用，可安全用于任意顺序的事件流。
function mergeKind(current: TreemappingFileKind, next: TreemappingFileKind): TreemappingFileKind {
  const priority: Record<TreemappingFileKind, number> = {
    deleted: 4,
    written: 3,
    modified: 2,
    viewed: 1,
  };
  return priority[next] > priority[current] ? next : current;
}

// [聚合] added/removed 按事件累加，不用 max：多次编辑的行数必须相加。
// views 只统计 view 动作；pendingToolCallIds 去重后再 push，否则角标虚高。
// lastTouchedAt 取 max，理由与目录聚合一致。
// 新条目的 pendingToolCallIds 必须由 event.pending 决定初值，不能恒为空。
// events 保留原始事件对象，聚合值只用于排序与展示。
// kind 计算与 mergeKind 是两件事：前者把 action 映射成 kind，后者处理冲突。
// 先算 kind 再读 existing：新条目与已有条目必须走同一套映射。
// 聚合层不 normalize 路径、不改 event，入参视为不可变。
function addFileEvent(
  files: Map<string, TreemappingFileActivity>,
  event: TreemappingActivityEvent,
) {
  const kind: TreemappingFileKind =
    event.action === "write"
      ? "written"
      : event.action === "modify"
        ? "modified"
        : event.action === "delete"
          ? "deleted"
          : "viewed";
  const existing = files.get(event.path);
  if (existing) {
    existing.kind = mergeKind(existing.kind, kind);
    existing.added += event.added;
    existing.removed += event.removed;
    existing.views += event.action === "view" ? 1 : 0;
    existing.lastTouchedAt = Math.max(existing.lastTouchedAt, event.timestamp);
    existing.events.push(event);
    if (event.pending && !existing.pendingToolCallIds.includes(event.toolCallId)) {
      existing.pendingToolCallIds.push(event.toolCallId);
    }
    return;
  }

  files.set(event.path, {
    path: event.path,
    kind,
    added: event.added,
    removed: event.removed,
    views: event.action === "view" ? 1 : 0,
    pendingToolCallIds: event.pending ? [event.toolCallId] : [],
    lastTouchedAt: event.timestamp,
    events: [event],
  });
}

// [契约] writable 事件来自 readRawToolCallFileSummaries，这是文件变更的唯一权威来源。
// rawOutputContentAction 优先于 actionLabel：结构化 type 比展示文案可信。
// 只有 actionLabel=Created 或 operationKind=write 才记 write，title 不参与判定。
// title 是展示文案，kind=edit/title=Write 组合会把修改误染成写入。
// changeStat 缺失时用 1 行兜底：write 记 1 行新增，delete 记 1 行删除。
// summary.path 必须经 normalizePath，空路径条目直接丢弃而不是造空文件行。
// toolCallId 用 toolId：它是事件关联与 pending 去重的键。
// timestamp 用 startedAt，缺失才回退 Date.now()，避免同一调用的事件时间漂移。
// pending 由状态集合决定，不读 summary 字段。
// 返回数组可能为空，调用方用长度判断是否继续走 fallback。
// 不要在 map 里修改 summary 对象：它可能被多个消费者共享。
// toolName 在循环外算一次：解析 identity 有成本且结果稳定。
// action 的三元嵌套顺序是 delete → write → modify，调换会让删除变成修改。
// 过滤 null 的谓词必须保留，它同时收窄了 map 返回类型。
// 上报给 readRawToolCallFileSummaries 的字段要全量透传，缺一项都会让摘要退化。
function collectWritableEvents(
  toolCall: TaskChatToolCall,
  workspacePath: string,
): TreemappingActivityEvent[] {
  const pending = ACTIVE_TOOL_CALL_STATUSES.has(toolCall.status);
  const timestamp = toolCall.startedAt ?? Date.now();
  const toolName = getToolName(toolCall);
  const rawOutputContentAction = readRawOutputContentAction(toolCall);
  return readRawToolCallFileSummaries(toolCall.raw, {
    toolName: toolCall.toolName,
    kind: toolCall.kind,
    input: toolCall.input,
    output: toolCall.output,
    raw: toolCall.raw,
  })
    .map((summary) => {
      const path = normalizePath(summary.path, workspacePath);
      if (!path) {
        return null;
      }
      const action: TreemappingEventAction =
        rawOutputContentAction ??
        (summary.actionLabel === "Deleted"
          ? "delete"
          : // ZCode agent 会返回 kind=edit/title=Write/rawOutput.content.type=update。
            // title 只是展示文案，不能作为写入兜底；这里只信任结构化变更类型，避免 edit 被误染成 write。
            summary.actionLabel === "Created" || summary.operationKind === "write"
            ? "write"
            : summary.operationKind === "delete"
              ? "delete"
              : "modify");
      return {
        toolCallId: toolCall.toolId,
        toolName,
        action,
        path,
        target: "file" as const,
        added: summary.changeStat?.added ?? (action === "write" ? 1 : 0),
        removed: summary.changeStat?.removed ?? (action === "delete" ? 1 : 0),
        timestamp,
        pending,
      };
    })
    .filter((event): event is Exclude<typeof event, null> => event !== null);
}

// [契约] 读事件先由 inferReadAction 决定是否有 view，null 直接返回空数组。
// search 且没有任何结果路径时按目录记账：否则会伪造一个空文件。
// target=directory 时路径走 normalizeDirectoryPath，file 走 normalizePath。
// 搜索范围路径只作回退：结果缺席时才用它表示“扫过这个目录”。
// 路径集合用 Set 去重后再映射，保证同一调用不产生重复 view。
// search 的 result 与 scope 使用不同候选源，不能合并成一个读取器。
// view 事件的 added/removed 恒为 0：读取不改变行数。
// pending 与 timestamp 的计算必须与写入事件一致，避免同一调用两种时间。
// 同一 toolCallId 下不同 path 是合法事件，不要按调用去重。
// target 的判定要在取路径之前完成：它决定用哪个规范化函数。
// rawPaths 为空时回退 scope，是 search 语义特有的分支，directory/file 不适用。
// 返回的数组顺序来自 Set 插入序，调用方不得依赖它做展示排序。
function collectReadEvents(
  toolCall: TaskChatToolCall,
  workspacePath: string,
): TreemappingActivityEvent[] {
  const readAction = inferReadAction(toolCall);
  if (!readAction) {
    return [];
  }

  const pending = ACTIVE_TOOL_CALL_STATUSES.has(toolCall.status);
  const timestamp = toolCall.startedAt ?? Date.now();
  const toolName = getToolName(toolCall);
  const rawPaths =
    readAction === "search"
      ? readSearchResultPathCandidates(toolCall)
      : readToolCallPathCandidates(toolCall);
  const target =
    readAction === "directory"
      ? "directory"
      : readAction === "search" && rawPaths.length === 0
        ? "directory"
        : "file";
  const paths = new Set(
    (rawPaths.length > 0 ? rawPaths : readSearchScopePathCandidates(toolCall))
      .map((path) =>
        target === "directory"
          ? normalizeDirectoryPath(path, workspacePath)
          : normalizePath(path, workspacePath),
      )
      .filter((path): path is string => Boolean(path)),
  );

  return [...paths].map((path) => ({
    toolCallId: toolCall.toolId,
    toolName,
    action: "view" as const,
    path,
    target,
    added: 0,
    removed: 0,
    timestamp,
    pending,
  }));
}

// [契约] 结构化 exec 只在 writable 为空时调用，避免与文件摘要重复记账。
// sources 顺序 output → rawOutput → raw，同一 changes 可能多层出现。
// changes 的 key 是原始路径，必须规范化后再判断可用性。
// type=add 记 write，type=delete 记 delete，其余一律 modify。
// stats 缺失时为 0：exec 没有行数信息时不能凭空造 1 行。
// 非 plain record 的 change 直接跳过，不做类型断言。
// changes 必须是 plain record 才遍历，数组形式的输出不当作变更表。
// 本函数不做去重：重复记账的防线在调用方的互斥条件上。
function collectStructuredExecEvents(
  toolCall: TaskChatToolCall,
  workspacePath: string,
): TreemappingActivityEvent[] {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawOutput = raw && isPlainRecord(raw.rawOutput) ? raw.rawOutput : null;
  const sources = [toolCall.output, rawOutput, raw].filter(isPlainRecord);
  const events: TreemappingActivityEvent[] = [];
  const pending = ACTIVE_TOOL_CALL_STATUSES.has(toolCall.status);
  const timestamp = toolCall.startedAt ?? Date.now();
  const toolName = getToolName(toolCall);

  for (const source of sources) {
    const changes = isPlainRecord(source.changes) ? source.changes : null;
    if (!changes) {
      continue;
    }

    for (const [rawPath, change] of Object.entries(changes)) {
      const path = normalizePath(rawPath, workspacePath);
      if (!path || !isPlainRecord(change)) {
        continue;
      }
      const changeType = typeof change.type === "string" ? change.type : "";
      const stats = readStructuredChangeStats(change);
      events.push({
        toolCallId: toolCall.toolId,
        toolName,
        action: changeType === "add" ? "write" : changeType === "delete" ? "delete" : "modify",
        path,
        target: "file",
        added: stats.added,
        removed: stats.removed,
        timestamp,
        pending,
      });
    }
  }

  return events;
}

function collectFallbackMutationEvents(
  toolCall: TaskChatToolCall,
  workspacePath: string,
): TreemappingActivityEvent[] {
  const action = inferMutationAction(toolCall);
  if (!action) {
    return [];
  }

  const pending = ACTIVE_TOOL_CALL_STATUSES.has(toolCall.status);
  const timestamp = toolCall.startedAt ?? Date.now();
  const toolName = getToolName(toolCall);
  const paths = new Set(
    readToolCallPathCandidates(toolCall)
      .map((path) => normalizePath(path, workspacePath))
      .filter((path): path is string => Boolean(path)),
  );

  return [...paths].map((path) => ({
    toolCallId: toolCall.toolId,
    toolName,
    action,
    path,
    target: "file" as const,
    added: action === "write" ? 1 : 0,
    removed: action === "delete" ? 1 : 0,
    timestamp,
    pending,
  }));
}

// [入口] 事件拼装顺序固定：writable → structured → fallback mutation → read，前三者互斥。
// structured 与 fallback 都挂在 writable.length===0 上：writable 有结论时它们只会重复。
// read 事件始终追加：同一调用既写又读时两者都要记。
// events 为空且状态活跃时只累加 runningWithoutPathCount，不建行。
// 事件按 target 分流到两个 Map，最后统一排序输出。
// files 与 directories 都按 path 的 localeCompare：Map 插入序受工具顺序影响。
// 返回的是新数组，调用方可以安全排序或裁剪。
// message 为 null 时返回空模型而不是抛错：未开始的会话也要能渲染空态。
// workspacePath 必须原样传给每个 collect*：混用不同 workspace 会让前缀剥离错乱。
// 不要在这里做去重或二次聚合：聚合只发生在 add*Event。
// runningWithoutPathCount 只统计活跃调用，已结算的无路径调用不进角标。
// toolCalls 的遍历顺序就是事件顺序，不要为了“稳定”而预先排序入参。
export function buildTreemappingActivityModel(
  message: TaskChatMessage | null,
  workspacePath: string,
): TreemappingActivityModel {
  const files = new Map<string, TreemappingFileActivity>();
  const directories = new Map<string, TreemappingDirectoryActivity>();
  let runningWithoutPathCount = 0;

  for (const toolCall of message?.toolCalls ?? []) {
    const writableEvents = collectWritableEvents(toolCall, workspacePath);
    const events = [
      ...writableEvents,
      ...(writableEvents.length === 0 ? collectStructuredExecEvents(toolCall, workspacePath) : []),
      ...(writableEvents.length === 0
        ? collectFallbackMutationEvents(toolCall, workspacePath)
        : []),
      ...collectReadEvents(toolCall, workspacePath),
    ];

    if (events.length === 0 && ACTIVE_TOOL_CALL_STATUSES.has(toolCall.status)) {
      runningWithoutPathCount += 1;
      continue;
    }

    for (const event of events) {
      if (event.target === "directory") {
        addDirectoryEvent(directories, event);
      } else {
        addFileEvent(files, event);
      }
    }
  }

  return {
    files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
    directories: [...directories.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    runningWithoutPathCount,
  };
}
