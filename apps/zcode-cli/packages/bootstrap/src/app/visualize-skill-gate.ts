// ============================================================
// visualize 官方技能的终端侧剔除
// ============================================================
// 内置插件默认启用会让终端会话也发现 visualize，但终端没有内联视图宿主。技能发现后、交给
// 运行时之前调用本函数；协议入口通过 includeVisualize=true 显式保留。
// 只按 pluginId 过滤，用户/项目里同名技能不受影响。

import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, type SkillRoot } from "@zcode/contracts";

/** 官方 visualize 插件的完整身份 `<name>@<marketplace>`；按身份而非技能名匹配。 */
const VISUALIZE_PLUGIN_ID = `visualize@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;

/**
 * 过滤技能根：默认剔除官方 visualize 插件贡献的根，includeVisualize 为真时原样返回。
 *
 * 纯函数、不改入参顺序；返回的是过滤后的浅数组。剔除只影响发现结果，不卸载插件本身。
 */
export function filterVisualizeSkillRoots(
  roots: readonly SkillRoot[],
  includeVisualize = false,
): SkillRoot[] {
  // 内置插件默认启用曾让终端会话也发现 visualize，但终端没有内联视图宿主。
  // 只过滤官方插件身份，避免误伤用户/项目自定义的同名技能；协议入口显式保留。
  return roots.filter((root) => includeVisualize || root.pluginId !== VISUALIZE_PLUGIN_ID);
}
