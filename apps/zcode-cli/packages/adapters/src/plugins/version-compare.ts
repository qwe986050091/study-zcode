import semver from "semver";

/*
 * ============================================================
 * plugins / version-compare.ts —— 已安装插件与最新版本的更新状态判定
 *
 * 定位：把 semver 与 source pin 两种比较轴收敛成三态（none/update-available/
 * version-changed），供插件列表展示“可更新”。
 *
 * 输入输出：纯函数；输入版本字符串可能缺失/非 semver，输出确定性状态。
 *
 * 副作用：无。
 *
 * 失败语义：无法解析的版本不抛错，退化为字符串相等比较（不等即 version-changed）。
 *
 * 不变量：只有能证明“更新”（semver.gt 或 sha 不同）才报 update-available；无法证明时
 * 绝不误报。
 * ============================================================
 */

export type PluginUpdateStatus = "none" | "update-available" | "version-changed";

/**
 * Compare an installed plugin version against the latest manifest version.
 * - semver.gt(latest, installed) -> "update-available"
 * - parseable + not greater (equal or older) -> "none"
 * - unparseable but differing -> "version-changed" (we can't prove it's newer)
 * - unparseable + equal, or either missing -> "none"
 */
export function comparePluginVersions(input: {
  /** 已安装版本；缺失视为无法比较。 */
  installed: string | undefined;
  /** 远端最新版本；缺失视为无法比较。 */
  latest: string | undefined;
}): PluginUpdateStatus {
  const { installed, latest } = input;
  // 任一缺失都只能返回 none：没有基线就谈不上“更新”。
  if (!installed || !latest) return "none";
  const installedValid = semver.valid(semver.coerce(installed) ?? installed);
  const latestValid = semver.valid(semver.coerce(latest) ?? latest);
  if (installedValid && latestValid) {
    return semver.gt(latestValid, installedValid) ? "update-available" : "none";
  }
  return installed === latest ? "none" : "version-changed";
}

/**
 * 按最新目录条目实际提供的比较轴判断更新状态：优先比较可解析的 version，缺失时比较
 * source identity pin；两者都缺失时保持 none，避免把无法证明的新旧关系误报为更新。
 */
export function comparePluginUpdate(input: {
  /** 已安装版本。 */
  installedVersion: string | undefined;
  /** 已安装来源 pin（sha）。 */
  installedSha: string | undefined;
  /** 最新目录条目版本。 */
  latestVersion: string | undefined;
  /** 最新目录条目 sha。 */
  latestSha: string | undefined;
}): PluginUpdateStatus {
  const { installedVersion, installedSha, latestVersion, latestSha } = input;
  // 版本优先：只要最新条目给了可比较版本，就用 semver 轴，避免混用两种口径。
  if (latestVersion) {
    return comparePluginVersions({ installed: installedVersion, latest: latestVersion });
  }
  if (latestSha) {
    if (!installedSha) return "version-changed";
    return installedSha === latestSha ? "none" : "update-available";
  }
  return "none";
}
