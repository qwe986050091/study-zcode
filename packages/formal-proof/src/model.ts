// packages/formal-proof/src/model.ts —— 会话产品语义的形式化模型（纯数据 + 纯函数）
//
// 职责边界：
//   - 唯一职责：把「产品上下文 × 候选动作」枚举成 TraceNode 树，并为每个组合给出 Decision。
//     产物被 main.ts（可视化）与 bootstrap 的 formal-proof-consistency 黄金测试共同消费。
//   - 不渲染、不读 DOM、不读时钟与随机数：同一输入必须得到同一 id 与同一结构。
//   - 不实现运行时行为：这里的 allow/reject 只是对产品预期的建模；改动不会改变 CLI 行为，
//     但会让黄金测试与文档中的裁决表失配。
//   - RuleId 是跨模块契约，CLI 投影与 E2E 断言都按这些字符串引用，重命名等同破坏契约。
//
// 不变量（INV）：
//   INV-01 contextKey 的字段顺序就是等价类 key（contextKey）——重排或增删字段会让同上下文被判成不同节点，图与统计同时膨胀。
//   INV-02 buildTraceTree 先 resetIds 再构建——漏掉会让多次重建的 case 编号持续增长，E2E 引用失效。
//   INV-03 nextNodeId/nextCaseId 是模块级计数器——并行构建两棵树会交错编号，因此不支持并发构建。
//   INV-04 轮次上限判断是 round > maxRounds（buildStateNode）——写成大于等于会少枚举一整轮。
//   INV-05 重复上下文用 round + contextKey 作 loopKey，visited > 1 才判重——改成大于等于 1 会让自环路径直接消失。
//   INV-06 seen 每层复制 new Map(seen)——共享同一个 Map 会让兄弟分支互相污染，路径被提前判重。
//   INV-07 enumerateCandidates 返回全量用户动作加适用的系统事件——过滤用户动作会让笛卡尔积不完整。
//   INV-08 evaluate 先分流 system 候选——顺序颠倒会让 running 下的 assistantComplete 落到 undefined。
//   INV-09 enqueue 只改 queue 不改 runPhase——顺手推进 phase 会把「排队」变成「立即执行」。
//   INV-10 allow 必须提供 next——缺 next 会让 buildCandidateNode 走 case 分支，路径被当成终点。
//   INV-11 choice 的 next 就是当前 context 且不展开子状态——展开会凭空生成「用户已裁决」的路径。
//   INV-12 reject/undefined 不展开子树——展开会把剪枝路径当成可达状态，污染统计。
//   INV-13 makeCaseNode 的编号形如 CASE-00001——去掉补零会破坏报告与 E2E 的字典序。
//   INV-14 buildE2eAssertion 对 reject 断言「无副作用」而非状态迁移——写成迁移会让测试期待不存在的新状态。
//   INV-15 drainQueueAfterRun 的 mixed 回落到 running + queue=goal——清成 empty 会丢掉未消费的 goal 意图。
//   INV-16 mergeQueue 只在两个不同非空意图时返回 mixed——始终返回 mixed 会让同类意图无法合并。
//   INV-17 isSystemCandidateApplicable 的 goalVerifyStart 需要 completed 且 goal=active——放宽会在验证中再次进入验证。
//   INV-18 profiles 的 id 与 main.ts 的 option value 一一对应——改 id 会让首屏回落第一个 profile。
//   INV-19 systemCandidates 不导出——外部只能经 enumerateCandidates 取得，保证过滤规则唯一。
//   INV-20 collectStats 一次遍历累加全部计数——新增 kind 要同步 stats 字段，否则指标恒为 0。
//   INV-21 decisionLabel 的兜底分支覆盖 undefined——新增 kind 必须补分支，否则标签张冠李戴。
//   INV-22 flatten 依赖 visit 的 DFS 前序——改遍历顺序会影响规则列表首个命中的说明文案。
//   INV-23 evaluate 的 phase 分派必须覆盖全部 RunPhase——漏一个会静默落到 evaluateIdle。
export type RunPhase = "idle" | "running" | "completed" | "compacting" | "goalVerifying";
// 队列状态只记录「滞留了什么意图」，不记录条数与顺序。
// text/goal/compact 是单一意图，mixed 表示至少两种意图并存。
// [契约] mixed 的存在是为了让下游显式拆分，而不是在入队时静默覆盖。
// 新增意图类型要同步 mergeQueue 与 drainQueueAfterRun 的拆分分支。
export type QueueState = "empty" | "text" | "goal" | "compact" | "mixed";
export type CompactMemory = "never" | "compactable" | "justCompacted" | "notNeeded";
// goal 生命周期：设置后 active，验证中 verifying，终态 verified 或 failed。
// 只有 completed + active 才允许触发验证，见 isSystemCandidateApplicable。
// [契约] 终态不回退，避免状态空间出现无限往返。
export type GoalState = "none" | "active" | "verifying" | "verified" | "failed";
export type TurnTarget = "latest" | "old" | "none";
export type CandidateKind = "user" | "system";
// held 状态输入不静默入队，
// 由用户选择「清空 queue 后发送 / 保留 queue 立即发送」。
// 决策种类是图的着色与过滤维度，也是导出 JSON 的 decision 字段。
// choice 表示需要用户裁决的阻塞态，不是 reject，也不是 enqueue。
// [契约] undefined 是「产品预期尚未定义」的显式信号，不能用手抛异常代替。
// 新增种类要同步 effectTitle、decisionLabel、decisionRank 与统计字段。
export type DecisionKind = "allow" | "reject" | "enqueue" | "choice" | "system" | "undefined";
// 六种节点构成固定五列结构：state→candidate→guard→effect→case。
// summary 只由渲染层产生，模型不会生成它。
// [契约] graphNodeId 与 columnFor 按 kind 分支，新增 kind 必须同时补这两处。
export type NodeKind = "state" | "candidate" | "guard" | "effect" | "case" | "summary";

// 产品上下文是状态空间的坐标，七个字段全组合后由 guard 剪枝。
// 字段全部只读：状态推进靠返回新对象，绝不就地修改。
// [契约] 新增字段必须同步 contextKey、contextLabel 与 profiles。
// 字段越多状态空间越大，因此只收录会影响按钮可用性的维度。
export interface ProductContext {
  // runPhase 是分派主键：evaluate 依它选择 evaluateRunning 等分支。
  // 它是唯一决定 phase 的分支点，其它字段只影响细分支。
  // [失败路径] 未覆盖的 phase 会静默落到 evaluateIdle，行为看起来正常但语义错误。
  readonly runPhase: RunPhase;
  // queue 描述当前滞留的输入意图，不是消息正文。
  // merged 之后的 mixed 会由 drainQueueAfterRun 拆分回落。
  // [契约] 入队只经 mergeQueue，任何直接赋值都会绕过 mixed 判定。
  readonly queue: QueueState;
  // compactMemory 区分「从未压缩」「可压缩」「刚压缩」「无需压缩」。
  // 它决定 compact 是 allow 还是 reject，与 canCompactAgain 共同判定。
  // [失败路径] justCompacted 与 canCompactAgain 的组合必须成套出现，单独改一个会产生矛盾路径。
  readonly compactMemory: CompactMemory;
  // canCompactAgain 表示压缩后是否仍有可压缩空间。
  // 它只在 justCompacted 语境下有业务含义，其它 phase 恒为 true。
  // [权衡] 用它而不是再次压缩次数，是为了让状态空间保持有限。
  readonly canCompactAgain: boolean;
  // goal 描述 goal 生命周期：none→active→verifying→verified/failed。
  // 验证阶段的 fork 必须拒绝，因为结果归属会被破坏。
  // [契约] goalVerifyStart 只在 completed 且 active 时适用，见 isSystemCandidateApplicable。
  readonly goal: GoalState;
  readonly selectedTurn: TurnTarget;
  // forked 是「当前轮次被 fork 出来」的标记，只由 completed 的 fork 分支写入。
  // 它用于区分原轮次与派生轮次的按钮可用性。
  // [契约] 该字段一旦为 true，后续 allow 分支必须原样透传。
  readonly forked: boolean;
}

// 候选动作是「用户可能触发的一个入口」，包含展示位置与目标轮次。
// id 是稳定标识，用于 evaluate 的所有分支判断，改 id 等于改规则。
// [契约] label 会直接进入 E2E 断言文案，改动会影响快照测试。
// target 只对 fork/edit 有意义，其余动作为 none。
export interface Candidate {
  readonly id: string;
  // user 与 system 的分流决定了由谁推进状态：用户动作或运行时事件。
  // evaluate 一进来就按 kind 分流，system 走 evaluateSystem。
  // [失败路径] 把系统事件标成 user 会让它被当作可拒绝的用户动作。
  readonly kind: CandidateKind;
  readonly label: string;
  readonly target: TurnTarget;
  // surface 是入口所在的 UI 区域，仅用于展示与排查。
  // 它不参与任何规则判定，因此可以自由改写文案。
  // [权衡] 用字符串而非枚举，避免 UI 位置变动引起规则层改动。
  readonly surface: string;
}

// 决策对象承载结果、规则身份、可读理由与断言模板。
// ruleId 是机器契约，title/reason 是人读文案，两者不可互换。
// [契约] next 存在与否决定是否继续展开下一轮，见 buildCandidateNode。
// assertion 会被复制到 case 的 subtitle 与 E2E 文本中。
export interface Decision {
  readonly kind: DecisionKind;
  // ruleId 是黄金测试与文档裁决表的对齐键，必须全局唯一。
  // 它同时是规则列表的分组键与高亮过滤条件。
  // [契约] 重命名规则需要同步 bootstrap 的 formal-proof-consistency 用例。
  readonly ruleId: string;
  // title 是决策的短文案，进入 guard 节点标题与规则按钮。
  // 它与 ruleId 分离：ruleId 给机器，title 给人。
  // [权衡] 允许 title 重复，但 ruleId 必须唯一。
  readonly title: string;
  readonly reason: string;
  // next 是动作执行后的新上下文，缺省表示路径在此终止。
  // reject 与 undefined 也会带上 next，但那只是当前状态的快照，不代表推进。
  // [失败路径] 仅凭 next 是否存在判断「是否推进」会把 reject 当成 allow。
  readonly next?: ProductContext;
  // assertion 是面向 E2E 的自然语言断言，进入 case 节点与导出文件。
  // 它描述可观测行为，不描述内部实现，避免测试与实现耦合。
  // [契约] 对 reject 必须写「无副作用」，这是 buildE2eAssertion 的分支依据。
  readonly assertion: string;
}

// TraceNode 是枚举产物，也是渲染与导出的唯一数据形状。
// 节点只读，children 通过新数组装配，不做原地修改。
// [契约] case 节点必须带 caseId 与 e2e，其余节点可缺省。
// summary 节点不在本文件生成，但形状必须兼容。
export interface TraceNode {
  readonly id: string;
  // kind 决定节点在五列结构中的位置与图上的分类样式。
  // 它不参与规则判定，规则只看 decision。
  // [失败路径] kind 与 decision 不一致会让 guard/effect 的语义错位。
  readonly kind: NodeKind;
  readonly title: string;
  readonly subtitle: string;
  readonly detail: string;
  // context 是节点所处状态，effect 节点使用 decision.next 而不是父状态。
  // contextKey 由它派生，进而决定 state 节点的合并。
  // [契约] 折叠节点继承父上下文，保证列归属正确。
  readonly context: ProductContext;
  readonly candidate?: Candidate;
  readonly decision?: Decision;
  readonly caseId?: string;
  readonly e2e?: string;
  // children 是装配后的新数组，构建期 push，构建后只读。
  // 深度与宽度都受 maxRounds 约束，避免状态空间爆炸。
  // [资源] 每层都复制 seen，因此内存随「轮次乘分支数」增长。
  readonly children: TraceNode[];
}

// 统计对象是左栏六项指标的数据源，字段与决策种类一一对应。
// nodes 与 cases 是结构量，其余是决策分类量。
// [契约] 新增 DecisionKind 必须同步这里与 collectStats。
export interface TraceStats {
  readonly nodes: number;
  readonly cases: number;
  readonly rejects: number;
  readonly undefined: number;
  readonly enqueued: number;
  readonly allowed: number;
  readonly choices: number;
  readonly system: number;
}

// profile 是枚举起点：一个初始上下文对应一个可视化入口。
// id 与 label 直接进入下拉框，顺序即展示顺序。
// [契约] 至少保留一个 profile，rebuildRoot 依赖它的存在。
export interface ModelProfile {
  readonly id: string;
  readonly label: string;
  readonly context: ProductContext;
}

// 六种起始上下文覆盖 running、completed、goal 验证与压缩前后。
// 这里只放「值得枚举」的起点，不是全部可能上下文。
// [权衡] 增加 profile 会线性放大状态空间，需要先确认渲染预算。
// 每个 profile 的 context 字段都必须完整，缺字段会绕过类型检查的语义。
export const profiles: ModelProfile[] = [
  {
    id: "running",
    label: "running：消息发送中",
    context: {
      runPhase: "running",
      queue: "empty",
      compactMemory: "compactable",
      canCompactAgain: true,
      goal: "active",
      selectedTurn: "latest",
      forked: false,
    },
  },
  {
    id: "completed",
    label: "completed：消息已完成",
    context: {
      runPhase: "completed",
      queue: "empty",
      compactMemory: "compactable",
      canCompactAgain: true,
      goal: "active",
      selectedTurn: "latest",
      forked: false,
    },
  },
  {
    id: "goal-verifying",
    label: "goalVerifying：goal 验证中",
    context: {
      runPhase: "goalVerifying",
      queue: "empty",
      compactMemory: "compactable",
      canCompactAgain: true,
      goal: "verifying",
      selectedTurn: "latest",
      forked: false,
    },
  },
  {
    id: "compacting",
    label: "compacting：正在 compact",
    context: {
      runPhase: "compacting",
      queue: "empty",
      compactMemory: "compactable",
      canCompactAgain: true,
      goal: "active",
      selectedTurn: "latest",
      forked: false,
    },
  },
  {
    id: "just-compacted-noop",
    label: "justCompacted：刚压缩完，不需要继续压缩",
    context: {
      runPhase: "completed",
      queue: "empty",
      compactMemory: "justCompacted",
      canCompactAgain: false,
      goal: "active",
      selectedTurn: "latest",
      forked: false,
    },
  },
  {
    id: "just-compacted-more",
    label: "justCompacted：刚压缩完，但还能继续压缩",
    context: {
      runPhase: "completed",
      queue: "empty",
      compactMemory: "justCompacted",
      canCompactAgain: true,
      goal: "active",
      selectedTurn: "latest",
      forked: false,
    },
  },
];

// 用户动作全集固定八个，不随上下文增减。
// 由 guard 决定每个动作在不同上下文下的结果，而不是在入口处裁剪。
// [契约] 顺序即图上 Action 列的排序输入，改变顺序会影响布局。
export const userCandidates: Candidate[] = [
  { id: "sendText", kind: "user", label: "继续发送文字", target: "none", surface: "composer" },
  { id: "slashCompact", kind: "user", label: "输入 /compact", target: "none", surface: "composer" },
  { id: "setGoal", kind: "user", label: "设置 goal", target: "none", surface: "goal control" },
  { id: "compact", kind: "user", label: "点击 compact", target: "none", surface: "toolbar" },
  {
    id: "forkLatest",
    kind: "user",
    label: "fork 最新轮次",
    target: "latest",
    surface: "turn actions",
  },
  { id: "forkOld", kind: "user", label: "fork 老轮次", target: "old", surface: "turn actions" },
  {
    id: "editLatest",
    kind: "user",
    label: "编辑最新 query",
    target: "latest",
    surface: "message actions",
  },
  { id: "editOld", kind: "user", label: "编辑老 query", target: "old", surface: "message actions" },
];

// 系统事件是运行时异步推进，不是用户操作。
// 刻意不导出：外部只能经 enumerateCandidates 取得适用子集。
// [契约] 每个系统事件都必须在 isSystemCandidateApplicable 中有适用条件。
const systemCandidates: Candidate[] = [
  {
    id: "assistantComplete",
    kind: "system",
    label: "assistant 完成当前 run",
    target: "none",
    surface: "runtime event",
  },
  {
    id: "compactComplete",
    kind: "system",
    label: "compact 完成",
    target: "none",
    surface: "runtime event",
  },
  {
    id: "compactNoop",
    kind: "system",
    label: "compact 判断不需要继续",
    target: "none",
    surface: "runtime event",
  },
  {
    id: "goalVerifyStart",
    kind: "system",
    label: "开始 goal 验证",
    target: "none",
    surface: "goal runtime",
  },
  {
    id: "goalVerifyPass",
    kind: "system",
    label: "goal 验证通过",
    target: "none",
    surface: "goal runtime",
  },
  {
    id: "goalVerifyFail",
    kind: "system",
    label: "goal 验证失败",
    target: "none",
    surface: "goal runtime",
  },
];

// 节点 id 是模块级自增计数，构建一次树从 1 开始。
// [并发] 模块级状态意味着同一进程内不能并行构建两棵树。
// id 只在单次构建内有意义，不用于跨构建比较。
let nextNodeId = 0;
// case 编号与节点 id 分开计数，避免两类标识互相干扰。
// 它只在 makeCaseNode 中递增，且与 resetIds 同步归零。
// [失败路径] 单独重置一个计数器会让编号与节点顺序错位。
let nextCaseId = 0;

// 重置两个计数器，保证重建后 id 与 case 编号可复现。
// 它只重置编号，不清空任何缓存，因为本模块没有缓存。
// [失败路径] 忘记调用会让连续重建的编号漂移，快照测试随之失败。
export function resetIds(): void {
  nextNodeId = 0;
  nextCaseId = 0;
}

// 生成人类可读的上下文文案，用于节点副标题与导出。
// 字段顺序与 contextKey 一致，便于肉眼比对两条路径。
// [契约] 文案会进入 E2E 断言，改措辞会改动快照。
// 它不做任何归一化，undefined 字段会原样出现在字符串里。
export function contextLabel(context: ProductContext): string {
  return [
    `phase=${context.runPhase}`,
    `queue=${context.queue}`,
    `compact=${context.compactMemory}`,
    context.canCompactAgain ? "canCompactAgain" : "cannotCompactAgain",
    `goal=${context.goal}`,
    `turn=${context.selectedTurn}`,
    context.forked ? "forked" : "notForked",
  ].join(" / ");
}

// 等价类 key：同 key 视为同一产品状态。
// [契约] 字段顺序即 key 的字节序，重排会让历史判定全部失效。
// 布尔值显式转成字符串，避免 undefined 参与拼接。
// 不要在这里做 trim 或大小写归一化，会掩盖数据错误。
export function contextKey(context: ProductContext): string {
  return [
    context.runPhase,
    context.queue,
    context.compactMemory,
    String(context.canCompactAgain),
    context.goal,
    context.selectedTurn,
    String(context.forked),
  ].join("|");
}

// 候选集等于用户动作全集加上当前适用的系统事件。
// 过滤只发生在系统事件上，用户动作永远参与笛卡尔积。
// [契约] 返回新数组，调用方可以安全地映射或排序。
export function enumerateCandidates(context: ProductContext): Candidate[] {
  // 系统事件按上下文过滤，避免枚举出不可能发生的迁移。
  // 过滤条件集中在 isSystemCandidateApplicable，保持单一事实源。
  // [失败路径] 放宽条件会生成「凭空发生」的系统事件路径。
  const events = systemCandidates.filter((candidate) =>
    isSystemCandidateApplicable(context, candidate),
  );
  return [...userCandidates, ...events];
}

// 构建入口：重置编号后从第 1 轮开始递归。
// seen 传入新的空 Map，所有分支共享同一个 visited 记录根。
// [契约] 返回值是完整树，不受渲染预算影响。
// maxRounds 只控制深度，不控制宽度。
export function buildTraceTree(context: ProductContext, maxRounds: number): TraceNode {
  // 先重置编号再构建，保证同参数得到同 id。
  // 若改成构建后重置，返回值里的 id 会与下一次构建重叠。
  // [契约] 这是快照可复现的前提，不要为了「保留历史编号」而删除。
  resetIds();
  // 递归从这里开始：轮次从 1 计，seen 是全新的空表。
  // 把 new Map() 提到函数外会让多次构建共享循环计数。
  // [契约] 根节点一定带 full 上下文，不做任何裁剪。
  return buildStateNode(context, 1, maxRounds, new Map());
}

// 一次 DFS 累加全部统计，避免为每个指标重复遍历。
// 统计基于完整树，包含被折叠与剪枝的路径。
// [契约] 返回普通对象，调用方不得回写。
export function collectStats(root: TraceNode): TraceStats {
  // 初始计数全为 0，字段与 TraceStats 一一对应。
  // 新增字段必须在这里初始化，否则累加会得到 NaN。
  // [失败路径] 用类型断言省略初始化会让指标显示 undefined。
  const stats = {
    nodes: 0,
    cases: 0,
    rejects: 0,
    undefined: 0,
    enqueued: 0,
    allowed: 0,
    choices: 0,
    system: 0,
  };

  // 统计回调对每个节点执行一次，累加所有分类计数。
  // 回调是同步的，不要在内部触发异步或修改节点。
  // [契约] 计数口径以 decision.kind 为准，不看节点 kind。
  visit(root, (node) => {
    stats.nodes += 1;
    if (node.kind === "case") {
      stats.cases += 1;
    }
    if (node.decision?.kind === "reject") {
      stats.rejects += 1;
    }
    if (node.decision?.kind === "undefined") {
      stats.undefined += 1;
    }
    if (node.decision?.kind === "enqueue") {
      stats.enqueued += 1;
    }
    if (node.decision?.kind === "allow") {
      stats.allowed += 1;
    }
    if (node.decision?.kind === "choice") {
      stats.choices += 1;
    }
    if (node.decision?.kind === "system") {
      stats.system += 1;
    }
  });

  return stats;
}

// 把树压平成 DFS 前序数组，供规则聚合与导出使用。
// 顺序稳定，因此规则列表首个命中的说明文案也是稳定的。
// [资源] 每次调用都新建数组，深树会产生一次性开销。
export function flatten(root: TraceNode): TraceNode[] {
  const nodes: TraceNode[] = [];
  visit(root, (node) => nodes.push(node));
  return nodes;
}

// 把决策渲染成「kind · title」，用于 guard 节点标题。
// [契约] 兜底分支必须覆盖 undefined，新增 kind 要补分支。
// label 只影响展示，不参与判定。
export function decisionLabel(decision: Decision): string {
  if (decision.kind === "reject") {
    return `reject · ${decision.title}`;
  }
  if (decision.kind === "enqueue") {
    return `enqueue · ${decision.title}`;
  }
  if (decision.kind === "allow") {
    return `allow · ${decision.title}`;
  }
  if (decision.kind === "choice") {
    return `choice · ${decision.title}`;
  }
  if (decision.kind === "system") {
    return `system · ${decision.title}`;
  }
  return `undefined · ${decision.title}`;
}

// 统一的 DFS 前序遍历，统计与压平共用。
// 先访问自身再递归子节点，顺序是规则文案稳定的前提。
// [失败路径] 改成后序会让 flatten 的顺序与图上列顺序不一致。
function visit(node: TraceNode, fn: (node: TraceNode) => void): void {
  fn(node);
  for (const child of node.children) {
    visit(child, fn);
  }
}

// 构造 state 节点，并在轮次超限或检测到循环时直接产出 case。
// state 节点的 id 只含 contextKey，因此跨父路径的相同上下文会合并。
// [权衡] 这是有意的等价类语义，代价是丢失「从哪条路径到达」的信息。
// seen 的计数在进入子节点前完成，保证同一层的兄弟共享父计数。
function buildStateNode(
  context: ProductContext,
  round: number,
  maxRounds: number,
  seen: Map<string, number>,
): TraceNode {
  const node = makeNode({
    kind: "state",
    title: `S${round}: ${context.runPhase}`,
    subtitle: contextLabel(context),
    detail: "可见产品上下文。下一层会对所有候选动作做笛卡尔积枚举，再用产品 guard 剪枝。",
    context,
    children: [],
  });

  // 超过轮次上限时不再展开，直接生成 review case。
  // 判断用的是大于而不是大于等于，等于时仍会枚举一轮动作。
  // [契约] 修改边界会让每一轮的节点数与快照全部变化。
  if (round > maxRounds) {
    return makeCaseNode(
      node,
      "到达轮次上限",
      "这条 trace 已到达当前枚举深度，需要人工 review 是否继续展开。",
    );
  }

  // 循环检测的 key 同时包含轮次与上下文。
  // 带上 round 是为了允许「同上下文在不同轮次出现」，否则第二层就会被误判为重复。
  // [契约] 去掉 round 会让多轮枚举在第一轮就终止。
  const loopKey = `${round}:${contextKey(context)}`;
  // 读取该 key 已出现的次数，未出现视为 0。
  // 计数只增不减，且通过 nextSeen 传给子树。
  // [失败路径] 用 || 代替 ?? 在计数为 0 时结果相同，但语义上要区分缺失与零。
  const visited = seen.get(loopKey) ?? 0;
  // 同一轮次同一上下文出现两次以上才判为循环。
  // 允许出现一次是刻意的：这样自环路径仍能被枚举到并收束成 case。
  // [失败路径] 改成大于 0 会让所有回到既有上下文的动作直接消失。
  if (visited > 1) {
    return makeCaseNode(node, "重复上下文", "模型再次到达相同上下文；这里应判断是否合并为等价类。");
  }
  // 每个分支复制一份计数表，兄弟分支互不影响。
  // [并发] 这是纯函数式隔离，避免共享可变 Map 造成的顺序依赖。
  // [资源] 复制成本随深度线性增长，是状态空间爆炸的主要来源之一。
  const nextSeen = new Map(seen);
  nextSeen.set(loopKey, visited + 1);

  node.children.push(
    ...enumerateCandidates(context).map((candidate) =>
      buildCandidateNode(context, candidate, round, maxRounds, nextSeen),
    ),
  );
  return node;
}

// 为单个候选动作构造三层：candidate→guard→effect。
// guard 携带决策，effect 携带决策后的上下文。
// [契约] 只有 allow 与 enqueue 且带 next 时才继续展开下一轮。
// 其余情况把路径收束成 case 节点，作为人工 review 的落点。
function buildCandidateNode(
  context: ProductContext,
  candidate: Candidate,
  round: number,
  maxRounds: number,
  seen: Map<string, number>,
): TraceNode {
  // 决策在构造节点前一次算出，后续三段共用同一个对象。
  // [契约] 不要在 guard 与 effect 里重复调用 evaluate，否则可能出现两次判定不一致。
  // evaluate 是纯函数，但重复调用没有必要。
  const decision = evaluate(context, candidate);
  // candidate 节点记录动作本身与发起时的上下文。
  // 副标题固定为「kind / surface」，便于在图上快速分辨入口来源。
  // [契约] 它必须恰好有一个 guard 子节点，不得为空。
  const candidateNode = makeNode({
    kind: "candidate",
    title: candidate.label,
    subtitle: `${candidate.kind} / ${candidate.surface}`,
    detail: `候选组合：${contextLabel(context)} × ${candidate.label}`,
    context,
    candidate,
    children: [],
  });
  // guard 节点以「kind · title」为标题，ruleId 为副标题。
  // 它承载决策本身，是规则高亮的落点。
  // [契约] guard 必须恰好有一个 effect 子节点。
  const guardNode = makeNode({
    kind: "guard",
    title: decisionLabel(decision),
    subtitle: decision.ruleId,
    detail: decision.reason,
    context,
    candidate,
    decision,
    children: [],
  });
  const effectNode = makeNode({
    kind: "effect",
    title: effectTitle(decision),
    subtitle: decision.assertion,
    detail: decision.next
      ? contextLabel(decision.next)
      : "无下一状态：路径在这里被剪枝或等待产品定义。",
    context: decision.next ?? context,
    candidate,
    decision,
    children: [],
  });

  // choice 不展开下一状态：clear/keep 两个 disposition 都终到 completedCanSend 路径。
  if (
    decision.next &&
    decision.kind !== "reject" &&
    decision.kind !== "undefined" &&
    decision.kind !== "choice"
  ) {
    effectNode.children.push(buildStateNode(decision.next, round + 1, maxRounds, seen));
  } else {
    effectNode.children.push(
      makeCaseNode(effectNode, decision.title, decision.assertion, candidate, decision),
    );
  }

  guardNode.children.push(effectNode);
  candidateNode.children.push(guardNode);
  return candidateNode;
}

// 把路径收束成可 review 的 case，分配编号并生成 E2E 断言。
// case 的上下文取 base.context，而不是决策后的 next。
// [契约] caseId 必须存在，前端的 review 标注以它为键。
function makeCaseNode(
  base: TraceNode,
  title: string,
  detail: string,
  candidate?: Candidate,
  decision?: Decision,
): TraceNode {
  // case 编号严格按构建顺序递增，保证快照稳定。
  // 它独立于节点 id，便于外部按编号引用。
  // [失败路径] 改成随机 id 会让 review 标注在重建后全部失配。
  nextCaseId += 1;
  // 固定前缀加五位补零，保证字典序等于数值序。
  // [契约] 五位的上限是一万条 case，超出后字符串会变长但排序仍正确。
  // 去掉补零会让 CASE-10 排在 CASE-2 之前。
  const caseId = `CASE-${String(nextCaseId).padStart(5, "0")}`;
  return makeNode({
    kind: "case",
    title: caseId,
    subtitle: title,
    detail,
    context: base.context,
    candidate,
    decision,
    caseId,
    e2e: buildE2eAssertion(base.context, candidate, decision),
    children: [],
  });
}

// 统一的节点工厂：补 id，其余字段透传。
// 使用 Omit 让调用方无法自带 id，保证编号唯一。
// [契约] 不要在这里做深拷贝，children 由调用方按需装配。
function makeNode(input: Omit<TraceNode, "id">): TraceNode {
  nextNodeId += 1;
  return {
    ...input,
    id: `n-${nextNodeId}`,
  };
}

// 把决策翻译成副作用的短标题，用于 effect 节点。
// 六个分支必须覆盖全部 DecisionKind，最后的兜底是 undefined。
// [失败路径] 新增 kind 未补分支会显示「未定义：需要产品 review」，误导排查方向。
function effectTitle(decision: Decision): string {
  if (decision.kind === "reject") {
    return "剪枝：显示明确拒绝";
  }
  if (decision.kind === "enqueue") {
    return "副作用：进入消息队列";
  }
  if (decision.kind === "allow") {
    return "副作用：动作生效";
  }
  if (decision.kind === "system") {
    return "系统事件：推进阶段";
  }
  if (decision.kind === "choice") {
    return "阻塞：等待用户裁决 queue disposition";
  }
  return "未定义：需要产品 review";
}

// 导出为可执行裁决表（02-projection「规则模块下沉」）：
// CLI 投影的 guard 派生必须与本函数逐条一致，由 bootstrap 的
// formal-proof-consistency 黄金测试机械背书。
// 规则总入口：先按候选类型分流，再按 phase 分派。
// 每个分支都必须返回 Decision，绝不允许抛异常或返回 undefined。
// [契约] 导出为可执行裁决表，CLI 投影的 guard 派生必须与本函数逐条一致。
// [失败路径] 新增 phase 而漏分支，会静默落到 evaluateIdle 并给出错误的 allow。
export function evaluate(context: ProductContext, candidate: Candidate): Decision {
  // 系统事件优先分流，因为它与 phase 无关只与事件类型有关。
  // [失败路径] 若放在 phase 判断之后，running 下的 assistantComplete 会被当作用户动作判成 undefined。
  // [顺序] 系统事件分支先返回：进入 evaluate 后不会再落回用户动作或 phase 分支，新增 kind 必须在入口显式列出。
  if (candidate.kind === "system") {
    return evaluateSystem(context, candidate);
  }

  if (context.runPhase === "running") {
    return evaluateRunning(context, candidate);
  }
  if (context.runPhase === "compacting") {
    return evaluateCompacting(context, candidate);
  }
  if (context.runPhase === "goalVerifying") {
    return evaluateGoalVerifying(context, candidate);
  }
  if (context.runPhase === "completed") {
    return evaluateCompleted(context, candidate);
  }
  return evaluateIdle(context, candidate);
}

function evaluateRunning(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "sendText") {
    return enqueue(
      context,
      candidate,
      "queueTextWhileRunning",
      "running 时继续发文字进入消息队列。",
    );
  }
  if (candidate.id === "setGoal") {
    return enqueue(
      context,
      candidate,
      "queueGoalWhileRunning",
      "running 时设置 goal 进入消息队列。",
    );
  }
  if (candidate.id === "slashCompact" || candidate.id === "compact") {
    return enqueue(
      context,
      candidate,
      "runningCompactQueues",
      "running 时 compact 作为维护意图进入 FIFO。",
    );
  }
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return reject(context, "runningCannotFork", "运行中不能 fork", "最新轮次和老轮次都不能 fork。");
  }
  if (candidate.id === "editLatest" || candidate.id === "editOld") {
    return reject(
      context,
      "runningCannotEditQuery",
      "运行中不能编辑 query",
      "发送过程中最新 query 和历史 query 都不能编辑。",
    );
  }
  return undefinedDecision(context, candidate, "runningUnhandled");
}

function evaluateCompacting(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "compact" || candidate.id === "slashCompact") {
    return reject(
      context,
      "compactingCannotCompact",
      "正在 compact，不能再次 compact",
      "必须去重或禁用入口。",
    );
  }
  // 重裁决（compactingAcceptsFutureInput）：
  // compact 是维护步骤，用户输入是未来意图 → 入队，不打断 compact。
  if (candidate.id === "sendText" || candidate.id === "setGoal") {
    return enqueue(
      context,
      candidate,
      "compactingAcceptsFutureInput",
      "compacting 时输入追加 queue，不打断 compact。",
    );
  }
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return reject(
      context,
      "compactingCannotFork",
      "正在 compact，不能 fork",
      "避免 fork 到半压缩上下文。",
    );
  }
  return undefinedDecision(context, candidate, "compactingUnhandled");
}

function evaluateGoalVerifying(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "compact" || candidate.id === "slashCompact") {
    return enqueue(
      context,
      candidate,
      "goalVerifierAcceptsFutureInput",
      "goal verifier 中 compact 追加 queue，不打断验证。",
    );
  }
  if (candidate.id === "sendText" || candidate.id === "setGoal") {
    return enqueue(
      context,
      candidate,
      "goalVerifierAcceptsFutureInput",
      "goal verifier 中输入追加 queue，不打断验证。",
    );
  }
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return reject(
      context,
      "goalVerifyingCannotFork",
      "goal 验证中不能 fork",
      "验证阶段 fork 会破坏结果归属。",
    );
  }
  return undefinedDecision(context, candidate, "goalVerifyingUnhandled");
}

// completed 是规则最密集的分支：fork、compact、发送与设置 goal。
// held queue 存在时发送与设置 goal 都降级为 choice，而不是静默入队。
// [契约] compact 在 held queue 下必须入队，不能绕过未来意图。
// fork 会写入 forked 与 selectedTurn，这是唯一改这两个字段的分支。
function evaluateCompleted(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return allow(context, "completedCanFork", "完成后可以 fork", {
      ...context,
      forked: true,
      selectedTurn: candidate.target,
    });
  }
  if (candidate.id === "compact" || candidate.id === "slashCompact") {
    if (context.queue !== "empty") {
      return enqueue(
        context,
        candidate,
        "heldCompactQueues",
        "held queue 下 compact 追加队尾，不绕过未来意图。",
      );
    }
    if (context.compactMemory === "justCompacted" && !context.canCompactAgain) {
      return reject(
        context,
        "justCompactedNoNeed",
        "刚压缩完，不需要压缩",
        "compact 可以被点击，但模型返回 noop 提示。",
      );
    }
    return allow(context, "completedCanCompact", "完成后可以 compact", {
      ...context,
      runPhase: "compacting",
      compactMemory: "compactable",
    });
  }
  // held 判定：completed 下仍滞留的 queue 只可能是 autoDrain=false 的 held queue
  // （autoDrain=true 时 assistantComplete 即消费，completed+queue>0 不持久存在）。
  // 重裁决（heldQueueInputRequiresChoice，替代原 heldQueueCapturesNewInput）：
  // held 下输入不静默入队，由用户选择 clear/keep queue 后发送。
  if (candidate.id === "sendText") {
    if (context.queue !== "empty") {
      return choice(
        context,
        "heldQueueInputRequiresChoice",
        "held queue 下发送需用户裁决",
        "呈现「清空 queue 后发送 / 保留 queue 立即发送」，disposition 随 command 上行。",
      );
    }
    return allow(context, "completedCanSend", "完成后继续发送", {
      ...context,
      runPhase: "running",
      queue: "empty",
    });
  }
  if (candidate.id === "setGoal") {
    if (context.queue !== "empty") {
      return choice(
        context,
        "heldQueueInputRequiresChoice",
        "held queue 下设置 goal 需用户裁决",
        "同 sendText：composer 输入统一走 choice。",
      );
    }
    return allow(context, "completedCanSetGoal", "完成后可以设置 goal", {
      ...context,
      goal: "active",
    });
  }
  return undefinedDecision(context, candidate, "completedUnhandled");
}

function evaluateIdle(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "sendText") {
    return allow(context, "idleCanSend", "idle 时发送消息", {
      ...context,
      runPhase: "running",
      queue: "empty",
    });
  }
  if (candidate.id === "setGoal") {
    return allow(context, "idleCanSetGoal", "idle 时设置 goal", {
      ...context,
      goal: "active",
    });
  }
  if (candidate.id === "compact" || candidate.id === "slashCompact") {
    return reject(
      context,
      "idleCannotCompact",
      "没有可压缩上下文",
      "没有完成消息时 compact 应禁用或提示。",
    );
  }
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return reject(context, "idleCannotFork", "没有可 fork 轮次", "没有完成轮次时 fork 应禁用。");
  }
  if (candidate.id === "editLatest" || candidate.id === "editOld") {
    return reject(
      context,
      "idleCannotEdit",
      "没有可编辑 query",
      "没有 query 时编辑入口不应该出现。",
    );
  }
  return undefinedDecision(context, candidate, "idleUnhandled");
}

// 系统事件只做状态推进，不做剪枝。
// 末尾的 goalVerifyFail 是兜底分支，依赖 isSystemCandidateApplicable 先过滤。
// [失败路径] 新增系统事件但漏分支，会静默走 goalVerifyFail 并把 goal 标成失败。
function evaluateSystem(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "assistantComplete") {
    return systemTransition(
      context,
      "assistantComplete",
      "assistant 完成",
      drainQueueAfterRun(context),
    );
  }
  if (candidate.id === "compactComplete") {
    return systemTransition(context, "compactComplete", "compact 完成", {
      ...context,
      runPhase: "completed",
      compactMemory: "justCompacted",
      canCompactAgain: true,
    });
  }
  if (candidate.id === "compactNoop") {
    return systemTransition(context, "compactNoop", "compact 判断无需继续", {
      ...context,
      runPhase: "completed",
      compactMemory: "justCompacted",
      canCompactAgain: false,
    });
  }
  if (candidate.id === "goalVerifyStart") {
    return systemTransition(context, "goalVerifyStart", "进入 goal 验证", {
      ...context,
      runPhase: "goalVerifying",
      goal: "verifying",
    });
  }
  if (candidate.id === "goalVerifyPass") {
    return systemTransition(context, "goalVerifyPass", "goal 验证通过", {
      ...context,
      runPhase: "completed",
      goal: "verified",
    });
  }
  return systemTransition(context, "goalVerifyFail", "goal 验证失败", {
    ...context,
    runPhase: "completed",
    goal: "failed",
  });
}

// 系统事件的适用条件集中在此，保证枚举与判定同源。
// goalVerifyStart 要求 completed 且 goal 为 active，避免验证中再次进入验证。
// [契约] 未识别的候选返回 false，而不是抛错。
function isSystemCandidateApplicable(context: ProductContext, candidate: Candidate): boolean {
  if (candidate.id === "assistantComplete") {
    return context.runPhase === "running";
  }
  if (candidate.id === "compactComplete" || candidate.id === "compactNoop") {
    return context.runPhase === "compacting";
  }
  if (candidate.id === "goalVerifyStart") {
    return context.runPhase === "completed" && context.goal === "active";
  }
  if (candidate.id === "goalVerifyPass" || candidate.id === "goalVerifyFail") {
    return context.runPhase === "goalVerifying";
  }
  return false;
}

function allow(
  context: ProductContext,
  ruleId: string,
  title: string,
  next: ProductContext,
): Decision {
  return {
    kind: "allow",
    ruleId,
    title,
    reason: title,
    next,
    assertion: "动作应生效，并且 UI、消息归属、按钮状态与下一上下文一致。",
  };
}

// 入队决策只改 queue，不推进 runPhase。
// 入队项按候选 id 归类为 text/goal/compact，再由 mergeQueue 合并。
// [契约] assertion 按类别区分，compact 额外要求不生成 user row。
// [失败路径] 在这里顺手推进 phase 会让状态空间出现「已入队却已执行」的矛盾路径。
function enqueue(
  context: ProductContext,
  candidate: Candidate,
  ruleId: string,
  reason: string,
): Decision {
  const queued =
    candidate.id === "setGoal"
      ? "goal"
      : candidate.id === "compact" || candidate.id === "slashCompact"
        ? "compact"
        : "text";
  return {
    kind: "enqueue",
    ruleId,
    title: queued === "goal" ? "goal 入队" : queued === "compact" ? "compact 入队" : "文字消息入队",
    reason,
    next: {
      ...context,
      queue: mergeQueue(context.queue, queued),
    },
    assertion:
      queued === "goal"
        ? "队列里必须保留 goal 意图。"
        : queued === "compact"
          ? "队列里必须保留 compact 维护意图，且不能生成 user row。"
          : "队列里必须保留用户文字消息。",
  };
}

function choice(context: ProductContext, ruleId: string, title: string, reason: string): Decision {
  return {
    kind: "choice",
    ruleId,
    title,
    reason,
    // 无 next：状态直到用户提交 disposition 才推进（clear/keep 都终到 startNow）。
    next: context,
    assertion: "必须呈现明确选择，用户裁决前不得入队、不得发送。",
  };
}

function reject(context: ProductContext, ruleId: string, title: string, reason: string): Decision {
  return {
    kind: "reject",
    ruleId,
    title,
    reason,
    assertion: "这条路径必须显示明确反馈，并且不能产生被禁止的副作用。",
    next: context,
  };
}

function systemTransition(
  context: ProductContext,
  ruleId: string,
  title: string,
  next: ProductContext,
): Decision {
  return {
    kind: "system",
    ruleId,
    title,
    reason: "系统异步事件推进产品状态。",
    next,
    assertion: "系统事件必须按当前 session/run 归属落盘，不能污染其它 trace。",
  };
}

function undefinedDecision(
  context: ProductContext,
  candidate: Candidate,
  ruleId: string,
): Decision {
  return {
    kind: "undefined",
    ruleId,
    title: "产品预期未定义",
    reason: `模型还不知道 ${context.runPhase} + ${candidate.label} 应该 allow、reject 还是 enqueue。`,
    assertion: "需要人工 review：补产品规则、剪枝为 invalid、或标记可忽略。",
  };
}

// 空队列直接接受新意图；同类合并保持原值；不同类升级为 mixed。
// [契约] mixed 是唯一需要下游拆分的状态，drainQueueAfterRun 必须处理它。
// [失败路径] 直接返回 mixed 会让同类意图也被标记为需要拆分。
function mergeQueue(queue: QueueState, item: "text" | "goal" | "compact"): QueueState {
  if (queue === "empty") {
    return item;
  }
  if (queue === item) {
    return queue;
  }
  return "mixed";
}

// 把排队意图消费成下一阶段：text 转 running、goal 保持 completed、compact 转 compacting。
// mixed 只消费 text，残留 goal 继续排队，避免丢失意图。
// [权衡] 每次只消费一个意图，是为了让状态迁移保持单步可解释。
// [失败路径] 空队列分支会把 never 提升为 compactable，其它记忆状态必须原样保留。
function drainQueueAfterRun(context: ProductContext): ProductContext {
  if (context.queue === "text") {
    return { ...context, runPhase: "running", queue: "empty" };
  }
  if (context.queue === "goal") {
    return { ...context, runPhase: "completed", queue: "empty", goal: "active" };
  }
  if (context.queue === "compact") {
    return { ...context, runPhase: "compacting", queue: "empty" };
  }
  if (context.queue === "mixed") {
    return { ...context, runPhase: "running", queue: "goal" };
  }
  return {
    ...context,
    runPhase: "completed",
    compactMemory: context.compactMemory === "never" ? "compactable" : context.compactMemory,
  };
}

// 按决策种类生成 E2E 断言模板，写入 case 节点与导出文件。
// reject 断言的是「出现提示且不产生被禁止的副作用」，不是状态迁移。
// [契约] 断言里的上下文文案来自 contextLabel，改文案会改动快照。
// 缺少 candidate 或 decision 时返回兜底文案，供轮次上限与循环 case 使用。
function buildE2eAssertion(
  context: ProductContext,
  candidate?: Candidate,
  decision?: Decision,
): string {
  if (!candidate || !decision) {
    return "记录当前 trace，并判断是否需要继续展开。";
  }
  if (decision.kind === "reject") {
    return `Given ${contextLabel(context)}, when ${candidate.label}, then show "${decision.title}" and no forbidden side effect occurs.`;
  }
  if (decision.kind === "enqueue") {
    return `Given ${contextLabel(context)}, when ${candidate.label}, then queue state becomes ${decision.next?.queue ?? "unknown"}.`;
  }
  if (decision.kind === "allow") {
    return `Given ${contextLabel(context)}, when ${candidate.label}, then transition to ${decision.next ? contextLabel(decision.next) : "next context"}.`;
  }
  if (decision.kind === "system") {
    return `Given ${contextLabel(context)}, when system emits ${candidate.label}, then reconcile to ${decision.next ? contextLabel(decision.next) : "next context"}.`;
  }
  return `Given ${contextLabel(context)}, when ${candidate.label}, product expectation is undefined and must be reviewed.`;
}
