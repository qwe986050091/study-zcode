// Host 启动期数据库准备编排。
//
// 职责：把「磁盘采样 → tasks-index 迁移 → 各 workspace 会话库迁移 → 服务初始化」串成一次
// 启动流程，进度通过 report 推到 DatabaseStartupCoordinator，最终由 coordinator 发布状态。
// 输入输出：输入 cwd / workingDirectories / env / publish / initializeServices / onFailure；
// 输出 { coordinator, dispose }，dispose 会 abort 进行中的子进程并停采样。
// 副作用：创建 Worker 子进程、写数据库、启动磁盘定时采样、调用 initializeServices、发布状态。
// 失败语义：任一阶段失败 → onFailure（自身抛错被吞）→ 重新抛出原错误，由 coordinator 记为
// failed；失败不会静默降级，宿主初始化必须显式失败。
// 维护的不变量：磁盘基线只在每个库首次准备前采一次并封存（sealBaseline），后续采样只更新
// 观测值；会话库按真实 cwd 去重，避免把 fallback 路径下的空库当成另一个库。

import {
  getTasksIndexDatabasePath,
  markTasksStoragePrepared,
  resolveZCodeAgentSpawnCwd,
} from "@zcode/services/storage-startup";
import type { DatabaseStartupState } from "@zcode/shared";
import { DatabaseStartupCoordinator } from "../databaseStartupCoordinator.js";
import { StartupDiskSampler } from "../startupDiskSampler.js";
import { prepareHostStorage, prepareSessionStorage } from "./storagePreparationProcesses.js";

const BASELINE_BUDGET_MS = 250;
// 创建启动编排器。
// 采用 AbortController 统一取消：dispose 与外部 signal 之外的生命周期都在此收口。
// prepare 内部按顺序完成三段：tasks-index（内部固定库）→ session 库（逐个 cwd）→ services。
// 失败语义：onFailure 只用于诊断，抛错被吞；原始错误继续向上抛出。
export function createHostDatabaseStartup(options: {
  startupId?: string;
  cwd: string;
  workingDirectories?: string[];
  env?: Record<string, string>;
  publish: (state: DatabaseStartupState) => void;
  initializeServices: () => Promise<void>;
  onFailure: (error: unknown) => void;
}) {
  const abort = new AbortController();
  let sampler: StartupDiskSampler | undefined;
  const coordinator = new DatabaseStartupCoordinator({
    startupId: options.startupId,
    publish: options.publish,
    prepare: async (report) => {
      const preparedPaths = new Set<string>();
      sampler = new StartupDiskSampler({ onSample: (disk) => coordinator.updateDisk(disk) });
      const currentSampler = sampler;
      // 采样单路径并封存基线：用 250ms 预算 race，慢盘 / 网络盘不会拖慢启动。
      // 无论探测是否完成都 sealBaseline：基线固定为首次观测，之后只累计跌幅，不漂移。
      // 失败语义：addPath 内部已消化探测异常，这里不额外 catch。
      const observePath = async (path: string) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            currentSampler.addPath(path),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, BASELINE_BUDGET_MS);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        currentSampler.sealBaseline(path);
        coordinator.updateDisk(currentSampler.snapshot());
      };
      try {
        report("preparing_host_storage", "checking");
        const tasksPath = getTasksIndexDatabasePath();
        await observePath(tasksPath);
        currentSampler.start();
        await prepareHostStorage(
          tasksPath,
          (phase, migration) =>
            report("preparing_host_storage", phase, { databaseId: "tasks-index", migration }),
          abort.signal,
        );
        markTasksStoragePrepared(tasksPath);
        report("preparing_session_storage", "checking");
        const candidates = options.workingDirectories?.length
          ? options.workingDirectories
          : [options.cwd];
        const directories = new Set<string>();
        for (const candidate of candidates) {
          // 历史项目 ENOTDIR/无权限不是数据库失败；与普通 Agent 使用同一 cwd 选择规则。
          const { cwd } = await resolveZCodeAgentSpawnCwd({
            requestedCwd: candidate,
            workspacePath: candidate,
            spawnFallbackCwd: options.cwd,
          });
          directories.add(cwd);
        }
        // 相对 sessionDbPath 按实际进程 cwd 解析；不能先准备 fallback 下的另一个空库。
        const pendingDirectories = [...directories];
        for (const [index, cwd] of pendingDirectories.entries())
          await prepareSessionStorage({
            cwd,
            env: options.env,
            signal: abort.signal,
            preparedPaths,
            report: (phase, details) =>
              report("preparing_session_storage", phase, {
                databaseId: details?.databaseId ?? "session",
                migration: details?.migration,
                finalDatabase: index === pendingDirectories.length - 1,
              }),
            observePath,
          });
        report("starting_services");
        await options.initializeServices();
      } catch (error) {
        try {
          options.onFailure(error);
        } catch {
          /* 诊断失败不覆盖原始错误。 */
        }
        throw error;
      } finally {
        currentSampler.stop();
        coordinator.updateDisk(currentSampler.snapshot());
      }
    },
  });
  return {
    coordinator,
    dispose: () => {
      abort.abort();
      sampler?.stop();
    },
  };
}
