// INV-01 视口比较留一像素容差：守住位置 恒定容差；改错故障 取整差异导致重复准备。
// INV-02 宽高都要比较：守住位置 双条件与运算；改错故障 高度变化被忽略。
// INV-03 释放回调只执行一次：守住位置 布尔标记；改错故障 重复释放引发二次异常。
// INV-04 首次释放后置位标记：守住位置 语句顺序；改错故障 回调抛错后仍可再次进入。
// INV-05 可选字段缺席不写键：守住位置 条件展开；改错故障 载荷出现未定义字段。
// INV-06 载荷字段与入参同名：守住位置 逐项映射；改错故障 主渲染两侧字段错位。
// INV-07 超时由调用方决定：守住位置 入参透传；改错故障 录制与截图共用同一上限。
// INV-08 释放载荷剔除只读字段：守住位置 解构剔除；改错故障 释放被当作二次准备。
// INV-09 剔除字段用占位名：守住位置 下划线前缀；改错故障 未使用变量告警。
// INV-10 租约携带失效信号：守住位置 只读属性；改错故障 调用方无法感知作废。
// INV-11 租约携带缩放与视口：守住位置 字段完整；改错故障 调用方拿到错配表面。
// INV-12 活动租约可标记已准备：守住位置 可选方法；改错故障 看门狗无法提前结算。
// INV-13 准备分组按键聚合同源请求：守住位置 分组键；改错故障 同源请求各自准备。
// INV-14 分组区分准备中与就绪：守住位置 两个布尔；改错故障 就绪前被当作可截图。
// INV-15 分组保留发送方标识：守住位置 可选字段；改错故障 回包无法路由到窗口。
// INV-16 分组持有失效控制器：守住位置 必填字段；改错故障 取消时无信号可发。
// INV-17 预设载荷类型取自共享协议：守住位置 类型来源；改错故障 主渲染字段各自定义。
// INV-18 本模块只放契约与纯函数：守住位置 文件职责；改错故障 契约层混入副作用。
//
// 模块职责：browserScreenshotSurfaceContracts 提供截图表面准备与释放的共享契约及三个纯函数。
// 状态所有权：无状态；分组与 BrowserScreenshotActivityLease 租约的生命周期由 BrowserScreenshotSurfaceCoordinator 持有。
// 阅读顺序：先看租约与分组形状，再看容差比较，最后看载荷互转。
import type {
  BrowserViewportSize,
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewScreenshotSurfaceReleasePayload,
  BrowserViewSurfaceScaleMode,
} from "@zcode/shared";

const VIEWPORT_TOLERANCE_PX = 1;

export interface BrowserScreenshotActivityLease {
  readonly invalidated?: AbortSignal;
  markPrepared?(): void;
  release(): void;
}

export interface BrowserScreenshotSurfaceLease {
  readonly invalidated?: AbortSignal;
  surfaceScale: number;
  webContentsId: number;
  viewport: BrowserViewportSize;
  release(): void;
}

export interface BrowserScreenshotSurfaceCoordinator {
  prepare(input: {
    requestId: string;
    windowId: number;
    workspaceKey: string;
    sessionId: string;
    browserId: string;
    browserGeneration: number;
    tabId: string;
    webContentsId: number;
    viewport: BrowserViewportSize;
    viewportMode?: BrowserViewScreenshotSurfacePreparePayload["viewportMode"];
    /** recording 用真实 100% renderer surface；普通截图缺失时保留当前预览比例。 */
    surfaceScaleMode?: BrowserViewSurfaceScaleMode;
    signal: AbortSignal;
    /** recording 可显式请求更长但仍有界的 activity watchdog；普通截图继续使用默认值。 */
    activityTimeoutMs?: number;
  }): Promise<BrowserScreenshotSurfaceLease>;
}

export type BrowserScreenshotSurfacePrepareInput = Parameters<
  BrowserScreenshotSurfaceCoordinator["prepare"]
>[0];

export interface BrowserScreenshotPendingRequest {
  input: BrowserScreenshotSurfacePrepareInput;
  group: BrowserScreenshotPreparationGroup;
  resolve: (lease: BrowserScreenshotSurfaceLease) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortListener: () => void;
}

export interface BrowserScreenshotPreparationGroup {
  key: string;
  payload: BrowserViewScreenshotSurfacePreparePayload;
  windowId: number;
  requests: Set<BrowserScreenshotPendingRequest>;
  prepareSent: boolean;
  ready: boolean;
  released: boolean;
  senderWebContentsId?: number;
  readySurfaceScale?: number;
  readyViewport?: BrowserViewportSize;
  leaseReleases: Set<() => void>;
  invalidationController: AbortController;
  activityLease?: BrowserScreenshotActivityLease;
  activityAbortListener?: () => void;
  activityTimer?: ReturnType<typeof setTimeout>;
  activityTimeoutMs?: number;
}

// 宽高各允许 VIEWPORT_TOLERANCE_PX 一像素误差；sameBrowserScreenshotViewport 只比较数值不比较模式；越界立即返回假；两侧都在容差内才算相同。
export function sameBrowserScreenshotViewport(
  expected: BrowserViewportSize,
  actual: BrowserViewportSize,
): boolean {
  return (
    Math.abs(expected.width - actual.width) <= VIEWPORT_TOLERANCE_PX &&
    Math.abs(expected.height - actual.height) <= VIEWPORT_TOLERANCE_PX
  );
}

// releaseBrowserScreenshotResourceOnce 的闭包持有 released 布尔标记；第二次调用直接返回；标记先置位再执行 callback；回调异常不影响幂等性。
export function releaseBrowserScreenshotResourceOnce(callback: () => void): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    callback();
  };
}

// toBrowserScreenshotSurfacePreparePayload 字段逐项映射；viewportMode 与 surfaceScaleMode 仅在存在时展开；timeoutMs 由调用方透传。
export function toBrowserScreenshotSurfacePreparePayload(
  input: BrowserScreenshotSurfacePrepareInput,
  timeoutMs: number,
): BrowserViewScreenshotSurfacePreparePayload {
  return {
    requestId: input.requestId,
    workspaceKey: input.workspaceKey,
    sessionId: input.sessionId,
    browserId: input.browserId,
    browserGeneration: input.browserGeneration,
    tabId: input.tabId,
    webContentsId: input.webContentsId,
    viewport: input.viewport,
    ...(input.viewportMode ? { viewportMode: input.viewportMode } : {}),
    ...(input.surfaceScaleMode ? { surfaceScaleMode: input.surfaceScaleMode } : {}),
    timeoutMs,
  };
}

export function toBrowserScreenshotSurfaceReleasePayload(
  payload: BrowserViewScreenshotSurfacePreparePayload,
): BrowserViewScreenshotSurfaceReleasePayload {
  const {
    surfaceScaleMode: _surfaceScaleMode,
    timeoutMs: _timeoutMs,
    viewport: _viewport,
    viewportMode: _viewportMode,
    ...releasePayload
  } = payload;
  return releasePayload;
}
