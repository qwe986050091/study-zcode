// INV-01 启动遥测只在协调器确认后发：守住位置 回调分支；改错故障 重复启动事件。
// INV-02 待发标识先清空再上报：守住位置 赋值顺序；改错故障 上报失败反复重试同一次启动。
// INV-03 缺少渲染上下文时静默跳过：守住位置 空值判断；改错故障 上报空字段。
// INV-04 日活只在首次进入交互时补发：守住位置 状态翻转判断；改错故障 每次聚焦都重复上报。
// INV-05 日活心跳只使用最新上下文：守住位置 取值来源；改错故障 多窗口下上报旧窗口。
// INV-06 心跳间隔可注入：守住位置 依赖参数；改错故障 测试无法推进时间。
// INV-07 定时器不阻止进程退出：守住位置 释放调用；改错故障 应用关闭被心跳拖住。
// INV-08 释放时清除心跳：守住位置 释放入口；改错故障 销毁后仍持续上报。
// INV-09 上报失败统一交给错误回调：守住位置 捕获分支；改错故障 未处理拒绝带崩主进程。
// INV-10 上下文按渲染器标识存放：守住位置 映射键；改错故障 多窗口互相覆盖。
// INV-11 最新上下文单独记录：守住位置 同步入口；改错故障 心跳读到已关闭窗口。
// INV-12 同步上下文后立刻尝试补发：守住位置 调用顺序；改错故障 启动事件延迟到下一拍。
// INV-13 异步上报不阻塞调用方：守住位置 调用方式；改错故障 窗口就绪被网络阻塞。
// INV-14 生产与测试共用同一入口：守住位置 导出形状；改错故障 定时器实现分叉。
// INV-15 依赖全部显式注入：守住位置 参数解构；改错故障 隐式全局让单测相互污染。
// INV-16 渲染器标识使用数字：守住位置 类型约束；改错故障 字符串键与数字键重复。
// INV-17 释放后不再写入状态：守住位置 生命周期边界；改错故障 已销毁实例仍被调用。
// INV-18 对外只暴露必要方法：守住位置 返回对象；改错故障 映射表被外部直接改写。
//
// 模块职责：createAppTelemetryRuntime 调度主进程应用启动与日活遥测。
// 状态所有权：rendererContexts 映射、pendingStartupTelemetryRendererId 与 interactive 标记都归单次创建的运行时。
// 阅读顺序：先看上报函数，再看心跳与补发，最后看对外方法。
import type { TelemetryRendererContext } from "@zcode/shared";

interface StartupCoordinatorLike {
  onRendererReady(input: { hasPendingOAuthCallback: boolean; rendererId: number }): boolean;
  onOAuthCallbackHandled(input: { rendererId: number }): boolean;
}

interface TelemetryCoreLike {
  reportAppLaunch(context: TelemetryRendererContext): Promise<void>;
  reportAppDailyActive(context: TelemetryRendererContext): Promise<void>;
}

type DailyActiveInterval = ReturnType<typeof setInterval> | number;

interface AppTelemetryRuntimeDependencies {
  telemetryCore: TelemetryCoreLike;
  appLaunchCoordinator: StartupCoordinatorLike;
  onError?: (error: unknown) => void;
  dailyActiveHeartbeatIntervalMs?: number;
  setInterval?: (handler: () => void, timeout: number) => DailyActiveInterval;
  clearInterval?: (interval: DailyActiveInterval) => void;
}

const DEFAULT_DAILY_ACTIVE_HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;

// rendererContexts 按渲染器标识存放；pendingStartupTelemetryRendererId 初始为 null；interactive 默认关闭；依赖全部由调用方注入。
export function createAppTelemetryRuntime({
  telemetryCore,
  appLaunchCoordinator,
  onError,
  dailyActiveHeartbeatIntervalMs = DEFAULT_DAILY_ACTIVE_HEARTBEAT_INTERVAL_MS,
  setInterval: setIntervalFn = setInterval,
  clearInterval: clearIntervalFn = clearInterval,
}: AppTelemetryRuntimeDependencies) {
  const rendererContexts = new Map<number, TelemetryRendererContext>();
  let pendingStartupTelemetryRendererId: number | null = null;
  let latestRendererContext: TelemetryRendererContext | null = null;
  let interactive = false;

  function reportDailyActive(context: TelemetryRendererContext): void {
    void telemetryCore.reportAppDailyActive(context).catch((error) => {
      onError?.(error);
    });
  }

  function maybeReportDailyActive(): void {
    if (!interactive || latestRendererContext == null) {
      return;
    }

    reportDailyActive(latestRendererContext);
  }

  const dailyActiveHeartbeat = setIntervalFn(
    maybeReportDailyActive,
    dailyActiveHeartbeatIntervalMs,
  );
  if (typeof dailyActiveHeartbeat === "object") {
    dailyActiveHeartbeat.unref?.();
  }

  // 无 pendingStartupTelemetryRendererId 时直接返回；上下文缺失时保留待发；先清空标识再上报。
  function flushStartupTelemetry(): void {
    if (pendingStartupTelemetryRendererId == null) {
      return;
    }

    const context = rendererContexts.get(pendingStartupTelemetryRendererId);
    if (context == null) {
      return;
    }

    pendingStartupTelemetryRendererId = null;
    void telemetryCore.reportAppLaunch(context).catch((error) => {
      onError?.(error);
    });
    reportDailyActive(context);
  }

  // 记录待发 rendererId；立即调用 flushStartupTelemetry 补发；上下文未同步时保持待发。
  function markStartupTelemetryPending(rendererId: number): void {
    pendingStartupTelemetryRendererId = rendererId;
    flushStartupTelemetry();
  }

  return {
    syncRendererContext(input: { rendererId: number; context: TelemetryRendererContext }): void {
      rendererContexts.set(input.rendererId, input.context);
      latestRendererContext = input.context;
      flushStartupTelemetry();
    },

    getLatestRendererContext(): TelemetryRendererContext | null {
      return latestRendererContext;
    },

    getRendererContext(rendererId: number): TelemetryRendererContext | null {
      return rendererContexts.get(rendererId) ?? null;
    },

    setInteractive(nextInteractive: boolean): void {
      const becameInteractive = !interactive && nextInteractive;
      interactive = nextInteractive;
      if (becameInteractive) {
        maybeReportDailyActive();
      }
    },

    onRendererReady(input: { hasPendingOAuthCallback: boolean; rendererId: number }): void {
      if (appLaunchCoordinator.onRendererReady(input)) {
        markStartupTelemetryPending(input.rendererId);
      }
    },

    onOAuthCallbackHandled(input: { rendererId: number }): void {
      if (appLaunchCoordinator.onOAuthCallbackHandled(input)) {
        markStartupTelemetryPending(input.rendererId);
      }
    },

    dispose(): void {
      clearIntervalFn(dailyActiveHeartbeat);
    },
  };
}
