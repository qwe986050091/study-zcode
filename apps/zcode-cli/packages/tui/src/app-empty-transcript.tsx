// 空会话 Logo（L2）：会话还没有消息时在转录区中心展示 ZCODE ASCII 大字。
// animated=true 时每帧由 useShimmerFrame 驱动高光扫过；否则静态渲染，零动画开销。
// 纯展示组件，不读取任何业务状态。
import React from "react";
import { palette } from "./app-model.js";
import { ShimmerText, useShimmerFrame } from "./app-motion.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// 6 行等宽 ASCII 艺术字：必须保持每行显示宽度一致，否则居中会错位；行数同时作为最小高度。
export const ZCODE_LOGO_LINES = [
  "███████╗ ██████╗ ██████╗ ██████╗ ███████╗",
  "   ███╔╝██╔════╝██╔═══██╗██╔══██╗██╔════╝",
  "  ███╔╝ ██║     ██║   ██║██║  ██║█████╗  ",
  " ███╔╝  ██║     ██║   ██║██║  ██║██╔══╝  ",
  "███████╗╚██████╗╚██████╔╝██████╔╝███████╗",
  "╚══════╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
] as const;

const EMPTY_TRANSCRIPT_LOGO_MIN_HEIGHT = ZCODE_LOGO_LINES.length;

// 组件无业务 props，animated 只切换渲染路径；两种路径输出的行数与显示宽度完全一致。
// 动画子组件单独订阅帧，静态模式不会挂载任何定时器。
// 渲染 Logo。animated 默认 false：只出一帧静态文本，避免无谓的动画循环；
// true 时挂载内部动画组件（hook 不能在条件分支里调用，所以拆成子组件）。
export function EmptyTranscriptLogo({
  animated = false,
}: {
  animated?: boolean;
} = {}): React.ReactElement {
  if (animated) {
    return h(AnimatedEmptyTranscriptLogo);
  }
  return renderLogoContent({ animated: false });
}

// 动画版本：订阅 shimmer 帧号，把 frameMs 透传给每一行文本。
function AnimatedEmptyTranscriptLogo(): React.ReactElement {
  const frameMs = useShimmerFrame(true);
  return renderLogoContent({ animated: true, frameMs });
}

// 居中容器：flexGrow 占满剩余高度，minHeight 为 Logo 行数；逐行渲染（key 用行下标）。
function renderLogoContent(input: { animated: boolean; frameMs?: number }): React.ReactElement {
  return h(
    "box",
    {
      style: {
        alignItems: "center",
        flexDirection: "column",
        flexGrow: 1,
        justifyContent: "center",
        minHeight: EMPTY_TRANSCRIPT_LOGO_MIN_HEIGHT,
        width: "100%",
      },
    },
    ...ZCODE_LOGO_LINES.map((line, index) =>
      renderLogoText({
        animated: input.animated,
        baseColor: palette.accent,
        frameMs: input.frameMs,
        key: `zcode-logo-${index}`,
        text: line,
      }),
    ),
  );
}

// 单行渲染：静态直接用 accent 色；动画交给 ShimmerText（accent 为基色、palette.text 为高光）。
// frameMs 缺省时由 ShimmerText 自行驱动。
function renderLogoText(input: {
  animated: boolean;
  baseColor: string;
  frameMs?: number;
  key: string;
  text: string;
}): React.ReactElement {
  if (!input.animated) {
    return h("text", { key: input.key, style: { fg: input.baseColor } }, input.text);
  }
  return h(ShimmerText, {
    animated: true,
    baseColor: input.baseColor,
    frameMs: input.frameMs,
    highlightColor: palette.text,
    key: input.key,
    text: input.text,
  });
}
