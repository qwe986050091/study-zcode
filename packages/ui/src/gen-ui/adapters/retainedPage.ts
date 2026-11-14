// INV-01 守住位置：key 由作用域 task、路径与 instanceKey 三元组唯一确定；改错故障：漏掉 instanceKey 会把不同实例折叠成同一个 owner
// INV-02 守住位置：同一 key 的并发获取必须共享同一个创建中的 promise；改错故障：绕过创建表会重复准入并双份占用配额
// INV-03 守住位置：准入登记表里的 owner 才是保留实体，guest 页面可以被回收；改错故障：把 guest 当所有权主体，离屏回收后锚点将失去唤醒入口
// INV-04 守住位置：准入失败必须销毁刚建好的 owner 再把错误抛出；改错故障：吞掉失败会留下永不释放的准入门票
// INV-05 守住位置：每次唤醒都取递增代际，异步续体必须比对代际；改错故障：不比对会让旧续体在挂起之后重新建出 guest
// INV-06 守住位置：释放动作串行挂接到同一条队列，同一时刻只允许一个 guest 退出；改错故障：并行释放会与新建争抢同一份配额
// INV-07 守住位置：预留成功而锚点已清空时必须立即归还配额；改错故障：漏归还会让配额泄漏到进程结束
// INV-08 守住位置：挂起先递增代际并清启动标记，再摘订阅与绑定，最后置空 guest；改错故障：顺序颠倒会让回调读到已释放的 guest
// INV-09 守住位置：挂起时保留快照高度作为占位尺寸；改错故障：清零高度会让滚动位置跳动并诱发误回收
// INV-10 守住位置：错误态一经写入便不再自动重试，只有显式重试入口能重置；改错故障：自动重试会在坏输入上形成死循环
// INV-11 守住位置：确认回调取最近注册的那个，避免旧闭包拦截新页面；改错故障：取最早注册会让已卸载页面的回调继续生效
// INV-12 守住位置：绑定按锚点符号计数，最后一个锚点解绑后才把可见性置为假；改错故障：首个解绑就置假会让同页多锚点提前休眠
// INV-13 守住位置：交叉观察器归属窗口 owner，只服务唤醒而不随 guest 一起销毁；改错故障：跟随 guest 销毁观察器会永久失去重新滚入时的唤醒
// INV-14 守住位置：销毁入口幂等，且先置销毁标记再走挂起流程；改错故障：重复进入会二次断开观察器并清空仍在使用的监听集合
// INV-15 守住位置：任务移除回调只做移除登记，不直接销毁 owner；改错故障：直接销毁会绕过释放队列造成双重释放
// INV-16 守住位置：可见性判定同时要求锚点位于视口内且节点仍在文档中；改错故障：只看可见标记会让已卸载节点长期占用可见额度
// INV-17 守住位置：监听通知只在快照真正更新之后发出，遍历期间不增删集合；改错故障：通知过程中改动集合会漏发或重入
// INV-18 守住位置：销毁外壳只是即发即忘地调用同一套销毁流程；改错故障：让外壳承担额外清理会与显式销毁路径互相冲突
//
// 模块职责：把 gen-ui 页面的创建、准入、可见性、挂起与释放收敛成一个可保留的 owner
// 状态所有权：owner 持有锚点、确认回调、快照与生命周期推进权，guest 页面归准入登记表的配额管理
// 阅读顺序：先看 key 与创建去重，再看唤醒的挂起与恢复状态机，最后看绑定与释放路径
import { buildGenUiScopeKey } from "@zcode/shared/gen-ui";
import { sandboxPages, type SandboxPageOwner } from "@/plugin-ui/hostPrimitives.js";
import { EMPTY_GEN_UI_SNAPSHOT, type GenUiPage, type GenUiPageSnapshot } from "../contract.js";
import { createGenUiPage, type GenUiPageInput } from "./page.js";

export interface RetainedGenUiPage extends GenUiPage, SandboxPageOwner {
  readonly kind: "gen-ui";
  attachConfirmation(confirm: GenUiPageInput["confirm"]): () => void;
  retry(): void;
}
// 创建表按 key 去重，把并发的申请压成一次准入，避免同帧多次挂载各自建 guest
// 表里的 promise 结束即删除，成功或失败都回到无创建中的状态，不缓存陈旧结果
// 去重换来内存与配额的节省，代价是并发方共享同一个失败结果，是否重试由调用方决定
// 表只覆盖创建阶段，页面被回收后不保留任何句柄，唤醒仍依赖登记表中的现存 owner
// 若把完成后的 promise 长期留在表中，回收后的 key 会永远命中一条死条目
const creating = new Map<string, Promise<RetainedGenUiPage>>();
export function acquireGenUiPage(
  input: Omit<GenUiPageInput, "confirm"> & {
    watchTaskRemoved(run: () => void): () => void;
  },
): Promise<RetainedGenUiPage> {
  const task = buildGenUiScopeKey(input.target);
  const key = `gen-ui:${JSON.stringify([task, input.target.path, input.target.instanceKey])}`;
  const existing = sandboxPages.get(key);
  // 命中已有 owner 时直接复用，不重建 guest，也不重置快照与锚点
  // 复用路径把所有权完全交给登记表的结果，本地不再做引用计数
  // 类型判别用于与同 key 的其他页面隔离，混合类型各自走独立分支
  // 若在此处重新创建，重复挂载会让同一路径出现两份快照，界面出现双份渲染
  if (existing?.kind === "gen-ui") return Promise.resolve(existing as RetainedGenUiPage);
  const pending = creating.get(key);
  if (pending) return pending;
  const owner = createOwner(key, task, input);
  // 准入是异步的，先登记 promise 再等待配额落定，保证并发方看到同一份进度
  // 失败分支必须销毁刚建好的 owner，否则锚点、观察器与监听都会悬挂在内存里
  // 收尾阶段删除创建表条目，保证不论成败下一次申请都能重新进入准入
  // 失败以拒绝的 promise 向上抛出，页面层据此展示错误而不是无限加载
  // 这里不做重试，时机交回调用方，避免配额耗尽时形成忙等
  const admission = sandboxPages
    .add(owner)
    .then(
      () => owner,
      (error) => {
        owner.destroy();
        throw error;
      },
    )
    .finally(() => creating.delete(key));
  creating.set(key, admission);
  return admission;
}
function createOwner(
  key: string,
  task: string,
  input: Omit<GenUiPageInput, "confirm"> & { watchTaskRemoved(run: () => void): () => void },
): RetainedGenUiPage {
  const anchors = new Map<symbol, { node: HTMLElement; visible: boolean; off?: () => void }>();
  const confirmations = new Map<symbol, GenUiPageInput["confirm"]>();
  const listeners = new Set<() => void>();
  let core: GenUiPage | null = null;
  let snapshot: GenUiPageSnapshot = { ...EMPTY_GEN_UI_SNAPSHOT };
  let disposed = false,
    starting = false,
    epoch = 0;
  // 释放队列把 guest 退出串成一条链，任何时刻只有一个销毁在进行
  // 新的挂起会挂到链尾，天然等待前一次释放完成，避免配额计数错乱
  // 代价是快速滚动时释放会排队，短期内存峰值偏高，但换来确定性
  // 队列始终保有可挂接状态，不做空值回退，从而简化并发判断
  let releasing: Promise<unknown> = Promise.resolve();
  let offCore: (() => void) | undefined;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const fail = (error: unknown) => {
    snapshot = { ...snapshot, phase: "error", error: String(error) };
    notify();
  };
  // 回收的是 guest；锚点观察属于窗口 owner，离屏回收后重新滚入视口仍能唤醒。
  // 观察器归窗口 owner 所有，锚点节点在文档中增删都不改变它的生命周期
  // guest 被回收后锚点仍在观察，重新滚入视口即可再次唤醒，这是保留策略的支点
  // 回调只更新锚点可见标记，真正建页交给统一入口，避免在回调里做重活
  // 若把观察器绑到 guest 上，回收瞬间就会断开，页面重新可见时无人唤醒
  const intersection = new IntersectionObserver((entries) => {
    for (const entry of entries)
      for (const anchor of anchors.values())
        if (anchor.node === entry.target) anchor.visible = entry.isIntersecting;
    if (!core && !disposed) {
      const visible = [...anchors.values()].some(
        (anchor) => anchor.visible && anchor.node.isConnected,
      );
      sandboxPages.visibility(owner, visible);
      if (visible) void ensure();
    }
  });
  // 唤醒入口先短路：已销毁、正在启动、已有 guest 或处于错误态都不再推进
  // 每次启动取新的代际号，等待之后必须比对代际，防止旧续体重建已挂起的页面
  // 失败只写入错误快照并通知，不自动重试，避免坏输入触发无限循环
  // 收尾阶段仅在代际未变时清除启动标记，避免旧代际覆盖新一代的运行状态
  // 状态推进权集中在此函数，外部只能通过锚点与可见性间接驱动
  async function ensure() {
    if (disposed || starting || core || snapshot.phase === "error") return;
    starting = true;
    const generation = ++epoch;
    try {
      await releasing;
      if (disposed || generation !== epoch) return;
      // 配额预留成功后才允许创建 guest，顺序颠倒会出现无配额的页面在运行
      // 预留后若锚点全部消失或代际已变，必须立刻归还并放弃创建
      // 归还走已释放通知，使配额账本与真实存活页面保持一致
      // 这条失败路径是内存上限的守门人，缺失时页面可无上限堆积
      await sandboxPages.reserve(owner);
      if (disposed || generation !== epoch || !anchors.size) {
        sandboxPages.released(owner);
        return;
      }
      core = createGenUiPage({
        ...input,
        confirm: (prompt) => [...confirmations.values()].at(-1)?.(prompt) ?? Promise.resolve(null),
        onVisibility: (visible) => {
          if (owner.visible !== visible) sandboxPages.visibility(owner, visible);
        },
        onSettled: () => sandboxPages.settled(owner),
      });
      const active = core;
      offCore = core.subscribe(() => {
        snapshot = active.getSnapshot();
        notify();
      });
      for (const anchor of anchors.values()) anchor.off = core.bind(anchor.node);
      snapshot = core.getSnapshot();
      notify();
    } catch (error) {
      if (!disposed && generation === epoch) fail(error);
    } finally {
      if (generation === epoch) starting = false;
    }
  }
  const stopTask = input.watchTaskRemoved(() => sandboxPages.removeTask(task));
  // 非强制挂起会拒绝正在忙碌的页面，避免打断用户进行中的生成或确认
  // 顺序固定：先递增代际并清启动标记，再摘订阅与绑定，最后置空 guest
  // 清空后立即广播空快照但保留高度，让宿主仍有占位尺寸可用
  // 释放动作进入串行队列，等待完成后才在可见状态下重新唤醒
  // 强制挂起用于销毁与重试，跳过忙碌判断但仍遵守同一清理顺序
  async function suspend(force = false) {
    if (!force && (starting || core?.isBusy())) return false;
    epoch++;
    starting = false;
    const previous = core;
    core = null;
    offCore?.();
    offCore = undefined;
    for (const anchor of anchors.values()) {
      anchor.off?.();
      anchor.off = undefined;
    }
    snapshot = { ...EMPTY_GEN_UI_SNAPSHOT, height: snapshot.height };
    notify();
    releasing = Promise.all([releasing, previous?.dispose()]).finally(() =>
      sandboxPages.released(owner),
    );
    await releasing;
    if (!force && owner.visible && !disposed) void ensure();
    return true;
  }
  const owner: RetainedGenUiPage = {
    kind: "gen-ui",
    key,
    task,
    visible: false,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    attachConfirmation(confirm) {
      const id = Symbol();
      confirmations.set(id, confirm);
      return () => {
        confirmations.delete(id);
      };
    },
    bind(node) {
      const id = Symbol(),
        anchor = { node, visible: true, off: core?.bind(node) };
      anchors.set(id, anchor);
      intersection.observe(node);
      sandboxPages.visibility(owner, true);
      void ensure();
      return () => {
        // layout cleanup 在 React 移除祖先前把活页面停放；passive cleanup 会先断开 guest。
        anchor.off?.();
        anchors.delete(id);
        if (![...anchors.values()].some((item) => item.node === node)) intersection.unobserve(node);
        if (!anchors.size) sandboxPages.visibility(owner, false);
      };
    },
    preview: (node) => core?.preview(node),
    focus: () => core?.focus(),
    copyImage: () => (core ? core.copyImage() : Promise.reject(new Error("Gen UI is not ready"))),
    setTweaks: (values) => core?.setTweaks(values),
    previewTweaks: (original) => core?.previewTweaks(original),
    submitTweaks: (values) =>
      core ? core.submitTweaks(values) : Promise.reject(new Error("Gen UI is not ready")),
    isBusy: () => starting || (core?.isBusy() ?? false),
    busy: () => owner.isBusy(),
    running: () => starting || core !== null,
    suspend,
    retry() {
      void suspend(true).then(() => {
        if (!disposed) {
          snapshot = { ...snapshot, phase: "loading", error: undefined };
          void ensure();
        }
      });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      stopTask();
      intersection.disconnect();
      confirmations.clear();
      await suspend(true);
      anchors.clear();
      listeners.clear();
    },
    destroy() {
      void owner.dispose();
    },
  };
  return owner;
}
