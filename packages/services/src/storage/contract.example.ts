// 契约用法示例，不参与运行时装配；仅演示扫描、订阅进度、离开取消与清理重扫的调用顺序。
// INV: 快照必须按当前 jobId 过滤，旧 job 的尾包一律丢弃。
// 改错后果：示例被误当实现接入时，离线尾包会覆盖新扫描进度，使占用展示回退。
import type { IStorageService, StorageUsageSnapshot } from "./contract.js";

/**
 * 契约用法示例：进入分区时订阅进度并开始扫描，离开时取消；清理后重新扫描。
 * 这是 UI hook 的最小骨架，不含任何实现细节。
 */
export async function useStorageSection(
  storage: IStorageService,
  render: (snapshot: StorageUsageSnapshot) => void,
): Promise<{ leave: () => Promise<void>; cleanTrajectories: () => Promise<void> }> {
  let currentJobId: string | null = null;
  const subscription = storage.onScanProgress((snapshot) => {
    // 只消费当前 job 的快照，旧 job 的尾包直接丢弃。
    if (snapshot.jobId === currentJobId) render(snapshot);
  });
  const start = async () => {
    currentJobId = (await storage.startScan()).jobId;
  };
  await start();
  return {
    leave: async () => {
      subscription.dispose();
      if (currentJobId) await storage.cancelScan(currentJobId);
    },
    cleanTrajectories: async () => {
      await storage.clean({ rootId: "home", categoryId: "modelTrajectory" });
      await start();
    },
  };
}
