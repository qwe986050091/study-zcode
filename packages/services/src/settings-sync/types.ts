// ============================================================================
// 设置同步的展示层类型：描述「来源 → 类别 → 条目」的三层结构，
// 供设置页渲染，不参与实际导入逻辑。
// ============================================================================
import type {
  SettingsSyncAgent,
  SettingsSyncCategory,
} from "@zcode/shared";

// 单个可展示条目：id 用于回传选择，label 用于 UI 文案。
export interface SettingsSyncSourceItem {
  id: string;
  label: string;
}

// 一个 Agent 下的一类资源；items 为空表示该类别没有发现内容。
export interface SettingsSyncSourceCategory {
  category: SettingsSyncCategory;
  items: SettingsSyncSourceItem[];
}

// 一个 Agent 的发现结果；discovered=false 时前端应隐藏整个分组。
// categories 只包含实际扫描过的类别。
export interface SettingsSyncSourceDiscovery {
  agent: SettingsSyncAgent;
  discovered: boolean;
  categories: SettingsSyncSourceCategory[];
}

// 导入任务的最小描述，用于进度事件与结果聚合。
export interface SettingsSyncImportTask {
  agent: SettingsSyncAgent;
  category: SettingsSyncCategory;
  discoveredCount: number;
}

// 单个任务的统计结果；三个计数互斥，未发生的计数可缺省。
// status 由实现按「有失败 / 有导入 / 全跳过」的优先级推导。
export interface SettingsSyncTaskResult {
  status: "success" | "skipped" | "failed";
  importedCount?: number;
  skippedCount?: number;
  failedCount?: number;
}
