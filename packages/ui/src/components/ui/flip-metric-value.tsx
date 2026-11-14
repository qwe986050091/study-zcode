// INV-01 减少动效时全部静态：守住位置 reducedMotion；改错故障 前庭不适。
// INV-02 服务端渲染无 window：守住位置 typeof 判断；改错故障 SSR 崩溃。
// INV-03 matchMedia 缺失直接返回：守住位置 函数判断；改错故障 旧环境抛错。
// INV-04 新旧监听 API 都兼容：守住位置 addEventListener 判断；改错故障 旧内核不回退。
// INV-05 注册后立即同步一次：守住位置 update 调用；改错故障 首帧使用默认值。
// INV-06 卸载时移除监听：守住位置 两个清理函数；改错故障 监听泄漏。
// INV-07 数字槽宽固定：守住位置 isDigitCharacter；改错故障 数字跳动引发横向抖动。
// INV-08 冒号与点更窄：守住位置 分支；改错故障 时间格式过宽。
// INV-09 其余字符统一宽度：守住位置 默认分支；改错故障 单位挤压。
// INV-10 非数字不走翻转：守住位置 早退；改错故障 单位也被翻页。
// INV-11 槽高固定并居中：守住位置 固定高度类；改错故障 基线错位。
// INV-12 翻页只在槽内裁切：守住位置 overflow-hidden；改错故障 字符越界。
// INV-13 键含索引与字符：守住位置 key 拼接；改错故障 同字符重复触发动效。
// INV-14 初始动画可关闭：守住位置 animateInitial；改错故障 首屏闪烁。
// INV-15 字符按码点拆分：守住位置 Array.from；改错故障 emoji 被拆断。
// INV-16 可访问名称取完整值：守住位置 aria-label；改错故障 读屏逐字念。
// INV-17 值同时作为标题：守住位置 title；改错故障 截断后无法查看全值。
// INV-18 容器不换行且裁切：守住位置 whitespace-nowrap；改错故障 指标换行撑高。
//
// 模块职责：把指标字符串逐字符渲染为可翻页的固定宽度槽位。
// 状态所有权：减少动效偏好由媒体查询派生，其余全部来自 props。
// 阅读顺序：先看媒体查询，再看字符宽度，最后看两个组件。
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/components/lib/utils.js";

const FLIP_TRANSITION = {
  duration: 0.16,
  ease: [0.4, 0, 0.2, 1],
} as const;

// SSR 时 typeof window 为 undefined，直接 return 不注册监听。
// window.matchMedia 不是函数时同样直接 return。
// 注册监听后立即调用 update() 同步首帧值。
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

function isDigitCharacter(character: string) {
  return /^[0-9]$/.test(character);
}

// isDigitCharacter 为真时用 w-[0.66em] 固定槽宽。
// character 为 ":" 或 "." 时用 w-[0.34em]。
// 其余字符统一 w-[0.7em]，保证单位不挤压。
function getCharacterWidthClass(character: string) {
  if (isDigitCharacter(character)) {
    return "w-[0.66em]";
  }
  if (character === ":" || character === ".") {
    return "w-[0.34em]";
  }
  return "w-[0.7em]";
}

// 非数字字符或 reducedMotion 为真时直接静态渲染。
// 静态与翻转两条路径都用 h-[1.15em] 固定槽高并居中。
// overflow-hidden 只作用在槽元素，翻页不越出槽外。
function MetricCharacter({
  character,
  index,
  reducedMotion,
  animateInitial,
}: {
  character: string;
  index: number;
  reducedMotion: boolean;
  animateInitial: boolean;
}) {
  const widthClass = getCharacterWidthClass(character);

  // 数字槽以前用 baseline + 负偏移，冒号和 K/M 单位走静态 inline，
  // 混排时视觉中线不一致；所有字符统一固定高度并居中，翻页只发生在槽内。
  if (!isDigitCharacter(character) || reducedMotion) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex h-[1.15em] shrink-0 items-center justify-center leading-none",
          widthClass,
        )}
      >
        {character}
      </span>
    );
  }

  // 外层 span 用 inline-flex 与 whitespace-nowrap 禁止换行。
  // overflow-hidden 裁掉超出槽宽的部分。
  // 槽内只渲染单个 character，不在此处截断内容。
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex h-[1.15em] shrink-0 items-center justify-center overflow-hidden leading-none [perspective:8em]",
        widthClass,
      )}
    >
      <AnimatePresence initial={animateInitial}>
        <motion.span
          key={`${index}-${character}`}
          className="absolute inset-0 flex items-center justify-center leading-none"
          initial={{ rotateX: -90, y: "-0.45em", opacity: 0 }}
          animate={{ rotateX: 0, y: 0, opacity: 1 }}
          exit={{ rotateX: 90, y: "0.45em", opacity: 0 }}
          style={{ transformOrigin: "50% 50%" }}
          transition={FLIP_TRANSITION}
        >
          {character}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

// reducedMotion 为真时 MetricCharacter 全部走静态分支。
// Array.from(value) 按码点拆分，避免 emoji 被拆断。
// aria-label 取原始 value，读屏不会逐字念。
// animateInitial 默认 false，AnimatePresence 不做首屏动画。
export function FlipMetricValue({
  value,
  className,
  animateInitial = false,
}: {
  value: string;
  className?: string;
  animateInitial?: boolean;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const characters = useMemo(() => Array.from(value), [value]);

  return (
    <span
      aria-label={value}
      data-animate-initial={animateInitial ? "true" : undefined}
      className={cn(
        "inline-flex max-w-full items-center overflow-hidden whitespace-nowrap align-middle leading-none",
        className,
      )}
      role="text"
      title={value}
    >
      {characters.map((character, index) => (
        <MetricCharacter
          key={index}
          character={character}
          index={index}
          reducedMotion={reducedMotion}
          animateInitial={animateInitial}
        />
      ))}
    </span>
  );
}
