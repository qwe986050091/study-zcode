import { TOOL_SEARCH_DEFAULT_RESULTS, type ToolSearchCandidate } from "@zcode/contracts";
import { toModelVisibleMcpNamePart } from "../../mcp/name.js";

/**
 * 把一个候选工具拆成检索用的三组 token。
 *
 * coarse：MCP 工具的 serverName/toolName，或非 MCP 的完整小写名；parts：进一步按空白/下划线/点切分，
 * 非 MCP 还会把 camelCase 拆成单词（ToolSearch → tool / search）；full：parts 以空格连接，用于短语加分。
 * mcp 标记决定后续打分权重（12/6 对 10/5）。副作用：无。
 * 注意：所有 token 都小写化，任何保留大小写的改动都会让查询与目录失配。
 */
function tokenize(tool: ToolSearchCandidate) {
  const name = tool.name;
  const mcp = tool.mcp
    ? [name, tool.mcp.serverName, tool.mcp.toolName]
    : /^mcp__(.+?)__(.+)$/.exec(name);
  const coarse = mcp ? [mcp[1]!, mcp[2]!].map((s) => s.toLowerCase()) : [name.toLowerCase()];
  const parts = mcp
    ? coarse.flatMap((s) => s.split(/[\s_.]+/)).filter(Boolean)
    : name
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replaceAll("_", " ")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
  return { coarse, parts, full: parts.join(" "), mcp: Boolean(mcp) };
}

/**
 * 按 canonical 名或 aliases 精确解析候选工具；找不到返回 undefined。
 * 注意：别名只做精确匹配（不做模糊）；调用方决定先查 deferred 还是回退全目录。
 */
function resolveName(name: string, catalog: readonly ToolSearchCandidate[]) {
  return catalog.find((tool) => tool.name === name || tool.aliases?.includes(name));
}

/**
 * 在 ToolSearch 目录里检索，返回工具名字符串列表（不含 schema）。
 *
 * 查询形态与优先级：
 * 1) "select:A,B" —— 精确取定义，支持 canonical 名 / alias / MCP toolName（含模型可见名），命中即返回，
 * 不按 maxResults 截断，并按首次出现顺序去重。
 * 2) 完整名称精确命中（deferred 优先）；3) "mcp__" 前缀只列 deferred 并截断；
 * 4) 关键词——"+term" 是必须命中的硬条件，其余参与打分。
 * 输入口径：maxResults 默认 TOOL_SEARCH_DEFAULT_RESULTS = 5，单位是"工具个数"不是字节。
 * 失败/降级：无异常路径；无命中返回空数组，由 handler 转成 "No matching deferred tools found"。
 * 副作用：无（纯函数），可并发安全调用。
 */
export function searchTools(
  query: string,
  catalog: readonly ToolSearchCandidate[],
  maxResults = TOOL_SEARCH_DEFAULT_RESULTS,
): string[] {
  // 主检索面是 deferred；只有 select 允许回退到常驻目录（返回定义不改变其调用方式）。
  const deferred = catalog.filter((tool) => tool.deferred);
  const select = /^select:(.+)$/i.exec(query);
  if (select)
    // select 不截断 maxResults：调用方显式点名，截断会让合法请求静默少工具。
    return [
      ...new Set(
        select[1]!.split(",").flatMap((value) => {
          const name = value.trim();
          // 优先在延迟集合里解析；同名常驻工具不应遮蔽可加载项，别名兼容靠全目录兜底。
          const exact = resolveName(name, deferred) ?? resolveName(name, catalog);
          if (exact) return [exact.name];
          // MCP 允许用裸 toolName / 模型可见名选中，但返回的仍是完整 mcp__server__tool canonical 名。
          return catalog
            .filter(
              (tool) =>
                tool.mcp &&
                (tool.mcp.toolName === name ||
                  toModelVisibleMcpNamePart(tool.mcp.toolName) === name),
            )
            .map((tool) => tool.name);
        }),
      ),
    ];
  const text = query.toLowerCase().trim();
  // 名称精确命中优先于关键词打分：避免 "Read" 被拆成词后与大量工具同分。
  const exact =
    deferred.find((tool) => tool.name.toLowerCase() === text) ??
    catalog.find((tool) => tool.name.toLowerCase() === text);
  if (exact) return [exact.name];
  if (text.startsWith("mcp__") && text.length > 5) {
    // 只查 deferred：常驻 MCP 工具已带 schema，重复列出只会浪费一次结果名额。
    const names = deferred
      .filter((tool) => tool.name.toLowerCase().startsWith(text))
      .slice(0, maxResults)
      .map((tool) => tool.name);
    if (names.length > 0) return names;
  }
  const terms = text.split(/\s+/).filter(Boolean);
  // "+term" 是硬过滤，不参与"未知词"降级；它本身也进 keywords，以复用同一套正则与打分。
  const required = terms
    .filter((term) => term.startsWith("+") && term.length > 1)
    .map((term) => term.slice(1));
  const keywords =
    required.length > 0
      ? [...required, ...terms.filter((term) => !(term.startsWith("+") && term.length > 1))]
      : terms;
  // 正则加单词边界并转义元字符：既避免 "git" 命中 "digital"，也避免用户输入 "(" 造成无效正则抛错。
  const patterns = new Map(
    keywords.map((term) => [
      term,
      new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
    ]),
  );
  return deferred
    .map((tool) => {
      const name = tokenize(tool);
      const description = tool.description?.toLowerCase() ?? "";
      const hint = tool.searchHint?.toLowerCase() ?? "";
      // 硬性条件：任一词必须在名/粗粒度名/描述/hint 之一命中；description 与 hint 缺失时正则仍可安全执行。
      if (
        !required.every(
          (term) =>
            name.parts.some((part) => part.includes(term)) ||
            name.coarse.some((part) => part.includes(term)) ||
            patterns.get(term)!.test(description) ||
            patterns.get(term)!.test(hint),
        )
      )
        return { name: tool.name, score: 0 };
      let score = 0;
      // 打分口径：名称精确命中权重最高（MCP 12 / 非 MCP 10），前缀命中次之（6/5），
      // 粗粒度名（server/toolName）命中 12/10 或 4/3，hint 4 分，描述 2 分。
      for (const term of keywords) {
        if (name.parts.includes(term)) score += name.mcp ? 12 : 10;
        else if (name.parts.some((part) => part.includes(term))) score += name.mcp ? 6 : 5;
        if (name.coarse.includes(term)) score += name.mcp ? 12 : 10;
        else if (name.coarse.some((part) => part.includes(term))) score += name.mcp ? 4 : 3;
        // 反直觉：短语兜底只在当前累计分数仍为 0 时加 3，避免多词查询被同一短语反复抬分。
        if (name.full.includes(term) && score === 0) score += 3;
        if (hint && patterns.get(term)!.test(hint)) score += 4;
        if (patterns.get(term)!.test(description)) score += 2;
      }
      return { name: tool.name, score };
    })
    // 只保留正分候选；零分意味着仅靠 required 之外的词没有相关性，不应占 maxResults 名额。
    .filter((tool) => tool.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((tool) => tool.name);
}
