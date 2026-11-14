// INV-01 逻辑 tab 上限按 windowId 隔离：32 是单窗口上限而非进程总量。守住位置：selectBrowserTabLimitVictim 用 windowId 过滤候选，upsert 按 record.windowId 发起评估。改错故障：按全局计数会让某个窗口开 tab 时淘汰掉另一个窗口的活跃 tab。
// INV-02 records 是本模块对 residency 的唯一事实来源，物理 guest 与 CDP 仍归 BrowserGuestManager。守住位置：records 表与所有 mark/complete/fail 方法只写这里。改错故障：main 与 manager 各写一份 residency，迟到回调会让两端状态永久分裂。
// INV-03 generation 是事务代次而非自增序号，任何作废旧事务的转折都必须推进它。守住位置：upsert 复用既有 generation，markRestoring、failRestore 与 suspend 保护分支各自加一。改错故障：漏推进会让旧 suspend 或旧 restore 的迟到回执被当成当前事务。
// INV-04 upsert 是插入与更新合一，只覆盖 candidate 字段并保留 generation。守住位置：generation 取 existing?.generation ?? 0。改错故障：重置为 0 后，上一代 suspend ack 会命中新记录并误卸可见 tab。
// INV-05 所有对外返回都必须是浅拷贝快照，包括 get、list、upsert 与各个 mark 方法。守住位置：返回值统一展开成新对象。改错故障：把内部 record 交给调用方后，外部可直接改字段而绕过 report 与评估，计数和淘汰依据立刻失真。
// INV-06 任何改变上限相关字段的写入都必须紧跟一次 requestEvaluation，并传入记录所属 windowId。守住位置：upsert、report、mark 系列与 remove 末尾的调用。改错故障：漏掉一次评估就会长期超出上限，直到下一次无关变更才收敛。
// INV-07 评估是单飞串行事务：同一时刻只允许一个 evaluatePendingWindows 在跑。守住位置：evaluation 非空时直接返回。改错故障：并发评估会对同一 victim 重复调用 onEvict，造成重复关闭与 guest 双销毁。
// INV-08 pendingWindows 是按窗口合并的脏标记集合，一轮评估可连续消费多个窗口。守住位置：Set<number> 的 add、delete 与外层 while 循环。改错故障：改成单窗口或单布尔标记会吞掉其他窗口的请求，失效窗口永远不被回收。
// INV-09 preferred 与 selected 的互斥范围是同一 windowId 且同一 sessionId，不是全进程。守住位置：report 在 selected=true 时清理同窗口同 session 的其他记录。改错故障：跨 session 清除 preferred 会让多任务切换恢复到错误的主 tab。
// INV-10 lastActivityAt 只在 selected 或 visible 变为 true、以及运行时活动由 false 转 true 时前移。守住位置：runtimeActivityStarted 必须在 Object.assign 之前用旧值比较。改错故障：先合并再比较会永远判定为无变化，淘汰顺序退化成按打开时间。
// INV-11 suspend-pending 期间一旦出现可见或运行中状态，立刻作废本轮 suspend。守住位置：protectedDuringSuspend 分支推进 generation 并回到 live 系列状态。改错故障：迟到 suspend ack 会卸载用户正在看的 tab，表现为白屏后重建。
// INV-12 markRestoring 只接受 suspended，其余状态原样返回快照表示无需恢复。守住位置：residency 不等即早返回。改错故障：对 live 或 restoring 重复发起恢复会让同一 tab 多个 guest 同时 attach。
// INV-13 completeRestore 必须同时校验 generation 与 restoring 状态，任一不符都不改状态。守住位置：返回 false 的三条件判断。改错故障：只校验 tabId 会让上一代完成回调把新一代恢复标记成已结束。
// INV-14 failRestore 是恢复的唯一失败出口：推进 generation、清 loading、退回 suspended。守住位置：失败分支的四步写入。改错故障：缺少终态会让 tab 永久停在 restoring，同代迟到 guest 仍可 attach，且再也无法重发恢复。
// INV-15 commitCancelledSuspend 提交的是 renderer 已卸载的物理事实，而不是维护 main 的乐观状态。守住位置：仅当 generation 已超过 cancelledGeneration 且处于 live 系列状态时生效。改错故障：只拒绝 stale ack 会让 main 认为 tab 仍存活，两端永久分裂。
// INV-16 markAttached 在 restoring 状态必须携带匹配的 generation，未携带即视为旧 guest。守住位置：generation 为 undefined 与不相等都被拒绝。改错故障：放行旧 guest 会抢走新恢复事务的所有权，可见性与 loading 被旧值覆盖。
// INV-17 markDetached 只清 guestAttached，不动 residency，逻辑 shell 仍计入上限。守住位置：该方法不修改 residency。改错故障：顺手改成 suspended 会让仍在用的 shell 提前退出计数，并可能被当成已卸载再次恢复。
// INV-18 dispose 之后 requestEvaluation 与评估循环都必须停止。守住位置：requestEvaluation 与 while 循环的 disposed 判断。改错故障：退出过程中仍会调用 onEvict 关闭窗口，产生关闭期竞态与未捕获异常。
//
// 模块职责：维护每个 tab 的 logical residency、preferred 与 selected 归属以及窗口级上限，超限时必须串行挑选 victim 交给 onEvict。
// 状态所有权：records、pendingWindows、evaluation、disposed 必须全归本类；物理 guest 与 CDP 归 BrowserGuestManager，本类只消费其事件。
// 阅读顺序：先看 options 与字段契约，再读 upsert 与 report 的写入口，然后按 restoring 与 suspend 事务分支阅读，最后看 requestEvaluation 与 evaluatePendingWindows 的串行收口。
import {
  BROWSER_TAB_LIMIT,
  selectBrowserTabLimitVictim,
  type BrowserTabResidencyCandidate,
} from "./browserTabResidencyPolicy.js";

export interface BrowserTabResidencyRecord extends BrowserTabResidencyCandidate {
  generation: number;
}

// options 是唯一注入点：tabLimit 用于测试覆盖上限，未提供时回落到 BROWSER_TAB_LIMIT。
// now 让淘汰顺序在测试中可确定，未提供时回落到 Date.now。
// onEvict 是唯一副作用出口，返回 true 表示本次关闭成功、可以继续挑下一个 victim。
// 返回 false 视为调用方已不能继续关闭，本轮评估立刻 break，避免无限重试。
// 易错点：onEvict 抛错不会被这里捕获，窗口此时已从 pendingWindows 删除，该窗口不会被自动重试，异常会直接冒到 whenIdle 的等待方。
interface BrowserTabResidencyCoordinatorOptions {
  tabLimit?: number;
  now?: () => number;
  onEvict(record: BrowserTabResidencyRecord): Promise<boolean>;
}

/**
 * 每个 main 进程实例协调所有 BrowserWindow，但逻辑 tab 上限与 victim 选择都按 window 隔离。
 * BrowserGuestManager 仍拥有 guest/CDP；本类只维护正交 residency 状态与串行关闭事务。
 */
export class BrowserTabResidencyCoordinator {
  // records 以 tabId 为键，跨窗口共享一张表；窗口隔离靠记录内的 windowId 过滤，而不是按窗口拆多张表。
  // pendingWindows 只保存待评估的 windowId，不记账次数，重复请求自然合并成一次。
  // evaluation 是单飞 Promise 的句柄，非空表示本轮已在排队或执行中。
  // disposed 是终止闸门，置位后不再接受任何新的评估请求。
  // 易错点：这四个字段都由本类独占管理，清理只能走 dispose 与 remove，外部提前清空会让并发中的评估读到半途状态。
  private readonly records = new Map<string, BrowserTabResidencyRecord>();
  private readonly pendingWindows = new Set<number>();
  private evaluation: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly options: BrowserTabResidencyCoordinatorOptions) {}

  // upsert 是 tab 创建与元数据刷新的唯一入口，先取旧记录再合并。
  // candidate 中的字段会被整体覆盖，因此调用方每次必须传完整快照，不能只传变化的 diff。
  // 返回快照而非内部对象，调用方长期持有也不会影响后续评估。
  // 易错点：不要在 upsert 里顺手重置 residency，状态迁移统一由 report 与恢复事务负责，否则会绕过代次校验。
  upsert(candidate: BrowserTabResidencyCandidate): BrowserTabResidencyRecord {
    const existing = this.records.get(candidate.tabId);
    const record: BrowserTabResidencyRecord = {
      ...candidate,
      generation: existing?.generation ?? 0,
    };
    this.records.set(candidate.tabId, record);
    this.requestEvaluation(record.windowId);
    return { ...record };
  }

  get(tabId: string): BrowserTabResidencyRecord | null {
    const record = this.records.get(tabId);
    return record ? { ...record } : null;
  }

  list(): BrowserTabResidencyRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  // report 是运行期状态的唯一写入口，patch 只允许十项声明过的字段。
  // 未登记的 tabId 直接忽略，避免已移除 tab 的迟到事件复活记录。
  // selected=true 时同窗口同 session 的其他记录必须让出 preferred，并同时刷新选中与活动时间。
  // 易错点：patch 字段与 record 同名，所有派生判断都要在合并前用旧值算完，否则比较基准已被覆盖。
  report(
    tabId: string,
    patch: Partial<
      Pick<
        BrowserTabResidencyRecord,
        | "currentTask"
        | "selected"
        | "visible"
        | "loading"
        | "operationActive"
        | "captureActive"
        | "audible"
        | "mediaActive"
        | "downloadActive"
      >
    >,
  ): void {
    const record = this.records.get(tabId);
    if (!record) return;
    const now = this.now();
    const runtimeActivityStarted = (
      [
        "operationActive",
        "captureActive",
        "audible",
        "mediaActive",
        "loading",
        "downloadActive",
      ] as const
    ).some((key) => patch[key] === true && record[key] !== true);
    Object.assign(record, patch);
    if (patch.selected === true) {
      for (const candidate of this.records.values()) {
        if (
          candidate.tabId !== record.tabId &&
          candidate.windowId === record.windowId &&
          candidate.sessionId === record.sessionId
        ) {
          candidate.preferred = false;
        }
      }
      record.preferred = true;
      record.lastSelectedAt = now;
      record.lastActivityAt = now;
    }
    if (patch.visible === true) record.lastActivityAt = now;
    if (runtimeActivityStarted) record.lastActivityAt = now;

    // 保护判定只在 suspend-pending 有意义：此时 renderer 可能已收到 suspend，main 尚未确认。
    // 可见、selected、加载中、操作或采集活跃、有声、媒体与下载都必须算受保护，任一成立就必须撤销本轮淘汰。
    // 撤销方式是推进 generation 再回到 live 系列状态，让旧 suspend ack 因代次不符而失效。
    // 紧随其后的状态归一化跳过 suspended、restoring、suspend-pending，避免把进行中的事务提前结束。
    // 易错点：把保护判定放到 Object.assign 之后，新值会掩盖旧状态，判断恒为假，可见 tab 仍会被卸载。
    const protectedDuringSuspend =
      record.residency === "suspend-pending" &&
      (record.selected ||
        record.visible ||
        record.loading ||
        record.operationActive ||
        record.captureActive ||
        record.audible ||
        record.mediaActive ||
        record.downloadActive);
    if (protectedDuringSuspend) {
      // 迟到 suspend ack 只能命中旧 generation；保护状态出现后立即取消本轮淘汰。
      record.generation += 1;
      record.residency = record.visible ? "live-visible" : "live-background";
    }
    if (
      record.residency !== "suspended" &&
      record.residency !== "restoring" &&
      record.residency !== "suspend-pending"
    ) {
      record.residency = record.visible ? "live-visible" : "live-background";
    }
    this.requestEvaluation(record.windowId);
  }

  // markRestoring 是恢复事务起点：只有 suspended 能进入，其余状态返回当前快照表示无需重复恢复。
  // 进入时必须推进 generation、置 restoring 与 loading=true，并把受理时间记为活动时间。
  // completeRestore 只接受同一 generation 的 restoring，成功后清 loading 并回到 live 系列状态。
  // 易错点：恢复期间被 detach 或新 suspend 打断时只能靠 generation 变化识别，不能只比较 tabId。
  markRestoring(tabId: string): BrowserTabResidencyRecord | null {
    const record = this.records.get(tabId);
    if (!record) return null;
    if (record.residency !== "suspended") return { ...record };
    record.generation += 1;
    record.residency = "restoring";
    record.loading = true;
    record.lastActivityAt = this.now();
    this.requestEvaluation(record.windowId);
    return { ...record };
  }

  completeRestore(tabId: string, generation: number): boolean {
    const record = this.records.get(tabId);
    if (!record || record.generation !== generation || record.residency !== "restoring") {
      return false;
    }
    record.loading = false;
    record.residency = record.visible ? "live-visible" : "live-background";
    record.lastActivityAt = this.now();
    this.requestEvaluation(record.windowId);
    return true;
  }

  failRestore(tabId: string, generation: number): BrowserTabResidencyRecord | null {
    const record = this.records.get(tabId);
    if (!record || record.generation !== generation || record.residency !== "restoring") {
      return null;
    }
    // attach timeout/恢复取消原来没有失败终态，tab 会永久停在 restoring，
    // 且同 generation 的迟到 guest 仍能 attach。推进 generation 后回到 suspended，
    // 下一次访问才能安全重发恢复事务。
    record.generation += 1;
    record.loading = false;
    record.residency = "suspended";
    record.lastActivityAt = this.now();
    this.requestEvaluation(record.windowId);
    return { ...record };
  }

  // commitCancelledSuspend 处理取消恢复后的对账：renderer 已卸载，main 必须跟着落地。
  // generation 小于等于 cancelledGeneration 表示这是过期请求，直接不处理。
  // 只对 live-visible 与 live-background 生效，说明 main 仍以为 tab 存活，必须补一次提交。
  // 易错点：把取消当成普通 stale ack 忽略，会留下一个没有 guest 的 live 记录，后续淘汰与恢复全部算错。
  commitCancelledSuspend(
    tabId: string,
    cancelledGeneration: number,
  ): BrowserTabResidencyRecord | null {
    const record = this.records.get(tabId);
    if (
      !record ||
      record.generation <= cancelledGeneration ||
      (record.residency !== "live-visible" && record.residency !== "live-background")
    ) {
      return null;
    }
    // renderer 已收到旧 suspend 后，main 仅拒绝 stale ack 会造成两端分裂。
    // 此处提交 renderer 已卸载的物理事实，随后 manager 再用新 generation 完整恢复。
    record.loading = false;
    record.residency = "suspended";
    record.lastActivityAt = this.now();
    this.requestEvaluation(record.windowId);
    return { ...record };
  }

  // markAttached 记录物理 attach 事实，并顺带同步可见性。
  // restoring 期间的 attach 必须带匹配 generation，未携带或不匹配都返回 false，由调用方丢弃该 guest。
  // 非 restoring 状态下不覆盖 residency，只按 visible 归一化，避免把 suspend-pending 提前结束。
  // 易错点：markDetached 只清 guestAttached 而不改 residency，逻辑 shell 仍占上限，这是有意的计数口径。
  markAttached(tabId: string, visible: boolean, generation?: number): boolean {
    const record = this.records.get(tabId);
    if (!record) return false;
    if (
      record.residency === "restoring" &&
      (generation === undefined || generation !== record.generation)
    ) {
      return false;
    }
    record.guestAttached = true;
    record.visible = visible;
    if (record.residency !== "restoring") {
      record.residency = visible ? "live-visible" : "live-background";
    }
    record.lastActivityAt = this.now();
    this.requestEvaluation(record.windowId);
    return true;
  }

  markDetached(tabId: string): void {
    const record = this.records.get(tabId);
    if (!record) return;
    // guest destroyed/detach 后 logical residency 仍可能暂时是 live-background。
    // 单独清除物理事实；logical shell 仍计入 32 个上限，也允许在没有 guest 时被完整关闭。
    record.guestAttached = false;
    this.requestEvaluation(record.windowId);
  }

  isTransitionCurrent(
    tabId: string,
    generation: number,
    residency: BrowserTabResidencyRecord["residency"],
  ): boolean {
    const record = this.records.get(tabId);
    return Boolean(record && record.generation === generation && record.residency === residency);
  }

  remove(tabId: string): void {
    const record = this.records.get(tabId);
    if (!record) return;
    this.records.delete(tabId);
    this.requestEvaluation(record.windowId);
  }

  async whenIdle(): Promise<void> {
    await this.evaluation;
  }

  dispose(): void {
    this.disposed = true;
    this.pendingWindows.clear();
    this.records.clear();
  }

  private requestEvaluation(windowId: number): void {
    if (this.disposed) return;
    this.pendingWindows.add(windowId);
    if (this.evaluation) return;
    this.evaluation = Promise.resolve()
      .then(() => this.evaluatePendingWindows())
      .finally(() => {
        this.evaluation = null;
        if (this.pendingWindows.size > 0) {
          const nextWindowId = this.pendingWindows.values().next().value as number | undefined;
          if (nextWindowId !== undefined) this.requestEvaluation(nextWindowId);
        }
      });
  }

  // requestEvaluation 只登记脏窗口并保证单飞，实际剔除逻辑全部在这里。
  // finally 中先清空 evaluation 再按剩余窗口重新发起，评估期间新增的请求不会丢，也不会并发执行。
  // 外层消费窗口、内层反复挑选 victim，直到无可淘汰对象或 onEvict 拒绝。
  // records 查找可能落空，因为 onEvict 期间记录可能已被外部移除，命中时直接继续而不是中断整轮。
  // 易错点：onEvict 成功后这里会自行 remove，若是 manager 已先移除，remove 必须幂等，不能因此报错或重复关闭。
  private async evaluatePendingWindows(): Promise<void> {
    while (!this.disposed && this.pendingWindows.size > 0) {
      const windowId = this.pendingWindows.values().next().value as number;
      this.pendingWindows.delete(windowId);
      while (!this.disposed) {
        const victim = selectBrowserTabLimitVictim([...this.records.values()], {
          windowId,
          tabLimit: this.options.tabLimit ?? BROWSER_TAB_LIMIT,
        });
        if (!victim) break;
        const record = this.records.get(victim.tabId);
        if (!record) continue;
        const evicted = await this.options.onEvict({ ...record });
        if (!evicted) break;
        // manager 的 durable close 会先移除本记录；纯协调器调用方则由这里收口。
        this.remove(record.tabId);
      }
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
