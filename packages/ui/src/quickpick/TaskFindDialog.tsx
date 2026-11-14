// INV 不变量表（19 条；违反任意一条都会造成可见的查找行为错乱）：
// INV-01 命中计数只在 query 去空白后非空时生效；守住位置：conversationState 与 fileChangeState 的 useMemo；改错故障：清空输入后界面仍显示上一轮的 3/7
// INV-02 对话与文件变更各自持有 total 与 currentIndex，禁止共用一份；守住位置：activeFindState 的三元选择；改错故障：切到文件变更后沿用对话计数，比值变成 5/3
// INV-03 关闭时必须同时清空 query、scope 与两侧高亮；守住位置：open 为假的 effect 分支；改错故障：下次打开自动套用上次关键词并高亮旧命中
// INV-04 currentIndex 为 0 起、-1 表示无活动命中；守住位置：handleQueryChange 与 resolveConversationFindNavigationSelection；改错故障：计数显示 0/N，或第一条命中永远不被选中
// INV-05 新查询必须把索引重置为 0（有词）或 -1（无词）；守住位置：handleQueryChange 的 nextIndex；改错故障：新关键词直接停在上一次的第 N 个命中
// INV-06 零命中时导航必须早退；守住位置：moveSelection 开头的 total 判断；改错故障：空结果上按键仍递增请求序号，父级把视图滚回旧位置
// INV-07 键位到导航方向的映射单点收敛；守住位置：resolveConversationFindNavigationDirection；改错故障：按钮与键盘各写一套键位，Shift 语义分叉
// INV-08 只有识别出导航方向才 preventDefault；守住位置：handleInputKeyDown 的方向分支；改错故障：拦截输入法选词回车，中文候选无法确认
// INV-09 回车不承担提交语义；守住位置：方向解析对 Enter 返回空；改错故障：用户按回车期望跳到下一处，却触发了范围切换
// INV-10 chat 下沉模式的 Esc 由 window 冒泡监听兜底；守住位置：placement 为 chat 的 keydown effect；改错故障：浮层关不掉，只能点关闭按钮
// INV-11 已被内层浮层消费的 Esc 不得再次关闭查找框；守住位置：handleKeyDown 的 defaultPrevented 早退；改错故障：一次 Esc 同时关掉嵌套菜单与查找框
// INV-12 Esc 监听只在 open 且 placement 为 chat 时存在并成对清理；守住位置：该 effect 的守卫与返回的移除函数；改错故障：监听器泄漏，关闭后 Esc 仍被吞
// INV-13 无蒙层且 modal 为 false 时，外部点击不得关闭；守住位置：onInteractOutside 的 preventDefault；改错故障：点聊天区看上下文就丢失关键词与高亮
// INV-14 焦点必须落在输入框，重复快捷键靠 focusRequestId 重放；守住位置：两个 requestAnimationFrame 聚焦 effect；改错故障：第二次 Cmd/Ctrl+F 后光标不在输入框，输入无响应
// INV-15 两次聚焦都要延后到下一帧；守住位置：两处 requestAnimationFrame；改错故障：Dialog 挂载动画期间焦点被抢回，输入框失焦
// INV-16 范围切换必须清空对侧高亮；守住位置：handleScopeChange 与两个同步 effect；改错故障：两个范围同时高亮，用户误以为结果叠加
// INV-17 切换范围后索引从 0 重新开始，不沿用对侧索引；守住位置：handleScopeChange 里的 trim 分支；改错故障：进入文件变更直接停在上次对话的第 3 个命中
// INV-18 Office 模式下范围切换按钮只在 changes 分支保留；守住位置：findContent 的按钮可见条件；改错故障：切到文件变更后入口消失，无法切回对话范围
// INV-19 chat 模式自绘 role=dialog 容器而不是嵌套 Dialog；守住位置：placement 分支的早退渲染；改错故障：两层 dialog 同时存在，读屏重复朗读标题
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  FileDiffIcon,
  MessageCircleIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import {
  getConversationFindState,
  resolveConversationFindNavigationSelection,
  resolveConversationFindNavigationDirection,
} from "@/quickpick/conversationFindSearch.js";

type TaskFindScope = "conversation" | "changes";

export type TaskFindDialogProps = {
  open: boolean;
  focusRequestId: number;
  placement?: "window" | "chat";
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isLinuxDesktop?: boolean;
  conversationMatchCount: number;
  conversationMatchIndex: number;
  fileChangeMatchCount: number;
  fileChangeMatchIndex: number;
  onOpenChange: (open: boolean) => void;
  onConversationFindChange: (query: string, activeIndex: number) => void;
  onConversationFindNavigate: (query: string, activeIndex: number) => void;
  onFileChangeFindChange: (query: string, activeIndex: number) => void;
  onFileChangeFindNavigate: (query: string, activeIndex: number) => void;
  onOpenFileChanges: () => void;
};

export function TaskFindDialog({
  open,
  focusRequestId,
  placement = "window",
  isMacDesktop,
  isWindowsDesktop,
  isLinuxDesktop,
  conversationMatchCount,
  conversationMatchIndex,
  fileChangeMatchCount,
  fileChangeMatchIndex,
  onOpenChange,
  onConversationFindChange,
  onConversationFindNavigate,
  onFileChangeFindChange,
  onFileChangeFindNavigate,
  onOpenFileChanges,
}: TaskFindDialogProps) {
  const isOfficeMode = useIsOfficeMode();
  const { intl } = useZCodeIntl();
  const titleId = useId();
  const descriptionId = useId();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<TaskFindScope>("conversation");
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 命中总数与当前索引都来自父级的异步搜索结果，本组件只负责判断这一轮结果是否还该被展示。
  // query 去空白后为空时把 total 硬置 0，即使父级还没清空上一次计数，界面也只显示 0/0 而不是陈旧命中。
  // 依赖列表带上 query，是为了清空输入的同一帧就重算；去掉它会让计数滞后一次渲染，出现已清空却还显示 3/7。
  // 搜索不做本地防抖，每次输入直接交给父级；防抖窗口与请求序号留在父级搜索层，切换范围时才能共用同一条丢弃逻辑。
  // 过期响应由父级的请求序号判定后丢弃，本组件不再缓存上一轮 count；在这里叠一层缓存，切范围后会读到另一范围的旧计数。
  // 大小写与连续空白的归一发生在父级匹配实现里，这里只做 trim 判空，两套归一规则会让高亮命中而计数为 0。
  // 这一对计数必须与 fileChangeState 分开计算，不能合并成一个 state，合并后两侧 total 会互相覆盖。
  // 改错后果：清空输入仍显示上一轮 `conversationMatchCount`，用户以为聊天区还留着高亮。
  const conversationState = useMemo(
    () =>
      getConversationFindState(query.trim() ? conversationMatchCount : 0, conversationMatchIndex),
    [conversationMatchCount, conversationMatchIndex, query],
  );
  const fileChangeState = useMemo(
    () => getConversationFindState(query.trim() ? fileChangeMatchCount : 0, fileChangeMatchIndex),
    [fileChangeMatchCount, fileChangeMatchIndex, query],
  );
  // 活动计数只能由 scope 从两侧里选一个，两个范围不允许出现同时活动的第三态。
  // 计数文本、上一处与下一处按钮的禁用、键盘导航的早退全部读这一个变量，保证三处语义同源。
  // 显示值是 currentIndex 加一，索引本身 0 起，直接渲染索引会少显示一个；零命中固定渲染 0/0 而不是空串。
  // 输入框是普通文本框而不是 combobox，因此不声明 aria-activedescendant 与 listbox，命中项在消息区而不在弹层里。
  // 给输入框套上 combobox 语义后，读屏会期待一个候选列表，而实际候选在聊天区，按上下键听不到任何选项变化。
  // 计数文本没有 aria-live，快速输入时不逐字朗读；需要播报时由父级在导航完成后统一播报一次。
  // 选中项完全由父级回传的 index 驱动，本组件不保存第几个的副本，避免过滤结果与索引两份状态不同步。
  // 改错后果：按钮用对侧计数判禁用，出现按钮可点但按下没有跳转。
  const activeFindState = scope === "conversation" ? conversationState : fileChangeState;

  useEffect(() => {
    if (!open) {
      // 关闭查找框时三件事必须一起做：清空关键词、把范围复位到对话、通知父级清空两侧高亮。
      // 只清 query 不清 scope，下次打开会停在上次的文件变更范围，与用户对该快捷键的预期不符。
      // 只改本地状态不通知父级，聊天区高亮会留在原处，下次打开再输入时新旧高亮叠加。
      // 两个撤销回调传空串与 -1，而不是当前 query；传当前值会让父级在关闭后仍维持一份命中集合。
      // 清理放在 open 变为假的 effect 里而不是关闭按钮回调里，是因为 Esc、外部收起、父级强制关闭三条路径都汇到这里。
      // 该 effect 在挂载时也会执行一次，此时 open 为假，重复清理是幂等的，不会多出一次可见渲染。
      // 不在这里手动清 inputRef 的 DOM 值，输入框受控于 query，直接改 DOM 会与 React 状态脱节。
      // 改错后果：重开查找框时旧 `query` 立即生效，用户以为输入法串词。
      setQuery("");
      setScope("conversation");
      onConversationFindChange("", -1);
      onFileChangeFindChange("", -1);
      return;
    }

    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [onConversationFindChange, onFileChangeFindChange, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    // Cmd/Ctrl+F 在查找框已打开时不会改变 open 状态，常规聚焦 effect 不会重跑。
    // 这里监听显式 focus 请求，让重复触发快捷键时总能把焦点带回搜索输入框。
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [focusRequestId, open]);

  useEffect(() => {
    if (!open || scope !== "changes") {
      return;
    }

    onOpenFileChanges();
  }, [onOpenFileChanges, open, scope]);

  useEffect(() => {
    if (!open || placement !== "chat") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // chat 下沉模式没有 Dialog 托管按键，Esc 由这条 window 冒泡监听负责，两个守卫的先后顺序不可交换。
      // defaultPrevented 优先判断，是为了把 Esc 让给更内层且已消费该按键的浮层或菜单。
      // 反过来先判按键再判已消费状态，嵌套菜单打开时一次 Esc 会同时关掉菜单和查找框。
      // 监听挂在 window 而不是容器上，因为焦点可能落在聊天区按钮上，容器级监听收不到按键。
      // 命中后先 preventDefault 再关闭，避免同一按键继续冒泡去触发宿主或其他快捷键。
      // 清理函数必须与添加同源，依赖变化时先移除旧监听，否则一次 Esc 会被处理多遍。
      // 该监听只在 open 且 placement 为 chat 时创建，其余情况走 Dialog 自带的 Esc 行为，不重复注册。
      // 改错后果：浮层关不掉，或一次 Esc 连锁关闭多层界面。
      if (event.defaultPrevented || event.key !== "Escape") {
        return;
      }

      // 查找框下沉到聊天区域后不再由 Radix Dialog 负责 Esc。
      // window 冒泡监听只处理尚未被活动浮层消费的 Esc，避免抢占嵌套菜单/弹层的关闭语义。
      event.preventDefault();
      onOpenChange(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpenChange, open, placement]);

  useEffect(() => {
    if (!open || scope !== "conversation") {
      return;
    }

    onFileChangeFindChange("", -1);
    onConversationFindChange(query, conversationState.currentIndex);
  }, [
    conversationState.currentIndex,
    onConversationFindChange,
    onFileChangeFindChange,
    open,
    query,
    scope,
  ]);

  useEffect(() => {
    if (!open || scope !== "changes") {
      return;
    }

    // 切到“文件变更”范围后，旧的对话搜索高亮不应该继续留在聊天区。
    // 两个范围使用独立高亮 root，这里显式清空另一边，避免用户误以为两个范围同时生效。
    onConversationFindChange("", -1);
    onFileChangeFindChange(query, fileChangeState.currentIndex);
  }, [
    fileChangeState.currentIndex,
    onConversationFindChange,
    onFileChangeFindChange,
    open,
    query,
    scope,
  ]);

  const moveSelection = useCallback(
    (direction: "previous" | "next") => {
      // 零命中时按钮虽已禁用，键盘上下键仍会进到同一个导航函数，早退必须放在最前面。
      // 早退不只是省一次调用：下游按递增的请求序号驱动滚动，空导航会推进序号，让父级回滚到上一次的位置。
      // 这里直接返回而不是把方向取反，保证键盘与按钮在零命中时行为完全一致。
      // 判断读 activeFindState 而不是任一侧计数，切换范围后不会用对侧的非零总数放行。
      // 空查询与有查询但无命中都落到 0，两者对导航的处置一致。
      // 改错后果：空结果上连按上下键，界面闪烁并滚到上一次命中的位置。
      if (activeFindState.total === 0) {
        // 零命中时按钮已禁用，但键盘仍会进入同一处理函数。
        // 这里统一拒绝空导航，避免无效 request id 递增和按钮/键盘语义分叉。
        return;
      }

      // 环形与边界推进规则集中在纯函数里，本组件只把当前 query、活动计数与方向喂进去。
      // 不在组件内自己算取模，否则按钮与键盘两条路径各维护一套边界语义，越界方向先分叉。
      // 传入的 query 是原始输入，未做大小写转换，返回值里的 query 原样回传，保证父级匹配口径与输入一致。
      // 选中索引由该函数按 total 修正，调用方信任返回值而不再 clamp，二次修正会让 0 与 -1 的边界含义变模糊。
      // 本组件不直接对命中节点调 scrollIntoView：命中在消息区、跨范围且可能未渲染，滚动由父级消费导航回调完成。
      // 同理不保存命中元素引用，消息重排后引用会指向已卸载节点，滚动落到不可见区域。
      // 两条回调按 scope 二选一，禁止都调，否则两个范围各滚一次，最后停在错误位置。
      // 改错后果：最后一个命中按下一处不回卷到第一个，或滚动位置与计数显示不一致。
      const selection = resolveConversationFindNavigationSelection(
        query,
        activeFindState,
        direction,
      );
      if (scope === "conversation") {
        onConversationFindNavigate(selection.query, selection.activeIndex);
        return;
      }

      onFileChangeFindNavigate(selection.query, selection.activeIndex);
    },
    [activeFindState, onConversationFindNavigate, onFileChangeFindNavigate, query, scope],
  );

  const handleQueryChange = useCallback(
    (nextQuery: string) => {
      setQuery(nextQuery);
      // 输入变化一律重置索引：有非空白内容从第一个命中开始，没有内容回到 -1 表示无活动命中。
      // 沿用旧索引会让新关键词直接跳到第 N 个结果，与系统查找每次新词从头开始的行为不一致。
      // 用 trim 判空而不是判空串：只敲一个空格时按空查询处理，计数归零，不放开全量命中。
      // -1 与 0 必须区分：0 表示第一条命中生效并高亮，-1 表示不指定，父级据此决定是否清除高亮。
      // 本地 query 与父级回调在同一次事件里更新，避免出现输入框已换词、父级仍是旧索引的中间帧。
      // 大小写不在这里转换，用户输入大写时高亮仍按原样匹配，转换会改变偏移量导致高亮错位。
      // 输入法组合期间每个中间态也会走到这里，索引反复归零可以接受，最终结果以最后一次请求为准。
      // 改错后果：新关键词停在上一次的第 4 个命中，用户按回车跳到看不见的位置。
      const nextIndex = nextQuery.trim() ? 0 : -1;
      if (scope === "conversation") {
        // 输入新的查找词时应从第一个命中开始滚动。
        // 如果沿用旧 activeIndex，新关键词也可能直接跳到第 N 个结果，和系统查找行为不一致。
        onConversationFindChange(nextQuery, nextIndex);
        return;
      }

      onFileChangeFindChange(nextQuery, nextIndex);
    },
    [onConversationFindChange, onFileChangeFindChange, scope],
  );

  const handleScopeChange = useCallback(
    (nextScope: TaskFindScope) => {
      setScope(nextScope);
      if (nextScope === "changes") {
        onOpenFileChanges();
        onConversationFindChange("", -1);
        onFileChangeFindChange(query, query.trim() ? 0 : -1);
        return;
      }

      onFileChangeFindChange("", -1);
      onConversationFindChange(query, query.trim() ? 0 : -1);
    },
    [onConversationFindChange, onFileChangeFindChange, onOpenFileChanges, query],
  );

  const handleToggleScope = useCallback(() => {
    handleScopeChange(scope === "conversation" ? "changes" : "conversation");
  }, [handleScopeChange, scope]);

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // 键位到方向的映射只在这一个函数里判定，组件不硬编码 ArrowUp 与 ArrowDown，避免两处键位表漂移。
      // 只有拿到非空方向才 preventDefault，回车、空格、字母键原样放行给输入框和输入法。
      // 组合输入期间的回车承载确认候选的职责，这里若对回车也 preventDefault，中文用户将无法用回车选词。
      // [权衡] 没有额外补 isComposing 判断，而是靠不拦截回车天然满足组合态语义；将来若要加回车提交，必须先判组合态。
      // Shift 参与方向计算是为了与宿主快捷键保持一致，究竟是反序还是跳首尾由纯函数决定，组件不复制该规则。
      // preventDefault 放在导航之前，防止父级滚动容器也响应方向键再滚一次。
      // 方向被识别但零命中时仍会先 preventDefault 再早退，保证按键不漏到聊天区触发滚动。
      // 改错后果：按上下键时只有光标移动而命中不切换，或拼音选词的回车被吞。
      const direction = resolveConversationFindNavigationDirection(event.key, event.shiftKey);
      if (direction) {
        event.preventDefault();
        moveSelection(direction);
      }
    },
    [moveSelection],
  );

  const placeholderId = `quickPick.find.placeholder.${scope}`;
  const ScopeIcon = scope === "conversation" ? MessageCircleIcon : FileDiffIcon;
  const nextScopeLabelId =
    scope === "conversation" ? "quickPick.find.scope.changes" : "quickPick.find.scope.conversation";
  const previousLabel = intl.formatMessage({ id: "quickPick.find.previous" });
  const nextLabel = intl.formatMessage({ id: "quickPick.find.next" });
  const nextScopeLabel = intl.formatMessage({ id: nextScopeLabelId });
  const scopeTooltipLabel = intl.formatMessage({
    id: "quickPick.find.scope.tooltip",
  });
  const closeLabel = intl.formatMessage({ id: "common.close" });
  const renderFindIconButton = ({
    label,
    tooltipLabel = label,
    disabled,
    onClick,
    children,
  }: {
    label: string;
    tooltipLabel?: string;
    disabled?: boolean;
    onClick: () => void;
    children: ReactNode;
  }) => (
    <ControlHintTooltip title={tooltipLabel} side="bottom">
      <span className="inline-flex">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </span>
    </ControlHintTooltip>
  );
  const findContent = (
    <div className="flex h-9 items-center gap-1.5 py-0 pr-2 pl-2">
      <SearchIcon className="size-3.5 shrink-0 text-foreground" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => handleQueryChange(event.target.value)}
        onKeyDown={handleInputKeyDown}
        placeholder={intl.formatMessage({ id: placeholderId })}
        className="min-w-0 flex-1 bg-transparent text-ui-base font-medium text-foreground outline-none placeholder:text-foreground-subtlest"
      />
      <div className="w-8 shrink-0 text-center text-ui-xs font-medium text-foreground-subtle tabular-nums">
        {activeFindState.total > 0
          ? `${activeFindState.currentIndex + 1}/${activeFindState.total}`
          : "0/0"}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 border-l border-border pl-1.5">
        {renderFindIconButton({
          label: previousLabel,
          disabled: activeFindState.total === 0,
          onClick: () => moveSelection("previous"),
          children: <ArrowUpIcon className="size-3.5" />,
        })}
        {renderFindIconButton({
          label: nextLabel,
          disabled: activeFindState.total === 0,
          onClick: () => moveSelection("next"),
          children: <ArrowDownIcon className="size-3.5" />,
        })}
        {(!isOfficeMode || scope === "changes") &&
          renderFindIconButton({
            label: nextScopeLabel,
            tooltipLabel: scopeTooltipLabel,
            onClick: handleToggleScope,
            children: <ScopeIcon className="size-3.5" />,
          })}
      </div>
      <div className="ml-0.5 flex shrink-0 border-l border-border pl-1.5">
        {renderFindIconButton({
          label: closeLabel,
          onClick: () => onOpenChange(false),
          children: <XIcon className="size-3.5" />,
        })}
      </div>
    </div>
  );
  const contentPositionClassName = cn(
    // 原查找框宽高偏大，在小窗口和密集操作里会遮挡更多正文区域。
    // 这里收紧到更小的宽度与内边距，减少侵入性并保持操作可读性。
    "left-auto !w-[min(360px,calc(100vw-0.75rem))] !max-w-[calc(100vw-0.75rem)] translate-x-0 translate-y-0",
    // Linux 的窗口控制和标题栏都是 renderer 自绘；查找浮层如果继续贴在 top-3，
    // 会覆盖标题栏点击区，导致打开浮层后无法通过标题栏切换/拖动窗口。Linux desktop
    // 预留 48px 标题栏和 120px 右侧窗口按钮安全区，其余平台用各自分支的偏移。
    isWindowsDesktop
      ? "top-12 right-36"
      : isMacDesktop
        ? "top-14 right-3"
        : isLinuxDesktop
          ? "top-12 right-[120px]"
          : "top-3 right-3",
  );

  if (placement === "chat") {
    if (!open) {
      return null;
    }

    return (
      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="absolute top-3 left-1/2 z-30 w-[min(360px,calc(100%-1rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-popover-border bg-popover p-0 text-ui-base/relaxed text-foreground shadow-md outline-none [app-region:no-drag] max-md:top-2"
      >
        <div className="sr-only">
          <h2 id={titleId}>{intl.formatMessage({ id: "quickPick.find.title" })}</h2>
          <p id={descriptionId}>{intl.formatMessage({ id: "quickPick.find.description" })}</p>
        </div>
        {findContent}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogHeader className="sr-only">
        <DialogTitle id={titleId}>{intl.formatMessage({ id: "quickPick.find.title" })}</DialogTitle>
        <DialogDescription id={descriptionId}>
          {intl.formatMessage({ id: "quickPick.find.description" })}
        </DialogDescription>
      </DialogHeader>
      <DialogContent
        showCloseButton={false}
        showOverlay={false}
        onInteractOutside={(event) => {
          // 查找框改成无蒙层后，用户会点击聊天区查看命中的上下文。
          // Radix Dialog 默认把外部点击当成关闭信号，这会让查找状态丢失；这里保留浮层，仍可用 Esc 或关闭按钮退出。
          event.preventDefault();
        }}
        className={cn(
          // Cmd/Ctrl+F 浮层不能固定在右上角：Desktop 端会和标题区控件重叠。
          // 这里按平台预留安全区：统一下移到标题区下方，并在 Windows 额外右移，避开右上角原生窗口按钮。
          contentPositionClassName,
          "overflow-hidden border-popover-border bg-popover p-0 shadow-md",
        )}
      >
        {findContent}
      </DialogContent>
    </Dialog>
  );
}
