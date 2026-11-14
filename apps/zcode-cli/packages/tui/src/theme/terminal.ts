// 终端主题探测（L2）：从 renderer 已上报的 themeMode 或 16 色调色板亮度推断深浅主题。
// 只做只读能力探测，不改 renderer 状态；所有失败/超时静默降级为 null，由上层回退默认主题。
// 探测总等待约 600ms（250ms 上报 + 350ms 调色板），绝不阻塞首屏渲染。
import type { CliRenderer, TerminalColors } from "@mbears/opentui-core";
import type { UiThemeMode } from "@zcode/contracts";
import { isTuiThemeMode } from "./state.js";

// 等待终端上报主题模式的上限；超时后不再阻塞首屏，改走调色板启发式。
const THEME_MODE_WAIT_TIMEOUT_MS = 250;
// 查询 16 色调色板的总超时，失败后返回 null 由调用方回退到默认主题。
const PALETTE_DETECTION_TIMEOUT_MS = 350;
// #RRGGBB 固定 7 个字符（# + 6 位十六进制）。
const HEX_COLOR_LENGTH = 7;
const HEX_RADIX = 16;
const RGB_COMPONENT_START = 1;
const RGB_COMPONENT_SIZE = 2;
// 加权亮度阈值：背景亮度大于 128 判为浅色终端。
const BRIGHTNESS_THRESHOLD = 128;

type TerminalThemeRenderer = Pick<
  CliRenderer,
  "getPalette" | "themeMode" | "waitForThemeMode"
>;

// 按可靠性优先级探测终端主题：已知 themeMode → 短暂等待上报 → 调色板亮度推断。
// 任一环节失败/超时都静默降级为 null，由上层回退到默认主题，绝不阻塞渲染。
// 异步函数，不修改 renderer 状态；最多等待约 600ms。
export async function resolveInitialTerminalThemeMode(
  renderer: TerminalThemeRenderer,
): Promise<UiThemeMode | null> {
  const current = normalizeThemeMode(renderer.themeMode);
  if (current) return current;

  const detected = normalizeThemeMode(
    await renderer.waitForThemeMode(THEME_MODE_WAIT_TIMEOUT_MS).catch(() => null),
  );
  if (detected) return detected;

  return await detectThemeModeFromPalette(renderer);
}

// 判定只看背景色，不参考前景或调色板其余 15 色；浅色背景即判 light，与终端品牌无关。
// 纯函数：不修改 colors、不发起额外查询；非法色值（非 #RRGGBB）返回 null，由上层回退默认主题。
// 从调色板推断主题：优先取 defaultBackground，缺省用 0 号色（通常是终端背景）。
// 无有效颜色时返回 null，保证"未知"与"深色"可区分。
export function inferThemeModeFromTerminalColors(colors: TerminalColors): UiThemeMode | null {
  const background = colors.defaultBackground ?? colors.palette[0];
  if (!background) return null;
  return inferThemeModeFromHex(background);
}

// 过滤终端传入的任意值，只放行合法主题模式。
function normalizeThemeMode(value: unknown): UiThemeMode | null {
  return isTuiThemeMode(value) ? value : null;
}

// 调色板查询失败（终端不支持 OSC 查询等）时返回 null，不让异常冒泡到启动流程。
async function detectThemeModeFromPalette(
  renderer: TerminalThemeRenderer,
): Promise<UiThemeMode | null> {
  try {
    const colors = await renderer.getPalette({
      size: 16,
      timeout: PALETTE_DETECTION_TIMEOUT_MS,
    });
    return inferThemeModeFromTerminalColors(colors);
  } catch {
    return null;
  }
}

// 非法色值直接返回 null；亮度采用 ITU-R BT.601 加权（299/587/114）近似人眼感知。
function inferThemeModeFromHex(color: string): UiThemeMode | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(color) || color.length !== HEX_COLOR_LENGTH) {
    return null;
  }

  const red = readHexComponent(color, RGB_COMPONENT_START);
  const green = readHexComponent(color, RGB_COMPONENT_START + RGB_COMPONENT_SIZE);
  const blue = readHexComponent(color, RGB_COMPONENT_START + RGB_COMPONENT_SIZE * 2);
  const brightness = (red * 299 + green * 587 + blue * 114) / 1000;
  return brightness > BRIGHTNESS_THRESHOLD ? "light" : "dark";
}

// 按两位十六进制切片解析单个 RGB 分量。
function readHexComponent(color: string, offset: number): number {
  return Number.parseInt(color.slice(offset, offset + RGB_COMPONENT_SIZE), HEX_RADIX);
}

