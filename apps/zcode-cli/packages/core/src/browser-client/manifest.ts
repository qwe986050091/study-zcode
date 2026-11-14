/* eslint-disable max-lines -- public API manifest、动态裁剪策略和 Proxy 合同集中维护，拆分会增加对象图漂移风险。 */
// ==========================================================================
// manifest.ts —— 浏览器 API manifest、能力策略与 Proxy 门面的唯一事实源
//
// 做：声明 Agent/Browser/Tab 等对象的成员、签名、command 归属与后端能力约束。
// 做：加载期解析 documentationRoot/api.json，缺失或非法时回退 FALLBACK_MANIFEST。
// 做：按 BrowserBackendDescriptor 计算成员可见性，并在 Proxy 的 get/has/枚举层隐藏。
// 不做：不执行任何浏览器动作，不建立 CDP/插件连接，不缓存页面或 tab 状态。
// 不做：不校验 signature 在运行时是否可调用；签名只服务文档、代理与类型对齐。
// 依赖：@zcode/contracts/browser-control 的 BrowserBackendDescriptor / BackendType。
// 依赖：documentationRoot/api.json；与插件 docs/api.json 成对维护，必须同步。
// 边界：本文件、manifest 形状与 Proxy 合同同生共死；拆分会静默改变 hideUnknown 语义。
// 边界：descriptor 可热更新，但 members 索引在构造时冻结，禁止增量改写对象图。
// 权衡：宁可让 FALLBACK 成为保守子集，也不在加载失败时放开全部成员——缺文档即降能力。
//
// 阅读顺序：类型定义 → FALLBACK_MANIFEST → loadBrowserApiManifest → BrowserApiPolicy → Proxy。
// 维护提示：changed manifest 必须同时跑插件 docs 侧一致性检查，否则错误只在运行时暴露。
// INV 不变量（格式：断言 / 守住它的位置 / 改错故障）
// INV-01 断言：FALLBACK_MANIFEST 必须覆盖 Agent→Browsers→Browser→Tabs→Tab 五层入口 —— 守住它的位置：const FALLBACK_MANIFEST —— 改错故障：api.json 缺失时 agent.browsers.open 变 undefined。
// INV-02 断言：FALLBACK.version 必须与插件 api.json 的 version 同值 —— 守住它的位置：version: 10 —— 改错故障：两端对成员形状的判断永久分叉。
// INV-03 断言：isManifest 只校验 version 与 objects —— 守住它的位置：function isManifest —— 改错故障：members 写错类型要到 supportedMembers 才炸，错误位置误导排查。
// INV-04 断言：loadBrowserApiManifest 永不抛错 —— 守住它的位置：function loadBrowserApiManifest —— 改错故障：文档目录损坏会让整个 agent 启动失败。
// INV-05 断言：api.json 解析失败必须回退而不是返回空对象 —— 守住它的位置：catch 分支 —— 改错故障：所有成员一夜之间不可见且无日志。
// INV-06 断言：supports() 对未声明成员返回 true —— 守住它的位置：BrowserApiPolicy.supports —— 改错故障：改成 false 后 manifest 漏项变成静默能力消失。
// INV-07 断言：apiSupportOverrides 必须最后裁决 —— 守住它的位置：supports() 的 return —— 改错故障：提前返回会让灰度与 adapter 修正整体失效。
// INV-08 断言：declarations 用 some 而非 every —— 守住它的位置：supports() 的重载分支 —— 改错故障：一个重载不可用就隐藏全部重载入口。
// INV-09 断言：BrowserApiPolicy 构造后 members 不可增量改写 —— 守住它的位置：constructor 的填充循环 —— 改错故障：descriptor 热更新时出现半新半旧成员表。
// INV-10 断言：updateDescriptor 先赋值 descriptor 再重建能力集合 —— 守住它的位置：updateDescriptor —— 改错故障：并发读到新旧混合能力，可见性抖动。
// INV-11 断言：能力集合用 clear() 复用同一 Set —— 守住它的位置：updateDescriptor —— 改错故障：外部持有旧集合引用的判读永久过期。
// INV-12 断言：先判 unsupportedByDefaultIn 再判 requiresCapabilities —— 守住它的位置：supportsRequirement 首行 —— 改错故障：顺序颠倒后能力缺失掩盖后端禁用。
// INV-13 断言：无 scope 的 capability id 必须回退到双集合命中 —— 守住它的位置：supportsRequirement 末行 —— 改错故障：旧 manifest 全部失配，成员凭空消失。
// INV-14 断言：scope 分隔符必须取首个冒号 —— 守住它的位置：capability.indexOf(":") —— 改错故障：带冒号的 id 解析错位，scope 判定错误。
// INV-15 断言：Proxy 必须同时拦截 get/has/getOwnPropertyDescriptor/ownKeys —— 守住它的位置：handler 四个 trap —— 改错故障：只改 get 会让 in 与 Object.keys 泄露隐藏成员。
// INV-16 断言：ownKeys 的过滤条件必须与 getOwnPropertyDescriptor 一致 —— 守住它的位置：ownKeys —— 改错故障：不一致会触发 Proxy invariant TypeError。
// INV-17 断言：隐藏只针对 string 键 —— 守住它的位置：isHidden 首行 —— 改错故障：隐藏 symbol 键会切断内部符号通道。
// INV-18 断言：strict facade 下方法必须 bind(current) —— 守住它的位置：handler.get 的返回值 —— 改错故障：热更新后拿到旧 this，改动不生效。
// INV-19 断言：隐藏成员的 get 返回 undefined 而不是抛错 —— 守住它的位置：handler.get —— 改错故障：探测式访问变成 NotImplemented 抛错。
// INV-20 断言：objectName 必须与 manifest.objects 的 key 完全一致 —— 守住它的位置：createBrowserApiProxy 入参 —— 改错故障：Proxy 查表失败，全部成员按未知处理。
// ==========================================================================
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BrowserBackendDescriptor,
  BrowserBackendType,
} from "@zcode/contracts/browser-control";

// [契约] kind 只有 method/property 两值，代理层只按它决定是否需要 bind；
// method 成员在 strict facade 下会被 value.bind(current) 包裹；
// 把 property 写成 method，getter 返回的函数会被绑到旧对象，热更新后读不到新实现；
// 新增第三类（如 event）必须同步改 createBrowserApiProxy，否则落到不绑定的默认分支；
// 不要把 kind 当纯展示字段删掉：它是 Proxy 行为分支的唯一输入。
export type BrowserApiMemberKind = "method" | "property";

// [契约] 字段全部可选是刻意的：插件 api.json 历史版本缺 command/documented 时仍要能加载；
// signature 只用于文档展示与命令路由，不参与运行时校验，改它不会让调用失败；
// declarations 是重载声明：存在时 supports() 走 some()，任一重载可用即整体可用；
// unsupportedByDefaultIn 描述默认不可用，最终由 apiSupportOverrides 做最后裁决；
// 新增字段必须可选，否则旧 manifest 通过类型断言后运行时缺值。
export interface BrowserApiManifestMember {
  name: string;
  kind: BrowserApiMemberKind;
  signature: string;
  command?: string;
  documented?: boolean;
  unsupportedByDefaultIn?: BrowserBackendType[];
  requiresCapabilities?: string[];
  declarations?: Array<{
    signature: string;
    documented?: boolean;
    unsupportedByDefaultIn?: BrowserBackendType[];
    requiresCapabilities?: string[];
  }>;
}

// [契约] members 是数组而非字典：顺序就是文档与 supportedMembers() 的输出顺序；
// 去重靠 BrowserApiPolicy 构造时的 Map 覆盖实现，同对象内重名会让后者静默胜出；
// 不要在 members 里塞非成员元数据（如 description），Proxy 会把它当成可读属性；
// objects 的 key 必须与 Proxy 的 objectName 完全一致，改了 key 等于换命名空间；
// 此接口不承载能力过滤结果，过滤是 BrowserApiPolicy 的运行时职责。
export interface BrowserApiManifestObject {
  members: BrowserApiManifestMember[];
}

// [契约] version 是 manifest 形状的版本号（当前 10），不是插件版本，改它需同步插件；
// types/semantics 只是文档字符串，不进 Proxy，删掉不会影响可见性判断；
// objects 允许稀疏：缺失的对象在 supportedMembers 里按空数组合并，不报错；
// isManifest 只校验 version+objects，因此新增的必填字段都会绕过运行期校验；
// 把 types 当运行时类型源会静默失效——这里只有字符串。
export interface BrowserApiManifest {
  version: number;
  entrypoints?: string[];
  semantics?: Record<string, string>;
  types?: Record<string, string>;
  objects: Record<string, BrowserApiManifestObject>;
}

// [失败路径] 内置 manifest 是 api.json 缺失或损坏时的唯一兜底，必须自洽可运行；
// [权衡] FALLBACK_MANIFEST 刻意是保守子集：无文档时宁可少暴露成员，也不放开 api.json 里的全部能力。
// FALLBACK 与 api.json 不同步会表现成某环境成员凭空消失，改动需两侧对齐；
// 不要改成从 api.json 生成：加载失败时无法再生成，会直接得到空对象；
// 此常量必须保持纯数据，不能引用 descriptor 或任何运行时状态。
const FALLBACK_MANIFEST: BrowserApiManifest = {
  // [契约] FALLBACK 的 version 必须与插件侧 manifest 同版本，否则两端形状漂移；
  // version 变化意味着 Proxy 合同可能一并变化，升级时要重看 isManifest 的校验字段；
  // 它不参与能力计算，写错不会报错，只会让两端对支持什么产生分歧；
  // 修改该数字前先确认 browser adapter 侧的能力集合是否同步；
  // 不要把 version 改造成 feature flag——能力判断只看 descriptor 与成员表。
  version: 10,
  types: {
    BrowserViewportSize: "{ width: number; height: number }",
    TabInfo:
      "{ id: string; active?: boolean; title?: string; url?: string; viewport: BrowserViewportSize }",
  },
  objects: {
    // [契约] 根 Agent 对象只暴露 browsers/documentation，多余入口会让提示面失控；
    // 这两个成员是插件 docs 的稳定入口，删除等于破坏 agent.browsers 的发现链；
    // members 顺序决定文档顺序，把 documentation 提前会改变示例展示顺序；
    // 不要在 Agent 上加执行类方法：动作必须收敛到 Browser/Tab 对象上；
    // 新增根对象时同步更新代理创建处的 objectName 常量。
    Agent: {
      members: [
        { name: "browsers", kind: "property", signature: "browsers: Browsers" },
        { name: "documentation", kind: "property", signature: "documentation: Documentation" },
      ],
    },
    Documentation: {
      members: [{ name: "get", kind: "method", signature: "get(name: string): Promise<string>" }],
    },
    // [契约] list/get/getDefault/getForUrl 由 map 生成，签名是占位，仅供类型展示；
    // open() 必须显式声明：它不在 map 里，漏掉会被 hideUnknown 代理判为未知并隐藏；
    // open 的同站复用 + 激活 + 原地跳转属于行为合同，不能只改这里的签名；
    // finalize 这类破坏性回收不要放这里，它属于 Tab 级能力；
    // 数组展开顺序即文档顺序，不要为了排版重排生成数组。
    Browsers: {
      members: [
        ...["list", "get", "getDefault", "getForUrl"].map((name) => ({
          name,
          kind: "method" as const,
          signature: `${name}(...)`,
        })),
        // open() 是默认导航入口（同站复用 + 激活 + 原地跳转）；不声明会被 hideUnknown
        // 代理隐藏，REPL 里 agent.browsers.open 变 undefined（与插件 docs/api.json 同步维护）。
        {
          name: "open",
          kind: "method" as const,
          signature: "open(url?: string, options?: { reuseTab?: boolean }): Promise<Tab>",
        },
      ],
    },
    // [契约] Browser 是 tab 容器，只暴露 browserId/capabilities/documentation/tabs/user；
    // capabilities 是集合对象而非布尔，调用方要经 CapabilityCollection.get/list 判定；
    // 把 tabs 从 property 改成 method 会打断 agent.browsers.tabs.new 的既有调用点；
    // user 承载 claimTab/history/openTabs，权限更敏感，不能上提到 Browser；
    // 这里声明的成员全部受 hideUnknown 保护，缺一个在 strict facade 下就是 undefined。
    Browser: {
      members: [
        { name: "browserId", kind: "property", signature: "browserId: string" },
        {
          name: "capabilities",
          kind: "property",
          signature: "capabilities: BrowserCapabilityCollection",
        },
        {
          name: "documentation",
          kind: "method",
          signature: "documentation(): Promise<string>",
        },
        { name: "tabs", kind: "property", signature: "tabs: Tabs" },
        { name: "user", kind: "property", signature: "user: BrowserUser" },
      ],
    },
    // [契约] claimTab/history 在 iab、cdp 后端默认不可用，靠 unsupportedByDefaultIn 表达；
    // openTabs 无后端限制，因为它是只读列举，不涉及抢占用户会话；
    // 删掉 claimTab 的 iab 限制会静默放开对用户真实浏览器的接管，属安全回归；
    // history 只保留 iab 限制：cdp 后端已能安全读取历史，改前需对照 adapter 实现；
    // signature 里的参数名要与 adapter 形参一致，否则空调试时容易误判。
    BrowserUser: {
      members: [
        {
          name: "claimTab",
          kind: "method",
          signature: "claimTab(tab): Promise<Tab>",
          unsupportedByDefaultIn: ["iab", "cdp"],
        },
        {
          name: "history",
          kind: "method",
          signature: "history(options): Promise<BrowserHistoryEntry[]>",
          unsupportedByDefaultIn: ["iab"],
        },
        {
          name: "openTabs",
          kind: "method",
          signature: "openTabs(): Promise<BrowserUserTabInfo[]>",
        },
      ],
    },
    // [契约] get/new/selected 由 map 生成；list/finalize 手写，因为签名与后端限制不同；
    // new 会创建真实 guest，属于有副作用的入口，文档上不能当只读；
    // finalize 在 iab/cdp 默认关闭：它是破坏性回收，误开会让用户丢失标签；
    // 顺序固定为 get/new/selected → list → finalize，重排会改变 API 文档分组；
    // 不要把 finalize 与 Tab.finalize 合并：作用域不同，合并会误回收整组。
    Tabs: {
      members: [
        ...["get", "new", "selected"].map((name) => ({
          name,
          kind: "method" as const,
          signature: `${name}(...)`,
        })),
        {
          name: "list",
          kind: "method" as const,
          signature: "list(): Promise<TabInfo[]>",
        },
        {
          name: "finalize",
          kind: "method" as const,
          signature: "finalize(options): Promise<void>",
          unsupportedByDefaultIn: ["iab", "cdp"] as BrowserBackendType[],
        },
      ],
    },
    // [契约] Tab 是最大成员表：属性（id/capabilities/cua/dom_cua/playwright/recording）与
    // 动作（back/close/forward/goto/reload/screenshot）混排，代理只按 kind 区分；
    // back/close/forward/goto/screenshot 由 map 生成，新增必须同时改这里与 adapter；
    // markDeliverable/markHandoff 仅在非 iab/cdp 可用，去掉限制会让后端收到未知 command；
    // setViewportSize 绑定 command browserViewportSet，改 command 名等于切断执行链。
    Tab: {
      members: [
        { name: "id", kind: "property", signature: "id: string" },
        {
          name: "capabilities",
          kind: "property",
          signature: "capabilities: TabCapabilityCollection",
        },
        ...[
          "back",
          "close",
          "forward",
          "getJsDialog",
          "goto",
          "reload",
          "screenshot",
          "title",
          "url",
        ].map((name) => ({ name, kind: "method" as const, signature: `${name}(...)` })),
        {
          name: "finalize",
          kind: "method",
          signature: "finalize(options?): Promise<void>",
          unsupportedByDefaultIn: ["iab", "cdp"],
        },
        ...["markDeliverable", "markHandoff"].map((name) => ({
          name,
          kind: "method" as const,
          signature: `${name}(): Promise<void>`,
          unsupportedByDefaultIn: ["iab", "cdp"] as BrowserBackendType[],
        })),
        { name: "cua", kind: "property", signature: "cua: CUAAPI" },
        { name: "dom_cua", kind: "property", signature: "dom_cua: DomCUAAPI" },
        {
          name: "playwright",
          kind: "property",
          signature: "playwright: PlaywrightAPI",
        },
        {
          name: "recording",
          kind: "property",
          signature: "recording: BrowserRecordingAPI",
        },
        {
          name: "setViewportSize",
          kind: "method",
          signature:
            "setViewportSize(viewportSize: { width: number; height: number }): Promise<void>",
          command: "browserViewportSet",
        },
        {
          name: "viewportSize",
          kind: "method",
          signature: "viewportSize(): { width: number; height: number } | null",
        },
      ],
    },
    // [契约] 录制三件套 start/status/cancel 全部依赖 recording 系 command，缺一即不可执行；
    // 它们在 extension 与 cdp 后端默认不可用：录制需主进程托管，后端能力不同；
    // status/cancel 必须一起保留，只留 start 会让录制任务无法回收，形成资源泄漏；
    // 不要把 recording 成员上提到 Tab 顶级：代理按对象.成员查表，上提即失配；
    // documented 默认 true，新增内部命令时显式写 false，避免污染对外文档。
    BrowserRecordingAPI: {
      members: [
        {
          name: "start",
          kind: "method",
          signature: "start(options?): Promise<BrowserRecordingJob>",
          command: "recordingStart",
          unsupportedByDefaultIn: ["extension", "cdp"],
        },
        {
          name: "status",
          kind: "method",
          signature: "status(recordingId, options?): Promise<BrowserRecordingJob>",
          command: "recordingStatus",
          unsupportedByDefaultIn: ["extension", "cdp"],
        },
        {
          name: "cancel",
          kind: "method",
          signature: "cancel(recordingId): Promise<BrowserRecordingJob>",
          command: "recordingCancel",
          unsupportedByDefaultIn: ["extension", "cdp"],
        },
      ],
    },
    BrowserCapabilityCollection: {
      members: ["get", "list"].map((name) => ({
        name,
        kind: "method" as const,
        signature: `${name}(...)`,
      })),
    },
    TabCapabilityCollection: {
      members: ["get", "list"].map((name) => ({
        name,
        kind: "method" as const,
        signature: `${name}(...)`,
      })),
    },
    // [契约] 这里分两类：需要 command 的 evaluate/expectNavigation 等，以及纯本地构造的
    // locator/getBy 系列——后者无 command，返回链式对象由 renderer 侧继续分发；
    // domSnapshot/elementInfo/elementScreenshot 共用 command playwright，
    // 所以元素级截图必须靠 options 区分，改 command 名会让三者一起失效；
    // documented:false 的成员仍可调用，只是不进文档，不要当成未实现删掉。
    PlaywrightAPI: {
      members: [
        {
          name: "domSnapshot",
          kind: "method",
          signature: "domSnapshot(): Promise<string>",
          command: "playwright",
        },
        {
          name: "elementInfo",
          kind: "method",
          signature: "elementInfo(options: ElementInfoOptions): Promise<ElementInfo[]>",
          command: "playwright",
          documented: false,
        },
        {
          name: "elementScreenshot",
          kind: "method",
          signature: "elementScreenshot(options: ElementScreenshotOptions): Promise<Uint8Array>",
          command: "playwright",
          documented: false,
        },
        {
          name: "evaluate",
          kind: "method",
          signature: "evaluate(pageFunction, arg?, options?): Promise<TResult>",
          command: "playwright",
        },
        {
          name: "expectNavigation",
          kind: "method",
          signature: "expectNavigation(action, options?): Promise<T>",
          command: "playwright",
        },
        {
          name: "frameLocator",
          kind: "method",
          signature: "frameLocator(selector: string): PlaywrightFrameLocator",
        },
        {
          name: "getByLabel",
          kind: "method",
          signature: "getByLabel(text, options?): PlaywrightLocator",
        },
        {
          name: "getByPlaceholder",
          kind: "method",
          signature: "getByPlaceholder(text, options?): PlaywrightLocator",
        },
        {
          name: "getByRole",
          kind: "method",
          signature: "getByRole(role, options?): PlaywrightLocator",
        },
        {
          name: "getByTestId",
          kind: "method",
          signature: "getByTestId(testId: string): PlaywrightLocator",
        },
        {
          name: "getByText",
          kind: "method",
          signature: "getByText(text, options?): PlaywrightLocator",
        },
        {
          name: "locator",
          kind: "method",
          signature: "locator(selector: string): PlaywrightLocator",
        },
        {
          name: "waitForEvent",
          kind: "method",
          signature: "waitForEvent(event, options?): Promise<PlaywrightDownload>",
          command: "playwright",
          declarations: [
            {
              signature: 'waitForEvent(event: "download", options?): Promise<PlaywrightDownload>',
            },
            {
              signature:
                'waitForEvent(event: "filechooser", options?): Promise<PlaywrightFileChooser>',
              unsupportedByDefaultIn: ["iab"],
            },
          ],
        },
        {
          name: "waitForLoadState",
          kind: "method",
          signature: "waitForLoadState(options?): Promise<void>",
          command: "playwright",
        },
        {
          name: "waitForTimeout",
          kind: "method",
          signature: "waitForTimeout(timeoutMs: number): Promise<void>",
          command: "playwrightWaitForTimeout",
        },
        {
          name: "waitForURL",
          kind: "method",
          signature: "waitForURL(url: string, options?): Promise<void>",
          command: "playwright",
        },
      ],
    },
    // [契约] FrameLocator 与 Locator 方法集刻意不同：它不能 click/fill 到 frame 元素本身；
    // map 生成的签名固定返回 PlaywrightLocator，不能随手改成 this 类型；
    // frameLocator 递归返回自身类型，删掉它会让 iframe 内链式定位断在第一层；
    // getBy 系列必须在两个对象上都存在，缺失会退化为手写选择器字符串；
    // 不要用 spread 复用 Locator 的成员表：两者的 command 归属并不相同。
    PlaywrightFrameLocator: {
      members: [
        "frameLocator",
        "getByLabel",
        "getByPlaceholder",
        "getByRole",
        "getByTestId",
        "getByText",
        "locator",
      ].map((name) => ({
        name,
        kind: "method" as const,
        signature: `${name}(...): PlaywrightLocator`,
      })),
    },
    // [契约] command 白名单刻意用 includes 反选：纯本地方法无 command，其余默认 playwright；
    // 把白名单改成黑名单会让新增方法默认无 command，执行时静默变成空操作；
    // all/and/filter/first/last/nth/or 组合器不进服务端，保持在渲染侧链接；
    // downloadMedia 走 playwright：它是真实副作用，必须经主进程；
    // 成员按字母序排列，重排只会增加文档 diff 噪音，不改变语义。
    PlaywrightLocator: {
      members: [
        "all",
        "allTextContents",
        "and",
        "check",
        "click",
        "count",
        "dblclick",
        "downloadMedia",
        "evaluate",
        "fill",
        "filter",
        "first",
        "getAttribute",
        "getByLabel",
        "getByPlaceholder",
        "getByRole",
        "getByTestId",
        "getByText",
        "innerText",
        "isEnabled",
        "isVisible",
        "last",
        "locator",
        "nth",
        "or",
        "press",
        "selectOption",
        "setChecked",
        "textContent",
        "type",
        "uncheck",
        "waitFor",
      ].map((name) => ({
        name,
        kind: "method" as const,
        signature: `${name}(...)`,
        command: [
          "all",
          "and",
          "filter",
          "first",
          "getByLabel",
          "getByPlaceholder",
          "getByRole",
          "getByTestId",
          "getByText",
          "last",
          "locator",
          "nth",
          "or",
        ].includes(name)
          ? undefined
          : "playwright",
      })),
    },
    PlaywrightDownload: {
      members: [
        {
          name: "path",
          kind: "method",
          signature: "path(options?): Promise<string | null>",
          command: "playwright",
          documented: false,
        },
      ],
    },
    PlaywrightFileChooser: {
      members: [
        { name: "isMultiple", kind: "method", signature: "isMultiple(): boolean" },
        {
          name: "setFiles",
          kind: "method",
          signature: "setFiles(files, options?): Promise<void>",
          command: "playwright",
          unsupportedByDefaultIn: ["iab"],
        },
      ],
    },
    // [契约] CUA 方法名用下划线（double_click/get_visible_dom），与 DomCUAAPI 保持一致；
    // 这是外部协议命名，改成驼峰会静默失效——调用方按字符串名反射；
    // downloadMedia 在 iab 默认不可用且 documented:false，属内部能力，不对外承诺；
    // CUA 走坐标与键位而非选择器，不要在这里混入 locator 风格成员；
    // 新增 CUA 动作要同时在 DomCUAAPI 与 adapter 落地，缺一处即分叉。
    CUAAPI: {
      members: [
        ...["click", "double_click", "drag", "keypress", "move", "scroll", "type"].map((name) => ({
          name,
          kind: "method" as const,
          signature: `${name}(...)`,
        })),
        {
          name: "downloadMedia",
          kind: "method",
          signature: "downloadMedia(options): Promise<void>",
          unsupportedByDefaultIn: ["iab"] as BrowserBackendType[],
          documented: false,
        },
      ],
    },
    // [契约] DomCUAAPI 是 CUA 的 DOM 变体，成员集刻意少 drag/move，不要补齐成一样；
    // get_visible_dom 是它的关键差异：允许 agent 读可见 DOM 后再做坐标决策；
    // downloadMedia 限制与 CUAAPI 相同，不一致会让同一动作在后端间表现不同；
    // map 展开写法决定成员顺序，插入位置即文档位置；
    // 不要合并 CUAAPI 与 DomCUAAPI：命名空间不同，合并会让 Proxy 表键冲突。
    DomCUAAPI: {
      members: [
        ...["click", "double_click", "get_visible_dom", "keypress", "scroll", "type"].map(
          (name) => ({ name, kind: "method" as const, signature: `${name}(...)` }),
        ),
        {
          name: "downloadMedia",
          kind: "method",
          signature: "downloadMedia(options): Promise<void>",
          unsupportedByDefaultIn: ["iab"] as BrowserBackendType[],
          documented: false,
        },
      ],
    },
  },
};

// [契约] 这里是唯一的运行期形状校验，但它只认 version 是 number、objects 是 object；
// 因此 api.json 里 members 写错类型不会被拦下，要等到 supportedMembers 才炸；
// 放宽校验前先确认消费方都是容错读取（?? []），否则会把损坏 manifest 当真；
// 不要加缺字段补默认值的修正分支：那会让 manifest 漂移难以发现；
// 类型谓词必须与消费方式一致，改成 boolean 会丢类型收窄。
function isManifest(value: unknown): value is BrowserApiManifest {
  if (!value || typeof value !== "object") return false;
  const record = value as { version?: unknown; objects?: unknown };
  return (
    typeof record.version === "number" &&
    Boolean(record.objects && typeof record.objects === "object")
  );
}

// [失败路径] 无 documentationRoot 直接回退，不抛错：CLI 可能没有插件文档目录；
// 先 existsSync 再 readFileSync，避免把 ENOENT 混进 JSON 解析失败分支；
// catch 吞掉解析错误是刻意的：manifest 损坏不能让整个 agent 启动失败；
// 代价是坏 manifest 只会静默降级，排查时只能对比成员可见性；
// 返回的是解析对象本体，调用方不得就地修改，否则会污染后续 policy 构造。
export function loadBrowserApiManifest(documentationRoot?: string): BrowserApiManifest {
  if (!documentationRoot) return FALLBACK_MANIFEST;
  const path = join(documentationRoot, "api.json");
  if (!existsSync(path)) return FALLBACK_MANIFEST;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isManifest(parsed) ? parsed : FALLBACK_MANIFEST;
  } catch {
    return FALLBACK_MANIFEST;
  }
}

function capabilityIds(
  descriptor: BrowserBackendDescriptor,
  scope: "browser" | "tab",
): Set<string> {
  return new Set((descriptor.capabilities[scope] ?? []).map((capability) => capability.id));
}

// [并发] 每个连接一个 policy 实例；members Map 在构造时一次性建成，之后只读；
// browserCapabilities/tabCapabilities 是可变集合，updateDescriptor 时清空重建；
// 不要把 members 也做成可增量更新：成员表来自 manifest，热改会出现半新半旧；
// descriptor 是可变私有字段，supports() 每次读最新值——这是灰度改判的唯一通道；
// policy 不持有连接或 IPC 句柄，可在测试里直接构造。
export class BrowserApiPolicy {
  private readonly members = new Map<string, BrowserApiManifestMember>();
  private readonly browserCapabilities: Set<string>;
  private readonly tabCapabilities: Set<string>;

  constructor(
    readonly manifest: BrowserApiManifest,
    private descriptor: BrowserBackendDescriptor,
  ) {
    this.browserCapabilities = capabilityIds(descriptor, "browser");
    this.tabCapabilities = capabilityIds(descriptor, "tab");
    for (const [objectName, object] of Object.entries(manifest.objects)) {
      for (const member of object.members ?? []) {
        this.members.set(`${objectName}.${member.name}`, member);
      }
    }
  }

  isKnown(objectName: string, memberName: string): boolean {
    return this.members.has(`${objectName}.${memberName}`);
  }

  // [契约] 未声明成员默认返回 true：manifest 没声明的不由本层否决，交给 hideUnknown；
  // 若改成默认 false，任何 manifest 缺项都会让成员凭空消失且没有日志；
  // declarations 存在时用 some：任一重载满足即整体可用，不要改成 every；
  // apiSupportOverrides 必须在能力计算之后读，顺序颠倒会被默认值覆盖；
  // 返回值只表示可用，不表示已实现——实现缺失仍会在调用时抛。
  supports(objectName: string, memberName: string): boolean {
    const key = `${objectName}.${memberName}`;
    const member = this.members.get(key);
    if (!member) return true;
    let supported = this.supportsRequirement(member);
    if (supported && member.declarations?.length) {
      supported = member.declarations.some((declaration) => this.supportsRequirement(declaration));
    }
    // connection 级 override 是最后裁决；用于灰度或 adapter 的精确能力修正。
    return this.descriptor.apiSupportOverrides?.[key] ?? supported;
  }

  // [契约] 输出是成员的浅拷贝，但 declarations 被过滤成仅剩可用的重载；
  // 必须保留 command/documented 等字段，否则下游命令路由会丢 command；
  // 过滤必须复用同一个 supports()，另写一套能力判断会让两处慢慢分叉；
  // 未知对象返回空数组而非抛错：manifest 允许稀疏声明；
  // 调用方不得改返回的 declarations 数组，成员对象仍是共享引用。
  supportedMembers(objectName: string): BrowserApiManifestMember[] {
    return (this.manifest.objects[objectName]?.members ?? [])
      .filter((member) => this.supports(objectName, member.name))
      .map((member) => ({
        ...member,
        ...(member.declarations
          ? {
              declarations: member.declarations.filter((declaration) =>
                this.supportsRequirement(declaration),
              ),
            }
          : {}),
      }));
  }

  // [并发] 先赋值 descriptor 再重建能力集合：中间态被并发读到会拿到新旧混合结果；
  // 因此调用方须在同一 tick 内完成替换，不要在 await 之间调用 supports()；
  // 用 clear() 而不是重新 new Set：保持引用稳定，避免外部持有旧集合；
  // 不重建 members 是刻意设计——后端切换不改变 manifest 形状；
  // 该方法无返回值也不抛错：能力缺失由 supports() 体现，不做启动期断言。
  updateDescriptor(descriptor: BrowserBackendDescriptor): void {
    this.descriptor = descriptor;
    this.browserCapabilities.clear();
    this.tabCapabilities.clear();
    for (const id of capabilityIds(descriptor, "browser")) this.browserCapabilities.add(id);
    for (const id of capabilityIds(descriptor, "tab")) this.tabCapabilities.add(id);
  }

  // [契约] 判定顺序固定：先 unsupportedByDefaultIn（后端类型），再 requiresCapabilities；
  // capability 允许 browser:id / tab:id 的 scope 前缀，分隔符必须取首个冒号；
  // 无 scope 的旧式 id 回退到两个集合任一命中，删掉该分支会让老 manifest 全部失配；
  // some() 的语义是缺任一能力即不支持，因此回调返回 true 表示缺失；
  // 只读 descriptor 的类型与能力两个维度，不要在这里引入第三种判据。
  private supportsRequirement(requirement: {
    unsupportedByDefaultIn?: BrowserBackendType[];
    requiresCapabilities?: string[];
  }): boolean {
    if ((requirement.unsupportedByDefaultIn ?? []).includes(this.descriptor.type)) return false;
    return !requirement.requiresCapabilities?.some((capability) => {
      const separator = capability.indexOf(":");
      if (separator > 0) {
        const scope = capability.slice(0, separator);
        const id = capability.slice(separator + 1);
        if (scope === "browser") return !this.browserCapabilities.has(id);
        if (scope === "tab") return !this.tabCapabilities.has(id);
      }
      // 兼容旧 manifest 的无 scope capability id；新版应显式使用 browser:/tab:。
      return !this.browserCapabilities.has(capability) && !this.tabCapabilities.has(capability);
    });
  }
}

/** unsupported member 在读取和 `in` 检查时都不可见，而不是调用后才抛 NotImplemented。 */
// [契约] 代理同时拦截 get/has/getOwnPropertyDescriptor/ownKeys，四者必须一致；
// 只改 get 会让 in 与 Object.keys 泄露被隐藏成员，agent 据此误判能力；
// hideUnknown 为 true 时未知属性也隐藏，为 false 时放行（默认行为）；
// isHidden 只处理 string 键：symbol 键一律可见，这是刻意保留的内部通道；
// 不要在代理里做异步或副作用，它位于每次属性读取的热路径上。
export function createBrowserApiProxy<T extends object>(
  target: T,
  objectName: string,
  policy: BrowserApiPolicy,
  options: { hideUnknown?: boolean } = {},
): T {
  const isHidden = (property: PropertyKey) => {
    if (typeof property !== "string") return false;
    const known = policy.isKnown(objectName, property);
    return known ? !policy.supports(objectName, property) : options.hideUnknown === true;
  };
  // [契约] get 里对函数 bind(current) 只在 hideUnknown 模式生效，防止 strict facade
  // 暴露未绑定 this 的方法；非 strict 模式保留原函数以维持身份相等；
  // getOwnPropertyDescriptor 返回 undefined 使隐藏成员对属性枚举不可见；
  // ownKeys 必须同步过滤，否则上面的 undefined 会触发 Proxy invariant 报错；
  // 四个 trap 必须共用 isHidden，任何一处手写判断都会造成可见性分叉。
  const handler: ProxyHandler<object> = {
    get(current, property, receiver) {
      if (isHidden(property)) return undefined;
      const value = Reflect.get(current, property, receiver);
      // strict facade 隐藏内部 helper/field；公开 method 绑定原对象，避免 method 内部读取被 proxy 拦截。
      return options.hideUnknown && typeof value === "function" ? value.bind(current) : value;
    },
    has(current, property) {
      if (isHidden(property)) return false;
      return Reflect.has(current, property);
    },
    getOwnPropertyDescriptor(current, property) {
      if (isHidden(property)) return undefined;
      return Reflect.getOwnPropertyDescriptor(current, property);
    },
    ownKeys(current) {
      return Reflect.ownKeys(current).filter((property) => !isHidden(property));
    },
  };
  return new Proxy(target, handler) as T;
}
