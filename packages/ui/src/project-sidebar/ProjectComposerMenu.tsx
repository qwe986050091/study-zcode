// ==========================================================================
// 职责边界（ProjectComposerMenu.tsx）
// 做：
//   - 渲染 workspace chip 菜单：选项目、脱离项目、新建项目、远程连接。
//   - 维护远程连接的返回意图与提交门禁 pending。
// 不做：
//   - 不持有项目目录事实；树、项目、可用性全部来自 useProjectDirectory。
//   - 不创建任务、不写草稿；一律回调 onCreateTask 交给 Root。
//   - 不管理远程会话生命周期，只提供 isCurrent 校验与完成结果接缝。
// 依赖：
//   - zcodeSessionStore 的 draftProjectId、activeTaskId、draftFocusVersion 决定聊天身份。
//   - ComposerSubmissionPendingContext 向输入区同步提交门禁。
// 边界：
//   - chatKey 变化即视为换聊天，旧返回意图必须整体失效。
//   - pending 只能在连接被接受、目录确认完成或取消时改变，禁止乐观解除。
//   - 组件只做投影，持久化状态必须先回到 store 再渲染。
//
// INV 不变量表（18 条；破坏任一条会让旧草稿意图复活或门禁卡死）：
// INV-01 断言：chatKey 由 workspaceKey、activeTaskId、projectId、draftVersion 四元组决定 —— 守住它的位置：currentChat ref 的比较与替换 —— 改错故障：换聊天后旧返回意图仍然通过 isCurrent
// INV-02 断言：isCurrent 必须同时校验 mounted、chat 引用、operation 序号与 store 四元组 —— 守住它的位置：addDevice 内闭包 —— 改错故障：迟到回调把旧草稿重新挂成当前连接
// INV-03 断言：operation 每次打开远程连接自增，取消也要自增 —— 守住它的位置：addDevice 与 cancelSelection —— 改错故障：上一轮完成回调覆盖新一轮状态
// INV-04 断言：pending 与 setSubmissionPending 同步更新，不能只改其一 —— 守住它的位置：addDevice 所有分支与门禁 effect —— 改错故障：输入区门禁与菜单状态不一致，会话卡死或提前放行
// INV-05 断言：连接成功不等于可以提交，目录未确认前 pending 保持 true —— 守住它的位置：finish 的 connected 分支 —— 改错故障：项目未确定就解除门禁，草稿发到错误工作区
// INV-06 断言：canFinish 只在 isCurrent 且成员仍在目录中时返回 true —— 守住它的位置：async canFinish —— 改错故障：已被移除的设备借显式继续重新登记
// INV-07 断言：canFinish 内 readDirectory 的结果必须二次校验 isCurrent —— 守住它的位置：await 之后的判断 —— 改错故障：等待期间切换聊天，结果仍被接受
// INV-08 断言：validatedHost 只能由通过的 canFinish 写入 —— 守住它的位置：validatedHost 赋值点 —— 改错故障：未校验主机被当作已确认设备继续创建
// INV-09 断言：onVisibilityChange 只改门禁，不关闭已建立的返回意图 —— 守住它的位置：onVisibilityChange —— 改错故障：后台收起后原草稿永久无法继续
// INV-10 断言：cancelSelection 必须清空 connectedDevice 与 pending 并触发焦点回归 —— 守住它的位置：cancelSelection —— 改错故障：取消后弹窗状态残留，再次打开串台
// INV-11 断言：accepted 为 false 时走 cancelSelection，而不是静默忽略 —— 守住它的位置：addDevice 末尾 —— 改错故障：点击菜单无反馈，pending 永久为 true
// INV-12 断言：returnFocus 递增是焦点恢复的唯一触发器 —— 守住它的位置：依赖 returnFocus 的 effect —— 改错故障：弹窗关闭后焦点留在已卸载节点
// INV-13 断言：workspaceKey 统一取 identity 去空白后的值，否则回落 path —— 守住它的位置：workspaceKey 常量 —— 改错故障：同一远程工作区被拆成两个草稿桶
// INV-14 断言：createProjectTask 只在无 activeTaskId 时读取 draftTaskGroupId —— 守住它的位置：createProjectTask —— 改错故障：已有会话被错误归入草稿分组
// INV-15 断言：canUseRemoteWorkspace 必须同时满足壳层开关、全局可见性与回调存在 —— 守住它的位置：canUseRemoteWorkspace —— 改错故障：Web 空态露出必然失败的远程入口
// INV-16 断言：canDetachProject 必须在无 hostId 时才成立 —— 守住它的位置：canDetachProject —— 改错故障：远程项目显示脱离按钮，点击后草稿归属丢失
// INV-17 断言：菜单打开远程弹窗不得阻止 DropdownMenu 默认关闭 —— 守住它的位置：远程菜单项 onSelect —— 改错故障：父菜单覆盖 modal，弹窗无法交互
// INV-18 断言：currentProject 必须同时匹配 projectId 与 hostId —— 守住它的位置：projects.find —— 改错故障：跨设备同名项目被误判为当前项目
import { ComposerSubmissionPendingContext } from "@/project-sidebar/ComposerSubmissionPendingContext.js";
import { ChatRemoteFolderSelection } from "@/project-sidebar/ChatRemoteFolderSelection.js";
import { RemoteIdentityHoverCard } from "@/project-sidebar/RemoteIdentityHoverCard.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import type { ReactNode } from "react";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group.js";
import {
  ChevronDownIcon,
  Cloud,
  FolderPlus,
  MessageCircle,
  Plus,
  SearchIcon,
  X,
} from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useRemoteConnectionEntryVisibility } from "@/hooks/useRemoteConnectionEntryVisibility.js";
import { cn } from "@/components/lib/utils.js";
import { logger } from "@/logger.js";
import { buildServerRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  TID_COMPOSER_PROJECT_DETACH,
  TID_COMPOSER_REMOTE_CONNECTION,
  TID_COMPOSER_WORK_OUTSIDE_PROJECT,
  TID_COMPOSER_WORKSPACE_TRIGGER,
} from "@zcode/shared/test-ids";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";

import type { ProjectSidebarProps, RemoteProjectHost } from "@/project-sidebar/contract.js";
import { remoteHostIdFromWorkspaceIdentity } from "@/project-sidebar/contract.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import { ProjectCreation } from "@/project-sidebar/ProjectCreation.js";
import { ProjectFolderIcon } from "@/project-sidebar/ProjectFolderIcon.js";
import { projectKey, projectSourceServerId } from "@/project-sidebar/view.js";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

export function ProjectComposerMenu({
  workspacePath,
  workspaceIdentity,
  compactForRemoteControl = false,
  allowConversationWorkspaceSelection = true,
  allowConversationWorkspaceDetach = allowConversationWorkspaceSelection,
  onCreateTask,
  onSelectConversationWorkspace,
  allowRemoteWorkspace = true,
  onOpenRemoteWorkspace,
  containerClassName,
  triggerClassName,
  triggerIndicator,
  showEditProject = false,
  children,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  compactForRemoteControl?: boolean;
  allowConversationWorkspaceSelection?: boolean;
  /** 是否显示项目 chip 的快捷脱离按钮；默认跟随非项目工作区选择能力。 */
  allowConversationWorkspaceDetach?: boolean;
  onCreateTask: ProjectSidebarProps["onCreateTask"];
  onSelectConversationWorkspace: () => void | Promise<void>;
  allowRemoteWorkspace?: boolean;
  onOpenRemoteWorkspace?: ProjectSidebarProps["onOpenRemoteWorkspace"];
  onConnectRemote?: ProjectSidebarProps["onConnectRemote"];
  onCancelRemote?: ProjectSidebarProps["onCancelRemoteProject"];
  /** 调用方局部调整 workspace chip 外层视觉，不改变普通会话默认样式。 */
  containerClassName?: string;
  /** 调用方局部调整 workspace trigger 视觉，不改变普通会话默认样式。 */
  triggerClassName?: string;
  /** 调用方局部替换尾部 indicator；普通会话继续使用默认 Lucide chevron。 */
  triggerIndicator?: ReactNode;
  /** 聊天头部启用当前项目编辑，其他项目选择器保持原有入口。 */
  showEditProject?: boolean;
  /** 分支等控件位于项目选择器与编辑按钮之间。 */
  children?: ReactNode;
}) {
  // [契约] intl 只用于文案，不允许在这里缓存格式化结果，语言切换必须立即生效。
  // 不要把它提到模块级：模块加载时 Provider 还没就绪。
  // 依赖数组里也不要放 intl：每轮渲染引用变化会让回调无谓重建。
  // 改错后果：切换语言后菜单文案停留在旧语言。
  const { intl } = useZCodeIntl();
  // [契约] 搜索词是菜单的纯本地状态，关闭菜单不重置，便于连续挑选。
  // 它只参与 visibleProjects 的过滤，不写回任何 store。
  // 不要提升为受控 prop：调用方不应知道菜单内部的搜索行为。
  // 改错后果：workspaceSearchQuery 被提升为受控 prop 后每次开菜单清空，多项目场景反复输入。
  const [workspaceSearchQuery, setWorkspaceSearchQuery] = useState("");
  // [契约] 远程入口可见性来自独立 hook，只反映壳层能力，不算业务判断。
  // 它必须在组件顶层调用，再与 allowRemoteWorkspace 组合，不能放进条件分支。
  // 不要在这里再查 feature flag：hook 已经封装了订阅与默认值。
  // 改错后果：远程能力关闭后菜单仍露出入口，点击必然失败。
  const showRemoteConnectionEntry = useRemoteConnectionEntryVisibility();
  // Bugfix: Web 普通模式没有完整远程 workspace 会话链路，不能只依赖全局 feature visibility。
  // 这里叠加壳层能力开关，确保本地 Web 模式的空态菜单不会露出必然失败的远程连接入口。
  // [契约] 三个条件缺一不可：壳层允许、全局可见、调用方提供 openRemoteWorkspace。
  // 曾只依赖全局可见性，导致 Web 模式露出必然失败的入口。
  // 不要用或运算合并条件：任一缺失都会造成死链。
  // 改错后果：用户点开远程连接，流程在 Root 处直接返回，看起来像卡住。
  const canUseRemoteWorkspace =
    allowRemoteWorkspace && showRemoteConnectionEntry && Boolean(onOpenRemoteWorkspace);
  const {
    tree,
    projects,
    availability,
    directory,
    deviceNames,
    error,
    service,
    remoteService,
    refresh,
  } = useProjectDirectory();
  // [契约] 身份 key 统一为 identity 去空白后的值，否则回落 workspacePath。
  // 这是草稿、会话、队列共用的 key 规则，组件内不得另写一份。
  // 不要用 path 单独作 key：同一路径可能属于不同远端身份。
  // 改错后果：远程与本地会话共用草稿，切换后草稿串台。
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  // [契约] 当前项目身份只从 store 的 draftProjectId 读取，不从 tree 或 cwd 推断。
  // selector 只取一个字段，避免整个 workspace 对象变化触发重渲染。
  // 不要在渲染里再调 getState 取同一字段：会出现两套事实。
  // 改错后果：项目 chip 与菜单勾选状态不一致。
  const projectId = useZCodeSessionStore((state) => state.workspaces[workspaceKey]?.draftProjectId);
  const activeTaskId = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.activeTaskId,
  );
  // [契约] 这是菜单内唯一允许发起任务创建的出口，必须保留 onCreateTask 的原始签名。
  // taskGroupId 只在没有 activeTaskId 时从草稿 owner 读取，已被接受的会话不归草稿组。
  // 不要在这里补 projectId：调用方传入的才是组织意图。
  // 改错后果：已有会话的新任务被塞进草稿分组，侧栏位置跳变。
  const createProjectTask: ProjectSidebarProps["onCreateTask"] = (request) =>
    onCreateTask(
      typeof request === "object"
        ? {
            ...request,
            // 远程目录确认曾遗漏草稿分组；两个项目入口必须从同一草稿 owner 读取组织意图。
            taskGroupId: !activeTaskId
              ? useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
                  .draftTaskGroupId
              : null,
          }
        : request,
    );
  const draftVersion = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftFocusVersion,
  );
  // 草稿重建和聊天切换都会使旧返回意图失效，即使后来又回到同一路径也不能复活旧操作。
  // [事务] chatKey 四元组是聊天身份的唯一指纹，元素顺序参与序列化，不能随意调整。
  // 它同时驱动 pending 重置、返回意图失效与提交门禁 effect。
  // 不要把 items 或时间戳塞进来：无关渲染会被误判为换聊天。
  // 改错后果：把 items 或时间戳塞进 chatKey 会让门禁在正常交互中被重置，旧意图则永久存活。
  const chatKey = JSON.stringify([workspaceKey, activeTaskId, projectId, draftVersion]);
  // [契约] currentChat 是可变 ref，用于身份相等比较，不参与渲染。
  // 它保存对象引用而不是 key 字符串，isCurrent 依赖引用相等。
  // 不要换成 state：比较发生在异步回调里，需要读到最新值。
  // 改错后果：isCurrent 永远返回 false，连接成功后无法挂载设备。
  const currentChat = useRef({ key: chatKey });
  // [事务] key 变化时整体替换 ref 对象，旧对象引用立刻失效。
  // 必须替换对象而不是只改 key 字段：闭包捕获的是对象引用。
  // 这一步必须在任何异步操作之前执行，否则回调仍指向旧聊天。
  // 改错后果：换聊天后旧连接结果被写入新聊天。
  if (currentChat.current.key !== chatKey) currentChat.current = { key: chatKey };
  const chat = currentChat.current;
  // [资源] mounted 由 layout effect 维护，卸载时置 false，用于阻断迟到回调。
  // 必须在 layout 阶段重置为 true，普通 effect 会在首帧之后才生效。
  // 不要用 AbortController 替代：这里只关心组件是否还挂着。
  // 改错后果：卸载后的异步结果仍然 setState，触发告警且状态脏写。
  const mounted = useRef(true);
  // [并发] operation 是单调递增的请求序号，每次打开远程连接自增一次。
  // 取消、重开、被拒绝都必须自增，否则上一轮结果仍能通过 isCurrent。
  // 不要用 Date.now 或 Math.random：operation 序号需要可比较且无碰撞。
  // 改错后果：快速连点两次菜单，先发起的回调覆盖后发起的状态。
  const operation = useRef(0);
  // [资源] trigger 指向 chip 按钮，仅用于焦点回归，不参与业务判断。
  // 它必须直接挂在 DropdownMenuTrigger 的 Button 上，不能被 Tooltip 包裹。
  // 不要在渲染期读 trigger.current，只能在 effect 或事件里读。
  // 改错后果：弹窗关闭后焦点落到 body，键盘用户丢失位置。
  const trigger = useRef<HTMLButtonElement>(null);
  // [契约] connectedDevice 保存待选目录的设备快照，isCurrent 在打开时捕获。
  // 它不是设备事实的来源，只是本次连接结果的临时载体。
  // 不要把它持久化或提升到 store：刷新后必须重新连接。
  // 改错后果：把 connectedDevice 持久化后，重启仍显示已失效的设备弹窗。
  const [connectedDevice, setConnectedDevice] = useState<{
    sourceServerId: string;
    host?: RemoteProjectHost;
    isCurrent(): boolean;
  } | null>(null);
  // [契约] 上下文允许为 undefined，所有调用都必须用可选链，不能改成默认空函数。
  // 默认空函数会掩盖 Provider 缺失，让门禁静默失效。
  // 它只同步布尔值，不承载任何业务状态。
  // 改错后果：没有 Provider 时输入区无法阻止提交，草稿被并发发出。
  const setSubmissionPending = useContext(ComposerSubmissionPendingContext);
  // [事务] pending 表示当前聊天正在等待连接结果，只由连接流程改写。
  // 它与 setSubmissionPending 必须成对更新，任何单边赋值都是 bug。
  // 不要在 chatKey 变化之外的地方重置它：换聊天才代表意图失效。
  // 改错后果：连接失败后输入框永久禁用，用户只能刷新应用。
  const [pending, setPending] = useState(false);
  // [契约] restoredChat 是已返回原聊天的投影，只用于展示恢复提示。
  // 它保存 chat 引用而不是布尔值，确保换聊天后旧提示自动消失。
  // 不要在渲染中 setRestoredChat：会造成渲染期状态更新。
  // 改错后果：切到别的聊天仍显示上一轮的已返回提示。
  const [restoredChat, setRestoredChat] = useState<typeof chat | null>(null);
  useEffect(() => {
    setSubmissionPending?.(pending);
    return () => setSubmissionPending?.(false);
  }, [pending, chatKey, setSubmissionPending]);
  useEffect(() => {
    setPending(false);
  }, [chatKey]);
  // [事务] 取消顺序固定：标记 restoredChat、递增 operation、清设备、清门禁、触发焦点。
  // operation 自增必须在清设备之前，否则旧回调仍会通过 isCurrent。
  // 它同时清 pending 与 context，不能只清本地状态。
  // 改错后果：取消后旧连接完成回调重新打开目录选择弹窗。
  const cancelSelection = () => {
    setRestoredChat(chat);
    operation.current++;
    setConnectedDevice(null);
    setPending(false);
    setSubmissionPending?.(false);
    setReturnFocus((version) => version + 1);
  };
  const [creating, setCreating] = useState(false);
  const [editingChat, setEditingChat] = useState<typeof chat | null>(null);
  const [returnFocus, setReturnFocus] = useState(0);
  // 旧连接弹窗在被动 effect 中释放焦点锁；layout 阶段聚焦会被拉回即将卸载的按钮。
  // 同轮清理结束后恢复原菜单焦点，不依赖延时，也不移动聊天草稿。
  useEffect(() => {
    if (returnFocus) {
      trigger.current?.focus();
      logger.debug("[ProjectComposerMenu] 返回聊天焦点", {
        restored: document.activeElement === trigger.current,
        inert: Boolean(trigger.current?.closest("[inert]")),
      });
    }
  }, [returnFocus]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // [事务] 打开连接的入口：先清 restoredChat、取序号、快照目录，再置 pending。
  // originalHosts 必须在打开前快照，用于之后判断成员是否被移除或换代。
  // accepted 为 false 必须走 cancelSelection，不能留下 pending。
  // 改错后果：连接入口被拒后菜单一直显示加载，无法再次点击。
  const addDevice = () => {
    setRestoredChat(null);
    const request = ++operation.current;
    const originalHosts = directory.hosts;
    let validatedHost: RemoteProjectHost | undefined;
    setConnectedDevice(null);
    setPending(true);
    setSubmissionPending?.(true);
    // [并发] 判定条件必须同时包含 mounted、chat 引用、operation 序号与 store 四元组。
    // Store 先提交、React 后渲染，中间的间隙正是迟到结果最容易误判的窗口。
    // 不要只比较 workspaceKey：草稿版本变化也算换聊天。
    // 改错后果：旧草稿意图在切换后复活，任务被创建到已离开的项目。
    const isCurrent = () => {
      const draft = useZCodeSessionStore.getState().workspaces[workspaceKey];
      // Store 先提交、React 后渲染；迟到结果不能利用这一间隙复活旧草稿意图。
      return (
        mounted.current &&
        currentChat.current === chat &&
        operation.current === request &&
        draft?.activeTaskId === activeTaskId &&
        draft?.draftProjectId === projectId &&
        draft?.draftFocusVersion === draftVersion
      );
    };
    // [契约] 返回值只用于区分已接管与立刻拒绝，false 必须显式处理。
    // 传出的 completion 与 returnTarget 是 Root 的唯一接缝，不要新增字段。
    // 回调必须捕获 isCurrent 与 validatedHost，不能依赖组件后续渲染。
    // 改错后果：Root 已接管流程，菜单却按拒绝处理并清空状态。
    const accepted = onOpenRemoteWorkspace?.({
      completion: "device-management",
      returnTarget: {
        kind: "add-device",
        isCurrent,
        // [契约] 这是显式继续前的最后一道校验，返回 true 才允许登记设备。
        // 首次设备尚未进入目录时返回 true，让目录确认流程继续。
        // 成员已移除或换代时必须返回 false，并在 await 后二次校验 isCurrent。
        // 改错后果：canFinish 不在 await 后二次校验 isCurrent，已下线设备借继续按钮重新登记。
        async canFinish(result) {
          if (!isCurrent()) return false;
          if (result.kind !== "connected" || !result.sourceServerId) return true;
          const hostId = remoteHostIdFromWorkspaceIdentity(
            buildServerRemoteWorkspaceIdentity({
              serverId: result.sourceServerId,
              workspacePath: "/",
            }),
          );
          const original = originalHosts.find((host) => host.id === hostId);
          // 后台等待期间已移除/换代的成员不能借显式继续重新登记；首次设备仍在确认目录时登记。
          if (!original) return true;
          const latest = await remoteService?.readDirectory();
          if (
            !isCurrent() ||
            !latest?.hosts.some(
              (host) => host.id === original.id && host.membershipId === original.membershipId,
            )
          )
            return false;
          validatedHost = original;
          return true;
        },
        // [事务] 可见性变化只改门禁，不改变返回意图，也不关闭设备选择。
        // 曾经门禁不随收起解除，导致原草稿无法继续本地工作。
        // 必须同时更新 pending 与 context，否则输入区状态分裂。
        // 改错后果：用户返回聊天后仍无法发送，必须重启应用。
        onVisibilityChange(visible) {
          if (!isCurrent()) return;
          // 后台连接只保留返回意图；曾因门禁未随收起解除，原草稿无法继续本地工作。
          setPending(visible);
          setSubmissionPending?.(visible);
        },
        // [事务] 完成分支固定：connected 且有 sourceServerId 时保持门禁并挂载设备。
        // 连接只证明设备可用，目录与项目仍未确定，不能提前解除门禁。
        // 取消且非后台时必须恢复 restoredChat 并触发焦点回归。
        // 改错后果：连接成功后立刻放行提交，任务落到未确认的工作区。
        finish(result) {
          if (!isCurrent()) return;
          // 连接只证明设备可用；目录与项目仍未确定，不能提前解除原草稿的提交门禁。
          if (result.kind === "connected" && result.sourceServerId) {
            setPending(true);
            setSubmissionPending?.(true);
            setConnectedDevice({
              sourceServerId: result.sourceServerId,
              host: validatedHost,
              isCurrent,
            });
          } else {
            if (result.kind === "cancelled" && !result.background) setRestoredChat(chat);
            setPending(false);
            setSubmissionPending?.(false);
          }
          if (result.kind === "cancelled" && !result.background)
            setReturnFocus((version) => version + 1);
        },
      },
    });
    if (accepted === false) cancelSelection();
  };
  const currentDevice = connectedDevice?.isCurrent() ? connectedDevice : null;
  // [契约] hostId 由 workspaceIdentity 反解，空 identity 时为 null，表示本地。
  // 它决定云图标、项目匹配与脱离按钮的可见性，不能由 path 推断。
  // 不要在这里 trim 或重建 identity：统一走 remoteHostIdFromWorkspaceIdentity。
  // 改错后果：远程工作区被当成本地，菜单显示错误的项目集合。
  const hostId = workspaceIdentity ? remoteHostIdFromWorkspaceIdentity(workspaceIdentity) : null;
  // 原因：目录可以属于多个项目，tab/cwd 不能决定归属；只读草稿的项目身份。
  // [契约] 当前项目必须同时匹配 projectId 与 hostId，缺一不可。
  // 本地场景还要排除 entryId 非空的项目，避免把远程项目当成本地。
  // 目录可以属于多个项目，tab 与 cwd 都不能决定归属。
  // 改错后果：currentProject 漏掉 hostId 匹配会让跨设备同名项目被误判，编辑动作打错目标。
  const currentProject = projects.find(
    (project) =>
      project.id === projectId &&
      (hostId ? project.hostId === hostId : !availability.get(projectKey(project))?.entryId),
  );
  // [契约] 编辑入口要求：调用方开启、有当前项目、非 legacy 单根、在线、服务可用。
  // 在线判断默认 true，缺目录信息时不应阻断编辑。
  // 不要在这里补 hostId 判断：currentProject 已经做过身份匹配。
  // 改错后果：离线项目仍可点编辑，保存时必然失败。
  const canEditProject =
    showEditProject &&
    currentProject &&
    !currentProject.legacySingleRoot &&
    (availability.get(projectKey(currentProject))?.online ?? true) &&
    Boolean(service);
  const isConversationWorkspace = !currentProject;
  // [契约] canDetachProject 必须同时满足无 hostId、允许选择与允许脱离三个条件。
  // hostId 存在时必须为 false：远程项目的脱离会破坏身份绑定。
  // 默认值跟随选择能力，不要硬编码 true。
  // 改错后果：canDetachProject 必须排除 hostId 非空的远程项目，否则 X 按钮会让草稿归属丢失。
  const canDetachProject =
    !hostId &&
    allowConversationWorkspaceSelection &&
    allowConversationWorkspaceDetach &&
    !isConversationWorkspace;
  // [契约] 过滤字段固定为项目名、设备名、全部根路径，任一命中即可见。
  // 设备名优先取 deviceNames，缺失时回退到 remoteHostLabel。
  // 依赖数组必须包含 projects、搜索词、deviceNames 与 directory.hosts。
  // 改错后果：连接新设备后搜索不到其项目，或旧列表不刷新。
  const visibleProjects = useMemo(() => {
    const query = workspaceSearchQuery.trim().toLowerCase();
    return projects.filter((project) =>
      [
        project.name,
        deviceNames?.get(projectSourceServerId(project) ?? "") ||
          (() => {
            const host = directory.hosts.find((host) => host.id === project.hostId);
            return host ? remoteHostLabel(host) : "";
          })(),
        ...project.roots.map((root) => root.rootPath),
      ].some((text) => text.toLowerCase().includes(query)),
    );
  }, [projects, workspaceSearchQuery, deviceNames, directory.hosts]);
  // [契约] 标题优先用当前项目名，没有项目时回退到选择项目文案。
  // currentWorkspaceTitle 只做展示，不参与身份判断。
  // 不要在标题里拼接设备名：chip 宽度受限，长文案会挤坏布局。
  // 改错后果：远程项目标题过长导致 chip 溢出，遮挡相邻控件。
  const currentWorkspaceTitle =
    currentProject?.name ?? intl.formatMessage({ id: "chat.empty.selectProject" });
  // [契约] 图标与脱离按钮共用同一位置，只有可脱离时才在 hover/focus 时隐藏图标。
  // 不可脱离时必须保留图标，避免 X 叠在图标上。
  // 两个 group 变体要同时出现，否则键盘用户看不到脱离按钮。
  // 改错后果：定时任务等禁用脱离的场景里，图标与 X 重叠。
  const currentWorkspaceIconClassName = cn(
    "size-4 text-foreground-subtle transition-opacity",
    // Bugfix: 关闭按钮和项目图标占用同一位置。只有允许脱离项目时才隐藏底层图标，
    // 否则 X 会直接叠在图标上；定时任务禁用该能力时则让项目图标保持可见。
    canDetachProject &&
      "group-hover/workspace-chip:opacity-0 group-focus-within/workspace-chip:opacity-0",
  );

  // [契约] menu 是纯 JSX 片段，不允许在这里调用 hook 或读取 DOM。
  // 它必须只依赖上方已派生的变量，保证每次渲染行为可预测。
  // 不要在 JSX 内新增条件 setState：事件回调里才允许。
  // 改错后果：渲染期副作用导致无限重渲染或状态错乱。
  const menu = (
    <DropdownMenu>
      <div
        className={cn(
          "group/workspace-chip relative flex min-w-0 items-center rounded-full hover:bg-surface-hover focus-within:bg-surface-hover",
          containerClassName,
        )}
      >
        {canDetachProject ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="pointer-events-none absolute left-1.5 z-10 rounded-full text-foreground-subtle opacity-0 transition-opacity group-hover/workspace-chip:pointer-events-auto group-hover/workspace-chip:opacity-100 group-focus-within/workspace-chip:pointer-events-auto group-focus-within/workspace-chip:opacity-100"
            aria-label={intl.formatMessage({ id: "chat.empty.detachProject" })}
            data-testid={TID_COMPOSER_PROJECT_DETACH}
            onClick={(event) => {
              event.stopPropagation();
              void runUserActionAsync({
                input: {
                  featureId: "workspace.project_binding",
                  action: "detach",
                  trigger: "button",
                },
                operation: () => Promise.resolve(onSelectConversationWorkspace()),
                completed: { resultSource: "optimistic_projection" },
                failureStage: "project_detach",
              });
            }}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="default"
            className={cn(
              "min-w-0 rounded-full bg-transparent text-ui-base/relaxed hover:bg-transparent",
              // Bugfix: 远程控制页面空态文案区域更窄，workspacePath 过长会把同一行挤坏。
              // 这里在远控模式收紧菜单触发按钮宽度，让超长路径在按钮内走省略号。
              compactForRemoteControl ? "max-w-44 pl-3 pr-2" : "max-w-[15rem] pl-3 pr-2",
              triggerClassName,
            )}
            ref={trigger}
            aria-label={intl.formatMessage({ id: "chat.empty.workspaceMenu" })}
            data-testid={TID_COMPOSER_WORKSPACE_TRIGGER}
          >
            {hostId ? (
              <Cloud className={currentWorkspaceIconClassName} />
            ) : (
              <ProjectFolderIcon
                rootCount={currentProject?.roots.length ?? 0}
                className={currentWorkspaceIconClassName}
              />
            )}
            <span className="block max-w-full truncate">{currentWorkspaceTitle}</span>
            {triggerIndicator ?? <ChevronDownIcon className="size-3.5 text-foreground-subtle" />}
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent
        data-testid="composer-project-menu"
        align="start"
        side="top"
        className="flex w-72 max-w-[calc(100vw-2rem)] flex-col p-0"
      >
        <div
          data-slot="command-input-wrapper"
          className="shrink-0 p-1 border-b border-border"
          onKeyDown={(event) => event.stopPropagation()}
        >
          <InputGroup className="h-8 border-0 !bg-transparent hover:border-input-border-hover ">
            <input
              data-slot="command-input"
              value={workspaceSearchQuery}
              placeholder={intl.formatMessage({
                id: "chat.empty.workspaceSearchPlaceholder",
              })}
              onChange={(event) => setWorkspaceSearchQuery(event.target.value)}
              className="w-full text-ui-base/relaxed text-foreground outline-hidden placeholder:text-foreground-subtlest disabled:cursor-not-allowed disabled:opacity-50"
            />
            <InputGroupAddon>
              <SearchIcon className="size-4 shrink-0 text-foreground-subtlest" />
            </InputGroupAddon>
          </InputGroup>
        </div>
        <div className="flex min-h-0 flex-col p-1">
          {error ? (
            <div role="alert" className="px-2 py-2 text-ui-base text-destructive">
              {error}
            </div>
          ) : null}
          <div className="min-h-0 max-h-60 overflow-y-auto">
            {visibleProjects.map((project) => {
              const state = availability.get(projectKey(project));
              const isRemoteWorkspace =
                Boolean(state?.entryId) || Boolean(hostId && hostId === project.hostId);
              const disabled = state?.online === false;
              const remoteHost = directory.hosts.find((host) => host.id === project.hostId);
              const deviceName =
                deviceNames?.get(projectSourceServerId(project) ?? "") ||
                (remoteHost ? remoteHostLabel(remoteHost) : undefined);
              return (
                <RemoteIdentityHoverCard
                  key={projectKey(project)}
                  host={remoteHost}
                  title={project.name}
                  projectName={project.name}
                  deviceName={deviceName}
                  paths={project.roots.map((root) => root.rootPath)}
                  anchorToMenu
                  contentClassName="z-[60] max-w-(--radix-hover-card-content-available-width)"
                >
                  <span className="block min-w-0">
                    <DropdownMenuCheckboxItem
                      data-project-id={project.id}
                      data-project-host={project.hostId}
                      data-project-name={project.name}
                      checked={currentProject === project}
                      disabled={disabled}
                      onSelect={() => {
                        logger.info("[ProjectComposerMenu] 选择项目", {
                          projectId: project.id,
                          hostId: project.hostId,
                        });
                        runUserAction({
                          input: {
                            featureId: "workspace.project_binding",
                            action: isConversationWorkspace ? "attach" : "switch",
                            trigger: "menu",
                            workspaceKind: isRemoteWorkspace ? "remote" : "local",
                          },
                          // 同侧栏项目新建入口：由 Root/Host 解析主要目录及远程 attachment。
                          operation: () =>
                            createProjectTask({
                              projectId: project.id,
                              ...(compactForRemoteControl ||
                              directory.hosts.some((host) => host.id === project.hostId)
                                ? { hostId: project.hostId }
                                : {}),
                            }),
                          completed: { resultSource: "local_commit" },
                          failureStage: "project_switch",
                        });
                      }}
                    >
                      {isRemoteWorkspace ? (
                        <Cloud className="size-4 text-foreground-subtle" />
                      ) : (
                        <ProjectFolderIcon
                          rootCount={project.roots.length}
                          className="size-4 text-foreground-subtle"
                        />
                      )}
                      {/* 不同字号按框居中会让设备名基线上浮；文字单独对齐基线，外层图标仍居中。 */}
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate">{project.name}</span>
                        {deviceName ? (
                          <span
                            data-testid="composer-project-device"
                            className="max-w-36 truncate text-ui-sm text-remote-foreground-muted"
                          >
                            {deviceName}
                          </span>
                        ) : null}
                      </span>
                      {disabled ? (
                        <span className="text-ui-xs text-foreground-subtlest">
                          {intl.formatMessage({ id: "project.offline" })}
                        </span>
                      ) : null}
                    </DropdownMenuCheckboxItem>
                  </span>
                </RemoteIdentityHoverCard>
              );
            })}
            {visibleProjects.length === 0 && !error ? (
              <div className="px-2 py-2 text-ui-base text-foreground-subtlest">
                {intl.formatMessage({ id: "chat.empty.workspaceSearchEmpty" })}
              </div>
            ) : null}
          </div>

          <div className="shrink-0">
            <DropdownMenuSeparator />
            {/* 项目创建依赖共享服务，不能受本机原生打开文件夹的能力开关限制。 */}
            <DropdownMenuItem
              data-testid="composer-create-project"
              disabled={!service || !remoteService}
              onSelect={() => setCreating(true)}
            >
              <FolderPlus className="size-4 text-foreground-subtle" />
              <span>{intl.formatMessage({ id: "project.create" })}</span>
            </DropdownMenuItem>
            {canUseRemoteWorkspace ? (
              <DropdownMenuItem
                data-testid={TID_COMPOSER_REMOTE_CONNECTION}
                onSelect={() => {
                  // Bugfix: 打开远程弹窗时必须让 DropdownMenu 执行默认关闭流程。
                  // 阻止默认 select 会让父菜单与 modal 同时保持打开，浮层层级调整后父菜单会覆盖弹窗。
                  logger.info(
                    `[ProjectComposerMenu] open remote dialog from workspace menu workspace=${workspacePath}`,
                  );
                  // 连接流程由 Root 唯一持有；聊天只提供有效性检查与完成结果接缝。
                  runUserAction({
                    input: {
                      featureId: "workspace.remote.lifecycle",
                      action: "open_dialog",
                      trigger: "menu",
                      workspaceKind: "remote",
                    },
                    operation: addDevice,
                    completed: { resultSource: "local_commit" },
                    failureStage: "dialog_open",
                  });
                }}
              >
                <Cloud className="size-4 text-foreground-subtle" />
                <span>{intl.formatMessage({ id: "chat.empty.newRemoteConnection" })}</span>
              </DropdownMenuItem>
            ) : null}
            {allowConversationWorkspaceSelection && !hostId ? (
              <DropdownMenuCheckboxItem
                data-testid={TID_COMPOSER_WORK_OUTSIDE_PROJECT}
                checked={isConversationWorkspace}
                onSelect={() =>
                  void runUserActionAsync({
                    input: {
                      featureId: "workspace.project_binding",
                      action: "work_outside_project",
                      trigger: "menu",
                    },
                    operation: () => Promise.resolve(onSelectConversationWorkspace()),
                    completed: { resultSource: "optimistic_projection" },
                    failureStage: "project_detach",
                  })
                }
              >
                <MessageCircle className="size-4 text-foreground-subtle" />
                <span>{intl.formatMessage({ id: "chat.empty.workOutsideProject" })}</span>
              </DropdownMenuCheckboxItem>
            ) : null}
          </div>
        </div>
      </DropdownMenuContent>
      {restoredChat === chat ? (
        <span
          role="status"
          data-testid="chat-restored-target"
          className="max-w-full break-words px-2 text-ui-sm text-foreground-subtle"
        >
          {intl.formatMessage(
            { id: "chat.remoteFolder.restored" },
            {
              device: hostId
                ? (deviceNames?.get(
                    currentProject ? (projectSourceServerId(currentProject) ?? "") : "",
                  ) ?? hostId)
                : intl.formatMessage({ id: "project.thisComputer" }),
              project:
                currentProject?.name ?? intl.formatMessage({ id: "chat.empty.workOutsideProject" }),
            },
          )}
        </span>
      ) : null}
      {currentDevice && service && remoteService ? (
        <ChatRemoteFolderSelection
          request={currentDevice}
          service={service}
          remoteService={remoteService}
          onCreateTask={createProjectTask}
          onClose={cancelSelection}
        />
      ) : null}
      {/* 连接成功仍由目录流程交付聊天；普通创建在同一草稿中选中保存后的项目。 */}
      {creating && service && remoteService ? (
        <ProjectCreation
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          onCreateTask={createProjectTask}
          projects={tree.projects}
          directory={directory}
          service={service}
          remoteService={remoteService}
          defaultDeviceId={activeTaskId && hostId ? hostId : "local"}
          allowDeviceManagement={canUseRemoteWorkspace}
          onOpenRemoteWorkspace={onOpenRemoteWorkspace}
          onClose={() => setCreating(false)}
          onSaved={refresh}
        />
      ) : null}
    </DropdownMenu>
  );
  return (
    <>
      {menu}
      {children}
      {canEditProject ? (
        <ControlHintTooltip title={intl.formatMessage({ id: "project.edit" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-full text-foreground-subtle"
            aria-label={intl.formatMessage({ id: "project.edit" })}
            data-testid="composer-edit-project"
            onClick={() => setEditingChat(chat)}
          >
            <Plus className="size-4" />
          </Button>
        </ControlHintTooltip>
      ) : null}
      {/* 项目身份沿用菜单；聊天切换使旧编辑器失效，避免同 cwd 的项目被误编辑。 */}
      {editingChat === chat && canEditProject && currentProject && service ? (
        <ProjectEditor
          key={projectKey(currentProject)}
          project={currentProject}
          host={directory.hosts.find((host) => host.id === currentProject.hostId)}
          projects={tree.projects.filter(
            (project) => !availability.get(projectKey(project))?.entryId,
          )}
          service={service}
          onClose={() => setEditingChat(null)}
          onSaved={refresh}
          onDeleted={refresh}
        />
      ) : null}
    </>
  );
}
