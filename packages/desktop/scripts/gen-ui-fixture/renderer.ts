// INV-01 消息桥只认固定类型：守住位置 类型判断；改错故障 其他消息误触端口回调。
// INV-02 端口来自消息通道：守住位置 事件端口取值；改错故障 中继拿不到消息通道。
// INV-03 监听器可单例替换：守住位置 模块级变量；改错故障 重复注册导致多路转发。
// INV-04 状态订阅返回销毁器：守住位置 订阅分支；改错故障 夹具切页后仍收通知。
// INV-05 其余方法转发桥接：守住位置 代理默认分支；改错故障 文件与状态请求走不到宿主。
// INV-06 启动只执行一次：守住位置 自执行函数；改错故障 重复建页导致节点冲突。
// INV-07 目标固定为夹具：守住位置 目标常量；改错故障 被识别成真实工作区。
// INV-08 建页前先注册会话动作：守住位置 调用顺序；改错故障 追问按钮无响应。
// INV-09 就绪条件写死分组数：守住位置 快照判断；改错故障 页面未就绪就开始断言。
// INV-10 错误阶段立即拒绝：守住位置 阶段分支；改错故障 等待永不结束。
// INV-11 订阅后立即自查一次：守住位置 主动读取；改错故障 已就绪时错过通知。
// INV-12 绑定区分内联与展开：守住位置 元素标识；改错故障 展开态渲染进内联容器。
// INV-13 切页先解绑旧容器：守住位置 解绑调用；改错故障 两处同时监听。
// INV-14 重启先销毁再建：守住位置 调用顺序；改错故障 旧页面残留监听。
// INV-15 检查接口返回快照：守住位置 返回值；改错故障 无法断言交互次数。
// INV-16 解绑只注销会话动作：守住位置 解绑调用；改错故障 页面整体被销毁。
// INV-17 调整遍历首组控件：守住位置 控件映射；改错故障 调整值写到错误控件。
// INV-18 提交只改首个控件：守住位置 下标取值；改错故障 提交触发全量修改。
//
// 模块职责：Gen UI 桌面夹具的页面引导与浏览器侧测试接口。
// 状态所有权：页面实例与监听器变量归本模块，宿主能力由注入的桥提供。
// 阅读顺序：先看消息桥与代理，再看启动与就绪等待，最后看测试接口。
import { createGenUiPage } from "../../../ui/src/gen-ui/adapters/page.js";
import { registerPluginUiSessionActions } from "../../../ui/src/plugin-ui/hostPrimitives.js";
import type { GenUiPage } from "../../../ui/src/gen-ui/contract.js";
import type { IGenUiService } from "@zcode/services";
import type { GenUiStateChange } from "@zcode/shared/gen-ui";
import type { PluginSandboxPortsEvent } from "@zcode/shared/mcp-apps";
const harness = (window as any).harness;
let portListener: ((event: PluginSandboxPortsEvent) => void) | undefined;
let stateListener: ((event: GenUiStateChange) => void) | undefined;
window.addEventListener("message", (event) => {
  if (event.data?.type === "zcode:plugin-sandbox-ports")
    portListener?.({ ...event.data, port: event.ports[0] });
  if (event.data?.type === "fixture-notification") stateListener?.(event.data.payload);
});
// service 代理在 onStateChanged 时走专用订阅分支，其余方法原样转发给 harness.bridge。
// onStateChanged 之外的方法都由 harness.bridge 转发，代理不认识具体业务。
// 代理只实现 IGenUiService 的服务面，不额外暴露内部字段。
// 代理不缓存调用结果，每次 get 都现算返回值。
// 新的 stateListener 会覆盖旧的，dispose 只把引用置回 undefined。
const service = new Proxy(
  {},
  {
    get: (_, key) =>
      key === "onStateChanged"
        ? (fn: typeof stateListener) => {
            stateListener = fn;
            return {
              dispose() {
                stateListener = undefined;
              },
            };
          }
        : (input: unknown) => harness.bridge(key, input),
  },
) as IGenUiService;
// start 先 await harness.config()，拿到 root 与 path 后才建页。
// target 固定成 fixture 会话，workspaceIdentity 写死 ssh:fixture:/workspace。
// registerPluginUiSessionActions 在建页前注册，保证页面就绪时动作已可用。
// page.bind 绑定到 id 为 inline 的容器，初始 expanded 为 false。
// await waitReady() 通过后才把接口挂到 window 上。
void (async () => {
  const config = await harness.config();
  let page: GenUiPage, off: (() => void) | undefined;
  let confirmations = 0,
    messages: unknown[] = [],
    bound = true;
  const target = {
    workspacePath: config.root,
    sessionId: "fixture",
    path: config.path,
    instanceKey: "row:0",
    workspaceIdentity: "ssh:fixture:/workspace",
  };
  const unregister = registerPluginUiSessionActions(target, {
    async sendFollowUp(message) {
      messages.push(message);
    },
  });
  // waitReady 要求 s.groups.length === 2，分组数量写死为二。
  // 第一组 controls 长度为 4 且第二组为 2，两组数量都写死。
  // 就绪时先调用 stop() 解除订阅，再 resolve 这个 promise。
  // phase 为 error 时立即 reject，不等待后续快照。
  // 订阅成功后主动调用一次 read() 自查，避免错过首帧。
  const waitReady = () =>
    new Promise<void>((resolve, reject) => {
      const read = () => {
        const s = page.getSnapshot();
        if (
          s.phase === "ready" &&
          s.groups.length === 2 &&
          s.groups[0]?.controls.length === 4 &&
          s.groups[1]?.controls.length === 2
        ) {
          stop();
          resolve();
        }
        if (s.phase === "error") {
          stop();
          reject(new Error(s.error));
        }
      };
      const stop = page.subscribe(read);
      read();
    });
  async function start() {
    page = createGenUiPage({
      target,
      files: service,
      state: service,
      openExternal: () => {
        throw new Error("External links belong to the React fixture");
      },
      confirm: async (prompt) => {
        confirmations++;
        return prompt;
      },
      platform: {
        supportsRetainedMove: window.zcodePluginSandbox?.supportsRetainedMove,
        copyImage: (request) => window.zcodePluginSandbox!.copyImage!(request),
        getOwnerWebContentsId: () => harness.owner(),
        disposeSandbox: (id, init) => harness.dispose(id, init),
        consumeUserGesture: () => harness.gesture(),
        onPorts(fn) {
          portListener = fn;
          return () => {
            portListener = undefined;
          };
        },
      },
    });
    off = page.bind(document.getElementById("inline")!, false);
    await waitReady();
  }
  // stop 直接调用 page.dispose()，把页面连同绑定一起销毁。
  // switchPage 先 off?.() 解绑旧容器，再 bind 到新容器。
  // restore 先 off?.() 再 dispose，然后 start() 重建。
  // inspect 返回 confirmations 与 messages 计数以及 getSnapshot() 快照。
  // unbind 只调用 unregister() 并置 bound=false，不销毁页面。
  Object.assign(window, {
    harnessReady: start(),
    stop: () => page.dispose(),
    copy: () => page.copyImage(),
    switchPage: async (expanded: boolean) => {
      off?.();
      off = page.bind(document.getElementById(expanded ? "expanded" : "inline")!, expanded);
      await new Promise(requestAnimationFrame);
      return page.getSnapshot();
    },
    restore: async () => {
      off?.();
      await page.dispose();
      await start();
    },
    inspect: () => ({ confirmations, messages, bound, snapshot: page.getSnapshot() }),
    setProbeTweaks: (values: Record<string, number>) => page.setTweaks(values),
    unbind: () => {
      unregister();
      bound = false;
    },
    adjust: () =>
      page.setTweaks(
        Object.fromEntries(
          page
            .getSnapshot()
            .groups[0]!.controls.map((control, index) => [
              control.id,
              [35, "#ff0000", false, "compact"][index]!,
            ]),
        ),
      ),
    submit: () => page.submitTweaks({ [page.getSnapshot().groups[0]!.controls[0]!.id]: 35 }),
  });
})();
