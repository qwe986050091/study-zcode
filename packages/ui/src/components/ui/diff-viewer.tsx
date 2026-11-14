// INV-01 输入形态由是否存在补丁字段判定：守住位置 补丁形态判断；改错故障 两种模式同时渲染。
// INV-02 两种形态的必填字段互斥：守住位置 联合类型；改错故障 调用方同时传补丁与文件内容。
// INV-03 补丁模式使用简易分隔符：守住位置 分隔符分支；改错故障 出现无法展开的未修改行。
// INV-04 多文件模式保留可展开提示：守住位置 分隔符分支另一侧；改错故障 用户无法展开上下文。
// INV-05 统一使用内联差异与条形指示：守住位置 样式与指示选项；改错故障 视图风格随调用方漂移。
// INV-06 文件头固定隐藏，由外层提供标题：守住位置 文件头开关；改错故障 出现重复文件名。
// INV-07 溢出统一滚动而不是换行：守住位置 溢出选项；改错故障 长行把布局撑宽。
// INV-08 主题只在外层同时提供明暗两套时生效：守住位置 三元判断；改错故障 半套主题导致渲染异常。
// INV-09 首选高亮器来自共享常量：守住位置 高亮器选项；改错故障 两次渲染使用不同引擎。
// INV-10 调用方选项最后展开，可覆盖默认值：守住位置 展开顺序；改错故障 默认值反过来覆盖调用方。
// INV-11 字号注入到阴影内样式变量：守住位置 视图样式；改错故障 阴影内字号不跟随外层。
// INV-12 字体族固定为等宽变量：守住位置 字体变量；改错故障 代码在阴影内变成非等宽。
// INV-13 背景三套变量都对齐外层背景：守住位置 三个背景变量；改错故障 明暗切换闪白。
// INV-14 自定义样式在默认变量之后合并：守住位置 展开顺序；改错故障 调用方无法覆盖字号。
// INV-15 外层容器必须占满可用高度并自行滚动：守住位置 根容器类名；改错故障 出现嵌套滚动条。
// INV-16 非差异属性必须透传到根容器：守住位置 两组属性剔除函数；改错故障 无障碍属性与事件处理器丢失。
// INV-17 组件使用记忆化包装：守住位置 导出方式；改错故障 父级重渲染触发全量差异重算。
// INV-18 显示名固定用于调试：守住位置 显示名赋值；改错故障 性能面板出现匿名组件。
//
// 模块职责：统一渲染补丁或多文件差异，并隔离差异库阴影内外的样式差异。
// 状态所有权：无状态；主题、选项与选中行全部来自入参。
// 阅读顺序：先看形态判定与样式变量，再读差异选项，最后看两种模式的节点与属性透传。
"use client";

import type { CSSProperties, HTMLAttributes } from "react";
import { memo, useMemo } from "react";
import type { BundledTheme } from "shiki";
import type { FileContents, FileDiffOptions } from "@pierre/diffs";
import { MultiFileDiff, PatchDiff } from "@pierre/diffs/react";

import { cn } from "@/components/lib/utils.js";
import { DIFFS_PREFERRED_HIGHLIGHTER } from "@/lib/diffsHighlighterEngine.js";

type DiffViewerStyle = CSSProperties & {
  "--diffs-bg"?: string;
  "--diffs-light-bg"?: string;
  "--diffs-dark-bg"?: string;
  "--diffs-font-family"?: string;
  "--diffs-font-size"?: string;
};

// DIFF_VIEWER_UNSAFE_CSS 保持空串：@pierre/diffs 的 code 节点运行在 Shadow DOM 内，外层 Tailwind class 命中不了，
// 唯一能覆盖的入口就是 FileDiffOptions.unsafeCSS；当前没有需要覆盖的内部样式，所以先留空而不是堆积死规则；
// 将来要改也只做最小范围，PatchDiff 与 MultiFileDiff 共用同一个常量。
const DIFF_VIEWER_UNSAFE_CSS = ``;

type DiffViewerPatchInput = {
  patch: string;
  oldFile?: never;
  newFile?: never;
};

type DiffViewerMultiFileInput = {
  patch?: never;
  oldFile: FileContents;
  newFile: FileContents;
};

export type DiffViewerProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> &
  (DiffViewerPatchInput | DiffViewerMultiFileInput) & {
    options?: FileDiffOptions<undefined>;
    disableWorkerPool?: boolean;
    diffClassName?: string;
    fontSizePx?: number;
    lightTheme?: BundledTheme;
    darkTheme?: BundledTheme;
    themeType?: "light" | "dark";
    selectedLines?: DiffViewerSelectedLineRange | null;
  };

export interface DiffViewerSelectedLineRange {
  start: number;
  end: number;
  side: "additions" | "deletions";
}

function DiffViewerComponent(props: DiffViewerProps) {
  const rendersPatch = isPatchDiffProps(props);
  const {
    options: optionsOverride,
    disableWorkerPool = false,
    lightTheme,
    darkTheme,
    themeType,
    diffClassName,
    fontSizePx = 12,
    selectedLines,
    className,
    style,
  } = props;
  // viewerStyle 把三个 --diffs*-bg 都指向 var(--color-background)，明暗切换时 Shadow DOM 内不会闪白；
  // --diffs-font-family 用 var(--font-mono)，因为阴影不继承外层 font-mono class；--diffs-font-size 按 fontSizePx 注入；
  // ...style 放在最后，调用方同名变量可覆盖默认值。依赖只有 [fontSizePx, style]。
  const viewerStyle = useMemo<DiffViewerStyle>(
    () => ({
      "--diffs-bg": "var(--color-background)",
      "--diffs-light-bg": "var(--color-background)",
      "--diffs-dark-bg": "var(--color-background)",
      // 完整 diff 运行在 @pierre/diffs Shadow DOM 中，不会自动继承外层 font-mono class。
      "--diffs-font-family": "var(--font-mono)",
      "--diffs-font-size": `${fontSizePx}px`,
      ...style,
    }),
    [fontSizePx, style],
  );
  // options 先写固定项：diffStyle:"unified"、diffIndicators:"bars"、disableFileHeader:true、overflow:"scroll"；
  // hunkSeparators 按 rendersPatch 分叉——PatchDiff 只有局部上下文，用 "simple" 避免出现点不开的 "unmodified lines"，
  // MultiFileDiff 才用 "line-info" 保留可展开提示；theme 只在 lightTheme && darkTheme 成对时才生效；
  // 末尾 ...optionsOverride 让调用方覆盖默认值，所以它必须最后展开。
  const options = useMemo<FileDiffOptions<undefined>>(
    () => ({
      diffStyle: "unified",
      diffIndicators: "bars",
      disableFileHeader: true,
      // PatchDiff 只有 patch 里的局部上下文，未包含完整 before/after 内容。
      // 使用 simple 避免展示无法点击展开的 “unmodified lines”；MultiFileDiff 保留可展开提示。
      hunkSeparators: rendersPatch ? "simple" : "line-info",
      lineDiffType: "word-alt",
      overflow: "scroll",
      unsafeCSS: DIFF_VIEWER_UNSAFE_CSS,
      // @pierre/diffs 的 code 节点在 Shadow DOM 内，外层 Tailwind class 无法命中；
      // 需要覆盖其内部样式时走 unsafeCSS 注入，且只做最小覆盖，不做大范围样式重写。
      theme:
        lightTheme && darkTheme
          ? {
              light: lightTheme,
              dark: darkTheme,
            }
          : undefined,
      themeType,
      preferredHighlighter: DIFFS_PREFERRED_HIGHLIGHTER,
      ...optionsOverride,
    }),
    [darkTheme, lightTheme, optionsOverride, rendersPatch, themeType],
  );

  // diffNode 按 rendersPatch 二选一：PatchDiff 只接收 props.patch，MultiFileDiff 只接收 props.oldFile/props.newFile，
  // 两种形态的必填字段由 DiffViewerProps 的联合类型在编译期互斥；options/disableWorkerPool/selectedLines 共享，
  // className 固定拼 "min-h-full w-full"，保证两种模式的最小高度与全宽一致。
  const diffNode = rendersPatch ? (
    <PatchDiff
      patch={props.patch}
      options={options}
      disableWorkerPool={disableWorkerPool}
      selectedLines={selectedLines}
      className={cn("min-h-full w-full", diffClassName)}
      style={viewerStyle}
    />
  ) : (
    <MultiFileDiff
      oldFile={props.oldFile}
      newFile={props.newFile}
      options={options}
      disableWorkerPool={disableWorkerPool}
      selectedLines={selectedLines}
      className={cn("min-h-full w-full", diffClassName)}
      style={viewerStyle}
    />
  );

  // divProps 用 omitPatchDiffProps / omitMultiFileDiffProps 剔掉两种形态的全部专有字段（patch、oldFile/newFile 及
  // options/主题/选中行等），剩下的 HTMLAttributes 原样透传到根 div；这样 onClick/aria-* 不会丢，
  // 剔除列表必须与 DiffViewerProps 的字段同步维护，漏一个就会把非法属性传到 DOM。
  const divProps = rendersPatch ? omitPatchDiffProps(props) : omitMultiFileDiffProps(props);

  return (
    <div
      className={cn("h-full w-full overflow-auto", className)}
      data-diff-viewer=""
      style={viewerStyle}
      {...divProps}
    >
      {diffNode}
    </div>
  );
}

export const DiffViewer = memo(DiffViewerComponent);
DiffViewer.displayName = "DiffViewer";

function isPatchDiffProps(
  props: DiffViewerPatchInput | DiffViewerMultiFileInput,
): props is DiffViewerPatchInput {
  return typeof props.patch === "string";
}

function omitPatchDiffProps({
  patch: _patch,
  options: _options,
  disableWorkerPool: _disableWorkerPool,
  diffClassName: _diffClassName,
  fontSizePx: _fontSizePx,
  lightTheme: _lightTheme,
  darkTheme: _darkTheme,
  themeType: _themeType,
  selectedLines: _selectedLines,
  className: _className,
  style: _style,
  ...divProps
}: DiffViewerProps & DiffViewerPatchInput) {
  return divProps;
}

function omitMultiFileDiffProps({
  oldFile: _oldFile,
  newFile: _newFile,
  options: _options,
  disableWorkerPool: _disableWorkerPool,
  diffClassName: _diffClassName,
  fontSizePx: _fontSizePx,
  lightTheme: _lightTheme,
  darkTheme: _darkTheme,
  themeType: _themeType,
  selectedLines: _selectedLines,
  className: _className,
  style: _style,
  ...divProps
}: DiffViewerProps & DiffViewerMultiFileInput) {
  return divProps;
}
