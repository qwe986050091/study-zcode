// ============================================================
// Dynamic Workflow Run Port：就地改一个在飞 run 的并发上界
// ============================================================
// docs/dynamic-workflow/concurrency.md「Retuning a live run」。与情势截面
// （dynamic-workflow-run-roster.port.ts）同一条拆分理由：dynamic-workflow-run.port.ts 顶到
// oxlint max-lines 上限（400 行），而这三个类型自成一组。公开面不变——那边原样再导出，
// `@zcode/contracts` 的导入路径一字不改。
//
// 【原子性】retune 不是「新建一个 run」，而是**同一个 runId 的一次设置改写**：换引擎的 caps、
// 写 `dwf_run.caps_max_concurrency`、记 `run-caps-changed` 三件事在一个同步片里发生或者一件都
// 不发生（服务随后才挪自己那份内存副本）。所以这里没有版本号 / generation 字段：基线就是
// **此刻生效的上界**，由结果里的 `previous` / `current` 如实报出；不匹配不是「冲突」而是
// `unchanged`，调用方不需要（也没有办法）做 compare-and-swap。

/**
 * 【契约坐标】生产者：core 的 `AmendWorkflow` handler（`max_concurrency` 的 retune 分支）与 GUI
 * 的 `amendWorkflowRunSettings`；消费者：bootstrap 的 `retuneRunConcurrency`。`runId` 必须在
 * 本进程的注册表里且未结算，否则 `not_live`——retune 只对活 run 有意义，已结算的 run 改上界
 * 是无声的空操作。`null` 是三态的工具面归一之后的结果，不是「没传」。
 *
 * {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunPort.retuneConcurrency}
 * 的请求。
 */
export interface DynamicWorkflowRunRetuneRequest {
  runId: string;
  /**
   * 新的并发上界。`null` = 天花板 = 解除本 run 自己的限制（与 `AmendWorkflow` 的
   * `max_concurrency: null` 同义）。给了数就钳到 `[1, 天花板]`——钳制用的是端口自己那一份实现，
   * 工具层无须、也不该再钳一次得到第二个答案。
   */
  maxConcurrency: number | null;
}

/**
 * 【契约坐标】两种拒绝在**不同地方**判定，这正是它们分得开的原因：`unchanged` 由服务在读自己
 * 那份上界时判完（句柄还没被调），`not_live` 剩下唯一的成因——句柄存在但 `setMaxConcurrency`
 * 回 false，即 run 在存活判定与调用之间结算了。生产者：`retuneRunConcurrency`；消费者：
 * `AmendWorkflow` / GUI 的回落路径（前者回落到一次真正的修订）。
 *
 * retune 被拒的结构化理由。两者对调用方是**两个不同的下一步**，所以必须可分辨：
 *
 *   - `not_live`：本 service 手上没有这个在飞 run（从来不是本进程的、已经结算的），或者它恰好
 *     在存活判定与本次调用之间结算了。调用方回落到一次真正的修订（`AmendWorkflow` 的既有那条路）。
 *   - `unchanged`：值与此刻生效的上界相同。什么都没写、什么都没停——`current` 就是那个值，
 *     调用方据它写出「已经是 n 了」。
 */
export type DynamicWorkflowRunRetuneRefusalReason = "not_live" | "unchanged";

/**
 * 【契约坐标】成功时三件事都已落地：引擎 caps（调度器现读）、`dwf_run` 行、`run-caps-changed`
 * 事件；服务随后才改自己那份内存副本，所以读面（快照 / 详情）立刻报新值。`previous` 与
 * `defaultConcurrency` 都只有端口这一侧知道——事件日志要写「8 → 2」，模型回话要在等于默认
 * 并发时注明「（默认）」，让调用方重算就是第二份默认并发实现。失败里 `current` 的在场规则
 * 是「还读得到就给」：`unchanged` 恒有，`not_live` 视结算时是否已清掉条目。
 *
 * retune 的结构化结果。失败走 reason 而不是 throw，与
 * {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunAmendResult} 同一条论证：
 * 两种理由都是调用方可预期的业务分支。
 *
 * `defaultConcurrency` 与 `previous` 不是锦上添花：模型面的回话要说「至多 n 个子代理同时运行」，而
 * n 等于默认并发时要注明「（默认）」（与 `CreateWorkflow` 的回话同一条判据）；事件日志要说「8 → 2」，
 * 从单个新值推不出前一个。两者都只有端口这一侧知道，留给调用方重算就是第二份默认并发实现。
 */
export type DynamicWorkflowRunRetuneResult =
  | { ok: true; maxConcurrency: number; previous: number; defaultConcurrency: number }
  | {
      ok: false;
      reason: DynamicWorkflowRunRetuneRefusalReason;
      /** 此刻生效的上界；`unchanged` 恒在场，`not_live` 只在还读得到时在场。 */
      current?: number;
    };
