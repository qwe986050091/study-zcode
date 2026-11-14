// ============================================================
// 文件定位：Windows 可执行文件解析，供 exec 的 spawn 与 bash-shell-provider 的 shell 探测共用。
// 输入输出：输入 e.g. "git" / "C:\\x\\a.cmd" + env(含 PATH/PATHEXT)，输出候选绝对路径数组。
// 副作用：无（纯字符串/路径计算，不触碰文件系统，存在性由调用方注入的 exists 判定）。
// 失败语义：从不抛出；环境变量缺失时用默认 PATHEXT，候选全部不存在则由调用方回退原值。
// 不变量：候选顺序 = PATHEXT 声明顺序；带扩展名的输入不追加扩展名。
// ============================================================
import { extname, win32 } from "node:path";

// PATHEXT 缺失时的兜底集合，保持大小写与顺序稳定。
const DEFAULT_WINDOWS_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];

// Windows 环境变量名大小写不敏感：按小写比较取第一个匹配项。
// 多连接/多窗口共享同一 env 对象时，大小写混写不会导致读不到值。
export function getWindowsEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const lowerKey = key.toLowerCase();
  const match = Object.keys(env).find((envKey) => envKey.toLowerCase() === lowerKey);
  return match ? env[match] : undefined;
}

// 生成候选可执行路径：含分隔符/绝对路径只补扩展名；裸文件名则按 PATH 目录逐个展开。
// 返回值可能为空数组（PATH 为空），调用方需自行处理“找不到可执行文件”。
export function windowsExecutableCandidates(
  file: string,
  env: NodeJS.ProcessEnv,
  cwd?: string,
): string[] {
  const pathExts = getWindowsPathExts(env);
  const fileCandidates = windowsExtensionCandidates(file, pathExts);

  if (hasWindowsPathSeparator(file) || win32.isAbsolute(file)) {
    // 相对路径带分隔符时按 cwd 解析成绝对路径，避免继承进程自身 cwd 造成歧义。
    const basePath =
      !win32.isAbsolute(file) && cwd ? win32.resolve(cwd, file) : win32.normalize(file);
    return windowsExtensionCandidates(basePath, pathExts);
  }

  const dirs =
    getWindowsEnvValue(env, "PATH")
      ?.split(win32.delimiter)
      .filter((dir) => dir.length > 0) ?? [];
  return dirs.flatMap((dir) => fileCandidates.map((candidate) => win32.join(dir, candidate)));
}

function windowsExtensionCandidates(file: string, pathExts: string[]): string[] {
  if (extname(file)) return [file];
  return [file, ...pathExts.map((extension) => `${file}${extension.toLowerCase()}`)];
}

function getWindowsPathExts(env: NodeJS.ProcessEnv): string[] {
  const raw = getWindowsEnvValue(env, "PATHEXT");
  const values = raw
    ?.split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0);
  return values && values.length > 0 ? values : DEFAULT_WINDOWS_PATHEXT;
}

function hasWindowsPathSeparator(value: string): boolean {
  return value.includes("\\") || value.includes("/");
}
