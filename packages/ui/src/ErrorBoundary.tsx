// ── ZCode UI · 渲染期错误边界 ──────────────────────────
// 本模块提供两层兜底：AppErrorBoundary 包住整棵 Provider 树，把整树崩溃收敛成可重试/可刷新的全屏页；
// ScopedErrorBoundary 按区域隔离，让 sidebar、chat、terminal 等面板各自失败各自恢复。
// 依赖 DesktopWindowFrame、i18n 词典、logger 与 ARMS 上报；模块本身不持有任何业务状态。
// INV-01 错误边界只捕获子树 render 与生命周期里抛出的异常，事件处理器和异步回调抛错仍会穿透到 window.onerror；守住位置：componentDidCatch；改错故障：误以为点击回调异常已被吞掉，线上依旧白屏。
// INV-02 fallback 渲染自身不得再抛，locale 读取与词典查询都必须有兜底；守住位置：resolveBoundaryLocale；改错故障：兜底页二次崩溃，用户看到纯白屏且没有重试入口。
// INV-03 getDerivedStateFromError 只产 error 与空 componentStack，必须是纯函数；守住位置：两个 class 的静态方法；改错故障：在静态方法里做副作用或读 props 触发 React 警告与状态错乱。
// INV-04 命中错误后先由 React 渲染 fallback，再由 didCatch 补堆栈，两阶段顺序不可并成一步；守住位置：componentDidCatch；改错故障：把堆栈写进第一阶段会让兜底首帧缺少详情，诊断信息丢失。
// INV-05 重试语义是把 state.error 置空后重渲染，不重建子树实例；守住位置：handleReset；改错故障：改成强制整页刷新会丢失用户未提交的编辑内容。
// INV-06 [失败路径] 重试后同一子树再次抛错必须被再次捕获，不能无限自我重试；守住位置：render 分支；改错故障：错误态未清干净会让重试按钮失效，fallback 永久卡死。
// INV-07 [资源] resetKeys 长度变化或逐位引用变化都算新上下文，用 Object.is 比较以兼容原始值与稳定引用；守住位置：haveResetKeysChanged；改错故障：改成深比较会把对象键当成变化，重置过于频繁。
// INV-08 [事务] resetKeys 重置只在已处于错误态时执行，正常态切换不得触碰 state；守住位置：componentDidUpdate；改错故障：无条件 setState 会形成更新循环，页面持续重渲染直至卡死。
// INV-09 [资源] 错误上报只能在渲染路径之外同步尝试且不得等待，避免阻塞兜底首帧；守住位置：reportReactErrorToArms 调用点；改错故障：上报挂起时用户看不到任何兜底界面。
// INV-10 [失败路径] 日志与 ARMS 上报自身异常不得中断 fallback 展示；守住位置：componentDidCatch；改错故障：监控 SDK 抛错让边界跟着崩，白屏范围被放大。
// INV-11 [权衡] 根级边界必须位于 Provider 外层，因此 Provider 崩溃也走全屏兜底，用局部可用性换可诊断性；守住位置：AppErrorBoundary；改错故障：把根边界下沉到页面内会漏掉 Provider 崩溃场景。
// INV-12 [权衡] 局部边界按 silent、compact、inline、panel 四档降级，重要度越低越静默；守住位置：ScopedErrorFallback；改错故障：小控件一律用 panel 会占满屏幕，主界面不可操作。
// INV-13 [并发] 同一 scope 下的多个实例各自持有错误态，不得共享模块级变量；守住位置：ScopedErrorBoundary；改错故障：共享状态让一个面板的崩溃传染给同区域其他面板。
// INV-14 error 归一化必须把非 Error 抛出物包成 Error 并保留字符串内容；守住位置：normalizeError；改错故障：抛字符串时兜底页只剩 Unknown error，问题无法定位。
// INV-15 [资源] 写日志时按需附带 stack，只传可序列化字段以跨 preload bridge；守住位置：serializeErrorForLog；改错故障：直接传 Error 实例会序列化成空对象，关键 message 丢失。
// INV-16 locale 解析顺序为存储偏好、navigator 语言、DEFAULT_LOCALE，任一步抛错都要降级；守住位置：resolveBoundaryLocale；改错故障：localStorage 不可读时文案解析失败，兜底页再次崩溃。
// INV-17 [事务] onReset 用户回调在 state 清理之后调用，保证回调里重挂载的子树不会命中旧错误；守住位置：ScopedErrorBoundary 的 handleReset；改错故障：先回调后清 state 会让重挂载被旧 error 直接拦住。
// INV-18 [资源] 刷新按钮只在 window 存在时执行整页重载，测试环境不假装成功；守住位置：handleReload；改错故障：Node 测试里抛 ReferenceError，刷新入口变成新的失败源。
// INV-19 兜底页文案与间距必须走词典与设计 token，不得硬编码；守住位置：ErrorFallback 布局；改错故障：英文超长文案与固定高度叠加，窄窗口下操作按钮被挤出可视区。
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import type { Locale } from "@zcode/shared";
import { DEFAULT_LOCALE } from "@zcode/shared";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";
import { logger } from "@/logger.js";
import { reportReactErrorToArms } from "@/lib/reactErrorArmsTelemetry.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { AlertTriangleIcon, RefreshCw } from "lucide-react";

// [权衡] children 必填，边界只有真正包住子树才有兜底意义，空包裹等于没有保护。
// onCaughtReactError 是宿主注入的上报出口，边界只负责转发，不持有监控实现细节。
// [并发] 三个桌面平台标志只影响窗口外观，不允许据此改变错误语义与重试行为。
interface AppErrorBoundaryProps {
  children: ReactNode;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  /**
   * React 错误边界捕获的异常不会冒泡到 window.onerror，监控 SDK默认收不到。
   * Desktop 等宿主可传入此回调，将 React 错误边界捕获的异常转发到监控 SDK。
   */
  onCaughtReactError?: (error: Error, errorInfo: ErrorInfo) => void;
}

// 错误态只存 error 与 componentStack，两字段同生同灭，避免出现半个错误态。
// [事务] componentStack 在捕获阶段留空、didCatch 后补齐，渲染据此分两阶段推进。
interface AppErrorBoundaryState {
  error: Error | null;
  componentStack: string;
}

// [权衡] 四档变体按区域重要度降级：silent 不渲染、compact 单行、inline 内嵌卡片、panel 整块居中。
// 新增变体必须同时处理 silent 早返回与 compact 分支，否则会静默落入面板分支造成布局错位。
export type ScopedErrorBoundaryVariant = "panel" | "inline" | "compact" | "silent";

// scope 用于日志与 ARMS 归因，必须稳定，不能随渲染随机生成。
// resetKeys 是外部上下文切换信号，长度变化或引用变化都视为进入新的隔离会话。
// [资源] className 只做外观覆盖，不参与错误判定，避免样式差异影响重试结果。
interface ScopedErrorBoundaryProps {
  children: ReactNode;
  scope: string;
  resetKeys?: readonly unknown[];
  variant?: ScopedErrorBoundaryVariant;
  className?: string;
  onReset?: () => void;
  onCaughtReactError?: (error: Error, errorInfo: ErrorInfo, scope: string) => void;
}

const LOCALE_PREFERENCE_KEY = "zcode-locale-preference";

// [失败路径] 非 Error 抛出物统一包装：字符串直接作为 message，其余降级为 Unknown error。
// 返回新实例而不是原地改写，保证各上报方拿到的 Error 不共享可变引用。
// 该函数在静态方法与 didCatch 各执行一次，必须保持幂等以免两次归一化结果分叉。
function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : "Unknown error");
}

function serializeErrorForLog(error: Error): {
  name: string;
  message: string;
  stack?: string;
} {
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
  };
}

// [失败路径] 存储读取包在 try 内，能力缺失或直接抛错都回退到 navigator，再回退默认语言。
// 只接受 zh-CN 与 en-US 两个存储值，其余脏数据按未设置处理，避免词典查不到键。
// 该函数在 fallback 渲染期被调用，绝不允许向外抛错，否则兜底页变成新的崩溃源。
function resolveBoundaryLocale(): Locale {
  if (typeof localStorage !== "undefined" && typeof localStorage.getItem === "function") {
    try {
      const storedPreference = localStorage.getItem(LOCALE_PREFERENCE_KEY);
      if (storedPreference === "zh-CN" || storedPreference === "en-US") {
        return storedPreference;
      }
    } catch {
      // 在 Node 测试环境里，可能出现“localStorage 对象存在但能力不完整/不可读”的场景
      // （例如只有占位对象或读取阶段直接抛错）。错误边界若不兜底会在 fallback 渲染期再次崩溃，
      // 用户就会看到白屏。这里吞掉存储层异常，继续回退到 navigator / 默认语言。
    }
  }

  if (typeof navigator !== "undefined") {
    return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
  }

  return DEFAULT_LOCALE;
}

function formatBoundaryMessage(id: string): string {
  const locale = resolveBoundaryLocale();
  const messages = locale === "en-US" ? enUS : zhCN;
  return messages[id] ?? id;
}

// [事务] 先比长度再逐位用 Object.is 比较，长度不同直接判定为变化，省去逐项扫描。
// 使用 Object.is 而非宽松相等，NaN 与 -0 的判定才稳定，不会漏掉或误报重置。
// 两个参数给默认空数组，让未传 resetKeys 的调用方无需额外判空。
function haveResetKeysChanged(
  previousKeys: readonly unknown[] = [],
  nextKeys: readonly unknown[] = [],
): boolean {
  if (previousKeys.length !== nextKeys.length) {
    return true;
  }

  return previousKeys.some((previousKey, index) => !Object.is(previousKey, nextKeys[index]));
}

// 根级兜底页只依赖入参，不读全局状态，保证 Provider 崩溃后它仍能独立渲染。
// [资源] 容器用 overflow-y-auto + items-start：componentStack 再长，重试与刷新按钮也保持可达。
// 禁止在 fallback 内复用会抛错的业务组件，否则兜底路径自身崩溃，白屏无法挽回。
function ErrorFallback({
  error,
  componentStack,
  onReset,
  onReload,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
}: {
  error: Error;
  componentStack: string;
  onReset: () => void;
  onReload: () => void;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}) {
  const errorSummary = error.message.trim() || formatBoundaryMessage("appError.unknown");

  return (
    <DesktopWindowFrame
      title={formatBoundaryMessage("appError.title")}
      isDesktop={isDesktop}
      isMacDesktop={isMacDesktop}
      isWindowsDesktop={isWindowsDesktop}
    >
      <div className="flex h-full min-h-0 justify-center overflow-y-auto p-6">
        <div
          role="alert"
          // 错误信息和组件堆栈可能非常长，之前外层不可滚动会把内容挤出视口，
          // 用户既看不完堆栈，也点不到“重试/刷新”按钮。这里让 fallback 卡片固定从顶部开始，
          // 并配合外层纵向滚动，确保窗口再小也能完整访问全部操作。
          className="w-full max-w-xl self-start rounded-3xl border border-destructive/20 bg-surface-alt p-6 shadow-sm"
        >
          <div className="flex size-10 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
            <AlertTriangleIcon className="size-5" />
          </div>

          <h1 className="mt-4 text-lg font-semibold text-foreground">
            {formatBoundaryMessage("appError.title")}
          </h1>
          <p className="mt-2 text-ui-base leading-6 text-on-surface-muted">
            {formatBoundaryMessage("appError.description")}
          </p>

          <div className="mt-4 rounded-2xl border border-border bg-background px-3 py-2 font-mono text-ui-base leading-5 text-on-surface-muted">
            {errorSummary}
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <Button type="button" onClick={onReset}>
              {formatBoundaryMessage("appError.retry")}
            </Button>
            <Button type="button" variant="outline" onClick={onReload}>
              <RefreshCw />
              {formatBoundaryMessage("appError.reload")}
            </Button>
          </div>

          <p className="mt-4 text-ui-base leading-5 text-on-surface-muted">
            {formatBoundaryMessage("appError.hint")}
          </p>

          {componentStack ? (
            <details className="mt-4 rounded-2xl border border-border bg-background px-3 py-2">
              <summary className="cursor-pointer text-ui-base font-medium text-on-surface-muted">
                {formatBoundaryMessage("appError.details")}
              </summary>
              <pre className="mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words text-ui-base leading-5 text-on-surface-muted">
                {/* 组件堆栈展开后会瞬间增高，限制 pre 高度并独立滚动，
                    避免 details 撑满全屏导致主操作区被挤出可视区域。 */}
                {componentStack.trim()}
              </pre>
            </details>
          ) : null}
        </div>
      </div>
    </DesktopWindowFrame>
  );
}

// [权衡] 同一份内容片段被 inline 与 panel 复用，差异只在容器布局，减少分支重复。
// errorSummary 为空时回退到词典里的未知错误文案，避免出现空白提示条。
// 组件堆栈在 compact 档被隐藏，用诊断信息换取小空间里的核心操作可见。
function ScopedErrorFallback({
  error,
  componentStack,
  onReset,
  onReload,
  variant = "panel",
  className,
}: {
  error: Error;
  componentStack: string;
  onReset: () => void;
  onReload: () => void;
  variant?: ScopedErrorBoundaryVariant;
  className?: string;
}) {
  // [失败路径] silent 档直接返回空，占位不渲染也不额外提示，用于可安全消失的次要模块。
  // compact 档走单行截断布局，仅保留摘要与重试按钮，适配工具栏等窄区域。
  // inline 档输出内嵌卡片，panel 档输出整块居中容器，两者共享同一内容片段。
  // 分支顺序即降级优先级，调整顺序会改变默认外观，必须同步更新调用方约定。
  if (variant === "silent") {
    return null;
  }

  const errorSummary = error.message.trim() || formatBoundaryMessage("appError.unknown");
  const isCompact = variant === "compact";
  const showDetails = variant !== "compact";

  if (isCompact) {
    return (
      <div
        role="alert"
        className={cn(
          "flex min-h-10 items-center gap-2 border-border bg-surface px-3 py-2",
          className,
        )}
      >
        <AlertTriangleIcon className="size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui-base font-medium text-foreground">
            {formatBoundaryMessage("appError.sectionTitle")}
          </p>
          <p className="truncate font-mono text-ui-base text-foreground-subtle">{errorSummary}</p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onReset}>
          {formatBoundaryMessage("appError.sectionRetry")}
        </Button>
      </div>
    );
  }

  const content = (
    <>
      <div className="flex size-8 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
        <AlertTriangleIcon className="size-4" />
      </div>
      <h2 className="mt-3 text-ui-base font-medium text-foreground">
        {formatBoundaryMessage("appError.sectionTitle")}
      </h2>
      <p className="mt-1 text-ui-base leading-5 text-foreground-subtle">
        {formatBoundaryMessage("appError.sectionDescription")}
      </p>
      <div className="mt-3 rounded-lg border border-border bg-background px-3 py-2 font-mono text-ui-base leading-5 text-foreground-subtle">
        {errorSummary}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={onReset}>
          {formatBoundaryMessage("appError.sectionRetry")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onReload}>
          <RefreshCw />
          {formatBoundaryMessage("appError.reload")}
        </Button>
      </div>
      <p className="mt-3 text-ui-base leading-5 text-foreground-subtle">
        {formatBoundaryMessage("appError.sectionHint")}
      </p>
      {showDetails && componentStack ? (
        <details className="mt-3 rounded-lg border border-border bg-background px-3 py-2">
          <summary className="cursor-pointer text-ui-base font-medium text-foreground-subtle">
            {formatBoundaryMessage("appError.details")}
          </summary>
          <pre className="mt-2 max-h-[32vh] overflow-auto whitespace-pre-wrap break-words text-ui-base leading-5 text-foreground-subtle">
            {componentStack.trim()}
          </pre>
        </details>
      ) : null}
    </>
  );

  if (variant === "inline") {
    return (
      <div
        role="alert"
        className={cn("w-full rounded-xl border border-destructive/20 bg-surface p-4", className)}
      >
        {content}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className={cn(
        "flex h-full min-h-0 items-center justify-center overflow-auto bg-background p-4",
        className,
      )}
    >
      <div className="w-full max-w-md rounded-xl border border-destructive/20 bg-surface p-4 shadow-sm">
        {content}
      </div>
    </div>
  );
}

/**
 * AppErrorBoundary —— React 根级错误边界
 *
 * renderer 入口若直接把 ZCodeIntlProvider / Root 挂到 createRoot，
 * 一旦某个 Provider 或页面组件在 render / lifecycle 阶段抛错，React 会整棵树卸载，
 * 用户看到的就只剩一张白屏。这里包一层共享根级边界，把异常收敛成可恢复 fallback，
 * 至少保证界面还能给出“重试 / 刷新”的出口，并把错误打到统一 UI 日志里。
 */
// 根级边界是整棵树最后一道兜底，挂载位置必须在全部 Provider 外层。
// [权衡] state 初始为空错误，首帧直接透传 children，无错误时不增加任何 DOM 层级。
// 两个生命周期分工固定：静态方法产状态，didCatch 只做日志、上报与补堆栈。
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    error: null,
    componentStack: "",
  };

  // [事务] 静态方法只返回错误态，堆栈留白交给 didCatch 第二阶段补齐。
  // 该方法在渲染阶段执行，不得读 props、不得写日志、不得触发状态更新。
  // [失败路径] 入参是 unknown，必须过归一化，否则非 Error 抛出物会让兜底页取不到 message。
  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      error: normalizeError(error),
      componentStack: "",
    };
  }

  // [资源] 先按可序列化结构写 UI 日志，再转发宿主回调与 ARMS，最后把堆栈补进 state。
  // [失败路径] 上报处于同步流程中，任何异常都不得冒泡覆盖原始崩溃信息。
  // setState 只改 componentStack，error 已在静态方法落地，避免二次渲染抖动。
  override componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    const normalizedError = normalizeError(error);
    logger.error(
      "[AppErrorBoundary] React subtree crashed:",
      // Error 对象跨 preload 日志 bridge 序列化后会变成 {}，
      // 导致 Maximum update depth 等关键 message 丢失。这里显式展开可诊断字段。
      serializeErrorForLog(normalizedError),
      errorInfo.componentStack,
    );
    this.props.onCaughtReactError?.(normalizedError, errorInfo);
    // React 错误边界拦截了异常、阻止其冒泡到 window.onerror，RUM Browser SDK 默认收不到。
    // 主动转发到 ARMS 自定义事件干道（reporter 在 renderer 入口早注入），补上根级渲染崩溃盲区。
    reportReactErrorToArms({
      error: normalizedError,
      componentStack: errorInfo.componentStack ?? "",
    });
    this.setState({ componentStack: errorInfo.componentStack ?? "" });
  }

  // [事务] handleReset 只清 error 与 componentStack 后 setState：触发重渲染，但不重挂载子树。
  // [权衡] 不重挂载子树是有意为之，保留用户未提交的输入与滚动位置。
  private handleReset = () => {
    this.setState({
      error: null,
      componentStack: "",
    });
  };

  // [资源] 刷新走整页重载，仅作为重试无效时的最终出口，代价是丢掉全部内存状态。
  // window 不存在时静默跳过，兼容 Node 测试与非浏览器宿主环境。
  private handleReload = () => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  // 无错误时直接返回 children，不包额外节点，避免影响布局与 key 稳定性。
  // [失败路径] 有错误时只渲染根级 fallback，children 完全卸载，防止错误组件继续执行。
  override render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <ErrorFallback
        error={this.state.error}
        componentStack={this.state.componentStack}
        onReset={this.handleReset}
        onReload={this.handleReload}
        isDesktop={this.props.isDesktop}
        isMacDesktop={this.props.isMacDesktop}
        isWindowsDesktop={this.props.isWindowsDesktop}
      />
    );
  }
}

/**
 * ScopedErrorBoundary —— 局部 UI 故障隔离边界
 *
 * 只有根级错误边界时，workspace 内任意一个面板 render 抛错都会一路冒泡到根，
 * 最终把整套界面替换成全屏错误页。这里提供可复用的局部边界，让 sidebar、chat、
 * terminal、side pane 等区域各自失败各自恢复，避免单个组件问题扩大成整窗不可用。
 */
// 局部边界按区域实例化，一个面板崩溃不牵连兄弟面板，把故障半径限制在区域内。
// [并发] 每个实例独立持有 error 与 componentStack，禁止提升到模块作用域共享。
// React 的边界不捕获自身抛出的错误，挂载点位置决定实际隔离范围，越靠近调用方越精确。
export class ScopedErrorBoundary extends Component<
  ScopedErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = {
    error: null,
    componentStack: "",
  };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      error: normalizeError(error),
      componentStack: "",
    };
  }

  // [资源] 日志前缀带 scope，便于按区域检索；上报同样携带 scope 完成归因闭环。
  // [事务] 先归一化再分发，宿主回调在末位追加 scope，保持与根级边界签名兼容。
  // [失败路径] 日志或上报异常不得阻断补堆栈，否则兜底页永远等不到详情。
  override componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    const normalizedError = normalizeError(error);
    logger.error(
      `[ScopedErrorBoundary:${this.props.scope}] React subtree crashed:`,
      // Error 对象跨 preload 日志 bridge 序列化后会变成 {}，
      // 局部边界需要保留 message/stack 才能定位 UI 更新循环。
      serializeErrorForLog(normalizedError),
      errorInfo.componentStack,
    );
    this.props.onCaughtReactError?.(normalizedError, errorInfo, this.props.scope);
    // 同根级边界：scoped 区域捕获的渲染异常同样不会冒泡到 RUM，按 scope 区分上报，
    // 让 sidebar/chat/terminal/settings 等局部崩溃在 RUM 里可见、可定位。
    reportReactErrorToArms({
      error: normalizedError,
      componentStack: errorInfo.componentStack ?? "",
      scope: this.props.scope,
    });
    this.setState({ componentStack: errorInfo.componentStack ?? "" });
  }

  // [事务] 仅当处于错误态且 resetKeys 变化时重置，正常态切换不触碰 state。
  // [并发] 在 didUpdate 内更新状态会再触发一轮，条件必须收敛为一次性，不能反复命中。
  // [失败路径] 遗漏错误态判断会形成更新循环，页面持续重渲染直至卡死。
  override componentDidUpdate(previousProps: ScopedErrorBoundaryProps) {
    if (this.state.error && haveResetKeysChanged(previousProps.resetKeys, this.props.resetKeys)) {
      // 局部 fallback 如果不随 workspace/task/tab 切换自动清空，
      // 用户离开出错区域后再回来仍会看到旧错误。resetKeys 变化时重置边界，
      // 让新的隔离上下文可以重新渲染。
      this.setState({
        error: null,
        componentStack: "",
      });
    }
  }

  // [事务] 先清自身错误态再调用外部 onReset，保证回调里重挂载的子树不再命中旧错误。
  // onReset 是可选回调，不得假设宿主一定提供，也不能用它替代内部状态清理。
  private handleReset = () => {
    this.setState({
      error: null,
      componentStack: "",
    });
    this.props.onReset?.();
  };

  private handleReload = () => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  // 把 variant 与 className 原样透传给 fallback，边界本身不决定外观档位。
  // [失败路径] 局部 fallback 同样在 children 卸载后渲染，避免错误子组件继续被调用。
  override render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <ScopedErrorFallback
        error={this.state.error}
        componentStack={this.state.componentStack}
        onReset={this.handleReset}
        onReload={this.handleReload}
        variant={this.props.variant}
        className={this.props.className}
      />
    );
  }
}
