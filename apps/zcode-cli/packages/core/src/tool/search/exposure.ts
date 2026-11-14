import { LOCAL_TOOL_SEARCH_DESCRIPTION } from "./description.js";
import {
  TOOL_SEARCH_NAME,
  DEFERRED_TOOL_CALL_NAME,
  type ToolSearchMode,
  type ResolvedToolSearchMode,
  type Model,
  type ModelToolContract,
  type ToolSearchCandidate,
  type ToolSearchExecutionContext,
} from "@zcode/contracts";
import type { ToolRegistry } from "../registry.js";
import type { ToolMetadata } from "../types.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { collectToolSearchHistory, projectToolReferences } from "./history.js";

// 常量口径：ADDED_TOOLS_NOTICE / LOCAL_ADDED_TOOLS_NOTICE 是"首次公告"的引导语，分别对应
// Native（schema 由 provider 展开、直接调用）与 Local（必须经 DeferredToolCall 执行）两种约定。
// MAX_REMOVED_NAME_LINES = 30：删除名单超过 30 行时改为按 server 归并成一行，避免一次目录收缩刷屏。
// AMBIENT_CONTEXT_NOTICE 固定追加在删除公告末尾，提示这是环境事实，不应被转述成用户诉求。
const ADDED_TOOLS_NOTICE = `The following deferred tools are now available via ${TOOL_SEARCH_NAME}. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ${TOOL_SEARCH_NAME} with query "select:<name>[,<name>...]" to load tool schemas before calling them:`;
const LOCAL_ADDED_TOOLS_NOTICE = `The following deferred tools are available via ${TOOL_SEARCH_NAME}. Use query "select:<name>[,<name>...]" to load their complete schemas, then call them through ${DEFERRED_TOOL_CALL_NAME} with {name, input}. Call resident tools directly:`;
const MAX_REMOVED_NAME_LINES = 30;
const AMBIENT_CONTEXT_NOTICE =
  "This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.";

/**
 * 把配置层 ToolSearchMode 解析成本请求真正可用的 ResolvedToolSearchMode。
 *
 * 口径：off 恒为 off；native 要求 provider 的 toolSearch.protocolSupported（Anthropic Messages 类协议）；
 * auto 只在"协议支持且 defaultEnabled"时升级为 native，否则回落到 local（模型支持 tool call 时）。
 * 失败：显式请求 native 但协议不支持、显式请求 local 但模型不支持 tool call，都会抛普通 Error；
 * 这是配置错误，由上层（config.ts 与请求准备）暴露，不在本函数内静默降级。
 * 副作用：无。消费者：buildToolExposure、buildToolSearchAnnouncement、config.isToolSearchEnabled。
 */
export function resolveToolSearchMode(
  model: Model,
  mode: ToolSearchMode = "off",
): ResolvedToolSearchMode {
  const capability = model.requestCapabilities?.toolSearch;
  if (mode === "off") return "off";
  if (mode === "native") {
    if (!capability?.protocolSupported)
      throw new Error("--toolsearch-mode native requires an Anthropic Messages provider.");
    return "native";
  }
  if (mode === "auto" && capability?.protocolSupported && capability.defaultEnabled)
    return "native";
  if (model.properties.supportsToolCall) return "local";
  if (mode === "local")
    throw new Error("--toolsearch-mode local requires a provider that supports tool calls.");
  return "off";
}

/**
 * 判断一个已暴露的工具契约是否属于"延迟加载"集合（工具面裁剪的唯一判定点）。
 *
 * 排除项依次是：ToolSearch / DeferredToolCall 自身（否则模型要先加载搜索器才能搜索）、
 * providerNative（由 provider 原生管理，客户端不能改写其 defer 语义）、alwaysLoad 显式常驻工具。
 * 命中条件：metadata.shouldDefer === true，或声明了 mcpPresentation（MCP 工具默认延迟）。
 * 注意：metadata 缺席（工具未注册）时不会延迟——宁可多带 schema，也不能让工具在请求里直接消失。
 */
export function isDeferredTool(tool: ModelToolContract, metadata?: ToolMetadata): boolean {
  return (
    tool.name !== TOOL_SEARCH_NAME &&
    tool.name !== DEFERRED_TOOL_CALL_NAME &&
    !tool.providerNative &&
    metadata?.alwaysLoad !== true &&
    (metadata?.shouldDefer === true || metadata?.mcpPresentation !== undefined)
  );
}

/**
 * 一次 provider 请求的"工具面"输入快照；所有字段都按只读消费，本模块不改写调用方状态。
 *
 * 组合口径：model 决定 provider 能力；mode 是 config.toolSearch?.mode 的原值；
 * tools 是注册表导出的当前候选契约；registry 可选，缺席时读不到 metadata；
 * entries 是当前请求历史，用于恢复"已发现/已公告"的 durable 事实。
 */
interface ToolExposureInput {
  // provider 能力来源：requestCapabilities.toolSearch 与 properties.supportsToolCall。
  model: Model;
  // 配置原值；undefined 时 resolveToolSearchMode 按 "off" 处理，避免漏传即开启延迟工具。
  mode?: ToolSearchMode;
  // 候选工具面（顺序即 provider-visible 顺序，调用方可能已做稳定排序）；本模块只过滤、不重排。
  tools: readonly ModelToolContract[];
  // metadata 读取口（shouldDefer / alwaysLoad / mcpPresentation / aliases / searchHint）；缺席即视为无延迟配置。
  registry?: Pick<ToolRegistry, "get">;
  // 请求历史条目；只读，用于收集 tool_reference 与 compact 边界事实。
  entries: readonly RuntimeMessageEntry[];
}

/**
 * 计算本请求的目录、延迟集合与最终启用状态（buildToolExposure 与公告重建共用同一份逻辑）。
 *
 * 输出字段：catalog 是全量候选（含常驻与已提升工具）；deferred 是仍需延迟加载的名称集；
 * enabled/mode 是最终决策（不可启用时 mode 必须回落 off）；reason 用于诊断
 * （provider_disabled | no_deferred_tools | tool_unavailable）。
 * 不变量：只有"存在可延迟工具"且"控制入口齐备"时才 enabled；否则下游 filter 会按 mode 裁工具，
 * 却没有 ToolSearch 可以补救，模型将永久看不到这些 schema。
 * 副作用：无（纯计算）。注意：Local 下 compact 前已发现的工具不再 deferred，直接以常驻身份进请求。
 */
function resolveToolSearchCatalog(
  input: ToolExposureInput,
  preCompactDiscoveredTools: ReadonlySet<string>,
) {
  const requestedMode = resolveToolSearchMode(input.model, input.mode);
  let hasConfiguredDeferred = false;
  const catalog: ToolSearchCandidate[] = input.tools
    // 为什么：DeferredToolCall 只是 Local 模式的包装入口；native 由 provider 直接调用，不能进目录。
    .filter((tool) => requestedMode === "local" || tool.name !== DEFERRED_TOOL_CALL_NAME)
    .map((tool) => {
      const entry = input.registry?.get(tool.name);
      const metadata = entry?.metadata;
      const configuredDeferred = isDeferredTool(tool, metadata);
      hasConfiguredDeferred ||= configuredDeferred;
      return {
        name: tool.name,
        aliases: entry?.aliases,
        description: tool.description,
        searchHint: metadata?.searchHint,
        mcp: metadata?.mcpPresentation,
        // 反直觉：Local 下 compact 前已发现的工具不再延迟——压缩后直接带 schema 比再搜一次更省。
        deferred:
          configuredDeferred &&
          !(requestedMode === "local" && preCompactDiscoveredTools.has(tool.name)),
      };
    });
  const deferred = new Set(catalog.filter((tool) => tool.deferred).map((tool) => tool.name));
  // native 只需要 ToolSearch 本体；local 还必须存在 DeferredToolCall，否则搜到工具也无法执行。
  const controlsAvailable =
    catalog.some((tool) => tool.name === TOOL_SEARCH_NAME) &&
    (requestedMode !== "local" || catalog.some((tool) => tool.name === DEFERRED_TOOL_CALL_NAME));
  // 全部提升后仍需要控制入口处理后续目录变化，不能用剩余 deferred 数量关闭 Local。
  const enabled = requestedMode !== "off" && hasConfiguredDeferred && controlsAvailable;
  const mode: ResolvedToolSearchMode = enabled ? requestedMode : "off";
  return {
    catalog,
    deferred,
    enabled,
    mode,
    // reason 只用于诊断/遥测，不参与控制流；三态分别对应"配置关闭 / 无可延迟工具 / 控制工具缺失"。
    reason: enabled
      ? mode
      : requestedMode === "off"
        ? "provider_disabled"
        : !hasConfiguredDeferred
          ? "no_deferred_tools"
          : "tool_unavailable",
  };
}

/**
 * 构造一次请求的最终工具面：过滤后的 tools + 历史投影 + ToolSearch 决策上下文。
 *
 * 输入：见 ToolExposureInput。输出字段：
 * tools —— 真正发给 provider 的契约（ToolSearch 仅在 enabled 时出现，DeferredToolCall 仅 Local）；
 * entries / loadedToolCallIds —— 历史投影结果，后者供结算层标记"已完成加载"的 tool call；
 * enabled / context / reason —— 供 handler、config 与遥测读取，不改变消息内容。
 * 副作用：无（纯投影），不写 durable、不发事件。
 * 顺序不变量：调用方必须先拿本函数的 entries 再做消息投影（见 prepareRuntimeProviderRequest）；
 * 反过来投影会看到已移除的 tool_reference，而 tools 已过滤，产生自相矛盾的请求。
 */
export function buildToolExposure(input: ToolExposureInput) {
  const { discovered, preCompactDiscoveredTools } = collectToolSearchHistory(input.entries);
  const { catalog, deferred, enabled, mode, reason } = resolveToolSearchCatalog(
    input,
    preCompactDiscoveredTools,
  );
  const tools = input.tools
    // 三类分别处理：控制入口按启用态放行；其余按 mode/deferred/discovered 决定是否保留。
    .filter((tool) => {
      if (tool.name === TOOL_SEARCH_NAME) return enabled;
      if (tool.name === DEFERRED_TOOL_CALL_NAME) return mode === "local";
      return (
        mode === "off" ||
        !deferred.has(tool.name) ||
        (mode === "native" && discovered.has(tool.name))
      );
    })
    .map((tool) => {
      // 为什么先剥掉 deferLoading：它是上一次请求（native）可能留下的残留，必须按当前 mode 重算；
      // 否则切到 local/off 后 provider 仍按延迟工具处理，schema 不会随请求发送。
      const { deferLoading: _previous, ...contract } = tool;
      // Local 整体替换 ToolSearch 文案：Native 文案会让模型直接调用，而 Local 必须走 DeferredToolCall。
      if (mode === "local" && tool.name === TOOL_SEARCH_NAME)
        return {
          ...contract,
          description: LOCAL_TOOL_SEARCH_DESCRIPTION,
        };
      // native 才重新打上 deferLoading：provider 依据它把 schema 延迟到 tool_reference 命中后再展开。
      return mode === "native" && deferred.has(tool.name)
        ? { ...contract, deferLoading: true }
        : contract;
    });
  // Local 使用完整目录，且常驻控制工具以实际发送的定义覆盖原文案。
  // 传 [...input.tools, ...tools] 的原因：本轮被裁掉的工具只要历史里引用过，定义仍要能渲染出来。
  const projection = projectToolReferences(
    input.entries,
    mode,
    mode === "local" ? [...input.tools, ...tools] : tools,
    deferred,
  );
  const context: ToolSearchExecutionContext = { enabled, mode, catalog, discovered };
  return { tools, ...projection, enabled, context, reason };
}

// Bug 根因：请求投影中生成的公告晚于续写快照，恢复快照后会反复生成并累积到主历史。
// 公告只由正常提醒收集和 compact 重建调用，提交历史后才生成请求快照。
// 职责：把"延迟工具集合相对已公告事实的差分"写成一条 attachment（added / readded / removed 三类）。
// 输入口径：input.tools 是当前作用域完整候选（判断 removed 必须对照它，而不是过滤后的 tools）；
// compactDiscoveredTools 是压缩前已发现集合，用于重建时不重复公告。
// 输出：undefined = 无变化；否则 metadata.toolSearchAnnouncement 就是要落盘的增量事实。
// 副作用：无——本函数只生成条目；持久化由 turn-loop.ts 在请求前完成（先落盘再进内存历史）。
// 不变量：readded ⊆ addedNames，且 removed 只删 announced 不删 listed，否则下轮重建会漏报或重复。
export function buildToolSearchAnnouncement(
  input: ToolExposureInput,
  compactDiscoveredTools?: ReadonlySet<string>,
): RuntimeMessageEntry | undefined {
  // Off 不需要公告或提升信息，保持关闭路径不扫描公告历史。
  if (resolveToolSearchMode(input.model, input.mode) === "off") return undefined;
  // Bug 根因：全量 metadata 与增量正文不一致，compact 保留尾部时会误以为旧名称仍在上下文。
  // 只从保留的公告事实恢复状态；恢复提示不算完整列名，原始列名被压缩后仍需补齐。
  // announced = 仍被认为"已公告可用"的集合；listed = 曾逐行列出完整名称的集合。
  // 两者分离是为了区分"首次列出"与"删除后又回来"——后者只发一行提示，不重复贴 schema 清单。
  const announced = new Set<string>();
  const listed = new Set<string>();
  const preCompactDiscoveredTools = new Set(compactDiscoveredTools);
  for (const entry of input.entries) {
    for (const name of entry.metadata?.compactBoundary?.preCompactDiscoveredTools ?? [])
      preCompactDiscoveredTools.add(name);
    const delta = entry.metadata?.toolSearchAnnouncement;
    if (!delta) continue;
    const readded = new Set(delta.readdedNames);
    for (const name of delta.addedNames) {
      announced.add(name);
      if (!readded.has(name)) listed.add(name);
    }
    // 注意：removed 只从 announced 删除，listed 保留——这正是 readded 能被识别出来的依据。
    for (const name of delta.removedNames) announced.delete(name);
  }
  // 用与 buildToolExposure 相同的目录解析，保证公告与现实暴露的工具面同源。
  const { enabled, deferred, mode } = resolveToolSearchCatalog(input, preCompactDiscoveredTools);
  if (!enabled) return undefined;
  // 排序只为让公告文本稳定，便于缓存前缀与回归比对。
  const names = [...deferred].sort();
  // 从未公告过，或曾公告但没进过完整列名 → 需要补告；曾列入清单、被移除后又回来 → 走"available again"。
  const addedNames = names.filter((name) => !announced.has(name) || !listed.has(name));
  const readdedNames = names.filter((name) => !announced.has(name) && listed.has(name));
  // deferred 转 alwaysLoad 后工具仍然可用，删除必须对照完整的当前作用域目录。
  const available = new Set(input.tools.map((tool) => tool.name));
  const removedNames = [...announced].filter((name) => !available.has(name)).sort();
  if (addedNames.length === 0 && removedNames.length === 0) return undefined;
  const readded = new Set(readdedNames);
  const listedNames = addedNames.filter((name) => !readded.has(name));
  const paragraphs: string[] = [];
  if (listedNames.length)
    paragraphs.push(
      `${mode === "local" ? LOCAL_ADDED_TOOLS_NOTICE : ADDED_TOOLS_NOTICE}\n${listedNames.join("\n")}`,
    );
  // 目录变化只证明当前可用性，不能据此推断 MCP 连接状态或其他变化原因。
  if (readdedNames.length) {
    paragraphs.push(
      `${readdedNames.length} deferred tool${readdedNames.length === 1 ? " is" : "s are"} available again (names announced earlier in this conversation): ${summarizeToolNames(readdedNames)}. Load via ${TOOL_SEARCH_NAME} as before.`,
    );
  }
  if (removedNames.length) {
    // 名称事实仍完整保留在 metadata；只有模型可见文案按 server 分组，避免大批删除刷屏。
    paragraphs.push(
      removedNames.length > MAX_REMOVED_NAME_LINES
        ? `${removedNames.length} deferred tools are no longer available: ${summarizeToolNames(removedNames)}. Do not search for them — ${TOOL_SEARCH_NAME} will return no match.`
        : `The following deferred tools are no longer available. Do not search for them — ${TOOL_SEARCH_NAME} will return no match:\n${removedNames.join("\n")}`,
      AMBIENT_CONTEXT_NOTICE,
    );
  }
  return {
    kind: "attachment",
    content: paragraphs.join("\n\n"),
    metadata: {
      // source 决定 system-reminder 通道 / 冷恢复生命周期；改名会让 hydrateToolSearchAnnouncement 读不回来。
      source: "tool_search_announcement",
      // 三个名称集合是 durable 事实：正文可重写，但这里必须保留完整名单用于下一轮差分。
      toolSearchAnnouncement: { addedNames, removedNames, readdedNames },
    },
  };
}

/**
 * 把工具名列表压成一行可读摘要，用于大批量 added/removed 公告文案。
 *
 * 口径：mcp__<server>__<tool> 归并为 mcp__<server>__* 并标注数量；非 MCP 名原样保留；
 * 结果按分组名排序，保证同一集合每次产出相同文本（缓存友好、回归可比对）。
 * 副作用：无。注意：只影响模型可见文案，metadata 里仍保留完整名称用于下一轮差分。
 */
function summarizeToolNames(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) {
    const group = name.startsWith("mcp__") ? `${name.split("__", 2).join("__")}__*` : name;
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => (count > 1 ? `${name} (${count})` : name))
    .join(", ");
}
