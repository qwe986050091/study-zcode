// 职责边界：mcp-apps 宿主夹具的受管页面渲染器，只在 Electron 测试窗口内运行，不进入产品构建产物。
// 它把 harness 注入的 fixture 配置翻译成 usePluginUiHost 入参，同时模拟 inline 卡片与 side pane 两种挂载形态。
// Agent、任务服务与沙箱平台全部由内存桩替代，因此这里任何看起来可用的返回值都不是生产事实。
// 唯一的外部输入是 harness.config()，夹具专属字段（mode、sequence、fixture-remote）不得回流到生产判断。
// 驱动方式是 window 上挂的调试函数，由夹具脚本按顺序调用，同一时刻只允许存在一个受管页面。
//
// 不变量表（改动其中任何一条，都必须同步更正本表与下方对应位置）：
// INV-01 断言：入向消息只有 window 的 message 一条通道，未经 type 白名单的消息一律丢弃 —— 守住它的位置：message 监听器 —— 改错故障：任意页面都能伪造相位与工具结果，夹具结论失去意义。
// INV-02 断言：ready 与 paused 一次性解析，只能成功或失败各一次 —— 守住它的位置：两个解析器的声明与 Anchor 的相位分支 —— 改错故障：重复解析会掩盖首个失败，测试在错误页面上继续跑。
// INV-03 断言：每个通道订阅必须返回可释放的句柄，释放时通知等待者 —— 守住它的位置：subscribe 工厂 —— 改错故障：泄漏的监听让连接释放等待永不返回。
// INV-04 断言：fixture-notification 的 kind 与 value 原样转发，不在渲染器里重新解释 —— 守住它的位置：监听器里的 emit 调用 —— 改错故障：夹具事件语义被改写，产品侧真实订阅者的行为被掩盖。
// INV-05 断言：服务桩只暴露夹具真正用到的方法，未实现的能力不进对象字面量 —— 守住它的位置：agent 与 services 定义 —— 改错故障：多出来的方法让宿主未接该能力的断言失效。
// INV-06 断言：current 只保存最后一次启用锚点的宿主结果 —— 守住它的位置：Anchor 里的启用分支 —— 改错故障：被禁用锚点覆盖 current，查询读到旧页面。
// INV-07 断言：假计时器只拦五分钟这一档延迟，其余时长必须落回真实计时器 —— 守住它的位置：window.setTimeout 替换 —— 改错故障：握手等待被冻结，测试永久挂起。
// INV-08 断言：假计时器 id 与浏览器 id 的空间必须分开 —— 守住它的位置：负数编号与假 id 表 —— 改错故障：负数传入真实清理函数会误清别的定时器。
// INV-09 断言：过期只处理仍登记在期限集合里的回调，触发后立刻清表 —— 守住它的位置：expireOffscreen —— 改错故障：保活回调被重复触发，页面生命周期被推进两次。
// INV-10 断言：冷启动模式必须返回空，不能渲染任何元素 —— 守住它的位置：Anchor 里的提前返回 —— 改错故障：冷启动用例测到的是热启动行为，结论整体失真。
// INV-11 断言：订阅、监听、会话动作注册三类句柄必须成对释放 —— 守住它的位置：effect 清理与采样开关 —— 改错故障：卸载后仍推送事件，用例之间互相污染。
// INV-12 断言：准入模式只保留生产窗口接收器，不挂锚点也不建会话租约 —— 守住它的位置：模式分支 —— 改错故障：额外挂载让无租约仍能收结果的前提不成立。
// INV-13 断言：夹具参数只读，绝不写回生产配置对象 —— 守住它的位置：config 的全部消费点 —— 改错故障：后续断言拿到被污染入参。
// INV-14 断言：渲染入口只执行一次根节点创建，分支只决定挂哪套组件 —— 守住它的位置：文件末尾的提交 —— 改错故障：残留第二棵树，查询到的 DOM 与断言对象不是同一个。
//
// 阅读顺序：先看两个跨进程闸门，再看 Anchor 的挂载与卸载，最后看 window 上的驱动函数。
import { attachPluginUiToolResults } from "../../../ui/src/plugin-ui/adapters/pluginUiBackground.js";
import { buildPluginUiSurfaceKey } from "../../../ui/src/plugin-ui/contract.js";
import { subscribePage } from "../../../ui/src/plugin-ui/adapters/pluginUiPageRegistry.js";
import { registerPluginUiSessionActions } from "../../../ui/src/plugin-ui/adapters/pluginUiSessionActions.js";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ServiceProvider } from "../../../ui/src/hooks/useServices.js";
import { PlatformProvider } from "../../../ui/src/hooks/usePlatform.js";
import { usePluginUiHost } from "../../../ui/src/plugin-ui/adapters/usePluginUiHost.js";
import { PluginUiCard } from "../../../ui/src/plugin-ui/components/PluginUiCard.js";
import { PluginUiSidePaneView } from "../../../ui/src/plugin-ui/components/PluginUiSidePane.js";
import { pluginUiPages } from "../../../ui/src/plugin-ui/adapters/pluginUiPageRegistry.js";
import { getPluginUiWidgetState } from "../../../ui/src/plugin-ui/app/pluginUiWidgetStateStore.js";
import { RowsFixture } from "./rows-renderer.js";
import type {
  UsePluginUiHostInput,
  UsePluginUiHostResult,
} from "../../../ui/src/plugin-ui/adapters/pluginUiHostTypes.js";
// [契约] harness 由外层脚本在页面脚本之前注入，这里只取引用，不做存在性兜底。
// [失败路径] harness 缺席说明启动顺序被改坏，此时应让首个 await 直接抛错，而不是渲染空页面。
// 把桩挂到 window 上而不是模块导出，是为了让夹具脚本在导航后仍能拿到同一个入口。
// 这里读到的引用在整轮测试里保持不变，任何判断都不应假设它会被替换。
const harness = (window as any).harness;
// [并发] ready 是跨进程握手闸门，父进程等它确定页面是否成功挂载。
// [契约] 它只能被解析一次，所以 Anchor 里成功与失败的分支必须互斥。
// [失败路径] 握手期间抛出的异常同样要走失败分支，否则父进程只能靠超时判定。
// 这里不额外包一层超时：判定失败的时机属于夹具脚本，不属于渲染器。
const ready = Promise.withResolvers<void>();
(window as any).harnessReady = ready.promise;
// [并发] 第二个闸门专供最小化模式，与握手闸门分开，避免暂停被误当成挂载完成。
const paused = Promise.withResolvers<void>();
(window as any).fixturePaused = paused.promise;
// [资源] drained 记录通道清空后该通知谁的回调，生命周期与订阅一一对应。
// [权衡] 用集合而非计数，是因为同一个等待者可能被重复登记，重复回调会造成多次解析。
// 集合本身不持有订阅，只是等待者的登记簿，清空时机由取消订阅那一刻决定。
const drained = new Set<() => void>();
const channels = new Map<string, Set<(value: any) => void>>();
// [契约] emit 只做扇出，不解释事件含义，也不缓存最后一次值。
// [并发] 遍历时对集合取快照，避免回调内部退订导致遍历跳过元素。
// [失败路径] 订阅者抛出的异常会向上冒泡，这里刻意不吞，夹具需要看到真实崩溃。
const emit = (name: string, value: unknown) => {
  for (const handler of channels.get(name) ?? []) handler(value);
};
const subscribe = (name: string, handler: (value: any) => void) => {
  const set = channels.get(name) ?? new Set();
  channels.set(name, set);
  set.add(handler);
  return {
    dispose: () => {
      set.delete(handler);
      for (const notify of drained) notify();
    },
  };
};
// [契约] 入向消息统一从 window 的 message 事件进入，这是夹具与页面之间唯一的接收口。
// [契约] 只认 fixture-notification 与 zcode:plugin-sandbox-ports 两种类型，其余消息静默丢弃。
// [并发] 端口消息先把 MessagePort 从事件里取出再展开，避免把不可枚举字段丢掉。
// [失败路径] 没有类型标记的消息不报错也不转发，防止把调试工具注入的其他消息当成夹具指令。
// 这里不校验消息来源，因为夹具页面本身是受控环境；来源校验属于生产宿主，不能照搬到这里。
window.addEventListener("message", (event) => {
  if (event.data?.type === "fixture-notification")
    emit(event.data.payload.kind, event.data.payload.value);
  if (event.data?.type === "zcode:plugin-sandbox-ports")
    emit("ports", { ...event.data, port: event.ports[0] });
});
// [权衡] pluginUiBridgeService 与另两个桥接服务共用 proxy 工厂，靠方法名在调用时动态转发。
// 这样夹具不必为每个新方法补一行桩，代价是方法名拼错只会在调用时暴露。
// [契约] 代理只包一层转发，不缓存返回值，也不改变拒绝语义。
const proxy = (send: (method: string, p: unknown) => Promise<unknown>) =>
  new Proxy({}, { get: (_, method) => (p: unknown) => send(String(method), p) });
// [契约] agent 桩只实现五类会话方法与五类订阅方法，多一个都不给。
// [契约] 订阅方法都返回退订句柄，句柄内部只删除自己那一条监听。
// [失败路径] 会话方法直接透传给 harness，方法名由调用方传入，拼错时由 harness 侧报错。
// [权衡] 批量生成而不是逐条书写，是为了新增方法时只需改名字数组。
const agent = {
  ...Object.fromEntries(
    [
      "helloConversationV4",
      "initializeConversationV4",
      "subscribeConversationV4",
      "unsubscribeConversationV4",
      "resyncConversationV4",
    ].map((method) => [method, (p: unknown) => harness.v4(method, p)]),
  ),
  onDynamicPluginUiToolResult: () => (handler: any) => subscribe("ui-result", handler),
  onDynamicConversationFrame: () => (handler: any) => subscribe("frame", handler),
  onDynamicLocalTtftFacts: () => (handler: any) => subscribe("ttft", handler),
  onAgentRuntimeRestarted: (handler: any) => subscribe("restart", handler),
  onAgentRuntimeLifecycle: (handler: any) => subscribe("lifecycle", handler),
};
// [契约] 服务键名必须与生产注入的键名完全一致，否则 hooks 里的取用会落到空值。
// [权衡] 这里用断言绕过类型，代价是拼错键名没有编译期报错，只能靠运行时冒烟发现。
// [资源] 每个服务都只持有通道引用，不自行创建定时器或连接，卸载时无需额外清理。
const services = {
  zcodeAgentService: agent,
  zcodeTaskService: { onDynamicWorkspaceEvent: () => (handler: any) => subscribe("task", handler) },
  pluginUiBridgeService: proxy(harness.bridge),
  pluginUiSamplingService: proxy(harness.bridge),
  pluginUiAppToolsService: proxy(harness.appTools),
};
// [契约] 沙箱字段是唯一被刻意做成可替换的成员，用于模拟宿主不支持沙箱。
// [资源] 释放与取所有者两个方法直接落到 harness，渲染器不复制任何沙箱状态。
// [并发] 消费用户手势恒返回否，保证夹具里不会误触发需要手势的路径。
// [资源] 端口订阅把句柄包成返回函数的退订形式，与产品侧接口签名保持一致。
const platform = {
  pluginSandbox: {
    setExecutionActive: window.zcodePluginSandbox?.setExecutionActive,
    getOwnerWebContentsId: () => harness.owner(),
    disposeSandbox: (id: string, init: number) => harness.dispose(id, init),
    consumeUserGesture: async () => false,
    onPorts(handler: any) {
      const listener = subscribe("ports", handler);
      return () => listener.dispose();
    },
  },
};
// [契约] current 是最后一次启用锚点的宿主结果快照，外部驱动函数全部依赖它。
// [并发] 只有启用为真的锚点才能写入，被禁用的锚点连渲染都不该发生。
// [失败路径] 首次启用的锚点卸载后 current 仍指向旧结果，这是刻意保留：查询需要看到最后状态。
let current: UsePluginUiHostResult;
let renderState: (next: {
  inline: boolean;
  sidebar: boolean;
  sequence?: number;
  remote?: boolean;
}) => void;
let config: any;
// [契约] phases 只追加不重排，用来断言相位变化序列而不是终态。
// [资源] 它随模块生命周期存在，不随组件卸载清空，避免丢掉早期相位记录。
const phases: string[] = [];
const deadlines = new Set<() => void>();
// [契约] 先保存真实计时器的绑定版本，后面对 window 的替换才可逆。
// [失败路径] 若直接引用 window.setTimeout，替换之后再调用会落到假实现上，形成自递归。
// [权衡] realSetTimeout 与 realClearTimeout 用同一条 const 声明绑定，让替换与还原始终成对出现。
const realSetTimeout = window.setTimeout.bind(window),
  realClearTimeout = window.clearTimeout.bind(window);
const fakeIds = new Map<number, () => void>();
let nextTimer = -1;
// 只控制产品的五分钟保活期限；握手、teardown、v4 keep-warm 仍用真实完成事件/时钟。
// [契约] window.setTimeout 只拦截 300_000 这一档延迟，其余时长原样交给 realSetTimeout。
// [并发] 假 id 从负一递减，确保与浏览器分配的整数 id 不可能相撞。
// [失败路径] 被拦截的回调不进事件循环，只能由驱动函数显式触发，测试因此掌握推进权。
window.setTimeout = ((run: () => void, ms: number, ...args: any[]) => {
  if (ms !== 300_000) return realSetTimeout(run, ms, ...args);
  const id = nextTimer--;
  deadlines.add(run);
  fakeIds.set(id, run);
  return id;
}) as typeof window.setTimeout;
// [契约] clearTimeout 先查 fakeIds 表，命中则只撤 deadlines 登记，不触碰 realClearTimeout。
// [失败路径] 命中后必须同时从期限集合与假 id 表删除，漏掉任一处都会留下过期回调。
// [权衡] 未命中时无条件转给真实清理函数，保证非拦截的定时器仍能正常取消。
window.clearTimeout = ((id: number) => {
  const run = fakeIds.get(id);
  if (run) {
    deadlines.delete(run);
    fakeIds.delete(id);
  } else realClearTimeout(id);
}) as typeof window.clearTimeout;

// [契约] Anchor 是夹具里唯一真正调用宿主 hook 的组件，宿主入参全部在这里组装。
// [契约] 入参里的工具输入与工具结果必须同时存在或同时缺席，用 sequence 作为唯一开关。
// [并发] 只保留最后启用的一次宿主结果供外部读取，避免多锚点互相覆盖。
// [资源] 相位变化通过 effect 上报给 harness，并且只在启用期间生效。
// [失败路径] 页面进入错误相位时必须让握手闸门失败，而不是继续等待。
function Anchor({
  side,
  enabled,
  sequence,
  remote,
  visible = true,
}: {
  side: boolean;
  enabled: boolean;
  sequence?: number;
  remote?: boolean;
  visible?: boolean;
}) {
  // [契约] 入参以 harness 下发的配置为底，夹具只覆盖挂载形态相关字段。
  // [契约] 远端标志为真时注入固定的会话标识，用于区分远端与本地会话。
  // [失败路径] 主题、语言、宽度缺省时给固定兜底值，防止未配置模式渲染出不确定布局。
  const input: UsePluginUiHostInput = {
    ...config,
    scope: { ...config.scope, ...(remote ? { remoteSessionId: "fixture-remote" } : {}) },
    theme: config.theme ?? "light",
    locale: config.locale ?? "en",
    displayMode: side ? "fullscreen" : "inline",
    width: config.width ?? 400,
    hostVersion: "managed-fixture",
    toolInput: sequence === undefined ? undefined : { sequence },
    toolResult:
      sequence === undefined ? undefined : { content: [], structuredContent: { sequence } },
    toolCallId: `feed-${sequence}`,
    enabled,
  };
  const host = usePluginUiHost(input);
  if (enabled) current = host;
  // [资源] 该 effect 没有清理函数，因为它只做上报，不注册任何长期监听。
  // [契约] 相位与页面键同时作为依赖，页面切换但相位相同时也要重新上报。
  // [并发] 启用状态翻转时 effect 会重跑，禁用后不再产生任何上报。
  // [失败路径] 运行中与不支持都算握手成功，只有错误才算失败，这个顺序不能反。
  // [权衡] 把判定写在 effect 里而不是渲染期，是为了让父进程看到提交后的真实相位。
  useEffect(() => {
    if (!enabled) return;
    phases.push(host.phase);
    void harness.event({ type: "phase", phase: host.phase, key: host.pageKey });
    if (host.phase === "running" || !host.supported) ready.resolve();
    if (host.phase === "error") ready.reject(new Error(host.error ?? "managed page failed"));
  }, [host.phase, host.pageKey, enabled]);
  // [契约] 冷启动模式只允许返回空，宿主连挂载都不该发生。
  // [失败路径] 一旦这里渲染了元素，冷启动用例测到的就是热启动行为。
  // [权衡] 判定放在 hooks 之后而不是组件入口，是为了让宿主状态照常推进，只掐断可视输出。
  if (config.mode.startsWith("background-cold")) return null;
  return side ? (
    <PluginUiSidePaneView
      visible={visible}
      scopeRef={config.scope.scope}
      host={host}
      loadingLabel="loading"
      errorLabel="failed"
      retryLabel="retry"
    />
  ) : (
    <PluginUiCard
      {...host}
      prefersBorder={false}
      loadingLabel="loading"
      errorLabel="failed"
      retryLabel="retry"
      onRetry={host.reload}
    />
  );
}
// [契约] Fixture 只负责布局与本地开关，不参与宿主协议，也不读写配置以外的外部状态。
// [契约] 内联与侧栏两个锚点互斥启用，切换顺序由驱动函数决定。
// [失败路径] 若两个锚点同时启用，current 会被后渲染者覆盖，查询结果随即漂移。
function Fixture() {
  // [契约] 本地状态只描述可见性，不复制宿主相位，混放会让断言无法区分来源。
  // [契约] useState 的初始值完全由 config.mode 推导，运行期只允许 renderState 驱动修改。
  // [失败路径] 序号默认无值，表示还没有任何工具结果，不能写成零这类哨兵值。
  const [state, setState] = useState({
    inline: config.mode !== "background-hidden" && !config.mode.startsWith("background-admission"),
    sidebar: config.mode === "background-hidden",
    sidebarVisible: true,
    sidebarActive: true,
    chatVisible: true,
    workspaceVisible: true,
    sequence: undefined as number | undefined,
    remote: config.mode === "remote",
  });
  renderState = (next) => setState((previous) => ({ ...previous, ...next }));
  return (
    <ServiceProvider services={services as never}>
      <PlatformProvider platform={platform as never}>
        <div
          id="inline-scroll"
          style={{
            position: "absolute",
            left: 20,
            top: 20,
            width: config.width ?? 400,
            height: 350,
            overflow: "auto",
          }}
        >
          <div data-sandbox-page-container="true" style={{ position: "relative" }}>
            <div id="inline-anchor">
              {state.inline && (
                <Anchor
                  side={false}
                  enabled={!state.sidebar}
                  sequence={state.sequence}
                  remote={state.remote}
                />
              )}
            </div>
            <div style={{ height: 1400 }} />
          </div>
        </div>
        <div
          id="sidebar-anchor"
          aria-hidden={!state.sidebarVisible || !state.chatVisible || !state.workspaceVisible}
          style={{
            position: "absolute",
            left: 500,
            top: 20,
            width: state.sidebarVisible ? 450 : 0,
            height: 600,
            display: config.mode === "background-hidden" ? "none" : undefined,
            overflow: "hidden",
            opacity: state.sidebarVisible && state.chatVisible && state.workspaceVisible ? 1 : 0,
            pointerEvents:
              state.sidebarVisible && state.chatVisible && state.workspaceVisible
                ? undefined
                : "none",
          }}
        >
          {/* 复现应用收起时锁宽、切标签时 forceMount 的真实布局；锚点一直连接。 */}
          <div style={{ width: 450, height: 600, display: state.sidebarActive ? "block" : "none" }}>
            {state.sidebar && (
              <Anchor
                side
                enabled
                visible={
                  state.sidebarVisible &&
                  state.sidebarActive &&
                  state.chatVisible &&
                  state.workspaceVisible
                }
                sequence={state.sequence}
                remote={state.remote}
              />
            )}
          </div>
        </div>
        <div style={{ position: "absolute", left: 500, top: 650 }}>
          <button
            id="toggle-sidebar"
            onClick={() =>
              setState((previous) => ({ ...previous, sidebarVisible: !previous.sidebarVisible }))
            }
          >
            Toggle sidebar
          </button>
          <button
            id="switch-sidebar-tab"
            onClick={() =>
              setState((previous) => ({ ...previous, sidebarActive: !previous.sidebarActive }))
            }
          >
            Switch tab
          </button>
          <button
            id="switch-main-page"
            onClick={() =>
              setState((previous) => ({ ...previous, chatVisible: !previous.chatVisible }))
            }
          >
            Switch page
          </button>
          <button
            id="switch-workspace"
            onClick={() =>
              setState((previous) => ({
                ...previous,
                workspaceVisible: !previous.workspaceVisible,
              }))
            }
          >
            Switch workspace
          </button>
        </div>
      </PlatformProvider>
    </ServiceProvider>
  );
}
// [契约] 布局等待两帧，确保同步提交之后的 DOM 变更已经真正落到绘制。
// [失败路径] 只等一帧时滚动容器尺寸可能尚未更新，断言会读到旧几何。
// [权衡] 这里不用计时器，避免与假计时器逻辑纠缠，也避免引入不可控的固定延迟。
const layout = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
// [契约] 这是外部驱动挂载形态的统一入口，必须先同步提交再等待布局。
// [并发] 同步提交保证状态更新在返回前已经落地，避免驱动脚本读到上一帧的 DOM。
// [失败路径] 序号未传表示清空工具结果，不能被当成保持原值。
(window as any).setAnchors = async (inline: boolean, sidebar: boolean, sequence?: number) => {
  flushSync(() => renderState({ inline, sidebar, sequence }));
  await layout();
};
(window as any).revealBackgroundPage = async () => {
  config.mode = "background";
  flushSync(() => renderState({ inline: false, sidebar: true }));
  await layout();
};
(window as any).setShowcasePresentation = async (
  theme: "light" | "dark",
  locale: string,
  width: number,
) => {
  Object.assign(config, { theme, locale, width });
  // fixture 没有应用主题样式表，提供宿主 token 以验证 reader → hostContext → 页面颜色。
  for (const [token, values] of Object.entries({
    "--color-background": ["#ffffff", "#17191c"],
    "--color-panel": ["#f4f5f6", "#23272c"],
    "--color-foreground": ["#202124", "#e6edf3"],
    "--color-foreground-subtle": ["#5f6368", "#adb5bd"],
    "--color-border": ["#dadce0", "#454b52"],
  }))
    document.documentElement.style.setProperty(token, values[theme === "dark" ? 1 : 0]!);
  flushSync(() => renderState({ inline: true, sidebar: false }));
  await layout();
};
(window as any).managedState = () => ({
  actual: {
    phase: pluginUiPages.get(current.pageKey)?.snapshot().phase,
    error: pluginUiPages.get(current.pageKey)?.snapshot().error,
  },
  phase: current.phase,
  supported: current.supported,
  handle: current.handle,
  key: current.pageKey,
  visible: pluginUiPages.get(current.pageKey)?.visible,
  busy: pluginUiPages.get(current.pageKey)?.busy(),
  widget: getPluginUiWidgetState(current.pageKey),
  views: document.querySelectorAll("webview").length,
  listeners: Object.fromEntries([...channels].map(([key, listeners]) => [key, listeners.size])),
  phases,
});
(window as any).expireOffscreen = () => {
  const pending = [...deadlines];
  deadlines.clear();
  for (const run of pending) run();
};
// [契约] 删除任务必须先把呈现入口撤掉，再广播任务列表变更。
// [失败路径] 顺序反了，仍挂载的 hook 会立刻向已删除任务发起请求，出现假的错误相位。
// [契约] 广播里的任务标识取自当前作用域的会话标识，用来让桩服务定位到同一个任务。
// [权衡] 这里用同步提交而不是等待布局，是因为断言只关心事件顺序，不关心绘制。
(window as any).removeTask = () => {
  // 删除任务同时撤掉呈现入口；不能让测试中仍挂载的 hook 再次请求已删除任务。
  flushSync(() => renderState({ inline: false, sidebar: false }));
  emit("task", {
    type: "workspace_task_list_changed",
    reason: "task_deleted",
    taskId: config.scope.sessionId,
  });
};
(window as any).runtimeUnavailable = () =>
  emit("lifecycle", {
    workspaceKey: config.scope.workspaceIdentity ?? config.scope.workspacePath,
    state: "unavailable",
  });
(window as any).retryManaged = () => current.reload();
(window as any).waitManagedPhase = (phase: string) => {
  const page = pluginUiPages.get(current.pageKey);
  if (!page || page.snapshot().phase === phase) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const off = page.subscribe(() => {
      if (page.snapshot().phase === phase) {
        off();
        resolve();
      }
    });
  });
};
(window as any).suspendManaged = () => pluginUiPages.get(current.pageKey)?.suspend();
// [契约] 该函数只在所有通道都没有订阅者时才解析，用于证明卸载真的释放了连接。
// [并发] drained.add(check) 之后立即调用 check()，覆盖登记之前就已清空的竞态。
// [失败路径] 解析前必须把自己从等待集合摘掉，否则重复调用会互相唤醒。
(window as any).waitConnectionsReleased = () =>
  new Promise<void>((resolve) => {
    const check = () => {
      if ([...channels.values()].every((set) => set.size === 0)) {
        drained.delete(check);
        resolve();
      }
    };
    drained.add(check);
    check();
  });
(window as any).clearManaged = () => pluginUiPages.clear();
// [契约] 该函数临时摘掉沙箱平台，用一次同步渲染观察降级路径。
// [资源] 无论渲染是否抛错，结束后都要把原来的平台对象放回去。
// [失败路径] 中途抛错且没有还原，后续所有用例都会跑在无沙箱的降级分支上。
// [契约] 返回值只暴露是否受支持与视图数量，不泄漏宿主内部句柄。
(window as any).setFallback = async (remote: boolean, noSandbox: boolean) => {
  const previous = platform.pluginSandbox;
  if (noSandbox) platform.pluginSandbox = undefined as never;
  flushSync(() => renderState({ inline: true, sidebar: false, remote }));
  await layout();
  platform.pluginSandbox = previous;
  return { supported: current.supported, views: document.querySelectorAll("webview").length };
};
// [契约] 整个引导流程包在配置的 Promise 链里，配置未到之前不创建任何根节点。
// [失败路径] 链尾统一接失败分支，配置读取失败时让握手闸门立即失败而不是静默白屏。
// [并发] 同一页面只执行一次引导，重复导航会重建整个文档，不存在二次进入。
void harness
  .config()
  .then(async (value: any) => {
    config = value;
    // [契约] 采样模式额外注册会话动作，用来验证宿主在采样期间的拒绝路径。
    // [资源] 注册返回的注销函数必须被保存，开关再次关闭时要先注销再置空。
    // [失败路径] 采样期间发起会话轮次属于违规，桩里直接抛出固定错误以便断言。
    if (config.mode === "sampling") {
      let unregister: (() => void) | undefined;
      (window as any).setSamplingEnabled = (enabled: boolean) => {
        unregister?.();
        unregister = undefined;
        if (enabled)
          unregister = registerPluginUiSessionActions(config.scope, {
            sendFollowUp: async () => {
              throw new Error("Sampling must not send a conversation turn");
            },
          });
      };
      (window as any).setSamplingEnabled(true);
      const idleWaiters = new Set<() => void>();
      const settled = pluginUiPages.settled.bind(pluginUiPages);
      pluginUiPages.settled = (page) => {
        settled(page);
        for (const notify of idleWaiters) notify();
      };
      (window as any).waitSamplingIdle = () =>
        new Promise<void>((resolve) => {
          const notify = () => {
            if (!pluginUiPages.get(current.pageKey)?.busy()) {
              idleWaiters.delete(notify);
              resolve();
            }
          };
          idleWaiters.add(notify);
          notify();
        });
    }
    // [契约] 该模式不挂锚点、不建会话租约，只保留生产窗口的结果接收器。
    // [契约] 页面键由产品侧的键构造函数生成，输入同时来自作用域与呈现配置。
    // [资源] 页面订阅与结果接收器都要保留句柄，接收器的注销函数还要暴露给脚本。
    // [失败路径] 若这里顺手挂了锚点，用例就再也证明不了没有租约也能接收结果。
    // [权衡] current 只在页面快照存在时更新，宁可让查询读到空，也不要凭空造状态。
    if (config.mode.startsWith("background-admission")) {
      // 故意不挂 Anchor/usePluginUiHost，也没有 conversation lease；只保留生产窗口接收器。
      // [契约] 键的输入必须同时展开作用域与呈现配置，顺序变化会改变最终字符串。
      // [失败路径] 只传其中一份会让接收器与页面注册表算出的键不一致，订阅永远收不到事件。
      // [权衡] 这里复用产品侧 buildPluginUiSurfaceKey 的构造逻辑，而不是在夹具里手写拼接键。
      const key = buildPluginUiSurfaceKey(
        { ...config.scope, ...config.presentation },
        config.scope.scope,
      );
      subscribePage(key, () => {
        const page = pluginUiPages.get(key);
        if (page) current = page.snapshot();
      });
      // [契约] 返回的注销函数是唯一释放接收器的入口。
      // [失败路径] 丢掉返回值就等于把监听永久留在窗口上，下一个用例会收到重复结果。
      // [契约] 主题与语言给固定值，避免夹具外观影响结果分发的断言。
      // [并发] 接收器只读服务桩，不写任何全局状态，因此可以与页面订阅并存。
      const off = attachPluginUiToolResults(services as never, platform as never, () => ({
        theme: "light",
        locale: "en",
      }));
      (window as any).stopBackgroundReceiver = off;
      ready.resolve();
    }
    // [契约] 网页模式模拟平台层没有沙箱，必须在创建根节点之前完成替换。
    // [失败路径] 放到渲染之后再改，首帧已经按有沙箱的路径跑了，断言会文不对题。
    // [权衡] 这里直接置空而不是包一层假对象，让缺失分支尽早暴露。
    if (config.mode === "web") platform.pluginSandbox = undefined as never;
    // [契约] 最小化模式先暂停引导，等外部脚本显式放行后再创建根节点。
    // [并发] 放行用的解析器挂在 window 上，脚本可以在页面任意时刻调用。
    // [失败路径] 放行前不得有任何渲染，否则最小化窗口的空白用例会失去前提。
    // [权衡] 这里用 Promise.withResolvers 等待而不是轮询，暂停时长完全由 startFixture 脚本决定。
    if (config.mode.endsWith("-minimized")) {
      const start = Promise.withResolvers<void>();
      (window as any).startFixture = start.resolve;
      paused.resolve();
      await start.promise;
    }
    // [契约] 根节点只创建一次，分支只决定挂表格夹具还是主夹具。
    // [契约] rows 模式走独立的 ServiceProvider 装配，仍需保持与主夹具相同的 theme 与 locale 来源。
    // [失败路径] 重复调用会让旧树失去引用却继续响应事件，查询到的 DOM 与断言对象随之错位。
    // [资源] createRoot 的根引用不保留，页面销毁时由文档整体卸载承担清理。
    createRoot(document.getElementById("root")!).render(
      config.mode === "rows" ? (
        <ServiceProvider services={services as never}>
          <PlatformProvider platform={platform as never}>
            <RowsFixture config={config} ready={ready.resolve} />
          </PlatformProvider>
        </ServiceProvider>
      ) : (
        <Fixture />
      ),
    );
  })
  .catch(ready.reject);
