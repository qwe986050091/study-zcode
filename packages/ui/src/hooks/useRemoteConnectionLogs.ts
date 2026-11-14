// INV-01 日志归一化三层剥离：守住位置 连续替换；改错故障 时间戳噪声占满面板。
// INV-02 源服务阶段保留：守住位置 负向断言；改错故障 bootstrap 状态被吞掉。
// INV-03 下载进度独立键：守住位置 固定键；改错故障 多文件下载互相覆盖。
// INV-04 上传按文件分键：守住位置 捕获组拼接；改错故障 并发上传只剩一行。
// INV-05 进度键识别不分大小写：守住位置 正则标志；改错故障 大小写变体重复成行。
// INV-06 进度更新整窗查找：守住位置 逆向遍历；改错故障 交错进度产生多行。
// INV-07 合并保留原层级：守住位置 展开覆盖；改错故障 升级提示丢等级。
// INV-08 最新进度移到末尾：守住位置 切片重排；改错故障 速度行停在可视区外。
// INV-09 非进度日志只追加：守住位置 末尾追加；改错故障 普通日志被去重吞掉。
// INV-10 无活跃请求全部接收：守住位置 空标识判断；改错故障 首次连接日志全被丢弃。
// INV-11 请求标识先裁剪：守住位置 归一化；改错故障 空白标识匹配失败。
// INV-12 标识不符直接丢弃：守住位置 相等比较；改错故障 旧连接日志串进新会话。
// INV-13 请求标识用引用跟踪：守住位置 引用同步；改错故障 订阅闭包读到旧标识。
// INV-14 空消息不入列表：守住位置 归一化后判断；改错故障 面板出现空行。
// INV-15 订阅随平台重建：守住位置 依赖数组；改错故障 平台切换后仍收旧事件。
// INV-16 卸载即退订：守住位置 返回清理函数；改错故障 重挂载后重复追加。
// INV-17 本地日志标识去重：守住位置 时间加长度；改错故障 同毫秒日志键冲突。
// INV-18 时间戳只取时分秒：守住位置 格式化选项；改错故障 日志行被日期撑宽。
//
// 模块职责：远端连接日志的归一化、进度合并与订阅式收集。
// 状态所有权：日志数组归 hook 本地状态，活跃请求标识由外部传入。
// 阅读顺序：先看消息归一化，再读进度键与合并，最后看订阅与本地追加。
import { useEffect, useRef, useState } from "react";
import type { RemoteConnectionRuntimeLog } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";

export interface RemoteConnectionLogEntry {
  id: string;
  level: "info" | "success" | "warn" | "error";
  message: string;
  timestamp: string;
}

// normalizeRemoteConnectionLogMessage 先剥毫秒时间戳前缀。
// 再剥 [pid:N] 前缀。
// 其余方括号前缀由 REGEX 负向断言循环剥离。
// source-server 阶段前缀必须保留，不剥。
// 最后 trim 统一裁剪首尾空白。
export function normalizeRemoteConnectionLogMessage(message: string): string {
  return message
    .replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/u, "")
    .replace(/^\[pid:\d+\]\s*/u, "")
    // Source Server phase 是 bootstrap UI 的正式状态，不是通用日志前缀，必须保留。
    .replace(/^(?:\[(?!source-server:)[^\]]+\]\s*)+/u, "")
    .trim();
}

function isRemoteDownloadProgressLog(message: string): boolean {
  return /^download progress:/iu.test(message);
}

// getRemoteTransferProgressKey 先剥 source-server 阶段前缀。
// 下载进度直接返回固定键 "download"。
// 上传进度用 uploadMatch 正则解析两段方括号标识。
// uploadMatch 为空时返回 null。
// 该键只供 appendRemoteConnectionRuntimeLog 去重，不参与展示。
function getRemoteTransferProgressKey(message: string): string | null {
  const progressMessage = message.replace(/^\[source-server:[^\]]+\]\s*/u, "");
  if (isRemoteDownloadProgressLog(progressMessage)) {
    return "download";
  }

  const uploadMatch = /^upload progress(?: \[([^\]]+)\])?(?: \((.+)\))?:/iu.exec(
    progressMessage,
  );
  if (!uploadMatch) {
    return null;
  }

  return `upload:${uploadMatch[1]?.trim() ?? ""}:${uploadMatch[2]?.trim() ?? ""}`;
}

// incomingProgressKey 非空才走合并分支。
// 从 currentLogs 末尾向前找同键旧行。
// matchingProgressIndex 命中后从原位置移除该行。
// 新进度以 incoming 内容追加到末尾。
// 无 matchingLog 或普通日志直接追加到末尾。
export function appendRemoteConnectionRuntimeLog(
  currentLogs: RemoteConnectionLogEntry[],
  incoming: {
    id: string;
    level: RemoteConnectionLogEntry["level"];
    message: string;
    timestamp: string;
  },
): RemoteConnectionLogEntry[] {
  const incomingProgressKey = getRemoteTransferProgressKey(incoming.message);
  if (incomingProgressKey) {
    let matchingProgressIndex = -1;
    for (let index = currentLogs.length - 1; index >= 0; index -= 1) {
      const currentLog = currentLogs[index];
      if (
        currentLog &&
        getRemoteTransferProgressKey(currentLog.message) === incomingProgressKey
      ) {
        matchingProgressIndex = index;
        break;
      }
    }

    if (matchingProgressIndex >= 0) {
      const matchingLog = currentLogs[matchingProgressIndex];
      if (matchingLog) {
        // 上传多个 remote 资源时不同文件的进度会交错到达，只合并相邻进度行时，
        // 同一文件稍后再更新就会追加成一长串速度行。这里按“传输类型 + 文件标识”在整个日志窗口内去重，
        // 并把最新进度移到末尾，保证每个活跃传输只占一行且最新速度始终靠近可视区域底部。
        return [
          ...currentLogs.slice(0, matchingProgressIndex),
          ...currentLogs.slice(matchingProgressIndex + 1),
          {
            ...matchingLog,
            level: incoming.level,
            message: incoming.message,
            timestamp: incoming.timestamp,
          },
        ];
      }
    }
  }

  return [
    ...currentLogs,
    {
      id: incoming.id,
      level: incoming.level,
      message: incoming.message,
      timestamp: incoming.timestamp,
    },
  ];
}

export function shouldAcceptRemoteConnectionRuntimeLog(
  entry: Pick<RemoteConnectionRuntimeLog, "requestId">,
  activeRequestId?: string | null,
): boolean {
  const normalizedActiveRequestId = activeRequestId?.trim();
  if (!normalizedActiveRequestId) {
    return true;
  }

  return entry.requestId?.trim() === normalizedActiveRequestId;
}

// activeRequestIdRef 用 ref 保持最新值。
// 每条事件先经 shouldAcceptRemoteConnectionRuntimeLog 校验归属。
// normalizeRemoteConnectionLogMessage 归一后为空则丢弃。
// id 拼 `${entry.label}-${entry.timestamp}-${currentLogs.length}`。
// 返回值包含 connectionLogs 与两个写入回调。
export function useRemoteConnectionLogs(activeRequestId?: string | null) {
  const platform = usePlatform();
  const activeRequestIdRef = useRef(activeRequestId);
  const [connectionLogs, setConnectionLogs] = useState<
    RemoteConnectionLogEntry[]
  >([]);

  useEffect(() => {
    activeRequestIdRef.current = activeRequestId;
  }, [activeRequestId]);

  useEffect(() => {
    const unsubscribe = platform.onRemoteConnectionLog((entry) => {
      if (!shouldAcceptRemoteConnectionRuntimeLog(entry, activeRequestIdRef.current)) {
        return;
      }

      const normalizedMessage = normalizeRemoteConnectionLogMessage(entry.message);
      if (!normalizedMessage) {
        return;
      }

      setConnectionLogs((currentLogs) =>
        appendRemoteConnectionRuntimeLog(currentLogs, {
          id: `${entry.label}-${entry.timestamp}-${currentLogs.length}`,
          level: entry.level,
          message: normalizedMessage,
          timestamp: entry.timestamp,
        }),
      );
    });

    return unsubscribe;
  }, [platform]);

  const resetConnectionLogs = () => {
    setConnectionLogs([]);
  };

  const appendConnectionLog = (
    level: RemoteConnectionLogEntry["level"],
    message: string,
  ) => {
    setConnectionLogs((currentLogs) => [
      ...currentLogs,
      {
        id: `${Date.now()}-${currentLogs.length}`,
        level,
        message,
        timestamp: new Date().toLocaleTimeString(undefined, {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      },
    ]);
  };

  return {
    connectionLogs,
    resetConnectionLogs,
    appendConnectionLog,
  };
}
