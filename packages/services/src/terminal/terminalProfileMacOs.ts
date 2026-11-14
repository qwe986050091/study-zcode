// 文件头不变量表（macOS 终端配置探测，best-effort）：
// INV-01：探测器永不抛异常，任何读取失败都退化为 null（守住位置：readMacOsPlistFile 的 try/catch、各 detect 循环）。
//   抛出会让主进程的终端配置装配整段失败，用户失去默认字体与主题。
// INV-02：只有真的读到可用字段才返回结果（守住位置：hasDetectedProfile 与两个 detect 函数的空结果分支）。
//   返回空对象会被 UI 当成有效覆盖，反而抹掉默认字体。
// INV-03：字体与颜色都先归一化再交给 UI（守住位置：normalizeFontSize、normalizeMacOsColor）。
//   非法值透传会让主题渲染出非法 CSS 或超界字号。
// 路径固定为 ~/Library/Preferences 下的 plist；探测只在 darwin 执行，非 macOS 直接返回 null。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TerminalDetectedProfile, TerminalThemeProfile } from "./terminalProfileTypes.js";

// 探测器契约：id 用于日志与去重，platforms 供调用方按平台筛选，detect 必须是 best-effort。
// env 作为参数而不是直读 process.env，测试才能注入不同 HOME 与平台组合。
type TerminalProfileDetector = {
  id: string;
  platforms?: readonly NodeJS.Platform[];
  detect: (env: NodeJS.ProcessEnv) => TerminalDetectedProfile | null;
};

// plutil 是外部进程：没有超时会在 plist 被锁或磁盘卡住时永久挂住主进程。
// 2s 足以转换常规大小的 plist，同时短于用户可感知的启动延迟。
const MACOS_PLIST_READ_TIMEOUT_MS = 2_000;

// 优先 env.HOME：探测器的输入由调用方给定，不能绕过它直接读 os.homedir。
// homedir() 只是最后兜底：从 Dock 启动时 HOME 可能存在但 USERPROFILE 为空。
function resolveHomeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

// 空串与纯空白统一成 null：UI 按 null 判断未探测到，空串会被当成有效字体名渲染。
// 该函数是所有字体字段的唯一出口，后续「是否有值」的判断都依赖这次归一。
function normalizeFontFamily(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// 同时接受 number 与字符串：plutil 转换后是 number，iTerm2 的 Font 串里是文本。
// 6–72 是可用区间，越界值多为误读（例如把行高当字号），交给 UI 会破坏布局。
// parseFloat 容忍 13.0 这类写法，NaN 与非有限值一律按缺失处理。
function normalizeFontSize(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value.trim())
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 6 || parsed > 72) {
    return null;
  }
  return parsed;
}

// 逐段下钻且每层校验对象类型：plist 任意一层都可能是数组或标量，直接点访问会抛 TypeError。
// 数组按不可下钻处理：终端配置的键都是字典，遇到数组说明结构不匹配。
// 返回值经 normalizeFontFamily 归一，空串不会当作有效值继续向上传播。
function readNestedString(value: unknown, pathSegments: readonly string[]): string | null {
  let current: unknown = value;
  for (const segment of pathSegments) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" ? normalizeFontFamily(current) : null;
}

// 这是整套探测唯一的 I/O 入口；平台不符或文件不存在时提前返回，避免无谓 spawn。
// 结果必须是普通对象：数组或标量说明文件结构异常，按读取失败处理。
// [失败路径] 任何异常都终止本次探测而不上抛：探测是增强能力，不是必需依赖。
function readMacOsPlistFile(filePath: string): Record<string, unknown> | null {
// 双条件都必须成立：平台判断防止在 Linux CI 上调用不存在的 plutil，存在性判断避免 spawn 失败。
// [权衡] 先 existsSync 再读，接受一次多余 stat：spawn 失败的错误更难与「plist 损坏」区分。
// 该函数不认识 TCC 权限限制，读取受限只会表现为空结果。
  if (process.platform !== "darwin" || !existsSync(filePath)) {
    return null;
  }

  try {
// 用 plutil 而不是自解析：二进制 plist 与 XML 变体都需要完整实现，系统工具更可靠。
// -o - 把 JSON 输出到 stdout，避免写临时文件；maxBuffer 限制异常大文件的副作用。
// [权衡] execFileSync 阻塞事件循环，但探测只在启动时执行一次且带 2s 上限，换取实现简单。
    const raw = execFileSync("plutil", ["-convert", "json", "-o", "-", filePath], {
      encoding: "utf8",
      windowsHide: true,
      timeout: MACOS_PLIST_READ_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // macOS 终端来源只是 best-effort 插件，plist 缺失、二进制格式异常或 plutil 失败都应静默跳过。
    return null;
  }

  return null;
}

// 去掉末尾字号后缀再还原空格：iTerm2 存的是「MesloLGSDZ-Regular 13」，字号不属于字体名。
// 连字符还原为空格以匹配 UI 字体列表的展示名，Mono/Code 等关键字不受影响。
function normalizeMacOsFontName(value: string | null | undefined): string | null {
  const normalized = normalizeFontFamily(value);
  if (!normalized) {
    return null;
  }

  const withoutSize = normalized.replace(/\s+\d+(?:\.\d+)?$/, "");
  return normalizeFontFamily(withoutSize.replace(/-/g, " "));
}

// 字体名与字号必须来自同一个描述串：分开解析会出现字号对得上、字体名却错的组合。
// 解析失败时两个字段都为 undefined，由 hasDetectedProfile 决定是否继续下一个 profile。
function readMacOsFontDescriptor(
  value: unknown,
): Pick<TerminalDetectedProfile, "fontFamily" | "fontSize"> {
  const raw = typeof value === "string" ? value : value?.toString();
  const fontFamily = normalizeMacOsFontName(raw) ?? undefined;
  const fontSize = normalizeFontSize(raw?.match(/\s+(\d+(?:\.\d+)?)$/)?.[1]) ?? undefined;
  return {
    fontFamily,
    fontSize,
  };
}

// Terminal.app 把字体存成 NSKeyedArchiver 的 base64 数据，只能从二进制里提字符串。
// 同时支持对象与字符串形态：不同系统版本序列化结构不同，取不到 NS 就按缺失处理。
// 该函数是最后兜底，只有 FontName/Font 都读不到时才调用。
function readMacOsArchivedFontName(value: unknown): string | null {
  const rawData =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>).NS?.toString()
        : null;
  const normalizedData = normalizeFontFamily(rawData);
  if (!normalizedData) {
    return null;
  }

  try {
// 用 latin1 解码而不是 utf8：归档数据含长度前缀与二进制头，utf8 会在非法字节处截断。
// 正则限定常见等宽字体关键字，避免把任意可见字符串当作字体名。
// [失败路径] 解码或匹配失败都返回 null；base64 非法时 Buffer 仍产出垃圾，由匹配兜住。
    const decoded = Buffer.from(normalizedData, "base64").toString("latin1");
    const match = decoded.match(
      /([A-Za-z][A-Za-z0-9 ._-]*(?:Mono|Code|Nerd|Powerline|Console|Menlo|Monaco|Courier|Cascadia|Consolas|Hack|Meslo)[A-Za-z0-9 ._-]*)/i,
    );
    return normalizeMacOsFontName(match?.[1]);
  } catch {
    return null;
  }
}

// 颜色可能以 0–1 浮点、0–255 整数或 0–65535（16 位）出现，按量级逐档归一。
// 超出三档的值返回 null 而不是夹紧：夹紧会把明显错误的数据伪装成合法颜色。
function normalizeColorComponent(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value.trim())
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return null;
  }
// 先判 0–1：这是 iTerm2 新版的浮点表示，也是最短区间，优先匹配避免被 255 档误判。
// 判档顺序不能交换：0.5 同时落在前两档，交换后会被放大 255 倍。
// 返回值域固定为 [0,1]，后续统一乘 255 取整。
  if (parsed >= 0 && parsed <= 1) {
    return parsed;
  }
  if (parsed >= 0 && parsed <= 255) {
    return parsed / 255;
  }
  if (parsed >= 0 && parsed <= 65_535) {
    return parsed / 65_535;
  }
  return null;
}

// 按候选键名顺序取第一个存在的键：不同终端版本的键名在大小写与空格上不一致。
// 用 !== undefined 而不是真值判断，保留 0 这种合法颜色分量。
function readColorRecordValue(record: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined) {
      return record[name];
    }
  }
  return undefined;
}

// 字符串形态只接受 hex 与 rgb()/rgba()：其余文本多为命名色或占位，UI 无法直接使用。
// 对象形态要求红绿蓝齐全，缺任一分量返回 null，避免生成偏色。
function normalizeMacOsColor(value: unknown): string | null {
// 先分流字符串，避免把 hex 串当对象取属性而得到 undefined。
// 三段 hex 与带 alpha 的四段 hex 都接受，具体合法性交给下游 CSS 解析。
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      /^#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?$/i.test(trimmed) ||
      /^rgba?\(/i.test(trimmed)
    ) {
      return trimmed;
    }
    return null;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

// 对象形态可能是 NSColor 归档或普通字典，这里只按扁平键读取，不递归下钻。
// 键名同时尝试带空格与驼峰两种写法，兼容不同 macOS 版本的序列化结果。
// 类型断言安全：上方已排除数组与 null。
  const record = value as Record<string, unknown>;
  const red = normalizeColorComponent(
    readColorRecordValue(record, ["Red Component", "red", "Red"]),
  );
  const green = normalizeColorComponent(
    readColorRecordValue(record, ["Green Component", "green", "Green"]),
  );
  const blue = normalizeColorComponent(
    readColorRecordValue(record, ["Blue Component", "blue", "Blue"]),
  );
// alpha 缺失按 1 处理：多数终端只存 RGB，缺失不等于透明。
// 0 是合法 alpha，因此不能用真值判断兜底。
  const alpha =
    normalizeColorComponent(
      readColorRecordValue(record, ["Alpha Component", "alpha", "Alpha", "Opacity"]),
    ) ?? 1;
  if (red === null || green === null || blue === null) {
    return null;
  }

// 四舍五入到 0–255：截断会把 #ffffff 变成 #fefefe，主题色出现可感知偏差。
// 输出 6 位 hex 并逐段补零，保证 #000000 这类值长度固定。
// 半透明时输出 rgba 并保留三位小数，匹配 CSS 可接受的精度。
  const r = Math.round(red * 255);
  const g = Math.round(green * 255);
  const b = Math.round(blue * 255);
  if (alpha < 1) {
    return `rgba(${r}, ${g}, ${b}, ${+alpha.toFixed(3)})`;
  }
  return `#${[r, g, b].map((component) => component.toString(16).padStart(2, "0")).join("")}`;
}

// `readThemeColor` 依次尝试候选键名，命中即停：同一语义可能有多个键。
// 只有 normalizeMacOsColor 成功才写入，失败继续尝试下一个键，不会用空值覆盖已有结果。
function readThemeColor(
  profile: Record<string, unknown>,
  theme: TerminalThemeProfile,
  themeKey: keyof TerminalThemeProfile,
  profileKeys: readonly string[],
): void {
  for (const profileKey of profileKeys) {
    const color = normalizeMacOsColor(profile[profileKey]);
    if (color) {
      theme[themeKey] = color;
      return;
    }
  }
}

// 顺序必须与 ANSI 索引一致（0–7 常规，8–15 亮色）：顺序错会让红绿互换。
// 作为唯一索引源，iTerm2 与 Terminal.app 的键名都按该下标映射。
// as const 让 themeKey 保留字面量类型，readThemeColor 的 keyof 约束才成立。
const ANSI_THEME_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

// 空对象归一成 undefined：UI 用 undefined 表示未探测到主题，空对象会被当成有效覆盖。
// 该归一发生在两个 theme 读取函数的末尾，是 INV-02 的最后一道保障。
function compactTheme(theme: TerminalThemeProfile): TerminalThemeProfile | undefined {
  return Object.keys(theme).length > 0 ? theme : undefined;
}

// iTerm2 的键名带空格且按颜色名拼装，逐个显式读取比循环拼键更易核对。
// 缺失槽位保持未定义，由 UI 决定回退，不在这里填默认色。
function readIterm2Theme(profile: Record<string, unknown>): TerminalThemeProfile | undefined {
  const theme: TerminalThemeProfile = {};
// 先读前景/背景等基础色，保证即使 ANSI 全缺也有可用主题。
// 五次 `readThemeColor` 调用各写各的槽位，互不覆盖。
  readThemeColor(profile, theme, "foreground", ["Foreground Color"]);
  readThemeColor(profile, theme, "background", ["Background Color"]);
  readThemeColor(profile, theme, "cursor", ["Cursor Color"]);
  readThemeColor(profile, theme, "cursorAccent", ["Cursor Text Color"]);
  readThemeColor(profile, theme, "selectionBackground", ["Selection Color"]);

  ANSI_THEME_KEYS.forEach((themeKey, index) => {
    readThemeColor(profile, theme, themeKey, [`Ansi ${index} Color`, `ANSI ${index} Color`]);
  });
  return compactTheme(theme);
}

// Terminal.app 的键名是紧凑驼峰（TextColor/BackgroundColor），与 iTerm2 完全不同。
// 该函数不做默认值填充，空主题由 compactTheme 归一。
function readMacOsTerminalTheme(
  profile: Record<string, unknown>,
): TerminalThemeProfile | undefined {
  const theme: TerminalThemeProfile = {};
  readThemeColor(profile, theme, "foreground", ["TextColor"]);
  readThemeColor(profile, theme, "background", ["BackgroundColor"]);
  readThemeColor(profile, theme, "cursor", ["CursorColor"]);
  readThemeColor(profile, theme, "selectionBackground", ["SelectionColor"]);
// 名称数组必须与 ANSI_THEME_KEYS 等长且同序，二者靠 index 对齐。
// 逐个 if 判空是为了在 noUncheckedIndexedAccess 下也能安全索引。
  const terminalAnsiNames = [
    "ANSIBlackColor",
    "ANSIRedColor",
    "ANSIGreenColor",
    "ANSIYellowColor",
    "ANSIBlueColor",
    "ANSIMagentaColor",
    "ANSICyanColor",
    "ANSIWhiteColor",
    "ANSIBrightBlackColor",
    "ANSIBrightRedColor",
    "ANSIBrightGreenColor",
    "ANSIBrightYellowColor",
    "ANSIBrightBlueColor",
    "ANSIBrightMagentaColor",
    "ANSIBrightCyanColor",
    "ANSIBrightWhiteColor",
  ] as const;
  ANSI_THEME_KEYS.forEach((themeKey, index) => {
    const terminalAnsiName = terminalAnsiNames[index];
    if (terminalAnsiName) {
      readThemeColor(profile, theme, themeKey, [terminalAnsiName]);
    }
  });
  return compactTheme(theme);
}

// 判定标准是至少一个可用字段：全部缺失时继续尝试下一个 profile，而不是返回空主题覆盖 UI 默认。
function hasDetectedProfile(profile: TerminalDetectedProfile): boolean {
  return Boolean(profile.fontFamily || profile.fontSize || profile.theme);
}

// iTerm2 可能有多个 profile，默认 profile 未必带字体信息，因此需要按序回退。
// 读取路径固定，不接受调用方指定文件：避免把任意 plist 当作终端配置解析。
// [失败路径] plist 缺失或损坏时 profiles 为空数组，循环不执行并返回 null。
function detectIterm2Profile(env: NodeJS.ProcessEnv): TerminalDetectedProfile | null {
  const homeDir = resolveHomeDir(env);
  const plist = readMacOsPlistFile(
    join(homeDir, "Library", "Preferences", "com.googlecode.iterm2.plist"),
  );
// New Bookmarks 是 iTerm2 的 profile 列表；非数组一律视为空，避免对未知结构做索引。
// 保持原顺序，后续再把默认 profile 提到最前。
  const profiles = Array.isArray(plist?.["New Bookmarks"])
    ? (plist["New Bookmarks"] as unknown[])
    : [];
  const defaultProfile = profiles.find(
    (profile) =>
      typeof profile === "object" &&
      profile !== null &&
      !Array.isArray(profile) &&
      (profile as Record<string, unknown>)["Default Bookmark"] === true,
  );
// 默认 profile 优先：它才是用户当前使用的配置，其余只是候选。
// 用 filter 而不是 sort，保持其余 profile 的相对顺序，结果可预测。
// [权衡] 每次探测都重新排序而不缓存：配置可能在运行中被用户修改。
  const orderedProfiles = defaultProfile
    ? [defaultProfile, ...profiles.filter((profile) => profile !== defaultProfile)]
    : profiles;

// 非对象元素直接跳过：列表里可能混入字符串或 null。
// 一旦某个 profile 探测到可用字段就返回，不再看后续候选。
  for (const profile of orderedProfiles) {
    if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
      continue;
    }
    const profileObject = profile as Record<string, unknown>;
    const detectedProfile = {
// Normal Font 是 iTerm2 的等宽字体字段，展开后与 theme 合并成完整 profile。
// 使用 satisfies 而不是断言，保证字段名与类型契约一致。
      ...readMacOsFontDescriptor(profileObject["Normal Font"]),
      theme: readIterm2Theme(profileObject),
    } satisfies TerminalDetectedProfile;
    if (hasDetectedProfile(detectedProfile)) {
      return detectedProfile;
    }
  }

  return null;
}

// Terminal.app 的字体在 Startup/Default Window Settings 指向的命名配置里，需要二次下钻。
// 先取启动配置再看默认配置：前者才是用户实际打开的窗口所用设置。
// 两者都读不到时返回 null，不回退到任意 settings 键。
function detectMacOsTerminalProfile(env: NodeJS.ProcessEnv): TerminalDetectedProfile | null {
  const homeDir = resolveHomeDir(env);
  const plist = readMacOsPlistFile(
    join(homeDir, "Library", "Preferences", "com.apple.Terminal.plist"),
  );
// 两个键都可能缺失或为空串，过滤后保持原顺序。
// 名称是用户可编辑的键，不能假设一定存在。
// 去重不是必需的：重复名称第二次循环读到同一配置，结果相同。
  const settingsNames = [
    readNestedString(plist, ["Startup Window Settings"]),
    readNestedString(plist, ["Default Window Settings"]),
  ].filter((name): name is string => Boolean(name));

// 配置值必须是对象：标量说明该键被用于其他用途，按缺失处理。
// 任一候选命中可用字段即返回，避免低优先级配置覆盖高优先级结果。
  for (const settingsName of settingsNames) {
    const settings = plist?.[settingsName];
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      continue;
    }

    const settingsObject = settings as Record<string, unknown>;
// 三层回退：FontName 是明文键，Font 可能是明文也可能是归档数据。
// 顺序不能交换：归档解析最贵且最容易误匹配，只在明文都失败时使用。
// 三个读取函数都返回 null 而不抛错，因此 ?? 链可以安全串联。
    const fontFamily =
      readNestedString(settingsObject, ["FontName"]) ??
      normalizeMacOsFontName(readNestedString(settingsObject, ["Font"])) ??
      readMacOsArchivedFontName(settingsObject.Font);
    const detectedProfile = {
      fontFamily: fontFamily ?? undefined,
      fontSize:
        normalizeFontSize(settingsObject.FontSize) ??
        readMacOsFontDescriptor(settingsObject.Font).fontSize,
      theme: readMacOsTerminalTheme(settingsObject),
    } satisfies TerminalDetectedProfile;
    if (hasDetectedProfile(detectedProfile)) {
      return detectedProfile;
    }
  }

  return null;
}

// 注册顺序即优先级：iTerm2 在前，Terminal.app 兜底，调用方按 id 记录来源。
// platforms 限定 darwin：非 macOS 上调用方不会选到这两个探测器。
// 返回只读数组，防止调用方在运行时改写列表影响其他窗口。
// detect 直接引用模块内函数，测试通过 env 注入控制读取的 HOME。
export function createMacOsTerminalProfileDetectors(): readonly TerminalProfileDetector[] {
  return [
    {
      id: "iterm2",
      platforms: ["darwin"],
      detect: detectIterm2Profile,
    },
    {
      id: "macos-terminal",
      platforms: ["darwin"],
      detect: detectMacOsTerminalProfile,
    },
  ];
}
