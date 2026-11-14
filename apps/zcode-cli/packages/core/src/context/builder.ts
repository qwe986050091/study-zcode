/**
 * ============================================================================
 * context/builder.ts —— Context Prefix(系统提示)组装
 * ============================================================================
 *
 * 【产物】
 *   ContextBuildResult:
 *     sections            所有已组装 section(带 chars/tokens/preview,便于诊断)
 *     systemMessages      注入 system role 的消息(stable/dynamic 分开缓存)
 *     metaUserAttachments 注入 meta user 的附件(skills 列表与一般上下文)
 *
 * 【组装顺序】
 *   1. CLI/product prefix(短身份,仅主 agent);
 *   2. 稳定身份:customSystemPrompt / workflowActor / 默认 identity(三选一);
 *   3. 动态 system 段:desktop、Dynamic Behavior、Session Guidance、Memory、Env、
 *      Output Style、Context Management、Git 上下文;
 *   4. Skills(仅当 Skill 工具可用);
 *   5. meta user 上下文(用户指令/项目记忆)与当前日期;
 *   6. 自定义 sections。
 *
 * 【缓存策略】
 *   stable → 单独一条 system 消息并标记 cacheControl(可长期缓存);
 *   dynamic → 另一条 system 消息(fresh 计算);顺序固定,避免破坏缓存前缀。
 * ============================================================================
 */
// ============================================================
// Context Builder - System prompt assembly
// ============================================================

import type { ModelInputMessage } from "@zcode/contracts";
import type {
  ContextMetaUserAttachment,
  ContextSection,
  ContextBuildResult,
  ContextBuilderConfig,
  EnvInfo,
} from "./types.js";
import type { ToolRegistry } from "../tool/registry.js";
import { estimateTokens } from "./utils.js";
import { buildCliPrefixSection } from "./sections/cli-prefix.js";
import { buildIdentitySection } from "./sections/identity.js";
import { buildWorkflowActorIdentitySection } from "./sections/workflow-actor.js";
import { buildEnvInfoSection, buildGitSystemContextSection } from "./sections/env-info.js";
import { buildSkillsSection } from "./sections/skills.js";
import { buildRequestUserContextSection } from "./sections/request-user-context.js";
import { buildCurrentDateSection } from "./sections/current-date.js";
import { buildMemorySection } from "./sections/memory.js";
import { ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH } from "../memory/project-memory-retrieval-branch.js";
import { buildDesktopContextSection } from "./sections/desktop.js";
import {
  buildContextManagementSection,
  buildDynamicBehaviorSection,
  buildOutputStyleSection,
  buildSessionGuidanceSection,
} from "./dynamic-sections.js";

// -----------------------------------------------
// Context Builder
// -----------------------------------------------

const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" as const };
/** Skill 工具的注册名（与 tool/handlers/skill.ts 的 metadata.name 同字面；contracts 没有常量）。 */
const SKILL_TOOL_NAME = "Skill";

/**
 * Context Prefix 组装器：把配置里的各来源 section 拼成 system 消息与 meta user 附件。
 *
 * 输入：ContextBuilderConfig（env/model/skills/memory/date/userInstructions 等）；
 * 输出：ContextBuildResult（有序 sections + 统计 + 两类消息产物）。
 * 副作用：纯内存组装，不读盘、不调模型；build 可重复调用，产出随 config 变化。
 * 失败语义：仅 workflowActor 与 customSystemPrompt 同时出现时抛错（接线错误）；
 * 其余缺席来源按段跳过，不生成空标题。
 * 不变量：stable/dynamic 分区顺序固定，stable 段决定 provider 前缀缓存命中。
 */
export class ContextBuilder {
  private config: ContextBuilderConfig;
  private customSections: ContextSection[] = [];

  /**
   * 保存配置引用；调用方后续 setEnvInfo 或改 config 后再 build。
   * config 为可变对象，builder 不克隆，也不触发任何 I/O。
   */
  constructor(config: ContextBuilderConfig) {
    this.config = config;
  }

  /**
   * 保留兼容入口。工具说明由 model request 的 tools 字段承载，不再镜像进 system prompt。
   * 输入 registry 被忽略；返回 this 仅用于链式调用，不改变组装结果。
   */
  setToolRegistry(_registry: ToolRegistry): this {
    return this;
  }

  /**
   * 替换环境事实并返回 this；下一轮 build 的 env/system context 立即反映新值。
   * 只做浅合并，不校验字段；envInfo 变化只会让 dynamic 段失效，不影响 stable 前缀。
   */
  setEnvInfo(envInfo: EnvInfo): this {
    this.config = {
      ...this.config,
      envInfo,
    };
    return this;
  }

  /**
   * 添加自定义 section（用于后续扩展）
   * 缺省注入 system + dynamic；自动计算 chars/tokens，并保留 content 前 100 字符预览。
   * 输入 content 为空也不会被丢弃，由调用方保证语义；返回 this 供链式调用。
   */
  addSection(
    section: Omit<ContextSection, "chars" | "tokens" | "injectionTarget" | "cacheHint"> &
      Partial<Pick<ContextSection, "injectionTarget" | "cacheHint">>,
  ): this {
    this.customSections.push({
      ...section,
      injectionTarget: section.injectionTarget ?? "system",
      cacheHint: section.cacheHint ?? "dynamic",
      chars: section.content.length,
      tokens: estimateTokens(section.content),
    });
    return this;
  }

  /**
   * 构建 Context Prefix。
   * 注意:customSystemPrompt 会跳过默认 system 体系与 systemContext(而不是只替换正文),
   * 避免用户自定义提示后仍混入 Session Guidance / output style 等动态段。
   * 输入：当前 config（含 workflowActor/customSystemPrompt 互斥约束）。
   * 输出：按注入顺序排好的 sections、统计与 system/meta_user 产物；可重复调用。
   * 副作用：仅内存计算；不读盘、不写历史、不调模型。
   * 失败语义：workflowActor 与 customSystemPrompt 同时出现时抛错（接线错误），
   * 其它可选来源缺席则跳过对应段。
   * 不变量：build 不做缓存失效判断；stable 段内容不变时前缀缓存才可能命中。
   */
  build(): ContextBuildResult {
    const sections: ContextSection[] = [];
    const activeOutputStyle = this.config.outputStyle?.prompt.trim()
      ? this.config.outputStyle
      : undefined;
    const customSystemPrompt = this.config.customSystemPrompt?.trim();
    const hasCustomSystemPrompt = Boolean(customSystemPrompt);
    // 工作流子代理身份：第三条路径。与
    // customSystemPrompt 互斥——两者同在只可能是接线错误（persona 该经 workflowActor 进来，
    // 不该再塞 systemPrompt），大声失败而不是默默二选一。
    const workflowActor = this.config.workflowActor;
    if (workflowActor !== undefined && hasCustomSystemPrompt) {
      throw new Error(
        "ContextBuilder: workflowActor and customSystemPrompt are mutually exclusive",
      );
    }
    const isWorkflowActor = workflowActor !== undefined;

    // 1. CLI / product prefix:短身份块,只给主 agent;
    //    workflowActor(脚本专属子代理)不适用"交互式 coding agent"身份,因此跳过。
    if (!isWorkflowActor) {
      sections.push(buildCliPrefixSection());
    }

    // 2. 稳定身份三选一:
    //    customSystemPrompt(用户完全接管) > workflowActor(工作流子代理身份) > 默认 identity。
    //    互斥是硬约束:两者同时出现说明接线错误,直接抛错而不是静默二选一。
    if (hasCustomSystemPrompt) {
      sections.push(
        createSection({
          name: "Custom System Prompt",
          source: "custom_system_prompt",
          injectionTarget: "system",
          cacheHint: "stable",
          content: customSystemPrompt ? `\n${customSystemPrompt}` : "",
        }),
      );
    } else if (workflowActor !== undefined) {
      sections.push(buildWorkflowActorIdentitySection(workflowActor));
    } else {
      sections.push(buildIdentitySection(activeOutputStyle));
    }

    // 3. Dynamic system context
    // custom prompt 不是只替换
    // stable body，而是跳过默认 system prompt 体系和 systemContext；否则用户提供
    // custom prompt 后仍会混入 Session Guidance / output style 等动态 system 段。
    // 工作流子代理跳过其中面向「与用户对话」的三段（desktop、Dynamic Behavior、session
    // guidance——契约里已把 Report outcomes faithfully 搬过去），保留 memory 与其后各段。
    if (!hasCustomSystemPrompt) {
      // 3a. Desktop 渲染与交互协议:只在 zcode_desktop 表面注入,terminal 不需要。
      if (!isWorkflowActor && this.config.presentationSurface === "zcode_desktop") {
        sections.push(buildDesktopContextSection(this.config.genUiOutputDirectory));
      }

      // 3b. Dynamic Behavior:沟通规范、自主性边界、不可逆操作确认。
      if (!isWorkflowActor) {
        sections.push(buildDynamicBehaviorSection());
      }

      // 3c. Session Guidance:按当前工具表生成(如 Skill 使用指引);无内容则不注入。
      const sessionGuidanceSection = isWorkflowActor
        ? null
        : buildSessionGuidanceSection(
            this.config.guidanceToolNames ?? [],
            (this.config.skills?.skills.length ?? 0) > 0,
          );
      if (sessionGuidanceSection) {
        sections.push(sessionGuidanceSection);
      }

      // 3d. Memory:项目长期记忆索引;仅在配置了 memoryRoot 时注入。
      if (this.config.memoryRoot) {
        const memorySection = buildMemorySection(
          this.config.memoryRoot,
          ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
        );
        if (memorySection) {
          sections.push(memorySection);
        }
      }
      // 3e. Env Info:平台/cwd/工作区/额外目录等环境事实(每次请求都可能变化)。
      sections.push(
        buildEnvInfoSection(
          this.config.envInfo,
          this.config.model,
          this.config.additionalDirectories,
        ),
      );

      // 3f. Output Style:用户选择的输出风格(为空则不注入)。
      const outputStyleSection = buildOutputStyleSection(activeOutputStyle);
      if (outputStyleSection) {
        sections.push(outputStyleSection);
      }

      // 3g. Context Management:告诉模型长会话会 compact,以及继续工作的边界。
      sections.push(buildContextManagementSection());

      // 3h. Git 上下文:当前仓库/branch/dirty 状态等(可能为空)。
      const gitSystemContextSection = buildGitSystemContextSection(this.config.envInfo);
      if (gitSystemContextSection) {
        sections.push(gitSystemContextSection);
      }
    }

    // 4. Skills:仅当本轮确实注册了 Skill 工具时才注入清单,
    //    否则会告诉模型一个它并不拥有的能力。
    if (this.config.skills && this.skillToolAvailable()) {
      const skillsSection = buildSkillsSection({
        outcome: this.config.skills,
        metadataBudget: this.config.skillMetadataBudget,
      });
      if (skillsSection) {
        sections.push(skillsSection);
      }
    }

    // 5. Meta user context: workspace instructions/project memory first, date second.
    const requestUserContextSection = buildRequestUserContextSection({
      userInstructions: this.config.userInstructions,
      memoryIndexContent: this.config.memoryIndexContent,
      memoryRoot: this.config.memoryRoot,
    });
    if (requestUserContextSection) {
      sections.push(requestUserContextSection);
    }

    const currentDateSection = buildCurrentDateSection(this.config.currentDate);
    if (currentDateSection) {
      sections.push(currentDateSection);
    }

    // 6. Custom sections
    sections.push(...this.customSections);

    const orderedSections = orderSectionsForInjection(sections);

    // 计算总计
    const totalChars = orderedSections.reduce((sum, s) => sum + s.chars, 0);
    const totalTokens = orderedSections.reduce((sum, s) => sum + s.tokens, 0);

    const systemMessages = this.assembleSystemMessages(orderedSections);
    const metaUserAttachments = this.assembleMetaUserAttachments(orderedSections);

    return {
      sections: orderedSections,
      totalChars,
      totalTokens,
      systemMessages,
      metaUserAttachments,
    };
  }

  /**
   * Skill 工具可用性口径：未提供 guidanceToolNames 视为未知，按可用处理；
   * 显式列表则必须包含 Skill。仅影响 skills 清单是否注入。
   */
  private skillToolAvailable(): boolean {
    const names = this.config.guidanceToolNames;
    return names === undefined || names.includes(SKILL_TOOL_NAME);
  }

  /**
   * 组装 system role 消息:按 cli_prefix → stable → dynamic 分成最多三条消息。
   * stable/dynamic 分别带 ephemeral cacheControl,保证缓存命中不因动态内容变化而失效。
   * 输入：已排序 sections；输出最多三条 system 消息（cli_prefix/stable/dynamic）。
   * cli_prefix 不带 cacheControl；stable 与 dynamic 各带 ephemeral。
   * dynamic 正文前置空行，与 stable 正文形成明确边界（所有 provider 一致）。
   * 空消息不下发；section 顺序由 orderSectionsForInjection 保证。
   */
  private assembleSystemMessages(sections: ContextSection[]): ModelInputMessage[] {
    const messages: ModelInputMessage[] = [];

    const cliPrefixContent = buildSectionContent(
      sections.filter(
        (section) => section.injectionTarget === "system" && section.source === "cli_prefix",
      ),
    );
    if (cliPrefixContent) {
      messages.push({
        role: "system",
        content: cliPrefixContent,
      });
    }

    const stableBodyContent = buildSectionContent(
      sections.filter(
        (section) =>
          section.injectionTarget === "system" &&
          section.cacheHint === "stable" &&
          section.source !== "cli_prefix",
      ),
    );
    if (stableBodyContent) {
      messages.push({
        role: "system",
        content: stableBodyContent,
        cacheControl: EPHEMERAL_CACHE_CONTROL,
      });
    }

    const dynamicSystemContent = buildSectionContent(
      sections.filter(
        (section) => section.injectionTarget === "system" && section.cacheHint === "dynamic",
      ),
    );
    if (dynamicSystemContent) {
      messages.push({
        role: "system",
        // ZCode by design：Main Agent 的 dynamic system block 自带左边界，所有 provider 保持一致。
        content: `\n\n${dynamicSystemContent}`,
        cacheControl: EPHEMERAL_CACHE_CONTROL,
      });
    }

    return messages;
  }

  /**
   * 组装 meta user 附件:
   *   skills_listing  技能清单(单独一条,便于 ToolSearch 与技能门控);
   *   context_prefix  其余 meta 上下文(用户指令、项目记忆等)。
   * 输入：已排序 sections；输出 0~2 条附件（技能清单优先，其余合并为 context_prefix）。
   * 纯映射，不排序也不裁剪；空内容不产生附件。
   * 附件在历史层会被包成 system-reminder，而不是 user 发言。
   */
  private assembleMetaUserAttachments(sections: ContextSection[]): ContextMetaUserAttachment[] {
    const attachments: ContextMetaUserAttachment[] = [];

    const skillsContent = buildSkillsMetaUserBody(
      sections.filter(
        (section) => section.injectionTarget === "meta_user" && section.source === "skills",
      ),
    );
    if (skillsContent) {
      attachments.push({
        source: "skills_listing",
        content: skillsContent,
      });
    }

    const contextContent = buildContextMetaUserBody(
      sections.filter(
        (section) => section.injectionTarget === "meta_user" && section.source !== "skills",
      ),
    );
    if (contextContent) {
      attachments.push({
        source: "context_prefix",
        content: contextContent,
      });
    }

    return attachments;
  }
}

/**
 * 注入顺序固定为 system(stable → dynamic)后 meta_user(stable → dynamic):
 * 先稳定后动态,保证缓存前缀尽量长、动态内容尽量靠后。
 * 输入任意 section 集合，输出新数组（不修改入参）。
 * 不在四类的 section 会被丢弃，调用方需保证 injectionTarget/cacheHint 合法。
 * 这是缓存口径的硬约束：调整顺序会改变 provider 前缀，需同步阅读大纲。
 */
function orderSectionsForInjection(sections: ContextSection[]): ContextSection[] {
  return [
    ...sections.filter(
      (section) => section.injectionTarget === "system" && section.cacheHint === "stable",
    ),
    ...sections.filter(
      (section) => section.injectionTarget === "system" && section.cacheHint === "dynamic",
    ),
    ...sections.filter(
      (section) => section.injectionTarget === "meta_user" && section.cacheHint === "stable",
    ),
    ...sections.filter(
      (section) => section.injectionTarget === "meta_user" && section.cacheHint === "dynamic",
    ),
  ];
}

/**
 * 把 meta_user 段包装成模型可见的上下文附件正文：
 * 固定引导语 + 各 section 内容 + "may or may not be relevant" 免责行。
 * 空数组返回 null；不排序、不去重，由 builder 先排序再传入。
 */
export function buildContextMetaUserBody(sections: ContextSection[]): string | null {
  if (sections.length === 0) return null;

  return [
    "As you answer the user's questions, you can use the following context:",
    buildSectionContent(sections),
    "",
    "      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.",
  ].join("\n");
}

/**
 * 技能清单附件正文：只拼接 section 内容，不额外加引导/免责语。
 * 内容为空返回 null；清单顺序沿用 builder 的 stable→dynamic 排序。
 */
export function buildSkillsMetaUserBody(sections: ContextSection[]): string | null {
  const content = buildSectionContent(sections);
  if (!content) {
    return null;
  }

  return content;
}

/**
 * 以空行连接 section 正文；空数组返回空串。
 * 纯字符串拼接，不做长度预算或截断。
 */
function buildSectionContent(sections: ContextSection[]): string {
  return sections.map((section) => section.content).join("\n\n");
}

/**
 * 由调用方给定的元信息构造 ContextSection，并补齐 chars/tokens/preview。
 * 输入 content 原样保留（含前导换行）；preview 固定取前 100 字符。
 * 不校验 source/injectionTarget 组合，合法性由调用方负责。
 */
function createSection(input: {
  name: string;
  source: ContextSection["source"];
  injectionTarget: ContextSection["injectionTarget"];
  cacheHint: ContextSection["cacheHint"];
  content: string;
}): ContextSection {
  return {
    ...input,
    chars: input.content.length,
    tokens: estimateTokens(input.content),
    preview: input.content.slice(0, 100),
  };
}

// -----------------------------------------------
// Factory
// -----------------------------------------------

/**
 * ContextBuilder 的工厂入口；等价于 new ContextBuilder(config)。
 * 返回新实例，不缓存；同一 config 多次创建互不共享 customSections。
 */
export function createContextBuilder(config: ContextBuilderConfig): ContextBuilder {
  return new ContextBuilder(config);
}
