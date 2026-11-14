// 运行平台请求头：把 Node 的平台/架构/内核版本转成可安全放进 HTTP 头的值。
//
// 所有字段都经过 normalizePrintableHeaderValue（拒绝非可打印 ASCII 与控制字符），
// 平台与架构必须同时可用才输出 X-Platform；X-Os-Category 归一为 macos/windows/linux 三值，
// 未知平台按 linux 处理，保证网关侧分类不会出现空洞。
import { arch as readOsArch, release as readOsRelease } from "node:os";

const PRINTABLE_HEADER_VALUE_PATTERN = /^[\x20-\x7e]+$/;

// 返回平台相关头的增量对象：字段缺席即不发送，调用方直接展开合并。
export function createRuntimePlatformHeaders(): Record<string, string> {
  const platform = normalizePrintableHeaderValue(process.platform);
  const architecture = normalizePrintableHeaderValue(readOsArch());
  const osVersion = normalizePrintableHeaderValue(readOsRelease());
  return {
    ...(platform && architecture ? { "X-Platform": `${platform}-${architecture}` } : {}),
    "X-Os-Category": normalizeOsCategory(process.platform),
    ...(osVersion ? { "X-Os-Version": osVersion } : {}),
  };
}

// trim 后必须非空且全部字符落在 0x20–0x7e；否则返回 undefined（调用方据此省略该头）。
// 该函数同时被 model-config 的版本/locale/timezone 复用，是 headers 值的唯一净化口径。
export function normalizePrintableHeaderValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !PRINTABLE_HEADER_VALUE_PATTERN.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

// 三值归一：darwin→macos、win32→windows、其余（含未知平台）→linux。
function normalizeOsCategory(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}
