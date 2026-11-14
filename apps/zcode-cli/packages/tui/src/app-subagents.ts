// 子 Agent 目录与详情控制器模块：维护目录快照、当前选中项、详情 transcript 与加载/错误态。
// 边界：业务数据只经 TuiOptions 注入的读接口获取，本层仅保存临时交互态（选中项、加载态）。
// 并发语义：目录刷新用 dirty 标记合并，详情加载用自增 generation 做代际校验，丢弃迟到响应。
// 副作用：只读远端快照；本地仅更新 React 状态与 ref，不落盘、不写主会话。
import React from "react";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type {
  ZCodeSessionSubagentsResult,
  ZCodeSessionRunningSubagent,
  ZCodeSessionEndedSubagent,
} from "@zcode/shared";
import type { TuiOptions } from "./types.js";
import { changesSubagentDirectory } from "./app-subagent-events.js";
import {
  applySubagentTranscriptEvent,
  hydrateSubagentTranscript,
  type SubagentTranscript,
} from "./app-subagent-transcript.js";

// 列表项类型：运行中与已结束子 Agent 的联合，二者都以 childSessionId 作为稳定标识。
export type SubagentItem = ZCodeSessionRunningSubagent | ZCodeSessionEndedSubagent;
// 空目录常量：切换 session 或首次加载前使用，保证 UI 永远拿到结构完整的对象而非 undefined。
// revision 0 表示尚未从服务端取到任何版本；ended 用 { total: 0, items: [] } 表示无历史分页。
const EMPTY_DIRECTORY: ZCodeSessionSubagentsResult = {
  revision: 0,
  childSessionIds: [],
  running: [],
  ended: { total: 0, items: [] },
};

// 子 Agent 目录与详情控制器：维护目录快照、当前选中项、详情 transcript 及加载/错误态。
// 输入 options 提供 readSubagents / readSubagentTranscript / getMainSessionId 等能力，
// 缺失对应能力时相应功能静默不可用（目录不刷新、详情报错），不影响主会话。
// 并发语义：目录刷新用 dirty 标记合并（同一时刻只有一个请求在飞，期间的新请求合并为一次补刷），
// 详情加载用自增 generation 做代际校验，避免慢响应覆盖新选择。
// 副作用：只读远端快照（由 options 注入）；本地仅维护 React 状态与 ref，不落盘。
// 返回值：directory/transcript 用于渲染；open/back/loadMore/refreshDirectory/onEvent 供 UI 与事件层驱动。
export function useSubagents(options: TuiOptions) {
  const sessionId = options.getMainSessionId?.();
  const [directory, setDirectory] = React.useState(EMPTY_DIRECTORY);
  const [directoryError, setDirectoryError] = React.useState<string>();
  const [selected, setSelected] = React.useState<SubagentItem>();
  const [transcript, setTranscript] = React.useState<SubagentTranscript>();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const generation = React.useRef(0);
  const selection = React.useRef<SubagentItem | undefined>(undefined);
  const pendingEvents = React.useRef<SessionEvent[] | null>(null);
  const loaded = React.useRef<SubagentTranscript | undefined>(undefined);
  const directoryGeneration = React.useRef(0);
  const directoryRequest = React.useRef<Promise<void> | undefined>(undefined);
  const directoryDirty = React.useRef(false);
  const directoryRef = React.useRef(directory);
  directoryRef.current = directory;

  // 请求目录刷新：用 dirty 标记 + 单飞 Promise 合并并发请求。
  // 若已有请求在跑，只置脏位并立即返回，由在飞请求的循环体消费；epoch 用于区分切换 session 前后的请求，
  // 迟到的旧 epoch 响应直接丢弃，同时校验 parent session 是否已变化。
  // 副作用：调用 options.readSubagents 读快照；更新 directory / directoryError 状态。
  const refreshDirectory = React.useCallback((): void => {
    if (!options.readSubagents) return;
    // 已有请求在飞时不重复发起，只置脏位；循环体会在本次响应后补刷一次。
    directoryDirty.current = true;
    if (directoryRequest.current) return;
    const epoch = directoryGeneration.current;
    const parentId = options.getMainSessionId?.();
    directoryRequest.current = (async () => {
      while (directoryDirty.current && epoch === directoryGeneration.current) {
        directoryDirty.current = false;
        try {
          const snapshot = await options.readSubagents!();
          if (epoch !== directoryGeneration.current || parentId !== options.getMainSessionId?.())
            return;
          setDirectory(snapshot);
          setDirectoryError(undefined);
        } catch (cause) {
          // 仅当代际未变时才写错误态，避免旧 session 的失败覆盖新 session 的干净状态。
          if (epoch === directoryGeneration.current) setDirectoryError(String(cause));
        }
      }
    })().finally(() => {
      if (epoch === directoryGeneration.current) {
        directoryRequest.current = undefined;
        // An event can invalidate the directory after the loop exits but before
        // this continuation runs. Preserve that final refresh request as well.
        if (directoryDirty.current) refreshDirectory();
      }
    });
  }, [options]);

  // 退出详情视图：递增代际使在飞的详情请求失效，并清空选中项、待处理事件与已加载 transcript。
  // 副作用：仅重置本地状态；不释放远端资源（快照为只读数据）。
  const back = React.useCallback(() => {
    generation.current += 1;
    selection.current = undefined;
    pendingEvents.current = null;
    loaded.current = undefined;
    setSelected(undefined);
    setTranscript(undefined);
    setLoading(false);
    setError(undefined);
  }, []);

  // 打开子 Agent 详情：先置 loading 并清空旧 transcript，再异步读取快照。
  // 快照返回前到达的同会话事件会先缓存到 pendingEvents，加载完成后按序重放，避免漏事件；
  // 代际（epoch）与 parent session 双重校验，任一不匹配即放弃写入，防止跨 session 串数据。
  // 校验快照 sessionId 与请求项一致，不一致视为错误（说明读到别的会话数据）。
  // 副作用：读远端 transcript；更新 selected/transcript/loading/error 状态。
  const open = React.useCallback(
    (item: SubagentItem) => {
      const epoch = ++generation.current;
      const parentId = options.getMainSessionId?.();
      selection.current = item;
      pendingEvents.current = [];
      loaded.current = undefined;
      setSelected(item);
      setTranscript(undefined);
      setLoading(true);
      setError(undefined);
      void (async () => {
        try {
          if (!options.readSubagentTranscript)
            throw new Error("Subagent transcript is unavailable.");
          const snapshot = await options.readSubagentTranscript(item.childSessionId);
          if (epoch !== generation.current || parentId !== options.getMainSessionId?.()) return;
          if (snapshot.sessionId !== item.childSessionId)
            throw new Error("Subagent transcript session mismatch.");
          let next = hydrateSubagentTranscript(snapshot, options.workspaceDirectory);
          // 把快照生成期间收到的事件按序补放，保证详情与实时流不出现断层。
          for (const event of pendingEvents.current ?? [])
            next = applySubagentTranscriptEvent(next, event, options.workspaceDirectory);
          pendingEvents.current = null;
          loaded.current = next;
          setTranscript(next);
        } catch (cause) {
          if (epoch === generation.current) {
            pendingEvents.current = null;
            setError(String(cause));
          }
        } finally {
          if (epoch === generation.current) setLoading(false);
        }
      })();
    },
    [options],
  );

  // session 切换 effect：重置目录与详情（清空缓存与代际），再主动刷一次目录。
  // 依赖 sessionId 变化；清理函数再次递增代际，确保旧 session 的在飞请求全部作废。
  React.useEffect(() => {
    directoryGeneration.current += 1;
    directoryRequest.current = undefined;
    setDirectory(EMPTY_DIRECTORY);
    setDirectoryError(undefined);
    back();
    refreshDirectory();
    return () => {
      generation.current += 1;
      directoryGeneration.current += 1;
    };
  }, [sessionId, refreshDirectory, back]);

  // 事件入口：按需刷新目录并把属于当前选中子会话的事件投影到详情 transcript。
  // 目录刷新只对"目录相关事件"生效，且 tool_call_result 仅限主会话（子会话的结果不改变目录）。
  // 详情规则：加载中先缓存事件；已加载时若事件序号跳跃（不再 +1）则重新拉取快照，防止丢事件后静默错位。
  // 无副作用：只更新内存状态，事件本身由上游 session 流驱动。
  const onEvent = React.useCallback(
    (event: SessionEvent) => {
      if (
        changesSubagentDirectory(event) &&
        (event.type !== SessionEventType.ToolCallResult ||
          event.sessionId === options.getMainSessionId?.())
      )
        refreshDirectory();
      if (event.sessionId !== selection.current?.childSessionId) return;
      if (pendingEvents.current) {
        pendingEvents.current.push(event);
        // 缓存超过 4096 条说明快照迟迟未回或事件洪峰；直接重开详情以重建投影，避免无界内存增长。
        if (pendingEvents.current.length > 4096 && selection.current) open(selection.current);
      } else if (loaded.current) {
        if (event.sequenceNumber > loaded.current.sequenceNumber + 1 && selection.current) {
          open(selection.current);
          return;
        }
        const next = applySubagentTranscriptEvent(
          loaded.current,
          event,
          options.workspaceDirectory,
        );
        if (next !== loaded.current) {
          loaded.current = next;
          setTranscript(next);
        }
      }
    },
    [options, refreshDirectory, open],
  );

  // 加载下一页已结束子 Agent：以 directoryRef 中的 nextCursor 为准（避免闭包读到旧目录）。
  // 代际校验保证分页结果只并入同一 session 的目录；结果按 childSessionId 去重后追加，
  // 防止服务端分页边界重叠导致重复条目。无 cursor 或缺少读能力时直接返回（幂等空操作）。
  const loadMore = React.useCallback(async () => {
    const cursor = directoryRef.current.ended.nextCursor;
    if (!cursor || !options.readSubagents) return;
    const epoch = directoryGeneration.current;
    try {
      const page = await options.readSubagents({ endedCursor: cursor });
      if (epoch !== directoryGeneration.current) return;
      setDirectory((current) => ({
        ...current,
        ended: {
          ...page.ended,
          items: [
            ...new Map(
              [...current.ended.items, ...page.ended.items].map((item) => [
                item.childSessionId,
                item,
              ]),
            ).values(),
          ],
        },
      }));
    } catch (cause) {
      if (epoch === directoryGeneration.current) setDirectoryError(String(cause));
    }
  }, [options]);

  return {
    directory,
    directoryError,
    selected:
      selected &&
      ([...directory.running, ...directory.ended.items].find(
        (item) => item.childSessionId === selected.childSessionId,
      ) ??
        selected),
    transcript,
    loading,
    error,
    open,
    back,
    onEvent,
    loadMore,
    refreshDirectory,
  };
}

// 控制器类型：直接由 hook 返回值推导，调用方无需手写重复接口，保证类型与实现同步。
export type SubagentsController = ReturnType<typeof useSubagents>;
