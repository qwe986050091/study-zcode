// INV-01 保存与再次运行同一控制器：守住位置 单一 hook；改错故障 卡片与侧板行为分叉。
// INV-02 目标对象按工作区身份构造：守住位置 useMemo 依赖；改错故障 远程会话丢失身份。
// INV-03 远程会话字段缺省不写：守住位置 条件展开；改错故障 本地请求带上空远程 id。
// INV-04 缓存键由工作区与 run 组成：守住位置 workflowRunSavedKey；改错故障 不同 run 互相覆盖。
// INV-05 rpc 未就绪不发查询：守住位置 rpcReady 判断；改错故障 启动期请求失败。
// INV-06 代际变化触发重查：守住位置 generation 依赖；改错故障 删除后卡片仍显示已保存。
// INV-07 查询结果写入共享缓存：守住位置 load 回调；改错故障 卡片各自请求。
// INV-08 保存中状态只包住请求：守住位置 try/finally；改错故障 失败后按钮永久禁用。
// INV-09 保存成功立即回填缓存：守住位置 applySaved；改错故障 卡片停留在未保存。
// INV-10 回填字段与入参一致：守住位置 meta 展开；改错故障 描述与保存值不符。
// INV-11 覆盖写出参原样透传：守住位置 overwrite 展开；改错故障 用户选择被忽略。
// INV-12 重名探测失败不阻断：守住位置 catch 返回假；改错故障 网络抖动挡住保存。
// INV-13 启动器统一构造：守住位置 useSavedWorkflowLauncher；改错故障 两条启动路径参数不同。
// INV-14 显式目标优先于默认：守住位置 launchTarget 判断；改错故障 从历史运行启动跑错工作区。
// INV-15 有会话才解析项目绑定：守住位置 sessionId 判断；改错故障 无会话时多余请求。
// INV-16 项目服务缺失显式报错：守住位置 throw；改错故障 静默回退到错误目录。
// INV-17 启动结果收敛为判别联合：守住位置 ok 三元；改错故障 调用方拿到未定义错误。
// INV-18 对外字段全部来自缓存快照：守住位置 返回值展开；改错故障 展示态与实际不一致。
//
// 模块职责：把完成卡与侧板的保存、重名探测与再次运行收敛成一套动作。
// 状态所有权：保存结果归 workflowRunSavedStore；本 hook 只做编排与瞬时态。
// 阅读顺序：先看目标与缓存键，再看查询与保存，最后看启动器接线。
// 完成卡与 run 侧板共用的「保存 / 再次运行」控制器（docs/dynamic-workflow/transcript-and-notifications.md
// 「Saving the run, and running it again」）。
//
// 一个 hook 而不是两份接线：同一个 run 在卡上与侧板上必须说同一句话、走同一条命令。它负责
//   1. 这次 run 对应哪个已保存工作流（推导，缓存在 workflowRunSavedStore）；
//   2. 「直接保存」= `workflows/save`（按 runId 取脚本，无模型回合）；
//   3. 「再次运行」= 中枢那台启动器（`useSavedWorkflowLauncher`），实参取这次 run 跑过的那份。
// 「让 ZCode 帮我提炼保存」不在这里：它只是把一条用户消息交回宿主发出去（卡在会话里、侧板在父
// 会话里），宿主各有各的发送路径。
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  resolveWorkspaceKey,
  type ZCodeSavedWorkflowEntry,
  type ZCodeSavedWorkflowScope,
} from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import {
  selectWorkflowRunSavedState,
  useWorkflowRunSavedStore,
  workflowRunSavedKey,
} from "@/store/workflowRunSavedStore.js";
import { useSavedWorkflowLauncher } from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";

import type {
  WorkflowRunSaveHost,
  WorkflowRunSaveController,
  WorkflowRunSaveSubmit,
  WorkflowRunSaveTarget,
} from "@/project-workflow/contract.js";
export type {
  WorkflowRunSaveHost,
  WorkflowRunSaveController,
  WorkflowRunSaveSubmit,
  WorkflowRunSaveTarget,
} from "@/project-workflow/contract.js";

// 入参只带工作区与 run 线索。
// 服务解析统一走工作区 hook。
// 远程标记决定作用域是否锁定。
export function useWorkflowRunSave(host: WorkflowRunSaveHost): WorkflowRunSaveController {
  const { candidates, runId, onNavigateToRun } = host;
  const resolution = useWorkspaceServicesResolution(
    host.workspacePath,
    host.remoteSessionId ?? null,
    host.workspaceIdentity,
  );
  const { rpcReady, services } = resolution;
  const agentService = services.zcodeAgentService;
  const isRemote = resolution.isRemoteTarget;

  // 目标对象按依赖缓存。
  // 身份与远程 id 缺省不落字段。
  // 同一 run 复用同一引用。
  const target = useMemo<WorkflowRunSaveTarget>(
    () => ({
      workspacePath: host.workspacePath,
      ...(host.workspaceIdentity ? { workspaceIdentity: host.workspaceIdentity } : {}),
      ...(resolution.remoteSessionId ? { remoteSessionId: resolution.remoteSessionId } : {}),
    }),
    [host.workspacePath, host.workspaceIdentity, resolution.remoteSessionId],
  );
  const workspaceKey = useMemo(
    () =>
      resolveWorkspaceKey({
        workspacePath: host.workspacePath,
        ...(host.workspaceIdentity ? { workspaceIdentity: host.workspaceIdentity } : {}),
      }),
    [host.workspacePath, host.workspaceIdentity],
  );
  const key = useMemo(
    () => workflowRunSavedKey(workspaceKey, runId, candidates),
    [candidates, runId, workspaceKey],
  );

  const generation = useWorkflowRunSavedStore((state) => state.generation);
  const load = useWorkflowRunSavedStore((state) => state.load);
  const applySaved = useWorkflowRunSavedStore((state) => state.applySaved);
  const saved = useWorkflowRunSavedStore((state) => selectWorkflowRunSavedState(state, key));

  // rpc 未就绪先跳过。
  // generation 变化时强制重查，一次作废让所有卡片刷新。
  // 结果交由 store 幂等写入。
  useEffect(() => {
    if (!rpcReady) return;
    // `generation` 在依赖里：一次作废让所有在场的卡片重查（保存、删除、中枢刷新都会作废）。
    void generation;
    void load(key, () =>
      agentService.findSavedWorkflowForRun({
        ...target,
        runId,
        ...(candidates === undefined || candidates.length === 0 ? {} : { candidates }),
      }),
    );
  }, [agentService, candidates, generation, key, load, rpcReady, runId, target]);

  const [saving, setSaving] = useState(false);
  // setSaving(true) 在 await 之前执行。
  // result.ok 时立刻 applySaved 回填缓存。
  // 回填的 name 与 meta 取自 input，保持一致。
  // finally 里 setSaving(false)，无论成败都复位。
  const save = useCallback(
    async (input: WorkflowRunSaveSubmit) => {
      setSaving(true);
      try {
        const result = await agentService.saveSavedWorkflowFromRun({
          ...target,
          runId,
          name: input.name,
          meta: input.meta,
          scope: input.scope,
          ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }),
        });
        if (result.ok) {
          // 刚写成的那一份立刻摆上去（卡片翻成「已保存 / 再次运行」），同时作废别的卡的答案。
          applySaved(key, {
            name: result.name,
            description: input.meta.description,
            ...(input.meta.whenToUse === undefined ? {} : { whenToUse: input.meta.whenToUse }),
            ...(input.meta.args === undefined ? {} : { args: input.meta.args }),
            scope: result.scope,
            path: result.path,
          });
        }
        return result;
      } finally {
        setSaving(false);
      }
    },
    [agentService, applySaved, key, runId, target],
  );

  const checkNameTaken = useCallback(
    async (name: string, scope: ZCodeSavedWorkflowScope) => {
      try {
        const result = await agentService.getSavedWorkflow({ ...target, name, scope });
        return result.ok;
      } catch {
        // 探测失败不该挡住保存：agent 仍会用 `target_exists` 给出最终答案。
        return false;
      }
    },
    [agentService, target],
  );

  const launcher = useSavedWorkflowLauncher({
    agentService,
    ...(onNavigateToRun === undefined ? {} : { onNavigate: onNavigateToRun }),
  });
  // launchTarget 显式传入时优先于 hook 的 target。
  // host.sessionId 存在时用 resolveSessionDirectories 补 projectId。
  // 结果收敛为 { ok: true } 或带 error 的判别值。
  const launch = useCallback(
    async (
      entry: ZCodeSavedWorkflowEntry,
      args: Record<string, unknown>,
      launchTarget?: WorkflowRunSaveTarget,
    ) => {
      let destination = launchTarget ?? target;
      if (!launchTarget && host.sessionId) {
        if (!services.projectService) throw new Error("project.service-unavailable");
        const binding = await services.projectService.resolveSessionDirectories({
          ...target,
          taskId: host.sessionId,
        });
        destination = { ...target, projectId: binding.projectId };
      }
      const result = await launcher.launch(
        {
          workspacePath: destination.workspacePath,
          ...(destination.workspaceIdentity
            ? { workspaceIdentity: destination.workspaceIdentity }
            : {}),
          ...(destination.remoteSessionId ? { remoteSessionId: destination.remoteSessionId } : {}),
        },
        { name: entry.name, scope: entry.scope, args },
      );
      return result.ok ? { ok: true as const } : { ok: false as const, error: result.error };
    },
    [launcher, target, services.projectService, host.sessionId],
  );

  return {
    saved,
    entry: saved?.entry,
    runArgs: saved?.runArgs,
    directSaveUnsupported: saved?.status === "unsupported",
    scopeLocked: isRemote,
    saving,
    save,
    checkNameTaken,
    launching: launcher.pending,
    launchError: launcher.error,
    clearLaunchError: launcher.clearError,
    launch,
  };
}
