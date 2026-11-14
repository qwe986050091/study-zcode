/*
 * Derived from vercel/ai-elements (packages/elements/src/code-block.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

// CodeBlock 组件族：把纯文本代码渲染成可高亮、可换行、可复制、可预览 Mermaid 的展示块。
// 职责边界：本文件只做展示与交互编排，不解析语言、不做染色算法；高亮与滚动交给 CodeViewer，
// Mermaid 自动渲染配额交给 mermaidRenderBudget，主题、文件图标与文案由外部 Provider 注入。
// 状态归属：换行开关是局部 isWrapped，复制反馈是 isCopied 加计时器，预览 SVG 由子组件回填；
// 跨挂载不缓存业务数据，本文件不读写 store，也不承担任何持久化。
// INV 表（不变量：任一条被破坏都会导致渲染错乱、状态泄漏或交互失效）：
// INV-01 断言：上下文必须有可用默认值，脱离 Provider 也不抛错 —— 守住它的位置：createContext 的初始对象 —— 改错故障：单独复用复制按钮时组件树直接崩溃。
// INV-02 断言：语言标识必须先去除空白再转小写才参与查表 —— 守住它的位置：resolveCodeBlockDisplayFile 的归一化 —— 改错故障：带空格的 ts 与 TypeScript 都落到同一兜底文件名。
// INV-03 断言：未知语言回退 code 加点号加语言名，空语言回退 code.txt —— 守住它的位置：同一工具的三级兜底 —— 改错故障：标题出现悬空点号或 undefined。
// INV-04 断言：非 Mermaid 块不得注册页面可见性监听 —— 守住它的位置：useDocumentVisibilityRevision 的启用短路 —— 改错故障：消息流里每块挂一个监听，滚动明显掉帧。
// INV-05 断言：Mermaid 渲染决策必须随可见性修订号重算 —— 守住它的位置：决策缓存的依赖列表 —— 改错故障：切回标签页后图表仍停在跳过态。
// INV-06 断言：外部换行开关变化必须覆盖本地状态 —— 守住它的位置：同步本地状态的那段副作用 —— 改错故障：按钮高亮与实际换行不一致。
// INV-07 断言：关闭换行时超长行只能横向滚动，不得截断 —— 守住它的位置：isWrapped 透传给 CodeViewer —— 改错故障：行尾内容被容器裁掉。
// INV-08 断言：复制成功态必须在 timeout 毫秒后自动复位 —— 守住它的位置：计时器句柄 timeoutRef 的写入 —— 改错故障：对勾图标永久停留，用户重复复制无反馈。
// INV-09 断言：卸载时必须清掉挂起的复制计时器 —— 守住它的位置：清理型副作用 —— 改错故障：卸载后仍改写状态，出现告警与句柄泄漏。
// INV-10 断言：成功态期间重复点击不得二次写剪贴板 —— 守住它的位置：copyToClipboard 的状态判断 —— 改错故障：连点产生多次回调与多个计时器。
// INV-11 断言：剪贴板能力缺失必须走 onError，不许静默 —— 守住它的位置：复制前的环境校验分支 —— 改错故障：非安全上下文点击毫无反应且无日志。
// INV-12 断言：没有预览 SVG 时 Mermaid 按钮保持禁用 —— 守住它的位置：mermaidPreviewAvailable 的取值 —— 改错故障：点开空白预览弹窗。
// INV-13 断言：离开 Mermaid 分支必须清空 SVG 并关闭弹窗 —— 守住它的位置：跟随 shouldRenderMermaid 的副作用 —— 改错故障：上一张图残留到纯代码块里。
// INV-14 断言：代码区限高只由 contentClassName 承担，Header 不能随滚动滚走 —— 守住它的位置：内容容器与头部的分层 —— 改错故障：滚动时代码盖住复制与换行按钮。
// INV-15 断言：主题变更只透传主题字段，不重建上下文对象 —— 守住它的位置：上下文缓存的依赖列表 —— 改错故障：换主题触发全量重渲染并丢失复制态。
import { Button } from "../ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.js";
import { cn } from "../lib/utils.js";
import { CheckIcon, CopyIcon, Maximize2Icon, WrapTextIcon } from "lucide-react";
import type { ComponentProps, CSSProperties, HTMLAttributes } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BundledTheme } from "shiki";
import { CodeViewer } from "@/components/ui/code-viewer.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { isMermaidLanguage, shouldRenderMermaidCodeBlock } from "@/lib/mermaidLanguage.js";
import {
  getCurrentMermaidDocumentVisibility,
  resolveMermaidAutoRenderDecision,
} from "@/lib/mermaidRenderBudget.js";
import { MermaidBlock } from "@/components/ai-elements/mermaid-block.js";
import { DiagramPreviewDialog } from "@/components/ai-elements/diagram-preview-dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { Theme } from "@/useTheme.js";

// Types
// [契约] Props 分两层：底座是原生 div 属性，业务层必填只有 code 与 language
// [权衡] 高亮开关、行号、字号、换行都带默认值，调用方零配置即可渲染
// [契约] appTheme 供 Mermaid 用应用主题，theme 是 shiki 高亮主题，两者不可互相顶替
type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: string;
  enableSyntaxHighlighting?: boolean;
  showLineNumbers?: boolean;
  theme?: BundledTheme;
  /**
   * 应用主题（store 耦合剥离）：仅透传给 Mermaid 渲染分支；
   * `theme` 已被 shiki 高亮主题占用，故另起名 appTheme。缺省时 Mermaid 按 "system" 兜底。
   */
  appTheme?: Theme;
  wrapLongLines?: boolean;
  fontSizePx?: number;
  renderMermaid?: boolean;
  /** 正文独立限高，避免滚动时把 Header 的复制/换行按钮一起卷走。 */
  contentClassName?: string;
  /**
   * 行定位透传（CodeViewer 已实现滚动+高亮，CodeBlock 也一并暴露）：
   * focusedRange 高亮行区间，focusRequestId 变化时触发滚动到该区间。
   */
  focusedRange?: { startLine: number; endLine: number } | null;
  focusRequestId?: string;
  /** 行号着警示色的行（透传 CodeViewer `markedLines`），编译反馈卡标出被诊断指到的行。 */
  markedLines?: readonly number[];
};

// [契约] 上下文只暴露复制所需源码、换行开关、换行动作与 Mermaid 预览通道
// [权衡] 不放语言与主题：它们已是各子组件的静态渲染参数，进上下文只会扩大无效刷新
// [契约] 预览可用性是布尔派生值，取决于是否已有 SVG，而非是否 Mermaid
interface CodeBlockContextType {
  code: string;
  mermaidPreviewAvailable: boolean;
  openMermaidPreview: () => void;
  toggleWrapLongLines: () => void;
  wrapLongLines: boolean;
}

// [契约] 语言到展示文件名的映射只服务标题图标与后缀，不参与高亮语言判定
// [权衡] 表内同时收录长短别名，是因为标题按用户输入原样小写展示，不做归一化改写
// [契约] 新增语言只需补一行映射，未登记的语言走兜底文件名
const LANGUAGE_DISPLAY_FILE_BY_LANGUAGE: Record<string, string> = {
  bash: "script.sh",
  cjs: "index.cjs",
  css: "style.css",
  go: "main.go",
  html: "index.html",
  javascript: "index.js",
  js: "index.js",
  jsx: "component.jsx",
  json: "data.json",
  markdown: "README.md",
  md: "README.md",
  mermaid: "diagram.mmd",
  mmd: "diagram.mmd",
  mjs: "index.mjs",
  python: "main.py",
  py: "main.py",
  rs: "main.rs",
  rust: "main.rs",
  sh: "script.sh",
  shell: "script.sh",
  toml: "config.toml",
  ts: "index.ts",
  tsx: "component.tsx",
  typescript: "index.ts",
  yaml: "config.yaml",
  yml: "config.yml",
  zsh: "script.zsh",
};

// [契约] 归一化顺序固定：先去首尾空白再转小写，展示文件名优先于映射表
// [失败路径] displayFile 仅在为空值时让位给语言映射，空串会被原样采用，调用方不要传空串
// [权衡] 兜底使用 code 加点号加语言名，保证图标解析器总能拿到可用后缀
function resolveCodeBlockDisplayFile(language: string, displayFile?: string) {
  const normalizedLanguage = language.trim().toLowerCase();
  return (
    displayFile ??
    LANGUAGE_DISPLAY_FILE_BY_LANGUAGE[normalizedLanguage] ??
    `code.${normalizedLanguage || "txt"}`
  );
}

// [资源] 可见性监听只在启用时注册，普通代码块不参与页面级事件订阅
// [并发] 修订号单调递增，只作 Mermaid 决策的重算触发器，不承载真实可见性状态
// [资源] 清理与注册严格配对，启用态切换时先解绑再重绑，避免重复监听
function useDocumentVisibilityRevision(enabled: boolean): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    // 普通代码块数量和消息流同量级，不能为非 Mermaid 块批量注册页面可见性监听。
    if (!enabled) {
      return;
    }

    if (typeof document === "undefined" || typeof document.addEventListener !== "function") {
      return;
    }

    const handleVisibilityChange = () => {
      setRevision((current) => current + 1);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled]);

  return revision;
}

// Context
// [契约] 默认上下文是空实现，保证子组件脱离 Provider 也能安全渲染
// [权衡] 默认换行关闭、预览不可用，宁可功能降级也不抛错
// [契约] 上下文类型与 Provider 装配须同步，缺字段会在类型层面立刻暴露
const CodeBlockContext = createContext<CodeBlockContextType>({
  code: "",
  mermaidPreviewAvailable: false,
  openMermaidPreview: () => {},
  toggleWrapLongLines: () => {},
  wrapLongLines: false,
});

// [资源] 容器开启内容可见性跳过与占位尺寸，离屏长代码块不参与布局与绘制
// [权衡] 占位高度固定两百像素，换来滚动稳定，代价是首屏可能有轻微跳动
// [契约] data-language 只作样式与测试锚点，不参与高亮决策
export const CodeBlockContainer = ({
  className,
  language,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { language: string }) => (
  <div
    className={cn(
      "group relative w-full overflow-hidden rounded-xl bg-background text-foreground",
      className,
    )}
    data-language={language}
    style={{
      containIntrinsicSize: "auto 200px",
      contentVisibility: "auto",
      ...style,
    }}
    {...props}
  />
);

// [契约] Header 三个可选字段：是否显示换行按钮、展示文件名、语言名
// [权衡] 语言名可选，是为了复用自定义标题时不必编造语言
// [契约] children 是整体替换口，一旦传入标题与动作区都不再生效
export type CodeBlockHeaderProps = HTMLAttributes<HTMLDivElement> & {
  showWrapButton?: boolean;
  displayFile?: string;
  language?: string;
};

// [契约] 语言标签去首尾空白后兜底为 text，保证图标与标题都有输入
// [事务] 先解析展示文件名，再交给图标解析器，两步共用同一份归一化语言
// [权衡] 动作区按语言分流：Mermaid 给预览按钮，其余给换行按钮，二者互斥
export const CodeBlockHeader = ({
  children,
  className,
  displayFile,
  language,
  showWrapButton = true,
  ...props
}: CodeBlockHeaderProps) => {
  const languageLabel = language?.trim() || "text";
  const descriptor = resolveFileDisplayDescriptor(
    resolveCodeBlockDisplayFile(languageLabel, displayFile),
  );

  // [契约] 返回结构固定为 Provider 包容器，容器内先放自定义头部再放内容区
  // [事务] Mermaid 与普通代码互斥渲染，同一时刻只有一条分支产出可见内容
  // [契约] 预览弹窗只在已有 SVG 时挂载，避免空节点参与布局
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-3 py-2 text-ui-base text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <CodeBlockTitle className="min-w-0">
            <FileDisplayIcon src={descriptor.fileIconSrc} size={16} className="shrink-0" />
            <CodeBlockFilename className="truncate lowercase">{languageLabel}</CodeBlockFilename>
          </CodeBlockTitle>
          <CodeBlockActions>
            {isMermaidLanguage(languageLabel) ? (
              <CodeBlockMermaidPreviewButton />
            ) : showWrapButton ? (
              <CodeBlockWrapButton />
            ) : null}
            <CodeBlockCopyButton />
          </CodeBlockActions>
        </>
      )}
    </div>
  );
};

export const CodeBlockTitle = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex items-center gap-2", className)} {...props}>
    {children}
  </div>
);

export const CodeBlockFilename = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn("font-mono", className)} {...props}>
    {children}
  </span>
);

export const CodeBlockActions = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("-my-1 -mr-1 flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

// [契约] CodeBlock 是唯一持有交互状态的外壳，其余导出组件都是无状态外观件
// [权衡] 换行、字号、Mermaid 开关都走 props 默认值，调用方零配置即可用
// [契约] 行定位参数整体透传，本层不做区间裁剪与滚动实现
export const CodeBlock = ({
  code,
  enableSyntaxHighlighting = true,
  language,
  showLineNumbers = false,
  theme,
  appTheme,
  wrapLongLines = false,
  fontSizePx = 14,
  renderMermaid = true,
  focusedRange = null,
  focusRequestId,
  markedLines,
  className,
  children,
  contentClassName,
  ...props
}: CodeBlockProps) => {
  const { intl } = useZCodeIntl();
  // [契约] 本地换行态以 props 为初值，之后由用户交互接管
  // [权衡] 用局部状态而非受控：按钮切换零延迟，不要求调用方回写
  // [契约] 初值只在挂载时读一次，后续变更靠同步副作用追平
  const [isWrapped, setIsWrapped] = useState(wrapLongLines);
  const [mermaidPreviewSvg, setMermaidPreviewSvg] = useState<string | null>(null);
  const [mermaidPreviewOpen, setMermaidPreviewOpen] = useState(false);
  // [契约] 显式开启渲染、语言是 Mermaid、内容判定合格，三者同时满足才是候选
  // [失败路径] 任一条件不满足即整体短路，配额计算与监听注册全部跳过
  // [资源] 候选判定是纯同步计算，不申请任何渲染资源
  const canRenderMermaidCode = renderMermaid && shouldRenderMermaidCodeBlock(language, code);
  const documentVisibilityRevision = useDocumentVisibilityRevision(canRenderMermaidCode);
  // [契约] 自动渲染决策按源码与可见性修订号缓存，避免每次渲染重复打分
  // [并发] 页面不可见时决策给出跳过结论，恢复可见后修订号变化触发重算
  // [权衡] 非候选块直接返回空决策，调用方据此跳过配额逻辑
  const mermaidAutoRenderDecision = useMemo(() => {
    if (!canRenderMermaidCode) {
      return null;
    }

    return resolveMermaidAutoRenderDecision(code, {
      documentVisibilityState: getCurrentMermaidDocumentVisibility(),
    });
  }, [canRenderMermaidCode, code, documentVisibilityRevision]);
  // [契约] 真正渲染 Mermaid 需要候选资格与决策同意同时成立
  // [失败路径] 决策缺失或明确拒绝时走普通代码分支，绝不留白屏
  // [契约] 该布尔值是后续清理副作用与日志副作用的唯一开关
  const shouldRenderMermaid =
    canRenderMermaidCode && mermaidAutoRenderDecision?.shouldRender === true;

  useEffect(() => {
    // [契约] 外部换行开关每次变化都覆盖本地状态，包括用户刚手动切换过的场景
    // [权衡] 以 props 为准可避免父子状态分叉，代价是本地切换会被下一次下发覆盖
    // [事务] 同步只做赋值，不改动 Mermaid 相关状态
    setIsWrapped(wrapLongLines);
  }, [wrapLongLines]);

  // [契约] 换行切换是纯翻转，不读源码也不触发外部回调
  // [并发] 采用函数式更新，连续点击不会基于过期快照计算
  // [契约] 该回调引用稳定，进入上下文后不引起下游无谓重渲染
  const toggleWrapLongLines = useCallback(() => {
    setIsWrapped((current) => !current);
  }, []);

  const openMermaidPreview = useCallback(() => {
    setMermaidPreviewOpen(true);
  }, []);

  useEffect(() => {
    if (!shouldRenderMermaid) {
      // [契约] 离开 Mermaid 分支时同时清空预览图与关闭弹窗，二者必须成对
      // [资源] 清空是为释放大体积 SVG 字符串，避免长会话内存累积
      // [失败路径] 只清其一会出现按钮禁用却仍可打开旧图的矛盾态
      setMermaidPreviewSvg(null);
      setMermaidPreviewOpen(false);
    }
  }, [shouldRenderMermaid]);

  useEffect(() => {
    if (!mermaidAutoRenderDecision || mermaidAutoRenderDecision.shouldRender) {
      return;
    }

    // [契约] 自动渲染被跳过时留调试日志，携带原因与度量，便于定位配额问题
    // [权衡] 决策缺席时不打日志，避免普通代码块刷出噪声
    // [契约] 日志只在决策变化时触发，不进入渲染主路径
    logger.debug("[CodeBlock] Mermaid 自动渲染跳过", {
      reason: mermaidAutoRenderDecision.reason,
      ...mermaidAutoRenderDecision.metrics,
    });
  }, [mermaidAutoRenderDecision]);

  // [契约] 上下文对象按源码、换行态、预览可用性与两个稳定回调缓存
  // [并发] 任一依赖变化都会生成新对象，下游消费方随之更新
  // [权衡] 回调引用稳定让依赖列表可以省略它们，减少无效刷新
  const contextValue = useMemo(
    () => ({
      code,
      mermaidPreviewAvailable: Boolean(mermaidPreviewSvg),
      openMermaidPreview,
      toggleWrapLongLines,
      wrapLongLines: isWrapped,
    }),
    [code, isWrapped, mermaidPreviewSvg, openMermaidPreview, toggleWrapLongLines],
  );

  return (
    <CodeBlockContext.Provider value={contextValue}>
      <CodeBlockContainer className={className} language={language} {...props}>
        {children}
        <div className={cn("p-2 pt-0 pb-3", contentClassName)}>
          {shouldRenderMermaid ? (
            <MermaidBlock
              code={code}
              theme={appTheme}
              onOpenPreview={openMermaidPreview}
              onPreviewSvgChange={setMermaidPreviewSvg}
              // className={cn(children ? "border-t border-border" : null)}
            />
          ) : (
            <CodeViewer
              code={code}
              enableSyntaxHighlighting={enableSyntaxHighlighting}
              language={language}
              showLineNumbers={showLineNumbers}
              theme={theme}
              wrapLongLines={isWrapped}
              focusedRange={focusedRange}
              focusRequestId={focusRequestId}
              markedLines={markedLines}
              className="bg-transparent"
              fontSizePx={fontSizePx}
              // markdown 代码块外层是 bg-card，但 CodeViewer 默认把 @pierre/diffs 背景设成 background。
              // 这里仅覆盖 markdown CodeBlock 入口，避免侧边栏文件预览的背景层级被一起改掉。
              style={
                {
                  "--diffs-bg": "var(--color-card)",
                  "--diffs-light-bg": "var(--color-card)",
                  "--diffs-dark-bg": "var(--color-card)",
                  "--diffs-gap-block": "0px",
                } as CSSProperties
              }
            />
          )}
        </div>
        {shouldRenderMermaid && mermaidPreviewSvg ? (
          <DiagramPreviewDialog
            open={mermaidPreviewOpen}
            onOpenChange={setMermaidPreviewOpen}
            svg={mermaidPreviewSvg}
            title={intl.formatMessage({ id: "codeBlock.mermaid.ariaLabel" })}
          />
        ) : null}
      </CodeBlockContainer>
    </CodeBlockContext.Provider>
  );
};

// [契约] 换行按钮属性继承底座按钮，仅额外约定提示与标签的覆盖口
// [权衡] 不新增尺寸与外观字段，避免与底座按钮的既有约定重复
// [契约] 该类型不影响行为，行为全部来自上下文
export type CodeBlockWrapButtonProps = ComponentProps<typeof Button>;

// [契约] 点击先交给调用方，未被阻止才切换换行，保留外部拦截能力
// [契约] 图标可整体替换，默认使用换行图标且尺寸固定
// [事务] 切换只改本地状态，不同步远端也不写存储
export const CodeBlockWrapButton = ({
  "aria-label": ariaLabel,
  children,
  className,
  onClick,
  title,
  ...props
}: CodeBlockWrapButtonProps) => {
  // [契约] 换行按钮只订阅上下文里的开关与切换动作，不感知源码
  // [并发] 切换由函数式更新完成，连点不会丢状态
  // [契约] 脱离上下文时拿到空实现，按钮退化为无副作用的图标
  const { toggleWrapLongLines, wrapLongLines } = useContext(CodeBlockContext);
  const { intl } = useZCodeIntl();
  // [契约] 提示与无障碍标签同源：title 优先，否则取国际化文案
  // [权衡] 同源可避免读屏播报与悬浮提示不一致
  // [契约] 该文案只用于展示，不参与换行判定
  const label = title ?? intl.formatMessage({ id: "codeBlock.wrapLines" });

  return (
    <ControlHintTooltip title={label} side="top">
      <Button
        aria-label={ariaLabel ?? label}
        aria-pressed={wrapLongLines}
        className={cn("shrink-0", wrapLongLines && "bg-muted", className)}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) {
            toggleWrapLongLines();
          }
        }}
        size="icon-md"
        type="button"
        variant="ghost"
        {...props}
      >
        {children ?? <WrapTextIcon className="size-3.5" />}
      </Button>
    </ControlHintTooltip>
  );
};

// [契约] 预览按钮属性同样继承底座按钮，允许调用方覆盖外观
// [权衡] 不额外暴露禁用控制，禁用条件由上下文可用性统一决定
// [契约] 图标可通过子节点替换，默认使用放大图标
export type CodeBlockMermaidPreviewButtonProps = ComponentProps<typeof Button>;

// [契约] 预览按钮与换行按钮共用底座，差异只在图标、禁用条件与动作
// [契约] 打开动作经上下文转发给外层弹窗状态，按钮本身不持有开关
// [权衡] 由外层统一托管弹窗，避免每个按钮各自维护一份可见性
export const CodeBlockMermaidPreviewButton = ({
  "aria-label": ariaLabel,
  children,
  className,
  onClick,
  title,
  ...props
}: CodeBlockMermaidPreviewButtonProps) => {
  const { intl } = useZCodeIntl();
  // [契约] 预览按钮订阅预览可用性与打开动作，不接触渲染细节
  // [失败路径] 可用性为假时按钮禁用，点击被底座按钮直接吞掉
  // [契约] 禁用态只跟随 SVG 是否已产出，与语言判定无直接关系
  const { mermaidPreviewAvailable, openMermaidPreview } = useContext(CodeBlockContext);
  const label = title ?? intl.formatMessage({ id: "codeBlock.mermaid.openPreview" });

  return (
    <ControlHintTooltip title={label} side="top">
      <Button
        aria-label={ariaLabel ?? label}
        className={cn("shrink-0", className)}
        disabled={!mermaidPreviewAvailable}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) {
            openMermaidPreview();
          }
        }}
        size="icon-md"
        type="button"
        variant="ghost"
        {...props}
      >
        {children ?? <Maximize2Icon className="size-3.5" />}
      </Button>
    </ControlHintTooltip>
  );
};

// [契约] 复制按钮在底座属性上增加两个回调与一个复位时长
// [权衡] 超时默认两秒：足够看清对勾，又不至于长期占用成功态
// [契约] 成功与失败走不同回调，调用方可分别做提示与埋点
export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

// [契约] 复制按钮从上下文取源码，自身只管成功态与计时器
// [失败路径] 两个回调都可选，缺省时复制失败会被静默吞掉
// [权衡] 文案与标签同源，与换行按钮保持同一套可访问性口径
export const CodeBlockCopyButton = ({
  "aria-label": ariaLabel,
  onCopy,
  onError,
  title,
  timeout = 2000,
  children,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  // [契约] 成功态是布尔标记，只控制图标与重复点击拦截
  // [并发] 该状态与计时器句柄成对存在，复位时必须同时清掉句柄
  // [契约] 初值恒为未复制，不随源码变化重置
  const [isCopied, setIsCopied] = useState(false);
  // [资源] 计时器句柄存入可变引用，跨渲染保留，卸载时统一清理
  // [契约] 初值零表示无挂起计时，对零值清理是安全的空操作
  // [失败路径] 不用状态保存句柄，避免句柄变化再触发一轮渲染
  const timeoutRef = useRef<number>(0);
  const { code } = useContext(CodeBlockContext);
  const { intl } = useZCodeIntl();
  const label = title ?? intl.formatMessage({ id: "codeBlock.copyCode" });

  // [契约] 复制流程：校验环境、写入剪贴板、置成功态、回调、起计时器
  // [并发] 成功态期间再次点击直接跳过，防止并发写入与多计时器叠加
  // [失败路径] 写入异常转交错误回调，不置成功态也不起计时器
  // [契约] 依赖列表包含成功态，因此成功态变化会重建回调引用
  const copyToClipboard = useCallback(async () => {
    // [失败路径] 非浏览器环境或剪贴板能力缺失时，先回调错误再返回，不进入写入
    // [契约] 该分支是唯一的环境守卫，后续流程假定能力可用
    // [权衡] 用可选链探测而非特性标记，兼容嵌入式浏览器的残缺实现
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    // [失败路径] 只有写入成功才置成功态，避免失败也显示对勾
    // [事务] 回调与计时器在成功之后依次执行，顺序不可颠倒
    // [契约] 计时器把成功态复位，间隔取配置的超时时长
    try {
      if (!isCopied) {
        await navigator.clipboard.writeText(code);
        setIsCopied(true);
        onCopy?.();
        timeoutRef.current = window.setTimeout(() => setIsCopied(false), timeout);
      }
    } catch (error) {
      onError?.(error as Error);
    }
  }, [code, onCopy, onError, timeout, isCopied]);

  // [资源] 卸载时清除挂起的复制计时器，防止卸载后改写状态
  // [契约] 清理只注册一次，依赖为空，不随成功态变化重复注册
  // [权衡] 不在成功态复位时清句柄，因为复位本身就是计时器触发的
  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <ControlHintTooltip title={label} side="top">
      <Button
        aria-label={ariaLabel ?? label}
        className={cn("shrink-0", className)}
        onClick={copyToClipboard}
        size="icon-md"
        type="button"
        variant="ghost"
        {...props}
      >
        {children ?? <Icon className="size-3.5" />}
      </Button>
    </ControlHintTooltip>
  );
};

export type CodeBlockLanguageSelectorProps = ComponentProps<typeof Select>;

export const CodeBlockLanguageSelector = (props: CodeBlockLanguageSelectorProps) => (
  <Select {...props} />
);

export type CodeBlockLanguageSelectorTriggerProps = ComponentProps<typeof SelectTrigger>;

export const CodeBlockLanguageSelectorTrigger = ({
  className,
  ...props
}: CodeBlockLanguageSelectorTriggerProps) => (
  <SelectTrigger
    className={cn("h-7 border-none bg-transparent px-2 text-ui-base shadow-none", className)}
    size="sm"
    {...props}
  />
);

export type CodeBlockLanguageSelectorValueProps = ComponentProps<typeof SelectValue>;

export const CodeBlockLanguageSelectorValue = (props: CodeBlockLanguageSelectorValueProps) => (
  <SelectValue {...props} />
);

export type CodeBlockLanguageSelectorContentProps = ComponentProps<typeof SelectContent>;

export const CodeBlockLanguageSelectorContent = ({
  align = "end",
  ...props
}: CodeBlockLanguageSelectorContentProps) => <SelectContent align={align} {...props} />;

export type CodeBlockLanguageSelectorItemProps = ComponentProps<typeof SelectItem>;

export const CodeBlockLanguageSelectorItem = (props: CodeBlockLanguageSelectorItemProps) => (
  <SelectItem {...props} />
);
