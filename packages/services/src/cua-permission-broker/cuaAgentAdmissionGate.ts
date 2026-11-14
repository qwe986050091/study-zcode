// CUA Agent 准入屏障：Helper recovery 期间挂起新 Agent 的启动，恢复结束后统一放行。
// 模块只维护 epoch 与等待者集合，不持有 workspace/session 状态，可独立测试。
// 默认装配已不再注入 CuaAgentAdmissionGate，这里仅为旧调用方保留兼容语义（详见下方废弃说明）。
// 调用方传入的 workspace 字段只用于关联与日志，屏障本身不按路径或身份做分区。
// 真正决定放行的是 signal 与当前 epoch；缺省 signal 表示调用方放弃取消能力。
export interface CuaAgentSpawnAdmissionContext {
  workspaceKey: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  signal?: AbortSignal;
}

// 等待者同时持有 resolve/reject；成功、失败或 abort 任一路径都需从集合移除，否则泄漏。
interface AdmissionWaiter {
  reject: (reason?: unknown) => void;
  resolve: () => void;
}

/**
 * @deprecated 默认 CUA 装配已不再注入该准入屏障，仅为旧调用方保留兼容导出。
 * 当前 Helper recovery 只影响后续 Agent admission，不会阻塞或回收已有 Agent。
 *
 * 仅保留 API 兼容性：默认生命周期已不再使用该机制隔离 Helper recovery 与 command/env
 * resolve 的并发。这里不持有 workspace/session 状态。
 */
// 单实例对应一个准入域；epoch 单调递增，旧 epoch 的 commit/fail 由 epoch 比较一律拒绝，避免迟到的
// recovery 完成事件误放行或误拒绝后来发起的新一轮等待者。
export class CuaAgentAdmissionGate {
  private nextEpoch = 0;
  private activeEpoch: number | undefined;
  private readonly waiters = new Set<AdmissionWaiter>();

// 幂等进入：已在 recovery 中时直接返回既有 epoch，避免嵌套调用推进 epoch，
// 导致先发起的等待者永远等不到对应的 commit/fail。
  beginRecovery(): number {
    // recovery 期间重复 begin 直接返回旧 epoch，不推进计数，嵌套调用不会让先来的等待者失去归属。
    if (this.activeEpoch !== undefined) {
      // 返回既有 epoch 让调用方仍可用它提交；嵌套 begin 不会产生第二个可提交的编号。
      return this.activeEpoch;
    }
    // 先自增再赋值：epoch 从 1 开始，undefined 才代表未恢复，0 永远不会成为有效值。
    this.activeEpoch = ++this.nextEpoch;
    return this.activeEpoch;
  }

// 与 waitForSpawnAdmission 使用同一判据（activeEpoch 是否存在），供调用方快速探测。
  isRecovering(): boolean {
    // 判据必须与 waitForSpawnAdmission 一致，否则探测说未恢复而实际仍会挂起。
    return this.activeEpoch !== undefined;
  }

// 契约：signal 已中止立即 reject；未处于 recovery 立即 resolve；否则登记等待者并挂起。
// abort 与 recovery 完成是两条竞争路径，谁先到达谁生效，另一条通过 removeEventListener 解绑。
// 这里不设超时：调用方必须用 signal 表达超时，否则等待可能无限期持续。
  waitForSpawnAdmission(context: CuaAgentSpawnAdmissionContext): Promise<void> {
    // signal 是唯一的取消通道；屏障本身不设超时，不给 signal 就等于接受无限期等待。
    const signal = context.signal;
    // 已中止的 signal 必须立即拒绝：abort 事件不会重放，等到 recovery 结束才 reject 会让调用方多挂一轮。
    if (signal?.aborted) {
      // reason 缺省用固定文案：AbortController.abort() 无参时 reason 是 DOMException，直接透出会丢失调用上下文。
      return Promise.reject(signal.reason ?? new Error("ZCode agent process start was cancelled."));
    }
    // 未处于 recovery 时同步放行，不登记 waiter，正常启动不会在集合里留痕。
    if (this.activeEpoch === undefined) {
      // 同步放行不额外排微任务链，调用方 await 后立刻继续启动流程。
      return Promise.resolve();
    }
    // 先建 waiter 再挂 abort 监听：顺序反了会漏掉两步之间到达的 abort。
    return new Promise<void>((resolve, reject) => {
      // 先用后置断言占位：onAbort 需要在 waiter 赋值前就能引用它，闭包捕获的是变量本身。
      let waiter!: AdmissionWaiter;
      // abort 只做移除与拒绝，不碰 activeEpoch：recovery 仍由 commit/fail 结束，两条路径互不越权。
      const onAbort = (): void => {
        // 先删再 reject：reject 回调里若同步重入，集合里已经没有这个 waiter，不会重复清理。
        this.waiters.delete(waiter);
        reject(signal?.reason ?? new Error("ZCode agent process start was cancelled."));
      };
      // waiter 的 resolve/reject 都负责解绑 abort 监听，否则已完成的 Promise 仍被 signal 持有。
      waiter = {
        resolve: () => {
          // 解绑必须用同一个 onAbort 引用；换函数或漏解绑都会让 signal 在 waiter 释放后继续回调。
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (reason) => {
          signal?.removeEventListener("abort", onAbort);
          reject(reason);
        },
      };
      // 只有传入 signal 才挂监听；无 signal 的等待者只能等 recovery 的结果。
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      // add 放在监听之后：addEventListener 若立即触发，waiter 尚未入集合，删除是空操作也不会泄漏。
      this.waiters.add(waiter);
    });
  }

// 只有当前 epoch 有权结束 recovery；过期 epoch 直接返回 false，调用方据此忽略迟到的完成事件。
// 成功后清空 active 并一次性放行全部等待者（无差别 resolve），新发起的等待会重新进入下一轮。
  commitRecovery(epoch: number): boolean {
    // epoch 不匹配说明这是上一轮的完成事件，直接返回 false 让调用方忽略，而不是抛错打断恢复流程。
    if (this.activeEpoch !== epoch) {
      return false;
    }
    // 先清 active 再放行：等待者被唤醒后重新 begin 会拿到新 epoch，不会卡在已结束的轮次。
    this.activeEpoch = undefined;
    // 一次性放行全部等待者，不做优先级或身份筛选；屏障不按 workspace 分区。
    // 放行只说明屏障解除，不代表 Agent 启动成功；等待者恢复后仍要自行处理 spawn 失败。
    this.releaseWaiters();
    // 返回 true 表示本次提交生效，调用方可据此决定是否广播恢复完成。
    return true;
  }

// 非 Error 的 reason 统一包装为 Error，保证下游 catch 拿到的类型稳定、消息可读。
// 失败路径与提交路径同样清空等待者，防止集合里残留永远无法完成的 Promise。
  failRecovery(epoch: number, error: unknown): boolean {
    // epoch 过期同样返回 false：迟到的失败事件不能清掉新一轮的 activeEpoch 与等待者。
    if (this.activeEpoch !== epoch) {
      return false;
    }
    // 清 active 后再逐个 reject：回调里重入 begin 会得到新 epoch，不会继承这一轮的等待者。
    this.activeEpoch = undefined;
    // 失败与 commit 对同一 epoch 互斥：谁先清 activeEpoch 谁生效，另一条迟到路径返回 false，
    // 不会出现「已放行后又被失败拒绝」或反过来的双重终结。
    // 非 Error 的 reason 统一包装：下游 catch 靠 instanceof 判断是否可提示，裸字符串会丢失 message。
    const reason = error instanceof Error ? error : new Error(String(error));
    // 先逐个 reject 再清空：在循环里 clear 会让部分 waiter 永远等不到结果。
    for (const waiter of this.waiters) {
      waiter.reject(reason);
    }
    // 清空放在循环之后：reject 回调里若重入 fail 或 commit，集合状态必须仍然完整。
    this.waiters.clear();
    // 失败同样代表本轮结束；返回 false 只表示 epoch 已过期，而不是错误没被处理。
    return true;
  }

// 先 resolve 再清空：每个 waiter 的 resolve 内部负责解绑各自的 abort 监听，避免悬挂。
  private releaseWaiters(): void {
    // 遍历原集合，resolve 内部只解绑各自的 abort 监听、不改集合，因此不需要先复制。
    for (const waiter of this.waiters) {
      waiter.resolve();
    }
    // 清空后集合不再持有已完成的 Promise，下一轮 recovery 从空集合开始。
    this.waiters.clear();
  }
}
