// ZCode UI 夹具生成器（React 变体）：在真实渲染器里挂载真实的 GenUiMessageResponse，
// 用桥接替身伪造 genUiService、插件沙箱与远端工作区，供样式检查与交互回归复用。
// 输出必须确定：同一份 config 与同一组控制指令，任意时刻都产出逐字节一致的 DOM 与计数快照。
// INV-01 夹具根节点唯一且只创建一次；守住位置：reactRoot 的 createRoot 调用；改错故障：二次建根触发 React 报错，整份夹具白屏且检查静默通过。
// INV-02 首帧必须在 flushSync 内提交；守住位置：启动末尾包住 renderReply 的流式阶段；改错故障：检查读到空容器，卡片未渲染被当成功能缺失。
// INV-03 每条控制指令都同步重渲染且复用同一 root；守住位置：Object.assign 暴露的全部指令；改错故障：重复挂载叠加旧树，截图出现两份卡片。
// INV-04 消息正文必须由文本包裹 directive 组成，走真实解析链路；守住位置：renderReply 里的 children 模板串；改错故障：直接挂卡片则漏掉未知 directive 的回归覆盖。
// INV-05 仅 wide 模式附带 mode 字段；守住位置：模板串中的三元展开；改错故障：普通模式被当成宽屏，布局断言永远命中宽版分支。
// INV-06 服务替身对未知方法一律透传到 harness 桥；守住位置：服务代理的兜底分支；改错故障：上游新增接口拿到空值，调用方在夹具里静默失败。
// INV-07 只有 onStateChanged 返回订阅句柄，其余方法按可调用函数处理；守住位置：服务代理的特例判断；改错故障：订阅被当成普通调用，状态事件无处派发。
// INV-08 沙箱准备次数必须单独累加；守住位置：代理兜底里的方法名比较；改错故障：准备计数恒为零，预热相关回归失去唯一观测点。
// INV-09 远端文档读取必须被 documentGate 卡住；守住位置：remoteServices 的 readDocument；改错故障：hold 与 release 指令失效，加载态时序无法复现。
// INV-10 会话注册只写一次 store，且 base 与 remote 分离注入；守住位置：useRemoteWorkspaceSessionStore.setState；改错故障：远端读写落到本地服务，身份隔离断言失真。
// INV-11 平台替身默认成功、可整体切到失败；守住位置：openExternal 的 rejectOpen 分支；改错故障：外链失败路径无从验证，错误分支永远不执行。
// INV-12 用户手势的挂起标志必须覆盖真实等待窗口；守住位置：consumeUserGesture 的 await 顺序；改错故障：挂起态观测错位，重复点击检测失效。
// INV-13 端口订阅成对增删，卸载后集合回零；守住位置：onPorts 返回的清理函数；改错故障：热更新后旧 handler 泄漏，同一事件被重复消费。
// INV-14 手机模式只摘掉插件沙箱，其余能力同源；守住位置：mobilePlatform 的展开覆盖；改错故障：移动端检查连带丢失外链桩，出现假失败。
// INV-15 长延时定时器登记后可由 expireOffscreen 立即放行；守住位置：setTimeout 包装与 300000 判定；改错故障：离屏过期必须真等五分钟，回归无法自动化。
// INV-16 任务事件按会话广播给全部监听者；守住位置：deleteTask 的遍历派发；改错故障：只删指定会话却让其他会话收到误报。
// INV-17 快照读取必须只读，不得改动夹具状态；守住位置：inspectReact 的返回对象；改错故障：计数被清零，相邻断言互相污染。
// INV-18 未知组件与未知 hook 一律降级为无副作用空实现；守住位置：Provider 包装与桥接兜底；改错故障：夹具因缺依赖直接崩溃，真实渲染缺陷被掩盖。
//
// 夹具与真实渲染的偏差集中在三处：替身不模拟进程边界、Provider 组合省略了应用的路由与外层布局、
// 时序完全由指令驱动而非网络与磁盘的真实耗时。任何断言只能说明组件在本夹具下自洽，
// 不能替代桌面端端到端测试；发现差异时先确认替身覆盖范围，再判断是否为产品缺陷。
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { FileSummaryFixture } from "./file-summary.js";
import { GenUiMessageResponse } from "../../../ui/src/gen-ui/components/GenUiMessageResponse.js";
import { ServiceProvider } from "../../../ui/src/hooks/useServices.js";
import { PlatformProvider } from "../../../ui/src/hooks/usePlatform.js";
import { TabStoreProvider } from "../../../ui/src/store/TabStoreProvider.js";
import { ZCodeIntlProvider } from "../../../ui/src/i18n/IntlProvider.js";
import { useRemoteWorkspaceSessionStore } from "../../../ui/src/store/remoteWorkspaceSessionStore.js";
import { registerPluginUiSessionActions } from "../../../ui/src/plugin-ui/hostPrimitives.js";
import type { IServiceAccessor } from "@zcode/services";
import type { GenUiStateChange } from "@zcode/shared/gen-ui";
import type { PluginSandboxPortsEvent } from "@zcode/shared/mcp-apps";
import { buildRemoteWorkspaceSessionServicesForRegistration } from "@desktop/renderer/src/remoteWorkspaceSessionServices.js";
// harness 由预加载脚本注入，模块求值即读取，晚于脚本加载就永远取不到
// 失败路径：注入缺失时此处值为空，第一处 await 直接抛错且没有可读提示
// 设计权衡：这里不做形状校验，换取启动路径零分支，代价是错误定位后移
const harness = (window as any).harness;
// ports 与 states 是消息网关的两张订阅表，初始为空，由订阅方按需注入
// 并发：遍历期间允许增删，本轮只影响下一轮，避免边派发边修改导致的跳过
// 失败路径：卸载遗漏会让 handler 常驻，跨轮次的计数断言随之偏大
const ports = new Set<(event: PluginSandboxPortsEvent) => void>();
const states = new Set<(event: GenUiStateChange) => void>();
// reads、preparations 与随后的 messages、opened 都是可观测副作用账本，初值必须归零
// 不变量：账本只由替身写入，夹具自身不得修改，保证不同指令序列之间可对比
// 设计权衡：用模块级可变变量而非组件状态，读取无需重渲染即可立即生效
let reads = 0,
  preparations = 0;
const messages: unknown[] = [];
const opened: string[] = [];
// gestureGate 与 documentGate 是可挂起的闸门，为空表示不阻塞、直接放行
// 资源：闸门用后即置空，避免已结算的句柄被下一轮误用而永久放行
// 失败路径：忘记放行会让调用方永久悬挂，夹具表现为永远加载中
let gestureGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let gesturePending = false;
let rejectOpen = false;
const taskListeners = new Set<(event: unknown) => void>();
let activeSession = "fixture";
let documentGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let viewTitle = "Gen UI test";
// deadlines 收集被识别为离屏过期的定时器回调，由 expireOffscreen 一次性放行
// 不变量：只登记长延时回调，短定时器混入会提前打断正常渲染节奏
// 并发：放行后立即清空集合，重复调用不会二次触发同一回调
const deadlines = new Set<() => void>();
const nativeSetTimeout = window.setTimeout.bind(window);
// 定时器被包装以识别 300000 毫秒的离屏期限，其余调用原样转交原生实现
// 不变量：必须保留原方法的绑定与额外参数，否则回调上下文与真实轮询器不一致
// 失败路径：仅按毫秒数识别存在误伤，业务若用同值延时会被提前触发
window.setTimeout = ((run: () => void, ms?: number, ...args: unknown[]) => {
  if (ms === 300000) deadlines.add(run);
  return nativeSetTimeout(run, ms, ...args);
}) as typeof window.setTimeout;
// 消息网关按 type 分流：端口事件进入 ports，通知负载进入 states
// 不变量：两路互不干扰，未知 type 静默忽略，夹具不对新增消息类型过敏
// 失败路径：负载结构不符由订阅方承担，网关不做校验以贴近真实链路
window.addEventListener("message", (event) => {
  if (event.data?.type === "zcode:plugin-sandbox-ports")
    for (const handler of ports) handler({ ...event.data, port: event.ports[0] });
  if (event.data?.type === "fixture-notification")
    for (const handler of states) handler(event.data.payload);
});
void (async () => {
  const config = await harness.config(true);
  const target = {
    workspacePath: config.root,
    workspaceIdentity: "ssh:fixture:/workspace",
    remoteSessionId: "remote-1",
    sessionId: "fixture",
    path: config.path,
    instanceKey: "react:0",
  };
  // 服务替身在取值阶段分流：onStateChanged 返回订阅工厂，其余一律包装成透传函数
  // 透传函数把调用原样交给桥接层，保留入参形态与返回值，模拟真实异步签名
  // 不变量：未知方法既不抛错也不返回空值，否则上游新增接口在夹具里静默失败
  // 权衡：透传不做参数校验，宁可让错误在组件侧暴露，也不在替身里另造一套语义
  const service = new Proxy(
    {},
    {
      get: (_, method) => {
        if (method === "onStateChanged")
          return (handler: (event: GenUiStateChange) => void) => {
            states.add(handler);
            return { dispose: () => states.delete(handler) };
          };
        return (input: unknown) => {
          if (method === "prepareSandbox") preparations++;
          return harness.bridge(method, input);
        };
      },
    },
  );
  // base 描述本地会话：genUiService 走代理，任务服务只暴露工作区事件订阅
  // 不变量：订阅返回带释放方法的句柄，调用方释放后监听表必须回落到原大小
  // 失败路径：其余方法暂缺，由类型断言兜住，按需再补而不是一次铺满
  const base = {
    genUiService: service,
    zcodeTaskService: {
      onDynamicWorkspaceEvent: () => (listener: (event: unknown) => void) => {
        taskListeners.add(listener);
        return { dispose: () => taskListeners.delete(listener) };
      },
    },
  } as unknown as IServiceAccessor;
  // remote 描述远端会话：文件存在性恒真，文档读取先过闸门再走桥
  // 不变量：读取计数在等待之前自增，挂起期间快照也能反映已发起的请求
  // 失败路径：闸门未创建时直接放行，保证没有指令的场景不会卡死
  const remoteServices = {
    fileService: {
      async checkFilesExist({ paths }: { paths: string[] }) {
        return paths.map((path) => ({ path, exists: true }));
      },
    },
    genUiService: {
      async readDocument(input: unknown) {
        reads++;
        await documentGate?.promise;
        return harness.remoteRead(input);
      },
    },
  } as unknown as IServiceAccessor;
  // 远端服务由统一构造函数装配，目标种类与来源服务器由查询参数决定
  // 不变量：装配结果整体注入 store，不逐字段拼装，否则身份解析规则会分叉
  // 并发：先注册服务再挂载界面，避免首帧拿到尚未就绪的会话
  const remote = buildRemoteWorkspaceSessionServicesForRegistration({
    baseServices: base,
    remoteServices,
    targetKind: "ssh",
    sourceServerId: new URLSearchParams(location.search).has("source")
      ? "fixture-source"
      : undefined,
  });
  useRemoteWorkspaceSessionStore.setState({
    baseServices: base,
    sessionsById: { "remote-1": { sessionId: "remote-1", services: remote } },
    sessionIdByWorkspaceIdentity: { [target.workspaceIdentity]: "remote-1" },
  });
  const unregister = registerPluginUiSessionActions(target, {
    async sendFollowUp(message) {
      messages.push(message);
    },
  });
  // 平台替身覆盖外链打开与插件沙箱两组能力，其余平台操作由类型断言忽略
  // 不变量：沙箱句柄复用 window 上的真实实现，替身只负责计数与闸门
  // 失败路径：window 上沙箱缺失时会解引用空值，属依赖未满足的显式崩溃
  const platform = {
    openExternal(url: string) {
      if (rejectOpen) throw new Error("Fixture opener failed");
      opened.push(url);
    },
    pluginSandbox: {
      supportsRetainedMove: window.zcodePluginSandbox?.supportsRetainedMove,
      copyImage: (request) => window.zcodePluginSandbox!.copyImage!(request),
      getOwnerWebContentsId: () => harness.owner(),
      disposeSandbox: (id: string, init: number) => harness.dispose(id, init),
      // 手势消费先向真实沙箱取结果，再挂起等待闸门，最后翻转挂起标志
      // 不变量：标志在放行之后才置回，保证观测窗口与真实等待区间完全重合
      // 失败路径：闸门未创建时立即返回，未使用指令时行为与真实平台一致
      async consumeUserGesture(sandboxId: string) {
        const allowed = await window.zcodePluginSandbox!.consumeUserGesture(sandboxId);
        gesturePending = true;
        await gestureGate?.promise;
        gesturePending = false;
        return allowed;
      },
      onPorts(handler: (event: PluginSandboxPortsEvent) => void) {
        ports.add(handler);
        return () => {
          ports.delete(handler);
        };
      },
    },
  };
  const reactRoot = createRoot(document.getElementById("root")!);
  const mobilePlatform = { ...platform, pluginSandbox: undefined };
  let mobile = false;
  // 回归真实模型输出：从正文解析进入卡片，直接挂 GenUiCard 无法发现 directive 未识别。
  let mode: "normal" | "wide" = "wide";
  let summaryMode: "only" | "mixed" | "ordinary" | null = null;
  let compact = false;
  // 渲染入口固定 Provider 嵌套顺序：国际化、标签页 store、服务、平台，顺序错了 hook 取不到依赖
  // props 透传规则：消息键、工作区路径与身份、远端会话 id、会话 id 全部显式取自目标描述
  // 不变量：阶段决定完成与流式互斥，隐藏时只留外层容器不渲染消息主体
  const renderReply = (phase: "streaming" | "complete" | "hidden") =>
    reactRoot.render(
      <ZCodeIntlProvider initialLocale="en-US">
        <TabStoreProvider>
          <ServiceProvider services={remote}>
            <PlatformProvider platform={(mobile ? mobilePlatform : platform) as never}>
              <div id="gen-ui-scroll" style={{ height: 650, overflow: "auto" }}>
                <div className="w-full" style={{ padding: 5 }} data-conversation-selectable="true">
                  {phase !== "hidden" && (
                    <GenUiMessageResponse
                      completed={phase === "complete"}
                      streaming={phase === "streaming"}
                      messageKey="react"
                      workspacePath={target.workspacePath}
                      workspaceIdentity={target.workspaceIdentity}
                      workspaceRemoteSessionId={target.remoteSessionId}
                      sessionId={activeSession}
                    >
                      {`Before view\n\n::visualize${JSON.stringify({ path: config.paths[activeSession], title: viewTitle, ...(mode === "wide" ? { mode } : {}) })}\n\nAfter view`}
                    </GenUiMessageResponse>
                  )}
                  {summaryMode && (
                    <FileSummaryFixture
                      key={summaryMode}
                      path={config.path}
                      root={config.root}
                      mode={summaryMode}
                      compact={compact}
                    />
                  )}
                  <div style={{ height: 1000 }} />
                </div>
              </div>
            </PlatformProvider>
          </ServiceProvider>
        </TabStoreProvider>
      </ZCodeIntlProvider>,
    );
  flushSync(() => renderReply("streaming"));
  // 控制面把全部指令挂到 window，检查脚本据此驱动夹具而不触碰内部变量
  // 不变量：每条指令都同步渲染并复用同一 root，读取后立即可断言无需等待
  // 失败路径：指令名拼错只会在检查侧表现为超时，夹具本身不会报错
  Object.assign(window, {
    showMobile: () => {
      mobile = true;
      flushSync(() => renderReply("complete"));
    },
    holdDocument: () => {
      documentGate = Promise.withResolvers<void>();
    },
    releaseDocument: () => {
      documentGate?.resolve();
      documentGate = undefined;
    },
    setViewTitle: (value: string) => {
      viewTitle = value;
      flushSync(() => renderReply("complete"));
    },
    showFileSummary: (value: typeof summaryMode, mobile = false) => {
      summaryMode = value;
      compact = mobile;
      flushSync(() => renderReply("complete"));
    },
    holdGesture: () => {
      gestureGate = Promise.withResolvers<void>();
    },
    releaseGesture: () => {
      gestureGate?.resolve();
      gestureGate = undefined;
    },
    rejectExternalOpen: (value: boolean) => {
      rejectOpen = value;
    },
    setInlineMode: (value: "normal" | "wide") => {
      mode = value;
      flushSync(() => renderReply("complete"));
    },
    showReply: (phase: "streaming" | "complete" | "hidden") => flushSync(() => renderReply(phase)),
    disableSession: unregister,
    showTask: (session: string) => {
      activeSession = session;
      flushSync(() => renderReply("complete"));
    },
    expireOffscreen: () => {
      for (const run of deadlines) run();
      deadlines.clear();
    },
    deleteTask: (session: string) => {
      for (const listener of taskListeners)
        listener({ type: "workspace_task_list_changed", reason: "task_deleted", taskId: session });
    },
    inspectReact: () => ({
      reads,
      preparations,
      messages,
      opened,
      gesturePending,
      ports: ports.size,
      states: states.size,
      tasks: taskListeners.size,
    }),
  });
})();
