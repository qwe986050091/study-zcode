// 群任务（Bot 群控制）的路由 scope 绑定。
//
// 职责：把已经通过附件校验的 WindowHostAttachmentScope 落到任务入参上，使 Bot RPC 无法
// 自行声明一条不同的远程会话（防越权路由到别的 Source / workspace）。
// 输入输出：输入原始 params 与 attachment scope；local scope 原样返回，remote scope 补齐
// workspacePath / workspaceIdentity / remoteSessionId 三个路由字段。
// 副作用：无（纯函数，不修改入参，返回新对象）。
// 失败语义：source-settings 直接抛错——该 scope 没有 workspace/task 路由权限。

import type { WindowHostAttachmentScope } from "@zcode/shared";

// 绑定群任务路由：优先信任 attachment 的 scope，而不是 RPC 入参自带的字段。
// local 视为「当前窗口 = 当前 Host 工作区」，因此不覆盖 params；
// remote 则必须用 scope 中的三元组覆盖，避免调用方伪造 remoteSessionId 串到别的会话。
// 失败语义：source-settings 抛错（见文件头）。
/** 群控制复用已验证 attachment，不能由 RPC 调用方声明另一条远程会话。 */
export function bindBotGroupTaskScope<T extends object>(
  params: T,
  scope: WindowHostAttachmentScope,
): T {
  // Source settings 没有 workspace/task 权限，不能按 remote 分支读取不存在的路由字段。
  if (scope.kind === "source-settings") {
    throw new Error("Source settings attachment does not provide bot task routing");
  }
  return scope.kind === "local"
    ? params
    : {
        ...params,
        workspacePath: scope.workspacePath,
        workspaceIdentity: scope.workspaceIdentity,
        remoteSessionId: scope.remoteSessionId,
      };
}
