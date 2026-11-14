import { basename, resolve } from "node:path";
import {
  createWorkspaceHookBundleSnapshot,
  type WorkspaceHookBundleSnapshot,
} from "@zcode/contracts";
import { digestSummary, workspaceIdentitySummary } from "@zcode/core";
import {
  buildWorkspaceHookBundleSnapshot,
  readWorkspaceHookProjectSources,
  type WorkspaceHookRuntimeRoot,
} from "@zcode/shared/workspace-hook-discovery";
import {
  WorkspaceHookMutationError,
  writeWorkspaceHookConfiguredToggle,
} from "@zcode/shared/workspace-hook-mutation";
import type { WorkspaceHookReviewMutationPort } from "./workspace-hook-review-controller.js";

/**
 * toggle 端口的装配输入：全部为路径 / 身份事实，不携带信任态。
 *
 * `workingDirectory` 只用于定位可编辑的 `.zcode/config.json`；`workspaceIdentity` 是快照的
 * 归属键（隔离用，不是路径）；`projectConfigPath` 可覆盖发现入口；`runtimeRoot` 决定运行时
 * hook 根，二者共同决定 rebuild 结果，因此必须与发起审核时同一口径。
 */
export interface WorkspaceHookReviewMutationPortOptions {
  workingDirectory: string;
  workspaceIdentity: string;
  projectConfigPath?: string;
  runtimeRoot: WorkspaceHookRuntimeRoot;
}

const workspaceMutationTails = new Map<string, Promise<void>>();

/**
 * 创建“审核后改开关”的写端口：每次 toggle 都串行（按可编辑 config 路径加进程内锁）。
 *
 * 顺序是契约：持锁 → 重建快照 → 先比 workspaceIdentity、再比 bundleDigest（任一不符抛专属
 * 错误）→ 写配置 → `onWriteCommitted()`（持久化已落地，控制方可据此推进状态）→ 再重建一次
 * 返回新快照。重建而不是本地打补丁，保证返回的是文件真实投影。
 * 失败语义：三种失败分开报（identity 变 / bundle 变 / 配置读不出），消息只带脱敏摘要或文件名，
 * 绝不把绝对路径送进 telemetry；原始错误保留在 cause 里走 debug 日志。
 * 进程内锁只防同一进程的并发 UI 动作，跨进程写入仍以文件系统为准。
 */
export function createWorkspaceHookReviewMutationPort(
  options: WorkspaceHookReviewMutationPortOptions,
): WorkspaceHookReviewMutationPort {
  const workingDirectory = resolve(options.workingDirectory);
  const editableConfigPath = resolve(workingDirectory, ".zcode", "config.json");
  const lockKey = editableConfigPath;

  return {
    toggle(input, onWriteCommitted) {
      return withWorkspaceMutationLock(lockKey, async () => {
        const current = await rebuildSnapshot(options);
        // 这三种失败必须区分：共用 workspace_hooks_snapshot_mismatch
        // 会让用户无法区分「换了 workspace」「配置真的变了」「配置读不出来」。
        if (current.workspaceIdentity !== input.snapshot.workspaceIdentity) {
          throw new WorkspaceHookMutationError(
            "workspace_hooks_snapshot_mismatch",
            // 消息会经 controller 进入 telemetry.errorMessage，故此处即脱敏：
            // identity 本身是绝对路径，禁止上报完整 workspace path。
            `Workspace Hook identity changed after review (expected ${workspaceIdentitySummary(
              input.snapshot.workspaceIdentity,
            )}, got ${workspaceIdentitySummary(current.workspaceIdentity)})`,
          );
        }
        if (current.bundleDigest !== input.snapshot.bundleDigest) {
          throw new WorkspaceHookMutationError(
            "workspace_hooks_bundle_changed",
            `Workspace Hook bundle changed after review (expected ${digestSummary(
              input.snapshot.bundleDigest,
            )}, got ${digestSummary(current.bundleDigest)})`,
          );
        }

        await writeWorkspaceHookConfiguredToggle({
          configPath: editableConfigPath,
          snapshot: current,
          reviewItemId: input.reviewItemId,
          enabled: input.enabled,
        });
        await onWriteCommitted();
        return rebuildSnapshot(options);
      });
    },
  };
}

async function rebuildSnapshot(
  options: WorkspaceHookReviewMutationPortOptions,
): Promise<WorkspaceHookBundleSnapshot> {
  const discovery = await readWorkspaceHookProjectSources({
    workingDirectory: options.workingDirectory,
    ...(options.projectConfigPath ? { explicitProjectConfigPath: options.projectConfigPath } : {}),
  });
  if (discovery.errors.length > 0) {
    // 只报文件名，不报绝对路径（「不记录 source path」）；
    // 完整路径与原始错误保留在 cause 里，走 logger 的 debug 通道而不进 telemetry。
    const failed = discovery.errors[0]?.path;
    throw new WorkspaceHookMutationError(
      "workspace_hooks_config_unreadable",
      `Workspace Hook config could not be read: ${failed ? basename(failed) : "unknown"}`,
      { cause: discovery.errors[0]?.error },
    );
  }
  const snapshot = buildWorkspaceHookBundleSnapshot({
    workspaceIdentity: options.workspaceIdentity,
    workspacePath: options.workingDirectory,
    sources: discovery.sources,
    runtimeRoot: options.runtimeRoot,
  });
  if (!snapshot) {
    throw new WorkspaceHookMutationError(
      "workspace_hooks_snapshot_mismatch",
      "Workspace Hook bundle no longer exists",
    );
  }
  return createWorkspaceHookBundleSnapshot(snapshot);
}

async function withWorkspaceMutationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  // 以“前一个操作完成”为链：排队者等 previous（吞掉前序失败），成功后自己放行下一个；
  // 队尾清理用 tail 身份比对，避免删掉后来者刚挂上的链。
  const previous = workspaceMutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  workspaceMutationTails.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (workspaceMutationTails.get(key) === tail) workspaceMutationTails.delete(key);
  }
}
