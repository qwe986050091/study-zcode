/* oxlint-disable eslint(max-lines) -- re-home 产物：task realtime 运行时 schema 集中迁移，类型与校验就近。 */
// re-home 迁移产物（为删除旧协议树铺路）。
// 本文件承载 task realtime 传输面中仍被存活栈（validation.ts 外部 relay payload 校验）
// 消费的运行时 zod schema 与 resolveWorkspaceKey。
// task-realtime.ts 保留旧协议兼容接口；本文件集中定义对应的运行时 schema。

// task-realtime-core：task realtime 传输面的运行时 schema 集中地（re-home 产物，为删除旧协议树铺路）。
//
// 职责边界（做什么）：用 zod 定义事件信封、快照/列表失效事件、stream mirror 批次与发布操作、
// run lease 目标与租约结果、owner 命令的请求/投递/结果，以及 workspaceKey 的唯一解析算法。
// 职责边界（不做什么）：不做路由、不重试、不持有运行时状态、不读写存储，也不决定谁收到事件；
// 它只回答「这条 wire 数据在结构上是否被允许」。
// 职责边界（依赖谁）：zod、zcode-task-types-core 的模式与迁移来源类型、legacy provider 归一 schema、
// 权限回执、Hook 审核决策与 error attribution 共享 schema；消费者是 validation.ts 的外部 relay 校验。
//
// 分层：信封只放所有事件共有的事实（eventId、工作区三元组、trace、createdAt），失效事件与 mirror
// 批次都在信封上 extend；执行侧的命令与租约各有独立基座，不要为了复用把三者拉平。
// 这是结构校验文件，任何一处放宽都会直接扩大远端可写入的面，下面每条不变量都按硬约束对待。
//
// 阅读顺序：nonEmptyString → resolveWorkspaceKey → 两个 refine 辅助 → 失效事件 → mirror 操作
// → 租约 → 命令 → 结果 → 顶层两个联合。
//
// INV-01 断言：工作区身份键只能是「identity 去空白优先、path 兜底」这一种算法 —— 守住它的位置：resolveWorkspaceKey 与所有事件的 addWorkspaceKeyIssue 调用 —— 改错故障：远端与本地同路径互相串台，事件被误判为跨工作区。
// INV-02 断言：镜像批次与租约目标的 runId 必须等于 traceId —— 守住它的位置：addRunIdTraceIdIssue 及两处 mirror 分支 —— 改错故障：批次在手机端无法与本地 trace 对齐，消息挂到错误的运行上。
// INV-03 断言：自有对象 schema 必须 strict，未知字段一律拒绝 —— 守住它的位置：信封、失效事件、mirror 操作、租约与命令各处的 .strict() —— 改错故障：旧协议残留字段静默穿透，wire 契约悄悄漂移。
// INV-04 断言：全文件只有 taskStreamMirrorableEventSchema 可以 passthrough —— 守住它的位置：该 schema 的 .passthrough() —— 改错故障：运行时新增的流事件字段被本层裁掉，手机端卡片缺内容。
// INV-05 断言：扩展顺序固定为 base → extend → strict → superRefine —— 守住它的位置：每个 export 的链式调用 —— 改错故障：在 superRefine 之后再 extend 会丢校验或丢类型收窄。
// INV-06 断言：发布操作不带 seq，带序号操作才是补传版本 —— 守住它的位置：两个 discriminatedUnion 的定义 —— 改错故障：直播路径提前补号，owner 侧编号冲突、缺口检测失效。
// INV-07 断言：taskRunLeaseTargetSchema 必须与 taskStreamMirrorTargetSchema 同一实例 —— 守住它的位置：直接赋值那一行 —— 改错故障：两份目标各自演化，租约能过而镜像被拒。
// INV-08 断言：附件判别联合必须覆盖 image/audio/video/pdf/file 五种 kind —— 守住它的位置：zcodePromptAttachmentSchema 的数组 —— 改错故障：合法附件被 replayable 端拒绝，手机远控丢消息。
// INV-09 断言：身份与 id 字段必须经 nonEmptyString 校验 —— 守住它的位置：nonEmptyString 的定义与所有 taskId/traceId 字段 —— 改错故障：纯空白身份通过校验，写入一个不可定位的工作区。
// INV-10 断言：时间戳必须是整数且非负 —— 守住它的位置：createdAt/updatedAt/unreadAt 等字段 —— 改错故障：浮点或负数时间线让排序错乱，补偿逻辑漏事件。
// INV-11 断言：mode 枚举必须由 as const satisfies 锁到 ZCodeTaskMode —— 守住它的位置：zcodeTaskModeRealtimeValues 声明 —— 改错故障：新增模式在这里被拒，或放宽成 string 后类型推导回不到任务元数据。
// INV-12 断言：迁移来源在 realtime 面只承认 claudeCode —— 守住它的位置：zcodeTaskMigrationSourceRealtimeValues —— 改错故障：未登记来源写进元数据，迁移面板无法归类。
// INV-13 断言：provider 归一必须走共享 legacy schema —— 守住它的位置：taskMetaRealtimeSchema 的 provider 字段 —— 改错故障：旧桌面投影的历史取值被拒，旧客户端整批掉线。
// INV-14 断言：lastError.attribution 必须复用 errorAttributionSchema —— 守住它的位置：lastError 对象内 —— 改错故障：手机 replayable meta 与桌面 snapshot 归因不一致。
// INV-15 断言：streamWatermark 可缺省，但绝不能补 0 —— 守住它的位置：taskRealtimeInvalidationBaseEventSchema —— 改错故障：0 被当成真实序号，正常的无水位事件被误判为 stale。
// INV-16 断言：请求联合与投递联合必须保持同一命令集合 —— 守住它的位置：taskOwnerCommandRequestSchema 与 taskOwnerCommandDeliverySchema —— 改错故障：命令能发出去却投不达，静默丢失。
// INV-17 断言：originHostId 与 deliveryPurpose 只出现在投递侧 —— 守住它的位置：taskRealtimeDeliveredEventSchema —— 改错故障：生产端被迫伪造来源主机，中转字段回流污染上游校验。
// INV-18 断言：带 remoteSessionId 的 Hook 审核回执必须带 workspaceIdentity —— 守住它的位置：该子 schema 末尾的 superRefine —— 改错故障：远程工作区回执落到本地同路径会话。
//
import { z } from "zod";
import type { ZCodeTaskMigrationSource, ZCodeTaskMode } from "./zcode-task-types-core.js";
import { legacyZCodeProviderSchema } from "./zcode-agent-policy.js";
import { zcodePermissionResponseSchema } from "./zcode-protocol-legacy-types.js";
// merge 冲突解决：两侧分别在相邻行新增独立 import（本分支 hook trust review
// 决策 schema、staging telemetry error attribution schema），二者无语义交集，均保留。
import { workspaceHookReviewDecisionSchema } from "./zcode-protocol-v4/workspace-hook-review.js";
import { errorAttributionSchema } from "./zcode-protocol-v4/snapshot.js";

// 身份与 id 类字段统一走这个 schema：先 trim 再判空，纯空白串不算合法值
// 不要改成裸 min(1)：带空白的 workspaceIdentity 会穿到身份键计算，变成两条不同的工作区
// 这里不设长度上限，长度由传输层负责，本文件只守「非空」这一条语义
const nonEmptyString = z.string().trim().min(1);
// realtime 面允许的 mode 全集，末尾的 as const satisfies 把它与 ZCodeTaskMode 钉在一起
// 新增模式时 TS 会先在这里报错，这正是设计意图：传输面必须显式接纳新模式，而不是被 z.string 顺带放过
// 顺序无关但一项都不能删：历史任务回放仍会携带旧值，删了等于让旧客户端整批掉线
const zcodeTaskModeRealtimeValues = [
  "default",
  "yolo",
  "guarded",
  "plan",
  "edit",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "autoEdit",
  "build",
] as const satisfies readonly ZCodeTaskMode[];
// 迁移来源在 realtime 面只承认 claudeCode，未登记的来源一律拒绝
// 放宽成 z.string 会让脏来源写进任务元数据，迁移面板无法归类，也会被 satisfies 约束挡住
const zcodeTaskMigrationSourceRealtimeValues = [
  "claudeCode",
] as const satisfies readonly ZCodeTaskMigrationSource[];
// 变更摘要只描述文件数与增删行，不携带 diff 正文，正文永远走快照接口
// files 每项要求 writeCount 为正、lastTurnIndex 非负，用来判定这条变更能否按单轮展示
// 这里刻意不做「files 之和等于顶层 added」的对账，求和属于展示口径，校验层不重复业务计算
const zcodeTaskChangeSummaryRealtimeSchema = z
  .object({
    fileCount: z.number().int().nonnegative(),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    files: z.array(
      z
        .object({
          path: z.string(),
          added: z.number().int().nonnegative(),
          removed: z.number().int().nonnegative(),
          writeCount: z.number().int().positive(),
          lastTurnIndex: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
// 任务元数据是列表与详情共用的投影，字段全部围绕「列表里能渲染」而存在
// 顶层刻意没有 strict：早期桌面会附带内部字段，全部拒绝会让旧客户端的列表整批失败
// 缺省用 optional 表达而不是给默认值，缺省语义交给消费方，避免这里伪造事实
const taskMetaRealtimeSchema = z.object({
  taskId: nonEmptyString,
  traceId: nonEmptyString,
  title: z.string(),
  titleOverridden: z.boolean().optional(),
  workspacePath: nonEmptyString,
  workspaceIdentity: nonEmptyString.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  // realtime deliver 的运行时 schema 之前把 mode 放宽成 string，
  // schema 推导类型因此无法回到 ZCodeTaskMeta，host typecheck 也就无法覆盖这条链路。
  // mode 必须引用上面的只读数组，不允许就地写字面量，否则清单分叉后类型推导仍是 string
  // 这一行是「放宽成 string」事故的现场，改回前先读文件顶部的 INV-11
  mode: z.enum(zcodeTaskModeRealtimeValues),
  model: z.string().optional(),
  runtimeEpoch: z.number().int().nonnegative().optional(),
  // relay payload 可能由旧版本桌面投影；历史 provider 值在此归一为 glm。
  // provider 走共享的 legacy 归一 schema，历史取值在这里被接受并映射到新枚举
  // 不要换成新枚举：旧桌面投影的 payload 仍带历史值，换掉等于让旧客户端全部校验失败
  provider: legacyZCodeProviderSchema.optional(),
  migrationSource: z.enum(zcodeTaskMigrationSourceRealtimeValues).optional(),
  forkedFromTaskId: nonEmptyString.optional(),
  unreadAt: z.number().int().nonnegative().optional(),
  status: z.enum(["running", "completed", "error"]).optional(),
  lastError: z
    .object({
      code: z.string().optional(),
      message: z.string().min(1),
      traceId: nonEmptyString.optional(),
      taskId: nonEmptyString.optional(),
      // 旧 realtime schema 会静默剥离 lastError.attribution，导致手机 replayable
      // task meta 与桌面 snapshot 的归因不一致；这里沿用共享 schema 保持 wire 约束一致。
      // 归因结构必须复用 snapshot 的共享 schema，不能在这里重写一份等价结构
      // 旧 realtime schema 会静默剥离该字段，手机 replayable meta 与桌面 snapshot 的归因因此对不上
      // optional 只表示字段可缺，不表示结构可放宽，内部仍然逐字段受约束
      attribution: errorAttributionSchema.optional(),
    })
    .optional(),
  changeSummary: zcodeTaskChangeSummaryRealtimeSchema.optional(),
});
// 工作区身份键的唯一算法入口：identity 去空白后优先，空则回落到 path
// 全仓的去重、绑定、缓存、队列与持久化都用这一口径，任何地方手写等价逻辑都会分叉
// 不要在这里补 remoteSessionId 或 hostId：身份键只回答「是不是同一个工作区」，不回答「是不是同一条连接」
export function resolveWorkspaceKey(params: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  // 这一行就是全仓约定的字面实现，写成 ?? 或先判空再回落都会改变语义
  // path 不做 trim：它是文件操作口径，去掉首尾空白会改变真实路径；空串与纯空白都必须回落到它
  return params.workspaceIdentity?.trim() || params.workspacePath;
}
// reason 是失效事件的唯一分类维度，新增分类必须显式加进这个枚举
// 模型切换与标题更新单独成 reason，是为了避免被当成归属相关变更触发列表整刷
// stream_mirror_gap 与 stream_mirror_owner_lost 是失败路径专用，不能被普通事件复用，否则手机端会把正常重连当成异常
export const taskRealtimeReasonSchema = z.enum([
  "task_created",
  "user_message_saved",
  "assistant_message_saved",
  "task_status_changed",
  "task_meta_changed",
  // 切模型等纯配置变更独立成 reason，避免被当成归属相关 meta 变更触发列表整刷。
  "task_model_changed",
  // 标题更新（首条消息/自动标题）与归属无关且高频，独立 reason 避免全局 membership 重拉。
  "task_title_changed",
  "task_pinned",
  "task_unpinned",
  "task_archived",
  "task_unarchived",
  "task_deleted",
  "stream_mirror_gap",
  "stream_mirror_owner_lost",
]);
export const taskRealtimeDeliveryPurposeSchema = z.enum(["observer", "relay_owner"]);
export const taskRealtimeHostDeliveryKindSchema = z.enum(["desktop_window", "relay_bridge"]);
// 信封只放跨事件共有的事实：事件 id、工作区三元组、trace 与创建时间
// createdAt 是 epoch 毫秒整数而不是 ISO 字符串，避免时区与字符串比较口径分叉
// 信封不含 taskId：失效事件可以针对整个工作区，把 taskId 提前放进来会诱导消费方误用
const taskRealtimeEnvelopeSchema = z
  .object({
    eventId: nonEmptyString,
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
    traceId: nonEmptyString,
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
// 水位 = runId + 操作序号，两者一起才构成「看到哪」的位置，单给序号无法跨 run 比较
// 这里不校验单调性：单调只有在同一 run 的序列上下文里才有意义，校验层拿不到那个上下文
const taskStreamWatermarkSchema = z
  .object({
    runId: nonEmptyString,
    opSeq: z.number().int().nonnegative(),
  })
  .strict();
// 失效事件基座 = 信封 + reason + 可选水位，两路子类都从这里 extend，公共字段不得下放
// 水位可选：没有流式运行的失效事件本就没有位置，缺省不能被补成 0，0 是合法序号
const taskRealtimeInvalidationBaseEventSchema = taskRealtimeEnvelopeSchema
  .extend({
    reason: taskRealtimeReasonSchema,
    streamWatermark: taskStreamWatermarkSchema.optional(),
  })
  .strict();
// [契约] 这是 workspaceKey 校验的唯一实现，所有事件的 superRefine 都调它
// 它用 resolveWorkspaceKey 重算期望值再与 payload 比对，不在校验层另写一套算法
// [失败路径] 错误挂在 workspaceKey 路径上而不是整个对象，前端能直接指出是哪个字段不对
// [权衡] 不改成 throw：zod 的 refine 约定是收集 issue，抛错会让一批事件失去其余诊断信息
// 函数只读入参、不缓存上次结果，避免跨事件串用身份
const addWorkspaceKeyIssue = (
  ctx: z.RefinementCtx,
  event: { workspacePath: string; workspaceIdentity?: string; workspaceKey: string },
) => {
  const expectedWorkspaceKey = resolveWorkspaceKey(event);
  if (event.workspaceKey !== expectedWorkspaceKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["workspaceKey"],
      message: "workspaceKey must match workspaceIdentity fallback rule",
    });
  }
};
// [契约] 镜像链路上 runId 必须等于 traceId，这是「一次 run 一条 trace」的物化表达
// 两者都来自同一 run 的创建点，任何不一致都说明消息被跨 run 拼接；放宽成警告会让批次在手机端无法与本地 trace 对齐
const addRunIdTraceIdIssue = (ctx: z.RefinementCtx, target: { runId: string; traceId: string }) => {
  if (target.runId !== target.traceId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["runId"],
      message: "runId must match traceId",
    });
  }
};
// [契约] 单任务快照失效必须带 taskId，且只带 taskId
// 不携带 taskMeta：带上元数据会诱导消费方把失效事件当数据源，绕过快照接口
export const taskSnapshotInvalidatedEventSchema = taskRealtimeInvalidationBaseEventSchema
  .extend({
    type: z.literal("task_snapshot_invalidated"),
    taskId: nonEmptyString,
  })
  .strict();
// [契约] 列表失效允许不带 taskId（整工作区刷新），也允许附带 taskMeta 做就地更新
// taskId 可选与 taskMeta 可选是两件事，不要为了省事把两者绑成「要么都给要么都不给」
// 附带 taskMeta 只是省一次快照往返，消费方仍必须以快照为准，缺省即表示这次不改列表行内容
export const workspaceTaskListInvalidatedEventSchema = taskRealtimeInvalidationBaseEventSchema
  .extend({
    type: z.literal("workspace_task_list_invalidated"),
    taskId: nonEmptyString.optional(),
    taskMeta: taskMetaRealtimeSchema.optional(),
  })
  .strict();
// [契约] 附件按 kind 判别，每种 kind 的必填项不同，因此不能退化成一个宽松大对象
// 判别键必须是字面量常量，写成 string 会让联合失去判别能力，任意对象都能通过
// [失败路径] 新增 kind 要同时确认 replayable 端认识它，否则手机远控会拒收合法附件
const zcodePromptAttachmentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("image"),
      filename: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int().nonnegative().optional(),
      dataBase64: z.string().optional(),
      localPath: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("audio"),
      filename: z.string(),
      mimeType: z.string(),
      dataBase64: z.string().optional(),
      localPath: z.string().optional(),
    })
    .strict(),
  // 附件类型新增 video 后，replayable schema 未同步，手机远控会拒绝合法附件。
  z
    .object({
      // [契约] video 分支补齐的是早期遗漏：附件类型先加了 video，replayable schema 没有跟上
      // 它保留 dataBase64 与 localPath 两条通道，与 image 分支保持一致；sizeBytes 不能删，展示端要靠它决定是否内联预览
      kind: z.literal("video"),
      filename: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int().nonnegative().optional(),
      dataBase64: z.string().optional(),
      localPath: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pdf"),
      filename: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int().nonnegative().optional(),
      dataBase64: z.string().optional(),
      localPath: z.string().optional(),
    })
    .strict(),
  z
    .object({
      // [权衡] file 分支的 sizeBytes 是必填，其余分支是可选，这是刻意的差异，不要统一
      // textContent 只属于 file 分支：提到联合外层会误导其它 kind，也会让文本之外的内容被当作文本
      kind: z.literal("file"),
      filename: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      dataBase64: z.string().optional(),
      textContent: z.string().optional(),
      localPath: z.string().optional(),
    })
    .strict(),
]);
// [契约] 这是全文件唯一的 passthrough：被镜像的 agent 流事件由运行时定义，本层不拥有它的字段
// 只强制 type/taskId/traceId 三个定位字段，其余原样透传，手机端才能收到完整事件
// [失败路径] 改成 strict 后，运行时一旦新增事件字段，replay 会被本层裁掉，表现为手机端卡片缺字段
// 反过来也不能把 passthrough 用到本文件自有结构上，那等于放弃 wire 约束
const taskStreamMirrorableEventSchema = z
  .object({
    type: nonEmptyString,
    taskId: nonEmptyString,
    traceId: nonEmptyString,
  })
  .passthrough();
// [契约] 用户消息操作只描述「一条消息内容 + 附件 + 时间戳」，不携带序号
// timestamp 用有限数而非整数：它与消息本地时间同源，允许小数；NaN 与 Infinity 必须被挡在外面
const taskStreamMirrorUserMessagePublishOpSchema = z
  .object({
    kind: z.literal("user_message"),
    messageId: nonEmptyString,
    content: z.string(),
    attachments: z.array(zcodePromptAttachmentSchema).optional(),
    timestamp: z.number().finite(),
  })
  .strict();
// [契约] 流事件操作只包一层可镜像事件，不复制它的字段
// 包一层而不是展开，是为了让 passthrough 的边界在结构上可见；新增操作类型要先加发布联合再加带序号联合
const taskStreamMirrorStreamEventPublishOpSchema = z
  .object({
    kind: z.literal("stream_event"),
    event: taskStreamMirrorableEventSchema,
  })
  .strict();
// [契约] 发布操作是直播路径的无序号版本，delivery 端按到达顺序消费
// 它刻意不复用带 seq 的联合：直播路径不需要补号，补号反而会与 owner 侧编号冲突
// 两个联合的分支顺序必须一致，否则类型收窄与运行期判别可能指向不同分支
export const taskStreamMirrorPublishOpSchema = z.discriminatedUnion("kind", [
  taskStreamMirrorUserMessagePublishOpSchema,
  taskStreamMirrorStreamEventPublishOpSchema,
]);
// [契约] 带序号操作是补传与重放路径的版本，seq 必须为正整数
// 用正数而非非负，是为了让 0 永远表示「尚未写入」，避免与首个操作混淆
// 它由发布操作 extend 而来，字段集天然与直播路径一致；扩展后必须重新 strict，否则会丢掉父级严格性
export const taskStreamMirrorOpSchema = z.discriminatedUnion("kind", [
  taskStreamMirrorUserMessagePublishOpSchema
    .extend({
      seq: z.number().int().positive(),
    })
    .strict(),
  taskStreamMirrorStreamEventPublishOpSchema
    .extend({
      seq: z.number().int().positive(),
    })
    .strict(),
]);
// [契约] 镜像目标描述「哪个 run 归哪个客户端所有」，含工作区、task、run 与 owner 标识
// ownerClientId 与 ownerDeviceLabel 都可选：本地直连场景没有设备标签，必填会把本地路径挡在门外
// raw 版本不做 refine，校验放在对外版本里，这样 lease 请求也能复用同一份字段集
const taskStreamMirrorTargetRawSchema = z
  .object({
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
    taskId: nonEmptyString,
    runId: nonEmptyString,
    traceId: nonEmptyString,
    ownerClientId: nonEmptyString.optional(),
    ownerDeviceLabel: nonEmptyString.optional(),
  })
  .strict();
// [契约] 对外目标 schema 在 raw 版本上补两道校验：工作区键一致、runId 与 traceId 一致
// 两道都走共享辅助函数，不内联重写；也不在这里追加业务字段，扩展应该回到 raw 版本
export const taskStreamMirrorTargetSchema = taskStreamMirrorTargetRawSchema.superRefine(
  (target, ctx) => {
    addWorkspaceKeyIssue(ctx, target);
    addRunIdTraceIdIssue(ctx, target);
  },
);
// [契约] 批次事件在信封之上补齐 run、owner、序号区间与操作数组
// batchSeq/fromSeq/toSeq 都是正整数，区间用于检测丢批与重复批，缺一段就无法判断连续性
// ops 允许为空：心跳式批次可以只推进水位；terminal 标记本 run 镜像结束，缺失会让手机端一直等后续批次
const taskStreamMirrorBatchEventRawSchema = taskRealtimeEnvelopeSchema
  .extend({
    type: z.literal("task_stream_mirror_batch"),
    taskId: nonEmptyString,
    runId: nonEmptyString,
    ownerClientId: nonEmptyString.optional(),
    ownerDeviceLabel: nonEmptyString.optional(),
    batchSeq: z.number().int().positive(),
    fromSeq: z.number().int().positive(),
    toSeq: z.number().int().positive(),
    ops: z.array(taskStreamMirrorOpSchema),
    terminal: z.boolean(),
  })
  .strict();
// [契约] 租约目标与镜像目标是同一个 schema 实例，不是复制体
// 直接赋值而非重新定义，保证两边校验永远同步；任何复制粘贴都会埋下分叉
export const taskRunLeaseTargetSchema = taskStreamMirrorTargetSchema;
// [契约] 租约请求 = 目标字段 + 请求 id，同样过工作区键与 run/trace 两道校验
// 用 raw 版本 extend 而不是目标版本，因为 superRefine 之后无法再 extend；新增字段必须加在这里，不要污染镜像目标
export const taskRunLeaseAcquireRequestSchema = taskStreamMirrorTargetRawSchema
  .extend({
    leaseRequestId: nonEmptyString,
  })
  .strict()
  .superRefine((request, ctx) => {
    addWorkspaceKeyIssue(ctx, request);
    addRunIdTraceIdIssue(ctx, request);
  });
// [契约] 租约结果按 acquired 判别：成功只回 ownerHostId，失败额外回固定原因
// 失败原因目前只有 owned_by_other_host，扩原因必须同步手机端文案，否则用户看到空提示
// 判别键用字面量 true/false 而不是 boolean，否则联合无法收窄；成功分支不带原因，避免消费方读到无意义的 reason
export const taskRunLeaseResultSchema = z.discriminatedUnion("acquired", [
  z
    .object({
      leaseRequestId: nonEmptyString,
      acquired: z.literal(true),
      ownerHostId: nonEmptyString,
    })
    .strict(),
  z
    .object({
      leaseRequestId: nonEmptyString,
      acquired: z.literal(false),
      ownerHostId: nonEmptyString,
      reason: z.literal("owned_by_other_host"),
    })
    .strict(),
]);
// [契约] owner 命令基座统一携带请求 id、工作区三元组、taskId 与 runId
// 所有命令都要能定位到具体 run，因此 runId 必填，不接受只给 taskId
// 基座不带 type，判别字段留给各子类 extend，避免基座自身被当成合法命令；strict 在这里尤其重要，命令是写入路径
const taskOwnerCommandBaseSchema = z
  .object({
    commandRequestId: nonEmptyString,
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
    taskId: nonEmptyString,
    runId: nonEmptyString,
  })
  .strict();
const taskStopGenerationOwnerCommandRequestSchema = taskOwnerCommandBaseSchema
  .extend({
    type: z.literal("stop_generation"),
  })
  .strict();
const taskRespondPermissionOwnerCommandRequestSchema = taskOwnerCommandBaseSchema
  .extend({
    type: z.literal("respond_permission"),
    permissionRequestId: nonEmptyString,
    optionId: nonEmptyString,
    response: zcodePermissionResponseSchema,
  })
  .strict();
const taskRespondElicitationOwnerCommandRequestSchema = taskOwnerCommandBaseSchema
  .extend({
    type: z.literal("respond_elicitation"),
    elicitationRequestId: nonEmptyString,
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
// [契约] Hook 审核回执必须带 bundleDigest 与递增的 generation
// digest 用正则锁死 64 位小写十六进制，防止短摘要或大写形式写进回执，桌面端比对会失败
// generation 是正整数，用来丢弃过期审核面板发出的回执，缺失它就无法判断新旧
// 该子类还要求「带 remoteSessionId 时必须带 workspaceIdentity」，这条约束只属于它，不能上提到基座
const taskRespondWorkspaceHookReviewOwnerCommandRequestSchema = taskOwnerCommandBaseSchema
  .extend({
    type: z.literal("respond_workspace_hook_review"),
    remoteSessionId: nonEmptyString.optional(),
    sessionId: nonEmptyString,
    bundleDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    reviewFlowId: nonEmptyString,
    generation: z.number().int().positive(),
    interactionId: nonEmptyString,
    decision: workspaceHookReviewDecisionSchema,
  })
  .strict()
  .superRefine((command, context) => {
    // [契约] 远程会话的审核回执必须带 workspaceIdentity，否则只靠路径会落错工作区
    // 判定用 falsy 而非 undefined，空串身份同样视为缺失；错误挂在 workspaceIdentity 上，前端可直接高亮
    if (command.remoteSessionId && !command.workspaceIdentity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspaceIdentity"],
        message: "remote workspace Hook review response requires workspaceIdentity",
      });
    }
  });
const zcodeTaskRuntimeCommandBaseSchema = z
  .object({
    commandId: nonEmptyString,
    taskId: nonEmptyString,
    traceId: nonEmptyString,
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
    status: z.enum(["accepted", "running", "failed"]),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    clientId: nonEmptyString.optional(),
    clientLabel: nonEmptyString.optional(),
    error: z.string().optional(),
  })
  .strict();
const zcodeTaskRuntimeCommandSchema = z.discriminatedUnion("type", [
  zcodeTaskRuntimeCommandBaseSchema
    .extend({
      type: z.literal("send_prompt"),
      content: z.string(),
      attachments: z.array(zcodePromptAttachmentSchema).optional(),
      automationId: nonEmptyString.optional(),
    })
    .strict(),
]);
const taskEnqueueCommandOwnerCommandRequestSchema = taskOwnerCommandBaseSchema
  .extend({
    type: z.literal("enqueue_task_command"),
    taskCommand: zcodeTaskRuntimeCommandSchema,
  })
  .strict();
const taskPromoteCommandOwnerCommandRequestSchema = taskOwnerCommandBaseSchema
  .extend({
    type: z.literal("promote_task_command"),
    commandId: nonEmptyString,
    clientMode: z.literal("web-remote-replayable"),
  })
  .strict();
const taskCancelCommandOwnerCommandRequestSchema = taskOwnerCommandBaseSchema
  .extend({
    type: z.literal("cancel_task_command"),
    commandId: nonEmptyString,
    clientMode: z.literal("web-remote-replayable"),
  })
  .strict();
// [契约] 命令请求联合固定七类：停止生成、权限回执、提问回执、Hook 回执、入队、提权、取消
// 七类共用基座字段，增删一类只需改这个数组与对应子 schema，顺序不影响校验
// [权衡] 外层 refine 只校验顶层 workspaceKey，内层 taskCommand 的 key 由 owner 侧按同一算法对齐
// 不做内外层交叉比对是刻意的：入队命令允许先把命令挂到目标工作区，再在 owner 侧落盘
export const taskOwnerCommandRequestSchema = z
  .discriminatedUnion("type", [
    taskStopGenerationOwnerCommandRequestSchema,
    taskRespondPermissionOwnerCommandRequestSchema,
    taskRespondElicitationOwnerCommandRequestSchema,
    taskRespondWorkspaceHookReviewOwnerCommandRequestSchema,
    taskEnqueueCommandOwnerCommandRequestSchema,
    taskPromoteCommandOwnerCommandRequestSchema,
    taskCancelCommandOwnerCommandRequestSchema,
  ])
  .superRefine((command, ctx) => {
    addWorkspaceKeyIssue(ctx, command);
  });
// [契约] 投递联合是请求联合的镜像，唯一差异是每类都多一个 requesterHostId
// 两份联合必须保持同一命令集合，少一类就会出现「能发不能投」的静默丢命令
// 这里重复写七次 extend 而不是用映射生成，是为了让类型推导保持精确的判别联合
// [权衡] 不要为了去重抽成泛型工厂：zod 的判别在运行期需要字面量分支，抽走会退化类型
export const taskOwnerCommandDeliverySchema = z
  .discriminatedUnion("type", [
    taskStopGenerationOwnerCommandRequestSchema
      .extend({
        requesterHostId: nonEmptyString,
      })
      .strict(),
    taskRespondPermissionOwnerCommandRequestSchema
      .extend({
        requesterHostId: nonEmptyString,
      })
      .strict(),
    taskRespondElicitationOwnerCommandRequestSchema
      .extend({
        requesterHostId: nonEmptyString,
      })
      .strict(),
    taskRespondWorkspaceHookReviewOwnerCommandRequestSchema
      .extend({
        requesterHostId: nonEmptyString,
      })
      .strict(),
    taskEnqueueCommandOwnerCommandRequestSchema
      .extend({
        requesterHostId: nonEmptyString,
      })
      .strict(),
    taskPromoteCommandOwnerCommandRequestSchema
      .extend({
        requesterHostId: nonEmptyString,
      })
      .strict(),
    taskCancelCommandOwnerCommandRequestSchema
      .extend({
        requesterHostId: nonEmptyString,
      })
      .strict(),
  ])
  .superRefine((command, ctx) => {
    addWorkspaceKeyIssue(ctx, command);
  });
// [契约] 命令失败码只有三种：无活跃 owner、命令过期、执行失败
// 新增码必须同步手机端提示文案；不要把原因塞进 error 字符串代替码，字符串不可判定也不可统计
export const taskOwnerCommandErrorCodeSchema = z.enum([
  "NO_ACTIVE_TASK_OWNER",
  "STALE_TASK_OWNER_COMMAND",
  "OWNER_COMMAND_FAILED",
]);
// [契约] 结果按 success 判别：成功可选带回被接受的任务命令，失败必须带 error
// 成功分支的 taskCommand 可选，因为停止生成这类命令没有后续命令体；code 只在失败分支出现且可选，兼容还没实现错误码的旧 owner
export const taskOwnerCommandResultSchema = z.discriminatedUnion("success", [
  z
    .object({
      commandRequestId: nonEmptyString,
      success: z.literal(true),
      taskCommand: zcodeTaskRuntimeCommandSchema.optional(),
    })
    .strict(),
  z
    .object({
      commandRequestId: nonEmptyString,
      success: z.literal(false),
      error: z.string(),
      code: taskOwnerCommandErrorCodeSchema.optional(),
    })
    .strict(),
]);
// [契约] 事件生产者侧的联合：三类事件共用信封与工作区校验
// mirror 批次额外要求 runId 与 traceId 一致，其余两类没有 run 概念
// 这里不含 originHostId 与 deliveryPurpose，它们是中转层补充的字段，进生产侧会逼生产端伪造来源主机
export const taskRealtimeEventSchema = z
  .discriminatedUnion("type", [
    taskSnapshotInvalidatedEventSchema,
    workspaceTaskListInvalidatedEventSchema,
    taskStreamMirrorBatchEventRawSchema,
  ])
  .superRefine((event, ctx) => {
    addWorkspaceKeyIssue(ctx, event);
    if (event.type === "task_stream_mirror_batch") {
      addRunIdTraceIdIssue(ctx, event);
    }
  });
// [契约] 投递侧联合：在生产侧三类事件上补 originHostId 与可选 deliveryPurpose
// originHostId 必填，手机端靠它判定事件来自哪台主机，缺了就无法做多主机去重
// 与生产侧联合保持同构，改一边必须同步另一边，否则会出现「产出即失败」的链路
export const taskRealtimeDeliveredEventSchema = z
  .discriminatedUnion("type", [
    taskSnapshotInvalidatedEventSchema
      .extend({
        originHostId: nonEmptyString,
        deliveryPurpose: taskRealtimeDeliveryPurposeSchema.optional(),
      })
      .strict(),
    workspaceTaskListInvalidatedEventSchema
      .extend({
        originHostId: nonEmptyString,
        deliveryPurpose: taskRealtimeDeliveryPurposeSchema.optional(),
      })
      .strict(),
    taskStreamMirrorBatchEventRawSchema
      .extend({
        originHostId: nonEmptyString,
        deliveryPurpose: taskRealtimeDeliveryPurposeSchema.optional(),
      })
      .strict(),
  ])
  .superRefine((event, ctx) => {
    addWorkspaceKeyIssue(ctx, event);
    if (event.type === "task_stream_mirror_batch") {
      addRunIdTraceIdIssue(ctx, event);
    }
  });
