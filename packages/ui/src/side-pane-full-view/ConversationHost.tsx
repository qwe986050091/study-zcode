// Side Pane 完整视图的对话宿主（spec：docs/ui/side-pane-full-view.md）。
// 它包住 conversation-column 里唯一的 SessionPane 实例，只改变定位方式，不移动 DOM、不重挂载：
// - normal：静态布局，与原三栏一致；
// - conversation：fixed 铺满面板内容区（slot），对话全宽；
// - floating：fixed 浮在 slot 内的吸附位置，收起态只露出底部输入区。
// 几何值是 DOM 布局投影，直接写到宿主 style，不进入 React state，避免每次测量重渲染对话树。
// 本文件职责：Side Pane 完整视图里唯一的 SessionPane 宿主，负责把对话树放进不同定位模式。
//   - 做什么：按 normal / conversation / floating 三种模式计算并写入宿主几何，管理浮窗的
//     拖拽、吸附、最小化与回答气泡，并把运行状态经 context 广播给对话内部。
//   - 不做什么：不渲染对话内容、不发请求、不保存会话数据；children 由上层传入且只挂载一次。
//   - 依赖谁：model 里的纯几何与气泡归约函数、contract 里的模式与状态类型、intl 提供文案。
//   - 被谁调用：side pane 完整视图的对话列，作为对话树的唯一定位容器。
//   - 边界：几何是 DOM 布局投影，直接写 style，不进 React state，避免测量引发对话树重渲染。
//   - 失败边界：宿主或 slot 不存在时只清理内联样式，不抛错、不回退到错误的定位模式。
//   - 资源边界：ResizeObserver 与 window resize 监听必须成对释放，否则切换模式后泄漏。
//
// INV（不变量：每一条都对应一处曾经的布局或交互故障，改动前逐条确认）：
// INV-01 几何只能写入宿主内联样式，不能进入 React state：测量结果每次变化都会触发对话树重渲染 —— 守住它的位置：useLayoutEffect 内 apply 的全部样式赋值 —— 改错故障：拖拽或窗口缩放时对话树持续抖动。
// INV-02 normal 模式或 slot 缺失时必须移除全部几何属性与变量：残留会让静态布局被浮窗尺寸污染 —— 守住它的位置：useLayoutEffect 开头的提前返回分支 —— 改错故障：退出完整视图后三栏布局出现偏移。
// INV-03 清理函数必须同时断开观察器与移除窗口监听：只清一半会在模式切换后叠加回调 —— 守住它的位置：useLayoutEffect 返回的清理函数 —— 改错故障：多次切换后每次缩放触发多轮几何重算并卡顿。
// INV-04 几何效应的依赖必须包含吸附位置、最小化、模式、尺寸解析与 slot：删任一项都会沿用旧几何 —— 守住它的位置：useLayoutEffect 的依赖数组 —— 改错故障：切换吸附点或最小化后浮窗停在旧坐标。
// INV-05 最小化与恢复之间切换必须临时关闭过渡并强制提交样式：否则高度会先从按钮尺寸拉到整窗再回落 —— 守住它的位置：最小化切换标记分支与随后的强制回流 —— 改错故障：恢复动画出现背景先变高再下坠的跳变。
// INV-06 最小化期间内部内容仍按浮窗宽度排版：不能随按钮尺寸重排 —— 守住它的位置：框宽变量的写入与最小化时不可见的输入层 —— 改错故障：恢复后测得输入区高度错误，浮窗高度错位。
// INV-07 吸附位置必须经边界收敛到 slot 内：拖拽位置不能直接写回 —— 守住它的位置：apply 中的位置计算与松手时的落点计算 —— 改错故障：浮窗被拖出面板后无法找回。
// INV-08 拖拽位移必须超过点击阈值才进入拖动：低于阈值仍然算点击 —— 守住它的位置：moveDrag 内的阈值判断 —— 改错故障：轻点手柄既打开菜单又挪动浮窗。
// INV-09 拖拽事件必须校验指针标识：多指或残留事件不能继续驱动同一次拖拽 —— 守住它的位置：moveDrag 与 endDrag 的首个守卫 —— 改错故障：误触的第二根手指接管拖拽导致浮窗乱跳。
// INV-10 松手时按是否位移在点击与吸附之间二选一：两者互斥 —— 守住它的位置：endDrag 中位移标记的两个分支 —— 改错故障：拖动后误打开菜单，或点击手柄无响应。
// INV-11 拖拽结束必须清空拖拽位置引用：残留会让下次重算继续使用旧坐标 —— 守住它的位置：endDrag 与 cancelDrag 的引用清理 —— 改错故障：取消拖拽后浮窗跳到上一次松手位置。
// INV-12 落点吸附到同一吸附点时应只重算几何、不通知上层：避免无意义的父级更新 —— 守住它的位置：endDrag 中新旧吸附点的比较 —— 改错故障：每次拖动都触发上层重渲染。
// INV-13 回答气泡只在浮窗且收起态展示：其它形态下不能取用气泡数据 —— 守住它的位置：answer 的计算 —— 改错故障：展开或对话页签中仍浮出旧回答气泡。
// INV-14 离开浮窗形态时必须重置气泡基线而不是清空气泡：在对话页签看过的回答不应回切后弹出 —— 守住它的位置：浮窗布尔变化触发的清理效应 —— 改错故障：来回切换页签时已回答内容反复弹出。
// INV-15 气泡只按 owner 记录且在点击关闭或点击气泡时清除：不能按请求批次清空 —— 守住它的位置：状态上报的归约与关闭气泡的回调 —— 改错故障：同一会话的新提问把上一条回答气泡吞掉。
// INV-16 状态上报必须先比较三个字段再写 state：内容相同要返回原引用 —— 守住它的位置：上报回调内的比较函数 —— 改错故障：流式输出期间宿主持续重渲染。
// INV-17 最小化时出现新的阻塞交互才恢复，且必须比较请求标识：同一请求不能反复弹开 —— 守住它的位置：阻塞交互效应里的上一次标识比较 —— 改错故障：用户最小化后浮窗被同一权限请求立刻弹回。
// INV-18 拖动开始必须阻止默认行为，但菜单是否打开要看松手结果：Radix 会在指针按下时打开菜单 —— 守住它的位置：beginDrag 的阻止默认与 endDrag 的点击回调 —— 改错故障：按下手柄即弹菜单，拖拽无法进行。
// INV-19 关闭气泡不得抢走输入框焦点：失焦会收起抽屉，气泡随之闪烁 —— 守住它的位置：气泡关闭按钮的按下事件处理 —— 改错故障：点关闭气泡时整个操作栏闪一下再出现。
//
// 阅读顺序：先看常量与拖拽会话类型，再看宿主的状态、几何效应、拖拽、菜单与渲染。
// 几何写入只发生在 useLayoutEffect 与它暴露的 apply 引用里，其它地方不要直接改样式。
// 方向词：normal 为静态三栏，conversation 为铺满 slot，floating 为吸附浮窗。
// floating 的收起态指底部吸附的输入框，最小化态指圆形按钮，两者必须区分。
// 测试标识来自 shared/test-ids，任何改名都要同步 E2E，不要只改一处。
// 本文件的状态都随宿主生命周期存活，不要把它们提升到全局 store。
// 动画只作用于缩放与透明度，几何过渡在最小化切换时被临时关闭。
// 任何新增几何变量都要同时加入清理列表，否则普通模式会残留上一次的浮窗尺寸。
// 组件的 props 由上层持有，本文件只通过两个变更回调申请模式与吸附点变更。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  GripVerticalIcon,
  LoaderIcon,
  Maximize2Icon,
  MessageCircleIcon,
  MinusIcon,
  XIcon,
} from "lucide-react";
import {
  TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE,
  TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE_CLOSE,
  TID_SIDE_PANE_FULL_VIEW_BUBBLE,
  TID_SIDE_PANE_FULL_VIEW_DRAWER,
  TID_SIDE_PANE_FULL_VIEW_EXPAND,
  TID_SIDE_PANE_FULL_VIEW_HANDLE,
  TID_SIDE_PANE_FULL_VIEW_HEADER,
  TID_SIDE_PANE_FULL_VIEW_HOST,
  TID_SIDE_PANE_FULL_VIEW_MENU_MINIMIZE,
  TID_SIDE_PANE_FULL_VIEW_MENU_OPEN_CONVERSATION,
  TID_SIDE_PANE_FULL_VIEW_MINIMIZE,
  TID_SIDE_PANE_FULL_VIEW_RUNNING,
  TID_V4_COMPOSER_INPUT,
} from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  clampFloatingPosition,
  dismissFloatingAnswerBubble,
  FLOATING_DRAG_CLICK_THRESHOLD_PX,
  FLOATING_MINIMIZED_SIZE_PX,
  rebaselineFloatingAnswerBubbles,
  reduceFloatingAnswerBubbles,
  resolveFloatingAnswerPreview,
  resolveFloatingExpandedHeight,
  resolveFloatingPosition,
  resolveFloatingTransformOrigin,
  resolveFloatingWidth,
  resolveNearestFloatingAnchor,
  type FloatingPosition,
  type FloatingRect,
} from "@/side-pane-full-view/model.js";
import type {
  ConversationPaneFloatingStatus,
  ConversationPanePresentationValue,
  FloatingAnchor,
  FloatingAnswerBubbleState,
  SidePaneFullViewFloating,
  SidePaneFullViewHostMode,
} from "@/side-pane-full-view/contract.js";
import { ConversationPanePresentationContext } from "@/side-pane-full-view/conversationPanePresentation.js";

const FLOATING_HEADER_HEIGHT_PX = 40;
/** 操作栏隐藏时抽屉藏在输入框后面的高度；聚焦时从这里向上滑出。 */
const DRAWER_TUCK_UNDER_COMPOSER_PX = 16;
const GEOMETRY_PROPERTIES = ["left", "top", "width", "height"] as const;
const GEOMETRY_VARIABLES = [
  "--side-pane-full-view-frame-width",
  "--side-pane-full-view-pane-height",
  "--side-pane-full-view-clip-height",
  "--side-pane-full-view-drawer-height",
] as const;

interface DragSession {
  pointerId: number;
  startX: number;
  startY: number;
  origin: FloatingPosition;
  moved: boolean;
}

function readSlotRect(slot: HTMLElement): FloatingRect {
  const rect = slot.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

export function SidePaneFullViewConversationHost({
  mode,
  floating,
  anchor,
  slotElement,
  onFloatingChange,
  onAnchorChange,
  onOpenConversation,
  children,
}: {
  mode: SidePaneFullViewHostMode;
  floating: SidePaneFullViewFloating;
  anchor: FloatingAnchor;
  slotElement: HTMLElement | null;
  onFloatingChange: (floating: SidePaneFullViewFloating) => void;
  onAnchorChange: (anchor: FloatingAnchor) => void;
  onOpenConversation: () => void;
  children: ReactNode;
}) {
  // [契约] 文案必须在组件顶层取一次实例，事件回调里复用闭包中的值，不重复调用取词钩子。
  // 浮窗的状态、手柄、展开与恢复文案都来自这里，语言切换时整棵宿主会随 provider 重渲染。
  // 不要在渲染处临时构造文案，那会让同一语义出现多份键，翻译漏项时难以发现。
  // 新增文案一律走国际化接口，禁止硬编码，这是产品的硬约束。
  const { intl } = useZCodeIntl();
  // [契约] 这个引用是几何写入与拖拽测量的唯一句柄，不允许再用选择器找第二个宿主节点。
  // 所有样式写入、矩形测量与焦点查询都基于 hostRef，换成选择器可能命中错误实例。
  // 同一时刻只应存在一个宿主，若上层渲染两份，拖拽会话与几何会互相覆盖。
  // 该引用不参与渲染依赖，读取之前必须做空值判断。
  const hostRef = useRef<HTMLDivElement | null>(null);
  // [契约] 三种模式的判定只在这里展开一次，后续分支全部复用它，不要重复比较字符串。
  // 最小化与展开都是浮窗的子状态，必须同时满足浮窗才成立，缺前半段会把普通模式误判。
  // 这些布尔值参与多处依赖与渲染条件，调整判定顺序会同时影响几何、交互与可见性。
  // 模式字符串来自上层契约，本文件不新增第四种模式。
  const isFloating = mode === "floating";
  const isMinimized = isFloating && floating === "minimized";
  const isExpanded = isFloating && floating === "expanded";
  // [契约] 运行状态只保留运行中、阻塞交互标识与 owner 三个字段，不承接会话业务数据。
  // 阻塞交互标识用于判断是否出现新的权限或问答请求，owner 用于把气泡对齐到正确对话。
  // 初始 owner 为空表示还没有对话上报，此时气泡查询必然落空，这是有意的空值语义。
  // 状态更新必须经下方上报回调做字段比较，直接写会让流式输出期间持续重渲染。
  // 不要把三个字段拆成多个状态，否则一次上报会触发多轮渲染。
  const [status, setStatus] = useState<
    Pick<ConversationPaneFloatingStatus, "running" | "blockingInteractionId" | "ownerKey">
  >({
    running: false,
    blockingInteractionId: null,
    ownerKey: "",
  });
  /** 回答气泡按对话 owner 记录（只在内存里），只有点 × 或点气泡才清除。 */
  // [资源] 回答气泡只存在于内存并按 owner 记录，刷新页面即丢失，这是产品接受的范围。
  // 用不可变映射做归约，是为了让上报回调能安全地基于上一次结果计算下一次。
  // 只在点击关闭或点击气泡时清除，不能按请求批次清空，否则新提问会吞掉上一条回答。
  // 初始值为空映射而不是空对象，保持与归约函数的入参类型一致。
  // 该状态不落盘也不进入全局 store，避免气泡跨窗口串到别的对话。
  const [answerBubbles, setAnswerBubbles] = useState<
    ReadonlyMap<string, FloatingAnswerBubbleState>
  >(() => new Map());
  const [focusWithin, setFocusWithin] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  // [契约] headerVisible 必须同时满足浮窗、非最小化，且展开、聚焦、菜单打开、拖拽至少一项成立。
  // 四种触发条件是产品定义的显隐规则：展开常显，其余是临时显隐，松手或失焦即收起。
  // 这个布尔值同时驱动抽屉高度、输入层裁剪与无障碍状态，改动会连带几何一起变。
  // 最小化必须排除，圆形按钮上放不下操作栏，强行显示会遮挡状态图标。
  // 不要在这里追加鼠标悬停，悬停显隐会与焦点态互相打断。
  const headerVisible =
    isFloating && !isMinimized && (isExpanded || focusWithin || menuOpen || dragging);
  const dockHeightRef = useRef(0);
  const dragRef = useRef<DragSession | null>(null);
  const dragPositionRef = useRef<FloatingPosition | null>(null);
  /** 上一次写入的几何是否为最小化形态；用来识别最小化与恢复之间的切换。 */
  const appliedMinimizedRef = useRef<boolean | null>(null);
  const applyGeometryRef = useRef<() => void>(() => {});

  // [并发] 上报来自对话内部，可能随流式输出高频触发，必须先做字段比较再决定是否写入。
  // 三个字段都相同要返回原引用，这是避免宿主整棵重渲染的关键，删掉比较会让每个片段都渲染。
  // 气泡归约每次都要执行，即使状态未变，因为它需要吸收新的回答内容。
  // 回调依赖为空，说明它只用函数式更新与纯归约，不读外部变量；新增外部读取必须补依赖。
  // 不要把上报同步给父级，父级只需要浮窗模式与吸附位置。
  const reportFloatingStatus = useCallback((next: ConversationPaneFloatingStatus) => {
    setStatus((current) =>
      current.running === next.running &&
      current.blockingInteractionId === next.blockingInteractionId &&
      current.ownerKey === next.ownerKey
        ? current
        : {
            running: next.running,
            blockingInteractionId: next.blockingInteractionId,
            ownerKey: next.ownerKey,
          },
    );
    setAnswerBubbles((current) => reduceFloatingAnswerBubbles(current, next));
  }, []);
  // 离开浮窗形态（对话 tab、退出完整视图）时清空基线：在对话 tab 里看过的回答，
  // 切回浮窗不再弹出；已经弹出的气泡保留。
  // [资源] 离开浮窗形态时只调 setAnswerBubbles(rebaselineFloatingAnswerBubbles)，不清空已有气泡。
  // 依赖只有浮窗布尔值，这是有意的最小依赖：气泡内容变化不该触发基线重置。
  // 如果改成清空，从对话页签切回浮窗会丢失尚未关闭的回答入口。
  // 该效应没有清理函数，因为它只做一次内存状态修正。
  useEffect(() => {
    if (!isFloating) setAnswerBubbles(rebaselineFloatingAnswerBubbles);
  }, [isFloating]);
  const answer =
    isFloating && floating === "collapsed"
      ? (answerBubbles.get(status.ownerKey)?.answer ?? null)
      : null;
  // [权衡] 预览只取回答正文的前两行，截断在渲染之外完成，避免气泡里渲染整段富文本。
  // 仅当存在回答时才计算，空值直接返回空串，让渲染分支可以安全忽略内容。
  // 依赖是回答对象本身，不要把结果缓存到引用里，否则新回答不会刷新。
  const answerPreview = useMemo(
    () => (answer ? resolveFloatingAnswerPreview(answer.text) : ""),
    [answer],
  );
  // [契约] 输入区高度由对话内部测量后上报，宿主只缓存最新值并立即重算几何。
  // 相同高度必须提前返回，否则每次输入框渲染都会触发一轮几何读写，形成测量循环。
  // 通过引用调用几何函数而不是直接依赖布局效应的闭包，保证上报时拿到最新几何。
  // 缓存值不进入状态，避免高度变化引发宿主重渲染。
  const reportComposerDockHeight = useCallback((heightPx: number) => {
    if (dockHeightRef.current === heightPx) return;
    dockHeightRef.current = heightPx;
    applyGeometryRef.current();
  }, []);
  // [契约] 呈现上下文只暴露呈现类型与两个上报函数，不把宿主状态整体下传。
  // 依赖包含两个回调与浮窗布尔值，缺任一项都会让内部拿到旧的呈现判断。
  // 两个回调都用 useCallback 稳定引用，所以上下文只在模式切换时变化。
  // 不要在这里合并运行状态，内部需要通过回调上报，而不是被下发。
  const presentationValue = useMemo<ConversationPanePresentationValue>(
    () => ({
      presentation: isFloating ? "floating" : "docked",
      reportFloatingStatus,
      reportComposerDockHeight,
    }),
    [isFloating, reportComposerDockHeight, reportFloatingStatus],
  );

  // [契约] 浮窗尺寸由 slot 尺寸推导：最小化固定为按钮尺寸，展开按可用高度减标题栏，收起按输入区裁剪。
  // 收起态外层就是输入框本身，展开态输入层内缩 1px 露出抽屉边框，这个差异必须保留。
  // 抽屉高度在操作栏可见时取整窗高度，隐藏时只留 16px 藏在输入框后，两者不能混用。
  // 这里只做纯计算，不读 DOM 也不写样式，因此可以作为几何效应的稳定依赖。
  // 依赖只包含三个布尔值，槽位尺寸作为参数传入，保证同一输入得到同一输出。
  const resolveFrameSize = useCallback(
    (slot: FloatingRect) => {
      if (isMinimized) {
        return { width: FLOATING_MINIMIZED_SIZE_PX, height: FLOATING_MINIMIZED_SIZE_PX };
      }
      const paneHeight = Math.max(
        0,
        resolveFloatingExpandedHeight(slot.height) - FLOATING_HEADER_HEIGHT_PX,
      );
      const headerHeight = headerVisible ? FLOATING_HEADER_HEIGHT_PX : 0;
      // 收起态外层就是输入框本身；展开态输入层在抽屉内缩 1px，露出抽屉边框。
      const clipHeight = isExpanded
        ? Math.max(0, paneHeight - 1)
        : Math.min(dockHeightRef.current, paneHeight);
      const height = headerHeight + (isExpanded ? paneHeight : clipHeight);
      return {
        width: resolveFloatingWidth(slot.width),
        height,
        paneHeight: isExpanded ? clipHeight : paneHeight,
        clipHeight,
        // 修复原因：抽屉只伸到输入框后面 16px 时，抽屉底角与输入框顶角的圆角对出一个凹口。
        // 操作栏可见时抽屉一直延伸到浮窗底边，两侧边线连续，输入框像放在抽屉里。
        drawerHeight: headerVisible ? height : DRAWER_TUCK_UNDER_COMPOSER_PX,
      };
    },
    [headerVisible, isExpanded, isMinimized],
  );

  // [资源] 几何写入必须在布局阶段完成，否则绘制后再改尺寸会看到一帧错位。
  // 效应开头先处理普通模式与缺少 slot：清空全部内联属性与变量并让几何函数变为空操作。
  // 清理时同时断开尺寸观察与窗口监听，二者缺一都会在模式切换后叠加回调。
  // 依赖包含吸附位置、最小化、模式、尺寸解析与 slot，删任一项都会让浮窗停在旧几何。
  // 这里不写 React 状态，结果直接落到内联样式，避免测量引发对话树重渲染。
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (mode === "normal" || !slotElement) {
      for (const property of GEOMETRY_PROPERTIES) host.style.removeProperty(property);
      for (const variable of GEOMETRY_VARIABLES) host.style.removeProperty(variable);
      applyGeometryRef.current = () => {};
      appliedMinimizedRef.current = null;
      return;
    }
    // [事务] apply 是一次完整的几何提交：先读 slot，再算尺寸与位置，最后一次性写入宿主样式。
    // 对话模式直接铺满 slot 并提前返回，不参与浮窗的尺寸与位置计算。
    // apply 在最小化切换时必须临时关闭过渡并强制一次回流，让新几何立即生效。
    // 内部内容始终按浮窗宽度排版，即使最小化也不跟随按钮重排，否则测量高度会失真。
    // apply 的引用被保存在 ref 里，供上报函数在效应之外触发重算，因此每次效应都要刷新它。
    const apply = () => {
      const slot = readSlotRect(slotElement);
      if (mode === "conversation") {
        host.style.left = `${slot.left}px`;
        host.style.top = `${slot.top}px`;
        host.style.width = `${slot.width}px`;
        host.style.height = `${slot.height}px`;
        return;
      }
      const size = resolveFrameSize(slot);
      // 修复原因：恢复时宽度从圆形按钮的 48px 过渡到 560px，单行输入框在窄宽度下折成多行，
      // 测得的输入区高度先变大（实测 258px）再缩回 46px，浮窗背景先变高再往下掉。
      // 最小化与恢复之间切换时几何直接到位，只做从按钮所在角缩放 + 淡入（transform 不触发重排）。
      const crossingMinimized =
        appliedMinimizedRef.current !== null && appliedMinimizedRef.current !== isMinimized;
      appliedMinimizedRef.current = isMinimized;
      if (crossingMinimized) host.style.transition = "none";
      // 内部内容始终按浮窗宽度排版：最小化期间也不跟着 48px 重排，测得的输入区高度保持正确。
      host.style.setProperty(
        "--side-pane-full-view-frame-width",
        `${resolveFloatingWidth(slot.width)}px`,
      );
      if ("paneHeight" in size) {
        host.style.setProperty("--side-pane-full-view-pane-height", `${size.paneHeight}px`);
        host.style.setProperty("--side-pane-full-view-clip-height", `${size.clipHeight}px`);
        host.style.setProperty("--side-pane-full-view-drawer-height", `${size.drawerHeight}px`);
      }
      // [契约] 拖拽中的位置优先于吸附解析，但两者都必须经边界收敛后才写入。
      // 拖拽位置来自上一次指针位移，未经收敛直接写入会把浮窗放到面板外。
      // 没有拖拽位置时才按当前吸附点解析，保证普通重排不会漂移。
      // 这里不修改吸附状态，吸附只在松手时由拖拽结束逻辑提交。
      const position = dragPositionRef.current
        ? clampFloatingPosition(dragPositionRef.current, slot, size)
        : resolveFloatingPosition(anchor, slot, size);
      host.style.left = `${position.left}px`;
      host.style.top = `${position.top}px`;
      host.style.width = `${size.width}px`;
      host.style.height = `${size.height}px`;
      if (crossingMinimized) {
        // 强制提交一次样式，让上面的几何不带过渡生效，再恢复 CSS 过渡。
        void host.offsetWidth;
        host.style.removeProperty("transition");
        host.style.transformOrigin = resolveFloatingTransformOrigin(anchor);
        host.animate?.(
          [
            { opacity: 0, transform: "scale(0.92)" },
            { opacity: 1, transform: "scale(1)" },
          ],
          { duration: 150, easing: "ease-out" },
        );
      }
    };
    applyGeometryRef.current = apply;
    apply();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    resizeObserver?.observe(slotElement);
    window.addEventListener("resize", apply);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, [anchor, isMinimized, mode, resolveFrameSize, slotElement]);

  // 最小化时出现新的阻塞交互（权限 / 问答）自动恢复为收起态，卡片替换输入框显示在浮窗内。
  // 只响应新的请求 id：用户在请求等待期间再次最小化，不会被同一个请求反复弹开。
  // [并发] 记录已见过的阻塞交互标识，用于区分新请求与同一请求的重复上报。
  // 比较必须在更新引用之前完成，否则永远相等，自动恢复不会发生。
  // 只有最小化、标识非空、且与上一次不同才恢复为收起态，三个条件缺一不可。
  // 用引用而不是状态保存，是因为它只在效应内部参与判断，变化不需要渲染。
  const seenBlockingInteractionIdRef = useRef(status.blockingInteractionId);
  useEffect(() => {
    const previous = seenBlockingInteractionIdRef.current;
    seenBlockingInteractionIdRef.current = status.blockingInteractionId;
    if (isMinimized && status.blockingInteractionId && status.blockingInteractionId !== previous) {
      onFloatingChange("collapsed");
    }
  }, [isMinimized, onFloatingChange, status.blockingInteractionId]);

  // [契约] 恢复浮窗后要把焦点交还输入框，但必须等下一帧，等布局完成后再聚焦。
  // 通过测试标识查询输入框而不是保存元素引用，避免输入框重挂载后指向旧节点。
  // 查询失败时静默跳过，输入框可能尚未挂载，这不是错误。
  const focusComposer = useCallback(() => {
    window.requestAnimationFrame(() => {
      hostRef.current
        ?.querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)
        ?.focus();
    });
  }, []);

  const handleFocusCapture = useCallback(() => setFocusWithin(true), []);
  // [契约] 失焦要判断新焦点是否仍在宿主内部，内部转移不能收起操作栏。
  // 判断基于当前目标是否包含新焦点节点，空焦点时收起，这是可接受的降级。
  // 不要改成延时收起，延时会让点击操作栏按钮时的闪烁更明显。
  const handleBlurCapture = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setFocusWithin(false);
  }, []);

  // [并发] 只响应主键按下，其它按键不启动拖拽，避免右键菜单与拖拽叠加。
  // 按下时必须阻止默认行为，否则菜单组件会在指针按下时直接展开。
  // 指针捕获在按下时设置，保证指针移出宿主后仍能收到移动与松开事件。
  // 拖拽起点取宿主当前矩形，而不是指针位置，之后所有位移都相对这个原点。
  const beginDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const host = hostRef.current;
    if (!host) return;
    // 阻止 Radix 在 pointerdown 时打开菜单；是否打开由松手时是否发生拖动决定。
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = host.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { left: rect.left, top: rect.top },
      moved: false,
    };
  }, []);
  // [契约] 位移未超过阈值时不做处理，让轻点仍然按点击处理。
  // 首次超过阈值才标记拖动并更新渲染状态，避免每次移动都触发重渲染。
  // 指针标识不匹配的事件直接忽略，多指或残留事件不能接管当前拖拽。
  // 位移结果写入引用后立即请求重算几何，不经过 React 状态。
  const moveDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    if (!session.moved && Math.hypot(dx, dy) < FLOATING_DRAG_CLICK_THRESHOLD_PX) return;
    if (!session.moved) {
      session.moved = true;
      setDragging(true);
    }
    dragPositionRef.current = { left: session.origin.left + dx, top: session.origin.top + dy };
    applyGeometryRef.current();
  }, []);
  // [契约] 松开时按是否位移二选一：位移则吸附落点，未位移则执行传入的点击回调。
  // 无论哪种结果都要先清空拖拽引用，否则下一次重算会沿用旧位置。
  // 落点必须先收敛到面板内再求最近吸附点，在面板外求点会得到错误方向。
  // 吸附点未变化时只重算几何，不通知上层，避免无意义的父级更新。
  // 缺少宿主、落点或 slot 时提前返回，此时几何由后续布局效应兜底。
  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, onClick: () => void) => {
      const session = dragRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      dragRef.current = null;
      if (!session.moved) {
        onClick();
        return;
      }
      const host = hostRef.current;
      const dropped = dragPositionRef.current;
      dragPositionRef.current = null;
      setDragging(false);
      if (!host || !dropped || !slotElement) return;
      const slot = readSlotRect(slotElement);
      const rect = host.getBoundingClientRect();
      const nextAnchor = resolveNearestFloatingAnchor(
        clampFloatingPosition(dropped, slot, rect),
        slot,
        { width: rect.width, height: rect.height },
      );
      if (nextAnchor === anchor) {
        applyGeometryRef.current();
      } else {
        onAnchorChange(nextAnchor);
      }
    },
    [anchor, onAnchorChange, slotElement],
  );
  // [失败路径] 指针被系统取消时必须彻底复位拖拽会话、位置与渲染标记。
  // 复位后立即重算几何，让浮窗回到拖动前的吸附位置，而不是停在半途。
  // cancelDrag 不调用上层吸附变更，取消意味着放弃本次落点。
  const cancelDrag = useCallback(() => {
    dragRef.current = null;
    dragPositionRef.current = null;
    setDragging(false);
    applyGeometryRef.current();
  }, []);

  // [契约] 展开与收起是同一个按钮的两种状态，切换依据当前是否展开。
  // 状态变更交给上层持有的浮窗模式，本文件不自行维护第二份展开标记。
  // 依赖只有展开布尔与变更回调，新增判断要同步到操作栏可见性。
  const handleToggleExpanded = useCallback(() => {
    onFloatingChange(isExpanded ? "collapsed" : "expanded");
  }, [isExpanded, onFloatingChange]);
  const handleMinimize = useCallback(() => {
    setMenuOpen(false);
    onFloatingChange("minimized");
  }, [onFloatingChange]);
  // [契约] 关闭气泡只移除当前 owner 的记录，不影响其他对话的回答气泡。
  // 使用函数式更新，避免闭包里拿到过期的气泡映射。
  // 依赖是当前 owner，owner 变化后关闭的必须是新对话的气泡。
  const handleDismissAnswer = useCallback(() => {
    setAnswerBubbles((current) => dismissFloatingAnswerBubble(current, status.ownerKey));
  }, [status.ownerKey]);
  const handleOpenAnswer = useCallback(() => {
    handleDismissAnswer();
    onFloatingChange("expanded");
  }, [handleDismissAnswer, onFloatingChange]);
  const handleRestore = useCallback(() => {
    onFloatingChange("collapsed");
    focusComposer();
  }, [focusComposer, onFloatingChange]);

  // [契约] statusIcon 只区分运行中与空闲，运行中显示旋转指示。
  // 图标属于纯展示，不携带交互，因此统一加无障碍隐藏标记。
  // 不要在图标上挂运行状态文案，文案由按钮标签承担。
  const statusIcon = status.running ? (
    <LoaderIcon className="size-4 animate-spin text-foreground-subtle" aria-hidden="true" />
  ) : (
    <MessageCircleIcon className="size-4 text-foreground-subtle" aria-hidden="true" />
  );
  // [契约] 状态文案随运行中切换，同一个标识在按钮与指示器两处复用。
  // 最小化按钮与运行指示器必须显示同一句话，避免两套描述。
  // 文案标识必须存在于所有语言包，新增状态要先补翻译。
  const statusLabel = intl.formatMessage({
    id: status.running ? "sidePane.fullView.statusRunning" : "sidePane.fullView.statusIdle",
  });
  const handleLabel = intl.formatMessage({ id: "sidePane.fullView.handle" });
  const expandLabel = intl.formatMessage({
    id: isExpanded ? "sidePane.fullView.collapseMessages" : "sidePane.fullView.expandMessages",
  });
  const ExpandIcon = isExpanded ? ChevronDownIcon : ChevronUpIcon;

  // [契约] 宿主根节点只承载定位与事件捕获，视觉层级由内部各层自行声明。
  // 数据属性用于样式与测试定位，模式、浮窗形态、可见性与运行态都要如实反映。
  // 聚焦与失焦捕获只在浮窗模式挂载，普通模式不拦截任何焦点事件。
  // children 放在最内层且只渲染一次，任何条件包裹都可能导致对话树重挂载。
  return (
    <div
      ref={hostRef}
      data-testid={TID_SIDE_PANE_FULL_VIEW_HOST}
      data-side-pane-full-view-host={mode}
      data-floating={isFloating ? floating : undefined}
      data-header-visible={headerVisible ? "true" : "false"}
      data-dragging={dragging ? "true" : undefined}
      data-running={status.running ? "true" : "false"}
      onFocusCapture={isFloating ? handleFocusCapture : undefined}
      onBlurCapture={isFloating ? handleBlurCapture : undefined}
      className={cn(
        mode === "normal" && "relative h-full w-full",
        mode === "conversation" && "fixed z-30 flex flex-col",
        isFloating &&
          "fixed z-30 transition-[left,top,width,height] duration-150 ease-out data-[dragging=true]:transition-none",
      )}
    >
      <ConversationPanePresentationContext.Provider value={presentationValue}>
        {answer ? (
          // 回答气泡：只显示回答正文前两行，不显示图标与标题；顶部吸附位置时放在浮窗下方。
          <div
            data-testid={TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE}
            className={cn(
              "absolute inset-x-0 z-20",
              anchor.startsWith("top") ? "top-full mt-2" : "bottom-full mb-2",
            )}
          >
            <button
              type="button"
              aria-label={intl.formatMessage({ id: "sidePane.fullView.openAnswer" })}
              className="block w-full rounded-2xl border border-border bg-background px-4 py-3 text-left shadow-lg transition-colors hover:bg-hover"
              onClick={handleOpenAnswer}
            >
              <span className="line-clamp-2 text-ui-base text-foreground">{answerPreview}</span>
            </button>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              data-testid={TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE_CLOSE}
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="absolute -top-2 -left-2 rounded-full border bg-background shadow-sm"
              // 关闭不夺走输入框焦点，避免抽屉因焦点进出闪一下。
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleDismissAnswer}
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        ) : null}
        {isFloating && !isMinimized ? (
          // 抽屉层：在输入框后面，聚焦时随浮窗变高从输入框后面向上滑出；展开时铺满整个浮窗。
          <div
            data-testid={TID_SIDE_PANE_FULL_VIEW_DRAWER}
            data-open={headerVisible ? "true" : "false"}
            className={cn(
              "absolute inset-x-0 top-0 h-[var(--side-pane-full-view-drawer-height)] overflow-hidden rounded-2xl border border-border bg-background shadow-lg transition-[height,opacity] duration-150 ease-out",
              headerVisible ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          >
            {headerVisible ? (
              <div
                data-testid={TID_SIDE_PANE_FULL_VIEW_HEADER}
                data-expanded={isExpanded ? "true" : "false"}
                className="flex h-10 items-center gap-1 px-2"
                // 修复原因：菜单内容虽 portal 到 body，React 合成事件仍沿组件树冒泡；操作栏容器
                // 不挂点击行为，只阻止 mousedown 抢走输入框焦点，避免操作栏在点击前因失焦消失。
                onMouseDown={(event) => event.preventDefault()}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-testid={TID_SIDE_PANE_FULL_VIEW_MINIMIZE}
                  aria-label={intl.formatMessage({ id: "sidePane.fullView.minimize" })}
                  onClick={handleMinimize}
                >
                  <MinusIcon className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-testid={TID_SIDE_PANE_FULL_VIEW_EXPAND}
                  aria-label={expandLabel}
                  aria-expanded={isExpanded}
                  title={expandLabel}
                  onClick={handleToggleExpanded}
                >
                  <ExpandIcon className="size-4" />
                </Button>
                {status.running ? (
                  <span
                    role="status"
                    data-testid={TID_SIDE_PANE_FULL_VIEW_RUNNING}
                    aria-label={statusLabel}
                    title={statusLabel}
                    className="flex size-6 items-center justify-center"
                  >
                    <LoaderIcon
                      className="size-4 animate-spin text-foreground-subtle"
                      aria-hidden="true"
                    />
                  </span>
                ) : null}
                <div className="min-w-0 flex-1" />
                <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
                  <ControlHintTooltip title={handleLabel} side="top" align="end">
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        data-testid={TID_SIDE_PANE_FULL_VIEW_HANDLE}
                        aria-label={handleLabel}
                        className="cursor-grab touch-none data-[state=open]:bg-selected"
                        onPointerDown={beginDrag}
                        onPointerMove={moveDrag}
                        onPointerUp={(event) => endDrag(event, () => setMenuOpen(true))}
                        onPointerCancel={cancelDrag}
                      >
                        <GripVerticalIcon className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                  </ControlHintTooltip>
                  <DropdownMenuContent align="end" side="top" className="w-52">
                    <DropdownMenuItem
                      data-testid={TID_SIDE_PANE_FULL_VIEW_MENU_OPEN_CONVERSATION}
                      onSelect={onOpenConversation}
                    >
                      <Maximize2Icon className="size-4" />
                      {intl.formatMessage({ id: "sidePane.fullView.openConversation" })}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      data-testid={TID_SIDE_PANE_FULL_VIEW_MENU_MINIMIZE}
                      onSelect={handleMinimize}
                    >
                      <MinusIcon className="size-4" />
                      {intl.formatMessage({ id: "sidePane.fullView.minimize" })}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : null}
          </div>
        ) : null}
        {isMinimized ? (
          <button
            type="button"
            data-testid={TID_SIDE_PANE_FULL_VIEW_BUBBLE}
            aria-label={intl.formatMessage({ id: "sidePane.fullView.restore" })}
            title={statusLabel}
            className="absolute inset-0 z-10 flex cursor-grab touch-none items-center justify-center rounded-full border border-border bg-background shadow-lg hover:bg-hover"
            onPointerDown={beginDrag}
            onPointerMove={moveDrag}
            onPointerUp={(event) => endDrag(event, handleRestore)}
            onPointerCancel={cancelDrag}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                handleRestore();
              }
            }}
          >
            {statusIcon}
          </button>
        ) : null}
        <div
          data-side-pane-full-view-clip=""
          className={cn(
            "relative min-h-0",
            mode === "normal" && "h-full",
            mode === "conversation" && "flex-1",
            // 输入层：收起态外壳就是输入框（带阴影），展开态内缩 1px 露出抽屉边框。
            isFloating &&
              "absolute z-10 h-[var(--side-pane-full-view-clip-height)] overflow-hidden",
            isFloating && !isExpanded && "inset-x-0 bottom-0 rounded-2xl shadow-lg",
            isExpanded && "inset-x-px bottom-px rounded-b-2xl",
            // 最小化时输入层不可见，但保持浮窗宽度排版，不随 48px 的按钮重排。
            isMinimized && "invisible w-[var(--side-pane-full-view-frame-width)]",
          )}
        >
          <div
            className={cn(
              "h-full",
              // 收起态保持展开态的固定高度并贴底：只露出底部输入区，上方内容仍然挂载。
              isFloating &&
                "absolute inset-x-0 bottom-0 h-[var(--side-pane-full-view-pane-height)]",
            )}
          >
            {children}
          </div>
        </div>
      </ConversationPanePresentationContext.Provider>
    </div>
  );
}
