/**
 * 轻量 toast 提示
 *
 * 不引入第三方库，用 React portal 渲染到 body，3 秒自动消失。
 * 调用方式：`import { toast } from "@/components/ui/toast.js"; toast("message");`
 */
// toast.tsx — 全局 toast 单例宿主、按位置分栈、去重与自动消失
//
// 职责边界
//   拥有：模块级 add/remove/update 桥、挂载前暂存、宿主 div 单例、按 position 分栈渲染、
//         每条提示的进出场与自动消失计时、anchorId 锚点跟随定位。
//   不拥有：提示文案与业务语义、是否该弹出、路由与页面状态、持久化。
//   边界：唯一对外入口是 toast / updateToast / dismissToast；调用方不得直接操作 #zcode-toast-host。
//   依赖：react-dom/client、react hooks、lucide-react 图标、cn；不引入第三方 toast 库。
//
// INV（不变量）—— 任一条被破坏都会表现为丢提示、重复提示或计时器泄漏
// INV-01 断言：宿主 #zcode-toast-host 至多一个 —— 守住它的位置：ensureHost 中 addToast 的短路返回 —— 改错故障：重复 portal，同一提示成对出现并互抢层叠上下文
// INV-02 断言：addToast 为 null 时 toast() 不得丢消息 —— 守住它的位置：tryAdd 的 requestAnimationFrame 重试 —— 改错故障：首帧调用被静默丢弃
// INV-03 断言：items 是唯一渲染源 —— 守住它的位置：ToastContainer 内三处 setItems 写入 —— 改错故障：出现第二份镜像后关闭状态不同步
// INV-04 断言：同 dedupeKey 只保留最新一条 —— 守住它的位置：upsertToastItem 的 filter —— 改错故障：同一操作堆叠成多条且各自倒计时
// INV-05 断言：去重后的新条目排在栈底 —— 守住它的位置：upsertToastItem 返回尾部追加 —— 改错故障：用户感知不到最新进度
// INV-06 断言：durationMs 非有限或小于等于 0 时不启计时器 —— 守住它的位置：ToastMessage effect 的提前 return —— 改错故障：NaN 传给 setTimeout 变成 0ms 立即消失
// INV-07 断言：durationMs 变化必须重启倒计时 —— 守住它的位置：effect 依赖 [item.durationMs] 与 clearTimeout —— 改错故障：长任务转终态后仍按旧时长提前关闭
// INV-08 断言：挂载前的 update 不得覆盖建条时的必需字段 —— 守住它的位置：addToast 中 {...item, ...pendingUpdate} 的展开顺序 —— 改错故障：id 与 message 被补丁污染
// INV-09 断言：挂载前被 dismiss 的 id 不得再上屏 —— 守住它的位置：dismissedBeforeMountToastIds 与 addToast 的提前返回 —— 改错故障：已取消的操作结果仍然弹出
// INV-10 断言：卸载时必须解绑三个全局回调 —— 守住它的位置：ToastContainer effect 的 cleanup —— 改错故障：悬空引用继续 setItems（卸载后 setState）
// INV-11 断言：移除只按 id 精确匹配 —— 守住它的位置：handleRemove 与 removeToast 的 filter —— 改错故障：重复键场景误删兄弟提示
// INV-12 断言：动画时长与 JS 移除延迟必须一致 —— 守住它的位置：TOAST_TRANSITION_DURATION_MS 与根节点 duration-200 —— 改错故障：CSS 改了而 JS 未改，条目被提前摘除露出残影
// INV-13 断言：锚点监听在 anchorId 变化后完全重建 —— 守住它的位置：AnchoredToastStack effect 的 disconnect 与 removeEventListener —— 改错故障：旧锚点滚动仍推动新栈位置
// INV-14 断言：React key 必须是 item.id 而非 dedupeKey —— 守住它的位置：各栈 map 中的 key={item.id} —— 改错故障：去重替换复用旧组件，计时器与动画都不重启
// 状态所有者
//   模块级：nextId（单调递增）、addToast/removeToast/updateToastItem（挂载期桥）、
//           pendingToastIds、pendingToastUpdates、dismissedBeforeMountToastIds，均只在宿主挂载后有效。
//   组件级：ToastContainer.items、ToastMessage.visible、AnchoredToastStack.left。
//   渲染顺序：ensureHost → ToastContainer → AnchoredToastStack → ToastMessage → ToastMessageView。
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { Info, TriangleAlert, X } from "lucide-react";
import { cn } from "@/components/lib/utils.js";

export type ToastPosition = "top-center" | "top-right" | "bottom-left" | "bottom-center";
type ToastVariant = "default" | "update" | "source-server-update" | "info" | "warning";

export interface ToastOptions {
  durationMs?: number;
  position?: ToastPosition;
  variant?: ToastVariant;
  actionLabel?: string;
  onAction?: () => void;
  dismissible?: boolean;
  dismissLabel?: string;
  anchorId?: string;
  /** 同一业务目标与动作的稳定键；新结果替换旧结果并移到栈底。 */
  dedupeKey?: string;
}

export interface ToastItem {
  id: number;
  message: string;
  durationMs: number;
  position: ToastPosition;
  variant?: ToastVariant;
  actionLabel?: string;
  onAction?: () => void;
  dismissible?: boolean;
  dismissLabel?: string;
  anchorId?: string;
  dedupeKey?: string;
}

export function upsertToastItem(items: readonly ToastItem[], item: ToastItem): ToastItem[] {
  if (!item.dedupeKey) return [...items, item];
  return [...items.filter((current) => current.dedupeKey !== item.dedupeKey), item];
}

export function resolveToastStackClassName(position: ToastPosition): string {
  const bottomInset = "bottom-[calc(1rem+env(safe-area-inset-bottom))]";
  switch (position) {
    case "top-center":
      return "fixed top-16 left-1/2 z-[9999] flex -translate-x-1/2 flex-col items-center gap-2";
    case "top-right":
      return "fixed right-4 top-16 z-[9999] flex max-w-[calc(100vw-2rem)] flex-col items-end gap-2";
    case "bottom-center":
      return `fixed ${bottomInset} left-1/2 z-[9999] flex -translate-x-1/2 flex-col items-center gap-2`;
    case "bottom-left":
      return `fixed ${bottomInset} left-4 z-[9999] flex flex-col items-start gap-2`;
  }
}

export type ToastUpdate = Partial<Omit<ToastItem, "id">>;

// [契约] 每条 toast 的稳定句柄 id，由模块级计数器单调分配，进程内永不复用。
// 调用方拿 id 做后续 updateToast / dismissToast 的唯一定位依据；重启计数会撞上仍在栈内的旧条目。
// id 同时是各栈 map 的 React key —— 见 ToastContainer 中的 key={item.id}。
// 去重并不复用 id：upsertToastItem 剔除同 dedupeKey 的旧条目后，追加一条带新 id 的条目。
// 因此「替换」在 React 看来是「卸载 + 挂载」，动画与倒计时都会重新开始，这是有意保留的行为。
let nextId = 0;
let addToast: ((item: ToastItem) => void) | null = null;
let removeToast: ((id: number) => void) | null = null;
let updateToastItem: ((id: number, patch: ToastUpdate) => void) | null = null;
// [事务] 挂载前暂存区，与下面两个容器一起构成 toast() 与宿主之间的两阶段提交。
// pendingToastIds：已发放 id 但尚未被 addToast 接管的条目，用于判断 update/dismiss 走暂存还是直改。
// pendingToastUpdates：合并同一 id 的多段更新，让长任务从「进行中」到「已完成」只落一次最终态。
// dismissedBeforeMountToastIds：宿主就绪前就被取消的 id，addToast 见到即丢弃，避免迟到的结果仍上屏。
// 三者只在宿主挂载期间有意义；ToastContainer 卸载时回调置 null，但集合本身不清空。
const pendingToastIds = new Set<number>();
const pendingToastUpdates = new Map<number, ToastUpdate>();
const dismissedBeforeMountToastIds = new Set<number>();
// [契约] 默认停留 3 秒；调用方可用 durationMs 覆盖，传 0 或负数表示「常驻直到显式关闭」。
// 200ms 是进出场过渡时长，必须与 ToastMessageView 根节点的 duration-200 保持一致。
// 两个时长在代码里是独立常量，改 CSS 时若忘改这里，条目会在动画结束前被摘除，露出剩余残影。
// 3000 与 200 的比值决定用户可读窗口；放大字号或加长文案时应由调用方传参，而不是压低默认值。
// 计时器不在这里启动，它属于 ToastMessage 的 effect，避免宿主重渲染导致倒计时被反复重置。
const DEFAULT_TOAST_DURATION_MS = 3000;
const TOAST_TRANSITION_DURATION_MS = 200;

function ensureHost() {
  if (addToast) {
    return;
  }

  // [资源] 宿主是挂到 body 的独立 div，toast 不进入调用方组件树，因而不受其 overflow 与层叠上下文裁剪。
  // id 固定为 zcode-toast-host，便于调试与 E2E 定位；重复插入会让 z-[9999] 的层级竞争变得不可预期。
  // 这里不复用已有的宿主节点；创建与绑定写在同一段同步代码里，只在 ensureHost 首次通过时才执行。
  // [失败路径] ensureHost 的守卫读的是 addToast，而 addToast 要到 ToastContainer 的 effect 才赋值，
  // 所以同一帧内连续两次 toast() 仍可能各建一个宿主 —— 这是现存窗口，不要在此基础上再加同步入口。
  const host = document.createElement("div");
  host.id = "zcode-toast-host";
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<ToastContainer />);
}

function ToastContainer() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    // [事务] 挂载完成后的正式写入口：先删 pendingToastIds 标记该 id 已交付，再取走并删除待合并的更新。
    // dismissedBeforeMountToastIds 命中说明这条在等待期间已被取消，消费标记后直接返回，不写 items。
    // 合并顺序是 {...item, ...pendingUpdate}：建条字段打底、更新补丁覆盖，晚到的 update 不会丢 message 与 id。
    // upsertToastItem 在这里承担去重：同 dedupeKey 的旧条目被过滤，新条目追加到数组尾部（栈底）。
    // [并发] 无 dedupeKey 时每次调用都追加，items 只增不减 —— 队列上限由此完全交给调用方自律。
    addToast = (item: ToastItem) => {
      pendingToastIds.delete(item.id);
      const pendingUpdate = pendingToastUpdates.get(item.id);
      pendingToastUpdates.delete(item.id);
      if (dismissedBeforeMountToastIds.has(item.id)) {
        dismissedBeforeMountToastIds.delete(item.id);
        return;
      }
      // 挂载前的进度更新和既有去重必须同时生效，不能合入分享提示后又堆叠同一操作。
      setItems((prev) =>
        upsertToastItem(prev, pendingUpdate ? { ...item, ...pendingUpdate } : item),
      );
    };
    // [契约] 对外 dismissToast 的实际执行体：按 id 精确过滤，不做 dedupeKey 或 message 的模糊匹配。
    // 只在宿主已挂载、且该 id 已过 pending 阶段时被调用；挂载前的取消走 dismissedBeforeMountToastIds。
    // 被过滤条目若仍有未触发的内层 setTimeout，会在 200ms 后对同一 id 再调一次 onDone，此时是空操作。
    // 不在这里清理 pending 集合：那属于 toast() 与 dismissToast 的职责，避免同一条目出现第二处写入路径。
    removeToast = (id: number) => {
      setItems((prev) => prev.filter((item) => item.id !== id));
    };
    // [事务] 已上屏条目的原地补丁：map 后浅合并，id 不在 items 中时整次调用是 no-op。
    // patch 类型是 Partial<Omit<ToastItem, "id">>，从类型层面禁止改 id，防止 React key 与计时器基座错位。
    // [权衡] 这里没有 dedupeKey 冲突检查：更新只作用于已知 id，不会把另一条同键条目挤掉。
    // 若 patch 改了 durationMs，ToastMessage 的 effect 会感知并重启自动消失计时器。
    updateToastItem = (id: number, patch: ToastUpdate) => {
      setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    };

    return () => {
      // [资源] ToastContainer 卸载的唯一清理分支：三个模块级桥全部置 null，避免闭包继续持有已卸载组件的 setItems。
      // addToast 置 null 后，ensureHost 的守卫重新变为「未就绪」，下次 toast() 会重建宿主 —— 这是预期的重入路径。
      // [失败路径] 卸载后仍被触发的 200ms 内层定时器会走 onDone → handleRemove → setItems，
      // React 18 对已卸载组件的 setState 是静默丢弃，不报警也不恢复渲染，因此不能依赖它兜底。
      // 这里只解绑回调，不清空 pending 系列容器；残留 id 随进程存活，量级由调用方控制。
      addToast = null;
      removeToast = null;
      updateToastItem = null;
    };
  }, []);

  // [契约] 子组件回调上浮的移除入口，语义与 removeToast 相同，只在容器内部使用。
  // 它由 ToastMessage 在动画结束后调用，调用时机天然晚于用户可见的消失，不需要再做防抖。
  // [并发] 同一 id 可能同时被点击关闭与计时器到点两条路径命中；filter 幂等，重复移除无副作用。
  // 若同 dedupeKey 的新条目已带新 id 入栈，这里按旧 id 过滤不会误伤新条目。
  const handleRemove = (id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  };

  // [权衡] 分栈是纯派生的：每次渲染对 items 做四遍 filter，n 为当前存活提示数，不做缓存也没有显式上限。
  // [契约] 未设 anchorId 的 top-center 条目走固定居中栈；设了 anchorId 的交给 AnchoredToastStack 跟随锚点。
  // 队列上限不存在于代码中：同位置的全部条目都会被渲染并各自倒计时，长任务反复 toast 会持续堆叠。
  // 唯一的收敛手段是调用方的 dedupeKey，把「同一业务目标 + 同一动作」合并成一条；不传键就没有任何抑制。
  // 若需要真正的上限，应在这里截断并保留尾部最新的若干条，而不是在渲染层用 CSS 隐藏溢出。
  const topCenterItems = items.filter((item) => item.position === "top-center" && !item.anchorId);
  const topRightItems = items.filter((item) => item.position === "top-right");
  const bottomLeftItems = items.filter((item) => item.position === "bottom-left");
  const bottomCenterItems = items.filter((item) => item.position === "bottom-center");
  const anchoredTopCenterItems = new Map<string, ToastItem[]>();
  for (const item of items) {
    if (item.position !== "top-center" || !item.anchorId) continue;
    const anchorItems = anchoredTopCenterItems.get(item.anchorId) ?? [];
    anchorItems.push(item);
    anchoredTopCenterItems.set(item.anchorId, anchorItems);
  }

  return (
    <>
      {/* 顶部居中 */}
      <div className={resolveToastStackClassName("top-center")}>
        {topCenterItems.map((item) => (
          <ToastMessage key={item.id} item={item} onDone={handleRemove} />
        ))}
      </div>
      {/* 右上角：与表单状态相关的可操作提示。 */}
      <div className={resolveToastStackClassName("top-right")}>
        {topRightItems.map((item) => (
          <ToastMessage key={item.id} item={item} onDone={handleRemove} />
        ))}
      </div>
      {/* 左下角 */}
      <div className={resolveToastStackClassName("bottom-left")}>
        {bottomLeftItems.map((item) => (
          <ToastMessage key={item.id} item={item} onDone={handleRemove} isBottom />
        ))}
      </div>
      {/* 底部居中：保存和连通性等操作结果固定在窗口底部，不随设置内容滚动。 */}
      <div className={resolveToastStackClassName("bottom-center")}>
        {bottomCenterItems.map((item) => (
          <ToastMessage key={item.id} item={item} onDone={handleRemove} isBottom />
        ))}
      </div>
      {[...anchoredTopCenterItems].map(([anchorId, anchorItems]) => (
        <AnchoredToastStack
          key={anchorId}
          anchorId={anchorId}
          items={anchorItems}
          onDone={handleRemove}
        />
      ))}
    </>
  );
}

export function resolveToastAnchorLeft(rect: Pick<DOMRect, "left" | "width">): number {
  return rect.left + rect.width / 2;
}

export function AnchoredToastStack({
  anchorId,
  items,
  onDone,
}: {
  anchorId: string;
  items: ToastItem[];
  onDone: (id: number) => void;
}) {
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    let observedAnchor: HTMLElement | null = null;
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => syncPosition());

    const syncPosition = () => {
      const anchor = document.getElementById(anchorId);
      if (anchor !== observedAnchor) {
        if (observedAnchor) resizeObserver?.unobserve(observedAnchor);
        observedAnchor = anchor;
        if (observedAnchor) resizeObserver?.observe(observedAnchor);
      }
      setLeft(
        observedAnchor ? resolveToastAnchorLeft(observedAnchor.getBoundingClientRect()) : null,
      );
    };
    syncPosition();

    const mutationObserver =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(syncPosition);
    mutationObserver?.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", syncPosition);
    document.addEventListener("scroll", syncPosition, {
      capture: true,
      passive: true,
    });

    return () => {
      // [资源] 锚点栈的完整拆卸：ResizeObserver、MutationObserver、resize 与捕获阶段 scroll 四类监听逐个释放。
      // 顺序无关紧要，但必须全部执行；漏掉任何一个都会让 effect 在 anchorId 变化后叠加旧监听。
      // [失败路径] 两个 observer 在运行时不支持时为 null，此处用可选链跳过，不能写成属性访问。
      // [权衡] MutationObserver 观察 document.body 的 subtree，任何 DOM 变更都会触发一次重算，成本不低；
      // 它换来的是锚点元素被重建后位置仍能跟住，代价是提示存续期间全局 DOM 抖动都会进来。
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", syncPosition);
      document.removeEventListener("scroll", syncPosition, true);
    };
  }, [anchorId]);

  return (
    <div
      className={cn(resolveToastStackClassName("top-center"))}
      style={left === null ? undefined : { left }}
    >
      {items.map((item) => (
        <ToastMessage key={item.id} item={item} onDone={onDone} />
      ))}
    </div>
  );
}

function ToastMessage({
  item,
  onDone,
  isBottom,
}: {
  item: ToastItem;
  onDone: (id: number) => void;
  isBottom?: boolean;
}) {
  // [契约] 进入与退出动画的状态机：初始 false 用隐藏态挂载，避免第一帧就在最终位置闪现。
  // 置 false 只触发过渡，真正从 items 移除靠 onDone；两个阶段之间必然经历一次 200ms 的过渡窗口。
  // 状态只属于单条提示，卸载即销毁；同 dedupeKey 的新条目是新 id、新组件，visible 重新从 false 起步。
  // [权衡] 没有独立的 phase 枚举：visible 同时承担进场与退场，语义靠调用点区分。
  // 这让重复调用 setVisible(false) 天然幂等，代价是读代码时要结合 effect 才能判断当前处于哪一段。
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // 触发进入动画
    // [失败路径] 用 rAF 把首帧推到隐藏态绘制之后，否则浏览器会合并初始与目标样式，动画完全不发生。
    // 这个回调没有保存句柄、effect 也没有取消它：组件在首帧前被卸载时仍会执行一次 setVisible(true)。
    // React 18 对已卸载组件的 setState 静默丢弃，所以目前无害；但不要用它替代真正的取消逻辑。
    // [契约] 这里的 setVisible 只影响动画，不启动倒计时 —— 倒计时在下面的 setTimeout 分支里独立建立。
    // 进入动画依赖根节点的 motion-reduce 降级，减少动态偏好下只保留透明度过渡。
    requestAnimationFrame(() => setVisible(true));

    if (!Number.isFinite(item.durationMs) || item.durationMs <= 0) {
      return undefined;
    }

    // [资源] 自动消失计时器：到点先把 visible 置 false 启动退场过渡，再等一个过渡时长才真正移除条目。
    // 外层 timer 会被 effect 的 cleanup 清掉；内层那个 200ms 定时器没有任何句柄，属于有意为之的不取消。
    // [契约] durationMs 是可见停留且不含过渡；实际从入栈到移除的时长是 durationMs 加 200。
    // [并发] 用户点击关闭会同时走 dismissWithTransition，两条路径最终都调用 onDone，filter 幂等故不冲突。
    // 计时基准是 effect 重新执行时；若 patch 改了 durationMs，旧 timer 被清理、新 timer 从头计时。
    const timer = setTimeout(() => {
      setVisible(false);
      // 等退出动画结束后移除
      setTimeout(() => onDone(item.id), TOAST_TRANSITION_DURATION_MS);
    }, item.durationMs);

    // [资源] 唯一被显式清理的计时器句柄：durationMs 变化或组件卸载时都会执行。
    // 内层 setTimeout(onDone, 200) 不受此清理约束，它可能在卸载后仍触发一次 onDone。
    // [失败路径] durationMs 非有限或不大于 0 时 effect 已提前返回 undefined，此时没有 timer 可清，也不应清。
    // [契约] 依赖数组只含 durationMs；item.id 变化由 key 驱动的卸载重建覆盖，因此不需要进依赖。
    return () => clearTimeout(timer);
    // 持续中的 Toast 使用 duration=0；切换到终态时更新 duration，重新启动自动消失计时器。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.durationMs]);

  const isUpdate = item.variant === "update";
  const [title, ...bodyLines] = item.message.split("\n");
  const body = bodyLines.join("\n").trim();
  const dismissWithTransition = () => {
    setVisible(false);
    window.setTimeout(() => onDone(item.id), TOAST_TRANSITION_DURATION_MS);
  };
  // [事务] 操作按钮的唯一处理点：先执行调用方回调，再以同一套过渡逻辑关闭，保证点击必有反馈。
  // onAction 用可选调用；回调抛错会跳过关闭步骤，这类异常不应由 toast 吞掉。
  // dismissWithTransition 与计时器路径共用，避免出现「按钮关了但计时器还在跑」的双关闭。
  // [契约] 按钮只关闭当前这一条，不会清理同 dedupeKey 的兄弟条目 —— 后者已在上屏时被去重。
  // [权衡] 回调同步执行，耗时操作需调用方自行改用 updateToast 的持续提示，而不是撑住这次点击。
  const handleAction = () => {
    item.onAction?.();
    dismissWithTransition();
  };

  return (
    <ToastMessageView
      item={item}
      visible={visible}
      isBottom={isBottom}
      title={title}
      body={body}
      onAction={handleAction}
      onDismiss={dismissWithTransition}
    />
  );
}

export function ToastMessageView({
  item,
  visible,
  isBottom,
  title,
  body,
  onAction,
  onDismiss,
}: {
  item: ToastItem;
  visible: boolean;
  isBottom?: boolean;
  title?: string;
  body?: string;
  onAction?: () => void;
  onDismiss?: () => void;
}) {
  const isUpdate = item.variant === "update";
  const isSourceServerUpdate = item.variant === "source-server-update";
  const isNotice = item.variant === "info" || item.variant === "warning";
  const isTopRight = item.position === "top-right";
  const [fallbackTitle, ...fallbackBodyLines] = item.message.split("\n");
  const displayTitle = title ?? fallbackTitle;
  const displayBody = body ?? fallbackBodyLines.join("\n").trim();

  return (
    <div
      className={cn(
        "rounded-2xl border bg-toast/60 text-ui-base shadow-lg backdrop-blur-xl transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.77,0,0.175,1)] motion-reduce:transform-none motion-reduce:transition-opacity",
        isSourceServerUpdate
          ? "w-[min(480px,calc(100vw-2rem))] border-popover-border text-foreground"
          : isUpdate
            ? "origin-bottom-left w-[min(300px,calc(100vw-1rem))] max-w-[min(300px,calc(100vw-1rem))] border-popover-border text-foreground shadow-lg"
            : isNotice
              ? "w-[min(536px,calc(100vw-2rem))] border-border text-foreground"
              : "border-border px-4 py-3 text-foreground whitespace-pre-line",
        // Bug 原因：右上角 Toast 曾复用顶部居中的纵向缩放动画，无法表达其从右侧进入的空间关系。
        isTopRight
          ? visible
            ? "translate-x-0 opacity-100"
            : "translate-x-[calc(100%+1rem)] opacity-0"
          : isBottom
            ? visible
              ? "translate-y-0 scale-100 opacity-100"
              : "translate-y-1 scale-[0.98] opacity-0"
            : visible
              ? "translate-y-0 scale-100 opacity-100"
              : "-translate-y-1 scale-[0.98] opacity-0",
      )}
    >
      {isSourceServerUpdate ? (
        <div className="flex min-w-0 items-start gap-3 px-4 py-3">
          <span
            className="mt-1.5 size-2 shrink-0 rounded-full bg-primary ring-4 ring-accent"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <div className="break-words text-ui-base font-medium leading-5 text-foreground">
              {displayTitle}
            </div>
            {displayBody ? (
              <div className="mt-1 whitespace-pre-line break-words text-ui-sm leading-5 text-foreground-subtle">
                {displayBody}
              </div>
            ) : null}
          </div>
          {item.actionLabel ? (
            <button
              type="button"
              onClick={onAction ?? item.onAction}
              className="h-8 shrink-0 whitespace-nowrap rounded-md bg-primary px-3 text-ui-base font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {item.actionLabel}
            </button>
          ) : null}
          {item.dismissible ? (
            <button
              type="button"
              onClick={onDismiss}
              aria-label={item.dismissLabel ?? "Close"}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-subtle hover:bg-hover hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : isUpdate ? (
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-2">
          <span
            className="size-2 shrink-0 rounded-full bg-primary/80 ring-4 ring-accent"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-ui-base font-medium text-foreground">{displayTitle}</div>
            {displayBody ? (
              <div className="mt-0.5 truncate text-ui-base leading-4 text-foreground-subtle">
                {displayBody}
              </div>
            ) : null}
          </div>
          {item.actionLabel ? (
            <button
              type="button"
              onClick={onAction ?? item.onAction}
              className="h-7 max-w-14 shrink-0 truncate rounded-md bg-secondary px-2 text-ui-base font-medium text-foreground transition-colors hover:bg-hover"
            >
              {item.actionLabel}
            </button>
          ) : null}
        </div>
      ) : isNotice ? (
        // 固定最小高度会在 12px 内容 padding 之外继续补高，产生额外上下留白。
        <div className="flex min-w-0 items-center gap-4 px-4">
          {item.variant === "warning" ? (
            <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
          ) : (
            <Info className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
          )}
          <div className="flex min-w-0 flex-[1_0_0] items-start gap-4 py-3 text-sm">
            <div className="min-w-0 flex-1 leading-5">
              <div className="text-foreground">{displayTitle}</div>
              {displayBody ? (
                <div className="mt-0.5 whitespace-pre-line text-foreground-subtle">
                  {displayBody}
                </div>
              ) : null}
            </div>
            {/* Toast 继承可缩放 UI 字号，固定 18px 行高会在大字号下压缩操作文案。*/}
            {item.actionLabel ? (
              <button
                type="button"
                onClick={onAction ?? item.onAction}
                // 长团队名等具体目标不能把窄屏 Toast 撑出视口；保留完整名称并允许换行。
                className="max-w-1/2 self-center shrink-0 whitespace-normal break-words text-left font-medium leading-snug text-foreground underline underline-offset-2 hover:text-foreground-subtle"
              >
                {item.actionLabel}
              </button>
            ) : null}
          </div>
          {item.dismissible ? (
            <button
              type="button"
              onClick={onDismiss}
              aria-label={item.dismissLabel ?? "Close"}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-foreground-subtle hover:bg-hover hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : (
        item.message
      )}
    </div>
  );
}

export function toast(message: string, options?: ToastOptions): number {
  ensureHost();
  // ensureHost 是同步的，但 addToast 在下一帧 React 渲染后才可用
  // 用 requestAnimationFrame 保证 container 已挂载
  // [契约] 先取号再入暂存：id 在 toast() 的同步阶段就确定，调用方可以立刻拿返回值做 dismissToast。
  // pendingToastIds.add 标记「已发放、未交付」，updateToast 与 dismissToast 据此在暂存与直改之间分流。
  // 建条时把全部可选字段展开为显式变量，是为了让后续 tryAdd 的闭包捕获一份不可变快照。
  // [并发] tryAdd 可能跨多帧重试，每次都用同一份快照重建 item，不会读到中途变化的 options 对象。
  // [权衡] 没有对 message 做空串校验：空白提示也会占用一个 id 与一次渲染，过滤责任在调用方。
  const id = nextId++;
  pendingToastIds.add(id);
  const durationMs = options?.durationMs ?? DEFAULT_TOAST_DURATION_MS;
  const position = options?.position ?? "top-center";
  const variant = options?.variant ?? "default";
  const actionLabel = options?.actionLabel;
  const onAction = options?.onAction;
  const dismissible = options?.dismissible;
  const dismissLabel = options?.dismissLabel;
  const anchorId = options?.anchorId;
  // [契约] 去重键由调用方给出，语义是「同一业务目标 + 同一动作」，toast 层不解析也不校验其格式。
  // [并发] 同键并发入栈时后写入者获胜：upsertToastItem 过滤旧条目并追加新条目。
  // 新条目带新 id，因此 React 会卸载旧组件、挂载新组件，动画与倒计时都从头开始。
  // [权衡] 若两个不同业务误用同一个键，会互相顶掉且没有告警；键的全局唯一性由调用方保证。
  const dedupeKey = options?.dedupeKey;
  // [失败路径] 宿主未就绪时的退避：addToast 仍为 null 就再排一帧，直到 ToastContainer 的 effect 完成绑定。
  // 这是没有轮数上限的重试；只要组件树最终挂载就必然收敛，宿主被永久移除则会一直空转。
  // 命中 addToast 时先取走 pendingToastUpdates，把等待期间累积的补丁与最新快照合并后再交付。
  // [事务] 建条是单点写入：无论重试多少次，最终只调用一次 addToast，不产生重复条目。
  // 若交付前用户已 dismiss，addToast 内部会用 dismissedBeforeMountToastIds 丢弃，这里无需重复判断。
  const tryAdd = () => {
    if (addToast) {
      const item: ToastItem = {
        id,
        message,
        durationMs,
        position,
        variant,
        actionLabel,
        onAction,
        dismissible,
        dismissLabel,
        anchorId,
        dedupeKey,
      };
      const pendingUpdate = pendingToastUpdates.get(id);
      pendingToastUpdates.delete(id);
      addToast(pendingUpdate ? { ...item, ...pendingUpdate } : item);
    } else {
      requestAnimationFrame(tryAdd);
    }
  };

  tryAdd();
  return id;
}

/** 更新已有 Toast，适合把同一长耗时操作的阶段变化收敛到一个提示中。 */
// [契约] 更新分两条路径：id 还在 pendingToastIds 说明宿主未接管，写入暂存并等建条时合并。
// 暂存合并是浅合并的叠加：多次 updateToast 按调用顺序覆盖，不丢字段，也不触发额外渲染。
// 已交付的 id 走 updateToastItem；宿主未挂载或该 id 已消失时回调为 null，调用被静默忽略。
// [并发] 同一帧内连续 update 只保留最后一次的最终值，中间态不会短暂上屏，避免进度文案来回跳。
// [权衡] 不校验 id 是否存在：把 update 打到已关闭的提示上是 no-op，调用方无需维护生命周期。
export function updateToast(id: number, patch: ToastUpdate): void {
  if (pendingToastIds.has(id)) {
    pendingToastUpdates.set(id, {
      ...(pendingToastUpdates.get(id) ?? {}),
      ...patch,
    });
    return;
  }
  updateToastItem?.(id, patch);
}

export function dismissToast(id: number): void {
  if (pendingToastIds.has(id)) {
    pendingToastUpdates.delete(id);
    dismissedBeforeMountToastIds.add(id);
    return;
  }
  removeToast?.(id);
}
