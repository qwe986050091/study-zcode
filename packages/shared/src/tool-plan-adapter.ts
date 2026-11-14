// INV-01 工具名识别只依赖名称形状，不看来源：守住位置 TODO_TOOL_NAME_PATTERN；改错故障 自定义同名工具无法投影。
// INV-02 名称匹配大小写不敏感且允许分隔符：守住位置 正则的忽略大小写与分隔符；改错故障 update-plan 与 updatePlan 只认一种。
// INV-03 集合键按固定优先级读取：守住位置 集合键数组顺序；改错故障 同时存在多个键时选错。
// INV-04 空数组不算有效计划：守住位置 长度判断；改错故障 空计划覆盖已有摘要。
// INV-05 任一步解析失败则整组放弃：守住位置 解析数与集合长度比较；改错故障 半截计划被当作完整计划。
// INV-06 状态只接受三个归一化值：守住位置 状态归一化函数；改错故障 未知状态让摘要整组失效。
// INV-07 状态分隔符统一转下划线再小写：守住位置 替换与大小写转换；改错故障 连字符写法无法识别。
// INV-08 纯字符串步骤默认首个进行中：守住位置 索引判断；改错故障 全部显示未开始。
// INV-09 字符串步骤以标题兼作标识：守住位置 标识回退；改错故障 同标题步骤键冲突。
// INV-10 标题按内容、步骤、标题、文本、进行中文案的顺序回退：守住位置 空值合并链；改错故障 兼容字段被忽略。
// INV-11 非法 JSON 输入静默返回空而不是抛错：守住位置 解析的捕获；改错故障 工具输出异常中断渲染。
// INV-12 输出候选按原值、解析值、三个包装字段展开：守住位置 候选收集函数；改错故障 嵌套字符串结果无法识别。
// INV-13 只有主代理投影才允许覆盖顶部计划：守住位置 isMainAgentToolProjectionSource；改错故障 子代理计划污染主任务。
// INV-14 来源标记为子代理时直接判否：守住位置 source 判断；改错故障 镜像工具覆盖摘要。
// INV-15 任意父工具标识存在即判否：守住位置 三个父字段检查；改错故障 父子工具树计划互相覆盖。
// INV-16 工具输入提取先过名称指纹：守住位置 输入提取函数；改错故障 任意工具输入被当计划。
// INV-17 输出提取按候选顺序返回首个有效计划：守住位置 循环提前返回；改错故障 深层包装遮蔽更准确结果。
// INV-18 本模块不持有状态，仅做纯解析：守住位置 模块边界；改错故障 解析结果被跨调用复用。
//
// 模块职责：把 todo 与计划类工具的输入或输出解析为统一的计划步骤。
// 状态所有权：无状态；计划摘要由调用方持有，本文件只做纯解析与归属判断。
// 阅读顺序：先看名称正则与集合键，再读单步解析，最后看输出候选与主代理判定。
import type { ZCodePlanStep } from "./zcode-task-types-core.js";

const TODO_TOOL_NAME_PATTERN =
  /(?:^|[_\s-])(?:todo[_\s-]*(?:read|write)|update[_\s-]*plan)(?:$|[_\s-])/i;
// PLAN_COLLECTION_KEYS 的顺序就是优先级：readPlanCollection 先命中 todos，再到 plan/steps/items，
// 每个键只有 Array.isArray 成立才采用，其他类型继续尝试下一个键；
// 新增键只能追加到末尾，否则已有工具输出里同时存在多个键时会改变解析结果。
const PLAN_COLLECTION_KEYS = ["todos", "plan", "steps", "items"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizePlanStatus(value: unknown): ZCodePlanStep["status"] | null {
  const status = readString(value)?.replace(/-/g, "_").toLowerCase();
  if (status === "pending" || status === "in_progress" || status === "completed") {
    return status;
  }
  return null;
}

// parsePlanStep 先处理字符串简写：非空字符串直接变成 { id: title, title, status }，index === 0 记 in_progress，
// 其余 pending——全部 pending 会让摘要看起来一步都没开始；
// 对象分支用 content ?? step ?? title ?? text ?? activeForm 依次取标题，normalizePlanStatus 不认的状态直接返回 null，
// 上层 extractPlanStepsFromValue 会因解析数少于 collection.length 而丢弃整组，避免半截计划覆盖完整摘要。
function parsePlanStep(value: unknown, index: number): ZCodePlanStep | null {
  if (typeof value === "string") {
    const title = value.trim();
    return title ? { id: title, title, status: index === 0 ? "in_progress" : "pending" } : null;
  }
  if (!isRecord(value)) {
    return null;
  }

  const title =
    readString(value.content) ??
    readString(value.step) ??
    readString(value.title) ??
    readString(value.text) ??
    readString(value.activeForm);
  const status = normalizePlanStatus(value.status);
  if (!title || !status) {
    return null;
  }

  return {
    id: readString(value.id) ?? title,
    title,
    status,
  };
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function readPlanCollection(input: unknown): unknown[] | null {
  const value = typeof input === "string" ? parseJsonValue(input) : input;
  if (!isRecord(value)) {
    return null;
  }
  for (const key of PLAN_COLLECTION_KEYS) {
    const collection = value[key];
    if (Array.isArray(collection)) {
      return collection;
    }
  }
  return null;
}

// extractPlanStepsFromValue 用 readPlanCollection 取出数组后先判空：空数组与非法集合都返回 null，防止空计划清掉已有摘要；
// 每步都过 parsePlanStep，filter 后只要 steps.length !== collection.length 就整组返回 null（任一步失败即全弃）；
// 返回顺序与输入一致，且每次调用重新解析，不复用缓存结果。
function extractPlanStepsFromValue(value: unknown): ZCodePlanStep[] | null {
  const collection = readPlanCollection(value);
  if (!collection || collection.length === 0) {
    return null;
  }

  const steps = collection
    .map((item, index) => parsePlanStep(item, index))
    .filter((step): step is ZCodePlanStep => step !== null);

  return steps.length === collection.length ? steps : null;
}

function collectOutputCandidates(output: unknown): unknown[] {
  const candidates: unknown[] = [output];
  const parsedOutput = typeof output === "string" ? parseJsonValue(output) : undefined;
  if (parsedOutput !== undefined) {
    candidates.push(parsedOutput);
  }

  if (isRecord(output)) {
    for (const key of ["content", "output", "result"] as const) {
      const value = output[key];
      candidates.push(value);
      if (typeof value === "string") {
        const parsedValue = parseJsonValue(value);
        if (parsedValue !== undefined) {
          candidates.push(parsedValue);
        }
      }
    }
  }

  return candidates;
}

export function isTodoPlanToolName(value: string | null | undefined): boolean {
  return typeof value === "string" && TODO_TOOL_NAME_PATTERN.test(value.trim());
}

function readClaudeParentToolUseId(value: Record<string, unknown>): string | undefined {
  const meta = value._meta;
  if (!isRecord(meta)) {
    return undefined;
  }
  const claudeCode = meta.claudeCode;
  if (!isRecord(claudeCode)) {
    return undefined;
  }
  return readString(claudeCode.parentToolUseId);
}

// isMainAgentToolProjectionSource 逐个候选检查：非对象直接跳过（不算否决），source === "subagent" 立即返回 false，
// parentToolCallId / parentToolUseId / _meta.claudeCode.parentToolUseId 任一存在也返回 false——
// subagent/workflow 会把子工具镜像进父 session，这些 TodoWrite 只属于对应父工具树，不能覆盖主任务顶部摘要；
// 只有全部候选通过才返回 true，调用方据此决定是否写入摘要。
export function isMainAgentToolProjectionSource(...candidates: unknown[]): boolean {
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    // subagent / workflow 会把子工具镜像进父 session；这些 TodoWrite
    // 只属于对应父工具树，不能覆盖主任务顶部 todo 摘要。
    if (readString(candidate.source) === "subagent") {
      return false;
    }
    if (
      readString(candidate.parentToolCallId) ||
      readString(candidate.parentToolUseId) ||
      readClaudeParentToolUseId(candidate)
    ) {
      return false;
    }
  }
  return true;
}

export function extractPlanStepsFromToolInput(params: {
  title?: string;
  kind?: string;
  input: unknown;
}): ZCodePlanStep[] | null {
  const fingerprint = [params.title, params.kind].filter(Boolean).join(" ");
  if (!isTodoPlanToolName(fingerprint)) {
    return null;
  }

  return extractPlanStepsFromValue(params.input);
}

// extractPlanStepsFromToolOutput 先拼 [title, kind] 成名称指纹并过 isTodoPlanToolName，形状不符直接返回 null，
// 避免任意工具输出被当计划；然后按 collectOutputCandidates 由浅到深（原值 → 解析值 → content/output/result
// 及其解析值）尝试，首个非空计划立即 return，深层包装就不会遮蔽更准确的结果；全部失败才返回 null。
export function extractPlanStepsFromToolOutput(params: {
  title?: string;
  kind?: string;
  output: unknown;
}): ZCodePlanStep[] | null {
  const fingerprint = [params.title, params.kind].filter(Boolean).join(" ");
  if (!isTodoPlanToolName(fingerprint)) {
    return null;
  }

  for (const candidate of collectOutputCandidates(params.output)) {
    const steps = extractPlanStepsFromValue(candidate);
    if (steps) {
      return steps;
    }
  }

  return null;
}
