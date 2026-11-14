// ==========================================================================
// 文件头不变量表（ProjectCreation.tsx，新建项目外层编排；共 20 条）：
// INV-01 设备列表来源必须二选一：有 Source 管理服务时取快照 servers，缺席时退回 directory.hosts；守住位置：devices 的三元表达式；改错故障：移动端设备下拉为空，新建无法选远端。
// INV-02 设备状态只取聚合映射，缺项按 offline 兜底；守住位置：statuses 与两处 status 赋值；改错故障：未知状态渲染出错误圆点，用户误判设备在线。
// INV-03 设备 id 必须由 buildServerRemoteWorkspaceIdentity 反算，不得手拼字符串；守住位置：devices 映射与 onAddDevice 的 finish；改错故障：新建与登记使用不同 host id，项目在列表里看不到。
// INV-04 workspaceKey 必须按去空白后的 workspaceIdentity 优先、空值回落 workspacePath；守住位置：workspaceKey 赋值；改错故障：空白 identity 让草稿归属错工作区，选中项目串台。
// INV-05 currentScope 必须在每次渲染同步刷新，异步回调只读 ref；守住位置：currentScope.current 赋值；改错故障：保存期间切 tab 后仍把项目绑到旧草稿。
// INV-06 originDraft 只在挂载时采样一次；守住位置：useState 初始化器；改错故障：比较基线随渲染漂移，选项目条件恒真或恒假。
// INV-07 卸载后 active 必须为 false，并让挂起的连接 Promise 以 false 收口；守住位置：空依赖 effect 的 cleanup；改错故障：关闭弹层后 await 永不返回，创建流程悬死。
// INV-08 admittedHosts 必须以 directory.hosts 为初始准入集；守住位置：useRef 初始化；改错故障：已有成员的 Host 被当作未准入，保存直接报 host-removed。
// INV-09 membershipId 变化即视为 Host 被移除，必须抛 host-removed；守住位置：prepareHost 的 previous 比较；改错故障：条目写进已删除的 Host，远端列表不出现。
// INV-10 local Host 不做任何远端准备；守住位置：prepareHost 首行早返回；改错故障：本机新建也去读目录，变慢且可能弹出连接错误。
// INV-11 prepareHost 的每个 await 之后必须复检 active 与 isCurrent；守住位置：两处 creation-cancelled 抛出；改错故障：取消后仍登记 Host，留下孤儿条目。
// INV-12 只有显式创建或选择已有项目才登记 Host；守住位置：onBeforeSave 与 onPrepareExisting 两条入口；改错故障：浏览设备就写入口，列表出现从未打开过的设备。
// INV-13 缺少可用 profile 时必须抛 connection-unavailable；守住位置：prepareHost 的 profile 判定；改错故障：向已退役设备写入 Host，连接永远失败。
// INV-14 远端保存必须先确认 Host 仍准入，再带 expectedMembershipId 登记；守住位置：saved 的 host 校验与 addEntry；改错故障：并发移除后写到旧成员，条目丢失。
// INV-15 登记成功之后才允许本地列表 prepend；守住位置：saved 的 sidebar 分支；改错故障：登记失败仍显示项目，点击后打开失败。
// INV-16 saved 未激活时立即返回，不得继续登记或导航；守住位置：saved 首行与 addEntry 后的复检；改错故障：弹层关闭后用户被强行带进新建项目。
// INV-17 创建后接管必须同时满足 tab 未换、工作区未换、草稿版本与项目 id 未变且无活跃任务；守住位置：saved 的 if 条件；改错故障：覆盖用户正在编辑的另一份草稿。
// INV-18 接管必须携带当前 composer 草稿交接快照；守住位置：onCreateTask 的 initialComposerDraft；改错故障：输入框内容丢失，用户需要重新输入。
// INV-19 设备管理回跳只接受与请求设备同 sourceServerId 的连接结果；守住位置：connectDevice 的 resolve 条件；改错故障：向导改选线路后串写，新建落到别的设备。
// INV-20 suspended 必须覆盖连接中、添加设备中与 tab 已切换三种情况；守住位置：suspended 属性；改错故障：后台表单仍可提交，重复创建项目。
import { captureV4ComposerDraftHandoff } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useEffect, useRef, useState } from "react";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useSourceServerManagementSnapshot } from "@/hooks/useSourceServerManagementSnapshot.js";
import { logger } from "@/logger.js";
import { buildAggregatedSourceStatusMap } from "@/lib/remoteConnectionPresentation.js";
import {
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@/project-sidebar/contract.js";
import type {
  IProjectService,
  IRemoteProjectService,
  RemoteProjectDirectory,
  VirtualProject,
  ProjectSidebarProps,
  ProjectDevice,
} from "@/project-sidebar/contract.js";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";

export function ProjectCreation({
  workspacePath,
  workspaceIdentity,
  onCreateTask,
  projects,
  directory,
  service,
  remoteService,
  onOpenRemoteWorkspace,
  onClose,
  onSaved,
  defaultDeviceId,
  allowDeviceManagement = false,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  onCreateTask: ProjectSidebarProps["onCreateTask"];
  projects: VirtualProject[];
  directory: RemoteProjectDirectory;
  service: IProjectService;
  remoteService: IRemoteProjectService;
  defaultDeviceId?: string;
  allowDeviceManagement?: boolean;
  onOpenRemoteWorkspace?: ProjectSidebarProps["onOpenRemoteWorkspace"];
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  // Root 的动作 controller 没有装配 projection；设备全集必须直接订阅同一个 Source 服务。
  // [权衡] 这里取 optional 服务而不是具名 hook：缺少 Provider 或独立挂载时不能崩，代价是设备全集可能为空。
  // 服务缺席时 devices 退回 directory.hosts，宁可字段少也不让设备下拉消失。
  // snapshotRef 每帧同步，供 prepareHost 的异步分支读取最新快照，await 之后不得再读闭包里的 snapshot。
  // buildAggregatedSourceStatusMap 每次渲染重算，不能缓存：连接状态随时钟推进，缓存会停在旧值。
  // 这个 effect 只写诊断日志、不写状态，删掉不改变行为，保留是为了把设备数量与快照代数对齐。
  // 改错故障：把该服务改成必需依赖，移动端的新建入口整块白屏。
  const management = useOptionalBaseWorkspaceServices()?.sourceServerManagementService;
  const { snapshot } = useSourceServerManagementSnapshot(management);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const statuses = buildAggregatedSourceStatusMap(snapshot);
  useEffect(() => {
    if (snapshot)
      logger.debug("[ProjectCreation] device snapshot", {
        generation: snapshot.generation,
        devices: snapshot.servers.length,
      });
  }, [snapshot]);
  const sidebar = useOptionalProjectDirectory();
  const composerClientNamespace = useComposerClientNamespace();
  const activeTabId = useOptionalTabStore((state) => state.activeTabId);
  const originTabId = useRef(activeTabId);
  // [契约] workspaceKey 是草稿归属的唯一键：identity 去空白后非空优先，否则回落 workspacePath。
  // identity 为空串或纯空白时必须回落，否则同一工作区会算出两个归属，草稿互相读不到。
  // 不在此处做路径归一：两个调用点必须使用上层传入的同一个字符串，各自 normalize 会重新引入不一致。
  // 该值同时参与挂载时采样与保存后比对，两处必须同源，不能各自再算一次。
  // 改错故障：`workspaceKey` 采样与比对不同源，新建成功后草稿停在旧项目上。
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  // [并发] currentScope 是渲染期写的 ref 镜像，异步流程读它才能看到最新的 tab 与工作区。
  // 在渲染期直接赋值是刻意的：放 effect 里会晚一帧，保存完成的那一刻可能仍读到旧 tab。
  // 只读不写回，任何异步分支都不得改这个对象，避免与 React 状态形成双份事实。
  // 它与 originTabId、originDraft 组成对比三元组：一个取最新，两个取挂载时快照。
  // 不要把它改成 state：写入它会触发重渲染，而它的唯一用途是给异步回调取值。
  // 改错故障：读闭包里的 activeTabId，切 tab 后仍判定为同一草稿并强行跳转。
  const currentScope = useRef({ workspaceKey, activeTabId });
  currentScope.current = { workspaceKey, activeTabId };
  // [契约] 挂载时采样一次草稿基线，之后永不更新：它是判断草稿是否被用户改动过的参照。
  // 采样必须走 getWorkspaceState 而不是组件 props，草稿事实只存在于 session store。
  // activeTaskId 与 draftFocusVersion 一并采样，缺一项都会把已开始的任务误判成可接管。
  // useState 初始化器保证只执行一次，不要改成每次渲染读取，否则比对基线会自证成立。
  // workspaceKey 用变量而不是重新拼，确保采样与后续比对落在同一口径上。
  // 改错故障：`originDraft` 随渲染漂移，新建后无条件抢走当前草稿焦点。
  const [originDraft] = useState(() => {
    const { activeTaskId, draftFocusVersion, draftProjectId } = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath, workspaceIdentity);
    return { workspaceKey, activeTaskId, draftFocusVersion, draftProjectId };
  });
  const active = useRef(true);
  // [事务] admittedHosts 是本次弹层会话的准入名单：只有登记成功的 Host 才允许写项目条目。
  // 初值取 directory.hosts，覆盖弹层打开前就已是成员的 Host，避免要求用户重新登记。
  // 准入后仍保留 membershipId：它是成员关系版本，Host 被移除再加回时 id 可能被复用。
  // Map 只增不删，因为一次创建流程内 Host 只应准入一次，删项会让后续校验误判为未准入。
  // prepareHost 与 saved 共用这份名单，两处必须同一实例，不能各自新建一份。
  // 该集合不落盘，弹层关闭即丢弃，持久事实仍以 remoteService 的目录为准。
  // 改错故障：绕过准入直接写条目，会把项目写进用户已经退出的设备。
  const admittedHosts = useRef(new Map(directory.hosts.map((host) => [host.id, host])));
  const [connection, setConnection] = useState<{
    device?: ProjectDevice;
    resolve(ready: boolean): void;
  } | null>(null);
  const [addingDevice, setAddingDevice] = useState(false);
  const addition = useRef<object | null>(null);
  const pendingConnection = useRef(connection);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      addition.current = null;
      pendingConnection.current?.resolve(false);
    };
  }, []);
  // 手机只有既有 Host 的项目权限，没有 Source 管理能力；能力缺席不能抹掉可用设备。
  const devices: ProjectDevice[] = management
    ? (snapshot?.servers ?? []).map((device) => ({
        id: remoteHostIdFromWorkspaceIdentity(
          buildServerRemoteWorkspaceIdentity({
            serverId: device.sourceServerId,
            workspacePath: "/",
          }),
        )!,
        sourceServerId: device.sourceServerId,
        label: device.displayName,
        status: statuses.get(device.sourceServerId) ?? "offline",
      }))
    : directory.hosts.map((host) => ({
        id: host.id,
        label: remoteHostLabel(host),
        status: host.connectionStatus ?? "offline",
      }));
  // [事务] prepareHost 是远端写入的前置闸门：Host 未准入就不允许保存项目条目。
  // 先重读目录再比较，而不是信任 devices 快照：快照可能比服务端晚一个世代。
  // local 直接返回，因为本机项目不涉及 Host 成员关系，任何远端准备都是多余 I/O。
  // 两个 await 之后都要复检，取消语义必须穿透到调用方，不能静默当作成功。
  // 已有成员的 Host 直接复用并返回，不重复 saveHost：重复登记会刷新成员版本，打断别处的 CAS。
  // [失败路径] 解析不到设备或 profile 时抛 connection-unavailable，让上层显示可重试文案而不是崩溃。
  // 抛出的 message 是 i18n key，由 ProjectEditor 的统一格式化转成文案，不要在此拼中文。
  // 改错故障：省略准入直接保存，远端列表与本地视图出现不一致的条目。
  const prepareHost = async (hostId: string, isCurrent = () => active.current) => {
    if (hostId === "local") return;
    const current = (await remoteService.readDirectory()).hosts.find((host) => host.id === hostId);
    if (!active.current || !isCurrent()) throw new Error("project.creation-cancelled");
    const previous = admittedHosts.current.get(hostId);
    // [事务] membershipId 是成员关系的乐观锁：准入后它一变，说明 Host 已被移除或重建。
    // 比较放在读取之后、写入之前，中间没有 await，因此不存在检查与使用之间的竞态窗口。
    // 只比较不刷新：不一致必须抛错让用户重新连接，不能就地覆盖成新成员。
    // 抛出的 host-removed 与 saved 里的同名错误共用一个 key，上层只需处理一种文案。
    // 该检查对本次弹层内新登记的 Host 同样生效，新 Host 也带着自己的 membershipId 入表。
    // 改错故障：把旧成员当新成员继续写，条目挂到已销毁的 Host 上，刷新即消失。
    if (previous && previous.membershipId !== current?.membershipId)
      throw new Error("remote-project.host-removed");
    if (current) {
      admittedHosts.current.set(hostId, current);
      return current;
    }
    const device = devices.find((item) => item.id === hostId);
    const source = snapshotRef.current?.servers.find(
      (item) => item.sourceServerId === device?.sourceServerId,
    );
    const profile =
      source &&
      snapshotRef.current?.profiles.find(
        (item) =>
          item.lifecycleState !== "retired" && item.sourceServerId === source.sourceServerId,
      );
    // [失败路径] 设备能被识别不等于能建连接：只有存在非 retired 的 profile 才允许登记 Host。
    // 退役 profile 仍留在快照里，若只按 sourceServerId 匹配，会给已下线线路建出必然失败的 Host。
    // 这里抛错而不是返回 undefined，是为了让保存流程整体中断，表单保留可重试。
    // profile 必须与 source 同源，不能跨设备借用，否则连接会落到另一台机器。
    // 改错故障：给退役设备建 Host，用户点创建后长时间等待超时，列表还多出一条坏记录。
    if (!profile) throw new Error("project.connection-unavailable");
    // 已识别设备不一定有项目成员；只在显式创建或选择已有项目时登记，浏览设备/列表不写入口。
    const host = await remoteService.saveHost({ id: hostId, target: profile.target });
    if (!active.current || !isCurrent()) throw new Error("project.creation-cancelled");
    admittedHosts.current.set(hostId, host);
    return host;
  };
  // [事务] saved 是已落盘项目的后置编排：远端登记、本地列表投影、草稿接管依次执行。
  // 首行未激活即返回，因为弹层关闭后任何登记或导航都没有接收者，只会制造脏数据。
  // 预检失败直接返回，此时项目已建成但未登记，重试会复用同一 id 而不是新建第二个。
  // onSaved 返回后必须重新读会话状态，不能沿用挂载时的快照，否则看不到用户在保存期间的操作。
  // 顺序不能换：先登记再投影，投影只是本地偏好，回滚成本低于把条目写到错误 Host。
  // 改错故障：登记失败仍执行导航，用户进入一个远端列表里不存在的项目。
  const saved = async (project: VirtualProject) => {
    if (!active.current) return;
    if (project.hostId !== "local") {
      const host = admittedHosts.current.get(project.hostId);
      if (!host) throw new Error("remote-project.host-removed");
      await remoteService.addEntry({
        hostId: project.hostId,
        expectedMembershipId: host.membershipId,
        project: { projectId: project.id, name: project.name, roots: project.roots },
      });
      if (!active.current) return;
      sidebar?.preferences.prepend(project);
    }
    await onSaved();
    const draft = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath, workspaceIdentity);
    // 创建原来只刷新列表，草稿仍绑定旧项目；复用项目选择入口，并拒绝保存期间已失效的草稿。
    if (
      active.current &&
      currentScope.current.activeTabId === originTabId.current &&
      currentScope.current.workspaceKey === originDraft.workspaceKey &&
      !originDraft.activeTaskId &&
      !draft.activeTaskId &&
      draft.draftFocusVersion === originDraft.draftFocusVersion &&
      draft.draftProjectId === originDraft.draftProjectId
    ) {
      // [事务] 只有 tab、工作区、草稿版本与项目 id 全部未变时才允许接管，任一变化都视为用户已另有所指。
      // activeTaskId 非空表示草稿已变成任务，抢占会把任务内容替换成新建项目的入口。
      // 判定靠 originDraft 与实时 draft 逐字段比较，不是引用相等，因为 store 每次返回新对象。
      // 改错故障：用户在保存期间切换 tab 后仍被拉回，输入草稿在另一处被清空。
      logger.debug("[ProjectCreation] select created project for draft", {
        projectId: project.id,
        hostId: project.hostId,
      });
      onCreateTask({
        projectId: project.id,
        hostId: project.hostId,
        taskGroupId: draft.draftTaskGroupId ?? null,
        initialComposerDraft: captureV4ComposerDraftHandoff(
          workspacePath,
          workspaceIdentity,
          composerClientNamespace,
        ),
      });
    }
  };
  const connectDevice = async (device: ProjectDevice): Promise<boolean> => {
    if (allowDeviceManagement && onOpenRemoteWorkspace) {
      return new Promise((resolve) => {
        const request = { device, resolve };
        pendingConnection.current = request;
        setConnection(request);
        const accepted = onOpenRemoteWorkspace({
          completion: "device-management",
          preferredSourceServerId: device.sourceServerId,
          returnTarget: {
            kind: "connect-device",
            isCurrent: () => active.current && pendingConnection.current === request,
            finish: (result) => {
              if (!active.current || pendingConnection.current !== request) return;
              pendingConnection.current = null;
              setConnection(null);
              // 原目录/已有项目 continuation 只接受所选 Source，不能被向导改选线路串写。
              resolve(
                result.kind === "connected" && result.sourceServerId === device.sourceServerId,
              );
            },
          },
        });
        if (accepted === false) {
          pendingConnection.current = null;
          setConnection(null);
          resolve(false);
        }
      });
    }
    const host = await remoteService.connectHost(device.id);
    if (!active.current) return false;
    admittedHosts.current.set(host.id, host);
    return true;
  };
  return (
    <>
      <ProjectEditor
        project={null}
        projects={projects}
        service={service}
        devices={devices}
        defaultDeviceId={defaultDeviceId}
        onClose={onClose}
        onSaved={saved}
        onBeforeSave={async (hostId) => {
          await prepareHost(hostId);
        }}
        remoteService={remoteService}
        onSavedExisting={async (isCurrent) => {
          await onSaved();
          if (active.current && isCurrent?.()) onClose();
        }}
        onPrepareExisting={async (hostId, isCurrent) => {
          const host = await prepareHost(hostId, isCurrent);
          if (!host) throw new Error("remote-project.host-removed");
          return host;
        }}
        onBrowseExisting={(device) =>
          device.status === "online" ? Promise.resolve(true) : connectDevice(device)
        }
        // 后台取消只解除连接等待，原草稿在用户回到原 tab 前仍保持隐藏。
        suspended={Boolean(connection) || addingDevice || activeTabId !== originTabId.current}
        onConnectDevice={connectDevice}
        onAddDevice={
          allowDeviceManagement && onOpenRemoteWorkspace
            ? (selectDevice) => {
                const request = {};
                addition.current = request;
                setAddingDevice(true);
                const accepted = onOpenRemoteWorkspace({
                  completion: "device-management",
                  returnTarget: {
                    kind: "add-device",
                    isCurrent: () => active.current && addition.current === request,
                    finish: async (result) => {
                      if (!active.current || addition.current !== request) return;
                      addition.current = null;
                      setAddingDevice(false);
                      if (result.kind === "connected" && result.sourceServerId) {
                        // 返回仍走同一个设备切换入口，不能绕过原草稿的目录确认。
                        await selectDevice(
                          remoteHostIdFromWorkspaceIdentity(
                            buildServerRemoteWorkspaceIdentity({
                              serverId: result.sourceServerId,
                              workspacePath: "/",
                            }),
                          )!,
                        );
                      }
                    },
                  },
                });
                if (accepted === false) {
                  addition.current = null;
                  setAddingDevice(false);
                }
              }
            : undefined
        }
      />
    </>
  );
}
