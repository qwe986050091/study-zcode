/**
 * Trust store 文件 schema 已下沉到 `@zcode/shared/workspace-hook-trust-store-file`
 * 作为单一权威实现（services 层无法依赖 apps 下的 contracts，
 * 只好手写局部校验，导致 UI 与 runtime 对同一损坏文件结论分裂）。
 *
 * 此处 re-export 保持 contracts 既有 import 路径（adapters/bootstrap/core 等）
 * 不变；shared 与 contracts 分属 zod4 / zod3 实例，本 re-export 不得被
 * contracts 内部的 zod3 schema 组合引用。
 *
 * 【边界】trust store 文件的权威 schema 与读写实现归 shared/services；本文件
 * 只负责"契约门面"：转出记录/文件类型，并定义 runtime 自己的 policy 形态。
 * 跨进程不变量：store 文件是持久授权事实，写入必须整体替换（不是合并），
 * 损坏时读侧 fail closed 到 pending/blocked，绝不能把解析失败当成空 store。
 * 【禁止】不要在本文件用 zod3 重新实现 trust store schema，否则 UI 与 runtime
 * 会对同一损坏文件得出不同结论（这正是下沉 shared 的根因）。
 */
export {
  WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
  workspaceHookTrustRecordSchema,
  workspaceHookTrustStoreFileSchema,
} from "@zcode/shared/workspace-hook-trust-store-file";
export type {
  WorkspaceHookTrustRecord,
  WorkspaceHookTrustStoreFile,
} from "@zcode/shared/workspace-hook-trust-store-file";

import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);

/**
 * runtime 侧的工作区 hook 策略裁决（deny / user_decides / allow_trusted_only）。
 *
 * 生产者在解析项目/用户配置后构造；消费者是 trust evaluator 与 admission。
 * 不变量：deny 是无条件硬阻断，不能被审查或持久信任放宽；user_decides 只是
 * 把决定权交给交互式审查，本身不等于允许；allow_trusted_only 仍要求摘要匹配。
 * policyRevision 用于 CAS——配置变更后旧裁决必须失效，不能被缓存覆盖。
 */
export const workspaceHookPolicySchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("deny"),
      reason: nonEmptyStringSchema,
      policyRevision: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("user_decides"),
      policyRevision: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("allow_trusted_only"),
      reason: nonEmptyStringSchema.optional(),
      policyRevision: nonEmptyStringSchema,
    })
    .strict(),
]);
export type WorkspaceHookPolicy = z.infer<typeof workspaceHookPolicySchema>;
