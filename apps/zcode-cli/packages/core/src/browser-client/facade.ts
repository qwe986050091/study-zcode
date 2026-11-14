/* eslint-disable max-lines -- Browser/Tab/Tabs facade 共享 selection、transport 与对象 identity；拆分前保持同一连接状态机。 */
// ============================================================================
// facade.ts — browser-client 对外的对象门面（Browser / Tabs / Tab / capabilities）
//
// 职责边界：
//   - 只做「对象化封装 + 策略注入」：把 backend-neutral 的 command/result 协议
//     包装成 Browser / Tab / RawTab / cua / dom_cua 等可调用对象。
//   - 不自行探测 backend 能力，也不伪造某个 backend 可用：list 结果由 transport 决定。
//   - 不持有连接状态：真正的连接、generation 与命令路由都在 transport（host 侧）。
//
// 三层结构：
//   1) 能力描述层：BrowserCapability / BrowserCapabilityCollection / documentation；
//   2) 对象层：Browser → BrowserTabs / BrowserUser / Tab（含 raw、cua、dom_cua、recording）；
//   3) 门面层：BrowsersFacade 负责按 id/type/url 选 backend，并按 generation 缓存对象。
//
// 不变量（INV）。每条注明「守住它的位置」与「改错故障」。
//
// INV-01 本文件不得按 backend 类型分支：IAB、Chrome extension、CDP 走同一套 descriptor。
//   守住它的位置：BrowserClientTransport 只暴露 list / execute 两个方法。
//   改错故障：一旦按 type 特判，新增 backend 就要改门面，且未覆盖的分支会静默失效。
//
// INV-02 Browser 对象按 id 缓存，只有 generation 变化才重建。
//   守住它的位置：browserFor 的 existing.raw.generation === info.generation 判断。
//   改错故障：每次 list 都新建对象会让调用方持有的旧引用永久失效（identity 断裂）。
//
// INV-03 assertAvailable 必须包住每一次 transport 与 documentation 调用。
//   守住它的位置：BrowsersFacade 构造函数里对 transport / readDocumentation 的包装。
//   改错故障：只在初始化时检查，内核 reset 后旧 binding 仍会被调用，命令发到已销毁连接。
//
// INV-04 每个 Tab 的 execute 必须冻结创建时选中的 Browser 引用。
//   守住它的位置：BrowsersFacade.tab 里先 await browser 再闭包捕获。
//   改错故障：每条命令重跑 getDefault，backend 上下线后同一 tabId 会被发到另一连接。
//
// INV-05 tabId 只在存在时注入命令；默认 tab 必须保持无 tabId。
//   守住它的位置：Tab.run 里的 this.tabId ? { ...command, tabId } : command。
//   改错故障：给默认 tab 硬塞空串 tabId，host 侧会把命令路由到不存在的 tab。
//
// INV-06 setViewportSize 必须先校验、再发命令、成功后才更新本地镜像。
//   守住它的位置：validateViewportSize → action → viewportSizeValue 赋值的顺序。
//   改错故障：先写本地值再发命令，命令失败后 viewportSize() 与真实页面不一致。
//
// INV-07 viewportSize() 必须返回副本，不得把内部对象直接交出去。
//   守住它的位置：viewportSize 方法末尾的 { ...this.viewportSizeValue }。
//   改错故障：调用方原地修改返回值会污染后续每次读取，且不经过校验。
//
// INV-08 raw.* 只返回原始 BrowserCommandResult，不做 expectOk。
//   守住它的位置：RawTab 的每个方法都直接 return this.run(...)。
//   改错故障：在 raw 层抛错会让调用方拿不到 error code / elapsedMs 等排障字段。
//
// INV-09 cua 的 button 只接受 1/2/3，分别映射 left/middle/right，其余直接抛错。
//   守住它的位置：cuaButton 的三段 if 与末尾 throw。
//   改错故障：把未知数字默默当左键，用户点击会落在错误的语义上且无任何提示。
//
// INV-10 cua 修饰键必须白名单过滤，未知键丢弃而不是透传。
//   守住它的位置：cuaModifiers 的 includes 过滤。
//   改错故障：透传平台私有键名会被 host 侧 schema 拒绝，整条点击命令失败。
//
// INV-11 cua.drag 的 path 不得为空，空路径必须在发命令前抛错。
//   守住它的位置：drag 里 path.length === 0 的判断。
//   改错故障：空路径到达 backend 后表现为「按下了但没移动」，鼠标停在按下状态。
//
// INV-12 JS dialog 只构造四种类型，未知 type 统一降级为 alert。
//   守住它的位置：createJsDialog 的 switch default。
//   改错故障：返回 undefined 会让调用方对空对象调用 dismiss，抛出难以理解的 TypeError。
//
// INV-13 tabs.reuse 只看 agent-owned tabs（list 的范围），不得触碰用户 tab。
//   守住它的位置：reuse 使用 this.summaries() 而不是 user.openTabs()。
//   改错故障：复用用户正在用的标签页，并在其上手写 goto，直接破坏用户现场。
//
// INV-14 open 的复用链路失败必须降级 newTab，不能阻断任务。
//   守住它的位置：open 里 tabs.reuse(url).catch(() => undefined)。
//   改错故障：activate 偶发失败就让整个浏览器任务失败，而新建 tab 本来可以继续。
//
// INV-15 没有可用 backend 时必须走统一的 backend_unavailable 错误，而不是返回 undefined。
//   守住它的位置：getDefault 用哨兵 id 调 get，由 get 抛 BrowserCommandError。
//   改错故障：返回 undefined 会迫使每个调用点判空，漏判就是空指针崩溃。
//
// INV-16 getForUrl 的逐 browser tab 探测失败必须视为「该 browser 无匹配 tab」。
//   守住它的位置：Promise.all 里的 try/catch 与 tabsByBrowserId.set(id, [])。
//   改错故障：单个 backend 报错会让整个选择流程失败，即使其他 backend 完全可用。
//
// INV-17 listTabs 不得逐个调用 tabs.get：get 带显式激活语义。
//   守住它的位置：listTabs 用 browser.createTab 而不是 browser.tabs.get。
//   改错故障：批量 get 会依次抢占 active tab，并发时最终选中项不确定。
//
// INV-18 documentation 只读本地文档，不得触发任何 browser 命令。
//   守住它的位置：Browser.documentation 直接读 readDocumentation。
//   改错故障：文档读取需要 backend 在线，离线时 capability 列表整块不可用。
//
// INV-19 registry refresh 必须保留 Browser 对象 identity，只更新 info 与 policy。
//   守住它的位置：updateInfo 里只赋值 info 并调用 policy.updateDescriptor。
//   改错故障：新建对象会让调用方缓存的 tabs / tab 句柄指向旧 generation 的 transport。
//
// INV-20 iab backend 的 history 必须显式抛错，不能返回空数组伪造「没有历史」。
//   守住它的位置：BrowserUser.history 末尾的 throw。
//   改错故障：空数组会被上层当作「确实没有记录」，掩盖 backend 不支持的事实。
//
// INV-21 applyPlaywrightPolicy 之后创建的 cua / dom_cua / dialog 必须经过 wrapObject。
//   守住它的位置：三个 getter 与 getJsDialog 的 this.wrapObject 调用。
//   改错故障：策略注入只作用于 playwright，其他入口仍暴露未声明的 API。
//
// INV-22 capability.list 与 tabs.list 必须返回新对象/新数组，不能泄露内部快照。
//   守住它的位置：list 里的 map((capability) => ({ ...capability })) 等复制。
//   改错故障：调用方修改描述符会改变后续 get 的行为，且不影响 backend 真实能力。
//
// INV-23 execute 必须在调用时读取最新的 info，不能在构造时把 generation 固化成常量。
//   守住它的位置：Browser 构造函数里箭头函数体内 this.info.id / this.info.generation。
//   改错故障：updateInfo 之后命令仍带旧 generation，host 侧会按陈旧绑定拒绝执行。
//
// INV-24 所有 public 方法参数里的 id 必须在门面层做非空校验，不能依赖 backend 报错。
//   守住它的位置：recording.status / cancel 与 browser.nameSession 的 TypeError。
//   改错故障：空 id 会生成语义不明的后端错误，排查时无法定位是调用方传参问题。
//
// ============================================================================
import {
  BROWSER_VIEWPORT_LIMITS,
  type BrowserBackendDescriptor,
  type BrowserBackendType,
  type BrowserCapabilityDescriptor,
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserDialog,
  type BrowserKeyModifier,
  type BrowserMouseButton,
  type BrowserPageState,
  type BrowserRecordingJob,
  type BrowserRecordingOptions,
  type BrowserSnapshot,
  type BrowserSnapshotElement,
  type BrowserTabSummary,
  type BrowserUserTabInfo,
  type BrowserViewportSize,
} from "@zcode/contracts/browser-control";
import { loadBrowserDocumentation } from "./documentation.js";
import {
  BrowserApiPolicy,
  createBrowserApiProxy,
  loadBrowserApiManifest,
  type BrowserApiManifest,
} from "./manifest.js";
import { selectBrowserForUrl, selectDefaultBrowser, selectTabForUrl } from "./selection.js";
import {
  configurePlaywrightObjectWrapper,
  createPlaywrightAPI,
  type PlaywrightAPI,
} from "./playwright.js";
import { BrowserCommandError, base64ToBytes, expectOk, expectPayload } from "./result.js";

// [权衡] execute 是「已绑定 browser」的函数：调用方不需要知道 browserId/generation，
// 减少每个便捷方法重复传参，也避免两处参数不一致。
export type BrowserExecuteFn = (command: BrowserCommand) => Promise<BrowserCommandResult>;
export type BrowserAvailabilityGuard = () => void;
export type BrowserTransportExecuteFn = (
  browserId: string,
  browserGeneration: number,
  command: BrowserCommand,
) => Promise<BrowserCommandResult>;
export type { BrowserBackendType };
export type BrowserCapabilityInfo = BrowserCapabilityDescriptor;

/** 视口坐标点（cua 坐标路 / drag / elementInfo 用；与 CDP Input 同坐标系）。 */
// [失败路径] 坐标只做透传不取整：取整会引入最多 1px 偏移，
// 在密集控件上足以点中相邻元素；精度由 backend 决定。
export interface Point {
  x: number;
  y: number;
}

// [权衡] 直接别名而不是重新声明字段：descriptor 是 host 与门面之间的契约，
// 复制一份会出现两边字段漂移。
export type BrowserInfo = BrowserBackendDescriptor;
export type BrowserDescriptor = Omit<BrowserInfo, "generation">;

// [权衡] 列表项只暴露展示字段（title/url/active/viewport）：
// 不含 policy 与 capability，避免调用方把列表快照当成能力判断依据。
export interface BrowserTabInfo {
  id: string;
  active?: boolean;
  title?: string;
  url?: string;
  viewport: BrowserViewportSize;
}

// [权衡] 文档读取用注入的函数而不是直接 import：同一份能力描述会随 backend
// descriptor 变化，注入让 Browser 与 collection 共享同一个 descriptor 上下文。
export class BrowserCapability {
  readonly #readDocumentation: (name?: string) => string;

  constructor(
    readonly id: string,
    readonly description: string,
    readDocumentation: (name?: string) => string,
  ) {
    this.#readDocumentation = readDocumentation;
  }

  // [失败路径] 这里只补 capability id，不吞异常：文档缺失属于开发期配置错误，
  // 静默返回空串会让模型以为该能力「没有文档」。
  async documentation(): Promise<string> {
    return this.#readDocumentation(this.id);
  }
}

// [权衡] 只有 visibility 单独建子类：它是唯一带 get/set 语义的浏览器级能力，
// 其余能力保持纯文档对象，避免为个别特例把基类做成通用命令包装器。
export class VisibilityBrowserCapability extends BrowserCapability {
  constructor(
    info: BrowserCapabilityInfo,
    readDocumentation: (name?: string) => string,
    private readonly execute: BrowserExecuteFn,
  ) {
    super(info.id, info.description, readDocumentation);
  }

  async get(): Promise<boolean> {
    const command: BrowserCommand = { method: "browserVisibilityGet" };
    const result = expectOk(command, await this.execute(command));
    if (typeof result.value !== "boolean") {
      throw new Error("Browser visibility result is missing a boolean value");
    }
    return result.value;
  }

  // [失败路径] 类型校验放在门面层：调用方可能来自 JS 或模型生成的参数，
  // 不校验就会把非布尔值写进 command，最终由 host schema 报一个晦涩的错误。
  async set(visible: boolean): Promise<void> {
    if (typeof visible !== "boolean") throw new TypeError("visibility.set requires a boolean");
    const command: BrowserCommand = { method: "browserVisibilitySet", visible };
    expectOk(command, await this.execute(command));
  }
}

// [并发] #read 是函数而不是数组：Browser.updateInfo 会替换 descriptor，
// collection 必须每次读取最新能力表，而不是冻结构造时的快照。
export class BrowserCapabilityCollection {
  readonly #read: () => readonly BrowserCapabilityInfo[];
  readonly #readDocumentation: (name?: string) => string;

  constructor(
    read: () => readonly BrowserCapabilityInfo[],
    readDocumentation: (name?: string) => string,
    private readonly execute?: BrowserExecuteFn,
    private readonly assertAvailable: BrowserAvailabilityGuard = () => undefined,
  ) {
    this.#read = read;
    this.#readDocumentation = readDocumentation;
  }

  // [并发] 每次 list 都浅拷贝：调用方（模型/UI）可能缓存并修改返回对象，
  // 直接返回内部引用会让下一次 get 用到被改过的 id 或 description。
  async list(): Promise<BrowserCapabilityInfo[]> {
    this.assertAvailable();
    return this.#read().map((capability) => ({ ...capability }));
  }

  get(id: "visibility"): Promise<VisibilityBrowserCapability>;
  get(id: string): Promise<BrowserCapability>;
  async get(id: string): Promise<BrowserCapability> {
    this.assertAvailable();
    const capability = this.#read().find((candidate) => candidate.id === id);
    if (!capability) throw new Error(`Browser capability '${id}' is unavailable`);
    // [失败路径] 没有 execute 时仍返回基类对象而不是抛错：
    // 纯文档场景（例如静态能力索引）不应因为缺命令通道而整体不可用。
    if (id === "visibility" && this.execute) {
      return new VisibilityBrowserCapability(capability, this.#readDocumentation, this.execute);
    }
    return new BrowserCapability(capability.id, capability.description, this.#readDocumentation);
  }
}

/**
 * browser-client 只依赖 backend-neutral transport。IAB、Chrome extension 和 CDP provider
 * 都通过相同 descriptor/execute 接口接入，facade 不再自行伪造某个 backend 可用。
 */
// [权衡] execute 的签名带 browserId + generation，而不是只传 command：
// host 侧据此确认命令发往当前绑定；门面不解析 generation 的含义，只透传。
export interface BrowserClientTransport {
  list(): Promise<BrowserInfo[]>;
  execute: BrowserTransportExecuteFn;
}

// [权衡] CUA 路径全部用视口像素坐标而不是 ref：这条通道面向「看不见 DOM」的场景，
// 坐标系必须与 CDP Input 一致，不能混用元素引用。
export interface CuaTab {
  click(options: Point & { button?: number; keypress?: string[] }): Promise<void>;
  double_click(options: Point & { keypress?: string[] }): Promise<void>;
  downloadMedia(options: Point & { timeoutMs?: number }): Promise<void>;
  drag(options: { keys?: string[]; path: Point[] }): Promise<void>;
  keypress(options: { keys: string[] }): Promise<void>;
  move(options: Point & { keys?: string[] }): Promise<void>;
  scroll(options: Point & { keypress?: string[]; scrollX: number; scrollY: number }): Promise<void>;
  type(options: { text: string }): Promise<void>;
}

// [失败路径] 全部操作以 node_id 为入口：调用方必须先 get_visible_dom 拿到快照，
// 拿旧快照里的 node_id 去点击会得到 backend 的「节点不存在」。
export interface DomCuaTab {
  get_visible_dom(): Promise<BrowserSnapshot>;
  click(options: { node_id: string }): Promise<void>;
  double_click(options: { node_id: string }): Promise<void>;
  downloadMedia(options: { node_id: string; timeoutMs?: number }): Promise<void>;
  type(options: { text: string }): Promise<void>;
  scroll(options: { node_id?: string; x: number; y: number }): Promise<void>;
  keypress(options: { keys: string[] }): Promise<void>;
}

// [失败路径] 三个方法都要求 result.recording 存在：录制是长任务，
// 缺少 job 对象说明 backend 没有真正启动录制，不能返回一个伪造的默认 job。
export class BrowserRecordingAPI {
  constructor(private readonly run: (command: BrowserCommand) => Promise<BrowserCommandResult>) {}

  // [权衡] 默认空对象而不是 undefined：让 transport 侧永远收到一个可展开的 options，
  // 避免每个 backend 各写一次 ?? {}。
  async start(options: BrowserRecordingOptions = {}): Promise<BrowserRecordingJob> {
    const command: BrowserCommand = { method: "recordingStart", options };
    const result = await this.run(command);
    return expectPayload(command, result, result.recording, "recording");
  }

  // [失败路径] recordingId 为空直接 TypeError：status 无法猜测目标，
  // 空 id 打到 backend 只会得到一个无法归因的「未找到录制」。
  async status(
    recordingId: string,
    options: { outputPath?: string } = {},
  ): Promise<BrowserRecordingJob> {
    if (!recordingId) throw new TypeError("recording.status requires a recording id");
    const command: BrowserCommand = {
      method: "recordingStatus",
      recordingId,
      ...options,
    };
    const result = await this.run(command);
    return expectPayload(command, result, result.recording, "recording");
  }

  async cancel(recordingId: string): Promise<BrowserRecordingJob> {
    if (!recordingId) throw new TypeError("recording.cancel requires a recording id");
    const command: BrowserCommand = { method: "recordingCancel", recordingId };
    const result = await this.run(command);
    return expectPayload(command, result, result.recording, "recording");
  }
}

// [失败路径] 用 Number.isInteger 而不是 typeof === "number"：
// NaN 与 1.5 都能通过 typeof，但会让 backend 的视口计算出现半像素或 NaN。
// [权衡] 边界值来自 contracts 的 BROWSER_VIEWPORT_LIMITS，不在这里写死：
// 上限同时约束 UI 与 backend，三处各自写一个数字必然漂移。
function validateViewportSize(viewportSize: BrowserViewportSize): void {
  if (
    !Number.isInteger(viewportSize?.width) ||
    viewportSize.width < BROWSER_VIEWPORT_LIMITS.minWidth ||
    viewportSize.width > BROWSER_VIEWPORT_LIMITS.maxWidth ||
    !Number.isInteger(viewportSize?.height) ||
    viewportSize.height < BROWSER_VIEWPORT_LIMITS.minHeight ||
    viewportSize.height > BROWSER_VIEWPORT_LIMITS.maxHeight
  ) {
    throw new TypeError(
      `setViewportSize requires integer width ${BROWSER_VIEWPORT_LIMITS.minWidth}..${BROWSER_VIEWPORT_LIMITS.maxWidth} ` +
        `and height ${BROWSER_VIEWPORT_LIMITS.minHeight}..${BROWSER_VIEWPORT_LIMITS.maxHeight}`,
    );
  }
}

// [权衡] 参数用数字而不是字符串：CUA 协议（cua 工具入参）就是数字编号，
// 在门面处转换一次，避免把两套命名混进 command。
function cuaButton(button = 1): BrowserMouseButton {
  if (button === 2) return "middle";
  if (button === 3) return "right";
  if (button === 1) return "left";
  throw new Error(`Unsupported CUA mouse button: ${button}`);
}

// [失败路径] 过滤而不是抛错：调用方常把 "Cmd"、"Command" 等别名一起传进来，
// 丢弃未知项可以让有效修饰键仍然生效，同时不把错误扩大成整条命令失败。
function cuaModifiers(keys: string[] = []): BrowserKeyModifier[] {
  return keys.filter((key): key is BrowserKeyModifier =>
    ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"].includes(key),
  );
}

// [权衡] raw 是「逃生舱」：返回完整 BrowserCommandResult 供高级调用方判断 ok/error，
// 因此它刻意不做 expectOk，也不能被策略代理隐藏掉错误结构。
export class RawTab {
  constructor(private readonly run: (command: BrowserCommand) => Promise<BrowserCommandResult>) {}

  navigate(url: string): Promise<BrowserCommandResult> {
    return this.run({ method: "navigate", url });
  }

  getState(): Promise<BrowserCommandResult> {
    return this.run({ method: "getState" });
  }

  screenshot(opts?: {
    ref?: string;
    fullPage?: boolean;
    clip?: { x: number; y: number; width: number; height: number };
  }): Promise<BrowserCommandResult> {
    return this.run({ method: "screenshot", ...opts });
  }

  back(): Promise<BrowserCommandResult> {
    return this.run({ method: "back" });
  }

  forward(): Promise<BrowserCommandResult> {
    return this.run({ method: "forward" });
  }

  reload(): Promise<BrowserCommandResult> {
    return this.run({ method: "reload" });
  }

  snapshot(opts?: {
    maxElements?: number;
    includeHidden?: boolean;
  }): Promise<BrowserCommandResult> {
    return this.run({ method: "snapshot", ...opts });
  }

  click(
    target:
      | string
      | (Point & {
          button?: BrowserMouseButton;
          doubleClick?: boolean;
          modifiers?: BrowserKeyModifier[];
        }),
    opts?: {
      button?: BrowserMouseButton;
      doubleClick?: boolean;
      modifiers?: BrowserKeyModifier[];
    },
  ): Promise<BrowserCommandResult> {
    // [权衡] 字符串走 ref、对象走坐标，两条路径互斥：
    // 不能「两者都给」让 backend 自己选，否则 ref 失效时会悄悄点到坐标位置。
    if (typeof target === "string") {
      return this.run({ method: "click", ref: target, ...opts });
    }
    const { x, y, ...rest } = target;
    return this.run({ method: "click", x, y, ...rest, ...opts });
  }

  type(text: string, opts?: { ref?: string }): Promise<BrowserCommandResult> {
    return this.run({ method: "type", text, ref: opts?.ref });
  }

  press(
    key: string,
    opts?: { ref?: string; modifiers?: BrowserKeyModifier[] },
  ): Promise<BrowserCommandResult> {
    return this.run({ method: "press", key, ref: opts?.ref, modifiers: opts?.modifiers });
  }

  scroll(opts: { ref?: string; x?: number; y?: number }): Promise<BrowserCommandResult> {
    return this.run({ method: "scroll", ...opts });
  }

  hover(target: string | Point): Promise<BrowserCommandResult> {
    if (typeof target === "string") {
      return this.run({ method: "hover", ref: target });
    }
    return this.run({ method: "hover", x: target.x, y: target.y });
  }

  select(ref: string, values: string[]): Promise<BrowserCommandResult> {
    return this.run({ method: "select", ref, values });
  }

  check(ref: string, checked = true): Promise<BrowserCommandResult> {
    return this.run({ method: "check", ref, checked });
  }

  drag(
    from: string | Point,
    to: string | Point,
    opts?: { modifiers?: BrowserKeyModifier[] },
  ): Promise<BrowserCommandResult> {
    const fromPart = typeof from === "string" ? { fromRef: from } : { from };
    const toPart = typeof to === "string" ? { toRef: to } : { to };
    return this.run({ method: "drag", ...fromPart, ...toPart, ...opts });
  }

  close(): Promise<BrowserCommandResult> {
    return this.run({ method: "close" });
  }

  elementInfo(x: number, y: number): Promise<BrowserCommandResult> {
    return this.run({ method: "elementInfo", x, y });
  }

  evaluate(
    expressionOrFn: string | ((...args: unknown[]) => unknown),
  ): Promise<BrowserCommandResult> {
    // [失败路径] 函数序列化后包成 IIFE 再执行：直接 toString 会得到函数声明，
    // 在 evaluate 上下文里不是表达式，语法错误只在运行期暴露。
    const expression =
      typeof expressionOrFn === "function" ? `(${expressionOrFn.toString()})()` : expressionOrFn;
    return this.run({ method: "evaluate", expression });
  }

  getDialog(): Promise<BrowserCommandResult> {
    return this.run({ method: "getDialog" });
  }

  handleDialog(accept: boolean, promptText?: string): Promise<BrowserCommandResult> {
    return this.run({ method: "handleDialog", accept, promptText });
  }
}

// [权衡] 用类而不是带 type 字段的普通对象：Playwright 风格调用方习惯 dialog.accept()，
// 类继承让 dismiss 只实现一次。
export type JsDialog = AlertDialog | ConfirmDialog | PromptDialog | BeforeUnloadDialog;

// [并发] respond 由 Tab 注入而不是 dialog 自己发命令：
// 保证 handleDialog 仍走同一个 Tab.run，从而带上正确的 tabId 与策略。
class DialogBase {
  constructor(
    readonly type: BrowserDialog["type"],
    protected readonly respond: (accept: boolean, promptText?: string) => Promise<void>,
  ) {}

  dismiss(): Promise<void> {
    return this.respond(false);
  }
}

export class AlertDialog extends DialogBase {
  declare readonly type: "alert";
}

export class BeforeUnloadDialog extends DialogBase {
  declare readonly type: "beforeunload";
}

export class ConfirmDialog extends DialogBase {
  declare readonly type: "confirm";

  accept(): Promise<void> {
    return this.respond(true);
  }
}

export class PromptDialog extends DialogBase {
  declare readonly type: "prompt";

  accept(text: string): Promise<void> {
    return this.respond(true, text);
  }
}

// [失败路径] default 归为 alert 而不是抛错：未来 backend 新增 dialog 类型时，
// 旧版 UI 至少还能展示并关闭它，而不是让整个 getJsDialog 失败。
function createJsDialog(
  dialog: BrowserDialog,
  respond: (accept: boolean, promptText?: string) => Promise<void>,
): JsDialog {
  switch (dialog.type) {
    case "confirm":
      return new ConfirmDialog("confirm", respond);
    case "prompt":
      return new PromptDialog("prompt", respond);
    case "beforeunload":
      return new BeforeUnloadDialog("beforeunload", respond);
    default:
      return new AlertDialog("alert", respond);
  }
}

// [并发] Tab 是「绑定 + 缓存」对象：viewport 是本地镜像，playwright/recording 是长生命周期子 API，
// 所有字段都必须在构造时一次性装配，避免首次调用时惰性创建出两份不同实例。
// [权衡] wrapObject 默认是恒等函数：未注入策略时保持零开销，
// 策略注入后同一个字段必须换成代理版本（见 applyPlaywrightPolicy）。
export class Tab {
  readonly id: string;
  readonly raw: RawTab;
  readonly capabilities: BrowserCapabilityCollection;
  playwright: PlaywrightAPI;
  recording: BrowserRecordingAPI;
  private wrapObject = <T extends object>(value: T, _objectName: string): T => value;
  private viewportSizeValue: BrowserViewportSize | null;

  constructor(
    private readonly execute: BrowserExecuteFn,
    readonly tabId?: string,
    summary?: Pick<BrowserTabSummary, "url" | "title" | "active" | "viewport">,
    capabilityDescriptors: readonly BrowserCapabilityInfo[] = [],
    readCapabilityDocumentation: (name?: string) => string = () => "",
  ) {
    this.id = tabId ?? "";
    this.raw = new RawTab((command) => this.run(command));
    this.capabilities = new BrowserCapabilityCollection(
      () => capabilityDescriptors,
      readCapabilityDocumentation,
    );
    this.playwright = createPlaywrightAPI((command) => this.run(command));
    this.recording = new BrowserRecordingAPI((command) => this.run(command));
    this.viewportSizeValue = summary?.viewport ? { ...summary.viewport } : null;
  }

  // [并发] tabId 用展开复制而不是原地改 command：同一个 command 对象可能被调用方复用，
  // 原地写 tabId 会让它在多个 tab 之间串号。
  private run(command: BrowserCommand): Promise<BrowserCommandResult> {
    const withTab = this.tabId ? { ...command, tabId: this.tabId } : command;
    return this.execute(withTab);
  }

  /** Browser connection capability policy 在对象建好后注入，并保持 Playwright 对象 identity。 */
  // [事务] 三件事必须一起完成：保存 wrapObject、重建 playwright、包装 recording。
  // 漏掉 recording 会让录制 API 绕过策略，暴露 manifest 未声明的方法。
  // [权衡] 返回 this 而不是新对象：Browser 缓存与调用方引用都依赖 identity 不变。
  applyPlaywrightPolicy(policy: BrowserApiPolicy): this {
    const wrap = <T extends object>(value: T, objectName: string): T =>
      createBrowserApiProxy(value, objectName, policy, { hideUnknown: true });
    this.wrapObject = wrap;
    this.playwright = configurePlaywrightObjectWrapper(this.playwright, wrap);
    this.recording = wrap(this.recording, "BrowserRecordingAPI");
    return this;
  }

  // [失败路径] 统一在这里 expectOk：所有「只关心成功与否」的便捷方法共用一条错误出口，
  // 避免每个方法各写一遍 ok 判断而漏掉其中一个。
  private async action(command: BrowserCommand): Promise<void> {
    expectOk(command, await this.run(command));
  }

  async goto(url: string): Promise<void> {
    await this.action({ method: "navigate", url });
  }

  async url(): Promise<string | undefined> {
    return (await this.getState()).url || undefined;
  }

  async title(): Promise<string | undefined> {
    return (await this.getState()).title || undefined;
  }

  async navigate(url: string): Promise<void> {
    await this.goto(url);
  }

  // [失败路径] state 缺失时 expectPayload 抛错而不是返回空对象：
  // 空对象会让 url()/title() 静默返回 undefined，看起来像页面真的没有标题。
  async getState(): Promise<BrowserPageState> {
    const command: BrowserCommand = { method: "getState" };
    const result = await this.run(command);
    return expectPayload(command, result, result.state, "state");
  }

  /** 对齐 Playwright Page.setViewportSize；ZCode 额外施加内置自由尺寸的安全边界。 */
  // [事务] 本地镜像只在命令成功后更新：失败时保持旧值，
  // 下一次 viewportSize() 才能如实反映「这次设置没生效」。
  async setViewportSize(viewportSize: BrowserViewportSize): Promise<void> {
    validateViewportSize(viewportSize);
    await this.action({ method: "browserViewportSet", ...viewportSize });
    this.viewportSizeValue = { ...viewportSize };
  }

  /** 对齐 Playwright Page.viewportSize；返回本次 tab binding 最近一次观察到的实际值。 */
  // [失败路径] 未观察过时返回 null 而不是默认尺寸：
  // 默认值会让调用方误以为当前视口就是那个尺寸。
  viewportSize(): BrowserViewportSize | null {
    return this.viewportSizeValue ? { ...this.viewportSizeValue } : null;
  }

  // [权衡] 截图选项直接展开进 command：不同 backend 支持的子集不同，
  // 门面不做白名单裁剪，让不支持的一方明确报错而不是静默忽略。
  async screenshot(opts?: {
    fullPage?: boolean;
    clip?: { x: number; y: number; width: number; height: number };
  }): Promise<Uint8Array> {
    const command: BrowserCommand = { method: "screenshot", ...opts };
    const result = await this.run(command);
    // [资源] base64 解码成 Uint8Array 后由调用方负责落盘：
    // 门面不缓存截图，避免长会话里把每张图都留在主进程堆上。
    const image = expectPayload(command, result, result.image, "image");
    return base64ToBytes(image.base64);
  }

  async back(): Promise<void> {
    await this.action({ method: "back" });
  }

  async forward(): Promise<void> {
    await this.action({ method: "forward" });
  }

  async reload(): Promise<void> {
    await this.action({ method: "reload" });
  }

  async snapshot(opts?: {
    maxElements?: number;
    includeHidden?: boolean;
  }): Promise<BrowserSnapshot> {
    const command: BrowserCommand = { method: "snapshot", ...opts };
    const result = await this.run(command);
    return expectPayload(command, result, result.snapshot, "snapshot");
  }

  async click(
    target:
      | string
      | (Point & {
          button?: BrowserMouseButton;
          doubleClick?: boolean;
          modifiers?: BrowserKeyModifier[];
        }),
    opts?: {
      button?: BrowserMouseButton;
      doubleClick?: boolean;
      modifiers?: BrowserKeyModifier[];
    },
  ): Promise<void> {
    await this.action(
      typeof target === "string"
        ? { method: "click", ref: target, ...opts }
        : (() => {
            const { x, y, ...rest } = target;
            return { method: "click", x, y, ...rest, ...opts };
          })(),
    );
  }

  async type(text: string, opts?: { ref?: string }): Promise<void> {
    await this.action({ method: "type", text, ref: opts?.ref });
  }

  async press(
    key: string,
    opts?: { ref?: string; modifiers?: BrowserKeyModifier[] },
  ): Promise<void> {
    await this.action({ method: "press", key, ref: opts?.ref, modifiers: opts?.modifiers });
  }

  async scroll(opts: { ref?: string; x?: number; y?: number }): Promise<void> {
    await this.action({ method: "scroll", ...opts });
  }

  async hover(target: string | Point): Promise<void> {
    await this.action(
      typeof target === "string"
        ? { method: "hover", ref: target }
        : { method: "hover", x: target.x, y: target.y },
    );
  }

  async select(ref: string, values: string[]): Promise<void> {
    await this.action({ method: "select", ref, values });
  }

  async check(ref: string, checked = true): Promise<void> {
    await this.action({ method: "check", ref, checked });
  }

  async drag(
    from: string | Point,
    to: string | Point,
    opts?: { modifiers?: BrowserKeyModifier[] },
  ): Promise<void> {
    const fromPart = typeof from === "string" ? { fromRef: from } : { from };
    const toPart = typeof to === "string" ? { toRef: to } : { to };
    await this.action({ method: "drag", ...fromPart, ...toPart, ...opts });
  }

  async close(): Promise<void> {
    await this.action({ method: "close" });
  }

  // [权衡] finalize 与 markDeliverable 分开：前者作用于整个 tab 集合，
  // 后者只标记当前 tab，语义不同不能合并成同一个 command。
  async finalize(opts?: { deliverable?: boolean }): Promise<void> {
    await this.action({ method: "finalize", deliverable: opts?.deliverable });
  }

  async markDeliverable(): Promise<void> {
    await this.action({ method: "markDeliverable", tabId: this.id });
  }

  async markHandoff(): Promise<void> {
    await this.action({ method: "markHandoff", tabId: this.id });
  }

  // [失败路径] 命中空位返回 undefined 而不是抛错：坐标落在空白处是正常结果，
  // 不是命令失败，调用方据此决定是否重试。
  async elementInfo(x: number, y: number): Promise<BrowserSnapshotElement | undefined> {
    const command: BrowserCommand = { method: "elementInfo", x, y };
    const result = expectOk(command, await this.run(command));
    return result.element;
  }

  // [失败路径] 返回值原样透传：evaluate 的结果可能是 undefined / 不可序列化类型，
  // 在门面层做类型收窄会掩盖页面真实返回值。
  async evaluate(expressionOrFn: string | ((...args: unknown[]) => unknown)): Promise<unknown> {
    const expression =
      typeof expressionOrFn === "function" ? `(${expressionOrFn.toString()})()` : expressionOrFn;
    const command: BrowserCommand = { method: "evaluate", expression };
    const result = expectOk(command, await this.run(command));
    return result.value;
  }

  // [并发] dialog 是瞬时状态：这里只查询并返回快照，
  // 真正的接受/关闭必须走 handleDialog，不能把 dialog 对象当成可反复操作的句柄。
  async getDialog(): Promise<BrowserDialog | null> {
    const command: BrowserCommand = { method: "getDialog" };
    const result = expectOk(command, await this.run(command));
    return result.dialog ?? null;
  }

  // [失败路径] 没有 dialog 时返回 undefined 而不是 null：与 TS 可选返回保持一致，
  // 调用方用 if (!dialog) 即可同时覆盖两种空值。
  // [并发] objectName 必须与 dialog.type 一一对应：策略代理用它匹配 manifest 条目，
  // 写错会让 ConfirmDialog 的 accept 被隐藏成未知方法。
  async getJsDialog(): Promise<JsDialog | undefined> {
    const dialog = await this.getDialog();
    if (!dialog) return undefined;
    const value = createJsDialog(dialog, (accept, promptText) =>
      this.handleDialog(accept, promptText),
    );
    const objectName =
      dialog.type === "confirm"
        ? "ConfirmDialog"
        : dialog.type === "prompt"
          ? "PromptDialog"
          : dialog.type === "beforeunload"
            ? "BeforeUnloadDialog"
            : "AlertDialog";
    return this.wrapObject(value, objectName);
  }

  async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    await this.action({ method: "handleDialog", accept, promptText });
  }

  // [权衡] 每次访问都新建对象字面量并过代理：CUA 调用频率低，
  // 换取「策略变更后立即生效」，不需要在 Tab 上维护第二份缓存。
  get cua(): CuaTab {
    return this.wrapObject(
      {
        click: ({ x, y, button, keypress }) => {
          const modifiers = cuaModifiers(keypress);
          return this.action({
            method: "click",
            x,
            y,
            button: cuaButton(button),
            ...(modifiers.length > 0 ? { modifiers } : {}),
          });
        },
        double_click: ({ x, y, keypress }) => {
          const modifiers = cuaModifiers(keypress);
          return this.action({
            method: "click",
            x,
            y,
            doubleClick: true,
            ...(modifiers.length > 0 ? { modifiers } : {}),
          });
        },
        // [权衡] CUA 的 downloadMedia 退化为点击：该通道没有独立下载命令，
        // 点击触发浏览器自身下载是唯一可行语义，需要精确落点时由调用方给坐标。
        downloadMedia: ({ x, y }) => this.action({ method: "click", x, y }),
        // [失败路径] 空 path 在门面层就拒绝：backend 收到空路径只会原地按下，
        // 不会报错，最终表现为页面进入拖拽选中态无法恢复。
        drag: ({ keys, path }) => {
          if (path.length === 0) throw new Error("cua.drag requires a non-empty path");
          const modifiers = cuaModifiers(keys);
          return this.action({
            method: "cuaDrag",
            path,
            ...(modifiers.length > 0 ? { modifiers } : {}),
          });
        },
        keypress: ({ keys }) => this.action({ method: "cuaKeypress", keys }),
        move: ({ x, y, keys }) => {
          const modifiers = cuaModifiers(keys);
          return this.action({
            method: "hover",
            x,
            y,
            ...(modifiers.length > 0 ? { modifiers } : {}),
          });
        },
        scroll: ({ x, y, keypress, scrollX, scrollY }) => {
          const modifiers = cuaModifiers(keypress);
          return this.action({
            method: "cuaScroll",
            x,
            y,
            scrollX,
            scrollY,
            ...(modifiers.length > 0 ? { modifiers } : {}),
          });
        },
        type: ({ text }) => this.action({ method: "type", text }),
      },
      "CUAAPI",
    );
  }

  // [权衡] DOM 通道与 CUA 通道并列暴露而不是二选一：
  // 有 DOM 时前者更稳，无 DOM（canvas/跨域 iframe）时回退到坐标点击。
  get dom_cua(): DomCuaTab {
    return this.wrapObject(
      {
        get_visible_dom: () => this.snapshot(),
        click: ({ node_id }) => this.action({ method: "click", ref: node_id }),
        double_click: ({ node_id }) =>
          this.action({ method: "click", ref: node_id, doubleClick: true }),
        downloadMedia: ({ node_id }) => this.action({ method: "click", ref: node_id }),
        type: ({ text }) => this.action({ method: "type", text }),
        scroll: ({ node_id, x, y }) =>
          this.action({ method: "domCuaScroll", nodeId: node_id, scrollX: x, scrollY: y }),
        keypress: ({ keys }) => this.action({ method: "cuaKeypress", keys }),
      },
      "DomCUAAPI",
    );
  }
}

// [并发] wrapTab 是唯一注入点：Browser 用它统一套策略代理，
// 因此 Tabs 内部创建的每个 Tab（list/new/get/reuse）都必须经过 this.tab。
export class BrowserTabs {
  constructor(
    private readonly execute: BrowserExecuteFn,
    private readonly wrapTab: (tab: Tab) => Tab = (tab) => tab,
    private readonly capabilities: readonly BrowserCapabilityInfo[] = [],
    private readonly readCapabilityDocumentation: (name?: string) => string = () => "",
  ) {}

  // [失败路径] 构造 Tab 只用 summary 里的元数据，不发额外命令：
  // list 之后立刻逐 tab 查询会让一次列表操作放大成 N+1 次 IPC。
  private tab(summary: BrowserTabSummary): Tab {
    return this.wrapTab(
      new Tab(
        this.execute,
        summary.tabId,
        summary,
        this.capabilities,
        this.readCapabilityDocumentation,
      ),
    );
  }

  private async summaries(): Promise<BrowserTabSummary[]> {
    const command: BrowserCommand = { method: "list" };
    const result = await this.execute(command);
    expectOk(command, result);
    return result.tabs ?? [];
  }

  // [权衡] 可选字段用条件展开而不是给 undefined：调用方常用 Object.keys 判断字段是否存在，
  // 显式 undefined 会让「没有 title」与「title 字段缺失」混为一谈。
  async list(): Promise<BrowserTabInfo[]> {
    return (await this.summaries()).map((summary) => ({
      id: summary.tabId,
      viewport: { ...summary.viewport },
      ...(summary.active ? { active: true } : {}),
      ...(summary.title ? { title: summary.title } : {}),
      ...(summary.url ? { url: summary.url } : {}),
    }));
  }

  // [失败路径] active 不存在时退回最后一个 summary：部分 backend 在切换瞬间不回报 active，
  // 直接返回 undefined 会让 current() 误以为没有可用标签页。
  async selected(): Promise<Tab | undefined> {
    const summaries = await this.summaries();
    const selected = summaries.find((summary) => summary.active === true) ?? summaries.at(-1);
    return selected ? this.tab(selected) : undefined;
  }

  // [事务] get 由「查列表 + 激活」两步组成，不是纯查表：
  // get 的语义是「切到这个 tab 并返回句柄」，少一步激活会让后续操作打到旧 active tab。
  // [失败路径] 未命中构造 BrowserCommandError 而不是普通 Error：
  // 上层按 code=backend_unavailable 统一提示，文本不参与流程判断。
  async get(tabId: string): Promise<Tab> {
    const summary = (await this.summaries()).find((candidate) => candidate.tabId === tabId);
    if (!summary) {
      throw new BrowserCommandError(
        { method: "list" },
        {
          ok: false,
          elapsedMs: 0,
          error: { code: "backend_unavailable", message: `Browser tab '${tabId}' is unavailable` },
        },
        "backend_unavailable",
      );
    }
    const command: BrowserCommand = { method: "activateTab", tabId };
    const result = await this.execute(command);
    const activated = expectPayload(command, result, result.tab, "tab");
    return this.tab(activated);
  }

  async new(): Promise<Tab> {
    const command: BrowserCommand = { method: "newTab" };
    const result = await this.execute(command);
    const summary = expectPayload(command, result, result.tab, "tab");
    return this.tab(summary);
  }

  /**
   * open(url) 的复用入口：按 URL 匹配已有 agent-owned tab，命中则激活（activateTab，
   * 用户立即看到该 tab）并返回，未命中返回 undefined。list/activate 的失败向调用方抛出，
   * 由 open() 统一降级为 newTab，复用链路绝不阻断任务。
   */
  // [失败路径] 未命中返回 undefined 而不是抛错：复用是优化路径，
  // 调用方据此走 newTab，不应把「没有可复用 tab」当成错误。
  // [并发] 命中后必须 activate 再返回：只返回句柄不激活，
  // 用户看不到复用的结果，会以为又开了一个后台标签。
  async reuse(url: string): Promise<Tab | undefined> {
    const summaries = await this.summaries();
    const matched = selectTabForUrl(url, summaries);
    if (!matched) return undefined;
    const command: BrowserCommand = { method: "activateTab", tabId: matched.tabId };
    const result = await this.execute(command);
    const activated = expectPayload(command, result, result.tab, "tab");
    return this.tab(activated);
  }

  // [权衡] keep 支持三种入参（id / Tab / {id}）：兼容脚本与模型两种调用习惯，
  // 在门面层统一收敛成 tabId，host 侧只认一种形状。
  async finalize(
    options: {
      keep?: Array<{
        tab: string | Tab | { id: string };
        status: "handoff" | "deliverable";
      }>;
    } = {},
  ): Promise<void> {
    const keep = (options.keep ?? []).map(({ tab, status }) => ({
      tabId: typeof tab === "string" ? tab : tab.id,
      status,
    }));
    const command: BrowserCommand = { method: "finalizeTabs", keep };
    expectOk(command, await this.execute(command));
  }
}

// [失败路径] 所有字段可选：历史查询由 backend 决定支持范围，
// 门面不做默认值填充，否则会把「未指定」与「显式指定默认值」混为一谈。
export interface BrowserHistoryOptions {
  from?: string | Date;
  limit?: number;
  queries?: string[];
  to?: string | Date;
}

// [权衡] dateVisited 固定为 string：跨进程传输不保留 Date 实例，
// 在门面层解析会让非法值提前抛错，掩盖 backend 原始数据。
export interface BrowserHistoryEntry {
  dateVisited: string;
  title?: string;
  url: string;
}

// [权衡] user 与 tabs 分开：前者面向「用户已打开的标签页」（需授权认领），
// 后者面向 agent 自己拥有的标签页，两者的权限与生命周期完全不同。
export class BrowserUser {
  constructor(
    private readonly execute: BrowserExecuteFn,
    private readonly wrapTab: (tab: Tab) => Tab,
    private readonly capabilities: readonly BrowserCapabilityInfo[] = [],
    private readonly readCapabilityDocumentation: (name?: string) => string = () => "",
  ) {}

  // [失败路径] userTabs 缺失时返回空数组：部分 backend 不实现用户标签枚举，
  // 返回 undefined 会让调用方对 undefined 做 map。
  async openTabs(): Promise<BrowserUserTabInfo[]> {
    const command: BrowserCommand = { method: "listUserTabs" };
    const result = expectOk(command, await this.execute(command));
    return result.userTabs ?? [];
  }

  // [事务] 认领结果以 host 返回的 summary 为准，而不是本地入参：
  // 认领后 tabId 可能被规范化，继续用入参构造句柄会指向不存在的 tab。
  async claimTab(tab: string | BrowserUserTabInfo): Promise<Tab> {
    const command: BrowserCommand = {
      method: "claimTab",
      tabId: typeof tab === "string" ? tab : tab.id,
    };
    const result = await this.execute(command);
    const summary = expectPayload(command, result, result.tab, "tab");
    return this.wrapTab(
      new Tab(
        this.execute,
        summary.tabId,
        summary,
        this.capabilities,
        this.readCapabilityDocumentation,
      ),
    );
  }

  // [失败路径] 保留方法但必须抛错：manifest 会在 iab 下隐藏该 member，
  // 直接调用属于越界使用，伪造空历史会掩盖 backend 不支持的事实。
  async history(_options: BrowserHistoryOptions = {}): Promise<BrowserHistoryEntry[]> {
    // IAB 没有 Chromium History provider。该 member 会由 IAB manifest override 隐藏；保留方法
    // 只用于未来 extension backend 复用同一对象类型，避免当前 backend 伪造历史记录。
    throw new Error("Browser history is unavailable for the iab backend");
  }
}

// [并发] Browser 是 backend 的持久门面：tabs/user/defaultTab 都在构造时建好并复用，
// 不能按需重建，否则调用方缓存的子对象会与新的 policy 脱节。
export class Browser {
  readonly tabs: BrowserTabs;
  readonly user: BrowserUser;
  readonly capabilities: BrowserCapabilityCollection;
  private readonly defaultTab: Tab;
  private info: BrowserInfo;
  private readonly execute: BrowserExecuteFn;
  private readonly policy: BrowserApiPolicy;
  private readonly runtimeObject: Browser;

  constructor(
    info: BrowserInfo,
    execute: BrowserTransportExecuteFn,
    private readonly readDocumentation: (name?: string, descriptor?: BrowserInfo) => string,
    manifest: BrowserApiManifest,
    assertAvailable: BrowserAvailabilityGuard = () => undefined,
  ) {
    this.info = info;
    this.policy = new BrowserApiPolicy(manifest, info);
    // [并发] 这里刻意在每次调用时读 this.info：updateInfo 会替换 descriptor，
    // 若在构造时把 id/generation 解构成常量，后续命令会永远带旧 generation。
    this.execute = (command) => execute(this.info.id, this.info.generation, command);
    const capabilityDocumentation = (name?: string) => this.readDocumentation(name, this.info);
    const wrapTab = (tab: Tab) =>
      createBrowserApiProxy(tab.applyPlaywrightPolicy(this.policy), "Tab", this.policy);
    this.capabilities = new BrowserCapabilityCollection(
      () => this.info.capabilities.browser ?? [],
      capabilityDocumentation,
      this.execute,
      assertAvailable,
    );
    this.tabs = createBrowserApiProxy(
      new BrowserTabs(
        this.execute,
        wrapTab,
        this.info.capabilities.tab ?? [],
        capabilityDocumentation,
      ),
      "Tabs",
      this.policy,
    );
    this.user = createBrowserApiProxy(
      new BrowserUser(
        this.execute,
        wrapTab,
        this.info.capabilities.tab ?? [],
        capabilityDocumentation,
      ),
      "BrowserUser",
      this.policy,
    );
    this.defaultTab = wrapTab(
      new Tab(
        this.execute,
        undefined,
        undefined,
        this.info.capabilities.tab ?? [],
        capabilityDocumentation,
      ),
    );
    // [权衡] 暴露给运行时的是代理而不是 this：模型只能看到 manifest 声明的方法，
    // raw 字段通过显式属性白名单保留，避免内部状态被直接改写。
    this.runtimeObject = createBrowserApiProxy(this, "Browser", this.policy);
  }

  // [权衡] id/browserId 并存是迁移期的兼容：新代码统一用 browserId，
  // 旧脚本仍读 id，两者必须指向同一个值，不能各自回退到 type。
  get browserId(): string {
    return this.info.id;
  }

  get type(): BrowserBackendType {
    return this.info.type;
  }

  get generation(): number {
    return this.info.generation;
  }

  /** @deprecated 迁移兼容；新代码使用 browserId。 */
  get id(): string {
    return this.browserId;
  }

  /** @deprecated 迁移兼容；新代码使用 descriptor.type。 */
  get backend(): BrowserBackendType {
    return this.type;
  }

  get default(): Tab {
    return this.defaultTab;
  }

  async documentation(): Promise<string> {
    return this.readDocumentation(undefined, this.info);
  }

  // [失败路径] 空名（含纯空白）直接拒绝：会话名会进入宿主侧索引，
  // 空串与全空格会被归一成同一个键，导致两个会话互相覆盖。
  async nameSession(name: string): Promise<void> {
    if (!name.trim()) throw new Error("browser.nameSession requires a non-empty name");
    const command: BrowserCommand = { method: "nameSession", name };
    expectOk(command, await this.execute(command));
  }

  /** registry refresh 后保留对象 identity，同时更新 capability/metadata。 */
  // [事务] 只更新 info 与 policy 两处：tabs/user 已持有 this.execute 闭包，
  // 会随 this.info 自动拿到新 generation，不需要也不能重建它们。
  updateInfo(info: BrowserInfo): void {
    this.info = info;
    this.policy.updateDescriptor(info);
  }

  executeCommand(command: BrowserCommand): Promise<BrowserCommandResult> {
    return this.execute(command);
  }

  // [权衡] 不做 list 校验：union 上层刚从 tabs.list 拿到 id，再查一次纯属浪费；
  // 真正的合法性由 host 在收到命令时判断。
  createTab(tabId: string): Tab {
    return createBrowserApiProxy(
      new Tab(this.execute, tabId, undefined, this.info.capabilities.tab ?? [], (name) =>
        this.readDocumentation(name, this.info),
      ),
      "Tab",
      this.policy,
    );
  }

  asRuntimeObject(): Browser {
    return this.runtimeObject;
  }
}

// [并发] browsers Map 是对象 identity 的唯一来源：同 id 同 generation 复用 raw+runtime，
// 调用方拿到的 Browser 引用在多次 list 之间保持稳定。
export class BrowsersFacade {
  private readonly assertAvailable: BrowserAvailabilityGuard;
  private readonly transport: BrowserClientTransport;
  private readonly readDocumentation: (name?: string, descriptor?: BrowserInfo) => string;
  private readonly manifest: BrowserApiManifest;
  private readonly browsers = new Map<string, { raw: Browser; runtime: Browser }>();
  private readonly runtimeObject: BrowsersFacade;

  constructor(
    transport: BrowserClientTransport,
    options: {
      documentationRoot?: string;
      assertAvailable?: BrowserAvailabilityGuard;
    } = {},
  ) {
    const assertAvailable = options.assertAvailable ?? (() => undefined);
    this.assertAvailable = assertAvailable;
    // Browser 对象是持久引用，内核 reset 后旧绑定必须失效。guard 必须包住持久对象的每次
    // transport/doc 调用，不能只在初始化时判断。
    // [失败路径] 包装后的 transport 每次调用都先 assertAvailable：
    // 内核 reset 后旧 binding 会失效，这个 guard 是唯一能与 reset 同步的检查点。
    // [并发] 故意包一层新对象而不是改 transport 实例：外部传入的 transport 可能被复用，
    // 原地替换其方法会影响其他 facade。
    this.transport = {
      list: async () => {
        assertAvailable();
        return await transport.list();
      },
      execute: async (browserId, browserGeneration, command) => {
        assertAvailable();
        return await transport.execute(browserId, browserGeneration, command);
      },
    };
    // [资源] manifest 在构造时同步加载一次：它是静态能力声明，
    // 放进每次 command 的路径会引入文件 IO 抖动，且内容不会变。
    this.manifest = loadBrowserApiManifest(options.documentationRoot);
    this.readDocumentation = (name, descriptor) => {
      assertAvailable();
      return loadBrowserDocumentation(options.documentationRoot, name, descriptor);
    };
    const topLevelPolicy = new BrowserApiPolicy(this.manifest, {
      id: "browser-client",
      generation: 0,
      type: "iab",
      name: "Browser client",
      capabilities: {},
    });
    // [权衡] 顶层策略用合成 descriptor（id=browser-client, generation=0）：
    // facade 本身不是 backend，不能借用某个真实 browser 的能力表。
    this.runtimeObject = createBrowserApiProxy(this, "Browsers", topLevelPolicy, {
      hideUnknown: true,
    });
  }

  asRuntimeObject(): BrowsersFacade {
    return this.runtimeObject;
  }

  private async listAvailable(): Promise<BrowserInfo[]> {
    return await this.transport.list();
  }

  // [权衡] 对外描述符剥离 generation：generation 是内部绑定版本，
  // 暴露出去会诱导调用方用它做缓存键，而正确做法是通过对象 identity 复用。
  async list(): Promise<BrowserDescriptor[]> {
    return (await this.listAvailable()).map(
      ({ generation: _generation, ...descriptor }) => descriptor,
    );
  }

  // [失败路径] 先按 id 再按 type 匹配：id 唯一，type 可能对应多个 backend，
  // 反过来会导致同名 type 下总是返回第一个，用户无法指定具体实例。
  // [权衡] 错误消息里带上可用列表：这是唯一能告诉调用方「你该填什么」的位置。
  async get(idOrType: string): Promise<Browser> {
    const infos = await this.listAvailable();
    const info =
      infos.find((candidate) => candidate.id === idOrType) ??
      infos.find((candidate) => candidate.type === idOrType);
    if (!info) {
      const available = infos.map((candidate) => `${candidate.type}:${candidate.id}`).join(", ");
      throw new BrowserCommandError(
        { method: "list" },
        {
          ok: false,
          elapsedMs: 0,
          error: {
            code: "backend_unavailable",
            message: `Browser backend '${idOrType}' is unavailable${available ? `; available: ${available}` : ""}`,
          },
        },
        "backend_unavailable",
      );
    }
    return this.browserFor(info);
  }

  // [失败路径] 无默认 backend 时用哨兵 id 走 get 的错误路径：
  // 保证「没有默认」和「指定了不存在的 backend」给出同一种错误结构。
  async getDefault(): Promise<Browser> {
    const info = selectDefaultBrowser(await this.listAvailable());
    if (!info) {
      return this.get("__no_browser_backend__");
    }
    return this.browserFor(info);
  }

  // [失败路径] 0 个 backend 与 1 个 backend 都提前返回：
  // 前者必须报错，后者无需探测 tab（唯一选项即答案），省掉一轮 IPC。
  // [并发] 多 backend 时并行探测再交给纯函数决策：
  // 串行会让选择耗时随 backend 数线性增长，而它们彼此独立。
  async getForUrl(url: string): Promise<Browser> {
    const infos = await this.listAvailable();
    if (infos.length === 0) {
      return this.get("__no_browser_backend__");
    }
    if (infos.length === 1) {
      return this.browserFor(infos[0]);
    }

    const tabsByBrowserId = new Map<string, readonly string[]>();
    await Promise.all(
      infos.map(async (info) => {
        try {
          const tabs = await this.browserFor(info).tabs.list();
          tabsByBrowserId.set(
            info.id,
            tabs.flatMap((tab) => (tab.url ? [tab.url] : [])),
          );
        } catch {
          tabsByBrowserId.set(info.id, []);
        }
      }),
    );
    // [权衡] 选择逻辑放在 selection.ts 的纯函数里：门面只负责取数据，
    // 这样「按 URL 选 backend」的规则可以单测，不需要构造整条 transport。
    return this.browserFor(selectBrowserForUrl(infos, url, tabsByBrowserId));
  }

  // [事务] 复用优先于新建，且复用失败必须降级：顺序反了会重新引入「标签页堆满」的问题。
  // [并发] reuse 之后立刻 goto：复用命中只是激活旧 tab，
  // 不 goto 会把旧页面内容当成本次任务的起点。
  async open(url?: string, options: { reuseTab?: boolean } = {}): Promise<Tab> {
    const browser = await this.getDefault();
    if (url && options.reuseTab !== false) {
      // 已知问题：模型每次 open() 都新开 tab，任务结束后内置浏览器堆满标签页。
      // 默认按 URL 复用已有 agent-owned tab（tabs.list 只含本 scope 的 owned tabs，
      // 不会误接管用户 tab）：激活给用户并在原地 goto 刷新；复用链路任何失败都
      // 降级 newTab。需要并排独立 tab 时模型可显式传 reuseTab: false。
      const reusable = await browser.tabs.reuse(url).catch(() => undefined);
      if (reusable) {
        await reusable.goto(url);
        return reusable;
      }
    }
    const tab = await browser.tabs.new();
    if (url) {
      await tab.goto(url);
    }
    return tab;
  }

  // [失败路径] selected 为空时直接 new：current 的语义是「给我一个可用的 tab」，
  // 返回 undefined 会把「没有标签页」这一正常状态变成调用方错误。
  async current(): Promise<Tab> {
    const browser = await this.getDefault();
    return (await browser.tabs.selected()) ?? browser.tabs.new();
  }

  // [并发] 用 createTab 惰性绑定：list 只枚举 binding，不需要也不应该激活任何 tab；
  // 这正是它不能复用 tabs.get 的原因。
  async listTabs(): Promise<Tab[]> {
    const browser = await this.getDefault();
    // 兼容 listTabs 只枚举 binding，不能逐个调用 tabs.get()；get 现在有显式激活语义，
    // 批量 get 会依次抢占 active tab，且并发执行时最终选中项不确定。
    return (await browser.tabs.list()).map((tab) => browser.createTab(tab.id));
  }

  // [事务] 先把 browser promise 固定下来再闭包：这是 INV-04 的唯一实现点，
  // 去掉这层固定会让每条命令重新选择 backend。
  tab(tabId: string): Tab {
    // 兼容入口仍需冻结创建时选中的 browser；不能在每条命令时重跑 default，
    // 否则 backend 上下线后同一个 tabId 可能被错误发送到另一连接。
    const browser = this.getDefault();
    return new Tab(async (command) => (await browser).executeCommand(command), tabId);
  }

  // [失败路径] 作为同步方法只读本地文件：调用方（工具描述生成）在构造阶段就会调用，
  // 不能在这里引入 await 或 backend 往返。
  documentation(name?: string): string {
    return this.readDocumentation(name);
  }

  // [事务] 命中缓存的判定必须同时看 id 与 generation：同 id 不同 generation 代表内核已重启，
  // 旧对象的所有子句柄都必须作废。
  // [并发] 缓存里同时存 raw 与 runtime：raw 用于 updateInfo（内部可变），
  // runtime 是给调用方的代理，二者必须成对写入，不能只更新其中一个。
  private browserFor(info: BrowserInfo): Browser {
    const existing = this.browsers.get(info.id);
    if (existing && existing.raw.generation === info.generation) {
      existing.raw.updateInfo(info);
      return existing.runtime;
    }
    const raw = new Browser(
      info,
      this.transport.execute,
      this.readDocumentation,
      this.manifest,
      this.assertAvailable,
    );
    const runtime = raw.asRuntimeObject();
    this.browsers.set(info.id, { raw, runtime });
    return runtime;
  }
}
