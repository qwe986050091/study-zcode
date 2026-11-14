import { isSea } from "node:sea";
import type { RuntimeInfo } from "@zcode/shared-types";

export { type RuntimeInfo };

// 汇总当前进程的运行时环境快照，供 prompt/诊断/支持信息使用。
// 每次调用都重新读取 process，不缓存：cwd 可能在运行期被切换，必须反映当下值。
// 纯读取，无 IO 副作用；字段均来自 Node 进程自身，不含用户密钥或环境变量。
export const getRuntimeInfo = (): RuntimeInfo => ({
  // CPU 架构，如 x64/arm64，用于选择二进制产物。
  arch: process.arch,
  // 进程当前工作目录（绝对路径），会话内可能随 cd 变化。
  cwd: process.cwd(),
  // 当前 Node 可执行文件绝对路径，SEA 打包时指向宿主程序。
  execPath: process.execPath,
  // Node 版本号，带 v 前缀，如 v20.x。
  node: process.version,
  // 运行平台标识，如 win32/darwin/linux。
  platform: process.platform,
  // 是否运行在 Node 单可执行应用（SEA）中，影响资源解包路径。
  sea: isSea(),
  // Node 与依赖的版本集合（process.versions 原样暴露）。
  versions: process.versions,
});
