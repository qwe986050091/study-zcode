// ============================================================
// context-usage-breakdown —— 上下文用量分类下的"贡献者明细"投影
// ============================================================
//
// 【定位】
//   本文件只服务于诊断展示(context-usage.ts 的 /context-usage 输出):
//   把"某个分类(system prompt / 工具 schema / 技能 / 消息)占了 X token"
//   进一步下钻到"具体是哪个 section / 哪个工具 / 哪个技能 / 哪个 role"。
//
// 【口径】
//   - 纯投影:contributors 的 chars/tokens/tokenMethod/confidence/tokenizer
//     全部原样取自上游明细,本文件不做估算、不重算、不合并;
//   - 分类与贡献者之间靠 source 关联:buildCategoryBreakdown 找不到分类时
//     返回 undefined(上游会把 0 token 分类过滤掉,此时明细也无意义);
//   - 本层不参与模型请求,不影响 compact/预算,仅用于展示与排障。
//
// 【副作用】
//   无。所有函数都是无 I/O、无缓存的纯函数。
// ============================================================
import type {
  ContextUsageCategory,
  ContextUsageMetric,
  ContextUsageMessageRoleBreakdown,
  ContextUsageSkillDetail,
  ContextUsageToolDetail,
} from "../types.js";

/** 贡献者类型:决定 UI 用哪种行渲染,也决定哪些可选字段有意义。 */
type ContextUsageContributorKind = "context_section" | "tool_schema" | "skill" | "message_role";

/**
 * 单条贡献者明细(分类内的一个 section / 工具 / 技能 / role)。
 * 继承 ContextUsageMetric:chars / tokens / tokenMethod / confidence / tokenizer
 * 均来自上游明细,本文件不做二次估算。
 */
export interface ContextUsageContributor extends ContextUsageMetric {
  /** 生成该明细所用的 cache 提示(仅 context_section 有)。 */
  cacheHint?: string;
  /** 该明细归属的分类 source,必须与父分类一致。 */
  categorySource: ContextUsageCategory["source"];
  /** message_role 专用:该 role 的消息条数。 */
  count?: number;
  /** 该 section 注入到请求的目标位置(prompt / user context 等)。 */
  injectionTarget?: string;
  /** 明细种类,决定 UI 渲染形态。 */
  kind: ContextUsageContributorKind;
  /** 展示用名称(通常等于 name,message_role 为 role 字符串)。 */
  label: string;
  /** 工具 / 技能 / section 的原始名称。 */
  name?: string;
  /** 技能文件路径(仅 skill)。 */
  path?: string;
  /** 工具是否只读(仅 tool_schema)。 */
  readOnly?: boolean;
  /** 消息 role(仅 message_role)。 */
  role?: string;
  /** 技能作用域(仅 skill)。 */
  scope?: string;
  /** MCP server 名(仅 mcp 工具)。 */
  serverName?: string;
  /** 工具副作用范围声明(仅 tool_schema)。 */
  sideEffectScope?: string;
  /** 上游来源标识(section 来源 / 工具来源 / 技能来源)。 */
  source?: string;
}

/** 分类 + 其下明细:categories 与 categoryBreakdown 通过 source 对齐。 */
export interface ContextUsageCategoryBreakdown extends ContextUsageCategory {
  /** 该分类下的明细集合;顺序沿用上游(通常与请求拼装顺序一致)。 */
  contributors: ContextUsageContributor[];
}

/** 可注入的性能 section 明细(系统提示 / meta user / tool prompt 共用)。 */
export type ContextUsageSectionDetail = ContextUsageMetric & {
  /** 该 section 的 cache 断点提示。 */
  cacheHint: string;
  /** 注入目标位置。 */
  injectionTarget: string;
  /** section 名称。 */
  name: string;
  /** section 来源标识。 */
  source: string;
};

/**
 * 把"分类"与"该分类下的明细"组合成一条 breakdown。
 *
 * 输入:按 source 索引的分类表、目标 source、贡献者数组。
 * 输出:带 contributors 的分类;分类不存在时返回 undefined。
 * 为什么允许 undefined:上游会过滤掉 tokens=0 的分类,
 *   这类分类在 totals/percent 里本来就不出现,若强行给空明细
 *   会让 UI 出现"0 token 但有行"的噪声。
 * 副作用:无。
 */
export function buildCategoryBreakdown(
  categoryBySource: ReadonlyMap<ContextUsageCategory["source"], ContextUsageCategory>,
  source: ContextUsageCategory["source"],
  contributors: ContextUsageContributor[],
): ContextUsageCategoryBreakdown | undefined {
  const category = categoryBySource.get(source);
  if (!category) return undefined;
  return {
    ...category,
    contributors,
  };
}

/**
 * 把一个上下文 section 投影成贡献者明细。
 * 输入/输出逐字段 1:1 透传(chars/tokens/tokenMethod/confidence/tokenizer),
 * 额外补 kind=context_section 与所属 categorySource;不做任何重算。
 */
export function sectionContributor(
  categorySource: ContextUsageCategory["source"],
  section: ContextUsageSectionDetail,
): ContextUsageContributor {
  return {
    kind: "context_section",
    categorySource,
    label: section.name,
    name: section.name,
    source: section.source,
    injectionTarget: section.injectionTarget,
    cacheHint: section.cacheHint,
    chars: section.chars,
    tokens: section.tokens,
    tokenMethod: section.tokenMethod,
    confidence: section.confidence,
    tokenizer: section.tokenizer,
  };
}

/**
 * 把一个工具 schema 明细投影成贡献者。
 * 保留 name / serverName / readOnly / sideEffectScope,便于展示"哪个工具占了多少、
 * 是否只读、副作用范围";度量字段原样透传。
 */
export function toolContributor(
  categorySource: ContextUsageCategory["source"],
  tool: ContextUsageToolDetail,
): ContextUsageContributor {
  return {
    kind: "tool_schema",
    categorySource,
    label: tool.name,
    name: tool.name,
    source: tool.source,
    serverName: tool.serverName,
    readOnly: tool.readOnly,
    sideEffectScope: tool.sideEffectScope,
    chars: tool.chars,
    tokens: tool.tokens,
    tokenMethod: tool.tokenMethod,
    confidence: tool.confidence,
    tokenizer: tool.tokenizer,
  };
}

/**
 * 把一个技能明细投影成贡献者。
 * 保留 scope / path 以便定位技能文件;度量字段原样透传,不做二次估算。
 */
export function skillContributor(
  categorySource: ContextUsageCategory["source"],
  skill: ContextUsageSkillDetail,
): ContextUsageContributor {
  return {
    kind: "skill",
    categorySource,
    label: skill.name,
    name: skill.name,
    source: skill.source,
    scope: skill.scope,
    path: skill.path,
    chars: skill.chars,
    tokens: skill.tokens,
    tokenMethod: skill.tokenMethod,
    confidence: skill.confidence,
    tokenizer: skill.tokenizer,
  };
}

/**
 * 把"按 role 的消息统计"投影成贡献者。
 * categorySource 固定为 messages:该分类本身已排除 system / meta user
 * (它们在上游按 section 单独统计),这里不能再把 system 消息算进来,
 * 否则会重复计数。
 */
export function messageRoleContributor(
  message: ContextUsageMessageRoleBreakdown,
): ContextUsageContributor {
  return {
    kind: "message_role",
    categorySource: "messages",
    label: message.role,
    role: message.role,
    count: message.count,
    chars: message.chars,
    tokens: message.tokens,
    tokenMethod: message.tokenMethod,
    confidence: message.confidence,
    tokenizer: message.tokenizer,
  };
}
