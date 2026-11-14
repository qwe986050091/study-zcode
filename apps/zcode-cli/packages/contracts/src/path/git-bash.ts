// Windows 路径 → Git Bash 路径。Git Bash（MSYS2）在 Windows 上把盘符映射成 `/<driver>/`，
// 因此 `C:\a\b` 变成 `/c/a/b`；`\\server\share` 这类 UNC 只做分隔符翻转，不额外加盘符。
// 已是 POSIX 形式或不带盘符的输入按“仅统一分隔符”处理，保留调用方原有语义。
// 生产者/消费者：adapters/exec 在写 bash 启动脚本与捕获 cwd 时调用；路径转换必须走这里，
// 禁止在别处硬编码 `C:/` 或 `/c/` 规则，否则不同 shell 下 cwd 会漂移。
// 本函数只做字符串形态转换，不访问文件系统，也不做 realpath/大小写归一。
export function windowsPathToGitBashPath(value: string): string {
  if (value.startsWith("\\\\")) return value.replaceAll("\\", "/");
  const driveMatch = value.match(/^([A-Za-z]):(?:[/\\]|$)/u);
  if (driveMatch) {
    const rest = value.slice(2).replaceAll("\\", "/");
    return `/${driveMatch[1]!.toLowerCase()}${rest.startsWith("/") ? rest : `/${rest}`}`;
  }
  return value.replaceAll("\\", "/");
}

// Git Bash 路径 → Windows 路径，是 `windowsPathToGitBashPath` 的逆向变换。
// 同时接受三种真实来源：`//server/share`（UNC）、`/cygdrive/<driver>/...`（旧版 MSYS 挂载）、
// `/<driver>/...`（新版 Git Bash 默认前缀）；盘符统一转成大写，其余部分交给
// `gitBashRestToWindowsPathRest` 翻转分隔符并保留根反斜杠。
// 反向转换不保证与正向完全可逆（`C:` vs `c:`、UNC 前缀写法），调用方只能依赖“能被 Windows
// API 接受”这一条，不要用它做路径等价比较；识别失败时按分隔符翻转兜底，避免抛错中断 exec。
export function gitBashPathToWindowsPath(value: string): string {
  if (value.startsWith("//")) return value.replaceAll("/", "\\");
  const cygdrive = value.match(/^\/cygdrive\/([A-Za-z])(\/|$)/u);
  if (cygdrive) {
    const rest = value.slice(`/cygdrive/${cygdrive[1]}`.length);
    return `${cygdrive[1]!.toUpperCase()}:${gitBashRestToWindowsPathRest(rest)}`;
  }
  const drive = value.match(/^\/([A-Za-z])(\/|$)/u);
  if (drive) {
    const rest = value.slice(2);
    return `${drive[1]!.toUpperCase()}:${gitBashRestToWindowsPathRest(rest)}`;
  }
  return value.replaceAll("/", "\\");
}

// 盘符/cygdrive 前缀之后的剩余部分：把 `/` 翻成 `\`，去掉开头多余的反斜杠，再补回一个根
// 分隔符，保证输出总是 `C:\` 或 `C:\x` 形态，不会出现 `C:` 后直接跟内容或空串的歧义。
// 只在两个公开转换函数内部使用，不对外导出；调用方不应绕过公开函数直接拼接盘符。
function gitBashRestToWindowsPathRest(rest: string): string {
  const converted = rest.replaceAll("/", "\\").replace(/^\\+/u, "");
  return converted.length > 0 ? `\\${converted}` : "\\";
}
