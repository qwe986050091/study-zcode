// ── 文件职责 ──
// 设置页「子智能体」分区：把 CLI 侧的 agents 配置（user/workspace 文件、插件只读 profile、
// 内置 general-purpose/Explore）投影成一张可搜索、可分组、可编辑的资源列表，并承担新增/
// 编辑表单的全部校验与保存事务。它不实现 agent 运行时，只做配置面的读写与展示。
//
// ── 数据流向（单向） ──
// Scope target（用户/某工作区/某远端 source）→ targetServiceResolution → subagentsService.list
//   → projectSettingsSubagents（去掉插件别名行）→ filteredAgents → groupAgentsByScope
//   → AgentListRow（只读投影）或 SubagentForm（可写草稿）。
// 反向只有五条写入命令：createAgent / updateAgent / deleteAgent / setEnabled /
// setBuiltInModelOverride 与 setPluginAgentModelOverride；每次写成功后都必须 refresh()，
// 以服务端投影为准。本地的 agents 数组永远只是投影缓存，不是事实来源。
//
// ── 不变量表 ──
// INV-01：当前作用域只有 selectedScopeKey 一个所有者；targetWorkspacePath /
//         targetWorkspaceIdentity / cacheAuthorityKey / activeAgentTargetKey 全部由它派生，
//         组件内不得另算一份。（守住它的位置：selectedWorkspace 到 activeAgentTargetKey 段）
// INV-02：列表加载必须按 target key 归因；迟到的响应凭 requestId 丢弃，否则切换 Scope 后
//         旧 Host 的结果会覆盖新列表。（loadAgents 的 requestId 与 requestTargetKey）
// INV-03：rpcReady=false 时不得发任何 RPC，也不得把上一次投影当成当前 Scope 的事实；
//         此时渲染 connecting/loading，而不是 error 或空态。（loadAgents 早退 + 渲染分支）
// INV-04：保存前校验 validate 与按钮置灰 canSave 必须同源：两者读同一组
//         modelAvailable / thoughtLevelInvalid / 必填项，避免“能点不能存”。（SubagentForm）
// INV-05：不可用模型只能提示、不能静默清空草稿；保存时必须显式拒绝，防止历史值被当成
//         有效配置写回 Markdown。（validate 的 model 分支 + handleModelChange）
// INV-06：enabled 开关只对 user scope 的 user-source agent 展示；runtime 对其它 scope
//         恒返回 enabled=true，展示开关会造成静默回弹与永不生效的落盘。（supportsEnabledToggle）
// INV-07：内置与插件 agent 的唯一可写面是 model/effort 覆盖，不得改写插件安装目录里的
//         Markdown；这是 supportsModelOverride 与表单可编辑性的分界线。
// INV-08：删除、保存、切换启用都以 agent.id 为身份，不以 name 为身份：同名 agent 可以
//         同时存在于不同 scope 与不同插件。
// INV-09：表单草稿只在 initialFormStateKey 变化时回灌；同一 agent 的等价刷新不能覆盖
//         用户未保存的编辑。（previousInitialFormStateKeyRef 比较）
// INV-10：编辑态删附件必须同时删 editAttachments 与 editAttachmentIndices，二者长度
//         始终相等；只删其一会让按 index 的读取指向错误分块。
// INV-11：target-scoped services 与 useServices() 的当前上下文可能属于不同 Host；
//         插件投影与 subagents RPC 必须统一走 targetServiceResolution。
// INV-12：错误分两路：加载错误进 error 条，写入错误走 toast；不能混进同一状态，
//         否则会出现“保存失败却显示加载失败”的错位提示。
// INV-13：空态有四种且互斥：未连接、加载中/target 不匹配、搜索无结果、确实为空。
//         混用会让用户把连接等待误读成资源为空。（渲染分支顺序）
// INV-14：toast 与日志只透传 message，不得包含系统提示词正文或凭据。
//
import { useConfigWorkspaceTargets } from "@/workspace-config-catalog/index.js";
import { SettingsUserScopeProvider } from "@/settings/SettingsMachine.js";
/* eslint-disable max-lines -- 子智能体管理页集中维护作用域列表、表单和启用状态，避免状态分散 */
import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import { hasExplicitModelChanged } from "@/lib/startPlanRecommendation.js";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Bot, Check, Plus, Trash2 } from "lucide-react";
import { completeNewModelSelection } from "@zcode/provider";
import {
  ZCODE_AGENT_PROVIDER,
  type AgentColor,
  type AgentsCapability,
  type AgentsListResult,
  type AgentSummary,
  type BuiltInSubagentName,
  type ModelSelection,
  type SubAgentConfig,
} from "@zcode/shared";
import {
  TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER,
  TID_SUBAGENT_ROW,
  testId,
} from "@zcode/shared/test-ids";
import type { ModelSelectionView } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { toast } from "@/components/ui/toast.js";
import {
  ModelConfigSelect,
  type ModelSelectFooterAction,
  type ModelSelectGroup,
} from "@/ModelConfigSelect.js";
import { cn } from "@/components/lib/utils.js";
import { logger } from "@/logger.js";
import { settingsResourceRowInteraction } from "@/settings/settingsResourceRowInteraction.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useServices } from "@/hooks/useServices.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useConfigWorkspaceServicesResolution as useWorkspaceServicesResolution } from "@/workspace-config-catalog/index.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildRegistryModelSelectGroups,
  resolveModelDisplayName,
} from "@/lib/modelSelectionGroups.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { SUBAGENT_COLORS, SUBAGENT_COLOR_CLASS } from "@/lib/subagentColors.js";
import { SettingsResourceGroupHeader } from "@/settings/SettingsResourceGroupHeader.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import {
  SubagentReasoningField,
  type SubagentReasoningFieldState,
} from "@/settings/SubagentReasoningField.js";
import { refreshLoadedSubagentsStoreForWorkspace } from "@/store/subagentsStore.js";
import { PluginScopeMenu, getPluginWorkspaceKey } from "@/settings/PluginScopeMenu.js";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";
import { buildSourceSettingsProjectionKey } from "@/settings/settingsSourceWorkspace.js";
import {
  PluginInstallEmptyState,
  PluginLoadingState,
  PluginSearchEmptyState,
} from "@/settings/PluginInstallEmptyState.js";
import {
  resolvePluginDisplayName,
  resolveUniquePluginListingByName,
} from "@/settings/pluginStoreListing.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";

// 颜色候选来自共享常量而不是本页自造：AgentColor 的取值同时被会话列表色点、聊天侧
// 若在本页硬编码一份顺序，切换主题时其中一处会缺 class，色点变成透明。
// AGENT_COLORS 直接展开 SUBAGENT_COLORS，不复制也不本地排序，保证与 CLI schema 同集合。
// 标记与 CLI 配置 schema 使用，三处必须同集合，否则选中的颜色在别处找不到对应 class。
const AGENT_COLORS: AgentColor[] = [...SUBAGENT_COLORS];
const COLOR_DOT_CLASS: Record<AgentColor, string> = SUBAGENT_COLOR_CLASS;
// ModelConfigSelect 要求 isItemLocked：子代理模型菜单不做锁定语义，但要传稳定引用
// 菜单锁定语义属于“当前连接不具备该模型”的场景，由模型设置页处理；
// 子代理页只关心“这个配置指向哪个模型”，锁定与否不在本页职责内。
// 因此这里恒返回 false，而不是从 Registry 反查可用性——两件事不要混。
// （模块级常量）避免每次渲染生成新函数，使菜单内部的 memo 比较失效。
const MODEL_ITEM_NEVER_LOCKED = () => false;
const INHERIT_MODEL_VALUE = "inherit";
// 工具白名单既是“设置页可勾选的全部工具”，也是 getKnownTools 的判定表。
// 它不代表权限：真正的允许/拒绝在 agent frontmatter 与运行时权限层判定。
// 顺序即渲染顺序，属于用户肌肉记忆；增删会改变复选框位置，不要随意重排。
// TOOL_OPTIONS 的次序即复选框渲染次序，增删会挪动用户已记住的位置，不要为了排版重排。
const TOOL_OPTIONS = [
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "Edit",
  "Write",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
] as const;
// Set 版本只服务于 O(1) 判定；配置里可能有几十个工具，逐项 includes 会在每次渲染重复扫描。
// 用 Set 而不是 Record：工具名是自由字符串，Record 会带上原型链风险。
// 集合只读，模块级常量，不随语言或主题变化。
const TOOL_OPTION_SET = new Set<string>(TOOL_OPTIONS);
// 危险工具只标红点、不禁用：禁用会让人误以为“子代理不能用 Bash”，实际只是提示
// 风险标记不参与保存：它不会被写进 Markdown，也不影响运行时权限。
// 若要真正限制，应使用 disallowedTools 或运行时权限模式，而不是在这里做 UI 禁令。
// 这条配置会扩大权限面。
const RISKY_TOOLS = new Set<string>(["Bash", "Edit", "Write"]);

// 三组互斥：user = 可编辑的 user-source agent；plugin = 插件安装目录里的只读 profile；
// 分组只影响展示与搜索，不影响写入：写入的 scope 仍由 agent 自身字段决定。
// 若拿分组结果反推 scope，会把“未知来源”误写进 user 目录。
// 三组的并集必须等于入参集合，不能吞掉未知来源（吞掉会让行凭空消失）。
// builtIn = 其余（内置与来源未知的行）。分组顺序同时决定页面区块顺序。
interface AgentGroups {
  builtIn: AgentSummary[];
  plugin: AgentSummary[];
  user: AgentSummary[];
}

// [权衡] 先过滤掉 result.agents 里的 plugin 项，再并入 pluginAgents：runtime 的 agents
// 该投影只服务设置页；运行时工具调用仍需完整 agents 列表，两者不能互相替换。
// pluginAgents 也可能为空（旧 CLI），此时插件区块直接消失，不报错。
// 会为同一插件 agent 产出规范名与裸名两条（供工具调用解析），直接展示会出现重复行；
// pluginAgents 才是“一文件一条”的设置页投影。若改成按 name 去重，前缀不同的两个插件
// 同名 agent 会被误合并。
export function projectSettingsSubagents(result: AgentsListResult): AgentSummary[] {
  // Bugfix：result.agents 是运行时调用投影，插件 agent 可能同时有规范名称与裸名称别名；
  // 设置页按已安装资源展示，插件部分必须改用一文件一条的 pluginAgents 投影。
  return [...result.agents.filter((agent) => agent.source !== "plugin"), ...result.pluginAgents];
}

// 表单初值快照：把 AgentSummary 归一成受控的字符串/布尔/数组，便于 JSON 化后比较
// 归一化会抹掉服务端新增但 UI 不认识的字段，这是有意的：快照只服务表单字段。
// 未知字段仍由 handleSubmit 从 initial 原样带回，不经过这个快照。
// 因此“表单能编辑的字段”与“原样透传的字段”是两个集合，新增字段要显式选择归属。
// （见 createSubagentFormInitialStateKey）。新增字段必须进入这里，否则刷新不回灌。
export interface SubagentFormInitialState {
  name: string;
  description: string;
  color: AgentColor;
  model: string;
  thoughtLevel?: string;
  injectAgentsMd: boolean;
  inheritAllTools: boolean;
  selectedTools: string[];
  preservedTools: string[];
  systemPrompt: string;
}

interface SubagentsSectionProps {
  onManageModels?: () => void;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  settingsSourceServerId?: string | null;
}

// 可编辑 = scope 为 user/workspace + source 为 user + 非只读，三个条件缺一不可。
// 该判定同时驱动“行可点”“显示删除”“进入表单”，放宽一格就会多出一批不可写入口。
// 只判 source 会让内置行（source 也是 user）获得删除按钮，点下去只会报文件不存在。
// 只判 scope 会让 project-source agent 出现编辑入口，写回时 updateAgent 找不到文件。
function isEditableUserAgent(agent: AgentSummary): boolean {
  return (
    (agent.scope === "user" || agent.scope === "workspace") &&
    agent.source === "user" &&
    agent.readOnly !== true
  );
}

// runtime 只对 user scope 应用 disabledAgentIds（CLI 侧 isDisabledUserProfile 对
// source !== "user" 直接返回 false，workspace profile 的 source 是 "project"），服务端
// attachEnabledState 也据此对非 user scope 恒返回 enabled: true。因此 workspace agent 不能
// 展示启用开关——点了会静默回弹，还会往 user 级 agents-state.json 写入永不生效的记录。
// 即使 agent 可编辑，也只有 user scope 有启用态；workspace agent 的 enabled 是派生值，
// 写入 agents-state.json 后 CLI 仍按 user scope 判定，等于永不生效。
function supportsEnabledToggle(agent: AgentSummary): boolean {
  return isEditableUserAgent(agent) && agent.scope === "user";
}

// scope 与 source 在不同 CLI 版本里只保证其一带 built-in；用“或”兼容旧投影，
// 避免升级后内置 agent 掉进 user 分组拿到编辑入口。
function isBuiltInAgent(agent: AgentSummary): boolean {
  return agent.scope === "built-in" || agent.source === "built-in";
}

/**
 * 内置 general-purpose / Explore 与插件 agent 都是只读 profile，配置入口统一为行内
 * model / effort 覆盖控件；插件 md 属于插件安装目录，升级会覆写，所以不能像 user agent 那样改文件。
 */
// 只读 profile 的唯一可写面是 model/effort 覆盖；这两项由 CLI 单独持久化到用户配置，
// 不触碰插件目录与内置资源。
function supportsModelOverride(agent: AgentSummary): boolean {
  return getBuiltInSubagentName(agent) !== null || agent.source === "plugin";
}

// 只有 general-purpose / Explore 有稳定的内置覆盖通道（setBuiltInModelOverride 以
// 其它内置名（含未来新增）返回 null，会落到“只读且无覆盖控件”的安全兜底。
// 宁可少一个入口，也不能拿一个不稳定的 name 去写覆盖记录。
// agentName 为键）。返回 null 表示“不是可覆盖的内置 agent”，调用方必须据此分派，
// 不能拿 name 字符串直接当键去写。
function getBuiltInSubagentName(agent: AgentSummary): BuiltInSubagentName | null {
  if (!isBuiltInAgent(agent)) {
    return null;
  }
  return agent.name === "general-purpose" || agent.name === "Explore" ? agent.name : null;
}

// 已知工具与未知工具分两段保存：未知项可能来自未来版本或用户手写，设置页不展示，
// 两者的并集顺序即写回顺序：先已知后未知，避免每次保存都重排未识别项。
// 这也是 preserve 命名的来源：它们不是“被保留的勾选”，而是“不由本页管理的项”。
// 但也不能丢，否则保存一次就把它们从 Markdown 的 tools 里抹掉。
function getKnownTools(values: readonly string[] | undefined): string[] {
  return values?.filter((tool) => TOOL_OPTION_SET.has(tool)) ?? [];
}

// 与 getKnownTools 互补，二者必须对同一 TOOL_OPTION_SET 取反；单独改动任一端都会
// 让工具在“展示”和“保存”之间凭空增减。
function getPreservedTools(values: readonly string[] | undefined): string[] {
  return values?.filter((tool) => !TOOL_OPTION_SET.has(tool)) ?? [];
}

// 合并顺序固定为“勾选在前、保留在后”，并按首次出现去重；保存时顺序会写进
// Markdown 的 tools 列表，顺序变化会产生无意义的文件 diff。
// 全空返回 undefined 而不是 []：undefined 在 CLI 语义里是“继承全部”，[] 是“一个都不给”。
function mergeTools(
  selectedTools: readonly string[],
  preservedTools: readonly string[],
): string[] | undefined {
  const result = [...selectedTools, ...preservedTools].filter(
    (tool, index, tools) => tool.length > 0 && tools.indexOf(tool) === index,
  );
  return result.length > 0 ? result : undefined;
}

// 缺省、空数组、含通配符三种形态都表示全部工具，这是 CLI 的既有语义；
// 展示层只回答“是不是全部”，具体名单由 selectedTools 与 preservedTools 负责。
// 若这里判 false，界面会显示“0 个工具”，但运行时其实继承了全部，属高危误导。
// 不能按 length 判断，否则通配符配置会显示成“1 个工具”。
function allowsAllTools(tools: readonly string[] | undefined): boolean {
  // 通配符 * 表示全部工具，不能按数组长度显示成 1 个工具。
  return !tools || tools.length === 0 || tools.some((tool) => tool.trim() === "*");
}

// inherit 是 UI 哨兵值而不是合法模型名；持久化前必须折成 undefined，
// 否则 CLI 会把 inherit 当真实模型写进配置，运行时解析失败。
function toPersistedModel(model: string): string | undefined {
  const trimmedModel = model.trim();
  return trimmedModel && trimmedModel !== INHERIT_MODEL_VALUE ? trimmedModel : undefined;
}

// 反向转换：Selection → 选择器 value。providerId/modelId 用共享编码器拼接，
// 编码器同时服务聊天工具栏与模型设置，任何自定义拼接都会在跨页面比较时失配。
// 未选择时返回 inherit 而不是空串：空串会被表单当成“用户清空了模型”。
// 保证与聊天工具栏、模型设置页产生完全相同的字符串，否则可用性判定会误判。
function toSubagentModelValue(selection: ModelSelection | undefined): string {
  return selection
    ? encodeCustomModelValue(selection.providerId, selection.modelId)
    : INHERIT_MODEL_VALUE;
}

// 只在有真实模型时构造 Selection；reasoningLevel 为空串时不要写 options——
// trim 后再判：只有空白字符的档位等同未设置。
// 构造时不回查 Registry：历史模型也要能原样提交，是否存在由校验层回答。
// CLI 把显式空串当成“用户清空了档位”，与“未设置”是两种状态。
function toSubagentModelSelection(
  model: string | undefined,
  thoughtLevel?: string,
): ModelSelection | undefined {
  const persistedModel = model ? toPersistedModel(model) : undefined;
  if (!persistedModel) return undefined;
  const selection = parseModelPickerValue(persistedModel);
  const reasoningLevel = thoughtLevel?.trim();
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
}

// 导出别名让表单与行内控件共用同一状态类型；SubagentReasoningField 的契约变化时
// 两处会同时报错，而不是悄悄退化成宽松类型。
export type SubagentThoughtOptionState = SubagentReasoningFieldState;

// 思考档位状态机：not-applicable（无模型/模型不可用）→ supported（Registry 给出选项）
// 两个消费方：ReasoningField 用它决定“隐藏/加载中/可选项”，
// isSubagentThoughtLevelAvailable 用它决定保存是否放行。
// 同一状态机服务渲染与校验，避免两处各自解析候选而得出相反结论。
// → unknown（注册表仍在加载）→ unsupported（明确没有 reasoning 能力）。
// 顺序不能换：必须先判模型可用性，否则加载中会被误判成“模型不支持思考”。
export function resolveSubagentThoughtOptionState(params: {
  model: string;
  modelAvailable: boolean;
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionLoading: boolean;
  thoughtLevel?: string;
}): SubagentThoughtOptionState {
  // 无模型或模型失效时直接短路，避免把 inherit 当模型去查 Registry 能力。
  const persistedModel = toPersistedModel(params.model);
  if (!persistedModel || !params.modelAvailable) {
    return { kind: "not-applicable" };
  }
  // 只有真实模型才需要解析；仍用同一编码器，保证与保存时的身份完全一致。
  const modelSelection = parseModelPickerValue(persistedModel);
  const explicitThoughtLevel = params.thoughtLevel?.trim();

  // Settings 只管理 Local Environment，模型能力与候选统一来自 Local Host View。
  // Workspace presentation 的 configOptions 不是第二份模型目录，也不参与 reasoning 判断。
  // Registry 视图是唯一能力来源：Local Host 的模型目录决定 provider/model 是否存在、
  // 以及该模型暴露哪些 reasoning 档位。
  const metadataOption = params.modelSelectionView
    ? resolveModelThoughtOption({
        modelSelectionView: params.modelSelectionView,
        providerId: modelSelection.providerId,
        modelId: modelSelection.modelId,
        currentValue: explicitThoughtLevel,
      })
    : null;
  // 命中 metadata 就返回 supported，即使当前 thoughtLevel 是历史值；
  // 合法性由调用方用 isSubagentThoughtLevelAvailable 单独判定，两个问题不能混在一起。
  if (metadataOption) {
    return {
      kind: "supported",
      option: metadataOption,
    };
  }
  // 仍在加载时不能断言 unsupported：返回 unknown 让校验放行，
  // 避免首帧把本来合法的历史配置标红。
  if (params.modelSelectionLoading) {
    return { kind: "unknown", status: "loading" };
  }
  return { kind: "unsupported" };
}

// 校验口径：空档位永远可用；unknown/not-applicable 时放行（无法证伪）；
// 返回布尔而不是错误码：文案由字段组件负责，校验只回答“能不能存”。
// 选项比较用严格相等：档位值是协议枚举，不做大小写或别名归一。
// unsupported 才拒绝；supported 时要求选项集合里真的有这个 value。
// 放行 unknown 是有意的 fail-open：加载失败不应阻止用户保存本来正确的配置。
export function isSubagentThoughtLevelAvailable(
  state: SubagentThoughtOptionState,
  thoughtLevel: string | undefined,
): boolean {
  const normalizedThoughtLevel = thoughtLevel?.trim();
  if (!normalizedThoughtLevel) {
    return true;
  }
  if (state.kind === "unknown" || state.kind === "not-applicable") {
    return true;
  }
  if (state.kind === "unsupported") {
    return false;
  }
  return Boolean(
    state.option.type === "select" &&
    state.option.options?.some((entry) => entry.value === normalizedThoughtLevel),
  );
}

// 只接受 supported 且 currentValue 为字符串的情形，其它状态返回 undefined，
// 表示“保留现有值”，不能把选项的缺省值写回用户配置。
function resolvedSubagentThoughtLevel(state: SubagentThoughtOptionState): string | undefined {
  return state.kind === "supported" && typeof state.option.currentValue === "string"
    ? state.option.currentValue
    : undefined;
}

// 三道放行：未选择模型、选择 inherit、目录尚未 ready。前两者是配置意图，后者是时序；
// 调用方必须把 loading 一并传入，缺省 false 只适用于确定已 ready 的场景。
// 保存时传入的 loading 与渲染时相同，保证“按钮亮着”与“校验通过”结论一致。
// 只有“目录已 ready 且候选里确实没有”才算失效。把 loading 当失效会让冷启动整页飘红。
export function isSubagentModelAvailable(
  modelGroups: readonly ModelSelectGroup[],
  model: string | undefined,
  modelSelectionLoading = false,
): boolean {
  const trimmedModel = model?.trim();
  if (!trimmedModel || trimmedModel === INHERIT_MODEL_VALUE) {
    return true;
  }
  if (modelSelectionLoading) {
    return true;
  }
  return modelGroups.some((group) => group.items.some((item) => item.value === trimmedModel));
}

// 表单初值的唯一构造点：行内控件与编辑表单都从这里取，保证“打开表单看到的”与
// 这也是“关闭再打开仍复现同一草稿”的原因：初值只依赖 agent 快照，不依赖挂载顺序。
// 新增表单字段时，若只改 JSX 不改这里，刷新后该字段会回到组件默认值。
// “保存时提交的”来自同一份归一化规则。默认 color=yellow、injectAgentsMd=true 是
// 产品既有默认值（与 CLI 新建脚本一致），改动需同步 CLI 侧默认。
export function createSubagentFormInitialState(
  initial?: Pick<
    AgentSummary,
    | "name"
    | "description"
    | "color"
    | "modelSelection"
    | "tools"
    | "systemPrompt"
    | "injectAgentsMd"
  >,
): SubagentFormInitialState {
  return {
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    color: initial?.color ?? "yellow",
    model: toSubagentModelValue(initial?.modelSelection),
    thoughtLevel: initial?.modelSelection?.options?.reasoningLevel,
    injectAgentsMd: initial?.injectAgentsMd ?? true,
    // tools 缺省或空数组都视为“继承全部”；此时 selectedTools 为空但 inheritAllTools 为 true，
    // 两者并不矛盾，不要用 selectedTools.length 反推。
    inheritAllTools: initial?.tools === undefined || initial.tools.length === 0,
    selectedTools: getKnownTools(initial?.tools),
    preservedTools: getPreservedTools(initial?.tools),
    systemPrompt: initial?.systemPrompt ?? "",
  };
}

// 用 JSON 字符串做“初值等价”比较：每次 refresh 都会产生新的 AgentSummary 对象，
// 键里包含 id：两条 agent 字段恰好相同也不会互相覆盖。
// JSON 字段顺序由对象字面量固定，因此同一快照必然得到同一字符串。
// 引用比较必然不等，会导致用户正在编辑的草稿被刷新覆盖。
function createSubagentFormInitialStateKey(initial?: AgentSummary): string {
  return JSON.stringify({
    id: initial?.id ?? null,
    ...createSubagentFormInitialState(initial),
  });
}

// 展示层允许回退到原始字符串（历史配置可能已下架），但保存校验仍以 Registry 为准。
// 若把回退值也当合法，会掩盖失效配置；若在展示层直接报错，又会让只读列表变得刺眼。
// 所以“展示可信度”与“保存可信度”刻意不同，且都由同一个 trimmedModel 驱动。
// resolveSubagentModelLabel 展示历史模型名而保存校验走 Registry，这条不一致是刻意的：用户能看见配置也能知道失效。
function resolveSubagentModelLabel(params: {
  inheritLabel: string;
  modelGroups: readonly ModelSelectGroup[];
  model: string | undefined;
}): string {
  // inherit 与空值都显示调用方给的“继承”文案，措辞交给 i18n。
  const trimmedModel = params.model?.trim();
  if (!trimmedModel || trimmedModel === INHERIT_MODEL_VALUE) {
    return params.inheritLabel;
  }
  // Registry 只包含当前可选模型，但历史 Subagent 配置仍需展示原模型身份，
  // 方便用户理解并修复失效配置。候选列表与保存校验继续以 Registry 为准。
  return resolveModelDisplayName(params.modelGroups, trimmedModel) ?? trimmedModel;
}

// 纯展示 label：不接 htmlFor，因为表单控件多为自定义组件，点击聚焦由各控件自理。
// 统一 mb-1.5 的间距，保证三列表单在窄屏折叠后节奏一致。
// 文案由调用方经 i18n 传入，组件内部不做任何格式化。
function FormFieldLabel({ children }: { children: string }) {
  return (
    <label className="mb-1.5 block text-ui-base font-medium text-foreground-subtle">
      {children}
    </label>
  );
}

// 色点只做视觉标识；颜色本身不是可访问信息，aria-hidden 由外层容器负责。
function AgentColorDot({ color }: { color?: AgentColor }) {
  return (
    <span
      className={cn(
        "inline-flex size-2 shrink-0 rounded-full",
        color ? COLOR_DOT_CLASS[color] : "bg-foreground-subtlest",
      )}
      aria-hidden="true"
    />
  );
}

// 徽标用 ring 而不是 border：不改变内间距，多个徽标并排时高度才一致。
// min-h-5 与 text-ui-sm 绑定，保证与行内主标题的基线对齐。
// 徽标只接收字符串子节点：它不承载交互，避免在行点击区里嵌套按钮。
function AgentBadge({ children, className }: { children: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-5 items-center rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle ring-1 ring-border",
        className,
      )}
    >
      {children}
    </span>
  );
}

// 分组优先级：可编辑 user → plugin → builtIn。顺序不能反：插件的 source 也不是 user，
// 分组是纯函数，便于单测锁定“同一 agent 永远落同一组”的性质。
// 它不做过滤：过滤在调用方先做，分组结果的行数必须与 filteredAgents 一致。
// 必须先判 plugin，否则插件 agent 会掉进 builtIn 区而失去图标与分组标题。
function groupAgentsByScope(agents: readonly AgentSummary[]): AgentGroups {
  const groups: AgentGroups = { builtIn: [], plugin: [], user: [] };
  for (const agent of agents) {
    // 复用 isEditableUserAgent 而不是再写一遍 scope/source：保证“能编辑”与“进 user 区”同源。
    // 若这里独立判断，未来收紧可编辑条件时会出现“列表可点但表单拒绝打开”的分裂。
    // groupAgentsByScope 保持纯函数，测试可直接对投影结果断言而不必挂载组件。
    if (isEditableUserAgent(agent)) {
      groups.user.push(agent);
    } else if (agent.source === "plugin") {
      groups.plugin.push(agent);
    } else {
      groups.builtIn.push(agent);
    }
  }
  return groups;
}

/** 按完整插件 ID 分组，避免同名 marketplace 的子智能体互相合并。 */
// 分组键优先级：pluginId（含 marketplace 前缀，唯一）→ pluginName → agent.name 的冒号
// 排序用 localeCompare，保证不同语言下区块顺序稳定且可预期。
// 兜底键 Plugin 只在字段全缺时出现，属于异常投影，不应被当成正常分组名。
// 前缀 → 兜底。只用 name 前缀会把两家 marketplace 的同名插件合并，一组里出现两个来源。
export function groupPluginAgentsById(
  agents: readonly AgentSummary[],
): Array<[string, AgentSummary[]]> {
  const groups = new Map<string, AgentSummary[]>();
  for (const agent of agents) {
    const key =
      agent.pluginId?.trim() || agent.pluginName?.trim() || agent.name.split(":", 1)[0] || "Plugin";
    groups.set(key, [...(groups.get(key) ?? []), agent]);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

// 自绘 checkbox 而不是原生 input：需要“左侧勾选框 + 整行点击 + 右侧风险点”的布局，
// disabled 只控制视觉与点击，不改变选中值：调用方传 false，保持既有行为。
// 若改成原生 input，整行点击区与自定义勾选样式都要重做，收益只有语义标签。
// role 与 aria-checked 已补齐可访问语义。
function ToolCheckbox({
  checked,
  disabled,
  label,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  // 危险工具只加小红点，不改变可点击性：这里只提示风险，不替用户做权限决策。
  // 红点没有文案，因此用 aria-hidden 排除出可访问树；风险提示由外层说明承担。
  // 位置固定在行尾，避免长工具名把标记挤出可视区。
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left transition-colors",
        disabled ? "cursor-not-allowed opacity-60" : "hover:bg-surface-hover",
      )}
    >
      <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden="true">
        <span
          className={cn(
            "flex size-4 items-center justify-center rounded-sm border transition-colors",
            checked
              ? "border-primary bg-primary text-primary-foreground"
              : "border-input-border bg-input text-transparent",
          )}
        >
          <Check className="size-3.5" />
        </span>
      </span>
      <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
        {label}
      </span>
      {RISKY_TOOLS.has(label) ? (
        <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
      ) : null}
    </button>
  );
}

// 列表行是只读投影：除 model/effort 覆盖与 enabled 开关外没有字段编辑入口。
// 写路径只有两条：表单 → handleSave，覆盖控件 → handleModelOverrideChange。
// 不在行内增加第三种写文件实现，是这个组件保持可推理的前提。
// 行点击进入编辑态由 settingsResourceRowInteraction 统一处理（含键盘可达）。
function AgentListRow({
  agent,
  pluginIconItem,
  isOperating,
  modelGroups,
  modelSelectionView,
  modelSelectionLoading,
  modelSelectGroups,
  onModelOverrideChange,
  onDelete,
  onEdit,
  onToggle,
}: {
  agent: AgentSummary;
  pluginIconItem?: Pick<StorePluginItem, "name" | "listing">;
  isOperating: boolean;
  modelGroups: readonly ModelSelectGroup[];
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionLoading: boolean;
  modelSelectGroups: readonly ModelSelectGroup[];
  onModelOverrideChange: (
    agent: AgentSummary,
    config: { model?: string; thoughtLevel?: string },
  ) => Promise<void>;
  onDelete: (agent: AgentSummary) => void;
  onEdit: (agent: AgentSummary) => void;
  onToggle: (agent: AgentSummary, enabled: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  // 三个布尔回答不同问题：editable=能否删改文件；showEnabledToggle=能否写启用态；
  // 拆成三个变量而不是一个枚举，是因为三者不同步：可编辑但不可切启用是最常见组合。
  // 任何一处复用错误都会让只读行出现写入入口，或让可写行失去入口。
  // rowEditable=当前是否允许交互（含操作中冻结）。不要用一个变量替代三者。
  const editable = isEditableUserAgent(agent);
  const showEnabledToggle = supportsEnabledToggle(agent);
  const rowEditable = editable && !isOperating;
  // 内置/插件行由覆盖控件表达模型，再显示徽标会让同一信息出现两次。
  // 徽标与控件的信息来源相同（modelSelection），重复展示不会增加任何信息。
  // 用户 agent 没有覆盖控件，才需要徽标来回答“这条继承了什么”。
  const hasModelOverrideControl = supportsModelOverride(agent);
  // 有覆盖控件的行由控件本身表达模型，不再重复显示模型徽标。
  const showModelBadge = !hasModelOverrideControl;
  const inheritModelLabel = intl.formatMessage({
    id: "settings.subagents.model.inherit",
  });
  const modelLabel = resolveSubagentModelLabel({
    inheritLabel: inheritModelLabel,
    // 徽标用的是与下拉一致的候选组，保证“显示的名字”和“菜单里选的名字”不打架。
    // 候选组为空（目录未就绪）时仍会回退到原始 model 字符串，不会显示空白。
    // 这里不读 modelSelectionView，只读已构建好的分组，避免行内重复解析。
    modelGroups: modelSelectGroups,
    model: toSubagentModelValue(agent.modelSelection),
  });
  // 工具数按原始数组计：被保留的未知工具也是用户配置的一部分。
  // 显示的数字与 Markdown 里 tools 的条数一致，便于用户对照文件排查。
  // allowsAllTools 为真时 toolsLabel 只用 all 文案，不拼接 toolCount 数字。
  const toolCount = agent.tools?.length ?? 0;
  const toolsLabel = allowsAllTools(agent.tools)
    ? intl.formatMessage({ id: "settings.subagents.tools.all" })
    : intl.formatMessage({ id: "settings.subagents.toolsCount" }, { count: String(toolCount) });
  // 插件 agent 的规范名是 plugin:name，行内只显示冒号后的可读名；
  // 只截掉 plugin:name 里第一个冒号之前的部分，名称中间再出现冒号时保持原样。
  // 完整名继续用于 testid 与 RPC，因此展示名不能回写到 agent 对象。
  // 完整名仍用于 testid 与 RPC 身份，不能替换。
  const displayName =
    agent.source === "plugin" && agent.name.includes(":")
      ? agent.name.slice(agent.name.indexOf(":") + 1)
      : agent.name;

  // 有插件图标就用真实图标，否则统一 Bot 占位；缺失图标不应改变行高。
  // 图标容器固定 size-9：插件图标与占位必须同尺寸，否则列表会出现参差。
  // pluginIconItem 可能只有 name 没有 listing，此时头像组件自行回退。
  // 颜色点必须内缩到头像边框内，否则会溢出容器撑高整行（历史 bug）。
  // 外层用负偏移定位、内层再画点：描边与卡片背景一致，深色主题下不会出现白边。
  // 这层 span 只是定位容器，真正的颜色仍由 AgentColorDot 决定。
  // 删除入口只对可编辑 agent 出现：插件与内置行没有可删的文件。
  // 按钮放在独立 flex 容器里：即使不可编辑，右侧留白也保持对齐。
  // disabled 由 isOperating 控制，与整行冻结保持一致。
  return (
    <div
      data-testid={testId(TID_SUBAGENT_ROW, agent.name)}
      className={cn(
        "grid cursor-default items-center gap-3 px-4 py-3 transition-colors",
        rowEditable && "hover:bg-hover",
        // 有覆盖控件时右侧列在窄屏会换行，需要额外占满一行；没有控件时单行三列即可。
        // 这个分支只影响栅格列数，不改变 DOM 结构，因此不影响行内交互绑定。
        // 有覆盖控件时栅格在 sm 断点追加第三列，否则手机上删除按钮会与控件挤在同一行。
        hasModelOverrideControl
          ? "grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,1fr)_auto]"
          : "grid-cols-[auto_minmax(0,1fr)_auto]",
      )}
      // 行级交互只在可编辑时绑定；不可编辑行不挂 onClick，避免“可点但无反应”。
      // 绑定的是 onEdit 而不是“打开详情”：设置页没有第二层详情。
      // hover 样式同样只在可编辑时出现，保持视觉与行为一致。
      {...settingsResourceRowInteraction(rowEditable ? () => onEdit(agent) : undefined)}
    >
      <div className="relative shrink-0" aria-hidden="true">
        {pluginIconItem ? (
          <PluginStoreAvatar
            item={pluginIconItem}
            className="size-9 bg-background"
            fallbackIcon={<Bot className="size-4" />}
          />
        ) : (
          <div className="flex size-9 items-center justify-center rounded-xl bg-background text-foreground-subtle">
            <Bot className="size-4" />
          </div>
        )}
        {agent.color ? (
          // 右下角颜色点之前溢出头像容器，会让列表行视觉高度变高。
          <span className="absolute -bottom-1 -right-1 inline-flex size-3.5 items-center justify-center rounded-full border border-card bg-card p-px leading-none">
            <AgentColorDot color={agent.color} />
          </span>
        ) : null}
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-ui-base font-medium text-foreground">{displayName}</span>
          {showModelBadge ? <AgentBadge>{modelLabel}</AgentBadge> : null}
          <AgentBadge>{toolsLabel}</AgentBadge>
        </div>
        <p className="mt-0.5 line-clamp-2 text-ui-sm text-foreground-subtle">
          {agent.description || intl.formatMessage({ id: "settings.subagents.noDescription" })}
        </p>
      </div>

      <div
        className={cn(
          "flex items-center gap-2",
          hasModelOverrideControl
            ? "col-span-2 min-w-0 justify-end sm:col-span-1 sm:shrink-0"
            : "shrink-0",
        )}
      >
        {hasModelOverrideControl ? (
          <SubagentModelOverrideControl
            agent={agent}
            disabled={isOperating}
            modelGroups={modelGroups}
            modelSelectionView={modelSelectionView}
            modelSelectionLoading={modelSelectionLoading}
            onModelOverrideChange={onModelOverrideChange}
          />
        ) : null}
        {showEnabledToggle ? (
          <Switch
            checked={agent.enabled}
            onCheckedChange={(enabled) => onToggle(agent, enabled)}
            disabled={isOperating}
            aria-label={intl.formatMessage(
              { id: "settings.subagents.toggleAria" },
              { name: agent.name },
            )}
          />
        ) : null}
        <div className="flex items-center gap-1">
          {editable ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              onClick={() => void onDelete(agent)}
              disabled={isOperating}
              title={intl.formatMessage({ id: "common.delete" })}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// SubagentModelOverrideControl 即改即存：选择一变就写覆盖通道，没有保存按钮。
// 与表单的差异是刻意的：内置/插件资源没有可编辑文件，覆盖值存在用户配置里，
// 一次选择就是一次完整事务，因此只需要“成功/回滚”两态，不需要草稿态。
// 因此它必须自己处理乐观更新、失败回滚与并发禁用（pending），
// 否则用户会看到“界面已改、磁盘未改”的假状态。
/** 内置与插件 subagent 共用的行内 model / effort 覆盖控件，即改即存。 */
function SubagentModelOverrideControl({
  agent,
  disabled,
  modelGroups,
  modelSelectionView,
  modelSelectionLoading,
  onModelOverrideChange,
}: {
  agent: AgentSummary;
  disabled: boolean;
  modelGroups: readonly ModelSelectGroup[];
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionLoading: boolean;
  onModelOverrideChange: (
    agent: AgentSummary,
    config: { model?: string; thoughtLevel?: string },
  ) => Promise<void>;
}) {
  // 新建模型可能触发 Start Plan 推荐流程；无推荐时 hook 直接透传，
  // 推荐是“确认并可能替换模型”的交互，不是必填步骤；hook 返回 null 表示用户取消。
  // 它依赖 modelSelectionView，因此目录未就绪时不会弹窗。
  // useStartPlanRecommendation 复用聊天工具栏那套确认弹窗，返回 null 表示用户取消。
  const recommendStartPlan = useStartPlanRecommendation(modelSelectionView, "subagent");
  const { intl } = useZCodeIntl();
  // pending 只用于禁用控件，不参与渲染分支；写入失败必须回滚到 previousConfig。
  // 不用 pending 切换 loading 文案：覆盖控件没有“保存中”这一视觉状态。
  // 但 pending 会同时禁用模型下拉与 effort 字段，避免两路写入交叉。
  const [pending, setPending] = useState(false);
  // 初值来自“覆盖值”而不是主模型：未覆盖时为 undefined，由 value 落到 inherit。
  // 这里故意不读 agent.modelSelection：继承态要显示“默认主模型”，而不是展开后的模型名。
  // 覆盖值为空对象时也按未覆盖处理，value 由 ?? 兜底。
  const [config, setConfig] = useState<{
    model?: string;
    thoughtLevel?: string;
  }>(() => ({
    model: agent.modelSelectionOverride
      ? toSubagentModelValue(agent.modelSelectionOverride)
      : undefined,
    thoughtLevel: agent.modelSelectionOverride?.options?.reasoningLevel,
  }));
  const defaultLabel = intl.formatMessage({
    id: "settings.subagents.model.defaultMain",
  });
  const selectModelLabel = intl.formatMessage({
    id: "settings.subagents.model.select",
  });
  // inherit 是控件内部哨兵，传给可用性判定前不再转换。
  // 判定函数内部会再次识别 inherit，因此这里不重复归一化。
  // 它的字面值与 CLI 配置里的保留词一致，避免两套哨兵。
  const value = config.model ?? INHERIT_MODEL_VALUE;
  const modelAvailable = isSubagentModelAvailable(modelGroups, value, modelSelectionLoading);
  const thoughtLevelState = resolveSubagentThoughtOptionState({
    model: value,
    modelAvailable,
    modelSelectionView,
    modelSelectionLoading,
    thoughtLevel: config.thoughtLevel,
  });
  // 只有“模型可用 + 确实给了档位 + 档位不在候选里”才算非法；其余情况交给空白态。
  // 模型不可用时不报档位错误：那属于模型问题，提示档位会误导用户。
  // 非法只影响提示与保存，不会自动清空已选档位。
  const thoughtLevelInvalid = Boolean(
    config.thoughtLevel &&
    modelAvailable &&
    !isSubagentThoughtLevelAvailable(thoughtLevelState, config.thoughtLevel),
  );
  // Coding Plan 连接切换后，Builtin 的旧模型可能不再属于当前候选；仅隐藏 reasoning
  // 会让用户误以为模型仍有效，因此触发器改用“选择模型”提示，候选列表仍只展示当前连接。
  // 三种触发器文案：继承 → 默认主模型；失效 → 选择模型；正常 → 模型显示名。
  // 只改文案、不改 value：value 仍是原模型身份，用户重选后才更新。
  // 失效态不显示旧名，避免用户误以为当前连接仍支持该模型。
  // 失效态不能继续显示旧模型名，否则用户会以为当前连接仍支持它。
  const triggerLabel =
    value === INHERIT_MODEL_VALUE
      ? defaultLabel
      : !modelAvailable
        ? selectModelLabel
        : resolveSubagentModelLabel({
            inheritLabel: defaultLabel,
            modelGroups,
            model: value,
          });
  // 外部（刷新或切换 agent）更新覆盖值时回灌本地草稿；依赖只看 override 对象，
  // 不依赖 config：否则用户刚选的值会被自己 setConfig 触发的 effect 覆盖。
  // 依赖里也不放 agent 本身，避免同一覆盖值在父级对象换引用时重复回灌。
  // 避免整行刷新造成无谓重置。
  useEffect(() => {
    setConfig({
      model: agent.modelSelectionOverride
        ? toSubagentModelValue(agent.modelSelectionOverride)
        : undefined,
      thoughtLevel: agent.modelSelectionOverride?.options?.reasoningLevel,
    });
  }, [agent.modelSelectionOverride]);

  // [事务] persistConfig：先乐观 setConfig，再 await 写入；任一步失败都回滚到调用前快照。
  // 反过来（先写后改）会让控件在 await 期间显示旧值，用户会重复点击。
  const persistConfig = useCallback(
    async (nextConfig: { model?: string; thoughtLevel?: string }) => {
      // pending 期间直接丢弃新请求：并发写同一覆盖值没有幂等保证，
      // 视觉上控件此时是 disabled，正常用户无法触发；这条主要防键盘与程序化连点。
      // 丢弃而不是排队：排队会按顺序写入多个中间值，最后一个未必是用户最终意图。
      // pending 期间丢弃新请求而不是排队，避免旧请求晚到后覆盖用户最新的选择。
      if (pending) {
        return;
      }
      const previousConfig = config;
      setConfig(nextConfig);
      setPending(true);
      try {
        // 只有模型身份变化才走 Start Plan 推荐；仅改 effort 不重新询问，避免每次调档都弹确认。
        let selectedConfig = nextConfig;
        if (nextConfig.model && nextConfig.model !== config.model) {
          const selection = toSubagentModelSelection(nextConfig.model, nextConfig.thoughtLevel);
          // 用户取消推荐（chosen 为空）视为放弃本次修改：回滚并保留 pending 前的选择。
          const chosen = selection ? await recommendStartPlan(selection) : null;
          if (!chosen) {
            setConfig(previousConfig);
            return;
          }
          selectedConfig = {
            model: toSubagentModelValue(chosen),
            thoughtLevel: chosen.options?.reasoningLevel,
          };
        }
        // 写入成功后才落 selectedConfig：服务端可能规范化了 thoughtLevel，界面必须跟随权威值。
        // 若继续显示本地值，下一次刷新会“跳变”，用户会以为保存没生效。
        // 因此本地 state 在成功路径上不是权威，只是等待刷新的临时值。
        await onModelOverrideChange(agent, selectedConfig);
        setConfig(selectedConfig);
    // [失败路径] 写入抛错时静默回滚：toast 由上层 handleModelOverrideChange 统一弹，
    // 这里再提示会造成重复。
      } catch {
        setConfig(previousConfig);
      } finally {
        setPending(false);
      }
    },
    [agent, config, onModelOverrideChange, pending, recommendStartPlan],
  );
  const handleValueChange = useCallback(
    // 同一模型重复选择直接返回：否则会触发一次无意义的推荐询问与落盘。
    // 比较的是 nextModel（已把 inherit 归一为 undefined），因此 inherit → inherit 也短路。
    // 这里不比较 thoughtLevel：档位由另一个控件独立提交。
    (nextValue: string) => {
      const nextModel = nextValue === INHERIT_MODEL_VALUE ? undefined : nextValue;
      if (nextModel === config.model) {
        return;
      }
      const nextModelAvailable = isSubagentModelAvailable(
        modelGroups,
        nextValue,
        modelSelectionLoading,
      );
      const nextThoughtState = resolveSubagentThoughtOptionState({
        model: nextValue,
        modelAvailable: nextModelAvailable,
        modelSelectionView,
        modelSelectionLoading,
        thoughtLevel:
          nextModel && modelSelectionView
            ? completeNewModelSelection(modelSelectionView, parseModelPickerValue(nextModel))
                ?.options?.reasoningLevel
            : undefined,
      });
      // 控件展示的是 Registry 默认档位，持久化必须写同一个值；
      // 否则界面有档位而执行 Selection 缺 reasoningLevel。
      // 控件会展示 Registry 的正常默认档位，持久化必须保存同一个值，
      // 不能让界面有值而执行 Selection 缺少 reasoningLevel。
      void persistConfig({
        model: nextModel,
        thoughtLevel: resolvedSubagentThoughtLevel(nextThoughtState),
      });
    },
    [config.model, modelGroups, modelSelectionLoading, modelSelectionView, persistConfig],
  );
  // footer 的“默认主模型”与下拉项同源，选中态由 value 判定；
  // footer 复用 handleValueChange，确保与列表选择走完全相同的推荐与回滚路径。
  // key 用固定字符串：它是菜单项的稳定身份，不能随模型变化。
  // useMemo 锁引用，ModelConfigSelect 内部按引用比较。
  const footerActions = useMemo<ModelSelectFooterAction[]>(
    () => [
      {
        key: "subagent-model:built-in-default",
        label: defaultLabel,
        onSelect: () => handleValueChange(INHERIT_MODEL_VALUE),
        selected: value === INHERIT_MODEL_VALUE,
      },
    ],
    [defaultLabel, handleValueChange, value],
  );

  // 覆盖控件不展示“管理模型”入口：模型目录的权威编辑页在模型设置，这里只做选择。
  // 传入空 lockReasonMessage 是接口要求，不代表存在锁定项。
  // contentSide=top：行内控件靠近列表底部时向上弹，避免被裁切。
  return (
    <div className="flex min-w-0 max-w-full flex-col items-end gap-1">
      <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
        <span
          data-testid={testId(TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER, agent.name)}
          data-model-current-value={value}
          className="inline-flex min-w-0"
        >
          <ModelConfigSelect
            modelGroups={modelGroups}
            normalizedValue={value}
            triggerLabel={triggerLabel}
            showManageModelsAction={false}
            lockReasonMessage=""
            isItemLocked={MODEL_ITEM_NEVER_LOCKED}
            onValueChange={handleValueChange}
            footerActions={footerActions}
            manageModelsLabel={intl.formatMessage({
              id: "chat.toolbar.model.manageModels",
            })}
            contentSide="top"
            contentAlign="end"
            focusSelectorOnClose={null}
            labelVisibilityClassName="inline-flex min-w-0"
            triggerClassName="h-8 w-fit max-w-52 min-w-0 justify-between rounded-lg border border-input-border bg-input px-3 py-1.5 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
            triggerLabelClassName="inline-flex min-w-0 truncate text-left"
            disabled={disabled || pending}
          />
        </span>
        <SubagentReasoningField
          intl={intl}
          state={thoughtLevelState}
          disabled={disabled || pending}
          labelVisibilityClassName="hidden sm:inline-flex"
          onValueCommit={(thoughtLevel) => {
            if (thoughtLevel === config.thoughtLevel) {
              return;
            }
            void persistConfig({ model: config.model, thoughtLevel });
          }}
        />
      </div>
      {thoughtLevelInvalid ? (
        <span className="text-ui-sm text-destructive">
          {intl.formatMessage({
            id: "settings.subagents.form.validation.thoughtLevelUnavailable",
          })}
        </span>
      ) : null}
    </div>
  );
}

// 编辑/新增表单：所有字段都是受控本地草稿，唯一提交点是 handleSubmit。
// 表单不读服务、不写 store：只接收 modelSelectionView 与 onSave，
// 因此测试可用纯回调驱动全部校验分支，不需要搭 Host。
// 表单不持有服务引用，onSave 由 Section 注入，因此同一组件可服务不同 Scope target。
function SubagentForm({
  initial,
  modelSelectionView,
  modelSelectionLoading,
  modelSelectGroups,
  onManageModels,
  saving,
  onCancel,
  onDelete,
  onSave,
  scopeKey,
  workspaceTabs,
  onScopeKeyChange,
}: {
  initial?: AgentSummary;
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionLoading: boolean;
  modelSelectGroups: readonly ModelSelectGroup[];
  onManageModels?: () => void;
  saving: boolean;
  onCancel: () => void;
  onDelete?: (agent: AgentSummary) => void;
  onSave: (config: SubAgentConfig) => Promise<void>;
  scopeKey: string;
  workspaceTabs: ConfigWorkspaceTarget[];
  onScopeKeyChange: (scopeKey: string) => void;
}) {
  // 推荐流程与行内控件共用同一 hook；保存时仅在模型身份变化才询问。
  // 共用 hook 保证两处的“是否弹窗”判定与候选一致。
  // 表单路径没有 pending 概念，因此取消推荐只需 return，不改任何字段。
  const recommendStartPlan = useStartPlanRecommendation(modelSelectionView, "subagent");
  const { intl } = useZCodeIntl();
  // initialFormStateKey 是“等价刷新”的判据：id 相同且归一化字段相同才算同一份初值。
  // 不含 path/scope：这两个字段变化通常意味着换了文件，但表单不展示它们。
  // 若把 updatedAt 之类时间戳放进来，每次刷新都会回灌，草稿必丢。
  const initialFormStateKey = createSubagentFormInitialStateKey(initial);
  const initialFormState = useMemo(
    () => createSubagentFormInitialState(initial),
    [initial, initialFormStateKey],
  );
  // 记录上一次初值键，避免 effect 首次挂载就把用户输入覆盖掉。
  // 初值键在渲染期计算（不 memo），因为比较很便宜，且必须与 effect 看到的值同源。
  // 用 ref 而不是 state：比较结果不参与渲染，放 state 会多一轮更新。
  const previousInitialFormStateKeyRef = useRef(initialFormStateKey);
  const [name, setName] = useState(initialFormState.name);
  const [description, setDescription] = useState(initialFormState.description);
  const [color, setColor] = useState<AgentColor>(initialFormState.color);
  const [model, setModel] = useState(initialFormState.model);
  const [thoughtLevel, setThoughtLevel] = useState(initialFormState.thoughtLevel);
  const [injectAgentsMd, setInjectAgentsMd] = useState(initialFormState.injectAgentsMd);
  const [inheritAllTools, setInheritAllTools] = useState(initialFormState.inheritAllTools);
  const [selectedTools, setSelectedTools] = useState<string[]>(initialFormState.selectedTools);
  const [systemPrompt, setSystemPrompt] = useState(initialFormState.systemPrompt);
  const [nameError, setNameError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const inheritModelLabel = intl.formatMessage({
    id: "settings.subagents.model.inherit",
  });
  // 换模型时同步重算 reasoning 默认档位：不同模型的合法档位集合不同，
  // 若新模型没有 reasoning 能力，completeNewModelSelection 返回 undefined，档位清空。
  // 清成空串而不是保留旧值，避免表单带着一个永远不会被使用的档位提交。
  // 保留旧档位会让“刚选的模型”立刻处于非法状态。
  const handleModelChange = useCallback(
    (nextModel: string) => {
      if (nextModel === model) {
        return;
      }
      setModel(nextModel);
      const identity = toPersistedModel(nextModel);
      const selected =
        identity && modelSelectionView
          ? completeNewModelSelection(modelSelectionView, parseModelPickerValue(identity))
          : undefined;
      setThoughtLevel(selected?.options?.reasoningLevel ?? "");
      setModelError(null);
    },
    [model, modelSelectionView],
  );
  // 这里用原始 model 而非归一化值：inherit 也要参与 available 判定（恒为 true）。
  // 若先归一化，undefined 会让判定少一条分支，逻辑上等价但可读性更差。
  // 后续 persistedModel 仍用于提交，两个变量职责分开。
  const persistedModel = toPersistedModel(model);
  const modelAvailable = isSubagentModelAvailable(modelSelectGroups, model, modelSelectionLoading);
  // 候选已明确失效时仍展示原型号会误导用户；只改触发器文案，不清空草稿或补回候选。
  // 非 ready 阶段由可用性函数保留原意图，不能把读取失败当成模型被删除。
  const modelTriggerLabel = modelAvailable
    ? resolveSubagentModelLabel({
        inheritLabel: inheritModelLabel,
        modelGroups: modelSelectGroups,
        model,
      })
    : intl.formatMessage({ id: "settings.subagents.model.select" });
  // 与行内控件相同结构的 footer：保存前不落盘，选中态只反映草稿。
  // footer 的 key 与行内控件不同，避免同一菜单在不同宿主间复用状态。
  // 选中判定直接用 model 字符串，未归一化，保证 inherit 也能被标中。
  const footerActions = useMemo<ModelSelectFooterAction[]>(
    () => [
      {
        key: "subagent-model:inherit",
        label: inheritModelLabel,
        onSelect: () => handleModelChange(INHERIT_MODEL_VALUE),
        selected: model === INHERIT_MODEL_VALUE,
      },
    ],
    [handleModelChange, inheritModelLabel, model],
  );
  // thoughtLevelState 供字段渲染与校验共用，避免两处各自解析候选。
  // 它依赖 modelAvailable，因此模型失效时字段会隐藏而不是显示空选择器。
  // 校验只读 thoughtLevelInvalid，不重复解析状态机。
  const thoughtLevelState = resolveSubagentThoughtOptionState({
    model,
    modelAvailable,
    modelSelectionView,
    modelSelectionLoading,
    thoughtLevel,
  });
  const thoughtLevelInvalid = Boolean(
    persistedModel &&
    thoughtLevel &&
    modelAvailable &&
    !isSubagentThoughtLevelAvailable(thoughtLevelState, thoughtLevel),
  );
  const trimmedName = name.trim();
  // canSave 是 validate 的“静默版”：只做布尔判定，不写错误文案。
  // 两者唯一差别是副作用：validate 会 setError，而 canSave 在渲染期不能 setState。
  // 新增校验条件时必须在两处同时加，否则会出现“按钮可点但提交后无任何反馈”。
  // 两者必须同时改，否则会出现按钮可点但提交立即失败，或按钮灰但校验其实通过。
  const canSave = Boolean(
    trimmedName.length >= 3 &&
    trimmedName.length <= 50 &&
    /^[a-zA-Z0-9-]+$/u.test(trimmedName) &&
    description.trim() &&
    systemPrompt.trim() &&
    modelAvailable &&
    !thoughtLevelInvalid,
  );
  const selectedColorIndex = Math.max(0, AGENT_COLORS.indexOf(color));

  // [事务] 只有初值键变化才回灌；同一 agent 的等价刷新不能清掉未保存草稿。
  // 刷新后 editingAgent 是新对象但字段相同 → 键相同 → 不回灌，草稿保留；
  // 用户切到另一条 agent → 键不同 → 整表替换，旧草稿丢弃。
  useEffect(() => {
    if (previousInitialFormStateKeyRef.current === initialFormStateKey) {
      return;
    }
    previousInitialFormStateKeyRef.current = initialFormStateKey;
    const nextInitialState = createSubagentFormInitialState(initial);

    // 保存/刷新后表单组件可能复用旧实例；必须按最新 agent 快照回灌字段，
    // 否则已写入 Markdown 的 model 会继续停留在本地 inherit 状态。
    // 逐字段回灌而不是整体替换：字段各自独立 state，没有可整体 set 的容器。
    // 四个错误态也要一起清空：旧错误属于旧 agent，留在界面上会指向错误字段。
    // 回灌后不重置 submitting：提交中的请求仍需要按原流程结束。
    setName(nextInitialState.name);
    setDescription(nextInitialState.description);
    setColor(nextInitialState.color);
    setModel(nextInitialState.model);
    setThoughtLevel(nextInitialState.thoughtLevel);
    setInjectAgentsMd(nextInitialState.injectAgentsMd);
    setInheritAllTools(nextInitialState.inheritAllTools);
    setSelectedTools(nextInitialState.selectedTools);
    setSystemPrompt(nextInitialState.systemPrompt);
    setNameError(null);
    setDescriptionError(null);
    setPromptError(null);
    setModelError(null);
  }, [initial, initialFormStateKey]);

  // validate 返回布尔并写四个字段错误；文案走 i18n，规则必须与 canSave 逐条对应。
  const validate = (): boolean => {
    const trimmedName = name.trim();
    let valid = true;
    // 3–50 与字符集 [a-zA-Z0-9-] 来自 CLI 的文件名安全约束：name 会直接成为 agent 文件名。
    // 前端校验只是提前反馈；CLI 仍会独立校验，不能把这里当成唯一防线。
    // 长度按 trim 后的字符数计，避免用户用空格凑长度。
    if (trimmedName.length < 3 || trimmedName.length > 50) {
      setNameError(
        intl.formatMessage(
          { id: "settings.subagents.form.validation.nameLength" },
          { min: "3", max: "50" },
        ),
      );
      valid = false;
    // 字符集单独一支：长度合法但含空格或中文时仍要给出更精确的提示。
    // 用 else if：长度错误优先展示，避免同时出现两条互相矛盾的提示。
    // 正则带 u 标志，按码点匹配；这里只允许 ASCII，因此行为与字节一致。
    } else if (!/^[a-zA-Z0-9-]+$/u.test(trimmedName)) {
      setNameError(
        intl.formatMessage({
          id: "settings.subagents.form.validation.nameCharacters",
        }),
      );
      valid = false;
    } else {
      setNameError(null);
    }
    // description 会写入 frontmatter，空值会让列表与工具描述出现空白，因此必填。
    // 不做长度上限：description 由模型读取，过长只影响可读性，不影响解析。
    // 仅 trim 后判空，不修改用户输入的大小写与标点。
    if (!description.trim()) {
      setDescriptionError(
        intl.formatMessage({
          id: "settings.subagents.form.validation.descriptionRequired",
        }),
      );
      valid = false;
    } else {
      setDescriptionError(null);
    }
    // systemPrompt 是 agent 的全部行为定义，空值等于创建一个无指令 agent，必须拦截。
    // 这里只对 systemPrompt.trim() 判非空，提示词质量不在前端校验范围。
    // 提交时会 trim，因此纯空白也被视为空。
    if (!systemPrompt.trim()) {
      setPromptError(
        intl.formatMessage({
          id: "settings.subagents.form.validation.promptRequired",
        }),
      );
      valid = false;
    } else {
      setPromptError(null);
    }
    // 模型失效时保存会写入运行时解析不到的值；这里显式拦截，而不是等后端报错。
    // 用 modelSelectionLoading 参与判定：加载中不拦截，避免冷启动无法保存。
    // 错误文案与行内触发器的“选择模型”提示语义一致。
    // 不可用模型会展示为“选择模型”，保存时也必须阻止历史值被静默写回。
    if (!isSubagentModelAvailable(modelSelectGroups, model, modelSelectionLoading)) {
      setModelError(
        intl.formatMessage({
          id: "settings.subagents.form.validation.modelUnavailable",
        }),
      );
      valid = false;
    } else {
      setModelError(null);
    }
    // 档位非法不写字段级错误（字段已自行展示提示），只让整体校验失败。
    // 若这里也 setState，会出现两条相同提示（字段内 + 表单顶部）。
    // 该分支不修改任何字段错误，保留其它字段已算出的结果。
    if (thoughtLevelInvalid) {
      valid = false;
    }
    return valid;
  };

  // 勾选任意工具即退出“继承全部”：否则用户勾了却仍提交 undefined，会被当成未修改。
  // 反向切到“全部”时不清空 selectedTools：切回来时勾选还在，减少重复操作。
  // 保存时“全部”提交 undefined，而不是把当前勾选序列化成完整列表。
  const toggleTool = (tool: string) => {
    setInheritAllTools(false);
    setSelectedTools((current) =>
      current.includes(tool) ? current.filter((item) => item !== tool) : [...current, tool],
    );
  };

  // 从“全部”切到“自定义”时预填全部工具：空白清单会让用户以为工具被清空。
  // 预填只在清单为空时发生；已有勾选（例如从 preserved 恢复）时保持用户原选择。
  // 预填不写回 preservedTools：未识别项仍原样透传。
  const handleToolsModeChange = (value: string) => {
    const nextInheritAllTools = value === "all";
    setInheritAllTools(nextInheritAllTools);
    if (!nextInheritAllTools && selectedTools.length === 0) {
      setSelectedTools([...TOOL_OPTIONS]);
    }
  };

  // [事务] 提交流程：校验 → 必要时询问推荐 → 组装 SubAgentConfig → onSave。
  // onSave 的 reject 会冒泡到 handleSave 的 catch 并 toast，这里不做二次捕获。
  // 提前 return 的两种情形（校验失败、用户取消推荐）都不修改草稿。
  // 任一步提前 return 都不修改草稿；是否关闭表单由上层决定。
  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!validate()) {
      return;
    }
    // 模型身份变化才询问推荐；未变化时直接沿用原 Selection，避免重复弹窗。
    // hasExplicitModelChanged 把 undefined 与 inherit 视为同一意图，避免“没改却弹窗”。
    // 推荐结果整体替换 selection（含 options），不能只替换 model 字段。
    let selection = toSubagentModelSelection(persistedModel, thoughtLevel);
    if (hasExplicitModelChanged(initial?.modelSelection, selection)) {
      const chosen = await recommendStartPlan(selection);
      if (!chosen) return;
      selection = chosen;
    }
    // [权衡] 表单未编辑的字段（disallowedTools/skills/permissionMode/mcpServers 等）
    // 它们没有 UI，但必须原样保留；缺字段在 updateAgent 的语义里是“删除该配置”。
    // 新增 UI 字段时应改为显式读取并进入 initialFormState，而不是继续依赖透传。
    // 从 initial 原样带回：updateAgent 是整体写文件，缺字段会被当成“删除该配置”。
    await onSave({
      name: name.trim(),
      description: description.trim(),
      systemPrompt: systemPrompt.trim(),
      color,
      injectAgentsMd,
      ...(selection ? { modelSelection: selection } : {}),
      tools: inheritAllTools
        ? undefined
        : mergeTools(selectedTools, initialFormState.preservedTools),
      disallowedTools: initial?.disallowedTools,
      skills: initial?.skills,
      permissionMode: initial?.permissionMode,
      ...(initial?.maxTurns ? { maxTurns: initial.maxTurns } : {}),
      ...(initial?.background !== undefined ? { background: initial.background } : {}),
      mcpServers: initial?.mcpServers,
    });
  };

  // 表单不处理 Esc/遮罩关闭：这是设置页内的原地视图，取消必须由按钮显式触发。
  // 这样浏览器的返回与面包屑可以与取消走同一入口（handleCancelForm）。
  // 表单也不监听全局快捷键，避免与设置页其他输入框冲突。
  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-xl border border-border p-4">
      <div className="flex justify-end">
        <label className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <span className="shrink-0 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.scope.label" })}
          </span>
          <PluginScopeMenu
            align="end"
            disabled={Boolean(initial)}
            selectedScopeKey={scopeKey}
            workspaceTabs={workspaceTabs}
            onScopeKeyChange={onScopeKeyChange}
          />
        </label>
      </div>
      <div className="grid gap-3 md:grid-cols-[minmax(12rem,14rem)_auto_minmax(0,1fr)] md:items-start">
        <div className="space-y-1.5">
          <FormFieldLabel>
            {intl.formatMessage({ id: "settings.subagents.form.name.label" })}
          </FormFieldLabel>
          <Input
            type="text"
            size="lg"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.subagents.form.name.placeholder",
            })}
          />
          {nameError ? <p className="text-ui-base text-destructive">{nameError}</p> : null}
        </div>
        <div className="space-y-1.5">
          <FormFieldLabel>
            {intl.formatMessage({ id: "settings.subagents.form.color.label" })}
          </FormFieldLabel>
          <div
            role="radiogroup"
            className="relative inline-grid w-56 grid-cols-8 rounded-lg border border-input-border bg-input p-1"
          >
            <span
              className="pointer-events-none absolute top-1 size-6 rounded-full border border-border-hover bg-surface shadow-xs transition-[left]"
              style={{
                left: `calc(0.25rem + ((100% - 0.5rem) / ${AGENT_COLORS.length}) * ${selectedColorIndex})`,
              }}
              aria-hidden="true"
            />
            {AGENT_COLORS.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={color === option}
                aria-label={intl.formatMessage({
                  id: `settings.subagents.color.${option}`,
                })}
                className="relative z-10 flex size-6 items-center justify-center rounded-full outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setColor(option)}
              >
                <span className={cn("size-3.5 rounded-full", COLOR_DOT_CLASS[option])} />
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <FormFieldLabel>
            {intl.formatMessage({ id: "settings.subagents.form.model.label" })}
          </FormFieldLabel>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ModelConfigSelect
              modelGroups={modelSelectGroups}
              normalizedValue={model}
              triggerLabel={modelTriggerLabel}
              showManageModelsAction={Boolean(onManageModels)}
              lockReasonMessage=""
              isItemLocked={MODEL_ITEM_NEVER_LOCKED}
              onValueChange={handleModelChange}
              footerActions={footerActions}
              manageModelsLabel={intl.formatMessage({
                id: "chat.toolbar.model.manageModels",
              })}
              onManageModels={onManageModels}
              // 聊天工具栏的模型菜单默认向上弹；Subagents add/edit 表单位于设置页正文，
              // 菜单项应贴着按钮下方展开，避免覆盖上面的表单字段。
              contentSide="bottom"
              focusSelectorOnClose={null}
              labelVisibilityClassName="inline-flex min-w-0"
              triggerClassName="h-8 w-fit max-w-full min-w-0 justify-between rounded-lg border border-input-border bg-input bg-clip-border px-3 py-1.5 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
              triggerLabelClassName="inline-flex min-w-0 truncate text-left"
            />
            <SubagentReasoningField
              intl={intl}
              state={thoughtLevelState}
              disabled={saving}
              labelVisibilityClassName="inline-flex min-w-0"
              onValueCommit={setThoughtLevel}
            />
          </div>
          {modelError ? <p className="text-ui-base text-destructive">{modelError}</p> : null}
          {thoughtLevelInvalid ? (
            <p className="text-ui-base text-destructive">
              {intl.formatMessage({
                id: "settings.subagents.form.validation.thoughtLevelUnavailable",
              })}
            </p>
          ) : null}
        </div>
      </div>

      <div className="space-y-1.5">
        <FormFieldLabel>
          {intl.formatMessage({
            id: "settings.subagents.form.description.label",
          })}
        </FormFieldLabel>
        <Input
          type="text"
          size="lg"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.subagents.form.description.placeholder",
          })}
        />
        {descriptionError ? (
          <p className="text-ui-base text-destructive">{descriptionError}</p>
        ) : null}
      </div>

      <div className="space-y-2 pt-1">
        <FormFieldLabel>
          {intl.formatMessage({ id: "settings.subagents.form.tools.label" })}
        </FormFieldLabel>
        <div className="flex min-w-0 items-center gap-2">
          <Select value={inheritAllTools ? "all" : "custom"} onValueChange={handleToolsModeChange}>
            <SelectTrigger size="lg" className="w-fit justify-between">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {intl.formatMessage({
                  id: "settings.subagents.form.tools.mode.all",
                })}
              </SelectItem>
              <SelectItem value="custom">
                {intl.formatMessage({
                  id: "settings.subagents.form.tools.mode.custom",
                })}
              </SelectItem>
            </SelectContent>
          </Select>
          <span className="min-w-0 text-ui-base font-normal text-foreground-subtle">
            {intl.formatMessage({
              id: "settings.subagents.form.tools.card.title",
            })}
          </span>
        </div>
        {inheritAllTools ? null : (
          <div className="rounded-lg border border-border bg-card p-1">
            <div className="grid max-h-72 gap-1 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
              {TOOL_OPTIONS.map((tool) => (
                <ToolCheckbox
                  key={tool}
                  checked={selectedTools.includes(tool)}
                  disabled={false}
                  label={tool}
                  onToggle={() => toggleTool(tool)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <FormFieldLabel>
          {intl.formatMessage({
            id: "settings.subagents.form.systemPrompt.label",
          })}
        </FormFieldLabel>
        <SettingsFormTextarea
          value={systemPrompt}
          onChange={(event) => setSystemPrompt(event.target.value)}
          rows={3}
          className="max-h-56 min-h-16 resize-y overflow-y-auto text-ui-base"
          placeholder={intl.formatMessage({
            id: "settings.subagents.form.systemPrompt.placeholder",
          })}
        />
        {promptError ? <p className="text-ui-base text-destructive">{promptError}</p> : null}
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-3 py-2.5">
        <p className="min-w-0 text-ui-base font-medium text-foreground">
          {intl.formatMessage({
            id: "settings.subagents.form.injectAgentsMd.label",
          })}
        </p>
        <Switch
          checked={injectAgentsMd}
          onCheckedChange={setInjectAgentsMd}
          aria-label={intl.formatMessage({
            id: "settings.subagents.form.injectAgentsMd.label",
          })}
        />
      </div>

      <SettingsFormActions
        leadingAction={
          initial && onDelete ? (
            <Button
              type="button"
              variant="link"
              size="lg"
              className="px-0 text-destructive hover:text-destructive"
              onClick={() => onDelete(initial)}
              disabled={saving}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {intl.formatMessage({ id: "common.delete" })}
            </Button>
          ) : undefined
        }
      >
        <Button type="submit" variant="default" size="lg" disabled={!canSave || saving}>
          {saving
            ? intl.formatMessage({ id: "common.saving" })
            : intl.formatMessage({ id: "common.save" })}
        </Button>
        <Button type="button" variant="ghost" size="lg" onClick={onCancel} disabled={saving}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
      </SettingsFormActions>
    </form>
  );
}

// 分区容器：负责 Scope 选择、列表加载、写入命令与视图切换（列表 ↔ 表单）。
// 容器不缓存“上一次 Scope 的列表”：切换时直接进入 loading，避免展示错配数据。
// 因此这里看不到第二份 agents 状态，也没有跨 target 的合并逻辑。
// 业务状态都收敛在这里，子组件只接收投影与回调，便于把“读哪份 Host 事实”集中到一处。
export function SubagentsSection({
  onManageModels,
  workspacePath,
  workspaceIdentity,
  settingsSourceServerId,
}: SubagentsSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const plugins = usePluginManagementStore((state) => state.plugins);
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const currentServices = useServices();
  const workspaceTabs = useConfigWorkspaceTargets(settingsSourceServerId);
  const baseServices = useBaseWorkspaceServices();
  // agents 是服务端投影的本地镜像，只由 loadAgents 写入；不要在其他回调里局部拼装。
  // 写入回调也不做本地乐观增删：文件操作的结果只有 list 能权威回答。
  // 唯一例外是 operatingAgentId/refreshing 这类瞬时交互态，它们不参与事实判定。
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  // capability 描述当前 Host 支持的 scope 能力（如 userScopeAvailable），决定新建入口是否存在。
  // 它来自 list 的返回，因此切换 target 后会随列表一起更新。
  // 不持久化：能力是连接属性，缓存下来会误导下一次启动。
  const [capability, setCapability] = useState<AgentsCapability | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // query 只影响展示，不参与 RPC：搜索是纯前端过滤，避免每次输入都打服务端。
  // 它也不进入 URL：设置页刷新后回到全量列表，行为可预期。
  // 清空按钮只 setQuery("")：不调用 list 也不触发 reload，避免一次点击引发全量拉取。
  const [query, setQuery] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentSummary | null>(null);
  const [saving, setSaving] = useState(false);
  const [operatingAgentId, setOperatingAgentId] = useState<string | null>(null);
  // loadedAgentTargetKey 记录“当前列表属于哪个 target”，切换期间据此避免展示错配数据。
  // 它只在请求成功或失败后写入，不在请求开始时写：否则会把旧列表标成新 target。
  // 与 requestId 配合：一个负责同期，一个负责跨期。
  const [loadedAgentTargetKey, setLoadedAgentTargetKey] = useState("");
  // selectedScopeKey 是 Scope 的唯一所有者，下面所有 target 派生都从它出发。
  // 初始值 user 对应“本机用户配置”，与设置页默认入口一致。
  // 表单内切换 Scope 只在新增时允许，编辑时由 initial 锁定。
  const [selectedScopeKey, setSelectedScopeKey] = useState("user");
  const selectedWorkspace = workspaceTabs.find(
    (tab) => getPluginWorkspaceKey(tab) === selectedScopeKey,
  );
  // User scope 的权威固定为 base：未选项目时不能继承 active remote identity，
  // localWorkspaceTabs 同时排除 remoteTarget 与 remoteSessionId，两种远端形态都要挡。
  // 若只挡 remoteSessionId，SSH/WSL 目标仍会把本机用户配置写到远端 home。
  // Bug 根因：User 未选项目时曾继承 active remote identity，把本机用户配置写进远端 home。
  // User 的服务权威固定为 base；需要 cwd 的插件初始化只借用同权威的本机项目。
  // 只有“本机 + 非远端”的 tab 才能给 User 页提供 cwd；远端 tab 只属于它自己的 workspace scope。
  // 过滤条件是三个字段全空，而不是只看 workspaceIdentity：remoteTarget 也可能单独存在。
  // 结果顺序沿用 workspaceTabs，取第一个作为兜底项目。
  const localWorkspaceTabs = workspaceTabs.filter(
    (tab) => !tab.workspaceIdentity && !tab.remoteSessionId && !tab.remoteTarget,
  );
  const localWorkspace =
    localWorkspaceTabs.find((tab) => tab.workspacePath === workspacePath) ?? localWorkspaceTabs[0];
  // targetWorkspacePath：选中 workspace 用它自己的路径；User 页在 source 模式下沿用来源路径，
  // 三个分支的优先级不可交换：selectedWorkspace 必须压过 source，否则切项目后仍读来源。
  // 最后的本机项目回退只为插件初始化提供 cwd，不参与 user 配置的写入目标。
  // 否则退到本机任一项目（插件初始化需要 cwd）。
  const targetWorkspacePath =
    selectedWorkspace?.workspacePath ??
    (settingsSourceServerId ? workspacePath : localWorkspace?.workspacePath);
  // identity 只在 workspace 或 source 模式下有意义；User 本机页必须留空，否则身份会串到远端。
  // 这与“identity 优先于 path”的全局约定一致：远端同名路径必须靠 identity 区分。
  // 因此这里用 ?? 而不是 ||：空串也是显式“无身份”，不能被回退覆盖。
  const targetWorkspaceIdentity =
    selectedWorkspace?.workspaceIdentity ??
    (settingsSourceServerId ? workspaceIdentity : undefined);
  // cacheAuthorityKey 区分“来源服务器投影”与“本机用户投影”，避免两份缓存互相命中。
  // 选中具体 workspace 时返回 undefined：workspace 自己就是权威，不需要额外前缀。
  // 三个分支与 targetWorkspacePath 的分支一一对应，不能单独改一处。
  const cacheAuthorityKey =
    settingsSourceServerId && !selectedWorkspace
      ? `source-settings:${settingsSourceServerId}`
      : selectedWorkspace
        ? undefined
        : "local-user";
  // activeAgentTargetKey 是列表归因键：路径 + 身份 + 缓存权威，任一变化都算换 target。
  // 键由 buildSourceSettingsProjectionKey 统一构造，避免本页手工拼串与来源页不一致。
  // 它同时用于请求快照与展示匹配，两个用途必须使用同一个变量。
  const activeAgentTargetKey = buildSourceSettingsProjectionKey(
    targetWorkspacePath,
    targetWorkspaceIdentity,
    cacheAuthorityKey,
  );
  // 旧 target 的列表在首次加载完成前不展示；projectionMatchesTarget 为 false 时走 loading。
  // 首次 loadedAgentTargetKey 为空算匹配，由 loading 状态负责，不重复判断。
  // 这样 target 切换只会出现“loading”，不会出现“空列表”中间态。
  const projectionMatchesTarget =
    !loadedAgentTargetKey || loadedAgentTargetKey === activeAgentTargetKey;
  // [权衡] 显式传 unscopedServices/forceUnscoped：User 页需要一个“无 workspace 绑定”的服务
  // 若省略这两个参数，hook 会按当前上下文解析，可能在设置页尚未切项目时就绑定到某个项目。
  // source 模式下传入 currentServices：它代表“来源服务器”，而不是当前窗口的连接。
  // 解析，否则会退回当前窗口的活动 workspace，把配置写到错误位置。
  const targetServiceResolution = useWorkspaceServicesResolution(
    targetWorkspacePath,
    selectedWorkspace?.remoteSessionId,
    targetWorkspaceIdentity,
    selectedWorkspace?.remoteTarget,
    {
      unscopedServices: selectedWorkspace
        ? undefined
        : settingsSourceServerId
          ? currentServices
          : baseServices,
      forceUnscoped: !selectedWorkspace,
    },
  );
  // [失败路径] 连接未就绪时 services 仍是占位实现，rpcReady 为 false；
  // 所有调用点必须先看 rpcReady，不能只依赖 services 是否存在。
  // Bug 原因：Scope target 与 useServices() 的当前上下文可以属于不同远程 host，
  // 子智能体及插件投影必须统一使用 target-scoped services，连接恢复前暂停 RPC。
  // 解构出的两个服务都来自 target 解析结果，不能换成 useServices() 的同名服务：
  // 主进程返回的投影键与 RPC 连接都带 target 身份，混用会出现“列表来自 A、图标来自 B”。
  // 这也是本页唯一允许出现 currentServices 的地方（仅 source 分支注入）。
  const { pluginManagementService, subagentsService } = targetServiceResolution.services;
  // activeScope 与 selectedScopeKey 不同源：前者是 RPC 语义（user/workspace），
  // 后者含具体 workspace 键，专供缓存与展示；把它直接当 RPC scope 会带上路径。
  // 两者都由 selectedWorkspace 派生，因此不会出现“UI 显示项目、RPC 走用户”的错位。
  const activeScope = selectedWorkspace ? "workspace" : "user";
  // Provider/Model 事实属于目标 Environment：内置模型覆盖必须读 Scope target 自己的
  // Registry 视图，等待远端连接期间不能回退到 Base Host 的模型列表。
  // [并发] 模型目录按 target 读取；连接等待期间 view 为 null 但 loading 为 true，
  // 校验据此放行，而不是判失效。
  const modelSelectionRead = useModelSelectionServiceView(
    targetServiceResolution.services.modelSelectionService,
    targetServiceResolution.rpcReady,
  );
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  // 非 ready 一律视为 loading：error/unavailable 不能等同于“模型已删除”。
  // 这保证加载失败时保存按钮仍然可用（只要其它校验通过），不会把用户锁死。
  // 错误本身由 modelSelectionRead.state.status 单独渲染提示条。
  // 非 Ready 生命周期均保留表单中的模型意图；error/unavailable 不能被误判成模型已失效。
  const modelSelectionLoading = modelSelectionRead.state.status !== "ready";
  // requestId 单调递增，用于丢弃迟到的 list 响应（切 Scope 或快速刷新）。
  // 它在每次连接状态变化时也自增：断线后旧请求不应再写状态。
  // 用 ref 而不是 state：自增不需要触发渲染。
  const latestRequestIdRef = useRef(0);
  const pluginInventoryWorkspacePath = targetWorkspacePath;
  // 候选组由 Registry 视图构建；视图为 null 时给空数组，避免下游拿到半成品分组。
  // 这里只构建一次，行内控件与表单共用同一引用，避免每个 row 各自构造大数组。
  // 依赖只用 intl 与 view：语言切换会重建标签，但不会重新请求模型目录。
  const chatModelSelectGroups = useMemo(() => {
    if (!modelSelectionView) return [];
    return buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, modelSelectionView, {
      startPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.startPlanBadge",
      }),
      apiKeyLabel: intl.formatMessage({
        id: "settings.modelProvider.apiKey",
      }),
      codingPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlan",
      }),
    });
  }, [intl, modelSelectionView]);
  const subagentModelSelectGroups = chatModelSelectGroups;
  // [并发] loadAgents：进入时自增 requestId 并快照 target key；返回后任一变化即丢弃结果。
  // 两个判据缺一不可：requestId 防同 target 的旧请求，target key 防跨 target 的返回值。
  // 成功与失败分支都要做同一判定，否则错误会从旧 target 泄漏到新页面。
  // 否则“切到远端后本机响应才到”会把远端列表覆盖成本机数据。
  const loadAgents = useCallback(
    async (showBlockingLoading: boolean) => {
      // 未连接直接返回：不 setLoading，避免连接页闪一下空态。
      // 连接建立后由 effect 触发一次阻塞加载，因此这里不需要补偿性清空。
      // 也不清空 agents：重连后先展示旧列表再刷新，比整页空白体验更好。
      if (!targetServiceResolution.rpcReady) return;
      setLoading(showBlockingLoading);
      setRefreshing(!showBlockingLoading);
      setError(null);
      const requestTargetKey = activeAgentTargetKey;
      const requestId = ++latestRequestIdRef.current;
      // [失败路径] list 失败也写 loadedAgentTargetKey：让 UI 停止 loading 并展示错误条，
      // 而不是永远停在加载态（那样用户没有任何重试入口）。
      // 失败时不更新 agents：旧列表仍是上一次成功的结果，配合错误条可继续操作吗？
      // 不能：错误态下 target 可能已切换，因此只展示错误，不承诺旧列表属于当前 target。
      // 失败分支同样写 loadedAgentTargetKey 并停 loading，错误条出现后用户可手动刷新重试。
      try {
        const result = await subagentsService.list({
          workspacePath: targetWorkspacePath ?? "",
          workspaceIdentity: targetWorkspaceIdentity,
          provider: ZCODE_AGENT_PROVIDER,
          mode: activeScope === "user" ? "settingsUserOnly" : "allRuntimeScopes",
        });
        if (requestId !== latestRequestIdRef.current) {
          return;
        }
        // 插件 agent 是运行时 profile 的只读投影：展示它们，但仍不提供 workspace 编辑入口。
        // 它们的 model/effort 覆盖写在用户配置里，因此仍可在行内修改。
        // 插件卸载后对应行自然消失，不需要额外的清理逻辑。
        // 插件 agent 是运行时 profile 的只读投影；设置页展示它们，但仍不展示工作区级编辑入口。
        setAgents(projectSettingsSubagents(result));
        setCapability(result.capability);
        setLoadedAgentTargetKey(requestTargetKey);
        setLoading(false);
        setRefreshing(false);
      } catch (loadError) {
        if (requestId !== latestRequestIdRef.current) {
          return;
        }
        setLoading(false);
        setRefreshing(false);
        setLoadedAgentTargetKey(requestTargetKey);
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    },
    [
      subagentsService,
      activeScope,
      activeAgentTargetKey,
      targetServiceResolution.rpcReady,
      targetWorkspaceIdentity,
      targetWorkspacePath,
    ],
  );

  // 连接状态变化时先使 in-flight 请求失效，再清空 loading/error：
  // rpcReady 变 false 时先自增 latestRequestIdRef，让在飞请求的旧结果失效后再清 loading 与 error。
  useEffect(() => {
    if (!targetServiceResolution.rpcReady) {
      latestRequestIdRef.current += 1;
      setLoading(false);
      setRefreshing(false);
      setError(null);
      return;
    }
    void loadAgents(true);
  }, [loadAgents, targetServiceResolution.rpcReady]);

  // [并发] 插件清单初始化与列表加载并行：初始化只补充图标与展示名，失败仅告警，
  // 初始化完成后主动再 load 一次（非阻塞），让冷启动时先到的列表补上插件分组。
  // active 标志在 cleanup 置 false，阻止卸载后仍调用 setAgents。
  // 不阻断用户 agent 列表；active 标志防止组件卸载后 setState。
  useEffect(() => {
    if (!pluginInventoryWorkspacePath || !targetServiceResolution.rpcReady) return;
    let active = true;
    // 冷启动 seed 晚于文件首读，旧用户页又跳过 inventory 初始化，导致插件直到重进才出现。
    // 复用已有初始化完成事件刷新只读资源，不阻塞用户列表、不轮询，也不把项目配置带入用户页。
    void (async () => {
      try {
        await initializePlugins({
          workspacePath: pluginInventoryWorkspacePath,
          workspaceIdentity: targetWorkspaceIdentity,
          authorityKey: cacheAuthorityKey,
          configScope: activeScope === "user" ? "user" : undefined,
          pluginService: pluginManagementService,
        });
        if (active) await loadAgents(false);
      } catch (initializationError) {
        if (active)
          logger.warn("[subagents] 插件资源初始化失败，保留当前列表", initializationError);
      }
    })();
    return () => {
      active = false;
    };
  }, [
    activeScope,
    cacheAuthorityKey,
    initializePlugins,
    loadAgents,
    pluginInventoryWorkspacePath,
    pluginManagementService,
    targetServiceResolution.rpcReady,
    targetWorkspaceIdentity,
  ]);

  // 手动刷新走非阻塞 loading（refreshing），保持列表可见，避免整页闪烁。
  // refreshing 同时用于禁用行操作：刷新期间 agents 数组会被整体替换。
  // 阻塞 loading 只用于首次加载与 target 切换，二者都必须遮住错配数据。
  const refresh = useCallback(async () => {
    await loadAgents(false);
  }, [loadAgents]);

  // 提及（@）候选是另一份 store；写入后必须一起刷新，否则新 agent 在输入框里搜不到。
  // 两份刷新并行且互不阻断：列表是页面事实，mention store 只影响输入框候选。
  // 它们都依赖同一个 target，因此 target 变化时两份缓存必须一起失效。
  const refreshMentionStore = useCallback(async () => {
    await refreshLoadedSubagentsStoreForWorkspace({
      scope: activeScope,
      workspacePath: targetWorkspacePath,
      workspaceIdentity: targetWorkspaceIdentity,
      subagentsService,
    });
  }, [activeScope, subagentsService, targetWorkspaceIdentity, targetWorkspacePath]);

  // [事务] 保存的提交点：写入成功 → 关闭表单 → 并行刷新列表与提及 store。
  // 关表单发生在刷新之前：刷新期间若仍停在表单，用户会看到旧初值又被回灌一次。
  // 刷新失败不回滚：文件已是新事实，重试刷新即可恢复展示。
  // 刷新失败不回滚已落盘的文件；错误只提示，因为磁盘已是新事实。
  const handleSave = useCallback(
    async (config: SubAgentConfig) => {
      setSaving(true);
      try {
        // 编辑用 editingAgent 自己的 scope/projectPath：它可能属于另一个 workspace，
        // 不能用当前 target 覆盖，否则文件会写到错误项目。
        // oldFilePath 让服务端能定位旧文件并在改名时移动它。
        // 不能用当前 target 覆盖，否则文件会写到错误项目。
        if (editingAgent) {
          await subagentsService.updateAgent({
            agentId: editingAgent.id,
            config,
            oldFilePath: editingAgent.path,
            provider: ZCODE_AGENT_PROVIDER,
            scope: editingAgent.scope === "workspace" ? "workspace" : "user",
            workspacePath: editingAgent.projectPath ?? targetWorkspacePath ?? undefined,
            workspaceIdentity: targetWorkspaceIdentity,
          });
        // 新建用 activeScope 与当前 target path；Scope 选择在表单内被禁用（编辑时不可改）。
        // 新建的 workspacePath 允许为空：User 页在本机无项目时也能创建用户级 agent。
        // identity 只在 workspace/source 模式下非空，与列表读取口径一致。
        } else {
          await subagentsService.createAgent({
            config,
            provider: ZCODE_AGENT_PROVIDER,
            scope: activeScope,
            workspacePath: targetWorkspacePath ?? undefined,
            workspaceIdentity: targetWorkspaceIdentity,
          });
        }
        setShowForm(false);
        setEditingAgent(null);
        await Promise.all([refresh(), refreshMentionStore()]);
      } catch (saveError) {
        toast(saveError instanceof Error ? saveError.message : String(saveError));
      } finally {
        setSaving(false);
      }
    },
    [
      activeScope,
      editingAgent,
      refresh,
      refreshMentionStore,
      subagentsService,
      targetWorkspaceIdentity,
      targetWorkspacePath,
    ],
  );

  // [事务] 删除不可逆：先确认，再按 agent.id 删除，成功后刷新两份投影。
  // 确认框是唯一防线，服务端不做二次确认；因此删除按钮只出现在可编辑行。
  // 删除后同时清空编辑态：否则表单会继续渲染一个已不存在的 agent。
  // 失败只 toast、不关闭表单，用户可重试。
  const handleDelete = useCallback(
    async (agent: AgentSummary) => {
      if (!isEditableUserAgent(agent)) {
        return;
      }
      const confirmed = await confirmDialog({
        confirmVariant: "destructive",
        title: intl.formatMessage({ id: "settings.subagents.delete.title" }),
        description: intl.formatMessage(
          { id: "settings.subagents.delete.description" },
          { name: agent.name },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
      });
      if (!confirmed) {
        return;
      }
      setOperatingAgentId(agent.id);
      try {
        await subagentsService.deleteAgent({
          agentId: agent.id,
          filePath: agent.path,
        });
        setEditingAgent(null);
        setShowForm(false);
        await Promise.all([refresh(), refreshMentionStore()]);
      } catch (deleteError) {
        toast(deleteError instanceof Error ? deleteError.message : String(deleteError));
      } finally {
        setOperatingAgentId(null);
      }
    },
    [confirmDialog, intl, refresh, refreshMentionStore, subagentsService],
  );

  // 启用态只对 user scope 生效；这里再判一次 supportsEnabledToggle，
  // 与行内渲染共用同一判定函数，避免“显示了开关”和“允许写入”两条规则漂移。
  // 不满足时直接 return，不写任何 state，保证 UI 不会出现乐观闪烁。
  // handleToggle 先拦一道 supportsEnabledToggle，行内控件即便被误渲染也写不进去。
  const handleToggle = useCallback(
    async (agent: AgentSummary, enabled: boolean) => {
      if (!supportsEnabledToggle(agent)) {
        return;
      }
      setOperatingAgentId(agent.id);
      try {
        await subagentsService.setEnabled({
          agentId: agent.id,
          enabled,
        });
        await Promise.all([refresh(), refreshMentionStore()]);
      } catch (toggleError) {
        toast(toggleError instanceof Error ? toggleError.message : String(toggleError));
      } finally {
        setOperatingAgentId(null);
      }
    },
    [refresh, refreshMentionStore, subagentsService],
  );

  // 覆盖写入分两条通道：内置按稳定 agentName，插件按不含版本的 agent.id。
  // agentName 是协议里的稳定键；插件 id 不含版本，升级换目录后仍能读到同一份覆盖。
  // 两条通道的 payload 不同，但都走 toSubagentModelSelection 归一化模型身份。
  // 用错通道会把覆盖写到另一个 agent 上。
  const handleModelOverrideChange = useCallback(
    async (agent: AgentSummary, config: { model?: string; thoughtLevel?: string }) => {
      const agentName = getBuiltInSubagentName(agent);
      if (!agentName && agent.source !== "plugin") {
        return;
      }
      setOperatingAgentId(agent.id);
      try {
        const modelSelection = toSubagentModelSelection(config.model, config.thoughtLevel);
        if (agentName) {
          await subagentsService.setBuiltInModelOverride({ agentName, modelSelection });
        } else {
          // 稳定 ID 不含插件版本；升级换目录后继续读取同一份用户 Selection 覆盖。
          await subagentsService.setPluginAgentModelOverride({ agentId: agent.id, modelSelection });
        }
      // [失败路径] 写入失败先清 operating 再抛出：让行内控件回滚，同时保留上层的 toast。
      // 抛出是必要的——persistConfig 依赖 reject 触发本地回滚。
      } catch (changeError) {
        toast(changeError instanceof Error ? changeError.message : String(changeError));
        setOperatingAgentId(null);
        throw changeError;
      }
      // 持久化已成功，刷新失败只提示：不能因为投影读取失败就回滚磁盘状态。
      // 此时控件仍会显示服务端返回前的最新本地值，下一次刷新再校正。
      // 与写入失败的区别：写入失败必须 reject，让控件回滚。
      try {
        await Promise.all([refresh(), refreshMentionStore()]);
      } catch (refreshError) {
        // 持久化成功即为提交点；后续投影刷新失败只能提示，不能让控件回滚磁盘状态。
        toast(refreshError instanceof Error ? refreshError.message : String(refreshError));
      } finally {
        setOperatingAgentId(null);
      }
    },
    [refresh, refreshMentionStore, subagentsService],
  );

  // 打开编辑只设置编辑对象，不直接显示表单；isFormView 由 canManage 与对象共同决定。
  // 先隐藏新增表单（showForm=false）再设置编辑对象，避免同帧出现两个标题。
  // canManage 为 false 时即使有 editingAgent 也不进表单，防止越权编辑。
  const handleEdit = useCallback((agent: AgentSummary) => {
    if (!isEditableUserAgent(agent)) {
      return;
    }
    setEditingAgent(agent);
    setShowForm(false);
  }, []);

  // 新建权限：workspace 需要真实路径，user 需要 Host 声明 userScopeAvailable；
  // capability 为空（尚未返回）时视为不可新建，避免在未知能力上暴露写入入口。
  // canManageUserAgents 只看 workspacePath 与 userScopeAvailable，登录态由更上层页面负责。
  // 两者都不是“用户是否登录”，不能混用。
  const canManageUserAgents =
    activeScope === "workspace"
      ? Boolean(targetWorkspacePath)
      : capability?.userScopeAvailable === true;

  // 新建前清空 editingAgent：否则表单会以“编辑”语义打开并携带上一条的初值。
  // 清空与 showForm 同批设置，React 会合并成一次渲染，不会出现中间态。
  // handleAddNew 只清 editingAgent 并打开表单，不调用 list 也不读任何服务端事实。
  const handleAddNew = useCallback(() => {
    if (!canManageUserAgents) {
      return;
    }
    setEditingAgent(null);
    setShowForm(true);
  }, [canManageUserAgents]);

  const handleCancelForm = useCallback(() => {
    setEditingAgent(null);
    setShowForm(false);
  }, []);

  // [权衡] 搜索是纯前端过滤：数据量在几十条量级，服务端搜索会引入分页与竞态。
  // 搜索串统一 trim + lowerCase，与服务端大小写不敏感的口径保持一致。
  // 过滤只读不写：清空搜索立即回到全量，不需要重新请求。
  // 过滤必须同时覆盖 name/description/model/path/scope/source/tools，避免用户搜不到已知配置。
  const filteredAgents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return agents.filter((agent) => {
      // User 页隐藏 workspace agent：它们属于具体项目，混排会让用户误删项目配置。
      // 过滤在搜索之前：先按 scope 收窄，再在收窄集合里匹配关键字。
      // 因此用户区的计数不含项目行，与区块标题一致。
      if (activeScope === "user") {
        if (agent.scope === "workspace") return false;
      } else {
        // Workspace 页只保留该项目自己的 workspace agent；内置 agent 在项目页无意义。
        // 内置行的 scope 是 built-in，不满足 workspace，因此不会出现在项目页。
        // 插件行单独处理：它们可能以 workspace 目录为作用域。
        if (isBuiltInAgent(agent) || agent.scope !== "workspace") return false;
        // 插件 agent 按 projectPath 过滤：同一插件在不同项目可能有不同 profile。
        // projectPath 为空表示尚未绑定项目，此时不展示，避免跨项目串行。
        // 与下一支的 user-source 判断互斥，二者不会同时命中。
        if (agent.source === "plugin" && agent.projectPath !== targetWorkspacePath) return false;
        if (
          agent.source !== "plugin" &&
          agent.projectPath &&
          agent.projectPath !== targetWorkspacePath
        )
          return false;
      }
      if (!normalizedQuery) return true;
      const haystack = [
        agent.name,
        agent.description,
        agent.modelSelection
          ? `${agent.modelSelection.providerId}/${agent.modelSelection.modelId}`
          : undefined,
        agent.path,
        agent.scope,
        agent.source,
        agent.tools?.join(" "),
        agent.disallowedTools?.join(" "),
        agent.skills?.join(" "),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [activeScope, agents, query, targetWorkspacePath]);

  // 分组在过滤之后做：搜索命中数用于显隐区块，先分组再过滤会留下空标题。
  // filteredAgentCount 是三个分组之和，与渲染出来的行数严格一致。
  // 它同时用于“搜索无结果”判定，因此必须排除被 scope 过滤掉的行。
  const groupedAgents = useMemo(() => groupAgentsByScope(filteredAgents), [filteredAgents]);
  // 插件按完整 id 二次分组：一个 marketplace 可以有多个插件，各自成区块。
  const pluginGroups = useMemo(
    () => groupPluginAgentsById(groupedAgents.plugin),
    [groupedAgents.plugin],
  );
  // 图标映射：availablePlugins 提供 listing，plugins 提供已安装实例；
  // 两个 Map 都用 id 键；按 name 建索引会在同名插件上互相覆盖。
  // 映射只在插件数据变化时重建，行渲染期间是纯查表。
  // 两者都可能缺，缺失时退回 Bot 占位。
  const pluginListingById = useMemo(
    () => new Map(availablePlugins.map((plugin) => [plugin.id, plugin.listing])),
    [availablePlugins],
  );
  const pluginIconItemById = useMemo(
    () =>
      new Map(
        plugins.map((plugin) => [
          plugin.id,
          { name: plugin.name, listing: pluginListingById.get(plugin.id) },
        ]),
      ),
    [pluginListingById, plugins],
  );
  // 计数只统计过滤后的结果，与标题旁的数字一致；不能用 agents.length。
  const filteredAgentCount =
    groupedAgents.user.length + groupedAgents.plugin.length + groupedAgents.builtIn.length;
  // editingAgent 可能已被刷新替换（同 id 新对象）：用最新快照渲染表单；
  // 找不到时退回旧对象，保证删除后仍能显示标题。
  const currentEditingAgent = useMemo(() => {
    if (!editingAgent) {
      return null;
    }
    return agents.find((agent) => agent.id === editingAgent.id) ?? editingAgent;
  }, [agents, editingAgent]);
  // 表单视图需要 Host 就绪；未连接时保持在列表视图，避免表单里的 RPC 全部失败。
  // 但表单状态本身不重置：重连后用户仍回到刚才的表单，不需要重新填写。
  // 这也是 isFormView 与 rpcReady 分成两个条件的原因。
  const isFormView = canManageUserAgents && (showForm || currentEditingAgent !== null);

  if (isFormView && targetServiceResolution.rpcReady) {
    // 图标查找优先 pluginId，其次按名称唯一匹配；重名插件不做猜测，直接省略图标。
    // resolveUniquePluginListingByName 返回 undefined 表示重名或无匹配，
    // 此时 PluginStoreAvatar 会退回 Bot 图标，而不是随机选一个。
    return (
      <SettingsUserScopeProvider sourceServerId={settingsSourceServerId}>
        <div className="space-y-6">
          <SettingsBreadcrumbReporter
            items={[
              {
                label:
                  currentEditingAgent?.name ??
                  intl.formatMessage({ id: "settings.subagents.addNew" }),
              },
            ]}
            onSectionSelect={handleCancelForm}
          />
          <div className="space-y-4">
            <div className="space-y-1">
              <h3 className="text-ui-xl font-semibold text-foreground">
                {editingAgent
                  ? intl.formatMessage({ id: "settings.subagents.edit" })
                  : intl.formatMessage({ id: "settings.subagents.addNew" })}
              </h3>
              <p className="text-ui-base text-foreground-subtle">
                {editingAgent
                  ? intl.formatMessage({
                      id: "settings.subagents.editDescription",
                    })
                  : intl.formatMessage({
                      id: "settings.subagents.addDescription",
                    })}
              </p>
            </div>

            <SubagentForm
              initial={currentEditingAgent ?? undefined}
              modelSelectionView={modelSelectionView}
              modelSelectionLoading={modelSelectionLoading}
              modelSelectGroups={subagentModelSelectGroups}
              onManageModels={onManageModels}
              saving={saving}
              onCancel={handleCancelForm}
              onDelete={handleDelete}
              onSave={handleSave}
              scopeKey={selectedScopeKey}
              workspaceTabs={workspaceTabs}
              onScopeKeyChange={setSelectedScopeKey}
            />
          </div>
        </div>
      </SettingsUserScopeProvider>
    );
  }

  // 行列表渲染器：分隔线用独立 1px 元素而不是 border，避免最后一行多一条边。
  // key 用 agent.id 而非 name：同名 agent 可在不同 scope 共存，用 name 会复用错行。
  // 分隔线 aria-hidden：它只是视觉分组，不应进入可访问树。
  const renderAgentList = (items: AgentSummary[]) => (
    <div className="overflow-hidden rounded-xl bg-surface">
      {items.map((agent, index) => (
        <div key={agent.id}>
          {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
          <AgentListRow
            agent={agent}
            pluginIconItem={
              agent.pluginId
                ? pluginIconItemById.get(agent.pluginId)
                : agent.pluginName
                  ? {
                      name: agent.pluginName,
                      listing: resolveUniquePluginListingByName(availablePlugins, agent.pluginName),
                    }
                  : undefined
            }
            // refreshing 期间禁用所有行操作：刷新会替换 agents 数组，操作对象可能已失效。
            // operatingAgentId 只冻结被操作的那一行，用于展示单行 pending。
            // isOperating 取 refreshing 与 operatingAgentId 的或：前者全局冻结，后者只冻被操作那一行。
            isOperating={operatingAgentId === agent.id || refreshing}
            modelGroups={chatModelSelectGroups}
            modelSelectionView={modelSelectionView}
            modelSelectionLoading={modelSelectionLoading}
            modelSelectGroups={subagentModelSelectGroups}
            onModelOverrideChange={handleModelOverrideChange}
            onDelete={handleDelete}
            onEdit={handleEdit}
            onToggle={handleToggle}
          />
        </div>
      ))}
    </div>
  );

  // hasSearchResultEmpty 区分“搜不到”与“本来为空”：前者给搜索提示，后者给创建引导。
  // 若共用一套空态，用户会以为“搜索坏了”或“数据没了”。
  // 判定用 filteredAgentCount 而不是 agents.length，保证与可见行数一致。
  const hasSearchResultEmpty = Boolean(query.trim()) && filteredAgentCount === 0;
  // 渲染优先级：未连接 > 加载中/target 不匹配 > 搜索空态 > 正常分组；四者互斥，
  // 顺序若调换，搜索无结果时会先闪一下“未连接”，观感上像连接掉了。
  // 错误条只在连接就绪后展示：未连接时的错误必然来自上一条连接，展示会误导；
  // error 在每次 loadAgents 开始时清空，因此它只描述“最近一次真实请求”。
  // 模型目录失败与能力受限各自成条：前者不影响列表但会让模型控件不可用，
  // 后者是信息而非错误（Web/远端 Host 可能不支持 user scope 管理）。
  return (
    <div className="space-y-6">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <PluginScopeMenu
            userSourceServerId={settingsSourceServerId}
            align="start"
            selectedScopeKey={selectedScopeKey}
            workspaceTabs={workspaceTabs}
            onScopeKeyChange={setSelectedScopeKey}
          />
          <div className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
          <div className="flex h-7 items-center gap-1 px-3 text-ui-base font-medium text-foreground">
            <span>{intl.formatMessage({ id: "settings.subagents.title" })}</span>
            <span className="text-ui-sm text-foreground-subtle">{filteredAgentCount}</span>
          </div>
        </div>
        <SettingsSearchInput
          containerClassName="w-full sm:ml-auto sm:w-64"
          clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
          value={query}
          onClear={() => setQuery("")}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.subagents.searchPlaceholder",
          })}
        />
      </div>

      {targetServiceResolution.rpcReady && error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          {error}
        </div>
      ) : null}

      {modelSelectionRead.state.status === "error" ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          <span>{intl.formatMessage({ id: "settings.subagents.modelLoadFailed" })}</span>
          <Button type="button" variant="ghost" size="sm" onClick={modelSelectionRead.reload}>
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      ) : null}

      {targetServiceResolution.rpcReady && capability && !capability.userScopeAvailable ? (
        <div className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage({
            id: "settings.subagents.userScopeDesktopOnly",
          })}
        </div>
      ) : null}

      {!targetServiceResolution.rpcReady ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.connecting" })} />
      ) : loading || !projectionMatchesTarget ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      ) : hasSearchResultEmpty ? (
        <PluginSearchEmptyState label={intl.formatMessage({ id: "settings.subagents.empty" })} />
      ) : (
        <div className="space-y-6">
          <section
            className={query.trim() && groupedAgents.user.length === 0 ? "hidden" : "space-y-4"}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SettingsResourceGroupHeader
                count={groupedAgents.user.length}
                title={intl.formatMessage({
                  id: "settings.subagents.group.user",
                })}
              />
              <SettingsResourceHeaderActions
                onRefresh={() => void Promise.all([refresh(), refreshMentionStore()])}
                onNew={canManageUserAgents ? handleAddNew : undefined}
                refreshing={refreshing}
              />
            </div>
            {groupedAgents.user.length > 0 ? (
              renderAgentList(groupedAgents.user)
            ) : (
              <PluginInstallEmptyState
                title={intl.formatMessage({ id: "settings.subagents.empty" })}
                description={intl.formatMessage({
                  id: "settings.subagents.addDescription",
                })}
                actions={
                  canManageUserAgents ? (
                    <Button type="button" variant="default" size="lg" onClick={handleAddNew}>
                      <Plus data-icon="inline-start" aria-hidden="true" />
                      {intl.formatMessage({ id: "settings.create.action" })}
                    </Button>
                  ) : null
                }
              />
            )}
          </section>
          {pluginGroups.map(([pluginId, items]) => (
            <section key={pluginId} className="space-y-4">
              <SettingsResourceGroupHeader
                count={items.length}
                title={resolvePluginDisplayName(
                  {
                    name: items[0]?.pluginName ?? pluginId,
                    listing:
                      (items[0]?.pluginId ? pluginListingById.get(items[0].pluginId) : undefined) ??
                      resolveUniquePluginListingByName(
                        availablePlugins,
                        items[0]?.pluginName ?? pluginId,
                      ),
                  },
                  locale,
                )}
              />
              {renderAgentList(items)}
            </section>
          ))}
          {groupedAgents.builtIn.length > 0 ? (
            <section className="space-y-4">
              <SettingsResourceGroupHeader
                count={groupedAgents.builtIn.length}
                title={intl.formatMessage({
                  id: "settings.subagents.group.builtIn",
                })}
              />
              {renderAgentList(groupedAgents.builtIn)}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
