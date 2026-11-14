// ============================================================
// Skill Contracts - reusable local instruction packs
// ============================================================
// 生产方：adapters/src/skills 的 SkillPort 扫描 roots（按 priority 升序、同名先到先得）并解析
// SKILL.md frontmatter；消费方：core 的 Skill 工具与 system prompt 构建。
// 关键边界：发现阶段只产出 metadata（名称/描述/路径），正文只在 loadSkill 时按 maxBytes 读取
// 并可能截断；telemetry 只允许携带最小身份字段，正文/description 不得逃逸。
// `safeToAutoLoad` 决定能否被自动注入提示，未声明或来源不可信时按 fail-closed 处理。

import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

// 技能来源层级：project/user/system/admin。它描述技能存放在哪一层，不表达优先级；
// 同名技能由 SkillRoot.priority 决定谁胜出。admin 层通常由托管安装注入，不属于用户可写目录。
export type SkillScope = "project" | "user" | "system" | "admin";

// 技能产出来源：agents（`.agents` 约定目录）、zcode（ZCode 自有目录）、bundled（随包内置）、
// plugin（插件携带）、remote（远端拉取）。与 scope 正交，只用于 provenance/展示与诊断；
// 不参与加载优先级，也不单独授予自动加载资格。
export type SkillSource = "agents" | "zcode" | "bundled" | "plugin" | "remote";

// 诊断级别：warning 表示跳过该技能/该根但整体仍可用；error 表示该技能不可用。
// 稳定判别字段，调用方按 severity 处理，不得解析 message 文案。
export type SkillDiagnosticSeverity = "warning" | "error";

// 稳定的技能诊断码，跨进程/日志可长期依赖；message 仅供人读。`skill_too_large` 与
// `skill_duplicate_name` 的成型条件分别由 adapter（读取上限）与发现顺序（先到先得）决定，
// 不是契约层自行判定的；新增码必须同步 adapter 与 UI 文案。
export type SkillDiagnosticCode =
  | "skill_root_not_found"
  | "skill_scan_failed"
  | "skill_read_failed"
  | "skill_missing_frontmatter"
  | "skill_invalid_frontmatter"
  | "skill_missing_name"
  | "skill_invalid_name"
  | "skill_missing_description"
  | "skill_description_too_long"
  | "skill_unknown_frontmatter"
  | "skill_duplicate_name"
  | "skill_too_large"
  | "skill_not_found";

// 一个待扫描的技能根。`priority` 越小越先扫描，同名先出现者胜出；`namespace` 只用于附加目录的
// 命名限定（避免冲突），不是项目身份。`pluginId` 仅 plugin root 可用，是完整插件身份
//（`name@marketplace`），用于 provenance 回溯；`path` 必须是绝对路径。
export interface SkillRoot {
  /** 附加目录能力的目录限定名；不是项目身份。 */
  namespace?: string;
  path: string;
  scope: SkillScope;
  source: SkillSource;
  priority: number;
  /** 所属 plugin 的完整 id；仅 plugin root 可用。 */
  pluginId?: string;
}

// 技能策略：当前只有 `allowImplicitInvocation`，控制是否允许模型在未显式调用 Skill 工具时
// 自动采纳该技能；未声明时由上层按默认策略处理。该字段来自 frontmatter，不是权限授予。
export interface SkillPolicy {
  allowImplicitInvocation?: boolean;
}

// 技能发现结果，只含元数据、不含正文。`description`/`whenToUse` 用于模型选择技能；
// `pluginName` 是插件基名（展示用），`pluginId` 才是完整身份；`qualifiedName` 是带命名空间的
// 运行时名（`name:skill`），非 plugin skill 可能缺省。
// `path`/`directory`/`rootPath` 是宿主内路径，`frontmatterKeys` 供诊断；`safeToAutoLoad`
// 决定能否被自动注入提示，false 时必须等显式调用。该结构可跨进程传递。
export interface SkillMetadata {
  name: string;
  description: string;
  whenToUse?: string;
  pluginName?: string;
  /** 所属 plugin 的完整 id；非 plugin skill 不设置。 */
  pluginId?: string;
  qualifiedName?: string;
  path: string;
  directory: string;
  rootPath: string;
  scope: SkillScope;
  source: SkillSource;
  safeToAutoLoad: boolean;
  frontmatterKeys: string[];
  policy?: SkillPolicy;
}

// 遥测白名单：只允许 name/qualifiedName/pluginId/source 这类身份字段跨边界，
// 正文、description、whenToUse、路径一律不进入 telemetry，避免用户内容与宿主路径外泄。
// 字段均可缺省——遥测不因缺少身份而降级为失败。
/** Skill tool result 中允许跨边界传播的最小 metadata；不包含正文或 description。 */
export interface SkillTelemetryMetadata {
  /** 实际解析的技能原始名称；不限插件来源。 */
  name?: string;
  qualifiedName?: string;
  pluginId?: string;
  source?: SkillSource;
}

// 单条诊断。`code`/`severity` 机器可判别，`message` 仅供人读；`path` 与 `skillName` 可能缺省
//（根级扫描失败时只有 path）。诊断随 discover/load 结果返回，不持久化为会话事件。
export interface SkillDiagnostic {
  code: SkillDiagnosticCode;
  severity: SkillDiagnosticSeverity;
  message: string;
  path?: string;
  skillName?: string;
}

// 一次发现的结果。`skills` 已按 name 排序并剔除同名重复；`totalDiscovered` 统计通过解析的
// 候选数（含被同名丢弃者），可能大于 skills 长度，不能当作可用技能数。
// 单条失败只产出 diagnostic，不中断整体扫描。
export interface SkillLoadOutcome {
  skills: SkillMetadata[];
  diagnostics: SkillDiagnostic[];
  totalDiscovered: number;
}

// `loadSkill` 的返回值。`content` 是正文（已剥离 frontmatter）；`baseDirectory` 是正文中相对
// 路径的解析基准，跨进程消费方必须带上它，不能自行推断。`bytesRead` 是实际读入字节数
//（截断时等于 maxBytes），`sizeBytes` 是完整大小，`truncated` 由二者比较得出——
// 截断只保留前 maxBytes 字节，调用方不能假设拿到完整技能。
export interface SkillContent {
  metadata: SkillMetadata;
  content: string;
  baseDirectory: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
}

// `roots` 省略时由适配器按 workingDirectory 解析默认根；显式传入必须给绝对路径。
// `trace` 仅用于日志关联，不改变发现结果，也不跨进程持久化。
export interface SkillDiscoverRequest {
  workingDirectory: string;
  roots?: SkillRoot[];
  trace?: TraceContext;
}

// 按 name 加载技能；name 由适配器归一化，`maxBytes` 覆盖缺省读取上限。`roots` 语义与 discover
// 相同。未找到时抛错而不是返回空结果；load 会重新执行发现，因此诊断也会被重算。
export interface SkillLoadRequest {
  name: string;
  workingDirectory: string;
  roots?: SkillRoot[];
  maxBytes?: number;
  trace?: TraceContext;
}

// 通用操作选项：`signal` 在扫描/读取边界检查用于中止，`context` 供日志与追踪。
// 中止是协作式的，单次文件读取不会被立即打断，调用方不应依赖即时取消。
export interface SkillOperationOptions {
  signal?: AbortSignal;
  context?: ExecutionContext;
}

// 技能端口的唯一契约：discover 只返回元数据，load 返回正文与 baseDirectory。
// 实现方负责根解析、frontmatter 校验、同名先到先得与 maxBytes 截断；调用方不得绕过 Port
// 直接读技能文件，否则会跳过命名空间与安全校验。
export interface SkillPort {
  discoverSkills(
    request: SkillDiscoverRequest,
    options?: SkillOperationOptions,
  ): Promise<SkillLoadOutcome>;
  loadSkill(request: SkillLoadRequest, options?: SkillOperationOptions): Promise<SkillContent>;
}

// 技能配置（合并结果）：`enabled` 是全局开关，`includeInstructions` 决定是否把技能说明注入
// system prompt，`metadataBudget` 限制注入的元数据体量（不是正文字节上限），`roots` 是用户
// 附加的技能根。该结构可持久化，不包含技能正文。
export interface SkillConfig {
  enabled: boolean;
  includeInstructions: boolean;
  metadataBudget: number;
  roots: string[];
}
