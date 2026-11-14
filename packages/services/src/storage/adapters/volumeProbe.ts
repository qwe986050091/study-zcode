/**
 * 卷探测：用 stat().dev 识别物理卷，向上遍历找到挂载点，再 statfs 取容量。
 * 任何一步失败都返回 null（UI 只展示占用、不展示容量），不抛错。
 */
// 卷探测：以 stat().dev 判定是否同一物理卷，向上回溯到挂载点后用 statfs 读取容量。
// 边界：权限不足、路径消失或不支持 statfs 的平台一律返回 null，绝不向调用方抛错。
// 改错风险：误判挂载点会把整块磁盘容量算给该目录，用户会据此误判占用并误删数据。
import { stat, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import type { StorageVolume } from "@zcode/shared";
import type { VolumeProbePort } from "../app/ports.js";

// 不做跨调用缓存：同一路径的挂载关系可能变化，缓存会让容量信息长期失真。
// 失败返回 null 而不是 0 容量，前端据此隐藏容量条，避免出现「总容量 0」的误导展示。
export async function probeStorageVolume(path: string): Promise<StorageVolume | null> {
  try {
    // 起点路径必须存在且可 stat；ENOENT 或 EACCES 都由外层 catch 归一化为 null。
    const deviceId = (await stat(path)).dev;
    let mountPoint = path;
    // 逐级向上：父目录仍在同一 dev 上就继续；到根或 dev 变化即为挂载点（Windows 会停在盘符根）。
    // 循环只在到达文件系统根或 dev 变化时退出；父目录 stat 失败按边界处理，不再继续上移。
    for (;;) {
      const parent = dirname(mountPoint);
      if (parent === mountPoint) break;
      let parentDev: number | bigint;
      try {
        parentDev = (await stat(parent)).dev;
      } catch {
        break;
      }
      if (parentDev !== deviceId) break;
      // 只有父目录与起点同 dev 才上移，dev 变化处即挂载点边界，判错会把整块磁盘容量算给该目录。
      mountPoint = parent;
    }
// 剩余量用 bavail（非特权可用块）而非 bfree，避免把 root 保留块算成用户可用空间。
    const fs = await statfs(mountPoint);
    return {
      deviceId: String(deviceId),
      mountPoint,
      // statfs 的 blocks/bsize 可能是 bigint 或 number，统一转 Number 再乘，避免大数乘法类型不一致。
      totalBytes: Number(fs.blocks) * Number(fs.bsize),
      freeBytes: Number(fs.bavail) * Number(fs.bsize),
    };
  } catch {
    return null;
  }
}

export function createFsVolumeProbe(): VolumeProbePort {
  // 适配器把纯函数包成 VolumeProbePort 供 runner 注入，自身不缓存、不持有状态。
  return { probe: probeStorageVolume };
}
