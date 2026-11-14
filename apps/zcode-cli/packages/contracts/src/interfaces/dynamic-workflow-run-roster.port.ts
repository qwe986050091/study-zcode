// ============================================================
// Dynamic Workflow Run 的**情势截面**：阶段 / 子代理 / 健康
// ============================================================
// 从 dynamic-workflow-run.port.ts 拆出，理由与 dwf-journal-introspection.ts 同一条：那份契约
// 已到 oxlint 的 max-lines 上限。公开面不变——主端口文件原地再导出这里的每一个名字，
// `@zcode/contracts` 的导入路径逐字不动。
//
// 三组字段挂在 `DynamicWorkflowRunDetail` 上，由读面在 `getRunDetail` 里读时派生；
// 契约与不变式见下方各类型的注释。

// 一条贯穿三组的纪律：**时间只有一个来源**，即 `dwf_event.time_created`（事件落 journal 的
// 时刻）。读者现取 `Date.now()` 兜底是错的——那会把一次冷读里一周前的整段历史全标成「刚刚」，
// 而这三组字段存在的全部理由就是让「多久以前」可信。没有这个列的老 journal 一律让时间字段
// **缺席**，不给 0、不给 NaN。
//
// 【投影而非事实】三组字段都是 `getRunDetail` 的**读时派生**：输入是 journal 事件 + 注册表
// 条目的活体停驻表，输出不写库、不进快照。因此同一个 run 隔一秒读可以不同（`state` / `wait`
// 是活的），而 `name` / `siteId` / `ordinal` 这类身份字段恒定。读者不得把这里的派生结果当成
// 持久状态去与 journal 对账——对不上的地方以 journal 为准。
//
// 【缺席规则】整对象只在「有话说」时在场：`concurrency` 只在被限流时、`phases` 在既没声明也
// 没进入过时、`pendingQuestions` 在无法回答时——缺席是**陈述**（「没必要说」/「不知道」），
// 不是零值。读端区分「缺席」与「空数组」这两句话。

/**
 * 【契约坐标】四种状态的**判定顺序**是契约的一部分（见下段的读序）：先判「run 死活」再判
 * 「有没有未结算 ask」最后才是「进入过没有」。生产者：`dynamic-workflow-run-roster-phases`；
 * 消费者：详情侧板的阶段轨道。状态是派生值，不落库；`ahead` 与 `rounds: 0` 的绑定是唯一
 * 可靠的判据，读端不要只看状态名去推轮次。
 *
 * 一个阶段在情势截面里的处境。
 *
 * - `ahead`：脚本声明了它，控制流还没到——**唯一** `rounds: 0` 的状态；
 * - `current`：run 还活着，且它是最后进入的那个阶段；
 * - `unfinished`：run 已终态，而这个阶段里还有没结算的 ask（进程死在它下面）；
 * - `done`：其余。
 */
export type DynamicWorkflowRunPhaseState = "done" | "current" | "ahead" | "unfinished";

/**
 * 【契约坐标】`name` 是作者原词，与 `run-launched.phaseNames` / `phase-entered.name` 同一词表，
 * 因此跨进程可靠；`rounds` / `nodesSettled` / `nodesRunning` 是 journal 行的聚合；`enteredAt` /
 * `exitedAt` 取**最近一次**进入与离开（回边绕圈时读者问的是「这一圈进来多久了」）。生产者：
 * 阶段投影；消费者：详情与侧栏迷你轨道。run 没声明也没进入过任何阶段时整字段缺席。
 *
 */
/** 情势截面里的一个阶段（`phase("…")` 标记）。 */
export interface DynamicWorkflowRunPhaseView {
  /** 作者原词，与 `run-launched.phaseNames` / `phase-entered.name` 同一个词表。 */
  name: string;
  state: DynamicWorkflowRunPhaseState;
  /** 被进入过几次（同名再入即 +1）。`ahead` 恒为 0，其余恒 ≥ 1。 */
  rounds: number;
  /** 出生在这个阶段的节点里已结算 / 未结算的条数。 */
  nodesSettled: number;
  nodesRunning: number;
  /**
   * **最近一次**进入的时刻，以及那一次的离开时刻（下一个异名 `phase-entered` 的时刻）。
   * 取最近一次而不是第一次：一个被回边绕了三圈的阶段，读者要问的是「这一圈进来多久了」。
   * 当前阶段没有离开时刻；事件缺时间戳时两者一并缺席。
   */
  enteredAt?: number;
  exitedAt?: number;
}

/**
 * 【契约坐标】前四种只在 run 未终态时有意义，后三种在终态后**顶替**它们（活着的词全部退场）。
 * 生产者：`dynamic-workflow-run-roster-subagents`（读事件顺序：parked → waiting → executing →
 * failed → idle）；消费者：详情侧板的子代理卡。`parked` 依赖进程内的停驻表，因此当
 * `health.pendingQuestionsKnown` 为假时不可能出现——那不是「没停」而是「不知道」。
 *
 * 一个子代理此刻的处境。**读的顺序就是写的顺序**，前一条命中即定案：
 *
 * run 未终态：`parked`（有它自己的问题停在那儿等答案）→ `waiting`（当前 ask 的最后一条生命
 * 周期事件是 `node-waiting`：在等槽位或在退避）→ `executing`（有 ask 行还在跑）→ `failed`
 * （最后一条已结算的 ask 失败了）→ `idle`。
 *
 * run 已终态：三个活着的词全部退场——`unfinished`（还有 ask 行标着 running，即进程死在它
 * 下面）→ `failed` → `done`。
 */
export type DynamicWorkflowRunSubagentState =
  | "idle"
  | "executing"
  | "waiting"
  | "parked"
  | "done"
  | "failed"
  | "unfinished";

/**
 * 【契约坐标】`target` 是**线索**不是入参：整条链路从引擎到这里每一段都按同一条界切，入参
 * 全文永不进端口。生产者：`node-progress` 事件（引擎侧的裁剪）；消费者：子代理卡的「在干什么」
 * 一行。`at` 是那条事件的落库时刻，缺时间戳就缺席——不用读时兜底。
 *
 * 一次 ask 里最近被观察到的工具调用。`target` 是给人看的**线索**（文件路径、命令头），
 * 不是入参本身——这条链路从引擎到这里每一段都按同一条界切，入参全文永不进来。
 */
export interface DynamicWorkflowRunSubagentLastTool {
  name: string;
  target?: string;
  /** 观察到它的那条 `node-progress` 的落库时刻；事件无时间戳时缺席。 */
  at?: number;
}

/**
 * 【契约坐标】`(siteId, ordinal)` 定位这一站，`actorSeq` 是 journal 的 actor 序号（同一 actor
 * 的第几次 ask），两者都不随时间变化；`turn` / `toolCalls` / `lastTool` 随 `node-progress`
 * 增量到达，缺席读作「不知道」而不是 0。生产者：ask 行 + 进度事件；消费者：子代理卡。
 * `instructionsHead` 是作者指令的头 240 字，老 journal 缺席时**不去读全文补**。
 *
 */
/** 子代理此刻正在跑的那一次 ask（有 ask 行还是 `running` 时在场）。 */
export interface DynamicWorkflowRunSubagentAsk {
  siteId: string;
  ordinal: number;
  /** 这是该子代理的第几次 ask（journal 的 `actorSeq`）；不落这一列的老行缺席。 */
  actorSeq?: number;
  /**
   * 作者写给这次 ask 的指令的头 240 字。读面据它回答「这个子代理被派去干什么」——相位只
   * 说得出「在跑」。不带 `instructionsHead` 的老 journal 上缺席，**不去读指令全文补**。
   */
  instructionsHead?: string;
  /** 这次 ask 的 `node-dispatched` 时刻；事件无时间戳时缺席。 */
  startedAt?: number;
  /**
   * 已解析到第几轮、累计调了几次工具（随 `node-progress` 到达）。
   * 没有 `node-progress` 的老 journal 上一律缺席——缺席读作「不知道」，`0` 读作
   * 「一个工具都没调过」，这是两个不同的事实。
   */
  turn?: number;
  toolCalls?: number;
  lastTool?: DynamicWorkflowRunSubagentLastTool;
}

/**
 * 【契约坐标】`cause` 是封闭二值：`slot` 是进程级准入闸门的排队（跨 run 的共享资源），
 * `backoff` 是 runner 自己的重试退避（run 内的节奏）。生产者：最后一条 `node-waiting`；
 * 消费者：子代理卡的等待行。`since` 是**进入本次等待**的时刻而不是最后一条的时刻——退避阶梯
 * 会连发多条，读者问的是「它卡了多久」。
 *
 */
/** 当前 ask 正在等什么（最后一条 `node-waiting` 的观察）。 */
export interface DynamicWorkflowRunSubagentWait {
  /** `slot` = 在等进程级准入闸门；`backoff` = runner 在退避重试。 */
  cause: "slot" | "backoff";
  reason?: string;
  retryAfterMs?: number;
  /**
   * **进入本次等待**的时刻（即最近一条非 waiting 生命周期事件之后的第一条
   * `node-waiting`），不是最后一条的时刻：退避阶梯会连发好几条，而读者问的是「它卡了多久」。
   * 事件无时间戳时缺席。
   */
  since?: number;
}

/**
 * 【契约坐标】生产者：`rosterSubagentsOf`（journal 事件按 actor 归并 + 停驻表投影）；消费者：
 * 详情侧板与 v4 的子代理面板。`stepsSettled` / `stepsFailed` / `tokens` 来自节点行的 `stats`
 * （只累加已结算的 ask，与 run 级 `spentTokens` 不是一个口径）；`parkedOn` 只在
 * `health.pendingQuestionsKnown` 为真时可能出现。整数组恒在场（0 个 actor 就是空数组），与
 * 可缺席的 `phases` 刻意不同。
 *
 */
/** 情势截面里的一个子代理（= 一个 actor 实例）。 */
export interface DynamicWorkflowRunSubagentView {
  siteId: string;
  ordinal: number;
  /** `agent("poet")` 的有效名；匿名 actor 缺席，这里不合成兜底标签（同 pendingQuestions）。 */
  name?: string;
  state: DynamicWorkflowRunSubagentState;
  /** 它当前（或最后）那次 ask 出生在哪个阶段；都读不出时退到它自己的出生阶段。 */
  phaseName?: string;
  currentAsk?: DynamicWorkflowRunSubagentAsk;
  wait?: DynamicWorkflowRunSubagentWait;
  /**
   * 它停在哪个问题上（`pendingQuestions[].qid`）。**只有确实查得到停驻表时才可能在场**：
   * `health.pendingQuestionsKnown` 为假的那次读根本不知道有没有人在等，见那个字段。
   */
  parkedOn?: string;
  /** 它已结算 / 其中失败的 ask 条数，以及这些 ask 的 token 之和（节点行的 `stats`）。 */
  stepsSettled: number;
  stepsFailed: number;
  tokens: number;
  /** 最后一次被观察到在动的时刻（它名下任一节点的最后一条进度类事件）。 */
  lastProgressAt?: number;
}

/**
 * 【契约坐标】`effective` 是治理器实际放行的数（= min(共享闸门, cap)），`cap` 是**这个 run
 * 自己**的上界——刻意不报本机天花板，否则以 `max_concurrency: 3` 起的 run 在六核机器上会永远
 * 显示「3/6」、读起来像被限流。生产者：最后一条 `concurrency-changed` + 条目上的现读值；
 * 消费者：详情的健康段。整对象只在 `effective < cap` 时在场：在场就等于「它正被限着」。
 *
 * run 级并发现状：它此刻被压到了多少，本该是多少，以及为什么、从什么时候起。
 *
 * **整个对象只在 `effective < cap` 时在场**（与详情面的 `maxConcurrency` 同一条缺席规则）：
 * 一个跑满自己那条界的 run 没有可说的，而这里在场就等于「它正被限着」。
 */
export interface DynamicWorkflowRunConcurrencyHealth {
  /** 治理器此刻实际放行的数 = min(共享闸门, {@link cap})。 */
  effective: number;
  /**
   * **这个 run 自己的**上界：用户给它定过就是那个数，没定过才是本机天花板。
   *
   * 刻意不报天花板：一个以 `max_concurrency: 3` 起的 run 在六核机器上会永远显示成「3/6」，
   * 读起来像被限流，而它正跑在用户亲手定的界上——那条界不是故障，是设定。
   */
  cap: number;
  /** 最后一条 `concurrency-changed` 的原因（`rate_limited` / `recovered` …）。 */
  reason?: string;
  /** 那条事件的落库时刻；无时间戳时缺席。 */
  since?: number;
}

/**
 * 【契约坐标】整对象**恒在场**（与可缺席的阶段 / 并发段不同：run 动不动永远有答案）。生产者：
 * `rosterHealthOf`（进度事件的时间与计数 + 节点行状态）；消费者：详情页的状态灯与
 * `GetWorkflowRun` 的下一步建议。`stalledSince` 的判据刻意排除「等槽位」——那段等待正是停滞
 * 本身，把它算成进度就永远看不到停滞。`pendingQuestionsKnown` 是**元事实**：假时
 * `pendingQuestions` 整字段缺席且没有子代理会被报成 `parked`。
 *
 */
/** run 整体还在不在动。 */
export interface DynamicWorkflowRunHealth {
  /** 全 run 最后一条进度类事件的时刻。 */
  lastProgressAt?: number;
  /**
   * 最后一条 `run-stalled` 的时刻，且其后**没有**任何进度类事件。
   * 「等槽位」不算进度——那段等待正是停滞本身，把它算进去就永远看不到停滞。
   */
  stalledSince?: number;
  concurrency?: DynamicWorkflowRunConcurrencyHealth;
  /** 按结算顺序**结尾处连续**失败的 ask 数：3 次连挂与散落 3 次是两个不同的处境。 */
  consecutiveFailures: number;
  /** 命中完结缓存（`node-settled { cached: true }`）的结算数。 */
  cachedSteps: number;
  /** **仅终态 run**：还标着 `running` 的节点行数，也就是进程死在它们下面的那些。为 0 时缺席。 */
  leftoverRunning?: number;
  /**
   * 这次读**能不能**回答「有没有问题在等答案」。
   *
   * 停驻的问题只活在提问那个进程的内存里（见 {@link DynamicWorkflowRunDetail.pendingQuestions}），
   * 所以读另一个进程名下在飞的 run 时，「没有待答问题」与「不知道」长得一模一样——而这两者
   * 对模型是两个完全不同的下一步。为真的条件是：本会话持有这个 run 的注册表条目，或 run 已
   * 终态（终态 run 按定义没有在听的人）。为假时 `pendingQuestions` 整字段缺席，且没有任何
   * 子代理会被报成 `parked`。
   */
  pendingQuestionsKnown: boolean;
}
