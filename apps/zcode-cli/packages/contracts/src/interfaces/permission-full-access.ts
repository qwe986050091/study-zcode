import { z } from "zod";

// 完全访问 receipt 的 session entry 类型名。runtime/ 前缀表示运行时自管条目，不是用户消息。
// 生产：core/runtime/permission-full-access.ts 的 commitPermissionFullAccess 与模式事件同事务写入；
// 消费：冷恢复 restorePermissionGrantMarker 读该类型的最后一条重建 lastPermissionGrantId。
// 隔离：entries 查询按 sessionID 过滤，跨 session 不可见，也不能被普通消息流当成对话内容。
export const PERMISSION_FULL_ACCESS_ENTRY = "runtime/permission_full_access";

// receipt 的运行时校验 schema（strict：任何多余或缺失字段都判无效）。
// 它固定一次授权的完整事实：interactionId、目标队列 queueItemIds、模式变化前后值、来源 command。
// 不变量：receipt.interactionId 必须等于 event.payload.permissionGrant.interactionId，否则授权身份错位；
// 队列权限必须来自写入那一刻的投影——重试或恢复时不能重新抓取后来新增的队列项。
// 损坏或 scope 不匹配时消费方只 warn 并忽略（不抛错），但绝不允许按当前队列重新扩大授权范围。
// 该 receipt 与 execution state entry 必须同一事务提交，否则会出现"模式已变但队列未授权"的半个授权。
/** 持久化 receipt 是授权重试事实源；损坏时拒绝重试，不能按当前队列重新扩大授权范围。 */
export const permissionFullAccessReceiptSchema = z
  .object({
    interactionId: z.string().min(1),
    event: z
      .object({
        id: z.string().min(1),
        sessionId: z.string().min(1),
        traceId: z.string().min(1),
        turnId: z.string().optional(),
        type: z.literal("session_mode_changed"),
        timestamp: z.coerce.date(),
        sequenceNumber: z.number().int().nonnegative(),
        payload: z
          .object({
            mode: z.literal("yolo"),
            planEnabled: z.boolean(),
            previousMode: z.enum(["build", "edit", "yolo", "guarded", "auto", "plan"]),
            previousPlanEnabled: z.boolean(),
            source: z.literal("command"),
            permissionGrant: z
              .object({
                interactionId: z.string().min(1),
                queueItemIds: z.array(z.string().min(1)),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (receipt) => receipt.interactionId === receipt.event.payload.permissionGrant.interactionId,
    {
      message: "Permission grant identity mismatch",
    },
  );
