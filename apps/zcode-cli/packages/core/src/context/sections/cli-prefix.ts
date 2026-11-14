/**
 * ============================================================================
 * context/sections/cli-prefix.ts —— CLI 身份前缀
 * ============================================================================
 *
 * 一句话定义"你是 ZCode，一个交互式 coding agent"，标 stable。
 * 动态工作流子代理不会注入该段（其身份由 workflow-actor 提供），
 * 否则子代理会误以为自己在和用户对话。
 * ============================================================================
 */

import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

const CLI_PREFIX_PROMPT = "You are ZCode, an interactive coding agent";

/**
 * 产出 CLI 身份前缀 section。
 * 输入无；输出固定 stable system 段（一句话身份），chars/tokens 由内容计算。
 * 无副作用、无失败分支；工作流子代理不应调用（其身份由 workflow-actor 提供）。
 * 内容变更会让 stable 前缀缓存整体失效，改文案需评估。
 */
export function buildCliPrefixSection(): ContextSection {
  const content = CLI_PREFIX_PROMPT;

  return {
    name: "CLI Prefix",
    source: "cli_prefix",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
