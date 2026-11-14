// RemoteSyncActions 把入口可见性判定与弹窗打开意图收在一处：
// preflight 超时保护，以及 Skill、MCP、Plugin 三套同步弹窗的组合挂载收在这一处。
// 不负责：真正执行同步、建立远端连接、维护 RPC 就绪状态，这些分属 services 与宿主连接层。
// 也不负责桌面端的窗口与进程调度、重连退避，本文件只在已就绪的连接上做入口与弹窗编排。
//
// 结构上按「纯判定函数、意图 hook、展示组件」三段排列，依赖全部由外部注入，不直连服务实例。
// 因此同一套入口能同时服务 desktop-continuous 持续链路与 web-remote-replayable 恢复链路。
//
// INV-01 断言：web-remote-replayable 客户端永不展示同步入口 —— 守住它的位置：shouldShowRemoteSyncActions 的首个分支 —— 改错故障：手机恢复链路上出现注定失败的同步按钮。
// INV-02 断言：hasLocalSourceService 显式为 false 时判定为不可同步 —— 守住它的位置：shouldShowRemoteSyncActions 的第二个早退分支 —— 改错故障：远端目标缺本地源服务时按钮仍可见，点击后同步直接抛错。
// INV-03 断言：只有 ssh 与 wsl 目标被视为可同步 —— 守住它的位置：shouldShowRemoteSyncActions 尾部 Boolean 的 kind 比较 —— 改错故障：local 目标也弹出同步菜单，读到错误工作区路径并覆盖本地文件。
// INV-04 断言：remoteSessionId 必须 trim 后非空 —— 守住它的位置：shouldShowRemoteSyncActions 的 sessionId trim 判定 —— 改错故障：纯空白会话被当成有效会话，弹窗挂到错误的远端上下文。
// INV-05 断言：进行中或零选中时不得发起同步 —— 守住它的位置：shouldStartRemoteSyncOperation 的返回值 —— 改错故障：按钮连点发出两次同步，或对空集合空转并在完成后误报成功。
// INV-06 断言：open 必须同时满足 rpcReady、targetKey 非空、意图 key 与当前目标一致 —— 守住它的位置：useRemoteSyncDialogIntent 的 open 表达式 —— 改错故障：断连期间残留的意图在重连后自动把弹窗重新弹出。
// INV-07 断言：targetKey 变化必须清空已记录意图 —— 守住它的位置：useRemoteSyncDialogIntent 的第一个 useEffect —— 改错故障：切换远端目标后，上一个目标的弹窗在新目标下自动重开。
// INV-08 断言：rpcReady 变为 false 必须清空已记录意图 —— 守住它的位置：useRemoteSyncDialogIntent 的第二个 useEffect —— 改错故障：短暂断连恢复后弹窗复活，用户措手不及地看到上次未确认的同步面板。
// INV-09 断言：只有真正可打开时才记录 targetKey —— 守住它的位置：useRemoteSyncDialogIntent 的 setOpen 回调 —— 改错故障：记下不可用目标的 key，之后 open 永久为 false 或在目标切换后错配。
// INV-10 断言：超时计时器必须在 finally 中清除 —— 守住它的位置：runRemoteSyncPreflightWithTimeout 的 finally 分支 —— 改错故障：计时器长期挂起造成泄漏，并在组件卸载后仍触发 reject。
// INV-11 断言：超时错误必须可被类型守卫识别 —— 守住它的位置：RemoteSyncPreflightTimeoutError 与 isRemoteSyncPreflightTimeoutError —— 改错故障：调用方把超时当成普通失败，误报成网络错误并隐藏真实卡死点。
// INV-12 断言：超时只是竞速，不取消底层 operation —— 守住它的位置：runRemoteSyncPreflightWithTimeout 的 Promise.race —— 改错故障：误以为探测已中止而再次发起，造成远端双写。
// INV-13 断言：三套服务与 remoteTarget 全部齐备才构造弹窗 props —— 守住它的位置：RemoteSyncDialogs 里三个 dialogProps 三元 —— 改错故障：残缺服务被传入 Dialog，渲染期访问 undefined 崩溃。
// INV-14 断言：弹窗只在对应 open 为真且 props 齐备时渲染 —— 守住它的位置：RemoteSyncDialogs 的三个 JSX 条件 —— 改错故障：关闭后仍保留订阅并触发重复同步。
// INV-15 断言：菜单项阻止 mousedown 冒泡只在按钮容器内开启 —— 守住它的位置：RemoteSyncMenuItems 的 stopMouseDownPropagation 参数 —— 改错故障：下拉项点击同时触发父级触发器，菜单刚打开就关闭。
// INV-16 断言：可选回调缺失时必须回落到空实现 —— 守住它的位置：RemoteSyncDialogs 中 onPluginOpenChange 与 onPluginsSynced 的兜底 —— 改错故障：未接回调的宿主点插件项时抛 TypeError。
//
// 改动前先确认三件事：入口可见性属于产品口径而不是样式问题，
// 弹窗意图属于会话级状态而不是组件本地状态，
// 超时数值与竞速语义已被调用方依赖，不要在没有同步改造远端调用链的前提下单独调整。
// 需要新增同步能力时，优先扩 canSync 参数，不要在组件内部再开第二条判定路径。
// 新增行为后请同步检查单测里对 shouldShowRemoteSyncActions 与超时守卫的既有断言。
import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { BlocksIcon, CableIcon, ChevronDown, UploadCloud, WandIcon } from "lucide-react";
import type { RemoteTarget } from "@zcode/shared";
import type {
  IMcpSyncService,
  IPluginSyncService,
  ISkillSyncService,
  IZCodeAgentService,
} from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { RemoteMcpSyncDialog } from "@/settings/RemoteMcpSyncDialog.js";
import { RemotePluginSyncDialog } from "@/settings/RemotePluginSyncDialog.js";
import { RemoteSkillSyncDialog } from "@/settings/RemoteSkillSyncDialog.js";

// [契约] 这两个字面量是跨包共享的语义标签，桌面走持续实时链路，手机走可重放恢复链路。
// [权衡] 只在 web 侧关闭同步入口，是因为恢复链路重放时会重新挂载 UI，同步动作无法保证幂等。
// 新增第三种 mode 时 shouldShowRemoteSyncActions 的早退分支不会自动覆盖，必须显式补判定。
// 不要把它改成枚举或宽松 string，远端可见性判定是按等值比较写的。
// 改错症状：RemoteSyncClientMode 放宽后手机端重连自动弹面板，用户误以为上次同步已确认。
export type RemoteSyncClientMode = "desktop-continuous" | "web-remote-replayable";
// [权衡] 15 秒覆盖 ssh 与 wsl 冷启动探测的实测上限，压到秒级会把正常慢机误判成超时。
// 该常量同时是默认参数与等待文案的口径，改小会让提示里的时长与实际等待不一致。
// 探测本身不会被取消，缩短超时只会更早报错，后台工作继续占着远端通道。
// 需要更短等待时应由调用方传入 timeoutMs，不要改这个共享默认值。
// 改错症状：调小 REMOTE_SYNC_PREFLIGHT_TIMEOUT_MS 后弱网机器频繁报超时，用户重试叠加并发探测。
export const REMOTE_SYNC_PREFLIGHT_TIMEOUT_MS = 15_000;

// [契约] name 必须手写成固定字符串，否则压缩打包后类名被改写，日志里检索不到。
// 字段 timeoutMs 要保持 readonly 且不改名，上层会把它拼进提示文案。
// 不要改成带 code 字段的通用错误，调用方用类型守卫而不是字符串匹配来分流。
// 改错症状：超时在日志里显示为普通 Error，排障时无法与真正的连接失败区分。
export class RemoteSyncPreflightTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Remote sync preflight timed out after ${timeoutMs}ms`);
    this.name = "RemoteSyncPreflightTimeoutError";
  }
}

// [契约] 守卫只认 instanceof，不做 message 关键字匹配，避免误伤宿主自定义错误。
// 跨窗口或跨 realm 传入的同构错误不会被识别，这是当前设计接受的边界。
// 返回值写成类型谓词，调用方才能在不加断言的情况下收窄 unknown。
// 改错症状：调用方拿不到收窄后的 timeoutMs，只能打印笼统的失败提示。
export function isRemoteSyncPreflightTimeoutError(
  error: unknown,
): error is RemoteSyncPreflightTimeoutError {
  return error instanceof RemoteSyncPreflightTimeoutError;
}

// [契约] 入参全部可选，调用方在未就绪时传空对象也必须得到 false 而不是抛错。
// 判定顺序是语义要求而非性能优化：先排客户端模式，再排本地服务，最后才看远端目标。
// 不要把它改成依赖 store 或服务实例的 hook，它要能在纯逻辑单测里直接调用。
// 与 shouldStartRemoteSyncOperation 分工明确：这里决定能不能看到，那里决定能不能点。
// 改错症状：未连接状态渲染出同步入口，点击后弹窗拿不到服务而静默无响应。
export function shouldShowRemoteSyncActions(params: {
  remoteSessionId?: string | null;
  remoteTarget?: RemoteTarget | null;
  clientMode?: RemoteSyncClientMode;
  hasLocalSourceService?: boolean;
}): boolean {
  // [失败路径] 这里是手机恢复链路的唯一闸门，早退必须发生在任何远端判定之前。
  // clientMode 缺省时不进入该分支，等价于按桌面语义处理，这是刻意的向后兼容。
  // 不要为了「让手机也能同步」删掉分支，恢复链路重放会重复触发同步副作用。
  // 改错症状：手机端刷新或重连后自动重放同步动作，远端产生重复写入。
  if (params.clientMode === "web-remote-replayable") {
    return false;
  }
  // [契约] 只认显式 false，undefined 表示调用方尚未探测完成，此时不能提前否定。
  // 该参数表示本地是否具备可读取的源服务，不代表远端是否可用，两者不可互换。
  // 与后续 target 判定是「与」关系，缺一不可，不要合并成单个布尔。
  // 改错症状：探测未完成时同步入口被永久隐藏，用户以为功能丢失。
  if (params.hasLocalSourceService === false) {
    return false;
  }
  // [契约] sessionId 先 trim 再判空，纯空白与空串等价，这是远端会话的真实有效性口径。
  // 只放行 target.kind 为 ssh 与 wsl 的情形，local 目标由本地同步流程负责。
  // 外层 Boolean 负责把 undefined 表达式收敛成布尔，调用方不要再做二次真值判断。
  // 改错症状：local 目标误入远端同步，弹窗按本地路径读写，造成跨环境覆盖。
  return Boolean(
    params.remoteSessionId?.trim() &&
    (params.remoteTarget?.kind === "ssh" || params.remoteTarget?.kind === "wsl"),
  );
}

// [契约] 本函数是按钮 disabled 与提交回调共用的唯一闸门，两处必须同时生效。
// 参数 inFlight 为 true 时阻断重入，selectedCount 不大于零时阻断空提交，两者不可互相替代。
// 不要在函数内读组件状态，调用方传入的才是当前渲染帧的快照。
// disabled 只影响视觉与键盘可达性，真正的兜底仍然在调用方回调里。
// 改错症状：shouldStartRemoteSyncOperation 放行双击，远端出现半截成功的中间数据。
export function shouldStartRemoteSyncOperation(params: {
  inFlight: boolean;
  selectedCount: number;
}): boolean {
  return !params.inFlight && params.selectedCount > 0;
}

// [契约] 意图以 targetKey 为键而不是布尔，目的是让弹窗天然绑定到某个远端目标。
// 返回的 setOpen 语义是声明意图，不是直接改 open，可见性由 rpcReady 与 key 共同决定。
// 不要把它扩成多目标集合，当前调用方一次只关心一个目标。
// 改错症状：退化成布尔后切换目标，弹窗会跟到新目标上显示旧环境的内容。
export function useRemoteSyncDialogIntent(params: { rpcReady: boolean; targetKey: string }): {
  open: boolean;
  setOpen: (open: boolean) => void;
} {
  const [openedTargetKey, setOpenedTargetKey] = useState<string | null>(null);
  const open =
    params.rpcReady && params.targetKey.length > 0 && openedTargetKey === params.targetKey;

  // [并发] targetKey 变化即清空意图，避免跨目标的意图泄漏。
  // 该 effect 不区分同一目标重新挂载，重挂载也会清空，这是有意的保守行为。
  // 上面那段既有注释记录的就是这条历史故障，不要与下面 rpcReady 的 effect 合并。
  // 改错症状：切换 targetKey 后旧弹窗自动重开，用户看到上一个环境的同步结果。
  useEffect(() => {
    // 弹窗 open 曾只绑定 PluginList 组件生命周期，远端断连或切换目标时
    // Dialog 虽被卸载，用户意图仍会残留并在重连后自动恢复。
    setOpenedTargetKey(null);
  }, [params.targetKey]);
  // [失败路径] rpcReady 变 false 说明通道已断，已记录的目标 key 必须作废。
  // 只在 false 时清空，变 true 不自动恢复，避免断线重连后弹窗突然出现。
  // 与上一个 effect 职责不同：一个按目标切换，一个按就绪状态，不能合并依赖数组。
  // 两处都写 null 而不是空串，null 是与 targetKey 比较时永不相等的那一侧。
  // 改错症状：rpcReady 短暂断开再恢复后同步面板自动弹出，用户误以为是自己触发的。
  useEffect(() => {
    if (!params.rpcReady) {
      setOpenedTargetKey(null);
    }
  }, [params.rpcReady]);

  // [契约] 只有 nextOpen 为真、rpcReady 为真且 targetKey 非空时才记录 key，其余一律清空。
  // 依赖数组必须同时包含 rpcReady 与 targetKey，漏一个就会记进过期闭包里的目标。
  // 不要在这里直接 setState 一个 open 布尔，那样会绕开可打开性判定。
  // 改错症状：未就绪时打开被记录，就绪后弹窗以错误目标自动出现。
  const setOpen = useCallback(
    (nextOpen: boolean) => {
      setOpenedTargetKey(
        nextOpen && params.rpcReady && params.targetKey.length > 0 ? params.targetKey : null,
      );
    },
    [params.rpcReady, params.targetKey],
  );

  return { open, setOpen };
}

// [并发] 这是竞速而不是取消：operation 在超时后仍会跑完，写远端前要自己判活。
// 默认超时来自 REMOTE_SYNC_PREFLIGHT_TIMEOUT_MS，改小只会更早报错，后台操作保持运行。
// 传入的 operation 必须幂等，不能把真正的写入塞进来，否则超时重试会双写。
// 改错症状：超时后调用方重试，与仍在跑的探测叠加，通道拥塞同时产生重复写。
export async function runRemoteSyncPreflightWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs = REMOTE_SYNC_PREFLIGHT_TIMEOUT_MS,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new RemoteSyncPreflightTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(), timeout]);
  // [资源] 无论成功、失败还是超时都必须清掉计时器，否则定时器一直挂在事件循环上。
  // 计时器 id 可能仍为 undefined（operation 同步抛错时），因此判空不能省略。
  // 不要用 Promise.finally 链式替代，finally 里抛出会掩盖原始异常。
  // 改错症状：频繁探测后进程里堆积待触发的计时器，退出被拖住并打印未处理拒绝。
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

// [契约] 三个 canSync 开关彼此独立，缺省 false 表示调用方未开启该能力。
// stopMouseDownPropagation 只在放进 DropdownMenuTrigger 内部时才该开启，否则会吞掉外部点击。
// mcpDisabled 与 canSyncMcp 语义不同，表示能力在但当前不可用，两者不能合并。
// 菜单项顺序即展示顺序，图标与文案 id 成对出现，改动要同步 i18n 资源。
// 改错症状：RemoteSyncMenuItems 的点击冒泡到父级触发器，菜单闪一下即关，用户点不到任何项。
export function RemoteSyncMenuItems({
  canSyncSkills,
  canSyncMcp,
  canSyncPlugins = false,
  onOpenSkillSync,
  onOpenMcpSync,
  onOpenPluginSync,
  stopMouseDownPropagation = false,
  mcpDisabled = false,
}: {
  canSyncSkills: boolean;
  canSyncMcp: boolean;
  canSyncPlugins?: boolean;
  onOpenSkillSync: () => void;
  onOpenMcpSync: () => void;
  onOpenPluginSync?: () => void;
  stopMouseDownPropagation?: boolean;
  mcpDisabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const handleMouseDown = stopMouseDownPropagation
    ? (event: MouseEvent) => {
        event.stopPropagation();
      }
    : undefined;

  return (
    <>
      {canSyncSkills ? (
        <DropdownMenuItem onMouseDown={handleMouseDown} onSelect={onOpenSkillSync}>
          <WandIcon className="size-3.5" />
          {intl.formatMessage({ id: "remote.syncSkills" })}
        </DropdownMenuItem>
      ) : null}
      {canSyncMcp ? (
        <DropdownMenuItem
          disabled={mcpDisabled}
          onMouseDown={handleMouseDown}
          onSelect={onOpenMcpSync}
        >
          <CableIcon className="size-3.5" />
          {intl.formatMessage({ id: "remote.syncMcp" })}
        </DropdownMenuItem>
      ) : null}
      {canSyncPlugins ? (
        <DropdownMenuItem onMouseDown={handleMouseDown} onSelect={onOpenPluginSync}>
          <BlocksIcon className="size-3.5" />
          {intl.formatMessage({ id: "remote.syncPlugins" })}
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

export function RemoteSyncDropdownButton({
  canSyncSkills,
  canSyncMcp,
  canSyncPlugins = false,
  mcpDisabled = false,
  onOpenSkillSync,
  onOpenMcpSync,
  onOpenPluginSync,
}: {
  canSyncSkills: boolean;
  canSyncMcp: boolean;
  canSyncPlugins?: boolean;
  mcpDisabled?: boolean;
  onOpenSkillSync: () => void;
  onOpenMcpSync: () => void;
  onOpenPluginSync?: () => void;
}) {
  const { intl } = useZCodeIntl();

  if (!canSyncSkills && !canSyncMcp && !canSyncPlugins) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="secondary" size="sm" className="gap-1">
          <UploadCloud className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "remote.syncAll" })}
          <ChevronDown className="size-3.5 text-foreground-subtle" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <RemoteSyncMenuItems
          canSyncSkills={canSyncSkills}
          canSyncMcp={canSyncMcp}
          canSyncPlugins={canSyncPlugins}
          mcpDisabled={mcpDisabled}
          onOpenSkillSync={onOpenSkillSync}
          onOpenMcpSync={onOpenMcpSync}
          onOpenPluginSync={onOpenPluginSync}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function RemoteSyncDialogs({
  canSyncSkills,
  canSyncMcp,
  canSyncPlugins = false,
  skillOpen,
  mcpOpen,
  pluginOpen = false,
  onSkillOpenChange,
  onMcpOpenChange,
  onPluginOpenChange,
  localSkillSyncService,
  remoteSkillSyncService,
  localMcpSyncService,
  remoteMcpSyncService,
  localPluginSyncService,
  remotePluginSyncService,
  localZCodeAgentService,
  remoteZCodeAgentService,
  remoteTarget,
  skillWorkspacePath,
  mcpWorkspacePath,
  pluginWorkspacePath,
  pluginLocalWorkspacePath,
  mcpLocalWorkspacePath,
  workspaceIdentity,
  onSkillsSynced,
  onMcpSynced,
  onPluginsSynced,
}: {
  canSyncSkills: boolean;
  canSyncMcp: boolean;
  canSyncPlugins?: boolean;
  skillOpen: boolean;
  mcpOpen: boolean;
  pluginOpen?: boolean;
  onSkillOpenChange: (open: boolean) => void;
  onMcpOpenChange: (open: boolean) => void;
  onPluginOpenChange?: (open: boolean) => void;
  localSkillSyncService?: ISkillSyncService | null;
  remoteSkillSyncService?: ISkillSyncService | null;
  localMcpSyncService?: IMcpSyncService | null;
  remoteMcpSyncService?: IMcpSyncService | null;
  localPluginSyncService?: IPluginSyncService | null;
  remotePluginSyncService?: IPluginSyncService | null;
  localZCodeAgentService?: IZCodeAgentService | null;
  remoteZCodeAgentService?: IZCodeAgentService | null;
  remoteTarget?: RemoteTarget | null;
  skillWorkspacePath: string;
  mcpWorkspacePath: string;
  pluginWorkspacePath?: string;
  pluginLocalWorkspacePath?: string;
  mcpLocalWorkspacePath?: string;
  workspaceIdentity?: string;
  onSkillsSynced: () => Promise<void> | void;
  onMcpSynced: () => Promise<void> | void;
  onPluginsSynced?: () => Promise<void> | void;
}) {
  const skillDialogProps =
    canSyncSkills && skillOpen && remoteTarget && localSkillSyncService && remoteSkillSyncService
      ? {
          localSkillSyncService,
          remoteSkillSyncService,
          remoteTarget,
        }
      : null;
  const mcpDialogProps =
    canSyncMcp && mcpOpen && remoteTarget && localMcpSyncService && remoteMcpSyncService
      ? {
          localMcpSyncService,
          remoteMcpSyncService,
          remoteTarget,
        }
      : null;
  const pluginDialogProps =
    canSyncPlugins &&
    pluginOpen &&
    remoteTarget &&
    localPluginSyncService &&
    remotePluginSyncService
      ? {
          localPluginSyncService,
          remotePluginSyncService,
          remoteTarget,
        }
      : null;

  return (
    <>
      {skillDialogProps ? (
        <RemoteSkillSyncDialog
          open={skillOpen}
          onOpenChange={onSkillOpenChange}
          localSkillSyncService={skillDialogProps.localSkillSyncService}
          remoteSkillSyncService={skillDialogProps.remoteSkillSyncService}
          remoteTarget={skillDialogProps.remoteTarget}
          workspacePath={skillWorkspacePath}
          workspaceIdentity={workspaceIdentity}
          onSynced={onSkillsSynced}
        />
      ) : null}
      {mcpDialogProps ? (
        <RemoteMcpSyncDialog
          open={mcpOpen}
          onOpenChange={onMcpOpenChange}
          localMcpSyncService={mcpDialogProps.localMcpSyncService}
          remoteMcpSyncService={mcpDialogProps.remoteMcpSyncService}
          remoteTarget={mcpDialogProps.remoteTarget}
          workspacePath={mcpWorkspacePath}
          localWorkspacePath={mcpLocalWorkspacePath}
          onSynced={onMcpSynced}
        />
      ) : null}
      {pluginDialogProps ? (
        <RemotePluginSyncDialog
          open={pluginOpen}
          onOpenChange={onPluginOpenChange ?? (() => {})}
          localPluginSyncService={pluginDialogProps.localPluginSyncService}
          remotePluginSyncService={pluginDialogProps.remotePluginSyncService}
          localZCodeAgentService={localZCodeAgentService}
          remoteZCodeAgentService={remoteZCodeAgentService}
          remoteTarget={pluginDialogProps.remoteTarget}
          localWorkspacePath={pluginLocalWorkspacePath}
          workspacePath={pluginWorkspacePath ?? mcpWorkspacePath}
          workspaceIdentity={workspaceIdentity}
          onSynced={onPluginsSynced ?? (() => {})}
        />
      ) : null}
    </>
  );
}
