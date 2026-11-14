// 插件 UI 宿主控制器：把 prepareSandbox、沙箱端口、AppBridge 握手与页面通知收敛成单一状态机。
// 只负责生命周期编排与时序守卫，不做权限裁决、不读页面内容、不持久化任何会话事实；
// 工具执行交给 appTools、采样交给 sampling、资源订阅交给 resources，全部经 deps 注入。
//
// INV-01 断言：phase 只能经 setPhase 推进，error 之后也不再回到 running —— 守住它的位置：setPhase 与 start 的 idle 守卫 —— 改错故障：页面被判定可用却已无沙箱，工具输入投给不存在的实例。
// INV-02 断言：disposed 置真后，任何握手、端口、回收回调都不得再写 phase 或建桥 —— 守住它的位置：fail、oninitialized、超时回调的首行判断 —— 改错故障：卸载后仍弹错误态，或新桥覆盖已置空的 bridge 导致端口泄漏。
// INV-03 断言：prepare 成功但期间已 dispose 时，必须显式关闭实例并释放沙箱 —— 守住它的位置：start 中两处 disposed 复查分支 —— 改错故障：Host 侧登记残留，沙箱进程无人回收，重开面板复用脏代际。
// INV-04 断言：validateInstance 失败也要先关闭实例、释放沙箱再抛错 —— 守住它的位置：start 的 validate 捕获块 —— 改错故障：失败实例永久占位，下一次挂载拿到不可用句柄。
// INV-05 断言：只接受 sandboxId 相同且 initId 不小于当前代际的端口 —— 守住它的位置：onPorts 回调的两道过滤 —— 改错故障：guest 重载后旧端口接上新桥，页面与宿主各说各话。
// INV-06 断言：装桥之前必须先订阅端口，两者顺序不可对调 —— 守住它的位置：onPorts 登记与 setPhase 的先后 —— 改错故障：guest dom-ready 早于订阅，端口事件丢失，界面永久空白。
// INV-07 断言：每个新端口都要重置采样、退订旧资源、注销旧工具登记 —— 守住它的位置：attachPort 开头的四步清理 —— 改错故障：旧代际订阅把通知投到新页面，页面工具被重复登记。
// INV-08 断言：同一桥只允许第一次 initialized 生效 —— 守住它的位置：initializedOnce 与 bridge 恒等判断 —— 改错故障：别名 App 二次握手重置状态，工具结果被重复投喂。
// INV-09 断言：握手计时器必须在 initialized 或 dispose 时清除 —— 守住它的位置：cancelHandshakeTimer 的三处赋值 —— 改错故障：迟到的超时把已运行页面打成 error。
// INV-10 断言：握手窗口内收到的宿主上下文更新不能丢弃，只能补发最新值 —— 守住它的位置：oninitialized 中的 baseContext 比较 —— 改错故障：主题或尺寸变更在首帧丢失，页面停在旧主题。
// INV-11 断言：widgetState 只在建桥时经扩展键下发一次 —— 守住它的位置：contextAtCreate 的构造 —— 改错故障：页面重挂载读到宿主默认值，表单状态回滚。
// INV-12 断言：notify 系列在未 attached 时静默丢弃，不排队 —— 守住它的位置：notifyToolInput、notifyToolResult、notifyToolCancelled 的首行 —— 改错故障：补发队列与 initialized 时读快照双写，页面收到过期输入。
// INV-13 断言：dispose 必须先把 bridge、transport、handle 从模块变量摘除再 await —— 守住它的位置：dispose 同步段的捕获与置空 —— 改错故障：等待期间新端口写入已释放对象，句柄串线。
// INV-14 断言：closeInstance 使用 dispose 开始时捕获的 instance 凭证 —— 守住它的位置：scope 在闭包创建时求值 —— 改错故障：回收后按新代际关闭，误杀刚挂载的实例。
// INV-15 断言：回收期间收到的实例关闭通知只挂起，不立即上报 —— 守住它的位置：recycling 与 closedDuringRecycle 的配对 —— 改错故障：回收失败后丢失关闭事实，面板停在僵尸态。
// INV-16 断言：资源通知按代际登记，换端口即注销 —— 守住它的位置：unregisterNotifications 与 register 的成对调用 —— 改错故障：旧代际通知路由到新页面，订阅者收到别人的资源更新。
// INV-17 断言：页面通知只在桥存在且已 attached 时转发 —— 守住它的位置：资源更新、清单变更、页面工具调用三个入口的守卫 —— 改错故障：未握手页面收到协议通知，SDK 抛协议错。
// INV-18 断言：activeCalls 由控制器统一持有并在 dispose 时清空 —— 守住它的位置：activeCalls 与 isBusy、dispose 的关系 —— 改错故障：卸载后忙态恒为真，新面板被判定为忙而拒绝挂载。
// INV-19 断言：dispose 必须等待 preparation 落地，避免释放与 prepare 并发 —— 守住它的位置：disposal 中的等待步骤 —— 改错故障：沙箱在 prepare 回包前被销毁，留下孤儿登记。
// INV-20 断言：拆卸由统一例程收口并带超时 —— 守住它的位置：disposal 的最后一步 —— 改错故障：页面不响应导致卸载永久挂起，应用退出被卡住。
//
// 阅读提示：先看 phase 与 disposed 两个变量，再看 attachPort 的清理顺序，最后看 dispose 的摘链顺序。
// 任何新增 await 点都要回答两个问题：期间 dispose 是否可能发生、句柄是否已被新端口替换。
// 所有副作用都经 deps 注入，测试用假桥与假计时器控制时序；新增外部依赖应继续走 deps，不要在文件内直接取全局单例。
import { createPluginUiSampling } from "./pluginUiSampling.js";
import type { CallToolResult, Transport } from "@modelcontextprotocol/client";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { PluginSandboxHandle, PluginSandboxTransportPort } from "@zcode/shared/mcp-apps";
import {
  MCP_APPS_HANDSHAKE_TIMEOUT_MS,
  MCP_APPS_HOST_NAME,
  MCP_APPS_WIDGET_STATE_CONTEXT_KEY,
  buildPluginSandboxScopeId,
} from "@zcode/shared/mcp-apps";
import { createPluginUiAppTools } from "./pluginUiAppTools.js";
import {
  installPluginUiHostAppHandlers,
  installPluginUiHostNotificationHandlers,
} from "./pluginUiHostAppHandlers.js";
import type { PluginUiHostBridge } from "./pluginUiHostBridge.js";
import type {
  PluginUiHostController,
  PluginUiHostControllerDeps,
  PluginUiHostPhase,
  PluginUiToolFeed,
} from "./pluginUiHostControllerContract.js";
import { runPluginUiHostTeardown } from "./pluginUiHostTeardown.js";
import { wirePluginUiInteractions } from "./pluginUiInteractionPorts.js";
import { createPluginUiResourceSubscriptions } from "./pluginUiResourceSubscriptions.js";

export type {
  PluginUiHostController,
  PluginUiHostControllerDeps,
  PluginUiHostPhase,
  PluginUiHostScope,
} from "./pluginUiHostControllerContract.js";
export function createPluginUiHostController(
  deps: PluginUiHostControllerDeps,
): PluginUiHostController {
  // [契约] phase 是外部可见的唯一状态源：调用方按准备、挂载、运行、销毁四段判断能否投喂。
  // 只允许 setPhase 写入；直接赋值会绕过 onPhase 回调，面板管理器收不到挂载或销毁通知。
  // error 不是终态：dispose 仍会把它推进到 disposed，因此错误分支不能假定已经清理完毕。
  // idle 是 start 的一次性闸门，重复调用必须原样返回，否则会并发准备同一个 scope。
  // [权衡] 没有单独的关闭中状态：卸载期间外部看到的仍是 disposed，真实进度靠返回的 promise 判断。
  let phase: PluginUiHostPhase = "idle";
  let handle: PluginSandboxHandle | null = null;
  let bridge: PluginUiHostBridge | null = null;
  let boundScope:
    | (ReturnType<typeof baseScope> & { instance: PluginSandboxHandle["instance"] })
    | null = null;
  let transport: Transport | null = null;
  let unsubscribePorts: (() => void) | null = null;
  let hostContext: McpUiHostContext = deps.initialHostContext;
  let disposed = false;
  // [并发] disposal 是幂等令牌：第二次 dispose 直接返回同一个 promise，不重复关闭实例。
  // preparation 保存 start 的在途流程，dispose 必须等它落地后再释放，否则 prepare 会在释放之后创建沙箱。
  // 两个变量都只在闭包内可见，不要提升为外部字段，避免调用方误判清理已完成。
  // [失败路径] preparation 内部已捕获所有异常并转为错误态，因此等待它不会抛错，也不会卡住卸载。
  // 若未来在 start 中新增 await，要点仍是每个回包后复查 disposed，而不是依赖这里的等待。
  let disposal: Promise<void> | null = null;
  let preparation: Promise<void> | null = null;
  let recycling = false;
  let closedDuringRecycle = false;
  // initialized 已到：可以直接 send*；之前的 notify* 不排队——initialized 时按 getToolFeed 读最新值。
  let attached = false;
  let cancelHandshakeTimer: (() => void) | null = null;
  // 进行中的页面工具调用 id，dispose 时逐个取消到 agent。
  const activeCalls = new Set<string>();
  let unregisterNotifications: (() => void) | null = null;
  const createCallId = deps.createCallId ?? (() => crypto.randomUUID());
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    });
  const createAppBridge =
    deps.createAppBridge ??
    ((hostInfo, hostCapabilities, initialContext) =>
      new AppBridge(null, hostInfo, hostCapabilities, {
        hostContext: initialContext,
      }) as unknown as PluginUiHostBridge);

  // [契约] 先写内部 phase 再回调 onPhase：回调里同步读控制器状态必须看到新值。
  // detail 只在准备与挂载时带句柄、错误态带 message，其余状态传空，调用方靠 phase 判别。
  // 不要在 setPhase 内做异步副作用；它是同步通知点，抛错会中断状态推进。
  // 重复上报同一 phase 目前不拦截，依赖调用点自身守卫，例如 start 的 idle 判断与 initializedOnce。
  // [权衡] 没有转换合法性校验，是为允许错误态到销毁态；新增转换前先确认外部消费者不会误判。
  const setPhase = (
    next: PluginUiHostPhase,
    detail?: { handle?: PluginSandboxHandle; error?: string },
  ) => {
    phase = next;
    deps.onPhase(next, detail);
  };
  // [失败路径] 失败统一收口到这里：记日志并置错误态，调用方不再各自上报。
  // disposed 之后直接返回，避免卸载尾声的迟到异常把状态从销毁拉回错误。
  // 非 Error 值统一字符串化，保证状态回调里的 error 字段始终是字符串。
  // 只记录 message 不记录堆栈，是沿用面板日志口径；排查时序问题靠 phase 与端口过滤日志。
  // fail 不负责释放沙箱，清理责任仍在 dispose；因此失败后必须由拥有者显式调用 dispose。
  const fail = (error: unknown) => {
    if (disposed) return;
    const message = error instanceof Error ? error.message : String(error);
    deps.log?.("[plugin-ui] host failed", { message });
    setPhase("error", { error: message });
  };

  /** 经桥的请求共用的归属范围：workspace + session + 本插件 server。 */
  const baseScope = () => ({
    workspacePath: deps.scope.workspacePath,
    ...(deps.scope.workspaceIdentity ? { workspaceIdentity: deps.scope.workspaceIdentity } : {}),
    sessionId: deps.scope.sessionId,
    pluginId: deps.presentation.pluginId,
    serverName: deps.presentation.serverName,
  });

  // [契约] 所有经桥的请求都必须带 instance，boundScope 是唯一来源，禁止调用点自行拼装。
  // 未准备完成时直接抛错，而不是返回空对象：缺 instance 的请求在 Host 侧会被判为陈旧代际。
  // boundScope 在准备成功后一次性定型，dispose 不清空它，是为了让迟到回调仍拿到原始凭证。
  // [权衡] 抛错会让页面看到调用失败而不是静默；这比返回默认 scope 更安全。
  // 新增依赖归属范围的通道时复用此函数，不要另建带插件标识的局部对象。
  const pluginScope = () => {
    if (!boundScope) throw new Error("MCP App is not prepared");
    return boundScope;
  };

  const sampling = deps.sampling
    ? createPluginUiSampling({
        bridge: deps.sampling,
        scope: pluginScope,
        canSample: () => Boolean(deps.getHostCapabilities().sampling),
        createCallId,
        activeCalls,
        onBusyChange: deps.onBusyChange,
      })
    : undefined;

  const resources = createPluginUiResourceSubscriptions({
    bridge: deps.bridge,
    pluginScope,
    scopeId: buildPluginSandboxScopeId(deps.scope.scope),
    currentGeneration: () => handle?.instance.generation,
    isDisposed: () => disposed,
  });

  // App-Provided Tools：握手后发现页面工具并登记；信箱投递到达时认领并让页面执行。没有通道时整段跳过。
  const appTools = deps.appTools
    ? createPluginUiAppTools({
        bridge: deps.appTools,
        pluginScope,
        scopeId: buildPluginSandboxScopeId(deps.scope.scope),
        currentGeneration: () => handle?.instance.generation,
        onBusyChange: deps.onBusyChange,
        setTimer,
        log: deps.log,
      })
    : null;

  // [契约] feed 三态互斥：取消优先于结果，有取消时即便同时带结果也只发取消。
  // 输入与结果分两条通知，顺序由这里固定为先输入后结果，页面据此配对同一次调用。
  // 所有发送都不等待并吞掉异常：握手刚完成时桥可能已断，失败不应打断初始化流程。
  // 传入 active 而非读闭包里的桥，避免在等待间隙被新端口替换后投给错误的页面。
  // [失败路径] 吞异常不等于无事发生；需要可观测性时在桥内部记录，不要在这里加等待。
  const sendFeed = (active: PluginUiHostBridge, feed: PluginUiToolFeed) => {
    if (feed.toolInput) void active.sendToolInput(feed.toolInput).catch(() => undefined);
    if (feed.toolCancelled) {
      void active.sendToolCancelled({}).catch(() => undefined);
    } else if (feed.toolResult) {
      void active.sendToolResult(feed.toolResult as CallToolResult).catch(() => undefined);
    }
  };

  // [并发] `attachPort` 进入即重置采样并关闭旧传输：同一时刻只允许一条活跃页面通道。
  // attached 先置假再建桥，保证旧桥残留的通知在切换窗口内被丢弃而不是投给新实例。
  // 顺序敏感：退订资源、注销工具、读初始状态、建桥、装处理器、连传输，不可重排。
  // [资源] 旧传输的关闭不等待，失败也被吞掉；真正的释放由拆卸例程兜底。
  // 本函数不校验沙箱与代际，过滤在端口回调里完成，直接调用会接错端口。
  const attachPort = (port: PluginSandboxTransportPort) => {
    sampling?.reset();
    void transport?.close().catch(() => undefined);
    attached = false;
    cancelHandshakeTimer?.();
    // 新端口 = 页面重载或重挂载：旧代际的订阅退掉、旧实例的工具登记注销；通知入口按新代际重新登记。
    resources.unsubscribeAll();
    appTools?.resetForAttach();
    const widgetState = deps.getWidgetState();
    // widgetState 初值随握手经 hostContext 的扩展键下发（hostContext 允许附加键）；之后不再从宿主推送。
    const contextAtCreate: McpUiHostContext =
      widgetState === undefined
        ? hostContext
        : { ...hostContext, [MCP_APPS_WIDGET_STATE_CONTEXT_KEY]: widgetState };
    const active = createAppBridge(
      { name: MCP_APPS_HOST_NAME, version: deps.hostVersion },
      deps.getHostCapabilities(),
      contextAtCreate,
    );
    const baseContext = hostContext;
    bridge = active;
    // 同一页面里两个 App（页面自建 + 别名）会各发一次 initialize / initialized：只按第一次进入 running 并投喂。
    let initializedOnce = false;
    // [契约] 只有第一次初始化能进入运行态；别名 App 的第二次握手在此被整体忽略。
    // 桥与当前 active 不相等说明端口已被替换，此时必须整体放弃，不能只跳过状态写入。
    // 先清握手计时器再置 attached：顺序反了会让超时回调提前返回，计时器泄漏。
    // 页面能力上报与工具初始化都在运行态之后调用，能力声明只上报一次。
    // [并发] 投喂读的是最新快照，与 notify 系列的丢弃策略配合，避免重复投递。
    active.oninitialized = () => {
      if (disposed || bridge !== active || initializedOnce) return;
      initializedOnce = true;
      cancelHandshakeTimer?.();
      cancelHandshakeTimer = null;
      attached = true;
      setPhase("running", { handle: handle ?? undefined });
      deps.onAppCapabilities?.(active.getAppCapabilities());
      appTools?.onInitialized(
        active,
        active.getAppCapabilities(),
        () => !disposed && bridge === active,
      );
      // 握手窗口内的更新不能丢弃：只补当前实例的最新值，不新增会话状态 owner。
      if (hostContext !== baseContext) active.setHostContext(hostContext);
      sendFeed(active, deps.getToolFeed());
    };
    installPluginUiHostAppHandlers(active, {
      currentContext: () => hostContext,
      applyDisplayMode: (mode) => {
        hostContext = { ...hostContext, displayMode: mode };
        if (attached && bridge === active) active.setHostContext(hostContext);
      },
      onDisplayModeRequest: deps.onDisplayModeRequest,
      pluginScope: () => {
        if (disposed) throw new Error("MCP App instance was closed");
        return pluginScope();
      },
      bridge: deps.bridge,
      createCallId,
      activeCalls,
      onBusyChange: deps.onBusyChange,
      onOpenExternal: deps.onOpenExternal,
    });
    sampling?.install(active, () => !disposed && bridge === active);
    resources.install(active);
    wirePluginUiInteractions(active, deps, deps.platform, () => handle);
    installPluginUiHostNotificationHandlers(active, {
      pluginId: deps.presentation.pluginId,
      onHeight: deps.onHeight,
      log: deps.log,
    });
    // [资源] 传输与桥同批替换：先赋值再连接，dispose 才能拿到可关闭的引用。
    // 连接失败只在桥仍是 active 时上报，防止旧连接的失败覆盖新连接的状态。
    // 握手计时器在连接之后才装：窗口覆盖已连上但未初始化，不覆盖建桥本身。
    // [失败路径] 超时只置错误态，不主动关闭传输；清理仍由拥有者调用 dispose 触发。
    // 传输由 deps 注入，测试替换为假实现以复现丢端口与乱序握手。
    const activeTransport = deps.createTransport(port);
    transport = activeTransport;
    cancelHandshakeTimer = setTimer(() => {
      if (disposed || bridge !== active || attached) return;
      fail(new Error("plugin-ui: ui/initialize handshake timed out"));
    }, deps.handshakeTimeoutMs ?? MCP_APPS_HANDSHAKE_TIMEOUT_MS);
    active.connect(activeTransport).catch((error) => {
      if (bridge === active) fail(error);
    });
  };

  return {
    get phase() {
      return phase;
    },
    isBusy: () => activeCalls.size > 0 || (appTools?.isBusy() ?? false),
    // [事务] 忙时直接返回否且不进入回收标记，调用方可安全重试而不产生半回收状态。
    // 回收标记覆盖整个等待窗口：期间到达的实例关闭通知只记标记，不上报。
    // [失败路径] 回收调用抛错也要走清理段，把标记复位并补发挂起的关闭通知。
    // 返回否说明实例未被回收，此时若曾收到关闭通知必须补报，否则面板停在僵尸态。
    // 挂起标记在清理段末尾无条件复位，避免下一次回收误读上一轮结果。
    async tryRecycle() {
      if (!handle || activeCalls.size || appTools?.isBusy()) return false;
      recycling = true;
      let closed = false;
      try {
        closed = await deps.bridge.recycleInstance(pluginScope());
        return closed;
      } finally {
        recycling = false;
        // 回收 RPC 失败也不能吞掉等待期间已经收到的来源撤销通知。
        if (!closed && closedDuringRecycle && !disposed) deps.onInstanceClosed?.();
        closedDuringRecycle = false;
      }
    },
    start() {
      if (phase !== "idle") return;
      setPhase("preparing");
      preparation = (async () => {
        try {
          const ownerWebContentsId = await deps.platform.getOwnerWebContentsId();
          if (disposed) return;
          const prepared = await deps.bridge.prepareSandbox({
            ...baseScope(),
            scopeId: buildPluginSandboxScopeId(deps.scope.scope),
            resourceUri: deps.presentation.resourceUri,
            ownerWebContentsId,
            ...(deps.presentation.csp ? { csp: deps.presentation.csp } : {}),
            ...(deps.presentation.prefersBorder !== undefined
              ? { prefersBorder: deps.presentation.prefersBorder }
              : {}),
          });
          // prepare 已在 Host/Main 完成登记时，卸载不能只忽略回包，否则沙箱无人释放。
          if (disposed) {
            await deps.bridge.closeInstance({ ...baseScope(), instance: prepared.instance });
            await deps.platform.disposeSandbox(prepared.sandboxId, prepared.initId);
            return;
          }
          try {
            await deps.bridge.validateInstance({ ...baseScope(), instance: prepared.instance });
          } catch (error) {
            await deps.bridge
              .closeInstance({ ...baseScope(), instance: prepared.instance })
              .catch(() => undefined);
            await deps.platform.disposeSandbox(prepared.sandboxId, prepared.initId);
            throw error;
          }
          if (disposed) {
            await deps.bridge
              .closeInstance({ ...baseScope(), instance: prepared.instance })
              .catch(() => undefined);
            await deps.platform.disposeSandbox(prepared.sandboxId, prepared.initId);
            return;
          }
          // [契约] 句柄与归属范围必须成对赋值：任何只写其一的路径都会让范围函数指向旧实例。
          // 赋值前已两次复查已销毁，到这里才落地句柄，是先清理再认领的顺序保证。
          // 句柄的代际随后会被端口事件抬高，初次值只用于比较旧端口是否过期。
          // 不要在句柄赋值后插入等待；后续订阅与通知登记都依赖当前代际仍有效。
          // [权衡] 句柄是浅拷贝替换，不要持有局部引用跨等待使用，否则拿到的是过期代际。
          handle = prepared;
          boundScope = { ...baseScope(), instance: prepared.instance };
          // 先订阅端口再挂 webview：main 在 guest dom-ready 后投递端口，挂载后订阅可能错过。
          unsubscribePorts?.();
          unsubscribePorts = deps.platform.onPorts((event) => {
            if (disposed || !handle || event.sandboxId !== handle.sandboxId) return;
            // 旧 initId 的端口一律丢弃（guest reload / 重复挂载防串线）。
            // [并发] 严格小于才丢弃：相等表示同一代际的重挂载，允许重新接端口。
            // 用事件代际回写句柄，使后续端口按最新代际比较，避免重复挂载被误判为旧端口。
            // 这里只比较代际，跨插件串线由外层的沙箱标识过滤拦住。
            // [失败路径] 丢弃是静默的，不置错误态：页面会通过下一次就绪重新投递端口。
            // 若改成小于等于，guest 重载后的新端口会被当成重复事件丢弃，界面停在空白。
            if (event.initId < handle.initId) return;
            handle = { ...handle, initId: event.initId };
            attachPort(event.port);
          });
          unregisterNotifications?.();
          unregisterNotifications =
            deps.resourceNotifications?.register(
              prepared.instance.generation,
              {
                // [并发] 回收期间的关闭通知只置标记：回收结果尚未返回，此时上报会让面板提前销毁。
                // 非回收期且未销毁才上报；已销毁说明调用方已掌握关闭事实，不再回调。
                // [失败路径] 标记只在回收流程的清理段消费一次，回收成功时直接丢弃。
                // 三个通知入口都先判桥与 attached，未握手时页面收不到协议通知也不会报错。
                // 资源集合归属资源模块，这里只做转发判断，不要在回调里增删订阅。
                notifyInstanceClosed: () => {
                  if (recycling) closedDuringRecycle = true;
                  else if (!disposed) deps.onInstanceClosed?.();
                },
                notifyResourceUpdated: (uri) => {
                  if (!bridge || !attached || !resources.has(uri)) return;
                  void bridge
                    .notification({ method: "notifications/resources/updated", params: { uri } })
                    .catch(() => undefined);
                },
                notifyResourceListChanged: () => {
                  if (!bridge || !attached) return;
                  void bridge
                    .notification({ method: "notifications/resources/list_changed", params: {} })
                    .catch(() => undefined);
                },
                notifyAppToolCall: (call) => {
                  if (!bridge || !attached) return;
                  appTools?.execute(bridge, call);
                },
              },
              prepared.instance,
            ) ?? null;
          setPhase("mounted", { handle: prepared });
        } catch (error) {
          fail(error);
        }
      })();
    },
    updateHostContext(patch) {
      hostContext = { ...hostContext, ...patch };
      if (bridge && attached) bridge.setHostContext(hostContext);
    },
    notifyToolInput(input) {
      if (disposed || !bridge || !attached) return;
      void bridge.sendToolInput(input).catch(() => undefined);
    },
    notifyToolResult(result) {
      if (disposed || !bridge || !attached) return;
      void bridge.sendToolResult(result as CallToolResult).catch(() => undefined);
    },
    notifyToolCancelled() {
      if (disposed || !bridge || !attached) return;
      void bridge.sendToolCancelled({}).catch(() => undefined);
    },
    // [资源] 摘链顺序固定：清计时器与端口订阅、捕获活跃对象、置空、置销毁态，最后才等待。
    // 必须先置销毁态再关闭实例，否则关闭期间的端口或初始化回调会重新建桥。
    // 归属范围与活跃对象都在同步段捕获，等待之后不再读模块变量。
    // 销毁态在异步清理之前发出，外部立即看到终态；清理完成情况靠返回的 promise 判断。
    // [失败路径] 关闭实例的失败被吞掉，但拆卸例程仍会关闭传输并释放沙箱句柄。
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      cancelHandshakeTimer?.();
      cancelHandshakeTimer = null;
      unsubscribePorts?.();
      unsubscribePorts = null;
      const current = handle;
      const scope = current ? { ...baseScope(), instance: current.instance } : null;
      unregisterNotifications?.();
      unregisterNotifications = null;
      const active = bridge,
        activeTransport = transport,
        wasAttached = attached;
      // 注销请求捕获原凭证，不能在 await 后从新句柄读取代际。
      bridge = null;
      transport = null;
      attached = false;
      handle = null;
      setPhase("disposed");
      disposal = (async () => {
        if (scope) await deps.bridge.closeInstance(scope).catch(() => undefined);
        sampling?.reset();
        await preparation;
        resources.unsubscribeAll();
        appTools?.dispose();
        activeCalls.clear();
        await runPluginUiHostTeardown({
          bridge: active,
          transport: activeTransport,
          wasAttached,
          handle: current,
          platform: deps.platform,
          setTimer,
          ...(deps.teardownTimeoutMs !== undefined
            ? { teardownTimeoutMs: deps.teardownTimeoutMs }
            : {}),
        });
      })();
      return disposal;
    },
  };
}
