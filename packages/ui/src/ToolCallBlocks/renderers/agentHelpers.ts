// INV-01 [失败路径] 语言包缺配时必须回落到稳定术语而非内部 key；守住位置：formatAgentMessage 里 message === id 的判定与返回 fallback 的分支；改错故障：agent 工具块的界面直接显示 i18n key，测试断言与真实文案同时失效。
// INV-02 [契约] 记录判定统一收口在 isPlainRecord；守住位置：typeof 为 object、非 null、非 Array 这三个条件；改错故障：数组或 null 被当作记录按键取值，读到伪字段或直接抛错，整块渲染中断。
// INV-03 [契约] 字段读取必须跳过非字符串与纯空白；守住位置：readStringField 对 candidate 的类型判断与 trimmed.length > 0 的分支；改错故障：空白串被当成有效标签返回，标题位置出现看不见的空壳元素。
// INV-04 [契约] 文本提取的分支顺序不可调换；守住位置：readTextFromUnknown 中 string、Array、isPlainRecord 三段判断的先后；改错故障：先判记录会让数组与字符串走错分支，输出文本读成 undefined。
// INV-05 [失败路径] 空数组与全空子项必须返回 undefined 而不是空串；守住位置：readTextFromUnknown 数组分支结尾的 text || undefined；改错故障：返回空串让调用方的存在性判断失效，后台信息与活动内容被误判为已读到。
// INV-06 [失败路径] 嵌套读取必须先确认当前层是记录；守住位置：readStringFromNestedRecord 循环里的 isPlainRecord 判断与提前返回；改错故障：在字符串或数字上直接取字段，渲染期抛 TypeError，整个工具块白屏。
// INV-07 [失败路径] JSON 解析失败只能降级为 null；守住位置：parseJsonObject 的 try 块、isPlainRecord 结果判断与 catch 返回 null；改错故障：异常冒泡到渲染层，单条脏数据让整段会话崩溃。
// INV-08 [权衡] 记录已就绪时不得做序列化往返；守住位置：readRecordFromUnknown 先返回 isPlainRecord 命中的原值，仅文本才走解析；改错故障：把已有记录转成字符串再解析，字段丢失且每帧多一次无谓开销。
// INV-09 [契约] 昵称候选顺序固定为元数据、顶层字段、输入、输出；守住位置：readCodexSubagentNickname 里两次 readStringFromNestedRecord、isPlainRecord 输入分支与末尾解析输出；改错故障：输入优先会盖掉 runtime 写入的权威昵称，同一 agent 在不同帧显示不同名字。
// INV-10 [失败路径] 输出无文本时不得进入解析；守住位置：readCodexSubagentNickname 中 outputText 为空即返回 undefined 的提前分支；改错故障：空输出被反复解析，既拿不到昵称又浪费每帧解析成本。
// INV-11 [契约] 标题归一化才能识别实现名；守住位置：isImplementationToolTitle 的 trim、toLowerCase 与空格连字符替换，以及 agent、task、spawn_agent 三个比较值；改错故障：大小写或连字符变体漏判，工具名被当成任务标题展示给用户。
// INV-12 [契约] 类型标签的候选顺序以 runtime 权威值为首；守住位置：getAgentKindLabel 里 explicitName 的 nullish 链，authoritativeAgentType 排在 outputRecord 之前；改错故障：流式旧数据压过已投影的 subagentRow 类型，标签在流结束后仍显示旧值。
// INV-13 [并发] 流式半截 JSON 不允许触发默认类型回落；守住位置：getAgentKindLabel 结尾 rawRecord?.inputPreviewComplete === true 的三元判定；改错故障：首帧读不到 subagent_type 就报 general-purpose，随后跳成真实类型，标签闪烁。
// INV-14 [失败路径] 未完成预览时必须返回空串而非兜底标签；守住位置：getAgentKindLabel 三元表达式为假时返回的空字符串；改错故障：提前占用兜底文案，真实类型到达后无法区分占位与最终值。
// INV-15 [契约] 颜色必须经过白名单再交给样式层；守住位置：getAgentColor 返回前对 isSubagentColor 的判断及 undefined 分支；改错故障：任意色值拼进类名得到不存在的样式，徽标失去配色甚至整块变透明。
// INV-16 [契约] 后台判定只认三个入口；守住位置：readBackgroundAgentInfo 对 run_in_background、runInBackground 与 outputFile 的联合判断；改错故障：判定放宽后普通 agent 也被标记为后台，出现不该有的后台徽标。
// INV-17 [契约] 活动内容优先展示通知摘要；守住位置：getAgentActivityContent 先取 taskNotification 的 result 与 summary，最后才用 content；改错故障：直接展示 output_file 指向的 sidechain transcript，展开后是整段 JSONL。
// INV-18 [失败路径] 主文本与提示词都必须有稳定回落；守住位置：getAgentPrimaryText 末尾返回 fallbackLabel，以及 getAgentPrompt 两个输入分支都落空后返回 undefined；改错故障：标题为空导致整行只剩图标，提示词丢失导致详情抽屉空白。
//
// 模块职责：把 agent 工具调用的原始节点解析成类型标签、颜色、后台信息、活动摘要、主文本与提示词，供渲染层直接消费。
// 状态所有权：本文件全部是纯函数，不持有状态、不订阅 store，也不改写 toolCall，输入节点由上游投影层维护。
// 阅读顺序：先看三个类型别名与默认常量，再看形状归一化的底层读取函数，随后是按优先级组装的七个导出函数。
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { isSubagentColor } from "@/lib/subagentColors.js";

type AgentIntl = ReturnType<typeof useZCodeIntl>["intl"];
type AgentToolCall = ToolCallBlockRenderContext["toolCallNode"]["toolCall"];
const DEFAULT_AGENT_TYPE_LABEL = "general-purpose";

// [契约] 消息格式化只在语言包命中时使用返回值，未命中一律回落到调用方给出的稳定术语。
// [失败路径] 入参 id 是内部 i18n key，格式化结果与 id 相同即代表缺配，这个比较就是唯一的检测点。
// [权衡] 缺配不抛错也不打日志，宁可展示术语，也不让内部 key 与实现细节出现在界面上。
// [契约] isPlainRecord 是本文件所有字段读取的统一门禁，只有非空且非数组的对象才算记录。
// [边界] 数组被显式排除，避免把列表当记录按键取值，读到长度或下标这种伪字段。
// [契约] 该判定不复制也不冻结入参，只做形状确认，后续读取仍以调用方传入的原始引用为准。
export function formatAgentMessage(intl: AgentIntl, id: string, fallback: string) {
  const message = intl.formatMessage({ id });
  // agent 工具块的语言包一旦漏配，SSR/静态渲染会把内部 i18n key 原样打到 UI 上，
  // 不但测试断言会失败，真实界面也会直接暴露实现细节。这里统一回退到稳定术语。
  return message === id ? fallback : message;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// [契约] readStringField 按 keys 顺序取第一个非空字符串，返回值一律经过 trim，调用方无需二次清洗。
// [失败路径] 非字符串与纯空白都被跳过而不中断循环，全部落空才返回 undefined，由上层决定展示内容。
// [事务] readTextFromUnknown 的分支顺序是字符串、数组、记录，顺序颠倒会让不同形状走进错误的读取路径。
// [契约] 数组子项逐个递归后过滤空串并以换行拼接，整段为空则返回 undefined 而不是空字符串。
// [失败路径] readStringFromNestedRecord 逐层确认是记录才继续下钻，遇到基本类型立即返回 undefined，避免在原始值上取字段。
// [失败路径] parseJsonObject 用 try 包住解析，非对象结果与解析异常都收敛为 null，调用方无需再判类型。
// [权衡] readRecordFromUnknown 对已是记录的值直接透传，仅当输入是文本时才尝试解析，不做序列化再反序列化的往返。
function readStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate !== "string") {
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

function readTextFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (Array.isArray(value)) {
    const text = value
      .map((item) => readTextFromUnknown(item))
      .filter((item): item is string => typeof item === "string" && item.length > 0)
      .join("\n");
    return text || undefined;
  }

  if (!isPlainRecord(value)) {
    return undefined;
  }

  const text = readStringField(value, ["text"]);
  if (text) {
    return text;
  }

  return readTextFromUnknown(value.content);
}

function readStringFromNestedRecord(value: unknown, path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isPlainRecord(current)) {
      return undefined;
    }
    current = current[key];
  }

  return typeof current === "string" && current.trim().length > 0 ? current.trim() : undefined;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readRecordFromUnknown(value: unknown): Record<string, unknown> | null {
  if (isPlainRecord(value)) {
    return value;
  }

  const text = readTextFromUnknown(value);
  return text ? parseJsonObject(text) : null;
}

// [契约] 昵称读取按 _meta.zcode.nickname、顶层 nickname、输入 nickname、输出 JSON 的顺序取值，先命中先返回。
// [失败路径] 输出只在确实有文本时才解析，解析不到对象直接返回 undefined，不在每一帧对空输出做无谓解析。
// [契约] isImplementationToolTitle 先 trim 再小写并把空格与连字符归一为下划线，只把 agent、task、spawn_agent 视为实现名。
// [失败路径] 该判定用于丢弃工具的实现标题，漏判会让用户在主标题位置看到 agent 或 spawn_agent 这类内部名。
// [契约] readAgentNameFromRecord 与 readAgentPrimaryDescription 都是空值安全的薄封装，传入 null 直接返回 undefined。
// [契约] 名称候选把 agentType 系列排在 name 与 nickname 之前，描述候选把 description 放在最前，字段优先级即展示优先级。
function readCodexSubagentNickname(toolCall: AgentToolCall): string | undefined {
  const rawNickname =
    readStringFromNestedRecord(toolCall.raw, ["_meta", "zcode", "nickname"]) ??
    readStringFromNestedRecord(toolCall.raw, ["nickname"]);
  if (rawNickname) {
    return rawNickname;
  }

  if (isPlainRecord(toolCall.input)) {
    const inputNickname = readStringField(toolCall.input, ["nickname"]);
    if (inputNickname) {
      return inputNickname;
    }
  }

  const outputText = readTextFromUnknown(toolCall.output);
  if (!outputText) {
    return undefined;
  }

  const parsedOutput = parseJsonObject(outputText);
  if (!parsedOutput) {
    return undefined;
  }

  return readStringField(parsedOutput, ["nickname"]);
}

function isImplementationToolTitle(title: string): boolean {
  const normalized = title
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return normalized === "agent" || normalized === "task" || normalized === "spawn_agent";
}

function readAgentNameFromRecord(value: Record<string, unknown> | null): string | undefined {
  return value
    ? readStringField(value, [
        "agentType",
        "agent_type",
        "subagentType",
        "subagent_type",
        "name",
        "nickname",
      ])
    : undefined;
}

function readAgentPrimaryDescription(value: Record<string, unknown> | null): string | undefined {
  return value ? readStringField(value, ["description", "summary", "message"]) : undefined;
}

// [契约] 类型标签的候选顺序是权威 agentType、输出记录、codex 昵称、输入记录、raw 元数据，前者优先。
// [并发] 流式输入是半截 JSON，字段读不到不代表模型省略，只有 inputPreviewComplete 明确为真才允许回落默认标签。
// [失败路径] 未完成时返回空字符串而不是 general-purpose，避免首帧先报默认类型再跳成真实类型。
// [契约] 已投影的 subagentRow 类型来自 runtime，属于权威结果，必须排在所有解析结果之前。
// [权衡] 空字符串交由调用方决定是否隐藏标签，本函数不自行决定占位文案。
// [失败路径] 兜底标签为空时再用 DEFAULT_AGENT_TYPE_LABEL，保证非流式场景下标签不会整块消失。
// [契约] 三条 raw 元数据路径分别对应 agentType、agent_type、subagent_type 三种历史拼写，删除任一条都会漏掉一种来源。
// [事务] 所有读取都在返回前完成，函数本身无副作用，同一 toolCall 多次调用结果一致。
export function getAgentKindLabel(
  toolCall: AgentToolCall,
  fallbackLabel: string,
  authoritativeAgentType?: string,
) {
  const outputRecord = readRecordFromUnknown(toolCall.output);
  const inputRecord = isPlainRecord(toolCall.input) ? toolCall.input : null;
  const rawRecord = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawName =
    readStringFromNestedRecord(toolCall.raw, ["_meta", "zcode", "agentType"]) ??
    readStringFromNestedRecord(toolCall.raw, ["_meta", "zcode", "agent_type"]) ??
    readStringFromNestedRecord(toolCall.raw, ["_meta", "zcode", "subagent_type"]);

  // 流式 input 的半截 JSON 暂时读不到 subagent_type，若一读不到就按“模型省略字段”
  // 回退 general-purpose，首帧会误报、之后再跳成真实类型。只有 inputPreviewComplete 明确为 true
  // 才能确认字段确实省略；已投影的 subagentRow 类型则作为 runtime 权威结果优先展示。
  const explicitName =
    (authoritativeAgentType?.trim() || undefined) ??
    readAgentNameFromRecord(outputRecord) ??
    readCodexSubagentNickname(toolCall) ??
    readAgentNameFromRecord(inputRecord) ??
    rawName;
  if (explicitName) {
    return explicitName;
  }

  return rawRecord?.inputPreviewComplete === true ? fallbackLabel || DEFAULT_AGENT_TYPE_LABEL : "";
}

// [契约] 颜色按 raw 元数据、顶层 color、输入记录、输出记录的顺序取值，元数据优先级最高。
// [契约] 取到的值必须通过 isSubagentColor 白名单才返回，否则一律 undefined，不把任意字符串交给样式层。
// [失败路径] 漏掉白名单会让未知色值进入类名拼接，得到不存在的样式并让整个色板失效。
// [契约] readAgentColorFromRecord 同时接受 color、agentColor、agent_color 三种拼写，与上游字段命名保持一致。
// [权衡] 颜色缺失返回 undefined 而非默认色，默认色由渲染层统一决定，避免两处各写一份默认值。
export function getAgentColor(toolCall: AgentToolCall) {
  const outputRecord = readRecordFromUnknown(toolCall.output);
  const inputRecord = isPlainRecord(toolCall.input) ? toolCall.input : null;
  const rawColor =
    readStringFromNestedRecord(toolCall.raw, ["_meta", "zcode", "color"]) ??
    readStringFromNestedRecord(toolCall.raw, ["color"]) ??
    readAgentColorFromRecord(inputRecord) ??
    readAgentColorFromRecord(outputRecord);

  return rawColor && isSubagentColor(rawColor) ? rawColor : undefined;
}

function readAgentColorFromRecord(value: Record<string, unknown> | null): string | undefined {
  return value ? readStringField(value, ["color", "agentColor", "agent_color"]) : undefined;
}

// [契约] 后台判定只有三种入口：run_in_background 为真、runInBackground 为真、或能从通知与输出里解析出 output_file。
// [失败路径] 三者都不成立时返回 null，调用方据此不渲染后台标记，避免所有 agent 块都被当成后台任务。
// [契约] output_file 先取 taskNotification，再取 backgroundAgent，最后从输出文本按 output_file 前缀兜底。
// [契约] 活动内容优先取 taskNotification 的 result 再取 summary，最后才用 toolCall.content。
// [失败路径] 若直接展示 output_file 指向的 sidechain transcript，展开后是整段 JSONL，用户读不到完成摘要。
// [契约] 返回对象只含 outputFile 一个字段，缺省为 undefined，调用方不依赖其他后台字段。
export function readBackgroundAgentInfo(toolCall: AgentToolCall) {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const meta = raw && isPlainRecord(raw._meta) ? raw._meta : null;
  const zcode = meta && isPlainRecord(meta.zcode) ? meta.zcode : null;
  const zcodeBackgroundAgent =
    zcode && isPlainRecord(zcode.backgroundAgent) ? zcode.backgroundAgent : null;
  const taskNotification =
    zcode && isPlainRecord(zcode.taskNotification) ? zcode.taskNotification : null;
  const backgroundAgent = zcodeBackgroundAgent;
  const input = isPlainRecord(toolCall.input) ? toolCall.input : null;
  const outputText = readTextFromUnknown(toolCall.output);
  const outputFile =
    (taskNotification && readStringField(taskNotification, ["outputFile", "output_file"])) ??
    (backgroundAgent && readStringField(backgroundAgent, ["outputFile", "output_file"])) ??
    outputText?.match(/output_file:\s*([^\s]+)/i)?.[1];

  if (input?.run_in_background !== true && input?.runInBackground !== true && !outputFile) {
    return null;
  }

  return { outputFile };
}

export function getAgentActivityContent(toolCall: AgentToolCall) {
  const taskNotificationResult =
    readStringFromNestedRecord(toolCall.raw, ["_meta", "zcode", "taskNotification", "result"]) ??
    readStringFromNestedRecord(toolCall.raw, ["_meta", "zcode", "taskNotification", "summary"]);
  if (taskNotificationResult) {
    // background Agent 的 output_file 是完整 sidechain transcript，
    // task-notification result 才是适合用户阅读的完成摘要。优先展示摘要，避免展开后被 JSONL 淹没。
    return taskNotificationResult;
  }

  return toolCall.content?.trim();
}

// [契约] 主文本优先级为昵称、非实现类标题、输入 description、subagent_type、agent_type、输出描述与名称，最后回落 fallbackLabel。
// [失败路径] 跳过实现标题判定会把 agent、task 这类工具名当标题，用户看不到真正的任务描述。
// [契约] 输入是记录时才按键读取，字符串或缺失输入不会进入字段分支，也不会抛错。
// [契约] getAgentPrompt 先取输入的 prompt、message、description，再接受纯字符串输入，两者都为空才返回 undefined。
// [失败路径] 漏掉纯字符串分支会让流式早期只有原始输入文本时提示词整段丢失。
// [边界] 两个函数都只读不写，不缓存也不改写 toolCall，可安全用于渲染期的多次调用。
export function getAgentPrimaryText(toolCall: AgentToolCall, fallbackLabel: string) {
  const nickname = readCodexSubagentNickname(toolCall);
  if (nickname) {
    return nickname;
  }

  if (typeof toolCall.title === "string" && toolCall.title.trim().length > 0) {
    const title = toolCall.title.trim();
    if (!isImplementationToolTitle(title)) {
      return title;
    }
  }

  if (isPlainRecord(toolCall.input)) {
    const description = readStringField(toolCall.input, ["description"]);
    if (description) {
      return description;
    }

    const subagentType = readStringField(toolCall.input, ["subagent_type"]);
    if (subagentType) {
      return subagentType;
    }

    const agentType = readStringField(toolCall.input, ["agent_type"]);
    if (agentType) {
      return agentType;
    }
  }

  const outputRecord = readRecordFromUnknown(toolCall.output);
  const outputDescription = readAgentPrimaryDescription(outputRecord);
  if (outputDescription) {
    return outputDescription;
  }

  const outputAgentName = readAgentNameFromRecord(outputRecord);
  if (outputAgentName) {
    return outputAgentName;
  }

  return fallbackLabel;
}

export function getAgentPrompt(toolCall: AgentToolCall) {
  if (isPlainRecord(toolCall.input)) {
    const prompt = readStringField(toolCall.input, ["prompt", "message", "description"]);
    if (prompt) {
      return prompt;
    }
  }

  if (typeof toolCall.input === "string" && toolCall.input.trim().length > 0) {
    return toolCall.input.trim();
  }

  return undefined;
}
