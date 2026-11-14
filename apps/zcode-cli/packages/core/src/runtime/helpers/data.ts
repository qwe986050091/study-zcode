// ============================================================
// data —— 外部数据(unknown)的类型守卫与安全读取小工具
// ============================================================
//
// 【定位】
//   用于处理"跨进程 / 跨存储 / 来自模型或工具输出"的 unknown 数据:
//   在 runtime/helpers/rewind.ts、runtime/methods/turn-model-step.ts 等处
//   做防御性判定与诊断字段提取。
//
// 【口径】
//   - 全部是纯函数,无 I/O、不抛错、不修改入参;
//   - 守卫只在"结构足够用"时返回 true,不追求完整 schema 校验;
//   - 只为诊断取字段(objectKeys 最多 20 个键),避免日志被超长对象撑爆。
// ============================================================
import type { DiffHunk } from "../deps.js";

/**
 * DiffHunk 结构守卫:四个数值范围字段 + 行数组全部校验通过才算合法。
 * 输入:任意 unknown(可能来自结构化 patch 输出);输出:类型谓词。
 * 用途:rewind 里 filter(isRuntimeDiffHunk),把不合法的 hunk 直接剔除,
 *       避免后续按错误的行号做文件恢复。
 * 副作用:无。
 */
export function isRuntimeDiffHunk(value: unknown): value is DiffHunk {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.oldStart === "number" &&
    typeof value.oldLines === "number" &&
    typeof value.newStart === "number" &&
    typeof value.newLines === "number" &&
    Array.isArray(value.lines) &&
    value.lines.every((line) => typeof line === "string")
  );
}

/**
 * "普通对象"守卫:排除 null 与数组,但允许任意原型(不做 class 判断)。
 * 只用于读取字段前的粗略过滤,不能当作安全反序列化。
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 取对象键名用于诊断日志;非对象返回 undefined,最多取前 20 个键。
 * 为什么截断:provider metadata 可能非常宽,全量打日志既昂贵又无意义。
 */
export function objectKeys(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  return Object.keys(value).slice(0, 20);
}

/** 安全读取字符串字段:值不是 string(含 null/对象/数字)时返回 undefined,不做转换。 */
export function stringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
