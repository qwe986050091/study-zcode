// ============================================================================
// 职责边界
// 做：把 subagent markdown 的 frontmatter 切成键值表——识别 --- 分隔、键值去空白、
//     续接多行列表、做标量类型转换，并把 mcpServers 名字列表单独收敛成字符串数组。
// 不做：不做字段 schema 校验（color、permissionMode 等在上层归一），不读文件，
//       不实现完整 YAML，不抛异常；非法输入一律降级为空结果或原字符串。
// 依赖：无外部依赖，纯字符串处理；导出 splitMarkdownFrontmatter 与 parseAgentFrontmatter。
// 边界：键名只认字母开头的 [A-Za-z0-9_-]*，其余行静默跳过；未知键照常写入 values，
//       本层不丢弃也不告警，是否取用由上层决定。
// 观测：没有日志与异常出口，失败只体现为三种形态——undefined 未配置、null 配置非法、数组合法。
//
// INV 不变量表
// INV-01 BOM 必须在判断分隔符前剥离；守住位置：splitMarkdownFrontmatter 的 normalized 赋值；改错故障：带 BOM 的文件整份被当正文，子代理缺 name 直接加载失败。
// INV-02 首行必须 trim 后完全等于 ---，不能用前缀判断代替；守住位置：lines[0] 的相等校验；改错故障：以 ---abc 开头的正文被误切，开头几行被吞进 frontmatter。
// INV-03 结束分隔符必须满足索引大于 0；守住位置：findIndex 的索引条件；改错故障：首行被同时当成开头与结尾，frontmatter 恒为空。
// INV-04 没有闭合分隔符时必须整体降级为 body；守住位置：endIndex 小于 0 的分支；改错故障：文档被切掉开头，systemPrompt 缺段且无人知晓。
// INV-05 body 必须从结束分隔符下一行开始，不得包含分隔行；守住位置：两处 slice 的边界参数；改错故障：正文顶部多出 ---，systemPrompt 带脏数据。
// INV-06 tools 空值必须整体删除而不是留空数组；守住位置：parseAgentFrontmatter 的 delete 分支；改错故障：上层把空数组读成禁用全部工具，子代理无工具可用。
// INV-07 mcpServers 的 undefined、null、数组三种语义不得混用；守住位置：parseMcpServerNames 的返回约定；改错故障：非法配置被当未配置，子代理拿到错误 MCP 范围。
// INV-08 未配置 mcpServers 必须返回 undefined；守住位置：isConfigured 的早退分支；改错故障：空数组被读成不继承父级服务器，工具链断裂。
// INV-09 冒号后留空的键必须先记空数组并登记为 bareValue；守住位置：rawValue 去空白后为空的赋值处；改错故障：mcpServers 留空被当合法空列表，继承静默丢失。
// INV-10 空值列表一旦补到真实项就必须从 bareValueKeys 移除；守住位置：listMatch 分支的 delete 调用；改错故障：合法列表仍被判非法，mcpServers 恒为 null。
// INV-11 列表项后的缩进续行必须标记为非法嵌套，不能当名字列表吞掉；守住位置：pendingListKey 与缩进正则的联合分支；改错故障：块状 mapping 被读成空列表，child MCP scope 被放大。
// INV-12 跨行游标 pendingListKey 必须在每个非列表行前清空；守住位置：键值匹配之前的重置；改错故障：上一个键的空数组吞掉下一个键的标量值。
// INV-13 键名只接受字母开头的字母数字下划线连字符；守住位置：keyValue 的匹配正则；改错故障：含点或中文的键被错误收录，values 出现上层无法识别的字段。
// INV-14 无法匹配键值的行必须静默跳过而不是中断解析；守住位置：keyValue 匹配失败的 continue；改错故障：一行语法错误让整份 frontmatter 丢失。
// INV-15 标量布尔只认小写 true 与 false；守住位置：parseScalarValue 前两个等值判断；改错故障：True 留在字符串分支，布尔字段被上层判为无效。
// INV-16 花括号值解析失败必须回退原字符串；守住位置：JSON.parse 的 catch 分支；改错故障：一行坏 JSON 让整份 agent 配置加载失败。
// INV-17 行内注释只在引号外且前一字符为空白时截断；守住位置：stripInlineComment 的井号判断；改错故障：URL 里的井号被当注释，地址被截断成半个。
// INV-18 顶层切分必须同时跟踪引号与花括号方括号圆括号深度；守住位置：splitTopLevelList 的循环体；改错故障：含逗号的对象或签名被拆成多项，工具名错乱。
// 阅读顺序：先看 splitMarkdownFrontmatter 的三处边界判定，再看 parseLooseFrontmatter 的行状态机，
// 最后看 parseScalarValue 的类型收敛链；本层没有日志与异常，失败统一收敛成空结果或原字符串。
//
export function splitMarkdownFrontmatter(content: string): {
  body: string;
  frontmatter?: string;
} {
  // [契约] 只切分不改写：body 与 frontmatter 都不含分隔行，也不做 trim。
  // [边界] 必须先剥 BOM 再判断分隔符：记事本另存的 UTF-8 文件首字符常是 U+FEFF。
  // [失败路径] 不剥则首行不以 --- 开头，整份 frontmatter 被当正文，子代理缺 name 报错。
  const normalized = content.replace(/^\uFEFF/u, "");
  if (!normalized.startsWith("---")) {
    return { body: normalized };
  }

  // [边界] 同时容忍 CRLF 与 LF：正则覆盖 Windows 与 Unix 两种换行。
  // [并发] 纯字符串处理，无共享状态，多份 markdown 可并行解析。
  const lines = normalized.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") return { body: normalized };
  // [边界] 索引大于 0 是硬条件，否则首行分隔符会同时被当成开头与结尾。
  // [失败路径] 返回 -1 表示没有闭合分隔符，此时整体降级为正文，不切半份配置。
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex < 0) return { body: normalized };

  return {
    frontmatter: lines.slice(1, endIndex).join("\n"),
    body: lines.slice(endIndex + 1).join("\n"),
  };
}

export interface ParsedAgentFrontmatter {
  mcpServers: string[] | null | undefined;
  values: Record<string, unknown>;
}

// [契约] 入参是已剥掉分隔行的中间段文本，本函数不再识别 --- 行。
// values 保留全部键（含未知键），本层不过滤，是否取用由上层决定。
export function parseAgentFrontmatter(frontmatter: string): ParsedAgentFrontmatter {
  const { bareValueKeys, invalidNestedListKeys, values } = parseLooseFrontmatter(frontmatter);
  // [权衡] tools 出现空值即整体删除：上层把空数组读成禁用全部工具，比缺省更危险。
  // [失败路径] 只删 tools 不动其它键，避免一次容错连带清掉 mcpServers 等正文配置。
  if (bareValueKeys.has("tools")) {
    delete values.tools;
  }
  return {
    // [事务] 四个入参来自同一份解析结果，必须一起判断，缺一个都会让非法配置蒙混过关。
    // [失败路径] 名字列表非法返回 null，上层据此产出 agent_invalid_mcp_servers 诊断。
    mcpServers: parseMcpServerNames(
      values.mcpServers,
      Object.prototype.hasOwnProperty.call(values, "mcpServers"),
      bareValueKeys.has("mcpServers"),
      invalidNestedListKeys.has("mcpServers"),
    ),
    values,
  };
}

// [并发] 全部状态都在函数内新建：两个 Set 与一个普通对象，不使用模块级缓存。
// 同一份 frontmatter 可被重复解析，结果互不影响，也不会残留上一次的游标。
function parseLooseFrontmatter(frontmatter: string): {
  bareValueKeys: Set<string>;
  invalidNestedListKeys: Set<string>;
  values: Record<string, unknown>;
} {
  const bareValueKeys = new Set<string>();
  const invalidNestedListKeys = new Set<string>();
  const values: Record<string, unknown> = {};
  const lines = frontmatter.split(/\r?\n/u);
  // [边界] 它是行状态机唯一的跨行游标：只有空值键才会把它指向后续的 - 项。
  // 任何非列表行都会先清空它，防止上一个键的空数组吞掉下一个键的标量值。
  let pendingListKey: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    // [边界] 列表项只在存在待续键时才被吸收，孤立的 - 行被忽略而不是报错。
    // mcpServers 下出现未加引号的 mapping 会被标记为嵌套结构。
    // [权衡] 先移除 bareValue 标记再追加：一旦补到真实项，就不再按空值处理。
    const listMatch = line.match(/^\s*-\s+(.*)$/u);
    if (listMatch && pendingListKey) {
      bareValueKeys.delete(pendingListKey);
      const rawListItem = listMatch[1] ?? "";
      if (pendingListKey === "mcpServers" && isUnquotedMappingValue(rawListItem)) {
        invalidNestedListKeys.add(pendingListKey);
      }
      const existing = Array.isArray(values[pendingListKey])
        ? (values[pendingListKey] as unknown[])
        : [];
      values[pendingListKey] = [
        ...existing,
        pendingListKey === "mcpServers"
          ? parseMcpServerListItem(rawListItem)
          : parseScalarValue(rawListItem),
      ];
      continue;
    }

    // [失败路径] 缩进续行说明这是块状 mapping，不是名字列表，必须标记为非法。
    // 否则空数组兜底会把它读成空列表，child MCP scope 反而被放大。
    if (pendingListKey && /^\s+/u.test(rawLine)) {
      // 块状 mapping 不是 server-name 列表，不能被空数组吞掉后扩大 child MCP scope。
      invalidNestedListKeys.add(pendingListKey);
      pendingListKey = undefined;
      continue;
    }

    pendingListKey = undefined;
    // [边界] 键名只认字母开头的字母数字下划线连字符，带点或中文的键一律跳过。
    // [失败路径] 匹配失败直接 continue，不让一行语法错误中断整份配置的解析。
    const keyValue = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/u);
    if (!keyValue) continue;
    const key = keyValue[1]!;
    const rawValue = keyValue[2] ?? "";
    // [边界] 冒号后为空视为待续列表，先记空数组并登记为 bareValue。
    // [失败路径] 后续没有 - 项补上时，这个空数组会在上层被识别为非法或空值。
    if (rawValue.trim() === "") {
      values[key] = [];
      bareValueKeys.add(key);
      pendingListKey = key;
      continue;
    }
    if (key === "mcpServers" && hasUnquotedInlineMappingItem(rawValue)) {
      invalidNestedListKeys.add(key);
    }
    values[key] = parseScalarValue(rawValue, key === "mcpServers");
  }

  return { bareValueKeys, invalidNestedListKeys, values };
}

// [契约] 三种返回值严格区分：undefined 未配置、null 配置非法、数组为合法名字列表。
// [失败路径] 非数组、空值列表、嵌套 mapping、任一项非字符串或空串，全部返回 null。
// [资源] 名字逐个 trim 后重建新数组，不复用入参，避免上层改写污染解析结果。
function parseMcpServerNames(
  value: unknown,
  isConfigured: boolean,
  hasBareValue: boolean,
  hasInvalidNestedValue: boolean,
): string[] | null | undefined {
  if (!isConfigured) return undefined;
  if (!Array.isArray(value) || hasBareValue || hasInvalidNestedValue) return null;

  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const name = item.trim();
    if (name.length === 0) return null;
    names.push(name);
  }
  return names;
}

function hasUnquotedInlineMappingItem(rawValue: string): boolean {
  const value = stripInlineComment(rawValue.trim());
  if (!value.startsWith("[") || !value.endsWith("]")) return false;
  return splitTopLevelList(value.slice(1, -1), true).some(isUnquotedMappingValue);
}

function isUnquotedMappingValue(rawValue: string): boolean {
  const value = stripInlineComment(rawValue.trim());
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return false;
  }
  return (value.startsWith("{") && value.endsWith("}")) || /^[^:]+:(?:\s|$)/u.test(value);
}

function parseMcpServerListItem(rawValue: string): unknown {
  const value = stripInlineComment(rawValue.trim());
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return unquoteScalar(value);
  }
  if (value.startsWith("[") && value.endsWith("]")) return null;
  if (/^(?:null|~)$/iu.test(value)) return null;
  if (/^(?:true|false)$/iu.test(value)) return value.toLowerCase() === "true";
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value)) {
    return Number(value);
  }
  return value;
}

// [契约] 类型收敛顺序固定：布尔、整数、方括号列表、花括号 JSON、去引号字符串。
// [失败路径] JSON 解析失败时回退原字符串，不抛异常，坏配置只丢一个字段。
// [边界] 布尔与整数只认完全匹配，true1 或 12abc 这类值一律留在字符串分支。
function parseScalarValue(rawValue: string, parseInlineItemScalars = false): unknown {
  const value = stripInlineComment(rawValue.trim());
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/u.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitTopLevelList(
      value.slice(1, -1),
      parseInlineItemScalars,
      parseInlineItemScalars,
    ).map((item) =>
      parseInlineItemScalars
        ? parseMcpServerListItem(item)
        : unquoteScalar(stripInlineComment(item.trim())),
    );
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return unquoteScalar(value);
}

// [边界] 只有引号外的井号且前一字符是空白时才截断，URL 里的井号必须保留。
// [失败路径] 转义引号用前一字符是否为反斜杠近似判断，不做完整的转义解析。
function stripInlineComment(value: string): string {
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && value[index - 1] !== "\\") {
      quote = quote === char ? undefined : (quote ?? char);
    }
    if (!quote && char === "#" && /\s/u.test(value[index - 1] ?? "")) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value;
}

function unquoteScalar(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

// [边界] 引号内与括号内的逗号不切分，保证 mcp 参数里的 JSON 片段不被拆散。
// [权衡] 深度用增量加减而非栈，遇到不平衡输入时夹到 0，避免负数越界。
function splitTopLevelList(
  value: string,
  trackContainerDepth = false,
  preserveEmptyItems = false,
): string[] {
  const items: string[] = [];
  let current = "";
  let quote: string | undefined;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (const char of value) {
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      current += char;
      continue;
    }
    if (quote === char) {
      quote = undefined;
      current += char;
      continue;
    }
    if (!quote && char === "(") parenDepth += 1;
    if (!quote && char === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (!quote && trackContainerDepth && char === "{") braceDepth += 1;
    if (!quote && trackContainerDepth && char === "}") braceDepth = Math.max(0, braceDepth - 1);
    if (!quote && trackContainerDepth && char === "[") bracketDepth += 1;
    if (!quote && trackContainerDepth && char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    if (!quote && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 && char === ",") {
      if (current.trim() || preserveEmptyItems) items.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}
