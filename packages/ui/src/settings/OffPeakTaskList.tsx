/* 闲时任务列表（Figma「Automations - Task list Idle-time task」/ node 4866-1735）：
   2 列卡片网格，卡片结构与定时任务卡同源（MR 1622 设计）：标题 + 指令描述 +
   底部（moon + #N in queue 位次徽章）。按创建时间倒序；hover 菜单按状态收敛（D29/D30）。
   位次无 Est.（D30-1）。 */
// 闲时任务列表视图（OffPeakTaskList）：把 ZCodeOffPeakTask 只读数组投影为 2 列卡片网格、
// 状态脚注与 hover 菜单，并把暂停/继续/取消/删除/打开会话等写操作以回调形式上抛。
// 不负责：任务调度、队列位次与状态流转（来自 @zcode/shared 的任务快照）、脚注文案与
// 图标语义（offPeakUiPresentation）、操作幂等与乐观更新（父级 AutomationsSection 及服务层）。
//
// INV-01 断言：列表顺序只由 createdAt 倒序决定，状态变化不得改变卡片位次 —— 守住它的位置：sortOffPeakTasksByCreatedAt 及其唯一调用点 sorted —— 改错故障：任务由 running 转 completed 时卡片跳到末尾，用户跟丢正在跟踪的任务。
// INV-02 断言：排序必须发生在内存副本上，不得原地重排入参 —— 守住它的位置：sortOffPeakTasksByCreatedAt 中的展开复制 —— 改错故障：上游 store 切片被就地打乱，其他视图顺序同时变化且 memo 比较结果失真。
// INV-03 断言：操作在途判定用 busyOperationId.endsWith(任务 id)，而非相等比较 —— 守住它的位置：主渲染中的 busy 常量 —— 改错故障：复合 id 永不匹配，按钮不置灰，重复点击发出多条并发指令。
// INV-04 断言：只有 queued/paused/running 才显示主操作与分组分割线 —— 守住它的位置：hasPrimaryMenuAction 与三个状态分支 —— 改错故障：终态菜单顶出一条没有分组语义的分割线，用户误判还有可执行动作。
// INV-05 断言：菜单项按状态互斥渲染，暂停/继续/取消三选一 —— 守住它的位置：DropdownMenuContent 内的三个条件分支 —— 改错故障：同一任务同时出现两个动作项，选中后回调重复触发、状态互相覆盖。
// INV-06 断言：卡片内部按钮与菜单的点击必须阻断冒泡 —— 守住它的位置：会话跳转按钮、菜单触发器与 DropdownMenuContent 的 onClick，以及提示入口 span 的 stopPropagation —— 改错故障：点菜单会连带触发 onOpen，详情页在操作同时被打开。
// INV-07 断言：菜单触发器在 busy 为真时保持 disabled —— 守住它的位置：DropdownMenuTrigger 内 button 的 disabled 属性 —— 改错故障：同一任务的操作请求在途时仍可再次打开菜单并重复提交。
// INV-08 断言：模型选择问题只在 shouldShowOffPeakModelSelectionIssue 为真时覆盖状态脚注 —— 守住它的位置：footer 的三元表达式 —— 改错故障：已完成任务显示「需修复模型」，用户误以为结果不可信并重复重跑。
// INV-09 断言：状态徽章 shrink-0 不可压缩，只允许会话标题 truncate —— 守住它的位置：脚注容器的 flex 与两个子项的 shrink 类名 —— 改错故障：长会话标题把状态文字压到只剩一个字，主信息丢失。
// INV-10 断言：旋转动画只加在 running 的状态图标上 —— 守住它的位置：FooterIcon 的 className 条件拼接 —— 改错故障：完成态永久转圈，用户以为任务仍在执行。
// INV-11 断言：提示浮层的翻向由 resolveOffPeakMenuHintSide 计算，右向空间不足时改为上方右对齐 —— 守住它的位置：updateSide 与 ControlHintTooltip 的 side/align —— 改错故障：依赖 Radix 自动翻到左侧，气泡盖住整个菜单、遮住被解释的菜单项。
// INV-12 断言：resize 监听的挂载与移除必须使用同一个函数引用，且只在 open 期间存在 —— 守住它的位置：useEffect 的依赖数组与返回的清理函数 —— 改错故障：监听逐次累积，一次缩放触发成倍 setState，内存与重渲染同时增长。
// INV-13 断言：仅当任务数超过 OFFPEAK_LIST_SCROLL_THRESHOLD 时才启用滚动容器与高度上限 —— 守住它的位置：网格 className 的 cn 条件 —— 改错故障：8 张以内也出现滚动条与裁切阴影，与定时任务列表视觉不一致。
// INV-14 断言：STATUS_ICON 必须穷尽 OffPeakStatusIconKind 的所有取值 —— 守住它的位置：STATUS_ICON 常量表 —— 改错故障：新增 kind 后查表得到 undefined 组件，渲染阶段抛错导致整块列表白屏。
// INV-15 断言：空列表在排序之后判断，并返回单一占位块而非空网格 —— 守住它的位置：sorted.length === 0 的提前返回 —— 改错故障：空态先闪出空滚动容器，或返回 null 导致容器塌陷、标题与工具栏之间出现空洞。
//
// 改动的安全边界：本组件是纯展示层，唯一允许的「写」是调用父级传入的回调；任何看似无害的
// 本地持久化（记住滚动位置、缓存排序结果）都会引入第二份队列事实。
// 位次徽章 #N in queue 与 Est. 缺席属于产品决策（D30-1），不要在此补算剩余时间。
// 测试选择器统一取自 @zcode/shared/test-ids，改名会让 E2E 静默失配而不是报错。
// 卡片结构与定时任务卡同源（MR 1622），改版式前先确认两个列表是否需要同步演进。
//
// 阅读顺序：常量与纯函数（排序、浮层侧向）→ OffPeakMenuHint 浮层壳 → STATUS_ICON 映射 →
// OffPeakTaskList 主渲染（空态 → 网格 → 单卡脚注 → 右上角操作区 → 菜单项）。
// 行内既有注释记录了 Bug/修复原因与回归条件，重构时不要删除或缩短。
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type SVGProps,
} from "react";
import { CircleCheck, Loader2, TriangleAlert } from "lucide-react";
import { type ZCodeOffPeakTask } from "@zcode/shared";
import {
  TID_OFFPEAK_ACTION_CONTINUE,
  TID_OFFPEAK_ACTION_DELETE,
  TID_OFFPEAK_ACTION_PAUSE,
  TID_OFFPEAK_CARD,
  TID_OFFPEAK_CARD_SESSION,
  TID_OFFPEAK_CARD_MENU,
} from "@zcode/shared/test-ids";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  AutomationCancelActionIcon,
  AutomationContinueIcon,
  AutomationExternalLinkIcon,
  AutomationIdleTimeIcon,
  AutomationInfoIcon,
  AutomationMoreHorizontalIcon,
  AutomationPauseActionIcon,
  AutomationPausedIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationDesignPrimitives.js";
import {
  resolveFailedOffPeakQueueFooter,
  resolveOffPeakStatusFooter,
  shouldShowOffPeakModelSelectionIssue,
  type OffPeakStatusIconKind,
} from "@/settings/offPeakUiPresentation.js";

interface OffPeakTaskListProps {
  tasks: readonly ZCodeOffPeakTask[];
  busyOperationId: string | null;
  onOpen: (task: ZCodeOffPeakTask) => void;
  onPause: (task: ZCodeOffPeakTask) => void;
  onContinue: (task: ZCodeOffPeakTask) => void;
  onCancel: (task: ZCodeOffPeakTask) => void;
  onDelete: (task: ZCodeOffPeakTask) => void;
  onOpenSession: (task: ZCodeOffPeakTask) => void;
}

// 按状态分组会让任务在运行和终态切换时跳位，破坏用户对已有卡片位置的预期；
// 列表只按不可变的创建时间倒序，状态变化不再影响顺序。
// [契约] 这里是列表顺序的唯一出口，只在内存副本上排序，不能改成原地 sort。
// 入参可能是只读的 store 切片，原地排序会让上游数组在本次渲染期间被重排，
// 表现为其他视图里同一批任务顺序忽然变化，且 memo 比较结果与真实内容不一致。
export function sortOffPeakTasksByCreatedAt(
  tasks: readonly ZCodeOffPeakTask[],
): ZCodeOffPeakTask[] {
  return [...tasks].sort((a, b) => b.createdAt - a.createdAt);
}

/** 与 AutomationsSection 定时任务列表相同的滚动阈值（Figma 规范最多露出 8 张卡片）。 */
// [契约] 8 是 Figma 规范里一屏可见的卡片上限，定时任务列表与本文件共用同一口径，
// 为个案微调会让两个列表的折叠高度分叉，用户切换页面时感到布局跳动。
// 高度阈值（1198px / 606px）按 132px 行高与 gap 手算得到，不随容器宽度自适应，
// 调整行高或 gap 时必须同步这两个值，否则会出现半张卡片被裁切或提前出现滚动条。
export const OFFPEAK_LIST_SCROLL_THRESHOLD = 8;

// 浮层最大宽度与右偏移共同决定何时翻到菜单上方，偏移量同时充当 sideOffset 与安全边距。
// 只改宽度会让提示贴边或被菜单裁切，只改偏移会让翻向判断比实际可用空间更乐观。
// 这两个值刻意不放进 props，避免同一菜单内多个提示实例得出不同的翻向结果。
const OFFPEAK_MENU_HINT_MAX_WIDTH = 320;
const OFFPEAK_MENU_HINT_RIGHT_OFFSET = 16;

type OffPeakMenuHintSide = "right" | "top";

// [权衡] 这里刻意不依赖 Radix 的碰撞翻转：右侧空间不足时它会翻到 left，
// 而左侧紧邻的是整个下拉菜单内容，气泡会盖住被解释的那一项，用户失去对照。
// 改为「右侧够宽用 right，否则 top + 末尾对齐」，保证气泡朝远离菜单的方向展开。
// 阈值用视口宽度减触发器右边界而非触发器自身宽度，因为菜单贴右显示，
// 真正决定可用空间的是右边界到视口边缘的距离。
export function resolveOffPeakMenuHintSide(
  triggerRect: Pick<DOMRect, "right"> | null,
  viewportWidth: number,
): OffPeakMenuHintSide {
  // [失败路径] 首次打开时 ref 可能还未挂到 DOM，测距返回空，此时按 top 处理。
  // 不能在这里抛错或默认 right：空引用属于正常挂载时序，不是异常分支。
  // top 是更保守的选择——宁可气泡在上方，也不要横向溢出到视口之外。
  if (!triggerRect) {
    return "top";
  }
  return viewportWidth - triggerRect.right >=
    OFFPEAK_MENU_HINT_MAX_WIDTH + OFFPEAK_MENU_HINT_RIGHT_OFFSET
    ? "right"
    : "top";
}

// [资源] 每个菜单项内的信息入口各持一份 open/side 状态与 resize 订阅，
// 因此这层壳必须保持轻量：不引入 portal、不做测量循环、不订阅全局滚动。
// 菜单关闭时 Radix 会卸载菜单项，状态随之回收，不需要额外的清理登记。
function OffPeakMenuHint({ children, title }: { children: ReactNode; title: string }) {
  // [契约] 类型放宽到 HTMLElement，是因为提示会把 ref 挂到实际的触发元素上。
  // 不要在渲染期读取 current 来计算 side：布局尚未提交，读到的是上一帧的位置。
  // 测距只允许发生在打开前与 resize 回调里，否则会引发布局抖动与重复渲染。
  const triggerRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<OffPeakMenuHintSide>("right");

  // [并发] resize 可能在同一帧内多次触发，这里不节流是刻意的：测距只在浮层打开期间
  // 执行，getBoundingClientRect 的同步布局代价可接受；若改成按帧批处理，
  // 拖动窗口时气泡会明显滞后于菜单，出现气泡先悬空再跳位的撕裂感。
  const updateSide = useCallback(() => {
    // 提示入口位于菜单内部。窄窗口下 Radix 会把 right 自动翻到 left，
    // 左侧提示会穿过整个菜单；横向空间不足时改到菜单上方，避免提示与操作项互相覆盖。
    setSide(
      resolveOffPeakMenuHintSide(
        triggerRef.current?.getBoundingClientRect() ?? null,
        window.innerWidth,
      ),
    );
  }, []);

  // [资源] 监听只在浮层打开时挂载，关闭即卸载，避免每张卡片常驻 window 监听。
  // 依赖里的 updateSide 由空依赖 useCallback 固定，引用稳定，不会反复重挂。
  // [失败路径] 若把 open 从依赖中移除，浮层关闭后监听仍然存在，
  // resize 会持续 setState 已关闭的组件，造成无意义重渲染甚至开发期告警。
  useEffect(() => {
    if (!open) {
      return;
    }
    updateSide();
    window.addEventListener("resize", updateSide);
    // [资源] 清理必须移除同一个函数引用，挂载与移除的参数要完全一致。
    // 不要用匿名箭头包裹 updateSide，那样移除无法命中，监听会逐次累积，
    // 每打开一次菜单就多一份监听，最终一次缩放触发成倍的状态更新。
    return () => window.removeEventListener("resize", updateSide);
  }, [open, updateSide]);

  // [契约] side 与 align 必须成对决定：top 时用末尾对齐贴住菜单右缘，right 时垂直居中。
  // max-w 用 min(20rem, 100vw-1rem) 保证极窄视口下气泡不越出屏幕。
  // 这两条约束共同替代 Radix 的碰撞检测，改动任一项都会破坏窄窗口布局。
  return (
    <ControlHintTooltip
      title={title}
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          updateSide();
        }
        setOpen(nextOpen);
      }}
      triggerRef={triggerRef}
      side={side}
      align={side === "top" ? "end" : "center"}
      sideOffset={OFFPEAK_MENU_HINT_RIGHT_OFFSET}
      className="max-w-[min(20rem,calc(100vw-1rem))]"
    >
      {children}
    </ControlHintTooltip>
  );
}

// [契约] 这是 OffPeakStatusIconKind 到图标组件的穷尽表，新增 kind 必须同步补条目，
// 否则 footer.icon 取到未知值时会得到 undefined 组件，渲染阶段直接抛错。
// pause 与 stopped 共用同一种停止图标是有意的：产品只区分「可继续」与「已终止」，
// 不要为了视觉差异给 stopped 换图标，否则与菜单里的继续/取消动作产生歧义。
const STATUS_ICON: Record<OffPeakStatusIconKind, ComponentType<SVGProps<SVGSVGElement>>> = {
  moon: AutomationIdleTimeIcon,
  // 设计稿中 Paused 状态是圆形停止图标，旧双竖线会被误读为媒体暂停控件。
  pause: AutomationPausedIcon,
  spinner: Loader2,
  success: CircleCheck,
  warning: TriangleAlert,
  stopped: AutomationPausedIcon,
};

// [契约] 本组件不持有任务事实：tasks 由父级注入，真实状态以服务端与队列为准。
// 所有动作只上抛 task 对象，busyOperationId 也是父级投影，这里不做乐观更新。
// 任何在此新增的本地状态（例如「已确认删除」）都会形成第二份真相，
// 刷新或切换窗口后二者不一致，表现为卡片短暂消失又回来。
export function OffPeakTaskList({
  tasks,
  busyOperationId,
  onOpen,
  onPause,
  onContinue,
  onCancel,
  onDelete,
  onOpenSession,
}: OffPeakTaskListProps) {
  // 全部文案走 i18n 消息 id，不拼接字符串：中英文长度差异会直接改变徽章与菜单宽度。
  // formatMessage 的取值来自 footer 投影，不要在渲染期重新计算队列位次。
  // 缺少消息 id 会回退为 id 本身，长 id 会把脚注撑开，新增文案必须同时补齐资源。
  const { intl } = useZCodeIntl();
  // [权衡] 每次渲染都重新排序而不加缓存：任务量以「个」计，复制加排序的成本远低于
  // 维护一个可能过期的缓存。若为性能引入 memo，必须同时保证 tasks 的引用稳定性，
  // 否则上游每次传新数组，缓存每次都失效，反而多一层比较开销。
  const sorted = sortOffPeakTasksByCreatedAt(tasks);

  // [失败路径] 空态判断必须在排序之后：父级可能在加载完成前传入空数组，
  // 此时渲染网格会先闪出一个空的滚动容器，再被占位文案替换。
  // 占位块沿用卡片的圆角与边框，是为了避免加载完成瞬间布局高度突变。
  // 不要在这里返回 null，外层容器会因此塌陷，标题与工具栏之间出现空隙。
  if (sorted.length === 0) {
    return (
      <div className="rounded-[10px] border border-card-border px-3 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "offPeak.list.empty" })}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid auto-rows-[132px] grid-cols-1 gap-x-4 gap-y-4 lg:grid-cols-2",
        // 与定时任务列表同一口径：最多露出 8 张卡片，超出由 grid 自身滚动，避免页面无限拉长。
        sorted.length > OFFPEAK_LIST_SCROLL_THRESHOLD &&
          "max-h-[1198px] overflow-y-auto overscroll-contain lg:max-h-[606px]",
      )}
    >
      {sorted.map((task) => {
        // [契约] 模型选择问题优先于任务状态脚注：状态已完成但模型不可用时，
        // 必须显示「需修复」而不是「已完成」，否则用户会把不可信的结果当真。
        // 覆盖条件受 shouldShowOffPeakModelSelectionIssue 限制，终态任务不再提示修复。
        const footer =
          task.modelSelectionIssue && shouldShowOffPeakModelSelectionIssue(task.status)
            ? {
                icon: "warning" as const,
                className: "text-warning",
                labelId: "offPeak.modelSelection.repairRequired",
              }
            : resolveOffPeakStatusFooter(task);
        // [契约] 图标由 footer.icon 查表得到，取值必须始终落在 STATUS_ICON 的键内。
        // 这里不做兜底组件：兜底会掩盖投影层新增 kind 却漏配图标的问题，等到线上才暴露。
        // 图标统一 aria-hidden，语义由相邻文案承载，读屏不会重复播报状态。
        const FooterIcon = STATUS_ICON[footer.icon];
        const failedQueueFooter = resolveFailedOffPeakQueueFooter(task);
        const FailedQueueIcon = failedQueueFooter ? STATUS_ICON[failedQueueFooter.icon] : null;
        // [契约] busyOperationId 是复合标识，要用后缀匹配任务 id，而不是严格相等。
        // 改成严格相等会让真实操作 id 全部匹配失败，按钮永不置灰，重复点击发出并发指令。
        // 可选链之后的 false 表示「没有操作在途」，不代表「状态未知」，不要改成 null 语义。
        const busy = busyOperationId?.endsWith(task.offPeakTaskId) ?? false;
        // [契约] 只有能产生主操作（暂停/继续/取消）的状态才需要分组分割线，
        // 终态菜单只剩删除，若仍渲染分割线就会出现一条没有分组语义的顶线。
        // 这里的条件必须与下方三个状态分支保持一致，增删分支时同步修改。
        const hasPrimaryMenuAction =
          task.status === "queued" || task.status === "paused" || task.status === "running";
        // [契约] 卡片根节点同时承担点击与键盘激活，Enter 与空格必须 preventDefault，
        // 否则空格会滚动页面，页面在打开详情的同时发生位移。
        // 内层按钮统一阻断冒泡，避免顺带触发卡片自身的 onOpen。
        return (
          <div
            key={task.offPeakTaskId}
            data-testid={TID_OFFPEAK_CARD}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(task)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(task);
              }
            }}
            className={cn(
              // inset surface shadow 不是 Card 描边语义，明暗主题下会与首页卡片产生色差。
              "group relative flex h-full min-h-0 cursor-pointer gap-3 overflow-hidden rounded-[10px] border border-card-border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
              // 完成态保持整体置灰，但仍需用 hover 背景反馈卡片可点击、更多菜单可操作。
              task.status === "completed" ? "opacity-60 hover:bg-hover" : "hover:bg-hover",
            )}
          >
            <div className="flex h-full min-w-0 flex-1 flex-col gap-3">
              <span className="block truncate pr-14 text-ui-base font-medium leading-5 text-foreground">
                {task.title || task.prompt}
              </span>
              {/* 修复原因：任务卡正文与状态字号可缩放，固定 18px 行高会在大字号下挤压或裁切文字。 */}
              <p className="line-clamp-2 h-9 text-ui-base font-normal leading-snug text-foreground-subtle">
                {task.prompt}
              </p>
              <div className="mt-auto flex h-6 min-w-0 items-center gap-[10px] text-ui-base leading-snug">
                {/* Bug 原因：状态徽章与右侧「运行会话：…」都允许收缩，长会话标题会把状态文字压到只剩一个字。
                   状态是脚注的主信息，改为 shrink-0 不可压缩，只让会话标题那一段 truncate。 */}
                <div
                  className={cn(
                    "flex w-fit shrink-0 items-center gap-0.5 font-normal",
                    footer.className,
                    (task.status === "queued" || task.status === "paused") &&
                      // Zai Dark 的 brand 是白色，闲时排队 Tag 必须使用设计稿专用紫色语义。
                      "rounded-[8px] bg-idle-task-surface py-0.5 pl-1 pr-2 text-idle-task",
                  )}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center">
                    <FooterIcon
                      className={cn("size-4 shrink-0", task.status === "running" && "animate-spin")}
                      strokeWidth={1.33}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="truncate">
                    {intl.formatMessage({ id: footer.labelId }, footer.labelValues)}
                  </span>
                </div>
                {failedQueueFooter && FailedQueueIcon ? (
                  <div className="flex w-fit shrink-0 items-center gap-0.5 rounded-[6px] bg-idle-task-surface py-0.5 pl-1 pr-2 text-idle-task opacity-40">
                    <span className="flex size-5 shrink-0 items-center justify-center">
                      <FailedQueueIcon
                        className="size-4 shrink-0"
                        strokeWidth={1.33}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="truncate">
                      {intl.formatMessage(
                        { id: failedQueueFooter.labelId },
                        failedQueueFooter.labelValues,
                      )}
                    </span>
                  </div>
                ) : null}
                {task.sessionTitle ? (
                  // 会话内创建的任务绑定并运行在创建它的会话里，脚注露出会话标题。
                  <span
                    data-testid={TID_OFFPEAK_CARD_SESSION}
                    className="ml-auto min-w-0 truncate text-foreground-subtle"
                    title={task.sessionTitle}
                  >
                    {intl.formatMessage(
                      { id: "offPeak.boundSession.label" },
                      { title: task.sessionTitle },
                    )}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="absolute right-3 top-3 flex items-center gap-1">
              {task.sessionId ? (
                <button
                  type="button"
                  className="flex size-6 items-center justify-center rounded-md opacity-100 transition-colors hover:bg-white/10 md:opacity-0 md:group-hover:opacity-100"
                  aria-label={intl.formatMessage({
                    id: "offPeak.goToSession",
                  })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenSession(task);
                  }}
                >
                  <AutomationExternalLinkIcon
                    className="size-4 text-foreground-subtle"
                    aria-hidden="true"
                  />
                </button>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex size-6 items-center justify-center rounded-md opacity-100 transition-colors hover:bg-white/10 md:opacity-0 md:group-hover:opacity-100 data-[state=open]:bg-white/10 data-[state=open]:opacity-100"
                    data-testid={TID_OFFPEAK_CARD_MENU}
                    aria-label={intl.formatMessage({
                      id: "automations.moreActions",
                    })}
                    disabled={busy}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <AutomationMoreHorizontalIcon
                      className="size-4 text-foreground-subtle"
                      aria-hidden="true"
                    />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  sideOffset={4}
                  className="w-[190px]"
                  onClick={(event) => event.stopPropagation()}
                >
                  {task.status === "queued" ? (
                    <DropdownMenuItem
                      className="gap-1"
                      data-testid={TID_OFFPEAK_ACTION_PAUSE}
                      onSelect={() => onPause(task)}
                    >
                      <span className="flex size-5 items-center justify-center">
                        <AutomationPauseActionIcon className="size-4" aria-hidden="true" />
                      </span>
                      <span className="flex-1">
                        {intl.formatMessage({ id: "offPeak.action.pause" })}
                      </span>
                      {/* 修复原因：暂停已改为立即执行，不再弹二次确认；保留信息入口承载
                         排队等待时间与重新入队的产品提示，避免用户无从了解操作后果。 */}
                      <OffPeakMenuHint
                        title={intl.formatMessage({
                          id: "offPeak.action.pauseHint",
                        })}
                      >
                        {/* 修复原因：提示入口嵌在可选择菜单项内，click 冒泡会直接执行
                           Pause / Continue；只隔离 click，避免 pointerdown 干扰 Radix 选中时序。 */}
                        <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
                          <AutomationInfoIcon
                            className="size-3.5 shrink-0 text-foreground-subtle"
                            aria-hidden="true"
                          />
                        </span>
                      </OffPeakMenuHint>
                    </DropdownMenuItem>
                  ) : null}
                  {task.status === "paused" ? (
                    <DropdownMenuItem
                      className="gap-1"
                      data-testid={TID_OFFPEAK_ACTION_CONTINUE}
                      onSelect={() => onContinue(task)}
                    >
                      <span className="flex size-5 items-center justify-center">
                        <AutomationContinueIcon className="size-4" aria-hidden="true" />
                      </span>
                      <span className="flex-1">
                        {intl.formatMessage({
                          id: "offPeak.action.continue",
                        })}
                      </span>
                      <OffPeakMenuHint
                        title={intl.formatMessage({
                          id: "offPeak.action.continueHint",
                        })}
                      >
                        <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
                          <AutomationInfoIcon
                            className="size-3.5 shrink-0 text-foreground-subtle"
                            aria-hidden="true"
                          />
                        </span>
                      </OffPeakMenuHint>
                    </DropdownMenuItem>
                  ) : null}
                  {task.status === "running" ? (
                    <DropdownMenuItem className="gap-1" onSelect={() => onCancel(task)}>
                      {/* 修复原因：细描边 X 比相邻操作图标轻，且与首页 Chat 的暂停生成语义不一致。 */}
                      <span className="flex size-5 items-center justify-center">
                        <AutomationCancelActionIcon
                          className="size-4 fill-current"
                          aria-hidden="true"
                        />
                      </span>
                      {intl.formatMessage({ id: "offPeak.action.cancel" })}
                    </DropdownMenuItem>
                  ) : null}
                  {/* 修复原因：终态菜单只有删除一项时，固定分割线会变成没有分组语义的顶线。 */}
                  {hasPrimaryMenuAction ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem
                    className="gap-1 !text-destructive data-[highlighted]:!bg-menu-hover data-[highlighted]:!text-destructive focus:!text-destructive [&_svg]:!text-destructive"
                    data-testid={TID_OFFPEAK_ACTION_DELETE}
                    onSelect={() => onDelete(task)}
                  >
                    <AutomationTrashIcon />
                    {intl.formatMessage({ id: "automations.delete" })}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        );
      })}
    </div>
  );
}
