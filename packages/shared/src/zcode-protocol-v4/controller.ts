// INV 不变量表（18 条；破坏任一条都是静默协议故障，不抛错只错数据）：
// INV-01 topic 字面量集合只含 controller/workspaces 与 controller/tasks-index；守住位置：windowHostControllerTopicSchema 与两个常量；改错故障：新增 topic 只在枚举一侧登记会让该通道订阅被拒，侧栏对应区块恒为空且无报错
// INV-02 快照帧的 fromSeq 必须为 0；守住位置：createControllerFrameSchema 的 snapshot 分支；改错故障：放宽后快照被当作接续增量，接收方在旧投影上叠加全量，列表项重复
// INV-03 任一帧的 toSeq 不得小于 fromSeq，且两者都是非负整数；守住位置：createControllerFrameSchema 的 superRefine 首条校验；改错故障：游标可倒退，已消费增量被再次应用，任务计数虚高
// INV-04 帧外层 logEpoch 必须与 payload 内快照的 logEpoch 相等；守住位置：createControllerFrameSchema 的 snapshot 分支比对；改错故障：epoch 混用把重启前的旧日志与新序号拼接，数据错位且无法自愈
// INV-05 判定帧连续性时 subscriptionId、logEpoch、seq 必须同时相等；守住位置：isWindowHostControllerFrameGap；改错故障：漏判 gap 会把断点后的增量直接接上，出现永不消失的幽灵行
// INV-06 两个快照 schema 的 protocolVersion 固定为字面量 1；守住位置：workspaces 与 tasks 的快照定义；改错故障：改成 number 后旧端把新版结构当同版解析，字段语义变化被静默接受
// INV-07 任务行的 address 与 meta 必须在 taskId、workspacePath、workspaceIdentity 三项上相等；守住位置：windowHostControllerTaskRowSchema 的 superRefine；改错故障：地址与展示字段指向不同任务，用户点开错误工作区的同名任务
// INV-08 给出 remoteSessionId 时必须同时给出 workspaceIdentity，地址与工作区事实都适用；守住位置：windowHostTaskAddressSchema 与 workspaceFactSchema 的 superRefine；改错故障：远程条目失去去重依据，重连后列表翻倍且删除只影响其中一份
// INV-09 sourceAvailability 为 offline 时 connectionState 只能是 disconnected 或 failed；守住位置：workspaceFactSchema 的 superRefine 第二条；改错故障：出现自相矛盾的事实，UI 标离线却继续发起请求并反复失败
// INV-10 所有对象 schema 均为 strict，拒绝未声明字段；守住位置：各 z.object 链尾的 strict 与两个 discriminatedUnion；改错故障：放行未知字段后跨版本新增字段被旧端采信，回写时丢字段且无告警
// INV-11 工作区与任务增量的 op 是封闭字面量集合，未知 op 直接解析失败而非跳过；守住位置：windowHostControllerWorkspaceDeltaSchema 与 TaskDeltaSchema；改错故障：安静跳过未知 op 会让投影与 Host 状态永久分叉
// INV-12 一帧 payload 只能是 snapshot 或 deltas，二者不可同时出现；守住位置：createControllerFrameSchema 的 kind 判别联合；改错故障：混装时接收方无法判断该替换还是追加，重复应用导致数据翻倍
// INV-13 订阅 base 可缺席表示全新订阅，重同步 base 可为 null 表示强制快照，两种语义不可合并；守住位置：controllerSubscribeParamsSchema 与 controllerResyncParamsSchema；改错故障：客户端无法表达丢弃本地状态，重启后越接越乱
// INV-14 visibility 只接受 foreground 与 background，是放行提示而非语义开关；守住位置：controllerSubscribeParamsSchema 的 visibility 字段；改错故障：按可见性丢弃增量后，切回前台立刻触发 gap 并重订
// INV-15 四类 membership 视图的判定只由 matchesTaskListMembershipKind 给出，pinned 视图排除已归档项；守住位置：该函数的 switch 分支；改错故障：各端自行实现导致计数与列表不一致，置顶栏混入归档任务
// INV-16 activity 整体可选，但出现时 lastActivityAt 必须有限非负，workflowActivity 缺席表示没有运行中的 run；守住位置：windowHostControllerTaskActivitySchema；改错故障：允许 NaN 会让时间线排序比较恒为假，任务位置随机抖动
// INV-17 subscriptionId 经 trim 后必须非空，是订阅、重同步、退订三类消息的唯一配对键；守住位置：帧、resync、unsubscribe 三个 schema 的该字段；改错故障：空串被接受后多个订阅共用一键，退订误杀他人通道
// INV-18 订阅与重同步的结果统一包在 ack 对象里，业务数据只走帧；守住位置：controllerSubscribeResultSchema 与 controllerResyncResultSchema；改错故障：数据塞进回执使两条路径载荷语义分叉，seq 连续性失去唯一依据
import { z } from "zod";
import { zcodeTaskMetaSchema } from "../validation.js";
import { pendingInteractionSummarySchema } from "./sessions-index.js";
import { sessionWorkflowActivitySchema } from "./sessions-index-workflow-activity.js";
import { sessionPhaseSchema } from "./snapshot.js";
import { subscribeAckSchema } from "./transport.js";

// [权衡] topic 用字符串字面量而不是枚举或数字编号：同一字符串会同时出现在 Host 的
// 发送日志与 Renderer 的订阅请求里，排障时必须能肉眼对上；换成数字后跨版本不一致
// 就只剩一个无法解释的序号。
// 两个 topic 各是一条独立的单向流，Host 主动推帧、Renderer 不回执，所以某条流
// 中断不会被对端感知，只能由帧内 seq 的连续性暴露。
// 常量改名等于单方面修改对外契约：旧 Renderer 的订阅会被 topic 枚举拒绝，
// 侧栏工作区与任务列表同时空表，且没有任何可读错误提示。
// 新增 topic 必须同时登记进下面的枚举，否则该通道的帧在解析期就被丢掉。
export const CONTROLLER_WORKSPACES_TOPIC = "controller/workspaces" as const;
export const CONTROLLER_TASKS_INDEX_TOPIC = "controller/tasks-index" as const;

export const windowHostControllerTopicSchema = z.enum([
  CONTROLLER_WORKSPACES_TOPIC,
  CONTROLLER_TASKS_INDEX_TOPIC,
]);
export type WindowHostControllerTopic = z.infer<typeof windowHostControllerTopicSchema>;

// 地址是任务在 Renderer 侧的去重键与选中键，不是展示字段。
// 同一条日志被重放时 Host 会再次下发同一地址的行，客户端只能据此原地更新，
// 若退化成追加就会看到重复任务。
// sourceServerId 与 remoteSessionId 缺席表示本机工作区，存在则表示远端来源。
// 四元组 sourceServerId、remoteSessionId、workspacePath、taskId 才是全局唯一键，
// 只用 taskId 去重会让不同工作区里的同名任务互相覆盖。
// [失败路径] 结构性缺失在这里解析失败，不留给下游兜底：各投影对缺省值的处理
// 并不一致，放行后同一任务在不同视图里会指向不同对象。
export const windowHostTaskAddressSchema = z
  .object({
    sourceServerId: z.string().trim().min(1).optional(),
    remoteSessionId: z.string().trim().min(1).optional(),
    workspacePath: z.string().trim().min(1),
    workspaceIdentity: z.string().trim().min(1).optional(),
    taskId: z.string().trim().min(1),
  })
  .strict()
  .superRefine((address, context) => {
    if (address.remoteSessionId && !address.workspaceIdentity) {
      context.addIssue({
        code: "custom",
        message: "remote task address requires workspaceIdentity",
        path: ["workspaceIdentity"],
      });
    }
  });
export type WindowHostTaskAddress = z.infer<typeof windowHostTaskAddressSchema>;

// 工作区事实里 sourceAvailability 与 connectionState 是两套独立状态：
// 前者描述来源是否可达，后者描述连接处于哪个阶段，reconnecting 属于在线来源。
// [失败路径] 交叉校验把 offline 却仍在 connecting 的组合挡在解析期：这种组合只
// 可能来自 Host 状态机写错，放行后 UI 会一边标离线一边持续发起请求并反复失败。
// 远程工作区必须带 workspaceIdentity，否则重连后无法与旧条目对齐，
// 列表里会出现两份同一路径，删掉其中一份并不影响另一份。
// 事实是快照的全量单元，不携带 seq：序列信息只存在于外层帧。
// connectionState 的六种取值是对外枚举，增删都要求两端同版本发布。
export const windowHostControllerWorkspaceFactSchema = z
  .object({
    sourceServerId: z.string().trim().min(1).optional(),
    serverDisplayName: z.string().trim().min(1).optional(),
    remoteSessionId: z.string().trim().min(1).optional(),
    workspacePath: z.string().trim().min(1),
    workspaceIdentity: z.string().trim().min(1).optional(),
    sourceAvailability: z.enum(["online", "offline"]),
    connectionState: z.enum([
      "connecting",
      "online",
      "closing",
      "failed",
      "disconnected",
      "reconnecting",
    ]),
  })
  .strict()
  .superRefine((workspace, context) => {
    if (workspace.remoteSessionId && !workspace.workspaceIdentity) {
      context.addIssue({
        code: "custom",
        message: "remote workspace fact requires workspaceIdentity",
        path: ["workspaceIdentity"],
      });
    }
    if (
      workspace.sourceAvailability === "offline" &&
      workspace.connectionState !== "disconnected" &&
      workspace.connectionState !== "failed"
    ) {
      context.addIssue({
        code: "custom",
        message: "offline source must be disconnected or failed",
        path: ["connectionState"],
      });
    }
  });
export type WindowHostControllerWorkspaceFact = z.infer<
  typeof windowHostControllerWorkspaceFactSchema
>;

export const windowHostControllerTaskActivitySchema = z
  .object({
    phase: sessionPhaseSchema,
    lastActivityAt: z.number().finite().nonnegative(),
    hasBackgroundWork: z.boolean(),
    pendingInteractions: pendingInteractionSummarySchema.optional(),
    // 侧栏工作流运行行；无 run 时缺席。
    workflowActivity: sessionWorkflowActivitySchema.optional(),
  })
  .strict();
export type WindowHostControllerTaskActivity = z.infer<
  typeof windowHostControllerTaskActivitySchema
>;

// 一行任务同时带 address 与 meta 两份身份信息，因为它们来源不同：
// address 用于在日志里定位任务，meta 用于展示标题、时间与工作区归属。
// [并发] 两份数据由 Host 在不同阶段填充，必须在此强制相等，否则会出现
// 地址指向 A 而标题显示 B 的行，用户点击后打开的是另一个任务。
// membership 用三个并列布尔而不是单一枚举，因为归档与置顶可以同时为真，
// 而 active 只表示未归档；塌缩成枚举会丢掉已归档且置顶这种真实状态。
// activity 与 searchSnippets 可选：前者只在任务有运行态时下发，后者只在搜索
// 场景填充，缺席表示该维度不适用，而不是取值为空。
export const windowHostControllerTaskRowSchema = z
  .object({
    address: windowHostTaskAddressSchema,
    meta: zcodeTaskMetaSchema,
    membership: z
      .object({
        pinned: z.boolean(),
        archived: z.boolean(),
        active: z.boolean(),
      })
      .strict(),
    sourceAvailability: z.enum(["online", "offline"]),
    liveStatus: z.enum(["idle", "running", "waiting", "completed", "error"]),
    activity: windowHostControllerTaskActivitySchema.optional(),
    searchSnippets: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((row, context) => {
    if (
      row.address.taskId !== row.meta.taskId ||
      row.address.workspacePath !== row.meta.workspacePath ||
      row.address.workspaceIdentity !== row.meta.workspaceIdentity
    ) {
      context.addIssue({
        code: "custom",
        message: "task address and meta identity must match",
        path: ["meta"],
      });
    }
  });
export type WindowHostControllerTaskRow = z.infer<typeof windowHostControllerTaskRowSchema>;

export type TaskListMembershipKind = "pinned" | "archived" | "timeline" | "active";

/** Host 查询和各 Renderer 投影共用的 task list membership 判定。 */
// 这个判定同时被 Host 查询与各 Renderer 投影调用，是四类视图的唯一真源。
// 任何一侧另写一份都会与另一侧漂移，表现为计数和列表内容对不上。
// pinned 与 archived 同时为真时 pinned 视图不收录：置顶栏只放活跃项，
// 归档优先，这样取消归档后任务会自然回到置顶栏而不需要额外记忆。
// active 只排除归档，因此 timeline 与 active 可以在同一任务上同时命中。
// [权衡] 返回布尔而非枚举，调用方只关心是否收录，不需要知道命中的是哪条规则。
export function matchesTaskListMembershipKind(
  membership: Pick<WindowHostControllerTaskRow["membership"], "pinned" | "archived">,
  kind: TaskListMembershipKind,
): boolean {
  switch (kind) {
    case "pinned":
      return membership.pinned && !membership.archived;
    case "archived":
      return membership.archived;
    case "timeline":
      return !membership.pinned && !membership.archived;
    case "active":
      return !membership.archived;
  }
}

// protocolVersion 是字面量 1 而不是 number：它代表结构版本，版本不同意味着字段
// 语义已变，必须让解析直接失败，而不是尽力兼容。
// [失败路径] 兼容式放宽会让新版新增或改义的字段在旧端被静默采信，
// 用户看到的是字段错位却不报错的列表，比直接拒绝更难排查。
// logEpoch 标识 Host 侧一次日志生命周期，重启即换新值，作用是让旧游标整体失效。
// 快照是全量基线，客户端收到后必须整体替换本地投影，不能与现有条目合并。
// 两个快照的字段名不同，workspaces 与 tasks，因此不能合并成一个通用容器。
// 快照帧的 fromSeq 恒为 0，客户端据此知道本地历史必须整体作废。
export const windowHostControllerWorkspacesSnapshotSchema = z
  .object({
    protocolVersion: z.literal(1),
    logEpoch: z.string().trim().min(1),
    workspaces: z.array(windowHostControllerWorkspaceFactSchema),
  })
  .strict();
export type WindowHostControllerWorkspacesSnapshot = z.infer<
  typeof windowHostControllerWorkspacesSnapshotSchema
>;

export const windowHostControllerTasksSnapshotSchema = z
  .object({
    protocolVersion: z.literal(1),
    logEpoch: z.string().trim().min(1),
    tasks: z.array(windowHostControllerTaskRowSchema),
  })
  .strict();
export type WindowHostControllerTasksSnapshot = z.infer<
  typeof windowHostControllerTasksSnapshotSchema
>;

// op 是封闭字面量集合，未知 op 会被 discriminatedUnion 判为非法，而不是安静跳过。
// 这与传输层对未知消息类型选择忽略的口径刻意不同：这里处在已建立的订阅内部，
// 未知 op 意味着两端版本不一致，继续应用剩余增量会让投影与 Host 状态永久分叉。
// 删除增量只带定位字段而不带整行，避免把已经过期的展示字段重新写回本地。
// upsert 与 removed 的字段集不对称是有意的：删除只需要能命中条目。
// 任务增量同样按 op 判别，task.removed 复用地址 schema，保证删除与去重同键。
// 新增 op 属于对外契约变更，必须与 Renderer 同版本发布，不能靠旧端兼容。
// 空增量序列合法，表示该区间无变更，接收方仍需按 toSeq 推进游标。
export const windowHostControllerWorkspaceDeltaSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("workspace.upserted"),
      workspace: windowHostControllerWorkspaceFactSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("workspace.removed"),
      sourceServerId: z.string().trim().min(1).optional(),
      remoteSessionId: z.string().trim().min(1).optional(),
      workspacePath: z.string().trim().min(1),
      workspaceIdentity: z.string().trim().min(1).optional(),
    })
    .strict(),
]);
export type WindowHostControllerWorkspaceDelta = z.infer<
  typeof windowHostControllerWorkspaceDeltaSchema
>;

export const windowHostControllerTaskDeltaSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("task.upserted"), task: windowHostControllerTaskRowSchema }).strict(),
  z.object({ op: z.literal("task.removed"), address: windowHostTaskAddressSchema }).strict(),
]);
export type WindowHostControllerTaskDelta = z.infer<typeof windowHostControllerTaskDeltaSchema>;

// 帧结构由两个 topic 共用，只有 snapshot 与 delta 的类型参数不同；复制两份会让
// seq 与 logEpoch 的校验规则逐渐分叉，一侧修了另一侧没修。
// [事务] payload 的 kind 判别保证一帧要么是全量快照要么是增量序列，不允许混装：
// 混装时接收方无法判断该替换还是该追加，重复应用会让计数翻倍。
// 快照帧强制 fromSeq 为 0，因为快照不接续任何历史，语义上等价于从头开始。
// toSeq 不低于 fromSeq 且两者非负，保证游标单调，只增不退。
// sentAt 只做数值校验、不参与排序：排障时它会因时钟回拨而倒退，不能当序列依据。
// 所有校验都放在 superRefine 里而不是分散到消费端，保证两侧接受同一份帧集合。
function createControllerFrameSchema<Snapshot extends z.ZodTypeAny, Delta extends z.ZodTypeAny>(
  topic: WindowHostControllerTopic,
  snapshotSchema: Snapshot,
  deltaSchema: Delta,
) {
  return z
    .object({
      topic: z.literal(topic),
      subscriptionId: z.string().trim().min(1),
      logEpoch: z.string().trim().min(1),
      fromSeq: z.number().int().nonnegative(),
      toSeq: z.number().int().nonnegative(),
      sentAt: z.number(),
      payload: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("snapshot"), snapshot: snapshotSchema }).strict(),
        z.object({ kind: z.literal("deltas"), deltas: z.array(deltaSchema) }).strict(),
      ]),
    })
    .strict()
    .superRefine((frame, context) => {
      if (frame.toSeq < frame.fromSeq) {
        context.addIssue({
          code: "custom",
          message: "toSeq must not be lower than fromSeq",
          path: ["toSeq"],
        });
      }
      const payload = frame.payload as
        | { kind: "snapshot"; snapshot: { logEpoch?: string } }
        | { kind: "deltas" };
      if (payload.kind === "snapshot") {
        if (frame.fromSeq !== 0) {
          context.addIssue({
            code: "custom",
            message: "snapshot frame must start at seq zero",
            path: ["fromSeq"],
          });
        }
        if (payload.snapshot.logEpoch !== frame.logEpoch) {
          context.addIssue({
            code: "custom",
            message: "frame and snapshot logEpoch must match",
            path: ["logEpoch"],
          });
        }
      }
    });
}

export const windowHostControllerWorkspaceFrameSchema = createControllerFrameSchema(
  CONTROLLER_WORKSPACES_TOPIC,
  windowHostControllerWorkspacesSnapshotSchema,
  windowHostControllerWorkspaceDeltaSchema,
);
export type WindowHostControllerWorkspaceFrame = z.infer<
  typeof windowHostControllerWorkspaceFrameSchema
>;

export const windowHostControllerTaskFrameSchema = createControllerFrameSchema(
  CONTROLLER_TASKS_INDEX_TOPIC,
  windowHostControllerTasksSnapshotSchema,
  windowHostControllerTaskDeltaSchema,
);
export type WindowHostControllerTaskFrame = z.infer<typeof windowHostControllerTaskFrameSchema>;

// base 缺席表示客户端没有历史，Host 会从 fromSeq 0 的快照开始推。
// 带上 base 则要求接在该 epoch 与 seq 之后，epoch 不匹配就退回快照。
// visibility 只是放行与节流提示，不改变消息语义：后台订阅仍要保持 seq 连续，
// 否则切回前台立刻触发 gap 判定并重订。
// 通道是单向推送，订阅结果只回 ack 不回数据，业务数据全部走帧。
export const controllerSubscribeParamsSchema = z
  .object({
    topic: windowHostControllerTopicSchema,
    base: z
      .object({
        logEpoch: z.string().trim().min(1),
        seq: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    visibility: z.enum(["foreground", "background"]).optional(),
  })
  .strict();
export type ControllerSubscribeParams = z.infer<typeof controllerSubscribeParamsSchema>;

export const controllerSubscribeResultSchema = z.object({ ack: subscribeAckSchema }).strict();
export type ControllerSubscribeResult = z.infer<typeof controllerSubscribeResultSchema>;

export const controllerResyncParamsSchema = z
  .object({
    subscriptionId: z.string().trim().min(1),
    base: z
      .object({
        logEpoch: z.string().trim().min(1),
        seq: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    forceSnapshot: z.boolean().optional(),
  })
  .strict();
export type ControllerResyncParams = z.infer<typeof controllerResyncParamsSchema>;

export const controllerResyncResultSchema = z.object({ ack: subscribeAckSchema }).strict();
export type ControllerResyncResult = z.infer<typeof controllerResyncResultSchema>;

export const controllerUnsubscribeParamsSchema = z
  .object({ subscriptionId: z.string().trim().min(1) })
  .strict();
export type ControllerUnsubscribeParams = z.infer<typeof controllerUnsubscribeParamsSchema>;

export interface WindowHostControllerCursor {
  subscriptionId: string;
  logEpoch: string;
  seq: number;
}

export interface WindowHostControllerFrameStart {
  subscriptionId: string;
  logEpoch: string;
  fromSeq: number;
}

// 三项必须全等才能判为连续，只比 seq 会把换 epoch 或换订阅后的首帧当成接续，
// 从而把新日志的增量接到旧投影上，产生永不消失的幽灵行。
// subscriptionId 参与比较，是为了让重订之后旧订阅的迟到帧自然失效。
// 这里只做判定，不改游标也不去重，调用方消费完帧后自行推进 seq。
// [权衡] 不在此抛错：gap 属正常现象，重订还是等待快照由调用方决定。
export function isWindowHostControllerFrameGap(
  cursor: WindowHostControllerCursor,
  frame: WindowHostControllerFrameStart,
): boolean {
  return (
    cursor.subscriptionId !== frame.subscriptionId ||
    cursor.logEpoch !== frame.logEpoch ||
    cursor.seq !== frame.fromSeq
  );
}
