import type { EnvInfo, Model } from "@zcode/contracts";
import { isEnvInfoGitRepository } from "../context/sections/env-info.js";

// 构建子 agent 环境段的输入。
export interface SubagentEnvironmentContextOptions {
  // 子 agent 的 prompt 原文；当前仅用于调用方对齐，不参与本文件文案生成。
  agentPrompt: string;
  // 运行环境事实（cwd/platform/shell/osVersion 等），必须提供。
  envInfo: EnvInfo;
  // 当前模型；undefined 时省略 “powered by” 一行。
  model?: Model;
}

// 生成所有子 agent 通用的 Notes 段：cwd 重置、绝对路径、最终回复格式、禁用 emoji、
// 不写报告类 md 文件等行为约束。文案即模型契约，纯字符串无副作用。
// 无入参、无分支，输出稳定，可安全缓存。
export function buildSubagentCommonNotes(): string {
  return [
    "Notes:",
    "- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.",
    "- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.",
    "- For clear communication with the user the assistant MUST avoid using emojis.",
    '- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.',
    "- Do NOT Write report/summary/findings/analysis .md files. Return findings directly as your final assistant message — the parent agent reads your text output, not files you create.",
  ].join("\n");
}

// 生成 `<env>...</env>` 环境段：工作目录、是否 git 仓库、平台、shell、OS 版本。
// 追加模型行（providerId/modelId）仅在 model 存在时；undefined 不产出空行。
// 纯字符串拼装，不探测环境、不读系统信息，所有事实由调用方注入。
export function buildSubagentEnvironmentContext(
  options: SubagentEnvironmentContextOptions,
): string {
  const { envInfo, model } = options;
  // 模型行单独成组，便于在缺失时整体省略而不影响 <env> 结构。
  const modelLine = model
    ? [`You are powered by the model named ${model.providerId}/${model.modelId}.`]
    : [];

  return [
    "Here is useful information about the environment you are running in:",
    "<env>",
    `Working directory: ${envInfo.cwd}`,
    `Is directory a git repo: ${isEnvInfoGitRepository(envInfo) ? "Yes" : "No"}`,
    `Platform: ${envInfo.platform}`,
    `Shell: ${envInfo.shell}`,
    `OS Version: ${envInfo.osVersion}`,
    "</env>",
    ...modelLine,
  ].join("\n");
}
