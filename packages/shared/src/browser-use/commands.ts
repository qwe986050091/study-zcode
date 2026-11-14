// 文件职责边界：browser-use 命令协议的唯一运行时事实源，BrowserCommand 是以 method 为判别键的 Zod 联合。
// 只声明方法与参数形状：不做参数语义校验、不做能力协商、不触碰 CDP、不读写文件系统。
// 使用方：desktop 的 browser-use manager、agent 工具层、extension 与 CDP adapter，均从本文件取类型。
// 非职责：执行语义、超时、重试、tab 生命周期与 webview 卸载、录制文件落盘，全部在 manager 与 executor。
//
// INV 表：以下断言任一被破坏，协议都会在调用方与后端之间静默漂移。
// INV-01 断言：browserCommandSchema 以 method 判别且每个分支 strict —— 守住它的位置：browserCommandSchema 的 discriminatedUnion 与各分支结尾 —— 改错故障：method 与分支漂移后 manager 路由拿不到实现，命令落入未知分支。
// INV-02 断言：每个命令对象都拒绝未知字段 —— 守住它的位置：各 z.object 的 strict 标记 —— 改错故障：agent 把 tabId 拼成 tabid 被剥离，命令打到默认 view 上改错 tab。
// INV-03 断言：tabId 在所有命令里可选，缺省表示该会话默认 view —— 守住它的位置：每个分支的 tabId 字段 —— 改错故障：改成必填后旧 agent 全部校验失败，且无法再表达默认 view。
// INV-04 断言：click 的 ref 与坐标 x、y 至少给一组 —— 守住它的位置：click 分支里 ref 与 x、y 的可选组合 —— 改错故障：两者都当必填时坐标点击不可用，都放行且执行端只取坐标时快照句柄失效会点到空白。
// INV-05 断言：cuaKeypress 的 keys 保留逐键 down 与 up 顺序 —— 守住它的位置：cuaKeypress 分支的 keys 数组 —— 改错故障：压成末键加修饰键位掩码后三键组合漏键，页面快捷键失效。
// INV-06 断言：cuaScroll 的视口锚点 x、y 与滚动量 scrollX、scrollY 分开必填 —— 守住它的位置：cuaScroll 分支的四个字段 —— 改错故障：把滚动量当坐标传，滚动落点错误并可能触发 hover。
// INV-07 断言：cuaDrag 接受完整 path 而不是首尾两点 —— 守住它的位置：cuaDrag 分支的 path 数组 —— 改错故障：执行端只发首尾两点，HTML5 拖放缺少中间 move 而不触发。
// INV-08 断言：screenshot 的 clip 与 fullPage 互斥 —— 守住它的位置：screenshot 分支的 clip 对象 —— 改错故障：两者同传时 CDP 忽略 clip，截图区域与调用方选区不一致。
// INV-09 断言：录制动作只允许白名单 type，不提供任意脚本执行 —— 守住它的位置：browserRecordingActionSchema 的判别联合 —— 改错故障：录制入口变成任意 JS 通道，权限模型失效。
// INV-10 断言：录制单步时长上限 90000，与 maxDurationMs 上限同源 —— 守住它的位置：browserRecordingDurationSchema 的 max —— 改错故障：单步超过整段录制，时间轴被截断且帧数与动作数对不上。
// INV-11 断言：recording 的 outputPath 必须是工作区内相对路径并以 .webm 结尾 —— 守住它的位置：browserRecordingOutputPathSchema 的三段 refine —— 改错故障：绝对路径或上跳路径把文件写到工作区外。
// INV-12 断言：outputPath 拒绝空段与点段 —— 守住它的位置：路径分段检查 —— 改错故障：双斜杠路径与点开头路径归一化后覆盖预期外的已有文件。
// INV-13 断言：playwright locator 只暴露十六个终结操作 —— 守住它的位置：browserPlaywrightLocatorOperationSchema —— 改错故障：调用未注册操作时 executor 抛 unknown operation，整条命令失败。
// INV-14 断言：playwright selectOption 必须给出 value、label、index 之一 —— 守住它的位置：browserPlaywrightSelectOptionSchema 的 refine —— 改错故障：空选择对象被接受，下拉框被清空而不是保持原值。
// INV-15 断言：playwright 条件超时只接受正整数，0 非法 —— 守住它的位置：browserPlaywrightTimeoutSchema 的 positive —— 改错故障：放宽后 0 被解释成立即超时，条件等待永久失败。
// INV-16 断言：playwrightWaitForTimeout 的 timeoutMs 允许 0 但必须非负整数 —— 守住它的位置：该分支自己的 nonnegative 约束 —— 改错故障：收紧成正整数后，轮询脚本里的 0 等待直接校验失败。
//
// 维护约定：只增不改判别键与字段名；新增 method 时同步 manager 路由、executor 实现与 capabilities 回包。
// 本文件由 eslint max-lines 豁免，原因是拆分会让判别联合与协议方法漂移，不要以行数为由拆分。
/* eslint-disable max-lines -- BrowserCommand 的 Zod discriminated union 必须保持单一运行时事实源，拆分会让协议方法与 schema 漂移。 */
import { z } from "zod";
// [契约] 依赖方向：commands 单向依赖 command-metadata，只借 viewport 输入 schema 与协议基础枚举。
// 反向引用会让 command-metadata 反过来需要 BrowserCommand 类型，形成运行时循环依赖。
// 新增命令若需要 viewport 之外的基础 schema，先下沉到 command-metadata，不要在这里复制一份。
// 这里不重新对外暴露 viewport schema，避免同一符号出现两个公开入口与两份文档。
import { browserViewportInputSchema } from "./command-metadata.js";

export {
  browserClientModeSchema,
  browserCommandContextSchema,
  browserCommandMethodSchema,
  browserErrorCodeSchema,
  browserPageStateSchema,
} from "./command-metadata.js";
export type {
  BrowserClientMode,
  BrowserCommandContext,
  BrowserCommandMethod,
  BrowserErrorCode,
  BrowserPageState,
} from "./command-metadata.js";

// [契约] 鼠标键闭集只有 left、right、middle，与 CDP Input.dispatchMouseEvent 的 button 取值同名。
// 新增 back、forward 这类侧键会穿透到所有 backend，先确认 extension 与 CDP 两条链路都支持。
// 录制 DSL 的 click.button 与命令 click.button 共用此枚举，改一处等于同时改两条协议。
// 未收到 button 时 executor 按 left 处理，不要把 middle 提到前面改变默认语义。
export const browserMouseButtonSchema = z.enum(["left", "right", "middle"]);
export type BrowserMouseButton = z.infer<typeof browserMouseButtonSchema>;

/** 键盘修饰键；CDP dispatchMouse/KeyEvent 的 modifiers 位掩码由 executor 映射。 */
// [契约] 修饰键名沿用 Playwright 命名，ControlOrMeta 表示 macOS 用 Meta、其他平台用 Control。
// 字符串到 CDP modifiers 位掩码的映射在 executor，schema 层不做平台判断。
// 不要加 Cmd、Win 这类别名，backend 收到未映射值会静默丢掉修饰键。
// playwright 侧另有 browserPlaywrightModifierSchema，取值一致但故意分开，便于各自演进。
export const browserKeyModifierSchema = z.enum([
  "Alt",
  "Control",
  "ControlOrMeta",
  "Meta",
  "Shift",
]);
export type BrowserKeyModifier = z.infer<typeof browserKeyModifierSchema>;

/** 视口坐标点（cua 坐标路 / elementInfo / drag 用；与 CDP Input 同坐标系）。 */
// [契约] 视口坐标点，原点在视口左上，单位是 CSS px，与 CDP Input 及截图 clip 同一坐标系。
// strict 保证多余的 pageX、z 不会被悄悄带入，避免调用方误以为这里支持页面滚动坐标。
// 拖动路径与录制 drag 都复用此点结构，改字段名会同时破坏两条协议。
// 坐标不做正负校验，越界点击由执行端按 CDP 裁切，schema 提前拒绝反而挡掉合法边缘点。
export const browserPointSchema = z.object({ x: z.number(), y: z.number() }).strict();
export type BrowserPoint = z.infer<typeof browserPointSchema>;

// [权衡] 单步等待上限 90000 与录制总时长 maxDurationMs 的上限保持一致，避免单步吃掉整段。
// 必须是整数毫秒，小数会让帧调度出现半帧累积，ffmpeg 时间轴无法对齐。
// 0 合法表示立即继续，不要收紧成 positive，否则 wait 0 这类脚本会被拒。
// 此 schema 同时用于 delayAfterMs、intervalMs、settleMs，改上限要同步 options 里的 maxDurationMs。
const browserRecordingDurationSchema = z.number().int().nonnegative().max(90_000);
const browserRecordingSelectorSchema = z.string().trim().min(1).max(2_000);

/** 内置 WebView 录制只接受受限动作 DSL；不能借录制入口执行任意页面脚本。 */
// [契约] 内置 WebView 录制只接受十个受限动作，type 是判别键：wait、click、type、hover、move、scroll、scrollTo、wheel、drag、waitFor。
// 白名单的意义是不给录制入口留任意脚本执行能力，evaluate 这类动作绝不能加进来。
// click、hover、scrollTo 的 selector 与 x、y 都可选，执行端按 selector 优先、坐标兜底。
// waitFor 的 timeoutMs 上限 30000，比单步时长更短，防止整段录制卡在元素等待。
// 每个分支都有 strict，新增字段必须同步改走查执行端，否则老版本会因未知字段拒收整条录制。
export const browserRecordingActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("wait"), durationMs: browserRecordingDurationSchema }).strict(),
  z
    .object({
      type: z.literal("click"),
      selector: browserRecordingSelectorSchema.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      button: browserMouseButtonSchema.optional(),
      doubleClick: z.boolean().optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("type"),
      selector: browserRecordingSelectorSchema,
      text: z.string().max(100_000),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("hover"),
      selector: browserRecordingSelectorSchema.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("move"),
      x: z.number(),
      y: z.number(),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      deltaX: z.number().optional(),
      deltaY: z.number(),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("scrollTo"),
      selector: browserRecordingSelectorSchema.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("wheel"),
      deltaX: z.number().optional(),
      deltaY: z.number(),
      times: z.number().int().min(1).max(100).optional(),
      intervalMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("drag"),
      path: z.array(browserPointSchema).min(2).max(200),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("waitFor"),
      selector: browserRecordingSelectorSchema,
      state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
      timeoutMs: z.number().int().positive().max(30_000).optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
]);
export type BrowserRecordingAction = z.infer<typeof browserRecordingActionSchema>;

// [权衡] fps 范围 1 到 60、jpegQuality 范围 1 到 100，都是录制管线的硬边界。
// maxDurationMs 最小 1000，小于 1 秒的录制没有可交付帧，宁可拒绝也不要产出坏文件。
// actions 上限 500 条，超出的录制会让内存里的动作表与帧时间轴同时膨胀。
// viewport 复用 browserViewportInputSchema，录制尺寸与后续视口设置共用同一套校验。
export const browserRecordingOptionsSchema = z
  .object({
    viewport: browserViewportInputSchema.optional(),
    fps: z.number().int().min(1).max(60).optional(),
    jpegQuality: z.number().int().min(1).max(100).optional(),
    maxDurationMs: z.number().int().min(1_000).max(90_000).optional(),
    settleMs: browserRecordingDurationSchema.optional(),
    showCursor: z.boolean().optional(),
    actions: z.array(browserRecordingActionSchema).max(500).optional(),
  })
  .strict();
export type BrowserRecordingOptions = z.infer<typeof browserRecordingOptionsSchema>;

// [失败路径] 三段 refine 依次拒绝绝对路径、含上跳段或空段的路径、以及非 .webm 后缀。
// 第一段同时匹配 POSIX 的斜杠开头与 Windows 的盘符，Windows 上尤其不能只看前者。
// 第二段按两种斜杠切段检查，双斜杠与点斜杠都会被拒，避免归一化后覆盖预期外文件。
// 第三段限定 webm，是因为录制管线只产出 WebM，改成 mp4 会让下游封装流程找不到文件。
// 这里只做形状校验，工作区根目录的拼接与目录创建由 manager 完成，schema 不碰文件系统。
const browserRecordingOutputPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine((value) => !/^[/\\]/u.test(value) && !/^[A-Za-z]:[/\\]/u.test(value), {
    message: "recording outputPath must be relative to the workspace",
  })
  .refine(
    (value) =>
      !value
        .split(/[\\/]+/u)
        .some((segment) => segment === ".." || segment === "." || segment.length === 0),
    { message: "recording outputPath cannot escape the workspace" },
  )
  .refine((value) => value.toLowerCase().endsWith(".webm"), {
    message: "recording outputPath must end with .webm",
  });

/** Playwright locator 的可跨进程终结操作。builder 本身只在 agent 内组合 selector。 */
// [契约] 只暴露可跨进程终结的 locator 操作，共十六个，从 allTextContents 到 waitFor。
// builder 在 agent 内组合 selector，跨进程只传终结操作，避免把 Playwright 对象带过边界。
// evaluate 也在这个枚举里，说明定位器级执行仍被允许，但参数走 expression 与 arg 通道。
// 新增操作必须同时在 executor 注册实现，否则会得到 unknown operation 的运行时错误。
export const browserPlaywrightLocatorOperationSchema = z.enum([
  "allTextContents",
  "click",
  "count",
  "dblclick",
  "downloadMedia",
  "evaluate",
  "fill",
  "getAttribute",
  "innerText",
  "isEnabled",
  "isVisible",
  "press",
  "selectOption",
  "setChecked",
  "textContent",
  "waitFor",
]);
export type BrowserPlaywrightLocatorOperation = z.infer<
  typeof browserPlaywrightLocatorOperationSchema
>;

export const browserPlaywrightModifierSchema = z.enum([
  "Alt",
  "Control",
  "ControlOrMeta",
  "Meta",
  "Shift",
]);
export type BrowserPlaywrightModifier = z.infer<typeof browserPlaywrightModifierSchema>;

// [契约] Playwright 侧条件超时只接受正整数，0 不合法，缺省表示沿用 backend 默认。
// 与 playwrightWaitForTimeout 的非负约束故意不同：前者等条件，后者主动让出时间片。
// 把这里放宽成 nonnegative，会让 0 被解释成立即超时，两端行为漂移。
// 所有 playwright 子动作共用此 schema，改它等于一次性改掉全部超时语义。
const browserPlaywrightTimeoutSchema = z.number().int().positive().optional();
// [契约] 选项三元组 value、label、index 至少给一个，refine 的报错文本已是对外契约。
// index 用 nonnegative 整数，Playwright 的 0 表示第一项，不要收紧成 positive。
// strict 保证选择对象里不会混入 selected 这类未实现字段而被当成有效选择。
// 空对象被拒是关键，否则 selectOption 会拿到空数组，下拉框被清空而不是保持原值。
const browserPlaywrightSelectOptionSchema = z
  .object({
    value: z.string().optional(),
    label: z.string().optional(),
    index: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (selection) =>
      selection.value !== undefined ||
      selection.label !== undefined ||
      selection.index !== undefined,
    "Select option requires value, label, or index",
  );

/**
 * Playwright 公共操作使用与 backend 无关的消息结构，以 `name` 和 `operation` 区分动作，
 * 便于 extension/CDP adapter 复用同一契约。
 */
// [契约] 以 name 而非 method 判别，是因为该联合嵌在 playwright 命令的 action 字段里。
// 十个动作覆盖快照、元素信息、求值、加载态、URL、事件、下载与 locator，与 backend 无关。
// locator 分支字段最多，selector 必填，其余按 operation 语义可选，schema 不做交叉校验。
// 新增分支要同时更新 extension 与 CDP adapter，两条链路共用这套消息结构。
export const browserPlaywrightActionSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("domSnapshot") }).strict(),
  z
    .object({
      name: z.literal("elementInfo"),
      x: z.number(),
      y: z.number(),
      includeNonInteractable: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      name: z.literal("elementScreenshot"),
      x: z.number(),
      y: z.number(),
      includeNonInteractable: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      name: z.literal("evaluate"),
      expression: z.string().min(1),
      expressionKind: z.enum(["string", "function"]),
      arg: z.unknown().optional(),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("waitForLoadState"),
      state: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("waitForURL"),
      url: z.string().min(1),
      waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional(),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("waitForEvent"),
      event: z.enum(["download", "filechooser"]),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("downloadPath"),
      downloadId: z.string().min(1),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("fileChooserSetFiles"),
      fileChooserId: z.string().min(1),
      files: z.array(z.string()).min(1),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("locator"),
      selector: z.string().min(1),
      operation: browserPlaywrightLocatorOperationSchema,
      value: z.unknown().optional(),
      arg: z.unknown().optional(),
      expression: z.string().min(1).optional(),
      expressionKind: z.enum(["string", "function"]).optional(),
      attribute: z.string().min(1).optional(),
      checked: z.boolean().optional(),
      replace: z.boolean().optional(),
      force: z.boolean().optional(),
      button: browserMouseButtonSchema.optional(),
      modifiers: z.array(browserPlaywrightModifierSchema).optional(),
      state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
      selections: z.array(browserPlaywrightSelectOptionSchema).min(1).optional(),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
]);
export type BrowserPlaywrightAction = z.infer<typeof browserPlaywrightActionSchema>;

/**
 * 统一命令面：后端只认这一个判别联合类型。
 *
 * tabId（可选）：agent 对象模型用于寻址指定受控 tab（含 human 开的 tab）。缺省表示作用于
 * 该会话默认 view。manager 侧以 `command.tabId ?? key` 解析为受控 view 的 key。
 */
// [契约] 全仓唯一命令面，后端只认这一个判别联合，method 是判别键且每个分支 strict。
// tabId 可选，manager 以命令的 tabId 优先、会话 key 兜底来解析受控 view，缺省即默认 view。
// schema 不校验 tabId 是否存在或已归属，那属于 manager 的归属校验，提前拒绝会让 claimTab 流程断。
// [并发] 同一 tab 上的命令由会话串行队列派发，schema 只保证参数不可变，不在协议层排队。
// 新增 method 必须同步 manager 路由、executor 实现与 capability 声明，三处缺一都表现为命令黑洞。
export const browserCommandSchema = z.discriminatedUnion("method", [
  z
    .object({
      // [失败路径] url 只要求非空字符串，这里不做 scheme 白名单，about:blank 与 data 也在合法面内。
      // 若在这里限制 http 与 https，本地预览页与内嵌页面会直接校验失败。
      // 导航超时与历史记录写入由 executor 负责，给 schema 加 timeoutMs 会让旧调用方不兼容。
      // navigate 之后是否等待加载由调用方用 waitFor 组合，不要在这里偷偷塞默认等待。
      method: z.literal("navigate"),
      url: z.string().min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("back"), tabId: z.string().optional() }).strict(),
  z.object({ method: z.literal("forward"), tabId: z.string().optional() }).strict(),
  z.object({ method: z.literal("reload"), tabId: z.string().optional() }).strict(),
  z
    .object({
      // [权衡] maxElements 为正整数可选，缺省上限由 executor 决定，这里不写死数值。
      // includeHidden 缺省为不包含，隐藏元素只影响可交互候选集，不影响截图。
      // 快照 ref 的编码规则在 executor，schema 只保证快照命令本身没有额外字段。
      // 不要把 maxElements 改成必填，agent 的探索式调用完全依赖这个缺省值。
      method: z.literal("snapshot"),
      maxElements: z.number().int().positive().optional(),
      includeHidden: z.boolean().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      // [契约] ref 走快照句柄定位，x 与 y 走视觉坐标定位，至少给一组是执行端约定而非 schema 约束。
      // ref 与坐标同时给出时以 ref 为准，schema 不做互斥，因为快照刷新后坐标只是兜底。
      // modifiers 复用键盘修饰键枚举，双击用 doubleClick 开关，而不是把 click 连发两次。
      // button 缺省 left；录制侧的 click 与这里字段同名但属于两套协议，改动要分开看。
      // 缺一个坐标字段时执行端会走 ref 分支失败，schema 不补默认坐标，避免静默点错位置。
      method: z.literal("click"),
      // ref（快照句柄）与坐标 (x,y) 二选一：ref 走 dom_cua 式定位，(x,y) 走 cua 视觉坐标定位。
      ref: z.string().min(1).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      button: browserMouseButtonSchema.optional(),
      doubleClick: z.boolean().optional(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("fill"),
      ref: z.string().min(1),
      value: z.string(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("type"),
      ref: z.string().min(1).optional(),
      text: z.string(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("press"),
      key: z.string().min(1),
      ref: z.string().min(1).optional(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // CUA 组合键输入：keys 是一个组合键，必须保留逐键 down/up 顺序，不能压成末键 + bitmask。
  z
    .object({
      // [契约] keys 是一个组合键序列，必须保留逐键 down 与 up 的顺序。
      // 不能压成末键加修饰键位掩码，否则 Ctrl、Shift、A 这类三键组合会漏键。
      // 数组最小长度 1 只挡空数组，组合合法性由 executor 判断，schema 不做键名白名单。
      // 与 press 的区别：press 面向元素 ref，cuaKeypress 面向当前焦点，不要合并两者。
      method: z.literal("cuaKeypress"),
      keys: z.array(z.string().min(1)).min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("scroll"),
      ref: z.string().min(1).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // CUA 滚动输入：视口锚点与滚动 delta 是两组不同坐标，且可携带 modifier。
  z
    .object({
      method: z.literal("cuaScroll"),
      x: z.number(),
      y: z.number(),
      scrollX: z.number(),
      scrollY: z.number(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // DOM CUA 滚动输入：nodeId 缺省时从视口中心滚动；存在时从该节点中心滚动。
  z
    .object({
      method: z.literal("domCuaScroll"),
      nodeId: z.string().min(1).optional(),
      scrollX: z.number(),
      scrollY: z.number(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      // [契约] clip 是 CDP 截图的 CSS px 区域，width 与 height 必须为正数，strict 拒多余字段。
      // clip 与 fullPage 互斥，schema 不表达互斥是历史兼容，执行端按 fullPage 优先处理。
      // ref 与 clip 同时给出时按 ref 裁切元素区域，clip 被忽略，调用方应只给一种。
      // 若把 clip 的 width 改成 nonnegative，零宽截图会产出无法解码的图片。
      // 整页截图的内存峰值在 executor 控制，schema 不设尺寸上限，避免挡掉长页面。
      method: z.literal("screenshot"),
      ref: z.string().min(1).optional(),
      fullPage: z.boolean().optional(),
      // 区域截图：CDP Page.captureScreenshot 的 clip（视口 CSS px）。与 fullPage 互斥。
      clip: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number().positive(),
          height: z.number().positive(),
        })
        .strict()
        .optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("getState"), tabId: z.string().optional() }).strict(),
  // hover：移动鼠标到元素(ref)或坐标(x,y)，触发 hover 态（cua move / dom_cua 定位后 move）。
  z
    .object({
      method: z.literal("hover"),
      ref: z.string().min(1).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // select：对 <select> 选择一个或多个 option（按 value 或可见文本匹配）。
  z
    .object({
      method: z.literal("select"),
      ref: z.string().min(1),
      values: z.array(z.string()).min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  // check：设置 checkbox/radio 勾选态（checked 缺省为 true）。
  z
    .object({
      method: z.literal("check"),
      ref: z.string().min(1),
      checked: z.boolean().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // drag：从 起点(fromRef 或 from{x,y}) 拖到 终点(toRef 或 to{x,y})，走 CDP Input 合成鼠标拖拽。
  z
    .object({
      method: z.literal("drag"),
      fromRef: z.string().min(1).optional(),
      toRef: z.string().min(1).optional(),
      from: browserPointSchema.optional(),
      to: browserPointSchema.optional(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // CUA drag 输入：完整 path 是公共合同，backend 必须逐点发送而不是只取首尾。
  z
    .object({
      method: z.literal("cuaDrag"),
      path: z.array(browserPointSchema).min(1),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // elementInfo：给视口坐标 (x,y)，反查该点命中元素的信息（role/name/rect/selector），打通视觉↔结构。
  z
    .object({
      method: z.literal("elementInfo"),
      x: z.number(),
      y: z.number(),
      tabId: z.string().optional(),
    })
    .strict(),
  // evaluate：在页面作用域执行 JS 表达式，返回可 JSON 序列化的结果。
  z
    .object({
      // [失败路径] expression 只要求非空，返回结果由 executor 序列化，schema 不约束结果形状。
      // 不可序列化的返回值会变成 undefined 而不是抛错，调用方需要自己判空。
      // 这里不限制表达式长度与作用域，权限面由调用方的命令授权决定。
      // 加 timeoutMs 字段会与 playwright 的 evaluate 重复，两条路径应保持字段独立。
      method: z.literal("evaluate"),
      expression: z.string().min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  // getDialog：读取当前 JS 弹窗（alert/confirm/prompt/beforeunload）信息，无则返回 dialog=null。
  z.object({ method: z.literal("getDialog"), tabId: z.string().optional() }).strict(),
  // handleDialog：接受/取消当前 JS 弹窗；prompt 可带 promptText。
  z
    .object({
      method: z.literal("handleDialog"),
      accept: z.boolean(),
      promptText: z.string().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      // [契约] selector、text、textGone 三个条件都可选，至少给一个是执行端校验的约定。
      // timeoutMs 为正整数可选，缺省等待上限由 executor 给，不要在 schema 写死。
      // 三个条件同时给出时按与关系等待，顺序不影响结果，但会放大超时。
      // textGone 与 text 的互斥语义由执行端处理，schema 不做互斥，便于组合重试。
      method: z.literal("waitFor"),
      selector: z.string().min(1).optional(),
      text: z.string().min(1).optional(),
      textGone: z.string().min(1).optional(),
      timeoutMs: z.number().int().positive().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // PlaywrightAPI.waitForTimeout：固定等待只接受非负整数，0 表示让出一次 timer tick。
  z
    .object({
      // [权衡] 这里的 timeoutMs 是 nonnegative，0 表示让出一次 timer 事件循环。
      // 与 playwright 子动作的超时不同：那个拒绝 0，因为它表达条件等待。
      // 收紧成 positive 会让轮询脚本里 wait 0 的写法直接校验失败。
      // 不设上限是故意的，长等待由调用方与取消机制约束，schema 不背这个语义。
      method: z.literal("playwrightWaitForTimeout"),
      timeoutMs: z.number().int().nonnegative(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      // [契约] action 直接复用 browserPlaywrightActionSchema，避免在命令层再展开一层判别。
      // tabId 在命令层，action 内部不带 tab，保证一个命令只作用一个受控 view。
      // playwright 是窄口，只有确实需要 Playwright 语义时才走这里，普通动作走顶层 method。
      // 新增 action 分支不会改变本命令形状，但会改变 capabilities 的返回值。
      method: z.literal("playwright"),
      action: browserPlaywrightActionSchema,
      tabId: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("capabilities"), tabId: z.string().optional() }).strict(),
  z.object({ method: z.literal("browserVisibilityGet") }).strict(),
  z.object({ method: z.literal("browserVisibilitySet"), visible: z.boolean() }).strict(),
  browserViewportInputSchema
    .extend({
      method: z.literal("browserViewportSet"),
      tabId: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("browserViewportReset"), tabId: z.string().optional() }).strict(),
  z
    .object({
      method: z.literal("recordingStart"),
      options: browserRecordingOptionsSchema.optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      // [资源] 录制状态查询必须带 recordingId，trim 后非空，避免空串命中全部录制。
      // outputPath 可选，表示落盘到工作区相对路径，形状校验与录制启动共用同一 schema。
      // [事务] 查询不改录制生命周期，取消与落盘分别由 recordingCancel 与状态终态驱动。
      // [资源] 同一 tab 同时只允许一个录制，重复启动由 manager 拒绝而不是 schema 拒绝。
      // schema 不返回录制进度，进度在 result 里，避免协议层绑定具体帧数。
      method: z.literal("recordingStatus"),
      recordingId: z.string().trim().min(1),
      outputPath: browserRecordingOutputPathSchema.optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("recordingCancel"),
      recordingId: z.string().trim().min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  // tabs.get(id) 的 backend 激活步骤：校验并更新该 scope selected tab；renderer 决定前台展示或后台记录。
  z.object({ method: z.literal("activateTab"), tabId: z.string().min(1) }).strict(),
  z.object({ method: z.literal("newTab") }).strict(),
  z.object({ method: z.literal("listUserTabs") }).strict(),
  z.object({ method: z.literal("claimTab"), tabId: z.string().min(1) }).strict(),
  z
    .object({
      // [事务] keep 是原子提交的保留清单，每项含 tabId 与 status，status 只能是 handoff 或 deliverable。
      // finalizeTabs 只表达意图，真正的 tab 释放与 webview 卸载由 manager 逐项执行。
      // 未出现在 keep 里的受控 tab 会被关闭，schema 不做非空校验，允许一次全部关闭。
      // status 用字面量枚举而不是布尔，便于后续扩展第三种终态而不破坏旧调用。
      method: z.literal("finalizeTabs"),
      keep: z.array(
        z.object({ tabId: z.string().min(1), status: z.enum(["handoff", "deliverable"]) }).strict(),
      ),
    })
    .strict(),
  z.object({ method: z.literal("markDeliverable"), tabId: z.string().min(1) }).strict(),
  z.object({ method: z.literal("markHandoff"), tabId: z.string().min(1) }).strict(),
  z.object({ method: z.literal("nameSession"), name: z.string().trim().min(1) }).strict(),
  z
    .object({
      method: z.literal("finalize"),
      tabId: z.string().optional(),
      deliverable: z.boolean().optional(),
    })
    .strict(),
  z.object({ method: z.literal("turnEnded"), turnId: z.string().min(1).optional() }).strict(),
  // closeTabs：连同该 session 名下的 tab 一起关（含已释放回该 session 的）。只给永不回来认领的
  // session 用——dwf 子代理（docs/browser-use/2026-07-14-browser-tab-conversation-isolation-spec.md §2.3）。
  // [失败路径] closeTabs 只给永不回来认领的 session 用，例如 dwf 子代理结束后收尾。
  // 普通会话不要传 true，否则会把已释放回该 session 的 tab 一起关掉。
  // 这个命令没有 tabId，作用域是整段 session，不针对单个受控 view。
  // 缺省等价于不关 tab，保持与旧版 close 语义兼容。
  z.object({ method: z.literal("closeSession"), closeTabs: z.boolean().optional() }).strict(),
  z.object({ method: z.literal("cancelRequest"), requestId: z.string().min(1) }).strict(),
  // close：关闭指定受控 tab（tabId 缺省=当前 tab）。manager 层处理：detach + 通知 renderer 卸载 webview。
  z.object({ method: z.literal("close"), tabId: z.string().optional() }).strict(),
  // list：枚举当前会话窗口下所有受控 tab 摘要。manager 层拦截处理，返回 result.tabs。
  // [契约] list 由 manager 层拦截，返回 result 里的 tabs 摘要，不进入 executor。
  // 因此它没有 tabId 也没有参数，schema 保持空对象以拒绝多余字段。
  // 摘要字段是只读投影，不要在命令里加过滤参数，过滤留给调用方在本地做。
  // capabilities 与 list 都属于元命令，一个答能力集，一个答当前受控 tab 集合。
  z.object({ method: z.literal("list") }).strict(),
]);
export type BrowserCommand = z.infer<typeof browserCommandSchema>;
