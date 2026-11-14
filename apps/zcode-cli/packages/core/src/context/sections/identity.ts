/**
 * ============================================================================
 * context/sections/identity.ts —— Agent 身份段（稳定前缀）
 * ============================================================================
 *
 * 【定位】system prompt 的第一段：身份开场 + 安全 IMPORTANT 行 + `# Harness`
 * 运行时约束。标 cacheHint="stable"：内容不随请求变化，应命中 provider 前缀缓存。
 *
 * 【复用边界】
 *   - buildSecurityNotice / buildHarnessBlock 同时被 workflow-actor 逐字复用：
 *     动态工作流子代理只替换"身份开场"，安全与 Harness 约束必须与主代理一致；
 *   - 有 outputStyle 时开场句改为"按下列输出风格回应"，但 Harness 不参与风格替换。
 *
 * 【为什么安全声明放在身份段】
 *   它是对模型行为的硬约束，必须出现在稳定前缀里（而不是可被 compact 掉的
 *   meta user 附件），否则长会话压缩后模型可能丢失该约束。
 * ============================================================================
 */

import type { ContextSection } from "../types.js";
import type { OutputStylePromptConfig } from "../types.js";
import { estimateTokens } from "../utils.js";

const SECURITY_NOTICE =
  "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.";

/** 安全 IMPORTANT 行：交互式身份与工作流子代理身份共用，逐字同一份。 */
// 无输入，返回常量字符串；修改文案会同时影响主代理与 workflow actor 的 stable 前缀。
export function buildSecurityNotice(): string {
  return SECURITY_NOTICE;
}

/**
 * `# Harness` 块：稳定运行时约束，不属于 output style 可替换的 coding instructions，
 * 也是工作流子代理身份（sections/workflow-actor.ts）逐字复用的那一段。
 * 输入无，输出固定文本；内容属于 stable 前缀，文案变化会整体失效 provider 缓存。
 * 不随 output style 替换，确保所有子代理共享同一运行时约束。
 */
export function buildHarnessBlock(): string {
  return [
    "# Harness",
    "- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.",
    "- Tools run behind a user-selected permission mode; a denied call means the user declined it \u2014 adjust, don't retry verbatim.",
    "- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.",
    "- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.",
    "- Reference code as `file_path:line_number` \u2014 it's clickable.",
  ].join("\n");
}

/**
 * 拼接默认身份正文：开场句 + 安全行 + Harness。
 * 输入可选 outputStyle；有风格时只改开场句，安全与 Harness 不变。
 * 返回纯字符串，无副作用；不负责 section 统计字段。
 */
function buildIdentityPrompt(outputStyle?: OutputStylePromptConfig): string {
  const intro = outputStyle
    ? "You respond to the user according to the active Output Style below while using ZCode's tools and instructions."
    : "You are an interactive ZCode agent that helps users with software engineering tasks.";

  const identityLines = ["", intro, "", SECURITY_NOTICE].join("\n");

  return [identityLines, "", buildHarnessBlock()].join("\n");
}

/**
 * 产出默认身份 section（system + stable）。
 * 输入可选 outputStyle；输出稳定 system 段，不随请求变化。
 * 无副作用；customSystemPrompt/workflowActor 在场时 builder 不调用本函数。
 */
export function buildIdentitySection(outputStyle?: OutputStylePromptConfig): ContextSection {
  const content = buildIdentityPrompt(outputStyle);

  return {
    name: "Agent Identity",
    source: "identity",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
