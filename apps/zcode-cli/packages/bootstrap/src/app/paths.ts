// ============================================================
// CLI 存储目录与项目身份的路径口径
// ============================================================
// create-app 在打开会话存储、插件缓存、模型 IO 日志与项目记忆之前调用这些推导函数。
// 全部是纯路径运算：不创建目录、不读盘；真正的 mkdir 由各存储实现负责。
// 身份口径遵循 workspaceKey = workspaceIdentity?.trim() || workspacePath 的统一规则。

import { basename, join } from "node:path";
import { createProjectId, type ProjectId } from "@zcode/contracts";
import { resolveProjectMemoryRoot } from "@zcode/core";

/**
 * CLI 专用存储根。传入的根目录本身已名为 `cli` 时原样返回（幂等），否则在其下追加 `cli`。
 *
 * 幂等是为了让「已经指向 <data>/cli 的调用方」与「指向 <data> 的调用方」得到同一结果，
 * 避免出现 `<data>/cli/cli` 这类分裂目录。
 */
export function getCliStorageRoot(storageRoot: string): string {
  return basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli");
}

/** 插件缓存根：固定位于 CLI 存储根的 `plugins` 下，与用户级插件安装目录并列。 */
export function getPluginStorageRoot(cliStorageRoot: string): string {
  return join(cliStorageRoot, "plugins");
}

/**
 * 模型请求/响应落盘目录：开发版写 `debug`，生产写 `rollout`。
 *
 * 两目录分开是为了让开发期的高频诊断数据不混进生产回放数据；调用方据 isDevelopment 决定。
 */
export function getModelIoDir(cliStorageRoot: string, isDevelopment: boolean): string {
  return join(cliStorageRoot, isDevelopment ? "debug" : "rollout");
}

/**
 * 项目记忆根。转发给 core 的 resolveProjectMemoryRoot，由它执行与别处一致的
 * workspaceIdentity 优先、workspacePath 兜底的判据；本文件不重复实现。
 */
export function getProjectMemoryRoot(
  cliStorageRoot: string,
  workingDirectory: string,
  workspaceIdentity?: string,
): string {
  return resolveProjectMemoryRoot({
    cliStorageRoot,
    workspaceIdentity,
    workspacePath: workingDirectory,
  });
}

/**
 * 由目录路径派生稳定的 ProjectId：小写、非 `[a-z0-9._-]` 字符压成单个 `-`、去首尾连字符、
 * 截到 80 字符；全部被清空时用 `default`。
 *
 * 只用于身份与索引键，不参与文件执行；同一目录在不同平台大小写规则下仍得到同一个 id。
 */
export function projectIdFromDirectory(directory: string): ProjectId {
  return createProjectId(
    directory
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      // 80 是路径可读性与键长度的折中；空串（如根目录或全符号路径）必须有值。
      .slice(0, 80) || "default",
  );
}
