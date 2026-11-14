// ============================================================
// Browser Control Port - agent 浏览器控制的反向请求边界
// ============================================================
// 帧/会话隔离：每个请求都携带 requestId 与 session/turn 事实；execute 还必须带
// browserId+browserGeneration，generation 变化即视为不同实例，禁止跨代复用 tab/凭证。
// 动作幂等：同一 requestId 重复到达必须以 duplicate_request_id 拒绝；超时/取消是终态，
// 写操作不得自动重试。CUA 图像（image.base64）与 meta 只用于展示/归属，不回灌模型上下文。

import type { TraceContext } from "../tracing/tracer.js";

/**
 * BrowserControlPort —— agent 侧浏览器控制端口。
 *
 * browser-client 库把 agent.browsers.* 的每个调用构造成 BrowserCommand，经此端口执行；
 * 实现（ProtocolBrowserControlBroker）把它翻译成 ZCode Protocol 的
 * interaction/browserExecute 反向请求，由 app（host→main WebContentsView/CDP）执行。
 *
 * 类型说明：BrowserCommand/BrowserCommandResult 与 @zcode/shared 的 browser-use 契约同构。
 * 此处定义结构镜像（不 import @zcode/shared，避免 agent contracts 的 zod v3 与 shared zod v4
 * 跨包耦合）；协议边界用 shared 的 zod schema 做运行时校验，两侧一致性由 round-trip 测保证。
 */

// backend family。iab=内置浏览器，extension=浏览器扩展，cdp=外部 Chrome DevTools 协议。
// 它只是 family 标签，不能代替运行时 id；Playwright 属于 Tab API 层而非 backend。
/** Playwright 是 Tab API 层，不是 backend family。 */
export type BrowserBackendType = "iab" | "extension" | "cdp";

// 单个能力条目。id 是能力名，description 是人类可读说明；只用于展示与能力协商，
// 不构成调用许可，实际可用性仍以 execute 返回的 capability_unsupported 为准。
export interface BrowserCapabilityDescriptor {
  id: string;
  description: string;
}

// backend 运行时描述。id 是 connection identity（同一 family 可有多实例），
// generation 随重连/重建递增，用于拒绝跨代操作；capabilities 是声明的能力面，
// apiSupportOverrides 允许按 API 粒度覆盖，metadata 仅字符串键值供展示/诊断。
/**
 * 完成握手且真实可达的 backend descriptor；id 是运行时 connection identity，不能用 type 代替。
 */
export interface BrowserBackendDescriptor {
  id: string;
  generation: number;
  type: BrowserBackendType;
  name: string;
  capabilities: {
    browser?: BrowserCapabilityDescriptor[];
    tab?: BrowserCapabilityDescriptor[];
  };
  apiSupportOverrides?: Record<string, boolean>;
  metadata?: Record<string, string>;
}

// 协议层包装结果。BrowserControlPort.list 会解包并直接返回 browsers；
// 保留包装是为了让协议 schema 有稳定外壳，消费方不要把它当额外状态。
/** ZCode Protocol 使用包装结果；BrowserControlPort.list 会解包并直接返回 browsers。 */
export interface BrowserBackendListResult {
  browsers: BrowserBackendDescriptor[];
}

// 客户端模式。desktop-continuous=桌面持续连接（可 live 会话）；web-remote-replayable=
// Web 远端可重放（cached 会话只能基于快照，不等价于 live 帧）。
export type BrowserClientMode = "desktop-continuous" | "web-remote-replayable";
// 会话上下文新鲜度。live=当前可交互实例；cached=来自缓存/重放，不保证帧与状态实时。
export type BrowserSessionContextKind = "live" | "cached";

// 视口边界（CSS px）。与 Desktop 自由尺寸视口保持同一组上下限；
// 这些是协商边界，不是保证值，实际尺寸以 BrowserTabSummary.viewport 为准。
/** 与 Desktop 自由尺寸视口保持同一组 CSS px 边界。 */
export const BROWSER_VIEWPORT_LIMITS = {
  minWidth: 320,
  maxWidth: 3840,
  minHeight: 320,
  maxHeight: 2160,
} as const;

// 视口尺寸。width/height 是 CSS px，不是设备像素；缺省/非法值由调用方按
// BROWSER_VIEWPORT_LIMITS 夹取，端口不替调用方做归一化。
export interface BrowserViewportSize {
  width: number;
  height: number;
}

// discovery 上下文。requestId 是本次请求的幂等键（重复即 duplicate_request_id）；
// workspaceKey/Path/Identity 决定隔离域；sessionId/turnId 用于生命周期归属；
// clientMode 与 sessionContext 决定是否允许 live 帧。所有字段都由调用方提供事实，
// 端口不得自行推断或补全。
/** backend discovery 使用的完整 workspace/session 隔离上下文。 */
export interface BrowserDiscoveryContext {
  requestId: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
  turnId?: string;
  clientMode: BrowserClientMode;
  sessionContext: BrowserSessionContextKind;
}

// execute 上下文 = discovery 上下文 + 精确实例身份。browserId 必须来自 list 的返回值，
// browserGeneration 必须与该次 list 一致：generation 不匹配即视为 backend 已重建，
// 拒绝执行而不是事后报错（避免把写操作打到错误实例）。
/** execute 比 discovery 多一个精确 runtime browser identity。 */
export interface BrowserSessionContext extends BrowserDiscoveryContext {
  browserId: string;
  browserGeneration: number;
}

// 命令方法名全集。与 @zcode/shared 的 browserCommandSchema 变体一一对应；
// cua* 是图像坐标驱动的动作（依赖 CUA），playwright* 走 Playwright API，
// browser*/recording*/tab 生命周期命令由 manager 层处理。新增方法必须两侧同步。
export type BrowserCommandMethod =
  | "navigate"
  | "back"
  | "forward"
  | "reload"
  | "snapshot"
  | "click"
  | "fill"
  | "type"
  | "press"
  | "cuaKeypress"
  | "scroll"
  | "cuaScroll"
  | "domCuaScroll"
  | "hover"
  | "select"
  | "check"
  | "drag"
  | "cuaDrag"
  | "screenshot"
  | "getState"
  | "elementInfo"
  | "evaluate"
  | "getDialog"
  | "handleDialog"
  | "waitFor"
  | "playwright"
  | "playwrightWaitForTimeout"
  | "capabilities"
  | "browserVisibilityGet"
  | "browserVisibilitySet"
  | "browserViewportSet"
  | "browserViewportReset"
  | "recordingStart"
  | "recordingStatus"
  | "recordingCancel"
  | "activateTab"
  | "newTab"
  | "finalize"
  | "finalizeTabs"
  | "listUserTabs"
  | "claimTab"
  | "markDeliverable"
  | "markHandoff"
  | "nameSession"
  | "turnEnded"
  | "closeSession"
  | "cancelRequest"
  | "close"
  | "list";

// 鼠标键。left/right/middle 原样映射到 Playwright/CUA，不做别名。
export type BrowserMouseButton = "left" | "right" | "middle";
// 键盘修饰键。ControlOrMeta 由实现按平台映射（macOS→Meta，其它→Control），
// 调用方不应自行判断平台。
export type BrowserKeyModifier = "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift";
export type BrowserPlaywrightModifier = BrowserKeyModifier;
// Playwright locator 操作名。downloadMedia 是本地扩展能力，其余与 Playwright API 同名；
// 每个操作需要哪些附加字段由 BrowserPlaywrightAction 的 locator 变体约束。
export type BrowserPlaywrightLocatorOperation =
  | "allTextContents"
  | "click"
  | "count"
  | "dblclick"
  | "downloadMedia"
  | "evaluate"
  | "fill"
  | "getAttribute"
  | "innerText"
  | "isEnabled"
  | "isVisible"
  | "press"
  | "selectOption"
  | "setChecked"
  | "textContent"
  | "waitFor";
// Playwright 动作判别联合。坐标类（elementInfo/elementScreenshot）用 CSS px；
// evaluate 的 expressionKind 决定 expression 是字符串还是函数序列化；
// waitForEvent/fileChooserSetFiles 依赖前置事件 id，不能跨轮次复用。
export type BrowserPlaywrightAction =
  | { name: "domSnapshot" }
  | { name: "elementInfo"; x: number; y: number; includeNonInteractable?: boolean }
  | { name: "elementScreenshot"; x: number; y: number; includeNonInteractable?: boolean }
  | {
      name: "evaluate";
      expression: string;
      expressionKind: "string" | "function";
      arg?: unknown;
      timeoutMs?: number;
    }
  | {
      name: "waitForLoadState";
      state?: "load" | "domcontentloaded" | "networkidle";
      timeoutMs?: number;
    }
  | {
      name: "waitForURL";
      url: string;
      waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
      timeoutMs?: number;
    }
  | { name: "waitForEvent"; event: "download" | "filechooser"; timeoutMs?: number }
  | { name: "downloadPath"; downloadId: string; timeoutMs?: number }
  | {
      name: "fileChooserSetFiles";
      fileChooserId: string;
      files: string[];
      timeoutMs?: number;
    }
  | {
      name: "locator";
      selector: string;
      operation: BrowserPlaywrightLocatorOperation;
      value?: unknown;
      arg?: unknown;
      expression?: string;
      expressionKind?: "string" | "function";
      attribute?: string;
      checked?: boolean;
      replace?: boolean;
      force?: boolean;
      button?: BrowserMouseButton;
      modifiers?: BrowserPlaywrightModifier[];
      state?: "attached" | "detached" | "visible" | "hidden";
      selections?: Array<{ value?: string; label?: string; index?: number }>;
      timeoutMs?: number;
    };
// 视口坐标点。x/y 为 CSS px，相对当前 tab 视口左上角；不是屏幕绝对坐标。
export interface BrowserPoint {
  x: number;
  y: number;
}

// 录制动作脚本。每个动作可带 delayAfterMs 作为步骤间停顿；selector 与坐标二选一，
// 两者都缺省时动作无效。录制只回放这些高层动作，不记录底层 CDP 事件。
export type BrowserRecordingAction =
  | { type: "wait"; durationMs: number }
  | {
      type: "click";
      selector?: string;
      x?: number;
      y?: number;
      button?: BrowserMouseButton;
      doubleClick?: boolean;
      delayAfterMs?: number;
    }
  | { type: "type"; selector: string; text: string; delayAfterMs?: number }
  | {
      type: "hover";
      selector?: string;
      x?: number;
      y?: number;
      durationMs?: number;
      delayAfterMs?: number;
    }
  | { type: "move"; x: number; y: number; durationMs?: number; delayAfterMs?: number }
  | {
      type: "scroll";
      deltaX?: number;
      deltaY: number;
      durationMs?: number;
      delayAfterMs?: number;
    }
  | {
      type: "scrollTo";
      selector?: string;
      x?: number;
      y?: number;
      durationMs?: number;
      delayAfterMs?: number;
    }
  | {
      type: "wheel";
      deltaX?: number;
      deltaY: number;
      times?: number;
      intervalMs?: number;
      delayAfterMs?: number;
    }
  | { type: "drag"; path: BrowserPoint[]; durationMs?: number; delayAfterMs?: number }
  | {
      type: "waitFor";
      selector: string;
      state?: "attached" | "detached" | "visible" | "hidden";
      timeoutMs?: number;
      delayAfterMs?: number;
    };

// 录制参数。viewport 固定捕获区域；fps/jpegQuality 决定体积与清晰度；
// maxDurationMs 是硬上限，settleMs 是收尾等待；showCursor 控制光标叠加；
// actions 为空时录制当前画面，不为空时按脚本回放并录制。
export interface BrowserRecordingOptions {
  viewport?: BrowserViewportSize;
  fps?: number;
  jpegQuality?: number;
  maxDurationMs?: number;
  settleMs?: number;
  showCursor?: boolean;
  actions?: BrowserRecordingAction[];
}

// 浏览器命令判别联合。method 是唯一分派键；tabId 指定受控 tab（缺省作用于会话默认 view），
// 无 tabId 的 tab 生命周期命令（newTab/listUserTabs/finalizeTabs 等）由 manager 层处理。
// 结构必须与 shared 的 browserCommandSchema 逐变体镜像，任何一侧新增字段都要同步。
// 写操作不是幂等的：同一 requestId 重复提交必须被 duplicate_request_id 拒绝。
// tabId（可选）：agent 对象模型用于寻址指定受控 tab（含 human 开的 tab）；缺省作用于会话默认 view。
// 与 @zcode/shared 的 browserCommandSchema 各变体结构镜像同步。
export type BrowserCommand =
  | { method: "navigate"; url: string; tabId?: string }
  | { method: "back"; tabId?: string }
  | { method: "forward"; tabId?: string }
  | { method: "reload"; tabId?: string }
  | { method: "snapshot"; maxElements?: number; includeHidden?: boolean; tabId?: string }
  | {
      method: "click";
      ref?: string;
      x?: number;
      y?: number;
      button?: BrowserMouseButton;
      doubleClick?: boolean;
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | { method: "fill"; ref: string; value: string; tabId?: string }
  | { method: "type"; ref?: string; text: string; tabId?: string }
  | { method: "press"; key: string; ref?: string; modifiers?: BrowserKeyModifier[]; tabId?: string }
  | { method: "cuaKeypress"; keys: string[]; tabId?: string }
  | { method: "scroll"; ref?: string; x?: number; y?: number; tabId?: string }
  | {
      method: "cuaScroll";
      x: number;
      y: number;
      scrollX: number;
      scrollY: number;
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | { method: "domCuaScroll"; nodeId?: string; scrollX: number; scrollY: number; tabId?: string }
  | {
      method: "hover";
      ref?: string;
      x?: number;
      y?: number;
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | { method: "select"; ref: string; values: string[]; tabId?: string }
  | { method: "check"; ref: string; checked?: boolean; tabId?: string }
  | {
      method: "drag";
      fromRef?: string;
      toRef?: string;
      from?: BrowserPoint;
      to?: BrowserPoint;
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | {
      method: "cuaDrag";
      path: BrowserPoint[];
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | {
      method: "screenshot";
      ref?: string;
      fullPage?: boolean;
      clip?: { x: number; y: number; width: number; height: number };
      tabId?: string;
    }
  | { method: "getState"; tabId?: string }
  | { method: "elementInfo"; x: number; y: number; tabId?: string }
  | { method: "evaluate"; expression: string; tabId?: string }
  | { method: "getDialog"; tabId?: string }
  | { method: "handleDialog"; accept: boolean; promptText?: string; tabId?: string }
  | {
      method: "waitFor";
      selector?: string;
      text?: string;
      textGone?: string;
      timeoutMs?: number;
      tabId?: string;
    }
  | { method: "playwrightWaitForTimeout"; timeoutMs: number; tabId?: string }
  | { method: "playwright"; action: BrowserPlaywrightAction; tabId?: string }
  | { method: "capabilities"; tabId?: string }
  | { method: "browserVisibilityGet" }
  | { method: "browserVisibilitySet"; visible: boolean }
  | { method: "browserViewportSet"; width: number; height: number; tabId?: string }
  | { method: "browserViewportReset"; tabId?: string }
  | { method: "recordingStart"; options?: BrowserRecordingOptions; tabId?: string }
  | {
      method: "recordingStatus";
      recordingId: string;
      outputPath?: string;
      tabId?: string;
    }
  | { method: "recordingCancel"; recordingId: string; tabId?: string }
  | { method: "activateTab"; tabId: string }
  | { method: "newTab" }
  | { method: "listUserTabs" }
  | { method: "claimTab"; tabId: string }
  | {
      method: "finalizeTabs";
      keep: Array<{ tabId: string; status: "handoff" | "deliverable" }>;
    }
  | { method: "markDeliverable"; tabId: string }
  | { method: "markHandoff"; tabId: string }
  | { method: "nameSession"; name: string }
  | { method: "finalize"; tabId?: string; deliverable?: boolean }
  | { method: "turnEnded"; turnId?: string }
  // closeTabs：连 tab 一起关（含已释放回该 session 的）。只给永不回来认领的 session（dwf 子代理）。
  | { method: "closeSession"; closeTabs?: boolean }
  | { method: "cancelRequest"; requestId: string }
  // close：关闭指定受控 tab；manager 层处理。
  | { method: "close"; tabId?: string }
  // list：枚举当前会话窗口下所有受控 tab 摘要，manager 层拦截处理，返回 tabs。
  | { method: "list" };

// 稳定错误码。backend_unavailable=没有可达实例；capability_unsupported=当前 backend
// 不支持该命令；duplicate_request_id=幂等键重复；ref_not_found=快照 ref 失效；
// navigation_blocked=策略拦截；timeout/cancelled=终态（写操作可能已部分生效）；
// renderer_unreachable=页面进程失联；execution_error=其余执行失败。调用方按码分支，
// 不解析 message；timeout/cancelled 不得自动重试写操作。
export type BrowserErrorCode =
  | "backend_unavailable"
  | "capability_unsupported"
  | "duplicate_request_id"
  | "ref_not_found"
  | "navigation_blocked"
  | "timeout"
  | "renderer_unreachable"
  | "cancelled"
  | "execution_error";

// 页面状态。url/title 是当前文档事实；canGoBack/Forward 来自历史栈；
// scrollX/Y 与 viewportWidth/Height 可缺席（cached/无渲染上下文时），
// 缺席不等于 0，调用方不得据此推断页面已到顶/无法滚动。
export interface BrowserPageState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  scrollX?: number;
  scrollY?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}

// 快照元素。ref 是本次快照内稳定的寻址标识，只对当前快照代有效（页面变化后可能失效）；
// selector/xpath 用于调试兜底；rect 为 CSS px；inViewport 影响是否可被坐标类动作命中；
// framePath 标识跨 frame 归属，parentRef 表示 DOM 层级。attributes 只含白名单属性。
export interface BrowserSnapshotElement {
  ref: string;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  selector: string;
  xpath: string;
  rect: { x: number; y: number; width: number; height: number };
  inViewport: boolean;
  parentRef?: string;
  framePath?: string;
  attributes?: Record<string, string>;
}

// 快照 DOM 节点（精简树）。depth 表示层级，inViewport 与元素一致；
// ref 仅对可交互节点给出，其余节点没有 ref；dom 是可选补充视图，不作为主要寻址依据。
export interface BrowserSnapshotDomNode {
  tag: string;
  depth: number;
  inViewport: boolean;
  ref?: string;
  role?: string;
  name?: string;
  text?: string;
  attributes?: Record<string, string>;
}

// 页面快照。elements 是主寻址面；truncated=true 表示元素被上限截断，
// 调用方应缩小范围而不是假定页面只有这些元素；dom/domTruncated 是可选补充树，
// 与 elements 的截断状态互不推断。
export interface BrowserSnapshot {
  url: string;
  title: string;
  elements: BrowserSnapshotElement[];
  truncated: boolean;
  dom?: BrowserSnapshotDomNode[];
  domTruncated?: boolean;
}

// 受控 tab 摘要。tabId 是会话内标识；viewport 必须是 guest 当前真实 CSS 尺寸
// （normal/free-size 都要返回）；active 表示用户正在看它；lifecycle 缺失表示普通活动 tab。
/** 受控 tab 摘要（list 命令返回）；与 @zcode/shared 的 browserTabSummarySchema 镜像同步。 */
export interface BrowserTabSummary {
  tabId: string;
  url: string;
  title: string;
  /** guest 当前真实 CSS viewport；normal/free-size 均必须返回。 */
  viewport: BrowserViewportSize;
  /** 当前可见/激活的内置浏览器 tab；agent 用它优先读取用户正在看的页面。 */
  active?: boolean;
  lifecycle?: "active" | "deliverable" | "handoff";
}

// 用户自有 tab 信息（listUserTabs 返回，通常来自浏览器扩展）。字段多为可选：
// 只有 id 必填，其余取决于扩展能读到的元数据；不得用于寻址受控 tab。
export interface BrowserUserTabInfo {
  id: string;
  lastOpened?: string;
  tabGroup?: string;
  title?: string;
  url?: string;
}

// 响应元信息。browserUse=true 是该结构的判别标记；backendType/browserId/
// browserGeneration 回填本次实际执行的实例（用于识别执行期间是否发生重连）；
// openTabIds 是执行后仍存活的 tab；tabId/currentUrl 是命令作用的 tab；
// lifecycle=closed 表示该 tab 已在本次命令中关闭。
export interface BrowserResponseMeta {
  browserUse: true;
  backendType: BrowserBackendType;
  browserId: string;
  browserGeneration: number;
  openTabIds: string[];
  tabId?: string;
  currentUrl?: string;
  lifecycle?: "active" | "deliverable" | "handoff" | "closed";
}

// JS 弹窗信息。type 与浏览器原生对话框一一对应；defaultPrompt 仅 prompt 有；
// getDialog 无弹窗时返回的 dialog 字段是 null 而不是省略，避免调用方混淆"未查询"。
/** JS 弹窗信息（getDialog 返回）。 */
export interface BrowserDialog {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string;
}

// 录制产物。path 是宿主可读的本地路径（不是 artifact uri）；mimeType 固定 webm；
// width/height/fps/durationMs/frameCount 是实际编码参数，用于 UI 与体积估算。
export interface BrowserRecordingArtifact {
  path: string;
  mimeType: "video/webm";
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  frameCount: number;
}

// 录制任务。status 是终态/运行态判别（running 之外不可再操作）；
// phase 是更细粒度的阶段；progress 为 0~1；startedAt/updatedAt 是毫秒时间戳；
// artifact 仅在 completed 出现；error 仅在 failed 出现。
export interface BrowserRecordingJob {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  phase: "preparing" | "capturing" | "finalizing" | "completed" | "failed" | "cancelled";
  progress: number;
  startedAt: number;
  updatedAt: number;
  artifact?: BrowserRecordingArtifact;
  error?: string;
}

// 命令执行结果。ok 是总成功标志；其余字段按 method 选择性出现（state/snapshot/
// image/tabs/userTabs/tab/value/element/dialog/recording），缺席不代表空值。
// image 是 screenshot 的 PNG base64，仅用于模型/UI 展示；error.sideEffect 说明
// 失败时写操作是否可能已生效（uncertain 时调用方不得盲目重试）；meta 见上；
// elapsedMs 是宿主侧实际耗时，不是超时预算。
export interface BrowserCommandResult {
  ok: boolean;
  state?: BrowserPageState;
  snapshot?: BrowserSnapshot;
  image?: { base64: string; mimeType: "image/png" };
  /** list 命令返回：当前会话窗口下所有受控 tab 的摘要。 */
  tabs?: BrowserTabSummary[];
  userTabs?: BrowserUserTabInfo[];
  tab?: BrowserTabSummary;
  /** evaluate 返回：页面表达式的可 JSON 序列化结果。 */
  value?: unknown;
  /** elementInfo 返回：坐标命中元素的信息（未命中则省略）。 */
  element?: BrowserSnapshotElement;
  /** getDialog 返回：当前 JS 弹窗信息；无弹窗时为 null。 */
  dialog?: BrowserDialog | null;
  recording?: BrowserRecordingJob;
  error?: { code: BrowserErrorCode; message: string; sideEffect?: "none" | "uncertain" };
  meta?: BrowserResponseMeta;
  elapsedMs: number;
}

// 执行输入。browserId/browserGeneration 必须来自同一次 list（精确实例，不能只给
// family）；sessionId/turnId 用于生命周期归属与 turnEnded 清理；traceContext 仅日志；
// signal 中止单次命令，但中止不等于回滚已发生的写操作。
export interface BrowserControlExecuteInput {
  /** 精确 runtime backend id；不能只传 iab/extension/cdp family。 */
  browserId: string;
  browserGeneration: number;
  sessionId: string;
  turnId?: string;
  command: BrowserCommand;
  traceContext?: TraceContext;
  signal?: AbortSignal;
}

// 列表/清理输入。只需会话事实；turnId 用于按 turn 取消未完成请求；
// signal 中止枚举本身（不保证已发出的宿主请求被撤销）。
export interface BrowserControlListInput {
  sessionId: string;
  turnId?: string;
  traceContext?: TraceContext;
  signal?: AbortSignal;
}

// 子会话 tab 归属。child=tab 归子会话自己（dwf 子代理），关闭时连 tab 一起关；
// parent=tab 归父会话（core Agent 子代理），子代理与当前对话共用同一组 tab，
// 子会话的生命周期事件不向桌面发生命周期。
/** 子会话 Browser 请求的 tab 归属：子会话自己（dwf 子代理）或父会话（core Agent 子代理）。 */
export type BrowserChildSessionTabOwner = "child" | "parent";

// 浏览器控制端口。list 只返回完成握手且当前可达的 backend（禁止 stub）；
// execute 必须校验 browserId+generation，并用 requestId 做幂等；turnEnded/closeSession
// 是可选的清理钩子，缺席表示实现不需要该生命周期通知；forChildSession 缺失表示
// 实现不按客户端会话校验 sessionId（headless CDP 直接复用本端口）。
export interface BrowserControlPort {
  /** 只返回完成握手且当前 context 可达的 backend，不允许伪造 stub。 */
  list(input: BrowserControlListInput): Promise<BrowserBackendDescriptor[]>;
  execute(input: BrowserControlExecuteInput): Promise<BrowserCommandResult>;
  /** turn 结束时取消该 turn 尚未完成的 IAB 请求，不跨 session 清 tab。 */
  turnEnded?(input: BrowserControlListInput): Promise<void>;
  /** session 关闭时释放 browser guest、pending request 与 lease。 */
  closeSession?(input: BrowserControlListInput): Promise<void>;
  /**
   * 为一个客户端不认识的子会话派生端口：workspace / clientMode 按 parentSessionId 的会话解析。
   *
   * - `tabOwner: "child"`（默认，dwf 子代理）：tab 归属是子会话自己的 sessionId；派生端口的
   *   closeSession 连 tab 一起关，并结束这份登记。
   * - `tabOwner: "parent"`（core Agent 子代理）：下发的 sessionId 换成父会话，子代理与当前对话共用同一组
   *   tab（桌面据此展开面板、tabs.list 列出对话全部 tab）；派生端口的 turnEnded / closeSession 不向
   *   桌面发生命周期，tab 交给父会话自己的生命周期管理，closeSession 只结束登记。
   *
   * 登记结束后该子会话的请求与从未登记的一样被拒。
   *
   * 缺席表示实现不按客户端会话校验 sessionId（如 CLI headless CDP），子会话直接用本端口。
   * 见 apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Subagent sessions」。
   */
  forChildSession?(input: {
    childSessionId: string;
    parentSessionId: string;
    tabOwner?: BrowserChildSessionTabOwner;
  }): BrowserControlPort;
}
