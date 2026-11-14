// Subagent Markdown 的读写边界：解析 frontmatter 生成 AgentSummary，以及把配置写回 Markdown。
// 前提是 runtime 与 GUI 共享同一份 .md，任何解析偏差都会让同一个 agent 在 CLI 可用
// 而在设置页消失，所以此处刻意比严格 YAML 更宽松。
//
// INV-01：无 frontmatter 或缺少 name/description 时返回 diagnostic 而不抛错（位置：
//   parseSubagentMarkdown 的前三个返回分支）。破坏后果：一个手写错误的 md 会中断
//   整批扫描，其他正常 agent 也加载不出来。
// INV-02：loose 解析覆盖严格 YAML 结果（位置：parseRuntimeCompatibleFrontmatter 的展开顺序）。
//   破坏后果：runtime 已认的简写（注释、未加引号、括号内逗号）会在 GUI 侧消失，
//   于是保存一次就把 runtime 的语义改写成另一种配置。
// INV-03：行内标量写出后必须能被本文件读回（位置：formatYamlScalar 与 isSafePlainYamlScalar）。
//   破坏后果：like * 或含冒号空格的工具模式被当作 alias/map，保存后文件不可解析。
// INV-04：readOnly 只对 built-in 为 true（位置：parseSubagentMarkdown 的 readOnly 字段）。
//   破坏后果：workspace agent 不可编辑，还会被分组兜底逻辑误显示为内置。
// INV-05：序列化保留 mcpServers 的对象结构（位置：appendUnknownList 的 YAML 分支）。
//   破坏后果：用户只改描述并保存，MCP 配置被静默清空。
// INV-06：正文不参与任何字段推断（位置：splitMarkdownFrontmatter 的返回值）。
//   破坏后果：正文里的 key: value 会污染 frontmatter，保存后被物化成真实配置。
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  createAgentStateId,
  parseSubagentMarkdownSelection,
  formatSubagentMarkdownModel,
  type AgentColor,
  type AgentDiagnostic,
  type AgentPermissionMode,
  type AgentScope,
  type AgentSummary,
  type SubAgentConfig,
} from "@zcode/shared";

// 颜色是枚举而非自由字符串：下游按值取主题 token，未知值会让标签渲染成透明。
// 用 Set 而非数组做校验，是因为这里只关心成员判断，顺序没有意义。
const VALID_COLORS = new Set<AgentColor>([
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
]);

// 权限模式同样是闭集；新增模式必须同时出现在这里与 runtime 的解析中，
// 否则用户在 md 里写新模式时会被静默降级为 default，风险被低估。
const VALID_PERMISSION_MODES = new Set<AgentPermissionMode>([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
]);

// 输入带 path 与 scope：path 只用于诊断与回写定位，scope 决定 id 前缀与只读性。
// 两者都无法从 content 推出，必须由调用方给出，否则内置与用户 agent 会互相覆盖。
// [权衡] 不在这里读取文件：解析保持纯函数，便于对内容做批量重放与测试。
export interface ParseSubagentMarkdownInput {
  content: string;
  path: string;
  scope: AgentScope;
}

export interface ParseSubagentMarkdownResult {
  agent?: AgentSummary;
  diagnostic?: AgentDiagnostic;
}

// 解析入口：所有失败都收敛成 diagnostic，调用方据此跳过该文件而非中断整批扫描。
// frontmatter 缺失时不做整篇当正文的兜底：没有元数据的 md 是文档而不是 agent，
// 静默接受会把它塞进列表，用户看到一堆无描述条目却不知道来源。
// name 与 description 缺任一即判失败，其余字段全部可选，解析不出就丢弃。
// 条件展开避免了显式 undefined 键，也避免污染下游的 isEmpty 判空。
// [失败路径] 每个返回分支只带一个 diagnostic，不抛异常，也不返回半成品 agent。
// [权衡] 不在此处做字段纠错（例如自动补 name），错误必须让用户可见。
export function parseSubagentMarkdown(
  input: ParseSubagentMarkdownInput,
): ParseSubagentMarkdownResult {
  // 第一步只做切分，不解析字段：splitMarkdownFrontmatter 失败时会把整篇当 body，
  // 这里立刻检查 frontmatter 是否存在，避免把纯文档 md 当成 agent。
  const parsed = splitMarkdownFrontmatter(input.content);
  // 没有 frontmatter 时返回 diagnostic 而不是空 agent：调用方按 agent 是否存在决定是否展示，
  // 返回空对象会让列表出现一条无名字的幽灵项。
  if (!parsed.frontmatter) {
    return {
      diagnostic: {
        code: "agent_missing_frontmatter",
        message: `Agent Markdown must include frontmatter: ${input.path}`,
        path: input.path,
      },
    };
  }

  // runtime 使用 loose frontmatter 语义；Settings 也按同一语义读取，
  // 避免 CLI 已加载的 profile 因为不是严格 YAML 而在 GUI 中消失。
  // 解析结果只在这一处产出，后面所有字段都从它取值：
  // 分散解析会让 loose 层与 yaml 层的优先级在不同字段上不一致。
  const frontmatter = parseRuntimeCompatibleFrontmatter(parsed.frontmatter);

  // scalarString 同时做 trim 与「非空字符串」判定：YAML 把数字 name 解析成 number 时会被丢弃，
  // 这比 String() 强转安全，因为 "123" 与 123 在展示上并不等价。
  const name = scalarString(frontmatter.name);
  const description = scalarString(frontmatter.description)?.replace(/\\n/gu, "\n");
  // 顺序有意义：先 name 后 description，诊断信息才能稳定指向第一个缺失字段。
  if (!name) {
    return missingRequiredDiagnostic("name", input.path);
  }
  // description 缺失单独判一次：它在列表卡片里是唯一的说明来源，
  // 空描述的 agent 用户无法区分用途，宁可让它显示为损坏文件。
  if (!description) {
    return missingRequiredDiagnostic("description", input.path);
  }

  // source 只区分内置与用户：插件 agent 不走本解析器，由 discoverPluginAgents 产出，
  // 因此 source 只有 built-in 与 user 两个值，不要为将来预留占位值。
  // 后面的枚举与数值字段都经过 normalize：非法值一律丢弃而不是带上默认值，
  const source = input.scope === "built-in" ? "built-in" : "user";
  const modelSelection = parseSubagentMarkdownSelection(frontmatter);
  // 枚举非法值返回 undefined 而不是回退到第一个颜色：颜色是展示属性，
  // 猜错会让两个不同 agent 看起来一样，丢掉比猜更安全。
  const color = normalizeEnum(frontmatter.color, VALID_COLORS);
  const permissionMode = normalizeEnum(frontmatter.permissionMode, VALID_PERMISSION_MODES);
  // maxTurns 只接受正整数：负数或小数会让 runtime 的循环判定失效，
  // 截断成 0 又等于禁用该 agent，两种结果都比丢弃更糟。
  const maxTurns = normalizePositiveInteger(frontmatter.maxTurns);
  // tools 与 disallowedTools 用同一个解析器：两者写法约定一致，
  // 分开实现时 mcp 括号参数容易出现一边支持一边不支持的情况。
  const tools = parseToolSpecList(frontmatter.tools);
  const disallowedTools = parseToolSpecList(frontmatter.disallowedTools);
  const skills = parseStringList(frontmatter.skills);
  const background = parseOptionalBoolean(frontmatter.background);
  const injectAgentsMd = parseOptionalBoolean(frontmatter.injectAgentsMd);
  // mcpServers 必须是数组才接收：YAML 里写成映射是常见手误，
  // 放行后序列化会把它写回成另一种结构，用户配置被静默改写。
  const mcpServers = Array.isArray(frontmatter.mcpServers) ? frontmatter.mcpServers : undefined;

  return {
    // 可选字段一律用条件展开：显式写 undefined 会让序列化结果仍带该键，
    // 下游的 hasOwnProperty 判断与 schema 校验都会被误导。
    // id 由 name+scope+source 派生，保证同一 agent 在不同机器上稳定，避免列表键漂移。
    // systemPrompt 取 body 的 trim 结果：首尾空行属于排版，不属于指令内容。
    agent: {
      id: createAgentStateId({ name, scope: input.scope, source }),
      name,
      description,
      // body 的 trim 只去首尾空白：正文内部行距是用户排版，
      // 统一重排会让每次保存都产生大面积 diff。
      systemPrompt: parsed.body.trim(),
      // 条件展开每个可选字段：显式写 color: undefined 会让序列化结果带上该键，
      // 跨进程 IPC 的结构校验会因此把 agent 判成损坏。
      ...(color ? { color } : {}),
      ...(modelSelection ? { modelSelection } : {}),
      ...(tools ? { tools } : {}),
      ...(disallowedTools ? { disallowedTools } : {}),
      ...(skills ? { skills } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(maxTurns ? { maxTurns } : {}),
      ...(background !== undefined ? { background } : {}),
      ...(injectAgentsMd !== undefined ? { injectAgentsMd } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      path: input.path,
      scope: input.scope,
      source,
      // enabled 恒为 true：md 存在即代表启用，禁用状态由独立的 UI 状态维护，
      // 写进 frontmatter 会与 runtime 的文件发现逻辑冲突。
      enabled: true,
      // workspace scope 曾一并标为只读，导致 .zcode/agents 下的 profile 在设置页
      // 既不能编辑/删除，又因 groupAgentsByScope 的兜底分支被显示在“内置”分组里。
      // 只有内置 agent 是真正不可编辑的；插件 agent 由 discoverPluginAgents 显式覆盖为只读。
      // 见 INV-04：workspace agent 必须可编辑；插件 agent 的只读性在发现阶段单独设置。
      readOnly: input.scope === "built-in",
    },
  };
}

// 序列化入口：输出必须能被本文件解析器读回（INV-03）。
// 顶层标量统一加双引号：description 里常含冒号与井号，裸写会被拆成映射或注释。
// 列表用块状（key 换行加缩进横线）而不是行内数组，便于手工编辑与 diff。
// [权衡] 不保留未识别字段的书写顺序：只保证语义等价，
// 因为本函数由 GUI 全量重写，保留顺序需要额外维护原文映射，收益只是更小的 diff。
export function serializeSubagentMarkdown(config: SubAgentConfig): string {
  // 先拼行再一次性组装，而不是边拼边做模板替换：模板里一旦出现用户内容，
  // 反引号与插值符号都会被求值，行数组从结构上避免了这类注入。
  // 前两行固定是 name 与 description：解析侧把它们当必填项，
  // 顺序变化不影响读取，但能让人工 diff 稳定在同一位置。
  const frontmatterLines: string[] = [
    `name: "${escapeYamlString(config.name)}"`,
    `description: "${escapeYamlString(config.description)}"`,
  ];
  // appendScalar 对 undefined 与空串直接跳过：写出 color: 空值会被解析成空标量，
  // 再读回时 normalizeEnum 丢弃它，造成「保存一次字段消失」的往返不一致。
  appendScalar(frontmatterLines, "color", config.color);
  if (config.modelSelection) {
    appendScalar(frontmatterLines, "model", formatSubagentMarkdownModel(config.modelSelection));
    // thoughtLevel 与 model 成对写出：只有 model 没有档位时 runtime 会用默认档，
    // 缺这一行会让用户选的高推理档位在保存后丢失。
    appendScalar(frontmatterLines, "thoughtLevel", config.modelSelection.options?.reasoningLevel);
  }
  appendList(frontmatterLines, "tools", config.tools);
  appendList(frontmatterLines, "disallowedTools", config.disallowedTools);
  appendList(frontmatterLines, "skills", config.skills);
  appendScalar(frontmatterLines, "permissionMode", config.permissionMode);
  // maxTurns 用 !== undefined 判断：0 与 undefined 语义不同，真值判断会静默丢掉显式值。
  if (config.maxTurns !== undefined) {
    frontmatterLines.push(`maxTurns: ${config.maxTurns}`);
  }
  if (config.background !== undefined) {
    frontmatterLines.push(`background: ${config.background ? "true" : "false"}`);
  }
  if (config.injectAgentsMd !== undefined) {
    frontmatterLines.push(`injectAgentsMd: ${config.injectAgentsMd ? "true" : "false"}`);
  }
  // mcpServers 走 appendUnknownList 而不是 appendList：它的元素可能是对象，
  // 按字符串列表写会让 YAML 输出 [object Object]。
  appendUnknownList(frontmatterLines, "mcpServers", config.mcpServers);

  // 结束标记后必须恰好一个换行：parser 会对 body 做 trim，多一空行无影响，
  // 但少换行会让最后一段正文与标记粘连，下次解析时 frontmatter 定位失败。
  return `---\n${frontmatterLines.join("\n")}\n---\n${formatBody(config.systemPrompt)}`;
}

// 只认首行的 --- 作为 frontmatter 起点：允许 BOM 与 CRLF，因为 Windows 编辑器与
// git autocrlf 会改写行尾，按原始字节匹配会让同一文件在不同机器上解析结果不同。
// 结束标记必须整行就是 ---，正文里单独一行的 --- 是 Markdown 分隔线而不是结束符，
// 所以这里要求 trim 后严格相等，而不是 includes。
// 找不到结束标记时整体当正文返回，不留半截 frontmatter，
// 避免后续松散解析读到残缺键值并生成看似正常实则丢字段的 agent。
function splitMarkdownFrontmatter(content: string): { body: string; frontmatter?: string } {
  const normalized = content.replace(/^\uFEFF/u, "").replace(/\r\n/g, "\n");
  // 首字符不是 --- 就把整篇当 body，因为 agent 文件约定第一行就是标记，
  // 放宽到「任意位置」会把正文里的 YAML 示例误认成配置。
  if (!normalized.startsWith("---")) {
    return { body: normalized };
  }

  // 按换行符切分前已归一 CRLF：这一步之后每行都不带 CR，trim 比较才有意义。
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { body: normalized };
  }
  // index > 0 排除首行的起始标记，否则空 frontmatter 会被解析成起点即终点，
  // 起始标记重复出现时，紧随其后的正文会被整体吞掉，agent 丢失全部指令。
  // [失败路径] 返回 -1 时走无 frontmatter 分支，由上层给出诊断。
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex < 0) {
    return { body: normalized };
  }

  return {
    frontmatter: lines.slice(1, endIndex).join("\n"),
    // body 从结束标记下一行开始：把结束标记留在正文里会让 Markdown 渲染出多余横线。
    body: lines.slice(endIndex + 1).join("\n"),
  };
}

// 两层解析：严格 YAML 提供类型与嵌套，loose 解析补回 runtime 容忍的简写。
// 合并顺序是 yaml 在前、loose 在后（INV-02）：loose 只认识标量与简单列表，
// 让它覆盖同名键等于把复杂结构降级，因此 mcpServers 在最后单独从 yaml 补回。
// [权衡] 不判断哪一层更正确：runtime 是唯一事实来源，GUI 跟随它的容忍度。
function parseRuntimeCompatibleFrontmatter(frontmatter: string): Record<string, unknown> {
  // loose 先跑完再跑 yaml：两者独立，合并顺序在 return 里统一决定，
  // 这样 loose 解析失败也不会阻止 yaml 提供嵌套结构。
  const looseValues = parseLooseFrontmatter(frontmatter);
  let yamlValues: Record<string, unknown> = {};
  try {
    // parseYaml 的结果是 unknown：手写 md 可能解析出字符串或数组，
    // 只有 isObjectRecord 为真时才当作键值集合，其余一律按空配置处理。
    const rawFrontmatter = parseYaml(frontmatter) as unknown;
    // 非对象结果按空配置处理：parseYaml 对空文本返回 null，
    // 直接展开 null 会抛 TypeError 并中断整批扫描。
    yamlValues = isObjectRecord(rawFrontmatter) ? rawFrontmatter : {};
  } catch {
    yamlValues = {};
  }

  return {
    ...yamlValues,
    ...looseValues,
    // mcpServers 最后从 yaml 补回：loose 层不认识嵌套对象，
    // 若让它覆盖同名键，保存后 MCP 配置会被降级成字符串数组。
    ...(Array.isArray(yamlValues.mcpServers) ? { mcpServers: yamlValues.mcpServers } : {}),
  };
}

// 逐行扫描的 frontmatter 解析器支持 key: value 与块状列表，行内注释会被跳过。
// 它存在的理由是 runtime 的解析器接受这些写法，而严格 YAML 不接受；
// GUI 必须与 runtime 看到同一份配置，否则保存一次就会改变语义。
// 值统一先按字符串处理，再由各字段的 normalize 决定类型：这里不猜布尔或数字，
// 避免把名字恰好是 true 的 agent 解读成布尔值而丢失。
// 空行与整行注释被跳过：它们是 YAML 用户的排版，不承载配置项。
// [失败路径] 不匹配键值格式的行直接忽略，不报错，保持与 runtime 一致的宽松。
function parseLooseFrontmatter(frontmatter: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const lines = frontmatter.split(/\r?\n/u);
  // pendingListKey 记住最近一个空值键：块状列表项本身没有 key，
  // 只能靠这个游标判断它属于哪个字段。
  let pendingListKey: string | undefined;

  for (const rawLine of lines) {
    // 只 trimEnd 不 trimStart：行首空白用来区分顶层键与嵌套内容，
    // 提前 trimStart 会让两种写法无法分辨。
    const line = rawLine.trimEnd();
    // 空行与整行注释跳过：它们是 YAML 用户的排版，不承载配置项。
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    // 列表项只归属于最近一个空值键：pendingListKey 在遇到新的 key: value 时清空，
    // 否则列表会串到上一个键名下，造成 tools 与 skills 互相污染。
    // 同一个键可能既有标量又有列表项，数组写法能兼容两种顺序。
    const listMatch = line.match(/^\s*-\s+(.*)$/u);
    // 列表项挂到 pendingListKey 名下并追加：同一个键允许出现多行列表，
    // 已有标量值会被数组替换，这是「后者胜」的既有约定。
    if (listMatch && pendingListKey) {
      const existing = Array.isArray(values[pendingListKey])
        ? (values[pendingListKey] as unknown[])
        : [];
      values[pendingListKey] = [...existing, parseScalarValue(listMatch[1] ?? "")];
      continue;
    }

    // 遇到新键先清空列表游标：不清会让后续零散列表项挂到上一个键，
    // 表现为 tools 列表里混进 skills 的值。
    pendingListKey = undefined;
    const keyValue = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/u);
    // 不是 key: value 形状的行直接跳过：用户可能插入说明文字，
    // 把它们当成键会把备注写回成真实配置。
    if (!keyValue) continue;
    const key = keyValue[1]!;
    const rawValue = keyValue[2] ?? "";
    if (rawValue.trim() === "") {
      // 空值键先占位空数组并登记 pendingListKey：没有列表项时它也保留空数组，
      // 序列化阶段 appendList 会因为 length 为 0 跳过该键，等价于未配置。
      values[key] = [];
      pendingListKey = key;
      continue;
    }
    // 值统一交给 parseScalarValue：标量类型推断集中在一处，新增类型只改那个函数。
    values[key] = parseScalarValue(rawValue);
  }

  return values;
}

// 标量推断顺序：布尔 → 整数 → 行内列表 → 行内映射 → 去引号字符串。
// 只识别小写 true/false 与纯数字，不做宽松布尔解析，因为 yes/on 在 agent 名字里更常见。
// 误判会把 agent 名字变成布尔类型，代价远大于一次显示偏差。
// 行内映射解析失败时保留原字符串，交给下游严格 schema 拒绝，
// 而不是让整个 agent 文件消失。
// [权衡] 不实现完整的 YAML 标量规则：loose 层的职责只是补齐 runtime 已接受的写法。
function parseScalarValue(rawValue: string): unknown {
  const value = stripInlineComment(rawValue.trim());
  if (value === "true") return true;
  if (value === "false") return false;
  // 只认纯数字串："1.5" 与 "0x10" 保留字符串，避免 maxTurns 这类整数字段被静默截断。
  if (/^\d+$/u.test(value)) return Number(value);
  // 行内列表按顶层逗号切分，因为工具模式里允许 mcp(x, y) 这类括号参数。
  // 直接 split 会把一个工具拆成两个，runtime 随后静默忽略不存在的名字。
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitTopLevelList(value.slice(1, -1)).map((item) =>
      unquoteScalar(stripInlineComment(item.trim())),
    );
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      // Runtime-compatible loose frontmatter 对非法 inline mapping 保留原字符串；
      // 下游严格 ModelSelection schema 会拒绝它，而不是让整个 agent 文件消失。
      return value;
    }
  }
  return unquoteScalar(value);
}

// 只剥离引号外的 # 且要求 # 前是空白，否则 a#b 与 URL 片段会被截断。
// 无条件截断会把工具名或描述截掉一半。
// quote 状态用翻转维护并跳过反斜杠转义，避免把引号内的 # 当注释。
// [失败路径] 未闭合的引号会让整行都被当作引号内内容，宁可不剥离也不误删。
function stripInlineComment(value: string): string {
  // quote 用 undefined 表示不在引号内：空串会让 quote === char 在遇到空值时误判。
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && value[index - 1] !== "\\") {
      quote = quote === char ? undefined : (quote ?? char);
    }
    if (!quote && char === "#" && /\s/u.test(value[index - 1] ?? "")) {
      // 只在命中注释起点时截断并 trimEnd：注释前的空白属于分隔符，
      // 保留它会让工具名带尾随空格，后续匹配失败。
      return value.slice(0, index).trimEnd();
    }
  }
  return value;
}

// splitTopLevelList 同时跟踪引号与括号深度，供行内列表与工具模式共用边界规则。
// 括号深度用 Math.max 兜底：多余的右括号不应把深度压成负数，
// 否则后续真正的顶层逗号会被误判为嵌套内容而丢失整段配置。
// 空片段被丢弃，因此尾随逗号不会产生空项。
function splitTopLevelList(value: string): string[] {
  // items 只收非空片段：调用方拿到的一定是可直接写入 YAML 列表的字符串。
  const items: string[] = [];
  let current = "";
  let quote: string | undefined;
  // parenDepth 记录未闭合括号层数：工具模式 mcp(x, y) 里的逗号不是分隔符。
  let parenDepth = 0;
  for (const char of value) {
    // 进入 quote 后逗号与括号都不再计数：引号内的内容是工具参数，
    // 按结构切分会把一个参数拆成两项。
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      current += char;
      continue;
    }
    // 只有与开引号相同的字符才闭合：混用单双引号时不能互相终止。
    if (quote === char) {
      quote = undefined;
      current += char;
      continue;
    }
    // 括号只在引号外计数：引号内的 ( 是普通字符，计入会让深度永远回不到 0。
    if (!quote && char === "(") parenDepth += 1;
    if (!quote && char === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (!quote && parenDepth === 0 && char === ",") {
      // 空片段不 push：尾随逗号与连续逗号都会产生空串，
      // 保留它们会让 appendList 写出空的列表项。
      if (current.trim()) items.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function unquoteScalar(value: string): string {
  if (
    // startsWith 与 endsWith 成对判断首尾引号：只有一端带引号的串属于用户手误，
    // 强行切掉会让内容少一个字且无法察觉。
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    // slice(1, -1) 去掉引号但不还原转义："\n" 会以字面反斜杠保留，
    // 只有 description 字段会把它还原成换行。
    return value.slice(1, -1);
  }
  return value;
}

function missingRequiredDiagnostic(field: string, path: string): { diagnostic: AgentDiagnostic } {
  return {
    diagnostic: {
      // 错误码固定成同一个常量串：UI 按 code 分类展示，
      // 把缺失字段拼进 code 会让前端的匹配列表漏掉新字段。
      code: "agent_missing_required_frontmatter",
      // message 里带 field 与 path：批量扫描时用户需要知道哪个文件的哪个字段缺失，
      // 只写「缺少必填字段」无法定位。
      message: `Agent frontmatter must include ${field}: ${path}`,
      path,
    },
  };
}

function scalarString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeEnum<T extends string>(value: unknown, valid: Set<T>): T | undefined {
  // 非法枚举返回 undefined 而不是回退默认值：回退会让用户写错的字段在保存后静默变成另一个合法值，
  // 下次打开界面看不出差异，实际 runtime 行为已经改变。
  const raw = scalarString(value);
  return raw && valid.has(raw as T) ? (raw as T) : undefined;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  // 布尔直接返回：YAML 已把 true/false 解析成布尔，再走字符串分支会把它变成字符串。
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    // 字符串只在明确等于 true/false 时转布尔：yes 与 1 保持 undefined，
    // 宽松解析会把 on 这类词静默当成 true，用户改动后没有任何提示。
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  // Number.isInteger 挡掉小数与 NaN：maxTurns 是循环次数，小数会让计数永远差一点。
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    // 字符串形态的 "0" 经 Number 解析后仍判不大于 0，表示「一轮都不跑」而不是「未配置」。
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function parseStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return nonEmptyList(
      // 数组里混入非字符串项时直接丢弃：YAML 会把 1.0 解析成 number，
      // 强转会在列表里留下一个不存在的 skill 名。
      value.filter((item): item is string => typeof item === "string").map((item) => item.trim()),
    );
  }
  // 非数组非字符串直接返回 undefined：数字或布尔作为 skills 值没有可解释语义。
  if (typeof value !== "string") return undefined;
  return nonEmptyList(
    value
      .split(/[,\s]+/u)
      .map((item) => item.trim())
      // filter(Boolean) 去掉切分产生的空串：连续逗号会产生空项，
      // 保留它会让下游认为存在一个空名 skill。
      .filter(Boolean),
  );
}

// parseToolSpecList 支持数组与字符串两种来源，字符串又可能是逗号分隔或空白分隔。
// 切分时必须跟踪括号深度：mcp 工具的带参写法是一个整体，按逗号或空格切开
// 会得到两个不存在的工具名，而 runtime 对未知工具是静默忽略的，
// 表现为 runtime 里工具莫名不可用且没有任何报错。
// 结果经 nonEmptyList 归一：全空时返回 undefined 而不是空数组，便于序列化时跳过该键。
function parseToolSpecList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return nonEmptyList(
      value.filter((item): item is string => typeof item === "string").map((item) => item.trim()),
    );
  }
  if (typeof value !== "string") return undefined;

  // 手写扫描而不是 split：mcp 工具的括号参数里可能含逗号与空格，
  // 正则切分会把一个工具拆成多个不存在的名字。
  const result: string[] = [];
  let current = "";
  let parenDepth = 0;
  for (const char of value) {
    // 只统计小括号：工具模式约定用 mcp(a, b) 传参，方括号在这套语法里不会嵌套。
    if (char === "(") parenDepth += 1;
    if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (parenDepth === 0 && (char === "," || /\s/u.test(char))) {
      if (current.trim()) result.push(current.trim());
      current = "";
      continue;
    }
    // parenDepth 为 0 时逗号与空白都是分隔符：括号内的空白属于参数，
    // 提前切分会得到 mcp( 这种残缺项。
    current += char;
  }
  // 末尾片段单独收尾：循环里的 push 只处理分隔符前的部分，
  // 最后一个工具后面通常没有分隔符，current 需要单独收尾。
  if (current.trim()) result.push(current.trim());
  return nonEmptyList(result);
}

function nonEmptyList(values: string[]): string[] | undefined {
  const filtered = values.filter((item) => item.length > 0);
  return filtered.length > 0 ? filtered : undefined;
}

function appendScalar(lines: string[], key: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  lines.push(`${key}: ${formatYamlScalar(value)}`);
}

function appendList(lines: string[], key: string, values: readonly string[] | undefined): void {
  // 空列表不写键：写出 tools: 后跟零个列表项会被解析成 null，
  // 再读回时与「未配置」无法区分。
  if (!values || values.length === 0) return;
  lines.push(`${key}:`);
  for (const value of values) {
    // 两项缩进对应块状序列：YAML 要求列表项比父键更深，
    // 缩进错位会让解析器把它当成新的顶层键。
    lines.push(`  - ${formatYamlScalar(value)}`);
  }
}

// mcpServers 在 GUI 里没有结构化表单，但保存会重写整份 frontmatter；
// 对象数组若被当普通字符串列表写入会丢结构，因此退回 YAML 序列化（INV-05）。
// 只对纯字符串数组走 appendList，保证常见情况下输出格式稳定、可手改。
// lineWidth 设为 0 禁止折行：折行后的 YAML 仍是合法输入，但会让人工 diff 难以阅读。
function appendUnknownList(
  lines: string[],
  key: string,
  values: readonly unknown[] | undefined,
): void {
  if (!values || values.length === 0) return;
  // 纯字符串数组仍走 appendList：让常见情况的输出与手写格式一致，
  // 避免 stringifyYaml 给每项加引号造成无意义 diff。
  if (isStringArray(values)) {
    appendList(lines, key, values);
    return;
  }
  // GUI 当前还没有 mcpServers 的结构化表单，但保存会重写整个
  // frontmatter；对象数组必须按 YAML 结构写回，避免编辑其他字段时清空 MCP 配置。
  const serialized = stringifyYaml({ [key]: values }, { lineWidth: 0 }).trimEnd();
  lines.push(...serialized.split("\n"));
}

function isStringArray(values: readonly unknown[]): values is readonly string[] {
  return values.every((value) => typeof value === "string");
}

// 判定与转义必须成对演进：放宽 isSafePlainYamlScalar 时要同步确认 escapeYamlString
// 能处理新放行的字符，否则会出现写得进却读不回的往返破坏（INV-03）。
function formatYamlScalar(value: string): string {
  // `*` 和包含 `: ` 的工具 pattern 在 YAML plain scalar 中会被当作
  // alias/map，必须 quote 后再写入，保证保存出的 Markdown 可被 parser 重新读取。
  if (isSafePlainYamlScalar(value)) {
    return value;
  }
  // 加双引号后统一走 escapeYamlString：引号内的反斜杠与换行都要转义，
  // 否则值里的双引号会提前闭合字符串。
  return `"${escapeYamlString(value)}"`;
}

// isSafePlainYamlScalar 是白名单式放行：只允许字母数字与少量安全符号，其余加引号。
// 首字符单独排除 YAML 指示符，避免 plain scalar 被当成序列项或键。
// 正则末尾允许空格与括号是为了 mcp 工具模式，首字符仍然不允许空白。
// 否则首尾空白会让 YAML 把值 trim 掉，与写入内容不再相等。
function isSafePlainYamlScalar(value: string): boolean {
  // 首尾空白一律加引号：plain scalar 会被 YAML 自动 trim，写回的值与内存中的不再相等。
  if (value.length === 0 || value.trim() !== value) return false;
  if (/^(?:false|null|true|~)$/iu.test(value)) return false;
  // 纯数字形态必须加引号："1.0" 不加引号会被读成 number，
  // 工具名或模型名里的数字串因此被读成 number 类型。
  if (/^[-+]?(?:\d+|\d*\.\d+)(?:e[-+]?\d+)?$/iu.test(value)) return false;
  if (/^[*?:,[\]{}&!|>'"%@`-]/u.test(value)) return false;
  if (value.includes("#") || /:\s/u.test(value)) return false;
  return /^[A-Za-z0-9_./@*][A-Za-z0-9_./@*\s()-]*$/u.test(value);
}

// 反斜杠必须先替换，否则后续为引号添加的转义会被二次转义；
// 换行写成字面 \n 转义，与 parseSubagentMarkdown 对 description 的还原约定配对。
function escapeYamlString(value: string): string {
  // 先替换反斜杠再替换引号：反过来的话，为引号新增的反斜杠会被二次转义。
  // 换行与回车写成字面转义：YAML 双引号标量里出现裸换行会直接解析失败。
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

// 正文前后各留一个换行，保证 --- 与正文之间恰好一个空行，重写后 diff 稳定。
function formatBody(systemPrompt: string): string {
  const body = systemPrompt.trim();
  return body.length > 0 ? `\n${body}\n` : "\n";
}

// 数组与 null 都不算配置对象：readNestedString 依赖这个判定阻止下标访问命中数组。
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
