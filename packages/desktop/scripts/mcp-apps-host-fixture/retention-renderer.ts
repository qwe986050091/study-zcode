// INV-01 守住位置：window 上注入的 harness 是唯一宿主通道，bridge 注册、owner 查询与 sandbox 释放都经它转发｜改错故障：自建通道会让保留测试测到假的生命周期
// INV-02 守住位置：只处理 type 为 zcode:plugin-sandbox-ports 且恰好 1 个 port 的消息，port 取自 event.ports[0]｜改错故障：从 data 里取 port 会拿到 undefined，接收端永远等不到端口
// INV-03 守住位置：track 必须同时挂 then 的成功与失败回调来删除 pending｜改错故障：reject 的 promise 会永久留在集合里，drain 永不结束
// INV-04 守住位置：now 只在 advance 中前进，timers 存 now + ms 的绝对截止时间｜改错故障：改存剩余时长后，每次推进都要重算，两套时间语义会互相污染
// INV-05 守住位置：调度器返回的取消函数要删除同一个 run 条目｜改错故障：页面释放后定时器仍在，advance 会执行已销毁页面的回调
// INV-06 守住位置：快照键固定为 `${task}/${key}`，读写共用同一拼接｜改错故障：只改一侧会让 getWidgetState 永远读到空值
// INV-07 守住位置：task 清理按 task + "/" 前缀删除快照，斜杠不可省｜改错故障：taskA 的清理会误删 taskAB 的数据
// INV-08 守住位置：busy 表示交互占用，running 表示 sandbox 已就绪，二者分离｜改错故障：合并成一个标志会让忙页被提前挂起，或空闲页永不释放
// INV-09 守住位置：suspend 先把 running 置 false 再 dispose｜改错故障：dispose 期间重入会重复释放，released 里出现重复 key
// INV-10 守住位置：released 只在成功路径追加，且先通知 owner 再 push｜改错故障：顺序颠倒会让计数与 owner 的已分配集合长期不一致
// INV-11 守住位置：未 running 时 suspend 返回 true，busy 时返回 false 且不改状态｜改错故障：丢失早返回会让空页面走完整释放链，或让忙页被强制卸载
// INV-12 守住位置：reserve 失败只清理 plane、监听与 DOM，并回传 error 字段｜改错故障：把失败当成功会让脚本后续操作拿到不存在的 sandbox
// INV-13 守住位置：addPage 返回前必须等 ready 落定，只有 running 才 resolve｜改错故障：提前返回会让脚本在 sandbox 未就绪时断言计数
// INV-14 守住位置：handle 在 mounted 阶段才回填，suspend 依赖这一顺序｜改错故障：把 mount 提前到 running 之前会读到 undefined 的 sandboxId
// INV-15 守住位置：recycleInstance 返回 !busy，与 suspend 的 busy 门禁同源｜改错故障：两处判定分叉会出现能回收却不能挂起的矛盾状态
// INV-16 守住位置：drain 用 while 检查 pending 直到为空｜改错故障：只做一次等待会漏掉释放回调中新挂起的链
// INV-17 守住位置：advance 先删除 timer 再调用 run｜改错故障：回调内的同步调度会在同一 tick 被再次触发，造成重复执行
// INV-18 守住位置：bind 得到的 off、plane 与 anchor 必须成对释放｜改错故障：漏掉 off 会让 port 接收器泄漏，counts 的 ports 指标失真
//
// 模块职责：在浏览器侧模拟插件 UI 宿主，把页面挂起、恢复与销毁的真实保留语义暴露给测试脚本。
// 状态所有权：pages、timers、snapshots、pending、released 均由本模块独占，owner 只通过构造参数获得时钟与清理能力。
// 阅读顺序：先看 track 与 owner 的构造（资源账本），再看 addPage 的挂载与就绪门闩，最后看 retention 暴露的 counts、visibility、busy、advance 与 clear。
import {
  createPluginUiHostController,
  type PluginUiHostController,
} from "../../../ui/src/plugin-ui/app/pluginUiHostController.js";
import { PluginUiPageManager } from "../../../ui/src/plugin-ui/app/pluginUiPageManager.js";
import { createPluginUiMessagePortTransport } from "../../../ui/src/plugin-ui/adapters/messagePortTransport.js";
import { createPluginUiPagePlane } from "../../../ui/src/plugin-ui/adapters/pluginUiPagePlane.js";
import type { PluginSandboxHandle, PluginSandboxPortsEvent } from "@zcode/shared/mcp-apps";
// harness 由宿主页面在加载本 fixture 前注入，这里只取引用不做事
// bridge 注册、owner 查询、sandbox 释放都必须回到这一个对象
// 任何本地模拟的 sandbox 都会让保留断言测到假数据
// 因此 harness 缺失时应尽早暴露，而不是静默降级
const harness = (window as any).harness;
const ports = new Set<(event: PluginSandboxPortsEvent) => void>();
window.addEventListener("message", (event) => {
  if (event.data?.type === "zcode:plugin-sandbox-ports" && event.ports.length === 1)
    for (const receive of ports) receive({ ...event.data, port: event.ports[0] });
});
// now 是测试唯一的虚拟时间源，初值 0 让首次 advance 前的截止时间可预期
// timers 存绝对 deadline 而不是剩余时长，避免每次推进都重算
// 改为剩余时长后，advance 的到点判定与调度器写入会形成两套时间语义
// 真实 Date 可能参与比较，会让保留测试在跨秒时抖动
let now = 0;
const timers = new Map<() => void, number>();
const snapshots = new Map<string, unknown>();
const pending = new Set<Promise<unknown>>();
const released: string[] = [];
// pending 记录所有未落定的异步释放，drain 以此判断是否还有尾部工作
// 成功与失败回调都要删除自身，否则被拒绝的 promise 会让 drain 永不为空
// 只处理成功分支是保留测试最常见的挂起原因
// 返回原 promise，调用方仍可继续链式使用同一结果
const track = (promise: Promise<unknown>) => {
  pending.add(promise);
  void promise.then(
    () => pending.delete(promise),
    () => pending.delete(promise),
  );
  return promise;
};
// owner 负责页面保留策略，本 fixture 只提供时钟与快照清理两个能力
// 调度器写入 now + ms 的绝对截止时间，并返回取消函数交给 owner 持有
// 取消函数必须删除同一个 run 引用，否则 advance 会执行已取消的回调
// task 清理按前缀删除快照，保证页面释放后 getWidgetState 不再读到旧值
// 前缀必须带 /，否则 taskA 的清理会波及 taskAB
const owner = new PluginUiPageManager<Page>(
  (run, ms) => {
    timers.set(run, now + ms);
    return () => {
      timers.delete(run);
    };
  },
  (task) => {
    for (const key of snapshots.keys()) if (key.startsWith(task + "/")) snapshots.delete(key);
  },
);
// Page 是 owner 与 retention 脚本共同依赖的最小契约
// busy 与 running 用函数而非字段，保证脚本读到的是当次闭包状态
// suspend 返回 Promise<boolean>：true 表示已释放，false 表示因 busy 被拒绝
// handle 只在 mounted 阶段回填，声明为可选正是为了反映这个时间窗口
type Page = {
  key: string;
  task: string;
  visible: boolean;
  busy(): boolean;
  running(): boolean;
  suspend(): Promise<boolean>;
  destroy(): void;
  setBusy(value: boolean): void;
  handle?: PluginSandboxHandle;
};
const pages = new Map<string, Page>();
// addPage 是唯一创建入口，key 与 task 共同决定快照键和沙箱作用域
// anchor 按 8 列网格排布，仅为让 webview 在测试页里可见可数
// busy 与 running 放在闭包内，外部只能通过 page 上的函数读取
// 返回 sandboxId 供脚本定位对应 guest，失败时则回传 error 字段
async function addPage(key: string, task: string, visible = true) {
  let busy = false;
  let running = false;
  let controller: PluginUiHostController;
  let handle: PluginSandboxHandle | undefined;
  const anchor = document.createElement("div");
  anchor.style.cssText = `position:absolute;left:${(pages.size % 8) * 120}px;top:${Math.floor(pages.size / 8) * 95}px;width:115px;height:90px;`;
  document.body.append(anchor);
  const plane = createPluginUiPagePlane({
    onVisibility() {},
    onCrash() {
      throw Error("retention guest crashed");
    },
  });
  const off = plane.bind({ node: anchor, kind: "inline" });
  const page: Page = {
    key,
    task,
    visible,
    busy: () => busy,
    running: () => running,
    setBusy(value) {
      busy = value;
      owner.settled(page);
    },
    suspend() {
      const result = (async () => {
        if (!running) return true;
        if (busy) return false;
        running = false;
        await controller.dispose();
        plane.unmount(handle!.sandboxId);
        owner.released(page);
        released.push(key);
        return true;
      })();
      track(result);
      return result;
    },
    destroy() {
      busy = false;
      track(
        page.suspend().then(() => {
          plane.dispose();
          off();
          anchor.remove();
          pages.delete(key);
        }),
      );
    },
  };
  // 先 add 再写入 pages：owner 接受后才暴露给脚本，避免注册失败留下幽灵页面
  // add 的拒绝会直接冒泡，此时 pages 尚未写入
  // reserve 是第二个准入闸门，全局最多保留 64 个 sandbox，必要时会先挂起空闲页
  // 失败分支只清理 plane、监听与 DOM，不删除 pages 条目
  // 因此脚本仍能观察到失败页面的残留计数，调用方按 error 字段判定
  await owner.add(page);
  pages.set(key, page);
  try {
    await owner.reserve(page);
  } catch (error) {
    plane.dispose();
    off();
    anchor.remove();
    return { error: String(error) };
  }
  const ready = Promise.withResolvers<void>();
  controller = createPluginUiHostController({
    scope: {
      workspacePath: "/retention",
      sessionId: task,
      scope: { kind: "surface", surfaceId: key },
    },
    presentation: { pluginId: "fixture", serverName: "fixture", resourceUri: "ui://fixture" },
    bridge: {
      prepareSandbox: () => harness.bridge("register", { key, task }),
      validateInstance: async () => {},
      closeInstance: async () => {},
      recycleInstance: async () => !busy,
    } as any,
    platform: {
      getOwnerWebContentsId: () => harness.owner(),
      disposeSandbox: (id, init) => harness.dispose(id, init),
      consumeUserGesture: async () => false,
      onPorts(receive) {
        ports.add(receive);
        return () => {
          ports.delete(receive);
        };
      },
    },
    createTransport: createPluginUiMessagePortTransport,
    initialHostContext: { displayMode: "inline" },
    hostVersion: "fixture",
    getToolFeed: () => ({}),
    getWidgetState: () => snapshots.get(task + "/" + key),
    getHostCapabilities: () => ({}),
    onPhase(phase, detail) {
      if (phase === "mounted") {
        handle = detail!.handle!;
        page.handle = handle;
        plane.mount(handle);
      }
      if (phase === "running") {
        running = true;
        ready.resolve();
      }
      if (phase === "error") ready.reject(Error(detail?.error));
    },
    onHeight() {},
    onOpenExternal() {},
    onDisplayModeRequest: (mode) => mode,
  });
  // start 之后 controller 自行推进 mounted 与 running 阶段
  // ready 在 running 阶段 resolve，因此 addPage 的返回时机等价于 sandbox 可交互
  // error 阶段 reject 会把异常抛回脚本，避免调用方无限等待
  // 等到门闩落定后才写首个快照，脚本不会读到未运行页面的状态
  controller.start();
  await ready.promise;
  snapshots.set(task + "/" + key, { saved: key });
  return { sandboxId: handle!.sandboxId };
}
// drain 用于把 track 过的释放链全部跑完，测试的断言点都在它之后
// 等待期间可能有新 promise 进入 pending，必须循环检查直到集合为空
// 只做一次等待会漏掉由释放回调再次触发的挂起链
// advance 与 clear 都以 drain 收尾，确保计数稳定后再返回脚本
// drain 不设超时，卡住即说明某条释放链永不落定，应查 track 的失败分支
async function drain() {
  while (pending.size) await Promise.all(pending);
}
(window as any).retention = {
  addPage,
  counts: () => ({
    pages: pages.size,
    views: document.querySelectorAll("webview").length,
    ports: ports.size,
    snapshots: snapshots.size,
    timers: timers.size,
    released: [...released],
  }),
  visibility: (key: string, value: boolean) => owner.visibility(pages.get(key)!, value),
  busy: (key: string, value: boolean) => pages.get(key)!.setBusy(value),
  async advance(ms: number) {
    now += ms;
    for (const [run, deadline] of timers)
      if (deadline <= now) {
        timers.delete(run);
        run();
      }
    await drain();
  },
  async clear() {
    owner.clear();
    await drain();
  },
};
(window as any).harnessReady = Promise.resolve();
