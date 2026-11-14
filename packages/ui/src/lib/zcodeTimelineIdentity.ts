// INV-01 身份键按时间线类型分组：守住位置 类型分支；改错故障 跨类型键误判为同一段。
// INV-02 缺字段不生成键：守住位置 键拼装函数；改错故障 出现只有前缀的空键。
// INV-03 上下文压缩有四个维度：守住位置 四条追加；改错故障 同一压缩被拆成多段。
// INV-04 迭代键含目标与序号：守住位置 模板拼接；改错故障 不同目标的迭代互相吞并。
// INV-05 分叉先记父会话：守住位置 公共追加；改错故障 分叉段缺少共同祖先。
// INV-06 目标键含检查点：守住位置 三元兜底；改错故障 不同检查点被当成同一条消息。
// INV-07 交集判断保持纯函数：守住位置 包含检查；改错故障 调用方被迫构建索引。
// INV-08 空集合不匹配任何键：守住位置 短路语义；改错故障 空数组被当成匹配全部。
// INV-09 合并只在同类型间发生：守住位置 双条件；改错故障 分叉元数据被压缩段覆盖。
// INV-10 新值优先旧值兜底：守住位置 空值合并；改错故障 续写时丢失新命令。
// INV-11 合并不引入空字段：守住位置 条件展开；改错故障 出现未定义字段。
// INV-12 输入标识同样可续写：守住位置 单独合并；改错故障 二次压缩丢失输入编号。
// INV-13 验证结果可续写：守住位置 字段合并；改错故障 重试后结果仍是旧值。
// INV-14 开始时间可续写：守住位置 字段合并；改错故障 重试后时长失真。
// INV-15 类型不同直接替换：守住位置 末尾返回；改错故障 混合两段元数据。
// INV-16 合并结果保持原类型：守住位置 分支返回；改错故障 返回类型被拓宽。
// INV-17 键生成不读外部状态：守住位置 纯函数；改错故障 同输入产生不同键。
// INV-18 键顺序稳定：守住位置 固定追加顺序；改错故障 重叠判断受顺序影响。
//
// 模块职责：为合成时间线段落生成身份键，并在相邻元数据之间做字段级合并。
// 状态所有权：纯函数集合，无模块状态，也不读取时间或随机源。
// 阅读顺序：先看键生成，再看重叠判断，最后看同类型合并。
import type { ZCodeTimelineMeta } from "@zcode/shared";

function addTimelineIdentityKey(
  keys: string[],
  prefix: string,
  value: string | undefined,
): void {
  if (value) {
    keys.push(`${prefix}:${value}`);
  }
}

// context_compaction 分支最多拼出 4 个身份键。
// operation 键直接取 timeline.operationId。
// 会话分叉先记 parentSessionId。
// 目标键再拼 targetMessageId 与 targetCheckpointId。
// 值为空的键由 addTimelineIdentityKey() 跳过。
export function getZCodeTimelineIdentityKeys(
  timeline: ZCodeTimelineMeta,
): string[] {
  const keys: string[] = [];
  if (timeline.type === "context_compaction") {
    addTimelineIdentityKey(
      keys,
      "synthetic:context_compaction:operation",
      timeline.operationId,
    );
    addTimelineIdentityKey(
      keys,
      "synthetic:context_compaction:input",
      timeline.inputId,
    );
    addTimelineIdentityKey(
      keys,
      "synthetic:context_compaction:boundary",
      timeline.boundaryId,
    );
    addTimelineIdentityKey(
      keys,
      "synthetic:context_compaction:summary",
      timeline.summaryMessageId,
    );
    return keys;
  }
  if (timeline.type === "goal_verification") {
    if (typeof timeline.goalIteration === "number") {
      keys.push(
        `synthetic:goal_verification:iteration:${timeline.targetId}:${timeline.goalIteration}`,
      );
    }
    addTimelineIdentityKey(
      keys,
      "synthetic:goal_verification:verification",
      timeline.verificationId,
    );
    return keys;
  }
  addTimelineIdentityKey(
    keys,
    "synthetic:session_fork:parent",
    timeline.parentSessionId,
  );
  if (timeline.targetMessageId) {
    keys.push(
      [
        "synthetic:session_fork:target",
        timeline.parentSessionId,
        timeline.targetMessageId,
        timeline.targetCheckpointId ?? "",
      ].join(":"),
    );
  }
  return keys;
}

// 交集为空时 some() 返回 false。
// 只做 left.some 与 right.includes 的线性判断。
// 键集合都很小，不额外建 Set 索引。
// hasSharedZCodeTimelineIdentity() 只回答重叠，合并策略由调用方决定。
export function hasSharedZCodeTimelineIdentity(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.some((key) => right.includes(key));
}

// 只有 type 同为 context_compaction 才做字段合并。
// 展开顺序让 nextTimeline 覆盖 previousTimeline。
// 合并结果仍落在 ZCodeTimelineMeta 既有字段内。
// 类型不同时直接返回 nextTimeline。
export function mergeZCodeTimelineMeta(
  previousTimeline: ZCodeTimelineMeta | undefined,
  nextTimeline: ZCodeTimelineMeta,
): ZCodeTimelineMeta {
  if (
    previousTimeline?.type === "context_compaction" &&
    nextTimeline.type === "context_compaction"
  ) {
    return {
      ...previousTimeline,
      ...nextTimeline,
      ...((nextTimeline.command ?? previousTimeline.command)
        ? { command: nextTimeline.command ?? previousTimeline.command }
        : {}),
      ...((nextTimeline.inputId ?? previousTimeline.inputId)
        ? { inputId: nextTimeline.inputId ?? previousTimeline.inputId }
        : {}),
    };
  }
  if (
    previousTimeline?.type === "goal_verification" &&
    nextTimeline.type === "goal_verification"
  ) {
    return {
      ...previousTimeline,
      ...nextTimeline,
      ...((nextTimeline.verification ?? previousTimeline.verification)
        ? {
            verification:
              nextTimeline.verification ?? previousTimeline.verification,
          }
        : {}),
      ...((nextTimeline.startedAt ?? previousTimeline.startedAt)
        ? { startedAt: nextTimeline.startedAt ?? previousTimeline.startedAt }
        : {}),
    };
  }
  return nextTimeline;
}
