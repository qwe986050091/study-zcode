// INV-01 守住位置：本文件只导出 parseAgentProfileFromMarkdown，解析策略全部内聚在私有辅助函数中；改错故障：新增第二个导出会让调用方出现两套入口与两套校验，字段语义必然漂移。
// INV-02 守住位置：失败一律以 diagnostic 返回而不抛异常，profile 只在字段齐备后组装；改错故障：改成 throw 会让批量加载因单个坏文件中断整轮扫描。
// INV-03 守住位置：缺失 frontmatter 使用独立错误码 agent_missing_frontmatter；改错故障：并入字段缺失错误后，用户分不清是没写头部还是漏了 name。
// INV-04 守住位置：name 与 description 是硬性必填，缺任一项立即返回 agent_missing_required_frontmatter；改错故障：放宽为可选会产生无法被路由与展示的匿名 agent。
// INV-05 守住位置：description 中字面量的反斜杠加 n 会还原成换行；改错故障：去掉还原会让多行描述在界面挤成一行并丢失原文的换行意图。
// INV-06 守住位置：source 为 project 时 permissionMode 一律被丢弃；改错故障：仓库内的 markdown 就能把子 agent 提升到 bypassPermissions，等于把执行权限交给被审查的代码。
// INV-07 守住位置：permissionMode 只接受 VALID_PERMISSION_MODES 内的值，非法值静默降级为未设置；改错故障：透传未知模式会让下游分支落空并采用隐式默认权限。
// INV-08 守住位置：color 只接受 VALID_COLORS 内的值，其余视为未设置；改错故障：透传任意字符串会污染界面主题映射并破坏展示回退。
// INV-09 守住位置：memory 非法时返回 agent_invalid_memory_scope 诊断，但 profile 仍然产出；改错故障：改成整体失败会让一个可纠正的提示变成硬阻断。
// INV-10 守住位置：mcpServers 为 null 时立即返回 agent_invalid_mcp_servers，为 undefined 时表示未声明；改错故障：两者混为一谈会让格式错误静默退化成不挂载父级 server。
// INV-11 守住位置：可选字段用条件展开写入，未设置时键根本不存在；改错故障：显式写入 undefined 会让精确可选类型检查失败，序列化结果也多出空键。
// INV-12 守住位置：profile.systemPrompt 取 frontmatter 之后的正文并 trim；改错故障：不 trim 会让每份提示词开头带空行，模型侧前缀匹配与缓存命中随之失效。
// INV-13 守住位置：maxTurns 只接受正整数，0、负数与非整数一律丢弃；改错故障：允许 0 会让回合预算立刻耗尽，任务在第一步就被终止。
// INV-14 守住位置：工具规格按括号深度切分，括号内的空格与逗号不作为分隔符；改错故障：按空白硬切会把带参数的工具拆成两个不存在的工具名。
// INV-15 守住位置：括号深度用 Math.max 夹在 0 以上；改错故障：多余的右括号会把深度压成负数，后续所有 token 再也无法切分。
// INV-16 守住位置：tools 的显式空数组保留为空列表，其余键的空值视为未设置；改错故障：把空数组当未设置会让禁止一切工具的白名单退化成默认全开。
// INV-17 守住位置：skills 走纯字符串列表归一化，tools 与 disallowedTools 走带括号感知的解析；改错故障：混用会把含空格的技能名截断成多个不存在的条目。
// INV-18 守住位置：工具名在第一个左括号处截断，只保留工具本体；改错故障：保留参数会让同一工具被识别成多个身份，权限匹配与统计都会失真。
//
// 模块职责：把 Markdown 文本与来源收敛成 AgentProfile 或诊断，不读文件、不直接解析 YAML 细节。
// 状态所有权：本模块无状态，白名单常量只读，返回的 profile 由调用方持有。
// 阅读顺序：先看 parseAgentProfileFromMarkdown 主流程，再看归一化辅助函数与括号感知切分。
import { parseAgentFrontmatter, splitMarkdownFrontmatter } from "./subagent-profile-frontmatter.js";
import { parseSubagentMarkdownSelection } from "./subagent-markdown-selection.js";
import type { AgentPermissionMode } from "./subagents-types.js";
import type {
  AgentProfile,
  AgentProfileSource,
  AgentMemoryScope,
  AgentProfileParseDiagnostic,
} from "./subagent-profile.js";

const VALID_COLORS = new Set<NonNullable<AgentProfile["color"]>>([
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
]);

const VALID_PERMISSION_MODES = new Set<AgentPermissionMode>([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
]);

const VALID_MEMORY_SCOPES = new Set<AgentMemoryScope>(["user", "project", "local"]);

// 对外只有这一个入口：输入 Markdown 文本、可选路径与来源，输出 profile 或 diagnostic 二者之一。
// 路径只用于诊断文案与 profile.path，不参与任何文件 IO，因此可以在内存里被批量调用。
// 没有 frontmatter、缺必填字段、mcpServers 结构错误都会走早返回，短路上后续所有归一化。
// 早返回的顺序即优先级：先判断整体结构，再判断必填字段，最后判断可选集合。
// 可选字段非法大多只降级为未设置而不报错，只有 memory 与 mcpServers 例外，这是刻意保留的可诊断性。
// 调用方必须按三种组合处理：仅有诊断、仅有 profile、以及 memory 诊断与 profile 并存。
export function parseAgentProfileFromMarkdown(input: {
  content: string;
  path?: string;
  source: AgentProfileSource;
}): { diagnostic?: AgentProfileParseDiagnostic; profile?: AgentProfile } {
  const parsed = splitMarkdownFrontmatter(input.content);
  // 没有 frontmatter 段时直接返回 agent_missing_frontmatter，不再做任何字段探测。
  // 诊断里的 path 允许缺省，文案用尖括号 inline 占位，保证内存输入的报错同样可读。
  // 此分支不产出 profile，调用方不能对返回值做兜底构造，否则会掩盖文件格式问题。
  // 诊断码是稳定契约，调用方按 code 分支处理，不要依赖 message 文案做判断。
  // 顺序上必须先于 parseAgentFrontmatter，否则会在空块上做无意义的键扫描。
  if (!parsed.frontmatter) {
    return {
      diagnostic: {
        code: "agent_missing_frontmatter",
        message: `Agent Markdown must include frontmatter: ${input.path ?? "<inline>"}`,
        path: input.path,
      },
    };
  }

  const { mcpServers, values: frontmatter } = parseAgentFrontmatter(parsed.frontmatter);
  const name = scalarString(frontmatter.name);
  const description = scalarString(frontmatter.description)?.replace(/\\n/gu, "\n");
  // name 与 description 缺一即返回，两条诊断共用 missingRequiredDiagnostic 以保证文案一致。
  // 二者都经过 scalarString，纯空白字符串等同于缺失。
  // description 只还原反斜杠 n 转义，其他转义保持原样，避免误改用户正文。
  // 此处不校验 name 的字符集与唯一性，这两项属于调用方注册阶段的职责。
  if (!name) {
    return missingRequiredDiagnostic("name", input.path);
  }
  if (!description) {
    return missingRequiredDiagnostic("description", input.path);
  }

  const modelSelection = parseSubagentMarkdownSelection(frontmatter);
  const color = normalizeColor(scalarString(frontmatter.color));
  const parsedPermissionMode = normalizePermissionMode(scalarString(frontmatter.permissionMode));
  // 修复原因：项目级 subagent markdown 属于仓库输入，不能通过 frontmatter 把
  // child runtime 提升到 bypass/yolo；权限模式只接受用户级或受信插件配置。
  // source 为 project 时 permissionMode 一律丢弃，这是权限边界的硬约束而非可选优化。
  // 理由是项目级 markdown 随仓库分发，属于被审查的输入，不能凭文本把子 agent 提到 bypassPermissions。
  // 只有用户级或受信插件来源可以写入权限模式，新增来源时必须先确认其可信度再放开。
  // 这里判断的是归一化后的结果，因此非法模式在 project 与用户级下都会被丢弃。
  // 若把条件反转或改成按模式值放行，仓库投毒即可获得无确认执行，属于安全回归。
  // 放宽此处等同于扩大信任面，必须与权限策略的所有者对齐，而不是只在解析层打补丁。
  const permissionMode = input.source === "project" ? undefined : parsedPermissionMode;
  const maxTurns = normalizePositiveInteger(frontmatter.maxTurns);
  const memory = parseAgentMemoryScope(frontmatter.memory);
  const memoryDiagnostic =
    frontmatter.memory !== undefined && memory === undefined
      ? {
          code: "agent_invalid_memory_scope",
          message: `Agent frontmatter memory must be user, project, or local: ${input.path ?? "<inline>"}`,
          path: input.path,
        }
      : undefined;
  // mcpServers 为 null 表示声明了但不是合法的父级 server 名字列表，直接报 agent_invalid_mcp_servers。
  // undefined 表示根本没写这个键，属于正常未声明，不能与 null 合并处理。
  // 该早返回发生在返回对象组装之前，因此错误输入不会留下半成品 profile。
  if (mcpServers === null) {
    return {
      diagnostic: {
        code: "agent_invalid_mcp_servers",
        message: `Agent frontmatter mcpServers must be a list of parent server names: ${input.path ?? "<inline>"}`,
        path: input.path,
      },
    };
  }

  return {
    // 可选字段全部通过条件展开写入，未设置时键不存在，而不是键存在且值为 undefined。
    // 这样既满足精确可选属性的类型约束，也让下游的对象比较与序列化结果保持稳定。
    // memory 诊断与 profile 可以同时返回：合法字段照常生效，非法 memory 只作为提示被丢弃。
    // profile 的字段集合是白名单，frontmatter 中未列出的键不会透传，避免脏数据流入运行时。
    // systemPrompt 取正文而非整份文件，frontmatter 段已在上游切走，重复切分只会引入偏移错误。
    // 只有 tools 的空数组保留为空列表语义，其余可选列表与布尔值在空值时整体省略。
    ...(memoryDiagnostic ? { diagnostic: memoryDiagnostic } : {}),
    profile: {
      name,
      description,
      source: input.source,
      systemPrompt: parsed.body.trim(),
      ...(input.path ? { path: input.path } : {}),
      ...(modelSelection ? { modelSelection } : {}),
      ...(color ? { color } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(maxTurns ? { maxTurns } : {}),
      ...(memory ? { memory } : {}),
      ...optionalList("tools", frontmatter.tools),
      ...optionalList("disallowedTools", frontmatter.disallowedTools),
      ...optionalList("skills", frontmatter.skills),
      ...optionalBoolean("background", frontmatter.background),
      ...optionalBoolean("injectAgentsMd", frontmatter.injectAgentsMd),
      ...(mcpServers === undefined ? {} : { mcpServers }),
    },
  };
}

function parseAgentMemoryScope(value: unknown): AgentMemoryScope | undefined {
  return typeof value === "string" && VALID_MEMORY_SCOPES.has(value as AgentMemoryScope)
    ? (value as AgentMemoryScope)
    : undefined;
}

function missingRequiredDiagnostic(
  field: string,
  path: string | undefined,
): { diagnostic: AgentProfileParseDiagnostic } {
  return {
    diagnostic: {
      code: "agent_missing_required_frontmatter",
      message: `Agent frontmatter must include ${field}: ${path ?? "<inline>"}`,
      path,
    },
  };
}

function parseToolList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return normalizeToolNames(normalizeStringList(value));
  }
  if (typeof value !== "string") return undefined;
  const result: string[] = [];
  let current = "";
  let parenDepth = 0;
  for (const char of value) {
    if (char === "(") parenDepth += 1;
    if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    // 工具规格可能带括号参数，括号内的空格与逗号必须视为工具名的一部分。
    // 分隔条件只在括号深度为 0 时成立，因此带括号参数的工具规格能整体保留。
    // 深度更新用 Math.max 夹到 0，单个多余的右括号不会把后续所有输入粘成一个 token。
    // 循环结束后还要补推一次 current，否则最后一个工具会被静默丢弃。
    // 字符串里的换行也按空白切分，因为单行字符串列表的换行等价于分隔符。
    if (parenDepth === 0 && (char === "," || /\s/u.test(char))) {
      if (current.trim()) result.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) result.push(current.trim());
  return normalizeToolNames(result);
}

function optionalList(
  key: "disallowedTools" | "skills" | "tools",
  value: unknown,
): Partial<AgentProfile> {
  // skills 是纯字符串列表，直接按逗号或空白切分即可，不需要括号感知。
  // tools 与 disallowedTools 走 parseToolList，因为它们的规格可能带括号参数。
  // 只有 tools 的显式空数组会保留为空列表，语义是禁止一切工具，而非未声明。
  // 其余键的空列表一律返回空对象，保持未设置语义，避免把空配置写成有效白名单。
  // 这个分支差异很容易被当成冗余代码删掉，删掉后默认工具集会被意外放开。
  const list = key === "skills" ? normalizeStringList(value) : parseToolList(value);
  if (list && list.length > 0) return { [key]: list };
  if (key === "tools" && Array.isArray(value)) {
    return { tools: [] };
  }
  return {};
}

function optionalBoolean(
  key: "background" | "injectAgentsMd",
  value: unknown,
): Partial<AgentProfile> {
  if (typeof value === "boolean") return { [key]: value };
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return { [key]: true };
    if (value.toLowerCase() === "false") return { [key]: false };
  }
  return {};
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const list = value.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
    return list.length > 0 ? list : undefined;
  }
  if (typeof value !== "string") return undefined;
  const list = value
    .split(/[,\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function scalarString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeColor(value: string | undefined): AgentProfile["color"] | undefined {
  if (!value) return undefined;
  return VALID_COLORS.has(value as NonNullable<AgentProfile["color"]>)
    ? (value as NonNullable<AgentProfile["color"]>)
    : undefined;
}

function normalizePermissionMode(value: string | undefined): AgentPermissionMode | undefined {
  if (!value) return undefined;
  return VALID_PERMISSION_MODES.has(value as AgentPermissionMode)
    ? (value as AgentPermissionMode)
    : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function normalizeToolNames(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const names = values.map(toolNameFromSpec).filter((item) => item.length > 0);
  return names.length > 0 ? names : undefined;
}

function toolNameFromSpec(value: string): string {
  const trimmed = value.trim();
  const parenIndex = trimmed.indexOf("(");
  if (parenIndex < 0) return trimmed;
  return trimmed.slice(0, parenIndex).trim();
}
