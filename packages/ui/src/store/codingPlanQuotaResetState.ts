// 编码计划配额重置的 UI 状态投影：把跨窗口、跨鉴权的“自动完成”提示收敛成可判定的状态机。
// 本文件只做纯状态推演与广播协议解析，不持有 React 生命周期，也不直接访问服务实现。
// 三张按 source 切分的映射表由同一个 updater 原子写入，任何跨表写入都不允许拆成两次。
// 播放资格 = 已观察 + 未播放 + 仍挂载；三者在 reserve 与 commit 两个阶段被分别校验。
// INV-01 鉴权会话序号不一致时写入必须是空补丁并保持原引用；守住位置：updateCodingPlanQuotaResetStoreState 的 authSessionSeq 早退分支；改错故障：退出登录后旧请求落地，登录页闪出上一账号的重置提示。
// INV-02 UI entry 与自动完成观察记录必须在同一次 updater 内落库；守住位置：updateCodingPlanQuotaResetStoreState 返回的 patch；改错故障：entry 已更新而观察缺失，动画在下一轮轮询中重复播放。
// INV-03 观察到同一 used_at 时不得改写鉴权会话序号；守住位置：previousObservation 相等分支；改错故障：重新登录后旧历史被当成本会话首见，已结束的动画重新撒花。
// INV-04 只有 startedAt 为空的 completed entry 才算自动完成；守住位置：automaticCompletedAt 的三元判定；改错故障：用户手动触发的重置被误当作系统完成，播放一次无来由的庆祝。
// INV-05 played 是单调游标，跨窗口广播只允许前进不允许回退；守住位置：applyCodingPlanQuotaResetAutoPlayedBroadcast 的数值比较；改错故障：乱序旧广播覆盖新记录，同一 used_at 在第二个窗口再播一次。
// INV-06 收到他窗口已播广播后必须清空本地 observedAt；守住位置：applyCodingPlanQuotaResetAutoPlayedBroadcast 的 entry 改写分支；改错故障：两个窗口同时撒花，Tooltip 叠在一起无法关闭。
// INV-07 claim key 必须由 source、类型、used_at 三段稳定拼出；守住位置：buildCodingPlanQuotaResetAutoPlayClaimKey；改错故障：两窗口生成不同 key，Main 无法串行化，去重彻底失效。
// INV-08 sourceKey 参与 key 前必须做 URI 编码；守住位置：buildCodingPlanQuotaResetAutoPlayClaimKey 的模板拼接；改错故障：含冒号的远程路径截断 key，不同 source 落到同一 claim 上互相阻塞。
// INV-09 广播 payload 非法时返回 null 而不是抛错；守住位置：parseCodingPlanQuotaResetAutoPlayedPayload 的全部校验；改错故障：一条脏消息打断整个监听回调，后续合法广播全部丢失。
// INV-10 本地回声消息必须被丢弃；守住位置：parseCodingPlanQuotaResetAutoPlayedBroadcastMessage 的 sourceWindowId 判断；改错故障：自己刚播完就收到自己的广播，动画被立即收起。
// INV-11 reserve 阶段只占用临时 lease，绝不写 played；守住位置：reserveCodingPlanQuotaResetAutoPlay 的返回分支；改错故障：组件中途卸载也把提示标记为已播，用户永远看不到这次完成。
// INV-12 claim 获取抛错或 busy 一律映射为 retry 并带退避；守住位置：reserveCodingPlanQuotaResetAutoPlay 的异常与 busy 分支；改错故障：把等待误判为 blocked，争用高峰期的提示被静默吞掉。
// INV-13 等待 Main 返回后必须重读 state 再判定候选；守住位置：reserveCodingPlanQuotaResetAutoPlay 的 latestState 校验；改错故障：基于过期快照提交，播完一个已被其他窗口消费的 used_at。
// INV-14 候选失效时必须释放 lease 再返回；守住位置：reserveCodingPlanQuotaResetAutoPlay 的提前退出收尾；改错故障：lease 泄漏到 TTL 过期，其他窗口在这段时间内全部被挡。
// INV-15 committed 状态只代表占用，不代表已播；守住位置：reserveCodingPlanQuotaResetAutoPlay 的 committed 分支；改错故障：输家提前清 observedAt，本窗口的撒花被自己取消。
// INV-16 commit 必须在 updater 内重新判定候选；守住位置：commitCodingPlanQuotaResetAutoPlay 的 writeState 回调；改错故障：卸载后又调度提交，已销毁界面的状态仍被写成已播。
// INV-17 本地 played 要先落库，再提交 Main 与广播；守住位置：commitCodingPlanQuotaResetAutoPlay 的调用顺序；改错故障：广播先到而本地未写，收到回声前又触发一次播放。
// INV-18 每条 reservation 都必须有唯一释放路径；守住位置：releaseCodingPlanQuotaResetAutoPlay 与卸载清理；改错故障：窗口关闭后 lease 悬空，其余窗口的自动完成被永久阻塞。
// INV-19 action 只通过注入的服务与读写函数工作；守住位置：createCodingPlanQuotaResetStoreActions 的闭包；改错故障：模块级单例把两个 store 实例串在一起，测试与真实窗口互相污染。
import type { BroadcastClaimLease, BroadcastMessage, IBroadcastService } from "@zcode/services";
import type { CodingPlanResetType } from "@zcode/shared";
import type {
  CodingPlanQuotaResetUiEntries,
  CodingPlanQuotaResetUiEntry,
} from "@/lib/codingPlanQuotaResetUi.js";

// 观察记录回答“这个 used_at 首次出现在哪个鉴权会话”，而不是“当前会话又看到了它”
// completedAt 与 authSessionSeq 同生共死，缺一项就无法判断是否该重新播放
// 结构刻意保持扁平：跨窗口广播与持久化都按整对象替换，不做字段级合并
export interface CodingPlanQuotaResetAutomaticObservation {
  completedAt: number;
  /** 同一 renderer 生命周期内，用户由未登录进入登录态时递增的鉴权会话序号。 */
  authSessionSeq: number;
}

export interface CodingPlanQuotaResetAutomaticObservations {
  fiveHour: CodingPlanQuotaResetAutomaticObservation | null;
  week: CodingPlanQuotaResetAutomaticObservation | null;
}

/** 跨窗口已播记录：source + 类型 -> 已在任一窗口播放过自动完成提示的 used_at。 */
export interface CodingPlanQuotaResetAutoPlayedSlot {
  fiveHour: number | null;
  week: number | null;
}

// zustand 状态形状只有四个顶层字段，其余映射一律按 sourceKey 分桶
// 按 source 分桶让不同账号、不同通道的提示互不覆盖，也让 reset 只影响单个来源
// 每个 patch 都要求返回三张表的完整引用，store 侧据此做引用比较，避免无关 source 触发重渲染
// authSessionSeq 是唯一的鉴权代际水位，任何跨会话写入都必须先与它比对
export interface CodingPlanQuotaResetStoreState {
  authSessionSeq: number;
  codingPlanQuotaResetUiBySource: Record<string, CodingPlanQuotaResetUiEntries>;
  codingPlanQuotaResetAutomaticObservationsBySource: Record<
    string,
    CodingPlanQuotaResetAutomaticObservations
  >;
  codingPlanQuotaResetAutoPlayedBySource: Record<string, CodingPlanQuotaResetAutoPlayedSlot>;
}

/** 自动完成"多窗口只播一次"的跨窗口广播频道（state: 前缀符合跨窗口状态同步约定）。 */
// state 前缀让该频道走跨窗口状态同步通道，与普通业务事件区分开
// 频道名是外部契约：改动等于让新旧版本窗口互相听不见，必须与广播端同步发布
// 频道常量只此一份，解析与发送都引用它，禁止在调用点写字面量
export const CODING_PLAN_QUOTA_RESET_AUTO_PLAYED_CHANNEL = "state:codereset-autoplayed";

export interface CodingPlanQuotaResetAutoPlayedBroadcastPayload {
  sourceKey: string;
  resetType: CodingPlanResetType;
  completedAt: number;
}

// claim key 是 Main 侧请求去重的唯一身份，同一批提示必须在任意窗口算出相同字符串
// sourceKey 走 URI 编码，避免分隔符与远程标识里的特殊字符改写 key 结构
// used_at 参与 key 意味着同一 source 的两次不同重置各自独立抢占，不会互相顶掉
export function buildCodingPlanQuotaResetAutoPlayClaimKey(
  sourceKey: string,
  resetType: CodingPlanResetType,
  completedAt: number,
): string {
  return `coding-plan-reset-autoplay:${encodeURIComponent(sourceKey)}:${resetType}:${completedAt}`;
}

// payload 来自其他窗口，按不可信输入处理：类型、有限数、非空串逐项校验后才采信
// 校验失败返回 null 而非抛错，广播监听回调里一条脏数据不能终止后续分发
// resetType 只接受两个字面量，未知枚举值视为坏消息，防止新版本字段流入旧逻辑
export function parseCodingPlanQuotaResetAutoPlayedPayload(
  payload: unknown,
): CodingPlanQuotaResetAutoPlayedBroadcastPayload | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const sourceKey = typeof record.sourceKey === "string" ? record.sourceKey.trim() : "";
  const resetType =
    record.resetType === "WEEK" || record.resetType === "FIVE_HOUR" ? record.resetType : null;
  const completedAt =
    typeof record.completedAt === "number" && Number.isFinite(record.completedAt)
      ? record.completedAt
      : null;
  if (!sourceKey || !resetType || completedAt === null) {
    return null;
  }
  return { sourceKey, resetType, completedAt };
}

/**
 * 解析"自动完成已播"跨窗口广播；非本频道消息、本地回声与非法 payload 均返回 null。
 *
 * host 的 send 会先把消息本地回声给本窗口 Renderer（无 sourceWindowId）；
 * 只有 BroadcastHub 中转的跨窗口消息才带 sourceWindowId，本地回声必须忽略，
 * 否则自己刚广播的"已播放"会把自己的动画当场抑制掉。
 */
export function parseCodingPlanQuotaResetAutoPlayedBroadcastMessage(
  message: Pick<BroadcastMessage, "channel" | "payload" | "sourceWindowId">,
): CodingPlanQuotaResetAutoPlayedBroadcastPayload | null {
  if (message.channel !== CODING_PLAN_QUOTA_RESET_AUTO_PLAYED_CHANNEL) {
    return null;
  }
  if (message.sourceWindowId === undefined) {
    return null;
  }
  return parseCodingPlanQuotaResetAutoPlayedPayload(message.payload);
}

/**
 * 广播本窗口首次播放的自动完成 used_at，其他窗口收到后抑制同 used_at 的提示。
 */
export function broadcastCodingPlanQuotaResetAutoPlayed(
  broadcastService: Pick<IBroadcastService, "send">,
  sourceKey: string,
  resetType: CodingPlanResetType,
  completedAt: number,
): void {
  // 发送是即发即忘：不等待回执，播放流程不能被广播链路延迟拖住
  // 本地回声由解析侧丢弃，这里不做窗口身份判断，保持发送与接收职责分离
  // 广播失败只影响其他窗口的抑制，本窗口的 played 已在 commit 落库，不会二次播放
  void broadcastService.send({
    channel: CODING_PLAN_QUOTA_RESET_AUTO_PLAYED_CHANNEL,
    payload: { sourceKey, resetType, completedAt },
  });
}

export interface CodingPlanQuotaResetStoreUpdate {
  patch: Pick<
    CodingPlanQuotaResetStoreState,
    | "codingPlanQuotaResetUiBySource"
    | "codingPlanQuotaResetAutomaticObservationsBySource"
    | "codingPlanQuotaResetAutoPlayedBySource"
  >;
}

/**
 * 原子写入重置 UI 状态和自动完成的鉴权会话轨迹，避免 entry 与观察记录跨 render 不一致。
 *
 * status 观察和 Composer 播放资格必须分离。设置页 / Usage 页也会调用本函数，
 * 如果在这里直接写 played，就会在没有展示 Tooltip/撒花时提前消耗跨窗口播放资格。
 */
export function updateCodingPlanQuotaResetStoreState(
  state: CodingPlanQuotaResetStoreState,
  sourceKey: string,
  resetType: CodingPlanResetType,
  entry: CodingPlanQuotaResetUiEntry | null,
  authSessionSeq: number,
): CodingPlanQuotaResetStoreUpdate {
  // 旧鉴权会话中的异步 status 可能在退出登录、组件卸载后才返回。
  // Store 必须在原子写入点校验序号，不能只依赖已卸载 Hook 内不会再更新的 ref。
  // 鉴权代际不一致时原样返回三张表的现有引用，形成零改动补丁
  // 已卸载 Hook 的 ref 不会再更新，序号校验必须落在 store 的原子写入点才算数
  // 这里不能顺手清空旧 source：登出并不等于用户放弃历史提示，清理归登出流程负责
  // 返回同一引用而非新空表，订阅方不会因为一次无效写入而重渲染
  if (state.authSessionSeq !== authSessionSeq) {
    return {
      patch: {
        codingPlanQuotaResetUiBySource: state.codingPlanQuotaResetUiBySource,
        codingPlanQuotaResetAutomaticObservationsBySource:
          state.codingPlanQuotaResetAutomaticObservationsBySource,
        codingPlanQuotaResetAutoPlayedBySource: state.codingPlanQuotaResetAutoPlayedBySource,
      },
    };
  }

  // 写前先浅拷贝外层映射，单个 source 的 entry 替换不影响其他 source 的引用
  // 两侧都为空时删除 bucket，让映射规模跟活跃 source 数量一致而不是跟历史数量一致
  // entry 为 null 表示清除该类型，不代表保持原值，调用方必须显式区分
  const nextEntries = { ...state.codingPlanQuotaResetUiBySource };
  const current = nextEntries[sourceKey] ?? { fiveHour: null, week: null };
  const updated =
    resetType === "WEEK" ? { ...current, week: entry } : { ...current, fiveHour: entry };
  if (updated.fiveHour === null && updated.week === null) {
    delete nextEntries[sourceKey];
  } else {
    nextEntries[sourceKey] = updated;
  }

  // 自动完成 = completed 且 startedAt 为空；手动触发的重置不参与播放资格
  // 这个判定同时服务观察记录与播放游标，两处口径必须一致，故抽成单点表达式
  // entry 为空或非 completed 时取 null，后续分支直接短路，不再构造观察对象
  const automaticCompletedAt =
    entry?.status === "completed" && entry.startedAt === null ? entry.completedAt : null;
  if (automaticCompletedAt === null) {
    return {
      patch: {
        codingPlanQuotaResetUiBySource: nextEntries,
        codingPlanQuotaResetAutomaticObservationsBySource:
          state.codingPlanQuotaResetAutomaticObservationsBySource,
        codingPlanQuotaResetAutoPlayedBySource: state.codingPlanQuotaResetAutoPlayedBySource,
      },
    };
  }

  const currentObservations = state.codingPlanQuotaResetAutomaticObservationsBySource[
    sourceKey
  ] ?? {
    fiveHour: null,
    week: null,
  };
  const previousObservation =
    resetType === "WEEK" ? currentObservations.week : currentObservations.fiveHour;
  // 观察记录表达“首次看到 used_at 的鉴权会话”。重新登录后同一历史的
  // 对账只能更新 entry，不能把 observation 改写到新会话，否则下一轮会重新播放旧动画。
  // 同一 used_at 的重复对账视为幂等，保留首见会话序号并返回未改动的观察表
  // 重新登录后的历史对账只允许刷新 entry，观察表保持旧代际，避免旧动画复活
  // 比较的是 completedAt 而非 entry 引用，status 轮询会不断产出等价的新对象
  if (previousObservation?.completedAt === automaticCompletedAt) {
    return {
      patch: {
        codingPlanQuotaResetUiBySource: nextEntries,
        codingPlanQuotaResetAutomaticObservationsBySource:
          state.codingPlanQuotaResetAutomaticObservationsBySource,
        codingPlanQuotaResetAutoPlayedBySource: state.codingPlanQuotaResetAutoPlayedBySource,
      },
    };
  }

  const nextObservations = {
    ...state.codingPlanQuotaResetAutomaticObservationsBySource,
  };
  const observation = { completedAt: automaticCompletedAt, authSessionSeq };
  nextObservations[sourceKey] =
    resetType === "WEEK"
      ? { ...currentObservations, week: observation }
      : { ...currentObservations, fiveHour: observation };

  return {
    patch: {
      codingPlanQuotaResetUiBySource: nextEntries,
      codingPlanQuotaResetAutomaticObservationsBySource: nextObservations,
      codingPlanQuotaResetAutoPlayedBySource: state.codingPlanQuotaResetAutoPlayedBySource,
    },
  };
}

/**
 * 应用来自其他窗口的"已播放"广播：合并 played 记录，并把本窗口正在播放的
 * 同 used_at 自动完成 observedAt 置空（收起 Tooltip、阻止后续撒花补播）。
 */
export function applyCodingPlanQuotaResetAutoPlayedBroadcast(
  state: Pick<
    CodingPlanQuotaResetStoreState,
    "codingPlanQuotaResetUiBySource" | "codingPlanQuotaResetAutoPlayedBySource"
  >,
  payload: CodingPlanQuotaResetAutoPlayedBroadcastPayload,
): Pick<
  CodingPlanQuotaResetStoreState,
  "codingPlanQuotaResetUiBySource" | "codingPlanQuotaResetAutoPlayedBySource"
> {
  // played 语义是“至少已播到哪个 used_at”，合并规则只允许数值变大
  // 先拷贝再按需写入，未命中的 source 保持原引用，减少无意义的重渲染
  // 旧广播晚到时不写 played，但仍继续走后面的 observedAt 抑制分支
  const playedBySource = { ...state.codingPlanQuotaResetAutoPlayedBySource };
  const slot = playedBySource[payload.sourceKey] ?? { fiveHour: null, week: null };
  const currentPlayed = payload.resetType === "WEEK" ? slot.week : slot.fiveHour;
  // 跨窗口消息可能乱序到达。played 是“至少已播到哪个 used_at”的单调游标，
  // 旧广播晚到不能把新记录回退，否则后续 status 会把已播完成再次当成候选。
  if (currentPlayed === null || payload.completedAt > currentPlayed) {
    playedBySource[payload.sourceKey] =
      payload.resetType === "WEEK"
        ? { ...slot, week: payload.completedAt }
        : { ...slot, fiveHour: payload.completedAt };
  }

  // 其他窗口已播同一 used_at 时，本窗口提示必须当场收起，observedAt 置空即取消播放资格
  // 四个条件同时成立才改写：completed、自动完成、used_at 相同、仍有 observedAt
  // 只清理匹配的那一侧 bucket，另一侧类型的进行中提示不受影响
  const entriesBySource = { ...state.codingPlanQuotaResetUiBySource };
  const entries = entriesBySource[payload.sourceKey];
  const key = payload.resetType === "WEEK" ? "week" : "fiveHour";
  const entry = entries?.[key];
  if (
    entry &&
    entry.status === "completed" &&
    entry.startedAt === null &&
    entry.completedAt === payload.completedAt &&
    entry.observedAt !== null
  ) {
    entriesBySource[payload.sourceKey] = {
      ...entries,
      [key]: { ...entry, observedAt: null },
    } as CodingPlanQuotaResetUiEntries;
  }

  return {
    codingPlanQuotaResetUiBySource: entriesBySource,
    codingPlanQuotaResetAutoPlayedBySource: playedBySource,
  };
}

type CodingPlanQuotaResetAutoPlayState = Pick<
  CodingPlanQuotaResetStoreState,
  "codingPlanQuotaResetUiBySource" | "codingPlanQuotaResetAutoPlayedBySource"
>;

export interface CodingPlanQuotaResetAutoPlayReservation {
  sourceKey: string;
  resetType: CodingPlanResetType;
  completedAt: number;
  lease: BroadcastClaimLease;
}

export type CodingPlanQuotaResetAutoPlayReservationAttempt =
  | { status: "reserved"; reservation: CodingPlanQuotaResetAutoPlayReservation }
  | { status: "retry"; retryAfterMs: number }
  | { status: "blocked" };

// 候选判定是 reserve 与 commit 的唯一口径，两处复用同一谓词，避免资格定义漂移
// 要求 completed、startedAt 为空、observedAt 非空、used_at 精确相等，缺一不可
// played 必须严格小于 used_at，等于即已播，防的是广播与轮询同时到达的竞态
// 纯函数且无副作用，便于在状态快照上反复求值而不触发写入
function isCodingPlanQuotaResetAutoPlayCandidate(
  state: CodingPlanQuotaResetAutoPlayState,
  sourceKey: string,
  resetType: CodingPlanResetType,
  completedAt: number,
): boolean {
  const key = resetType === "WEEK" ? "week" : "fiveHour";
  const candidate = state.codingPlanQuotaResetUiBySource[sourceKey]?.[key];
  const played = state.codingPlanQuotaResetAutoPlayedBySource[sourceKey]?.[key] ?? null;
  return Boolean(
    candidate?.status === "completed" &&
    candidate.startedAt === null &&
    candidate.observedAt !== null &&
    candidate.completedAt === completedAt &&
    (played === null || played < completedAt),
  );
}

/**
 * Composer 在播放自动完成提示前申请临时 reservation。
 *
 * reservation 与 played 提交必须分离。等待 Main 期间组件可能卸载或切换 source；
 * 此阶段只占用带 token 的临时 lease，不写 played、不广播，也不把 busy 误判为已播放。
 */
export async function reserveCodingPlanQuotaResetAutoPlay(params: {
  broadcastService: Pick<IBroadcastService, "acquireClaim" | "releaseClaim">;
  readState: () => CodingPlanQuotaResetAutoPlayState;
  writeState: (
    updater: (state: CodingPlanQuotaResetAutoPlayState) => CodingPlanQuotaResetAutoPlayState,
  ) => void;
  sourceKey: string;
  resetType: CodingPlanResetType;
  completedAt: number;
}): Promise<CodingPlanQuotaResetAutoPlayReservationAttempt> {
  const { broadcastService, readState, writeState, sourceKey, resetType, completedAt } = params;
  const payload = { sourceKey, resetType, completedAt };
  const key = resetType === "WEEK" ? "week" : "fiveHour";
  // reserve 第一段是纯本地预检：先读快照判定，不产生任何 Main 往返
  // 已播游标领先时顺带应用一次广播补丁再返回 blocked，把迟到的抑制落到本地状态
  // 预检失败直接返回 blocked，不申请 lease，也不给上层留下需要清理的资源
  const initialState = readState();
  const initialPlayed =
    initialState.codingPlanQuotaResetAutoPlayedBySource[sourceKey]?.[key] ?? null;
  if (initialPlayed !== null && initialPlayed >= completedAt) {
    writeState((state) => applyCodingPlanQuotaResetAutoPlayedBroadcast(state, payload));
    return { status: "blocked" };
  }
  if (!isCodingPlanQuotaResetAutoPlayCandidate(initialState, sourceKey, resetType, completedAt)) {
    return { status: "blocked" };
  }

  // 第二段才接触 Main：抛错、busy、unavailable 统一映射为 retry 并附退避毫秒
  // busy 的等待时间取 Main 建议值与下限的较大者，避免高频重试打满 claim 通道
  // 阻塞与不可用都不得写 played：失败只影响本次播放时机，不影响后续轮询
  let claimResult;
  try {
    claimResult = await broadcastService.acquireClaim(
      buildCodingPlanQuotaResetAutoPlayClaimKey(sourceKey, resetType, completedAt),
    );
  } catch {
    return { status: "retry", retryAfterMs: 500 };
  }
  if (claimResult.status === "busy") {
    return { status: "retry", retryAfterMs: Math.max(50, claimResult.retryAfterMs) };
  }
  if (claimResult.status === "unavailable") {
    return { status: "retry", retryAfterMs: 500 };
  }
  if (claimResult.status === "committed") {
    // committed 只说明 Main 已有永久 claim；loser 仍等待真实 played 广播/本地游标，
    // 不能在这里清 observedAt，否则会再次把“已占用”误当成“已播放”。
    return { status: "blocked" };
  }

  // 等待 Main 期间窗口可能卸载或切换 source，第三段必须基于最新快照重新判定
  // 候选失效时先释放 lease 再返回，任何提前退出路径都不允许把占用留在 Main
  // 失效但本地游标已领先的，补一次广播应用把迟到抑制落地，防止下一轮再抢
  const latestState = readState();
  if (!isCodingPlanQuotaResetAutoPlayCandidate(latestState, sourceKey, resetType, completedAt)) {
    await broadcastService.releaseClaim(claimResult.lease);
    const latestPlayed =
      latestState.codingPlanQuotaResetAutoPlayedBySource[sourceKey]?.[key] ?? null;
    if (latestPlayed !== null && latestPlayed >= completedAt) {
      writeState((state) => applyCodingPlanQuotaResetAutoPlayedBroadcast(state, payload));
    }
    return { status: "blocked" };
  }

  return {
    status: "reserved",
    reservation: { sourceKey, resetType, completedAt, lease: claimResult.lease },
  };
}

/**
 * 组件确认仍 mounted、source/candidate 匹配并即将展示时提交 reservation。
 * 本函数同步写本地 played，再发送 Main commit 与 played 广播；同一 JS task 内不会穿插卸载。
 */
export function commitCodingPlanQuotaResetAutoPlay(params: {
  broadcastService: Pick<IBroadcastService, "commitClaim" | "send">;
  writeState: (
    updater: (state: CodingPlanQuotaResetAutoPlayState) => CodingPlanQuotaResetAutoPlayState,
  ) => void;
  reservation: CodingPlanQuotaResetAutoPlayReservation;
}): boolean {
  const { broadcastService, writeState, reservation } = params;
  const { sourceKey, resetType, completedAt } = reservation;
  // committed 标志由 updater 内部回填，用来区分真的写入与候选失效时的原样返回
  // 判定与写入必须在同一个 updater 内完成，中间不允许插入其他写路径
  // 未提交时调用方负责释放 lease，commit 本身不越权回收他人的占用
  let committed = false;
  writeState((state) => {
    if (!isCodingPlanQuotaResetAutoPlayCandidate(state, sourceKey, resetType, completedAt)) {
      return state;
    }
    committed = true;
    const slots = state.codingPlanQuotaResetAutoPlayedBySource[sourceKey] ?? {
      fiveHour: null,
      week: null,
    };
    return {
      codingPlanQuotaResetUiBySource: state.codingPlanQuotaResetUiBySource,
      codingPlanQuotaResetAutoPlayedBySource: {
        ...state.codingPlanQuotaResetAutoPlayedBySource,
        [sourceKey]:
          resetType === "WEEK"
            ? { ...slots, week: completedAt }
            : { ...slots, fiveHour: completedAt },
      },
    };
  });
  if (!committed) {
    return false;
  }

  void broadcastService.commitClaim(reservation.lease);
  broadcastCodingPlanQuotaResetAutoPlayed(broadcastService, sourceKey, resetType, completedAt);
  return true;
}

// 卸载、切换 source、播放取消都走这一条释放路径，lease 生命周期只有这一个终点
// 释放要等待回执再返回，调用方据此确认资源归还，而不是靠超时兜底
// 释放失败向上抛出，由调用方决定重试策略，这里不静默降级也不伪造成功
export async function releaseCodingPlanQuotaResetAutoPlay(params: {
  broadcastService: Pick<IBroadcastService, "releaseClaim">;
  reservation: CodingPlanQuotaResetAutoPlayReservation;
}): Promise<void> {
  await params.broadcastService.releaseClaim(params.reservation.lease);
}

export interface CodingPlanQuotaResetStoreActions {
  setCodingPlanQuotaResetUiEntry: (
    sourceKey: string,
    resetType: CodingPlanResetType,
    entry: CodingPlanQuotaResetUiEntry | null,
    authSessionSeq: number,
  ) => void;
  reserveCodingPlanQuotaResetAutoPlay: (
    sourceKey: string,
    resetType: CodingPlanResetType,
    completedAt: number,
  ) => Promise<CodingPlanQuotaResetAutoPlayReservationAttempt>;
  commitCodingPlanQuotaResetAutoPlay: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => boolean;
  releaseCodingPlanQuotaResetAutoPlay: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => Promise<void>;
}

type CodingPlanQuotaResetStoreWriter = (
  updater: (state: CodingPlanQuotaResetStoreState) => Partial<CodingPlanQuotaResetStoreState>,
) => void;

/** 把重置状态 action 集中在本领域文件，避免全局 Store 再次膨胀。 */
export function createCodingPlanQuotaResetStoreActions(params: {
  broadcastService: Pick<
    IBroadcastService,
    "acquireClaim" | "commitClaim" | "releaseClaim" | "send"
  >;
  readState: () => CodingPlanQuotaResetStoreState;
  writeState: CodingPlanQuotaResetStoreWriter;
}): CodingPlanQuotaResetStoreActions {
  const { broadcastService, readState, writeState } = params;
  return {
    setCodingPlanQuotaResetUiEntry: (sourceKey, resetType, entry, authSessionSeq) =>
      writeState(
        (state) =>
          updateCodingPlanQuotaResetStoreState(state, sourceKey, resetType, entry, authSessionSeq)
            .patch,
      ),
    reserveCodingPlanQuotaResetAutoPlay: (sourceKey, resetType, completedAt) =>
      reserveCodingPlanQuotaResetAutoPlay({
        broadcastService,
        readState,
        writeState: (updater) => writeState((state) => updater(state)),
        sourceKey,
        resetType,
        completedAt,
      }),
    commitCodingPlanQuotaResetAutoPlay: (reservation) =>
      commitCodingPlanQuotaResetAutoPlay({
        broadcastService,
        writeState: (updater) => writeState((state) => updater(state)),
        reservation,
      }),
    releaseCodingPlanQuotaResetAutoPlay: (reservation) =>
      releaseCodingPlanQuotaResetAutoPlay({ broadcastService, reservation }),
  };
}
