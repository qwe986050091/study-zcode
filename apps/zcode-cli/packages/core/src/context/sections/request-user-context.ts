/**
 * ============================================================================
 * context/sections/request-user-context.ts —— 用户指令 + 项目记忆索引
 * ============================================================================
 *
 * 【定位】把 AGENTS.md 等用户指令与 MEMORY.md 索引合并成一个 meta user 段，
 * 标题固定为 `# agentsMd`：只有项目记忆时也必须有一致的标题，
 * 不能把标题绑定到 AGENTS.md（否则仅记忆索引时整段无标题）。
 *
 * 【优先级文案】明确声明这些指令"覆盖默认行为"，这是它们高于 system prompt
 * 默认建议的依据。
 *
 * 【多来源】user/workspace 两类指令按 sources 顺序拼接；旧数据没有 sources
 * 时用单文件字段兜底。截断文件追加 "[File truncated]" 标记，
 * 让模型知道指令不完整，而不是当成全文。
 *
 * 【空段】没有任何指令且没有记忆索引时返回 null，不注入空标题。
 * ============================================================================
 */

import { join } from "node:path";

import { formatProjectMemoryIndexContent } from "../../memory/index-content.js";
import type {
  ContextSection,
  ResolvedUserInstructionSource,
  ResolvedUserInstructions,
} from "../types.js";
import { estimateTokens } from "../utils.js";

/**
 * 产出用户指令 + 项目记忆索引的 meta user 段。
 * 输入 userInstructions / memoryIndexContent / memoryRoot；
 * 输出 dynamic meta_user section；两者都无有效内容时返回 null。
 * 无副作用；标题固定为 # agentsMd，"覆盖默认行为"的优先级声明随段下发。
 */
export function buildRequestUserContextSection(input: {
  userInstructions?: ResolvedUserInstructions;
  memoryIndexContent?: string;
  memoryRoot?: string;
}): ContextSection | null {
  const content = buildRequestUserContextContent(input);
  if (!content) {
    return null;
  }

  return {
    name: "Request User Context",
    source: "request_user_context",
    injectionTarget: "meta_user",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

/**
 * 合并指令与记忆索引正文；空段返回 null（避免空标题）。
 * 顺序：用户/工作区指令在前，MEMORY.md 索引在后。
 */
function buildRequestUserContextContent(input: {
  userInstructions?: ResolvedUserInstructions;
  memoryIndexContent?: string;
  memoryRoot?: string;
}): string | null {
  const sections: string[] = [];

  const instructionContent = input.userInstructions
    ? buildInstructionContent(input.userInstructions)
    : null;
  if (instructionContent) {
    sections.push(instructionContent);
  }

  const memoryIndexContent = buildProjectMemoryIndexContent(
    input.memoryRoot,
    input.memoryIndexContent,
  );
  if (memoryIndexContent) {
    sections.push(memoryIndexContent);
  }

  if (sections.length === 0) {
    return null;
  }

  return [
    // 聚合字段标题不能绑定到 AGENTS.md，否则仅有 Project Memory 时缺少标题。

    "# agentsMd",
    "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.",
    "",
    sections.join("\n\n"),
  ].join("\n");
}

/**
 * 渲染 MEMORY.md 索引附件；memoryRoot 或 indexContent 缺席返回 null。
 * 输入内容经 formatProjectMemoryIndexContent 归一化，空结果视为未配置。
 */
function buildProjectMemoryIndexContent(
  memoryRoot: string | undefined,
  indexContent: string | undefined,
): string | null {
  if (!memoryRoot || indexContent === undefined) return null;
  const formatted = formatProjectMemoryIndexContent(indexContent);
  if (!formatted) return null;

  return [
    `Contents of ${join(memoryRoot, "MEMORY.md")} (user's auto-memory, persists across conversations):`,
    "",
    formatted,
  ].join("\n");
}

/**
 * 按 sources 顺序拼接各指令文件；无有效内容返回 null。
 * 旧数据缺 sources 时由 normalizedInstructionSources 用单文件字段兜底。
 */
function buildInstructionContent(instructions: ResolvedUserInstructions): string | null {
  const sections = normalizedInstructionSources(instructions)
    .map((source) => buildInstructionSourceContent(source))
    .filter((content): content is string => content !== null);

  return sections.length > 0 ? sections.join("\n\n") : null;
}

/**
 * 归一化指令来源：优先 sources 数组，否则把单文件字段包装成 workspace 来源。
 * 不修改入参，总是返回新数组。
 */
function normalizedInstructionSources(
  instructions: ResolvedUserInstructions,
): ResolvedUserInstructionSource[] {
  if (instructions.sources && instructions.sources.length > 0) {
    return instructions.sources;
  }

  return [
    {
      scope: "workspace",
      filePath: instructions.filePath,
      fileName: instructions.fileName,
      content: instructions.content,
      bytesRead: instructions.bytesRead,
      sizeBytes: instructions.sizeBytes,
      truncated: instructions.truncated,
    },
  ];
}

/**
 * 渲染单个指令来源；空内容返回 null。
 * 被截断的文件追加 "[File truncated: <name>]"，让模型知道内容不完整。
 */
function buildInstructionSourceContent(source: ResolvedUserInstructionSource): string | null {
  const body = source.truncated
    ? `${source.content}\n\n[File truncated: ${source.fileName}]`
    : source.content;
  const trimmedBody = body.trim();
  if (!trimmedBody) {
    return null;
  }

  return [
    `Contents of ${source.filePath} (${formatInstructionSourceScope(source.scope)}):`,
    "",
    trimmedBody,
  ].join("\n");
}

/**
 * 来源 scope 的用户可读文案；user → user default instructions，
 * 其它（workspace）→ workspace instructions。
 */
function formatInstructionSourceScope(scope: ResolvedUserInstructionSource["scope"]): string {
  return scope === "user" ? "user default instructions" : "workspace instructions";
}
