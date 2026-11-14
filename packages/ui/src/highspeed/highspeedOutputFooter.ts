// INV-01 标记只打组尾：守住位置 lastUnitIndex === index；改错故障 一张卡出现多个 footer。
// INV-02 footer 属于整张卡：守住位置 状态按 cardId 聚合；改错故障 多轮卡片每轮各显示一次。
// INV-03 过期是必要条件：守住位置 expiresAt <= nowMs；改错故障 倒计时未结束就显示来源。
// INV-04 组尾无正文也认前序输出：守住位置 hasOutput 或链；改错故障 中断的最后一轮吞掉 footer。
// INV-05 timelineMarker 不算输出：守住位置 kind 过滤；改错故障 空卡片仅凭标记就展示指标。
// INV-06 TPS 必须齐全且为正：守住位置 metas.some；改错故障 零除得到 Infinity 或 NaN。
// INV-07 零令牌不聚合：守住位置 outputTokens <= 0；改错故障 分享参数出现 0 tok/s。
// INV-08 普通耗时按令牌除 TPS 累加：守住位置 regularDurationSeconds；改错故障 加权方式与单轮不一致。
// INV-09 savedDuration 优先取持久值：守住位置 ?? 右侧重算；改错故障 冷恢复与在线口径不同。
// INV-10 model/tool 耗时需全齐：守住位置 metas.every；改错故障 部分轮次缺失时给出偏小的总和。
// INV-11 other 工时是差值：守住位置 Math.max(0, ...)；改错故障 四段之和超过总耗时。
// INV-12 卡级 TPS 取首条：守住位置 metas[0]；改错故障 各轮持久值不同时出现漂移。
// INV-13 无指标仍打标：守住位置 metrics 三元；改错故障 footer 整块消失，文案跳动。
// INV-14 冷恢复与在线同一聚合：守住位置 单一实现；改错故障 两条路径各写一份公式。
//
// 模块职责：为 Highspeed 卡片标记组尾 footer，并按持久化元数据聚合分享指标。
// 阅读顺序：先看标记入口，再看按卡收口，最后看指标聚合的校验与加权。
import type { HighspeedMessageMeta } from "@zcode/shared";
import { calculateHighspeedSavedDurationMs } from "@/highspeed/highspeedSavedTime.js";
import type { HighspeedShareMetrics } from "@/highspeed/highspeedTurnStore.js";

export interface HighspeedOutputFooterTarget {
  cardId: string;
  metrics: HighspeedShareMetrics;
}

/** 由 footer 收口逻辑写回渲染单元的标记字段，宿主类型只需声明这两个可选字段。 */
export interface HighspeedOutputFooterMark {
  /** 同一 Highspeed cardId 对应的当前最后一个 turn；仅该组尾可展示来源 footer。 */
  showHighspeedOutputFooter?: true;
  /** 冷恢复时由同卡全部持久化 turn metadata 聚合出的可信分享参数。 */
  highspeedOutputFooterTarget?: HighspeedOutputFooterTarget;
}

interface HighspeedFooterUnit {
  visibleUserInputs: readonly { highspeed?: HighspeedMessageMeta }[];
  assistantWorkRows: readonly { kind: string }[];
}

interface HighspeedCardFooterState {
  lastUnitIndex: number;
  hasOutput: boolean;
  metas: HighspeedMessageMeta[];
}

/**
 * 给同一张卡覆盖的最后一个渲染单元打上 footer 标记。
 *
 * Bug 根因：footer 过去在单个 turn 内按 accelerated 判定，一张卡覆盖多轮时会重复显示。
 * 必须在虚拟化前按持久化 cardId 和过期时间统一收口，组尾才能随新 turn 与倒计时稳定后移。
 */
// 标记只加在组尾单元上，不复制数据。
export function markHighspeedOutputFooterUnits<T extends HighspeedFooterUnit>(
  units: readonly T[],
  nowMs: number,
): (T & HighspeedOutputFooterMark)[] {
  const footerByUnitIndex = resolveHighspeedOutputFooters(units, nowMs);
  return units.map((unit, index) => {
    // 未命中的单元保持原引用。
    if (!footerByUnitIndex.has(index)) return unit;
    const target = footerByUnitIndex.get(index);
    return {
      ...unit,
      // 打标与 target 一起写入。
      showHighspeedOutputFooter: true as const,
      ...(target ? { highspeedOutputFooterTarget: target } : {}),
    };
  });
}

function resolveHighspeedOutputFooters(
  units: readonly HighspeedFooterUnit[],
  nowMs: number,
): Map<number, HighspeedOutputFooterTarget | null> {
  const cardsByUnit = units.map((unit) =>
    // 只收集带 highspeed 元数据的用户输入。
    unit.visibleUserInputs.flatMap((row) => (row.highspeed ? [row.highspeed] : [])),
  );
  const cardStateById = new Map<string, HighspeedCardFooterState>();

  cardsByUnit.forEach((cards, index) => {
    for (const card of cards) {
      const current = cardStateById.get(card.cardId);
      cardStateById.set(card.cardId, {
        // cardStateById.set 后写覆盖前写，lastUnitIndex 最终停在组尾。
        lastUnitIndex: index,
        // Bug 原因：组尾异常/中断可能自身没有正文，但前序 accelerated turn 已有输出。
        // footer 属于整张卡，不能只看最后一轮；timeline 边界不是模型 output，不计入。
        hasOutput:
          (current?.hasOutput ?? false) ||
          // 前序 turn 有输出也算整卡有输出。
          (card.outputTokens ?? 0) > 0 ||
          // 时间线标记不是模型输出。
          units[index]!.assistantWorkRows.some((row) => row.kind !== "timelineMarker"),
        metas: [...(current?.metas ?? []), card],
      });
    }
  });

  const footerByUnitIndex = new Map<number, HighspeedOutputFooterTarget | null>();
  cardsByUnit.forEach((cards, index) => {
    const footerCard = cards.find((card) => {
      const state = cardStateById.get(card.cardId);
      // expiresAt 已过、lastUnitIndex 为组尾、hasOutput 为真三条同时成立才判完成，缺一条必须跳过。
      return card.expiresAt <= nowMs && state?.lastUnitIndex === index && state.hasOutput;
    });
    if (!footerCard) return;
    const metrics = aggregatePersistedHighspeedMetrics(
      cardStateById.get(footerCard.cardId)?.metas ?? [],
    );
    // 无指标也打标，只是不带 target。
    footerByUnitIndex.set(index, metrics ? { cardId: footerCard.cardId, metrics } : null);
  });
  return footerByUnitIndex;
}

function aggregatePersistedHighspeedMetrics(
  metas: readonly HighspeedMessageMeta[],
): HighspeedShareMetrics | null {
  if (
    metas.length === 0 ||
    metas.some(
      (meta) =>
        meta.outputTokens === undefined ||
        meta.regularTps === undefined ||
        meta.regularTps <= 0 ||
        meta.highspeedTps === undefined ||
        // 每个 turn 的 TPS 必须齐全且为正。
        meta.highspeedTps <= 0,
    )
  ) {
    return null;
  }
  // 令牌总数按 turn 累加。
  const outputTokens = metas.reduce((total, meta) => total + (meta.outputTokens ?? 0), 0);
  // outputTokens ≤ 0 时直接返回 null，零输出没有可分享的指标。
  if (outputTokens <= 0) return null;
  const regularDurationSeconds = metas.reduce(
    (total, meta) => total + (meta.outputTokens ?? 0) / (meta.regularTps ?? 1),
    0,
  );
  const savedDurationMs = metas.reduce(
    (total, meta) =>
      total +
      (meta.savedDurationMs ??
        calculateHighspeedSavedDurationMs({
          outputTokens: meta.outputTokens ?? 0,
          regularTps: meta.regularTps ?? 0,
          highspeedTps: meta.highspeedTps ?? 0,
          durationMs: meta.durationMs ?? 0,
          modelDurationMs: meta.modelDurationMs,
          toolDurationMs: meta.toolDurationMs,
          otherDurationMs: meta.otherDurationMs,
        })),
    0,
  );
  return {
    outputTokens,
    durationMs: metas.reduce((total, meta) => total + (meta.durationMs ?? 0), 0),
    ...(metas.every(
      (meta) => meta.modelDurationMs !== undefined && meta.toolDurationMs !== undefined,
    )
      ? {
          modelDurationMs: metas.reduce((total, meta) => total + (meta.modelDurationMs ?? 0), 0),
          toolDurationMs: metas.reduce((total, meta) => total + (meta.toolDurationMs ?? 0), 0),
          otherDurationMs: metas.reduce(
            (total, meta) =>
              total +
              (meta.otherDurationMs ??
                Math.max(
                  0,
                  (meta.durationMs ?? 0) - (meta.modelDurationMs ?? 0) - (meta.toolDurationMs ?? 0),
                )),
            0,
          ),
        }
      : {}),
    savedDurationMs,
    regularTps: outputTokens / regularDurationSeconds,
    // healthy 返回卡级累计 TPS，同卡各 turn 持久化的是同一个权威值。
    // 卡级 TPS 取首条权威值。
    highspeedTps: metas[0]!.highspeedTps!,
  };
}
