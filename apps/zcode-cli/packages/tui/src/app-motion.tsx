// 终端动画原语：微光文本与旋转指示器。
// 职责：按时间戳计算逐字符颜色/帧图标，并提供本地动画时钟 hook。
// 边界：仅视觉装饰，不影响业务状态与布局列宽（旋转器固定 1 列）。
// 副作用：开启动画时每 80ms 触发一次重渲染，关闭或卸载时清理定时器。
// 降级：非 #rrggbb 色值退回二选一取色，不抛错。

import React, { useEffect, useMemo, useState } from "react";
import { palette } from "./app-model.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const SHIMMER_FRAME_INTERVAL_MS = 80;

// 微光扫过一轮的周期（毫秒），进度以“时间 mod 周期”计算，因此动画可跨组件同步。
export const SHIMMER_SWEEP_PERIOD_MS = 1_800;
// 旋转指示器的换帧间隔（毫秒）。
export const SPINNER_FRAME_INTERVAL_MS = 80;
// 旋转指示器占用的终端列数；固定为 1，保证布局不随图标变化抖动。
export const SPINNER_WIDTH = 1;
const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;
const SHIMMER_PADDING_COLUMNS = 10;
const SHIMMER_BAND_HALF_WIDTH = 5;
const SHIMMER_HIGHLIGHT_STRENGTH = 0.9;
const SHIMMER_HIGHLIGHT_THRESHOLD = 0.35;
const HEX_COLOR_PATTERN = /^#([0-9a-f]{6})$/i;
const HEX_RADIX = 16;
const RGB_MAX = 255;

// 微光文本片段：color 为最终前景色，highlighted 标记是否处于高亮带，text 为单个字符。
// 一个字符一个片段，便于按列独立着色；片段总数等于字符数（Array.from 计 Unicode 码点）。
type ShimmerTextSegment = {
  color: string;
  highlighted: boolean;
  text: string;
};

// RGB 三通道（0-255），仅用于颜色插值；非 #rrggbb 输入不会构造该结构。
type RgbColor = {
  b: number;
  g: number;
  r: number;
};

// 渲染带扫光效果的文本（如“思考中”提示）。
// 输入：animated=false 时直接输出单个 text 节点，不做逐字拆分也不启动计时器；
// frameMs 缺省时由内部 useShimmerFrame 驱动，传入则由调用方提供统一时钟。
// 输出：始终返回 React 元素；text 为空串时 animated 分支会得到空 box（无子节点）。
// 副作用：animated 且未提供 frameMs 时注册 80ms 定时器，卸载或关闭动画时清理。
// 降级语义：颜色非 #rrggbb 时 blendHexColor 退回二选一取色，不抛错。
export function ShimmerText({
  animated,
  baseColor = palette.accent,
  frameMs,
  highlightColor = palette.text,
  text,
}: {
  animated: boolean;
  baseColor?: string;
  frameMs?: number;
  highlightColor?: string;
  text: string;
}): React.ReactElement {
  const localFrameMs = useShimmerFrame(animated && frameMs === undefined);
  const effectiveFrameMs = frameMs ?? localFrameMs;
  const segments = useMemo(
    () =>
      animated
        ? shimmerTextSegments(text, effectiveFrameMs, { baseColor, highlightColor })
        : [{ color: baseColor, highlighted: false, text }],
    [animated, baseColor, effectiveFrameMs, highlightColor, text],
  );

  if (!animated) {
    return h("text", { style: { fg: baseColor } }, text);
  }

  return h(
    "box",
    {
      style: {
        flexDirection: "row",
      },
    },
    ...segments.map((segment, index) =>
      h(
        "text",
        {
          key: `shimmer-${index}`,
          style: { fg: segment.color },
        },
        segment.text,
      ),
    ),
  );
}

// 计算某一帧下每个字符的颜色，纯函数便于单测与复用。
// 输入：text 任意文本；frameMs 为当前时间戳（毫秒），可任意大；options 缺省时取主题 accent/text。
// 输出：长度等于 Unicode 码点数的片段数组；空文本返回空数组（调用方需处理空渲染）。
// 算法：在字符序列两侧各加 10 列留白后，用时间进度在扩展序列上定位扫光中心，
// 距离中心越近亮度越高，超过半宽（5 列）即回到基色。
// 副作用：无；不依赖 Date.now，帧值由调用方提供。
export function shimmerTextSegments(
  text: string,
  frameMs: number,
  options: {
    baseColor?: string;
    highlightColor?: string;
  } = {},
): ShimmerTextSegment[] {
  const chars = Array.from(text);
  if (chars.length === 0) return [];

  const baseColor = options.baseColor ?? palette.accent;
  const highlightColor = options.highlightColor ?? palette.text;
  const period = chars.length + SHIMMER_PADDING_COLUMNS * 2;
  const sweepPosition = Math.floor(
    (positiveModulo(frameMs, SHIMMER_SWEEP_PERIOD_MS) / SHIMMER_SWEEP_PERIOD_MS) * period,
  );

  return chars.map((char, index) => {
    const position = index + SHIMMER_PADDING_COLUMNS;
    const distance = Math.abs(position - sweepPosition);
    const intensity = shimmerIntensity(distance);
    return {
      color: colorForIntensity(baseColor, highlightColor, intensity),
      highlighted: intensity >= SHIMMER_HIGHLIGHT_THRESHOLD,
      text: char,
    };
  });
}

// 微光动画时钟：返回最近一次刷新的时间戳（毫秒），未启用时不注册定时器。
// 副作用：animated 为 true 时每 80ms setState 一次以触发重渲染（高频但仅在动画期间）；
// 关闭动画或卸载时 clearInterval；关闭后返回值停止更新但仍是合法数值。
export function useShimmerFrame(animated: boolean): number {
  const [frameMs, setFrameMs] = useState(() => Date.now());

  useEffect(() => {
    if (!animated) return undefined;
    const timer = setInterval(() => {
      setFrameMs(Date.now());
    }, SHIMMER_FRAME_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [animated]);

  return frameMs;
}

// 返回图标字符而非帧号，未启用时也返回首帧 "⠋"，调用方可无条件渲染。
// 与 useShimmerFrame 各自维护独立 interval，同一组件同时使用会产生两个定时器。
// 旋转指示器：返回当前帧的图标字符，未启用时返回固定首帧（不注册定时器）。
// 副作用：animated 为 true 时每 80ms 更新一次时间戳，驱动逐帧重渲染。
export function useSpinnerFrame(animated: boolean): string {
  const [frameMs, setFrameMs] = useState(() => Date.now());

  useEffect(() => {
    if (!animated) return undefined;
    const timer = setInterval(() => {
      setFrameMs(Date.now());
    }, SPINNER_FRAME_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [animated]);

  return spinnerFrame(frameMs);
}

// 结果只依赖时间戳，不依赖调用顺序，因此不同组件在同一时刻会得到相同图标。
// 帧序列长度变化会改变整个周期，调用方不应假定固定的 800ms 循环。
// 由时间戳选取旋转帧：10 帧循环，每帧 80ms；下标越界（理论上不会）回落到首帧。
// 使用正模运算，负数/极大时间戳也能得到合法下标。
export function spinnerFrame(frameMs: number): string {
  const periodMs = SPINNER_FRAME_INTERVAL_MS * SPINNER_FRAMES.length;
  const frameIndex = Math.floor(positiveModulo(frameMs, periodMs) / SPINNER_FRAME_INTERVAL_MS);
  return SPINNER_FRAMES[frameIndex] ?? SPINNER_FRAMES[0];
}

function shimmerIntensity(distance: number): number {
  if (distance > SHIMMER_BAND_HALF_WIDTH) return 0;
  const x = Math.PI * (distance / SHIMMER_BAND_HALF_WIDTH);
  return 0.5 * (1 + Math.cos(x));
}

function colorForIntensity(baseColor: string, highlightColor: string, intensity: number): string {
  if (intensity <= 0) return baseColor;
  return blendHexColor(baseColor, highlightColor, intensity * SHIMMER_HIGHLIGHT_STRENGTH);
}

function blendHexColor(baseColor: string, highlightColor: string, amount: number): string {
  const base = parseHexColor(baseColor);
  const highlight = parseHexColor(highlightColor);
  if (!base || !highlight) {
    return amount >= SHIMMER_HIGHLIGHT_THRESHOLD ? highlightColor : baseColor;
  }
  return rgbToHex({
    r: blendChannel(base.r, highlight.r, amount),
    g: blendChannel(base.g, highlight.g, amount),
    b: blendChannel(base.b, highlight.b, amount),
  });
}

function parseHexColor(value: string): RgbColor | undefined {
  const match = HEX_COLOR_PATTERN.exec(value);
  if (!match) return undefined;
  const hex = match[1] ?? "";
  return {
    r: Number.parseInt(hex.slice(0, 2), HEX_RADIX),
    g: Number.parseInt(hex.slice(2, 4), HEX_RADIX),
    b: Number.parseInt(hex.slice(4, 6), HEX_RADIX),
  };
}

function rgbToHex(color: RgbColor): string {
  return `#${hexChannel(color.r)}${hexChannel(color.g)}${hexChannel(color.b)}`;
}

function hexChannel(value: number): string {
  return Math.round(clamp(value, 0, RGB_MAX)).toString(HEX_RADIX).padStart(2, "0");
}

function blendChannel(base: number, highlight: number, amount: number): number {
  const clampedAmount = clamp(amount, 0, 1);
  return base + (highlight - base) * clampedAmount;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function positiveModulo(value: number, modulo: number): number {
  return ((value % modulo) + modulo) % modulo;
}
