// INV-01 本文件只做协议形状与不变量校验，不得引入 IO 或运行态存储，否则该 schema 会被 CLI 与 UI 两端的生命周期绑死。
// INV-02 所有对象一律 strict，未知字段必须被拒绝；放宽后旧客户端新增字段会被静默吞掉，升级期无法定位协议漂移。
// INV-03 nonEmptyStringSchema 先 trim 再判长，纯空白串不得通过；去掉 trim 会让只有空格的 id 进入查表并落空。
// INV-04 positiveIntegerSchema 守住 generation 与超时字节数，零值不合法；放宽到非负会让已失效的 generation 被当成有效轮次。
// INV-05 sha256DigestSchema 只接受 64 位小写十六进制；长度或大小写漂移会让摘要比对恒不等，全部 hook 被误判为 stale_digest。
// INV-06 枚举字面量是磁盘与远端存档的兼容面，只能追加不能改名；改名会让历史 pending 记录在反序列化时直接失败。
// INV-07 reviewItemIds 至少一项且不得重复；重复 id 会让 trust_selected 在同一项上重复提交，审批计数与列表展示错位。
// INV-08 hookDeclarationDigests 不得重复；重复会让撤销路径对同一声明重复扣减，信任表出现负向记录。
// INV-09 审核请求 target 刻意不含 hookDeclarationDigests，flow 需从当前 snapshot 全量拉取 pending 项。
// INV-10 bundleDigest 是审核与撤销的唯一绑定键；请求期与撤销期不一致即代表工作区内容已变，必须重新审核。
// INV-11 deadlineAt 不得早于 createdAt；颠倒后倒计时为负，评审人会看到已过期却仍可点击的弹窗。
// INV-12 summary.hookCount 必须等于 items 长度；不一致说明摘要与明细来自不同快照，前端会展示错误总数。
// INV-13 summary.eventCount 按去重后的事件种类计数，不是条目数；误用条目数会让统计栏虚高。
// INV-14 summary.pendingCount 只统计 pending_trust、revoked、stale_digest 三态；纳入 trusted_persistent 会把已信任项算成待审。
// INV-15 items 的 trustState 必须取自统一枚举；越界值在 strict 下报错，避免前端出现无样式的未知状态。
// INV-16 warningCode 固定为 workspace_hooks_execute_code，是 UI 高危提示的触发键，不得改为自由文本。
// INV-17 展示请求只允许 settingsSection 为 hooks、settingsScope 为 workspace，写死以防跳转到错误设置页。
// INV-18 addDuplicateItemIssue 只在存在重复时追加 issue，无重复时必须零副作用，否则合法载荷会被无端拒绝。
//
// 模块职责：定义 workspace hook 审核流程在协议层的全部 schema，覆盖信任状态枚举、命令 target、请求载荷与展示请求。
// 状态所有权：本文件不持有运行态；信任状态与摘要由服务端 snapshot 派生，客户端校验一次后原样透传。
// 阅读顺序：基础标量 → 信任状态枚举 → 命令 target → 请求载荷 → 展示请求 → 重复项判重工具。
import { z } from "zod";
import { timestampSchema } from "./core.js";

// 所有字符串字段共用这一个标量，trim 后判长是唯一的空值防线。
// [失败路径] 若只做 min(1) 而不 trim，纯空格 reviewItemId 会通过校验并在查表时静默失配。
const nonEmptyStringSchema = z.string().trim().min(1);
const positiveIntegerSchema = z.number().int().positive();
const nonnegativeIntegerSchema = z.number().int().nonnegative();
// 摘要统一按小写十六进制校验，与产物侧计算出的编码保持一致。
// [权衡] 这里只做形似校验，不做二次哈希比对，真正的绑定校验落在 bundleDigest 与 snapshot 的相等判断上。
const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

// 七种信任状态是审核弹窗渲染分支的唯一来源，顺序无关但取值不可增删。
// not_applicable 表示当前工作区无 hook，必须与待审态区分，否则会出现空审核列表。
// [失败路径] blocked_untrusted 与 blocked_policy 表达不同拦截原因，合并会让用户看到错误的放行指引。
// stale_digest 表示内容已变需重新审核，服务端只能下发此态而不能就地刷新信任。
export const workspaceHookReviewTrustStateSchema = z.enum([
  "not_applicable",
  "pending_trust",
  "trusted_persistent",
  "blocked_untrusted",
  "blocked_policy",
  "revoked",
  "stale_digest",
]);
export type WorkspaceHookReviewTrustState = z.infer<typeof workspaceHookReviewTrustStateSchema>;

// 审核决策只允许 trust_selected 一种动作，避免协议层出现隐式批量放行。
// [事务] 决策与 reviewItemIds 同时生效；只提交部分 id 时其余项保持原状态，不做任何默认勾选。
export const workspaceHookReviewDecisionSchema = z
  .object({
    action: z.literal("trust_selected"),
    reviewItemIds: z.array(nonEmptyStringSchema).min(1),
  })
  .strict()
  .superRefine((decision, context) => {
    if ("reviewItemIds" in decision && decision.reviewItemIds) {
      addDuplicateItemIssue(decision.reviewItemIds, context, ["reviewItemIds"]);
    }
  });
export type WorkspaceHookReviewDecision = z.infer<typeof workspaceHookReviewDecisionSchema>;

// 命令 target 是客户端回传审核结果时的定位坐标，sessionId、taskId 与 runId 三者缺一不可。
// generation 与 interactionId 共同防止旧弹窗覆盖新一轮审核结果。
// [并发] 同一 session 可能并行多个 run，只按 sessionId 匹配会把结果写到错误的运行上下文。
export const workspaceHookReviewCommandTargetSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    runId: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema.optional(),
    workspaceIdentity: nonEmptyStringSchema,
    bundleDigest: sha256DigestSchema,
    reviewFlowId: nonEmptyStringSchema,
    generation: positiveIntegerSchema,
    interactionId: nonEmptyStringSchema,
  })
  .strict();
export type WorkspaceHookReviewCommandTarget = z.infer<
  typeof workspaceHookReviewCommandTargetSchema
>;

// 撤销 target 必须携带 hookDeclarationDigests，撤销粒度是具体声明而非整个工作区。
// [事务] 撤销与信任写入共用 bundleDigest；摘要变化时旧撤销请求应整体作废而非部分生效。
// 重复声明摘要由 superRefine 直接拒绝，避免同一 hook 在信任表里被扣减两次。
export const workspaceHookTrustRevokeTargetSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema.optional(),
    workspaceIdentity: nonEmptyStringSchema,
    bundleDigest: sha256DigestSchema,
    hookDeclarationDigests: z.array(sha256DigestSchema).min(1),
  })
  .strict()
  .superRefine((target, context) => {
    addDuplicateItemIssue(target.hookDeclarationDigests, context, ["hookDeclarationDigests"]);
  });
export type WorkspaceHookTrustRevokeTarget = z.infer<typeof workspaceHookTrustRevokeTargetSchema>;

// 软门禁：按需开审核 flow 的命令 target。
// 克隆 revoke 的 non-flow target 变体,但不需要 hookDeclarationDigests
// (审核 flow 从当前 snapshot 拉取全部 pending items,而非指定 declarations)。
// 软门禁按需开审核 flow 时使用该 target，字段是撤销 target 去掉声明摘要后的最小集。
// [权衡] 不传声明摘要意味着一次审核覆盖 snapshot 内全部 pending 项，副作用范围更大但交互更短。
// [失败路径] 若误加 hookDeclarationDigests 字段，strict 会直接拒绝，导致旧客户端无法发起审核。
export const requestWorkspaceHookReviewTargetSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema.optional(),
    workspaceIdentity: nonEmptyStringSchema,
    bundleDigest: sha256DigestSchema,
  })
  .strict();
export type RequestWorkspaceHookReviewTarget = z.infer<
  typeof requestWorkspaceHookReviewTargetSchema
>;

// 请求载荷是审核弹窗的唯一数据源，kind 固定为 workspaceHookReview 以便按类型分发。
// items 内的 displayCommand 与 sourcePath 直接进入 UI，必须由服务端裁切长度而非依赖前端截断。
// [资源] resolvedMaxOutputBytes 与 resolvedTimeoutMs 已在服务端解析完毕，客户端不得再套用默认值。
// editable 与 configuredEnabled 分属两个维度，混用会让只读项被渲染成可编辑状态。
export const workspaceHookReviewRequestPayloadSchema = z
  .object({
    kind: z.literal("workspaceHookReview"),
    reviewFlowId: nonEmptyStringSchema,
    generation: positiveIntegerSchema,
    interactionId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    runId: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema,
    workspaceLabel: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema.optional(),
    bundleDigest: sha256DigestSchema,
    createdAt: timestampSchema,
    // [边界] 截止时间与创建时间同源同格式，先后比较依赖 timestampSchema 的可排序表示。
    // [失败路径] 若上游下发本地时间字符串，比较仍会给出错误顺序，必须保证同一时区与同一时刻基准。
    deadlineAt: timestampSchema,
    sourceFiles: z.array(
      z
        .object({
          path: nonEmptyStringSchema,
          displayPath: nonEmptyStringSchema,
          editable: z.boolean(),
        })
        .strict(),
    ),
    summary: z
      .object({
        eventCount: nonnegativeIntegerSchema,
        hookCount: nonnegativeIntegerSchema,
        pendingCount: nonnegativeIntegerSchema,
      })
      .strict(),
    items: z.array(
      z
        .object({
          reviewItemId: nonEmptyStringSchema,
          event: z.enum([
            "SessionStart",
            "UserPromptSubmit",
            "PreToolUse",
            "PermissionRequest",
            "PostToolUse",
            "PostToolUseFailure",
            "Stop",
          ]),
          matcher: z.string().optional(),
          type: z.enum(["command", "process"]),
          displayName: nonEmptyStringSchema,
          displayCommand: nonEmptyStringSchema,
          sourcePath: nonEmptyStringSchema,
          resolvedTimeoutMs: positiveIntegerSchema,
          resolvedMaxOutputBytes: positiveIntegerSchema,
          executionMode: z.enum(["foreground", "background"]),
          configuredEnabled: z.boolean(),
          editable: z.boolean(),
          trustState: workspaceHookReviewTrustStateSchema,
        })
        .strict(),
    ),
    warningCode: z.literal("workspace_hooks_execute_code"),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.deadlineAt < request.createdAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deadlineAt"],
        message: "deadlineAt must not precede createdAt",
      });
    }
    // 摘要与明细必须来自同一快照，hookCount 是二者一致性的第一道断言。
    // [事务] 该校验在解析期完成，调用方拿到的对象已保证摘要可信，无需二次核对。
    // [失败路径] 报错挂在 summary.hookCount 路径上，前端可据此高亮摘要区而非整个表单。
    if (request.summary.hookCount !== request.items.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary", "hookCount"],
        message: "hookCount must match the immutable request items",
      });
    }
    const eventCount = new Set(request.items.map((item) => item.event)).size;
    if (request.summary.eventCount !== eventCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary", "eventCount"],
        message: "eventCount must match the immutable request items",
      });
    }
    // 待审计数只认三种可放行前状态，统计口径与信任状态枚举强绑定。
    // [边界] revoked 与 stale_digest 仍算待审，因为二者都要求用户重新确认后才能执行。
    // [失败路径] 口径漂移会让按钮文案与真实可执行项数不符，用户会误以为全部已处理。
    const pendingCount = request.items.filter((item) =>
      ["pending_trust", "revoked", "stale_digest"].includes(item.trustState),
    ).length;
    if (request.summary.pendingCount !== pendingCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary", "pendingCount"],
        message: "pendingCount must match pending admission items",
      });
    }
    addDuplicateItemIssue(
      request.items.map((item) => item.reviewItemId),
      context,
      ["items"],
    );
  });
export type WorkspaceHookReviewRequestPayload = z.infer<
  typeof workspaceHookReviewRequestPayloadSchema
>;

// 展示请求只负责把界面导航到工作区 hooks 设置页，不携带任何审核结论。
// [权衡] presentWorkspaceHookReviewRequestSchema 的分区与作用域写成字面量：换取跳转确定性，代价是新增分区必须改协议。
export const presentWorkspaceHookReviewRequestSchema = z
  .object({
    reviewFlowId: nonEmptyStringSchema,
    generation: positiveIntegerSchema,
    interactionId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema,
    bundleDigest: sha256DigestSchema,
    settingsSection: z.literal("hooks"),
    settingsScope: z.literal("workspace"),
  })
  .strict();
export type PresentWorkspaceHookReviewRequest = z.infer<
  typeof presentWorkspaceHookReviewRequestSchema
>;

// 判重工具被决策、撤销与请求载荷三处 superRefine 共用，行为变化会同时影响三条校验链。
// 用 Set 尺寸与数组长度比较，命中重复即追加一条 issue，不中断其余校验项。
// [失败路径] 无重复时提前返回，保证合法载荷不会因判重产生多余 issue 而整体失败。
// [边界] 只认字符串完全相等，大小写不同视为不同 id，归一化责任留在上游。
function addDuplicateItemIssue(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (new Set(values).size === values.length) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message: "review item ids must be unique",
  });
}
