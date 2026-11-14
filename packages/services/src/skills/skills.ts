// 技能服务契约：定义技能列表、启停、提示上下文构建与本地技能目录增删的跨进程接口。
// 边界：本文件只有类型与描述符，扫描、权限判定、文件操作全部留在实现层，避免契约泄漏实现细节。
// INV：workspaceIdentity 省略时以 workspacePath 作为身份键；两者混用会把不同工作区的状态串到一起。
import type { ZCodeProvider, SkillsPromptContext, SkillsListResult } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// 对外只暴露 skillId，不暴露真实目录：路径拼接与越界校验必须收敛在实现内，防止 UI 自行拼路径。
// provider 参与所有方法的键计算，不同 provider 的技能集合与启用状态彼此隔离，缺省表示通用集合。
export interface ISkillsService {
// 结果必须带上启用状态与来源作用域，否则 UI 无法区分 workspace/user/plugin 三种归属。
  list(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
  }): Promise<SkillsListResult>;
  setEnabled(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    scope?: "workspace" | "user" | "plugin";
    skillId: string;
    enabled: boolean;
  }): Promise<void>;
  buildPromptContext(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    prompt: string;
  }): Promise<SkillsPromptContext>;
  /** 将指定 skill 复制到通用目录（.zcode/skills），成功后返回新 skill 的路径。 */
  copyToCommon(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<{ newPath: string }>;
  /** 从通用目录中移除指定 skill（仅当 skill 位于 .zcode/skills 时有效）。 */
  removeFromCommon(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<void>;
  /**
   * 删除本地技能（仅 workspace/user 作用域；plugin 作用域拒绝）。
   * 删除技能所在目录，仅允许命中 .zcode/skills 或 .agents/skills 根，越界则拒绝。
   */
  deleteSkill(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<void>;
}

// 描述符绑定 ServiceChannels.Skills，通道名即跨进程路由键，改名必须与调用端同步，否则运行时才报错。
export const ISkillsService = createServiceDescriptor<ISkillsService>(ServiceChannels.Skills);
