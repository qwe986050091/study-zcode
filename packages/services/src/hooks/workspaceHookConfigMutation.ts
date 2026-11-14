// 本文件仅作为 shared 实现的门面再导出，不新增业务分支或默认参数处理。
// INV: 导出名须与 @zcode/shared/workspace-hook-mutation 一一对应，改名会断开钩子配置写入链路。
export {
  atomicWriteWorkspaceHookConfig,
  writeWorkspaceHookConfiguredToggle,
  WorkspaceHookMutationError,
  type AtomicWorkspaceHookConfigWriteOptions,
} from "@zcode/shared/workspace-hook-mutation";
