// 契约示例，不参与运行时装配；仅演示运行时实例的装配与 connect 查询。
// INV: 端口实现由调用方注入，示例自身不创建运行时、不缓存连接状态。
import type { BotProjectRuntimePort, BotRemoteTarget } from "#src/bot-project-runtime/contract.js";
import { createBotProjectRuntime } from "#src/bot-project-runtime/index.js";
export async function example(port: BotProjectRuntimePort, target: BotRemoteTarget) {
  return createBotProjectRuntime(port).isConnected(target);
}
