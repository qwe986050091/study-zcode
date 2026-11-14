/**
 * ============================================================================
 * context/sections/env-info.ts —— 环境信息与 git 快照
 * ============================================================================
 *
 * 【两段输出】
 *   - Environment Info：cwd、附加目录、平台/Shell/OS、当前执行模型；
 *   - System Context：git 分支/main 分支/user、status、recent commits。
 *     仅在是 git 仓库时注入（isEnvInfoGitRepository）。
 *
 * 【口径】
 *   - 模型只读"本步实际执行的 Model"，不读 envInfo 里可能残留的历史模型字段；
 *   - additionalDirectories 只投影本次运行已解析的路径，让模型看见目录范围；
 *   - git status 是"会话开始时的快照"，文案明确说明不会实时更新，
 *     防止模型把它当作当前状态（需要最新状态时必须重新运行 git status）；
 *   - 非 git 仓库返回 null，而不是输出 "(not a git repository)" 的空段。
 *
 * 【缓存】两段都是 dynamic：环境可能在会话中变化（切换目录/新增目录），
 * 不能进 stable 前缀。
 * ============================================================================
 */

import type { ContextSection, EnvInfo } from "../types.js";
import type { Model } from "@zcode/contracts";
import { estimateTokens } from "../utils.js";

const ENVIRONMENT_HEADING = "# Environment";
const WORKING_DIRECTORY_LABEL = "Primary working directory";
const ADDITIONAL_DIRECTORIES_LABEL = "Additional directories";
const IS_GIT_REPOSITORY_LABEL = "Is a git repository";
const PLATFORM_LABEL = "Platform";
const SHELL_LABEL = "Shell";
const OS_VERSION_LABEL = "OS Version";
// const NODE_VERSION_LABEL = "Node version";
// const OPERATING_SYSTEM_LABEL = "Operating system";
const GIT_LABEL = "Git";
const NOT_A_GIT_REPOSITORY = "not a git repository";
const YES_LABEL = "yes";
const NO_LABEL = "no";
const GIT_SYSTEM_CONTEXT_PREFIX =
  "gitStatus: This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.";
const CURRENT_BRANCH_LABEL = "Current branch";
const MAIN_BRANCH_LABEL = "Main branch (you will usually use this for PRs)";
const GIT_USER_LABEL = "Git user";
const STATUS_LABEL = "Status";
const RECENT_COMMITS_LABEL = "Recent commits";
const CLEAN_GIT_STATUS = "(clean)";
const DIRTY_GIT_STATUS = "(dirty)";
const UNKNOWN_GIT_STATUS = "(unknown)";

/**
 * 产出 Environment Info 段（system + dynamic）。
 * 输入 envInfo、本步执行的 Model、本次已解析的附加目录；
 * 输出纯文本 section；model 缺席时不渲染模型行。
 * 无副作用；envInfo 变化只会让该 dynamic 段失效，不影响 stable 前缀。
 */
export function buildEnvInfoSection(
  envInfo: EnvInfo,
  model?: Model,
  additionalDirectories: readonly string[] = [],
): ContextSection {
  const content = buildEnvInfoContent(envInfo, model, additionalDirectories);

  return {
    name: "Environment Info",
    source: "env_info",
    injectionTarget: "system",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

/**
 * 产出 git 快照 System Context 段；非 git 仓库返回 null。
 * 输入 envInfo；输出 dynamic system 段，内容明确标注"会话开始时快照"。
 * 无副作用；git 状态后续变化不会自动刷新，模型需自行重跑 git status。
 */
export function buildGitSystemContextSection(envInfo: EnvInfo): ContextSection | null {
  if (!isEnvInfoGitRepository(envInfo)) {
    return null;
  }

  const content = buildGitSystemContextContent(envInfo);

  return {
    name: "System Context",
    source: "system_context",
    injectionTarget: "system",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

function buildEnvInfoContent(
  info: EnvInfo,
  model: Model | undefined,
  additionalDirectories: readonly string[],
): string {
  const hasGitRepository = isEnvInfoGitRepository(info);
  const lines: string[] = [
    ENVIRONMENT_HEADING,
    "You have been invoked in the following environment:",
    `- ${WORKING_DIRECTORY_LABEL}: ${info.cwd}`,
    // 附加目录此前只进入能力发现，模型看不到目录范围；这里只投影本次运行已解析的路径。
    ...(additionalDirectories.length
      ? [
          `- ${ADDITIONAL_DIRECTORIES_LABEL}:`,
          ...additionalDirectories.map((path) => `  - ${path}`),
        ]
      : []),
    `- ${IS_GIT_REPOSITORY_LABEL}: ${hasGitRepository ? YES_LABEL : NO_LABEL}`,
    `- ${PLATFORM_LABEL}: ${info.platform}`,
    `- ${SHELL_LABEL}: ${info.shell}`,
    `- ${OS_VERSION_LABEL}: ${info.osVersion}`,
    // 旧环境快照可能携带历史模型字段；渲染只读取本步骤实际执行的 Model。
    ...(model
      ? [`- You are powered by the model named ${model.providerId}/${model.modelId}.`]
      : []),
  ];

  return lines.join("\n");
}

function buildGitSystemContextContent(info: EnvInfo): string {
  const lines: string[] = [GIT_SYSTEM_CONTEXT_PREFIX];

  if (info.gitBranch) {
    lines.push("", `${CURRENT_BRANCH_LABEL}: ${info.gitBranch}`);
  }
  if (info.gitMainBranch) {
    lines.push("", `${MAIN_BRANCH_LABEL}: ${info.gitMainBranch}`);
  }
  if (info.gitUser) {
    lines.push("", `${GIT_USER_LABEL}: ${info.gitUser}`);
  }

  lines.push("", `${STATUS_LABEL}:\n${formatGitStatus(info)}`);
  lines.push("", `${RECENT_COMMITS_LABEL}:\n${formatRecentCommits(info)}`);

  return lines.join("\n");
}

/**
 * git 仓库判定口径：显式 isGitRepository 优先；否则按 gitStatus !== "not_repo"
 * 或存在 gitBranch 推断。输入 envInfo，输出布尔值；无副作用。
 * 注意旧快照字段可能缺失，不能据此判定"不是仓库"。
 */
export function isEnvInfoGitRepository(info: EnvInfo): boolean {
  return (
    info.isGitRepository ??
    (info.gitStatus !== undefined ? info.gitStatus !== "not_repo" : Boolean(info.gitBranch))
  );
}

/**
 * 渲染 git 状态：优先逐行 statusLines；否则退回 clean/dirty 标记。
 * 缺少状态信息时输出 "(unknown)"，避免伪造干净状态。
 */
function formatGitStatus(info: EnvInfo): string {
  if (info.gitStatusLines && info.gitStatusLines.length > 0) {
    return info.gitStatusLines.join("\n");
  }
  if (info.gitStatus === "dirty") {
    return DIRTY_GIT_STATUS;
  }
  if (info.gitStatus === "clean") {
    return CLEAN_GIT_STATUS;
  }
  return UNKNOWN_GIT_STATUS;
}

/**
 * 渲染最近提交：有列表则逐行拼接，否则返回空串；
 * 空串仍会保留 "Recent commits:" 标题，调用方无需另行判断。
 */
function formatRecentCommits(info: EnvInfo): string {
  if (info.recentCommits && info.recentCommits.length > 0) {
    return info.recentCommits.join("\n");
  }
  return "";
}
