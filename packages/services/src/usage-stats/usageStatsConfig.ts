// 职责边界：本文件只声明统计口径常量（时间窗口天数与未知模型占位键），不含查询、聚合或缓存逻辑。
// INV：键集合必须与 UsageStatsRange 去掉 "all" 后完全一致，且占位键不得与真实模型 ID 冲突；漏改会让 UI 选区与查询区间错位统计。
export const USAGE_STATS_RANGE_DAYS: Record<Exclude<import("@zcode/shared").UsageStatsRange, "all">, number> =
  {
    "7d": 7,
    "30d": 30,
  };

export const USAGE_STATS_UNKNOWN_MODEL_KEY = "__unknown__";
