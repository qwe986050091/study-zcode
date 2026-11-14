// INV-01 注册即返回清理函数：守住位置 函数末尾；改错故障 窗口重载后重复注册 IPC。
// INV-02 配置读取先解析运行时覆盖：守住位置 初始化；改错故障 环境变量开关不生效。
// INV-03 变更才广播：守住位置 序列化比较；改错故障 每分钟向所有窗口推送等值配置。
// INV-04 已销毁窗口跳过：守住位置 发送前判断；改错故障 向失效窗口发送抛异常。
// INV-05 上报先校验对象：守住位置 类型守卫；改错故障 非对象输入进入绑定流程。
// INV-06 实例标识必须非空：守住位置 字符串判断；改错故障 空标识被当成有效实例。
// INV-07 首次上报即绑定：守住位置 空值合并；改错故障 每批都重建生命周期监听。
// INV-08 过期实例拒收：守住位置 集合判断；改错故障 旧页面数据污染新会话。
// INV-09 实例切换拒收：守住位置 不一致分支；改错故障 两个页面共用同一发送方。
// INV-10 加载与导航都退休实例：守住位置 两个监听；改错故障 旧实例仍被认为有效。
// INV-11 同一次加载不二次退休：守住位置 标志位；改错故障 新实例被立刻标记过期。
// INV-12 销毁时清理监听：守住位置 dispose；改错故障 监听器随窗口泄漏。
// INV-13 定时器不阻止退出：守住位置 unref；改错故障 进程因定时器无法结束。
// INV-14 定时刷新失败只记调试：守住位置 捕获分支；改错故障 瞬时失败刷满告警日志。
// INV-15 清理恢复注册前状态：守住位置 返回函数；改错故障 热重载后通道残留。
// INV-16 本地开关只加本地档：守住位置 首次覆盖；改错故障 打开追踪时丢掉账号配置。
// INV-17 显式开关才全量采样：守住位置 早退分支；改错故障 生产环境默认全量采集。
// INV-18 真值集合固定：守住位置 判定函数；改错故障 大小写或空白写法被误判为开。
//
// 模块职责：注册渲染进程动作追踪的 IPC 通道与实例生命周期绑定。
// 状态所有权：模块内 rendererInstances 映射保存每个发送方的当前实例与过期集合。
// 阅读顺序：先看注册入口，再看生命周期绑定，最后看配置解析与清理。
import { BrowserWindow, ipcMain } from "electron";
import {
  DISABLED_RENDERER_ACTION_TRACE_CONFIG,
  PlatformChannels,
  type RendererActionTraceConfigV1,
} from "@zcode/shared";
import type { RendererActionTraceBroker } from "./rendererActionTraceBroker.js";
import type { RendererActionTraceRollout } from "./rendererActionTraceRollout.js";

const RENDERER_ACTION_TRACE_REFRESH_INTERVAL_MS = 60_000;

// 注册前必须先用 resolveRuntimeConfig 解析一次配置；rendererInstances 以 senderId 为键；生命周期绑定按需建立；定时刷新与手动读取共用 refresh；返回值必须撤销全部注册。
export function registerRendererActionTraceIpc(options: {
  rollout: RendererActionTraceRollout;
  broker: RendererActionTraceBroker;
  env?: Record<string, string | undefined>;
  logger: {
    debug(...args: unknown[]): void;
    warn(...args: unknown[]): void;
  };
}): () => void {
  type RendererInstanceBinding = {
    current?: string;
    stale: Set<string>;
    dispose: () => void;
  };
  const rendererInstances = new Map<number, RendererInstanceBinding>();
  // 四个事件覆盖加载与销毁；退休只把实例加入 stale 而不立即删除；did-navigate 必须区分同次加载；destroyed 时移除监听并清表；绑定结果回传给上报处理。
  const bindRendererLifecycle = (sender: Electron.WebContents, senderId: number) => {
    let awaitingNewInstance = false;
    const binding: RendererInstanceBinding = {
      stale: new Set(),
      dispose: () => {
        sender.removeListener("did-start-loading", reset);
        sender.removeListener("did-navigate", completeNavigation);
        sender.removeListener("render-process-gone", reset);
        sender.removeListener("destroyed", destroy);
      },
    };
    const reset = () => {
      if (binding.current) {
        binding.stale.add(binding.current);
        binding.current = undefined;
      }
      awaitingNewInstance = true;
    };
    const completeNavigation = () => {
      // did-start-loading 与 did-navigate 可能属于同一次加载，避免二次退休新实例。
      if (awaitingNewInstance) {
        awaitingNewInstance = false;
        return;
      }
      reset();
    };
    const destroy = () => {
      binding.dispose();
      rendererInstances.delete(senderId);
    };
    sender.on("did-start-loading", reset);
    sender.on("did-navigate", completeNavigation);
    sender.on("render-process-gone", reset);
    sender.once("destroyed", destroy);
    rendererInstances.set(senderId, binding);
    return binding;
  };
  let lastConfig = resolveRuntimeConfig(options.rollout.getSnapshot(), options.env ?? process.env);

  // refresh 会读取 rollout 最新快照；JSON.stringify 值相同则不发广播；变化时遍历 BrowserWindow.getAllWindows()；发送后仍返回新配置。
  const refresh = async (): Promise<RendererActionTraceConfigV1> => {
    const next = resolveRuntimeConfig(await options.rollout.refresh(), options.env ?? process.env);
    if (JSON.stringify(next) !== JSON.stringify(lastConfig)) {
      lastConfig = next;
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(PlatformChannels.RendererActionTraceConfigChanged, next);
        }
      }
    }
    return next;
  };

  ipcMain.handle(PlatformChannels.GetRendererActionTraceConfig, refresh);
  // 必须先校验 batch 形状与 rendererInstanceId；首次上报才建立绑定；过期或切换的实例直接丢弃。
  // 合法批次交给 broker 排队。
  ipcMain.on(PlatformChannels.ReportRendererActionTraceBatch, (event, batch: unknown) => {
    if (typeof batch !== "object" || batch === null) return;
    const rendererInstanceId = (batch as { rendererInstanceId?: unknown }).rendererInstanceId;
    if (typeof rendererInstanceId !== "string" || rendererInstanceId.length === 0) return;
    const senderId = event.sender.id;
    const binding =
      rendererInstances.get(senderId) ?? bindRendererLifecycle(event.sender, senderId);
    if (binding.stale.has(rendererInstanceId)) {
      options.logger.warn("[renderer-action-trace] stale renderer instance for sender", {
        senderId,
      });
      return;
    }
    if (binding.current && binding.current !== rendererInstanceId) {
      options.logger.warn("[renderer-action-trace] renderer instance changed for sender", {
        senderId,
      });
      return;
    }
    binding.current ??= rendererInstanceId;
    options.broker.enqueue(batch);
  });

  const refreshTimer = setInterval(() => {
    void refresh().catch((error) => {
      options.logger.debug("[renderer-action-trace] refresh failed", { error });
    });
  }, RENDERER_ACTION_TRACE_REFRESH_INTERVAL_MS);
  refreshTimer.unref();

  return () => {
    clearInterval(refreshTimer);
    ipcMain.removeHandler(PlatformChannels.GetRendererActionTraceConfig);
    ipcMain.removeAllListeners(PlatformChannels.ReportRendererActionTraceBatch);
    for (const binding of rendererInstances.values()) binding.dispose();
    rendererInstances.clear();
  };
}

export function resolveRuntimeConfig(
  config: RendererActionTraceConfigV1,
  env: Record<string, string | undefined>,
): RendererActionTraceConfigV1 {
  if (isTruthy(env.ZCODE_LOCAL_TTFT_ENABLED)) config = { ...config, localTtftEnabled: true };
  if (!isTruthy(env.ZCODE_RENDERER_ACTION_TRACE_ENABLED)) return config;
  return {
    ...config,
    enabled: true,
    sampleRatio: 1,
    enabledGroups: ["core", "settings"],
    configVersion: "local-explicit",
  } as RendererActionTraceConfigV1;
}

export function disabledRendererActionTraceConfig(): RendererActionTraceConfigV1 {
  return { ...DISABLED_RENDERER_ACTION_TRACE_CONFIG };
}

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
