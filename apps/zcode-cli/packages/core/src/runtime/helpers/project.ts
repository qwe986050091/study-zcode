// ============================================================
// project —— 会话标题与 ProjectId 的确定性生成工具
// ============================================================
//
// 【职责】
//   1. titleFromInput：从用户首条输入生成人类可读的会话标题；
//   2. slugify / projectIdFromDirectory：把目录路径稳定地折叠成 ProjectId。
//
// 【契约】纯函数，无副作用、无 I/O、不抛错（空输入都有兜底默认值）。
// 【不变量】同一输入必须得到同一结果（用于跨进程 / 跨重启的目录归类），
//   因此只允许确定性字符变换，不能引入随机数、时间或平台相关的路径语义。
// ============================================================
import { createProjectId } from "../deps.js";
import type { ProjectId } from "../deps.js";

/**
 * 从用户输入生成会话标题。
 * 输入：任意用户文本。
 * 输出：单行标题（<= 60 字符，超出截断为 57 字符 + "..."）。
 * 语义：先压缩空白；空串回退 "Untitled session"。
 * 副作用：无。
 */
export function titleFromInput(input: string): string {
  const compact = input.trim().replace(/\s+/g, " ");
  if (!compact) return "Untitled session";
  return compact.length <= 60 ? compact : `${compact.slice(0, 57)}...`;
}

/**
 * 把任意字符串规约为可用于 ID / 文件名的 slug。
 * 输入：任意字符串。
 * 输出：小写、仅含 a-z0-9._- 的形式；规约后仍为空时回退 "session"。
 * 副作用：无。
 */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "session";
}

/**
 * 由目录路径派生 ProjectId。
 * 输入：目录路径。
 * 输出：长度不超过 80 的 ProjectId；空 slug 回退 "default"。
 * 语义：先 slugify 再截断，保证同一目录在不同平台/不同绝对路径写法下尽量稳定归类。
 * 副作用：无。
 */
export function projectIdFromDirectory(directory: string): ProjectId {
  return createProjectId(slugify(directory).slice(0, 80) || "default");
}
