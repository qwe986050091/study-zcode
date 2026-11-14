// 窗口级 Controller 的公共契约层：只声明类型与服务描述符，不承载运行时状态或实现。
// 该文件同时被窗口内的 Host 与渲染进程引用，改类型等于改跨进程协议，需保持向后兼容。
// 所有任务引用统一用 WindowHostTaskAddress 标识，避免按路径猜测任务归属哪个 Host。
import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  ControllerResyncParams,
  ControllerResyncResult,
  ControllerSubscribeParams,
  ControllerSubscribeResult,
  ControllerUnsubscribeParams,
  WindowHostControllerTaskFrame,
  WindowHostControllerTaskRow,
  WindowHostControllerWorkspaceFrame,
  WindowHostTaskAddress,
} from "@zcode/shared/zcode-protocol-v4";
import { createServiceDescriptor } from "../descriptors.js";
import type { ZCodeArchivedTaskDeletionResult } from "#src/session/zcodeTaskService.js";
import type {
  ZCodeTaskListItem,
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
} from "../session/zcodeTaskListTypes.js";

// 用户可发起的任务变更动作集合，用可辨识联合而非「动作字符串 + 任意参数」，
// 使每种动作（如 rename 必须带 title）在类型层就完整，避免运行时再补齐字段。
export type WindowHostControllerMutation =
  | { kind: "rename"; title: string }
  | { kind: "pin"; pinned: boolean }
  | { kind: "archive"; archived: boolean }
  | { kind: "delete" }
  | { kind: "delete-archived" }
  | { kind: "mark-read"; expectedUnreadAt?: number }
  | { kind: "mark-unread" }
  | { kind: "open" }
  | { kind: "resume" };

// 列表投影在本地任务字段之上补充「来自哪个 source」的信息，供渲染层区分本地与远程任务；
// sourceAvailability 描述连接可达性，liveStatus 描述任务自身运行态，两者不可混用。
export type WindowHostControllerTaskListItem = ZCodeTaskListItem & {
  sourceServerId?: string;
  serverDisplayName?: string;
  remoteSessionId?: string;
  sourceAvailability: "online" | "offline";
  liveStatus: WindowHostControllerTaskRow["liveStatus"];
  activity?: WindowHostControllerTaskRow["activity"];
};

// 用 Omit 覆盖 items 而非重新定义整个结果，保证分页与游标等字段始终与 ZCodeTaskListResult 同源，
// 只有条目类型被替换为带 source 信息的版本。
export interface WindowHostControllerTaskListResult extends Omit<ZCodeTaskListResult, "items"> {
  items: WindowHostControllerTaskListItem[];
}

// 动态帧只有任务列表与工作区两类，订阅方按 kind 分支处理；
// 不做泛型包裹是为了让事件通道的序列化结构保持扁平、便于运行时校验。
export type WindowHostControllerFrame =
  | WindowHostControllerTaskFrame
  | WindowHostControllerWorkspaceFrame;

/** 仅实时发送；列表快照与重同步不能重放一次完成提醒。 */
export interface WindowHostTaskUnreadSignal {
  address: WindowHostTaskAddress;
  updatedAt: number;
  status: "completed" | "error";
}

/**
 * 窗口级 Controller 服务只承载列表投影与跨 source 路由。
 * conversation/file/git/terminal 仍由 attachment 对应的 scoped facade 提供。
 */
export interface IWindowControllerService {
// 单条与批量删除共用同一 address 语义：address 决定由哪个 Host 执行，
// 返回值表达「是否真的删掉了」，调用方据此区分已完成与本来就不存在。
  deleteArchivedTask(params: { address: WindowHostTaskAddress }): Promise<boolean>;
  deleteArchivedTasks(params: {
    address: WindowHostTaskAddress;
    taskIds: string[];
  }): Promise<ZCodeArchivedTaskDeletionResult>;
  listTaskList(params: ZCodeTaskListQuery): Promise<WindowHostControllerTaskListResult>;
  /** 直接读取所属 owner 的轻量 meta；未读 CAS 不得使用可能降级为旧快照的列表投影。 */
  getTaskMeta(params: { address: WindowHostTaskAddress }): Promise<ZCodeTaskMeta | null>;
  mutateTask(params: {
    address: WindowHostTaskAddress;
    mutation: WindowHostControllerMutation;
  }): Promise<ZCodeTaskMeta | null>;
  subscribeControllerV4(params: ControllerSubscribeParams): Promise<ControllerSubscribeResult>;
// 重同步与订阅分离：调用方可在保持订阅的情况下单独触发一次全量对齐，
// 用于重连后补齐增量帧可能丢失的中间状态。
  resyncControllerV4(params: ControllerResyncParams): Promise<ControllerResyncResult>;
  unsubscribeControllerV4(params: ControllerUnsubscribeParams): Promise<void>;
  onDynamicControllerFrame(): Event<WindowHostControllerFrame>;
  onDynamicTaskUnreadSignal(): Event<WindowHostTaskUnreadSignal>;
}

// 描述符只登记频道名，具体实例由 Host 侧装配后注入；
// 这样契约层不依赖任何实现模块，避免 services 内部出现循环引用。
export const IWindowControllerService = createServiceDescriptor<IWindowControllerService>(
  ServiceChannels.WindowController,
);
