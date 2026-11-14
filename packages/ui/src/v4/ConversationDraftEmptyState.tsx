/**
 * 草稿态空态问候：时间问候语 + ZCode Logo。
 * 自旧版 ChatView/ChatViewEmptyState.tsx 恢复（该组件随旧 ChatView 删除，
 * i18n key `chat.empty.greeting.*` 一直保留）；边界时刻自动换档逻辑保真。
 * 手机远控复用同一组件，但继续保留 20px 紧凑标题；桌面草稿首页才按标题自身宽度适配。
 */
// 职责边界（ConversationDraftEmptyState）：草稿首页的空态问候，只负责「现在该说哪句」与「这句该多大」。
// 不做：不发会话、不读 store、不碰输入框；文案全部来自 i18n，组件内不留中文兜底。
//
// INV 不变量表（18 条；每条都是看起来能改、其实一动就出用户可见故障的约束）
// INV-01 问候档位只有 6 个，全部由 chat.empty.greeting.* 这套 key 承载；守住位置：ChatEmptyGreetingMessageId 联合类型；改错故障：新增时段却没补 key，界面回退成原始 key 文本或空串。
// INV-02 边界小时表必须升序，且首项 5 恰好是凌晨档的收尾；守住位置：GREETING_BOUNDARY_HOURS 常量；改错故障：跨夜回退找不到正确起点，凌晨 0 到 4 点迟迟不换档。
// INV-03 分段判断按时间自早到晚串联，最后一个分支兜住 23 点到次日 5 点；守住位置：getChatEmptyGreetingMessageId 的分支顺序；改错故障：顺序打乱后重叠区间被前一条吃掉，深夜显示傍晚问候。
// INV-04 区间左闭右开，相邻档位不重叠也不留缝；守住位置：每条小时比较的两个等号；改错故障：整点 9 点命中两档，或漏掉等号导致 12 点整仍显示上午问候。
// INV-05 下次换档只取严格晚于当前时刻的边界，同刻边界不算；守住位置：getNextChatEmptyGreetingDelayMs 的筛选条件；改错故障：恰在边界触发时算出 0 延迟，定时器自激空转。
// INV-06 明天首个边界读表首项，不写死 5 点；守住位置：tomorrowFirstBoundary 的小时取值；改错故障：表首项调整后跨夜回退仍指 5 点，凌晨档永久错过一次切换。
// INV-07 延迟下限恒为 1 毫秒，任何情况下不得为 0 或负数；守住位置：差值返回前的下限夹取；改错故障：时钟回拨或同刻命中时定时器立即回调，组件陷入重渲染死循环。
// INV-08 字号解析是纯函数，不读 DOM、不读 state；守住位置：resolveGreetingFontSizePx；改错故障：掺入外部状态后同一输入得到不同字号，测量与渲染互相触发抖动。
// INV-09 手机远控恒用 20px 紧凑档，且不参与宽度测量；守住位置：resolveGreetingFontSizePx 与 useLayoutEffect 的首个分支；改错故障：远控窄屏把标题压得更小，或测量把字号改回桌面值。
// INV-10 宽度非法、非有限、非正，或可用宽度已够宽时一律回 30px；守住位置：resolveGreetingFontSizePx 的早退条件；改错故障：NaN 参与比大小得到 NaN 字号，CSS 变量失效后标题退回默认大小。
// INV-11 缩放比例夹在 20 到 30 之间，且先向下取整再夹；守住位置：floor 与外层 max/min 的嵌套顺序；改错故障：夹取顺序颠倒后出现 19px 或 31px 这类越界字号。
// INV-12 问候时间只在挂载时取一次当前时刻，之后由定时器推进；守住位置：greetingDate 的惰性初始化；改错故障：渲染期直接取时钟会让每次重渲染都换档，文案随窗口尺寸变化莫名跳变。
// INV-13 办公模式覆盖时间档位，优先级高于分段函数；守住位置：formatMessage 的 id 三元；改错故障：办公模式仍按小时问候，与产品约定的统一文案冲突。
// INV-14 换档定时器的依赖里必须有 greetingDate，清理必须清掉旧定时器；守住位置：useEffect 的依赖数组与返回函数；改错故障：依赖漏项导致只换一次档，旧定时器残留则出现多份计时。
// INV-15 字号只在文案或紧凑模式变化时重算，greeting 必须在依赖里；守住位置：useLayoutEffect 的依赖数组；改错故障：切语言后长文案仍沿用旧字号，文字溢出容器。
// INV-16 同值不写回，函数式更新里相等就原样返回；守住位置：setGreetingFontSizePx 的回调；改错故障：尺寸观察每帧回调都触发重渲染，滚动时明显掉帧。
// INV-17 动画帧句柄同一帧内只排一次，卸载时必须取消；守住位置：scheduleMeasure 与两处清理；改错故障：尺寸连续变化时排队多次测量，卸载后仍回调已销毁节点。
// INV-18 测量副本必须与正文同文案、绝对定位、不占布局，并对辅助技术隐藏；守住位置：greetingMeasurementRef 绑定的 span；改错故障：副本换行后量到的宽度偏小，字号被误缩，或读屏把同一句问候念两遍。
//
// 总述：收益集中在两件事上，问候档位可预测，字号只在真实碰撞时收缩。
// 总述：加时段先改时间表与 i18n，改尺寸先改夹取区间，别在渲染里补逻辑。
//
import {
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import darkEmptyStateLogoUrl from "@/assets/Z.svg";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { logger } from "@/logger.js";

// 6 个边界把一天切成 6 段，5 点到 23 点按序排列，最后一段跨到次日 5 点。
// 这张表同时服务分段判断与换档定时，两处共用一份顺序，不各自维护。
// [权衡] 首项 5 兼作凌晨档终点，跨夜回退读表首项而非写死数字。
const GREETING_BOUNDARY_HOURS = [5, 9, 12, 14, 18, 23] as const;
const GREETING_MIN_FONT_SIZE_PX = 20;
const GREETING_MAX_FONT_SIZE_PX = 30;

// 联合类型把 6 个 i18n key 收敛成封闭集合，新增时段必须同时改这里。
// 类型只保证编译期不漏写，字典缺词要等到真的进入该时段才暴露。
// [失败路径] 少写一格会被 TypeScript 拦住，多写一格则可能指向不存在的词条。
export type ChatEmptyGreetingMessageId =
  | "chat.empty.greeting.morningEarly"
  | "chat.empty.greeting.morning"
  | "chat.empty.greeting.noon"
  | "chat.empty.greeting.afternoon"
  | "chat.empty.greeting.evening"
  | "chat.empty.greeting.lateNight";

// 纯函数：只看传入日期的本地小时，不读时钟也不读区域，便于单测固定时间。
// date = new Date() 只是让组件侧少建一个临时变量，不改变纯函数性质。
// 返回值直接当 i18n key 用，中间不再加工，避免两次映射对不上。
export function getChatEmptyGreetingMessageId(
  date: Date = new Date(),
): ChatEmptyGreetingMessageId {
  const hour = date.getHours();

  // hour >= 5 && hour < 9 是首条分支，hour < 5 与 hour >= 23 都落到末条 lateNight 兜底。
  // [权衡] 用连续 if 判断而非查 GREETING_BOUNDARY_HOURS 表，区间语义在代码里一眼可读。
  if (hour >= 5 && hour < 9) return "chat.empty.greeting.morningEarly";
  if (hour >= 9 && hour < 12) return "chat.empty.greeting.morning";
  if (hour >= 12 && hour < 14) return "chat.empty.greeting.noon";
  if (hour >= 14 && hour < 18) return "chat.empty.greeting.afternoon";
  if (hour >= 18 && hour < 23) return "chat.empty.greeting.evening";

  return "chat.empty.greeting.lateNight";
}

// 在当天 6 个边界里找第一个晚于当前时刻的，命中即是下次换档点。
// 当天边界全部过去时把日期推到明天再取表首项，覆盖 23 点之后的长夜。
// [资源] 每次只算下一个边界，所以档位一变就得由 effect 重新挂 setTimeout。
export function getNextChatEmptyGreetingDelayMs(date: Date = new Date()) {
  const candidates = GREETING_BOUNDARY_HOURS.map((hour) => {
    const boundary = new Date(date);
    boundary.setHours(hour, 0, 0, 0);
    return boundary;
  });
  const tomorrowFirstBoundary = new Date(date);
  tomorrowFirstBoundary.setDate(tomorrowFirstBoundary.getDate() + 1);
  tomorrowFirstBoundary.setHours(GREETING_BOUNDARY_HOURS[0], 0, 0, 0);

  const nextBoundary =
    candidates.find((candidate) => candidate.getTime() > date.getTime()) ??
    tomorrowFirstBoundary;

  // 时钟回拨或恰好落在边界时差值为 0 甚至为负，这里兜住不退化成 0 毫秒。
  // [失败路径] 一旦返回 0，定时器立刻回调，更新 state 又排下一次，形成自激循环。
  return Math.max(1, nextBoundary.getTime() - date.getTime());
}

// 纯几何计算：给定可用宽度与文案自然宽度，给出 20 到 30 之间的字号。
// 可用宽度不小于自然宽度说明 30px 也放得下，直接取上限，不做无谓缩小。
// [权衡] 按 availableWidthPx 与 naturalTextWidthPx 的比例线性缩放并 Math.floor，宁可小一像素。
export function resolveGreetingFontSizePx({
  availableWidthPx,
  naturalTextWidthPx,
  compactForRemoteControl = false,
}: {
  availableWidthPx: number;
  naturalTextWidthPx: number;
  compactForRemoteControl?: boolean;
}) {
  // compactForRemoteControl 为真时先命中这条，后面的宽度判断与缩放都不再生效。
  // [权衡] 远控界面信息密度优先，固定 20px 比按宽度适配更稳定。
  if (compactForRemoteControl) {
    return GREETING_MIN_FONT_SIZE_PX;
  }
  if (
    !Number.isFinite(availableWidthPx) ||
    !Number.isFinite(naturalTextWidthPx) ||
    availableWidthPx <= 0 ||
    naturalTextWidthPx <= 0 ||
    availableWidthPx >= naturalTextWidthPx
  ) {
    return GREETING_MAX_FONT_SIZE_PX;
  }

  return Math.max(
    GREETING_MIN_FONT_SIZE_PX,
    Math.min(
      GREETING_MAX_FONT_SIZE_PX,
      Math.floor(
        GREETING_MAX_FONT_SIZE_PX * (availableWidthPx / naturalTextWidthPx),
      ),
    ),
  );
}

// 状态只有两个：当前问候时刻与当前字号，其余全是派生值，不留第二份真相。
// className 由调用方透传用于外部布局微调，组件不假设自己在页面中的位置。
// 紧凑开关也由调用方决定，组件不自行探测设备，避免同一窗口出现两套判断。
export function ConversationDraftEmptyState({
  className,
  compactForRemoteControl = false,
}: {
  className?: string;
  compactForRemoteControl?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  // 初始时刻在挂载时取一次，惰性初始化避免每次重渲染都新建日期对象。
  // [并发] 渲染期间不读实时时钟，greetingDate 只由 setTimeout 推进。
  const [greetingDate, setGreetingDate] = useState(() => new Date());
  const [greetingFontSizePx, setGreetingFontSizePx] = useState(
    GREETING_MAX_FONT_SIZE_PX,
  );
  const greetingContainerRef = useRef<HTMLParagraphElement | null>(null);
  const greetingMeasurementRef = useRef<HTMLSpanElement | null>(null);
  // 办公模式优先于时间档位，命中后不再调用分段函数，两条来源互斥。
  // 问候语只在这里取值，渲染与测量共用同一字符串，不会两边不一致。
  // [失败路径] 字典缺词交由 intl 层回退，组件内不写死中文兜底。
  const greeting = intl.formatMessage({
    id: isOfficeMode
      ? "chat.empty.greeting.office"
      : getChatEmptyGreetingMessageId(greetingDate),
  });

  // 按当前时刻算出到下一个边界的毫秒数，到点把问候时间推进到新的当前时刻。
  // 推进后依赖变化，effect 重跑并排下下一次定时，形成跨天不断档的链条。
  // [资源] 清理函数清掉未触发的定时器，换档与卸载都不会留下孤儿计时。
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setGreetingDate(new Date());
    }, getNextChatEmptyGreetingDelayMs(greetingDate));

    return () => {
      window.clearTimeout(timeout);
    };
  }, [greetingDate]);

  // 测量放在 useLayoutEffect 里：先量容器可用宽度与隐藏副本自然宽度，再算字号。
  // 容器宽度要扣掉左右内边距，避免把 padding 算进文字可用的横向空间。
  // [权衡] 双观察点分别盯容器与 30px 副本，只有两者真的相撞才缩小字号。
  useLayoutEffect(() => {
    if (compactForRemoteControl) {
      setGreetingFontSizePx(GREETING_MIN_FONT_SIZE_PX);
      return;
    }
    const container = greetingContainerRef.current;
    const measurement = greetingMeasurementRef.current;
    if (!container || !measurement) {
      return;
    }

    let frameId: number | null = null;
    const measure = () => {
      frameId = null;
      const containerStyle = window.getComputedStyle(container);
      const horizontalPaddingPx =
        Number.parseFloat(containerStyle.paddingLeft) +
        Number.parseFloat(containerStyle.paddingRight);
      const availableWidthPx = Math.max(
        0,
        container.getBoundingClientRect().width - horizontalPaddingPx,
      );
      const naturalTextWidthPx = measurement.getBoundingClientRect().width;
      const nextFontSizePx = resolveGreetingFontSizePx({
        availableWidthPx,
        naturalTextWidthPx,
      });

      // 用函数式 setGreetingFontSizePx 更新，读到的是最新字号而非闭包旧值。
      // 新字号与当前一致时原样返回，React 据此跳过重渲染，观察回调再密也不抖。
      // 只有确实变化才写日志，日志带两侧宽度与前后字号，便于复盘跳档现场。
      setGreetingFontSizePx((currentFontSizePx) => {
        if (currentFontSizePx === nextFontSizePx) {
          return currentFontSizePx;
        }
        logger.debug("[v4-draft-greeting] 标题自身可用宽度变化，更新字号", {
          availableWidthPx: Math.round(availableWidthPx),
          naturalTextWidthPx: Math.round(naturalTextWidthPx),
          previousFontSizePx: currentFontSizePx,
          nextFontSizePx,
        });
        return nextFontSizePx;
      });
    };
    const scheduleMeasure = () => {
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(measure);
    };

    measure();

    // 环境没有尺寸观察器时退回窗口 resize 事件，能力弱一些但不会直接失效。
    // [失败路径] 这条分支同样要取消动画帧与事件监听，否则降级路径反而更容易泄漏。
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", scheduleMeasure);
      return () => {
        if (frameId !== null) {
          window.cancelAnimationFrame(frameId);
        }
        window.removeEventListener("resize", scheduleMeasure);
      };
    }

    // 标题字号曾直接绑定整个视口宽度，最小窗口里文字两侧仍有大量空间却被
    // 强制缩到 20px。分别观察标题容器和 30px 原始文案，只在两者真实相撞时缩小。
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(container);
    observer.observe(measurement);
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      observer.disconnect();
    };
  }, [compactForRemoteControl, greeting]);

  return (
    <div
      className={cn(
        "relative mb-10 flex w-full max-w-2xl flex-col items-center justify-center gap-6 text-foreground sm:mb-8",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-1/2 top-1/2 aspect-[5/4] w-[min(72vw,25rem)] -mt-10",
          "-translate-x-1/2 -translate-y-1/2 text-foreground-subtlest",
        )}
      >
        <ZCodeEmptyStateLogo className="h-full w-full" />
      </div>
      <p
        ref={greetingContainerRef}
        data-v4-draft-greeting="true"
        style={
          {
            "--v4-draft-greeting-font-size": `${greetingFontSizePx}px`,
          } as CSSProperties
        }
        className={cn(
          "relative z-10 w-full px-4 text-center font-medium text-foreground",
          compactForRemoteControl
            ? "text-xl/[1.2]"
            : "text-[length:var(--v4-draft-greeting-font-size)]/[1.2]",
        )}
      >
        <span
          ref={greetingMeasurementRef}
          aria-hidden="true"
          // 隐藏副本与正文同文案，用 30px 排版量出自然宽度，自身不可见也不拦截指针。
          // [权衡] 副本必须禁止换行，否则量到的是折行后宽度，字号会被系统性低估。
          className="pointer-events-none invisible absolute whitespace-nowrap text-3xl/[1.2]"
        >
          {greeting}
        </span>
        <span>{greeting}</span>
      </p>
    </div>
  );
}

// 浅色线框与深色位图互斥显示，靠 dark 前缀切换，不用脚本判断主题。
// 浅色图用遮罩做自上而下渐隐，深色图已自带渐变，再叠遮罩会重复变淡。
// [无障碍] 两层图形都标了 aria-hidden，图形不参与朗读。
function ZCodeEmptyStateLogo({ className }: { className?: string }) {
  return (
    <>
      {/* 修复原因：夜间资源已自带渐变和透明度，公共容器叠加遮罩会让它重复变淡；渐隐效果只属于浅色线框。 */}
      <svg
        aria-hidden="true"
        className={cn(
          className,
          "opacity-70 dark:hidden",
          "[-webkit-mask-image:linear-gradient(to_bottom,black_0%,transparent_70%,transparent_100%)]",
          "[-webkit-mask-repeat:no-repeat] [-webkit-mask-size:100%_100%]",
          "[mask-image:linear-gradient(to_bottom,black_0%,transparent_70%,transparent_100%)]",
          "[mask-repeat:no-repeat] [mask-size:100%_100%]",
        )}
        width="400"
        height="320"
        viewBox="0 0 400 320"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M398.97 0.5L147.576 319.5H1.03027L37.5996 273.081L120.167 169.603L120.171 169.598L215.342 47.5605L215.343 47.5615L252.424 0.5H398.97ZM264.544 273.271H372.527L336.082 319.498H189.886L202.642 303.307C217.584 284.34 240.398 273.271 264.544 273.271ZM209.164 0.5L202.786 8.58887C183.782 32.6885 154.782 46.752 124.091 46.752H25.9805L62.4268 0.5H209.164Z"
          stroke="currentColor"
        />
      </svg>
      {/* 深色资源包含专用渐变与模糊效果，不能通过 currentColor 复刻；主题类保证两套 Logo 互斥显示。 */}
      <img
        aria-hidden="true"
        className={cn(className, "hidden dark:block")}
        data-v4-draft-logo="dark"
        src={darkEmptyStateLogoUrl}
        alt=""
      />
    </>
  );
}
