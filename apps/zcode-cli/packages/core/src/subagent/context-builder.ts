import type { Model, ModelInputMessage } from "@zcode/contracts";
import { ContextBuilder } from "../context/builder.js";
import {
  buildContextMetaUserBody,
  buildSkillsMetaUserBody,
  type ContextBuilderConfig,
  type ContextBuildResult,
  type ContextSection,
  type EnvInfo,
} from "../context/index.js";
import { buildCliPrefixSection } from "../context/sections/cli-prefix.js";
import { buildCurrentDateSection } from "../context/sections/current-date.js";
import { buildRequestUserContextSection } from "../context/sections/request-user-context.js";
import { buildSkillsSection } from "../context/sections/skills.js";
import { estimateTokens } from "../context/utils.js";
import { buildSubagentCommonNotes, buildSubagentEnvironmentContext } from "./system-prompt.js";

// 子 agent 上下文构建配置；字段口径与父 ContextBuilderConfig 保持一致。
export interface SubagentContextBuilderConfig {
  // 子 agent 的系统提示词正文；空串表示不产出 agent prompt 段（不占缓存块）。
  agentPrompt: string;
  // 当前日期字符串（已格式化）；undefined 时不注入日期段。
  currentDate?: string;
  // 环境信息，必须提供；workingDirectory 由 envInfo.cwd 派生。
  envInfo: EnvInfo;
  // 当前模型；undefined 时环境段省略 “powered by the model” 一行。
  model?: Model;
  // Skill 元数据 token 预算；undefined 时 skills 段使用默认预算。
  skillMetadataBudget?: number;
  // Skill 列表快照；undefined 时不构建 skills 段。
  skills?: ContextBuilderConfig["skills"];
  // 用户自定义指令；undefined/空时 request-user-context 段不产出。
  userInstructions?: ContextBuilderConfig["userInstructions"];
}

// 所有 system/meta_user 段落统一使用 ephemeral 缓存标记，保持与父会话断点策略一致。
const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" as const };

// 子 agent 专用的上下文构建器：复用父 ContextBuilder 的配置化能力，
// 但以子 agent 的 prompt、Notes、Environment 三段替换父级 system 段顺序。
// 无状态副作用，仅保存配置；setEnvInfo 返回 this 以支持链式调用。
export class SubagentContextBuilder extends ContextBuilder {
  private subagentConfig: SubagentContextBuilderConfig;

  constructor(config: SubagentContextBuilderConfig) {
    super(toBaseContextBuilderConfig(config));
    this.subagentConfig = config;
  }

  // 更新环境信息：保持其余配置不变，返回自身以支持 `builder.setEnvInfo(...).build()`。
  override setEnvInfo(envInfo: EnvInfo): this {
    this.subagentConfig = {
      ...this.subagentConfig,
      envInfo,
    };
    return this;
  }

  // 构建子 agent 的完整上下文结果（system 消息 + meta_user 附件 + 统计）。
  // 纯内存计算：不读文件、不发事件；同一配置多次调用结果稳定，便于缓存与测试。
  // 空集合语义：无 system 段时 systemMessages 为 []；无 skills/context 内容时
  // metaUserAttachments 对应项被整体省略，不产生空附件。
  override build(): ContextBuildResult {
    const sections = buildSubagentContextSections(this.subagentConfig);
    const orderedSections = orderSubagentSections(sections);
    const totalChars = orderedSections.reduce((sum, section) => sum + section.chars, 0);
    const totalTokens = orderedSections.reduce((sum, section) => sum + section.tokens, 0);
    const systemSections = orderedSections.filter(
      (section) => section.injectionTarget === "system",
    );
    // 逐段标记会耗尽缓存断点额度，导致对话末尾标记被丢弃；正文合并时保留各段自带的换行。
    const systemMessages = [
      systemSections.filter((section) => section.source === "cli_prefix"),
      systemSections.filter((section) => section.source !== "cli_prefix"),
    ]
      .filter((group) => group.length > 0)
      .map(
        (group): ModelInputMessage => ({
          role: "system",
          content: group.map((section) => section.content).join(""),
          cacheControl: EPHEMERAL_CACHE_CONTROL,
        }),
      );
    const skillsContent = buildSkillsMetaUserBody(
      orderedSections.filter(
        (section) => section.injectionTarget === "meta_user" && section.source === "skills",
      ),
    );
    const contextContent = buildContextMetaUserBody(
      orderedSections.filter(
        (section) => section.injectionTarget === "meta_user" && section.source !== "skills",
      ),
    );

    return {
      sections: orderedSections,
      totalChars,
      totalTokens,
      systemMessages,
      metaUserAttachments: [
        ...(skillsContent
          ? [
              {
                source: "skills_listing" as const,
                content: skillsContent,
              },
            ]
          : []),
        ...(contextContent
          ? [
              {
                source: "context_prefix" as const,
                content: contextContent,
              },
            ]
          : []),
      ],
    };
  }
}

// 工厂函数：以给定配置创建 SubagentContextBuilder（等价于 new，便于调用方按接口注入）。
// 不校验配置内容，缺失字段按上述 undefined/空串语义降级。
export function createSubagentContextBuilder(
  config: SubagentContextBuilderConfig,
): SubagentContextBuilder {
  return new SubagentContextBuilder(config);
}

// 按固定顺序产出子 agent 的上下文段落：CLI 前缀 → Agent Prompt → Notes → Environment
// → 用户指令 → 当前日期 → Skills。顺序不可随机，因为缓存断点依赖稳定前缀。
// 各段 chars/tokens 由 createSubagentSection 现场计算；未启用的可选段直接不产出。
function buildSubagentContextSections(config: SubagentContextBuilderConfig): ContextSection[] {
  const sections: ContextSection[] = [buildCliPrefixSection()];
  // trimEnd 去掉尾部空白，避免 prompt 末尾空行影响段落边界；空串则不建段。
  const agentPrompt = config.agentPrompt.trimEnd();
  if (agentPrompt) {
    sections.push(
      createSubagentSection({
        name: "Subagent Agent Prompt",
        source: "subagent_agent_prompt",
        cacheHint: "stable",
        // 空 prompt 不是语义段，不能让左边界单独成为 system block。
        // ZCode by design：Subagent agent prompt 自带相对 CLI prefix 的单换行左边界。
        content: `\n${agentPrompt}`,
      }),
    );
  }

  sections.push(
    createSubagentSection({
      name: "Subagent Notes",
      source: "subagent_notes",
      cacheHint: "stable",
      // ZCode by design：后续 Subagent system block 统一自带双换行左边界。
      content: `\n\n${buildSubagentCommonNotes()}`,
    }),
    createSubagentSection({
      name: "Subagent Environment",
      source: "subagent_environment",
      cacheHint: "dynamic",
      content: `\n\n${buildSubagentEnvironmentContext({
        agentPrompt: config.agentPrompt,
        envInfo: config.envInfo,
        model: config.model,
      })}`,
    }),
  );

  const requestUserContextSection = buildRequestUserContextSection({
    userInstructions: config.userInstructions,
  });
  if (requestUserContextSection) {
    sections.push(requestUserContextSection);
  }
  const currentDateSection = buildCurrentDateSection(config.currentDate);
  if (currentDateSection) {
    sections.push(currentDateSection);
  }
  if (config.skills) {
    const skillsSection = buildSkillsSection({
      outcome: config.skills,
      metadataBudget: config.skillMetadataBudget,
    });
    if (skillsSection) {
      sections.push(skillsSection);
    }
  }

  return sections;
}

// 稳定排序：system 段全部前置，meta_user 段统一后置，供 build 分段装配。
// 使用 filter 而非 sort，保持各分组内原有产出顺序。
function orderSubagentSections(sections: ContextSection[]): ContextSection[] {
  return [
    ...sections.filter((section) => section.injectionTarget === "system"),
    ...sections.filter((section) => section.injectionTarget === "meta_user"),
  ];
}

// 构造一个 system 注入段：补齐 injectionTarget、统计 chars/tokens 并截取前 100 字符预览。
// tokens 为估算值（estimateTokens），仅用于预算与观测，不保证与实际计费一致。
function createSubagentSection(input: {
  name: string;
  source: ContextSection["source"];
  cacheHint: ContextSection["cacheHint"];
  content: string;
}): ContextSection {
  return {
    ...input,
    injectionTarget: "system",
    chars: input.content.length,
    tokens: estimateTokens(input.content),
    preview: input.content.slice(0, 100),
  };
}

// 把子 agent 配置投影为父 ContextBuilder 配置：workingDirectory 一律取 envInfo.cwd，
// 不单独传入，避免两处路径出现不一致。
function toBaseContextBuilderConfig(config: SubagentContextBuilderConfig): ContextBuilderConfig {
  return {
    workingDirectory: config.envInfo.cwd,
    envInfo: config.envInfo,
    model: config.model,
    currentDate: config.currentDate,
    skillMetadataBudget: config.skillMetadataBudget,
    skills: config.skills,
  };
}
