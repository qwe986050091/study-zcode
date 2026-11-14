// INV-01 菜单只在已有附着上出现：不因展示菜单创建标签页、连接或代理，守住位置 动作派生与对话框渲染；改错故障：鼠标悬停即建立远端连接，空闲工作区被无故拉活。
// INV-02 只对在线主机出动作：连接状态不是在线则返回空，守住位置 主机查找条件；改错故障：离线主机显示同步项，点击后长时间无响应或直接报错。
// INV-03 同步目标按根路径逐个生成：多根项目每个根一条动作，守住位置 根遍历；改错故障：只取首根会让多根项目的其余目录无法同步。
// INV-04 动作标识带根下标：同类三类动作在多根下不重复，守住位置 动作标识拼接；改错故障：标识冲突会让前端复用错误行状态。
// INV-05 是否展示由会话与客户端模式共同决定：守住位置 展示判定调用；改错故障：放宽后 Web 回放态会显示不可执行动作。
// INV-06 打开菜单只记录选择，不立刻执行：守住位置 选择态写入；改错故障：点击即同步会让用户失去确认机会。
// INV-07 选择态需持续自证有效：主机在线、会话身份一致且非 Web 回放，守住位置 当前目标派生；改错故障：主机掉线后对话框仍打开，同步请求打到已断开的会话。
// INV-08 失效选择必须自动清空：守住位置 监视副作用的清理分支；改错故障：残留选择让下一次打开复用过期会话标识。
// INV-09 对话框以主机与会话身份作为键：换目标即重建，守住位置 键拼接；改错故障：复用实例会保留上一个目标的内部状态与进行中请求。
// INV-10 未就绪时对话框渲染为空：守住位置 服务解析后的早返回；改错故障：服务未就绪就挂载，子组件拿到空服务直接崩溃。
// INV-11 同步完成后的刷新按能力分别执行：技能、MCP 与插件各自路径，守住位置 三个完成回调；改错故障：统一刷新会让某一类能力读到旧缓存。
// INV-12 技能同步后先失效草稿会话再刷新共享库：守住位置 技能回调顺序；改错故障：顺序颠倒会让草稿继续引用已失效的技能快照。
// INV-13 MCP 同步后按工作区重新装载：守住位置 MCP 回调；改错故障：只更新内存列表不重载，远端新增服务器在面板中不可见。
// INV-14 插件同步后刷新能力聚合：守住位置 插件回调；改错故障：漏刷新会让命令面板继续展示已移除的插件能力。
// INV-15 回调一律使用本次目标的作用域：路径、身份与会话都来自目标而非当前界面，守住位置 三个回调入参；改错故障：使用当前选中工作区会把同步结果写到错误目录。
// INV-16 派生动作必须带稳定依赖：主机、会话、模式、服务可用性与标签页，守住位置 回调依赖数组；改错故障：漏依赖会让菜单在主机上线后仍不可用。
// INV-17 本地工作区路径只作提示透传：找不到时保持为空，守住位置 本地路径查找；改错故障：强制要求本机路径会让纯远端项目无法同步。
// INV-18 本 Hook 不持有远端事实：只读目录与会话映射，守住位置 全部选择器；改错故障：在 Hook 内缓存项目树会与侧栏权威数据分叉。
//
// 模块职责：为侧栏项目行派生远端同步动作，并在用户确认后打开对应同步对话框。
// 状态所有权：仅持有被点击的同步目标；主机、会话与标签页数据全部来自外部 store 与属性。
// 阅读顺序：先看目标结构，再看动作派生与失效清理，最后看对话框的服务解析与三个完成回调。
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  buildRemoteHostWorkspaceIdentity,
  type ProjectRowAction,
  type ProjectSidebarProps,
  type RemoteProjectDirectory,
  type RemoteProjectHost,
  type VirtualProject,
} from "@/project-sidebar/contract.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import {
  useBaseWorkspaceServices,
  useWorkspaceServicesResolution,
} from "@/hooks/useWorkspaceServices.js";
import { RemoteSyncDialogs, shouldShowRemoteSyncActions } from "@/settings/RemoteSyncActions.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import { refreshWorkspacePluginCapabilitiesAfterRemoteSync } from "@/lib/remotePluginSyncRefresh.js";
import { useMcpStore } from "@/store/mcpStore.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

type Kind = "skills" | "mcp" | "plugins";
// 目标结构把「同步什么、同步到哪里、属于哪个会话」固化在一次点击里
// [失败路径] 缺少会话标识时对话框无法解析远端服务，只能报错
// 本地工作区路径是可选提示，用于把远端结果对回本机缓存
// 身份字段必须与远端会话登记的身份一致，否则选择会被判失效
// 目标只在内存中存在，关闭对话框即丢弃
interface SyncTarget {
  kind: Kind;
  host: RemoteProjectHost;
  path: string;
  identity: string;
  sessionId: string;
  localWorkspacePath?: string;
}

/** 同步菜单只适配已有 workspace attachment；不因展示菜单创建 tab、连接或 Agent。 */
// 同步菜单只适配已有工作区附着，不主动建立连接
// [权衡] 把动作派生放在回调里，让菜单在依赖变化时整体重建而不是逐项打补丁
// [失败路径] 在 Hook 顶部创建连接，会让侧栏渲染本身产生远端副作用
// 服务可用性只影响是否提供动作，不影响项目行展示
// 标签页只在需要定位本机路径时读取，不参与菜单可见性
// 该 Hook 同时返回动作与对话框，调用方只需渲染两处
export function useProjectRemoteSync(
  props: Pick<ProjectSidebarProps, "isWebRemoteControl">,
  directory: RemoteProjectDirectory,
) {
  const base = useBaseWorkspaceServices();
  const sessions = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const tabs = useOptionalTabStore((state) => state.tabs);
  const { intl } = useZCodeIntl();
  const [selection, setSelection] = useState<SyncTarget | null>(null);
  // 当前目标需要三项同时成立：主机仍在线、会话身份一致、非 Web 回放
  // [失败路径] 只校验主机不校验会话，会在会话换代后把同步打到旧代
  // 身份比较使用完整身份串，避免同主机不同路径互相通过
  // [并发] 该派生每次渲染重算，依赖变化立即反映到对话框显隐
  // 选择为空时派生结果恒为空，不进入任何远端调用
  // Web 回放态下即使数据齐全也不展示对话框
  const selectedHost =
    selection &&
    directory.hosts.find(
      (host) =>
        host.id === selection.host.id &&
        host.membershipId === selection.host.membershipId &&
        host.connectionStatus === "online",
    );
  const selectedSession = selection && sessions[selection.sessionId];
  const current =
    selection &&
    selectedHost &&
    selectedSession?.workspaceIdentity === selection.identity &&
    !props.isWebRemoteControl
      ? selection
      : null;
  // 失效清理只在选择存在且派生为空时执行
  // [失败路径] 无此清理时，主机掉线后对话框保持打开且按钮可点
  // deps 包含派生值本身，保证每次重新派生后都复核一次
  // cleanup 只重置本地 selection，不触碰外部 session 登记
  // [权衡] 不 setInterval 轮询，状态变化由渲染链路自然触发
  // 该 useEffect 没有 cleanup，因为重置本身是幂等的
  useEffect(() => {
    if (selection && !current) setSelection(null);
  }, [selection, current]);
  const hasLocalSourceService = Boolean(base.skillSyncService);
  // 动作派生按根展开，每个根产出三类同步动作
  // [失败路径] 主机不在线时直接返回空数组，避免生成不可执行项
  // actionId 包含 rootIndex，多根项目下仍保证全局唯一
  // label 仅在 roots.length > 1 时附加根路径，单根保持简洁
  // 点击只写 selection，实际同步由对话框中 onConfirm 触发
  // [并发] 依赖覆盖主机、会话、模式、服务与标签页，避免读到旧闭包
  const actions = useCallback(
    (project: VirtualProject): ProjectRowAction[] => {
      const host = directory.hosts.find(
        (item) => item.id === project.hostId && item.connectionStatus === "online",
      );
      if (!host) return [];
      return project.roots.flatMap((root, index) => {
        const identity = buildRemoteHostWorkspaceIdentity(host.id, root.rootPath);
        const session = Object.values(sessions).find((item) => item.workspaceIdentity === identity);
        if (
          !shouldShowRemoteSyncActions({
            remoteSessionId: session?.sessionId,
            remoteTarget: host.target,
            clientMode: props.isWebRemoteControl ? "web-remote-replayable" : "desktop-continuous",
            hasLocalSourceService,
          }) ||
          !session
        )
          return [];
        return (["skills", "mcp", "plugins"] as const).map((kind) => ({
          id: `sync-${kind}-${index}`,
          icon: RefreshCw,
          label: `${intl.formatMessage({ id: { skills: "remote.syncSkills", mcp: "remote.syncMcp", plugins: "remote.syncPlugins" }[kind] })}${project.roots.length > 1 ? ` · ${root.rootPath}` : ""}`,
          run: () =>
            setSelection({
              kind,
              host,
              path: root.rootPath,
              identity,
              sessionId: session.sessionId,
              localWorkspacePath: tabs
                .filter(isWorkspaceTab)
                .find(
                  (tab) =>
                    tab.workspaceIdentity === identity && tab.remoteSessionId === session.sessionId,
                )?.localWorkspacePath,
            }),
        }));
      });
    },
    [directory.hosts, sessions, props.isWebRemoteControl, hasLocalSourceService, tabs, intl],
  );
  return {
    actions,
    dialog: current ? (
      <ProjectRemoteSyncDialog
        key={`${current.host.membershipId}:${current.identity}`}
        target={current}
        onClose={() => setSelection(null)}
      />
    ) : null,
  };
}

// 对话框自行解析目标工作区的服务，避免依赖上层缓存
// [失败路径] 服务未就绪时返回空，而不是渲染半初始化的子组件
// 关闭回调同时绑定三个子对话框，任一关闭即释放选择
// 三类同步能力均声明可用，具体是否展示由目标类型决定
// 完成回调闭包捕获本次目标，不使用当前界面的选中项
function ProjectRemoteSyncDialog({ target, onClose }: { target: SyncTarget; onClose(): void }) {
  const base = useBaseWorkspaceServices();
  const { services, rpcReady } = useWorkspaceServicesResolution(
    target.path,
    target.sessionId,
    target.identity,
    target.host.target,
  );
  const close = (open: boolean) => {
    if (!open) onClose();
  };
  if (!rpcReady) return null;
  return (
    <RemoteSyncDialogs
      canSyncSkills
      canSyncMcp
      canSyncPlugins
      skillOpen={target.kind === "skills"}
      mcpOpen={target.kind === "mcp"}
      pluginOpen={target.kind === "plugins"}
      onSkillOpenChange={close}
      onMcpOpenChange={close}
      onPluginOpenChange={close}
      localSkillSyncService={base.skillSyncService}
      remoteSkillSyncService={services.skillSyncService}
      localMcpSyncService={base.mcpSyncService}
      remoteMcpSyncService={services.mcpSyncService}
      localPluginSyncService={base.pluginSyncService}
      remotePluginSyncService={services.pluginSyncService}
      localZCodeAgentService={base.zcodeAgentService}
      remoteZCodeAgentService={services.zcodeAgentService}
      remoteTarget={target.host.target}
      workspaceIdentity={target.identity}
      skillWorkspacePath={target.path}
      mcpWorkspacePath={target.path}
      pluginWorkspacePath={target.path}
      mcpLocalWorkspacePath={target.localWorkspacePath}
      pluginLocalWorkspacePath={target.localWorkspacePath}
      onSkillsSynced={async () => {
        await invalidateDeferredDraftSessionForSkillChange({
          workspacePath: target.path,
          workspaceIdentity: target.identity,
          reason: "project-remote-skill-sync",
        });
        await refreshSharedSkillStoreForWorkspace({
          workspacePath: target.path,
          workspaceIdentity: target.identity,
          skillsService: services.skillsService,
        });
      }}
      onMcpSynced={async () => {
        await useMcpStore
          .getState()
          .ensureLoadedForWorkspace(target.path, services.mcpSyncService, target.identity);
      }}
      onPluginsSynced={() =>
        refreshWorkspacePluginCapabilitiesAfterRemoteSync({
          commandsService: services.commandsService,
          mcpSyncService: services.mcpSyncService,
          zcodeAgentService: services.zcodeAgentService,
          reason: "project-remote-plugin-sync",
          skillsService: services.skillsService,
          workspaceIdentity: target.identity,
          workspacePath: target.path,
        })
      }
    />
  );
}
