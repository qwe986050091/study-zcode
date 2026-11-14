// 工具调用身份归一化层：把 toolCall 上散落的 toolName、kind、title 与 raw._meta
// 收敛成 ToolCallIdentity（工具名 + 展示家族 + 命中来源 + 是否 legacy），供卡片渲染选图标。
// 只做识别与归类，不执行工具、不校验入参、不改写 toolCall，也不负责把 legacy 工具
// 重新登记进 shared 的现役 known tool 列表。
//
// INV-01 断言：同一 toolCall 输入必须始终解析出同一 family 与 source —— 守住它的位置：resolveToolCallIdentity 全部分支顺序 —— 改错故障：同一会话重渲染后工具卡片图标与标题在两种样式间跳变。
// INV-02 断言：现役工具名优先于任何 legacy 载荷判据 —— 守住它的位置：known name 候选循环在 legacy agent 与 title 之前 —— 改错故障：新会话的 Task 工具被降级成 legacy agent，卡片失去现役渲染能力。
// INV-03 断言：toolName、kind、raw 直取名的优先级固定为 toolName 最高 —— 守住它的位置：resolveToolCallIdentity 的 candidate 数组顺序 —— 改错故障：toolName 与 raw 名冲突时取自 raw，卡片图标与真实调用不符。
// INV-04 断言：identityFromKnownToolName 返回 null 只表示这个名字不认识 —— 守住它的位置：该函数的两个返回 null 分支 —— 改错故障：中途误判成最终 unknown，后续 legacy 兜底全部被跳过。
// INV-05 断言：isLegacy 只在 identityFromLegacyFamily 或显式覆盖时置真 —— 守住它的位置：identityFromLegacyFamily 与 claudeIdentity 分支 —— 改错故障：现役工具被打上 legacy 标记，UI 回退到旧卡片模板。
// INV-06 断言：normalizeLegacyToken 必须同时做 trim、小写与空白连字符转下划线 —— 守住它的位置：normalizeLegacyToken 的正则 —— 改错故障：switch-mode、Exited Plan Mode 等带空格写法全部匹配失败。
// INV-07 断言：fetch 与 web_fetch 一律归为 legacy 的 web-fetch 家族 —— 守住它的位置：identityFromKnownToolName 的首个分支 —— 改错故障：WebFetch 走现役表查到空家族，被误判 unknown 而丢失抓取卡片。
// INV-08 断言：legacy agent 判定必须在 title 现役解析之前 —— 守住它的位置：isLegacyAgentTool 的调用位置 —— 改错故障：kind 为 think、title 为 Task 的旧子 agent 被升级成现役 Task，展示成非 legacy 卡片。
// INV-09 断言：TodoWrite 与 GoalUpdate 只作为 legacy 展示身份存在 —— 守住它的位置：todo 与 goal 两段兜底分支 —— 改错故障：有人把二者加回 shared 已知工具表，历史会话解析结果随之漂移。
// INV-10 断言：ask_question 判定必须早于 resolveLegacyKindFamily —— 守住它的位置：AskUserQuestion 分支位置 —— 改错故障：问卷工具被 kind 正则当作普通检索家族，问题卡片不再展开。
// INV-11 断言：计划模式退出的 token 集合必须覆盖归一化后的无下划线写法 —— 守住它的位置：isPlanModeExitToken 与 ExitPlanMode 分支 —— 改错故障：ExitPlanMode 拿不到 switch-mode 家族，落回 fallback 导致计划卡片丢失。
// INV-12 断言：title 前缀仅允许推断 file-read，不得扩展到写入或命令 —— 守住它的位置：titlePrefixFamily 分支的判断条件 —— 改错故障：标题以 Read 开头的写入调用被误判为读取，diff 视图不再出现。
// INV-13 断言：claudeCode 元数据是最后兜底且必须标记 legacy —— 守住它的位置：resolveToolCallIdentity 尾部分支 —— 改错故障：提前使用会让低优先级的旧元数据压过 toolName，身份来源显示错误。
// INV-14 断言：UNKNOWN_TOOL_IDENTITY 是共享常量，调用方不得原地修改 —— 守住它的位置：该常量定义与返回处 —— 改错故障：一次写入污染全局，后续所有未识别工具都带上被改过的字段。
// INV-15 断言：isFileDiffToolCall 与 isFileContentWriteToolCall 必须严格互补于 file-write 家族 —— 守住它的位置：两个导出函数的布尔表达式 —— 改错故障：写入调用同时命中 diff 与内容写入，同一张卡片渲染两套预览。
//
// 判定顺序（命中即返回，顺序本身即契约）：
// 1) kind 归一化为 explore 时直接短路
// 2) toolName、kind、raw 直取名、raw._meta.zcode.toolName 依次查现役工具表
// 3) legacy agent 载荷、title、todo、goal、计划模式进出、skill、ask-user-question
// 4) legacy kind 正则家族、title 前缀、raw._meta.claudeCode，最后落到 unknown
//
// 改动纪律：新增分支必须明确自己相对既有分支的前后位置，并在文件头补一条不变量。
// 顺序调换通常只影响历史会话，新会话回归测试覆盖不到，务必按 INV 的守住位置核对。
// 归一化口径统一走 normalizeLegacyToken，单分支私自放宽匹配会与其余判定错位。
import {
  getZCodeToolFamilyForName,
  isTodoPlanToolName,
  isZCodeFileContentWriteToolName,
  normalizeZCodeToolName,
  type ZCodeKnownToolName,
  type ZCodeToolFamily,
} from "@zcode/shared";
import { normalizeAskUserQuestionInput, readAskUserQuestionInput } from "@/lib/askUserQuestion.js";

export type ToolCallPresentationFamily =
  | ZCodeToolFamily
  | "plan-guidance"
  | "switch-mode"
  | "explore"
  | "unknown";

export type ToolCallIdentitySource =
  | "toolName"
  | "kind"
  | "title"
  | "raw"
  | "raw-zcode-meta"
  | "raw-claude-meta"
  | "legacy-kind"
  | "legacy-title"
  | "legacy-payload"
  | "unknown";

export interface ToolCallIdentity {
  toolName: ZCodeKnownToolName | string | null;
  family: ToolCallPresentationFamily;
  source: ToolCallIdentitySource;
  isLegacy: boolean;
}

interface ToolIdentityLike {
  toolName?: string | null;
  kind?: string | null;
  title?: string | null;
  input?: unknown;
  raw?: unknown;
}

const UNKNOWN_TOOL_IDENTITY: ToolCallIdentity = {
  toolName: null,
  family: "unknown",
  source: "unknown",
  isLegacy: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNestedString(value: unknown, path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return readString(current);
}

// [契约] 归一化口径是全局的：去首尾空白、转小写、把空白与连字符折叠成一个下划线。
// 所有 token 比较都依赖它，单个分支不得私自再做一次大小写或分隔符处理。
// 用连续空白或连字符的字符类而不是逐字符替换，是为了把多个空格压成一个分隔符。
// 空值返回空串而非 undefined，调用方无需额外判空即可直接参与字符串比较。
function normalizeLegacyToken(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_") ?? ""
  );
}

function identityFromKnownToolName(
  value: string | null | undefined,
  source: ToolCallIdentitySource,
): ToolCallIdentity | null {
  // [权衡] fetch 与 web_fetch 先于现役表处理，统一归为 legacy 的 web-fetch 并保留原始名称。
  // 现役表里抓取类工具的家族与卡片语义不同，走通用路径会得到错误家族。
  // 默认名用 WebFetch 兜底，保证入参为空时卡片标题仍有内容。
  if (["fetch", "web_fetch"].includes(normalizeLegacyToken(value))) {
    return identityFromLegacyFamily(value?.trim() ?? "WebFetch", "web-fetch", source);
  }
  // [契约] 名字归一化后查不到就返回 null，让调用方继续尝试下一条线索，而不是直接判 unknown。
  // 拿到名字但取不到展示家族时同样返回 null，语义是认识名字却没有家族归属。
  // 把 null 改成 unknown 会截断候选链，历史会话里后续的 raw 元数据再也用不上。
  const toolName = normalizeZCodeToolName(value);
  if (!toolName) {
    return null;
  }
  const family = getZCodeToolFamilyForName(toolName);
  if (!family) {
    return null;
  }
  return {
    toolName,
    family,
    source,
    isLegacy: false,
  };
}

// [契约] 只要走这个构造函数，isLegacy 必为 true，这是 UI 选择旧卡片的唯一依据。
// 不要把 toolName 在这里再做归一化：显示名需要保留原始大小写与分隔符。
// source 必须如实反映命中的线索，否则排查这张卡样式为何不同时无从下手。
function identityFromLegacyFamily(
  toolName: string | null,
  family: ToolCallPresentationFamily,
  source: ToolCallIdentitySource,
): ToolCallIdentity {
  return {
    toolName,
    family,
    source,
    isLegacy: true,
  };
}

// [契约] 直取名按 toolName、tool_name、name 的固定顺序取第一个非空字符串。
// ZCode 与 Claude 的元数据分别放在 _meta 下两条独立路径，不可互相兜底。
// 所有取值都经过去空白与非空校验，因此返回 undefined 表示该线索确实不存在。
function readRawToolNameCandidates(raw: unknown) {
  return {
    direct:
      readNestedString(raw, ["toolName"]) ??
      readNestedString(raw, ["tool_name"]) ??
      readNestedString(raw, ["name"]),
    zcode: readNestedString(raw, ["_meta", "zcode", "toolName"]),
    claudeCode: readNestedString(raw, ["_meta", "claudeCode", "toolName"]),
    rawKind: readNestedString(raw, ["kind"]),
    rawTitle: readNestedString(raw, ["title"]),
  };
}

// [权衡] 这里刻意放宽：agent 与 task 名、kind 为 think 配 title、以及 input.subagent_type 存在都算子 agent。
// 历史投影把子 agent 记录成 think 加 title，不看 input 就会漏判成普通思考块。
// 代价是可能误伤：kind 为 think 且 input 带 subagent_type 的现役调用同样会被标 legacy。
// 收紧任何一条都要先确认旧会话仍能识别，否则已存在的任务卡片会退化成文本。
function isLegacyAgentTool(
  toolCall: ToolIdentityLike,
  rawNames: ReturnType<typeof readRawToolNameCandidates>,
) {
  const kind = normalizeLegacyToken(toolCall.kind);
  const title = normalizeLegacyToken(toolCall.title);
  const rawDirect = normalizeLegacyToken(rawNames.direct);
  const rawZCode = normalizeLegacyToken(rawNames.zcode);
  const rawClaude = normalizeLegacyToken(rawNames.claudeCode);

  return (
    rawClaude === "agent" ||
    rawClaude === "task" ||
    rawZCode === "agent" ||
    rawZCode === "spawn_agent" ||
    rawDirect === "agent" ||
    rawDirect === "spawn_agent" ||
    kind === "agent" ||
    kind === "spawn_agent" ||
    (kind === "think" && (title === "agent" || title === "task")) ||
    (kind === "think" &&
      isRecord(toolCall.input) &&
      typeof toolCall.input.subagent_type === "string")
  );
}

function isLegacySkillTool(
  toolCall: ToolIdentityLike,
  rawNames: ReturnType<typeof readRawToolNameCandidates>,
) {
  const kind = normalizeLegacyToken(toolCall.kind);
  const title = normalizeLegacyToken(toolCall.title);
  const rawClaude = normalizeLegacyToken(rawNames.claudeCode);
  return (
    rawClaude === "skill" ||
    title === "skill" ||
    kind === "skill" ||
    (kind === "other" && isRecord(toolCall.input) && typeof toolCall.input.skill === "string")
  );
}

function hasAskUserQuestionPayload(toolCall: ToolIdentityLike): boolean {
  return normalizeAskUserQuestionInput(readAskUserQuestionInput(toolCall)).questions.length > 0;
}

function isLegacyGoalToolToken(value: string): boolean {
  return value === "goalcreate" || value === "goalupdate";
}

// [契约] 正则分支顺序即家族优先级：读取、写入、命令、抓取、检索、探索，先命中先返回。
// 检索正则里也含 fetch 与 web 关键词，所以抓取的精确匹配必须排在检索之前。
// 写入正则用起始或下划线开头，允许 edit 出现在复合名中段，读取则只认前缀，二者刻意不对称。
// 所有正则都以可选下划线或行尾收尾，避免 readme、baseline 这类词被当成读取调用。
function resolveLegacyKindFamily(kind: string): ToolCallPresentationFamily | null {
  if (/^(?:read|view|open|cat|head|tail|read_file)(?:_|$)/i.test(kind)) {
    return "file-read";
  }
  if (
    /(?:^|_)(?:edit|patch|replace|multi_edit|multiedit|write|create|save|apply_patch)(?:_|$)/i.test(
      kind,
    )
  ) {
    return "file-write";
  }
  if (/^(?:execute|run|exec|bash|shell|command|terminal)(?:_|$)/i.test(kind)) {
    return "shell";
  }
  if (/^(?:fetch|web_fetch|webfetch)$/i.test(kind)) {
    return "web-fetch";
  }
  if (
    /^(?:search|grep|find|fetch|web_search|web_fetch|webfetch|query|lookup|glob|list|ls|dir|tree)(?:_|$)/i.test(
      kind,
    )
  ) {
    return "search";
  }
  if (/^(?:explore|inspect)(?:_|$)/i.test(kind)) {
    return "explore";
  }
  return null;
}

// [契约] 该集合覆盖计划模式退出的历史写法：switch_mode 与退出计划模式的连写形式。
// 归一化已把空格和连字符转成下划线，因此这里只需枚举下划线与无分隔两种形态。
function isPlanModeExitToken(value: string): boolean {
  return (
    value === "switch_mode" ||
    value === "switchmode" ||
    value === "exited_plan_mode" ||
    value === "exitedplanmode" ||
    value === "exit_plan_mode" ||
    value === "exitplanmode"
  );
}

// [契约] 本函数是 UI 侧唯一入口：分支顺序即对外行为契约，不能仅凭代码整洁重排。
// 历史会话的 toolCall 往往同时带 kind、title、raw 多套线索，先后手一变命中的 source 就变。
// 需要新增识别规则时，先判断它该插在哪一步之前，再补一条 INV，不要图省事追加到末尾。
// 返回的 identity 被调用方视为只读，不得回写字段，否则会污染下面共享的 unknown 常量。
export function resolveToolCallIdentity(toolCall: ToolIdentityLike): ToolCallIdentity {
  const rawNames = readRawToolNameCandidates(toolCall.raw);
  const normalizedKind = normalizeLegacyToken(toolCall.kind);
  const normalizedTitle = normalizeLegacyToken(toolCall.title);

  if (normalizedKind === "explore") {
    return identityFromLegacyFamily("Explore", "explore", "legacy-kind");
  }

  // [契约] 候选顺序就是优先级：toolName 最可信，其次 kind，再是 raw 直取名，最后 raw._meta.zcode。
  // raw._meta.claudeCode 故意不在这一轮，Claude 侧名字只作最后兜底且必须打 legacy 标。
  // 先命中即返回，意味着 toolName 一旦可解析，后面三路线索永远不会被读取。
  // 若把 kind 提到 toolName 之前，历史会话中带旧 kind 的新工具会被错误降级。
  for (const candidate of [
    { value: toolCall.toolName, source: "toolName" as const },
    { value: toolCall.kind, source: "kind" as const },
    { value: rawNames.direct, source: "raw" as const },
    { value: rawNames.zcode, source: "raw-zcode-meta" as const },
  ]) {
    const identity = identityFromKnownToolName(candidate.value, candidate.source);
    if (identity) {
      return identity;
    }
  }

  if (isLegacyAgentTool(toolCall, rawNames)) {
    return identityFromLegacyFamily(
      rawNames.direct ?? rawNames.zcode ?? rawNames.claudeCode ?? "Agent",
      "agent",
      "legacy-payload",
    );
  }

  // [失败路径] title 只作展示名，绝不能提到 legacy 载荷之前：kind 为 think、title 为 Task 的旧记录会误升级。
  // 现役 Task 与 legacy 子 agent 在 title 上同名，唯一区分依据就是前面的 payload 判据。
  // 调整这段顺序时用旧 session 复现，新会话根本无法暴露该回归。
  // `Task` 现在是现役 Claude 兼容工具名，但历史 ZCode Agent 投影会用
  // kind="think" + title="Task" 表示子 agent 活动。title 只是展示名，必须放在
  // legacy payload 判断之后，避免把旧会话误升级成非 legacy 工具身份。
  const titleIdentity = identityFromKnownToolName(toolCall.title, "title");
  if (titleIdentity) {
    return titleIdentity;
  }

  if (
    [
      toolCall.toolName,
      toolCall.kind,
      toolCall.title,
      rawNames.direct,
      rawNames.rawKind,
      rawNames.rawTitle,
    ]
      .filter((value): value is string => typeof value === "string")
      .some(isTodoPlanToolName)
  ) {
    // [契约] TodoWrite 已不在现役工具表，这里只按 legacy 身份渲染，避免历史待办卡片丢失。
    // 判据同时看 toolName、kind、title 与 raw 名，任一残留旧名即可命中，故不能只看 toolName。
    // 把 TodoWrite 加回 shared 已知工具会让本分支失效，历史会话展示也随之改变。
    return identityFromLegacyFamily("TodoWrite", "todo", "legacy-title");
  }

  if (
    // [失败路径] GoalCreate 与 GoalUpdate 同样只做 legacy 映射：先归一化成小写无分隔再比较。
    // 返回值优先取原始 toolName，其次 kind，都没有才用 GoalUpdate，保证卡片标题不为空。
    // 不要因为已废弃就删掉这段，删除会让旧 session 直接落到 unknown，目标卡片变成通用块。
    // GoalCreate/GoalUpdate 已不再是现役模型工具，但历史 session 仍可能有这些
    // tool call；这里作为 legacy goal 渲染，避免重新把它们放回 shared known tool list。
    [
      toolCall.toolName,
      toolCall.kind,
      toolCall.title,
      rawNames.direct,
      rawNames.rawKind,
      rawNames.rawTitle,
    ]
      .filter((value): value is string => typeof value === "string")
      .map(normalizeLegacyToken)
      .some(isLegacyGoalToolToken)
  ) {
    return identityFromLegacyFamily(
      toolCall.toolName?.trim() ?? toolCall.kind?.trim() ?? "GoalUpdate",
      "goal",
      "legacy-title",
    );
  }

  if (
    normalizedTitle === "enterplanmode" ||
    normalizeLegacyToken(rawNames.claudeCode) === "enterplanmode"
  ) {
    return identityFromLegacyFamily("EnterPlanMode", "plan-guidance", "legacy-title");
  }

  if (
    // [契约] 退出计划模式存在多种历史 token，归一化后需覆盖带下划线与无下划线两套写法。
    // 现役 ExitPlanMode 归一化后没有下划线，早期只认 switch_mode，导致退出卡片走 fallback。
    // 新增 token 只能往里加，删任何一个都会让某一时期的历史会话回退。
    // 当前 ZCode Agent 传给 app 的 plan mode 退出工具是 ExitPlanMode，
    // normalize 后没有下划线；旧兼容只认 switch_mode / Exited Plan Mode，导致计划卡片走 fallback。
    [
      toolCall.toolName,
      toolCall.kind,
      toolCall.title,
      rawNames.direct,
      rawNames.zcode,
      rawNames.claudeCode,
      rawNames.rawKind,
      rawNames.rawTitle,
    ]
      .filter((value): value is string => typeof value === "string")
      .map(normalizeLegacyToken)
      .some(isPlanModeExitToken)
  ) {
    return identityFromLegacyFamily("switch_mode", "switch-mode", "legacy-kind");
  }

  if (isLegacySkillTool(toolCall, rawNames)) {
    return identityFromLegacyFamily("Skill", "skill", "legacy-payload");
  }

  if (
    normalizedKind === "ask_question" ||
    normalizedTitle === "askuserquestion" ||
    normalizeLegacyToken(rawNames.claudeCode) === "askuserquestion" ||
    hasAskUserQuestionPayload(toolCall)
  ) {
    // [契约] 问卷判定必须早于 legacy kind 正则家族：ask_question 同时能满足其他正则的宽松条件。
    // 判定还包含载荷探测，问题数组非空即命中，因此即使名字丢失也能识别出问卷卡片。
    // 载荷探测会解析 input，成本略高，但放在这里只对已排除现役工具的调用执行。
    return identityFromLegacyFamily("AskUserQuestion", "ask-user-question", "legacy-payload");
  }

  const legacyKindFamily = resolveLegacyKindFamily(normalizedKind);
  if (legacyKindFamily) {
    // [权衡] kind 正则家族是 legacy 的主力兜底，只用于旧会话，命中即整体标记 legacy。
    // 返回的 toolName 保留原始 kind 文本供卡片显示，不要替换成家族名，否则标题会变成 read。
    // 家族内部的正则顺序在 resolveLegacyKindFamily 里固定，这里不重复判断家族冲突。
    return identityFromLegacyFamily(toolCall.kind?.trim() ?? null, legacyKindFamily, "legacy-kind");
  }

  const titlePrefixFamily = resolveLegacyKindFamily(
    normalizeLegacyToken(toolCall.title).split("_")[0] ?? "",
  );
  // [权衡] 标题前缀只允许推断读取：标题是展示文案，语义可信度远低于 kind。
  // 若放开到写入或命令，标题以 Read 开头的写入调用会被当成读取，diff 预览直接消失。
  // 因此这里显式比较 file-read，其他家族即使前缀命中也不采纳。
  if (titlePrefixFamily === "file-read") {
    return identityFromLegacyFamily(toolCall.title?.trim() ?? null, "file-read", "legacy-title");
  }

  // [契约] Claude 元数据是最后一道兜底：可以命中现役表，但必须补上 isLegacy 标记。
  // 放在这里而不是候选循环里，是为了让 toolName、kind 与 ZCode 元数据始终优先。
  // 去掉 isLegacy 覆盖会让旧 Claude 会话的卡片被当成现役工具渲染。
  const claudeIdentity = identityFromKnownToolName(rawNames.claudeCode, "raw-claude-meta");
  if (claudeIdentity) {
    return {
      ...claudeIdentity,
      isLegacy: true,
    };
  }

  // [资源] 这里返回模块级共享常量而不是每次新建对象，调用方必须按只读对待。
  // 任何原地赋值都会污染后续所有未识别调用，且问题往往只在另一条会话里才暴露。
  // 确需附加字段时用展开复制，不要修改这个常量本身。
  return UNKNOWN_TOOL_IDENTITY;
}

// [契约] 先过家族闸门：非 file-write 一律返回 false，避免把读取或命令调用误判成写入。
// 现役名交给 shared 判定，legacy 则只看 kind 正则，两条路径不可合并成一次字符串匹配。
// Edit、apply_patch 等增量修改被有意排除，它们应走 diff 预览而不是整篇内容写入。
export function isFileContentWriteToolCall(
  toolCall: ToolIdentityLike,
  identity = resolveToolCallIdentity(toolCall),
): boolean {
  if (identity.family !== "file-write") {
    return false;
  }
  if (isZCodeFileContentWriteToolName(identity.toolName)) {
    return true;
  }
  const legacyKind = normalizeLegacyToken(toolCall.kind);
  return /^(?:write|create|save)(?:_|$)/i.test(legacyKind);
}

// [契约] diff 与内容写入是互补关系：同为 file-write 且不是整篇写入，才算 diff 展示。
// identity 允许外部传入，调用方已解析时复用，避免同一次渲染重复走完整判定链。
// 不要为了更严格再加 toolName 白名单，互补一旦被打破会出现两种预览同时命中。
export function isFileDiffToolCall(
  toolCall: ToolIdentityLike,
  identity = resolveToolCallIdentity(toolCall),
): boolean {
  return identity.family === "file-write" && !isFileContentWriteToolCall(toolCall, identity);
}
