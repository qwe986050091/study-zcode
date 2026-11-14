// INV-01 生命周期绑 enabled：守住位置 第一个 effect 的提前返回；改错故障 切走 tab 后仍在扫描。
// INV-02 只认当前 jobId：守住位置 进度回调的 id 比较；改错故障 旧作业尾包覆盖新结果。
// INV-03 进入先展示旧快照：守住位置 getSnapshot 回填；改错故障 首屏空白直到扫描结束。
// INV-04 终态即清 jobId：守住位置 status 不等于 scanning；改错故障 已完成作业仍被当成在跑。
// INV-05 取消先置空再调远端：守住位置 cancel 的前三行；改错故障 取消失败后 jobId 残留。
// INV-06 清理前先作废旧作业：守住位置 clean 内的 jobIdRef 赋值；改错故障 清理期间旧进度继续写入。
// INV-07 清理后自动重扫：守住位置 clean 末尾的 start；改错故障 清理完数字还是旧的。
// INV-08 失焦六十秒才取消：守住位置 STORAGE_SCAN_BLUR_CANCEL_MS；改错故障 短暂切窗打断扫描。
// INV-09 聚焦仅在取消过时重启：守住位置 cancelledByBlur；改错故障 每次聚焦重复开扫。
// INV-10 桥缺失时静默降级：守住位置 start 的首行返回；改错故障 未注入桥的环境直接抛错。
// INV-11 扫描错误只记日志：守住位置 catch 分支；改错故障 失败冒泡打断资源管理器整页。
// INV-12 回填不覆盖新扫描：守住位置 !jobIdRef.current；改错故障 旧快照盖掉正在扫描的结果。
// INV-13 卸载清理三件事：守住位置 effect 的返回函数；改错故障 监听器与定时器泄漏。
// INV-14 rescan 即 start：守住位置 返回值映射；改错故障 外部刷新走另一条未同步的路径。
//
// 模块职责：资源管理器存储 tab 的扫描、进度订阅、失焦取消与清理数据源。
// 阅读顺序：先看 jobId 与两个回调，再看生命周期 effect，最后看失焦取消与 clean。
/**
 * useStorageUsage —— 资源管理器「存储」tab 的数据源，输入是 preload 暴露的 StorageManagementBridge。
 * 生命周期与 tab 绑定：enabled 时开始扫描并订阅进度，卸载 / 切走时取消；
 * 窗口失焦超过 60s 取消扫描，回到前台后重新开始（性能约束）。
 * 只消费当前 jobId 的快照，旧 job 的尾包直接丢弃；进入时先展示上次完成的快照（stale-while-revalidate）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  StorageCleanRequest,
  StorageCleanResult,
  StorageManagementBridge,
  StorageUsageSnapshot,
} from "@zcode/shared";
import { logger } from "@/logger.js";

export const STORAGE_SCAN_BLUR_CANCEL_MS = 60_000;

export interface StorageUsageState {
  snapshot: StorageUsageSnapshot | null;
  scanning: boolean;
  rescan: () => Promise<void>;
  clean: (request: StorageCleanRequest) => Promise<StorageCleanResult>;
}

export function useStorageUsage({
  bridge,
  enabled,
}: {
  bridge: StorageManagementBridge | undefined;
  enabled: boolean;
}): StorageUsageState {
  const [snapshot, setSnapshot] = useState<StorageUsageSnapshot | null>(null);
  const [scanning, setScanning] = useState(false);
  // 当前作业 id 是唯一有效的快照来源。
  const jobIdRef = useRef<string | null>(null);

  // 开扫成功后才记 jobId 并进入扫描态。
  // 失败只复位 scanning，不向调用方抛出。
  const start = useCallback(async () => {
    if (!bridge) return;
    try {
      const { jobId } = await bridge.startScan();
      jobIdRef.current = jobId;
      setScanning(true);
    } catch (error) {
      logger.warn("[storage] startScan failed", { error });
      setScanning(false);
    }
  }, [bridge]);

  const cancel = useCallback(async () => {
    const jobId = jobIdRef.current;
    jobIdRef.current = null;
    setScanning(false);
    // 先清本地态再调远端，保证重复取消幂等。
    if (!jobId || !bridge) return;
    try {
      await bridge.cancelScan(jobId);
    } catch (error) {
      logger.warn("[storage] cancelScan failed", { error, jobId });
    }
  }, [bridge]);

  useEffect(() => {
    if (!enabled || !bridge) return;
    let disposed = false;
    const unsubscribe = bridge.subscribeScanProgress((next) => {
      // 卸载后与 `jobId` 不匹配的尾包都在 `disposed` 判断处丢弃。
      if (disposed || next.jobId !== jobIdRef.current) return;
      setSnapshot(next);
      // 终态后清掉 jobId，后续进度不再被接受。
      if (next.status !== "scanning") {
        jobIdRef.current = null;
        setScanning(false);
      }
    });
    void bridge
      .getSnapshot()
      .then((previous) => {
        // 回填只在新扫描尚未开始时发生。
        if (!disposed && previous && !jobIdRef.current) setSnapshot(previous);
      })
      .catch(() => {});
    // `start()` 在 effect 建立时立即执行，不推迟到首个定时回调。
    void start();
    return () => {
      // 卸载标记要早于退订，防止尾包写状态。
      disposed = true;
      unsubscribe();
      void cancel();
    };
  }, [enabled, bridge, start, cancel]);

  useEffect(() => {
    if (!enabled || !bridge || typeof window === "undefined") return;
    let blurTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelledByBlur = false;
    const onBlur = () => {
      if (blurTimer) clearTimeout(blurTimer);
      // 失焦只启动延迟取消，回焦会清掉定时器。
      blurTimer = setTimeout(() => {
        blurTimer = null;
        if (!jobIdRef.current) return;
        cancelledByBlur = true;
        void cancel();
      }, STORAGE_SCAN_BLUR_CANCEL_MS);
    };
    const onFocus = () => {
      if (blurTimer) {
        clearTimeout(blurTimer);
        blurTimer = null;
      }
      if (cancelledByBlur) {
        cancelledByBlur = false;
        // 只有失焦确实取消过，聚焦才重新开扫。
        void start();
      }
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      if (blurTimer) clearTimeout(blurTimer);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, bridge, start, cancel]);

  const clean = useCallback(
    async (request: StorageCleanRequest) => {
      // 清理缺桥时明确抛错，与扫描的静默降级不同。
      if (!bridge) throw new Error("storage bridge unavailable");
      jobIdRef.current = null;
      setScanning(false);
      // 清理完成后主动重扫，避免展示过期数字。
      const result = await bridge.clean(request);
      await start();
      return result;
    },
    [bridge, start],
  );

  return { snapshot, scanning, rescan: start, clean };
}
