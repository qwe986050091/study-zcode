// ============================================================
// Skill Tool Handler
// ============================================================
// 定位：把本地技能正文注入当前会话上下文（技能文件 → `<skill_content>` 文本片段）。
// 职责：解析入参 name → SkillPort.loadSkill（受字节上限、给出 baseDirectory）→ 记录遥测
//   元数据 → 展开目录变量 → 套固定外壳返回。
// 输入输出：入参只有 skill/args（`args` 由技能正文自行解释，本 handler 不消费、不转义）；
//   输出是可直接拼进上下文的字符串，不是结构化 JSON。
// 失败/降级：SkillPort 缺席 → ConfigurationError（不可恢复，属于装配问题）；读取失败向上
//   冒泡；正文超限由端口截断，本 handler 只补 "[Skill content truncated]" 标记。
// 不变量：外壳字节必须计入预算 `SKILL_RESULT_WRAPPER_BYTES`，否则工具级 maxOutputBytes
//   会反过来把正文尾部（常常是"接下来怎么做"）截掉。

import {
  CoreErrorType,
  SkillInputJsonSchema,
  SkillInputSchema,
  SkillOutputJsonSchema,
  SkillOutputSchema,
  createCoreError,
  DYNAMIC_WORKFLOW_SKILL_NAME,
  type SkillRuntimeInput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

/** 技能正文的默认字节上限；超出部分由 adapter 从尾部截掉。 */
export const MAX_SKILL_BYTES = 100_000;

/**
 * `dynamic-workflows` 技能的字节上限（docs/dynamic-workflow/authoring.md「The skill」）。
 * 2026-09-30 放宽：这份技能从 09-22 起一直贴在 100 000 上，每加一个功能都得先删掉已有的指导。
 * 判据是请求里的名字，与技能门认的是同一个（workflow-skill-gate.ts）。
 */
export const WORKFLOW_SKILL_MAX_BYTES = 200_000;

/** 结果外壳（`<skill_content>` 标签、标题、Base directory 行）的余量；工具级预算要装得下它。 */
export const SKILL_RESULT_WRAPPER_BYTES = 4_096;

/** 工具级结果预算是静态的，所以取最大的正文上限再加外壳。 */
const MAX_SKILL_RESULT_BYTES = WORKFLOW_SKILL_MAX_BYTES + SKILL_RESULT_WRAPPER_BYTES;

function skillMaxBytes(skill: string): number {
  return skill === DYNAMIC_WORKFLOW_SKILL_NAME ? WORKFLOW_SKILL_MAX_BYTES : MAX_SKILL_BYTES;
}

/**
 * 加载并渲染技能正文。
 *
 * 副作用：读取技能文件（经 SkillPort，受 `maxBytes` 限制）+ 写遥测元数据；不写会话历史、
 *   不修改工作区。
 * 降级：头尾截断由端口完成，这里只补标记；`filter(line => line.length > 0)` 去掉截断分支
 *   留下的空行，避免正文末尾出现多余空行。
 * 注意：外壳里的 Base directory 行不可删——技能正文中的相对路径全靠它解析。
 */
export const skillHandler: ToolHandler = async (input, context) => {
  const { skill } = SkillInputSchema.parse(input) as SkillRuntimeInput;
  const skillPort = context.skillPort;

  if (!skillPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SkillPort is not configured for Skill tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Skill",
        },
        recoverable: false,
      },
    );
  }

  const loaded = await skillPort.loadSkill(
    {
      name: skill,
      workingDirectory: context.workingDirectory,
      maxBytes: skillMaxBytes(skill),
      trace: {
        traceId: context.traceId,
        spanId: context.spanId,
        parentSpanId: context.parentSpanId,
        sessionId: context.sessionId,
        turnId: context.turnId,
      },
    },
    { signal: context.abortSignal },
  );

  context.recordSkillTelemetryMetadata?.({
    name: loaded.metadata.name,
    ...(loaded.metadata.qualifiedName ? { qualifiedName: loaded.metadata.qualifiedName } : {}),
    ...(loaded.metadata.pluginId ? { pluginId: loaded.metadata.pluginId } : {}),
    source: loaded.metadata.source,
  });

  return [
    `<skill_content name="${loaded.metadata.name}">`,
    `# Skill: ${loaded.metadata.name}`,
    "",
    expandSkillContextVariables(loaded.content, loaded.baseDirectory),
    "",
    `Base directory for this skill: ${loaded.baseDirectory}`,
    "Relative paths in this skill are relative to this base directory.",
    loaded.truncated ? "[Skill content truncated]" : "",
    "</skill_content>",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
};

/**
 * 只在加载点替换 `${CLAUDE_SKILL_DIR}` / `${ZCODE_SKILL_DIR}`：技能正文是静态文件，目录
 * 要到 SkillPort 返回后才知道。保留 CLAUDE_ 前缀是兼容已发布的技能包，不是笔误。
 * 用正则全局替换而非字符串替换，因为同一份正文可能多处引用该目录。
 */
function expandSkillContextVariables(content: string, baseDirectory: string): string {
  // 只有 Skill 工具加载后才有明确的当前 skill 目录，因此变量替换限定在这里完成。
  return content.replace(/\$\{(CLAUDE_SKILL_DIR|ZCODE_SKILL_DIR)\}/gu, baseDirectory);
}

/**
 * Skill 的工具声明。
 *
 * 口径：`readOnly:true` + `concurrentSafe:true`——读技能不产生工作区副作用，可与其他工具
 *   并行；`sideEffectScope:"session"` 是因为正文会进入当前会话上下文（影响后续模型行为）。
 * 预算：工具声明无法按技能名动态改预算，因此 `maxOutputBytes` 取"最大技能上限 + 外壳余量"
 *   的静态上界；真正的 per-skill 上限在 `skillMaxBytes` 里，dynamic-workflows 放宽到 200KB。
 * 失败：handler 抛配置错误时 recoverable=false，由 executor 转成 error tool_result，
 *   不重试——装配错误重试也不会变好。
 */
export const skillToolEntry: ToolEntry = {
  capability: "Load local skill instructions into the current session context",
  metadata: {
    name: "Skill",
    description: `Execute a skill within the main conversation

When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>", they are referring to a skill. Use this tool to invoke it.

How to invoke:
- Set \`skill\` to the exact name of an available skill (no leading slash). For plugin-namespaced skills use the fully qualified \`plugin:skill\` form.
- Set \`args\` to pass optional arguments.

Important:
- Available skills are listed in system-reminder messages in the conversation
- Only invoke a skill that appears in that list, or one the user explicitly typed as \`/<name>\` in their message. Never guess or invent a skill name from training data; otherwise do not call this tool
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
- If you see a <command-name> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again
`,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30000,
    maxOutputBytes: MAX_SKILL_RESULT_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: skillHandler,
  inputSchema: SkillInputJsonSchema,
  outputSchema: SkillOutputJsonSchema,
  runtimeInputSchema: SkillInputSchema,
  runtimeOutputSchema: SkillOutputSchema,
  permission: {
    permission: "skill",
    reason: "Skill loads local instructions into session context",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_SKILL_RESULT_BYTES,
    maxModelBytes: MAX_SKILL_RESULT_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_SKILL_RESULT_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Skill loading was cancelled before content was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
