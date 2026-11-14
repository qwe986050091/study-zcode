// pluginUiManagedPage —— 单张插件页面（卡片 / 侧栏 / 独立页）的宿主适配器，工厂入口 createPage。
//
// 职责边界：把 UsePluginUiHostInput 编译为注册表可调度的 Page，串起「连接租约 → controller → 端口桥 → plane 挂载」，
// 并在 suspend / destroy 时按创建逆序释放；只做编排、代际判定与状态投影，不解析消息体、不渲染插件 UI。
// 不负责：MCP App 消息语义（pluginUiHostController / messagePortTransport）、沙箱进程与权限（platform.pluginSandbox）、
// 注册表容量与淘汰（pluginUiPages）、widgetState 持久化（pluginUiWidgetStateStore）、telemetry 落库与展示。
// 外部监听只有两个：document 的 visibilitychange 与 workspace 任务删除事件，两者都必须在 destroy 中成对解除。
//
// INV 表（每条都对应真实故障边界；改代码前先读「守住它的位置」与「改错故障」）：
// INV-01 断言：同一页面在任 controller 唯一，controller 字段是唯一事实源 —— 守住它的位置：ensure 早退、onPhase 首行比较 —— 改错故障：双桥抢同一端口，插件收到两份 hostContext 并反复重载。
// INV-02 断言：setHandle 仅在 appIdentity 变化时清 widgetState —— 守住它的位置：setHandle 的 appIdentity 比较分支 —— 改错故障：同插件热重载丢用户草稿，或跨插件串用旧 widgetState。
// INV-03 断言：ensure 用 incarnation 代际丢弃迟到结果 —— 守住它的位置：每个 await 之后的 epoch 比较 —— 改错故障：已 suspend 的页面被迟到的 reserve 复活，注册表出现幽灵页。
// INV-04 断言：非 force 的 suspend 必须返回 false —— 守住它的位置：suspend 首行 —— 改错故障：编辑器未保存文档随离屏或容量淘汰丢失。
// INV-05 断言：所有释放挂在 releasing 同一条 Promise 链上 —— 守住它的位置：suspend 的 Promise.all 与 ensure 的 await releasing —— 改错故障：新旧代际并发清理，重复 unmount 或释放后仍被挂载。
// INV-06 断言：入站消息只经 controller 绑定端口与 scope 到达，无模块级全局分发 —— 守住它的位置：createTransport 与 scope 入参 —— 改错故障：A 会话的 pluginUi 增量投递到 B 会话页面。
// INV-07 断言：宿主能力只按回调是否真实存在声明 —— 守住它的位置：getHostCapabilities 的 Boolean 判断 —— 改错故障：声明了 canDownloadFile 却无实现，插件调用后永久 pending。
// INV-08 断言：资源通知按 (scopeId, generation) 登记 —— 守住它的位置：createPluginUiResourceNotificationRegistrar 入参 —— 改错故障：旧代际增量污染新代际页面。
// INV-09 断言：toolInput / toolResult / toolCancelled 以 feed 快照去重后单向下发 —— 守住它的位置：updateToolFeed 的 lastFeed 比较 —— 改错故障：重复渲染或乱序覆盖，插件看到旧工具结果。
// INV-10 断言：hostContext 仅在输入指纹变化时更新 —— 守住它的位置：update 的 contextInputs 与 lastContext 双比较 —— 改错故障：每次父组件重渲染都下发上下文，插件主题闪烁。
// INV-11 断言：plane 可见性回调与 visibilitychange 共用同一 syncExecution —— 守住它的位置：onVisibility 与 addEventListener —— 改错故障：后台执行标志与真实可见性相反，插件被错误暂停。
// INV-12 断言：destroy 必须先摘全局监听与 workspace 事件再挂起 —— 守住它的位置：destroy 前四行 —— 改错故障：销毁后仍响应可见性变化，访问已清空的 controller。
// INV-13 断言：error 是终态，除 reload 外不得自动重建 —— 守住它的位置：ensure 开头的 phase 早退 —— 改错故障：崩溃自愈形成重连风暴，日志与沙箱被打满。
// INV-14 断言：高度只经 clampCardHeight 收敛 —— 守住它的位置：onHeight 与 heightHint 分支 —— 改错故障：插件把卡片撑到全屏或压成零高。
//
// 状态机：idle → preparing（handle 到达前）→ running → error；force suspend 一律回 idle，error 仅由 reload 逃逸。
// 阅读顺序：ensure（租约 / reserve）→ createController（建桥与能力声明）→ setHandle（挂载）→ suspend / destroy（释放）。
// 本注释描述当前实现，不构成对外契约；类型契约以 pluginUiHostTypes.ts 与本目录 contract.ts 为准。
import { pluginUiStateKey } from "@/plugin-ui/adapters/pluginUiStateKey.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { getPluginUiSessionActions } from "./pluginUiSessionActions.js";
import { logger } from "@/logger.js";
import { createPluginUiMessagePortTransport } from "@/plugin-ui/adapters/messagePortTransport.js";
import { createPluginUiDownloadInteraction } from "@/plugin-ui/adapters/pluginUiDownloads.js";
import { readPluginUiStyleVariables } from "@/plugin-ui/adapters/readPluginUiStyleVariables.js";
import {
  createPluginUiHostController,
  type PluginUiHostController,
  type PluginUiHostPhase,
} from "@/plugin-ui/app/pluginUiHostController.js";
import { createPluginUiResourceNotificationRegistrar } from "@/plugin-ui/app/pluginUiResourceNotificationBus.js";
import {
  clearPluginUiWidgetState,
  getPluginUiWidgetState,
  setPluginUiWidgetState,
} from "@/plugin-ui/app/pluginUiWidgetStateStore.js";
import type {
  McpUiAppCapabilities,
  McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import { buildPluginSandboxScopeId } from "@zcode/shared/mcp-apps";
import { clearPluginUiSurfaceFeed } from "../app/pluginUiSurfaceFeedStore.js";
import {
  PLUGIN_UI_CARD_DEFAULT_HEIGHT_PX,
  PLUGIN_UI_CARD_MAX_HEIGHT_PX,
  PLUGIN_UI_CARD_MIN_HEIGHT_PX,
} from "../contract.js";
import { buildPluginUiHostCapabilities } from "../domain/buildPluginUiHostCapabilities.js";
import { buildPluginUiHostContext } from "../domain/buildPluginUiHostContext.js";

import { acquireWorkspaceConnection } from "@/v4/workspaceConnectionRegistry.js";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { buildPluginUiSessionKey } from "../contract.js";
import type { Page, UsePluginUiHostInput, UsePluginUiHostResult } from "./pluginUiHostTypes.js";
import { createPluginUiPagePlane } from "./pluginUiPagePlane.js";
import { pluginUiPages } from "./pluginUiPageRegistry.js";
import { attachPluginUiResourceDeltaFeed } from "./pluginUiResourceDeltaFeed.js";
type Platform = IPlatformService;
type Services = IServiceAccessor;
export function createPage(
  key: string,
  input: UsePluginUiHostInput,
  platform: Platform,
  services: Services,
): Page {
  const reportUsage = (action: string, failed = false) => {
    void reportAppTelemetryEvent(
      platform,
      {
        elementName: failed ? "plugin_runtime_error" : "plugin_usage",
        eventRegion: "app",
        eventType: "result",
        eventExtraDetail: {
          schema_version: "1",
          action,
          plugin_id: input.presentation.pluginId,
          plugin_component: "ui",
          client_kind: "desktop",
          ...(failed ? { error_category: "unknown", result: "failure" } : {}),
        },
      },
      "plugin-ui",
    );
  };
  const bridge = services.pluginUiBridgeService!;
  const sandboxPlatform = platform.pluginSandbox!;
  const surfaceKey = key;
  // [契约] latest 只承接「最新一次外部输入」，不缓存派生量；controller 回调一律经它读取当前值。
  // 回调 identity 因此保持稳定，update 换 theme 或 interactions 不会触发 controller 重建。
  // 派生量（contextInputs / lastFeed / lastContext）单独存放，避免与输入混成一个对象导致全量比较。
  const latest = { current: input };
  const listeners = new Set<() => void>();
  // [契约] 这些 let 是本页面全部可变状态；surfaceStateKey 由异步 pluginUiStateKey 生成，只用于能力声明。
  // 其余字段分别对应 controller 连接、releaseFeed 资源增量、releaseLease 连接租约、executionKey 后台执行去重。
  // 这些字段都不放进 snapshot：snapshot 是给 UI 的只读投影，放入内部句柄会让订阅者绕过生命周期判断。
  let surfaceStateKey: string | undefined;
  let controller: PluginUiHostController | null = null;
  let releaseFeed: (() => void) | undefined;
  let releaseLease: (() => void) | undefined;
  let executionKey = "";
  let disposed = false;
  let starting = false;
  // [并发] incarnation 是唯一代际号，ensure 与 suspend 都递增，共同让「进行中的旧流程」失效。
  // 只比较 epoch 与 incarnation，不引入 AbortController：流程里只有 stateKey 与 reserve 两个可等待点。
  // 递增后必须让旧的 reserve 分支重新读 starting，否则旧流程会把 starting 永久置 true，页面再也 ensure 不起来。
  let incarnation = 0;
  // [资源] releasing 串行化所有释放；ensure 在 reserve 前先 await 它，保证旧沙箱未拆干净时不新建。
  // 初值 Promise.resolve 让首次 ensure 无需分支；之后每次 suspend 把新链叠在旧链尾部。
  // 错误不吞：Promise.all 的 rejection 由 await 方承担，suspend 会把失败抛给调用者。
  let releasing: Promise<unknown> = Promise.resolve();
  let contextInputs = "";
  let lastFeed = "";
  let lastContext = "";
  let appIdentity: string | undefined;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  let snapshot: UsePluginUiHostResult = {
    pageKey: key,
    supported: true,
    phase: "idle",
    handle: null,
    height: PLUGIN_UI_CARD_DEFAULT_HEIGHT_PX,
    error: null,
    appCapabilities: undefined,
    // [失败路径] reload 是错误态唯一出口：先清 widgetState，再 force suspend，最后重新 ensure。
    // 顺序不可换：先 suspend 才让 incarnation 失效旧 controller；先 ensure 会因 controller 非空直接返回。
    // suspend(true).then(ensure) 而非 await：按钮回调不必等待整个拆除过程。
    reload: () => {
      clearPluginUiWidgetState(key);
      void page.suspend(true).then(ensure);
    },
  };
  const patch = (value: Partial<UsePluginUiHostResult>) => {
    snapshot = { ...snapshot, ...value };
    notify();
  };
  const setPhase = (phase: PluginUiHostPhase) => patch({ phase });
  // [契约] handle 是「挂载」与「执行」的共同输入：先 patch，再 mount，再 syncExecution。
  // appIdentity 变化表示同页面换了插件实例，旧 widgetState 属于别的应用，必须丢弃。
  // 同一 appIdentity 的重载（同插件新 initId）保留 widgetState，这是编辑器草稿不丢的前提。
  // mount 必须在 patch 之后：订阅者可能立刻读 snapshot.handle，读到 null 会误判未就绪。
  const setHandle = (handle: PluginSandboxHandle) => {
    if (appIdentity && appIdentity !== handle.instance.appIdentity) clearPluginUiWidgetState(key);
    appIdentity = handle.instance.appIdentity;
    patch({ handle });
    plane.mount(handle);
    syncExecution();
  };
  const setHeight = (height: number) => patch({ height });
  const setError = (error: string) => patch({ error });
  const setAppCapabilities = (appCapabilities: McpUiAppCapabilities | undefined) =>
    patch({ appCapabilities });
  // [资源] plane 负责把沙箱节点挂到 DOM 并监测可见性与崩溃；它不持有 controller，也不管租约。
  // onVisibility 同时承担「注册表可见性」与「执行标志」两件事，只有可见性真的变化才通知注册表。
  // 无条件调用 pluginUiPages.visibility 会让注册表反复触发淘汰评估，属于隐性 O(n) 抖动。
  const plane = createPluginUiPagePlane({
    onVisibility(visible) {
      if (page.visible !== visible) pluginUiPages.visibility(page, visible);
      if (visible) ensure();
      syncExecution();
    },
    // [失败路径] 崩溃是终端事件：先 suspend(true) 阻止回收，再把 phase 置 error 交由 UI 呈现重试入口。
    // 这里不直接 dispose controller：dispose 由 suspend 统一排队到 releasing，避免两条清理路径竞争。
    // 崩溃后 handle 仍留在 snapshot 直到 suspend 统一清空，防止半清理状态被渲染。
    onCrash() {
      void page.suspend(true);
      patch({ phase: "error", error: "MCP App page stopped" });
    },
  });
  // [权衡] 握手完成、session 空闲都不等于插件空闲：宿主保留页面期间必须允许它继续执行。
  // 后台定义为 controller 存在且（页面不可见或 document.hidden），由沙箱决定降频而非停摆。
  // executionKey 以 sandboxId:initId:background 做幂等键，相同键直接返回，避免重复 IPC 与日志。
  // setExecutionActive 失败只记 warn，且要求 handle 仍是当前句柄，避免旧代际错误污染新页面。
  function syncExecution() {
    // 握手完成和 session 空闲都不能证明插件内部已无工作；宿主保留页面时必须允许它执行。
    const active = controller !== null;
    plane.setExecutionActive(active);
    const handle = snapshot.handle;
    if (!handle || !sandboxPlatform.setExecutionActive) return;
    // [契约] background 为真表示「逻辑活跃但用户看不见」，用于让沙箱降频。
    // page.visible 与 document.hidden 会各自失真（侧栏折叠 vs 窗口最小化），因此取或再下发。
    const background = active && (!page.visible || document.hidden);
    const nextKey = `${handle.sandboxId}:${handle.initId}:${background}`;
    if (nextKey === executionKey) return;
    executionKey = nextKey;
    logger.lifecycle.info("[plugin-ui] background execution", {
      sessionId: input.scope.sessionId,
      sandboxId: handle.sandboxId,
      active: background,
    });
    void sandboxPlatform
      .setExecutionActive(handle.sandboxId, handle.initId, background)
      .catch((error: unknown) => {
        if (snapshot.handle !== handle || disposed) return;
        logger.warn("[plugin-ui] background execution failed", { error: String(error) });
      });
  }
  // [并发] ensure 是唯一入口，四个早退挡住：已销毁、已有 controller、正在启动、错误终态。
  // starting 是同步重入锁，覆盖「已进入但 controller 尚未赋值」的窗口。
  // 错误态不回退 idle：仅 reload 或外部显式 suspend 可重试，避免崩溃自愈形成重连风暴。
  // 成功后必须复位 starting，否则 start 与 bind 并发调用会让页面永远停在 preparing。
  async function ensure() {
    if (disposed || controller || starting || snapshot.phase === "error") return;
    starting = true;
    const epoch = ++incarnation;
    try {
      await releasing;
      // [失败路径] stateKey 计算失败与 reserve 失败共用一个 catch，统一落到 error 并复位 starting。
      // 先算 stateKey 再 reserve：能力声明需要它，而 reserve 成功后注册表就可能立刻调度本页。
      // 两个 await 之后都要重新比对 epoch，因为期间可能发生 suspend 并已递增 incarnation。
      surfaceStateKey = await pluginUiStateKey(surfaceKey);
      if (disposed || epoch !== incarnation) return;
      // [资源] reserve 占用注册表名额，失败必须走 catch；此时尚未建租约，无需回滚其他资源。
      // reserve 成功后若代际已过期，必须显式 released(page) 归还名额，否则名额泄漏导致后续页面起不来。
      // 归还放在这个独立分支而非 finally：正常路径的归还在 suspend 的 releasing 链里完成。
      await pluginUiPages.reserve(page);
    } catch (error) {
      starting = false;
      patch({ phase: "error", error: String(error) });
      return;
    }
    if (disposed || epoch !== incarnation) {
      pluginUiPages.released(page);
      return;
    }
    starting = false;
    try {
      // 页面独立持有已有 workspace 连接租约；卡片或 pane 退出不会让后台页面失联。
      // [资源] 连接租约由页面自己持有，而非复用卡片或侧栏租约：展示位置切换不能让后台页面失联。
      // lease 的 store 供资源增量 feed 使用，因此释放顺序必须是 feed → 订阅 → 租约。
      // acquire 抛错时 controller 未建、plane 未挂载，catch 只需 suspend 回退注册表名额。
      // sessionId 作为 layer key：同一会话的多个页面共享一层，不同会话互不干扰。
      const connection = acquireWorkspaceConnection(
        latest.current.scope,
        services.zcodeAgentService,
        platform.createLocalMediaPreviewUrl,
      );
      releaseLease = () => connection.release();
      const lease = connection.layer.acquire(latest.current.scope.sessionId);
      // [失败路径] runtime 不可用是终态：suspend 阻止回收，同时把错误暴露给 UI 等待用户 reload。
      // onRuntimeRestart 与 onRuntimeLifecycle 的 unavailable 合并到同一处理，避免只监听其一时漏掉重启。
      // 这里不直接 dispose controller，仍交给 suspend 的 releasing 链，保证与正常关闭同一条清理路径。
      const runtimeStopped = () => {
        void page.suspend(true);
        patch({ phase: "error", error: "MCP App runtime is no longer available" });
      };
      const offRestart = connection.transport.onRuntimeRestart(runtimeStopped);
      const offLifecycle = connection.transport.onRuntimeLifecycle?.((state) => {
        if (state === "unavailable") runtimeStopped();
      });
      // [资源] 释放严格逆序：先摘 runtime 监听，再释放 layer 租约，最后释放连接。
      // 先摘监听可防止释放途中 runtime 再回调 runtimeStopped，把已回 idle 的页面重新写成 error。
      // layer 租约先于 connection 释放，否则关闭连接时租约仍被引用，连接池无法回收。
      // 首个版本只释放 connection，监听注册完成后被整体覆盖，保证任一步骤失败都能回退。
      releaseLease = () => {
        offRestart();
        offLifecycle?.();
        lease.release();
        connection.release();
      };
      // [资源] 资源增量 feed 绑在租约 store 上并按 scope 过滤，必须先于 lease 释放。
      // feed 在此注册而非 createController 内：即使后续 controller 创建失败，回收也保持对称。
      releaseFeed = attachPluginUiResourceDeltaFeed(lease.store, latest.current.scope);
      patch({ phase: "preparing", error: null, handle: null });
      createController();
    } catch (error) {
      void page.suspend(true);
      patch({ phase: "error", error: String(error) });
    }
  }
  // [契约] controller 是消息唯一入口与出口：入站 pluginUi 消息都经它与 scope 绑定的端口到达。
  // 构造参数里的 scope 与 presentation 决定消息来源身份；bridge 只负责投递，不做来源校验。
  // 因此本函数不做任何全局事件订阅，避免跨页面串消息。
  function createController() {
    const initialHostContext: McpUiHostContext = buildPluginUiHostContext({
      theme: latest.current.theme,
      locale: latest.current.locale,
      displayMode: latest.current.displayMode,
      width: latest.current.width,
      ...(latest.current.titleBar ? { titleBar: latest.current.titleBar } : {}),
      ...(latest.current.availableDisplayModes
        ? { availableDisplayModes: latest.current.availableDisplayModes }
        : {}),
      // 主题 token 随初始 hostContext 下发，主题切换时经 updateHostContext 更新。
      styleVariables: readPluginUiStyleVariables(),
    });
    const scope = latest.current.scope;
    const presentation = latest.current.presentation;
    // 平台交互（downloadFile）与调用方注入的会话交互合成一份；能力声明按合成后的回调是否存在。
    // [契约] `createPluginUiDownloadInteraction` 与调用方交互合成一份；能力声明按合成后回调是否存在逐项判断。
    // 最小暴露：没给 onSendFollowUpMessage 就不声明 canSendFollowUpMessage，插件据此做特性检测。
    // getInstance 延迟到调用时取 handle，避免 controller 构造期 snapshot 尚未就绪。
    const platformInteractions = createPluginUiDownloadInteraction({
      platform,
      bridge,
      scope,
      presentation,
      getInstance: () => {
        if (!snapshot.handle) throw new Error("MCP App is not prepared");
        return snapshot.handle.instance;
      },
    });
    // [并发] 先构造后赋值：构造期的 onPhase 与 onBusyChange 需能与 controller 比较，未赋值视为旧代际。
    // 所有回调捕获 nextController 而非 controller，用来识别「已被替换」的迟到回调。
    // resourceNotifications 按 (scopeId, generation) 登记，旧代际增量不会投给新页面。
    // getToolFeed 每次现读 latest，避免构造后 toolResult 更新却仍下发首帧快照。
    const nextController = createPluginUiHostController({
      bridge,
      sampling: services?.pluginUiSamplingService,
      ...(services?.pluginUiAppToolsService ? { appTools: services.pluginUiAppToolsService } : {}),
      createTransport: createPluginUiMessagePortTransport,
      platform: sandboxPlatform,
      scope,
      presentation,
      // 按代际登记到路由表；该会话的投影 store 收到 pluginUi.* 增量后按 (scopeId, generation) 投递。
      resourceNotifications: createPluginUiResourceNotificationRegistrar(
        scope,
        presentation.serverName,
      ),
      initialHostContext,
      hostVersion: latest.current.hostVersion,
      getToolFeed: () => ({
        ...(latest.current.toolInput ? { toolInput: { arguments: latest.current.toolInput } } : {}),
        ...(latest.current.toolResult ? { toolResult: latest.current.toolResult } : {}),
        ...(latest.current.toolCancelled ? { toolCancelled: true } : {}),
      }),
      // widgetState 初值直接读宿主内存 store（唯一 owner），不经 props 再缓存一份；
      // 端口投递时才读；切换展示位置仍使用同一 guest 与内存状态。
      // [契约] widgetState 的唯一 owner 是宿主内存 store，controller 只在端口投递时读取，不缓存第二份。
      // 切换展示位置复用同一 guest 与同一 store，因此这里必须读 surfaceKey 维度的当前值。
      getWidgetState: () => getPluginUiWidgetState(surfaceKey),
      getHostCapabilities: () =>
        buildPluginUiHostCapabilities({
          canSendFollowUpMessage: Boolean(latest.current.interactions?.onSendFollowUpMessage),
          canUpdateModelContext: Boolean(latest.current.interactions?.onUpdateModelContext),
          canSetWidgetState: true,
          canSample: Boolean(services?.pluginUiSamplingService && getPluginUiSessionActions(scope)),
          canSubscribeResources: true,
          canDownloadFile: Boolean(platformInteractions?.onDownloadFile),
          ...(scope.scope.kind === "surface"
            ? { surfaceId: scope.scope.surfaceId, surfaceStateKey }
            : {}),
        }),
      ...platformInteractions,
      // 经 latest ref 转调，回调 identity 变化不触发 controller 重建；缺省回 -32601（端口层翻译成 ProtocolError）。
      onSendFollowUpMessage: (payload, context) =>
        latest.current.interactions?.onSendFollowUpMessage
          ? latest.current.interactions.onSendFollowUpMessage(payload, context)
          : Promise.reject(Object.assign(new Error("Not supported"), { code: -32601 })),
      onUpdateModelContext: (payload) =>
        latest.current.interactions?.onUpdateModelContext
          ? latest.current.interactions.onUpdateModelContext(payload)
          : Promise.reject(Object.assign(new Error("Not supported"), { code: -32601 })),
      onUpdateWidgetState: async (widgetState) => {
        setPluginUiWidgetState(surfaceKey, widgetState);
      },
      // [契约] phase 是 UI 唯一可见的生命周期信号；本回调把它翻译成 snapshot 与 telemetry。
      // 代际检查放首行：controller 已被替换时，旧桥的 phase 不得再写 snapshot。
      // running 与 error 各只上报一次，用 snapshot.phase 去重，避免重连抖动放大成功与失败计数。
      // error 分支先 suspend 再 patch，保证注册表与 DOM 回收先于 UI 错误呈现。
      onPhase: (next, detail) => {
        // [并发] 这是回调层的代际闸门：controller 一旦被置空或替换，所有迟到回调在此丢弃。
        // 不用 disposed 判断：disposed 表示整页销毁，这里只表示桥已换代，两者归档路径不同。
        if (controller !== nextController) return;
        if (next === "running" && snapshot.phase !== "running") reportUsage("ui_ready");
        if (next === "error" && snapshot.phase !== "error") reportUsage("ui_open_request", true);
        // 生命周期事件每个沙箱只有几条，走 lifecycle 才能进主日志（排查用户现场用）。
        logger.lifecycle.info("[plugin-ui] lifecycle", {
          phase: next,
          sessionId: latest.current.scope.sessionId,
          pluginId: latest.current.presentation.pluginId,
          scopeId: buildPluginSandboxScopeId(latest.current.scope.scope),
          ...(detail?.error ? { error: detail.error } : {}),
        });
        if (next === "error") {
          void page.suspend(true);
          patch({ phase: "error", error: detail?.error ?? "MCP App failed" });
          return;
        }
        setPhase(next);
        if (detail?.handle) {
          setHandle(detail.handle);
          // 资源声明的初始高度替代固定 240；仍受 min / max clamp。
          const hint = detail.handle.resourceMeta?.heightHint;
          if (hint !== undefined) setHeight(clampCardHeight(hint, detail.handle));
          // 资源声明的浏览器权限随句柄到达（早于端口），进 hostContext 让页面 feature detect（规范草案 `permissions`）。
          const permissions = detail.handle.resourceMeta?.permissions;
          if (permissions?.length) {
            nextController.updateHostContext({
              permissions: Object.fromEntries(permissions.map((item) => [item, {}])),
            });
          }
        }
        if (detail?.error) setError(detail.error);
      },
      // [失败路径] 实例被插件侧关闭是终态：清 widgetState、suspend 阻止回收、error 提示用户。
      // 与其他错误分支的差别仅在额外清 widgetState，防止下次同 appIdentity 页面读到已失效快照。
      onInstanceClosed: () => {
        void page.suspend(true);
        clearPluginUiWidgetState(key);
        patch({ phase: "error", error: "MCP App connection is no longer available" });
      },
      onBusyChange: () => {
        if (controller === nextController) pluginUiPages.settled(page);
      },
      onAppCapabilities: setAppCapabilities,
      onHeight: (next) => setHeight(clampCardHeight(next, snapshot.handle)),
      onDisplayModeRequest: (mode) => latest.current.onDisplayModeRequest?.(mode) ?? mode,
      onOpenExternal: (url) => latest.current.onOpenExternal?.(url),
      log: (message, detail) => logger.warn(message, detail),
    });

    controller = nextController;
    reportUsage("ui_open_request");
    controller.start();
  }
  const task = buildPluginUiSessionKey(input.scope);
  const workspaceEvents = services.zcodeTaskService.onDynamicWorkspaceEvent({
    workspacePath: input.scope.workspacePath,
    workspaceIdentity: input.scope.workspaceIdentity,
  })((event) => {
    if (
      event.type === "workspace_task_list_changed" &&
      event.reason === "task_deleted" &&
      event.taskId === input.scope.sessionId
    )
      pluginUiPages.removeTask(task);
  });
  const page: Page = {
    kind: "mcp",
    key,
    task,
    visible: false,
    snapshot: () => snapshot,
    start: () => void ensure(),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    busy: () => controller?.isBusy() ?? false,
    running: () => controller !== null || starting,
    bind(node, sidebar) {
      const off = plane.bind({
        node,
        kind: sidebar ? "sidebar" : "inline",
        container: node.closest<HTMLElement>("[data-sandbox-page-container]") ?? undefined,
      });
      ensure();
      return off;
    },
    // [契约] update 也可能被背景内联锚点调用；enabled === false 表示不抢占当前上下文，直接丢弃。
    // 这里只更新输入与 hostContext，不重建 controller；重建会丢端口、widgetState 与插件内部状态。
    // tool feed 始终转发给 updateToolFeed 由其去重，避免两条更新路径各写一份。
    update(next) {
      // 背景内联锚点不能覆盖侧栏当前的交互上下文。
      if (next.enabled === false) return;
      latest.current = next;
      const nextContextInputs = JSON.stringify([
        next.theme,
        next.locale,
        next.displayMode,
        next.width,
        next.titleBar,
        next.availableDisplayModes,
      ]);
      // [事务] 两级比较：先比输入指纹（字段子集），再比构造出的上下文字符串，避免无意义下发。
      // 只把真正影响 hostContext 的字段纳入指纹；interactions 变化不触发上下文更新。
      // 未变化则完全不下发，插件不会因父组件重渲染而收到重复 hostContext。
      if (nextContextInputs !== contextInputs) {
        contextInputs = nextContextInputs;
        const context = buildPluginUiHostContext({
          theme: next.theme,
          locale: next.locale,
          displayMode: next.displayMode,
          width: next.width,
          titleBar: next.titleBar,
          availableDisplayModes: next.availableDisplayModes,
          styleVariables: readPluginUiStyleVariables(),
        });
        const contextKey = JSON.stringify(context);
        if (contextKey !== lastContext) {
          lastContext = contextKey;
          controller?.updateHostContext(context);
        }
      }
      page.updateToolFeed(next);
    },
    // [事务] 工具结果的乱序与重复由 lastFeed 快照吸收：只有四个字段整体变化才通知。
    // 三个 notify 互斥：input、result、cancelled 各自存在才调用，防止空值覆盖插件已显示的结果。
    // latest 与 lastFeed 同批更新，保证后续 getToolFeed 与已发通知口径一致。
    updateToolFeed(next) {
      if (disposed) return;
      latest.current = {
        ...latest.current,
        toolCallId: next.toolCallId,
        toolInput: next.toolInput,
        toolResult: next.toolResult,
        toolCancelled: next.toolCancelled,
      };
      const feed = JSON.stringify([
        next.toolCallId,
        next.toolInput,
        next.toolResult,
        next.toolCancelled,
      ]);
      if (feed !== lastFeed) {
        lastFeed = feed;
        if (next.toolInput) controller?.notifyToolInput({ arguments: next.toolInput });
        if (next.toolResult) controller?.notifyToolResult(next.toolResult);
        if (next.toolCancelled) controller?.notifyToolCancelled();
      }
    },
    // [资源] suspend 是唯一回收入口；force 表示「允许淘汰」，不是「是否清理」。
    // 非 force 一律拒绝：guest 内存里有编辑器未保存文档，离屏或容量回收会直接丢用户数据。
    // 清理链：清 controller → 停执行标志 → 清 handle 与能力 → prepareUnmount → dispose → unmount → feed 与 lease → 归还名额。
    // prepareUnmount 先于 dispose：Main 导航到 about:blank 会触发 navigation，需先解除旧代际观察以免误报崩溃。
    async suspend(force = false) {
      // 编辑器的未保存文档在 guest 内存中；即使 session 空闲，也不能按离屏期限或容量回收。
      // 管理器沿用 false 拒绝淘汰；删除、重载与来源失效仍显式 force 清理。
      if (!force) return false;
      incarnation++;
      starting = false;
      const previous = controller;
      controller = null;
      plane.setExecutionActive(false);
      executionKey = "";
      const previousHandle = snapshot.handle;
      const offFeed = releaseFeed,
        offLease = releaseLease;
      releaseFeed = undefined;
      releaseLease = undefined;
      patch({ phase: "idle", handle: null, appCapabilities: undefined });
      // 先前释放未完成时不能重新预备；反复重试也只等待同一个释放链。
      // Main 主动导航到 about:blank 会触发 navigation；先解除旧代际观察，避免回收被误报为崩溃。
      if (previousHandle) plane.prepareUnmount(previousHandle.sandboxId);
      if (previous) reportUsage("ui_close");
      const closing = previous?.dispose();
      // [并发] 新链与旧链合并等待，保证同一时刻只有一条清理在跑。
      // then 内才 unmount：dispose 可能异步，提前移除节点会让仍在运行的插件访问已卸载 DOM。
      // pluginUiPages.released 放最后，确保名额归还发生在真实资源释放之后，避免新页抢占旧沙箱。
      releasing = Promise.all([releasing, closing]).then(() => {
        if (previousHandle) plane.unmount(previousHandle.sandboxId);
        offFeed?.();
        offLease?.();
        pluginUiPages.released(page);
      });
      await releasing;
      return true;
    },
    // [资源] destroy 先摘外部监听（visibilitychange、workspace 事件、surface feed），再挂起页面。
    // 摘监听先于 suspend：否则清理期间触发的 visibilitychange 仍会调用 syncExecution 读取已清空 handle。
    // disposed 在 suspend 前置位，使 ensure 与 updateToolFeed 早退，阻断销毁后的重新初始化。
    // plane.dispose 放在 suspend 的 finally：清理失败也必须释放 DOM 与观察者，属于最后兜底。
    destroy() {
      document.removeEventListener("visibilitychange", syncExecution);
      workspaceEvents.dispose();
      clearPluginUiSurfaceFeed(key);
      disposed = true;
      void page.suspend(true).finally(() => plane.dispose());
      clearPluginUiWidgetState(key);
      listeners.clear();
    },
  };
  // [资源] 监听挂在 document 而非节点：窗口最小化时节点不可见但 document.hidden 为真，两者缺一不可。
  // 这是 createPage 唯一的外部注册，destroy 中必须成对移除，否则页面销毁后仍被闭包引用。
  document.addEventListener("visibilitychange", syncExecution);
  return page;
}

/** 卡片高度 clamp：下限取资源 `minFrameHeight` 与宿主最小值的较大者，上限固定。 */
function clampCardHeight(next: number, handle: PluginSandboxHandle | null): number {
  const min = Math.max(PLUGIN_UI_CARD_MIN_HEIGHT_PX, handle?.resourceMeta?.minFrameHeight ?? 0);
  return Math.min(PLUGIN_UI_CARD_MAX_HEIGHT_PX, Math.max(min, next));
}
