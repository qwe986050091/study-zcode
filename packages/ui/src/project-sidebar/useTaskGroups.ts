// INV-01 控制端只订阅一次：守住位置 挂载副作用；改错故障 每个视图各建一条广播订阅。
// INV-02 过期回包必须丢弃：守住位置 请求序号比较；改错故障 旧结果覆盖新结构。
// INV-03 服务缺席不抛错：守住位置 空结构赋值；改错故障 侧栏在无服务时崩溃。
// INV-04 读取失败保留旧结构：守住位置 错误分支；改错故障 一次抖动清空分组。
// INV-05 登记按宿主分批：守住位置 五千一批的循环；改错故障 大库命令超过上限。
// INV-06 单设备失败不影响其他：守住位置 全部落定聚合；改错故障 一台离线拖垮整批。
// INV-07 活动事实不触发登记：守住位置 签名输入范围；改错故障 每次流式输出都重排。
// INV-08 签名排序保证稳定：守住位置 序列化后排序；改错故障 数组顺序抖动导致重复登记。
// INV-09 卸载时让在途结果失效：守住位置 活跃标记；改错故障 卸载后仍刷新状态。
// INV-10 写入后统一刷新：守住位置 四个动作的收尾；改错故障 本地改完界面不动。
// INV-11 写动作缺服务即抛错：守住位置 必需服务的守卫；改错故障 静默失败无反馈。
// INV-12 成员表转成查询索引：守住位置 工作组键拼接；改错故障 任务找不到所属分组。
// INV-13 返回值整体缓存：守住位置 末尾的 memo；改错故障 下游每次渲染都重算。
// INV-14 可用性由服务存在性决定：守住位置 布尔字段；改错故障 菜单出现在不支持场景。
// INV-15 三个筛选视图共享语义：守住位置 结构唯一来源；改错故障 视图之间分组不一致。
// INV-16 订阅在清理时释放：守住位置 退订调用；改错故障 广播监听泄漏。
// INV-17 广播频道按名过滤：守住位置 频道判断；改错故障 无关消息也触发读取。
// INV-18 错误以字符串暴露：守住位置 错误状态类型；改错故障 界面无法渲染原因。
//
// 模块职责：为任务分组视图提供唯一的结构快照与写入动作。
// 状态所有权：结构、错误与请求序号都在 hook 内，服务由上层注入。
// 阅读顺序：先看读取与序号，再看登记签名，最后看动作与返回值。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type {
  GroupTaskRef,
  MoveGroupNode,
  ProjectTree,
  TaskGroup,
  TaskGroupStructure,
} from "@/project-sidebar/contract.js";
import { groupTaskRef } from "@/project-sidebar/grouped-view.js";
import { logger } from "@/logger.js";
const EMPTY: TaskGroupStructure = { groups: [], members: [], order: [] };
/** 控制端唯一订阅；三个筛选视图和所有任务菜单共享同一份已接受结构。 */
// useTaskGroups 只建一个 broadcastService.onMessage 订阅。
// 三个筛选视图共享同一份 TaskGroupStructure，不各自订阅。
// service 缺席时返回 EMPTY 快照，仍保持对象可用。
// read() 与广播登记都靠 refresh 收敛到同一结构。
// 返回值用 useMemo 整体缓存，避免下游因新对象重渲染。
export function useTaskGroups(tree: ProjectTree) {
  const services = useBaseWorkspaceServices();
  const service = services.taskGroupService;
  // structure 初值取模块级 EMPTY，三字段均为空数组。
  // serial 是请求序号，回包时比对以丢弃过期结果。
  // 无 service 时 setStructure(EMPTY) 并 return，不抛错。
  // 仅 request === serial.current 时才 setStructure 并清 error。
  // 失败时保留上一份 structure，只写 error 与 logger.error。
  const [structure, setStructure] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const serial = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++serial.current;
    if (!service) {
      setStructure(EMPTY);
      return;
    }
    try {
      const next = await service.read();
      if (request === serial.current) {
        setStructure(next);
        setError(null);
      }
    } catch (cause) {
      if (request === serial.current) {
        setError(String(cause));
        logger.error("[task-groups] 读取分组失败", cause);
      }
    }
  }, [service]);
  useEffect(() => {
    void refresh();
    const subscription = services.broadcastService.onMessage((event) => {
      if (event.channel === "state:task-groups") void refresh();
    });
    return () => {
      serial.current++;
      subscription.dispose();
    };
  }, [services.broadcastService, refresh]);
  // 活动时间/stream 不触发登记；仅首次身份、系统标记和明确删除有组织语义。
  // signature 由 groupTaskRef、cronAutomationId、offPeakTaskId 与删除标记拼成，其余字段不参与。
  // 活动时间与 stream 状态不进签名，避免活动渲染触发登记。
  // 已删除任务用 "deleted" 单独编码，与存活任务区分。
  // entries 先排序再 JSON.stringify，保证键顺序稳定。
  // useMemo 依赖只列 tree.tasks 与 tree.deletedTasks。
  const signature = useMemo(() => {
    // 原来每次活动渲染都排序并在比较器中反复序列化；只在事实输入变化时计算一次键。
    const entries = [
      ...tree.tasks.map((task) => [groupTaskRef(task), task.cronAutomationId, task.offPeakTaskId]),
      ...(tree.deletedTasks ?? []).map((task) => [task, "deleted"]),
    ].map((entry) => JSON.stringify(entry));
    entries.sort((a, b) => a.localeCompare(b));
    return `[${entries.join(",")}]`;
  }, [tree.tasks, tree.deletedTasks]);
  useEffect(() => {
    if (!service) return;
    const entries = JSON.parse(signature) as Array<[GroupTaskRef]>;
    const byHost = new Map<string, GroupTaskRef[]>();
    for (const [task] of entries) {
      const refs = byHost.get(task.hostId) ?? [];
      refs.push(task);
      byHost.set(task.hostId, refs);
    }
    let active = true;
    void Promise.allSettled(
      [...byHost.values()].map(async (tasks) => {
        // 同一 Host 顺序分批，避免大库超过命令上限；一个设备失败不覆盖其他设备的组织态。
        for (let start = 0; start < tasks.length; start += 5000)
          await service.admit({ tasks: tasks.slice(start, start + 5000) });
      }),
    ).then((results) => {
      for (const result of results)
        if (result.status === "rejected")
          logger.warn("[task-groups] 任务登记未完成，保留原结构", result.reason);
      if (active) void refresh();
    });
    return () => {
      active = false;
    };
  }, [service, signature, refresh]);
  const required = useCallback(() => {
    if (!service) throw new Error("task-group.service-unavailable");
    return service;
  }, [service]);
  const save = useCallback(
    async (input: { id?: string; title?: string; color?: TaskGroup["color"] }) => {
      const result = await required().save(input);
      await refresh();
      return result;
    },
    [required, refresh],
  );
  const move = useCallback(
    async (input: MoveGroupNode) => {
      await required().move(input);
      await refresh();
    },
    [required, refresh],
  );
  const ungroup = useCallback(
    async (id: string) => {
      await required().ungroup(id);
      await refresh();
    },
    [required, refresh],
  );
  const parents = useMemo(
    () =>
      new Map(
        structure.members.map((member) => [
          JSON.stringify([member.workspaceKey, member.taskId]),
          member.groupId,
        ]),
      ),
    [structure],
  );
  return useMemo(
    () => ({
      structure,
      parents,
      error,
      refresh,
      save,
      move,
      ungroup,
      available: Boolean(service),
    }),
    [structure, parents, error, refresh, save, move, ungroup, service],
  );
}
