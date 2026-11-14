// INV-01 模型只经由 root 下的配置文件指向本地 fixture 供应商，不读取任何真实凭据；守住位置：startModel 返回值 env 的透传路径；改错故障：用例打到真实供应商，费用与凭据同时外泄。
// INV-02 子进程环境只含 PATH、四个 ZCODE_* 数据位置、LANG 与 fixture 供应商变量；守住位置：startAgent 中 spawn 的 env 字面量；改错故障：宿主凭据或 Electron 的 Node 标志渗入，行为随开发机漂移。
// INV-03 所有数据目录都在 root 之下并以递归方式创建；守住位置：agent-data 的 mkdir 调用；改错故障：跨用例复用脏 session 库，前一轮状态污染后一轮断言。
// INV-04 窗口预加载脚本与页面路径全部由 root 经 join 拼出；守住位置：installPluginSandboxHost 的 preloadPath 与 createWindow 的 loadFile；改错故障：root 被外部覆盖后加载 root 之外的脚本，测试结论不可信。
// INV-05 路径拼接结果在 Windows 上含反斜杠，断言不得硬编码分隔符；守住位置：root 派生的全部路径；改错故障：本地必挂而 CI 通过，缺陷被平台差异掩盖。
// INV-06 scopes、modes、handles、guests 四张表统一以 webContents.id 为键；守住位置：createWindow 与 registerSandbox；改错故障：窗口重载后路由到旧句柄，通知静默丢失。
// INV-07 scopes 查不到时通知分支必须跳过而不是抛错；守住位置：onNotification 的两处窗口循环；改错故障：早到的帧让主进程异常，后续用例集体超时。
// INV-08 通知只投递给 sessionId 匹配的窗口，绝不广播；守住位置：tool-result 与 conversation/frame 两个分支；改错故障：一个窗口的插件结果被另一窗口消费，串台用例假通过。
// INV-09 wire 必须摘掉 scopeId、resourceUri、ownerWebContentsId、csp、prefersBorder；守住位置：wire 的解构与返回对象；改错故障：服务端收到渲染进程私有字段，权限判定被夹具自身绕过。
// INV-10 workspaceKey 缺失时回退到 workspacePath，workspaceIdentity 仅在非空时下发；守住位置：wire 的 workspace 组装；改错故障：空 key 让两个不同工作区被判成同一会话。
// INV-11 openInstance 必须把 resourceUri 与 scopeId 原样补回，其他方法不得携带；守住位置：bridge 的 openInstance 分支；改错故障：实例丢失资源定位，guest 加载空白页。
// INV-12 recycleInstance 以 onlyIfIdle 关闭并只返回 closed 字段；守住位置：recycleInstance 分支；改错故障：忙实例被强制关闭，进行中的工具调用被腰斩。
// INV-13 gates 以方法名为键，且只在转发之后等待；守住位置：fixture-bridge 与 fixture-app-tools；改错故障：门控早于转发生效，用例等待一个永不到来的返回。
// INV-14 fixture-bridge 必须校验 sessionId、serverName 与当前窗口 scope 一致；守住位置：fixture-bridge 的两条断言；改错故障：错窗口的调用被当作合法请求执行，权限隔离测试形同虚设。
// INV-15 fixture-app-tools 只放行四个已登记方法；守住位置：methods 白名单与随后的断言；改错故障：任意方法名透传到 agent，出现未知 RPC 或越权调用。
// INV-16 will-attach-webview 被拒时不得推入 sandboxId，attachGuest 依赖先入先出的队列；守住位置：pending 数组与两个 webview 事件；改错故障：被拒的 guest 占用队首，真正挂载的 guest 拿到错误沙箱句柄。
// INV-17 background-minimized 模式必须先最小化再启动 fixture；守住位置：mode.endsWith 分支；改错故障：后台时序用例实际在前台跑，覆盖不到目标缺陷。
// INV-18 local 与 sampling 模式必须等到 subscribed 事件才返回窗口；守住位置：createWindow 末尾；改错故障：用例在订阅生效前发请求，帧顺序断言随机失败。
// INV-19 close 必须先销毁全部窗口，再关 agent，最后关 model；守住位置：返回对象的 close；改错故障：agent 先退出导致窗口内请求悬挂，子进程与端口残留。
// INV-20 全部可写产物只落在 root 之内，失败路径不额外留下外部状态；守住位置：startAgent 的 cwd 与 close；改错故障：并行跑两套夹具时互相覆盖配置，出现偶发失败。
import { BrowserWindow, ipcMain, webContents, type WebContents } from "electron";
import assert from "node:assert/strict";
import { join } from "node:path";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";
import { installPluginSandboxHost } from "../../src/main/pluginSandbox/index.js";
import { createPluginUiBridgeService } from "../../../services/src/plugin-ui-bridge/pluginUiBridgeService.js";
import { createPluginUiSamplingService } from "../../../services/src/plugin-ui-bridge/pluginUiSamplingService.js";
import { Events, startAgent } from "./agent.js";
import { startModel } from "./model.js";
import { evaluateGuest } from "./guest-evaluation.js";

export async function managedEnvironment(root: string, node: string, cli: string) {
  const model = await startModel(root, cli);
  // [失败路径] 模型先起、Agent 后起：本地供应商必须先可连，否则子进程启动即失败；顺序颠倒会让 Agent 读到不存在或上一轮遗留的供应商配置。
  // 第四个参数只携带 fixture 的两个配置文件路径，不与 process.env 合并，宿主上的真实 key 因此进不了子进程。
  // 本地供应商地址写在这两个文件里，路径以绝对形式传入，子进程不依赖当前工作目录解析。
  // [并发] 每个用例各自起一套模型与 Agent，端口交给系统按 0 分配，两个夹具并行时不会撞端口。
  // [权衡] 不把完整环境展开再加过滤：显式白名单更难写错，新增变量必须同步改 agent.ts 的 env 字面量，遗漏会在启动阶段立刻暴露。
  // 两处 root 必须是同一个：数据目录、供应商配置与页面资源共处一棵树，失败后可整体清理。
  // [资源] 模型服务与 Agent 子进程都由返回对象的 close 统一收尾，这里任何提前返回都会泄漏端口与子进程。
  const agent = await startAgent(root, node, cli, model.env);
  const events = new Events<any>();
  const windows: BrowserWindow[] = [];
  const modes = new Map<number, string>();
  const scopes = new Map<number, any>();
  const gates = new Map<string, Promise<void>>();
  const handles = new Map<number, any>();
  const guests = new Map<number, WebContents>();
  // preloadPath 由 root 拼出 guest.cjs，root 来自调用方而非当前工作目录，避免从仓库根或构建产物目录误加载另一份沙箱预加载脚本。
  // rendererDir 与 aliasDir 同指 root：夹具页面及其别名资源共用一层，缩小可加载范围，也省掉额外映射。
  // 根目录同时被沙箱宿主与页面加载共用，改渲染目录等于同时改了预加载脚本与页面资源的搜索范围。
  // [权衡] 显式传 env 而不让 install 推导：夹具在源码与构建产物两种布局下都指向同一份实现。
  // [失败路径] 预加载脚本缺失时宿主装配失败并只落一条 stderr 告警，用例在挂载阶段失败而不是静默降级。
  // [失败路径] logger 只把告警写到 stderr，不抛不退出：沙箱装配失败交给后续用例断言发现，在这里中断会把问题伪装成用例挂起。
  // [资源] 返回的 native 句柄被所有注册与挂载共用，窗口存活期间不能重建，否则已挂载的 guest 会指向另一个宿主实例。
  const native = installPluginSandboxHost({
    rendererDir: root,
    aliasDir: root,
    preloadPath: join(root, "guest.cjs"),
    logger: { warn: (message) => process.stderr.write(`${message}\n`) },
  });
  // wire 是渲染进程到服务端的唯一收敛点，宿主私有字段只在这一层被摘掉，下游 service 看不到协议之外的字段。
  // 解构出的 scopeId、resourceUri 等在此刻意丢弃，少数确实需要的方法再显式补回，这样哪些调用依赖宿主上下文在调用点可见。
  // [权衡] 用对象解构而不是逐字段删除：新增宿主字段时不会再被无意识透传。
  // [权衡] workspaceKey 用修剪后的 workspaceIdentity 回退到 workspacePath：允许构造无身份工作区，同时保证 key 永不为空串。
  // 若直接下发原始 workspaceIdentity，空串会让两个不同工作区被判成同一会话。
  // [失败路径] 输入对象未做形状断言，缺字段时按可选处理，漏传 workspacePath 会得到空 workspace 并由用例断言暴露。
  // 返回对象里只有 workspace 是重建的，其余字段原样展开，后续新增协议字段无需改动这里。
  const wire = (p: any) => {
    const {
      workspacePath,
      workspaceIdentity,
      scopeId: _scope,
      resourceUri: _uri,
      ownerWebContentsId: _owner,
      csp: _csp,
      prefersBorder: _border,
      ...rest
    } = p;
    return {
      ...rest,
      workspace: {
        workspacePath,
        workspaceKey: workspaceIdentity?.trim() || workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      },
    };
  };
  const sampling = createPluginUiSamplingService({
    sample: (p) => agent.call("mcp/uiSampling", wire(p)),
    cancelSampling: (p) => agent.call("mcp/uiCancelSampling", wire(p)),
  });
  const bridge = createPluginUiBridgeService({
    openInstance: (p) =>
      agent.call("mcp/uiOpenInstance", {
        ...wire(p),
        resourceUri: p.resourceUri,
        scopeId: p.scopeId,
        ownerWebContentsId: p.ownerWebContentsId,
      }),
    validateInstance: (p) => agent.call("mcp/uiValidateInstance", wire(p)),
    closeInstance: (p) => agent.call("mcp/uiCloseInstance", wire(p)),
    // [事务] 回收复用关闭接口并带 onlyIfIdle：实例忙时服务端不关，返回的 closed 为假，调用方可以安全重试。
    // 回收是关闭的弱化形式：在真正关闭前确认实例空闲，避免与仍在执行的工具调用竞争同一 guest。
    // 这里只取 closed 一个字段，把关闭原因等诊断信息挡在桥接层外，渲染进程不会依赖服务端内部结构。
    // [并发] 同一实例被两个窗口同时回收时以先到者为准，后到者拿到 closed 为假并自行重试。
    // [失败路径] 关闭请求抛错时异常原样上抛，不做吞掉，否则用例会把回收失败误判成实例已消失。
    // [失败路径] 桥接层没有再包装返回值，渲染进程直接看到服务端的拒绝原因，排查不必多翻一层。
    // [权衡] 单独包一次调用而不给 closeInstance 加参数：回收语义由宿主决定，渲染进程无法自行选择强制关闭。
    recycleInstance: async (p) =>
      (await agent.call("mcp/uiCloseInstance", { ...wire(p), onlyIfIdle: true })).closed,
    readMcpResource: (p) => agent.call("mcp/readResource", wire(p)),
    callMcpToolForUi: (p) => agent.call("mcp/uiCallTool", wire(p)),
    cancelMcpToolCallForUi: (p) => agent.call("mcp/uiCancelCall", wire(p)),
    readMcpResourceForUi: (p) => agent.call("mcp/uiReadResource", wire(p)),
    listMcpResourcesForUi: (p) => agent.call("mcp/uiListResources", wire(p)),
    listMcpResourceTemplatesForUi: (p) => agent.call("mcp/uiListResourceTemplates", wire(p)),
    subscribeMcpResourceForUi: (p) =>
      agent.call("mcp/uiSubscribeResource", { ...wire(p), scopeId: p.scopeId }),
    unsubscribeMcpResourceForUi: (p) =>
      agent.call("mcp/uiUnsubscribeResource", { ...wire(p), scopeId: p.scopeId }),
    // [资源] 每次注册都以 ownerWebContentsId 覆盖旧句柄，窗口重载后同一 id 的新句柄顶替旧值，旧句柄不再被引用。
    // [并发] handles 没有加锁：写入都发生在主进程的 IPC 回调里，单线程事件循环保证读写不交错。
    // 先入表再发事件：等待 registered 的用例被唤醒时，handles 里一定已能查到对应句柄，不会读到空表。
    // registered 事件携带句柄本身，用例既能查表也能用事件参数，两条路径指向同一对象。
    // [失败路径] registerFromHost 抛错时条目未写入、事件也未发出，用例停在等待上并最终超时，而不是拿到半初始化的句柄。
    // [权衡] 不在这里校验 ownerWebContentsId 是否已登记窗口：注册可能先于窗口入表，校验会把合法时序判成错误。
    registerSandbox: async (p) => {
      const handle = native.registerFromHost(p);
      handles.set(p.ownerWebContentsId, handle);
      events.emit({ type: "registered", owner: p.ownerWebContentsId, handle });
      return handle;
    },
  });
  // [并发] 通知异步到达，windows 与 scopes 可能已增删；循环内每次重新取 scope 并跳过已销毁窗口，不缓存窗口引用。
  // [权衡] 两条分支各自遍历窗口而不先建索引：窗口数量是个位数，索引的维护成本高于遍历收益。
  // tool-result 必须在 frame 之前单独处理：它的 sessionId 来自参数本身，而 frame 的 topic 需按窗口拼出，两者匹配口径不同。
  // frame 分支要求 topic 与窗口会话完全相等，前缀相同但会话不同的帧不会被误投。
  // [失败路径] scopes 查不到时可选链给出 undefined，比较结果为假即跳过；这里不能断言存在，早到的帧合法地先于窗口注册。
  // [失败路径] 发送前只检查销毁状态，发送失败由 Electron 忽略，这里不重试以免打乱帧顺序。
  agent.client.onNotification((event) => {
    if (event.method === "v4/plugin-ui/tool-result") {
      for (const win of windows) {
        if (win.isDestroyed()) continue;
        const scope = scopes.get(win.webContents.id);
        if (scope?.sessionId === event.params.sessionId)
          win.webContents.send("fixture-notification", {
            kind: "ui-result",
            value: {
              ...event.params,
              workspacePath: scope.workspace.workspacePath,
            },
          });
      }
      return;
    }
    if (event.method !== "v4/conversation/frame") return;
    for (const win of windows) {
      if (
        !win.isDestroyed() &&
        event.params.topic === `conversation/${scopes.get(win.webContents.id)?.sessionId}`
      )
        win.webContents.send("fixture-notification", { kind: "frame", value: event.params });
    }
  });
  ipcMain.handle("fixture-config", (event) => {
    const scope = scopes.get(event.sender.id);
    return {
      mode: modes.get(event.sender.id),
      scope: {
        ...scope.workspace,
        sessionId: scope.sessionId,
        scope: { kind: "surface", surfaceId: scope.surface ?? "same" },
      },
      presentation: {
        pluginId: scope.pluginId,
        serverName: scope.serverName,
        resourceUri: scope.resourceUri ?? "ui://fixture",
      },
    };
  });
  ipcMain.handle("fixture-event", (event, value) =>
    events.emit({ ...value, owner: event.sender.id }),
  );
  // [失败路径] 两条断言把渲染进程的会话与服务名钉死在自己 scope 上：携带别人的 sessionId 时用例立即失败，而不是被服务端当成合法请求执行。
  // [并发] 每个窗口的调用并行进入，gates 按方法名共享，同一方法的多窗口请求会一起被放行，用例需自行区分 owner。
  // 到达事件先发、结果事件后发，gates 只在转发完成后等待，保证门控挂起时请求已真正进入服务端。
  // 结果在门控之后返回，但转发与结果事件已先发出，用例可在放行前后分别断言。
  // [失败路径] 对象展开后方法不存在时抛类型错误，错误经 IPC 回给渲染进程，不会静默给出 undefined。
  // [权衡] 方法通过对象展开后动态取键，省掉一长串分支；代价是非法方法只抛类型错误，由用例的失败信息兜底。
  ipcMain.handle("fixture-bridge", async (event, method, params) => {
    const scope = scopes.get(event.sender.id);
    assert.equal(params.sessionId, scope.sessionId);
    assert.equal(params.serverName, scope.serverName);
    events.emit({ type: "bridge-arrived", method, owner: event.sender.id });
    const result = await ({ ...bridge, ...sampling } as any)[method](params);
    events.emit({ type: "bridge", method, owner: event.sender.id });
    await gates.get(`return:${method}`);
    return result;
  });
  // methods 既是方法名校验表也是 RPC 名映射，新增应用工具能力必须在此登记，否则收到的调用直接判为非法。
  // [并发] install 的多次调用共享同一个 gate，第二次在第一次放行后立即通过。
  // [失败路径] 白名单校验在方法名不在表内时抛出，异常经 IPC 回传给渲染进程，用例看到明确的非法方法而不是服务端的未知 RPC 错误。
  // 门控键直接用 method 本身而不拼前缀，与用例侧 gates 的约定一致，改键名会让挂起永久等待。
  // [失败路径] 参数里的 scopeId 在此显式补回，缺失时服务端按未绑定作用域拒绝，错误直接可见。
  // 结果连同参数一起写回事件，供用例核对服务端返回与请求是否对应。
  ipcMain.handle("fixture-app-tools", async (event, method, params) => {
    const methods: Record<string, string> = {
      registerAppTools: "mcp/uiRegisterAppTools",
      unregisterAppTools: "mcp/uiUnregisterAppTools",
      claimAppToolCall: "mcp/uiClaimAppToolCall",
      resolveAppToolCall: "mcp/uiResolveAppToolCall",
    };
    assert.ok(methods[method]);
    events.emit({ type: "app-tools-arrived", method, owner: event.sender.id, params });
    await gates.get(method);
    const result = await agent.call(methods[method]!, { ...wire(params), scopeId: params.scopeId });
    events.emit({ type: method, owner: event.sender.id, params, result });
    return result;
  });
  ipcMain.handle("fixture-v4", async (event, method, params) => {
    const scope = scopes.get(event.sender.id);
    const connectionId = `managed-${event.sender.id}`;
    if (method === "helloConversationV4")
      return {
        kind: "hello",
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        connectionId,
        clientMode: "desktop-continuous",
        deliveryProfile: "continuous",
        serverTime: Date.now(),
        capabilities: {
          nativeDialogs: true,
          localTerminal: true,
          binaryFrames: false,
          compression: "none",
          independentPlanState: true,
        },
        auth: {},
      };
    if (method === "initializeConversationV4") return;
    if (method === "subscribeConversationV4") {
      const result = await agent.call("v4/conversation/subscribe", {
        connectionId,
        clientMode: "desktop-continuous",
        workspace: scope.workspace,
        topic: `conversation/${params.sessionId}`,
        ...(params.visibility ? { visibility: params.visibility } : {}),
      });
      events.emit({ type: "subscribed", owner: event.sender.id });
      return result;
    }
    if (method === "unsubscribeConversationV4") {
      const result = await agent.call("v4/conversation/unsubscribe", {
        connectionId,
        topic: `conversation/${params.sessionId}`,
        subscriptionId: params.subscriptionId,
      });
      events.emit({ type: "unsubscribed", owner: event.sender.id });
      return result;
    }
    if (method === "resyncConversationV4")
      return agent.call("v4/conversation/resync", { connectionId, ...params });
    throw new Error(`Unexpected managed service call ${method}`);
  });
  async function createWindow(scope: any, mode = "local") {
    const win = new BrowserWindow({
      show: mode.startsWith("background"),
      width: 1000,
      height: 700,
      webPreferences: {
        preload: join(root, "preload.cjs"),
        webviewTag: true,
        backgroundThrottling: mode.startsWith("background"),
      },
    });
    windows.push(win);
    modes.set(win.webContents.id, mode);
    scopes.set(win.webContents.id, scope);
    win.webContents.on("console-message", (e) => process.stderr.write(`${e.message}\n`));
    const pending: string[] = [];
    win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      const result = native.configureGuest({
        webPreferences,
        params,
        ownerWebContentsId: win.webContents.id,
      });
      if (!result.ok) event.preventDefault();
      else pending.push(result.sandboxId);
    });
    win.webContents.on("did-attach-webview", (_event, guest) => {
      guests.set(win.webContents.id, guest);
      native.attachGuest({ guest, hostWebContents: win.webContents, sandboxId: pending.shift()! });
    });
    // 页面固定取 root 下的 managed.html，不手工拼 file URL，省掉 Windows 盘符与中文路径的转义问题。
    // 页面里不注入测试数据，全部状态经 IPC 与通知通道驱动，夹具与真实宿主走同一条路径。
    // [并发] 多个窗口加载同一文件互不影响，会话隔离由 scope 表而非页面自身承担。
    // [失败路径] 加载失败时该调用直接拒绝，不会返回白屏窗口让后续断言在超时里空耗。
    // [权衡] 加载完成与 harnessReady 分开等待：前者只保证文档就绪，渲染进程的桥接对象由后续显式探测确认。
    // [资源] 窗口在加载前已入表，即使加载抛错也能被 close 逐个销毁。
    await win.loadFile(join(root, "managed.html"));
    if (mode.endsWith("-minimized")) {
      // 已加载的宿主窗口先最小化，再发起首个插件请求，覆盖真实后台创建时序。
      await win.webContents.executeJavaScript("window.fixturePaused");
      win.minimize();
      await win.webContents
        .executeJavaScript(`document.hidden || new Promise(resolve=>document.addEventListener('visibilitychange',function changed(){
        if(document.hidden){document.removeEventListener('visibilitychange',changed);resolve()}
      }))`);
      await win.webContents.executeJavaScript("window.startFixture()");
    }
    await win.webContents.executeJavaScript("window.harnessReady");
    if (mode !== "local" && mode !== "sampling") return win;
    await evaluateGuest(
      guests.get(win.webContents.id)!,
      scope.resourceUri ? "window.showcaseReady" : "window.fixtureReady",
    );
    await events.wait((e) => e.type === "subscribed" && e.owner === win.webContents.id);
    return win;
  }
  return {
    gates,
    model,
    agent,
    events,
    windows,
    scopes,
    handles,
    guests,
    native,
    wire,
    bridge,
    createWindow,
    evalPage: (win: BrowserWindow, code: string) =>
      evaluateGuest(guests.get(win.webContents.id)!, code),
    countGuests: () =>
      webContents.getAllWebContents().filter((c) => c.getType() === "webview").length,
    async close() {
      // [资源] 先销毁窗口再关服务：窗口内的 webview 与沙箱句柄随宿主销毁释放，反序会让仍在运行的 agent 继续向已消失的 webContents 推送。
      // 单个窗口销毁抛错不会阻断循环，后续窗口照常处理。
      // [失败路径] 销毁不等待异步事件，重复调用由 isDestroyed 短路，单个窗口出错也不阻断后续 agent 与 model 关闭。
      // [权衡] 只销毁不等待 closed 事件：夹具不依赖优雅关闭，卡住的窗口会把整轮拖死。
      for (const win of windows) if (!win.isDestroyed()) win.destroy();
      await agent.close();
      await model.close();
    },
  };
}
