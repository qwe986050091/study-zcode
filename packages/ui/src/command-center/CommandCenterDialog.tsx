// ============================================================================
// CommandCenterDialog.tsx — 全局命令中心（命令 / 会话 / 文件三类搜索）
//
// 职责边界：
//   - 只做检索与跳转：不执行任务编排，不直接读写工作区文件（走 fileService）。
//   - 关闭态不参与聊天流式重算：所有输入降为空数组/null（见 effective* 系列）。
//   - cmdk 只负责键盘导航与高亮，过滤规则全部由本文件实现（shouldFilter=false）。
//
// 三种结果源与各自的 limit：
//   commands      来自 props，按 section 分组；展开只看当前 section。
//   conversations useGlobalTaskList 提供，按 workspaceTabs 范围收敛。
//   files         首次搜索时拉一次 packed 列表，之后本地过滤。
//
// 不变量（INV）。每条注明「守住它的位置」与「改错故障」。
//
// INV-01 关闭时必须把 commands / tabs / changeSummary 降为空，但不能提前 return。
//   守住它的位置：effectiveCommands / effectiveWorkspaceTabs / effectiveActiveTaskChangeSummary。
//   改错故障：关闭态仍跟随 streaming 重算三类结果，隐藏弹窗在每个 token 批次重建。
//
// INV-02 远程会话标签不参与命令中心的会话搜索。
//   守住它的位置：effectiveWorkspaceTabs 的 !isRemoteConversationWorkspace 过滤。
//   改错故障：对远程 tab 发本地任务查询，返回空结果并让搜索看起来「没找到」。
//
// INV-03 显式前缀（> / # / @）优先于手动 scope。
//   守住它的位置：activeScope = explicitScope ? resolved.scope : manualScope。
//   改错故障：输入 #foo 却仍按手动选择的「命令」过滤，结果与输入不符。
//
// INV-04 setScope 在存在显式前缀时必须把前缀从输入中摘掉。
//   守住它的位置：setScope 里的 if (resolvedQuery.explicitScope) setRawQuery(searchQuery)。
//   改错故障：点 scope 按钮后前缀仍生效，按钮看起来被忽略。
//
// INV-05 hasSearchQuery 决定「历史 / 默认区」与「搜索结果区」的互斥。
//   守住它的位置：showHistory 与 CommandList 的三元分支。
//   改错故障：有搜索词时仍展示历史 chip，用户以为历史本身就是搜索结果。
//
// INV-06 会话与文件搜索都必须同时满足 open、有搜索词、scope 匹配。
//   守住它的位置：searchConversations / searchFiles 的三段与。
//   改错故障：关闭态触发文件拉取，或命令 scope 下仍在搜文件。
//
// INV-07 文件列表每个工作区只拉一次，靠 loadedWorkspaceKey 标记。
//   守住它的位置：if (!searchFiles || loadedWorkspaceKey === workspaceKey) return。
//   改错故障：每次输入都重新请求整棵文件树，搜索变成持续 IO。
//
// INV-08 工作区切换必须清空文件、错误、loading 与已加载标记。
//   守住它的位置：依赖 [workspaceKey] 的 effect。
//   改错故障：新工作区首帧展示旧工作区的文件，点击后打开错误路径。
//
// INV-09 异步拉取必须用 cancelled 标记拦截晚到的成功与失败。
//   守住它的位置：effect cleanup 与 then/catch/finally 里的 cancelled 判断。
//   改错故障：快速切换工作区时旧响应覆盖新列表，且 loading 卡在 true。
//
// INV-10 远程连接类错误必须经 formatRemoteConnectionError 本地化。
//   守住它的位置：catch 里 remoteCode 的三元。
//   改错故障：用户看到原始 RPC 错误码，无法判断是凭据问题还是网络问题。
//
// INV-11 文件结果只保留 type=file，多关键词之间是 AND。
//   守住它的位置：filterWorkspaceFileEntries 的 type 过滤与 parts.every。
//   改错故障：目录出现在结果里点开报错；或 OR 匹配让无关文件占满前 80 条。
//
// INV-12 文件结果上限固定 80，必须在过滤后截断。
//   守住它的位置：filter 链末尾的 slice(0, COMMAND_CENTER_FILE_RESULT_LIMIT)。
//   改错故障：先截断再过滤会让大仓库只剩几条命中。
//
// INV-13 任务行的身份 key 必须是「工作区身份或路径 + taskId」。
//   守住它的位置：buildTaskResultRows 里两处 taskKey 拼接。
//   改错故障：不同工作区的同名 taskId 被合并成一行，点击跳到错误任务。
//
// INV-14 同任务的多条搜索片段必须归一后去重，且保留原始片段文本。
//   守住它的位置：getUniqueTaskSearchSnippets 的 seen + uniqueSnippets。
//   改错故障：同一句话因省略号差异展示两遍，或去重后丢掉高亮所需原文。
//
// INV-15 有搜索词但片段为空的任务不产生行。
//   守住它的位置：snippets.length === 0 时只在无查询时 push 的逻辑。
//   改错故障：标题命中但无片段的会话会出现在结果里，看起来像搜索失灵。
//
// INV-16 最近任务必须排除当前 activeTaskId。
//   守住它的位置：recentTaskRows 的 task.taskId !== activeTaskId。
//   改错故障：用户在当前会话里又看到「最近任务」中的自己，重复且易误点。
//
// INV-17 最近改动排序：lastTurnIndex 降序 → writeCount 降序 → 路径字典序。
//   守住它的位置：compareRecentChangedFiles 的三段返回。
//   改错故障：同轮次改动顺序随机，每次打开命令中心列表都在变。
//
// INV-18 命令执行必须先记历史、再关闭、最后执行，并捕获异步失败。
//   守住它的位置：runCommand 的三步顺序与 Promise.resolve(...).catch。
//   改错故障：先关闭再记历史会丢失当前 query；不 catch 会让命令失败静默。
//
// INV-19 会话跳转的 snippet 有三段回退：行片段 → 任务片段 → undefined。
//   守住它的位置：selectTask 里 onSearchResultHighlightRequest 的 snippet 字段。
//   改错故障：多片段结果跳转后永远高亮第一段，用户看不出点的是哪条。
//
// INV-20 文件跳转必须用 entry.path（绝对路径），目录展示才用 relativePath。
//   守住它的位置：selectFile 与 getWorkspaceFileDirectory 的分工。
//   改错故障：把相对路径交给 code viewer，在非工作区根目录下打不开文件。
//
// INV-21 展开状态是「一次展开、本次会话内保持」，按 section 记录。
//   守住它的位置：expandedSections Set 与 renderMoreRow 的 add。
//   改错故障：每输入一个字符就折回 3 条，用户无法浏览长结果。
//
// INV-22 scope 或搜索词变化时必须重置展开状态。
//   守住它的位置：依赖 [activeScope, searchQuery] 的 effect。
//   改错故障：从文件切到命令后旧 section 仍处于展开，短列表出现空档。
//
// INV-23 打开时读取历史，关闭时清空输入、scope、展开与历史展开态。
//   守住它的位置：依赖 [open, workspaceKey] 的 effect 两个分支。
//   改错故障：下次打开残留上次的 query 与展开面板，像没有关闭过。
//
// INV-24 cmdk 的 value 必须全局唯一，不能只用展示标题。
//   守住它的位置：命令 value 拼 title+keywords；任务拼 identity+taskId；文件拼 name+relativePath。
//   改错故障：同名任务/文件按方向键时两行同时高亮，回车选中错误的那个。
//
// INV-25 cmdk 必须关闭内置过滤（shouldFilter=false）。
//   守住它的位置：<Command shouldFilter={false} loop>。
//   改错故障：cmdk 再按 value 过滤一次，与本地结果不一致，出现「列表有但选中被跳过」。
//
// INV-26 搜索历史 chip 的 key 必须包含 updatedAt。
//   守住它的位置：CommandCenterSearchHistory 的 key 模板。
//   改错故障：同一 scope+query 多次搜索时 React 复用旧节点，点击回调指向旧时间。
//
// INV-27 弹层位置必须在 Linux variant 下重新声明 top。
//   守住它的位置：commandCenterDialogClassName 里的 platform-linux-desktop 类。
//   改错故障：平台补偿覆盖 top-16，命令中心掉到窗口中部，不再是顶部搜索浮层。
//
// ============================================================================
import { getRemoteConnectionFailureCode } from "@/lib/remoteWorkspaceServiceError.js";
import { formatRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import { isRemoteConversationWorkspace } from "@/conversation-workspace-target/purpose.js";
/* eslint-disable max-lines -- 聚合命令、任务、文件三类搜索结果，后续可按 result section 拆分。 */
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import { fetchWorkspaceFileEntriesPacked } from "@/workspace-file-search/fetchWorkspaceFileEntries.js";
import { Command as CommandPrimitive } from "cmdk";
import {
  ChevronDownIcon,
  FileIcon,
  ListIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  RocketIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import type { WorkspaceFileEntry, ZCodeTaskChangeSummary, ZCodeTaskMeta } from "@zcode/shared";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command.js";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import { HighlightedMatchText } from "@/quickpick/HighlightedMatchText.js";
import { QUICK_PICK_SECTION_ORDER, type QuickPickCommand } from "@/quickpick/quickPickCommands.js";
import { QUICK_PICK_ICON_BY_KIND } from "@/quickpick/quickPickCommandIcons.js";
import {
  quickPickCommandClassName,
  quickPickDialogClassName,
  quickPickItemClassName,
  quickPickListClassName,
  quickPickMetadataClassName,
  quickPickShortcutPillClassName,
} from "@/quickpick/quickPickStyles.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { ChatSearchResultHighlightRequest } from "@/v4/legacyChatViewTypes.js";
import {
  clearCommandCenterSearchHistory,
  pushCommandCenterSearchHistory,
  readCommandCenterSearchHistory,
  type CommandCenterSearchHistoryEntry,
  type CommandCenterSearchScope,
} from "@/command-center/commandCenterSearchHistory.js";

// [性能] 空数组必须是模块级常量：关闭态每次渲染都传新 [] 会让子组件的 memo 全部失效。
const EMPTY_QUICK_PICK_COMMANDS: QuickPickCommand[] = [];
const EMPTY_COMMAND_CENTER_WORKSPACE_TABS: WorkspaceTabState[] = [];
const COMMAND_CENTER_SECTION_LIMIT = 3;
const COMMAND_CENTER_CONTEXT_SECTION_LIMIT = 3;
// [权衡] 80 条是「够翻」与「不卡键盘导航」的折中：
// cmdk 每行都会注册键盘事件，再多会让长按方向键明显掉帧。
const COMMAND_CENTER_FILE_RESULT_LIMIT = 80;
const COMMAND_CENTER_TASK_RESULT_LIMIT = 80;
// [失败路径] 这里必须覆盖 DialogContent 的默认居中定位：
// Linux 桌面端会为自绘标题栏补偿 top，不重新声明会让浮层掉到中部。
const commandCenterDialogClassName = cn(
  quickPickDialogClassName,
  // Linux 桌面端的通用 DialogContent 会给居中弹窗补偿自绘标题栏高度。
  // Command Center 是顶部搜索浮层，必须在 Linux variant 下重新声明 top，
  // 否则平台补偿会覆盖 top-16/sm:top-20，导致弹层掉到窗口中部。
  "top-16 max-h-[calc(100dvh-4.5rem)] -translate-y-0 sm:top-20 sm:max-h-[calc(100dvh-6rem)]",
  "platform-linux-desktop:top-16 sm:platform-linux-desktop:top-20",
);
// [权衡] 用 min(440px, calc(100dvh - 15rem)) 限高：
// 固定 440px 在矮窗口里会超出可视区，纯 vh 又会让超大屏列表过长。
const commandCenterListClassName = cn(
  quickPickListClassName,
  "max-h-[min(440px,calc(100dvh-15rem))]",
);

type CommandCenterSectionId = "commands" | "conversations" | "files";
type TaskSearchResultItem = ZCodeTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
};
type TaskChangedFileSummary = ZCodeTaskChangeSummary["files"][number];
type TaskSearchResultRow = {
  key: string;
  task: TaskSearchResultItem;
  searchSnippet?: string;
  snippetIndex?: number;
};

// [失败路径] 没有斜杠时返回空串而不是 "."：
// 根目录文件不需要展示目录前缀，空串让调用方直接用条件渲染。
function getWorkspaceFileDirectory(entry: WorkspaceFileEntry): string {
  const slashIndex = entry.relativePath.lastIndexOf("/");
  return slashIndex === -1 ? "" : entry.relativePath.slice(0, slashIndex);
}

// [权衡] 只拼 name + relativePath：
// 绝对路径包含工作区前缀，所有结果都会命中同一个无关关键词。
function buildWorkspaceFileSearchText(entry: WorkspaceFileEntry): string {
  return `${entry.name} ${entry.relativePath}`.toLocaleLowerCase();
}

// [失败路径] 空查询返回空数组而不是全部文件：
// 有查询才调用本函数；返回全部会让「只输入空格」时瞬间渲染 80 条无关文件。
function filterWorkspaceFileEntries(
  entries: readonly WorkspaceFileEntry[],
  query: string,
): WorkspaceFileEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  // [权衡] 多关键词按 AND 处理：
  // 用户输入「src util」通常是在逐步收窄，OR 会让结果越来越多。
  const parts = normalizedQuery.split(/\s+/).filter(Boolean);
  return entries
    // [失败路径] 目录被排除：
    // 命令中心的文件结果直接交给 code viewer，打开目录只会得到错误页。
    .filter((entry) => entry.type === "file")
    .filter((entry) => {
      const searchText = buildWorkspaceFileSearchText(entry);
      return parts.every((part) => searchText.includes(part));
    })
    .slice(0, COMMAND_CENTER_FILE_RESULT_LIMIT);
}

// [失败路径] 先去掉首尾省略号再折叠空白：
// 后端在不同片段位置会加 ... 前缀/后缀，不剥离会让同一句话去重失败。
function normalizeSnippetForDedupe(snippet: string): string {
  return snippet
    .replace(/^\.\.\./, "")
    .replace(/\.\.\.$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

// [失败路径] searchSnippets 优先于单个 searchSnippet：
// 新接口下发多片段，旧字段只是兼容；反过来会丢掉第 2 条之后的命中。
function getUniqueTaskSearchSnippets(task: TaskSearchResultItem): string[] {
  const snippets = task.searchSnippets?.length
    ? task.searchSnippets
    : task.searchSnippet
      ? [task.searchSnippet]
      : [];
  // [性能] 用归一化文本做 Set 键而不是原串：
  // 同一句话在不同命中位置可能带不同省略号，原串比较无法去重。
  const seen = new Set<string>();
  const uniqueSnippets: string[] = [];
  for (const snippet of snippets) {
    const normalized = normalizeSnippetForDedupe(snippet);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    uniqueSnippets.push(snippet);
  }

  return uniqueSnippets;
}

// [失败路径] 空白标题回退「未命名」：
// 直接渲染空串会让该行只剩图标与时间，用户无法判断是哪个任务。
function getTaskTitle(task: ZCodeTaskMeta, untitledLabel: string): string {
  return task.title.trim() || untitledLabel;
}

// [事务] 三级排序必须稳定：最后一层用路径字典序兜底，
// 否则同一轮写入次数相同的文件顺序取决于输入顺序，列表会抖动。
function compareRecentChangedFiles(left: TaskChangedFileSummary, right: TaskChangedFileSummary) {
  if (right.lastTurnIndex !== left.lastTurnIndex) {
    return right.lastTurnIndex - left.lastTurnIndex;
  }
  if (right.writeCount !== left.writeCount) {
    return right.writeCount - left.writeCount;
  }
  return left.path.localeCompare(right.path);
}

// [失败路径] trimStart 而不是 trim：
// 前缀只允许出现在开头，先 trim 会把「  #foo」也当成显式 scope，与用户输入的中间空格无关。
function resolveQueryScope(rawQuery: string): {
  query: string;
  scope: CommandCenterSearchScope;
  explicitScope: boolean;
} {
  const trimmed = rawQuery.trimStart();
  const prefix = trimmed[0];
  // [事务] 三种前缀各自映射一个 scope 且标记 explicit：
  // 这个标记是 setScope 清除前缀、以及 activeScope 覆盖 manualScope 的唯一依据。
  if (prefix === ">") {
    return { query: trimmed.slice(1).trimStart(), scope: "commands", explicitScope: true };
  }
  if (prefix === "#") {
    return { query: trimmed.slice(1).trimStart(), scope: "conversations", explicitScope: true };
  }
  if (prefix === "@") {
    return { query: trimmed.slice(1).trimStart(), scope: "files", explicitScope: true };
  }

  // [失败路径] 无前缀时返回 trim 后的原串并标记非显式：
  // 这里不能顺手把 manualScope 合进来，否则前缀与手动 scope 的优先级会纠缠。
  return { query: rawQuery.trim(), scope: "all", explicitScope: false };
}

// [失败路径] 空查询返回 true（命令全量展示）：
// 这与文件/会话的「空查询不搜」不同，命令面板需要默认可用。
function matchesCommand(command: QuickPickCommand, title: string, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const searchText = `${title} ${command.keywords.join(" ")}`.toLocaleLowerCase();
  return normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => searchText.includes(part));
}

// [事务] 先按任务身份合并片段，再展开成行：
// 同一任务的多个命中片段要共享标题与工作区信息，不能各自复制一份任务对象。
function buildTaskResultRows(params: {
  tasks: readonly TaskSearchResultItem[];
  query: string;
}): TaskSearchResultRow[] {
  const rows: TaskSearchResultRow[] = [];
  // [并发] 合并用 Map 而不是数组去重：
  // 任务列表可能上千条，indexOf 的 O(n²) 会在输入首个字符时明显卡顿。
  const taskByKey = new Map<string, TaskSearchResultItem>();

  for (const task of params.tasks) {
    // [失败路径] 身份优先、路径兜底：
    // 远程与本地可能存在同名路径，仅用路径会让两个工作区共用一个 key。
    const taskKey = `${task.workspaceIdentity?.trim() || task.workspacePath}:${task.taskId}`;
    const existingTask = taskByKey.get(taskKey);
    if (!existingTask) {
      taskByKey.set(taskKey, task);
      continue;
    }

    taskByKey.set(taskKey, {
      ...existingTask,
      searchSnippets: [
        ...getUniqueTaskSearchSnippets(existingTask),
        ...getUniqueTaskSearchSnippets(task),
      ],
    });
  }

  for (const task of taskByKey.values()) {
    const taskKey = `${task.workspaceIdentity?.trim() || task.workspacePath}:${task.taskId}`;
    // [失败路径] 无查询时不展开片段：默认区按任务展示，
    // 若这里仍展开，同一任务可能因多个片段重复出现多行。
    const snippets = params.query ? getUniqueTaskSearchSnippets(task) : [];
    if (snippets.length === 0) {
      rows.push({ key: taskKey, task });
      continue;
    }

    snippets.forEach((snippet, snippetIndex) => {
      rows.push({
        key: `${taskKey}:${snippetIndex}`,
        task,
        searchSnippet: snippet,
        snippetIndex,
      });
    });
  }

  // [性能] 行 key 在展开时一次生成：
  // 下游只读 row.key，不再重复拼接，避免同一行在不同调用点得到不同 key。
  return rows;
}

// [权衡] 用 role=tab + aria-selected 而不是 aria-pressed：
// scope 是一组互斥视图切换，语义上更接近标签页；键盘左右切换由外层 tablist 负责。
export function CommandCenterScopeButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        // scope tabs 是可交互的范围切换按钮，按 DESIGN.md 语义角色属于
        // common buttons，应使用 text-ui-base；不能用 text-ui-xs（10px，badge/
        // counter 专用），否则字号过小。同时与上方搜索输入框 (text-ui-base) 保持一致。
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-ui-base font-medium leading-none transition-colors",
        active
          ? "border-border bg-selected text-foreground"
          : "border-transparent text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
      )}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

/**
 * 搜索历史 chip 的 scope 前缀（如 commands → ">"）。
 * 提取为独立函数以便 CommandCenterSearchHistory 组件复用。
 */
// [失败路径] default 返回空串：
// all 没有前缀，回填历史时直接写 query，不能凭空造一个字符。
function scopeToPrefix(scope: CommandCenterSearchScope): string {
  switch (scope) {
    case "commands":
      return ">";
    case "conversations":
      return "#";
    case "files":
      return "@";
    default:
      return "";
  }
}

/**
 * 对话搜索结果的时间戳。
 * 独立组件便于复用与单测；按 DESIGN.md 语义角色，列表项里的相对时间属于
 * secondary copy，使用 text-ui-sm（不用 text-ui-xs，避免偏小）。
 */
// [权衡] 时间戳抽成独立组件：
// 列表行与搜索结果都要用同一宽度与截断行为，内联样式很容易在两处漂移。
export function CommandCenterConversationTimestamp({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "max-w-12 shrink-0 truncate font-sans text-ui-sm tracking-normal text-foreground-subtlest",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * 命令中心搜索历史区：分区标题 + 历史 chip + 清除/展开按钮。
 * 从 CommandCenterDialog 内联 JSX 抽取，便于复用与单测。
 *
 * 字号语义（DESIGN.md）：
 * - 分区标题：text-ui-sm（section label / helper text）
 * - 历史 chip 搜索词：text-ui-base（可读内容，与列表主体一致）
 * - chip 内 scope 前缀：text-ui-xs（badge 标记，比主体小一级形成层级）
 */
// [事务] 历史区是受控组件：读取、清除、展开全部由父组件执行，
// 组件内只负责渲染与透传点击，保证历史存储只有一处写入口。
export function CommandCenterSearchHistory({
  entries,
  expanded,
  onToggleExpanded,
  onPickEntry,
  onClear,
  historyLabel,
  clearLabel,
  expandLabel,
  collapseLabel,
}: {
  entries: CommandCenterSearchHistoryEntry[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onPickEntry: (entry: CommandCenterSearchHistoryEntry) => void;
  onClear: () => void;
  historyLabel: string;
  clearLabel: string;
  expandLabel: string;
  collapseLabel: string;
}) {
  // [权衡] 阈值 6 与两行 chip 高度对齐：
  // 恰好超出两行才需要展开按钮，少于两行时按钮会平白占用右上角空间。
  const canExpand = entries.length > 6;
  return (
    <>
      <div className="flex items-center gap-2 px-3 pt-2 text-ui-sm font-medium text-foreground-subtle">
        <span>{historyLabel}</span>
        <button
          type="button"
          aria-label={clearLabel}
          className="ml-auto inline-grid size-6 place-items-center rounded-md text-foreground-subtlest hover:bg-surface-hover hover:text-foreground"
          onClick={onClear}
        >
          <Trash2Icon className="size-3.5" />
        </button>
      </div>
      <div
        className={cn(
          "relative flex flex-wrap gap-1.5 overflow-hidden px-3 pt-1 pb-2 pr-11",
          expanded ? "" : "max-h-[34px]",
        )}
      >
        {entries.map((entry) => {
          const prefix = scopeToPrefix(entry.scope);
          return (
            <button
              key={`${entry.scope}:${entry.query}:${entry.updatedAt}`}
              type="button"
              // text-ui-base 随 --ui-font-size（12–20px）缩放，不能用固定 h-5
              // 否则 20px 字号下内容区（20px - 2px 边框 = 18px）装不下字体行盒，
              // 配合外层 overflow-hidden 会裁切文字。改用 min-h-5 + py-0.5 + leading-none
              // 让高度随字号增长，保证 12–20px 全范围可读。
              className="inline-flex min-h-5 max-w-44 shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 leading-none text-ui-base text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
              onClick={() => onPickEntry(entry)}
            >
              {prefix ? <span className="font-mono text-ui-xs text-brand">{prefix}</span> : null}
              <span className="min-w-0 truncate">{entry.query}</span>
            </button>
          );
        })}
        {canExpand ? (
          <button
            type="button"
            aria-label={expanded ? collapseLabel : expandLabel}
            className="absolute top-1 right-3 inline-grid size-6 place-items-center rounded-md text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            onClick={onToggleExpanded}
          >
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", expanded ? "rotate-180" : "")}
            />
          </button>
        ) : null}
      </div>
    </>
  );
}

// [性能] memo 包住整个弹窗：
// 父级在工作区列表刷新时会频繁重渲染，props 不变时应直接跳过。
export const CommandCenterDialog = memo(function CommandCenterDialogComponent({
  open,
  commands,
  workspaceAbsPath,
  workspaceIdentity,
  activeTaskId,
  activeTaskChangeSummary,
  workspaceTabs,
  onOpenChange,
  onSelectTask,
  onSearchResultHighlightRequest,
  onOpenCodeViewer,
}: {
  open: boolean;
  commands: QuickPickCommand[];
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  activeTaskId?: string | null;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  workspaceTabs: WorkspaceTabState[];
  onOpenChange: (open: boolean) => void;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onSearchResultHighlightRequest?: (
    request: Omit<ChatSearchResultHighlightRequest, "requestId">,
  ) => void;
  onOpenCodeViewer: (source: CodeViewerSource) => void;
}) {
  const { fileService } = useServices();
  const { intl } = useZCodeIntl();
  // [失败路径] 身份优先、路径兜底必须与任务 key 完全一致：
  // 两处规则不同会让历史与最近任务指向不同的「同一个工作区」。
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  // [事务] 输入保持原始串（含前缀）：
  // 前缀是用户可见输入的一部分，解析结果单独存 resolvedQuery，不能把两者合一。
  const [rawQuery, setRawQuery] = useState("");
  // [失败路径] 默认 all 而不是上次选择：
  // 命令中心的默认心智是「全局搜」，记忆 scope 会让用户以为搜不到命令。
  const [manualScope, setManualScope] = useState<CommandCenterSearchScope>("all");
  // [事务] 用 Set 而不是三个布尔：
  // section 数量未来会增加，布尔会迫使每个新增 section 都改一遍状态声明。
  const [expandedSections, setExpandedSections] = useState<Set<CommandCenterSectionId>>(
    () => new Set(),
  );
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<CommandCenterSearchHistoryEntry[]>([]);
  // [资源] 文件表只驻留当前工作区：
  // 切换工作区立即清空，避免大仓库的条目在内存里累积。
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileEntry[]>([]);
  const [workspaceFilesLoading, setWorkspaceFilesLoading] = useState(false);
  const [workspaceFilesError, setWorkspaceFilesError] = useState<string | null>(null);
  // [并发] 用 key 而不是布尔：
  // 布尔只能表达「加载过」，无法区分「加载的是另一个工作区」，会让新工作区误跳过拉取。
  const [loadedWorkspaceKey, setLoadedWorkspaceKey] = useState<string | null>(null);
  // 性能修复：Command Center 关闭时不需要跟随 chat streaming 重算命令、任务和 recent changes。
  // 保留 hooks 顺序，但把关闭态输入降为空，避免隐藏弹窗在每个 token 批次重建结果区。
  // [性能] 关闭态换成模块级空数组：
  // props 里的 commands 每次父级渲染都是新引用，降空后下游 useMemo 才能真正命中。
  const effectiveCommands = open ? commands : EMPTY_QUICK_PICK_COMMANDS;
  // [并发] 过滤在这里完成而不是在 useGlobalTaskList 内部：
  // 所有下游（会话搜索、最近任务、工作区标签）必须看到同一份已过滤集合。
  const effectiveWorkspaceTabs = useMemo(
    () =>
      open
        // [失败路径] 远程会话直接排除：
        // 远程任务不在本机索引里，保留只会让会话搜索出现「永远空结果」。
        ? workspaceTabs.filter((tab) => !isRemoteConversationWorkspace(tab))
        : EMPTY_COMMAND_CENTER_WORKSPACE_TABS,
    [open, workspaceTabs],
  );
  // [性能] 关闭态置 null 而不是空对象：
  // 空对象仍会让 recentChangeRows 产生一次排序，且 memo 依赖每次都变。
  const effectiveActiveTaskChangeSummary = open ? activeTaskChangeSummary : null;
  // [性能] 只依赖 rawQuery：
  // 解析是纯字符串操作，放在渲染期会让每次 streaming 重渲染都多算一次。
  const resolvedQuery = useMemo(() => resolveQueryScope(rawQuery), [rawQuery]);
  // [事务] 这一行是「前缀 > 按钮」的唯一表达：
  // 任何组件里再写一次 scope 优先级判断，都会与这里产生分歧。
  const activeScope = resolvedQuery.explicitScope ? resolvedQuery.scope : manualScope;
  const searchQuery = resolvedQuery.query;
  const hasSearchQuery = searchQuery.trim().length > 0;
  // [失败路径] 必须带 open：
  // 关闭态仍发起搜索会让 useGlobalTaskList 持续工作，违背 INV-01 的零开销目标。
  const searchConversations =
    open && hasSearchQuery && (activeScope === "all" || activeScope === "conversations");
  // [事务] 与 searchConversations 同构：
  // 两者条件必须平行，否则会出现「切到文件 scope 但会话仍在搜」的错配。
  const searchFiles = open && hasSearchQuery && (activeScope === "all" || activeScope === "files");
  // [失败路径] 不搜索时传空数组而不是 undefined：
  // hook 内部依赖数组长度，undefined 会让它退回全量工作区。
  const searchWorkspaceTabs = useMemo(
    () => (searchConversations ? effectiveWorkspaceTabs : []),
    [effectiveWorkspaceTabs, searchConversations],
  );
  // [事务] 最近任务只看当前工作区：
  // 跨工作区的「最近」对用户没有意义，反而会让跳转后的上下文突变。
  const currentWorkspaceTabs = useMemo(
    () =>
      effectiveWorkspaceTabs.filter(
        (tab) => (tab.workspaceIdentity?.trim() || tab.workspacePath) === workspaceKey,
      ),
    [effectiveWorkspaceTabs, workspaceKey],
  );
  // [失败路径] 有搜索词时置空：
  // 最近任务与搜索结果互斥，继续传工作区会让 hook 白跑一轮查询。
  const recentTaskWorkspaceTabs = useMemo(
    () => (open && !hasSearchQuery ? currentWorkspaceTabs : []),
    [currentWorkspaceTabs, hasSearchQuery, open],
  );
  // [事务] 搜索查询与展示查询分开两个 hook 实例：
  // 前者跟随 searchQuery 与 scope，后者固定空查询取最近任务，混用会互相打架。
  const taskList = useGlobalTaskList({
    kind: "active",
    workspaceTabs: searchWorkspaceTabs,
    sortBy: "updated",
    searchQuery,
    expanded: false,
    collapsedLimit: COMMAND_CENTER_TASK_RESULT_LIMIT,
  });
  // [失败路径] collapsedLimit 要额外 +1：
  // 结果会再过滤掉 activeTaskId，不加一会让列表正好少一条。
  const recentTaskList = useGlobalTaskList({
    kind: "active",
    workspaceTabs: recentTaskWorkspaceTabs,
    sortBy: "updated",
    searchQuery: "",
    expanded: false,
    collapsedLimit:
      activeScope === "conversations"
        ? COMMAND_CENTER_TASK_RESULT_LIMIT + (activeTaskId ? 1 : 0)
        : COMMAND_CENTER_CONTEXT_SECTION_LIMIT + (activeTaskId ? 1 : 0),
  });
  // [性能] 一次建 Map 供所有结果行查询：
  // 每行各自 find 会让会话结果在行数 × 工作区数上重复扫描。
  const workspaceLabelByKey = useMemo(
    () =>
      new Map(
        effectiveWorkspaceTabs.map((tab) => [
          tab.workspaceIdentity?.trim() || tab.workspacePath,
          tab.label,
        ]),
      ),
    [effectiveWorkspaceTabs],
  );
  // [事务] title 在这里格式化一次并缓存：
  // matchesCommand 与渲染都要用同一份标题，分别格式化会让高亮文本与匹配文本不一致。
  const commandOptions = useMemo(
    () =>
      effectiveCommands
        .map((command) => ({
          command,
          title: intl.formatMessage({ id: command.titleId }),
        }))
        .filter(({ command, title }) => matchesCommand(command, title, searchQuery)),
    [effectiveCommands, intl, searchQuery],
  );
  // [失败路径] 按 QUICK_PICK_SECTION_ORDER 映射后再过滤空组：
  // 直接按数据分组会让 section 顺序取决于命令注册顺序，每次启动可能不同。
  const commandOptionsBySection = useMemo(
    () =>
      QUICK_PICK_SECTION_ORDER.map((sectionId) => ({
        sectionId,
        commands: commandOptions.filter(({ command }) => command.sectionId === sectionId),
      })).filter((section) => section.commands.length > 0),
    [commandOptions],
  );
  // [失败路径] 依赖 taskList.items 而不是整个 taskList：
  // loading 等字段变化会重建所有行，导致 cmdk 选中项被重置。
  const conversationRows = useMemo(
    () => buildTaskResultRows({ tasks: taskList.items, query: searchQuery }),
    [searchQuery, taskList.items],
  );
  // [性能] 过滤只依赖搜索词与文件表：
  // 把 activeScope 也放进依赖会让切换 scope 时重算同一份结果。
  const fileRows = useMemo(
    () => filterWorkspaceFileEntries(workspaceFiles, searchQuery),
    [searchQuery, workspaceFiles],
  );
  // [并发] 先复制再排序：
  // activeTaskChangeSummary.files 是上层持有的数组，原地排序会改动父级数据。
  const recentChangeRows = useMemo(
    () => [...(effectiveActiveTaskChangeSummary?.files ?? [])].sort(compareRecentChangedFiles),
    [effectiveActiveTaskChangeSummary],
  );
  // [权衡] 预览与完整列表分开：
  // 默认区只显示 3 条，但展开后需要完整排序结果，共用一份切片会丢掉后续条目。
  const recentChangePreviewRows = useMemo(
    () => recentChangeRows.slice(0, COMMAND_CENTER_CONTEXT_SECTION_LIMIT),
    [recentChangeRows],
  );
  // [失败路径] 排除当前任务发生在截断之前：
  // 先截断再排除会让「最近任务」只剩 2 条甚至空。
  const recentTaskRows = useMemo(
    () => recentTaskList.items.filter((task) => task.taskId !== activeTaskId),
    [activeTaskId, recentTaskList.items],
  );
  // [事务] 预览切片与「更多」按钮共用同一上限：
  // 两处各写一个数字会出现「显示 3 条但仍提示还有更多」的错位。
  const recentTaskPreviewRows = useMemo(
    () => recentTaskRows.slice(0, COMMAND_CENTER_CONTEXT_SECTION_LIMIT),
    [recentTaskRows],
  );
  useEffect(() => {
    if (open) {
      // [事务] 打开时只读不写：
      // 读取动作不能顺手清理或排序历史，存储顺序就是用户最近使用的顺序。
      setHistoryEntries(readCommandCenterSearchHistory(workspaceKey));
      return;
    }

    // [事务] 关闭时清空输入：
    // 下一次打开应当是全新搜索，残留 query 会让用户误以为命令中心没关掉。
    setRawQuery("");
    setManualScope("all");
    setExpandedSections(new Set());
    setHistoryExpanded(false);
  }, [open, workspaceKey]);

  useEffect(() => {
    setExpandedSections(new Set());
  // [失败路径] scope 变化也要重置展开：
  // 文件区展开后切到命令区，旧 Set 仍含 files，切回时列表会突然变成全量。
  }, [activeScope, searchQuery]);

  useEffect(() => {
    setWorkspaceFiles([]);
    setWorkspaceFilesError(null);
    setWorkspaceFilesLoading(false);
    // [并发] 清空加载标记必须与清空文件同时进行：
    // 只清文件不清标记会让新工作区跳过拉取，列表永远是空的。
    setLoadedWorkspaceKey(null);
  }, [workspaceKey]);

  useEffect(() => {
    // [资源] 早退条件同时覆盖「不需要」与「已加载」：
    // 拆成两个 effect 会让依赖数组难以表达，也容易出现重复请求。
    if (!searchFiles || loadedWorkspaceKey === workspaceKey) {
      return;
    }

    // [并发] 这是本轮请求的代号：
    // cleanup 只翻转自己那一轮的标记，晚到的旧响应据此丢弃，不影响新一轮。
    let cancelled = false;
    setWorkspaceFilesLoading(true);
    setWorkspaceFilesError(null);
    void fetchWorkspaceFileEntriesPacked(fileService, workspaceAbsPath)
      .then((result) => {
        // Host 返回列式 packed 字符串（避免大数组结构化克隆），此处一次性解包。
        // [资源] packed 列式数据只解包一次：
        // 解包结果存 state，过滤与渲染都复用；每次输入重新解包会在大仓库上明显卡顿。
        const entries = unpackWorkspaceFileEntries(result, workspaceAbsPath);
        if (cancelled) {
          return;
        }

        setWorkspaceFiles(entries);
        setLoadedWorkspaceKey(workspaceKey);
      })
      .catch((error) => {
        if (!cancelled) {
          // [失败路径] 先取远程错误码再决定文案：
          // 普通 Error 没有 code，只有远程连接类错误才需要走本地化映射。
          const remoteCode = getRemoteConnectionFailureCode(error);
          setWorkspaceFilesError(
            remoteCode
              ? formatRemoteConnectionError({
                  fallback: String(error),
                  reasonCode: remoteCode,
                  formatMessage: intl.formatMessage,
                })
              : String(error),
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setWorkspaceFilesLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fileService, loadedWorkspaceKey, searchFiles, workspaceAbsPath, workspaceKey, intl]);

  // [事务] scope 默认取当前 activeScope：
  // 这样命令/会话/文件三个入口不必各自传 scope，减少传错的可能。
  const rememberSearch = useCallback(
    (scope: CommandCenterSearchScope = activeScope) => {
      if (!hasSearchQuery) {
        return;
      }

      setHistoryEntries(
        pushCommandCenterSearchHistory({
          workspaceKey,
          query: searchQuery,
          scope,
        }),
      );
    },
    [activeScope, hasSearchQuery, searchQuery, workspaceKey],
  );

  // [性能] 抽出稳定引用：
  // 它作为多个 useCallback 的依赖，匿名函数会让整组回调每次渲染都重建。
  const closeDialog = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  // [事务] 顺序固定为「记历史 → 关闭 → 执行」：
  // 命令本身可能打开新弹窗或改变路由，先执行再关闭会把新界面一起关掉。
  const runCommand = useCallback(
    (command: QuickPickCommand) => {
      rememberSearch("commands");
      closeDialog();
      // [失败路径] 用 Promise.resolve 包住同步函数：
      // run 可能同步抛错，直接 .catch 会在注册 handler 之前就崩溃。
      void Promise.resolve(command.run()).catch((error) => {
        logger.error("[CommandCenter] 命令执行失败", {
          commandId: command.id,
          error,
        });
        toast(
          intl.formatMessage(
            { id: "quickPick.commandFailed" },
            {
              error: error instanceof Error ? error.message : String(error),
            },
          ),
        );
      });
    },
    [closeDialog, intl, rememberSearch],
  );

  // [事务] 高亮请求先于跳转发：
  // 目标会话挂载时就能读到 request，晚发会让首帧高亮丢失。
  const selectTask = useCallback(
    (row: TaskSearchResultRow) => {
      rememberSearch("conversations");
      onSearchResultHighlightRequest?.({
        taskId: row.task.taskId,
        workspacePath: row.task.workspacePath,
        workspaceIdentity: row.task.workspaceIdentity,
        query: searchQuery,
        // [失败路径] 三段回退中的 trim 之后为空要继续回退：
        // 空片段会让目标会话按空串高亮，实际什么都没选中。
        snippet: row.searchSnippet?.trim() || row.task.searchSnippet?.trim() || undefined,
        snippetIndex: row.snippetIndex,
      });
      onSelectTask(row.task.workspacePath, row.task.taskId, row.task.workspaceIdentity);
      closeDialog();
    },
    [closeDialog, onSearchResultHighlightRequest, onSelectTask, rememberSearch, searchQuery],
  );

  // [失败路径] 标题用 entry.name、路径用 entry.path：
  // name 可能重复，但路径必须绝对且唯一，code viewer 依赖它定位文件。
  const selectFile = useCallback(
    (entry: WorkspaceFileEntry) => {
      rememberSearch("files");
      onOpenCodeViewer({
        type: "file",
        title: entry.name,
        path: entry.path,
      });
      closeDialog();
    },
    [closeDialog, onOpenCodeViewer, rememberSearch],
  );

  // [失败路径] 相对路径只用于标题：
  // toWorkspaceRelativePath 在跨盘符时可能失败，标题回退到完整路径，不影响打开。
  const selectRecentChange = useCallback(
    (file: TaskChangedFileSummary) => {
      closeDialog();
      // [失败路径] 清单里的 path 是绝对路径：
      // 展示前统一转相对路径，否则整列被工作区前缀占满，文件名被截断。
      const relativePath = toWorkspaceRelativePath(workspaceAbsPath, file.path);
      onOpenCodeViewer({
        type: "file",
        title: getPathLeaf(relativePath) || relativePath,
        path: file.path,
      });
    },
    [closeDialog, onOpenCodeViewer, workspaceAbsPath],
  );

  // [事务] 最近任务与搜索结果走同一个 onSelectTask：
  // 两条入口若各自拼跳转参数，工作区身份与 taskId 的传参顺序很容易写反。
  const selectRecentTask = useCallback(
    (task: ZCodeTaskMeta) => {
      onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity);
      closeDialog();
    },
    [closeDialog, onSelectTask],
  );

  // [事务] 手动切 scope 必须清掉输入里的显式前缀（INV-04）：
  // 否则用户点了「文件」，输入仍是 #foo，实际 scope 依旧被前缀覆盖。
  const setScope = useCallback(
    (scope: CommandCenterSearchScope) => {
      setManualScope(scope);
      // [失败路径] 只在显式前缀时回写：
      // 普通输入也要 setRawQuery 会把光标推到结尾，破坏正在编辑的文本。
      if (resolvedQuery.explicitScope) {
        setRawQuery(searchQuery);
      }
    },
    [resolvedQuery.explicitScope, searchQuery],
  );

  // [事务] 三个 shouldShow 必须同时覆盖 all 与自身：
  // 只判断自身会让 all 态什么都不显示；只判断 all 会让 scope 切换失效。
  const shouldShowCommandSection = activeScope === "all" || activeScope === "commands";
  // [失败路径] 会话可见性与 hasSearchQuery 是两件事：
  // 前者决定 scope 过滤，后者决定是否进入搜索模式，不能合并成一个布尔。
  const shouldShowConversationSection = activeScope === "all" || activeScope === "conversations";
  // [权衡] 文件可见性同时影响空态与 loading 提示：
  // 把条件集中在这里，下游三处不需要各自重复判断。
  const shouldShowFileSection = activeScope === "all" || activeScope === "files";
  // [失败路径] 历史与搜索结果互斥：
  // 有搜索词时同时展示历史会让用户误把历史 chip 当作命中结果点击。
  const showHistory = !hasSearchQuery && historyEntries.length > 0;

  // [事务] 「更多」只在默认 scope 下渲染：
  // 具体 scope 本身已经是完整列表，再出现「更多」会让用户以为还有隐藏结果。
  const renderMoreRow = (sectionId: CommandCenterSectionId, count: number) => {
    // [失败路径] count 必须大于展示上限才显示：
    // 等于时点开只会看到同一批结果，按钮像是坏了。
    if (expandedSections.has(sectionId) || count <= COMMAND_CENTER_SECTION_LIMIT) {
      return null;
    }

    return (
      <button
        type="button"
        className="mt-0.5 flex min-h-7 w-full items-center gap-1.5 rounded-xl px-2.5 pl-8 text-left text-ui-base text-foreground-subtle hover:bg-menu-hover hover:text-foreground"
        onClick={() => setExpandedSections((current) => new Set(current).add(sectionId))}
      >
        {intl.formatMessage({ id: "commandCenter.moreResults" })}
        <ChevronDownIcon className="size-3.5" />
      </button>
    );
  };

  // [事务] rows 与 showEmpty 双参数化：
  // 默认区用预览 + 不显示空态，scope 详情用全量 + 显示空态，避免写两个近似的渲染块。
  const renderRecentChangesSection = ({
    rows = recentChangePreviewRows,
    showEmpty = false,
  }: {
    rows?: TaskChangedFileSummary[];
    showEmpty?: boolean;
  } = {}) => {
    // [失败路径] 有搜索词时最近改动整体隐藏：
    // 它与搜索结果不是同一语义，混排会让用户以为这些文件命中了关键词。
    if (hasSearchQuery || (rows.length === 0 && !showEmpty)) {
      return null;
    }

    return (
      <CommandGroup heading={intl.formatMessage({ id: "commandCenter.section.recentChanges" })}>
        {rows.length === 0 ? (
          <CommandEmpty className="px-4 py-5 text-foreground-subtle">
            {intl.formatMessage({ id: "commandCenter.empty.recentChanges" })}
          </CommandEmpty>
        ) : null}
        {rows.map((file) => {
          const relativePath = toWorkspaceRelativePath(workspaceAbsPath, file.path);
          // [失败路径] 图标按绝对路径解析扩展名：
          // 相对路径在无扩展名场景下可能误判，绝对路径是唯一稳定输入。
          const descriptor = resolveFileDisplayDescriptor(file.path);
          return (
            <CommandItem
              key={file.path}
              value={`${relativePath} +${file.added} -${file.removed}`}
              className={quickPickItemClassName}
              onSelect={() => selectRecentChange(file)}
            >
              <FileDisplayIcon src={descriptor.fileIconSrc} size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{relativePath}</span>
              <CommandShortcut className={quickPickMetadataClassName}>
                <span className="text-diff-added">+{file.added}</span>{" "}
                <span className="text-diff-removed">-{file.removed}</span>
              </CommandShortcut>
            </CommandItem>
          );
        })}
      </CommandGroup>
    );
  };

  // [事务] 与最近改动同构：
  // 两组默认区共用同一套「预览/空态」约定，保证展开与折叠行为一致。
  const renderRecentTasksSection = ({
    rows = recentTaskPreviewRows,
    showEmpty = false,
  }: {
    rows?: ZCodeTaskMeta[];
    showEmpty?: boolean;
  } = {}) => {
    if (hasSearchQuery || (rows.length === 0 && !showEmpty)) {
      return null;
    }

    return (
      <CommandGroup heading={intl.formatMessage({ id: "commandCenter.section.recentTasks" })}>
        {rows.length === 0 ? (
          <CommandEmpty className="px-4 py-5 text-foreground-subtle">
            {intl.formatMessage({ id: "commandCenter.empty.recentTasks" })}
          </CommandEmpty>
        ) : null}
        {rows.map((task) => {
          // [失败路径] 最近任务与搜索结果各自格式化标题：
          // 共用一次结果会跨 intl 变更复用旧语言，切语言后标题不更新。
          const title = getTaskTitle(task, intl.formatMessage({ id: "taskList.untitled" }));
          // Bugfix：cmdk 按 value 判断选中；标题可重复，必须用工作区身份和任务 ID 隔离重名行。
          return (
            <CommandItem
              key={`${task.workspaceIdentity?.trim() || task.workspacePath}:${task.taskId}`}
              value={`recent-task:${task.workspaceIdentity?.trim() || task.workspacePath}:${task.taskId}`}
              className={quickPickItemClassName}
              onSelect={() => selectRecentTask(task)}
            >
              <MessageSquareIcon className="size-3.5 text-foreground-subtle" />
              <span className="min-w-0 flex-1 truncate">{title}</span>
              <CommandShortcut className={quickPickMetadataClassName}>
                {formatTaskRelativeTime(task.updatedAt, intl)}
              </CommandShortcut>
            </CommandItem>
          );
        })}
      </CommandGroup>
    );
  };

  // [事务] 命令区是唯一在「默认态」与「搜索态」都会渲染的 section：
  // 它由 shouldShowCommandSection 独立控制，不能跟随 hasSearchQuery 隐藏。
  const renderCommandSections = () => {
    // [失败路径] 空分组直接不渲染，而不是渲染空标题：
    // cmdk 的空组仍会参与键盘导航，用户会选中一个没有任何内容的标题行。
    if (!shouldShowCommandSection || commandOptionsBySection.length === 0) {
      return null;
    }

    return commandOptionsBySection.map((section) => (
      <CommandGroup
        key={section.sectionId}
        heading={intl.formatMessage({
          id: `quickPick.section.${section.sectionId}`,
        })}
      >
        {section.commands.map(({ command, title }) => {
          const Icon = QUICK_PICK_ICON_BY_KIND[command.icon];
          return (
            <CommandItem
              key={command.id}
              value={`${title} ${command.keywords.join(" ")}`}
              disabled={command.disabled}
              className={quickPickItemClassName}
              onSelect={() => runCommand(command)}
            >
              <Icon className="size-3.5 text-foreground-subtle" />
              <span className="min-w-0 flex-1 truncate">
                <HighlightedMatchText text={title} query={searchQuery} />
              </span>
              {command.shortcut ? (
                <CommandShortcut className={quickPickShortcutPillClassName}>
                  {command.shortcut}
                </CommandShortcut>
              ) : null}
            </CommandItem>
          );
        })}
      </CommandGroup>
    ));
  };

  // [事务] 会话区只在「有搜索词」时出现：
  // 默认态的最近任务由 renderRecentTasksSection 负责，两者不能同时渲染同一批任务。
  const renderConversationSection = () => {
    if (
      !hasSearchQuery ||
      !shouldShowConversationSection ||
      (!taskList.loading && conversationRows.length === 0)
    ) {
      return null;
    }

    // [失败路径] 命中具体 scope 时直接全量：
    // 用户已经明确选了「会话」，再截断 3 条会让人以为只有 3 个结果。
    const visibleRows =
      activeScope === "conversations" || expandedSections.has("conversations")
        ? conversationRows
        : conversationRows.slice(0, COMMAND_CENTER_SECTION_LIMIT);
    return (
      <CommandGroup heading={intl.formatMessage({ id: "commandCenter.section.conversations" })}>
        {taskList.loading && conversationRows.length === 0 ? (
          <CommandEmpty className="px-4 py-5 text-foreground-subtle">
            {intl.formatMessage({ id: "taskSearch.loading" })}
          </CommandEmpty>
        ) : null}
        {visibleRows.map((row) => {
          const task = row.task;
          const title = getTaskTitle(task, intl.formatMessage({ id: "taskList.untitled" }));
          const workspaceLabel =
            workspaceLabelByKey.get(task.workspaceIdentity?.trim() || task.workspacePath) ??
            task.workspacePath;
          const searchSnippet = row.searchSnippet?.trim();
          return (
            <CommandItem
              key={row.key}
              // 搜索结果沿用含工作区身份、任务 ID 和片段序号的行 key，避免同文案一起选中。
              value={`task-result:${row.key}`}
              className={quickPickItemClassName}
              onSelect={() => selectTask(row)}
            >
              <MessageSquareIcon className="size-3.5 text-foreground-subtle" />
              <span className="flex min-w-0 flex-1 flex-col justify-center py-0.5">
                <span className="truncate text-ui-base leading-5 font-normal text-foreground">
                  <HighlightedMatchText text={title} query={searchQuery} />
                </span>
                {searchSnippet ? (
                  <span className="min-w-0 truncate text-ui-base leading-4 text-foreground-subtle">
                    <HighlightedMatchText text={searchSnippet} query={searchQuery} />
                  </span>
                ) : null}
              </span>
              <CommandShortcut className={quickPickMetadataClassName}>
                {workspaceLabel}
              </CommandShortcut>
              <CommandCenterConversationTimestamp>
                {formatTaskRelativeTime(task.updatedAt, intl)}
              </CommandCenterConversationTimestamp>
            </CommandItem>
          );
        })}
        {activeScope === "all" ? renderMoreRow("conversations", conversationRows.length) : null}
      </CommandGroup>
    );
  };

  // [失败路径] 空态三态互斥：loading → error → 无结果，
  // 顺序反了会让加载中先闪一下「没有找到文件」。
  const renderFileSection = () => {
    if (
      !hasSearchQuery ||
      !shouldShowFileSection ||
      (!workspaceFilesLoading && !workspaceFilesError && fileRows.length === 0)
    ) {
      return null;
    }

    // [事务] 文件区与文件 scope 共用同一份 fileRows：
    // 展开只是改变切片长度，不重新过滤，避免长列表在展开瞬间重算。
    const visibleRows =
      activeScope === "files" || expandedSections.has("files")
        ? fileRows
        : fileRows.slice(0, COMMAND_CENTER_SECTION_LIMIT);
    return (
      <CommandGroup heading={intl.formatMessage({ id: "commandCenter.section.files" })}>
        {workspaceFilesLoading && fileRows.length === 0 ? (
          <CommandEmpty className="px-4 py-5 text-foreground-subtle">
            {intl.formatMessage({ id: "sidePane.openFileLoading" })}
          </CommandEmpty>
        ) : workspaceFilesError ? (
          <CommandEmpty className="px-4 py-5 text-destructive">{workspaceFilesError}</CommandEmpty>
        ) : null}
        {visibleRows.map((entry) => {
          const descriptor = resolveFileDisplayDescriptor(entry.path);
          // [失败路径] 根目录文件不渲染目录列：
          // 空串会让 CommandShortcut 占位并挤压文件名，条件渲染才能保持对齐。
          const directory = getWorkspaceFileDirectory(entry);
          return (
            <CommandItem
              key={entry.path}
              value={`${entry.name} ${entry.relativePath}`}
              className={quickPickItemClassName}
              onSelect={() => selectFile(entry)}
            >
              <FileDisplayIcon src={descriptor.fileIconSrc} size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                <HighlightedMatchText text={entry.name} query={searchQuery} />
              </span>
              {directory ? (
                <CommandShortcut className={quickPickMetadataClassName}>
                  <HighlightedMatchText text={directory} query={searchQuery} />
                </CommandShortcut>
              ) : null}
            </CommandItem>
          );
        })}
        {activeScope === "all" ? renderMoreRow("files", fileRows.length) : null}
      </CommandGroup>
    );
  };

  // [事务] 三段各自带上 shouldShow 条件：
  // 去掉后，被 scope 隐藏的 section 也算「有结果」，空态永远不出现。
  const hasAnySearchResults =
    (shouldShowCommandSection && commandOptions.length > 0) ||
    (shouldShowConversationSection && conversationRows.length > 0) ||
    (shouldShowFileSection && fileRows.length > 0);
  // [失败路径] 错误也算「有状态」：
  // 否则文件加载失败时会落到「没有找到结果」，掩盖真正的错误文案。
  const hasSearchStatus =
    taskList.loading ||
    workspaceFilesLoading ||
    (shouldShowFileSection && Boolean(workspaceFilesError));

  // [事务] default 分支同时渲染三块默认内容：
  // 顺序是「最近改动 → 最近任务 → 命令」，与用户打开命令中心时的常见意图一致。
  const renderDefaultSections = () => {
    switch (activeScope) {
      case "commands":
        return renderCommandSections();
      case "conversations":
        return renderRecentTasksSection({ rows: recentTaskRows, showEmpty: true });
      case "files":
        return renderRecentChangesSection({ rows: recentChangeRows, showEmpty: true });
      default:
        return (
          <>
            {renderRecentChangesSection()}
            {renderRecentTasksSection()}
            {renderCommandSections()}
          </>
        );
    }
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={intl.formatMessage({ id: "quickPick.title" })}
      description={intl.formatMessage({ id: "quickPick.description" })}
      className={commandCenterDialogClassName}
    >
      <Command shouldFilter={false} loop className={quickPickCommandClassName}>
        <div className="border-b border-border px-2 pt-2 pb-2">
          <div className="flex h-8 items-center gap-2 rounded-full border border-input-border bg-input px-2.5 transition-colors hover:border-input-border-hover focus-within:border-input-border-focused focus-within:bg-input-focused">
            <SearchIcon className="size-4 shrink-0 text-foreground-subtlest" />
            <CommandPrimitive.Input
              value={rawQuery}
              onValueChange={setRawQuery}
              placeholder={intl.formatMessage({ id: "commandCenter.placeholder" })}
              className="min-w-0 flex-1 bg-transparent text-ui-base leading-5 text-foreground outline-none placeholder:text-foreground-subtlest"
            />
          </div>
          <div
            role="tablist"
            aria-label={intl.formatMessage({ id: "commandCenter.scopeTabs" })}
            className="-mx-1 mt-1.5 flex gap-1 overflow-x-auto px-1 pb-0.5 scrollbar-hide"
          >
            <CommandCenterScopeButton
              active={activeScope === "all"}
              label={intl.formatMessage({ id: "commandCenter.scope.all" })}
              onClick={() => setScope("all")}
            >
              <ListIcon className="size-3" />
            </CommandCenterScopeButton>
            <CommandCenterScopeButton
              active={activeScope === "commands"}
              label={intl.formatMessage({ id: "commandCenter.scope.commands" })}
              onClick={() => setScope("commands")}
            >
              <RocketIcon className="size-3" />
            </CommandCenterScopeButton>
            <CommandCenterScopeButton
              active={activeScope === "conversations"}
              label={intl.formatMessage({ id: "commandCenter.scope.conversations" })}
              onClick={() => setScope("conversations")}
            >
              <MessagesSquareIcon className="size-3" />
            </CommandCenterScopeButton>
            <CommandCenterScopeButton
              active={activeScope === "files"}
              label={intl.formatMessage({ id: "commandCenter.scope.files" })}
              onClick={() => setScope("files")}
            >
              <FileIcon className="size-3" />
            </CommandCenterScopeButton>
          </div>
        </div>
        <CommandList className={commandCenterListClassName}>
          {!hasSearchQuery ? (
            renderDefaultSections()
          ) : hasAnySearchResults || hasSearchStatus ? (
            <>
              {renderCommandSections()}
              {renderConversationSection()}
              {renderFileSection()}
            </>
          ) : (
            <CommandEmpty className="px-4 py-5 text-foreground-subtle">
              {intl.formatMessage({ id: "commandCenter.noResults" })}
            </CommandEmpty>
          )}
        </CommandList>
        {showHistory ? (
          <CommandCenterSearchHistory
            entries={historyEntries}
            expanded={historyExpanded}
            onToggleExpanded={() => setHistoryExpanded((value) => !value)}
            onPickEntry={(entry) => {
              const prefix = scopeToPrefix(entry.scope);
              setManualScope(entry.scope);
              setRawQuery(prefix ? `${prefix}${entry.query}` : entry.query);
            }}
            onClear={() => {
              clearCommandCenterSearchHistory(workspaceKey);
              setHistoryEntries([]);
            }}
            historyLabel={intl.formatMessage({ id: "commandCenter.history" })}
            clearLabel={intl.formatMessage({ id: "commandCenter.clearHistory" })}
            expandLabel={intl.formatMessage({ id: "commandCenter.expandHistory" })}
            collapseLabel={intl.formatMessage({ id: "commandCenter.collapseHistory" })}
          />
        ) : null}
      </Command>
    </CommandDialog>
  );
});
