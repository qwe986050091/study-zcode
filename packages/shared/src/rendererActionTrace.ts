// INV-01 采样上限为两成：守住位置 常量与 schema；改错故障 全量采集压垮主线程。
// INV-02 单批跨度上限三十二：守住位置 max；改错故障 大批次阻塞 IPC。
// INV-03 单批字节上限 256K：守住位置 常量；改错故障 序列化超时。
// INV-04 分组是封闭枚举：守住位置 group schema；改错故障 拼写错误的分组被放行。
// INV-05 配置 strict 且版本必填：守住位置 config schema；改错故障 无法判断配置是否更新。
// INV-06 关闭态配置固定：守住位置 常量；改错故障 关闭仍带非零采样比。
// INV-07 十六进制标识有定长：守住位置 两个正则；改错故障 非法 traceId 进入后端。
// INV-08 属性字段全部白名单：守住位置 attributes schema；改错故障 任意键被当维度上报。
// INV-09 属性值限长且去空白：守住位置 bounded 正则；改错故障 高基数文本撑爆聚合。
// INV-10 动作标识用 uuid：守住位置 action_id；改错故障 同一动作无法去重。
// INV-11 时间必须单调：守住位置 superRefine；改错故障 负时长跨度污染统计。
// INV-12 跨度名固定为 ui_action：守住位置 literal；改错故障 后端无法按名聚合。
// INV-13 资源名与服务名一致：守住位置 literal；改错故障 多端数据混在同一服务名下。
// INV-14 环境枚举三选一：守住位置 enum；改错故障 生产数据被标成测试。
// INV-15 批次序号非负整数：守住位置 sequence；改错故障 丢批检测失效。
// INV-16 丢弃计数单列：守住位置 droppedSinceLastFlush；改错故障 丢样本无法归因。
// INV-17 资源实例与批次一致：守住位置 superRefine；改错故障 跨实例样本被合并。
// INV-18 批次版本固定为一：守住位置 literal；改错故障 新旧协议无法区分。
//
// 模块职责：定义渲染进程动作追踪的配置、跨度与批次协议。
// 状态所有权：纯 schema 与常量；无运行时状态。
// 阅读顺序：先看常量与分组，再看属性与跨度，最后看批次交叉校验。
import { z } from "zod";

// 服务名由 resource schema 的 literal 固定，后端按它聚合，改名会导致历史数据分裂。
// 采样比上限与 schema 共用同一常量。
// 跨度数与字节数分别设限。
// 这些常量与采集端共用同一份取值，改动时必须两端同时发版。
export const RENDERER_ACTION_TRACE_SERVICE_NAME = "zcode-desktop-renderer";
export const RENDERER_ACTION_TRACE_MAX_SAMPLE_RATIO = 0.2;
export const RENDERER_ACTION_TRACE_MAX_BATCH_SPANS = 32;
export const RENDERER_ACTION_TRACE_MAX_BATCH_BYTES = 256 * 1024;

export const rendererActionTraceGroupSchema = z.enum([
  "core",
  "settings",
  "workbench",
  "extensions",
  "automation",
  "account",
]);
export type RendererActionTraceGroup = z.infer<typeof rendererActionTraceGroupSchema>;

// enabled 是必填布尔，缺失时 schema 直接拒绝整个配置对象。
// localTtftEnabled 标了 optional，旧配置不带该字段仍能通过校验。
// enabledGroups 用 .max(6)，与分组枚举的六项一一对应。
// configVersion 只要求非空且不超过 128 字符，用于识别配置是否换过。
export const rendererActionTraceConfigSchema = z
  .object({
    enabled: z.boolean(),
    localTtftEnabled: z.boolean().optional(),
    sampleRatio: z.number().finite().min(0).max(RENDERER_ACTION_TRACE_MAX_SAMPLE_RATIO),
    enabledGroups: z.array(rendererActionTraceGroupSchema).max(6),
    configVersion: z.string().trim().min(1).max(128),
  })
  .strict();
export type RendererActionTraceConfigV1 = z.infer<typeof rendererActionTraceConfigSchema>;

export const DISABLED_RENDERER_ACTION_TRACE_CONFIG: RendererActionTraceConfigV1 = {
  enabled: false,
  sampleRatio: 0,
  enabledGroups: [],
  configVersion: "disabled",
};

const hexTraceIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);
const hexSpanIdSchema = z.string().regex(/^[0-9a-f]{16}$/u);
const boundedIdentifierSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/u);
const boundedValueSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/u);

// feature_id、action、surface 三个字段都由 boundedIdentifierSchema 约束，字符集相同。
// result_source 与 failure_stage 都标了 optional，不参与必填校验。
// workspace_kind 与 remote_kind 分别描述本地/远程形态，远程才带子类型。
export const rendererActionTraceAttributesSchema = z
  .object({
    feature_id: boundedIdentifierSchema,
    action: boundedIdentifierSchema,
    catalog_group: rendererActionTraceGroupSchema,
    operation_kind: z.enum(["navigation", "preference", "command", "management", "destructive"]),
    surface: boundedIdentifierSchema,
    trigger: z.enum(["button", "keyboard", "shortcut", "menu", "switch", "select", "drag"]),
    outcome: z.enum(["completed", "failed", "rejected", "cancelled", "noop", "abandoned"]),
    result_source: z
      .enum([
        "local_commit",
        "shared_settings",
        "setting_service",
        "platform_result",
        "authority_ack",
        "optimistic_projection",
      ])
      .optional(),
    failure_stage: boundedIdentifierSchema.optional(),
    state_after: z.enum(["enabled", "disabled"]).optional(),
    configured: z.boolean().optional(),
    requires_restart: z.boolean().optional(),
    section_id: boundedIdentifierSchema.optional(),
    value_after: boundedValueSchema.optional(),
    workspace_kind: z.enum(["local", "remote"]).optional(),
    remote_kind: z.enum(["ssh", "wsl", "docker", "server"]).optional(),
    admission_result: z
      .enum(["accepted", "rejected", "stale", "duplicate", "noop", "not_applicable"])
      .optional(),
    automation_kind: z.enum(["scheduled", "off_peak"]).optional(),
    action_id: z.string().uuid(),
  })
  .strict();
export type RendererActionTraceAttributes = z.infer<typeof rendererActionTraceAttributesSchema>;

// traceId 由 32 位十六进制正则约束，spanId 则要求 16 位，两者都锚定首尾。
// name 固定为字面量 "ui_action"，后端按这个名字分组。
// startTimeUnixMs 与 endTimeUnixMs 都经过 nonnegative()，负数直接被拒。
export const rendererActionTraceSpanSchema = z
  .object({
    traceId: hexTraceIdSchema,
    spanId: hexSpanIdSchema,
    name: z.literal("ui_action"),
    startTimeUnixMs: z.number().finite().nonnegative(),
    endTimeUnixMs: z.number().finite().nonnegative(),
    status: z.enum(["unset", "ok", "error"]),
    attributes: rendererActionTraceAttributesSchema,
  })
  .strict()
  .superRefine((span, context) => {
    if (span.endTimeUnixMs < span.startTimeUnixMs) {
      context.addIssue({
        code: "custom",
        message: "endTimeUnixMs must be greater than or equal to startTimeUnixMs",
        path: ["endTimeUnixMs"],
      });
    }
  });
export type RendererActionTraceSpanV1 = z.infer<typeof rendererActionTraceSpanSchema>;

export const rendererActionTraceResourceSchema = z
  .object({
    serviceName: z.literal(RENDERER_ACTION_TRACE_SERVICE_NAME),
    serviceVersion: boundedIdentifierSchema,
    deploymentEnvironment: z.enum(["development", "test", "production"]),
    rendererInstanceId: boundedIdentifierSchema,
  })
  .strict();
export type RendererActionTraceResourceV1 = z.infer<typeof rendererActionTraceResourceSchema>;

// rendererInstanceId 在外层与 resource 里各出现一次，两处必须相等。
// spans 数组走 .max(RENDERER_ACTION_TRACE_MAX_BATCH_SPANS)，即 32 条。
// superRefine 比对两个 rendererInstanceId，不一致就 addIssue 到 resource。
export const rendererActionTraceBatchSchema = z
  .object({
    version: z.literal(1),
    rendererInstanceId: boundedIdentifierSchema,
    sequence: z.number().int().nonnegative(),
    droppedSinceLastFlush: z.number().int().nonnegative(),
    resource: rendererActionTraceResourceSchema,
    spans: z.array(rendererActionTraceSpanSchema).max(RENDERER_ACTION_TRACE_MAX_BATCH_SPANS),
  })
  .strict()
  .superRefine((batch, context) => {
    if (batch.resource.rendererInstanceId !== batch.rendererInstanceId) {
      context.addIssue({
        code: "custom",
        message: "rendererInstanceId must match the resource",
        path: ["resource", "rendererInstanceId"],
      });
    }
  });
export type RendererActionTraceBatchV1 = z.infer<typeof rendererActionTraceBatchSchema>;
