// ============================================================
// ToolSearch Tool 契约 - 延迟工具发现与 tool_reference 身份
// ============================================================
// 生产者：core 的 handlers/tool-search.ts 在当前允许的 catalog 内检索，返回工具名列表；
// 消费者：模型面把命中转成 `tool_reference` 内容块，由 provider 展开对应 schema（客户端只回
// 真实引用，不伪造定义）。相邻契约 deferred-tool-call.ts 承担"按名调用"的另一半。
// 身份不变量：catalog 里同一工具可能同时有 name/aliases/mcp 身份；匹配按这些身份归一，但
// 真正执行仍以解析后的工具名为准——搜索命中不等于已授权，权限在 executor 侧独立判定。
// 持久化不变量：`tool_reference` 块要能原样回放进历史，因此它的 schema 与文本块并列存储，
// 不能被剥成纯文本；丢失引用会让冷恢复后的模型看到"提过一个不存在的工具"。

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { JsonSchema } from "../model/index.js";

// 工具名：与 provider 原生 ToolSearch 名一致，也是延迟工具发现链路的入口标识。
export const TOOL_SEARCH_NAME = "ToolSearch";
// 检索模式四态：auto（按宿主能力决定）、native（provider 原生检索）、local（本地 catalog
// 检索）、off（关闭）。它是配置输入，不是模型可写的运行时参数。
export const ToolSearchModeSchema = z.enum(["auto", "native", "local", "off"]);
// 配置层使用的模式类型，含 `auto`（尚未解析成具体实现）。
export type ToolSearchMode = z.infer<typeof ToolSearchModeSchema>;
// 解析后的模式：`auto` 已被宿主能力判定替换，执行路径只面对 native/local/off 三值。
export type ResolvedToolSearchMode = Exclude<ToolSearchMode, "auto">;
// 单次检索的默认返回条数（5）。入参 `max_results` 的默认值取自这里，provider schema 与实际
// 执行共用同一常量，避免两处口径漂移。
export const TOOL_SEARCH_DEFAULT_RESULTS = 5;
// provider 侧 beta 能力标识：开启后模型可以调用工具检索并使用 tool_reference 展开 schema。
// 它是协议握手字符串，改动会直接影响 provider 是否接受该请求。
export const TOOL_SEARCH_BETA = "advanced-tool-use-2025-11-20";
// 工具面增量公告：一次检索后告诉 provider/客户端"新增了哪些、移除了哪些、重新加回了哪些"。
// 三个数组都是工具名（非 schema）；`readdedNames ⊆ addedNames` 由 refine 强制——重新加载的
// 工具必须先出现在新增集合里，否则消费方会收到一个无法展开的引用。
export const ToolSearchAnnouncementSchema = z
  .object({
    addedNames: z.array(z.string().min(1)),
    removedNames: z.array(z.string().min(1)),
    readdedNames: z.array(z.string().min(1)),
  })
  .strict()
  .refine((delta) => delta.readdedNames.every((name) => delta.addedNames.includes(name)), {
    message: "Readded tool names must be included in addedNames",
  });
// 模型内容块：只携带工具名，不带 schema。provider 收到后自行展开定义，客户端不得伪造
// `input_schema` 等内容；`toolName` 必须与 catalog 中的身份一致，否则展开会失败。
export const ToolReferenceContentSchema = z
  .object({
    type: z.literal("tool_reference"),
    toolName: z.string().min(1),
  })
  .strict();
// 该内容块的 TS 投影，用于会话消息与事件里的模型内容联合类型。
export type ModelToolReferenceContentBlock = z.infer<typeof ToolReferenceContentSchema>;
// 落库/回放的工具检索内容：文本块与 tool_reference 的联合数组，至少一项。
// 最小长度 1 是刻意的——空数组会让部分 provider 把 assistant 消息判为非法，也会让历史行
// 丢失"这次调用确实发生过"的证据。
export const PersistedToolSearchContentSchema = z
  .array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }).strict(),
      ToolReferenceContentSchema,
    ]),
  )
  .min(1);
// 模型入参（这里**不是** strict：检索是宽松能力，多一个未知键不该让检索失败）。
// query 支持 `select:<tool_name>` 直接点名，或自然语言关键词；max_results 默认 5，上限未在
// schema 强制，由检索实现按 catalog 大小自然收敛。
export const ToolSearchInputSchema = z.object({
  query: z
    .string()
    .describe(
      'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
    ),
  max_results: z
    .number()
    .optional()
    .default(TOOL_SEARCH_DEFAULT_RESULTS)
    .describe("Maximum number of results to return (default: 5)"),
});
// 检索结果：`matches` 是匹配到的工具名（不是 schema），`query` 回显便于日志归因，
// `total_deferred_tools` 统计 catalog 中**全部**延迟工具（不是命中数），让模型知道还有多少
// 未加载。三者都无上限约束：结果规模由 catalog 与 max_results 在实现侧控制。
export const ToolSearchOutputSchema = z.object({
  matches: z.array(z.string()),
  query: z.string(),
  total_deferred_tools: z.number(),
});
// provider 可见入参 schema 覆盖 required：转换器把带默认值的 max_results 标成可选，但模型侧
// 要求显式传入；执行侧仍会补默认值，两处口径不同是刻意的兼容安排。
export const ToolSearchInputJsonSchema = {
  ...(zodToJsonSchema(ToolSearchInputSchema) as JsonSchema),
  // 转换器会把带默认值的字段视为可选；模型侧要求显式传入，执行侧仍先补默认值。
  required: ["query", "max_results"],
};
// 输出侧 JSON schema（由 zod 直接转换）；仅用于契约对齐与测试，模型看到的是 tool_reference。
export const ToolSearchOutputJsonSchema = zodToJsonSchema(ToolSearchOutputSchema) as JsonSchema;
// 宿主能力声明：`protocolSupported` 表示 provider 协议支持 tool_reference 展开；
// `defaultEnabled` 表示未显式配置时是否默认开启。两者都由宿主探测得出，模型不可改。
export interface ToolSearchCapability {
  readonly protocolSupported: boolean;
  readonly defaultEnabled: boolean;
}
// 检索候选：这是工具面检索的**唯一身份来源**。`name` 是最终执行名；`aliases` 是历史/别名
// 身份（命中任一即可）；`mcp` 保留 server/tool 双段身份以便按命名空间隔离；`deferred` 区分
// 常驻与延迟工具。`description`/`searchHint` 只参与匹配与展示，不参与执行。
export interface ToolSearchCandidate {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly mcp?: { readonly serverName: string; readonly toolName: string };
  readonly description?: string;
  readonly searchHint?: string;
  readonly deferred: boolean;
}
// 一次检索的执行上下文：`mode` 是已解析模式（无 auto），`enabled` 是最终开关，
// `catalog` 是当前**已允许**的工具面（不是全量注册表），`discovered` 记录本轮已加载的名字，
// 用于去重与增量公告。catalog 已按权限/可见性裁剪，因此命中不等于允许执行。
export interface ToolSearchExecutionContext {
  readonly mode: ResolvedToolSearchMode;
  readonly enabled: boolean;
  readonly catalog: readonly ToolSearchCandidate[];
  readonly discovered: ReadonlySet<string>;
}
