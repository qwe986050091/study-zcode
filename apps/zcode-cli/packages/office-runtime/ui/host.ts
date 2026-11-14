// 宿主桥接层：建立 MCP Apps 连接、声明页面工具（capture_view），并集中转发宿主能力与窗口状态。
// 边界：单例在 window 上寄存，加载器与 UI bundle 共享同一条连接，禁止重复 connect。
// 失败语义：宿主未就绪时 ready() 会等待握手；工具处理异常由 oncalltool 统一转成 isError 文本。
import { readWindowState, writeWindowState, type WindowState } from "#ui/windowStorage.ts";
import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import { PLUGIN_VERSION, SERVER_NAME } from "#office/contract.ts";
import { CAPTURE_EXAMPLES, TITLE } from "#office/wording.ts";

// 下面三个类型从 MCP Apps 的 App 回调签名反推，只描述协议形状（线上传输结构），
// 不承载页面状态；宿主换版本时以 ext-apps 的类型为准。
type ListHandler = NonNullable<App["onlisttools"]>;
type CallHandler = NonNullable<App["oncalltool"]>;
type ListToolsResult = Awaited<ReturnType<ListHandler>>;
// 宿主工具定义：直接取 MCP Apps onlisttools 的条目类型，随 ext-apps 升级自动同步。
// 只做类型别名，不约束字段；新增工具必须同时满足宿主 schema 与 PAGE_TOOLS 的静态声明。
export type ToolDefinition = ListToolsResult["tools"][number];
// 工具调用结果：取 oncalltool 的返回类型，含 content 与 isError；UI 侧只读不改。
export type CallToolResult = Awaited<ReturnType<CallHandler>>;

// 页面工具处理器口径：args 来自模型，类型是 unknown（已由 inputSchema 校验但不再细分）；
// signal 是宿主取消信号，可能为 undefined（不同宿主的 MCP 请求对象形状不一致；
// 抛出的异常由 oncalltool 统一转成 isError 文本，返回值原样回给模型。
export type PageToolHandler = (
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
) => Promise<CallToolResult>;

/**
 * Tools the page exposes to the model while it is open (MCP Apps app-provided tools). The
 * definitions are static so the host sees them at the handshake; the UI bundle binds handlers later.
 */
// 页面工具清单在握手时一次性声明，handler 在 UI bundle 加载后才绑定；清单必须与 registerTool 对应。
// 新增工具需同步 inputSchema、handler 与 i18n 文案，否则模型会看到无法执行的工具。
export const PAGE_TOOLS: ToolDefinition[] = [
  {
    // 工具名同时是 MCP 方法名和 handlers 表的键；改名必须同步改 useCaptureView 的注册。
    name: "capture_view",
    // 标题/描述是模型可见的提示词，调整措辞会直接影响模型是否发起截图。
    title: `Capture ${TITLE} view`,
    description: `Take a picture of a rendered document location in the ${TITLE} panel so you can see layout, charts, images and formatting that text extraction misses. Pass an anchor such as ${CAPTURE_EXAMPLES} (the document must be open in the panel; call open_document first), or omit it to capture what the user currently sees.`,
    inputSchema: {
      type: "object",
      properties: {
        // 锚点；空串等价于省略，此时截取当前可视区域。
        anchor: {
          type: "string",
          maxLength: 1200,
          description: "Location to capture; defaults to the visible view.",
        },
        // 像素宽度上限；使用侧再夹到 [320, 2000]，缺省 1600，见 useCaptureView。
        maxWidth: {
          type: "integer",
          minimum: 320,
          maximum: 2000,
          description: "Maximum image width in pixels (default 1600).",
        },
      },
      additionalProperties: false,
    },
    // 只读且幂等：重复截图不改文档与面板状态，宿主可安全重试。
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
];

// 宿主下发的工具结果（可能早于 UI 挂载到达），因此需要缓冲而不是直接消费。
type ToolResult = Parameters<NonNullable<App["ontoolresult"]>>[0];

/**
 * One App connection per page. The bootstrap loader creates it before the UI bundle exists, so it
 * keeps every tool result and the page tools are registered through a late-bound table.
 */
function createHost() {
  // 兜底 viewId：宿主没给 stateKey 时也要能标识本页，保证 release_view 有值可回传。
  const pageId = crypto.randomUUID();
  // 优先用宿主下发的 stateKey（同一页面多面板时用它区分），缺失才回落到随机 pageId。
  const currentViewId = () =>
    (
      app.getHostCapabilities()?.experimental?.["zcode/surface"] as
        | { stateKey?: string }
        | undefined
    )?.stateKey ?? pageId;
  const app = new App(
    { name: SERVER_NAME, version: PLUGIN_VERSION },
    { tools: { listChanged: true }, availableDisplayModes: ["inline", "fullscreen"] },
    { autoResize: false },
  );
  // results 是环形缓冲：最多留 20 条，超出丢最旧的，避免 UI 长时间未挂载时无界增长。
  // handlers + waiters 构成晚绑定工具表：UI 未注册时调用方等待，注册后 handleTool 唤醒等待者。
  // connection 缓存 connect 的 Promise，保证严格模式重复渲染或并发 ready() 只连接一次。
  const results: ToolResult[] = [];
  const handlers = new Map<string, PageToolHandler>();
  const waiters = new Set<() => void>();
  let connection: Promise<void> | undefined;
  // 所有宿主事件都走 window 事件总线，UI 只监听事件名，不直接读取宿主内部状态。
  const emit = (name: string) => void window.dispatchEvent(new Event(`office:${name}`));

  // Handlers are installed before connect so nothing sent during the handshake is lost.
  app.ontoolresult = (result) => {
    results.push(result);
    // 只保留最近 20 条：更早的结果已无消费者，丢弃最旧的即可。
    if (results.length > 20) results.shift();
    emit("toolresult");
  };
  app.onhostcontextchanged = () => emit("hostchange");
  app.onlisttools = async (): Promise<ListToolsResult> => ({ tools: PAGE_TOOLS });
  app.oncalltool = async (params, extra) => {
    if (!PAGE_TOOLS.some((tool) => tool.name === params.name))
      return {
        isError: true,
        content: [{ type: "text", text: `The ${TITLE} page has no tool ${params.name}.` }],
      };
    try {
      // The UI bundle may still be loading when the first call arrives.
      // 最多等 20s（500ms 轮询），超时后返回明确错误而不是让模型永久挂起。
      const deadline = Date.now() + 20_000;
      while (!handlers.has(params.name) && Date.now() < deadline)
        await new Promise<void>((resolve) => {
          const done = () => (waiters.delete(done), resolve());
          waiters.add(done);
          setTimeout(done, 500);
        });
      const handler = handlers.get(params.name);
      if (!handler) throw new Error(`The ${TITLE} panel is still loading; try again in a moment.`);
      // 取消信号来源不统一：优先 MCP 请求上的 signal，兼容宿主直接挂在 extra 上的 signal。
      const scoped = extra as { mcpReq?: { signal?: AbortSignal }; signal?: AbortSignal };
      return await handler(params.arguments ?? {}, scoped.mcpReq?.signal ?? scoped.signal);
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      };
    }
  };

  // 页面销毁时释放宿主侧视图占位；失败无关紧要（页面已在卸载），故吞掉异常。
  window.addEventListener("pagehide", () => {
    void app
      .callServerTool({ name: "release_view", arguments: { viewId: currentViewId() } })
      .catch(() => undefined);
  });

  // 幂等连接：并发调用共享同一个 Promise；连接成功后广播一次 hostchange，
  // 让 UI 重新读取 capabilities/hostContext（连接前它们可能为空）。
  const ready = () =>
    (connection ??= app
      .connect(new PostMessageTransport(window.parent, window.parent))
      .then(() => emit("hostchange")));

  return {
    app,
    // 视图标识：供 report_view / release_view 使用，随宿主 stateKey 变化，勿缓存。
    get viewId() {
      return currentViewId();
    },
    ready,
    // 读取本窗口保存的界面状态；没有 stateKey、存储不可用或数据损坏时一律返回空对象 {}，
    // 调用方据此回落到全新窗口语义（不抛错，因为这只是恢复性数据）。
    readWindow(): WindowState {
      const surface = app.getHostCapabilities()?.experimental?.["zcode/surface"] as
        | { stateKey?: string }
        | undefined;
      if (!surface?.stateKey) return {};
      try {
        return readWindowState(localStorage, surface.stateKey);
      } catch {
        return {};
      }
    },
    // 合并写入窗口状态（只覆盖 patch 中的键）；无 stateKey 时静默跳过，
    // 持久化失败只影响下次恢复，不影响当前预览。
    saveWindow(patch: WindowState): void {
      const surface = app.getHostCapabilities()?.experimental?.["zcode/surface"] as
        | { stateKey?: string }
        | undefined;
      if (!surface?.stateKey) return;
      try {
        writeWindowState(localStorage, surface.stateKey, patch);
      } catch {
        /* 存储不可用仍可预览。 */
      }
    },
    // 上次在本窗口打开的文档路径；null 表示新窗口（调用方应显示空态而不是报错）。
    readDocument(): string | null {
      return this.readWindow().path ?? null;
    },
    // 记录当前文档路径，供下次挂载时恢复；与 recent 列表独立（recent 是历史，这是当前）。
    saveDocument(path: string): void {
      this.saveWindow({ path });
    },
    /** Tool results received so far (oldest first); the UI drains them on mount. */
    takeResults: () => results.splice(0, results.length),
    // 绑定页面工具实现：后注册覆盖先注册（同名工具以最后一次为准），
    // 并唤醒所有正在轮询等待该工具的 oncalltool 调用。
    handleTool(name: string, handler: PageToolHandler) {
      handlers.set(name, handler);
      for (const wake of waiters) wake();
    },
    // 宿主上下文（displayMode/theme/locale 等）；未连接时为 undefined，调用方需给默认值。
    get context() {
      return app.getHostContext();
    },
    // 宿主能力声明（message/openLink 等）；用于按能力降级 UI，不假设一定存在。
    get capabilities() {
      return app.getHostCapabilities();
    },
  };
}

// 宿主桥接对象的类型：由工厂函数返回值推导，调用方只依赖能力而不依赖内部字段。
// 同一页面内所有模块共享一个实例，重复 import 不会新建连接。
export type Host = ReturnType<typeof createHost>;

declare global {
  interface Window {
    __officeHost?: Host;
  }
}

// 进程内单例：加载器与 UI bundle 可能各自 import 本模块，但必须共享同一条 App 连接；
// 因此在 window 上寄存（见 declare global），而不是模块级变量。
// 获取（必要时创建）唯一宿主实例；创建是同步的，真正 connect 由 ready() 在首次调用时触发。
// 幂等：并发调用返回同一对象；宿主未注入时抛出可读错误，避免后续调用链静默失败。
/** The loader page and the UI bundle share this instance; never connect twice. */
export function getHost(): Host {
  return (window.__officeHost ??= createHost());
}
