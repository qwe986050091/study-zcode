// ============================================================
// locale 变更命令的写入目标选择
// ============================================================
// 「切换界面语言」要落到哪个配置文件：项目层已加载且显式带 ui locale 时写项目文件，
// 否则写用户配置。只做路径选择，不读文件、不校验值；配置文件不存在时由下游写入方创建。

import type { ConfigResult } from "@zcode/adapters/config";

/**
 * 选 locale 的落盘路径：项目文件（loaded 且 hasUiLocale 且路径存在）优先，否则用户配置。
 *
 * `hasUiLocale` 让「项目里从没设过语言」继续沿用用户层选择，而不是把项目变成新的唯一来源；
 * 返回的一定是绝对路径，不返回 undefined。
 */
export function getLocaleConfigPath(configResult: ConfigResult): string {
  const project = configResult.sources.project;
  if (project.loaded && project.hasUiLocale && project.uiLocalePath) {
    return project.uiLocalePath;
  }

  return configResult.sources.user.path;
}
