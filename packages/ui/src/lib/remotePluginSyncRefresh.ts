// INV-01 未提供工作区路径直接返回：守住位置 空值早退；改错故障 向空路径发起刷新。
// INV-02 工作区标识先修剪再归一：守住位置 赋值表达式；改错故障 纯空白标识被当成有效。
// INV-03 标识为空时按未提供传递：守住位置 空值合并；改错故障 下游收到空字符串。
// INV-04 先失效草稿会话再刷新：守住位置 调用顺序；改错故障 草稿仍引用旧技能。
// INV-05 技能库刷新带同一标识：守住位置 参数透传；改错故障 刷新落到错误工作区。
// INV-06 命令刷新失败不中断后续：守住位置 内部捕获；改错故障 同步整体失败。
// INV-07 命令结果仅在归属一致时写回：守住位置 双字段比较；改错故障 切换工作区后回写旧结果。
// INV-08 命令面板数据单独写回会话：守住位置 显式调用；改错故障 输入框看不到新命令。
// INV-09 命令合并保留既有顺序：守住位置 合并函数；改错故障 用户命令被重新排序。
// INV-10 失败时清空加载态并记错误：守住位置 状态写入；改错故障 设置页永久转圈。
// INV-11 失败日志带原因与工作区：守住位置 日志字段；改错故障 无法定位是哪次同步。
// INV-12 MCP 按工作区惰性加载：守住位置 加载调用；改错故障 使用上一工作区的工具列表。
// INV-13 刷新后通知全部已挂载投影：守住位置 通知调用；改错故障 设置页停留在旧能力。
// INV-14 通知范围限定为用户级：守住位置 范围字段；改错故障 其它作用域被误刷新。
// INV-15 通知不携带权限键：守住位置 空值字段；改错故障 借用上次的权限判定。
// INV-16 三段刷新按固定顺序串行：守住位置 逐段等待；改错故障 命令先于技能完成。
// INV-17 错误信息统一转字符串：守住位置 转换函数；改错故障 日志出现对象占位。
// INV-18 入口不修改传入参数对象：守住位置 局部取值；改错故障 调用方配置被就地改写。
//
// 模块职责：远端插件同步后刷新技能、命令与 MCP 能力投影。
// 状态所有权：无状态；结果写入各领域 store 与会话 store。
// 阅读顺序：先看命令刷新，再看同步入口，最后看通知与错误处理。
import type {
  ICommandsService,
  IMcpSyncService,
  ISkillsService,
  IZCodeAgentService,
} from "@zcode/services";
import { logger } from "@/logger.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import { mergeSlashCommandsAfterCommandRefresh } from "@/settings/pluginSlashCommandRefresh.js";
import { useCommandsStore } from "@/store/commandsStore.js";
import { useMcpStore } from "@/store/mcpStore.js";
import { notifyPluginManagementChange } from "@/store/pluginManagementStoreLoading.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// workspaceIdentity 存在时才在拉取命令时带上标识。
// 写回设置页前必须先校验 workspaceIdentity 与当前工作区一致。
// 命令面板数据显式写回会话状态，不走事件总线。
// 失败时只把 loading 复位并记录日志，不向上抛错。
async function refreshSlashCommandsAfterRemotePluginSync(params: {
  commandsService: ICommandsService;
  reason: string;
  workspacePath: string;
  workspaceIdentity: string | null;
}): Promise<void> {
  const { commandsService, reason, workspacePath, workspaceIdentity } = params;
  const workspaceIdentityParam = workspaceIdentity ?? undefined;

  try {
    const result = await commandsService.list({
      workspacePath,
      ...(workspaceIdentityParam ? { workspaceIdentity: workspaceIdentityParam } : {}),
    });

    const commandsStore = useCommandsStore.getState();
    if (
      commandsStore.workspacePath === workspacePath &&
      commandsStore.workspaceIdentity === workspaceIdentity
    ) {
      useCommandsStore.setState({
        commands: result.commands,
        userCommands: result.userCommands,
        pluginCommands: result.pluginCommands,
        capability: result.capability,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentity,
        loading: false,
        error: null,
      });
    }

    const zcodeSessionStore = useZCodeSessionStore.getState();
    const currentSlashCommands = zcodeSessionStore.getWorkspaceState(
      workspacePath,
      workspaceIdentityParam,
    ).slashCommands;
    // 远程插件同步入口不一定打开过命令设置页，commandsStore 可能尚未初始化。
    // 输入框 `/` 面板读取的是 zcodeSessionStore.slashCommands，所以同步后必须直接
    // 向当前远端 workspace 拉取 commands 并写回 slashCommands，不能只刷新设置页 store。
    zcodeSessionStore.setSlashCommands(
      workspacePath,
      mergeSlashCommandsAfterCommandRefresh(currentSlashCommands, result.commands),
      workspaceIdentityParam,
    );
  } catch (error) {
    const commandsStore = useCommandsStore.getState();
    if (
      commandsStore.workspacePath === workspacePath &&
      commandsStore.workspaceIdentity === workspaceIdentity
    ) {
      useCommandsStore.setState({
        loading: false,
        error: toMessage(error),
      });
    }
    logger.warn("[plugins] refresh slash commands after remote plugin sync failed", {
      reason,
      workspaceIdentity,
      workspacePath,
      error: toMessage(error),
    });
  }
}

// workspacePath 为空时直接 return。
// workspaceIdentity 先 trim，空串归一为 null。
// 三段刷新必须按顺序串行 await，不能并发。
export async function refreshWorkspacePluginCapabilitiesAfterRemoteSync(params: {
  commandsService: ICommandsService;
  mcpSyncService: IMcpSyncService;
  reason: string;
  skillsService: ISkillsService;
  workspaceIdentity?: string | null;
  workspacePath?: string | null;
  zcodeAgentService: IZCodeAgentService;
}): Promise<void> {
  const workspacePath = params.workspacePath;
  if (!workspacePath) {
    return;
  }
  const workspaceIdentity = params.workspaceIdentity?.trim() || null;
  const workspaceIdentityParam = workspaceIdentity ?? undefined;
  await invalidateDeferredDraftSessionForSkillChange({
    workspacePath,
    workspaceIdentity: workspaceIdentityParam,
    reason: params.reason,
  });
  // 技能刷新复用同一组 workspacePath 与 workspaceIdentity 参数。
  // 随后经 refreshSlashCommandsAfterRemotePluginSync 刷新命令数据，失败不回滚前面的技能刷新。
  // 最后通知已挂载投影重取 plugin capabilities，调用方不等待返回值。
  await refreshSharedSkillStoreForWorkspace({
    workspacePath,
    workspaceIdentity: workspaceIdentityParam,
    skillsService: params.skillsService,
  });
  await refreshSlashCommandsAfterRemotePluginSync({
    commandsService: params.commandsService,
    reason: params.reason,
    workspacePath,
    workspaceIdentity,
  });
  await useMcpStore
    .getState()
    .ensureLoadedForWorkspace(workspacePath, params.mcpSyncService, workspaceIdentityParam);
  // 同步入口可能没有打开全局设置；按真实目标通知所有已挂载投影。
  notifyPluginManagementChange({
    workspacePath,
    workspaceIdentity,
    authorityKey: null,
    scope: "user",
  });
}
