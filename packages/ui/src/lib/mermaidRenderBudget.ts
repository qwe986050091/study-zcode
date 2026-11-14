// INV-01 三道预算是渲染前闸门：守住位置 常量；改错故障 大图直接进入渲染层。
// INV-02 字符上限两万：守住位置 sourceChars；改错故障 超长源码拖垮主线程。
// INV-03 行数上限六百：守住位置 lineCount；改错故障 长文档一次性建树。
// INV-04 复杂度上限一千五：守住位置 complexityScore；改错故障 边与节点双重放大。
// INV-05 页面不可见即跳过：守住位置 可见性分支；改错故障 后台标签页仍然渲染。
// INV-06 未知可见性按可见处理：守住位置 判定；改错故障 首帧被误判为隐藏。
// INV-07 无文档环境按可见处理：守住位置 环境判断；改错故障 测试环境全部跳过。
// INV-08 可见性只认四种标准值：守住位置 类型与判定；改错故障 浏览器新状态被拒。
// INV-09 指标先于决策计算：守住位置 measure 调用；改错故障 拒绝时无法解释原因。
// INV-10 跳过原因封闭四种：守住位置 联合类型；改错故障 新原因前端没有对应文案。
// INV-11 决策是判别联合：守住位置 返回类型；改错故障 调用方同时处理两种形状。
// INV-12 边匹配使用全局正则：守住位置 标志 gu；改错故障 只统计首个匹配。
// INV-13 正则游标每次归零：守住位置 lastIndex；改错故障 复用正则时计数漂移。
// INV-14 节点匹配限长两百：守住位置 量词；改错故障 恶意长串拖慢匹配。
// INV-15 空源码按零行处理：守住位置 countLines；改错故障 空文档被算成一行。
// INV-16 阈值可由选项覆盖：守住位置 options；改错故障 测试无法构造边界。
// INV-17 覆盖值不改变默认常量：守住位置 空值合并；改错故障 默认常量被意外改写。
// INV-18 全部判断无副作用：守住位置 纯函数；改错故障 决策过程触发渲染。
//
// 模块职责：为 Mermaid 自动渲染提供源码规模与页面可见性预算。
// 状态所有权：纯常量与纯函数；不持有渲染状态。
// 阅读顺序：先看三道阈值，再看指标采集，最后看决策分支。
export const MERMAID_AUTO_RENDER_MAX_SOURCE_CHARS = 20_000;
// 三道阈值在进入 Mermaid render 之前生效。
// sourceChars 取 source.length。
// lineCount 与 complexityScore 各自独立设限。
// 改阈值需同步 MERMAID_AUTO_RENDER_* 常量说明。
export const MERMAID_AUTO_RENDER_MAX_LINES = 600;
export const MERMAID_AUTO_RENDER_MAX_COMPLEXITY_SCORE = 1_500;

export type MermaidDocumentVisibilityState =
  | "visible"
  | "hidden"
  | "prerender"
  | "unloaded"
  | "unknown";

export type MermaidAutoRenderSkipReason =
  | "document-hidden"
  | "source-too-large"
  | "line-count-too-large"
  | "complexity-too-large";

export interface MermaidAutoRenderMetrics {
  sourceChars: number;
  lineCount: number;
  edgeLikeTokenCount: number;
  nodeLikeTokenCount: number;
  complexityScore: number;
}

export type MermaidAutoRenderDecision =
  | {
      shouldRender: true;
      metrics: MermaidAutoRenderMetrics;
    }
  | {
      shouldRender: false;
      reason: MermaidAutoRenderSkipReason;
      metrics: MermaidAutoRenderMetrics;
    };

interface MermaidAutoRenderOptions {
  documentVisibilityState?: MermaidDocumentVisibilityState;
  maxSourceChars?: number;
  maxLines?: number;
  maxComplexityScore?: number;
}

const MERMAID_EDGE_TOKEN_PATTERN = /(?:<-->|<--|-->|---|-\.->|==>|--x|--o|x--|o--)/gu;
const MERMAID_NODE_TOKEN_PATTERN =
  /(?:^|\n)\s*[A-Za-z][\w-]*(?:\[[^\]\n]{0,200}\]|\([^)\n]{0,200}\)|\{[^}\n]{0,200}\})/gu;

// countPatternMatches 先把 pattern.lastIndex 归零。
// while (pattern.exec(value)) 逐次执行到无匹配。
// 返回值只用于 complexityScore 估算。
// pattern 是模块级常量，不按调用重建。
function countPatternMatches(value: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(value)) {
    count += 1;
  }
  return count;
}

// countLines 对空串返回 0。
// countLines 按 charCode 10 统计换行。
// 末行无换行时 countLines 仍加 1。
function countLines(value: string): number {
  if (!value) {
    return 0;
  }

  let lineCount = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) {
      lineCount += 1;
    }
  }
  return lineCount;
}

// typeof document === "undefined" 时返回 "visible"。
// 只接受 visible / hidden / prerender / unloaded 四种 visibilityState。
// 其余值回落到 document.hidden ? "hidden" : "visible"。
export function getCurrentMermaidDocumentVisibility(): MermaidDocumentVisibilityState {
  if (typeof document === "undefined") {
    return "visible";
  }

  const visibilityState = document.visibilityState as MermaidDocumentVisibilityState | undefined;
  if (
    visibilityState === "visible" ||
    visibilityState === "hidden" ||
    visibilityState === "prerender" ||
    visibilityState === "unloaded"
  ) {
    return visibilityState;
  }

  return document.hidden ? "hidden" : "visible";
}

// measureMermaidSource 一次遍历得到全部指标。
// complexityScore = lineCount + edgeLikeTokenCount + nodeLikeTokenCount。
// metrics 随 MermaidAutoRenderDecision 一起返回。
function measureMermaidSource(source: string): MermaidAutoRenderMetrics {
  const sourceChars = source.length;
  const lineCount = countLines(source);
  const edgeLikeTokenCount = countPatternMatches(source, MERMAID_EDGE_TOKEN_PATTERN);
  const nodeLikeTokenCount = countPatternMatches(source, MERMAID_NODE_TOKEN_PATTERN);
  const complexityScore = lineCount + edgeLikeTokenCount + nodeLikeTokenCount;

  return {
    sourceChars,
    lineCount,
    edgeLikeTokenCount,
    nodeLikeTokenCount,
    complexityScore,
  };
}

export function resolveMermaidAutoRenderDecision(
  source: string,
  options: MermaidAutoRenderOptions = {},
): MermaidAutoRenderDecision {
  const metrics = measureMermaidSource(source);
  const documentVisibilityState = options.documentVisibilityState ?? "visible";
  const maxSourceChars = options.maxSourceChars ?? MERMAID_AUTO_RENDER_MAX_SOURCE_CHARS;
  const maxLines = options.maxLines ?? MERMAID_AUTO_RENDER_MAX_LINES;
  const maxComplexityScore = options.maxComplexityScore ?? MERMAID_AUTO_RENDER_MAX_COMPLEXITY_SCORE;

  // Mermaid/DOMPurify 渲染会在 native 层构造大 DOM/SVG 字符串，事后 catch 或截断无法阻止 OOM。
  // 因此必须在进入 Mermaid render 前按源码规模和页面可见性做预算门禁。
  if (documentVisibilityState !== "visible" && documentVisibilityState !== "unknown") {
    return {
      shouldRender: false,
      reason: "document-hidden",
      metrics,
    };
  }

  if (metrics.sourceChars > maxSourceChars) {
    return {
      shouldRender: false,
      reason: "source-too-large",
      metrics,
    };
  }

  if (metrics.lineCount > maxLines) {
    return {
      shouldRender: false,
      reason: "line-count-too-large",
      metrics,
    };
  }

  if (metrics.complexityScore > maxComplexityScore) {
    return {
      shouldRender: false,
      reason: "complexity-too-large",
      metrics,
    };
  }

  return {
    shouldRender: true,
    metrics,
  };
}
