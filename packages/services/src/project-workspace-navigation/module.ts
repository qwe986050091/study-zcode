// Window Host 项目目录导航的模块描述符：只登记依赖与公开入口，不保存导航状态或目录树；INV: requires 必须与 architecture-policy 声明的依赖方向逐项一致，多写会掩盖越权导入、漏写会让架构检查与真实调用图分叉，导航请求最终被路由到未授权的 project 域。
/** Window Host 项目目录导航；依赖须与 architecture-policy 一致。 */
export const projectWorkspaceNavigationModule = {
  id: "project-workspace-navigation",
  requires: ["project", "project-catalog", "remote-projects", "shared"],
  provides: ["project-workspace-navigation"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
