// GitBranchSwitcher：Git 分支切换入口的展示层，编排「触发器 → 分支列表 → 页脚动作 → 三个受控弹层」。
// 职责边界：分支快照、切换/新建/提交后切换的真实语义全部归 useGitBranchSwitcher；本文件不读服务、不发请求、不落盘。
// 本文件只做三件事：把 hook 快照投影成文案与禁用态；把用户意图转成 hook 命令；管理纯 UI 局部开关（列表开合、图谱弹层）。
// 阅读顺序：状态投影（isVisible / displayedCurrentBranchName / triggerLabel）→ 选区滚动与 Tab 键 → 触发器 → 列表项 → 页脚 → 弹层绑定。
// INV 表（每条都对应一处「改错就出故障」的位置约束，禁止绕过）：
// INV-01 断言：仅当 Git 可用且确为仓库时才渲染，否则整棵树返回 null —— 守住它的位置：isVisible 判定与 hooks 之后的提前 return —— 改错故障：非仓库工作区出现空入口或伪分支。
// INV-02 断言：mutationPending 期间触发器、列表项、页脚按钮全部 disabled —— 守住它的位置：Button 与 CommandItem 的 disabled —— 改错故障：切换进行中重复触发，产生并发 checkout。
// INV-03 断言：搜索过滤只改变列表可见项，绝不改写当前分支 —— 守住它的位置：branchSearchFilter 仅作为 Command 的 filter —— 改错故障：关键字被误当成切换，或当前分支标记漂移。
// INV-04 断言：当前分支视图优先 branchesResult.currentBranchName，回退 gitSummary.branchName —— 守住它的位置：displayedCurrentBranchName 单点计算 —— 改错故障：刷新回来的真实分支被旧值覆盖。
// INV-05 断言：组件不保存乐观分支名，切换结果只认 hook 刷新后的快照 —— 守住它的位置：所有高亮与触发器都读同一个 displayedCurrentBranchName —— 改错故障：失败后 UI 停在并不存在的分支上。
// INV-06 断言：脏工作区是否拦截由 hook 决定并升级为 assist 弹层 —— 守住它的位置：onSelect 直接转交 switchBranch —— 改错故障：组件二次拦截导致双提示或绕过提交确认。
// INV-07 断言：列表打开且有分支时把当前分支滚入可视区 —— 守住它的位置：依赖 open 与 branchesResult 的滚动 effect —— 改错故障：长列表打开停在顶部，用户找不到当前分支。
// INV-08 断言：Tab 只点击「已选中的非禁用项」，否则退到第一个可用项 —— 守住它的位置：handleContentKeyDown 的两段 querySelector —— 改错故障：Tab 触发禁用项或无项时吞掉默认行为。
// INV-09 断言：粗触控设备打开列表不自动聚焦搜索框 —— 守住它的位置：onOpenAutoFocus 内的 isCoarseTouchDevice 分支 —— 改错故障：手机系统键盘弹起遮挡分支列表。
// INV-10 断言：关闭弹层后仅在约定场景把焦点还给聊天输入 —— 守住它的位置：onCloseAutoFocus 与 shouldRestoreChatInputFocusAfterPickerClose —— 改错故障：焦点丢到 body，连续输入被打断。
// INV-11 断言：新建分支弹层每次关闭都清空分支名 —— 守住它的位置：onOpenChange 的 !nextOpen 分支与 onCancel —— 改错故障：下次打开残留上次输入，误建分支。
// INV-12 断言：页脚动作先关列表再开弹层 —— 守住它的位置：新建与图谱两个 onClick 的第一句 setOpen(false) —— 改错故障：两个浮层同时存在，焦点与层级互相抢。
// INV-13 断言：紧凑远控模式只保留图标，不渲染文案与尾随图标 —— 守住它的位置：compactForRemoteControl 的两处条件渲染 —— 改错故障：窄底栏被分支名挤爆输入工具栏。
// INV-14 断言：弹层 open 状态唯一来源是 hook 的 open / createDialogOpen / switchAssistStep —— 守住它的位置：全部弹层都受控绑定 —— 改错故障：本地再存一份开关，关闭后状态不同步。
// INV-15 断言：所有可见文案与数字格式走 intl 与 numberFormatter —— 守住它的位置：triggerLabel、空态、动作名、脏文件计数 —— 改错故障：切换语言后仍显示旧语言或手拼数字。
// INV-16 断言：commandListRef 只服务于滚动定位，不参与状态判定 —— 守住它的位置：effect 内 query 后 scrollIntoView —— 改错故障：把滚动副作用当成选中事实，高亮错位。
//
// 局部状态机（本文件可见部分）：closed → 列表 open；open → 选中分支 / 新建动作 / 图谱动作；任一动作都会先收敛浮层。
// 切换动作的推进不在此处：hook 用 mutationPending 与 switchAssistStep 表达 idle / pending / 需提交 / 结束。
// 关键不变量：任何时刻只允许一个「当前分支」视图——列表高亮、触发器文案、assist 弹层标题必须同源。
// 一致性取舍：本组件不自建乐观状态，宁可让 UI 等 hook 刷新，也不让显示先于真实 checkout 结果。
// 失败路径总纲：切换失败没有本地回滚代码，回滚显示完全靠「不提前改快照 + onRefreshGit 后重新取数」。
// 并发总纲：mutationPending 是从触发器到列表项、页脚按钮的统一闸门，新增可触发分支变更的入口必须接同一闸门。
// 资源总纲：requestAnimationFrame 在 effect 清理中取消，弹层快速开合不残留滚动副作用。
// 事务总纲：新建分支先关列表再开弹层，失败重试仍在同一弹层内完成，不重复创建。
// 边界：本文件不判断分支是否存在、不校验命名、不生成提交信息，这些都属于 hook 与弹层组件的契约。
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { GitRepositorySummary } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import {
  GitBranchCreateDialog,
  GitBranchSwitchAssistDialog,
} from "@/git-branch-switcher/GitBranchDialogs.js";
import { GitGraphDialog } from "@/git-graph/GitGraphDialog.js";
import { useGitBranchSwitcher } from "@/hooks/useGitBranchSwitcher.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  matchesGitBranchSearch,
  resolveGitBranchTriggerLabel,
} from "@/git-branch-switcher/display.js";
import {
  isCoarseTouchDevice,
  shouldRestoreChatInputFocusAfterPickerClose,
} from "@/lib/pickerFocus.js";
import {
  ChevronDownIcon,
  GitBranchIcon,
  GitGraph,
  LoaderIcon,
  PlusIcon,
} from "lucide-react";

// [契约] props 全是「外部快照 + 回调」：gitSummary 与 dirtyFileCount 由上层提供，本组件不回写。
// [契约] onRefreshGit 是唯一刷新出口，切换或新建成功后由 hook 调用，组件不自行拉取。
// [权衡] 三个 className 由调用方注入，组件只保证默认布局，不在内部再判断宿主场景。
// [契约] markAsWorkspaceHeaderBranch 与 compactForRemoteControl 是布局开关，不改变任何数据语义。
interface GitBranchSwitcherProps {
  workspacePath: string;
  gitSummary: GitRepositorySummary;
  dirtyFileCount: number;
  onRefreshGit: () => void;
  className?: string;
  triggerClassName?: string;
  popoverClassName?: string;
  branchListClassName?: string;
  markAsWorkspaceHeaderBranch?: boolean;
  compactForRemoteControl?: boolean;
  popoverSide?: "top" | "bottom" | "left" | "right";
  avoidPopoverCollisions?: boolean;
  showFooterActions?: boolean;
}

// [契约] 解构默认值即组件合同：markAsWorkspaceHeaderBranch=false、popoverSide="top"、showFooterActions=true。
// [契约] workspacePath 同时是 hook 的仓库身份与 GitGraphDialog 的查询键，二者必须是同一个值。
// [资源] 组件初始化无副作用，全部请求都在 useGitBranchSwitcher 内按 workspacePath 触发。
// [失败路径] 上层传入非仓库 summary 时不做兜底渲染，交由 isVisible 统一早退，避免半渲染。
export function GitBranchSwitcher({
  workspacePath,
  gitSummary,
  dirtyFileCount,
  onRefreshGit,
  className,
  triggerClassName,
  popoverClassName,
  branchListClassName,
  markAsWorkspaceHeaderBranch = false,
  compactForRemoteControl = false,
  popoverSide = "top",
  avoidPopoverCollisions = true,
  showFooterActions = true,
}: GitBranchSwitcherProps) {
  // [契约] 文案与数字格式都由 intl / locale 派生，脏文件数量不手写拼接。
  // [权衡] numberFormatter 随 locale 重建并进入依赖数组，避免语言切换后数字格式滞留。
  const { intl, locale } = useZCodeIntl();
  const numberFormatter = new Intl.NumberFormat(locale);
  // [资源] ref 只挂到 CommandList，用于滚动定位，不参与任何状态判定。
  // [权衡] 用 ref 而非重建 command 状态，避免打开弹层时重排列表。
  // [契约] ref 为空时必须安全短路，不能在滚动 effect 里假设节点已挂载。
  const commandListRef = useRef<HTMLDivElement | null>(null);
  const [gitGraphDialogOpen, setGitGraphDialogOpen] = useState(false);
  const {
    open,
    setOpen,
    createDialogOpen,
    setCreateDialogOpen,
    createBranchName,
    setCreateBranchName,
    commitMessage,
    setCommitMessage,
    commitError,
    switchAssistStep,
    switchAssistState,
    branchesResult,
    loadingBranches,
    mutationPending,
    switchBranch,
    createBranchAndSwitch,
    openSwitchCommitDialog,
    closeSwitchAssistDialog,
    commitAndSwitchBranch,
  // [契约] hook 是唯一状态机所有者：open / createDialogOpen / switchAssist 由它产出与回收。
  // [并发] mutationPending 由 hook 下发，是切换进行中禁用态的唯一事实来源。
  // [事务] switchBranch / createBranchAndSwitch / commitAndSwitchBranch 三条命令互斥，由 hook 串行化。
  // [失败路径] commitError 只透传给 assist 弹层，列表处不再做二次错误提示。
  // [契约] currentBranchName 与 headRefType 传入供 hook 计算回滚目标，组件不自行推导。
  } = useGitBranchSwitcher({
    workspacePath,
    currentBranchName: gitSummary.branchName,
    headRefType: gitSummary.headRefType,
    onRefreshGit,
  });

  // [契约] 可见性需要「Git 可用 + 是仓库」同时成立，缺一不渲染。
  // [失败路径] 不可见时在 hooks 之后提前返回 null，保证 hook 调用顺序稳定。
  // [权衡] 不用 CSS 隐藏，避免隐藏入口仍可被键盘聚焦后触发切换。
  // [契约] 该判断只影响渲染，不影响 hook 内已建立的订阅与请求。
  const isVisible = gitSummary.isGitAvailable && gitSummary.isRepository;
  // [契约] 当前分支视图优先取 branchesResult.currentBranchName，其次 gitSummary.branchName。
  // [失败路径] 切换失败后 hook 不写入新值，此处自然继续显示旧分支，即显示层回滚。
  // [并发] 两处来源可能短暂不一致，以列表结果为准，避免刷新期间高亮跳到错误项。
  // [权衡] 不在本地维护乐观分支名，牺牲即时反馈换取与真实 checkout 一致。
  const displayedCurrentBranchName =
    branchesResult?.currentBranchName ?? gitSummary.branchName;
  // [契约] 触发器文案由 resolveGitBranchTriggerLabel 统一处理 detached HEAD 与缺省标签。
  // [契约] 依赖 displayedCurrentBranchName，列表刷新后触发器同步更新。
  // [权衡] useMemo 只依赖稳定值，避免每次渲染重算 i18n 文案。
  // [失败路径] 分支名为空时回退到通用分支标签，不出现空白触发器。
  const triggerLabel = useMemo(
    () =>
      resolveGitBranchTriggerLabel({
        headRefType: gitSummary.headRefType,
        currentBranchName: displayedCurrentBranchName,
        detachedLabel: intl.formatMessage({ id: "git.head.detached" }),
        fallbackLabel: intl.formatMessage({ id: "git.branchSwitcher.label" }),
      }),
    [displayedCurrentBranchName, gitSummary.headRefType, intl],
  );
  // [契约] 脏文件提示只挂在当前分支行，非当前分支一律不显示。
  // [失败路径] dirtyFileCount 为 0 时返回 null，UI 不渲染空段落。
  // [权衡] 展示与拦截分离：是否拦截由 hook 判定，这里只负责数字格式化。
  const currentBranchDirtyLabel = useMemo(
    () =>
      dirtyFileCount > 0
        ? intl.formatMessage(
            { id: "git.branchSwitcher.currentDirty" },
            { count: numberFormatter.format(dirtyFileCount) },
          )
        : null,
    [dirtyFileCount, intl, numberFormatter],
  );
  // [契约] assist 弹层标题跟随 switchAssistState 快照，而不是实时 gitSummary。
  // [事务] 快照存在期间用户可能已切换成功，标题要反映发起时的分支，避免文案错位。
  // [失败路径] 快照为空时退回触发器文案，弹层不会出现空标题。
  // [权衡] 保留 triggerLabel 作为依赖，保证无快照场景与触发器同源。
  const switchAssistCurrentBranchLabel = useMemo(() => {
    if (!switchAssistState) {
      return triggerLabel;
    }

    return resolveGitBranchTriggerLabel({
      headRefType: gitSummary.headRefType,
      currentBranchName: switchAssistState.currentBranchName,
      detachedLabel: intl.formatMessage({ id: "git.head.detached" }),
      fallbackLabel: intl.formatMessage({ id: "git.branchSwitcher.label" }),
    });
  }, [gitSummary.headRefType, intl, switchAssistState, triggerLabel]);
  // [契约] 过滤器只回答「该项是否命中关键字」，返回 0/1 交给 Command 排序。
  // [权衡] 命中判定复用 matchesGitBranchSearch，搜索规则与其它入口保持一份实现。
  // [契约] 过滤结果不影响 displayedCurrentBranchName，也不触发任何切换。
  // [失败路径] 关键字无命中时走 CommandEmpty，展示 loading 或空态文案。
  // [并发] branchSearchFilter 只调 matchesGitBranchSearch 并返回 0/1，无副作用，输入高频变化时可反复调用。
  const branchSearchFilter = useCallback(
    (value: string, search: string) =>
      matchesGitBranchSearch(value, search) ? 1 : 0,
    [],
  );

  // [契约] open 变真且分支非空时先把 displayedCurrentBranchName 滚入可视区域，因此长列表不必手找。
  // [资源] 滚动放进 requestAnimationFrame，等 Command 完成首帧布局后再测量。
  // [资源] effect 清理取消未执行帧，弹层快速开合不产生悬挂回调。
  // [失败路径] 找不到 data-branch-current 节点时静默跳过，不抛错。
  useEffect(() => {
    if (!open || !branchesResult?.branches.length) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const selectedItem =
        commandListRef.current?.querySelector<HTMLElement>(
          '[data-branch-current="true"]',
        ) ?? null;
      selectedItem?.scrollIntoView({ block: "nearest" });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [branchesResult, open]);

  // [契约] 只接管 Tab：把键盘焦点语义转成「选中当前高亮项」。
  // [失败路径] 无可用项时直接返回，保留浏览器默认 Tab 行为。
  // [契约] 选择器优先命中 data-selected，其次退化到第一个非禁用项。
  // [并发] mutationPending 时列表项 disabled，选择器排除 disabled，Tab 无法发起第二次切换。
  // [权衡] 用 click() 复用 Command 的选中链路，不另写一份切换逻辑。
  const handleContentKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Tab") {
        return;
      }

    const highlightedItem =
      event.currentTarget.querySelector<HTMLElement>(
        '[data-slot="command-item"][data-selected="true"]:not([data-disabled=true])',
      ) ??
      event.currentTarget.querySelector<HTMLElement>(
        '[data-slot="command-item"]:not([data-disabled=true])',
      );

    if (!highlightedItem) {
      return;
    }

      event.preventDefault();
      highlightedItem.click();
    },
    [],
  );

  // [契约] 早退点位于全部 hooks 之后、JSX 之前，遵守 hooks 顺序规则。
  // [失败路径] 不可见时渲染 null，不输出占位节点，避免布局留白。
  // [权衡] 不在此处清理 hook 状态，重开仓库时由 hook 按 workspacePath 自行重置。
  if (!isVisible) {
    return null;
  }

  // [契约] 根节点是 Fragment：触发器与三个弹层并列，弹层不进入触发器的 DOM 层级。
  // [资源] 三个弹层都由 `open` 决定挂载，关闭时整棵子树不渲染，省掉分支列表与图谱的渲染开销。
  // [权衡] 弹层留在本组件内而非拆成外部容器，换取状态就近可读。
  return (
    <>
      <div
        data-workspace-header-branch={markAsWorkspaceHeaderBranch ? "true" : undefined}
        className={cn("flex items-center px-1 pt-2", className)}
      >
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size={"default"}
              disabled={mutationPending}
              aria-label={intl.formatMessage({
                id: "git.branchSwitcher.trigger.ariaLabel",
              })}
              className={cn(
                "min-w-0 rounded-full text-ui-base/relaxed",
                // Bugfix: 手机远控聊天页底部空间很窄，分支名会挤压输入工具栏；远控模式只保留图标入口。
                compactForRemoteControl
                  ? "size-8 px-0"
                  : "max-w-full pl-3 pr-2",
                triggerClassName,
              )}
            >
              <GitBranchIcon
                data-branch-switcher-primary-icon="true"
                className="size-4 text-foreground-subtle"
              />
              {!compactForRemoteControl ? (
                <>
                  <span className="min-w-0 max-w-25 truncate text-left">{triggerLabel}</span>
                  {loadingBranches || mutationPending ? (
                    <LoaderIcon
                      data-branch-switcher-trailing-icon="true"
                      className="size-3.5 animate-spin text-foreground-subtle"
                    />
                  ) : (
                    <ChevronDownIcon
                      data-branch-switcher-trailing-icon="true"
                      className="size-3.5 text-foreground-subtle"
                    />
                  )}
                </>
              ) : null}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            side={popoverSide}
            avoidCollisions={avoidPopoverCollisions}
            className={cn("w-80 gap-0 bg-menu p-0", popoverClassName)}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              // [契约] 粗触控设备打开列表不自动聚焦搜索框，避免系统键盘遮挡列表。
              // [权衡] 桌面端仍自动聚焦搜索，保持键盘优先的高效路径。
              // [失败路径] 设备判定失败按桌面处理，只影响焦点，不影响切换能力。
              // [契约] 这里只提前返回，不改动 Popover 的打开状态。
              if (isCoarseTouchDevice()) {
                // 手机触控设备打开分支列表时，自动聚焦搜索框会拉起系统键盘遮挡列表。
                // 移动端保留触发器焦点，用户需要搜索时再手动点输入框；桌面端继续自动进入搜索。
                return;
              }

              // [契约] 焦点目标从事件当前元素向下查找 command-input，不跨弹层全局查找。
              // [失败路径] 元素不是 HTMLElement 或找不到输入框时静默跳过。
              // [权衡] 选择器依赖 data-slot 约定，与 Command 实现耦合但可读性更好。
              const target = event.currentTarget;
              if (!(target instanceof HTMLElement)) {
                return;
              }
              const searchInput = target.querySelector<HTMLElement>(
                '[data-slot="command-input"]',
              );
              searchInput?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (
                !shouldRestoreChatInputFocusAfterPickerClose({
                  isCoarseTouchDevice: isCoarseTouchDevice(),
                })
              ) {
                return;
              }
              // [契约] 关闭后若 shouldRestoreChatInputFocusAfterPickerClose 为真，就把焦点移回 [data-testid="chat-input"]。
              // [失败路径] 聊天输入未挂载时 focus 为空操作，不抛错。
              // [权衡] 是否归还焦点由 shouldRestoreChatInputFocusAfterPickerClose 决定，组件不重复判断设备。
              const input = document.querySelector<HTMLElement>(
                '[data-testid="chat-input"]',
              );
              input?.focus();
            }}
          >
            <Command
              className="bg-transparent p-0 text-foreground"
              filter={branchSearchFilter}
              onKeyDown={handleContentKeyDown}
            >
              <CommandInput
                placeholder={intl.formatMessage({
                  id: "git.branchSwitcher.searchPlaceholder",
                })}
                className="h-8"
              />
              <CommandList ref={commandListRef} className={cn("max-h-72", branchListClassName)}>
                <CommandEmpty className="px-4 py-5 text-foreground-subtle">
                  {loadingBranches
                    ? intl.formatMessage({ id: "common.loading" })
                    : intl.formatMessage({ id: "git.branchSwitcher.empty" })}
                </CommandEmpty>
                <CommandGroup
                  heading={intl.formatMessage({
                    id: "git.branchSwitcher.section.branches",
                  })}
                  className="space-y-0.5 p-1 **:[[cmdk-group-heading]]:px-3 **:[[cmdk-group-heading]]:py-2 **:[[cmdk-group-heading]]:text-ui-base **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-foreground-subtle"
                >
                  {(branchesResult?.branches ?? []).map((branch) => {
                    // [契约] 当前分支标记同时驱动 data-checked 与 data-branch-current，两者必须同源。
                    // [契约] data-branch-current 供滚动 effect 定位，改名会同时破坏高亮与定位。
                    // [失败路径] 切换失败后 displayedCurrentBranchName 未变，旧分支继续保持高亮。
                    // [权衡] 逐项比较分支名而非索引，过滤重排后高亮仍然正确。
                    const isCurrent =
                      branch.name === displayedCurrentBranchName;
                    return (
                      <CommandItem
                        key={branch.name}
                        value={branch.name}
                        data-checked={isCurrent ? "true" : undefined}
                        data-branch-current={isCurrent ? "true" : undefined}
                        disabled={mutationPending}
                        className={cn(
                          "items-start gap-3 rounded-lg px-3 py-2 text-ui-base",
                        )}
                        onSelect={() => {
                          // [事务] 选中即发起切换，命令交给 hook，组件不预判是否需要提交。
                          // [失败路径] 脏工作区由 hook 转成 assist 弹层，组件不在此处二次拦截。
                          // [并发] 列表项在 mutationPending 时 disabled，杜绝重复点击同一分支。
                          // [契约] void 显式丢弃 Promise，错误提示归 hook 与 assist 弹层。
                          void switchBranch(branch.name);
                        }}
                      >
                        <GitBranchIcon className="mt-0.5 size-4 text-foreground-subtle" />
                        <div className="min-w-0 flex-1 flex flex-col gap-1 text-left">
                          <div className="truncate text-ui-base font-medium text-foreground">
                            {branch.name}
                          </div>
                          {isCurrent && currentBranchDirtyLabel ? (
                            <p className="pt-0.5 text-ui-base text-foreground-subtle">
                              {currentBranchDirtyLabel}
                            </p>
                          ) : null}
                        </div>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
            {showFooterActions ? (
              <div className="border-t border-border p-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="lg"
                  className="w-full justify-start px-2 text-foreground hover:bg-menu-hover hover:text-foreground"
                  disabled={mutationPending}
                  onClick={() => {
                    // [事务] 新建分支先关列表再开弹层，避免两个浮层同时抢占焦点。
                    // [契约] 创建按钮与列表项共用 mutationPending 闸门，切换中不可新建。
                    // [失败路径] 创建失败时弹层保持打开并保留输入，用户可在原处重试。
                    // [权衡] 创建弹层不复用 Command 内输入，改开 createDialogOpen 独立表单以便展示错误。
                    setOpen(false);
                    setCreateDialogOpen(true);
                  }}
                >
                  <PlusIcon className="size-4 text-foreground-subtle" />
                  {intl.formatMessage({
                    id: "git.branchSwitcher.createAction",
                  })}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="lg"
                  className="w-full justify-start px-2 text-foreground hover:bg-menu-hover hover:text-foreground"
                  onClick={() => {
                    setOpen(false);
                    // [事务] 图谱是只读视图，打开前先关列表，保证同一时刻只有一个浮层。
                    // [契约] 图谱不接收 mutationPending，浏览历史不影响切换闸门。
                    // [资源] 图谱数据由 GitGraphDialog 按 workspacePath 自取，本组件不预取。
                    setGitGraphDialogOpen(true);
                  }}
                >
                  <GitGraph className="size-4 text-foreground-subtle" />
                  {intl.formatMessage({ id: "gitGraph.menuAction" })}
                </Button>
              </div>
            ) : null}
          </PopoverContent>
        </Popover>
      </div>

      <GitBranchCreateDialog
        open={createDialogOpen}
        branchName={createBranchName}
        mutationPending={mutationPending}
        onOpenChange={(nextOpen) => {
          setCreateDialogOpen(nextOpen);
          // [事务] 弹层关闭即清空分支名，避免下次打开残留上一次输入。
          // [失败路径] 取消与点击遮罩都走同一清理路径，不留下半填表单。
          // [权衡] 清理放在 onOpenChange 而非卸载 effect，保证受控开关每次关闭都生效。
          if (!nextOpen) {
            setCreateBranchName("");
          }
        }}
        onBranchNameChange={setCreateBranchName}
        onCancel={() => {
          setCreateDialogOpen(false);
          setCreateBranchName("");
        }}
        onSubmit={() => {
          // [事务] 提交只表达「创建并切换」意图，命名校验与重名冲突由 hook 承担。
          // [失败路径] 失败时 createDialogOpen 由 hook 维持，已填输入不清空。
          // [并发] 弹层按钮已按 mutationPending 禁用，重复提交由 hook 保证幂等。
          void createBranchAndSwitch();
        }}
      />

      <GitGraphDialog
        open={gitGraphDialogOpen}
        workspacePath={workspacePath}
        onOpenChange={setGitGraphDialogOpen}
      />

      <GitBranchSwitchAssistDialog
        step={switchAssistStep}
        state={switchAssistState}
        currentBranchLabel={switchAssistCurrentBranchLabel}
        commitMessage={commitMessage}
        commitError={commitError}
        mutationPending={mutationPending}
        onClose={closeSwitchAssistDialog}
        onOpenCommit={openSwitchCommitDialog}
        onCommitMessageChange={setCommitMessage}
        onSubmit={() => {
          // [事务] 提交后切换：commit 成功才 checkout，顺序由 hook 保证。
          // [失败路径] commitError 回填到弹层，用户修正信息后再次提交。
          // [并发] mutationPending 覆盖提交全过程，期间关闭弹层不改变错误归属。
          void commitAndSwitchBranch();
        }}
      />
    </>
  );
}
