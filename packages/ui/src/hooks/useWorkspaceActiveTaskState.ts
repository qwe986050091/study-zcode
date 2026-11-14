// INV-01 元数据比较按序列化结果：守住位置 areTaskMetaJsonFieldsEqual；改错故障 等价对象被判不等。
// INV-02 空值统一归一：守住位置 两侧 null 合并；改错故障 未定义与空值被判不等。
// INV-03 等价元数据复用旧引用：守住位置 useStableResolvedActiveTaskMeta；改错故障 流式更新拖动标题栏重渲。
// INV-04 不等时才替换引用：守住位置 条件赋值；改错故障 旧标题长期不更新。
// INV-05 目标键含身份与远端：守住位置 targetKey；改错故障 同 ID 跨远端互相污染。
// INV-06 订阅先于查询：守住位置 effect 顺序；改错故障 读取与订阅之间漏掉重命名。
// INV-07 迟到结果不得覆盖新结果：守住位置 serial 比较；改错故障 旧响应盖回旧标题。
// INV-08 卸载后不写状态：守住位置 disposed；改错故障 卸载后 setState 警告。
// INV-09 目标变化立即拒绝旧结果：守住位置 渲染期比较；改错故障 切换后短暂显示旧标题。
// INV-10 乐观元数据只按当前任务取：守住位置 activeTaskId 判断；改错故障 显示其它任务标题。
// INV-11 乐观值作为回退：守住位置 indexedMeta 合并；改错故障 首帧无标题。
// INV-12 标题缺省区分分叉与新建：守住位置 forkedFromTaskId 三元；改错故障 分叉任务显示新会话。
// INV-13 提供方回退到选中项：守住位置 resolveWorkspaceHeaderProvider；改错故障 标题栏显示空提供方。
// INV-14 变更摘要当前恒为空：守住位置 activeTaskChangeSummary；改错故障 展示已退役的消息流字段。
// INV-15 读取失败只告警：守住位置 catch；改错故障 单次读取失败打断整页。
// INV-16 动态事件与广播都触发刷新：守住位置 两个订阅；改错故障 重命名后标题不更新。
// INV-17 订阅随目标释放：守住位置 effect 清理；改错故障 事件处理器累积。
// INV-18 本 hook 不写 store：守住位置 只读选择器；改错故障 渲染期产生副作用。
//
// 模块职责：按工作区与任务标识汇总活动任务的展示状态。
// 状态所有权：索引元数据为 hook 局部状态；任务事实归任务服务与会话 store。
// 阅读顺序：先看元数据比较，再读稳定引用，最后看订阅与返回值。
import { useEffect, useRef, useState } from "react";
import type { ZCodeProvider, ZCodeTaskMeta } from "@zcode/shared";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useTaskNativeSessionLogFile } from "@/hooks/useTaskNativeSessionLogFile.js";
import { useTaskSessionFilePath } from "@/hooks/useTaskSessionFilePath.js";
import { logger } from "@/logger.js";
import { resolveWorkspaceHeaderProvider } from "@/lib/workspaceHeaderProvider.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

interface UseWorkspaceActiveTaskStateParams {
  workspaceAbsPath: string;
  activeTaskId: string | null;
  workspaceRemoteSessionId?: string | null;
  workspaceIdentity?: string;
  selectedProvider: ZCodeProvider;
  intl: {
    formatMessage(descriptor: { id: string }): string;
  };
}

// 入参先归一：undefined 折成 null 再比，两侧都空才算相等
// JSON.stringify 只比序列化结果：不做递归遍历，开销只与字段数相关
// 键序不同会被判为不等，所以两侧 meta 必须由同一个构造函数产出
// 仅用于 task meta 片段，不要拿它比较含 Date 或 Map 的对象
// 不含原型比较：两个 different prototype 但字段相同的对象也会通过
// 该比较无副作用，可以直接放在 render 里调用
function areTaskMetaJsonFieldsEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function areResolvedTaskMetasEqual(left: ZCodeTaskMeta | null, right: ZCodeTaskMeta | null) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.taskId === right.taskId &&
    left.traceId === right.traceId &&
    left.title === right.title &&
    left.titleOverridden === right.titleOverridden &&
    left.workspacePath === right.workspacePath &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.mode === right.mode &&
    left.model === right.model &&
    left.thoughtLevel === right.thoughtLevel &&
    left.runtimeEpoch === right.runtimeEpoch &&
    left.provider === right.provider &&
    left.migrationSource === right.migrationSource &&
    left.forkedFromTaskId === right.forkedFromTaskId &&
    left.unreadAt === right.unreadAt &&
    left.status === right.status &&
    areTaskMetaJsonFieldsEqual(left.lastError, right.lastError) &&
    areTaskMetaJsonFieldsEqual(left.repairState, right.repairState) &&
    areTaskMetaJsonFieldsEqual(left.changeSummary, right.changeSummary) &&
    areTaskMetaJsonFieldsEqual(left.target, right.target)
  );
}

// 首次渲染把 taskMeta 存进 ref，后续都以它为比较基准
// 等价元数据复用 ref 里的旧引用，让下游 memo 命中
// 流式更新每个 chunk 都会重算 meta，复用旧引用才不拖动标题栏重渲
// areResolvedTaskMetasEqual 为假时才替换 ref，真变化不能被压掉
// 该 hook 不做深拷贝。
// 空值也会被稳定。
export function useStableResolvedActiveTaskMeta(taskMeta: ZCodeTaskMeta | null) {
  const stableTaskMetaRef = useRef<ZCodeTaskMeta | null>(null);
  const stableTaskMeta = stableTaskMetaRef.current;
  // stream chunk 只更新消息流时，active task meta 经列表/乐观层重新合成后可能字段相同但引用变了。
  // Header/Shell 依赖 memo props；这里复用等价 meta 的旧引用，避免连续流式更新拖动标题栏重渲。
  if (!areResolvedTaskMetasEqual(stableTaskMeta, taskMeta)) {
    stableTaskMetaRef.current = taskMeta;
  }
  return stableTaskMetaRef.current;
}

// 先从 host 取 taskService 与 broadcastService，缺任一个就退化成无订阅
// 订阅依赖 tasksVersion，版本一变就重建订阅，旧订阅由 effect 清理
// optimisticMeta 只按当前 taskId 取，别的任务的乐观值不参与渲染
// targetKey 由身份与远端拼成，同 ID 跨远端不会被认成同一个目标
// 先 subscribe 再发查询，否则查询返回前的事件会漏掉
// 迟到的结果用版本号拦掉，不允许覆盖已经更新的 indexed 快照
export function useWorkspaceActiveTaskState({
  workspaceAbsPath,
  activeTaskId,
  workspaceRemoteSessionId,
  workspaceIdentity,
  selectedProvider,
  intl,
}: UseWorkspaceActiveTaskStateParams) {
  const service = useZCodeTaskService(
    workspaceAbsPath,
    workspaceRemoteSessionId,
    workspaceIdentity,
  );
  const { broadcastService } = useBaseWorkspaceServices();
  const version = useZCodeSessionStore(
    (state) =>
      selectWorkspaceZCodeState(state, workspaceAbsPath, workspaceIdentity).taskListVersion,
  );
  const optimisticMeta = useZCodeSessionStore((state) => {
    const workspace = selectWorkspaceZCodeState(state, workspaceAbsPath, workspaceIdentity);
    return activeTaskId ? (workspace.optimisticTaskListByTaskId[activeTaskId] ?? null) : null;
  });
  const targetKey = JSON.stringify([
    workspaceIdentity?.trim() || workspaceAbsPath,
    activeTaskId,
    workspaceRemoteSessionId ?? null,
  ]);
  const [indexed, setIndexed] = useState<{
    service: typeof service;
    targetKey: string;
    meta: ZCodeTaskMeta | null;
  } | null>(null);
  useEffect(() => {
    if (!activeTaskId) return;
    let disposed = false;
    let serial = 0;
    const target = { workspacePath: workspaceAbsPath, workspaceIdentity, taskId: activeTaskId };
    const refresh = async () => {
      const request = ++serial;
      try {
        // Bugfix: 旧列表退场后，标题 fallback 的 readSession 早于 V4 冷恢复而报
        // Session is not active。标题只读 Host 索引；正文恢复不再决定标题是否可用。
        const meta = await service.getTaskMeta(target);
        if (!disposed && request === serial) setIndexed({ service, targetKey, meta });
      } catch (error) {
        if (!disposed && request === serial)
          logger.warn("[active-task-meta] 读取 Host 任务元数据失败", { ...target, error });
      }
    };
    // 先订阅再查询，避免读取与订阅之间漏掉重命名/归档；同目标的迟到结果也不能覆盖新结果。
    const events = service.onDynamicWorkspaceEvent(target)((event) => {
      if (event.type === "workspace_task_list_changed") void refresh();
    });
    const projects = broadcastService.onMessage((event) => {
      if (event.channel === "state:projects") void refresh();
    });
    void refresh();
    return () => {
      disposed = true;
      events.dispose();
      projects.dispose();
    };
  }, [
    service,
    broadcastService,
    workspaceAbsPath,
    workspaceIdentity,
    activeTaskId,
    targetKey,
    version,
  ]);
  // 同 ID 可存在于不同远端；渲染时即拒绝旧目标，不能等 effect 才清标题。
  // indexed 与当前 service/targetKey 不一致就整块丢弃，旧结果不许回流
  // 拒绝在渲染期完成而不是等 effect，避免先闪一帧旧标题
  // indexedMeta 为空时回退到 optimisticMeta，保证提交瞬间也有标题
  // title 缺省值按 isFork 与新建状态分两种文案，不用同一个占位符
  // logFilePath 交给提供方解析，本文件不拼路径
  const indexedMeta =
    indexed?.service === service && indexed.targetKey === targetKey ? indexed.meta : null;
  const activeTaskMeta = indexedMeta ?? optimisticMeta;
  const resolvedActiveTaskMeta = useStableResolvedActiveTaskMeta(activeTaskMeta);
  // M5② store 收尾：taskMessagesByTaskId 已无写入方（旧 ChatView/bot 消息回放均退役），
  // 由消息流派生的实时改动摘要恒为空；摘要展示回落到 task meta.changeSummary（持久化侧）。
  const activeTaskChangeSummary = null;
  const activeTraceId = resolvedActiveTaskMeta?.traceId ?? null;
  const activeSessionId = resolvedActiveTaskMeta?.taskId ?? null;
  const activeTaskProvider = resolvedActiveTaskMeta?.provider ?? null;
  const workspaceHeaderProvider = resolveWorkspaceHeaderProvider(
    activeTaskProvider,
    selectedProvider,
  );
  const activeTaskBaseTitle = resolvedActiveTaskMeta?.title?.trim()
    ? resolvedActiveTaskMeta.title
    : intl.formatMessage({
        id: resolvedActiveTaskMeta?.forkedFromTaskId
          ? "taskList.forkedUntitled"
          : "taskList.newThread",
      });
  const activeTaskTitle = activeTaskBaseTitle;
  const taskNativeSessionLogFile = useTaskNativeSessionLogFile(
    workspaceAbsPath,
    activeTaskId,
    activeTaskProvider,
    workspaceIdentity,
  );
  const taskSessionFile = useTaskSessionFilePath(workspaceAbsPath, activeTaskId, workspaceIdentity);

  return {
    activeTaskMeta,
    resolvedActiveTaskMeta,
    activeTraceId,
    activeSessionId,
    activeTaskProvider,
    workspaceHeaderProvider,
    activeTaskChangeSummary,
    activeTaskTitle,
    taskNativeSessionLogFile,
    taskSessionFile,
  };
}
