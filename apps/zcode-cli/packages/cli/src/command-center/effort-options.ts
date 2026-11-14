import { getZCodeCopy, type UiLocale } from "@zcode/i18n";
import type { TuiEffortOption } from "@zcode/tui";
import type { CommandCenterApp } from "./types.js";

// 从 app 读取思考档位并转成 TUI 选项；app 不支持该能力时返回 undefined，
// 与「支持但当前模型无档位（空数组）」区分，调用方据此决定是否展示选择器。
export async function listAppEffortOptions(
  app: CommandCenterApp,
): Promise<TuiEffortOption[] | undefined> {
  const levels = app.listThoughtLevels ? await app.listThoughtLevels() : undefined;
  return levels ? thoughtLevelsToEffortOptions(levels, app.getLocale?.()) : undefined;
}

// 档位名映射为本地化 TUI 选项，保持原始顺序；空数组原样返回空数组。
export function thoughtLevelsToEffortOptions(
  levels: readonly string[],
  locale?: UiLocale,
): TuiEffortOption[] {
  const effortCopy = getZCodeCopy(locale).tui.effort;
  return levels.map((level) => ({
    id: level,
    label: effortLabel(level, effortCopy),
  }));
}

// 单档位标签解析：只特判 enabled/disabled 两个语义值并走 i18n 文案，其余按字面量显示。
function effortLabel(level: string, effortCopy: { disabled: string; enabled: string }): string {
  if (level === "enabled") return effortCopy.enabled;
  if (level === "disabled") return effortCopy.disabled;
  return level;
}
