// INV-01 单桥持有：守住位置 模块级桥变量；改错故障：多个窗口各建一套待决表。
// INV-02 装配可空：守住位置 设置入口；改错故障：测试无法卸载桥。
// INV-03 目标回退：守住位置 宿主窗口查找；改错故障：宿主已销毁时弹窗无处可发。
// INV-04 发送必报：守住位置 发送结果；改错故障：推送失败仍等待到超时。
// INV-05 结算一次：守住位置 已结算标记；改错故障：回传与超时都生效，重复决议。
// INV-06 超时删除：守住位置 结算时的清理；改错故障：待决表泄漏。
// INV-07 超时兜底：守住位置 计时器回调；改错故障：无响应请求永远挂起。
// INV-08 载荷校验：守住位置 解析函数；改错故障：畸形回传进入结算。
// INV-09 动作白名单：守住位置 允许集合；改错故障：未知动作被当成有效决议。
// INV-10 专有字段：守住位置 屏幕共享与设备分支；改错故障：缺少标识的决议被放行。
// INV-11 未知忽略：守住位置 待决表命中判断；改错故障：过期请求改写当前弹窗。
// INV-12 设备热更新：守住位置 待决判断；改错故障：已结算请求继续推送设备列表。
// INV-13 同请求复用：守住位置 设备选择标识；改错故障：连续发现被当成新弹窗。
// INV-14 源分组：守住位置 来源标识前缀；改错故障：屏幕与窗口分组错误。
// INV-15 取源失败降级：守住位置 捕获分支；改错故障：屏幕共享异常卡住页面。
// INV-16 回调隔离：守住位置 同步调用包装；改错故障：页面取消被误记为源获取失败。
// INV-17 不抛异常：守住位置 两个入口的失败路径；改错故障：权限桥异常冒泡到主进程。
// INV-18 无隐式状态：守住位置 除桥与待决表外的模块体；改错故障：加载时产生副作用。
//
// 模块职责：main 把内置浏览器的权限决策点转成 EmbeddedBrowserPermissionPrompt 弹窗事件，并接收渲染进程的 EmbeddedBrowserPermissionResolve 决议。
// 状态所有权：待决请求归 createEmbeddedBrowserPermissionUiBridge 工厂实例；模块级变量 activeBridge 只保存当前装配的桥。
// 阅读顺序：接口 → 允许集合 → 装配与取用 → 载荷解析 → 工厂 → 各决策入口。
import { randomUUID } from "node:crypto";
import { BrowserWindow, desktopCapturer, ipcMain, webContents } from "electron";
import {
  PlatformChannels,
  type EmbeddedBrowserPermissionDeviceOption,
  type EmbeddedBrowserPermissionResolveRequest,
} from "@zcode/shared";
import type {
  EmbeddedBrowserPermissionLogger,
  EmbeddedBrowserPermissionPromptAction,
  EmbeddedBrowserPermissionPromptRequest,
} from "./embeddedBrowserPermissionPolicy.js";

/**
 * 内置浏览器权限弹窗的 main ↔ renderer 桥：
 * - promptPermission / devicePicker / onDisplayMediaRequest 把策略模块的决策点
 *   转成 EmbeddedBrowserPermissionPrompt 事件推送到 guest 宿主窗口；
 * - renderer 的用户决策经 EmbeddedBrowserPermissionResolve 回传；
 * - 20s 无响应按 dismiss/cancel 结算（面板不可见或 agent 后台场景自然拒绝）。
 */
export interface EmbeddedBrowserPermissionUiBridge {
  promptPermission(request: EmbeddedBrowserPermissionPromptRequest): Promise<EmbeddedBrowserPermissionPromptAction>;
  devicePicker(input: {
    origin: string;
    permission: string;
    devices: EmbeddedBrowserPermissionDeviceOption[];
    hostWebContentsId?: number;
    guestWebContentsId?: number;
  }): {
    result: Promise<{ deviceId: string } | null>;
    updateDevices(devices: EmbeddedBrowserPermissionDeviceOption[]): void;
  };
  onDisplayMediaRequest(input: { origin: string }, callback: (result: unknown) => void): void;
  registerResolveListener(): void;
}

// ALLOWED_ACTIONS 集合用于收窄回传值。
// 屏幕共享 share-screen 与设备选择 select-device 有独立分支，不在此表。
//
const ALLOWED_ACTIONS = new Set([
  "allow-always",
  "allow-session",
  "block-always",
  "dismiss",
  "cancel",
]);

/**
 * 模块级桥持有者（getPluginSandboxHost 同款模式）：index.ts 启动时装配，
 * desktopWindowChrome 等窗口层直接取用，避免多层 options 透传。
 */
// 桥由模块级变量 activeBridge 持有，启动时由 index.ts 装配一次。
// desktopWindowChrome 等窗口层直接取用，避免层层透传选项。
//
let activeBridge: EmbeddedBrowserPermissionUiBridge | null = null;

// 装配与卸载都走同一入口，传入空即卸载。
// setActiveEmbeddedBrowserPermissionUiBridge 的调用方无需知道内部持有方式。
//
export function setActiveEmbeddedBrowserPermissionUiBridge(
  bridge: EmbeddedBrowserPermissionUiBridge | null,
): void {
  activeBridge = bridge;
}

/** 蓝牙设备选择守卫用的设备选择器；桥未装配时返回 undefined（守卫回退为取消请求）。 */
// 桥未装配时返回空，守卫回退为取消请求。
// bind(activeBridge) 绑定时保留接收者，避免调用丢失上下文。
//
export function getEmbeddedBrowserDevicePicker():
  | EmbeddedBrowserPermissionUiBridge["devicePicker"]
  | undefined {
  return activeBridge?.devicePicker.bind(activeBridge);
}

/** IPC 载荷的运行时校验：requestId 必须是待决请求，resolution 形状必须可识别。 */
// 请求标识必须为非空字符串，动作必须可识别。
// share-screen 要求 sourceId，select-device 要求 deviceId。
//
export function parseEmbeddedBrowserPermissionResolveRequest(
  payload: unknown,
): EmbeddedBrowserPermissionResolveRequest | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as {
    requestId?: unknown;
    resolution?: { action?: unknown; sourceId?: unknown; deviceId?: unknown };
  };
  if (typeof candidate.requestId !== "string" || !candidate.requestId) return null;
  const action = candidate.resolution?.action;
  if (typeof action !== "string") return null;
  if (action === "share-screen") {
    if (typeof candidate.resolution?.sourceId !== "string" || !candidate.resolution.sourceId) {
      return null;
    }
    return {
      requestId: candidate.requestId,
      resolution: { action, sourceId: candidate.resolution.sourceId },
    };
  }
  if (action === "select-device") {
    if (typeof candidate.resolution?.deviceId !== "string" || !candidate.resolution.deviceId) {
      return null;
    }
    return {
      requestId: candidate.requestId,
      resolution: { action, deviceId: candidate.resolution.deviceId },
    };
  }
  if (!ALLOWED_ACTIONS.has(action)) return null;
  return { requestId: candidate.requestId, resolution: { action } as { action: "allow-always" } };
}

// promptTimeoutMs 默认 20_000ms，测试可注入更短值。
// pending 表以 requestId 为键，结算即删除。
//
export function createEmbeddedBrowserPermissionUiBridge(deps: {
  logger: EmbeddedBrowserPermissionLogger;
  /** 弹窗无响应结算时长；测试注入短值。 */
  promptTimeoutMs?: number;
}): EmbeddedBrowserPermissionUiBridge {
  const { logger } = deps;
  const timeoutMs = deps.promptTimeoutMs ?? 20_000;
  // pending 表存放结算函数，超时与回传共用。
  // 键唯一的请求标识保证不会串线。
  //
  const pending = new Map<string, (resolution: unknown) => void>();

  const sendPrompt = (
    hostWebContentsId: number | undefined,
    event: { requestId: string; kind: "permission" | "screen-share" | "device" } & Record<string, unknown>,
  ): boolean => {
    const host =
      (hostWebContentsId !== undefined ? webContents.fromId(hostWebContentsId) : undefined) ??
      BrowserWindow.getFocusedWindow()?.webContents ??
      BrowserWindow.getAllWindows()[0]?.webContents;
    if (!host || host.isDestroyed()) {
      logger.warn("[embedded-browser-permission] prompt target window unavailable");
      return false;
    }
    host.send(PlatformChannels.EmbeddedBrowserPermissionPrompt, event);
    return true;
  };

  /** 建一个待决请求：renderer 决策经 resolver 回来，超时按 fallback 结算。 */
  // 结算函数保证只生效一次，重复回传被忽略。
  // 发送失败或超时都按兜底值结算。
  //
  const openPendingPrompt = <T>(
    hostWebContentsId: number | undefined,
    event: { requestId: string; kind: "permission" | "screen-share" | "device" } & Record<string, unknown>,
    settle: (resolution: unknown) => T,
    fallbackValue: T,
  ): Promise<T> => {
    const { requestId } = event;
    return new Promise<T>((resolve) => {
      let settled = false;
      const finish = (value: T) => {
        if (settled) return;
        settled = true;
        pending.delete(requestId);
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        logger.info("[embedded-browser-permission] decision=denied", {
          requestId,
          source: "prompt-timeout",
        });
        finish(fallbackValue);
      }, timeoutMs);
      pending.set(requestId, (resolution) => finish(settle(resolution)));
      if (!sendPrompt(hostWebContentsId, event)) finish(fallbackValue);
    });
  };

  return {
    promptPermission(request) {
      return openPendingPrompt(
        request.hostWebContentsId,
        {
          requestId: randomUUID(),
          kind: "permission",
          origin: request.origin,
          permission: request.permission,
          ...(request.mediaTypes ? { mediaTypes: [...request.mediaTypes] } : {}),
          ...(request.guestWebContentsId !== undefined
            ? { guestWebContentsId: request.guestWebContentsId }
            : {}),
        },
        (resolution) => {
          const action = (resolution as { action?: string })?.action;
          return (["allow-always", "allow-session", "block-always", "dismiss"] as const).includes(
            action as never,
          )
            ? (action as EmbeddedBrowserPermissionPromptAction)
            : "dismiss";
        },
        "dismiss" as const,
      );
    },

    devicePicker(input) {
      // requestId 显式生成并保留在闭包：设备发现过程中 select-* 会连续 fire，
      // 同 requestId 的后续推送被 renderer 当作列表热更新而不是新弹窗。
      const requestId = randomUUID();
      const result = openPendingPrompt(
        input.hostWebContentsId,
        {
          requestId,
          kind: "device",
          origin: input.origin,
          permission: input.permission,
          devices: input.devices,
          ...(input.guestWebContentsId !== undefined
            ? { guestWebContentsId: input.guestWebContentsId }
            : {}),
        },
        (resolution) => {
          const candidate = resolution as { action?: string; deviceId?: string };
          return candidate?.action === "select-device" && candidate.deviceId
            ? { deviceId: candidate.deviceId }
            : null;
        },
        null,
      );
      return {
        result,
        updateDevices: (devices) => {
          if (!pending.has(requestId)) return;
          sendPrompt(input.hostWebContentsId, {
            requestId,
            kind: "device",
            origin: input.origin,
            permission: input.permission,
            devices,
            ...(input.guestWebContentsId !== undefined
              ? { guestWebContentsId: input.guestWebContentsId }
              : {}),
          });
        },
      };
    },

    onDisplayMediaRequest(input, callback) {
      void desktopCapturer
        .getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } })
        .then(async (sources) => {
          const picked = await openPendingPrompt(
            undefined,
            {
              requestId: randomUUID(),
              kind: "screen-share",
              origin: input.origin,
              screens: sources.map((source) => ({
                sourceId: source.id,
                name: source.name,
                // source.id 形如 "screen:0:0" / "window:12345:0"，据此在 UI 分组展示。
                kind: source.id.startsWith("screen:") ? ("screen" as const) : ("window" as const),
                thumbnailDataUrl: `data:image/jpeg;base64,${source.thumbnail.toJPEG(60).toString("base64")}`,
              })),
            },
            (resolution) => {
              const candidate = resolution as { action?: string; sourceId?: string };
              return candidate?.action === "share-screen" ? (candidate.sourceId ?? null) : null;
            },
            null,
          );
          const source = picked ? sources.find((candidate) => candidate.id === picked) : undefined;
          invokeDisplayMediaCallback(callback, source ? { video: source } : {});
        })
        .catch((error: unknown) => {
          logger.warn("[embedded-browser-permission] screen share sources unavailable:", error);
          invokeDisplayMediaCallback(callback, {});
        });
    },

    // registerResolveListener 只处理 parseEmbeddedBrowserPermissionResolveRequest 能解析且 pending 仍命中的载荷。
    // 畸形或未知请求只告警，不进入结算。
    //
    registerResolveListener() {
      ipcMain.on(PlatformChannels.EmbeddedBrowserPermissionResolve, (_event, payload: unknown) => {
        const parsed = parseEmbeddedBrowserPermissionResolveRequest(payload);
        const resolver = parsed ? pending.get(parsed.requestId) : undefined;
        if (!parsed || !resolver) {
          logger.warn("[embedded-browser-permission] ignored malformed or unknown resolve payload");
          return;
        }
        resolver(parsed.resolution);
      });
    },
  };
}


/**
 * Electron 41 在「页面请求了 video 但回调未提供流」时会从 callback 内部同步抛
 * TypeError（用户取消共享的正常路径）；直接在 promise 链里调用会被外层 catch 误记为
 * 源获取失败并二次回调。此处隔离后不再向外传播。
 */
// invokeDisplayMediaCallback 内同步抛错被隔离，不再向外传播。
// 页面侧已按取消路径收尾，invokeDisplayMediaCallback 无需额外处理。
//
function invokeDisplayMediaCallback(
  callback: (result: unknown) => void,
  result: unknown,
): void {
  try {
    callback(result);
  } catch {
    // 页面侧已按取消/拒绝路径收尾，无需处理。
  }
}
