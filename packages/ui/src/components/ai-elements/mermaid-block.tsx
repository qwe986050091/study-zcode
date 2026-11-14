"use client";

// [资源] 模块说明：Mermaid 代码块把 AI 回复里的图表源码异步渲染成 SVG，失败时降级为纯文本。
// [并发] 渲染由模块级串行队列调度，主题变化、系统配色变化与代码变化都会排入新的一轮。
// [事务] 下文按读取顺序列出不变式，只描述既有语义，不引入任何行为变更。
// [权衡] 关注点集中在异步竞态、主题解析与 DOM 资源回收三处。
// INV-01 [并发] 所有图表共用一条串行渲染队列；守住位置：enqueueMermaidRender 的队尾替换；改错故障：并行渲染争用共享运行时，图形串到别的代码块。
// INV-02 [失败路径] 前序任务失败后队列仍继续接单；守住位置：enqueueMermaidRender 中同时传入成功与失败回调；改错故障：一次语法错误后所有后续图表永久停在加载态。
// INV-03 [并发] 每轮 effect 用取消标记作废旧轮次，旧结果不得覆盖新结果；守住位置：渲染完成回调里的取消判断；改错故障：代码已更新仍显示上一张图。
// INV-04 [并发] 渲染键同时包含主题键与代码哈希，任一变化都视为新渲染；守住位置：renderKey 的 useMemo；改错故障：切换主题后图表颜色停留在旧配色。
// INV-05 [资源] 新渲染开始前先置加载态并清空外部预览；守住位置：effect 中置 loading 的分支；改错故障：新结果到达前旧 SVG 继续可见，用户误读为已完成。
// INV-06 [失败路径] 空代码直接落到纯文本，不占用渲染队列；守住位置：effect 开头的裁空判断；改错故障：空块也排队，拖慢后续真实图表首帧。
// INV-07 [失败路径] 解析异常记录后退回纯文本，不用错误面板打断阅读；守住位置：渲染失败的 catch 分支；改错故障：流式输出中途的残缺语法让整条消息显示报错。
// INV-08 [资源] 卸载或依赖变化时清空外部预览 SVG，避免外部持有已卸载组件的图像；守住位置：effect 返回的清理函数；改错故障：预览面板残留上一块图表的图像。
// INV-09 [权衡] 主题 token 先由浏览器解析再用 canvas 采样成 rgb/rgba，不透传现代颜色；守住位置：normalizeCssColorForMermaid；改错故障：Mermaid 无法解析 oklab，图表整体不渲染。
// INV-10 [失败路径] canvas 不支持的颜色会停在哨兵色，此处必须回退安全色；守住位置：fillStyle 与哨兵值的比较分支；改错故障：图表出现透明或纯黑节点。
// INV-11 [资源] 解析元素在 finally 中移出文档，探针元素读取后立即移除；守住位置：normalizeCssColorForMermaid 的 finally 与 resolveCssColor 的移除语句；改错故障：反复切主题残留隐藏节点，长会话内存增长。
// INV-12 [权衡] 缺少 DOM 工厂时颜色能力降级为固定回退色，但模块导入不得抛错；守住位置：canCreateDomElements 与规范化函数的提前返回；改错故障：预渲染或测试环境导入即崩溃，整页白屏。
// INV-13 [并发] 配色监听器随 effect 清理注销并兼容旧版注册接口；守住位置：useSystemThemeRevision 的两条订阅路径；改错故障：系统主题切换后图表不刷新，且监听器持续泄漏。
// INV-14 [事务] 系统配色变化只在监听回调里递增修订号，重算交给渲染阶段统一处理；守住位置：handleChange 的更新函数；改错故障：监听回调里直接触发渲染，多个图表同时排队造成卡顿。
// INV-15 [事务] 渲染配置在调用时读取当前主题 token，不跨主题复用旧值；守住位置：createMermaidConfig 内的颜色解析调用；改错故障：深浅主题共用一套颜色，文字与背景对比度失效。
// INV-16 [权衡] 代码哈希只作为渲染标识而非相等性判据，碰撞仅导致多余重渲染；守住位置：hashMermaidCode 与 renderId 的拼接；改错故障：误当内容比较使用，该刷新的图表被漏掉。
// INV-17 [失败路径] 渲染异常先归一化为字符串再记录，日志不带整段源码；守住位置：normalizeMermaidRenderError 与 debug 日志字段；改错故障：异常丢失消息，或把用户大段内容写进日志。
// INV-18 [权衡] 渲染结果以 HTML 注入，安全边界由 Mermaid 的 strict 级别承担；守住位置：dangerouslySetInnerHTML 与配置里的 securityLevel；改错故障：放松安全级别后代码块可执行注入脚本。
import { createMermaidPlugin, type MermaidConfig } from "@streamdown/mermaid";
import { Loader2Icon } from "lucide-react";
import type { HTMLAttributes } from "react";
import { useEffect, useId, useMemo, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { Theme } from "@/useTheme.js";
import { resolveTheme } from "@/useTheme.js";

type MermaidRenderState =
  | {
      status: "loading";
    }
  | {
      status: "ready";
      svg: string;
    }
  | {
      status: "plaintext";
    };

export interface MermaidBlockProps extends HTMLAttributes<HTMLDivElement> {
  code: string;
  /**
   * 应用主题（store 耦合剥离）：由调用方从上层状态传入。
   * 默认 "system" 跟随操作系统，供旧调用点/待删代码兜底。
   */
  theme?: Theme;
  onOpenPreview?: () => void;
  onPreviewSvgChange?: (svg: string | null) => void;
}

// [资源] 插件实例在模块作用域创建一次，同页所有代码块共享同一份 Mermaid 运行时。
// [资源] 常量地位保证组件反复挂载卸载不会重建运行时，也不重复注册渲染器。
// [权衡] 共享实例省去重复初始化开销，代价是渲染配置必须在每次渲染时显式传入。
// [并发] 运行时内部持有全局状态，因此不能假设两次渲染彼此隔离。
const mermaidPlugin = createMermaidPlugin();
// [并发] 队列以已决议 promise 起头，首个任务无需等待任何前置渲染。
// [事务] 队尾每次被替换为当前任务的收尾 promise，形成单链表式的串行链。
// [失败路径] 收尾 promise 吸收拒绝态，队列不会因任何一次失败而停止接单。
// [资源] 只保留最新队尾引用，已完成的节点可被回收，不在内存中长期堆积。
let mermaidRenderQueue = Promise.resolve();
const MERMAID_COLOR_CANVAS_SENTINEL = "#010203";

// Mermaid 底层的 khroma 解析器不支持 Tailwind v4 常见的 oklab/color-mix 结果。
// 先让浏览器解析主题 token，再通过 canvas 采样成传统 rgb/rgba，避免把现代 CSS 颜色直接传给 Mermaid。
// Web 远程控制的启动测试只提供了最小 document mock，SSR/预渲染环境也可能没有 DOM 工厂；
// 颜色归一化是增强能力，不能让 MessageResponse 的静态导入在这些环境中直接崩溃。
// [失败路径] 在创建任何节点之前先确认 document.createElement 可用。
// [权衡] 颜色归一化属于增强能力，环境不支持时整体降级而不是抛出异常。
// [资源] 探测结果在模块加载时固化，运行期不再重复判断环境。
const canCreateDomElements =
  typeof document !== "undefined" && typeof document.createElement === "function";
const mermaidColorResolverEl: HTMLSpanElement | null = canCreateDomElements
  ? document.createElement("span")
  : null;
const mermaidColorNormalizeCtx: CanvasRenderingContext2D | null = (() => {
  if (!canCreateDomElements) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx) {
    ctx.globalCompositeOperation = "copy";
  }
  return ctx;
})();

// [并发] 新任务接到队尾而非队首，渲染顺序与代码块出现顺序保持一致。
// [事务] 入队与队尾替换在同一同步段完成，不存在两个任务同时读到旧队尾的窗口。
// [并发] 任务的实际开始时机由前序 promise 决议决定，与调用方是否等待无关。
// [失败路径] 前序任务失败时当前任务仍会执行，单个坏图不影响后续图表。
// [资源] 返回的 promise 是任务本身的镜像，调用方只能追踪，无法撤销排队。
// [权衡] 以串行换取运行时稳定，代价是慢图会推迟后面所有图的首帧时间。
function enqueueMermaidRender<T>(task: () => Promise<T>): Promise<T> {
  const run = mermaidRenderQueue.then(task, task);
  mermaidRenderQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// [权衡] 逐字符异或并乘以质数再截断到 32 位，实现简单且分布足够均匀。
// [并发] 哈希结果只用于生成渲染标识，不承担内容相等性判断。
// [失败路径] 按码元而非码点累加，代理对仍得到确定值，跨环境结果一致。
// [权衡] 结果转成 36 进制缩短标识长度，碰撞只影响命名唯一性的概率。
function hashMermaidCode(code: string): string {
  let hash = 2166136261;
  for (let index = 0; index < code.length; index += 1) {
    hash ^= code.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

// [失败路径] 探针元素、canvas 上下文或文档体任一缺失都直接返回回退色。
// [资源] 探针在进入保护块后挂载，finally 中一定移除，异常路径也不残留节点。
// [权衡] 先让浏览器按计算样式解析变量，再交给 canvas 归一化颜色格式。
// [失败路径] 采样过程中的异常统一走兜底分支，不把颜色问题升级为渲染失败。
// [资源] canvas 固定 1×1 并使用 copy 合成，读取像素不受历史内容影响。
// [权衡] 透明度保留三位小数，兼顾表达精度与字符串稳定性。
function normalizeCssColorForMermaid(raw: string, fallback: string): string {
  if (!raw || !mermaidColorResolverEl || !mermaidColorNormalizeCtx || !document.body) {
    return raw || fallback;
  }

  try {
    document.body.appendChild(mermaidColorResolverEl);
    mermaidColorResolverEl.style.color = "";
    mermaidColorResolverEl.style.color = raw;
    const resolved = getComputedStyle(mermaidColorResolverEl).color;
    if (!resolved) {
      return fallback;
    }

    mermaidColorNormalizeCtx.clearRect(0, 0, 1, 1);
    mermaidColorNormalizeCtx.fillStyle = MERMAID_COLOR_CANVAS_SENTINEL;
    const sentinelFillStyle = mermaidColorNormalizeCtx.fillStyle;
    mermaidColorNormalizeCtx.fillStyle = resolved;
    // 如果 canvas 也不支持该颜色格式，fillStyle 会停在哨兵色，直接回退到 Mermaid 可解析的安全色。
    if (mermaidColorNormalizeCtx.fillStyle === sentinelFillStyle) {
      return fallback;
    }

    mermaidColorNormalizeCtx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 255] = mermaidColorNormalizeCtx.getImageData(0, 0, 1, 1).data;
    const roundedAlpha = +(a / 255).toFixed(3);
    return roundedAlpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${roundedAlpha})`;
  } catch {
    return fallback;
  } finally {
    mermaidColorResolverEl.remove();
  }
}

// [资源] 探针 `span` 设为 `pointer-events:none` 的隐藏绝对定位，读取计算色后立即 remove()。
// [失败路径] 无 document 或文档体未就绪时直接给出回退色，不创建任何节点。
// [事务] 挂载、读取与移除在同一同步段完成，样式变更不会让读取拿到半成品。
function resolveCssColor(variableName: string, fallback: string): string {
  if (typeof document === "undefined" || !document.body) {
    return fallback;
  }

  const probe = document.createElement("span");
  probe.style.color = `var(${variableName})`;
  probe.style.pointerEvents = "none";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();

  return normalizeCssColorForMermaid(color, fallback);
}

// [事务] 每次调用都重新解析主题 token，配置对象不跨主题复用。
// [权衡] 关闭自动启动与内置错误渲染，渲染时机与失败展示都交给组件掌控。
// [权衡] strict 安全级别限制图内交互与脚本，牺牲部分表达力换取注入面收敛。
// [失败路径] 单个 token 解析失败只影响对应颜色，其余颜色仍取各自回退值。
// [资源] 返回值是纯数据对象，可被多次渲染共享，无需额外清理。
function createMermaidConfig(resolvedTheme: "light" | "dark"): MermaidConfig {
  const background = resolveCssColor(
    "--color-card",
    resolvedTheme === "dark" ? "#18181b" : "#ffffff",
  );
  const surface = resolveCssColor(
    "--color-surface",
    resolvedTheme === "dark" ? "#27272a" : "#f4f4f5",
  );
  const accent = resolveCssColor(
    "--color-accent",
    resolvedTheme === "dark" ? "#1f2937" : "#f0f9ff",
  );
  const text = resolveCssColor(
    "--color-foreground",
    resolvedTheme === "dark" ? "#f4f4f5" : "#27272a",
  );
  const subtleText = resolveCssColor(
    "--color-foreground-subtle",
    resolvedTheme === "dark" ? "#a1a1aa" : "#52525b",
  );
  const border = resolveCssColor(
    "--color-border",
    resolvedTheme === "dark" ? "#3f3f46" : "#d4d4d8",
  );

  return {
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    securityLevel: "strict",
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: "base",
    themeVariables: {
      actorBkg: background,
      actorBorder: border,
      actorTextColor: text,
      background,
      lineColor: subtleText,
      mainBkg: background,
      nodeBorder: border,
      noteBkgColor: accent,
      noteTextColor: text,
      primaryBorderColor: border,
      primaryColor: surface,
      primaryTextColor: text,
      secondaryBorderColor: border,
      secondaryColor: accent,
      secondaryTextColor: text,
      signalColor: subtleText,
      signalTextColor: text,
      tertiaryBorderColor: border,
      tertiaryColor: background,
      tertiaryTextColor: text,
      textColor: text,
    },
  };
}

function resolveBrowserTheme(theme: Theme): "light" | "dark" {
  if (typeof window === "undefined") {
    return theme === "dark" || theme === "zai-dark" ? "dark" : "light";
  }

  return resolveTheme(theme);
}

// [资源] 监听器在 effect 清理函数中注销，卸载后不再持有任何回调。
// [失败路径] 非 system 主题或非浏览器环境直接跳过订阅，不产生副作用。
// [权衡] 同时兼容 `addEventListener` 与旧版 `addListener`，按运行时能力二选一。
// [事务] 监听回调只做 setRevision(prev => prev + 1)，重算交给渲染阶段统一处理。
// [并发] 修订号单调递增，采用函数式更新，避免闭包读到过期计数。
function useSystemThemeRevision(theme: Theme): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (theme !== "system" || typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => setRevision((current) => current + 1);

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, [theme]);

  return revision;
}

function normalizeMermaidRenderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MermaidBlock({
  code,
  className,
  theme = "system",
  onOpenPreview,
  onPreviewSvgChange,
  ...props
}: MermaidBlockProps) {
  const { intl } = useZCodeIntl();
  const systemThemeRevision = useSystemThemeRevision(theme);
  const renderIdPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const trimmedCode = code.trim();
  const resolvedTheme = resolveBrowserTheme(theme);
  const themeKey = `${theme}:${resolvedTheme}:${systemThemeRevision}`;
  const mermaidConfig = useMemo(
    () => createMermaidConfig(resolvedTheme),
    [resolvedTheme, themeKey],
  );
  const renderKey = useMemo(
    () => `${themeKey}:${hashMermaidCode(trimmedCode)}`,
    [themeKey, trimmedCode],
  );
  const [renderState, setRenderState] = useState<MermaidRenderState>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;

    if (!trimmedCode) {
      setRenderState({
        status: "plaintext",
      });
      onPreviewSvgChange?.(null);
      return;
    }

    // [并发] 新一轮渲染开始前先清空结果，旧 SVG 不会在新结果到达前继续可见。
    // [事务] setRenderState("loading") 与 onPreviewSvgChange(null) 在同一同步段完成，外部视口看不到中间态。
    // [资源] 覆盖式更新丢弃上一次的 SVG 字符串引用，旧值可被回收。
    setRenderState({ status: "loading" });
    onPreviewSvgChange?.(null);
    const renderId = `zcode-mermaid-${renderIdPrefix}-${hashMermaidCode(renderKey)}`;

    // [并发] 异步任务在入队时创建，真正执行要等前序渲染全部结束。
    // [失败路径] 主动忽略返回 promise 的拒绝，避免未捕获拒绝冒泡到全局。
    // [事务] 任务内部读取的是本次 effect 捕获的代码与配置快照。
    // [资源] 渲染器按当前配置临时取得，不复用跨主题的旧实例。
    void enqueueMermaidRender(async () => {
      const renderer = mermaidPlugin.getMermaid(mermaidConfig);
      return renderer.render(renderId, trimmedCode);
    })
      .then(({ svg }) => {
        if (!cancelled) {
          setRenderState({ status: "ready", svg });
          onPreviewSvgChange?.(svg);
        }
      })
      // [失败路径] 解析失败降级为纯文本，保留原文可读性而不是展示错误面板。
      // [并发] 已被取消的轮次只记录日志，不再回写任何状态。
      // [权衡] 日志仅保留错误消息与代码长度，避免把用户内容整段写入日志。
      .catch((error: unknown) => {
        const message = normalizeMermaidRenderError(error);
        logger.debug("[MermaidBlock] Mermaid 渲染失败", {
          error: message,
          codeLength: trimmedCode.length,
        });
        if (!cancelled) {
          // Mermaid 解析失败常见于模型流式输出未完成或用户粘贴了非标准语法。
          // 退回纯文本能保留内容可读，避免用错误面板打断聊天阅读。
          setRenderState({ status: "plaintext" });
          onPreviewSvgChange?.(null);
        }
      });

    return () => {
      // [并发] 清理函数把本轮标记为失效，晚到的渲染结果会被丢弃。
      // [资源] 同时清空外部预览 SVG，外部不会持有已卸载组件的图像。
      // [事务] 标记在清理时同步生效，之后所有回写都以它为前提。
      cancelled = true;
      onPreviewSvgChange?.(null);
    };
  }, [intl, mermaidConfig, onPreviewSvgChange, renderIdPrefix, renderKey, trimmedCode]);

  return (
    <div
      className={cn("group/mermaid relative min-h-32 w-full bg-card", className)}
      data-mermaid-block=""
      {...props}
    >
      <div className="max-h-[420px] overflow-auto p-3 text-foreground">
        {renderState.status === "loading" ? (
          <div className="flex min-h-28 items-center justify-center gap-2 text-foreground-subtle text-ui-base">
            <Loader2Icon className="size-4 animate-spin" />
            <span>{intl.formatMessage({ id: "codeBlock.mermaid.loading" })}</span>
          </div>
        ) : null}
        {renderState.status === "plaintext" ? (
          <pre className="m-0 min-h-28 min-w-max bg-transparent font-mono text-foreground text-ui-base leading-relaxed">
            {code}
          </pre>
        ) : null}
        {renderState.status === "ready" ? (
          <div
            aria-label={intl.formatMessage({ id: "codeBlock.mermaid.ariaLabel" })}
            className="flex min-h-28 min-w-max items-center justify-center [&_svg]:h-auto [&_svg]:max-w-none"
            // [权衡] SVG 以字符串直接注入，安全边界依赖 strict 安全级别对输出的约束。
            // [事务] 注入内容只来自本次就绪状态，不拼接任何外部片段。
            // [并发] 主题或代码变化会先卸载该节点，旧 SVG 不残留于文档。
            dangerouslySetInnerHTML={{ __html: renderState.svg }}
            onDoubleClick={onOpenPreview}
            role="img"
          />
        ) : null}
      </div>
    </div>
  );
}
