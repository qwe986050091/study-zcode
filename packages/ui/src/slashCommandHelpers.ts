// INV-01 纯函数：守住位置 全部导出；改错故障 建议构造过程产生副作用。
// INV-02 值一律去前导斜杠：守住位置 normalizeSlashCommandValue；改错故障 插入后变成双斜杠。
// INV-03 App 命令带独立前缀：守住位置 APP_SLASH_SUGGESTION_ID_PREFIX；改错故障 与 CLI 命令 id 撞车。
// INV-04 App 命令不进发送链路：守住位置 接口注释与 run；改错故障 选中即发送文本。
// INV-05 空值命令丢弃：守住位置 !value 早退；改错故障 面板出现空白项。
// INV-06 Plan 由 Composer 本地处理：守住位置 plan 过滤；改错故障 旧 Agent 广播的命令重新插入文本。
// INV-07 关键词去重：守住位置 new Set 展开；改错故障 面板匹配项重复排序抖动。
// INV-08 标签可回落：守住位置 inputHint 三元；改错故障 命令显示为 undefined。
// INV-09 子代理复用 mention 映射：守住位置 mapSubagentsToMentionItemsForTest；改错故障 两处展示不一致。
// INV-10 Skill 标记补默认关键词：守住位置 skills 关键字拼接；改错故障 搜索不到技能。
// INV-11 替换要求活跃触发：守住位置 activeTrigger 判断；改错故障 光标不在命令内也改写文本。
// INV-12 尾部按 token 长度裁剪：守住位置 tailLength；改错故障 替换后残留旧命令片段。
// INV-13 非折叠选区不取文本：守住位置 isCollapsed；改错故障 选中整段时插入错位。
// INV-14 非文本锚点回落全量：守住位置 anchor.type 分支；改错故障 根节点下光标拿不到上下文。
//
// 模块职责：斜杠命令面板的建议构造、命令名规整与光标前后文本替换。
// 阅读顺序：先看 App 命令与 CLI 命令两套建议，再看替换函数，最后看光标上下文。
/**
 * slashCommandHelpers — 纯函数辅助工具，供 SlashCommandPlugin.tsx 使用
 */
import { $getRoot, $getSelection, $isRangeSelection, $isTextNode } from "lexical";
import type { AgentSummary, Locale, SkillSummary, ZCodeSlashCommand } from "@zcode/shared";
import type { MentionItem } from "@/mentions/mentionTypes.js";
import { mapSubagentsToMentionItemsForTest } from "@/mentions/providers/subagentsMentionProvider.js";
import { mapSkillsToMentionItemsForTest } from "@/mentions/providers/skillsMentionProvider.js";
import {
  extractActivePromptInputTrigger,
  getActivePromptInputTokenTailLength,
} from "./lib/promptInputTriggers.js";
import type { PromptInputSuggestionItem } from "./lib/promptInputTriggers.js";

export interface SlashCommandPluginProps {
  container?: HTMLElement | null;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 已有 Session 的 id；null/undefined 表示新建草稿，决定 Skill catalog authority。 */
  sessionId?: string | null;
  disabled?: boolean;
  excludedCommandNames?: readonly string[];
  /**
   * App 层本地命令（如 `/side`）。命令目录仍以 CLI catalog 为权威；这里只允许渲染层
   * 追加"选中即执行 UI 行为"的命令，不参与发送，也不写回 CLI 命令列表。
   */
  appCommands?: readonly AppSlashCommand[];
}

/** App 层斜杠命令：选中即执行 UI 行为（不插入 mention、不发送）。 */
export interface AppSlashCommand {
  /** 命令值（不含 `/`），如 "side"。 */
  value: string;
  /** 本地化操作名称；省略时保留斜杠命令形式。 */
  label?: string;
  /** 本地化描述，直接展示在 `/` 面板。 */
  description: string;
  /** 额外搜索关键词；应同时包含中英文别名，保证两种输入习惯都能搜到。 */
  keywords?: readonly string[];
  /** 选中命令后立即执行的 UI 行为。 */
  run: () => void;
}

const APP_SLASH_SUGGESTION_ID_PREFIX = "app-slash:";

// App 命令逐条规整后转成建议项。
export function buildAppSlashCommandSuggestions(
  commands: readonly AppSlashCommand[],
): PromptInputSuggestionItem[] {
  return commands.flatMap((command) => {
    // 先过 `normalizeSlashCommandValue`，返回空串的 command 不进建议列表。
    const value = normalizeSlashCommandValue(command.value);
    if (!value) {
      return [];
    }
    return [
      {
        id: `${APP_SLASH_SUGGESTION_ID_PREFIX}${value}`,
        trigger: "/",
        value,
        label: command.label ?? `/${value}`,
        description: command.description,
        keywords: [...new Set([value, command.description, ...(command.keywords ?? [])])],
      },
    ];
  });
}

// 前缀是判断来源的唯一依据。
export function isAppSlashCommandSuggestion(suggestion: PromptInputSuggestionItem): boolean {
  return suggestion.id.startsWith(APP_SLASH_SUGGESTION_ID_PREFIX);
}

/**
 * `/side` 门禁：草稿态没有父 session 可挂 child，辅助对话自身不允许再开辅助对话，
 * 只读与手机 viewport 与固定入口保持一致地隐藏。
 */
// 四个条件必须同时满足才展示。
export function shouldOfferSideSlashCommand(options: {
  isDraft: boolean;
  selectionSideChat: boolean;
  readOnly: boolean;
  isMobileViewport: boolean;
}): boolean {
  return (
    !options.isDraft && !options.selectionSideChat && !options.readOnly && !options.isMobileViewport
  );
}

// `normalizeSlashCommandValue` 统一去掉远端命令自带的前导斜杠。
export function normalizeSlashCommandValue(name: string): string {
  // ZCode Agent 在远端可能直接返回 "/init" 作为命令名。
  // UI 的 value 需要去掉前导斜杠，否则插入 markdown 时会变成 "//init"，并影响 / 面板匹配。
  // `replace` 配 `/^\/+/` 只裁剪前导斜杠，保留内部内容。
  return name.trim().replace(/^\/+/, "");
}

// CLI 命令以 catalog 为准。
export function buildSlashSuggestions(commands: ZCodeSlashCommand[]): PromptInputSuggestionItem[] {
  return commands.flatMap((command) => {
    const value = normalizeSlashCommandValue(command.name);
    // Plan 是 Composer 本地操作。旧 Agent 仍可能广播同名命令，不能让它重新
    // 变成插入文本、等到发送时才切模式的旧入口；其余命令仍以 CLI catalog 为准。
    // Plan 不再经建议面板插入。
    if (!value || value.toLowerCase() === "plan") {
      return [];
    }
    return [
      {
        id: `slash:${value}`,
        trigger: "/",
        value,
        label: command.inputHint?.trim() || `/${value}`,
        description: command.description,
        keywords: [...new Set([value, command.name, command.description, command.inputHint ?? ""])],
      },
    ];
  });
}

// 子代理先转 mention 再转建议。
export function buildSubagentSuggestions(
  agents: Array<
    Pick<
      AgentSummary,
      "id" | "name" | "description" | "path" | "scope" | "source" | "enabled" | "modelSelection"
    >
  >,
): PromptInputSuggestionItem[] {
  return mapSubagentsToMentionItemsForTest(agents).map((item) =>
    mapSubagentMentionItemToSuggestion(item),
  );
}

// 技能标签固定带美元前缀。
export function buildSkillSuggestions(
  skills: Array<
    Pick<SkillSummary, "id" | "name" | "description" | "path" | "scope" | "pluginName">
  >,
  locale?: Locale,
): PromptInputSuggestionItem[] {
  return mapSkillsToMentionItemsForTest(skills, locale).map((item) => ({
    id: item.id,
    trigger: "/",
    value: item.value,
    label: `$${item.value}`,
    description: item.description,
    keywords: [...new Set([...(item.keywords ?? []), "skill", "skills", item.value])],
    data: item.data,
  }));
}

function mapSubagentMentionItemToSuggestion(item: MentionItem): PromptInputSuggestionItem {
  return {
    id: item.id,
    trigger: "/",
    value: item.value,
    label: item.label,
    description: item.description,
    keywords: [...new Set([...(item.keywords ?? []), "subagent", "agent"])],
    data: item.data,
  };
}

// 只有光标处在命令内才替换。
export function replaceActiveSlashToken(
  textBeforeCursor: string,
  textAfterCursor: string,
  replacementToken: string,
) {
  const activeTrigger = extractActivePromptInputTrigger(textBeforeCursor);
  if (!activeTrigger || activeTrigger.trigger !== "/") {
    return null;
  }

  const tokenStart = textBeforeCursor.length - activeTrigger.query.length - 1;
  const tailLength = getActivePromptInputTokenTailLength(
    activeTrigger,
    textAfterCursor,
    replacementToken,
  );
  const prefix = textBeforeCursor.slice(0, tokenStart);
  const suffix = textAfterCursor.slice(tailLength);
  return {
    cursorOffset: prefix.length + replacementToken.length + 1,
    text: `${prefix}${replacementToken} ${suffix}`,
  };
}

// 取光标前后文本供触发识别。
export function getTextAroundCursor() {
  const selection = $getSelection();
  // `selection.isCollapsed()` 为 false 时直接返回 null，不参与命令匹配。
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return null;
  }

  const anchor = selection.anchor;
  if (anchor.type !== "text") {
    return {
      textAfterCursor: "",
      textBeforeCursor: $getRoot().getTextContent(),
    };
  }

  const node = anchor.getNode();
  if (!$isTextNode(node)) {
    return null;
  }

  const textContent = node.getTextContent();
  return {
    textAfterCursor: textContent.slice(anchor.offset),
    textBeforeCursor: textContent.slice(0, anchor.offset),
  };
}
