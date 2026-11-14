// 终端字体 profile 解析：字体栈由用户设置、终端配置与平台默认值合成。
// resolveTerminalFontProfile 不做渲染，只决定新开终端的字体/字号/主题与来源。
//
// INV-01：settings.terminalFontFamily 非空时必须返回 source=custom（守住它的位置：
//   resolveTerminalFontProfile 的首个分支）。破坏后果：用户选的字体被系统探测结果顶掉，
//   表现为 settings.terminalFontFamily 改完重启又变回原样，界面没有任何提示。
// INV-02：terminalInheritSystemProfile === false 时不得读取任何系统配置文件
//   （守住它的位置：resolveTerminalFontProfile 中 detectedProfile 的计算）。破坏后果：
//   显式关闭继承的用户仍被读取终端配置，属于越权读取隐私文件，会让 INV-02 失效。
// INV-03：任何探测失败（文件缺失、JSONC 解析失败、字段不是字符串）都必须退化为 null 并继续
//   （守住它的位置：readJsoncFile/readObjectFile 的 catch 与 readNestedString 的类型检查）。
//   破坏后果：一个损坏的 settings.json 会让整个 profile 解析中断，终端退回默认外观。
// INV-04：fontFamily 返回值永远是非空字符串（守住它的位置：dedupeFontFamilyStack 与末尾
//   fallback 分支）。破坏后果：下游拼进 CSS font-family 或 xterm 配置时出现空串，
//   终端回落到浏览器等宽默认字体，CJK 与 Nerd Font 图标全部错位。
// INV-05：探测按 TERMINAL_FONT_DETECTORS 的数组顺序取第一个命中（守住它的位置：
//   detectSystemTerminalProfile 的循环）。破坏后果：顺序变更会让通用探测器抢在专用探测器
//   之前命中就会读到另一个应用的字体，同一台机器两次打开的字体可能不同。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppSettings } from "@zcode/shared";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { createMacOsTerminalProfileDetectors } from "./terminalProfileMacOs.js";
import type {
  TerminalDetectedProfile,
  TerminalFontFamilySource,
  TerminalThemeProfile,
} from "./terminalProfileTypes.js";
export type { TerminalFontFamilySource, TerminalThemeProfile } from "./terminalProfileTypes.js";

interface TerminalFontProfile {
  fontFamily: string;
  fontSize?: number;
  theme?: TerminalThemeProfile;
  source: TerminalFontFamilySource;
}

interface TerminalFontProfileInput {
  settings: Pick<AppSettings, "terminalFontFamily" | "terminalInheritSystemProfile">;
  env?: NodeJS.ProcessEnv;
}

type TerminalFontDetector = {
  id: string;
  platforms?: readonly NodeJS.Platform[];
  detect: (env: NodeJS.ProcessEnv) => TerminalDetectedProfile | null;
};

// 兜底字体栈：从通用到具体再到 CJK 收尾，顺序本身承载语义，不是随便排列。
// 前段是各平台自带的等宽字体，靠后的 Nerd Font 只在用户装过时才生效。
// 末尾的 monospace 必须留在最后，它是整串失效时的最终断言；前移会遮蔽后面所有真实字体。
// [权衡] 不按平台裁剪列表：同一份 profile 可能被远端与手机端复用，裁剪会造成跨端不一致，
// 而未安装的字体在 CSS 与 xterm 中都是静默跳过的，保留它们没有运行时成本。
// 调用方把结果直接拼进 CSS 与 xterm 配置，因此这里只能返回字体族名，不能带样式。
const FONT_FAMILY_FALLBACKS = [
  "ui-monospace",
  "SFMono-Regular",
  "SF Mono",
  "Menlo",
  "Monaco",
  "Consolas",
  "Cascadia Mono",
  "JetBrains Mono",
  "MesloLGS NF",
  "Hack Nerd Font",
  "Noto Sans Mono CJK SC",
  "monospace",
] as const;

// 平台差异：Windows 没有 HOME 只有 USERPROFILE，Unix 反之；两者都可能被显式置空
// （容器与 CI 常见），因此空串要继续下退，不能当成已解析。最后的 os.homedir() 读账户
// 数据库，能覆盖 env 被裁剪的场景；这里不校验目录是否存在，探测端会逐项 existsSync 过滤。
// 返回的 home 只用于拼候选路径；不存在时由各探测器的 existsSync 过滤，本函数不校验目录。
function resolveHomeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

// 把看起来是空的输入统一收敛为 null：终端配置里空白串与字段缺失语义相同，
// 若把空串当有效值就会打破 INV-04。trim 顺带去掉复制粘贴带来的换行与首尾空格。
// 这里不校验字体名是否真实存在：字体缺失时终端会静默跳过，提前拒绝反而误伤。
// 输入来自 settings 与终端配置文件，二者都可能是用户手写，空白必须视为未设置。
function normalizeFontFamily(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// 探测器可能返回只有 fontSize/theme 的空壳（macOS 常见：只读到配色，没有字体族）。
// 三者全空才视为未命中，只要有一项就保留，因为 resolveTerminalFontProfile 会用兜底
// 字体补上缺失的 fontFamily。这里不抛错也不写日志：探测是尽力而为，
// 每次打开终端都刷日志会淹没真正的问题。
function normalizeDetectedProfile(
  profile: TerminalDetectedProfile | null,
): TerminalDetectedProfile | null {
  if (!profile?.fontFamily && !profile?.fontSize && !profile?.theme) {
    return null;
  }
  return profile;
}

// 把用户字体串与兜底栈合并成去重后的完整栈，保证 INV-04 与 INV-05 的字体可解析性。
// 用整串比较而不是前缀或模糊匹配：字体族名允许带空格与引号，模糊匹配会把
// 'JetBrains Mono' 与 'JetBrainsMono' 误判为同一个，从而漏掉用户指定的那一项。
// [权衡] 不做大小写归一：Linux 上的终端实现按字面匹配字体名，归一反而会改坏正确写法。
// primary 可能已是逗号分隔的字体栈，先拆分再补兜底，避免整串被当成一个字体名。
function dedupeFontFamilyStack(primary: string): string {
  const stack = primary
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const fallback of FONT_FAMILY_FALLBACKS) {
    if (!stack.includes(fallback)) {
      stack.push(fallback);
    }
  }
  return stack.join(", ");
}

// Windows Terminal 与 VS Code 的 settings.json 允许行注释与块注释，标准 JSON.parse 会直接拒绝。
// 这里手写状态机而不是正则：必须区分字符串内的注释符号与真注释，正则无法可靠处理
// 转义引号以及 https:// 这类高频内容。注释替换为换行而非删除，是为了让后续尾逗号清理
// 与 JSON.parse 的报错行号仍能对上原文件；块注释需要跳过结束符本身，否则会误判。
// raw 来自磁盘上的用户配置文件，长度不受控；逐字符扫描保证线性时间且不构造正则。
function stripJsonComments(raw: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
    } else if (char === "/" && next === "/") {
      while (index < raw.length && raw[index] !== "\n") index += 1;
      result += "\n";
    } else if (char === "/" && next === "*") {
      index += 2;
      while (index < raw.length && !(raw[index] === "*" && raw[index + 1] === "/")) index += 1;
      index += 1;
    } else {
      result += char;
    }
  }
  return result;
}

// 尾随逗号在 JSONC 中合法，在 JSON.parse 中非法，必须在字符串外剥离，
// 字符串内的逗号（如 'a,b'）原样保留。向前跳过空白时用 ?? 兜住越界读取，
// 末端逗号因此会保留，最终由 JSON.parse 抛错并被上层 catch 成 null（INV-03）。
// 入参是 stripJsonComments 的输出：注释已换成换行，这里只处理字符串外的逗号。
function removeJsonTrailingCommas(raw: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    if (char === ",") {
      let nextIndex = index + 1;
      while (/\s/.test(raw[nextIndex] ?? "")) nextIndex += 1;
      if (raw[nextIndex] === "}" || raw[nextIndex] === "]") continue;
    }
    result += char;
  }
  return result;
}

// 两级尝试：先按标准 JSON 解析，失败后再做注释与尾逗号清洗；顺序不能反，
// 先清洗等于无条件改写原文，标准 JSON 的严格性就没了。只接受普通对象，
// 数组与标量不是配置文件，返回它们会让后续的路径下钻静默失效。
// 返回 null 表示该配置文件不可用，探测器继续下一个候选，调用方不会收到异常。
function parseJsonc(raw: string): Record<string, unknown> | null {
  const attempts = [raw, removeJsonTrailingCommas(stripJsonComments(raw))];
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // continue
    }
  }
  return null;
}

// 探测入口的公共读盘封装，必须永不抛出（INV-03）。权限不足、文件被编辑器占用、
// 编码异常都在这里吞掉：这些是用户环境的常态而不是代码缺陷，向上传播只会让整个
// 字体探测中断；不缓存是权衡：配置可能在运行期改变，缓存必须依赖文件监听，
// 而探测本身只是几次 existsSync 加一个很小的文件读取。
function readJsoncFile(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, "utf8");
    return parseJsonc(raw);
  } catch {
    return null;
  }
}

// 按路径逐层下钻取字符串，任一层不是普通对象就返回 null。必须显式排除数组：
// JS 里数组也能用字符串下标访问，不排除会让 list.0.font 这类路径意外命中，
// 读到与语义无关的结构。只有 string 才继续 normalize，避免把数字或布尔
// 隐式转成字体名，那会生成一个永远匹配不到任何字体的字符串。
// [失败路径] 中途任一环为 null 即返回 null，由探测器继续尝试下一个候选文件。
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

// TOML 与 YAML 共用的读盘加解析封装，同样遵守 INV-03 的失败即 null。
// readObjectFile 的解析器由调用方注入，避免本文件为两种格式各写一份读盘与异常处理。
function readObjectFile(
  filePath: string,
  parser: (raw: string) => unknown,
): Record<string, unknown> | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = parser(readFileSync(filePath, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

// Windows Terminal 的字体优先级必须与它自己的解析顺序一致：defaultProfile 指定的 profile
// 优先于 profiles.defaults，再优先于 list 中第一个带 font.face 的 profile。顺序反了会让
// 用户为某个 profile 单独设置的字体被全局 defaults 覆盖，看起来像设置没生效。
// LOCALAPPDATA 优先于 APPDATA：Store 版配置在 Packages 下，只有 unpackaged 版才在 Roaming。
// 三个候选都要试：稳定版、Preview 版与 unpackaged 版可能同时存在，漏掉任一路径都会读错来源。
// env 来自调用方注入，进程启动后不再变化；Store 版与 unpackaged 版可能并存。
function detectWindowsTerminalFontFamily(env: NodeJS.ProcessEnv): TerminalDetectedProfile | null {
  if (process.platform !== "win32") {
    return null;
  }

  const localAppData = env.LOCALAPPDATA?.trim() || env.APPDATA?.trim();
  if (!localAppData) {
    return null;
  }

  const candidates = [
    join(
      localAppData,
      "Packages",
      // 包族名是 Store 安装的固定标识，不能按显示名查找（显示名可被本地化或用户修改）。
      "Microsoft.WindowsTerminal_8wekyb3d8bbwe",
      "LocalState",
      "settings.json",
    ),
    join(
      localAppData,
      "Packages",
      "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe",
      "LocalState",
      "settings.json",
    ),
    join(localAppData, "Microsoft", "Windows Terminal", "settings.json"),
  ];

  for (const filePath of candidates) {
    const parsed = readJsoncFile(filePath);
    if (!parsed) {
      continue;
    }

    // defaultProfile 是 GUID 且允许带花括号，这里不做格式归一，因为它自己也按字面匹配。
    // guid 不匹配的 profile 只是别的配置项，绝不能提前 return，必须继续看 defaults。
    const defaultProfileId = readNestedString(parsed, ["defaultProfile"]);
    const profiles = parsed.profiles as Record<string, unknown> | undefined;
    const list = Array.isArray(profiles?.list) ? profiles?.list : [];
    if (defaultProfileId) {
      for (const item of list) {
        const profile = item as Record<string, unknown> | undefined;
        if (!profile || profile.guid !== defaultProfileId) {
          continue;
        }
        const fontFamily = readNestedString(profile, ["font", "face"]);
        if (fontFamily) {
          return { fontFamily };
        }
      }
    }

    // defaults 是未单独配置字体时的全局兜底，优先级低于具名 profile。
    // 它可能缺失或不是对象，交给 readNestedString 自然返回 null。
    const defaults = profiles?.defaults as Record<string, unknown> | undefined;
    const defaultsFont = readNestedString(defaults, ["font", "face"]);
    if (defaultsFont) {
      return { fontFamily: defaultsFont };
    }

    for (const item of list) {
      const profile = item as Record<string, unknown> | undefined;
      if (!profile) {
        continue;
      }
      const fontFamily = readNestedString(profile, ["font", "face"]);
      if (fontFamily) {
        return { fontFamily };
      }
    }
  }

  return null;
}

// VS Code 的终端字体是单一键 terminal.integrated.fontFamily，没有 profile 概念。
// 候选路径覆盖三平台：APPDATA、XDG_CONFIG_HOME、~/.config 与 Application Support。
// 必须用 filter 去掉未定义项，否则 join(undefined, ...) 抛 TypeError 并中断整条探测链。
// 稳定版排在 Insiders 之前：同时安装时优先跟随用户日常使用的那个。
// [失败路径] 单个路径读失败或解析失败都只让 readNestedString 返回 null，循环继续。
// 候选中 undefined 来自缺失的 APPDATA/XDG_CONFIG_HOME，filter 之后必须 existsSync，否则 join 会抛错。
function detectVsCodeTerminalFontFamily(env: NodeJS.ProcessEnv): TerminalDetectedProfile | null {
  const homeDir = resolveHomeDir(env);
  const appData = env.APPDATA?.trim();
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const candidates = [
    appData && join(appData, "Code", "User", "settings.json"),
    appData && join(appData, "Code - Insiders", "User", "settings.json"),
    xdgConfigHome && join(xdgConfigHome, "Code", "User", "settings.json"),
    xdgConfigHome && join(xdgConfigHome, "Code - Insiders", "User", "settings.json"),
    join(homeDir, ".config", "Code", "User", "settings.json"),
    join(homeDir, ".config", "Code - Insiders", "User", "settings.json"),
    join(homeDir, "Library", "Application Support", "Code", "User", "settings.json"),
    join(homeDir, "Library", "Application Support", "Code - Insiders", "User", "settings.json"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const filePath of candidates) {
    const parsed = readJsoncFile(filePath);
    const fontFamily = readNestedString(parsed, ["terminal.integrated.fontFamily"]);
    if (fontFamily) {
      return { fontFamily };
    }
  }

  return null;
}

// kitty 配置是纯文本，整份文件里只关心 font_family 一行，用带 m 标志的单行正则定位即可，
// 为一行配置引入完整解析器只会增加语法错误处理的分支。配置可被 include 拆分，
// 这里只看主配置，属于有意取舍。去掉首尾引号，否则字体会被当成带引号的名字而匹配不到：kitty 允许 "JetBrains Mono"，
// 引号进入下游会被当成字体名的一部分而永远匹配不到。正则不匹配时返回 null 并继续。
// [权衡] 不做 include 展开：需要跟踪循环引用，收益只是一个字体名。
// 整份配置只读取 font_family 一行；匹配失败返回 null，由下一个探测器继续。
function detectKittyFontFamily(env: NodeJS.ProcessEnv): TerminalDetectedProfile | null {
  const homeDir = resolveHomeDir(env);
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim() || join(homeDir, ".config");
  const candidates = [
    join(xdgConfigHome, "kitty", "kitty.conf"),
    join(homeDir, "Library", "Application Support", "kitty", "kitty.conf"),
  ];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) {
      continue;
    }
    try {
      const raw = readFileSync(filePath, "utf8");
      const match = raw.match(/^\s*font_family\s+(.+)$/m);
      const fontFamily = normalizeFontFamily(match?.[1]);
      if (fontFamily) {
        return { fontFamily: fontFamily.replace(/^"|"$/g, "") };
      }
    } catch {
      // continue
    }
  }

  return null;
}

// Alacritty 配置随版本迁移：0.13 之前是 YAML、之后是 TOML，两者会同时存在
// （升级未清理旧文件），所以两套候选都要试。TOML 在前，因为新版本忽略旧 YAML，
// 先读新格式才反映用户当前真正生效的配置。两种格式命中同一字段 font.normal.family，
// 读取逻辑复用 readNestedString。include/import 不展开，理由同 kitty。
// [失败路径] 解析器抛错由 readObjectFile 吞掉，返回 null 后继续下一个候选。
function detectAlacrittyFontFamily(env: NodeJS.ProcessEnv): TerminalDetectedProfile | null {
  const homeDir = resolveHomeDir(env);
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim() || join(homeDir, ".config");
  const tomlCandidates = [
    join(xdgConfigHome, "alacritty", "alacritty.toml"),
    join(homeDir, ".alacritty.toml"),
  ];
  const yamlCandidates = [
    join(xdgConfigHome, "alacritty", "alacritty.yml"),
    join(xdgConfigHome, "alacritty", "alacritty.yaml"),
  ];

  for (const filePath of tomlCandidates) {
    const parsed = readObjectFile(filePath, parseToml);
    const fontFamily = readNestedString(parsed, ["font", "normal", "family"]);
    if (fontFamily) {
      return { fontFamily };
    }
  }

  for (const filePath of yamlCandidates) {
    const parsed = readObjectFile(filePath, parseYaml);
    const fontFamily = readNestedString(parsed, ["font", "normal", "family"]);
    if (fontFamily) {
      return { fontFamily };
    }
  }

  return null;
}

// 探测器注册表：数组顺序即优先级（INV-05），调整前先确认通用探测器是否会抢占专用探测器。
// platforms 缺省表示全平台；带 platforms 的只在匹配平台参与，避免在无关平台上反复 stat
// 不存在的路径（Windows 上不会去读 ~/.config/kitty）。macOS 探测器由
// terminalProfileMacOs 由外部注入，使本文件与平台实现解耦，新平台只需新增模块。
// [权衡] 用数组而非 Map：优先级是顺序敏感的，字面顺序最直观，也便于测试裁剪探测器集合。
const TERMINAL_FONT_DETECTORS: readonly TerminalFontDetector[] = [
  {
    id: "windows-terminal",
    platforms: ["win32"],
    detect: detectWindowsTerminalFontFamily,
  },
  {
    id: "vscode",
    detect: detectVsCodeTerminalFontFamily,
  },
  ...createMacOsTerminalProfileDetectors(),
  {
    id: "kitty",
    platforms: ["darwin", "linux", "freebsd", "openbsd"],
    detect: detectKittyFontFamily,
  },
  {
    id: "alacritty",
    platforms: ["darwin", "linux", "freebsd", "openbsd"],
    detect: detectAlacrittyFontFamily,
  },
];

// 串行短路：第一个命中的探测器立即返回，不并行探测。并行更快，但会引入多个探测器
// 同时读盘、由竞态决定胜者的不确定性，同一台机器两次打开终端可能得到不同字体（破坏 INV-05）。
// 单个探测器失败只会返回 null，循环继续；返回前统一 normalize，避免每个探测器各写一遍空壳判空。
// [权衡] 不缓存探测结果：配置可能在运行期被修改，缓存必须依赖文件监听，
// 而一次探测只是几个 existsSync，成本可以忽略。
// env 由 resolveTerminalFontProfile 透传，探测器本身不读 process.env，保证同一输入得到同一结果。
function detectSystemTerminalProfile(env: NodeJS.ProcessEnv): TerminalDetectedProfile | null {
  for (const detector of TERMINAL_FONT_DETECTORS) {
    if (detector.platforms && !detector.platforms.includes(process.platform)) {
      continue;
    }
    const profile = normalizeDetectedProfile(detector.detect(env));
    if (profile) {
      return profile;
    }
  }

  return null;
}

// 三方合并入口，优先级：用户自定义字体 > 系统探测到的 profile > 内置兜底栈。
//
// 关键点：即使 customFontFamily 存在也要先探测，只为拿到 fontSize 与 theme。
// 用户只表达了字体要自己选，没有表达字号与配色也要重置，两者必须分开继承；
// 若把探测放在 custom 分支之后，选了自定义字体的用户会永久失去系统配色，
// 表现为 xterm 配色与面板外壳不一致。
//
// detectedProfile 的开关写成 !== false：只有显式关闭继承才跳过探测（INV-02），
// 旧设置里没有该字段时为 undefined，必须按继承处理，否则升级后默认外观突变。
//
// 三个 return 分支都保证 fontFamily 非空（INV-04）：custom 经 dedupe 合并，
// system 用 FONT_FAMILY_FALLBACKS[0] 补位，fallback 直接 join 整份兜底栈。
export function resolveTerminalFontProfile(input: TerminalFontProfileInput): TerminalFontProfile {
  // env 注入用于让测试与远端调用方复现其他平台的目录布局；
  // options.env 缺省才读 process.env，避免在模块加载期抓取全局状态。
  const env = input.env ?? process.env;
  const customFontFamily = normalizeFontFamily(input.settings.terminalFontFamily);
  const detectedProfile =
    input.settings.terminalInheritSystemProfile !== false ? detectSystemTerminalProfile(env) : null;
  // customFontFamily 分支：字体取用户值，字号与主题仍来自系统探测，只覆盖用户明确表达的字段。
  // source=custom 让 UI 能提示当前字体来自设置而非系统，便于排查继承开关的困惑。
  if (customFontFamily) {
    return {
      fontFamily: dedupeFontFamilyStack(customFontFamily),
      fontSize: detectedProfile?.fontSize,
      theme: detectedProfile?.theme,
      source: "custom",
    };
  }

  // 系统分支：字体族缺失时用兜底首项补位而不是整体放弃，否则只读到配色或字号的
  // 终端（macOS 常见）会退化到 fallback，悄悄丢掉 fontSize 与 theme。
  if (detectedProfile) {
    return {
      // macOS 用户终端样式不只包含字体族，还包含字号和配色；
      // 读不到字体族时不能整体放弃系统 profile，否则仅配置配色的终端无法继承到面板。
      fontFamily: dedupeFontFamilyStack(detectedProfile.fontFamily ?? FONT_FAMILY_FALLBACKS[0]),
      fontSize: detectedProfile.fontSize,
      theme: detectedProfile.theme,
      source: "system",
    };
  }

  return {
  // fallback 分支：探测器全灭时只给 FONT_FAMILY_FALLBACKS，让下游沿用终端自身默认值。
    fontFamily: FONT_FAMILY_FALLBACKS.join(", "),
    source: "fallback",
  };
}
