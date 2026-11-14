// INV-01 先 trim 再去 v 前缀：守住位置 parseSemver 首行；改错故障 带空格或前缀的版本解析失败，强制更新永不触发。
// INV-02 标准 semver 优先于简写补全：守住位置 三条匹配的顺序；改错故障 "4.5" 被先当成主版本号解析。
// INV-03 构建元数据不参与比较：守住位置 正则的加号段；改错故障 同版本仅构建号不同被判为需要升级。
// INV-04 预发布版低于同号正式版：守住位置 comparePrerelease 的空数组分支；改错故障 1.0.0-beta 被当成高于 1.0.0。
// INV-05 预发布逐段比较，数字段按数值、其余按字典序：守住位置 循环内分支；改错故障 beta.10 排在 beta.9 之前。
// INV-06 数字段小于字母段：守住位置 numeric 异或分支；改错故障 1.0.0-1 被判为高于 1.0.0-alpha。
// INV-07 段数短的一方更小：守住位置 undefined 分支；改错故障 前缀相同的两个预发布版被判为相等。
// INV-08 解析失败返回 null 而不是抛错：守住位置 三个解析出口；改错故障 脏配置让设置页崩溃。
// INV-09 无法比较不得当作需要升级：守住位置 compareSemverVersions 的 null 出口；改错故障 部分用户被莫名强制更新。
// INV-10 空或纯空白的最小版本视为不限制：守住位置 resolve 的前置判断；改错故障 空字符串触发全员强制更新。
// INV-11 当前版本不低于最小版本即不提示：守住位置 comparison 大于等于零；改错故障 最新版用户仍被要求升级。
// INV-12 返回值只带两个版本号：守住位置 返回对象；改错故障 UI 依赖额外字段后无法复用。
// INV-13 比较不读远端顺序或时间：守住位置 整个模块无外部状态；改错故障 服务端下发顺序影响判断。
//
// 模块职责：把远端下发的 minimalVersion 与本地版本比较，决定是否必须更新。
// 阅读顺序：先看解析与补全，再看预发布比较，最后看准入判定。
import type { ForceUpdateConfig } from "./coding-plan-subscription.js";

export interface ForceUpdateRequirement {
  currentVersion: string;
  minimalVersion: string;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseSemver(version: string): ParsedSemver | null {
  // [边界] parseSemver 只去空白与 v 前缀：段数不得在解析期补全，否则会打乱后续三条正则的先后顺序。
  // 不要在这里补全段数：补全依赖后续三条正则的先后顺序。
  // 大小写不敏感只作用于前缀，版本主体保持原样。
  const normalized = version.trim().replace(/^v/i, "");

  // 远端配置可能只传主版本号（如 "45"）或主次版本号（如 "4.5"），
  // 严格 semver（X.Y.Z）解析会返回 null，导致 resolveForceUpdateRequirement
  // 永远不触发。这里依次尝试标准版本和补齐版本，兼容服务端简写格式。
  // 严格 semver 优先，命中后不再走补全分支。
  // 预发布段按点切分，供逐段比较使用。
  // 构建元数据被正则吞掉但不入结构，天然不参与比较。
  const strictMatch = normalized.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (strictMatch) {
    return {
      major: Number(strictMatch[1]!),
      minor: Number(strictMatch[2]!),
      patch: Number(strictMatch[3]!),
      prerelease: strictMatch[4]?.split(".") ?? [],
    };
  }

  // 补全：只有主版本号（"45" → "45.0.0"）
  const majorOnly = normalized.match(/^(\d+)$/);
  if (majorOnly) {
    return {
      major: Number(majorOnly[1]!),
      minor: 0,
      patch: 0,
      prerelease: [],
    };
  }

  // 补全：主版本号.次版本号（"4.5" → "4.5.0"）
  const majorMinor = normalized.match(/^(\d+)\.(\d+)$/);
  if (majorMinor) {
    return {
      major: Number(majorMinor[1]!),
      minor: Number(majorMinor[2]!),
      patch: 0,
      prerelease: [],
    };
  }

  return null;
}

// 空数组代表正式版，正式版高于任何预发布版。
// 逐段比较：纯数字段按数值，其余按字典序。
// 数字段低于字母段，这是 semver 的明确规定。
// 段数不等时短者更小，注意这里必须先判 undefined。
function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const delta = Number(leftPart) - Number(rightPart);
      if (delta !== 0) {
        return delta > 0 ? 1 : -1;
      }
      continue;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }

    const delta = leftPart.localeCompare(rightPart);
    if (delta !== 0) {
      return delta > 0 ? 1 : -1;
    }
  }

  return 0;
}

// 主次补丁逐段比较，任一不等即返回，不再看预发布。
// 两边都解析成功才比较预发布；解析失败统一返回 null。
// 返回 null 是「无法比较」，调用方必须显式处理。
export function compareSemverVersions(leftVersion: string, rightVersion: string): number | null {
  const left = parseSemver(leftVersion);
  const right = parseSemver(rightVersion);
  if (!left || !right) {
    return null;
  }

  for (const key of ["major", "minor", "patch"] as const) {
    const delta = left[key] - right[key];
    if (delta !== 0) {
      return delta > 0 ? 1 : -1;
    }
  }

  return comparePrerelease(left.prerelease, right.prerelease);
}

export function resolveForceUpdateRequirement(params: {
  currentVersion: string;
  forceUpdate?: ForceUpdateConfig | null;
}): ForceUpdateRequirement | null {
  // 空串与纯空白都表示未配置，此时不强制更新。
  // 当前版本无法解析或已达标时同样不返回需求。
  const minimalVersion = params.forceUpdate?.minimalVersion.trim();
  if (!minimalVersion) {
    return null;
  }

  const comparison = compareSemverVersions(params.currentVersion, minimalVersion);
  if (comparison === null || comparison >= 0) {
    return null;
  }

  return {
    currentVersion: params.currentVersion,
    minimalVersion,
  };
}
