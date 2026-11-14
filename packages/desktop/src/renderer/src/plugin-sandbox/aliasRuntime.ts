// INV-01 别名运行时只做官方 App 的薄封装，不自行实现协议与错误码；守住位置：整个工厂函数体；改错故障：出现第二套 JSON-RPC，握手状态与宿主判断分叉。
// INV-02 握手必须推迟到任一成员首次被访问时；守住位置：lazy 代理的 get 分支；改错故障：插件页加载即握手，与自建 App 的页面抢同一条通道。
// INV-03 同一次运行内握手只发起一次；守住位置：ready 中 connectPromise 的复用；改错故障：每读一次属性就重复初始化，宿主侧出现重复会话。
// INV-04 握手失败只记录一次且不自动重试；守住位置：ready 的失败回调；改错故障：属性访问触发重试风暴，控制台被同一条错误刷满。
// INV-05 页面已自建官方 App 时别名必须永久让位；守住位置：foreignApp 与 markForeignApp 分支；改错故障：两条 App 共用 postMessage，请求 id 相撞、宿主收到两次 initialized。
// INV-06 让位状态一经设置不可撤销；守住位置：markForeignApp 中的 connectPromise 判空；改错故障：已建立的别名会话被中途作废，页面成员突然全部不可用。
// INV-07 工具输入缺失时归为空对象而非空值；守住位置：ontoolinput 的默认值分支；改错故障：页面判空后误判工具未调用，渲染出空态。
// INV-08 工具结果与元数据必须分字段保存；守住位置：ontoolresult 的两个赋值；改错故障：元数据混进结果，页面把宿主内部字段当业务数据展示。
// INV-09 所有状态变更都要触发一次通知；守住位置：三处事件赋值与 setWidgetState 中的 notify；改错故障：订阅方收不到更新，界面停在旧内容。
// INV-10 widgetState 的宿主初值只播种一次；守住位置：widgetStateSeeded 标志；改错故障：宿主上下文变更反复覆盖页面已写入的状态。
// INV-11 widgetState 先落本地再上报宿主；守住位置：setWidgetState 的赋值顺序；改错故障：乐观读取拿到旧值，两端状态长期不一致。
// INV-12 所有远程调用都必须经过 whenReady；守住位置：每个成员方法外层的包装；改错故障：未握手就发请求，宿主返回未知方法错误。
// INV-13 宿主派生字段在未握手时一律返回空值而非抛错；守住位置：theme、locale、displayMode 等 getter；改错故障：页面初始化读取字段即崩，白屏。
// INV-14 高度上报需兼容 height 与 maxHeight 两个分支；守住位置：containerDimensions 的取值链；改错故障：页面高度被判为零，内容被裁切。
// INV-15 协议版本只在宿主版本可得时返回；守住位置：protocolVersion getter 的条件；改错故障：过早读到版本号，按错误协议构造请求。
// INV-16 订阅接口返回退订函数且退订幂等；守住位置：onResourceUpdated、onResourceListChanged 与 subscribe；改错故障：卸载后回调仍在跑，写入已销毁节点。
// INV-17 单向动作的失败必须就地吞掉；守住位置：openExternal 与 notifyIntrinsicHeight 的兜底；改错故障：一次链接失败产生未处理拒绝，污染插件页控制台。
// INV-18 别名对象对外冻结且只暴露白名单成员；守住位置：lazy 中 Object.freeze 的包裹；改错故障：页面改写方法即可劫持后续调用，形成沙箱逃逸面。
// 上述不变量串起一条单向链路：懒握手 → 事件回填 → 成员读写 → 通知广播。
// 改动前先确认破坏的是哪一条；不得用延时或重试掩盖顺序问题。
//
import type {
  CallToolResult,
  Implementation,
  ListResourceTemplatesResult,
  ListResourcesResult,
  ReadResourceResult,
  RequestOptions,
  Transport,
// [权衡] 传输、请求选项与结果类型只以类型身份引入
// 换成值导入会把客户端运行时打进 iframe 沙箱包
// 类型面收窄后，上游升级需要跟随的改动也更少
} from "@modelcontextprotocol/client";
import { EmptyResultSchema, ListResourceTemplatesResultSchema } from "@modelcontextprotocol/core";
import type {
  McpUiDisplayMode,
  McpUiHostCapabilities,
  McpUiHostContext,
  McpUiToolCancelledNotification,
  McpUiToolInputNotification,
  McpUiToolResultNotification,
} from "@modelcontextprotocol/ext-apps";
import type { McpAppsDownloadFileItem } from "@zcode/shared/mcp-apps";
import {
  MCP_APPS_SET_WIDGET_STATE_METHOD,
  MCP_APPS_WIDGET_STATE_CONTEXT_KEY,
} from "@zcode/shared/mcp-apps";
import type { OpenAiCompatApi, ZcodeAliasApi } from "./aliasApi.js";
// [资源] 兼容层复用同一份别名对象，不另建连接与状态
// 否则页面同时使用两个全局时会各自握手，宿主看到两条会话
// 通知时现取快照，不在兼容层缓存旧副本
import { createOpenAiCompatApi, readOpenAiGlobals } from "./openaiAlias.js";

/**
 * 插件 iframe 内 `window.zcode` / `window.openai` 别名的运行时：官方 ext-apps `App` 上的薄封装，协议、握手、
 * 错误码全部来自 SDK，自己不持有 JSON-RPC。纯逻辑（消息经注入的 App 收发），alias.ts 负责接 DOM。
 *
 * 懒连接：别名脚本注入到每个插件页面，而用官方 SDK 自建 `App` 的页面（官方示例）不会碰 `window.zcode`；
 * 首次访问任一成员才握手，避免同一页面对宿主发两次 ui/initialize。
 */
// [权衡] 以结构化接口描述官方 App，运行时因此不依赖具体类
// 成员按实际调用逐条声明，多声明一条就多一处跟随上游的负担
// 接口即最小能力面，扩它就是给插件放开新的宿主能力
export interface AliasAppLike {
  connect(transport?: Transport, options?: RequestOptions): Promise<void>;
  getHostVersion(): Implementation | undefined;
  getHostCapabilities(): McpUiHostCapabilities | undefined;
  getHostContext(): McpUiHostContext | undefined;
  ontoolinput: ((params: McpUiToolInputNotification["params"]) => void) | undefined;
  ontoolresult: ((params: McpUiToolResultNotification["params"]) => void) | undefined;
  ontoolcancelled: ((params: McpUiToolCancelledNotification["params"]) => void) | undefined;
  onhostcontextchanged: ((params: McpUiHostContext) => void) | undefined;
  callServerTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<CallToolResult>;
  readServerResource(params: { uri: string }): Promise<ReadResourceResult>;
  listServerResources(params?: { cursor?: string }): Promise<ListResourcesResult>;
  /** 规范方法（resources/templates/list、resources/subscribe…）与 ZCode 扩展方法走基类 request。 */
  request(
    request: { method: string; params?: Record<string, unknown> },
    resultSchema: unknown,
  ): Promise<unknown>;
  setNotificationHandler(
    method: "notifications/resources/updated" | "notifications/resources/list_changed",
    handler: (notification: { params?: { uri?: string } }) => void,
  ): void;
  openLink(params: { url: string }): Promise<unknown>;
  requestDisplayMode(params: { mode: McpUiDisplayMode }): Promise<{ mode: McpUiDisplayMode }>;
  sendSizeChanged(params: { width?: number; height?: number }): Promise<void>;
  sendMessage(params: {
    role: "user";
    content: Array<Record<string, unknown>>;
    structuredContent?: Record<string, unknown>;
  }): Promise<unknown>;
  updateModelContext(params: {
    content?: Array<Record<string, unknown>>;
    structuredContent?: Record<string, unknown>;
  }): Promise<unknown>;
  downloadFile(params: { contents: McpAppsDownloadFileItem[] }): Promise<{ isError?: boolean }>;
}

// 事件名是跨进程契约，改名必须同步宿主侧监听
// [并发] 事件只示意有更新，不携带快照，订阅方自行读取最新值
// 不要在载荷里放可变对象，避免两端交叉修改同一引用
export const ZCODE_GLOBALS_EVENT = "zcode:globals";

export interface PluginSandboxAliasRuntime {
  zcode: ZcodeAliasApi;
  openai: OpenAiCompatApi;
  /** 是否已经（或正在）握手；诊断用。 */
  readonly connecting: boolean;
  /**
   * 页面自建的官方 `App` 已在与宿主通信（别名尚未握手前就看到宿主发来的 JSON-RPC）：别名放弃握手。
   * 同一页面两个 `App` 共用一条 postMessage 通道会撞请求 id（都从 0 起）并让宿主收到两次 initialized。
   */
  markForeignApp(): void;
}

// 全部可变状态收敛在工厂闭包里，返回对象之外没有写入口
// 状态只有一个所有者，排查时不必跨模块追查写入点
// 注入的 app 与 transport 由调用方保证唯一，运行时不重复校验
export function createPluginSandboxAliasRuntime(options: {
  app: AliasAppLike;
  /** 官方 App 的 connect 缺省用 window.parent 的 PostMessageTransport；这里注入以便控制目标窗口。 */
  transport?: Transport;
  protocolVersion: string;
  onChange?: (globals: Record<string, unknown>) => void;
}): PluginSandboxAliasRuntime {
  const { app } = options;
  let toolInput: Record<string, unknown> | null = null;
  let toolOutput: unknown = null;
  let toolResponseMetadata: Record<string, unknown> | null = null;
  // [事务] 工具生命周期的几份状态各自独立保存，互不覆盖
  // 取消事件只记录原因，不清理已到达的输入与结果
  // 清空责任留给下一次工具事件，避免出现中间空窗
  let toolCancelled: { reason?: string } | null = null;
  let widgetState: unknown = null;
  let widgetStateSeeded = false;
  let connectPromise: Promise<void> | null = null;
  let foreignApp = false;
  const listeners = new Set<() => void>();
  const resourceUpdatedListeners = new Set<(uri: string) => void>();
  const resourceListChangedListeners = new Set<() => void>();

  // 通知分两路：本地订阅者与宿主侧变更回调
  // [并发] 遍历按插入顺序同步执行，回调内不应再触发写入
  // 单个回调抛错会中断后续订阅者，异常需由回调自担
  const notify = () => {
    for (const listener of listeners) listener();
    options.onChange?.(readOpenAiGlobals(openai));
  };

  // [失败路径] 入参可能为空，这里归一成空对象供页面直接读取
  // 处理器在构造期同步挂上，握手完成前到达的通知也不会漏
  // 赋值后立即通知，保证页面读到的输入与事件次序一致
  app.ontoolinput = (params) => {
    toolInput = params.arguments ?? {};
    notify();
  };
  app.ontoolresult = (params) => {
    toolOutput = params.structuredContent ?? null;
    toolResponseMetadata = (params._meta as Record<string, unknown> | undefined) ?? null;
    notify();
  };
  app.ontoolcancelled = (params) => {
    toolCancelled = params.reason ? { reason: params.reason } : {};
    notify();
  };
  app.onhostcontextchanged = () => notify();
  app.setNotificationHandler("notifications/resources/updated", (notification) => {
    const uri = notification.params?.uri;
    if (typeof uri !== "string") return;
    for (const listener of resourceUpdatedListeners) listener(uri);
  });
  app.setNotificationHandler("notifications/resources/list_changed", () => {
    for (const listener of resourceListChangedListeners) listener();
  });

  /** 失败只记录一次，后续访问不重试（与页面自建 App 的失败语义一致）。 */
  const ready = (): Promise<void> => {
    // [失败路径] 页面自建 App 已占用通道时，别名一律拒绝并给出可读原因
    // 判定还要求本次尚未握手，已建立的会话不会被中途推翻
    // 错误文案直接指向改用自建 App，减少无效排查
    // 返回拒绝而非静默成功，避免调用方一直等不到结果
    if (foreignApp && !connectPromise) {
      return Promise.reject(
        new Error(
          "window.zcode is unavailable: this page already connected its own MCP Apps App; use it directly",
        ),
      );
    }
    if (!connectPromise) {
      connectPromise = app.connect(options.transport).then(
        () => {
          // widgetState 初值随握手经 hostContext 扩展键下发（宿主只在创建桥时带一次）。
          // 宿主只在桥创建时带一次初始状态，因此播种只做一次
          // 后续上下文变更不再覆盖，页面写入的值始终优先
          // [权衡] 播种与写入共用同一变量，靠标志位区分首次，去掉就会回填旧值
          if (!widgetStateSeeded) {
            widgetStateSeeded = true;
            const seeded = (app.getHostContext() as Record<string, unknown> | undefined)?.[
              MCP_APPS_WIDGET_STATE_CONTEXT_KEY
            ];
            if (seeded !== undefined) widgetState = seeded;
          }
          notify();
        },
        (error) => {
          // [失败路径] 失败只在此处记录一次，随后把错误继续抛给调用方
          // 不重置已创建的握手承诺，后续访问直接复用同一个拒绝
          // 失败语义因此稳定：要么成功一次，要么一直失败
          console.warn("[plugin-sandbox-alias] connect failed", error);
          throw error;
        },
      );
    }
    return connectPromise;
  };
  const whenReady = <T>(run: () => Promise<T>): Promise<T> => ready().then(run);

  const hostContext = () => app.getHostContext() ?? null;
  const zcodeTarget: ZcodeAliasApi = {
    get toolInput() {
      return toolInput;
    },
    get toolOutput() {
      return toolOutput;
    },
    get toolResponseMetadata() {
      return toolResponseMetadata;
    },
    get toolCancelled() {
      return toolCancelled;
    },
    get theme() {
      return hostContext()?.theme ?? null;
    },
    get locale() {
      return hostContext()?.locale ?? null;
    },
    get displayMode() {
      return hostContext()?.displayMode ?? null;
    },
    get maxHeight() {
      // SDK 把 containerDimensions 建成 height|maxHeight 的联合，两个分支都可能带值，按对象读。
      // [权衡] 上游把尺寸建成 height 与 maxHeight 的联合，按对象读取
      // 取不到最大高度时回退到高度，两者都缺才返回空值
      // 只认单一分支会让高度上报缺失，页面内容被裁切
      const dimensions = hostContext()?.containerDimensions as
        | { height?: number; maxHeight?: number }
        | undefined;
      return dimensions?.maxHeight ?? dimensions?.height ?? null;
    },
    get safeArea() {
      return hostContext()?.safeAreaInsets ?? null;
    },
    get userAgent() {
      return hostContext()?.userAgent ?? null;
    },
    get hostInfo() {
      return app.getHostVersion() ?? null;
    },
    get hostCapabilities() {
      return app.getHostCapabilities() ?? null;
    },
    get hostContext() {
      return hostContext();
    },
    get protocolVersion() {
      return app.getHostVersion() ? options.protocolVersion : null;
    },
    // 参数为空时不下发 arguments 字段，保持与宿主约定一致
    // 调用前统一过就绪包装，握手与请求串行
    // [失败路径] 宿主拒绝调用时错误原样上抛，交页面自行处理
    callTool: (name, args) =>
      whenReady(() => app.callServerTool({ name, ...(args ? { arguments: args } : {}) })),
    readResource: (uri) => whenReady(() => app.readServerResource({ uri })),
    listResources: (input) =>
      whenReady(() => app.listServerResources(input?.cursor ? { cursor: input.cursor } : {})),
    listResourceTemplates: (input) =>
      whenReady(
        () =>
          app.request(
            {
              method: "resources/templates/list",
              params: input?.cursor ? { cursor: input.cursor } : {},
            },
            ListResourceTemplatesResultSchema,
          ) as Promise<ListResourceTemplatesResult>,
      ),
    subscribeResource: (uri) =>
      whenReady(() =>
        app.request({ method: "resources/subscribe", params: { uri } }, EmptyResultSchema),
      ).then(() => undefined),
    unsubscribeResource: (uri) =>
      whenReady(() =>
        app.request({ method: "resources/unsubscribe", params: { uri } }, EmptyResultSchema),
      ).then(() => undefined),
    onResourceUpdated(listener) {
      resourceUpdatedListeners.add(listener);
      return () => resourceUpdatedListeners.delete(listener);
    },
    onResourceListChanged(listener) {
      resourceListChangedListeners.add(listener);
      return () => resourceListChangedListeners.delete(listener);
    },
    requestDisplayMode: (input) => whenReady(() => app.requestDisplayMode(input)),
    openExternal(input) {
      void whenReady(() => app.openLink({ url: input.href })).catch(() => undefined);
    },
    downloadFile: (contents) => whenReady(() => app.downloadFile({ contents })),
    notifyIntrinsicHeight(height) {
      void whenReady(() => app.sendSizeChanged({ height })).catch(() => undefined);
    },
    get widgetState() {
      return widgetState;
    },
    // [事务] 先写本地并通知，再发上报请求，读取方立刻看到新值
    // 上报失败不回滚本地状态，页面仍按最新值渲染
    // 若先发请求再写本地，页面会在往返窗口里读到旧值
    setWidgetState(state) {
      widgetState = state;
      notify();
      return whenReady(() =>
        app.request(
          { method: MCP_APPS_SET_WIDGET_STATE_METHOD, params: { widgetState: state } },
          EmptyResultSchema,
        ),
      ).then(() => undefined);
    },
    sendFollowUpMessage: (input) =>
      whenReady(() =>
        app.sendMessage({
          role: "user",
          content: [{ type: "text", text: input.prompt }],
          ...(input.structuredContent ? { structuredContent: input.structuredContent } : {}),
        }),
      ).then(() => undefined),
    updateModelContext: (input) =>
      whenReady(() =>
        app.updateModelContext({
          ...(input.content ? { content: input.content } : {}),
          ...(input.structuredContent ? { structuredContent: input.structuredContent } : {}),
        }),
      ).then(() => undefined),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ready,
  };
  // 任一成员首次被访问即触发握手（读 toolInput 也算：页面通常先读再等事件）。
  // 第一次访问任意成员就静默发起握手，失败留给显式调用暴露
  // [并发] 握手由就绪包装去重，多个成员同时被读也只连一次
  // 对象先冻结再包代理，插件页无法改写成员实现
  // 这是别名层的主要防逃逸手段：能力面固定且不可替换
  const lazy = <T extends object>(target: T): T =>
    new Proxy(Object.freeze(target), {
      get(object, key, receiver) {
        if (typeof key === "string") void ready().catch(() => undefined);
        return Reflect.get(object, key, receiver);
      },
    });
  const zcode = lazy(zcodeTarget);
  const openai = lazy(createOpenAiCompatApi(zcodeTarget));

  return {
    zcode,
    openai,
    get connecting() {
      return connectPromise !== null;
    },
    // [事务] `markForeignApp()` 只在 `connectPromise` 为空时置位，已建立的会话不受影响。
    // `foreignApp` 置位后握手入口直接拒绝，不做任何补救重连。
    // `foreignApp` 是单向标记：调用方不得把它当临时开关复位。
    markForeignApp() {
      if (!connectPromise) foreignApp = true;
    },
  };
}
