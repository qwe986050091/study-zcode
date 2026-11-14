// planModeTool：把 UI 收到的「计划模式」工具载荷与模式配置，规整成可渲染的计划步骤与模式投影。
// 本文件只做解析、归一与展示投影，不发起请求、不写任务状态、不决定模式切换是否真正生效。
// 不负责：工具执行、权限判定、会话持久化，以及 provider 侧模式的真实切换语义。
//
// 关键不变量：
// INV-01 断言：任意深度嵌套的 input/output/raw 都能抽出计划且遇环必停 —— 守住它的位置：extractPlanPayload 的 seen 弱集 —— 改错故障：自引用载荷栈溢出，计划面板整块白屏
// INV-02 断言：空白标题的步骤一律不进入结果 —— 守住它的位置：createPlanStep 的空标题返回 null —— 改错故障：面板出现无标题空行，点击无响应
// INV-03 断言：步骤状态只可能是 completed、in_progress、pending 三者 —— 守住它的位置：normalizePlanStepStatus 的兜底分支 —— 改错故障：未知状态泄到渲染层，图标与文案错位
// INV-04 断言：多候选归并结果与候选遍历顺序无关 —— 守住它的位置：pickBetterPlan 的比较分支 —— 改错故障：同一工具在不同渲染时机给出不同步骤数
// INV-05 断言：结构化键判定与集合键解析使用同一份键表 —— 守住它的位置：hasPlanStructuredKeys 对 PLAN_COLLECTION_KEYS 的引用 —— 改错故障：新增键只改一处，计划被判为不存在
// INV-06 断言：非计划工具必须返回 null 而不是空计划对象 —— 守住它的位置：getPlanToolPayload 末尾的三重复核 —— 改错故障：任意工具都弹出空的计划面板
// INV-07 断言：模式配置项必须同时满足 category 为 mode 且 type 为 select —— 守住它的位置：getModeOptionFromConfigOptions 的 find 条件 —— 改错故障：误取其它下拉项，模式名显示成无关选项
// INV-08 断言：配置里没有模式项时返回 null 而非抛错 —— 守住它的位置：getCurrentModeIdFromConfigOptions 的类型收窄 —— 改错故障：旧版 provider 打开会话即崩溃
// INV-09 断言：语义模式找不到原生映射时原样返回入参 —— 守住它的位置：resolveProviderNativeModeIdFromSemantic 的末尾返回 —— 改错故障：模式 id 被清空，会话回落到默认模式
// INV-10 断言：归一化别名只增不删 —— 守住它的位置：normalizeSessionMode 的 switch —— 改错故障：历史配置静默落到 default，权限语义被悄悄放宽
// INV-11 断言：full-auto 与 yolo 必须归一到 yolo —— 守住它的位置：normalizeSessionMode 的全权限分支 —— 改错故障：全权限会话被降级为可编辑模式
// INV-12 断言：JSON 解析失败不得中断文本解析 —— 守住它的位置：parsePlanMarkdown 的 try/catch —— 改错故障：格式抖动的计划直接不显示
// INV-13 断言：列表行之后的文本不进入摘要 —— 守住它的位置：parsePlanMarkdown 的 encounteredList 分支 —— 改错故障：清单后的补充说明混进摘要，标题串行
// INV-14 断言：摘要取值的键优先顺序固定 —— 守住它的位置：PLAN_TEXT_KEYS 的数组顺序 —— 改错故障：同一载荷在不同 provider 下摘要字段不一致
//
// 解析链路分层：
// 1) getPlanToolPayload 做候选筛选与三源归并  2) extractPlanPayload 递归下钻  3) parsePlanMarkdown 处理文本化清单。
// 任一层返回 null 都表示此处没有可用计划，上层继续尝试其它来源，不得据此提前中断。
//
// 调用方须知：
// 步骤 id 仅用于渲染 key，标题重复时可能重复，不要当作业务主键做持久化或去重。
// steps 为空但 summary 非空是合法结果，对应只有说明没有清单的计划。
// 模式相关导出只读配置项且不缓存，配置变更后需重新调用才能拿到新值。
//
// 维护提示：
// 新增集合键或模式别名时，必须同步 hasPlanStructuredKeys 与 normalizeSessionMode，否则筛选与解析会错位。
// 本文件被逐工具频繁调用，任何新增日志都应降到 debug 级别并避免打印完整载荷。
import type {
  ZCodeConfigOption,
  ZCodePlanStep,
  ZCodeProvider,
  ZCodeTaskModeInfo,
} from "@zcode/shared";

// 上游工具对象字段全部可选：UI 可能拿到 CLI 事件、回放快照或历史消息的不同形态。
// input/output/raw 保持 unknown，是因为不同链路对同一工具可能只填其中一个。
// 收紧成必填会让旧会话回放整段报错，计划面板直接空掉。
interface PlanToolLike {
  title?: string;
  kind?: string;
  input?: unknown;
  output?: unknown;
  raw?: unknown;
}

interface ParsedPlanTool {
  summary: string | null;
  steps: ZCodePlanStep[];
  toolName: string | null;
}

interface ParsedPlanPayload {
  summary: string | null;
  steps: ZCodePlanStep[];
}

// [契约] 集合键顺序即探测优先级：plan 最贴近语义，todos 与 items 只是后置兜底别名。
// 新增键必须同步确认 hasPlanStructuredKeys 也认它，否则「有结构化计划」判定会漏。
// 顺序变动会让同一载荷选中不同候选，表现为步骤数忽多忽少。
const PLAN_COLLECTION_KEYS = ["plan", "steps", "entries", "todos", "items"] as const;
const PLAN_TEXT_KEYS = ["explanation", "summary", "description", "planSummary"] as const;
// [权衡] 用正则兜底而非精确工具名：不同 provider 存在 enter_plan_mode 与 EnterPlanMode 混用。
// 正则放宽会误判，普通工具描述里出现 plan mode 字样也会被当成候选。
// `PLANISH_TOOL_PATTERNS` 只产出候选，最终由结构化判定和步骤数复核把关。
const PLANISH_TOOL_PATTERNS = [
  /enter\s*_?plan\s*_?mode/i,
  /exit\s*_?plan\s*_?mode/i,
  /update\s*_?plan/i,
  /plan\s+mode/i,
  /switch\s*_?mode/i,
];

// 数组同样算 object，这里刻意不排除，由各调用点自行决定是否走数组分支。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// 只接受字符串且 trim 后非空，数字与布尔一律跳过，避免把 id 或计数误当标题。
function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return null;
}

// 状态口径收敛为三种：completed、in_progress、pending，其余一律 pending。
// done 与 completed 视为同义，这是 provider 写法差异，不要新增第四种状态。
// 渲染层只认这三个值，新增状态会静默落到默认图标。
function normalizePlanStepStatus(value: unknown): ZCodePlanStep["status"] {
  if (typeof value !== "string") {
    return "pending";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "completed" || normalized === "done") {
    return "completed";
  }

  // in_progress、in-progress、running 三种写法都视为进行中，是 provider 术语差异。
  // 只做小写与去空白，不做前缀或包含匹配，避免 pending 被误判为进行中。
  // 未识别的字符串走末尾兜底返回 pending，宁可显示待办也不谎报进度。
  if (normalized === "in_progress" || normalized === "in-progress" || normalized === "running") {
    return "in_progress";
  }

  return "pending";
}

// 空标题直接返回 null 交由调用方过滤，保证 steps 里没有空行占位。
function createPlanStep(title: string, status: unknown, index: number): ZCodePlanStep | null {
  const trimmedTitle = title.trim();
  if (trimmedTitle.length === 0) {
    return null;
  }

  return {
    id: `${index}-${trimmedTitle}`,
    title: trimmedTitle,
    status: normalizePlanStepStatus(status),
  };
}

// [失败路径] 先试 JSON，失败后静默降级为 markdown，不让格式抖动冒泡成异常。
// 先看首字符是花括号或方括号，避免每段普通文本都进 try/catch 付开销。
// 整段为空返回 null，调用方据此判定此处没有计划。
function parsePlanMarkdown(markdown: string): ParsedPlanPayload | null {
  const trimmed = markdown.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // [失败路径] JSON.parse 失败只吞异常不记日志：这是逐工具高频路径。
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const jsonPlan = extractPlanPayload(parsed);
      if (jsonPlan) {
        return jsonPlan;
      }
    } catch {
      // JSON 解析失败时继续按 markdown 文本处理。
    }
  }

  const lines = trimmed.split(/\r?\n/);
  const summaryLines: string[] = [];
  const steps: ZCodePlanStep[] = [];
  let encounteredList = false;

  for (const line of lines) {
    const current = line.trim();
    if (current.length === 0) {
      if (!encounteredList && summaryLines.at(-1) !== "") {
        summaryLines.push("");
      }
      continue;
    }

    // 复选框状态直接映射步骤状态，x 或 X 为已完成，空格为待办。
    // 正则允许行首无列表符号，兼容手写的裸复选框格式。
    // 命中后必须 continue，否则同一行会被后面的普通列表正则二次消费。
    const checkboxMatch = current.match(/^(?:[-*+]\s+)?\[( |x|X)\]\s+(.+)$/);
    if (checkboxMatch) {
      const checkboxState = checkboxMatch[1];
      const checkboxTitle = checkboxMatch[2];
      if (!checkboxState || !checkboxTitle) {
        continue;
      }

      encounteredList = true;
      const step = createPlanStep(
        checkboxTitle,
        checkboxState.toLowerCase() === "x" ? "completed" : "pending",
        steps.length,
      );
      if (step) {
        steps.push(step);
      }
      continue;
    }

    // 有序与无序列表都算待办步骤，但不推断完成态，统一 pending。
    // 一旦出现列表行就置 encounteredList，之后的行不再计入摘要。
    const listMatch = current.match(/^(?:[-*+]\s+|\d+\.\s+)(.+)$/);
    if (listMatch) {
      const listTitle = listMatch[1];
      if (!listTitle) {
        continue;
      }

      encounteredList = true;
      const step = createPlanStep(listTitle, "pending", steps.length);
      if (step) {
        steps.push(step);
      }
      continue;
    }

    // [权衡] 只有列表之前的普通文本才进摘要，列表之后的说明文字直接丢弃。
    // 这是为兼容「一段解释加一份清单」的输出，反过来收会把清单后的补充塞进摘要。
    if (!encounteredList) {
      summaryLines.push(current.replace(/^#+\s*/, ""));
    }
  }

  const summary = summaryLines.join("\n").trim() || null;
  if (steps.length === 0 && summary === null) {
    return null;
  }

  return {
    summary,
    steps,
  };
}

// 单条步骤可能是纯字符串也可能是对象，对象按 step、title、content、text 依次取标题。
function parsePlanStepEntry(value: unknown, index: number): ZCodePlanStep | null {
  if (typeof value === "string") {
    return createPlanStep(value, "pending", index);
  }

  if (!isRecord(value)) {
    return null;
  }

  const title = firstNonEmptyString(value.step, value.title, value.content, value.text);
  if (!title) {
    return null;
  }

  return createPlanStep(title, value.status, index);
}

// 多个候选竞争时步骤数更多的胜出，数量相同才看摘要能否补齐。
// 该比较必须稳定，否则同一工具在不同渲染时机给出不同步骤数。
function pickBetterPlan(
  current: ParsedPlanPayload | null,
  next: ParsedPlanPayload | null,
): ParsedPlanPayload | null {
  if (!next) {
    return current;
  }

  if (!current) {
    return next;
  }

  if (next.steps.length > current.steps.length) {
    return next;
  }

  if (next.steps.length === current.steps.length && next.summary && !current.summary) {
    return next;
  }

  return current;
}

// [契约] 全文件唯一递归入口：字符串走 markdown，数组优先按直连步骤处理，对象逐键下钻。
// [并发] seen 默认参数每次调用新建 WeakSet，跨调用不共享，避免一次解析污染下一次。
function extractPlanPayload(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): ParsedPlanPayload | null {
  if (typeof value === "string") {
    return parsePlanMarkdown(value);
  }

  if (Array.isArray(value)) {
    const directSteps = value
      .map((entry, index) => parsePlanStepEntry(entry, index))
      .filter((step): step is ZCodePlanStep => step !== null);
    if (directSteps.length > 0) {
      return {
        summary: null,
        steps: directSteps,
      };
    }

    let best: ParsedPlanPayload | null = null;
    for (const entry of value) {
      best = pickBetterPlan(best, extractPlanPayload(entry, seen));
    }
    return best;
  }

  if (!isRecord(value)) {
    return null;
  }

  // [失败路径] 环检测：同一对象再次进入直接返回 null，防止自引用载荷无限递归。
  // WeakSet 仅在本次解析内有效，不持强引用，大载荷不会因此泄漏。
  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  const singleStep = parsePlanStepEntry(value, 0);
  if (singleStep) {
    return {
      summary: null,
      steps: [singleStep],
    };
  }

  let best: ParsedPlanPayload | null = null;

  // 逐键下钻固定顺序，任一键命中更优候选就替换，不会因为后面的空值回退。
  // value[key] 可能是 undefined，递归入口对此返回 null，pickBetterPlan 会保留旧值。
  for (const key of PLAN_COLLECTION_KEYS) {
    best = pickBetterPlan(best, extractPlanPayload(value[key], seen));
  }

  // 内容块有两种形态：结构化 text part 取其 text，否则把 content 当容器继续下钻。
  // 漏掉 type 判断会把 text part 的包装对象当成步骤对象，凭空多出一条步骤。
  if (isRecord(value.content) && value.content.type === "text") {
    best = pickBetterPlan(best, extractPlanPayload(value.content.text, seen));
  } else {
    best = pickBetterPlan(best, extractPlanPayload(value.content, seen));
  }

  best = pickBetterPlan(best, extractPlanPayload(value.rawInput, seen));
  best = pickBetterPlan(best, extractPlanPayload(value.rawOutput, seen));
  best = pickBetterPlan(best, extractPlanPayload(value.result, seen));

  // 摘要兜底：即使没有解析出步骤，也要尝试从载荷顶层取一段说明。
  // 只有 best.summary 为空时才用这里的值，避免覆盖更贴近计划的字段。
  // 键顺序即优先级，调整会让同一载荷的摘要来源发生变化。
  const summary = firstNonEmptyString(...PLAN_TEXT_KEYS.map((key) => value[key]));
  if (best) {
    return {
      summary: best.summary ?? summary,
      steps: best.steps,
    };
  }

  if (typeof value.text === "string") {
    return parsePlanMarkdown(value.text);
  }

  if (summary) {
    return {
      summary,
      steps: [],
    };
  }

  return null;
}

// [契约] 只判断有没有计划结构而不解析内容，因此可对完整 raw 做一次浅层快扫。
// 数组任一元素命中即真，对象命中集合键或任一子值命中同样为真。
function hasPlanStructuredKeys(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasPlanStructuredKeys(entry, seen));
  }

  if (!isRecord(value)) {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (PLAN_COLLECTION_KEYS.some((key) => key in value)) {
    return true;
  }

  return Object.values(value).some((entry) => hasPlanStructuredKeys(entry, seen));
}

// 工具名可能挂在 name、toolName、tool_name 或 title 上，这是不同事件源的字段差异。
// 取不到就返回 null，指纹里少一项不影响其余项继续参与正则匹配。
function extractToolName(raw: unknown): string | null {
  if (!isRecord(raw)) {
    return null;
  }

  return firstNonEmptyString(raw.name, raw.toolName, raw.tool_name, raw.title);
}

// 模式配置项身份由 category 为 mode 且 type 为 select 同时确定，任一不满足即视为不存在。
// 找不到返回 null 而非抛错，调用方据此降级到默认模式。
export function getModeOptionFromConfigOptions(
  configOptions: ZCodeConfigOption[],
): ZCodeConfigOption | null {
  const modeOption = configOptions.find(
    (option) => option.category === "mode" && option.type === "select",
  );
  return modeOption ?? null;
}

// currentValue 仅当是非空字符串才视为有效模式 id，其它类型一律返回 null。
// 不要在这里补默认值：默认模式由调用方与配置决定，补值会把未初始化伪装成已选。
export function getCurrentModeIdFromConfigOptions(
  configOptions: ZCodeConfigOption[],
): string | null {
  const modeOption = getModeOptionFromConfigOptions(configOptions);
  if (typeof modeOption?.currentValue !== "string") {
    return null;
  }
  const currentValue = modeOption.currentValue.trim();
  return currentValue.length > 0 ? currentValue : null;
}

/**
 * Resolve provider-native modeId from semantic modeId.
 * This is the UI counterpart of resolveProviderModeIdFromConfigOptions in service layer.
 *
 * @param configOptions - The config options array
 * @param semanticModeId - The semantic mode ID (e.g., "default", "plan")
 * @returns The provider-native mode ID, or the original semanticModeId if not found
 */
// 语义模式到 provider 原生 value 的映射，只用于展示与回填，不改变运行态。
// 先精确匹配再归一化匹配，都失败原样返回语义 id，保证不丢信息。
// 与 service 层同名能力对齐，两边规则改动必须同步。
export function resolveProviderNativeModeIdFromSemantic(
  configOptions: ZCodeConfigOption[],
  semanticModeId: string,
  provider?: ZCodeProvider,
): string {
  const modeOption = getModeOptionFromConfigOptions(configOptions);
  if (!modeOption?.options) {
    return semanticModeId;
  }

  // Look for exact match first
  // 精确匹配优先：value 与语义 id 完全一致时直接返回，跳过归一化避免把不同模式合并。
  // 这一步也保证 provider 原生 id 与语义 id 同名时行为零变化。
  const exactMatch = modeOption.options.find((opt) => opt.value === semanticModeId);
  if (exactMatch) {
    return exactMatch.value;
  }

  // Try normalized mapping for known variants
  const normalizedMode = normalizeSessionMode(semanticModeId, provider);
  const normalizedMatch = modeOption.options.find((opt) => {
    const normalizedOpt = normalizeSessionMode(opt.value, provider);
    return normalizedOpt === normalizedMode;
  });

  return normalizedMatch?.value ?? semanticModeId;
}

// [契约] 归一只用于比较，返回值是规范名而非 provider 原始 value。
// 未知模式原样返回小写去空白结果，调用方仍可做精确匹配。
// 别名表只增不删：删掉任一别名都会让历史配置静默落到 default。
function normalizeSessionMode(mode: string, _provider?: ZCodeProvider): string {
  const normalized = mode.trim().toLowerCase();
  // Map known provider-native variants to canonical forms
  switch (normalized) {
    case "default":
      return "default";
    case "full-access":
    case "full_access":
    case "bypasspermissions":
      return "bypassPermissions";
    case "read-only":
    case "read_only":
    case "plan":
      return "plan";
    case "guarded":
      return "guarded";
    // 修复原因：新增模式曾吸收旧 full-auto 别名；历史全权限语义仍必须是 YOLO。
    // [契约] full-auto 与 yolo 必须归到 yolo，全权限语义不能被 build 或 plan 吸收。
    // 历史修复：新增模式时误把 full-auto 并入其它分支，导致全权限会话被降级。
    case "full-auto":
    case "full_auto":
    case "yolo":
      return "yolo";
    case "auto-edit":
    case "auto_edit":
    case "build":
      return "build";
    default:
      return normalized;
  }
}

// 可用模式列表直接映射为展示结构，不做过滤与排序，顺序即 provider 配置顺序。
// 缺少 options 时返回空数组而非 null，列表组件可直接渲染为空态。
export function getAvailableModesFromConfigOptions(
  configOptions: ZCodeConfigOption[],
): ZCodeTaskModeInfo[] {
  const modeOption = getModeOptionFromConfigOptions(configOptions);
  if (!modeOption?.options) {
    return [];
  }

  return modeOption.options.map((option) => ({
    id: option.value,
    name: option.name,
    description: option.description,
  }));
}

// 标签只按 value 精确查名字，查不到时回落为 modeId 本身，保证标签不出现空白。
// 不做归一化匹配：这里展示配置里的真实选项，模糊匹配会显示成另一个模式名。
export function getModeLabelFromConfigOptions(
  configOptions: ZCodeConfigOption[],
  modeId: string | null,
): string | null {
  if (!modeId) {
    return null;
  }

  const modeOption = getModeOptionFromConfigOptions(configOptions);
  return modeOption?.options?.find((option) => option.value === modeId)?.name ?? modeId;
}

// 面板入口：先用工具指纹与结构化键做廉价筛选，再依次解析 input、output、raw。
// 指纹由 title、kind、raw.name 拼接，任一项缺失不影响其余项参与正则。
// 返回 null 表示不是计划工具，UI 不应渲染空面板。
export function getPlanToolPayload(tool: PlanToolLike): ParsedPlanTool | null {
  const toolName = extractToolName(tool.raw);
  const toolFingerprint = [tool.title, tool.kind, toolName].filter(Boolean).join(" ");
  // [权衡] 正则与结构化键是或关系，任一命中都继续，宁可多解析不可漏判。
  // `getPlanToolPayload` 宁多解析：误判只多一次空解析，漏判则整块面板不显示。
  const isPlanishTool = PLANISH_TOOL_PATTERNS.some((pattern) => pattern.test(toolFingerprint));
  const hasStructuredPlan =
    hasPlanStructuredKeys(tool.input) ||
    hasPlanStructuredKeys(tool.output) ||
    hasPlanStructuredKeys(tool.raw);

  if (!isPlanishTool && !hasStructuredPlan) {
    return null;
  }

  // 三个候选源按序归并，由 pickBetterPlan 决定保留谁，顺序只影响择优时机。
  const parsed = [tool.input, tool.output, tool.raw].reduce<ParsedPlanPayload | null>(
    (best, candidate) => pickBetterPlan(best, extractPlanPayload(candidate)),
    null,
  );
  if (!parsed) {
    return null;
  }

  // [失败路径] 兜底复核：无结构化键且指纹里也没有 plan 字样时，仅凭摘要不足以判定为计划工具。
  // 这是纯标题被正则误判时的唯一止损点，删除会让无关工具弹出计划面板。
  if (parsed.steps.length === 0 && !hasStructuredPlan && !/plan/i.test(toolFingerprint)) {
    return null;
  }

  return {
    summary: parsed.summary,
    steps: parsed.steps,
    toolName,
  };
}
