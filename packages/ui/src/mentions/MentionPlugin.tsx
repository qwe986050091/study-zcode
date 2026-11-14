/* eslint-disable max-lines */
// 职责边界（MentionPlugin）：Lexical 输入框内的 @ / # / $ 触发面板与键盘选择面。
// 做：从当前文本选区派生 trigger/query，聚合五个 provider，按 trigger 排出分组，接管控键并插入 mention token。
// 不做：候选检索与分组排序规则（mentionSearch / 各 provider）、catalog 冻结、面板视觉（MentionPanel）。
// 依赖：Lexical composer context（编辑器唯一事实源）、ZCode session store 的 draftProjectId、i18n。
// 边界：面板是编辑器 token 的投影，不是独立状态机；选中项与 query 随时会被 provider 结果重算覆盖。
// 分发：@ = files/plugins/sessions/skills/whiteboards；# = sessions；$ = skills，三者共用同一 flatItems 索引。
// 关闭态（isOpen=false）下所有 provider 的 enabled 参数同时为 false，不允许某个分组单独继续查询。
//
// INV 不变量表（每条都对应一种静默故障，改前先确认它守的是什么）
// INV-01 断言：activeTokenRef 只在 editorState.read 内被写 —— 守住它的位置：registerUpdateListener 回调 —— 改错故障：渲染期派生 token，插入区间落后一次按键并残留 query 字符
// INV-02 断言：dismissedSignatureRef 只在签名变化、插入或失焦时清空 —— 守住它的位置：update listener 与各 handler —— 改错故障：Esc 关闭后同一查询永不再弹，或误重新打开
// INV-03 断言：setActiveTrigger 的 updater 在 trigger+query 相同时返回原对象 —— 守住它的位置：listener 内 updater —— 改错故障：每次按键都产生新对象，面板重渲染并闪烁
// INV-04 断言：isOpen 只由 disabled 与三种 trigger 决定 —— 守住它的位置：isOpen 计算处 —— 改错故障：新增 trigger 后开合判定与 provider enabled 分叉
// INV-05 断言：deferredActiveQuery 只用于候选派生 —— 守住它的位置：五个 provider 的 query 参数 —— 改错故障：拿它算替换区间，插入范围与可见输入不一致
// INV-06 断言：provider 的 enabled 必须是 isOpen 与对应 trigger 的合取 —— 守住它的位置：五处 hook 调用 —— 改错故障：@ 打开时 sessions/skills 也在后台扫描 workspace
// INV-07 断言：selectedIndex 在 activeSignature 变化时归零 —— 守住它的位置：签名 effect —— 改错故障：切换 trigger 后沿用旧索引，Enter 插入错误分类的条目
// INV-08 断言：flatItems 变化后必须经 coerceEnabledMentionIndex 收敛 —— 守住它的位置：flatItems effect —— 改错故障：异步分组把禁选项顶到第 0 位，首次 Enter 回落编辑器换行
// INV-09 断言：上下键走 getNextEnabledMentionIndex 而非取模 —— 守住它的位置：Arrow 命令 handler —— 改错故障：停在 disabled 项，Enter 被拒但按键仍被吞
// INV-10 断言：handler 返回 true 前必须 preventDefault 且 stopPropagation —— 守住它的位置：四条 key 命令 —— 改错故障：Lexical 继续执行默认换行/缩进，token 与换行双写
// INV-11 断言：Enter 与 Tab 共用 selectOption(selectedIndex) —— 守住它的位置：两条命令 handler —— 改错故障：两条选择路径分叉，键盘与鼠标命中的不是同一项
// INV-12 断言：定位、替换区间、插入节点必须在同一次 editor.update 内 —— 守住它的位置：insertMentionItem —— 改错故障：分两次事务时选区被中间态重置，token 落到错误节点
// INV-13 断言：token 与尾随空格同批插入并以 selectEnd 收尾 —— 守住它的位置：insertNodes 调用 —— 改错故障：光标停在 token 前，下一次输入并入 mention 的 query
// INV-14 断言：whiteboard 分支先删除原文本再回调宿主 —— 守住它的位置：insertMentionItem 首个分支 —— 改错故障：宿主插入白板卡片的同时残留 @board 文本
// INV-15 断言：命令 effect 在 isOpen=false 时提前返回 —— 守住它的位置：effect 开头 —— 改错故障：关闭态仍拦截方向键，编辑器无法移动光标
// INV-16 断言：命令 effect 依赖含 flatItems/selectedIndex/selectOption —— 守住它的位置：effect 依赖数组 —— 改错故障：handler 闭包捕获旧候选，键盘选中已消失的项
// INV-17 断言：六个 unregister 在 cleanup 中成对调用 —— 守住它的位置：return 清理函数 —— 改错故障：重开面板后同一按键触发两次插入
// INV-18 断言：IME 冻结只对非 Android 生效 —— 守住它的位置：shouldFreezeMentionRecalcWhileComposing —— 改错故障：Android Gboard 拉丁输入失去逐字过滤
// INV-19 断言：disabled 与 Blur 必须同时清 activeTokenRef 与 dismissedSignatureRef —— 守住它的位置：两处清理分支 —— 改错故障：重新启用后旧 token 复活并自动开面板
// INV-20 断言：空态/加载态只能来自 provider 结果 —— 守住它的位置：panelSections 映射 —— 改错故障：分组与面板对同一 query 展示互相矛盾的结论
//
// 阅读顺序：wrap → nextEnabled → coerce → update listener → insertMentionItem → 命令注册 → 渲染门。
// .tsx 限制：新增注释只能落在语句之间或对象字面量内，不能写进 JSX 子节点与开标签属性行之间。
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeProvider } from "@zcode/shared";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { createPortal } from "react-dom";
import { PaletteIcon, WandSparkles } from "lucide-react";
import {
  $createTextNode,
  BLUR_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
} from "lexical";
import { useZCodeIntl } from "../i18n/IntlProvider.js";
import {
  extractActivePromptInputTrigger,
  getActivePromptInputTokenTailLength,
  getPromptInputTriggerSignature,
  type ActivePromptInputTrigger,
} from "../lib/promptInputTriggers.js";
import { ContextMentionOptionContent } from "@/mentions/components/ContextMentionOptionContent.js";
import { PluginMentionOptionContent } from "@/mentions/components/PluginMentionOptionContent.js";
import {
  MentionPanel,
  type MentionPanelOption,
  type MentionPanelSection,
} from "./components/MentionPanel.js";
import {
  buildVisibleMentionGroups,
  hasMentionQuery,
  MENTION_DEFAULT_GROUP_PREVIEW_LIMIT,
  MENTION_FILES_ONLY_DEFAULT_PREVIEW_LIMIT,
  type MentionResultGroup,
} from "./mentionSearch.js";
import {
  getMentionPanelGroupOrder,
  getSessionMentionWorkspaceScope,
  type MentionPanelGroupId,
} from "./mentionPanelRouting.js";
import { $createPromptMentionNode } from "./nodes/PromptMentionNode.js";
import { useFileMentionProvider } from "./providers/fileMentionProvider.js";
import { usePluginsMentionProvider } from "./providers/pluginsMentionProvider.js";
import { useSessionsMentionProvider } from "./providers/sessionsMentionProvider.js";
import { useSkillsMentionProvider } from "./providers/skillsMentionProvider.js";
import { useWhiteboardMentionProvider } from "./providers/whiteboardMentionProvider.js";
import type { MentionItem } from "./mentionTypes.js";
import {
  getActivePromptInputTokenReplacementRange,
  reconcileActivePromptInputTokenSnapshot,
  type ActivePromptInputTokenSnapshot,
} from "./activePromptInputToken.js";
import { getCurrentTextNodeSelection } from "./mentionHelpers.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

interface MentionPluginProps {
  container?: HTMLElement | null;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 已有 Session 的 id；null/undefined = 新建草稿。决定 Plugins 分组的 catalog authority。 */
  sessionId?: string | null;
  disabled?: boolean;
  onWhiteboardMentionSelected?: (boardId: string) => void | Promise<void>;
}

// [契约] `MENTION_NAV_KEYS` 的循环取模是面板导航语义：首项按上键到末项，末项按下键回首项。
// itemCount<=0 返回 0 而不是抛错：provider 尚未返回时按键仍会走到这里。
// (current + delta + itemCount) % itemCount 里先加 itemCount，是因为 JS 负数取模结果为负。
// 不要改成 clamp：边界卡住会让用户以为面板失去了焦点。
// getNextEnabledMentionIndex 复用本函数做步进，改语义会同时改变跳过禁选的方向。
// delta 约定只取 ±1；传入更大步长时循环跳项不是本函数的契约。
export function getWrappedMentionIndex(
  currentIndex: number,
  delta: number,
  itemCount: number,
): number {
  if (itemCount <= 0) {
    return 0;
  }

  // mention 面板的上下键导航以前会把边界直接 clamp 到首/尾项。
  // 这里改成循环取模，保证按上键能从第一项跳到最后一项，按下键也能从最后一项回到第一项。
  return (currentIndex + delta + itemCount) % itemCount;
}

/**
 * 在循环导航的基础上跳过禁选项（V1 同名 Plugin 冲突项）。
 * 全部禁选时保持原地不动，Enter/Tab 的选择守卫会拒绝插入。
 */
// [契约] 跳过禁选项时步进方向必须与首次落点同向：delta>=0 用 +1，否则用 -1。
// 循环上限是 items.length：全禁用时必须原地返回，不能返回 -1 让调用方去 clamp。
// 全禁用返回 currentIndex 而非 0：挪到 0 会制造“选中了却按不动”的错觉。
// 可选择性只看 item.disabled，不看 disabledReason 文案：文案变化不得改变键盘行为。
// 这里返回的是索引而非条目：调用方 setSelectedIndex 依赖它保持同一次渲染的索引空间。
export function getNextEnabledMentionIndex(
  currentIndex: number,
  delta: number,
  items: ReadonlyArray<Pick<MentionItem, "disabled">>,
): number {
  if (items.length === 0) {
    return 0;
  }
  let next = getWrappedMentionIndex(currentIndex, delta, items.length);
  for (let step = 0; step < items.length; step++) {
    if (!items[next]?.disabled) {
      return next;
    }
    next = getWrappedMentionIndex(next, delta >= 0 ? 1 : -1, items.length);
  }
  return currentIndex;
}

/**
 * 候选首次出现或异步分组更新时，把选中项收敛到可选条目。
 * 根因：冲突 Plugin 保持可见后可能占据 flatItems[0]；若仍默认选中 0，
 * 第一次 Enter/Tab 会命中禁选项并回落编辑器默认行为，而不是继续键盘导航。
 */
// [契约] 收敛只把越界或禁选的索引搬到第一个可选项，不改变原本可选的选中项。
// 先 clamp 再判 disabled：候选缩短时旧索引必须落到有效区间，findIndex 之前不能跳过。
// 全部禁选时保留 boundedIndex 而不是 -1：面板仍要高亮某一行，Enter 由 selectOption 拒绝。
// 本函数是“异步分组把冲突 Plugin 顶到第 0 位”的唯一补偿点，删掉即回归该 bug。
// 改成直接返回 0 会让异步结果到达后首项仍是禁选项，第一次 Enter 失效。
// 调用点只有 flatItems effect；不要挪到渲染期，否则每次渲染都重置用户选择。
export function coerceEnabledMentionIndex(
  currentIndex: number,
  items: ReadonlyArray<Pick<MentionItem, "disabled">>,
): number {
  if (items.length === 0) {
    return 0;
  }
  const boundedIndex = Math.min(Math.max(currentIndex, 0), items.length - 1);
  if (!items[boundedIndex]?.disabled) {
    return boundedIndex;
  }
  const firstEnabledIndex = items.findIndex((item) => !item.disabled);
  return firstEnabledIndex >= 0 ? firstEnabledIndex : boundedIndex;
}

/**
 * IME 组合期间（拼音未上屏）是否冻结 @ 面板重算：中间态字母会被当作 query 逐字过滤一轮，
 * 面板闪烁且中间态结果错误；composition 提交后 Lexical 会再派发一次 update 完成重算。
 * Android 例外：Chrome + Gboard 对拉丁词也走 composition（整词到空格才 compositionend），
 * 冻结会让手机 Web 的 @ 面板失去逐字过滤，因此 Android 保持实时重算。
 */
// [契约] 组合输入期间冻结重算，判定必须同时看 composition 状态与平台。
// Android 例外不能删：Chrome+Gboard 对拉丁词也走 composition，冻结会让手机 Web 失去逐字过滤。
// userAgent 由参数传入而非函数内读 navigator，保证纯函数可测、SSR 不炸。
// 返回 false 表示“继续重算”，调用方是 update listener 的早退分支，语义不能反。
// 冻结只跳过重算，不跳过编辑器自身更新：不要在调用方顺手清空 activeTrigger。
export function shouldFreezeMentionRecalcWhileComposing(
  isComposing: boolean,
  userAgent: string,
): boolean {
  return isComposing && !/Android/i.test(userAgent);
}

export function MentionPlugin({
  workspacePath,
  workspaceIdentity,
  sessionId,
  provider,
  container,
  disabled = false,
  onWhiteboardMentionSelected,
}: MentionPluginProps & { provider: ZCodeProvider }) {
  const [editor] = useLexicalComposerContext();
  const { intl } = useZCodeIntl();
  const draftProjectId = useZCodeSessionStore(
    (state) => state.getWorkspaceState(workspacePath, workspaceIdentity).draftProjectId,
  );
  // [状态] activeTrigger、selectedIndex 与三个 ref 是同一份面板状态的四个切片，不能合并成一个对象 state。
  // activeTrigger 驱动渲染；selectedIndex 只由键盘与异步收敛改写；refs 只在 update listener 内读写。
  // activeSignatureRef 是“当前打开态签名”的镜像，供 Esc 写入 dismissedSignatureRef。
  // dismissedSignatureRef 记录用户主动关掉的那一次查询，按签名比较才能区分 trigger 变化。
  // activeTokenRef 保存插入所需的原始 token 快照（起点、终点、query），不能从 DOM 反推。
  // 合并 state 会让 listener 闭包读到过期快照，插入区间错位且难以用单测复现。
  // 不要给这三个 ref 加同步 effect：它们的写入时机本身就是不变量的一部分。
  // selectedIndex 初值必须是 0；负数或 undefined 会让面板首帧没有高亮行。
  // 这里不读 flatItems：候选尚未派生，任何依赖候选的初始化都应在 coerce effect 里做。
  const [activeTrigger, setActiveTrigger] = useState<ActivePromptInputTrigger | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dismissedSignatureRef = useRef<string | null>(null);
  const activeSignatureRef = useRef<string | null>(null);
  const activeTokenRef = useRef<ActivePromptInputTokenSnapshot | null>(null);
  const activeQuery = activeTrigger?.query ?? "";
  // 候选过滤会在渲染线程扫描大型 workspace；输入框与搜索共用同一个 query
  // 时，快速输入/删除会让每次按键都同步承担搜索成本。deferred query 只延后候选派生，
  // 不延后编辑器 token、触发器和最终插入，因此输入始终跟手，结果最终收敛到最新 query。
  // [权衡] deferredActiveQuery 只用来派生候选，绝不能用于 token 替换区间或插入判断。
  // 快速输入时每次按键都扫描 workspace 很贵，defer 把搜索成本合并到一次渲染，输入保持跟手。
  // hasActiveQuery 用实时 query：它决定面板文案与 preview limit，必须与用户看到的输入一致。
  // 若把 deferred 值传给 insertMentionItem，会把上一轮 query 的长度当成待替换区间。
  // provider 接收 deferred 值，因此结果最终收敛到最新 query，而不是停止搜索。
  // 不要给 deferred 值加 debounce：那会引入第二套时序，两套延迟叠加后更难解释。
  // React 可能丢弃并重放该值，任何副作用都不能挂在它上面。
  const deferredActiveQuery = useDeferredValue(activeQuery);
  const hasActiveQuery = hasMentionQuery(activeQuery);
  const activeSignature = useMemo(
    () => getPromptInputTriggerSignature(activeTrigger),
    [activeTrigger],
  );
  // [契约] isOpen 是唯一开合判据：disabled 优先，其次才是三种 trigger 的白名单。
  // 新增 trigger 必须同时改这里与下面三个 isXxxTrigger，否则 provider 会被错误启用。
  // isOpen=false 时组件不渲染 portal，但副作用仍靠 effect 提前返回，不能只依赖渲染兜底。
  // 不要在这里加入 query 非空判断：空 query 也要展示默认分组预览。
  // disabled 变化由独立 effect 处理清理；isOpen 只负责“当前是否展示”，不负责写状态。
  const isOpen =
    !disabled &&
    (activeTrigger?.trigger === "@" ||
      activeTrigger?.trigger === "$" ||
      activeTrigger?.trigger === "#");
  const isContextTrigger = activeTrigger?.trigger === "@";
  const isSessionTrigger = activeTrigger?.trigger === "#";
  const isSkillTrigger = activeTrigger?.trigger === "$";

  // 修复说明：之前把 @ 面板拆成了两层，导致用户输入 query 后还要再确认一次，
  // 实际感受像“按回车之后才开始搜”。现在改成单层分组面板，query 一变化就直接展示各分组结果。
  // [契约] 五个 provider 的 enabled 都是“isOpen 与该 trigger 匹配”的合取，不能只传 isOpen。
  // 只传 isOpen 会让 @ 打开时同时触发 sessions 与 skills 的 workspace 扫描。
  // 各 provider 的 query 统一用 deferredActiveQuery，实时 query 只用于文案与 preview limit。
  // whiteboard provider 额外要求 onWhiteboardMentionSelected 存在：没有宿主回调就没有白板分组。
  // plugins provider 传 sessionId（null 表示草稿），决定读 workspace catalog 还是 session 冻结 catalog。
  // file provider 额外接收 draftProjectId：项目上下文参与候选排序，不能省成 undefined。
  // sessions provider 的 workspace scope 由 getSessionMentionWorkspaceScope 按 trigger 推导，不要手写。
  // intl 文案在每次渲染现算后作为参数传入，provider 内部不持有 intl 实例。
  // 调整位置参数顺序前先核对 provider 签名：相邻的多个 string 参数错位不会报类型错。
  const skillsResult = useSkillsMentionProvider(
    workspacePath,
    workspaceIdentity,
    sessionId ?? null,
    provider,
    deferredActiveQuery,
    isOpen && isSkillTrigger,
    false,
    intl.formatMessage({ id: "chat.mention.skills.empty" }),
    intl.formatMessage({ id: "chat.mention.skills.title" }),
  );
  const fileDefaultPreviewLimit = !hasActiveQuery
    ? MENTION_FILES_ONLY_DEFAULT_PREVIEW_LIMIT
    : MENTION_DEFAULT_GROUP_PREVIEW_LIMIT;
  const fileResult = useFileMentionProvider(
    workspacePath,
    workspaceIdentity,
    deferredActiveQuery,
    isOpen && isContextTrigger,
    intl.formatMessage({ id: "chat.mention.files.empty" }),
    intl.formatMessage({ id: "chat.mention.files.title" }),
    fileDefaultPreviewLimit,
    { sessionId, projectId: draftProjectId },
  );
  const whiteboardResult = useWhiteboardMentionProvider(
    workspacePath,
    workspaceIdentity,
    deferredActiveQuery,
    isOpen && isContextTrigger && Boolean(onWhiteboardMentionSelected),
    intl.formatMessage({ id: "chat.mention.whiteboards.empty" }),
    intl.formatMessage({ id: "chat.mention.whiteboards.title" }),
  );
  const sessionsResult = useSessionsMentionProvider(
    provider,
    workspacePath,
    workspaceIdentity,
    deferredActiveQuery,
    isOpen && (isContextTrigger || isSessionTrigger),
    getSessionMentionWorkspaceScope(activeTrigger?.trigger),
    intl.formatMessage({ id: "chat.mention.sessions.empty" }),
    intl.formatMessage({ id: "chat.mention.sessions.title" }),
    intl.formatMessage({ id: "project.tasks" }),
  );
  // Plugins 分组：新建草稿（sessionId=null）读 workspace
  // 当前 catalog，已有 Session 读 session-owned 冻结 catalog；冲突项由 provider 标记禁选。
  const pluginsResult = usePluginsMentionProvider(
    workspacePath,
    workspaceIdentity,
    sessionId ?? null,
    deferredActiveQuery,
    isOpen && isContextTrigger,
    intl.formatMessage({ id: "chat.mention.plugins.empty" }),
    intl.formatMessage({ id: "chat.mention.plugins.title" }),
  );

  // [契约] 面板分组是 provider 结果的纯投影，顺序由 getMentionPanelGroupOrder(trigger) 决定。
  // # 分支必须提前 return：sessions 分组由 Host 查询自带分组，不能再过一次 groupsById 重排。
  // groupsById 用 satisfies 约束五个分组键齐全，新增分组时类型检查会在这里报错。
  // 每个分组把 error 折成 errorText 字符串：面板不感知 Error 对象，展示层只认文案。
  // buildVisibleMentionGroups 负责过滤空分组，因此这里可以放心传全量。
  // 依赖数组必须逐项列出 provider 字段而不是整个 result 对象：result 每次渲染都是新引用。
  // 漏列依赖会让分组停留在旧 query 的结果上，表现为“输入后结果不更新”。
  // 不要把 flatItems 的计算并进来：两者依赖粒度不同，合并会让所有分组共享一次全量重算。
  // 标题与空态文案都来自 provider，本函数不生成任何兜底文案。
  // groupsById 的 title 与 emptyText 必须逐项取自对应 provider，不能在本地 fallback。
  // 分组 id 必须与 MentionPanelGroupId 一致，面板的键盘索引依赖它保持稳定顺序。
  // 这里只读不写状态：任何“顺便修正选中项”的副作用都应留在独立 effect。
  const panelGroups = useMemo<MentionResultGroup<MentionItem>[]>(() => {
    if (activeTrigger?.trigger === "#" && sessionsResult.groups?.length) {
      return buildVisibleMentionGroups(
        sessionsResult.groups.map((group) => ({
          ...group,
          emptyText: sessionsResult.emptyText,
          loading: sessionsResult.loading,
          errorText: sessionsResult.error?.message ?? null,
        })),
      );
    }
    const groupsById = {
      files: {
        id: "files",
        title: fileResult.title,
        items: fileResult.items,
        loading: fileResult.loading,
        errorText: fileResult.error?.message ?? null,
        emptyText: fileResult.emptyText,
      },
      plugins: {
        id: "plugins",
        title: pluginsResult.title,
        items: pluginsResult.items,
        loading: pluginsResult.loading,
        errorText: pluginsResult.error?.message ?? null,
        emptyText: pluginsResult.emptyText,
      },
      sessions: {
        id: "sessions",
        title: sessionsResult.title,
        items: sessionsResult.items,
        loading: sessionsResult.loading,
        errorText: sessionsResult.error?.message ?? null,
        emptyText: sessionsResult.emptyText,
      },
      skills: {
        id: "skills",
        title: skillsResult.title,
        items: skillsResult.items,
        loading: skillsResult.loading,
        errorText: skillsResult.error?.message ?? null,
        emptyText: skillsResult.emptyText,
      },
      whiteboards: {
        id: "whiteboards",
        title: whiteboardResult.title,
        items: whiteboardResult.items,
        loading: whiteboardResult.loading,
        errorText: whiteboardResult.error?.message ?? null,
        emptyText: whiteboardResult.emptyText,
      },
    } satisfies Record<MentionPanelGroupId, MentionResultGroup<MentionItem>>;

    // @ 的类别顺序与 $ 单分组保持原契约；# 的项目分组来自当前 Host 查询结果。
    return buildVisibleMentionGroups(
      getMentionPanelGroupOrder(activeTrigger?.trigger).map((groupId) => groupsById[groupId]),
    );
  }, [
    fileResult.emptyText,
    fileResult.error,
    fileResult.items,
    fileResult.loading,
    fileResult.title,
    activeTrigger?.trigger,
    pluginsResult.emptyText,
    pluginsResult.error,
    pluginsResult.items,
    pluginsResult.loading,
    pluginsResult.title,
    sessionsResult.emptyText,
    sessionsResult.error,
    sessionsResult.items,
    sessionsResult.groups,
    sessionsResult.loading,
    sessionsResult.title,
    whiteboardResult.emptyText,
    whiteboardResult.error,
    whiteboardResult.items,
    whiteboardResult.loading,
    whiteboardResult.title,
    skillsResult.emptyText,
    skillsResult.error,
    skillsResult.items,
    skillsResult.loading,
    skillsResult.title,
  ]);

  const flatItems = useMemo(() => panelGroups.flatMap((group) => group.items), [panelGroups]);

  // [契约] panelSections 把 MentionItem 投影成 MentionPanelOption，id 必须透传 item.id。
  // disabled 与 disabledReason 必须原样透传：同名 Plugin 冲突项要“可见但不可选”。
  // content 按 category 分支复用展示组件，必须与 token 展示同源，不能另拼一套文案。
  // files 与 sessions 共用 ContextMentionOptionContent，语义由 item 决定，不在这里再分支。
  // skills 与 whiteboards 的内联结构是主次信息行，不是通用容器，改样式时两边要一起看。
  // whiteboards 的 description 是笔画数（字符串），传给 i18n 时必须走插值参数。
  // showHeader 只对 # 打开：它来自 trigger 而不是分组本身，不能下放到 provider。
  // 依赖含 activeTrigger?.trigger：showHeader 与标题投影都随 trigger 变化。
  // 不要在 map 内部创建新的组件类型，否则每次渲染都卸载重挂并丢失焦点。
  // panelGroups 变化即整表重建：面板侧应把它当不可变数据，不能就地修改 options。
  // loadingText 每次渲染现算 i18n 文案，不要缓存到模块级常量。
  // options 的顺序必须与 group.items 一致：面板高亮索引与 flatItems 索引是同一套。
  const panelSections = useMemo<MentionPanelSection[]>(
    () =>
      panelGroups.map((group) => ({
        id: group.id,
        title: group.title,
        showHeader: activeTrigger?.trigger === "#",
        options: group.items.map<MentionPanelOption>((item) => ({
          id: item.id,
          label: item.displayLabel ?? item.label,
          description: item.description,
          // 冲突 Plugin 等禁选项：面板可见但不可选择，行内展示原因（V1 fail closed）。
          disabled: item.disabled,
          disabledReason: item.disabledReason,
          // @ 面板之前只用 label/description 自己拼文件行，导致图标、文件名和路径展示
          // 跟输入框里的 mention token 不一致。这里统一复用 fileDisplay，让面板和 token 使用同一套文件语义展示。
          content:
            item.category === "files" ? (
              <ContextMentionOptionContent item={item} workspacePath={workspacePath} />
            ) : item.category === "skills" ? (
              <span className="min-w-0 flex flex-1 items-center gap-2">
                {/* Bugfix: skills 候选项需要和命令类项保持一致的主次信息密度，
                    这里保留图标 + 名称主文案，再把描述压成右侧弱信息，而不是额外占第二行。 */}
                <WandSparkles className="size-3.5 shrink-0 text-foreground" />
                <span className="shrink-0 whitespace-nowrap text-ui-base font-medium text-foreground">
                  {item.label}
                </span>
                <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
                  {item.description}
                </span>
              </span>
            ) : item.category === "whiteboards" ? (
              <span className="min-w-0 flex flex-1 items-center gap-2">
                <PaletteIcon className="size-3.5 shrink-0 text-foreground" />
                <span className="shrink-0 whitespace-nowrap text-ui-base font-medium text-foreground">
                  {item.label}
                </span>
                <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
                  {intl.formatMessage(
                    { id: "chat.mention.whiteboards.strokeCount" },
                    { count: item.description },
                  )}
                </span>
              </span>
            ) : item.category === "sessions" ? (
              <ContextMentionOptionContent item={item} workspacePath={workspacePath} />
            ) : item.category === "plugins" ? (
              <PluginMentionOptionContent item={item} />
            ) : undefined,
        })),
        loading: group.loading,
        loadingText: intl.formatMessage({
          id: "chat.mention.category.loading",
        }),
        errorText: group.errorText,
        emptyText: group.emptyText,
      })),
    [intl, panelGroups, workspacePath, activeTrigger?.trigger],
  );

  useEffect(() => {
    // [并发] activeSignatureRef 是 activeSignature 的镜像，必须由独立 effect 写入。
    // 不能把赋值塞进渲染体：并发渲染下被丢弃的那次也会写 ref，Esc 会记错签名。
    // 本例先于 selectedIndex 归零的 effect 执行，Esc 读取时必须已拿到本轮签名。
    // 不要在签名变化时清空 dismissedSignatureRef：清空由 listener 按签名比较决定。
    // 这个 ref 只读于 Esc handler；把它复用到插入路径会掩盖真正的 token 失效。
    activeSignatureRef.current = activeSignature;
  }, [activeSignature]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [activeSignature]);

  useEffect(() => {
    setSelectedIndex((current) => coerceEnabledMentionIndex(current, flatItems));
  }, [flatItems]);

  useEffect(() => {
    if (!disabled) {
      return;
    }

    setActiveTrigger(null);
    setSelectedIndex(0);
    activeTokenRef.current = null;
  }, [disabled]);

  useEffect(() => {
    // [并发] update listener 是唯一允许派生 token 的地方，所有读取都在 editorState.read 内完成。
    // disabled 分支先清三份状态：关闭后残留 token 会让下一次启用立刻误开面板。
    // 选区不在文本节点时清空 dismissedSignatureRef：换节点意味着上一次关闭不再适用。
    // reconcile 的第三个参数用 dirtyElements/dirtyLeaves 双空判断“纯选区移动”，不能只用其一。
    // 非 @/#/$ 的 token 一律清空，而不是保留旧 activeTrigger。
    // 签名变化时先清 dismissed 再比较，顺序反了会让“改 query 后重新打开”失效。
    // setActiveTrigger 的 updater 在 query 与 trigger 都相同时返回 current，避免无意义重渲染。
    // dismissed 与 nextSignature 相等时只关面板，不清 ref：下一次同签名仍应保持关闭。
    // listener 返回的注销函数由 effect 的 return 直接接管，不要再包一层幂等包装。
    // 依赖只放 disabled 与 editor：其他状态都经 ref 读取，加依赖会反复注册监听。
    // editorState.read 内不能 setState 之外的异步操作；异步会让读到的选区在回调时已失效。
    // 不要在这里直接改 selectedIndex：索引归零由 activeSignature effect 统一负责。
    // reconcile 传 activeTokenRef.current 而不是局部快照：跨多次更新要能衔接同一 token。
    // 本回调可能在 IME 组合期间高频触发，早退分支必须放在 read 之前，避免重复读树。
    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, editorState }) => {
      if (
        shouldFreezeMentionRecalcWhileComposing(
          editor.isComposing(),
          typeof navigator === "undefined" ? "" : navigator.userAgent,
        )
      ) {
        return;
      }
      editorState.read(() => {
        if (disabled) {
          activeTokenRef.current = null;
          setActiveTrigger(null);
          return;
        }

        const selectionState = getCurrentTextNodeSelection();
        if (!selectionState) {
          activeTokenRef.current = null;
          dismissedSignatureRef.current = null;
          setActiveTrigger(null);
          return;
        }

        const nextActiveToken = reconcileActivePromptInputTokenSnapshot(
          activeTokenRef.current,
          selectionState,
          dirtyElements.size === 0 && dirtyLeaves.size === 0,
        );
        if (
          !nextActiveToken ||
          (nextActiveToken.trigger !== "@" &&
            nextActiveToken.trigger !== "$" &&
            nextActiveToken.trigger !== "#")
        ) {
          activeTokenRef.current = null;
          dismissedSignatureRef.current = null;
          setActiveTrigger(null);
          return;
        }
        activeTokenRef.current = nextActiveToken;

        const nextSignature = getPromptInputTriggerSignature(nextActiveToken);
        if (
          dismissedSignatureRef.current !== null &&
          dismissedSignatureRef.current !== nextSignature
        ) {
          dismissedSignatureRef.current = null;
        }

        if (dismissedSignatureRef.current === nextSignature) {
          setActiveTrigger(null);
          return;
        }

        setActiveTrigger((current) => {
          if (
            current?.trigger === nextActiveToken.trigger &&
            current.query === nextActiveToken.query
          ) {
            return current;
          }

          return {
            query: nextActiveToken.query,
            trigger: nextActiveToken.trigger,
          };
        });
      });
    });
  }, [disabled, editor]);

  // [事务] 插入必须在单次 editor.update 内完成：定位、替换区间、插入节点三步不可拆。
  // whiteboard 分支先删文本再回调宿主：卡片由宿主插入，本组件不能同时插 token。
  // snapshotRange 存在时一律以快照为准，只有快照失效才回退 extractActivePromptInputTrigger。
  // tokenStart 回退公式里的 -1 是触发符本身，去掉它会把 @ 留在正文里。
  // tokenEnd 用 getActivePromptInputTokenTailLength 吃掉已输入的尾串，避免 @file.ts 残留。
  // setTextNodeRange 的四个参数必须落在同一个 text node，跨节点会抛错。
  // insertNodes 里 token 与尾随空格必须同批提交，空格单独插入会让光标落进 token 内部。
  // trailingWhitespace.selectEnd() 是插入后的唯一光标落点，删掉它用户得手动再点。
  // update 之外的清理顺序固定：先清 dismissed 与 token，再关面板，最后归零索引。
  // requestAnimationFrame 里再 focus：同步 focus 会和 Lexical 的 DOM 更新抢时序。
  // onWhiteboardMentionSelected 用 void 调用：它是宿主副作用，不能阻塞编辑器事务。
  // 宿主回调放在状态清理之后：回调若同步抛错，面板也不应停在半开状态。
  // 依赖只有 editor 与 onWhiteboardMentionSelected；flatItems 不应进入闭包，否则每次候选变化都重建。
  // 两处 update 分支的 token 区间算法必须保持一致，只改一处会让白板与普通 mention 行为分叉。
  const insertMentionItem = useCallback(
    (item: MentionItem) => {
      if (item.category === "whiteboards" && onWhiteboardMentionSelected) {
        editor.update(() => {
          const selectionState = getCurrentTextNodeSelection();
          if (!selectionState) {
            return;
          }

          const snapshotRange = getActivePromptInputTokenReplacementRange(
            activeTokenRef.current,
            selectionState,
          );
          const activeMentionTrigger = snapshotRange
            ? activeTokenRef.current
            : extractActivePromptInputTrigger(selectionState.textBeforeCursor);
          if (
            !activeMentionTrigger ||
            (activeMentionTrigger.trigger !== "@" && activeMentionTrigger.trigger !== "$")
          ) {
            return;
          }

          const tokenStart =
            snapshotRange?.start ??
            selectionState.cursorOffset - activeMentionTrigger.query.length - 1;
          const tokenEnd =
            snapshotRange?.end ??
            selectionState.cursorOffset +
              getActivePromptInputTokenTailLength(
                activeMentionTrigger,
                selectionState.textAfterCursor,
                [item.label, item.value, item.markdown],
              );
          selectionState.selection.setTextNodeRange(
            selectionState.node,
            tokenStart,
            selectionState.node,
            tokenEnd,
          );
          selectionState.selection.insertText("");
        });

        dismissedSignatureRef.current = null;
        activeTokenRef.current = null;
        setActiveTrigger(null);
        setSelectedIndex(0);
        void onWhiteboardMentionSelected(item.value);
        requestAnimationFrame(() => {
          editor.focus();
        });
        return;
      }

      editor.update(() => {
        const selectionState = getCurrentTextNodeSelection();
        if (!selectionState) {
          return;
        }

        const snapshotRange = getActivePromptInputTokenReplacementRange(
          activeTokenRef.current,
          selectionState,
        );
        const activeMentionTrigger = snapshotRange
          ? activeTokenRef.current
          : extractActivePromptInputTrigger(selectionState.textBeforeCursor);
        if (
          !activeMentionTrigger ||
          (activeMentionTrigger.trigger !== "@" &&
            activeMentionTrigger.trigger !== "$" &&
            activeMentionTrigger.trigger !== "#")
        ) {
          return;
        }

        const tokenStart =
          snapshotRange?.start ??
          selectionState.cursorOffset - activeMentionTrigger.query.length - 1;
        const tokenEnd =
          snapshotRange?.end ??
          selectionState.cursorOffset +
            getActivePromptInputTokenTailLength(
              activeMentionTrigger,
              selectionState.textAfterCursor,
              [item.label, item.value, item.markdown],
            );
        selectionState.selection.setTextNodeRange(
          selectionState.node,
          tokenStart,
          selectionState.node,
          tokenEnd,
        );
        const trailingWhitespace = $createTextNode(" ");
        selectionState.selection.insertNodes([
          $createPromptMentionNode({
            id: item.id,
            category: item.category,
            label: item.label,
            value: item.value,
            markdown: item.markdown,
            description: item.description,
            data: item.data,
          }),
          trailingWhitespace,
        ]);
        trailingWhitespace.selectEnd();
      });

      dismissedSignatureRef.current = null;
      activeTokenRef.current = null;
      setActiveTrigger(null);
      setSelectedIndex(0);
      requestAnimationFrame(() => {
        editor.focus();
      });
    },
    [editor, onWhiteboardMentionSelected],
  );

  // [契约] selectOption 是 Enter、Tab 与鼠标点击的唯一入口，禁选项统一在这里拒绝。
  // 返回 false 表示“没选中”，命令 handler 据此放行 Lexical 的默认行为。
  // 不要在这里做插入后的索引清理：insertMentionItem 已负责，重复会引入竞态。
  // flatItems[index] 可能越界（异步收缩），必须先判空再读 disabled。
  // 这里不做副作用外的状态写入，保证三条选择路径行为完全一致。
  // 依赖只含 flatItems 与 insertMentionItem，不要把 selectedIndex 卷进来。
  const selectOption = useCallback(
    (index: number) => {
      const nextItem = flatItems[index];
      if (!nextItem) {
        return false;
      }
      // 禁选项（同名冲突 Plugin）不可插入：键盘 Enter/Tab 与鼠标点击都走这里统一拒绝。
      if (nextItem.disabled) {
        return false;
      }

      insertMentionItem(nextItem);
      return true;
    },
    [flatItems, insertMentionItem],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    // [契约] 四条导航/选择命令注册在 COMMAND_PRIORITY_CRITICAL，Esc 与 Blur 的优先级不同，不可统一。
    // ArrowDown/Up 在没有候选时返回 false：让编辑器保留原生光标移动。
    // handler 必须先 preventDefault 再改索引，顺序反了浏览器会先滚动列表。
    // Enter/Tab 用 selectOption 的返回值决定是否吞事件；吞掉未选中的 Enter 会让输入框无法换行。
    // Esc 写入 dismissedSignatureRef 后再关面板：否则下一次 update 会立刻重开。
    // Blur 返回 false 且用 LOW 优先级：失焦要允许其他监听者继续处理。
    // cleanup 必须逐个 unregister，缺一个就会在重开面板后重复触发。
    // 命令 effect 的依赖含 selectedIndex：handler 闭包必须看到最新选中项。
    // 把 setSelectedIndex 的 updater 改成直接赋值会丢掉并发下的最新值。
    // 所有 handler 都不读 flatItems.length 之外的候选内容，避免闭包持有旧数组。
    // Esc 不调用 selectOption：它只关闭，不插入，也不改 selectedIndex 之外的 token 状态。
    // Blur 的清理比 Esc 更彻底：它还清 activeTokenRef，因为焦点已离开编辑器。
    // 事件参数可能为 undefined（命令可被程序化派发），因此统一用可选链。
    // 不要在 handler 内部再 registerCommand：命令注册只应发生在 effect 里。
    // effect 提前返回的分支不能留下已注册的部分命令，注册顺序必须整体成功或整体跳过。
    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        if (flatItems.length === 0) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        setSelectedIndex((prev) => getNextEnabledMentionIndex(prev, 1, flatItems));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        if (flatItems.length === 0) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        setSelectedIndex((prev) => getNextEnabledMentionIndex(prev, -1, flatItems));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!selectOption(selectedIndex)) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        if (!selectOption(selectedIndex)) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        event?.preventDefault();
        event?.stopPropagation();

        dismissedSignatureRef.current = activeSignatureRef.current;
        setActiveTrigger(null);
        setSelectedIndex(0);
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    // 调试说明：先注释掉 blur 自动关闭逻辑，方便观察 panel 在焦点切换时的实际行为。
    // 当前只移除“失焦即消失”这一路径，Esc / 选中项 / trigger 失效等关闭逻辑仍然保留。
    const unregisterBlur = editor.registerCommand(
      BLUR_COMMAND,
      () => {
        dismissedSignatureRef.current = null;
        activeTokenRef.current = null;
        setActiveTrigger(null);
        setSelectedIndex(0);
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );

    return () => {
      unregisterDown();
      unregisterUp();
      unregisterEnter();
      unregisterTab();
      unregisterEscape();
      unregisterBlur();
    };
  }, [editor, flatItems, isOpen, selectOption, selectedIndex]);

  // [契约] 渲染门在 createPortal 之前：isOpen 为假或 container 缺席都返回 null。
  // container 由调用方注入，不能退化到 document.body，否则多窗口会挂错 DOM。
  // panelDescription 按 trigger 选 hint：空 query 与有 query 是两套文案。
  // emptyText 只在有 query 时给：无 query 的空分组由 section 自己展示。
  // selectedIndex 传给面板只用于高亮，真正的选择仍走 selectOption。
  // onSelect 直接透传 selectOption，不要包一层索引换算。
  // trigger 回退 @ 只影响面板文案，不影响 isOpen 判定。
  // panelTitle 在这里现算而不是模块级常量，保证语言切换即时生效。
  // 三元链的顺序是 # → $ → 默认 @，新增 trigger 时要补在默认分支之前。
  // 面板不接收任何 ref 或 editor 实例：它只负责展示与回调，不能直接操作编辑器。
  // createPortal 的容器必须是调用方给的宿主节点；换节点会重建整棵面板并丢焦点。
  // 面板 props 全部是派生值：渲染期不得写 ref 或 setState，否则一次输入触发两轮更新。
  const panelTitle = intl.formatMessage({ id: "chat.mention.title" });
  const panelDescription = hasActiveQuery
    ? ""
    : activeTrigger?.trigger === "#"
      ? intl.formatMessage({ id: "chat.mention.sessions.searchHint" })
      : activeTrigger?.trigger === "$"
        ? intl.formatMessage({ id: "chat.mention.skills.searchHint" })
        : intl.formatMessage({ id: "chat.mention.searchHint" });
  const panelEmptyText = hasActiveQuery
    ? intl.formatMessage({ id: "chat.mention.emptyResults" })
    : "";

  if (!isOpen || !container) {
    return null;
  }

  return createPortal(
    <MentionPanel
      title={panelTitle}
      description={panelDescription}
      trigger={activeTrigger?.trigger ?? "@"}
      sections={panelSections}
      emptyText={panelEmptyText}
      selectedIndex={selectedIndex}
      hasActiveQuery={hasActiveQuery}
      onSelect={selectOption}
    />,
    container,
  );
}
