// INV-01 优先按 UTF-8 解码：守住位置 一次性解码主分支；改错故障 合法 UTF-8 被当成 GBK。
// INV-02 仅确定非法才回退：守住位置 valid 判断；改错故障 尾部截断被误判为非法。
// INV-03 流式模式一次定型：守住位置 mode 变量；改错故障 同一路输出编码混用。
// INV-04 尾部不完整留待拼接：守住位置 incomplete 分支；改错故障 多字节字符被截成乱码。
// INV-05 纯 ASCII 直接返回：守住位置 hasNonAscii；改错故障 无谓进入解码器。
// INV-06 locale 只补空缺：守住位置 isMissingOrCLocale；改错故障 覆盖用户显式设置。
// INV-07 LC_ALL 未设不补：守住位置 undefined 判断；改错故障 压过 LANG 与 LC_CTYPE。
// INV-08 Python 输出强制 UTF-8：守住位置 环境补丁；改错故障 Windows 中文路径乱码。
// INV-09 Windows 环境键大小写不敏感：守住位置 setEnvKey；改错故障 重复键互相覆盖。
// INV-10 覆盖变量优先：守住位置 override 分支；改错故障 无法强制指定编码。
// INV-11 非 Windows 恒为 UTF-8：守住位置 平台判断；改错故障 误用旧代码页。
// INV-12 chcp 探测限时一秒：守住位置 超时选项；改错故障 预检卡住启动。
// INV-13 未知代码页返回空：守住位置 编码存在性检查；改错故障 iconv 抛错。
// INV-14 代码页 65001 视为 UTF-8：守住位置 特殊分支；改错故障 UTF-8 被再转一次。
// INV-15 locale 推断覆盖四语系：守住位置 正则序列；改错故障 中文环境落到 cp437。
// INV-16 超长编码与代理区拒绝：守住位置 码点校验；改错故障 非法字节被静默吞掉。
// INV-17 非 Win 路径直接返回：守住位置 resolve 入口；改错故障 引入多余系统调用。
// INV-18 探测失败仍可解码：守住位置 locale 兜底；改错故障 无 chcp 时抛错。
//
// 模块职责：为 exec 输出注入 UTF-8 locale 并决定一次性与流式解码的编码。
// 状态所有权：纯函数；除 Windows 代码页探测外无副作用。
// 阅读顺序：先看环境补齐，再看 UTF-8 校验，最后看编码解析。
// ============================================================
// 文件定位：exec 输出的编码策略：子进程环境注入 UTF-8 locale + 解码时 UTF-8/旧代码页判定与回退。
// 输入输出：applyExecutionTextEnv 原地改 env；decode/decoder 把 Buffer 转字符串；resolve* 返回编码名或 null。
// 副作用：Windows 探测会 execFileSync(chcp, 1s 超时、windowsHide)；其余为纯计算。
// 失败语义：chcp 失败回退到按 locale 推断；iconv 不认识的编码一律返回 null（即按 UTF-8）。
// 不变量：优先 UTF-8；仅当字节序列确定非法或不完整时才使用 legacy 编码；流式解码一旦定模式不再切换。
// ============================================================
import { execFileSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import iconv from "iconv-lite";

const WINDOWS_OUTPUT_ENCODING_OVERRIDE_ENV = "ZCODE_WINDOWS_OUTPUT_ENCODING";
// Python 默认按控制台代码页输出，强制其 UTF-8 以免 Windows 中文乱码。
const PYTHON_UTF8_ENV_PATCH = {
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
} as const;

// 单段 Buffer 的 UTF-8 合法性分析结果。
type Utf8BufferAnalysis = {
  // 是否出现过 >=0x80 的字节（全 ASCII 时无需走解码器）。
  hasNonAscii: boolean;
  // 末尾是否停在多字节序列中间（跨 chunk，需要拼接后再判定）。
  incomplete: boolean;
  // 是否存在确定非法的序列（此时才允许回退 legacy 编码）。
  valid: boolean;
};

function getEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return env[key];
  const foundKey = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return foundKey ? env[foundKey] : undefined;
}

function setEnvKey(
  env: Record<string, string>,
  key: string,
  value: string,
  platform: NodeJS.Platform,
): void {
  if (platform === "win32") {
    const lowerKey = key.toLowerCase();
    for (const existingKey of Object.keys(env)) {
      if (existingKey.toLowerCase() === lowerKey) {
        delete env[existingKey];
      }
    }
  }
  env[key] = value;
}

function isUtf8Locale(value: string | undefined): boolean {
  return /utf-?8/i.test(value ?? "");
}

function isMissingOrCLocale(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toUpperCase();
  return normalized === "" || normalized === "C" || normalized === "POSIX";
}

// 从环境变量列表里找已继承的 UTF-8 locale；找不到时按平台给默认值（macOS 用 en_US.UTF-8）。
function resolveFallbackUtf8Locale(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const inheritedUtf8Locale = [
    getEnvValue(env, "LC_ALL", platform),
    getEnvValue(env, "LC_CTYPE", platform),
    getEnvValue(env, "LANG", platform),
  ].find(isUtf8Locale);
  if (inheritedUtf8Locale) return inheritedUtf8Locale;
  return platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
}

// 原地补齐子进程文本编码环境：locale 缺失或为 C/POSIX 时补 UTF-8，并强制 Python 输出 UTF-8。
// 只补空缺，不覆盖用户/overlay 已显式设置的 UTF-8 locale；返回 void（直接改传入的 env）。
// 先解析兜底 locale。
// 只补缺失或 C/POSIX 的键。
// Python 相关变量最后统一补齐。
export function applyExecutionTextEnv(
  env: Record<string, string>,
  platform: NodeJS.Platform,
): void {
  const fallbackLocale = resolveFallbackUtf8Locale(env, platform);

  // Bash 工具的 stdout/stderr 是给 UI 和模型消费的 Unicode 文本。
  // macOS GUI/远程 host 如果继承到 C/POSIX locale，wc、ls 等系统工具会先把中文路径替换成 "??"；
  // 这时前端已经拿不到原始字符，不能靠 React 渲染兜底恢复。这里仅在 locale 缺失或明确为 C/POSIX 时
  // 给子命令补 UTF-8 locale，并让 overlay 仍可在后面显式覆盖。
  if (isMissingOrCLocale(getEnvValue(env, "LANG", platform))) {
    setEnvKey(env, "LANG", fallbackLocale, platform);
  }
  if (isMissingOrCLocale(getEnvValue(env, "LC_CTYPE", platform))) {
    setEnvKey(env, "LC_CTYPE", fallbackLocale, platform);
  }
  // LC_ALL 只在“已设置但为空/为 C/POSIX”时改写；未设置则保持未设置，避免压过 LANG/LC_CTYPE。
  const lcAll = getEnvValue(env, "LC_ALL", platform);
  if (lcAll !== undefined && isMissingOrCLocale(lcAll)) {
    setEnvKey(env, "LC_ALL", fallbackLocale, platform);
  }

  for (const [key, value] of Object.entries(PYTHON_UTF8_ENV_PATCH)) {
    setEnvKey(env, key, value, platform);
  }
}

// 逐字节校验 UTF-8：拒绝过长编码、越界码点与代理区，末尾截断单独标记为 incomplete。
// 复杂度 O(n) 且不分配对象，用于每个输出块的热路径。
// 首字节小于等于 0x7f 时直接跳过，纯 ASCII 块不进入多字节分支。
// 末字节不足时标记 incomplete，由调用方决定是否等待下一块。
// 遇到非法序列立即返回 valid=false，避免继续扫描浪费 CPU。
function analyzeUtf8Buffer(buffer: Buffer): Utf8BufferAnalysis {
  let hasNonAscii = false;
  for (let index = 0; index < buffer.length; index += 1) {
    const first = buffer[index]!;
    if (first <= 0x7f) {
      continue;
    }

    hasNonAscii = true;
    let needed = 0;
    let minCodePoint = 0;
    let codePoint = 0;
    if (first >= 0xc2 && first <= 0xdf) {
      needed = 1;
      minCodePoint = 0x80;
      codePoint = first & 0x1f;
    } else if (first >= 0xe0 && first <= 0xef) {
      needed = 2;
      minCodePoint = 0x800;
      codePoint = first & 0x0f;
    } else if (first >= 0xf0 && first <= 0xf4) {
      needed = 3;
      minCodePoint = 0x10000;
      codePoint = first & 0x07;
    } else {
      return { hasNonAscii, incomplete: false, valid: false };
    }

    if (index + needed >= buffer.length) {
      return { hasNonAscii, incomplete: true, valid: true };
    }

    // 后续每个字节必须是 10xxxxxx，否则确定不是 UTF-8。
    for (let offset = 1; offset <= needed; offset += 1) {
      const next = buffer[index + offset]!;
      if ((next & 0xc0) !== 0x80) {
        return { hasNonAscii, incomplete: false, valid: false };
      }
      codePoint = (codePoint << 6) | (next & 0x3f);
    }

    if (
      codePoint < minCodePoint ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return { hasNonAscii, incomplete: false, valid: false };
    }

    index += needed;
  }

  return { hasNonAscii, incomplete: false, valid: true };
}

// 一次性解码：空缓冲返回 ""；无 legacy 编码或 UTF-8 合法（含仅尾部不完整）时按 UTF-8。
// 只有确定非法时才用 iconv 以 Windows 旧代码页解码，避免把合法 UTF-8 误判成 GBK。
// 空缓冲直接返回空串。
// 无 legacy 编码一律按 UTF-8。
// 确定非法时才回退旧代码页。
export function decodeExecutionOutputBuffer(
  buffer: Buffer,
  legacyOutputEncoding: string | null = null,
): string {
  if (buffer.length === 0) return "";
  const analysis = analyzeUtf8Buffer(buffer);
  if (!legacyOutputEncoding || (analysis.valid && !analysis.incomplete)) {
    return buffer.toString("utf8");
  }
  return iconv.decode(buffer, legacyOutputEncoding);
}

// 流式解码器：无 legacy 编码时直接用 StringDecoder(utf8)。
// 有 legacy 时先进入 unknown 模式，攒到能判定为止：非法 → legacy，完整且含非 ASCII → utf8。
// 判定后模式固定，保证同一路输出不会一半用 UTF-8、一半用 GBK 而出现乱码。
// 无 legacy 时直接流式解码。
// 有 legacy 先进入未知模式。
// 判定后模式固定不再切换，同一路输出不会一半 UTF-8 一半 GBK。
export function createExecutionOutputStreamDecoder(legacyOutputEncoding: string | null) {
  if (!legacyOutputEncoding) {
    const decoder = new StringDecoder("utf8");
    return {
      write: (buffer: Buffer) => decoder.write(buffer),
    };
  }

  const utf8Decoder = new StringDecoder("utf8");
  const legacyDecoder = iconv.getDecoder(legacyOutputEncoding);
  let pending: Buffer = Buffer.alloc(0);
  let mode: "unknown" | "utf8" | "legacy" = "unknown";

  return {
    write(buffer: Buffer): string {
      if (mode === "utf8") {
        return utf8Decoder.write(buffer);
      }
      if (mode === "legacy") {
        return legacyDecoder.write(buffer);
      }

      const combined = pending.length > 0 ? Buffer.concat([pending, buffer]) : buffer;
      const analysis = analyzeUtf8Buffer(combined);
      // 确定非法才切 legacy；否则继续攒 pending，等后续块补齐被截断的多字节字符。
      if (!analysis.valid) {
        mode = "legacy";
        pending = Buffer.alloc(0);
        return legacyDecoder.write(combined);
      }
      if (analysis.incomplete) {
        pending = combined;
        return "";
      }

      pending = Buffer.alloc(0);
      if (analysis.hasNonAscii) {
        mode = "utf8";
        return utf8Decoder.write(combined);
      }
      return combined.toString("utf8");
    },
  };
}

// 读取 Windows 活动代码页：执行 `cmd /d /s /c chcp`（1s 超时、隐藏窗口），65001 视为 UTF-8。
// 返回 iconv 可用的编码名；命令失败/输出异常/不认识的代码页返回 null。
// 调用 chcp 读取活动代码页。
// 65001 直接视为 UTF-8。
// 失败与未知代码页返回空。
function readWindowsActiveCodePageEncoding(env: NodeJS.ProcessEnv): string | null {
  const comSpec = getEnvValue(env, "ComSpec", "win32") ?? "cmd.exe";
  try {
    const output = execFileSync(comSpec, ["/d", "/s", "/c", "chcp"], {
      encoding: "utf8",
      env,
      timeout: 1_000,
      windowsHide: true,
    });
    const codePage = output.match(/(\d{3,5})/)?.[1];
    if (!codePage) return null;
    if (codePage === "65001") return "utf8";
    const encoding = `cp${codePage}`;
    return iconv.encodingExists(encoding) ? encoding : null;
  } catch {
    return null;
  }
}

// 按系统 locale 猜旧代码页：中文→gb18030、日文→cp932、韩文→cp949、俄文→cp866，其余 cp437。
// 这是 chcp 探测失败后的最后回退，宁可近似也不返回“未知编码”。
function resolveWindowsLocaleLegacyEncoding(env: NodeJS.ProcessEnv): string {
  const localeText = [
    getEnvValue(env, "LC_ALL", "win32"),
    getEnvValue(env, "LC_CTYPE", "win32"),
    getEnvValue(env, "LANG", "win32"),
    Intl.DateTimeFormat().resolvedOptions().locale,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/(zh|chinese|cn|hans|hant)/i.test(localeText)) {
    return "gb18030";
  }
  if (/(ja|japanese|jp)/i.test(localeText)) {
    return "cp932";
  }
  if (/(ko|korean|kr)/i.test(localeText)) {
    return "cp949";
  }
  if (/(ru|russian)/i.test(localeText)) {
    return "cp866";
  }
  return "cp437";
}

// 决定 Windows 旧代码页编码：覆盖变量优先（非法则 null）→ chcp 活动代码页 → locale 推断。
// 非 Windows 恒为 null（只按 UTF-8 解码）。
// 非 Windows 恒为空。
// 覆盖变量存在但 chcp 不认识时返回 null，不回落到活动代码页。
// 其次探测，最后按 locale 推断。
export function resolveLegacyExecutionOutputEncoding(options: {
  platform: NodeJS.Platform;
  processEnv: NodeJS.ProcessEnv;
}): string | null {
  if (options.platform !== "win32") {
    return null;
  }
  const override = getEnvValue(
    options.processEnv,
    WINDOWS_OUTPUT_ENCODING_OVERRIDE_ENV,
    "win32",
  )?.trim();
  if (override) {
    return iconv.encodingExists(override) ? override : null;
  }
  const activeEncoding = readWindowsActiveCodePageEncoding(options.processEnv);
  if (activeEncoding && activeEncoding !== "utf8") {
    return activeEncoding;
  }
  return resolveWindowsLocaleLegacyEncoding(options.processEnv);
}
