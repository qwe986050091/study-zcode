// 任务分组（Task Groups）的服务契约与数据结构定义。
// 分组结构与顺序完全由客户端持有并整体 save，服务端只做持久化与合法性检查。
// 所有跨端引用统一使用 workspaceKey + taskId，避免路径在远端机器上不可用。
// 本文件不含实现，只导出类型与 RPC 频道描述符。
import { ServiceChannels, type ZCodeTaskMeta } from "@zcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";

// 颜色是有限枚举：新增颜色必须同步 UI 主题，否则会渲染为未知色。
export type TaskGroupColor = "gray" | "red" | "orange" | "yellow" | "green" | "blue" | "purple";
// 分组本体；createdAt/updatedAt 由服务端在 save 时写入，客户端传入值会被忽略。
export interface TaskGroup {
  id: string;
  title: string;
  color: TaskGroupColor;
  createdAt: number;
  updatedAt: number;
}
// 任务引用：workspaceIdentity 可选，缺失时回落到 workspacePath 匹配。
export interface GroupTaskRef {
  hostId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}
export type GroupNode = { type: "group"; groupId: string } | { type: "task"; task: GroupTaskRef };
// 整体结构：groups 定义元数据，members 记录任务归属，order 决定混排顺序。
export interface TaskGroupStructure {
  groups: TaskGroup[];
  members: Array<{ groupId: string; workspaceKey: string; taskId: string; sortOrder: number }>;
  order: Array<{ type: "group" | "task"; key: string; sortOrder: number }>;
}
// 移动请求带来源分组与目标分组；null 表示根层级。
export interface MoveGroupNode {
  node: GroupNode;
  /** 来源不匹配表示另一客户端已整理，不能用旧 UI 覆盖。 */
  sourceGroupId: string | null;
  groupId: string | null;
  anchor?: { node: GroupNode; side: "before" | "after" };
}
// Host 校验后回填的事实字段；archived/deleted 用于让 UI 过滤已消失的任务。
export type GroupTaskFact = GroupTaskRef &
  Pick<ZCodeTaskMeta, "cronAutomationId" | "offPeakTaskId"> & {
    createdAt?: number;
    archived?: boolean;
    deleted?: boolean;
  };
// 服务接口：读写整体结构，另提供移动与首次登记两个定向操作。
export interface ITaskGroupService {
// 读取不写库；首次读取返回空结构而不是抛错。
  read(): Promise<TaskGroupStructure>;
// [契约] save 收整份结构：id 缺失由服务端生成；color 缺失落默认值，返回落库后的完整对象。
  save(input: { id?: string; title?: string; color?: TaskGroupColor }): Promise<TaskGroup>;
  ungroup(id: string): Promise<void>;
  move(input: MoveGroupNode): Promise<void>;
  /** Host 验证存在性和类型后首次登记；读取结构本身不写数据。 */
  admit(input: {
    tasks: GroupTaskRef[];
    placement?: { task: GroupTaskRef; groupId: string | null; creationId: string };
  }): Promise<void>;
}
export const ITaskGroupService = createServiceDescriptor<ITaskGroupService>(
  ServiceChannels.TaskGroups,
);
