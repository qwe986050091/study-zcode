// INV-01 主题名到调色板是穷举映射：守住位置 switch 四个分支；改错故障 新主题掉进深色兜底。
// INV-02 system 先解析成具体明暗：守住位置 useResolvedThemeHeroPalette；改错故障 system 被当成 dark 直接使用。
// INV-03 zai-light 与 light 不共用：守住位置 case 顺序；改错故障 品牌浅色套上默认浅色蓝。
// INV-04 zai-dark 与 dark 不共用：守住位置 两个分支各自的字面量；改错故障 品牌深色丢失蓝色基调。
// INV-05 dark 与 system 落到同一兜底：守住位置 default 前的连续 case；改错故障 未识别主题渲染成空白。
// INV-06 面板渐变属于调色板而非组件：守住位置 palette.panel 拼接；改错故障 主题切换只换字色不换背景。
// INV-07 两团光晕同源不同色：守住位置 glowPrimary 与 glowSecondary；改错故障 明暗主题光晕冲突。
// INV-08 光晕是纯装饰：守住位置 pointer-events-none；改错故障 光晕挡住内容点击。
// INV-09 内容层置顶：守住位置 z-10；改错故障 内容被渐层覆盖。
// INV-10 内容可选：守住位置 children 三元；改错故障 无内容时渲染空壳。
// INV-11 外部类名追加而非覆盖：守住位置 cn 参数顺序；改错故障 调用方样式被内部覆盖。
// INV-12 调色板只读：守住位置 每次返回新对象；改错故障 调用方修改污染其它实例。
// INV-13 颜色值集中在此文件：守住位置 各 case 的字面量；改错故障 主题色散落到组件里。
//
// 模块职责：把主题名映射成首页 Hero 的渐层与光晕配色，并渲染可选内容层。
// 阅读顺序：先看主题映射的四个分支，再看 system 解析，最后看 Hero 的两团光晕与内容层。
import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import type { Theme } from "@/useTheme.js";

// 调色板的七个字段决定 Hero 的全部视觉。
interface ThemeHeroPalette {
  panel: string;
  meshBase: string;
  meshLight: string;
  glowPrimary: string;
  glowSecondary: string;
  heading: string;
  description: string;
}

// 纯函数映射，便于在不同主题间比对取值。
function getThemeHeroPalette(theme: Theme): ThemeHeroPalette {
  switch (theme) {
    // light 主题用 meshBase #eff6ff 打底，sky 色主光晕配 blue 次光晕以保持蓝白基调。
    case "light":
      return {
        meshBase: "#eff6ff",
        meshLight: "#7dd3fc",
        panel:
          "bg-[linear-gradient(180deg,#eff6ff_0%,#dbeafe_34%,#bfdbfe_100%)] before:absolute before:inset-0 before:content-[''] before:bg-[radial-gradient(circle_at_18%_18%,rgba(255,255,255,0.9),transparent_24%),radial-gradient(circle_at_82%_16%,rgba(125,211,252,0.42),transparent_26%),radial-gradient(circle_at_68%_80%,rgba(96,165,250,0.24),transparent_28%)]",
        glowPrimary: "bg-sky-200/70 mix-blend-screen",
        glowSecondary: "bg-blue-200/70 mix-blend-multiply",
        heading: "text-slate-900",
        description: "text-slate-700/80",
      };
    // zai-light 主题把 meshBase 设为 #f8f8f8，光晕统一用 #80BEFF 的乘法混合。
    case "zai-light":
      return {
        meshBase: "#f8f8f8",
        meshLight: "#80beff",
        panel:
          "bg-[linear-gradient(180deg,#ffffff_0%,#f8f8f8_42%,#ebf4ff_100%)] before:absolute before:inset-0 before:content-[''] before:bg-[radial-gradient(circle_at_18%_20%,rgba(255,255,255,0.9),transparent_24%),radial-gradient(circle_at_82%_14%,rgba(11,127,255,0.2),transparent_26%),radial-gradient(circle_at_70%_84%,rgba(128,190,255,0.2),transparent_30%)]",
        glowPrimary: "bg-[#80BEFF]/45 mix-blend-multiply",
        glowSecondary: "bg-[#EBF4FF]/80 mix-blend-multiply",
        heading: "text-[#0D0D0D]",
        description: "text-[#5C5C5C]",
      };
    // zai-dark 主题从 #161616 过渡到 #001d3d，光晕改用屏幕混合以在深底上显色。
    case "zai-dark":
      return {
        meshBase: "#001d3d",
        meshLight: "#80beff",
        panel:
          "bg-[linear-gradient(180deg,#161616_0%,#202020_42%,#001d3d_100%)] before:absolute before:inset-0 before:content-[''] before:bg-[radial-gradient(circle_at_18%_18%,rgba(64,153,255,0.18),transparent_24%),radial-gradient(circle_at_82%_12%,rgba(128,190,255,0.2),transparent_26%),radial-gradient(circle_at_66%_84%,rgba(153,199,255,0.16),transparent_28%)]",
        glowPrimary: "bg-[#4099FF]/22 mix-blend-screen",
        glowSecondary: "bg-[#80BEFF]/16 mix-blend-screen",
        heading: "text-[#F8F8F8]",
        description: "text-[#ADADAD]",
      };
    case "dark":
    // system 与 dark 共用兜底分支。
    case "system":
    // 未知主题一律落到深色，保证可读。
    default:
      return {
        meshBase: "#060816",
        meshLight: "#60a5fa",
        panel:
          "bg-[linear-gradient(180deg,#060816_0%,#0b1333_38%,#12245a_72%,#173474_100%)] before:absolute before:inset-0 before:content-[''] before:bg-[radial-gradient(circle_at_16%_20%,rgba(165,243,252,0.14),transparent_22%),radial-gradient(circle_at_82%_14%,rgba(96,165,250,0.18),transparent_24%),radial-gradient(circle_at_68%_84%,rgba(56,189,248,0.14),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0))]",
        glowPrimary: "bg-cyan-300/22 mix-blend-screen",
        glowSecondary: "bg-blue-400/18 mix-blend-screen",
        heading: "text-slate-50",
        description: "text-slate-200/72",
      };
  }
}

export function useResolvedThemeHeroPalette(): ThemeHeroPalette {
  // useResolvedThemeHeroPalette 订阅 useZCodeStore 的 state.theme，主题变更时自动重算调色板。
  const theme = useZCodeStore((state) => state.theme);
  const resolvedTheme =
    // system 取解析后的明暗，不把 system 传下去。
    theme === "system" ? (resolveTheme(theme) === "dark" ? "dark" : "light") : theme;

  return getThemeHeroPalette(resolvedTheme);
}

export function ThemeHeroVisual(props: {
  className?: string;
  contentClassName?: string;
  children?: ReactNode;
}) {
  // 每次渲染重新取调色板，保证跟随主题。
  const palette = useResolvedThemeHeroPalette();

  return (
    // panel 负责底色与网格，外部类名只做追加。
    <div className={cn("relative overflow-hidden", palette.panel, props.className)}>
      <div
        className={cn(
          "pointer-events-none absolute left-[-12%] top-[18%] h-[42rem] w-[42rem] rounded-full blur-3xl",
          // 主光晕用 left-[-12%] top-[18%] 锚在左上，给标题区留出聚光。
          palette.glowPrimary,
        )}
      />
      <div
        className={cn(
          "pointer-events-none absolute right-[-18%] bottom-[-14%] h-[36rem] w-[36rem] rounded-full blur-3xl",
          // 次光晕用 right-[-18%] bottom-[-14%] 压在右下，补足渐变层次。
          palette.glowSecondary,
        )}
      />
      {props.children ? (
        <div className={cn("relative z-10", props.contentClassName)}>{props.children}</div>
      ) : null}
    </div>
  );
}
