// INV-01 守住位置：本文件是排队摘要滚动的唯一实现，职责边界在工具调用摘要条内部；改错故障：若把滚动状态上移到调用方，多条摘要会各自计时并重叠播放。
// INV-02 守住位置：滚动时长常量必须成对演进，动画与计时共用一处来源；改错故障：只改其一会让总时长与过渡时长脱节，出现空白停顿。
// INV-03 守住位置：待播队列上界固定为 2，截断与入队逻辑同源；改错故障：放宽后摘要积压，卡顿恢复时连环补播过期状态。
// INV-04 守住位置：快照 key 表示这是哪一条摘要，而非其文本内容；改错故障：用文本拼接当 key 会让同内容不同来源互相顶替。
// INV-05 守住位置：refreshVersion 负责同一条摘要的原位刷新；改错故障：去掉版本判定后流式正文会停在首帧不再更新。
// INV-06 守住位置：尾部文本脱离滚动容器单独渲染；改错故障：并入滚动 span 后计数与摘要一起翻走，用户看不到最终数值。
// INV-07 守住位置：displayedContent 与 displayedContentRef 双写；改错故障：只写 state 会让 effect 内读到上一帧快照并重复入队。
// INV-08 守住位置：isAnimatingRef 标记当前是否处于播放窗口；改错故障：换成 state 会引入一帧延迟，新摘要将直接 promote 打断动画。
// INV-09 守住位置：animationTimerRef 全局唯一，同一时刻只允许一个计时器；改错故障：漏清旧 timer 会让两条摘要同时滚动。
// INV-10 守住位置：漂移阈值 250ms 把迟到补播挡在外面；改错故障：阈值调大后长时间阻塞仍逐条补播，恢复瞬间更卡。
// INV-11 守住位置：减少动效与显式禁用共同短路整个排队流程；改错故障：只在渲染层判断会让 effect 仍在后台堆积任务。
// INV-12 守住位置：同一 key 不重播整条摘要；改错故障：把内部刷新误判为新条目，会让每次 diff 都触发一次滚动。
// INV-13 守住位置：卸载时清理计时器；改错故障：不清理会在组件卸载后继续写状态，触发告警并泄漏。
// INV-14 守住位置：队列第二条不可被覆盖，新摘要只能替换第三格；改错故障：直接替换队首会让既定播放顺序倒置。
// INV-15 守住位置：队列为空时立即播放，不走入队路径；改错故障：也走入队会凭空多出一拍等待，首条摘要显得迟钝。
// INV-16 守住位置：媒体查询优先新接口并保留旧接口回退；改错故障：只调新接口会让旧浏览器抛错且监听彻底失效。
// INV-17 守住位置：减少动效初值固定为 false，服务端不探测浏览器；改错故障：首帧读 window 会导致水合结果不一致。
// INV-18 守住位置：过渡配置对象复用常量派生的秒数；改错故障：另写字面量会让动画时长与计时器对不上，出现截断。
//
// 模块职责：把摘要替换过程收敛为单条纵向滚动，并保证正文与尾部计数不被动画撕裂。
// 状态所有权：快照队列、计时器、播放标志全部由本组件持有，父组件只提供当前快照字段。
// 阅读顺序：先看常量与纯函数，再看 effect 内入队与播放双分支，最后看渲染的两条返回路径。
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

// 时长常量同时驱动过渡配置与计时器，任一侧改动都要同步另一侧。
// 过渡对象用 as const 收窄缓动元组，避免被推断成可变数组而丢失长度信息。
// `SUMMARY_ROLL_TOTAL_MS` 对外导出，测试与调用方可按两个常量相加推导单拍总时长。
// 300ms 滚动加 500ms 停留构成 800ms 一拍，队列节拍完全由它决定。
export const SUMMARY_ROLL_TRANSITION_MS = 300;
export const SUMMARY_ROLL_HOLD_MS = 500;
export const SUMMARY_ROLL_TOTAL_MS = SUMMARY_ROLL_TRANSITION_MS + SUMMARY_ROLL_HOLD_MS;
const SUMMARY_ROLL_TIMER_DRIFT_SKIP_MS = 250;
// 上界取 2 表示除当前显示外最多再缓存两条待播摘要。
// 该上界与入队时的截断共同生效，二者必须保持一致。
// 收紧到 1 会让连续到达的摘要互相覆盖，用户看不到中间态。
// 放宽会让积压变长，主线程恢复后需要更久才能追平最新状态。
// 折中取 `SUMMARY_ROLL_MAX_PENDING = 2`：兼顾可读性与实时性，不要随手调整。
const SUMMARY_ROLL_MAX_PENDING = 2;
const SUMMARY_ROLL_TRANSITION = {
  duration: SUMMARY_ROLL_TRANSITION_MS / 1000,
  ease: [0.4, 0, 0.2, 1],
} as const;

// 统一时间源：优先单调时钟，缺失时退回墙钟。
// 漂移判断只关心差值，因此两种来源在单次会话内可以混用。
// 墙钟在系统时间回拨时可能给出负漂移，语义上等价于未超时。
// 不要在别处另取时间，否则漂移基准不一致，判定会失真。
function getCurrentTimestamp() {
  if (typeof performance !== "undefined") {
    return performance.now();
  }
  return Date.now();
}

// 纯函数，不触碰 ref 与 state，便于单独覆盖漂移分支。
// 漂移超过阈值且队列仍有多条时只保留最后一条，直接丢弃中间态。
// 保留最后一条而非清空，是为了让界面最终落到最新快照而不是空白。
// 阈值判断放在此处而非计时器回调内，保证策略可被独立验证。
// 返回新数组，调用方可以安全地整体替换队列引用。
export function resolveQueuedSummaryPlaybackQueue<T>(
  queuedContent: readonly T[],
  timerDriftMs: number,
): T[] {
  if (timerDriftMs > SUMMARY_ROLL_TIMER_DRIFT_SKIP_MS && queuedContent.length > 1) {
    return queuedContent.slice(-1);
  }
  return [...queuedContent];
}

// 动画开关是三重与：功能启用、未显式禁用、系统未要求减少动效。
// 减少动效优先级最高，只判定一次即可短路后续全部排队逻辑。
// 参数用对象传入，调用处不易把布尔值的顺序写反。
// 该函数被 effect 与渲染分支共用，保持纯函数才能两处结论一致。
export function shouldAnimateQueuedSummaryContent({
  enabled,
  disableAnimation,
  reducedMotion,
}: {
  enabled: boolean;
  disableAnimation?: boolean;
  reducedMotion: boolean;
}) {
  return enabled && disableAnimation !== true && !reducedMotion;
}

// 快照是播放队列的最小单元，承载一条摘要的全部可视字段。
// key 判定是否为同一条摘要，refreshVersion 判定同一条内是否需要原位刷新。
// 三个文本槽位分开存放，渲染时才能让尾部计数脱离滚动容器。
// 接口只描述数据结构，`QueuedSummaryContent` 不承载比较或派生逻辑。
interface SummaryContentSnapshot {
  key: string;
  refreshVersion?: string;
  primaryText: ReactNode;
  secondaryText?: ReactNode;
  trailingText?: ReactNode;
}

// 仅当 key 相同且尾部文本或刷新版本变化时才原位更新。
// 尾部文本用引用比较即可，因为上游每次变化都会产出新节点。
// 刷新版本缺省为空，两侧都缺省时不会被误判为需要刷新。
// 该判定不触发滚动，避免流式正文把整条摘要反复推走。
export function shouldRefreshQueuedSummaryContent(
  current: Pick<SummaryContentSnapshot, "key" | "refreshVersion" | "trailingText">,
  next: Pick<SummaryContentSnapshot, "key" | "refreshVersion" | "trailingText">,
) {
  return (
    current.key === next.key &&
    (current.trailingText !== next.trailingText || current.refreshVersion !== next.refreshVersion)
  );
}

// 初值固定为 false，服务端渲染阶段不探测浏览器能力。
// effect 内先读一次当前值再注册监听，避免首帧出现状态闪动。
// 优先新式监听接口，缺失时回退旧接口，两条路径都要返回清理函数。
// 两种接口都不可用说明环境不支持媒体查询，此时静默保持 false。
function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setPrefersReducedMotion(query.matches);
    };
    update();

    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => {
        query.removeEventListener("change", update);
      };
    }

    query.addListener(update);
    return () => {
      query.removeListener(update);
    };
  }, []);

  return prefersReducedMotion;
}

export function QueuedSummaryContent({
  contentKey,
  contentRefreshVersion,
  primaryText,
  secondaryText,
  trailingText,
  enabled,
  disableAnimation = false,
}: {
  contentKey: string;
  contentRefreshVersion?: string;
  primaryText: ReactNode;
  secondaryText?: ReactNode;
  trailingText?: ReactNode;
  enabled: boolean;
  disableAnimation?: boolean;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const shouldAnimate = shouldAnimateQueuedSummaryContent({
    enabled,
    disableAnimation,
    reducedMotion,
  });
  const createSnapshot = (): SummaryContentSnapshot => ({
    key: contentKey,
    refreshVersion: contentRefreshVersion,
    primaryText,
    secondaryText,
    trailingText,
  });
  // 惰性初始化只执行一次，后续渲染不会重建初始快照。
  // 显示快照是渲染真源，其 ref 是 effect 内可即时读取的镜像。
  // 队列与计时器都用 ref 持有，避免每次入队引发多余重渲染。
  // 写入时必须两侧同时更新，否则 effect 里会拿到过期快照。
  const [displayedContent, setDisplayedContent] = useState(createSnapshot);
  const displayedContentRef = useRef(displayedContent);
  const queuedContentRef = useRef<SummaryContentSnapshot[]>([]);
  const animationTimerRef = useRef<number | null>(null);
  const isAnimatingRef = useRef(false);

  useEffect(() => {
    displayedContentRef.current = displayedContent;
  }, [displayedContent]);

  useEffect(() => {
    const clearAnimationTimer = () => {
      if (animationTimerRef.current !== null) {
        window.clearTimeout(animationTimerRef.current);
        animationTimerRef.current = null;
      }
    };
    const enqueue = (snapshot: SummaryContentSnapshot) => {
      const queue = queuedContentRef.current;
      const existingIndex = queue.findIndex((item) => item.key === snapshot.key);
      if (existingIndex >= 0) {
        // 文件摘要正在等待播放时，持续到达的 diff 只更新同一快照，不能因为 key 去重
        // 留下最早的 +N/-N，也不能为每次数值变化新增整条滚动项。
        const nextQueue = [...queue];
        nextQueue[existingIndex] = snapshot;
        queuedContentRef.current = nextQueue;
        return;
      }

      if (queue.length === 0) {
        queuedContentRef.current = [snapshot];
        return;
      }

      // 摘要滚动总共只能有三格：当前显示、下一条、可插队条。
      // queuedContentRef 只保存后两格；第二条不能被覆盖，新摘要只能替换第三格。
      queuedContentRef.current = [queue[0]!, snapshot].slice(0, SUMMARY_ROLL_MAX_PENDING);
    };
    const promote = (snapshot: SummaryContentSnapshot) => {
      displayedContentRef.current = snapshot;
      setDisplayedContent(snapshot);
      isAnimatingRef.current = true;
      clearAnimationTimer();
      const expectedTimerAt = getCurrentTimestamp() + SUMMARY_ROLL_TOTAL_MS;
      animationTimerRef.current = window.setTimeout(() => {
        isAnimatingRef.current = false;
        animationTimerRef.current = null;
        const queuedContent = queuedContentRef.current;
        const timerDrift = getCurrentTimestamp() - expectedTimerAt;
        // 主线程繁忙时 timeout 会晚到；如果继续逐条补播旧摘要，
        // 用户会在卡顿恢复后看到过期状态排队播放，体感上会更卡。
        const nextQueue = resolveQueuedSummaryPlaybackQueue(queuedContent, timerDrift);
        const [nextQueued, ...restQueued] = nextQueue;
        if (!nextQueued) {
          queuedContentRef.current = [];
          return;
        }
        queuedContentRef.current = restQueued;
        promote(nextQueued);
      }, SUMMARY_ROLL_TOTAL_MS);
    };
    const nextContent = createSnapshot();

    if (!shouldAnimate) {
      clearAnimationTimer();
      isAnimatingRef.current = false;
      queuedContentRef.current = [];
      displayedContentRef.current = nextContent;
      setDisplayedContent(nextContent);
      return;
    }

    if (displayedContentRef.current.key === nextContent.key) {
      // 同一 Changes child 的 diff 和同一 streaming Assistant message 都不能重播整条摘要；
      // 前者更新尾部计数，后者用显式 version 原位刷新正文。
      if (shouldRefreshQueuedSummaryContent(displayedContentRef.current, nextContent)) {
        displayedContentRef.current = nextContent;
        setDisplayedContent(nextContent);
      }
      return;
    }

    if (isAnimatingRef.current) {
      enqueue(nextContent);
      return;
    }

    if (queuedContentRef.current.length > 0) {
      enqueue(nextContent);
      return;
    }

    promote(nextContent);
  }, [contentKey, contentRefreshVersion, shouldAnimate, trailingText]);

  useEffect(() => {
    return () => {
      if (animationTimerRef.current !== null) {
        window.clearTimeout(animationTimerRef.current);
      }
    };
  }, []);

  if (!shouldAnimate) {
    return (
      <>
        {primaryText}
        {secondaryText}
        {trailingText}
      </>
    );
  }

  return (
    <span className="relative inline-flex min-w-0 items-center gap-2 overflow-hidden align-middle">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={displayedContent.key}
          className="inline-flex min-w-0 items-center gap-2"
          initial={{ y: "0.8em", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: "-0.8em", opacity: 0 }}
          transition={SUMMARY_ROLL_TRANSITION}
        >
          {displayedContent.primaryText}
          {displayedContent.secondaryText}
        </motion.span>
      </AnimatePresence>
      {/* 修复原因：Changes 的 diff count 必须与文件摘要属于同一排队快照，
          但数字自身继续用 FlipMetricValue 独立翻动，不能跟整条摘要一起纵向滚走。 */}
      {displayedContent.trailingText}
    </span>
  );
}
