import { z } from "zod";

/**
 * 工作区 hook 信任/准入契约的公共常量。
 *
 * DIGEST_SCHEMA_VERSION 固化 bundle 摘要的算法版本：快照落盘时写入，恢复时
 * 只认同版本，升级摘要算法必须换版本而不是原地重算（旧记录会被判 stale）。
 * REVIEW_TIMEOUT_MS 是 hook 审查交互的硬超时：超时后审查流进入 timed_out，
 * 由调用方 fail closed，不得把"用户没回答"当成允许。
 */
export const WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_HOOK_REVIEW_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 配置文件中 hooks 段允许出现字段的白名单，按配置层级分组。
 *
 * 生产者在读取工作区配置时用它做"未知字段"判定；消费者是信任审查与
 * config_unreadable/unknown_execution_field 错误分支。该表是安全边界：
 * 出现在 hooks 段却不在白名单里的执行字段必须拒绝（fail closed），
 * 不能忽略后继续运行，否则新增字段可能在未经审查的情况下拿到执行权。
 */
export const WORKSPACE_HOOK_SCHEMA_FIELDS = {
  root: ["enabled", "timeoutMs", "maxOutputBytes", "events"],
  matcher: ["matcher", "hooks"],
  events: [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
  ],
  process: ["type", "command", "enabled", "args", "timeoutMs", "statusMessage"],
  command: [
    "type",
    "command",
    "enabled",
    "async",
    "shell",
    "timeout",
    "timeoutMs",
    "statusMessage",
  ],
} as const;

/**
 * 工作区 hook 的信任结论词表（持久事实的枚举）。
 *
 * 生产者是 trust evaluator（读配置声明 + 持久 trust store 后给出结论）；
 * 消费者是 runtime admission、UI 审查卡与冷恢复。跨进程语义：
 * trusted_persistent 表示摘要匹配且用户曾持久授权；stale_digest 表示
 * 声明内容变了、旧授权失效；revoked 是用户主动撤销，三者都不可当"已信任"。
 */
export const WorkspaceHookTrustState = {
  NotApplicable: "not_applicable",
  PendingTrust: "pending_trust",
  TrustedPersistent: "trusted_persistent",
  BlockedUntrusted: "blocked_untrusted",
  BlockedPolicy: "blocked_policy",
  Revoked: "revoked",
  StaleDigest: "stale_digest",
} as const;
export type WorkspaceHookTrustState =
  (typeof WorkspaceHookTrustState)[keyof typeof WorkspaceHookTrustState];

export const workspaceHookTrustStateSchema = z.enum([
  "not_applicable",
  "pending_trust",
  "trusted_persistent",
  "blocked_untrusted",
  "blocked_policy",
  "revoked",
  "stale_digest",
]);

/**
 * 运行时准入分类：把七态信任结论收敛成执行器可直接消费的四类。
 *
 * 生产者是 WORKSPACE_HOOK_STATE_ADMISSION_MAP（状态 → 分类的唯一映射）；
 * 消费者是 core 的 hook runner，它只判断 admitted/pending/blocked，
 * 不再自行解释 trustState。pending 不是允许：它表示"等审查"，执行必须挂起。
 */
export const workspaceHookAdmissionClassSchema = z.enum([
  "not_applicable",
  "admitted",
  "pending",
  "blocked",
]);
export type WorkspaceHookAdmissionClass = z.infer<typeof workspaceHookAdmissionClassSchema>;

/**
 * 拒绝/待审原因的稳定码表，跨进程与 UI 都靠它分支，不能依赖文案。
 *
 * config_unreadable 与 config_write_failed 必须分开：读取失败被误报成写入
 * 失败会让用户重试错误的方向（这条由历史 bug 固化下来）。新增码只能追加，
 * 旧客户端遇到未知码应视为 blocked 而不是放行。
 */
export const workspaceHookReasonCodeSchema = z.enum([
  "workspace_hooks_no_enabled_hooks",
  "workspace_hooks_not_applicable",
  "workspace_hooks_pending_trust",
  "workspace_hooks_trusted_persistent",
  "workspace_hooks_blocked_untrusted",
  "workspace_hooks_blocked_by_policy",
  "workspace_hooks_policy_requires_pretrust",
  "workspace_hook_declaration_changed",
  "workspace_hooks_bundle_changed",
  "workspace_hooks_require_trust_capable_host",
  "workspace_hooks_interaction_timeout",
  "workspace_hooks_trust_store_corrupt",
  "workspace_hooks_snapshot_mismatch",
  "workspace_hooks_review_superseded",
  "workspace_hooks_config_write_failed",
  // 读取失败与写入失败必须可区分：config_write_failed 曾被 mutation 在
  // readFile/JSON.parse 失败时抛出，误导用户重试「写入」。
  "workspace_hooks_config_unreadable",
  "workspace_hooks_config_rebuild_failed",
  "workspace_hooks_revoked",
  "workspace_hooks_unknown_execution_field",
  "workspace_hooks_feature_disabled",
]);
export type WorkspaceHookReasonCode = z.infer<typeof workspaceHookReasonCodeSchema>;

/**
 * 信任态 → (准入分类, 是否可执行, 原因码) 的唯一映射表。
 *
 * 它固化的是"安全默认值"：只有 trusted_persistent 允许执行，且要求配置本身
 * 处于 enabled；pending/revoked/stale 全部不可执行。消费者是 effective state
 * schema 的 superRefine（校验字段组合一致）与 runtime admission。
 * 修改时必须同步 WorkspaceHookTrustState 的闭集，漏一个状态会让 schema 校验
 * 在运行时抛错而不是静默降级。
 */
export const WORKSPACE_HOOK_STATE_ADMISSION_MAP = {
  not_applicable: {
    admissionClass: "not_applicable",
    effectiveRunnable: false,
    reasonCode: "workspace_hooks_not_applicable",
  },
  pending_trust: {
    admissionClass: "pending",
    effectiveRunnable: false,
    reasonCode: "workspace_hooks_pending_trust",
  },
  trusted_persistent: {
    admissionClass: "admitted",
    effectiveRunnable: "configured",
    reasonCode: "workspace_hooks_trusted_persistent",
  },
  blocked_untrusted: {
    admissionClass: "blocked",
    effectiveRunnable: false,
    reasonCode: "workspace_hooks_blocked_untrusted",
  },
  blocked_policy: {
    admissionClass: "blocked",
    effectiveRunnable: false,
    reasonCode: "workspace_hooks_blocked_by_policy",
  },
  revoked: {
    admissionClass: "pending",
    effectiveRunnable: false,
    reasonCode: "workspace_hooks_revoked",
  },
  stale_digest: {
    admissionClass: "pending",
    effectiveRunnable: false,
    reasonCode: "workspace_hook_declaration_changed",
  },
} as const satisfies Record<
  WorkspaceHookTrustState,
  {
    admissionClass: WorkspaceHookAdmissionClass;
    effectiveRunnable: false | "configured";
    reasonCode: WorkspaceHookReasonCode;
  }
>;

const nonEmptyStringSchema = z.string().trim().min(1);
const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const positiveIntegerSchema = z.number().int().positive();
const nonnegativeIntegerSchema = z.number().int().nonnegative();

/**
 * 单个 hook bundle 的"有效状态"快照，供 UI 审查卡与 runtime 判断共用。
 *
 * 字段口径：sourceRootEnabled / declarationEnabled / runtimeHooksEnabled /
 * configuredEnabled 分别是配置各层的开关事实（不是推导值）；editable 表示
 * 当前配置来源是否允许 UI 改写；bundleDigest 与 hookDeclarationDigest 是
 * 审查授权绑定的内容指纹，恢复时摘要不匹配即 stale_digest。
 * superRefine 强制 admissionClass/reasonCode/effectiveRunnable 与 trustState
 * 一致，防止生产方拼出"pending 但可执行"这种自相矛盾的状态。
 */
export const workspaceHookEffectiveStateSchema = z
  .object({
    reviewItemId: nonEmptyStringSchema,
    sourceRootEnabled: z.boolean(),
    declarationEnabled: z.boolean(),
    runtimeHooksEnabled: z.boolean(),
    configuredEnabled: z.boolean(),
    editable: z.boolean(),
    trustState: workspaceHookTrustStateSchema,
    admissionClass: workspaceHookAdmissionClassSchema,
    effectiveRunnable: z.boolean(),
    workspaceIdentity: nonEmptyStringSchema.optional(),
    bundleDigest: sha256DigestSchema.optional(),
    hookDeclarationDigest: sha256DigestSchema.optional(),
    sourcePaths: z.array(nonEmptyStringSchema),
    reasonCode: workspaceHookReasonCodeSchema.optional(),
  })
  .strict()
  .superRefine((state, context) => {
    const expected = WORKSPACE_HOOK_STATE_ADMISSION_MAP[state.trustState];
    if (state.admissionClass !== expected.admissionClass) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["admissionClass"],
        message: `admissionClass must be ${expected.admissionClass} for ${state.trustState}`,
      });
    }
    if (state.reasonCode !== undefined && state.reasonCode !== expected.reasonCode) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasonCode"],
        message: `reasonCode must be ${expected.reasonCode} for ${state.trustState}`,
      });
    }
    if (expected.effectiveRunnable === false && state.effectiveRunnable) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effectiveRunnable"],
        message: `${state.trustState} cannot be runnable`,
      });
    }
    if (!state.configuredEnabled && state.effectiveRunnable) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effectiveRunnable"],
        message: "a configured-disabled hook cannot be runnable",
      });
    }
  });
export type WorkspaceHookEffectiveState = z.infer<typeof workspaceHookEffectiveStateSchema>;

/**
 * hook 可订阅的事件名闭集，与 hook runner 的分发点一一对应。
 *
 * 未知事件名在配置校验阶段即拒绝；运行时不接受"未来事件"的字符串，
 * 否则一个拼写错误会变成静默不执行。新增事件必须同时改这里、schema 白名单
 * 和 runner 的分发逻辑，三者缺一不可。
 */
export const workspaceHookEventNameSchema = z.enum([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
]);

const canonicalEntryBaseShape = {
  reviewItemId: nonEmptyStringSchema,
  event: workspaceHookEventNameSchema,
  matcherIndex: nonnegativeIntegerSchema,
  hookIndex: nonnegativeIntegerSchema,
  sourceFileIndex: nonnegativeIntegerSchema,
  sourceRelativePath: nonEmptyStringSchema,
  matcher: z.string().nullable(),
  command: nonEmptyStringSchema,
  resolvedTimeoutMs: positiveIntegerSchema,
  resolvedMaxOutputBytes: positiveIntegerSchema,
  statusMessage: nonEmptyStringSchema.optional(),
  sourceRootEnabled: z.boolean(),
  declarationEnabled: z.boolean(),
  runtimeHooksEnabled: z.boolean(),
  configuredEnabled: z.boolean(),
  editable: z.boolean(),
  declarationDigestAlgorithm: z.literal("sha256"),
  hookDeclarationDigest: sha256DigestSchema,
} as const;

/**
 * 归一化后的单条 hook 执行项（审查/授权与实际执行都以它为准）。
 *
 * 生产者是配置发现与归一化逻辑：把多层配置展开成扁平的 (event, matcherIndex,
 * hookIndex, sourceFileIndex) 坐标，并记录来源文件与解析后的超时/输出上限。
 * 消费者是审查卡、摘要计算与 runner。hookDeclarationDigest 是"这条声明"的
 * 内容指纹，用户授权绑定它；同一坐标内容变化即需要重新审查。
 */
export const canonicalWorkspaceHookEntrySchema = z.discriminatedUnion("type", [
  z
    .object({
      ...canonicalEntryBaseShape,
      type: z.literal("command"),
      async: z.boolean().optional(),
      shell: z.union([z.literal(true), nonEmptyStringSchema]).optional(),
    })
    .strict(),
  z
    .object({
      ...canonicalEntryBaseShape,
      type: z.literal("process"),
      args: z.array(z.string()).optional(),
    })
    .strict(),
]);
export type CanonicalWorkspaceHookEntry = z.infer<typeof canonicalWorkspaceHookEntrySchema>;

/**
 * 工作区 hook 的完整内容快照，是"用户审查了什么"的持久事实。
 *
 * 生产者是 bundle 发现器（按 workspaceIdentity 扫描配置文件并归一化）；
 * 消费者是 trust store 的摘要比对与冷恢复。不变量：bundleDigest 覆盖
 * sourceFiles + hooks + 版本；恢复时重算摘要必须与落盘值一致，否则整包
 * 判 stale_digest，不能只对变化的单条 hook 做局部放行。
 */
export const workspaceHookBundleSnapshotSchema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION),
    workspaceIdentity: nonEmptyStringSchema,
    discoveredAt: z.string().datetime(),
    sourceFiles: z.array(
      z
        .object({
          canonicalPath: nonEmptyStringSchema,
          baseDir: nonEmptyStringSchema,
          discoveryOrder: nonnegativeIntegerSchema,
          configFileKind: z.enum(["zcode.json", ".zcode/config.json", "explicit"]),
          explicitProjectConfig: z.boolean(),
          editable: z.boolean(),
          hooksRoot: z
            .object({
              enabled: z.boolean().optional(),
              timeoutMs: z.number().finite().positive().optional(),
              maxOutputBytes: z.number().finite().positive().optional(),
            })
            .strict(),
        })
        .strict(),
    ),
    hooks: z.array(canonicalWorkspaceHookEntrySchema),
    digestAlgorithm: z.literal("sha256"),
    bundleDigest: sha256DigestSchema,
  })
  .strict();
export type WorkspaceHookBundleSnapshot = Readonly<
  z.infer<typeof workspaceHookBundleSnapshotSchema>
>;

/**
 * 解析并深冻结一份 bundle 快照。
 *
 * 校验失败直接抛出（不吞错）：调用方据此判 config_unreadable 并 fail closed。
 * 深冻结是因为快照会被多个消费者共享（审查、摘要、运行），任何一处原地修改
 * 都会让另一处看到未审查的内容；冻结让越权写入在开发期就暴露。
 */
export function createWorkspaceHookBundleSnapshot(value: unknown): WorkspaceHookBundleSnapshot {
  return deepFreeze(workspaceHookBundleSnapshotSchema.parse(value)) as WorkspaceHookBundleSnapshot;
}

/**
 * 一次 hook 审查交互的状态机记录。
 *
 * 生产者是审查协调器（每次请求信任时创建，带 generation 与 deadline）；
 * 消费者是 UI 审查卡、超时回收与 supersede 判定。superseded 必须带
 * supersededByInteractionId，且只有 superseded 能带它：保证"旧审查被谁替代"
 * 可追溯，避免两个审查并发写同一 trust store 时结论互相覆盖。
 */
export const workspaceHookReviewFlowStateSchema = z
  .object({
    reviewFlowId: nonEmptyStringSchema,
    generation: positiveIntegerSchema,
    interactionId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema,
    bundleDigest: sha256DigestSchema,
    state: z.enum(["pending", "resolved", "superseded", "cancelled", "timed_out"]),
    supersededByInteractionId: nonEmptyStringSchema.optional(),
    createdAt: nonnegativeIntegerSchema,
    deadlineAt: nonnegativeIntegerSchema,
  })
  .strict()
  .superRefine((flow, context) => {
    if (flow.deadlineAt < flow.createdAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deadlineAt"],
        message: "deadlineAt must not precede createdAt",
      });
    }
    if (flow.state === "superseded" && !flow.supersededByInteractionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supersededByInteractionId"],
        message: "superseded flow requires its replacement interaction id",
      });
    }
    if (flow.state !== "superseded" && flow.supersededByInteractionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supersededByInteractionId"],
        message: "only a superseded flow may reference a replacement interaction",
      });
    }
  });
export type WorkspaceHookReviewFlowState = z.infer<typeof workspaceHookReviewFlowStateSchema>;

/**
 * 安全事实的单调修订号：coordinatorEpoch + counter。
 *
 * 生产者在每次 trust/policy 变更时递增；消费者用它做 CAS 与 stale 判定。
 * epoch 标识协调器实例（重启换 epoch），counter 在同一实例内单调；
 * 两者组合后旧实例的迟到写入不会覆盖新结论——这是跨进程并发下
 * "授权只能前进、不能被旧消息回滚"的关键。
 */
export const workspaceHookSecurityRevisionSchema = z
  .object({ coordinatorEpoch: nonEmptyStringSchema, counter: nonnegativeIntegerSchema })
  .strict();
export type WorkspaceHookSecurityRevision = z.infer<typeof workspaceHookSecurityRevisionSchema>;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
