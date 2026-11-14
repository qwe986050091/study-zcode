// 职责：定义技能同步服务契约，覆盖本地候选枚举、远端状态查询、归档导出与导入。
// 边界：只描述跨进程 RPC 的形状，不实现文件搬运；归档字节由调用方持有并负责生命周期。
// INV：接口与 ServiceChannels.SkillSync 一一绑定，方法名或形状变更必须同步 RPC 两端。
// INV：导入禁止静默覆盖（overwrite 固定为 false），冲突须由上层显式确认后再处理。
// 改错后果：契约漂移会同时打断桌面与 Web 客户端，且错误只能以运行时 RPC 失败暴露。
import type {
  SkillSyncArchiveExportResult,
  SkillSyncCandidateListResult,
  SkillSyncImportResult,
  SkillSyncRemoteStatusResult,
  RemoteSyncWriteAccessResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// 所有方法返回 Promise：实现侧涉及磁盘与远端 IO，禁止在调用线程内做同步阻塞。
// 列表接口以目录名为索引，调用方需保证 directoryNames 与 skills 的对应关系可校验。
export interface ISkillSyncService {
  listLocalUserSkillCandidates(): Promise<SkillSyncCandidateListResult>;
  listRemoteUserSkillStatuses(params: {
    directoryNames: string[];
    skills?: Array<{
      directoryName: string;
      name: string;
    }>;
  }): Promise<SkillSyncRemoteStatusResult>;
  exportSkillsArchive(params: { skillIds: string[] }): Promise<SkillSyncArchiveExportResult>;
  checkRemoteUserSkillWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  importSkillsArchive(params: {
    archive: Uint8Array;
    overwrite?: false;
  }): Promise<SkillSyncImportResult>;
}

// 描述符把接口类型与频道常量绑定，供 RPC 层生成同构的客户端与服务端桩。
// [契约] ServiceChannels.SkillSync 是跨版本协议面：改名即断旧客户端，只能走版本化迁移。
export const ISkillSyncService = createServiceDescriptor<ISkillSyncService>(
  ServiceChannels.SkillSync,
);
