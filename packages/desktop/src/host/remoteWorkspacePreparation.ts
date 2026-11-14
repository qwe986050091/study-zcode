// 远程 workspace 可用性校验与身份绑定。
//
// 职责：用远端 fileService.readdir 验证 workspace 目录真实可读可遍历，再回调绑定稳定身份；
// 不依赖本地文件系统或控制端路径规则。
// 输入输出：输入 fileService（只需 readdir）、workspacePath / stableWorkspaceIdentity /
// legacyRouteHint / signal，以及可选 bindWorkspaceIdentity；输出 Promise<void>（成功即身份已绑定）。
// 副作用：一次远端 readdir；bindWorkspaceIdentity 可能写远端身份映射。
// 失败语义：ENOENT / ENOTDIR / EACCES / EPERM / ELOOP 统一转成
// REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE（retryable=false）；网络/协议错误原样抛出；
// 每个 await 前后检查 abort，取消优先于其它错误上报。
// 维护的不变量：必须保留末尾 `/.`，让远端同时校验目录遍历权限（stat 成功不代表可读）。

import type { IFileService } from "@zcode/services";
import { REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE } from "@zcode/shared";

interface RemoteWorkspaceIdentityInput {
  workspacePath: string;
  stableWorkspaceIdentity: string;
  legacyRouteHint?: string;
  signal?: AbortSignal;
}

// 校验远端目录并绑定身份。
// 三类注入错误码合并为不可用：目录不存在 / 不是目录 / 无读权限 / 无遍历权限 / 符号链接循环。
// ELOOP 归入不可用是刻意的：若透传会跳过 Renderer 的 Host ready 通知，同一 Source 的其他
// 项目会永久卡在恢复流程。
// 失败语义：上述错误码抛 unavailable；其他错误（网络/协议）保持原语义；abort 优先。
export async function prepareRemoteWorkspaceIdentity(
  fileService: Pick<IFileService, "readdir">,
  input: RemoteWorkspaceIdentityInput,
  bindWorkspaceIdentity?: (input: RemoteWorkspaceIdentityInput) => Promise<void>,
): Promise<void> {
  input.signal?.throwIfAborted();
  const unavailable = () =>
    Object.assign(
      new Error(
        `Remote workspace directory is missing, is not a directory, or cannot be accessed: ${input.workspacePath}`,
      ),
      { code: REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE, retryable: false },
    );
  // 叶目录收回权限后 stat 仍会成功，身份映射也保存在目录之外，不能据此放行。
  // 复用远端 readdir 验证读取权限；保留末尾 /. 让远端同时检查目标目录的遍历权限。
  // 不用 path.join 归一化掉 /.，也不使用控制端的平台路径规则或本地文件系统。
  try {
    await fileService.readdir({ path: `${input.workspacePath}/.` });
  } catch (error) {
    input.signal?.throwIfAborted();
    // 符号链接循环也属于目录不可用；透传 ELOOP 会跳过 Renderer 的 Host ready 通知，
    // 导致同一 Source 的其他项目无法继续恢复。
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))
    ) {
      throw unavailable();
    }
    // 网络/协议错误保持原语义，不能据此判断远端目录已被删除。
    throw error;
  }
  input.signal?.throwIfAborted();
  await bindWorkspaceIdentity?.(input);
  input.signal?.throwIfAborted();
}
