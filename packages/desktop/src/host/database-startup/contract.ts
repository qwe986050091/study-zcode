// Host database startup Worker 的输入 / 输出消息合约。
//
// 职责：定义 tasksStorageWorkerDataSchema（Worker 启动参数）与 workerMessageSchema
//（progress / done / failed 三种回传），Host 与 Worker 共用同一份 Zod 校验，避免两端漂移。
// 输入输出：schema 只做 parse 校验，不承载业务写入；TasksStorageWorkerMessage 为推导类型。
// 副作用：无（纯 schema 声明）。
// 失败语义：parse 失败即抛 ZodError；failed 消息必须带 errorCode 与 error details。
// 维护的不变量：所有分支 .strict()——新增字段必须同时更新 schema 与使用方，
// 不允许 Worker 私下扩展字段（跨进程边界必须显式）。

import { z } from "zod";
import {
  databaseStartupErrorCodeSchema,
  databaseMigrationFactsSchema,
  databaseStartupErrorDetailsSchema,
} from "@zcode/shared";

// Worker 启动参数：只含 path（必须非空），其它配置由 Worker 自身从环境读取。
export const tasksStorageWorkerDataSchema = z.object({ path: z.string().min(1) }).strict();
// Worker 回传消息：discriminatedUnion 保证 type 与负载一一对应。
// progress 的 phase 枚举是顺序语义（checking → ready），失败分支携带 shared 中的错误码与详情，
export const workerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("progress"),
      migration: databaseMigrationFactsSchema.optional(),
      phase: z.enum([
        "checking",
        "waiting_for_lock",
        "migrating",
        "committing",
        "maintaining",
        "ready",
      ]),
    })
    .strict(),
  z.object({ type: z.literal("done") }).strict(),
  z
    .object({
      type: z.literal("failed"),
      errorCode: databaseStartupErrorCodeSchema,
      migration: databaseMigrationFactsSchema.optional(),
      ...databaseStartupErrorDetailsSchema.shape,
    })
    .strict(),
]);
export type TasksStorageWorkerMessage = z.infer<typeof workerMessageSchema>;
