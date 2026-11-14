// tasks-index 存储准备的 Worker 入口（运行在 worker_threads 中）。
//
// 职责：校验 workerData.path 后调用 prepareTasksIndexStorage，把进度以 progress 帧、结果以
// done / failed 帧回传给 Host；这是 Host 与 Worker 之间唯一的协议面。
// 输入输出：输入 { path }；输出 progress / done / failed 消息（schema 见 contract.ts）。
// 副作用：打开并迁移 sqlite 库、读取旧设置参与项目迁移、向 parentPort 发消息。
// 失败语义：任何异常都转成 failed 帧（classifyDatabaseStartupError + error details），
// 绝不向外抛；finally 关闭 parentPort，避免 Worker 泄漏端口。
// 维护的不变量：必须携带旧设置完成项目迁移，否则 Host 只能看到已记账的空项目种子；
// workerData 不合法时 parse 直接抛，Worker 立即失败（不会进入迁移）。

import { parentPort, workerData } from "node:worker_threads";
import { tasksStorageWorkerDataSchema } from "./contract.js";
import { prepareTasksIndexStorage, createSettingService } from "@zcode/services/storage-startup";
import {
  classifyDatabaseStartupError,
  databaseStartupErrorDetails,
  databaseMigrationFactsSchema,
} from "@zcode/shared";

const data = tasksStorageWorkerDataSchema.parse(workerData);
try {
  // Worker 必须携带旧设置完成项目迁移，否则后续 Host 只能看到已记账的空项目种子。
  const settings = await createSettingService().get();
  await prepareTasksIndexStorage(
    data.path,
    (phase, migration) => parentPort?.postMessage({ type: "progress", phase, migration }),
    settings,
  );
  parentPort?.postMessage({ type: "done" });
} catch (error) {
  const migration = databaseMigrationFactsSchema.safeParse(
    error && typeof error === "object"
      ? (error as { startupMigration?: unknown }).startupMigration
      : undefined,
  );
  parentPort?.postMessage({
    type: "failed",
    migration: migration.success ? migration.data : undefined,
    errorCode: classifyDatabaseStartupError(error),
    ...databaseStartupErrorDetails(error),
  });
} finally {
  parentPort?.close();
}
