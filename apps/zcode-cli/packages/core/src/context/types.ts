/**
 * ============================================================================
 * context/types.ts —— Context Prefix 的类型契约
 * ============================================================================
 * 每个 ContextSection 描述"一段系统提示来自哪里、注入到哪、是否稳定":
 *   source          来源标识(cli_prefix/identity/env/skills/memory/...);
 *   injectionTarget system(系统消息)或 meta_user(用户上下文附件);
 *   cacheHint       stable(可缓存)或 dynamic(每轮 fresh);
 *   chars/tokens    诊断与预算用。
 * 注意:ContextSource 是封闭枚举,新增 section 必须同时更新这里与 builder。
 * ============================================================================
 */
// ============================================================
// Context Builder Types
// ============================================================

import type {
  EnvInfo,
  Model,
  ModelInputMessage,
  ProjectContext,
  ResolvedUserInstructions,
  SkillLoadOutcome,
  UserInstructionsOptions,
} from "@zcode/contracts";
import type { AutoCompactPolicyConfig } from "../compact/index.js";
import type { AgentProfile } from "../subagent/profile.js";

export type {
  EnvInfo,
  PackageManager,
  ProjectContext,
  ProjectType,
  ResolvedUserInstructionSource,
  ResolvedUserInstructions,
  UserInstructionsOptions,
} from "@zcode/contracts";

// -----------------------------------------------
// Context Source
// -----------------------------------------------

/**
 * section 来源的封闭枚举：新增来源必须同时更新这里、builder 与消费方，
 * 否则诊断与缓存口径会缺字段。各成员的语义见行尾注释。
 * 该类型只描述"来自哪里"，不决定注入位置或缓存稳定性。
 */
export type ContextSource =
  | "cli_prefix" // CLI / 产品身份前缀
  | "identity" // Agent 基础描述
  | "env_info" // 环境信息 (cwd, platform, git repo boolean)
  | "system_context" // git snapshot context
  | "skills" // 可用 skills
  | "tools" // 工具定义
  | "request_user_context" // request-level user context provider-visible 组合块
  | "memory" // 长期 memory read path
  | "current_date" // 当前日期
  | "custom_system_prompt" // 自定义 stable system body
  | "workflow_actor_identity" // 动态工作流子代理身份：契约 + persona 叠加
  | "subagent_agent_prompt" // 子 agent 专属身份/任务 prompt
  | "subagent_notes" // 子 agent 通用操作提醒
  | "subagent_environment" // 子 agent 环境和模型上下文
  | "dynamic_behavior" // 动态行为边界
  | "session_guidance" // 当前可用内置能力指导
  | "output_style" // 输出风格
  | "context_management" // 长上下文管理提示
  | "desktop_context"; // ZCode Desktop 渲染与交互协议

export type ContextInjectionTarget = "system" | "meta_user";

export type ContextCacheHint = "stable" | "dynamic";

export type PresentationSurface = "terminal" | "zcode_desktop";

// -----------------------------------------------
// Context Section
// -----------------------------------------------

/**
 * 单段上下文的结构化描述，由各 section builder 产出，builder 只读不改。
 * 口径：injectionTarget 决定进 system 还是 meta_user；cacheHint 决定是否可长期缓存；
 * chars/tokens 是估算值（token 用 estimateTokens），只用于诊断与预算，不是计费事实。
 * 不变量：stable 段不得包含随请求变化的内容（如日期、模型名、git 状态）。
 */
export interface ContextSection {
  name: string; // 人类可读的 section 名称
  source: ContextSource; // 来源标识
  injectionTarget: ContextInjectionTarget; // 注入位置
  cacheHint: ContextCacheHint; // 缓存稳定性提示
  chars: number; // 字符数
  tokens: number; // 估算 token 数
  content: string; // 完整内容
  preview: string; // 前 100 字符预览
}

export type ContextMetaUserAttachmentSource = "skills_listing" | "context_prefix";

/**
 * meta user 附件：builder 只产出内容，历史层再包成 system-reminder。
 * source 决定附件类别（技能清单 vs 其余上下文），content 为已拼接正文。
 */
export interface ContextMetaUserAttachment {
  source: ContextMetaUserAttachmentSource;
  content: string;
}

// -----------------------------------------------
// Context Build Result
// -----------------------------------------------

/**
 * 一次 build 的完整产物。
 * sections 是排序后的诊断视图；systemMessages 可直接下发；
 * metaUserAttachments 尚未包裹 system-reminder，由历史层负责包装。
 * totalChars/totalTokens 为全量估算，仅供观测，不参与请求预算。
 */
export interface ContextBuildResult {
  sections: ContextSection[];
  totalChars: number;
  totalTokens: number;
  systemMessages: ModelInputMessage[]; // ContextBuilder 只组装 system messages
  metaUserAttachments: ContextMetaUserAttachment[]; // 未包裹 <system-reminder> 的 meta user body
}

export interface OutputStylePromptConfig {
  name: string;
  prompt: string;
  keepCodingInstructions?: boolean;
}

// -----------------------------------------------
// Context Builder Config
// -----------------------------------------------

/**
 * builder 的输入配置。
 * 口径：envInfo/model/currentDate 等来自当步解析结果，不是全局缓存；
 * workflowActor 与 customSystemPrompt 互斥；可选字段缺席表示"该来源不存在"，
 * 对应 section 跳过而不是注入空段。配置变化由 runtime 决定何时重建前缀。
 */
export interface ContextBuilderConfig {
  workingDirectory: string;
  additionalDirectories?: readonly string[];
  envInfo: EnvInfo;
  /** 当前步骤的执行对象，不进入 Context Source 或持久化环境快照。 */
  model?: Model;
  presentationSurface?: PresentationSurface;
  genUiOutputDirectory?: string;
  currentDate?: string;
  userInstructions?: ResolvedUserInstructions;
  projectContext?: ProjectContext;
  memoryRoot?: string;
  memoryIndexContent?: string;
  skills?: SkillLoadOutcome;
  agentProfiles?: readonly AgentProfile[];
  embeddedSearchEnabled?: boolean;
  skillMetadataBudget?: number;
  customSystemPrompt?: string;
  /**
   * 动态工作流子代理（workflow child）的身份输入。在场即走 builder 的第三条路径：
   * 基座段（CLI prefix、安全行、Harness、memory）+ 工作流子代理契约 + persona 叠加，
   * 而不是像 `customSystemPrompt` 那样整段替换。与 `customSystemPrompt` 互斥。
   */
  workflowActor?: WorkflowActorContext;
  language?: string;
  outputStyle?: OutputStylePromptConfig;
  compact?: AutoCompactPolicyConfig;
  guidanceToolNames?: readonly string[];
}

/**
 * 工作流子代理的身份输入：有效名（匿名缺席）、作者写的 persona system prompt（可缺席）。
 * 没有工具档位：每个子代理都有完整工作工具集，契约只有一份文本。
 */
export interface WorkflowActorContext {
  name?: string;
  persona?: string;
}

export type ContextUserInstructionsRequest = UserInstructionsOptions;
