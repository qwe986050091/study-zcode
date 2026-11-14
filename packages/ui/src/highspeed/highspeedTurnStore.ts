// Highspeed Turn Store —— 高速回合内存账本：登记/完成/丢弃回合、缓存卡级 TPS、聚合卡级指标。
// 同时裁决三件事：哪些卡需要补查 healthy TPS、哪些卡可以自动分享、transcript 水合结果如何落库。
// 不负责：transcript 读写与持久化、指标写盘、分享请求发送、订阅抖动抑制、倍率达标判定本身。
// 单例语义：本模块是 renderer 进程内唯一账本，各 SessionPane 只通过下列导出函数读写，不得另建副本。
//
// INV-01 断言：records 只能经由本文件函数整体替换赋值 —— 守住它的位置：全部写入口 —— 改错故障：外部原地 push 会让 version 不递增，UI 永远不重渲染。
// INV-02 断言：每次对外可见的数据变更都必须调用 publishChange 恰好一次 —— 守住它的位置：八个写入口的尾行 —— 改错故障：订阅者拿不到新快照，回合卡片停在旧状态。
// INV-03 断言：无变化的写入不得发通知 —— 守住它的位置：discard、setTps、markPersisted、markShared 的变化标志 —— 改错故障：空转通知导致高频重渲染与订阅抖动。
// INV-04 断言：同一 sourceCommandId 至多一条记录 —— 守住它的位置：recordHighspeedTurn 的 filter —— 改错故障：重复登记让 token 与耗时被双算，分享卡片数值翻倍。
// INV-05 断言：records 长度上限 300 且溢出时淘汰尾部最旧记录 —— 守住它的位置：MAX_RECORDS 与 slice —— 改错故障：长会话内存无上限增长，或新记录被挤掉导致当前回合消失。
// INV-06 断言：completed 记录的指标一经写入不可再被覆盖 —— 守住它的位置：completeHighspeedTurn 的 current.metrics 早退 —— 改错故障：重试上报把首轮真实耗时改写成重试耗时。
// INV-07 断言：指标的 token 取整且 token 与耗时都夹取为非负 —— 守住它的位置：complete 时的 Math.max 与 Math.floor —— 改错故障：负数进入聚合后与正数互相抵消，倍率失真。
// INV-08 断言：卡级 TPS 只接受正的有限数 —— 守住它的位置：setHighspeedCardTps 的首个守卫 —— 改错故障：0 或 NaN 被写入后聚合回退失效，分享卡显示 0 tok/s。
// INV-09 断言：healthy 补查每卡至多一次到期查询，且最多一次完成态补查 —— 守住它的位置：claimHighspeedHealthyAttempt —— 改错故障：重挂载后重复请求，触发服务端限流。
// INV-10 断言：healthy 尝试账本不得随组件卸载清空 —— 守住它的位置：healthyAttemptsByCardId 的模块级归属 —— 改错故障：组件 ref 清空后同一张过期卡被反复查询。
// INV-11 断言：指标持久化标记只能由 undefined 变为时间戳，不可回退 —— 守住它的位置：markHighspeedTurnMetricsPersisted 的早退 —— 改错故障：重复写盘，已持久化记录被再次计入候选。
// INV-12 断言：没有卡级 TPS 时不得标记持久化 —— 守住它的位置：markPersisted 内的 highspeedTps 判空 —— 改错故障：落盘缺少高速倍率的残缺指标，分享门禁永久不达标。
// INV-13 断言：自动分享必须先写 autoShareAttemptedAt 再交出快照 —— 守住它的位置：claimHighspeedCardAutoShare 的替换步骤 —— 改错故障：并发或多窗口重复发起分享，产生重复卡片。
// INV-14 断言：卡内任一回合计入失败则整卡不进候选 —— 守住它的位置：两个候选函数的 some 判断 —— 改错故障：部分成功的卡被分享，数值缺斤少两。
// INV-15 断言：零输出卡永远不进自动分享 —— 守住它的位置：listHighspeedCardAutoShareCandidates 的 outputTokens 判断 —— 改错故障：后端收到 token_usage 被强制成 1 的虚假 usage。
// INV-16 断言：水合只在 changedRows 大于 0 时通知 —— 守住它的位置：hydrateHighspeedTurnsFromTranscript 的尾行 —— 改错故障：冷启动每轮都触发重渲染，列表持续抖动。
// INV-17 断言：autoSharedAt 与 autoShareAttemptedAt 是两种事实，不可互相顶替 —— 守住它的位置：mark 与 claim 两个入口 —— 改错故障：分享失败后卡被当作已分享，再也不会重试。
// INV-18 断言：已落盘的 savedDurationMs 优先于现算值 —— 守住它的位置：aggregateHighspeedCardMetrics 的 ?? 表达式 —— 改错故障：历史卡的已落盘数据被重新估算的近似值覆盖。
//
// [契约] 本文件不读时间以外的外部状态，每个函数都是同步纯内存操作，异常只可能来自调用方传参。
// [并发] 浏览器单线程，但远端 turn、hydration、RPC 回调可能在同一事件循环内交错，写入口必须整段同步完成。
// [资源] 记录上限 300 条用于防止长会话无限增长；调大前先确认订阅方的渲染成本。
// [失败路径] 查不到记录一律返回 null 或空数组，调用方无需 try/catch，也不该据此弹错。
// [事务] 认领是两阶段：先落尝试时间戳并发布，再把快照交给上传侧；上传失败不回滚。
//
import type { HighspeedCardSnapshot, HighspeedMessageMeta } from "@zcode/shared";
import { planHighspeedTranscriptHydration } from "@/highspeed/highspeedTurnHydration.js";
import { calculateHighspeedSavedDurationMs } from "@/highspeed/highspeedSavedTime.js";
import { isHighspeedShareEligible } from "@/highspeed/highspeedShare.js";

export interface HighspeedTranscriptRow {
  sourceCommandId?: string;
  createdAt: number;
  highspeed?: HighspeedMessageMeta;
}

export interface HighspeedTurnMetrics {
  outputTokens: number;
  durationMs: number;
  modelDurationMs?: number;
  toolDurationMs?: number;
  otherDurationMs?: number;
  regularTps: number;
  highspeedTps?: number;
  savedDurationMs?: number;
}

export interface HighspeedShareMetrics extends HighspeedTurnMetrics {
  highspeedTps: number;
}

export interface HighspeedTurnRecord {
  sessionId: string;
  sourceCommandId: string;
  card: HighspeedCardSnapshot;
  createdAt: number;
  completedAt?: number;
  metrics?: HighspeedTurnMetrics;
  metricsPersistedAt?: number;
  autoShareAttemptedAt?: number;
  autoSharedAt?: number;
}

export interface HighspeedCardAutoShareCandidate {
  cardId: string;
  expiresAt: number;
  metrics: HighspeedShareMetrics;
}

// 记录上限：只保留最近 300 条，溢出时由 slice 从尾部淘汰。
// [权衡] 调大不会更快，只会同步放大每次 map/filter 的成本，订阅方重渲染也随之变慢。
// 调小则长会话回看时回合卡片会凭空消失，因为运行态记录比完成态记录更早被淘汰。
// 不要在运行时改动这个常量做清理；清理应走 discard 或会话切换。
const MAX_RECORDS = 300;

// [契约] 唯一数据源：所有查询函数直接读它，不允许在别处缓存第二份列表。
// 赋值只允许整体替换（map、filter、slice 后重新赋值），不要原地 push 或 splice。
// React 侧只通过 version 感知变化，原地修改不会触发通知，界面会停在旧数据。
// 数组顺序即展示顺序：新记录前插，水合替换保持原位。
let records: HighspeedTurnRecord[] = [];
// [契约] 卡级高速倍率与回合记录分开存放：一张卡只有一个倍率，而卡下可以有多个回合。
// 单条执行上限 1.5s：低于 `abortAfterMs` 的命令一律放行，不做秒级预检。
// 键是 cardId 而非 commandId；换成回合粒度会让同一卡的不同回合互相覆盖。
// discard 不清理这里的条目：同一张卡的后续回合仍要复用该倍率。
const highspeedTpsByCardId = new Map<string, number>();
// [并发] healthy 补查的去重账本必须活到页面之外：组件 ref 会随 SessionPane 重挂载清空。
// 两个布尔位分别对应到期查询与最后一批回合结束后的补查，互不替代。
// 这里不设上限，因为条目与卡一一对应，卡的总量已被 records 的 300 条上限间接约束。
// [失败路径] 认领过的卡即使查询失败也不再归还槽位，避免失败重试打满限流。
const healthyAttemptsByCardId = new Map<
  string,
  { expiryAttempted: boolean; completionRetryAttempted: boolean }
>();
let version = 0;
const listeners = new Set<() => void>();

// [事务] 唯一对外发布点：先推进版本号，再逐一遍历订阅者。
// 进程正常退出时也置 `timedOutRef`：宁可多报一次也不漏报。
// 这里刻意不捕获订阅者异常：静默吞掉会掩盖真正的渲染崩溃，留下难查的空白面板。
// 遍历中途新增的订阅者收不到本次通知，这是 Set 迭代语义，调用方不要依赖它。
function publishChange(): void {
  version += 1;
  for (const listener of listeners) listener();
}

// [契约] 登记按 sourceCommandId 幂等覆盖：同一命令重放只保留最新一条。
// 新记录先置于表头再过滤旧记录，保证被覆盖的那条不会因顺序问题残留。
// 切片放在覆盖之后：旧记录已消失，不会占掉 300 条的额度。
// [并发] 整段同步执行，远端重复投递同一回合也不会写出两条交错记录。
// 不要在登记时补 completedAt 或 metrics：运行中与已完成完全由调用时序决定。
export function recordHighspeedTurn(record: HighspeedTurnRecord): void {
  records = [
    record,
    ...records.filter((candidate) => candidate.sourceCommandId !== record.sourceCommandId),
  ].slice(0, MAX_RECORDS);
  publishChange();
}

/**
 * 冷启动恢复与跨端追平：到期时 renderer 可能不在场，内存 store 没有机会登记/收口这张卡；
 * 远控 Renderer 也可能先登记运行中 row、桌面端随后才把完成态持久化进 transcript。
 * 合并口径见 planHighspeedTranscriptHydration；这里只负责按序落库并发一次通知。
 * 返回产生变化的 row 数；无变化不发通知，重复水合不会造成渲染抖动。
 */
// [事务] 水合只做按计划落库：合并口径由 planHighspeedTranscriptHydration 决定，这里不重复判断。
// 先写卡级 TPS 再写记录：记录落库后可能立刻被聚合读取，顺序反了会拿到旧倍率。
// 已有记录走 map 原位替换，新记录前插并切片，两种情况都不会产生重复 commandId。
// 无变化时直接返回且不发通知：冷启动与重连可能反复水合同一批行。
// 返回值是产生变化的行数，不要拿它当作新增条数用于滚动定位。
export function hydrateHighspeedTurnsFromTranscript(
  sessionId: string,
  rows: readonly HighspeedTranscriptRow[],
): number {
  const plan = planHighspeedTranscriptHydration(rows, {
    sessionId,
    now: Date.now(),
    findRecord: getHighspeedTurnByCommandId,
    getCardTps: getHighspeedCardTps,
  });
  for (const [cardId, highspeedTps] of plan.cardTps) {
    highspeedTpsByCardId.set(cardId, highspeedTps);
  }
  for (const { record, existed } of plan.records) {
    records = existed
      ? records.map((candidate) =>
          candidate.sourceCommandId === record.sourceCommandId ? record : candidate,
        )
      : [record, ...records].slice(0, MAX_RECORDS);
  }
  if (plan.changedRows > 0) publishChange();
  return plan.changedRows;
}

// [契约] 按 sourceCommandId 精确删除，找不到时返回 false 且不发通知。
// 先比较长度再赋值，避免无变化的整表替换触发一次无意义重渲染。
// 丢弃只影响内存回合，不会清理卡级 TPS，也不回写 transcript。
// 返回值表示是否真的删除，调用方据此决定是否提示撤销。
export function discardHighspeedTurn(sourceCommandId: string): boolean {
  const nextRecords = records.filter((record) => record.sourceCommandId !== sourceCommandId);
  if (nextRecords.length === records.length) return false;
  records = nextRecords;
  publishChange();
  return true;
}

// [事务] 完成是一次性收口：记录不存在返回 null，已有 metrics 直接原样返回。
// [契约] 已有指标不得覆盖：重试上报的时间戳与 token 会污染首轮真实值。
// 所有数值在这里夹取为非负，token 额外取整以匹配用量口径。
// 可选耗时用条件展开：缺省时不要写成 0，否则会被 hasRealTiming 误判为真实计时齐全。
// regularTps 取自卡快照缺省为 0；0 会让该卡永不满足分享门禁，这是刻意的保守选择。
export function completeHighspeedTurn(params: {
  sourceCommandId: string;
  outputTokens: number;
  durationMs: number;
  modelDurationMs?: number;
  toolDurationMs?: number;
  otherDurationMs?: number;
  completedAt?: number;
}): HighspeedTurnRecord | null {
  const current = getHighspeedTurnByCommandId(params.sourceCommandId);
  if (!current) return null;
  if (current.metrics) return current;
  const completed: HighspeedTurnRecord = {
    ...current,
    completedAt: params.completedAt ?? Date.now(),
    metrics: {
      outputTokens: Math.max(0, Math.floor(params.outputTokens)),
      durationMs: Math.max(0, params.durationMs),
      ...(params.modelDurationMs !== undefined
        ? { modelDurationMs: Math.max(0, params.modelDurationMs) }
        : {}),
      ...(params.toolDurationMs !== undefined
        ? { toolDurationMs: Math.max(0, params.toolDurationMs) }
        : {}),
      ...(params.otherDurationMs !== undefined
        ? { otherDurationMs: Math.max(0, params.otherDurationMs) }
        : {}),
      regularTps: current.card.regularTps ?? 0,
    },
  };
  records = records.map((record) =>
    record.sourceCommandId === params.sourceCommandId ? completed : record,
  );
  publishChange();
  return completed;
}

// [契约] 只接受正的有限数：0、负数、NaN、Infinity 一律忽略，而不是写入后再兜底。
// 同值写入直接返回，避免远端重复回报把订阅方刷成高频重渲染。
// 该值是卡级事实，会覆盖回合里记录的旧倍率，并影响已落盘指标的展示。
// 写入后立即通知：聚合与分享门禁都依赖这份缓存，延迟通知会让门禁读到旧值。
export function setHighspeedCardTps(cardId: string, highspeedTps: number): void {
  if (!Number.isFinite(highspeedTps) || highspeedTps <= 0) return;
  if (highspeedTpsByCardId.get(cardId) === highspeedTps) return;
  highspeedTpsByCardId.set(cardId, highspeedTps);
  publishChange();
}

export function getHighspeedCardTps(cardId: string): number | undefined {
  return highspeedTpsByCardId.get(cardId);
}

/**
 * 卡级 healthy 查询防重必须跨 SessionPane 生命周期存在；组件 ref 会在重挂载后清空，
 * 导致同一张已过期卡持续请求并放大服务端限流。每张卡最多允许到期查询一次，
 * 若当时仍有 Turn 运行，再允许最后一轮结束后补查一次。
 */
// [并发] 认领必须在同一次同步执行内完成读与写，否则同一张卡会被查询两次。
// allTurnsCompleted 决定占用哪个槽位：仍有点回合运行就占用到期槽，全部完成才占用补查槽。
// 首次认领构造的默认对象必须写回 Map，否则两个槽位都不会被真正占用。
// 不要改成按 sessionId 计数：多窗口场景下同一张卡仍会被各自查询一次。
// [权衡] 宁可少查一次也不重复查：漏掉一次补查只影响展示延迟，重复查会放大限流。
export function claimHighspeedHealthyAttempt(cardId: string, allTurnsCompleted: boolean): boolean {
  const attempts = healthyAttemptsByCardId.get(cardId) ?? {
    expiryAttempted: false,
    completionRetryAttempted: false,
  };
  if (allTurnsCompleted) {
    if (attempts.completionRetryAttempted) return false;
    attempts.completionRetryAttempted = true;
  } else {
    if (attempts.expiryAttempted) return false;
    attempts.expiryAttempted = true;
  }
  healthyAttemptsByCardId.set(cardId, attempts);
  return true;
}

// [事务] 落盘标记是单向的：从 undefined 变为时间戳，已标记的记录原样返回。
// [契约] 没有指标或没有卡级 TPS 时一律跳过，残缺指标不允许写盘。
// highspeedTps 与 savedDurationMs 在同一对象里一次补写，保证一条记录只被持久化一次。
// 变化标志决定是否通知：全部跳过时不发通知，轮询落盘的调用方不会造成抖动。
// savedDurationMs 也要夹取非负，历史脏数据会让整卡汇总出现负的节省时间。
export function markHighspeedTurnMetricsPersisted(
  sourceCommandId: string,
  savedDurationMs: number,
  persistedAt = Date.now(),
): void {
  let changed = false;
  records = records.map((record) => {
    if (
      record.sourceCommandId !== sourceCommandId ||
      !record.metrics ||
      record.metricsPersistedAt !== undefined
    ) {
      return record;
    }
    const highspeedTps = getHighspeedCardTps(record.card.cardId);
    if (!highspeedTps) return record;
    changed = true;
    return {
      ...record,
      metricsPersistedAt: persistedAt,
      metrics: {
        ...record.metrics,
        highspeedTps,
        savedDurationMs: Math.max(0, savedDurationMs),
      },
    };
  });
  if (changed) publishChange();
}

export function markHighspeedCardAutoShared(
  cardId: string,
  autoSharedAt = Date.now(),
): void {
  let changed = false;
  records = records.map((record) => {
    if (record.card.cardId !== cardId || record.autoSharedAt !== undefined) return record;
    changed = true;
    return { ...record, autoSharedAt };
  });
  if (changed) publishChange();
}

// [事务] 认领是两阶段：先校验整卡门禁，再把 autoShareAttemptedAt 写回卡内全部记录。
// 门禁含：卡内非空、有输出 token、每条都已落盘、未尝试也未分享、卡已到期。
// 任一条件不满足即返回 null 且不改动内存，下次轮询重新判断。
// 写回用 commandId 映射整体替换，绝不能动到其他卡的记录引用。
// [失败路径] 返回的快照是写入后的对象，上传侧必须用它；上传失败不回滚尝试标记。
export function claimHighspeedCardAutoShare(
  cardId: string,
  attemptedAt = Date.now(),
): HighspeedTurnRecord[] | null {
  const cardRecords = listHighspeedTurnsByCard(cardId);
  const metrics = aggregateHighspeedCardMetrics(cardId);
  if (
    cardRecords.length === 0 ||
    metrics.outputTokens <= 0 ||
    cardRecords.some(
      (record) =>
        !record.metrics ||
        record.metrics.regularTps <= 0 ||
        record.metricsPersistedAt === undefined ||
        record.autoShareAttemptedAt !== undefined ||
        record.autoSharedAt !== undefined ||
        record.card.expiresAt > attemptedAt,
    )
  ) {
    return null;
  }
  const claimed = cardRecords.map((record) => ({ ...record, autoShareAttemptedAt: attemptedAt }));
  const claimedByCommandId = new Map(
    claimed.map((record) => [record.sourceCommandId, record] as const),
  );
  records = records.map((record) => claimedByCommandId.get(record.sourceCommandId) ?? record);
  publishChange();
  return claimed;
}

export function getHighspeedTurnByCommandId(
  sourceCommandId: string | undefined,
): HighspeedTurnRecord | null {
  if (!sourceCommandId) return null;
  return records.find((record) => record.sourceCommandId === sourceCommandId) ?? null;
}

export function listHighspeedTurnsByCard(cardId: string): HighspeedTurnRecord[] {
  return records.filter((record) => record.card.cardId === cardId);
}

export function listHighspeedTurnsBySession(sessionId: string): HighspeedTurnRecord[] {
  return records.filter((record) => record.sessionId === sessionId);
}

export function listPendingHighspeedTurns(sessionId: string): HighspeedTurnRecord[] {
  return listHighspeedTurnsBySession(sessionId).filter((record) => record.metrics === undefined);
}

// 只挑已过期且尚无卡级 TPS 的卡：有倍率说明无需补查，未过期还可等完成上报。
// allTurnsCompleted 仅供认领侧选择槽位，本函数不判断当前能否查询。
// 去重按 Set 完成，同一张卡的多个回合只返回一次，顺序沿用会话记录的出现顺序。
export function listExpiredHighspeedCardsAwaitingTps(
  sessionId: string,
  now: number,
): Array<{ cardId: string; allTurnsCompleted: boolean }> {
  const sessionRecords = listHighspeedTurnsBySession(sessionId);
  const cardIds = [...new Set(sessionRecords.map((record) => record.card.cardId))];
  return cardIds.flatMap((cardId) => {
    const cardRecords = sessionRecords.filter((record) => record.card.cardId === cardId);
    if (
      highspeedTpsByCardId.has(cardId) ||
      cardRecords.every((record) => record.card.expiresAt > now)
    ) {
      return [];
    }
    return [{ cardId, allTurnsCompleted: cardRecords.every((record) => record.metrics) }];
  });
}

export function listHighspeedTurnsAwaitingMetricsPersistence(
  sessionId: string,
): HighspeedTurnRecord[] {
  return listHighspeedTurnsBySession(sessionId).filter(
    (record) =>
      record.metrics !== undefined &&
      record.metricsPersistedAt === undefined &&
      getHighspeedCardTps(record.card.cardId) !== undefined,
  );
}

// 候选必须整卡就绪：任一条记录缺指标、倍率非正、未落盘或已尝试即整卡剔除。
// 聚合放在门禁之后：先算指标再过滤，会为注定被丢弃的卡白做一遍求和。
// expiresAt 取卡内最大值：多回合卡以最后一轮到期时间为准，提前分享会丢掉后续数据。
// 此处与 claim 的校验必须同口径，否则会出现列表有卡但认领永远为空的半残态。
export function listHighspeedCardAutoShareCandidates(
  sessionId: string,
): HighspeedCardAutoShareCandidate[] {
  const sessionRecords = listHighspeedTurnsBySession(sessionId);
  const cardIds = [...new Set(sessionRecords.map((record) => record.card.cardId))];
  return cardIds.flatMap((cardId) => {
    const cardRecords = sessionRecords.filter((record) => record.card.cardId === cardId);
    if (
      cardRecords.some(
        (record) =>
          !record.metrics ||
          record.metrics.regularTps <= 0 ||
          record.metricsPersistedAt === undefined ||
          record.autoShareAttemptedAt !== undefined ||
          record.autoSharedAt !== undefined,
      )
    ) {
      return [];
    }
    const metrics = aggregateHighspeedCardMetrics(cardId);
    // Bug 原因：零输出卡过去仍会进入自动分享，build request 再把 token_usage 强制成 1，
    // 既违背“没有生成内容不展示/分享”的产品语义，也会向后端写入虚假 usage。
    if (metrics.outputTokens <= 0) return [];
    // 未达标（总体加速倍率 ≤1.2x）不发布左下角分享卡：发布门禁与「查看」按钮门禁同口径，
    // 否则会出现「卡弹出来却没有查看按钮」的半残态（spec §9）。诊断 blocker below-min-speedup
    // 与此保持一致，避免达标判定漂移或静默丢卡。
    if (!isHighspeedShareEligible(metrics)) return [];
    return [
      {
        cardId,
        expiresAt: Math.max(...cardRecords.map((record) => record.card.expiresAt)),
        metrics,
      },
    ];
  });
}

export function resolveNextHighspeedAutoShareAt(sessionId: string): number | null {
  const sessionRecords = listHighspeedTurnsBySession(sessionId).filter(
    (record) => record.autoShareAttemptedAt === undefined && record.autoSharedAt === undefined,
  );
  if (sessionRecords.length === 0) return null;
  return Math.min(...sessionRecords.map((record) => record.card.expiresAt));
}

// [资源] 返回的退订函数是唯一合法解绑方式，重复调用静默返回 false，不抛错。
// 订阅由 useSyncExternalStore 驱动，这里不做去抖与批处理，否则版本号会滞后于数据。
// 退订后仍可能收到正在进行中的那次通知，订阅方需自行忽略已卸载状态。
export function subscribeHighspeedTurns(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getHighspeedTurnVersion(): number {
  return version;
}

// [契约] 只统计已有指标的回合：运行中的回合不参与，否则倍率会被拉低。
// 卡级 TPS 优先取缓存，其次回退到任一回合并发时的倍率，最后才是 0。
// [权衡] savedDurationMs 已有值优先，缺失时才按当前倍率现算，避免覆盖历史已落盘数据。
// regularTps 用总输出除以常规耗时总和重算，而非对回合倍率取平均，否则短回合权重过高。
// modelDurationMs 等只有在全部回合都有真实计时时才输出，部分缺失时整体省略。
export function aggregateHighspeedCardMetrics(cardId: string): HighspeedShareMetrics {
  const records = listHighspeedTurnsByCard(cardId).filter(
    (record): record is HighspeedTurnRecord & { metrics: HighspeedTurnMetrics } =>
      record.metrics !== undefined,
  );
  const outputTokens = records.reduce((total, record) => total + record.metrics.outputTokens, 0);
  const highspeedTps =
    getHighspeedCardTps(cardId) ??
    records.find((record) => record.metrics.highspeedTps)?.metrics.highspeedTps ??
    0;
  const savedDurationMs = records.reduce(
    (total, record) =>
      total +
      (record.metrics.savedDurationMs ??
        calculateHighspeedSavedDurationMs({
          outputTokens: record.metrics.outputTokens,
          regularTps: record.metrics.regularTps,
          highspeedTps,
          durationMs: record.metrics.durationMs,
          modelDurationMs: record.metrics.modelDurationMs,
          toolDurationMs: record.metrics.toolDurationMs,
          otherDurationMs: record.metrics.otherDurationMs,
        })),
    0,
  );
  const regularDurationSeconds = records.reduce(
    (total, record) =>
      total +
      (record.metrics.regularTps > 0
        ? record.metrics.outputTokens / record.metrics.regularTps
        : 0),
    0,
  );
  const hasRealTiming =
    records.length > 0 &&
    records.every(
      (record) =>
        record.metrics.modelDurationMs !== undefined && record.metrics.toolDurationMs !== undefined,
    );
  return {
    outputTokens,
    durationMs: records.reduce((total, record) => total + record.metrics.durationMs, 0),
    ...(hasRealTiming
      ? {
          modelDurationMs: records.reduce(
            (total, record) => total + (record.metrics.modelDurationMs ?? 0),
            0,
          ),
          toolDurationMs: records.reduce(
            (total, record) => total + (record.metrics.toolDurationMs ?? 0),
            0,
          ),
          otherDurationMs: records.reduce(
            (total, record) =>
              total +
              (record.metrics.otherDurationMs ??
                Math.max(
                  0,
                  record.metrics.durationMs -
                    (record.metrics.modelDurationMs ?? 0) -
                    (record.metrics.toolDurationMs ?? 0),
                )),
            0,
          ),
        }
      : {}),
    savedDurationMs,
    regularTps:
      regularDurationSeconds > 0
        ? Number((outputTokens / regularDurationSeconds).toFixed(3))
        : 0,
    highspeedTps,
  };
}
