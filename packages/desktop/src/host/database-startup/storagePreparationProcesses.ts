// Host 存储准备的两条子进程路径。
//
// 职责：prepareHostStorage 在 worker_threads 中运行 tasksStorageWorker；prepareSessionStorage
// 以 Worker 方式运行同一 CLI bundle 的 --prepare-storage 入口，从而 Host 退出不会留下持锁孤儿。
// 输入输出：两条都输入 path/cwd、report、AbortSignal，输出 Promise<void>（成功即库可用）。
// 副作用：创建子进程 / Worker、写 stdin 协议帧、注册 abort 监听、超时 terminate。
// 失败语义：失败统一 reject 一个带 kind / errcode / code / migrationUpdate 的 Error；
// 30s 内无首个状态帧 → startup_status_timeout；协议帧非法 / 超长 / 进程异常 → transport_closed。
// 维护的不变量：首批状态帧必须清除超时定时器；abort 监听在 exit 时移除（once + remove），
// 保证同一 signal 可被后续步骤复用而不泄漏监听器。

import { realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { Worker } from "node:worker_threads";
import { createInterface } from "node:readline";
import {
  type DatabaseMigrationFacts,
  zcodeStoragePreparationFrameSchema,
  type DatabaseStartupState,
} from "@zcode/shared";
import { resolveDefaultZCodeAgentCommand } from "@zcode/services/storage-startup";

type Phase = NonNullable<DatabaseStartupState["databasePhase"]>;
import { workerMessageSchema } from "./contract.js";
// 构造带结构化字段的准备失败错误。
// kind 是稳定的失败分类（transport_closed / startup_status_timeout / sql_failed 等），
// sqliteCode / systemCode / migrationId 原样带给 coordinator 用于归类重试策略。
// migrationUpdate 只在同时有 databaseId 与 migration 时给出，避免半条迁移事实污染状态。
// 失败语义：本身不抛出，只返回 Error 实例。
const statusError = (
  kind: string,
  details?: {
    sqliteCode?: number;
    systemCode?: string;
    migrationId?: string;
    migration?: DatabaseMigrationFacts;
  },
  databaseId?: string,
) =>
  Object.assign(new Error(`Storage preparation failed: ${kind}`), {
    kind,
    errcode: details?.sqliteCode,
    code: details?.systemCode,
    migrationId: details?.migrationId,
    migrationUpdate:
      databaseId && details?.migration ? { databaseId, migration: details.migration } : undefined,
  });

// 在 Worker 中准备 tasks-index 库。
// 退出判定：done && code===0 && 无 failure && 收到过首个状态帧 才算成功；否则一律 reject，
// 防止 Worker 静默崩溃被当成成功导致后续服务连到不存在的库。
// 超时只覆盖「首个状态帧」：30s 未开始即视为卡死并 terminate，不限制整体迁移时长。
// 失败语义：signal abort → transport_closed 并 terminate；schema 校验失败 → transport_closed；
// failed 帧携带 errorCode 与 migration 事实。
export function prepareHostStorage(
  path: string,
  report: (phase: Phase, migration?: DatabaseMigrationFacts) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./tasksStorageWorker.js", import.meta.url), {
      workerData: { path },
    });
    let done = false;
    let failure: unknown;
    let firstState = false;
    const firstStateTimer = setTimeout(() => {
      failure = statusError("startup_status_timeout");
      void worker.terminate();
    }, 30_000);
    const abort = () => {
      failure = statusError("transport_closed");
      void worker.terminate();
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.on("message", (raw: unknown) => {
      const result = workerMessageSchema.safeParse(raw);
      if (!result.success) {
        failure = statusError("transport_closed");
        void worker.terminate();
        return;
      }
      firstState = true;
      clearTimeout(firstStateTimer);
      const message = result.data;
      if (message.type === "progress") report(message.phase, message.migration);
      else if (message.type === "done") done = true;
      else failure = statusError(message.errorCode, message, "tasks-index");
    });
    worker.once("error", (error) => {
      failure = error;
    });
    worker.once("exit", (code) => {
      clearTimeout(firstStateTimer);
      signal.removeEventListener("abort", abort);
      if (done && code === 0 && !failure && firstState) resolve();
      else reject(failure ?? statusError("transport_closed"));
    });
    if (signal.aborted) abort();
  });
}

// 通过 CLI bundle 的 --prepare-storage 入口准备会话库。
// 前置：resolveDefaultZCodeAgentCommand 必须声明 supportsStorageStartup 与入口，否则
// unsupported_runtime（旧运行时不支持该协议）。
// 协议：stdout 逐行 JSON 帧；startup/storagePath 需要回 storagePathReady，且只允许一次
//（pathReceived 防重复），storagePrepared 才允许 input.end()。
// reuse 判定：用 realpath 后的真实路径查 preparedPaths，命中则跳过 observePath——
// 同一物理库被不同 cwd 复用时不能重复采样基线。
// 失败语义：所有失败统一 reject；stderr 只 resume 排空不上报（可能含本地路径）。
/** 在 Host 所属 Worker 运行同一 CLI bundle 的存储入口；Host 退出不会留下持锁孤儿进程。 */
export async function prepareSessionStorage(options: {
  cwd: string;
  env?: Record<string, string>;
  signal: AbortSignal;
  report: (
    phase: Phase,
    details?: { databaseId: string; migration?: DatabaseMigrationFacts },
  ) => void;
  preparedPaths?: Set<string>;
  observePath: (path: string) => Promise<void>;
}): Promise<void> {
  const command = resolveDefaultZCodeAgentCommand({
    workspacePath: options.cwd,
    workspaceKey: options.cwd,
    presentationSurface: "desktop",
  });
  if (!command?.supportsStorageStartup || !command.storagePreparationEntry)
    throw statusError("unsupported_runtime");
  const entry = command.storagePreparationEntry;
  await new Promise<void>((resolve, reject) => {
    const child = new Worker(entry, {
      argv: ["app-server", "--stdio", "--prepare-storage", "--cwd", command.cwd ?? options.cwd],
      env: { ...process.env, ...options.env, ...command.env },
      stdin: true,
      stdout: true,
      stderr: true,
    });
    const input = child.stdin!;
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    let prepared = false;
    let pathReceived = false;
    let preparedPath: string | undefined;
    let failure: unknown;
    const terminate = () => {
      void child.terminate();
    };
    const abort = () => {
      failure ??= statusError("transport_closed");
      terminate();
    };
    const firstStateTimer = setTimeout(() => {
      failure = statusError("startup_status_timeout");
      terminate();
    }, 30_000);
    options.signal.addEventListener("abort", abort, { once: true });
    // stdout 只有有界控制帧，stderr 排空但不把可能含本地路径的原始文本上报。
    child.stderr.resume();
    input.on("error", (error) => {
      failure ??= error;
      terminate();
    });
    lines.on("line", (line) => {
      try {
        if (line.length > 65536) throw statusError("transport_closed");
        const frame = zcodeStoragePreparationFrameSchema.parse(JSON.parse(line));
        clearTimeout(firstStateTimer);
        if (frame.method === "startup/storagePath") {
          if (pathReceived) throw statusError("transport_closed");
          pathReceived = true;
          void (async () => {
            // 仅复用同一次准备中已成功关闭的真实库，不能按不同 cwd 误判为不同数据库。
            preparedPath = await realpath(frame.params.path).catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return resolvePath(frame.params.path);
                throw error;
              },
            );
            if (settled || failure || options.signal.aborted) return;
            const reuse = options.preparedPaths?.has(preparedPath) ?? false;
            if (!reuse) await options.observePath(frame.params.path);
            if (!settled && !failure && !options.signal.aborted)
              input.write(`${JSON.stringify({ method: "startup/storagePathReady", reuse })}\n`);
          })().catch((error) => {
            failure ??= error;
            terminate();
          });
        } else if (frame.method === "startup/storagePrepared") {
          prepared = pathReceived;
          input.end();
        } else if (frame.params.phase === "failed")
          failure ??= statusError(
            frame.params.errorCode ?? "sql_failed",
            frame.params,
            frame.params.databaseId,
          );
        else
          options.report(frame.params.phase, {
            databaseId: frame.params.databaseId,
            migration: frame.params.migration,
          });
      } catch (error) {
        failure ??= error;
        terminate();
      }
    });
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("exit", (code) => {
      settled = true;
      clearTimeout(firstStateTimer);
      options.signal.removeEventListener("abort", abort);
      lines.close();
      if (code === 0 && prepared && !failure) {
        if (preparedPath) options.preparedPaths?.add(preparedPath);
        resolve();
      } else reject(failure ?? statusError("transport_closed"));
    });
    if (options.signal.aborted) abort();
  });
}
