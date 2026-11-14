import type { SubagentRuntimeState } from "@zcode/shared";
/** 文件 IO 由 loader 完成；本模块只解析注入文本，不读取磁盘或补充 Host 快照。 */
export interface RuntimeSubagentConfiguration {
  /** 已读入内存的 Markdown 原文：loader 负责文件枚举与读取，本模块只做纯解析。 */
  documents: { content: string; path: string; namespace?: string; source: "user" | "project" }[];
  /** 运行态开关与模型覆盖；从启动快照透传，不在解析阶段查询账号或磁盘。 */
  state: SubagentRuntimeState;
}
