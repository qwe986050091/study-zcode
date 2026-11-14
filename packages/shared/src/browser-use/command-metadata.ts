// INV-01 尺寸边界是单一事实源：守住位置 常量对象；改错故障 画布与接口各写一套上下限。
// INV-02 代理视口与人类偏好分离：守住位置 两套常量；改错故障 代理打开页面继承用户缩放。
// INV-03 基础尺寸只要求正数：守住位置 整数正判断；改错故障 零宽视口进入渲染。
// INV-04 输入尺寸再夹边界：守住位置 扩展 schema；改错故障 超大视口撑爆窗口。
// INV-05 缩放档位固定枚举：守住位置 常量数组；改错故障 前端传入任意比例。
// INV-06 默认缩放为适应：守住位置 默认值；改错故障 首开缩放比例不符合预期。
// INV-07 人类偏好不含运行态：守住位置 类型注释；改错故障 代理运行态写入用户偏好。
// INV-08 偏好结构严格校验：守住位置 严格模式；改错故障 多余字段被静默持久化。
// INV-09 默认偏好给手机尺寸：守住位置 默认对象；改错故障 首开桌面尺寸与布局不符。
// INV-10 命令方法集集中枚举：守住位置 判别字段；改错故障 新命令在两端名称不一致。
// INV-11 方法名即协议契约：守住位置 枚举值；改错故障 客户端与服务端分叉。
// INV-12 客户端模式决定重放边界：守住位置 模式枚举；改错故障 手机端执行不可重放命令。
// INV-13 会话上下文必填：守住位置 最小长度；改错故障 空标识跨会话串扰。
// INV-14 工作区键可回落路径：守住位置 字段注释；改错故障 远端工作区互相隔离失败。
// INV-15 受控标签缺省合法：守住位置 可选字段；改错故障 未指定标签时直接报错。
// INV-16 错误码不静默兜底：守住位置 固定枚举；改错故障 失败原因被压成通用错误。
// INV-17 页面状态字段最小：守住位置 接口定义；改错故障 把内部调试字段暴露给模型。
// INV-18 可选滚动与视口字段：守住位置 可选标记；改错故障 老版本回传缺字段时校验失败。
//
// 模块职责：browser-use 命令与页面状态的共享 schema 与常量。
// 状态所有权：无状态；只有常量与校验器，不持有运行时数据。
// 阅读顺序：先看视口边界与缩放，再看人类偏好，最后看命令方法与错误码。
import { z } from "zod";

/** 内置自由尺寸与 Agent viewport API 共用同一组 CSS px 安全边界。 */
// minWidth 与 maxWidth、minHeight 与 maxHeight 成对出现。
// 数值按 CSS 像素计。
// 常量冻结，避免被调用方改写。
// 画布与接口共用这一组边界。
export const BROWSER_VIEWPORT_LIMITS = {
  minWidth: 320,
  maxWidth: 3840,
  minHeight: 320,
  maxHeight: 2160,
} as const;

/** Agent 创建或打开的新页面使用的固定逻辑 viewport；不属于人类浏览器显示偏好。 */
export const DEFAULT_AGENT_BROWSER_VIEWPORT = {
  width: 1280,
  height: 720,
} as const;

export const browserViewportSizeSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
export type BrowserViewportSize = z.infer<typeof browserViewportSizeSchema>;

/** setViewportSize 输入边界；实际自然 viewport 可能大于自由尺寸画布上限。 */
// 在 browserViewportSizeSchema 上追加范围约束。
// 整数与正数继承自基础 schema。
// 只校验 setViewportSize 入参，不约束自然视口。
export const browserViewportInputSchema = browserViewportSizeSchema.extend({
  width: z
    .number()
    .int()
    .min(BROWSER_VIEWPORT_LIMITS.minWidth)
    .max(BROWSER_VIEWPORT_LIMITS.maxWidth),
  height: z
    .number()
    .int()
    .min(BROWSER_VIEWPORT_LIMITS.minHeight)
    .max(BROWSER_VIEWPORT_LIMITS.maxHeight),
});

export const BROWSER_VIEWPORT_ZOOM_OPTIONS = [
  "fit",
  "50",
  "75",
  "100",
  "125",
  "150",
  "200",
] as const;
export const browserViewportZoomSchema = z.enum(BROWSER_VIEWPORT_ZOOM_OPTIONS);
export type BrowserViewportZoom = z.infer<typeof browserViewportZoomSchema>;

export const DEFAULT_BROWSER_VIEWPORT_ZOOM: BrowserViewportZoom = "fit";

/** 仅用于人类用户主动打开 Browser tab 的显示偏好；Agent viewport 运行态不得读写。 */
// 只描述人类主动打开的 Browser tab。
// mode 决定是否按 responsive 展示。
// strict() 拒绝多余字段。
export const embeddedBrowserViewportPreferenceSchema = z
  .object({
    mode: z.enum(["normal", "responsive"]),
    viewport: browserViewportInputSchema,
    zoom: browserViewportZoomSchema,
  })
  .strict();
export type EmbeddedBrowserViewportPreference = z.infer<
  typeof embeddedBrowserViewportPreferenceSchema
>;

export const DEFAULT_EMBEDDED_BROWSER_VIEWPORT_PREFERENCE: EmbeddedBrowserViewportPreference = {
  mode: "normal",
  viewport: { width: 393, height: 852 },
  zoom: DEFAULT_BROWSER_VIEWPORT_ZOOM,
};

/** browser-use 的统一命令方法集，各分支由 BrowserCommand 的 method 判别。 */
// 方法名作为 BrowserCommand.method 的判别字段值。
// 两端共享同一份 browserCommandMethodSchema 枚举。
// 新增命令必须同时更新这里与分派表。
export const browserCommandMethodSchema = z.enum([
  "navigate",
  "back",
  "forward",
  "reload",
  "snapshot",
  "click",
  "fill",
  "type",
  "press",
  "cuaKeypress",
  "scroll",
  "cuaScroll",
  "domCuaScroll",
  "hover",
  "select",
  "check",
  "drag",
  "cuaDrag",
  "screenshot",
  "getState",
  "elementInfo",
  "evaluate",
  "getDialog",
  "handleDialog",
  "waitFor",
  "playwright",
  "playwrightWaitForTimeout",
  "capabilities",
  "browserVisibilityGet",
  "browserVisibilitySet",
  "browserViewportSet",
  "browserViewportReset",
  "recordingStart",
  "recordingStatus",
  "recordingCancel",
  "activateTab",
  "newTab",
  "finalize",
  "finalizeTabs",
  "listUserTabs",
  "claimTab",
  "markDeliverable",
  "markHandoff",
  "nameSession",
  "turnEnded",
  "closeSession",
  "cancelRequest",
  "close",
  "list",
]);
export type BrowserCommandMethod = z.infer<typeof browserCommandMethodSchema>;

/** 客户端模式；决定桌面 continuous 与手机 replayable 的边界处理。 */
export const browserClientModeSchema = z.enum(["desktop-continuous", "web-remote-replayable"]);
export type BrowserClientMode = z.infer<typeof browserClientModeSchema>;

/** 每条命令携带的会话上下文。 */
export const browserCommandContextSchema = z
  .object({
    /** workspaceIdentity?.trim() || workspacePath，用于隔离与受控 tab 复用。 */
    workspaceKey: z.string().min(1),
    sessionId: z.string().min(1),
    /** 受控 tab id；缺省表示该 session 的活动受控 tab。 */
    tabId: z.string().min(1).optional(),
    requestId: z.string().min(1),
    clientMode: browserClientModeSchema,
  })
  .strict();
export type BrowserCommandContext = z.infer<typeof browserCommandContextSchema>;

/** 结构化错误码：不静默兜底，明确失败原因给模型。 */
export const browserErrorCodeSchema = z.enum([
  "backend_unavailable",
  "capability_unsupported",
  "duplicate_request_id",
  "ref_not_found",
  "navigation_blocked",
  "timeout",
  "renderer_unreachable",
  "cancelled",
  "execution_error",
]);
export type BrowserErrorCode = z.infer<typeof browserErrorCodeSchema>;

/** 页面基础状态（getState / 导航后回传）。 */
export const browserPageStateSchema = z
  .object({
    url: z.string(),
    title: z.string(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    scrollX: z.number().optional(),
    scrollY: z.number().optional(),
    viewportWidth: z.number().optional(),
    viewportHeight: z.number().optional(),
  })
  .strict();
export type BrowserPageState = z.infer<typeof browserPageStateSchema>;
