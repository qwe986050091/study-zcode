// bots/groupQueueCard.ts — 群输入排队卡片的状态投影与串行更新。
//
// INV-01 状态单向演进：waiting(0) → working(1) → 终态(2)。迟到的 admission
//        不能把已进入终态的卡片改回 working，否则用户会看到“完成又复活”。
// INV-02 同一 key 的 read→render→mutate 必须串行；并发执行会让后写的
//        cardStatus 覆盖先渲染的结果，出现卡片与真实进度不一致。
// INV-03 cardStatus 只在 render 成功后落库；render 失败时保持旧值，下一轮
//        变更会自然重试，不引入额外的重试计数。
// [权衡] operation 链上的错误被吞掉（catch 后继续），避免一次渲染失败卡死
//        后续所有更新；失败事实由 render 实现自行记录。
import type { BotGroupInputProgress, BotGroupInputStatus } from "@zcode/shared";

const rank = (state: BotGroupInputStatus) =>
  state === "waiting" ? 0 : state === "working" ? 1 : 2;

export function createGroupQueueCardSync(deps: {
  read(key: string): Promise<BotGroupInputProgress | undefined>;
  mutate(
    key: string,
    update: (current: BotGroupInputProgress) => BotGroupInputProgress,
  ): Promise<BotGroupInputProgress | undefined>;
  render(key: string, messageId: string, status: BotGroupInputStatus): Promise<void>;
}) {
  // 每个 key 一条串行链；链尾结束即删除，避免长期占位。
  const operations = new Map<string, Promise<void>>();
  const change = (
    key: string,
    mutate: (current: BotGroupInputProgress) => BotGroupInputProgress,
  ) => {
    const operation = (operations.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await deps.mutate(key, mutate);
        // 变更后重新读取，用最新状态决定是否需要渲染，而不是依赖入参。
        const current = await deps.read(key);
        // 无卡片、或渲染值未变化时跳过，避免重复 PATCH 平台消息。
        if (!current?.cardMessageId || current.cardStatus === current.status) return;
        await deps.render(key, current.cardMessageId, current.status);
        // 记录最后一次已渲染状态；即使期间状态再次演进，下一轮也会补渲染。
        await deps.mutate(key, (latest) => ({ ...latest, cardStatus: current.status }));
      });
    // 先入链再挂清理回调，保证 finally 判断的是本链是否仍为链尾。
    operations.set(key, operation);
    void operation
      .finally(() => {
        // 只清理自己：被后续操作接链时不能删除新链。
        if (operations.get(key) === operation) operations.delete(key);
      })
      .catch(() => {});
    return operation;
  };
  return {
    // update 只接受前进，rank 相同或倒退一律保持原状态。
    update: (key: string, status: BotGroupInputStatus) =>
      change(key, (current) => ({
        ...current,
        // 原实现只改表情；卡片也必须记录单向生命周期，迟到的 admission 不能覆盖终态。
        status: rank(status) > rank(current.status) ? status : current.status,
      })),
    // attach 建立卡片并重置为 waiting；这是唯一允许“回到起点”的入口。
    attach: (key: string, cardMessageId: string) =>
      change(key, (current) => ({
        ...current,
        cardMessageId,
        cardStatus: "waiting",
      })),
  };
}
