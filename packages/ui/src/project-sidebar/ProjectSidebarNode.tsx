// INV-01 动作统一收口：守住位置 runProjectAction 的 catch；改错故障：异步失败变成未处理拒绝。
// INV-02 失败可见：守住位置 错误日志与 toast 的成对调用；改错故障：操作失败但界面毫无反馈。
// INV-03 按项目隔离：守住位置 memo 的第二个参数；改错故障：任务活动刷新导致整列项目重渲染。
// INV-04 任务单独比较：守住位置 任务数组的浅比较；改错故障：任务内容变化却被判为相等。
// INV-05 设备入口条件：守住位置 isDesktop 与源服务器标识的判断；改错故障：无源服务器的项目出现无效入口。
// INV-06 设置意图先行：守住位置 setPendingSettingsSectionIntent 的调用顺序；改错故障：设置页落在默认分区。
// INV-07 连接项按需：守住位置 远端在线状态判断；改错故障：在线项目仍显示「连接」。
// INV-08 连接路径分流：守住位置 桌面端与其它端的分支；改错故障：桌面端丢失凭据与安装流程。
// INV-09 删除需服务：守住位置 service 的非空断言前提；改错故障：无服务时点击删除抛空引用。
// INV-10 远端移除需凭据：守住位置 entryId 与 remoteService 的双重判断；改错故障：缺少条目标识仍发起移除。
// INV-11 移动重试限本地：守住位置 hostId 与错误文案判断；改错故障：远端缺根也被引导补本地目录。
// INV-12 补根需确认：守住位置 确认框结果判断；改错故障：未经同意自动添加工作区根。
// INV-13 成功后刷新：守住位置 各动作末尾的 refresh；改错故障：操作成功但列表要手动刷新。
// INV-14 展示属性透传：守住位置 display 的展开；改错故障：展开态或未读标记被本层吞掉。
// INV-15 回调带项目：守住位置 展开回调用 project 闭包；改错故障：同一回调被多行复用导致串项目。
// INV-16 文案命名空间：守住位置 project 前缀拼接；改错故障：缺键时显示原始 key。
// INV-17 固定动作顺序：守住位置 远端动作与连接动作的拼接顺序；改错故障：菜单项顺序随状态跳变。
// INV-18 无本地状态：守住位置 组件体；改错故障：行内缓存与外部刷新不同步。
//
// 模块职责：把侧栏契约、项目服务与远端动作装配成单行项目节点，并隔离重渲染。
// 状态所有权：项目数据与展开态归上层；本层只读并用服务执行动作。
// 阅读顺序：动作包装 → 属性类型 → memo 主体 → 设置与连接 → 增删改动作 → 比较器。
import { memo } from "react";
import { shallow } from "zustand/shallow";
import { Plug } from "lucide-react";
import type {
  IProjectService,
  IRemoteProjectService,
  ProjectRowAction,
  ProjectSidebarProps,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import { buildRemoteHostWorkspaceIdentity } from "@/project-sidebar/contract.js";
import { ProjectNode } from "@/project-sidebar/ProjectNode.js";
import type { ProjectNodeProps } from "@/project-sidebar/ProjectNodeContent.js";
import { projectSourceServerId } from "@/project-sidebar/view.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";

// 统一捕获异步动作的失败：写日志并弹提示，不向上抛。
// 错误转成字符串展示，避免非 Error 抛出时提示为空。
//
export function runProjectAction(body: () => Promise<void>) {
  void body().catch((cause) => {
    logger.error("[project-sidebar] 操作失败", cause);
    toast(String(cause));
  });
}

// 属性从内容层与侧栏契约各取一部分，展示字段走剩余属性透传。
// remoteService 是可选依赖，未注入时相关动作自然不可用。
//
type Props = Pick<
  ProjectNodeProps,
  | "project"
  | "remoteHost"
  | "deviceLabel"
  | "diagnostics"
  | "expanded"
  | "hasUnread"
  | "availability"
  | "tasks"
  | "onSelect"
  | "refresh"
> &
  Pick<
    ProjectSidebarProps,
    "isDesktop" | "isWebRemoteControl" | "onCreateTask" | "onReconnectRemoteWorkspace"
  > & {
    service?: IProjectService;
    remoteService?: IRemoteProjectService;
    onExpandedChange(project: VirtualProject, expanded: boolean): void;
    onEdit(value: { project: VirtualProject }): void;
    onViewFiles(project: VirtualProject, rootPath: string): Promise<void>;
    remoteActions(project: VirtualProject): ProjectRowAction[];
  };

// Bug 根因：任务活动每秒更新目录，父组件随之重建所有项目的菜单与回调，穿透内容层 memo。
// 按项目隔离装配；数组只比较元素与顺序，其余属性完整比较，真实状态和回调变化仍需更新。
// 按项目隔离 memo：任务活动每秒刷新时只重渲染真正变化的行。
// nodeProps 整体透传给内容层，本层只补 actions 与 onOpenSettings。
//
export const ProjectSidebarNode = memo(
  function ProjectSidebarNode({
    project,
    remoteHost,
    service,
    remoteService,
    isDesktop,
    isWebRemoteControl,
    onCreateTask,
    onReconnectRemoteWorkspace,
    onExpandedChange,
    onEdit,
    onViewFiles,
    remoteActions,
    ...display
  }: Props) {
    // 文案统一走 project 命名空间前缀，避免逐字硬编码。
    // 确认框与 Tab store 在此取一次，动作闭包里直接复用。
    // 这些依赖都是稳定的，不会成为额外重渲染来源。
    //
    const { intl } = useZCodeIntl();
    const confirm = useConfirmDialog();
    const tabStore = useTabStoreApi();
    const msg = (id: string) => intl.formatMessage({ id: `project.${id}` });
    // 源服务器标识决定是否显示设备设置入口，缺失时不给入口。
    // 标识取自项目本身，而不是远端连接的当前状态。
    // 标识为空即视为「没有可设置的源服务器」，不提供入口。
    //
    const sourceServerId = projectSourceServerId(project);
    const { refresh, availability } = display;
    return (
      <ProjectNode
        {...display}
        project={project}
        remoteHost={remoteHost}
        // 桌面端且存在源服务器时才注入回调，否则传空让内容层隐藏入口。
        // 打开设置前先写 pendingSettingsSection = "remote-devices"，设置页据此直接落在远程设备分区。
        //
        onOpenDeviceSettings={
          isDesktop && sourceServerId
            ? () => {
                setPendingSettingsSectionIntent("remoteDevices", { sourceServerId });
                tabStore.getState().openSettingsTab();
              }
            : undefined
        }
        // 远端动作在前、连接动作在后，顺序与菜单展示保持一致。
        // 仅在远端未在线时补「连接」项，避免出现重复入口。
        // isDesktop 时走 reconnectRemote 复用凭据与安装步骤，其余平台直接 hostConnect。
        //
        additionalActions={[
          ...remoteActions(project),
          ...(remoteHost && remoteHost.connectionStatus !== "online"
            ? [
                {
                  id: "connect",
                  label: msg("connect"),
                  icon: Plug,
                  run: () =>
                    runProjectAction(async () => {
                      // 远端连接仍经现有意图分派，保留缺凭据、安装和升级流程。
                      if (isDesktop && project.roots[0]) {
                        await onReconnectRemoteWorkspace(
                          buildRemoteHostWorkspaceIdentity(
                            project.hostId,
                            project.roots[0].rootPath,
                          ),
                        );
                      } else {
                        await remoteService!.connectHost(project.hostId);
                      }
                      await refresh();
                    }),
                },
              ]
            : []),
        ]}
        onExpandedChange={(expanded) => onExpandedChange(project, expanded)}
        onRemoveEntry={() =>
          runProjectAction(async () => {
            const entryId = availability?.entryId;
            if (!entryId || !remoteService) throw new Error("remote-project.entry-not-found");
            await remoteService.removeEntry(entryId);
            await refresh();
          })
        }
        onCreate={() =>
          runProjectAction(async () => {
            onCreateTask({
              projectId: project.id,
              taskGroupId: null,
              ...(isWebRemoteControl || remoteHost ? { hostId: project.hostId } : {}),
            });
          })
        }
        onEdit={() => onEdit({ project })}
        onViewFiles={(rootPath) => runProjectAction(() => onViewFiles(project, rootPath))}
        onDelete={() =>
          runProjectAction(async () => {
            await service!.deleteProject(project.id, project.hostId);
            await refresh();
          })
        }
        onPin={() =>
          runProjectAction(async () => {
            await service!.saveProject({
              id: project.id,
              hostId: project.hostId,
              pinned: !project.pinned,
            });
            await refresh();
          })
        }
        // 移动失败时只在本地根目录且确认为缺根的情况下询问补目录。
        // 其它错误原样抛出，由统一动作包装记录并提示。
        // 用户确认后带 repairRoot 标志重试，成功后统一 refreshProjectList。
        //
        onMove={(task) =>
          runProjectAction(async () => {
            if (!service) return;
            try {
              await service.moveTask({ task, projectId: project.id, hostId: project.hostId });
            } catch (cause) {
              if (
                project.hostId !== "local" ||
                !String(cause).includes("project.root-confirmation-required")
              )
                throw cause;
              if (!(await confirm({ title: msg("addFolder"), description: task.workspacePath })))
                return;
              await service.moveTask({
                task,
                projectId: project.id,
                hostId: project.hostId,
                addMissingRoot: true,
              });
            }
            await refresh();
          })
        }
      />
    );
  },
  // 比较器拆出任务数组单独浅比较，其余属性整体浅比较。
  // 任务每秒更新但元素未变时跳过重渲染，这是本文件存在的理由。
  //
  (previous, next) => {
    const { tasks: previousTasks, ...previousProps } = previous;
    const { tasks: nextTasks, ...nextProps } = next;
    return shallow(previousProps, nextProps) && shallow(previousTasks, nextTasks);
  },
);
