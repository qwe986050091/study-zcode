// 会话分享浮层的「部分对话」选择面板：渲染可勾选的会话轮次清单，承载全选、定位跳转、滚动指示与确认/取消。
// 职责边界：纯受控视图。选择事实来自 selectedRowIds，校验结论来自 preflight；本组件不请求、不缓存、不计算分享范围。
// 不负责：候选轮次的生成与过滤规则、超限文案的措辞、提交动作本身——这些改动应落在父级容器与 i18n 词条里。
//
// INV-01 断言：可勾选集合必须排除 isRunning 的轮次 —— 守住它的位置：selectableItems 过滤与三处 disabled —— 改错故障：运行中轮次被勾选提交，分享内容与用户所见不一致。
// INV-02 断言：勾选状态只能由 selectedRowIds 派生，组件内不得保存副本 —— 守住它的位置：selected 与 selectedItemCount 的推导 —— 改错故障：父级清空选择后仍显示旧勾选，确认后提交空集。
// INV-03 断言：全选三态必须由可勾选集合推导而非 items 总数 —— 守住它的位置：allSelected 与 indeterminate 表达式 —— 改错故障：存在运行中轮次时永远无法显示全选，用户反复点击均无效。
// INV-04 断言：全选切换必须对当前全选态取反且只遍历可勾选项 —— 守住它的位置：onCheckedChange 的两个分支 —— 改错故障：缺省回调路径漏勾部分行或反向多勾，面板与已选计数互相矛盾。
// INV-05 断言：存在 rows_limit 阻塞项时确认按钮必须禁用 —— 守住它的位置：rowLimit 派生与确认按钮 disabled —— 改错故障：超限仍可提交，服务端拒绝而面板已关闭，用户选择全部丢失。
// INV-06 断言：checking 期间确认按钮必须禁用，且仅在已选大于 0 时才算检查中 —— 守住它的位置：checking 表达式与底部按钮 —— 改错故障：校验未就绪即提交，拿到过期结论或重复触发校验。
// INV-07 断言：selectedCount 允许父级覆盖，缺省才回落到集合大小 —— 守住它的位置：参数解构默认值 —— 改错故障：父级传入筛选后的计数被覆盖，汇总文案与实际提交数量对不上。
// INV-08 断言：面板高度必须为 auto 加 max-height，不能写死像素 —— 守住它的位置：PANEL_LAYOUT_STYLE —— 改错故障：候选很少时留下大块空白，底部 dock 增高时面板压住输入区。
// INV-09 断言：窄屏下选择器必须移到设置面板下方并收缩可用高度 —— 守住它的位置：syncNaturalHeight 的 640 分支 —— 改错故障：两个面板重叠，确认区被裁掉无法点击。
// INV-10 断言：量测高度必须用内容层 scrollHeight 而非面板可视高度 —— 守住它的位置：naturalHeight 计算 —— 改错故障：外层被截断后量到视口高度，面板越缩越矮直至塌陷。
// INV-11 断言：确认区 98px 补偿仅在同时存在确认与取消回调时叠加 —— 守住它的位置：naturalHeight 的加数 —— 改错故障：无底部栏场景多出空白，或底部栏被挤出量测导致按钮被裁。
// INV-12 断言：滚动、尺寸观察与动画帧句柄必须在 cleanup 中全部释放 —— 守住它的位置：两个副作用的 return 分支 —— 改错故障：面板隐藏后监听仍在跑，持续写入样式并造成滚动卡顿。
// INV-13 断言：同一时刻最多保留一个待执行帧，重排前必须取消旧句柄 —— 守住它的位置：scheduleVisualThumbUpdate —— 改错故障：滚动时排队几十帧，视觉滑块抖动且明显滞后。
// INV-14 断言：视觉滑块的高度与位移必须由完整滚动进度映射得出 —— 守住它的位置：滚动指标解析调用处 —— 改错故障：滚到底后滑块停在轨道中段，用户误判还有未读内容。
// INV-15 断言：上下渐隐遮罩只能作用于内容视口 —— 守住它的位置：updateVisualThumb 的遮罩赋值 —— 改错故障：独立滚动条与底部按钮一起淡出，hover 时控件闪烁。
// INV-16 断言：行点击与复选框点击合计只能派发一次切换 —— 守住它的位置：行点击与复选框外层阻断冒泡 —— 改错故障：冒泡双触发把勾选又取消，点击看起来毫无反应。
//
// [契约] 布局常量与滚动指标由兄弟模块提供，本文件不得内联第二份数值，否则面板与滚动条会各自漂移。
// [权衡] 点击热区、渐变遮罩与独立滑块都是为解决真实反馈问题引入的，回退前先确认原症状不再复现。
// 视觉验收：桌面与手机 Web、深色与浅色主题下都要检查文本截断、hover 显现与滚到底时的滑块位置。
import { memo, useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { LocateFixed } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveConversationShareSelectionPanelMotion } from "@/v4/conversationShareModeMotion.js";
import {
  CONVERSATION_SHARE_SELECTION_PANEL_CENTER_Y_PROPERTY,
  CONVERSATION_SHARE_SELECTION_PANEL_MAX_HEIGHT_PROPERTY,
} from "@/v4/conversationShareSelectionPanelLayout.js";
import { resolveConversationShareScrollbarIndicatorMetrics } from "@/v4/conversationShareScrollbarMetrics.js";
import type { ConversationSharePreflightState } from "@/conversation-share-interaction/ConversationSharePreflightStatus.js";
import type { ConversationTurnNavigatorItem } from "@/v4/conversationTurnNavigatorHelpers.js";

export interface ConversationShareSelectionPanelProps {
  onConfirm?: () => void;
  onCancel?: () => void;
  selectedCount?: number;
  preflight?: ConversationSharePreflightState;
  visible: boolean;
  items: readonly ConversationTurnNavigatorItem[];
  selectedRowIds: ReadonlySet<number>;
  onToggle: (rowId: number) => void;
  onSelectAllChange?: (selected: boolean) => void;
  onInspect: (target: { unitIndex: number; rowId: number }) => void;
}

// [契约] 高度写 auto 而非固定像素：候选很少时面板自然收窄，避免在大块空白里只放一个确认区。
// max-height 与 top 走 CSS 变量，由共享会话容器在运行时注入，窄屏与 dock 增高时同一份样式被重算。
// 改回写死 top 百分比会与 motion 自带的居中位移叠加，面板整体上移半个身位并越过内容区。
// 这里只是兜底默认，打开后会被量测函数逐帧覆写，两处不一致时以脚本写入的内联样式为准。
const PANEL_LAYOUT_STYLE: CSSProperties = {
  // 固定高度会让少量候选留下大块空白，并在底部 dock 增高时覆盖输入区。
  // 面板自身按内容自然撑开，max-height 与 top 由共享会话容器动态提供。
  height: "auto",
  maxHeight: `var(${CONVERSATION_SHARE_SELECTION_PANEL_MAX_HEIGHT_PROPERTY}, calc(100% - 3rem))`,
  top: `var(${CONVERSATION_SHARE_SELECTION_PANEL_CENTER_Y_PROPERTY}, 50%)`,
};

// 实现体与 memo 包装分离：props 变化由浅比较拦截，避免父级每次渲染都重建整棵长列表。
// 回调 props 必须保持引用稳定，否则 memo 失效，长列表每帧全量重渲并在滚动时掉帧。
// 本组件不持有选择、展开等业务状态，唯一的局部状态是 DOM 引用与布局副作用。
function ConversationShareSelectionPanelImpl({
  visible,
  items,
  selectedRowIds,
  onToggle,
  onSelectAllChange,
  onInspect,
  onConfirm,
  onCancel,
  selectedCount = selectedRowIds.size,
  preflight,
}: ConversationShareSelectionPanelProps) {
  // 文案全部走 intl.formatMessage，键名以 conversationShare 前缀分组；不要在 JSX 里拼中文兜底串。
  // 减少动效偏好取 useReducedMotion 的布尔结果，直接读 matchMedia 会漏掉系统设置的运行期变更。
  // 动效参数由兄弟模块按偏好给出，本文件不自行拼过渡曲线，避免两处节奏不一致。
  // 四个 ref 分别指向面板、滚动外壳、内容层、视觉滑块，缺任意一个都会让对应副作用直接退出。
  const { intl } = useZCodeIntl();
  const prefersReducedMotion = useReducedMotion() === true;
  const motionConfig = resolveConversationShareSelectionPanelMotion(prefersReducedMotion);
  const panelRef = useRef<HTMLElement>(null);
  const scrollShellRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const visualThumbRef = useRef<HTMLDivElement>(null);
  // [契约] isRunning 的轮次不可分享：它仍在流式输出，内容未定型，勾选后提交会与其最终状态不符。
  // 过滤只做一次，后续计数、全选、禁用态统一基于这份集合，避免各处重复判断产生分歧。
  // 不要改成保留全量再加 disabled 标记：计数一旦含运行中项，全选将永远无法显示为已选。
  // 每次渲染重新过滤可接受：候选项量级等于会话轮次数，远小于布局与滚动的开销。
  const selectableItems = items.filter((item) => !item.isRunning);
  const selectedItemCount = selectableItems.filter((item) => selectedRowIds.has(item.rowId)).length;
  const allSelected = selectableItems.length > 0 && selectedItemCount === selectableItems.length;
  // [并发] 已选大于 0 且校验未就绪才算检查中；未选时不该因后台校验未完成而锁住按钮。
  // preflight 为 undefined 表示尚未发起校验，既不算检查中，也不应据此给出超限结论。
  // 状态取自父级状态机，本组件不做乐观推断，避免与服务端返回的结论互相打架。
  // 若把 undefined 当成就绪处理，用户可在校验完成前抢先提交，拿到过期结论。
  const checking = selectedCount > 0 && preflight !== undefined && preflight.status !== "ready";
  // [失败路径] 只在就绪状态里找 rows_limit 阻塞项：非就绪时的 issues 是半成品，不能据此禁用确认。
  // 取第一条即可，preflight 保证同一 code 不重复上报；重复时也只影响提示数量，不影响禁用判定。
  // actual 与 limit 可能缺失，下面的差值统一用零兜底，避免非数字直接渲染到界面。
  // 改动此处要同步底部按钮的禁用条件，两处必须来自同一个 rowLimit，不能各算一遍。
  const rowLimit =
    preflight?.status === "ready"
      ? preflight.blockingIssues.find((issue) => issue.code === "rows_limit")
      : undefined;
  // 超额数量用零截断：服务端口径可能先超后回落，负数会让文案出现「已超出 -2 条」。
  // 该值仅用于提示文案，不参与禁用判定；禁用只看阻塞项是否存在。
  const exceededRows = rowLimit ? Math.max(0, (rowLimit.actual ?? 0) - (rowLimit.limit ?? 0)) : 0;

  useLayoutEffect(() => {
    // [资源] 隐藏时不量测也不订阅：面板已从 DOM 移除，此时读高度会得到零并把样式写坏。
    // 提前返回必须在取节点引用之前，否则拿到的是上一轮残留节点，量测结果会污染下次打开。
    if (!visible) return;
    const panel = panelRef.current;
    const content = scrollContentRef.current;
    if (!panel || !content) return;

    // 量测函数会被首帧、尺寸观察与容器变化反复调用，必须保持幂等且只读几何量。
    // [权衡] 用同步读写而非动画帧合帧：首帧就要完成布局，否则面板先按兜底样式闪现再跳位。
    // 内部不做节流，依赖观察者自身的批量派发限频；加节流会让展开与收起出现肉眼可见的滞后。
    // 写回样式的三个属性必须成套更新，只改其一会让最大高度与定位互相矛盾。
    const syncNaturalHeight = () => {
      // 列表直接贴合面板边缘；content 的 scrollHeight 始终代表完整候选列表，
      // 即使外层已经被 max-height 截断，也不会把可滚动内容误测成当前 viewport 高度。
      // [契约] 用内容层 scrollHeight 而非面板可视高度：内容层未被外层裁剪，始终代表完整列表。
      // 98 是底部确认区的固定占用，只有确认与取消同时存在才叠加，否则会把栏高算进纯列表。
      // 这个常量与底部栏的内边距耦合，改内边距时必须同步，否则按钮会被裁掉几个像素。
      // 改成读取底部栏实际高度不可行：首次渲染时它尚未布局，面板会先塌陷再撑开。
      const naturalHeight = content.scrollHeight + (onConfirm && onCancel ? 98 : 0);
      const settings = document.querySelector<HTMLElement>(
        '[data-testid="conversation-share-popover"]',
      );
      const container = panel.parentElement;
      // 窄窗口无法并排容纳两个面板，选择器移到设置下方，仍保留固定确认区。
      // [契约] 640 是并排容纳两个面板的下限，与样式层的移动端断点对齐，改一处必须改另一处。
      // 窄屏下选择器移到设置面板下方，仍保留固定确认区，避免确认按钮被推出视口。
      // 设置面板通过测试标识查询而非引用传递：两个面板由不同容器渲染，无法共享引用。
      // settings 查询落空时直接走通用定位，面板可能被设置面板遮挡，保持原有位置并接受这一已知降级。
      // 该下移分支要求 onConfirm 与 onCancel 同时存在：纯预览模式没有确认区，也就不需要下移。
      if (onConfirm && settings && container && container.clientWidth < 640) {
        const parentRect = container.getBoundingClientRect();
        const settingsRect = settings.getBoundingClientRect();
        const layout = getComputedStyle(container);
        const center = Number.parseFloat(
          layout.getPropertyValue(CONVERSATION_SHARE_SELECTION_PANEL_CENTER_Y_PROPERTY),
        );
        const maxHeight = Number.parseFloat(
          layout.getPropertyValue(CONVERSATION_SHARE_SELECTION_PANEL_MAX_HEIGHT_PROPERTY),
        );
        const bottom =
          Number.isFinite(center) && Number.isFinite(maxHeight)
            ? parentRect.top + center + maxHeight / 2
            : parentRect.bottom;
        // 可用高度等于面板下沿减去设置面板底部再减 16px 间距，保证两者不重叠。
        // 下限 96px 保证至少露出一行内容加确认区；窗口极矮时宁可重叠也不渲染成一条缝。
        // 中心位与最大高度由 CSS 变量解析得到，解析失败时退回容器底边，避免非数字参与计算。
        // 这里的下沿是相对视口的绝对位置，后续写 top 时要减回容器顶部。
        const remaining = Math.max(96, bottom - settingsRect.bottom - 16);
        const height = Math.min(naturalHeight, remaining);
        panel.style.maxHeight = `${remaining}px`;
        panel.style.top = `${settingsRect.bottom - parentRect.top + 8 + height / 2}px`;
        panel.style.height = `${height}px`;
      // 通用分支恢复共享变量，让容器在窗口变宽后重新接管定位。
      // 必须显式写回而不是清空内联样式：清空会立即回落到旧值，触发观察者再次进入窄屏分支形成抖动。
      // 高度只在内容已量出时写入，避免隐藏瞬间把面板压成零高。
      } else {
        panel.style.maxHeight = String(PANEL_LAYOUT_STYLE.maxHeight);
        panel.style.top = String(PANEL_LAYOUT_STYLE.top);
        if (content.scrollHeight > 0) panel.style.height = `${naturalHeight}px`;
      }
    };
    syncNaturalHeight();

    // [失败路径] 无尺寸观察能力的环境直接放弃订阅，不抛错也不阻断渲染。
    // ResizeObserver 缺失时面板保持首帧 syncNaturalHeight 的量测结果，尺寸变化后不再自适应。
    // 不能用定时轮询兜底，隐藏面板上的定时器会持续持有已卸载节点。
    if (typeof ResizeObserver === "undefined") return;
    const resizeObserver = new ResizeObserver(syncNaturalHeight);
    resizeObserver.observe(content);
    if (panel.parentElement) resizeObserver.observe(panel.parentElement);
    const settings = document.querySelector<HTMLElement>(
      '[data-testid="conversation-share-popover"]',
    );
    if (settings) resizeObserver.observe(settings);
    // [资源] 卸载或依赖变化时必须断开观察者，否则回调继续持有已卸载节点并写入样式。
    // 只断开不置空引用即可：下次副作用会重新创建，残留引用不影响正确性。
    // 依赖数组刻意只放长度与回调存在性，列表内容变化不触发重新订阅。
    return () => resizeObserver.disconnect();
  }, [items.length, visible, onConfirm, onCancel]);

  // visualThumb 是独立视觉层：原生滑块只保留拖动命中，绘制与位移全部由 updateVisualThumb 接管。
  // [契约] 面板隐藏时整段不执行，避免对已移除的滚动视口绑定监听。
  // 外壳、视觉滑块、滚动视口三者任一缺失就放弃，说明 DOM 结构已被改动，此时宁可不画。
  useEffect(() => {
    if (!visible) return;

    const shell = scrollShellRef.current;
    const visualThumb = visualThumbRef.current;
    const viewport = shell?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!shell || !visualThumb || !viewport) return;

    // [并发] 用闭包变量保存唯一的动画帧句柄，零表示空闲；滚动事件可能每帧触发多次。
    // 句柄在回调首行归零，保证回调执行期间的再次调度能被正确取消。
    // 不要放到模块作用域，多实例面板会互相取消，导致其中一个永远不刷新。
    let animationFrame = 0;
    // 指标计算交给兄弟模块，本组件只负责把结果写进样式，保证与滚动条判定同源。
    // 内容尺寸取视口滚动高度，轨道尺寸取外壳可见高度：两者口径不同不能互换。
    // 可见性为假时隐藏滑块，对应内容未溢出的场景，此时不应残留半截滑块。
    // 高度与位移必须同一帧写入，否则会看到滑块先跳高度再跳位置。
    const updateVisualThumb = () => {
      animationFrame = 0;
      const metrics = resolveConversationShareScrollbarIndicatorMetrics({
        trackSize: shell.clientHeight,
        viewportSize: viewport.clientHeight,
        contentSize: viewport.scrollHeight,
        scrollOffset: viewport.scrollTop,
      });

      // 渐隐只作用于 viewport，避免连同独立滚动条和底部按钮一起淡出。
      // 1px 容差用于吸收小数滚动的取整误差，否则顶部会残留一条渐隐。
      // [契约] 两端共用一条渐变表达式，只有端点颜色随之切换，避免滚动中反复重建两套遮罩定义。
      // 两端同时可滚时用固定 32px 过渡带，两端都不可滚时置为空值，避免合成层常驻。
      // 遮罩参与合成，滚动期间只改端点色而不摘除属性，否则每帧都会重建图层。
      const fadeTop = viewport.scrollTop > 1;
      const fadeBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 1;
      viewport.style.maskImage =
        fadeTop || fadeBottom
          ? `linear-gradient(to bottom, ${fadeTop ? "transparent" : "black"}, black 32px, black calc(100% - 32px), ${fadeBottom ? "transparent" : "black"})`
          : "none";
      visualThumb.style.display = metrics.visible ? "block" : "none";
      visualThumb.style.height = `${metrics.size}px`;
      visualThumb.style.transform = `translateY(${metrics.offset}px)`;
    };
    // [并发] 调度前先取消上一个句柄，保证同一时刻最多一个待执行帧。
    // requestAnimationFrame 调度只保留最后一帧：中间态无保留价值，逐帧绘制会让滑块落后于手指。
    // 首帧也走调度而非直接调用，保证与后续更新路径完全一致，便于统一排查。
    // 这里不重复判断可见性，调用方已在隐藏时提前返回，重复判断会掩盖生命周期错误。
    const scheduleVisualThumbUpdate = () => {
      if (animationFrame !== 0) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(updateVisualThumb);
    };

    // [权衡] 滚动监听必须被动模式，回调里只读几何量、只写位移，不触发同步布局。
    // 监听挂在滚动视口而非外壳：外壳本身不滚动，挂错位置会永远收不到事件。
    // 监听器引用必须与清理阶段的同一个函数，否则移除失败、监听越积越多。
    viewport.addEventListener("scroll", scheduleVisualThumbUpdate, {
      passive: true,
    });
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleVisualThumbUpdate);
    resizeObserver?.observe(shell);
    resizeObserver?.observe(viewport);
    if (viewport.firstElementChild instanceof HTMLElement) {
      resizeObserver?.observe(viewport.firstElementChild);
    }
    scheduleVisualThumbUpdate();

    // [资源] 清理顺序固定：先摘监听，再断开观察者，最后取消待执行帧。
    // 顺序颠倒会让最后一帧基于过期节点计算，或读到已经断开的滚动视口。
    // 三层观察覆盖外壳、滚动视口与内容首个子元素，任一层缺失都会漏掉一类尺寸变化。
    return () => {
      viewport.removeEventListener("scroll", scheduleVisualThumbUpdate);
      resizeObserver?.disconnect();
      if (animationFrame !== 0) cancelAnimationFrame(animationFrame);
    };
  }, [items.length, visible]);

  return (
    <AnimatePresence initial={false}>
      {visible ? (
        // motion transform 已包含 -50% 的纵向居中；再叠加 Tailwind translate
        // 会把面板重复上移半个自身高度，越过会话内容区并被 WorkspaceHeader 覆盖。
        <motion.aside
          ref={panelRef}
          key="conversation-share-selection-panel"
          aria-label={intl.formatMessage({
            id: "conversationShare.partial.panelLabel",
          })}
          data-testid="conversation-share-selection-panel"
          data-conversation-share-left-navigation="true"
          data-conversation-share-mode-motion="selection-panel"
          className="group/share-selection-panel absolute left-4 z-30 flex h-auto w-[20rem] flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-md ring-1 ring-inset ring-popover-border max-md:left-2 max-md:w-[min(20rem,calc(100vw-1rem))]"
          style={PANEL_LAYOUT_STYLE}
          initial={motionConfig.initial}
          animate={motionConfig.animate}
          exit={motionConfig.exit}
          transition={motionConfig.transition}
        >
          {onConfirm && onCancel ? (
            <div
              className="flex shrink-0 items-center border-b border-border px-4 py-2"
              data-testid="conversation-share-selection-header"
            >
              <label className="flex min-h-8 cursor-pointer items-center gap-3">
                <Checkbox
                  data-testid="conversation-share-selection-all"
                  aria-label={intl.formatMessage({ id: "conversationShare.partial.selectAll" })}
                  checked={allSelected ? true : selectedItemCount > 0 ? "indeterminate" : false}
                  disabled={selectableItems.length === 0}
                  onCheckedChange={() => {
                    if (onSelectAllChange) {
                      onSelectAllChange(!allSelected);
                      return;
                    }
                    for (const item of selectableItems) {
                      if (selectedRowIds.has(item.rowId) === allSelected) onToggle(item.rowId);
                    }
                  }}
                />
                <span className="text-ui-base">
                  {intl.formatMessage({ id: "conversationShare.partial.selectAll" })}
                </span>
              </label>
            </div>
          ) : null}
          {/* Bugfix：Radix 默认的 table wrapper 会被长文本撑宽，必须锁回 viewport 宽度，否则右侧间距、截断和 hover 都会失真。 */}
          {/* Bug 根因：auto 会按滚动事件挂载/卸载 scrollbar，无法让整个面板 hover 稳定控制可见性；始终挂载后只切 opacity。 */}
          <div ref={scrollShellRef} className="relative min-h-0 flex-1">
            <ScrollArea
              type="always"
              data-testid="conversation-share-selection-scroll-area"
              className="size-full min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:!w-full"
              // scale-y-50 只缩短 Radix thumb 的绘制结果，位移仍按原长度计算，
              // 因而滚动到底后可见 thumb 仍停在轨道中段。原始 thumb 仅保留拖动命中，
              // 视觉 thumb 由完整 scroll progress 独立映射到整条轨道。
              scrollbarClassName="opacity-0 transition-opacity group-hover/share-selection-panel:opacity-100 group-focus-within/share-selection-panel:opacity-100 data-vertical:!w-2.5 data-vertical:!pr-1 data-vertical:!pl-0 [&_[data-slot=scroll-area-thumb]]:!min-w-1.5 [&_[data-slot=scroll-area-thumb]]:!bg-transparent [@media(hover:none)]:opacity-100"
            >
              <div ref={scrollContentRef} className="flex min-w-0 flex-col p-2">
                {items.length > 0 ? (
                  items.map((item) => {
                    const selected = selectedRowIds.has(item.rowId);
                    return (
                      <div
                        key={item.key}
                        data-conversation-share-selection-item="true"
                        data-conversation-share-selection-state={
                          selected ? "selected" : "unselected"
                        }
                        className="group flex items-start gap-2 rounded-lg px-1 py-2 transition-colors hover:bg-menu-hover"
                        onClick={() => {
                          // [契约] 行点击与复选框点击共用同一判定，运行中轮次即便点中也必须无副作用。
                          // 复选框外层已阻断冒泡，这里再补一次阻断会让整行点击热区失效。
                          // 只派发切换意图，不在本地改选中态：状态回流前界面保持不变，避免双写。
                          if (!item.isRunning) onToggle(item.rowId);
                        }}
                      >
                        <div className="relative flex h-5 w-6 shrink-0 items-center justify-center">
                          {/* Bugfix：原先只有 14px Checkbox 本体接收点击，24px 槽位只是布局容器；用不占布局的 32px label 扩大热区，避免改变列表间距和视觉尺寸。 */}
                          <label
                            data-conversation-share-checkbox-hit-area="true"
                            onClick={(event) => event.stopPropagation()}
                            className="absolute flex size-8 cursor-pointer items-center justify-center"
                          >
                            <Checkbox
                              checked={selected}
                              disabled={item.isRunning}
                              aria-label={item.userPreview}
                              onCheckedChange={() => {
                                if (!item.isRunning) onToggle(item.rowId);
                              }}
                              checkIconStrokeWidth={1.33}
                            />
                          </label>
                        </div>
                        <button
                          type="button"
                          disabled={item.isRunning}
                          aria-label={item.userPreview}
                          aria-pressed={selected}
                          data-testid="conversation-share-selection-toggle"
                          className="flex min-w-0 flex-1 flex-col gap-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                        >
                          <span
                            className={cn(
                              "block truncate text-ui-base font-normal leading-5 transition-colors",
                              item.isRunning ? "text-foreground-subtlest" : "text-foreground",
                            )}
                          >
                            {item.userPreview}
                          </span>
                          <span
                            className={cn(
                              "line-clamp-2 break-words text-ui-sm leading-4 transition-colors",
                              item.isRunning
                                ? "text-foreground-subtlest"
                                : "text-foreground-subtle",
                            )}
                          >
                            {item.assistantPreview}
                          </span>
                        </button>
                        <ControlHintTooltip
                          title={intl.formatMessage({ id: "conversationShare.range.locate" })}
                          side="right"
                        >
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="-my-0.5 text-foreground-subtle"
                            data-testid="conversation-share-selection-locate"
                            aria-label={intl.formatMessage({
                              id: "conversationShare.range.locate",
                            })}
                            onClick={(event) => {
                              event.stopPropagation();
                              onInspect({ unitIndex: item.unitIndex, rowId: item.rowId });
                            }}
                          >
                            <LocateFixed />
                          </Button>
                        </ControlHintTooltip>
                      </div>
                    );
                  })
                ) : (
                  <p className="px-2 py-4 text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({
                      id: "conversationShare.partial.empty",
                    })}
                  </p>
                )}
              </div>
            </ScrollArea>
            <div
              ref={visualThumbRef}
              aria-hidden="true"
              data-testid="conversation-share-selection-scroll-thumb"
              className="pointer-events-none absolute right-1 top-0 z-10 hidden w-1.5 rounded-full bg-border opacity-0 transition-opacity group-hover/share-selection-panel:opacity-100 group-focus-within/share-selection-panel:opacity-100 [@media(hover:none)]:opacity-100"
            />
          </div>
          {onConfirm && onCancel ? (
            <div
              className="flex shrink-0 items-center justify-between gap-1 border-t border-border pr-2 pl-4 py-2"
              data-testid="conversation-share-selection-footer"
            >
              <span
                role="status"
                data-testid="conversation-share-selection-summary"
                className={cn(
                  "min-w-0 text-ui-sm",
                  rowLimit ? "text-warning" : "text-foreground-subtle",
                )}
              >
                {rowLimit
                  ? intl.formatMessage(
                      { id: "conversationShare.range.exceeded" },
                      { count: exceededRows },
                    )
                  : checking
                    ? intl.formatMessage({ id: "conversationShare.partial.preflightChecking" })
                    : intl.formatMessage(
                        { id: "conversationShare.range.selected" },
                        { count: selectedCount },
                      )}
              </span>
              <div className="flex gap-1">
                <Button
                  size="lg"
                  variant="ghost"
                  onClick={onCancel}
                  data-testid="conversation-share-selection-cancel"
                >
                  {intl.formatMessage({
                    id: "conversationShare.partial.cancel",
                  })}
                </Button>
                <Button
                  size="lg"
                  disabled={selectedCount === 0 || checking || !!rowLimit}
                  onClick={onConfirm}
                  data-testid="conversation-share-selection-apply"
                >
                  {intl.formatMessage({
                    id: "conversationShare.range.confirm",
                  })}
                </Button>
              </div>
            </div>
          ) : null}
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}

export const ConversationShareSelectionPanel = memo(ConversationShareSelectionPanelImpl);
