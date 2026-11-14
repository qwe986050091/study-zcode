// 示例契约：仅演示 WindowProjectDirectoryServices 的调用形态，不参与运行时装配。
// INV：本文件只做类型层演示，不得被任何生产模块 import，也不得注册进服务容器。
// 误把它引入装配链会凭空拉起目录与远端服务依赖，启动期即出现空实现调用崩溃。
import type { WindowProjectDirectoryServices } from "#src/window-project-directory/contract.js";

export async function windowProjectDirectoryExample(directory: WindowProjectDirectoryServices) {
  await directory.changesService.getCapabilities();
  return Promise.all([
    directory.projectService.readTree({ includeDeleted: true }),
    directory.remoteProjectService.readDirectory(),
  ]);
}
