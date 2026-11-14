// INV-01 清单模式只接受三个字段：守住位置 对象模式；改错故障 多余字段被静默接受。
// INV-02 模式声明为严格模式：守住位置 收尾调用；改错故障 未知字段随清单一并流转。
// INV-03 版本字符串不得为空：守住位置 字段校验；改错故障 空版本进入比较逻辑。
// INV-04 最低兼容版本编译期注入：守住位置 全局声明；改错故障 本地构建缺少兜底值。
// INV-05 未注入时回落到产品版本：守住位置 三元分支；改错故障 最低版本变成未定义。
// INV-06 清单构造走模式校验：守住位置 解析调用；改错故障 手写对象绕过校验。
// INV-07 版本解析接受可选前缀与构建号：守住位置 正则表达式；改错故障 合法版本被判非法。
// INV-08 解析失败立即抛错：守住位置 未命中分支；改错故障 非法版本比较出错误顺序。
// INV-09 预发布段按点切分：守住位置 切分调用；改错故障 预发布标签整体比较。
// INV-10 数字标识按数值比较：守住位置 数值分支；改错故障 十被判定小于九。
// INV-11 数字标识低于字母标识：守住位置 类型差异分支；改错故障 预发布顺序颠倒。
// INV-12 同类型标识按字典序比较：守住位置 兜底返回；改错故障 非数字标签顺序不稳定。
// INV-13 主次补丁依次比较：守住位置 字段循环；改错故障 低位差异被高位掩盖。
// INV-14 正式版高于同号预发布：守住位置 空段判断；改错故障 预发布被当成更新。
// INV-15 预发布段按最长对齐：守住位置 长度取值；改错故障 短段比较提前结束。
// INV-16 缺段视为更早：守住位置 未定义判断；改错故障 缺段被当成相同。
// INV-17 兼容性以较旧一方的产品版本判定：守住位置 比较方向；改错故障 新版自证兼容。
// INV-18 仅在不兼容时给出升级目标：守住位置 条件展开；改错故障 兼容时仍提示升级方。
//
// 模块职责：Source Server 与 Controller 的版本清单与兼容性判定。
// 状态所有权：无状态；清单在模块加载时构造一次并冻结。
// 阅读顺序：先看清单模式与构造，再看版本比较，最后看兼容性结论。
import { z } from "zod";
import { ZCODE_VERSION } from "../version.js";

declare const __ZCODE_MIN_COMPATIBLE_VERSION__: string;

export const ZCODE_MIN_COMPATIBLE_VERSION =
  typeof __ZCODE_MIN_COMPATIBLE_VERSION__ !== "undefined"
    ? __ZCODE_MIN_COMPATIBLE_VERSION__
    : ZCODE_VERSION;

// 清单只由 schemaVersion、productVersion、minCompatibleVersion 三个字段组成。
// productVersion 与 minCompatibleVersion 都先 .trim()，前后空白不算版本差异。
// 两个版本字段都带 .min(1)，trim 后空串会被 schema 拒绝。
// .strict() 让多余字段直接解析失败，不静默丢弃。
export const compatibilityManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    productVersion: z.string().trim().min(1),
    minCompatibleVersion: z.string().trim().min(1),
  })
  .strict();

export type CompatibilityManifest = z.infer<typeof compatibilityManifestSchema>;

export function createCompatibilityManifest(
  productVersion = ZCODE_VERSION,
  minCompatibleVersion = ZCODE_MIN_COMPATIBLE_VERSION,
): CompatibilityManifest {
  return compatibilityManifestSchema.parse({
    schemaVersion: 1,
    productVersion,
    minCompatibleVersion,
  });
}

export const ZCODE_COMPATIBILITY_MANIFEST = Object.freeze(createCompatibilityManifest());

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

// parseVersion 的正则允许可选的 v 前缀与 +build 构建号。
// 预发布段 match[4] 按 "." 切分存入 prerelease 数组。
// 正则不匹配时抛 Error("Invalid compatibility version")，不做默认值兜底。
function parseVersion(value: string): ParsedVersion {
  const match = value
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u);
  if (!match) throw new Error(`Invalid compatibility version: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left.localeCompare(right);
}

// compareCompatibilityVersions 先比 major、再比 minor、最后比 patch。
// 正式版 prerelease 为空，此时比同号预发布版本高。
// prerelease 逐段交给 compareIdentifier：数字段按数值、字母段按 localeCompare。
export function compareCompatibilityVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1;
    }
    const comparison = compareIdentifier(leftIdentifier, rightIdentifier);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

export interface SourceServerCompatibilityResult {
  compatible: boolean;
  updateAvailable: boolean;
  newerEndpoint: "controller" | "server" | "equal";
  upgradeTarget?: "controller" | "server";
  newerVersion: string;
  olderVersion: string;
  requiredMinimumVersion: string;
}

export function evaluateSourceServerCompatibility(
  controller: CompatibilityManifest,
  server: CompatibilityManifest,
): SourceServerCompatibilityResult {
  const comparison = compareCompatibilityVersions(controller.productVersion, server.productVersion);
  const newerEndpoint = comparison > 0 ? "controller" : comparison < 0 ? "server" : "equal";
  const newer = comparison >= 0 ? controller : server;
  const older = comparison >= 0 ? server : controller;
  const compatible =
    compareCompatibilityVersions(older.productVersion, newer.minCompatibleVersion) >= 0;
  return {
    compatible,
    updateAvailable: comparison !== 0,
    newerEndpoint,
    ...(!compatible
      ? { upgradeTarget: comparison >= 0 ? ("server" as const) : ("controller" as const) }
      : {}),
    newerVersion: newer.productVersion,
    olderVersion: older.productVersion,
    requiredMinimumVersion: newer.minCompatibleVersion,
  };
}
