// INV-01 页面按 key 唯一：守住位置 pages 映射；改错故障 同 key 覆盖活页面。
// INV-02 每个任务一组 key：守住位置 tasks；改错故障 无法按任务回收。
// INV-03 任务上限三十：守住位置 容量判断；改错故障 后台任务无限增长。
// INV-04 沙箱槽位上限六十四：守住位置 reserve；改错故障 同时存活页面失控。
// INV-05 所有准入串行：守住位置 admission 链；改错故障 并发添加突破容量。
// INV-06 取消标记先于入队：守住位置 pendingAdds；改错故障 已移除页面仍被创建。
// INV-07 回收只选不可见且空闲：守住位置 候选过滤；改错故障 正在使用的页面被销毁。
// INV-08 挂起失败即换下一个：守住位置 suspend 返回值；改错故障 回收卡在首个候选。
// INV-09 回收后再次校验页面身份：守住位置 第二次判断；改错故障 撤销的槽位被旧页占用。
// INV-10 重复 key 直接报错：守住位置 pages.has；改错故障 两个 controller 同时持有。
// INV-11 隐藏延迟回收：守住位置 五分钟计时；改错故障 切走即销毁丢失状态。
// INV-12 计时器按 key 单份：守住位置 timers；改错故障 重复隐藏叠加多个计时。
// INV-13 可见时刷新任务顺序：守住位置 删除后重设；改错故障 淘汰顺序长期不变。
// INV-14 结算时无计时才挂起：守住位置 settled；改错故障 与计时器重复挂起。
// INV-15 释放只移除分配记录：守住位置 released；改错故障 连活页面一起销毁。
// INV-16 移除任务清理全部页面：守住位置 removeTask；改错故障 键集合残留。
// INV-17 清空先取消全部在途：守住位置 clear；改错故障 关闭后仍有页面创建。
// INV-18 管理器不直接渲染：守住位置 类职责；改错故障 视图与生命周期耦合。
//
// 模块职责：管理窗口级 MCP App 页面的准入、容量与回收。
// 状态所有权：页面、任务、计时器与准入链均由管理器独占。
// 阅读顺序：先看添加与预留的准入，再看可见性回收，最后看移除与清空。
/** 窗口级页面 owner。视图只持锚点租约，切位置不会销毁 controller 或活页面。 */
export interface ManagedPluginPage {
  readonly key: string;
  readonly task: string;
  visible: boolean;
  busy(): boolean;
  running(): boolean;
  suspend(): void | Promise<boolean | void>;
  destroy(): void;
}
// 按 key 持有窗口级页面。
// 任务集合用于容量与回收。
// 准入链保证操作串行。
export class PluginUiPageManager<T extends ManagedPluginPage> {
  private readonly allocated = new Set<T>();
  private admission: Promise<void> = Promise.resolve();
  private readonly pages = new Map<string, T>();
  private readonly tasks = new Map<string, Set<string>>();
  private readonly timers = new Map<string, () => void>();
  private readonly pendingAdds = new Map<T, { cancelled: boolean }>();
  constructor(
    private readonly timer: (run: () => void, ms: number) => () => void,
    private readonly clearTask: (task: string) => void,
    private readonly changed: (key: string) => void = () => {},
  ) {}
  get(key: string): T | undefined {
    return this.pages.get(key);
  }
  // add 先把 { cancelled: false } 登记进 pendingAdds，再入队。
  // 准入逻辑挂到 this.admission 上，所有添加与预留共用一条串行链。
  // 队首轮到该次添加时先查 admission.cancelled，已取消就抛错不占槽位。
  add(page: T): Promise<void> {
    const admission = { cancelled: false };
    this.pendingAdds.set(page, admission);
    const pending = this.admission
      .then(async () => {
        if (admission.cancelled) throw new Error("MCP App task was removed");
        if (this.pages.has(page.key)) throw new Error("Duplicate MCP App page owner");
        // 新 task 且 this.tasks.size 已达 30 时才进入候选回收。
        // 候选路径跳过任何 visible 或 busy() 为真的页面。
        // evicted 仍为 false 就抛出 "MCP App task capacity reached"。
        if (!this.tasks.has(page.task) && this.tasks.size >= 30) {
          let evicted = false;
          for (const [task, keys] of this.tasks) {
            const candidates = [...keys]
              .map((key) => this.pages.get(key))
              .filter((p): p is T => p !== undefined);
            if (candidates.some((p) => p.visible || p.busy())) continue;
            let idle = true;
            for (const background of candidates) {
              if ((await background.suspend()) === false) {
                idle = false;
                break;
              }
            }
            if (admission.cancelled) throw new Error("MCP App task was removed");
            if (candidates.some((p) => p.visible || p.busy())) continue;
            if (!idle) continue;
            this.removeTask(task);
            evicted = true;
            break;
          }
          if (!evicted) throw new Error("MCP App task capacity reached");
        }
        const keys = this.tasks.get(page.task) ?? new Set<string>();
        this.tasks.delete(page.task);
        this.tasks.set(page.task, keys);
        keys.add(page.key);
        this.pages.set(page.key, page);
      })
      .finally(() => this.pendingAdds.delete(page));
    this.admission = pending.catch(() => undefined);
    return pending;
  }
  // reserve 开头 allocated.has(page) 为真直接 return，不重复占槽。
  // running.length 小于 64 才分配，64 是沙箱槽位上限。
  // 超过上限时遍历 allocated，跳过 visible 或 busy() 的候选。
  reserve(page: T): Promise<void> {
    const pending = this.admission.then(async () => {
      if (this.allocated.has(page)) return;
      if (this.pages.get(page.key) !== page) throw new Error("MCP App page was removed");
      const running = [...this.allocated];
      if (running.length < 64) {
        this.allocated.add(page);
        return;
      }
      for (const candidate of running) {
        if (candidate.visible || candidate.busy()) continue;
        if ((await candidate.suspend()) === false) continue;
        this.allocated.delete(candidate);
        // 回收等待期间任务可能被删除；旧 admission 不得重新占用已经撤销的槽位。
        if (this.pages.get(page.key) !== page) throw new Error("MCP App page was removed");
        this.allocated.add(page);
        return;
      }
      throw new Error("MCP App sandbox capacity reached");
    });
    this.admission = pending.catch(() => undefined);
    return pending;
  }
  released(page: T): void {
    this.allocated.delete(page);
  }
  // visibility 先比对 pages.get(page.key) 与入参，不是同一对象就 return。
  // 隐藏分支用 timer 起 5 * 60_000 毫秒计时，到点再判一次可见与忙闲。
  // 可见分支删掉 tasks 里的旧条目再重设，把该任务挪到 Map 末尾。
  visibility(page: T, visible: boolean): void {
    if (this.pages.get(page.key) !== page) return;
    page.visible = visible;
    this.timers.get(page.key)?.();
    this.timers.delete(page.key);
    if (visible) {
      const keys = this.tasks.get(page.task)!;
      this.tasks.delete(page.task);
      this.tasks.set(page.task, keys);
    } else
      this.timers.set(
        page.key,
        this.timer(() => {
          this.timers.delete(page.key);
          if (!page.visible && !page.busy()) page.suspend();
        }, 5 * 60_000),
      );
  }
  settled(page: T): void {
    if (this.pages.get(page.key) !== page) return;
    if (!page.visible && !page.busy() && !this.timers.has(page.key)) page.suspend();
  }
  // removeTask 先扫 pendingAdds，把同 task 的在途添加标记 cancelled。
  // 再按 key 逐个 pages.delete、清计时器并调用 page.destroy()。
  // 最后 clearTask(task) 通知外部把该任务从列表移除。
  removeTask(task: string): void {
    for (const [page, pending] of this.pendingAdds) {
      if (page.task === task) pending.cancelled = true;
    }
    const keys = this.tasks.get(task);
    if (!keys) return;
    this.tasks.delete(task);
    for (const key of keys) {
      const page = this.pages.get(key);
      this.pages.delete(key);
      this.timers.get(key)?.();
      this.timers.delete(key);
      page?.destroy();
      this.changed(key);
    }
    this.clearTask(task);
  }
  clear(): void {
    for (const pending of this.pendingAdds.values()) pending.cancelled = true;
    for (const task of this.tasks.keys()) this.removeTask(task);
  }
}
