// 窗口级项目目录变化的转发适配层：只把广播层的 state:projects 消息转成目录变更通知。
// INV: 仅做单向订阅转发，不读写项目数据、不扩大广播通道权限。
// 改错后果：宽化频道匹配或在此写入状态，会让窗口收到非目录事件，并与 Host 状态形成双写分叉。
import type { IBroadcastService } from "#src/broadcast/broadcast.js";
import type { IWindowProjectChangesService } from "#src/window-project-directory/contract.js";

export function createWindowProjectChangesService(
  broadcast: Pick<IBroadcastService, "onMessage">,
): IWindowProjectChangesService {
  return {
    getCapabilities: async () => ({ version: 1 }),
    // 远端 scope 曾消费 Source 的项目广播。这里只转发窗口目录变化，不扩大广播读写权限。
    onDidChange: (listener) =>
      broadcast.onMessage((event) => {
        if (event.channel === "state:projects") listener();
      }),
  };
}
