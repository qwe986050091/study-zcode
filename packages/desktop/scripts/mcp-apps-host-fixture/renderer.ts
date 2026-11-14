// INV-01 页面生命周期以 manager 为唯一权威；守住位置：manager 的 add、reserve、visibility、released 调用；改错故障：重复挂载让两个 webview 并存，用例读数翻倍。
// INV-02 握手完成只由 running 相位确认；守住位置：onPhase 的 running 分支与 ready 兑现；改错故障：start 提前返回，用例对未启动的 controller 断言。
// INV-03 端口处理器在任一时刻只有一个；守住位置：onPorts 的赋值与注销闭包的身份比对；改错故障：重挂载后消息仍投递给旧处理器。
// INV-04 文本消息入口只转发带单个端口的定制消息；守住位置：message 监听的前置判断；改错故障：无关消息误触发端口握手，链路提前进入运行态。
// INV-05 监听器账本只统计当前仍注册的监听器；守住位置：tracked 的写入与删除；改错故障：泄漏读数失真，回归用例漏报。
// INV-06 承载层切换必须先建立新绑定再解绑旧绑定；守住位置：switchPage 中 previous 的调用位置；改错故障：两个节点同时收到渲染事件。
// INV-07 回收必须经 tryRecycle 同意后才释放；守住位置：suspend 的早返回分支；改错故障：忙碌页面被强拆，用户输入丢失。
// INV-08 回收成功后必须解挂 plane 并交还名额；守住位置：suspend 尾部三步；改错故障：残留 webview 占住内存与端口。
// INV-09 五分钟保留期限是唯一合法的回收触发；守住位置：manager 的定时器工厂与 300000 校验；改错故障：期限漂移让回收用例空跑。
// INV-10 回收完成信号由临时包装的 suspend 捕获；守住位置：recyclePage 的替换与还原；改错故障：包装未还原，后续回收永久失效。
// INV-11 恢复的重试分支先清 widget 状态再交还名额；守住位置：restorePage 的 retry 判断；改错故障：旧状态串入新会话，断言拿到过期值。
// INV-12 每次恢复都要重建 ready 并重新 start；守住位置：restorePage 的重新赋值与启动调用；改错故障：第二次恢复等待已兑现的旧 promise，握手被跳过。
// INV-13 释放顺序固定为 controller、plane、manager；守住位置：disposePage 的三步；改错故障：顺序颠倒后解挂到已销毁的实例，抛错中断用例。
// INV-14 widget 状态只经 store 读写；守住位置：getWidgetState 与 onUpdateWidgetState；改错故障：状态写到页面对象上，读取方看不到更新。
// INV-15 崩溃必须冒泡为可见错误；守住位置：plane 的 onCrash 抛出；改错故障：崩溃被吞掉，用例误判为正常流程。
// INV-16 tool feed 投递保持先输入后结果；守住位置：deliverFeed 的两次通知顺序；改错故障：宿主收到结果却找不到对应输入。
// INV-17 inline 与 sidebar 两个挂载点在模块加载时一次取定；守住位置：inline 与 sidebar 的取值与非空断言；改错故障：页面结构改名后绑定阶段抛错，用例无从定位。
// INV-18 缺少配置时回落到固定的 scope 与 presentation；守住位置：start 中的空值合并；改错故障：未提供配置的用例拿到空身份，挂载被拒。
//
// 模块职责：在桌面渲染进程中复现 MCP apps 的 UI 承载链路，供端到端用例驱动挂载、切换、回收与恢复。
// 状态所有权：host controller、页面 plane 与 page manager 各持一份模块级引用，生命周期以 manager 为准，握手完成以 ready 为准。
// 阅读顺序：先看全局接线与消息出口，再看 start 的初始化顺序，最后看切换、回收、恢复与释放的清理路径。
import {
  createPluginUiHostController,
  type PluginUiHostController,
} from "../../../ui/src/plugin-ui/app/pluginUiHostController.js";
import { PluginUiPageManager } from "../../../ui/src/plugin-ui/app/pluginUiPageManager.js";
import {
  getPluginUiWidgetState,
  setPluginUiWidgetState,
  clearPluginUiWidgetState,
} from "../../../ui/src/plugin-ui/app/pluginUiWidgetStateStore.js";
import type { PluginSandboxHandle, PluginSandboxPortsEvent } from "@zcode/shared/mcp-apps";
import { createPluginUiMessagePortTransport } from "../../../ui/src/plugin-ui/adapters/messagePortTransport.js";
import { createPluginUiPagePlane } from "../../../ui/src/plugin-ui/adapters/pluginUiPagePlane.js";
// [契约] harness 是预加载脚本注入的测试桥，config、handle、bridge、owner、dispose 构成唯一外部依赖面。
// [权衡] 夹具直接读取 window 上的 harness，不另建抽象层，避免测试壳与生产代码出现第二套调用约定。
const harness = (window as any).harness;
// 记录生产承载层的活动 window 监听器，重复切换后必须保持恒定。
// [资源] tracked 按事件类型登记活动监听器，switchPage 用它汇总监听器总数。
// [失败路径] 只统计经过被替换入口的注册，绕过该入口的监听不会记账，读数会偏低。
const tracked = new Map<string, Set<EventListenerOrEventListenerObject>>();
const add = window.addEventListener.bind(window),
  remove = window.removeEventListener.bind(window);
(window as any).addEventListener = (
  type: string,
  listener: EventListenerOrEventListenerObject,
  options: any,
) => {
  const entries = tracked.get(type) ?? new Set();
  entries.add(listener);
  tracked.set(type, entries);
  add(type, listener, options);
};
(window as any).removeEventListener = (
  type: string,
  listener: EventListenerOrEventListenerObject,
  options: any,
) => {
  tracked.get(type)?.delete(listener);
  remove(type, listener, options);
};
// [状态所有权] controller、handshakes、handle、portHandler 四个模块级变量都由 start 重写，本文件因此持有单例状态。
// [并发] 恢复流程会再次进入 start，旧 controller 必须先随 suspend 释放，否则同一页面存在两个宿主实例。
let controller: PluginUiHostController;
let handshakes = 0;
let handle: PluginSandboxHandle;
let portHandler: ((event: PluginSandboxPortsEvent) => void) | undefined;
// [契约] ready 是握手信号，running 相位兑现，error 相位拒绝，start 只等待这一个 promise。
// [失败路径] 恢复前必须重建 ready，复用已兑现的旧 promise 会让第二次启动直接通过。
let ready = Promise.withResolvers<void>();
(window as any).harnessReady = ready.promise;
// [事件分发] 端口消息经 window 的 message 事件进入，再转交给 controller 注册的处理器。
// [失败路径] 处理器尚未注册时消息被静默丢弃且不缓存，重挂载窗口期到达的端口就此消失。
window.addEventListener("message", (event) => {
  if (event.data?.type !== "zcode:plugin-sandbox-ports" || event.ports.length !== 1) return;
  // [契约] 转发时保留原始消息字段并补上 port，拼成 PluginSandboxPortsEvent 的形状。
  // [并发] 端口对象只应交付一次，重复投递会让宿主持有两个 transport。
  portHandler?.({ ...event.data, port: event.ports[0] });
});
// [职责] plane 负责把宿主页面渲染进指定节点，绑定与解挂必须成对出现。
// [权衡] 可见性回调留空，因为夹具只关心绑定节点与实例数量，不关心过渡动画。
const plane = createPluginUiPagePlane({
  onVisibility() {},
  onCrash() {
    // [失败路径] onCrash 主动抛出，让崩溃在用例里表现为可捕获的错误而非静默降级。
    // [契约] 该分支只在 plane 报告崩溃时进入，主动释放与正常解挂不会触发。
    throw new Error("fixture crashed");
  },
});
const inline = document.getElementById("inline")!;
const sidebar = document.getElementById("sidebar")!;
(window as any).previewPage = async (enabled: boolean) => {
  plane.preview(enabled ? sidebar : null);
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
};
let off: (() => void) | undefined;
// [资源] deadlines 收集 manager 注册的到期回调，recyclePage 借此提前触发五分钟规则。
// [失败路径] 每次触发后清空集合，防止同一回调重复执行造成二次回收。
const deadlines = new Set<() => void>();
let disposal = Promise.resolve();
const page = {
  key: "fixture",
  task: "fixture",
  visible: true,
  busy: () => controller?.isBusy() ?? false,
  running: () => Boolean(controller && controller.phase !== "disposed"),
  // [顺序] suspend 先请求 tryRecycle，成功后释放 controller，再解挂 plane 并通知 manager。
  // [权衡] 未获准回收时返回 false，把是否继续交给 manager 判断，页面保持运行。
  async suspend() {
    if (!(await controller.tryRecycle())) return false;
    disposal = controller.dispose();
    await disposal;
    plane.unmount(handle.sandboxId);
    manager.released(page);
    return true;
  },
  // [清理] destroy 走兜底释放：不等待 dispose 完成，同时卸载 plane 并清空 widget 状态。
  // [权衡] 这里不 await 是因为 manager 的销毁回调不返回 promise，异常只能由下游自行暴露。
  destroy() {
    void controller.dispose();
    plane.dispose();
    clearPluginUiWidgetState("fixture");
  },
};
// [契约] 构造入参的定时器工厂是夹具对保留期限的唯一拦截面，非 300000 毫秒直接报错。
// [失败路径] 该工厂返回的清理函数负责把回调移出 deadlines，防止集合无限增长。
const manager = new PluginUiPageManager<typeof page>(
  (run, ms) => {
    if (ms !== 300_000) throw new Error("unexpected retention deadline");
    deadlines.add(run);
    return () => {
      deadlines.delete(run);
    };
  },
  () => {},
);
async function start() {
  await manager.reserve(page);
  // [契约] 配置存在时走真实 bridge 代理，缺失时退化为本地桩，两条路径共用同一 controller 接口。
  // [权衡] 桩把 prepareSandbox 直接接到 harness.handle，跳过校验与关闭，换来可离线启动。
  const config = await harness.config();
  controller = createPluginUiHostController({
    bridge: config
      ? (new Proxy(
          {},
          { get: (_, method) => (params: unknown) => harness.bridge(method, params) },
        ) as any)
      : ({
          prepareSandbox: () => harness.handle(),
          validateInstance: async () => {},
          closeInstance: async () => {},
          recycleInstance: async () => true,
        } as any),
    platform: {
      getOwnerWebContentsId: () => harness.owner(),
      disposeSandbox: (id, init) => harness.dispose(id, init),
      consumeUserGesture: async () => false,
      // [状态所有权] onPorts 把平台侧处理器写进 portHandler，并返回注销闭包。
      // [失败路径] 注销时比对身份，只有当前处理器才置空，旧闭包不会误清新处理器。
      onPorts(handler) {
        portHandler = handler;
        return () => {
          if (portHandler === handler) portHandler = undefined;
        };
      },
    },
    scope: config?.scope ?? {
      workspacePath: "/fixture",
      sessionId: "fixture",
      scope: { kind: "surface", surfaceId: "fixture" },
    },
    presentation: config?.presentation ?? {
      pluginId: "fixture",
      serverName: "fixture",
      resourceUri: "ui://fixture",
    },
    createTransport: createPluginUiMessagePortTransport,
    initialHostContext: { displayMode: "inline" },
    hostVersion: "fixture",
    getToolFeed: () => ({}),
    getWidgetState: () => getPluginUiWidgetState("fixture"),
    getHostCapabilities: () => ({
      serverTools: {},
      serverResources: {},
      experimental: { "zcode/widgetState": {} },
    }),
    onUpdateWidgetState: async (value) => {
      setPluginUiWidgetState("fixture", value);
    },
    // [生命周期] mounted 相位取出 sandbox 句柄交给 plane 挂载，这是唯一给 handle 赋值的位置。
    // [并发] running 相位累加 handshakes 并兑现 ready，重复进入会让计数虚高。
    // [失败路径] error 相位用 detail 里的错误拒绝 ready，让 start 的等待立即失败。
    // [契约] 其它相位不改变状态，避免中间态干扰断言。
    onPhase(phase, detail) {
      if (phase === "mounted") {
        handle = detail!.handle!;
        plane.mount(handle);
      }
      if (phase === "running") {
        handshakes++;
        ready.resolve();
      }
      if (phase === "error") ready.reject(new Error(detail?.error));
    },
    onHeight() {},
    onOpenExternal() {},
    onDisplayModeRequest: (mode) => mode,
  });
  controller.start();
  // [顺序] start 在 controller 启动后阻塞到握手完成，返回即代表页面可交互。
  // [失败路径] 握手被拒时异常沿 await 上抛到 manager 的启动链，不会被吞成静默成功。
  await ready.promise;
}
off = plane.bind({ node: inline, kind: "inline" });
void manager.add(page).then(start);
// [顺序] switchPage 先绑定新节点，随后调用旧解绑闭包，最后更新 host 上下文并等待两帧。
// [并发] 返回的 views 与 listeners 是切换后的即时读数，用于断言没有多出 webview 或监听器。
(window as any).switchPage = async (side: boolean) => {
  const started = performance.now();
  const previous = off;
  off = plane.bind({ node: side ? sidebar : inline, kind: side ? "sidebar" : "inline" });
  previous?.();
  controller.updateHostContext({ displayMode: side ? "fullscreen" : "inline" });
  const dispatchMs = performance.now() - started;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  return {
    handshakes,
    views: document.querySelectorAll("webview").length,
    // [资源] 该读数把所有事件类型的登记条目求和，作为切换前后监听器是否恒定的判据。
    // [失败路径] 任何未注销的监听都会让数字单调上升，用例据此定位承载层泄漏。
    listeners: [...tracked.values()].reduce((sum, items) => sum + items.size, 0),
    dispatchMs,
  };
};
// [顺序] recyclePage 先解绑页面并置为不可见，再临时包装 suspend 以捕获回收完成信号。
// [权衡] 包装只为拿到完成时机，回收结束后立即还原原 suspend，避免污染后续调用。
// [失败路径] 若没有任何期限回调，完成信号永不兑现，用例在超时处暴露 manager 未注册定时器。
(window as any).recyclePage = async () => {
  off?.();
  off = undefined;
  manager.visibility(page, false);
  // 可控期限触发生产 manager 的五分钟回收规则，不依赖实际等待五分钟。
  const completed = Promise.withResolvers<void>();
  const suspend = page.suspend;
  page.suspend = async () => {
    const result = await suspend();
    completed.resolve();
    return result;
  };
  for (const deadline of deadlines) deadline();
  deadlines.clear();
  await completed.promise;
  page.suspend = suspend;
  return {
    views: document.querySelectorAll("webview").length,
    state: getPluginUiWidgetState("fixture"),
  };
};
// [顺序] 重试分支先清 widget 状态并再执行一次 suspend，然后重建 ready、重新绑定并调用 start。
// [失败路径] 非重试分支假定页面已回收，若仍持有 controller 会与 start 的新实例冲突。
(window as any).restorePage = async (retry: boolean) => {
  if (retry) {
    clearPluginUiWidgetState("fixture");
    await page.suspend();
  }
  ready = Promise.withResolvers<void>();
  off = plane.bind({ node: inline, kind: "inline" });
  manager.visibility(page, true);
  await start();
  return { handshakes };
};
// [清理] disposePage 依次释放 controller、解挂 plane、通知 manager，是收尾的唯一入口。
// [资源] 释放不重置 handshakes，用例可在关闭后继续断言历史握手次数。
(window as any).disposePage = async () => {
  await controller.dispose();
  plane.unmount(handle.sandboxId);
  manager.released(page);
};
(window as any).currentHandle = () => handle;
(window as any).pageBusy = () => controller.isBusy();
(window as any).savedWidget = () => getPluginUiWidgetState("fixture");
(window as any).deliverFeed = (n: number) => {
  controller.notifyToolInput({ arguments: { sequence: n } });
  controller.notifyToolResult({ content: [], structuredContent: { sequence: n } });
};
