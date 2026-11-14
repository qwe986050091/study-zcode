// INV-01 分区顺序固定为命令技能子代理：守住位置 数组字面量顺序；改错故障 分区随过滤结果乱序。
// INV-02 分区标识唯一：守住位置 标识字段；改错故障 面板合并两个分区。
// INV-03 命令标题按消息键翻译：守住位置 翻译调用；改错故障 面板出现英文硬编码。
// INV-04 应用内命令直接取标签：守住位置 类型判断；改错故障 应用命令多出斜杠前缀。
// INV-05 非应用命令补斜杠前缀：守住位置 三元分支；改错故障 命令缺少可识别前缀。
// INV-06 技能统一补美元前缀：守住位置 模板拼接；改错故障 技能与子代理视觉混淆。
// INV-07 子代理不补前缀：守住位置 直接取值；改错故障 子代理名被加上符号。
// INV-08 空态区分无命令与无结果：守住位置 数量判断；改错故障 未安装也提示无匹配。
// INV-09 技能分区携带加载态：守住位置 加载字段；改错故障 加载中显示为空结果。
// INV-10 技能分区携带错误态：守住位置 错误字段；改错故障 加载失败静默无提示。
// INV-11 子代理分区携带加载态：守住位置 加载字段；改错故障 子代理列表闪烁为空。
// INV-12 子代理分区携带错误态：守住位置 错误字段；改错故障 子代理失败无反馈。
// INV-13 描述字段可为空：守住位置 直接透传；改错故障 面板出现未定义文本。
// INV-14 概览行限制标题宽度：守住位置 最大宽类；改错故障 长命令名挤掉描述。
// INV-15 描述行占满剩余宽度：守住位置 弹性类；改错故障 描述被截断在中段。
// INV-16 计算只在依赖变化时发生：守住位置 依赖数组；改错故障 每次按键重算整个面板。
// INV-17 依赖覆盖全部输入：守住位置 数组完整；改错故障 过滤结果与输入不同步。
// INV-18 本函数只返回分区数据：守住位置 返回值形状；改错故障 调用方拿到节点而非数据。
//
// 模块职责：把命令、技能与子代理三份过滤结果组装成提及面板分区。
// 状态所有权：无状态；全部入参与加载错误标记由调用方注入。
// 阅读顺序：先看函数入参，再看缓存边界，最后看三个分区的字段差异。
import { useMemo } from "react";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { PromptInputSuggestionItem } from "@/lib/promptInputTriggers.js";
import { isAppSlashCommandSuggestion } from "@/slashCommandHelpers.js";
import {
  type MentionPanelOption,
  type MentionPanelSection,
} from "@/mentions/components/MentionPanel.js";

// filteredCommandSuggestions 等入参都已过滤，hook 不再二次筛选。
// useSlashCommandMentionPanelSections 只组装 MentionPanelSection 数组。
// 渲染与交互交给 MentionPanel，hook 不碰 DOM。
export function useSlashCommandMentionPanelSections(
  intl: IntlInstance,
  commandsLength: number,
  filteredCommandSuggestions: PromptInputSuggestionItem[],
  filteredSkillSuggestions: PromptInputSuggestionItem[],
  skillsLoading: boolean,
  skillsError: string | null,
  filteredSubagentSuggestions: PromptInputSuggestionItem[],
  subagentsLoading: boolean,
  subagentsError: string | null,
): MentionPanelSection[] {
  // 分区顺序由 commands、skills、subagents 固定，消费方按 id 取用。
  // useMemo 依赖数组变化才重算分区结果。
  // 依赖覆盖 intl 与全部 filtered* 入参，漏一个就会拿到旧数据。
  return useMemo(
    () => [
      {
        id: "commands",
        title: intl.formatMessage({ id: "chat.slash.commands.title" }),
        options: filteredCommandSuggestions.map<MentionPanelOption>((suggestion) => ({
          id: suggestion.id,
          label: isAppSlashCommandSuggestion(suggestion)
            ? suggestion.label
            : `/${suggestion.value}`,
          description: suggestion.description,
          content: (
            <span className="min-w-0 flex-1 flex items-center gap-2">
              <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                {isAppSlashCommandSuggestion(suggestion)
                  ? suggestion.label
                  : `/${suggestion.value}`}
              </span>
              <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                {suggestion.description}
              </span>
            </span>
          ),
        })),
        loading: false,
        emptyText:
          commandsLength === 0
            ? intl.formatMessage({ id: "chat.slash.emptyUnavailable" })
            : intl.formatMessage({ id: "chat.slash.emptyResults" }),
      },
      {
        // skills 分区的 label 加 $ 前缀，与命令的 / 前缀区分。
        // skillsLoading 透传到 loading，skillsError 透传到 errorText。
        // emptyText 固定取 chat.slash.skills.empty。
        id: "skills",
        title: intl.formatMessage({ id: "chat.slash.skills.title" }),
        options: filteredSkillSuggestions.map<MentionPanelOption>((suggestion) => ({
          id: suggestion.id,
          label: `$${suggestion.value}`,
          description: suggestion.description,
          content: (
            <span className="min-w-0 flex-1 flex items-center gap-2">
              <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                {`$${suggestion.value}`}
              </span>
              <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                {suggestion.description}
              </span>
            </span>
          ),
        })),
        loading: skillsLoading,
        loadingText: intl.formatMessage({ id: "chat.mention.category.loading" }),
        emptyText: intl.formatMessage({ id: "chat.slash.skills.empty" }),
        errorText: skillsError,
      },
      {
        // subagents 分区的 label 直接用 suggestion.value，不加前缀。
        // subagentsLoading 与 subagentsError 同样透传，不走本地兜底。
        // emptyText 固定取 chat.slash.subagents.empty。
        id: "subagents",
        title: intl.formatMessage({ id: "chat.slash.subagents.title" }),
        options: filteredSubagentSuggestions.map<MentionPanelOption>((suggestion) => ({
          id: suggestion.id,
          label: suggestion.value,
          description: suggestion.description,
          content: (
            <span className="min-w-0 flex-1 flex items-center gap-2">
              <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                {suggestion.value}
              </span>
              <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                {suggestion.description}
              </span>
            </span>
          ),
        })),
        loading: subagentsLoading,
        emptyText: intl.formatMessage({ id: "chat.slash.subagents.empty" }),
        errorText: subagentsError,
      },
    ],
    [
      commandsLength,
      filteredCommandSuggestions,
      filteredSkillSuggestions,
      filteredSubagentSuggestions,
      intl,
      skillsError,
      skillsLoading,
      subagentsError,
      subagentsLoading,
    ],
  );
}
