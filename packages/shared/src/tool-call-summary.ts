// INV-01 位置：文件首行的五态联合；守住：状态字符串只能取 input-available、input-streaming、output-available、output-denied、output-error；改错：映射表缺键、类型收窄失效。
// INV-02 位置：ToolCallSummarySource 的字段声明；守住：kind 必填且是唯一分支依据，其余字段可缺省；改错：调用方漏传 kind 会让统计与摘要同时退化。
// INV-03 位置：ToolCallChangeStat 结构；守住：只保留 added 与 removed 两个数值，不扩散字段；改错：上层读取不存在的字段得到 undefined。
// INV-04 位置：ToolCallSummary 结构；守住：primaryText 必有值，secondaryText 与 changeStat 可缺省；改错：渲染出空白主标题。
// INV-05 位置：运行态集合；守住：只含 input-streaming 与 input-available，并与完成态集合互斥；改错：同一状态同时被判为运行中与已完成。
// INV-06 位置：完成态集合；守住：output-denied 也属于完成；改错：被拒绝的工具调用永久显示为运行中。
// INV-07 位置：状态到 i18n key 的映射表；守住：五态一个不漏，键必须是 i18n key 而非最终文案；改错：新增状态时映射静默缺失并落到兜底。
// INV-08 位置：isRecord 收窄函数；守住：null 与数组一律排除；改错：数组被当成记录，读取命名字段得到 undefined。
// INV-09 位置：normalizeDisplayText；守住：只压缩空白与去首尾，结果仍可能为空串；改错：空串被当作有效标题。
// INV-10 位置：countLines；守住：空串返回 0，末尾换行回退一；改错：空 diff 被算成一行。
// INV-11 位置：readFirstStringField；守住：按 keys 顺序取第一个字符串，非字符串继续找；改错：数字或对象字段被丢弃或提前中断。
// INV-12 位置：extractBeforeAfterText；守住：扁平字段、metadata.filediff、content 数组三层来源按序尝试，且 before 与 after 必须同时存在；改错：只有单侧时返回半份 diff。
// INV-13 位置：getChangeStat 的 kind 正则门禁；守住：只有编辑类工具才统计增删；改错：读取类工具被误标增删行。
// INV-14 位置：diff 来源回退链；守住：按 input、output、raw 顺序取首个可用来源后即停；改错：优先级倒置导致统计口径漂移。
// INV-15 位置：零变更早返回；守住：added 与 removed 同时为 0 时返回 undefined；改错：界面出现加零减零的徽标。
// INV-16 位置：getInputSummary 的候选键顺序；守住：command、path、file_path、filePath、prompt 依次尝试，空白摘要视为缺失；改错：空字符串占位挤掉真实摘要。
// INV-17 位置：两个状态判断的类型谓词；守住：入参是宽 string，必须经受控断言收窄；改错：任意字符串被当成合法状态。
// INV-18 位置：getCompactToolCallSummary 汇总出口；守住：标题归一后为空时兜底为 tool；改错：无标题调用渲染出空行。
//
// 模块职责：把工具调用状态与原始 input/output 归一为展示用摘要，纯函数、无 IO、无外部状态。
// 状态所有权：五态联合与两个集合在本文件唯一定义，调用方只读取不复制，避免出现多份状态真值。
// 阅读顺序：状态类型与集合 → 记录与计数工具 → diff 提取与统计 → 状态判断与摘要出口。
export type CompactToolCallState =
  | "input-available"
  | "input-streaming"
  | "output-available"
  | "output-denied"
  | "output-error";

// 对外契约：title、kind、input、output、raw 全部来自调用方原始载荷，本模块不假设其形状
// kind 必填且是唯一用于分支判断的字段，缺失会让增删统计与输入摘要同时退化
// input、output、raw 声明为 unknown，任何字段读取前必须先经 isRecord 收窄，禁止直接下标
// 除 kind 外全部可缺省，因为流式事件与持久化记录都可能只带部分字段
// 改错示例：把 input 收窄成固定结构，会对非编辑类工具产生运行期误判
export interface ToolCallSummarySource {
  title?: string;
  kind: string;
  input: unknown;
  output?: unknown;
  raw?: unknown;
}

export interface ToolCallChangeStat {
  added: number;
  removed: number;
}

export interface ToolCallSummary {
  primaryText: string;
  secondaryText?: string;
  changeStat?: ToolCallChangeStat;
}

// 运行态集合决定界面是否展示进行中动画，input-streaming 与 input-available 都算未完成
// 完成态集合覆盖 output-available、output-error、output-denied 三态，被拒绝同样属于终态
// 两个集合必须互斥且并集等于五态全集，新增状态时两处都要同步
// 用模块级 Set 常量而非函数内字面量，保证判断零分配且引用稳定
// 改错：把 output-denied 从完成态移除，被拒调用会永久停留在运行中
const TOOL_CALL_RUNNING_STATES = new Set<CompactToolCallState>([
  "input-streaming",
  "input-available",
]);

const TOOL_CALL_FINISHED_STATES = new Set<CompactToolCallState>([
  "output-available",
  "output-error",
  "output-denied",
]);

// Record 以五态为键，编译期强制映射完整，新增状态不补键会直接类型报错
// 值是 i18n key 而非最终文案，文案与状态解耦，便于多语言切换
// stopped 不在这五态内，属于运行时额外传入的原始状态，由出口函数单独短路处理
// 改错：把 key 直接写成中文文案，会绕过 i18n 并在非中文环境错乱
const TOOL_CALL_STATUS_MESSAGE_IDS: Record<CompactToolCallState, string> = {
  "input-streaming": "chat.toolCall.status.pending",
  "input-available": "chat.toolCall.status.running",
  "output-available": "chat.toolCall.status.completed",
  "output-error": "chat.toolCall.status.failed",
  "output-denied": "chat.toolCall.status.denied",
};

// 只把普通对象视为记录，null 与数组必须排除，否则空值会让后续字段读取失败
// 排除数组的原因：载荷里的 content 等字段既可能是数组也可能是对象
// 判断顺序是先 typeof 后判 null，因为 typeof null 的历史行为是 object
// 改错：漏掉数组判断，索引访问会返回数组元素，被误当作命名字段
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDisplayText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

// 空串计 0 行，避免把空 diff 当成有内容的一行
// 逐字符比较 charCode 10 统计换行，比切分字符串少一次数组分配
// 末尾若是换行则回退一，使有无尾换行的同一片段得到相同行数
// 改错：去掉末尾回退，所有以换行结尾的片段行数都会多一行
function countLines(value: string): number {
  if (value.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 10) count++;
  }
  if (value.charCodeAt(value.length - 1) === 10) count--;
  return count;
}

function readFirstStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return undefined;
}

// diff 文本来源有三种：扁平字段、metadata.filediff 嵌套、content 数组块
// 三层按顺序尝试，命中即返回，避免不同来源互相覆盖
// before 与 after 必须同时存在才成立，只有单侧说明不是完整的替换语义
// 嵌套层只认 filediff 键，不递归任意深度，防止异常载荷无限下钻
// content 数组只扫描对象元素，非对象块直接跳过而不是报错
// 改错：把单侧也算成功，会拿空串参与行数统计，产出错误的增删数字
function extractBeforeAfterText(source: unknown): { before: string; after: string } | null {
  if (!isRecord(source)) {
    return null;
  }

  const before = readFirstStringField(source, ["old_string", "oldString", "oldText", "before"]);
  const after = readFirstStringField(source, [
    "new_string",
    "newString",
    "newText",
    "after",
    "content",
  ]);
  if (before !== undefined && after !== undefined) {
    return { before, after };
  }

  const metadata = source["metadata"];
  if (isRecord(metadata)) {
    const fileDiff = metadata["filediff"];
    if (isRecord(fileDiff)) {
      const nestedBefore = readFirstStringField(fileDiff, [
        "old_string",
        "oldString",
        "oldText",
        "before",
      ]);
      const nestedAfter = readFirstStringField(fileDiff, [
        "new_string",
        "newString",
        "newText",
        "after",
        "content",
      ]);
      if (nestedBefore !== undefined && nestedAfter !== undefined) {
        return { before: nestedBefore, after: nestedAfter };
      }
    }
  }

  const contentBlocks = source["content"];
  if (Array.isArray(contentBlocks)) {
    for (const block of contentBlocks) {
      if (!isRecord(block)) {
        continue;
      }
      const blockBefore = readFirstStringField(block, [
        "old_string",
        "oldString",
        "oldText",
        "before",
      ]);
      const blockAfter = readFirstStringField(block, [
        "new_string",
        "newString",
        "newText",
        "after",
        "content",
      ]);
      if (blockBefore !== undefined && blockAfter !== undefined) {
        return { before: blockBefore, after: blockAfter };
      }
    }
  }

  return null;
}

// 先用 kind 正则做门禁，只有编辑类工具才可能产生增删统计
// multi.?edit 允许中间一个任意字符，兼容 multi_edit 与 multiEdit 等命名
// 来源按 input、output、raw 依次回退，首个可用者决定本次统计口径
// 两侧都为 0 行时返回 undefined，让上层不渲染零变更徽标
// 改错：去掉 kind 门禁，读取类工具的 input 也会被当成 diff 统计
function getChangeStat(
  kind: string,
  input: unknown,
  output?: unknown,
  raw?: unknown,
): ToolCallChangeStat | undefined {
  if (!/(edit|patch|replace|multi.?edit)/i.test(kind)) return undefined;

  const changeSource =
    extractBeforeAfterText(input) ?? extractBeforeAfterText(output) ?? extractBeforeAfterText(raw);
  if (!changeSource) return undefined;

  const removed = countLines(changeSource.before);
  const added = countLines(changeSource.after);
  if (added === 0 && removed === 0) return undefined;

  return { added, removed };
}

function getInputSummary(input: unknown): string | undefined {
  if (typeof input === "string") {
    const summary = normalizeDisplayText(input);
    return summary.length > 0 ? summary : undefined;
  }

  if (!isRecord(input)) {
    return undefined;
  }

  for (const key of ["command", "path", "file_path", "filePath", "prompt"] as const) {
    const candidate = input[key];
    if (typeof candidate !== "string") {
      continue;
    }

    const summary = normalizeDisplayText(candidate);
    if (summary.length > 0) {
      return summary;
    }
  }

  return undefined;
}

export function isCompactToolCallRunningState(state: string): state is CompactToolCallState {
  return TOOL_CALL_RUNNING_STATES.has(state as CompactToolCallState);
}

export function isCompactToolCallFinishedState(state: string): state is CompactToolCallState {
  return TOOL_CALL_FINISHED_STATES.has(state as CompactToolCallState);
}

// stopped 是运行时额外传入的原始状态，优先于五态映射返回独立文案
// 其余状态走映射表查值，未知值兜底为 pending，保证永远有可展示文案
// 改错：把 stopped 并入五态，会污染状态集合与进行中判断
export function getCompactToolCallStatusMessageId(state: string, rawStatus?: string): string {
  if (rawStatus === "stopped") {
    return "chat.toolCall.status.stopped";
  }

  return (
    TOOL_CALL_STATUS_MESSAGE_IDS[state as CompactToolCallState] ?? "chat.toolCall.status.pending"
  );
}

// 对外唯一汇总出口：一次取齐 changeStat、primaryText、secondaryText 三个字段
// 标题经空白归一后仍为空时兜底为 tool，保证主文案永远非空
// 输入摘要只从 input 提取，缺失时为 undefined，交给上层决定是否展示
export function getCompactToolCallSummary({
  title,
  kind,
  input,
  output,
  raw,
}: ToolCallSummarySource): ToolCallSummary {
  const changeStat = getChangeStat(kind, input, output, raw);
  const primaryText = (title && normalizeDisplayText(title)) || "tool";
  const secondaryText = getInputSummary(input);
  return {
    primaryText,
    secondaryText,
    changeStat,
  };
}
