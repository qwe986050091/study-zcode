// 面板外壳（Shell）：编排文档加载、查看器挂载、菜单/抽屉/查找/选择条与 Agent 标记。
// 边界：业务状态只存在本组件；查看器与下拉/浮层通过显式回调交互，子组件不持有全局状态。
// 副作用：经 rpc 打开/导入/重载文档，读写最近文件与窗口状态，并向宿主上报页面工具注册。
// 文件职责（office 面板 Shell）：把宿主 RPC、工具结果与查看器回调收敛成一套 UI 状态，
// 再渲染内联卡片 / 侧栏两种形态；本文件只做编排，文档解析、分页与高亮绘制都在 viewers/ 下。
// 边界：文档字节只经 load_document 取得；位置/页码/缩放/选择的唯一事实来源是查看器回调，
// 本组件只缓存并转发；跨进程副作用只经 call（RPC）与 host（持久化/发消息）两个出口。
// 失败路径：一切异常都收敛为 Failure 文案或静默忽略，不向 React 抛出，避免整面板白屏。
// 不在本文件：格式解析（viewers/registry）、查找状态机（useFind）、键盘映射（useShellKeys）。
//
// INV 表逐条可核对：下面每个实现点都标了它守的是哪一条 `INV-xx`。
// INV-01 断言：同一时刻至多一份已加载文档，旧加载结果不得覆盖新文档 —— 守住它的位置：load 内两处 mine !== loadSeq.current 提前返回 —— 改错故障：快速切换文档时画面串台、旧失败覆盖新成功。
// INV-02 断言：doc / pending / ready / failure 四态最多一个主导画面 —— 守住它的位置：showSkeleton 与 nothing 的互斥条件 —— 改错故障：骨架和错误层叠，或空态盖住正在加载的文档。
// INV-03 断言：宿主工具结果按到达顺序排空，且取走即清空 —— 守住它的位置：drain 与 host.takeResults —— 改错故障：同一结果被重复展示，或漏掉早于挂载产生的结果。
// INV-04 断言：未知或不含 document 的快照被忽略而非报错 —— 守住它的位置：applySnapshot 首行判空返回 —— 改错故障：别家面板的消息把当前文档清屏。
// INV-05 断言：被截断的结果改走 get_viewer 取完整快照 —— 守住它的位置：drain 内 zcode/truncated 分支 —— 改错故障：拿到半截快照导致定位错页或信息缺失。
// INV-06 断言：reveal.seq 单调递增，重复 seq 只执行一次 —— 守住它的位置：applySnapshot 中 lastRevealSeq 比较 —— 改错故障：重放或重连后同一处被反复滚动。
// INV-07 断言：查找高亮与 Agent 标记不同时显示 —— 守住它的位置：onOpenFind 与 runReveal 互相清理 —— 改错故障：两套高亮重叠，用户分不清哪个是搜索结果。
// INV-08 断言：选择必须 selection 与 detail 同时存在，否则视为取消 —— 守住它的位置：onSelect 的三元表达式 —— 改错故障：操作条对着不存在的选段报锚点。
// INV-09 断言：references 只在 updateModelContext 成功后提交 —— 守住它的位置：addReference 中 try 之后的赋值 —— 改错故障：远端失败但本地已记引用，重试内容与模型上下文不一致。
// INV-10 断言：磁盘 revision 轮询结果不得写入其他文档 —— 守住它的位置：check_document 回调里的 docRef 比对 —— 改错故障：切换文档后弹出上一个文件的“已变更”横幅。
// INV-11 断言：所有注册物在卸载时成对撤销（监听、观察器、定时器） —— 守住它的位置：各 effect 的 return 清理 —— 改错故障：StrictMode 双挂载后重复处理同一条结果。
// INV-12 断言：同路径重载不得丢掉已挂起的定位 —— 守住它的位置：load 中 loadingPath 比较 —— 改错故障：点击“重新加载”后原本要定位的位置丢失。
// INV-13 断言：切换文档只复位文档相关状态，跨文档状态保持 —— 守住它的位置：resetDocumentState 的清单 —— 改错故障：最近文件被清空，或新文档沿用旧页码。
// INV-14 断言：内联模式只上报尺寸，不改变文档与内容 —— 守住它的位置：inline 分支的 sendSizeChanged —— 改错故障：内联卡片里触发侧栏才有的抽屉与快捷键行为。
//
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import {
  kindOf,
  type DocKind,
  type DocumentInfo,
  type DocxBlockKey,
  type FileHandle,
  type Selection,
  type ShowTarget,
  type ViewerSnapshot,
} from "#office/contract.ts";
import { formatAnchor } from "#office/domain/anchor.ts";
import { PROFILE } from "#office/profile.ts";
import { wellFormed, wellFormedDeep } from "#office/domain/text.ts";
import { readFileBytes } from "#ui/assets.ts";
import { getHost } from "#ui/host.ts";
import {
  clip,
  describeFailure,
  readRecent,
  useHostContext,
  writeRecent,
  type AgentPointer,
  type Failure,
  type LoadedDoc,
  type Picked,
  type Reference,
} from "#ui/shell/state.ts";
import { describeAt, strings } from "#ui/i18n.ts";
import { Icon } from "#ui/icons.tsx";
import { baseName, call } from "#ui/rpc.ts";
import { InlineShell } from "#ui/shell/inline.tsx";
import { MoreMenu, SwitchMenu } from "#ui/shell/menus.tsx";
import {
  ChangedBanner,
  Drawer,
  EmptyState,
  useNativeFileInput,
  ErrorState,
  Skeleton,
  type DrawerTab,
} from "#ui/shell/panes.tsx";
import {
  AgentCallout,
  FindBar,
  OffscreenChip,
  PagePill,
  SelectionBar,
  offscreenText,
  type BarMode,
} from "#ui/shell/parts.tsx";
import { CLOSED_FIND, useFind } from "#ui/shell/useFind.ts";
import { useCaptureView } from "#ui/shell/useCaptureView.ts";
import { useOffscreenTargets } from "#ui/shell/useOffscreenTargets.ts";
import { useShellKeys } from "#ui/shell/useShellKeys.ts";
import { VIEWERS } from "#ui/viewers/registry.ts";
import type {
  PageState,
  RevealedTarget,
  SelectionDetail,
  ViewerHandle,
  ZoomState,
} from "#ui/viewers/types.ts";

// [契约] 模块级单例：host 在组件外解析一次，Shell 与各 hook 共享同一条宿主通道。
// 解析失败在 getHost 内部降级（见 ui/host.ts），此处不重复判空，避免调用点各自兜底。
// [权衡] 不放进 React context：host 生命周期跨重挂载，放 state 会引起引用抖动。
const host = getHost();

// 可分页/出缩略图的文档类型；xlsx 走网格视图，不进入翻页与页码控件。
// [契约] 只有这三种类型进入翻页控件；xlsx 走网格视图，页码与缩略图对它没有语义。
// 新增格式先决定是否分页，再决定是否加进此数组：paged 与 PagePill 共用同一判断。
const PAGED: DocKind[] = ["pdf", "docx", "pptx"];
/** Viewers with fit modes and zoom in the page control. */
const ZOOMABLE: DocKind[] = ["pdf", "docx"];
// 面板宽度达到此阈值即停靠抽屉，否则抽屉浮层覆盖页面；该值只影响布局，不影响文档内容。
/** Below this panel width the drawer floats over the pages; at or above it, it docks. */
// [权衡] 720px 是抽屉“停靠 vs 浮层”的唯一分界，只影响布局，不影响文档内容与状态。
// 阈值只写在常量里：ResizeObserver 与渲染分支都读它，避免两处魔法数漂移。
const DOCK_WIDTH = 720;
// 内联卡片固定高度（像素），仅用于向宿主声明尺寸。
const INLINE_HEIGHT = 380;
// 面板外壳：把宿主事件、工具结果、查看器回调汇聚成一套 UI 状态，并渲染内联或侧栏两种形态。
// 数据来源唯一：文档字节经 load_document 取得后由查看器渲染；状态由 viewer 回调上报（位置/页/缩放/选择）。
// 副作用集中在 call（RPC）、host（持久化/发消息）与事件监听；组件本身不直接做 IO。
// 失败一律落成 Failure 文案（describeFailure），不抛到 React，避免整面板白屏。
// 维护不变量：同一时刻只有一份已加载文档；loadSeq 递增保证旧加载结果被丢弃。
function Shell() {
  // [契约] 宿主上下文的唯一消费入口：locale/theme/displayMode 都是声明式输入，本组件不反推。
  // 首帧可能为空（连接未就绪），因此所有读取都带默认值，绝不在渲染前提前 return。
  // [失败路径] 宿主未声明即按默认渲染，等 office:hostchange 触发重渲染后自然对齐。
  const context = useHostContext();
  const t = strings(context?.locale ?? navigator.language);
  const dark = context?.theme === "dark";
  const inline = context?.displayMode === "inline";

  // 文档与加载态：pending 是正在加载的路径（骨架与标题据此推断类型），failure 是加载/渲染失败描述；
  // 三者互斥展示（见下方 showSkeleton 与 nothing），不会同时为真。
  // [事务] 文档态是四元组 doc/pending/ready/failure，任何时刻最多一个主导画面。
  // 写入顺序固定为“先清 failure、再置 pending、最后落 doc”，避免中间帧出现双真。
  // [并发] 三者与 loadSeq 配合：过期代次只允许清 pending，不允许碰 doc。
  const [doc, setDoc] = useState<LoadedDoc | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  // 当前展开的标题栏下拉菜单；同一时刻最多一个，null 表示关闭。
  const [menu, setMenu] = useState<"switch" | "more" | null>(null);
  // 抽屉（缩略图/大纲）状态：open 只有在 drawerAvailable 为真时才生效，tab 缺内容时自动回退。
  // [契约] open 只是“请求打开”，能否真正展示由下方 drawerAvailable 判定（有文档且 ready）。
  // tab 缺内容时交给 Drawer 自行回退，Shell 不预先纠正，避免布局判断散成两处。
  // [权衡] 用单个对象而非两个 useState：切 tab 与开关抽屉必须同帧生效，避免中间态闪烁。
  const [drawer, setDrawer] = useState<{ open: boolean; tab: DrawerTab }>({
    open: false,
    tab: "pages",
  });
  // 查看器上报的位置/分页/缩放：Shell 只缓存并转给 UI，不自行计算（唯一事实来源是查看器）。
  // [契约] 查看器上报的三元组各自独立：位置串、分页、缩放互不推导。
  // Shell 只做缓存与转发，页数换算、百分比等语义全部留在查看器内部。
  // [权衡] 不合并成 useReducer：三者更新频率不同，合并会放大无效重渲染。
  const [location, setLocation] = useState<string | null>(null);
  const [page, setPage] = useState<PageState | null>(null);
  const [zoom, setZoom] = useState<ZoomState | null>(null);
  // 用户选择与浮动操作条：picked 为 null 时操作条整体卸载；barMode 控制“操作条/提问/已加入”三态。
  // [契约] picked 为 null 即“没有选择”，操作条条件渲染而非常驻隐藏，随 null 卸载内部状态。
  // pickedRef 供异步收尾读取最新值：1.5s 定时器里不能使用闭包捕获的旧 picked。
  // [并发] ref 只用于比较、不用于驱动渲染，避免出现第二份事实来源。
  const [picked, setPicked] = useState<Picked | null>(null);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const [barMode, setBarMode] = useState<BarMode>("bar");
  const [copied, setCopied] = useState(false);
  // Agent 标注：note 可空（只看位置）、targets 至少一项、index 指向当前目标；visible 只控制气泡，标记始终保留。
  // [契约] Agent 指针：targets 非空、index 必在范围内、visible 只控制气泡不控制标记。
  // [权衡] 标记常驻而气泡可关，是为了让“引用仍在页面上”在视觉上不丢失。
  const [agent, setAgent] = useState<AgentPointer | null>(null);
  // changed 是磁盘上的新 revision（提示横幅），notice 是 2.5s 自动消失的短提示；二者语义独立。
  // [契约] changed 表示磁盘出现新 revision 需用户显式重载；notice 是 2.5s 后自动消失的短提示。
  // 两者不合并：横幅要留到用户处理，短提示必须自动消失，生命周期不同。
  const [changed, setChanged] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 最近打开列表（最多 5 条，最近在前的去重列表）；初始值直接读窗口持久化，空数组表示新窗口。
  const [recent, setRecent] = useState(readRecent);
  // 面板是否达到停靠宽度；由 ResizeObserver 更新，决定抽屉是停靠还是浮层。
  const [wide, setWide] = useState(false);

  // appRef 测面板宽度，canvasRef 给浮层（操作条/气泡/页码胶囊）提供定位与滚动参照。
  // [资源] 两个 DOM 参照各司其职：appRef 量宽度决定停靠，canvasRef 给浮层做定位与滚动参照。
  // 操作条、气泡、页码胶囊都靠 canvasRef 的矩形换算坐标，换成 appRef 会随标题栏偏移。
  // [失败路径] 首次渲染时 ref 尚为 null：带 ! 的读取只发生在已提交的 effect 内，浮层读取前均判空。
  const appRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [offscreen, setOffscreen] = useOffscreenTargets(canvasRef, agent);
  // viewer 是命令式句柄（由查看器 forwardRef 暴露）；viewerReady 标记渲染完成，未完成前定位任务先挂起。
  // pendingReveal 保存最近一次待执行定位（文档切换时随加载一起排队）；lastRevealSeq 用于丢弃重复的 reveal 指令。
  // [契约] viewer 是命令式句柄，由查看器 forwardRef 暴露；每次调用都必须判空，故遍布 ?.。
  // viewerReady 单独用 ref 记录：它不参与渲染，只决定 reveal 立即执行还是排队。
  // [并发] 重挂载瞬间句柄会短暂为 null，await 之后要重新取 handle，不能复用旧值。
  const viewer = useRef<ViewerHandle | null>(null);
  const viewerReady = useRef(false);
  const pendingReveal = useRef<{ targets: ShowTarget[]; note: string | null } | null>(null);
  const lastRevealSeq = useRef(0);
  // docRef 与 state 同步（每次渲染覆盖），供只在挂载时注册的回调（工具处理、快捷键）读取最新文档。
  // loadSeq 是加载代次：晚到的旧请求据此丢弃，避免快速切换文档时结果串台。
  // loadingPath 记录正在加载的路径：同路径二次加载不带 reveal 时不覆盖已挂起的定位。
  // loadKey 单调递增，作为 React key 让查看器在每次重新加载时重挂载，清空其内部状态。
  // [契约] docRef 每次渲染同步覆盖，供只在挂载时注册的回调（工具结果、快捷键）读到最新文档。
  // 这违反“渲染期不写 ref”的常规偏好，但它是让长生命周期监听看到新值的最低成本做法。
  // [并发] loadSeq 是加载代次，loadingPath 让同路径的二次加载不清掉已挂起的定位。
  const docRef = useRef<LoadedDoc | null>(null);
  docRef.current = doc;
  const loadSeq = useRef(0);
  /** Path being loaded; a second load of it without a reveal must not drop the pending one. */
  const loadingPath = useRef<string | null>(null);
  const loadKey = useRef(0);
  // references 是本次会话已加入模型上下文的引用（去重且最多 10 条）；
  // dismissedRevision 记住用户忽略过的文件版本，避免同一版本反复弹“文件已变更”。
  const references = useRef<Reference[]>([]);
  const dismissedRevision = useRef<string | null>(null);
  // 打开查找前清掉 Agent 标记与选择：查找高亮与它们不同时显示，避免视觉冲突与状态打架。
  // [契约] 打开查找前主动清掉 Agent 标记与选择：查找高亮与 Agent 标记不同时显示。
  // 顺序固定为“先让查看器清、再清 Shell 状态”，否则查看器可能回调一次新的选择。
  // [失败路径] clearReveal / clearSelection 对空句柄安全，未挂载时调用无副作用。
  const onOpenFind = useCallback(() => {
    viewer.current?.clearReveal();
    viewer.current?.clearSelection();
    setPicked(null);
    setAgent(null);
    setMenu(null);
  }, []);
  const { find, setFind, openFind, closeFind, queryFind, stepFind } = useFind({
    viewer,
    docRef,
    ready,
    onOpen: onOpenFind,
  });
  /**
   * The agent's current target stays in view until the user scrolls, clicks or types in the
   * document: ZCode animates the pane open, and each resize re-lays the pages out under it.
   */
  // [契约] pinned 仅在 Agent 定位成功后为真，用户滚动、按下或按键即解除（见下方 unpin）。
  // [权衡] 用 ref 而非 state：它只影响要不要滚回去，不参与渲染，用 state 会多一轮渲染。
  const pinned = useRef(false);

  // 预览用类型：优先已加载文档，其次由待加载路径推断，骨架需要知道用哪种布局。
  // 展示用路径：加载中 > 失败目标 > 已打开文档，保证标题栏始终显示用户刚操作的文件。
  // [契约] kind 优先级：已加载文档 > 待加载路径推断 > null，骨架据此选择布局。
  // path 优先级：加载中 > 失败目标 > 已打开，保证标题栏始终显示用户刚操作的文件。
  // [权衡] 两者优先级不同是刻意的：类型要稳定，路径要跟随用户意图。
  const kind = doc?.info.kind ?? (pending ? kindOf(pending) : null);
  const path = pending ?? failure?.path ?? doc?.info.path ?? null;

  // 主题与宿主设计变量：宿主未声明 dark 时按 light 处理；variables 缺失则沿用本地样式表。
  useEffect(() => {
    // [契约] 主题只写 documentElement 的 data-theme，颜色判断全部交给样式表，不在组件内散落。
    // [资源] 本 effect 只写不订阅，卸载无需回滚：面板销毁时 DOM 一并销毁。
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    const variables = context?.styles?.variables;
    if (variables) applyHostStyleVariables(variables);
  }, [dark, context?.styles?.variables]);

  // 内联卡片高度固定，需显式告知宿主；失败不影响预览，只是尺寸可能不理想。
  useEffect(() => {
    // An inline card is a fixed-height glance; the side panel fills the pane.
    if (inline) void host.app.sendSizeChanged({ height: INLINE_HEIGHT }).catch(() => undefined);
  }, [inline]);

  // 只观测宽度：跨过 DOCK_WIDTH 才切换停靠/浮层，避免 1px 抖动导致布局反复重排。
  useEffect(() => {
    // [资源] 观察器与组件同生命周期：effect 内注册，cleanup 中 disconnect，不跨挂载泄漏。
    // 回调只做布尔比较，setWide 收到同值不会触发重渲染，因此无需额外去抖。
    // [权衡] 只观察宽度：高度由文档流决定，跟着变会让抽屉反复重排。
    const app = appRef.current!;
    const resize = new ResizeObserver(() => setWide(app.clientWidth >= DOCK_WIDTH));
    resize.observe(app);
    return () => resize.disconnect();
  }, []);

  // 短提示：2.5s 后自动清除；用值比较而不是直接置 null，避免新提示被旧定时器提前清掉。
  const showNotice = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((current) => (current === text ? null : current)), 2500);
  }, []);

  // 清空所有“依赖具体文档”的视图状态：切换/卸载文档时必须整体复位，
  // 否则旧页数、旧选择、旧定位会短暂套用到新文档上。
  // 不重置 recent、宽窄布局与菜单等跨文档状态。
  // [事务] 这是“换文档”的复位事务：文档相关状态必须整体归零，不能漏项。
  // 刻意保留 recent / wide / menu / drawer：它们属于面板，不属于某一份文档。
  // [失败路径] 漏项的典型症状是新文档首帧短暂显示旧页码或旧选择。
  const resetDocumentState = useCallback(() => {
    viewerReady.current = false;
    setReady(false);
    setPicked(null);
    setBarMode("bar");
    setAgent(null);
    setOffscreen(null);
    setLocation(null);
    setPage(null);
    setZoom(null);
    setChanged(null);
    setFind(CLOSED_FIND);
  }, []);

  // 加载文档的唯一入口：先调 load_document 拿 info/file/blocks，再并行读取字节与查看器预热，
  // 任一失败都转成 Failure（不抛），并丢弃过期代次的结果。
  // reveal 参数用于“打开并定位”，会在查看器 ready 后执行；不传则清空待执行定位（除非是同一路径）。
  const load = useCallback(
    async (target: string, reveal?: { targets: ShowTarget[]; note: string | null } | null) => {
      // 抢占代次：后发加载覆盖先发，旧响应在下面的两处代次检查处直接丢弃。
      // [并发] `loadSeq` 代次：后发加载立即让先发失效，旧响应在两处 `mine !== loadSeq.current` 处丢弃。
      // 递增必须发生在任何 await 之前，否则两个并发加载会拿到同一代次。
      // [权衡] 用序号而非 AbortController：RPC 不支持取消，只能靠丢弃结果保证一致。
      const mine = ++loadSeq.current;
      // 带定位的加载先挂起；同路径的二次加载（如 reload）保留已挂起的定位，避免用户操作丢失。
      if (reveal) pendingReveal.current = reveal;
      else if (loadingPath.current !== target) pendingReveal.current = null;
      loadingPath.current = target;
      setPending(target);
      setFailure(null);
      try {
        const loaded = await call<{
          info: DocumentInfo;
          file: FileHandle;
          blocks?: DocxBlockKey[];
        }>("load_document", { path: target });
        // [资源] 字节读取与查看器预热并行：两者互不依赖，串行会让大文件首屏多等一倍。
        // prepare 失败随 Promise.all 一起 reject，落入下方统一失败分支，不会被静默吞掉。
        // [契约] 只取 bytes：prepare 的返回值无意义，查看器通过 props 拿到字节自行解析。
        const [bytes] = await Promise.all([
          readFileBytes(loaded.file),
          VIEWERS[loaded.info.kind]?.prepare?.(),
        ]);
        // 字节读取期间可能已有更新的加载请求，此时本次结果作废，不能覆盖更新的文档。
        if (mine !== loadSeq.current) return;
        resetDocumentState();
        dismissedRevision.current = null;
        setDoc({ info: loaded.info, bytes, blocks: loaded.blocks, key: ++loadKey.current });
        // 记录当前文档供下次挂载恢复；持久化失败由 host 内部吞掉，不影响本次展示。
        host.saveDocument(loaded.info.path);
        // 最近列表去重后置顶并截到 5 条；内存与窗口持久化同时更新，保证两处一致。
        setRecent((items) => {
          const next = [
            { path: loaded.info.path, kind: loaded.info.kind },
            ...items.filter((item) => item.path !== loaded.info.path),
          ].slice(0, 5);
          writeRecent(next);
          return next;
        });
      } catch (error) {
        // 过期请求的失败同样丢弃，避免旧失败覆盖新文档的成功状态。
        if (mine !== loadSeq.current) return;
        setDoc(null);
        resetDocumentState();
        setFailure(describeFailure(t, error, target));
      } finally {
        if (mine === loadSeq.current) {
          setPending(null);
          loadingPath.current = null;
        }
      }
    },
    [resetDocumentState, t],
  );

  // 执行 Agent 定位：先清掉查找高亮（二者不共存），再让查看器逐目标 reveal。
  // 全部目标都找不到时清空 agent（results 为空），避免留下空的调用气泡；
  // 成功后默认钉住第一处，直到用户滚动/点击/输入才解除（见下方 ResizeObserver 附近的 unpin）。
  const runReveal = useCallback(async (targets: ShowTarget[], note: string | null) => {
    // [契约] 定位前先取句柄：为空说明查看器尚未挂载，本次定位放弃，由 pendingReveal 兜底。
    // [失败路径] reveal 的 rejection 被转成空数组，等价于“没找到”，不冒泡成面板错误。
    const handle = viewer.current;
    if (!handle) return;
    // The agent's marks and find highlights are never shown together.
    handle.clearFind();
    setFind(CLOSED_FIND);
    const results = await handle.reveal(targets).catch(() => [] as RevealedTarget[]);
    pinned.current = results.length > 0;
    setAgent(
      results.length
        ? { note, targets: results, index: 0, visible: Boolean(note) || results.length > 1 }
        : null,
    );
  }, []);

  // 查看器就绪就直接定位，否则排队等 onReady；这样“打开文档 + 定位”时序无关。
  // [事务] 就绪则立即执行，未就绪则排队，使“先打开后定位”与“先定位后打开”语义一致。
  // pendingReveal 只保留最后一次：用户连续点击多个结果时以最后一次意图为准。
  // [权衡] 不在此处去重：去重职责在 applySnapshot 的 seq 比较，放这里会漏掉重载场景。
  const applyReveal = useCallback(
    (targets: ShowTarget[], note: string | null) => {
      if (viewer.current && viewerReady.current) void runReveal(targets, note);
      else pendingReveal.current = { targets, note };
    },
    [runReveal],
  );

  // 按 snapshot 对齐面板：路径或 revision 变化就要重新加载（内容可能已变），
  // 同一文档只需处理新的 reveal（seq 单调递增，重复的 seq 忽略）。
  // snapshot.document 缺失时视为无关结果，什么都不做（保持当前画面）。
  /** Bring the viewer in line with a snapshot from the server (tool result or get_viewer). */
  const applySnapshot = useCallback(
    (snapshot: ViewerSnapshot | undefined) => {
      // [契约] 快照来源可能是工具结果，也可能是 get_viewer，缺 document 即视为与本面板无关。
      // [失败路径] 这里静默返回而不是报错：未知消息、其他面板的结果都会走到这条分支。
      // 保持当前画面比清空更安全，错误清屏会让用户丢掉正在阅读的位置。
      if (!snapshot?.document) return;
      const reveal =
        snapshot.reveal && snapshot.reveal.seq > lastRevealSeq.current ? snapshot.reveal : null;
      if (reveal) lastRevealSeq.current = reveal.seq;
      const current = docRef.current?.info;
      const pointer = reveal ? { targets: reveal.targets, note: reveal.note ?? null } : null;
      if (
        !current ||
        current.path !== snapshot.document.path ||
        current.revision !== snapshot.document.revision
      ) {
        void load(snapshot.document.path, pointer);
      } else if (pointer) applyReveal(pointer.targets, pointer.note);
    },
    [load, applyReveal],
  );

  // 消费宿主下发的工具结果：结果可能早于 UI 挂载，host 已缓冲，这里按序排空。
  // 带 zcode/truncated 标记的结果 payload 被截断，改调 get_viewer 取完整快照；isError 结果直接跳过。
  // 连接成功后再做一次恢复：本窗口记录的文档优先于历史工具结果，新窗口则回放未消费结果。
  // Tool results routed to this panel (open_document, show_in_viewer).
  useEffect(() => {
    // [契约] 逐条按序排空宿主缓冲：结果可能早于 UI 挂载产生，顺序即用户操作顺序。
    // isError 结果直接跳过：失败的工具调用不代表“要展示的文档”，展示会误导用户。
    // [失败路径] 单条结构异常由 applySnapshot 的 document 判空兜住，不中断后续排空。
    const drain = () => {
      for (const result of host.takeResults()) {
        if (result.isError) continue;
        const truncated = (result._meta as Record<string, unknown> | undefined)?.[
          "zcode/truncated"
        ];
        if (truncated) void call<ViewerSnapshot>("get_viewer").then(applySnapshot, () => undefined);
        else applySnapshot(result.structuredContent as ViewerSnapshot | undefined);
      }
    };
    // [资源] 注册与反注册严格成对：effect 返回 removeEventListener，依赖变化时先解绑再重绑。
    // 同一事件可能被宿主重放并叠加实时推送，排空语义是取走即清空，因此天然幂等。
    // [契约] 事件名由宿主桥固定，改名必须同步 ui/host.ts，否则会静默收不到结果。
    window.addEventListener("office:toolresult", drain);
    void host.ready().then(async () => {
      setRecent(readRecent());
      const buffered = host.takeResults();
      const path = host.readDocument();
      // 恢复本窗口的手动选择优先于历史工具结果；新窗口没有记录，保持空状态。
      if (path) void load(path);
      else for (const result of buffered)
        if (!result.isError) applySnapshot(result.structuredContent as ViewerSnapshot | undefined);
    });
    return () => window.removeEventListener("office:toolresult", drain);
  }, [applySnapshot, load]);

  // 上报当前位置（400ms 防抖），让 get_view 能回答“用户现在看的是什么”；
  // 失败只影响远端观测，不影响本地交互，故静默忽略。
  // Tell the server where the user is (debounced) so get_view answers "what am I looking at".
  const selection = picked?.selection ?? null;
  useEffect(() => {
    if (!doc) return;
    const timer = setTimeout(() => {
      void call("report_view", { viewId: host.viewId, path: doc.info.path, at: location, selection }).catch(
        () => undefined,
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [doc, location, selection]);

  // 每 4s 轮询磁盘 revision：页面不可见时跳过以省资源；用户已忽略的版本不再提示；
  // 文档已切换（docRef 与闭包 doc 不一致）则不把结果写到新文档上。
  // Notice when the file changes on disk under the panel.
  useEffect(() => {
    // [资源] 轮询只在侧栏且已加载文档时存在；cleanup 清掉 interval，切换文档不会叠加定时器。
    // `document.visibilityState !== "visible"` 时跳过本次请求：只省资源，不改变轮询节奏。
    // [并发] 结果回来先比对 docRef 与闭包 doc：文档已换则丢弃，避免旧 revision 写到新文档。
    if (!doc || inline) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void call<{ revision: string }>("check_document", { path: doc.info.path }).then(
        ({ revision }) => {
          if (docRef.current !== doc) return;
          if (revision !== doc.info.revision && revision !== dismissedRevision.current)
            setChanged(revision);
        },
        () => undefined,
      );
    }, 4000);
    return () => clearInterval(timer);
  }, [doc, inline]);

  // 注册 capture_view 页面工具；只能注册一次，内部通过 ref 读取最新文档与查看器。
  useCaptureView(docRef, viewer);

  // 查看器就绪：清理待执行定位并延后 50ms 执行，等布局/渲染稳定后再滚动，避免定位偏一页。
  // [事务] 就绪是一次性事件：先置位再取走 pendingReveal，保证同一定位不会被执行两次。
  // 延后 50ms 是为等布局稳定（侧栏有打开动画），太早滚动会偏一页。
  // [资源] 该定时器无需清理：卸载时查看器已不存在，runReveal 会因句柄为空安全返回。
  const onReady = useCallback(() => {
    viewerReady.current = true;
    setReady(true);
    const reveal = pendingReveal.current;
    pendingReveal.current = null;
    if (reveal?.targets.length) setTimeout(() => void runReveal(reveal.targets, reveal.note), 50);
  }, [runReveal]);

  // 选择回调：只认同时带 selection 与 detail 的结果（查看器两者缺一即视为取消）；
  // 新的用户选择会收起 Agent 气泡但保留其标记，防止两套高亮互相遮挡。
  // [契约] 只有 selection 与 detail 同时存在才算真实选择，任一缺失都视为取消。
  // 新选择收起 Agent 气泡但保留标记：两套高亮不能同时抢注意力。
  // [权衡] barMode 每次选择都复位为 bar：宁可让用户重选操作，也不保留上一段的“已加入”态。
  const onSelect = useCallback((next: Selection | null, detail?: SelectionDetail) => {
    setBarMode("bar");
    setCopied(false);
    setPicked(next && detail ? { selection: next, detail } : null);
    // Acting on the page dismisses the agent's note (its marks stay).
    if (next && detail?.user) setAgent((current) => current && { ...current, visible: false });
  }, []);

  // “钉住”当前 Agent 目标：面板尺寸变化会重排版页面（ZCode 打开侧栏有动画），
  // 只有 pinned 为真时才在 200ms 去抖后把目标滚回视野；用户一滚动/按下/敲键即解除钉住。
  // [资源] 观察器、计时器与三个监听器在同一 effect 内成对注册与清理，依赖是 doc。
  // 换文档即重建：canvas 未变，但 pin/unpin 的语义必须从新文档重新开始。
  // [并发] unpin 用捕获阶段监听，确保不被查看器内部的 stopPropagation 吞掉。
  const agentRef = useRef(agent);
  agentRef.current = agent;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let timer = 0;
    const resize = new ResizeObserver(() => {
      if (!pinned.current) return;
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        const current = agentRef.current;
        if (pinned.current && current) current.targets[current.index]?.scrollTo();
      }, 200);
    });
    resize.observe(canvas);
    const unpin = () => {
      pinned.current = false;
    };
    canvas.addEventListener("wheel", unpin, { passive: true });
    canvas.addEventListener("pointerdown", unpin, true);
    canvas.addEventListener("keydown", unpin, true);
    return () => {
      clearTimeout(timer);
      resize.disconnect();
      canvas.removeEventListener("wheel", unpin);
      canvas.removeEventListener("pointerdown", unpin, true);
      canvas.removeEventListener("keydown", unpin, true);
    };
  }, [doc]);
  // 点击 Agent 标记：仅当该目标存在且有可展示内容（有 note 或多目标）时接管点击并恢复气泡，
  // 返回 false 表示让查看器继续走普通选择逻辑。
  // Clicking one of the agent's marks brings its note back, when there is one to show.
  const onRevealHit = useCallback((index: number) => {
    const current = agentRef.current;
    if (!current?.targets[index] || !(current.note || current.targets.length > 1)) return false;
    setAgent({ ...current, index, visible: true });
    return true;
  }, []);

  // 清除选择：同时通知查看器取消 DOM 高亮，并把操作条复位到默认态。
  const clearSelection = useCallback(() => {
    viewer.current?.clearSelection();
    setPicked(null);
    setBarMode("bar");
  }, []);

  // 把当前选择加入模型上下文：锚点+文本组成引用，按（锚点,文本）去重并只保留最近 10 条。
  // 成功后 1.5s 显示“已加入”再清除选择；若期间用户已换了选择则不清，避免误清。
  // 发送失败只提示，不改动本地 references（保证重试时内容一致）。
  // [事务] 引用写入是“先远端、后本地”：updateModelContext 成功才提交 references.current。
  // 这样发送失败时界面列表与模型上下文仍一致，重试内容不变。
  // [契约] 去重键是（锚点, 文本）而非锚点：同一位置的不同选段是两条独立引用。
  // [资源] 上限 10 条用 slice(-10) 实现，保留最近；被淘汰的旧引用静默丢弃，不回写提示。
  const addReference = useCallback(async () => {
    const current = docRef.current;
    if (!current || !picked) return;
    const anchor = formatAnchor(current.info.path, picked.selection.at);
    const text = picked.selection.text;
    const next = [
      ...references.current.filter((item) => item.anchor !== anchor || item.text !== text),
      { anchor, text },
    ].slice(-10);
    const lines = next.map(
      (item) => `- ${item.anchor}${item.text ? `: "${clip(item.text, 600)}"` : ""}`,
    );
    try {
      await host.ready();
      await host.app.updateModelContext({
        content: [
          {
            type: "text",
            text: wellFormed(
              `The user referenced these locations in the ${PROFILE.title.en} viewer (use read_document / show_in_viewer with the anchors):\n${lines.join("\n")}`,
            ),
          },
        ],
        structuredContent: wellFormedDeep({ references: next }),
      });
      references.current = next;
      setBarMode("added");
      const added = picked;
      setTimeout(() => {
        if (pickedRef.current === added) clearSelection();
      }, 1500);
    } catch {
      showNotice(t.contextFailed);
    }
  }, [picked, clearSelection, showNotice, t]);

  // “就此处提问”：把问题连同锚点与引用文本发给模型，成功返回 true 并清除选择。
  // 请求失败返回 false（保留输入内容，用户可重试）；isError 也按失败处理。
  // [失败路径] 失败返回 false 而不抛：操作条据此保持提问态，已输入的草稿留在子组件中。
  // result.isError 同样走失败分支：传输成功不代表业务成功，两者都必须处理。
  // [契约] 成功后清选择：问题已发出，继续保留高亮会让用户以为还没发送。
  const ask = useCallback(
    async (question: string) => {
      const current = docRef.current;
      if (!current || !picked) return false;
      const anchor = formatAnchor(current.info.path, picked.selection.at);
      const text = picked.selection.text;
      const quote = text ? `\n> ${clip(text, 800).replace(/\n/g, "\n> ")}` : "";
      try {
        const result = await host.app.sendMessage({
          role: "user",
          content: [
            {
              type: "text",
              text: wellFormed(
                `${question}\n\n(About ${anchor} in the ${PROFILE.title.en} viewer${quote ? ":" : "."})${quote}`,
              ),
            },
          ],
        });
        if (result.isError) throw new Error();
        clearSelection();
        return true;
      } catch {
        showNotice(t.sendFailed);
        return false;
      }
    },
    [picked, clearSelection, showNotice, t],
  );

  // 复制选中文本：异步剪贴板可能被沙箱拒绝，降级到 execCommand；无论哪种方式都显示 1.2s 的“已复制”。
  // [失败路径] 异步剪贴板可能被沙箱拒绝，降级到 execCommand；两条路径都不向用户报错。
  // [权衡] 降级也可能失败，但仍显示“已复制”：此时文本仍在选区里，用户可手工复制。
  const copy = useCallback(async () => {
    const text = picked?.selection.text;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // The sandbox may deny the async clipboard; the live selection still copies.
      document.execCommand("copy");
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [picked]);

  // 翻页统一走查看器句柄；不支持翻页的查看器（无 goToPage）时静默无效。
  const goToPage = useCallback((n: number) => viewer.current?.goToPage?.(n), []);

  // 切换 Agent 目标：显式 index 优先，否则循环到下一个；切换后重新钉住并展示气泡。
  // 在 setAgent 内部读取 targets，保证总是基于最新列表取目标。
  const stepAgent = useCallback((index?: number) => {
    setAgent((current) => {
      if (!current) return current;
      const next = index ?? (current.index + 1) % current.targets.length;
      current.targets[next]?.scrollTo();
      pinned.current = true;
      return { ...current, index: next, visible: true };
    });
  }, []);

  // 除气泡/胶囊等浮层外，按下页面即收起 Agent 气泡；用捕获阶段确保不被查看器内部事件吞掉。
  // Pressing on the page (outside the callout) dismisses the agent's note.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onDown = (event: PointerEvent) => {
      if ((event.target as Element).closest(".callout, .chip, .pop, .pill")) return;
      setAgent((current) => (current?.visible ? { ...current, visible: false } : current));
    };
    canvas.addEventListener("pointerdown", onDown, true);
    return () => canvas.removeEventListener("pointerdown", onDown, true);
  }, [doc]);

  // 布局判定：内联模式下即使够宽也不停靠（卡片太矮）；drawerAvailable 需要文档已渲染且存在缩略图或大纲。
  const docked = wide && !inline;
  const paged = Boolean(kind && PAGED.includes(kind));
  const drawerAvailable =
    Boolean(doc && ready && kind !== "xlsx") &&
    Boolean(viewer.current?.thumbnail || doc?.info.outline.length);

  // 全局面板快捷键：⌘F、⌘Enter、缩放与翻页、Esc 逐层关闭；依赖项变化时重挂监听。
  useShellKeys({
    docRef,
    viewer,
    picked,
    addReference,
    openFind,
    closeFind,
    clearSelection,
    paged,
    page,
    goToPage,
    drawer,
    setDrawer,
    docked,
    find,
    agent,
    setAgent,
  });

  // 用户主动切换文档：先走服务端 open_document（可能带新的定位信息），失败则关闭当前文档并显示原因；
  // 无论成功失败都递增 loadSeq，让仍在途的旧加载全部作废。
  // [事务] 用户主动换文档走服务端 open_document，成功路径完全交给 applySnapshot 决定是否重载。
  // 失败才由本地兜底：先递增代次让在途加载作废，再清空文档并给出原因。
  // [契约] 先关菜单再发请求：菜单是瞬时 UI，不应等待网络结果。
  const openPath = useCallback(
    (target: string) => {
      setMenu(null);
      void call<ViewerSnapshot>("open_document", { path: target }).then(applySnapshot, (error) => {
        // The user asked for another file: close this one and say why that one did not open.
        loadSeq.current++;
        setDoc(null);
        resetDocumentState();
        setFailure(describeFailure(t, error, target));
      });
    },
    [applySnapshot, resetDocumentState, t],
  );

  // 文件选择器：取消不改变现状，导入失败（超限/格式/IO）一律转成 Failure 文案。
  const filePicker = useNativeFileInput(t, openPath, (error, name) =>
    setFailure(describeFailure(t, error, name)),
  );
  // 查看器注册表按 kind 查表；未知类型（未来新增格式）为 null，此时只显示骨架/错误而不崩。
  // [契约] 注册表按 kind 查表，未注册类型得到 null，此时只显示骨架或错误，不抛异常。
  // [失败路径] 这是“未知格式”的唯一收口：新增格式忘记注册时表现为空画面，而非崩溃。
  // [权衡] 用查表而非 switch：格式由 viewers/registry 统一登记，Shell 不感知具体实现。
  const Viewer = doc ? (VIEWERS[doc.info.kind]?.view ?? null) : null;
  const viewerProps = useMemo(
    () =>
      doc
        ? {
            bytes: doc.bytes,
            info: doc.info,
            blocks: doc.blocks,
            dark,
            glance: inline,
            onLocation: setLocation,
            onSelect,
            onRevealHit,
            onPage: setPage,
            onZoom: setZoom,
            onLink: (url: string) => void host.app.openLink({ url }).catch(() => undefined),
            onReady,
            onError: (error: Error) =>
              setFailure(describeFailure(t, error, docRef.current?.info.path ?? null)),
          }
        : null,
    // `t` only words errors; a locale change does not need a new viewer.
    [doc, dark, inline, onReady, onSelect, onRevealHit],
  );

  // 三种互斥画面：加载中骨架（有 pending 或文档未 ready）、空态（无文档无加载无错误）、失败。
  // label 只用于选择操作条的定位说明，无选择时为空串（不渲染）。
  const showSkeleton = !failure && (Boolean(pending) || Boolean(doc && !ready));
  const nothing = !doc && !pending && !failure;
  const label = picked ? describeAt(picked.selection.at, t) : "";

  if (inline)
    return (
      <InlineShell
        appRef={appRef}
        canvasRef={canvasRef}
        t={t}
        path={path}
        info={doc?.info}
        kind={kind}
        showSkeleton={showSkeleton}
        failure={failure}
        nothing={nothing}
        onExpand={() =>
          void host.app.requestDisplayMode({ mode: "fullscreen" }).catch(() => undefined)
        }
      >
        {Viewer && viewerProps ? <Viewer key={doc!.key} ref={viewer} {...viewerProps} /> : null}
      </InlineShell>
    );

  return (
    <div ref={appRef} className="app">
      {nothing ? null : find.open ? (
        <FindBar
          t={t}
          query={find.query}
          total={find.total}
          index={find.index}
          onQuery={queryFind}
          onStep={stepFind}
          onClose={closeFind}
        />
      ) : (
        <header className="docbar">
          {doc || pending || failure ? (
            <button
              type="button"
              className={`btn icon ${drawer.open && drawerAvailable ? "secondary" : "dim"}`}
              title={t.pagesAndOutline}
              aria-label={t.pagesAndOutline}
              aria-pressed={drawer.open && drawerAvailable}
              disabled={!drawerAvailable}
              hidden={kind === "xlsx"}
              onClick={() => setDrawer((state) => ({ ...state, open: !state.open }))}
            >
              <Icon name="panel-left" />
            </button>
          ) : null}
          <button
            type="button"
            className={`doctitle${menu === "switch" ? " open" : ""}`}
            title={path ?? undefined}
            aria-haspopup="menu"
            aria-expanded={menu === "switch"}
            aria-label={`${t.switchDocument}: ${path ?? ""}`}
            data-menu-trigger=""
            onClick={() => setMenu((value) => (value === "switch" ? null : "switch"))}
          >
            <span className="name">{path ? baseName(path) : t.title}</span>
            <Icon name="chevron-down" size={12} className="chev" />
          </button>
          <span className="spacer" />
          {doc && !failure ? (
            <>
              <button
                type="button"
                className="btn icon dim"
                title={`${t.find} (⌘F)`}
                aria-label={t.find}
                disabled={!ready}
                onClick={openFind}
              >
                <Icon name="search" />
              </button>
              <button
                type="button"
                className={`btn icon dim${menu === "more" ? " active" : ""}`}
                title={t.more}
                aria-label={t.more}
                aria-haspopup="menu"
                aria-expanded={menu === "more"}
                data-menu-trigger=""
                onClick={() => setMenu((value) => (value === "more" ? null : "more"))}
              >
                <Icon name="ellipsis" />
              </button>
            </>
          ) : null}
        </header>
      )}
      {changed ? (
        <ChangedBanner
          t={t}
          onReload={() => doc && void load(doc.info.path)}
          onDismiss={() => {
            dismissedRevision.current = changed;
            setChanged(null);
          }}
        />
      ) : null}
      {nothing ? (
        <EmptyState t={t} importing={filePicker.importing} onBrowse={filePicker.browse} />
      ) : (
        <div className="stage">
          {drawer.open && drawerAvailable && doc ? (
            <>
              {docked ? null : (
                <div
                  className="scrim"
                  onClick={() => setDrawer((state) => ({ ...state, open: false }))}
                />
              )}
              <Drawer
                t={t}
                info={doc.info}
                handle={viewer.current}
                page={paged ? page : null}
                tab={drawer.tab}
                docked={docked}
                onTab={(tab) => setDrawer((state) => ({ ...state, tab }))}
                onPage={(n) => {
                  goToPage(n);
                  if (!docked) setDrawer((state) => ({ ...state, open: false }));
                }}
                onOutline={(at) => {
                  viewer.current?.goTo(at);
                  if (!docked) setDrawer((state) => ({ ...state, open: false }));
                }}
              />
            </>
          ) : null}
          <div ref={canvasRef} className="canvas">
            {Viewer && viewerProps ? <Viewer key={doc!.key} ref={viewer} {...viewerProps} /> : null}
            {showSkeleton ? <Skeleton kind={kind} /> : null}
            {failure ? (
              <ErrorState
                t={t}
                title={failure.title}
                detail={failure.detail}
                onOpenAnother={filePicker.browse}
              />
            ) : null}
            {doc && ready && !failure && picked?.detail.user ? (
              <SelectionBar
                key={`${picked.selection.at}:${picked.selection.text.length}`}
                t={t}
                frame={canvasRef}
                locate={picked.detail.locate}
                text={picked.detail.text}
                label={label}
                quote={clip(picked.selection.text.replace(/\s+/g, " "), 60)}
                short={doc.info.kind === "xlsx"}
                mode={barMode}
                canAsk={Boolean(host.capabilities?.message)}
                copied={copied}
                onAdd={() => void addReference()}
                onAsk={() => setBarMode("ask")}
                onCopy={() => void copy()}
                onCancelAsk={() => setBarMode("bar")}
                onSend={ask}
              />
            ) : null}
            {agent?.visible && agent.targets[agent.index] && !failure ? (
              <AgentCallout
                t={t}
                frame={canvasRef}
                locate={agent.targets[agent.index].locate}
                note={agent.note}
                index={agent.index}
                total={agent.targets.length}
                onNext={() => stepAgent()}
                onClose={() => setAgent({ ...agent, visible: false })}
              />
            ) : null}
            {agent && offscreen ? (
              <OffscreenChip
                text={offscreenText(
                  t,
                  offscreen.indexes.map((i) => agent.targets[i].at),
                )}
                down={offscreen.down}
                raised={paged}
                onClick={() => stepAgent(offscreen.indexes[0])}
              />
            ) : null}
            {doc && ready && !failure && paged && page ? (
              <PagePill
                t={t}
                frame={canvasRef}
                page={page}
                zoom={kind && ZOOMABLE.includes(kind) ? zoom : null}
                onPage={goToPage}
                onZoom={(direction) => viewer.current?.zoom(direction)}
                onFit={() => viewer.current?.fit("width")}
              />
            ) : null}
            {notice ? <div className="chip notice">{notice}</div> : null}
          </div>
        </div>
      )}
      {menu === "switch" ? (
        <SwitchMenu
          t={t}
          recent={recent}
          currentPath={doc?.info.path}
          onOpen={openPath}
          onBrowse={() => {
            setMenu(null);
            filePicker.browse();
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {menu === "more" && doc ? (
        <MoreMenu
          t={t}
          zoomable={ZOOMABLE.includes(doc.info.kind)}
          zoomMode={zoom?.mode}
          onFit={(mode) => {
            viewer.current?.fit(mode);
            setMenu(null);
          }}
          onFind={openFind}
          onReload={() => {
            setMenu(null);
            void load(doc.info.path);
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {filePicker.input}
    </div>
  );
}

// 挂载入口：先清空容器（加载器可能已放入占位），再以 StrictMode 渲染；
// host.ready() 幂等触发连接，不等待结果，UI 通过 office:hostchange 事件获知连接完成。
const root = document.getElementById("root")!;
root.textContent = "";
createRoot(root).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
void host.ready();
