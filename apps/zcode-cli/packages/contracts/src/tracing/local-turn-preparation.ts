import { LOCAL_TTFT_MAX_PENDING, localTtftNow, type LocalTtftDetail } from "@zcode/shared";

// ---------------------------------------------------------------
// 本地 turn 准备阶段观测：把 core 的同步阶段事实交给 CLI recorder
//
// 生产者：core 在本地 turn 的准备阶段调用 beginLocalTurnPreparation。
// 消费者：bootstrap 的 LocalTtftRecorder 通过 observeLocalTurnPreparation 订阅，
// 记录每个阶段的 start/end/outcome，再经 V4 协议投影成首 token 诊断。
// 时间口径：start/end 全部来自 localTtftNow()（performance.timeOrigin + performance.now()），
// 是同一时钟源下的绝对毫秒，不经过本地日期格式化；因此跨午夜、时区切换或
// 夏令时都不会把一次 turn 的阶段算到前一天或产生负时长。不要改用 Date 的
// getHours/getDate 或 UTC 分桶来推导阶段时间。
// 隔离边界：观测是旁路，订阅回调抛错/超限只丢弃事实，不能改变 core 的返回值或异常。
// ---------------------------------------------------------------

/**
 * 本地 turn 准备阶段：从共享协议的 LocalTtftDetail 中挑出属于“准备期”的子集，
 * 并补一个 `execution` 阶段表示准备结束、进入模型执行。
 *
 * 生产者：core 在对应阶段开始时传入（stage 由调用点决定）。
 * 消费者：LocalTtftRecorder 按 stage 写入 details 或 executionAt。
 * 不变量：`attempt`/`retry_wait`/`user_confirmation` 属于响应期而非准备期，必须排除；
 * `execution` 是本地补充值，不属于共享协议枚举，recorder 需单独处理。
 */
type PreparationStage =
  | Exclude<LocalTtftDetail["stage"], "attempt" | "retry_wait" | "user_confirmation">
  | "execution";

/**
 * 一条准备阶段事实：同一个 `id` 的 start 与 end 配对，end 缺省表示仍在进行中。
 *
 * 生产者：beginLocalTurnPreparation 发布开始与收尾两条事实。
 * 消费者：LocalTtftRecorder 以 id 合并、按 outcome 判定阶段结果。
 * 不变量：sessionId/turnId 来自 trace（必须同时存在，否则不发布）；
 * start/end 使用 localTtftNow 的毫秒值，end ≥ start；outcome 一旦给出不可再改。
 */
export interface LocalTurnPreparationFact {
  sessionId: string;
  turnId: string;
  /** 阶段事实 ID：`prepare:<订阅序号>`，同一 turn 内单调递增且唯一。 */
  id: string;
  stage: PreparationStage;
  start: number;
  end?: number;
  outcome?: "completed" | "failed" | "cancelled";
}
type Subscription = { publish: (fact: LocalTurnPreparationFact) => void; sequence: number };
// 仅保存观察回调，不保存业务输入或阶段事实；CLI recorder 独占事实与订阅生命周期。
const subscriptions = new Map<string, Subscription>();
const noop = () => {};
/**
 * 订阅某个输入（queryId）的准备阶段事实：recorder 在接纳输入时登记、首输出或结束时解绑。
 *
 * 生产者：bootstrap 的 LocalTtftRecorder（每个 commandId 一次）。
 * 消费者：beginLocalTurnPreparation 按 trace.queryId 查找对应回调。
 * 不变量：登记表只存回调与序号，不存业务输入；容量达到 LOCAL_TTFT_MAX_PENDING
 * 或同一 inputId 重复登记时返回 noop，绝不淘汰既有订阅（否则会丢正在进行的 turn）。
 * 返回的取消函数必须幂等，且只能删除自己那次登记（防止旧订阅误删新订阅）。
 */
export function observeLocalTurnPreparation(
  inputId: string,
  publish: Subscription["publish"],
): () => void {
  if (subscriptions.size >= LOCAL_TTFT_MAX_PENDING || subscriptions.has(inputId)) return noop;
  const subscription = { publish, sequence: 0 };
  subscriptions.set(inputId, subscription);
  return () => {
    if (subscriptions.get(inputId) === subscription) subscriptions.delete(inputId);
  };
}
/**
 * 发布一条准备阶段事实，并返回收尾函数；返回 noop 表示当前 trace 不可观测。
 *
 * 生产者：core 的准备阶段边界（阶段开始即调用，结束时调用返回的函数）。
 * 消费者：已登记的 recorder；事实只进入本地 TTFT 诊断，不写入会话事件。
 * 不变量：必须同时具备 queryId/sessionId/turnId 才发布，缺一即静默跳过；
 * start 与 end 都取 localTtftNow，避免用墙钟日期导致跨午夜错位。
 * 收尾函数幂等（只发布一次 end），且发布前会复核订阅仍是同一个实例；
 * 订阅回调抛错被吞掉，不影响 core 主流程。
 */
export function beginLocalTurnPreparation(
  trace: { queryId?: string; sessionId?: string; turnId?: string },
  stage: PreparationStage,
): (outcome?: LocalTurnPreparationFact["outcome"]) => void {
  const subscription = trace.queryId ? subscriptions.get(trace.queryId) : undefined;
  if (!subscription || !trace.sessionId || !trace.turnId) return noop;
  const fact: LocalTurnPreparationFact = {
    sessionId: trace.sessionId,
    turnId: trace.turnId,
    id: `prepare:${subscription.sequence++}`,
    stage,
    start: localTtftNow(),
  };
  const publish = (value: LocalTurnPreparationFact) => {
    // 观测回调失败不得改变 Core 的返回值或异常；首输出解绑后不再补采工具循环。
    if (subscriptions.get(trace.queryId!) !== subscription) return;
    try {
      subscription.publish(value);
    } catch {
      /* 遥测不参与业务裁决。 */
    }
  };
  publish(fact);
  let ended = false;
  return (outcome = "completed") => {
    if (ended) return;
    ended = true;
    publish({ ...fact, end: localTtftNow(), outcome });
  };
}
