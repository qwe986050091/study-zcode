// INV-01 日志上限固定五十条：守住位置 常量与 slice；改错故障 长时间重连把内存撑爆。
// INV-02 最新的键列表放进 ref：守住位置 第一个 effect 的写入；改错故障 订阅回调读到挂载时的旧键。
// INV-03 日志按 workspaceKey 分组：守住位置 状态形状；改错故障 多个项目日志混成一条流。
// INV-04 目标消失即清日志：守住位置 过滤条件 resolveWorkspaceTargetByKey；改错故障 已移除项目的日志常驻。
// INV-05 无变化时返回原引用：守住位置 长度相等短路；改错故障 每次键变化都触发全量重渲染。
// INV-06 空白日志消息直接丢弃：守住位置 归一化后的判空；改错故障 空行占满五十条配额。
// INV-07 没有重连项目就不处理：守住位置 长度为 0 的提前返回；改错故障 常态下每条日志都走一遍匹配。
// INV-08 只构造有目标的重连条目：守住位置 flatMap 的空数组；改错故障 无效项目参与标签匹配。
// INV-09 requestId 可缺省：守住位置 可选链与空值合并；改错故障 缺少请求 id 的项目匹配不到日志。
// INV-10 匹配失败不写状态：守住位置 第二处提前返回；改错故障 无关日志触发无意义的映射复制。
// INV-11 只有真正变化才复制对象：守住位置 next 与 current 的判等；改错故障 每条日志都重建整个映射。
// INV-12 日志 id 含时间戳与序号：守住位置 模板字符串；改错故障 同一毫秒的多条日志键冲突。
// INV-13 订阅在卸载时释放：守住位置 effect 返回 unsubscribe；改错故障 重复挂载累积监听器。
// INV-14 重置只清单个项目：守住位置 resetLogsForWorkspaceKey；改错故障 重连一个项目把其它项目日志清空。
//
// 模块职责：为重连中的远程工作区收集运行日志，并在项目消失或主动重置时释放。
// 阅读顺序：先看上限与两份状态，再看键同步与日志订阅，最后看重置回调与返回值。
import { useCallback, useEffect, useRef, useState } from "react";
import type { IPlatformService } from "@zcode/shared";
import {
  appendRemoteConnectionRuntimeLog,
  normalizeRemoteConnectionLogMessage,
  type RemoteConnectionLogEntry,
} from "@/hooks/useRemoteConnectionLogs.js";
import { resolveRemoteWorkspaceReconnectLogWorkspaceKeys } from "@/root/reconnectingRemoteWorkspaceLogs.js";

// 上限是配额而非提示，所有写入都要截断。
const RECONNECT_RUNTIME_LOG_LIMIT = 50;

export function useReconnectingRemoteWorkspaceLogs({
  platform,
  reconnectingWorkspaceKeys,
  resolveWorkspaceTargetByKey,
  resolveWorkspaceRequestIdByKey,
}: {
  platform: IPlatformService;
  reconnectingWorkspaceKeys: string[];
  resolveWorkspaceTargetByKey: (
    workspaceKey: string,
  ) => import("@zcode/shared").RemoteWorkspaceSessionEntry["target"] | null;
  resolveWorkspaceRequestIdByKey?: (workspaceKey: string) => string | null;
}) {
  // 回调里读到的最新键列表由 ref 提供。
  const reconnectingWorkspaceKeysRef = useRef<string[]>([]);
  // logsByWorkspaceKey 以 workspaceKey 为键分组保存，各项目日志互不干扰。
  const [logsByWorkspaceKey, setLogsByWorkspaceKey] = useState<
    Record<string, RemoteConnectionLogEntry[]>
  >({});

  useEffect(() => {
    // 写入 ref 与清理状态放在同一个 effect。
    reconnectingWorkspaceKeysRef.current = reconnectingWorkspaceKeys;
    setLogsByWorkspaceKey((current) => {
      // resolveWorkspaceTargetByKey 返回 null 的项目，其日志必须一并清掉。
      const nextEntries = Object.entries(current).filter(
        ([workspaceKey]) => resolveWorkspaceTargetByKey(workspaceKey) !== null,
      );
      // 没有减少就不必产生新对象。
      if (nextEntries.length === Object.keys(current).length) {
        return current;
      }
      return Object.fromEntries(nextEntries);
    });
    // 已结束的失败日志仍由此 owner 持有，下一次请求 reset 或移除项目时释放。
  }, [reconnectingWorkspaceKeys, resolveWorkspaceTargetByKey]);

  useEffect(() => {
    // 订阅是唯一日志入口，卸载时必须释放。
    const unsubscribe = platform.onRemoteConnectionLog((entry) => {
      // 先归一化，纯空白消息不进入状态。
      const normalizedMessage = normalizeRemoteConnectionLogMessage(entry.message);
      if (!normalizedMessage) {
        return;
      }

      const reconnectingKeys = reconnectingWorkspaceKeysRef.current;
      // reconnectingKeys 为空时日志与本次重连无关，直接返回。
      if (reconnectingKeys.length === 0) {
        return;
      }

      // 只把 resolveWorkspaceTargetByKey 非空的项目交给匹配器，已消失的必须剔掉。
      const reconnectingEntries = reconnectingKeys.flatMap((workspaceKey) => {
        const target = resolveWorkspaceTargetByKey(workspaceKey);
        return target
          ? [
              {
                workspaceKey,
                requestId: resolveWorkspaceRequestIdByKey?.(workspaceKey) ?? undefined,
                target,
              },
            ]
          : [];
      });

      // 匹配同时看标签与请求 id，规则在纯函数里。
      const matchedWorkspaceKeys = resolveRemoteWorkspaceReconnectLogWorkspaceKeys({
        runtimeLabel: entry.label,
        runtimeRequestId: entry.requestId,
        reconnectingEntries,
      });
      // 匹配不到任何项目就直接返回。
      if (matchedWorkspaceKeys.length === 0) {
        return;
      }

      setLogsByWorkspaceKey((current) => {
        let next = current;
        for (const workspaceKey of matchedWorkspaceKeys) {
          const currentLogs = next[workspaceKey] ?? [];
          const nextLogs = appendRemoteConnectionRuntimeLog(currentLogs, {
            id: `${entry.label}-${entry.timestamp}-${currentLogs.length}`,
            level: entry.level,
            message: normalizedMessage,
            timestamp: entry.timestamp,
          // 保留最近若干条，旧日志按序丢弃。
          }).slice(-RECONNECT_RUNTIME_LOG_LIMIT);
          if (next === current) {
            next = { ...current };
          }
          next[workspaceKey] = nextLogs;
        }
        return next;
      });
    });

    return unsubscribe;
  }, [platform, resolveWorkspaceRequestIdByKey, resolveWorkspaceTargetByKey]);

  // 重置只作用于指定项目，不影响其它分组。
  const resetLogsForWorkspaceKey = useCallback((workspaceKey: string) => {
    setLogsByWorkspaceKey((current) => ({
      ...current,
      [workspaceKey]: [],
    }));
  }, []);

  return {
    logsByWorkspaceKey,
    resetLogsForWorkspaceKey,
  };
}
