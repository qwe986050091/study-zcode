// 职责边界：只声明设置服务的对外契约，持久化、加锁与版本推进全部由实现方承担。
// INV：AppSettings 是唯一真源，投影类型只能读取，不得反向写回或自行补默认值。
// INV：update 必须同时携带原快照与操作版本，实现方需在同一临界区内完成比较与递增。
// 改错后果：在此层新增旁路写入口或隐式默认值，会让并发更新失去版本约束并静默覆盖用户设置。
import type { AppSettings } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** Host 私有装配端口：只读取本机已提交目录，禁止递归读取设置或网络。 */
export type WorkspaceSettingsProjection = Pick<
  AppSettings,
  "lastActiveWorkspace" | "lastWorkspaceSession" | "recentProjects" | "lastActiveTabIndex"
>;

export interface ISettingService {
  get(): Promise<AppSettings>;
  /** 完整连接映射写入必须传入原快照和操作版本；服务在锁内比较并递增版本。 */
  update(
    patch: Partial<AppSettings>,
    expectedAccountSettings?: Pick<
      AppSettings,
      | "providerFamilyDomain"
      | "providerFamilyConnectionSelections"
      | "providerFamilyDomainUpdatedAt"
    >,
  ): Promise<void>;
  /** Change the data base directory: copy data from old → new location, then persist the setting. */
  updateDataBaseDir(newDir: string | undefined): Promise<void>;
}

export const ISettingService = createServiceDescriptor<ISettingService>(ServiceChannels.Setting);
