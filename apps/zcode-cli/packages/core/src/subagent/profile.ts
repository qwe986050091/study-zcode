import { basename } from "node:path";
import { GENERAL_PURPOSE_AGENT_TYPE, buildGeneralPurposeSystemPrompt } from "./general-purpose.js";
import { EXPLORE_AGENT_TYPE } from "./explore.js";
import { formatExploreAllowedToolsForAgentDescription } from "./explore-tools.js";
import { filterSubagentChildToolNames } from "./tool-policy.js";
import type { ModelSelection, AgentProfile } from "@zcode/shared";
export { parseAgentProfileFromMarkdown } from "@zcode/shared";
export type {
  AgentProfile,
  AgentPermissionMode,
  AgentProfileSource,
  AgentMemoryScope,
  AgentProfileParseDiagnostic,
  AgentProfileLoadResult,
} from "@zcode/shared";

// 未指定 subagent_type 时使用的默认类型：general-purpose。
export const DEFAULT_SUBAGENT_TYPE = GENERAL_PURPOSE_AGENT_TYPE;

// 内置子 agent 的模型选择覆盖表：按类型名限定，未提供的类型沿用全局模型。
export type BuiltInSubagentModelSelectionOverrides = Partial<
  Record<typeof DEFAULT_SUBAGENT_TYPE | typeof EXPLORE_AGENT_TYPE, ModelSelection>
>;

// 构造内置 Explore profile：只读检索型，不注入 AGENTS.md，工具取固定子集。
// modelSelection 缺省时不写该字段（而非置 undefined），保持 profile 结构紧凑。
// systemPrompt 留空，实际提示词由 explore.ts 在运行时注入。
export function createBuiltInExploreAgentProfile(
  options: { modelSelection?: ModelSelection } = {},
): AgentProfile {
  return {
    name: EXPLORE_AGENT_TYPE,
    description:
      'Read-only search agent for broad fan-out searches - when answering means sweeping many files, directories, or naming conventions and you only need the conclusion, not the file dumps. It reads excerpts rather than whole files, so it locates code; it doesn\'t review or audit it. Specify search breadth: "medium" for moderate exploration, "very thorough" for multiple locations and naming conventions.',
    color: "cyan",
    injectAgentsMd: false,
    ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
    source: "built-in",
    systemPrompt: "",
    tools: ["Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "TodoWrite"],
  };
}

export function isBuiltInExploreAgentProfile(
  profile: Pick<AgentProfile, "name" | "source">,
): boolean {
  // 用户/项目 profile 可以同名覆盖内置 Explore，不能只按名称套用内置行为。
  return profile.name === EXPLORE_AGENT_TYPE && profile.source === "built-in";
}

// 合并内置 profile 与外部发现的 profile，按 name 去重（后者覆盖前者）。
// 输出顺序：内置 general-purpose → 内置 Explore → 其余按传入顺序；
// 同名覆盖用于让用户/项目级 profile 替换内置行为，而不是并存。
// 纯函数，无 IO；重复调用同一输入结果稳定。
export function normalizeAgentProfiles(
  profiles: readonly AgentProfile[],
  options: {
    builtInModelSelectionOverrides?: BuiltInSubagentModelSelectionOverrides;
  } = {},
): AgentProfile[] {
  const overrides = options.builtInModelSelectionOverrides ?? {};
  // Map 保持首次插入顺序，且 set 同名 key 只更新值不改变位置。
  const active = new Map<string, AgentProfile>();
  active.set(
    DEFAULT_SUBAGENT_TYPE,
    createBuiltInGeneralPurposeAgentProfile({
      modelSelection: overrides[DEFAULT_SUBAGENT_TYPE],
    }),
  );
  active.set(
    EXPLORE_AGENT_TYPE,
    createBuiltInExploreAgentProfile({
      modelSelection: overrides[EXPLORE_AGENT_TYPE],
    }),
  );
  for (const profile of profiles) {
    active.set(profile.name, profile);
  }
  return Array.from(active.values());
}

// 构造内置 general-purpose profile：可写、可注入 AGENTS.md、工具面为全量 `*`。
// 与 Explore 相反，它允许修改文件；是否真的可写仍由父级权限模式与工具策略约束。
// 口径：modelSelection 缺省时省略字段，不写 undefined。
export function createBuiltInGeneralPurposeAgentProfile(
  options: { modelSelection?: ModelSelection } = {},
): AgentProfile {
  return {
    name: DEFAULT_SUBAGENT_TYPE,
    description:
      "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.",
    // 内置子智能体使用显式身份色，避免 UI 按名称 hash 后把 general-purpose 显示为红色。
    color: "blue",
    injectAgentsMd: true,
    ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
    source: "built-in",
    systemPrompt: buildGeneralPurposeSystemPrompt(),
    tools: ["*"],
  };
}

// 生成面向模型的 agent 类型清单文本；无可用类型时返回 null（调用方据此跳过注入）。
// 内部先 normalize，因此内置类型总是存在，当前实现只有在未来允许清空内置时才可能返回 null。
// 纯文本格式化，无 IO；每行调用 formatAgentProfileForPrompt 保证与增量公告口径一致。
export function formatAgentProfilesForPrompt(
  profiles: readonly AgentProfile[],
  options: { embeddedSearchEnabled?: boolean } = {},
): string | null {
  const active = normalizeAgentProfiles(profiles);
  if (active.length === 0) return null;

  return [
    "Available agent types and the tools they have access to:",
    ...active.map((profile) => formatAgentProfileForPrompt(profile, options)),
  ].join("\n");
}

// 单行格式化 `- <name>: <description> (Tools: a, b)`。
// 工具口径：内置 Explore 走 explore-tools 的展示文案（随搜索模式变化）；
// 其他 profile 使用其 tools 过滤 disallowed 后的可见集合；tools 缺失则省略括号段。
export function formatAgentProfileForPrompt(
  profile: Readonly<AgentProfile>,
  options: { embeddedSearchEnabled?: boolean } = {},
): string {
  // 内置 Explore 的工具面由模式决定，不能直接读 profile.tools（那是 direct 模式的静态快照）。
  const tools = isBuiltInExploreAgentProfile(profile)
    ? formatExploreAllowedToolsForAgentDescription(options)
    : profile.tools
      ? filterSubagentChildToolNames(profile.tools, profile.disallowedTools)
      : undefined;
  const toolText = typeof tools === "string" ? tools : tools?.join(", ");
  return `- ${profile.name}: ${profile.description}${toolText ? ` (Tools: ${toolText})` : ""}`;
}

// 面向用户的 profile 展示名：来自文件的 profile 追加文件名以便区分同名来源；
// 内置 profile 无 path，直接返回类型名。不读文件，只取路径末段。
export function agentProfileDisplayName(profile: AgentProfile): string {
  return profile.path ? `${profile.name} (${basename(profile.path)})` : profile.name;
}
