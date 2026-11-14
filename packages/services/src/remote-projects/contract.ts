// 远端项目目录的只读契约：projectId 属于远端，hostId 属于本机连接入口，两者不可混用。
// 边界：这里只描述本机持有的 host 与入口投影，不承载远端项目或任务的写入语义。
// 不变量：entry.hostId 必须指向仍然存在的 host；host 移除时其入口一并消失，不允许悬挂引用。
// 改错后果：把删除 host 当成远端删除会丢失本地连接配置；把 entry 当远端事实会长期显示过期项目。
import type { RemoteTargetSnapshot, RemoteWorkspaceSessionEntry } from "@zcode/shared";
import type { ProjectRoot } from "#src/project-storage/contract.js";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";

export interface RemoteProjectHost {
  id: string;
  membershipId: string;
  kind: RemoteTargetSnapshot["kind"];
  target: RemoteTargetSnapshot | null;
  position: number;
  /** 连接管理器的当前只读投影，不落 SQLite。 */
  connectionStatus?: "online" | "connecting" | "offline";
  lastConnectionStatus?: string;
  /** `needs-upgrade` 时需要更新的一端，详情入口与设置页设备卡共用它决定操作名。 */
  upgradeTarget?: "controller" | "server";
  lastConnectionError?: string;
  lastOpenedAt?: number;
}
// 缓存整体替换而非逐字段合并：name 与 roots 必须来自同一次远端快照，混合批次会拼出不存在的根路径。
// roots 的顺序影响入口展示与默认根选择，刷新时须沿用远端给出的顺序，不能本地重排。
export interface RemoteProjectCache {
  projectId: string;
  name: string;
  roots: ProjectRoot[];
}
// projectId 为 null 表示 3.15 迁移遗留的占位入口，尚未与远端项目对齐，不能参与刷新版本比较。
// legacyWorkspace 仅在迁移期用于恢复旧 workspace 路径，新写入的入口不应再填充它。
export interface RemoteProjectEntry {
  id: string;
  hostId: string;
  projectId: string | null;
  name: string;
  roots: ProjectRoot[];
  legacyWorkspace: RemoteWorkspaceSessionEntry | null;
  lastSyncedAt: number | null;
  /** 从 3.15 首次升级的混排位置；仅用作控制端排序初值。 */
  initialPosition?: number;
}
export interface RemoteProjectDirectory {
  hosts: RemoteProjectHost[];
  entries: RemoteProjectEntry[];
}
/** 本机持有的入口，不承担远端项目或任务的写入。调用完成表示已提交并通知订阅者。 */
export interface IRemoteProjectService {
  readDirectory(): Promise<RemoteProjectDirectory>;
  /** 只重连仍保留的成员，复用既有连接器；不恢复项目入口。 */
  connectHost(id: string): Promise<RemoteProjectHost>;
  /** 显式保存连接入口；单事务限制最多 20 个远端 host；不接收 secret。 */
  saveHost(input: { id: string; target: RemoteTargetSnapshot }): Promise<RemoteProjectHost>;
  /** 握手只合并仍存在的同一成员实例；迟到或移除后重加返回 null。 */
  bindHost(input: {
    id: string;
    membershipId: string;
    resolvedId: string;
    createDistinctHost?: boolean;
  }): Promise<RemoteProjectHost | null>;
  /** 幂等移除本机 host 与所属入口，不调用远端删除。 */
  removeHost(id: string): Promise<void>;
  /** 仅显式添加使用；已有入口保持 ID，移除后重加创建新 ID。 */
  addEntry(input: {
    hostId: string;
    expectedMembershipId?: string;
    project: RemoteProjectCache;
  }): Promise<RemoteProjectEntry>;
  /** 请求携带读取前版本；迟到/已删除返回 false，绝不 INSERT。 */
  refreshEntry(input: {
    entryId: string;
    expectedLastSyncedAt: number | null;
    project: RemoteProjectCache;
  }): Promise<boolean>;
  /** 幂等删除入口及缓存；不删除 host，不写待同步操作。 */
  removeEntry(id: string): Promise<void>;
}
export const IRemoteProjectService = createServiceDescriptor<IRemoteProjectService>(
  ServiceChannels.RemoteProjects,
);
