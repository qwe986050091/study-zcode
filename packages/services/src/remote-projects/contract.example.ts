// 示例契约：演示 IRemoteProjectService 的最小刷新调用形态，不参与运行时装配。
// INV：示例文件不得被任何生产入口 import，装配图只允许引用真实实现。
// 改错后果：若被误接入装配，刷新入口会出现两份来源，排障时无法判定真实写入方。
import type { IRemoteProjectService, RemoteProjectCache } from "#src/remote-projects/contract.js";

export async function refreshAddedProject(
  service: IRemoteProjectService,
  entryId: string,
  read: () => Promise<RemoteProjectCache>,
): Promise<boolean> {
  const entry = (await service.readDirectory()).entries.find((item) => item.id === entryId);
  if (!entry) return false;
  const project = await read();
// 返回值表示远端条目是否刷新成功，调用方据此决定重试，不能吞掉 false。
  return service.refreshEntry({ entryId, expectedLastSyncedAt: entry.lastSyncedAt, project });
}
