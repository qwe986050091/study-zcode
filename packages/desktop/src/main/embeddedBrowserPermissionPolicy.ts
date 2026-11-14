// INV-01 默认拒绝兜底：守住位置 末尾分支；改错故障 新枚举权限被自动放行。
// INV-02 白名单只放行无害权限：守住位置 常量集合；改错故障 敏感权限无需询问。
// INV-03 提示类权限逐条列举：守住位置 集合成员；改错故障 相邻权限被顺带放行。
// INV-04 设备类检查放行到选择器：守住位置 检查分支；改错故障 设备请求在检查层被拦死。
// INV-05 未知来源归为占位键：守住位置 捕获分支；改错故障 非法地址导致策略崩溃。
// INV-06 站点记录优先于会话记录：守住位置 分支顺序；改错故障 长期选择被临时放行覆盖。
// INV-07 会话放行只存内存：守住位置 局部映射；改错故障 临时同意被写进磁盘。
// INV-08 无弹窗层时敏感权限一律拒绝：守住位置 空值判断；改错故障 未接弹窗也静默放行。
// INV-09 同源同权限共享一次询问：守住位置 在途映射；改错故障 连续请求弹出多个窗口。
// INV-10 询问结算后清理在途项：守住位置 终态回调；改错故障 失败后永远拿不到新询问。
// INV-11 询问失败按拒绝结算：守住位置 第二参数；改错故障 异常时回调永不返回。
// INV-12 永远允许写入持久记录：守住位置 条件分支；改错故障 下次访问仍要询问。
// INV-13 设备选择器全局只开一个：守住位置 会话映射；改错故障 每次发现设备都新开窗。
// INV-14 后续事件只热更新列表：守住位置 已存在分支；改错故障 第二次回调覆盖首次结算。
// INV-15 取消参数按权限区分：守住位置 三元映射；改错故障 串口取消传错取值。
// INV-16 选择器异常按取消结算：守住位置 捕获分支；改错故障 页面请求悬挂不返回。
// INV-17 设备事件先阻止默认：守住位置 处理首行；改错故障 异步选择永远来不及。
// INV-18 屏幕共享缺桥接即拒绝：守住位置 回调前判断；改错故障 未选源也返回成功。
//
// 模块职责：为内置浏览器分区注册默认拒绝的权限闸门。
// 状态所有权：站点记录持久化，会话放行与设备选择器只存内存。
// 阅读顺序：先看三张权限表，再看请求分支，最后看检查与设备事件。
import type { Session, Streams } from "electron";
import type { EmbeddedBrowserPermissionDeviceOption } from "@zcode/shared";
import { readDeviceOptions } from "./embeddedBrowserDeviceOptions.js";
import {
  getEmbeddedBrowserSitePermission,
  initEmbeddedBrowserSitePermissions,
  writeEmbeddedBrowserSitePermission,
} from "./embeddedBrowserSitePermissions.js";

/**
 * 内置浏览器 partition 的权限闸门（CNVD「内置浏览器未授权访问」修复，spec 见
 * docs/browser-use/2026-10-08-embedded-browser-permission-governance-spec.md）。
 *
 * Electron 未设置 permission handler 的 session 会自动批准所有权限请求，恶意页面可静默
 * 拿到摄像头/麦克风/剪贴板/地理位置；设备类 API 未监听 select-* 事件时还会静默授权
 * 第一个匹配设备。本模块对该 partition 注册默认拒绝的 request/check/device/displayMedia
 * handler：无害权限白名单放行，敏感权限经产品级弹窗由用户决策，其余 fail-closed。
 *
 * 分步实施：prompt 未注入时敏感权限一律拒绝（安全闭环先行）；弹窗层接入后按用户选择
 * 回写内存 sessionAllow 或持久 store。
 */

export const EMBEDDED_BROWSER_SILENT_ALLOW_PERMISSIONS: ReadonlySet<string> = new Set([
  // 写剪贴板对应网页「复制」按钮、fullscreen/pointerLock 对应视频全屏与交互、
  // mediaKeySystem 对应 DRM 视频播放：拒绝会造成大面积功能性故障，且不泄露用户数据。
  "clipboard-sanitized-write",
  "fullscreen",
  "pointerLock",
  "mediaKeySystem",
]);

const PROMPT_PERMISSIONS: ReadonlySet<string> = new Set([
  "media",
  "clipboard-read",
  "geolocation",
  "notifications",
  "midi",
  "midiSysex",
  "idle-detection",
  "speaker-selection",
  "window-management",
  "storage-access",
  "top-level-storage-access",
  "keyboardLock",
  "fileSystem",
]);

/** check handler 枚举里的设备类权限：放行到 select-* chooser（见 check handler 注释）。 */
const DEVICE_CHECK_PERMISSIONS: ReadonlySet<string> = new Set(["usb", "hid", "serial"]);

export type EmbeddedBrowserPermissionPromptAction =
  | "allow-always"
  | "allow-session"
  | "block-always"
  | "dismiss";

export interface EmbeddedBrowserPermissionPromptRequest {
  origin: string;
  permission: string;
  mediaTypes?: readonly string[];
  /** 触发请求的 guest 的宿主 renderer webContents id，弹窗据此路由到正确窗口。 */
  hostWebContentsId?: number;
  /** 发起请求的 guest 自身 webContents id，renderer 据此只在归属 tab 渲染。 */
  guestWebContentsId?: number;
}

export interface EmbeddedBrowserSitePermissionRecord {
  [origin: string]: { [permission: string]: "allow" | "deny" };
}

export interface EmbeddedBrowserSitePermissionStore {
  load(): Promise<EmbeddedBrowserSitePermissionRecord>;
  persist(record: EmbeddedBrowserSitePermissionRecord): Promise<void>;
}

export interface EmbeddedBrowserPermissionLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export type EmbeddedBrowserPermissionSession = Session;

export interface EmbeddedBrowserDevicePickerSession {
  result: Promise<{ deviceId: string } | null>;
  updateDevices(devices: EmbeddedBrowserPermissionDeviceOption[]): void;
}

export interface EmbeddedBrowserPermissionPolicyOptions {
  logger: EmbeddedBrowserPermissionLogger;
  /** 弹窗层（Step 2）注入；缺省时敏感权限一律拒绝。 */
  prompt?: (
    request: EmbeddedBrowserPermissionPromptRequest,
  ) => Promise<EmbeddedBrowserPermissionPromptAction>;
  /** 持久站点同意记录（Step 2/3）；缺省时决策只依赖内存。 */
  store?: EmbeddedBrowserSitePermissionStore;
  /**
   * 设备选择器（Step 2）注入；返回 session 句柄：result 结算选中的 deviceId
   * （null 取消），updateDevices 在选择器打开期间热更新设备列表（蓝牙扫描 /
   * USB 枚举会连续 fire select-*，同一权限只开一个选择器）。
   * 缺省时 select-* 一律取消（阻断 Electron 静默授权第一个设备的默认行为）。
   */
  devicePicker?: (input: {
    origin: string;
    permission: string;
    devices: EmbeddedBrowserPermissionDeviceOption[];
    hostWebContentsId?: number;
    guestWebContentsId?: number;
  }) => EmbeddedBrowserDevicePickerSession;
  /**
   * 屏幕共享源选择（Step 2）注入；源列表与 callback 语义需要 desktopCapturer
   * 上下文，整体转发给 bridge，policy 只保留日志与默认拒绝。
   */
  onDisplayMediaRequest?: (input: { origin: string }, callback: (result: unknown) => void) => void;
}

export const EMBEDDED_BROWSER_PERMISSION_LOG_TAG = "[embedded-browser-permission]";
const LOG_TAG = EMBEDDED_BROWSER_PERMISSION_LOG_TAG;
const UNKNOWN_ORIGIN = "unknown";

// 非法地址必须归为 UNKNOWN_ORIGIN 占位来源；originFromUrl 只取协议与主机；尾部路径不参与来源。
export function originFromUrl(url: string | undefined): string {
  try {
    return new URL(url ?? "").origin;
  } catch {
    return UNKNOWN_ORIGIN;
  }
}

// 必须先 initEmbeddedBrowserSitePermissions 初始化站点记录；sessionAllow 只存内存；在途询问按 origin 与 permission 聚合；四类处理函数全部注册。
export async function applyEmbeddedBrowserPermissionPolicy(
  targetSession: EmbeddedBrowserPermissionSession,
  options: EmbeddedBrowserPermissionPolicyOptions,
): Promise<void> {
  const { logger } = options;

  // 站点同意记录常驻内存（check handler 需同步读取），由独立管理器负责加载与落盘，
  // 设置页「网站权限」与「清除浏览器数据」也经同一管理器，保证决策口径一致。
  await initEmbeddedBrowserSitePermissions({
    ...(options.store ? { store: options.store } : {}),
    logger,
  });

  const sessionAllow = new Map<string, Set<string>>();
  const inflight = new Map<string, Promise<EmbeddedBrowserPermissionPromptAction>>();

  const logDecision = (
    decision: "granted" | "denied",
    meta: Record<string, unknown>,
    warn = false,
  ): void => {
    const message = `${LOG_TAG} decision=${decision}`;
    if (warn) logger.warn(message, meta);
    else logger.info(message, meta);
  };

  // EMBEDDED_BROWSER_SILENT_ALLOW_PERMISSIONS 命中时直接放行；站点记录先于 sessionAllow；无 options.prompt 时默认拒绝；未知权限按拒绝处理。
  targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    // details 是 Electron 的四类 PermissionRequest 联合（media 带 mediaTypes、fileSystem
    // 带 filePaths 等），此处按需断言读取，不做结构假设。
    const requestingUrl = (details as { requestingUrl?: string }).requestingUrl;
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes;
    const origin = originFromUrl(requestingUrl);
    // guest 的宿主 renderer 即弹窗应显示的窗口；非 webview 场景缺省回落到 guest 自身。
    const hostWebContentsId = webContents.hostWebContents?.id ?? webContents.id;
    const guestWebContentsId = webContents.id;

    if (EMBEDDED_BROWSER_SILENT_ALLOW_PERMISSIONS.has(permission)) {
      logDecision("granted", { permission, origin, source: "allowlist" });
      callback(true);
      return;
    }

    if (PROMPT_PERMISSIONS.has(permission)) {
      const persisted = getEmbeddedBrowserSitePermission(origin, permission);
      if (persisted === "allow" || persisted === "deny") {
        logDecision(persisted === "allow" ? "granted" : "denied", {
          permission,
          origin,
          source: "site-setting",
        });
        callback(persisted === "allow");
        return;
      }
      if (sessionAllow.get(origin)?.has(permission)) {
        logDecision("granted", { permission, origin, source: "session-allow" });
        callback(true);
        return;
      }
      if (!options.prompt) {
        logDecision("denied", { permission, origin, source: "default-deny" });
        callback(false);
        return;
      }
      // 同 origin+权限并发请求共享一个弹窗（pluginSandbox permissionGate 同款 inflight 模式）。
      const key = `${origin}|${permission}`;
      let flight = inflight.get(key);
      if (!flight) {
        flight = options
          .prompt({
            origin,
            permission,
            hostWebContentsId,
            guestWebContentsId,
            ...(mediaTypes ? { mediaTypes } : {}),
          })
          .finally(() => {
            inflight.delete(key);
          });
        inflight.set(key, flight);
      }
      void flight.then(
        (action) => {
          const granted = action === "allow-always" || action === "allow-session";
          logDecision(granted ? "granted" : "denied", {
            permission,
            origin,
            source: "user-prompt",
            action,
          });
          if (action === "allow-always") {
            void writeEmbeddedBrowserSitePermission(origin, permission, "allow");
          } else if (action === "allow-session") {
            const grantedSet = sessionAllow.get(origin) ?? new Set<string>();
            grantedSet.add(permission);
            sessionAllow.set(origin, grantedSet);
          } else if (action === "block-always") {
            void writeEmbeddedBrowserSitePermission(origin, permission, "deny");
          }
          callback(granted);
        },
        (error: unknown) => {
          logger.warn(`${LOG_TAG} permission prompt failed: ${String(error)}`);
          callback(false);
        },
      );
      return;
    }

    // openExternal 由内置浏览器既有开窗路由负责；未识别权限 fail-closed，防 Electron
    // 后续版本新增枚举绕过白名单。
    logDecision("denied", { permission, origin, source: "default-deny" }, true);
    callback(false);
  });

  // 检查层只读不询问；DEVICE_CHECK_PERMISSIONS 放行到选择器；来源键必须与请求层保持一致。
  targetSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    if (EMBEDDED_BROWSER_SILENT_ALLOW_PERMISSIONS.has(permission)) return true;
    // 设备类 permission check：实测返回 false 会把 requestDevice/requestPort 在
    // check 层直接拦死（零 select-* 日志、页面拿 NotAllowedError），chooser 根本
    // 不触发——select-serial-port 的文档明确 serial 权限由 check handler 管理。
    // 与 setDevicePermissionHandler 恒 true 同理放行到 chooser；设备授权由
    // select-* 监听独占把关（未选择不授权）。蓝牙不在 check 枚举里，不受影响。
    if (DEVICE_CHECK_PERMISSIONS.has(permission)) return true;
    if (!PROMPT_PERMISSIONS.has(permission)) return false;
    // Electron check 可能传入带尾部斜杠或路径的 URL；必须与 request 使用相同的 origin 键。
    const origin = originFromUrl(requestingOrigin);
    if (getEmbeddedBrowserSitePermission(origin, permission) === "allow") return true;
    return sessionAllow.get(origin)?.has(permission) === true;
  });

  // 实测语义修正：setDevicePermissionHandler 返回 false 会把 requestDevice 直接拦死
  // （NotAllowedError），select-* chooser 根本不触发（permission.site 的 USB/HID/Serial
  // 请求曾因此无弹窗、无 select 日志）。真正的安全闸门是下方 select-* 监听：
  // 未监听时 Electron 才会静默授权第一个设备；我们 apply 恒注册监听（单测断言），
  // 因此 handler 恒 true 只表示「放行到 chooser」，不构成授权。
  targetSession.setDevicePermissionHandler(() => true);

  targetSession.setDisplayMediaRequestHandler((request, callback) => {
    const frameUrl = (request as { frame?: { url?: string } }).frame?.url;
    const origin = originFromUrl(frameUrl);
    if (options.onDisplayMediaRequest) {
      // 源选择需要 desktopCapturer 上下文与 Electron 专属 callback 语义，整体转发给 bridge。
      logDecision("granted", { permission: "display-capture", origin, source: "source-picker" });
      options.onDisplayMediaRequest({ origin }, (result) => callback(result as Streams));
      return;
    }
    logDecision("denied", { permission: "display-capture", origin, source: "default-deny" });
    callback({});
  });

  // Electron 未监听 select-* 事件时会静默授权第一个匹配设备；注册监听即阻断该路径。
  // 取消语义：hid/usb 不传参，serial 空串。设备选择器注入后按用户选择回调 deviceId。
  const cancelArgFor = (permission: string): string | undefined =>
    permission === "select-hid-device" || permission === "select-usb-device" ? undefined : "";

  // 同权限的设备选择器全局只开一个：select-* 事件会在设备发现过程中连续 fire
  // （蓝牙扫描渐进出设备、USB 枚举同理），后续 fire 只热更新列表；Chromium 语义为
  // 「callback 结算前重复 fire 同一请求」，因此后续 fire 携带的 callback 不再调用。
  const devicePickerSessions = new Map<string, EmbeddedBrowserDevicePickerSession>();

  const settleDeviceSelection = (
    permission: string,
    input: {
      origin: string;
      devices: EmbeddedBrowserPermissionDeviceOption[];
      hostWebContentsId?: number;
      guestWebContentsId?: number;
    },
    callback: (value?: string) => void,
  ): void => {
    const cancel = cancelArgFor(permission);
    if (!options.devicePicker) {
      logDecision("denied", { permission, origin: input.origin, source: "device-picker" });
      callback(cancel);
      return;
    }
    const existing = devicePickerSessions.get(permission);
    if (existing) {
      // 诊断蓝牙/USB 渐进枚举：热更新时记录可见设备数（列表为空可据此定位 TCC 权限问题）
      logger.info(`${LOG_TAG} device list updated`, {
        permission,
        origin: input.origin,
        deviceCount: input.devices.length,
      });
      existing.updateDevices(input.devices);
      return;
    }
    let session: EmbeddedBrowserDevicePickerSession;
    try {
      session = options.devicePicker({ ...input, permission });
    } catch (error) {
      logger.warn(`${LOG_TAG} device picker failed: ${String(error)}`);
      callback(cancel);
      return;
    }
    devicePickerSessions.set(permission, session);
    logger.info(`${LOG_TAG} device picker opened`, {
      permission,
      origin: input.origin,
      deviceCount: input.devices.length,
    });
    void session.result.then(
      (picked) => {
        devicePickerSessions.delete(permission);
        if (!picked) {
          logDecision("denied", { permission, origin: input.origin, source: "device-picker" });
          callback(cancel);
          return;
        }
        logDecision("granted", { permission, origin: input.origin, source: "device-picker" });
        callback(picked.deviceId);
      },
      (error: unknown) => {
        devicePickerSessions.delete(permission);
        logger.warn(`${LOG_TAG} device picker failed: ${String(error)}`);
        callback(cancel);
      },
    );
  };

  // hid/usb: (event, details { deviceList, frame }, callback)
  const handleFramedDeviceSelection = (permission: string) => {
    return (event: unknown, details: unknown, callback: (value?: string) => void) => {
      // 必须阻止默认行为，否则 Chromium 在事件 fire 后立即以「未选择设备」取消
      // 页面请求，异步回调无法生效（对照实验：加 preventDefault 后 4s 异步选择正常）。
      (event as { preventDefault?: () => void }).preventDefault?.();
      const frameUrl = (details as { frame?: { url?: string } | null })?.frame?.url;
      const deviceList = (details as { deviceList?: unknown })?.deviceList;
      settleDeviceSelection(
        permission,
        {
          origin: originFromUrl(frameUrl),
          devices: readDeviceOptions(deviceList),
        },
        callback,
      );
    };
  };
  targetSession.on("select-hid-device", handleFramedDeviceSelection("select-hid-device"));
  targetSession.on("select-usb-device", handleFramedDeviceSelection("select-usb-device"));

  // serial: (event, portList, webContents, callback(portId: string))；空串取消
  targetSession.on(
    "select-serial-port",
    (
      event: unknown,
      portList: unknown,
      webContents: unknown,
      callback: (portId: string) => void,
    ) => {
      // 同 hid/usb：阻止默认取消，等待用户选择。
      (event as { preventDefault?: () => void }).preventDefault?.();
      const contents = webContents as {
        hostWebContents?: { id?: number };
        id?: number;
        getURL?: () => string;
      } | null;
      const hostWebContentsId = contents?.hostWebContents?.id ?? contents?.id;
      settleDeviceSelection(
        "select-serial-port",
        {
          origin: originFromUrl(contents?.getURL?.()),
          devices: readDeviceOptions(portList),
          ...(hostWebContentsId !== undefined ? { hostWebContentsId } : {}),
        },
        (value) => callback(value ?? ""),
      );
    },
  );
}
